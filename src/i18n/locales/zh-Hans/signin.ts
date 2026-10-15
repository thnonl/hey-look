import { defineLocale } from "../../types.ts";
import type ns from "../../ns/signin.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who is not among the first 100 users sees Google's warning page, and nobody new can sign in once the limit is used up.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.

export default defineLocale<typeof ns.en>({
  "signin.waiting.mail": "请在浏览器中完成登录。",
  "signin.google.hint": "如果Google显示“Google hasn’t verified this app”，请选择“Advanced”，然后选择“Go to Hey Look! (unsafe)”。Hey Look!正在等待Google的审核。",
  "signin.google.learn": "这是什么意思？",
  "signin.end.timeout": "{provider}登录已超时。",
  "signin.end.cancelled": "{provider}登录已取消。",
  "signin.end.denied": "{provider}登录未完成。",
  "signin.end.generic": "{provider}登录未能完成。",
  "signin.end.google.mail": "Google可能已阻止此次登录，例如当未经Google验证的应用数量已达上限时。您可以改用应用专用密码添加Gmail账户。",
  "signin.end.google.calendar": "Google可能已阻止此次登录，例如当未经Google验证的应用数量已达上限时。您的邮件不受影响。",
  "signin.end.microsoft": "如果此账户由您的组织管理，Hey Look!可能需要先获得批准。请联系您的IT管理员。",
  "signin.end.microsoft.blocked": "此账户登录前，Hey Look!可能需要先获得您所在组织的批准。请联系您的IT管理员，然后重试。",
  "signin.end.appPassword": "使用应用专用密码添加Gmail",
  "signin.again.text": "{email}的{provider}登录已失效。请重新登录以继续接收邮件。您的邮件仍保存在这台电脑上。",
  "signin.again.blocked": "{email}使用Hey Look!可能需要获得您所在组织的批准。请联系您的IT管理员，然后重试。",
  "signin.again.button": "重新登录",
  "signin.again.short": "{provider}登录已失效。",
  "signin.again.blockedShort": "Hey Look!可能需要获得您所在组织的批准。",
  "signin.again.done": "已重新登录为{email}",
});
