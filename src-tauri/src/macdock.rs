//! macOS: the badge label the Dock tile really shows, read back (`NSApp.dockTile.badgeLabel`), so the log and the QA bridge (`GET /badge`) can tell
//! "the call was made" from "AppKit holds the label". Main thread only (`NSDockTile` is an AppKit object). Read-only: nothing is changed here.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use std::ffi::{CStr, c_char};

/// `[[NSApp dockTile] badgeLabel]`: `Ok(None)` when the tile has no label, `Err` when AppKit gives no application or tile.
pub fn tile_label() -> Result<Option<String>, String> {
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: plain Objective-C messages to AppKit/Foundation objects, on the main thread (the caller's duty); every object that comes back is
        // checked for null before it is used.
        unsafe {
            let class = AnyClass::get(c"NSApplication").ok_or("no NSApplication class")?;
            let app: *mut AnyObject = msg_send![class, sharedApplication];
            if app.is_null() {
                return Err("no shared NSApplication".to_string());
            }
            let tile: *mut AnyObject = msg_send![app, dockTile];
            if tile.is_null() {
                return Err("no Dock tile".to_string());
            }
            let label: *mut AnyObject = msg_send![tile, badgeLabel];
            if label.is_null() {
                return Ok(None);
            }
            let utf8: *const c_char = msg_send![label, UTF8String];
            if utf8.is_null() {
                return Ok(None);
            }
            Ok(Some(CStr::from_ptr(utf8).to_string_lossy().into_owned()))
        }
    })
}
