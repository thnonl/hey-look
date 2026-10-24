//! Linux: the web view of a window that sat in the tray (QA Linux v1.0.6, WebKitGTK 2.52: after "close hides to the tray" and "Open Hey
//! Look!" from the tray menu the window showed a blank white page for the rest of the session; not reproduced on a fresh start).
//!
//! What can make that page white is not known from the log (nothing watched the web view on Linux: `webview_health.rs` is Windows only), so
//! this looks at the likely causes and cures what can be cured:
//! - the web process died while the window was hidden (WebKit then shows a white view until the page is loaded again): the
//!   `web-process-terminated` signal reloads the page at once, hidden or not (`watch`);
//! - the web process is alive but stuck, or the view did not take up the visible state after `hide()` + `show()`: when the window comes back
//!   from the tray the view is asked to redraw, and a round trip with the page (`eval` of a call to the command `page_pong`) tells whether the
//!   page still runs; if it does not answer within `PONG_WAIT` the page is reloaded (`startup::recover_dead_page`: reload, load the
//!   address again, restart, bounded);
//! - every one of these steps is written to startup.log with what WebKit says (is the web process responsive, which address is loaded).
//!
//! (Pixels are not read: a page that runs but is painted white is not seen here. `startup::page_state` reports visibility and animation
//! frames a moment after the show and does a hide + show when the page says it is not painting.)
use crate::startup;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// How long the page gets to answer the round trip after the window came back.
pub const PONG_WAIT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(50);

static PINGS: AtomicU64 = AtomicU64::new(0);
/// The highest ping the page answered.
static PONGED: AtomicU64 = AtomicU64::new(0);
static PONG_VISIBILITY: Mutex<String> = Mutex::new(String::new());
/// When the window was hidden to the tray (taken by the next show).
static HIDDEN_AT: Mutex<Option<Instant>> = Mutex::new(None);

/// The window was hidden to the tray (the close button).
pub fn note_hidden() {
    if cfg!(target_os = "linux") {
        *HIDDEN_AT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        startup::stage(None, "window hidden to the tray");
    }
}

/// The page answers a ping (command `page_pong`).
pub fn pong(nonce: u64, visibility: &str) {
    *PONG_VISIBILITY.lock().unwrap_or_else(|p| p.into_inner()) = visibility.to_string();
    PONGED.fetch_max(nonce, Ordering::SeqCst);
}

/// Send a ping and wait for its answer: `Some(time it took)` or `None` when `wait` passed without one. The clock and the sending are
/// injected so a test needs neither a page nor time.
pub fn ping_until(send: impl FnOnce(u64), answered: impl Fn(u64) -> bool, mut sleep: impl FnMut(Duration), wait: Duration) -> Option<Duration> {
    let nonce = PINGS.fetch_add(1, Ordering::SeqCst) + 1;
    send(nonce);
    let mut waited = Duration::ZERO;
    while waited < wait {
        if answered(nonce) {
            return Some(waited);
        }
        sleep(POLL);
        waited += POLL;
    }
    answered(nonce).then_some(waited)
}

/// The script of a ping: the page calls `page_pong` with the nonce and what it believes about its visibility.
fn ping_script(nonce: u64) -> String {
    format!("try{{window.__TAURI_INTERNALS__.invoke('page_pong',{{nonce:{nonce},visibility:document.visibilityState}})}}catch(e){{}}")
}

/// The window was shown again after it sat in the tray (called by `shell::show_main`): redraw the view, ask the page whether it still runs
/// and reload it when it does not answer. Never blocks the caller.
pub fn after_show(app: &AppHandle) {
    if !cfg!(target_os = "linux") || !startup::is_ready() || startup::is_exiting() {
        return;
    }
    // only a window that was hidden to the tray: the first show of a start and a hide + show of the blank-window escalation have their own looks
    let Some(hidden) = HIDDEN_AT.lock().unwrap_or_else(|p| p.into_inner()).take() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        startup::stage(Some(&app), &format!("tray: the window is back after {} s in the tray, asking the web view to redraw ({})", hidden.elapsed().as_secs(), web_facts(&app)));
        nudge(&app);
        let page = app.get_webview_window("main");
        let started = Instant::now();
        let answer = ping_until(
            |nonce| {
                if let Some(w) = &page {
                    let _ = w.eval(ping_script(nonce));
                }
            },
            |nonce| PONGED.load(Ordering::SeqCst) >= nonce,
            std::thread::sleep,
            PONG_WAIT,
        );
        match answer {
            Some(took) => {
                let seen = PONG_VISIBILITY.lock().unwrap_or_else(|p| p.into_inner()).clone();
                startup::stage(Some(&app), &format!("tray: the page answered after {} ms (it sees itself as {seen}); {}", took.as_millis(), web_facts(&app)));
            }
            None => {
                startup::stage(Some(&app), &format!("tray: the page did not answer within {} s ({}): it is loaded again", PONG_WAIT.as_secs(), web_facts(&app)));
                startup::recover_dead_page(&app, &format!("the page does not answer {} ms after the window came back from the tray", started.elapsed().as_millis()));
            }
        }
    });
}

/// Ask the view to lay out and draw itself again, as a window that was just shown would after a resize.
fn nudge(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.eval("window.dispatchEvent(new Event('resize'))");
    #[cfg(target_os = "linux")]
    let _ = w.with_webview(|pw| {
        use gtk::prelude::WidgetExt;
        let view = pw.inner();
        view.queue_resize();
        view.queue_draw();
    });
}

/// What WebKit says about its web process, for the log.
#[cfg(target_os = "linux")]
fn web_facts(app: &AppHandle) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    let asked = app
        .get_webview_window("main")
        .map(|w| {
            w.with_webview(move |pw| {
                use webkit2gtk::WebViewExt;
                let view = pw.inner();
                let uri = view.uri().map(|u| u.to_string()).unwrap_or_default();
                let _ = tx.send(format!("web process responsive: {}, loaded: {uri}", view.is_web_process_responsive()));
            })
            .is_ok()
        })
        .unwrap_or(false);
    if !asked {
        return "no web view".into();
    }
    // (runs on the main thread: when that is busy the answer comes late or not at all)
    rx.recv_timeout(Duration::from_secs(1)).unwrap_or_else(|_| "the main thread did not answer".into())
}

#[cfg(not(target_os = "linux"))]
fn web_facts(_app: &AppHandle) -> String {
    String::new()
}

/// Listen to the web view's own signals: a web process that ends (crash, memory limit) leaves a white view until the page is loaded again,
/// and one that stops answering is written down. Called once at start-up (`startup::start`).
#[cfg(target_os = "linux")]
pub fn watch(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let handle = app.clone();
    let hooked = w.with_webview(move |pw| {
        use webkit2gtk::{WebProcessTerminationReason, WebViewExt};
        let view = pw.inner();
        let on_end = handle.clone();
        view.connect_web_process_terminated(move |_, reason| {
            let why = match reason {
                WebProcessTerminationReason::Crashed => "crashed",
                WebProcessTerminationReason::ExceededMemoryLimit => "was ended for using too much memory",
                WebProcessTerminationReason::TerminatedByApi => "was ended by the app",
                _ => "ended",
            };
            startup::stage(Some(&on_end), &format!("web view: the web process {why}"));
            if startup::is_exiting() {
                return;
            }
            let app = on_end.clone();
            std::thread::spawn(move || startup::recover_dead_page(&app, "the web process of the web view ended"));
        });
        let on_change = handle.clone();
        view.connect_is_web_process_responsive_notify(move |view| {
            let state = if view.is_web_process_responsive() { "answers again" } else { "does not answer" };
            startup::stage(Some(&on_change), &format!("web view: the web process {state}"));
        });
    });
    startup::stage(Some(app), &format!("linux: web view signals (process ended, not responding): {}", hooked.err().map(|e| e.to_string()).unwrap_or_else(|| "listening".into())));
}

/// The same for the web view of a secondary window (W4.2): every end of the web process is a failure of kind 1 (a render process that exited) for
/// `popout::page_failed`, which reloads the window once and ends it the second time; "does not answer" is a failure of kind 2 (log only).
#[cfg(target_os = "linux")]
pub fn watch_window(app: &AppHandle, win: &tauri::WebviewWindow, label: &str) {
    let (handle, label) = (app.clone(), label.to_string());
    let hooked = win.with_webview(move |pw| {
        use webkit2gtk::{WebProcessTerminationReason, WebViewExt};
        let view = pw.inner();
        let (on_end, name) = (handle.clone(), label.clone());
        view.connect_web_process_terminated(move |_, reason| {
            let why = match reason {
                WebProcessTerminationReason::Crashed => "crashed",
                WebProcessTerminationReason::ExceededMemoryLimit => "was ended for using too much memory",
                WebProcessTerminationReason::TerminatedByApi => "was ended by the app",
                _ => "ended",
            };
            crate::popout::page_failed(&on_end, &name, 1, &format!("the web process {why}"));
        });
        let (on_change, name) = (handle.clone(), label.clone());
        view.connect_is_web_process_responsive_notify(move |view| {
            if !view.is_web_process_responsive() {
                crate::popout::page_failed(&on_change, &name, 2, "the web process does not answer");
            }
        });
    });
    if let Err(e) = hooked {
        startup::stage(Some(app), &format!("a secondary window's web view could not be watched: {e}"));
    }
}

#[cfg(not(target_os = "linux"))]
pub fn watch(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn a_page_that_answers_is_timed_and_one_that_does_not_is_given_up_after_the_wait() {
        // answers on the 4th look (200 ms)
        let looks = Cell::new(0);
        let took = ping_until(|_| {}, |_| { looks.set(looks.get() + 1); looks.get() > 4 }, |_| {}, PONG_WAIT);
        assert_eq!(took, Some(Duration::from_millis(200)));
        // never: no real time passes, the fake sleep adds up to the wait
        let slept = Cell::new(Duration::ZERO);
        let sent = Cell::new(0u64);
        let took = ping_until(|n| sent.set(n), |_| false, |d| slept.set(slept.get() + d), PONG_WAIT);
        assert_eq!(took, None);
        assert_eq!(slept.get(), PONG_WAIT);
        assert!(sent.get() > 0, "the ping went out");
        // an answer to an older ping does not count
        let n_old = PINGS.load(Ordering::SeqCst);
        pong(n_old, "visible");
        assert_eq!(ping_until(|_| {}, |n| PONGED.load(Ordering::SeqCst) >= n, |_| {}, Duration::from_millis(100)), None);
        // the page's own answer does
        let took = ping_until(|n| pong(n, "hidden"), |n| PONGED.load(Ordering::SeqCst) >= n, |_| {}, PONG_WAIT);
        assert_eq!(took, Some(Duration::ZERO));
        assert_eq!(*PONG_VISIBILITY.lock().unwrap(), "hidden");
    }

    #[test]
    fn the_ping_script_calls_the_command_with_the_nonce() {
        let s = ping_script(7);
        assert!(s.contains("invoke('page_pong',{nonce:7,visibility:document.visibilityState})"), "{s}");
    }

    /// The Linux code cannot be compiled on every machine that runs the tests, so the wiring is read from the sources.
    #[test]
    fn the_tray_round_trip_is_wired() {
        let shell = crate::test_guard::non_test_code(include_str!("shell.rs"));
        let show = &shell[shell.find("pub fn show_main").unwrap()..];
        let show = &show[..show.find("\n}\n").unwrap()];
        assert!(show.contains("crate::linuxview::after_show(app)"), "{show}");
        assert!(show.find("w.show()").unwrap() < show.find("after_show").unwrap(), "the check follows the show: {show}");
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let close = &lib[lib.find("tauri::WindowEvent::CloseRequested").unwrap()..];
        let close = &close[..close.find(".invoke_handler").unwrap()];
        assert!(close.contains("window.hide();") && close.contains("linuxview::note_hidden()"), "{close}");
        assert!(lib.contains("fn page_pong(") && lib.contains("            page_pong,"));
        let start = crate::test_guard::non_test_code(include_str!("startup.rs"));
        let start = &start[start.find("pub fn start(").unwrap()..];
        assert!(start.contains("crate::linuxview::watch(app)"));
        let me = crate::test_guard::non_test_code(include_str!("linuxview.rs"));
        assert!(me.contains("connect_web_process_terminated") && me.contains("recover_dead_page") && me.contains("is_web_process_responsive"));
    }
}
