import { CONFIG } from "./config.js";
import { initAuth, signIn, onTokenExpired, getToken, isGranted, silentSignIn, onTokenRefreshed } from "./auth.js";
import { findFolderId, listChildren, downloadText, downloadBlobUrl } from "./drive.js";
import { selectDateFolders, partitionDateChildren, groupSessions, buildViewModel, parseSegmentedMeta, buildSegmentPlaylist } from "./parse.js";
import { renderViewer } from "./viewer.js";
import { buildMediaUrl } from "./media-range.js";

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $("status").textContent = msg || ""; };
const setError = (msg) => { $("error").textContent = msg || ""; };

let dates = [];     // [{id, name, label}] 走行日（最新が先頭）
let sessions = [];  // 選択中の走行日のセッション（groupSessions の結果）
let opSeq = 0;      // 非同期レースガード：最新の日付/時刻操作のみ反映する連番
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
  const dateSel = $("date");
  const sessionSel = $("session");
  if (dates.length === 0) {
    dateSel.innerHTML = "";
    sessionSel.innerHTML = "";
    dateSel.classList.add("hidden");
    sessionSel.classList.add("hidden");
    setStatus("");
    setError("走行セッションが見つかりません。");
    return;
  }
  dateSel.innerHTML = "";
  dates.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = d.label;
    dateSel.appendChild(opt);
  });
  dateSel.classList.remove("hidden");
  dateSel.value = "0"; // 最新の走行日
  setStatus(`走行日 ${dates.length} 日`);
  await loadSessions(0);
}

// 走行日を選択：その日の時刻フォルダ＋ファイルを取得しセッション一覧を作る
async function loadSessions(dateIndex) {
  const seq = ++opSeq;
  setError("");
  const d = dates[dateIndex];
  setStatus(`${d.label} のセッションを取得中…`);
  const sessionSel = $("session");
  try {
    const children = await listChildren(d.id);
    if (seq !== opSeq) return; // 後続の操作に追い越されたら破棄
    const { timeFolders, directFiles } = partitionDateChildren(children);
    let files = [...directFiles]; // 旧フラット構成の後方互換
    for (const tf of timeFolders) {
      const more = await listChildren(tf.id);
      if (seq !== opSeq) return;
      files = files.concat(more);
    }
    sessions = groupSessions(files);
    if (sessions.length === 0) {
      sessionSel.classList.add("hidden");
      sessionSel.innerHTML = "";
      setStatus("");
      setError("その日のセッションが見つかりません。");
      return;
    }
    sessionSel.innerHTML = "";
    sessions.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = s.timeLabel;
      sessionSel.appendChild(opt);
    });
    sessionSel.classList.remove("hidden");
    sessionSel.value = "0"; // その日の最新
    setStatus(`${d.label}：${sessions.length} セッション`);
    await openSession(0);
  } catch (e) {
    if (seq !== opSeq) return;
    setError(String(e.message || e));
    setStatus("");
  }
}

// 時刻セッションを開く（描画は既存のまま）
async function openSession(index) {
  const seq = ++opSeq;
  setError("");
  const s = sessions[index];
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
      if (list.length > 0) {
        const segments = list.map((x) => ({ baseOffsetSec: x.baseOffsetSec }));
        if (swStreaming) {
          await sendTokenToSW();          // token 受領を待ってから src を張る（H2）
          if (seq !== opSeq) return;
          // Range ストリーミング: セグメントの仮想URLを都度返す（全DLしない）。
          playback = { segments, isBlob: false, resolveSrc: async (i) => buildMediaUrl(list[i].id) };
        } else {
          // 非SW フォールバック: 該当セグメントのみ blob として順次ダウンロードする。
          playback = {
            segments, isBlob: true,
            resolveSrc: (i) => downloadBlobUrl(list[i].id, (loaded, total) => {
              const pct = total ? Math.round((loaded / total) * 100) : null;
              setStatus(`動画ダウンロード中… ${pct !== null ? pct + "%" : Math.round(loaded / 1e6) + "MB"}`);
            }),
          };
        }
      }
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
  $("date").addEventListener("change", (e) => loadSessions(Number(e.target.value)));
  $("session").addEventListener("change", (e) => openSession(Number(e.target.value)));
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
