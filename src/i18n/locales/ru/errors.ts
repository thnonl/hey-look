import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
  // ---- friendlyError()
  "errors.pgp.locked": "Ваш ключ шифрования заблокирован. Разблокируйте его и повторите попытку.",
  "errors.pgp.missingKeys": "Нет открытого ключа для {list}.",
  "errors.signIn": "Не удалось войти. Проверьте пароль (для Gmail, iCloud и Yahoo нужен пароль приложения) или войдите заново.",
  "errors.noCredentials": "Сохранённые данные для входа в эту учётную запись не найдены. Удалите учётную запись и добавьте её снова.",
  "errors.timeout": "Почтовый сервер не отвечает. Проверьте подключение и повторите попытку.",
  "errors.unreachable": "Не удаётся связаться с почтовым сервером. Проверьте имя сервера и подключение.",
  "errors.certificate": "Сертификат безопасности сервера отклонён. Если сервер использует самоподписанный сертификат или сертификат частного ЦС, удалите учётную запись и добавьте её снова, включив параметр «Доверять сертификату этого сервера».",
  // ---- toasts of store.ts
  "errors.toast.failed": "Ошибка: {error}",
  "errors.toast.accountFallback": "Учётная запись",
  "errors.toast.withAccount": "{account}: {error}",
  "errors.toast.accountAdded": "Учётная запись {email} добавлена",
  "errors.toast.loadedOlder": {
    one: "Загружено {n} более старое письмо",
    few: "Загружено {n} более старых письма",
    many: "Загружено {n} более старых писем",
    other: "Загружено {n} более старого письма",
  },
  "errors.toast.noOlder": "В этой папке нет более старых писем",
  "errors.limit": "Достигнут лимит загрузки (писем на ящик: {n}). Увеличьте его в разделе Настройки > Почтовые ящики > Чтение и синхронизация.",
  // ---- questions of store.ts
  "errors.ask.unsentTitle": "У вас есть неотправленное письмо",
  "errors.ask.unsentBody": "Если открыть другое письмо, то письмо, которое вы пишете, будет закрыто.",
  "errors.ask.keepWriting": "Продолжить писать",
  "errors.ask.saveContinue": "Сохранить черновик и продолжить",
  "errors.ask.discard": "Удалить",
  // ---- account presets of api.ts (provider names are not translated)
  "errors.provider.gmail.hint": "Нужен пароль приложения Google (должна быть включена двухэтапная аутентификация).",
  "errors.provider.outlook.hint": "Лучше использовать вкладку Microsoft (OAuth). Вход по паролю работает, только если включена обычная проверка подлинности (basic); для личных учётных записей тогда нужен пароль приложения.",
  "errors.provider.icloud.hint": "У Apple нет OAuth для почтовых программ. Создайте пароль приложения на account.apple.com (раздел «Вход и безопасность») и введите его здесь, а в поле электронной почты укажите полный адрес iCloud.",
  "errors.provider.yahoo.hint": "Используйте пароль приложения Yahoo.",
  "errors.provider.bridge.hint": "Запустите Proton Mail Bridge и введите имя пользователя и пароль из Bridge (не пароль от Proton). Bridge использует на этом компьютере самоподписанный сертификат, поэтому сертификату доверяют.",
  "errors.provider.custom.label": "Другой (IMAP/SMTP)",
  // ---- platform.ts: where passwords are kept ("Passwords stay in {store}") and the risky-file examples
  "errors.os.credStore.macos": "связке ключей macOS",
  "errors.os.credStore.linux": "системном хранилище ключей",
  "errors.os.credStore.windows": "диспетчере учётных данных Windows",
  "errors.os.risky.macos": ".app, .pkg, .command, .sh, .scpt, файлы Office с макросами (.docm, .xlsm) и подобные",
  "errors.os.risky.linux": ".sh, .desktop, .AppImage, .run, .deb, файлы Office с макросами (.docm, .xlsm) и подобные",
  "errors.os.risky.windows": ".exe, .bat, .cmd, .ps1, .js, .vbs, .msi, файлы Office с макросами (.docm, .xlsm) и подобные",
});
