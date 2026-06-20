import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVideoStartMs } from "../js/parse.js";
import { parseCsvSeries } from "../js/parse.js";

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
