// 走行軌跡を「表示だけ」道路形状へ吸着させる層(段階2)。
//
// 段階1(geo-correct.js)で団子とギザギザは消えるが、GPS のバイアスと車線ぶんの
// 数m のずれが残り、線は道の上に乗らない。ここでは地図が**すでに取得している**
// OpenFreeMap のベクタータイルから道路形状を取り出し、ブラウザ内で吸着する。
//
// サーバーへ送るのはタイル番号 z/x/y だけで、これは地図を表示した時点で同じものを
// 取っている。**走行位置そのものは外へ出さない**(OSRM 等の match API を使わない理由)。
//
// 吸着先は OSM の道路形状であって真の位置ではない。見た目を整えるための層であり、
// **距離や速度の分析に吸着後の座標を使ってはいけない**。元データは読むだけで変更しない。
//
// 方針書: Torque2/docs/1122/走行軌跡マップマッチング方針_2026-11-22.html

import { distanceMeters, segmentDistance } from "./geo.js";

export const MATCH_DEFAULTS = Object.freeze({
  zoom: 14,          // OpenFreeMap の planet タイルは maxzoom=14
  radiusM: 25,       // この距離より遠い道には吸着しない(GPS バイアス + 車線幅の実測から)
  sigmaM: 10,        // 観測モデルの標準偏差。吸着距離の確からしさを測る
  betaM: 15,         // 遷移モデル。吸着後の移動距離が実移動とどれだけ食い違ってよいか
  sameRoadBonus: 0.6,// 連続する点が同じ道に乗っているときの加点(道の乗り換えを渋らせる)
  maxCandidates: 6,  // 1点あたりの候補数の上限(計算量は 点数 × 候補数²)
  gridM: 120,        // 空間索引のセル幅
  maxTiles: 64,      // 取得するタイル枚数の上限(広域セッションでの暴走を防ぐ)
});

/** 吸着先として認める道路種別。歩道・農道・鉄道へ吸われると軌跡が壊れるので除く。 */
export const ROAD_CLASSES = Object.freeze([
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "minor", "unclassified", "service",
]);

const clone = (p) => ({ ...p });
const M_PER_DEG_LAT = 111320;

// --- タイル座標 ---

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/**
 * 軌跡を覆うタイル範囲。y は北が小さいので、北端の緯度から y0 を作る。
 * 枚数が maxTiles を超える広域セッションでは null を返し、呼び出し側が吸着を諦める。
 */
export function tileRangeForTrack(track, z = MATCH_DEFAULTS.zoom, maxTiles = MATCH_DEFAULTS.maxTiles) {
  if (!Array.isArray(track) || track.length === 0) return null;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of track) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const x0 = lonToTileX(minLon, z), x1 = lonToTileX(maxLon, z);
  const y0 = latToTileY(maxLat, z), y1 = latToTileY(minLat, z);
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > maxTiles) return null;
  return { z, x0, x1, y0, y1, count };
}

/** タイル内座標(extent 分割)を経度緯度へ戻す。Web メルカトルの逆変換。 */
export function tilePointToLngLat(x, y, z, px, py, extent) {
  const n = 2 ** z;
  const lon = ((x + px / extent) / n) * 360 - 180;
  const t = Math.PI - 2 * Math.PI * ((y + py / extent) / n);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  return { lon, lat };
}

// --- 空間索引 ---

/**
 * 道路線分をおおよそ gridM 四方のセルへ登録する。
 * 1セッションで線分は数万本になるため、全数走査では間に合わない。
 */
export function buildRoadIndex(segments, gridM = MATCH_DEFAULTS.gridM) {
  const list = Array.isArray(segments) ? segments : [];
  const dLat = gridM / M_PER_DEG_LAT;
  // 経度の刻みは、この地域の緯度で決める(日本国内なら全体を1つの cos で足りる)。
  const lat0 = list.length ? list[0].aLat : 0;
  const dLon = gridM / (M_PER_DEG_LAT * Math.max(0.1, Math.cos((lat0 * Math.PI) / 180)));
  const cells = new Map();
  const key = (i, j) => `${i},${j}`;
  const put = (i, j, seg) => {
    const k = key(i, j);
    let arr = cells.get(k);
    if (!arr) { arr = []; cells.set(k, arr); }
    arr.push(seg);
  };
  for (const s of list) {
    const i0 = Math.floor(Math.min(s.aLat, s.bLat) / dLat), i1 = Math.floor(Math.max(s.aLat, s.bLat) / dLat);
    const j0 = Math.floor(Math.min(s.aLon, s.bLon) / dLon), j1 = Math.floor(Math.max(s.aLon, s.bLon) / dLon);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) put(i, j, s);
  }
  return {
    size: list.length,
    /** (lat, lon) の半径 radiusM 以内にありうる線分。重複は呼び出し側で距離により弾く。 */
    query(lat, lon, radiusM) {
      const ri = Math.ceil(radiusM / M_PER_DEG_LAT / dLat);
      const rj = Math.ceil(radiusM / (M_PER_DEG_LAT * Math.max(0.1, Math.cos((lat * Math.PI) / 180))) / dLon);
      const i0 = Math.floor(lat / dLat), j0 = Math.floor(lon / dLon);
      const seen = new Set(), out = [];
      for (let i = i0 - ri; i <= i0 + ri; i++) {
        for (let j = j0 - rj; j <= j0 + rj; j++) {
          const arr = cells.get(key(i, j));
          if (!arr) continue;
          for (const s of arr) { if (!seen.has(s)) { seen.add(s); out.push(s); } }
        }
      }
      return out;
    },
  };
}

// --- 吸着(HMM + Viterbi) ---

/**
 * 各点を道路へ吸着させた軌跡を返す。**時刻 t はそのまま**なので、
 * 吸着後の線でも「クリック→その地点を通った時刻へシーク」が正しく動く。
 *
 * 点ごとに最寄りの道へ独立に吸着させると、並行する側道や交差道路へ1点だけ飛んで
 * 線が跳ねる。そこで候補列全体の最尤経路を Viterbi で選ぶ。
 *   観測: 吸着距離 d が近いほど良い            → -d² / 2σ²
 *   遷移: 吸着後の移動距離が実移動と合うほど良い → -|Δsnap - Δreal| / β
 *         さらに前の点と同じ道に乗っていれば加点(道を渡るのは相応の理由があるときだけ)
 *
 * どの候補にも届かない点(駐車場や私道)は「吸着しない」候補が選ばれ、元の座標が残る。
 * 線が途切れず、無理な吸着で道を外れることもない。
 */
export function matchTrack(track, index, options = {}) {
  if (!Array.isArray(track)) return [];
  const o = { ...MATCH_DEFAULTS, ...options };
  if (track.length === 0 || !index || index.size === 0) return track.map(clone);

  // 吸着しない選択肢の観測スコア。ちょうど radiusM 離れた道と同じ値にしておくと、
  // 「半径内に道があればそちらを選ぶが、無理なら素通し」になる。
  const noSnapLogP = -(o.radiusM ** 2) / (2 * o.sigmaM ** 2);

  const candidates = track.map((p) => {
    const list = [];
    for (const s of index.query(p.lat, p.lon, o.radiusM)) {
      const { distance, ratio } = segmentDistance(p.lat, p.lon, s.aLat, s.aLon, s.bLat, s.bLon);
      if (distance > o.radiusM) continue;
      list.push({
        roadId: s.roadId,
        lat: s.aLat + ratio * (s.bLat - s.aLat),
        lon: s.aLon + ratio * (s.bLon - s.aLon),
        logP: -(distance ** 2) / (2 * o.sigmaM ** 2),
      });
    }
    list.sort((a, b) => b.logP - a.logP);
    list.length = Math.min(list.length, o.maxCandidates);
    // 末尾に「吸着しない」を必ず置く。候補ゼロの点でも経路が途切れない。
    list.push({ roadId: null, lat: p.lat, lon: p.lon, logP: noSnapLogP });
    return list;
  });

  // Viterbi 前向き
  let prevScores = candidates[0].map((c) => c.logP);
  const back = [];
  for (let i = 1; i < track.length; i++) {
    const realMove = distanceMeters(track[i - 1].lat, track[i - 1].lon, track[i].lat, track[i].lon);
    const cur = candidates[i], prev = candidates[i - 1];
    const scores = new Array(cur.length).fill(-Infinity);
    const ptr = new Array(cur.length).fill(0);
    for (let j = 0; j < cur.length; j++) {
      for (let k = 0; k < prev.length; k++) {
        const snapMove = distanceMeters(prev[k].lat, prev[k].lon, cur[j].lat, cur[j].lon);
        let trans = -Math.abs(snapMove - realMove) / o.betaM;
        if (cur[j].roadId !== null && cur[j].roadId === prev[k].roadId) trans += o.sameRoadBonus;
        const s = prevScores[k] + trans;
        if (s > scores[j]) { scores[j] = s; ptr[j] = k; }
      }
      scores[j] += cur[j].logP;
    }
    prevScores = scores;
    back.push(ptr);
  }

  // 後ろ向きに復元
  let best = 0;
  for (let j = 1; j < prevScores.length; j++) if (prevScores[j] > prevScores[best]) best = j;
  const picked = new Array(track.length);
  picked[track.length - 1] = best;
  for (let i = track.length - 1; i > 0; i--) picked[i - 1] = back[i - 1][picked[i]];

  return track.map((p, i) => {
    const c = candidates[i][picked[i]];
    return { ...p, lat: c.lat, lon: c.lon };
  });
}

/** 吸着できた点の割合。実データでの効き具合を測るために使う。 */
export function matchedRatio(track, matched, minMoveM = 0.5) {
  if (!Array.isArray(track) || !Array.isArray(matched) || track.length !== matched.length) return 0;
  let n = 0;
  for (let i = 0; i < track.length; i++) {
    if (distanceMeters(track[i].lat, track[i].lon, matched[i].lat, matched[i].lon) > minMoveM) n++;
  }
  return track.length ? n / track.length : 0;
}

// --- タイルの取得とデコード(ここだけがネットワークを触る) ---

/** スタイルの vector source から、タイル URL のテンプレートを得る。 */
export async function resolveTilesTemplate(source, fetchImpl = fetch) {
  if (!source) return null;
  if (Array.isArray(source.tiles) && source.tiles.length) return source.tiles[0];
  if (typeof source.url === "string") {
    const res = await fetchImpl(source.url);
    if (!res.ok) return null;
    const tj = await res.json();
    if (Array.isArray(tj.tiles) && tj.tiles.length) return tj.tiles[0];
  }
  return null;
}

/** MVT デコーダ(pbf / @mapbox/vector-tile)。使うときだけ CDN から取りに行く。 */
async function defaultDecoder() {
  const [{ default: Pbf }, { VectorTile }] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm"),
    import("https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm"),
  ]);
  return (buf) => new VectorTile(new Pbf(buf));
}

/**
 * タイルを取得して道路線分の配列にする。
 * 取れなかったタイルは黙って飛ばす(1枚落ちても吸着はできる)。
 */
export async function loadRoadSegments({
  tilesTemplate, track, zoom = MATCH_DEFAULTS.zoom,
  fetchImpl = fetch, decode = null, roadClasses = ROAD_CLASSES, maxTiles = MATCH_DEFAULTS.maxTiles,
}) {
  const range = tileRangeForTrack(track, zoom, maxTiles);
  if (!tilesTemplate || !range) return [];
  const toTile = decode || (await defaultDecoder());
  const classes = new Set(roadClasses);
  const segments = [];
  const jobs = [];
  for (let x = range.x0; x <= range.x1; x++) {
    for (let y = range.y0; y <= range.y1; y++) jobs.push([x, y]);
  }
  await Promise.all(jobs.map(async ([x, y]) => {
    const url = tilesTemplate.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));
    let tile;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return;
      tile = toTile(new Uint8Array(await res.arrayBuffer()));
    } catch (_) { return; } // 1枚落ちても全体は続ける
    const layer = tile && tile.layers && tile.layers.transportation;
    if (!layer) return;
    const extent = layer.extent;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (!classes.has(f.properties.class)) continue;
      const roadId = `${zoom}/${x}/${y}/${i}`;
      for (const ring of f.loadGeometry()) {
        for (let k = 0; k < ring.length - 1; k++) {
          const a = tilePointToLngLat(x, y, zoom, ring[k].x, ring[k].y, extent);
          const b = tilePointToLngLat(x, y, zoom, ring[k + 1].x, ring[k + 1].y, extent);
          segments.push({ aLat: a.lat, aLon: a.lon, bLat: b.lat, bLon: b.lon, roadId });
        }
      }
    }
  }));
  return segments;
}

/**
 * 吸着一式。失敗したら null を返し、呼び出し側は段階1 の軌跡のまま続ける。
 * 画面を壊さないことを最優先にし、ここで例外を外へ投げない。
 */
export async function snapTrackToRoads(track, opts = {}) {
  try {
    if (!Array.isArray(track) || track.length < 2) return null;
    const segments = await loadRoadSegments({ track, ...opts });
    if (!segments.length) return null;
    return matchTrack(track, buildRoadIndex(segments, opts.gridM), opts);
  } catch (_) {
    return null;
  }
}
