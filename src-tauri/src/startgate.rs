//! The start gate: a Windows autostart (`--minimized`) makes the main window and its web view only when the desktop is ready.
//!
//! 1.0.7 fix16 (owner question 2026-10-23, D-057): the white window after an autostart over RDP. The autostarted app made its web view at
//! once, while the session was still coming up (no taskbar yet, the display not composed, the RDP session connecting or disconnected,
//! the WebView2 runtime not yet answering), and a web view made in that state can be white for good. Everything after the web view exists
//! (the pixel looks of `startup.rs`, the start screen of fix12) cures or reports it; this file keeps it from happening on a start that
//! nobody is looking at.
//!
//! On a start with `--minimized` (the argument of the autostart entry, Windows only) tauri is told not to make the window of the config
//! (`create: false`, `defer`). `setup` then runs as always (the data folder, the tray icon, the sync / outbox / calendar workers: nothing of
//! it needs a window) and hands the rest to a thread (`start`): it polls the gates below every 500 ms, for 60 s at most, then makes the window
//! from the same config, does the steps of `setup` that need a window (frame, theme) and starts the load watch of `startup.rs`
//! (`startup::start`). Nothing waits on the main thread, so the tray icon is there at once and mail keeps being fetched and sent.
//!
//! The five gates (`Gate`): the taskbar window `Shell_TrayWnd` exists; DWM composition is on; a monitor exists (`SM_CMONITORS`); the session
//! is active (`WTSConnectState == WTSActive`: an RDP session that is connecting or disconnected is not); the WebView2 runtime answers
//! (`GetAvailableCoreWebView2BrowserVersionString`, through `tauri::webview_version`). Each result goes to `startup.log` as `[gate +ms] ...`
//! (the first poll and every change), then the total wait. After 60 s the window is made anyway and the line says which gates were closed;
//! a WebView2 runtime that is still missing then is the fatal start message of `startfail.rs` (it is no longer asked at once on such a start:
//! a runtime that answers a minute after login is no reason to show an error at login).
//!
//! A person who asks for the window while the gate waits (tray click, a second start, a notification) is not made to wait: `request_window`
//! ends the wait and the window is shown when it exists. A quit while waiting ends the process as always; no window is made then.
//!
//! 1.0.10: the start at Windows sign-in is a VISIBLE start by default (the entry has no `--minimized`, autostart.rs), and a visible start made at logon races the
//! desktop just the same: the window of a gated start is made after the gates, whether it is shown afterwards (visible start) or kept in the tray (`--minimized`).
//! A start without the flag cannot say that it is a sign-in start, so the shell tells: the process that owns the taskbar window (`Shell_TrayWnd`, explorer.exe)
//! began less than `SIGN_IN_SHELL_AGE` ago, or there is no taskbar window yet (`sign_in_start`). Explorer runs the Run entries a few seconds to a minute after it
//! began; a person who starts the app by hand later finds an old shell and a normal start, untouched. A person who does it within those minutes gets the same
//! window a moment later (all gates are open: the wait is 0 ms). No delay is added: the gates are the wait.
//!
//! A normal start (no `--minimized`, an old shell) is not touched: no gate, the window of the config is made by tauri before `setup`, as before. macOS and
//! Linux have no gate (the autostart there does not race a desktop shell that is missing; see webkit-checks-107.md).
//!
//! Lazy creation of the web view beyond the gate (a tray start that never makes it until the first show) was considered and is NOT done:
//! mail fetching, notifications, the tray count, the outbox / scheduled sends and the calendar reminders are Rust threads, but the page owns
//! the update check (8 s after it is up), the recovery of messages that were being written when the app last ended, the support reminder,
//! the Undo timers of messages just sent and the mirror of the language to the native texts, and the quit sequence asks the page to flush.
//! A tray start without a page would silently skip them. See the 1.0.7 report coder-v107-fix16.md.
// (the real gates and the window need the Windows desktop: other systems compile the decision logic and its tests only)
#![cfg_attr(not(windows), allow(dead_code))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// The longest the window is held back.
pub const MAX_WAIT: Duration = Duration::from_secs(60);
/// How often the gates are read.
pub const POLL: Duration = Duration::from_millis(500);
/// A wait between two reads is cut into slices of this length, so a request for the window (`request_window`) is noticed at once.
const SLICE: Duration = Duration::from_millis(100);

/// One thing the desktop must have before the web view is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Taskbar,
    Dwm,
    Monitor,
    Session,
    WebView2,
}

impl Gate {
    pub const ALL: [Gate; 5] = [Gate::Taskbar, Gate::Dwm, Gate::Monitor, Gate::Session, Gate::WebView2];

    /// The name in `startup.log` and in `HEYLOOK_TEST_GATE_FAIL`.
    pub fn name(self) -> &'static str {
        match self {
            Gate::Taskbar => "taskbar",
            Gate::Dwm => "dwm",
            Gate::Monitor => "monitor",
            Gate::Session => "session",
            Gate::WebView2 => "webview2",
        }
    }

    pub fn parse(name: &str) -> Option<Gate> {
        Gate::ALL.into_iter().find(|g| g.name() == name.trim().to_ascii_lowercase())
    }
}

/// What one read of a gate found. `detail` says what was seen (it goes to the log).
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub gate: Gate,
    pub ready: bool,
    pub detail: String,
}

/// What the loop does after a read.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Every gate is open.
    Open,
    /// A gate is closed, but the person asked for the window.
    Requested(Vec<Gate>),
    /// A gate is closed and the time is up.
    TimedOut(Vec<Gate>),
    /// A gate is closed and there is time left.
    Wait,
}

/// The rule, pure: all open => open at once; else the person's request ends the wait; else the wait ends at `max`; else it goes on.
pub fn decide(readings: &[Reading], elapsed: Duration, max: Duration, requested: bool) -> Decision {
    let closed: Vec<Gate> = readings.iter().filter(|r| !r.ready).map(|r| r.gate).collect();
    if closed.is_empty() {
        Decision::Open
    } else if requested {
        Decision::Requested(closed)
    } else if elapsed >= max {
        Decision::TimedOut(closed)
    } else {
        Decision::Wait
    }
}

/// How the wait ended. `waited_ms` is the time since the first read.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Opened { waited_ms: u128 },
    Requested { waited_ms: u128, closed: Vec<Gate> },
    TimedOut { waited_ms: u128, closed: Vec<Gate> },
}

/// The wait loop with its clock, its reads and its sleeping injected (a test runs a minute in no time). `probe` reads all gates, `report` is
/// called with the first read and with every read that differs from the one before it.
pub fn wait(
    mut probe: impl FnMut() -> Vec<Reading>,
    elapsed: impl Fn() -> Duration,
    mut sleep: impl FnMut(Duration),
    requested: impl Fn() -> bool,
    mut report: impl FnMut(Duration, &[Reading]),
) -> Outcome {
    let mut last: Option<Vec<Reading>> = None;
    loop {
        let readings = probe();
        let now = elapsed();
        if last.as_ref() != Some(&readings) {
            report(now, &readings);
            last = Some(readings.clone());
        }
        let waited_ms = now.as_millis();
        match decide(&readings, now, MAX_WAIT, requested()) {
            Decision::Open => return Outcome::Opened { waited_ms },
            Decision::Requested(closed) => return Outcome::Requested { waited_ms, closed },
            Decision::TimedOut(closed) => return Outcome::TimedOut { waited_ms, closed },
            Decision::Wait => {}
        }
        let mut slept = Duration::ZERO;
        while slept < POLL && !requested() {
            sleep(SLICE);
            slept += SLICE;
        }
    }
}

/// The text of one read for `startup.log`: `taskbar=ok dwm=ok monitor=ok (2) session=WAIT (WTSDisconnected) webview2=ok (141.0.3537.71)`.
pub fn describe(readings: &[Reading]) -> String {
    readings
        .iter()
        .map(|r| {
            let state = if r.ready { "ok" } else { "WAIT" };
            if r.detail.is_empty() { format!("{}={state}", r.gate.name()) } else { format!("{}={state} ({})", r.gate.name(), r.detail) }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The names of gates for the log: `session, webview2`.
pub fn names(gates: &[Gate]) -> String {
    gates.iter().map(|g| g.name()).collect::<Vec<_>>().join(", ")
}

/// Whether a start is gated: `--minimized` (exactly) among the arguments, on Windows.
pub fn wanted(args: &[String], windows: bool) -> bool {
    windows && args.iter().skip(1).any(|a| a == "--minimized")
}

/// How long after the desktop shell began a start without `--minimized` still counts as a start at sign-in (the Run entries are started by Explorer once the
/// desktop is up, a few seconds to a minute after it began; a slow disk can make it longer).
pub const SIGN_IN_SHELL_AGE: Duration = Duration::from_secs(180);

/// What is known about the desktop shell (the owner of the taskbar window) at the start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellAge {
    /// No taskbar window yet: the shell is not up, this start is part of the sign-in.
    NoShell,
    /// The process that owns the taskbar window began this long ago.
    Age(Duration),
    /// The taskbar window exists, but its process cannot be asked: no guess, a normal start.
    Unknown,
}

/// Is a start without `--minimized` a start at sign-in? Pure.
pub fn sign_in_start(age: ShellAge) -> bool {
    match age {
        ShellAge::NoShell => true,
        ShellAge::Age(a) => a < SIGN_IN_SHELL_AGE,
        ShellAge::Unknown => false,
    }
}

/// The log words of a shell age.
pub fn describe_shell_age(age: ShellAge) -> String {
    match age {
        ShellAge::NoShell => "the taskbar window does not exist yet".to_string(),
        ShellAge::Age(a) => format!("the desktop shell began {} s ago", a.as_secs()),
        ShellAge::Unknown => "the age of the desktop shell is not known".to_string(),
    }
}

/// Windows' name of a session's connect state (`WTS_CONNECTSTATE_CLASS`), for the log.
pub fn session_state_name(state: i32) -> &'static str {
    match state {
        0 => "WTSActive",
        1 => "WTSConnected",
        2 => "WTSConnectQuery",
        3 => "WTSShadow",
        4 => "WTSDisconnected",
        5 => "WTSIdle",
        6 => "WTSListen",
        7 => "WTSReset",
        8 => "WTSDown",
        9 => "WTSInit",
        _ => "unknown state",
    }
}

/// Only an active session has a desktop that is shown: connecting, disconnected, idle ... are not.
pub fn session_ready(state: i32) -> bool {
    state == 0
}

/// `HEYLOOK_TEST_GATE_FAIL=<name>[,<name>...]` (debug builds): the gates that are forced closed `secs` seconds after the first read. Names that
/// are not a gate are ignored. Pure, for the test.
pub fn forced_closed(spec: &str, elapsed: Duration, secs: u64) -> Vec<Gate> {
    if elapsed >= Duration::from_secs(secs) {
        return vec![];
    }
    spec.split(',').filter_map(Gate::parse).collect()
}

/// The reads with the forced gates closed.
pub fn with_forced(mut readings: Vec<Reading>, forced: &[Gate]) -> Vec<Reading> {
    for r in readings.iter_mut().filter(|r| forced.contains(&r.gate)) {
        r.ready = false;
        r.detail = "forced closed by HEYLOOK_TEST_GATE_FAIL".into();
    }
    readings
}

// ---------- the window ----------

/// The config window was taken out of tauri's hands (`defer`), so `start` has to make it.
static DEFERRED: AtomicBool = AtomicBool::new(false);
/// The window has been made (or the attempt was made).
static CREATED: AtomicBool = AtomicBool::new(false);
/// Somebody asked for the window while it did not exist: the wait ends, the window is shown when it is there.
static REQUESTED: AtomicBool = AtomicBool::new(false);

/// Why this start is gated (for the log); set by `defer`.
static REASON: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The words for `startup.log`: "a --minimized start", ...
pub fn reason() -> String {
    REASON.get().cloned().unwrap_or_else(|| "a gated start".to_string())
}

/// The age of the shell, or the one a debug build is told (`HEYLOOK_TEST_SHELL_AGE_S=<seconds>` or `none`: QA of the visible start at sign-in; a release build
/// reads no variable).
#[cfg(windows)]
fn shell_age() -> ShellAge {
    if cfg!(debug_assertions) {
        if let Ok(v) = std::env::var("HEYLOOK_TEST_SHELL_AGE_S") {
            let v = v.trim().to_lowercase();
            if v == "none" {
                return ShellAge::NoShell;
            }
            if let Ok(secs) = v.parse::<u64>() {
                return ShellAge::Age(Duration::from_secs(secs));
            }
        }
    }
    win::shell_age()
}

#[cfg(not(windows))]
fn shell_age() -> ShellAge {
    ShellAge::Unknown
}

/// Called with the config before tauri builds the app: on a gated start the window of the config is not made by tauri. Returns whether it
/// is gated.
pub fn defer(config: &mut tauri::utils::config::Config) -> bool {
    let args: Vec<String> = std::env::args().collect();
    // (a start by the package's startup task has no argument: Windows says how it was started, pkg.rs)
    let why = if wanted(&args, cfg!(windows)) {
        "a --minimized start".to_string()
    } else if cfg!(windows) && crate::pkg::started_by_startup_task() {
        "a start by the package's startup task".to_string()
    } else if cfg!(windows) {
        // the visible start at sign-in: the entry has no argument, the shell's age tells (the module header)
        let age = shell_age();
        if !sign_in_start(age) {
            return false;
        }
        format!("a start at sign-in ({})", describe_shell_age(age))
    } else {
        return false;
    };
    let _ = REASON.set(why);
    let mut taken = 0;
    for w in config.app.windows.iter_mut().filter(|w| w.create) {
        w.create = false;
        taken += 1;
    }
    let on = taken > 0;
    DEFERRED.store(on, Ordering::SeqCst);
    on
}

/// Is this start gated (the main window is made by `start`, not by tauri)?
pub fn is_deferred() -> bool {
    DEFERRED.load(Ordering::SeqCst)
}

/// The main window does not exist yet but will: `show_main` asks for it. Returns whether there is something to wait for (the window is shown
/// as soon as it exists).
pub fn request_window() -> bool {
    if is_deferred() && !CREATED.load(Ordering::SeqCst) {
        REQUESTED.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// `HEYLOOK_TEST_GATE_FAIL` / `HEYLOOK_TEST_GATE_FAIL_SECS` (debug builds only; a release build reads neither).
fn test_forced() -> Option<(String, u64)> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let spec = std::env::var("HEYLOOK_TEST_GATE_FAIL").ok().filter(|s| !s.trim().is_empty())?;
    let secs = std::env::var("HEYLOOK_TEST_GATE_FAIL_SECS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(10);
    Some((spec, secs))
}

/// Make the window after the gate (on its own thread; `show_at_start` as `startup::start` takes it) and finish the steps of `setup` that need it.
pub fn start(app: &AppHandle, show_at_start: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        let forced = test_forced();
        if let Some((spec, secs)) = &forced {
            crate::startup::line("gate", &format!("test: HEYLOOK_TEST_GATE_FAIL={spec} holds those gates closed for {secs} s"));
        }
        crate::startup::line("gate", &format!("start gate: the window waits for the desktop (up to {} s, read every {} ms)", MAX_WAIT.as_secs(), POLL.as_millis()));
        let began = Instant::now();
        let outcome = wait(
            || {
                let readings = read_gates();
                match &forced {
                    Some((spec, secs)) => with_forced(readings, &forced_closed(spec, began.elapsed(), *secs)),
                    None => readings,
                }
            },
            || began.elapsed(),
            std::thread::sleep,
            || REQUESTED.load(Ordering::SeqCst) || crate::startup::is_exiting(),
            |at, readings| crate::startup::line("gate", &format!("{} ms after the first read: {}", at.as_millis(), describe(readings))),
        );
        if crate::startup::is_exiting() {
            crate::startup::line("gate", "the app is quitting: no window is made");
            return;
        }
        match &outcome {
            Outcome::Opened { waited_ms } => crate::startup::line("gate", &format!("all gates open after {waited_ms} ms: making the window")),
            Outcome::Requested { waited_ms, closed } => crate::startup::line("gate", &format!("the window was asked for after {waited_ms} ms (still closed: {}): making it now", names(closed))),
            Outcome::TimedOut { waited_ms, closed } => crate::startup::line("gate", &format!("timed out after {waited_ms} ms, still closed: {}: making the window anyway", names(closed))),
        }
        if let Outcome::TimedOut { closed, .. } = &outcome {
            if closed.contains(&Gate::WebView2) {
                // (a window cannot be made without the runtime: the same message as a start that finds it missing at once)
                crate::startfail::fail_start("the Microsoft WebView2 Runtime was not found on this computer");
            }
        }
        // a tray start keeps the window hidden, so the icon is the only way back: it must really be in the notification area (autostart.rs). An icon that
        // never comes (the shell did not take it at the logon) means the window is shown, not an app nobody can see
        #[cfg(windows)]
        let mut show_at_start = show_at_start;
        #[cfg(windows)]
        if !show_at_start && !REQUESTED.load(Ordering::SeqCst) {
            #[cfg(debug_assertions)]
            if crate::autostart::test_drop_tray_icon() {
                crate::startup::line("tray", "test: HEYLOOK_TEST_TRAY took the icon out of the notification area behind the icon library's back");
            }
            let t0 = Instant::now();
            let outcome = crate::autostart::tray_confirmed(
                || crate::shell::tray_icon_present(&app),
                || {
                    let found = crate::autostart::ask_tray_again();
                    crate::startup::line("tray", &format!("the icon is not in the notification area yet: asked it to register again (its window {})", if found { "found" } else { "not found" }));
                },
                || t0.elapsed(),
                std::thread::sleep,
                || REQUESTED.load(Ordering::SeqCst) || crate::startup::is_exiting(),
            );
            match outcome {
                crate::autostart::TrayOutcome::Present { ms, asked } => crate::startup::line("tray", &format!("the icon is in the notification area after {ms} ms (asked again {asked} times): the window stays hidden")),
                crate::autostart::TrayOutcome::Absent { ms, asked } => {
                    crate::startup::line("tray", &format!("the icon is NOT in the notification area after {ms} ms (asked again {asked} times): the window is shown, so the app is not left invisible"));
                    show_at_start = true;
                }
            }
        }
        let config = app.config().app.windows.first().cloned();
        let made = match config {
            Some(cfg) => tauri::WebviewWindowBuilder::from_config(&app, &cfg).and_then(|b| b.build()).map(|_| ()),
            None => Err(tauri::Error::Io(std::io::Error::other("no window in the config"))),
        };
        CREATED.store(true, Ordering::SeqCst);
        // a tray start's window is parked at once, off every monitor: a window that was never shown is drawn white with its shadow by the compositor although it is
        // hidden, and the person must never see a frame of it (ghost.rs; tao puts a window made at a place that is on no monitor at the system's default place, so it is
        // moved right after it is made)
        #[cfg(windows)]
        if made.is_ok() && !show_at_start && !REQUESTED.load(Ordering::SeqCst) && crate::ghost::park_at_creation() {
            let moved = crate::ghost::park(&app);
            crate::startup::line("ghost", &format!("the window of a tray start is parked off-screen right after it was made ({})", if moved { "moved" } else { "could not be moved" }));
        }
        if let Err(e) = made {
            crate::startfail::fail_start(&format!("the main window could not be created after the start gate: {e}"));
            return;
        }
        crate::startup::stage(Some(&app), "window made after the start gate");
        // the steps of `setup` that need the window (they ran without one before and did nothing)
        crate::winframe::setup(&app);
        crate::wintheme::apply_all(&app, "start (window made after the start gate)");
        // a request for the window (tray click, second start) made while it did not exist shows it as soon as its page is up
        crate::startup::start(&app, show_at_start || REQUESTED.load(Ordering::SeqCst));
    });
}

// ---------- the gates on Windows ----------

#[cfg(windows)]
fn read_gates() -> Vec<Reading> {
    win::read()
}

#[cfg(not(windows))]
fn read_gates() -> Vec<Reading> {
    Gate::ALL.iter().map(|&gate| Reading { gate, ready: true, detail: String::new() }).collect()
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Graphics::Dwm::DwmIsCompositionEnabled;
    use windows::Win32::System::RemoteDesktop::{WTSConnectState, WTSFreeMemory, WTSQuerySessionInformationW, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION};
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetSystemMetrics, GetWindowThreadProcessId, SM_CMONITORS};

    /// How long ago the process that owns the taskbar window (Explorer) was created.
    pub fn shell_age() -> ShellAge {
        unsafe {
            let Ok(bar) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) else { return ShellAge::NoShell };
            let mut pid = 0u32;
            GetWindowThreadProcessId(bar, Some(&mut pid));
            if pid == 0 {
                return ShellAge::Unknown;
            }
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return ShellAge::Unknown };
            let (mut created, mut x, mut y, mut z) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            let ok = GetProcessTimes(h, &mut created, &mut x, &mut y, &mut z).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return ShellAge::Unknown;
            }
            let then_ms = ((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64) / 10_000; // 100 ns -> ms since 1601
            let Ok(since_epoch) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else { return ShellAge::Unknown };
            let now_ms = since_epoch.as_millis() as u64 + 11_644_473_600_000;
            ShellAge::Age(Duration::from_millis(now_ms.saturating_sub(then_ms)))
        }
    }

    pub fn read() -> Vec<Reading> {
        vec![taskbar(), dwm(), monitor(), session(), webview2()]
    }

    fn reading(gate: Gate, ready: bool, detail: impl Into<String>) -> Reading {
        Reading { gate, ready, detail: detail.into() }
    }

    /// The taskbar window exists: the shell is up (the tray icon area and the taskbar button have a place to go).
    fn taskbar() -> Reading {
        let found = unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) }.is_ok();
        reading(Gate::Taskbar, found, if found { "Shell_TrayWnd" } else { "Shell_TrayWnd not found" })
    }

    /// Desktop composition is on. (Always on from Windows 8; an answer that does not come is not a reason to wait.)
    fn dwm() -> Reading {
        match unsafe { DwmIsCompositionEnabled() } {
            Ok(on) => reading(Gate::Dwm, on.as_bool(), if on.as_bool() { "composition on" } else { "composition off" }),
            Err(e) => reading(Gate::Dwm, true, format!("not asked: {e}")),
        }
    }

    /// A display exists (an RDP session that is not connected has none).
    fn monitor() -> Reading {
        let n = unsafe { GetSystemMetrics(SM_CMONITORS) };
        reading(Gate::Monitor, n > 0, format!("{n} monitor(s)"))
    }

    /// The session of this process is active. (A query that fails is not a reason to wait: some systems do not offer it.)
    fn session() -> Reading {
        let mut buf = PWSTR::null();
        let mut bytes = 0u32;
        let asked = unsafe { WTSQuerySessionInformationW(Some(WTS_CURRENT_SERVER_HANDLE), WTS_CURRENT_SESSION, WTSConnectState, &mut buf, &mut bytes) };
        match asked {
            Ok(()) if !buf.is_null() && bytes as usize >= std::mem::size_of::<i32>() => {
                let state = unsafe { std::ptr::read_unaligned(buf.0 as *const i32) };
                unsafe { WTSFreeMemory(buf.0 as *mut core::ffi::c_void) };
                reading(Gate::Session, session_ready(state), session_state_name(state))
            }
            Ok(()) => {
                if !buf.is_null() {
                    unsafe { WTSFreeMemory(buf.0 as *mut core::ffi::c_void) };
                }
                reading(Gate::Session, true, "not asked: empty answer")
            }
            Err(e) => reading(Gate::Session, true, format!("not asked: {e}")),
        }
    }

    /// The WebView2 runtime answers (`GetAvailableCoreWebView2BrowserVersionString`).
    fn webview2() -> Reading {
        match tauri::webview_version() {
            Ok(v) => reading(Gate::WebView2, true, v),
            Err(e) => reading(Gate::WebView2, false, format!("not available: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn all(ready: bool) -> Vec<Reading> {
        Gate::ALL.iter().map(|&gate| Reading { gate, ready, detail: String::new() }).collect()
    }

    /// The reads of a desktop where `gate` opens at `opens_ms` and everything else is open from the start.
    fn only(gate: Gate, opens_ms: u128, at_ms: u128) -> Vec<Reading> {
        Gate::ALL.iter().map(|&g| Reading { gate: g, ready: g != gate || at_ms >= opens_ms, detail: String::new() }).collect()
    }

    /// Runs the wait on a simulated clock: returns the outcome, how many reads were made, how long was slept and the reports.
    fn run(read: impl Fn(u128) -> Vec<Reading>, requested_at_ms: Option<u128>) -> (Outcome, usize, u128, Vec<u128>) {
        let clock = Cell::new(0u128);
        let reads = Cell::new(0usize);
        let reports = RefCell::new(vec![]);
        let outcome = wait(
            || {
                reads.set(reads.get() + 1);
                read(clock.get())
            },
            || Duration::from_millis(clock.get() as u64),
            |d| clock.set(clock.get() + d.as_millis()),
            || requested_at_ms.is_some_and(|t| clock.get() >= t),
            |at, _| reports.borrow_mut().push(at.as_millis()),
        );
        (outcome, reads.get(), clock.get(), reports.into_inner())
    }

    #[test]
    fn a_desktop_that_is_ready_opens_the_window_at_once_without_sleeping() {
        let (outcome, reads, slept, reports) = run(|_| all(true), None);
        assert_eq!(outcome, Outcome::Opened { waited_ms: 0 });
        assert_eq!((reads, slept), (1, 0), "one read, no wait");
        assert_eq!(reports, vec![0], "the first read is logged");
    }

    #[test]
    fn one_gate_that_is_closed_keeps_the_wait_going_until_it_opens() {
        let (outcome, reads, _, reports) = run(|t| only(Gate::Session, 1_800, t), None);
        // read every 500 ms: 0, 500, 1000, 1500, 2000 (the first read after 1800)
        assert_eq!(outcome, Outcome::Opened { waited_ms: 2_000 });
        assert_eq!(reads, 5);
        assert_eq!(reports, vec![0, 2_000], "logged at the first read and when something changed, not on every read");
        for gate in Gate::ALL {
            let (o, ..) = run(|t| only(gate, 700, t), None);
            assert_eq!(o, Outcome::Opened { waited_ms: 1_000 }, "{gate:?} alone keeps the window back");
        }
    }

    #[test]
    fn a_gate_that_never_opens_ends_the_wait_after_sixty_seconds_and_names_it() {
        let (outcome, reads, slept, reports) = run(|_| only(Gate::Session, u128::MAX, 0), None);
        assert_eq!(outcome, Outcome::TimedOut { waited_ms: 60_000, closed: vec![Gate::Session] });
        assert_eq!(reads, 121, "a read every 500 ms from 0 to 60 s");
        assert_eq!(slept, 60_000);
        assert_eq!(reports, vec![0], "one line for a state that did not change");
        let (outcome, ..) = run(|_| { let mut r = all(true); r[0].ready = false; r[4].ready = false; r }, None);
        assert_eq!(outcome, Outcome::TimedOut { waited_ms: 60_000, closed: vec![Gate::Taskbar, Gate::WebView2] });
    }

    #[test]
    fn a_change_of_what_a_closed_gate_sees_is_logged_too() {
        let (_, _, _, reports) = run(
            |t| {
                let mut r = all(true);
                r[3] = Reading { gate: Gate::Session, ready: t >= 2_000, detail: if t < 1_000 { "WTSConnected".into() } else { "WTSDisconnected".into() } };
                r
            },
            None,
        );
        assert_eq!(reports, vec![0, 1_000, 2_000]);
    }

    #[test]
    fn the_person_asking_for_the_window_ends_the_wait_in_a_slice_not_after_a_poll() {
        let (outcome, _, slept, _) = run(|_| only(Gate::Taskbar, u128::MAX, 0), Some(1_250));
        assert_eq!(outcome, Outcome::Requested { waited_ms: 1_300, closed: vec![Gate::Taskbar] });
        assert_eq!(slept, 1_300, "a slice is 100 ms");
        // when everything is open the request changes nothing
        assert_eq!(run(|_| all(true), Some(0)).0, Outcome::Opened { waited_ms: 0 });
    }

    #[test]
    fn the_decision_is_open_wait_request_or_timeout_in_that_order() {
        let ready = all(true);
        let mut closed = all(true);
        closed[3].ready = false;
        let (s0, s59, s60) = (Duration::ZERO, Duration::from_millis(59_999), MAX_WAIT);
        assert_eq!(decide(&ready, s60, MAX_WAIT, true), Decision::Open);
        assert_eq!(decide(&closed, s0, MAX_WAIT, false), Decision::Wait);
        assert_eq!(decide(&closed, s59, MAX_WAIT, false), Decision::Wait);
        assert_eq!(decide(&closed, s60, MAX_WAIT, false), Decision::TimedOut(vec![Gate::Session]));
        assert_eq!(decide(&closed, s0, MAX_WAIT, true), Decision::Requested(vec![Gate::Session]));
        assert_eq!(decide(&[], s0, MAX_WAIT, false), Decision::Open, "no gate, nothing to wait for");
    }

    #[test]
    fn only_a_minimized_start_on_windows_is_gated() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(wanted(&args(&["hey-look.exe", "--minimized"]), true));
        assert!(wanted(&args(&["C:\\Program Files\\Hey Look!\\hey-look.exe", "x", "--minimized"]), true));
        assert!(!wanted(&args(&["hey-look.exe"]), true), "a normal start is not delayed");
        assert!(!wanted(&args(&["hey-look.exe", "--minimized"]), false), "macOS / Linux: no gate");
        assert!(!wanted(&args(&["hey-look.exe", "--minimized=1", "-minimized", "minimized"]), true));
        assert!(!wanted(&args(&["--minimized"]), true), "the first argument is the program");
    }

    #[test]
    fn a_start_without_the_flag_is_a_sign_in_start_while_the_desktop_shell_is_young() {
        let s = Duration::from_secs;
        assert!(sign_in_start(ShellAge::NoShell), "no taskbar yet: the sign-in is still going on");
        assert!(sign_in_start(ShellAge::Age(s(0))) && sign_in_start(ShellAge::Age(s(25))) && sign_in_start(ShellAge::Age(s(179))));
        assert!(!sign_in_start(ShellAge::Age(s(180))), "the shell is old: the person started it by hand");
        assert!(!sign_in_start(ShellAge::Age(s(86_400))));
        assert!(!sign_in_start(ShellAge::Unknown), "no guess: a normal start is not delayed");
        assert!(describe_shell_age(ShellAge::Age(s(25))).contains("25 s") && describe_shell_age(ShellAge::NoShell).contains("taskbar"));
    }

    #[test]
    fn a_visible_start_at_sign_in_is_gated_too() {
        let gate = code("startgate.rs");
        let defer = &gate[gate.find("pub fn defer(").unwrap()..];
        let defer = &defer[..defer.find("\n}\n").unwrap()];
        assert!(defer.contains("wanted(&args, cfg!(windows))") && defer.contains("started_by_startup_task()") && defer.contains("sign_in_start(age)"), "{defer}");
        // the flag and the package task are asked first, the shell last: a start with the flag does not read the shell at all
        assert!(defer.find("wanted(").unwrap() < defer.find("started_by_startup_task()").unwrap() && defer.find("started_by_startup_task()").unwrap() < defer.find("shell_age()").unwrap());
        // a start that is gated for its age shows the window once it is made (only a tray start keeps it hidden)
        let lib = code("lib.rs");
        assert!(lib.contains("let show_at_start = !minimized || !shell::tray_ready() || window_wanted;"));
        assert!(lib.contains("startgate::reason()"), "the log says why the start is gated");
        // the tray check, the parking and the ghost looks belong to a tray start only
        let start = &gate[gate.find("pub fn start(").unwrap()..];
        assert!(start.contains("if !show_at_start && !REQUESTED.load(Ordering::SeqCst) {") && start.contains("made.is_ok() && !show_at_start"), "{start}");
    }

    #[test]
    fn the_session_is_ready_only_when_it_is_active() {
        assert!(session_ready(0));
        for (state, name) in [(1, "WTSConnected"), (2, "WTSConnectQuery"), (3, "WTSShadow"), (4, "WTSDisconnected"), (5, "WTSIdle"), (6, "WTSListen"), (7, "WTSReset"), (8, "WTSDown"), (9, "WTSInit")] {
            assert!(!session_ready(state), "{name}");
            assert_eq!(session_state_name(state), name);
        }
        assert_eq!(session_state_name(0), "WTSActive");
        assert_eq!(session_state_name(42), "unknown state");
        assert!(!session_ready(-1));
    }

    #[test]
    fn the_test_switch_closes_the_named_gates_for_a_while_and_ignores_other_names() {
        let s = Duration::from_secs;
        assert_eq!(forced_closed("session", s(0), 10), vec![Gate::Session]);
        assert_eq!(forced_closed("taskbar, WebView2,dwm", s(9), 10), vec![Gate::Taskbar, Gate::WebView2, Gate::Dwm]);
        assert_eq!(forced_closed("session", s(10), 10), vec![], "after the seconds the gate opens");
        assert_eq!(forced_closed("nonsense,,monitor", s(1), 10), vec![Gate::Monitor]);
        assert_eq!(forced_closed("", s(1), 10), vec![]);
        let r = with_forced(all(true), &[Gate::Monitor]);
        assert_eq!(r.iter().filter(|r| !r.ready).map(|r| r.gate).collect::<Vec<_>>(), vec![Gate::Monitor]);
        assert!(describe(&r).contains("monitor=WAIT (forced closed by HEYLOOK_TEST_GATE_FAIL)") && describe(&r).contains("taskbar=ok"), "{}", describe(&r));
        // and the wait with it: the gate opens after the seconds
        let (outcome, ..) = run(|t| with_forced(all(true), &forced_closed("session", Duration::from_millis(t as u64), 3)), None);
        assert_eq!(outcome, Outcome::Opened { waited_ms: 3_000 });
    }

    #[test]
    fn the_log_line_names_each_gate_and_what_it_saw() {
        let r = vec![
            Reading { gate: Gate::Taskbar, ready: true, detail: "Shell_TrayWnd".into() },
            Reading { gate: Gate::Session, ready: false, detail: "WTSDisconnected".into() },
            Reading { gate: Gate::Dwm, ready: true, detail: String::new() },
        ];
        assert_eq!(describe(&r), "taskbar=ok (Shell_TrayWnd) session=WAIT (WTSDisconnected) dwm=ok");
        assert_eq!(names(&[Gate::Session, Gate::WebView2]), "session, webview2");
    }

    /// The source of a file without its test modules (for the wiring tests).
    fn code(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(name);
        crate::test_guard::non_test_code(&std::fs::read_to_string(p).unwrap())
    }

    #[test]
    fn the_setup_hands_a_minimized_start_to_the_gate_and_every_other_start_to_the_load_watch() {
        let lib = code("lib.rs");
        let run = &lib[lib.find("pub fn run() {").unwrap()..];
        // before the builder: the window of the config is taken out of tauri's hands, and the runtime check waits for the gate
        let defer = run.find("startgate::defer(context.config_mut())").expect("defer");
        assert!(defer < run.find(".build(context)").unwrap(), "the config is changed before the app is built");
        assert!(run.contains("!gated || startfail::seam().is_some()"), "a gated start asks for the WebView2 runtime at the gate");
        let setup = &run[run.find(".setup(|app| {").unwrap()..];
        let setup = &setup[..setup.find(".on_window_event").unwrap()];
        assert!(setup.contains("startgate::is_deferred()") && setup.contains("startgate::start(app.handle(), show_at_start)"), "{setup}");
        assert!(setup.contains("startup::start(app.handle(), show_at_start)"), "a normal start is unchanged");
        // the tray, the workers and the sync are started before the gate's thread and none of them waits for it
        for early in ["shell::setup_tray(", "std::thread::spawn(move || sync_worker(handle))", "std::thread::spawn(move || outbox_worker(worker_app, worker_db))"] {
            assert!(setup.find(early).unwrap() < setup.find("startgate::start(").unwrap(), "{early}");
        }
        assert!(!setup.contains("startgate::wait("), "the wait runs on the gate's own thread");
    }

    #[test]
    fn a_request_for_the_window_before_it_exists_is_taken_by_show_main() {
        let shell = code("shell.rs");
        let show = &shell[shell.find("pub fn show_main").unwrap()..];
        let show = &show[..show.find("\n}\n").unwrap()];
        assert!(show.contains("crate::startgate::request_window()") && show.find("request_window").unwrap() > show.find("get_webview_window(\"main\")").unwrap(), "{show}");
        // the thread that waits ends its wait on that request and on a quit
        let gate = code("startgate.rs");
        let start = &gate[gate.find("pub fn start(").unwrap()..];
        assert!(start.contains("REQUESTED.load(Ordering::SeqCst) || crate::startup::is_exiting()"), "{start}");
        assert!(start.contains("show_at_start || REQUESTED.load(Ordering::SeqCst)"), "{start}");
        // after the window: the same steps of setup as a normal start, then the load watch
        let after = &start[start.find("\"window made after the start gate\"").unwrap()..];
        assert!(after.find("winframe::setup").unwrap() < after.find("wintheme::apply_all").unwrap() && after.find("wintheme::apply_all").unwrap() < after.find("startup::start").unwrap(), "{after}");
    }

    #[test]
    fn the_window_is_still_in_the_config_so_a_normal_start_makes_it_as_before() {
        let conf = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&conf).unwrap();
        let w = &v["app"]["windows"];
        assert_eq!(w.as_array().map(|a| a.len()), Some(1), "one window in the config");
        assert!(w[0].get("create").is_none(), "create is switched off at run time for a gated start only");
        assert_eq!(w[0]["visible"], false);
    }
}
