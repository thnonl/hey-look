//! How the preview of a PDF attachment is shown on this system.
//!
//! Windows draws the PDF in a frame of the dialog (verified in a real WebView2 window, see src/pdfFrame.ts). On macOS the same frame came out
//! blank white (Mac QA 1.0.6: the frame's `load` fired, nothing was drawn, no refusal was seen by the page), and Linux's web view has no PDF
//! viewer at all. So on macOS and Linux the dialog shows a CARD instead: the file, "PDF files open in your default app on this system",
//! Open (a temporary copy opened with the default app, the same path as every other Open) and Save as.
use std::sync::OnceLock;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PdfView {
    /// the PDF in a frame of the dialog
    Frame,
    /// no PDF in the window: a card with Open and Save as
    Card,
}

impl PdfView {
    /// The word the page reads (`shell_info`).
    pub fn name(self) -> &'static str {
        match self {
            PdfView::Frame => "frame",
            PdfView::Card => "card",
        }
    }
}

/// Pure decision. `os` is `std::env::consts::OS`; `force_card` the debug-only test seam.
pub fn decide(os: &str, force_card: bool) -> PdfView {
    if os == "windows" && !force_card {
        PdfView::Frame
    } else {
        PdfView::Card
    }
}

/// The decision for this run, made once. `HEYLOOK_TEST_PDF_CARD=1` (debug builds only) forces the card on Windows too, so that it can be seen in a
/// real window there.
pub fn view() -> PdfView {
    static VIEW: OnceLock<PdfView> = OnceLock::new();
    *VIEW.get_or_init(|| {
        let force_card = cfg!(debug_assertions) && std::env::var("HEYLOOK_TEST_PDF_CARD").is_ok_and(|v| v == "1");
        let v = decide(std::env::consts::OS, force_card);
        crate::startup::stage(None, &format!("PDF preview: {} (system {})", v.name(), std::env::consts::OS));
        v
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_draws_the_pdf_and_every_other_system_shows_the_card() {
        assert_eq!(decide("windows", false), PdfView::Frame);
        assert_eq!(decide("macos", false), PdfView::Card);
        assert_eq!(decide("linux", false), PdfView::Card);
        assert_eq!(decide("windows", true), PdfView::Card, "the debug seam");
    }

    #[test]
    fn the_seam_is_compiled_for_debug_builds_only() {
        let me = crate::test_guard::non_test_code(include_str!("pdfmode.rs"));
        assert!(me.contains("cfg!(debug_assertions) && std::env::var(\"HEYLOOK_TEST_PDF_CARD\")"));
    }
}
