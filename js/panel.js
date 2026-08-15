// 走行記録サイドパネル。日付グループ(新しい順)→セッションカードの2階層リスト。
// Drive アクセスは持たず、loadSessions コールバック経由(遅延読み込み+ここでキャッシュ)。
import { sessionCardMeta } from "./parse.js";

export function createSessionPanel({ listEl, loadSessions, onSelect }) {
  const cache = new Map();       // dateId -> Session[]
  const sessionsBox = new Map(); // dateId -> カード挿入先 DOM
  const durations = new Map();   // stem -> 実記録秒(CSV実測)。setDuration で後から届く
  let selectedStem = null;

  function cardLabel(meta) {
    const video = meta.hasVideo ? " 🎬" : " (動画なし)";
    // 記録時間は CSV を取得できるまで出さない(推定値を出すと実際と食い違う)。
    const duration = meta.durationLabel ? ` ${meta.durationLabel}` : "";
    return `${meta.timeLabel}${video}${duration}`;
  }

  /**
   * セッションの実記録時間(秒)を反映する。カードの描画は Drive のファイル一覧だけで
   * 先に済ませ、CSV の取得が終わった順にここへ流し込む(一覧の表示を待たせない)。
   */
  function setDuration(stem, sec) {
    durations.set(stem, sec);
    const btn = listEl.querySelector(`.session-card[data-stem="${stem}"]`);
    if (!btn) return; // 折りたたみ中などで DOM が無ければ、次の描画で durations から復元される
    const session = [...cache.values()].flat().find((s) => s.stem === stem);
    if (session) btn.textContent = cardLabel(sessionCardMeta(session, sec));
  }

  function renderCards(dateId, sessions) {
    const box = sessionsBox.get(dateId);
    if (!box) return;
    box.textContent = "";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-empty";
      empty.textContent = "セッションなし";
      box.appendChild(empty);
      return;
    }
    for (const s of sessions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "session-card";
      btn.dataset.stem = s.stem;
      btn.textContent = cardLabel(sessionCardMeta(s, durations.get(s.stem) ?? null));
      if (s.stem === selectedStem) btn.classList.add("active");
      btn.addEventListener("click", () => { markSelected(s.stem); onSelect(s); });
      box.appendChild(btn);
    }
  }

  // 日付グループを展開(初回は loadSessions で取得してキャッシュ)。取得結果を返す。
  async function expandDate(date, { autoSelectFirst = false } = {}) {
    const box = sessionsBox.get(date.id);
    if (box) box.classList.remove("hidden");
    let sessions = cache.get(date.id);
    if (!sessions) {
      if (box) box.textContent = "読み込み中…";
      sessions = await loadSessions(date);
      cache.set(date.id, sessions);
      renderCards(date.id, sessions);
    }
    if (autoSelectFirst && sessions.length > 0) {
      markSelected(sessions[0].stem);
      onSelect(sessions[0]);
    }
    return sessions;
  }

  function setDates(dates) {
    listEl.textContent = "";
    cache.clear();
    sessionsBox.clear();
    for (const d of dates) {
      const group = document.createElement("div");
      group.className = "panel-group";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "panel-date";
      head.textContent = d.label;
      const box = document.createElement("div");
      box.className = "panel-sessions hidden";
      sessionsBox.set(d.id, box);
      head.addEventListener("click", () => {
        if (box.classList.contains("hidden")) expandDate(d);
        else box.classList.add("hidden"); // 再クリックで折りたたみ(キャッシュは保持)
      });
      group.appendChild(head);
      group.appendChild(box);
      listEl.appendChild(group);
    }
  }

  function markSelected(stem) {
    selectedStem = stem;
    for (const el of listEl.querySelectorAll(".session-card")) {
      el.classList.toggle("active", el.dataset.stem === stem);
    }
  }

  return { setDates, expandDate, markSelected, setDuration };
}
