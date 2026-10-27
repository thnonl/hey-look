//! What the app knows about the numbering of a server folder (1.0.7 W6.1).
//!
//! IMAP numbers the messages of a folder (UIDs) under a folder-wide value, the UIDVALIDITY. When the server renumbers a folder (a provider migration, the folder deleted and made
//! again by another program, a restore, a role that now points to another folder) the value changes and every UID the app stored names another message or none. The local row
//! `acc:inbox:57` then belongs to a message that is not at UID 57 any more, and a Delete of it would remove an unrelated message.
//!
//! The app keeps `(server folder name, UIDVALIDITY)` per account and role in the settings (`uidv:<account>:<role>`, like the `exhausted:` marks), written by every sync after
//! its SELECT. Writes on stored UIDs are checked against it (`mail::Expect`); a sync that sees another value reads the folder again from scratch. Pure helpers here, so the
//! decisions are tested without a server.
use crate::db::{err, R};
use rusqlite::Connection;
use std::sync::Mutex;

/// The numbering of one folder as it was recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    /// the server's name of the folder (the saved folder list's value for the role)
    pub name: String,
    pub validity: u32,
}

fn key(account_id: &str, role: &str) -> String {
    format!("uidv:{account_id}:{role}")
}

/// The recorded numbering of a folder; `None` before the first sync that recorded it (an install from before 1.0.7, a folder never synced).
pub fn get(c: &Connection, account_id: &str, role: &str) -> Option<State> {
    let v = crate::db::get_setting(c, &key(account_id, role))?;
    let (validity, name) = v.split_once('\t')?;
    Some(State { name: name.to_string(), validity: validity.parse().ok().filter(|v| *v != 0)? })
}

pub fn set(c: &Connection, account_id: &str, role: &str, name: &str, validity: u32) -> R<()> {
    crate::db::set_setting(c, &key(account_id, role), &format!("{validity}\t{name}"))
}

fn max_key(account_id: &str, role: &str) -> String {
    format!("maxuid:{account_id}:{role}")
}

/// The highest UID a sync has seen in a folder (0: none recorded). It is the "where did I stop" of the folder when its local rows are gone: an Inbox that was emptied by moving or
/// archiving everything (Inbox zero, Run now of a rule) is NOT a folder that was never synced, so the next sync reads only what is newer than this and the mail that arrived is
/// new mail (notified, and looked at by the rules). Without it the sync took the empty folder for a first sync and read the newest page as a taste (1.0.8, OPEN-1 of the rules QA).
pub fn max_uid(c: &Connection, account_id: &str, role: &str) -> u32 {
    crate::db::get_setting(c, &max_key(account_id, role)).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// A sync of this folder has finished and recorded where it stopped (also when the folder was empty: the value is then 0, which `max_uid` alone cannot tell from "never synced").
pub fn recorded(c: &Connection, account_id: &str, role: &str) -> bool {
    crate::db::get_setting(c, &max_key(account_id, role)).is_some()
}

/// Is this sync the first one of the folder, the one whose messages are only a taste and never new mail? Not when the folder has rows or a recorded highest UID, and not when
/// an earlier sync finished with the folder empty (a new account whose Inbox is empty: its first mail is new mail, 1.0.10); a renumbered folder is read like a first sync.
pub fn is_first_sync(max_uid: u32, recorded: bool, reset: bool) -> bool {
    reset || (max_uid == 0 && !recorded)
}

/// Record the highest UID seen. `reset`: the folder was renumbered, the old value means nothing and is replaced; otherwise it only grows. The first call for a folder always
/// writes (even 0), so that an empty folder counts as synced (`recorded`).
pub fn note_max_uid(c: &Connection, account_id: &str, role: &str, top: u32, reset: bool) -> R<()> {
    if reset || top > max_uid(c, account_id, role) || !recorded(c, account_id, role) {
        crate::db::set_setting(c, &max_key(account_id, role), &top.to_string())?;
    }
    Ok(())
}

/// What a sync knows about a folder before it asks the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Known {
    /// nothing recorded: the first sync of the folder, or an install from before 1.0.7
    Unknown,
    /// recorded under this value, for the same server folder
    Validity(u32),
    /// recorded for another server folder than the role names now: it counts as renumbered
    Renamed,
}

pub fn known(stored: Option<&State>, name: &str) -> Known {
    match stored {
        None => Known::Unknown,
        Some(s) if s.name == name => Known::Validity(s.validity),
        Some(_) => Known::Renamed,
    }
}

/// Has the folder been renumbered, given what was recorded and what the SELECT answered? A server that sends no UIDVALIDITY cannot be judged (no change is assumed).
pub fn renumbered(known: &Known, now: Option<u32>) -> bool {
    match (known, now) {
        (Known::Renamed, _) => true,
        (Known::Validity(was), Some(now)) => *was != now,
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Draft references of before a reset
//
// A draft is named by `m:<local id>` (account:drafts:UID) while it is open. After the folder was read again the same id can name another draft. The ids a reset dropped are
// kept with their Message-ID (drafts only, a small list), so a reference taken before the reset is not taken for the message that now has that id.

const RETIRED_MAX: usize = 300;

fn retired_key(account_id: &str) -> String {
    format!("uidv-retired:{account_id}")
}

/// Remember the dropped rows `(local id, Message-ID)` of a reset Drafts folder.
pub fn retire(c: &Connection, account_id: &str, rows: &[(String, Option<String>)]) -> R<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut all: Vec<(String, Option<String>)> =
        crate::db::get_setting(c, &retired_key(account_id)).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    all.retain(|(id, _)| !rows.iter().any(|(r, _)| r == id));
    all.extend(rows.iter().cloned());
    if all.len() > RETIRED_MAX {
        all.drain(..all.len() - RETIRED_MAX);
    }
    crate::db::set_setting(c, &retired_key(account_id), &serde_json::to_string(&all).map_err(err)?)
}

/// The Message-ID the local id named before a reset dropped it: `Some(mid)` (which may be `None`: no Message-ID) when the id was retired, `None` when it never was.
pub fn retired(c: &Connection, account_id: &str, local_id: &str) -> Option<Option<String>> {
    let all: Vec<(String, Option<String>)> = crate::db::get_setting(c, &retired_key(account_id)).and_then(|s| serde_json::from_str(&s).ok())?;
    all.into_iter().find(|(id, _)| id == local_id).map(|(_, mid)| mid)
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A sync that was asked for

static RESYNC: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// An action was refused because the folder changed on the server: the account is read again soon (`take_resync`, the one-second worker).
pub fn want_resync(account_id: &str) {
    push_once(&mut RESYNC.lock().unwrap_or_else(|p| p.into_inner()), account_id);
}

fn push_once(list: &mut Vec<String>, account_id: &str) {
    if !list.iter().any(|a| a == account_id) {
        list.push(account_id.to_string());
    }
}

pub fn take_resync() -> Vec<String> {
    std::mem::take(&mut *RESYNC.lock().unwrap_or_else(|p| p.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_was_recorded_decides_whether_a_folder_counts_as_renumbered() {
        let s = State { name: "INBOX".into(), validity: 7 };
        assert_eq!(known(None, "INBOX"), Known::Unknown);
        assert_eq!(known(Some(&s), "INBOX"), Known::Validity(7));
        assert_eq!(known(Some(&s), "INBOX.Old"), Known::Renamed);
        assert!(!renumbered(&Known::Unknown, Some(3)), "nothing recorded: nothing to compare");
        assert!(!renumbered(&Known::Validity(7), Some(7)));
        assert!(renumbered(&Known::Validity(7), Some(8)));
        assert!(!renumbered(&Known::Validity(7), None), "a server that sends no UIDVALIDITY cannot be judged");
        assert!(renumbered(&Known::Renamed, Some(7)), "a role that points to another server folder is a renumbered one");
    }

    #[test]
    fn the_numbering_is_recorded_per_account_and_role() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        assert_eq!(get(&c, "a", "inbox"), None);
        set(&c, "a", "inbox", "INBOX", 12).unwrap();
        set(&c, "a", "sent", "Sent Items", 3).unwrap();
        set(&c, "b", "inbox", "INBOX", 99).unwrap();
        assert_eq!(get(&c, "a", "inbox"), Some(State { name: "INBOX".into(), validity: 12 }));
        assert_eq!(get(&c, "a", "sent"), Some(State { name: "Sent Items".into(), validity: 3 }));
        assert_eq!(get(&c, "b", "inbox").map(|s| s.validity), Some(99));
        // a name with a tab or a colon survives (the value is split at the first tab only)
        set(&c, "a", "f:x", "INBOX/a:b", 5).unwrap();
        assert_eq!(get(&c, "a", "f:x").map(|s| s.name), Some("INBOX/a:b".to_string()));
    }

    #[test]
    fn retired_draft_ids_remember_their_message_id() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        assert_eq!(retired(&c, "a", "a:drafts:57"), None);
        retire(&c, "a", &[("a:drafts:57".into(), Some("<d1@x>".into())), ("a:drafts:58".into(), None)]).unwrap();
        assert_eq!(retired(&c, "a", "a:drafts:57"), Some(Some("<d1@x>".to_string())));
        assert_eq!(retired(&c, "a", "a:drafts:58"), Some(None));
        assert_eq!(retired(&c, "a", "a:drafts:59"), None);
        assert_eq!(retired(&c, "b", "a:drafts:57"), None, "per account");
        // a newer entry for the same id replaces the old one; the list is bounded
        retire(&c, "a", &[("a:drafts:57".into(), Some("<d9@x>".into()))]).unwrap();
        assert_eq!(retired(&c, "a", "a:drafts:57"), Some(Some("<d9@x>".to_string())));
        let many: Vec<(String, Option<String>)> = (0..RETIRED_MAX + 50).map(|i| (format!("a:drafts:{}", 1000 + i), None)).collect();
        retire(&c, "a", &many).unwrap();
        assert_eq!(retired(&c, "a", "a:drafts:57"), None, "the oldest went");
        assert!(retired(&c, "a", &format!("a:drafts:{}", 1000 + RETIRED_MAX + 49)).is_some());
    }

    #[test]
    fn a_refused_action_asks_for_one_sync_per_account() {
        let mut list = vec![];
        push_once(&mut list, "acct-x");
        push_once(&mut list, "acct-x");
        push_once(&mut list, "acct-y");
        assert_eq!(list, vec!["acct-x".to_string(), "acct-y".to_string()]);
    }
}
