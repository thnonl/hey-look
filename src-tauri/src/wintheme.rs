//! The theme of the native frame (title bar) of every window, main, compose and reader.
//!
//! One function, [`apply_all`], tells every open window what the app theme setting asks of its frame. It is called from three places and
//! nowhere else: when a window is created (`popout::create`; the main window at start-up in lib.rs `setup`), when the `prefs` blob is written
//! (`set_setting`), and when the OS theme changes (`WindowEvent::ThemeChanged` of any window, see [`on_os_theme_changed`]).
//!
//! The rule: "light" and "dark" pin the frame to that theme; "system" (and anything else, an unreadable blob, no blob yet) pins nothing: the
//! windows are told `None` = follow the OS. A theme is never fixed at creation: the window builder is not given one.
//!
//! Why on macOS the native part does more (Mac QA 1.0.6, a compose pop-out created in Dark mode kept a black title bar after the OS went to
//! Light, with the app theme on System, while the main window and other pop-outs followed): tao's `set_theme` on macOS sets the appearance of the
//! whole application (`NSApp`), not of the window, and only the page of a pop-out used to call it, once, when the window opened. So nothing
//! looked at a window again when the OS changed, and nothing could reach an `NSWindow` whose own appearance or cached frame drawing had not
//! followed. Here every `NSWindow` gets its appearance set (an explicit one for light / dark, and for System first the one the application
//! shows now and then `nil`, which makes the window resolve its appearance again) and its frame redrawn.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Theme};

/// What the preferences ask of the frame: `Some` for "light" / "dark", `None` ("follow the OS") for "system" and for anything else.
pub fn choice_of(prefs: Option<&str>) -> Option<Theme> {
    let v: serde_json::Value = serde_json::from_str(prefs?).ok()?;
    match v.get("theme").and_then(|t| t.as_str()) {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    }
}

/// What is said to the windowing library for a window: pin a theme, give the choice back to the OS, or nothing (the library keeps its own
/// default, which is the OS).
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Step {
    Pin(Theme),
    Release,
    Nothing,
}

/// `was_pinned`: a window was pinned to a theme earlier in this run. `always_release`: tell `None` even when nothing was pinned (macOS: the
/// application appearance is reset every time, see the module text).
pub fn step(choice: Option<Theme>, was_pinned: bool, always_release: bool) -> Step {
    match choice {
        Some(t) => Step::Pin(t),
        None if was_pinned || always_release => Step::Release,
        None => Step::Nothing,
    }
}

fn pinned() -> &'static AtomicBool {
    static PINNED: AtomicBool = AtomicBool::new(false);
    &PINNED
}

fn last_apply() -> &'static Mutex<Option<Instant>> {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    &LAST
}

/// The theme the stored preferences ask of the frame (`None` = follow the OS).
fn choice(app: &AppHandle) -> Option<Theme> {
    let st = app.try_state::<crate::AppState>()?;
    let db = st.db.clone();
    let raw = crate::db::get_setting(&crate::lock(&db), "prefs");
    choice_of(raw.as_deref())
}

/// Apply the current theme choice to every open window (visible, hidden or parked). Safe to call from any thread, as often as needed.
pub fn apply_all(app: &AppHandle) {
    *last_apply().lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    let choice = choice(app);
    let was_pinned = match choice {
        Some(_) => pinned().swap(true, Ordering::SeqCst),
        None => pinned().swap(false, Ordering::SeqCst),
    };
    let step = step(choice, was_pinned, cfg!(target_os = "macos"));
    for (_, w) in app.webview_windows() {
        match step {
            Step::Pin(t) => {
                let _ = w.set_theme(Some(t));
            }
            Step::Release => {
                let _ = w.set_theme(None);
            }
            Step::Nothing => {}
        }
    }
    native(app, choice);
}

/// The OS theme changed (any window reports it). Only a System setting follows the OS; an explicit one stays as it is.
pub fn on_os_theme_changed(app: &AppHandle) {
    static SCHEDULED: AtomicBool = AtomicBool::new(false);
    if choice(app).is_some() {
        return;
    }
    // the answer of a theme change that our own call caused (some platforms report one) is not a change of the OS
    if last_apply().lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|t| t.elapsed() < Duration::from_millis(400)) {
        return;
    }
    // every window reports the same change; and the system says what its theme is a moment after it said that it changed
    if SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        SCHEDULED.store(false, Ordering::SeqCst);
        apply_all(&app);
    });
}

/// macOS: the appearance of every `NSWindow` itself (main thread), see the module text.
#[cfg(target_os = "macos")]
fn native(app: &AppHandle, choice: Option<Theme>) {
    let dark = choice.map(|t| t == Theme::Dark);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (_, w) in handle.webview_windows() {
            if let Ok(p) = w.ns_window() {
                crate::macwin::set_appearance(p, dark);
            }
        }
    });
}
#[cfg(not(target_os = "macos"))]
fn native(_app: &AppHandle, _choice: Option<Theme>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setting_decides_what_the_frame_is_told() {
        assert_eq!(choice_of(Some(r#"{"theme":"dark"}"#)), Some(Theme::Dark));
        assert_eq!(choice_of(Some(r#"{"theme":"light","density":"x"}"#)), Some(Theme::Light));
        // "system" and everything that is not a theme follow the OS: nothing is pinned
        for none in [Some(r#"{"theme":"system"}"#), Some(r#"{}"#), Some(r#"{"theme":7}"#), Some(r#"{"theme":"Dark"}"#), Some("not json"), Some(""), None] {
            assert_eq!(choice_of(none), None, "{none:?}");
        }
    }

    #[test]
    fn system_never_pins_and_gives_a_pinned_window_back_to_the_os() {
        assert_eq!(step(Some(Theme::Dark), false, false), Step::Pin(Theme::Dark));
        assert_eq!(step(Some(Theme::Light), true, true), Step::Pin(Theme::Light));
        // Dark -> System: the windows that were pinned are released (None = follow the system)
        assert_eq!(step(None, true, false), Step::Release);
        // System from the start: nothing to take back where the library already follows the OS ...
        assert_eq!(step(None, false, false), Step::Nothing);
        // ... but on macOS the application appearance is reset each time
        assert_eq!(step(None, false, true), Step::Release);
        assert!(!matches!(step(None, true, true), Step::Pin(_)));
    }

    /// Every way a window comes to be, and every reason its frame has to change, goes through `apply_all`: the guards below fail when a
    /// new path is added without it, or when a page (or another file) fixes a theme by itself.
    #[test]
    fn every_window_path_goes_through_the_one_function() {
        let code = |s: &str| crate::test_guard::non_test_code(s);
        let lib = code(include_str!("lib.rs"));
        let pop = code(include_str!("popout.rs"));
        // creation: a secondary window (inside `create`, after the build) and the main window (start-up)
        let create = &pop[pop.find("fn create(").unwrap()..];
        let create = &create[..create.find("\n}\n").unwrap()];
        assert!(create.find("b.build()").unwrap() < create.find("crate::wintheme::apply_all(app)").expect("create applies the theme"), "{create}");
        assert!(!create.contains(".theme("), "a theme is never fixed at creation: {create}");
        let setup = &lib[lib.find(".setup(|app|").unwrap()..lib.find(".on_window_event(").unwrap()];
        assert!(setup.contains("wintheme::apply_all(app.handle())"), "the main window gets its theme at start-up");
        // the setting changes
        let set = &lib[lib.find("fn set_setting(").unwrap()..];
        let set = &set[..set.find("\n}\n").unwrap()];
        assert!(set.contains("if key == \"prefs\" {") && set.contains("wintheme::apply_all(&app)"), "{set}");
        // the OS changes: any window, before the label is looked at
        let ev = &lib[lib.find(".on_window_event(").unwrap()..lib.find(".invoke_handler").unwrap()];
        let theme = ev.find("tauri::WindowEvent::ThemeChanged").expect("the OS theme event is handled");
        assert!(theme < ev.find("window.label() != \"main\"").unwrap() && ev.contains("wintheme::on_os_theme_changed(window.app_handle())"), "{ev}");
        // nothing else sets a window theme or builds a window with one: the native calls are in this file (and macwin.rs) only
        for (name, src) in [("lib.rs", &lib), ("popout.rs", &pop)] {
            assert!(!src.contains(".set_theme(") && !src.contains(".theme(Some"), "{name} sets a theme by itself");
        }
        let me = code(include_str!("wintheme.rs"));
        assert_eq!(me.matches(".set_theme(").count(), 2, "Pin and Release are the only two native calls");
    }

    /// The System setting hands the choice to the OS (`None`), it never turns into a theme.
    #[test]
    fn system_means_follow_the_os() {
        let me = crate::test_guard::non_test_code(include_str!("wintheme.rs"));
        assert!(me.contains("Step::Release => {\n                let _ = w.set_theme(None);"));
        assert!(me.contains("_ => None,"), "an unknown value follows the OS");
        // the page does not choose a theme for its window any more
        let cap = include_str!("../capabilities/popout.json");
        assert!(!cap.contains("allow-set-theme"), "a pop-out page may not fix its own theme");
    }
}
