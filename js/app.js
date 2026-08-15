import { CONFIG } from "./config.js";
import { initAuth, signIn, onTokenExpired, getToken, isGranted, silentSignIn, onTokenRefreshed } from "./auth.js";
import { findFolderId, listChildren, downloadText, downloadBlobUrl } from "./drive.js";
import { selectDateFolders, partitionDateChildren, groupSessions, buildViewModel, parseSegmentedMeta, buildSegmentPlaylist, csvDurationSec } from "./parse.js";
import { renderViewer } from "./viewer.js";
import { buildMediaUrl } from "./media-range.js";
import { buildPlayback } from "./playback.js";
import { createSessionPanel } from "./panel.js";

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $("status").textContent = msg || ""; };
const setError = (msg) => { $("error").textContent = msg || ""; };

let dates = [];   // [{id, name, label}] 走行日（最新が先頭）
let panel = null; // createSessionPanel の戻り値
let opSeq = 0;    // 非同期レースガード：最新の操作のみ反映する連番
let swStreaming = false; // SW による動画ストリーミングが使えるか

// SW を登録して制御下に入るまで待つ。失敗時は false（全DLフォールバック）。
async function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { type: "module" });
    await navigator.serviceWorker.ready;
    swStreaming = Boolean(navigator.serviceWorker.controller);
    // 初回訪問では ready 時点で controller が未確立(null)のため false になりがち。
    // 制御が確立したら controllerchange で true へ更新する（H1: 初回もSWストリーミング）。
    navigator.serviceWorker.addEventListener("controllerchange", () => { swStreaming = true; });
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "drive-401") {
        setError("認証の有効期限が切れました。再度ログインしてください。");
      }
      if (e.data && e.data.type === "sw-media-no-token") {
        setError("動画用トークンがSWに未達です。ページを再読み込みしてください。");
      }
    });
  } catch {
    swStreaming = false; // 登録失敗時は従来方式
  }
}

// 再生直前に最新トークンを SW へ渡し、受領 ack を待つ（H2: token 未受領による 401 回避）。
// controller 不在や ack 不達でも 1.5s で解決して再生を続行する（保守的フォールバック）。
function sendTokenToSW() {
  return new Promise((resolve) => {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) { resolve(false); return; }
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1500);
    ch.port1.onmessage = (e) => {
      if (e.data && e.data.type === "drive-token-ack") { clearTimeout(timer); resolve(true); }
    };
    c.postMessage({ type: "drive-token", token: getToken() }, [ch.port2]);
  });
}

// GIS スクリプトの読込完了を待ってから初期化
function whenGisReady(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) { cb(); return; }
  setTimeout(() => whenGisReady(cb), 100);
}

// ログイン後：root 直下から走行日リストだけ取得（遅延読み込みの起点）
async function loadDates() {
  setError("");
  setStatus("走行日を取得中…");
  const rootId = await findFolderId(CONFIG.ROOT_FOLDER);
  if (!rootId) {
    setStatus("");
    setError(`Drive に「${CONFIG.ROOT_FOLDER}」フォルダが見つかりません。`);
    return;
  }
  dates = selectDateFolders(await listChildren(rootId));
  if (dates.length === 0) {
    setStatus("");
    setError("走行セッションが見つかりません。");
    return;
  }
  panel.setDates(dates);
  document.getElementById("panel").classList.remove("closed");
  setStatus(`走行日 ${dates.length} 日`);
  await panel.expandDate(dates[0], { autoSelectFirst: true }); // 最新日を自動展開・先頭を自動選択
}

// 走行日の全ファイルを取得してセッションにまとめる(パネルの遅延読み込みから呼ばれる)。
async function fetchSessionsForDate(d) {
  const children = await listChildren(d.id);
  const { timeFolders, directFiles } = partitionDateChildren(children);
  let files = [...directFiles]; // 旧フラット構成の後方互換
  for (const tf of timeFolders) {
    files = files.concat(await listChildren(tf.id));
  }
  const sessions = groupSessions(files);
  fillDurations(sessions); // 一覧の表示は待たせない(届いた順にカードへ反映)
  return sessions;
}

// 各セッションの実記録時間を CSV から求めてカードへ流し込む。
// 動画セグメント数からの推定はしない ―― 2026-08-15 の走行では実記録 1分50秒 の
// セッションが「約10分」と表示され、記録の区切りが読み取れなかった。
async function fillDurations(sessions) {
  await Promise.all(sessions.map(async (s) => {
    try {
      panel.setDuration(s.stem, csvDurationSec(await downloadText(s.csv)));
    } catch (e) {
      // 長さが出ないだけで一覧も再生も成り立つ。全体を止める理由にはしない。
      console.warn(`記録時間を取得できません: ${s.stem}`, e);
    }
  }));
}

// 時刻セッションを開く（描画は既存のまま。パネルのカード選択から呼ばれる）
async function openSession(s) {
  const seq = ++opSeq;
  setError("");
  setStatus(`${s.dateLabel} ${s.timeLabel} を読み込み中…`);
  try {
    const csvText = await downloadText(s.csv);
    if (seq !== opSeq) return;
    const kmlText = s.kml ? await downloadText(s.kml) : "";
    if (seq !== opSeq) return;
    const jsonText = s.json ? await downloadText(s.json) : "";
    if (seq !== opSeq) return;
    // 10分セグメント分割された連番mp4を1本のプレイリストとして扱う（H3）。
    // _video.json の集約メタがあれば絶対時刻で baseOffset を確定、無ければ
    // name 昇順＋実測 duration へフォールバック（viewer 側が累積する）。
    const mp4s = s.mp4s || [];
    const hasVideo = mp4s.length > 0;
    let playback = null;
    if (hasVideo) {
      const meta = parseSegmentedMeta(jsonText);
      const list = buildSegmentPlaylist(mp4s, meta); // [{id, name, baseOffsetSec}]
      // src の解決は buildPlayback に閉じ込める。SW ストリーミングでは
      // セグメントを解決するたびにトークンを渡し直す（SW はアイドルで停止され
      // メモリ上のトークンを失うため、10分境界の切替が 401 になるのを防ぐ）。
      playback = buildPlayback(list, {
        swStreaming,
        sendToken: sendTokenToSW,
        buildMediaUrl,
        downloadBlobUrl: (id) => downloadBlobUrl(id, (loaded, total) => {
          const pct = total ? Math.round((loaded / total) * 100) : null;
          setStatus(`動画ダウンロード中… ${pct !== null ? pct + "%" : Math.round(loaded / 1e6) + "MB"}`);
        }),
      });
    }
    const model = buildViewModel(csvText, kmlText, jsonText, hasVideo);
    renderViewer(model, playback);
    setStatus(`${s.dateLabel} ${s.timeLabel}`);
  } catch (e) {
    if (seq !== opSeq) return;
    setError(String(e.message || e));
    setStatus("");
  }
}

function wire() {
  initAuth();
  // トークンが更新されたら(自動ログイン・401回復とも) SW にも新トークンを届ける。
  // 動画ストリーミング中のセグメント切替が古いトークンで 401 になるのを防ぐ。
  onTokenRefreshed(() => { sendTokenToSW(); });
  onTokenExpired(() => setError("認証の有効期限が切れました。再度ログインしてください。"));
  $("login").addEventListener("click", async () => {
    try {
      setError("");
      await signIn();
      $("login").textContent = "再読み込み";
      await loadDates();
    } catch (e) {
      setError(String(e.message || e));
    }
  });
  panel = createSessionPanel({
    listEl: document.getElementById("panel-list"),
    loadSessions: (d) => fetchSessionsForDate(d).catch((e) => { setError(String(e.message || e)); return []; }),
    onSelect: (s) => { openSession(s); },
  });
  document.getElementById("panel-toggle").addEventListener("click", () => {
    document.getElementById("panel").classList.toggle("closed");
  });
}

// 一度許可済みなら、ページを開いただけで無操作の再認証を試す。
// 成功: ログイン操作なしでそのまま走行日リストを表示(ボタンは再読み込みに変わる)。
// 失敗: 何も表示を変えない(従来どおりログインボタンから)。
async function tryAutoSignIn() {
  if (!isGranted()) return;
  setStatus("自動ログイン中…");
  const tok = await silentSignIn();
  if (!tok) { setStatus(""); return; }
  $("login").textContent = "再読み込み";
  await loadDates();
}

setupServiceWorker();
whenGisReady(() => {
  wire();
  tryAutoSignIn().catch((e) => { setStatus(""); setError(String(e.message || e)); });
});
