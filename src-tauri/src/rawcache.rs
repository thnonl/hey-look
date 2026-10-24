//! Raw messages fetched from the server on demand (a picture that was too big to embed at sync time, an attachment), kept
//! in memory for the session so the second click is instant instead of a new connection and a new download.
//!
//! Bounded: at most `MAX_ENTRIES` messages and `MAX_BYTES` in total, the least recently used go first, and a message that
//! alone would take more than half the budget is not kept. Only the message as the server stores it is cached (for PGP mail
//! that is the ciphertext); decrypted content never enters this cache.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

pub const MAX_ENTRIES: usize = 8;
pub const MAX_BYTES: usize = 48 * 1024 * 1024;


pub struct RawCache {
    /// least recently used first
    items: VecDeque<(String, Arc<Vec<u8>>)>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}

impl RawCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        RawCache { items: VecDeque::new(), bytes: 0, max_entries, max_bytes }
    }

    pub fn get(&mut self, id: &str) -> Option<Arc<Vec<u8>>> {
        let i = self.items.iter().position(|(k, _)| k == id)?;
        let item = self.items.remove(i)?;
        let v = item.1.clone();
        self.items.push_back(item);
        Some(v)
    }

    pub fn put(&mut self, id: &str, raw: Arc<Vec<u8>>) {
        self.remove(id);
        if raw.len() > self.max_bytes / 2 {
            return;
        }
        self.bytes += raw.len();
        self.items.push_back((id.to_string(), raw));
        while self.items.len() > self.max_entries || self.bytes > self.max_bytes {
            match self.items.pop_front() {
                Some((_, v)) => self.bytes -= v.len(),
                None => break,
            }
        }
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(i) = self.items.iter().position(|(k, _)| k == id) {
            if let Some((_, v)) = self.items.remove(i) {
                self.bytes -= v.len();
            }
        }
    }

    /// Drop every message whose id starts with `prefix` (a folder the server renumbered: its ids name other messages now, W6.1).
    pub fn remove_prefix(&mut self, prefix: &str) {
        let bytes = &mut self.bytes;
        self.items.retain(|(k, v)| {
            let keep = !k.starts_with(prefix);
            if !keep {
                *bytes -= v.len();
            }
            keep
        });
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

static CACHE: Mutex<Option<RawCache>> = Mutex::new(None);
static FETCHING: Mutex<Option<HashMap<String, Arc<Mutex<()>>>>> = Mutex::new(None);

fn with_cache<T>(f: impl FnOnce(&mut RawCache) -> T) -> T {
    let mut g = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    f(g.get_or_insert_with(|| RawCache::new(MAX_ENTRIES, MAX_BYTES)))
}

pub fn get(id: &str) -> Option<Arc<Vec<u8>>> {
    with_cache(|c| c.get(id))
}

pub fn put(id: &str, raw: Arc<Vec<u8>>) {
    with_cache(|c| c.put(id, raw))
}

/// Drop a message that is no longer stored locally (pruned by the download cap).
pub fn forget(id: &str) {
    with_cache(|c| c.remove(id))
}

/// Drop every cached message of a folder (ids are `<account>:<role>:<uid>`) after the server renumbered it.
pub fn forget_prefix(prefix: &str) {
    with_cache(|c| c.remove_prefix(prefix))
}

/// Fetch `id` once: callers asking for the same message at the same time wait for the first download and then find it in
/// the cache (a message with several pictures to load would otherwise download itself once per picture).
pub fn get_or_fetch<E>(id: &str, fetch: impl FnOnce() -> Result<Vec<u8>, E>) -> Result<Arc<Vec<u8>>, E> {
    if let Some(v) = get(id) {
        return Ok(v);
    }
    let gate = {
        let mut g = FETCHING.lock().unwrap_or_else(|p| p.into_inner());
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() > 64 {
            m.retain(|_, v| Arc::strong_count(v) > 1);
        }
        m.entry(id.to_string()).or_default().clone()
    };
    let _one_at_a_time = gate.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(v) = get(id) {
        return Ok(v);
    }
    let raw = Arc::new(fetch()?);
    put(id, raw.clone());
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(n: usize) -> Arc<Vec<u8>> {
        Arc::new(vec![1u8; n])
    }

    #[test]
    fn keeps_recent_messages_and_stays_within_both_bounds() {
        let mut c = RawCache::new(3, 100);
        for i in 0..5 {
            c.put(&format!("m{i}"), blob(10));
        }
        assert_eq!(c.len(), 3, "entry bound");
        assert!(c.get("m0").is_none() && c.get("m1").is_none());
        assert!(c.get("m4").is_some());
        // the byte bound: 40 + 40 fits, a third 40 pushes the oldest out
        let mut c = RawCache::new(10, 100);
        c.put("a", blob(40));
        c.put("b", blob(40));
        c.put("c", blob(40));
        assert!(c.bytes() <= 100);
        assert!(c.get("a").is_none() && c.get("b").is_some() && c.get("c").is_some());
        // a message over half the budget is never kept
        c.put("huge", blob(51));
        assert!(c.get("huge").is_none());
        assert!(c.bytes() <= 100);
    }

    #[test]
    fn a_hit_makes_the_message_recent_and_replacing_does_not_double_count() {
        let mut c = RawCache::new(2, 1000);
        c.put("a", blob(10));
        c.put("b", blob(10));
        assert!(c.get("a").is_some()); // a is now the most recent
        c.put("c", blob(10));
        assert!(c.get("b").is_none(), "b was the least recently used");
        assert!(c.get("a").is_some());
        c.put("a", blob(30));
        assert_eq!(c.bytes(), 40);
        c.remove("a");
        assert_eq!(c.bytes(), 10);
    }

    #[test]
    fn second_load_does_not_fetch_again_and_concurrent_loads_share_one_download() {
        let id = "test-single-flight";
        forget(id);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = vec![];
        for _ in 0..4 {
            let calls = calls.clone();
            handles.push(std::thread::spawn(move || {
                get_or_fetch::<String>(id, || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    Ok(vec![9u8; 1000])
                })
                .unwrap()
                .len()
            }));
        }
        for h in handles {
            assert_eq!(h.join().unwrap(), 1000);
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "one download for four callers");
        // a later call is served from memory
        let again = get_or_fetch::<String>(id, || panic!("must not fetch again")).unwrap();
        assert_eq!(again.len(), 1000);
        // a failed fetch is not cached
        let bad = "test-failing-fetch";
        assert!(get_or_fetch::<String>(bad, || Err("offline".into())).is_err());
        assert_eq!(get_or_fetch::<String>(bad, || Ok(vec![1, 2, 3])).unwrap().len(), 3);
        forget(id);
        forget(bad);
    }
}
