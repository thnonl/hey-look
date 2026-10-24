//! Drag and drop between the windows of the app (W4.7): the registry behind the opaque token that a drag carries.
//!
//! A drag of a mail (a row of the list, the subject of a reader window) or of an attachment chip puts only a TOKEN in the drag data (a custom type, never
//! text, never the mail); the page that starts the drag tells this registry what the token stands for (`drag_begin`), and the page where the drag
//! ends asks for it (`drag_peek` while the pointer is over a target, `drag_take` on the drop). Nothing of the dragged mail or file travels through the
//! operating system's drag data, so it can neither leave the app nor be read by another program that is dropped on. An entry is taken once; it is dropped
//! when the drag ends (`drag_end`) or after [`LIFETIME`], and at most [`MAX_ENTRIES`] are kept (the oldest goes first).
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

type R<T> = Result<T, String>;

/// An entry that nobody took lives this long (spec REQ-4.7.5).
pub const LIFETIME: Duration = Duration::from_secs(60);
/// Entries kept at once (a drag is one gesture: more than a few means something is wrong).
pub const MAX_ENTRIES: usize = 4;
/// The largest payload, as JSON text: a file of about 40 MB as base64 fits; the attach rules of the target (size limit) judge the file itself.
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

struct Entry {
    payload: Value,
    at: Instant,
}

#[derive(Default)]
pub struct Registry {
    entries: HashMap<String, Entry>,
}

/// A token as the pages make it (a UUID): letters, digits and hyphens, at most 64.
pub fn valid_token(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The kinds of drag the app knows; anything else is refused.
fn known(payload: &Value) -> bool {
    matches!(payload.get("kind").and_then(Value::as_str), Some("mail" | "file"))
}

impl Registry {
    fn purge(&mut self, now: Instant) {
        self.entries.retain(|_, e| now.duration_since(e.at) < LIFETIME);
    }

    /// Remember what `token` stands for. A second `begin` with the same token replaces the first.
    pub fn begin(&mut self, token: &str, payload: Value, size: usize, now: Instant) -> R<()> {
        if !valid_token(token) {
            return Err("not a drag token".into());
        }
        if !known(&payload) {
            return Err("not a kind of drag".into());
        }
        if size > MAX_BYTES {
            return Err("this drag carries too much".into());
        }
        self.purge(now);
        while self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(token) {
            let oldest = self.entries.iter().min_by_key(|(_, e)| e.at).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.entries.remove(&k),
                None => break,
            };
        }
        self.entries.insert(token.to_string(), Entry { payload, at: now });
        Ok(())
    }

    /// What `token` stands for, once: the entry is gone after this.
    pub fn take(&mut self, token: &str, now: Instant) -> Option<Value> {
        self.purge(now);
        self.entries.remove(token).map(|e| e.payload)
    }

    /// What `token` stands for, left in place (the pointer is over a target; the drop may come).
    pub fn peek(&mut self, token: &str, now: Instant) -> Option<Value> {
        self.purge(now);
        self.entries.get(token).map(|e| e.payload.clone())
    }

    /// The drag ended (dropped, cancelled with Esc, or released outside): the entry goes.
    pub fn end(&mut self, token: &str) {
        self.entries.remove(token);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    static R: std::sync::OnceLock<Mutex<Registry>> = std::sync::OnceLock::new();
    R.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner())
}

/// A page starts a drag: `token` is what the drag data carries, `payload` what it stands for (`{ kind: "mail", items: [...] }` or `{ kind: "file", ... }`).
#[tauri::command]
pub fn drag_begin(token: String, payload: Value) -> R<()> {
    // (the size is judged on the text the page sent: a file is base64 in a string)
    let size = payload.to_string().len();
    registry().begin(&token, payload, size, Instant::now())
}

/// The pointer is over a target of this window: what is dragged, without taking it.
#[tauri::command]
pub fn drag_peek(token: String) -> Option<Value> {
    registry().peek(&token, Instant::now())
}

/// The drop: what was dragged, once. `None` after 60 s, after the drag ended, or for a token nobody began.
#[tauri::command]
pub fn drag_take(token: String) -> Option<Value> {
    registry().take(&token, Instant::now())
}

/// The drag ended (in the window that began it).
#[tauri::command]
pub fn drag_end(token: String) {
    registry().end(&token);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mail(n: u32) -> Value {
        json!({ "kind": "mail", "items": [{ "threadId": format!("t{n}"), "accountId": "a1", "folder": "inbox" }] })
    }

    #[test]
    fn a_drag_token_is_taken_once_and_expires() {
        let t0 = Instant::now();
        let mut r = Registry::default();
        r.begin("tok-1", mail(1), 10, t0).unwrap();
        // the pointer over a target: looked at, not taken
        assert_eq!(r.peek("tok-1", t0 + Duration::from_secs(1)), Some(mail(1)));
        assert_eq!(r.peek("tok-1", t0 + Duration::from_secs(2)), Some(mail(1)));
        // the drop takes it, once
        assert_eq!(r.take("tok-1", t0 + Duration::from_secs(3)), Some(mail(1)));
        assert_eq!(r.take("tok-1", t0 + Duration::from_secs(3)), None);
        assert_eq!(r.peek("tok-1", t0 + Duration::from_secs(3)), None);
        // 60 s and it is gone, for peek and take alike
        r.begin("tok-2", mail(2), 10, t0).unwrap();
        assert_eq!(r.peek("tok-2", t0 + LIFETIME - Duration::from_millis(1)), Some(mail(2)));
        assert_eq!(r.take("tok-2", t0 + LIFETIME), None);
        r.begin("tok-3", mail(3), 10, t0).unwrap();
        assert_eq!(r.peek("tok-3", t0 + LIFETIME + Duration::from_secs(1)), None);
        assert_eq!(r.len(), 0, "expired entries are purged");
        // a token nobody began, and the end of a drag
        assert_eq!(r.take("never", t0), None);
        r.begin("tok-4", mail(4), 10, t0).unwrap();
        r.end("tok-4");
        assert_eq!(r.take("tok-4", t0), None);
    }

    #[test]
    fn only_tokens_kinds_and_sizes_the_app_makes_are_taken() {
        let t0 = Instant::now();
        let mut r = Registry::default();
        for bad in ["", "a b", "../x", "a/b", &"a".repeat(65)] {
            assert!(r.begin(bad, mail(1), 10, t0).is_err(), "{bad:?}");
        }
        assert!(r.begin("ok", json!({ "kind": "text", "text": "x" }), 10, t0).is_err(), "text is not a kind of drag");
        assert!(r.begin("ok", json!("mail"), 10, t0).is_err());
        assert!(r.begin("ok", mail(1), MAX_BYTES + 1, t0).is_err(), "too much");
        assert!(r.begin("ok", json!({ "kind": "file", "name": "a.pdf" }), MAX_BYTES, t0).is_ok());
        assert!(valid_token("0f3c9d2e-1b7a-4c55-9e0a-5d6a7b8c9d0e"));
    }

    #[test]
    fn the_oldest_entry_goes_when_there_are_too_many() {
        let t0 = Instant::now();
        let mut r = Registry::default();
        for n in 0..MAX_ENTRIES as u32 + 2 {
            r.begin(&format!("t-{n}"), mail(n), 1, t0 + Duration::from_millis(n as u64)).unwrap();
        }
        assert_eq!(r.len(), MAX_ENTRIES);
        assert_eq!(r.peek("t-0", t0 + Duration::from_secs(1)), None);
        assert_eq!(r.peek("t-1", t0 + Duration::from_secs(1)), None);
        assert!(r.peek("t-5", t0 + Duration::from_secs(1)).is_some());
        // the same token again replaces its entry and costs no other
        r.begin("t-5", mail(99), 1, t0 + Duration::from_secs(2)).unwrap();
        assert_eq!(r.len(), MAX_ENTRIES);
        assert_eq!(r.peek("t-5", t0 + Duration::from_secs(2)), Some(mail(99)));
    }

    /// The four commands are in the three places, for the main window and the secondary windows (a drag starts and ends in any of them).
    #[test]
    fn the_drag_commands_are_in_the_three_places() {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let build = include_str!("../build.rs");
        for c in ["drag_begin", "drag_peek", "drag_take", "drag_end"] {
            assert!(lib.contains(&format!("drag::{c},")), "{c} in generate_handler!");
            assert!(build.contains(&format!("\"{c}\"")), "{c} in APP_COMMANDS");
            let perm = format!("\"allow-{}\"", c.replace('_', "-"));
            for cap in [include_str!("../capabilities/default.json"), include_str!("../capabilities/popout.json")] {
                assert!(cap.contains(&perm), "{perm}");
            }
        }
    }
}
