// サイドパネルの記録時間表示。CSV は一覧の描画とは別に取得されるため、
// 「カードが先か、記録時間が先か」のどちらの順序でも表示が揃うことを確かめる。
// ブラウザを使わずに済むよう、panel.js が実際に触る DOM API だけを最小限に模す。
import { test } from "node:test";
import assert from "node:assert/strict";

function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    dataset: {},
    _classes: new Set(),
    _text: "",
    appendChild(c) { el.children.push(c); return c; },
    addEventListener() {},
    querySelector(sel) { return el.querySelectorAll(sel)[0] ?? null; },
    querySelectorAll(sel) {
      // 使うのは `.session-card` と `.session-card[data-stem="..."]` の2形だけ。
      const m = /^\.([\w-]+)(?:\[data-stem="([^"]+)"\])?$/.exec(sel);
      if (!m) throw new Error(`未対応のセレクタ: ${sel}`);
      const [, cls, stem] = m;
      const hit = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (c._classes.has(cls) && (!stem || c.dataset.stem === stem)) hit.push(c);
          walk(c);
        }
      };
      walk(el);
      return hit;
    },
  };
  Object.defineProperty(el, "className", {
    get: () => [...el._classes].join(" "),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  Object.defineProperty(el, "textContent", {
    get: () => el._text,
    set: (v) => { el._text = v; el.children = []; },
  });
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
    toggle: (c, on) => (on ? el._classes.add(c) : el._classes.delete(c)),
  };
  return el;
}

globalThis.document = { createElement: makeEl };
const { createSessionPanel } = await import("../js/panel.js");

const DATE = { id: "d1", name: "20260815", label: "2026-08-15" };
const SESSIONS = [
  { stem: "t33_20260815_143450", timeLabel: "14:34:50", dateLabel: "2026-08-15", mp4s: [{}] },
  { stem: "t33_20260815_144958", timeLabel: "14:49:58", dateLabel: "2026-08-15", mp4s: [] },
];

function setup() {
  const listEl = makeEl("div");
  const panel = createSessionPanel({
    listEl,
    loadSessions: async () => SESSIONS,
    onSelect: () => {},
  });
  panel.setDates([DATE]);
  return { listEl, panel };
}

const labelOf = (listEl, stem) =>
  listEl.querySelector(`.session-card[data-stem="${stem}"]`).textContent;

test("panel: 記録時間が未取得のカードは時刻と動画有無だけ", async () => {
  const { listEl, panel } = setup();
  await panel.expandDate(DATE);
  assert.equal(labelOf(listEl, "t33_20260815_143450"), "14:34:50 🎬");
  assert.equal(labelOf(listEl, "t33_20260815_144958"), "14:49:58 (動画なし)");
});

test("panel: 描画後に届いた記録時間をそのカードだけに反映する", async () => {
  const { listEl, panel } = setup();
  await panel.expandDate(DATE);
  panel.setDuration("t33_20260815_143450", 99);
  assert.equal(labelOf(listEl, "t33_20260815_143450"), "14:34:50 🎬 1分39秒");
  assert.equal(labelOf(listEl, "t33_20260815_144958"), "14:49:58 (動画なし)");
});

test("panel: 描画より先に届いた記録時間も、描画時に反映される", async () => {
  const { listEl, panel } = setup();
  panel.setDuration("t33_20260815_143450", 938); // カードはまだ DOM に無い
  await panel.expandDate(DATE);
  assert.equal(labelOf(listEl, "t33_20260815_143450"), "14:34:50 🎬 15分38秒");
});

test("panel: 記録時間が判らない(null)なら長さを出さない", async () => {
  const { listEl, panel } = setup();
  await panel.expandDate(DATE);
  panel.setDuration("t33_20260815_143450", null);
  assert.equal(labelOf(listEl, "t33_20260815_143450"), "14:34:50 🎬");
});
