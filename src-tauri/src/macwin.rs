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

/// What [`apply_appearance`] found and did, for the log (one line per window).
pub struct Report {
    pub lines: Vec<String>,
    pub mismatches: usize,
}

const AQUA: &CStr = c"NSAppearanceNameAqua";
const DARK_AQUA: &CStr = c"NSAppearanceNameDarkAqua";

/// The `NSAppearance` for a choice: `Some(true)` dark, `Some(false)` light, `None` = nil (follow the application, which follows the OS).
///
/// SAFETY (caller): main thread.
unsafe fn appearance_for(dark: Option<bool>) -> *mut AnyObject {
    let Some(dark) = dark else { return std::ptr::null_mut() };
    let (Some(string), Some(appearance)) = (AnyClass::get(c"NSString"), AnyClass::get(c"NSAppearance")) else { return std::ptr::null_mut() };
    let name = if dark { DARK_AQUA } else { AQUA };
    // SAFETY: Objective-C class messages with a constant C string; the result is checked for null before it is messaged.
    unsafe {
        let name: *mut AnyObject = msg_send![string, stringWithUTF8String: name.as_ptr()];
        if name.is_null() {
            return std::ptr::null_mut();
        }
        msg_send![appearance, appearanceNamed: name]
    }
}

/// The text of an `NSString`, "nil" for null.
///
/// SAFETY (caller): `s` is null or an NSString.
unsafe fn text(s: *mut AnyObject) -> String {
    if s.is_null() {
        return "nil".into();
    }
    // SAFETY: `s` is a live NSString (caller); the UTF-8 buffer is read before anything is released.
    unsafe {
        let utf8: *const c_char = msg_send![s, UTF8String];
        if utf8.is_null() { "?".into() } else { CStr::from_ptr(utf8).to_string_lossy().into_owned() }
    }
}

/// The name of an `NSAppearance` ("NSAppearanceNameDarkAqua", ...), "nil" for null.
unsafe fn appearance_name(appearance: *mut AnyObject) -> String {
    if appearance.is_null() {
        return "nil".into();
    }
    // SAFETY: `appearance` is a live NSAppearance (checked for null above).
    unsafe {
        let name: *mut AnyObject = msg_send![appearance, name];
        text(name)
    }
}

/// `NSApp`, null when AppKit cannot be asked.
unsafe fn shared_app() -> *mut AnyObject {
    match AnyClass::get(c"NSApplication") {
        // SAFETY: a class message that returns the singleton.
        Some(class) => unsafe { msg_send![class, sharedApplication] },
        None => std::ptr::null_mut(),
    }
}

/// The appearance a window (or the application) shows now: its name, and whether that is a dark one.
unsafe fn effective(w: *mut AnyObject) -> (String, Option<bool>) {
    // SAFETY: `w` is a live NSWindow or NSApplication (both answer `effectiveAppearance`), checked by the callers.
    let name = unsafe {
        let a: *mut AnyObject = msg_send![w, effectiveAppearance];
        appearance_name(a)
    };
    let dark = crate::wintheme::dark_from_name(&name);
    (name, dark)
}

/// Does the window have a title bar (a document window, not a menu, tooltip or status item window)?
unsafe fn is_titled(w: *mut AnyObject) -> bool {
    // SAFETY: `w` is a live NSWindow; `styleMask` is an NSUInteger, bit 0 = NSWindowStyleMaskTitled.
    unsafe {
        let mask: usize = msg_send![w, styleMask];
        mask & 1 != 0
    }
}

/// The windows `NSApp` lists, as raw pointers (valid for this main-thread task).
unsafe fn app_window_list() -> Vec<*mut AnyObject> {
    let mut out = Vec::new();
    // SAFETY: Objective-C messages to AppKit objects; every returned object is checked for null before it is messaged.
    unsafe {
        let app = shared_app();
        if app.is_null() {
            return out;
        }
        let list: *mut AnyObject = msg_send![app, windows];
        if list.is_null() {
            return out;
        }
        let total: usize = msg_send![list, count];
        for i in 0..total {
            let w: *mut AnyObject = msg_send![list, objectAtIndex: i];
            if !w.is_null() {
                out.push(w);
            }
        }
    }
    out
}

/// Set the appearance of one `NSWindow` and redraw its frame (the frame view, the parent of the content view, draws the title bar).
unsafe fn set_one(w: *mut AnyObject, dark: Option<bool>) {
    // SAFETY: `w` is a live NSWindow on the main thread; objects that come back are checked for null before they are messaged.
    unsafe {
        let _: () = msg_send![w, setAppearance: appearance_for(dark)];
        let content: *mut AnyObject = msg_send![w, contentView];
        if !content.is_null() {
            let frame: *mut AnyObject = msg_send![content, superview];
            if !frame.is_null() {
                let _: () = msg_send![frame, setNeedsDisplay: Bool::YES];
            }
        }
        let _: () = msg_send![w, invalidateShadow];
        let _: () = msg_send![w, displayIfNeeded];
    }
}

/// The window's own appearance name ("nil" = none of its own), the one it shows, and whether that is a dark one.
unsafe fn read_back(w: *mut AnyObject) -> (String, String, Option<bool>) {
    // SAFETY: `w` is a live NSWindow on the main thread.
    unsafe {
        let own = appearance_name(msg_send![w, appearance]);
        let (eff_name, eff_dark) = effective(w);
        (own, eff_name, eff_dark)
    }
}

/// Give windows the appearance `dark` asks for (`Some(true)` dark, `Some(false)` light, `None` = no appearance of their own: follow the OS),
/// and read back what each one has. Main thread (wintheme.rs calls it from `run_on_main_thread`).
///
/// - `known`: the label and `NSWindow` of every window tauri lists (`WebviewWindow::ns_window`).
/// - `only`: just the window with this label (the page of a pop-out asked for it); the application itself is then left alone.
///
/// Without `only` this also walks `[NSApp windows]`, so a titled window that tauri's own list did not give (or gave under another pointer) gets
/// the appearance too; those are reported as `ns#<window number>`. A window that does not show what was asked is a MISMATCH in the report
/// and is repaired: first by giving it the explicit appearance it should show (and, for System, taking it away again), and if it still
/// differs it stays explicitly set (the OS-change events and the watchdog in wintheme.rs set it right again at the next change).
pub fn apply_appearance(dark: Option<bool>, known: &[(String, *mut c_void)], only: Option<&str>) -> Report {
    let mut report = Report { lines: Vec::new(), mismatches: 0 };
    // SAFETY: main thread (caller); every pointer comes from AppKit or from tauri's live windows, and is checked for null before use.
    unsafe {
        let app = shared_app();
        if only.is_none() && !app.is_null() {
            // the application itself: what tao's `set_theme` does too, done here as well so that this function alone gives the final state
            let _: () = msg_send![app, setAppearance: appearance_for(dark)];
        }
        // what a window has to show: the pinned theme, or (nil) what the application shows, which is the OS
        let (app_own, app_eff, app_dark) = if app.is_null() {
            ("?".to_string(), "?".to_string(), None)
        } else {
            let own = appearance_name(msg_send![app, appearance]);
            let (name, dark) = effective(app);
            (own, name, dark)
        };
        let expected = dark.or(app_dark);
        report.lines.push(format!(
            "application: appearance {app_own} / effective {app_eff}; windows have to show {}",
            crate::wintheme::dark_text(expected)
        ));
        let mut work: Vec<(String, *mut AnyObject)> = Vec::new();
        for (label, p) in known {
            if !p.is_null() && only.is_none_or(|o| o == label) {
                work.push((label.clone(), *p as *mut AnyObject));
            }
        }
        if only.is_none() {
            for w in app_window_list() {
                if is_titled(w) && !work.iter().any(|(_, k)| *k == w) {
                    let number: isize = msg_send![w, windowNumber];
                    work.push((format!("ns#{number}"), w));
                }
            }
        }
        for (label, w) in work {
            let number: isize = msg_send![w, windowNumber];
            let visible: Bool = msg_send![w, isVisible];
            let class = text(msg_send![w, className]);
            let (own0, eff0, _) = read_back(w);
            set_one(w, dark);
            let (mut own, mut eff, mut eff_dark) = read_back(w);
            let mut note = String::new();
            if let Some(why) = crate::wintheme::judge(dark, &own, eff_dark, expected) {
                report.mismatches += 1;
                note = format!("MISMATCH ({why})");
                // repair: the explicit appearance it should show, then (System) none again; one that still differs stays explicit
                if let Some(e) = expected {
                    set_one(w, Some(e));
                    if dark.is_none() {
                        set_one(w, None);
                    }
                    (own, eff, eff_dark) = read_back(w);
                    if crate::wintheme::judge(dark, &own, eff_dark, expected).is_some() {
                        if dark.is_none() {
                            set_one(w, Some(e));
                            (own, eff, eff_dark) = read_back(w);
                            note.push_str(", repair: pinned to the OS appearance");
                        }
                        if let Some(v) = crate::wintheme::judge(dark, &own, eff_dark, expected).filter(|_| dark.is_some()) {
                            note.push_str(&format!(", repair failed: {v}"));
                        }
                    } else {
                        note.push_str(", repaired");
                    }
                }
            }
            report.lines.push(format!(
                "{label} [{class} #{number}, visible {}]: was {own0} / {eff0}, now {own} / {eff} {}",
                visible.as_bool(),
                if note.is_empty() { "ok" } else { &note },
            ));
        }
    }
    report
}

/// The titled windows whose shown appearance differs from what `dark` asks for (see [`apply_appearance`] for the meaning), by label or
/// `ns#<number>`. Reads only; the watchdog in wintheme.rs asks for this every few seconds. Main thread.
pub fn mismatched(dark: Option<bool>, known: &[(String, *mut c_void)]) -> Vec<String> {
    let mut out = Vec::new();
    // SAFETY: main thread (caller); pointers from AppKit or tauri's live windows, checked for null.
    unsafe {
        let app = shared_app();
        let expected = dark.or_else(|| if app.is_null() { None } else { effective(app).1 });
        let Some(expected) = expected else { return out };
        for w in app_window_list() {
            if !is_titled(w) {
                continue;
            }
            let (_, shown) = effective(w);
            if shown.is_some_and(|s| s != expected) {
                let label = known.iter().find(|(_, p)| *p as *mut AnyObject == w).map(|(l, _)| l.clone());
                out.push(label.unwrap_or_else(|| {
                    let number: isize = msg_send![w, windowNumber];
                    format!("ns#{number}")
                }));
            }
        }
    }
    out
}

/// Call `on_change` when the system says its colour mode changed (`AppleInterfaceThemeChangedNotification`, the notification tao listens to for
/// `ThemeChanged` too, but here on its own, so it also reaches us when tao's per-window bookkeeping decides that nothing changed). The callback
/// runs on the main thread and must be quick. Call once.
pub fn observe_theme_change(on_change: fn()) -> Result<(), String> {
    // SAFETY: plain Objective-C messages; objects are checked for null; the notification center copies the block.
    unsafe {
        let center_class = AnyClass::get(c"NSDistributedNotificationCenter").ok_or("no NSDistributedNotificationCenter class")?;
        let center: *mut AnyObject = msg_send![center_class, defaultCenter];
        if center.is_null() {
            return Err("no distributed notification center".into());
        }
        let string_class = AnyClass::get(c"NSString").ok_or("no NSString class")?;
        let name: *mut AnyObject = msg_send![string_class, stringWithUTF8String: c"AppleInterfaceThemeChangedNotification".as_ptr()];
        if name.is_null() {
            return Err("could not make the notification name".into());
        }
        let block = block2::RcBlock::new(move |_notification: *mut AnyObject| on_change());
        let none: *mut AnyObject = std::ptr::null_mut();
        let observer: *mut AnyObject = msg_send![center, addObserverForName: name, object: none, queue: none, usingBlock: &*block];
        if observer.is_null() {
            return Err("the notification center returned no observer".into());
        }
    }
    Ok(())
}

/// What the global default `AppleInterfaceStyle` says ("Dark" while dark mode is on, no value in Light), for the log: a second reading of the
/// OS colour mode that does not go through `NSApp`.
pub fn system_style() -> String {
    // SAFETY: Foundation messages; null is checked.
    unsafe {
        let (Some(defaults), Some(string)) = (AnyClass::get(c"NSUserDefaults"), AnyClass::get(c"NSString")) else { return "?".into() };
        let standard: *mut AnyObject = msg_send![defaults, standardUserDefaults];
        let key: *mut AnyObject = msg_send![string, stringWithUTF8String: c"AppleInterfaceStyle".as_ptr()];
        if standard.is_null() || key.is_null() {
            return "?".into();
        }
        let value: *mut AnyObject = msg_send![standard, stringForKey: key];
        format!("AppleInterfaceStyle={}", if value.is_null() { "(none = light)".to_string() } else { text(value) })
    }
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
