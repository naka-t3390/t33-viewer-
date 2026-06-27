// セッション再描画にともなう「使い捨てリソース」のライフサイクルを一元管理する。
//
// renderViewer はセッション(走行)を切り替えるたびに呼ばれる。その都度
//   ・Leaflet マップ … 同じ #map へ再 L.map() すると "Map container already
//                       initialized" になる
//   ・requestAnimationFrame ループ … 前回ループを止めないと多重に走り続ける
//   ・window resize リスナ … 毎回 addEventListener すると無限に積み上がる
// が問題になる。これらを「前回分を必ず破棄してから新しく確保する」形に
// そろえる横断的関心事として切り出し、ブラウザ依存(win/raf/caf)を注入する
// ことで Node 上の単体テストを可能にする。
export function createSessionLifecycle({ win, raf, caf }) {
  let currentMap = null;   // 直近に生成した Leaflet マップ
  let rafId = null;        // 進行中の RAF ループ id
  let currentFrame = null; // 進行中ループの「1フレーム処理」
  let currentResize = null;// 現在セッションの resize ハンドラ
  let resizeBound = false; // window resize を登録済みか(1度だけ)

  // 前回マップを破棄してから factory() で新しいマップを作る。
  // track が無いセッション等で新規生成しない場合は factory に null を渡す。
  function replaceMap(factory) {
    if (currentMap) { currentMap.remove(); currentMap = null; }
    currentMap = factory ? factory() : null;
    return currentMap;
  }

  // 前回の RAF ループを止めてから frame() を毎フレーム呼ぶループを開始する。
  // frame は自分で再スケジュールしない(ここで一元管理する)。
  function restartLoop(frame) {
    if (rafId !== null) { caf(rafId); rafId = null; }
    currentFrame = frame;
    const step = () => {
      if (currentFrame !== frame) return; // さらに新しいループに置き換わったら止む
      frame();
      rafId = raf(step);
    };
    rafId = raf(step);
  }

  // resize ハンドラを差し替える。window への登録は最初の1回だけ行い、
  // 以降は常に最新のハンドラへ委譲する(多重登録を防ぐ)。
  function bindResize(handler) {
    currentResize = handler;
    if (!resizeBound) {
      win.addEventListener("resize", () => { if (currentResize) currentResize(); });
      resizeBound = true;
    }
  }

  return { replaceMap, restartLoop, bindResize };
}
