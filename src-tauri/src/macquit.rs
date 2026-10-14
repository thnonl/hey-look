//! macOS: the quits that never reach `RunEvent::ExitRequested` (QA Mac round 2, Q3 / Q4).
//!
//! The predefined "Quit" menu item (and its Cmd+Q) and the Dock's "Quit" all end in `[NSApp terminate:]`. tao (0.37) has no
//! `applicationShouldTerminate:` in its app delegate: `terminate:` goes straight to `applicationWillTerminate:`, which only sends
//! `LoopDestroyed` (= `RunEvent::Exit`) and the process is gone a moment later. No `ExitRequested` is raised, so the quit sequence of
//! REQ-48 (the page saves its draft and lets the sends in their Undo time go out, the scheduled-messages question) never ran.
//!
//! The menu's own Quit item is replaced in `shell::mac_app_menu`. This module covers the rest (Dock "Quit", log out, a script's
//! `quit` Apple event): it adds `applicationShouldTerminate:` to the app delegate's class at run time. The answer is "cancel" while the
//! quit sequence runs; the sequence ends in `app.exit(0)`, which leaves through the run loop, not through `terminate:` again.

use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};
use std::sync::OnceLock;

/// `true` = let the application terminate now, `false` = stop it (the quit sequence has been started instead).
type Decide = Box<dyn Fn() -> bool + Send + Sync>;
static DECIDE: OnceLock<Decide> = OnceLock::new();

/// `NSTerminateCancel` / `NSTerminateNow` (an `NSUInteger` enum).
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

/// `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`
extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
    // a panic must not unwind into AppKit; a quit that cannot be decided goes ahead (the person must always be able to quit)
    let go = match DECIDE.get() {
        Some(decide) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decide())).unwrap_or(true),
        None => true,
    };
    if go { TERMINATE_NOW } else { TERMINATE_CANCEL }
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
