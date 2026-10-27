//! QA-only credential store (cargo feature `qa-secrets`, never on in a release build, see scripts/test-qa-secrets-off.mjs): the passwords, OAuth tokens and
//! the AI key of a QA copy live in a JSON file in its data folder (`qa-secrets.json`, mode 0600 on Unix) instead of the system store (macOS Keychain, Windows
//! Credential Manager, Linux Secret Service), so a person who tests the app is not asked for the system password on every new account.
//! The ONE switch is `identity::entry_in` (`identity.rs`): nothing else in the app knows which store is in use.
//!
//! The module is also compiled for the unit tests of the file store, with or without the feature.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// File name in the data folder.
pub const FILE_NAME: &str = "qa-secrets.json";

/// One key per (service, user) pair; the separator cannot occur in either part.
fn key(service: &str, user: &str) -> String {
    format!("{service}\u{1}{user}")
}

/// A JSON file of secrets. Every call reads the file again and writes it whole, so two copies of the app that share a folder do not lose each other's entries.
pub struct FileStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        FileStore { path, lock: Mutex::new(()) }
    }

    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn write(&self, map: &BTreeMap<String, String>) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        write_private(&tmp, serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".into()).as_bytes())?;
        std::fs::rename(&tmp, &self.path)
    }

    /// The stored value, or None (no entry).
    pub fn get(&self, service: &str, user: &str) -> Option<String> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        self.read().get(&key(service, user)).cloned()
    }

    pub fn set(&self, service: &str, user: &str, value: &str) -> std::io::Result<()> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut map = self.read();
        map.insert(key(service, user), value.to_string());
        self.write(&map)
    }

    /// Whether an entry was there.
    pub fn delete(&self, service: &str, user: &str) -> std::io::Result<bool> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut map = self.read();
        let had = map.remove(&key(service, user)).is_some();
        if had {
            self.write(&map)?;
        }
        Ok(had)
    }
}

/// Writes `bytes` to `path`, readable by the owner only on Unix (created with mode 0600).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("heylook-qasecrets-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn set_get_delete_and_the_file_survives_a_new_store() {
        let d = dir("basic");
        let p = d.join(FILE_NAME);
        let _ = std::fs::remove_file(&p);
        let s = FileStore::new(p.clone());
        assert_eq!(s.get("svc", "a1"), None);
        s.set("svc", "a1", "pw one").unwrap();
        s.set("svc", "a1:smtp", "pw two").unwrap();
        s.set("other", "a1", "pw three").unwrap();
        assert_eq!(s.get("svc", "a1").as_deref(), Some("pw one"));
        assert_eq!(s.get("other", "a1").as_deref(), Some("pw three"), "per service");
        // a second store on the same file (a restart) sees the same values
        let again = FileStore::new(p.clone());
        assert_eq!(again.get("svc", "a1:smtp").as_deref(), Some("pw two"));
        assert!(s.delete("svc", "a1").unwrap());
        assert!(!s.delete("svc", "a1").unwrap(), "already gone");
        assert_eq!(again.get("svc", "a1"), None);
        assert_eq!(again.get("other", "a1").as_deref(), Some("pw three"));
        s.set("other", "a1", "new").unwrap();
        assert_eq!(again.get("other", "a1").as_deref(), Some("new"));
    }

    #[test]
    fn a_missing_or_broken_file_is_an_empty_store_and_text_is_kept_exactly() {
        let d = dir("broken");
        let p = d.join(FILE_NAME);
        std::fs::write(&p, "not json {").unwrap();
        let s = FileStore::new(p.clone());
        assert_eq!(s.get("svc", "x"), None);
        let odd = "pässwörd \"quoted\" \\ back\nline 日本語 🔑";
        s.set("svc", "x", odd).unwrap();
        assert_eq!(FileStore::new(p).get("svc", "x").as_deref(), Some(odd));
        let none = FileStore::new(d.join("no-such-folder").join(FILE_NAME));
        assert_eq!(none.get("svc", "x"), None);
        none.set("svc", "x", "made the folder").unwrap();
        assert_eq!(none.get("svc", "x").as_deref(), Some("made the folder"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("mode");
        let p = d.join(FILE_NAME);
        let _ = std::fs::remove_file(&p);
        let s = FileStore::new(p.clone());
        s.set("svc", "x", "secret").unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode {mode:o}");
        s.set("svc", "y", "more").unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
