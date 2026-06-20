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

const CSV_COLUMNS = {
  vehicle_speed_kmh: "speed",
  engine_rpm: "rpm",
  coolant_temp_c: "coolant",
  throttle_pct: "throttle",
  hv_state: "hv_state",
};

function toFloatOrNull(text) {
  const t = (text ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

// 値にカンマ/引用符を含まない単純CSVを想定（T33 ログは数値のみ）。
function splitCsvLines(csvText) {
  return csvText.split(/\r?\n/).filter((line) => line.trim() !== "");
}

export function parseCsvSeries(csvText, videoStartMs) {
  const lines = splitCsvLines(csvText);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {};
  header.forEach((name, i) => { idx[name] = i; });
  const series = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(",");
    const tsRaw = (cells[idx["timestamp_ms"]] ?? "").trim();
    if (tsRaw === "") continue;
    const tsMs = Number.parseInt(tsRaw, 10);
    if (Number.isNaN(tsMs)) continue;
    const sample = { t: Math.round(((tsMs - videoStartMs) / 1000.0) * 1000) / 1000 };
    for (const [col, key] of Object.entries(CSV_COLUMNS)) {
      sample[key] = toFloatOrNull(cells[idx[col]]);
    }
    series.push(sample);
  }
  return series;
}
