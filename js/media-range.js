// 動画ストリーミングの純粋ロジック（副作用なし・SWと共有）。
export const MEDIA_PREFIX = "/__media__/";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";

export function isMediaPath(pathname) {
  return pathname.includes(MEDIA_PREFIX);
}

// 仮想URLパスから Drive fileId を取り出す。不正なら null。
export function parseMediaPath(pathname) {
  const i = pathname.indexOf(MEDIA_PREFIX);
  if (i < 0) return null;
  let rest = pathname.slice(i + MEDIA_PREFIX.length);
  rest = rest.replace(/\.mp4$/, "");
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]+$/.test(rest) ? rest : null; // Drive ID 形式のみ許可
}

export function buildMediaUrl(fileId) {
  return `.${MEDIA_PREFIX}${encodeURIComponent(fileId)}.mp4`;
}

export function buildDriveMediaUrl(fileId) {
  return `${DRIVE_FILES}/${fileId}?alt=media`;
}

export function buildDriveHeaders(rangeHeader, token) {
  const h = { Authorization: `Bearer ${token}` };
  if (rangeHeader) h.Range = rangeHeader;
  return h;
}

export function buildClientHeaders(driveHeaders) {
  const out = {};
  const ct = driveHeaders.get("Content-Type");
  out["Content-Type"] = (!ct || ct === "application/octet-stream") ? "video/mp4" : ct;
  for (const k of ["Content-Length", "Content-Range"]) {
    const v = driveHeaders.get(k);
    if (v != null) out[k] = v;
  }
  const ar = driveHeaders.get("Accept-Ranges");
  out["Accept-Ranges"] = ar || "bytes";
  return out;
}
