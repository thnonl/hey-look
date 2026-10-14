//! macOS: the quits that never reach `RunEvent::ExitRequested` (QA Mac round 2, Q3 / Q4).
//!
//! The predefined "Quit" menu item (and its Cmd+Q) and the Dock's "Quit" all end in `[NSApp terminate:]`. tao (0.37) has no
//! `applicationShouldTerminate:` in its app delegate: `terminate:` goes straight to `applicationWillTerminate:`, which only sends
//! `LoopDestroyed` (= `RunEvent::Exit`) and the process is gone a moment later. No `ExitRequested` is raised, so the quit sequence of
//! REQ-48 (the page saves its draft and lets the sends in their Undo time go out, the scheduled-messages question) never ran.
//!
//! The menu's own Quit item is replaced in `shell::mac_app_menu`. This module covers the rest (Dock "Quit", a script's
//! `quit` Apple event): it adds `applicationShouldTerminate:` to the app delegate's class at run time. The answer is "cancel" while the
//! quit sequence runs; the sequence ends in `app.exit(0)`, which leaves through the run loop, not through `terminate:` again.
//!
//! **A session end (log out, restart, shut down) is never cancelled** (OWNER DECISION A1, REQ-42 b r3.6): the hook tells it from a
//! quit the person asked for (`sessionend.rs`: the reason attribute of the quit Apple event being handled, and the power-off
//! notice) and answers "terminate now" at once. Telling the two apart is the only thing the platform calls in here do.

use crate::sessionend;
use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};
use std::sync::OnceLock;

/// Called with `true` when the request is a session end. Returns `true` = let the application terminate now, `false` = stop it (the
/// quit sequence has been started instead).
type Decide = Box<dyn Fn(bool) -> bool + Send + Sync>;
static DECIDE: OnceLock<Decide> = OnceLock::new();

/// `NSTerminateCancel` / `NSTerminateNow` (an `NSUInteger` enum).
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

/// The quit-reason attribute of the Apple event that is being handled right now (`kAEQuitReason`), `None` when there is no current
/// Apple event or it has no such attribute (a Dock "Quit" and a script's `quit` carry none).
fn current_quit_reason() -> Option<u32> {
    // SAFETY: plain Objective-C messages to Foundation objects on the main thread; every returned object is checked for null.
    unsafe {
        let manager_class = AnyClass::get(c"NSAppleEventManager")?;
        let manager: *mut AnyObject = msg_send![manager_class, sharedAppleEventManager];
        if manager.is_null() {
            return None;
        }
        let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
        if event.is_null() {
            return None;
        }
        let why: *mut AnyObject = msg_send![event, attributeDescriptorForKeyword: sessionend::QUIT_REASON_KEY];
        if why.is_null() {
            return None;
        }
        // the value is an enumerated code (some systems send it as a type code): read it either way
        let code: u32 = msg_send![why, enumCodeValue];
        if code != 0 {
            return Some(code);
        }
        let code: u32 = msg_send![why, typeCodeValue];
        if code != 0 { Some(code) } else { None }
    }
}

/// Whether this terminate request is a log out, restart or shut down. A failure to find out counts as "not a session end" (the
/// request then runs the quit sequence, as a Dock "Quit" does) unless the power-off notice was seen.
fn is_session_end_now() -> bool {
    let reason = std::panic::catch_unwind(current_quit_reason).unwrap_or(None);
    sessionend::is_session_end(reason, sessionend::power_off_recently_seen())
}

/// `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`
extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
    // the session end is read first and by itself: whatever happens below, a session end must not be answered "cancel"
    let session_end = is_session_end_now();
    // a panic must not unwind into AppKit; a quit that cannot be decided goes ahead (the person must always be able to quit)
    let go = match DECIDE.get() {
        Some(decide) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decide(session_end))).unwrap_or(true),
        None => true,
    };
    if go || session_end { TERMINATE_NOW } else { TERMINATE_CANCEL }
}

/// Add `applicationShouldTerminate:` to the app delegate (tao's, set before the app's setup runs). Call once, on the main thread.
pub fn install_terminate_hook(decide: Decide) -> Result<(), String> {
    if DECIDE.set(decide).is_err() {
        return Err("the terminate hook is already installed".into());
    }
    // SAFETY: plain Objective-C runtime calls on the main thread; `should_terminate` has the signature and the type encoding
    // (`Q@:@`: returns NSUInteger, takes self, _cmd and the sender) of the delegate method it implements.
    unsafe {
        let ns_application = AnyClass::get(c"NSApplication").ok_or("no NSApplication class")?;
        let app: *mut AnyObject = msg_send![ns_application, sharedApplication];
        if app.is_null() {
            return Err("no shared NSApplication".into());
        }
        let delegate: *mut AnyObject = msg_send![app, delegate];
        if delegate.is_null() {
            return Err("the application has no delegate".into());
        }
        let class: &AnyClass = (*delegate).class();
        let imp: Imp = std::mem::transmute(should_terminate as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize);
        let added = class_addMethod(class as *const AnyClass as *mut AnyClass, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
        if !added.as_bool() {
            return Err(format!("{} already answers applicationShouldTerminate:", class.name().to_string_lossy()));
        }
        // AppKit may remember what its delegate answers to: hand the same delegate over again so it asks anew
        let _: () = msg_send![app, setDelegate: delegate];
    }
    Ok(())
}

/// Note `NSWorkspaceWillPowerOffNotification` (posted when the person has asked for a log out, restart or shut down, before the
/// applications are asked to quit): the second sign of a session end besides the reason of the quit Apple event. Call once, on the
/// main thread.
pub fn observe_power_off() -> Result<(), String> {
    // SAFETY: plain Objective-C messages on the main thread; objects are checked for null; the notification center copies the block.
    unsafe {
        let workspace_class = AnyClass::get(c"NSWorkspace").ok_or("no NSWorkspace class")?;
        let workspace: *mut AnyObject = msg_send![workspace_class, sharedWorkspace];
        if workspace.is_null() {
            return Err("no shared NSWorkspace".into());
        }
        let center: *mut AnyObject = msg_send![workspace, notificationCenter];
        if center.is_null() {
            return Err("the workspace has no notification center".into());
        }
        let string_class = AnyClass::get(c"NSString").ok_or("no NSString class")?;
        let name: *mut AnyObject = msg_send![string_class, stringWithUTF8String: c"NSWorkspaceWillPowerOffNotification".as_ptr()];
        if name.is_null() {
            return Err("could not make the notification name".into());
        }
        let block = block2::RcBlock::new(|_notification: *mut AnyObject| sessionend::note_power_off());
        let none: *mut AnyObject = std::ptr::null_mut();
        let observer: *mut AnyObject = msg_send![center, addObserverForName: name, object: none, queue: none, usingBlock: &*block];
        if observer.is_null() {
            return Err("the notification center returned no observer".into());
        }
    }
    Ok(())
}
