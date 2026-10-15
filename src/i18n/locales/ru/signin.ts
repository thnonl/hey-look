import { defineLocale } from "../../types.ts";
import type ns from "../../ns/signin.ts";

// The wait for the browser while signing in (mail and calendar), what is said when it ends without access, and the "Sign in again"
// state of a mailbox whose sign-in was rejected. While Google has not verified Hey Look! (GOOGLE_REVIEW_PENDING in src/signIn.ts) a
// person who is not among the first 100 users sees Google's warning page, and nobody new can sign in once the limit is used up.
// "Google hasn't verified this app", "Advanced" and "Go to Hey Look! (unsafe)" are the words of Google's own page (which Google shows in the
// language of the browser), so they stay in English in every language.

export default defineLocale<typeof ns.en>({
  "signin.waiting.mail": "Завершите вход в браузере.",
  "signin.google.hint": "Если Google покажет предупреждение «Google hasn’t verified this app» (страница может отображаться на языке вашего браузера), выберите Advanced, а затем Go to Hey Look! (unsafe). Hey Look! ожидает проверки Google.",
  "signin.google.learn": "Что это значит?",
  "signin.end.timeout": "Время ожидания входа через {provider} истекло.",
  "signin.end.cancelled": "Вход через {provider} отменён.",
  "signin.end.denied": "Вход через {provider} не завершён.",
  "signin.end.generic": "Вход через {provider} не завершился.",
  "signin.end.google.mail": "Возможно, Google заблокировал этот вход, например из-за достигнутого лимита для приложений, не прошедших проверку Google. Вместо этого можно добавить аккаунт Gmail с паролем приложения.",
  "signin.end.google.calendar": "Возможно, Google заблокировал этот вход, например из-за достигнутого лимита для приложений, не прошедших проверку Google. Почта это не затрагивает.",
  "signin.end.microsoft": "Если этим аккаунтом управляет ваша организация, возможно, ей нужно сначала одобрить Hey Look! Обратитесь к ИТ-администратору.",
  "signin.end.microsoft.blocked": "Возможно, вашей организации нужно одобрить Hey Look!, прежде чем этот аккаунт сможет войти. Обратитесь к ИТ-администратору и повторите попытку.",
  "signin.end.appPassword": "Добавить Gmail с паролем приложения",
  "signin.again.text": "Сеанс входа через {provider} для {email} завершён. Войдите снова, чтобы продолжить получать почту. Ваша почта остаётся на этом компьютере.",
  "signin.again.blocked": "Возможно, вашей организации нужно одобрить Hey Look! для {email}. Обратитесь к ИТ-администратору и повторите попытку.",
  "signin.again.button": "Войти снова",
  "signin.again.short": "Сеанс входа через {provider} завершён.",
  "signin.again.blockedShort": "Возможно, Hey Look! нужно одобрение вашей организации.",
  "signin.again.done": "Выполнен повторный вход как {email}",
});
