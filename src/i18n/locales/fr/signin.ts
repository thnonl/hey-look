import { defineLocale } from "../../types.ts";
import type ns from "../../ns/signin.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who signs in sees Google's warning page, and Google may refuse the sign-in.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.

export default defineLocale<typeof ns.en>({
  "signin.waiting.mail": "Terminez dans votre navigateur.",
  "signin.google.hint": "Si Google affiche l’avertissement « Google n’a pas validé cette application » (Google hasn’t verified this app), choisissez Paramètres avancés (Advanced), puis Accéder à Hey Look! (non sécurisé) (Go to Hey Look! (unsafe)). Hey Look! attend l’examen de Google.",
  "signin.google.learn": "Que signifie ceci ?",
  "signin.end.timeout": "Délai de connexion à {provider} dépassé.",
  "signin.end.cancelled": "Connexion à {provider} annulée.",
  "signin.end.denied": "La connexion à {provider} n’a pas abouti.",
  "signin.end.generic": "La connexion à {provider} n’est pas terminée.",
  "signin.end.google.mail": "Google a peut-être bloqué cette connexion. Vous pouvez ajouter un compte Gmail avec un mot de passe d’application.",
  "signin.end.google.calendar": "Google a peut-être bloqué cette connexion. Votre messagerie n’est pas affectée.",
  "signin.end.microsoft": "Si votre organisation gère ce compte, elle devra peut-être d’abord approuver Hey Look! Contactez votre administrateur informatique.",
  "signin.end.microsoft.blocked": "Votre organisation devra peut-être approuver Hey Look! avant que vous puissiez vous connecter à ce compte. Contactez votre administrateur informatique, puis réessayez.",
  "signin.end.appPassword": "Ajouter Gmail avec un mot de passe d’application",
  "signin.again.text": "La connexion à {provider} pour {email} a pris fin. Connectez-vous de nouveau pour continuer à recevoir vos e-mails. Vos e-mails restent sur cet ordinateur.",
  "signin.again.blocked": "Votre organisation devra peut-être approuver Hey Look! pour {email}. Contactez votre administrateur informatique, puis réessayez.",
  "signin.again.button": "Se reconnecter",
  "signin.again.short": "La connexion à {provider} a pris fin.",
  "signin.again.blockedShort": "Votre organisation devra peut-être approuver Hey Look!",
  "signin.again.done": "Connexion rétablie pour {email}",
});
