// CAN ログ(_can.csv / _can.csv.gz を解凍したテキスト)から、経路の再構成と
// グラフ表示に要る信号だけを取り出す。
//
//   289  b6-7        車体速度(カウント ÷ 102.15 = km/h)
//   0AB  b6-7        ヨーレート(生値。中立 32000。大きいほど左旋回)
//   1D4  b2-3 上12b  前モータートルク(符号付き × 0.125 = Nm、駆動正・回生負)
//   1BC  b2-3 上12b  後モータートルク(符号付き × 0.125 = Nm、駆動正・回生負)
//
// 1 走行で約 180 万行・100MB あるので、行ごとに文字列を作らず、必要な ID の行だけを
// 切り出す。チャンクの境目で行が切れても取りこぼさない(streaming で食わせられる)。

export const SPEED_COUNTS_PER_KMH = 102.15;
export const TORQUE_NM_PER_COUNT_12BIT = 0.125;

/**
 * 16bit 値の上位 12bit を符号付き整数へ直し、Nm(×0.125)へ換算する。
 * @param {number} u16
 */
export function decodeTorque12BitNm(u16) {
  const raw = u16 >> 4;
  const signed = raw >= 0x800 ? raw - 0x1000 : raw;
  return signed * TORQUE_NM_PER_COUNT_12BIT;
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

/**
 * @param {number} startMs 動画/走行CSV の起点(epoch ms)。t はここからの秒。
 * @returns {{ feed(chunk: string): void, finish(): { speed: Array<{t:number,kmh:number}>, yaw: Array<{t:number,raw:number}>, frontTorque: Array<{t:number,nm:number}>, rearTorque: Array<{t:number,nm:number}> } }}
 */
export function createCanSignalParser(startMs) {
  const speed = [];
  const yaw = [];
  const frontTorque = [];
  const rearTorque = [];
  let carry = "";

  // text[s, e) が 1 行。`timestamp_ms,id,ext,dlc,data`
  function handleLine(text, s, e) {
    const c1 = text.indexOf(",", s);
    if (c1 < 0 || c1 >= e) return;
    // ID は直後の 4 文字(`289,` / `0AB,` / `1D4,` / `1BC,`)で判定する。29bit 拡張 ID(8 桁)は一致しない。
    const isSpeed = text.startsWith("289,", c1 + 1);
    const isYaw = !isSpeed && text.startsWith("0AB,", c1 + 1);
    const isFrontTq = !isSpeed && !isYaw && text.startsWith("1D4,", c1 + 1);
    const isRearTq = !isSpeed && !isYaw && !isFrontTq && text.startsWith("1BC,", c1 + 1);
    if (!isSpeed && !isYaw && !isFrontTq && !isRearTq) return;
    const ts = Number(text.slice(s, c1));
    if (!Number.isFinite(ts)) return;
    const lastComma = text.lastIndexOf(",", e - 1);
    if (lastComma <= c1) return;
    const dataEnd = text.charCodeAt(e - 1) === 13 ? e - 1 : e; // CRLF
    const dataStart = lastComma + 1;
    const t = (ts - startMs) / 1000;
    if (isSpeed || isYaw) {
      if (dataEnd - dataStart < 16) return;
      const hex = text.slice(dataStart + 12, dataStart + 16);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return;
      const u16 = parseInt(hex, 16);
      if (isSpeed) speed.push({ t, kmh: u16 / SPEED_COUNTS_PER_KMH });
      else yaw.push({ t, raw: u16 });
    } else {
      if (dataEnd - dataStart < 8) return;
      const hex = text.slice(dataStart + 4, dataStart + 8);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return;
      const nm = decodeTorque12BitNm(parseInt(hex, 16));
      if (isFrontTq) frontTorque.push({ t, nm });
      else rearTorque.push({ t, nm });
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
      return { speed, yaw, frontTorque, rearTorque };
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
