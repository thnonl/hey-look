import { defineLocale } from "../../types.ts";
import type ns from "../../ns/signin.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who signs in sees Google's warning page, and Google may refuse the sign-in.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.

export default defineLocale<typeof ns.en>({
  "signin.waiting.mail": "ブラウザーで操作を完了してください。",
  "signin.google.hint": "Googleに「Google はこのアプリを確認していません」（英語では “Google hasn’t verified this app”）と表示された場合は、「詳細」（Advanced）を選び、続けて「Hey Look!（安全ではないページ）に移動」（Go to Hey Look! (unsafe)）を選んでください。Hey Look!はGoogleの審査待ちです。",
  "signin.google.learn": "これはどういう意味ですか？",
  "signin.end.timeout": "{provider}のサインインがタイムアウトしました。",
  "signin.end.cancelled": "{provider}のサインインがキャンセルされました。",
  "signin.end.denied": "{provider}のサインインは完了していません。",
  "signin.end.generic": "{provider}のサインインが完了しませんでした。",
  "signin.end.google.mail": "Googleがこのサインインをブロックした可能性があります。代わりに、アプリパスワードを使ってGmailアカウントを追加できます。",
  "signin.end.google.calendar": "Googleがこのサインインをブロックした可能性があります。メールには影響しません。",
  "signin.end.microsoft": "このアカウントを組織が管理している場合は、先にHey Look!の承認が必要なことがあります。IT管理者に問い合わせてください。",
  "signin.end.microsoft.blocked": "このアカウントでサインインするには、組織によるHey Look!の承認が必要な場合があります。IT管理者に問い合わせてから、もう一度お試しください。",
  "signin.end.appPassword": "アプリパスワードでGmailを追加",
  "signin.again.text": "{email}の{provider}サインインが終了しました。メールを受信し続けるには、もう一度サインインしてください。メールはこのコンピューターに残ります。",
  "signin.again.blocked": "{email}でHey Look!を使うには、組織の承認が必要な場合があります。IT管理者に問い合わせてから、もう一度お試しください。",
  "signin.again.button": "もう一度サインイン",
  "signin.again.short": "{provider}のサインインが終了しました。",
  "signin.again.blockedShort": "Hey Look!には、組織の承認が必要な場合があります。",
  "signin.again.done": "{email}で再度サインインしました",
});
