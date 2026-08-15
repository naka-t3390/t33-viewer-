import { test } from "node:test";
import assert from "node:assert/strict";
import { bearingDeg, distanceMeters, headingAt, nearestPassIndex } from "../js/geo.js";

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

// nearestPassIndex: 地図でクリックした地点を「いつ通ったか」を返す。
// 緯度35°では 経度0.0001度 ≈ 9.1m。以下の軌跡はこの間隔で東へ進む。
const LINE = Array.from({ length: 11 }, (_, i) => ({
  t: i, lat: 35.0, lon: 139.0 + i * 0.0001,
}));

test("nearestPassIndex: 軌跡上をクリックすると最も近い点の index", () => {
  assert.equal(nearestPassIndex(LINE, { lat: 35.0, lon: 139.0003 }, 20, 0), 3);
});

test("nearestPassIndex: 半径外のクリックは -1(誤タップで動画を飛ばさない)", () => {
  // 緯度0.01度 ≈ 1.1km 北。半径20mには遠く及ばない。
  assert.equal(nearestPassIndex(LINE, { lat: 35.01, lon: 139.0003 }, 20, 0), -1);
});

test("nearestPassIndex: 軌跡が空/不正なら -1", () => {
  assert.equal(nearestPassIndex([], { lat: 35.0, lon: 139.0 }, 20, 0), -1);
  assert.equal(nearestPassIndex(null, { lat: 35.0, lon: 139.0 }, 20, 0), -1);
});

// 往復: t=0..5 で東へ、t=6..11 で同じ道を西へ戻る。同じ地点を2度通る。
const ROUND = [
  ...Array.from({ length: 6 }, (_, i) => ({ t: i, lat: 35.0, lon: 139.0 + i * 0.0001 })),
  ...Array.from({ length: 6 }, (_, i) => ({ t: 6 + i, lat: 35.0, lon: 139.0 + (5 - i) * 0.0001 })),
];

test("nearestPassIndex: 往路を再生中なら往路の通過を選ぶ", () => {
  // lon 139.0002 は往路 index 2(t=2)と復路 index 9(t=9)。半径8mでこの2点だけが入る。
  assert.equal(nearestPassIndex(ROUND, { lat: 35.0, lon: 139.0002 }, 8, 1), 2);
});

test("nearestPassIndex: 復路を再生中なら復路の通過を選ぶ", () => {
  assert.equal(nearestPassIndex(ROUND, { lat: 35.0, lon: 139.0002 }, 8, 10), 9);
});

// GPS が一時的に飛んだ1点(55m北)を挟んでも、前後は同じ1回の通過である。
// これを2つの通過と数えると、再生位置しだいで手前と奥に振られてしまう。
const GAP = [
  { t: 0, lat: 35.0, lon: 139.0 },
  { t: 1, lat: 35.0, lon: 139.0001 },
  { t: 2, lat: 35.0, lon: 139.000195 }, // クリック点まで約0.46m
  { t: 3, lat: 35.0005, lon: 139.0002 }, // 飛んだ点(半径外)
  { t: 4, lat: 35.0, lon: 139.00021 },  // 約0.91m
  { t: 5, lat: 35.0, lon: 139.0003 },
];

test("nearestPassIndex: GPS欠落で途切れても近接する点は同じ通過として畳む", () => {
  const click = { lat: 35.0, lon: 139.0002 };
  // 1つの通過に畳まれていれば、再生位置がどこでも同じ(最も近い)点を指す。
  assert.equal(nearestPassIndex(GAP, click, 8, 0), 2);
  assert.equal(nearestPassIndex(GAP, click, 8, 100), 2);
});
