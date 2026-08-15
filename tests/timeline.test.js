// グラフ横軸のドメイン（時間範囲）決定ロジックのテスト。
// 軸は「動画全体」を必ず覆う。CSV(OBD) が動画より早く止まっても、
// 軸が CSV 末尾で切れて再生位置が軸外へ出ることが無いようにする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateVideoEndSec, computeTimeDomain, DEFAULT_SEGMENT_SEC } from "../js/timeline.js";

// 10分×3本のうち、最後だけ短い（サイズが 1/5）実データ相当の構成
const SEGMENTS = [
  { baseOffsetSec: 0, size: 1_250_000_000 },
  { baseOffsetSec: 600, size: 1_250_000_000 },
  { baseOffsetSec: 1200, size: 250_000_000 },
];

// ---- estimateVideoEndSec ----

test("estimateVideoEndSec: 最終セグメントのサイズ比から終端を見積もる", () => {
  // 最終は満杯の 1/5 なので約 120 秒 → 1200 + 120
  assert.equal(Math.round(estimateVideoEndSec(SEGMENTS, null)), 1320);
});

test("estimateVideoEndSec: サイズが無ければ 1本ぶんの長さを足す", () => {
  const segs = SEGMENTS.map((s) => ({ baseOffsetSec: s.baseOffsetSec }));
  assert.equal(estimateVideoEndSec(segs, null), 1800);
});

test("estimateVideoEndSec: セグメント1本だけならサイズ比の基準が無く既定長を足す", () => {
  assert.equal(estimateVideoEndSec([{ baseOffsetSec: 0, size: 10 }], null), DEFAULT_SEGMENT_SEC);
});

test("estimateVideoEndSec: 最終セグメントの実測終端が判れば見積もりより優先する", () => {
  // loadedmetadata で最終セグメントの duration が判った状態（1200 + 実測 130）
  assert.equal(estimateVideoEndSec(SEGMENTS, 1330), 1330);
});

test("estimateVideoEndSec: 途中セグメントの実測終端では見積もりを縮めない", () => {
  // 2本目まで再生した時点の実測(1200)で軸を縮めると最終セグメントが軸外に出る
  assert.equal(Math.round(estimateVideoEndSec(SEGMENTS, 1200)), 1320);
});

test("estimateVideoEndSec: baseOffsetSec 未確定(null)のセグメントは基準にしない", () => {
  const segs = [{ baseOffsetSec: 0 }, { baseOffsetSec: null }, { baseOffsetSec: null }];
  assert.equal(estimateVideoEndSec(segs, 900), 900);
});

test("estimateVideoEndSec: 動画なし(セグメント空)は null", () => {
  assert.equal(estimateVideoEndSec([], null), null);
  assert.equal(estimateVideoEndSec(null, null), null);
});

// ---- computeTimeDomain ----

const samples = (first, last) => [{ t: first }, { t: last }];

test("computeTimeDomain: CSV が動画より早く終わっても軸は動画全体を覆う", () => {
  // 実データ相当(2026-08-14 15:31): 10分×12本 + 最終1本(272MB≒2分)、
  // CSV は 8.5〜6105.9 秒で停止、動画は約 7334 秒まである
  const segs = Array.from({ length: 12 }, (_, i) => ({
    baseOffsetSec: Math.round(i * 600.3 * 1000) / 1000,
    size: 1_258_000_000,
  }));
  segs.push({ baseOffsetSec: 7204, size: 272_800_618 });
  const d = computeTimeDomain({
    samples: samples(8.5, 6105.9),
    track: [],
    segments: segs,
    knownEndSec: null,
  });
  assert.equal(d.tMin, 0);
  assert.ok(d.tMax > 7300 && d.tMax < 7400, `tMax=${d.tMax}`);
});

test("computeTimeDomain: CSV が動画より長ければ CSV 末尾まで伸ばす(切り落とさない)", () => {
  const d = computeTimeDomain({
    samples: samples(0, 2000),
    track: [],
    segments: [{ baseOffsetSec: 0 }],
    knownEndSec: 600,
  });
  assert.equal(d.tMax, 2000);
});

test("computeTimeDomain: KML が動画より後まで続く場合も覆う", () => {
  const d = computeTimeDomain({
    samples: samples(10, 500),
    track: [{ t: 5 }, { t: 1500 }],
    segments: [{ baseOffsetSec: 0 }],
    knownEndSec: 600,
  });
  assert.equal(d.tMin, 0);
  assert.equal(d.tMax, 1500);
});

test("computeTimeDomain: 動画なしセッションは CSV の範囲のまま(従来動作)", () => {
  const d = computeTimeDomain({ samples: samples(0, 300), track: [], segments: [], knownEndSec: null });
  assert.equal(d.tMin, 0);
  assert.equal(d.tMax, 300);
});

test("computeTimeDomain: CSV 先頭が負(動画より前から記録)なら軸もそこから始める", () => {
  const d = computeTimeDomain({
    samples: samples(-30, 300),
    track: [],
    segments: [{ baseOffsetSec: 0 }],
    knownEndSec: 600,
  });
  assert.equal(d.tMin, -30);
});

test("computeTimeDomain: データが空でも例外を出さず幅を持つ", () => {
  const d = computeTimeDomain({ samples: [], track: [], segments: [], knownEndSec: null });
  assert.equal(d.tMin, 0);
  assert.ok(d.tMax > d.tMin);
});
