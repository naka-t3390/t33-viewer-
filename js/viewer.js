import { getThemeColors, onThemeChange } from "./theme.js";
import { hvLabel, segmentAtGlobalTime } from "./parse.js";
import { computeTimeDomain } from "./timeline.js";
import { createSessionLifecycle } from "./lifecycle.js";
import { headingAt, distanceMeters, nearestPassTime } from "./geo.js";
import { trackToFeatures } from "./dead-reckoning.js";
import { downsampleTorque, sampleCockpitAt } from "./can-signals.js";
import { createCockpitPanel } from "./cockpit-panel.js";

// 非SW フォールバック時の blob URL。次セグメント読込・セッション切替の前に解放する。
let activeObjectUrl = null;
function revokeActiveObjectUrl() {
  if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; }
}

// 全画面(ネイティブコントロール)から通常表示へ戻ると、Chrome が動画フレームを
// 全画面時の配置のまま合成し続け、上に黒帯・下寄せの表示ずれが出ることがある。
// 復帰時に一度 reflow を挟んで再表示し、object-fit:contain の中央配置を回復する
// (display の切替は再生を止めない)。登録はモジュール読込時の1回だけ。
function repaintVideoAfterFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) return; // 入る側は対象外
  const video = document.getElementById("video");
  if (!video || video.style.display === "none") return;
  requestAnimationFrame(() => {
    video.style.display = "none";
    void video.offsetHeight; // 強制 reflow
    video.style.display = "";
  });
}
document.addEventListener("fullscreenchange", repaintVideoAfterFullscreen);
document.addEventListener("webkitfullscreenchange", repaintVideoAfterFullscreen);

// ソート済み配列 arr で t に最近傍の index（タイは下側）。
function nearest(arr, t) {
  let lo = 0, hi = arr.length - 1;
  if (hi < 0) return -1;
  if (t <= arr[0]) return 0;
  if (t >= arr[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  return (lo > 0 && arr[lo] - t > t - arr[lo - 1]) ? lo - 1 : lo;
}

// セッション再描画ごとの使い捨てリソース(マップ/RAFループ/resizeリスナ)を
// 一元管理する。前回分を必ず破棄してから作り直すので、再描画しても
// 「already initialized」やループ/リスナの多重化が起きない。
let currentThemeCallback = null;
onThemeChange((colors) => {
  if (currentThemeCallback) currentThemeCallback(colors);
});

const lifecycle = createSessionLifecycle({
  win: window,
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
});

// ─── 端末画面(縦型)パネル ───
// `.mid` の右枠をグラフと入れ替えて出す(2026-11-28 の所有者指定)。パネルの DOM は
// セッションをまたいで使い回し、セッション切替では reset() だけ呼ぶ。
const COCKPIT_STORAGE_KEY = "t33_viewer_right_pane";
let cockpitPanel = null;
/** 枠の寸法が変わったときに呼ぶ再計算(最新のセッションの fit)。 */
let currentFit = null;

function cockpitEl() {
  return document.getElementById("cockpit");
}

/** 端末画面を表示しているか。 */
export function isCockpitVisible() {
  const el = cockpitEl();
  return Boolean(el) && !el.classList.contains("hidden");
}

function applyRightPane(showCockpit) {
  const cockpit = cockpitEl();
  const graph = document.getElementById("graph");
  const btn = document.getElementById("cockpit-toggle");
  if (!cockpit || !graph) return;
  cockpit.classList.toggle("hidden", !showCockpit);
  graph.classList.toggle("hidden", showCockpit);
  if (btn) {
    btn.classList.toggle("active", showCockpit);
    btn.textContent = showCockpit ? "グラフ" : "端末画面";
    btn.title = showCockpit ? "右枠をグラフに戻す" : "右枠を端末画面にする";
  }
  if (showCockpit && cockpitPanel) cockpitPanel.resize();
  // 枠の高さが変わるので、グラフ側の canvas と地図も作り直す。
  if (currentFit) currentFit();
}

/**
 * 右枠の切り替えボタンを 1 度だけ結線する。選択は localStorage に残す。
 */
export function initCockpitToggle() {
  const btn = document.getElementById("cockpit-toggle");
  // セッションを開く前に切り替えても空の箱にならないよう、先に組み立てておく。
  const root = cockpitEl();
  if (root && !cockpitPanel) cockpitPanel = createCockpitPanel(root);
  let saved = null;
  try { saved = localStorage.getItem(COCKPIT_STORAGE_KEY); } catch { /* 使えなくても既定で動く */ }
  applyRightPane(saved === "cockpit");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = !isCockpitVisible();
    try { localStorage.setItem(COCKPIT_STORAGE_KEY, next ? "cockpit" : "graph"); } catch { /* 保存できなくても切替は効く */ }
    applyRightPane(next);
  });
}

export function renderViewer(model, playback) {
  const { samples, graph, warnings } = model;
  // 表示中の軌跡。生の GPS で始まり、CAN による補正が済めば差し替わる(setCorrection)。
  let track = model.track;
  const times = samples.map((s) => s.t);
  const video = document.getElementById("video");

  document.getElementById("warnings").textContent = (warnings || []).join("  /  ");

  // 端末画面パネルは DOM を使い回す。セッションが変わったら PEAK と残像だけ捨てる。
  const cockpitRoot = cockpitEl();
  if (cockpitRoot) {
    if (!cockpitPanel) cockpitPanel = createCockpitPanel(cockpitRoot);
    cockpitPanel.reset();
  }

  // 前セッションの blob を解放してから、この世代の再生状態を構築する。
  revokeActiveObjectUrl();
  const segments = playback ? playback.segments : [];
  // baseOffsets[i] = セグメント i のグローバル開始秒。数値なら確定、null は
  // loadedmetadata の実測 duration で順次確定する（メタ無しフォールバック）。
  const baseOffsets = segments.map((s) => s.baseOffsetSec);
  let currentSeg = 0;
  let pendingSeek = null;      // loadedmetadata 後に適用するローカルシーク秒
  let pendingAutoplay = false; // loadedmetadata 後に自動再生するか
  let lastAutoplay = false;    // 直近 loadSegment の autoplay 意図(エラー時スキップで引き継ぐ)

  // 全体タイムライン上の現在時刻（秒）= 現セグメントの開始オフセット + ローカル再生位置。
  function globalTime() {
    const base = baseOffsets[currentSeg];
    return (base == null ? 0 : base) + (video.currentTime || 0);
  }

  async function loadSegment(i, localTime, autoplay) {
    if (i < 0 || i >= segments.length) return;
    currentSeg = i;
    lastAutoplay = autoplay;
    revokeActiveObjectUrl();
    pendingSeek = localTime;
    pendingAutoplay = autoplay;
    const src = await playback.resolveSrc(i);
    if (playback.isBlob) activeObjectUrl = src;
    video.src = src;
    video.load();
  }

  video.onloadedmetadata = () => {
    // 次セグメントの baseOffset が未確定なら、今のセグメントの実測 duration で確定する。
    const next = currentSeg + 1;
    if (next < baseOffsets.length && baseOffsets[next] == null && Number.isFinite(video.duration)) {
      const cur = baseOffsets[currentSeg] == null ? 0 : baseOffsets[currentSeg];
      baseOffsets[next] = cur + video.duration;
    }
    // 実測 duration で動画全体の終端を伸ばす。最終セグメントの長さは
    // ここに来るまで判らないので、判った時点でグラフ横軸を引き直す。
    if (Number.isFinite(video.duration)) {
      const cur = baseOffsets[currentSeg] == null ? 0 : baseOffsets[currentSeg];
      const end = cur + video.duration;
      if (knownVideoEnd == null || end > knownVideoEnd) {
        knownVideoEnd = end;
        if (refreshDomain()) draw(globalTime());
      }
    }
    if (pendingSeek != null) { try { video.currentTime = pendingSeek; } catch { /* 範囲外は無視 */ } pendingSeek = null; }
    if (pendingAutoplay) {
      // 自動再生をブラウザに拒否されると、次セグメントの先頭で静止したまま何も起きない。
      // 握り潰すと利用者からは「10分ちょうどで止まった」としか見えず原因が追えないので、
      // 何が起きたかと復帰方法を画面に出す（10分境界をまたぐ唯一の自動遷移点）。
      video.play().catch((e) => {
        document.getElementById("error").textContent =
          `続きの再生がブラウザに止められました（${e && e.name ? e.name : "NotAllowedError"}）。` +
          `再生ボタンを押すと ${currentSeg + 1} 本目から続きます。`;
      });
      pendingAutoplay = false;
    }
  };
  video.onended = () => {
    // 次セグメントがあれば先頭から自動再生し、10分境界をまたいで連続再生する（H3）。
    if (currentSeg + 1 < segments.length) loadSegment(currentSeg + 1, 0, true);
  };
  // 壊れたセグメントの実行時スキップ + 再生失敗の可視化。
  // スリープ/Doze/切断で moov 未書き込みの mp4 は 0バイト(HTTP 416)や再生不可(DEMUXER)になる。
  // 0バイトは buildSegmentPlaylist が事前除外するが、サイズは大きいが moov 無しの破損は
  // 再生してみないと分からないため、ここで次セグメントへ飛ばして連続再生を続ける。
  video.onerror = async () => {
    // まだ後続セグメントがあるなら、壊れた1本を飛ばして次を試す(直近の再生意図を引き継ぐ)。
    if (currentSeg + 1 < segments.length) {
      document.getElementById("error").textContent =
        "一部の映像が壊れているため、その区間をスキップしました";
      loadSegment(currentSeg + 1, 0, lastAutoplay);
      return;
    }
    // 最終セグメントまで全滅した場合のみ、原因切り分け用に MediaError と実 HTTP を出す。
    const me = video.error;
    let http = "";
    try {
      const r = await fetch(video.currentSrc, { headers: { Range: "bytes=0-1" } });
      http = ` / HTTP ${r.status}`;
    } catch {
      http = " / HTTP 取得失敗";
    }
    document.getElementById("error").textContent =
      `動画を再生できません: MediaError code=${me ? me.code : "?"}` +
      `${me && me.message ? ` (${me.message})` : ""}${http}`;
  };

  if (segments.length > 0) {
    video.style.display = "";
    loadSegment(0, 0, false); // 初期表示は先頭セグメントを頭出し（自動再生しない）
  } else {
    video.onloadedmetadata = null;
    video.onended = null;
    video.onerror = null;
    video.removeAttribute("src");
    video.style.display = "none";
  }

  // 地図: MapLibre GL + OpenFreeMap ベクタータイル（実緯度経度）
  let trackTimes = track.map((p) => p.t);
  let lmap = null, lmarker = null;
  // CAN による補正の受け口。軌跡なしセッション(地図なし)では何もしない。
  let setCorrection = () => {};
  // ヘッドアップ(進行方向を上)表示の状態。update()/fit() から参照するため外側で保持する。
  // applyMapView(t) は地図生成時に実体を差し込む(軌跡なしセッションでは no-op のまま)。
  let applyMapView = () => {};
  const mapEl = document.getElementById("map");
  if (track.length && window.maplibregl) {
    mapEl.classList.remove("nomap");
    mapEl.innerHTML = "";
    // MapLibre は [lon, lat] 順(Leaflet と逆)なので注意。
    const boundsOf = (pts) => pts.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(pts[0], pts[0])
    );
    let lnglats = track.map((p) => [p.lon, p.lat]);
    let bounds = boundsOf(lnglats);
    // 前回マップを破棄してから新規生成。ベクタータイルなので回転しても文字は常に正立。
    const initialColors = getThemeColors();
    lmap = lifecycle.replaceMap(() => new maplibregl.Map({
      container: mapEl,
      style: initialColors.mapStyle,
      bounds,
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
    }));
    lmap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    lmap.addControl(new maplibregl.ScaleControl({ unit: "metric" }));

    // 軌跡は est(推定)の連なりごとに別の線にする。GPS が取れず CAN から推定した区間は破線。
    const trackData = () => ({ type: "FeatureCollection", features: trackToFeatures(track) });
    function updateTrackLayer() {
      if (!lmap || !lmap.isStyleLoaded()) return;
      if (!lmap.getSource("track")) {
        lmap.addSource("track", { type: "geojson", data: trackData() });
      }
      const color = getThemeColors().track;
      if (!lmap.getLayer("track-line")) {
        lmap.addLayer({
          id: "track-line", type: "line", source: "track",
          filter: ["!=", ["get", "est"], true],
          paint: { "line-color": color, "line-width": 4 },
        });
      } else {
        lmap.setPaintProperty("track-line", "line-color", color);
      }
      if (!lmap.getLayer("track-line-est")) {
        lmap.addLayer({
          id: "track-line-est", type: "line", source: "track",
          filter: ["==", ["get", "est"], true],
          paint: { "line-color": color, "line-width": 4, "line-dasharray": [1.5, 1.5] },
        });
      } else {
        lmap.setPaintProperty("track-line-est", "line-color", color);
      }
    }
    // 表示する軌跡を差し替える(生 GPS ⇔ CAN 補正)。動画の再生は止めない。
    function applyTrack(next) {
      track = next;
      trackTimes = track.map((p) => p.t);
      lnglats = track.map((p) => [p.lon, p.lat]);
      bounds = boundsOf(lnglats);
      const src = lmap && lmap.getSource("track");
      if (src) src.setData(trackData());
      lastAppliedJ = null; // ヘッドアップの追従を取り直す
      lastAppliedBearing = null;
      refreshDomain(); // 補正経路が GPS より長く続けば、横軸も伸ばす
    }
    lmap.on("load", updateTrackLayer);
    lmap.on("style.load", updateTrackLayer);
    // 自車マーカー(DOM要素。見た目は CSS .car-marker)
    const carEl = document.createElement("div");
    carEl.className = "car-marker";
    lmarker = new maplibregl.Marker({ element: carEl }).setLngLat(lnglats[0]).addTo(lmap);

    // --- ノースアップ ⇔ ヘッドアップ(進行方向を上) 切替 ---
    const MIN_MOVE_M = 5; // これ未満の移動は停車とみなし直前の方位を保持する
    let headUp = false;
    let lastBearing = 0;  // 最後に確定した進行方位(停車中の保持用)
    // 直前にカメラへ適用した自車位置(track index)と方位。ここが変わらない限り
    // jumpTo しない。毎フレーム jumpTo すると進行中のズーム操作(ホイール/ピンチ/±)を
    // 打ち消して「拡大縮小が効かない」状態になるため。zoom は一切指定せず、
    // 現在の縮尺を常に維持する(ノースアップ⇔ヘッドアップで縮尺を共有)。
    let lastAppliedJ = null;
    let lastAppliedBearing = null;

    function carLngLatAt(t) {
      const j = nearest(trackTimes, t);
      return j >= 0 ? [track[j].lon, track[j].lat] : lnglats[0];
    }
    // 自車中心・進行方向を上。bearing は MapLibre ネイティブ機能(文字は正立のまま)。
    function applyHeadUp(t) {
      const j = nearest(trackTimes, t);
      if (j >= 0) {
        const b = headingAt(track, j, MIN_MOVE_M);
        if (b != null) lastBearing = b; // 停車中(null)は直前の向きを維持
      }
      if (j === lastAppliedJ && lastBearing === lastAppliedBearing) return;
      lastAppliedJ = j;
      lastAppliedBearing = lastBearing;
      lmap.jumpTo({ center: carLngLatAt(t), bearing: lastBearing });
    }
    // update()/fit() から毎フレーム呼ばれる。ヘッドアップ時のみ追従+回転を適用する。
    applyMapView = (t) => { if (headUp) applyHeadUp(t); };

    // ボタン群(全体を表示 / 進行方向を上)。地図の子ではなく #map 直下の素の DOM。
    const NorthLabel = "⬆ 北を上";
    const HeadLabel = "⬆ 進行方向を上";
    const btns = document.createElement("div");
    btns.className = "map-btns";
    const fitBtn = document.createElement("button");
    fitBtn.type = "button";
    fitBtn.className = "fit-btn";
    fitBtn.textContent = "全体を表示";
    const headBtn = document.createElement("button");
    headBtn.type = "button";
    headBtn.className = "fit-btn headup-btn";
    headBtn.textContent = HeadLabel; // 押すとヘッドアップへ。既定はノースアップ。
    btns.appendChild(fitBtn);
    btns.appendChild(headBtn);
    mapEl.appendChild(btns);

    // 北を上へ戻す: 回転のみ解除し、縮尺と中心は維持する(縮尺はモード間で共有)。
    function toNorthUp() {
      headUp = false;
      headBtn.classList.remove("active");
      headBtn.textContent = HeadLabel;
      lmap.jumpTo({ bearing: 0 });
    }
    // 全体を表示: こちらだけが縮尺を変える(北を上に戻して軌跡全体へフィット)。
    fitBtn.addEventListener("click", () => {
      toNorthUp();
      lmap.fitBounds(bounds, { padding: 24 });
    });
    headBtn.addEventListener("click", () => {
      if (headUp) { toNorthUp(); return; }
      headUp = true;
      headBtn.classList.add("active");
      headBtn.textContent = NorthLabel; // 次に戻せる状態を表示
      lastAppliedJ = null; // 前回セッションの適用済み状態を破棄して必ず初回適用する
      lastAppliedBearing = null;
      applyHeadUp(globalTime());
    });

    // --- 軌跡のクリックで、その地点を通った時刻へ動画を飛ばす ---
    // 許容範囲は画面上のピクセルで決める。メートルで固定すると、広域表示では
    // 軌跡を押しても届かず、拡大時は離れた場所でも反応してしまうため。
    const CLICK_RADIUS_PX = 40;
    lmap.on("click", (e) => {
      if (!segments.length) return; // 動画なしセッションは飛び先がない
      // クリック点から CLICK_RADIUS_PX だけ横の点を緯度経度へ戻し、実距離に換算する。
      const edge = lmap.unproject([e.point.x + CLICK_RADIUS_PX, e.point.y]);
      const radiusM = distanceMeters(e.lngLat.lat, e.lngLat.lng, edge.lat, edge.lng);
      const t = nearestPassTime(
        track, { lat: e.lngLat.lat, lon: e.lngLat.lng }, radiusM, globalTime()
      );
      if (t !== null) seekToGlobal(t);
    });
    // 軌跡の上ではカーソルを指マークにして、押せることを示す。
    for (const layer of ["track-line", "track-line-est"]) {
      lmap.on("mouseenter", layer, () => { lmap.getCanvas().style.cursor = "pointer"; });
      lmap.on("mouseleave", layer, () => { lmap.getCanvas().style.cursor = ""; });
    }
  } else {
    lifecycle.replaceMap(null); // 軌跡なしセッション: 前回マップがあれば破棄する
    mapEl.classList.add("nomap");
  }

  // グラフ（左軸: 速度=青, 右軸: 前トルク=緑・後トルク=紫）
  const cv = document.getElementById("graph");
  const PAD = { l: 46, r: 54, t: 26, b: 22 };
  const plot = () => ({ x: PAD.l, y: PAD.t, w: cv.width - PAD.l - PAD.r, h: cv.height - PAD.t - PAD.b });
  // 横軸は CSV(OBD) ではなく「動画全体」を基準にする。OBD が動画より早く止まった
  // セッションでも軸が途中で切れず、再生位置カーソルが軸外へ出ない。
  // knownVideoEnd は loadedmetadata で実測できた「base + duration」の最大値。
  let knownVideoEnd = null;
  // baseOffsets は再生に伴って確定していく（メタ無しフォールバック）ので、
  // 軸の算出には元の segments ではなく最新の baseOffsets を渡す。
  const domainSegments = () => segments.map((s, i) => ({ baseOffsetSec: baseOffsets[i], size: s.size }));
  let { tMin, tMax } = computeTimeDomain({ samples, track, segments: domainSegments(), knownEndSec: null });
  // 実測で終端が伸びたら軸を更新する（最終セグメントは再生するまで長さが判らない）。
  function refreshDomain() {
    const d = computeTimeDomain({ samples, track, segments: domainSegments(), knownEndSec: knownVideoEnd });
    if (d.tMin === tMin && d.tMax === tMax) return false;
    tMin = d.tMin; tMax = d.tMax;
    return true;
  }
  const vmax = (key) => Math.max(1, ...graph.map((s) => s[key] || 0));
  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return m * p;
  };
  const speedAxis = niceMax(vmax("speed"));
  // 前後モータートルク(CAN 1D4 / 1BC)。裏で読み込まれ次第 setMotorTorque で流し込む。
  let frontTorqueSeries = [];
  let rearTorqueSeries = [];
  let torqueAxis = 100;
  function setMotorTorque({ frontTorque = [], rearTorque = [] } = {}) {
    frontTorqueSeries = downsampleTorque(frontTorque, 0.2);
    rearTorqueSeries = downsampleTorque(rearTorque, 0.2);
    let maxAbs = 50;
    for (const p of frontTorqueSeries) { const a = Math.abs(p.nm); if (a > maxAbs) maxAbs = a; }
    for (const p of rearTorqueSeries) { const a = Math.abs(p.nm); if (a > maxAbs) maxAbs = a; }
    torqueAxis = niceMax(maxAbs);
    draw(globalTime());
  }
  // 端末画面パネル用の 20Hz グリッド。CAN を読み終わってから流し込まれる。
  let cockpitGrid = null;
  function setCockpit(grid) {
    cockpitGrid = grid || null;
    if (cockpitPanel && isCockpitVisible()) {
      cockpitPanel.update(sampleCockpitAt(cockpitGrid, globalTime()), globalTime());
    }
  }
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const xAt = (t, P) => P.x + (t - tMin) / ((tMax - tMin) || 1) * P.w;

  function drawFrame(P) {
    const ctx = cv.getContext("2d");
    const colors = getThemeColors();
    ctx.font = "11px -apple-system,'Hiragino Sans',sans-serif";
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.grid;
    for (let i = 0; i <= 4; i++) { const y = P.y + P.h * i / 4; ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); }
    // トルク 0 Nm の基準線(中央)をわずかに強調する
    ctx.save();
    ctx.strokeStyle = colors.textMuted;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([4, 4]);
    const yZero = P.y + P.h / 2;
    ctx.beginPath(); ctx.moveTo(P.x, yZero); ctx.lineTo(P.x + P.w, yZero); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = colors.textMuted; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const t = tMin + (tMax - tMin) * i / 4, x = P.x + P.w * i / 4;
      ctx.strokeStyle = colors.grid; ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
      ctx.fillText(mmss(t), x, P.y + P.h + 4);
    }
    // 左軸: 速度 (km/h)
    ctx.fillStyle = colors.speed; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 2; i++) { const y = P.y + P.h - P.h * i / 2; ctx.fillText(String(Math.round(speedAxis * i / 2)), P.x - 6, y); }
    // 右軸: 前後モータートルク (-torqueAxis 〜 +torqueAxis Nm)
    ctx.fillStyle = colors.frontTorque; ctx.textAlign = "left";
    ctx.fillText(`+${Math.round(torqueAxis)}`, P.x + P.w + 6, P.y);
    ctx.fillText("0", P.x + P.w + 6, P.y + P.h / 2);
    ctx.fillText(`-${Math.round(torqueAxis)}`, P.x + P.w + 6, P.y + P.h);
    // 凡例
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = colors.speed; ctx.fillRect(P.x, 12, 14, 3); ctx.fillText("速度 (km/h)", P.x + 18, 13);
    ctx.fillStyle = colors.frontTorque; ctx.fillRect(P.x + 102, 12, 14, 3); ctx.fillText("前トルク (Nm)", P.x + 120, 13);
    ctx.fillStyle = colors.rearTorque; ctx.fillRect(P.x + 216, 12, 14, 3); ctx.fillText("後トルク (Nm)", P.x + 234, 13);
  }
  function line(key, max, color, P) {
    const ctx = cv.getContext("2d");
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false;
    for (const s of graph) {
      if (s[key] == null) { started = false; continue; }
      const x = xAt(s.t, P), y = P.y + P.h - (s[key] / max) * P.h;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  function torqueLine(series, maxAbs, color, P) {
    if (!series.length) return;
    const ctx = cv.getContext("2d");
    const yMid = P.y + P.h / 2;
    const halfH = P.h / 2;
    ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.beginPath();
    let prevT = null;
    for (const p of series) {
      const x = xAt(p.t, P);
      const y = yMid - (p.nm / maxAbs) * halfH;
      if (prevT == null || p.t - prevT > 2.0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      prevT = p.t;
    }
    ctx.stroke();
  }
  function draw(t) {
    const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height);
    const P = plot();
    const colors = getThemeColors();
    drawFrame(P);
    line("speed", speedAxis, colors.speed, P);
    torqueLine(frontTorqueSeries, torqueAxis, colors.frontTorque, P);
    torqueLine(rearTorqueSeries, torqueAxis, colors.rearTorque, P);
    const x = xAt(t, P);
    ctx.strokeStyle = colors.cursor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
  }
  currentThemeCallback = (colors) => {
    if (lmap) {
      lmap.setStyle(colors.mapStyle);
    }
    draw(globalTime());
  };
  function fit() {
    cv.width = cv.clientWidth;
    cv.height = cv.clientHeight;
    if (lmap) lmap.resize();
    if (cockpitPanel) cockpitPanel.resize();
    draw(globalTime());
  }
  currentFit = fit; // 右枠の切り替えでもこの世代の fit を呼べるようにする

  const fmt = (v) => (v == null ? "--" : Math.round(v * 10) / 10);
  function update() {
    const t = globalTime();
    const i = nearest(times, t);
    if (i >= 0) {
      const s = samples[i];
      document.getElementById("g-speed").textContent = fmt(s.speed);
      document.getElementById("g-rpm").textContent = fmt(s.rpm);
      document.getElementById("g-coolant").textContent = fmt(s.coolant);
      document.getElementById("g-throttle").textContent = fmt(s.throttle);
      document.getElementById("g-hv").textContent = hvLabel(s.hv_state);
      document.getElementById("g-time").textContent = t.toFixed(1);
    }
    if (lmarker) {
      const j = nearest(trackTimes, t);
      if (j >= 0) lmarker.setLngLat([track[j].lon, track[j].lat]);
    }
    applyMapView(t); // ヘッドアップ時は自車追従+回転を適用(ノースアップ時は no-op)
    // 端末画面は表示しているときだけ描く(隠れている間は CPU を使わない)。
    // 地図のマーカーとグラフのカーソルと同じ t を渡すので、必ず同じ時刻を指す。
    if (cockpitPanel && isCockpitVisible()) {
      cockpitPanel.update(sampleCockpitAt(cockpitGrid, t), t);
    }
    draw(t);
    // 再スケジュールは lifecycle.restartLoop が一元管理する(多重ループ防止)。
  }

  // グローバル時刻(秒)へ移動する。グラフのクリックと地図のクリックが共用する。
  // 再生状態は変えない ―― 再生中なら移動先から再生が続き、一時停止中は止まったまま。
  function seekToGlobal(target) {
    if (segments.length > 1) {
      // 確定済み baseOffsets で対象セグメントとローカル時刻を求め、跨ぎシークする。
      const playlist = baseOffsets.map((b) => ({ baseOffsetSec: b }));
      const { index, localTime } = segmentAtGlobalTime(playlist, target);
      if (index >= 0 && index !== currentSeg) { loadSegment(index, localTime, !video.paused); return; }
      if (index >= 0) { video.currentTime = localTime; return; }
    }
    video.currentTime = target; // 単一セグメント（従来動作）
  }

  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect(), P = plot();
    const frac = (e.clientX - r.left - P.x) / (P.w || 1);
    const cl = Math.min(1, Math.max(0, frac));
    seekToGlobal(tMin + cl * (tMax - tMin)); // クリック位置のグローバル時刻（秒）
  };

  lifecycle.bindResize(fit); // window への登録は1度だけ。常に最新の fit を呼ぶ
  fit();

  lifecycle.restartLoop(update); // 前回セッションのループを止めてから開始する
  // seekToGlobal は本番ではグラフ/地図のクリックから呼ばれる。外へも出しておくと、
  // 開発ハーネスが動画要素を直接触らずに(= currentSeg を壊さずに)時刻を指定できる。
  return { setCorrection, setMotorTorque, setCockpit, seekToGlobal };
}
