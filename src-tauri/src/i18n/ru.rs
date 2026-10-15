//! The texts the operating system shows (tray menu, notifications, reminder titles, file dialog titles, repeat descriptions) in Russian.
//! Keep the product name "Hey Look!" and the {placeholders} (`{n}`, `{who}`) as they are.
//! The compiler stops on a missing text. `cargo test --lib i18n` checks the file.

use super::K;

/// The fixed texts.
pub fn text(k: K) -> &'static str {
    match k {
        K::TrayOpen => "Открыть Hey Look!",
        K::TrayCompose => "Новое письмо",
        K::TraySync => "Проверить почту",
        K::TrayPause => "Приостановить уведомления",
        K::TrayQuit => "Выйти из Hey Look!",
        K::MacQuit => "Выйти из Hey Look!",
        K::ActArchive => "Архивировать",
        K::ActDelete => "Удалить",
        K::ActRead => "Прочитано",
        K::ActFlag => "Флажок",
        K::ActReply => "Ответить",
        K::ActSnooze => "Отложить",
        K::TrayHintTitle => "Hey Look! продолжает работу",
        K::TrayHintMac => "Приложение продолжает проверять почту из строки меню. Чтобы открыть его снова, щёлкните значок Hey Look! в Dock или в строке меню.",
        K::TrayHintLinux => "Приложение продолжает проверять почту из трея. Чтобы выйти, выберите «Выйти из Hey Look!» в меню значка в трее.",
        K::TrayHintOther => "Приложение продолжает проверять почту из трея. Чтобы выйти, щёлкните значок в трее правой кнопкой мыши и выберите «Выйти».",
        K::TestTitle => "Тестовое уведомление Hey Look!",
        K::TestLine1 => "Уведомления работают",
        K::TestLine2 => "Так будут выглядеть новые письма.",
        K::EveryDay => "Каждый день",
        K::EveryMonth => "Каждый месяц",
        K::EveryYear => "Каждый год",
        K::SaveAttachmentsTo => "Сохранить вложения в",
        K::ChooseKeyFile => "Выберите файл ключа",
        K::OpenPgpKeys => "Ключи OpenPGP",
        K::CalendarFile => "Файл календаря",
        K::SavePublicKey => "Сохранить открытый ключ",
        K::SaveKeyBackup => "Сохранить резервную копию ключа",
    }
}

/// The Russian noun form after a number: 1, 21, 31 ... `one`; 2-4, 22-24 ... `few`; 0, 5-20, 25-30 ... `many`.
fn plural(n: u64, one: &'static str, few: &'static str, many: &'static str) -> &'static str {
    match (n % 10, n % 100) {
        (_, 11..=14) => many,
        (1, _) => one,
        (2..=4, _) => few,
        _ => many,
    }
}

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    match n {
        0 => "Hey Look!".to_string(),
        n => format!(
            "Hey Look! — {n} {}",
            plural(n as u64, "непрочитанная беседа", "непрочитанные беседы", "непрочитанных бесед")
        ),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    format!("{n} {}", plural(n as u64, "новое письмо", "новых письма", "новых писем"))
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    format!("Отсрочка закончилась: {who}")
}

/// Event reminder title: the event starts now (`minutes` = 0) or in `minutes` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    match minutes {
        0 => format!("{summary} начинается"),
        m => format!(
            "{summary} — через {m} {}",
            plural(m.unsigned_abs(), "минуту", "минуты", "минут")
        ),
    }
}

/// Day name, `i` = 0 for Monday. The dative plural, because the descriptions read "По понедельникам" (every Monday).
pub fn day_name(i: usize) -> &'static str {
    const DAYS: [&str; 7] = ["понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям"];
    DAYS[i % 7]
}

/// "понедельникам, вторникам и пятницам"
pub fn day_list(days: &[String]) -> String {
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        n => format!("{} и {}", days[..n - 1].join(", "), days[n - 1]),
    }
}

/// "По средам" / "Раз в 2 недели по средам" (`list` from `day_list`).
pub fn every_weekday(n: u32, list: &str) -> String {
    match n {
        1 => format!("По {list}"),
        n => format!("Раз в {n} {} по {list}", plural(n as u64, "неделю", "недели", "недель")),
    }
}

/// "Раз в 2 дня" etc. `unit`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    let noun = match unit {
        'd' => plural(n as u64, "день", "дня", "дней"),
        'm' => plural(n as u64, "месяц", "месяца", "месяцев"),
        _ => plural(n as u64, "год", "года", "лет"),
    };
    match (n, unit) {
        (1, 'd') => "Каждый день".to_string(),
        (1, 'm') => "Каждый месяц".to_string(),
        (1, _) => "Каждый год".to_string(),
        _ => format!("Раз в {n} {noun}"),
    }
}

/// ", 5 раз"
pub fn times_tail(c: u32) -> String {
    format!(", {c} {}", plural(c as u64, "раз", "раза", "раз"))
}

/// ", до 31 декабря 2026 г." (`month0` = 0 for January)
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    const MONTHS: [&str; 12] = [
        "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ];
    format!(", до {day} {} {year} г.", MONTHS[(month0 % 12) as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plural_forms_follow_cldr() {
        let f = |n| plural(n, "one", "few", "many");
        for n in [1, 21, 31, 101] {
            assert_eq!(f(n), "one", "{n}");
        }
        for n in [2, 3, 4, 22, 24, 102] {
            assert_eq!(f(n), "few", "{n}");
        }
        for n in [0, 5, 11, 12, 14, 20, 25, 30, 111, 112, 114] {
            assert_eq!(f(n), "many", "{n}");
        }
    }

    #[test]
    fn sentences_agree_with_the_number() {
        assert_eq!(unread_tooltip(1), "Hey Look! — 1 непрочитанная беседа");
        assert_eq!(unread_tooltip(2), "Hey Look! — 2 непрочитанные беседы");
        assert_eq!(unread_tooltip(5), "Hey Look! — 5 непрочитанных бесед");
        assert_eq!(unread_tooltip(11), "Hey Look! — 11 непрочитанных бесед");
        assert_eq!(unread_tooltip(21), "Hey Look! — 21 непрочитанная беседа");
        assert_eq!(unread_tooltip(22), "Hey Look! — 22 непрочитанные беседы");
        assert_eq!(unread_tooltip(25), "Hey Look! — 25 непрочитанных бесед");
        assert_eq!(new_messages(4), "4 новых письма");
        assert_eq!(new_messages(21), "21 новое письмо");
        assert_eq!(event_reminder("Встреча", 0), "Встреча начинается");
        assert_eq!(event_reminder("Встреча", 1), "Встреча — через 1 минуту");
        assert_eq!(event_reminder("Встреча", 15), "Встреча — через 15 минут");
        assert_eq!(event_reminder("Встреча", 22), "Встреча — через 22 минуты");
        assert_eq!(every_n(2, 'd'), "Раз в 2 дня");
        assert_eq!(every_n(5, 'm'), "Раз в 5 месяцев");
        assert_eq!(every_n(21, 'y'), "Раз в 21 год");
        assert_eq!(times_tail(1), ", 1 раз");
        assert_eq!(times_tail(3), ", 3 раза");
        assert_eq!(times_tail(12), ", 12 раз");
        assert_eq!(until_tail(31, 11, 2026), ", до 31 декабря 2026 г.");
    }

    #[test]
    fn weekday_lists() {
        let days: Vec<String> = [0, 2, 4].iter().map(|&i| day_name(i).to_string()).collect();
        assert_eq!(every_weekday(1, &day_list(&days)), "По понедельникам, средам и пятницам");
        assert_eq!(every_weekday(2, &day_list(&days[1..2])), "Раз в 2 недели по средам");
        assert_eq!(every_weekday(5, &day_list(&days[1..2])), "Раз в 5 недель по средам");
    }
}
