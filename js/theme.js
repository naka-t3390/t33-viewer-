// テーマ管理モジュール
const STORAGE_KEY = "t33_viewer_theme";

export function isDarkMode() {
  if (typeof document === "undefined") return false;
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function getThemeColors() {
  const dark = isDarkMode();
  return {
    isDark: dark,
    grid: dark ? "#27272a" : "#e7dfce",
    textMuted: dark ? "#a1a1aa" : "#877c69",
    speed: dark ? "#00e5ff" : "#2563c9",
    rpm: dark ? "#ff9800" : "#c2710c",
    cursor: dark ? "#ff3d00" : "#d64545",
    track: dark ? "#1d4ed8" : "#2563c9",
    mapStyle: dark
      ? "https://tiles.openfreemap.org/styles/positron"
      : "https://tiles.openfreemap.org/styles/liberty",
  };
}

const listeners = new Set();

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners() {
  const colors = getThemeColors();
  for (const fn of listeners) {
    try {
      fn(colors);
    } catch (e) {
      console.error("Theme listener error:", e);
    }
  }
}

export function updateThemeButton() {
  if (typeof document === "undefined") return;
  const btn = document.getElementById("theme-btn");
  if (!btn) return;
  const dark = isDarkMode();
  btn.textContent = dark ? "☀️" : "🌙";
  btn.title = dark ? "ライトモードに切り替え" : "ダークモードに切り替え";
  btn.setAttribute("aria-label", btn.title);
}

export function applyTheme(theme) {
  if (typeof document === "undefined") return;
  if (theme === "dark" || theme === "light") {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {}
  } else {
    document.documentElement.removeAttribute("data-theme");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }
  updateThemeButton();
  notifyListeners();
}

export function toggleTheme() {
  applyTheme(isDarkMode() ? "light" : "dark");
}

export function initTheme() {
  if (typeof document === "undefined") return;
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch (_) {}
  if (saved === "dark" || saved === "light") {
    document.documentElement.setAttribute("data-theme", saved);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  updateThemeButton();

  const btn = document.getElementById("theme-btn");
  if (btn) {
    btn.addEventListener("click", toggleTheme);
  }

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq && typeof mq.addEventListener === "function") {
      mq.addEventListener("change", () => {
        let currentSaved = null;
        try {
          currentSaved = localStorage.getItem(STORAGE_KEY);
        } catch (_) {}
        if (!currentSaved) {
          updateThemeButton();
          notifyListeners();
        }
      });
    }
  }
}
