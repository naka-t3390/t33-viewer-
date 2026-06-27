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

// "bytes=START-END?" を {start, end|null} に。suffix(bytes=-N)や不正は null。
export function parseByteRange(rangeHeader) {
  const m = /^bytes=(\d+)-(\d*)$/.exec((rangeHeader || "").trim());
  if (!m) return null;
  return { start: Number(m[1]), end: m[2] === "" ? null : Number(m[2]) };
}

// video へ返すヘッダを組み立てる。
// Drive を別オリジン(CORS)で取得すると Content-Range / Accept-Ranges は読めず null に
// なる（safelist 外）。読める Content-Length と要求 Range から Content-Range を自前合成し、
// シーク可能な 206 を成立させる。
// 戻り値の total は呼び出し側が fileId 単位でキャッシュし、クローズ端 Range 時に渡す。
export function buildClientResponseInit(driveStatus, driveHeaders, rangeHeader, knownTotal) {
  const ct = driveHeaders.get("Content-Type");
  const headers = {
    "Content-Type": (!ct || ct === "application/octet-stream") ? "video/mp4" : ct,
    "Accept-Ranges": "bytes",
  };
  const clRaw = driveHeaders.get("Content-Length");
  const cl = clRaw != null ? Number(clRaw) : null;
  if (clRaw != null) headers["Content-Length"] = clRaw;

  let total = knownTotal != null ? knownTotal : null;
  const r = parseByteRange(rangeHeader);
  // オープン端(bytes=N-)なら total = start + 返却バイト数 で算出できる
  if (total == null && r && r.end == null && cl != null) {
    total = r.start + cl;
  }

  if (driveStatus === 206 && r && total != null) {
    const start = r.start;
    const end = r.end != null ? r.end : total - 1;
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  }
  return { headers, total };
}
