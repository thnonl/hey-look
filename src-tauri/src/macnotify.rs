//! macOS notification permission (W5.10, DEC-017) and the hidden banner diagnostic.
//!
//! D-056: on macOS 13+ the Dock tile draws its badge only for an app that is registered in System Settings > Notifications with "Badge app icon". The
//! plugin's backend (notify-rust -> NSUserNotificationCenter) never asks for permission, so nothing registered the app. This module asks through
//! `UNUserNotificationCenter` (alert, sound, badge) and reports the state; the banner delivery path is not replaced (owner rule 2026-10-20).
//! Everything that decides is pure and compiled everywhere (tested on every system); only the Objective-C calls are macOS-only.
//!
//! Log lines (startup.log): `[notify +ms] macos: permission <state>` (changes only), `macos: asking for permission (<trigger>)`,
//! `macos: permission request failed: <error>`.
//!
//! Part 2 of the file is the hidden diagnostic of the first Mac round (debug builds only): nothing there runs unless `HEYLOOK_MAC_NOTIFY` is set.

use serde::Serialize;
use std::sync::Mutex;

/// What macOS lets this app do with notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// authorized (also provisional or ephemeral) and banners or the badge allowed
    Granted,
    /// refused, or allowed but with banners off and the badge off: nothing is shown
    Denied,
    /// macOS has never been asked
    Undetermined,
    /// not macOS, or the process does not run from an app bundle (the notification centre cannot be used)
    Unsupported,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Granted => "granted",
            State::Denied => "denied",
            State::Undetermined => "undetermined",
            State::Unsupported => "unsupported",
        }
    }
}

/// `UNAuthorizationStatus` raw values (read on macOS; the tests pin the rule everywhere).
#[cfg(any(test, target_os = "macos"))]
const AUTH_NOT_DETERMINED: i64 = 0;
#[cfg(any(test, target_os = "macos"))]
const AUTH_DENIED: i64 = 1;
#[cfg(any(test, target_os = "macos"))]
const AUTH_AUTHORIZED: i64 = 2;
#[cfg(any(test, target_os = "macos"))]
const AUTH_PROVISIONAL: i64 = 3;
#[cfg(any(test, target_os = "macos"))]
const AUTH_EPHEMERAL: i64 = 4;
/// `UNAlertStyle` none.
#[cfg(any(test, target_os = "macos"))]
const ALERT_STYLE_NONE: i64 = 0;

/// The state for what `getNotificationSettings` reports: the authorization status, the alert style (0 none, 1 banner, 2 alert) and whether the badge
/// is enabled. Authorized with no alerts AND no badge is as good as denied (the person turned both off in System Settings). A status this version
/// does not know is `Unsupported` (nothing is asked, no note is shown). Pure.
#[cfg(any(test, target_os = "macos"))]
pub fn permission_state(auth: i64, alert_style: i64, badge_enabled: bool) -> State {
    match auth {
        AUTH_NOT_DETERMINED => State::Undetermined,
        AUTH_DENIED => State::Denied,
        AUTH_AUTHORIZED | AUTH_PROVISIONAL | AUTH_EPHEMERAL => {
            if alert_style != ALERT_STYLE_NONE || badge_enabled {
                State::Granted
            } else {
                State::Denied
            }
        }
        _ => State::Unsupported,
    }
}

/// The moments at which the app may ask (REQ-5.10.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// start, or the first account added: only with an account and a reason to notify
    Start,
    /// "Send test" pressed
    SendTest,
    /// desktop notifications or the Dock badge turned on in Settings
    SettingOn,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Start => "start",
            Trigger::SendTest => "send test",
            Trigger::SettingOn => "setting turned on",
        }
    }
}

/// Whether the app asks macOS now: only while the state is undetermined (never again after denied, no own pre-prompt), and at a start only when
/// at least one account exists AND desktop notifications are on for at least one mailbox OR the Dock badge is not "None". Pure.
pub fn should_request(state: State, accounts: usize, notify_any: bool, dock_badge: bool, trigger: Trigger) -> bool {
    if state != State::Undetermined {
        return false;
    }
    match trigger {
        Trigger::Start => accounts > 0 && (notify_any || dock_badge),
        Trigger::SendTest | Trigger::SettingOn => true,
    }
}

/// Debug builds only: `HEYLOOK_TEST_NOTIFY_PERMISSION=granted|denied|undetermined` makes the state that value on any system (CDP checks of the texts on
/// Windows). A release build ignores the variable. Pure.
pub fn seam_from(debug: bool, var: Option<&str>) -> Option<State> {
    if !debug {
        return None;
    }
    match var.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("granted") => Some(State::Granted),
        Some("denied") => Some(State::Denied),
        Some("undetermined") => Some(State::Undetermined),
        _ => None,
    }
}

/// The seam of this process, if any.
fn seam() -> Option<State> {
    seam_from(cfg!(debug_assertions), std::env::var("HEYLOOK_TEST_NOTIFY_PERMISSION").ok().as_deref())
}

/// The System Settings pane of this app, then the general Notifications pane (older macOS without the per-app anchor). Pure.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn settings_urls(bundle_id: &str) -> Vec<String> {
    let mut urls = vec![];
    if !bundle_id.is_empty() {
        urls.push(format!("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={bundle_id}"));
    }
    urls.push("x-apple.systempreferences:com.apple.preference.notifications".to_string());
    urls
}

/// The last state that was logged, so a line is written when it changes and not at every focus.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static LOGGED: Mutex<Option<State>> = Mutex::new(None);
/// One asking at a time: a start and a "Send test" that meet do not both open a dialog.
static ASKING: Mutex<()> = Mutex::new(());

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn note(state: State) {
    let mut last = LOGGED.lock().unwrap_or_else(|p| p.into_inner());
    if *last != Some(state) {
        *last = Some(state);
        crate::startup::line("notify", &format!("macos: permission {}", state.as_str()));
    }
}

/// The state now, from macOS (a debug build may fake it, see `seam_from`). Blocks up to 5 s: call it from a worker, never from the main thread. Anywhere
/// but macOS: `Unsupported`.
pub fn read() -> State {
    if let Some(s) = seam() {
        return s;
    }
    let state = native::read();
    #[cfg(target_os = "macos")]
    note(state);
    state
}

/// Reads the state and, when `should_request` says so, asks macOS (alert, sound, badge); returns the state afterwards. Blocks while the system dialog is up
/// (until the person answers): call it from a worker only. `accounts`, `notify_any` and `dock_badge` are what the app knows (`shell::mac_notify_flags`).
pub fn ensure(trigger: Trigger, accounts: usize, notify_any: bool, dock_badge: bool) -> State {
    let _one_at_a_time = ASKING.lock().unwrap_or_else(|p| p.into_inner());
    let state = read();
    // (a faked state is only read, never asked for)
    if seam().is_some() || !should_request(state, accounts, notify_any, dock_badge, trigger) {
        return state;
    }
    crate::startup::line("notify", &format!("macos: asking for permission ({})", trigger.as_str()));
    if let Err(e) = native::request() {
        crate::startup::line("notify", &format!("macos: permission request failed: {e}"));
    }
    read()
}

/// Opens the Notifications pane of System Settings for this app. macOS only (elsewhere an error).
pub fn open_settings(bundle_id: &str) -> Result<(), String> {
    native::open_settings(&settings_urls(bundle_id))
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::State;

    pub fn read() -> State {
        State::Unsupported
    }

    pub fn request() -> Result<(), String> {
        Err("notification permission exists on macOS only".into())
    }

    pub fn open_settings(_urls: &[String]) -> Result<(), String> {
        Err("System Settings exists on macOS only".into())
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{State, permission_state};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError};
    use objc2_user_notifications::{UNAuthorizationOptions, UNNotificationSetting, UNNotificationSettings, UNUserNotificationCenter};
    use std::ptr::NonNull;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    /// `UNUserNotificationCenter.currentNotificationCenter` raises an Objective-C exception (a crash) for a process that is not an app bundle, so the
    /// bundle is checked first: it has an identifier and its path ends in `.app`.
    fn bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        let has_id = bundle.bundleIdentifier().map(|s| !s.to_string().is_empty()).unwrap_or(false);
        has_id && bundle.bundlePath().to_string().ends_with(".app")
    }

    pub fn read() -> State {
        if !bundled() {
            return State::Unsupported;
        }
        let (tx, rx) = channel();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the system passes a valid settings object that lives for the duration of the call; the values are copied out.
            let s = unsafe { settings.as_ref() };
            let _ = tx.send((s.authorizationStatus().0 as i64, s.alertStyle().0 as i64, s.badgeSetting() == UNNotificationSetting::Enabled));
        });
        center.getNotificationSettingsWithCompletionHandler(&block);
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok((auth, style, badge)) => permission_state(auth, style, badge),
            Err(_) => {
                crate::startup::line("notify", "macos: the notification centre did not answer within 5 s");
                State::Unsupported
            }
        }
    }

    /// Asks for alert, sound and badge and waits for the person's answer (the system dialog is shown once; later calls return at once).
    pub fn request() -> Result<(), String> {
        if !bundled() {
            return Err("not running from an app bundle".into());
        }
        let (tx, rx) = channel();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            // SAFETY: `error` is null or a valid NSError for the duration of the call; only its text is copied.
            let text = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            let _ = tx.send((granted.as_bool(), text));
        });
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge, &block);
        // the person may take minutes to answer the dialog
        match rx.recv_timeout(Duration::from_secs(600)) {
            Ok((_, Some(error))) => Err(error.chars().take(200).collect()),
            Ok((_, None)) => Ok(()),
            Err(_) => Err("no answer within 10 minutes".into()),
        }
    }

    pub fn open_settings(urls: &[String]) -> Result<(), String> {
        let mut last = String::from("no address");
        for url in urls {
            match crate::winproc::hidden("/usr/bin/open").arg(url).status() {
                Ok(s) if s.success() => return Ok(()),
                Ok(s) => last = format!("open {url}: {s}"),
                Err(e) => last = format!("open {url}: {e}"),
            }
        }
        Err(last)
    }
}

// ---------- part 2: the hidden banner diagnostic ----------

/// Which attempts to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// native, then osascript if native returned an error
    Auto,
    Native,
    Osascript,
    Both,
}

/// The mode for a value of the variable; `debug` is whether this is a debug build. Pure.
pub fn mode_from(debug: bool, var: Option<&str>) -> Option<Mode> {
    if !debug {
        return None;
    }
    match var.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("1") => Some(Mode::Auto),
        Some("native") => Some(Mode::Native),
        Some("osascript") => Some(Mode::Osascript),
        Some("both") => Some(Mode::Both),
        _ => None,
    }
}

/// The diagnostic that is on for this process, if any.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mode() -> Option<Mode> {
    mode_from(cfg!(debug_assertions), std::env::var("HEYLOOK_MAC_NOTIFY").ok().as_deref())
}

/// A string inside an AppleScript double-quoted literal: backslash and double quote escaped, other control characters dropped
/// (a raw line break inside the literal is accepted by AppleScript).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn applescript_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push('\n'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The AppleScript of the fallback: the caller's title, no sound unless the app setting asks for one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn applescript(title: &str, body: &str, sound: &str) -> String {
    let mut s = format!("display notification {} with title {}", applescript_string(body), applescript_string(title));
    if sound != "none" {
        s.push_str(" sound name \"default\"");
    }
    s
}

#[cfg(target_os = "macos")]
fn native_banner(app: &tauri::AppHandle, title: &str, body: &str, sound: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(title).body(body);
    if sound != "none" {
        n = n.sound("default");
    }
    n.show().map_err(|e| e.to_string().chars().take(200).collect())
}

#[cfg(target_os = "macos")]
fn osascript(title: &str, body: &str, sound: &str) -> Result<(), String> {
    let out = crate::winproc::hidden("osascript")
        .arg("-e")
        .arg(applescript(title, body, sound))
        .output()
        .map_err(|e| format!("could not start osascript: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect())
    }
}

/// Makes the attempts of `mode`, logs the result of each in startup.log and returns Ok when one reported success (that does not
/// prove that a banner appeared: that is what the person at the Mac reports).
#[cfg(target_os = "macos")]
pub fn show(app: &tauri::AppHandle, mode: Mode, title: &str, body: &str, sound: &str) -> Result<(), String> {
    use crate::startup::line;
    line("notify", &format!("macos: diagnostic on (HEYLOOK_MAC_NOTIFY, mode {mode:?}), bundle {}", app.config().identifier));
    let mut errors: Vec<String> = vec![];
    let mut shown = false;
    if matches!(mode, Mode::Auto | Mode::Native | Mode::Both) {
        match native_banner(app, title, body, sound) {
            Ok(()) => {
                line("notify", "macos: shown (native)");
                shown = true;
            }
            Err(e) => {
                line("notify", &format!("macos: failed: native: {e}"));
                errors.push(format!("native: {e}"));
            }
        }
    }
    let fallback = match mode {
        Mode::Osascript | Mode::Both => true,
        Mode::Auto => !shown,
        Mode::Native => false,
    };
    if fallback {
        match osascript(title, body, sound) {
            Ok(()) => {
                line("notify", "macos: shown (osascript)");
                shown = true;
            }
            Err(e) => {
                line("notify", &format!("macos: failed: osascript: {e}"));
                errors.push(format!("osascript: {e}"));
            }
        }
    }
    if shown {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_diagnostic_is_off_unless_a_debug_build_is_asked() {
        for v in [None, Some(""), Some("0"), Some("yes"), Some("true")] {
            assert_eq!(mode_from(true, v), None, "{v:?}");
        }
        assert_eq!(mode_from(true, Some("1")), Some(Mode::Auto));
        assert_eq!(mode_from(true, Some(" Native ")), Some(Mode::Native));
        assert_eq!(mode_from(true, Some("osascript")), Some(Mode::Osascript));
        assert_eq!(mode_from(true, Some("BOTH")), Some(Mode::Both));
        // a release build never enables it, whatever the variable says
        for v in [None, Some("1"), Some("both"), Some("osascript")] {
            assert_eq!(mode_from(false, v), None, "{v:?}");
        }
    }

    #[test]
    fn the_applescript_is_escaped_and_silent_unless_a_sound_is_set() {
        assert_eq!(applescript("Hey Look!", "Hello", "none"), "display notification \"Hello\" with title \"Hey Look!\"");
        assert_eq!(applescript("Hey Look!", "Hello", "mail"), "display notification \"Hello\" with title \"Hey Look!\" sound name \"default\"");
        // a subject cannot break out of the string literal
        assert_eq!(applescript_string(r#"say "hi" \ now"#), r#""say \"hi\" \\ now""#);
        assert_eq!(applescript_string("a\u{7}b"), "\"ab\"");
        let evil = applescript("t", "\" & (do shell script \"x\") & \"", "none");
        assert_eq!(evil, "display notification \"\\\" & (do shell script \\\"x\\\") & \\\"\" with title \"t\"");
    }

    #[test]
    fn the_permission_state_follows_the_authorization_and_the_alert_and_badge_settings() {
        // (auth, alert style, badge) -> state; UNAuthorizationStatus 0 notDetermined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral
        assert_eq!(permission_state(0, 0, false), State::Undetermined);
        assert_eq!(permission_state(0, 2, true), State::Undetermined, "not asked yet: the other values mean nothing");
        assert_eq!(permission_state(1, 1, true), State::Denied);
        for auth in [2, 3, 4] {
            assert_eq!(permission_state(auth, 1, false), State::Granted, "banners only");
            assert_eq!(permission_state(auth, 2, false), State::Granted, "alerts only");
            assert_eq!(permission_state(auth, 0, true), State::Granted, "badge only");
            assert_eq!(permission_state(auth, 1, true), State::Granted);
            assert_eq!(permission_state(auth, 0, false), State::Denied, "allowed, but banners and badge both off");
        }
        assert_eq!(permission_state(9, 1, true), State::Unsupported, "a status this version does not know");
    }

    #[test]
    fn the_app_asks_only_while_undetermined_and_only_at_the_agreed_moments() {
        let all = [State::Granted, State::Denied, State::Undetermined, State::Unsupported];
        for trigger in [Trigger::Start, Trigger::SendTest, Trigger::SettingOn] {
            for state in all {
                for accounts in [0usize, 1, 3] {
                    for notify_any in [false, true] {
                        for dock in [false, true] {
                            let asked = should_request(state, accounts, notify_any, dock, trigger);
                            if state != State::Undetermined {
                                assert!(!asked, "never again after denied, never when granted or unsupported: {state:?} {trigger:?}");
                                continue;
                            }
                            let expected = match trigger {
                                Trigger::Start => accounts > 0 && (notify_any || dock),
                                Trigger::SendTest | Trigger::SettingOn => true,
                            };
                            assert_eq!(asked, expected, "{trigger:?} accounts={accounts} notify={notify_any} dock={dock}");
                        }
                    }
                }
            }
        }
        // the start without an account, or with everything off, does not ask
        assert!(!should_request(State::Undetermined, 0, true, true, Trigger::Start));
        assert!(!should_request(State::Undetermined, 2, false, false, Trigger::Start));
        assert!(should_request(State::Undetermined, 1, false, true, Trigger::Start), "the Dock badge alone is a reason");
        assert!(should_request(State::Undetermined, 1, true, false, Trigger::Start));
    }

    #[test]
    fn the_test_seam_is_ignored_in_a_release_build() {
        for v in ["granted", "denied", "undetermined"] {
            assert_eq!(seam_from(false, Some(v)), None, "{v}");
        }
        assert_eq!(seam_from(true, Some("granted")), Some(State::Granted));
        assert_eq!(seam_from(true, Some(" Denied ")), Some(State::Denied));
        assert_eq!(seam_from(true, Some("UNDETERMINED")), Some(State::Undetermined));
        for v in [None, Some(""), Some("unsupported"), Some("1")] {
            assert_eq!(seam_from(true, v), None, "{v:?}");
        }
        // the only reader of the variable is guarded by debug_assertions
        let src = crate::test_guard::non_test_code(include_str!("macnotify.rs"));
        assert!(src.contains("seam_from(cfg!(debug_assertions)"), "the seam must be debug-only");
    }

    #[test]
    fn the_settings_button_opens_the_app_pane_and_falls_back_to_the_notifications_pane() {
        let urls = settings_urls("io.github.thnonl.HeyLook");
        assert_eq!(urls[0], "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=io.github.thnonl.HeyLook");
        assert_eq!(urls[1], "x-apple.systempreferences:com.apple.preference.notifications");
        assert_eq!(settings_urls(""), vec!["x-apple.systempreferences:com.apple.preference.notifications".to_string()]);
    }

    #[test]
    fn the_permission_code_has_no_leftover_of_the_old_unavailable_message() {
        let all = [include_str!("shell.rs"), include_str!("lib.rs"), include_str!("macnotify.rs")];
        for src in all {
            let code = crate::test_guard::non_test_code(src);
            assert!(!code.contains(concat!("NOTIFY_MAC", "_UNAVAILABLE")), "the old answer is gone (REQ-5.10.5)");
        }
    }
}
