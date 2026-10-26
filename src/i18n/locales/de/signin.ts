import { defineLocale } from "../../types.ts";
import type ns from "../../ns/signin.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who signs in sees Google's warning page, and Google may refuse the sign-in.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.

export default defineLocale<typeof ns.en>({
  "signin.waiting.mail": "Schließen Sie die Anmeldung in Ihrem Browser ab.",
  "signin.google.hint": "Wenn Google „Google hasn’t verified this app“ anzeigt, wählen Sie Advanced und dann Go to Hey Look! (unsafe). Hey Look! wartet auf die Prüfung durch Google.",
  "signin.google.learn": "Was bedeutet das?",
  "signin.end.timeout": "Zeitüberschreitung bei der {provider}-Anmeldung.",
  "signin.end.cancelled": "Die Anmeldung bei {provider} wurde abgebrochen.",
  "signin.end.denied": "Die Anmeldung bei {provider} wurde nicht abgeschlossen.",
  "signin.end.generic": "Die Anmeldung bei {provider} wurde nicht abgeschlossen.",
  "signin.end.google.mail": "Google hat diese Anmeldung möglicherweise blockiert. Sie können stattdessen ein Gmail-Konto mit einem App-Passwort hinzufügen.",
  "signin.end.google.calendar": "Google hat diese Anmeldung möglicherweise blockiert. Ihre E-Mails sind davon nicht betroffen.",
  "signin.end.microsoft": "Wenn Ihre Organisation dieses Konto verwaltet, muss sie Hey Look! möglicherweise zuerst freigeben. Wenden Sie sich an Ihren IT-Administrator.",
  "signin.end.microsoft.blocked": "Möglicherweise muss Ihre Organisation Hey Look! freigeben, bevor sich dieses Konto anmelden kann. Wenden Sie sich an Ihren IT-Administrator und versuchen Sie es dann erneut.",
  "signin.end.appPassword": "Gmail mit App-Passwort hinzufügen",
  "signin.again.text": "Die Anmeldung bei {provider} für {email} wurde beendet. Melden Sie sich erneut an, um weiterhin E-Mails zu erhalten. Ihre E-Mails bleiben auf diesem Computer.",
  "signin.again.blocked": "Möglicherweise muss Ihre Organisation Hey Look! für {email} freigeben. Wenden Sie sich an Ihren IT-Administrator und versuchen Sie es dann erneut.",
  "signin.again.button": "Erneut anmelden",
  "signin.again.short": "Die Anmeldung bei {provider} wurde beendet.",
  "signin.again.blockedShort": "Hey Look! benötigt möglicherweise die Freigabe Ihrer Organisation.",
  "signin.again.done": "Erneut angemeldet als {email}",
});
