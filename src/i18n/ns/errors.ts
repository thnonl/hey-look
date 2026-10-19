import { define } from "../types.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.
export default define({
  en: {
    // ---- friendlyError()
    "errors.pgp.locked": "Your encryption key is locked. Unlock it and try again.",
    "errors.pgp.missingKeys": "No public key for {list}.",
    "errors.signIn": "Sign-in failed. Check the password (Gmail, iCloud and Yahoo need an app password) or sign in again.",
    "errors.noCredentials": "The saved credentials for this account are missing. Remove the account and add it again.",
    "errors.timeout": "The mail server did not respond. Check your connection and try again.",
    "errors.sendRefused": "The mail server did not accept the message. Try again in a moment; if it keeps failing, check the outgoing server in Settings. (Details: {detail})",
    "errors.unreachable": "Cannot reach the mail server. Check the server name and your connection.",
    "errors.certificate": "The server's security certificate was rejected. For a self-signed or private-CA server, remove the account and add it again with \"Trust this server's certificate\" turned on.",

    // ---- toasts of store.ts
    "errors.toast.failed": "Failed: {error}",
    "errors.toast.accountFallback": "Account",
    "errors.toast.withAccount": "{account}: {error}",
    "errors.toast.accountAdded": "Account {email} added",
    "errors.toast.loadedOlder": { one: "Loaded {n} older message", other: "Loaded {n} older messages" },
    "errors.toast.noOlder": "No older messages in this folder",
    "errors.limit": "Download limit reached ({n} mails per mailbox). Raise it in Settings > Mailboxes > Reading & sync.",

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
  },
  vi: {
    "errors.pgp.locked": "Khóa mã hóa của bạn đang bị khóa. Hãy mở khóa rồi thử lại.",
    "errors.pgp.missingKeys": "Không có khóa công khai cho {list}.",
    "errors.signIn": "Đăng nhập không thành công. Hãy kiểm tra mật khẩu (Gmail, iCloud và Yahoo cần mật khẩu ứng dụng) hoặc đăng nhập lại.",
    "errors.noCredentials": "Không tìm thấy thông tin đăng nhập đã lưu của tài khoản này. Hãy gỡ bỏ tài khoản rồi thêm lại.",
    "errors.timeout": "Máy chủ thư không phản hồi. Hãy kiểm tra kết nối rồi thử lại.",
    "errors.sendRefused": "Máy chủ thư không nhận thư. Hãy thử lại sau giây lát; nếu vẫn lỗi, hãy kiểm tra mục Thư đi (SMTP) của máy chủ trong Cài đặt. (Chi tiết: {detail})",
    "errors.unreachable": "Không thể kết nối tới máy chủ thư. Hãy kiểm tra tên máy chủ và kết nối của bạn.",
    "errors.certificate": "Chứng chỉ bảo mật của máy chủ bị từ chối. Với máy chủ dùng chứng chỉ tự ký hoặc CA riêng, hãy gỡ bỏ tài khoản rồi thêm lại và bật “Tin cậy chứng chỉ của máy chủ này”.",

    "errors.toast.failed": "Không thành công: {error}",
    "errors.toast.accountFallback": "Tài khoản",
    "errors.toast.withAccount": "{account}: {error}",
    "errors.toast.accountAdded": "Đã thêm tài khoản {email}",
    "errors.toast.loadedOlder": { one: "Đã tải {n} thư cũ hơn", other: "Đã tải {n} thư cũ hơn" },
    "errors.toast.noOlder": "Không còn thư cũ hơn trong thư mục này",
    "errors.limit": "Đã đạt giới hạn tải xuống ({n} thư mỗi hộp thư). Hãy tăng giới hạn trong Cài đặt > Hộp thư > Đọc thư & đồng bộ.",

    "errors.ask.unsentTitle": "Bạn có một thư chưa gửi",
    "errors.ask.unsentBody": "Mở thư khác sẽ đóng thư bạn đang soạn.",
    "errors.ask.keepWriting": "Tiếp tục soạn",
    "errors.ask.saveContinue": "Lưu thư nháp và tiếp tục",
    "errors.ask.discard": "Loại bỏ",

    "errors.provider.gmail.hint": "Cần mật khẩu ứng dụng Google (đã bật Xác minh 2 bước).",
    "errors.provider.outlook.hint": "Nên dùng tab Microsoft (OAuth). Đăng nhập bằng mật khẩu chỉ hoạt động khi bật xác thực cơ bản; tài khoản cá nhân khi đó cần mật khẩu ứng dụng.",
    "errors.provider.icloud.hint": "Apple không có OAuth cho ứng dụng thư. Hãy tạo mật khẩu riêng cho ứng dụng tại account.apple.com (Đăng nhập và Bảo mật) rồi dùng ở đây, với địa chỉ iCloud đầy đủ làm email.",
    "errors.provider.yahoo.hint": "Hãy dùng mật khẩu ứng dụng Yahoo.",
    "errors.provider.bridge.hint": "Hãy chạy Proton Mail Bridge, rồi dùng tên người dùng và mật khẩu của Bridge (không phải mật khẩu Proton). Bridge dùng chứng chỉ tự ký trên máy tính này nên chứng chỉ được tin cậy.",
    "errors.provider.custom.label": "Khác (IMAP/SMTP)",

    "errors.os.credStore.macos": "Chuỗi khóa macOS của bạn",
    "errors.os.credStore.linux": "kho khóa hệ thống của bạn",
    "errors.os.credStore.windows": "Trình quản lý thông tin xác thực của Windows",
    "errors.os.risky.macos": ".app, .pkg, .command, .sh, .scpt, tệp Office có macro (.docm, .xlsm) và các loại tương tự",
    "errors.os.risky.linux": ".sh, .desktop, .AppImage, .run, .deb, tệp Office có macro (.docm, .xlsm) và các loại tương tự",
    "errors.os.risky.windows": ".exe, .bat, .cmd, .ps1, .js, .vbs, .msi, tệp Office có macro (.docm, .xlsm) và các loại tương tự",
  },
  fr: {
    "errors.pgp.locked": "Votre clé de chiffrement est verrouillée. Déverrouillez-la, puis réessayez.",
    "errors.pgp.missingKeys": "Aucune clé publique pour {list}.",
    "errors.signIn": "Échec de la connexion. Vérifiez le mot de passe (Gmail, iCloud et Yahoo exigent un mot de passe d’application) ou reconnectez-vous.",
    "errors.noCredentials": "Les identifiants enregistrés pour ce compte sont introuvables. Supprimez le compte, puis ajoutez-le de nouveau.",
    "errors.timeout": "Le serveur de messagerie n’a pas répondu. Vérifiez votre connexion, puis réessayez.",
    "errors.sendRefused": "Le serveur de messagerie n’a pas accepté le message. Réessayez dans un instant ; si l’échec persiste, vérifiez le courrier sortant (SMTP) dans les Paramètres. (Détails : {detail})",
    "errors.unreachable": "Impossible de joindre le serveur de messagerie. Vérifiez le nom du serveur et votre connexion.",
    "errors.certificate": "Le certificat de sécurité du serveur a été rejeté. Pour un serveur à certificat auto-signé ou à autorité de certification privée, supprimez le compte, puis ajoutez-le de nouveau en activant « Faire confiance au certificat de ce serveur ».",

    "errors.toast.failed": "Échec : {error}",
    "errors.toast.accountFallback": "Compte",
    "errors.toast.withAccount": "{account} : {error}",
    "errors.toast.accountAdded": "Compte {email} ajouté",
    "errors.toast.loadedOlder": { one: "{n} message plus ancien chargé", other: "{n} messages plus anciens chargés" },
    "errors.toast.noOlder": "Aucun message plus ancien dans ce dossier",
    "errors.limit": "Limite de téléchargement atteinte ({n} messages par boîte aux lettres). Augmentez-la dans Paramètres > Boîtes aux lettres > Lecture et synchro.",

    "errors.ask.unsentTitle": "Vous avez un message non envoyé",
    "errors.ask.unsentBody": "L’ouverture d’un autre message fermera celui que vous rédigez.",
    "errors.ask.keepWriting": "Continuer à écrire",
    "errors.ask.saveContinue": "Enregistrer le brouillon et continuer",
    "errors.ask.discard": "Abandonner",

    "errors.provider.gmail.hint": "Nécessite un mot de passe d’application Google (validation en deux étapes activée).",
    "errors.provider.outlook.hint": "Privilégiez l’onglet Microsoft (OAuth). La connexion par mot de passe ne fonctionne que si l’authentification de base est activée ; les comptes personnels nécessitent alors un mot de passe d’application.",
    "errors.provider.icloud.hint": "Apple ne propose pas OAuth pour les applications de messagerie. Créez un mot de passe d’application spécifique sur account.apple.com (Connexion et sécurité) et utilisez-le ici, avec votre adresse iCloud complète comme e-mail.",
    "errors.provider.yahoo.hint": "Utilisez un mot de passe d’application Yahoo.",
    "errors.provider.bridge.hint": "Lancez Proton Mail Bridge, puis utilisez le nom d’utilisateur et le mot de passe de Bridge (et non votre mot de passe Proton). Bridge utilise un certificat auto-signé sur cet ordinateur ; ce certificat est donc approuvé.",
    "errors.provider.custom.label": "Autre (IMAP/SMTP)",

    "errors.os.credStore.macos": "votre trousseau macOS",
    "errors.os.credStore.linux": "le trousseau de clés de votre système",
    "errors.os.credStore.windows": "le Gestionnaire d’informations d’identification Windows",
    "errors.os.risky.macos": ".app, .pkg, .command, .sh, .scpt, fichiers Office avec macros (.docm, .xlsm) et assimilés",
    "errors.os.risky.linux": ".sh, .desktop, .AppImage, .run, .deb, fichiers Office avec macros (.docm, .xlsm) et assimilés",
    "errors.os.risky.windows": ".exe, .bat, .cmd, .ps1, .js, .vbs, .msi, fichiers Office avec macros (.docm, .xlsm) et assimilés",
  },
});
