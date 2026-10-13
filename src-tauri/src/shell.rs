//! Desktop shell integration: tray icon + unread badge, toast notifications with action buttons,
//! snooze reminders. Settings come from the UI's `prefs` JSON (stored in the settings table).
use crate::{action_impl, db, lock, now, AppState, Db, NewMsg};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
pub const AUMID: &str = "thnonl.heylook";

// ---------- prefs ----------

pub fn prefs(db: &Db) -> Value {
    db::get_setting(&lock(db), "prefs")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

pub(crate) fn pbool(v: &Value, k: &str, d: bool) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(d)
}

fn pstr(v: &Value, k: &str, d: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or(d).to_string()
}

fn account_pref(p: &Value, account: &str, k: &str) -> Option<Value> {
    p.get("accountPrefs")?.get(account)?.get(k).cloned()
}

/// Effective value of a setting: the account's own override, else the "all accounts" value.
pub fn eff(p: &Value, account: &str, k: &str) -> Option<Value> {
    account_pref(p, account, k).or_else(|| p.get(k).cloned())
}

/// Set once the tray icon exists. Without it a hidden window could not be brought back, so closing must quit.
static TRAY_READY: AtomicBool = AtomicBool::new(false);

pub fn tray_ready() -> bool {
    TRAY_READY.load(Ordering::Relaxed)
}

/// Whether the window close button hides the window to the tray (setting `closeToTray`, on by default) instead of quitting.
/// Never true when the tray icon could not be created: then the close button really quits.
pub fn close_to_tray(db: &Db) -> bool {
    tray_ready() && pbool(&prefs(db), "closeToTray", true)
}

// ---------- window ----------

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let was_hidden = !w.is_visible().unwrap_or(true);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // a window that was hidden (first show, a tray click after a --minimized start, a second start) is looked at for a black web view
        if was_hidden {
            crate::startup::verify_painting(app);
        }
        // the UI re-checks for updates when the window comes back (throttled in update.rs)
        let _ = app.emit("app-shown", ());
    }
}

// ---------- badge icon (anti-aliased, real font) ----------

static FONT: OnceLock<Option<fontdue::Font>> = OnceLock::new();

/// Segoe UI Bold from the system (always present on Windows); the badge falls back to a plain dot without it.
fn font() -> Option<&'static fontdue::Font> {
    FONT.get_or_init(|| {
        for path in [r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\segoeui.ttf"] {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(f) = fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()) {
                    return Some(f);
                }
            }
        }
        None
    })
    .as_ref()
}

const BADGE_RED: [u8; 3] = [229, 72, 77]; // softer than pure red
const WHITE: [u8; 3] = [255, 255, 255];

/// Alpha-composite one pixel (straight alpha) onto the RGBA buffer.
fn blend(buf: &mut [u8], size: usize, x: i32, y: i32, rgb: [u8; 3], a: f32) {
    if a <= 0.0 || x < 0 || y < 0 || x >= size as i32 || y >= size as i32 {
        return;
    }
    let i = (y as usize * size + x as usize) * 4;
    let da = buf[i + 3] as f32 / 255.0;
    let oa = a + da * (1.0 - a);
    for c in 0..3 {
        buf[i + c] = ((rgb[c] as f32 * a + buf[i + c] as f32 * da * (1.0 - a)) / oa).round() as u8;
    }
    buf[i + 3] = (oa * 255.0).round() as u8;
}

fn circle(buf: &mut [u8], size: usize, cx: f32, cy: f32, r: f32, rgb: [u8; 3]) {
    let (x0, x1) = ((cx - r - 1.0).floor() as i32, (cx + r + 1.0).ceil() as i32);
    let (y0, y1) = ((cy - r - 1.0).floor() as i32, (cy + r + 1.0).ceil() as i32);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            blend(buf, size, x, y, rgb, (r - d + 0.5).clamp(0.0, 1.0));
        }
    }
}

fn text_centered(buf: &mut [u8], size: usize, cx: f32, cy: f32, px: f32, text: &str, rgb: [u8; 3]) {
    let Some(f) = font() else { return };
    let glyphs: Vec<_> = text.chars().map(|c| f.rasterize(c, px)).collect();
    let total: f32 = glyphs.iter().map(|(m, _)| m.advance_width).sum();
    let digit_h = f.rasterize('0', px).0.height as f32;
    let baseline = cy + digit_h / 2.0;
    let mut x = cx - total / 2.0;
    for (m, bitmap) in glyphs {
        let gx = (x + m.xmin as f32).round() as i32;
        let gy = (baseline - m.ymin as f32 - m.height as f32).round() as i32;
        for row in 0..m.height {
            for col in 0..m.width {
                blend(buf, size, gx + col as i32, gy + row as i32, rgb, bitmap[row * m.width + col] as f32 / 255.0);
            }
        }
        x += m.advance_width;
    }
}

/// Round badge with an optional count (capped at 99+); `ring` adds a thin white outline to separate it from the logo.
fn badge(buf: &mut [u8], size: usize, cx: f32, cy: f32, r: f32, count: u32, number: bool, ring: bool) {
    if ring {
        circle(buf, size, cx, cy, r + r * 0.13, WHITE);
    }
    circle(buf, size, cx, cy, r, BADGE_RED);
    if number && font().is_some() {
        let text = if count > 99 { "99+".to_string() } else { count.to_string() };
        let px = match text.len() {
            1 => r * 1.5,
            2 => r * 1.2,
            _ => r * 0.95,
        };
        text_centered(buf, size, cx, cy, px, &text, WHITE);
    }
}

/// App icon at 64x64 (area-averaged so it stays smooth), with the unread badge when `style` asks for one.
fn tray_icon(app: &AppHandle, count: u32, style: &str) -> Option<Image<'static>> {
    const N: usize = 64;
    let base = app.default_window_icon()?;
    let (bw, bh) = (base.width() as usize, base.height() as usize);
    let rgba = base.rgba();
    let mut buf = vec![0u8; N * N * 4];
    for y in 0..N {
        for x in 0..N {
            let (x0, y0) = (x * bw / N, y * bh / N);
            let (x1, y1) = (((x + 1) * bw / N).max(x0 + 1).min(bw), ((y + 1) * bh / N).max(y0 + 1).min(bh));
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = (sy * bw + sx) * 4;
                    let al = rgba[i + 3] as u64;
                    r += rgba[i] as u64 * al;
                    g += rgba[i + 1] as u64 * al;
                    b += rgba[i + 2] as u64 * al;
                    a += al;
                    n += 1;
                }
            }
            if a > 0 {
                let d = (y * N + x) * 4;
                buf[d..d + 4].copy_from_slice(&[(r / a) as u8, (g / a) as u8, (b / a) as u8, (a / n) as u8]);
            }
        }
    }
    if count > 0 && style != "off" {
        match style {
            "dot" => badge(&mut buf, N, 50.0, 50.0, 10.0, count, false, true),
            _ => badge(&mut buf, N, 45.0, 45.0, 17.0, count, true, true),
        }
    }
    Some(Image::new_owned(buf, N as u32, N as u32))
}

#[cfg(windows)]
fn overlay_icon(count: u32) -> Image<'static> {
    const N: usize = 32;
    let mut buf = vec![0u8; N * N * 4];
    badge(&mut buf, N, 16.0, 16.0, 15.0, count, true, false);
    Image::new_owned(buf, N as u32, N as u32)
}

/// Unread conversations (not messages). With Focused Inbox on, bulk mail is left out unless the user asks for it.
fn unread_count(db: &Db) -> u32 {
    let p = prefs(db);
    let include_other = pbool(&p, "countOtherMail", false) || !pbool(&p, "focused", true);
    lock(db)
        .query_row(
            "SELECT COUNT(DISTINCT m.thread_id) FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id
             WHERE m.folder='inbox' AND m.seen=0 AND (tm.snoozed_until IS NULL OR tm.snoozed_until<=?1)
               AND m.from_email NOT IN (SELECT email FROM blocked) AND (?2=1 OR m.list_unsub IS NULL)",
            rusqlite::params![now(), include_other as i64],
            |r| r.get(0),
        )
        .unwrap_or(0)
}

fn badge_styles(p: &Value) -> (String, String) {
    let legacy_off = p.get("showUnreadCount").and_then(|v| v.as_bool()) == Some(false);
    let tray = pstr(p, "trayBadge", if legacy_off { "off" } else { "number" });
    let task = pstr(p, "taskbarBadge", if legacy_off { "off" } else { "number" });
    (tray, task)
}

/// Tray icon + tooltip and taskbar overlay reflect the unread count.
pub fn update_badge(app: &AppHandle, db: &Db) {
    let count = unread_count(db);
    let (tray_style, task_style) = badge_styles(&prefs(db));
    if let Some(tray) = app.tray_by_id("main") {
        if let Some(icon) = tray_icon(app, count, &tray_style) {
            let _ = tray.set_icon(Some(icon));
        }
        let tip = match count {
            0 => "Hey Look!".to_string(),
            1 => "Hey Look! — 1 unread conversation".to_string(),
            n => format!("Hey Look! — {n} unread conversations"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_overlay_icon(if count > 0 && task_style == "number" { Some(overlay_icon(count)) } else { None });
    }
    #[cfg(not(windows))]
    let _ = task_style;
}

// ---------- tray ----------

/// Linux: is there anything on the session bus that shows tray icons (a registered StatusNotifier host)? Any error = no.
#[cfg(target_os = "linux")]
fn linux_tray_host() -> bool {
    let probe = || -> Result<bool, zbus::Error> {
        let conn = zbus::blocking::Connection::session()?;
        let dbus = zbus::blocking::fdo::DBusProxy::new(&conn)?;
        let name = zbus::names::BusName::try_from("org.kde.StatusNotifierWatcher")?;
        if !dbus.name_has_owner(name)? {
            return Ok(false);
        }
        let watcher = zbus::blocking::Proxy::new(&conn, "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher")?;
        Ok(watcher.get_property::<bool>("IsStatusNotifierHostRegistered")?)
    };
    tray_host_present(probe().ok())
}

/// The answer of the bus probe as a yes/no: only an explicit "a host is registered" counts.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn tray_host_present(probe: Option<bool>) -> bool {
    probe.unwrap_or(false)
}

/// Whether at least one account exists. The tray entries "New mail" and "Check mail now" work only then (the Welcome screen has no mail controls).
static MAIL_AVAILABLE: AtomicBool = AtomicBool::new(true);
static TRAY_MAIL_ITEMS: OnceLock<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)> = OnceLock::new();

/// The tray's mail entries are enabled exactly when an account exists.
pub fn tray_mail_enabled(account_count: usize) -> bool {
    account_count > 0
}

/// Called with the account state at start and whenever the frontend sees the account list become empty / non-empty.
pub fn set_mail_available(available: bool) {
    MAIL_AVAILABLE.store(available, Ordering::Relaxed);
    if let Some((compose, sync)) = TRAY_MAIL_ITEMS.get() {
        let _ = compose.set_enabled(available);
        let _ = sync.set_enabled(available);
    }
}

pub fn setup_tray(app: &AppHandle, db: &Db) -> tauri::Result<()> {
    // without a tray host the icon would be invisible and a hidden window could not be brought back: no tray, closing quits
    #[cfg(target_os = "linux")]
    if !linux_tray_host() {
        eprintln!("tray: no StatusNotifier host, closing the window quits");
        return Ok(());
    }
    let paused = db::get_setting(&lock(db), "notif_paused").as_deref() == Some("1");
    let open = MenuItem::with_id(app, "open", "Open Hey Look!", true, None::<&str>)?;
    let compose = MenuItem::with_id(app, "compose", "New mail", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Check mail now", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause notifications", true, paused, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hey Look!", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &compose, &sync, &sep1, &pause, &sep2, &quit])?;
    let has_accounts = tray_mail_enabled(db::list_accounts(&lock(db)).map(|a| a.len()).unwrap_or(0));
    let _ = TRAY_MAIL_ITEMS.set((compose.clone(), sync.clone()));
    set_mail_available(has_accounts);

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Hey Look!")
        .menu(&menu)
        .show_menu_on_left_click(false);
    // no icon at all would leave an invisible tray entry: do without the tray then (closing quits, see `close_to_tray`)
    let Some(icon) = tray_icon(app, 0, "off").or_else(|| app.default_window_icon().cloned()) else {
        eprintln!("tray icon unavailable: no icon image found, the close button will quit instead of hiding the window");
        return Ok(());
    };
    builder = builder.icon(icon);
    let pause_item = pause.clone();
    builder
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "compose" if MAIL_AVAILABLE.load(Ordering::Relaxed) => {
                show_main(app);
                let _ = app.emit("tray-compose", ());
            }
            "sync" if MAIL_AVAILABLE.load(Ordering::Relaxed) => {
                let app = app.clone();
                std::thread::spawn(move || crate::sync_all(&app));
            }
            "pause" => {
                let on = pause_item.is_checked().unwrap_or(false);
                let st = app.state::<AppState>();
                let _ = db::set_setting(&lock(&st.db), "notif_paused", if on { "1" } else { "0" });
            }
            "quit" => crate::request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
            | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    TRAY_READY.store(true, Ordering::Relaxed);
    Ok(())
}

// ---------- toast notifications ----------

/// Register the AppUserModelID so Windows shows our name and icon on toasts (no installer needed).
#[cfg(windows)]
pub fn register_aumid(app: &AppHandle) {
    crate::legacy_names::remove_old_notification_id();
    let Some(data) = app.try_state::<crate::legacy_names::DataDir>() else { return };
    let icon = data.0.join("icon.png");
    let _ = std::fs::write(&icon, include_bytes!("../icons/128x128.png"));
    let key = format!(r"HKCU\Software\Classes\AppUserModelId\{AUMID}");
    for (name, val) in [("DisplayName", "Hey Look!"), ("IconUri", icon.to_str().unwrap_or(""))] {
        let _ = crate::winproc::hidden("reg").args(["add", &key, "/v", name, "/t", "REG_SZ", "/d", val, "/f"]).output();
    }
}

#[cfg(not(windows))]
pub fn register_aumid(_app: &AppHandle) {}

fn action_label(id: &str) -> Option<&'static str> {
    Some(match id {
        "archive" => "Archive",
        "delete" => "Delete",
        "read" => "Mark as read",
        "flag" => "Flag",
        "reply" => "Reply",
        "snooze" => "Snooze",
        _ => return None,
    })
}

/// Hours from `prefs.snoozeTimes.tomorrow` (default 08:00) tomorrow, as a unix timestamp.
fn tomorrow_ts(p: &Value) -> i64 {
    use chrono::{Duration, Local, TimeZone};
    let hour = p
        .get("snoozeTimes")
        .and_then(|t| t.get("tomorrow"))
        .and_then(|h| h.as_u64())
        .unwrap_or(8) as u32;
    let d = (Local::now() + Duration::days(1)).date_naive().and_hms_opt(hour.min(23), 0, 0).unwrap();
    Local.from_local_datetime(&d).single().map(|t| t.timestamp()).unwrap_or_else(|| now() + 86_400)
}

fn handle_activation(app: &AppHandle, thread: &str, action: Option<String>) {
    match action.as_deref() {
        None | Some("") => {
            show_main(app);
            let _ = app.emit("open-thread", json!({ "threadId": thread }));
        }
        Some("reply") => {
            show_main(app);
            let _ = app.emit("notify-reply", json!({ "threadId": thread }));
        }
        Some(a) => {
            if thread.is_empty() {
                return; // test notification
            }
            let db = app.state::<AppState>().db.clone();
            let (act, arg) = match a {
                "archive" => ("archive", None),
                "delete" => ("trash", None),
                "read" => ("read", None),
                "flag" => ("star", None),
                "snooze" => ("snooze", Some(tomorrow_ts(&prefs(&db)).to_string())),
                _ => return,
            };
            let (app2, thread) = (app.clone(), thread.to_string());
            std::thread::spawn(move || {
                let _ = action_impl(&db, vec![thread], act.to_string(), arg, Some("inbox".into()));
                update_badge(&app2, &db);
                let _ = app2.emit("mail-synced", ());
            });
        }
    }
}

#[cfg(windows)]
fn toast(app: &AppHandle, thread: String, title: &str, line1: &str, line2: &str, sound: &str, actions: &[String]) -> Result<(), String> {
    use tauri_winrt_notification::{Sound, Toast};
    let snd = match sound {
        "none" => None,
        "default" => Some(Sound::Default),
        "im" => Some(Sound::IM),
        "reminder" => Some(Sound::Reminder),
        "sms" => Some(Sound::SMS),
        _ => Some(Sound::Mail),
    };
    let mut t = Toast::new(AUMID).title(title).text1(line1);
    if !line2.is_empty() {
        t = t.text2(line2);
    }
    t = t.sound(snd);
    for a in actions {
        if let Some(label) = action_label(a) {
            t = t.add_button(label, a);
        }
    }
    let app = app.clone();
    let t = t.on_activated(move |action| {
        handle_activation(&app, &thread, action);
        Ok(())
    });
    let _ = t.show();
    Ok(())
}

/// macOS and Linux: a plain native notification (no buttons; clicking it has the system's default effect only).
#[cfg(not(windows))]
fn toast(app: &AppHandle, _thread: String, title: &str, line1: &str, line2: &str, sound: &str, _actions: &[String]) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(title).body(notification_body(line1, line2));
    if sound != "none" {
        n = n.sound(if cfg!(target_os = "macos") { "default" } else { "message-new-email" });
    }
    n.show().map_err(|e| e.to_string().chars().take(120).collect())
}

/// Subject, then the preview on a second line when there is one.
#[cfg_attr(windows, allow(dead_code))]
fn notification_body(line1: &str, line2: &str) -> String {
    if line2.is_empty() { line1.to_string() } else { format!("{line1}
{line2}") }
}

/// Failures of other notifications than "Send test" are only logged.
fn toast_logged(app: &AppHandle, thread: String, title: &str, line1: &str, line2: &str, sound: &str, actions: &[String]) {
    if let Err(e) = toast(app, thread, title, line1, line2, sound, actions) {
        eprintln!("notification failed: {e}");
    }
}

fn notify_actions(p: &Value) -> Vec<String> {
    let list: Vec<String> = p
        .get("notifyActions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["archive".into(), "delete".into(), "read".into()]);
    list.into_iter().filter(|a| action_label(a).is_some()).take(3).collect()
}

fn blocked(app: &AppHandle, db: &Db) -> bool {
    db::get_setting(&lock(db), "notif_paused").as_deref() == Some("1")
        || !pbool(&prefs(db), "notifications", true)
        || app.get_webview_window("main").map_or(false, |w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false))
}

/// Toasts for newly arrived inbox mail. Every account can override the "all accounts" notification settings.
pub fn notify_new(app: &AppHandle, db: &Db, new: &[NewMsg]) {
    if new.is_empty() || blocked(app, db) {
        return;
    }
    let p = prefs(db);
    let flag = |n: &NewMsg, k: &str, d: bool| eff(&p, &n.account_id, k).and_then(|v| v.as_bool()).unwrap_or(d);
    let list: Vec<&NewMsg> = new
        .iter()
        .filter(|n| flag(n, "notifications", true))
        .filter(|n| !(flag(n, "smartNotifications", true) && n.bulk))
        .collect();
    if list.is_empty() {
        return;
    }
    let sound_for = |n: &NewMsg| {
        eff(&p, &n.account_id, "notifySound")
            .and_then(|v| v.as_str().map(String::from))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "mail".to_string())
    };
    if list.len() > 3 {
        toast_logged(app, String::new(), "Hey Look!", &format!("{} new messages", list.len()), "", &sound_for(list[0]), &[]);
        return;
    }
    for n in list {
        let snippet: String = if flag(n, "notifyPreview", true) { n.snippet.chars().take(140).collect() } else { String::new() };
        let actions = notify_actions_for(&p, &n.account_id);
        toast_logged(app, n.thread_id.clone(), &n.from, &n.subject, &snippet, &sound_for(n), &actions);
    }
}

fn notify_actions_for(p: &Value, account: &str) -> Vec<String> {
    let list: Vec<String> = eff(p, account, "notifyActions")
        .and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()))
        .unwrap_or_else(|| vec!["archive".into(), "delete".into(), "read".into()]);
    list.into_iter().filter(|a| action_label(a).is_some()).take(3).collect()
}

/// One-time notice that closing the window keeps the app running in the tray.
pub fn tray_hint_once(app: &AppHandle, db: &Db) {
    if db::get_setting(&lock(db), "tray_hint_shown").as_deref() == Some("1") {
        return;
    }
    let _ = db::set_setting(&lock(db), "tray_hint_shown", "1");
    toast_logged(app, String::new(), "Hey Look! is still running", tray_hint_text(std::env::consts::OS), "", "none", &[]);
}

/// Snoozed threads whose time has come: bring them back as unread and notify.
pub fn check_snoozes(app: &AppHandle, db: &Db) {
    let due: Vec<(String, String, String, String)> = {
        let c = lock(db);
        let Ok(mut st) = c.prepare(
            "SELECT tm.thread_id,
                    COALESCE((SELECT subject FROM messages WHERE thread_id=tm.thread_id ORDER BY date DESC LIMIT 1),''),
                    COALESCE((SELECT from_name || ' ' || from_email FROM messages WHERE thread_id=tm.thread_id AND folder!='sent' ORDER BY date DESC LIMIT 1),''),
                    COALESCE((SELECT snippet FROM messages WHERE thread_id=tm.thread_id ORDER BY date DESC LIMIT 1),'')
             FROM thread_meta tm WHERE tm.snoozed_until IS NOT NULL AND tm.snoozed_until<=?1",
        ) else {
            return;
        };
        let Ok(rows) = st.query_map([now()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))) else { return };
        rows.filter_map(|r| r.ok()).collect()
    };
    if due.is_empty() {
        return;
    }
    let p = prefs(db);
    let quiet = blocked(app, db);
    let sound = pstr(&p, "notifySound", "reminder");
    let actions = notify_actions(&p);
    for (tid, subject, who, snippet) in due {
        let _ = lock(db).execute("UPDATE thread_meta SET snoozed_until=NULL WHERE thread_id=?1", [&tid]);
        let _ = action_impl(db, vec![tid.clone()], "unread".into(), None, None);
        if !quiet {
            toast_logged(app, tid, &format!("Snooze ended: {}", who.trim()), &subject, &snippet.chars().take(140).collect::<String>(), &sound, &actions);
        }
    }
    update_badge(app, db);
    let _ = app.emit("mail-synced", ());
}

/// Desktop notification for an event reminder (skipped when notifications are paused or the window is in front).
pub fn notify_reminder(app: &AppHandle, db: &Db, title: &str, line: &str) {
    if blocked(app, db) {
        return;
    }
    let p = prefs(db);
    toast_logged(app, String::new(), title, line, "", &pstr(&p, "notifySound", "reminder"), &[]);
}

/// Body of the one-time "still running" notice, per OS.
fn tray_hint_text(os: &str) -> &'static str {
    match os {
        "macos" => "It keeps checking your mail from the menu bar. Click the Hey Look! icon in the Dock or the menu bar to open it again.",
        "linux" => "It keeps checking your mail from the tray. Choose Quit Hey Look! in the tray icon’s menu to exit.",
        _ => "It keeps checking your mail from the tray. Right-click the tray icon and choose Quit to exit.",
    }
}

pub fn test_notification(app: &AppHandle, db: &Db) -> Result<(), String> {
    // macOS: the notification backend of the plugin (the old NSUserNotification API) shows nothing on current macOS for an ad-hoc
    // signed app and cannot ask for permission; Send test says so instead of pretending (QA BUG-M5, owner decision: documented limit)
    #[cfg(target_os = "macos")]
    {
        let _ = (app, db);
        return Err("not available on macOS in this version".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let p = prefs(db);
        toast(
            app,
            String::new(),
            "Hey Look! test notification",
            "Notifications are working",
            "This is how new mail will look.",
            &pstr(&p, "notifySound", "mail"),
            &notify_actions(&p),
        )
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn tray_mail_entries_need_an_account() {
        assert!(!tray_mail_enabled(0));
        assert!(tray_mail_enabled(1));
        assert!(tray_mail_enabled(4));
        // the menu handlers for "New mail" and "Check mail now" check the same flag, so a stale menu cannot start a sync or a draft
        let src = include_str!("shell.rs");
        for id in ["\"compose\" if MAIL_AVAILABLE", "\"sync\" if MAIL_AVAILABLE"] {
            assert!(src.contains(id), "{id}");
        }
    }

    #[test]
    fn only_a_registered_tray_host_counts() {
        assert!(tray_host_present(Some(true)));
        assert!(!tray_host_present(Some(false)));
        assert!(!tray_host_present(None), "any error on the bus means no host");
    }

    #[test]
    fn notification_text_is_subject_then_preview() {
        assert_eq!(notification_body("Subject", ""), "Subject");
        assert_eq!(notification_body("Subject", "Preview text"), "Subject\nPreview text");
    }

    #[test]
    fn the_still_running_notice_names_the_right_place() {
        assert!(tray_hint_text("windows").contains("Right-click the tray icon"));
        assert!(tray_hint_text("macos").contains("Dock") && tray_hint_text("macos").contains("menu bar"));
        assert!(tray_hint_text("linux").contains("Quit Hey Look! in the tray icon"));
    }
}
