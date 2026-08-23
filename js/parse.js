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

// 走行CSVは「スタンプ + .csv」ちょうどこの形だけ。サフィックスの付いた CSV は別物である。
const DRIVE_CSV_RE = /^t33_\d{8}_\d{6}\.csv$/;

function classifyKind(name) {
  if (name.endsWith("_video.json")) return "json";
  // 走行CSVと同じセッションフォルダには、列も用途も違う CSV が何本も並ぶ
  // (_can.csv / _pid.csv / _canmark.csv …)。拡張子だけで判定すると、Drive の
  // 列挙順(不定)しだいでそれらが走行CSVを上書きしてしまう。
  //
  // 2026-08-15: ヘッダだけの _can.csv を走行CSVとして読み「CSV にデータ行がありません」。
  //   このとき _can.csv を名指しで除外したが、除外リスト方式では**次に増えたファイルで
  //   また踏む**。
  // 2026-08-23: 実際に踏んだ。後から増えていた _pid.csv(PID 応答ログ)が 09:22:09 の
  //   走行CSVを上書きし、速度も回転も出ない空のグラフになった。
  //
  // そこで除外リストをやめ、**走行CSVの名前そのもの**を積極的に判定する。
  // 今後どんなサフィックス付き CSV が増えても、ここは黙って正しく無視する。
  if (name.endsWith(".csv")) return DRIVE_CSV_RE.test(name) ? "csv" : null;
  if (name.endsWith(".kml")) return "kml";
  if (name.endsWith(".mp4")) return "mp4";
  return null;
}

// 同名ファイルを1件に畳む（出現順は維持）。size が判る場合は大きい方を採り、
// 送信途中で切れた不完全なコピーが残っても完全な方を選ぶ。
function dedupeByName(items) {
  const byName = new Map();
  for (const item of items) {
    const prev = byName.get(item.name);
    if (!prev) { byName.set(item.name, item); continue; }
    if (Number(item.size) > Number(prev.size)) byName.set(item.name, item);
  }
  return [...byName.values()];
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
    // size があれば壊れた 0バイトセグメントの事前除外に使う(無い入力では付けない=後方互換)。
    // 他種別（csv/kml/json）は 1 セッション 1 本なので id を直接持つ。
    if (kind === "mp4") {
      const item = { id: f.id, name: f.name };
      if (f.size != null) item.size = f.size;
      map.get(stem).mp4s.push(item);
    } else {
      map.get(stem)[kind] = f.id;
    }
  }
  // 端末が同じセグメントを二重送信すると Drive に同名・別IDのファイルが並ぶ。
  // そのまま持つと記録時間(本数×10分)が水増しされ、メタ無し再生では同じ区間を
  // 二度流してしまうので、名前で1本に畳む（不完全なコピー対策で大きい方を残す）。
  for (const s of map.values()) s.mp4s = dedupeByName(s.mp4s);
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
// 有効なセグメントとみなす最小サイズ（バイト）。端末側 VideoSessionTarget.MIN_VALID_SEGMENT_BYTES
// と揃える。スリープ/Doze/切断で 0バイト・極小になった壊れた mp4 を弾く安全ライン。
export const MIN_VALID_SEGMENT_BYTES = 8 * 1024;

// Drive の files.size（API v3 は文字列で返る）を見て、壊れた 0バイト/極小 mp4 でないか判定する。
// size 未取得（undefined/null/NaN）なら判定不能として通す（再生時スキップに委ねる）。
function segmentSizeOk(file) {
  const n = Number(file && file.size);
  return !Number.isFinite(n) || n >= MIN_VALID_SEGMENT_BYTES;
}

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
      if (!segmentSizeOk(f)) continue; // 0バイト/極小の壊れたセグメントは載せない(416防止)
      const item = { id: f.id, name: f.name, baseOffsetSec: (seg.startMs - videoStartMs) / 1000 };
      // size は最終セグメントの長さ見積もり（グラフ横軸の終端）にも使う。
      if (f.size != null) item.size = f.size;
      playlist.push(item);
    }
    return playlist;
  }

  const sorted = [...files]
    .filter(segmentSizeOk) // メタ無しフォールバックでも壊れた 0バイトは除外する
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((f, i) => {
    const item = { id: f.id, name: f.name, baseOffsetSec: i === 0 ? 0 : null };
    if (f.size != null) item.size = f.size;
    return item;
  });
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

/**
 * 走行CSVの実記録時間(秒)。先頭データ行と最終行の timestamp_ms の差。
 *
 * 動画セグメント数から推定しない。録画は10分ごとに区切られるだけで、記録開始から
 * 停止までの長さとは一致しないため ―― 2026-08-15 の走行では実記録 1分50秒 の
 * セッションが1セグメント持っていたので「約10分」と表示された。
 *
 * 判定できない入力(データ行が1行以下、timestamp_ms が数値でない)は null を返す。
 */
export function csvDurationSec(csvText) {
  const lines = splitCsvLines(csvText);
  if (lines.length < 3) return null; // ヘッダ + データ2行以上でないと差が取れない
  const msAt = (line) => {
    const ms = Number(line.split(",")[1]);
    return Number.isFinite(ms) ? ms : null;
  };
  const first = msAt(lines[1]);
  const last = msAt(lines[lines.length - 1]);
  if (first === null || last === null || last < first) return null;
  return Math.round((last - first) / 1000);
}

/** 一覧向けの長さ表記。60秒未満は「42秒」、以降は「1分50秒」「7分」。 */
export function formatDuration(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return null;
  const total = Math.round(sec);
  if (total < 60) return `${total}秒`;
  const min = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${min}分` : `${min}分${rest}秒`;
}

/**
 * サイドパネルのセッションカード表示用メタ。
 *
 * @param durationSec [csvDurationSec] の実測値。CSV は一覧の描画後に非同期で取得するため、
 *   未取得の間は省略でき、その場合 durationLabel は null(=長さを出さない)になる。
 */
export function sessionCardMeta(session, durationSec = null) {
  const n = Array.isArray(session.mp4s) ? session.mp4s.length : 0;
  return {
    timeLabel: session.timeLabel,
    hasVideo: n > 0,
    durationLabel: formatDuration(durationSec),
  };
}
