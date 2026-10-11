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

test("theme: ダークモード時は文字が読めるグレーの positron 地図スタイルを採用する", () => {
  // DOM の data-theme="dark" を模倣
  global.document = {
    documentElement: {
      getAttribute: (attr) => (attr === "data-theme" ? "dark" : null),
    },
  };
  try {
    assert.equal(isDarkMode(), true);
    const colors = getThemeColors();
    assert.equal(colors.isDark, true);
    assert.match(colors.mapStyle, /positron/);
    assert.equal(colors.track, "#1d4ed8");
  } finally {
    delete global.document;
  }
});
