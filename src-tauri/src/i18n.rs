//! Texts the operating system shows (tray menu, macOS Quit item, notifications, repeat descriptions) in the language of the Language
//! setting. The UI mirrors its resolved language (the registry code: `en`, `vi`, `fr`, `zh-Hans`, `es`, `ja`, `de`, `ru`) to the plain setting
//! `ui_language`; this module keeps it in memory.
//! English, Vietnamese and French sit side by side below. Every later language has its own file (`i18n/<code>.rs`, scaffolded by
//! `scripts/i18n-new-language.mjs`) so translators never edit the same file; the `match` arms that call them are in this file.
//! Everything else the person reads is translated in the UI (`src/i18n/`): errors that reach it carry a stable `CODE` (see `coded`).
//!
//! The English texts are the ones the app has always shown (QA specs and tests assert them); `Lang::En` is also the fallback.

use std::sync::atomic::{AtomicU8, Ordering};

mod de;
mod es;
mod ja;
mod ru;
mod zh_hans;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En,
    Vi,
    Fr,
    ZhHans,
    Es,
    Ja,
    De,
    Ru,
}

/// Every language, in the order of the registry (`src/i18n/languages.ts`) and of the numbers stored in `LANG`.
pub const LANGS: [Lang; 8] = [Lang::En, Lang::Vi, Lang::Fr, Lang::ZhHans, Lang::Es, Lang::Ja, Lang::De, Lang::Ru];

static LANG: AtomicU8 = AtomicU8::new(0);

/// The registry codes (`en`, `vi`, `fr`, `zh-Hans`, `es`, `ja`, `de`, `ru`), also with a region (`vi-VN`, `fr_CA`, `zh-CN`, …); anything else
/// is English. Traditional Chinese (`zh-Hant`, `zh-TW`, `zh-HK`) is not Simplified, so it stays English.
pub fn parse(code: &str) -> Lang {
    let c = code.trim().to_ascii_lowercase().replace('_', "-");
    match c.split('-').next().unwrap_or("") {
        "vi" => Lang::Vi,
        "fr" => Lang::Fr,
        "zh" if !(c.contains("hant") || c.ends_with("-tw") || c.ends_with("-hk") || c.ends_with("-mo")) => Lang::ZhHans,
        "es" => Lang::Es,
        "ja" => Lang::Ja,
        "de" => Lang::De,
        "ru" => Lang::Ru,
        _ => Lang::En,
    }
}

pub fn lang() -> Lang {
    LANGS.get(LANG.load(Ordering::Relaxed) as usize).copied().unwrap_or(Lang::En)
}

/// Sets the language; true when it changed.
pub fn set_lang(code: &str) -> bool {
    let l = parse(code);
    let n = LANGS.iter().position(|x| *x == l).unwrap_or(0) as u8;
    LANG.swap(n, Ordering::Relaxed) != n
}

/// Column of English / Vietnamese / French in the `texts` table; the later languages have their own files.
fn idx(l: Lang) -> usize {
    match l {
        Lang::Vi => 1,
        Lang::Fr => 2,
        _ => 0,
    }
}

/// A fixed text of the app. Add English, Vietnamese and French in `texts` and every other language in its file `i18n/<code>.rs`
/// (the compiler insists on every variant).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum K {
    TrayOpen,
    TrayCompose,
    TraySync,
    TrayPause,
    TrayQuit,
    MacQuit,
    ActArchive,
    ActDelete,
    ActRead,
    ActFlag,
    ActReply,
    ActSnooze,
    TrayHintTitle,
    TrayHintMac,
    TrayHintLinux,
    TrayHintOther,
    TestTitle,
    TestLine1,
    TestLine2,
    EveryDay,
    EveryMonth,
    EveryYear,
    SaveAttachmentsTo,
    ChooseKeyFile,
    OpenPgpKeys,
    CalendarFile,
    SavePublicKey,
    SaveKeyBackup,
}

pub const ALL: &[K] = &[
    K::TrayOpen, K::TrayCompose, K::TraySync, K::TrayPause, K::TrayQuit, K::MacQuit, K::ActArchive, K::ActDelete, K::ActRead, K::ActFlag,
    K::ActReply, K::ActSnooze, K::TrayHintTitle, K::TrayHintMac, K::TrayHintLinux, K::TrayHintOther, K::TestTitle, K::TestLine1, K::TestLine2,
    K::EveryDay, K::EveryMonth, K::EveryYear, K::SaveAttachmentsTo, K::ChooseKeyFile,
    K::OpenPgpKeys, K::CalendarFile, K::SavePublicKey, K::SaveKeyBackup,
];

/// English, Vietnamese, French. The product name stays "Hey Look!".
fn texts(k: K) -> [&'static str; 3] {
    match k {
        K::TrayOpen => ["Open Hey Look!", "Mở Hey Look!", "Ouvrir Hey Look!"],
        K::TrayCompose => ["New mail", "Thư mới", "Nouveau message"],
        K::TraySync => ["Check mail now", "Kiểm tra thư ngay", "Relever le courrier maintenant"],
        K::TrayPause => ["Pause notifications", "Tạm dừng thông báo", "Suspendre les notifications"],
        K::TrayQuit | K::MacQuit => ["Quit Hey Look!", "Thoát Hey Look!", "Quitter Hey Look!"],
        K::ActArchive => ["Archive", "Lưu trữ", "Archiver"],
        K::ActDelete => ["Delete", "Xóa", "Supprimer"],
        K::ActRead => ["Mark as read", "Đánh dấu đã đọc", "Marquer comme lu"],
        K::ActFlag => ["Flag", "Gắn cờ", "Assurer un suivi"],
        K::ActReply => ["Reply", "Trả lời", "Répondre"],
        K::ActSnooze => ["Snooze", "Tạm ẩn", "Mettre en attente"],
        K::TrayHintTitle => ["Hey Look! is still running", "Hey Look! vẫn đang chạy", "Hey Look! est toujours en cours d’exécution"],
        K::TrayHintMac => [
            "It keeps checking your mail from the menu bar. Click the Hey Look! icon in the Dock or the menu bar to open it again.",
            "Ứng dụng vẫn kiểm tra thư từ thanh menu. Nhấp vào biểu tượng Hey Look! trong Dock hoặc thanh menu để mở lại.",
            "Il continue de relever votre courrier depuis la barre des menus. Cliquez sur l’icône Hey Look! dans le Dock ou la barre des menus pour le rouvrir.",
        ],
        K::TrayHintLinux => [
            "It keeps checking your mail from the tray. Choose Quit Hey Look! in the tray icon’s menu to exit.",
            "Ứng dụng vẫn kiểm tra thư từ khay hệ thống. Chọn Thoát Hey Look! trong menu của biểu tượng khay để thoát.",
            "Il continue de relever votre courrier depuis la zone de notification. Choisissez Quitter Hey Look! dans le menu de l’icône pour le fermer.",
        ],
        K::TrayHintOther => [
            "It keeps checking your mail from the tray. Right-click the tray icon and choose Quit to exit.",
            "Ứng dụng vẫn kiểm tra thư từ khay hệ thống. Nhấp chuột phải vào biểu tượng khay và chọn Thoát để thoát.",
            "Il continue de relever votre courrier depuis la zone de notification. Faites un clic droit sur l’icône et choisissez Quitter pour le fermer.",
        ],
        K::TestTitle => ["Hey Look! test notification", "Thông báo thử của Hey Look!", "Notification de test de Hey Look!"],
        K::TestLine1 => ["Notifications are working", "Thông báo đang hoạt động", "Les notifications fonctionnent"],
        K::TestLine2 => ["This is how new mail will look.", "Thư mới sẽ hiển thị như thế này.", "Voici l’aspect d’un nouveau message."],
        K::EveryDay => ["Every day", "Hằng ngày", "Tous les jours"],
        K::EveryMonth => ["Every month", "Hằng tháng", "Tous les mois"],
        K::EveryYear => ["Every year", "Hằng năm", "Tous les ans"],
        K::SaveAttachmentsTo => ["Save attachments to", "Lưu tệp đính kèm vào", "Enregistrer les pièces jointes dans"],
        K::ChooseKeyFile => ["Choose a key file", "Chọn tệp khóa", "Choisir un fichier de clé"],
        K::OpenPgpKeys => ["OpenPGP keys", "Khóa OpenPGP", "Clés OpenPGP"],
        K::CalendarFile => ["Calendar file", "Tệp lịch", "Fichier d’agenda"],
        K::SavePublicKey => ["Save public key", "Lưu khóa công khai", "Enregistrer la clé publique"],
        K::SaveKeyBackup => ["Save a backup of your key", "Lưu bản sao lưu khóa của bạn", "Enregistrer une sauvegarde de votre clé"],
    }
}

/// The text in the current language.
pub fn tr(k: K) -> &'static str {
    tr_in(lang(), k)
}
pub fn tr_in(l: Lang, k: K) -> &'static str {
    match l {
        Lang::En | Lang::Vi | Lang::Fr => texts(k)[idx(l)],
        Lang::ZhHans => zh_hans::text(k),
        Lang::Es => es::text(k),
        Lang::Ja => ja::text(k),
        Lang::De => de::text(k),
        Lang::Ru => ru::text(k),
    }
}

/// The text in English (for logs and tests).
#[allow(dead_code)]
pub fn en(k: K) -> &'static str {
    texts(k)[0]
}

// ---- texts with numbers / names ----------------------------------------------------------------------------------------------

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    unread_tooltip_in(lang(), n)
}
pub fn unread_tooltip_in(l: Lang, n: u32) -> String {
    match (n, l) {
        (0, _) => "Hey Look!".to_string(),
        (n, Lang::ZhHans) => zh_hans::unread_tooltip(n),
        (n, Lang::Es) => es::unread_tooltip(n),
        (n, Lang::Ja) => ja::unread_tooltip(n),
        (n, Lang::De) => de::unread_tooltip(n),
        (n, Lang::Ru) => ru::unread_tooltip(n),
        (1, Lang::En) => "Hey Look! — 1 unread conversation".to_string(),
        (n, Lang::En) => format!("Hey Look! — {n} unread conversations"),
        (n, Lang::Vi) => format!("Hey Look! — {n} cuộc trò chuyện chưa đọc"),
        (1, Lang::Fr) => "Hey Look! — 1 conversation non lue".to_string(),
        (n, Lang::Fr) => format!("Hey Look! — {n} conversations non lues"),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    new_messages_in(lang(), n)
}
pub fn new_messages_in(l: Lang, n: usize) -> String {
    match l {
        Lang::En => format!("{n} new messages"),
        Lang::Vi => format!("{n} thư mới"),
        Lang::Fr => format!("{n} nouveaux messages"),
        Lang::ZhHans => zh_hans::new_messages(n),
        Lang::Es => es::new_messages(n),
        Lang::Ja => ja::new_messages(n),
        Lang::De => de::new_messages(n),
        Lang::Ru => ru::new_messages(n),
    }
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    snooze_ended_in(lang(), who)
}
pub fn snooze_ended_in(l: Lang, who: &str) -> String {
    match l {
        Lang::En => format!("Snooze ended: {who}"),
        Lang::Vi => format!("Hết thời gian tạm ẩn: {who}"),
        Lang::Fr => format!("Fin de la mise en attente\u{a0}: {who}"),
        Lang::ZhHans => zh_hans::snooze_ended(who),
        Lang::Es => es::snooze_ended(who),
        Lang::Ja => ja::snooze_ended(who),
        Lang::De => de::snooze_ended(who),
        Lang::Ru => ru::snooze_ended(who),
    }
}

/// Event reminder title: the event starts now (`minutes` = 0) or in `minutes` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    event_reminder_in(lang(), summary, minutes)
}
pub fn event_reminder_in(l: Lang, summary: &str, minutes: i64) -> String {
    match (l, minutes) {
        (Lang::En, 0) => format!("{summary} is starting"),
        (Lang::En, 1) => format!("{summary} in 1 minute"),
        (Lang::En, m) => format!("{summary} in {m} minutes"),
        (Lang::Vi, 0) => format!("{summary} sắp bắt đầu"),
        (Lang::Vi, m) => format!("{summary} sau {m} phút"),
        (Lang::Fr, 0) => format!("{summary} commence"),
        (Lang::Fr, 1) => format!("{summary} dans 1 minute"),
        (Lang::Fr, m) => format!("{summary} dans {m} minutes"),
        (Lang::ZhHans, m) => zh_hans::event_reminder(summary, m),
        (Lang::Es, m) => es::event_reminder(summary, m),
        (Lang::Ja, m) => ja::event_reminder(summary, m),
        (Lang::De, m) => de::event_reminder(summary, m),
        (Lang::Ru, m) => ru::event_reminder(summary, m),
    }
}

/// Body of the one-time "still running" notice, per OS name (`std::env::consts::OS`).
pub fn tray_hint(os: &str) -> &'static str {
    tray_hint_in(lang(), os)
}
pub fn tray_hint_in(l: Lang, os: &str) -> &'static str {
    tr_in(l, match os {
        "macos" => K::TrayHintMac,
        "linux" => K::TrayHintLinux,
        _ => K::TrayHintOther,
    })
}

// ---- repeat descriptions (ical::describe_rrule) ----------------------------------------------------------------------------

/// Day name, `i` = 0 for Monday. `plural` is the French "every Wednesday" form (mercredis); the caller asks for it only for "every week".
/// (The later languages ignore `plural`; a language that needs it takes it into its own `day_name`.)
pub fn day_name(i: usize, plural: bool) -> &'static str {
    day_name_in(lang(), i, plural)
}
pub fn day_name_in(l: Lang, i: usize, plural: bool) -> &'static str {
    const EN: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const VI: [&str; 7] = ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ nhật"];
    const FR: [&str; 7] = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
    const FRS: [&str; 7] = ["lundis", "mardis", "mercredis", "jeudis", "vendredis", "samedis", "dimanches"];
    let i = i % 7;
    match l {
        Lang::En => EN[i],
        Lang::Vi => VI[i],
        Lang::Fr if plural => FRS[i],
        Lang::Fr => FR[i],
        Lang::ZhHans => zh_hans::day_name(i),
        Lang::Es => es::day_name(i),
        Lang::Ja => ja::day_name(i),
        Lang::De => de::day_name(i),
        Lang::Ru => ru::day_name(i),
    }
}

/// "Monday, Tuesday and Friday"
pub fn day_list(days: &[String]) -> String {
    day_list_in(lang(), days)
}
pub fn day_list_in(l: Lang, days: &[String]) -> String {
    let and = match l {
        Lang::En => "and",
        Lang::Vi => "và",
        Lang::Fr => "et",
        Lang::ZhHans => return zh_hans::day_list(days),
        Lang::Es => return es::day_list(days),
        Lang::Ja => return ja::day_list(days),
        Lang::De => return de::day_list(days),
        Lang::Ru => return ru::day_list(days),
    };
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        n => format!("{} {} {}", days[..n - 1].join(", "), and, days[n - 1]),
    }
}

/// "Every Wednesday" / "Every 2 weeks on Wednesday" (`list` from `day_list`).
pub fn every_weekday(n: u32, list: &str) -> String {
    every_weekday_in(lang(), n, list)
}
pub fn every_weekday_in(l: Lang, n: u32, list: &str) -> String {
    match (l, n) {
        (Lang::En, 1) => format!("Every {list}"),
        (Lang::En, n) => format!("Every {n} weeks on {list}"),
        (Lang::Vi, 1) => format!("Mỗi {list}"),
        (Lang::Vi, n) => format!("Mỗi {n} tuần vào {list}"),
        (Lang::Fr, 1) => format!("Tous les {list}"),
        (Lang::Fr, n) => format!("Toutes les {n} semaines le {list}"),
        (Lang::ZhHans, n) => zh_hans::every_weekday(n, list),
        (Lang::Es, n) => es::every_weekday(n, list),
        (Lang::Ja, n) => ja::every_weekday(n, list),
        (Lang::De, n) => de::every_weekday(n, list),
        (Lang::Ru, n) => ru::every_weekday(n, list),
    }
}

/// "Every 2 days" etc. `unit`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    every_n_in(lang(), n, unit)
}
pub fn every_n_in(l: Lang, n: u32, unit: char) -> String {
    match (l, unit) {
        (Lang::En, 'd') => format!("Every {n} days"),
        (Lang::En, 'm') => format!("Every {n} months"),
        (Lang::En, _) => format!("Every {n} years"),
        (Lang::Vi, 'd') => format!("Mỗi {n} ngày"),
        (Lang::Vi, 'm') => format!("Mỗi {n} tháng"),
        (Lang::Vi, _) => format!("Mỗi {n} năm"),
        (Lang::Fr, 'd') => format!("Tous les {n} jours"),
        (Lang::Fr, 'm') => format!("Tous les {n} mois"),
        (Lang::Fr, _) => format!("Tous les {n} ans"),
        (Lang::ZhHans, u) => zh_hans::every_n(n, u),
        (Lang::Es, u) => es::every_n(n, u),
        (Lang::Ja, u) => ja::every_n(n, u),
        (Lang::De, u) => de::every_n(n, u),
        (Lang::Ru, u) => ru::every_n(n, u),
    }
}

/// ", 5 times"
pub fn times_tail(c: u32) -> String {
    times_tail_in(lang(), c)
}
pub fn times_tail_in(l: Lang, c: u32) -> String {
    match (l, c) {
        (Lang::En, 1) => ", 1 time".to_string(),
        (Lang::En, c) => format!(", {c} times"),
        (Lang::Vi, c) => format!(", {c} lần"),
        (Lang::Fr, 1) => ", 1 fois".to_string(),
        (Lang::Fr, c) => format!(", {c} fois"),
        (Lang::ZhHans, c) => zh_hans::times_tail(c),
        (Lang::Es, c) => es::times_tail(c),
        (Lang::Ja, c) => ja::times_tail(c),
        (Lang::De, c) => de::times_tail(c),
        (Lang::Ru, c) => ru::times_tail(c),
    }
}

/// ", until 31 Dec 2026"
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    until_tail_in(lang(), day, month0, year)
}
pub fn until_tail_in(l: Lang, day: u32, month0: u32, year: i32) -> String {
    const EN: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const FR: [&str; 12] = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
    let m = (month0 % 12) as usize;
    match l {
        Lang::En => format!(", until {day} {} {year}", EN[m]),
        Lang::Vi => format!(", đến {day} thg {} {year}", m + 1),
        Lang::Fr => format!(", jusqu’au {day} {} {year}", FR[m]),
        Lang::ZhHans => zh_hans::until_tail(day, month0, year),
        Lang::Es => es::until_tail(day, month0, year),
        Lang::Ja => ja::until_tail(day, month0, year),
        Lang::De => de::until_tail(day, month0, year),
        Lang::Ru => ru::until_tail(day, month0, year),
    }
}

// ---- errors that reach the UI --------------------------------------------------------------------------------------------------

fn escape(v: &str) -> String {
    v.replace('%', "%25").replace('|', "%7C").replace(':', "%3A").replace('\n', "%0A")
}

/// An error the UI translates: `CODE: English text`, or `CODE|name=value|…: English text` when the sentence has values.
/// The UI looks `backend.CODE` up in its dictionary (`src/i18n/ns/backend.ts`), fills `{name}` from the values and falls back to
/// the English text when it has no entry (an older UI, a code it does not know). Values are percent-escaped for `%`, `|`, `:`, newline.
pub fn coded(code: &str, params: &[(&str, &str)], english: &str) -> String {
    let mut s = code.to_string();
    for (k, v) in params {
        s.push('|');
        s.push_str(k);
        s.push('=');
        s.push_str(&escape(v));
    }
    s.push_str(": ");
    s.push_str(english);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_takes_the_language_part_only() {
        assert_eq!(parse("vi"), Lang::Vi);
        assert_eq!(parse("vi-VN"), Lang::Vi);
        assert_eq!(parse("FR_ca"), Lang::Fr);
        assert_eq!(parse("en-GB"), Lang::En);
        assert_eq!(parse(""), Lang::En);
        assert_eq!(parse("system"), Lang::En);
        assert_eq!(parse("klingon"), Lang::En);
    }

    #[test]
    fn parse_knows_every_registry_code() {
        // the codes of src/i18n/languages.ts, as the UI mirrors them to the `ui_language` setting
        for (code, l) in [("en", Lang::En), ("vi", Lang::Vi), ("fr", Lang::Fr), ("zh-Hans", Lang::ZhHans), ("es", Lang::Es), ("ja", Lang::Ja), ("de", Lang::De), ("ru", Lang::Ru)] {
            assert_eq!(parse(code), l, "{code}");
            assert_eq!(parse(&code.to_ascii_uppercase()), l, "{code} upper case");
        }
        assert_eq!(parse("zh-CN"), Lang::ZhHans);
        assert_eq!(parse("zh_SG"), Lang::ZhHans);
        assert_eq!(parse("zh"), Lang::ZhHans);
        assert_eq!(parse("de-AT"), Lang::De);
        assert_eq!(parse("es_MX"), Lang::Es);
        assert_eq!(parse("ja-JP"), Lang::Ja);
        assert_eq!(parse("ru-RU"), Lang::Ru);
        // Traditional Chinese is not a language of the app
        for c in ["zh-Hant", "zh-TW", "zh_HK", "zh-Hant-TW"] {
            assert_eq!(parse(c), Lang::En, "{c}");
        }
    }

    #[test]
    fn every_text_exists_in_all_three_languages() {
        for k in ALL {
            let t = texts(*k);
            for (i, s) in t.iter().enumerate() {
                assert!(!s.trim().is_empty(), "{k:?} language {i} is empty");
            }
            assert_ne!(t[0], t[1], "{k:?}: the Vietnamese text is the English one") ;
            assert_ne!(t[0], t[2], "{k:?}: the French text is the English one");
        }
    }

    #[test]
    fn every_language_has_every_text_and_sentence() {
        // the per-language files (i18n/<code>.rs) start as English placeholders; they must never be empty or lose a placeholder
        for l in LANGS {
            for k in ALL {
                assert!(!tr_in(l, *k).trim().is_empty(), "{l:?} {k:?}");
            }
            assert_eq!(unread_tooltip_in(l, 0), "Hey Look!", "{l:?}");
            for n in [1u32, 2, 5, 11, 21, 22, 25] {
                assert!(unread_tooltip_in(l, n).contains(&n.to_string()) || n == 1, "{l:?} unread {n}");
            }
            assert!(new_messages_in(l, 5).contains('5'), "{l:?}");
            assert!(snooze_ended_in(l, "Ann").contains("Ann"), "{l:?}");
            for m in [0i64, 1, 2, 5, 15, 21] {
                assert!(event_reminder_in(l, "Stand-up", m).contains("Stand-up"), "{l:?} {m}");
            }
            let names: Vec<String> = (0..7).map(|i| day_name_in(l, i, true).to_string()).collect();
            assert!(names.iter().all(|n| !n.is_empty()), "{l:?}");
            assert!(day_list_in(l, &names[..3]).contains(&names[0]) && day_list_in(l, &names[..3]).contains(&names[2]), "{l:?}");
            assert_eq!(day_list_in(l, &names[..1]), names[0], "{l:?}");
            assert!(every_weekday_in(l, 1, &names[0]).contains(&names[0]), "{l:?}");
            assert!(every_weekday_in(l, 3, &names[0]).contains('3'), "{l:?}");
            for u in ['d', 'm', 'y'] {
                assert!(every_n_in(l, 4, u).contains('4'), "{l:?} {u}");
            }
            assert!(times_tail_in(l, 5).contains('5'), "{l:?}");
            assert!(until_tail_in(l, 31, 11, 2026).contains("31") && until_tail_in(l, 31, 11, 2026).contains("2026"), "{l:?}");
            for os in ["windows", "macos", "linux"] {
                assert!(tray_hint_in(l, os).len() > 20, "{l:?} {os}");
            }
        }
    }

    /// `{name}`-style placeholders of a text, sorted (the fixed texts have none today; a text that gained one in English must keep it everywhere).
    fn braces(s: &str) -> Vec<String> {
        let mut v: Vec<String> = s.split('{').skip(1).filter_map(|r| r.split_once('}').map(|(n, _)| n.to_string())).collect();
        v.sort();
        v
    }

    #[test]
    fn every_language_keeps_the_placeholders_and_the_product_name_of_english() {
        for l in LANGS {
            for k in ALL {
                let (english, text) = (tr_in(Lang::En, *k), tr_in(l, *k));
                assert!(!text.trim().is_empty(), "{l:?} {k:?} is empty");
                assert_eq!(braces(text), braces(english), "{l:?} {k:?}: placeholders differ from English");
                assert!(!text.contains('{') && !text.contains('}'), "{l:?} {k:?}: stray brace in {text:?}");
                assert!(text.contains("Hey Look!") || !english.contains("Hey Look!"), "{l:?} {k:?}: the product name \"Hey Look!\" must stay where English has it ({text:?})");
                if !matches!(l, Lang::En) {
                    assert_ne!(text, english, "{l:?} {k:?}: still the English text");
                }
                assert_eq!(text, text.trim(), "{l:?} {k:?}: leading or trailing space");
                assert!(!text.contains("  "), "{l:?} {k:?}: double space");
            }
            // sentences built from values: every value arrives, nothing is left over, and no template brace escapes
            let mut out: Vec<String> = Vec::new();
            for n in [0u32, 1, 2, 3, 4, 5, 11, 12, 21, 22, 25, 101, 111] {
                out.push(unread_tooltip_in(l, n));
                out.push(new_messages_in(l, n as usize));
                out.push(every_n_in(l, n.max(2), 'd'));
                out.push(every_n_in(l, n.max(2), 'm'));
                out.push(every_n_in(l, n.max(2), 'y'));
                out.push(times_tail_in(l, n.max(2)));
                for m in [0i64, 1, n as i64] {
                    out.push(event_reminder_in(l, "Stand-up", m.max(0)));
                }
            }
            out.push(snooze_ended_in(l, "Ann <ann@x.y>"));
            out.push(until_tail_in(l, 5, 0, 2027));
            for i in 0..7 {
                for plural in [true, false] {
                    out.push(day_name_in(l, i, plural).to_string());
                }
            }
            for s in &out {
                assert!(!s.contains('{') && !s.contains('}'), "{l:?}: unfilled template in {s:?}");
                assert_eq!(s.as_str(), s.trim(), "{l:?}: space around {s:?}");
            }
            assert!(snooze_ended_in(l, "Ann <ann@x.y>").contains("Ann <ann@x.y>"), "{l:?}: the sender of a snoozed message is missing");
            assert!(event_reminder_in(l, "Stand-up", 15).contains("15") && event_reminder_in(l, "Stand-up", 15).contains("Stand-up"), "{l:?}");
        }
    }

    #[test]
    fn russian_uses_the_right_plural_form() {
        // one / few / many / other (CLDR): 1, 21, 101 -> one; 2-4, 22-24 -> few; 0, 5-20, 25 -> many
        let form = |n: usize| new_messages_in(Lang::Ru, n).replace(&n.to_string(), "#");
        assert_eq!(form(1), form(21));
        assert_eq!(form(1), form(101));
        assert_eq!(form(2), form(3));
        assert_eq!(form(2), form(22));
        assert_eq!(form(5), form(11));
        assert_eq!(form(5), form(25));
        assert_eq!(form(5), form(111));
        assert_ne!(form(1), form(2));
        assert_ne!(form(2), form(5));
        assert_ne!(form(1), form(5));
    }

    #[test]
    fn all_lists_every_variant() {
        // texts() is exhaustive; ALL must not forget one (the variant count is pinned by the last variant's position)
        assert_eq!(ALL.len(), K::SaveKeyBackup as usize + 1);
        let mut seen = std::collections::HashSet::new();
        for k in ALL {
            assert!(seen.insert(*k as usize), "{k:?} twice");
        }
    }

    #[test]
    fn english_is_what_the_app_always_said() {
        assert_eq!(en(K::TrayOpen), "Open Hey Look!");
        assert_eq!(en(K::TraySync), "Check mail now");
        assert_eq!(en(K::TestLine2), "This is how new mail will look.");
        assert_eq!(en(K::MacQuit), "Quit Hey Look!");
    }

    #[test]
    fn texts_follow_the_language() {
        // (the in-process language is shared by all tests, so these use the explicit-language forms)
        assert_eq!(tr_in(Lang::Vi, K::TrayCompose), "Thư mới");
        assert_eq!(unread_tooltip_in(Lang::Vi, 3), "Hey Look! — 3 cuộc trò chuyện chưa đọc");
        assert_eq!(new_messages_in(Lang::Vi, 5), "5 thư mới");
        assert_eq!(tr_in(Lang::Fr, K::TrayCompose), "Nouveau message");
        assert_eq!(unread_tooltip_in(Lang::Fr, 1), "Hey Look! — 1 conversation non lue");
        assert_eq!(unread_tooltip_in(Lang::Fr, 0), "Hey Look!");
        assert_eq!(snooze_ended_in(Lang::Fr, "Ann"), "Fin de la mise en attente : Ann");
        assert_eq!(event_reminder_in(Lang::Fr, "Stand-up", 0), "Stand-up commence");
        assert_eq!(event_reminder_in(Lang::Fr, "Stand-up", 15), "Stand-up dans 15 minutes");
        assert_eq!(tr_in(Lang::En, K::TrayCompose), "New mail");
        assert_eq!(unread_tooltip_in(Lang::En, 2), "Hey Look! — 2 unread conversations");
        assert_eq!(event_reminder_in(Lang::En, "Stand-up", 1), "Stand-up in 1 minute");
    }

    #[test]
    fn repeat_descriptions_in_each_language() {
        let days_n = |l: Lang, v: &[usize], plural: bool| day_list_in(l, &v.iter().map(|i| day_name_in(l, *i, plural).to_string()).collect::<Vec<_>>());
        let days = |l: Lang, v: &[usize]| days_n(l, v, true);
        assert_eq!(every_weekday_in(Lang::En, 1, &days(Lang::En, &[0, 2, 4])), "Every Monday, Wednesday and Friday");
        assert_eq!(every_weekday_in(Lang::Fr, 1, &days(Lang::Fr, &[0, 2, 4])), "Tous les lundis, mercredis et vendredis");
        assert_eq!(every_weekday_in(Lang::Fr, 2, &days_n(Lang::Fr, &[2], false)), "Toutes les 2 semaines le mercredi");
        assert_eq!(every_weekday_in(Lang::Vi, 1, &days(Lang::Vi, &[0, 6])), "Mỗi Thứ Hai và Chủ nhật");
        assert_eq!(every_n_in(Lang::Fr, 2, 'd'), "Tous les 2 jours");
        assert_eq!(every_n_in(Lang::Vi, 3, 'm'), "Mỗi 3 tháng");
        assert_eq!(times_tail_in(Lang::Fr, 5), ", 5 fois");
        assert_eq!(until_tail_in(Lang::Fr, 31, 11, 2026), ", jusqu’au 31 déc. 2026");
        assert_eq!(until_tail_in(Lang::Vi, 31, 11, 2026), ", đến 31 thg 12 2026");
        assert_eq!(until_tail_in(Lang::En, 31, 11, 2026), ", until 31 Dec 2026");
    }

    #[test]
    fn tray_hint_has_a_text_per_os_and_language() {
        for l in LANGS {
            for os in ["windows", "macos", "linux"] {
                assert!(tray_hint_in(l, os).len() > 20, "{l:?} {os}");
            }
            assert!(tray_hint_in(l, "macos").contains("Hey Look!"), "{l:?}");
        }
    }

    #[test]
    fn coded_errors_carry_code_values_and_the_english_text() {
        assert_eq!(coded("SCHEDULE_TOO_FAR", &[], "Pick a date within a year."), "SCHEDULE_TOO_FAR: Pick a date within a year.");
        assert_eq!(
            coded("PGP_NO_KEY", &[("email", "a:b@c.d|x")], "You have no PGP key for a:b@c.d|x."),
            "PGP_NO_KEY|email=a%3Ab@c.d%7Cx: You have no PGP key for a:b@c.d|x."
        );
    }
}
