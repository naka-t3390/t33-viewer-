import { CONFIG } from "./config.js";
import { initAuth, signIn, onTokenExpired } from "./auth.js";
import { findFolderId, listChildren, downloadText, downloadBlobUrl } from "./drive.js";
import { groupSessions, buildViewModel } from "./parse.js";
import { renderViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $("status").textContent = msg || ""; };
const setError = (msg) => { $("error").textContent = msg || ""; };

let sessions = [];

// GIS スクリプトの読込完了を待ってから初期化
function whenGisReady(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) { cb(); return; }
  setTimeout(() => whenGisReady(cb), 100);
}

async function loadSessions() {
  setError("");
  setStatus("セッション一覧を取得中…");
  const rootId = await findFolderId(CONFIG.ROOT_FOLDER);
  if (!rootId) {
    setStatus("");
    setError(`Drive に「${CONFIG.ROOT_FOLDER}」フォルダが見つかりません。`);
    return;
  }
  const dateFolders = (await listChildren(rootId)).filter((f) => /^\d{8}$/.test(f.name));
  let allFiles = [];
  for (const df of dateFolders) {
    const children = await listChildren(df.id);
    allFiles = allFiles.concat(children);
  }
  sessions = groupSessions(allFiles);
  if (sessions.length === 0) {
    setStatus("");
    setError("走行セッションが見つかりません。");
    return;
  }
  const sel = $("session");
  sel.innerHTML = "";
  sessions.forEach((s, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${s.dateLabel} ${s.timeLabel}`;
    sel.appendChild(opt);
  });
  sel.classList.remove("hidden");
  sel.value = "0"; // 最新
  setStatus(`${sessions.length} 件`);
  await openSession(0);
}

async function openSession(index) {
  setError("");
  const s = sessions[index];
  setStatus(`${s.dateLabel} ${s.timeLabel} を読み込み中…`);
  try {
    const csvText = await downloadText(s.csv);
    const kmlText = s.kml ? await downloadText(s.kml) : "";
    const jsonText = s.json ? await downloadText(s.json) : "";
    let videoSrc = null;
    if (s.mp4) {
      videoSrc = await downloadBlobUrl(s.mp4, (loaded, total) => {
        const pct = total ? Math.round((loaded / total) * 100) : null;
        setStatus(`動画ダウンロード中… ${pct !== null ? pct + "%" : Math.round(loaded / 1e6) + "MB"}`);
      });
    }
    const model = buildViewModel(csvText, kmlText, jsonText, Boolean(s.mp4));
    renderViewer(model, videoSrc);
    setStatus(`${s.dateLabel} ${s.timeLabel}`);
  } catch (e) {
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
      await loadSessions();
    } catch (e) {
      setError(String(e.message || e));
    }
  });
  $("session").addEventListener("change", (e) => openSession(Number(e.target.value)));
}

whenGisReady(wire);
