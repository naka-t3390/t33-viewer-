// 端末(KYV46)の縦型記録画面を再現するための、CAN 値のデコードと表示モデル。
//
// **読み方の出どころは T33Monitor の `data/can/CanSignalSpec.kt` ただ一つ**で、
// 係数・符号・ビット幅はそれと 1 対 1 に対応させてある。ここで独自解釈を入れると
// 端末の画面とビューアの画面が食い違い、どちらが正しいのか分からなくなる。
// 係数を変えるときは必ず Kotlin 側を先に直し、根拠(いつ・どの走行で・何と相関したか)を
// そちらの KDoc に書いてから、ここへ写すこと。
//
// 表示モデル(`cockpitModelOf`)は端末の `ui/cockpit/CockpitModel.kt` の
// `cockpitModelOf` と同じ約束を持つ: **裏付けのない値は数字らしく見せない**。
// 取れていない値は 0 か `---` を `verified:false` で返し、描画側がグレーで描く。

// ---- 係数(CanSignalSpec.kt と 1 対 1) ----

/** トルク 1 カウントあたりの Nm。上位 12bit 符号付き。= 1/8 Nm。 */
export const TORQUE_NM_PER_COUNT_12BIT = 0.125;
/** モータ回転 1 カウントあたりの rpm。符号付き 16bit。前進が正、後退が負。 */
export const MOTOR_RPM_PER_COUNT = 0.5;
/** 電池電圧 1 カウントあたりの V。上位 10bit。 */
export const BATTERY_VOLTAGE_V_PER_COUNT = 0.5;
/** 電池電流 1 カウントあたりの A。上位 11bit 符号付き。**負が放電、正が回生**。 */
export const BATTERY_CURRENT_A_PER_COUNT = 0.5;
/** SOC 1 カウントあたりの %。上位 10bit。 */
export const BATTERY_SOC_PERCENT_PER_COUNT = 0.1;
/** EV バス `191` の発電エンジン回転。既存バス `075` との相関 +0.99988。 */
export const EV_ENGINE_RPM_COUNTS_PER_RPM = 5.1207;
/** EV バス `29A` の車体速度。既存バスの車速との相関 +0.99995。 */
export const EV_VEHICLE_SPEED_COUNTS_PER_KMH = 102.086;
/** 車輪速。車体速度とは別スケール。 */
export const WHEEL_SPEED_COUNTS_PER_KMH = 180.2;
/** 舵角の中立値。手を離した状態でこの値になる。 */
export const STEERING_CENTER = 32768;
/** 舵角 1 カウントあたりのハンドル角(度)。**左が正、右が負**。 */
export const STEERING_DEGREES_PER_COUNT = 0.0434;
/** 前後G の中心(0x8000 とはズレがある、未校正)。 */
export const ACCEL_G_CENTER = 31959;
export const COOLANT_TEMP_OFFSET_C = 40;
export const OIL_TEMP_OFFSET_C = 30;
export const INTAKE_TEMP_OFFSET_C = 50;
/** エンジン負荷の 0% に当たる生値とスケール(`41A` b3-4)。 */
export const ENGINE_LOAD_ZERO_RAW = 31;
export const ENGINE_LOAD_PCT_PER_COUNT = 0.0122;
/** モーター出力 kW = トルク[Nm] × |回転[rpm]| ÷ この定数。 */
export const KW_PER_NM_RPM = 9549;

/**
 * 12bit 符号付きの上限に近いと見なす Nm。
 *
 * 12bit 符号付きの上限は ±2047 カウント = ±255.9 Nm で、公称のフロントモーター
 * トルク(330Nm 級)に足りない矛盾が未解決。ここに達したら飽和の疑いを画面に出す
 * (係数には手を入れない)。
 */
export const TORQUE_SATURATION_NM = 250;

// ---- ビット取り出し(CanSignalSpec.kt の readS16 / readS12High / readS11High / readU10High) ----

/** 符号付き 16bit へ直す。 */
export function toS16(u16) {
  return u16 >= 0x8000 ? u16 - 0x10000 : u16;
}

/** 上位 12bit を符号付きで読む。下位 4bit はほぼ常に 0。 */
export function toS12High(u16) {
  const raw = u16 >> 4;
  return raw >= 0x800 ? raw - 0x1000 : raw;
}

/** 上位 11bit を符号付きで読む(電流。バイト境界と揃っていない)。 */
export function toS11High(u16) {
  const raw = u16 >> 5;
  return raw >= 0x400 ? raw - 0x800 : raw;
}

/** 上位 10bit を読む(電圧・SOC。バイト境界と揃っていない)。 */
export function toU10High(u16) {
  return u16 >> 6;
}

// ---- 信号ごとのデコード。引数は該当バイトを 16bit/8bit で読んだ生値 ----

/** 前後モータートルク(Nm)。`1D4`/`1BC` の b2-3。駆動が正、回生が負。 */
export const motorTorqueNm = (u16) => toS12High(u16) * TORQUE_NM_PER_COUNT_12BIT;
/** モータ回転(rpm)。`1DA`/`1CE` の b4-5。前進が正、**後退が負**。 */
export const motorRpm = (u16) => toS16(u16) * MOTOR_RPM_PER_COUNT;
/** 電池電圧(V)。`1DB` の b2-3。 */
export const batteryVoltageV = (u16) => toU10High(u16) * BATTERY_VOLTAGE_V_PER_COUNT;
/** 電池電流(A)。`1DB` の b0-1。**負が放電、正が回生**。 */
export const batteryCurrentA = (u16) => toS11High(u16) * BATTERY_CURRENT_A_PER_COUNT;
/** SOC(%)。`55B` の b0-1。 */
export const batterySocPercent = (u16) => toU10High(u16) * BATTERY_SOC_PERCENT_PER_COUNT;
/** 発電エンジン回転(rpm)。`191` の b5-6。 */
export const engineRpmOf = (u16) => u16 / EV_ENGINE_RPM_COUNTS_PER_RPM;
/** 車体速度(km/h)。`29A` の b4-5。 */
export const vehicleSpeedKmh = (u16) => u16 / EV_VEHICLE_SPEED_COUNTS_PER_KMH;
/** 車輪速(km/h)。`289`/`28A`。 */
export const wheelSpeedKmh = (u16) => u16 / WHEEL_SPEED_COUNTS_PER_KMH;
/** ハンドル角(度)。`141` の b2-3。**左が正、右が負**。 */
export const steeringDegrees = (u16) => (u16 - STEERING_CENTER) * STEERING_DEGREES_PER_COUNT;
/** 冷却水温(℃)。`50F` の b1。 */
export const coolantTempC = (u8) => u8 - COOLANT_TEMP_OFFSET_C;
/** エンジン油温(℃)。`4B0` の b0。 */
export const oilTempC = (u8) => u8 - OIL_TEMP_OFFSET_C;
/** 吸気温(℃)。`50F` の b5。 */
export const intakeTempC = (u8) => u8 - INTAKE_TEMP_OFFSET_C;

/** エンジン負荷(%)。`41A` の b3-4。0〜100 でクランプする(端末と同じ)。 */
export function engineLoadPercent(u16) {
  const pct = (u16 - ENGINE_LOAD_ZERO_RAW) * ENGINE_LOAD_PCT_PER_COUNT;
  return Math.min(100, Math.max(0, pct));
}

/** シフト位置の名前。`1D4` b5 の bit1-2 の値がそのまま添字になる。 */
export const SHIFT_NAMES = ["N", "R", "D", "P"];

/** シフト位置の添字(0=N / 1=R / 2=D / 3=P)。`1D4` の b5。 */
export const shiftIndexOf = (b5) => (b5 >> 1) & 0x03;
/** READY(走行可能)。`1D4` の b5 の bit6。 */
export const readyOf = (b5) => ((b5 >> 6) & 0x01) === 1;
/** e-Pedal Step の ON/OFF 候補。`47A` の b1 の bit3。実車スイッチでの最終確認は未了。 */
export const ePedalActiveOf = (b1) => (b1 & 0x08) !== 0;

// ---- 表示モデル(端末の CockpitModel.kt と同じ約束) ----

/** 画面に出す 1 つの値。`verified` が false の値はグレーで描く。 */
const value = (text, verified) => ({ text, verified });

const NOT_AVAILABLE = "---";

/** NaN(未取得)を 0 として扱う。端末では取れない値が 0.0 で入ってくるのに合わせる。 */
const or0 = (v) => (Number.isFinite(v) ? v : 0);

/** 整数へ丸めて 3 桁区切りで書く。 */
const int = (v) => Math.round(v).toLocaleString("en-US");

/** 符号付きで小数 1 桁。 */
const signed1 = (v) => (v >= 0 ? "+" : "") + v.toFixed(1);

/**
 * 20Hz グリッドの 1 サンプル(`sampleCockpitAt` の戻り値)から、画面に出す値一式を作る。
 *
 * `sample` が null(CAN ログの範囲外・CAN を読めなかった)ときは、全部を
 * `verified:false` の 0 か `---` にする。もっともらしい値を置かない。
 */
export function cockpitModelOf(sample) {
  const has = sample != null && sample.hasCan === true;
  const s = sample || {};

  const ftq = or0(s.frontTorqueNm);
  const rtq = or0(s.rearTorqueNm);
  const frpm = or0(s.frontRpm);
  const rrpm = or0(s.rearRpm);

  // 端末と同じ判定: トルクと回転がどちらも 0 の間は「取れていない」とみなす。
  const hasFront = has && (ftq !== 0 || frpm !== 0);
  const hasRear = has && (rtq !== 0 || rrpm !== 0);

  const frontKw = (ftq * Math.abs(frpm)) / KW_PER_NM_RPM;
  const rearKw = (rtq * Math.abs(rrpm)) / KW_PER_NM_RPM;

  // 前後配分は |トルク| の比。**両方 0 のときは 0:0**(データが無いだけなのに
  // 「50:50 で配分されている」と見せないため。E4orceBalance.fromTorques と同じ)。
  const total = Math.abs(ftq) + Math.abs(rtq);
  const frontPct = total > 0 ? Math.trunc((Math.abs(ftq) / total) * 100) : 0;
  const rearPct = total > 0 ? Math.trunc((Math.abs(rtq) / total) * 100) : 0;

  const hasSpeed = has && Number.isFinite(s.speedKmh);
  const speedKmh = hasSpeed ? Math.max(0, s.speedKmh) : 0;
  const hasSoc = has && Number.isFinite(s.socPct) && s.socPct > 0;
  const volt = s.batteryV;
  const amp = s.batteryA;
  const hasVolt = has && Number.isFinite(volt);
  const hasAmp = has && Number.isFinite(amp);
  const powerKw = hasVolt && hasAmp ? (volt * amp) / 1000 : NaN;

  const tempValue = (v, unit) =>
    has && Number.isFinite(v) ? value(`${Math.round(v)}${unit}`, true) : value("--", false);

  const shiftIdx = s.shift;
  const hasShift = has && Number.isFinite(shiftIdx);

  return {
    hasCan: has,
    speed: value(String(Math.round(speedKmh)), hasSpeed),
    speedKmh,
    // 発電エンジン回転。EV バス `191`。
    engineRpm: has && Number.isFinite(s.engineRpm) ? value(int(s.engineRpm), true) : value("0", false),
    shift: value(hasShift ? SHIFT_NAMES[shiftIdx] : "-", hasShift),
    // 端末と同じ: READY の信号が立っているか、1km/h 以上で走っていれば点灯。
    ready: has && (s.ready === 1 || speedKmh >= 1.0),
    ePedal: has && s.ePedal === 1,
    front: {
      kw: hasFront ? value(signed1(frontKw), true) : value(signed1(0), false),
      torque: hasFront ? value(int(ftq), true) : value("0", false),
      rpm: hasFront ? value(int(frpm), true) : value("0", false),
      saturated: hasFront && Math.abs(ftq) >= TORQUE_SATURATION_NM,
    },
    rear: {
      kw: hasRear ? value(signed1(rearKw), true) : value(signed1(0), false),
      torque: hasRear ? value(int(rtq), true) : value("0", false),
      rpm: hasRear ? value(int(rrpm), true) : value("0", false),
      saturated: hasRear && Math.abs(rtq) >= TORQUE_SATURATION_NM,
    },
    axleSplit: value(`前 ${frontPct}% : 後 ${rearPct}%`, hasFront || hasRear),
    frontRatio: total > 0 ? Math.abs(ftq) / total : 0,
    battery: {
      volt: hasVolt ? value(volt.toFixed(1), true) : value(NOT_AVAILABLE, false),
      amp: hasAmp ? value(signed1(amp), true) : value(NOT_AVAILABLE, false),
      soc: hasSoc ? value(s.socPct.toFixed(1), true) : value(NOT_AVAILABLE, false),
      power: Number.isFinite(powerKw) ? value(signed1(powerKw), true) : value(NOT_AVAILABLE, false),
      powerKw,
    },
    coolant: tempValue(s.coolantC, "℃"),
    oil: tempValue(s.oilC, "℃"),
    intake: tempValue(s.intakeC, "℃"),
    load: has && Number.isFinite(s.loadPct) ? value(`${Math.round(s.loadPct)}%`, true) : value("--", false),
  };
}
