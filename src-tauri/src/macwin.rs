//! macOS: the native window (`NSWindow`) of a secondary window, held on to so that its end can be checked and finished by hand.
//!
//! Why (Mac QA 1.0.6, macfix2): after a pop-out was closed, the window system kept listing a window of the app (820 x 720, not on screen) for as
//! long as the app ran, and the process grew by about 5 MB per window. Nothing in the app keeps a reference to a window; the reference that
//! keeps the `NSWindow` alive is inside tao / wry / WebKit, and a Mac is needed to find it. Until then this module does two things:
//! - it tells the log what the window system thinks after a window is gone (window number, whether it is visible, its retain count, how many
//!   windows `NSApp` lists), so the next Mac log shows whether windows are released;
//! - it finishes the job from the outside: `orderOut:` and `close` on the window once more (both are harmless on a closed window) and then
//!   lets go of its own reference, so the app is never the one that keeps a window alive.
//! Only plain Objective-C messages; the window is retained here (`Retained`) so a message never reaches a freed object.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_void};
use std::sync::{Mutex, OnceLock};

struct Held(Retained<AnyObject>);

// SAFETY: the window is only messaged on the main thread (`sweep`, `windows_summary` are called from a main-thread task); the other thing done
// to it from another thread is the release when the value is dropped, which Objective-C allows from any thread.
unsafe impl Send for Held {}

fn held() -> &'static Mutex<HashMap<String, Held>> {
    static HELD: OnceLock<Mutex<HashMap<String, Held>>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Held>> {
    held().lock().unwrap_or_else(|p| p.into_inner())
}

/// Keep a reference to the `NSWindow` of window `label` (`WebviewWindow::ns_window`). False when the pointer is null.
pub fn hold(label: &str, ns_window: *mut c_void) -> bool {
    // SAFETY: `ns_window` is the live NSWindow that tauri just built; `Retained::retain` adds our own reference (null is refused by the Option).
    let Some(w) = (unsafe { Retained::retain(ns_window as *mut AnyObject) }) else { return false };
    lock().insert(label.to_string(), Held(w));
    true
}

/// `NSApp windows`: how many, and how many of them are visible. `None` when AppKit cannot be asked.
///
/// SAFETY (caller): main thread.
unsafe fn app_windows() -> Option<(usize, usize)> {
    // SAFETY: Objective-C messages to AppKit objects; every returned object is checked for null before it is messaged.
    unsafe {
        let app: *mut AnyObject = msg_send![AnyClass::get(c"NSApplication")?, sharedApplication];
        if app.is_null() {
            return None;
        }
        let list: *mut AnyObject = msg_send![app, windows];
        if list.is_null() {
            return None;
        }
        let total: usize = msg_send![list, count];
        let mut visible = 0;
        for i in 0..total {
            let w: *mut AnyObject = msg_send![list, objectAtIndex: i];
            if !w.is_null() {
                let v: Bool = msg_send![w, isVisible];
                if v.as_bool() {
                    visible += 1;
                }
            }
        }
        Some((total, visible))
    }
}

/// What the window system lists now, for the log. Main thread.
pub fn windows_summary() -> String {
    // SAFETY: called on the main thread (see the callers in popout.rs).
    match unsafe { app_windows() } {
        Some((total, visible)) => format!("NSApp lists {total} window(s), {visible} visible"),
        None => "NSApp could not be asked".to_string(),
    }
}

/// Finish the native window of `label` and let go of the reference held here. Returns the line for the log, `None` when no window is held.
/// Main thread only.
pub fn sweep(label: &str) -> Option<String> {
    let Held(w) = lock().remove(label)?;
    let ptr = Retained::as_ptr(&w) as *mut AnyObject;
    // SAFETY: `w` keeps the window alive for the whole function; the messages are the ones every NSWindow answers; main thread (caller).
    let text = unsafe {
        let number: isize = msg_send![ptr, windowNumber];
        let before: Bool = msg_send![ptr, isVisible];
        let retains: usize = msg_send![ptr, retainCount];
        let nil: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![ptr, orderOut: nil];
        let _: () = msg_send![ptr, close];
        let after: Bool = msg_send![ptr, isVisible];
        format!(
            "native window {number}: visible {} then {}, retain count {retains} (this log's own reference is one of them); {}",
            before.as_bool(),
            after.as_bool(),
            windows_summary()
        )
    };
    drop(w); // our reference goes: from here on the app holds nothing of this window
    Some(text)
}

/// The system version, for the log ("Version 15.1 (Build 24B83)").
pub fn os_version() -> String {
    // SAFETY: Foundation messages; null is checked.
    unsafe {
        let Some(class) = AnyClass::get(c"NSProcessInfo") else { return "?".into() };
        let info: *mut AnyObject = msg_send![class, processInfo];
        if info.is_null() {
            return "?".into();
        }
        let s: *mut AnyObject = msg_send![info, operatingSystemVersionString];
        if s.is_null() {
            return "?".into();
        }
        let utf8: *const c_char = msg_send![s, UTF8String];
        if utf8.is_null() { "?".into() } else { CStr::from_ptr(utf8).to_string_lossy().into_owned() }
    }
}
