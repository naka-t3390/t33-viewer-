import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListQuery, fetchWithAuthRetry } from "../js/drive.js";

test("buildListQuery: 親フォルダ配下・未ゴミ箱の検索式", () => {
  assert.equal(
    buildListQuery("FOLDER123"),
    "'FOLDER123' in parents and trashed=false"
  );
});

// --- fetchWithAuthRetry: 401 でサイレント再認証して1回だけ再試行する ---

// fetch のフェイク: 呼び出しごとに用意したレスポンスを順に返す
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  fn.calls = calls;
  return fn;
}
const ok = { ok: true, status: 200 };
const unauthorized = { ok: false, status: 401, statusText: "Unauthorized" };

test("fetchWithAuthRetry: 200はそのまま返す(サイレント再取得しない)", async () => {
  let silent = 0;
  const f = fakeFetch([ok]);
  const res = await fetchWithAuthRetry("u", {}, {
    getToken: () => "t1", silentSignIn: async () => { silent++; return "t2"; },
    notifyExpired: () => {}, fetchFn: f,
  });
  assert.equal(res.status, 200);
  assert.equal(silent, 0);
  assert.equal(f.calls[0].auth, "Bearer t1");
});

test("fetchWithAuthRetry: 401→サイレント成功→新トークンで再試行し成功", async () => {
  const f = fakeFetch([unauthorized, ok]);
  const res = await fetchWithAuthRetry("u", {}, {
    getToken: () => "old", silentSignIn: async () => "new",
    notifyExpired: () => {}, fetchFn: f,
  });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].auth, "Bearer new");
});

test("fetchWithAuthRetry: 401→サイレント失敗→notifyExpired して throw", async () => {
  let expired = 0;
  const f = fakeFetch([unauthorized]);
  await assert.rejects(
    fetchWithAuthRetry("u", {}, {
      getToken: () => "old", silentSignIn: async () => null,
      notifyExpired: () => { expired++; }, fetchFn: f,
    }),
    /再ログイン/
  );
  assert.equal(expired, 1);
  assert.equal(f.calls.length, 1); // 再試行しない
});

test("fetchWithAuthRetry: 401→サイレント成功→再試行も401→throw(無限ループしない)", async () => {
  let expired = 0;
  const f = fakeFetch([unauthorized, unauthorized]);
  await assert.rejects(
    fetchWithAuthRetry("u", {}, {
      getToken: () => "old", silentSignIn: async () => "new",
      notifyExpired: () => { expired++; }, fetchFn: f,
    }),
    /再ログイン/
  );
  assert.equal(expired, 1);
  assert.equal(f.calls.length, 2);
});

test("fetchWithAuthRetry: 401以外のエラーはステータス付きで throw", async () => {
  const f = fakeFetch([{ ok: false, status: 500, statusText: "ISE" }]);
  await assert.rejects(
    fetchWithAuthRetry("u", {}, {
      getToken: () => "t", silentSignIn: async () => null,
      notifyExpired: () => {}, fetchFn: f,
    }),
    /500/
  );
});
