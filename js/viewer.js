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

  if (segments.length > 0) {
    video.style.display = "";
    loadSegment(0, 0, false); // 初期表示は先頭セグメントを頭出し（自動再生しない）
  } else {
    video.onloadedmetadata = null;
    video.onended = null;
    video.removeAttribute("src");
    video.style.display = "none";
  }

  // 地図: Leaflet + OpenStreetMap（実緯度経度）
  const trackTimes = track.map((p) => p.t);
  let lmap = null, lmarker = null;
  // ヘッドアップ(進行方向を上)表示の状態。update()/fit() から参照するため外側で保持する。
  // applyMapView(t) は地図生成時に実体を差し込む(軌跡なしセッションでは no-op のまま)。
  let applyMapView = () => {};
  const mapEl = document.getElementById("map");
  if (track.length && window.L) {
    mapEl.classList.remove("nomap");
    mapEl.innerHTML = "";
    // 前回マップを破棄してから新規生成(コンテナの _leaflet_id を確実に消す)。
    lmap = lifecycle.replaceMap(() => L.map("map"));
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(lmap);
    const latlngs = track.map((p) => [p.lat, p.lon]);
    const lpoly = L.polyline(latlngs, { color: "#2563c9", weight: 4 }).addTo(lmap);
    lmap.fitBounds(lpoly.getBounds(), { padding: [24, 24] });
    L.control.scale({ metric: true, imperial: false }).addTo(lmap);
    // 右上「全体を表示」: 軌跡 Start〜Goal 全体が収まる縮尺へ自動調整する
    const FitControl = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const btn = L.DomUtil.create("button", "fit-btn");
        btn.type = "button";
        btn.textContent = "全体を表示";
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", () => lmap.fitBounds(lpoly.getBounds(), { padding: [24, 24] }));
        return btn;
      },
    });
    lmap.addControl(new FitControl());
    lmarker = L.circleMarker(latlngs[0], {
      radius: 7, color: "#ffffff", weight: 2, fillColor: "#d64545", fillOpacity: 1,
    }).addTo(lmap);

    // --- ノースアップ ⇔ ヘッドアップ(進行方向を上) 切替 ---
    // Leaflet はタイル・軌跡・マーカーを .leaflet-map-pane 配下に、コントロールを
    // 兄弟の .leaflet-control-container に描く。map-pane だけを CSS 回転させれば、
    // ボタン/スケールは正立のまま地図の向きだけを変えられる(依存プラグイン不要)。
    const mapPane = mapEl.querySelector(".leaflet-map-pane");
    const MIN_MOVE_M = 5;   // これ未満の移動は停車とみなし直前の方位を保持する
    const HEADUP_ZOOM = 17; // ヘッドアップ時は自車周辺を拡大表示する
    let headUp = false;
    let lastBearing = 0;    // 最後に確定した進行方位(停車中の保持用)

    // θ度回転しても矩形コンテナを隙間なく覆う最小スケール(四隅の欠けを防ぐ)。
    // 正方形(w==h)なら最大でも √2≈1.41 に収まる。
    function coverScale(w, h, deg) {
      const r = (deg * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
    }
    // ヘッドアップ時は #map を高さと同じ幅の中央正方形にする。元のインライン
    // width/margin を退避し、復帰時に戻す。Leaflet に再計測させる。
    let savedW = null, savedMargin = null;
    function squareMap(on) {
      if (on) {
        if (savedW === null) { savedW = mapEl.style.width; savedMargin = mapEl.style.margin; }
        mapEl.style.width = mapEl.clientHeight + "px";
        mapEl.style.margin = "8px auto 12px";
      } else if (savedW !== null) {
        mapEl.style.width = savedW;
        mapEl.style.margin = savedMargin;
        savedW = null; savedMargin = null;
      }
      lmap.invalidateSize(false); // タイルを新サイズで再計算(全体再フィットはしない)
    }
    function carLatLngAt(t) {
      const j = nearest(trackTimes, t);
      return j >= 0 ? [track[j].lat, track[j].lon] : latlngs[0];
    }
    // 自車を中心に置き、map-pane を -方位 回転させて進行方向を画面上向きにする。
    function applyHeadUp(t) {
      const j = nearest(trackTimes, t);
      if (j >= 0) {
        const b = headingAt(track, j, MIN_MOVE_M);
        if (b != null) lastBearing = b; // 停車中(null)は直前の向きを維持
      }
      // setView は map-pane の translate をリセットするので、この後に回転を上書きできる。
      lmap.setView(carLatLngAt(t), HEADUP_ZOOM, { animate: false });
      const rect = mapEl.getBoundingClientRect();
      const sc = coverScale(rect.width, rect.height, lastBearing);
      mapPane.style.transformOrigin = "50% 50%";
      mapPane.style.transform =
        `translate3d(0px,0px,0px) scale(${sc.toFixed(4)}) rotate(${(-lastBearing).toFixed(2)}deg)`;
    }
    // update()/fit() から毎フレーム呼ばれる。ヘッドアップ時のみ回転を適用する。
    applyMapView = (t) => { if (headUp) applyHeadUp(t); };

    const NorthLabel = "⬆ 北を上";
    const HeadLabel = "⬆ 進行方向を上";
    const HeadUpControl = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const btn = L.DomUtil.create("button", "fit-btn headup-btn");
        btn.type = "button";
        btn.textContent = HeadLabel; // 押すとヘッドアップへ。既定はノースアップ。
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", () => {
          headUp = !headUp;
          btn.classList.toggle("active", headUp);
          btn.textContent = headUp ? NorthLabel : HeadLabel; // 次に戻せる状態を表示
          if (headUp) {
            // ヘッドアップ時は地図を中央正方形にする。横長のまま回転すると四隅を
            // 覆うために大きく拡大せねばならずタイルがボヤけるため、正方形化して
            // 拡大率を √2 以下に抑える(進行方向ナビでは正方形ビューが自然)。
            squareMap(true);
            applyHeadUp(globalTime());
          } else {
            // ノースアップへ復帰: 回転を解除し、全幅に戻して全体表示する。
            mapPane.style.transform = "";
            mapPane.style.transformOrigin = "";
            squareMap(false);
            lmap.fitBounds(lpoly.getBounds(), { padding: [24, 24] });
          }
        });
        return btn;
      },
    });
    lmap.addControl(new HeadUpControl());
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
  function fit() { cv.width = cv.clientWidth; cv.height = cv.clientHeight; if (lmap) lmap.invalidateSize(); draw(globalTime()); }

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
      if (j >= 0) lmarker.setLatLng([track[j].lat, track[j].lon]);
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
