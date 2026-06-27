// module service worker。Drive への Range 中継で動画を全DLせずストリーム再生する。
import {
  isMediaPath,
  parseMediaPath,
  buildDriveMediaUrl,
  buildDriveHeaders,
  buildClientResponseInit,
} from "./js/media-range.js";

let driveToken = null; // メモリ保持のみ（永続化しない）
const sizeCache = new Map(); // fileId -> 総バイト数（Content-Range 合成用）

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "drive-token") driveToken = data.token || null; // 空文字は無効扱い
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !isMediaPath(url.pathname)) return;
  event.respondWith(handleMedia(event.request, url));
});

async function handleMedia(request, url) {
  const fileId = parseMediaPath(url.pathname);
  if (!fileId) return new Response("bad media path", { status: 400 });
  if (!driveToken) return new Response("no drive token", { status: 401 });

  let driveRes;
  try {
    driveRes = await fetch(buildDriveMediaUrl(fileId), {
      headers: buildDriveHeaders(request.headers.get("Range"), driveToken),
    });
  } catch (err) {
    return new Response("upstream fetch failed", { status: 502 });
  }

  if (driveRes.status === 401) {
    driveToken = null;
    const all = await self.clients.matchAll();
    for (const c of all) c.postMessage({ type: "drive-401" });
    return new Response("unauthorized", { status: 401 });
  }

  // CORS で隠れる Content-Range を、要求 Range と読める Content-Length から自前合成する。
  const rangeHeader = request.headers.get("Range");
  const { headers, total } = buildClientResponseInit(
    driveRes.status, driveRes.headers, rangeHeader, sizeCache.get(fileId)
  );
  if (total != null) sizeCache.set(fileId, total);

  return new Response(driveRes.body, { status: driveRes.status, headers });
}
