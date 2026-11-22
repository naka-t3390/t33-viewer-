# T33 Drive ビューア

スマホ/PC のブラウザから Google Drive 上の T33Monitor 走行データ（CSV/KML/MP4）を
地図・動画・グラフ同期で閲覧する静的 Web アプリ。端末や PC 接続は不要。

公開 URL: `https://naka-t3390.github.io/t33-viewer-/`

## セットアップ（初回のみ）

### 1. Google Cloud で OAuth クライアント ID を発行
1. https://console.cloud.google.com/ でプロジェクトを作成（または既存を選択）。
2. 「API とサービス」→「ライブラリ」で **Google Drive API** を有効化。
3. 「OAuth 同意画面」: User Type = **External**、公開ステータス = **テスト**。
   - スコープに `https://www.googleapis.com/auth/drive.readonly` を追加。
   - **テストユーザー**に自分の Google アカウントのメールを追加。
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ アプリの種類 **ウェブアプリケーション**。
   - **承認済みの JavaScript 生成元**に `https://naka-t3390.github.io` を追加。
5. 発行された **クライアント ID**（`...apps.googleusercontent.com`）をコピー。

### 2. クライアント ID を設定
`js/config.js` の `CLIENT_ID` を発行した値に書き換える（このIDは秘密ではない）。

### 3. GitHub Pages を有効化
リポジトリ Settings → Pages → Build and deployment → Source = **GitHub Actions**。
`main` に push すると自動デプロイされる。

## 使い方
1. 公開 URL を開く。
2. 「Google でログイン」→ 自分のアカウントで認可。
3. セッション（最新が既定）を選ぶと地図・動画・グラフが同期表示される。

### 地図の操作
- **全体を表示** … 北を上に戻して走行全体へフィットする。
- **⬆ 進行方向を上** … 自車を中心に、進行方向が上になるよう地図を回す。
- **〜 道に吸着 / 補正のみ / 生データを表示** … 軌跡の表示モードを切り替える（押すたびに巡回）。
  ラベルは「押すと何になるか」。既定は「道に吸着」で、選択はブラウザに記憶される。

  | モード | 表示される軌跡 | 中身 |
  |---|---|---|
  | 道に吸着 | 道路形状に乗った線 | `js/geo-correct.js` + `js/map-match.js` |
  | 補正のみ | 団子とギザギザだけ畳んだ線 | `js/geo-correct.js` |
  | 生データ | KML のまま | — |

  **元の KML / CSV の座標は変更しない**（分析の原本のため）。吸着先は OpenStreetMap の
  道路形状であって真の位置ではないので、**距離や速度の分析に吸着後の座標を使わないこと**。

  道路形状は、地図表示にすでに使っている OpenFreeMap のベクタータイルから取る。
  サーバーへ送るのはタイル番号だけで、**走行位置そのものは外部へ送らない**
  （OSRM 等の外部 match API を使わない理由）。方針は
  `Torque2/docs/1122/走行軌跡マップマッチング方針_2026-11-22.html`。
- 軌跡をクリックすると、その地点を通った時刻へ動画がシークする（補正の ON/OFF を問わず動く）。

## 開発・テスト
```bash
node --test        # parse/drive のユニットテスト（Node 18+）
```

## セキュリティ
- スコープは `drive.readonly`（読取専用）。トークンはメモリ保持のみ。
- OAuth 同意画面をテストモードにし本人のみテストユーザー登録 → 本人以外はログイン不可。
- 秘密情報・PII は含まない。
