import { CONFIG } from "./config.js";

const GRANTED_KEY = "t33_auth_granted";

let tokenClient = null;
let accessToken = null;
let expiredCb = null;
const refreshedCbs = [];

// localStorage はプライベートモード等で例外になりうるため安全に包む。
// 保存するのは「許可済みか」のフラグのみ。トークンは絶対に永続化しない。
function readGranted() {
  try { return localStorage.getItem(GRANTED_KEY) === "1"; } catch { return false; }
}
function writeGranted() {
  try { localStorage.setItem(GRANTED_KEY, "1"); } catch { /* 保存不可でも致命ではない */ }
}

export function isGranted() {
  return readGranted();
}

export function onTokenRefreshed(cb) {
  refreshedCbs.push(cb);
}

function notifyRefreshed(token) {
  for (const cb of refreshedCbs) cb(token);
}

// google.accounts.oauth2 は index.html で読み込む GIS スクリプトが提供するグローバル。
export function initAuth() {
  // eslint-disable-next-line no-undef
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,
    callback: () => {},       // requestToken で都度差し替える
    error_callback: () => {}, // 同上
  });
}

// prompt:"" で取得を試みる共通処理。resolve は必ず {token}|{error} のどちらか(拒否しない)。
// prompt:"" は「Google 側が必要なときだけ UI を出す」— セッション有り+許可済みなら無操作、
// 未許可なら同意画面、未ログインならアカウント選択が出る(初回サインインの導線を兼ねる)。
function requestToken() {
  return new Promise((resolve) => {
    if (!tokenClient) { resolve({ error: "initAuth() を先に呼んでください" }); return; }
    tokenClient.callback = (resp) => {
      if (resp && resp.access_token) resolve({ token: resp.access_token });
      else resolve({ error: (resp && resp.error) || "unknown" });
    };
    tokenClient.error_callback = (err) => {
      resolve({ error: (err && err.type) || "popup_error" });
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

// ボタンからの明示ログイン。失敗は reject(呼び出し側がエラー表示)。成功でフラグ保存。
export async function signIn() {
  const r = await requestToken();
  if (r.error) throw new Error(r.error);
  accessToken = r.token;
  writeGranted();
  notifyRefreshed(accessToken);
  return accessToken;
}

// ページ読込時・401 リトライ用の無操作(サイレント)取得。失敗しても例外を出さず null。
export async function silentSignIn() {
  const r = await requestToken();
  if (r.error) return null;
  accessToken = r.token;
  writeGranted();
  notifyRefreshed(accessToken);
  return accessToken;
}

export function getToken() {
  return accessToken;
}

export function onTokenExpired(cb) {
  expiredCb = cb;
}

// drive.js から 401 時(リトライ不成立後)に呼ぶ。
export function notifyExpired() {
  accessToken = null;
  if (expiredCb) expiredCb();
}
