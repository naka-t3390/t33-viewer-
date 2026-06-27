import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_PREFIX,
  isMediaPath,
  parseMediaPath,
  buildMediaUrl,
  buildDriveMediaUrl,
  buildDriveHeaders,
  buildClientHeaders,
} from "../js/media-range.js";

test("MEDIA_PREFIX は /__media__/", () => {
  assert.equal(MEDIA_PREFIX, "/__media__/");
});

test("isMediaPath: 仮想URLパスを判定", () => {
  assert.equal(isMediaPath("/t33-viewer-/__media__/abc.mp4"), true);
  assert.equal(isMediaPath("/t33-viewer-/index.html"), false);
});

test("parseMediaPath: fileId を取り出す（.mp4 除去・URLデコード）", () => {
  assert.equal(parseMediaPath("/t33-viewer-/__media__/1AbC_d-e.mp4"), "1AbC_d-e");
  assert.equal(parseMediaPath("/app/__media__/" + encodeURIComponent("XYZ123") + ".mp4"), "XYZ123");
});

test("parseMediaPath: 不正値は null", () => {
  assert.equal(parseMediaPath("/__media__/.mp4"), null);          // 空
  assert.equal(parseMediaPath("/__media__/a%2Fb.mp4"), null);     // スラッシュ混入
  assert.equal(parseMediaPath("/foo/bar.mp4"), null);             // プレフィックスなし
});

test("buildMediaUrl: 仮想URLを組み立てる", () => {
  assert.equal(buildMediaUrl("1AbC_d-e"), "./__media__/1AbC_d-e.mp4");
});

test("buildDriveMediaUrl: Drive media エンドポイント", () => {
  assert.equal(
    buildDriveMediaUrl("FILE1"),
    "https://www.googleapis.com/drive/v3/files/FILE1?alt=media"
  );
});

test("buildDriveHeaders: Range あり/なし", () => {
  assert.deepEqual(buildDriveHeaders("bytes=0-99", "TKN"), {
    Authorization: "Bearer TKN",
    Range: "bytes=0-99",
  });
  assert.deepEqual(buildDriveHeaders(null, "TKN"), { Authorization: "Bearer TKN" });
});

test("buildClientHeaders: octet-stream を video/mp4 に補正し Range 系を透過", () => {
  const h = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": "100",
    "Content-Range": "bytes 0-99/1000",
  });
  const out = buildClientHeaders(h);
  assert.equal(out["Content-Type"], "video/mp4");
  assert.equal(out["Content-Length"], "100");
  assert.equal(out["Content-Range"], "bytes 0-99/1000");
  assert.equal(out["Accept-Ranges"], "bytes");
});

test("buildClientHeaders: 既存の動画 Content-Type は保持", () => {
  const h = new Headers({ "Content-Type": "video/mp4" });
  assert.equal(buildClientHeaders(h)["Content-Type"], "video/mp4");
});
