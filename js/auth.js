import { CONFIG } from "./config.js";

let tokenClient = null;
let accessToken = null;
let expiredCb = null;

// google.accounts.oauth2 は index.html で読み込む GIS スクリプトが提供するグローバル。
export function initAuth() {
  // eslint-disable-next-line no-undef
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,
    callback: () => {}, // signIn で都度差し替える
  });
}

export function signIn() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error("initAuth() を先に呼んでください"));
      return;
    }
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error));
        return;
      }
      accessToken = resp.access_token;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
}

export function getToken() {
  return accessToken;
}

export function onTokenExpired(cb) {
  expiredCb = cb;
}

// drive.js から 401 時に呼ぶ。
export function notifyExpired() {
  accessToken = null;
  if (expiredCb) expiredCb();
}
