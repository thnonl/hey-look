//! Linux follows the desktop's light or dark setting (1.0.7 W5.2).
//!
//! With the theme "System" the app stayed light under Plasma's Breeze Dark (1.0.6, F-10), although tao reads the desktop portal itself: WebKitGTK's
//! `prefers-color-scheme` does not reliably follow the GTK setting that tao sets, tao's "no preference" is light, and the release step of `wintheme`
//! turned GTK light again after a theme had been pinned once. So the app asks the desktop itself and tells everyone the same answer: the pages (command
//! `os_color_scheme`, event `os-color-scheme`: they set the theme on their root element, src/osTheme.ts) and GTK (`wintheme::apply_all` pins the resolved
//! theme on every window, so the native parts, GNOME's header bar, scroll bars, `<select>` popups and file dialogs, match).
//!
//! Where the answer comes from, in this order (REQ-5.2.1, 5.2.2):
//!   1. the desktop portal: `org.freedesktop.portal.Settings.ReadOne("org.freedesktop.appearance", "color-scheme")` (`Read` where `ReadOne` does not exist: the
//!      value is wrapped in a second variant), 1 = dark, 2 = light, 0 or no answer = no preference; and the signal `SettingChanged` for that key for the whole run;
//!   2. the GTK settings: `GTK_THEME` ending in `:dark`, else `$XDG_CONFIG_HOME/gtk-3.0/settings.ini` (`gtk-application-prefer-dark-theme` = 1 / true, or
//!      `gtk-theme-name` ending in `-dark` / `-Dark` / `:dark`), else light. No live change there (the log says so).
//! No portal and no hint: light, no error shown (REQ-5.2.7). The decisions are pure functions (tested everywhere); only the D-Bus calls are Linux-only.
use serde::Serialize;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// Where the current answer came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Portal,
    GtkSettings,
    Default,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Portal => "portal",
            Source::GtkSettings => "gtk-settings",
            Source::Default => "default",
        }
    }
}

/// The desktop's scheme, and the words for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scheme {
    pub dark: bool,
    pub source: Source,
    pub note: String,
}

impl Scheme {
    /// `dark (portal color-scheme 1)`.
    pub fn log_line(&self) -> String {
        format!("{} ({})", if self.dark { "dark" } else { "light" }, self.note)
    }
}

/// What the portal's `color-scheme` value says: 1 = dark, 2 = light, 0 (no preference), anything else and no answer = `None` (the fallback decides).
pub fn from_portal(value: Option<u32>) -> Option<bool> {
    match value {
        Some(1) => Some(true),
        Some(2) => Some(false),
        _ => None,
    }
}

/// The GTK hints, as far as they say dark: `GTK_THEME` (`Adwaita:dark`), then `settings.ini` (`[Settings]` `gtk-application-prefer-dark-theme` = 1 / true, or a
/// `gtk-theme-name` that ends in `-dark`, `-Dark` or `:dark`). `None` when none of them says dark (the answer is then light, not "unknown"). Pure.
pub fn dark_from_gtk(gtk_theme_env: Option<&str>, settings_ini: Option<&str>) -> Option<&'static str> {
    if gtk_theme_env.is_some_and(|t| t.trim().to_ascii_lowercase().ends_with(":dark")) {
        return Some("GTK_THEME ends in :dark");
    }
    let ini = settings_ini?;
    let mut in_settings = false;
    let mut theme_name_dark = false;
    for line in ini.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_settings = line.eq_ignore_ascii_case("[Settings]");
            continue;
        }
        if !in_settings || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim().to_ascii_lowercase(), value.trim());
        if key == "gtk-application-prefer-dark-theme" && (value == "1" || value.eq_ignore_ascii_case("true")) {
            return Some("settings.ini: gtk-application-prefer-dark-theme");
        }
        if key == "gtk-theme-name" {
            let v = value.trim_matches('"');
            theme_name_dark = v.ends_with("-dark") || v.ends_with("-Dark") || v.to_ascii_lowercase().ends_with(":dark");
        }
    }
    theme_name_dark.then_some("settings.ini: gtk-theme-name")
}

/// The answer: the portal's value when it has one, else the GTK hints, else light.
pub fn resolve(portal: Option<u32>, gtk_theme_env: Option<&str>, settings_ini: Option<&str>) -> Scheme {
    if let Some(dark) = from_portal(portal) {
        return Scheme { dark, source: Source::Portal, note: format!("portal color-scheme {}", portal.unwrap_or(0)) };
    }
    match dark_from_gtk(gtk_theme_env, settings_ini) {
        Some(why) => Scheme { dark: true, source: Source::GtkSettings, note: format!("{why}; the portal said {}; no live change in this mode", portal.map_or("nothing".to_string(), |v| v.to_string())) },
        None => {
            let source = if gtk_theme_env.is_some() || settings_ini.is_some() { Source::GtkSettings } else { Source::Default };
            Scheme { dark: false, source, note: format!("no dark hint; the portal said {}; no live change in this mode", portal.map_or("nothing".to_string(), |v| v.to_string())) }
        }
    }
}

/// `$XDG_CONFIG_HOME/gtk-3.0/settings.ini` (default `~/.config`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn settings_ini_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))?;
    Some(base.join("gtk-3.0").join("settings.ini"))
}

/// The state: the last answer, and a condition for the page's first ask to wait for it.
static STATE: Mutex<Option<Scheme>> = Mutex::new(None);
static FIRST: Condvar = Condvar::new();

/// The answer now (`None` before the first one, and off Linux).
pub fn current() -> Option<Scheme> {
    STATE.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// What `wintheme` needs: dark or light as the desktop says, `None` when unknown (and always off Linux).
pub fn os_dark_now() -> Option<bool> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    current().map(|s| s.dark)
}

/// What the command answers: the value for a page (`None` = keep using the engine's media query, on Windows and macOS always), and where it came from.
#[derive(Serialize)]
pub struct OsScheme {
    pub dark: Option<bool>,
    pub source: &'static str,
}

/// The command `os_color_scheme`. On Linux it waits up to one second for the first answer (the app is starting), then answers with what there is.
pub fn command_value() -> OsScheme {
    if !cfg!(target_os = "linux") {
        return OsScheme { dark: None, source: "engine" };
    }
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        let (g, _timeout) = FIRST.wait_timeout_while(guard, Duration::from_secs(1), |s| s.is_none()).unwrap_or_else(|p| p.into_inner());
        guard = g;
    }
    match guard.as_ref() {
        Some(s) => OsScheme { dark: Some(s.dark), source: s.source.as_str() },
        None => OsScheme { dark: None, source: "engine" },
    }
}

/// Stores a new answer; returns whether it differs from the one before.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn store(s: Scheme) -> bool {
    let mut g = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let changed = g.as_ref().is_none_or(|old| old.dark != s.dark);
    *g = Some(s);
    FIRST.notify_all();
    changed
}

/// Starts the reading at the start of the app (Linux). The first answer is awaited for 400 ms at most, so the first window is made in the right colour when the desktop
/// answers as usual; a desktop that does not answer in time is followed as soon as it does (the pages and GTK are told then).
#[cfg(target_os = "linux")]
pub fn start(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || run(handle));
    let g = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let _ = FIRST.wait_timeout_while(g, Duration::from_millis(400), |s| s.is_none());
}

#[cfg(not(target_os = "linux"))]
pub fn start(_app: &tauri::AppHandle) {}

#[cfg(target_os = "linux")]
fn run(app: tauri::AppHandle) {
    use tauri::Emitter;
    // the first reading: the portal with a limit of 2 s (a D-Bus call to a portal that hangs would take 25 s), then the GTK hints
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(portal::connect().ok().map(|conn| {
            let v = portal::read(&conn);
            (conn, v)
        }));
    });
    let (conn, value) = match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Some((conn, v))) => (Some(conn), v),
        _ => {
            crate::startup::line("ostheme", "the desktop portal did not answer in 2 s (or there is no session bus): the GTK settings decide");
            (None, None)
        }
    };
    let ini = settings_ini_path().and_then(|p| std::fs::read_to_string(p).ok());
    let scheme = resolve(value, std::env::var("GTK_THEME").ok().as_deref(), ini.as_deref());
    crate::startup::line("ostheme", &scheme.log_line());
    store(scheme.clone());
    // the first answer is applied at once and told to the pages (a window that was made before it came is corrected)
    let _ = app.emit("os-color-scheme", serde_json::json!({ "dark": scheme.dark, "source": scheme.source.as_str() }));
    crate::wintheme::apply_all(&app, "ostheme first reading");
    // the live changes: the portal's signal for the whole run (only where the portal answered)
    let Some(conn) = conn else { return };
    portal::watch(&conn, |v| {
        let Some(dark) = from_portal(v) else { return };
        let next = Scheme { dark, source: Source::Portal, note: format!("portal color-scheme {}", v.unwrap_or(0)) };
        crate::startup::line("ostheme", &next.log_line());
        if store(next) {
            let _ = app.emit("os-color-scheme", serde_json::json!({ "dark": dark, "source": "portal" }));
            crate::wintheme::on_os_theme_changed(&app, "portal color-scheme");
        }
    });
}

/// The D-Bus side (zbus, blocking; already a dependency for the tray check).
#[cfg(target_os = "linux")]
mod portal {
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{OwnedValue, Value};

    const DEST: &str = "org.freedesktop.portal.Desktop";
    const PATH: &str = "/org/freedesktop/portal/desktop";
    const IFACE: &str = "org.freedesktop.portal.Settings";
    const NAMESPACE: &str = "org.freedesktop.appearance";
    const KEY: &str = "color-scheme";

    pub fn connect() -> zbus::Result<Connection> {
        Connection::session()
    }

    /// The number inside a variant, also when it is wrapped in a second variant (the answer of `Read`).
    fn number(v: &Value<'_>) -> Option<u32> {
        match v {
            Value::U32(n) => Some(*n),
            Value::Value(inner) => number(inner),
            _ => None,
        }
    }

    /// `ReadOne` (portal version 2), else `Read`; `None` when the portal does not answer or answers with something that is not a number.
    pub fn read(conn: &Connection) -> Option<u32> {
        let proxy = Proxy::new(conn, DEST, PATH, IFACE).ok()?;
        if let Ok(v) = proxy.call::<_, _, OwnedValue>("ReadOne", &(NAMESPACE, KEY)) {
            return number(&v);
        }
        let v: OwnedValue = proxy.call("Read", &(NAMESPACE, KEY)).ok()?;
        number(&v)
    }

    /// Blocks for the rest of the run and calls `on_change` with each new value of the key.
    pub fn watch(conn: &Connection, on_change: impl Fn(Option<u32>)) {
        let Ok(proxy) = Proxy::new(conn, DEST, PATH, IFACE) else { return };
        let Ok(signals) = proxy.receive_signal("SettingChanged") else { return };
        for msg in signals {
            let Ok((ns, key, value)) = msg.body().deserialize::<(String, String, OwnedValue)>() else { continue };
            if ns == NAMESPACE && key == KEY {
                on_change(number(&value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_portal_value_and_the_gtk_settings_give_the_os_scheme() {
        // the portal: 1 dark, 2 light, 0 and no answer = no preference
        assert_eq!(from_portal(Some(1)), Some(true));
        assert_eq!(from_portal(Some(2)), Some(false));
        assert_eq!(from_portal(Some(0)), None);
        assert_eq!(from_portal(Some(7)), None);
        assert_eq!(from_portal(None), None);
        let r = resolve(Some(1), None, None);
        assert_eq!((r.dark, r.source), (true, Source::Portal));
        assert_eq!(r.log_line(), "dark (portal color-scheme 1)");
        let r = resolve(Some(2), Some("Adwaita:dark"), Some("[Settings]\ngtk-application-prefer-dark-theme=1\n"));
        assert_eq!((r.dark, r.source), (false, Source::Portal), "the portal wins over the hints, light too");
        // no preference / no portal: GTK_THEME first
        for env in ["Adwaita:dark", "Breeze:dark", " Adwaita:Dark ", "adwaita:DARK"] {
            let r = resolve(Some(0), Some(env), None);
            assert_eq!((r.dark, r.source), (true, Source::GtkSettings), "{env}");
            assert!(resolve(None, Some(env), None).dark, "{env} without a portal");
        }
        assert!(!resolve(None, Some("Adwaita"), None).dark);
        assert!(!resolve(None, Some("Adwaita:light"), None).dark);
        // settings.ini
        let ini = |body: &str| format!("[Settings]\n{body}\n");
        for dark in ["gtk-application-prefer-dark-theme=1", "gtk-application-prefer-dark-theme = true", "Gtk-Application-Prefer-Dark-Theme=TRUE", "gtk-theme-name=Breeze-Dark", "gtk-theme-name=\"Adwaita-dark\"", "gtk-theme-name=Adwaita:dark"] {
            let r = resolve(None, None, Some(&ini(dark)));
            assert_eq!((r.dark, r.source), (true, Source::GtkSettings), "{dark}");
        }
        for light in ["gtk-application-prefer-dark-theme=0", "gtk-application-prefer-dark-theme=false", "gtk-theme-name=Breeze", "gtk-theme-name=Adwaita", "gtk-font-name=Sans 10"] {
            let r = resolve(None, None, Some(&ini(light)));
            assert!(!r.dark, "{light}");
        }
        // a key outside [Settings] does not count; comments do not count
        assert!(!resolve(None, None, Some("[Other]\ngtk-application-prefer-dark-theme=1\n")).dark);
        assert!(!resolve(None, None, Some("[Settings]\n# gtk-application-prefer-dark-theme=1\n; gtk-application-prefer-dark-theme=1\n")).dark);
        // neither: light, from the default; a file that says nothing: light from the settings (no error either way)
        let r = resolve(None, None, None);
        assert_eq!((r.dark, r.source), (false, Source::Default));
        assert!(r.note.contains("no dark hint") && r.note.contains("no live change"), "the log says that there is no live change: {}", r.note);
        assert_eq!(resolve(None, None, Some("[Settings]\n")).source, Source::GtkSettings);
    }

    #[test]
    fn off_linux_nothing_is_known_and_the_engine_decides() {
        if cfg!(target_os = "linux") {
            return;
        }
        assert_eq!(os_dark_now(), None);
        let v = command_value();
        assert_eq!((v.dark, v.source), (None, "engine"));
    }

    #[test]
    fn the_reading_has_the_limits_and_the_sources_of_the_spec() {
        let src = crate::test_guard::non_test_code(include_str!("linuxtheme.rs"));
        assert!(src.contains("\"ReadOne\"") && src.contains("\"Read\"") && src.contains("\"SettingChanged\""), "ReadOne, then Read, and the signal");
        assert!(src.contains("org.freedesktop.appearance") && src.contains("org.freedesktop.portal.Desktop") && src.contains("/org/freedesktop/portal/desktop"));
        assert!(src.contains("Duration::from_secs(2)"), "the portal gets 2 s");
        assert!(src.contains("crate::wintheme::apply_all") && src.contains("crate::wintheme::on_os_theme_changed(&app, \"portal color-scheme\")"));
        assert!(src.contains("app.emit(\"os-color-scheme\""), "the pages are told");
    }
}
