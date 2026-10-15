//! The texts the operating system shows (tray menu, notifications, reminder titles, file dialog titles, repeat descriptions) in Russian.
//! STUB: English placeholders, to be translated. Edit this file only: every function below returns English now; translate the strings (and the word order
//! and plural rules where the language needs other ones). Keep the product name "Hey Look!" and the {placeholders} (`{n}`, `{who}`) as they are.
//! The compiler stops on a missing text. `cargo test --lib i18n` checks the file.

use super::K;

/// The fixed texts.
pub fn text(k: K) -> &'static str {
    match k {
        K::TrayOpen => "Open Hey Look!",
        K::TrayCompose => "New mail",
        K::TraySync => "Check mail now",
        K::TrayPause => "Pause notifications",
        K::TrayQuit => "Quit Hey Look!",
        K::MacQuit => "Quit Hey Look!",
        K::ActArchive => "Archive",
        K::ActDelete => "Delete",
        K::ActRead => "Mark as read",
        K::ActFlag => "Flag",
        K::ActReply => "Reply",
        K::ActSnooze => "Snooze",
        K::TrayHintTitle => "Hey Look! is still running",
        K::TrayHintMac => "It keeps checking your mail from the menu bar. Click the Hey Look! icon in the Dock or the menu bar to open it again.",
        K::TrayHintLinux => "It keeps checking your mail from the tray. Choose Quit Hey Look! in the tray icon’s menu to exit.",
        K::TrayHintOther => "It keeps checking your mail from the tray. Right-click the tray icon and choose Quit to exit.",
        K::TestTitle => "Hey Look! test notification",
        K::TestLine1 => "Notifications are working",
        K::TestLine2 => "This is how new mail will look.",
        K::EveryDay => "Every day",
        K::EveryMonth => "Every month",
        K::EveryYear => "Every year",
        K::SaveAttachmentsTo => "Save attachments to",
        K::ChooseKeyFile => "Choose a key file",
        K::OpenPgpKeys => "OpenPGP keys",
        K::CalendarFile => "Calendar file",
        K::SavePublicKey => "Save public key",
        K::SaveKeyBackup => "Save a backup of your key",
    }
}

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    match n {
        0 => "Hey Look!".to_string(),
        1 => "Hey Look! — 1 unread conversation".to_string(),
        n => format!("Hey Look! — {n} unread conversations"),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    format!("{n} new messages")
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    format!("Snooze ended: {who}")
}

/// Event reminder title: the event starts now (`minutes` = 0) or in `minutes` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    match minutes {
        0 => format!("{summary} is starting"),
        1 => format!("{summary} in 1 minute"),
        m => format!("{summary} in {m} minutes"),
    }
}

/// Day name, `i` = 0 for Monday.
pub fn day_name(i: usize) -> &'static str {
    const DAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    DAYS[i % 7]
}

/// "Monday, Tuesday and Friday"
pub fn day_list(days: &[String]) -> String {
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        n => format!("{} and {}", days[..n - 1].join(", "), days[n - 1]),
    }
}

/// "Every Wednesday" / "Every 2 weeks on Wednesday" (`list` from `day_list`).
pub fn every_weekday(n: u32, list: &str) -> String {
    match n {
        1 => format!("Every {list}"),
        n => format!("Every {n} weeks on {list}"),
    }
}

/// "Every 2 days" etc. `unit`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    match unit {
        'd' => format!("Every {n} days"),
        'm' => format!("Every {n} months"),
        _ => format!("Every {n} years"),
    }
}

/// ", 5 times"
pub fn times_tail(c: u32) -> String {
    match c {
        1 => ", 1 time".to_string(),
        c => format!(", {c} times"),
    }
}

/// ", until 31 Dec 2026" (`month0` = 0 for January)
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!(", until {day} {} {year}", MONTHS[(month0 % 12) as usize])
}
