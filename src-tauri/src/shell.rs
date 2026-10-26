//! Desktop shell integration: tray icon + unread badge, toast notifications with action buttons,
//! snooze reminders. Settings come from the UI's `prefs` JSON (stored in the settings table).
use crate::{action_impl, db, lock, now, AppState, Db, NewMsg};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
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
        let was_minimized = w.is_minimized().unwrap_or(false);
        // a window that a tray start made off-screen goes to the screen first (ghost.rs)
        crate::ghost::unpark(app);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // a window that was hidden or minimized (first show, a tray click after a --minimized start, a second start, a notification) is looked at: is
        // the web view still running, and does the window show the page (D-057: a white window after a show from the tray)? So is a window that is already
        // on screen while no look has found it painted yet (1.0.8, the white window after an update relaunch: the owner's tray click cured it, and the click is
        // what asked for these looks)
        if crate::startup::looks_wanted(was_hidden, was_minimized, crate::startup::paint_confirmed()) {
            crate::startup::verify_painting(app);
        }
        if was_hidden {
            // Linux: a window that sat in the tray may come back with a white page (linuxview.rs)
            crate::linuxview::after_show(app);
        }
        // the UI re-checks for updates when the window comes back (throttled in update.rs)
        let _ = app.emit_to("main", "app-shown", ());
    } else if crate::startgate::request_window() {
        // a Windows autostart whose window waits for the desktop (startgate.rs): the wait ends now and the window is shown when it exists
        crate::startup::stage(Some(app), "the window was asked for before it exists: the start gate lets it be made now");
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
    let include_other = pbool(&p, "countOtherMail", true) || !pbool(&p, "focused", true);
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
    // macOS Dock icon: the same number as the tray, off at 0 and with the "None" choice of the badge setting (shown as "Dock badge"). The call runs on
    // the main thread (NSDockTile) and its Result is logged and kept for the QA bridge (D-056, dockbadge.rs)
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        crate::dockbadge::request_into(
            &crate::dockbadge::LAST,
            crate::dockbadge::label(count, &task_style),
            |job| app.run_on_main_thread(job).map_err(|e| e.to_string()),
            move |label| set_dock_badge(&handle, label),
        );
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = task_style;
}

/// The platform call of the Dock badge (main thread): sets the label and returns what the Dock tile reports afterwards.
#[cfg(target_os = "macos")]
fn set_dock_badge(app: &AppHandle, label: Option<String>) -> Result<Option<String>, String> {
    let w = app.get_webview_window("main").ok_or("the main window does not exist (yet)")?;
    w.set_badge_label(label).map_err(|e| e.to_string())?;
    crate::macdock::tile_label()
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
    if let Err(e) = add_paste_match_item(app, &menu) {
        crate::startup::line("menu", &format!("the Edit menu has no Paste and Match Style item ({e})"));
    }
    // W5.11: the standard items of a Mac mail app, each one left out (and logged) rather than failing the menu
    if let Err(e) = add_settings_item(app, &menu) {
        crate::startup::line("menu", &format!("the app menu has no Settings item ({e})"));
    }
    if let Err(e) = add_print_item(app, &menu) {
        crate::startup::line("menu", &format!("the File menu has no Print item ({e})"));
    }
    if let Err(e) = add_help_item(app, &menu) {
        crate::startup::line("menu", &format!("the Help menu has no Hey Look! Help item ({e})"));
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

/// One entry of the macOS app menu, in the order the person sees it (W5.7).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum AppMenuEntry {
    Item(crate::i18n::K),
    Separator,
}

/// The app menu of macOS as the app builds it: tauri's default menu (About, separator, Services, separator, Hide, Hide Others, separator, Quit) with the Show All item that
/// Apple's standard menu has under Hide Others added (`localize_app_menu`), the Settings item after About (`add_settings_item`, W5.11) and the Quit item replaced by ours
/// (`replace_quit_item`): seven items and four separators, in the app's language. Pure: the list the test compares with what the functions do (W5.7: Show All stays).
#[cfg_attr(not(test), allow(dead_code))]
pub fn app_menu_plan() -> Vec<AppMenuEntry> {
    use crate::i18n::K;
    use AppMenuEntry::{Item, Separator};
    vec![Item(K::MacAbout), Separator, Item(K::MacSettings), Separator, Item(K::MacServices), Separator, Item(K::MacHide), Item(K::MacHideOthers), Item(K::MacShowAll), Separator, Item(K::MacQuit)]
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

/// Id of the Edit menu's "Paste and Match Style" item (macOS).
pub const MAC_PASTE_MATCH_ID: &str = "edit-paste-match";
/// The item, kept to change its text when the language changes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static MAC_PASTE_MATCH_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

/// macOS: "Paste and Match Style" (Cmd+Option+Shift+V) in the Edit menu, right after Paste. tauri's default Edit menu does not have it, and macOS apps have it (1.0.7 AC-2.24.1).
/// The item has no action of its own: choosing it tells the focused window (event `mac-paste-match`), whose page pastes the clipboard text only, the way its
/// Cmd+Shift+V does (src/plainPasteKey.ts). The key itself still reaches the page first (the web view offers a key equivalent to the page before the menu) and the page
/// claims it, so one press is one paste. Never fails on account of the change: a menu without the Paste item is left as it is.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn add_paste_match_item(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    for item in menu.items().map_err(|e| e.to_string())? {
        let MenuItemKind::Submenu(sub) = item else { continue };
        let items = sub.items().map_err(|e| e.to_string())?;
        let paste = items.iter().position(|i| matches!(i, MenuItemKind::Predefined(p) if p.text().map(|t| t.replace('&', "").trim() == "Paste").unwrap_or(false)));
        let Some(at) = paste else { continue };
        let ours = MenuItem::with_id(app, MAC_PASTE_MATCH_ID, crate::i18n::tr(crate::i18n::K::MacPasteMatch), true, Some("CmdOrCtrl+Alt+Shift+V")).map_err(|e| e.to_string())?;
        sub.insert(&ours, at + 1).map_err(|e| e.to_string())?;
        let _ = MAC_PASTE_MATCH_ITEM.set(ours);
        return Ok(());
    }
    Err("the menu has no Paste item".into())
}

/// Ids of the items W5.11 adds to the macOS menu bar (the page is told through the events `mac-open-settings`, `mac-print`, `mac-help`).
pub const MAC_SETTINGS_ID: &str = "app-settings";
pub const MAC_PRINT_ID: &str = "file-print";
pub const MAC_HELP_ID: &str = "help-app";
/// The three items, kept to change their text when the language changes (Print also to switch it on and off).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static MAC_SETTINGS_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static MAC_PRINT_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static MAC_HELP_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

/// App menu: "Settings…" (Cmd+,) right after About and its separator, with a separator of its own after it (REQ-5.11.1). Choosing it shows the main window and opens Settings as the gear does.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn add_settings_item(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    let first = menu.items().map_err(|e| e.to_string())?.into_iter().next();
    let Some(MenuItemKind::Submenu(app_menu)) = first else { return Err("the menu does not start with the app menu".into()) };
    let items = app_menu.items().map_err(|e| e.to_string())?;
    let after_about = matches!(items.first(), Some(MenuItemKind::Predefined(p)) if p.text().map(|t| t.replace('&', "").trim().starts_with("About")).unwrap_or(false));
    if !after_about || !matches!(items.get(1), Some(MenuItemKind::Predefined(_))) {
        return Err("the app menu does not start with About and a separator".into());
    }
    let ours = MenuItem::with_id(app, MAC_SETTINGS_ID, crate::i18n::tr(crate::i18n::K::MacSettings), true, Some("CmdOrCtrl+,")).map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    app_menu.insert(&ours, 2).map_err(|e| e.to_string())?;
    app_menu.insert(&sep, 3).map_err(|e| e.to_string())?;
    let _ = MAC_SETTINGS_ITEM.set(ours);
    Ok(())
}

/// File menu: "Print…" (Cmd+P) after Close Window, behind a separator (REQ-5.11.2). It starts switched off; the pages say when there is something to print (`note_can_print`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn add_print_item(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    for item in menu.items().map_err(|e| e.to_string())? {
        let MenuItemKind::Submenu(file) = item else { continue };
        if file.text().map_err(|e| e.to_string())?.replace('&', "").trim() != "File" {
            continue;
        }
        let ours = MenuItem::with_id(app, MAC_PRINT_ID, crate::i18n::tr(crate::i18n::K::MacPrint), false, Some("CmdOrCtrl+P")).map_err(|e| e.to_string())?;
        file.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        file.append(&ours).map_err(|e| e.to_string())?;
        let _ = MAC_PRINT_ITEM.set(ours);
        return Ok(());
    }
    Err("the menu has no File menu".into())
}

/// Help menu: "Hey Look! Help" (REQ-5.11.3). The Help menu is the one tauri registers with the system, so macOS keeps its own search field in it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn add_help_item(app: &AppHandle, menu: &Menu<tauri::Wry>) -> Result<(), String> {
    let Some(MenuItemKind::Submenu(help)) = menu.get(tauri::menu::HELP_SUBMENU_ID) else { return Err("the menu has no Help menu".into()) };
    let ours = MenuItem::with_id(app, MAC_HELP_ID, crate::i18n::tr(crate::i18n::K::MacHelp), true, None::<&str>).map_err(|e| e.to_string())?;
    help.append(&ours).map_err(|e| e.to_string())?;
    let _ = MAC_HELP_ITEM.set(ours);
    Ok(())
}

/// Which window has the keyboard focus and which windows said they show a printable message.
#[derive(Default)]
struct PrintState {
    focused: Option<String>,
    can: HashMap<String, bool>,
}

fn print_state() -> &'static Mutex<PrintState> {
    static STATE: OnceLock<Mutex<PrintState>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}

/// Only the main window and the reader windows print a message (a compose, Settings, search, Scheduled or event window never does).
fn prints_in(label: &str) -> bool {
    label == "main" || label.starts_with("reader-")
}

/// Is File > Print… on: the focused window is one that prints and it said that a printable message is open (not Confidential, W5.3). Pure.
pub fn print_enabled(focused: Option<&str>, can: &HashMap<String, bool>) -> bool {
    focused.is_some_and(|l| prints_in(l) && can.get(l).copied().unwrap_or(false))
}

/// Switches the Print item to what the state says. Main thread only (the item is a native menu item): called from the window events and, through `run_on_main_thread`, after a page's report,
/// so the last report always wins and the state is read when the switch is made.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn apply_print_item() {
    let on = {
        let st = print_state().lock().unwrap_or_else(|e| e.into_inner());
        print_enabled(st.focused.as_deref(), &st.can)
    };
    if let Some(item) = MAC_PRINT_ITEM.get() {
        let _ = item.set_enabled(on);
    }
}

/// A page says whether it shows a printable message (command `mac_menu_state`): the item follows at once. The window is the one that calls, so a page can only speak for itself.
pub fn note_can_print(app: &AppHandle, label: &str, can: bool) {
    if !prints_in(label) {
        return;
    }
    {
        let mut st = print_state().lock().unwrap_or_else(|e| e.into_inner());
        if can {
            st.can.insert(label.to_string(), true);
        } else {
            st.can.remove(label);
        }
    }
    if MAC_PRINT_ITEM.get().is_some() {
        let _ = app.run_on_main_thread(apply_print_item);
    }
}

/// Window events that decide File > Print… (macOS): the window with the focus, and a window that is gone forgets what it said. Runs on the main thread.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn menu_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label();
    {
        let mut st = print_state().lock().unwrap_or_else(|e| e.into_inner());
        match event {
            tauri::WindowEvent::Focused(true) => st.focused = Some(label.to_string()),
            tauri::WindowEvent::Focused(false) if st.focused.as_deref() == Some(label) => st.focused = None,
            tauri::WindowEvent::Destroyed => {
                st.can.remove(label);
                if st.focused.as_deref() == Some(label) {
                    st.focused = None;
                }
            }
            _ => return,
        }
    }
    apply_print_item();
}

/// The window a menu item acts on: the one with the focus, else the first one the system says has it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn focused_label(app: &AppHandle) -> Option<String> {
    let tracked = print_state().lock().unwrap_or_else(|e| e.into_inner()).focused.clone();
    tracked.or_else(|| app.webview_windows().into_iter().find(|(_, w)| w.is_focused().unwrap_or(false)).map(|(l, _)| l))
}

/// The macOS app menu's items (the tray's items are handled in `setup_tray`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() == MAC_QUIT_ID {
        crate::startup::stage(Some(app), "quit: asked through the app menu (Quit Hey Look! / Cmd+Q)");
        crate::request_quit(app);
    } else if event.id().as_ref() == MAC_PASTE_MATCH_ID {
        // the focused window pastes (a page that is not an editor does nothing)
        let label = app.webview_windows().into_iter().find(|(_, w)| w.is_focused().unwrap_or(false)).map(|(l, _)| l).unwrap_or_else(|| "main".into());
        let _ = app.emit_to(label.as_str(), "mac-paste-match", ());
    } else if event.id().as_ref() == MAC_SETTINGS_ID {
        // as the gear: the main window first (shown, in front), then the page opens Settings (or its window)
        crate::startup::line("menu", "Settings… chosen in the app menu");
        show_main(app);
        let _ = app.emit_to("main", "mac-open-settings", ());
    } else if event.id().as_ref() == MAC_PRINT_ID {
        // the focused window prints its own message through the page (the same path as its More > Print); the item is off unless that window said it can
        let target = focused_label(app).filter(|l| {
            let st = print_state().lock().unwrap_or_else(|e| e.into_inner());
            print_enabled(Some(l), &st.can)
        });
        match target {
            Some(label) => {
                crate::startup::line("menu", &format!("Print… chosen in the app menu: {label} prints"));
                let _ = app.emit_to(label.as_str(), "mac-print", ());
            }
            None => crate::startup::line("menu", "Print… chosen with nothing to print: ignored"),
        }
    } else if event.id().as_ref() == MAC_HELP_ID {
        // the page of the focused window opens help.html in the app language and tells a failure in its own window; any other window asks the main page
        let label = focused_label(app).filter(|l| prints_in(l)).unwrap_or_else(|| "main".into());
        let _ = app.emit_to(label.as_str(), "mac-help", ());
    }
}

// ---------- tray ----------

/// Linux: is there anything on the session bus that shows tray icons (a registered StatusNotifier host)? Any error = no.
#[cfg(target_os = "linux")]
pub fn linux_tray_host() -> bool {
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
/// "New mail" was chosen in the tray / menu bar menu and the main page has not taken the request yet. An event sent before the page listens is lost (the first
/// second of a start, or a page that is still loading), so the request is also kept here: the page asks `take_tray_compose` when the event arrives and once more
/// after it registered its listeners (W1.3).
pub static TRAY_COMPOSE_PENDING: AtomicBool = AtomicBool::new(false);
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
    if let Some(p) = MAC_PASTE_MATCH_ITEM.get() {
        let _ = p.set_text(tr(K::MacPasteMatch));
    }
    if let Some(i) = MAC_SETTINGS_ITEM.get() {
        let _ = i.set_text(tr(K::MacSettings));
    }
    if let Some(i) = MAC_PRINT_ITEM.get() {
        let _ = i.set_text(tr(K::MacPrint));
    }
    if let Some(i) = MAC_HELP_ITEM.get() {
        let _ = i.set_text(tr(K::MacHelp));
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
                TRAY_COMPOSE_PENDING.store(true, Ordering::SeqCst);
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

/// Windows: is the tray icon really in the notification area? The icon library reports success when the first `Shell_NotifyIcon` call failed because the shell was
/// not ready (it waits for `TaskbarCreated`, which does not come when the taskbar was already there), so `tray_ready` alone does not say that a person can see
/// the icon. `Some(false)`: the shell does not know the icon; `None`: no tray icon, or the answer cannot be asked (counts as present, nothing is guessed). An icon
/// that Windows 11 keeps in the overflow flyout is known to the shell and counts as present.
#[cfg(windows)]
pub fn tray_icon_present(app: &AppHandle) -> Option<bool> {
    let tray = app.tray_by_id("main")?;
    match tray.rect() {
        Ok(Some(_)) => Some(true),
        Ok(None) => Some(false),
        Err(_) => None,
    }
}

// ---------- toast notifications ----------

/// Register the AppUserModelID so Windows shows our name and icon on toasts (no installer needed).
#[cfg(windows)]
pub fn register_aumid(app: &AppHandle) {
    if crate::pkg::packaged() {
        return; // a package has its own AppUserModelID, name and icon (the manifest); the registry is not used
    }
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
    // (W13.8) "reminder" (an event reminder) keeps the system Reminder sound; a new-mail toast is always silent: Windows cannot play a Hey Look! file for an unpackaged
    // app, so the app plays the sound itself after the toast (notifysound.rs)
    let snd = if sound == "reminder" { Some(Sound::Reminder) } else { None };
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
    let app2 = app.clone();
    let app = app.clone();
    let t = t.on_activated(move |action| {
        handle_activation(&app, &thread, action);
        Ok(())
    });
    // (the result was dropped here: a toast that Windows refused was reported as shown by "Send test" and left no line in startup.log)
    let shown = t.show().map_err(|e| e.to_string().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect());
    if shown.is_ok() && sound == "pop" {
        crate::notifysound::play_new_mail(&app2);
    }
    shown
}

/// macOS: a plain native notification (no buttons; clicking it has the system's default effect only). Linux: the notification carries the mailbox's buttons and a click on its body opens the
/// conversation when the service draws buttons (W5.4, linuxnotify.rs). `sound` is "pop" (the Hey Look! sound, W13.8), "reminder" (an event reminder: the system's notification sound) or "none".
#[cfg(not(windows))]
fn toast(app: &AppHandle, thread: String, title: &str, line1: &str, line2: &str, sound: &str, actions: &[String]) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return toast_linux(app, &thread, title, &notification_body(line1, line2), sound, actions);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (&thread, actions); // (macOS notifications have no buttons)
        // macOS: the hidden diagnostic (HEYLOOK_MAC_NOTIFY in a debug build, see macnotify.rs); off = the unchanged path below. The notification is silent, the app plays the sound
        // (a new-mail sound is the only signal on a Mac where the notification itself is not shown, W13.8)
        #[cfg(target_os = "macos")]
        if let Some(mode) = crate::macnotify::mode() {
            let shown = crate::macnotify::show(app, mode, title, &notification_body(line1, line2), if sound == "reminder" { "reminder" } else { "none" });
            if sound == "pop" {
                crate::notifysound::play_new_mail(app);
            }
            return shown;
        }
        use tauri_plugin_notification::NotificationExt;
        let mut n = app.notification().builder().title(title).body(notification_body(line1, line2));
        if sound == "reminder" {
            n = n.sound("default");
        }
        let shown = n.show().map_err(|e| e.to_string().chars().take(120).collect());
        #[cfg(target_os = "macos")]
        if sound == "pop" {
            crate::notifysound::play_new_mail(app);
        }
        shown
    }
}

/// Linux: the plugin's `show()` hands the notification to a background task and drops its result, so a missing notification
/// service ("ServiceUnknown" on the bus) was never reported and "Send test" stayed silent (QA BUG-L2). The notification is sent
/// here and the answer of the bus is returned; a bus that does not answer in time is an error too.
#[cfg(target_os = "linux")]
fn toast_linux(app: &AppHandle, thread: &str, title: &str, body: &str, sound: &str, actions: &[String]) -> Result<(), String> {
    let mut n = notify_rust::Notification::new();
    n.summary(title).body(body).auto_icon();
    // (W5.4) an e-mail notification: its category, and the desktop file that names the app (services group and mute by it); urgency stays normal
    n.hint(notify_rust::Hint::Category("email.arrived".into()));
    n.hint(notify_rust::Hint::DesktopEntry(LINUX_DESKTOP_ID.into()));
    // (W5.4) buttons and the click on the body, when the service draws buttons; the one listener of the run answers them
    let pairs = if crate::linuxnotify::actions_supported() {
        let open = crate::i18n::tr(crate::i18n::K::TrayOpen);
        let pairs = crate::linuxnotify::action_pairs(actions, open, action_label);
        for (key, label) in &pairs {
            n.action(key, label);
        }
        let handle = app.clone();
        crate::linuxnotify::ensure_listener(move |answer| linux_answer(&handle, answer));
        pairs
    } else {
        Vec::new()
    };
    let app = app.clone();
    let thread = thread.to_string();
    let sound = sound.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // (W13.8) the sound: a server that lists the capability "sound" plays the file of the hint `sound-file` (`sound-name` is the fallback of a server that knows only names), and applies
        // its own Do not disturb; otherwise the app plays the file after the notification (notifysound.rs). An event reminder keeps the system's notification sound.
        let mut by_app = false;
        if sound == "reminder" {
            n.sound_name("message-new-email");
        } else if sound == "pop" {
            match crate::notifysound::linux_carrier(&app) {
                (crate::notifysound::Carrier::Server, Some(file)) => {
                    n.hint(notify_rust::Hint::SoundFile(file.to_string_lossy().into_owned()));
                    n.sound_name("message-new-email");
                }
                _ => by_app = true,
            }
        }
        let shown = n.show().map(|h| h.id()).map_err(|e| notify_failure_text(&e.to_string()));
        if let Ok(id) = &shown {
            if !pairs.is_empty() {
                crate::linuxnotify::tracked().lock().unwrap_or_else(|p| p.into_inner()).insert(*id, &thread, &pairs, std::time::Instant::now());
            }
        }
        if shown.is_ok() && by_app {
            crate::notifysound::play_with_player(&app);
        }
        let _ = tx.send(shown.map(|_| ()));
    });
    rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_else(|_| {
        // no answer in 5 s: the bus holds the call while it tries to start a notification service that never comes up (an
        // activatable name without a working service), which is the same thing for the person: nothing will show it (QA BUG-L6)
        crate::startup::line("notify", "the notification call got no answer from the bus within 5 s");
        Err(NO_NOTIFICATION_SERVICE.into())
    })
}

/// The desktop file id of the app on Linux (hey-look.desktop: the .deb, the AppImage's and the snap's).
#[cfg(target_os = "linux")]
const LINUX_DESKTOP_ID: &str = "hey-look";

/// Linux (W5.4): an answer of the notification service. The body of a notification opens its conversation (the main window only comes forward when it has none, as the summary and the
/// test notification); a button does what it does on Windows (`handle_activation`), also while the window is hidden.
#[cfg(target_os = "linux")]
fn linux_answer(app: &AppHandle, answer: crate::linuxnotify::Answer) {
    use crate::linuxnotify::Answer;
    match answer {
        Answer::Open { thread } if thread.is_empty() => show_main(app),
        Answer::Open { thread } => handle_activation(app, &thread, None),
        Answer::Button { thread, key } => handle_activation(app, &thread, Some(key)),
    }
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
    // (W13.8) one sound per batch: when the sound is on for at least one mailbox of the batch and none played in the last 3 s. Only the first notification carries it.
    let wants = crate::notifysound::batch_wants_sound(&p, list.iter().map(|n| n.account_id.as_str()));
    let mut first_pop = wants && crate::notifysound::claim();
    if wants && !first_pop {
        crate::startup::line("notify", "sound: skipped (one played less than 3 s ago)");
    }
    let mut chime = || if std::mem::take(&mut first_pop) { "pop" } else { "none" };
    if list.len() > 3 {
        toast_logged(app, String::new(), "Hey Look!", &crate::i18n::new_messages(list.len()), "", chime(), &[]);
        return;
    }
    for n in list {
        let (line1, line2) = message_lines(&n.subject, &n.snippet, flag(n, "notifyPreview", true));
        let actions = notify_actions_for(&p, &n.account_id);
        toast_logged(app, n.thread_id.clone(), &crate::snippet::notification_line(&n.from), &line1, &line2, chime(), &actions);
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
    let actions = notify_actions(&p);
    for (tid, subject, who, snippet) in due {
        let _ = lock(db).execute("UPDATE thread_meta SET snoozed_until=NULL WHERE thread_id=?1", [&tid]);
        let _ = action_impl(db, vec![tid.clone()], "unread".into(), None, None);
        if !quiet {
            let (line1, line2) = message_lines(&subject, &snippet, true);
            // (W13.8) mail that comes back from a snooze is new mail: it plays the sound like any other (one per round: a few coming back together make one)
            let sound = if crate::notifysound::on_for(&p, "") && crate::notifysound::claim() { "pop" } else { "none" };
            toast_logged(app, tid, &crate::snippet::notification_line(&crate::i18n::snooze_ended(who.trim())), &line1, &line2, sound, &actions);
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
    // (W13.8) a calendar reminder keeps today's sound (the system's) and is silent when the switch is off
    toast_logged(app, String::new(), title, line, "", if crate::notifysound::on_for(&p, "") { "reminder" } else { "none" }, &[]);
}

/// Body of the one-time "still running" notice, per OS.
fn tray_hint_text(os: &str) -> &'static str {
    crate::i18n::tray_hint(os)
}

/// macOS: the facts the permission rules need: the number of accounts, whether desktop notifications are on for at least one mailbox, and whether the Dock badge is not "None"
/// (REQ-5.10.2). The "all mailboxes" switch and the per-mailbox override are read the way `notify_new` reads them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_notify_flags(db: &Db) -> (usize, bool, bool) {
    let ids: Vec<String> = db::list_accounts(&lock(db)).map(|a| a.into_iter().map(|x| x.id).collect()).unwrap_or_default();
    let (notify, dock) = mac_notify_reasons(&prefs(db), &ids);
    (ids.len(), notify, dock)
}

/// (notifications on for some mailbox, Dock badge on) for these preferences. Pure.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_notify_reasons(p: &Value, account_ids: &[String]) -> (bool, bool) {
    let notify = pbool(p, "notifications", true) && account_ids.iter().any(|id| eff(p, id, "notifications").and_then(|v| v.as_bool()).unwrap_or(true));
    (notify, badge_styles(p).1 == "number")
}

/// Whether a change of the preferences turned notifications or the Dock badge on (REQ-5.10.2 c). Pure.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn turned_on(before: (bool, bool), after: (bool, bool)) -> bool {
    (after.0 && !before.0) || (after.1 && !before.1)
}

/// macOS: the answer of "ask for permission" for a start / first account (REQ-5.10.2 a). Runs on a thread of its own (the system dialog blocks until the person answers) and
/// stops asking once macOS has an answer; called at start and every sync round, so an account added later is covered.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_notify_start(db: &Db) {
    use crate::macnotify::{ensure, State, Trigger};
    static SETTLED: AtomicBool = AtomicBool::new(false);
    static BUSY: AtomicBool = AtomicBool::new(false);
    if SETTLED.load(Ordering::Relaxed) || BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    let db = db.clone();
    std::thread::spawn(move || {
        let (accounts, notify, dock) = mac_notify_flags(&db);
        if ensure(Trigger::Start, accounts, notify, dock) != State::Undetermined {
            SETTLED.store(true, Ordering::Relaxed);
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

/// macOS: notifications or the Dock badge were turned on in Settings: ask now if macOS was never asked (REQ-5.10.2 c).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_notify_setting_on(db: &Db) {
    let db = db.clone();
    std::thread::spawn(move || {
        let (accounts, notify, dock) = mac_notify_flags(&db);
        crate::macnotify::ensure(crate::macnotify::Trigger::SettingOn, accounts, notify, dock);
    });
}

/// macOS: the main window gained focus: read the state again (a change made in System Settings shows without a restart; the log gets a line when it changed).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_notify_focus() {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        crate::macnotify::read();
        BUSY.store(false, Ordering::SeqCst);
    });
}

/// The command `notify_permission`: the state macOS reports for this app (`unsupported` anywhere else). `ask` (the "Send test" button) asks first while macOS was never asked.
pub fn notify_permission(db: &Db, ask: bool) -> crate::macnotify::State {
    if ask {
        let (accounts, notify, dock) = mac_notify_flags(db);
        crate::macnotify::ensure(crate::macnotify::Trigger::SendTest, accounts, notify, dock)
    } else {
        crate::macnotify::read()
    }
}

pub fn test_notification(app: &AppHandle, db: &Db) -> Result<(), String> {
    // macOS: macOS is asked for permission first when it never was (REQ-5.10.5); with the permission turned off nothing is sent (the page shows the note)
    #[cfg(target_os = "macos")]
    {
        let (accounts, notify, dock) = mac_notify_flags(db);
        if crate::macnotify::ensure(crate::macnotify::Trigger::SendTest, accounts, notify, dock) == crate::macnotify::State::Denied {
            crate::startup::line("notify", "macos: send test skipped (notifications are turned off in macOS)");
            return Ok(());
        }
    }
    // Linux (W5.6): ask the bus first; no notification service and none that can be started is the answer at once, not after the 5 s wait
    #[cfg(target_os = "linux")]
    if crate::linuxnotify::send_test_plan() == crate::linuxnotify::ServicePlan::FailNow {
        return Err(NO_NOTIFICATION_SERVICE.into());
    }
    let p = prefs(db);
    toast(
        app,
        String::new(),
        crate::i18n::tr(crate::i18n::K::TestTitle),
        crate::i18n::tr(crate::i18n::K::TestLine1),
        crate::i18n::tr(crate::i18n::K::TestLine2),
        if crate::notifysound::on_for(&p, "") { "pop" } else { "none" },
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
    /// W5.7 + W5.11: the app menu has exactly the agreed items, Show All stays (Apple's standard menu has it; it only un-hides other apps) and Settings… follows About.
    #[test]
    fn the_mac_app_menu_has_exactly_the_agreed_items() {
        use crate::i18n::K;
        let plan = app_menu_plan();
        let items: Vec<K> = plan.iter().filter_map(|e| if let AppMenuEntry::Item(k) = e { Some(*k) } else { None }).collect();
        assert_eq!(items, [K::MacAbout, K::MacSettings, K::MacServices, K::MacHide, K::MacHideOthers, K::MacShowAll, K::MacQuit], "seven items, in this order");
        assert_eq!(plan.iter().filter(|e| **e == AppMenuEntry::Separator).count(), 4, "four separators");
        // About, separator, Settings…, separator, Services, separator, Hide, Hide Others, Show All, separator, Quit
        for at in [1, 3, 5, 9] {
            assert_eq!(plan[at], AppMenuEntry::Separator, "separator at {at}");
        }
        assert_eq!(plan.len(), 11);
        // what builds it: the localisation inserts Show All right under Hide Others when tauri's menu has none, and the Quit item is ours; the six texts are in every language
        let src = crate::test_guard::non_test_code(include_str!("shell.rs"));
        let localize = &src[src.find("fn localize_app_menu(").unwrap()..];
        let localize = &localize[..localize.find("
}
").unwrap()];
        assert!(localize.contains("PredefinedMenuItem::show_all(app, Some(tr(K::MacShowAll)))") && localize.contains("app_menu.insert(&show, at + 1)") && localize.contains("K::MacHideOthers"), "Show All under Hide Others: {localize}");
        assert!(src.contains("MAC_QUIT_ID, crate::i18n::tr(crate::i18n::K::MacQuit)"), "our Quit item");
        // Settings… with Cmd+, goes in at 2 (after About and its separator) with a separator of its own at 3
        let settings = &src[src.find("fn add_settings_item(").unwrap()..];
        let settings = &settings[..settings.find("
}
").unwrap()];
        assert!(settings.contains("MAC_SETTINGS_ID, crate::i18n::tr(crate::i18n::K::MacSettings), true, Some(\"CmdOrCtrl+,\")") && settings.contains("app_menu.insert(&ours, 2)") && settings.contains("app_menu.insert(&sep, 3)"), "{settings}");
        // (the texts of the six keys exist in every language: the i18n tests check every key; here, that the menu uses these six)
        for k in items {
            assert!(!crate::i18n::tr(k).is_empty());
        }
    }

    #[test]
    fn the_app_menu_follows_the_language_change() {
        let src = crate::test_guard::non_test_code(include_str!("shell.rs"));
        let src = &src[..];
        assert!(src.contains("localize_app_menu(app, &menu)"), "mac_app_menu does not translate the app menu");
        let refresh = &src[src.find("pub fn refresh_language").unwrap()..];
        let refresh = &refresh[..refresh.find("
}
").unwrap()];
        assert!(refresh.contains("MAC_MENU_ITEMS") && refresh.contains("MAC_QUIT_ITEM") && refresh.contains("MAC_PASTE_MATCH_ITEM"), "{refresh}");
        // Paste and Match Style (AC-2.24.1): added to the Edit menu with Cmd+Option+Shift+V, and the menu event reaches the focused window as `mac-paste-match`
        assert!(src.contains("add_paste_match_item(app, &menu)") && src.contains("\"CmdOrCtrl+Alt+Shift+V\""), "the Edit menu item is not added");
        assert!(src.contains("emit_to(label.as_str(), \"mac-paste-match\""), "the menu event does not reach the window");
    }

    /// W5.11 (REQ-5.11.2): File > Print… is on only while the window that has the focus is the main window or a reader window that said it shows a printable message.
    #[test]
    fn print_follows_the_focused_window_that_can_print() {
        let mut can: HashMap<String, bool> = HashMap::new();
        assert!(!print_enabled(None, &can) && !print_enabled(Some("main"), &can), "nothing reported: off");
        for label in ["main", "reader-3", "compose-1", "settings-1", "search-1", "scheduled-1", "event-1"] {
            can.insert(label.to_string(), true);
        }
        assert!(print_enabled(Some("main"), &can) && print_enabled(Some("reader-3"), &can));
        assert!(!print_enabled(Some("reader-4"), &can), "a reader window that said nothing");
        for label in ["compose-1", "settings-1", "search-1", "scheduled-1", "event-1", "print-view"] {
            assert!(!print_enabled(Some(label), &can), "{label} never prints, whatever it says");
        }
        assert!(!print_enabled(None, &can), "no window has the focus");
        can.insert("main".to_string(), false);
        assert!(!print_enabled(Some("main"), &can), "an open mail that is Confidential or gone: off");
    }

    /// W5.11: how the menu bar is built and what the items do (the macOS code cannot be compiled here: this reads the sources).
    #[test]
    fn the_menu_bar_items_of_w5_11_are_wired() {
        let src = crate::test_guard::non_test_code(include_str!("shell.rs"));
        let body = |name: &str| {
            let at = src.find(name).unwrap_or_else(|| panic!("{name}"));
            let rest = &src[at..];
            rest[..rest.find("
}
").unwrap()].to_string()
        };
        // File > Print…: Cmd+P, after Close Window behind a separator, off until a page says it can
        let print = body("fn add_print_item(");
        assert!(print.contains("MAC_PRINT_ID, crate::i18n::tr(crate::i18n::K::MacPrint), false, Some(\"CmdOrCtrl+P\")"), "{print}");
        assert!(print.contains("!= \"File\"") && print.find("file.append(&PredefinedMenuItem::separator").unwrap() < print.find("file.append(&ours)").unwrap(), "{print}");
        // Help > Hey Look! Help: in the Help menu tauri registers with the system (the search field stays)
        let help = body("fn add_help_item(");
        assert!(help.contains("tauri::menu::HELP_SUBMENU_ID") && help.contains("MAC_HELP_ID, crate::i18n::tr(crate::i18n::K::MacHelp)"), "{help}");
        // the menu event: Settings shows the main window first, then tells it; Print tells the focused window that can print; Help tells the focused main / reader window (else main)
        let event = body("pub fn mac_menu_event(");
        let settings = &event[event.find("MAC_SETTINGS_ID").unwrap()..];
        assert!(settings.find("show_main(app)").unwrap() < settings.find("emit_to(\"main\", \"mac-open-settings\"").unwrap(), "{event}");
        assert!(event.contains("print_enabled(Some(l), &st.can)") && event.contains("emit_to(label.as_str(), \"mac-print\"") && event.contains("emit_to(label.as_str(), \"mac-help\""), "{event}");
        // the three items follow a language switch, and the windows decide the Print item
        let refresh = body("pub fn refresh_language(");
        for item in ["MAC_SETTINGS_ITEM", "MAC_PRINT_ITEM", "MAC_HELP_ITEM"] {
            assert!(refresh.contains(item), "{item} does not follow the language");
        }
        for call in ["add_settings_item(app, &menu)", "add_print_item(app, &menu)", "add_help_item(app, &menu)"] {
            assert!(src.contains(call), "{call}");
        }
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let at = lib.find(".on_window_event(|window, event| {").expect("window event handler");
        let handler = &lib[at..];
        assert!(handler.find("shell::menu_window_event(window, event)").unwrap() < handler.find("if window.label() != \"main\"").unwrap(), "every window, not only main, reaches the menu state");
        // the command answers for the window that calls it, and the item is switched on the main thread
        assert!(lib.contains("shell::note_can_print(&app, window.label(), can_print)"), "a page speaks for itself only");
        assert!(body("pub fn note_can_print(").contains("run_on_main_thread(apply_print_item)"));
        // no manual release of anything in the menu code (DEC-024: the frameworks own their objects)
        for word in ["autorelease", "CFRelease", "objc_release", ".release()", "msg_send"] {
            assert!(!src.contains(word), "shell.rs must not use {word}");
        }
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
    fn the_macos_permission_reasons_are_notifications_on_for_some_mailbox_and_the_dock_badge() {
        let ids = vec!["a".to_string(), "b".to_string()];
        let p = |j: &str| serde_json::from_str::<Value>(j).unwrap();
        assert_eq!(mac_notify_reasons(&Value::Null, &ids), (true, true), "defaults: notifications on, the Dock badge shows the number");
        assert_eq!(mac_notify_reasons(&Value::Null, &[]), (false, true), "no mailbox, nothing to notify about");
        assert_eq!(mac_notify_reasons(&p(r#"{"notifications":false}"#), &ids), (false, true), "the all-mailboxes switch is off");
        assert_eq!(mac_notify_reasons(&p(r#"{"accountPrefs":{"a":{"notifications":false}}}"#), &ids), (true, true), "one mailbox is enough");
        assert_eq!(mac_notify_reasons(&p(r#"{"accountPrefs":{"a":{"notifications":false},"b":{"notifications":false}}}"#), &ids), (false, true));
        assert_eq!(mac_notify_reasons(&p(r#"{"taskbarBadge":"off"}"#), &ids), (true, false));
        assert_eq!(mac_notify_reasons(&p(r#"{"showUnreadCount":false}"#), &ids), (true, false), "the older switch counts too");
        // turning one on asks; turning one off or changing something else does not
        assert!(turned_on((false, true), (true, true)));
        assert!(turned_on((true, false), (true, true)));
        assert!(turned_on((false, false), (false, true)));
        assert!(!turned_on((true, true), (false, true)));
        assert!(!turned_on((true, true), (true, true)));
        assert!(!turned_on((true, false), (true, false)));
    }

    /// W5.10: the callers of the permission flow. The sources are read like the quit tests do (the Objective-C code is macOS-only).
    #[test]
    fn the_macos_permission_is_asked_at_the_agreed_moments_and_the_old_unavailable_answer_is_gone() {
        let shell = crate::test_guard::non_test_code(include_str!("shell.rs"));
        let send = &shell[shell.find("pub fn test_notification(").unwrap()..];
        let send = &send[..send.find("
}
").unwrap()];
        assert!(send.contains("Trigger::SendTest") && send.contains("State::Denied"), "Send test asks, and sends nothing when macOS refuses: {send}");
        assert!(!shell.contains(concat!("NOTIFY_MAC", "_UNAVAILABLE")));
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(lib.contains("shell::mac_notify_start(&db)"), "start and every sync round");
        assert!(lib.contains("shell::mac_notify_focus()"), "the main window gaining focus reads the state again");
        assert!(lib.contains("shell::turned_on(before"), "turning notifications or the Dock badge on asks");
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
        let toast = &src[src.find("fn toast(app: &AppHandle, thread: String").unwrap()..];
        let linux = toast.find("toast_linux(").unwrap();
        let plugin = toast.find(concat!("builder", "()")).unwrap();
        assert!(linux < plugin, "the Linux branch comes first and returns");
        let body = &src[src.find("fn toast_linux").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains(".show()") && body.contains("recv_timeout") && !body.contains("NotificationExt"), "{body}");
    }
}

#[cfg(test)]
mod unread_count_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Two unread conversations in the Inbox, one of them bulk (a List-Unsubscribe header).
    fn db_with_two() -> Db {
        let c = db::test_conn(&["a1"]);
        for (i, unsub) in [None, Some("<mailto:u@example.test>")].into_iter().enumerate() {
            c.execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,seen,list_unsub)
                 VALUES(?1,'a1','inbox',?2,?3,'s','n','x@example.com','','',?2,'',0,?4)",
                rusqlite::params![format!("m{i}"), i as i64 + 1, format!("t{i}"), unsub],
            )
            .unwrap();
        }
        Arc::new(Mutex::new(c))
    }

    #[test]
    fn unread_count_counts_bulk_when_the_setting_is_missing() {
        let db = db_with_two();
        assert_eq!(unread_count(&db), 2, "no preferences stored: bulk mail counts");
        db::set_setting(&lock(&db), "prefs", r#"{"countOtherMail":false}"#).unwrap();
        assert_eq!(unread_count(&db), 1);
        db::set_setting(&lock(&db), "prefs", r#"{"focused":false,"countOtherMail":false}"#).unwrap();
        assert_eq!(unread_count(&db), 2, "without Focused Inbox bulk mail always counts");
        db::set_setting(&lock(&db), "prefs", r#"{"countOtherMail":true}"#).unwrap();
        assert_eq!(unread_count(&db), 2);
        db::set_setting(&lock(&db), "prefs", "{oops").unwrap();
        assert_eq!(unread_count(&db), 2, "damaged preferences: the defaults");
    }
}
