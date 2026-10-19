import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
  // ---- friendlyError()
  "errors.pgp.locked": "您的加密密钥已锁定。请解锁后重试。",
  "errors.pgp.missingKeys": "没有{list}的公钥。",
  "errors.signIn": "登录失败。请检查密码（Gmail、iCloud和Yahoo需要使用应用专用密码），或重新登录。",
  "errors.noCredentials": "此账户保存的登录凭据已丢失。请移除该账户后重新添加。",
  "errors.timeout": "邮件服务器没有响应。请检查网络连接后重试。",
  "errors.sendRefused": "邮件服务器未接受该邮件。请稍后重试；如果仍然失败，请在“设置 > 服务器”中检查发送（SMTP）设置。（详细信息：{detail}）",
  "errors.unreachable": "无法连接到邮件服务器。请检查服务器名称和网络连接。",
  "errors.certificate": "服务器的安全证书被拒绝。如果服务器使用自签名证书或私有CA，请移除该账户，然后在开启“信任此服务器的证书”的情况下重新添加。",
  // ---- toasts of store.ts
  "errors.toast.failed": "失败：{error}",
  "errors.toast.accountFallback": "账户",
  "errors.toast.withAccount": "{account}：{error}",
  "errors.toast.accountAdded": "已添加账户{email}",
  "errors.toast.loadedOlder": { other: "已加载{n}封较早的邮件" },
  "errors.toast.noOlder": "此文件夹中没有更早的邮件",
  "errors.limit": "已达到下载上限（每个邮箱{n}封邮件）。可在“设置 > 邮箱 > 阅读与同步”中调高。",
  // ---- questions of store.ts
  "errors.ask.unsentTitle": "您有一封未发送的邮件",
  "errors.ask.unsentBody": "打开另一封邮件将关闭您正在写的这封。",
  "errors.ask.keepWriting": "继续写",
  "errors.ask.saveContinue": "保存草稿并继续",
  "errors.ask.discard": "放弃",
  // ---- account presets of api.ts (provider names are not translated)
  "errors.provider.gmail.hint": "需要Google应用专用密码（须开启两步验证）。",
  "errors.provider.outlook.hint": "建议使用“Microsoft”选项卡（OAuth）。仅当启用了基本身份验证时才能用密码登录；个人账户还需要应用专用密码。",
  "errors.provider.icloud.hint": "Apple不为邮件应用提供OAuth。请在account.apple.com（“登录与安全”）创建应用专用密码并在此使用，电子邮件地址请填写完整的iCloud地址。",
  "errors.provider.yahoo.hint": "请使用Yahoo应用专用密码。",
  "errors.provider.bridge.hint": "请运行Proton Mail Bridge，然后使用Bridge的用户名和密码（不是Proton账户密码）。Bridge在这台电脑上使用自签名证书，因此该证书会被信任。",
  "errors.provider.custom.label": "其他（IMAP/SMTP）",
  // ---- platform.ts: where passwords are kept ("Passwords stay in {store}") and the risky-file examples
  "errors.os.credStore.macos": "您的macOS钥匙串",
  "errors.os.credStore.linux": "系统密钥环",
  "errors.os.credStore.windows": "Windows凭据管理器",
  "errors.os.risky.macos": ".app、.pkg、.command、.sh、.scpt，以及启用宏的Office文件（.docm、.xlsm）等类似文件",
  "errors.os.risky.linux": ".sh、.desktop、.AppImage、.run、.deb，以及启用宏的Office文件（.docm、.xlsm）等类似文件",
  "errors.os.risky.windows": ".exe、.bat、.cmd、.ps1、.js、.vbs、.msi，以及启用宏的Office文件（.docm、.xlsm）等类似文件",
});
