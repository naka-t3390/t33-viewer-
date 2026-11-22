// Mapbox Vector Tile (MVT) の最小デコーダ。
//
// 軌跡を道路へ吸着させるために必要なのは、1タイルの transportation レイヤから
// 「道路種別(class)」と「線の形」を取り出すことだけ。そのためだけに CDN から
// ライブラリを動的 import すると、**Google の OAuth トークンを持つのと同じオリジンで
// 第三者のコードを実行する**ことになる(index.html が maplibre を integrity 付きで
// 読んでいるのに、こちらだけ SRI も CSP も無い状態になる)。
// 必要な範囲が小さいので、依存ごと無くして自前で読む。
//
// 対応するのは MVT 2.1 のうち、このアプリが使う部分だけ:
//   Tile { repeated Layer layers = 3 }
//   Layer { name=1, features=2, keys=3, values=4, extent=5, version=15 }
//   Feature { id=1, tags=2(packed), type=3, geometry=4(packed) }
//   Value { string=1, float=2, double=3, int64=4, uint64=5, sint64=6, bool=7 }
// 形状は MoveTo(1) / LineTo(2) / ClosePath(7) のコマンド列。座標は zigzag 符号化。
//
// 返す形は @mapbox/vector-tile と同じ { layers: { name: { extent, length, feature(i) } } }
// にしてあるので、呼び出し側はどちらでも差し替えられる(テストでは偽物を注入している)。

const WIRE_VARINT = 0, WIRE_64 = 1, WIRE_BYTES = 2, WIRE_32 = 5;
const DEFAULT_EXTENT = 4096;

/** protobuf のバイト列を前から読む。shift は 32bit を超えるので掛け算で進める。 */
class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf; this.pos = start; this.end = end;
  }
  varint() {
    let result = 0, shift = 1, b;
    do {
      if (this.pos >= this.end) throw new RangeError("MVT: varint がバッファ末尾を越えた");
      b = this.buf[this.pos++];
      result += (b & 0x7f) * shift;
      shift *= 128;
    } while (b >= 0x80);
    return result;
  }
  /** 長さ付きフィールドの範囲 [start, end) を返し、読み位置をその先へ進める。 */
  bytes() {
    const len = this.varint();
    const start = this.pos;
    const end = start + len;
    if (end > this.end) throw new RangeError("MVT: 長さがバッファ末尾を越えた");
    this.pos = end;
    return [start, end];
  }
  utf8(start, end) {
    return new TextDecoder("utf-8").decode(this.buf.subarray(start, end));
  }
  /** 使わないフィールドを型に応じて読み飛ばす。 */
  skip(wire) {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_BYTES) this.bytes();
    else if (wire === WIRE_64) this.pos += 8;
    else if (wire === WIRE_32) this.pos += 4;
    else throw new RangeError(`MVT: 未知のワイヤ型 ${wire}`);
  }
}

/** Value メッセージ。文字列以外はこのアプリでは使わないので数値/真偽だけ拾う。 */
function readValue(buf, start, end) {
  const r = new Reader(buf, start, end);
  let v = null;
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3, wire = tag & 7;
    if (field === 1 && wire === WIRE_BYTES) { const [s, e] = r.bytes(); v = r.utf8(s, e); }
    else if (field === 4 || field === 5) { v = r.varint(); }
    else if (field === 6) { const n = r.varint(); v = (n >>> 1) ^ -(n & 1); } // sint64
    else if (field === 7) { v = r.varint() !== 0; }
    else r.skip(wire);
  }
  return v;
}

/** packed な uint32 列。tags と geometry の両方で使う。 */
function readPacked(buf, start, end) {
  const r = new Reader(buf, start, end);
  const out = [];
  while (r.pos < r.end) out.push(r.varint());
  return out;
}

/**
 * コマンド列を ring の配列へ展開する。
 * 線(LineString)は MoveTo 1点 + LineTo n点 の塊が1本ぶん。
 */
export function decodeGeometry(cmds) {
  const rings = [];
  let ring = null, x = 0, y = 0, i = 0;
  while (i < cmds.length) {
    const cmdInt = cmds[i++];
    const cmd = cmdInt & 0x7, count = cmdInt >> 3;
    if (cmd === 1) { // MoveTo: 新しい線の始まり
      for (let k = 0; k < count; k++) {
        if (i + 1 >= cmds.length) break; // 壊れたタイルで配列の外を読まない
        x += (cmds[i] >>> 1) ^ -(cmds[i] & 1); i++;
        y += (cmds[i] >>> 1) ^ -(cmds[i] & 1); i++;
        if (ring && ring.length) rings.push(ring);
        ring = [{ x, y }];
      }
    } else if (cmd === 2) { // LineTo: 現在の線へ続ける
      for (let k = 0; k < count; k++) {
        if (i + 1 >= cmds.length) break;
        x += (cmds[i] >>> 1) ^ -(cmds[i] & 1); i++;
        y += (cmds[i] >>> 1) ^ -(cmds[i] & 1); i++;
        if (ring) ring.push({ x, y });
      }
    } else if (cmd === 7) { // ClosePath: 面のときだけ現れる
      if (ring && ring.length) ring.push({ x: ring[0].x, y: ring[0].y });
    } else {
      break; // 未知のコマンド: ここで打ち切る(壊れたタイルで無限ループしない)
    }
  }
  if (ring && ring.length) rings.push(ring);
  return rings;
}

function parseLayer(buf, start, end) {
  const r = new Reader(buf, start, end);
  let name = "", extent = DEFAULT_EXTENT;
  const keys = [], values = [], features = [];
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3, wire = tag & 7;
    if (field === 1 && wire === WIRE_BYTES) { const [s, e] = r.bytes(); name = r.utf8(s, e); }
    else if (field === 2 && wire === WIRE_BYTES) { features.push(r.bytes()); }
    else if (field === 3 && wire === WIRE_BYTES) { const [s, e] = r.bytes(); keys.push(r.utf8(s, e)); }
    else if (field === 4 && wire === WIRE_BYTES) { const [s, e] = r.bytes(); values.push(readValue(buf, s, e)); }
    else if (field === 5 && wire === WIRE_VARINT) { extent = r.varint(); }
    else r.skip(wire);
  }
  // keys / values は features より後ろに来ることがあるので、解決は読み終えてから行う。
  const parsed = features.map(([fs, fe]) => {
    const fr = new Reader(buf, fs, fe);
    let tags = [], geom = null, type = 0;
    while (fr.pos < fr.end) {
      const tag = fr.varint();
      const field = tag >> 3, wire = tag & 7;
      if (field === 2 && wire === WIRE_BYTES) { const [s, e] = fr.bytes(); tags = readPacked(buf, s, e); }
      else if (field === 3 && wire === WIRE_VARINT) { type = fr.varint(); }
      else if (field === 4 && wire === WIRE_BYTES) { geom = fr.bytes(); }
      else fr.skip(wire);
    }
    const properties = {};
    for (let k = 0; k + 1 < tags.length; k += 2) {
      const key = keys[tags[k]];
      if (key !== undefined) properties[key] = values[tags[k + 1]];
    }
    // 形状の展開は必要になってから(1タイルに道路以外も大量に入っているため)。
    return { type, properties, loadGeometry: () => (geom ? decodeGeometry(readPacked(buf, geom[0], geom[1])) : []) };
  });
  return { name, extent, length: parsed.length, feature: (i) => parsed[i] };
}

/**
 * タイルを読む。wantedLayers を渡すとその名前のレイヤだけを展開し、
 * ほかは読み飛ばす(z14 のタイルは建物や土地利用で大半が占められている)。
 */
export function decodeTile(buf, wantedLayers = null) {
  const want = wantedLayers ? new Set(wantedLayers) : null;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(bytes);
  const layers = {};
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3, wire = tag & 7;
    if (field === 3 && wire === WIRE_BYTES) {
      const [s, e] = r.bytes();
      const layer = parseLayer(bytes, s, e);
      if (!want || want.has(layer.name)) layers[layer.name] = layer;
    } else r.skip(wire);
  }
  return { layers };
}
