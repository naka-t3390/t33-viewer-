import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVideoStartMs } from "../js/parse.js";
import { parseCsvSeries } from "../js/parse.js";
import { parseKmlTrack } from "../js/parse.js";
import { decimate } from "../js/parse.js";
import { hvLabel } from "../js/parse.js";
import { groupSessions } from "../js/parse.js";

test("parseVideoStartMs: 有効JSONはepoch msを返す", () => {
  assert.equal(parseVideoStartMs('{"video_start_ms": 1780205191835}'), 1780205191835);
});
test("parseVideoStartMs: キー無しはnull", () => {
  assert.equal(parseVideoStartMs('{"other": 1}'), null);
});
test("parseVideoStartMs: 不正JSONはnull", () => {
  assert.equal(parseVideoStartMs("not json"), null);
});
test("parseVideoStartMs: 非整数値はnull", () => {
  assert.equal(parseVideoStartMs('{"video_start_ms": "x"}'), null);
});

const CSV = [
  "timestamp_iso,timestamp_ms,vehicle_speed_kmh,engine_rpm,engine_load_pct,coolant_temp_c,throttle_pct,hv_state",
  "2026-05-31T14:26:31.835,1000,50.00,1200.0,30.0,80.0,12.5,2.0",
  "2026-05-31T14:26:32.039,2000,52.00,,31.0,80.5,,2.0",
].join("\n");

test("parseCsvSeries: t は video_start 起点の相対秒", () => {
  const s = parseCsvSeries(CSV, 1000);
  assert.equal(s[0].t, 0.0);
  assert.equal(s[1].t, 1.0);
});
test("parseCsvSeries: 名前付き列を写像する", () => {
  const s = parseCsvSeries(CSV, 1000);
  assert.equal(s[0].speed, 50.0);
  assert.equal(s[0].rpm, 1200.0);
  assert.equal(s[0].coolant, 80.0);
  assert.equal(s[0].throttle, 12.5);
  assert.equal(s[0].hv_state, 2.0);
});
test("parseCsvSeries: 空セルはnull", () => {
  const s = parseCsvSeries(CSV, 1000);
  assert.equal(s[1].rpm, null);
  assert.equal(s[1].throttle, null);
});
test("parseCsvSeries: データ行数に一致", () => {
  assert.equal(parseCsvSeries(CSV, 1000).length, 2);
});

const KML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
  "<Placemark><gx:Track>",
  "<when>2026-05-06T04:09:53Z</when>",
  "<gx:coord>139.700000 35.600000 10</gx:coord>",
  "<when>2026-05-06T04:09:55Z</when>",
  "<gx:coord>139.700100 35.600200 11</gx:coord>",
  "</gx:Track></Placemark></kml>",
].join("");
// 2026-05-06T04:09:53Z = epoch ms 1778040593000

test("parseKmlTrack: when と coord をペアにする", () => {
  assert.equal(parseKmlTrack(KML, 1778040593000).length, 2);
});
test("parseKmlTrack: coord順は lon lat alt", () => {
  const t = parseKmlTrack(KML, 1778040593000);
  assert.ok(Math.abs(t[0].lat - 35.6) < 1e-6);
  assert.ok(Math.abs(t[0].lon - 139.7) < 1e-6);
});
test("parseKmlTrack: when は秒オフセット", () => {
  const t = parseKmlTrack(KML, 1778040593000);
  assert.equal(t[0].t, 0.0);
  assert.equal(t[1].t, 2.0);
});
test("parseKmlTrack: 空KMLは空配列", () => {
  assert.deepEqual(parseKmlTrack("<kml></kml>", 0), []);
});

test("decimate: 上限以下はそのまま", () => {
  assert.deepEqual(decimate([1, 2, 3], 10), [1, 2, 3]);
});
test("decimate: maxPoints以下に減る", () => {
  const out = decimate(Array.from({ length: 100 }, (_, i) => i), 10);
  assert.ok(out.length <= 10);
});
test("decimate: 端点を保持", () => {
  const out = decimate(Array.from({ length: 100 }, (_, i) => i), 10);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 99);
});

test("hvLabel: null は --", () => assert.equal(hvLabel(null), "--"));
test("hvLabel: >=120 は 発電中・高", () => assert.equal(hvLabel(150), "発電中・高"));
test("hvLabel: 50..119 は 発電中・低", () => assert.equal(hvLabel(80), "発電中・低"));
test("hvLabel: <50 は 停止", () => assert.equal(hvLabel(2), "停止"));
test("hvLabel: 境界 120 は 発電中・高", () => assert.equal(hvLabel(120), "発電中・高"));
test("hvLabel: 境界 50 は 発電中・低", () => assert.equal(hvLabel(50), "発電中・低"));

const FILES = [
  { id: "a", name: "t33_20260620_101530.csv" },
  { id: "b", name: "t33_20260620_101530.kml" },
  { id: "c", name: "t33_20260620_101530.mp4" },
  { id: "d", name: "t33_20260620_101530_video.json" },
  { id: "e", name: "t33_20260619_090000.csv" },
  { id: "f", name: "stray_notes.txt" },
  { id: "g", name: "t33_20260618_080000.kml" }, // CSV無し → 除外
];

test("groupSessions: CSVありセッションのみ、新しい順", () => {
  const s = groupSessions(FILES);
  assert.equal(s.length, 2);
  assert.equal(s[0].stem, "t33_20260620_101530");
  assert.equal(s[1].stem, "t33_20260619_090000");
});
test("groupSessions: 種別ごとにfile IDを割当て", () => {
  const s = groupSessions(FILES)[0];
  assert.equal(s.csv, "a");
  assert.equal(s.kml, "b");
  assert.equal(s.mp4, "c");
  assert.equal(s.json, "d");
});
test("groupSessions: 表示ラベル", () => {
  const s = groupSessions(FILES)[0];
  assert.equal(s.dateLabel, "2026-06-20");
  assert.equal(s.timeLabel, "10:15:30");
});
test("groupSessions: KMLのみ(CSV無し)は除外", () => {
  assert.ok(!groupSessions(FILES).some((s) => s.stem === "t33_20260618_080000"));
});
