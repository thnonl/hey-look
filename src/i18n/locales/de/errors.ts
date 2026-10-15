import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
  // ---- friendlyError()
  "errors.pgp.locked": "Ihr Verschlüsselungsschlüssel ist gesperrt. Entsperren Sie ihn und versuchen Sie es erneut.",
  "errors.pgp.missingKeys": "Kein öffentlicher Schlüssel für {list}.",
  "errors.signIn": "Anmeldung fehlgeschlagen. Prüfen Sie das Passwort (Gmail, iCloud und Yahoo benötigen ein App-Passwort) oder melden Sie sich erneut an.",
  "errors.noCredentials": "Die gespeicherten Anmeldedaten für dieses Konto fehlen. Entfernen Sie das Konto und fügen Sie es erneut hinzu.",
  "errors.timeout": "Der Mailserver hat nicht geantwortet. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
  "errors.unreachable": "Der Mailserver ist nicht erreichbar. Prüfen Sie den Servernamen und Ihre Verbindung.",
  "errors.certificate": "Das Sicherheitszertifikat des Servers wurde abgelehnt. Bei einem Server mit selbstsigniertem Zertifikat oder einem Zertifikat einer privaten Zertifizierungsstelle entfernen Sie das Konto und fügen es erneut hinzu, mit aktivierter Option „Dem Zertifikat dieses Servers vertrauen“.",
  // ---- toasts of store.ts
  "errors.toast.failed": "Fehlgeschlagen: {error}",
  "errors.toast.accountFallback": "Konto",
  "errors.toast.withAccount": "{account}: {error}",
  "errors.toast.accountAdded": "Konto {email} hinzugefügt",
  "errors.toast.loadedOlder": { one: "{n} ältere Nachricht geladen", other: "{n} ältere Nachrichten geladen" },
  "errors.toast.noOlder": "Keine älteren Nachrichten in diesem Ordner",
  "errors.limit": "Download-Limit erreicht ({n} E-Mails pro Postfach). Erhöhen Sie es unter Einstellungen > Lesen & Synchronisierung.",
  // ---- questions of store.ts
  "errors.ask.unsentTitle": "Sie haben eine ungesendete Nachricht",
  "errors.ask.unsentBody": "Wenn Sie eine andere Nachricht öffnen, wird die Nachricht geschlossen, die Sie gerade schreiben.",
  "errors.ask.keepWriting": "Weiterschreiben",
  "errors.ask.saveContinue": "Entwurf speichern und fortfahren",
  "errors.ask.discard": "Verwerfen",
  // ---- account presets of api.ts (provider names are not translated)
  "errors.provider.gmail.hint": "Erfordert ein Google-App-Passwort (Bestätigung in zwei Schritten aktiviert).",
  "errors.provider.outlook.hint": "Bevorzugen Sie den Tab „Microsoft“ (OAuth). Die Anmeldung per Passwort funktioniert nur, wenn die Standardauthentifizierung aktiviert ist; persönliche Konten benötigen dann ein App-Passwort.",
  "errors.provider.icloud.hint": "Apple bietet für Mail-Apps kein OAuth. Erstellen Sie unter account.apple.com (Anmeldung und Sicherheit) ein app-spezifisches Passwort und verwenden Sie es hier, mit Ihrer vollständigen iCloud-Adresse als E-Mail-Adresse.",
  "errors.provider.yahoo.hint": "Verwenden Sie ein Yahoo-App-Passwort.",
  "errors.provider.bridge.hint": "Starten Sie Proton Mail Bridge und verwenden Sie dann den Bridge-Benutzernamen und das Bridge-Passwort (nicht Ihr Proton-Passwort). Bridge verwendet auf diesem Computer ein selbstsigniertes Zertifikat, daher wird dem Zertifikat vertraut.",
  "errors.provider.custom.label": "Andere (IMAP/SMTP)",
  // ---- platform.ts: where passwords are kept ("Passwords stay in {store}") and the risky-file examples
  "errors.os.credStore.macos": "Ihrem macOS-Schlüsselbund",
  "errors.os.credStore.linux": "Ihrem System-Schlüsselbund",
  "errors.os.credStore.windows": "der Windows-Anmeldeinformationsverwaltung",
  "errors.os.risky.macos": ".app, .pkg, .command, .sh, .scpt, Office-Dateien mit Makros (.docm, .xlsm) und Ähnliches",
  "errors.os.risky.linux": ".sh, .desktop, .AppImage, .run, .deb, Office-Dateien mit Makros (.docm, .xlsm) und Ähnliches",
  "errors.os.risky.windows": ".exe, .bat, .cmd, .ps1, .js, .vbs, .msi, Office-Dateien mit Makros (.docm, .xlsm) und Ähnliches",
});
