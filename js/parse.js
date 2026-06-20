// T33 走行ログ（CSV/KML/JSON）の解析・ビューモデル構築（DOM・ネットワーク非依存）。
// 既存 tools/viewer/timeline.py を JS へ移植。

export function parseVideoStartMs(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const v = data.video_start_ms;
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return v;
}
