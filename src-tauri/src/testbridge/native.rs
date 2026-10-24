//! The real [`Driver`]: the windows of the app, and the platform web view's own script call and snapshot. Nothing here needs a command the
//! page can invoke: the script goes in through the web view (WebView2 `ExecuteScript`, WKWebView `evaluateJavaScript:`, WebKitGTK
//! `evaluate_javascript`) and its answer comes back through the completion handler of that same call. Every platform call runs on the
//! main thread (`with_webview`), the waiting is done on the bridge's own thread.

use super::server::{native_json, Driver, ExecError, SnapshotError, WindowInfo};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

pub struct TauriDriver {
    pub app: AppHandle,
}

fn kind_of(label: &str) -> &'static str {
    if label == "main" {
        return "main";
    }
    match crate::popout::kind_of_label(label) {
        Some(crate::popout::Kind::Compose) => "compose",
        Some(crate::popout::Kind::Reader) => "reader",
        Some(k) => k.name(),
        None => "other",
    }
}

/// A physical length in logical pixels, to two decimals (960.0 for a 960 x 560 window on a 2x screen).
fn logical(physical: impl Into<f64>, scale: f64) -> f64 {
    if scale <= 0.0 {
        return physical.into();
    }
    (physical.into() / scale * 100.0).round() / 100.0
}

impl Driver for TauriDriver {
    fn windows(&self) -> Vec<WindowInfo> {
        let mut out: Vec<WindowInfo> = self
            .app
            .webview_windows()
            .into_iter()
            .map(|(label, w)| {
                let pos = w.outer_position().ok();
                let size = w.outer_size().ok();
                let scale = w.scale_factor().unwrap_or(1.0);
                WindowInfo {
                    title: w.title().unwrap_or_default(),
                    visible: w.is_visible().unwrap_or(false),
                    focused: w.is_focused().unwrap_or(false),
                    x: pos.map_or(0, |p| p.x),
                    y: pos.map_or(0, |p| p.y),
                    width: size.map_or(0, |s| s.width),
                    height: size.map_or(0, |s| s.height),
                    logical_x: logical(pos.map_or(0, |p| p.x), scale),
                    logical_y: logical(pos.map_or(0, |p| p.y), scale),
                    logical_width: logical(size.map_or(0, |s| s.width), scale),
                    logical_height: logical(size.map_or(0, |s| s.height), scale),
                    scale,
                    kind: kind_of(&label).to_string(),
                    label,
                }
            })
            .collect();
        out.sort_by(|a, b| (a.label != "main", a.label.len(), &a.label).cmp(&(b.label != "main", b.label.len(), &b.label)));
        out
    }

    fn exec(&self, label: &str, script: &str, timeout: Duration) -> Result<String, ExecError> {
        let w = self.app.get_webview_window(label).ok_or(ExecError::NoWindow)?;
        platform::exec(&w, script, timeout)
    }

    fn snapshot(&self, label: &str, timeout: Duration) -> Result<Vec<u8>, SnapshotError> {
        let w = self.app.get_webview_window(label).ok_or(SnapshotError::NoWindow)?;
        platform::snapshot(&w, timeout)
    }

    /// GET /native (REQ-4.1.5): the app process only (the web view processes are measured with the OS tools, W4.8).
    fn native(&self) -> serde_json::Value {
        let mem = process_memory();
        #[allow(unused_mut)]
        let mut v = native_json(std::process::id(), mem.rss, mem.footprint, mem.private, native_windows(&self.app), self.app.webview_windows().len());
        // macOS: the windows the app finished by hand, and what was found a second later (D-093): { swept, freed, alive }; alive is the empty shell that a close leaves (DEC-024: documented residual)
        #[cfg(target_os = "macos")]
        {
            let (swept, freed, alive) = crate::macwin::sweep_stats();
            v["sweeps"] = serde_json::json!({ "swept": swept, "freed": freed, "alive": alive });
        }
        v
    }
}

/// What the system says about the memory of this process; each field is None where the system has no such number.
#[derive(Default)]
struct ProcessMemory {
    /// resident set / working set
    rss: Option<u64>,
    /// macOS: phys_footprint, the number Activity Monitor and `footprint` show
    footprint: Option<u64>,
    /// Windows: PrivateUsage (commit)
    private: Option<u64>,
}

#[cfg(windows)]
fn process_memory() -> ProcessMemory {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
    c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    // SAFETY: the pseudo handle of this process, and a counters structure of the size it says (the EX layout starts with the plain one).
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS, c.cb) }.is_ok();
    if !ok {
        return ProcessMemory::default();
    }
    ProcessMemory { rss: Some(c.WorkingSetSize as u64), footprint: None, private: Some(c.PrivateUsage as u64) }
}

#[cfg(target_os = "macos")]
fn process_memory() -> ProcessMemory {
    // SAFETY: proc_pid_rusage fills the v0 structure we pass for our own pid (flavor 0 = rusage_info_v0, which holds the fields we read).
    unsafe {
        let mut info: libc::rusage_info_v0 = std::mem::zeroed();
        let rc = libc::proc_pid_rusage(std::process::id() as libc::c_int, libc::RUSAGE_INFO_V0, &mut info as *mut libc::rusage_info_v0 as *mut libc::rusage_info_t);
        if rc != 0 {
            return ProcessMemory::default();
        }
        ProcessMemory { rss: Some(info.ri_resident_size), footprint: Some(info.ri_phys_footprint), private: None }
    }
}

#[cfg(target_os = "linux")]
fn process_memory() -> ProcessMemory {
    // /proc/self/statm: size resident shared ... in pages
    let pages = std::fs::read_to_string("/proc/self/statm").ok().and_then(|t| t.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()));
    // SAFETY: sysconf with a constant name
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    ProcessMemory { rss: pages.map(|p| p * if page > 0 { page as u64 } else { 4096 }), footprint: None, private: None }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn process_memory() -> ProcessMemory {
    ProcessMemory::default()
}

/// macOS: the windows `NSApp` lists (total, visible, tao's own); asked on the main thread. None elsewhere, or when the main thread did not answer.
#[cfg(target_os = "macos")]
fn native_windows(app: &AppHandle) -> Option<(usize, usize, usize)> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(crate::macwin::counts());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(3)).ok().flatten()
}

#[cfg(not(target_os = "macos"))]
fn native_windows(_app: &AppHandle) -> Option<(usize, usize, usize)> {
    None
}

// ---- Windows: WebView2 ------------------------------------------------------------------------------------------------------------------
#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::sync::mpsc;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use webview2_com::{CapturePreviewCompletedHandler, ExecuteScriptCompletedHandler};
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    pub fn exec(w: &WebviewWindow, script: &str, timeout: Duration) -> Result<String, ExecError> {
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let tx_err = tx.clone();
        let script = script.to_string();
        w.with_webview(move |pw| unsafe {
            let started = (|| -> windows::core::Result<()> {
                let core = pw.controller().CoreWebView2()?;
                let done = ExecuteScriptCompletedHandler::create(Box::new(move |err, json| {
                    let _ = tx.send(err.map(|_| json).map_err(|e| e.message()));
                    Ok(())
                }));
                core.ExecuteScript(&HSTRING::from(script.as_str()), &done)
            })();
            if let Err(e) = started {
                let _ = tx_err.send(Err(e.message()));
            }
        })
        .map_err(|e| ExecError::Failed(e.to_string()))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(json)) => unwrap_string(&json),
            Ok(Err(e)) => Err(ExecError::Failed(e)),
            Err(_) => Err(ExecError::Timeout),
        }
    }

    /// WebView2 gives the result as JSON: a string comes back quoted, and `null` is what an uncaught exception or a syntax error looks like.
    pub(super) fn unwrap_string(json: &str) -> Result<String, ExecError> {
        match serde_json::from_str::<serde_json::Value>(json) {
            Ok(serde_json::Value::String(s)) => Ok(s),
            Ok(serde_json::Value::Null) => Err(ExecError::Failed("the script failed before it could answer (a syntax error in it, or the page is loading)".into())),
            _ => Err(ExecError::Failed(format!("the script did not return a string: {}", json.chars().take(100).collect::<String>()))),
        }
    }

    pub fn snapshot(w: &WebviewWindow, timeout: Duration) -> Result<Vec<u8>, SnapshotError> {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        let tx_err = tx.clone();
        w.with_webview(move |pw| unsafe {
            let started = (|| -> Result<(), String> {
                let core = pw.controller().CoreWebView2().map_err(|e| e.message())?;
                let stream = SHCreateMemStream(None).ok_or("could not make a memory stream")?;
                let for_read = stream.clone();
                let done = CapturePreviewCompletedHandler::create(Box::new(move |err| {
                    let _ = tx.send(err.map_err(|e| e.message()).and_then(|_| read_all(&for_read)));
                    Ok(())
                }));
                core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &done).map_err(|e| e.message())
            })();
            if let Err(e) = started {
                let _ = tx_err.send(Err(e));
            }
        })
        .map_err(|e| SnapshotError::Failed(e.to_string()))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(png)) if png.starts_with(b"\x89PNG") => Ok(png),
            Ok(Ok(_)) => Err(SnapshotError::Failed("WebView2 gave something that is not a PNG".into())),
            Ok(Err(e)) => Err(SnapshotError::Failed(e)),
            Err(_) => Err(SnapshotError::Failed("WebView2 did not finish the capture in time (is the window hidden?)".into())),
        }
    }

    unsafe fn read_all(s: &IStream) -> Result<Vec<u8>, String> {
        unsafe {
            let mut stat = STATSTG::default();
            s.Stat(&mut stat, STATFLAG_NONAME).map_err(|e| e.message())?;
            let size = stat.cbSize as usize;
            s.Seek(0, STREAM_SEEK_SET, None).map_err(|e| e.message())?;
            let mut buf = vec![0u8; size];
            let mut read = 0u32;
            s.Read(buf.as_mut_ptr() as *mut c_void, size as u32, Some(&mut read)).ok().map_err(|e| e.message())?;
            buf.truncate(read as usize);
            Ok(buf)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn unwraps_what_webview2_returns() {
            assert_eq!(unwrap_string("\"{\\\"done\\\":false}\"").unwrap(), "{\"done\":false}");
            assert!(matches!(unwrap_string("null"), Err(ExecError::Failed(_))));
            assert!(matches!(unwrap_string("12"), Err(ExecError::Failed(_))));
            assert!(matches!(unwrap_string(""), Err(ExecError::Failed(_))));
        }
    }
}

// ---- macOS: WKWebView ---------------------------------------------------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{c_char, CStr, CString};
    use std::sync::mpsc;

    unsafe fn ns_string(s: &str) -> Option<*mut AnyObject> {
        let c = CString::new(s).ok()?;
        let class = AnyClass::get(c"NSString")?;
        // SAFETY: a plain class message with a NUL-terminated string
        let o: *mut AnyObject = unsafe { msg_send![class, stringWithUTF8String: c.as_ptr()] };
        if o.is_null() { None } else { Some(o) }
    }

    unsafe fn rust_string(o: *mut AnyObject) -> Option<String> {
        if o.is_null() {
            return None;
        }
        let class = AnyClass::get(c"NSString")?;
        // SAFETY: `o` is an Objective-C object handed over by WebKit
        unsafe {
            let is_string: bool = msg_send![o, isKindOfClass: class];
            if !is_string {
                return None;
            }
            let p: *const c_char = msg_send![o, UTF8String];
            if p.is_null() { None } else { Some(CStr::from_ptr(p).to_string_lossy().into_owned()) }
        }
    }

    /// The message of a script error: WebKit puts the JavaScript exception in the user info.
    unsafe fn error_text(e: *mut AnyObject) -> String {
        // SAFETY: `e` is an NSError handed over by WebKit
        unsafe {
            let info: *mut AnyObject = msg_send![e, userInfo];
            if !info.is_null() {
                if let Some(key) = ns_string("WKJavaScriptExceptionMessage") {
                    let m: *mut AnyObject = msg_send![info, objectForKey: key];
                    if let Some(s) = rust_string(m) {
                        return s;
                    }
                }
            }
            let d: *mut AnyObject = msg_send![e, localizedDescription];
            rust_string(d).unwrap_or_else(|| "the script failed".into())
        }
    }

    pub fn exec(w: &WebviewWindow, script: &str, timeout: Duration) -> Result<String, ExecError> {
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let script = script.to_string();
        w.with_webview(move |pw| {
            // SAFETY: runs on the main thread (with_webview); `inner()` is the WKWebView of the window; the completion block is copied by WebKit
            unsafe {
                let view = pw.inner() as *mut AnyObject;
                let Some(js) = ns_string(&script) else {
                    let _ = tx.send(Err("the script contains a NUL character".into()));
                    return;
                };
                let tx_block = tx.clone();
                let block = block2::RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                    let out = if !error.is_null() {
                        Err(error_text(error))
                    } else {
                        rust_string(result).ok_or_else(|| "the script did not return a string".to_string())
                    };
                    let _ = tx_block.send(out);
                });
                let _: () = msg_send![view, evaluateJavaScript: js, completionHandler: &*block];
            }
        })
        .map_err(|e| ExecError::Failed(e.to_string()))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(s)) => Ok(s),
            Ok(Err(e)) => Err(ExecError::Failed(e)),
            Err(_) => Err(ExecError::Timeout),
        }
    }

    pub fn snapshot(w: &WebviewWindow, timeout: Duration) -> Result<Vec<u8>, SnapshotError> {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        w.with_webview(move |pw| {
            // SAFETY: as in `exec`; the image is converted inside the completion block, on the main thread
            unsafe {
                let view = pw.inner() as *mut AnyObject;
                let block = block2::RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
                    let out = if !error.is_null() {
                        Err(error_text(error))
                    } else if image.is_null() {
                        Err("WebKit returned no image (is the window hidden or minimised?)".to_string())
                    } else {
                        png_of(image)
                    };
                    let _ = tx.send(out);
                });
                let none: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![view, takeSnapshotWithConfiguration: none, completionHandler: &*block];
            }
        })
        .map_err(|e| SnapshotError::Failed(e.to_string()))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(png)) => Ok(png),
            Ok(Err(e)) => Err(SnapshotError::Failed(e)),
            Err(_) => Err(SnapshotError::Failed("WebKit did not finish the snapshot in time".into())),
        }
    }

    /// NSImage -> TIFF -> NSBitmapImageRep -> PNG bytes.
    unsafe fn png_of(image: *mut AnyObject) -> Result<Vec<u8>, String> {
        // SAFETY: Foundation / AppKit messages on the main thread; every object is checked for null
        unsafe {
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            if tiff.is_null() {
                return Err("the image has no TIFF data".into());
            }
            let rep_class = AnyClass::get(c"NSBitmapImageRep").ok_or("no NSBitmapImageRep class")?;
            let rep: *mut AnyObject = msg_send![rep_class, imageRepWithData: tiff];
            if rep.is_null() {
                return Err("could not read the image".into());
            }
            let dict_class = AnyClass::get(c"NSDictionary").ok_or("no NSDictionary class")?;
            let props: *mut AnyObject = msg_send![dict_class, dictionary];
            // NSBitmapImageFileTypePNG = 4
            let data: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: props];
            if data.is_null() {
                return Err("could not make a PNG".into());
            }
            let len: usize = msg_send![data, length];
            let bytes: *const u8 = msg_send![data, bytes];
            if bytes.is_null() || len == 0 {
                return Err("the PNG is empty".into());
            }
            Ok(std::slice::from_raw_parts(bytes, len).to_vec())
        }
    }
}

// ---- Linux: WebKitGTK -----------------------------------------------------------------------------------------------------------------
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::sync::mpsc;

    pub fn exec(w: &WebviewWindow, script: &str, timeout: Duration) -> Result<String, ExecError> {
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let script = script.to_string();
        w.with_webview(move |pw| {
            use javascriptcore::ValueExt;
            use webkit2gtk::WebViewExt;
            let view = pw.inner();
            view.evaluate_javascript(&script, None, None, None::<&webkit2gtk::gio::Cancellable>, move |result| {
                let out = match result {
                    Ok(v) if v.is_string() => Ok(v.to_str().to_string()),
                    Ok(_) => Err("the script did not return a string".to_string()),
                    Err(e) => Err(e.message().to_string()),
                };
                let _ = tx.send(out);
            });
        })
        .map_err(|e| ExecError::Failed(e.to_string()))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(s)) => Ok(s),
            Ok(Err(e)) => Err(ExecError::Failed(e)),
            Err(_) => Err(ExecError::Timeout),
        }
    }

    pub fn snapshot(_w: &WebviewWindow, _timeout: Duration) -> Result<Vec<u8>, SnapshotError> {
        Err(SnapshotError::Unsupported("snapshots are not available on Linux (WebKitGTK gives a cairo surface and the app has no PNG encoder for it); use the screen".into()))
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;

    pub fn exec(_w: &WebviewWindow, _script: &str, _timeout: Duration) -> Result<String, ExecError> {
        Err(ExecError::Failed("the test bridge has no web view driver for this system".into()))
    }

    pub fn snapshot(_w: &WebviewWindow, _timeout: Duration) -> Result<Vec<u8>, SnapshotError> {
        Err(SnapshotError::Unsupported("the test bridge has no web view driver for this system".into()))
    }
}
