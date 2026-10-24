//! How the preview of a PDF attachment is shown on this system.
//!
//! * Windows draws the PDF in a frame of the dialog with the engine's own viewer (WebView2, verified in a real window, see src/pdfFrame.ts).
//! * macOS and Linux have no usable PDF viewer in their web views (WKWebView drew nothing in every variant that 1.0.6 tried; WebKitGTK has none), so the pages are drawn by
//!   PDF.js on canvases of the app's own page (src/pdfView.tsx, W5.1): no frame, no plug-in, no blob URL, and no change of the content security policy.
//! * A system the app does not know gets the card (the file, Open and Save as).
//!
//! A debug build can pick another way for the QA of one of them (`HEYLOOK_TEST_PDF_VIEW`, read once at start; a release build never reads it):
//! `card`, `pdfjs`, `pdfjs-broken` (PDF.js with a worker address that points to a missing file: the card must come up, AC-5.1.13) or `frame`. `HEYLOOK_TEST_PDF_OS=macos|linux|windows`
//! makes a debug build decide as if it ran on that system, and `HEYLOOK_TEST_PDF_CARD=1` is the older name of `HEYLOOK_TEST_PDF_VIEW=card`.
use std::sync::OnceLock;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PdfView {
    /// the PDF in a frame of the dialog (the engine's own viewer)
    Frame,
    /// the pages drawn by PDF.js
    Pdfjs,
    /// PDF.js whose worker cannot be found (debug seam)
    PdfjsBroken,
    /// no PDF in the window: a card with Open and Save as
    Card,
}

impl PdfView {
    /// The word the page reads (`shell_info`).
    pub fn name(self) -> &'static str {
        match self {
            PdfView::Frame => "frame",
            PdfView::Pdfjs => "pdfjs",
            PdfView::PdfjsBroken => "pdfjs-broken",
            PdfView::Card => "card",
        }
    }
}

/// Pure decision. `os` is `std::env::consts::OS`; `seam` the value of `HEYLOOK_TEST_PDF_VIEW` (only passed in a debug build).
pub fn decide(os: &str, seam: Option<&str>) -> PdfView {
    match seam.map(str::trim) {
        Some("card") => return PdfView::Card,
        Some("pdfjs") => return PdfView::Pdfjs,
        Some("pdfjs-broken") => return PdfView::PdfjsBroken,
        Some("frame") => return PdfView::Frame,
        _ => {}
    }
    match os {
        "windows" => PdfView::Frame,
        "macos" | "linux" => PdfView::Pdfjs,
        _ => PdfView::Card,
    }
}

/// The system the decision is made for. A debug build can pretend to be another one (`HEYLOOK_TEST_PDF_OS=macos`); a release build never reads it.
fn os_name() -> String {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("HEYLOOK_TEST_PDF_OS") {
        if matches!(v.as_str(), "macos" | "linux" | "windows") {
            return v;
        }
    }
    std::env::consts::OS.to_string()
}

/// The seam of this run, debug builds only.
fn seam() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("HEYLOOK_TEST_PDF_VIEW")
        .ok()
        .or_else(|| std::env::var("HEYLOOK_TEST_PDF_CARD").ok().filter(|v| v == "1").map(|_| "card".to_string()))
}

/// The decision for this run, made once and written to the log.
pub fn view() -> PdfView {
    static VIEW: OnceLock<PdfView> = OnceLock::new();
    *VIEW.get_or_init(|| {
        let seam = seam();
        let v = decide(&os_name(), seam.as_deref());
        crate::startup::stage(None, &format!("PDF preview: {} (system {}, test seam {:?})", v.name(), os_name(), seam));
        v
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_system_has_its_way_to_draw_a_pdf() {
        assert_eq!(decide("windows", None), PdfView::Frame, "Windows: the engine's viewer in a frame, as verified in 1.0.6");
        assert_eq!(decide("macos", None), PdfView::Pdfjs);
        assert_eq!(decide("linux", None), PdfView::Pdfjs);
        assert_eq!(decide("freebsd", None), PdfView::Card, "a system the app does not know: the card");
        assert_eq!(decide("macos", Some("")), PdfView::Pdfjs);
        assert_eq!(decide("macos", Some("1")), PdfView::Pdfjs, "only the documented words count");
    }

    #[test]
    fn the_debug_seam_picks_any_way_on_any_system() {
        for os in ["windows", "macos", "linux"] {
            assert_eq!(decide(os, Some("card")), PdfView::Card);
            assert_eq!(decide(os, Some(" pdfjs ")), PdfView::Pdfjs);
            assert_eq!(decide(os, Some("pdfjs-broken")), PdfView::PdfjsBroken);
            assert_eq!(decide(os, Some("frame")), PdfView::Frame);
        }
        assert_eq!(PdfView::Pdfjs.name(), "pdfjs");
        assert_eq!(PdfView::PdfjsBroken.name(), "pdfjs-broken");
    }

    #[test]
    fn the_shipped_policy_is_left_alone_and_nothing_reads_the_seams_in_release() {
        let conf = include_str!("../tauri.conf.json");
        // PDF.js needs no change of the policy: no blob frame on macOS or Linux, no plug-in, no 'unsafe-eval', no 'wasm-unsafe-eval', no worker-src
        assert!(conf.contains("object-src 'none'") && conf.contains("frame-src blob:") && conf.contains("script-src 'self';"));
        assert!(!conf.contains("unsafe-eval") && !conf.contains("worker-src"), "the policy stays as it is");
        let me = crate::test_guard::non_test_code(include_str!("pdfmode.rs"));
        // the seams are compiled in debug builds only, and the policy is never rewritten at run time any more
        assert!(me.contains("#[cfg(debug_assertions)]\n    if let Ok(v) = std::env::var(\"HEYLOOK_TEST_PDF_OS\")"));
        assert!(me.contains("if !cfg!(debug_assertions) {\n        return None;\n    }"));
        assert!(!me.contains("apply_csp") && !me.contains("HEYLOOK_PDF_INLINE") && !me.contains(".replace(\"object-src"), "the per-run policy change of the 1.0.6 experiment is gone");
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert!(!lib.contains("pdfmode::apply_csp"), "lib.rs does not touch the policy");
    }
}
