//! macOS: print a message (1.0.7 W5.3). `contentWindow.print()` of the message frame does nothing in WKWebView, and `WebviewWindow::print()` would print the whole app page, so the page builds a
//! small document of its own (`src/printDoc.ts`: the message as shown, light, with a CSP that forbids scripts) and hands it over through the command `print_html`. This module loads it into a
//! WKWebView that is in no window, with JavaScript off and no base URL (no IPC, no app origin, nothing of the app), waits until it has loaded (at most 10 s), and shows the system print
//! sheet on the window that asked (`runOperationModalForWindow:`). One print at a time. The view is kept until the sheet is gone, then released.
//!
//! The rules (when the load is done, when the sheet is over) are plain functions, tested on every system; the AppKit / WebKit calls are in `native` (macOS only). On Windows and Linux the command
//! answers an error and does nothing (the page never calls it there: those systems print the frame).

use std::time::Duration;

/// How long the document may take to load before the print is given up, and how often it is looked at.
pub const LOAD_LIMIT: Duration = Duration::from_secs(10);
pub const POLL: Duration = Duration::from_millis(50);
/// How long the sheet may take to appear (a long message is laid out for the paper first) before the view is let go of anyway.
pub const SHEET_LIMIT: Duration = Duration::from_secs(60);
/// `isLoading` is YES at once after `loadHTMLString:`; a view that says NO before this has not started (or is a test double): it is not trusted earlier than this.
pub const FIRST_LOOK: Duration = Duration::from_millis(300);

/// What the load poll decides.
#[derive(Debug, PartialEq, Eq)]
pub enum Load {
    Wait,
    Done,
    TimedOut,
}

/// One look at the view: `elapsed` since the load was asked for, `loading` = `isLoading`, `seen_loading` = it said YES once already.
pub fn load_step(elapsed: Duration, loading: bool, seen_loading: bool) -> Load {
    if !loading && (seen_loading || elapsed >= FIRST_LOOK) {
        Load::Done
    } else if elapsed >= LOAD_LIMIT {
        Load::TimedOut
    } else {
        Load::Wait
    }
}

/// What the sheet watch decides.
#[derive(Debug, PartialEq, Eq)]
pub enum Sheet {
    Wait,
    /// the sheet is over (or the window it was on is gone, or it never came): the view can go
    Over,
}

/// One look at the window the sheet belongs to: `window_gone`, `has_sheet` = `attachedSheet` is there, `shown` = it was there before, `waited` since the operation was started.
pub fn sheet_step(window_gone: bool, has_sheet: bool, shown: bool, waited: Duration) -> Sheet {
    if window_gone || (shown && !has_sheet) || (!shown && waited >= SHEET_LIMIT) {
        Sheet::Over
    } else {
        Sheet::Wait
    }
}

/// The text of the error when the print cannot be started (the page shows its own, translated toast; this is for the log and for a caller that has nothing better).
pub const FAILED: &str = "the message could not be prepared for printing";

#[cfg(not(target_os = "macos"))]
pub fn print(_app: &tauri::AppHandle, _label: &str, _html: String, _title: String) -> Result<(), String> {
    Err("print_html is for macOS only".to_string())
}

#[cfg(target_os = "macos")]
pub use native::print;

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2::MainThreadOnly;
    use objc2::runtime::NSObjectProtocol;
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSWindow};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::NSString;
    use objc2_web_kit::{WKWebView, WKWebViewConfiguration};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Instant;
    use tauri::{AppHandle, Manager};

    /// One print at a time (REQ-5.3.7).
    static BUSY: AtomicBool = AtomicBool::new(false);

    /// The print view and the operation, kept until the sheet is over. Only touched on the main thread (the value is created, looked at and dropped in main-thread tasks).
    struct Job {
        _view: Retained<WKWebView>,
        _op: Option<Retained<NSPrintOperation>>,
    }
    // SAFETY: see above; the static only moves the box between the tasks, which all run on the main thread.
    unsafe impl Send for Job {}
    static JOB: Mutex<Option<Job>> = Mutex::new(None);

    fn log(what: &str) {
        crate::startup::line("print", what);
    }

    /// Run `f` on the main thread and wait for its result (the print needs AppKit; the poll runs on a thread of its own so that the main thread is never held).
    fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(MainThreadMarker) -> T + Send + 'static) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            // (a task of the event loop is on the main thread)
            let r = MainThreadMarker::new().map(f);
            let _ = tx.send(r);
        })
        .map_err(|e| format!("the main thread did not take the task: {e}"))?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "the main thread did not answer in 10 s".to_string())?
            .ok_or_else(|| "not on the main thread".to_string())
    }

    /// The view that is in no window: JavaScript off, no base URL, the document loading. Main thread.
    fn make_view(mtm: MainThreadMarker, html: &str) -> Result<Retained<WKWebView>, String> {
        // SAFETY: plain WebKit calls on the main thread with objects made here.
        unsafe {
            let config = WKWebViewConfiguration::new(mtm);
            // macOS 11 and later (the print operation of a web view is too): an older system answers an error and the page shows its toast
            if !config.respondsToSelector(objc2::sel!(defaultWebpagePreferences)) {
                return Err("this macOS cannot print a web page (macOS 11 or later is needed)".to_string());
            }
            // no script in the print view, whatever the document says (its CSP says it too)
            config.defaultWebpagePreferences().setAllowsContentJavaScript(false);
            // the size of a Letter page in points: the view is laid out at this width, the print operation paginates for the paper itself
            let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(612.0, 792.0));
            let view = WKWebView::initWithFrame_configuration(mtm.alloc(), frame, &config);
            if !view.respondsToSelector(objc2::sel!(printOperationWithPrintInfo:)) {
                return Err("this macOS cannot print a web page (macOS 11 or later is needed)".to_string());
            }
            let _ = view.loadHTMLString_baseURL(&NSString::from_str(html), None);
            Ok(view)
        }
    }

    /// The sheet on the window `label`. Main thread. The operation is kept in `JOB` with the view.
    fn start_sheet(app: &AppHandle, label: &str, title: &str) -> Result<(), String> {
        let win = app.get_webview_window(label).ok_or_else(|| format!("no window {label}"))?;
        let ptr = win.ns_window().map_err(|e| format!("no native window: {e}"))?;
        if ptr.is_null() {
            return Err("the native window is null".to_string());
        }
        // SAFETY: `ptr` is the live NSWindow of the window that asked (tauri hands it out for the lifetime of the window object we hold); main thread (caller).
        unsafe {
            let window: &NSWindow = &*(ptr as *const NSWindow);
            let view = JOB.lock().unwrap_or_else(|p| p.into_inner()).as_ref().ok_or("the print view is gone")?._view.clone();
            // a copy: the margins set here must not stay in the shared print settings of the app
            let shared = NSPrintInfo::sharedPrintInfo();
            let info: Retained<NSPrintInfo> = objc2::msg_send![&*shared, copy];
            for set in [NSPrintInfo::setTopMargin, NSPrintInfo::setBottomMargin, NSPrintInfo::setLeftMargin, NSPrintInfo::setRightMargin] {
                set(&info, 36.0);
            }
            let op = view.printOperationWithPrintInfo(&info);
            op.setJobTitle(Some(&NSString::from_str(title)));
            op.setShowsPrintPanel(true);
            op.setShowsProgressPanel(true);
            op.setCanSpawnSeparateThread(true);
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(window, None, None, std::ptr::null_mut());
            if let Some(job) = JOB.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
                job._op = Some(op);
            }
            Ok(())
        }
    }

    /// Is the sheet there on window `label`? (`None`: the window is gone.) Main thread.
    fn sheet_state(app: &AppHandle, label: &str) -> Option<bool> {
        let win = app.get_webview_window(label)?;
        let ptr = win.ns_window().ok().filter(|p| !p.is_null())?;
        // SAFETY: as in `start_sheet`.
        Some(unsafe { (*(ptr as *const NSWindow)).attachedSheet().is_some() })
    }

    /// Print `html` on the window `label`: returns when the sheet is up (Ok) or the print could not be started (Err). A second request while one is under way is ignored (Ok).
    pub fn print(app: &AppHandle, label: &str, html: String, title: String) -> Result<(), String> {
        if cfg!(debug_assertions) && std::env::var("HEYLOOK_TEST_PRINT_FAIL").as_deref() == Ok("1") {
            log(&format!("{label}: print failed on purpose (HEYLOOK_TEST_PRINT_FAIL)"));
            return Err(FAILED.to_string());
        }
        if BUSY.swap(true, Ordering::SeqCst) {
            log(&format!("{label}: a print is under way: the request is ignored"));
            return Ok(());
        }
        let started = Instant::now();
        // the view is made and held in the static until the sheet is over (or the print failed)
        let made = on_main(app, move |mtm| {
            let view = make_view(mtm, &html)?;
            *JOB.lock().unwrap_or_else(|p| p.into_inner()) = Some(Job { _view: view, _op: None });
            Ok::<(), String>(())
        })
        .and_then(|r| r);
        let fail = |why: String| -> Result<(), String> {
            release(app);
            log(&format!("{label}: print failed after {} ms: {why}", started.elapsed().as_millis()));
            Err(why)
        };
        if let Err(e) = made {
            return fail(e);
        }
        // the load, looked at every 50 ms; the view is only asked on the main thread
        let mut seen = false;
        loop {
            std::thread::sleep(POLL);
            let loading = match on_main(app, |_| JOB.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|j| unsafe { j._view.isLoading() })) {
                Ok(Some(l)) => l,
                Ok(None) => return fail("the print view is gone".to_string()),
                Err(e) => return fail(e),
            };
            seen |= loading;
            match load_step(started.elapsed(), loading, seen) {
                Load::Wait => {}
                Load::Done => break,
                Load::TimedOut => return fail(format!("the document did not load in {} s", LOAD_LIMIT.as_secs())),
            }
        }
        let (a, l, t) = (app.clone(), label.to_string(), title);
        match on_main(app, move |_| start_sheet(&a, &l, &t)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) | Err(e) => return fail(e),
        }
        log(&format!("{label}: print sheet requested {} ms after the request", started.elapsed().as_millis()));
        // the watch: the view goes when the sheet is over
        let (app, label) = (app.clone(), label.to_string());
        std::thread::spawn(move || {
            let begun = Instant::now();
            let mut shown = false;
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let (a, l) = (app.clone(), label.clone());
                let state = on_main(&app, move |_| sheet_state(&a, &l));
                let (gone, has) = match state {
                    Ok(Some(has)) => (false, has),
                    Ok(None) => (true, false),
                    Err(_) => continue,
                };
                shown |= has;
                if sheet_step(gone, has, shown, begun.elapsed()) == Sheet::Over {
                    break;
                }
            }
            release(&app);
            log(&format!("{label}: print over (sheet was shown {shown}), the print view is released"));
        });
        Ok(())
    }

    /// Let go of the view and the operation (on the main thread) and allow the next print.
    fn release(app: &AppHandle) {
        let job = JOB.lock().unwrap_or_else(|p| p.into_inner()).take();
        // dropped on the main thread (AppKit objects): the task owns the value
        if let Some(job) = job {
            let _ = app.run_on_main_thread(move || drop(job));
        }
        BUSY.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    #[test]
    fn the_load_is_done_when_the_view_stopped_loading_after_it_was_seen_loading() {
        assert_eq!(load_step(MS(50), true, true), Load::Wait);
        assert_eq!(load_step(MS(50), false, true), Load::Done);
        assert_eq!(load_step(MS(50), false, false), Load::Wait, "a view that has not said YES yet is not trusted this early");
        assert_eq!(load_step(MS(300), false, false), Load::Done);
        assert_eq!(load_step(MS(9_999), true, true), Load::Wait);
        assert_eq!(load_step(MS(10_000), true, true), Load::TimedOut);
        assert_eq!(load_step(MS(10_000), false, true), Load::Done, "finished at the last moment is finished");
    }

    #[test]
    fn the_sheet_is_over_when_it_was_shown_and_is_gone_or_the_window_is_gone_or_it_never_came() {
        assert_eq!(sheet_step(false, false, false, MS(1_000)), Sheet::Wait, "not yet shown");
        assert_eq!(sheet_step(false, true, true, MS(1_000)), Sheet::Wait, "shown and still there");
        assert_eq!(sheet_step(false, false, true, MS(5_000)), Sheet::Over);
        assert_eq!(sheet_step(true, false, false, MS(1)), Sheet::Over, "the window ended");
        assert_eq!(sheet_step(false, false, false, SHEET_LIMIT), Sheet::Over, "it never came");
        assert_eq!(sheet_step(false, true, false, SHEET_LIMIT), Sheet::Over);
    }

    /// REQ-5.3.2 / 5.3.6 / 5.3.7: the print view runs no JavaScript, has no base URL and is in no window; the code is macOS only; one print at a time; the debug seam is debug-only; the sheet is on
    /// the calling window; the command exists on every system and is the only caller.
    #[test]
    fn the_print_view_runs_no_javascript_and_is_macos_only() {
        let code = crate::test_guard::non_test_code(include_str!("macprint.rs"));
        let native = &code[code.find("mod native {").unwrap()..];
        assert!(code.contains("#[cfg(target_os = \"macos\")]\nmod native {"), "the AppKit code is macOS only");
        assert!(native.contains("setAllowsContentJavaScript(false)"));
        assert!(native.contains("loadHTMLString_baseURL(&NSString::from_str(html), None)"), "no base URL: the document has no origin");
        assert!(!native.contains("setAllowsContentJavaScript(true)") && !native.contains("evaluateJavaScript") && !native.contains("addScriptMessageHandler") && !native.contains("addUserScript"), "no script, no IPC");
        assert!(!native.contains("addSubview") && !native.contains("setContentView") && !native.contains("makeKeyAndOrderFront"), "the view is in no window");
        assert!(native.contains("BUSY.swap(true") && native.contains("the request is ignored"), "one print at a time");
        assert!(native.contains("cfg!(debug_assertions) && std::env::var(\"HEYLOOK_TEST_PRINT_FAIL\")"), "the seam is debug-only");
        assert!(native.contains("runOperationModalForWindow_delegate_didRunSelector_contextInfo(window") && native.contains("get_webview_window(label)"), "the sheet is on the window that asked");
        assert!(native.contains("setShowsPrintPanel(true)") && native.contains("setShowsProgressPanel(true)") && native.contains("setJobTitle("));
        // the view is let go of when the sheet is over, and the next print is allowed only after that
        let release = &native[native.find("fn release(").unwrap()..];
        assert!(release.contains("take()") && release.find("take()").unwrap() < release.find("BUSY.store(false").unwrap());
        // the command is in lib.rs, async, and calls this module only
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(lib.contains("async fn print_html(") && lib.contains("macprint::print(&app, &label, html, title)"));
        assert_eq!(lib.matches("macprint::print(").count(), 1);
    }
}
