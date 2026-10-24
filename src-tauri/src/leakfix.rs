//! macOS (D-093, round 12b): the arithmetic and the guards of the release of the extra references of a finished window. Pure code, compiled and tested on every system; the messages
//! to the window are in `macwin.rs` (`check`).
//!
//! Why: after a compose or reader window has ended (its `Destroyed` event came) and the app side has let go of everything it can (`macwin::sweep`), the weak reference still finds the
//! `NSWindow` alive with a retain count of 4: three references that nobody will ever use or release (the owners are inside tao / wry / WebKit / AppKit and cannot be removed from our
//! side). The Mac QA released them by hand in the experiment `HEYLOOK_MAC_RELEASE_LEAK=1`: the window list of AppKit shrank after every release, 3 warm-up + 20 cycles of compose and
//! reader kept `nsapp.total` flat, and the app ran for 3 minutes 20 seconds without a crash. This is the same release, guarded, and on by default.
//!
//! The count that may be released is computed, not guessed: `retainCount - the references this code knows it holds itself`. The only one at the moment of the check is the strong reference
//! that `check` takes from the weak one (the references of `sweep` were dropped before the weak reference was made). A future macOS, tao or wry that fixes the leak lowers the count to
//! that one reference and nothing is released (no over-release); a count that is not plausible (an immortal object reports a huge number) releases nothing either.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// The most references released from one window, whatever the count says.
pub const MAX_RELEASES: usize = 4;

/// A retain count above this is not a count of a few forgotten references (an immortal or a tagged object, or something that is not what we think): nothing is released.
pub const MAX_PLAUSIBLE: usize = 16;

/// The kill switch: `HEYLOOK_MAC_NO_LEAK_FIX=1`, in any build.
pub const KILL_SWITCH: &str = "HEYLOOK_MAC_NO_LEAK_FIX";

/// How many references may be released from a window whose retain count is `retain_count` when `own_refs` of them are the ones this code holds itself (and releases itself later).
pub fn expected_extra(retain_count: usize, own_refs: usize) -> usize {
    if retain_count > MAX_PLAUSIBLE {
        return 0;
    }
    retain_count.saturating_sub(own_refs).min(MAX_RELEASES)
}

/// Whether the kill switch is set (`value` = the environment variable).
pub fn switched_off(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("1")
}

/// What is known about the finished window when the fix is asked for.
#[derive(Default, Clone, Copy)]
pub struct WindowState {
    /// the `Destroyed` event came and tauri no longer lists the window
    pub destroyed: bool,
    pub is_main_label: bool,
    pub quitting: bool,
    pub visible: bool,
    pub key: bool,
    pub main: bool,
    pub has_sheet: bool,
    pub has_children: bool,
    pub has_parent: bool,
    pub switched_off: bool,
}

/// Why nothing may be released from this window, `None` when it may be.
pub fn refusal(s: &WindowState) -> Option<&'static str> {
    Some(match s {
        _ if s.switched_off => "switched off (HEYLOOK_MAC_NO_LEAK_FIX)",
        _ if s.is_main_label => "the main window",
        _ if s.quitting => "the app is quitting",
        _ if !s.destroyed => "the window did not end by its Destroyed event",
        _ if s.visible => "the window is visible",
        _ if s.key => "the window is the key window",
        _ if s.main => "the window is the main window of AppKit",
        _ if s.has_sheet => "the window has a sheet",
        _ if s.has_children => "the window has child windows",
        _ if s.has_parent => "the window has a parent window",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_guard::non_test_code;

    fn clean() -> WindowState {
        WindowState { destroyed: true, ..Default::default() }
    }

    #[test]
    fn the_extra_references_are_the_count_minus_the_ones_we_hold() {
        assert_eq!(expected_extra(4, 1), 3, "the count of round 12b");
        assert_eq!(expected_extra(1, 1), 0, "nothing left over: a future fix of the leak releases nothing");
        assert_eq!(expected_extra(0, 1), 0, "no underflow");
        assert_eq!(expected_extra(0, 0), 0);
        assert_eq!(expected_extra(2, 2), 0);
        assert_eq!(expected_extra(9, 1), MAX_RELEASES, "capped at 4 per window");
        assert_eq!(expected_extra(MAX_PLAUSIBLE, 1), MAX_RELEASES);
        assert_eq!(expected_extra(MAX_PLAUSIBLE + 1, 1), 0, "an implausible count releases nothing");
        assert_eq!(expected_extra(usize::MAX, 1), 0, "an immortal object reports a huge count");
    }

    #[test]
    fn the_kill_switch_is_one_and_nothing_else() {
        assert!(switched_off(Some("1")) && switched_off(Some(" 1 ")));
        assert!(!switched_off(None) && !switched_off(Some("0")) && !switched_off(Some("")) && !switched_off(Some("true")));
    }

    #[test]
    fn a_window_that_is_finished_and_quiet_may_be_released_and_every_other_state_may_not() {
        assert_eq!(refusal(&clean()), None);
        let cases: [(&str, WindowState); 10] = [
            ("switched", WindowState { switched_off: true, ..clean() }),
            ("main label", WindowState { is_main_label: true, ..clean() }),
            ("quitting", WindowState { quitting: true, ..clean() }),
            ("not destroyed", WindowState { destroyed: false, ..clean() }),
            ("visible", WindowState { visible: true, ..clean() }),
            ("key", WindowState { key: true, ..clean() }),
            ("main", WindowState { main: true, ..clean() }),
            ("sheet", WindowState { has_sheet: true, ..clean() }),
            ("children", WindowState { has_children: true, ..clean() }),
            ("parent", WindowState { has_parent: true, ..clean() }),
        ];
        for (name, s) in cases {
            assert!(refusal(&s).is_some(), "{name}");
        }
    }

    /// The release is in `check`, after `Destroyed` (the caller passes `destroyed`) and after `sweep` (which made the weak reference), only through the guards, and it never touches the
    /// pointer once the strong reference is dropped.
    #[test]
    fn the_release_is_after_the_destroy_and_the_teardown_and_behind_the_guards() {
        let mac = non_test_code(include_str!("macwin.rs"));
        let check = &mac[mac.find("pub fn check(").unwrap()..];
        let fix = &check[check.find("fn leak_fix(").unwrap()..];
        let fix = &fix[..fix.find("\n}\n").unwrap()];
        // asked only from `check`, which `popout.rs` runs after `Destroyed` + `sweep`
        assert!(check.contains("leak_fix(strong, &weak, label, destroyed)"));
        assert!(mac.find("pub fn sweep(").unwrap() < mac.find("pub fn check(").unwrap());
        let pop = non_test_code(include_str!("popout.rs"));
        assert!(pop.find("native_sweep(&name)").unwrap() < pop.find("native_check(&name, ended)").unwrap());
        assert!(pop.contains("after_destroyed(app, &label, true)") && pop.contains("after_destroyed(app, label, false)"), "a window that was given up is never released");
        // the guards, before the first release
        let first_release = fix.find("msg_send![ptr, release]").unwrap();
        for guard in ["leakfix::refusal(&state)", "leakfix::expected_extra(", "isVisible", "isKeyWindow", "isMainWindow", "attachedSheet", "childWindows", "parentWindow", "crate::QUITTING", "leakfix::KILL_SWITCH"] {
            let at = fix.find(guard).unwrap_or_else(|| panic!("{guard}"));
            assert!(at < first_release, "{guard} must come before the release");
        }
        // the count is read again before every release, the loop is capped, and our own reference is the last one to go
        assert!(fix.contains("while released < leakfix::MAX_RELEASES"));
        assert_eq!(fix.matches("msg_send![ptr, release]").count(), 1);
        assert!(fix.find("msg_send![ptr, release]").unwrap() < fix.rfind("drop(strong)").unwrap());
        assert_eq!(fix.matches("drop(strong)").count(), 2, "dropped once on a refusal and once after the loop, never twice on one path");
        assert!(fix.contains("leak fix: released {released} extra reference(s), window"));
        // counted for GET /native
        assert!(mac.contains("RELEASED.fetch_add(released"));
        let native = include_str!("testbridge/native.rs");
        assert!(native.contains("\"released\": released"));
    }
}
