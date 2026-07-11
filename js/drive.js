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

export async function findFolderId(name, parentId = null) {
  const folderMime = "application/vnd.google-apps.folder";
  const safeName = name.replace(/'/g, "\\'");
  let q = `name='${safeName}' and mimeType='${folderMime}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const url = `${FILES_ENDPOINT}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name)")}&spaces=drive`;
  const res = await authedFetch(url);
  const json = await res.json();
  return json.files && json.files.length > 0 ? json.files[0].id : null;
}

export async function listChildren(folderId) {
  const q = buildListQuery(folderId);
  const out = [];
  let pageToken = null;
  do {
    let url = `${FILES_ENDPOINT}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType)")}&pageSize=1000&spaces=drive`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const res = await authedFetch(url);
    const json = await res.json();
    for (const f of json.files || []) out.push({ id: f.id, name: f.name, mimeType: f.mimeType });
    pageToken = json.nextPageToken || null;
  } while (pageToken);
  return out;
}

export async function downloadText(fileId) {
  const url = `${FILES_ENDPOINT}/${fileId}?alt=media`;
  const res = await authedFetch(url);
  return res.text();
}

export async function downloadBlobUrl(fileId, onProgress) {
  const url = `${FILES_ENDPOINT}/${fileId}?alt=media`;
  const res = await authedFetch(url);
  const total = Number(res.headers.get("Content-Length") || 0);
  if (!res.body || !onProgress) {
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  return URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
}
