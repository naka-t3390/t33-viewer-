import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanSignalParser, decodeTorque12BitNm, downsampleTorque } from "../js/can-signals.js";

// CAN CSV: timestamp_ms,id,ext,dlc,data(16 桁の 16 進)。車速(289)とヨーレート(0AB)は
// どちらも data の b6-7(16 進 12〜16 桁目)に 16bit ビッグエンディアンで入っている。
const line = (ms, id, u16, dlc = 8) =>
  `${ms},${id},0,${dlc},000000000000${u16.toString(16).toUpperCase().padStart(4, "0")}`;

const START = 1_000_000;

test("車速(289)を km/h に直し、記録開始からの秒で返す", () => {
  const p = createCanSignalParser(START);
  // 5107 カウント ÷ 102.15 ≒ 50.0 km/h
  p.feed(line(START + 2500, "289", 5107) + "\n");
  const { speed } = p.finish();
  assert.equal(speed.length, 1);
  assert.equal(speed[0].t, 2.5);
  assert.ok(Math.abs(speed[0].kmh - 50) < 0.1, `got ${speed[0].kmh}`);
});

test("ヨーレート(0AB)は生値のまま返す", () => {
  const p = createCanSignalParser(START);
  p.feed(line(START + 1000, "0AB", 32000) + "\n");
  const { yaw } = p.finish();
  assert.deepEqual(yaw, [{ t: 1, raw: 32000 }]);
});

test("車速とヨーレート以外の ID は捨てる", () => {
  const p = createCanSignalParser(START);
  p.feed([line(START, "141", 100), line(START, "28A", 200), line(START, "075", 300)].join("\n") + "\n");
  const s = p.finish();
  assert.equal(s.speed.length, 0);
  assert.equal(s.yaw.length, 0);
});

test("29bit 拡張 ID(8桁)は 289/0AB と取り違えない", () => {
  const p = createCanSignalParser(START);
  p.feed(`${START},1BDE0289,1,8,0000000000001234\n`);
  assert.equal(p.finish().speed.length, 0);
});

test("行の途中でチャンクが切れても取りこぼさない", () => {
  const p = createCanSignalParser(START);
  const all = line(START, "289", 1000) + "\n" + line(START + 100, "289", 2000) + "\n";
  p.feed(all.slice(0, 20));
  p.feed(all.slice(20, 55));
  p.feed(all.slice(55));
  assert.equal(p.finish().speed.length, 2);
});

test("最後の行に改行が無くても拾う", () => {
  const p = createCanSignalParser(START);
  p.feed(line(START, "0AB", 32000));
  assert.equal(p.finish().yaw.length, 1);
});

test("ヘッダ行・壊れた行・データ長が足りない行は無視する", () => {
  const p = createCanSignalParser(START);
  p.feed("timestamp_ms,id,ext,dlc,data\n");
  p.feed("abc,289,0,8,0000000000001234\n");
  p.feed(`${START},289,0,2,0012\n`);
  p.feed(`${START},289,0,8,00000000000012ZZ\n`);
  p.feed("\n");
  const s = p.finish();
  assert.equal(s.speed.length, 0);
  assert.equal(s.yaw.length, 0);
});

test("CRLF の行末でも読める", () => {
  const p = createCanSignalParser(START);
  p.feed(line(START, "289", 1000) + "\r\n" + line(START + 100, "289", 1000) + "\r\n");
  assert.equal(p.finish().speed.length, 2);
});

// ---- Drive から落とした ArrayBuffer(gzip または平文)をそのまま読む ----
import zlib from "node:zlib";
import { parseCanSignalsFromBuffer } from "../js/can-signals.js";

const asBuffer = (text) => {
  const b = Buffer.from(text, "latin1");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const csvOf = (rows) => ["timestamp_ms,id,ext,dlc,data", ...rows].join("\n") + "\n";

test("gzip を解凍して車速・ヨーレートを読む", async () => {
  const text = csvOf([line(START, "289", 5107), line(START + 10, "0AB", 32000), line(START, "141", 1)]);
  const gz = zlib.gzipSync(Buffer.from(text, "latin1"));
  const buf = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  const s = await parseCanSignalsFromBuffer(buf, START);
  assert.equal(s.speed.length, 1);
  assert.equal(s.yaw.length, 1);
});

test("解凍済みの平文 CSV(古いセッション)も読む", async () => {
  const s = await parseCanSignalsFromBuffer(asBuffer(csvOf([line(START, "289", 1000)])), START);
  assert.equal(s.speed.length, 1);
});

test("拡張子ではなく先頭 2 バイト(1f 8b)で gzip かを判定する", async () => {
  // 平文の先頭が 1f 8b でないことと、gzip の先頭が 1f 8b であることだけで切り替える
  const gz = zlib.gzipSync(Buffer.from(csvOf([line(START, "0AB", 32100)]), "latin1"));
  const s = await parseCanSignalsFromBuffer(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength), START);
  assert.deepEqual(s.yaw, [{ t: 0, raw: 32100 }]);
});

test("大きなログ(チャンクの境目をまたぐ)でも件数が合う", async () => {
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push(line(START + i * 10, i % 2 ? "289" : "0AB", 1000 + (i % 500)));
  const gz = zlib.gzipSync(Buffer.from(csvOf(rows), "latin1"));
  const s = await parseCanSignalsFromBuffer(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength), START);
  assert.equal(s.speed.length, 10000);
  assert.equal(s.yaw.length, 10000);
});

test("壊れた gzip は例外にする(呼び出し側が生の軌跡へ戻す)", async () => {
  const bad = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  await assert.rejects(() => parseCanSignalsFromBuffer(bad, START));
});

test("前(1D4)・後(1BC)モータートルクを 12bit × 0.125 Nm で抽出する", () => {
  const p = createCanSignalParser(START);
  // 1D4: b2-3 = 0x2100 → +66.0 Nm / 1BC: b2-3 = 0x0B90 → +23.125 Nm / 1BC 回生: 0xF500 → -22.0 Nm
  p.feed(`${START + 1000},1D4,0,8,F80721000F440162\n`);
  p.feed(`${START + 1000},1BC,0,8,CD330B908F040003\n`);
  p.feed(`${START + 2000},1BC,0,8,CD33F5008F040003\n`);
  const s = p.finish();
  assert.deepEqual(s.frontTorque, [{ t: 1, nm: 66 }]);
  assert.deepEqual(s.rearTorque, [{ t: 1, nm: 23.125 }, { t: 2, nm: -22 }]);
  assert.equal(decodeTorque12BitNm(0xDFE0), -64.25);
});

test("downsampleTorque は指定秒刻みのバケット平均で間引く", () => {
  const pts = [
    { t: 0.05, nm: 10 },
    { t: 0.15, nm: 20 },
    { t: 0.25, nm: -10 },
  ];
  const out = downsampleTorque(pts, 0.2);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].nm - 15) < 1e-6);
  assert.ok(Math.abs(out[1].nm - -10) < 1e-6);
});

// ────────────────────────────────────────────────────────────
// 端末画面(縦型)パネル用の 20Hz グリッド
// ────────────────────────────────────────────────────────────
import { sampleCockpitAt, COCKPIT_HZ, COCKPIT_HOLD_SEC } from "../js/can-signals.js";
import { cockpitModelOf } from "../js/cockpit-model.js";

/** data の 16 進 16 桁をそのまま指定する行。 */
const raw = (ms, id, hex16, dlc = 8) => `${ms},${id},0,${dlc},${hex16}`;
/** 1D4: b2-3 にトルク、b5 にシフト/READY。 */
const line1D4 = (ms, torqueHex4, b5Hex2) => raw(ms, "1D4", `0000${torqueHex4}00${b5Hex2}0000`);
/** 1DA: b4-5 に前モータ回転。 */
const line1DA = (ms, rpmHex4) => raw(ms, "1DA", `00000000${rpmHex4}0000`);

const gridOf = (lines, startMs = START) => {
  const p = createCanSignalParser(startMs);
  p.feed(lines.join("\n") + "\n");
  return p.finish().cockpit;
};

test("グリッドは 20Hz(端末の CAN 公開間隔 50ms と同じ刻み)", () => {
  assert.equal(COCKPIT_HZ, 20);
});

test("1D4 からトルクとシフト・READY を同じ行で取り出す", () => {
  // b2-3 = 0x2100 → +66.0 Nm / b5 = 0x44 → シフト D・READY 点灯
  const grid = gridOf([line1D4(START + 1000, "2100", "44")]);
  const s = sampleCockpitAt(grid, 1.0);
  assert.equal(s.frontTorqueNm, 66);
  assert.equal(s.shift, 2); // D
  assert.equal(s.ready, 1);
});

test("1 バケット(50ms)に複数フレームが来たら最後の値が残る(平均しない)", () => {
  const grid = gridOf([
    line1D4(START + 1000, "2100", "44"), // +66.0
    line1D4(START + 1040, "0500", "44"), // +10.0 ← 同じバケットの後の方
  ]);
  assert.equal(sampleCockpitAt(grid, 1.0).frontTorqueNm, 10);
});

test("10Hz の信号(SOC・温度)は次の値が来るまで前値を保持する", () => {
  const lines = [raw(START, "55B", "8BC0000000000000")]; // SOC 55.9%
  // 1D4 を 50ms ごとに 5 秒ぶん流して「CAN は生きている」状態を作る
  for (let ms = 0; ms <= 5000; ms += 50) lines.push(line1D4(START + ms, "0000", "44"));
  const grid = gridOf(lines);
  assert.ok(Math.abs(sampleCockpitAt(grid, 0.0).socPct - 55.9) < 0.01, "来た直後");
  assert.ok(Math.abs(sampleCockpitAt(grid, 1.9).socPct - 55.9) < 0.01, "保持の内側");
  assert.ok(Number.isNaN(sampleCockpitAt(grid, 3.0).socPct), "保持の上限を超えたら未取得へ戻す");
});

test("前値の保持には上限がある(CAN が落ちた区間で古い値を出し続けない)", () => {
  assert.equal(COCKPIT_HOLD_SEC, 2.0);
  const grid = gridOf([line1D4(START, "2100", "44"), line1D4(START + 10000, "2100", "44")]);
  // 10 秒の空白。保持の 2 秒を越えた中間は「CAN なし」にする
  assert.equal(sampleCockpitAt(grid, 5.0), null);
  assert.ok(sampleCockpitAt(grid, 1.0) !== null, "落ちる直前までは残す");
});

test("CAN ログの範囲外(記録前・記録後)は null を返す", () => {
  const grid = gridOf([line1D4(START + 1000, "2100", "44")]);
  assert.equal(sampleCockpitAt(grid, -1), null);
  assert.equal(sampleCockpitAt(grid, 60), null);
  assert.equal(sampleCockpitAt(null, 1), null);
  assert.equal(sampleCockpitAt(grid, NaN), null);
});

test("容量を超える長い走行でも伸ばして読める(16,384 行 = 819 秒の先)", () => {
  const grid = gridOf([line1D4(START, "2100", "44"), line1D4(START + 1_000_000, "0500", "42")]);
  const s = sampleCockpitAt(grid, 1000);
  assert.equal(s.frontTorqueNm, 10);
  assert.equal(s.shift, 1); // R
});

test("四輪速は 289(前) と 28A(後) から FL/FR/RL/RR の順で入る", () => {
  // 289: b2-3=FL, b4-5=FR / 28A: b0-1=RR, b2-3=RL
  const grid = gridOf([
    raw(START, "289", "0000" + "1C34" + "1C34" + "0000"), // FL/FR = 7220 → 40.07km/h
    raw(START, "28A", "1388" + "1388" + "00000000"), // RR/RL = 5000 → 27.75km/h
  ]);
  const w = sampleCockpitAt(grid, 0).wheelKmh;
  assert.ok(Math.abs(w[0] - 40.07) < 0.05, `FL got ${w[0]}`);
  assert.ok(Math.abs(w[1] - 40.07) < 0.05, `FR got ${w[1]}`);
  assert.ok(Math.abs(w[2] - 27.75) < 0.05, `RL got ${w[2]}`);
  assert.ok(Math.abs(w[3] - 27.75) < 0.05, `RR got ${w[3]}`);
});

test("車速(29A)・電圧/電流(1DB)・発電回転(191)・温度(50F/4B0)・負荷(41A)を拾う", () => {
  const grid = gridOf([
    raw(START, "29A", "00000000" + "13F0" + "0000"), // 5104 → 49.996 km/h
    raw(START, "1DB", "EBA0" + "B100" + "00000000"), // 電流 -81.5A / 電圧 354.0V
    raw(START, "191", "0000000000" + "2943" + "00"), // 10563 → 2062.8 rpm
    raw(START, "50F", "00" + "73" + "000000" + "4B" + "00"), // 水温 75℃ / 吸気 25℃
    raw(START, "4B0", "56" + "00000000000000"), // 油温 56℃
    raw(START, "41A", "000000" + "2021" + "000000"), // 8225 → 99.97%
  ]);
  const s = sampleCockpitAt(grid, 0);
  assert.ok(Math.abs(s.speedKmh - 49.996) < 0.01, `車速 ${s.speedKmh}`);
  assert.equal(s.batteryV, 354);
  assert.equal(s.batteryA, -81.5);
  assert.ok(Math.abs(s.engineRpm - 2062.8) < 0.1, `発電回転 ${s.engineRpm}`);
  assert.equal(s.coolantC, 75);
  assert.equal(s.intakeC, 25);
  assert.equal(s.oilC, 56);
  assert.ok(Math.abs(s.loadPct - 99.9668) < 0.01, `負荷 ${s.loadPct}`);
});

test("既存の戻り値(speed / yaw / frontTorque / rearTorque)の形は変えていない", () => {
  const p = createCanSignalParser(START);
  p.feed(
    [
      line(START, "289", 5107),
      line(START + 10, "0AB", 32000),
      line1D4(START + 20, "2100", "44"),
      raw(START + 30, "1BC", "0000" + "0B90" + "00000000"),
    ].join("\n") + "\n"
  );
  const s = p.finish();
  assert.equal(s.speed.length, 1);
  assert.equal(s.yaw.length, 1);
  assert.deepEqual(s.frontTorque, [{ t: 0.02, nm: 66 }]);
  assert.deepEqual(s.rearTorque, [{ t: 0.03, nm: 23.125 }]);
  assert.ok(s.cockpit && s.cockpit.rows > 0, "cockpit グリッドが足されている");
});

// ---- 時刻合わせの回帰(2026-11-28 セッション 102230 の後退区間) ----
//
// `_video.json` の start_ms を t=0 とすると、実データでは
//   前モータ回転 < -5 rpm が 599.88〜617.00 秒
//   シフト R     が 600.21〜618.01 秒(17.8 秒)
// で一致した。同じ形を合成フィクスチャで固定し、基準がずれたら落ちるようにする。
test("時刻合わせ: 600 秒から R + 前回転が負になるログを、その時刻で読める", () => {
  const lines = [];
  // 589〜590 秒: D で前進(+2806 rpm)
  for (let ms = 589_000; ms <= 590_000; ms += 50) {
    lines.push(line1D4(START + ms, "2100", "44")); // D・READY
    lines.push(line1DA(START + ms, "15EC")); // +2806.0 rpm
  }
  // 600〜618 秒: R で後退(-270.5 rpm)
  for (let ms = 600_000; ms <= 618_000; ms += 50) {
    lines.push(line1D4(START + ms, "0500", "42")); // R・READY
    lines.push(line1DA(START + ms, "FDE3")); // -270.5 rpm
  }
  const grid = gridOf(lines);

  const before = cockpitModelOf(sampleCockpitAt(grid, 590));
  assert.equal(before.shift.text, "D");
  assert.ok(Number(before.front.rpm.text.replace(/,/g, "")) > 0, "前進は正");

  const reverse = cockpitModelOf(sampleCockpitAt(grid, 600.5));
  assert.equal(reverse.shift.text, "R");
  assert.equal(reverse.front.rpm.text, "-270");
  assert.equal(reverse.ready, true);

  const stillReverse = cockpitModelOf(sampleCockpitAt(grid, 617.0));
  assert.equal(stillReverse.shift.text, "R");

  // 590 と 600 の間は CAN が無い(保持の上限を越える空白)
  assert.equal(sampleCockpitAt(grid, 595), null);
});
