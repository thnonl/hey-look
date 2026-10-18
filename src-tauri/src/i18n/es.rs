//! The texts the operating system shows (tray menu, notifications, reminder titles, file dialog titles, repeat descriptions) in Spanish.
//! Neutral international Spanish, "tú" form. Weekday names are the plural form ("los lunes"): Monday to Friday do not change, and the
//! sentences below are built as "Todos los {list}" / "Cada {n} semanas los {list}".

use super::K;

/// The fixed texts.
pub fn text(k: K) -> &'static str {
    match k {
        K::TrayOpen => "Abrir Hey Look!",
        K::TrayCompose => "Nuevo mensaje",
        K::TraySync => "Comprobar correo ahora",
        K::TrayPause => "Pausar notificaciones",
        K::TrayQuit => "Salir de Hey Look!",
        K::MacQuit => "Salir de Hey Look!",
        K::MacAbout => "Acerca de Hey Look!",
        K::MacServices => "Servicios",
        K::MacHide => "Ocultar Hey Look!",
        K::MacHideOthers => "Ocultar otros",
        K::MacShowAll => "Mostrar todo",
        K::ActArchive => "Archivar",
        K::ActDelete => "Eliminar",
        K::ActRead => "Marcar como leído",
        K::ActFlag => "Marcar con bandera",
        K::ActReply => "Responder",
        K::ActSnooze => "Posponer",
        K::TrayHintTitle => "Hey Look! sigue en ejecución",
        K::TrayHintMac => "Sigue comprobando tu correo desde la barra de menús. Haz clic en el icono de Hey Look! del Dock o de la barra de menús para abrirlo de nuevo.",
        K::TrayHintLinux => "Sigue comprobando tu correo desde la bandeja del sistema. Elige Salir de Hey Look! en el menú del icono de la bandeja para cerrarlo.",
        K::TrayHintOther => "Sigue comprobando tu correo desde la bandeja del sistema. Haz clic con el botón derecho en el icono de la bandeja y elige Salir para cerrarlo.",
        K::TestTitle => "Notificación de prueba de Hey Look!",
        K::TestLine1 => "Las notificaciones funcionan",
        K::TestLine2 => "Así se verá el correo nuevo.",
        K::EveryDay => "Todos los días",
        K::EveryMonth => "Todos los meses",
        K::EveryYear => "Todos los años",
        K::SaveAttachmentsTo => "Guardar los adjuntos en",
        K::ChooseKeyFile => "Elegir un archivo de clave",
        K::OpenPgpKeys => "Claves OpenPGP",
        K::CalendarFile => "Archivo de calendario",
        K::SavePublicKey => "Guardar clave pública",
        K::SaveKeyBackup => "Guardar una copia de seguridad de tu clave",
        K::LoadFailTitle => "Hey Look! no pudo cargar su ventana",
        K::LoadFailWindows => "Hey Look! se inició, pero su ventana no pudo cargar la interfaz de la aplicación. Las causas más probables son que Microsoft Edge WebView2 Runtime falte o esté dañado (reinstálalo o repáralo desde Microsoft), o que un programa de seguridad lo esté bloqueando. Elige Reintentar para volver a intentarlo, o abre la carpeta de registros para ver qué ocurrió.",
        K::LoadFailMac => "Hey Look! se inició, pero su ventana no pudo cargar la interfaz de la aplicación. Las causas más probables son que el motor web integrado en macOS (WebKit) no se haya iniciado, por ejemplo tras una actualización del sistema interrumpida, o que un programa de seguridad lo esté bloqueando. Elige Reintentar para volver a intentarlo, o abre la carpeta de registros para ver qué ocurrió.",
        K::LoadFailLinux => "Hey Look! se inició, pero su ventana no pudo cargar la interfaz de la aplicación. Las causas más probables son que la biblioteca WebKitGTK (webkit2gtk-4.1) falte, sea demasiado antigua o esté dañada, o que la sesión no tenga una pantalla gráfica operativa. Elige Reintentar para volver a intentarlo, o abre la carpeta de registros para ver qué ocurrió.",
        K::LoadFailRetry => "Reintentar",
        K::LoadFailOpenLog => "Abrir la carpeta de registros",
        K::LoadFailQuit => "Salir",
        K::LoadFailLog => "Archivo de registro:",
        K::StartFailTitle => "Hey Look! no pudo iniciarse",
        K::StartFailBody => "Hey Look! no pudo iniciarse porque no se pudo crear su ventana.\n\nLo más habitual es que falte o esté dañado Microsoft WebView2 Runtime, un componente gratuito de Microsoft que las aplicaciones usan para mostrar sus ventanas. Instálalo o repáralo desde https://developer.microsoft.com/microsoft-edge/webview2/ (elige «Evergreen Bootstrapper» o «Evergreen Standalone Installer») y vuelve a abrir Hey Look!.\n\nLo ocurrido se guardó en el archivo de registro indicado abajo; si el problema continúa, envíalo a soporte.",
    }
}

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    match n {
        0 => "Hey Look!".to_string(),
        1 => "Hey Look! — 1 conversación sin leer".to_string(),
        n => format!("Hey Look! — {n} conversaciones sin leer"),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    format!("{n} mensajes nuevos")
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    format!("Vuelve a la bandeja de entrada: {who}")
}

/// Event reminder title: the event starts now (`minutes` = 0) or in `minutes` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    match minutes {
        0 => format!("{summary} empieza ahora"),
        1 => format!("{summary} en 1 minuto"),
        m => format!("{summary} en {m} minutos"),
    }
}

/// Day name (plural form, lower case), `i` = 0 for Monday.
pub fn day_name(i: usize) -> &'static str {
    const DAYS: [&str; 7] = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];
    DAYS[i % 7]
}

/// "lunes, martes y viernes"
pub fn day_list(days: &[String]) -> String {
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        n => format!("{} y {}", days[..n - 1].join(", "), days[n - 1]),
    }
}

/// "Todos los miércoles" / "Cada 2 semanas los miércoles" (`list` from `day_list`).
pub fn every_weekday(n: u32, list: &str) -> String {
    match n {
        1 => format!("Todos los {list}"),
        n => format!("Cada {n} semanas los {list}"),
    }
}

/// "Cada 2 días" etc. `unit`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    match unit {
        'd' => format!("Cada {n} días"),
        'm' => format!("Cada {n} meses"),
        _ => format!("Cada {n} años"),
    }
}

/// ", 5 veces"
pub fn times_tail(c: u32) -> String {
    match c {
        1 => ", 1 vez".to_string(),
        c => format!(", {c} veces"),
    }
}

/// ", hasta el 31 dic 2026" (`month0` = 0 for January)
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    const MONTHS: [&str; 12] = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    format!(", hasta el {day} {} {year}", MONTHS[(month0 % 12) as usize])
}
