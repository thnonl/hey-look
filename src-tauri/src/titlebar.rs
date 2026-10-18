//! macOS title bar repaint strategies: which steps are taken after the frame theme of the windows was applied, chosen by the environment
//! variable `HEYLOOK_TITLEBAR_MODE` (read once, at the first use; the value used is logged).
//!
//! Why this exists (Mac QA 1.0.6, builds 0121a65 and 142359b): the `NSWindow` appearance of every window was right (the log reads back
//! `appearance` / `effectiveAppearance` for each, no MISMATCH), yet the painted title bar of the compose pop-outs did not change after creation
//! while main and reader followed. The most likely cause is in the page (App.css `.popout-compose` was `position: fixed`, see the report), and
//! that is fixed at the source; these steps are the safety net and the experiment: the Mac QA runs one build with different modes and the log
//! (`[wintheme]` lines, `strategy step ...`) says which one repaints. This file is pure (no tauri, no AppKit) so that it is tested everywhere;
//! the AppKit side is `macwin::run_act`, the sequencing is `wintheme::run_strategy`.
use std::sync::OnceLock;
use std::time::Duration;

/// One step of a strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    /// `setNeedsDisplay:YES` on the theme frame view (`contentView.superview`) and, recursively, on every subview (NSTitlebarContainerView,
    /// NSTitlebarView, ...), then `displayIfNeeded`
    Invalidate,
    /// the window gets the OPPOSITE appearance of the one it has to show
    FlipOpposite,
    /// ... and on a later run-loop tick the target one (nil for System), then `invalidateShadow`
    FlipRestore,
    /// `setTitle:` to a different string and back, `titleVisibility` hidden and back, `update`
    TitleCycle,
    /// `orderOut:` of the windows that are visible (remembered)
    OrderOut,
    /// ... and `orderFront:` of those again (the one that was key becomes key again)
    OrderFront,
    /// `titlebarAppearsTransparent` the other way and back
    TransparentToggle,
    /// the page of every window is asked to lay out its top edge again (a 1 px change of the box of the elements that are fixed or sticky
    /// at the top, for two frames): WebKit takes the colour under a full-size title bar from there
    PageNudge,
}

impl Act {
    pub fn name(self) -> &'static str {
        match self {
            Act::Invalidate => "invalidate",
            Act::FlipOpposite => "flip-opposite",
            Act::FlipRestore => "flip-restore",
            Act::TitleCycle => "title-cycle",
            Act::OrderOut => "order-out",
            Act::OrderFront => "order-front",
            Act::TransparentToggle => "transparent-toggle",
            Act::PageNudge => "page-nudge",
        }
    }
}

/// The mode used when the variable is not set (or not a mode): 0 = no forced repaint. The Mac QA found (37ae699) that the page fix alone (the compose root no longer position: fixed) makes every title bar follow; the forced-repaint modes stay as an experiment switch.
pub const DEFAULT_MODE: u8 = 0;
/// The highest mode.
pub const MAX_MODE: u8 = 8;
/// The pause before every step (the "next run-loop tick" of the flip is one of these).
pub const STEP_GAP: Duration = Duration::from_millis(50);

/// The mode a value of `HEYLOOK_TITLEBAR_MODE` stands for, and a note for the log when it was not usable. `None` (not set) and "" are the
/// default without a note.
pub fn parse_mode(raw: Option<&str>) -> (u8, Option<String>) {
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else { return (DEFAULT_MODE, None) };
    match raw.parse::<u8>() {
        Ok(m) if m <= MAX_MODE => (m, None),
        _ => (DEFAULT_MODE, Some(format!("'{}' is not a mode (0 to {MAX_MODE}): using {DEFAULT_MODE}", raw.chars().take(20).collect::<String>()))),
    }
}

/// The steps of a mode, in order. 0 = none (control); 1 invalidate; 2 flip; 3 title cycle; 4 order out / front; 5 transparent toggle;
/// 6 = 1 + 2 + 3; 7 = the page nudge only; 8 = 6 + the page nudge.
pub fn plan(mode: u8) -> Vec<Act> {
    use Act::*;
    match mode {
        0 => vec![],
        1 => vec![Invalidate],
        2 => vec![FlipOpposite, FlipRestore],
        3 => vec![TitleCycle],
        4 => vec![OrderOut, OrderFront],
        5 => vec![TransparentToggle],
        6 => vec![Invalidate, FlipOpposite, FlipRestore, TitleCycle],
        7 => vec![PageNudge],
        8 => vec![Invalidate, FlipOpposite, FlipRestore, TitleCycle, PageNudge],
        _ => plan(DEFAULT_MODE),
    }
}

/// What the mode is called in the log.
pub fn mode_text(mode: u8) -> String {
    let steps: Vec<&str> = plan(mode).iter().map(|a| a.name()).collect();
    format!("{mode} [{}]", if steps.is_empty() { "none".to_string() } else { steps.join(" + ") })
}

/// The mode of this run: the environment variable, read once. The note of an unusable value is returned the first time only (for the log).
pub fn mode() -> (u8, Option<String>) {
    static MODE: OnceLock<(u8, Option<String>)> = OnceLock::new();
    let (m, note) = MODE.get_or_init(|| parse_mode(std::env::var("HEYLOOK_TITLEBAR_MODE").ok().as_deref()));
    (*m, note.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use Act::*;

    #[test]
    fn the_variable_picks_the_mode_and_the_default_is_zero() {
        assert_eq!(parse_mode(None), (0, None));
        assert_eq!(parse_mode(Some("")), (0, None));
        assert_eq!(parse_mode(Some("  ")), (0, None));
        for m in 0..=MAX_MODE {
            assert_eq!(parse_mode(Some(&m.to_string())), (m, None));
        }
        assert_eq!(parse_mode(Some(" 3 ")), (3, None), "spaces around it do not matter");
        for bad in ["9", "-1", "x", "1.5", "300", "six"] {
            let (m, note) = parse_mode(Some(bad));
            assert_eq!(m, DEFAULT_MODE, "{bad}");
            assert!(note.unwrap().contains("not a mode"), "{bad}: says why");
        }
        assert_eq!(DEFAULT_MODE, 0);
    }

    #[test]
    fn every_mode_has_its_steps() {
        assert!(plan(0).is_empty(), "0 is the control: nothing is done");
        assert_eq!(plan(1), [Invalidate]);
        assert_eq!(plan(2), [FlipOpposite, FlipRestore]);
        assert_eq!(plan(3), [TitleCycle]);
        assert_eq!(plan(4), [OrderOut, OrderFront]);
        assert_eq!(plan(5), [TransparentToggle]);
        assert_eq!(plan(6), [Invalidate, FlipOpposite, FlipRestore, TitleCycle], "6 = 1 + 2 + 3 in sequence");
        let mut one_two_three = plan(1);
        one_two_three.extend(plan(2));
        one_two_three.extend(plan(3));
        assert_eq!(plan(6), one_two_three);
        assert_eq!(plan(7), [PageNudge]);
        assert_eq!(plan(8), [plan(6), plan(7)].concat());
        assert_eq!(plan(200), plan(DEFAULT_MODE), "an unknown number is the default");
    }

    #[test]
    fn a_step_that_takes_something_away_always_gives_it_back() {
        for m in 0..=MAX_MODE {
            let p = plan(m);
            let count = |a: Act| p.iter().filter(|x| **x == a).count();
            assert_eq!(count(OrderOut), count(OrderFront), "mode {m}: windows put out of sight come back");
            assert_eq!(count(FlipOpposite), count(FlipRestore), "mode {m}: a flipped window is flipped back");
            if let (Some(a), Some(b)) = (p.iter().position(|x| *x == OrderOut), p.iter().position(|x| *x == OrderFront)) {
                assert!(a < b, "mode {m}");
            }
            if let (Some(a), Some(b)) = (p.iter().position(|x| *x == FlipOpposite), p.iter().position(|x| *x == FlipRestore)) {
                assert!(a < b, "mode {m}");
            }
        }
    }

    #[test]
    fn the_log_names_the_mode() {
        assert_eq!(mode_text(0), "0 [none]");
        assert_eq!(mode_text(6), "6 [invalidate + flip-opposite + flip-restore + title-cycle]");
        assert!(mode_text(8).ends_with("page-nudge]"));
        assert_eq!(STEP_GAP, Duration::from_millis(50));
    }
}
