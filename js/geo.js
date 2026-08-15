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

// 同じ1回の通過とみなすインデックス差。GPS が数点だけ大きく飛ぶと、半径内の点が
// 途切れて「2回通った」ように見える。その揺らぎを吸収する幅であって、往復や周回
// (通常は何十点も離れる)まで畳んでしまわない程度に小さく取る。
const SAME_PASS_GAP = 5;

/**
 * 地図でクリックした地点を「いつ通ったか」を返す。戻り値は track のインデックス、
 * 該当なしは -1。
 *
 * radiusMeters 以内の点を集め、インデックスが近い塊を1回の通過としてまとめる。
 * 塊ごとに最もクリック点へ近い点を代表とし、代表が複数あるとき(往復・周回で同じ
 * 地点を何度も通った場合)は currentT に時間的に最も近い通過を選ぶ ―― いま見ている
 * 場面の近くへ飛ぶのが、地図をなぞって前後を見返す使い方に合うため。
 */
export function nearestPassIndex(track, point, radiusMeters, currentT) {
  if (!Array.isArray(track) || track.length === 0 || !point) return -1;
  let best = -1;      // 採用中の通過の代表点
  let passIndex = -1; // いま見ている通過の代表点
  let passDist = Infinity;
  let lastHit = -Infinity;
  // 通過を1つ閉じるたびに、採用中の代表と currentT への近さで比べ直す。
  const closePass = () => {
    if (passIndex < 0) return;
    const better = best < 0 ||
      Math.abs(track[passIndex].t - currentT) < Math.abs(track[best].t - currentT);
    if (better) best = passIndex;
    passIndex = -1;
    passDist = Infinity;
  };
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    const d = distanceMeters(p.lat, p.lon, point.lat, point.lon);
    if (d > radiusMeters) continue;
    if (i - lastHit > SAME_PASS_GAP) closePass(); // 前の塊から離れた=別の通過
    lastHit = i;
    if (d < passDist) { passDist = d; passIndex = i; }
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
