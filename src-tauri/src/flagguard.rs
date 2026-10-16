//! F-16 / F-17: a sync reads the flags of the mail it already knows from the server and writes them into the local rows. A read /
//! unread / flag action does the opposite (the server first, the local row after). When the two overlap, the sync could carry a
//! flag it read BEFORE the action reached the server and write it AFTER the action stored its own: the row then showed the old state
//! (the mail "flipped back to unread") until the next sync. The actions note here which messages they are changing, and a sync skips
//! the flags of any message an action touched since the sync began reading (or is still touching).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// account id, folder role, UID
pub type Key = (String, String, u32);

#[derive(Default)]
struct State {
    epoch: u64,
    /// messages with an action under way (count: two actions may overlap)
    busy: HashMap<Key, u32>,
    /// epoch at which an action last finished with the message
    last: HashMap<Key, (u64, Instant)>,
}

#[derive(Default)]
pub struct FlagGuard(Mutex<State>);

/// How long a finished action is remembered (a sync that began earlier than this has long ended or timed out).
const REMEMBER: Duration = Duration::from_secs(600);

impl FlagGuard {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Take this before a sync starts reading flags from the server; pass it to `skip`.
    pub fn epoch(&self) -> u64 {
        self.state().epoch
    }

    /// The caller is about to change these messages' flags on the server and in the database; keep the returned value alive until
    /// both are done (it also ends on an error).
    pub fn writing(&self, keys: impl IntoIterator<Item = Key>) -> Writing<'_> {
        let keys: Vec<Key> = keys.into_iter().collect();
        let mut s = self.state();
        for k in &keys {
            *s.busy.entry(k.clone()).or_insert(0) += 1;
        }
        drop(s);
        Writing { guard: self, keys }
    }

    /// True when the flags a sync read after `started` (an `epoch()`) for this message must not be written: an action is changing it
    /// now, or finished since, so the server's answer may be older than the action.
    pub fn skip(&self, key: &Key, started: u64) -> bool {
        let s = self.state();
        s.busy.contains_key(key) || s.last.get(key).is_some_and(|(at, _)| *at > started)
    }
}

pub struct Writing<'a> {
    guard: &'a FlagGuard,
    keys: Vec<Key>,
}

impl Drop for Writing<'_> {
    fn drop(&mut self) {
        let mut s = self.guard.state();
        s.epoch += 1;
        let at = s.epoch;
        let now = Instant::now();
        for k in self.keys.drain(..) {
            if let Some(n) = s.busy.get_mut(&k) {
                *n -= 1;
                if *n == 0 {
                    s.busy.remove(&k);
                }
            }
            s.last.insert(k, (at, now));
        }
        if s.last.len() > 512 {
            s.last.retain(|_, (_, t)| now.duration_since(*t) < REMEMBER);
        }
    }
}

/// The process-wide guard.
pub static GUARD: std::sync::LazyLock<FlagGuard> = std::sync::LazyLock::new(FlagGuard::default);

#[cfg(test)]
mod tests {
    use super::*;

    fn k(uid: u32) -> Key {
        ("a1".into(), "inbox".into(), uid)
    }

    #[test]
    fn a_flag_read_before_the_action_began_is_skipped_while_it_runs_and_after() {
        let g = FlagGuard::default();
        let started = g.epoch();
        assert!(!g.skip(&k(7), started), "nothing touched it");
        let w = g.writing([k(7)]);
        assert!(g.skip(&k(7), started), "an action is under way");
        assert!(!g.skip(&k(8), started), "another message is free");
        drop(w);
        assert!(g.skip(&k(7), started), "the action finished after the sync began reading: its answer may be older");
        let later = g.epoch();
        assert!(!g.skip(&k(7), later), "a sync that began after the action read the new state");
    }

    #[test]
    fn two_overlapping_actions_keep_the_message_busy_until_both_end() {
        let g = FlagGuard::default();
        let a = g.writing([k(1)]);
        let b = g.writing([k(1)]);
        drop(a);
        let during = g.epoch();
        assert!(g.skip(&k(1), during), "still busy");
        drop(b);
        assert!(!g.skip(&k(1), g.epoch()));
    }
}
