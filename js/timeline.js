// グラフ横軸の時間ドメイン（全体タイムライン上の秒）を決める純粋ロジック。
//
// 以前は横軸を CSV(OBD ログ)の範囲だけで決めていた。OBD が動画より早く止まった
// セッション(例: 2026-08-14 15:31 は動画 約122分に対し CSV は 101:46 で停止)では
// 軸が CSV 末尾で切れ、再生位置カーソルが軸の外へ出てしまう。
// 軸は「動画全体」を基準にし、CSV/KML がそれより長い場合だけ更に伸ばす。

// セグメント1本の既定長（端末側の分割間隔＝10分）。
export const DEFAULT_SEGMENT_SEC = 600;

// Drive の size は文字列で来るので数値化する。null/undefined/"" は
// Number() が 0 になってしまうため、値なしとして先に弾く。
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function median(values) {
  if (values.length === 0) return null;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 動画全体の終端（秒）を求める。
 *
 * 最終セグメントの長さは再生して loadedmetadata が来るまで判らないので、
 * 判っていれば実測を使い、判らない間はファイルサイズ比から見積もる
 * （満杯セグメントに対する比率 × 1本ぶんの長さ）。サイズも無ければ 1本ぶんを足す。
 *
 * @param {Array<{baseOffsetSec:number|null, size?:number|string}>} segments 再生順のセグメント
 * @param {number|null} knownEndSec loadedmetadata で判った「base + duration」の最大値
 * @returns {number|null} 動画が無ければ null
 */
export function estimateVideoEndSec(segments, knownEndSec = null) {
  const list = Array.isArray(segments) ? segments : [];
  const known = num(knownEndSec);
  const bases = list.map((s) => num(s && s.baseOffsetSec)).filter((v) => v !== null);
  if (bases.length === 0) return known;

  const lastBase = Math.max(...bases);
  // 最終セグメントの実測終端が判っていれば、それが正解（見積もりで上書きしない）。
  if (known !== null && known > lastBase) return known;

  // セグメント間隔から1本ぶんの長さを得る（メタが等間隔でない場合に備えて中央値）。
  const sorted = [...bases].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1];
    if (g > 0) gaps.push(g);
  }
  const segSec = median(gaps) ?? DEFAULT_SEGMENT_SEC;

  // 最終セグメントの長さをサイズ比で見積もる（満杯側の基準は他セグメントの中央値）。
  let tail = segSec;
  const lastSeg = list.find((s) => num(s && s.baseOffsetSec) === lastBase);
  const lastSize = num(lastSeg && lastSeg.size);
  const fullSizes = list
    .filter((s) => s !== lastSeg)
    .map((s) => num(s && s.size))
    .filter((v) => v !== null && v > 0);
  const fullSize = median(fullSizes);
  if (lastSize !== null && lastSize > 0 && fullSize) {
    tail = segSec * Math.min(1, lastSize / fullSize);
  }
  return Math.max(lastBase + tail, known ?? -Infinity);
}

/**
 * グラフ横軸のドメインを決める。動画全体を必ず覆い、CSV/KML がそれより
 * 外側まであるときだけ更に広げる（データを切り落とさない）。
 *
 * @param {{samples:Array<{t:number}>, track:Array<{t:number}>,
 *          segments:Array<{baseOffsetSec:number|null,size?:number|string}>,
 *          knownEndSec:number|null}} input
 * @returns {{tMin:number, tMax:number}}
 */
export function computeTimeDomain({ samples = [], track = [], segments = [], knownEndSec = null } = {}) {
  const starts = [];
  const ends = [];
  const push = (series) => {
    const a = Array.isArray(series) ? series : [];
    if (a.length === 0) return;
    const first = num(a[0] && a[0].t);
    const last = num(a[a.length - 1] && a[a.length - 1].t);
    if (first !== null) starts.push(first);
    if (last !== null) ends.push(last);
  };
  push(samples);
  push(track);

  const videoEnd = estimateVideoEndSec(segments, knownEndSec);
  if (videoEnd !== null) {
    starts.push(0); // 動画がある限り軸は動画開始(0秒)から
    ends.push(videoEnd);
  }

  const tMin = starts.length ? Math.min(...starts) : 0;
  let tMax = ends.length ? Math.max(...ends) : 1;
  if (!(tMax > tMin)) tMax = tMin + 1; // 幅0は割り算で壊れるので最低1秒
  return { tMin, tMax };
}
