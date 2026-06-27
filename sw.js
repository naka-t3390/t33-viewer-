// module service worker。Drive への Range 中継で動画を全DLせずストリーム再生する。
import {
  isMediaPath,
  parseMediaPath,
  buildDriveMediaUrl,
  buildDriveHeaders,
  buildClientHeaders,
} from "./js/media-range.js";

let driveToken = null; // メモリ保持のみ（永続化しない）

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "drive-token") driveToken = data.token || null;
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

  const driveRes = await fetch(buildDriveMediaUrl(fileId), {
    headers: buildDriveHeaders(request.headers.get("Range"), driveToken),
  });

  if (driveRes.status === 401) {
    driveToken = null;
    const all = await self.clients.matchAll();
    for (const c of all) c.postMessage({ type: "drive-401" });
  }

  return new Response(driveRes.body, {
    status: driveRes.status,
    headers: buildClientHeaders(driveRes.headers),
  });
}
