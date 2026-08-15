// セグメント再生の src 解決に関するロジックのテスト。
//
// Service Worker はアイドルになるとブラウザに停止され、メモリ保持の Drive トークン
// (sw.js の driveToken) を失う。トークンをセッションを開いた時に一度しか渡していないと、
// 10 分再生して次のセグメントへ移る頃には SW が再起動していてトークンが無く、
// 動画取得が 401 になって再生が止まる。セグメントを解決するたびに渡し直す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlayback } from "../js/playback.js";

const LIST = [
  { id: "id-001", name: "t33_20260726_112524_001.mp4", baseOffsetSec: 0 },
  { id: "id-002", name: "t33_20260726_112524_002.mp4", baseOffsetSec: 594.6 },
];

function swDeps(overrides = {}) {
  return {
    swStreaming: true,
    sendToken: async () => {},
    buildMediaUrl: (id) => `./__media__/${id}.mp4`,
    downloadBlobUrl: () => {
      throw new Error("SW ストリーミング時に全DLへ落ちてはいけない");
    },
    ...overrides,
  };
}

test("segments は baseOffsetSec をそのまま引き継ぐ", () => {
  const playback = buildPlayback(LIST, swDeps());

  assert.deepEqual(playback.segments, [{ baseOffsetSec: 0 }, { baseOffsetSec: 594.6 }]);
});

test("SWストリーミングではセグメントを解決するたびにトークンを渡し直す", async () => {
  let sent = 0;
  const playback = buildPlayback(LIST, swDeps({ sendToken: async () => { sent += 1; } }));

  await playback.resolveSrc(0);
  assert.equal(sent, 1);

  // 10 分後の 2 本目。ここで渡し直さないと SW が停止していた場合 401 になる。
  await playback.resolveSrc(1);
  assert.equal(sent, 2, "2本目でもトークンを渡す");
});

test("SWストリーミングはトークンを渡してから仮想URLを返す", async () => {
  const order = [];
  const playback = buildPlayback(
    LIST,
    swDeps({
      sendToken: async () => { order.push("token"); },
      buildMediaUrl: (id) => { order.push("url"); return `./__media__/${id}.mp4`; },
    })
  );

  const src = await playback.resolveSrc(1);

  assert.deepEqual(order, ["token", "url"], "URL を張る前にトークンを届ける");
  assert.equal(src, "./__media__/id-002.mp4");
  assert.equal(playback.isBlob, false);
});

test("SWが使えないときは全DLフォールバックになりトークン送信はしない", async () => {
  let sent = 0;
  const playback = buildPlayback(LIST, {
    swStreaming: false,
    sendToken: async () => { sent += 1; },
    buildMediaUrl: () => { throw new Error("非SW時に仮想URLを使ってはいけない"); },
    downloadBlobUrl: (id) => `blob:${id}`,
  });

  const src = await playback.resolveSrc(1);

  assert.equal(playback.isBlob, true);
  assert.equal(src, "blob:id-002");
  assert.equal(sent, 0, "SW を経由しないのでトークン送信は不要");
});

test("空のプレイリストは null を返す(再生させない)", () => {
  assert.equal(buildPlayback([], swDeps()), null);
});
