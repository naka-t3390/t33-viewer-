// 10分セグメント分割動画（連番mp4）の再生に関する純粋ロジックのテスト。
// 端末側 VideoSessionTarget.renderSegmentedMetaJson が出力する _video.json を読む。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSegmentedMeta,
  buildSegmentPlaylist,
  segmentAtGlobalTime,
} from "../js/parse.js";

// 端末が書き出す集約メタの実形式（VideoSessionTarget.kt と一致）
const SEGMENTED_JSON = JSON.stringify({
  video_start_ms: 1780205191835,
  segments: [
    { file: "t33_20260704_083000_001.mp4", start_ms: 1780205191835 },
    { file: "t33_20260704_083000_002.mp4", start_ms: 1780205791835 }, // +600,000ms = 10分後
  ],
});

// ---- parseSegmentedMeta ----

test("parseSegmentedMeta: 集約形式から videoStartMs と segments を返す", () => {
  const meta = parseSegmentedMeta(SEGMENTED_JSON);
  assert.equal(meta.videoStartMs, 1780205191835);
  assert.equal(meta.segments.length, 2);
  assert.deepEqual(meta.segments[0], { file: "t33_20260704_083000_001.mp4", startMs: 1780205191835 });
  assert.deepEqual(meta.segments[1], { file: "t33_20260704_083000_002.mp4", startMs: 1780205791835 });
});

test("parseSegmentedMeta: 旧単一形式(video_start_ms のみ)は segments 空", () => {
  const meta = parseSegmentedMeta('{"video_start_ms":1780205191835}');
  assert.equal(meta.videoStartMs, 1780205191835);
  assert.deepEqual(meta.segments, []);
});

test("parseSegmentedMeta: 空 segments はそのまま空配列", () => {
  const meta = parseSegmentedMeta('{"segments":[]}');
  assert.equal(meta.videoStartMs, null);
  assert.deepEqual(meta.segments, []);
});

test("parseSegmentedMeta: 不正JSONは videoStartMs=null / segments=[]", () => {
  const meta = parseSegmentedMeta("not json");
  assert.equal(meta.videoStartMs, null);
  assert.deepEqual(meta.segments, []);
});

test("parseSegmentedMeta: 空文字・null入力も安全に空を返す", () => {
  assert.deepEqual(parseSegmentedMeta("").segments, []);
  assert.deepEqual(parseSegmentedMeta(null).segments, []);
});

test("parseSegmentedMeta: file/start_ms が不正な要素はスキップする", () => {
  const json = JSON.stringify({
    video_start_ms: 1000,
    segments: [
      { file: "a_001.mp4", start_ms: 1000 },
      { file: "a_002.mp4" },              // start_ms 欠落 → スキップ
      { start_ms: 2000 },                  // file 欠落 → スキップ
      { file: "a_003.mp4", start_ms: "x" },// start_ms 非数値 → スキップ
      { file: "a_004.mp4", start_ms: 3000 },
    ],
  });
  const meta = parseSegmentedMeta(json);
  assert.deepEqual(meta.segments.map((s) => s.file), ["a_001.mp4", "a_004.mp4"]);
});

// ---- buildSegmentPlaylist ----
// Drive 上の連番mp4群(id,name)と meta を突合し、再生順の [{id,name,baseOffsetSec}] を作る。

test("buildSegmentPlaylist: segments を name で id 突合し baseOffset を秒で算出", () => {
  const mp4s = [
    { id: "ID2", name: "t33_20260704_083000_002.mp4" },
    { id: "ID1", name: "t33_20260704_083000_001.mp4" },
  ];
  const meta = parseSegmentedMeta(SEGMENTED_JSON);
  const pl = buildSegmentPlaylist(mp4s, meta);
  assert.equal(pl.length, 2);
  assert.deepEqual(pl[0], { id: "ID1", name: "t33_20260704_083000_001.mp4", baseOffsetSec: 0 });
  assert.deepEqual(pl[1], { id: "ID2", name: "t33_20260704_083000_002.mp4", baseOffsetSec: 600 });
});

test("buildSegmentPlaylist: Drive に存在しない segment はスキップする", () => {
  const mp4s = [{ id: "ID1", name: "t33_20260704_083000_001.mp4" }];
  const meta = parseSegmentedMeta(SEGMENTED_JSON); // 002 は Drive に無い
  const pl = buildSegmentPlaylist(mp4s, meta);
  assert.equal(pl.length, 1);
  assert.equal(pl[0].id, "ID1");
});

test("buildSegmentPlaylist: segments 空・単一mp4は baseOffset 0 の1本", () => {
  const mp4s = [{ id: "IDX", name: "t33_20260704_083000.mp4" }];
  const meta = { videoStartMs: 1000, segments: [] };
  const pl = buildSegmentPlaylist(mp4s, meta);
  assert.deepEqual(pl, [{ id: "IDX", name: "t33_20260704_083000.mp4", baseOffsetSec: 0 }]);
});

test("buildSegmentPlaylist: segments 空・連番複数mp4は name 順・baseOffset は null(実測フォールバック)", () => {
  const mp4s = [
    { id: "IDB", name: "t33_x_002.mp4" },
    { id: "IDA", name: "t33_x_001.mp4" },
  ];
  const pl = buildSegmentPlaylist(mp4s, { videoStartMs: null, segments: [] });
  assert.deepEqual(pl.map((p) => p.id), ["IDA", "IDB"]);
  assert.equal(pl[0].baseOffsetSec, 0);      // 先頭は 0
  assert.equal(pl[1].baseOffsetSec, null);   // 2本目以降は実測で埋める
});

test("buildSegmentPlaylist: mp4 が無ければ空配列", () => {
  assert.deepEqual(buildSegmentPlaylist([], { videoStartMs: 1000, segments: [] }), []);
});

// 壊れたセグメント(スリープ/Doze/切断で 0バイト・極小になった mp4)は
// 再生すると HTTP 416 / DEMUXER エラーになる。プレイリストから事前除外する。

test("buildSegmentPlaylist: 0バイトの壊れたセグメントは除外する", () => {
  const mp4s = [
    { id: "ID1", name: "t33_20260704_083000_001.mp4", size: 1_200_000_000 },
    { id: "ID2", name: "t33_20260704_083000_002.mp4", size: 0 }, // 壊れた0バイト
  ];
  const meta = parseSegmentedMeta(SEGMENTED_JSON);
  const pl = buildSegmentPlaylist(mp4s, meta);
  assert.deepEqual(pl.map((p) => p.id), ["ID1"]);
});

test("buildSegmentPlaylist: 極小(閾値未満)セグメントは除外する", () => {
  const mp4s = [
    { id: "ID1", name: "t33_20260704_083000_001.mp4", size: 1_200_000_000 },
    { id: "ID2", name: "t33_20260704_083000_002.mp4", size: 500 },
  ];
  const meta = parseSegmentedMeta(SEGMENTED_JSON);
  const pl = buildSegmentPlaylist(mp4s, meta);
  assert.deepEqual(pl.map((p) => p.id), ["ID1"]);
});

test("buildSegmentPlaylist: Drive size は文字列でも数値として判定する", () => {
  // Drive API v3 の files.size は文字列("0" 等)で返る。
  const mp4s = [
    { id: "ID1", name: "t33_20260704_083000_001.mp4", size: "1200000000" },
    { id: "ID2", name: "t33_20260704_083000_002.mp4", size: "0" },
  ];
  const meta = parseSegmentedMeta(SEGMENTED_JSON);
  const pl = buildSegmentPlaylist(mp4s, meta);
  assert.deepEqual(pl.map((p) => p.id), ["ID1"]);
});

test("buildSegmentPlaylist: size 未取得(undefined)なら除外しない(後方互換)", () => {
  const mp4s = [
    { id: "ID1", name: "t33_20260704_083000_001.mp4" },
    { id: "ID2", name: "t33_20260704_083000_002.mp4" },
  ];
  const meta = parseSegmentedMeta(SEGMENTED_JSON);
  const pl = buildSegmentPlaylist(mp4s, meta);
  assert.equal(pl.length, 2);
});

test("buildSegmentPlaylist: フォールバック(メタ無し)でも 0バイトは除外する", () => {
  const mp4s = [
    { id: "IDA", name: "t33_x_001.mp4", size: 500_000 },
    { id: "IDB", name: "t33_x_002.mp4", size: 0 },
  ];
  const pl = buildSegmentPlaylist(mp4s, { videoStartMs: null, segments: [] });
  assert.deepEqual(pl.map((p) => p.id), ["IDA"]);
});

// ---- segmentAtGlobalTime ----
// グローバル時刻(全体タイムラインの秒)から、対象セグメント index と
// そのセグメント内ローカル時刻を求める(グラフクリックのシーク用)。

const PLAYLIST = [
  { id: "ID1", name: "a_001.mp4", baseOffsetSec: 0 },
  { id: "ID2", name: "a_002.mp4", baseOffsetSec: 600 },
  { id: "ID3", name: "a_003.mp4", baseOffsetSec: 1200 },
];

test("segmentAtGlobalTime: 先頭セグメント内", () => {
  assert.deepEqual(segmentAtGlobalTime(PLAYLIST, 30), { index: 0, localTime: 30 });
});

test("segmentAtGlobalTime: 2本目セグメント内はローカル時刻へ換算", () => {
  assert.deepEqual(segmentAtGlobalTime(PLAYLIST, 650), { index: 1, localTime: 50 });
});

test("segmentAtGlobalTime: 境界はその開始セグメント(localTime=0)", () => {
  assert.deepEqual(segmentAtGlobalTime(PLAYLIST, 600), { index: 1, localTime: 0 });
});

test("segmentAtGlobalTime: 末尾セグメントを超える時刻は最終セグメント内", () => {
  assert.deepEqual(segmentAtGlobalTime(PLAYLIST, 1500), { index: 2, localTime: 300 });
});

test("segmentAtGlobalTime: 負の時刻は先頭(localTime=0)", () => {
  assert.deepEqual(segmentAtGlobalTime(PLAYLIST, -5), { index: 0, localTime: 0 });
});

test("segmentAtGlobalTime: 空プレイリストは index=-1", () => {
  assert.deepEqual(segmentAtGlobalTime([], 10), { index: -1, localTime: 0 });
});
