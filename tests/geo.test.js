import { test } from "node:test";
import assert from "node:assert/strict";
import { bearingDeg, distanceMeters, headingAt } from "../js/geo.js";

// 方位角: 0=北, 90=東, 180=南, 270=西。緯度経度差から方向を検証する。
test("bearingDeg: 真北へ移動すると約0度", () => {
  const b = bearingDeg(35.0, 139.0, 35.01, 139.0);
  assert.ok(Math.abs(b) < 1 || Math.abs(b - 360) < 1, `got ${b}`);
});
test("bearingDeg: 真東へ移動すると約90度", () => {
  assert.ok(Math.abs(bearingDeg(35.0, 139.0, 35.0, 139.01) - 90) < 1);
});
test("bearingDeg: 真南へ移動すると約180度", () => {
  assert.ok(Math.abs(bearingDeg(35.0, 139.0, 34.99, 139.0) - 180) < 1);
});
test("bearingDeg: 真西へ移動すると約270度", () => {
  assert.ok(Math.abs(bearingDeg(35.0, 139.0, 35.0, 138.99) - 270) < 1);
});
test("bearingDeg: 戻り値は常に0以上360未満に正規化され南西は第3象限", () => {
  // 南かつ西へ移動 → 方位は 180〜270 度(南西象限)。緯度35°では経度が
  // 圧縮されるため南寄り(≈219°)になり、ちょうど225°にはならない。
  const b = bearingDeg(35.0, 139.0, 34.99, 138.99);
  assert.ok(b >= 0 && b < 360, `got ${b}`);
  assert.ok(b > 180 && b < 270, `got ${b}`);
});

test("distanceMeters: 同一点は0", () => {
  assert.equal(distanceMeters(35.0, 139.0, 35.0, 139.0), 0);
});
test("distanceMeters: 緯度0.001度差は約111m", () => {
  const d = distanceMeters(35.0, 139.0, 35.001, 139.0);
  assert.ok(Math.abs(d - 111) < 3, `got ${d}`);
});

// headingAt: track[index] 時点の進行方向。停車中(閾値未満の移動)は null を返し、
// 呼び出し側が前回値を保持できるようにする。
const straightNorth = [
  { t: 0, lat: 35.000, lon: 139.0 },
  { t: 1, lat: 35.001, lon: 139.0 },
  { t: 2, lat: 35.002, lon: 139.0 },
  { t: 3, lat: 35.003, lon: 139.0 },
];
test("headingAt: 北上する軌跡の中間点は約0度", () => {
  const h = headingAt(straightNorth, 1, 5);
  assert.ok(h != null && (Math.abs(h) < 2 || Math.abs(h - 360) < 2), `got ${h}`);
});
test("headingAt: 末尾点でも直前点から方位を算出できる", () => {
  const h = headingAt(straightNorth, 3, 5);
  assert.ok(h != null && (Math.abs(h) < 2 || Math.abs(h - 360) < 2), `got ${h}`);
});
test("headingAt: 停車(全点同座標)は null を返す", () => {
  const stopped = [
    { t: 0, lat: 35.0, lon: 139.0 },
    { t: 1, lat: 35.0, lon: 139.0 },
    { t: 2, lat: 35.0, lon: 139.0 },
  ];
  assert.equal(headingAt(stopped, 1, 5), null);
});
test("headingAt: 空配列・範囲外indexは null", () => {
  assert.equal(headingAt([], 0, 5), null);
  assert.equal(headingAt(straightNorth, 99, 5), null);
  assert.equal(headingAt(straightNorth, -1, 5), null);
});
test("headingAt: 前方が微動でも後方の点まで遡って方位を算出", () => {
  // index 2 の直前(1→2)は微動、前方が無いので後方 0→2 で東向きを返す。
  const mixed = [
    { t: 0, lat: 35.0, lon: 139.0 },
    { t: 1, lat: 35.0, lon: 139.02 },
    { t: 2, lat: 35.0, lon: 139.0200001 },
  ];
  const h = headingAt(mixed, 2, 5);
  assert.ok(h != null && Math.abs(h - 90) < 2, `got ${h}`);
});
