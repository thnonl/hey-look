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
//!
//! 1.0.7 (D-093): with the tao fix of W4.1 (the over-retain of the window) a closed window was STILL left behind by every compose and reader window, so the holders that are
//! left are not the one tao fixed. The sweep now takes away what the app side can: the window's delegate and the observers tao registered for it (tao adds the delegate to the
//! distributed notification centre for the appearance change and never removes it), its entry in the Windows menu, and its content view (so the web view's views and their memory go
//! even if something still holds the window shell). Then `check` asks again a second later, with a weak reference, whether the window was freed, and the answers are counted for
//! `GET /native`, so the next Mac log says which of the two it was and how many references were left.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_void};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::leakfix;

struct Held {
    window: Retained<AnyObject>,
    /// the window's delegate (tao's), kept to take the observers it registered away when the window is finished
    delegate: Option<Retained<AnyObject>>,
}

// SAFETY: the window is only messaged on the main thread (`sweep`, `windows_summary` are called from a main-thread task); the other thing done
// to it from another thread is the release when the value is dropped, which Objective-C allows from any thread.
unsafe impl Send for Held {}

/// A weak reference to a window that was swept, and its window number, until `check` says whether it was freed.
struct Watched(objc2::rc::Weak<AnyObject>, isize);

// SAFETY: only ever touched on the main thread (`sweep` stores it, `check` reads it, both main-thread tasks).
unsafe impl Send for Watched {}

fn watched() -> &'static Mutex<HashMap<String, Watched>> {
    static WATCHED: OnceLock<Mutex<HashMap<String, Watched>>> = OnceLock::new();
    WATCHED.get_or_init(Default::default)
}

/// How many windows were finished by hand, and what `check` found a second later: freed, or still alive (a leak).
static SWEPT: AtomicUsize = AtomicUsize::new(0);
static FREED: AtomicUsize = AtomicUsize::new(0);
static ALIVE: AtomicUsize = AtomicUsize::new(0);
/// How many extra references `leak_fix` released in all (D-093, round 12b).
static RELEASED: AtomicUsize = AtomicUsize::new(0);

/// (swept, freed, still alive, references released by the leak fix) since the start, for `GET /native` of the debug bridge.
pub fn sweep_stats() -> (usize, usize, usize, usize) {
    (SWEPT.load(Ordering::Relaxed), FREED.load(Ordering::Relaxed), ALIVE.load(Ordering::Relaxed), RELEASED.load(Ordering::Relaxed))
}

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
    // SAFETY: `w` is a live NSWindow; `delegate` answers null or a live object (kept with its own reference).
    let delegate = unsafe {
        let d: *mut AnyObject = msg_send![Retained::as_ptr(&w) as *mut AnyObject, delegate];
        Retained::retain(d)
    };
    lock().insert(label.to_string(), Held { window: w, delegate });
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

/// What `NSApp` lists, for `GET /native` of the debug test bridge (REQ-4.1.5): how many windows, how many are visible, and how many of them are
/// tao's own (the class name starts with `TaoWindow` or `NSKVONotifying_TaoWindow`: every window of the app, which is what a leak of closed windows
/// adds to). `None` when AppKit cannot be asked. Main thread.
pub fn counts() -> Option<(usize, usize, usize)> {
    // SAFETY: called on the main thread; the windows come from `[NSApp windows]` and `app_window_list` drops null entries.
    unsafe {
        let (total, visible) = app_windows()?;
        let titled = app_window_list()
            .into_iter()
            .filter(|w| {
                let name = text(msg_send![*w, className]);
                name.starts_with("TaoWindow") || name.starts_with("NSKVONotifying_TaoWindow")
            })
            .count();
        Some((total, visible, titled))
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

/// Everything the app side can undo on a window that has ended, as the first part of `sweep` (D-093, round 10b). Main thread, on the window that was held at creation. Nothing here releases a
/// reference that is not ours: it clears what points at the window and what the window points at.
///
/// NOT before the window ends (fix24 did, and no window could be closed any more, round 11a): AppKit delivers `windowWillClose:` to the delegate through an observer that the window registers itself when
/// it gets the delegate, and tao's `Destroyed` event, and with it the end of the label in tauri's manager, comes from that method. Taking that observer (or the delegate) away first stops the event.
///
/// In this order:
/// 1. the first responder (`makeFirstResponder:nil`: the window's strong `_firstResponder` is a web view otherwise, and the focus ring view of AppKit points at it);
/// 2. the drag destinations of the window and of every view below its content view (`unregisterDraggedTypes`: an `NSDragDestination` holds its window strongly), W4.7's and wry's;
/// 3. every notification observer of the window, its delegate and its views, on the default and on the distributed centre (tao registers its delegate for the appearance change);
/// 4. the web view: its navigation and UI delegate cleared, loading stopped, taken out of the window (the web view and the window must not keep each other);
/// 5. the title bar accessories and the toolbar (what hangs on the window's own frame view), and the content view is replaced by an empty one (the views of tao, wry and the web view go).
/// The window is closed already (it is called from `sweep`, a second after `Destroyed`), so nothing the person sees changes.
unsafe fn teardown_views(ptr: *mut AnyObject, delegate: Option<&Retained<AnyObject>>) -> String {
    // SAFETY (caller): `ptr` is a live NSWindow and `delegate` its delegate, both kept alive by the caller for the whole call; the messages are the ones NSWindow / NSView / WKWebView answer (asked with
    // `answers` where a class may not know one); main thread (caller).
    unsafe {
        let nil: *mut AnyObject = std::ptr::null_mut();
        let responder: *mut AnyObject = msg_send![ptr, firstResponder];
        let responder_class = if responder.is_null() { "none".to_string() } else { text(msg_send![responder, className]) };
        let cleared: Bool = msg_send![ptr, makeFirstResponder: nil];
        // all views below the content view (a few dozen at most; capped), and the frame view's own children, for the log
        let content: *mut AnyObject = msg_send![ptr, contentView];
        let frame: *mut AnyObject = if content.is_null() { nil } else { msg_send![content, superview] };
        let mut views: Vec<*mut AnyObject> = Vec::new();
        if !content.is_null() {
            collect_views(content, &mut views, 0);
        }
        let frame_children = if frame.is_null() { "none".to_string() } else { subview_classes(frame) };
        // 2. drag destinations
        let mut unregistered = 0;
        for target in std::iter::once(ptr).chain(views.iter().copied()) {
            if answers(target, c"unregisterDraggedTypes") {
                let _: () = msg_send![target, unregisterDraggedTypes];
                unregistered += 1;
            }
        }
        // 3. observers
        let mut observers = 0;
        let centers: Vec<*mut AnyObject> = [AnyClass::get(c"NSNotificationCenter"), AnyClass::get(c"NSDistributedNotificationCenter")]
            .into_iter()
            .flatten()
            .map(|class| msg_send![class, defaultCenter])
            .filter(|c: &*mut AnyObject| !c.is_null())
            .collect();
        let mut targets: Vec<*mut AnyObject> = vec![ptr];
        if let Some(d) = delegate {
            targets.push(Retained::as_ptr(d) as *mut AnyObject);
        }
        targets.extend(views.iter().copied());
        for center in &centers {
            for t in &targets {
                let _: () = msg_send![*center, removeObserver: *t];
                observers += 1;
            }
        }
        // 4. the web view(s)
        let mut web = 0;
        for v in views.iter().copied() {
            if answers(v, c"setNavigationDelegate:") {
                let _: () = msg_send![v, setNavigationDelegate: nil];
                if answers(v, c"setUIDelegate:") {
                    let _: () = msg_send![v, setUIDelegate: nil];
                }
                if answers(v, c"stopLoading") {
                    let _: () = msg_send![v, stopLoading];
                }
                let _: () = msg_send![v, removeFromSuperview];
                web += 1;
            }
        }
        // 5. the title bar accessories and the toolbar; the content view
        let mut accessories = 0;
        if answers(ptr, c"titlebarAccessoryViewControllers") {
            let list: *mut AnyObject = msg_send![ptr, titlebarAccessoryViewControllers];
            let count: usize = if list.is_null() { 0 } else { msg_send![list, count] };
            for _ in 0..count.min(16) {
                let _: () = msg_send![ptr, removeTitlebarAccessoryViewControllerAtIndex: 0usize];
                accessories += 1;
            }
        }
        let _: () = msg_send![ptr, setToolbar: nil];
        if let Some(view) = AnyClass::get(c"NSView") {
            let empty: Retained<AnyObject> = msg_send![view, new];
            let _: () = msg_send![ptr, setContentView: &*empty];
        }
        format!(
            "teardown: first responder {responder_class} cleared {}; {unregistered} drag destination(s) unregistered; {observers} observer removal(s); {web} web view(s) detached; {accessories} title bar accessory(ies) removed; frame view children before: {frame_children}; {} view(s) below the content view",
            cleared.as_bool(),
            views.len()
        )
    }
}

/// `view` and every view below it (depth first, at most 200, 12 levels): the pointers are valid while the window is held.
///
/// SAFETY (caller): main thread; `view` is a live NSView.
unsafe fn collect_views(view: *mut AnyObject, out: &mut Vec<*mut AnyObject>, depth: usize) {
    if out.len() >= 200 || depth > 12 {
        return;
    }
    out.push(view);
    // SAFETY: `view` is a live NSView (caller); the array and its elements are checked for null.
    unsafe {
        let list: *mut AnyObject = msg_send![view, subviews];
        if list.is_null() {
            return;
        }
        let count: usize = msg_send![list, count];
        for i in 0..count.min(64) {
            let child: *mut AnyObject = msg_send![list, objectAtIndex: i];
            if !child.is_null() {
                collect_views(child, out, depth + 1);
            }
        }
    }
}

/// The class names of the direct subviews of `view`, for the log ("NSTitlebarContainerView, _NSCoreHostingView<ThemeWidgetView>, ...").
///
/// SAFETY (caller): main thread; `view` is a live NSView.
unsafe fn subview_classes(view: *mut AnyObject) -> String {
    // SAFETY: `view` is a live NSView (caller); the array and its elements are checked for null.
    unsafe {
        let list: *mut AnyObject = msg_send![view, subviews];
        if list.is_null() {
            return "none".into();
        }
        let count: usize = msg_send![list, count];
        let names: Vec<String> = (0..count.min(24))
            .filter_map(|i| {
                let child: *mut AnyObject = msg_send![list, objectAtIndex: i];
                (!child.is_null()).then(|| text(msg_send![child, className]))
            })
            .collect();
        names.join(", ")
    }
}

/// Finish the native window of `label` and let go of the references held here. Returns the line for the log, `None` when no window is held.
/// Main thread only. Every step is a message that is harmless on a window that is closed already; none of them releases anything that is not ours.
pub fn sweep(label: &str) -> Option<String> {
    let Held { window: w, delegate } = lock().remove(label)?;
    let ptr = Retained::as_ptr(&w) as *mut AnyObject;
    // SAFETY: `w` keeps the window alive for the whole function (and `delegate` the delegate); the messages are the ones every NSWindow answers; main thread (caller).
    let (text, number) = unsafe {
        let number: isize = msg_send![ptr, windowNumber];
        let before: Bool = msg_send![ptr, isVisible];
        let retains: usize = msg_send![ptr, retainCount];
        let nil: *mut AnyObject = std::ptr::null_mut();
        // everything that points at the window or that it points at, undone (the window has ended: its `Destroyed` came before this runs)
        let torn = teardown_views(ptr, delegate.as_ref());
        // tao's delegate: nothing may call it any more, and the centres that were told to call it are told to stop (tao registers it for the appearance change and never removes it)
        let _: () = msg_send![ptr, setDelegate: nil];
        let delegate_retains = delegate.as_ref().map(|d| {
            let d = Retained::as_ptr(d) as *mut AnyObject;
            for class in [AnyClass::get(c"NSDistributedNotificationCenter"), AnyClass::get(c"NSNotificationCenter")].into_iter().flatten() {
                let c: *mut AnyObject = msg_send![class, defaultCenter];
                if !c.is_null() {
                    let _: () = msg_send![c, removeObserver: d];
                }
            }
            let n: usize = msg_send![d, retainCount];
            n
        });
        if let Some(class) = AnyClass::get(c"NSNotificationCenter") {
            let c: *mut AnyObject = msg_send![class, defaultCenter];
            if !c.is_null() {
                let _: () = msg_send![c, removeObserver: ptr];
            }
        }
        // the Windows menu lists the window (and holds it) until it is told to forget it
        let app = shared_app();
        if !app.is_null() {
            let _: () = msg_send![app, removeWindowsItem: ptr];
        }
        // the views of the window (tao's view, wry's web view and parent view) go with the content view: an empty one takes its place, so that even a window shell that something
        // still holds costs no more than its own few kilobytes
        if let Some(view) = AnyClass::get(c"NSView") {
            let empty: Retained<AnyObject> = msg_send![view, new];
            let _: () = msg_send![ptr, setContentView: &*empty];
        }
        let _: () = msg_send![ptr, orderOut: nil];
        let _: () = msg_send![ptr, close];
        let after: Bool = msg_send![ptr, isVisible];
        let retains_after: usize = msg_send![ptr, retainCount];
        let text = format!(
            "native window {number}: teardown done ({torn}); visible {} then {}, retain count {retains} then {retains_after} (this log's own reference is one of them), delegate retain count {}; {}",
            before.as_bool(),
            after.as_bool(),
            delegate_retains.map_or("none".to_string(), |n| n.to_string()),
            windows_summary()
        );
        (text, number)
    };
    SWEPT.fetch_add(1, Ordering::Relaxed);
    // from here on the app holds nothing of this window: a weak reference tells in a moment whether anything else does
    watched().lock().unwrap_or_else(|p| p.into_inner()).insert(label.to_string(), Watched(objc2::rc::Weak::from(&w), number));
    drop(delegate);
    drop(w);
    Some(text)
}

/// A second after `sweep`: was the window freed? A weak reference answers `None` once nothing holds it. Returns the line for the log, `None` when the window was not swept.
/// Main thread only. In a debug build started with `HEYLOOK_MAC_RELEASE_LEAK=1` (an experiment for the Mac QA, never in a release build): a window that is still alive with exactly one
/// reference besides the one this check takes is a leak, and those references are released (see the experiment below).
/// `destroyed`: the window ended by its `Destroyed` event (false for a window that was given up while tauri still lists it): only then the leak fix may run.
pub fn check(label: &str, destroyed: bool) -> Option<String> {
    let Watched(weak, number) = watched().lock().unwrap_or_else(|p| p.into_inner()).remove(label)?;
    let Some(strong) = weak.load() else {
        FREED.fetch_add(1, Ordering::Relaxed);
        return Some(format!("native window {number}: freed ({})", windows_summary()));
    };
    ALIVE.fetch_add(1, Ordering::Relaxed);
    let ptr = Retained::as_ptr(&strong) as *mut AnyObject;
    // SAFETY: `strong` keeps the window alive; main thread (caller).
    let retains: usize = unsafe { msg_send![ptr, retainCount] };
    let mut text = format!("native window {number}: STILL ALIVE after being finished, retain count {retains} (this check's own reference is one of them); {}", windows_summary());
    if cfg!(debug_assertions) && std::env::var("HEYLOOK_MAC_RELEASE_LEAK").as_deref() == Ok("1") {
        // The experiment: the window is closed and the app side has let go of everything it can (`teardown`, `sweep`); every reference that is still there besides this check's own is one that
        // nothing will ever release. They are released here, one by one, at most 40; `HEYLOOK_MAC_RELEASE_KEEP=<n>` leaves n of them (references of the system itself that the QA found out about).
        let keep: usize = std::env::var("HEYLOOK_MAC_RELEASE_KEEP").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
        let extra = retains.saturating_sub(1 + keep).min(40);
        for _ in 0..extra {
            // SAFETY: see above; this check's own reference keeps the window alive until `drop(strong)`.
            unsafe {
                let _: () = msg_send![ptr, release];
            }
        }
        drop(strong);
        let gone = weak.load().is_none();
        text.push_str(&format!("; released {extra} reference(s) (HEYLOOK_MAC_RELEASE_LEAK, keeping {keep}): the window is {}", if gone { "gone" } else { "STILL ALIVE" }));
        return Some(text);
    }
    text.push_str(&leak_fix(strong, &weak, label, destroyed));
    Some(text)
}

/// The release of the extra references of a finished window (D-093, round 12b; the reasoning and the numbers are in leakfix.rs). Main thread, after `Destroyed` and `sweep` (the caller is the
/// check that runs a second after the sweep). OFF by default since fix29 (round 13: fix28 over-released and crashed); `HEYLOOK_MAC_LEAK_FIX=1` turns it on, `HEYLOOK_MAC_NO_LEAK_FIX=1` forces it off. Takes the strong reference that `check` made (it is dropped here, once, on every path).
///
/// HOW MANY (fix29, after fix28 released 4 where 3 were safe and crashed in `objc_autoreleasePoolPop`): the count is read FIRST, as the very first message to the window after `check` made the
/// strong reference (that count includes the one reference this function owns, `strong`: round 13 saw "retain count 4"); then the state questions are asked inside an autorelease pool of
/// their own, which is emptied before the count is read a second time (a question that returns an autoreleased reference to the window, or a method that retains it for the length of a call, would
/// otherwise show up as an "extra" reference that belongs to a pool and not to a leak: releasing it is the over-release that crashed). The number released is
/// `min(first, second) - OWN_REFS` (leakfix::release_plan: 3 for the observed 4, the number the experiment released for 3 minutes 20 seconds without a crash), is FIXED before the first release
/// (the count is not used to decide again), each release is made only while the count read just before it is above OWN_REFS, and `strong` is dropped exactly once, by this function, after the
/// last release and never by the loop: the window is freed by that drop or by nobody. The count before and after every release is in the line for the log.
fn leak_fix(strong: Retained<AnyObject>, weak: &objc2::rc::Weak<AnyObject>, label: &str, destroyed: bool) -> String {
    const OWN_REFS: usize = 1;
    let ptr = Retained::as_ptr(&strong) as *mut AnyObject;
    // SAFETY: `strong` keeps the window alive; the message answers a plain number; main thread (caller).
    let first: usize = unsafe { msg_send![ptr, retainCount] };
    // SAFETY: `strong` keeps the window alive; the messages are the ones every NSWindow answers; each returned object is checked for null before it is messaged; main thread (caller). The pool
    // is emptied when the closure returns, before the second count.
    let state = objc2::rc::autoreleasepool(|_| unsafe {
        let visible: Bool = msg_send![ptr, isVisible];
        let key: Bool = msg_send![ptr, isKeyWindow];
        let main: Bool = msg_send![ptr, isMainWindow];
        let sheet: *mut AnyObject = msg_send![ptr, attachedSheet];
        let children: *mut AnyObject = msg_send![ptr, childWindows];
        let child_count: usize = if children.is_null() { 0 } else { msg_send![children, count] };
        let parent: *mut AnyObject = msg_send![ptr, parentWindow];
        leakfix::WindowState {
            destroyed,
            is_main_label: label == "main",
            quitting: crate::QUITTING.load(Ordering::SeqCst),
            visible: visible.as_bool(),
            key: key.as_bool(),
            main: main.as_bool(),
            has_sheet: !sheet.is_null(),
            has_children: child_count > 0,
            has_parent: !parent.is_null(),
            switched_off: !leakfix::enabled(std::env::var(leakfix::ENABLE).ok().as_deref(), std::env::var(leakfix::KILL_SWITCH).ok().as_deref()),
        }
    });
    if let Some(why) = leakfix::refusal(&state) {
        drop(strong);
        return format!("; leak fix: not applied ({why})");
    }
    // SAFETY: as for the first count.
    let second: usize = unsafe { msg_send![ptr, retainCount] };
    let planned = leakfix::release_plan(&[first, second], OWN_REFS);
    let mut released = 0;
    let mut trace = String::new();
    for _ in 0..planned {
        // SAFETY: as for the first count.
        let before: usize = unsafe { msg_send![ptr, retainCount] };
        if before <= OWN_REFS {
            break; // nothing but our own reference is left: never release it
        }
        // SAFETY: the count is above our own reference, so this release gives back a reference that is not ours; `strong` is held until after the loop, so the window cannot be freed by it.
        let after: usize = unsafe {
            let _: () = msg_send![ptr, release];
            msg_send![ptr, retainCount]
        };
        trace.push_str(&format!(" {before}>{after}"));
        released += 1;
    }
    drop(strong);
    RELEASED.fetch_add(released, Ordering::Relaxed);
    let freed = weak.load().is_none();
    format!(
        "; leak fix: released {released} extra reference(s) (retain count {first} then {second} before, planned {planned}, one by one:{}), window {}",
        if trace.is_empty() { " none".to_string() } else { trace },
        if freed { "freed" } else { "still alive" }
    )
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

/// `NSWindowStyleMaskFullSizeContentView` (1 << 15): the content view runs under the title bar. No window of this app has it (D-097).
const FULL_SIZE_CONTENT_VIEW: usize = 1 << 15;

/// Set the appearance of one `NSWindow` and redraw its frame (the frame view, the parent of the content view, draws the title bar).
unsafe fn set_one(w: *mut AnyObject, dark: Option<bool>) {
    // SAFETY: `w` is a live NSWindow on the main thread; objects that come back are checked for null before they are messaged.
    unsafe {
        let _: () = msg_send![w, setAppearance: appearance_for(dark)];
        // D-063: the title bar is not drawn by the system: it shows the window's background colour, which bgcolor.rs sets to the app's own ground (--bg)
        // in the same apply, so the strip above the page is not a grey of its own (35,36,39 against 27,28,32 in Dark)
        let _: () = msg_send![w, setTitlebarAppearsTransparent: Bool::YES];
        // D-097: and the page does not run under the title bar: without the full-size content view the three window buttons have their own band above the page
        let mask: usize = msg_send![w, styleMask];
        if mask & FULL_SIZE_CONTENT_VIEW != 0 {
            let _: () = msg_send![w, setStyleMask: mask & !FULL_SIZE_CONTENT_VIEW];
        }
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

/// The background colour of the window (what shows through its transparent title bar): the app's own ground (`--bg`, bgcolor.rs) of the theme the window shows. `dark` None = the
/// window follows the OS: its own colour is left as it is (bgcolor.rs resolves System to the OS theme).
///
/// SAFETY (caller): `w` is a live NSWindow on the main thread.
unsafe fn set_ground(w: *mut AnyObject, dark: Option<bool>) {
    let Some(dark) = dark else { return };
    let (r, g, b) = if dark { crate::bgcolor::DARK } else { crate::bgcolor::LIGHT };
    let Some(class) = AnyClass::get(c"NSColor") else { return };
    // SAFETY: a class message that returns an autoreleased colour; the window retains the colour it is given.
    unsafe {
        let color: *mut AnyObject = msg_send![class, colorWithSRGBRed: f64::from(r) / 255.0, green: f64::from(g) / 255.0, blue: f64::from(b) / 255.0, alpha: 1.0f64];
        if !color.is_null() {
            let _: () = msg_send![w, setBackgroundColor: color];
        }
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

/// The windows to work on: the ones tauri lists (`known`, only the one named by `only` when given) and, without `only`, every other titled
/// window of `[NSApp windows]` (labelled `ns#<window number>`).
///
/// SAFETY (caller): main thread; the pointers of `known` are live windows.
unsafe fn work_list(known: &[(String, *mut c_void)], only: Option<&str>) -> Vec<(String, *mut AnyObject)> {
    let mut work: Vec<(String, *mut AnyObject)> = Vec::new();
    for (label, p) in known {
        if !p.is_null() && only.is_none_or(|o| o == label) {
            work.push((label.clone(), *p as *mut AnyObject));
        }
    }
    if only.is_none() {
        // SAFETY: Objective-C messages to live AppKit windows (main thread, caller).
        unsafe {
            for w in app_window_list() {
                if is_titled(w) && !work.iter().any(|(_, k)| *k == w) {
                    let number: isize = msg_send![w, windowNumber];
                    work.push((format!("ns#{number}"), w));
                }
            }
        }
    }
    work
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
        for (label, w) in work_list(known, only) {
            let number: isize = msg_send![w, windowNumber];
            let visible: Bool = msg_send![w, isVisible];
            let class = text(msg_send![w, className]);
            let (own0, eff0, _) = read_back(w);
            set_one(w, dark);
            // D-092: the colour behind the transparent title bar is the window's own background colour: set natively, for every window of every kind the same way, to the ground of the theme it
            // shows (bgcolor.rs sets the same two values through tauri; a window drawn before that reached it would show the system's grey)
            set_ground(w, expected);
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

// ---- the title bar repaint strategies (titlebar.rs) and the description of a window for the log ----

/// An autoreleased `NSString` from text (a NUL inside is cut off). Null when it cannot be made.
///
/// SAFETY (caller): main thread.
unsafe fn nsstring(s: &str) -> *mut AnyObject {
    let cut = s.split('\0').next().unwrap_or("");
    let (Ok(c), Some(class)) = (std::ffi::CString::new(cut), AnyClass::get(c"NSString")) else { return std::ptr::null_mut() };
    // SAFETY: a class message with a NUL-terminated C string that lives through the call.
    unsafe { msg_send![class, stringWithUTF8String: c.as_ptr()] }
}

/// Does `obj` answer the selector `name`? (A message it does not answer would raise an Objective-C exception, which is not catchable here.)
unsafe fn answers(obj: *mut AnyObject, name: &CStr) -> bool {
    if obj.is_null() {
        return false;
    }
    // SAFETY: `obj` is a live Objective-C object (non-null); `respondsToSelector:` is an NSObject method.
    unsafe {
        let sel = objc2::runtime::Sel::register(name);
        let r: Bool = msg_send![obj, respondsToSelector: sel];
        r.as_bool()
    }
}

/// `[obj valueForKey:key]` described as text (an NSValue of a rect reads "NSRect: {{0, 0}, {980, 580}}"), "-" when `obj` has no such getter.
/// Used instead of calling a getter that returns a struct, so no struct type has to be described to the runtime.
unsafe fn key_text(obj: *mut AnyObject, key: &CStr) -> String {
    // SAFETY: only asked when `obj` answers the getter named like the key; the value and its description are checked for null.
    unsafe {
        if !answers(obj, key) {
            return "-".into();
        }
        let k = nsstring(key.to_str().unwrap_or(""));
        if k.is_null() {
            return "?".into();
        }
        let value: *mut AnyObject = msg_send![obj, valueForKey: k];
        if value.is_null() {
            return "nil".into();
        }
        text(msg_send![value, description]).replace("NSRect: ", "")
    }
}

/// The description of an object (`NSColor` and the like), "nil" for null.
unsafe fn describe_object(o: *mut AnyObject) -> String {
    if o.is_null() {
        return "nil".into();
    }
    // SAFETY: `o` is a live object, non-null.
    unsafe { text(msg_send![o, description]) }
}

/// The class names and frames of the direct subviews of a view, "[A {{x, y}, {w, h}}, B ...]" (at most 8).
unsafe fn subviews_text(view: *mut AnyObject) -> String {
    if view.is_null() {
        return "nil".into();
    }
    // SAFETY: `view` is a live NSView (non-null); the list and its entries are checked for null.
    unsafe {
        let list: *mut AnyObject = msg_send![view, subviews];
        if list.is_null() {
            return "[]".into();
        }
        let n: usize = msg_send![list, count];
        let mut parts = Vec::new();
        for i in 0..n.min(8) {
            let v: *mut AnyObject = msg_send![list, objectAtIndex: i];
            if !v.is_null() {
                parts.push(format!("{} {}", text(msg_send![v, className]), key_text(v, c"frame")));
            }
        }
        if n > 8 {
            parts.push(format!("... {n} in all"));
        }
        format!("[{}]", parts.join(", "))
    }
}

/// What a window is, for the log: everything that could make its title bar be painted differently from the title bar of another window
/// (style mask incl. the full-size content view bit, transparent title bar, title visibility, background colour, key / visible, document-edited
/// flag, sharing type, level, frames and the subviews of the content and of the frame view). Main thread.
pub fn describe(label: &str, w: *mut c_void) -> String {
    let w = w as *mut AnyObject;
    if w.is_null() {
        return format!("{label}: no window");
    }
    // SAFETY: `w` is a live NSWindow (tauri's `ns_window` or a member of `[NSApp windows]`) on the main thread; every returned object is
    // checked before it is messaged, and the getters of other objects are asked only when the object answers them.
    unsafe {
        let number: isize = msg_send![w, windowNumber];
        let mask: usize = msg_send![w, styleMask];
        let transparent: Bool = msg_send![w, titlebarAppearsTransparent];
        let vis: isize = msg_send![w, titleVisibility];
        let background = describe_object(msg_send![w, backgroundColor]);
        let opaque: Bool = msg_send![w, isOpaque];
        let key: Bool = msg_send![w, isKeyWindow];
        let visible: Bool = msg_send![w, isVisible];
        let edited: Bool = msg_send![w, isDocumentEdited];
        let sharing: usize = msg_send![w, sharingType];
        let level: isize = msg_send![w, level];
        let shadow: Bool = msg_send![w, hasShadow];
        let title = text(msg_send![w, title]);
        let content: *mut AnyObject = msg_send![w, contentView];
        let frame_view: *mut AnyObject = if content.is_null() { std::ptr::null_mut() } else { msg_send![content, superview] };
        let class = if content.is_null() { "nil".to_string() } else { text(msg_send![content, className]) };
        let frame_class = if frame_view.is_null() { "nil".to_string() } else { text(msg_send![frame_view, className]) };
        format!(
            "{label} [#{number}] title '{title}': styleMask {mask:#x} (titled {}, fullSizeContentView {}), titlebarAppearsTransparent {}, titleVisibility {vis}, \
             backgroundColor {background} (opaque {}), key {}, visible {}, documentEdited {}, sharingType {sharing}, level {level}, hasShadow {}; \
             window frame {}, contentLayoutRect {}; contentView {class} {} with subviews {}; frame view {frame_class} with subviews {}",
            mask & 1 != 0,
            mask & (1 << 15) != 0,
            transparent.as_bool(),
            opaque.as_bool(),
            key.as_bool(),
            visible.as_bool(),
            edited.as_bool(),
            shadow.as_bool(),
            key_text(w, c"frame"),
            key_text(w, c"contentLayoutRect"),
            if content.is_null() { "-".to_string() } else { key_text(content, c"frame") },
            subviews_text(content),
            subviews_text(frame_view),
        )
    }
}

/// [`describe`] for every window of the work list (`known` / `only` as in [`apply_appearance`]). Main thread.
pub fn describe_all(known: &[(String, *mut c_void)], only: Option<&str>) -> Vec<String> {
    // SAFETY: main thread (caller); the pointers are live windows.
    let list = unsafe { work_list(known, only) };
    list.into_iter().map(|(label, w)| describe(&label, w as *mut c_void)).collect()
}

/// `setNeedsDisplay:YES` on a view and, recursively, on all its subviews; counts the views, and the title bar views (class name has "Titlebar").
unsafe fn invalidate_tree(v: *mut AnyObject, depth: usize, views: &mut usize, titlebar_views: &mut usize) {
    if v.is_null() || depth > 24 {
        return;
    }
    // SAFETY: `v` is a live NSView (non-null, from `subviews` of a live view); main thread.
    unsafe {
        let _: () = msg_send![v, setNeedsDisplay: Bool::YES];
        *views += 1;
        if text(msg_send![v, className]).contains("Titlebar") {
            *titlebar_views += 1;
        }
        let list: *mut AnyObject = msg_send![v, subviews];
        if list.is_null() {
            return;
        }
        let n: usize = msg_send![list, count];
        for i in 0..n {
            let child: *mut AnyObject = msg_send![list, objectAtIndex: i];
            invalidate_tree(child, depth + 1, views, titlebar_views);
        }
    }
}

/// Windows put out of sight by `OrderOut` and not yet brought back by `OrderFront`: the window pointer and whether it was the key window.
fn hidden() -> &'static Mutex<Vec<(usize, bool)>> {
    static HIDDEN: OnceLock<Mutex<Vec<(usize, bool)>>> = OnceLock::new();
    HIDDEN.get_or_init(Default::default)
}

/// The label of a window pointer among tauri's windows, or `ns#<number>`.
unsafe fn window_label(known: &[(String, *mut c_void)], w: *mut AnyObject) -> String {
    match known.iter().find(|(_, p)| *p as *mut AnyObject == w) {
        Some((l, _)) => l.clone(),
        None => {
            // SAFETY: `w` is a live NSWindow (caller).
            let number: isize = unsafe { msg_send![w, windowNumber] };
            format!("ns#{number}")
        }
    }
}

/// One step of a repaint strategy on the windows (`known` / `only` as in [`apply_appearance`]), with the appearance `dark` the windows have
/// to end up with (the target of the setting at the time of the call: `None` = System). One line of the log per window. Main thread.
pub fn run_act(act: crate::titlebar::Act, dark: Option<bool>, known: &[(String, *mut c_void)], only: Option<&str>) -> Vec<String> {
    use crate::titlebar::Act;
    let mut out = Vec::new();
    // SAFETY: main thread (caller); every pointer comes from AppKit or from tauri's live windows and is checked for null before use.
    unsafe {
        // what the windows have to show, for the flip: the target, or (System) what the application shows
        let app = shared_app();
        let expected = dark.or_else(|| if app.is_null() { None } else { effective(app).1 });
        if act == Act::OrderFront {
            // every window put out of sight comes back, whichever run took it (and only if it still exists)
            let list: Vec<(usize, bool)> = std::mem::take(&mut *hidden().lock().unwrap_or_else(|p| p.into_inner()));
            let alive = app_window_list();
            let none: *mut AnyObject = std::ptr::null_mut();
            for (ptr, was_key) in list {
                let w = ptr as *mut AnyObject;
                if !alive.contains(&w) {
                    out.push(format!("window {ptr:#x} is gone: not brought back"));
                    continue;
                }
                if was_key {
                    let _: () = msg_send![w, makeKeyAndOrderFront: none];
                } else {
                    let _: () = msg_send![w, orderFront: none];
                }
                let visible: Bool = msg_send![w, isVisible];
                out.push(format!("{}: brought back (was key {was_key}), visible {}", window_label(known, w), visible.as_bool()));
            }
            return out;
        }
        for (label, w) in work_list(known, only) {
            match act {
                Act::Invalidate => {
                    let content: *mut AnyObject = msg_send![w, contentView];
                    let frame: *mut AnyObject = if content.is_null() { content } else { msg_send![content, superview] };
                    let (mut views, mut bars) = (0, 0);
                    invalidate_tree(frame, 0, &mut views, &mut bars);
                    let _: () = msg_send![w, invalidateShadow];
                    let _: () = msg_send![w, displayIfNeeded];
                    out.push(format!("{label}: {views} view(s) marked for redraw ({bars} title bar view(s)), displayIfNeeded"));
                }
                Act::FlipOpposite => {
                    let Some(e) = expected else {
                        out.push(format!("{label}: not flipped (the application shows no known appearance to be the opposite of)"));
                        continue;
                    };
                    let _: () = msg_send![w, setAppearance: appearance_for(Some(!e))];
                    let (own, eff, _) = read_back(w);
                    out.push(format!("{label}: flipped to {} ({own} / {eff})", crate::wintheme::dark_text(Some(!e))));
                }
                Act::FlipRestore => {
                    let _: () = msg_send![w, setAppearance: appearance_for(dark)];
                    let content: *mut AnyObject = msg_send![w, contentView];
                    let frame: *mut AnyObject = if content.is_null() { content } else { msg_send![content, superview] };
                    if !frame.is_null() {
                        let _: () = msg_send![frame, setNeedsDisplay: Bool::YES];
                    }
                    let _: () = msg_send![w, invalidateShadow];
                    let _: () = msg_send![w, displayIfNeeded];
                    let (own, eff, eff_dark) = read_back(w);
                    let bad = crate::wintheme::judge(dark, &own, eff_dark, expected).map(|b| format!(" MISMATCH ({b})")).unwrap_or_default();
                    out.push(format!("{label}: set to {} again ({own} / {eff}){bad}", if dark.is_some() { "the pinned appearance" } else { "none of its own (System)" }));
                }
                Act::TitleCycle => {
                    let old = text(msg_send![w, title]);
                    let vis: isize = msg_send![w, titleVisibility];
                    let other: isize = if vis == 0 { 1 } else { 0 };
                    // a different string that looks the same (a zero-width space on the end), the title hidden, the window told to update
                    let _: () = msg_send![w, setTitle: nsstring(&format!("{old}\u{200B}"))];
                    let _: () = msg_send![w, setTitleVisibility: other];
                    let _: () = msg_send![w, update];
                    let _: () = msg_send![w, displayIfNeeded];
                    let _: () = msg_send![w, setTitle: nsstring(&old)];
                    let _: () = msg_send![w, setTitleVisibility: vis];
                    let _: () = msg_send![w, update];
                    let _: () = msg_send![w, displayIfNeeded];
                    out.push(format!("{label}: title '{old}' set to another string and back, titleVisibility {vis} -> {other} -> {vis}, update"));
                }
                Act::OrderOut => {
                    let visible: Bool = msg_send![w, isVisible];
                    if !visible.as_bool() {
                        out.push(format!("{label}: not visible, left alone"));
                        continue;
                    }
                    let key: Bool = msg_send![w, isKeyWindow];
                    let none: *mut AnyObject = std::ptr::null_mut();
                    hidden().lock().unwrap_or_else(|p| p.into_inner()).push((w as usize, key.as_bool()));
                    let _: () = msg_send![w, orderOut: none];
                    out.push(format!("{label}: put out of sight (was key {})", key.as_bool()));
                }
                Act::TransparentToggle => {
                    let before: Bool = msg_send![w, titlebarAppearsTransparent];
                    let _: () = msg_send![w, setTitlebarAppearsTransparent: Bool::new(!before.as_bool())];
                    let _: () = msg_send![w, displayIfNeeded];
                    let _: () = msg_send![w, setTitlebarAppearsTransparent: before];
                    let _: () = msg_send![w, displayIfNeeded];
                    out.push(format!("{label}: titlebarAppearsTransparent {} -> {} -> {}", before.as_bool(), !before.as_bool(), before.as_bool()));
                }
                Act::OrderFront | Act::PageNudge => {} // OrderFront is handled above; the page nudge is not native
            }
        }
    }
    out
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
