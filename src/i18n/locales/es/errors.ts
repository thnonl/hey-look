import { defineLocale } from "../../types.ts";
import type ns from "../../ns/errors.ts";

// friendlyError() sentences, toasts and questions created in store.ts, the provider presets of api.ts, OS-dependent phrases of platform.ts.
// Raw server text (what a mail server said) is shown as it came and is not in here on purpose.

export default defineLocale<typeof ns.en>({
  // ---- friendlyError()
  "errors.pgp.locked": "Tu clave de cifrado está bloqueada. Desbloquéala e inténtalo de nuevo.",
  "errors.pgp.missingKeys": "Falta la clave pública de {list}.",
  "errors.signIn": "No se pudo iniciar sesión. Comprueba la contraseña (Gmail, iCloud y Yahoo requieren una contraseña de aplicación) o vuelve a iniciar sesión.",
  "errors.noCredentials": "Faltan las credenciales guardadas de esta cuenta. Quita la cuenta y vuelve a añadirla.",
  "errors.timeout": "El servidor de correo no respondió. Comprueba tu conexión e inténtalo de nuevo.",
  "errors.sendRefused": "El servidor de correo no aceptó el mensaje. Inténtalo de nuevo en un momento; si sigue fallando, revisa el servidor saliente en Configuración > Buzones > Servidor. (Detalles: {detail})",
  "errors.unreachable": "No se puede conectar con el servidor de correo. Comprueba el nombre del servidor y tu conexión.",
  "errors.certificate": "Se rechazó el certificado de seguridad del servidor. Si el servidor usa un certificado autofirmado o una autoridad de certificación privada, quita la cuenta y vuelve a añadirla con la opción “Confiar en el certificado de este servidor” activada.",
  // ---- toasts of store.ts
  "errors.toast.failed": "Error: {error}",
  "errors.toast.accountFallback": "Cuenta",
  "errors.toast.withAccount": "{account}: {error}",
  "errors.toast.accountAdded": "Se añadió la cuenta {email}",
  "errors.toast.accountAddedCal": "Se añadió la cuenta {email} con sincronización del calendario",
  "errors.toast.loadedOlder": { one: "Se cargó {n} mensaje anterior", other: "Se cargaron {n} mensajes anteriores" },
  "errors.toast.noOlder": "No hay mensajes anteriores en esta carpeta",
  "errors.limit": "Se alcanzó el límite de descarga ({n} correos por buzón). Aumenta el límite en Configuración > Buzones > Lectura y sincronización.",
  // ---- questions of store.ts
  "errors.ask.unsentTitle": "Tienes un mensaje sin enviar",
  "errors.ask.unsentBody": "Al abrir otro mensaje se cerrará el que estás escribiendo.",
  "errors.ask.keepWriting": "Seguir escribiendo",
  "errors.ask.saveContinue": "Guardar borrador y continuar",
  "errors.ask.discard": "Descartar",
  // ---- account presets of api.ts (provider names are not translated)
  "errors.provider.gmail.hint": "Requiere una contraseña de aplicación de Google (con la verificación en dos pasos activada).",
  "errors.provider.outlook.hint": "Usa preferentemente la pestaña Microsoft (OAuth). El inicio de sesión con contraseña solo funciona si la autenticación básica está habilitada; en ese caso, las cuentas personales necesitan una contraseña de aplicación.",
  "errors.provider.icloud.hint": "Apple no ofrece OAuth para aplicaciones de correo. Crea una contraseña específica de la aplicación en account.apple.com (Inicio de sesión y seguridad) y úsala aquí, con tu dirección completa de iCloud como correo electrónico.",
  "errors.provider.yahoo.hint": "Usa una contraseña de aplicación de Yahoo.",
  "errors.provider.bridge.hint": "Ejecuta Proton Mail Bridge y usa el nombre de usuario y la contraseña de Bridge (no tu contraseña de Proton). Bridge usa un certificado autofirmado en este equipo, así que se confía en el certificado.",
  "errors.provider.custom.label": "Otro (IMAP/SMTP)",
  // ---- platform.ts: where passwords are kept ("Passwords stay in {store}") and the risky-file examples
  "errors.os.credStore.macos": "tu llavero de macOS",
  "errors.os.credStore.linux": "el llavero del sistema",
  "errors.os.credStore.windows": "el Administrador de credenciales de Windows",
  "errors.os.risky.macos": ".app, .pkg, .command, .sh, .scpt, archivos de Office con macros (.docm, .xlsm) y similares",
  "errors.os.risky.linux": ".sh, .desktop, .AppImage, .run, .deb, archivos de Office con macros (.docm, .xlsm) y similares",
  "errors.os.risky.windows": ".exe, .bat, .cmd, .ps1, .js, .vbs, .msi, archivos de Office con macros (.docm, .xlsm) y similares",
});
