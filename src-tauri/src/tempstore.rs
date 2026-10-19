//! Big strings that wait between two requests of the page (1.0.7 D-044, D-045): the data of a picture the page sent ahead of `save_draft` (draftupload.rs), the data of a
//! picture the page fetches after `draft_editor_parts` (draftopen.rs). One request of 25 MB holds the app's main thread for 0.3 to 0.5 s, 14 requests of 1.8 MB hold it for
//! 45 ms at a time, so the parts of a big draft go in pieces both ways and wait here for the request that needs them.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub struct Store {
    held: Mutex<Vec<(String, Instant, String)>>,
    ttl: Duration,
    /// what the entries that wait may hold in all, in characters (the oldest go first)
    max_chars: usize,
}

impl Store {
    pub const fn new(ttl: Duration, max_chars: usize) -> Store {
        Store { held: Mutex::new(Vec::new()), ttl, max_chars }
    }

    fn held(&self) -> MutexGuard<'_, Vec<(String, Instant, String)>> {
        self.held.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Keep `data` under `id` (a second `put` of the id replaces the first). Entries that waited longer than the time-to-live go, and so do the oldest ones when the store
    /// holds more than it may.
    pub fn put(&self, id: String, data: String) {
        let mut h = self.held();
        h.retain(|(i, at, _)| *i != id && at.elapsed() < self.ttl);
        h.push((id, Instant::now(), data));
        while h.len() > 1 && h.iter().map(|(_, _, d)| d.len()).sum::<usize>() > self.max_chars {
            h.remove(0);
        }
    }

    /// The data kept under `id`, once: it is gone from the store afterwards.
    pub fn take(&self, id: &str) -> Option<String> {
        let mut h = self.held();
        let at = h.iter().position(|(i, _, _)| i == id)?;
        let (_, since, data) = h.remove(at);
        (since.elapsed() < self.ttl).then_some(data)
    }

    #[cfg(test)]
    fn age(&self, id: &str, by: Duration) {
        if let Some(e) = self.held().iter_mut().find(|(i, _, _)| i == id) {
            e.1 = Instant::now() - by;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_is_taken_once_and_the_same_id_replaces() {
        let s = Store::new(Duration::from_secs(300), 1000);
        s.put("a".into(), "1".into());
        s.put("a".into(), "2".into());
        assert_eq!(s.take("a").as_deref(), Some("2"));
        assert_eq!(s.take("a"), None, "used up");
        assert_eq!(s.take("nothing"), None);
    }

    #[test]
    fn entries_that_wait_too_long_go() {
        let s = Store::new(Duration::from_secs(300), 1000);
        s.put("old".into(), "x".into());
        s.age("old", Duration::from_secs(301));
        assert_eq!(s.take("old"), None, "expired: not given out");
        s.put("old2".into(), "x".into());
        s.age("old2", Duration::from_secs(301));
        s.put("new".into(), "y".into()); // (a new entry clears out the expired ones)
        assert_eq!(s.take("old2"), None);
        assert_eq!(s.take("new").as_deref(), Some("y"));
    }

    #[test]
    fn the_oldest_go_when_the_store_holds_too_much() {
        let s = Store::new(Duration::from_secs(300), 10);
        s.put("a".into(), "xxxxxx".into());
        s.put("b".into(), "yyyyyy".into());
        assert_eq!(s.take("a"), None, "the oldest was dropped for the newer");
        assert_eq!(s.take("b").as_deref(), Some("yyyyyy"));
        // a single entry bigger than the limit is kept (the last one is never dropped)
        s.put("c".into(), "z".repeat(50));
        assert_eq!(s.take("c").map(|d| d.len()), Some(50));
    }
}
