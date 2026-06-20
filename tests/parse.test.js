import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVideoStartMs } from "../js/parse.js";

test("parseVideoStartMs: 有効JSONはepoch msを返す", () => {
  assert.equal(parseVideoStartMs('{"video_start_ms": 1780205191835}'), 1780205191835);
});
test("parseVideoStartMs: キー無しはnull", () => {
  assert.equal(parseVideoStartMs('{"other": 1}'), null);
});
test("parseVideoStartMs: 不正JSONはnull", () => {
  assert.equal(parseVideoStartMs("not json"), null);
});
test("parseVideoStartMs: 非整数値はnull", () => {
  assert.equal(parseVideoStartMs('{"video_start_ms": "x"}'), null);
});
