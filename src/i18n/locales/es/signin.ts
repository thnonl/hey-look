import { defineLocale } from "../../types.ts";
import type ns from "../../ns/signin.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who signs in sees Google's warning page, and Google may refuse the sign-in.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.

export default defineLocale<typeof ns.en>({
  "signin.waiting.mail": "Termina en tu navegador.",
  "signin.google.hint": "Si Google muestra la advertencia “Google hasn’t verified this app” (la página puede aparecer en el idioma de tu navegador), elige Advanced y luego Go to Hey Look! (unsafe). Hey Look! está pendiente de la revisión de Google.",
  "signin.google.learn": "¿Qué significa esto?",
  "signin.end.timeout": "Se agotó el tiempo de espera del inicio de sesión con {provider}.",
  "signin.end.cancelled": "Se canceló el inicio de sesión con {provider}.",
  "signin.end.denied": "No se completó el inicio de sesión con {provider}.",
  "signin.end.generic": "El inicio de sesión con {provider} no terminó.",
  "signin.end.google.mail": "Es posible que Google haya bloqueado este inicio de sesión. En su lugar, puedes añadir una cuenta de Gmail con una contraseña de aplicación.",
  "signin.end.google.calendar": "Es posible que Google haya bloqueado este inicio de sesión. Tu correo no se ve afectado.",
  "signin.end.microsoft": "Si tu organización administra esta cuenta, es posible que tenga que aprobar Hey Look! antes. Consulta con tu administrador de TI.",
  "signin.end.microsoft.blocked": "Es posible que tu organización tenga que aprobar Hey Look! para que esta cuenta pueda iniciar sesión. Consulta con tu administrador de TI y vuelve a intentarlo.",
  "signin.end.appPassword": "Añadir Gmail con una contraseña de aplicación",
  "signin.again.text": "Se cerró la sesión de {provider} para {email}. Vuelve a iniciar sesión para seguir recibiendo correo. Tu correo se queda en este equipo.",
  "signin.again.blocked": "Es posible que tu organización tenga que aprobar Hey Look! para {email}. Consulta con tu administrador de TI y vuelve a intentarlo.",
  "signin.again.button": "Volver a iniciar sesión",
  "signin.again.short": "Se cerró la sesión de {provider}.",
  "signin.again.blockedShort": "Hey Look! puede necesitar la aprobación de tu organización.",
  "signin.again.done": "Sesión iniciada de nuevo como {email}",
});
