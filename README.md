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

## 開発・テスト
```bash
node --test        # parse/drive のユニットテスト（Node 18+）
```

## セキュリティ
- スコープは `drive.readonly`（読取専用）。トークンはメモリ保持のみ。
- OAuth 同意画面をテストモードにし本人のみテストユーザー登録 → 本人以外はログイン不可。
- 秘密情報・PII は含まない。
