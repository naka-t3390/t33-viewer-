import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// auth.js はグローバル google / localStorage を参照するため、import 前にモックを差す。
// 動的 import + クエリ付きで毎テスト新モジュールにする(モジュール状態のリセット)。
let requestCalls = [];
let nextResponse = null; // tokenClient.callback へ渡すレスポンス
let nextError = null;    // error_callback へ渡すエラー

function installGoogleMock() {
  requestCalls = [];
  globalThis.google = {
    accounts: { oauth2: { initTokenClient: (cfg) => {
      const client = {
        callback: cfg.callback,
        error_callback: cfg.error_callback,
        requestAccessToken(opts) {
          requestCalls.push(opts);
          queueMicrotask(() => {
            if (nextError) client.error_callback(nextError);
            else client.callback(nextResponse);
          });
        },
      };
      return client;
    } } },
  };
}

function installStorageMock() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

let seq = 0;
async function freshAuth() {
  installGoogleMock();
  installStorageMock();
  const mod = await import(`../js/auth.js?t=${++seq}`);
  mod.initAuth();
  return mod;
}

beforeEach(() => { nextResponse = null; nextError = null; });

test("signIn: 成功でトークンを返し許可済みフラグを保存する", async () => {
  const auth = await freshAuth();
  assert.equal(auth.isGranted(), false);
  nextResponse = { access_token: "tok1" };
  const tok = await auth.signIn();
  assert.equal(tok, "tok1");
  assert.equal(auth.getToken(), "tok1");
  assert.equal(auth.isGranted(), true);
});

test("signIn: prompt は常に空文字(Google側が必要時のみUI表示)", async () => {
  const auth = await freshAuth();
  nextResponse = { access_token: "tok1" };
  await auth.signIn();
  assert.deepEqual(requestCalls[0], { prompt: "" });
});

test("silentSignIn: 成功でトークン、onTokenRefreshed が呼ばれる", async () => {
  const auth = await freshAuth();
  const refreshed = [];
  auth.onTokenRefreshed((t) => refreshed.push(t));
  nextResponse = { access_token: "tok2" };
  const tok = await auth.silentSignIn();
  assert.equal(tok, "tok2");
  assert.deepEqual(refreshed, ["tok2"]);
});

test("silentSignIn: GISエラー応答でも reject せず null", async () => {
  const auth = await freshAuth();
  nextResponse = { error: "interaction_required" };
  assert.equal(await auth.silentSignIn(), null);
});

test("silentSignIn: error_callback(ポップアップ失敗)でも null", async () => {
  const auth = await freshAuth();
  nextError = { type: "popup_failed_to_open" };
  assert.equal(await auth.silentSignIn(), null);
});

test("signIn 成功も onTokenRefreshed に通知される(SWへの再送用)", async () => {
  const auth = await freshAuth();
  const refreshed = [];
  auth.onTokenRefreshed((t) => refreshed.push(t));
  nextResponse = { access_token: "tok3" };
  await auth.signIn();
  assert.deepEqual(refreshed, ["tok3"]);
});

test("notifyExpired: トークンを破棄し expiredCb を呼ぶ", async () => {
  const auth = await freshAuth();
  nextResponse = { access_token: "tok4" };
  await auth.signIn();
  let called = 0;
  auth.onTokenExpired(() => { called++; });
  auth.notifyExpired();
  assert.equal(auth.getToken(), null);
  assert.equal(called, 1);
});
