//! The texts the operating system shows (tray menu, notifications, reminder titles, file dialog titles, repeat descriptions) in German.
//! Edit this file only: every function below returns the German text; the word order and plural rules are German ones. Keep the product
//! name "Hey Look!" and the {placeholders} (`{n}`, `{who}`) as they are.
//! The compiler stops on a missing text. `cargo test --lib i18n` checks the file.

use super::K;

/// The fixed texts.
pub fn text(k: K) -> &'static str {
    match k {
        K::TrayOpen => "Hey Look! öffnen",
        K::TrayCompose => "Neue E-Mail",
        K::TraySync => "E-Mails jetzt abrufen",
        K::TrayPause => "Benachrichtigungen pausieren",
        K::TrayQuit => "Hey Look! beenden",
        K::MacQuit => "Hey Look! beenden",
        K::MacAbout => "Über Hey Look!",
        K::MacServices => "Dienste",
        K::MacHide => "Hey Look! ausblenden",
        K::MacHideOthers => "Andere ausblenden",
        K::MacShowAll => "Alle einblenden",
        K::ActArchive => "Archivieren",
        K::ActDelete => "Löschen",
        K::ActRead => "Als gelesen markieren",
        K::ActFlag => "Kennzeichnen",
        K::ActReply => "Antworten",
        K::ActSnooze => "Zurückstellen",
        K::TrayHintTitle => "Hey Look! läuft weiter",
        K::TrayHintMac => "Die App ruft weiterhin E-Mails ab und bleibt in der Menüleiste. Klicken Sie auf das Symbol von Hey Look! im Dock oder in der Menüleiste, um die App wieder zu öffnen.",
        K::TrayHintLinux => "Die App ruft weiterhin E-Mails ab und bleibt im Infobereich. Wählen Sie im Menü des Infobereich-Symbols „Hey Look! beenden“, um sie zu beenden.",
        K::TrayHintOther => "Die App ruft weiterhin E-Mails ab und bleibt im Infobereich. Klicken Sie mit der rechten Maustaste auf das Symbol im Infobereich und wählen Sie „Hey Look! beenden“, um sie zu beenden.",
        K::TestTitle => "Hey Look! Testbenachrichtigung",
        K::TestLine1 => "Benachrichtigungen funktionieren",
        K::TestLine2 => "So sehen neue E-Mails aus.",
        K::EveryDay => "Jeden Tag",
        K::EveryMonth => "Jeden Monat",
        K::EveryYear => "Jedes Jahr",
        K::SaveAttachmentsTo => "Anhänge speichern in",
        K::ChooseKeyFile => "Schlüsseldatei auswählen",
        K::OpenPgpKeys => "OpenPGP-Schlüssel",
        K::CalendarFile => "Kalenderdatei",
        K::SavePublicKey => "Öffentlichen Schlüssel speichern",
        K::SaveKeyBackup => "Sicherung Ihres Schlüssels speichern",
    }
}

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    match n {
        0 => "Hey Look!".to_string(),
        1 => "Hey Look! – 1 ungelesene Unterhaltung".to_string(),
        n => format!("Hey Look! – {n} ungelesene Unterhaltungen"),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    format!("{n} neue Nachrichten")
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    format!("Zurückstellung abgelaufen: {who}")
}

/// Event reminder title: the event starts now (`minutes` = 0) or in `minutes` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    match minutes {
        0 => format!("{summary} beginnt"),
        1 => format!("{summary} in 1 Minute"),
        m => format!("{summary} in {m} Minuten"),
    }
}

/// Day name, `i` = 0 for Monday.
pub fn day_name(i: usize) -> &'static str {
    const DAYS: [&str; 7] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
    DAYS[i % 7]
}

/// "Montag, Dienstag und Freitag"
pub fn day_list(days: &[String]) -> String {
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        n => format!("{} und {}", days[..n - 1].join(", "), days[n - 1]),
    }
}

/// "Jeden Mittwoch" / "Alle 2 Wochen am Mittwoch" (`list` from `day_list`).
pub fn every_weekday(n: u32, list: &str) -> String {
    match n {
        1 => format!("Jeden {list}"),
        n => format!("Alle {n} Wochen am {list}"),
    }
}

/// "Alle 2 Tage" etc. `unit`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    match (unit, n) {
        ('d', 1) => "Jeden Tag".to_string(),
        ('d', n) => format!("Alle {n} Tage"),
        ('m', 1) => "Jeden Monat".to_string(),
        ('m', n) => format!("Alle {n} Monate"),
        (_, 1) => "Jedes Jahr".to_string(),
        (_, n) => format!("Alle {n} Jahre"),
    }
}

/// ", 5-mal"
pub fn times_tail(c: u32) -> String {
    format!(", {c}-mal")
}

/// ", bis 31. Dez. 2026" (`month0` = 0 for January)
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    const MONTHS: [&str; 12] = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."];
    format!(", bis {day}. {} {year}", MONTHS[(month0 % 12) as usize])
}
