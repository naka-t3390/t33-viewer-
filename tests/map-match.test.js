import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_DEFAULTS, lonToTileX, latToTileY, tileRangeForTrack, tilePointToLngLat,
  buildRoadIndex, matchTrack, matchedRatio, resolveTilesTemplate, loadRoadSegments,
} from "../js/map-match.js";
import { distanceMeters, nearestPassTime } from "../js/geo.js";

// 緯度35°: 緯度0.00001度 ≈ 1.11m、経度0.00001度 ≈ 0.91m。

// --- タイル座標 ---

test("lonToTileX / latToTileY: z0 は全世界が1枚", () => {
  assert.equal(lonToTileX(139.0, 0), 0);
  assert.equal(latToTileY(35.0, 0), 0);
});

test("lonToTileX: 本初子午線と日付変更線の境目", () => {
  assert.equal(lonToTileX(-180, 1), 0);
  assert.equal(lonToTileX(0.0001, 1), 1);
});

test("latToTileY: 北の方がタイル y は小さい", () => {
  assert.ok(latToTileY(45.0, 14) < latToTileY(35.0, 14));
});

test("tileRangeForTrack: 近接した軌跡は1〜数枚に収まる", () => {
  const track = [
    { t: 0, lat: 35.70, lon: 140.00 },
    { t: 1, lat: 35.71, lon: 140.01 },
  ];
  const r = tileRangeForTrack(track, 14, 64);
  assert.ok(r && r.count >= 1 && r.count <= 4, JSON.stringify(r));
  assert.ok(r.y0 <= r.y1 && r.x0 <= r.x1);
});

test("tileRangeForTrack: 広すぎる範囲は null(吸着を諦める)", () => {
  const track = [
    { t: 0, lat: 35.0, lon: 135.0 },
    { t: 1, lat: 43.0, lon: 145.0 }, // 日本縦断。z14 では数万枚になる
  ];
  assert.equal(tileRangeForTrack(track, 14, 64), null);
});

test("tileRangeForTrack: 空・非配列は null", () => {
  assert.equal(tileRangeForTrack([], 14, 64), null);
  assert.equal(tileRangeForTrack(null, 14, 64), null);
});

test("tilePointToLngLat: タイルの左上は、そのタイルの北西角に戻る", () => {
  const z = 14, x = lonToTileX(140.0, z), y = latToTileY(35.7, z);
  const nw = tilePointToLngLat(x, y, z, 0, 0, 4096);
  // 北西角なので、元の点より西かつ北。ずれは z14 のタイル1枚(約2.4km)以内。
  assert.ok(nw.lon <= 140.0 && nw.lat >= 35.7, JSON.stringify(nw));
  assert.ok(distanceMeters(nw.lat, nw.lon, 35.7, 140.0) < 3500, JSON.stringify(nw));
});

test("tilePointToLngLat: 右下(extent)は隣のタイルの左上と一致する", () => {
  const z = 14, x = 1000, y = 2000;
  const br = tilePointToLngLat(x, y, z, 4096, 4096, 4096);
  const nextNw = tilePointToLngLat(x + 1, y + 1, z, 0, 0, 4096);
  assert.ok(Math.abs(br.lon - nextNw.lon) < 1e-9);
  assert.ok(Math.abs(br.lat - nextNw.lat) < 1e-9);
});

// --- 空間索引 ---

// 東西にまっすぐ伸びる道路(緯度35.0)を 20m 刻みの線分で作る。
const roadEast = (lat, roadId, n = 40) =>
  Array.from({ length: n }, (_, i) => ({
    aLat: lat, aLon: 139.0 + i * 0.00022,
    bLat: lat, bLon: 139.0 + (i + 1) * 0.00022,
    roadId,
  }));

test("buildRoadIndex: 半径内の線分が漏れなく返る", () => {
  const segs = roadEast(35.0, "r1");
  const idx = buildRoadIndex(segs, 120);
  const hit = idx.query(35.0, 139.0022, 30);
  assert.ok(hit.length > 0);
  // 全数走査の答えと取りこぼしが無いことを突き合わせる。
  const brute = segs.filter((s) =>
    Math.min(distanceMeters(35.0, 139.0022, s.aLat, s.aLon),
             distanceMeters(35.0, 139.0022, s.bLat, s.bLon)) <= 30);
  for (const s of brute) assert.ok(hit.includes(s), "半径内の線分が索引から漏れた");
});

test("buildRoadIndex: 同じ線分を二重に返さない", () => {
  const idx = buildRoadIndex(roadEast(35.0, "r1"), 120);
  const hit = idx.query(35.0, 139.001, 50);
  assert.equal(hit.length, new Set(hit).size);
});

test("buildRoadIndex: 空でも query が落ちない", () => {
  const idx = buildRoadIndex([], 120);
  assert.equal(idx.size, 0);
  assert.deepEqual(idx.query(35.0, 139.0, 25), []);
});

// --- 吸着 ---

// 道路の10m 北を、道と平行に走った軌跡。
const parallelTrack = (offsetLat, n = 12) =>
  Array.from({ length: n }, (_, i) => ({
    t: i, lat: 35.0 + offsetLat, lon: 139.0005 + i * 0.00022,
  }));

test("matchTrack: 道路の脇10m を走った点列が道路上に乗る", () => {
  const idx = buildRoadIndex(roadEast(35.0, "r1"), 120);
  const track = parallelTrack(0.00009); // 約10m 北
  const out = matchTrack(track, idx);
  for (const p of out) {
    assert.ok(Math.abs(p.lat - 35.0) < 1e-6, `道路に乗っていない lat=${p.lat}`);
  }
});

test("matchTrack: 時刻と点数は変わらない", () => {
  const idx = buildRoadIndex(roadEast(35.0, "r1"), 120);
  const track = parallelTrack(0.00009);
  const out = matchTrack(track, idx);
  assert.equal(out.length, track.length);
  for (let i = 0; i < track.length; i++) assert.equal(out[i].t, track[i].t);
});

test("matchTrack: 入力の配列と要素を書き換えない", () => {
  const idx = buildRoadIndex(roadEast(35.0, "r1"), 120);
  const track = parallelTrack(0.00009);
  const before = JSON.stringify(track);
  matchTrack(track, idx);
  assert.equal(JSON.stringify(track), before);
});

test("matchTrack: 半径より遠い点は吸着せず元の座標のまま", () => {
  const idx = buildRoadIndex(roadEast(35.0, "r1"), 120);
  const track = parallelTrack(0.00045); // 約50m 北。radiusM=25 の外
  const out = matchTrack(track, idx);
  for (let i = 0; i < track.length; i++) {
    assert.equal(out[i].lat, track[i].lat);
    assert.equal(out[i].lon, track[i].lon);
  }
});

test("matchTrack: 道路データが無ければ素通し", () => {
  const track = parallelTrack(0.00009);
  const out = matchTrack(track, buildRoadIndex([], 120));
  assert.deepEqual(out, track);
  assert.deepEqual(matchTrack(track, null), track);
  assert.deepEqual(matchTrack([], buildRoadIndex(roadEast(35.0, "r1"), 120)), []);
});

// 並行する2本の道(20m 離れ)。本線だけを走ったのに、1点の測位誤差で
// 側道の方が近くなる — ここで側道へ飛ぶと線がギザギザに跳ねる。
test("matchTrack: 1点が側道寄りにぶれても、そこだけ別の道へ飛ばない", () => {
  const main = roadEast(35.0, "main");
  const side = roadEast(35.00018, "side"); // 約20m 北
  const idx = buildRoadIndex([...main, ...side], 120);
  const track = parallelTrack(0.00002);    // 本線の 2m 北を走行
  track[5] = { t: 5, lat: 35.00014, lon: track[5].lon }; // 1点だけ側道寄り(約15m北)へぶれる
  const out = matchTrack(track, idx);
  for (const p of out) {
    assert.ok(Math.abs(p.lat - 35.0) < 1e-6, `側道へ飛んだ lat=${p.lat}`);
  }
});

test("matchTrack: 最近傍だけで決めると側道へ飛ぶ条件であることを確かめる", () => {
  // 上のテストが「Viterbi のおかげ」であることの裏取り。
  // ぶれた点だけを見ると側道(35.00018)の方が本線(35.0)より近い。
  const p = { lat: 35.00014, lon: 139.001 };
  const toMain = distanceMeters(p.lat, p.lon, 35.0, 139.001);
  const toSide = distanceMeters(p.lat, p.lon, 35.00018, 139.001);
  assert.ok(toSide < toMain, `side=${toSide} main=${toMain}`);
});

test("matchTrack: 交差点で曲がれば曲がった先の道へ乗り換える", () => {
  // 東西の道(緯度35.0)と、そこから北へ伸びる道(経度139.0022)。
  const ew = roadEast(35.0, "ew");
  const ns = Array.from({ length: 20 }, (_, i) => ({
    aLat: 35.0 + i * 0.00018, aLon: 139.0022,
    bLat: 35.0 + (i + 1) * 0.00018, bLon: 139.0022,
    roadId: "ns",
  }));
  const idx = buildRoadIndex([...ew, ...ns], 120);
  // 東へ進んで交差点で北へ折れる軌跡(いずれも道から数m ずれている)
  const track = [];
  for (let i = 0; i < 8; i++) track.push({ t: i, lat: 35.00004, lon: 139.0000 + i * 0.00028 });
  for (let i = 1; i <= 8; i++) track.push({ t: 7 + i, lat: 35.0 + i * 0.00018, lon: 139.00224 });
  const out = matchTrack(track, idx);
  // 前半は東西の道(緯度35.0)、後半は南北の道(経度139.0022)に乗る。
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(out[i].lat - 35.0) < 1e-6, `前半 i=${i} lat=${out[i].lat}`);
  for (let i = 8; i < out.length; i++) assert.ok(Math.abs(out[i].lon - 139.0022) < 1e-6, `後半 i=${i} lon=${out[i].lon}`);
});

test("matchTrack: 吸着後の軌跡でもクリック→シークが同じ時刻を指す", () => {
  const idx = buildRoadIndex(roadEast(35.0, "r1"), 120);
  const track = parallelTrack(0.00009);
  const out = matchTrack(track, idx);
  const click = { lat: track[6].lat, lon: track[6].lon };
  const tRaw = nearestPassTime(track, click, 30, 0);
  const tSnap = nearestPassTime(out, click, 30, 0);
  assert.ok(tRaw !== null && tSnap !== null);
  assert.ok(Math.abs(tRaw - tSnap) < 1, `raw=${tRaw} snap=${tSnap}`);
});

test("matchedRatio: 吸着で動いた点の割合を返す", () => {
  const idx = buildRoadIndex(roadEast(35.0, "r1"), 120);
  const track = parallelTrack(0.00009);
  assert.equal(matchedRatio(track, matchTrack(track, idx)), 1);
  assert.equal(matchedRatio(track, track), 0);
  assert.equal(matchedRatio(track, []), 0); // 長さ違いは0
});

test("MATCH_DEFAULTS: 既定値は書き換えられない", () => {
  assert.throws(() => { "use strict"; MATCH_DEFAULTS.radiusM = 999; });
});

// --- タイル取得(ネットワークは偽物を注入する) ---

test("resolveTilesTemplate: tiles があればそれを使い、fetch しない", async () => {
  const never = () => { throw new Error("fetch してはいけない"); };
  const tpl = await resolveTilesTemplate({ tiles: ["https://x/{z}/{x}/{y}.pbf"] }, never);
  assert.equal(tpl, "https://x/{z}/{x}/{y}.pbf");
});

test("resolveTilesTemplate: url しか無ければ TileJSON を読む", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ tiles: ["https://y/{z}/{x}/{y}.pbf"] }) });
  assert.equal(await resolveTilesTemplate({ url: "https://tj" }, fake), "https://y/{z}/{x}/{y}.pbf");
});

test("resolveTilesTemplate: source が無い / TileJSON が落ちたら null", async () => {
  assert.equal(await resolveTilesTemplate(null, async () => {}), null);
  assert.equal(await resolveTilesTemplate({ url: "https://tj" }, async () => ({ ok: false })), null);
});

test("loadRoadSegments: transportation の線分だけを拾い、歩道などは捨てる", async () => {
  const track = [{ t: 0, lat: 35.7, lon: 140.0 }, { t: 1, lat: 35.7005, lon: 140.0005 }];
  const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  // タイル内座標の形状を1本ずつ持つ 2 feature。片方は path なので捨てられる。
  const decode = () => ({
    layers: {
      transportation: {
        extent: 4096, length: 2,
        feature: (i) => ({
          properties: { class: i === 0 ? "minor" : "path" },
          loadGeometry: () => [[{ x: 0, y: 0 }, { x: 2048, y: 2048 }]],
        }),
      },
    },
  });
  const segs = await loadRoadSegments({ tilesTemplate: "https://t/{z}/{x}/{y}.pbf", track, fetchImpl: fakeFetch, decode });
  assert.ok(segs.length > 0);
  assert.ok(segs.every((s) => s.roadId.endsWith("/0")), "path の feature を拾ってしまった");
});

test("loadRoadSegments: タイルが落ちても例外にせず、取れた分で続ける", async () => {
  const track = [{ t: 0, lat: 35.7, lon: 140.0 }, { t: 1, lat: 35.7005, lon: 140.0005 }];
  const dead = async () => { throw new Error("network down"); };
  const segs = await loadRoadSegments({ tilesTemplate: "https://t/{z}/{x}/{y}.pbf", track, fetchImpl: dead, decode: () => ({}) });
  assert.deepEqual(segs, []);
});

test("loadRoadSegments: テンプレートが無い / 範囲が広すぎるときは空", async () => {
  const track = [{ t: 0, lat: 35.7, lon: 140.0 }, { t: 1, lat: 43.0, lon: 145.0 }];
  assert.deepEqual(await loadRoadSegments({ tilesTemplate: null, track, decode: () => ({}) }), []);
  assert.deepEqual(await loadRoadSegments({ tilesTemplate: "https://t/{z}/{x}/{y}.pbf", track, fetchImpl: async () => ({ ok: false }), decode: () => ({}) }), []);
});
