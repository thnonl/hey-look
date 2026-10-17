//! The texts the operating system shows (tray menu, notifications, reminder titles, file dialog titles, repeat descriptions) in Chinese (Simplified).
//! Keep the product name "Hey Look!" and the {placeholders} (`{n}`, `{who}`) as they are. The compiler stops on a missing text.
//! `cargo test --lib i18n` checks the file.

use super::K;

/// The fixed texts.
pub fn text(k: K) -> &'static str {
    match k {
        K::TrayOpen => "打开Hey Look!",
        K::TrayCompose => "新建邮件",
        K::TraySync => "立即检查邮件",
        K::TrayPause => "暂停通知",
        K::TrayQuit => "退出Hey Look!",
        K::MacQuit => "退出Hey Look!",
        K::MacAbout => "关于Hey Look!",
        K::MacServices => "服务",
        K::MacHide => "隐藏Hey Look!",
        K::MacHideOthers => "隐藏其他",
        K::MacShowAll => "全部显示",
        K::ActArchive => "归档",
        K::ActDelete => "删除",
        K::ActRead => "标记为已读",
        K::ActFlag => "标记",
        K::ActReply => "回复",
        K::ActSnooze => "延后",
        K::TrayHintTitle => "Hey Look!仍在运行",
        K::TrayHintMac => "它会在菜单栏中持续检查您的邮件。点击程序坞或菜单栏中的Hey Look!图标即可再次打开。",
        K::TrayHintLinux => "它会在托盘中持续检查您的邮件。要退出，请在托盘图标的菜单中选择“退出Hey Look!”。",
        K::TrayHintOther => "它会在托盘中持续检查您的邮件。要退出，请右键点击托盘图标并选择“退出”。",
        K::TestTitle => "Hey Look!测试通知",
        K::TestLine1 => "通知功能正常",
        K::TestLine2 => "新邮件将以这样的方式显示。",
        K::EveryDay => "每天",
        K::EveryMonth => "每月",
        K::EveryYear => "每年",
        K::SaveAttachmentsTo => "将附件保存到",
        K::ChooseKeyFile => "选择密钥文件",
        K::OpenPgpKeys => "OpenPGP密钥",
        K::CalendarFile => "日历文件",
        K::SavePublicKey => "保存公钥",
        K::SaveKeyBackup => "保存密钥备份",
        K::LoadFailTitle => "Hey Look!无法加载窗口",
        K::LoadFailWindows => "Hey Look!已启动，但其窗口无法加载应用界面。最可能的原因是 Microsoft Edge WebView2 Runtime 缺失或已损坏（请从 Microsoft 重新安装或修复），或有安全软件将其拦截。请选择“重试”再试一次，或打开日志文件夹查看发生了什么。",
        K::LoadFailMac => "Hey Look!已启动，但其窗口无法加载应用界面。最可能的原因是 macOS 内置的网页引擎（WebKit）未能启动（例如系统更新被中断之后），或有安全软件将其拦截。请选择“重试”再试一次，或打开日志文件夹查看发生了什么。",
        K::LoadFailLinux => "Hey Look!已启动，但其窗口无法加载应用界面。最可能的原因是 WebKitGTK 库（webkit2gtk-4.1）缺失、版本过旧或已损坏，或当前会话没有可用的图形显示。请选择“重试”再试一次，或打开日志文件夹查看发生了什么。",
        K::LoadFailRetry => "重试",
        K::LoadFailOpenLog => "打开日志文件夹",
        K::LoadFailQuit => "退出",
        K::LoadFailLog => "日志文件：",
        K::StartFailTitle => "Hey Look!无法启动",
        K::StartFailBody => "Hey Look!无法启动，因为无法创建它的窗口。\n\n最常见的原因是缺少或损坏了 Microsoft WebView2 Runtime（微软提供的免费组件，应用程序用它来显示窗口）。请从 https://developer.microsoft.com/microsoft-edge/webview2/ 安装或修复它（选择“Evergreen Bootstrapper”或“Evergreen Standalone Installer”），然后重新启动 Hey Look!。\n\n出错的详细情况已保存在下面所示的日志文件中；如果问题仍然存在，请把该文件发给技术支持。",
    }
}

/// Tray tooltip: the unread count.
pub fn unread_tooltip(n: u32) -> String {
    match n {
        0 => "Hey Look!".to_string(),
        n => format!("Hey Look! — {n}个未读对话"),
    }
}

/// Notification for more than three new messages at once.
pub fn new_messages(n: usize) -> String {
    format!("{n}封新邮件")
}

/// Title of the notification for a snoozed conversation that came back.
pub fn snooze_ended(who: &str) -> String {
    format!("延后时间已到：{who}")
}

/// Event reminder title: the event starts now (`minutes` = 0) or in `minutes` minutes.
pub fn event_reminder(summary: &str, minutes: i64) -> String {
    match minutes {
        0 => format!("{summary}即将开始"),
        m => format!("{summary}将在{m}分钟后开始"),
    }
}

/// Day name, `i` = 0 for Monday.
pub fn day_name(i: usize) -> &'static str {
    const DAYS: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    DAYS[i % 7]
}

/// "周一、周二和周五"
pub fn day_list(days: &[String]) -> String {
    match days.len() {
        0 => String::new(),
        1 => days[0].clone(),
        n => format!("{}和{}", days[..n - 1].join("、"), days[n - 1]),
    }
}

/// "每周三" / "每2周的周三" (`list` from `day_list`).
pub fn every_weekday(n: u32, list: &str) -> String {
    match n {
        1 => format!("每{list}"),
        n => format!("每{n}周的{list}"),
    }
}

/// "每2天" etc. `unit`: 'd' day, 'm' month, 'y' year.
pub fn every_n(n: u32, unit: char) -> String {
    match unit {
        'd' => format!("每{n}天"),
        'm' => format!("每{n}个月"),
        _ => format!("每{n}年"),
    }
}

/// "，共5次"
pub fn times_tail(c: u32) -> String {
    format!("，共{c}次")
}

/// "，截至2026年12月31日" (`month0` = 0 for January)
pub fn until_tail(day: u32, month0: u32, year: i32) -> String {
    format!("，截至{year}年{}月{day}日", (month0 % 12) + 1)
}
