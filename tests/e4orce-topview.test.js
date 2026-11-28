import { test } from "node:test";
import assert from "node:assert/strict";
import {
  turnRadiusFor, ackermannFactors, slipFraction,
  wheelRingAngleDeg, ringForwardSign, wheelArcSpanDeg, arcThicknessRatio, wheelSizeScale,
  e4orceStateOf, centerOfGravityOffset, CenterOfGravityTrail,
  WHEEL_FL, WHEEL_FR, WHEEL_RL, WHEEL_RR,
  ACCEL_G_CENTER, CG_FULL_LATERAL_G, CG_FULL_LONGITUDINAL_COUNTS,
  WHEELBASE_M, TRACK_M, STEERING_GEAR_RATIO,
} from "../js/e4orce-topview.js";

const near = (actual, expected, tol = 1e-6, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label} expected ≒${expected}, got ${actual}`);

/** 四輪と舵角が揃ったサンプル。 */
const sampleOf = (over = {}) => ({
  hasCan: true,
  steeringDeg: 0,
  accelGRaw: ACCEL_G_CENTER,
  wheelKmh: [30, 30, 30, 30],
  ...over,
});

// ---- 旋回の幾何 ----

test("寸法とギア比は端末の VehicleGeometry と同じ", () => {
  assert.equal(WHEELBASE_M, 2.705);
  assert.equal(TRACK_M, 1.59);
  assert.equal(STEERING_GEAR_RATIO, 17.3);
});

test("ハンドル角 3 度未満は直進として扱う(旋回半径なし)", () => {
  assert.equal(turnRadiusFor(0), null);
  assert.equal(turnRadiusFor(2.9), null);
  assert.equal(turnRadiusFor(-2.9), null);
  assert.ok(turnRadiusFor(3.1) !== null);
});

test("旋回半径は ホイールベース ÷ tan(前輪切れ角)。左右で同じ大きさ", () => {
  // 100 度 ÷ 17.3 = 5.780 度 → 2.705 / tan(5.780°) = 26.73 m
  near(turnRadiusFor(100), 26.73, 0.05, "旋回半径");
  near(turnRadiusFor(-100), turnRadiusFor(100), 1e-9, "左右対称");
  // 深く切れば小さくなる
  assert.ok(turnRadiusFor(300) < turnRadiusFor(100));
});

test("直進なら四輪の理論速度比は全部 1", () => {
  assert.deepEqual(ackermannFactors(0), [1, 1, 1, 1]);
});

test("左へ切れば左が内側(遅い)、前輪は後輪より大きな半径を通る", () => {
  const f = ackermannFactors(100); // 左
  assert.ok(f[WHEEL_RL] < f[WHEEL_RR], "後軸: 左(内)が遅い");
  assert.ok(f[WHEEL_FL] < f[WHEEL_FR], "前軸: 左(内)が遅い");
  assert.ok(f[WHEEL_FL] > f[WHEEL_RL], "前輪は後輪より大きな半径");
  assert.ok(f[WHEEL_FR] > f[WHEEL_RR], "前輪は後輪より大きな半径");
});

test("右へ切れば右が内側になる(左右が入れ替わる)", () => {
  const f = ackermannFactors(-100);
  assert.ok(f[WHEEL_RR] < f[WHEEL_RL], "後軸: 右(内)が遅い");
});

// ---- スリップ → 見え方 ----

test("スリップは基準速度に対する割合で見て、3% で振り切れる", () => {
  near(slipFraction(0.9, 30), 1.0, 1e-9, "3% で +1");
  near(slipFraction(0.45, 30), 0.5, 1e-9, "1.5% で +0.5");
  near(slipFraction(-0.9, 30), -1.0, 1e-9, "引きずりは負");
  near(slipFraction(9, 30), 1.0, 1e-9, "それ以上は振り切れたまま");
});

test("停車中(基準 0)はゼロ割りを避けて 0 を返す", () => {
  assert.equal(slipFraction(0.5, 0), 0);
  assert.equal(slipFraction(0.5, -1), 0);
});

test("効いていない(0.15 未満)なら弧は長さも太さも 0 にして何も描かない", () => {
  assert.equal(wheelArcSpanDeg(0.14), 0);
  assert.equal(arcThicknessRatio(0.14), 0);
  assert.ok(wheelArcSpanDeg(0.15) > 0);
  assert.ok(arcThicknessRatio(0.15) > 0);
});

test("弧の長さは最大 76 度まで(隣の弧と繋がらない)", () => {
  near(wheelArcSpanDeg(0.5), 38, 1e-9, "半分");
  assert.equal(wheelArcSpanDeg(1), 76);
  assert.equal(wheelArcSpanDeg(5), 76); // 振り切れても超えない
});

test("弧の太さは 0.045〜0.16(リング半径に対する割合)", () => {
  near(arcThicknessRatio(0.15), 0.045 + 0.115 * 0.15, 1e-9, "下端付近");
  near(arcThicknessRatio(1), 0.16, 1e-9, "上限");
});

test("タイヤの倍率は 1.0〜1.75。強く回っている輪ほど大きい", () => {
  assert.equal(wheelSizeScale(0), 1);
  near(wheelSizeScale(0.5), 1.375, 1e-9, "中間");
  assert.equal(wheelSizeScale(1), 1.75);
  assert.equal(wheelSizeScale(3), 1.75); // クランプ
});

test("四輪はリング上で 90 度ずつ離れ、車の前は真上(270 度)の左右 45 度", () => {
  assert.equal(wheelRingAngleDeg(WHEEL_FL), 225);
  assert.equal(wheelRingAngleDeg(WHEEL_FR), 315);
  assert.equal(wheelRingAngleDeg(WHEEL_RL), 135);
  assert.equal(wheelRingAngleDeg(WHEEL_RR), 45);
});

test("前方へ向かう回り方は左右で符号が逆(リングが円だから)", () => {
  assert.equal(ringForwardSign(WHEEL_FL), 1);
  assert.equal(ringForwardSign(WHEEL_RL), 1);
  assert.equal(ringForwardSign(WHEEL_FR), -1);
  assert.equal(ringForwardSign(WHEEL_RR), -1);
});

// ---- 状態の組み立て ----

test("舵角か四輪が欠けていれば null(データ待ちを出す)", () => {
  assert.equal(e4orceStateOf(null), null);
  assert.equal(e4orceStateOf({ hasCan: false, steeringDeg: 0, wheelKmh: [1, 1, 1, 1] }), null);
  assert.equal(e4orceStateOf(sampleOf({ steeringDeg: NaN })), null);
  assert.equal(e4orceStateOf(sampleOf({ wheelKmh: [30, 30, NaN, 30] })), null);
});

test("停車中は配分を計算せず 0 にする(ノイズが巨大なスリップに化けるため)", () => {
  const s = e4orceStateOf(sampleOf({ wheelKmh: [0.2, 0.1, 0.0, 0.3] }));
  assert.deepEqual(s.slipKmh, [0, 0, 0, 0]);
  assert.equal(s.referenceKmh, 0);
});

test("直進で四輪が揃っていれば基準速度はその値、スリップは 0", () => {
  const s = e4orceStateOf(sampleOf({ wheelKmh: [30, 30, 30, 30] }));
  near(s.referenceKmh, 30, 1e-9, "基準速度");
  for (const v of s.slipKmh) near(v, 0, 1e-9, "スリップ");
});

test("前輪だけ速ければ前のスリップが正になる(前が駆動されている)", () => {
  const s = e4orceStateOf(sampleOf({ wheelKmh: [30.3, 30.3, 30, 30] }));
  assert.ok(s.slipKmh[WHEEL_FL] > 0 && s.slipKmh[WHEEL_FR] > 0);
  assert.ok(s.slipKmh[WHEEL_RL] < 0 && s.slipKmh[WHEEL_RR] < 0);
});

test("基準速度は車体速度ではなく四輪から逆算する(車体速度のスケール誤差を持ち込まない)", () => {
  // 車体速度の列(speedKmh)を極端に外しても state は変わらない
  const a = e4orceStateOf(sampleOf({ speedKmh: 30 }));
  const b = e4orceStateOf(sampleOf({ speedKmh: 999 }));
  near(a.referenceKmh, b.referenceKmh, 1e-12, "基準速度は車体速度に依らない");
});

// ---- 重心ポイント ----

test("左旋回では遠心力で右(+x)へ寄り、右旋回では左(-x)へ寄る", () => {
  const base = { turnRadiusM: 20, referenceKmh: 18, accelGRaw: ACCEL_G_CENTER };
  const left = centerOfGravityOffset({ ...base, steeringDegrees: 50 });
  const right = centerOfGravityOffset({ ...base, steeringDegrees: -50 });
  // 5 m/s, R=20m → 25 / (20 × 9.80665) = 0.12747 G → ÷ 0.35 = 0.3642
  near(left.x, 0.3642, 1e-3, "左旋回で +x");
  near(right.x, -0.3642, 1e-3, "右旋回で -x");
  near(left.y, 0, 1e-12, "前後G 中心なら y=0");
});

test("直進(旋回半径なし)や 1km/h 未満では横方向に寄らない", () => {
  const straight = centerOfGravityOffset({
    turnRadiusM: null, referenceKmh: 50, steeringDegrees: 0, accelGRaw: ACCEL_G_CENTER,
  });
  assert.equal(straight.x, 0);
  const crawl = centerOfGravityOffset({
    turnRadiusM: 20, referenceKmh: 0.5, steeringDegrees: 50, accelGRaw: ACCEL_G_CENTER,
  });
  assert.equal(crawl.x, 0);
});

test("加速で後ろ(+y)、減速・制動で前(-y)へ寄る", () => {
  const base = { turnRadiusM: null, referenceKmh: 30, steeringDegrees: 0 };
  const half = CG_FULL_LONGITUDINAL_COUNTS / 2;
  near(centerOfGravityOffset({ ...base, accelGRaw: ACCEL_G_CENTER + half }).y, 0.5, 1e-9, "加速");
  near(centerOfGravityOffset({ ...base, accelGRaw: ACCEL_G_CENTER - half }).y, -0.5, 1e-9, "減速");
});

test("前後G が取れていなければ y は 0(もっともらしい値を置かない)", () => {
  const o = centerOfGravityOffset({
    turnRadiusM: null, referenceKmh: 30, steeringDegrees: 0, accelGRaw: null,
  });
  assert.equal(o.y, 0);
});

test("合成ベクトルの長さは 1.0 に収める(リングの外へ出さない)", () => {
  const o = centerOfGravityOffset({
    turnRadiusM: 5, referenceKmh: 60, steeringDegrees: 200,
    accelGRaw: ACCEL_G_CENTER + CG_FULL_LONGITUDINAL_COUNTS * 3,
  });
  near(Math.hypot(o.x, o.y), 1, 1e-9, "単位円上");
});

test("横G が振り切れる基準は 0.35G", () => {
  assert.equal(CG_FULL_LATERAL_G, 0.35);
});

// ---- 重心の残像 ----

test("残像は記録間隔(33ms)より短い間隔では増えない", () => {
  const trail = new CenterOfGravityTrail();
  const o = { x: 0, y: 0 };
  assert.equal(trail.record(o, 100).length, 1);
  assert.equal(trail.record(o, 110).length, 1);
  assert.equal(trail.record(o, 140).length, 2);
});

test("残像は保持時間(1400ms)より古い点を捨てる", () => {
  const trail = new CenterOfGravityTrail();
  const o = { x: 0, y: 0 };
  for (let ms = 100; ms <= 2000; ms += 50) trail.record(o, ms);
  const last = trail.record(o, 2050);
  assert.ok(last.length > 0);
  assert.ok(last.every((s) => s.timeMs >= 2050 - 1400), "古い点が残っていない");
});

test("残像の濃さは残り寿命。最新が 1.0、保持時間を過ぎたら 0", () => {
  const trail = new CenterOfGravityTrail(1400, 33);
  const s = { offset: { x: 0, y: 0 }, timeMs: 1000 };
  near(trail.freshnessOf(s, 1000), 1, 1e-9, "最新");
  near(trail.freshnessOf(s, 1700), 0.5, 1e-9, "半分");
  assert.equal(trail.freshnessOf(s, 3000), 0);
});

test("再生位置が巻き戻ったら残像を捨てる(シーク・巻き戻しに追従する)", () => {
  const trail = new CenterOfGravityTrail();
  const o = { x: 0, y: 0 };
  for (let ms = 100; ms <= 1000; ms += 50) trail.record(o, ms);
  assert.ok(trail.samples.length > 1);
  const afterRewind = trail.record(o, 200); // 巻き戻し
  assert.equal(afterRewind.length, 1);
});

test("再生位置が 0 以下(動画の先頭より前)では残像を作らない", () => {
  const trail = new CenterOfGravityTrail();
  assert.deepEqual(trail.record({ x: 0, y: 0 }, 0), []);
  assert.deepEqual(trail.record({ x: 0, y: 0 }, -100), []);
});
