//! The window never leaves the app for a website (Windows and macOS).
//!
//! The PDF preview is a frame WITHOUT a `sandbox` (src/pdfFrame.ts): neither WebView2 (Windows) nor WKWebView (macOS) draws a PDF inside a
//! sandboxed frame, whatever the sandbox allows. The sandbox was also what stopped a frame from navigating the whole window, so a link inside
//! a PDF (clicked, or a PDF built to do it) could replace the app with that website (seen in the real WebView2 window, WP1b). This hook sees
//! every navigation of a web view before it happens and cancels one that goes somewhere that is not the app: a web address that is not the
//! app's own (a loopback address of another program included), a `file:` or `data:` address, a `blob:` address of another site. It cannot
//! tell a frame from the window (WKWebView reports both alike), so a link inside the PDF does not even replace the PDF; it does nothing.
//! Nothing is opened in the browser instead: a navigation has no way to say whether a person clicked, and a PDF must not be able to
//! start a web page by itself. What is left alone: the app's own addresses (`http://tauri.localhost` on Windows, `tauri://localhost` on macOS,
//! and in a DEBUG build the one dev-server origin of `devUrl`), the `blob:` address of the PDF itself and the loads the PDF viewer makes
//! inside it, `about:` (srcdoc frames) and `mailto:`. Linux has no PDF preview and no hook.
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Manager;
use tauri::Url;

/// What to do with a navigation of a web view.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Nav {
    Allow,
    /// a web address that is not the app's: cancelled
    Cancel,
}

fn host_of(url: &Url) -> Option<String> {
    url.host_str().map(|h| h.trim_end_matches('.').to_ascii_lowercase())
}

/// The app's own web address is `http(s)://tauri.localhost/` (Windows, no port) and `tauri://localhost/` (macOS). Nothing else is the app:
/// a loopback address (`127.0.0.1:31103`, `localhost:9999`, `[::1]`) is some other program on this machine, and a link in a PDF must not be
/// able to take the window there (BUG-B1 of the v1.0.6 final QA: a link to a loopback stub replaced the app). Only a DEBUG build also lets
/// the dev server through, and only the one origin of `devUrl` in tauri.conf.json (`dev`), never "any local address".
fn is_app_origin(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {
            if host_of(url).as_deref() == Some("tauri.localhost") && url.port().is_none() {
                return true;
            }
            dev.is_some_and(|d| {
                url.scheme() == d.scheme() && host_of(url) == host_of(d) && url.port_or_known_default() == d.port_or_known_default()
            })
        }
        "tauri" => host_of(url).as_deref() == Some("localhost") && url.port().is_none(),
        _ => false,
    }
}

/// Pure decision (unit-tested on every system). `dev` is the dev-server origin: `Some` in a debug build only.
pub fn decide(url: &Url, dev: Option<&Url>) -> Nav {
    match url.scheme() {
        "http" | "https" | "tauri" => {
            if is_app_origin(url, dev) {
                Nav::Allow
            } else {
                Nav::Cancel
            }
        }
        // nothing in the app navigates to a file or to a document written into the address; a PDF link to one is an attack, not a feature
        "file" | "data" => Nav::Cancel,
        // `blob:<origin>/<id>`: the PDF the app made has the app's origin (`blob:tauri://localhost/..`, `blob:http://tauri.localhost/..`); the viewer's
        // own loads inside it may carry an opaque origin (`blob:null/..`); a blob of any other web address (a site, a loopback program) is not ours
        "blob" => match Url::parse(url.path()) {
            Ok(inner) if matches!(inner.scheme(), "http" | "https" | "tauri") && !is_app_origin(&inner, dev) => Nav::Cancel,
            _ => Nav::Allow,
        },
        _ => Nav::Allow,
    }
}

/// The hook. Registered on Windows and macOS (see `run` in lib.rs).
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("navguard")
        .on_navigation(|webview, url| {
            // the dev server counts as the app in a debug build only; a release build knows no loopback address at all
            let dev = if cfg!(debug_assertions) { webview.app_handle().config().build.dev_url.clone() } else { None };
            let verdict = decide(url, dev.as_ref());
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

    /// release build: no dev server
    fn d(u: &str) -> Nav {
        decide(&Url::parse(u).unwrap(), None)
    }

    /// debug build: the dev server of tauri.conf.json
    fn dd(u: &str) -> Nav {
        decide(&Url::parse(u).unwrap(), Some(&Url::parse("http://localhost:1420").unwrap()))
    }

    #[test]
    fn the_apps_own_addresses_pass() {
        for check in [d, dd] {
            assert_eq!(check("http://tauri.localhost/"), Nav::Allow);
            assert_eq!(check("https://tauri.localhost/index.html?w=compose"), Nav::Allow);
            assert_eq!(check("tauri://localhost/"), Nav::Allow);
            assert_eq!(check("about:blank"), Nav::Allow);
            assert_eq!(check("blob:http://tauri.localhost/6376f1f4-34a8-4b42-9c2b-b046a88deaad"), Nav::Allow);
            assert_eq!(check("blob:tauri://localhost/6376f1f4-34a8-4b42-9c2b-b046a88deaad"), Nav::Allow, "the PDF on macOS");
            assert_eq!(check("blob:null/6376f1f4-34a8-4b42-9c2b-b046a88deaad"), Nav::Allow, "the viewer's own load");
            assert_eq!(check("about:srcdoc"), Nav::Allow, "the frame of a message");
            assert_eq!(check("mailto:someone@example.com"), Nav::Allow);
        }
    }

    #[test]
    fn the_dev_server_passes_in_a_debug_build_only_and_only_its_own_origin() {
        assert_eq!(dd("http://localhost:1420/"), Nav::Allow);
        assert_eq!(dd("http://localhost:1420/index.html?w=compose#x"), Nav::Allow);
        assert_eq!(dd("blob:http://localhost:1420/6376f1f4"), Nav::Allow);
        assert_eq!(d("http://localhost:1420/"), Nav::Cancel, "a release build has no dev server");
        assert_eq!(d("blob:http://localhost:1420/6376f1f4"), Nav::Cancel);
        // another port, host spelling or scheme is not the dev server
        assert_eq!(dd("http://localhost:1421/"), Nav::Cancel);
        assert_eq!(dd("http://localhost/"), Nav::Cancel, "port 80");
        assert_eq!(dd("https://localhost:1420/"), Nav::Cancel);
        assert_eq!(dd("http://127.0.0.1:1420/"), Nav::Cancel);
        assert_eq!(dd("http://[::1]:1420/"), Nav::Cancel);
        assert_eq!(dd("http://localhost.:1420/x"), Nav::Allow, "a trailing dot is the same host");
    }

    #[test]
    fn a_loopback_program_is_cancelled_in_every_build() {
        // BUG-B1: the link of a PDF to a stub on 127.0.0.1 replaced the app
        for u in [
            "http://127.0.0.1:31103/link-from-pdf",
            "http://127.0.0.1/",
            "http://127.0.0.1:1420/",
            "http://localhost:9999/",
            "http://localhost:80/",
            "https://localhost/",
            "http://[::1]:80/",
            "http://[::1]/",
            "http://[::1]:1420/",
            "http://app.localhost/",
            "http://foo.localhost:1420/",
            "http://ipc.localhost/",
            "http://asset.localhost/",
            "http://tauri.localhost:8080/",
            "http://0.0.0.0:31103/",
            "http://0x7f.1/",
            "http://2130706433/",
            "http://127.1/",
            "tauri://localhost:9/",
            "tauri://evil/",
            "blob:http://127.0.0.1:31103/6376f1f4",
            "blob:http://localhost:9999/6376f1f4",
            "blob:http://[::1]:80/6376f1f4",
        ] {
            assert_eq!(d(u), Nav::Cancel, "release: {u}");
            assert_eq!(dd(u), Nav::Cancel, "debug: {u}");
        }
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
        // user-info and fragment tricks that name the app or the dev server but go elsewhere
        assert_eq!(d("http://tauri.localhost@127.0.0.1:31103/x"), Nav::Cancel);
        assert_eq!(dd("http://localhost:1420@127.0.0.1:31103/x"), Nav::Cancel);
        assert_eq!(dd("http://localhost:1420@example.com/"), Nav::Cancel);
        assert_eq!(dd("http://localhost:1420%40@127.0.0.1:9/"), Nav::Cancel);
        assert_eq!(dd("http://127.0.0.1:31103#@localhost:1420/"), Nav::Cancel);
        assert_eq!(dd("http://127.0.0.1:31103?@localhost:1420/"), Nav::Cancel);
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
