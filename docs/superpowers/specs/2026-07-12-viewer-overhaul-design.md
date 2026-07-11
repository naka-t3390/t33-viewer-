# t33-viewer 全面改修 設計書

日付: 2026-07-12
対象リポジトリ: `github.com/naka-t3390/t33-viewer-`（GitHub Pages 配信の純静的サイト）

## 背景と課題

| # | 課題 | 方針（ユーザー承認済み） |
|---|---|---|
| ① | 走行記録が増え、2段プルダウンでは選びにくい | 左サイドパネル式リスト（日付グループ＋セッションカード） |
| ② | ヘッドアップ時にラスタータイルの文字が回転して読めない | Leaflet → MapLibre GL JS 移行（ベクタータイルで文字常時正立） |
| ③ | ページを開くたびに Google 同意画面が出る | サイレント再認証（初回のみ同意、以降は自動・無操作） |

パスキー移行は不採用: Drive API へのアクセスには Google の OAuth アクセストークンが必須で、
パスキー（本人確認手段）では Drive の読み取り許可を発行できないため。

## 実装順序（各フェーズ単独でコミット・デプロイ・検証可能）

1. **Phase 1: ③サイレント再認証**（最小・即効果）
2. **Phase 2: ②MapLibre 移行**（地図描画の全面差し替え）
3. **Phase 3: ①サイドパネル**（レイアウト変更を最後にまとめる）

---

## Phase 1: サイレント再認証（③）

### 現状の欠陥
`js/auth.js` の `signIn()` は `prompt: accessToken ? "" : "consent"` としており、
ページ再訪時は必ず `accessToken == null` → 毎回フル同意画面が出る。

### 設計
- **許可済みフラグ**: 初回の明示ログイン成功時に `localStorage` へ `t33_auth_granted = "1"` を保存。
  保存するのはフラグのみで、**トークンや個人情報は一切保存しない**（XSS 耐性を維持）。
- **自動サイレント取得**: ページ読み込み時（GIS ready 後）、フラグがあれば
  `requestAccessToken({ prompt: "" })` を自動実行（非表示 iframe・無操作）。
  - 成功 → ログインボタンを隠し、そのまま走行日リストを表示（従来のログイン後と同じ流れ）。
  - 失敗（Google 未ログイン・サードパーティ Cookie ブロック等）→ 従来どおりログインボタンを表示。
- **トークン失効（約1時間）時の自動回復**: `drive.js` の fetch が 401 を受けたら、
  サイレント再取得を **1回だけ** 試し、成功したら同リクエストを再試行。
  再取得失敗または再試行も 401 → 従来の「再ログインしてください」エラー表示。
  再取得成功時は SW にも新トークンを送る（`sendTokenToSW` 相当の再送）。
- 明示ログアウト機能は現状なし（変更なし）。フラグ削除はブラウザのサイトデータ削除に委ねる。

### 変更ファイル
`js/auth.js`（silentSignIn 追加・フラグ管理）、`js/app.js`（起動時自動認証の結線）、
`js/drive.js`（401 → リトライ1回のラッパー）。

### テスト
- 401 リトライ判定・フラグ状態遷移など純粋部分を分離できる範囲で `node --test`。
- 完全な検証は本番 URL のみ可能（Google セッション依存）→ デプロイ後にユーザー確認。

---

## Phase 2: MapLibre GL JS 移行（②）

### 原因
OSM ラスタータイルは文字が PNG に焼き込まれており、CSS 回転では文字だけ正立させられない。

### 設計
- **ライブラリ**: MapLibre GL JS（CDN・ビルド不要）。Leaflet の CDN 参照を差し替え。
- **タイル**: OpenFreeMap の Liberty スタイル（`https://tiles.openfreemap.org/styles/liberty`）。
  無料・API キー不要・商用可。日本の地名は日本語表示。
- **回転**: `map.setBearing(進行方位)` ネイティブ機能。シンボル(文字)はビューポート整列のため常に正立。
  今の「対角線コンテナ＋CSS回転」ハックは全部撤去（`.map-canvas` 二重構造、`coverSquareSize`、
  回転 transform、`layoutHeadUp/NorthUp`）。
- **描画対応表**:
  | 現行 (Leaflet) | 移行後 (MapLibre) |
  |---|---|
  | `L.polyline(track)` | GeoJSON source + line layer（色 #2563c9・幅4） |
  | `L.circleMarker`（自車） | `maplibregl.Marker`（DOM 円マーカー、CSS で同見た目） |
  | `fitBounds(getBounds())` | `map.fitBounds(LngLatBounds, {padding: 24})` |
  | map-pane CSS 回転 | `map.jumpTo({center: 自車, zoom: 17, bearing: 方位})` |
  | `L.control.scale` | `maplibregl.ScaleControl` |
  | ズーム `+/-` | `maplibregl.NavigationControl`（回転操作は非表示設定） |
- ボタン群（全体を表示 / 進行方向を上）は現行の素 DOM（`.map-btns`）方式を継続。
- `js/geo.js` の `headingAt`/`bearingDeg`/`distanceMeters` は方位計算として続投。
  `coverSquareSize` は不要になるため関数・テストとも削除。
- `lifecycle.replaceMap` はそのまま利用可（MapLibre にも `map.remove()` がある）。
- WebGL 必須（想定端末では問題なし）。`sw.js`・動画再生・グラフは無関係で不変。

### テスト
- `node --test`（geo 残関数）＋ `_verify_layout.html` ハーネスを MapLibre に更新して実描画確認
  （通常表示 / ヘッドアップ時に文字正立 / 往復 / 全体表示）。

---

## Phase 3: セッションサイドパネル（①）

### 設計
- **レイアウト**: `index.html` を「左 `aside`（パネル）＋右メイン（ゲージ・動画・グラフ・地図）」の
  2 カラムグリッドへ。パネルはヘッダーのボタンで開閉。狭い画面（<760px）ではオーバーレイ表示。
  ヘッダーの `#date` / `#session` プルダウンは撤去。
- **パネル内容**: 日付グループ（新しい順）→ セッションカード（時刻・動画有無アイコン・
  おおよその記録時間 = セグメント数 × 10分）。選択中カードをハイライト。
- **遅延読み込み**: 日付グループを開いた時にその日のセッション一覧を Drive から取得し
  `Map<dateId, sessions>` にキャッシュ（再展開時は再取得しない）。
  初回は最新日を自動展開し、その先頭セッションを自動選択（現行の初期挙動を維持）。
- **モジュール**: パネルの DOM 構築・イベントは新規 `js/panel.js` に分離。
  純粋ロジック（カード表示用メタの算出 `sessionCardMeta`: 時刻ラベル・動画有無・推定分数）は
  `js/parse.js` に追加してユニットテスト対象にする。
- `js/app.js` は「日付一覧取得 → panel へ渡す」「panel からの選択イベント → openSession」の結線に整理。

### テスト
- `sessionCardMeta` 等の純粋関数を `node --test`。
- ハーネスに複数セッションのモックを足してパネル操作（展開・選択・ハイライト）を実描画確認。

---

## 影響範囲まとめ

- 変更: `index.html` / `css/style.css` / `js/app.js` / `js/auth.js` / `js/drive.js` /
  `js/viewer.js` / `js/parse.js` / `js/geo.js` / `js/panel.js`(新規) / `tests/` / `_verify_layout.html`
- 不変: `sw.js`（動画ストリーミング）、`js/media-range.js`、`js/config.js`（CLIENT_ID/スコープ変更なし）、
  `js/lifecycle.js`、Android アプリ側・Drive フォルダ構成
- セキュリティ: トークンの永続保存はしない。スコープ拡大なし（drive.readonly のまま）。
  外部依存の追加は MapLibre GL JS(CDN) と OpenFreeMap タイルのみ。
