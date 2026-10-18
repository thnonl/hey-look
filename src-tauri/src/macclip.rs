//! macOS: the text on the system clipboard, read and written by the backend (the `read_clipboard_text` and `copy_text` commands).
//!
//! The editors paste "as plain text" on Ctrl+Shift+V; on a Mac the same keys are Cmd+Shift+V, and WKWebView gives the page no `paste` event for
//! them (the Edit menu has Paste = Cmd+V only; Cmd+Shift+V is not an accelerator of any menu item, so the key goes to the page as a plain key
//! press and nothing pastes). The page catches the key and asks for the clipboard here. The web view's own clipboard calls are not an option:
//! `navigator.clipboard.readText()` shows a "Paste" button the person has to click first.
//!
//! Reads only the two text kinds (`public.utf8-plain-text`, `public.html`), only what the person has just copied. Writes one thing: the plain text of a
//! Copy button (`write`), because WKWebView refuses `navigator.clipboard.writeText` once the click's user gesture is gone (a copy that follows a backend call).

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::runtime::Bool;
use std::ffi::{CStr, CString, c_char};

/// What `NSPasteboard` has for the general pasteboard: the plain text and the HTML (either may be empty).
pub struct ClipboardText {
    pub text: String,
    pub html: String,
}

/// `[pasteboard stringForType:[NSString stringWithUTF8String:uti]]` as a Rust string; `None` when the pasteboard has no such type.
///
/// SAFETY (caller): `pasteboard` is a live `NSPasteboard`, inside an autorelease pool.
unsafe fn string_for(pasteboard: *mut AnyObject, uti: &CStr) -> Option<String> {
    // SAFETY: plain Objective-C messages to Foundation objects; every object that comes back is checked for null before it is used.
    unsafe {
        let string_class = AnyClass::get(c"NSString")?;
        let kind: *mut AnyObject = msg_send![string_class, stringWithUTF8String: uti.as_ptr()];
        if kind.is_null() {
            return None;
        }
        let value: *mut AnyObject = msg_send![pasteboard, stringForType: kind];
        if value.is_null() {
            return None;
        }
        let utf8: *const c_char = msg_send![value, UTF8String];
        if utf8.is_null() {
            return None;
        }
        Some(CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }
}

/// Reads the general pasteboard. An empty pasteboard (or one with a picture only) is not an error: both strings are empty.
pub fn read() -> Result<ClipboardText, String> {
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: see `string_for`; the pasteboard is checked for null.
        unsafe {
            let class = AnyClass::get(c"NSPasteboard").ok_or("no NSPasteboard class")?;
            let pasteboard: *mut AnyObject = msg_send![class, generalPasteboard];
            if pasteboard.is_null() {
                return Err("no general pasteboard".to_string());
            }
            Ok(ClipboardText {
                text: string_for(pasteboard, c"public.utf8-plain-text").unwrap_or_default(),
                html: string_for(pasteboard, c"public.html").unwrap_or_default(),
            })
        }
    })
}

/// Replaces the general pasteboard with `text` (`public.utf8-plain-text`): `clearContents`, then `setString:forType:`. Call it on the main thread.
pub fn write(text: &str) -> Result<(), String> {
    // a NUL cannot be in a C string (and ends the text for the pasteboard anyway)
    let c_text = CString::new(text.replace('\0', "")).map_err(|e| e.to_string())?;
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: plain Objective-C messages to Foundation / AppKit objects; every object that comes back is checked for null before it is used,
        // and `c_text` outlives the call (`stringWithUTF8String:` copies it).
        unsafe {
            let pasteboard_class = AnyClass::get(c"NSPasteboard").ok_or("no NSPasteboard class")?;
            let string_class = AnyClass::get(c"NSString").ok_or("no NSString class")?;
            let pasteboard: *mut AnyObject = msg_send![pasteboard_class, generalPasteboard];
            if pasteboard.is_null() {
                return Err("no general pasteboard".to_string());
            }
            let value: *mut AnyObject = msg_send![string_class, stringWithUTF8String: c_text.as_ptr()];
            let kind: *mut AnyObject = msg_send![string_class, stringWithUTF8String: c"public.utf8-plain-text".as_ptr()];
            if value.is_null() || kind.is_null() {
                return Err("could not make the pasteboard text".to_string());
            }
            let _: isize = msg_send![pasteboard, clearContents];
            let done: Bool = msg_send![pasteboard, setString: value, forType: kind];
            if done.as_bool() { Ok(()) } else { Err("the pasteboard did not take the text".to_string()) }
        }
    })
}
