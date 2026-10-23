//! The macOS Dock badge (the unread number on the app's Dock tile): what is asked for, where the call runs, and what is known about the result.
//!
//! Compiled everywhere so that its rules are tested everywhere; only `shell::update_badge` calls it, and only on macOS.
//!
//! D-056 (Mac QA, a real .app bundle): the Dock tile never showed the number although `set_badge_label` was called, and the call's Result was dropped,
//! so nothing said why. Now every request is logged in `startup.log` (the label, the Result of the call, the label the Dock tile reports back), the call
//! runs on the main thread (`NSDockTile` is an AppKit object), and the last attempt can be read from the QA bridge (`GET /badge`, debug builds):
//!   `[badge +ms] dock: label "7" set (on the main thread), tile reads back "7"`
//!   `[badge +ms] dock: label "7" NOT applied: <error>`
//! A line is written when the label changes or an attempt fails, not on every sync.

use serde::Serialize;
use std::sync::Mutex;

/// The last attempt to set the badge. `outcome` is `none` before the first request.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Record {
    /// requests so far (sets and clears)
    pub attempts: u64,
    /// the label asked for (`None` = remove the badge)
    pub requested: Option<String>,
    /// `none`, `queued` (handed to the main thread, not run yet), `set` or `failed: <why>`
    pub outcome: String,
    /// what the Dock tile reported right after the set (macOS), `None` when it has no label or could not be read
    pub tile: Option<String>,
    /// whether the call ran on the main thread
    #[serde(rename = "mainThread")]
    pub main_thread: bool,
}

impl Record {
    pub const fn new() -> Record {
        Record { attempts: 0, requested: None, outcome: String::new(), tile: None, main_thread: false }
    }
}

/// The record of the running app.
pub static LAST: Mutex<Record> = Mutex::new(Record::new());

fn lock(cell: &Mutex<Record>) -> std::sync::MutexGuard<'_, Record> {
    cell.lock().unwrap_or_else(|p| p.into_inner())
}

/// The last attempt, for the bridge.
pub fn last() -> Record {
    let mut r = lock(&LAST).clone();
    if r.outcome.is_empty() {
        r.outcome = "none".into();
    }
    r
}

/// The text of the macOS Dock badge: the unread number, nothing at 0 or when the setting is "off" (`None` removes the badge).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn label(count: u32, style: &str) -> Option<String> {
    (count > 0 && style == "number").then(|| count.to_string())
}

/// Whether an attempt gets a line in the log: the first one, a changed label, or any failure. Pure.
pub fn should_log(previous: &Record, requested: &Option<String>, failed: bool) -> bool {
    failed || previous.attempts == 0 || &previous.requested != requested || previous.outcome.starts_with("failed")
}

fn shown(label: &Option<String>) -> String {
    match label {
        Some(l) => format!("\"{l}\""),
        None => "none (badge removed)".into(),
    }
}

/// Hands the change to the main thread and records what happens. `on_main` runs a closure on the main thread (`app.run_on_main_thread`), `set`
/// is the platform call: it returns the label the Dock tile reports afterwards, or the error. Both are parameters so the decision is tested
/// without a Mac. `cell` is the record (`LAST` in the app).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn request_into<D, S>(cell: &'static Mutex<Record>, requested: Option<String>, on_main: D, set: S)
where
    D: FnOnce(Box<dyn FnOnce() + Send + 'static>) -> Result<(), String>,
    S: FnOnce(Option<String>) -> Result<Option<String>, String> + Send + 'static,
{
    let previous = {
        let mut r = lock(cell);
        let previous = r.clone();
        r.attempts += 1;
        r.requested = requested.clone();
        r.outcome = "queued".into();
        previous
    };
    let want = requested.clone();
    let job: Box<dyn FnOnce() + Send + 'static> = Box::new(move || {
        let result = set(want.clone());
        let mut r = lock(cell);
        r.main_thread = true;
        match result {
            Ok(tile) => {
                r.outcome = "set".into();
                r.tile = tile.clone();
                if should_log(&previous, &want, false) {
                    // the tile is read back right after the call: a label that differs from the one asked for is the thing to look at
                    let mismatch = if tile == want { "" } else { " (DIFFERENT from the label asked for)" };
                    crate::startup::line("badge", &format!("dock: label {} set (on the main thread), tile reads back {}{mismatch}", shown(&want), shown(&tile)));
                }
            }
            Err(e) => {
                r.outcome = format!("failed: {e}");
                r.tile = None;
                crate::startup::line("badge", &format!("dock: label {} NOT applied: {e}", shown(&want)));
            }
        }
    });
    if let Err(e) = on_main(job) {
        let mut r = lock(cell);
        r.outcome = format!("failed: could not reach the main thread: {e}");
        crate::startup::line("badge", &format!("dock: label {} NOT applied: could not reach the main thread: {e}", shown(&requested)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_is_the_unread_number_unless_it_is_zero_or_turned_off() {
        assert_eq!(label(7, "number"), Some("7".into()));
        assert_eq!(label(1234, "number"), Some("1234".into()));
        assert_eq!(label(0, "number"), None, "cleared at 0");
        assert_eq!(label(7, "off"), None, "the setting's None");
        assert_eq!(label(7, "dot"), None, "an unknown style shows nothing");
    }

    #[test]
    fn a_line_is_logged_for_the_first_attempt_a_changed_label_and_every_failure_only() {
        let first = Record::new();
        assert!(should_log(&first, &Some("3".into()), false), "the first attempt");
        let set3 = Record { attempts: 1, requested: Some("3".into()), outcome: "set".into(), ..Record::new() };
        assert!(!should_log(&set3, &Some("3".into()), false), "the same label again is a sync, not news");
        assert!(should_log(&set3, &Some("4".into()), false), "a changed label");
        assert!(should_log(&set3, &None, false), "removed");
        assert!(should_log(&set3, &Some("3".into()), true), "a failure is always logged");
        let failed = Record { outcome: "failed: x".into(), ..set3 };
        assert!(should_log(&failed, &Some("3".into()), false), "the first success after a failure");
    }

    #[test]
    fn a_request_runs_on_the_main_thread_call_and_records_the_tile() {
        static C: Mutex<Record> = Mutex::new(Record::new());
        let mut ran = false;
        request_into(&C, Some("7".into()), |job| { job(); ran = true; Ok(()) }, |l| { assert_eq!(l, Some("7".into())); Ok(Some("7".into())) });
        assert!(ran);
        let r = lock(&C).clone();
        assert_eq!((r.attempts, r.requested.as_deref(), r.outcome.as_str(), r.tile.as_deref(), r.main_thread), (1, Some("7"), "set", Some("7"), true));
    }

    #[test]
    fn nothing_is_claimed_before_the_main_thread_has_run_the_call() {
        static C: Mutex<Record> = Mutex::new(Record::new());
        // the job is handed over and kept: the record says queued, never set
        let parked = std::sync::Arc::new(Mutex::new(None));
        let p = parked.clone();
        request_into(&C, Some("2".into()), move |job| { *p.lock().unwrap() = Some(job); Ok(()) }, |_| Ok(Some("2".into())));
        assert_eq!(lock(&C).outcome, "queued");
        assert!(!lock(&C).main_thread);
        let job = parked.lock().unwrap().take().unwrap();
        job();
        assert_eq!(lock(&C).outcome, "set");
    }

    #[test]
    fn a_failed_call_is_recorded_with_its_error_and_the_label_is_not_called_set() {
        static C: Mutex<Record> = Mutex::new(Record::new());
        request_into(&C, Some("9".into()), |job| { job(); Ok(()) }, |_| Err("the main window does not exist yet".into()));
        let r = lock(&C).clone();
        assert_eq!(r.outcome, "failed: the main window does not exist yet");
        assert_eq!(r.tile, None);
        assert_eq!(r.requested.as_deref(), Some("9"), "what was asked for stays visible");
    }

    #[test]
    fn a_main_thread_that_cannot_be_reached_is_a_failure_too() {
        static C: Mutex<Record> = Mutex::new(Record::new());
        request_into(&C, None, |_job| Err("event loop closed".into()), |_| Ok(None));
        let r = lock(&C).clone();
        assert!(r.outcome.starts_with("failed: could not reach the main thread"), "{}", r.outcome);
        assert!(!r.main_thread);
    }

    #[test]
    fn a_tile_that_shows_another_label_than_the_one_set_is_visible_in_the_record() {
        static C: Mutex<Record> = Mutex::new(Record::new());
        request_into(&C, Some("5".into()), |job| { job(); Ok(()) }, |_| Ok(None));
        let r = lock(&C).clone();
        assert_eq!((r.outcome.as_str(), r.requested.as_deref(), r.tile.as_deref()), ("set", Some("5"), None), "the QA reads requested != tile");
    }

    #[test]
    fn update_badge_goes_through_the_main_thread_and_logs() {
        // the call site: the platform call is made only inside `request_into`'s job, with run_on_main_thread as the hand-over, and its Result is kept
        let src = include_str!("shell.rs");
        let body = &src[src.find("pub fn update_badge(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("crate::dockbadge::request_into("), "{body}");
        assert!(body.contains("app.run_on_main_thread(job)"), "{body}");
        assert!(!body.contains("let _ = w.set_badge_label"), "the Result of set_badge_label must not be dropped");
        let setter = &src[src.find("fn set_dock_badge(").unwrap()..];
        let setter = &setter[..setter.find("\n}\n").unwrap()];
        assert!(setter.contains(".set_badge_label(") && setter.contains("map_err") && setter.contains("macdock::tile_label()"), "{setter}");
        // and the page-ready and the preferences hooks that make sure the badge is set once the window exists and when the setting changes
        let lib = include_str!("lib.rs");
        let ready = &lib[lib.find("fn frontend_ready(").unwrap()..];
        assert!(ready[..ready.find("\n}\n").unwrap()].contains("shell::update_badge("), "frontend_ready");
        let set = &lib[lib.find("fn set_setting(").unwrap()..];
        assert!(set[..set.find("\n}\n").unwrap()].contains("shell::update_badge("), "set_setting");
    }
}
