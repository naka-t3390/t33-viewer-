import { test } from "node:test";
import assert from "node:assert/strict";
import {
  YAW_CENTER,
  YAW_DEG_PER_COUNT,
  buildMotion,
  motionAt,
  correctTrack,
  estimateGpsLag,
  trackToFeatures,
} from "../js/dead-reckoning.js";

// ---- 合成データ ----
// 実走行の座標は公開リポジトリに入れない。真値の走行を先に決め、そこから
// CAN の車速/ヨーレートと GPS を作って、補正が真値へ戻せるかを確かめる。

const M_PER_DEG = (6371000 * Math.PI) / 180;
const REF = { lat: 35.0, lon: 139.0 };
const enuToLatLon = (e, n) => ({
  lat: REF.lat + n / M_PER_DEG,
  lon: REF.lon + e / (M_PER_DEG * Math.cos((REF.lat * Math.PI) / 180)),
});
const dist = (a, b) => Math.hypot(a.e - b.e, a.n - b.n);

/**
 * segments: [{ sec, kmh, yaw }]  yaw は deg/s、**正が左旋回**(舵角・ヨーレート生値と同じ向き)。
 * 方位は北0°・東回りなので、左旋回では減る。
 */
function simulate(segments, { startHeading = 90, yawGain = 1, speedScale = 1, bias = 0 } = {}) {
  const dt = 0.1;
  let t = 0, e = 0, n = 0, psi = startHeading;
  const truth = [{ t, e, n }];
  const speed = [], yaw = [];
  for (const seg of segments) {
    const steps = Math.round(seg.sec / dt);
    for (let i = 0; i < steps; i++) {
      psi -= seg.yaw * dt;
      const v = seg.kmh / 3.6;
      e += v * dt * Math.sin((psi * Math.PI) / 180);
      n += v * dt * Math.cos((psi * Math.PI) / 180);
      t = Math.round((t + dt) * 1000) / 1000;
      truth.push({ t, e, n });
      speed.push({ t, kmh: seg.kmh * speedScale });
      yaw.push({ t, raw: Math.round(YAW_CENTER + bias + (seg.yaw * yawGain) / YAW_DEG_PER_COUNT) });
    }
  }
  return { truth, signals: { speed, yaw } };
}

// 停車 10 秒 → 直進 40 秒 → 左 90° → 直進 40 秒 → 右 90° → 直進 60 秒
const DRIVE = [
  { sec: 10, kmh: 0, yaw: 0 },
  { sec: 40, kmh: 40, yaw: 0 },
  { sec: 10, kmh: 30, yaw: 9 },
  { sec: 40, kmh: 40, yaw: 0 },
  { sec: 10, kmh: 30, yaw: -9 },
  { sec: 60, kmh: 40, yaw: 0 },
];

const truthAt = (truth, t) => truth[Math.round(t * 10)];
const gpsFixes = (truth, from, to, step = 1) => {
  const out = [];
  for (let t = from; t <= to; t += step) {
    const p = truthAt(truth, t);
    out.push({ t, ...enuToLatLon(p.e, p.n) });
  }
  return out;
};
const errorAt = (res, truth, t) => {
  const p = res.points.find((q) => q.t === t);
  assert.ok(p, `t=${t} の点が無い`);
  const ref = truthAt(truth, t);
  const e = (p.lon - REF.lon) * M_PER_DEG * Math.cos((REF.lat * Math.PI) / 180);
  const n = (p.lat - REF.lat) * M_PER_DEG;
  return dist({ e, n }, ref);
};
const maxError = (res, truth, from, to) => {
  let m = 0;
  for (const p of res.points) if (p.t >= from && p.t <= to) m = Math.max(m, errorAt(res, truth, p.t));
  return m;
};

// ---- 積分(相対座標。出発点を原点、北向きを 0° とする) ----

test("積分: 20m/s で 10 秒まっすぐ進むと北へ約 200m", () => {
  const { signals } = simulate([{ sec: 10, kmh: 72, yaw: 0 }], { startHeading: 0 });
  const m = buildMotion(signals);
  const end = motionAt(m, 10);
  assert.ok(Math.abs(end.y - 200) < 2, `y=${end.y}`);
  assert.ok(Math.abs(end.x) < 1, `x=${end.x}`);
});

test("積分: ヨーレート生値が大きい側が左旋回(北向きから西へ曲がる)", () => {
  const { signals } = simulate([{ sec: 9, kmh: 36, yaw: 10 }], { startHeading: 0 });
  const end = motionAt(buildMotion(signals), 9);
  assert.ok(end.x < -20, `西へ曲がるはず x=${end.x}`);
  assert.ok(end.y > 20, `北へも進むはず y=${end.y}`);
});

test("積分: 一定の旋回で 1 周すると出発点へ戻る", () => {
  // 36km/h・10deg/s → 36 秒で 1 周(半径 約 57m)
  const { signals } = simulate([{ sec: 36, kmh: 36, yaw: 10 }], { startHeading: 0 });
  const end = motionAt(buildMotion(signals), 36);
  assert.ok(Math.hypot(end.x, end.y) < 3, `戻り誤差 ${Math.hypot(end.x, end.y)} m`);
});

test("積分: 停車中のヨーレートのずれ(ゼロ点)を引いて直進を保つ", () => {
  const segs = [{ sec: 10, kmh: 0, yaw: 0 }, { sec: 20, kmh: 36, yaw: 0 }];
  const { signals } = simulate(segs, { startHeading: 0, bias: 60 });
  const end = motionAt(buildMotion(signals), 30);
  assert.ok(Math.abs(end.x) < 3, `ゼロ点を引かないと曲がる x=${end.x}`);
  assert.ok(Math.abs(end.y - 200) < 3, `y=${end.y}`);
});

test("積分: 停車中は位置も方位も動かない", () => {
  const { signals } = simulate([{ sec: 10, kmh: 0, yaw: 5 }], { startHeading: 0 });
  const end = motionAt(buildMotion(signals), 10);
  assert.ok(Math.hypot(end.x, end.y) < 0.01);
});

test("積分: 停車中のヨーレートの揺れで、発進後の進行方向をずらさない", () => {
  // 停車 10 秒のうち 2〜5 秒だけヨーレートが大きく揺れる(中央値は変わらないのでゼロ点は 32000 のまま)。
  // 停車中の旋回を積分してしまうと、発進後にまっすぐ走っても北から外れる。
  const segs = [{ sec: 10, kmh: 0, yaw: 0 }, { sec: 20, kmh: 36, yaw: 0 }];
  const { signals } = simulate(segs, { startHeading: 0 });
  for (const y of signals.yaw) if (y.t > 2 && y.t <= 5) y.raw = YAW_CENTER + 3000;
  const end = motionAt(buildMotion(signals), 30);
  assert.ok(Math.abs(end.x) < 3, `停車中の揺れで曲がった x=${end.x}`);
  assert.ok(Math.abs(end.y - 200) < 3, `y=${end.y}`);
});

test("積分: 信号が無ければ null", () => {
  assert.equal(buildMotion({ speed: [], yaw: [] }), null);
});

// ---- GPS 補正 ----

test("補正: 車速とヨーレートに数%の誤差があっても、GPS で真値へ戻る", () => {
  const { truth, signals } = simulate(DRIVE, { yawGain: 1.03, speedScale: 0.98, startHeading: 70 });
  const res = correctTrack(gpsFixes(truth, 0, 170), signals);
  assert.ok(res, "補正できる");
  assert.ok(maxError(res, truth, 20, 160) < 15, `最大誤差 ${maxError(res, truth, 20, 160)} m`);
});

test("補正: 出発方位が分からなくても GPS から決まる", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 215 });
  const res = correctTrack(gpsFixes(truth, 0, 170), signals);
  assert.ok(maxError(res, truth, 20, 160) < 8, `最大誤差 ${maxError(res, truth, 20, 160)} m`);
});

test("補正: GPS が 1 点だけ 300m 飛んでも引きずられない", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  const gps = gpsFixes(truth, 0, 170);
  // 41 秒はアンカー候補(最初の走行点 11 秒 + 30 秒)。ここが飛ぶと、見分けなければ経路ごと曲がる。
  const spike = gps.find((g) => g.t === 41);
  Object.assign(spike, enuToLatLon(truthAt(truth, 41).e + 300, truthAt(truth, 41).n));
  const res = correctTrack(gps, signals);
  assert.ok(errorAt(res, truth, 41) < 12, `飛んだ点の誤差 ${errorAt(res, truth, 41)} m`);
  assert.ok(maxError(res, truth, 20, 160) < 15);
});

test("補正: GPS が止まったまま(固着)でも、走行を CAN から描く", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  const gps = gpsFixes(truth, 0, 170);
  // 70 秒の位置のまま 60 秒間固着。途中の 71 秒・101 秒はアンカー候補で、
  // 見分けなければ 330m 手前の点を基準に経路ごとずれる。
  const frozen = gps.find((g) => g.t === 70);
  for (const g of gps) if (g.t > 70 && g.t < 130) { g.lat = frozen.lat; g.lon = frozen.lon; }
  const res = correctTrack(gps, signals);
  assert.ok(res);
  assert.ok(errorAt(res, truth, 100) < 15, `固着中の誤差 ${errorAt(res, truth, 100)} m`);
  assert.ok(errorAt(res, truth, 115) < 15, `固着中の誤差 ${errorAt(res, truth, 115)} m`);
  assert.ok(maxError(res, truth, 20, 160) < 20, `最大誤差 ${maxError(res, truth, 20, 160)} m`);
});

test("補正: GPS が途切れた後は CAN で延ばし、その区間を推定(est)と印す", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  const res = correctTrack(gpsFixes(truth, 0, 110), signals);
  assert.ok(res);
  const tail = res.points.filter((p) => p.t > 120);
  assert.ok(tail.length > 30, "GPS が無い後半も点がある");
  assert.ok(tail.every((p) => p.est === true), "GPS が無い区間は est");
  assert.ok(res.points.filter((p) => p.t >= 20 && p.t <= 100).every((p) => !p.est), "GPS がある区間は est にしない");
  assert.ok(errorAt(res, truth, 160) < 10, `延長の誤差 ${errorAt(res, truth, 160)} m`);
});

test("補正: GPS が走行の途中でしか取れなくても、前後を CAN で描く(2026-11-21 13:45 のパターン)", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  // 60〜66 秒の 7 点(約 6 秒分、移動 約 67m)しか無い
  const res = correctTrack(gpsFixes(truth, 60, 66), signals);
  assert.ok(res, "短い GPS でも向きが決まれば補正できる");
  assert.ok(res.points.some((p) => p.t < 50 && p.est), "手前は推定");
  assert.ok(res.points.some((p) => p.t > 120 && p.est), "後ろも推定");
  assert.ok(errorAt(res, truth, 160) < 40, `延長の誤差 ${errorAt(res, truth, 160)} m`);
});

test("補正: 車速が 2 割低く出ても、アンカーで経路が途切れない(残差を走った距離に比例して配る)", () => {
  // 拡縮の上限(1.12)を超える誤差。回転・拡縮で合わせきれない分が、区間の終端でまとめて
  // 出ると、アンカーごとに経路が数十 m 跳ねる。
  const { truth, signals } = simulate(DRIVE, { startHeading: 70, speedScale: 0.8 });
  const res = correctTrack(gpsFixes(truth, 0, 170), signals);
  assert.ok(res);
  assert.ok(maxError(res, truth, 20, 160) < 15, `最大誤差 ${maxError(res, truth, 20, 160)} m`);
  let maxStep = 0;
  for (let i = 1; i < res.points.length; i++) {
    const a = res.points[i - 1], b = res.points[i];
    const e = (b.lon - a.lon) * M_PER_DEG * Math.cos((REF.lat * Math.PI) / 180);
    const n = (b.lat - a.lat) * M_PER_DEG;
    maxStep = Math.max(maxStep, Math.hypot(e, n));
  }
  // 40km/h = 11m/s。1 秒で 20m を超えて動くなら、どこかで跳ねている。
  assert.ok(maxStep < 20, `1 秒あたりの最大移動 ${maxStep} m`);
});

test("補正: 使える GPS が無ければ null(呼び出し側は生の軌跡のまま)", () => {
  const { signals } = simulate(DRIVE);
  assert.equal(correctTrack([], signals), null);
  const stopped = gpsFixes(simulate(DRIVE).truth, 0, 5);
  assert.equal(correctTrack(stopped, signals), null, "停車中の GPS だけでは向きが決まらない");
});

test("補正: CAN が無ければ null", () => {
  const { truth } = simulate(DRIVE);
  assert.equal(correctTrack(gpsFixes(truth, 0, 100), { speed: [], yaw: [] }), null);
});

test("補正: 停車中は位置が動かない(GPS の団子を作らない)", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  const res = correctTrack(gpsFixes(truth, 0, 170), signals);
  const still = res.points.filter((p) => p.t >= 1 && p.t <= 9);
  const first = still[0];
  for (const p of still) {
    const e = (p.lon - first.lon) * M_PER_DEG * Math.cos((REF.lat * Math.PI) / 180);
    const n = (p.lat - first.lat) * M_PER_DEG;
    assert.ok(Math.hypot(e, n) < 0.5, "停車中に動いている");
  }
});

test("補正: 出力は 1 秒刻みで t が昇順", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  const res = correctTrack(gpsFixes(truth, 0, 170), signals);
  for (let i = 1; i < res.points.length; i++) {
    assert.equal(res.points[i].t - res.points[i - 1].t, 1);
  }
});

test("補正: 統計(アンカー数・推定秒数)を返す", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  const res = correctTrack(gpsFixes(truth, 0, 110), signals);
  assert.ok(res.stats.anchors >= 2);
  assert.ok(res.stats.estimatedSec > 30);
});

test("補正: アンカーにした GPS の時刻を返す(検証・デバッグ用)", () => {
  const { truth, signals } = simulate(DRIVE, { startHeading: 70 });
  const res = correctTrack(gpsFixes(truth, 0, 170), signals);
  assert.equal(res.stats.anchorTimes.length, res.stats.anchors);
  assert.ok(res.stats.anchorTimes.every((t, i, a) => i === 0 || t > a[i - 1]), "昇順");
});

// ---- GPS と端末の時計のずれ ----
// GPS の時刻は衛星由来で正確だが、端末の時計(CAN・動画)は SIM なしだと数秒ずれる。
// 2026-11-21 11:22 のセッションでは約 6 秒あり、時速 40km で 66m の食い違いになった。

/** 速度が常に変化する走行(速度の突き合わせで時刻ずれを測るには、変化が要る)。 */
function wavyDrive() {
  const segs = [{ sec: 10, kmh: 0, yaw: 0 }];
  for (let i = 0; i < 180; i++) {
    const phase = i % 60;
    segs.push({
      sec: 1,
      kmh: 35 + 20 * Math.sin((2 * Math.PI * i) / 24),
      yaw: phase >= 20 && phase < 30 ? 9 : phase >= 50 ? -9 : 0,
    });
  }
  return segs;
}
/** 端末の時計より lagS 秒だけ遅れた時刻を付けた GPS。 */
const laggedGps = (truth, lagS, from, to) =>
  gpsFixes(truth, from, to).map((g) => ({ ...g, t: g.t - lagS }));

test("時刻ずれ: GPS の時刻が端末より 4 秒遅れていれば、4 秒と推定する", () => {
  const { truth, signals } = simulate(wavyDrive(), { startHeading: 70 });
  const r = estimateGpsLag(laggedGps(truth, 4, 5, 185), buildMotion(signals));
  assert.equal(r.estimated, true);
  assert.ok(Math.abs(r.lagS - 4) < 0.3, `lag=${r.lagS}`);
});

test("時刻ずれ: 負の向き(GPS が先走っている)も推定する", () => {
  const { truth, signals } = simulate(wavyDrive(), { startHeading: 70 });
  const r = estimateGpsLag(laggedGps(truth, -3, 5, 185), buildMotion(signals));
  assert.ok(Math.abs(r.lagS + 3) < 0.3, `lag=${r.lagS}`);
});

test("時刻ずれ: ずれが無ければ 0 のまま(推定で動かさない)", () => {
  const { truth, signals } = simulate(wavyDrive(), { startHeading: 70 });
  const r = estimateGpsLag(laggedGps(truth, 0, 5, 185), buildMotion(signals));
  assert.equal(r.lagS, 0);
  assert.equal(r.estimated, false);
});

test("時刻ずれ: 速度がほぼ一定で手がかりが無ければ 0(でたらめな値を採らない)", () => {
  const { truth, signals } = simulate([{ sec: 10, kmh: 0, yaw: 0 }, { sec: 120, kmh: 40, yaw: 0 }]);
  const r = estimateGpsLag(laggedGps(truth, 5, 5, 125), buildMotion(signals));
  assert.equal(r.lagS, 0);
  assert.equal(r.estimated, false);
});

test("時刻ずれ: GPS が動かない(固着)ときは推定しない — 走行の手がかりが無い", () => {
  // 2026-11-21 13:36 のパターン。長い停車のあと走行したが、GPS は同じ場所を返し続けた。
  // GPS の速度は常に 0 なので、CAN の長い停車区間に重ねれば「食い違いが減る」だけの偽の谷ができる。
  const segs = [{ sec: 120, kmh: 0, yaw: 0 }, ...wavyDrive().slice(1, 61)];
  const { truth, signals } = simulate(segs, { startHeading: 70 });
  const p0 = truthAt(truth, 5);
  const frozen = [];
  for (let t = 5; t <= 175; t++) frozen.push({ t, ...enuToLatLon(p0.e, p0.n) });
  const r = estimateGpsLag(frozen, buildMotion(signals));
  assert.equal(r.lagS, 0);
  assert.equal(r.estimated, false);
});

test("時刻ずれ: 補正は時刻ずれを織り込んで真値へ戻る", () => {
  const { truth, signals } = simulate(wavyDrive(), { startHeading: 70 });
  const res = correctTrack(laggedGps(truth, 4, 5, 185), signals);
  assert.ok(res);
  assert.ok(Math.abs(res.stats.gpsLagS - 4) < 0.3, `lag=${res.stats.gpsLagS}`);
  assert.ok(maxError(res, truth, 30, 180) < 12, `最大誤差 ${maxError(res, truth, 30, 180)} m`);
});

// ---- 描画用 GeoJSON ----

test("trackToFeatures: est の切れ目で線を分け、境界の点を共有してつなぐ", () => {
  const pts = [
    { t: 0, lat: 1, lon: 1, est: true },
    { t: 1, lat: 2, lon: 2, est: true },
    { t: 2, lat: 3, lon: 3, est: false },
    { t: 3, lat: 4, lon: 4, est: false },
    { t: 4, lat: 5, lon: 5, est: true },
  ];
  const fs = trackToFeatures(pts);
  assert.deepEqual(fs.map((f) => f.properties.est), [true, false, true]);
  assert.deepEqual(fs[0].geometry.coordinates, [[1, 1], [2, 2]]);
  assert.deepEqual(fs[1].geometry.coordinates, [[2, 2], [3, 3], [4, 4]]);
  assert.deepEqual(fs[2].geometry.coordinates, [[4, 4], [5, 5]]);
});

test("trackToFeatures: est の無い軌跡(生 GPS)は 1 本の実線", () => {
  const fs = trackToFeatures([{ t: 0, lat: 1, lon: 1 }, { t: 1, lat: 2, lon: 2 }]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].properties.est, false);
});

test("trackToFeatures: 点が 2 つ未満なら線を作らない", () => {
  assert.deepEqual(trackToFeatures([{ t: 0, lat: 1, lon: 1 }]), []);
  assert.deepEqual(trackToFeatures([]), []);
});
