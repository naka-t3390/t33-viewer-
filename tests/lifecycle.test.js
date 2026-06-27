import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionLifecycle } from "../js/lifecycle.js";

// 注入用フェイク: RAF/CAF とマップを記録する。step を実際に走らせないよう
// raf は id を返すだけ(再帰実行しない)にして、ループ管理だけを検証する。
function fakes() {
  const win = { resizeListeners: 0, addEventListener(type) { if (type === "resize") this.resizeListeners++; } };
  const calls = { raf: 0, caf: [], removed: 0 };
  let seq = 0;
  const raf = () => ++seq;          // 毎回新しい id を返す
  const caf = (id) => calls.caf.push(id);
  const makeMap = () => ({ removeCalled: false, remove() { this.removeCalled = true; calls.removed++; } });
  return { win, calls, raf, caf, makeMap };
}

test("replaceMap: 初回は前回マップを破棄しない(remove未呼び)", () => {
  const f = fakes();
  const lc = createSessionLifecycle({ win: f.win, raf: f.raf, caf: f.caf });
  lc.replaceMap(f.makeMap);
  assert.equal(f.calls.removed, 0);
});

test("replaceMap: 2回目は前回マップを1度だけ破棄してから作り直す", () => {
  const f = fakes();
  const lc = createSessionLifecycle({ win: f.win, raf: f.raf, caf: f.caf });
  const m1 = lc.replaceMap(f.makeMap);
  const m2 = lc.replaceMap(f.makeMap);
  assert.equal(m1.removeCalled, true, "前回マップが破棄される");
  assert.equal(m2.removeCalled, false, "新マップは破棄されない");
  assert.equal(f.calls.removed, 1, "破棄は1回だけ(=already initialized を防ぐ)");
  assert.notEqual(m1, m2, "別インスタンスが作られる");
});

test("replaceMap: factory=null は破棄のみ行い新規生成しない", () => {
  const f = fakes();
  const lc = createSessionLifecycle({ win: f.win, raf: f.raf, caf: f.caf });
  lc.replaceMap(f.makeMap);
  const none = lc.replaceMap(null);
  assert.equal(f.calls.removed, 1);
  assert.equal(none, null);
});

test("restartLoop: 初回は前回ループを止めない(cancel未呼び)", () => {
  const f = fakes();
  const lc = createSessionLifecycle({ win: f.win, raf: f.raf, caf: f.caf });
  lc.restartLoop(() => {});
  assert.equal(f.calls.caf.length, 0);
});

test("restartLoop: 2回目は前回ループを cancelAnimationFrame してから開始する", () => {
  const f = fakes();
  const lc = createSessionLifecycle({ win: f.win, raf: f.raf, caf: f.caf });
  lc.restartLoop(() => {});  // id=1 を確保
  lc.restartLoop(() => {});  // 前回 id=1 を cancel
  assert.equal(f.calls.caf.length, 1, "前回ループを1回だけ止める");
  assert.equal(f.calls.caf[0], 1, "止めるのは前回確保した RAF id");
});

test("bindResize: 何回呼んでも window への登録は1回だけ(多重登録しない)", () => {
  const f = fakes();
  const lc = createSessionLifecycle({ win: f.win, raf: f.raf, caf: f.caf });
  lc.bindResize(() => {});
  lc.bindResize(() => {});
  lc.bindResize(() => {});
  assert.equal(f.win.resizeListeners, 1);
});

test("bindResize: 委譲先は常に最新のハンドラ", () => {
  const f = fakes();
  // addEventListener が登録したコールバックを捕捉する
  let registered = null;
  f.win.addEventListener = (type, cb) => { if (type === "resize") { f.win.resizeListeners++; registered = cb; } };
  const lc = createSessionLifecycle({ win: f.win, raf: f.raf, caf: f.caf });
  let called = "";
  lc.bindResize(() => { called = "old"; });
  lc.bindResize(() => { called = "new"; });
  registered();
  assert.equal(called, "new", "最新セッションの fit が呼ばれる");
  assert.equal(f.win.resizeListeners, 1, "登録は依然1回");
});
