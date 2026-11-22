// 走行軌跡の「表示だけ」を整える補正。
//
// GPS の測位誤差で、軌跡は道から数m〜十数m ずれ、停車中は同じ場所で微小に
// 往復して団子状の塊になる。ここはその見た目だけを直す層であり、
// **元データ(KML / CSV の座標)は読むだけで一切書き換えない**。分析の原本だからである。
// viewer.js が描画の直前にこのモジュールへ通し、トグルで生データへ戻せる。
//
// DOM にも地図ライブラリにも依存しない純関数なので、Node の node:test で検証できる。
//
// 補正は3段を直列に通す:
//   1. collapseStops  … 停車中の塊を1点へ畳む(団子の除去)
//   2. smoothTrack    … 両隣と重み付き平均を取り、測位ノイズのギザギザを均す
//   3. simplifyTrack  … Douglas-Peucker で直線部の無駄な揺れを落とす(角は残す)
//
// どの段でも各点は **元の時刻 t を保つ**。これにより、補正後の線を使っても
// 「軌跡をクリック → その地点を通った時刻へ動画をシーク」が正しく動く。

import { distanceMeters, segmentDistance } from "./geo.js";

/** 既定のしきい値。実測(2026-11-02 の走行, 1Hz・1564点)を基に決めた。 */
export const TRACK_FIX_DEFAULTS = Object.freeze({
  // 停車とみなす半径(m)。この走行では隣接点の移動が 2m 未満の点が全体の 42% を占める。
  stopRadiusM: 3,
  // 平滑化で中央の点に残す重み。両隣に (1 - これ)/2 ずつ配る。
  // 1/3 ずつの単純移動平均より角の削れが小さい。
  smoothCenterWeight: 0.5,
  // Douglas-Peucker の許容誤差(m)。これ以内の膨らみは直線とみなして落とす。
  simplifyToleranceM: 1.5,
  // 前後の点との時間差がこれ以上なら、直線上でも点を残す(停車の前後を失わない)。
  timeAnchorSec: 5,
});

const clone = (p) => ({ ...p });

/**
 * 停車中の塊を1点へ畳む。
 *
 * 先頭の点を基準(アンカー)とし、そこから radiusM 以内に留まる連続点を1つの塊とする。
 * 代表点の座標は塊の重心(散らばりの中心)、**時刻は塊の先頭の t**(= その場所へ着いた時刻)。
 * クリックしたときに「停まり始めた時刻」へ飛ぶほうが、停車シーンを見返す使い方に合う。
 *
 * アンカーは塊の間で動かさないので、徐行(渋滞のノロノロ)は radiusM ごとに
 * 1点ずつ残り、道の形は保たれる。
 */
export function collapseStops(track, radiusM = TRACK_FIX_DEFAULTS.stopRadiusM) {
  if (!Array.isArray(track) || track.length === 0) return [];
  if (!(radiusM > 0)) return track.map(clone);
  const out = [];
  let i = 0;
  while (i < track.length) {
    const anchor = track[i];
    let j = i + 1;
    while (j < track.length &&
           distanceMeters(anchor.lat, anchor.lon, track[j].lat, track[j].lon) <= radiusM) j++;
    const n = j - i;
    if (n === 1) {
      out.push(clone(anchor));
    } else {
      let lat = 0, lon = 0;
      for (let k = i; k < j; k++) { lat += track[k].lat; lon += track[k].lon; }
      out.push({ ...anchor, lat: lat / n, lon: lon / n }); // t は anchor のものを引き継ぐ
    }
    i = j;
  }
  return out;
}

/**
 * 両隣との重み付き平均で測位ノイズを均す。両端の点は動かさない(軌跡の始終点がずれないように)。
 *
 * 平均の元は **補正前の隣接点**(出力ではなく入力を読む)。出力を参照すると
 * 平滑化が連鎖して軌跡全体が縮んでしまう。
 */
export function smoothTrack(track, centerWeight = TRACK_FIX_DEFAULTS.smoothCenterWeight) {
  if (!Array.isArray(track)) return [];
  if (track.length < 3) return track.map(clone);
  if (!(centerWeight >= 0 && centerWeight <= 1)) return track.map(clone);
  const side = (1 - centerWeight) / 2;
  const out = [clone(track[0])];
  for (let i = 1; i < track.length - 1; i++) {
    const a = track[i - 1], b = track[i], c = track[i + 1];
    out.push({
      ...b,
      lat: a.lat * side + b.lat * centerWeight + c.lat * side,
      lon: a.lon * side + b.lon * centerWeight + c.lon * side,
    });
  }
  out.push(clone(track[track.length - 1]));
  return out;
}

/**
 * Douglas-Peucker で、線の形をほとんど変えない点を落とす。
 *
 * 線からの外れ具合は geo.js の segmentDistance(線分までの距離)で測る。
 * 無限直線ではなく線分で測るので、折り返し(往復)でも点を消しすぎない。
 *
 * ただし **前後と時間が大きく空いている点は必ず残す**。停車で畳まれた点が
 * 「直線上だから」と消えると、その区間の時刻が停車時間ぶん線形に引き伸ばされ、
 * クリック→シークが停車の途中を指してしまうため。
 *
 * 再帰ではなく明示スタックで回す(点数が多い走行でもスタックを深くしない)。
 */
export function simplifyTrack(track, toleranceM = TRACK_FIX_DEFAULTS.simplifyToleranceM,
                              timeAnchorSec = TRACK_FIX_DEFAULTS.timeAnchorSec) {
  if (!Array.isArray(track)) return [];
  if (track.length <= 2 || !(toleranceM > 0)) return track.map(clone);
  const n = track.length;
  const keep = new Array(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  // 時間が飛んでいる点(停車の前後)は無条件で残す。
  if (timeAnchorSec > 0) {
    for (let i = 1; i < n - 1; i++) {
      if (track[i + 1].t - track[i].t >= timeAnchorSec ||
          track[i].t - track[i - 1].t >= timeAnchorSec) keep[i] = true;
    }
  }
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    let best = -1, bestD = -1;
    for (let i = s + 1; i < e; i++) {
      const { distance } = segmentDistance(
        track[i].lat, track[i].lon, track[s].lat, track[s].lon, track[e].lat, track[e].lon);
      if (distance > bestD) { bestD = distance; best = i; }
    }
    if (bestD > toleranceM) {
      keep[best] = true;
      stack.push([s, best], [best, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(clone(track[i]));
  return out;
}

/**
 * 表示用の軌跡を作る。入力の配列も要素も書き換えず、新しい配列を返す。
 * 点が2つ以下のセッションは補正しても意味がないのでそのまま複製して返す。
 */
export function correctTrack(track, options = {}) {
  if (!Array.isArray(track)) return [];
  if (track.length <= 2) return track.map(clone);
  const o = { ...TRACK_FIX_DEFAULTS, ...options };
  return simplifyTrack(
    smoothTrack(collapseStops(track, o.stopRadiusM), o.smoothCenterWeight),
    o.simplifyToleranceM,
    o.timeAnchorSec,
  );
}

// --- 軌跡の表示モードをブラウザに覚えさせる ---
// theme.js と同じ作法: localStorage を try/catch で包み、読めない環境でも落とさない。

export const TRACK_FIX_STORAGE_KEY = "t33_viewer_track_fix";

/**
 * 表示モードは3つ。ボタンを押すとこの順に巡る。
 *   match … 道路形状へ吸着(段階1 + 段階2)。既定
 *   fix   … 段階1 の補正のみ
 *   raw   … 生データ
 */
export const TRACK_MODES = Object.freeze(["match", "fix", "raw"]);
export const DEFAULT_TRACK_MODE = "match";

/** 次のモード。巡回の順序はここだけが決める。知らない値は既定(先頭)へ戻す。 */
export function nextTrackMode(mode) {
  const i = TRACK_MODES.indexOf(mode);
  return TRACK_MODES[(i < 0 ? 0 : i + 1) % TRACK_MODES.length];
}

/**
 * 保存された表示モード。未設定・読めない場合は既定の match。
 *
 * 段階2 を入れる前は "on"(補正あり) / "off"(生データ) の2値だった。
 * すでに保存されている人の設定を壊さないよう、ここで読み替える。
 * "on" は「補正はするが吸着は知らない」ときの選択なので fix に対応させる。
 */
export function readTrackMode(storage) {
  try {
    const v = storage && storage.getItem(TRACK_FIX_STORAGE_KEY);
    if (TRACK_MODES.includes(v)) return v;
    if (v === "on") return "fix";
    if (v === "off") return "raw";
  } catch (_) { /* プライベートモード等では既定に落とす */ }
  return DEFAULT_TRACK_MODE;
}

/** 設定を保存する。書けない環境では黙って諦める(表示は切り替わったままでよい)。 */
export function writeTrackMode(storage, mode) {
  try {
    if (storage) storage.setItem(TRACK_FIX_STORAGE_KEY, TRACK_MODES.includes(mode) ? mode : DEFAULT_TRACK_MODE);
  } catch (_) { /* 保存できなくても動作は続ける */ }
}
