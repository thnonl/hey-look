//! The web view's own processes (QA BUG-11: the main window stays blank white although the page was alive a moment before).
//!
//! What the evidence says (round 6 QA machine; the files are in the web view's data folder
//! `%LOCALAPPDATA%\thnonl.heylook\EBWebView\Crashpad`):
//! * In every blank start of that round (B1, B6, the CDP starts at 02:28 and 02:33) the web view's **browser process**
//!   (`msedgewebview2.exe`) had crashed: an access violation (0xC0000005) inside `RTSSHooks64.dll`, the overlay hook of RivaTuner
//!   Statistics Server / MSI Afterburner that is injected into the process on that PC (`watson_metadata`: `ProcessType=browser`,
//!   `ModuleName=RTSSHooks64.dll`, the same offset in all four, `WV=hey-look.exe`; the minidumps list `RTSSHooks64.dll`,
//!   `dOverlay64.dll`, `dxgi.dll`). Dump times 02:28:48, 02:30:04, 02:31:46, 02:33:32; blank captures B1 02:30:15, B6 02:31:57,
//!   RL2-trigger 02:33:45. The healthy starts B2 to B5 and the relaunches RL1 and MSI have no dump.
//! * A web view whose browser process is gone shows its default white background for ever. The page was alive (it had reported
//!   itself and its animation frames 2.5 s after the start), then the process died. Hide + show, a reload and a repaint cannot
//!   revive a dead process, which is why the escalation of round 9 never cured those starts; only a new process did. No DevTools
//!   port opens either, which is what QA saw in round 5.
//! * What killed it: the app's own pixel check. The capture 2.5 s after the show (`PrintWindow(PW_RENDERFULLCONTENT)`, which asks the
//!   browser process to render the window) is the point: in every one of the 5 blank starts in the QA logs (4 in the round 6 log, 1 in
//!   round 5) that capture stalled, the gap to the check 1 s before it was 1331 to 2132 ms; in all 44 healthy starts it was 1016 to
//!   1048 ms (a capture of 16 to 48 ms). The capture 1 s earlier and the page's own report had been fine, so the process was healthy
//!   until the capture reached it, and the crash is inside the overlay hook (4 of the 5 starts have a dump at that moment, B1, B6 and
//!   the two CDP starts; the fifth has none). That makes the capture the trigger on a PC with such a hook, and it is also what QA's
//!   and the earlier harness' screenshots did (the black windows of round 4 and of the 700-launch harness came right after a
//!   screenshot). The captures at 4 s and 8 s of the healthy starts did no harm; the early one, while the hook settles in, is the
//!   dangerous one. This is an inference from the logs and the dump times, not a reproduction (no launches in round 10).
//!
//! So `startup.rs` no longer reads pixels (a diagnostic switch keeps it), and this module makes the app notice and survive a dead web
//! view whatever the cause (a hook, a runtime update, Task Manager): wry (the web view layer under Tauri) does not listen for it, so
//! nothing in the app knew. It
//! * listens for `ProcessFailed` of the main web view and logs exactly what failed (kind, reason, exit code, the module that crashed),
//!   then the app restarts itself (at most `startup::MAX_RESTARTS` times in ten minutes) for a dead browser process, or reloads the
//!   page for a dead renderer (`startup::web_view_failed`);
//! * waits, before the window is created, while a browser process of this app's web view data folder is still shutting down after
//!   the previous run (an installer relaunch or a restart starts the new process while the old browser process is exiting; a web
//!   view that joins it dies with it: the second blank pattern of round 5, a white window with no crash dump);
//! * records which browser process the web view uses (pid, who started it, how old it is) so `startup.log` shows a joined process;
//! * re-asserts the controller's visibility, position and bounds on request (the first, flicker-free step of the escalation).
// (the pure parts are compiled and tested on every OS, the process work is Windows only)
#![cfg_attr(not(windows), allow(dead_code))]
use std::time::Duration;

/// The web view runtime's executable.
pub const BROWSER_EXE: &str = "msedgewebview2.exe";
/// Set by this app right before it restarts itself: the pid of the process that is about to exit.
pub const RELAUNCH_ENV: &str = "HEYLOOK_RELAUNCH_OF";
/// How long a start waits for the previous run's web view process to go away before it carries on.
pub const WAIT_BUDGET: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(100);

// ---------- pure logic (unit tested on every OS) ----------

/// A process of the snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

/// The browser processes of web views whose app is gone: `msedgewebview2.exe` whose parent no longer runs. (A browser process is
/// started by the app that hosts the web view; its renderer, GPU and utility helpers have the browser process as parent, so they are
/// never reported.)
pub fn ownerless_browsers(procs: &[Proc]) -> Vec<u32> {
    let live: std::collections::HashSet<u32> = procs.iter().map(|p| p.pid).collect();
    procs.iter().filter(|p| p.name.eq_ignore_ascii_case(BROWSER_EXE) && !live.contains(&p.ppid)).map(|p| p.pid).collect()
}

/// Whether a command line is a browser process (no `--type=`) that works on the web view data folder whose path ends with `folder`
/// (`\thnonl.heylook\ebwebview`, lower case, backslashes).
pub fn is_browser_of(cmdline: &str, folder: &str) -> bool {
    let c = cmdline.to_lowercase().replace('/', "\\");
    !c.contains("--type=") && c.contains("--user-data-dir=") && c.contains(folder)
}

/// What a wait found.
#[derive(Debug, PartialEq)]
pub struct Waited {
    /// Pids that were in the way at the first look (empty: nothing to wait for).
    pub first: Vec<u32>,
    /// Pids still in the way when the wait ended (empty: all gone).
    pub left: Vec<u32>,
    pub waited_ms: u128,
}

/// Looks every `poll` until `check` finds nothing or `budget` is used up. The clock is injected (`sleep`) so a test runs it in no time.
pub fn wait_until_clear(mut check: impl FnMut() -> Vec<u32>, mut sleep: impl FnMut(Duration), budget: Duration, poll: Duration) -> Waited {
    let first = check();
    if first.is_empty() {
        return Waited { first, left: vec![], waited_ms: 0 };
    }
    let mut waited = Duration::ZERO;
    let mut left = first.clone();
    while waited < budget {
        sleep(poll);
        waited += poll;
        left = check();
        if left.is_empty() {
            break;
        }
    }
    Waited { first, left, waited_ms: waited.as_millis() }
}

/// `COREWEBVIEW2_PROCESS_FAILED_KIND` in words.
pub fn kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "browser process exited",
        1 => "render process exited",
        2 => "render process unresponsive",
        3 => "frame render process exited",
        4 => "utility process exited",
        5 => "sandbox helper process exited",
        6 => "GPU process exited",
        7 => "plugin process exited",
        8 => "plugin broker process exited",
        _ => "unknown process exited",
    }
}

/// `COREWEBVIEW2_PROCESS_FAILED_REASON` in words.
pub fn reason_name(reason: i32) -> &'static str {
    match reason {
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "launch failed",
        5 => "out of memory",
        6 => "profile deleted",
        _ => "unexpected",
    }
}

/// An exit code the way a crash dialog would say it.
pub fn exit_code_text(code: i32) -> String {
    let hex = format!("0x{:08X}", code as u32);
    match code as u32 {
        0 => "0".into(),
        0xC000_0005 => format!("{hex}, access violation"),
        0xC000_0409 => format!("{hex}, fast fail"),
        0xC000_0374 => format!("{hex}, heap corruption"),
        0xC000_013A => format!("{hex}, closed with Ctrl+C"),
        0x8000_0003 => format!("{hex}, breakpoint"),
        _ => hex,
    }
}

/// What the app does about a failed web view process.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Reaction {
    /// The browser process is gone: the web view is dead for good, a new process is the only cure.
    Restart,
    /// A page process is gone: the page is loaded again.
    Reload,
    /// Logged only (the runtime starts its own helpers again).
    LogOnly,
}

pub fn reaction(kind: i32) -> Reaction {
    match kind {
        0 => Reaction::Restart,
        1 | 3 => Reaction::Reload,
        _ => Reaction::LogOnly,
    }
}

/// The state of the browser process the main web view uses.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum BrowserState {
    /// Not recorded (the web view was not asked yet) or not readable.
    Unknown,
    Running,
    /// The process ended; its exit code when it could be read.
    Exited(Option<u32>),
}

impl BrowserState {
    pub fn text(&self) -> String {
        match self {
            BrowserState::Unknown => "state unknown".into(),
            BrowserState::Running => "running".into(),
            BrowserState::Exited(Some(c)) => format!("exited with {}", exit_code_text(*c as i32)),
            BrowserState::Exited(None) => "gone".into(),
        }
    }
}

// ---------- non-Windows: the web view is WebKit, nothing to watch ----------

#[cfg(not(windows))]
pub fn wait_for_previous_run() {}
#[cfg(not(windows))]
pub fn watch(_app: &tauri::AppHandle) {}
#[cfg(not(windows))]
pub fn reassert(_app: &tauri::AppHandle) {}
#[cfg(not(windows))]
pub fn browser_state() -> BrowserState {
    BrowserState::Unknown
}
#[cfg(not(windows))]
pub fn child_info(_app: &tauri::AppHandle) -> Option<String> {
    None
}
#[cfg(windows)]
pub use win::{browser_state, child_info, reassert, wait_for_previous_run, watch};

// ---------- Windows ----------

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, ProcessFailedEventHandler};
    use windows::core::{w, Interface, HRESULT, PCWSTR, PWSTR};
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, RECT, UNICODE_STRING, WAIT_TIMEOUT};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetClientRect, GetWindowRect, IsWindowVisible};

    /// The browser process of the main web view (0 = not asked yet).
    pub(super) static BROWSER_PID: AtomicU32 = AtomicU32::new(0);

    pub fn snapshot() -> Vec<Proc> {
        let mut out = vec![];
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    out.push(Proc { pid: e.th32ProcessID, ppid: e.th32ParentProcessID, name: String::from_utf16_lossy(&e.szExeFile[..len]) });
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    /// The command line of a process of this user (None when it cannot be read).
    pub fn command_line(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u8; 8192];
            let text = loop {
                let mut needed = 0u32;
                let status = NtQueryInformationProcess(h, ProcessCommandLineInformation, buf.as_mut_ptr() as *mut _, buf.len() as u32, &mut needed);
                if status.0 >= 0 {
                    // a UNICODE_STRING whose buffer follows it inside `buf`
                    let us = &*(buf.as_ptr() as *const UNICODE_STRING);
                    let chars = (us.Length / 2) as usize;
                    break (!us.Buffer.0.is_null() && chars > 0).then(|| String::from_utf16_lossy(std::slice::from_raw_parts(us.Buffer.0, chars)));
                }
                // STATUS_INFO_LENGTH_MISMATCH / STATUS_BUFFER_OVERFLOW / STATUS_BUFFER_TOO_SMALL: grow once to the size asked for
                let grow = matches!(status.0 as u32, 0xC000_0004 | 0x8000_0005 | 0xC000_0023) && (needed as usize) > buf.len() && (needed as usize) <= 1 << 20;
                if !grow {
                    break None;
                }
                buf.resize(needed as usize, 0);
            };
            let _ = CloseHandle(h);
            text
        }
    }

    fn own_exe() -> Option<String> {
        std::env::current_exe().ok().map(|p| p.to_string_lossy().to_lowercase())
    }

    fn image_path(h: HANDLE) -> Option<String> {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()? };
        Some(String::from_utf16_lossy(&buf[..len as usize]).to_lowercase())
    }

    /// Whether `pid` is a running process of this program (the previous run that is about to exit; a reused pid of another
    /// program is not it).
    pub fn is_previous_run(pid: u32) -> bool {
        if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
            return false;
        }
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) else { return false };
            let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            let ours = image_path(h).is_some_and(|p| Some(p) == own_exe());
            let _ = CloseHandle(h);
            running && ours
        }
    }

    /// The folder part of the web view's user data path: `\<identifier>\ebwebview` (Tauri puts it under the local app data folder).
    fn folder_marker() -> String {
        format!("\\{}\\ebwebview", crate::identity::identifier().to_lowercase())
    }

    /// Browser processes of this app's web view data folder whose app is gone.
    pub fn lingering(folder: &str) -> Vec<u32> {
        ownerless_browsers(&snapshot()).into_iter().filter(|pid| command_line(*pid).is_some_and(|c| is_browser_of(&c, folder))).collect()
    }

    /// Before the window (and so the web view) exists: while the previous run of this app is still exiting (a restart) or its web view
    /// browser process is still shutting down, wait, at most `WAIT_BUDGET`. A web view that starts now would join that process and
    /// die with it.
    pub fn wait_for_previous_run() {
        let previous = std::env::var(RELAUNCH_ENV).ok().and_then(|v| v.trim().parse::<u32>().ok());
        let folder = folder_marker();
        let w = wait_until_clear(
            || {
                let mut left: Vec<u32> = previous.filter(|p| is_previous_run(*p)).into_iter().collect();
                left.extend(lingering(&folder));
                left
            },
            std::thread::sleep,
            WAIT_BUDGET,
            POLL,
        );
        if w.first.is_empty() {
            return;
        }
        if w.left.is_empty() {
            crate::startup::line("webview", &format!("the previous run's web view processes {:?} were still shutting down: waited {} ms for them", w.first, w.waited_ms));
        } else {
            crate::startup::line("webview", &format!("processes {:?} of the previous run were still there after {} ms: starting anyway", w.left, w.waited_ms));
        }
    }

    /// How long ago a process was created.
    fn age_ms(pid: u32) -> Option<u64> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let (mut created, mut x, mut y, mut z) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            let ok = GetProcessTimes(h, &mut created, &mut x, &mut y, &mut z).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return None;
            }
            let then = ((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64) / 10_000; // 100 ns -> ms since 1601
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64 + 11_644_473_600_000;
            Some(now.saturating_sub(then))
        }
    }

    pub fn browser_state() -> BrowserState {
        let pid = BROWSER_PID.load(Ordering::SeqCst);
        if pid == 0 {
            return BrowserState::Unknown;
        }
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                // ERROR_INVALID_PARAMETER: no process has this id any more
                Err(e) if e.code() == HRESULT::from_win32(87) => BrowserState::Exited(None),
                Err(_) => BrowserState::Unknown,
                Ok(h) => {
                    let mut code = 0u32;
                    let r = GetExitCodeProcess(h, &mut code);
                    let _ = CloseHandle(h);
                    match r {
                        Ok(()) if code == 259 => BrowserState::Running, // STILL_ACTIVE
                        Ok(()) => BrowserState::Exited(Some(code)),
                        Err(_) => BrowserState::Unknown,
                    }
                }
            }
        }
    }

    /// The web view's own window inside the main window: size and visibility (what a screenshot of the area would be made from).
    pub fn child_info(app: &AppHandle) -> Option<String> {
        let hwnd = app.get_webview_window("main")?.hwnd().ok()?;
        unsafe {
            let child = FindWindowExW(Some(hwnd), None, w!("WRY_WEBVIEW"), PCWSTR::null()).ok()?;
            let mut r = RECT::default();
            GetWindowRect(child, &mut r).ok()?;
            Some(format!("web view window {}x{}, {}", r.right - r.left, r.bottom - r.top, if IsWindowVisible(child).as_bool() { "visible" } else { "hidden" }))
        }
    }

    /// Asks the web view controller to take up its state again: hidden, then visible, told about the window's position, bounds set to
    /// the whole client area. No flicker, no process work.
    pub fn reassert(app: &AppHandle) {
        let Some(win) = app.get_webview_window("main") else { return };
        let Ok(hwnd) = win.hwnd() else { return };
        let hwnd = hwnd.0 as isize;
        let _ = win.with_webview(move |pw| unsafe {
            let c = pw.controller();
            let _ = c.SetIsVisible(false);
            let _ = c.SetIsVisible(true);
            let _ = c.NotifyParentWindowPositionChanged();
            let mut r = RECT::default();
            if GetClientRect(HWND(hwnd as *mut _), &mut r).is_ok() {
                let _ = c.SetBounds(RECT { left: 0, top: 0, right: r.right - r.left, bottom: r.bottom - r.top });
            }
        });
    }

    /// Listens for the failures of a web view's processes and returns its browser process id. `on_failed(kind, description)` runs on the
    /// UI thread for every failure (`kind` = `COREWEBVIEW2_PROCESS_FAILED_KIND`).
    pub unsafe fn listen(core: &ICoreWebView2, mut on_failed: impl FnMut(i32, String) + 'static) -> windows::core::Result<u32> {
        unsafe {
            let mut pid = 0u32;
            core.BrowserProcessId(&mut pid)?;
            let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                if let Some(args) = args {
                    let (kind, detail) = describe(&args);
                    on_failed(kind, detail);
                }
                Ok(())
            }));
            let mut token = 0i64;
            core.add_ProcessFailed(&handler, &mut token)?;
            Ok(pid)
        }
    }

    /// Records the browser process of the main web view and listens for its failures. Call once, after the window exists.
    pub fn watch(app: &AppHandle) {
        let Some(win) = app.get_webview_window("main") else { return };
        let app = app.clone();
        let asked = win.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let handler_app = app.clone();
            match listen(&core, move |kind, detail| crate::startup::web_view_failed(&handler_app, kind, &detail)) {
                Ok(pid) => {
                    BROWSER_PID.store(pid, Ordering::SeqCst);
                    let parent = snapshot().into_iter().find(|p| p.pid == pid).map(|p| p.ppid);
                    let whose = match parent {
                        Some(p) if p == GetCurrentProcessId() => "started by this run".to_string(),
                        Some(p) => format!("started by process {p}: another run's, this web view joined it"),
                        None => "parent unknown".to_string(),
                    };
                    let age = age_ms(pid).map(|a| format!("{a} ms old")).unwrap_or_else(|| "age unknown".into());
                    crate::startup::line("webview", &format!("browser process {pid}: {whose}, {age}; listening for web view failures"));
                }
                Err(e) => crate::startup::line("webview", &format!("could not listen for web view failures: {e}")),
            }
        });
        if let Err(e) = asked {
            crate::startup::line("webview", &format!("could not reach the web view controller: {e}"));
        }
    }

    /// Kind and a readable description of a failure event.
    unsafe fn describe(args: &ICoreWebView2ProcessFailedEventArgs) -> (i32, String) {
        unsafe {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
            let _ = args.ProcessFailedKind(&mut kind);
            let mut parts: Vec<String> = vec![];
            if let Ok(a2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON(0);
                if a2.Reason(&mut reason).is_ok() {
                    parts.push(format!("reason: {}", reason_name(reason.0)));
                }
                let mut code = 0i32;
                if a2.ExitCode(&mut code).is_ok() {
                    parts.push(format!("exit code: {}", exit_code_text(code)));
                }
                let mut desc = PWSTR::null();
                if a2.ProcessDescription(&mut desc).is_ok() && !desc.is_null() {
                    parts.push(format!("process: {}", take_pwstr(desc)));
                }
            }
            if let Ok(a3) = args.cast::<ICoreWebView2ProcessFailedEventArgs3>() {
                let mut module = PWSTR::null();
                if a3.FailureSourceModulePath(&mut module).is_ok() && !module.is_null() {
                    let m = take_pwstr(module);
                    if !m.is_empty() {
                        parts.push(format!("failed in: {m}"));
                    }
                }
            }
            (kind.0, parts.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn p(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc { pid, ppid, name: name.into() }
    }

    #[test]
    fn a_browser_process_whose_app_is_gone_is_found_and_its_helpers_are_not() {
        let procs = vec![
            p(4, 0, "System"),
            p(100, 4, "explorer.exe"),
            p(200, 100, "hey-look.exe"),
            p(210, 200, "msedgewebview2.exe"), // browser of a running app
            p(211, 210, "msedgewebview2.exe"), // its renderer
            p(300, 999, "msedgewebview2.exe"), // browser whose app (999) is gone
            p(301, 300, "msedgewebview2.exe"), // helper of that browser: parent runs
            p(302, 300, "MSEDGEWEBVIEW2.EXE"),
            p(400, 999, "chrome.exe"), // not the web view runtime
        ];
        assert_eq!(ownerless_browsers(&procs), vec![300]);
        assert!(ownerless_browsers(&[]).is_empty());
    }

    #[test]
    fn only_the_browser_process_of_this_apps_data_folder_counts() {
        let folder = "\\thnonl.heylook\\ebwebview";
        let browser = r#""C:\Program Files (x86)\Microsoft\EdgeWebView\Application\154.0.4258.62\msedgewebview2.exe" --embedded-browser-webview=1 --webview-exe-name=hey-look.exe --user-data-dir="C:\Users\me\AppData\Local\thnonl.heylook\EBWebView" --lang=en-US"#;
        assert!(is_browser_of(browser, folder));
        assert!(is_browser_of(&browser.replace('\\', "/"), folder), "slashes do not matter");
        assert!(is_browser_of(&browser.to_uppercase(), folder), "case does not matter");
        let gpu = format!("{browser} --type=gpu-process");
        assert!(!is_browser_of(&gpu, folder), "a helper is not the browser process");
        let other = browser.replace("thnonl.heylook", "other.app");
        assert!(!is_browser_of(&other, folder), "another app's web view");
        assert!(!is_browser_of("msedgewebview2.exe --embedded-browser-webview=1", folder), "no data folder given");
    }

    /// Fake clock: `check` reports `busy` for the first `gone_after` looks.
    fn wait(gone_after: Option<u32>, budget_ms: u64) -> (Waited, u32) {
        let looks = Cell::new(0u32);
        let slept = RefCell::new(Duration::ZERO);
        let w = wait_until_clear(
            || {
                looks.set(looks.get() + 1);
                if gone_after.is_some_and(|n| looks.get() > n) { vec![] } else { vec![77] }
            },
            |d| *slept.borrow_mut() += d,
            Duration::from_millis(budget_ms),
            Duration::from_millis(100),
        );
        let n = looks.get();
        (w, n)
    }

    #[test]
    fn nothing_in_the_way_costs_no_time() {
        let (w, looks) = wait(Some(0), 10_000);
        assert_eq!(w, Waited { first: vec![], left: vec![], waited_ms: 0 });
        assert_eq!(looks, 1);
    }

    #[test]
    fn a_process_that_exits_ends_the_wait_at_once() {
        let (w, _) = wait(Some(5), 10_000);
        assert_eq!(w.first, vec![77]);
        assert!(w.left.is_empty());
        assert_eq!(w.waited_ms, 500);
    }

    #[test]
    fn a_process_that_never_exits_is_waited_for_only_as_long_as_the_budget() {
        let (w, _) = wait(None, 3000);
        assert_eq!(w.left, vec![77]);
        assert_eq!(w.waited_ms, 3000);
    }

    #[test]
    fn failures_are_named_and_the_browser_process_is_the_one_that_restarts_the_app() {
        assert_eq!(kind_name(0), "browser process exited");
        assert_eq!(kind_name(6), "GPU process exited");
        assert_eq!(kind_name(99), "unknown process exited");
        assert_eq!(reaction(0), Reaction::Restart);
        assert_eq!(reaction(1), Reaction::Reload);
        assert_eq!(reaction(3), Reaction::Reload);
        for k in [2, 4, 5, 6, 7, 8, 9] {
            assert_eq!(reaction(k), Reaction::LogOnly, "kind {k}");
        }
        assert_eq!(reason_name(3), "crashed");
        assert_eq!(exit_code_text(0), "0");
        assert_eq!(exit_code_text(0xC000_0005u32 as i32), "0xC0000005, access violation");
        assert_eq!(exit_code_text(7), "0x00000007");
    }

    #[test]
    fn the_browser_state_reads_in_words() {
        assert_eq!(BrowserState::Running.text(), "running");
        assert_eq!(BrowserState::Exited(Some(0xC000_0005)).text(), "exited with 0xC0000005, access violation");
        assert_eq!(BrowserState::Exited(None).text(), "gone");
        assert_eq!(BrowserState::Unknown.text(), "state unknown");
    }

    /// The module that is the source of the restart wait names the browser executable the runtime uses.
    #[test]
    fn the_runtime_executable_name_is_the_one_the_crash_reports_show() {
        assert_eq!(BROWSER_EXE, "msedgewebview2.exe");
    }

    #[cfg(windows)]
    mod windows_only {
        use super::super::win::*;
        use super::super::*;
        use std::os::windows::process::CommandExt;

        /// The four tests below that start processes or real web views never overlap: cargo runs tests in parallel threads, and two real web views, a
        /// copied executable that Defender scans on its first start and a process that has to be found within a time window made each other late.
        /// Poison-tolerant: a test that failed must not fail the others with "poisoned".
        static WV2_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        fn wv2_lock() -> std::sync::MutexGuard<'static, ()> {
            WV2_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// Polls `f` every 50 ms until it gives a value; the cap (60 s) is not a sleep, it only ends a test that would never succeed.
        fn poll_until<T>(cap: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
            let t0 = std::time::Instant::now();
            loop {
                if let Some(v) = f() {
                    return Some(v);
                }
                if t0.elapsed() >= cap {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        const WAIT_CAP: Duration = Duration::from_secs(60);

        /// Ends a process the way Task Manager does (`OpenProcess` + `TerminateProcess`, no `taskkill` is started) and waits until it is gone.
        fn terminate(pid: u32) -> bool {
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};
            unsafe {
                let Ok(h) = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid) else { return false };
                let ended = TerminateProcess(h, 1).is_ok();
                let _ = WaitForSingleObject(h, 30_000);
                let _ = CloseHandle(h);
                ended
            }
        }

        #[test]
        fn this_process_is_in_the_snapshot_and_its_command_line_is_readable() {
            let me = std::process::id();
            let snap = snapshot();
            let mine = snap.iter().find(|p| p.pid == me).expect("own process in the snapshot");
            let exe = std::env::current_exe().unwrap();
            assert!(exe.file_name().unwrap().to_string_lossy().eq_ignore_ascii_case(&mine.name), "{} vs {}", mine.name, exe.display());
            let line = command_line(me).expect("own command line");
            assert!(line.to_lowercase().contains(&mine.name.to_lowercase().replace(".exe", "")), "{line}");
        }

        /// Kills the fake browser process even when the test fails.
        struct Kill(Option<u32>);
        impl Drop for Kill {
            fn drop(&mut self) {
                if let Some(pid) = self.0 {
                    let _ = terminate(pid);
                }
            }
        }

        /// Sleeps when started as the fake browser (see the test below); passes at once in a normal run.
        #[test]
        fn fake_webview_browser_sleeper() {
            if std::env::var_os("HEYLOOK_FAKE_WV2").is_some() {
                std::thread::sleep(Duration::from_secs(25));
            }
        }

        /// The real detection with a real process: a small executable named like the web view runtime (a copy of the system `cmd.exe`, which runs
        /// `ping` for a minute), started with a `--user-data-dir` of this app's folder shape by a `cmd` that exits at once, so its parent is gone (what
        /// the previous run's browser process looks like). It is found; the wait sees it and ends when it is gone, which the injected clock makes
        /// happen on the first look (no real time passes, nothing depends on how fast a process starts or dies). Nothing is shown (no window).
        #[test]
        fn an_ownerless_browser_process_of_this_apps_folder_is_found_until_it_exits() {
            let _lock = wv2_lock();
            let dir = std::env::temp_dir().join(format!("heylook-wv2-test-{}", std::process::id()));
            let data = dir.join("thnonl.heylook").join("EBWebView");
            std::fs::create_dir_all(&data).unwrap();
            let fake = dir.join(BROWSER_EXE);
            let system = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into());
            std::fs::copy(system.join("System32").join("cmd.exe"), &fake).unwrap();
            let folder = "\\thnonl.heylook\\ebwebview";

            let mut cmd = crate::winproc::hidden("cmd");
            cmd.raw_arg(format!("/C start \"\" /B \"{}\" /c \"ping -n 60 127.0.0.1 >nul & rem --user-data-dir={}\"", fake.display(), data.display()));
            assert!(cmd.status().unwrap().success());

            let want = fake.to_string_lossy().to_lowercase();
            let find = || lingering(folder).into_iter().find(|pid| command_line(*pid).is_some_and(|c| c.to_lowercase().contains(&want)));
            let pid = poll_until(WAIT_CAP, find).expect("the ownerless fake browser process is found");
            let _guard = Kill(Some(pid));
            let children: Vec<u32> = snapshot().into_iter().filter(|p| p.ppid == pid).map(|p| p.pid).collect();

            // the wait sees it, and the first time it sleeps (the injected clock) the process is ended and gone
            let mut ended = false;
            let w = wait_until_clear(
                || lingering(folder).into_iter().filter(|p| command_line(*p).map_or(true, |c| c.to_lowercase().contains(&want))).collect(),
                |_| {
                    if !ended {
                        ended = true;
                        assert!(terminate(pid), "the fake browser process could be ended");
                    }
                },
                Duration::from_secs(10),
                Duration::from_millis(100),
            );
            for c in children {
                let _ = terminate(c);
            }
            assert!(w.first.contains(&pid), "{w:?}");
            assert!(w.left.is_empty(), "{w:?}");
            assert!(w.waited_ms >= 100, "{w:?}");
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// The failure listener with a real web view that is never shown (a window that is never made visible, a temp data folder):
        /// the browser process is killed the way a crash or Task Manager would, and the listener must say what failed. Skipped on a
        /// machine without the WebView2 runtime.
        #[test]
        fn a_killed_web_view_browser_process_is_reported_with_its_kind_and_exit_code() {
            let _lock = wv2_lock();
            use std::sync::mpsc;
            use webview2_com::{CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler};
            use windows::core::{w, HSTRING, PCWSTR};
            use windows::Win32::Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            use windows::Win32::System::LibraryLoader::GetModuleHandleW;
            use windows::Win32::UI::WindowsAndMessaging::*;
            use webview2_com::Microsoft::Web::WebView2::Win32::*;

            unsafe extern "system" fn test_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
                unsafe { DefWindowProcW(h, m, w, l) }
            }
            let folder = std::env::temp_dir().join(format!("heylook-wv2-listen-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&folder);
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                // a top-level window that is never shown
                let class = WNDCLASSW { lpfnWndProc: Some(test_proc), lpszClassName: w!("HEYLOOK_WV2_TEST"), ..Default::default() };
                RegisterClassW(&class);
                let hinst = GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0));
                let host = CreateWindowExW(Default::default(), w!("HEYLOOK_WV2_TEST"), w!("test"), WS_POPUP, 0, 0, 400, 300, None, None, hinst, None).unwrap();

                let udf = HSTRING::from(folder.to_string_lossy().as_ref());
                let (tx, rx) = mpsc::channel();
                let env = CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
                    Box::new(move |h| CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &udf, None::<&ICoreWebView2EnvironmentOptions>, &h).map_err(webview2_com::Error::WindowsError)),
                    Box::new(move |code, env| {
                        code?;
                        tx.send(env.ok_or_else(|| windows::core::Error::from(E_POINTER))).ok();
                        Ok(())
                    }),
                );
                let env = match env.ok().and_then(|_| rx.recv().ok()).and_then(|r| r.ok()) {
                    Some(e) => e,
                    None => {
                        eprintln!("no WebView2 runtime here: test skipped");
                        let _ = DestroyWindow(host);
                        return;
                    }
                };
                let (tx, rx) = mpsc::channel();
                CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
                    Box::new(move |h| env.CreateCoreWebView2Controller(host, &h).map_err(webview2_com::Error::WindowsError)),
                    Box::new(move |code, c| {
                        code?;
                        tx.send(c.ok_or_else(|| windows::core::Error::from(E_POINTER))).ok();
                        Ok(())
                    }),
                )
                .unwrap();
                let controller = rx.recv().unwrap().unwrap();
                let core = controller.CoreWebView2().unwrap();

                let (ftx, frx) = mpsc::channel();
                let pid = listen(&core, move |kind, detail| {
                    ftx.send((kind, detail)).ok();
                })
                .unwrap();
                assert!(pid != 0, "a browser process id");
                BROWSER_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
                assert_eq!(browser_state(), BrowserState::Running, "the process this web view uses runs");
                let me = std::process::id();
                let parent = snapshot().into_iter().find(|p| p.pid == pid).map(|p| p.ppid);
                assert_eq!(parent, Some(me), "a web view created by this process starts its own browser process");

                // what a crash or Task Manager does
                assert!(terminate(pid), "the browser process could be ended");

                // the callbacks arrive on this thread's message loop
                let mut got = None;
                let t0 = std::time::Instant::now();
                while t0.elapsed() < WAIT_CAP && got.is_none() {
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    got = frx.try_recv().ok();
                    std::thread::sleep(Duration::from_millis(20));
                }
                let (kind, detail) = got.expect("a failure event within 60 s of killing the browser process");
                eprintln!("web view failure reported: kind {kind} ({}), {detail}", kind_name(kind));
                assert_eq!(kind, 0, "browser process exited: {detail}");
                assert_eq!(reaction(kind), Reaction::Restart);
                assert!(detail.contains("exit code: 0x"), "{detail}");
                assert!(matches!(browser_state(), BrowserState::Exited(_)), "{:?}", browser_state());
                let _ = controller.Close();
                let _ = DestroyWindow(host);
                let _: HWND = HWND::default();
            }
            // the helper processes of the killed browser are still going away for a moment
            for _ in 0..50 {
                if std::fs::remove_dir_all(&folder).is_ok() || !folder.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        /// BUG-15 (QA round 8): after a page (render) process dies, which call brings the page back? A real web view that is never
        /// shown loads a page, its render process is killed, the failure event arrives (kind 1), and then the page is loaded again
        /// the way the app did (`window.location.reload()` run in the page) or with the native `Reload()`. The native reload must
        /// produce a successful navigation (the wait ends at the navigation; the cap is 60 s). The script variant is measured and printed (`--nocapture`), not asserted:
        /// the round-8 logs say it did nothing, and a script cannot run in a page whose process is gone. Skipped without WebView2.
        #[test]
        fn a_killed_page_process_comes_back_with_the_native_reload() {
            let _lock = wv2_lock();
            // the native reload is the one that must bring the page back: it gets the 60 s cap of every wait here. The script variant is only measured (the round-8 logs say it
            // does nothing, so it is waited for 10 s, not 60: a condition that is expected never to come is not worth a minute)
            let native = reload_after_render_kill("native Reload()", WAIT_CAP, |core| unsafe { core.Reload().is_ok() });
            let script = reload_after_render_kill("script location.reload()", Duration::from_secs(10), |core| unsafe {
                use webview2_com::ExecuteScriptCompletedHandler;
                use windows::core::HSTRING;
                let done = ExecuteScriptCompletedHandler::create(Box::new(|_err, _result| Ok(())));
                core.ExecuteScript(&HSTRING::from("window.location.reload()"), &done).is_ok()
            });
            eprintln!("render kill recovery: native reload -> {native:?}, script reload -> {script:?}");
            if let Some(n) = native {
                assert_eq!(n.kind, 1, "a render process exited event: {n:?}");
                assert!(n.back_ms.is_some(), "the native reload must bring the page back within 60 s: {n:?}");
            }
        }

        #[derive(Debug)]
        struct Recovery {
            /// the failure kind of the first event after the kill (1 = render process exited)
            kind: i32,
            /// milliseconds from the reload call to a successful navigation, None when none came within the cap
            back_ms: Option<u128>,
        }

        /// Starts a hidden real web view on a page, kills its render process, and calls `reload` once the failure event came.
        fn reload_after_render_kill(label: &str, back_cap: Duration, reload: impl Fn(&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> bool) -> Option<Recovery> {
            use std::sync::mpsc;
            use webview2_com::{CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler, NavigationCompletedEventHandler};
            use windows::core::{w, HSTRING, PCWSTR};
            use windows::Win32::Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            use windows::Win32::System::LibraryLoader::GetModuleHandleW;
            use windows::Win32::UI::WindowsAndMessaging::*;
            use webview2_com::Microsoft::Web::WebView2::Win32::*;

            unsafe extern "system" fn proc2(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
                unsafe { DefWindowProcW(h, m, w, l) }
            }
            let folder = std::env::temp_dir().join(format!("heylook-wv2-render-{}-{}", std::process::id(), label.len()));
            let _ = std::fs::remove_dir_all(&folder);
            let result;
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let class = WNDCLASSW { lpfnWndProc: Some(proc2), lpszClassName: w!("HEYLOOK_WV2_TEST2"), ..Default::default() };
                RegisterClassW(&class);
                let hinst = GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0));
                let host = CreateWindowExW(Default::default(), w!("HEYLOOK_WV2_TEST2"), w!("test"), WS_POPUP, 0, 0, 400, 300, None, None, hinst, None).unwrap();
                let pump = |ms: u64, stop: &mut dyn FnMut() -> bool| {
                    let t0 = std::time::Instant::now();
                    while t0.elapsed() < Duration::from_millis(ms) && !stop() {
                        let mut msg = MSG::default();
                        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                };
                let udf = HSTRING::from(folder.to_string_lossy().as_ref());
                let (tx, rx) = mpsc::channel();
                let env = CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
                    Box::new(move |h| CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &udf, None::<&ICoreWebView2EnvironmentOptions>, &h).map_err(webview2_com::Error::WindowsError)),
                    Box::new(move |code, env| {
                        code?;
                        tx.send(env.ok_or_else(|| windows::core::Error::from(E_POINTER))).ok();
                        Ok(())
                    }),
                );
                let Some(env) = env.ok().and_then(|_| rx.recv().ok()).and_then(|r| r.ok()) else {
                    eprintln!("no WebView2 runtime here: test skipped");
                    let _ = DestroyWindow(host);
                    return None;
                };
                let (tx, rx) = mpsc::channel();
                CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
                    Box::new(move |h| env.CreateCoreWebView2Controller(host, &h).map_err(webview2_com::Error::WindowsError)),
                    Box::new(move |code, c| {
                        code?;
                        tx.send(c.ok_or_else(|| windows::core::Error::from(E_POINTER))).ok();
                        Ok(())
                    }),
                )
                .unwrap();
                let controller = rx.recv().unwrap().unwrap();
                let core = controller.CoreWebView2().unwrap();

                // the result of every navigation that completes
                let (ntx, nrx) = mpsc::channel::<bool>();
                let handler = NavigationCompletedEventHandler::create(Box::new(move |_s, args| {
                    let mut ok = windows::core::BOOL(0);
                    if let Some(a) = args {
                        let _ = a.IsSuccess(&mut ok);
                    }
                    ntx.send(ok.as_bool()).ok();
                    Ok(())
                }));
                let mut token = 0i64;
                core.add_NavigationCompleted(&handler, &mut token).unwrap();
                let (ftx, frx) = mpsc::channel();
                let pid = listen(&core, move |kind, detail| {
                    ftx.send((kind, detail)).ok();
                })
                .unwrap();
                core.Navigate(&HSTRING::from("data:text/html,<title>heylook</title><p>page</p>")).unwrap();
                let mut first = None;
                pump(60_000, &mut || {
                    first = first.or(nrx.try_recv().ok());
                    first.is_some()
                });
                assert_eq!(first, Some(true), "the first page loads");

                // the render process: a child of the browser process
                let mut renderer = None;
                let t_find = std::time::Instant::now();
                while renderer.is_none() && t_find.elapsed() < WAIT_CAP {
                    renderer = snapshot().into_iter().filter(|p| p.ppid == pid).find(|p| command_line(p.pid).is_some_and(|c| c.contains("--type=renderer"))).map(|p| p.pid);
                    if renderer.is_none() {
                        pump(100, &mut || false);
                    }
                }
                let renderer = renderer.expect("a render process of this web view");
                assert!(terminate(renderer), "the render process could be ended");
                let mut ev = None;
                pump(60_000, &mut || {
                    ev = ev.take().or(frx.try_recv().ok());
                    ev.is_some()
                });
                let (kind, detail) = ev.expect("a failure event within 60 s of killing the render process");
                eprintln!("[{label}] failure reported: kind {kind} ({}), {detail}", kind_name(kind));
                while nrx.try_recv().is_ok() {} // navigations of the error page do not count
                let t0 = std::time::Instant::now();
                let asked = reload(&core);
                let mut back = None;
                pump(back_cap.as_millis() as u64, &mut || {
                    if nrx.try_recv().ok() == Some(true) {
                        back = Some(t0.elapsed().as_millis());
                    }
                    back.is_some()
                });
                eprintln!("[{label}] reload call ok: {asked}; page back after: {back:?} ms");
                result = Some(Recovery { kind, back_ms: back });
                let _ = controller.Close();
                let _ = DestroyWindow(host);
            }
            for _ in 0..50 {
                if std::fs::remove_dir_all(&folder).is_ok() || !folder.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            result
        }

        /// The restart wait (`HEYLOOK_RELAUNCH_OF`) only waits for a running process of this very program: another program, this
        /// process itself and pid 0 never hold it up; a running second copy of this program does, until it ends.
        #[test]
        fn the_previous_run_check_only_accepts_a_running_process_of_this_program() {
            let _lock = wv2_lock();
            assert!(!is_previous_run(0));
            assert!(!is_previous_run(std::process::id()));
            assert!(!is_previous_run(4), "System is not this program");
            let mut cmd = crate::winproc::hidden(&std::env::current_exe().unwrap().to_string_lossy());
            cmd.env("HEYLOOK_FAKE_WV2", "1").arg("fake_webview_browser_sleeper");
            let mut child = cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
            let pid = child.id();
            let _guard = Kill(Some(pid));
            assert!(poll_until(WAIT_CAP, || is_previous_run(pid).then_some(())).is_some(), "a running copy of this program");
            child.kill().unwrap();
            let _ = child.wait();
            assert!(!is_previous_run(pid), "it ended");
        }
    }
}
