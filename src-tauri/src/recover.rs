//! Crash recovery for the message being written (QA round 17 BUG-02).
//!
//! The text of a message that is being written lived only in the window: a kill, a crash or a power cut lost everything typed since the
//! last Save draft. Compose now writes a snapshot of itself every few seconds (when something changed) and removes it as soon as the message
//! is sent, discarded or saved; whatever is still here at the next start is saved as a real draft (1.0.6: no question any more, the interface
//! tells the person with a toast) and the snapshot goes once the draft is confirmed on the server. When that cannot be done the snapshot stays
//! and the message is kept on this computer.
//!
//! A snapshot is one row of `compose_recovery` (the form of the message, opaque JSON from the interface) plus its attachments in
//! `compose_recovery_files` (the bytes, not base64). One transaction writes both, so a kill in the middle leaves the previous snapshot, never a
//! half-written one. The rows belong to an account: they go with it (`db::remove_account`, `db::prune_orphans`) and are only offered for
//! accounts that exist.

use crate::db::{err, R};
use crate::smtp::Att;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// What the interface hands over: `files` is `None` when the attachments are the same as in the previous snapshot of this message (they
/// are not sent again), `Some` (possibly empty) when they changed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapIn {
    pub id: String,
    pub account_id: String,
    pub subject: String,
    /// the first words of the text, for the question at the next start
    pub preview: String,
    /// the form of the message as JSON (recipients, body, security switches ...): only parsed to check that it is an object
    pub payload: String,
    pub files: Option<Vec<Att>>,
}

/// A snapshot as the question at the next start shows it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    pub account_id: String,
    pub saved_at: i64,
    pub subject: String,
    pub preview: String,
    pub files: usize,
}

/// A whole snapshot, for Restore.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub id: String,
    pub account_id: String,
    pub saved_at: i64,
    pub payload: String,
    pub files: Vec<Att>,
}

/// A bound on what is kept per message (the message itself may hold 25 MB of attachments, see Compose).
const MAX_PAYLOAD: usize = 32 * 1024 * 1024;

pub fn create_tables(c: &Connection) -> R<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS compose_recovery(
           id TEXT PRIMARY KEY, account_id TEXT NOT NULL, saved_at INTEGER NOT NULL,
           subject TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS compose_recovery_files(
           recovery_id TEXT NOT NULL, pos INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL,
           PRIMARY KEY(recovery_id, pos)
         );",
    )
    .map_err(err)
}

/// Rows of removed accounts, and files of removed rows.
pub fn prune(c: &Connection) -> R<usize> {
    let mut n = c.execute("DELETE FROM compose_recovery WHERE account_id NOT IN (SELECT id FROM accounts)", []).map_err(err)?;
    if n > 0 {
        // nothing to save them to: the person removed the mailbox (or an older version left them behind)
        crate::startup::line("recovery", &format!("{n} snapshot(s) of an account that no longer exists dropped"));
    }
    n += c.execute("DELETE FROM compose_recovery_files WHERE recovery_id NOT IN (SELECT id FROM compose_recovery)", []).map_err(err)?;
    Ok(n)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Write (or replace) the snapshot of one message, atomically.
pub fn save(c: &Connection, s: &SnapIn, now: i64) -> R<()> {
    if !valid_id(&s.id) {
        return Err("bad recovery id".into());
    }
    if s.payload.len() > MAX_PAYLOAD {
        return Err("the message is too large to keep a snapshot of".into());
    }
    if !serde_json::from_str::<serde_json::Value>(&s.payload).map(|v| v.is_object()).unwrap_or(false) {
        return Err("bad snapshot".into());
    }
    // a snapshot is only kept for an account that exists (it would never be offered, and it is somebody's text)
    let known: Option<i64> = c.query_row("SELECT 1 FROM accounts WHERE id=?1", [&s.account_id], |r| r.get(0)).optional().map_err(err)?;
    if known.is_none() {
        return Err("unknown account".into());
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    tx.execute(
        "INSERT INTO compose_recovery(id,account_id,saved_at,subject,preview,payload) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, saved_at=excluded.saved_at, subject=excluded.subject, preview=excluded.preview, payload=excluded.payload",
        params![s.id, s.account_id, now, s.subject, s.preview, s.payload],
    )
    .map_err(err)?;
    if let Some(files) = &s.files {
        tx.execute("DELETE FROM compose_recovery_files WHERE recovery_id=?1", [&s.id]).map_err(err)?;
        for (i, f) in files.iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD.decode(&f.data_base64).map_err(err)?;
            tx.execute(
                "INSERT INTO compose_recovery_files(recovery_id,pos,name,mime,data) VALUES(?1,?2,?3,?4,?5)",
                params![s.id, i as i64, f.filename, f.mime, bytes],
            )
            .map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

/// The message was sent, discarded or saved: nothing to recover. Not an error when there is nothing. Returns how many snapshots were removed
/// (0 or 1), so the log can say whether a snapshot was really there.
pub fn clear(c: &Connection, id: &str) -> R<usize> {
    let tx = c.unchecked_transaction().map_err(err)?;
    tx.execute("DELETE FROM compose_recovery_files WHERE recovery_id=?1", [id]).map_err(err)?;
    let n = tx.execute("DELETE FROM compose_recovery WHERE id=?1", [id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(n)
}

/// How many snapshot rows there are, and how many of them belong to an account that is not loaded (never offered). For the start-up log.
pub fn counts(c: &Connection) -> R<(usize, usize)> {
    let rows: i64 = c.query_row("SELECT COUNT(*) FROM compose_recovery", [], |r| r.get(0)).map_err(err)?;
    let hidden: i64 = c.query_row("SELECT COUNT(*) FROM compose_recovery WHERE account_id NOT IN (SELECT id FROM accounts)", [], |r| r.get(0)).map_err(err)?;
    Ok((rows as usize, hidden as usize))
}

/// The line `startup.log` gets when the start looks for snapshots: what was found and what happens to it. `offered` is what `list`
/// returned, `dropped` the rows of accounts that no longer exist (removed now). No subject, no text: only counts.
pub fn decision_text(offered: usize, dropped: usize) -> String {
    match (offered, dropped) {
        (0, 0) => "none".into(),
        (0, d) => format!("{d} snapshot(s) of an account that no longer exists dropped"),
        (n, 0) => format!("{n} snapshot(s) found, saving them as drafts"),
        (n, d) => format!("{n} snapshot(s) found, saving them as drafts ({d} more of an account that no longer exists dropped)"),
    }
}

// ---- the identity of a draft made from a snapshot --------------------------------------------------------------------------------
//
// Every draft Compose saves (autosave, Save draft, leaving) carries the id of its message's snapshot at the start of its Message-ID:
// `<{snapshot id}.{seconds}.{random}@{domain of the account}>`. At the next start that is how a snapshot finds its draft on the server: a kill
// between "the draft was saved" and "the snapshot was removed" must not turn into a second draft, and an older draft of the same message is
// replaced, never joined by a copy.

/// A snapshot id as it is written into a Message-ID (the ids of Compose are uuids).
pub fn id_in_message_id(id: &str) -> bool {
    valid_id(id)
}

/// The Message-ID of a draft: the snapshot id (when there is one) and the second it was saved, then a random part.
pub fn draft_message_id(recovery_id: Option<&str>, domain: &str, secs: i64) -> String {
    let random = uuid::Uuid::new_v4().simple();
    match recovery_id.filter(|r| valid_id(r)) {
        Some(r) => format!("<{r}.{secs}.{random}@{domain}>"),
        None => format!("<{random}@{domain}>"),
    }
}

/// What a Message-ID of a draft of this snapshot starts with (for the server's HEADER search and for checking its answer).
pub fn message_id_prefix(recovery_id: &str) -> String {
    format!("<{recovery_id}.")
}

/// The second a draft of snapshot `recovery_id` was saved, read from its Message-ID.
pub fn saved_secs(message_id: &str, recovery_id: &str) -> Option<i64> {
    let rest = message_id.trim().strip_prefix(&message_id_prefix(recovery_id))?;
    rest.split(['.', '@']).next()?.parse().ok()
}

/// What to do with a snapshot at the start, given the drafts of the same message that are on the server: `(uid, Message-ID)` of each.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// a draft saved at or after the snapshot exists: it holds everything the snapshot has, the snapshot is only removed
    Covered(u32),
    /// save the snapshot as a draft and remove these older drafts of the same message, by uid (none = a new one)
    Save { replace: Vec<u32> },
}

pub fn verdict(found: &[(u32, String)], recovery_id: &str, snapshot_saved_at: i64) -> Verdict {
    let mut older = vec![];
    let mut newest: Option<(i64, u32)> = None;
    for (uid, mid) in found {
        match saved_secs(mid, recovery_id) {
            Some(secs) if secs >= snapshot_saved_at => {
                if newest.is_none_or(|(s, _)| secs > s) {
                    newest = Some((secs, *uid));
                }
            }
            Some(_) => older.push(*uid),
            None => {} // (not ours: left alone)
        }
    }
    match newest {
        Some((_, uid)) => Verdict::Covered(uid),
        None => Verdict::Save { replace: older },
    }
}

/// The first 8 characters of a snapshot id, for the log.
pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// What a start finds: newest first, only snapshots of accounts that exist.
pub fn list(c: &Connection) -> R<Vec<Info>> {
    let mut st = c
        .prepare(
            "SELECT r.id, r.account_id, r.saved_at, r.subject, r.preview, (SELECT COUNT(*) FROM compose_recovery_files f WHERE f.recovery_id=r.id)
             FROM compose_recovery r WHERE r.account_id IN (SELECT id FROM accounts) ORDER BY r.saved_at DESC, r.id",
        )
        .map_err(err)?;
    let rows = st
        .query_map([], |r| Ok(Info { id: r.get(0)?, account_id: r.get(1)?, saved_at: r.get(2)?, subject: r.get(3)?, preview: r.get(4)?, files: r.get::<_, i64>(5)? as usize }))
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

pub fn load(c: &Connection, id: &str) -> R<Option<Loaded>> {
    let head: Option<(String, i64, String)> = c
        .query_row(
            "SELECT account_id, saved_at, payload FROM compose_recovery WHERE id=?1 AND account_id IN (SELECT id FROM accounts)",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?;
    let Some((account_id, saved_at, payload)) = head else { return Ok(None) };
    let mut st = c.prepare("SELECT name, mime, data FROM compose_recovery_files WHERE recovery_id=?1 ORDER BY pos").map_err(err)?;
    let files = st
        .query_map([id], |r| {
            let data: Vec<u8> = r.get(2)?;
            Ok(Att { filename: r.get(0)?, mime: r.get(1)?, data_base64: base64::engine::general_purpose::STANDARD.encode(data) })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(Some(Loaded { id: id.to_string(), account_id, saved_at, payload, files }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(name: &str, bytes: &[u8]) -> Att {
        Att { filename: name.into(), mime: "text/plain".into(), data_base64: base64::engine::general_purpose::STANDARD.encode(bytes) }
    }

    fn snap(id: &str, account: &str, subject: &str, files: Option<Vec<Att>>) -> SnapIn {
        SnapIn {
            id: id.into(),
            account_id: account.into(),
            subject: subject.into(),
            preview: format!("preview of {subject}"),
            payload: format!(r#"{{"to":["Ann <ann@example.com>"],"cc":[],"bcc":["quiet@example.com"],"subject":"{subject}","html":"<p>Hi</p>"}}"#),
            files,
        }
    }

    /// The shape the interface sends (camelCase, `files: null` when the attachments did not change) and gets back.
    #[test]
    fn the_json_of_the_interface_is_understood() {
        let s: SnapIn = serde_json::from_str(r#"{"id":"m-1","accountId":"a1","subject":"s","preview":"p","payload":"{}","files":null}"#).unwrap();
        assert!(s.files.is_none() && s.account_id == "a1");
        let s: SnapIn = serde_json::from_str(r#"{"id":"m-1","accountId":"a1","subject":"s","preview":"p","payload":"{}","files":[{"filename":"a.txt","mime":"text/plain","dataBase64":"eA=="}]}"#).unwrap();
        assert_eq!(s.files.unwrap()[0].filename, "a.txt");
        let i = serde_json::to_value(Info { id: "m".into(), account_id: "a1".into(), saved_at: 5, subject: "s".into(), preview: "p".into(), files: 2 }).unwrap();
        assert_eq!(i, serde_json::json!({"id":"m","accountId":"a1","savedAt":5,"subject":"s","preview":"p","files":2}));
    }

    fn dir(tag: &str) -> std::path::PathBuf {
        crate::shard::tests::temp_dir(tag)
    }

    fn open(path: &std::path::Path) -> Connection {
        crate::db::open(&path.join("heylook.db")).unwrap()
    }

    fn account(c: &Connection, id: &str) {
        let mut a = crate::smtp::tests::account_with_id(id);
        a.email = format!("{id}@example.com");
        crate::db::insert_account(c, &a).unwrap();
    }

    #[test]
    fn a_snapshot_round_trips_with_its_bcc_and_its_files() {
        let d = dir("rec-roundtrip");
        let c = open(&d);
        account(&c, "a1");
        save(&c, &snap("m1", "a1", "Plan", Some(vec![att("a.txt", b"line1\r\nline2"), att("b.bin", &[0, 255, 7])])), 100).unwrap();
        let l = load(&c, "m1").unwrap().expect("there");
        assert_eq!((l.account_id.as_str(), l.saved_at), ("a1", 100));
        let v: serde_json::Value = serde_json::from_str(&l.payload).unwrap();
        assert_eq!(v["bcc"][0], "quiet@example.com", "the Bcc recipients are part of the snapshot");
        assert_eq!(l.files.len(), 2);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&l.files[0].data_base64).unwrap(), b"line1\r\nline2", "bytes as they were");
        assert_eq!(l.files[1].filename, "b.bin");
        assert_eq!(list(&c).unwrap(), vec![Info { id: "m1".into(), account_id: "a1".into(), saved_at: 100, subject: "Plan".into(), preview: "preview of Plan".into(), files: 2 }]);
    }

    /// The crash-recovery state machine: written while typing, a kill, the next start finds it, and it is gone once the message is sent,
    /// discarded or saved.
    #[test]
    fn the_snapshot_lives_from_the_first_change_to_the_end_of_the_message() {
        let d = dir("rec-lifecycle");
        {
            let c = open(&d);
            account(&c, "a1");
            assert!(list(&c).unwrap().is_empty(), "nothing before anything is typed");
            save(&c, &snap("m1", "a1", "first", Some(vec![att("a.txt", b"x")])), 1).unwrap();
            // typing on: one row, replaced; the files stay when the interface does not send them again
            save(&c, &snap("m1", "a1", "second", None), 2).unwrap();
            let l = list(&c).unwrap();
            assert_eq!(l.len(), 1, "one snapshot per message, never a pile");
            assert_eq!((l[0].subject.as_str(), l[0].saved_at, l[0].files), ("second", 2, 1));
            // the files changed: replaced; changed to none: gone
            save(&c, &snap("m1", "a1", "third", Some(vec![att("b.txt", b"y"), att("c.txt", b"z")])), 3).unwrap();
            assert_eq!(list(&c).unwrap()[0].files, 2);
            save(&c, &snap("m1", "a1", "fourth", Some(vec![])), 4).unwrap();
            assert_eq!(list(&c).unwrap()[0].files, 0);
            save(&c, &snap("m1", "a1", "fifth", Some(vec![att("d.txt", b"w")])), 5).unwrap();
            // the process is killed here: the connection is simply dropped
        }
        {
            let c = open(&d);
            let l = list(&c).unwrap();
            assert_eq!((l.len(), l[0].subject.as_str(), l[0].files), (1, "fifth", 1), "the next start finds the last snapshot");
            // the person restores it and sends: the message is over
            clear(&c, "m1").unwrap();
            clear(&c, "m1").unwrap(); // (a second clear is harmless)
            assert!(list(&c).unwrap().is_empty());
            assert!(load(&c, "m1").unwrap().is_none());
            let files: i64 = c.query_row("SELECT COUNT(*) FROM compose_recovery_files", [], |r| r.get(0)).unwrap();
            assert_eq!(files, 0, "no attachment bytes are left behind");
        }
        let c = open(&d);
        assert!(list(&c).unwrap().is_empty(), "and it stays gone after the next start");
    }

    /// The line the start-up log gets (Linux QA: a start without the toast left no trace of why): what was found, what is dropped, and what
    /// happens to the rest. Counts only, never text.
    #[test]
    fn the_start_up_log_says_what_was_found_and_what_happens_to_it() {
        let d = dir("rec-log");
        let c = open(&d);
        account(&c, "a1");
        let say = |c: &Connection| decision_text(list(c).unwrap().len(), counts(c).unwrap().1);
        assert_eq!(say(&c), "none");
        save(&c, &snap("m1", "a1", "one", None), 1).unwrap();
        save(&c, &snap("m2", "a1", "two", None), 2).unwrap();
        assert_eq!(say(&c), "2 snapshot(s) found, saving them as drafts");
        // rows of an account that no longer exists are counted apart and never listed
        c.execute("INSERT INTO compose_recovery(id,account_id,saved_at,payload) VALUES('m3','ghost',5,'{}')", []).unwrap();
        assert_eq!(counts(&c).unwrap(), (3, 1));
        assert_eq!(say(&c), "2 snapshot(s) found, saving them as drafts (1 more of an account that no longer exists dropped)");
        // the start drops them (recovery_list): the next count is clean
        assert_eq!(prune(&c).unwrap(), 1);
        assert_eq!(counts(&c).unwrap(), (2, 0));
        clear(&c, "m1").unwrap();
        clear(&c, "m2").unwrap();
        c.execute("INSERT INTO compose_recovery(id,account_id,saved_at,payload) VALUES('m3','ghost',5,'{}')", []).unwrap();
        assert_eq!(say(&c), "1 snapshot(s) of an account that no longer exists dropped");
        // `clear` says whether a snapshot was really there (the log only mentions the ones that were)
        save(&c, &snap("m4", "a1", "four", None), 6).unwrap();
        assert_eq!((clear(&c, "m4").unwrap(), clear(&c, "m4").unwrap()), (1, 0));
        assert_eq!(short_id("0123456789abcdef"), "01234567");
    }

    /// 1.0.6: the identity of a draft made from a snapshot is the snapshot id at the start of its Message-ID.
    #[test]
    fn a_draft_of_a_snapshot_is_found_again_by_its_message_id() {
        let rid = "0f8e7d6c-1111-4222-8333-444455556666";
        let mid = draft_message_id(Some(rid), "example.com", 1_700_000_123);
        assert!(mid.starts_with(&message_id_prefix(rid)) && mid.ends_with("@example.com>"), "{mid}");
        assert_eq!(saved_secs(&mid, rid), Some(1_700_000_123));
        assert_eq!(saved_secs(&mid, "other-id"), None, "another message's draft is not ours");
        assert_eq!(saved_secs("<random@example.com>", rid), None);
        // two saves in the same second still differ
        assert_ne!(draft_message_id(Some(rid), "example.com", 5), draft_message_id(Some(rid), "example.com", 5));
        // no snapshot id (or one that is not safe in a header and a search): a plain random id, as before
        for bad in [None, Some(""), Some("a b"), Some("x\"y"), Some("a>b")] {
            let m = draft_message_id(bad, "example.com", 5);
            assert!(m.starts_with('<') && m.ends_with("@example.com>") && !m.contains("..") && m.matches('.').count() == 1, "{m}");
        }
        // the real writer puts it there, Compose's other drafts keep the plain form
        let mut d = crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![]);
        d.recovery_id = Some(rid.into());
        let raw = crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted();
        let text = String::from_utf8_lossy(&raw).to_string();
        let line = text.lines().find(|l| l.to_ascii_lowercase().starts_with("message-id:")).unwrap().to_string();
        assert!(line.contains(&message_id_prefix(rid)), "{line}");
        d.recovery_id = None;
        let raw = crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted();
        assert!(!String::from_utf8_lossy(&raw).contains(rid));
        // it is only a draft's business: the payload of a queued message does not carry it unless set
        assert!(!serde_json::to_string(&d).unwrap().contains("recoveryId"));
    }

    #[test]
    fn a_snapshot_is_covered_by_a_newer_draft_replaces_an_older_one_or_makes_a_new_one() {
        let rid = "aaaa-bbbb";
        let mid = |secs: i64| format!("<{rid}.{secs}.x@example.com>");
        // nothing on the server: a new draft
        assert_eq!(verdict(&[], rid, 100), Verdict::Save { replace: vec![] });
        // a draft saved after the snapshot (the kill came between the save and the removal of the snapshot): no second draft
        assert_eq!(verdict(&[(7, mid(120))], rid, 100), Verdict::Covered(7));
        // saved in the same second: the draft has it all too (the snapshot is written after the change, the draft after that)
        assert_eq!(verdict(&[(7, mid(100))], rid, 100), Verdict::Covered(7));
        // older than the snapshot (typed after the last save): the snapshot wins and the old draft goes, in place
        assert_eq!(verdict(&[(7, mid(90))], rid, 100), Verdict::Save { replace: vec![7] });
        // several: the newest one that covers decides; a stray older copy is left for the next save to replace
        assert_eq!(verdict(&[(5, mid(90)), (9, mid(130)), (8, mid(110))], rid, 100), Verdict::Covered(9));
        assert_eq!(verdict(&[(5, mid(80)), (6, mid(90))], rid, 100), Verdict::Save { replace: vec![5, 6] });
        // a message that is not one of ours is never touched
        assert_eq!(verdict(&[(5, "<other@x>".into())], rid, 100), Verdict::Save { replace: vec![] });
    }

    #[test]
    fn a_failed_write_leaves_the_previous_snapshot_whole() {
        let d = dir("rec-atomic");
        let c = open(&d);
        account(&c, "a1");
        save(&c, &snap("m1", "a1", "good", Some(vec![att("keep.txt", b"keep")])), 1).unwrap();
        // the second file cannot be stored (a trigger stands in for a full disk / a kill): the first one and the row must not be half-replaced
        c.execute_batch("CREATE TRIGGER boom BEFORE INSERT ON compose_recovery_files WHEN NEW.name='boom.txt' BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        let e = save(&c, &snap("m1", "a1", "half", Some(vec![att("new.txt", b"new"), att("boom.txt", b"x")])), 2).unwrap_err();
        assert!(e.contains("disk full"), "{e}");
        let l = load(&c, "m1").unwrap().unwrap();
        assert_eq!(l.saved_at, 1, "the row is the old one");
        assert!(l.payload.contains("good") && !l.payload.contains("half"));
        assert_eq!(l.files.len(), 1);
        assert_eq!(l.files[0].filename, "keep.txt", "and so are its files");
        // bad input is refused before anything is written
        assert!(save(&c, &SnapIn { payload: "not json".into(), ..snap("m1", "a1", "x", None) }, 3).is_err());
        assert!(save(&c, &SnapIn { payload: "[1]".into(), ..snap("m1", "a1", "x", None) }, 3).is_err());
        assert!(save(&c, &snap("../x", "a1", "x", None), 3).is_err());
        assert_eq!(load(&c, "m1").unwrap().unwrap().saved_at, 1);
    }

    /// A snapshot belongs to its account: not kept for an account that does not exist, not offered once it is gone, wiped with it.
    #[test]
    fn snapshots_do_not_cross_accounts_and_go_with_their_account() {
        let d = dir("rec-accounts");
        let c = open(&d);
        account(&c, "a1");
        account(&c, "a2");
        assert!(save(&c, &snap("m0", "nobody", "x", None), 1).is_err(), "unknown account");
        save(&c, &snap("m1", "a1", "for a1", Some(vec![att("f.txt", b"1")])), 1).unwrap();
        save(&c, &snap("m2", "a2", "for a2", Some(vec![att("g.txt", b"2")])), 2).unwrap();
        let l = list(&c).unwrap();
        assert_eq!(l.iter().map(|i| (i.id.as_str(), i.account_id.as_str())).collect::<Vec<_>>(), vec![("m2", "a2"), ("m1", "a1")], "newest first, each with its own account");
        assert_eq!(load(&c, "m1").unwrap().unwrap().account_id, "a1");
        crate::db::remove_account(&c, "a1").unwrap();
        assert_eq!(list(&c).unwrap().iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["m2"]);
        assert!(load(&c, "m1").unwrap().is_none(), "what the removed account was writing is gone");
        let rows: i64 = c.query_row("SELECT COUNT(*) FROM compose_recovery WHERE account_id='a1'", [], |r| r.get(0)).unwrap();
        let files: i64 = c.query_row("SELECT COUNT(*) FROM compose_recovery_files WHERE recovery_id='m1'", [], |r| r.get(0)).unwrap();
        assert_eq!((rows, files), (0, 0));
        // an interrupted removal (the account row is gone, the snapshot is not) is cleaned up at the next start
        c.execute("INSERT INTO compose_recovery(id,account_id,saved_at,payload) VALUES('m3','ghost',5,'{}')", []).unwrap();
        c.execute("INSERT INTO compose_recovery_files(recovery_id,pos,name,mime,data) VALUES('m3',0,'f','x/y',x'00')", []).unwrap();
        assert!(list(&c).unwrap().iter().all(|i| i.id != "m3"), "never offered");
        assert!(load(&c, "m3").unwrap().is_none());
        crate::db::prune_orphans(&c).unwrap();
        let left: i64 = c.query_row("SELECT (SELECT COUNT(*) FROM compose_recovery WHERE id='m3') + (SELECT COUNT(*) FROM compose_recovery_files WHERE recovery_id='m3')", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
