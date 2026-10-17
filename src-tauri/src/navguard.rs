//! The main window never leaves the app for a website (Windows).
//!
//! On Windows the PDF preview is a frame WITHOUT a `sandbox` (src/pdfFrame.ts: WebView2's PDF viewer does not run in a sandboxed frame,
//! whatever the sandbox allows). The sandbox was also what stopped a frame from navigating the whole window, so a link inside a PDF
//! (clicked, or a PDF built to do it) could replace the app with that website (seen in the real WebView2 window, WP1b). This hook sees
//! every top-level navigation of a web view before it happens and cancels one that goes to a web address that is not the app's own.
//! Nothing is opened in the browser instead: a navigation has no way to say whether a person clicked, and a PDF must not be able to
//! start a web page by itself. Everything that is not `http(s)` (the app's own `tauri://` and `blob:` / `data:` / `about:` addresses,
//! `mailto:`) is left alone, so no navigation that works today changes. Other systems keep their sandboxed frame and have no hook.
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Url;

/// What to do with a navigation of a web view.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Nav {
    Allow,
    /// a web address that is not the app's: cancelled
    Cancel,
}

/// The app's own addresses on Windows are `http://tauri.localhost/`, the dev server `http://localhost:<port>/`, nothing else is local.
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
        _ => Nav::Allow,
    }
}

/// The hook. Registered on Windows only (see `run` in lib.rs).
#[cfg_attr(not(windows), allow(dead_code))]
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
        assert_eq!(d("data:text/html,hello"), Nav::Allow);
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
}
