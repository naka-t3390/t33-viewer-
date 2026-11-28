// e-4ORCE 真上俯瞰図。端末の `ui/e4orce/E4orceTopView.kt` の `drawTopView` を
// Canvas 2D へ移植したもの。幾何と色の意味は端末と同じにしてある。
//
//  - リングと目盛り
//  - 四輪の弧: 実測の車輪速から「舵角の幾何で決まるぶん」を引いた残り(スリップ)を、
//    その輪の位置から力の向きへ伸びる弧で描く。**内輪がオレンジ、外輪が薄い青**
//  - 真上から見た T33 の車体シルエット
//  - **重心ポイント(赤)と残像**: 旋回横G と前後G から荷重のかかる方向を出す
//
// 角度は端末(Compose)と同じ流儀で **3 時方向が 0 度・時計回り**、y は下向きが正。

/** 車両の寸法(端末の VehicleGeometry と同じ)。 */
export const WHEELBASE_M = 2.705;
export const TRACK_M = 1.590;
/** ステアリングギア比(ハンドル角 : 前輪切れ角)。2026-08-15 の実測。 */
export const STEERING_GEAR_RATIO = 17.3;

/** これ未満の速度では比が意味を持たない(ノイズが巨大なスリップに化ける)。 */
const MIN_MEANINGFUL_KMH = 1.0;
/** これ未満のハンドル角は直進として扱う。 */
const STRAIGHT_STEERING_DEG = 3.0;

/** 車輪の並び。 */
export const WHEEL_FL = 0;
export const WHEEL_FR = 1;
export const WHEEL_RL = 2;
export const WHEEL_RR = 3;

/** 塗りが振り切れるスリップ量(基準速度に対する割合)。3% で「はっきり効いている」。 */
export const SLIP_FULL_SCALE = 0.03;

/** これ未満は「効いていない」とみなして何も描かない。 */
export const ARC_NEUTRAL_THRESHOLD = 0.15;
const ARC_MIN_THICKNESS = 0.045;
const ARC_MAX_THICKNESS = 0.16;
/** 振り切れたときの弧の角度。90 度以上にすると隣の弧と繋がってしまう。 */
const ARC_MAX_DEG = 76;
/** 振り切れたときのタイヤの倍率。 */
const WHEEL_MAX_SCALE = 1.75;
/** リングの目盛りの本数。 */
const RING_TICKS = 60;
/** 車の全長がリングの直径に対して占める割合。 */
const CAR_TO_RING = 0.78;
/** 車体の半長(m)。全長 4690mm の半分。 */
export const CAR_HALF_LENGTH_M = 2.345;

/** 前後G の中心(未校正)。 */
export const ACCEL_G_CENTER = 31959;
/** 重心ポイントが最大振れ幅に達する横G(G)。 */
export const CG_FULL_LATERAL_G = 0.35;
/** 重心ポイントが最大振れ幅に達する前後G生値差(カウント)。 */
export const CG_FULL_LONGITUDINAL_COUNTS = 3500;
/** 重力加速度(m/s^2)。 */
const GRAVITY_MS2 = 9.80665;

/** 重心軌跡を残す時間(ミリ秒)。古い点ほど薄く・小さくなり、この時間で完全に消える。 */
export const CG_TRAIL_DURATION_MS = 1400;
/** 軌跡を記録する最小間隔(ミリ秒)。約 30Hz で滑らかに残す。 */
const CG_TRAIL_SAMPLE_INTERVAL_MS = 33;

const COLORS = {
  tick: "#9E9E9E",
  inner: "#FFB300", // 内輪(T33Colors.Amber)
  outer: "#7FD8FF", // 外輪(BAND_OUTER_BLUE)
  line: "#00E5FF", // 車体の線(T33Colors.Cyan)
  surface: "#1A1A1A",
  cg: "#FF3B30",
  muted: "#9E9E9E",
};

const rad = (deg) => (deg * Math.PI) / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** ハンドル角から旋回半径(m)を求める。直進なら null。 */
export function turnRadiusFor(steeringDegrees) {
  if (Math.abs(steeringDegrees) < STRAIGHT_STEERING_DEG) return null;
  const roadWheelDeg = steeringDegrees / STEERING_GEAR_RATIO;
  return WHEELBASE_M / Math.tan(rad(Math.abs(roadWheelDeg)));
}

/**
 * 車両中心の速度を 1 としたときの各輪の速度比。並びは FL/FR/RL/RR。
 *
 * 旋回中に外輪が内輪より速いこと、前輪が後輪より大きな半径を通ることは幾何で決まる。
 */
export function ackermannFactors(steeringDegrees) {
  const radius = turnRadiusFor(steeringDegrees);
  if (radius === null) return [1, 1, 1, 1];
  const half = TRACK_M / 2;
  const l = WHEELBASE_M;
  // 左へ切っていれば左が内側。
  const leftRadius = steeringDegrees > 0 ? radius - half : radius + half;
  const rightRadius = steeringDegrees > 0 ? radius + half : radius - half;
  return [
    Math.hypot(leftRadius, l) / radius,
    Math.hypot(rightRadius, l) / radius,
    leftRadius / radius,
    rightRadius / radius,
  ];
}

/** スリップ量を -1〜+1 の塗り具合に直す。正が駆動、負が引きずり。 */
export function slipFraction(slipKmh, referenceKmh) {
  if (!(referenceKmh > 0)) return 0;
  return clamp(slipKmh / referenceKmh / SLIP_FULL_SCALE, -1, 1);
}

/** リング上の四輪の位置(度)。車の前は真上(270 度)。 */
export function wheelRingAngleDeg(slot) {
  if (slot === WHEEL_FL) return 225;
  if (slot === WHEEL_FR) return 315;
  if (slot === WHEEL_RL) return 135;
  return 45;
}

/** リング上で「車の前方」がどちら回りかの符号。左右で逆になるのはリングが円だから。 */
export const ringForwardSign = (slot) => (slot === WHEEL_FL || slot === WHEEL_RL ? 1 : -1);

/** 力の大きさ(0〜1)を弧の長さ(度)に直す。効いていなければ 0。 */
export const wheelArcSpanDeg = (magnitude) =>
  magnitude < ARC_NEUTRAL_THRESHOLD ? 0 : ARC_MAX_DEG * Math.min(1, magnitude);

/** 力の大きさを弧の太さ(リング半径に対する割合)に直す。効いていなければ 0。 */
export const arcThicknessRatio = (magnitude) =>
  magnitude < ARC_NEUTRAL_THRESHOLD
    ? 0
    : ARC_MIN_THICKNESS + (ARC_MAX_THICKNESS - ARC_MIN_THICKNESS) * Math.min(1, magnitude);

/** 力の大きさ(0〜1)をタイヤの表示倍率に直す。強く回っている輪ほど大きく描く。 */
export const wheelSizeScale = (magnitude) => 1 + (WHEEL_MAX_SCALE - 1) * clamp(magnitude, 0, 1);

/**
 * 20Hz グリッドのサンプルから俯瞰図の状態を作る。
 *
 * 四輪と舵角が揃っていなければ null(「CAN データ待ち」を出す)。停車中は配分 0 の
 * 状態を返す(端末と同じ。0km/h では比が意味を持たず、ノイズが巨大なスリップに化ける)。
 *
 * 基準速度は車体速度の信号ではなく**四輪から逆算する**。車体速度のスケール誤差が
 * 結果に効かず、見たい「配分」だけが残る。
 */
export function e4orceStateOf(sample) {
  if (!sample || !sample.hasCan) return null;
  const steering = sample.steeringDeg;
  if (!Number.isFinite(steering)) return null;
  const w = sample.wheelKmh;
  if (!w || w.length < 4 || w.some((v) => !Number.isFinite(v))) return null;

  const radius = turnRadiusFor(steering);
  const accelGRaw = Number.isFinite(sample.accelGRaw) ? sample.accelGRaw : null;
  const roadWheelDegrees = steering / STEERING_GEAR_RATIO;

  if (Math.max(...w) < MIN_MEANINGFUL_KMH) {
    return {
      wheelSpeedsKmh: w,
      slipKmh: [0, 0, 0, 0],
      referenceKmh: 0,
      steeringDegrees: steering,
      roadWheelDegrees,
      turnRadiusM: radius,
      accelGRaw,
    };
  }

  const factors = ackermannFactors(steering);
  // 「どの輪も理論どおり」に最も近い中心速度。ここからのずれがスリップになる。
  const reference =
    (w[0] / factors[0] + w[1] / factors[1] + w[2] / factors[2] + w[3] / factors[3]) / 4;
  const slip = w.map((v, i) => v - factors[i] * reference);

  return {
    wheelSpeedsKmh: w,
    slipKmh: slip,
    referenceKmh: reference,
    steeringDegrees: steering,
    roadWheelDegrees,
    turnRadiusM: radius,
    accelGRaw,
  };
}

/**
 * 車両の重心(荷重移動)の正規化オフセット。
 *
 * - `x`: 右が正、左が負。左旋回(`steeringDegrees > 0`)では遠心力で右(+x)へ寄る
 * - `y`: 後ろ(画面下)が正、前(画面上)が負。加速で後ろ、減速・制動で前へ寄る
 * - 合成ベクトルの長さは最大 1.0(単位円内)に収める
 */
export function centerOfGravityOffset(state) {
  const radiusM = state.turnRadiusM;
  let rawX = 0;
  if (radiusM !== null && radiusM !== undefined && radiusM > 0 && state.referenceKmh >= 1.0) {
    const speedMs = state.referenceKmh / 3.6;
    const lateralG = (speedMs * speedMs) / (radiusM * GRAVITY_MS2);
    // 左旋回(steeringDegrees > 0)で遠心力は右(+x)向き
    const sign = state.steeringDegrees > 0 ? 1 : -1;
    rawX = (sign * lateralG) / CG_FULL_LATERAL_G;
  }
  const rawY =
    state.accelGRaw === null || state.accelGRaw === undefined
      ? 0
      : (state.accelGRaw - ACCEL_G_CENTER) / CG_FULL_LONGITUDINAL_COUNTS;

  const norm = Math.hypot(rawX, rawY);
  return norm > 1 ? { x: rawX / norm, y: rawY / norm } : { x: rawX, y: rawY };
}

/**
 * 重心の軌跡を時間付きで保持するバッファ。
 *
 * 端末は実時間で記録するが、ビューアは**再生位置の時刻**で記録する。そうすると
 * 早送り・巻き戻し・シークでも軌跡が正しく付いていく(時刻が巻き戻ったら捨てる)。
 */
export class CenterOfGravityTrail {
  constructor(durationMs = CG_TRAIL_DURATION_MS, sampleIntervalMs = CG_TRAIL_SAMPLE_INTERVAL_MS) {
    this.durationMs = durationMs;
    this.sampleIntervalMs = sampleIntervalMs;
    this.samples = [];
  }

  record(offset, nowMs) {
    if (nowMs <= 0) return [];
    const s = this.samples;
    if (s.length > 0 && nowMs < s[s.length - 1].timeMs) s.length = 0;
    const cutoff = nowMs - this.durationMs;
    let drop = 0;
    while (drop < s.length && s[drop].timeMs < cutoff) drop++;
    if (drop > 0) s.splice(0, drop);
    if (s.length === 0 || nowMs - s[s.length - 1].timeMs >= this.sampleIntervalMs) {
      s.push({ offset, timeMs: nowMs });
    }
    return s;
  }

  /** 残り寿命の割合(1.0 = 最新, 0.0 = 消滅)。 */
  freshnessOf(sample, nowMs) {
    return clamp(1 - (nowMs - sample.timeMs) / this.durationMs, 0, 1);
  }
}

// ---- 真上から見た T33 の車体(車体座標のメートル。x が右、z が前) ----

/** 車体の外郭。角張った幅広のノーズ、フェンダーの張り出し、ほぼ平らなテールゲート。 */
export const topBodyOutline = () => [
  [-0.66, -2.345], [-0.82, -2.29], [-0.88, -2.14],
  [-0.915, -1.85], [-0.92, -1.35], [-0.905, -0.92],
  [-0.88, -0.45], [-0.875, 0.15], [-0.885, 0.60],
  [-0.915, 0.95], [-0.92, 1.45], [-0.905, 1.75],
  [-0.86, 2.06], [-0.78, 2.26], [-0.62, 2.33], [-0.40, 2.345],
  [0.40, 2.345], [0.62, 2.33], [0.78, 2.26], [0.86, 2.06],
  [0.905, 1.75], [0.92, 1.45], [0.915, 0.95],
  [0.885, 0.60], [0.875, 0.15], [0.88, -0.45],
  [0.905, -0.92], [0.92, -1.35], [0.915, -1.85],
  [0.88, -2.14], [0.82, -2.29], [0.66, -2.345],
];
/** フロントガラス。カウルが広く、上端へ絞れる台形。 */
export const topWindshield = () => [[-0.70, 1.02], [0.70, 1.02], [0.585, 0.42], [-0.585, 0.42]];
/** リアガラス。テールゲート側が広い逆向きの台形。 */
export const topRearWindow = () => [[-0.60, -1.52], [0.60, -1.52], [0.665, -2.02], [-0.665, -2.02]];
/** ルーフレール。A ピラーの後ろから D ピラーまで。 */
export const topRoofRail = (side) => [[side * 0.56, 0.38], [side * 0.56, -1.48]];
/** ボンネットのプレスライン。カウル端からグリルへ収束する。 */
export const topHoodLine = (side) => [[side * 0.60, 1.06], [side * 0.27, 2.18]];
/** V-motion グリル。中央が後ろへ切れ込む山形。 */
export const topGrilleV = () => [[-0.36, 2.30], [0.0, 2.10], [0.36, 2.30]];
/** ヘッドライト。外側から内側へ切れ上がる細いスリット。 */
export const topHeadlight = (side) => [
  [side * 0.84, 2.04], [side * 0.40, 2.26], [side * 0.40, 2.21], [side * 0.82, 1.98],
];
/** ドアミラー。車体より外へ張り出す。 */
export const topMirror = (side) => [
  [side * 0.885, 0.78], [side * 1.055, 0.87], [side * 1.055, 0.72], [side * 0.885, 0.65],
];
/** 前モーター。前軸(z=1.3525)の上に載る。 */
export const topFrontMotor = () => [[-0.30, 1.55], [0.30, 1.55], [0.30, 1.15], [-0.30, 1.15]];
/** 後モーター。後軸(z=-1.3525)の上に載る。 */
export const topRearMotor = () => [[-0.26, -1.15], [0.26, -1.15], [0.26, -1.55], [-0.26, -1.55]];
/** 駆動用バッテリー。床下の中央。 */
export const topBattery = () => [[-0.34, 0.35], [0.34, 0.35], [0.34, -0.75], [-0.34, -0.75]];

const TRACK_HALF = 0.795;
const AXLE_Z = 1.3525;
const WHEEL_HALF_LENGTH_M = 0.36;
const WHEEL_HALF_WIDTH_M = 0.12;

/** その輪が旋回の内側かどうか。直進中はどれも内側ではない。 */
function innerWheelPredicate(state) {
  if (state.turnRadiusM === null || state.turnRadiusM === undefined) return () => false;
  const leftIsInner = state.steeringDegrees > 0;
  return (slot) => (slot === WHEEL_FL || slot === WHEEL_RL) === leftIsInner;
}

/** `#RRGGBB` にアルファを足して rgba 文字列にする。 */
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1).toFixed(3)})`;
}

function tracePath(ctx, points, project, close) {
  ctx.beginPath();
  points.forEach(([x, z], i) => {
    const p = project(x, z);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  if (close) ctx.closePath();
}

/** 目盛りのリング。 */
function drawRing(ctx, cx, cy, radius) {
  const inner = radius * 0.92;
  ctx.strokeStyle = alpha(COLORS.tick, 0.3);
  ctx.lineWidth = 3;
  for (let i = 0; i < RING_TICKS; i++) {
    const a = (2 * Math.PI * i) / RING_TICKS;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + inner * c, cy + inner * s);
    ctx.lineTo(cx + radius * c, cy + radius * s);
    ctx.stroke();
  }
}

/** 弧の先端に付ける矢じり。リングの接線方向を向く。 */
function drawArrowHead(ctx, cx, cy, radius, angleDeg, direction, thickness, color) {
  const a = rad(angleDeg);
  const tipX = cx + radius * Math.cos(a);
  const tipY = cy + radius * Math.sin(a);
  const tx = -Math.sin(a) * direction;
  const ty = Math.cos(a) * direction;
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const len = thickness * 1.2;
  const half = thickness * 0.85;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX + tx * len, tipY + ty * len);
  ctx.lineTo(tipX + nx * half, tipY + ny * half);
  ctx.lineTo(tipX - nx * half, tipY - ny * half);
  ctx.closePath();
  ctx.fill();
}

/** 各輪の働きぶりを、その輪の位置から力の向きへ伸びる弧で示す。 */
function drawWheelArcs(ctx, state, cx, cy, radius) {
  const arcRadius = radius * 0.96;
  const isInner = innerWheelPredicate(state);
  for (const slot of [WHEEL_FL, WHEEL_FR, WHEEL_RL, WHEEL_RR]) {
    const fraction = slipFraction(state.slipKmh[slot], state.referenceKmh);
    const magnitude = Math.abs(fraction);
    const span = wheelArcSpanDeg(magnitude);
    const thickness = radius * arcThicknessRatio(magnitude);
    if (span <= 0 || thickness <= 0) continue; // 効いていなければ何も描かない
    // 駆動なら前へ、引きずりなら後ろへ。
    const direction = ringForwardSign(slot) * (fraction >= 0 ? 1 : -1);
    const start = wheelRingAngleDeg(slot);
    const end = start + span * direction;
    const color = alpha(isInner(slot) ? COLORS.inner : COLORS.outer, 0.45 + 0.5 * magnitude);
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, rad(start), rad(end), direction < 0);
    ctx.stroke();
    drawArrowHead(ctx, cx, cy, arcRadius, end, direction, thickness, color);
  }
}

function drawTopWheels(ctx, state, cx, cy, pxPerM) {
  const steer = -state.roadWheelDegrees; // 画面の回転は時計回りが正
  const isInner = innerWheelPredicate(state);
  for (const slot of [WHEEL_FL, WHEEL_FR, WHEEL_RL, WHEEL_RR]) {
    const front = slot === WHEEL_FL || slot === WHEEL_FR;
    const onLeft = slot === WHEEL_FL || slot === WHEEL_RL;
    const centerX = cx + (onLeft ? -TRACK_HALF : TRACK_HALF) * pxPerM;
    const centerY = cy - (front ? AXLE_Z : -AXLE_Z) * pxPerM;
    const magnitude = Math.abs(slipFraction(state.slipKmh[slot], state.referenceKmh));
    const scale = wheelSizeScale(magnitude);
    const halfLen = WHEEL_HALF_LENGTH_M * pxPerM * scale;
    const halfWid = WHEEL_HALF_WIDTH_M * pxPerM * scale;
    ctx.save();
    ctx.translate(centerX, centerY);
    if (front) ctx.rotate(rad(steer));
    ctx.fillStyle = alpha(isInner(slot) ? COLORS.inner : COLORS.outer, 0.3 + 0.6 * magnitude);
    ctx.fillRect(-halfWid, -halfLen, halfWid * 2, halfLen * 2);
    ctx.restore();
  }
}

/** 真上から見た車体。前が上。 */
function drawTopCar(ctx, state, cx, cy, pxPerM) {
  const project = (x, z) => ({ x: cx + x * pxPerM, y: cy - z * pxPerM });
  const stroke = (points, width, a, close = false) => {
    tracePath(ctx, points, project, close);
    ctx.strokeStyle = alpha(COLORS.line, a);
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const fill = (points, a) => {
    tracePath(ctx, points, project, true);
    ctx.fillStyle = alpha(COLORS.line, a);
    ctx.fill();
  };

  // 車体。フェンダーの張り出しとドアの絞りが輪郭そのものに出る。
  tracePath(ctx, topBodyOutline(), project, true);
  ctx.fillStyle = alpha(COLORS.surface, 0.85);
  ctx.fill();
  ctx.strokeStyle = alpha(COLORS.line, 0.6);
  ctx.lineWidth = 2.5;
  ctx.stroke();

  for (const side of [-1, 1]) stroke(topHoodLine(side), 2, 0.3);
  stroke(topGrilleV(), 2.5, 0.5);
  for (const side of [-1, 1]) fill(topHeadlight(side), 0.65);
  stroke(topWindshield(), 2, 0.35, true);
  stroke(topRearWindow(), 2, 0.35, true);
  for (const side of [-1, 1]) stroke(topRoofRail(side), 3, 0.4);
  for (const side of [-1, 1]) fill(topMirror(side), 0.45);
  // 駆動系(前後モーターとバッテリー)。輪郭だけを薄く敷く。
  for (const part of [topFrontMotor(), topRearMotor(), topBattery()]) stroke(part, 1.5, 0.25, true);

  drawTopWheels(ctx, state, cx, cy, pxPerM);
}

/**
 * 車体中央の重心(荷重移動)ポイント。
 *
 * 前後G と旋回横G(v^2 / R)から荷重のかかる方向を求め、リング内側いっぱいに大きく動かす。
 * 移動の軌跡は古いほど薄い影として残り、時間経過で消える。
 */
function drawCenterOfGravity(ctx, state, cx, cy, ringRadius, tMs, cgTrail) {
  const maxTravel = ringRadius * 0.58;
  const offset = centerOfGravityOffset(state);
  const gx = cx + offset.x * maxTravel;
  const gy = cy + offset.y * maxTravel;
  const magnitude = clamp(Math.hypot(offset.x, offset.y), 0, 1);

  // 基準の十字線と可動範囲の薄いガイド円
  const guide = alpha(COLORS.muted, 0.22);
  const crossHalf = ringRadius * 0.18;
  ctx.strokeStyle = guide;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, maxTravel, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - crossHalf, cy);
  ctx.lineTo(cx + crossHalf, cy);
  ctx.moveTo(cx, cy - crossHalf);
  ctx.lineTo(cx, cy + crossHalf);
  ctx.stroke();

  const outerR = ringRadius * (0.14 + 0.05 * magnitude);
  const coreR = ringRadius * (0.085 + 0.025 * magnitude);

  // 影のような残像軌跡(古いものほど薄く小さく、時間経過で消える)
  if (cgTrail) {
    const trail = cgTrail.record(offset, tMs);
    let prev = null;
    for (const sample of trail) {
      const f = cgTrail.freshnessOf(sample, tMs);
      const pos = { x: cx + sample.offset.x * maxTravel, y: cy + sample.offset.y * maxTravel };
      if (f > 0.01) {
        const fade = f * f;
        if (prev) {
          ctx.strokeStyle = alpha(COLORS.cg, fade * 0.26);
          ctx.lineWidth = coreR * (0.5 + 0.9 * f);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(pos.x, pos.y);
          ctx.stroke();
        }
        ctx.fillStyle = alpha(COLORS.cg, fade * 0.3);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, coreR * (0.35 + 0.5 * f), 0, Math.PI * 2);
        ctx.fill();
      }
      prev = pos;
    }
    ctx.lineCap = "butt";
  }

  // 本体(外の淡い輪 + 芯)
  ctx.fillStyle = alpha(COLORS.cg, 0.18 + 0.2 * magnitude);
  ctx.beginPath();
  ctx.arc(gx, gy, outerR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = alpha(COLORS.cg, 0.85);
  ctx.beginPath();
  ctx.arc(gx, gy, coreR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = alpha("#FFFFFF", 0.65);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(gx, gy, coreR, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * 俯瞰図を 1 枚描く。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width  描画領域の幅(px)
 * @param {number} height 描画領域の高さ(px)
 * @param {object|null} state `e4orceStateOf` の戻り値。null なら何も描かない
 * @param {number} tMs 再生位置(ミリ秒)。残像の時計に使う
 * @param {CenterOfGravityTrail|null} cgTrail
 */
export function drawTopView(ctx, width, height, state, tMs, cgTrail) {
  ctx.clearRect(0, 0, width, height);
  if (!state) return;
  const cx = width / 2;
  const cy = height / 2;
  const ringRadius = Math.min(width, height) * 0.4;
  const pxPerM = (ringRadius * CAR_TO_RING) / CAR_HALF_LENGTH_M;
  drawRing(ctx, cx, cy, ringRadius);
  drawWheelArcs(ctx, state, cx, cy, ringRadius);
  drawTopCar(ctx, state, cx, cy, pxPerM);
  drawCenterOfGravity(ctx, state, cx, cy, ringRadius, tMs, cgTrail);
}
