# t33-viewer 全面改修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 走行記録ビューアの3課題を解消する — ③毎回のGoogle同意画面を初回のみに / ②ヘッドアップ時も地図文字を正立 / ①増え続けるセッションをサイドパネルで選択。

**Architecture:** 純静的サイト(GitHub Pages)のまま。③はGIS `prompt:""` によるサイレント再認証＋401時の自動リトライ。②はLeaflet(ラスター)→MapLibre GL JS(ベクター)移行で回転をネイティブ化。①は新規 `js/panel.js` に日付グループ＋遅延読み込みのセッションリストを実装。

**Tech Stack:** Vanilla JS (ES modules, ビルド無し) / MapLibre GL JS (CDN) / OpenFreeMap Liberty スタイル / Google Identity Services (token client) / node:test

**Spec:** `docs/superpowers/specs/2026-07-12-viewer-overhaul-design.md`

## Global Constraints

- リポジトリ: `~/Documents/t33-viewer`（作業・テスト・コミットすべてここ。Torque2 ではない）
- テスト実行: `cd ~/Documents/t33-viewer && node --test`（全テスト緑を維持）
- トークン・PII を localStorage/コード/ログに保存しない（保存してよいのは許可済みフラグ `t33_auth_granted` のみ）
- OAuth スコープは `drive.readonly` から変更しない。`js/config.js` の CLIENT_ID 変更なし
- `sw.js` / `js/media-range.js` / `js/lifecycle.js` は変更しない
- 座標系注意: Leaflet は `[lat, lon]`、**MapLibre は `[lon, lat]`**。取り違えると海上に描画される
- CDN 追加時は SRI (integrity) ハッシュを付ける（実装時に `openssl dgst -sha384` で算出）
- コミットは各タスク末尾で実施。**push は各フェーズ完了時にユーザー確認を得てから**
- コミットフッター: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## Phase 1: サイレント再認証（③）

### Task 1: auth.js — サイレント取得と許可済みフラグ

**Files:**
- Modify: `js/auth.js`（全面書き換えに近い）
- Test: `tests/auth.test.js`（新規）

**Interfaces:**
- Consumes: グローバル `google.accounts.oauth2`（GISスクリプト）、`localStorage`
- Produces（後続タスクが依存する公開API）:
  - `initAuth(): void`（既存維持）
  - `signIn(): Promise<string>`（既存維持・ボタン用。成功時にフラグ保存へ変更）
  - `silentSignIn(): Promise<string|null>`（新規。無操作取得。失敗は null、reject しない）
  - `isGranted(): boolean`（新規。過去に許可済みか）
  - `onTokenRefreshed(cb: (token:string)=>void): void`（新規。トークン取得成功のたび通知）
  - `getToken(): string|null` / `onTokenExpired(cb)` / `notifyExpired()`（既存維持）

- [ ] **Step 1: 失敗するテストを書く**

`tests/auth.test.js` を新規作成:

```js
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd ~/Documents/t33-viewer && node --test tests/auth.test.js`
Expected: FAIL（`silentSignIn`/`isGranted`/`onTokenRefreshed` は export されていない）

- [ ] **Step 3: auth.js を実装**

`js/auth.js` を以下の内容に置き換える:

```js
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/auth.test.js`
Expected: PASS（7件）。続けて `node --test` で全体も緑を確認。

- [ ] **Step 5: Commit**

```bash
git add js/auth.js tests/auth.test.js
git commit -m "feat(auth): サイレント再認証(prompt空)と許可済みフラグを追加"
```

### Task 2: drive.js — 401 でサイレント再取得して1回だけ再試行

**Files:**
- Modify: `js/drive.js`（`authedFetch` を注入可能な `fetchWithAuthRetry` に変更）
- Test: `tests/drive.test.js`（新規）

**Interfaces:**
- Consumes: Task 1 の `getToken` / `silentSignIn` / `notifyExpired`
- Produces: `fetchWithAuthRetry(url, options?, deps?): Promise<Response>` を export
  （deps = `{ getToken, silentSignIn, notifyExpired, fetchFn }`、省略時は実物。
  既存の `findFolderId`/`listChildren`/`downloadText`/`downloadBlobUrl` の挙動・シグネチャは不変）

- [ ] **Step 1: 失敗するテストを書く**

`tests/drive.test.js` を新規作成:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithAuthRetry } from "../js/drive.js";

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

test("200: そのまま返す(サイレント再取得しない)", async () => {
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

test("401→サイレント成功→新トークンで再試行し成功", async () => {
  const f = fakeFetch([unauthorized, ok]);
  const res = await fetchWithAuthRetry("u", {}, {
    getToken: () => "old", silentSignIn: async () => "new",
    notifyExpired: () => {}, fetchFn: f,
  });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].auth, "Bearer new");
});

test("401→サイレント失敗→notifyExpired して throw", async () => {
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

test("401→サイレント成功→再試行も401→notifyExpired して throw(無限ループしない)", async () => {
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

test("401以外のエラーはステータス付きで throw", async () => {
  const f = fakeFetch([{ ok: false, status: 500, statusText: "ISE" }]);
  await assert.rejects(
    fetchWithAuthRetry("u", {}, {
      getToken: () => "t", silentSignIn: async () => null,
      notifyExpired: () => {}, fetchFn: f,
    }),
    /500/
  );
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/drive.test.js`
Expected: FAIL（`fetchWithAuthRetry` は export されていない）

- [ ] **Step 3: drive.js を実装**

`js/drive.js` の import と `authedFetch` を次のように変更（`findFolderId` 以下の関数は不変）:

```js
import { getToken, silentSignIn, notifyExpired } from "./auth.js";

const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

export function buildListQuery(parentId) {
  return `'${parentId}' in parents and trashed=false`;
}

// 認証付き fetch。401 のときはサイレント再認証を1回だけ試し、成功したら同リクエストを
// 新トークンで再試行する(トークン失効の自動回復)。それでもダメなら従来のエラー。
// deps はテスト用の注入点(lifecycle.js と同じ流儀)。実行時は省略して実物を使う。
export async function fetchWithAuthRetry(url, options = {}, deps = {}) {
  const d = {
    getToken, silentSignIn, notifyExpired,
    fetchFn: (...a) => fetch(...a),
    ...deps,
  };
  const doFetch = (token) => d.fetchFn(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  let res = await doFetch(d.getToken());
  if (res.status === 401) {
    const fresh = await d.silentSignIn(); // 失敗時は null(例外にしない)
    if (fresh) res = await doFetch(fresh);
    if (!fresh || res.status === 401) {
      d.notifyExpired();
      throw new Error("認証の有効期限が切れました。再ログインしてください。");
    }
  }
  if (!res.ok) {
    throw new Error(`Drive API エラー: ${res.status} ${res.statusText}`);
  }
  return res;
}

async function authedFetch(url, options = {}) {
  return fetchWithAuthRetry(url, options);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test`
Expected: 全テスト PASS（drive 5件 + auth 7件 + 既存分）

- [ ] **Step 5: Commit**

```bash
git add js/drive.js tests/drive.test.js
git commit -m "feat(drive): 401でサイレント再認証して1回だけ自動再試行"
```

### Task 3: app.js — 起動時の自動ログイン結線＋SWへのトークン再送

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: Task 1 の `isGranted`/`silentSignIn`/`onTokenRefreshed`、既存 `sendTokenToSW`/`loadDates`
- Produces: なし（結線のみ。外部挙動: フラグありなら自動でデータ表示）

- [ ] **Step 1: app.js の import と wire() を変更**

import 行を変更:

```js
import { initAuth, signIn, onTokenExpired, getToken, isGranted, silentSignIn, onTokenRefreshed } from "./auth.js";
```

`wire()` 内の `initAuth();` の直後に追記:

```js
  // トークンが更新されたら(自動ログイン・401回復とも) SW にも新トークンを届ける。
  // 動画ストリーミング中のセグメント切替が古いトークンで 401 になるのを防ぐ。
  onTokenRefreshed(() => { sendTokenToSW(); });
```

`wire()` の後に関数を1つ追加:

```js
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
```

ファイル末尾の起動部を変更:

```js
setupServiceWorker();
whenGisReady(() => { wire(); tryAutoSignIn(); });
```

- [ ] **Step 2: 全テストとローカル起動確認**

Run: `node --test`
Expected: 全 PASS

Run: `python3 -m http.server 8799` → ブラウザで `http://localhost:8799/`
Expected: フラグ未保存のため従来どおり「Google でログイン」ボタン表示・コンソールエラーなし
（サイレント成功パスは本番 URL + Google セッションでのみ検証可能）

- [ ] **Step 3: Commit（Phase 1 完了）**

```bash
git add js/app.js
git commit -m "feat(app): 起動時サイレント自動ログインとSWへのトークン再送を結線"
```

**Phase 1 完了時: ユーザーに push 可否を確認 → push → 本番URLで「2回目以降はログイン操作不要」をユーザー検証**

---

## Phase 2: MapLibre GL JS 移行（②）

### Task 4: CDN 差し替え（index.html / _verify_layout.html）

**Files:**
- Modify: `index.html`（Leaflet の link/script → MapLibre）
- Modify: `_verify_layout.html`（同上）

**Interfaces:**
- Produces: グローバル `window.maplibregl`（Task 5 が使用）。Leaflet の `window.L` は消える

- [ ] **Step 1: MapLibre の最新5系バージョンと SRI ハッシュを確認**

```bash
# 最新の 5 系を解決（リダイレクト先 URL にバージョンが出る）
curl -sIL -o /dev/null -w "%{url_effective}\n" https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js
# 表示されたバージョン(例 5.6.1)で JS/CSS の SRI を算出
V=5.6.1  # ↑の実際の値に置き換える
curl -s https://unpkg.com/maplibre-gl@$V/dist/maplibre-gl.js  | openssl dgst -sha384 -binary | openssl base64 -A; echo
curl -s https://unpkg.com/maplibre-gl@$V/dist/maplibre-gl.css | openssl dgst -sha384 -binary | openssl base64 -A; echo
```

- [ ] **Step 2: index.html の CDN を差し替え**

head 内の Leaflet CSS link を削除し、以下に置換（`$V`/`ハッシュ` は Step 1 の実値）:

```html
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@$V/dist/maplibre-gl.css"
      integrity="sha384-［CSSのハッシュ］" crossorigin="anonymous">
```

body 末尾の Leaflet JS script を削除し、以下に置換:

```html
<script src="https://unpkg.com/maplibre-gl@$V/dist/maplibre-gl.js"
        integrity="sha384-［JSのハッシュ］" crossorigin="anonymous"></script>
```

`_verify_layout.html` にも同じ差し替えを行う。

- [ ] **Step 3: Commit**

```bash
git add index.html _verify_layout.html
git commit -m "build(map): Leaflet CDN を MapLibre GL JS に差し替え"
```

### Task 5: viewer.js の地図ブロックを MapLibre 実装へ置換

**Files:**
- Modify: `js/viewer.js`（地図生成〜ボタンの一帯と、`update()`/`fit()` の地図参照）
- Modify: `js/geo.js` / `tests/geo.test.js`（coverSquareSize 削除）
- Modify: `css/style.css`（Leaflet 用ルール削除・car-marker 追加）

**Interfaces:**
- Consumes: Task 4 の `window.maplibregl`、既存 `geo.js` の `headingAt`、`lifecycle.replaceMap`
- Produces: `renderViewer(model, playback)` の外部挙動は不変（地図の見た目のみ変わる）

- [ ] **Step 1: import から coverSquareSize を外す**

```js
import { headingAt } from "./geo.js";
```

- [ ] **Step 2: 地図ブロック全体を置換**

`let applyMapView = () => {};` の宣言から `} else {` の直前までを以下に置換。
`headUpOnResize` の外側宣言（`let headUpOnResize = () => {};`）と
`fit()` 内の `headUpOnResize()` 呼び出しは**削除**する
（MapLibre は ResizeObserver で自動リサイズし、bearing は枠サイズと無関係のため不要）:

```js
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
    const MIN_MOVE_M = 5;   // これ未満の移動は停車とみなし直前の方位を保持する
    const HEADUP_ZOOM = 17; // ヘッドアップ時は自車周辺を拡大表示する
    let headUp = false;
    let lastBearing = 0;    // 最後に確定した進行方位(停車中の保持用)

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
      lmap.jumpTo({ center: carLngLatAt(t), zoom: HEADUP_ZOOM, bearing: lastBearing });
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

    function toNorthUp() {
      headUp = false;
      headBtn.classList.remove("active");
      headBtn.textContent = HeadLabel;
      lmap.fitBounds(bounds, { padding: 24, bearing: 0 });
    }
    fitBtn.addEventListener("click", toNorthUp);
    headBtn.addEventListener("click", () => {
      if (headUp) { toNorthUp(); return; }
      headUp = true;
      headBtn.classList.add("active");
      headBtn.textContent = NorthLabel; // 次に戻せる状態を表示
      applyHeadUp(globalTime());
    });
```

- [ ] **Step 3: update() と fit() の地図参照を MapLibre API に変更**

`update()` 内のマーカー更新を変更（[lon, lat] 順に注意）:

```js
    if (lmarker) {
      const j = nearest(trackTimes, t);
      if (j >= 0) lmarker.setLngLat([track[j].lon, track[j].lat]);
    }
```

`fit()` の `lmap.invalidateSize()` を `lmap.resize()` に変更:

```js
  function fit() { cv.width = cv.clientWidth; cv.height = cv.clientHeight; if (lmap) lmap.resize(); draw(globalTime()); }
```

- [ ] **Step 4: geo.js から coverSquareSize を削除**

`js/geo.js` の `coverSquareSize` 関数（コメント3行+本体3行）を削除。
`tests/geo.test.js` の import から `coverSquareSize` を外し、`coverSquareSize:` で始まる4テスト（説明コメント2行含む）を削除。

- [ ] **Step 5: CSS を更新**

`css/style.css` から以下の3ルールを削除:
- `#map .map-canvas { ... }`（直前のコメント2行含む）
- `#map .leaflet-control-attribution { ... }`
- `#map .leaflet-map-pane { will-change:transform; }`（直前のコメント1行含む）

以下を `.map-btns` ルールの直後に追加:

```css
/* 自車マーカー(MapLibre Marker の DOM 要素) */
.car-marker { width:14px; height:14px; border-radius:50%; background:#d64545;
              border:2px solid #fff; box-shadow:0 1px 4px rgba(0,0,0,.45); }
#map .maplibregl-ctrl-attrib { font-size:10px; }
```

- [ ] **Step 6: テストとブラウザ実描画確認**

Run: `node --test`
Expected: 全 PASS（geo は coverSquareSize の4件が減る）

Run: `python3 -m http.server 8799` → `http://localhost:8799/_verify_layout.html`
→「セッション1描画(広域)」→ 確認項目:
1. ベクター地図が全幅表示・軌跡青線・自車赤丸
2. 「⬆ 進行方向を上」→ 回転しても**地名・道路名が正立**して読める（今回の主目的）
3. 「⬆ 北を上」で復帰、「全体を表示」で全体フィット
4. コンソールエラーなし

- [ ] **Step 7: Commit（Phase 2 完了）**

```bash
git add js/viewer.js js/geo.js tests/geo.test.js css/style.css
git commit -m "feat(map): MapLibre GL JSへ移行しヘッドアップでも文字を正立表示"
```

**Phase 2 完了時: ユーザーに push 可否を確認 → push → 本番で見た目確認**

---

## Phase 3: セッションサイドパネル（①）

### Task 6: parse.js — セッションカード表示メタの純粋関数

**Files:**
- Modify: `js/parse.js`（末尾に追記）
- Test: `tests/parse.test.js`（既存ファイルに追記。無ければ新規作成し既存の流儀に合わせる）

**Interfaces:**
- Consumes: `groupSessions` が返すセッション形 `{stem, dateLabel, timeLabel, csv, kml, mp4s, json}`
- Produces: `sessionCardMeta(session): { timeLabel: string, hasVideo: boolean, approxMin: number|null }`

- [ ] **Step 1: 失敗するテストを書く**（parse テストファイルに追記）

```js
import { sessionCardMeta } from "../js/parse.js"; // 既存 import に追加

test("sessionCardMeta: 動画なしは hasVideo=false, approxMin=null", () => {
  const meta = sessionCardMeta({ timeLabel: "09:15:00", mp4s: [] });
  assert.deepEqual(meta, { timeLabel: "09:15:00", hasVideo: false, approxMin: null });
});

test("sessionCardMeta: セグメント3本で約30分", () => {
  const meta = sessionCardMeta({ timeLabel: "10:00:00", mp4s: [{}, {}, {}] });
  assert.deepEqual(meta, { timeLabel: "10:00:00", hasVideo: true, approxMin: 30 });
});

test("sessionCardMeta: mp4s が配列でなくても安全", () => {
  const meta = sessionCardMeta({ timeLabel: "11:00:00", mp4s: null });
  assert.deepEqual(meta, { timeLabel: "11:00:00", hasVideo: false, approxMin: null });
});
```

- [ ] **Step 2: 失敗を確認** → Run: `node --test tests/parse.test.js` / Expected: FAIL

- [ ] **Step 3: parse.js 末尾に実装**

```js
// サイドパネルのセッションカード表示用メタ。動画は10分セグメント分割なので
// おおよその記録時間 = セグメント数 × 10分（最終セグメントは短い可能性あり）。
export function sessionCardMeta(session) {
  const n = Array.isArray(session.mp4s) ? session.mp4s.length : 0;
  return {
    timeLabel: session.timeLabel,
    hasVideo: n > 0,
    approxMin: n > 0 ? n * 10 : null,
  };
}
```

- [ ] **Step 4: 通過を確認** → Run: `node --test` / Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add js/parse.js tests/parse.test.js
git commit -m "feat(parse): セッションカード表示メタ sessionCardMeta を追加"
```

### Task 7: panel.js — サイドパネル本体（新規モジュール）

**Files:**
- Create: `js/panel.js`

**Interfaces:**
- Consumes: Task 6 の `sessionCardMeta`、呼び出し側から注入される
  `loadSessions(date): Promise<Session[]>`（date は `{id,name,label}`）と
  `onSelect(session): void`
- Produces: `createSessionPanel({ listEl, loadSessions, onSelect })` →
  `{ setDates(dates): void, expandDate(date, opts?): Promise<Session[]>, markSelected(stem): void }`

- [ ] **Step 1: js/panel.js を作成**

```js
// 走行記録サイドパネル。日付グループ(新しい順)→セッションカードの2階層リスト。
// Drive アクセスは持たず、loadSessions コールバック経由(遅延読み込み+ここでキャッシュ)。
import { sessionCardMeta } from "./parse.js";

export function createSessionPanel({ listEl, loadSessions, onSelect }) {
  const cache = new Map();       // dateId -> Session[]
  const sessionsBox = new Map(); // dateId -> カード挿入先 DOM
  let selectedStem = null;

  function cardLabel(meta) {
    const video = meta.hasVideo ? ` 🎬 約${meta.approxMin}分` : " (動画なし)";
    return `${meta.timeLabel}${video}`;
  }

  function renderCards(dateId, sessions) {
    const box = sessionsBox.get(dateId);
    if (!box) return;
    box.textContent = "";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-empty";
      empty.textContent = "セッションなし";
      box.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "session-card";
      btn.dataset.stem = s.stem;
      btn.textContent = cardLabel(sessionCardMeta(s));
      if (s.stem === selectedStem) btn.classList.add("active");
      btn.addEventListener("click", () => { markSelected(s.stem); onSelect(s); });
      box.appendChild(btn);
    }
  }

  // 日付グループを展開(初回は loadSessions で取得してキャッシュ)。取得結果を返す。
  async function expandDate(date, { autoSelectFirst = false } = {}) {
    const box = sessionsBox.get(date.id);
    if (box) box.classList.remove("hidden");
    let sessions = cache.get(date.id);
    if (!sessions) {
      if (box) box.textContent = "読み込み中…";
      sessions = await loadSessions(date);
      cache.set(date.id, sessions);
      renderCards(date.id, sessions);
    }
    if (autoSelectFirst && sessions.length > 0) {
      markSelected(sessions[0].stem);
      onSelect(sessions[0]);
    }
    return sessions;
  }

  function setDates(dates) {
    listEl.textContent = "";
    cache.clear();
    sessionsBox.clear();
    for (const d of dates) {
      const group = document.createElement("div");
      group.className = "panel-group";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "panel-date";
      head.textContent = d.label;
      const box = document.createElement("div");
      box.className = "panel-sessions hidden";
      sessionsBox.set(d.id, box);
      head.addEventListener("click", () => {
        if (box.classList.contains("hidden")) expandDate(d);
        else box.classList.add("hidden"); // 再クリックで折りたたみ(キャッシュは保持)
      });
      group.appendChild(head);
      group.appendChild(box);
      listEl.appendChild(group);
    }
  }

  function markSelected(stem) {
    selectedStem = stem;
    for (const el of listEl.querySelectorAll(".session-card")) {
      el.classList.toggle("active", el.dataset.stem === stem);
    }
  }

  return { setDates, expandDate, markSelected };
}
```

- [ ] **Step 2: Commit**

```bash
git add js/panel.js
git commit -m "feat(panel): 日付グループ+遅延読み込みのセッションサイドパネルを追加"
```

### Task 8: index.html / CSS — 2カラムレイアウトとパネル開閉

**Files:**
- Modify: `index.html`（select 2つを撤去、パネル開閉ボタンと aside 追加）
- Modify: `css/style.css`（レイアウト・パネル・カードのスタイル）

**Interfaces:**
- Produces: DOM 要素 `#panel-toggle`（開閉ボタン）、`#panel`（aside）、`#panel-list`（リスト挿入先）。
  Task 9 の app.js がこれらを参照する

- [ ] **Step 1: index.html の header と body 構造を変更**

header 内の `<select id="date" class="hidden"></select>` と
`<select id="session" class="hidden"></select>` の2行を削除し、
`<h1>` の直後に開閉ボタンを追加:

```html
  <button id="panel-toggle" type="button" title="記録一覧を開閉">☰ 記録</button>
```

body の `<div id="error">` から `<div id="map" ...>` までを `.layout`/`.main` で包む:

```html
<div class="layout">
  <aside id="panel" class="closed">
    <div id="panel-list"></div>
  </aside>
  <div class="main">
    <div id="error"></div>
    <div id="warnings" class="warn"></div>
    <div class="gaugebar"> …(既存のまま)… </div>
    <div class="mid"> …(既存のまま)… </div>
    <div id="map" class="nomap"></div>
  </div>
</div>
```

- [ ] **Step 2: css/style.css にレイアウトとパネルのスタイルを追加**

```css
/* 2カラム: 左サイドパネル(開閉) + 右メイン */
.layout { display:flex; align-items:stretch; }
.main { flex:1 1 0; min-width:0; }
#panel { width:232px; flex:0 0 auto; background:#efe7d4; border-right:1px solid #e3dac6;
         padding:10px 10px 24px; overflow-y:auto; max-height:calc(100vh - 58px); }
#panel.closed { display:none; }
.panel-group { margin-bottom:6px; }
.panel-date { display:block; width:100%; text-align:left; font-weight:700; font-size:.92rem;
              background:#fbf8f1; border:1px solid #c9a227; border-radius:8px; padding:7px 10px; }
.panel-sessions { display:flex; flex-direction:column; gap:4px; padding:6px 0 2px 10px; }
.session-card { display:block; width:100%; text-align:left; font-size:.88rem;
                background:#fbf8f1; border:1px solid #e3dac6; border-radius:8px; padding:6px 10px; }
.session-card.active { background:#2563c9; border-color:#1c4ea0; color:#fff; }
.panel-empty { color:#877c69; font-size:.85rem; padding:4px 2px; }
/* 狭い画面ではオーバーレイ表示 */
@media (max-width:760px) {
  #panel { position:fixed; left:0; top:58px; bottom:0; z-index:2000; max-height:none;
           box-shadow:2px 0 12px rgba(0,0,0,.25); }
}
```

- [ ] **Step 3: Commit**

```bash
git add index.html css/style.css
git commit -m "feat(ui): サイドパネル用2カラムレイアウトとカードスタイルを追加"
```

### Task 9: app.js — パネル結線（プルダウン撤去）

**Files:**
- Modify: `js/app.js`（`loadDates`/`loadSessions`/`openSession`/`wire` の再構成）
- Modify: `_verify_layout.html`（パネル検証の追加）

**Interfaces:**
- Consumes: Task 7 の `createSessionPanel`、Task 8 の `#panel`/`#panel-list`/`#panel-toggle`
- Produces: なし（外部挙動: 初回は最新日を自動展開し先頭セッションを自動選択＝従来と同じ）

- [ ] **Step 1: app.js を変更**

import に追加:

```js
import { createSessionPanel } from "./panel.js";
```

モジュール状態を変更（`dates`/`sessions` 変数の宣言部。`sessions` 変数は削除）:

```js
let dates = [];   // [{id, name, label}] 走行日（最新が先頭）
let panel = null; // createSessionPanel の戻り値
let opSeq = 0;    // 非同期レースガード：最新の操作のみ反映する連番
```

`loadDates()` の select 操作部分（`const dateSel = $("date");` 以降〜末尾）を置換:

```js
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
```

`loadSessions(dateIndex)` 関数全体を「取得だけ」の関数に置換（DOM操作なし。パネルから呼ばれる）:

```js
// 走行日の全ファイルを取得してセッションにまとめる(パネルの遅延読み込みから呼ばれる)。
async function fetchSessionsForDate(d) {
  const children = await listChildren(d.id);
  const { timeFolders, directFiles } = partitionDateChildren(children);
  let files = [...directFiles]; // 旧フラット構成の後方互換
  for (const tf of timeFolders) {
    files = files.concat(await listChildren(tf.id));
  }
  return groupSessions(files);
}
```

`openSession(index)` を `openSession(s)`（セッションオブジェクト直接受け）に変更。
関数先頭の `const s = sessions[index];` を削除し、シグネチャを `async function openSession(s)` に。
（中身の CSV/KML/動画読み込み・レースガード `seq !== opSeq` はそのまま）

`wire()` 内の `$("date")`/`$("session")` の addEventListener 2行を削除し、以下に置換:

```js
  panel = createSessionPanel({
    listEl: document.getElementById("panel-list"),
    loadSessions: (d) => fetchSessionsForDate(d).catch((e) => { setError(String(e.message || e)); return []; }),
    onSelect: (s) => { openSession(s); },
  });
  document.getElementById("panel-toggle").addEventListener("click", () => {
    document.getElementById("panel").classList.toggle("closed");
  });
```

- [ ] **Step 2: 全テスト確認**

Run: `node --test`
Expected: 全 PASS

- [ ] **Step 3: ハーネスにパネル検証を追加**

`_verify_layout.html` の header に `<button id="panel-toggle" type="button">☰ 記録</button>` を追加し、
body に Task 8 と同じ `.layout`/`#panel`/`#panel-list`/`.main` 構造を追加する
（`#error`〜`#map` を `.main` で包む）。
`<script type="module">` 内に以下を追記して、モック日付2日×セッション計3件でパネルを駆動:

```js
import { createSessionPanel } from "./js/panel.js";
const mockSessions = {
  d1: [
    { stem: "t33_20260711_090000", timeLabel: "09:00:00", mp4s: [{}, {}] },
    { stem: "t33_20260711_140000", timeLabel: "14:00:00", mp4s: [] },
  ],
  d2: [ { stem: "t33_20260628_100000", timeLabel: "10:00:00", mp4s: [{}] } ],
};
const panel = createSessionPanel({
  listEl: document.getElementById("panel-list"),
  loadSessions: async (d) => mockSessions[d.id] || [],
  onSelect: (s) => { status.textContent = `選択: ${s.stem}`; renderViewer(M, null); },
});
panel.setDates([
  { id: "d1", name: "20260711", label: "2026-07-11" },
  { id: "d2", name: "20260628", label: "2026-06-28" },
]);
document.getElementById("panel").classList.remove("closed");
panel.expandDate({ id: "d1", name: "20260711", label: "2026-07-11" }, { autoSelectFirst: true });
document.getElementById("panel-toggle").onclick = () =>
  document.getElementById("panel").classList.toggle("closed");
```

- [ ] **Step 4: ブラウザ実描画確認**

Run: `python3 -m http.server 8799` → `http://localhost:8799/_verify_layout.html`
確認項目:
1. 左パネルに日付2グループ。最新日が展開済みで先頭カードがハイライト＋描画済み
2. カード表示: 「09:00:00 🎬 約20分」「14:00:00 (動画なし)」
3. 2日目クリック → 展開してカード表示（遅延読み込み）
4. カードクリックで選択切替＋ハイライト移動
5. ☰ボタンでパネル開閉。地図・グラフのレイアウト崩れなし
6. コンソールエラーなし

- [ ] **Step 5: Commit（Phase 3 完了）**

```bash
git add js/app.js _verify_layout.html
git commit -m "feat(app): セッション選択をサイドパネルに置き換え(プルダウン撤去)"
```

**Phase 3 完了時: ユーザーに push 可否を確認 → push → 本番でログイン→パネル→再生の一連をユーザー検証 → メモリ更新**
