import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_PREFIX,
  isMediaPath,
  parseMediaPath,
  buildMediaUrl,
  buildDriveMediaUrl,
  buildDriveHeaders,
  parseByteRange,
  buildClientResponseInit,
} from "../js/media-range.js";

test("MEDIA_PREFIX は /__media__/", () => {
  assert.equal(MEDIA_PREFIX, "/__media__/");
});

test("isMediaPath: 仮想URLパスを判定", () => {
  assert.equal(isMediaPath("/t33-viewer-/__media__/abc.mp4"), true);
  assert.equal(isMediaPath("/t33-viewer-/index.html"), false);
});

test("parseMediaPath: fileId を取り出す（.mp4 除去・URLデコード）", () => {
  assert.equal(parseMediaPath("/t33-viewer-/__media__/1AbC_d-e.mp4"), "1AbC_d-e");
  assert.equal(parseMediaPath("/app/__media__/" + encodeURIComponent("XYZ123") + ".mp4"), "XYZ123");
});

test("parseMediaPath: 不正値は null", () => {
  assert.equal(parseMediaPath("/__media__/.mp4"), null);          // 空
  assert.equal(parseMediaPath("/__media__/a%2Fb.mp4"), null);     // スラッシュ混入
  assert.equal(parseMediaPath("/foo/bar.mp4"), null);             // プレフィックスなし
});

test("buildMediaUrl: 仮想URLを組み立てる", () => {
  assert.equal(buildMediaUrl("1AbC_d-e"), "./__media__/1AbC_d-e.mp4");
});

test("buildDriveMediaUrl: Drive media エンドポイント", () => {
  assert.equal(
    buildDriveMediaUrl("FILE1"),
    "https://www.googleapis.com/drive/v3/files/FILE1?alt=media"
  );
});

test("buildDriveHeaders: Range あり/なし", () => {
  assert.deepEqual(buildDriveHeaders("bytes=0-99", "TKN"), {
    Authorization: "Bearer TKN",
    Range: "bytes=0-99",
  });
  assert.deepEqual(buildDriveHeaders(null, "TKN"), { Authorization: "Bearer TKN" });
});

test("parseByteRange: オープン端（bytes=N-）", () => {
  assert.deepEqual(parseByteRange("bytes=0-"), { start: 0, end: null });
  assert.deepEqual(parseByteRange("bytes=1000-"), { start: 1000, end: null });
});

test("parseByteRange: クローズ端（bytes=N-M）", () => {
  assert.deepEqual(parseByteRange("bytes=1000-2000"), { start: 1000, end: 2000 });
});

test("parseByteRange: 不正/なしは null", () => {
  assert.equal(parseByteRange(null), null);
  assert.equal(parseByteRange(""), null);
  assert.equal(parseByteRange("bytes=abc"), null);
  assert.equal(parseByteRange("bytes=-100"), null); // suffix range は非対応
});

// CORS で Drive の Content-Range/Accept-Ranges は読めない前提（null）。
// 読める Content-Length と Range から自前で Content-Range を合成する。
test("buildClientResponseInit: 206 bytes=0- は総サイズを算出し Content-Range を合成", () => {
  const h = new Headers({ "Content-Type": "video/mp4", "Content-Length": "1000" });
  const { headers, total } = buildClientResponseInit(206, h, "bytes=0-", null);
  assert.equal(total, 1000);
  assert.equal(headers["Content-Range"], "bytes 0-999/1000");
  assert.equal(headers["Accept-Ranges"], "bytes");
  assert.equal(headers["Content-Length"], "1000");
  assert.equal(headers["Content-Type"], "video/mp4");
});

test("buildClientResponseInit: 206 途中オープン端（bytes=400-）は start+CL を総サイズに", () => {
  const h = new Headers({ "Content-Length": "600" });
  const { headers, total } = buildClientResponseInit(206, h, "bytes=400-", null);
  assert.equal(total, 1000);
  assert.equal(headers["Content-Range"], "bytes 400-999/1000");
});

test("buildClientResponseInit: 206 クローズ端は既知総サイズ(knownTotal)を使う", () => {
  const h = new Headers({ "Content-Length": "101" });
  const { headers } = buildClientResponseInit(206, h, "bytes=100-200", 1000);
  assert.equal(headers["Content-Range"], "bytes 100-200/1000");
});

test("buildClientResponseInit: octet-stream は video/mp4 に補正", () => {
  const h = new Headers({ "Content-Type": "application/octet-stream", "Content-Length": "10" });
  const { headers } = buildClientResponseInit(206, h, "bytes=0-", null);
  assert.equal(headers["Content-Type"], "video/mp4");
});

test("buildClientResponseInit: 200(Range非対応)は Content-Range なし・Accept-Ranges は bytes", () => {
  const h = new Headers({ "Content-Type": "video/mp4", "Content-Length": "1000" });
  const { headers } = buildClientResponseInit(200, h, null, null);
  assert.equal(headers["Content-Range"], undefined);
  assert.equal(headers["Accept-Ranges"], "bytes");
});
