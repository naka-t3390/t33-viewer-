import { CONFIG } from "./config.js";
import { initAuth, signIn, onTokenExpired } from "./auth.js";
import { findFolderId, listChildren, downloadText, downloadBlobUrl } from "./drive.js";
import { selectDateFolders, partitionDateChildren, groupSessions, buildViewModel } from "./parse.js";
import { renderViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $("status").textContent = msg || ""; };
const setError = (msg) => { $("error").textContent = msg || ""; };

let dates = [];     // [{id, name, label}] 走行日（最新が先頭）
let sessions = [];  // 選択中の走行日のセッション（groupSessions の結果）
let opSeq = 0;      // 非同期レースガード：最新の日付/時刻操作のみ反映する連番

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
    let videoSrc = null;
    if (s.mp4) {
      videoSrc = await downloadBlobUrl(s.mp4, (loaded, total) => {
        const pct = total ? Math.round((loaded / total) * 100) : null;
        setStatus(`動画ダウンロード中… ${pct !== null ? pct + "%" : Math.round(loaded / 1e6) + "MB"}`);
      });
      if (seq !== opSeq) { URL.revokeObjectURL(videoSrc); return; } // 破棄時は blob を解放
    }
    const model = buildViewModel(csvText, kmlText, jsonText, Boolean(s.mp4));
    renderViewer(model, videoSrc);
    setStatus(`${s.dateLabel} ${s.timeLabel}`);
  } catch (e) {
    if (seq !== opSeq) return;
    setError(String(e.message || e));
    setStatus("");
  }
}

function wire() {
  initAuth();
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

whenGisReady(wire);
