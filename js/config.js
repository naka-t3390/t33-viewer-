// 公開前提の設定のみ（秘密情報を入れない）。
// CLIENT_ID は Google Cloud で発行した「ウェブアプリ」OAuthクライアントID。
export const CONFIG = {
  CLIENT_ID: "REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  SCOPE: "https://www.googleapis.com/auth/drive.readonly",
  ROOT_FOLDER: "T33Monitor",
};
