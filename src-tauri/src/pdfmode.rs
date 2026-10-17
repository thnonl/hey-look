//! How the preview of a PDF attachment is shown on this system.
//!
//! Windows draws the PDF in a frame of the dialog (verified in a real WebView2 window, see src/pdfFrame.ts). On macOS the same frame came out
//! blank white (Mac QA 1.0.6, `load` fired, nothing drawn, no refusal seen by the page), so on macOS and Linux the dialog shows a CARD by
//! default: the file, "PDF files open in your default app on this system", Open and Save as. For the QA of a fix there is an experiment
//! switch, read once at start (it works in debug and release builds, and does nothing on Windows):
//!
//! * unset                      card
//! * `HEYLOOK_PDF_INLINE=1`      the frame, and the content security policy of THIS RUN gets `object-src blob:` instead of `object-src 'none'`
//! * `HEYLOOK_PDF_INLINE=object` an `<object type="application/pdf">` instead of the frame, same policy change
//!
//! Why the policy: WebKit turns a PDF loaded into a frame into a plugin document that holds an `<embed>` of the PDF's own address, and the
//! `object-src` rule can apply to that embed (WebKit bug 153160 describes the inheritance; bug 223576 / 220665 a PDF Safari would not draw
//! without `object-src`). Nothing proves that for this app yet: the Mac QA decides. The change only lets `blob:` addresses be loaded as
//! plugin content, and the only blob the app ever makes is the PDF of the preview, typed `application/pdf` after the `%PDF-` check.
//! Every other directive is untouched; the file tauri.conf.json (and so Windows) keeps `object-src 'none'`.
use std::sync::OnceLock;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PdfView {
    /// the PDF in a frame of the dialog
    Frame,
    /// the PDF in an `<object>` (experiment on macOS / Linux only)
    Object,
    /// no PDF in the window: a card with Open and Save as
    Card,
}

impl PdfView {
    /// The word the page reads (`shell_info`).
    pub fn name(self) -> &'static str {
        match self {
            PdfView::Frame => "frame",
            PdfView::Object => "object",
            PdfView::Card => "card",
        }
    }
}

/// Pure decision. `os` is `std::env::consts::OS`; `switch` the value of `HEYLOOK_PDF_INLINE`; `force_card` the debug-only test seam.
pub fn decide(os: &str, switch: Option<&str>, force_card: bool) -> PdfView {
    if os == "windows" {
        // (the experiment switch is ignored here: the frame is the verified way)
        return if force_card { PdfView::Card } else { PdfView::Frame };
    }
    if force_card {
        return PdfView::Card;
    }
    match switch.map(str::trim) {
        Some("1") => PdfView::Frame,
        Some("object") => PdfView::Object,
        _ => PdfView::Card,
    }
}

/// The system the decision is made for. A debug build can pretend to be another one (`HEYLOOK_TEST_PDF_OS=macos`) so that the card and the
/// experiment can be seen in a real window on Windows; a release build never reads it.
fn os_name() -> String {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("HEYLOOK_TEST_PDF_OS") {
        if matches!(v.as_str(), "macos" | "linux" | "windows") {
            return v;
        }
    }
    std::env::consts::OS.to_string()
}

/// The decision for this run, made once. `HEYLOOK_TEST_PDF_CARD=1` (debug builds only) forces the card on Windows too.
pub fn view() -> PdfView {
    static VIEW: OnceLock<PdfView> = OnceLock::new();
    *VIEW.get_or_init(|| {
        let force_card = cfg!(debug_assertions) && std::env::var("HEYLOOK_TEST_PDF_CARD").is_ok_and(|v| v == "1");
        let v = decide(&os_name(), std::env::var("HEYLOOK_PDF_INLINE").ok().as_deref(), force_card);
        crate::startup::stage(None, &format!("PDF preview: {} (system {}, HEYLOOK_PDF_INLINE {:?})", v.name(), os_name(), std::env::var("HEYLOOK_PDF_INLINE").ok()));
        v
    })
}

/// Whether the experiment is on: the frame or the object on a system that does not draw PDFs inline by default.
fn experiment(os: &str, view: PdfView) -> bool {
    os != "windows" && view != PdfView::Card
}

/// The same for this run (the page shows a readout of what the engine did with the PDF while it is on).
pub fn experiment_on() -> bool {
    experiment(&os_name(), view())
}

/// The policy of this run: the configured one, with `object-src blob:` in place of `object-src 'none'` while the experiment is on.
pub fn csp_for(csp: &str, os: &str, view: PdfView) -> String {
    if !experiment(os, view) {
        return csp.to_string();
    }
    csp.replace("object-src 'none'", "object-src blob:")
}

/// Applies [`csp_for`] to the configuration before the app is built (tauri sends the policy as a header with every page it serves).
pub fn apply_csp(config: &mut tauri::utils::config::Config) {
    if let Some(tauri::utils::config::Csp::Policy(p)) = &mut config.app.security.csp {
        let next = csp_for(p, &os_name(), view());
        if next != *p {
            crate::startup::stage(None, "PDF preview experiment: the content security policy of this run has object-src blob:");
            *p = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSP: &str = "default-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'";

    #[test]
    fn windows_draws_the_pdf_whatever_the_switch_says() {
        assert_eq!(decide("windows", None, false), PdfView::Frame);
        assert_eq!(decide("windows", Some("1"), false), PdfView::Frame);
        assert_eq!(decide("windows", Some("object"), false), PdfView::Frame, "the experiment does nothing on Windows");
        assert_eq!(decide("windows", Some("0"), false), PdfView::Frame);
        assert_eq!(decide("windows", None, true), PdfView::Card, "the debug seam");
    }

    #[test]
    fn mac_and_linux_show_the_card_unless_the_switch_asks_for_the_pdf() {
        for os in ["macos", "linux"] {
            assert_eq!(decide(os, None, false), PdfView::Card);
            assert_eq!(decide(os, Some(""), false), PdfView::Card);
            assert_eq!(decide(os, Some("0"), false), PdfView::Card);
            assert_eq!(decide(os, Some("yes"), false), PdfView::Card, "only the documented values count");
            assert_eq!(decide(os, Some("1"), false), PdfView::Frame);
            assert_eq!(decide(os, Some(" 1 "), false), PdfView::Frame);
            assert_eq!(decide(os, Some("object"), false), PdfView::Object);
            assert_eq!(decide(os, Some("1"), true), PdfView::Card, "the seam wins");
        }
    }

    #[test]
    fn the_policy_changes_only_for_the_experiment_and_only_object_src() {
        assert_eq!(csp_for(CSP, "macos", PdfView::Card), CSP);
        assert_eq!(csp_for(CSP, "windows", PdfView::Frame), CSP, "Windows keeps object-src 'none'");
        assert_eq!(csp_for(CSP, "windows", PdfView::Object), CSP);
        let on = csp_for(CSP, "macos", PdfView::Frame);
        assert_eq!(on, "default-src 'self'; frame-src blob:; object-src blob:; base-uri 'none'");
        assert_eq!(csp_for(CSP, "linux", PdfView::Object), on);
        // every other directive is as it was
        let rest = |s: &str| s.split("; ").filter(|d| !d.starts_with("object-src")).collect::<Vec<_>>().join("; ");
        assert_eq!(rest(&on), rest(CSP));
    }

    #[test]
    fn the_shipped_policy_has_the_text_the_switch_replaces_and_nothing_reads_the_seams_in_release() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains("object-src 'none'"), "csp_for replaces this text");
        let me = crate::test_guard::non_test_code(include_str!("pdfmode.rs"));
        // both test seams are compiled in debug builds only
        assert!(me.contains("#[cfg(debug_assertions)]\n    if let Ok(v) = std::env::var(\"HEYLOOK_TEST_PDF_OS\")"));
        assert!(me.contains("cfg!(debug_assertions) && std::env::var(\"HEYLOOK_TEST_PDF_CARD\")"));
    }
}
