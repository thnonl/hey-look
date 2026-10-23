import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
  // ---- friendlyError()
  "errors.pgp.locked": "暗号化用の鍵がロックされています。ロックを解除して、もう一度お試しください。",
  "errors.pgp.missingKeys": "{list}の公開鍵がありません。",
  "errors.signIn": "サインインできませんでした。パスワードを確認するか（Gmail、iCloud、Yahooではアプリパスワードが必要です）、もう一度サインインしてください。",
  "errors.noCredentials": "このアカウントの保存済みの認証情報が見つかりません。アカウントを削除して、もう一度追加してください。",
  "errors.timeout": "メールサーバーから応答がありません。接続を確認して、もう一度お試しください。",
  "errors.sendRefused": "メールサーバーがメッセージを受け付けませんでした。しばらくしてからもう一度お試しください。繰り返し失敗する場合は、設定の「送信（SMTP）」を確認してください。（詳細：{detail}）",
  "errors.unreachable": "メールサーバーに接続できません。サーバー名と接続状況を確認してください。",
  "errors.certificate": "サーバーのセキュリティ証明書が拒否されました。自己署名証明書や独自の認証局を使うサーバーの場合は、アカウントを削除し、「このサーバーの証明書を信頼する」をオンにして、もう一度追加してください。",
  // ---- toasts of store.ts
  "errors.toast.failed": "失敗：{error}",
  "errors.toast.accountFallback": "アカウント",
  "errors.toast.withAccount": "{account}：{error}",
  "errors.toast.accountAdded": "アカウント{email}を追加しました",
  "errors.toast.accountAddedCal": "アカウント{email}をカレンダー同期付きで追加しました",
  "errors.toast.loadedOlder": { other: "古いメッセージを{n}件読み込みました" },
  "errors.toast.noOlder": "このフォルダーにこれより古いメッセージはありません",
  "errors.limit": "ダウンロード数の上限に達しました（1メールボックスあたり{n}件）。設定 > メールボックス > 閲覧と同期で変更できます。",
  // ---- questions of store.ts
  "errors.ask.unsentTitle": "未送信のメッセージがあります",
  "errors.ask.unsentBody": "別のメッセージを開くと、作成中のメッセージが閉じられます。",
  "errors.ask.keepWriting": "作成を続ける",
  "errors.ask.saveContinue": "下書きを保存して続行",
  "errors.ask.discard": "破棄",
  // ---- account presets of api.ts (provider names are not translated)
  "errors.provider.gmail.hint": "Googleのアプリパスワードが必要です（2段階認証プロセスをオンにしてください）。",
  "errors.provider.outlook.hint": "Microsoftタブ（OAuth）の利用をおすすめします。パスワードでのサインインは、基本認証が有効な場合にのみ使えます。その場合、個人用アカウントではアプリパスワードが必要です。",
  "errors.provider.icloud.hint": "AppleはメールアプリにOAuthを提供していません。account.apple.com（サインインとセキュリティ）でApp用パスワードを作成し、メールアドレスにiCloudの完全なアドレスを入力して、ここで使ってください。",
  "errors.provider.yahoo.hint": "Yahooのアプリパスワードを使ってください。",
  "errors.provider.bridge.hint": "Proton Mail Bridgeを起動し、Bridgeのユーザー名とパスワード（Protonのパスワードではありません）を使ってください。Bridgeはこのコンピューター上で自己署名証明書を使うため、その証明書は信頼されます。",
  "errors.provider.custom.label": "その他（IMAP/SMTP）",
  // ---- platform.ts: where passwords are kept ("Passwords stay in {store}") and the risky-file examples
  "errors.os.credStore.macos": "macOSのキーチェーン",
  "errors.os.credStore.linux": "システムのキーリング",
  "errors.os.credStore.windows": "Windows資格情報マネージャー",
  "errors.os.risky.macos": ".app、.pkg、.command、.sh、.scpt、マクロ有効のOfficeファイル（.docm、.xlsm）など",
  "errors.os.risky.linux": ".sh、.desktop、.AppImage、.run、.deb、マクロ有効のOfficeファイル（.docm、.xlsm）など",
  "errors.os.risky.windows": ".exe、.bat、.cmd、.ps1、.js、.vbs、.msi、マクロ有効のOfficeファイル（.docm、.xlsm）など",
});
