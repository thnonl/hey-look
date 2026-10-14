//! Desktop shell integration: tray icon + unread badge, toast notifications with action buttons,
//! snooze reminders. Settings come from the UI's `prefs` JSON (stored in the settings table).
use crate::{action_impl, db, lock, now, AppState, Db, NewMsg};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem};
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
        // a window that was hidden (first show, a tray click after a --minimized start, a second start) is looked at: is the web view still running?
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
    // macOS Dock icon: the same number as the tray, off at 0 and with the "None" choice of the badge setting (shown as "Dock badge")
    #[cfg(target_os = "macos")]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_label(dock_label(count, &task_style));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = task_style;
}

/// The text of the macOS Dock badge: the unread number, nothing at 0 or when the setting is "off" (`None` removes the badge).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn dock_label(count: u32, style: &str) -> Option<String> {
    (count > 0 && style == "number").then(|| count.to_string())
}

// ---------- macOS app menu ----------

/// Id of the Quit item of the macOS app menu (the tray's own item is "quit").
pub const MAC_QUIT_ID: &str = "app-quit";

/// macOS: tauri's default menu with its Quit item replaced by one that goes through the quit sequence (REQ-48). The predefined Quit item
/// (and its Cmd+Q) ends in `[NSApp terminate:]`, which never raises `RunEvent::ExitRequested`: nothing was saved or sent (QA Mac round 2,
/// Q3 / Q4). Never fails on account of the change: a menu that cannot be changed is left as it is and `macquit.rs` still stops the terminate.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    if let Err(e) = replace_quit_item(app, &menu) {
        crate::startup::line("menu", &format!("the Quit item of the app menu could not be replaced ({e}): the terminate hook covers it"));
    }
    Ok(menu)
}

/// The app menu is the first submenu of the default menu and its Quit item the last item in it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn replace_quit_item(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    let first = menu.items().map_err(|e| e.to_string())?.into_iter().next();
    let Some(MenuItemKind::Submenu(app_menu)) = first else { return Err("the menu does not start with the app menu".into()) };
    let items = app_menu.items().map_err(|e| e.to_string())?;
    let Some(MenuItemKind::Predefined(quit)) = items.last() else { return Err("the app menu does not end with a predefined item".into()) };
    app_menu.remove(quit).map_err(|e| e.to_string())?;
    let ours = MenuItem::with_id(app, MAC_QUIT_ID, "Quit Hey Look!", true, Some("CmdOrCtrl+Q")).map_err(|e| e.to_string())?;
    app_menu.append(&ours).map_err(|e| e.to_string())
}

/// The macOS app menu's items (the tray's items are handled in `setup_tray`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() == MAC_QUIT_ID {
        crate::startup::stage(Some(app), "quit: asked through the app menu (Quit Hey Look! / Cmd+Q)");
        crate::request_quit(app);
    }
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
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return toast_linux(title, &notification_body(line1, line2), sound);
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS: the hidden diagnostic (HEYLOOK_MAC_NOTIFY in a debug build, see macnotify.rs); off = the unchanged path below
        #[cfg(target_os = "macos")]
        if let Some(mode) = crate::macnotify::mode() {
            return crate::macnotify::show(app, mode, title, &notification_body(line1, line2), sound);
        }
        use tauri_plugin_notification::NotificationExt;
        let mut n = app.notification().builder().title(title).body(notification_body(line1, line2));
        if sound != "none" {
            n = n.sound(if cfg!(target_os = "macos") { "default" } else { "message-new-email" });
        }
        n.show().map_err(|e| e.to_string().chars().take(120).collect())
    }
}

/// Linux: the plugin's `show()` hands the notification to a background task and drops its result, so a missing notification
/// service ("ServiceUnknown" on the bus) was never reported and "Send test" stayed silent (QA BUG-L2). The notification is sent
/// here and the answer of the bus is returned; a bus that does not answer in time is an error too.
#[cfg(target_os = "linux")]
fn toast_linux(title: &str, body: &str, sound: &str) -> Result<(), String> {
    let mut n = notify_rust::Notification::new();
    n.summary(title).body(body).auto_icon();
    if sound != "none" {
        n.sound_name("message-new-email");
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(n.show().map(|_| ()).map_err(|e| notify_failure_text(&e.to_string())));
    });
    rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_else(|_| {
        // no answer in 5 s: the bus holds the call while it tries to start a notification service that never comes up (an
        // activatable name without a working service), which is the same thing for the person: nothing will show it (QA BUG-L6)
        crate::startup::line("notify", "the notification call got no answer from the bus within 5 s");
        Err(NO_NOTIFICATION_SERVICE.into())
    })
}

/// What "Send test" says when no notification service can show the notification (TC-165 (1)).
const NO_NOTIFICATION_SERVICE: &str = "no notification service is running on this desktop";

/// What the user reads after "Couldn’t show a notification: ". The bus answers `ServiceUnknown` / `NameHasNoOwner` when no
/// notification service runs (a bare window manager, WSL without a server); anything else is kept in the system's words.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn notify_failure_text(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("serviceunknown") || lower.contains("namehasnoowner") || lower.contains("was not provided by any .service") {
        return NO_NOTIFICATION_SERVICE.into();
    }
    raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect()
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
        crate::startup::line("notify", &format!("notification failed: {e}"));
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
    quiet_reason(app, db).is_some()
}

/// Why no desktop notification is shown right now (paused, switched off, or the window is in front), None when one may be.
fn quiet_reason(app: &AppHandle, db: &Db) -> Option<String> {
    let paused = db::get_setting(&lock(db), "notif_paused").as_deref() == Some("1");
    let enabled = pbool(&prefs(db), "notifications", true);
    let (focused, visible, minimized) = app
        .get_webview_window("main")
        .map(|w| (w.is_focused().unwrap_or(false), w.is_visible().unwrap_or(false), w.is_minimized().unwrap_or(false)))
        .unwrap_or((false, false, false));
    quiet_because(paused, enabled, focused, visible, minimized, cfg!(target_os = "linux"))
}

/// The rule behind `quiet_reason`, pure. The window is "in front" when it is focused and visible; on Linux a minimized window is
/// never in front even when the desktop still reports it visible and focused (WSLg keeps a minimized window viewable, QA BUG-L5).
/// The reason names the values it saw, so `startup.log` tells an environment that reports the window as focused from a product fault.
pub fn quiet_because(paused: bool, enabled: bool, focused: bool, visible: bool, minimized: bool, linux: bool) -> Option<String> {
    if paused {
        return Some("notifications are paused".into());
    }
    if !enabled {
        return Some("notifications are switched off for all mailboxes".into());
    }
    let in_front = focused && visible && !(linux && minimized);
    in_front.then(|| format!("the window is in front (focused: {focused}, visible: {visible}, minimized: {minimized})"))
}

/// Toasts for newly arrived inbox mail. Every account can override the "all accounts" notification settings.
pub fn notify_new(app: &AppHandle, db: &Db, new: &[NewMsg]) {
    if new.is_empty() {
        return;
    }
    if let Some(why) = quiet_reason(app, db) {
        crate::startup::line("notify", &format!("notification: skipped for {} new message(s) ({why})", new.len()));
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
        crate::startup::line("notify", &format!("notification: skipped for {} new message(s) (the mailbox settings switch them off, or they are bulk mail)", new.len()));
        return;
    }
    crate::startup::line("notify", &format!("notification: shown for {} new message(s)", list.len()));
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
    // (a debug build started with HEYLOOK_MAC_NOTIFY=1 makes the attempt instead, for the Mac QA session: macnotify.rs)
    #[cfg(target_os = "macos")]
    if crate::macnotify::mode().is_none() {
        let _ = (app, db);
        return Err("not available on macOS in this version".into());
    }
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
    fn the_dock_badge_is_the_unread_number_unless_it_is_zero_or_turned_off() {
        assert_eq!(dock_label(7, "number"), Some("7".into()));
        assert_eq!(dock_label(1234, "number"), Some("1234".into()));
        assert_eq!(dock_label(0, "number"), None, "cleared at 0");
        assert_eq!(dock_label(7, "off"), None, "the setting's None");
        assert_eq!(dock_label(7, "dot"), None, "an unknown style shows nothing");
        // the Dock follows the same count and the same style setting as the taskbar badge, on macOS only
        let src = include_str!("shell.rs");
        assert!(src.contains("w.set_badge_label(dock_label(count, &task_style))"));
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

    #[test]
    fn the_quiet_rule_says_why_and_a_minimized_window_on_linux_is_not_in_front() {
        assert_eq!(quiet_because(false, true, false, true, false, true), None, "visible but not focused: shown");
        assert_eq!(quiet_because(false, true, true, false, false, true), None, "focused but hidden: shown");
        assert!(quiet_because(false, true, true, true, false, true).unwrap().starts_with("the window is in front (focused: true, visible: true, minimized: false)"));
        // BUG-L5: a minimized window that the desktop still calls focused and visible
        assert_eq!(quiet_because(false, true, true, true, true, true), None, "Linux: minimized is not in front");
        assert!(quiet_because(false, true, true, true, true, false).is_some(), "other systems keep the old rule");
        assert_eq!(quiet_because(true, true, false, false, false, true).as_deref(), Some("notifications are paused"));
        assert_eq!(quiet_because(false, false, false, false, false, true).as_deref(), Some("notifications are switched off for all mailboxes"));
    }

    #[test]
    fn a_new_mail_notification_leaves_a_line_for_every_decision() {
        let src = include_str!("shell.rs");
        let body = &src[src.find("pub fn notify_new(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        for line in ["notification: skipped for", "notification: shown for", "mailbox settings switch them off"] {
            assert!(body.contains(line), "{line}");
        }
        let logged = &src[src.find("fn toast_logged(").unwrap()..];
        let logged = &logged[..logged.find("\n}\n").unwrap()];
        assert!(logged.contains("startup::line(\"notify\""), "a failed notification is in startup.log too");
    }

    #[test]
    fn a_bus_that_does_not_answer_reads_like_a_missing_service() {
        // BUG-L6: the AppImage showed "did not answer" after 5 s, the deb the TC-165 text
        let src = include_str!("shell.rs");
        let body = &src[src.find("fn toast_linux").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("Err(NO_NOTIFICATION_SERVICE.into())") && !body.contains(concat!("did not ", "answer\".into()")), "{body}");
        assert_eq!(NO_NOTIFICATION_SERVICE, "no notification service is running on this desktop");
    }

    #[test]
    fn a_missing_notification_service_is_named_not_swallowed() {
        let raw = "org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.Notifications was not provided by any .service files";
        assert_eq!(notify_failure_text(raw), "no notification service is running on this desktop");
        assert_eq!(notify_failure_text("org.freedesktop.DBus.Error.NameHasNoOwner: x"), "no notification service is running on this desktop");
        assert_eq!(notify_failure_text("some  other\nfailure"), "some other failure");
        assert_eq!(notify_failure_text(&"x".repeat(500)).chars().count(), 120);
    }

    #[test]
    fn the_linux_notification_is_not_sent_through_the_fire_and_forget_plugin() {
        // BUG-L2: the plugin's show() drops the bus error, so "Send test" could never report it. The Linux branch of `toast` must
        // call `toast_linux` (which waits for the answer) before it reaches the plugin.
        let src = include_str!("shell.rs");
        let toast = &src[src.find("fn toast(app: &AppHandle, _thread").unwrap()..];
        let linux = toast.find("toast_linux(").unwrap();
        let plugin = toast.find(concat!("builder", "()")).unwrap();
        assert!(linux < plugin, "the Linux branch comes first and returns");
        let body = &src[src.find("fn toast_linux").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains(".show()") && body.contains("recv_timeout") && !body.contains("NotificationExt"), "{body}");
    }
}
