import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTile, decodeGeometry } from "../js/mvt.js";

// MVT の最小エンコーダ(テストでタイルを組み立てるためだけのもの)。
// 形式は mvt.js の冒頭コメントにある通り Tile { layers=3 } /
// Layer { name=1, features=2, keys=3, values=4, extent=5, version=15 } /
// Feature { id=1, tags=2, type=3, geometry=4 }。

function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
const fieldTag = (num, wire) => varint((num << 3) | wire);
const bytesField = (num, bytes) => [...fieldTag(num, 2), ...varint(bytes.length), ...bytes];
const varintField = (num, n) => [...fieldTag(num, 0), ...varint(n)];
const packedVarints = (num, arr) => bytesField(num, arr.flatMap(varint));
const strBytes = (s) => [...new TextEncoder().encode(s)];

/** transportation レイヤに LineString 1本(class=primary)だけ入ったタイルを作る。 */
function buildTile() {
  // (100,100) → (300,100) → (300,300)。zigzag: 100→200, 200→400, 0→0。
  const geometry = packedVarints(4, [9, 200, 200, 18, 400, 0, 0, 400]);
  const feature = [
    ...varintField(1, 42),
    ...packedVarints(2, [0, 0]), // keys[0]="class" → values[0]="primary"
    ...varintField(3, 2),        // type=2: LineString
    ...geometry,
  ];
  const value = bytesField(1, strBytes("primary"));
  const layer = [
    ...varintField(15, 2),
    ...bytesField(1, strBytes("transportation")),
    ...bytesField(2, feature),
    ...bytesField(3, strBytes("class")),
    ...bytesField(4, value),
    ...varintField(5, 4096),
  ];
  // 読む側の検証用に、要らないレイヤ(water)も1つ足しておく。
  const water = [
    ...varintField(15, 2),
    ...bytesField(1, strBytes("water")),
    ...varintField(5, 4096),
  ];
  return new Uint8Array([...bytesField(3, layer), ...bytesField(3, water)]);
}

test("decodeTile: レイヤ名・extent・件数が読める", () => {
  const tile = decodeTile(buildTile());
  const layer = tile.layers.transportation;
  assert.ok(layer);
  assert.equal(layer.extent, 4096);
  assert.equal(layer.length, 1);
});

test("decodeTile: プロパティと形状が @mapbox/vector-tile と同じ形で返る", () => {
  const f = decodeTile(buildTile()).layers.transportation.feature(0);
  assert.equal(f.type, 2);
  assert.deepEqual(f.properties, { class: "primary" });
  assert.deepEqual(f.loadGeometry(), [[
    { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 },
  ]]);
});

test("decodeTile: wantedLayers を渡すとそのレイヤだけ展開する", () => {
  const tile = decodeTile(buildTile(), ["transportation"]);
  assert.deepEqual(Object.keys(tile.layers), ["transportation"]);
  const all = decodeTile(buildTile());
  assert.deepEqual(Object.keys(all.layers).sort(), ["transportation", "water"]);
});

test("decodeGeometry: ClosePath は始点を足して閉じる", () => {
  // (0,0) → (10,0) のあと ClosePath。zigzag: 10→20。
  const rings = decodeGeometry([9, 0, 0, 18, 20, 0, (7 | (1 << 3))]);
  assert.deepEqual(rings, [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }]]);
});

test("decodeGeometry: 未知のコマンドや途中で切れた列でも止まらず例外を出さない", () => {
  assert.deepEqual(decodeGeometry([3]), []);          // 未知のコマンドで打ち切り
  assert.deepEqual(decodeGeometry([9, 200]), []);     // MoveTo の途中で欠けた列
  assert.deepEqual(decodeGeometry([]), []);
});
