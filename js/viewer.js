import { hvLabel } from "./parse.js";
import { createSessionLifecycle } from "./lifecycle.js";

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

export function renderViewer(model, videoSrc) {
  const { samples, graph, track, warnings } = model;
  const times = samples.map((s) => s.t);
  const video = document.getElementById("video");

  document.getElementById("warnings").textContent = (warnings || []).join("  /  ");

  if (videoSrc) {
    video.src = videoSrc;
    video.style.display = "";
  } else {
    video.removeAttribute("src");
    video.style.display = "none";
  }

  // 地図: Leaflet + OpenStreetMap（実緯度経度）
  const trackTimes = track.map((p) => p.t);
  let lmap = null, lmarker = null;
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
  function fit() { cv.width = cv.clientWidth; cv.height = cv.clientHeight; if (lmap) lmap.invalidateSize(); draw(video.currentTime || 0); }

  const fmt = (v) => (v == null ? "--" : Math.round(v * 10) / 10);
  function update() {
    const t = video.currentTime || 0;
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
    draw(t);
    // 再スケジュールは lifecycle.restartLoop が一元管理する(多重ループ防止)。
  }

  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect(), P = plot();
    const frac = (e.clientX - r.left - P.x) / (P.w || 1);
    const cl = Math.min(1, Math.max(0, frac));
    video.currentTime = tMin + cl * (tMax - tMin);
  };

  lifecycle.bindResize(fit); // window への登録は1度だけ。常に最新の fit を呼ぶ
  fit();

  // 縦長動画のときはグラフを動画の右列(.side)へ移し、全体の縦尺を縮める。
  // 横長/正方/動画なしは従来位置(.wrap 内・地図の前)に戻す。
  const sideEl = document.querySelector(".side");
  const wrapEl = document.querySelector(".wrap");
  function applyVideoLayout() {
    const portrait = Boolean(videoSrc) && video.videoWidth > 0 &&
      video.videoHeight > video.videoWidth;
    if (portrait) {
      document.body.classList.add("portrait-video");
      if (sideEl && cv.parentElement !== sideEl) sideEl.appendChild(cv);
    } else {
      document.body.classList.remove("portrait-video");
      if (wrapEl && cv.parentElement !== wrapEl) wrapEl.insertBefore(cv, mapEl);
    }
    window.dispatchEvent(new Event("resize")); // fit() でグラフ/地図を再描画
  }
  video.onloadedmetadata = applyVideoLayout; // 代入で多重登録を防ぐ
  applyVideoLayout(); // 初期(動画なし/メタ既ロード)

  lifecycle.restartLoop(update); // 前回セッションのループを止めてから開始する
}
