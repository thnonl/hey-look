//! Linux notifications with buttons (1.0.7 W5.4) and the check that makes "Send test" answer at once when no notification service exists (W5.6).
//!
//! A new-mail notification carries the mailbox's Buttons setting as notification actions when the service lists the `actions` capability (`GetCapabilities`); a click on the notification
//! body is the action `default`. The answers come as the signals `ActionInvoked` and `NotificationClosed` of `org.freedesktop.Notifications`: ONE listener thread for the whole run (not one
//! thread per notification) reads them and looks the notification id up in a small map (id -> thread, the keys that were offered), which forgets a notification when it is closed, after 24 hours
//! and beyond 200 entries. The rules (what is offered, what an answer means, what the map forgets, what "Send test" does when there is no service) are plain functions tested on every
//! system; the bus calls are in `bus` (Linux only).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The most notifications the map remembers, and for how long.
pub const MAX_TRACKED: usize = 200;
pub const MAX_AGE: Duration = Duration::from_secs(24 * 3600);

/// The action a click on the notification body sends (the Desktop Notifications Specification).
pub const DEFAULT_KEY: &str = "default";

/// The id of the notification server's capability for buttons.
const ACTIONS_CAP: &str = "actions";

/// Whether the server's `GetCapabilities` list has buttons.
pub fn has_actions(caps: &[String]) -> bool {
    caps.iter().any(|c| c == ACTIONS_CAP)
}

/// The `(key, label)` pairs sent with a notification: `default` first (labelled with `open_label`, which most services do not draw), then the buttons of the mailbox's setting in their order
/// (at most 3, each only when `label` knows it). Empty buttons give just `default`. `buttons` is already the cleaned list of the setting.
pub fn action_pairs(buttons: &[String], open_label: &str, label: impl Fn(&str) -> Option<&'static str>) -> Vec<(String, String)> {
    let mut out = vec![(DEFAULT_KEY.to_string(), open_label.to_string())];
    for b in buttons.iter().take(3) {
        if b == DEFAULT_KEY || out.iter().any(|(k, _)| k == b) {
            continue;
        }
        if let Some(l) = label(b) {
            out.push((b.clone(), l.to_string()));
        }
    }
    out
}

/// What the app does with an answer.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    /// the notification body was clicked: the main window shows this conversation (or just comes forward when it has none)
    Open { thread: String },
    /// a button: this key of the setting for this conversation
    Button { thread: String, key: String },
}

#[derive(Debug, Clone)]
struct Tracked {
    thread: String,
    keys: Vec<String>,
    at: Instant,
}

/// notification id -> what was offered. Pure (the clock is a parameter).
#[derive(Debug, Default)]
pub struct ActionMap {
    map: HashMap<u32, Tracked>,
}

impl ActionMap {
    /// Remember a notification that was just shown. Old entries (24 h) go first; beyond [`MAX_TRACKED`] the oldest go.
    pub fn insert(&mut self, id: u32, thread: &str, pairs: &[(String, String)], now: Instant) {
        self.forget_old(now);
        let keys = pairs.iter().map(|(k, _)| k.clone()).collect();
        self.map.insert(id, Tracked { thread: thread.to_string(), keys, at: now });
        while self.map.len() > MAX_TRACKED {
            let Some(oldest) = self.map.iter().min_by_key(|(_, t)| t.at).map(|(id, _)| *id) else { break };
            self.map.remove(&oldest);
        }
    }

    pub fn forget_old(&mut self, now: Instant) {
        self.map.retain(|_, t| now.saturating_duration_since(t.at) < MAX_AGE);
    }

    /// `ActionInvoked(id, key)`: what it means; `None` for a notification this app did not show, one that was forgotten, or a key that was not offered. The entry stays (a button click makes the
    /// service close the notification, and `NotificationClosed` forgets it; a service that keeps it open lets the person press again).
    pub fn invoked(&mut self, id: u32, key: &str, now: Instant) -> Option<Answer> {
        self.forget_old(now);
        let t = self.map.get(&id)?;
        if !t.keys.iter().any(|k| k == key) {
            return None;
        }
        if key == DEFAULT_KEY {
            return Some(Answer::Open { thread: t.thread.clone() });
        }
        Some(Answer::Button { thread: t.thread.clone(), key: key.to_string() })
    }

    /// `NotificationClosed(id, reason)`.
    pub fn closed(&mut self, id: u32) {
        self.map.remove(&id);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
}

/// The one map of the run.
pub fn tracked() -> &'static Mutex<ActionMap> {
    static MAP: OnceLock<Mutex<ActionMap>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// What "Send test" does, from the two answers of the bus about `org.freedesktop.Notifications` (W5.6, REQ-5.6.3).
#[derive(Debug, PartialEq, Eq)]
pub enum ServicePlan {
    /// a service runs: send, with the usual short wait
    Send,
    /// none runs but the bus can start one: send and wait for it (the existing 5 s limit)
    SendAndWait,
    /// none runs and none can be started: the error at once
    FailNow,
}

pub fn service_plan(has_owner: bool, activatable: bool) -> ServicePlan {
    if has_owner {
        ServicePlan::Send
    } else if activatable {
        ServicePlan::SendAndWait
    } else {
        ServicePlan::FailNow
    }
}

/// `notify_caps`: does the notification service of this system draw buttons? Windows always; macOS never (its notifications come from the notification plugin without buttons); Linux asks the
/// bus once per run (a failed or missing answer is not remembered, so the next call asks again). A debug build may force "no buttons" with `HEYLOOK_TEST_NOTIFY_NO_ACTIONS=1`.
pub fn actions_supported() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(target_os = "macos")]
    {
        false
    }
    #[cfg(target_os = "linux")]
    {
        if cfg!(debug_assertions) && std::env::var("HEYLOOK_TEST_NOTIFY_NO_ACTIONS").as_deref() == Ok("1") {
            return false;
        }
        static KNOWN: OnceLock<bool> = OnceLock::new();
        if let Some(k) = KNOWN.get() {
            return *k;
        }
        match bus::with_timeout(Duration::from_secs(3), bus::capabilities) {
            Some(Ok(caps)) => {
                let has = has_actions(&caps);
                crate::startup::line("notify", &format!("notification service capabilities: {}", caps.join(", ")));
                let _ = KNOWN.set(has);
                has
            }
            Some(Err(e)) => {
                crate::startup::line("notify", &format!("notification service: GetCapabilities failed: {e}"));
                false
            }
            None => {
                crate::startup::line("notify", "notification service: GetCapabilities got no answer in 3 s");
                false
            }
        }
    }
}

/// Linux: the plan for "Send test" from the bus (`None` = the bus itself cannot be reached, which is "no service" as well).
#[cfg(target_os = "linux")]
pub fn send_test_plan() -> ServicePlan {
    match bus::with_timeout(Duration::from_secs(3), bus::service_state) {
        Some(Ok((owner, activatable))) => service_plan(owner, activatable),
        Some(Err(e)) => {
            crate::startup::line("notify", &format!("notification service: the bus could not be asked: {e}"));
            ServicePlan::FailNow
        }
        // the bus did not answer in time: the old behaviour (send, wait up to 5 s)
        None => ServicePlan::SendAndWait,
    }
}

/// Linux: start the one listener of the run (idempotent). `on_answer(thread, answer)` runs on the listener thread.
#[cfg(target_os = "linux")]
pub fn ensure_listener(on_answer: impl Fn(Answer) + Send + 'static) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("notify-actions".into()).spawn(move || {
        // a bus that goes away (the session restarts a service, not the bus) ends the iterator: ask again, a few times, then give up for the run
        for attempt in 0..5 {
            match bus::listen(|id, event| match event {
                bus::Event::Invoked(key) => {
                    let answer = tracked().lock().unwrap_or_else(|p| p.into_inner()).invoked(id, &key, Instant::now());
                    if let Some(a) = answer {
                        on_answer(a);
                    }
                }
                bus::Event::Closed => tracked().lock().unwrap_or_else(|p| p.into_inner()).closed(id),
            }) {
                Ok(()) => {}
                Err(e) => crate::startup::line("notify", &format!("notification actions: the listener stopped ({e}), attempt {}", attempt + 1)),
            }
            std::thread::sleep(Duration::from_secs(10));
        }
    });
    if let Err(e) = spawned {
        crate::startup::line("notify", &format!("notification actions: no listener ({e})"));
        STARTED.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(target_os = "linux")]
mod bus {
    use std::time::Duration;
    use zbus::blocking::{Connection, Proxy};

    const SERVICE: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    pub enum Event {
        Invoked(String),
        Closed,
    }

    /// Run `f` on a thread of its own and wait at most `limit` for its answer (`None` = no answer; the thread ends when the bus finally answers).
    pub fn with_timeout<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(limit).ok()
    }

    pub fn capabilities() -> Result<Vec<String>, String> {
        let conn = Connection::session().map_err(|e| e.to_string())?;
        let proxy = Proxy::new(&conn, SERVICE, PATH, SERVICE).map_err(|e| e.to_string())?;
        proxy.call::<_, _, Vec<String>>("GetCapabilities", &()).map_err(|e| e.to_string())
    }

    /// (a service owns the name, the bus can start one)
    pub fn service_state() -> Result<(bool, bool), String> {
        let conn = Connection::session().map_err(|e| e.to_string())?;
        let bus = Proxy::new(&conn, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus").map_err(|e| e.to_string())?;
        let owner: bool = bus.call("NameHasOwner", &(SERVICE,)).map_err(|e| e.to_string())?;
        if owner {
            return Ok((true, false));
        }
        let names: Vec<String> = bus.call("ListActivatableNames", &()).map_err(|e| e.to_string())?;
        Ok((false, names.iter().any(|n| n == SERVICE)))
    }

    /// Blocks while the signals come; `Ok` when the stream ends, `Err` when it cannot be started.
    pub fn listen(on_event: impl Fn(u32, Event)) -> Result<(), String> {
        let conn = Connection::session().map_err(|e| e.to_string())?;
        let proxy = Proxy::new(&conn, SERVICE, PATH, SERVICE).map_err(|e| e.to_string())?;
        let signals = proxy.receive_all_signals().map_err(|e| e.to_string())?;
        for msg in signals {
            let header = msg.header();
            match header.member().map(|m| m.as_str()) {
                Some("ActionInvoked") => {
                    if let Ok((id, key)) = msg.body().deserialize::<(u32, String)>() {
                        on_event(id, Event::Invoked(key));
                    }
                }
                Some("NotificationClosed") => {
                    if let Ok((id, _reason)) = msg.body().deserialize::<(u32, u32)>() {
                        on_event(id, Event::Closed);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lab(k: &str) -> Option<&'static str> {
        match k {
            "archive" => Some("Archive"),
            "delete" => Some("Delete"),
            "read" => Some("Mark as read"),
            "flag" => Some("Flag"),
            "reply" => Some("Reply"),
            "snooze" => Some("Snooze"),
            _ => None,
        }
    }
    fn b(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_linux_notification_actions_follow_the_settings() {
        let p = action_pairs(&b(&["archive", "delete", "read"]), "Open", lab);
        assert_eq!(p, vec![("default".into(), "Open".into()), ("archive".into(), "Archive".into()), ("delete".into(), "Delete".into()), ("read".into(), "Mark as read".into())]);
        // other buttons, in the setting's order
        let p = action_pairs(&b(&["flag", "snooze", "reply"]), "Open", lab);
        assert_eq!(p.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["default", "flag", "snooze", "reply"]);
        // none, none, none: only the body click
        assert_eq!(action_pairs(&[], "Open", lab), vec![("default".into(), "Open".into())]);
        // at most 3 buttons, unknown keys and repeats dropped, `default` cannot be a button
        let p = action_pairs(&b(&["archive", "archive", "bogus", "default", "delete", "read", "flag"]), "Open", lab);
        assert_eq!(p.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["default", "archive", "delete"], "{p:?}");
        // the summary and the test notification: no buttons, the body click only
        assert_eq!(action_pairs(&[], "Open", lab).len(), 1);
    }

    #[test]
    fn the_service_lists_buttons_only_when_it_says_so() {
        assert!(has_actions(&b(&["body", "actions", "sound"])));
        assert!(!has_actions(&b(&["body", "sound"])));
        assert!(!has_actions(&[]));
    }

    #[test]
    fn an_answer_means_what_was_offered_and_nothing_else() {
        let t0 = Instant::now();
        let mut m = ActionMap::default();
        m.insert(7, "thread-a", &action_pairs(&b(&["archive", "read"]), "Open", lab), t0);
        assert_eq!(m.invoked(7, "default", t0), Some(Answer::Open { thread: "thread-a".into() }));
        assert_eq!(m.invoked(7, "archive", t0), Some(Answer::Button { thread: "thread-a".into(), key: "archive".into() }));
        assert_eq!(m.invoked(7, "delete", t0), None, "a button that was not offered");
        assert_eq!(m.invoked(8, "default", t0), None, "a notification of another app");
        // a notification without a conversation (the summary, the test): the body click only
        m.insert(9, "", &action_pairs(&[], "Open", lab), t0);
        assert_eq!(m.invoked(9, "default", t0), Some(Answer::Open { thread: String::new() }));
        assert_eq!(m.invoked(9, "archive", t0), None);
    }

    #[test]
    fn the_action_map_forgets_closed_and_old_notifications() {
        let t0 = Instant::now();
        let pairs = action_pairs(&b(&["archive"]), "Open", lab);
        let mut m = ActionMap::default();
        m.insert(1, "a", &pairs, t0);
        m.insert(2, "b", &pairs, t0);
        m.closed(1);
        assert_eq!(m.len(), 1);
        assert_eq!(m.invoked(1, "default", t0), None);
        m.closed(1); // twice: nothing
        // after 24 hours
        assert!(m.invoked(2, "default", t0 + MAX_AGE - Duration::from_secs(1)).is_some());
        assert_eq!(m.invoked(2, "default", t0 + MAX_AGE), None);
        assert_eq!(m.len(), 0);
        // at most 200: the oldest go
        let mut m = ActionMap::default();
        for i in 0..(MAX_TRACKED as u32 + 25) {
            m.insert(i, "t", &pairs, t0 + Duration::from_millis(i as u64));
        }
        assert_eq!(m.len(), MAX_TRACKED);
        assert_eq!(m.invoked(0, "default", t0 + Duration::from_secs(1)), None, "the oldest is gone");
        assert!(m.invoked(MAX_TRACKED as u32 + 24, "default", t0 + Duration::from_secs(1)).is_some());
    }

    #[test]
    fn send_test_fails_at_once_without_a_notification_service() {
        assert_eq!(service_plan(true, false), ServicePlan::Send);
        assert_eq!(service_plan(true, true), ServicePlan::Send);
        assert_eq!(service_plan(false, true), ServicePlan::SendAndWait, "startable but not running: the existing 5 s wait");
        assert_eq!(service_plan(false, false), ServicePlan::FailNow, "neither: the error at once");
    }

    /// One listener for the whole run, no thread per notification; the match is on the notification service's signals only.
    #[test]
    fn there_is_one_listener_thread_and_it_hears_only_the_notification_signals() {
        let src = crate::test_guard::non_test_code(include_str!("linuxnotify.rs"));
        assert_eq!(src.matches("std::thread::Builder::new().name(\"notify-actions\"").count(), 1);
        assert!(src.contains("STARTED.swap(true"), "started once");
        assert!(src.contains("receive_all_signals()") && src.contains("\"ActionInvoked\"") && src.contains("\"NotificationClosed\""));
        assert!(src.contains("const SERVICE: &str = \"org.freedesktop.Notifications\""));
        let shell = crate::test_guard::non_test_code(include_str!("shell.rs"));
        let toast = &shell[shell.find("fn toast_linux").unwrap()..];
        assert!(!toast.contains("wait_for_action"), "notify-rust's wait_for_action blocks one thread per notification");
    }
}
