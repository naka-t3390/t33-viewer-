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

function isoToEpochMs(text) {
  const t = (text ?? "").trim();
  if (t === "") return null;
  const ms = Date.parse(t); // ISO + Z を UTC として解釈
  return Number.isNaN(ms) ? null : ms;
}

// DOMParser を使わず（Node 互換のため）正規表現でタグ内容を抽出する。
export function parseKmlTrack(kmlText, videoStartMs) {
  const whens = [...kmlText.matchAll(/<when>([^<]*)<\/when>/g)].map((m) => m[1]);
  const coords = [...kmlText.matchAll(/<gx:coord>([^<]*)<\/gx:coord>/g)].map((m) => m[1]);
  const n = Math.min(whens.length, coords.length);
  const track = [];
  for (let i = 0; i < n; i++) {
    const epochMs = isoToEpochMs(whens[i]);
    const parts = (coords[i] ?? "").trim().split(/\s+/);
    if (epochMs === null || parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (Number.isNaN(lon) || Number.isNaN(lat)) continue;
    track.push({
      t: Math.round(((epochMs - videoStartMs) / 1000.0) * 1000) / 1000,
      lat,
      lon,
    });
  }
  return track;
}

export function decimate(series, maxPoints) {
  const n = series.length;
  if (maxPoints <= 0 || n <= maxPoints) return [...series];
  if (maxPoints === 1) return [series[0]];
  const step = (n - 1) / (maxPoints - 1);
  const indices = [...new Set(
    Array.from({ length: maxPoints }, (_, i) => Math.round(i * step))
  )].sort((a, b) => a - b);
  return indices.map((i) => series[i]);
}

export function hvLabel(hvState) {
  if (hvState == null) return "--";
  if (hvState >= 120) return "発電中・高";
  if (hvState >= 50) return "発電中・低";
  return "停止";
}

const SESSION_RE = /^(?:t33_)?(\d{8})_(\d{6})/;

function classifyKind(name) {
  if (name.endsWith("_video.json")) return "json";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".kml")) return "kml";
  if (name.endsWith(".mp4")) return "mp4";
  return null;
}

export function groupSessions(files) {
  const map = new Map();
  for (const f of files) {
    const m = SESSION_RE.exec(f.name);
    if (!m) continue;
    const kind = classifyKind(f.name);
    if (!kind) continue;
    const ymd = m[1];
    const hms = m[2];
    const stem = `t33_${ymd}_${hms}`;
    if (!map.has(stem)) {
      map.set(stem, {
        stem,
        dateLabel: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
        timeLabel: `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`,
        csv: null, kml: null, mp4: null, json: null,
      });
    }
    map.get(stem)[kind] = f.id;
  }
  return [...map.values()]
    .filter((s) => s.csv !== null)
    .sort((a, b) => (a.stem < b.stem ? 1 : a.stem > b.stem ? -1 : 0));
}

function firstTimestampMs(csvText) {
  const lines = splitCsvLines(csvText);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((h) => h.trim());
  const tsIdx = header.indexOf("timestamp_ms");
  if (tsIdx < 0) return null;
  for (let r = 1; r < lines.length; r++) {
    const raw = (lines[r].split(",")[tsIdx] ?? "").trim();
    if (raw === "") continue;
    const v = Number.parseInt(raw, 10);
    if (!Number.isNaN(v)) return v;
  }
  return null;
}

export function buildViewModel(csvText, kmlText, jsonText, hasVideo, maxPoints = 3000) {
  const warnings = [];
  let startMs = parseVideoStartMs(jsonText || "");
  const synced = startMs !== null;
  if (!synced) {
    startMs = firstTimestampMs(csvText);
    warnings.push("video_start_ms が無いため CSV 先頭時刻を起点に代替同期しています（精度低下の可能性）。");
  }
  if (startMs === null) {
    throw new Error("CSV に有効な timestamp_ms がありません。");
  }
  const samples = parseCsvSeries(csvText, startMs);
  if (samples.length === 0) {
    throw new Error("CSV にデータ行がありません。");
  }
  const track = parseKmlTrack(kmlText || "", startMs);
  if (track.length === 0) {
    warnings.push("KML が無い/空のため地図（走行軌跡）を表示しません。");
  }
  if (!hasVideo) {
    warnings.push("動画ファイル（mp4）が見つからないため動画なしで表示します。");
  }
  return { synced, samples, graph: decimate(samples, maxPoints), track, warnings };
}
