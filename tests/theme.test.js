import test from "node:test";
import assert from "node:assert/strict";
import { isDarkMode, getThemeColors } from "../js/theme.js";

test("theme: Node 環境での既定値は false (ライトモード)", () => {
  assert.equal(isDarkMode(), false);
  const colors = getThemeColors();
  assert.equal(colors.isDark, false);
  assert.equal(colors.speed, "#2563c9");
  assert.equal(colors.rpm, "#c2710c");
  assert.match(colors.mapStyle, /liberty/);
});
