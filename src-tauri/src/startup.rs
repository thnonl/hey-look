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
//!
//! 1.0.6: the end of every one of those roads (the page never reports itself, the restart is refused, nothing brings a dead page
//! back) is no longer a blank window and a line in the log: the person gets a native message box that says the app could not
//! load its interface and why that usually is, with Retry, Open log folder and Quit (`loadfail.rs` is the state machine; the
//! texts are the Rust ones of `i18n`, since the page is what is missing).
//!
//! 1.0.7 (D-057): a window that is shown from the tray can be WHITE although everything above says it is fine (owner, 1.0.6, after a
//! restart of the machine: the autostarted app was opened 53 s later, the log said "the web view is running ... visible", "page state
//! after show: visibility=visible, animation frames=true", no cure ran). The page reports `visible` and gets frames in that window
//! too, and the browser process is alive: only the pixels tell. So the looks after a show now include one that reads the pixels of the
//! window FROM THE SCREEN (`screen_probe`): what the desktop compositor shows, with a copy that never reaches the web view's processes
//! (the `PrintWindow` read of round 10 asked the browser process to render, and that is what crashed it with an overlay hook). Points
//! covered by another window are left out, a window that is not on screen (cloaked, minimized, locked desktop) gives no verdict. A
//! window of one colour 1 s after the show, or at any look after a cure, walks the ladder below: re-assert the web view, nudge its size
//! by 1 px, hide + show, reload, restart; every step logs a line and the look that follows says which one cured it.
//!
//! 1.0.7 (fix12, owner: "can the app show a loading indicator instead of an empty white window?"): the window and the web view now have the
//! colour of the theme from the first frame (`bgcolor.rs`) and index.html draws a start screen (the logo on that colour) until the app mounts.
//! That start screen is ONE colour on more than 95 % of the points, which is the definition of a blank window above. So a look only calls
//! one-colour "blank" while the page of this load has reported itself (`page_is_up`): a page that has not is showing its start screen, the
//! ready wait above is what deals with a page that never comes (reload, then the error message), and a cure (re-assert, nudge, hide + show,
//! reload, restart) would only fight a page that is still loading. A page that has reported itself replaced the start screen, so one colour
//! after that is a blank window, as before.
// (the restart, the failure reaction and the escalation need the Windows web view's events: other systems compile them unused)
#![cfg_attr(not(windows), allow(dead_code))]
use crate::webview_health::{self, BrowserState, Reaction};
use crate::{i18n, loadfail};
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
/// How many page loads reported themselves ready (the UI does it once per load): a page that came back after its process died counts again.
static READY_COUNT: AtomicU32 = AtomicU32::new(0);
/// The page of the CURRENT load has reported itself ready (set by `mark_ready`, cleared whenever the page is loaded again or its process died). Until
/// then the window shows the start screen of index.html, which is not a blank window (see the 1.0.7 note at the top).
static PAGE_UP: AtomicBool = AtomicBool::new(false);
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

/// The data folder of the log, once it is known.
pub fn log_dir() -> Option<std::path::PathBuf> {
    LOG_DIR.get().cloned()
}

pub fn init_log_dir(dir: std::path::PathBuf) {
    if LOG_DIR.set(dir.clone()).is_ok() {
        let early = std::mem::take(&mut *EARLY.lock().unwrap_or_else(|p| p.into_inner()));
        for l in early {
            append(&dir, &l);
        }
    }
}

fn append(dir: &std::path::Path, line: &str) {
    let mut keep = HEAD.lock().unwrap_or_else(|p| p.into_inner()).clone();
    for p in PINNED.lock().unwrap_or_else(|p| p.into_inner()).iter() {
        if !keep.contains(p) {
            keep.push(p.clone());
        }
    }
    append_pinned(dir, line, &keep);
}

/// The first lines this run wrote (how it was started, what it found, the first stages of its window): they stay at the top of `startup.log` when it starts
/// over at its size cap. 1.0.8: the owner's log of the 1.0.7 update relaunch had started over about 100 s into the run (a log that is only cut when it is
/// written to had carried the old run's lines to the cap), so every line about how that run began, the one thing the white window needed, was gone.
static HEAD: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// How many lines of a run's beginning are kept (a few KB).
const HEAD_LINES: usize = 30;

/// Appends `line`; a log that has grown past `LOG_CAP` starts over, with the `pinned` lines (those of this run that a reader of the file still needs) at its top.
fn append_pinned(dir: &std::path::Path, line: &str, pinned: &[String]) {
    let path = dir.join("startup.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            for p in pinned.iter().filter(|p| p.as_str() != line) {
                let _ = writeln!(f, "{p}");
            }
            if !pinned.is_empty() {
                let _ = writeln!(f, "[log] the log reached {} KB and started over here: the lines above are the first lines of this run", LOG_CAP / 1024);
            }
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// Lines that stay in `startup.log` when it starts over at its cap (see `line_pinned`).
static PINNED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// One line per event: `[tag +ms]` (milliseconds since the process started), on stderr and in `<data folder>/startup.log` (capped).
pub fn line(tag: &str, what: &str) {
    let ms = T0.get_or_init(Instant::now).elapsed().as_millis();
    emit(format!("[{tag} +{ms} ms] {what}"));
}

fn emit(line: String) {
    eprintln!("{line}");
    {
        let mut head = HEAD.lock().unwrap_or_else(|p| p.into_inner());
        if head.len() < HEAD_LINES {
            head.push(line.clone());
        }
    }
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

/// Like `line`, and the line is kept when the log starts over at its size cap: a reader that needs it (a script that finds the port of a QA run in the log) would else
/// find a log of two lines after a long session. Few lines only (a handful per run).
#[cfg(debug_assertions)]
pub fn line_pinned(tag: &str, what: &str) {
    let ms = T0.get_or_init(Instant::now).elapsed().as_millis();
    let text = format!("[{tag} +{ms} ms] {what}");
    emit(text.clone());
    let mut p = PINNED.lock().unwrap_or_else(|p| p.into_inner());
    if p.len() < 8 {
        p.push(text);
    }
}

/// How this process was started, for the first line of its log: version, process id, program, arguments, the start-up information it was given and who started it
/// (Windows: the installer's `RunAsUser` after an update, the autostart entry, Explorer, a shell). The white window after the 1.0.7 update relaunch could not
/// be told from any other start because nothing said how the new process had been started.
pub fn launch_description() -> String {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let relaunch = std::env::var(webview_health::RELAUNCH_ENV).map(|v| format!(", a restart of pid {v}")).unwrap_or_default();
    format!("Hey Look! {} started: pid {}, program {exe}, arguments {args:?}{}{relaunch}", env!("CARGO_PKG_VERSION"), std::process::id(), webview_health::launcher_text())
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

/// A look since the last show found the window painted (more than one colour on the points that are its own). Until then a person who asks for the window
/// again (tray click, second start, notification) starts the looks again, whether the window is hidden or already on screen: the white window of the 1.0.7
/// update relaunch was cured by exactly that click, and the app now does the same by itself.
static PAINT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// Whether a look has found the shown window painted since it was shown (see `PAINT_CONFIRMED`).
pub fn paint_confirmed() -> bool {
    PAINT_CONFIRMED.load(Ordering::SeqCst)
}

/// Whether a show of the main window starts the looks at its pixels: a window that was hidden or minimized, and one that is on screen while no look has
/// found it painted yet (the tray click that cured the white window of the 1.0.7 update relaunch). A window that a look found painted costs nothing more. Pure,
/// for the test.
pub fn looks_wanted(was_hidden: bool, was_minimized: bool, paint_confirmed: bool) -> bool {
    was_hidden || was_minimized || !paint_confirmed
}

/// Whether the page of the current load has reported itself (false again while it is being loaded anew).
pub fn page_is_up() -> bool {
    PAGE_UP.load(Ordering::SeqCst)
}

/// The page is being loaded again (a reload, a new address) or its process died: what shows now is the start screen until it reports itself.
fn page_loading() {
    PAGE_UP.store(false, Ordering::SeqCst);
}

/// The page is up (sent once per page load by the UI).
pub fn mark_ready(app: &AppHandle) {
    READY_COUNT.fetch_add(1, Ordering::SeqCst);
    PAGE_UP.store(true, Ordering::SeqCst);
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

/// What a look at the pixels of the shown window found.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Paint {
    /// More than one colour: the page is on screen.
    Painted,
    /// One colour over the whole area (the web view's background, or black): nothing of the page is on screen.
    Blank,
    /// One colour over the whole area, and the page of this load has not reported itself: this is the start screen of index.html (the logo is
    /// under 5 % of the points) or a page that is still loading, not a blank window. Never cured here (`with_page_state`).
    Starting,
    /// No verdict (the window is not on screen, other windows cover it, the copy failed).
    Unknown,
}

/// The share of the sampled points one colour must reach for the area to count as blank. A web view that is not presented shows its one
/// background colour everywhere (measured: 100 %, or 97.4 % when the taskbar lies over a hit-test transparent strip of the window's own area); a
/// real screen has a side bar, a list and text, and none of them is 95 % one colour (the dark QA screen: 40 to 47 %).
pub const BLANK_SHARE: f64 = 0.95;
/// At least this share of the grid points must lie on the window itself (not on a window in front of it) for a look to be a verdict.
pub const OWNED_SHARE: f64 = 0.6;
/// The grid of points that are read: columns x rows over the client area (2560 points: the copy is the cost, not the count).
pub const GRID: (usize, usize) = (64, 40);

/// The verdict and the numbers behind it (they go to `startup.log`).
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Judged {
    pub paint: Paint,
    /// The share of the points that have the most common colour.
    pub top_share: f64,
    pub top: [u8; 3],
    pub colours: usize,
}

/// Judge the sampled points (`asked` = how many points were meant to be read; the rest lay on other windows). Pure, for the test.
pub fn judge(samples: &[[u8; 3]], asked: usize) -> Judged {
    let mut counts: std::collections::HashMap<[u8; 3], usize> = std::collections::HashMap::new();
    for &p in samples {
        *counts.entry(p).or_insert(0) += 1;
    }
    let (top, n) = counts.iter().max_by_key(|(c, n)| (**n, std::cmp::Reverse(**c))).map(|(c, n)| (*c, *n)).unwrap_or(([0, 0, 0], 0));
    let top_share = if samples.is_empty() { 0.0 } else { n as f64 / samples.len() as f64 };
    let enough = !samples.is_empty() && asked > 0 && samples.len() as f64 >= asked as f64 * OWNED_SHARE;
    let paint = if !enough {
        Paint::Unknown
    } else if top_share >= BLANK_SHARE {
        Paint::Blank
    } else {
        Paint::Painted
    };
    Judged { paint, top_share, top, colours: counts.len() }
}

/// What a one-colour look means once it is known whether the page of this load is up: before that it is the start screen (`Paint::Starting`),
/// after it a blank window. Every other verdict stays as it is. Pure, for the test.
pub fn with_page_state(mut j: Judged, page_up: bool) -> Judged {
    if j.paint == Paint::Blank && !page_up {
        j.paint = Paint::Starting;
    }
    j
}

/// The points that are read: `cols` x `rows` evenly spread over a `w` x `h` area, 4 px in from its edges. Pure, for the test.
pub fn grid_points(w: i32, h: i32, cols: usize, rows: usize) -> Vec<(i32, i32)> {
    if w < 16 || h < 16 || cols < 2 || rows < 2 {
        return vec![];
    }
    let mut out = Vec::with_capacity(cols * rows);
    for j in 0..rows {
        for i in 0..cols {
            out.push((4 + (w - 9) * i as i32 / (cols as i32 - 1), 4 + (h - 9) * j as i32 / (rows as i32 - 1)));
        }
    }
    out
}

/// One look after a show: when (ms after the show), whether it reads the screen, and whether it reads with `PrintWindow` (the diagnostic).
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Look {
    pub ms: u64,
    pub screen: bool,
    pub print: bool,
}

/// When, after a window was shown, the web view is looked at. Every look asks the process and the window manager (is the browser process
/// there, is the web view's own window there, how big, visible?); the first three also read the screen (300 ms, 1 s, 3 s: D-057).
///
/// QA BUG-11 (evidence in `webview_health.rs`): reading the window's pixels with `PrintWindow(PW_RENDERFULLCONTENT)`, the way a
/// screenshot does, asks the web view's browser process to render the window for the capture. On the QA PC, where a graphics overlay
/// hook (`RTSSHooks64.dll`) sits in that process, the call stalled for 0.3 to 0.9 s and the browser process crashed (an access violation
/// in the hook) in 3 of 3 blank starts of round 6, exactly at the capture 2.5 s after the show; the window stayed white for good. The
/// check that was meant to find a blank window was making it. So `PrintWindow` stays a diagnostic that is switched on with
/// `HEYLOOK_PIXEL_CHECK=1`; the default read copies from the SCREEN (`GetDC(NULL)` + `BitBlt`), which is the desktop compositor's output
/// and sends the browser process nothing.
const LOOKS_MS: [u64; 6] = [300, 1000, 3000, 8000, 15000, 30000];
/// How many of `LOOKS_MS` read the screen. 1.0.8: all of them. The read is a copy of 2560 points from the screen (a few ms) and a look that found "no verdict"
/// (the window was covered by the installer's own window, by another program, or not on this desktop yet) used to be the last one that read pixels: a window that
/// was white when it came to the front at 8 s was never looked at again (the tray click that cured it for the owner was the second look the code never made).
const SCREEN_LOOKS: usize = 6;
/// After a step of the escalation (it needs an answer sooner).
const STEP_LOOKS_MS: [u64; 2] = [700, 2000];
/// A blank window is left alone at the first look (a window that was just shown may need a moment); from this look on it is cured.
pub const CURE_FROM_MS: u64 = 1000;

/// Whether the diagnostic `PrintWindow` read is on (`HEYLOOK_PIXEL_CHECK=1`).
fn pixel_check_enabled() -> bool {
    std::env::var("HEYLOOK_PIXEL_CHECK").is_ok_and(|v| v == "1")
}

/// The looks of a run. The screen is read at the first three looks (every look of the escalation); `PrintWindow` only when the diagnostic is
/// on, and never in the first seconds of a normal run.
pub fn schedule(in_ladder: bool, print_on: bool) -> Vec<Look> {
    let times: &[u64] = if in_ladder { &STEP_LOOKS_MS } else { &LOOKS_MS };
    times
        .iter()
        .enumerate()
        .map(|(i, &ms)| Look { ms, screen: in_ladder || i < SCREEN_LOOKS, print: print_on && (in_ladder || ms >= 8000) })
        .collect()
}

/// Whether a look that found `seen` starts the next step of the escalation: a blank window at 1 s or later, and any blank window after a
/// step (the look that judges it). Pure, for the test.
pub fn cure_needed(in_ladder: bool, ms: u64, seen: Paint) -> bool {
    seen == Paint::Blank && (in_ladder || ms >= CURE_FROM_MS)
}

/// Whether a look that could not judge the window (no verdict: covered, not on screen yet; or the start screen of a page that has not reported itself) asks the web
/// view once to take up its visibility, position and bounds again. It is the first, flicker-free step of the escalation, and a window nobody can judge never
/// reaches the ladder: 1.0.8, for the white window that stayed white until a tray click. Once per show, from the look at 1 s on. Pure, for the test.
pub fn blind_reassert_due(ms: u64, seen: Paint, done: bool) -> bool {
    !done && ms >= CURE_FROM_MS && matches!(seen, Paint::Unknown | Paint::Starting)
}

/// Set once the escalation has started: later looks use `STEP_LOOKS_MS`.
static IN_LADDER: AtomicBool = AtomicBool::new(false);
/// Steps of the escalation taken since the window last showed content.
static STEPS_TAKEN: AtomicU32 = AtomicU32::new(0);
/// The step taken last, until a look says whether it helped.
static LAST_STEP: Mutex<Option<&'static str>> = Mutex::new(None);
/// Raised by every `verify_painting`: a look thread whose number is no longer the latest ends (a second show while it still waits).
static LOOK_GEN: AtomicU32 = AtomicU32::new(0);

/// The step the last escalation took, if no look has judged it yet (taken: it is judged once).
fn judged_step() -> Option<&'static str> {
    LAST_STEP.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// The window showed content: the next blank window starts the ladder from its first step again (a run that is open for weeks shows its
/// window many times; the limits that must hold for ever are those of the restarts, `restart_allowed`).
fn ladder_done() {
    if IN_LADDER.swap(false, Ordering::SeqCst) {
        *LADDER.lock().unwrap_or_else(|p| p.into_inner()) = Ladder::default();
        REMEDIES.store(0, Ordering::SeqCst);
    }
    STEPS_TAKEN.store(0, Ordering::SeqCst);
}

/// The text of a look at the screen for `startup.log`.
pub fn describe(j: &Judged, took_ms: u128) -> String {
    let pct = (j.top_share * 100.0).round();
    match j.paint {
        Paint::Painted => format!("the window shows content (most common colour {pct} %, {} colours, read in {took_ms} ms)", j.colours),
        Paint::Blank => format!("one colour only (rgb {},{},{} on {pct} % of the points, {} colours): a blank window; read in {took_ms} ms", j.top[0], j.top[1], j.top[2], j.colours),
        Paint::Starting => format!("one colour (rgb {},{},{} on {pct} % of the points, {} colours): the start screen, the page has not reported itself yet; no cure; read in {took_ms} ms", j.top[0], j.top[1], j.top[2], j.colours),
        Paint::Unknown => "no verdict (too few points of the window are on screen)".into(),
    }
}

/// Look at the web view at the times of `schedule` after the window was shown, on its own thread: a browser process that is gone, or a
/// window of one colour, starts the escalation. A healthy window is only looked at.
pub fn verify_painting(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    let mine = LOOK_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    PAINT_CONFIRMED.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let in_ladder = IN_LADDER.load(Ordering::SeqCst);
        let looks = schedule(in_ladder, pixel_check_enabled());
        let mut at = 0;
        let mut blind_reasserted = false;
        for look in looks {
            let ms = look.ms;
            std::thread::sleep(Duration::from_millis(ms - at));
            at = ms;
            if LOOK_GEN.load(Ordering::SeqCst) != mine {
                return; // the window was shown again meanwhile: that show has its own looks
            }
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
            let mut seen = Paint::Unknown;
            let mut said = String::new();
            for (read, on) in [(Capture::Screen, look.screen), (Capture::Print, look.print)] {
                if !on {
                    continue;
                }
                let started = Instant::now();
                let (j, why) = look_at(&app, read);
                let text = match j {
                    Some(j) => describe(&with_page_state(j, page_is_up()), started.elapsed().as_millis()),
                    None => format!("no verdict ({})", why.unwrap_or_default()),
                };
                let verdict = j.map_or(Paint::Unknown, |j| with_page_state(j, page_is_up()).paint);
                said.push_str(&format!("; {}: {text}", if read == Capture::Screen { "screen" } else { "PrintWindow" }));
                // a blank read wins over a read that found content (the diagnostic exists to catch what the other misses)
                if verdict == Paint::Blank || (verdict == Paint::Painted && seen != Paint::Blank) {
                    seen = verdict;
                }
            }
            let line = format!("native check at {ms} ms: the web view is running (browser process {}; {child}){said}", state.text());
            match seen {
                Paint::Painted => {
                    let cured = judged_step().map(|s| format!(" (cured by: {s})")).unwrap_or_default();
                    stage(Some(&app), &format!("{line}{cured}"));
                    PAINT_CONFIRMED.store(true, Ordering::SeqCst);
                    ladder_done();
                }
                Paint::Blank => {
                    stage(Some(&app), &line);
                    if cure_needed(in_ladder, ms, seen) {
                        escalate(&app, false);
                        return;
                    }
                }
                // the start screen: the page is not up yet, the ready wait deals with it (and the looks of a later show read the page itself)
                Paint::Unknown | Paint::Starting => {
                    stage(Some(&app), &line);
                    if blind_reassert_due(ms, seen, blind_reasserted) {
                        blind_reasserted = true;
                        stage(Some(&app), "no verdict on the window yet: re-asserting the web view once (visibility, position, bounds)");
                        webview_health::reassert(&app);
                    }
                }
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
    restart_app_with(app, why, false);
}

/// `force`: the person asked for it (Retry in the error dialog), so the limit of `MAX_RESTARTS` does not apply (it is still recorded).
fn restart_app_with(app: &AppHandle, why: &str, force: bool) {
    if RESTARTING.swap(true, Ordering::SeqCst) || EXITING.load(Ordering::SeqCst) {
        return;
    }
    let marker = LOG_DIR.get().map(|d| d.join("blank-restart.txt"));
    let history = marker.as_ref().and_then(|m| std::fs::read_to_string(m).ok()).map(|t| parse_history(&t)).unwrap_or_default();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    if !force && !restart_allowed(&history, now) {
        stage(Some(app), &format!("{why}: the app already restarted {MAX_RESTARTS} times in the last ten minutes: leaving the window as it is"));
        RESTARTING.store(false, Ordering::SeqCst);
        report_dead_page(app, "no more restarts allowed");
        return;
    }
    let mut kept: Vec<i64> = history.into_iter().filter(|&t| now >= t && now - t <= RESTART_WINDOW_S).collect();
    stage(Some(app), &format!("{why}: restarting the app (restart {} of {MAX_RESTARTS} allowed in ten minutes; messages in their Undo time are kept in the outbox)", kept.len() + 1));
    kept.push(now);
    if let Some(m) = &marker {
        let _ = std::fs::write(m, kept.iter().map(|t| t.to_string()).collect::<Vec<_>>().join("\n"));
    }
    // closing the web view during the restart ends its processes: that is no failure to report
    mark_exiting();
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
    if !matches!(webview_health::reaction(kind), Reaction::LogOnly) {
        page_loading(); // (a page process that died: the page comes back through a reload)
    }
    stage(Some(app), &format!("web view: {what}{}", if detail.is_empty() { String::new() } else { format!(" ({detail})") }));
    let app = app.clone();
    match webview_health::reaction(kind) {
        Reaction::Restart => {
            std::thread::spawn(move || restart_app(&app, "the web view's browser process is gone"));
        }
        Reaction::Reload => {
            std::thread::spawn(move || recover_dead_page(&app, "a page process of the web view died"));
        }
        Reaction::LogOnly => {}
    }
}

/// The page is gone (its process died) or does not answer: bring it back with the remedies of `recover_page`, at most `MAX_PAGE_RELOADS`
/// times per run. Blocks until the page is back or every remedy was tried, so it runs on its own thread.
pub fn recover_dead_page(app: &AppHandle, why: &str) {
    if PAGE_RELOADS.fetch_add(1, Ordering::SeqCst) < MAX_PAGE_RELOADS {
        stage(Some(app), &format!("{why}: reloading the page"));
        let before = READY_COUNT.load(Ordering::SeqCst);
        let t0 = Instant::now();
        let cured = recover_page(
            |remedy| match remedy {
                PageRemedy::Reload => reload_page(app),
                PageRemedy::Navigate => navigate_to_app(app),
                PageRemedy::Restart => restart_app(app, "the page does not come back after a reload"),
            },
            || READY_COUNT.load(Ordering::SeqCst) > before,
            std::thread::sleep,
            |said| stage(Some(app), &said),
            || t0.elapsed().as_millis(),
        );
        if cured.is_none() {
            report_dead_page(app, "the page did not come back");
        }
    } else {
        stage(Some(app), &format!("{why}: not reloading again (already {MAX_PAGE_RELOADS} times in this run)"));
        report_dead_page(app, "the page process died again");
    }
}

/// Whether the app is closing (its web view's processes then end on purpose).
pub fn is_exiting() -> bool {
    EXITING.load(Ordering::SeqCst)
}

/// What brings back a page whose process died, in order, each tried only when the one before did not work.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum PageRemedy {
    /// The web view's own reload.
    Reload,
    /// Load the app's address again (a reload of the browser's error page can fail).
    Navigate,
    /// A new process (limited like every restart).
    Restart,
}

/// How long a remedy gets before the next one is tried (the page loads in well under a second when it works).
pub const PAGE_BACK_WAIT: Duration = Duration::from_secs(5);

/// Apply the remedies in order until the page has reported itself ready again (`back`), and say in the log what cured it or that
/// nothing did. `elapsed_ms` is the time since the page died. Returns the remedy that worked.
pub fn recover_page(
    mut apply: impl FnMut(PageRemedy),
    back: impl Fn() -> bool,
    mut sleep: impl FnMut(Duration),
    mut said: impl FnMut(String),
    elapsed_ms: impl Fn() -> u128,
) -> Option<PageRemedy> {
    let tick = Duration::from_millis(50);
    for (n, remedy) in [PageRemedy::Reload, PageRemedy::Navigate, PageRemedy::Restart].into_iter().enumerate() {
        if n > 0 {
            said(format!("the page did not come back within {} s: {}", PAGE_BACK_WAIT.as_secs(), match remedy {
                PageRemedy::Navigate => "loading the app's address again",
                _ => "restarting the app",
            }));
        }
        apply(remedy);
        let mut waited = Duration::ZERO;
        while waited < PAGE_BACK_WAIT {
            if back() {
                said(format!("the page is back {} ms after it died (cured by: {})", elapsed_ms(), match remedy {
                    PageRemedy::Reload => "reload",
                    PageRemedy::Navigate => "loading the app's address again",
                    PageRemedy::Restart => "restart",
                }));
                return Some(remedy);
            }
            sleep(tick);
            waited += tick;
        }
    }
    said("the page did not come back after a reload, loading the address again and a restart: leaving the window as it is".into());
    None
}

/// Load the page again with the web view's own reload. A script (`window.location.reload()`) cannot do this for a page whose
/// process is gone: there is nothing to run it in, and the call returns without an error (QA BUG-15, proven with a real web view in
/// `webview_health.rs`).
fn reload_page(app: &AppHandle) {
    page_loading();
    match app.get_webview_window("main").map(|w| w.reload()) {
        Some(Ok(())) => {}
        Some(Err(e)) => stage(Some(app), &format!("could not reload the page: {e}")),
        None => stage(Some(app), "could not reload the page: no window"),
    }
}

/// Load the address the page was loaded from again.
fn navigate_to_app(app: &AppHandle) {
    page_loading();
    let Some(w) = app.get_webview_window("main") else { return };
    match w.url().map(|u| w.navigate(u)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) | Err(e) => stage(Some(app), &format!("could not load the page's address again: {e}")),
    }
}

/// The address the main window loads (`WebviewUrl::App`), worked out the way Tauri does: the dev server in a dev build, a frontend given as a
/// URL, else the app protocol (`tauri://localhost`; on Windows its `http://tauri.localhost` form, `https` when the window asks for it). The web
/// view's own `url()` cannot be used: until the first load has finished it is `about:blank` (found by the real test of Retry), and after a failed one it
/// can be the browser's error page.
pub fn app_address(dev: bool, dev_url: Option<&str>, dist_url: Option<&str>, windows: bool, https: bool) -> String {
    match if dev { dev_url } else { dist_url } {
        Some(u) => u.to_string(),
        None if windows => format!("{}://tauri.localhost/", if https { "https" } else { "http" }),
        None => "tauri://localhost".to_string(),
    }
}

fn configured_address(app: &AppHandle) -> Option<tauri::Url> {
    let cfg = app.config();
    let dist = match cfg.build.frontend_dist.as_ref() {
        Some(tauri::utils::config::FrontendDist::Url(u)) => Some(u.to_string()),
        _ => None,
    };
    let https = cfg.app.windows.iter().find(|w| w.label == "main").is_some_and(|w| w.use_https_scheme);
    let dev_url = cfg.build.dev_url.as_ref().map(|u| u.to_string());
    tauri::Url::parse(&app_address(tauri::is_dev(), dev_url.as_deref(), dist.as_deref(), cfg!(windows), https)).ok()
}

/// Load the app's own address again (Retry in the error dialog).
fn navigate_home(app: &AppHandle) {
    page_loading();
    let Some(w) = app.get_webview_window("main") else { return };
    let Some(url) = configured_address(app) else {
        stage(Some(app), "could not load the app's address again: no address");
        return;
    };
    stage(Some(app), &format!("loading the app's address again: {url}"));
    if let Err(e) = w.navigate(url) {
        stage(Some(app), &format!("could not load the app's address again: {e}"));
    }
}

/// The steps of the escalation for a window that shows nothing, in order, each at most once (hide + show twice).
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Step {
    /// Tell the web view controller to take up its visibility, position and bounds again (no flicker).
    Reassert,
    /// Change the web view's size by 1 px and back (a surface that was not presented again takes up its size anew).
    Nudge,
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
    nudged: bool,
    reloaded: bool,
    restarted: bool,
}

impl Ladder {
    /// The next step. A dead browser process skips straight to the restart (nothing else can revive it); otherwise re-assert, nudge, hide +
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
        if !self.nudged {
            self.nudged = true;
            return Step::Nudge;
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

static LADDER: Mutex<Ladder> = Mutex::new(Ladder { reasserted: false, nudged: false, reloaded: false, restarted: false });

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
    if !matches!(step, Step::Restart | Step::GiveUp) {
        STEPS_TAKEN.fetch_add(1, Ordering::SeqCst);
    }
    match step {
        Step::Reassert => {
            stage(Some(app), "blank window: re-asserting the web view (visibility, position, bounds)");
            took_step("re-asserting the web view");
            webview_health::reassert(app);
            verify_painting(app);
        }
        Step::Nudge => {
            stage(Some(app), "still blank: changing the web view's size by 1 px and back");
            took_step("changing the web view's size by 1 px and back");
            webview_health::nudge(app);
            verify_painting(app);
        }
        Step::HideShow => {
            took_step("hide + show");
            hide_and_show(app, "blank window"); // its show starts the looks again
        }
        Step::Reload => {
            stage(Some(app), "still blank after hide + show: reloading the page");
            took_step("reloading the page");
            reload_page(app);
            verify_painting(app); // looks again after the reload
        }
        Step::Restart => {
            let why = if browser_gone { "the web view's browser process is gone" } else { "still blank after the reload" };
            restart_app(app, why);
        }
        Step::GiveUp => {
            stage(Some(app), "still blank after every step: leaving the window as it is");
            report_dead_page(app, "the window stays blank");
        }
    }
}

/// How the pixels of the window are read.
#[derive(Debug, PartialEq, Clone, Copy)]
enum Capture {
    /// Copied from the screen: what the desktop compositor shows (default; nothing is sent to the web view's processes).
    Screen,
    /// `PrintWindow`: the browser process renders the window (the diagnostic, `HEYLOOK_PIXEL_CHECK=1`).
    Print,
}

/// Read the window's pixels the way `how` says and judge them. `(None, reason)` when the pixels could not be read at all.
fn look_at(app: &AppHandle, how: Capture) -> (Option<Judged>, Option<String>) {
    #[cfg(all(windows, debug_assertions))]
    if how == Capture::Screen {
        fault::before_look(app);
    }
    match capture_samples(app, how) {
        Ok((samples, asked)) => (Some(judge(&samples, asked)), None),
        Err(why) => (None, Some(why)),
    }
}

/// The longest a QA switch may hold the page back.
const BOOT_DELAY_MAX_MS: u64 = 120_000;

/// `HEYLOOK_TEST_BOOT_DELAY_MS` as a number of milliseconds (a number only, at most two minutes; anything else is 0 = off). Pure, for the test.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn boot_delay_ms_from(v: Option<&str>) -> u64 {
    v.map(str::trim).filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0).min(BOOT_DELAY_MAX_MS)
}

/// How many page loads of a window the QA switch holds back (`HEYLOOK_TEST_BOOT_DELAY_LOADS`, default 2, at most 10): the ready wait shows the window after
/// `READY_WAIT` and loads the page again, so with 2 the window is shown with the start screen, the page is loaded again (held again) and the third load mounts at
/// once. Pure, for the test.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn boot_delay_loads_from(v: Option<&str>) -> u32 {
    v.map(str::trim).filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse::<u32>().ok()).unwrap_or(2).min(10)
}

/// Debug builds only: `HEYLOOK_TEST_BOOT_DELAY_MS=<ms>` holds the page back that long before it mounts the app (the start screen of index.html stays on
/// the window and the page does not report itself, so QA can look at the start screen and at the first frame, and see that no cure runs before the page
/// is up). Use more than `READY_WAIT` (6000): the window is created hidden and shown when the page is ready, or after that wait without it. Release builds
/// have none of this (cfg), and the page ignores a delay nobody set.
#[cfg(debug_assertions)]
pub fn boot_delay_ms() -> u64 {
    boot_delay_ms_from(std::env::var("HEYLOOK_TEST_BOOT_DELAY_MS").ok().as_deref())
}

/// The page side of that switch: `window.__heylookBootDelay = { ms, loads }`, an initialization script of every window (src/main.tsx holds that many loads
/// back, counted in the window's sessionStorage, which a reload keeps).
#[cfg(debug_assertions)]
pub fn boot_delay_plugin<R: tauri::Runtime>(ms: u64) -> tauri::plugin::TauriPlugin<R> {
    let loads = boot_delay_loads_from(std::env::var("HEYLOOK_TEST_BOOT_DELAY_LOADS").ok().as_deref());
    tauri::plugin::Builder::new("bootdelay").js_init_script(format!("window.__heylookBootDelay = {{ ms: {ms}, loads: {loads} }};")).build()
}

/// Debug builds only: a blank window on demand, so the cures can be proved with real pixels. `HEYLOOK_TEST_BLANK_AFTER_SHOW=<k>` hides the
/// web view (for real: the window then shows its background colour) at the first look after a show, and keeps hiding it again before every
/// look until the escalation has taken `k` steps (1 = re-assert, 2 = nudge, 3 = hide + show, 4 = the second hide + show, 5 = reload). The
/// steps before `k` are really taken and then undone by the injection; step `k` finds the web view shown again, as a cure that works would.
#[cfg(all(windows, debug_assertions))]
mod fault {
    use super::*;
    static HIDDEN: AtomicBool = AtomicBool::new(false);
    static DONE: AtomicBool = AtomicBool::new(false);

    pub fn before_look(app: &AppHandle) {
        let Some(k) = std::env::var("HEYLOOK_TEST_BLANK_AFTER_SHOW").ok().and_then(|v| v.trim().parse::<u32>().ok()).filter(|k| *k >= 1) else { return };
        if DONE.load(Ordering::SeqCst) {
            return;
        }
        let steps = STEPS_TAKEN.load(Ordering::SeqCst);
        if steps >= k {
            DONE.store(true, Ordering::SeqCst);
            webview_health::set_visible(app, true);
            stage(Some(app), &format!("test fault: the web view is shown again (the escalation has taken {steps} steps, the fault ends with step {k})"));
        } else {
            if !HIDDEN.swap(true, Ordering::SeqCst) {
                stage(Some(app), &format!("test fault: the web view is hidden on purpose (the fault ends with step {k} of the escalation)"));
            }
            webview_health::set_visible(app, false);
        }
        std::thread::sleep(Duration::from_millis(250)); // the compositor shows the change
    }
}

/// The sampled points of the window and how many were meant to be read.
#[cfg(windows)]
fn capture_samples(app: &AppHandle, how: Capture) -> Result<(Vec<[u8; 3]>, usize), String> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetClientRect, GetWindowRect, IsIconic, IsWindowVisible, WindowFromPoint, GA_ROOT};
    let hwnd = app.get_webview_window("main").ok_or("no window")?.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return Err("the window is not visible".into());
        }
        if IsIconic(hwnd).as_bool() {
            return Err("the window is minimized".into());
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0 {
            return Err("the window is cloaked (on another virtual desktop)".into());
        }
        // the screen read: the client area, where its top left corner lies on the screen; PrintWindow draws the whole window
        let mut r = RECT::default();
        let mut origin = POINT { x: 0, y: 0 };
        if how == Capture::Print {
            GetWindowRect(hwnd, &mut r).map_err(|e| e.to_string())?;
        } else {
            GetClientRect(hwnd, &mut r).map_err(|e| e.to_string())?;
            if !ClientToScreen(hwnd, &mut origin).as_bool() {
                return Err("the client area has no place on the screen".into());
            }
        }
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w < 200 || h < 200 || w > 8000 || h > 8000 {
            return Err(format!("the window is {w}x{h}"));
        }
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let copied = match how {
            // PW_RENDERFULLCONTENT (2): also draws the web view
            Capture::Print => PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(2)).as_bool(),
            // CAPTUREBLT: also layered windows, which is how the web view may be composed
            Capture::Screen => BitBlt(mem, 0, 0, w, h, Some(screen), origin.x, origin.y, ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0)).is_ok(),
        };
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, ..Default::default() };
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !copied || lines == 0 {
            return Err("the copy failed (a locked screen?)".into());
        }
        let points = grid_points(w, h, GRID.0, GRID.1);
        let asked = points.len();
        let mut out = Vec::with_capacity(asked);
        for (x, y) in points {
            // a point that lies on another window (one in front of ours) says nothing about ours
            if how == Capture::Screen {
                let at = POINT { x: origin.x + x, y: origin.y + y };
                if GetAncestor(WindowFromPoint(at), GA_ROOT) != hwnd {
                    continue;
                }
            }
            let o = (y as usize * w as usize + x as usize) * 4;
            out.push([buf[o + 2], buf[o + 1], buf[o]]);
        }
        Ok((out, asked))
    }
}

#[cfg(not(windows))]
fn capture_samples(_app: &AppHandle, _how: Capture) -> Result<(Vec<[u8; 3]>, usize), String> {
    Err("the pixel read is Windows only".into())
}

/// Only one guard talks to the person at a time: the one of the start, or one begun by `report_dead_page`.
static GUARD_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Start watching: show the window when the page is ready (`show_at_start`: not a tray-only start), reload it when it never is, and when
/// even that does not help tell the person (`loadfail::drive`).
pub fn start(app: &AppHandle, show_at_start: bool) {
    stage(Some(app), &format!("window created hidden (show at start: {show_at_start})"));
    // which browser process the web view uses (joined from an earlier run or its own), and a listener for its failures
    webview_health::watch(app);
    GUARD_ACTIVE.store(true, Ordering::SeqCst);
    crate::linuxview::watch(app);
    let app = app.clone();
    std::thread::spawn(move || {
        run_guard(&app, show_at_start, true, || READY.load(Ordering::SeqCst));
        GUARD_ACTIVE.store(false, Ordering::SeqCst);
    });
}

/// The page is gone for good although the app tried everything it does by itself (the end of `webview_health`'s roads): tell the person,
/// unless a guard is already doing so. `why` goes to the log.
pub fn report_dead_page(app: &AppHandle, why: &str) {
    if EXITING.load(Ordering::SeqCst) {
        return;
    }
    if GUARD_ACTIVE.swap(true, Ordering::SeqCst) {
        stage(Some(app), &format!("{why}: the person is already being told"));
        return;
    }
    stage(Some(app), &format!("{why}: the page is gone for good, telling the person"));
    let before = READY_COUNT.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        run_guard(&app, true, false, || READY_COUNT.load(Ordering::SeqCst) > before);
        GUARD_ACTIVE.store(false, Ordering::SeqCst);
    });
}

/// `loadfail::drive` with the real window, dialog and log.
fn run_guard(app: &AppHandle, show_at_start: bool, first_watch: bool, ready: impl Fn() -> bool) {
    let visible = || app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false);
    let done = loadfail::drive(first_watch, &ready, visible, std::thread::sleep, |round| ask_load_failure(app, round), |ev| on_guard_event(app, show_at_start, ev));
    if done == loadfail::Done::Quit {
        // the page that would be asked to save and send is not there: the quit runs without asking it (a message in its Undo time
        // stays in the outbox and goes out at the next start)
        crate::quit_without_page(app);
    }
}

fn on_guard_event(app: &AppHandle, show_at_start: bool, ev: loadfail::Ev) {
    use loadfail::Ev;
    match ev {
        Ev::Watch(Event::Ready { waited_ms }) => {
            if show_at_start {
                crate::shell::show_main(app);
                stage(Some(app), &format!("window shown, page ready after {waited_ms} ms"));
            } else {
                stage(Some(app), &format!("page ready after {waited_ms} ms, window stays hidden (tray start)"));
            }
        }
        Ev::Watch(Event::NoSignal { attempt, will_reload }) => {
            stage(Some(app), &format!("no ready signal within {} s (attempt {})", READY_WAIT.as_secs(), attempt + 1));
            if show_at_start && attempt == 0 {
                crate::shell::show_main(app);
                stage(Some(app), "window shown without a ready signal");
            }
            if will_reload {
                if let Some(w) = app.get_webview_window("main") {
                    page_loading();
                    let _ = w.eval("window.location.reload()");
                }
                stage(Some(app), "reloading the page");
            } else {
                stage(Some(app), "giving up: the page never reported itself");
            }
        }
        Ev::Waiting => stage(Some(app), "the window is hidden (tray start): the error about the page is shown when the window is opened"),
        Ev::ErrorShown { round } => {
            // the same words as the dialog, in English (the log is for whoever reads it with the person)
            let reason = i18n::tr_in(i18n::Lang::En, load_failed_key());
            stage(Some(app), &format!("the app could not load its interface (round {}): showing the error message. {reason}", round + 1));
        }
        Ev::OpenedLog => {
            stage(Some(app), "error message: Open log folder");
            open_log_folder(app);
        }
        Ev::Retrying { round } => {
            stage(Some(app), &format!("error message: Retry (round {})", round + 1));
            if let BrowserState::Exited(_) = webview_health::browser_state() {
                // nothing can be loaded into a dead browser process; the person asked, so the limit on restarts does not apply
                restart_app_with(app, "Retry, and the web view's browser process is gone", true);
            } else {
                navigate_home(app);
            }
        }
        Ev::LateAnswer => stage(Some(app), "the page answered after all: no error message (or its answer is ignored)"),
        Ev::Quitting => stage(Some(app), "error message: Quit"),
    }
}

fn load_failed_key() -> i18n::K {
    match std::env::consts::OS {
        "windows" => i18n::K::LoadFailWindows,
        "macos" => i18n::K::LoadFailMac,
        _ => i18n::K::LoadFailLinux,
    }
}

/// Show `startup.log` in the file manager (its folder when the file is not there yet).
fn open_log_folder(app: &AppHandle) {
    let Some(dir) = LOG_DIR.get() else { return };
    #[cfg(target_os = "linux")]
    let res = crate::linuxopen::open(&dir.to_string_lossy(), false);
    #[cfg(not(target_os = "linux"))]
    let res = {
        use tauri_plugin_opener::OpenerExt;
        let log = dir.join("startup.log");
        if log.exists() { app.opener().reveal_item_in_dir(&log) } else { app.opener().open_path(dir.to_string_lossy(), None::<&str>) }.map_err(|e| e.to_string())
    };
    if let Err(e) = res {
        stage(Some(app), &format!("could not open the log folder: {e}"));
    }
}

/// The native message box (blocks until it is answered; this runs on the guard's own thread).
fn ask_load_failure(app: &AppHandle, _round: u32) -> loadfail::Answer {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
    let (retry, open_log, quit) = (i18n::tr(i18n::K::LoadFailRetry), i18n::tr(i18n::K::LoadFailOpenLog), i18n::tr(i18n::K::LoadFailQuit));
    let log = LOG_DIR.get().map(|d| d.join("startup.log").display().to_string()).unwrap_or_default();
    let body = format!("{}\n\n{} {}", i18n::load_failed_body(std::env::consts::OS), i18n::tr(i18n::K::LoadFailLog), log);
    let mut dialog = app
        .dialog()
        .message(body)
        .title(i18n::tr(i18n::K::LoadFailTitle))
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::YesNoCancelCustom(retry.into(), open_log.into(), quit.into()));
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.parent(&w);
    }
    let label = match dialog.blocking_show_with_result() {
        MessageDialogResult::Custom(s) => s,
        MessageDialogResult::Yes => "Yes".into(),
        MessageDialogResult::No => "No".into(),
        MessageDialogResult::Ok => "Ok".into(),
        MessageDialogResult::Cancel => "Cancel".into(),
    };
    loadfail::answer_from(&label, retry, open_log, quit)
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
    fn one_colour_is_the_start_screen_until_the_page_is_up_and_a_blank_window_after() {
        // fix12: the start screen of index.html is one colour on more than 95 % of the points (the logo is a few points), the same as a blank window
        let asked = 2560;
        let mut start = vec![[27, 28, 32]; asked];
        for s in start.iter_mut().take(24) {
            *s = [15, 108, 189]; // the logo: under 1 % of the points
        }
        let j = judge(&start, asked);
        assert_eq!(j.paint, Paint::Blank, "by the pixels alone it is blank");
        assert_eq!(with_page_state(j, false).paint, Paint::Starting, "the page has not reported itself: the start screen");
        assert_eq!(with_page_state(j, true).paint, Paint::Blank, "the page reported itself and replaced the start screen: blank");
        // nothing else changes with the page state
        let ui = judge(&[[27, 28, 32], [36, 37, 42], [250, 250, 250]].repeat(800), asked);
        assert_eq!((with_page_state(ui, false).paint, with_page_state(ui, true).paint), (Paint::Painted, Paint::Painted));
        let none = judge(&[], asked);
        assert_eq!((with_page_state(none, false).paint, with_page_state(none, true).paint), (Paint::Unknown, Paint::Unknown));
        // a start screen is never cured, a blank page that is up is, from the look at 1 s
        assert!(!cure_needed(false, 3000, Paint::Starting) && !cure_needed(true, 700, Paint::Starting));
        assert!(cure_needed(false, 1000, Paint::Blank) && cure_needed(true, 700, Paint::Blank));
    }

    #[test]
    fn the_page_is_up_from_its_report_until_it_is_loaded_again() {
        // the roads that load the page again clear the flag, `mark_ready` sets it (text check: the real calls need a web view)
        let code = include_str!("startup.rs").replace('\r', "");
        let body = |from: &str| -> String { let s = &code[code.find(from).unwrap()..]; s[..s.find("\n}\n").unwrap()].to_string() };
        for f in ["fn reload_page(", "fn navigate_to_app(", "fn navigate_home("] {
            assert!(body(f).contains("page_loading();"), "{f}");
        }
        assert!(body("pub fn mark_ready(").contains("PAGE_UP.store(true"));
        assert!(body("pub fn web_view_failed(").contains("page_loading();"));
        assert!(code.contains("page_loading();\n                    let _ = w.eval(\"window.location.reload()\");"), "the guard's reload");
        // and the looks apply it to what they read
        assert!(code.matches("with_page_state(j, page_is_up())").count() >= 2);
    }

    #[test]
    fn the_boot_delay_switch_takes_a_number_of_milliseconds_and_nothing_else() {
        assert_eq!(boot_delay_ms_from(None), 0);
        assert_eq!(boot_delay_ms_from(Some("")), 0);
        assert_eq!(boot_delay_ms_from(Some("8000")), 8000);
        assert_eq!(boot_delay_ms_from(Some(" 8000 ")), 8000);
        assert_eq!(boot_delay_ms_from(Some("-1")), 0);
        assert_eq!(boot_delay_ms_from(Some("8s")), 0);
        assert_eq!(boot_delay_ms_from(Some("999999999")), 120_000, "capped");
        assert_eq!((boot_delay_loads_from(None), boot_delay_loads_from(Some("1")), boot_delay_loads_from(Some("x")), boot_delay_loads_from(Some("99"))), (2, 1, 2, 10));
        // debug builds only: the plugin and the variable are behind cfg(debug_assertions)
        let code = include_str!("startup.rs").replace('\r', "");
        assert!(code.contains("#[cfg(debug_assertions)]\npub fn boot_delay_ms()"));
        assert!(code.contains("#[cfg(debug_assertions)]\npub fn boot_delay_plugin"));
    }

    #[test]
    fn one_colour_everywhere_is_a_window_that_paints_nothing() {
        let asked = 2560;
        for c in [[0, 0, 0], [255, 255, 255], [27, 28, 32]] {
            let j = judge(&vec![c; asked], asked);
            assert_eq!((j.paint, j.top, j.colours), (Paint::Blank, c, 1), "{c:?}");
        }
        // a real screen: a side bar, a list, a few lines of text (the dark theme of the QA build: 47 % one colour, 191 colours)
        let mut ui = vec![[27, 28, 32]; 1200];
        ui.extend(vec![[36, 37, 42]; 900]);
        ui.extend(vec![[250, 250, 250]; 400]);
        ui.extend((0..60).map(|i| [i as u8, 80, 120]));
        let j = judge(&ui, asked);
        assert_eq!(j.paint, Paint::Painted);
        assert!(j.top_share < 0.5 && j.colours > 60, "{j:?}");
    }

    #[test]
    fn a_handful_of_stray_pixels_on_a_blank_window_does_not_make_it_painted_but_a_real_icon_does() {
        // 5 % of 2560 points = 128: the taskbar over a strip of the window, a cursor, an overlay icon on a window that is otherwise one colour
        let mut samples = vec![[255, 255, 255]; 2560];
        for s in samples.iter_mut().take(128) {
            *s = [20, 20, 20];
        }
        assert_eq!(judge(&samples, 2560).paint, Paint::Blank);
        for s in samples.iter_mut().take(129) {
            *s = [20, 20, 20];
        }
        assert_eq!(judge(&samples, 2560).paint, Paint::Painted, "129 points of another colour: the boundary");
        assert_eq!(BLANK_SHARE, 0.95);
    }

    #[test]
    fn a_window_that_other_windows_cover_or_that_gave_no_points_has_no_verdict_and_so_no_cure() {
        // 59 % of the points on our window: not enough to say anything, even if all of them are white
        assert_eq!(judge(&vec![[255, 255, 255]; 1510], 2560).paint, Paint::Unknown);
        assert_eq!(judge(&vec![[255, 255, 255]; 1536], 2560).paint, Paint::Blank, "60 %: enough");
        assert_eq!(judge(&[], 2560).paint, Paint::Unknown);
        assert_eq!(judge(&[[1, 2, 3]], 0).paint, Paint::Unknown);
        assert!(!cure_needed(true, 700, Paint::Unknown) && !cure_needed(false, 3000, Paint::Unknown));
    }

    #[test]
    fn the_grid_covers_the_client_area_inside_its_edges_and_is_the_same_size_for_every_window() {
        let g = grid_points(1600, 1037, GRID.0, GRID.1);
        assert_eq!(g.len(), GRID.0 * GRID.1);
        assert!(g.iter().all(|&(x, y)| (4..1600 - 4).contains(&x) && (4..1037 - 4).contains(&y)), "inside");
        assert_eq!((g[0], *g.last().unwrap()), ((4, 4), (4 + 1591, 4 + 1028)));
        assert_eq!(grid_points(960, 560, GRID.0, GRID.1).len(), GRID.0 * GRID.1);
        assert!(grid_points(10, 10, GRID.0, GRID.1).is_empty(), "a window with no area has no points");
    }

    #[test]
    fn a_blank_window_is_left_alone_for_the_first_look_and_cured_from_the_second_and_after_every_step() {
        // the looks of a show from the tray: every one of them reads the screen (1.0.8: the looks at 8, 15 and 30 s used to read nothing, so a window that was
        // covered or not on screen at the first three and white afterwards was never cured); only a blank window at 1 s or later starts a cure
        let looks = schedule(false, false);
        assert_eq!(looks.iter().map(|l| (l.ms, l.screen)).collect::<Vec<_>>(), [(300, true), (1000, true), (3000, true), (8000, true), (15000, true), (30000, true)]);
        assert!(!cure_needed(false, 300, Paint::Blank), "a window that was just shown may need a moment");
        assert!(cure_needed(false, 1000, Paint::Blank) && cure_needed(false, 3000, Paint::Blank));
        assert!(!cure_needed(false, 1000, Paint::Painted) && !cure_needed(false, 3000, Paint::Unknown), "a painted window costs nothing more");
        // after a step: the look that judges it (700 ms later) cures again at once
        assert!(cure_needed(true, 700, Paint::Blank) && !cure_needed(true, 700, Paint::Painted));
        let after = schedule(true, false);
        assert_eq!(after.iter().map(|l| (l.ms, l.screen)).collect::<Vec<_>>(), [(700, true), (2000, true)]);
        // bounded: the looks of one show are six at most, the steps of the ladder six at most (below)
        assert!(looks.len() <= 6 && after.len() <= 2);
        // a look that finds no verdict at 8 s or later still cures a blank window of the next one (no look is "the last that counts")
        assert!(cure_needed(false, 8000, Paint::Blank) && cure_needed(false, 15000, Paint::Blank) && cure_needed(false, 30000, Paint::Blank));
    }

    #[test]
    fn a_window_nobody_can_judge_is_re_asserted_once_from_the_look_at_one_second() {
        assert!(!blind_reassert_due(300, Paint::Unknown, false), "a window that was just shown may need a moment");
        assert!(blind_reassert_due(1000, Paint::Unknown, false) && blind_reassert_due(3000, Paint::Starting, false));
        assert!(!blind_reassert_due(1000, Paint::Unknown, true), "once per show");
        // a judged window never gets it from here: painted costs nothing, blank goes to the ladder (which starts with the same step)
        assert!(!blind_reassert_due(1000, Paint::Painted, false) && !blind_reassert_due(1000, Paint::Blank, false));
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
    fn the_ladder_is_reassert_then_nudge_then_hide_show_twice_then_reload_then_restart_then_give_up() {
        let mut l = Ladder::default();
        assert_eq!(l.next(0, false), Step::Reassert);
        assert_eq!(l.next(0, false), Step::Nudge);
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
        assert_eq!(l.next(0, true), Step::Nudge);
        assert_eq!(l.next(0, true), Step::HideShow);
    }

    #[test]
    fn a_window_that_showed_content_again_starts_the_next_blank_window_at_the_first_step() {
        // D-057: a run that stays open for weeks shows its window many times; one cured blank window must not use up the ladder
        let mut l = LADDER.lock().unwrap_or_else(|p| p.into_inner());
        *l = Ladder::default();
        assert_eq!(l.next(0, false), Step::Reassert);
        drop(l);
        IN_LADDER.store(true, Ordering::SeqCst);
        STEPS_TAKEN.store(3, Ordering::SeqCst);
        ladder_done();
        assert!(!IN_LADDER.load(Ordering::SeqCst) && STEPS_TAKEN.load(Ordering::SeqCst) == 0);
        assert_eq!(LADDER.lock().unwrap_or_else(|p| p.into_inner()).next(0, false), Step::Reassert);
        *LADDER.lock().unwrap_or_else(|p| p.into_inner()) = Ladder::default();
    }

    #[test]
    fn the_cures_are_bounded_six_steps_and_a_restart_that_the_history_file_limits() {
        let mut l = Ladder::default();
        let mut steps = vec![];
        let mut hide_shows = 0;
        loop {
            let s = l.next(hide_shows, false);
            if s == Step::HideShow {
                hide_shows += 1;
            }
            steps.push(s);
            if s == Step::GiveUp {
                break;
            }
            assert!(steps.len() < 12, "no end: {steps:?}");
        }
        assert_eq!(steps, [Step::Reassert, Step::Nudge, Step::HideShow, Step::HideShow, Step::Reload, Step::Restart, Step::GiveUp]);
    }

    #[test]
    fn the_default_look_copies_from_the_screen_and_never_asks_the_web_view_to_render_because_that_capture_crashes_it_on_some_pcs() {
        for in_ladder in [false, true] {
            let looks = schedule(in_ladder, false);
            assert!(!looks.is_empty() && looks.iter().all(|l| !l.print), "{in_ladder}: {looks:?}");
            assert!(looks.windows(2).all(|w| w[0].ms < w[1].ms), "in time order");
        }
        // the diagnostic: PrintWindow only later in a normal run (never in the first seconds), at every look after a step of the escalation
        let on = schedule(false, true);
        assert!(on.iter().filter(|l| l.ms < 8000).all(|l| !l.print), "{on:?}");
        assert!(on.iter().any(|l| l.print), "{on:?}");
        assert!(schedule(true, true).iter().all(|l| l.print));
        // and the code: PrintWindow is only called for `Capture::Print`, which only a look that asks for it reads; the default read is BitBlt from the screen
        let src = include_str!("startup.rs").replace('\r', "");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        let print = code.find("PrintWindow(hwnd, mem").expect("the print call");
        assert!(code[..print].rfind("Capture::Print =>").is_some() && code[print..].find("Capture::Screen => BitBlt(").is_some(), "PrintWindow sits in its own arm");
        assert!(code.contains("for (read, on) in [(Capture::Screen, look.screen), (Capture::Print, look.print)]") && code.contains("if !on {"), "each read only when its look asks for it");
        assert!(code.contains("GetDC(None)") && !code.contains("GetDC(Some("), "the screen's device context");
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
    fn a_log_that_starts_over_keeps_the_pinned_lines() {
        let dir = std::env::temp_dir().join(format!("heylook-pinned-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("startup.log"));
        let pinned = vec!["[x +1 ms] kept line".to_string()];
        append_pinned(&dir, "[x +1 ms] kept line", &pinned);
        // fill it past the cap
        for i in 0..800 {
            append_pinned(&dir, &format!("[filler +{i} ms] {}", "z".repeat(60)), &pinned);
        }
        let text = std::fs::read_to_string(dir.join("startup.log")).unwrap();
        assert!(text.len() < LOG_CAP as usize + 200, "the log was not cut: {} bytes", text.len());
        assert!(text.contains("[x +1 ms] kept line"), "the pinned line was lost");
        assert_eq!(text.matches("kept line").count(), 1, "the pinned line is there once");
        // without pinned lines the log starts over empty, as it always did
        let _ = std::fs::remove_file(dir.join("startup.log"));
        for i in 0..800 {
            append_pinned(&dir, &format!("[filler +{i} ms] {}", "z".repeat(60)), &[]);
        }
        assert!(!std::fs::read_to_string(dir.join("startup.log")).unwrap().contains("kept"));
        let _ = std::fs::remove_dir_all(&dir);
    }


    /// Runs `recover_page` with a fake clock: `back_after` says which remedy brings the page back (and after how many ticks).
    fn recover(back_after: Option<(PageRemedy, u32)>) -> (Option<PageRemedy>, Vec<PageRemedy>, Vec<String>, u32) {
        let ticks = Cell::new(0u32);
        let applied = RefCell::new(vec![]);
        let said = RefCell::new(vec![]);
        let cured_at = Cell::new(None::<u32>);
        let r = recover_page(
            |r| {
                applied.borrow_mut().push(r);
                if let Some((_, n)) = back_after.filter(|(b, _)| *b == r) {
                    cured_at.set(Some(ticks.get() + n));
                }
            },
            || cured_at.get().is_some_and(|t| ticks.get() >= t),
            |_| ticks.set(ticks.get() + 1),
            |s| said.borrow_mut().push(s),
            || (ticks.get() * 50) as u128,
        );
        (r, applied.into_inner(), said.into_inner(), ticks.get())
    }

    #[test]
    fn a_dead_page_is_reloaded_at_once_and_the_log_says_it_is_back() {
        let (r, applied, said, ticks) = recover(Some((PageRemedy::Reload, 4)));
        assert_eq!(r, Some(PageRemedy::Reload));
        assert_eq!(applied, [PageRemedy::Reload], "nothing else is tried when the reload works");
        assert_eq!(said, ["the page is back 200 ms after it died (cured by: reload)"]);
        assert_eq!(ticks, 4);
    }

    #[test]
    fn a_page_that_stays_dead_gets_the_address_again_and_then_a_restart_and_then_is_left_alone() {
        let (r, applied, said, _) = recover(Some((PageRemedy::Navigate, 2)));
        assert_eq!(r, Some(PageRemedy::Navigate));
        assert_eq!(applied, [PageRemedy::Reload, PageRemedy::Navigate]);
        assert!(said[0].contains("did not come back within 5 s") && said[0].contains("address again"), "{said:?}");
        assert!(said[1].contains("cured by: loading the app's address again"), "{said:?}");

        let (r, applied, said, ticks) = recover(Some((PageRemedy::Restart, 1)));
        assert_eq!((r, applied.len()), (Some(PageRemedy::Restart), 3));
        assert!(said.iter().any(|s| s.contains("restarting the app")), "{said:?}");
        assert_eq!(ticks, 2 * 100 + 1, "5 s per remedy at 50 ms ticks");

        let (r, applied, said, _) = recover(None);
        assert_eq!(r, None);
        assert_eq!(applied, [PageRemedy::Reload, PageRemedy::Navigate, PageRemedy::Restart]);
        assert!(said.last().unwrap().contains("leaving the window as it is"), "{said:?}");
    }

    #[test]
    fn a_dead_page_is_not_reloaded_by_a_script() {
        // BUG-15: a script cannot run in a page whose process is gone, and the call returns without an error. The reaction to a dead
        // page process and the escalation's reload use the web view's own reload.
        let code = include_str!("startup.rs");
        let code = &code[..code.find(concat!("#[cfg(test)]", "\nmod tests")).unwrap()];
        let eval = concat!(".ev", "al(");
        let react = &code[code.find("Reaction::Reload => {").unwrap()..];
        let react = &react[..react.find("Reaction::LogOnly").unwrap()];
        assert!(!react.contains(eval) && react.contains("recover_dead_page("), "{react}");
        // (the reaction and the Linux page checks share one function: remedies in order, each with the web view's own calls)
        let dead = &code[code.find("pub fn recover_dead_page(").unwrap()..];
        let dead = &dead[..dead.find("
}
").unwrap()];
        assert!(!dead.contains(eval) && dead.contains("recover_page(") && dead.contains("reload_page(app)"), "{dead}");
        let step = &code[code.find("Step::Reload => {").unwrap()..];
        let step = &step[..step.find("Step::Restart =>").unwrap()];
        assert!(!step.contains(eval) && step.contains("reload_page(app)"), "{step}");
        let helper = &code[code.find("fn reload_page(").unwrap()..];
        let helper = &helper[..helper.find("\n}\n").unwrap()];
        assert!(helper.contains(".reload()") && !helper.contains(eval), "{helper}");
    }
    #[test]
    fn every_road_that_ends_in_a_window_that_stays_dead_tells_the_person() {
        // 1.0.6: "leaving the window as it is" used to be the end (a blank window and a line in the log); each of them now ends in the error message
        let code = include_str!("startup.rs").replace('\r', "");
        let code = &code[..code.find(concat!("#[cfg(test)]", "\nmod tests")).unwrap()];
        let part = |from: &str, to: &str| {
            let a = code.find(from).unwrap_or_else(|| panic!("{from}"));
            let rest = &code[a..];
            rest[..rest.find(to).unwrap_or(rest.len())].to_string()
        };
        assert!(part("if !force && !restart_allowed", "return;").contains("report_dead_page"), "a refused restart");
        assert!(part("let cured = recover_page(", "Reaction::LogOnly").contains("if cured.is_none()"), "a page that does not come back");
        assert!(part("Step::GiveUp => {", "\n        }").contains("report_dead_page"), "the end of the ladder");
        // the start's own guard: the wait loop is the first stage of the same machine, and nothing else shows the dialog
        let start = part("pub fn start(", "/// The page is gone for good");
        assert!(start.contains("run_guard(&app, show_at_start, true"), "{start}");
        assert!(part("fn run_guard(", "fn on_guard_event").contains("loadfail::drive("));
        // Quit does not go through the question about scheduled messages (it would be put to the page that is not there)
        let quit = part("if done == loadfail::Done::Quit", "\n    }\n}");
        assert!(quit.contains("quit_without_page") && !quit.contains("request_quit"), "{quit}");
        // a Retry after a dead browser process restarts the app, any other Retry loads the app's own address again
        let retry = part("Ev::Retrying { round } => {", "Ev::LateAnswer");
        assert!(retry.contains("restart_app_with(app,") && retry.contains("true);") && retry.contains("navigate_home(app)"), "{retry}");
        // the dialog and its texts: Rust side only (the page is what is missing), three buttons, the log path in the message
        let ask = part("fn ask_load_failure(", "loadfail::answer_from(");
        for needle in ["K::LoadFailTitle", "K::LoadFailRetry", "K::LoadFailOpenLog", "K::LoadFailQuit", "K::LoadFailLog", "YesNoCancelCustom", "MessageDialogKind::Error", "load_failed_body("] {
            assert!(ask.contains(needle), "{needle}");
        }
    }

    #[test]
    fn the_address_retry_loads_is_the_apps_own_not_the_blank_page() {
        // found by the real test: the web view's url() is about:blank before the first load, so Retry loaded nothing
        assert_eq!(app_address(true, Some("http://localhost:1420/"), None, true, false), "http://localhost:1420/", "a dev build: the dev server");
        assert_eq!(app_address(false, Some("http://localhost:1420/"), None, true, false), "http://tauri.localhost/", "a release build ignores devUrl");
        assert_eq!(app_address(false, None, None, true, false), "http://tauri.localhost/");
        assert_eq!(app_address(false, None, None, true, true), "https://tauri.localhost/");
        assert_eq!(app_address(false, None, None, false, false), "tauri://localhost");
        assert_eq!(app_address(false, None, Some("https://app.example/"), false, false), "https://app.example/");
        // and the wiring: Retry does not read the web view's address
        let code = include_str!("startup.rs").replace('\r', "");
        let nav = &code[code.find("fn navigate_home(").unwrap()..];
        let nav = &nav[..nav.find("\n}\n").unwrap()];
        assert!(nav.contains("configured_address(app)") && !nav.contains(".url()"), "{nav}");
    }

    #[test]
    fn every_road_that_shows_the_hidden_window_goes_through_the_look_at_its_pixels() {
        // D-057: the tray click, the tray menu, a second start, a notification and the reopen all end in `show_main`, and it looks at a window that was
        // hidden or minimized (a window that is shown some other way is not looked at, so none may exist for the main window)
        let shell = include_str!("shell.rs").replace('\r', "");
        let show = &shell[shell.find("pub fn show_main").unwrap()..];
        let show = &show[..show.find("
}
").unwrap()];
        assert!(show.contains("if crate::startup::looks_wanted(was_hidden, was_minimized, crate::startup::paint_confirmed()) {") && show.contains("crate::startup::verify_painting(app)"), "{show}");
        assert!(show.find("w.show()").unwrap() < show.find("verify_painting").unwrap(), "the look follows the show");
        let lib = include_str!("lib.rs");
        let second = &lib[lib.find("a second start was handed to this instance").unwrap()..];
        assert!(second[..300].contains("shell::show_main(app)"), "the second start shows the window through show_main");
        let uses = shell.matches("show_main(").count();
        assert!(uses >= 5, "the tray icon, its menu and the notification buttons use show_main: {uses}");
    }

    #[test]
    fn a_show_of_a_window_that_no_look_found_painted_starts_the_looks_whether_it_was_hidden_or_not() {
        // hidden or minimized: as before
        assert!(looks_wanted(true, false, true) && looks_wanted(false, true, true) && looks_wanted(true, true, false));
        // already on screen: a tray click, a second start or a notification on a window that no look has found painted (the 1.0.7 update relaunch, white until the click)
        assert!(looks_wanted(false, false, false));
        // already on screen and found painted: nothing to look at
        assert!(!looks_wanted(false, false, true));
        // the flag follows the looks: a show clears it, a look that found content sets it, and nothing else does
        let src = include_str!("startup.rs");
        let code = &src[..src.find(concat!("#[cfg(test)]", "\nmod tests")).unwrap()];
        assert_eq!(code.matches("PAINT_CONFIRMED.store(true").count(), 1, "only a look that found content confirms");
        let verify = &code[code.find("pub fn verify_painting").unwrap()..];
        assert!(verify.find("PAINT_CONFIRMED.store(false").unwrap() < verify.find("std::thread::spawn").unwrap(), "a new show clears the confirmation before its looks start");
    }

    #[test]
    fn the_start_of_a_run_stays_at_the_top_of_a_log_that_starts_over() {
        let dir = std::env::temp_dir().join(format!("heylook-head-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("startup.log"));
        let head = vec!["[start +0 ms] Hey Look! 9.9.9 started: arguments [\"--minimized\"]".to_string(), "[window +5 ms] window created hidden".to_string()];
        for l in &head {
            append_pinned(&dir, l, &head);
        }
        for i in 0..800 {
            append_pinned(&dir, &format!("[filler +{i} ms] {}", "z".repeat(60)), &head);
        }
        let text = std::fs::read_to_string(dir.join("startup.log")).unwrap();
        assert!(text.len() < LOG_CAP as usize + 600, "the log was not cut: {} bytes", text.len());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(&lines[..2], &[head[0].as_str(), head[1].as_str()], "the first lines of the run are at the top");
        assert!(lines[2].starts_with("[log] the log reached") && lines[2].contains("started over"), "{}", lines[2]);
        assert_eq!(text.matches("started: arguments").count(), 1, "once");
        // a line that is itself one of the head lines (the log is cut while the run is still starting) is not written twice
        let _ = std::fs::remove_file(dir.join("startup.log"));
        std::fs::write(dir.join("startup.log"), "x".repeat(LOG_CAP as usize + 10)).unwrap();
        append_pinned(&dir, &head[1], &head);
        let text = std::fs::read_to_string(dir.join("startup.log")).unwrap();
        assert_eq!(text.matches("window created hidden").count(), 1, "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_line_of_a_run_says_how_it_was_started() {
        let d = launch_description();
        assert!(d.starts_with("Hey Look! ") && d.contains(env!("CARGO_PKG_VERSION")) && d.contains(&format!("pid {}", std::process::id())), "{d}");
        assert!(d.contains("arguments ["), "{d}");
        #[cfg(windows)]
        assert!(d.contains("started by ") && d.contains("start-up information: flags 0x"), "{d}");
        // it is written first, before anything else of the run
        let lib = include_str!("lib.rs");
        let run = &lib[lib.find("startup::init_clock();").unwrap()..];
        assert!(run[..400].contains("startup::line(\"start\", &startup::launch_description())"), "{}", &run[..400]);
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
