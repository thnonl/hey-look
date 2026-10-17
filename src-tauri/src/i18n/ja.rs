//! The texts the operating system shows (tray menu, notifications, reminder titles, file dialog titles, repeat descriptions) in Japanese.
//! Keep the product name "Hey Look!" and the {placeholders} (`{n}`, `{who}`) as they are.
//! The compiler stops on a missing text. `cargo test --lib i18n` checks the file.

use super::K;

/// The fixed texts.
pub fn text(k: K) -> &'static str {
    match k {
        K::TrayOpen => "Hey Look!を開く",
        K::TrayCompose => "新規メール",
        K::TraySync => "今すぐメールを確認",
        K::TrayPause => "通知を一時停止",
        K::TrayQuit => "Hey Look!を終了",
        K::MacQuit => "Hey Look!を終了",
        K::MacAbout => "Hey Look!について",
        K::MacServices => "サービス",
        K::MacHide => "Hey Look!を非表示",
        K::MacHideOthers => "ほかを非表示",
        K::MacShowAll => "すべてを表示",
        K::ActArchive => "アーカイブ",
        K::ActDelete => "削除",
        K::ActRead => "既読にする",
        K::ActFlag => "フラグ",
        K::ActReply => "返信",
        K::ActSnooze => "スヌーズ",
        K::TrayHintTitle => "Hey Look!は実行中です",
        K::TrayHintMac => "メニューバーからメールの確認を続けます。もう一度開くには、DockまたはメニューバーのHey Look!アイコンをクリックしてください。",
        K::TrayHintLinux => "トレイからメールの確認を続けます。終了するには、トレイアイコンのメニューで「Hey Look!を終了」を選んでください。",
        K::TrayHintOther => "トレイからメールの確認を続けます。終了するには、トレイアイコンを右クリックして「Hey Look!を終了」を選んでください。",
        K::TestTitle => "Hey Look!のテスト通知",
        K::TestLine1 => "通知は正常に動作しています",
        K::TestLine2 => "新着メールはこのように表示されます。",
        K::EveryDay => "毎日",
        K::EveryMonth => "毎月",
        K::EveryYear => "毎年",
        K::SaveAttachmentsTo => "添付ファイルの保存先",
        K::ChooseKeyFile => "鍵ファイルを選択",
        K::OpenPgpKeys => "OpenPGP鍵",
        K::CalendarFile => "カレンダーファイル",
        K::SavePublicKey => "公開鍵を保存",
        K::SaveKeyBackup => "鍵のバックアップを保存",
        K::LoadFailTitle => "Hey Look!のウィンドウを読み込めませんでした",
        K::LoadFailWindows => "Hey Look!は起動しましたが、ウィンドウがアプリの画面を読み込めませんでした。考えられる主な原因は、Microsoft Edge WebView2 Runtime がない、または破損している（Microsoft から再インストールまたは修復してください）、あるいはセキュリティソフトがブロックしていることです。「再試行」でもう一度試すか、ログフォルダーを開いて状況を確認してください。",
        K::LoadFailMac => "Hey Look!は起動しましたが、ウィンドウがアプリの画面を読み込めませんでした。考えられる主な原因は、macOS に組み込まれたウェブエンジン（WebKit）が起動しなかった（システムアップデートが中断された後など）、あるいはセキュリティソフトがブロックしていることです。「再試行」でもう一度試すか、ログフォルダーを開いて状況を確認してください。",
        K::LoadFailLinux => "Hey Look!は起動しましたが、ウィンドウがアプリの画面を読み込めませんでした。考えられる主な原因は、WebKitGTK ライブラリ（webkit2gtk-4.1）がない、古すぎる、または破損している、あるいはセッションで使えるグラフィック表示がないことです。「再試行」でもう一度試すか、ログフォルダーを開いて状況を確認してください。",
        K::LoadFailRetry => "再試行",
        K::LoadFailOpenLog => "ログフォルダーを開く",
        K::LoadFailQuit => "終了",
        K::LoadFailLog => "ログファイル：",
    }
}

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    match n {
        0 => "Hey Look!".to_string(),
        n => format!("Hey Look!：未読の会話{n}件"),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    format!("新着メッセージ{n}件")
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    format!("スヌーズ終了：{who}")
}

/// Event reminder title: the event starts now (`minutes` = 0) or in `minutes` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    match minutes {
        0 => format!("{summary}が始まります"),
        m => format!("{summary}まであと{m}分"),
    }
}

/// Day name, `i` = 0 for Monday.
pub fn day_name(i: usize) -> &'static str {
    const DAYS: [&str; 7] = ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日"];
    DAYS[i % 7]
}

/// "月曜日、水曜日、金曜日" (two days: "月曜日と金曜日")
pub fn day_list(days: &[String]) -> String {
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        2 => format!("{}と{}", days[0], days[1]),
        _ => days.join("、"),
    }
}

/// "毎週水曜日" / "2週間ごとの水曜日" (`list` from `day_list`).
pub fn every_weekday(n: u32, list: &str) -> String {
    match n {
        1 => format!("毎週{list}"),
        n => format!("{n}週間ごとの{list}"),
    }
}

/// "2日ごと" etc. `unit`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    match unit {
        'd' => format!("{n}日ごと"),
        'm' => format!("{n}か月ごと"),
        _ => format!("{n}年ごと"),
    }
}

/// "、5回"
pub fn times_tail(c: u32) -> String {
    format!("、{c}回")
}

/// "、2026年12月31日まで" (`month0` = 0 for January)
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    format!("、{year}年{}月{day}日まで", (month0 % 12) + 1)
}
