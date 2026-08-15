// セグメント動画の再生元(src)をどう解決するかを組み立てる。
//
// viewer 側は playback.resolveSrc(i) を呼ぶだけで i 番目のセグメントを再生できる。
// SW ストリーミングと全DLフォールバックの違いはここに閉じ込める。

/**
 * 再生プレイリストから playback を作る。要素が無ければ null（再生させない）。
 *
 * @param {Array<{id:string,name:string,baseOffsetSec:number|null}>} list
 *   buildSegmentPlaylist の出力（再生順）
 * @param {{
 *   swStreaming: boolean,
 *   sendToken: () => Promise<unknown>,
 *   buildMediaUrl: (id: string) => string,
 *   downloadBlobUrl: (id: string) => (string|Promise<string>),
 * }} deps
 * @returns {{segments: Array<{baseOffsetSec:number|null}>, isBlob: boolean,
 *   resolveSrc: (i:number) => (string|Promise<string>)}|null}
 */
export function buildPlayback(list, deps) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) return null;

  const segments = items.map((x) => {
    const seg = { baseOffsetSec: x.baseOffsetSec };
    // size はグラフ横軸の終端（最終セグメントの長さ）見積もりに使う。
    if (x.size != null) seg.size = x.size;
    return seg;
  });

  if (deps.swStreaming) {
    return {
      segments,
      isBlob: false,
      // Range ストリーミング: セグメントの仮想URLを都度返す（全DLしない）。
      //
      // トークンを**毎回**渡し直すのが要点。Service Worker はアイドルになると
      // ブラウザに停止され、メモリ保持の driveToken を失う（sw.js は永続化しない）。
      // セッションを開いた時の 1 回だけしか渡していないと、10 分再生して 2 本目へ
      // 移る頃には SW が再起動していてトークンが無く、Drive 取得が 401 になって
      // 再生が止まる。送信は ack 不達でも 1.5s で解決するため、境界の遅延は許容できる。
      resolveSrc: async (i) => {
        await deps.sendToken();
        return deps.buildMediaUrl(items[i].id);
      },
    };
  }

  // 非SW フォールバック: 該当セグメントのみ blob として順次ダウンロードする。
  return {
    segments,
    isBlob: true,
    resolveSrc: (i) => deps.downloadBlobUrl(items[i].id),
  };
}
