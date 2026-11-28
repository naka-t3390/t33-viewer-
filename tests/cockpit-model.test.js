import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toS16, toS12High, toS11High, toU10High,
  motorTorqueNm, motorRpm, batteryVoltageV, batteryCurrentA, batterySocPercent,
  engineRpmOf, vehicleSpeedKmh, wheelSpeedKmh, steeringDegrees,
  coolantTempC, oilTempC, intakeTempC, engineLoadPercent,
  shiftIndexOf, readyOf, ePedalActiveOf, SHIFT_NAMES,
  cockpitModelOf, ACCEL_G_CENTER,
} from "../js/cockpit-model.js";

const near = (actual, expected, tol = 1e-6, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label} expected ≒${expected}, got ${actual}`);

// ---- ビット取り出し ----

test("toS16: 0x8000 以上は負に折り返す", () => {
  assert.equal(toS16(0x0000), 0);
  assert.equal(toS16(0x7fff), 32767);
  assert.equal(toS16(0x8000), -32768);
  assert.equal(toS16(0xffff), -1);
});

test("toS12High: 上位 12bit を符号付きで読む(下位 4bit は捨てる)", () => {
  assert.equal(toS12High(0x2100), 0x210); // +528
  assert.equal(toS12High(0x210f), 0x210); // 下位 4bit が立っていても同じ
  assert.equal(toS12High(0x8000), -2048); // 下限
  assert.equal(toS12High(0x7ff0), 2047); // 上限
  assert.equal(toS12High(0xf500), -176);
});

test("toS11High: 上位 11bit を符号付きで読む", () => {
  assert.equal(toS11High(0x0000), 0);
  assert.equal(toS11High(0x7fe0), 1023); // 上限
  assert.equal(toS11High(0x8000), -1024); // 下限
  assert.equal(toS11High(0xeba0), -163);
});

test("toU10High: 上位 10bit を読む", () => {
  assert.equal(toU10High(0xb100), 708);
  assert.equal(toU10High(0xffc0), 1023);
});

// ---- 信号ごとのデコード(CanSignalSpec.kt の係数と 1 対 1) ----

test("モータートルクは上位 12bit 符号付き × 0.125 Nm。駆動が正・回生が負", () => {
  assert.equal(motorTorqueNm(0x2100), 66.0);
  assert.equal(motorTorqueNm(0x0b90), 23.125);
  assert.equal(motorTorqueNm(0xf500), -22.0);
  // 12bit の上限 ±2047 カウント = ±255.875 Nm(公称 330Nm に届かない件は未解決)
  assert.equal(motorTorqueNm(0x7ff0), 255.875);
  assert.equal(motorTorqueNm(0x8000), -256.0);
});

test("モータ回転は符号付き 16bit × 0.5 rpm。後退で負になる", () => {
  assert.equal(motorRpm(0x15ec), 2806.0);
  // 2026-11-28 の 102230 の後退区間で出た最小値 -270.5 rpm
  assert.equal(motorRpm(0xfde3), -270.5);
  assert.equal(motorRpm(0x0000), 0);
});

test("電池電圧は上位 10bit × 0.5V。停車 IGN ON の 354.0V になる", () => {
  assert.equal(batteryVoltageV(0xb100), 354.0);
});

test("電池電流は上位 11bit 符号付き × 0.5A。**負が放電・正が回生**", () => {
  assert.equal(batteryCurrentA(0xeba0), -81.5); // 放電の実測下限
  assert.equal(batteryCurrentA(0x0680), 26.0); // 回生側は正
  assert.equal(batteryCurrentA(0x0000), 0);
});

test("SOC は上位 10bit ÷ 10", () => {
  near(batterySocPercent(0x8bc0), 55.9, 1e-9, "SOC");
});

test("発電エンジン回転は 191 の生値 ÷ 5.1207", () => {
  near(engineRpmOf(10563), 2062.80, 0.01, "発電回転");
  assert.equal(engineRpmOf(0), 0);
});

test("車速は 29A の生値 ÷ 102.086、車輪速は ÷ 180.2(別スケール)", () => {
  near(vehicleSpeedKmh(5104), 49.996, 0.01, "車速");
  near(wheelSpeedKmh(9010), 50.0, 0.01, "車輪速");
});

test("舵角は中立 32768 からの差 × 0.0434 度。**左が正・右が負**", () => {
  assert.equal(steeringDegrees(32768), 0);
  near(steeringDegrees(32768 + 10608), 460.4, 0.1, "左へ切る");
  assert.ok(steeringDegrees(32768 - 6741) < 0, "右へ切ると負");
});

test("温度はそれぞれのオフセットを引く(水温 -40 / 油温 -30 / 吸気 -50)", () => {
  assert.equal(coolantTempC(115), 75);
  assert.equal(oilTempC(86), 56);
  assert.equal(intakeTempC(75), 25);
});

test("エンジン負荷は (生値 - 31) × 0.0122 を 0〜100 でクランプする", () => {
  assert.equal(engineLoadPercent(31), 0);
  assert.equal(engineLoadPercent(0), 0); // 負にならない
  near(engineLoadPercent(8225), 99.9668, 1e-3, "ほぼ全負荷"); // (8225-31) × 0.0122
  assert.equal(engineLoadPercent(60000), 100); // 上でクランプ
});

test("シフトは 1D4 b5 の bit1-2(0=N / 1=R / 2=D / 3=P)", () => {
  assert.equal(SHIFT_NAMES[shiftIndexOf(0x40)], "N");
  assert.equal(SHIFT_NAMES[shiftIndexOf(0x42)], "R");
  assert.equal(SHIFT_NAMES[shiftIndexOf(0x44)], "D");
  assert.equal(SHIFT_NAMES[shiftIndexOf(0x46)], "P");
});

test("READY は 1D4 b5 の bit6", () => {
  assert.equal(readyOf(0x44), true);
  assert.equal(readyOf(0x04), false);
});

test("e-Pedal は 47A b1 の bit3", () => {
  assert.equal(ePedalActiveOf(0x68), true);
  assert.equal(ePedalActiveOf(0x64), false);
});

// ---- 表示モデル ----

/** 20Hz グリッドの 1 サンプル相当。未取得は NaN。 */
const sampleOf = (over = {}) => ({
  hasCan: true,
  frontTorqueNm: 0, rearTorqueNm: 0, frontRpm: 0, rearRpm: 0,
  batteryV: NaN, batteryA: NaN, socPct: NaN, engineRpm: NaN, speedKmh: NaN,
  coolantC: NaN, oilC: NaN, intakeC: NaN, loadPct: NaN,
  shift: NaN, ready: NaN, ePedal: NaN,
  steeringDeg: NaN, accelGRaw: NaN, wheelKmh: [NaN, NaN, NaN, NaN],
  ...over,
});

test("モーター出力は トルク × |回転| ÷ 9549", () => {
  const m = cockpitModelOf(sampleOf({ frontTorqueNm: 62.75, frontRpm: 2798.5 }));
  assert.equal(m.front.kw.text, "+18.4"); // 62.75 × 2798.5 ÷ 9549
  assert.equal(m.front.kw.verified, true);
  assert.equal(m.front.torque.text, "63");
  assert.equal(m.front.rpm.text, "2,799");
});

test("回生(トルクが負)は kW も負になる", () => {
  const m = cockpitModelOf(sampleOf({ rearTorqueNm: -22, rearRpm: 2467.5 }));
  assert.ok(m.rear.kw.text.startsWith("-"), `got ${m.rear.kw.text}`);
});

test("後退(回転が負)でも kW の符号はトルクで決まる", () => {
  // 後退の駆動: トルクは正、回転は負 → 出力は正
  const m = cockpitModelOf(sampleOf({ frontTorqueNm: 10, frontRpm: -270.5 }));
  assert.ok(m.front.kw.text.startsWith("+"), `got ${m.front.kw.text}`);
  // 丸めは端末の roundToInt() と同じ「.5 は正の向きへ」なので -270.5 → -270
  assert.equal(m.front.rpm.text, "-270");
});

test("前後配分は |トルク| の比。**両方 0 なら 0:0 をグレーで出す**", () => {
  const zero = cockpitModelOf(sampleOf());
  assert.equal(zero.axleSplit.text, "前 0% : 後 0%");
  assert.equal(zero.axleSplit.verified, false);

  const both = cockpitModelOf(sampleOf({ frontTorqueNm: 60, rearTorqueNm: 20 }));
  assert.equal(both.axleSplit.text, "前 75% : 後 25%");
  assert.equal(both.axleSplit.verified, true);
  near(both.frontRatio, 0.75, 1e-9, "frontRatio");
});

test("トルクが 0 でも回転が出ていれば「取れている」とみなす", () => {
  const m = cockpitModelOf(sampleOf({ frontTorqueNm: 0, frontRpm: 1200 }));
  assert.equal(m.front.rpm.verified, true);
  assert.equal(m.front.torque.text, "0");
  assert.equal(m.front.torque.verified, true);
});

test("CAN が無ければ(sample=null)すべて 0 か --- をグレーで返す", () => {
  const m = cockpitModelOf(null);
  assert.equal(m.hasCan, false);
  assert.equal(m.speed.verified, false);
  assert.equal(m.speed.text, "0");
  assert.equal(m.shift.text, "-");
  assert.equal(m.shift.verified, false);
  assert.equal(m.ready, false);
  assert.equal(m.ePedal, false);
  assert.equal(m.battery.volt.text, "---");
  assert.equal(m.battery.volt.verified, false);
  assert.equal(m.coolant.text, "--");
  assert.equal(m.front.torque.verified, false);
  assert.equal(m.axleSplit.verified, false);
});

test("電池電力は 電圧 × 電流 ÷ 1000。放電(電流が負)なら負になる", () => {
  const m = cockpitModelOf(sampleOf({ batteryV: 354, batteryA: -80 }));
  near(m.battery.powerKw, -28.32, 1e-9, "電池電力");
  assert.equal(m.battery.power.text, "-28.3");
});

test("SOC が 0 や未取得ならグレー(0% という裏付けは無い)", () => {
  assert.equal(cockpitModelOf(sampleOf({ socPct: 0 })).battery.soc.verified, false);
  assert.equal(cockpitModelOf(sampleOf({ socPct: 55.9 })).battery.soc.text, "55.9");
});

test("READY は信号が立っていないときも 1km/h 以上で走っていれば点灯(端末と同じ)", () => {
  assert.equal(cockpitModelOf(sampleOf({ ready: 0, speedKmh: 0.4 })).ready, false);
  assert.equal(cockpitModelOf(sampleOf({ ready: 0, speedKmh: 1.0 })).ready, true);
  assert.equal(cockpitModelOf(sampleOf({ ready: 1, speedKmh: 0 })).ready, true);
});

test("シフトは添字から名前へ。R は文字で分かるようにする", () => {
  assert.equal(cockpitModelOf(sampleOf({ shift: 1 })).shift.text, "R");
  assert.equal(cockpitModelOf(sampleOf({ shift: 2 })).shift.text, "D");
});

test("温度・負荷は取れていれば単位付き、無ければ -- をグレー", () => {
  const m = cockpitModelOf(sampleOf({ coolantC: 75, oilC: 56, intakeC: 25, loadPct: 42.4 }));
  assert.equal(m.coolant.text, "75℃");
  assert.equal(m.oil.text, "56℃");
  assert.equal(m.intake.text, "25℃");
  assert.equal(m.load.text, "42%");
  assert.equal(m.load.verified, true);
  assert.equal(cockpitModelOf(sampleOf()).load.verified, false);
});

test("12bit の上限に近いトルクは飽和の疑いとして印を付ける", () => {
  assert.equal(cockpitModelOf(sampleOf({ frontTorqueNm: 62.75, frontRpm: 100 })).front.saturated, false);
  assert.equal(cockpitModelOf(sampleOf({ frontTorqueNm: 255.875, frontRpm: 100 })).front.saturated, true);
});

test("ノイズで速度が負になっても 0 未満は出さない", () => {
  assert.equal(cockpitModelOf(sampleOf({ speedKmh: -3 })).speed.text, "0");
});

test("前後G の中心は端末と同じ 31959", () => {
  assert.equal(ACCEL_G_CENTER, 31959);
});
