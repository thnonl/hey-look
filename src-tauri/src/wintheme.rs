//! The theme of the native frame (title bar) of every window, main, compose and reader.
//!
//! One function, [`apply_all`], tells every open window what the app theme setting asks of its frame. It is called when a window is created
//! (`popout::create`; the main window at start-up in lib.rs `setup`), when the `prefs` blob is written (`set_setting`), when the OS theme changes
//! (see [`on_os_theme_changed`]) and by the watchdog on macOS; the page of a pop-out can also ask for its own window to be done again
//! ([`window_theme_refresh`], the second, independent way). Every call writes a line to startup.log (`[wintheme +ms] ...`).
//!
//! The rule: "light" and "dark" pin the frame to that theme; "system" (and anything else, an unreadable blob, no blob yet) pins nothing: the
//! windows are told `None` = follow the OS. A theme is never fixed at creation: the window builder is not given one.
//!
//! macOS (Mac QA 1.0.6, build 0121a65: a compose pop-out kept its title bar through every theme change, in both directions, while
//! the main window and the reader pop-outs followed). tao's `set_theme` sets the appearance of the whole application (`NSApp`), never of an
//! `NSWindow`, so the frame of a window only changes when the window follows `NSApp`; a window that has an appearance of its own (or whose
//! frame is not drawn again) does not. The previous fix called `NSWindow.setAppearance:` for the windows tauri lists, but nothing in the log
//! could tell whether it ran, for which windows, or what AppKit answered. Now, on the main thread, `macwin::apply_appearance` sets the
//! application and every titled window (also those tauri does not list) to the explicit appearance (Dark => DarkAqua, Light => Aqua) or to
//! nil (System), reads back `appearance` and `effectiveAppearance` of each, logs them, and repairs a window that differs (MISMATCH). The OS
//! change is watched three ways: tao's `ThemeChanged`, the system notification itself (`macwin::observe_theme_change`) and a watchdog that looks at
//! every window every few seconds. The page of a pop-out asks for a re-apply whenever it changes its own theme.
//!
//! Third attempt (Mac QA 1.0.6, build 142359b: every property read back right, yet the painted title bar of a compose window never changed): the
//! window's appearance was never the problem. tauri's default title bar style on macOS has a full-size content view, so the web view runs UNDER the
//! title bar and what is painted there comes from the page (WebKit takes the colour from the page background, or from a fixed element at the top
//! edge). The compose page was the only root that was `position: fixed` (App.css `.popout-compose`); that is fixed at the source. What remains here
//! is a documented safety net and an experiment: after every apply the steps of `HEYLOOK_TITLEBAR_MODE` (titlebar.rs, run by [`run_strategy`])
//! are taken and every window is described in the log (`macwin::describe`), so the next Mac log shows what differs between window kinds.
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Theme};

fn log(what: &str) {
    crate::startup::line("wintheme", what);
}

/// What the preferences ask of the frame: `Some` for "light" / "dark", `None` ("follow the OS") for "system" and for anything else.
pub fn choice_of(prefs: Option<&str>) -> Option<Theme> {
    let v: serde_json::Value = serde_json::from_str(prefs?).ok()?;
    match v.get("theme").and_then(|t| t.as_str()) {
        Some("dark") => Some(Theme::Dark),
        Some("light") => Some(Theme::Light),
        _ => None,
    }
}

/// The setting as the log writes it.
pub fn setting_name(choice: Option<Theme>) -> &'static str {
    match choice {
        Some(Theme::Dark) => "dark",
        Some(Theme::Light) => "light",
        _ => "system",
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

/// The windows that get the frame theme: all of them, whatever their label (`main`, `compose-<n>`, `reader-<n>`, anything a later version
/// adds). Sorted, for the log. There is no filter on purpose: the previous fix reached some windows and not others, and a label test is one
/// of the places that could have done it.
pub fn themed_labels(all: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = all.into_iter().collect();
    v.sort();
    v.dedup();
    v
}

/// Is an appearance name a dark one ("NSAppearanceNameDarkAqua", "...VibrantDark", "...AccessibilityHighContrastDarkAqua")? `None` for
/// "nil" and for anything that is not a name.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn dark_from_name(name: &str) -> Option<bool> {
    if !name.starts_with("NSAppearanceName") {
        return None;
    }
    Some(name.contains("Dark"))
}

/// "dark" / "light" / "?" for the log.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn dark_text(dark: Option<bool>) -> &'static str {
    match dark {
        Some(true) => "dark",
        Some(false) => "light",
        None => "?",
    }
}

/// Does a window show what was asked? `dark`: the target (`None` = System: no appearance of its own); `own`: the name of the window's own
/// appearance read back ("nil" = none); `shown`: whether the appearance it shows (`effectiveAppearance`) is dark; `expected`: whether it has
/// to show a dark one (the target, or for System what the application shows). `Some(reason)` when it differs: a MISMATCH.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn judge(dark: Option<bool>, own: &str, shown: Option<bool>, expected: Option<bool>) -> Option<String> {
    match dark {
        Some(d) => {
            let want = if d { "NSAppearanceNameDarkAqua" } else { "NSAppearanceNameAqua" };
            if own != want {
                return Some(format!("its own appearance is {own}, it has to be {want}"));
            }
        }
        None => {
            if own != "nil" {
                return Some(format!("its own appearance is {own}, it has to be nil"));
            }
        }
    }
    match (expected, shown) {
        (Some(e), Some(s)) if e != s => Some(format!("it shows {} but has to show {}", dark_text(Some(s)), dark_text(Some(e)))),
        _ => None,
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

/// What the last apply asked for, for the watchdog: 0 nothing applied yet, 1 system, 2 light, 3 dark.
static TARGET: AtomicU8 = AtomicU8::new(0);

/// The theme the stored preferences ask of the frame (`None` = follow the OS).
fn choice(app: &AppHandle) -> Option<Theme> {
    let st = app.try_state::<crate::AppState>()?;
    let db = st.db.clone();
    let raw = crate::db::get_setting(&crate::lock(&db), "prefs");
    choice_of(raw.as_deref())
}

/// The same, for the other modules that follow the theme setting (bgcolor.rs: the colour of a window before its page paints).
pub fn choice_of_app(app: &AppHandle) -> Option<Theme> {
    choice(app)
}

/// Tell one window what the library has to be told (the only two native theme calls of the app are here).
fn tell(w: &tauri::WebviewWindow, step: Step) {
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

/// Apply the current theme choice to every open window (visible, hidden or parked). Safe to call from any thread, as often as needed.
/// `why` goes to the log.
pub fn apply_all(app: &AppHandle, why: &str) {
    *last_apply().lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    let choice = choice(app);
    TARGET.store(
        match choice {
            None => 1,
            Some(Theme::Light) => 2,
            Some(_) => 3,
        },
        Ordering::SeqCst,
    );
    let was_pinned = match choice {
        Some(_) => pinned().swap(true, Ordering::SeqCst),
        None => pinned().swap(false, Ordering::SeqCst),
    };
    let step = step(choice, was_pinned, cfg!(target_os = "macos"));
    let windows = app.webview_windows();
    for w in windows.values() {
        tell(w, step);
    }
    let labels = themed_labels(windows.keys().cloned());
    log(&format!("{} -> applied to {} windows: [{}] ({why}; library step {step:?})", setting_name(choice), labels.len(), labels.join(", ")));
    // the colour of the window and the web view before the page paints follows the same setting (bgcolor.rs)
    let (shown, n) = crate::bgcolor::apply(app);
    log(&format!("  background colour {} on {n} windows ({why})", setting_name(Some(shown))));
    native(app, choice, why.to_string(), None);
}

/// Repaint strategies running now (macOS), and when the last one ended. The flip step gives a window the opposite appearance for a moment, which
/// also moves the colour scheme the web view reports to its page; the page then asks for its window again (`window_theme_refresh`), which
/// would start the next strategy, which flips ... So the page's request is not taken while a strategy runs or for [`QUIET`] after it. The OS
/// change itself reaches us by the system notification and tao's event, which are not held back.
static STRATEGIES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
const QUIET: Duration = Duration::from_millis(800);

fn strategy_ended() -> &'static Mutex<Option<Instant>> {
    static ENDED: Mutex<Option<Instant>> = Mutex::new(None);
    &ENDED
}

/// Is a repaint strategy running, or did one end less than [`QUIET`] ago?
fn strategy_quiet() -> bool {
    STRATEGIES.load(Ordering::SeqCst) > 0 || strategy_ended().lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|t| t.elapsed() < QUIET)
}

/// Counts a running strategy; when dropped (the thread ended, or panicked) the strategy is over and the quiet time starts.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Running;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl Running {
    fn start() -> Running {
        STRATEGIES.fetch_add(1, Ordering::SeqCst);
        Running
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        *strategy_ended().lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        STRATEGIES.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The page of a pop-out asks for its own window to be done again (it changed its own theme class, or its colour scheme changed): the
/// second way, independent of [`apply_all`] and its triggers. `page_theme` / `prefers_dark`: what the page sees, for the log.
pub fn refresh_window(app: &AppHandle, label: &str, page_theme: &str, prefers_dark: Option<bool>) {
    if strategy_quiet() {
        log(&format!("{label}: its page asks for the frame theme again (page data-theme '{}', page prefers dark: {prefers_dark:?}): not taken, a repaint strategy is running or has just ended", page_theme.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(16).collect::<String>()));
        return;
    }
    let choice = choice(app);
    let step = step(choice, pinned().load(Ordering::SeqCst), cfg!(target_os = "macos"));
    let found = app.get_webview_window(label);
    if let Some(w) = &found {
        tell(w, step);
    }
    let page: String = page_theme.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(16).collect();
    log(&format!(
        "{label}: its page asks for the frame theme again (page data-theme '{page}', page prefers dark: {prefers_dark:?}); setting {}; window {}",
        setting_name(choice),
        if found.is_some() { "found" } else { "NOT FOUND" }
    ));
    native(app, choice, format!("{label} page request"), Some(label.to_string()));
}

/// A page asks for its own window's frame theme to be applied again (src/popout/PopoutRoot.tsx).
#[tauri::command]
pub fn window_theme_refresh(app: AppHandle, window: tauri::Window, page_theme: Option<String>, prefers_dark: Option<bool>) {
    refresh_window(&app, window.label(), page_theme.as_deref().unwrap_or(""), prefers_dark);
}

/// The OS theme changed (`source` says which way it was noticed). Only a System setting follows the OS; an explicit one stays as it is.
pub fn on_os_theme_changed(app: &AppHandle, source: &str) {
    static SCHEDULED: AtomicBool = AtomicBool::new(false);
    log(&format!("OS theme event: {source}"));
    let c = choice(app);
    if c.is_some() {
        log(&format!("  not followed: the setting is {}", setting_name(c)));
        return;
    }
    // the answer of a theme change that our own call caused (some platforms report one) is not a change of the OS
    if last_apply().lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|t| t.elapsed() < Duration::from_millis(400)) {
        log("  not followed: within 400 ms of our own apply");
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
        apply_all(&app, "OS theme change");
        // once more when the dust has settled: what the application answers can lag behind the notification
        std::thread::sleep(Duration::from_millis(900));
        apply_all(&app, "OS theme change, settled");
    });
}

/// The label and `NSWindow` of every window tauri lists (main thread). A window whose handle cannot be had is logged, never skipped silently.
#[cfg(target_os = "macos")]
fn native_windows(app: &AppHandle) -> Vec<(String, *mut std::ffi::c_void)> {
    let mut v = Vec::new();
    for (label, w) in app.webview_windows() {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.ns_window())) {
            Ok(Ok(p)) => v.push((label, p)),
            Ok(Err(e)) => log(&format!("{label}: no native window: {e}")),
            Err(_) => log(&format!("{label}: the native window lookup panicked")),
        }
    }
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

/// What the last apply asked for, as the appearance the windows have to end with: `None` = System (no appearance of their own).
#[cfg(target_os = "macos")]
fn target_dark() -> Option<bool> {
    match TARGET.load(Ordering::SeqCst) {
        2 => Some(false),
        3 => Some(true),
        _ => None,
    }
}

/// macOS: the appearance of every `NSWindow` itself (main thread), read back and logged, see the module text; then what each window is (the
/// properties that decide how its title bar is painted) and the repaint strategy of `HEYLOOK_TITLEBAR_MODE` (titlebar.rs). `only`: just that window.
#[cfg(target_os = "macos")]
fn native(app: &AppHandle, choice: Option<Theme>, why: String, only: Option<String>) {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    static MODE_NOTE: AtomicBool = AtomicBool::new(false);
    let (mode, note) = crate::titlebar::mode();
    if let Some(n) = note.filter(|_| !MODE_NOTE.swap(true, Ordering::SeqCst)) {
        log(&format!("HEYLOOK_TITLEBAR_MODE: {n}"));
    }
    let dark = choice.map(|t| t == Theme::Dark);
    let handle = app.clone();
    let for_strategy = only.clone();
    let strategy_why = why.clone();
    let queued = app.run_on_main_thread(move || {
        let known = native_windows(&handle);
        let report = crate::macwin::apply_appearance(dark, &known, only.as_deref());
        for l in &report.lines {
            log(&format!("  {l}"));
        }
        log(&format!(
            "  native appearance applied ({why}): {} window line(s), {} MISMATCH, macOS shows {}",
            report.lines.len().saturating_sub(1),
            report.mismatches,
            crate::macwin::system_style()
        ));
        // what each window is, to read what differs between a compose and a reader window (a panic here must never take the app down)
        log(&format!("  title bar mode {} ({why})", crate::titlebar::mode_text(mode)));
        match catch_unwind(AssertUnwindSafe(|| crate::macwin::describe_all(&known, only.as_deref()))) {
            Ok(lines) => lines.iter().for_each(|l| log(&format!("  window: {l}"))),
            Err(_) => log("  window: the description of the windows panicked"),
        }
    });
    if let Err(e) = queued {
        log(&format!("the native part could not be queued on the main thread: {e}"));
        return;
    }
    run_strategy(app, strategy_why, for_strategy);
}

/// Ask the pages (all, or the one named) to lay out their top edge again (`titlebar-nudge`, src/popout/titlebarNudge.ts).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn nudge_pages(app: &AppHandle, only: Option<&str>) -> usize {
    use tauri::Emitter;
    let mut n = 0;
    for label in app.webview_windows().keys() {
        if only.is_none_or(|o| o == label) {
            let _ = app.emit_to(label.as_str(), "titlebar-nudge", ());
            n += 1;
        }
    }
    n
}

/// macOS: the steps of the chosen repaint mode, one after the other with a pause between them (`titlebar::STEP_GAP`), each on the main thread,
/// each logged. Every step reads the CURRENT target, so a run that is overtaken by a newer apply cannot leave an old appearance behind (a flip
/// always ends with the target; a window put out of sight is always brought back).
#[cfg(target_os = "macos")]
fn run_strategy(app: &AppHandle, why: String, only: Option<String>) {
    use crate::titlebar::{plan, Act, STEP_GAP};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let steps = plan(crate::titlebar::mode().0);
    if steps.is_empty() {
        log("  strategy: none (mode 0, the control)");
        return;
    }
    let app = app.clone();
    let running = Running::start(); // (counted before the thread starts, so a request that comes in at once is already held back)
    std::thread::spawn(move || {
        let _running = running;
        let total = steps.len();
        for (i, act) in steps.iter().enumerate() {
            std::thread::sleep(STEP_GAP);
            let head = format!("  strategy step {}/{} {} ({why})", i + 1, total, act.name());
            if *act == Act::PageNudge {
                log(&format!("{head}: asked {} page(s) to lay out the top edge again", nudge_pages(&app, only.as_deref())));
                continue;
            }
            let (tx, rx) = std::sync::mpsc::channel();
            let (handle, a, o) = (app.clone(), *act, only.clone());
            let queued = app.run_on_main_thread(move || {
                let known = native_windows(&handle);
                let lines = catch_unwind(AssertUnwindSafe(|| crate::macwin::run_act(a, target_dark(), &known, o.as_deref())))
                    .unwrap_or_else(|_| vec!["the step panicked".to_string()]);
                let _ = tx.send(lines);
            });
            if let Err(e) = queued {
                log(&format!("{head}: could not be queued on the main thread: {e}"));
                continue;
            }
            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok(lines) => {
                    log(&head);
                    lines.iter().for_each(|l| log(&format!("    {l}")));
                }
                Err(_) => log(&format!("{head}: no answer from the main thread within 3 s")),
            }
        }
        // what the windows are once the strategy is done
        std::thread::sleep(STEP_GAP);
        let (handle, o) = (app.clone(), only.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let queued = app.run_on_main_thread(move || {
            let known = native_windows(&handle);
            let lines = catch_unwind(AssertUnwindSafe(|| crate::macwin::describe_all(&known, o.as_deref()))).unwrap_or_default();
            let _ = tx.send(lines);
        });
        if queued.is_ok() {
            if let Ok(lines) = rx.recv_timeout(Duration::from_secs(3)) {
                log(&format!("  strategy done ({why}); the windows now:"));
                lines.iter().for_each(|l| log(&format!("    window: {l}")));
            }
        }
    });
}
#[cfg(not(target_os = "macos"))]
fn native(_app: &AppHandle, _choice: Option<Theme>, _why: String, _only: Option<String>) {}

/// macOS: how often the watchdog looks at the windows.
#[cfg(target_os = "macos")]
const WATCH_EVERY: Duration = Duration::from_secs(2);

/// macOS: watch the OS colour mode in two more ways than tao's `ThemeChanged` (the system notification, and a watchdog that compares what
/// every window shows with what it has to show and applies again when they differ). Call once, at start-up.
#[cfg(target_os = "macos")]
pub fn watch_os(app: &AppHandle) {
    static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
    if APP.set(app.clone()).is_err() {
        return;
    }
    let seen = crate::macwin::observe_theme_change(|| {
        if let Some(app) = APP.get() {
            on_os_theme_changed(app, "AppleInterfaceThemeChangedNotification");
        }
    });
    log(&format!("watching the OS colour mode: notification {}, watchdog every {} s", seen.err().unwrap_or_else(|| "observed".into()), WATCH_EVERY.as_secs()));
    let (mode, note) = crate::titlebar::mode();
    log(&format!("title bar repaint mode (HEYLOOK_TITLEBAR_MODE): {}{}", crate::titlebar::mode_text(mode), note.map(|n| format!(" - {n}")).unwrap_or_default()));
    let app = app.clone();
    std::thread::spawn(move || {
        static STREAK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        loop {
            std::thread::sleep(WATCH_EVERY);
            let dark = match TARGET.load(Ordering::SeqCst) {
                0 => continue, // nothing applied yet
                1 => None,
                2 => Some(false),
                _ => Some(true),
            };
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let known = native_windows(&handle);
                let off = crate::macwin::mismatched(dark, &known);
                if off.is_empty() {
                    STREAK.store(0, Ordering::SeqCst);
                    return;
                }
                // a window that cannot be set right is not logged and retried every two seconds for ever: three tries, then one in thirty
                let n = STREAK.load(Ordering::SeqCst).saturating_add(1);
                STREAK.store(n, Ordering::SeqCst);
                if n <= 3 || n % 15 == 0 {
                    log(&format!("watchdog: [{}] do not show what the setting asks (check #{n}): applying again", off.join(", ")));
                    apply_all(&handle, "watchdog");
                }
            });
        }
    });
}

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
        assert_eq!([setting_name(Some(Theme::Dark)), setting_name(Some(Theme::Light)), setting_name(None)], ["dark", "light", "system"]);
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

    /// Every window gets the frame theme, whatever its label: `main`, every `compose-<n>` and `reader-<n>`, and a label no code knows yet.
    #[test]
    fn every_label_is_covered() {
        let labels: Vec<String> = ["main", "compose-1", "reader-2", "compose-12", "reader-30", "future-window"].iter().map(|s| s.to_string()).collect();
        let got = themed_labels(labels.clone());
        for l in &labels {
            assert!(got.contains(l), "{l} is left out: {got:?}");
        }
        assert_eq!(got.len(), labels.len());
        assert_eq!(themed_labels(vec!["b".into(), "a".into(), "b".into()]), ["a", "b"], "sorted, once each");
        assert!(themed_labels(Vec::<String>::new()).is_empty());
        // the code that walks the windows does not filter by label or kind
        let me = crate::test_guard::non_test_code(include_str!("wintheme.rs"));
        let apply = &me[me.find("pub fn apply_all(").unwrap()..];
        let apply = &apply[..apply.find("\n}\n").unwrap()];
        assert!(apply.contains("app.webview_windows()") && !apply.contains("is_secondary") && !apply.contains("== \"main\"") && !apply.contains("kind_of_label"), "{apply}");
        let mac = crate::test_guard::non_test_code(include_str!("macwin.rs"));
        let walk = &mac[mac.find("pub fn apply_appearance(").unwrap()..];
        let walk = &walk[..walk.find("\n}\n").unwrap()];
        assert!(walk.contains("work_list(known, only)"), "{walk}");
        let list = &mac[mac.find("unsafe fn work_list(").unwrap()..];
        let list = &list[..list.find("\n}\n").unwrap()];
        assert!(list.contains("app_window_list()") && list.contains("is_titled(w)"), "windows tauri does not list are reached too: {list}");
        assert!(!walk.contains("is_secondary") && !walk.contains("kind_of_label") && !list.contains("is_secondary") && !list.contains("kind_of_label"), "{walk}{list}");
    }

    #[test]
    fn what_a_window_has_to_show_is_judged_by_its_own_appearance_and_the_one_it_shows() {
        const DARK: &str = "NSAppearanceNameDarkAqua";
        const LIGHT: &str = "NSAppearanceNameAqua";
        // appearance names
        assert_eq!(dark_from_name(DARK), Some(true));
        assert_eq!(dark_from_name(LIGHT), Some(false));
        assert_eq!(dark_from_name("NSAppearanceNameVibrantDark"), Some(true));
        assert_eq!(dark_from_name("NSAppearanceNameAccessibilityHighContrastDarkAqua"), Some(true));
        assert_eq!(dark_from_name("NSAppearanceNameAccessibilityHighContrastAqua"), Some(false));
        assert_eq!((dark_from_name("nil"), dark_from_name("?"), dark_from_name("")), (None, None, None));
        // pinned: the window's own appearance has to be the named one, and it has to show it
        assert_eq!(judge(Some(true), DARK, Some(true), Some(true)), None);
        assert_eq!(judge(Some(false), LIGHT, Some(false), Some(false)), None);
        assert!(judge(Some(true), LIGHT, Some(false), Some(true)).is_some(), "an old light pin on a window that has to be dark");
        assert!(judge(Some(true), "nil", Some(false), Some(true)).is_some(), "no appearance of its own where one is pinned");
        assert!(judge(Some(false), LIGHT, Some(true), Some(false)).unwrap().contains("shows dark"), "own appearance right, shown one wrong");
        // System: no appearance of its own, and it shows what the application shows
        assert_eq!(judge(None, "nil", Some(false), Some(false)), None);
        assert_eq!(judge(None, "nil", Some(true), Some(true)), None);
        assert!(judge(None, DARK, Some(true), Some(true)).unwrap().contains("nil"), "a window that kept an appearance of its own");
        assert!(judge(None, "nil", Some(true), Some(false)).unwrap().contains("shows dark but has to show light"), "the compose case: stuck dark under a light OS");
        // unknown readings are not mismatches by themselves
        assert_eq!(judge(None, "nil", None, Some(true)), None);
        assert_eq!(judge(None, "nil", Some(true), None), None);
    }

    /// Every window path, and every reason a frame has to change, goes through the one function: the guards below fail when a new path is
    /// added without it, or when a page (or another file) fixes a theme by itself.
    #[test]
    fn every_window_path_goes_through_the_one_function() {
        let code = |s: &str| crate::test_guard::non_test_code(s);
        let lib = code(include_str!("lib.rs"));
        let pop = code(include_str!("popout.rs"));
        // creation: a secondary window (inside `create`, after the build) and the main window (start-up)
        let create = &pop[pop.find("fn create(").unwrap()..];
        let create = &create[..create.find("\n}\n").unwrap()];
        assert!(create.find("b.build()").unwrap() < create.find("crate::wintheme::apply_all(app, ").expect("create applies the theme"), "{create}");
        let setup = &lib[lib.find(".setup(|app|").unwrap()..lib.find(".on_window_event(").unwrap()];
        assert!(setup.contains("wintheme::apply_all(app.handle(), "), "the main window gets its theme at start-up");
        assert!(setup.contains("wintheme::watch_os(app.handle())"), "the OS colour mode is watched on macOS");
        // the setting changes
        let set = &lib[lib.find("fn set_setting(").unwrap()..];
        let set = &set[..set.find("\n}\n").unwrap()];
        assert!(set.contains("if key == \"prefs\" {") && set.contains("wintheme::apply_all(&app, "), "{set}");
        // the OS changes: any window, before the label is looked at
        let ev = &lib[lib.find(".on_window_event(").unwrap()..lib.find(".invoke_handler").unwrap()];
        let theme = ev.find("tauri::WindowEvent::ThemeChanged").expect("the OS theme event is handled");
        assert!(theme < ev.find("window.label() != \"main\"").unwrap() && ev.contains("wintheme::on_os_theme_changed(window.app_handle(), "), "{ev}");
        // nothing else sets a window theme or builds a window with one: the native calls are in this file (and macwin.rs) only
        for (name, src) in [("lib.rs", &lib), ("popout.rs", &pop)] {
            assert!(!src.contains(".set_theme(") && !src.contains(".theme(Some"), "{name} sets a theme by itself");
        }
        let me = code(include_str!("wintheme.rs"));
        assert_eq!(me.matches(".set_theme(").count(), 2, "Pin and Release are the only two native calls");
    }

    /// Nothing fixes a theme when a window is made: the builder is not given one, and neither is the window configuration.
    #[test]
    fn a_window_is_never_made_with_a_fixed_theme() {
        let pop = crate::test_guard::non_test_code(include_str!("popout.rs"));
        let create = &pop[pop.find("fn create(").unwrap()..];
        let create = &create[..create.find("\n}\n").unwrap()];
        let chain = &create[create.find("WebviewWindowBuilder::new").unwrap()..create.find("b.build()").unwrap()];
        assert!(!chain.contains(".theme(") && !chain.contains("preferred_theme") && !chain.contains("title_bar_style"), "{chain}");
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for w in conf["app"]["windows"].as_array().cloned().unwrap_or_default() {
            assert!(w.get("theme").is_none(), "the window configuration fixes a theme: {w}");
        }
        // no window object other than the builder in popout.rs exists (the main window comes from the configuration)
        assert_eq!(pop.matches("WebviewWindowBuilder::new").count(), 1);
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(!lib.contains("WebviewWindowBuilder") && !lib.contains("WindowBuilder::new"));
    }

    /// The System setting hands the choice to the OS (`None`), it never turns into a theme.
    #[test]
    fn system_means_follow_the_os() {
        let me = crate::test_guard::non_test_code(include_str!("wintheme.rs"));
        assert!(me.contains("Step::Release => {\n            let _ = w.set_theme(None);"));
        assert!(me.contains("_ => None,"), "an unknown value follows the OS");
        // the page does not choose a theme for its window itself: it only asks the backend to apply the setting again
        let cap = include_str!("../capabilities/popout.json");
        assert!(!cap.contains("allow-set-theme"), "a pop-out page may not fix its own theme");
        // macwin: nil for System, the named appearance only for an explicit choice
        let mac = crate::test_guard::non_test_code(include_str!("macwin.rs"));
        let f = &mac[mac.find("unsafe fn appearance_for(").unwrap()..];
        let f = &f[..f.find("\n}\n").unwrap()];
        assert!(f.contains("let Some(dark) = dark else { return std::ptr::null_mut() };"), "{f}");
    }

    /// The runtime self-check and the log lines the Mac QA reads.
    #[test]
    fn the_native_part_reads_back_and_logs() {
        let mac = crate::test_guard::non_test_code(include_str!("macwin.rs"));
        let walk = &mac[mac.find("pub fn apply_appearance(").unwrap()..];
        let walk = &walk[..walk.find("\n}\n").unwrap()];
        for needle in ["read_back(w)", "crate::wintheme::judge(", "MISMATCH", "app, setAppearance", "was {own0} / {eff0}, now {own} / {eff}"] {
            assert!(walk.contains(needle), "{needle}");
        }
        assert!(mac.contains("setAppearance: appearance_for(dark)") && mac.contains("effectiveAppearance"));
        let me = crate::test_guard::non_test_code(include_str!("wintheme.rs"));
        for needle in ["-> applied to {} windows: [{}]", "OS theme event: {source}", "{} MISMATCH", "watchdog: [{}]", "its page asks for the frame theme again"] {
            assert!(me.contains(needle), "{needle}");
        }
    }

    /// The repaint strategies (titlebar.rs) are wired the same way for every window: each apply logs the mode and describes every window, the
    /// steps run on the main thread one after the other, none of them looks at a label, and every step of a plan has its code.
    #[test]
    fn the_repaint_strategies_reach_every_window_and_are_logged() {
        let me = crate::test_guard::non_test_code(include_str!("wintheme.rs"));
        let native = &me[me.find("fn native(app: &AppHandle, choice").unwrap()..];
        let native = &native[..native.find("\n}\n").unwrap()];
        for needle in ["crate::titlebar::mode()", "title bar mode {}", "describe_all(&known", "catch_unwind", "run_strategy(app, "] {
            assert!(native.contains(needle), "native() lacks {needle}");
        }
        let run = &me[me.find("fn run_strategy(").unwrap()..];
        let run = &run[..run.find("\n}\n").unwrap()];
        for needle in ["plan(crate::titlebar::mode().0)", "STEP_GAP", "run_on_main_thread", "target_dark()", "strategy step {}/{} {}", "nudge_pages("] {
            assert!(run.contains(needle), "run_strategy() lacks {needle}");
        }
        assert!(!run.contains("kind_of_label") && !run.contains("is_secondary") && !run.contains("\"main\""), "a strategy is for every window");
        // every step of every plan is done by macwin::run_act (the page nudge is the one that is not native)
        let mac = crate::test_guard::non_test_code(include_str!("macwin.rs"));
        let act = &mac[mac.find("pub fn run_act(").unwrap()..];
        let act = &act[..act.find("\n}\n").unwrap()];
        for m in 0..=crate::titlebar::MAX_MODE {
            for a in crate::titlebar::plan(m) {
                let variant = format!("{a:?}");
                assert!(act.contains(&format!("Act::{variant}")), "mode {m}: {variant} has no code in macwin::run_act");
            }
        }
        assert!(act.contains("work_list(known, only)") && !act.contains("kind_of_label") && !act.contains("is_secondary"), "{act}");
        // a window put out of sight is remembered and brought back, the key one as the key window
        assert!(act.contains("hidden()") && act.contains("makeKeyAndOrderFront") && act.contains("orderOut"), "{act}");
        // the log shows what decides how a title bar is painted
        for needle in ["styleMask", "fullSizeContentView", "titlebarAppearsTransparent", "titleVisibility", "backgroundColor", "isKeyWindow", "isVisible", "documentEdited", "sharingType", "level"] {
            assert!(mac.contains(needle), "macwin::describe lacks {needle}");
        }
        // the variable is named in titlebar.rs, which reads it once; here only in a log line
        assert!(include_str!("titlebar.rs").contains("std::env::var(\"HEYLOOK_TITLEBAR_MODE\")"));
        assert!(!me.contains("env::var"), "wintheme.rs does not read the environment itself");
    }

    /// The flip makes the page's colour scheme change for a moment and the page asks for its window again: that request is held back while a
    /// strategy runs and for a short time after it, otherwise the strategy would start itself again for ever.
    #[test]
    fn a_page_request_is_held_back_while_a_strategy_runs() {
        assert!(!strategy_quiet(), "nothing runs at the start");
        let running = Running::start();
        assert!(strategy_quiet(), "a strategy is running");
        drop(running);
        assert!(strategy_quiet(), "and for a moment after it");
        std::thread::sleep(QUIET + Duration::from_millis(100));
        assert!(!strategy_quiet(), "then the page may ask again");
        let me = crate::test_guard::non_test_code(include_str!("wintheme.rs"));
        let refresh = &me[me.find("pub fn refresh_window(").unwrap()..];
        let refresh = &refresh[..refresh.find("\n}\n").unwrap()];
        assert!(refresh.find("strategy_quiet()").unwrap() < refresh.find("tell(w, step)").unwrap(), "the request is judged before anything is done");
        let run = &me[me.find("fn run_strategy(").unwrap()..];
        assert!(run.contains("Running::start()"), "a strategy counts itself");
    }

    /// The source of the compose title bar bug (Mac QA 1.0.6, third attempt): on macOS the web view runs under the title bar and WebKit takes the
    /// colour there from the page; the root of the compose page was `position: fixed`, the only one, and its colour was taken once.
    #[test]
    fn the_root_of_the_compose_page_is_not_fixed_to_the_window() {
        let css = include_str!("../../src/App.css");
        let rule = css.lines().find(|l| l.starts_with(".popout-compose {")).expect("the .popout-compose rule");
        assert!(!rule.contains("fixed") && !rule.contains("sticky"), "{rule}");
        assert!(rule.contains("position: relative") && rule.contains("height: 100vh"), "{rule}");
        // the other roots of a window of its own are not fixed either
        for sel in [".reader-win {", ".popout-root {"] {
            let r = css.lines().find(|l| l.starts_with(sel)).unwrap_or_else(|| panic!("{sel}"));
            assert!(!r.contains("position: fixed") && !r.contains("position: sticky"), "{r}");
        }
        // the page side: it logs what its top strip is painted with and answers the nudge
        let root = include_str!("../../src/popout/PopoutRoot.tsx");
        assert!(root.contains("topStripInfo()") && root.contains("listen(\"titlebar-nudge\""));
        assert!(include_str!("popout.rs").contains("\"strip\""), "the backend takes the strip note");
    }

    /// The page's way (`window_theme_refresh`) is wired in the three places a command needs, for the main page and the pop-outs.
    #[test]
    fn the_page_can_ask_for_its_window_to_be_done_again() {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(lib.contains("wintheme::window_theme_refresh,"));
        assert!(include_str!("../build.rs").contains("\"window_theme_refresh\""));
        for cap in [include_str!("../capabilities/default.json"), include_str!("../capabilities/popout.json")] {
            assert!(cap.contains("\"allow-window-theme-refresh\""));
        }
        let root = include_str!("../../src/popout/PopoutRoot.tsx");
        assert!(root.contains("api.windowThemeRefresh("), "the pop-out page asks after it changed its own theme");
        assert!(include_str!("../../src/api.ts").contains("invoke<void>(\"window_theme_refresh\""));
    }
}
