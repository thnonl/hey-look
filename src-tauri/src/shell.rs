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
            // Linux: a window that sat in the tray may come back with a white page (linuxview.rs)
            crate::linuxview::after_show(app);
        }
        // the UI re-checks for updates when the window comes back (throttled in update.rs)
        let _ = app.emit_to("main", "app-shown", ());
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
        let _ = tray.set_tooltip(Some(crate::i18n::unread_tooltip(count)));
    }
    // Windows: the badge goes on every window of the app (the main window and the secondary ones, which group under its taskbar button), so the
    // taskbar shows it whichever window was active last
    #[cfg(windows)]
    {
        let icon = if count > 0 && task_style == "number" { Some(overlay_icon(count)) } else { None };
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_overlay_icon(icon.clone());
        }
        crate::popout::set_overlay(app, icon);
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
/// The Quit item, kept to change its text when the language changes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static MAC_QUIT_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

/// macOS: tauri's default menu with its Quit item replaced by one that goes through the quit sequence (REQ-48). The predefined Quit item
/// (and its Cmd+Q) ends in `[NSApp terminate:]`, which never raises `RunEvent::ExitRequested`: nothing was saved or sent (QA Mac round 2,
/// Q3 / Q4). Never fails on account of the change: a menu that cannot be changed is left as it is and `macquit.rs` still stops the terminate.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    if let Err(e) = replace_quit_item(app, &menu) {
        crate::startup::line("menu", &format!("the Quit item of the app menu could not be replaced ({e}): the terminate hook covers it"));
    }
    if let Err(e) = localize_app_menu(app, &menu) {
        crate::startup::line("menu", &format!("the app menu stays in English ({e})"));
    }
    Ok(menu)
}

/// The predefined items of the app menu that carry text (About, Services, Hide, Hide Others, Show All), with the text each one gets: tauri builds
/// them in English whatever the language of the app is. Kept to set the text again when the language changes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static MAC_MENU_ITEMS: OnceLock<Vec<(PredefinedMenuItem<tauri::Wry>, crate::i18n::K)>> = OnceLock::new();

/// Which text a predefined item of the app menu gets, told from the English label it is built with ("About Hey Look!", "Hide Hey Look!",
/// "Services", "Hide Others", "Show All"). `None`: separators and anything else stay as they are.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_menu_slot(label: &str) -> Option<crate::i18n::K> {
    use crate::i18n::K;
    let label = label.replace('&', "");
    match label.trim() {
        "Services" => Some(K::MacServices),
        "Hide Others" => Some(K::MacHideOthers),
        "Show All" => Some(K::MacShowAll),
        l if l.starts_with("About") => Some(K::MacAbout),
        l if l.starts_with("Hide") => Some(K::MacHide),
        _ => None,
    }
}

/// Puts the language of the app on the predefined items of the app menu. macOS' standard menu has a Show All item right under Hide Others;
/// tauri's default menu leaves it out, so it is added here.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn localize_app_menu(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    use crate::i18n::{tr, K};
    let first = menu.items().map_err(|e| e.to_string())?.into_iter().next();
    let Some(MenuItemKind::Submenu(app_menu)) = first else { return Err("the menu does not start with the app menu".into()) };
    let mut found: Vec<(PredefinedMenuItem<tauri::Wry>, K)> = Vec::new();
    let mut hide_others_at = None;
    for (at, item) in app_menu.items().map_err(|e| e.to_string())?.into_iter().enumerate() {
        let MenuItemKind::Predefined(p) = item else { continue };
        let Some(k) = mac_menu_slot(&p.text().map_err(|e| e.to_string())?) else { continue };
        p.set_text(tr(k)).map_err(|e| e.to_string())?;
        if k == K::MacHideOthers {
            hide_others_at = Some(at);
        }
        found.push((p, k));
    }
    if !found.iter().any(|(_, k)| *k == K::MacShowAll) {
        if let Some(at) = hide_others_at {
            let show = PredefinedMenuItem::show_all(app, Some(tr(K::MacShowAll))).map_err(|e| e.to_string())?;
            app_menu.insert(&show, at + 1).map_err(|e| e.to_string())?;
            found.push((show, K::MacShowAll));
        }
    }
    let _ = MAC_MENU_ITEMS.set(found);
    Ok(())
}

/// The app menu is the first submenu of the default menu and its Quit item the last item in it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn replace_quit_item(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    let first = menu.items().map_err(|e| e.to_string())?.into_iter().next();
    let Some(MenuItemKind::Submenu(app_menu)) = first else { return Err("the menu does not start with the app menu".into()) };
    let items = app_menu.items().map_err(|e| e.to_string())?;
    let Some(MenuItemKind::Predefined(quit)) = items.last() else { return Err("the app menu does not end with a predefined item".into()) };
    app_menu.remove(quit).map_err(|e| e.to_string())?;
    let ours = MenuItem::with_id(app, MAC_QUIT_ID, crate::i18n::tr(crate::i18n::K::MacQuit), true, Some("CmdOrCtrl+Q")).map_err(|e| e.to_string())?;
    let _ = MAC_QUIT_ITEM.set(ours.clone());
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
/// The other tray entries, kept to change their text when the language changes: open, pause, quit.
static TRAY_OTHER_ITEMS: OnceLock<(MenuItem<tauri::Wry>, CheckMenuItem<tauri::Wry>, MenuItem<tauri::Wry>)> = OnceLock::new();

/// The language changed (the UI mirrored it): the tray menu, the macOS app menu (Quit, About, Hide ...) and the tray tooltip follow at once.
pub fn refresh_language(app: &AppHandle, db: &Db) {
    use crate::i18n::{tr, K};
    if let Some((compose, sync)) = TRAY_MAIL_ITEMS.get() {
        let _ = compose.set_text(tr(K::TrayCompose));
        let _ = sync.set_text(tr(K::TraySync));
    }
    if let Some((open, pause, quit)) = TRAY_OTHER_ITEMS.get() {
        let _ = open.set_text(tr(K::TrayOpen));
        let _ = pause.set_text(tr(K::TrayPause));
        let _ = quit.set_text(tr(K::TrayQuit));
    }
    if let Some(q) = MAC_QUIT_ITEM.get() {
        let _ = q.set_text(tr(K::MacQuit));
    }
    for (item, k) in MAC_MENU_ITEMS.get().into_iter().flatten() {
        let _ = item.set_text(tr(*k));
    }
    update_badge(app, db);
}

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
    use crate::i18n::{tr, K};
    let open = MenuItem::with_id(app, "open", tr(K::TrayOpen), true, None::<&str>)?;
    let compose = MenuItem::with_id(app, "compose", tr(K::TrayCompose), true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", tr(K::TraySync), true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", tr(K::TrayPause), true, paused, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", tr(K::TrayQuit), true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &compose, &sync, &sep1, &pause, &sep2, &quit])?;
    let has_accounts = tray_mail_enabled(db::list_accounts(&lock(db)).map(|a| a.len()).unwrap_or(0));
    let _ = TRAY_MAIL_ITEMS.set((compose.clone(), sync.clone()));
    let _ = TRAY_OTHER_ITEMS.set((open.clone(), pause.clone(), quit.clone()));
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
                // with "open new messages in a separate window" on, the message gets its own window and the main window stays where it is (REQ-C2)
                if !compose_in_window(app) {
                    show_main(app);
                }
                let _ = app.emit_to("main", "tray-compose", ());
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
        // Windows and macOS: a left click (double click) on the icon opens the window. Linux: the indicator service (libayatana-appindicator /
        // StatusNotifier) never delivers click events to the app, so this does not run there: the menu entry "Open Hey Look!" is the way back,
        // and the first-hide hint (`tray_hint_text`) names the menu only. Nothing in the app may promise a click on Linux.
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
    let key = format!(r"HKCU\Software\Classes\AppUserModelId\{}", crate::identity::aumid());
    let display = if crate::identity::isolated() { "Hey Look! (test copy)" } else { "Hey Look!" };
    for (name, val) in [("DisplayName", display), ("IconUri", icon.to_str().unwrap_or(""))] {
        let _ = crate::winproc::hidden("reg").args(["add", &key, "/v", name, "/t", "REG_SZ", "/d", val, "/f"]).output();
    }
}

#[cfg(not(windows))]
pub fn register_aumid(_app: &AppHandle) {}

fn action_label(id: &str) -> Option<&'static str> {
    use crate::i18n::{tr, K};
    Some(tr(match id {
        "archive" => K::ActArchive,
        "delete" => K::ActDelete,
        "read" => K::ActRead,
        "flag" => K::ActFlag,
        "reply" => K::ActReply,
        "snooze" => K::ActSnooze,
        _ => return None,
    }))
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
            let _ = app.emit_to("main", "open-thread", json!({ "threadId": thread }));
        }
        Some("reply") => {
            show_main(app);
            let _ = app.emit_to("main", "notify-reply", json!({ "threadId": thread }));
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
    let mut t = Toast::new(crate::identity::aumid()).title(title).text1(line1);
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
    // (the result was dropped here: a toast that Windows refused was reported as shown by "Send test" and left no line in startup.log)
    t.show().map_err(|e| e.to_string().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect())
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
/// (a coded error: the UI translates it, see `i18n::coded`)
const NO_NOTIFICATION_SERVICE: &str = "NOTIFY_NO_SERVICE: No notification service is running in this desktop environment.";

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

/// The two lines of a new-mail notification, the same text on every platform (the Windows toast shows them as its two text lines,
/// `notification_body` joins them for macOS and Linux): the subject, cleaned a little (control characters out, white space
/// collapsed), and the preview of the message (`snippet::notification_preview`: no link markup, addresses or "view in browser"
/// lines, about 100 characters). The preview line is empty when it is switched off or when too little readable text is left;
/// a message without a subject shows its preview in its place.
fn message_lines(subject: &str, snippet: &str, show_preview: bool) -> (String, String) {
    let subject = crate::snippet::notification_line(subject);
    let preview = if show_preview { crate::snippet::notification_preview(snippet) } else { String::new() };
    if subject.is_empty() {
        return if preview.is_empty() { ("(no subject)".into(), String::new()) } else { (preview, String::new()) };
    }
    (subject, preview)
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
    // "the app is in front" is any window of it: a focused secondary window counts like the main one (REQ-W13)
    let (focused, visible, minimized) = if crate::popout::any_in_front(app) { (true, true, false) } else { (focused, visible, minimized) };
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
        toast_logged(app, String::new(), "Hey Look!", &crate::i18n::new_messages(list.len()), "", &sound_for(list[0]), &[]);
        return;
    }
    for n in list {
        let (line1, line2) = message_lines(&n.subject, &n.snippet, flag(n, "notifyPreview", true));
        let actions = notify_actions_for(&p, &n.account_id);
        toast_logged(app, n.thread_id.clone(), &crate::snippet::notification_line(&n.from), &line1, &line2, &sound_for(n), &actions);
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
    toast_logged(app, String::new(), crate::i18n::tr(crate::i18n::K::TrayHintTitle), tray_hint_text(std::env::consts::OS), "", "none", &[]);
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
            let (line1, line2) = message_lines(&subject, &snippet, true);
            toast_logged(app, tid, &crate::snippet::notification_line(&crate::i18n::snooze_ended(who.trim())), &line1, &line2, &sound, &actions);
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
    crate::i18n::tray_hint(os)
}

pub fn test_notification(app: &AppHandle, db: &Db) -> Result<(), String> {
    // macOS: the notification backend of the plugin (the old NSUserNotification API) shows nothing on current macOS for an ad-hoc
    // signed app and cannot ask for permission; Send test says so instead of pretending (QA BUG-M5, owner decision: documented limit)
    // (a debug build started with HEYLOOK_MAC_NOTIFY=1 makes the attempt instead, for the Mac QA session: macnotify.rs)
    #[cfg(target_os = "macos")]
    if crate::macnotify::mode().is_none() {
        let _ = (app, db);
        return Err(crate::i18n::coded("NOTIFY_MAC_UNAVAILABLE", &[], "not available on macOS in this version"));
    }
    let p = prefs(db);
    toast(
        app,
        String::new(),
        crate::i18n::tr(crate::i18n::K::TestTitle),
        crate::i18n::tr(crate::i18n::K::TestLine1),
        crate::i18n::tr(crate::i18n::K::TestLine2),
        &pstr(&p, "notifySound", "mail"),
        &notify_actions(&p),
    )
}

/// Does a plain "New mail" open a window of its own? (Settings > Composing, `prefs.popoutCompose`, default off.) Read from the stored
/// preferences: the tray must know before the page is asked.
fn compose_in_window(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    let raw = db::get_setting(&lock(&st.db), "prefs");
    prefs_open_in_window(raw.as_deref())
}

fn prefs_open_in_window(raw: Option<&str>) -> bool {
    raw.and_then(|s| serde_json::from_str::<Value>(s).ok()).and_then(|v| v.get("popoutCompose").and_then(Value::as_bool)).unwrap_or(false)
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn the_tray_new_mail_reads_the_window_setting_from_the_stored_preferences() {
        assert!(!prefs_open_in_window(None), "no preferences stored yet: off");
        assert!(!prefs_open_in_window(Some("not json")));
        assert!(!prefs_open_in_window(Some("{}")), "an older blob without the field: off");
        assert!(!prefs_open_in_window(Some(r#"{"popoutCompose":false}"#)));
        assert!(!prefs_open_in_window(Some(r#"{"popoutCompose":"yes"}"#)), "only a real true counts");
        assert!(prefs_open_in_window(Some(r#"{"language":"en","popoutCompose":true}"#)));
    }

    #[test]
    fn the_app_menu_items_are_told_apart_by_their_english_label() {
        use crate::i18n::K;
        assert_eq!(mac_menu_slot("About Hey Look!"), Some(K::MacAbout));
        assert_eq!(mac_menu_slot("&About"), Some(K::MacAbout));
        assert_eq!(mac_menu_slot("Services"), Some(K::MacServices));
        assert_eq!(mac_menu_slot("Hide Hey Look!"), Some(K::MacHide));
        assert_eq!(mac_menu_slot("Hide"), Some(K::MacHide));
        assert_eq!(mac_menu_slot("Hide Others"), Some(K::MacHideOthers));
        assert_eq!(mac_menu_slot("Show All"), Some(K::MacShowAll));
        // separators and the Quit item (ours) are left alone
        assert_eq!(mac_menu_slot(""), None);
        assert_eq!(mac_menu_slot("Quit Hey Look!"), None);
    }

    /// The localised items are rebuilt with the language: the app menu code and the language refresh use the same list, and the menu code is only
    /// ever compiled in for macOS (this reads the source, like the quit tests do).
    #[test]
    fn the_app_menu_follows_the_language_change() {
        let src = crate::test_guard::non_test_code(include_str!("shell.rs"));
        let src = &src[..];
        assert!(src.contains("localize_app_menu(app, &menu)"), "mac_app_menu does not translate the app menu");
        let refresh = &src[src.find("pub fn refresh_language").unwrap()..];
        let refresh = &refresh[..refresh.find("
}
").unwrap()];
        assert!(refresh.contains("MAC_MENU_ITEMS") && refresh.contains("MAC_QUIT_ITEM"), "{refresh}");
    }

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
    fn f27_a_marketing_mail_notification_has_no_link_markup_on_any_platform() {
        // the stored snippet of the screenshot: a Markdown link to a tracking address (cut inside the address)
        let snippet = "[View in browser](https://ecafgcd.r.af.d.sendibt2.com/tr/mr/Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8lP4o2bJ6sXAn1ZcR7u?p=eyJ1IjoiMSJ9";
        let (l1, l2) = message_lines("\u{1F525} Mở Đặt Cọc iPhone Duo", snippet, true);
        assert_eq!((l1.as_str(), l2.as_str()), ("\u{1F525} Mở Đặt Cọc iPhone Duo", ""), "no third line");
        // Windows: the toast gets l1 / l2 as its two text lines; macOS and Linux: the body is both lines joined
        assert_eq!(notification_body(&l1, &l2), "\u{1F525} Mở Đặt Cọc iPhone Duo");
        // the same marketing mail with a readable preheader: that is the third line, without markup
        let snippet = "[View in browser](https://x.example/t) \u{1F525} Ưu đãi lớn cho khách hàng thân thiết. [Unsubscribe](https://x.example/u) https://x.example/z";
        let (l1, l2) = message_lines("\u{1F525} Mở Đặt Cọc iPhone Duo", snippet, true);
        assert_eq!(l2, "\u{1F525} Ưu đãi lớn cho khách hàng thân thiết.");
        assert_eq!(notification_body(&l1, &l2), "\u{1F525} Mở Đặt Cọc iPhone Duo\n\u{1F525} Ưu đãi lớn cho khách hàng thân thiết.");
        for bad in ["[", "](", "http", "://", "View in browser", "Unsubscribe"] {
            assert!(!notification_body(&l1, &l2).contains(bad), "{bad:?}");
        }
        // preview switched off: the subject only; the subject is cleaned a little, a real one is not changed
        assert_eq!(message_lines("Hello", "Some readable words here", false), ("Hello".into(), String::new()));
        assert_eq!(message_lines("  Re:\t Q3\r\n report\u{0007} ", "Some readable words here", true), ("Re: Q3 report".into(), "Some readable words here".into()));
        // a very long preview is cut to about 100 characters on a word
        let long = "word ".repeat(100);
        let (_, l2) = message_lines("Subject", &long, true);
        assert!(l2.chars().count() <= 100 && l2.ends_with("word\u{2026}"), "{l2:?}");
        // no subject: the preview takes its place, and with neither the notification still says something
        assert_eq!(message_lines("", "Some readable words here", true), ("Some readable words here".into(), String::new()));
        assert_eq!(message_lines(" \u{200B} ", "", true), ("(no subject)".into(), String::new()));
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
    fn a_windows_toast_that_fails_is_reported_not_swallowed() {
        // F-18 check: `let _ = t.show()` hid every WinRT error from "Send test" and from startup.log (toast_logged)
        let src = include_str!("shell.rs");
        let toast = &src[src.find("fn toast(app: &AppHandle, thread: String").unwrap()..];
        let toast = &toast[..toast.find("\n}\n").unwrap()];
        assert!(toast.contains("t.show().map_err(") && !toast.contains("let _ = t.show()"), "{toast}");
    }

    #[test]
    fn a_bus_that_does_not_answer_reads_like_a_missing_service() {
        // BUG-L6: the AppImage showed "did not answer" after 5 s, the deb the TC-165 text
        let src = include_str!("shell.rs");
        let body = &src[src.find("fn toast_linux").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("Err(NO_NOTIFICATION_SERVICE.into())") && !body.contains(concat!("did not ", "answer\".into()")), "{body}");
        assert_eq!(NO_NOTIFICATION_SERVICE, "NOTIFY_NO_SERVICE: No notification service is running in this desktop environment.");
    }

    #[test]
    fn a_missing_notification_service_is_named_not_swallowed() {
        let raw = "org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.Notifications was not provided by any .service files";
        assert_eq!(notify_failure_text(raw), NO_NOTIFICATION_SERVICE);
        assert_eq!(notify_failure_text("org.freedesktop.DBus.Error.NameHasNoOwner: x"), NO_NOTIFICATION_SERVICE);
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
