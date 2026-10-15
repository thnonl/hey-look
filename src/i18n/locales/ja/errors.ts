// STUB: English placeholders, to be translated
import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
  // ---- friendlyError()
  "errors.pgp.locked": "Your encryption key is locked. Unlock it and try again.",
  "errors.pgp.missingKeys": "No public key for {list}.",
  "errors.signIn": "Sign-in failed. Check the password (Gmail, iCloud and Yahoo need an app password) or sign in again.",
  "errors.noCredentials": "The saved credentials for this account are missing. Remove the account and add it again.",
  "errors.timeout": "The mail server did not respond. Check your connection and try again.",
  "errors.unreachable": "Cannot reach the mail server. Check the server name and your connection.",
  "errors.certificate": "The server's security certificate was rejected. For a self-signed or private-CA server, remove the account and add it again with \"Trust this server's certificate\" turned on.",
  // ---- toasts of store.ts
  "errors.toast.failed": "Failed: {error}",
  "errors.toast.accountFallback": "Account",
  "errors.toast.withAccount": "{account}: {error}",
  "errors.toast.accountAdded": "Account {email} added",
  "errors.toast.loadedOlder": { other: "Loaded {n} older messages" },
  "errors.toast.noOlder": "No older messages in this folder",
  "errors.limit": "Download limit reached ({n} mails per mailbox). Raise it in Settings > Reading & sync.",
  // ---- questions of store.ts
  "errors.ask.unsentTitle": "You have an unsent message",
  "errors.ask.unsentBody": "Opening another message will close the one you are writing.",
  "errors.ask.keepWriting": "Keep writing",
  "errors.ask.saveContinue": "Save draft and continue",
  "errors.ask.discard": "Discard",
  // ---- account presets of api.ts (provider names are not translated)
  "errors.provider.gmail.hint": "Needs a Google App Password (2-Step Verification on).",
  "errors.provider.outlook.hint": "Prefer the Microsoft tab (OAuth). Password sign-in only works if basic auth is enabled; personal accounts then need an app password.",
  "errors.provider.icloud.hint": "Apple has no OAuth for mail apps. Create an app-specific password at account.apple.com (Sign-In and Security) and use it here, with your full iCloud address as the email.",
  "errors.provider.yahoo.hint": "Use a Yahoo app password.",
  "errors.provider.bridge.hint": "Run Proton Mail Bridge, then use the Bridge username and password (not your Proton password). Bridge uses a self-signed certificate on this computer, so the certificate is trusted.",
  "errors.provider.custom.label": "Other (IMAP/SMTP)",
  // ---- platform.ts: where passwords are kept ("Passwords stay in {store}") and the risky-file examples
  "errors.os.credStore.macos": "your macOS Keychain",
  "errors.os.credStore.linux": "your system keyring",
  "errors.os.credStore.windows": "Windows Credential Manager",
  "errors.os.risky.macos": ".app, .pkg, .command, .sh, .scpt, macro-enabled Office files (.docm, .xlsm) and similar",
  "errors.os.risky.linux": ".sh, .desktop, .AppImage, .run, .deb, macro-enabled Office files (.docm, .xlsm) and similar",
  "errors.os.risky.windows": ".exe, .bat, .cmd, .ps1, .js, .vbs, .msi, macro-enabled Office files (.docm, .xlsm) and similar",
});
