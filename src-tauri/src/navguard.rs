//! The window never leaves the app for a website (Windows and macOS).
//!
//! The PDF preview is a frame WITHOUT a `sandbox` (src/pdfFrame.ts): neither WebView2 (Windows) nor WKWebView (macOS) draws a PDF inside a
//! sandboxed frame, whatever the sandbox allows. The sandbox was also what stopped a frame from navigating the whole window, so a link inside
//! a PDF (clicked, or a PDF built to do it) could replace the app with that website (seen in the real WebView2 window, WP1b). This hook sees
//! every navigation of a web view before it happens and cancels one that goes somewhere that is not the app: a web address that is not the
//! app's own, a `file:` or `data:` address, a `blob:` address of another site. It cannot tell a frame from the window (WKWebView reports both
//! alike), so a link inside the PDF does not even replace the PDF; it does nothing.
//! Nothing is opened in the browser instead: a navigation has no way to say whether a person clicked, and a PDF must not be able to
//! start a web page by itself. What is left alone: the app's own addresses (`http://tauri.localhost` on Windows, `tauri://localhost` on macOS,
//! the dev server), the `blob:` address of the PDF itself and the loads the PDF viewer makes inside it, `about:` (srcdoc frames) and
//! `mailto:`. Linux has no PDF preview and no hook.
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Url;

/// What to do with a navigation of a web view.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Nav {
    Allow,
    /// a web address that is not the app's: cancelled
    Cancel,
}

/// The app's own web addresses are `http://tauri.localhost/` (Windows), the dev server `http://localhost:<port>/`, nothing else is local
/// (on macOS the app is `tauri://localhost/`, which is not a web address and passes as such).
fn is_local_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1" || h == "[::1]" || h == "::1"
}

/// Pure decision (unit-tested on every system).
pub fn decide(url: &Url) -> Nav {
    match url.scheme() {
        "http" | "https" => match url.host_str() {
            Some(h) if is_local_host(h) => Nav::Allow,
            _ => Nav::Cancel,
        },
        // nothing in the app navigates to a file or to a document written into the address; a PDF link to one is an attack, not a feature
        "file" | "data" => Nav::Cancel,
        // `blob:<origin>/<id>`: the PDF the app made has the app's origin (`blob:tauri://localhost/..`, `blob:http://tauri.localhost/..`); the viewer's
        // own loads inside it may carry an opaque origin (`blob:null/..`); a blob of a web site is not ours
        "blob" => match Url::parse(url.path()) {
            Ok(inner) if matches!(inner.scheme(), "http" | "https") && !inner.host_str().is_some_and(is_local_host) => Nav::Cancel,
            _ => Nav::Allow,
        },
        _ => Nav::Allow,
    }
}

/// The hook. Registered on Windows and macOS (see `run` in lib.rs).
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("navguard")
        .on_navigation(|_webview, url| {
            let verdict = decide(url);
            if verdict == Nav::Cancel {
                // (the address can carry private data of the PDF's author: only host and scheme go to the log)
                crate::startup::stage(
                    None,
                    &format!("navigation to {}://{} cancelled: the window stays in the app", url.scheme(), url.host_str().unwrap_or("?")),
                );
            }
            verdict == Nav::Allow
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(u: &str) -> Nav {
        decide(&Url::parse(u).unwrap())
    }

    #[test]
    fn the_apps_own_addresses_pass() {
        assert_eq!(d("http://tauri.localhost/"), Nav::Allow);
        assert_eq!(d("https://tauri.localhost/index.html?w=compose"), Nav::Allow);
        assert_eq!(d("http://localhost:1420/"), Nav::Allow, "the dev server");
        assert_eq!(d("http://127.0.0.1:1420/"), Nav::Allow);
        assert_eq!(d("http://[::1]:1420/"), Nav::Allow);
        assert_eq!(d("tauri://localhost/"), Nav::Allow);
        assert_eq!(d("about:blank"), Nav::Allow);
        assert_eq!(d("blob:http://tauri.localhost/6376f1f4-34a8-4b42-9c2b-b046a88deaad"), Nav::Allow);
        assert_eq!(d("blob:tauri://localhost/6376f1f4-34a8-4b42-9c2b-b046a88deaad"), Nav::Allow, "the PDF on macOS");
        assert_eq!(d("blob:null/6376f1f4-34a8-4b42-9c2b-b046a88deaad"), Nav::Allow, "the viewer's own load");
        assert_eq!(d("blob:https://localhost:1420/6376f1f4"), Nav::Allow);
        assert_eq!(d("about:srcdoc"), Nav::Allow, "the frame of a message");
        assert_eq!(d("mailto:someone@example.com"), Nav::Allow);
    }

    #[test]
    fn a_website_is_cancelled() {
        assert_eq!(d("https://example.com/pdf-link-probe"), Nav::Cancel);
        assert_eq!(d("http://example.com/"), Nav::Cancel);
        assert_eq!(d("https://tauri.localhost.example.com/"), Nav::Cancel, "looks like the app, is not");
        assert_eq!(d("https://localhost.example.com/"), Nav::Cancel);
        assert_eq!(d("http://192.168.1.10/"), Nav::Cancel, "a router page is a website too");
        assert_eq!(d("https://user:pass@example.com@tauri.localhost/"), Nav::Allow, "the host is tauri.localhost whatever the user part says");
        assert_eq!(d("https://tauri.localhost@example.com/"), Nav::Cancel, "the host is example.com");
    }

    #[test]
    fn a_file_a_document_in_the_address_and_a_blob_of_a_website_are_cancelled() {
        assert_eq!(d("file:///etc/passwd"), Nav::Cancel);
        assert_eq!(d("file:///Users/someone/Library/Mail/x"), Nav::Cancel);
        assert_eq!(d("data:text/html,<script>alert(1)</script>"), Nav::Cancel);
        assert_eq!(d("data:application/pdf;base64,JVBERi0="), Nav::Cancel);
        assert_eq!(d("blob:https://example.com/6376f1f4-34a8-4b42-9c2b-b046a88deaad"), Nav::Cancel);
        assert_eq!(d("blob:http://tauri.localhost.example.com/6376f1f4"), Nav::Cancel);
    }

    #[test]
    fn the_hook_is_registered_on_the_two_systems_whose_pdf_frame_has_no_sandbox() {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(
            lib.replace("
", "
").contains("#[cfg(any(windows, target_os = \"macos\"))]
    // a frame of the window"),
            "navguard must be registered where src/pdfFrame.ts drops the sandbox"
        );
        assert!(lib.contains("builder.plugin(navguard::plugin())"));
    }
}
