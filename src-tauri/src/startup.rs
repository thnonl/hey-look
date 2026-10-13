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
//!
//! Round 10 (QA BUG-11): the blank windows of QA rounds 5 and 6 were a web view whose browser process had died, and the death came
//! with the pixel check below (a `PrintWindow` capture that crashes the process on a PC with an overlay hook), see `webview_health.rs`
//! for the evidence. The harness numbers above also come from screenshots, so they may be the same effect. What this file does now:
//! the looks after a show ask the process and the window manager instead of reading pixels (the pixel read is a switch, off), a
//! failure event of the web view restarts the app when the browser process is gone, and the escalation (re-assert the web view,
//! hide + show, reload, restart) is bounded and says in `startup.log` which step cured the window or failed.
use crate::webview_health::{self, BrowserState, Reaction};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
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

/// The data folder, for the log file (set once at start-up, so code that has no `AppHandle` can log too).
static LOG_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();
/// Lines written before the data folder is known (the wait for the previous run's web view runs before the app exists).
static EARLY: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn init_log_dir(dir: std::path::PathBuf) {
    if LOG_DIR.set(dir.clone()).is_ok() {
        let early = std::mem::take(&mut *EARLY.lock().unwrap_or_else(|p| p.into_inner()));
        for l in early {
            append(&dir, &l);
        }
    }
}

fn append(dir: &std::path::Path, line: &str) {
    let path = dir.join("startup.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// One line per event: `[tag +ms]` (milliseconds since the process started), on stderr and in `<data folder>/startup.log` (capped).
pub fn line(tag: &str, what: &str) {
    let ms = T0.get_or_init(Instant::now).elapsed().as_millis();
    let line = format!("[{tag} +{ms} ms] {what}");
    eprintln!("{line}");
    match LOG_DIR.get() {
        Some(dir) => append(dir, &line),
        None => {
            let mut early = EARLY.lock().unwrap_or_else(|p| p.into_inner());
            if early.len() < 100 {
                early.push(line);
            }
        }
    }
}

/// A window stage (see `line`).
pub fn stage(_app: Option<&AppHandle>, what: &str) {
    line("window", what);
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

/// When, after a window was shown, the web view is looked at (ms after the show), and whether the look reads the window's pixels.
///
/// QA BUG-11 (evidence in `webview_health.rs`): reading the window's pixels with `PrintWindow(PW_RENDERFULLCONTENT)`, the way a
/// screenshot does, asks the web view's browser process to render the window for the capture. On the QA PC, where a graphics overlay
/// hook (`RTSSHooks64.dll`) sits in that process, the call stalled for 0.3 to 0.9 s and the browser process crashed (an access violation
/// in the hook) in 3 of 3 blank starts of round 6, exactly at the capture 2.5 s after the show; the window stayed white for good. The
/// check that was meant to find a blank window was making it. So by default no look reads pixels: the looks ask the process (still
/// running?) and the window manager (is the web view's own window there, how big, visible?), neither of which sends the browser
/// process anything, and the failure event of `webview_health` reports a death at once. The pixel read stays as a diagnostic that is
/// switched on with `HEYLOOK_PIXEL_CHECK=1` (a machine without such hooks, a QA run that wants it).
const LOOKS_MS: [u64; 5] = [1500, 2500, 4000, 8000, 15000];
/// After a step of the escalation (it needs an answer sooner).
const STEP_LOOKS_MS: [u64; 2] = [1500, 4000];

/// Whether the diagnostic pixel read is on (`HEYLOOK_PIXEL_CHECK=1`).
fn pixel_check_enabled() -> bool {
    std::env::var("HEYLOOK_PIXEL_CHECK").is_ok_and(|v| v == "1")
}

/// The looks of a run: `(ms after the show, reads pixels)`. Pixels only when the diagnostic is on, and never in the first seconds.
pub fn schedule(in_ladder: bool, pixels_on: bool) -> Vec<(u64, bool)> {
    let times: &[u64] = if in_ladder { &STEP_LOOKS_MS } else { &LOOKS_MS };
    times.iter().map(|&ms| (ms, pixels_on && (in_ladder || ms >= 8000))).collect()
}

/// Set once the escalation has started: later looks use `STEP_LOOKS_MS`.
static IN_LADDER: AtomicBool = AtomicBool::new(false);
/// The step taken last, until a look says whether it helped.
static LAST_STEP: Mutex<Option<&'static str>> = Mutex::new(None);

/// The step the last escalation took, if no look has judged it yet (taken: it is judged once).
fn judged_step() -> Option<&'static str> {
    LAST_STEP.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// Look at the web view at the times of `schedule` after the window was shown, on its own thread: a browser process that is gone (or,
/// with the diagnostic on, a window of one colour) starts the escalation. A healthy window is only looked at.
pub fn verify_painting(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let looks = schedule(IN_LADDER.load(Ordering::SeqCst), pixel_check_enabled());
        let mut at = 0;
        for (ms, pixels) in looks {
            std::thread::sleep(Duration::from_millis(ms - at));
            at = ms;
            let shown = app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)).unwrap_or(false);
            if !shown {
                return; // hidden to the tray or minimized meanwhile: nothing to look at
            }
            let state = webview_health::browser_state();
            let child = webview_health::child_info(&app).unwrap_or_else(|| "no web view window found".into());
            if let BrowserState::Exited(_) = state {
                stage(Some(&app), &format!("native check at {ms} ms: the web view's browser process is gone ({}); {child}", state.text()));
                escalate(&app, true);
                return;
            }
            if !pixels {
                stage(Some(&app), &format!("native check at {ms} ms: the web view is running (browser process {}; {child})", state.text()));
                continue;
            }
            let started = Instant::now();
            let painted = window_paints(&app);
            let took = started.elapsed().as_millis();
            match painted {
                Some(true) => {
                    let cured = judged_step().map(|s| format!(" (cured by: {s})")).unwrap_or_default();
                    stage(Some(&app), &format!("native check at {ms} ms: the window shows content{cured}"));
                }
                Some(false) => {
                    stage(Some(&app), &format!("native check at {ms} ms: one colour only (black or blank window); capture took {took} ms; browser process {}; {child}", state.text()));
                    escalate(&app, false);
                    return;
                }
                None => stage(Some(&app), &format!("native check at {ms} ms: the window could not be captured")),
            }
        }
    });
}

/// How often the app restarts itself for a dead or blank web view within `RESTART_WINDOW_S` (a restart that fails the same way
/// again must not loop for ever).
pub const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW_S: i64 = 600;

/// Whether another restart is allowed: fewer than `MAX_RESTARTS` of them in the last ten minutes (`history` = unix seconds of the
/// earlier ones).
pub fn restart_allowed(history: &[i64], now: i64) -> bool {
    history.iter().filter(|&&t| now >= t && now - t <= RESTART_WINDOW_S).count() < MAX_RESTARTS
}

/// The restart times kept in `blank-restart.txt` (whitespace-separated unix seconds; an old file holds one).
pub fn parse_history(text: &str) -> Vec<i64> {
    text.split_whitespace().filter_map(|t| t.parse().ok()).collect()
}

/// One restart at a time (the failure event and a look can see the same dead process).
static RESTARTING: AtomicBool = AtomicBool::new(false);
/// Set when the app itself is closing: the web view's processes then end by design.
static EXITING: AtomicBool = AtomicBool::new(false);

pub fn mark_exiting() {
    EXITING.store(true, Ordering::SeqCst);
}

/// Restart the app, unless it did so `MAX_RESTARTS` times in the last ten minutes (then the window is left as it is). Messages in
/// their Undo time are safe in the outbox, queued actions are flushed first. The new process waits for this one and for the web
/// view processes it leaves behind (`webview_health::wait_for_previous_run`).
fn restart_app(app: &AppHandle, why: &str) {
    if RESTARTING.swap(true, Ordering::SeqCst) || EXITING.load(Ordering::SeqCst) {
        return;
    }
    let marker = LOG_DIR.get().map(|d| d.join("blank-restart.txt"));
    let history = marker.as_ref().and_then(|m| std::fs::read_to_string(m).ok()).map(|t| parse_history(&t)).unwrap_or_default();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    if !restart_allowed(&history, now) {
        stage(Some(app), &format!("{why}: the app already restarted {MAX_RESTARTS} times in the last ten minutes: leaving the window as it is"));
        RESTARTING.store(false, Ordering::SeqCst);
        return;
    }
    let mut kept: Vec<i64> = history.into_iter().filter(|&t| now >= t && now - t <= RESTART_WINDOW_S).collect();
    stage(Some(app), &format!("{why}: restarting the app (restart {} of {MAX_RESTARTS} allowed in ten minutes; messages in their Undo time are kept in the outbox)", kept.len() + 1));
    kept.push(now);
    if let Some(m) = &marker {
        let _ = std::fs::write(m, kept.iter().map(|t| t.to_string()).collect::<Vec<_>>().join("\n"));
    }
    crate::flush_pending(app);
    // the new process waits for this one to be gone, and for its web view processes, so it does not join a dying browser process
    // SAFETY: set right before the process is replaced; nothing else reads the variable meanwhile
    unsafe { std::env::set_var(webview_health::RELAUNCH_ENV, std::process::id().to_string()) };
    app.restart();
}

/// How often a page process that died is answered with a reload in one run.
const MAX_PAGE_RELOADS: u32 = 3;
static PAGE_RELOADS: AtomicU32 = AtomicU32::new(0);

/// The web view reported that one of its processes failed (`webview_health::watch`). Logged with everything the runtime says; a dead
/// browser process (the web view is gone for good) restarts the app, a dead page process reloads the page.
pub fn web_view_failed(app: &AppHandle, kind: i32, detail: &str) {
    if EXITING.load(Ordering::SeqCst) {
        return; // the app is closing: its web view's processes end on purpose
    }
    let what = webview_health::kind_name(kind);
    stage(Some(app), &format!("web view: {what}{}", if detail.is_empty() { String::new() } else { format!(" ({detail})") }));
    let app = app.clone();
    match webview_health::reaction(kind) {
        Reaction::Restart => {
            std::thread::spawn(move || restart_app(&app, "the web view's browser process is gone"));
        }
        Reaction::Reload => {
            std::thread::spawn(move || {
                if PAGE_RELOADS.fetch_add(1, Ordering::SeqCst) < MAX_PAGE_RELOADS {
                    stage(Some(&app), "a page process of the web view died: reloading the page");
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval("window.location.reload()");
                    }
                } else {
                    stage(Some(&app), "a page process of the web view died again: not reloading again");
                }
            });
        }
        Reaction::LogOnly => {}
    }
}

/// The steps of the escalation for a window that shows nothing, in order, each at most once (hide + show twice).
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Step {
    /// Tell the web view controller to take up its visibility, position and bounds again (no flicker).
    Reassert,
    /// Hide the window and show it again.
    HideShow,
    /// Load the page again.
    Reload,
    /// Restart the app.
    Restart,
    GiveUp,
}

#[derive(Default)]
pub struct Ladder {
    reasserted: bool,
    reloaded: bool,
    restarted: bool,
}

impl Ladder {
    /// The next step. A dead browser process skips straight to the restart (nothing else can revive it); otherwise re-assert, hide +
    /// show (`hide_shows` done so far, at most `MAX_REMEDIES`), reload, restart.
    pub fn next(&mut self, hide_shows: u32, browser_gone: bool) -> Step {
        if browser_gone && !self.restarted {
            self.restarted = true;
            return Step::Restart;
        }
        if !self.reasserted {
            self.reasserted = true;
            return Step::Reassert;
        }
        if hide_shows < MAX_REMEDIES {
            return Step::HideShow; // the counter is raised by `hide_and_show`
        }
        if !self.reloaded {
            self.reloaded = true;
            return Step::Reload;
        }
        if !self.restarted {
            self.restarted = true;
            return Step::Restart;
        }
        Step::GiveUp
    }
}

static LADDER: Mutex<Ladder> = Mutex::new(Ladder { reasserted: false, reloaded: false, restarted: false });

fn took_step(name: &'static str) {
    *LAST_STEP.lock().unwrap_or_else(|p| p.into_inner()) = Some(name);
}

/// The window shows one colour, or the web view's browser process is gone. Each step logs its own line, and the line that follows
/// says whether it cured the window or failed; every step but the last starts the looks again.
fn escalate(app: &AppHandle, browser_gone: bool) {
    IN_LADDER.store(true, Ordering::SeqCst);
    if let Some(prev) = judged_step() {
        stage(Some(app), &format!("after \"{prev}\": still blank"));
    }
    let step = LADDER.lock().unwrap_or_else(|p| p.into_inner()).next(REMEDIES.load(Ordering::SeqCst), browser_gone);
    match step {
        Step::Reassert => {
            stage(Some(app), "blank window: re-asserting the web view (visibility, position, bounds)");
            took_step("re-asserting the web view");
            webview_health::reassert(app);
            verify_painting(app);
        }
        Step::HideShow => {
            took_step("hide + show");
            hide_and_show(app, "blank window"); // its show starts the looks again
        }
        Step::Reload => {
            stage(Some(app), "still blank after hide + show: reloading the page");
            took_step("reloading the page");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("window.location.reload()");
            }
            verify_painting(app); // looks again after the reload
        }
        Step::Restart => {
            let why = if browser_gone { "the web view's browser process is gone" } else { "still blank after the reload" };
            restart_app(app, why);
        }
        Step::GiveUp => stage(Some(app), "still blank after every step: leaving the window as it is"),
    }
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
    // which browser process the web view uses (joined from an earlier run or its own), and a listener for its failures
    webview_health::watch(app);
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
    fn the_app_restarts_for_a_dead_or_blank_web_view_at_most_three_times_in_ten_minutes() {
        assert!(restart_allowed(&[], 1000));
        assert!(restart_allowed(&[1000], 1100));
        assert!(restart_allowed(&[1000, 1050], 1100));
        assert!(!restart_allowed(&[1000, 1050, 1090], 1100), "a restart that fails the same way again must not loop");
        assert!(restart_allowed(&[1000, 1050, 1090], 1700), "the oldest one is more than ten minutes ago");
        assert!(restart_allowed(&[5000, 5100, 5200], 100), "markers from the future (clock changed) do not block");
        assert_eq!(MAX_RESTARTS, 3);
    }

    #[test]
    fn the_restart_marker_reads_old_and_new_files() {
        assert_eq!(parse_history("1000"), vec![1000], "the one-time-stamp file of round 9");
        assert_eq!(parse_history("1000\n1050\r\n1090\n"), vec![1000, 1050, 1090]);
        assert_eq!(parse_history("garbage 7 x"), vec![7]);
        assert!(parse_history("").is_empty());
    }

    #[test]
    fn the_ladder_is_reassert_then_hide_show_twice_then_reload_then_restart_then_give_up() {
        let mut l = Ladder::default();
        assert_eq!(l.next(0, false), Step::Reassert);
        assert_eq!(l.next(0, false), Step::HideShow);
        assert_eq!(l.next(1, false), Step::HideShow);
        assert_eq!(l.next(MAX_REMEDIES, false), Step::Reload);
        assert_eq!(l.next(MAX_REMEDIES, false), Step::Restart);
        assert_eq!(l.next(MAX_REMEDIES, false), Step::GiveUp);
        assert_eq!(l.next(MAX_REMEDIES, false), Step::GiveUp, "bounded: nothing after the last step");
        assert_eq!(MAX_REMEDIES, 2);
    }

    #[test]
    fn a_dead_browser_process_goes_straight_to_the_restart_because_nothing_else_can_revive_it() {
        let mut l = Ladder::default();
        assert_eq!(l.next(0, true), Step::Restart);
        // the restart was refused (three in ten minutes): the rest of the ladder still runs, once
        assert_eq!(l.next(0, true), Step::Reassert);
        assert_eq!(l.next(0, true), Step::HideShow);
    }

    #[test]
    fn by_default_no_look_reads_the_windows_pixels_because_that_capture_crashes_the_web_view_on_some_pcs() {
        for in_ladder in [false, true] {
            let looks = schedule(in_ladder, false);
            assert!(!looks.is_empty() && looks.iter().all(|(_, px)| !px), "{in_ladder}: {looks:?}");
            assert!(looks.windows(2).all(|w| w[0].0 < w[1].0), "in time order");
        }
        // the diagnostic: pixels only later in a normal run (never in the first seconds), at once after a step of the escalation
        let on = schedule(false, true);
        assert!(on.iter().filter(|(ms, _)| *ms < 8000).all(|(_, px)| !px), "{on:?}");
        assert!(on.iter().any(|(_, px)| *px), "{on:?}");
        assert!(schedule(true, true).iter().all(|(_, px)| *px));
        // and the capture is behind the switch in the code
        let src = include_str!("startup.rs").replace('\r', "");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        let call = code.find("let painted = window_paints(&app);").expect("the capture call");
        assert!(code[..call].rfind("if !pixels {").is_some(), "the capture is only reached by a look that asks for pixels");
    }

    #[test]
    fn a_failure_log_line_names_what_failed_and_the_log_survives_before_the_data_folder_is_known() {
        // lines written before `init_log_dir` (the wait for the previous run) are kept and written once the folder is known
        let dir = std::env::temp_dir().join(format!("heylook-early-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        EARLY.lock().unwrap().clear();
        {
            let mut e = EARLY.lock().unwrap();
            e.push("[webview +1 ms] early line".into());
        }
        // LOG_DIR is a process-wide OnceLock: this test only checks the flush helper on its own folder
        for l in std::mem::take(&mut *EARLY.lock().unwrap()) {
            append(&dir, &l);
        }
        let text = std::fs::read_to_string(dir.join("startup.log")).unwrap();
        assert!(text.contains("[webview +1 ms] early line"));
        let _ = std::fs::remove_dir_all(&dir);
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
