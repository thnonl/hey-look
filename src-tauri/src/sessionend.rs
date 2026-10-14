//! macOS: a session end (log out, restart, shut down) is not a quit the person asked for (OWNER DECISION A1, REQ-42 b r3.6).
//!
//! `macquit.rs` holds every `terminate:` that does not come from our own Quit menu item and runs the quit sequence first. For a
//! session end that is wrong: the system waits for the answer, and "cancel" makes macOS stop the log out / restart / shutdown and name
//! Hey Look! as the reason. A mail app runs all day, so this would hit every Mac session end and every unattended system update.
//! A session end is therefore answered "terminate now": no question, no dialog, no window; the normal exit path runs (queued actions
//! committed, install on quit), a message in its Undo time stays in the outbox and goes out at the next start, unsaved Compose text is
//! lost (README, Known limitations).
//!
//! Two independent signs are used (either one is enough): the reason attribute (`kAEQuitReason`, 'why?') of the quit Apple event that
//! is being handled, and `NSWorkspaceWillPowerOffNotification` seen shortly before. Everything that decides is here, free of
//! Objective-C, so the tests run on every platform; the platform calls are in `macquit.rs`.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A four-character code as the `u32` Apple events use (`'why?'`).
pub const fn four_cc(code: &[u8; 4]) -> u32 {
    ((code[0] as u32) << 24) | ((code[1] as u32) << 16) | ((code[2] as u32) << 8) | (code[3] as u32)
}

/// `kAEQuitReason`: the attribute of a quit Apple event that says why the system asks to quit.
pub const QUIT_REASON_KEY: u32 = four_cc(b"why?");

/// `kAELogOut`, `kAEReallyLogOut`, `kAEShowRestartDialog`, `kAERestart`, `kAEShowShutdownDialog`, `kAEShutDown`.
const SESSION_END_REASONS: [u32; 6] = [
    four_cc(b"logo"),
    four_cc(b"rlgo"),
    four_cc(b"rrst"),
    four_cc(b"rest"),
    four_cc(b"rsdn"),
    four_cc(b"shut"),
];

/// Whether this value of the quit-reason attribute is a log out, restart or shut down (with or without their dialogs).
pub fn is_session_end_reason(code: u32) -> bool {
    SESSION_END_REASONS.contains(&code)
}

/// How long a seen power-off notice counts. A session end that another app cancels leaves the notice behind; a quit the person asks
/// for after this time is a normal quit again (it runs the sequence).
pub const POWER_OFF_WINDOW: Duration = Duration::from_secs(120);

static POWER_OFF_SEEN: Mutex<Option<Instant>> = Mutex::new(None);

/// `NSWorkspaceWillPowerOffNotification` arrived (the person asked for a log out, restart or shut down).
pub fn note_power_off() {
    *POWER_OFF_SEEN.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
}

/// Whether a power-off notice was seen within `POWER_OFF_WINDOW` before `now`.
pub fn power_off_is_recent(seen: Option<Instant>, now: Instant) -> bool {
    matches!(seen, Some(at) if now.checked_duration_since(at).map_or(true, |age| age <= POWER_OFF_WINDOW))
}

/// The same for the notice recorded by `note_power_off`.
pub fn power_off_recently_seen() -> bool {
    let seen = *POWER_OFF_SEEN.lock().unwrap_or_else(|p| p.into_inner());
    power_off_is_recent(seen, Instant::now())
}

/// Is the terminate request being handled a session end? `reason`: the quit-reason attribute of the current Apple event when it
/// could be read (a Dock "Quit" or a script's `quit` has none; Cmd+Q and the menu item never get here, they are our own item).
pub fn is_session_end(reason: Option<u32>, power_off_recent: bool) -> bool {
    reason.is_some_and(is_session_end_reason) || power_off_recent
}

/// What `applicationShouldTerminate:` does with a terminate request.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Plan {
    /// Answer "terminate now" (the process ends through the normal exit path).
    EndNow,
    /// Answer "cancel", start the quit sequence; it ends the app itself when it is done.
    RunSequence,
}

/// A session end always ends now, whatever else is going on (a quit sequence under way, a question open): it is never held and never
/// cancelled. Otherwise the request ends now only when the quit sequence has already finished (`quitting`).
pub fn plan(session_end: bool, quitting: bool) -> Plan {
    if session_end || quitting { Plan::EndNow } else { Plan::RunSequence }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_character_codes_are_the_apple_event_values() {
        assert_eq!(QUIT_REASON_KEY, 0x7768_793F); // 'why?' = kAEQuitReason
        assert_eq!(four_cc(b"logo"), 0x6C6F_676F); // kAELogOut
        assert_eq!(four_cc(b"rlgo"), 0x726C_676F); // kAEReallyLogOut
        assert_eq!(four_cc(b"rrst"), 0x7272_7374); // kAEShowRestartDialog
        assert_eq!(four_cc(b"rest"), 0x7265_7374); // kAERestart
        assert_eq!(four_cc(b"rsdn"), 0x7273_646E); // kAEShowShutdownDialog
        assert_eq!(four_cc(b"shut"), 0x7368_7574); // kAEShutDown
    }

    #[test]
    fn every_log_out_restart_and_shut_down_reason_is_a_session_end() {
        for r in [b"logo", b"rlgo", b"rrst", b"rest", b"rsdn", b"shut"] {
            assert!(is_session_end_reason(four_cc(r)), "{}", String::from_utf8_lossy(r));
            assert!(is_session_end(Some(four_cc(r)), false));
        }
        // any other value, no reason (Dock "Quit", a script's `quit`) and a reason that could not be read are a quit the person asked for
        assert!(!is_session_end_reason(four_cc(b"quia")));
        assert!(!is_session_end(Some(four_cc(b"quia")), false));
        assert!(!is_session_end(Some(0), false));
        assert!(!is_session_end(None, false));
    }

    #[test]
    fn a_power_off_notice_alone_makes_a_session_end() {
        assert!(is_session_end(None, true));
        assert!(is_session_end(Some(0), true));
    }

    #[test]
    fn a_power_off_notice_counts_for_two_minutes_only() {
        let now = Instant::now();
        assert!(!power_off_is_recent(None, now));
        assert!(power_off_is_recent(Some(now), now));
        assert!(power_off_is_recent(Some(now - Duration::from_secs(119)), now));
        assert!(!power_off_is_recent(Some(now - Duration::from_secs(121)), now));
        // a clock reading before the notice (cannot happen with Instant, but never panics): counts as recent
        assert!(power_off_is_recent(Some(now + Duration::from_secs(5)), now));
    }

    #[test]
    fn the_recorded_power_off_notice_is_seen() {
        note_power_off();
        assert!(power_off_recently_seen());
    }

    /// The point of A1: whatever the state of the quit sequence, a session end can only end now, never cancel.
    #[test]
    fn a_session_end_is_never_cancelled_or_held() {
        for quitting in [false, true] {
            assert_eq!(plan(true, quitting), Plan::EndNow, "quitting={quitting}");
        }
        // the quit the person asked for still runs the sequence first, and ends only when it is finished
        assert_eq!(plan(false, false), Plan::RunSequence);
        assert_eq!(plan(false, true), Plan::EndNow);
    }
}
