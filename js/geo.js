// 地図のヘッドアップ表示に使う地理計算の純粋関数群。
// track = [{ t, lat, lon }] を前提に進行方向(方位角)を求める。
// Leaflet や DOM に依存しないので Node の node:test でそのまま検証できる。

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;
const EARTH_RADIUS_M = 6371000;

// 2点間の方位角(度)。0=北, 90=東, 180=南, 270=西。常に [0,360) に正規化する。
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// 2点間の大圏距離(メートル)。停車判定に使う。
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 同じ1回の通過とみなす区間インデックスの差。半径内の区間が一時的に途切れても
// (大きく膨らんだ迂回など)同じ通過として扱うための幅であり、往復や周回
// (通常は何十区間も離れる)まで畳んでしまわない程度に小さく取る。
const SAME_PASS_GAP = 5;

/** 緯度1度あたりのメートル。[distanceMeters] と同じ地球半径から導く。 */
const M_PER_DEG = (Math.PI * EARTH_RADIUS_M) / 180;

/**
 * 点から線分 A→B への最短距離(m)と、線分上での位置比 [0,1] を返す。
 *
 * 数十メートルの範囲しか見ないので、点を原点とする局所平面へ近似する
 * (経度方向は緯度で縮む分を cos で補正)。
 */
function segmentDistance(pLat, pLon, aLat, aLon, bLat, bLon) {
  const k = Math.cos(toRad(pLat));
  const ax = (aLon - pLon) * k * M_PER_DEG, ay = (aLat - pLat) * M_PER_DEG;
  const bx = (bLon - pLon) * k * M_PER_DEG, by = (bLat - pLat) * M_PER_DEG;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // 長さ0の区間(停車中に同じ座標が続く)は端点そのものとして扱う。
  const ratio = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return { distance: Math.hypot(ax + ratio * dx, ay + ratio * dy), ratio };
}

/**
 * 地図でクリックした地点を「いつ通ったか」(秒)で返す。該当なしは null。
 *
 * **点ではなく区間(隣り合う2点を結ぶ線分)との距離で判定する。** GPS 点の間隔は
 * 実測で中央値22m あり、線の中間は最寄りの点から10m 以上離れる。地図を拡大すると
 * 許容半径(画面上の px 換算)がそれより小さくなるため、点だけを見ていると
 * 「線の上を押しているのに反応しない」ことになる(2026-08-15 に実際に起きた)。
 * 時刻は区間上の位置で内挿するので、点と点の中間を押せばその中間の時刻になる。
 *
 * radiusMeters 以内の区間を集め、インデックスが近い塊を1回の通過としてまとめる。
 * 塊ごとに最もクリック点へ近い位置を代表とし、代表が複数あるとき(往復・周回で同じ
 * 地点を何度も通った場合)は currentT に時間的に最も近い通過を選ぶ ―― いま見ている
 * 場面の近くへ飛ぶのが、地図をなぞって前後を見返す使い方に合うため。
 */
export function nearestPassTime(track, point, radiusMeters, currentT) {
  if (!Array.isArray(track) || track.length === 0 || !point) return null;
  if (track.length === 1) {
    const d = distanceMeters(track[0].lat, track[0].lon, point.lat, point.lon);
    return d <= radiusMeters ? track[0].t : null;
  }
  let best = null;     // 採用中の通過の時刻
  let passTime = null; // いま見ている通過の代表時刻
  let passDist = Infinity;
  let lastHit = -Infinity;
  // 通過を1つ閉じるたびに、採用中の代表と currentT への近さで比べ直す。
  const closePass = () => {
    if (passTime === null) return;
    if (best === null || Math.abs(passTime - currentT) < Math.abs(best - currentT)) best = passTime;
    passTime = null;
    passDist = Infinity;
  };
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i], b = track[i + 1];
    const { distance, ratio } = segmentDistance(point.lat, point.lon, a.lat, a.lon, b.lat, b.lon);
    if (distance > radiusMeters) continue;
    if (i - lastHit > SAME_PASS_GAP) closePass(); // 前の塊から離れた=別の通過
    lastHit = i;
    if (distance < passDist) { passDist = distance; passTime = a.t + ratio * (b.t - a.t); }
  }
  closePass();
  return best;
}

// track[index] 時点の進行方向(度)。index から前方(なければ後方)へ minMoveMeters 以上
// 離れた最初の点を探して bearing を算出する。停車中(前後とも閾値未満)は null を返し、
// 呼び出し側が直前の向きを保持できるようにする。
export function headingAt(track, index, minMoveMeters = 5) {
  if (!Array.isArray(track) || index < 0 || index >= track.length) return null;
  const here = track[index];
  // 前方: index より先で最初に閾値を超えた点への方位(進行方向そのもの)。
  for (let j = index + 1; j < track.length; j++) {
    if (distanceMeters(here.lat, here.lon, track[j].lat, track[j].lon) >= minMoveMeters) {
      return bearingDeg(here.lat, here.lon, track[j].lat, track[j].lon);
    }
  }
  // 前方に十分な移動がなければ、後方の点 → 現在点の方位で代用する(末尾・微速時)。
  for (let i = index - 1; i >= 0; i--) {
    if (distanceMeters(track[i].lat, track[i].lon, here.lat, here.lon) >= minMoveMeters) {
      return bearingDeg(track[i].lat, track[i].lon, here.lat, here.lon);
    }
  }
  return null;
}
