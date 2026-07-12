import { hvLabel, segmentAtGlobalTime } from "./parse.js";
import { createSessionLifecycle } from "./lifecycle.js";
import { headingAt } from "./geo.js";

// 非SW フォールバック時の blob URL。次セグメント読込・セッション切替の前に解放する。
let activeObjectUrl = null;
function revokeActiveObjectUrl() {
  if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; }
}

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
const lifecycle = createSessionLifecycle({
  win: window,
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
});

export function renderViewer(model, playback) {
  const { samples, graph, track, warnings } = model;
  const times = samples.map((s) => s.t);
  const video = document.getElementById("video");

  document.getElementById("warnings").textContent = (warnings || []).join("  /  ");

  // 前セッションの blob を解放してから、この世代の再生状態を構築する。
  revokeActiveObjectUrl();
  const segments = playback ? playback.segments : [];
  // baseOffsets[i] = セグメント i のグローバル開始秒。数値なら確定、null は
  // loadedmetadata の実測 duration で順次確定する（メタ無しフォールバック）。
  const baseOffsets = segments.map((s) => s.baseOffsetSec);
  let currentSeg = 0;
  let pendingSeek = null;      // loadedmetadata 後に適用するローカルシーク秒
  let pendingAutoplay = false; // loadedmetadata 後に自動再生するか

  // 全体タイムライン上の現在時刻（秒）= 現セグメントの開始オフセット + ローカル再生位置。
  function globalTime() {
    const base = baseOffsets[currentSeg];
    return (base == null ? 0 : base) + (video.currentTime || 0);
  }

  async function loadSegment(i, localTime, autoplay) {
    if (i < 0 || i >= segments.length) return;
    currentSeg = i;
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
    if (pendingSeek != null) { try { video.currentTime = pendingSeek; } catch { /* 範囲外は無視 */ } pendingSeek = null; }
    if (pendingAutoplay) { video.play().catch(() => {}); pendingAutoplay = false; }
  };
  video.onended = () => {
    // 次セグメントがあれば先頭から自動再生し、10分境界をまたいで連続再生する（H3）。
    if (currentSeg + 1 < segments.length) loadSegment(currentSeg + 1, 0, true);
  };
  // 再生失敗の可視化。SW/認証系の失敗は video 要素の中では無音になりがちなので、
  // MediaError と、同じ src を fetch した実 HTTP ステータスを #error に出して切り分ける。
  video.onerror = async () => {
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
  const trackTimes = track.map((p) => p.t);
  let lmap = null, lmarker = null;
  // ヘッドアップ(進行方向を上)表示の状態。update()/fit() から参照するため外側で保持する。
  // applyMapView(t) は地図生成時に実体を差し込む(軌跡なしセッションでは no-op のまま)。
  let applyMapView = () => {};
  const mapEl = document.getElementById("map");
  if (track.length && window.maplibregl) {
    mapEl.classList.remove("nomap");
    mapEl.innerHTML = "";
    // MapLibre は [lon, lat] 順(Leaflet と逆)なので注意。
    const lnglats = track.map((p) => [p.lon, p.lat]);
    const bounds = lnglats.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(lnglats[0], lnglats[0])
    );
    // 前回マップを破棄してから新規生成。ベクタータイルなので回転しても文字は常に正立。
    lmap = lifecycle.replaceMap(() => new maplibregl.Map({
      container: mapEl,
      style: "https://tiles.openfreemap.org/styles/liberty",
      bounds,
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
    }));
    lmap.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    lmap.addControl(new maplibregl.ScaleControl({ unit: "metric" }));
    // 軌跡はスタイル読込完了後にレイヤ追加する(load 前の addSource はエラー)。
    lmap.on("load", () => {
      lmap.addSource("track", {
        type: "geojson",
        data: { type: "Feature", properties: {},
                geometry: { type: "LineString", coordinates: lnglats } },
      });
      lmap.addLayer({
        id: "track-line", type: "line", source: "track",
        paint: { "line-color": "#2563c9", "line-width": 4 },
      });
    });
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
  } else {
    lifecycle.replaceMap(null); // 軌跡なしセッション: 前回マップがあれば破棄する
    mapEl.classList.add("nomap");
  }

  // グラフ（速度=青, rpm=橙）
  const cv = document.getElementById("graph");
  const PAD = { l: 46, r: 54, t: 26, b: 22 };
  const plot = () => ({ x: PAD.l, y: PAD.t, w: cv.width - PAD.l - PAD.r, h: cv.height - PAD.t - PAD.b });
  const tMin = graph.length ? graph[0].t : 0;
  const tMax = graph.length ? graph[graph.length - 1].t : 1;
  const vmax = (key) => Math.max(1, ...graph.map((s) => s[key] || 0));
  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return m * p;
  };
  const speedAxis = niceMax(vmax("speed")), rpmAxis = niceMax(vmax("rpm"));
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const xAt = (t, P) => P.x + (t - tMin) / ((tMax - tMin) || 1) * P.w;

  function drawFrame(P) {
    const ctx = cv.getContext("2d");
    ctx.font = "11px -apple-system,'Hiragino Sans',sans-serif";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#e7dfce";
    for (let i = 0; i <= 4; i++) { const y = P.y + P.h * i / 4; ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); }
    ctx.fillStyle = "#877c69"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const t = tMin + (tMax - tMin) * i / 4, x = P.x + P.w * i / 4;
      ctx.strokeStyle = "#e7dfce"; ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
      ctx.fillText(mmss(t), x, P.y + P.h + 4);
    }
    ctx.fillStyle = "#2563c9"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 2; i++) { const y = P.y + P.h - P.h * i / 2; ctx.fillText(String(Math.round(speedAxis * i / 2)), P.x - 6, y); }
    ctx.fillStyle = "#c2710c"; ctx.textAlign = "left";
    for (let i = 0; i <= 2; i++) { const y = P.y + P.h - P.h * i / 2; ctx.fillText(String(Math.round(rpmAxis * i / 2)), P.x + P.w + 6, y); }
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = "#2563c9"; ctx.fillRect(P.x, 12, 14, 3); ctx.fillText("速度 (km/h)", P.x + 18, 13);
    ctx.fillStyle = "#c2710c"; ctx.fillRect(P.x + 130, 12, 14, 3); ctx.fillText("RPM", P.x + 148, 13);
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
  function draw(t) {
    const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height);
    const P = plot(); drawFrame(P);
    line("speed", speedAxis, "#2563c9", P); line("rpm", rpmAxis, "#c2710c", P);
    const x = xAt(t, P);
    ctx.strokeStyle = "#d64545"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
  }
  function fit() { cv.width = cv.clientWidth; cv.height = cv.clientHeight; if (lmap) lmap.resize(); draw(globalTime()); }

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
    draw(t);
    // 再スケジュールは lifecycle.restartLoop が一元管理する(多重ループ防止)。
  }

  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect(), P = plot();
    const frac = (e.clientX - r.left - P.x) / (P.w || 1);
    const cl = Math.min(1, Math.max(0, frac));
    const target = tMin + cl * (tMax - tMin); // クリック位置のグローバル時刻（秒）
    if (segments.length > 1) {
      // 確定済み baseOffsets で対象セグメントとローカル時刻を求め、跨ぎシークする。
      const playlist = baseOffsets.map((b) => ({ baseOffsetSec: b }));
      const { index, localTime } = segmentAtGlobalTime(playlist, target);
      if (index >= 0 && index !== currentSeg) { loadSegment(index, localTime, !video.paused); return; }
      if (index >= 0) { video.currentTime = localTime; return; }
    }
    video.currentTime = target; // 単一セグメント（従来動作）
  };

  lifecycle.bindResize(fit); // window への登録は1度だけ。常に最新の fit を呼ぶ
  fit();

  lifecycle.restartLoop(update); // 前回セッションのループを止めてから開始する
}
