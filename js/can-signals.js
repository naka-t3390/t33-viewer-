// CAN ログ(_can.csv / _can.csv.gz)から、経路の再構成・グラフ表示・端末画面の再現に
// 要る信号だけを取り出す。
//
// 1 走行で 250〜360 万行・90〜134MB あるので、
//  - 行ごとに文字列を作らない(ID は文字コードから整数キーにして 1 回の switch で分岐)
//  - 16 進も slice/正規表現を通さず、文字コードから直に読む
//  - 端末画面用の値は **20Hz のグリッド(Float32Array の列)** へ間引いて持つ
// チャンクの境目で行が切れても取りこぼさない(streaming で食わせられる)。
//
// 取り出す値の読み方(係数・符号・ビット幅)の出どころは `js/cockpit-model.js`
// (= T33Monitor の `data/can/CanSignalSpec.kt`)に集めてある。
// ここは「どの ID のどのバイトを読むか」だけを持つ。

import {
  motorTorqueNm,
  motorRpm,
  batteryVoltageV,
  batteryCurrentA,
  batterySocPercent,
  engineRpmOf,
  vehicleSpeedKmh,
  wheelSpeedKmh,
  steeringDegrees,
  coolantTempC,
  oilTempC,
  intakeTempC,
  engineLoadPercent,
  shiftIndexOf,
  readyOf,
  ePedalActiveOf,
} from "./cockpit-model.js";

/** 既存バス `289` の車体速度のスケール(軌跡の再構成で使う。EV バスとは別係数)。 */
export const SPEED_COUNTS_PER_KMH = 102.15;
export const TORQUE_NM_PER_COUNT_12BIT = 0.125;

/**
 * 端末画面の再現に使うグリッドの刻み(Hz)。
 *
 * 端末は CAN スナップショットを 50ms ごとに公開しているので、20Hz が端末と同じ刻みになる。
 * 各バケットには**平均ではなくそのバケットの最終値**を入れる(平均するとトルクの山が鈍り、
 * 端末の表示と変わってしまう)。
 */
export const COCKPIT_HZ = 20;

/**
 * 前値を保持する上限(秒)。
 *
 * SOC・温度・負荷は 10Hz なので 20Hz グリッドでは 1 つ飛びになる。端末も最後に来た
 * CAN 値を保持して表示しているので、同じく前値を保持する。ただし**際限なく保持しない**:
 * CAN が落ちた区間(2026-08-29 に 29 分取りこぼした例がある)で古い値を出し続けると、
 * 走っていないのに走っているように見える。ここを超えたら未取得(NaN)に戻す。
 */
export const COCKPIT_HOLD_SEC = 2.0;

/** グリッドの列。`data[row * COCKPIT_COL_COUNT + col]` で読む。 */
export const COCKPIT_COLS = {
  frontTorqueNm: 0,
  rearTorqueNm: 1,
  frontRpm: 2,
  rearRpm: 3,
  batteryV: 4,
  batteryA: 5,
  socPct: 6,
  engineRpm: 7,
  speedKmh: 8,
  coolantC: 9,
  oilC: 10,
  intakeC: 11,
  loadPct: 12,
  shift: 13,
  ready: 14,
  ePedal: 15,
  steeringDeg: 16,
  accelGRaw: 17,
  wheelFL: 18,
  wheelFR: 19,
  wheelRL: 20,
  wheelRR: 21,
};
export const COCKPIT_COL_COUNT = 22;

/**
 * 16bit 値の上位 12bit を符号付き整数へ直し、Nm(×0.125)へ換算する。
 * (既存の呼び出し元のために残す。実体は cockpit-model.js の motorTorqueNm)
 * @param {number} u16
 */
export function decodeTorque12BitNm(u16) {
  return motorTorqueNm(u16);
}

/**
 * 100Hz のトルク配列をグラフ描画向けに間引く(各バケットの平均値)。
 * @param {Array<{t:number, nm:number}>} points
 * @param {number} stepSec
 */
export function downsampleTorque(points, stepSec = 0.2) {
  if (!points || points.length === 0) return [];
  const out = [];
  let bucket = Math.floor(points[0].t / stepSec);
  let sumT = 0, sumNm = 0, count = 0;
  for (const p of points) {
    const b = Math.floor(p.t / stepSec);
    if (b !== bucket && count > 0) {
      out.push({ t: sumT / count, nm: sumNm / count });
      bucket = b;
      sumT = 0; sumNm = 0; count = 0;
    }
    sumT += p.t;
    sumNm += p.nm;
    count++;
  }
  if (count > 0) out.push({ t: sumT / count, nm: sumNm / count });
  return out;
}

// ---- 16 進の読み取り(slice も正規表現も通さない) ----

/** 1 桁の 16 進。読めなければ -1。 */
function nibble(code) {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 65 && code <= 70) return code - 55; // A-F
  if (code >= 97 && code <= 102) return code - 87; // a-f
  return -1;
}

/** text[i..i+1] を 8bit として読む。読めなければ -1。 */
function hex2(text, i) {
  const a = nibble(text.charCodeAt(i));
  const b = nibble(text.charCodeAt(i + 1));
  return a < 0 || b < 0 ? -1 : (a << 4) | b;
}

/** text[i..i+3] を 16bit ビッグエンディアンとして読む。読めなければ -1。 */
function hex4(text, i) {
  const hi = hex2(text, i);
  const lo = hex2(text, i + 2);
  return hi < 0 || lo < 0 ? -1 : (hi << 8) | lo;
}

// ---- ID を整数キーにする(3 文字の文字コードを詰める) ----

const idKey = (s) => (s.charCodeAt(0) << 16) | (s.charCodeAt(1) << 8) | s.charCodeAt(2);

const K_289 = idKey("289"); // 既存バス 車体速度 b6-7 / 前輪速 b2-3(FL), b4-5(FR)
const K_28A = idKey("28A"); // 既存バス 後輪速 b2-3(RL), b0-1(RR)
const K_0AB = idKey("0AB"); // 既存バス ヨーレート b6-7
const K_141 = idKey("141"); // 既存バス 舵角 b2-3
const K_0B4 = idKey("0B4"); // 既存バス 前後G b2-3
const K_47A = idKey("47A"); // 既存バス e-Pedal b1 bit3
const K_1D4 = idKey("1D4"); // EV バス 前トルク b2-3 / シフト・READY b5
const K_1BC = idKey("1BC"); // EV バス 後トルク b2-3
const K_1DA = idKey("1DA"); // EV バス 前モータ回転 b4-5
const K_1CE = idKey("1CE"); // EV バス 後モータ回転 b4-5
const K_1DB = idKey("1DB"); // EV バス 電圧 b2-3 / 電流 b0-1
const K_55B = idKey("55B"); // EV バス SOC b0-1
const K_191 = idKey("191"); // EV バス 発電エンジン回転 b5-6
const K_29A = idKey("29A"); // EV バス 車体速度 b4-5
const K_50F = idKey("50F"); // EV バス 水温 b1 / 吸気温 b5
const K_4B0 = idKey("4B0"); // EV バス 油温 b0
const K_41A = idKey("41A"); // EV バス エンジン負荷 b3-4

/**
 * 20Hz グリッドを組み立てる。行は時刻順に増え、容量は倍々で伸ばす。
 *
 * 1 バケット(50ms)に複数フレームが来たら**最後のものが残る**。
 */
class CockpitGridBuilder {
  constructor() {
    this.capacity = 1 << 14; // 16,384 行 ≒ 819 秒ぶん
    this.data = new Float32Array(this.capacity * COCKPIT_COL_COUNT).fill(NaN);
    this.alive = new Uint8Array(this.capacity);
    this.rows = 0;
    this.firstRow = -1;
  }

  /** t(秒)の行番号。記録開始前(負)は 0 行目に寄せる。 */
  rowOf(t) {
    const row = Math.floor(t * COCKPIT_HZ);
    return row < 0 ? 0 : row;
  }

  ensure(row) {
    if (row < this.capacity) return;
    let cap = this.capacity;
    while (cap <= row) cap *= 2;
    const next = new Float32Array(cap * COCKPIT_COL_COUNT).fill(NaN);
    next.set(this.data);
    this.data = next;
    const alive = new Uint8Array(cap);
    alive.set(this.alive);
    this.alive = alive;
    this.capacity = cap;
  }

  set(row, col, v) {
    this.ensure(row);
    this.data[row * COCKPIT_COL_COUNT + col] = v;
    this.alive[row] = 1;
    if (this.firstRow < 0) this.firstRow = row;
    if (row + 1 > this.rows) this.rows = row + 1;
  }

  /**
   * 列ごとに前値を保持して埋める([COCKPIT_HOLD_SEC] を超えたら未取得へ戻す)。
   * 最初の値が来る前の行は NaN のままにする(「まだ来ていない」と「落ちた」を区別する)。
   */
  finish() {
    const holdRows = Math.round(COCKPIT_HOLD_SEC * COCKPIT_HZ);
    const { rows, data } = this;
    for (let col = 0; col < COCKPIT_COL_COUNT; col++) {
      let last = NaN;
      let age = 0;
      for (let row = 0; row < rows; row++) {
        const i = row * COCKPIT_COL_COUNT + col;
        const v = data[i];
        if (Number.isFinite(v)) {
          last = v;
          age = 0;
        } else if (Number.isFinite(last) && age < holdRows) {
          data[i] = last;
          age++;
        } else {
          last = NaN;
        }
      }
    }
    // 行そのものの生存も同じ約束で埋める(どの列が来ているかに依らず判定できる)。
    let aliveAge = holdRows + 1;
    for (let row = 0; row < rows; row++) {
      if (this.alive[row]) aliveAge = 0;
      else aliveAge++;
      this.alive[row] = aliveAge <= holdRows ? 1 : 0;
    }
    return {
      hz: COCKPIT_HZ,
      colCount: COCKPIT_COL_COUNT,
      rows,
      data: this.data,
      alive: this.alive,
      firstRow: this.firstRow < 0 ? 0 : this.firstRow,
      lastRow: rows - 1,
    };
  }
}

/**
 * グリッドから時刻 t(秒)のサンプルを 1 つ取り出す。
 *
 * 範囲外・CAN が落ちていた区間では null を返す。呼び出し側(`cockpitModelOf`)は
 * null をそのまま「CAN なし」として全部グレーに描く。
 *
 * @param {object|null} grid
 * @param {number} t
 */
export function sampleCockpitAt(grid, t) {
  if (!grid || grid.rows === 0 || !Number.isFinite(t)) return null;
  const row = Math.floor(t * grid.hz);
  if (row < grid.firstRow || row > grid.lastRow) return null;
  if (!grid.alive[row]) return null;
  const d = grid.data;
  const base = row * grid.colCount;
  const at = (col) => d[base + col];
  const C = COCKPIT_COLS;
  return {
    t,
    hasCan: true,
    frontTorqueNm: at(C.frontTorqueNm),
    rearTorqueNm: at(C.rearTorqueNm),
    frontRpm: at(C.frontRpm),
    rearRpm: at(C.rearRpm),
    batteryV: at(C.batteryV),
    batteryA: at(C.batteryA),
    socPct: at(C.socPct),
    engineRpm: at(C.engineRpm),
    speedKmh: at(C.speedKmh),
    coolantC: at(C.coolantC),
    oilC: at(C.oilC),
    intakeC: at(C.intakeC),
    loadPct: at(C.loadPct),
    shift: at(C.shift),
    ready: at(C.ready),
    ePedal: at(C.ePedal),
    steeringDeg: at(C.steeringDeg),
    accelGRaw: at(C.accelGRaw),
    wheelKmh: [at(C.wheelFL), at(C.wheelFR), at(C.wheelRL), at(C.wheelRR)],
  };
}

/**
 * @param {number} startMs 動画/走行CSV の起点(epoch ms)。t はここからの秒。
 */
export function createCanSignalParser(startMs) {
  const speed = [];
  const yaw = [];
  const frontTorque = [];
  const rearTorque = [];
  const grid = new CockpitGridBuilder();
  const C = COCKPIT_COLS;
  let carry = "";

  // text[s, e) が 1 行。`timestamp_ms,id,ext,dlc,data`
  function handleLine(text, s, e) {
    const c1 = text.indexOf(",", s);
    if (c1 < 0 || c1 >= e) return;
    // ID は直後の 3 文字 + カンマ。29bit 拡張 ID(8 桁)はカンマが来ないので一致しない。
    if (text.charCodeAt(c1 + 4) !== 44) return;
    const key =
      (text.charCodeAt(c1 + 1) << 16) | (text.charCodeAt(c1 + 2) << 8) | text.charCodeAt(c1 + 3);

    const lastComma = text.lastIndexOf(",", e - 1);
    if (lastComma <= c1) return;
    const dataStart = lastComma + 1;
    const dataEnd = text.charCodeAt(e - 1) === 13 ? e - 1 : e; // CRLF
    const bytes = (dataEnd - dataStart) >> 1;
    if (bytes < 1) return;

    const ts = Number(text.slice(s, c1));
    if (!Number.isFinite(ts)) return;
    const t = (ts - startMs) / 1000;

    /** b 番目のバイトから 16bit。足りない・壊れていれば -1。 */
    const u16 = (b) => (bytes < b + 2 ? -1 : hex4(text, dataStart + b * 2));
    /** b 番目のバイトを 8bit。足りない・壊れていれば -1。 */
    const u8 = (b) => (bytes < b + 1 ? -1 : hex2(text, dataStart + b * 2));
    const row = grid.rowOf(t);

    switch (key) {
      case K_1D4: {
        const tq = u16(2);
        if (tq >= 0) {
          const nm = motorTorqueNm(tq);
          frontTorque.push({ t, nm });
          grid.set(row, C.frontTorqueNm, nm);
        }
        const b5 = u8(5);
        if (b5 >= 0) {
          grid.set(row, C.shift, shiftIndexOf(b5));
          grid.set(row, C.ready, readyOf(b5) ? 1 : 0);
        }
        return;
      }
      case K_1BC: {
        const tq = u16(2);
        if (tq < 0) return;
        const nm = motorTorqueNm(tq);
        rearTorque.push({ t, nm });
        grid.set(row, C.rearTorqueNm, nm);
        return;
      }
      case K_1DA: {
        const v = u16(4);
        if (v >= 0) grid.set(row, C.frontRpm, motorRpm(v));
        return;
      }
      case K_1CE: {
        const v = u16(4);
        if (v >= 0) grid.set(row, C.rearRpm, motorRpm(v));
        return;
      }
      case K_1DB: {
        const volt = u16(2);
        if (volt >= 0) grid.set(row, C.batteryV, batteryVoltageV(volt));
        const amp = u16(0);
        if (amp >= 0) grid.set(row, C.batteryA, batteryCurrentA(amp));
        return;
      }
      case K_55B: {
        const v = u16(0);
        if (v >= 0) grid.set(row, C.socPct, batterySocPercent(v));
        return;
      }
      case K_191: {
        const v = u16(5);
        if (v >= 0) grid.set(row, C.engineRpm, engineRpmOf(v));
        return;
      }
      case K_29A: {
        const v = u16(4);
        if (v >= 0) grid.set(row, C.speedKmh, vehicleSpeedKmh(v));
        return;
      }
      case K_50F: {
        const c = u8(1);
        if (c >= 0) grid.set(row, C.coolantC, coolantTempC(c));
        const i = u8(5);
        if (i >= 0) grid.set(row, C.intakeC, intakeTempC(i));
        return;
      }
      case K_4B0: {
        const v = u8(0);
        if (v >= 0) grid.set(row, C.oilC, oilTempC(v));
        return;
      }
      case K_41A: {
        const v = u16(3);
        if (v >= 0) grid.set(row, C.loadPct, engineLoadPercent(v));
        return;
      }
      case K_47A: {
        const v = u8(1);
        if (v >= 0) grid.set(row, C.ePedal, ePedalActiveOf(v) ? 1 : 0);
        return;
      }
      case K_141: {
        const v = u16(2);
        if (v >= 0) grid.set(row, C.steeringDeg, steeringDegrees(v));
        return;
      }
      case K_0B4: {
        const v = u16(2);
        if (v >= 0) grid.set(row, C.accelGRaw, v);
        return;
      }
      case K_289: {
        const body = u16(6);
        if (body >= 0) speed.push({ t, kmh: body / SPEED_COUNTS_PER_KMH });
        const fl = u16(2);
        if (fl >= 0) grid.set(row, C.wheelFL, wheelSpeedKmh(fl));
        const fr = u16(4);
        if (fr >= 0) grid.set(row, C.wheelFR, wheelSpeedKmh(fr));
        return;
      }
      case K_28A: {
        const rl = u16(2);
        if (rl >= 0) grid.set(row, C.wheelRL, wheelSpeedKmh(rl));
        const rr = u16(0);
        if (rr >= 0) grid.set(row, C.wheelRR, wheelSpeedKmh(rr));
        return;
      }
      case K_0AB: {
        const v = u16(6);
        if (v >= 0) yaw.push({ t, raw: v });
        return;
      }
      default:
        return;
    }
  }

  return {
    feed(chunk) {
      const text = carry ? carry + chunk : chunk;
      let pos = 0;
      for (;;) {
        const nl = text.indexOf("\n", pos);
        if (nl < 0) break;
        handleLine(text, pos, nl);
        pos = nl + 1;
      }
      carry = text.slice(pos);
    },
    finish() {
      if (carry) { handleLine(carry, 0, carry.length); carry = ""; }
      // 通常は時刻順に並んでいるが、念のため保証する(積分・グラフは昇順を前提にする)。
      const byT = (a, b) => a.t - b.t;
      if (speed.some((v, i) => i > 0 && v.t < speed[i - 1].t)) speed.sort(byT);
      if (yaw.some((v, i) => i > 0 && v.t < yaw[i - 1].t)) yaw.sort(byT);
      if (frontTorque.some((v, i) => i > 0 && v.t < frontTorque[i - 1].t)) frontTorque.sort(byT);
      if (rearTorque.some((v, i) => i > 0 && v.t < rearTorque[i - 1].t)) rearTorque.sort(byT);
      return { speed, yaw, frontTorque, rearTorque, cockpit: grid.finish() };
    },
  };
}

/**
 * Drive から落とした CAN ログ(ArrayBuffer)を読む。gzip でも平文でもよい。
 *
 * 判定は拡張子ではなく先頭 2 バイト(1f 8b)で行う。Drive は名前と中身の対応を保証しない。
 * gzip は解凍しながらチャンクごとに食わせるので、100MB 級の CSV 全体を文字列にしない。
 * 壊れた gzip は例外にする(呼び出し側は生の軌跡のままにする)。
 *
 * @param {ArrayBuffer} buffer
 * @param {number} startMs
 */
export async function parseCanSignalsFromBuffer(buffer, startMs) {
  const parser = createCanSignalParser(startMs);
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  const isGzip = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
  if (isGzip) {
    const reader = new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream("latin1"))
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(value);
    }
  } else {
    const text = new TextDecoder("latin1").decode(buffer);
    const CH = 1 << 20;
    for (let i = 0; i < text.length; i += CH) parser.feed(text.slice(i, i + CH));
  }
  return parser.finish();
}
