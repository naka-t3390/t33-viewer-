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
