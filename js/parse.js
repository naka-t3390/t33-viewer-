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

const SESSION_RE = /^t33_(\d{8})_(\d{6})/;

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
        csv: null, kml: null, mp4s: [], json: null,
      });
    }
    // mp4 は 10分セグメント分割で複数になりうるため配列に集約する（id と name を保持）。
    // 他種別（csv/kml/json）は 1 セッション 1 本なので id を直接持つ。
    if (kind === "mp4") map.get(stem).mp4s.push({ id: f.id, name: f.name });
    else map.get(stem)[kind] = f.id;
  }
  return [...map.values()]
    .filter((s) => s.csv !== null)
    .sort((a, b) => (a.stem < b.stem ? 1 : a.stem > b.stem ? -1 : 0));
}

// _video.json（端末 VideoSessionTarget の集約メタ）を解析する。
// 新形式 {"video_start_ms":X,"segments":[{"file","start_ms"},...]}、
// 旧単一形式 {"video_start_ms":X}、空・不正のいずれも安全に吸収する。
// 戻り値: { videoStartMs: number|null, segments: [{file, startMs}] }
export function parseSegmentedMeta(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText || "");
  } catch {
    return { videoStartMs: null, segments: [] };
  }
  if (typeof data !== "object" || data === null) return { videoStartMs: null, segments: [] };
  const vs = data.video_start_ms;
  const videoStartMs = typeof vs === "number" && Number.isInteger(vs) ? vs : null;
  const raw = Array.isArray(data.segments) ? data.segments : [];
  const segments = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.file !== "string" || s.file === "") continue;
    if (typeof s.start_ms !== "number" || !Number.isInteger(s.start_ms)) continue;
    segments.push({ file: s.file, startMs: s.start_ms });
  }
  return { videoStartMs, segments };
}

// Drive 上の連番mp4群(mp4s=[{id,name}])と集約メタを突合し、
// 再生順のプレイリスト [{id, name, baseOffsetSec}] を作る。
// - segments メタがあれば file 名で id を解決し、baseOffsetSec=(startMs-videoStartMs)/1000。
//   Drive に存在しない segment はスキップする。
// - メタが無い(旧単一/未書込)場合は name 昇順に並べ、先頭 baseOffset=0、
//   以降は null（viewer 側が loadedmetadata の実測 duration で累積する）。
export function buildSegmentPlaylist(mp4s, meta) {
  const files = Array.isArray(mp4s) ? mp4s : [];
  if (files.length === 0) return [];
  const segs = meta && Array.isArray(meta.segments) ? meta.segments : [];
  const videoStartMs = meta ? meta.videoStartMs : null;

  if (segs.length > 0 && videoStartMs != null) {
    const byName = new Map(files.map((f) => [f.name, f]));
    const playlist = [];
    for (const seg of segs) {
      const f = byName.get(seg.file);
      if (!f) continue;
      playlist.push({ id: f.id, name: f.name, baseOffsetSec: (seg.startMs - videoStartMs) / 1000 });
    }
    return playlist;
  }

  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((f, i) => ({ id: f.id, name: f.name, baseOffsetSec: i === 0 ? 0 : null }));
}

// グローバル時刻(全体タイムラインの秒)から、対象セグメント index と
// そのセグメント内ローカル時刻を求める（グラフクリックのシーク用）。
// baseOffsetSec が数値のセグメントのみを基準にする。
export function segmentAtGlobalTime(playlist, globalTime) {
  if (!Array.isArray(playlist) || playlist.length === 0) return { index: -1, localTime: 0 };
  if (globalTime < 0) return { index: 0, localTime: 0 };
  let index = 0;
  for (let i = 0; i < playlist.length; i++) {
    const base = playlist[i].baseOffsetSec;
    if (base != null && base <= globalTime) index = i;
  }
  const base = playlist[index].baseOffsetSec || 0;
  return { index, localTime: Math.max(0, globalTime - base) };
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

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

// root 直下の children から日付フォルダ(YYYYMMDD)だけを抽出。最新が先頭。
export function selectDateFolders(children) {
  return children
    .filter((c) => c.mimeType === DRIVE_FOLDER_MIME && /^\d{8}$/.test(c.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      label: `${c.name.slice(0, 4)}-${c.name.slice(4, 6)}-${c.name.slice(6, 8)}`,
    }))
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// 日付フォルダ直下の children を「時刻フォルダ」と「直下ファイル(旧フラット)」に二分。
export function partitionDateChildren(children) {
  const timeFolders = [];
  const directFiles = [];
  for (const c of children) {
    if (c.mimeType === DRIVE_FOLDER_MIME) timeFolders.push(c);
    else directFiles.push(c);
  }
  return { timeFolders, directFiles };
}
