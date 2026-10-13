//! Showing the main window only when its page is alive (QA BUG-8: after an updater relaunch the window was sometimes black).
//!
//! The window is created hidden (`visible: false`). It used to be shown at the end of `setup`, a moment after the web view was
//! created and long before it had loaded the page. When the process is started by an installer, while the old process's web view
//! helpers are still shutting down, WebView2 can come up in a state where the window is shown but nothing is ever painted (the
//! process answers, the child window is visible, the area is black). Reproduced with the debug build in a throw-away data folder:
//! 1 in 15 quick relaunches (`scripts`-style harness: kill the old process at once, start the new one 50 ms later).
//!
//! Now the window is shown when the page says it is up (`frontend_ready`, sent by the UI after its first paint). If that signal does
//! not come within `READY_WAIT`, the window is shown anyway (the person sees something and can close it) and the page is reloaded,
//! up to `MAX_RELOADS` times. Every stage leaves one line on stderr and in `startup.log` in the data folder (the release app has
//! no console, so the file is the only record).
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// How long the page gets to report itself before the window is shown anyway and the page is reloaded.
pub const READY_WAIT: Duration = Duration::from_secs(6);
/// Reloads before giving up (the window stays as it is).
pub const MAX_RELOADS: u32 = 2;
const LOG_CAP: u64 = 32 * 1024;

static T0: OnceLock<Instant> = OnceLock::new();
static READY: AtomicBool = AtomicBool::new(false);
/// Hide + show attempts made so far (a window that is shown but whose page is not painting).
static REMEDIES: AtomicU32 = AtomicU32::new(0);
/// How often the hide + show is tried before leaving the window as it is.
pub const MAX_REMEDIES: u32 = 2;

/// What `watch` tells its caller.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Event {
    /// The page reported itself `waited_ms` after the first wait began.
    Ready { waited_ms: u128 },
    /// No signal within `READY_WAIT` (`attempt` counts from 0); `will_reload` says whether a reload follows.
    NoSignal { attempt: u32, will_reload: bool },
}

/// The wait loop, with the clock injected so a test can run it in no time: wait up to `READY_WAIT` for `ready`; when it does not
/// come report `NoSignal` (the caller reloads) and wait again, `MAX_RELOADS` times.
pub fn watch(ready: impl Fn() -> bool, mut sleep: impl FnMut(Duration), mut on: impl FnMut(Event)) {
    let tick = Duration::from_millis(50);
    let mut total = Duration::ZERO;
    for attempt in 0..=MAX_RELOADS {
        let mut waited = Duration::ZERO;
        while waited < READY_WAIT {
            if ready() {
                on(Event::Ready { waited_ms: (total + waited).as_millis() });
                return;
            }
            sleep(tick);
            waited += tick;
        }
        total += waited;
        on(Event::NoSignal { attempt, will_reload: attempt < MAX_RELOADS });
    }
}

/// One line per stage: milliseconds since the process started, on stderr and in `<data folder>/startup.log` (capped).
pub fn stage(app: Option<&AppHandle>, what: &str) {
    let ms = T0.get_or_init(Instant::now).elapsed().as_millis();
    let line = format!("[window +{ms} ms] {what}");
    eprintln!("{line}");
    let Some(dir) = app.and_then(|a| a.try_state::<crate::legacy_names::DataDir>()) else { return };
    let path = dir.0.join("startup.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Call first thing in `main`-ish code so the stage clock starts with the process.
pub fn init_clock() {
    T0.get_or_init(Instant::now);
}

/// Whether the page has reported itself at least once (a quit asks a page that is not up for nothing).
pub fn is_ready() -> bool {
    READY.load(Ordering::SeqCst)
}

/// The page is up (sent once per page load by the UI).
pub fn mark_ready(app: &AppHandle) {
    if !READY.swap(true, Ordering::SeqCst) {
        stage(Some(app), "the page reported itself ready");
    }
}

/// The page is in a window that is shown, yet the page believes it is hidden or gets no animation frames: nothing is painted
/// (the black window). Pure, for the test.
pub fn needs_remedy(visibility: &str, frames: bool, window_visible: bool, done: u32) -> bool {
    window_visible && (visibility != "visible" || !frames) && done < MAX_REMEDIES
}

/// The page's own report, a moment after the window was shown (`visibilityState` and whether an animation frame arrived).
/// If it says "not painting" the window is hidden and shown again, which makes WebView2 take up the visible state anew.
pub fn page_state(app: &AppHandle, visibility: &str, frames: bool) {
    // "shown" = visible and not minimized (a minimized window legitimately reports a hidden page)
    let visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false);
    stage(Some(app), &format!("page state after show: visibility={visibility}, animation frames={frames}, window visible={visible}"));
    // (On Windows the page cannot tell: in the black window it reports `visible` and gets frames. The native check of `verify_painting`
    // decides there; this report is the only signal on macOS and Linux.)
    if cfg!(windows) || !needs_remedy(visibility, frames, visible, REMEDIES.load(Ordering::SeqCst)) {
        return;
    }
    hide_and_show(app, "the page says it is not painting");
}

/// Hide the window and show it again: WebView2 then takes up the visible state anew (checked: it cures the black window each time,
/// a repaint or a 1 px resize does not). At most `MAX_REMEDIES` times per run.
fn hide_and_show(app: &AppHandle, why: &str) {
    let n = REMEDIES.fetch_add(1, Ordering::SeqCst) + 1;
    stage(Some(app), &format!("{why}: hide + show (attempt {n})"));
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
        std::thread::sleep(Duration::from_millis(400));
        crate::shell::show_main(&app); // shows the window again, which starts the native checks again
    });
}

/// True when the sampled pixels are one single colour: nothing is painted (the black window, or a white one). Pure, for the test.
pub fn is_blank(samples: impl IntoIterator<Item = [u8; 3]>) -> bool {
    let mut first: Option<[u8; 3]> = None;
    for p in samples {
        match first {
            None => first = Some(p),
            Some(f) if f != p => return false,
            _ => {}
        }
    }
    true
}

/// When, after the window was shown, its pixels are looked at (seconds). The black window was seen only in screenshots taken 2.5 s
/// or later after the window appeared; a check at 1.5 s alone found content every time (450 of 450 launches, 4 of which were black
/// a second later), so the window is looked at again later: a web view that attached to the previous run's dying browser process
/// goes wrong when that process exits, a few seconds after the relaunch.
pub const PAINT_CHECKS_MS: [u64; 4] = [1500, 2500, 4000, 8000];

/// Windows: look at the window's pixels at `PAINT_CHECKS_MS` after it was shown (the way a screenshot does); one colour means a
/// black window, and the window is hidden and shown again, at most `MAX_REMEDIES` times. Runs on its own thread.
pub fn verify_painting(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut at = 0;
        for ms in PAINT_CHECKS_MS {
            std::thread::sleep(Duration::from_millis(ms - at));
            at = ms;
            let shown = app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)).unwrap_or(false);
            if !shown {
                return; // hidden to the tray or minimized meanwhile: nothing to look at
            }
            match window_paints(&app) {
                Some(true) => {
                    let cured = REMEDIES.load(Ordering::SeqCst) > 0;
                    stage(Some(&app), &format!("native check at {ms} ms: the window shows content{}", if cured { " (the hide + show cured the black window)" } else { "" }));
                }
                Some(false) if REMEDIES.load(Ordering::SeqCst) < MAX_REMEDIES => {
                    stage(Some(&app), &format!("native check at {ms} ms: one colour only (black window)"));
                    hide_and_show(&app, "black window"); // its show starts the checks again
                    return;
                }
                Some(false) => stage(Some(&app), &format!("native check at {ms} ms: still one colour after the attempts, leaving the window as it is")),
                None => stage(Some(&app), &format!("native check at {ms} ms: the window could not be captured")),
            }
        }
    });
}

#[cfg(windows)]
fn window_paints(app: &AppHandle) -> Option<bool> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let hwnd = app.get_webview_window("main")?.hwnd().ok()?;
    unsafe {
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).ok()?;
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w < 200 || h < 200 || w > 8000 || h > 8000 {
            return None;
        }
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        // PW_RENDERFULLCONTENT (2): also draws the web view
        let printed = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(2)).as_bool();
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, ..Default::default() };
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !printed || lines == 0 {
            return None;
        }
        // a grid below the 50 px top bar
        let (w, h) = (w as usize, h as usize);
        let samples = (80..h.saturating_sub(10)).step_by((h / 24).max(1)).flat_map(|y| {
            let buf = &buf;
            (10..w.saturating_sub(10)).step_by((w / 40).max(1)).map(move |x| {
                let o = (y * w + x) * 4;
                [buf[o], buf[o + 1], buf[o + 2]]
            })
        });
        Some(!is_blank(samples))
    }
}

#[cfg(not(windows))]
fn window_paints(_app: &AppHandle) -> Option<bool> {
    None
}

/// Start watching: show the window when the page is ready (`show_at_start`: not a tray-only start), reload it when it never is.
pub fn start(app: &AppHandle, show_at_start: bool) {
    stage(Some(app), &format!("window created hidden (show at start: {show_at_start})"));
    let app = app.clone();
    std::thread::spawn(move || {
        watch(
            || READY.load(Ordering::SeqCst),
            std::thread::sleep,
            |ev| match ev {
                Event::Ready { waited_ms } => {
                    if show_at_start {
                        crate::shell::show_main(&app);
                        stage(Some(&app), &format!("window shown, page ready after {waited_ms} ms"));
                    } else {
                        stage(Some(&app), &format!("page ready after {waited_ms} ms, window stays hidden (tray start)"));
                    }
                }
                Event::NoSignal { attempt, will_reload } => {
                    stage(Some(&app), &format!("no ready signal within {} s (attempt {})", READY_WAIT.as_secs(), attempt + 1));
                    if show_at_start && attempt == 0 {
                        crate::shell::show_main(&app);
                        stage(Some(&app), "window shown without a ready signal");
                    }
                    if will_reload {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("window.location.reload()");
                        }
                        stage(Some(&app), "reloading the page");
                    } else {
                        stage(Some(&app), "giving up: the page never reported itself");
                    }
                }
            },
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// Runs `watch` with a fake clock: `ready` turns true after `after` ticks. Returns the events and the ticks slept.
    fn run(after: Option<u32>) -> (Vec<Event>, u32) {
        let ticks = Cell::new(0u32);
        let events = RefCell::new(vec![]);
        watch(|| after.map_or(false, |n| ticks.get() >= n), |_| ticks.set(ticks.get() + 1), |e| events.borrow_mut().push(e));
        (events.into_inner(), ticks.get())
    }

    #[test]
    fn a_page_that_reports_itself_is_shown_at_once_without_reloads() {
        let (ev, _) = run(Some(0));
        assert_eq!(ev, vec![Event::Ready { waited_ms: 0 }]);
        let (ev, ticks) = run(Some(20));
        assert_eq!(ev, vec![Event::Ready { waited_ms: 1000 }]);
        assert_eq!(ticks, 20);
    }

    #[test]
    fn a_page_that_is_slow_but_comes_within_the_wait_is_not_reloaded() {
        let last_tick = (READY_WAIT.as_millis() / 50) as u32 - 1;
        let (ev, _) = run(Some(last_tick));
        assert!(matches!(ev.as_slice(), [Event::Ready { .. }]), "{ev:?}");
    }

    #[test]
    fn a_page_that_comes_after_a_reload_is_reported_with_the_total_wait() {
        let per = (READY_WAIT.as_millis() / 50) as u32;
        let (ev, _) = run(Some(per + 10));
        assert_eq!(ev, vec![Event::NoSignal { attempt: 0, will_reload: true }, Event::Ready { waited_ms: (READY_WAIT.as_millis() + 500) }]);
    }

    #[test]
    fn a_page_that_never_comes_is_reloaded_twice_and_then_given_up() {
        let (ev, ticks) = run(None);
        assert_eq!(
            ev,
            vec![
                Event::NoSignal { attempt: 0, will_reload: true },
                Event::NoSignal { attempt: 1, will_reload: true },
                Event::NoSignal { attempt: 2, will_reload: false },
            ]
        );
        assert_eq!(ticks as u128 * 50, READY_WAIT.as_millis() * 3);
    }

    #[test]
    fn a_shown_window_whose_page_does_not_paint_gets_hidden_and_shown_twice_at_most() {
        assert!(!needs_remedy("visible", true, true, 0), "a healthy page is left alone");
        assert!(needs_remedy("hidden", true, true, 0), "the page thinks it is hidden");
        assert!(needs_remedy("visible", false, true, 0), "no animation frames");
        assert!(!needs_remedy("hidden", false, false, 0), "a window that is hidden on purpose (tray start) is not touched");
        assert!(needs_remedy("hidden", true, true, 1));
        assert!(!needs_remedy("hidden", true, true, MAX_REMEDIES), "no endless loop");
    }

    #[test]
    fn one_colour_everywhere_is_a_window_that_paints_nothing() {
        assert!(is_blank(vec![[0, 0, 0]; 50]), "black");
        assert!(is_blank(vec![[255, 255, 255]; 50]), "white");
        assert!(is_blank(Vec::<[u8; 3]>::new()));
        let mut ui = vec![[250, 250, 250]; 50];
        ui[17] = [30, 30, 30];
        assert!(!is_blank(ui), "a real screen has more than one colour");
    }

    #[test]
    fn the_window_is_never_shown_from_setup() {
        // the regression itself: `show_main` in `setup` showed the window before the page existed
        let lib = include_str!("lib.rs");
        let setup = &lib[lib.find(".setup(|app| {").expect("setup")..];
        let setup = &setup[..setup.find(".on_window_event").expect("end of setup")];
        assert!(!setup.contains("show_main"), "setup must hand the showing to startup::start");
        assert!(setup.contains("startup::start("));
    }
}
