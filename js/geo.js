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
