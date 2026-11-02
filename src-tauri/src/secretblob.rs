//! macOS: ONE Keychain item for all of the app's secrets.
//!
//! Why: on a Mac the app is signed with a self-signed certificate that has no Team ID. When the person answers a Keychain prompt with "Always Allow",
//! macOS adds the cdhash of THAT build to the item's partition list; every update is a new build with a new cdhash, so every item prompts once per
//! update, and the app keeps about eight items (one password per mailbox, the SMTP passwords, OAuth tokens, calendar sign-ins, the AI key ...).
//! One item holding all of them is one prompt per update.
//!
//! Shape: a JSON object `{ "<old entry user>": "<secret>", ... }` stored as the password of the item (service as before, account `secrets-v1`).
//! The old per-secret items are never deleted by the migration: a secret that is not in the blob is read from its old item (that read can
//! prompt, once per old item) and copied into the blob (write-through); the old item stays as the safety net. The app's own deletions (remove
//! an account, clear a secret) remove the secret from the blob AND delete the old item.
//!
//! This file is plain logic over the `Items` trait, so it is unit-tested on every platform; the macOS implementation of `Items` is in `identity.rs`
//! (the one place that builds keyring entries). Only macOS builds that use the system store (not a QA file-store kit) use it.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

/// Account of the one item.
pub const BLOB_ACCOUNT: &str = "secrets-v1";

/// The few operations on the system store the logic needs. `get_*` answer `Err(NoEntry)` / `Ok(None)` when there is nothing.
pub trait Items: Send + Sync {
    /// The blob item (`Ok(None)` when it does not exist yet).
    fn get_blob(&self) -> keyring::Result<Option<String>>;
    /// Update the blob item in place (create it when missing). Updating must keep the one item and its permissions.
    fn set_blob(&self, json: &str) -> keyring::Result<()>;
    /// The old per-secret item of `user`.
    fn get_old(&self, user: &str) -> keyring::Result<String>;
    fn set_old(&self, user: &str, value: &str) -> keyring::Result<()>;
    fn delete_old(&self, user: &str) -> keyring::Result<()>;
}

struct State {
    /// The blob was read (or found missing): never read again in this run.
    loaded: bool,
    /// The blob item exists but is not our JSON: nothing is overwritten until a fresh write.
    corrupt: bool,
    map: BTreeMap<String, String>,
    /// Secrets whose old item was asked and does not exist (this run): not asked again (an existence check of an unset secret costs one lookup, not one per call).
    absent: BTreeSet<String>,
}

pub struct Blobbed<I: Items> {
    items: I,
    state: Mutex<State>,
    note: fn(&str),
}

impl<I: Items> Blobbed<I> {
    pub fn new(items: I, note: fn(&str)) -> Self {
        Blobbed { items, state: Mutex::new(State { loaded: false, corrupt: false, map: BTreeMap::new(), absent: BTreeSet::new() }), note }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Read the blob once per run (under the lock: concurrent first readers wait for the one read, one prompt). An error (locked, denied,
    /// not answering) is returned and nothing is remembered, so the next call asks again.
    fn ensure_loaded(&self, st: &mut State) -> keyring::Result<()> {
        if st.loaded {
            return Ok(());
        }
        match self.items.get_blob()? {
            None => (self.note)("read the secrets item: not there yet"),
            Some(text) => match serde_json::from_str::<BTreeMap<String, String>>(&text) {
                Ok(m) => {
                    (self.note)(&format!("read the secrets item: {} secret(s)", m.len()));
                    st.map = m;
                }
                Err(_) => {
                    st.corrupt = true;
                    (self.note)("the secrets item is not readable as JSON; it is left as it is, the old items are used");
                }
            },
        }
        st.loaded = true;
        Ok(())
    }

    fn persist(&self, st: &State) -> keyring::Result<()> {
        let json = serde_json::to_string(&st.map).map_err(|e| keyring::Error::PlatformFailure(Box::new(e)))?;
        self.items.set_blob(&json)
    }

    pub fn get(&self, user: &str) -> keyring::Result<String> {
        let mut st = self.lock();
        self.ensure_loaded(&mut st)?;
        if let Some(v) = st.map.get(user) {
            return Ok(v.clone());
        }
        if st.absent.contains(user) {
            return Err(keyring::Error::NoEntry);
        }
        // not in the blob: the old item (may prompt once), copied into the blob; the old item stays
        let v = match self.items.get_old(user) {
            Ok(v) => v,
            Err(keyring::Error::NoEntry) => {
                st.absent.insert(user.to_string());
                (self.note)(&format!("{user}: no secret (old item asked once)"));
                return Err(keyring::Error::NoEntry);
            }
            Err(e) => return Err(e),
        };
        (self.note)(&format!("{user}: read from its old item, copied into the secrets item"));
        st.map.insert(user.to_string(), v.clone());
        if !st.corrupt {
            if let Err(e) = self.persist(&st) {
                (self.note)(&format!("copying a secret into the secrets item failed ({e}); the old item stays"));
            }
        }
        Ok(v)
    }

    pub fn set(&self, user: &str, value: &str) -> keyring::Result<()> {
        let mut st = self.lock();
        if let Err(e) = self.ensure_loaded(&mut st) {
            // the blob cannot be read (locked, denied): keep the secret in its own item, as before, rather than lose it
            return self.items.set_old(user, value).map_err(|_| e);
        }
        st.map.insert(user.to_string(), value.to_string());
        st.absent.remove(user);
        let was_corrupt = st.corrupt;
        match self.persist(&st) {
            Ok(()) => {
                st.corrupt = false; // a fresh write replaced the unreadable text
                if was_corrupt {
                    (self.note)("the unreadable secrets item was replaced by a fresh write");
                }
                Ok(())
            }
            Err(e) => {
                (self.note)(&format!("saving into the secrets item failed ({e}); saved as its own item"));
                self.items.set_old(user, value).map_err(|_| e)
            }
        }
    }

    pub fn delete(&self, user: &str) -> keyring::Result<()> {
        let mut st = self.lock();
        let loaded = self.ensure_loaded(&mut st).is_ok();
        let in_blob = loaded && st.map.remove(user).is_some();
        st.absent.insert(user.to_string());
        if in_blob && !st.corrupt {
            if let Err(e) = self.persist(&st) {
                (self.note)(&format!("removing a secret from the secrets item failed ({e})"));
            }
        }
        match self.items.delete_old(user) {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) if in_blob => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Default)]
    struct Mem {
        blob: Mutex<Option<String>>,
        old: Mutex<HashMap<String, String>>,
        blob_reads: AtomicUsize,
        blob_writes: AtomicUsize,
        old_reads: AtomicUsize,
        fail_blob_read: Mutex<bool>,
        fail_blob_write: Mutex<bool>,
        delay_ms: u64,
    }
    fn denied() -> keyring::Error {
        keyring::Error::NoStorageAccess("denied".into())
    }
    impl Items for Arc<Mem> {
        fn get_blob(&self) -> keyring::Result<Option<String>> {
            self.blob_reads.fetch_add(1, Ordering::SeqCst);
            if self.delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
            }
            if *self.fail_blob_read.lock().unwrap() {
                return Err(denied());
            }
            Ok(self.blob.lock().unwrap().clone())
        }
        fn set_blob(&self, json: &str) -> keyring::Result<()> {
            if *self.fail_blob_write.lock().unwrap() {
                return Err(denied());
            }
            self.blob_writes.fetch_add(1, Ordering::SeqCst);
            *self.blob.lock().unwrap() = Some(json.to_string());
            Ok(())
        }
        fn get_old(&self, user: &str) -> keyring::Result<String> {
            self.old_reads.fetch_add(1, Ordering::SeqCst);
            self.old.lock().unwrap().get(user).cloned().ok_or(keyring::Error::NoEntry)
        }
        fn set_old(&self, user: &str, value: &str) -> keyring::Result<()> {
            self.old.lock().unwrap().insert(user.to_string(), value.to_string());
            Ok(())
        }
        fn delete_old(&self, user: &str) -> keyring::Result<()> {
            self.old.lock().unwrap().remove(user).map(|_| ()).ok_or(keyring::Error::NoEntry)
        }
    }
    fn store(mem: &Arc<Mem>) -> Blobbed<Arc<Mem>> {
        Blobbed::new(mem.clone(), |_| {})
    }
    fn with_old(pairs: &[(&str, &str)]) -> Arc<Mem> {
        let m = Arc::new(Mem::default());
        for (k, v) in pairs {
            m.old.lock().unwrap().insert(k.to_string(), v.to_string());
        }
        m
    }
    fn blob_map(m: &Arc<Mem>) -> BTreeMap<String, String> {
        serde_json::from_str(m.blob.lock().unwrap().as_ref().expect("a blob")).unwrap()
    }

    #[test]
    fn a_secret_of_an_old_item_is_copied_into_the_blob_and_the_old_item_stays() {
        let m = with_old(&[("acc1", "pw1"), ("acc2", "pw2")]);
        let s = store(&m);
        assert_eq!(s.get("acc1").unwrap(), "pw1");
        assert_eq!(blob_map(&m).get("acc1").map(String::as_str), Some("pw1"), "write-through");
        assert!(m.old.lock().unwrap().contains_key("acc1"), "the old item is the safety net: not deleted");
        // the second read comes from memory: the old item is not asked again
        let reads = m.old_reads.load(Ordering::SeqCst);
        assert_eq!(s.get("acc1").unwrap(), "pw1");
        assert_eq!(m.old_reads.load(Ordering::SeqCst), reads);
        assert_eq!(s.get("acc2").unwrap(), "pw2");
        assert_eq!(blob_map(&m).len(), 2);
    }

    #[test]
    fn the_blob_is_read_once_per_run_even_by_concurrent_first_readers() {
        let m = Arc::new(Mem { delay_ms: 50, ..Default::default() });
        *m.blob.lock().unwrap() = Some(r#"{"a":"1","b":"2","c":"3"}"#.into());
        let s = Arc::new(store(&m));
        let hs: Vec<_> = ["a", "b", "c", "a", "b", "c"].into_iter().map(|k| { let s = s.clone(); std::thread::spawn(move || s.get(k).unwrap()) }).collect();
        let got: Vec<String> = hs.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(got, ["1", "2", "3", "1", "2", "3"]);
        assert_eq!(m.blob_reads.load(Ordering::SeqCst), 1, "one read of the item = one prompt");
        assert_eq!(m.old_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_existence_check_of_a_secret_in_the_blob_reads_no_old_item_and_the_ai_key_after_migration_reads_none() {
        let m = with_old(&[("secret:ai_key", "k"), ("acc1", "pw1")]);
        let s = store(&m);
        assert_eq!(s.get("secret:ai_key").unwrap(), "k"); // first run after the update: the old item is read once and copied
        assert_eq!(m.old_reads.load(Ordering::SeqCst), 1);
        // the next runs: a fresh store over the same items (a restart), the Settings check and the send path
        let s2 = store(&m);
        let before = m.old_reads.load(Ordering::SeqCst);
        assert!(s2.get("secret:ai_key").is_ok(), "is the key set?");
        assert!(s2.get("secret:ai_key").is_ok(), "the key itself");
        assert_eq!(m.old_reads.load(Ordering::SeqCst), before, "no old item is touched once the secret is in the blob");
        assert_eq!(m.blob_reads.load(Ordering::SeqCst), 2, "one blob read per run");
    }

    #[test]
    fn a_secret_that_is_not_set_asks_its_old_item_once_per_run() {
        let m = with_old(&[]);
        let s = store(&m);
        for _ in 0..5 {
            assert!(matches!(s.get("acc1:smtp"), Err(keyring::Error::NoEntry)));
        }
        assert_eq!(m.old_reads.load(Ordering::SeqCst), 1);
        s.set("acc1:smtp", "x").unwrap();
        assert_eq!(s.get("acc1:smtp").unwrap(), "x", "a later set is seen");
    }

    #[test]
    fn a_secret_that_exists_nowhere_is_no_entry_and_nothing_is_written() {
        let m = with_old(&[]);
        let s = store(&m);
        assert!(matches!(s.get("nope"), Err(keyring::Error::NoEntry)));
        assert_eq!(m.blob_writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn set_updates_the_one_blob_and_does_not_make_old_items() {
        let m = with_old(&[]);
        let s = store(&m);
        s.set("acc1", "pw1").unwrap();
        s.set("acc2", "pw2").unwrap();
        s.set("acc1", "pw1b").unwrap();
        assert_eq!(blob_map(&m).get("acc1").map(String::as_str), Some("pw1b"));
        assert_eq!(blob_map(&m).len(), 2);
        assert!(m.old.lock().unwrap().is_empty(), "no per-secret item is created");
        // a new run (fresh store over the same items) reads them back with one blob read
        let s2 = store(&m);
        assert_eq!(s2.get("acc2").unwrap(), "pw2");
    }

    #[test]
    fn a_failing_blob_write_saves_the_secret_as_its_own_item() {
        let m = with_old(&[]);
        let s = store(&m);
        *m.fail_blob_write.lock().unwrap() = true;
        s.set("acc1", "pw1").unwrap();
        assert_eq!(m.old.lock().unwrap().get("acc1").map(String::as_str), Some("pw1"), "never lost");
        // and a later run finds it through the old-item fallback
        *m.fail_blob_write.lock().unwrap() = false;
        let s2 = store(&m);
        assert_eq!(s2.get("acc1").unwrap(), "pw1");
    }

    #[test]
    fn a_blob_that_cannot_be_read_keeps_the_error_for_reads_and_saves_writes_as_old_items() {
        let m = with_old(&[("acc1", "pw1")]);
        *m.fail_blob_read.lock().unwrap() = true;
        let s = store(&m);
        assert!(matches!(s.get("acc1"), Err(keyring::Error::NoStorageAccess(_))), "denied / locked: the same error as before");
        s.set("acc2", "pw2").unwrap();
        assert_eq!(m.old.lock().unwrap().get("acc2").map(String::as_str), Some("pw2"));
        // the person answers later: the next call asks again and works
        *m.fail_blob_read.lock().unwrap() = false;
        assert_eq!(s.get("acc1").unwrap(), "pw1");
    }

    #[test]
    fn a_corrupt_blob_is_not_overwritten_by_reads_and_old_items_still_work() {
        let m = with_old(&[("acc1", "pw1")]);
        *m.blob.lock().unwrap() = Some("this is not json {".into());
        let s = store(&m);
        assert_eq!(s.get("acc1").unwrap(), "pw1", "fallback to the old item");
        assert_eq!(m.blob.lock().unwrap().as_deref(), Some("this is not json {"), "a read does not overwrite");
        assert_eq!(m.blob_writes.load(Ordering::SeqCst), 0);
        // a fresh write replaces it
        s.set("acc3", "pw3").unwrap();
        assert_eq!(blob_map(&m).get("acc3").map(String::as_str), Some("pw3"));
        assert!(m.old.lock().unwrap().contains_key("acc1"), "other secrets are still in their old items");
        assert_eq!(s.get("acc1").unwrap(), "pw1");
    }

    #[test]
    fn delete_removes_the_blob_entry_and_the_old_item() {
        let m = with_old(&[("acc1", "pw1"), ("acc2", "pw2")]);
        let s = store(&m);
        assert_eq!(s.get("acc1").unwrap(), "pw1");
        assert_eq!(s.get("acc2").unwrap(), "pw2");
        s.delete("acc1").unwrap();
        assert!(!m.old.lock().unwrap().contains_key("acc1"));
        assert!(!blob_map(&m).contains_key("acc1"));
        assert!(blob_map(&m).contains_key("acc2"));
        assert!(matches!(s.get("acc1"), Err(keyring::Error::NoEntry)));
        // only in the blob (a new install): no old item, still Ok
        s.set("acc9", "x").unwrap();
        s.delete("acc9").unwrap();
        // nowhere: NoEntry, like the old delete
        assert!(matches!(s.delete("ghost"), Err(keyring::Error::NoEntry)));
    }

    #[test]
    fn a_failing_blob_write_during_delete_does_not_resurrect_the_secret_in_this_run() {
        let m = with_old(&[("acc1", "pw1")]);
        let s = store(&m);
        s.get("acc1").unwrap();
        *m.fail_blob_write.lock().unwrap() = true;
        s.delete("acc1").unwrap();
        assert!(matches!(s.get("acc1"), Err(keyring::Error::NoEntry)));
    }
}
