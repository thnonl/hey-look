//! macOS notifications: the permission (W5.10, DEC-017) and the delivery through `UNUserNotificationCenter` (1.0.11).
//!
//! D-056: on macOS 13+ the Dock tile draws its badge only for an app that is registered in System Settings > Notifications with "Badge app icon". This module asks
//! through `UNUserNotificationCenter` (alert, sound, badge), reports the state, and shows the notifications itself: the plugin's backend (notify-rust ->
//! NSUserNotificationCenter) never asked for permission and showed nothing on a recent macOS, so it is no longer used on macOS.
//! Everything that decides is pure and compiled everywhere (tested on every system); only the Objective-C calls (module `native`) are macOS-only.
//!
//! Log lines (startup.log): `[notify +ms] macos: permission <state>` (changes only), `macos: asking for permission (<trigger>)`, `macos: permission request
//! answered|failed`, `macos: handed to the notification centre (<id>)`, `macos: not shown, permission <state>: <error>`.
//!
//! Part 2 is the delivery: the request identifier says where a notification came from (test or a conversation), the delegate of the notification centre draws the test
//! notification while the app is in front and brings the app (and the conversation) forward on a click.

use serde::Serialize;
use std::sync::Mutex;

/// What macOS lets this app do with notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// authorized (also provisional or ephemeral) and banners or the badge allowed
    Granted,
    /// refused, or allowed but with banners, the notification centre and the badge all off: nothing is shown
    Denied,
    /// allowed, but the alert style is "none": macOS puts the notifications in the Notification Centre without a banner (the app cannot change that; the person chooses Banners in System Settings)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))] // (only `permission_state`, compiled for macOS and tests, builds it)
    Quiet,
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
            State::Quiet => "quiet",
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
/// is enabled. Authorized with alert style none: quiet delivery to the Notification Centre when that is on, else the badge alone still counts as granted, else denied (the person turned everything off in System Settings). A status this version
/// does not know is `Unsupported` (nothing is asked, no note is shown). Pure.
#[cfg(any(test, target_os = "macos"))]
pub fn permission_state(auth: i64, alert_style: i64, centre_enabled: bool, badge_enabled: bool) -> State {
    match auth {
        AUTH_NOT_DETERMINED => State::Undetermined,
        AUTH_DENIED => State::Denied,
        AUTH_AUTHORIZED | AUTH_PROVISIONAL | AUTH_EPHEMERAL => {
            if alert_style != ALERT_STYLE_NONE {
                State::Granted
            } else if centre_enabled {
                State::Quiet
            } else if badge_enabled {
                State::Granted
            } else {
                State::Denied
            }
        }
        _ => State::Unsupported,
    }
}

/// One line for startup.log with what macOS reports: the raw `UNAuthorizationStatus`, `UNNotificationSetting` of alert / notification centre / lock screen / badge / sound
/// (0 not supported, 1 disabled, 2 enabled) and `UNAlertStyle` (0 none, 1 banner, 2 alert). Pure.
#[cfg(any(test, target_os = "macos"))]
pub fn settings_line(auth: i64, alert: i64, style: i64, centre: i64, lock: i64, badge: i64, sound: i64) -> String {
    let setting = |v: i64| match v { 0 => "notSupported", 1 => "disabled", 2 => "enabled", _ => "?" };
    let auth_name = match auth { 0 => "notDetermined", 1 => "denied", 2 => "authorized", 3 => "provisional", 4 => "ephemeral", _ => "?" };
    let style_name = match style { 0 => "none", 1 => "banner", 2 => "alert", _ => "?" };
    format!("macos: settings: authorizationStatus {auth_name}, alertSetting {}, alertStyle {style_name}, notificationCenterSetting {}, lockScreenSetting {}, badgeSetting {}, soundSetting {}", setting(alert), setting(centre), setting(lock), setting(badge), setting(sound))
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
    /// a new-mail alert is about to be shown (macOS only)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    NewMail,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Start => "start",
            Trigger::SendTest => "send test",
            Trigger::SettingOn => "setting turned on",
            Trigger::NewMail => "new mail",
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
        Trigger::SendTest | Trigger::SettingOn | Trigger::NewMail => true,
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

/// What `ensure_report` found: the state after the asking, and the error of the asking (or of an earlier one) when macOS refused to ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub state: State,
    /// the macOS error as the person reads it (a coded error, see `i18n::coded`); None when the asking went through
    pub error: Option<String>,
}

/// The result of the last asking, kept for the run: "Send test" a second time, and a new-mail alert, report the same error without asking again.
static LAST_REQUEST: Mutex<Option<Result<bool, String>>> = Mutex::new(None);

/// Reads the state and, when `should_request` says so, asks macOS (alert, sound, badge); returns the state afterwards and the error of the asking, if any.
/// Blocks while the system dialog is up (until the person answers): call it from a worker only. `accounts`, `notify_any` and `dock_badge` are what the
/// app knows (`shell::mac_notify_flags`).
pub fn ensure_report(trigger: Trigger, accounts: usize, notify_any: bool, dock_badge: bool) -> Outcome {
    let _one_at_a_time = ASKING.lock().unwrap_or_else(|p| p.into_inner());
    let state = read();
    // (a faked state is only read, never asked for)
    if seam().is_none() && should_request(state, accounts, notify_any, dock_badge, trigger) {
        crate::startup::line("notify", &format!("macos: asking for permission ({})", trigger.as_str()));
        let asked = native::request();
        match &asked {
            Ok(granted) => crate::startup::line("notify", &format!("macos: permission request answered (granted: {granted})")),
            Err(e) => crate::startup::line("notify", &format!("macos: permission request failed: {e}")),
        }
        *LAST_REQUEST.lock().unwrap_or_else(|p| p.into_inner()) = Some(asked);
    }
    let state = read();
    // (an earlier refusal does not stand once macOS allows the app: macOS may settle the permission after the call came back)
    let mut last = LAST_REQUEST.lock().unwrap_or_else(|p| p.into_inner());
    if matches!(state, State::Granted | State::Quiet) {
        *last = None;
    }
    let error = last.as_ref().and_then(|r| r.as_ref().err().cloned());
    Outcome { state, error }
}

/// `ensure_report` for the callers that only want the state.
pub fn ensure(trigger: Trigger, accounts: usize, notify_any: bool, dock_badge: bool) -> State {
    ensure_report(trigger, accounts, notify_any, dock_badge).state
}

/// Opens the Notifications pane of System Settings for this app. macOS only (elsewhere an error).
pub fn open_settings(bundle_id: &str) -> Result<(), String> {
    native::open_settings(&settings_urls(bundle_id))
}

// ---------- part 2: the delivery through UNUserNotificationCenter ----------

/// `UNErrorDomain` and its code 1 `UNErrorCodeNotificationsNotAllowed`: what macOS answers when the app may not show notifications.
#[cfg(any(test, target_os = "macos"))]
const UN_ERROR_DOMAIN: &str = "UNErrorDomain";
#[cfg(any(test, target_os = "macos"))]
const UN_ERROR_NOT_ALLOWED: i64 = 1;
/// The action identifier of a click on the body of a notification (`UNNotificationDefaultActionIdentifier`).
#[cfg(any(test, target_os = "macos"))]
const DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";

const NOT_ALLOWED: &str = "Notifications are not allowed for this application. Turn them on in System Settings > Notifications.";
const NO_BUNDLE: &str = "Notifications need the installed app: this copy does not run from an app bundle.";

/// The coded error (the page translates it, `backend.NOTIFY_MAC_NOT_ALLOWED`) for a refusal of macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn not_allowed_error() -> String {
    crate::i18n::coded("NOTIFY_MAC_NOT_ALLOWED", &[], NOT_ALLOWED)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn no_bundle_error() -> String {
    crate::i18n::coded("NOTIFY_MAC_NO_BUNDLE", &[], NO_BUNDLE)
}

/// The text for an `NSError` of the notification centre: "not allowed" is the coded answer the page translates, anything else is macOS's own sentence (white
/// space collapsed, 200 characters at most; the domain and code stand in for an empty one). Pure.
#[cfg(any(test, target_os = "macos"))]
pub fn delivery_error(domain: &str, code: i64, text: &str) -> String {
    if domain == UN_ERROR_DOMAIN && code == UN_ERROR_NOT_ALLOWED {
        return not_allowed_error();
    }
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
    if text.is_empty() { format!("macOS error {domain} {code}") } else { text }
}

/// Whether a notification may be put on the screen now: only while macOS lets the app (`Granted`). The error of the asking, if there was one, is what the
/// person reads (it says why macOS refused); without one, the refusal is the plain "not allowed". Pure.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn gate(state: State, error: Option<&str>) -> Result<(), String> {
    match state {
        State::Granted | State::Quiet => Ok(()),
        State::Denied | State::Undetermined => Err(error.map(String::from).unwrap_or_else(not_allowed_error)),
        State::Unsupported => Err(error.map(String::from).unwrap_or_else(no_bundle_error)),
    }
}

/// Where a notification came from. The request identifier carries it, so a click can be answered after a restart too (the app may be started by the click).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Origin {
    /// "Send test"
    Test,
    /// new mail; the thread is empty for a summary ("3 new messages") and for notices that open nothing
    Mail { thread: String },
}

#[cfg(any(test, target_os = "macos"))]
const ID_TEST: &str = "heylook.test.";
#[cfg(any(test, target_os = "macos"))]
const ID_MAIL: &str = "heylook.mail.";

/// The identifier of a notification: `heylook.test.<n>` or `heylook.mail.<n>:<thread>` (a new number every time, so none replaces another). Pure.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn request_id(seq: u64, origin: &Origin) -> String {
    match origin {
        Origin::Test => format!("heylook.test.{seq}"),
        Origin::Mail { thread } => format!("heylook.mail.{seq}:{thread}"),
    }
}

/// The origin an identifier names; None for an identifier that is not ours. Pure.
#[cfg(any(test, target_os = "macos"))]
pub fn origin_of(id: &str) -> Option<Origin> {
    let digits = |n: &str| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit());
    if id.strip_prefix(ID_TEST).is_some_and(digits) {
        return Some(Origin::Test);
    }
    let (n, thread) = id.strip_prefix(ID_MAIL)?.split_once(':')?;
    digits(n).then(|| Origin::Mail { thread: thread.to_string() })
}

/// Only the test notification is drawn while the app is in front, so that "Send test" shows what it sends. The alerts for new mail are not (the app skips them
/// before it asks for one while its window is in front, `shell::quiet_reason`; one that arrives in the meantime stays quiet). Pure.
#[cfg(any(test, target_os = "macos"))]
pub fn foreground_presentation(id: &str) -> bool {
    origin_of(id) == Some(Origin::Test)
}

/// What a click on a notification does.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Click {
    /// bring the main window forward (the test notification, a summary)
    Focus,
    /// bring the main window forward and open this conversation
    OpenThread(String),
}

/// The effect of a response: only the click on the body counts (the app sets no buttons; the dismiss gesture and the notification's own "Close" do nothing), and only for
/// a notification of ours. Pure.
#[cfg(any(test, target_os = "macos"))]
pub fn click_for(action: &str, id: &str) -> Option<Click> {
    if action != DEFAULT_ACTION {
        return None;
    }
    match origin_of(id)? {
        Origin::Test => Some(Click::Focus),
        Origin::Mail { thread } if thread.is_empty() => Some(Click::Focus),
        Origin::Mail { thread } => Some(Click::OpenThread(thread)),
    }
}

/// Registers what a click does and makes the app the delegate of the notification centre. Call it once, at start, from the main thread: a click that starts the app
/// reaches the delegate only if it is set before the app has finished launching. Anywhere but macOS: an error.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn install(on_click: Box<dyn Fn(Click) + Send + Sync>) -> Result<(), String> {
    native::install(on_click)
}

/// Puts a notification on the screen: asks macOS first when it was never asked (`trigger`), refuses with the macOS error when the app may not show it, adds the request
/// to the notification centre and returns macOS's answer. `sound` is "pop" (the notification is silent; the app plays the Hey Look! sound, notifysound.rs), "reminder"
/// (the system's notification sound) or "none". Blocks while the system dialog is up: call it from a worker only.
#[cfg(target_os = "macos")]
pub fn deliver(app: &tauri::AppHandle, origin: &Origin, trigger: Trigger, flags: (usize, bool, bool), title: &str, body: &str, sound: &str) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let out = ensure_report(trigger, flags.0, flags.1, flags.2);
    if let Err(e) = gate(out.state, out.error.as_deref()) {
        crate::startup::line("notify", &format!("macos: not shown, permission {}: {e}", out.state.as_str()));
        return Err(e);
    }
    let id = request_id(SEQ.fetch_add(1, Ordering::Relaxed), origin);
    native::add(&id, title, body, sound == "reminder").inspect_err(|e| crate::startup::line("notify", &format!("macos: the notification centre refused it: {e}")))?;
    crate::startup::line("notify", &format!("macos: handed to the notification centre ({id})"));
    if sound == "pop" {
        crate::notifysound::play_new_mail(app);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::{Click, State};

    pub fn read() -> State {
        State::Unsupported
    }

    pub fn request() -> Result<bool, String> {
        Err("notification permission exists on macOS only".into())
    }

    pub fn open_settings(_urls: &[String]) -> Result<(), String> {
        Err("System Settings exists on macOS only".into())
    }

    pub fn install(_on_click: Box<dyn Fn(Click) + Send + Sync>) -> Result<(), String> {
        Err("the notification centre exists on macOS only".into())
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{Click, State, click_for, delivery_error, foreground_presentation, permission_state, settings_line};
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AllocAnyThread, define_class, msg_send};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSetting, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::OnceLock;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    /// `UNNotificationSettingEnabled`
    const ENABLED: i64 = 2;

    /// `UNUserNotificationCenter.currentNotificationCenter` raises an Objective-C exception (a crash) for a process that is not an app bundle, so the
    /// bundle is checked first: it has an identifier and its path ends in `.app`.
    fn bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        let has_id = bundle.bundleIdentifier().map(|s| !s.to_string().is_empty()).unwrap_or(false);
        has_id && bundle.bundlePath().to_string().ends_with(".app")
    }

    /// (domain, code, text) of an `NSError`, or None for a null pointer (no error).
    fn error_parts(error: *mut NSError) -> Option<(String, i64, String)> {
        // SAFETY: `error` is null or a valid NSError for the duration of the completion handler; only copies of its text and code leave.
        unsafe { error.as_ref() }.map(|e| (e.domain().to_string(), e.code() as i64, e.localizedDescription().to_string()))
    }

    pub fn read() -> State {
        read_inner(false)
    }

    /// `read`, and the settings line is written whether or not it changed (every send logs what macOS thinks of the app at that moment).
    fn read_inner(always_log: bool) -> State {
        if !bundled() {
            return State::Unsupported;
        }
        let (tx, rx) = channel();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the system passes a valid settings object that lives for the duration of the call; the values are copied out.
            let s = unsafe { settings.as_ref() };
            let v = |x: UNNotificationSetting| x.0 as i64;
            let _ = tx.send([s.authorizationStatus().0 as i64, v(s.alertSetting()), s.alertStyle().0 as i64, v(s.notificationCenterSetting()), v(s.lockScreenSetting()), v(s.badgeSetting()), v(s.soundSetting())]);
        });
        center.getNotificationSettingsWithCompletionHandler(&block);
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(r) => {
                let line = settings_line(r[0], r[1], r[2], r[3], r[4], r[5], r[6]);
                // (written when it changes: the state is read at every focus)
                static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
                let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
                if always_log || *last != line {
                    crate::startup::line("notify", &line);
                    *last = line;
                }
                permission_state(r[0], r[2], r[3] == ENABLED, r[5] == ENABLED)
            }
            Err(_) => {
                crate::startup::line("notify", "macos: the notification centre did not answer within 5 s");
                State::Unsupported
            }
        }
    }

    /// Asks for alert, sound and badge and waits for the person's answer (the system dialog is shown once; later calls return at once). `Ok(granted)`, or the
    /// error of macOS as the person reads it.
    pub fn request() -> Result<bool, String> {
        if !bundled() {
            return Err(super::no_bundle_error());
        }
        let (tx, rx) = channel();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let _ = tx.send((granted.as_bool(), error_parts(error)));
        });
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge, &block);
        // the person may take minutes to answer the dialog
        match rx.recv_timeout(Duration::from_secs(600)) {
            Ok((_, Some((domain, code, text)))) => Err(delivery_error(&domain, code, &text)),
            Ok((granted, None)) => Ok(granted),
            Err(_) => Err("no answer within 10 minutes".into()),
        }
    }

    /// Adds a notification request (delivery at once: no trigger) and waits for macOS's answer. Needs the permission (the caller checked it).
    pub fn add(id: &str, title: &str, body: &str, system_sound: bool) -> Result<(), String> {
        if !bundled() {
            return Err(super::no_bundle_error());
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        if system_sound {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        // (causes of "handed over, no banner", in the order of the QA brief: 1 the delegate is gone, 4 alert style none or an off switch, 5 Focus is not visible to the app)
        let center = UNUserNotificationCenter::currentNotificationCenter();
        crate::startup::line("notify", &format!("macos: before {id}: delegate present: {}", center.delegate().is_some()));
        read_inner(true);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
        let (tx, rx) = channel();
        let block = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(error_parts(error));
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Some((domain, code, text))) => Err(delivery_error(&domain, code, &text)),
            Ok(None) => Ok(()),
            Err(_) => Err("the notification centre did not answer within 10 s".into()),
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

    static ON_CLICK: OnceLock<Box<dyn Fn(Click) + Send + Sync>> = OnceLock::new();

    define_class!(
        /// The delegate of the notification centre: draws the test notification while the app is in front, and answers a click on a notification.
        // SAFETY: NSObject has no subclassing requirements and the class has no ivars and no `Drop`.
        #[unsafe(super(NSObject))]
        #[name = "HeyLookNotificationDelegate"]
        #[ivars = ()]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: &UNUserNotificationCenter, notification: &UNNotification, completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                let id = notification.request().identifier().to_string();
                let options = if foreground_presentation(&id) {
                    UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound
                } else {
                    UNNotificationPresentationOptions::empty()
                };
                crate::startup::line("notify", &format!("macos: willPresent {id}: {}", if options.is_empty() { "not drawn in front" } else { "banner, list" }));
                // (always answered: a delegate that does not call the handler makes macOS drop the notification)
                completion.call((options,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, completion: &DynBlock<dyn Fn()>) {
                let action = response.actionIdentifier().to_string();
                let id = response.notification().request().identifier().to_string();
                crate::startup::line("notify", &format!("macos: response {id}: {action}"));
                if let (Some(click), Some(handler)) = (click_for(&action, &id), ON_CLICK.get()) {
                    handler(click);
                }
                completion.call(());
            }
        }
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            // SAFETY: `init` of NSObject, on a freshly allocated instance of this class.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// The notification centre keeps its delegate weakly, so the app holds it for the whole run.
    struct Held(#[allow(dead_code)] Retained<Delegate>);
    // SAFETY: the delegate has no state of its own; its methods read the process-wide `ON_CLICK`, which is `Send + Sync`, and macOS calls them on a thread of its own.
    unsafe impl Send for Held {}
    unsafe impl Sync for Held {}
    static DELEGATE: OnceLock<Held> = OnceLock::new();

    pub fn install(on_click: Box<dyn Fn(Click) + Send + Sync>) -> Result<(), String> {
        if !bundled() {
            return Err(super::no_bundle_error());
        }
        let _ = ON_CLICK.set(on_click);
        let held = DELEGATE.get_or_init(|| Held(Delegate::new()));
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*held.0)));
        crate::startup::line("notify", &format!("macos: delegate set: {}", center.delegate().is_some()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_permission_state_follows_the_authorization_and_the_alert_and_badge_settings() {
        // (auth, alert style, badge) -> state; UNAuthorizationStatus 0 notDetermined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral
        assert_eq!(permission_state(0, 0, false, false), State::Undetermined);
        assert_eq!(permission_state(0, 2, false, true), State::Undetermined, "not asked yet: the other values mean nothing");
        assert_eq!(permission_state(1, 1, false, true), State::Denied);
        for auth in [2, 3, 4] {
            assert_eq!(permission_state(auth, 1, false, false), State::Granted, "banners only");
            assert_eq!(permission_state(auth, 2, false, false), State::Granted, "alerts only");
            assert_eq!(permission_state(auth, 0, false, true), State::Granted, "badge only");
            assert_eq!(permission_state(auth, 1, false, true), State::Granted);
            assert_eq!(permission_state(auth, 0, false, false), State::Denied, "allowed, but banners and badge both off");
        }
        // alert style none with the Notification Centre on: delivered quietly, and the badge does not matter
        for auth in [2, 3, 4] {
            assert_eq!(permission_state(auth, 0, true, false), State::Quiet);
            assert_eq!(permission_state(auth, 0, true, true), State::Quiet);
            assert_eq!(permission_state(auth, 1, true, false), State::Granted, "a banner style wins");
        }
        assert_eq!(State::Quiet.as_str(), "quiet");
        assert_eq!(gate(State::Quiet, None), Ok(()), "quiet delivery is still delivery");
        assert_eq!(permission_state(9, 1, false, true), State::Unsupported, "a status this version does not know");
    }

    #[test]
    fn the_app_asks_only_while_undetermined_and_only_at_the_agreed_moments() {
        let all = [State::Granted, State::Denied, State::Undetermined, State::Unsupported];
        for trigger in [Trigger::Start, Trigger::SendTest, Trigger::SettingOn, Trigger::NewMail] {
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
                                Trigger::SendTest | Trigger::SettingOn | Trigger::NewMail => true,
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

    #[test]
    fn a_new_mail_alert_and_a_settings_change_ask_whenever_macos_was_never_asked() {
        assert!(should_request(State::Undetermined, 0, false, false, Trigger::NewMail), "an alert exists, so there is a reason");
        for state in [State::Granted, State::Denied, State::Unsupported] {
            assert!(!should_request(state, 1, true, true, Trigger::NewMail), "{state:?}");
        }
        assert_eq!(Trigger::NewMail.as_str(), "new mail");
    }

    #[test]
    fn only_a_granted_state_lets_a_notification_through_and_the_error_of_macos_is_what_the_person_reads() {
        assert_eq!(gate(State::Granted, None), Ok(()));
        assert_eq!(gate(State::Granted, Some("old error")), Ok(()), "an earlier error does not matter once macOS allows it");
        assert_eq!(gate(State::Denied, None), Err(not_allowed_error()));
        assert_eq!(gate(State::Undetermined, None), Err(not_allowed_error()));
        assert_eq!(gate(State::Denied, Some("macOS said no")), Err("macOS said no".to_string()));
        assert_eq!(gate(State::Undetermined, Some("macOS said no")), Err("macOS said no".to_string()), "asked, but the dialog could not be shown");
        let nb = gate(State::Unsupported, None).unwrap_err();
        assert!(nb.starts_with("NOTIFY_MAC_NO_BUNDLE: "), "{nb}");
        let na = not_allowed_error();
        assert_eq!(na, "NOTIFY_MAC_NOT_ALLOWED: Notifications are not allowed for this application. Turn them on in System Settings > Notifications.");
    }

    #[test]
    fn the_settings_macos_reports_are_written_in_words() {
        assert_eq!(
            settings_line(2, 2, 0, 2, 2, 1, 2),
            "macos: settings: authorizationStatus authorized, alertSetting enabled, alertStyle none, notificationCenterSetting enabled, lockScreenSetting enabled, badgeSetting disabled, soundSetting enabled"
        );
        assert!(settings_line(0, 0, 1, 0, 0, 0, 0).contains("notDetermined") && settings_line(0, 0, 1, 0, 0, 0, 0).contains("alertStyle banner"));
        assert!(settings_line(9, 9, 9, 9, 9, 9, 9).contains("authorizationStatus ?"));
    }

    #[test]
    fn the_errors_of_the_notification_centre_are_mapped_to_text() {
        // code 1 of UNErrorDomain is the refusal; the same code in another domain is not
        assert_eq!(delivery_error("UNErrorDomain", 1, "Notifications are not allowed for this application"), not_allowed_error());
        assert_eq!(delivery_error("UNErrorDomain", 1, ""), not_allowed_error());
        assert_eq!(delivery_error("OtherDomain", 1, "  something\n  went wrong  "), "something went wrong");
        assert_eq!(delivery_error("UNErrorDomain", 1003, ""), "macOS error UNErrorDomain 1003");
        assert_eq!(delivery_error("D", 5, &"x".repeat(500)).chars().count(), 200);
    }

    #[test]
    fn the_identifier_of_a_notification_names_where_it_came_from() {
        let test = request_id(7, &Origin::Test);
        assert_eq!(test, "heylook.test.7");
        assert_eq!(origin_of(&test), Some(Origin::Test));
        let mail = request_id(8, &Origin::Mail { thread: "t:1/a b".into() });
        assert_eq!(mail, "heylook.mail.8:t:1/a b");
        assert_eq!(origin_of(&mail), Some(Origin::Mail { thread: "t:1/a b".into() }), "the thread is everything after the first colon");
        assert_eq!(origin_of(&request_id(9, &Origin::Mail { thread: String::new() })), Some(Origin::Mail { thread: String::new() }));
        for foreign in ["", "x", "heylook.test.", "heylook.test.x", "heylook.test.1:a", "heylook.mail.", "heylook.mail.1", "heylook.mail.:t", "heylook.mail.x:t", "com.other.1"] {
            assert_eq!(origin_of(foreign), None, "{foreign:?}");
        }
    }

    #[test]
    fn only_the_test_notification_is_drawn_while_the_app_is_in_front() {
        assert!(foreground_presentation(&request_id(1, &Origin::Test)));
        assert!(!foreground_presentation(&request_id(1, &Origin::Mail { thread: "t".into() })));
        assert!(!foreground_presentation(&request_id(1, &Origin::Mail { thread: String::new() })));
        assert!(!foreground_presentation("foreign"));
    }

    #[test]
    fn a_click_on_the_body_opens_the_conversation_and_nothing_else_does_anything() {
        let thread = request_id(2, &Origin::Mail { thread: "abc".into() });
        assert_eq!(click_for(DEFAULT_ACTION, &thread), Some(Click::OpenThread("abc".into())));
        assert_eq!(click_for(DEFAULT_ACTION, &request_id(3, &Origin::Test)), Some(Click::Focus), "the test only brings the window forward");
        assert_eq!(click_for(DEFAULT_ACTION, &request_id(4, &Origin::Mail { thread: String::new() })), Some(Click::Focus), "a summary has no conversation");
        assert_eq!(click_for("com.apple.UNNotificationDismissActionIdentifier", &thread), None);
        assert_eq!(click_for("archive", &thread), None);
        assert_eq!(click_for(DEFAULT_ACTION, "foreign"), None);
    }

    #[test]
    fn the_delivery_code_is_macos_only_and_the_foreground_rule_is_in_the_delegate() {
        let src = crate::test_guard::non_test_code(include_str!("macnotify.rs"));
        let native = &src[src.find("#[cfg(target_os = \"macos\")]\nmod native").expect("macOS module")..];
        assert!(native.contains("UNUserNotificationCenterDelegate for Delegate"));
        assert!(native.contains("foreground_presentation(&id)"), "the test notification is the only one drawn in front");
        assert!(native.contains("addNotificationRequest_withCompletionHandler") && native.contains("setDelegate"));
        // the old Objective-C notification of the plugin (NSUserNotification) is not used any more
        assert!(!src.contains("NotificationExt") && !src.contains("HEYLOOK_MAC_NOTIFY"));
    }
}
