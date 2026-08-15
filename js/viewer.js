import { hvLabel, segmentAtGlobalTime } from "./parse.js";
import { computeTimeDomain } from "./timeline.js";
import { createSessionLifecycle } from "./lifecycle.js";
import { headingAt, distanceMeters, nearestPassIndex } from "./geo.js";

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

    // --- 軌跡のクリックで、その地点を通った時刻へ動画を飛ばす ---
    // 許容範囲は画面上のピクセルで決める。メートルで固定すると、広域表示では
    // 軌跡を押しても届かず、拡大時は離れた場所でも反応してしまうため。
    const CLICK_RADIUS_PX = 40;
    lmap.on("click", (e) => {
      if (!segments.length) return; // 動画なしセッションは飛び先がない
      // クリック点から CLICK_RADIUS_PX だけ横の点を緯度経度へ戻し、実距離に換算する。
      const edge = lmap.unproject([e.point.x + CLICK_RADIUS_PX, e.point.y]);
      const radiusM = distanceMeters(e.lngLat.lat, e.lngLat.lng, edge.lat, edge.lng);
      const now = globalTime();
      const j = nearestPassIndex(
        track, { lat: e.lngLat.lat, lon: e.lngLat.lng }, radiusM, now
      );
      // TODO(調査用・原因が判ったら削除): 2回目以降のクリックが効かない件の切り分け。
      // どこで落ちているか(半径外 / 飛び先が今と同じ / セグメント切替)を画面に出す。
      const st = document.getElementById("status");
      if (st) {
        st.textContent = j < 0
          ? `地図クリック: 半径外 (r=${Math.round(radiusM)}m)`
          : `地図クリック: j=${j} 飛び先=${track[j].t.toFixed(1)}s 現在=${now.toFixed(1)}s ` +
            `seg=${currentSeg} r=${Math.round(radiusM)}m`;
      }
      if (j >= 0) seekToGlobal(track[j].t);
    });
    // 軌跡の上ではカーソルを指マークにして、押せることを示す。
    lmap.on("mouseenter", "track-line", () => { lmap.getCanvas().style.cursor = "pointer"; });
    lmap.on("mouseleave", "track-line", () => { lmap.getCanvas().style.cursor = ""; });
  } else {
    lifecycle.replaceMap(null); // 軌跡なしセッション: 前回マップがあれば破棄する
    mapEl.classList.add("nomap");
  }

  // グラフ（速度=青, rpm=橙）
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
}
