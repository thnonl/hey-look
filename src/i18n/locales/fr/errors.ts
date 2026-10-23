import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
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
  "errors.toast.accountAddedCal": "Compte {email} ajouté avec la synchronisation du calendrier",
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
});
