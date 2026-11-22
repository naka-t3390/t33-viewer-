import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRACK_FIX_DEFAULTS, TRACK_FIX_STORAGE_KEY,
  collapseStops, smoothTrack, simplifyTrack, correctTrack,
  readTrackFix, writeTrackFix,
} from "../js/geo-correct.js";
import { distanceMeters, nearestPassTime } from "../js/geo.js";

// 緯度35°では 緯度0.00001度 ≈ 1.11m、経度0.00001度 ≈ 0.91m。以下の座標はこれを前提にする。

// --- collapseStops: 停車中の団子を1点へ畳む ---

// 停車中の揺れ(アンカーから最大でも約1.9m)。1点に畳まれるべき。
const STOP_JITTER = [
  { t: 0, lat: 35.000000, lon: 139.000000 },
  { t: 1, lat: 35.000010, lon: 139.000005 },
  { t: 2, lat: 35.000005, lon: 139.000015 },
  { t: 3, lat: 35.000015, lon: 139.000010 },
  { t: 4, lat: 35.000008, lon: 139.000002 },
];

test("collapseStops: 停車中の揺れは1点に畳まれる", () => {
  const out = collapseStops(STOP_JITTER, 3);
  assert.equal(out.length, 1);
});

test("collapseStops: 畳んだ点の時刻は塊の先頭(その場所へ着いた時刻)", () => {
  assert.equal(collapseStops(STOP_JITTER, 3)[0].t, 0);
});

test("collapseStops: 畳んだ点の座標は塊の重心", () => {
  const [p] = collapseStops(STOP_JITTER, 3);
  assert.ok(Math.abs(p.lat - 35.0000076) < 1e-9, `lat=${p.lat}`);
  assert.ok(Math.abs(p.lon - 139.0000064) < 1e-9, `lon=${p.lon}`);
});

test("collapseStops: 走行中(10m 間隔)の点は1つも畳まれない", () => {
  const moving = Array.from({ length: 6 }, (_, i) => ({ t: i, lat: 35.0, lon: 139.0 + i * 0.00011 }));
  assert.equal(collapseStops(moving, 3).length, 6);
});

test("collapseStops: 半径が0以下なら何もしない", () => {
  assert.equal(collapseStops(STOP_JITTER, 0).length, STOP_JITTER.length);
});

test("collapseStops: 空配列・非配列は空配列", () => {
  assert.deepEqual(collapseStops([], 3), []);
  assert.deepEqual(collapseStops(null, 3), []);
});

// --- smoothTrack: 測位ノイズのギザギザを均す ---

test("smoothTrack: 直線から外れた1点は中央重み分だけ直線へ寄る", () => {
  // 真ん中の点だけ北へ 0.00005度(約5.5m)飛んでいる。
  const spike = [
    { t: 0, lat: 35.0, lon: 139.0000 },
    { t: 1, lat: 35.00005, lon: 139.0001 },
    { t: 2, lat: 35.0, lon: 139.0002 },
  ];
  const out = smoothTrack(spike, 0.5);
  // 両隣 0.25 ずつ + 自分 0.5 → 外れ量は半分になる。
  assert.ok(Math.abs(out[1].lat - 35.000025) < 1e-9, `lat=${out[1].lat}`);
});

test("smoothTrack: 両端の点は動かさない", () => {
  const spike = [
    { t: 0, lat: 35.0, lon: 139.0000 },
    { t: 1, lat: 35.00005, lon: 139.0001 },
    { t: 2, lat: 35.0, lon: 139.0002 },
  ];
  const out = smoothTrack(spike, 0.5);
  assert.equal(out[0].lat, 35.0);
  assert.equal(out[0].lon, 139.0);
  assert.equal(out[2].lat, 35.0);
  assert.equal(out[2].lon, 139.0002);
});

test("smoothTrack: 平均の元は入力であり、平滑化が連鎖しない", () => {
  // 全点が同じ向きにずれている場合、連鎖していれば後ろの点ほど大きく動く。
  const zigzag = [
    { t: 0, lat: 35.0, lon: 139.0000 },
    { t: 1, lat: 35.00004, lon: 139.0001 },
    { t: 2, lat: 35.00000, lon: 139.0002 },
    { t: 3, lat: 35.00004, lon: 139.0003 },
    { t: 4, lat: 35.0, lon: 139.0004 },
  ];
  const out = smoothTrack(zigzag, 0.5);
  // index1: 0.25*35.0 + 0.5*35.00004 + 0.25*35.0 = 35.00002
  assert.ok(Math.abs(out[1].lat - 35.00002) < 1e-9, `got ${out[1].lat}`);
  // index2: 0.25*35.00004 + 0.5*35.0 + 0.25*35.00004 = 35.00002(入力を読んでいる証拠)
  assert.ok(Math.abs(out[2].lat - 35.00002) < 1e-9, `got ${out[2].lat}`);
});

test("smoothTrack: 2点以下はそのまま返す", () => {
  const two = [{ t: 0, lat: 35.0, lon: 139.0 }, { t: 1, lat: 35.1, lon: 139.1 }];
  assert.deepEqual(smoothTrack(two, 0.5), two);
  assert.deepEqual(smoothTrack([], 0.5), []);
});

// --- simplifyTrack: 直線部を間引き、角は残す ---

test("simplifyTrack: 直線上の中間点は落ち、始終点は残る", () => {
  const line = Array.from({ length: 5 }, (_, i) => ({ t: i, lat: 35.0, lon: 139.0 + i * 0.00005 }));
  const out = simplifyTrack(line, 1.5, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0].t, 0);
  assert.equal(out[1].t, 4);
});

test("simplifyTrack: 曲がり角の点は残る", () => {
  // 東へ進んで直角に北へ折れる。角(index 2)が消えると道の形が壊れる。
  const corner = [
    { t: 0, lat: 35.0, lon: 139.0 },
    { t: 1, lat: 35.0, lon: 139.0002 },
    { t: 2, lat: 35.0, lon: 139.0004 },
    { t: 3, lat: 35.0002, lon: 139.0004 },
    { t: 4, lat: 35.0004, lon: 139.0004 },
  ];
  const out = simplifyTrack(corner, 1.5, 5);
  assert.ok(out.some((p) => p.t === 2), "角の点が残っていない");
});

test("simplifyTrack: 時間が大きく空いた点(停車の前後)は直線上でも残す", () => {
  // 全点が一直線。index 2 の直後に 60 秒の空白(= 畳まれた停車)がある。
  const withStop = [
    { t: 0, lat: 35.0, lon: 139.00000 },
    { t: 1, lat: 35.0, lon: 139.00005 },
    { t: 2, lat: 35.0, lon: 139.00010 },
    { t: 62, lat: 35.0, lon: 139.00015 },
    { t: 63, lat: 35.0, lon: 139.00020 },
  ];
  const out = simplifyTrack(withStop, 1.5, 5);
  assert.ok(out.some((p) => p.t === 2), "停車の手前の点が落ちている");
  assert.ok(out.some((p) => p.t === 62), "停車の直後の点が落ちている");
});

test("simplifyTrack: 2点以下・許容誤差0以下はそのまま", () => {
  const two = [{ t: 0, lat: 35.0, lon: 139.0 }, { t: 1, lat: 35.0, lon: 139.001 }];
  assert.deepEqual(simplifyTrack(two, 1.5, 5), two);
  const line = Array.from({ length: 4 }, (_, i) => ({ t: i, lat: 35.0, lon: 139.0 + i * 0.00005 }));
  assert.equal(simplifyTrack(line, 0, 5).length, 4);
});

// --- correctTrack: 3段をまとめて通す ---

// 東へ 10m/s で20秒 → 同じ場所で30秒停車(揺れあり) → さらに東へ20秒。
function makeDrive() {
  const pts = [];
  const step = 0.00011; // 約10m
  let lon = 139.0;
  for (let t = 0; t <= 20; t++) {
    // 走行中も ±1m 程度の測位ノイズを乗せる(偶数秒は北、奇数秒は南)。
    pts.push({ t, lat: 35.0 + (t % 2 ? -0.000009 : 0.000009), lon });
    lon += step;
  }
  const stopLon = lon;
  for (let k = 1; k <= 30; k++) {
    pts.push({ t: 20 + k, lat: 35.0 + (k % 3) * 0.000008, lon: stopLon + (k % 2) * 0.00001 });
  }
  for (let k = 1; k <= 20; k++) {
    lon += step;
    pts.push({ t: 50 + k, lat: 35.0 + (k % 2 ? -0.000009 : 0.000009), lon });
  }
  return pts;
}

test("correctTrack: 停車の団子が畳まれて点数が大きく減る", () => {
  const raw = makeDrive();
  const fixed = correctTrack(raw);
  assert.ok(fixed.length < raw.length * 0.6, `raw=${raw.length} fixed=${fixed.length}`);
  assert.ok(fixed.length >= 2);
});

test("correctTrack: 停車地点に点が1つしか残らない(団子が消える)", () => {
  const raw = makeDrive();
  const fixed = correctTrack(raw);
  // 停車中(t=21..50)の点がいくつ残ったか。畳まれていれば1点のはず。
  const atStop = fixed.filter((p) => p.t >= 21 && p.t <= 50);
  assert.ok(atStop.length <= 1, `停車中に ${atStop.length} 点残っている`);
});

test("correctTrack: 時刻は単調増加のまま保たれる", () => {
  const fixed = correctTrack(makeDrive());
  for (let i = 1; i < fixed.length; i++) {
    assert.ok(fixed[i].t > fixed[i - 1].t, `t が戻った: ${fixed[i - 1].t} -> ${fixed[i].t}`);
  }
});

test("correctTrack: 始点と終点の時刻は元の軌跡と同じ", () => {
  const raw = makeDrive();
  const fixed = correctTrack(raw);
  assert.equal(fixed[0].t, raw[0].t);
  assert.equal(fixed[fixed.length - 1].t, raw[raw.length - 1].t);
});

test("correctTrack: 元データ(入力の配列と要素)を書き換えない", () => {
  const raw = makeDrive();
  const before = JSON.stringify(raw);
  correctTrack(raw);
  assert.equal(JSON.stringify(raw), before, "元の軌跡が書き換えられた");
});

test("correctTrack: 補正後の点は元の軌跡から大きく離れない(道の形を保つ)", () => {
  const raw = makeDrive();
  const fixed = correctTrack(raw);
  // 補正後の各点から、元の軌跡の最寄り点までの距離。平滑化の移動量は数m以内に収まる。
  for (const p of fixed) {
    let min = Infinity;
    for (const q of raw) min = Math.min(min, distanceMeters(p.lat, p.lon, q.lat, q.lon));
    assert.ok(min < 5, `補正後の点が元から ${min.toFixed(1)}m 離れた`);
  }
});

test("correctTrack: 空・1点・2点はそのまま複製して返す", () => {
  assert.deepEqual(correctTrack([]), []);
  assert.deepEqual(correctTrack(null), []);
  const one = [{ t: 0, lat: 35.0, lon: 139.0 }];
  assert.deepEqual(correctTrack(one), one);
  const two = [{ t: 0, lat: 35.0, lon: 139.0 }, { t: 1, lat: 35.0, lon: 139.001 }];
  assert.deepEqual(correctTrack(two), two);
  assert.notEqual(correctTrack(two)[0], two[0], "要素が複製されていない");
});

// --- 補正後の軌跡でもクリック→シークが壊れないこと ---

test("correctTrack: 補正後の線をクリックしても元と同じ時刻へ飛べる", () => {
  const raw = makeDrive();
  const fixed = correctTrack(raw);
  // 走行中のある地点(t=10 付近)を押す。元と補正後で指す時刻が大きくずれないこと。
  const click = { lat: raw[10].lat, lon: raw[10].lon };
  const tRaw = nearestPassTime(raw, click, 15, 0);
  const tFixed = nearestPassTime(fixed, click, 15, 0);
  assert.ok(tRaw !== null && tFixed !== null, `raw=${tRaw} fixed=${tFixed}`);
  assert.ok(Math.abs(tRaw - tFixed) < 2, `raw=${tRaw} fixed=${tFixed}`);
});

test("correctTrack: 停車地点をクリックすると停まり始めた時刻へ飛ぶ", () => {
  const raw = makeDrive();
  const fixed = correctTrack(raw);
  const stop = raw.find((p) => p.t === 35); // 停車のまっただ中
  const t = nearestPassTime(fixed, { lat: stop.lat, lon: stop.lon }, 15, 0);
  // 停車は t=21 の1点に畳まれている。nearestPassTime は線分上の位置で時刻を内挿する
  // ので、発進側の点(t=51)へ数秒ぶん引かれる。停まり始め(21)の近くで、
  // 発進(51)からは遠いことを確かめる。
  assert.ok(t !== null && t >= 20 && t <= 26, `got ${t}`);
});

// --- 補正 ON/OFF の保存 ---

function fakeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map),
  };
}

test("readTrackFix: 未設定なら既定のオン", () => {
  assert.equal(readTrackFix(fakeStorage()), true);
});

test("readTrackFix: off を保存していればオフ、on ならオン", () => {
  assert.equal(readTrackFix(fakeStorage({ [TRACK_FIX_STORAGE_KEY]: "off" })), false);
  assert.equal(readTrackFix(fakeStorage({ [TRACK_FIX_STORAGE_KEY]: "on" })), true);
});

test("readTrackFix: storage が無い/例外を投げても既定のオンで動く", () => {
  assert.equal(readTrackFix(null), true);
  assert.equal(readTrackFix({ getItem() { throw new Error("SecurityError"); } }), true);
});

test("writeTrackFix: on/off を書き分け、書けなくても例外を出さない", () => {
  const s = fakeStorage();
  writeTrackFix(s, false);
  assert.equal(s.dump()[TRACK_FIX_STORAGE_KEY], "off");
  writeTrackFix(s, true);
  assert.equal(s.dump()[TRACK_FIX_STORAGE_KEY], "on");
  assert.doesNotThrow(() => writeTrackFix(null, true));
  assert.doesNotThrow(() => writeTrackFix({ setItem() { throw new Error("QuotaExceeded"); } }, true));
});

test("TRACK_FIX_DEFAULTS: 既定値は書き換えられない", () => {
  assert.throws(() => { "use strict"; TRACK_FIX_DEFAULTS.stopRadiusM = 99; });
});
