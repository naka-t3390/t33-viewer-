// CAN の車速とヨーレートで走行経路を組み立て、GPS は「出発位置」と「補正点」にだけ使う。
//
// 背景(2026-11-23): GPS の記録はセッションによって壊れる。測位を失って最後の位置を
// 返し続け、復帰した瞬間に数百 m 飛ぶ。11/21 の 13:45 は 4 分 7 秒の動画に GPS が
// 6 点しか無く、13:36 は動いた点が 29 個だけで最大 1,500km/h 相当の飛びがあった。
// 一方シャシ系の CAN は同じ走行で 1,727fps 完全に取れていた。
//
// 方針:
//   1. CAN だけで相対経路を作る(出発点を原点・北向き 0° として 10Hz で積分)
//   2. GPS の各点が信じられるかを CAN の移動距離と突き合わせて選ぶ
//      (飛び=動けるはずの距離より遠い / 固着=走っているのに動かない)
//   3. 信じられる点を 30 秒ごとの「アンカー」にし、区間ごとに相対経路を回転・拡縮して
//      両端のアンカーに合わせる(方位のずれ・車速の係数誤差を吸収する)
//   4. アンカーの外側と、アンカーの間が 90 秒を超える区間は「推定(est)」と印す
//
// 元の GPS(KML)は変更しない。ここは描画直前に通す純関数である。
//
// ヨーレートの係数は左右後輪の速度差から幾何的に求めた値との回帰(r=+0.975、
// 35,504 サンプル)で決めた。1 deg/s = 343.1 カウント。生値が大きいほど**左旋回**。

export const YAW_CENTER = 32000;
export const YAW_DEG_PER_COUNT = 0.002914;

const STEP_S = 0.1;            // 積分の刻み(10Hz)
const STOP_KMH = 0.5;          // これ未満は停車(位置も方位も動かさない)
const MOVING_KMH = 3;          // アンカーに使う GPS 点は、この速度以上で走っているときだけ
const ANCHOR_SPACING_S = 30;   // アンカーの最小間隔
const MAX_ANCHOR_GAP_S = 90;   // これを超えて GPS が無い区間は推定扱い
const MIN_FIT_M = 40;          // 回転・拡縮を決めるのに要る最小の移動距離
const MIN_CHORD_M = 10;        // 向きだけ決めるのに要る最小の移動距離
const SCALE_MIN = 0.9;
const SCALE_MAX = 1.12;
const HOLD_BINS = 10;          // CAN の欠けは最大 1 秒だけ直前値を保持する
const LAG_RANGE_S = 15;        // GPS と端末の時計のずれを探す範囲(±)
const LAG_MIN_PAIRS = 30;      // 速度を比べられる GPS の組がこれ未満なら推定しない
const LAG_MIN_MOVING_PAIRS = 30;    // うち走っている(5km/h 超)組がこれ未満なら、手がかりが無い
const LAG_MOVING_KMH = 5;
const LAG_MIN_MISMATCH_KMH = 0.5;   // ずれ 0 でも速度の食い違いがこれ以下なら、ずれは無いとみなす
const LAG_MIN_IMPROVEMENT = 0.25;   // 食い違いがこれだけ減らなければ、手がかりが弱いので採らない

const M_PER_DEG = (6371000 * Math.PI) / 180; // geo.js の haversine(R=6371000)と同じ尺度
const toRad = (d) => (d * Math.PI) / 180;

// ---- 1. CAN だけで相対経路を作る ----

/**
 * 車速とヨーレートから、出発点を原点・北向きを 0° とした相対経路を 10Hz で作る。
 * @param {{speed: Array<{t:number,kmh:number}>, yaw: Array<{t:number,raw:number}>}} signals
 * @returns {null | {t0:number, stepS:number, n:number, x:Float64Array, y:Float64Array, cum:Float64Array, kmh:Float64Array, zero:number}}
 */
export function buildMotion(signals, stepS = STEP_S) {
  const sp = signals && signals.speed;
  const yw = signals && signals.yaw;
  if (!sp || !yw || sp.length === 0 || yw.length === 0) return null;
  const t0 = Math.max(sp[0].t, yw[0].t);
  const t1 = Math.min(sp[sp.length - 1].t, yw[yw.length - 1].t);
  if (!(t1 - t0 >= 1)) return null;
  const n = Math.floor((t1 - t0) / stepS);

  // 刻みごとに平均する(車速 約 49Hz・ヨーレート 約 98Hz → 10Hz)
  const bins = (series, key) => {
    const sum = new Float64Array(n + 1);
    const cnt = new Uint16Array(n + 1);
    for (const p of series) {
      const i = Math.round((p.t - t0) / stepS);
      if (i < 0 || i > n) continue;
      sum[i] += p[key];
      cnt[i]++;
    }
    const out = new Float64Array(n + 1).fill(NaN);
    let held = 0, last = NaN;
    for (let i = 0; i <= n; i++) {
      if (cnt[i] > 0) { out[i] = sum[i] / cnt[i]; last = out[i]; held = 0; }
      else if (held < HOLD_BINS) { out[i] = last; held++; } // 短い欠けは直前値
    }
    return out;
  };
  const kmh = bins(sp, "kmh");
  const raw = bins(yw, "raw");

  // ヨーレートのゼロ点は「停車中の生値の中央値」。個体や温度でずれるため毎回求める。
  const still = [];
  for (let i = 0; i <= n; i++) if (kmh[i] < STOP_KMH && !Number.isNaN(raw[i])) still.push(raw[i]);
  let zero = YAW_CENTER;
  if (still.length >= 50) { still.sort((a, b) => a - b); zero = still[still.length >> 1]; }

  const x = new Float64Array(n + 1), y = new Float64Array(n + 1), cum = new Float64Array(n + 1);
  let px = 0, py = 0, pc = 0, psi = 0; // psi: 北 0°・東回り(ラジアン)
  for (let i = 0; i <= n; i++) {
    const v = kmh[i];
    if (!Number.isNaN(v) && v >= STOP_KMH) {
      if (!Number.isNaN(raw[i])) {
        // 生値が大きい = 左旋回 = 方位は減る
        psi -= toRad((raw[i] - zero) * YAW_DEG_PER_COUNT) * stepS;
      }
      const d = (v / 3.6) * stepS;
      px += d * Math.sin(psi);
      py += d * Math.cos(psi);
      pc += d;
    }
    x[i] = px; y[i] = py; cum[i] = pc;
  }
  return { t0, stepS, n, x, y, cum, kmh, zero };
}

/** 時刻 t(秒)の相対位置と累積距離。範囲外は端に丸める。 */
export function motionAt(m, t) {
  const f = Math.min(m.n, Math.max(0, (t - m.t0) / m.stepS));
  const i = Math.min(m.n - 1, Math.floor(f));
  const a = f - i;
  if (m.n < 1) return { x: m.x[0], y: m.y[0], cum: m.cum[0] };
  return {
    x: m.x[i] + (m.x[i + 1] - m.x[i]) * a,
    y: m.y[i] + (m.y[i + 1] - m.y[i]) * a,
    cum: m.cum[i] + (m.cum[i + 1] - m.cum[i]) * a,
  };
}

function speedAt(m, t) {
  const i = Math.round((t - m.t0) / m.stepS);
  if (i < 0 || i > m.n) return NaN;
  return m.kmh[i];
}

// ---- 時刻ずれ: GPS の時計と端末の時計 ----

/**
 * GPS の時刻と端末の時計(CAN・動画)のずれ[秒]を、速度の突き合わせで推定する。
 *
 * GPS の時刻は衛星由来で正確だが、端末の時計は SIM なしだと補正が効かず数秒ずれる。
 * 2026-11-21 11:22 のセッションでは約 6 秒あり、時速 40km で 66m の食い違いになった。
 * 位置を突き合わせる前に直さないと、補正した経路が道に載らない。
 *
 * GPS の隣り合う 2 点から出した速度と、CAN の車速を、時刻をずらしながら比べる。
 * 食い違いが**はっきり減る**ときだけ採用し、手がかりが弱いとき(一定速度の走行など)は 0 を返す。
 * 返す lagS は「端末の時刻 = GPS の時刻 + lagS」。
 *
 * @returns {{lagS:number, estimated:boolean, improvement:number}}
 */
export function estimateGpsLag(gps, motion) {
  const none = { lagS: 0, estimated: false, improvement: 0 };
  if (!Array.isArray(gps) || !motion) return none;
  const pairs = [];
  const cosLat = Math.cos(toRad(gps.length ? gps[0].lat : 0));
  for (let i = 1; i < gps.length; i++) {
    const dt = gps[i].t - gps[i - 1].t;
    if (dt < 0.5 || dt > 2.5) continue;
    const d = Math.hypot((gps[i].lon - gps[i - 1].lon) * M_PER_DEG * cosLat, (gps[i].lat - gps[i - 1].lat) * M_PER_DEG);
    const v = (d / dt) * 3.6;
    if (v > 150) continue; // 飛び
    pairs.push({ t: (gps[i].t + gps[i - 1].t) / 2, v });
  }
  if (pairs.length < LAG_MIN_PAIRS) return none;
  // 走っている GPS の組が少ないと、止まっている者どうしの食い違いが減るだけの偽の谷ができる
  // (GPS が固着していた 2026-11-21 13:36 では -12.9 秒と誤推定した)。
  if (pairs.filter((q) => q.v > LAG_MOVING_KMH).length < LAG_MIN_MOVING_PAIRS) return none;

  // 食い違いの平均(大きい側 20% は GPS の外れとして捨てる)
  const cost = (tau) => {
    const diffs = [];
    for (const p of pairs) {
      const c = speedAt(motion, p.t + tau);
      if (!Number.isNaN(c)) diffs.push(Math.abs(p.v - c));
    }
    if (diffs.length < LAG_MIN_PAIRS) return Infinity;
    diffs.sort((a, b) => a - b);
    const keep = Math.ceil(diffs.length * 0.8);
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += diffs[i];
    return sum / keep;
  };
  // 同点なら 0 に近いほうを採る(平らな谷でも、でたらめな端を選ばない)
  const search = (lo, hi, step) => {
    let best = { tau: 0, c: Infinity };
    for (let tau = lo; tau <= hi + 1e-9; tau += step) {
      const c = cost(tau);
      if (c + 1e-6 * Math.abs(tau) < best.c + 1e-6 * Math.abs(best.tau)) best = { tau, c };
    }
    return best;
  };
  const c0 = cost(0);
  if (!(c0 > LAG_MIN_MISMATCH_KMH)) return none;
  const coarse = search(-LAG_RANGE_S, LAG_RANGE_S, 0.5);
  // 最小の近くを 0.1 秒刻みで見直す。谷の底が平ら(階段状の速度変化など)なときは、
  // 最小と同等の範囲の**中央**を採る。端を採ると、その分だけずれる。
  const taus = [], costs = [];
  for (let tau = coarse.tau - 1.5; tau <= coarse.tau + 1.5 + 1e-9; tau += 0.1) {
    taus.push(tau);
    costs.push(cost(tau));
  }
  let bi = 0;
  for (let i = 1; i < costs.length; i++) if (costs[i] < costs[bi]) bi = i;
  const tol = costs[bi] + 0.02; // km/h
  let lo = bi, hi = bi;
  while (lo > 0 && costs[lo - 1] <= tol) lo--;
  while (hi < costs.length - 1 && costs[hi + 1] <= tol) hi++;
  const improvement = 1 - costs[bi] / c0;
  if (!(improvement >= LAG_MIN_IMPROVEMENT)) return { lagS: 0, estimated: false, improvement };
  return { lagS: Math.round(((taus[lo] + taus[hi]) / 2) * 10) / 10, estimated: true, improvement };
}

// ---- 2〜4. GPS で補正する ----

/** GPS を最初の点を原点とした東・北(m)へ。 */
function projectGps(gps) {
  const ref = { lat: gps[0].lat, lon: gps[0].lon };
  const cosLat = Math.cos(toRad(ref.lat));
  const enu = gps.map((g) => ({
    e: (g.lon - ref.lon) * M_PER_DEG * cosLat,
    n: (g.lat - ref.lat) * M_PER_DEG,
  }));
  return { ref, cosLat, enu };
}

/**
 * 信じてよい GPS 点の添字。CAN の移動距離と矛盾しない点だけを選ぶ。
 *
 * 信じる点 = 走行中で、**次の点への動き**が CAN と合う点。
 * 「次へ」で見るのは、飛びから復帰した最初の点(前へは飛んでいるが、以後は正しい)を
 * 拾い、固着の最後の点や孤立した飛び点を捨てるため。最終点だけは前の点との関係で見る。
 */
export function trustedFixIndices(gps, motion, enu = projectGps(gps).enu) {
  const tEnd = motion.t0 + motion.n * motion.stepS;
  const inCoverage = (t) => t >= motion.t0 && t <= tEnd;
  // 隣り合う 2 点の動きが、CAN の移動距離と矛盾しないか。
  function pairOk(i, j) {
    const dt = gps[j].t - gps[i].t;
    if (dt <= 0 || !inCoverage(gps[i].t) || !inCoverage(gps[j].t)) return false;
    const g = Math.hypot(enu[j].e - enu[i].e, enu[j].n - enu[i].n);
    const c = motionAt(motion, gps[j].t).cum - motionAt(motion, gps[i].t).cum;
    if (g > c * 1.15 + 12) return false;                       // 飛び: 走った距離より遠い
    if (dt <= 3 && c >= 6 && g < 0.25 * c) return false;      // 固着: 走っているのに動かない
    return true;
  }
  const trusted = [];
  for (let i = 0; i < gps.length; i++) {
    if (!inCoverage(gps[i].t)) continue;
    if (!(speedAt(motion, gps[i].t) >= MOVING_KMH)) continue;
    const ok = i + 1 < gps.length ? pairOk(i, i + 1) : i > 0 && pairOk(i - 1, i);
    if (ok) trusted.push(i);
  }
  return trusted;
}


/**
 * @param {Array<{t:number,lat:number,lon:number}>} gps parseKmlTrack の出力(t は記録開始からの秒)
 * @param {{speed:Array, yaw:Array}} signals createCanSignalParser().finish() の出力(同じ t の基準)
 * @returns {null | {points: Array<{t:number,lat:number,lon:number,est:boolean}>, stats: object}}
 *   補正できないとき(GPS が使えない・CAN が無い)は null。呼び出し側は生の軌跡のまま使う。
 */
export function correctTrack(gpsInput, signals) {
  if (!Array.isArray(gpsInput) || gpsInput.length < 2) return null;
  const motion = buildMotion(signals);
  if (!motion) return null;
  // GPS の時刻を端末の時計へ合わせてから、以降の突き合わせをする。
  const lag = estimateGpsLag(gpsInput, motion);
  const gps = lag.lagS === 0 ? gpsInput : gpsInput.map((g) => ({ ...g, t: g.t + lag.lagS }));
  const tEnd = motion.t0 + motion.n * motion.stepS;

  const { ref, cosLat, enu } = projectGps(gps);
  const trusted = trustedFixIndices(gps, motion, enu);
  if (trusted.length < 2) return null;

  // アンカー: 信じる点から 30 秒以上あけて選ぶ。最後の信じる点が離れていれば足す。
  let anchors = [];
  for (const i of trusted) {
    if (anchors.length === 0 || gps[i].t - gps[anchors[anchors.length - 1]].t >= ANCHOR_SPACING_S) anchors.push(i);
  }
  const lastTrusted = trusted[trusted.length - 1];
  if (anchors[anchors.length - 1] !== lastTrusted && gps[lastTrusted].t - gps[anchors[anchors.length - 1]].t >= 10) {
    anchors.push(lastTrusted);
  }
  // 短い GPS(数秒〜数十秒しか無い)は、いちばん離れた 2 点で向きだけ決める。
  if (anchors.length < 2) {
    let best = null;
    for (let a = 0; a < trusted.length; a++) {
      for (let b = a + 1; b < trusted.length; b++) {
        const g = Math.hypot(enu[trusted[b]].e - enu[trusted[a]].e, enu[trusted[b]].n - enu[trusted[a]].n);
        if (!best || g > best.g) best = { a: trusted[a], b: trusted[b], g };
      }
    }
    if (!best || best.g < MIN_CHORD_M) return null;
    anchors = [best.a, best.b];
  }

  // 区間ごとの回転 θ と拡縮 s(相対経路 → 実座標)
  const segs = [];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const ia = anchors[k], ib = anchors[k + 1];
    const pa = motionAt(motion, gps[ia].t), pb = motionAt(motion, gps[ib].t);
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const ge = enu[ib].e - enu[ia].e, gn = enu[ib].n - enu[ia].n;
    const dl = Math.hypot(dx, dy), gl = Math.hypot(ge, gn);
    let theta = null, s = 1;
    if (dl >= MIN_CHORD_M && gl >= MIN_CHORD_M) {
      theta = Math.atan2(gn, ge) - Math.atan2(dy, dx);
      if (dl >= MIN_FIT_M && gl >= MIN_FIT_M) s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, gl / dl));
    }
    segs.push({ ia, ib, ta: gps[ia].t, tb: gps[ib].t, theta, s });
  }
  // 向きが決まらない区間(ほぼ動いていない)は、近い区間の向きを引き継ぐ。
  for (let k = 0; k < segs.length; k++) {
    if (segs[k].theta !== null) continue;
    let from = null;
    for (let d = 1; d < segs.length && from === null; d++) {
      if (k - d >= 0 && segs[k - d].theta !== null) from = segs[k - d].theta;
      else if (k + d < segs.length && segs[k + d].theta !== null) from = segs[k + d].theta;
    }
    segs[k].theta = from;
  }
  if (segs.some((sg) => sg.theta === null)) return null;

  const rot = (v, th) => ({ x: v.x * Math.cos(th) - v.y * Math.sin(th), y: v.x * Math.sin(th) + v.y * Math.cos(th) });

  function placeIn(sg, t) {
    const pa = motionAt(motion, sg.ta), pb = motionAt(motion, sg.tb), p = motionAt(motion, t);
    const A = enu[sg.ia], B = enu[sg.ib];
    const q = rot({ x: p.x - pa.x, y: p.y - pa.y }, sg.theta);
    const qb = rot({ x: pb.x - pa.x, y: pb.y - pa.y }, sg.theta);
    // 回転・拡縮で合わせきれなかった残りは、走った距離に比例して配る(アンカーでぴったり重なる)
    const span = pb.cum - pa.cum;
    const u = span > 1e-6 ? (p.cum - pa.cum) / span : (t - sg.ta) / (sg.tb - sg.ta);
    const rx = B.e - (A.e + sg.s * qb.x), ry = B.n - (A.n + sg.s * qb.y);
    return { e: A.e + sg.s * q.x + u * rx, n: A.n + sg.s * q.y + u * ry };
  }
  function extend(sg, anchorIdx, t) {
    const pa = motionAt(motion, gps[anchorIdx].t), p = motionAt(motion, t);
    const q = rot({ x: p.x - pa.x, y: p.y - pa.y }, sg.theta);
    return { e: enu[anchorIdx].e + q.x, n: enu[anchorIdx].n + q.y };
  }

  const firstT = gps[anchors[0]].t;
  const lastT = gps[anchors[anchors.length - 1]].t;
  const points = [];
  let k = 0;
  for (let t = Math.ceil(motion.t0); t <= Math.floor(tEnd); t++) {
    let pos, est;
    if (t < firstT) {
      pos = extend(segs[0], anchors[0], t); est = true;
    } else if (t > lastT) {
      pos = extend(segs[segs.length - 1], anchors[anchors.length - 1], t); est = true;
    } else {
      while (k < segs.length - 1 && t > segs[k].tb) k++;
      pos = placeIn(segs[k], t);
      est = segs[k].tb - segs[k].ta > MAX_ANCHOR_GAP_S;
    }
    points.push({
      t,
      lat: ref.lat + pos.n / M_PER_DEG,
      lon: ref.lon + pos.e / (M_PER_DEG * cosLat),
      est,
    });
  }
  if (points.length < 2) return null;
  return {
    points,
    stats: {
      anchors: anchors.length,
      anchorTimes: anchors.map((i) => gps[i].t),
      fixes: gps.length,
      trustedFixes: trusted.length,
      estimatedSec: points.filter((p) => p.est).length,
      yawZero: motion.zero,
      gpsLagS: lag.lagS,
      gpsLagEstimated: lag.estimated,
    },
  };
}

// ---- 描画用 ----

/**
 * 軌跡を GeoJSON の LineString 群にする。推定(est)の連なりごとに線を分け、
 * 境界の点を共有してつなぐ。est を持たない軌跡(生の GPS)は 1 本の実線になる。
 * 地図側は est の true/false で破線/実線を描き分ける。
 */
export function trackToFeatures(points) {
  const runs = [];
  let run = null;
  for (const p of points || []) {
    const est = p.est === true;
    if (!run || run.est !== est) {
      const prev = run;
      run = { est, coords: [] };
      if (prev && prev.coords.length) run.coords.push(prev.coords[prev.coords.length - 1]);
      runs.push(run);
    }
    run.coords.push([p.lon, p.lat]);
  }
  return runs
    .filter((r) => r.coords.length >= 2)
    .map((r) => ({ type: "Feature", properties: { est: r.est }, geometry: { type: "LineString", coordinates: r.coords } }));
}
