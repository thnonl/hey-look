//! Crash recovery for the message being written (QA round 17 BUG-02).
//!
//! The text of a message that is being written lived only in the window: a kill, a crash or a power cut lost everything typed since the
//! last Save draft. Compose now writes a snapshot of itself every few seconds (when something changed) and removes it as soon as the message
//! is sent, discarded or saved; whatever is still here at the next start is offered back ("Restore unsaved message").
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

/// The line `startup.log` gets when the start looks for snapshots: what was found and whether the question will be asked. `offered` is what
/// `list` returned, `hidden` the rows of accounts that are not loaded. No subject, no text: only counts.
pub fn decision_text(offered: usize, hidden: usize) -> String {
    match (offered, hidden) {
        (0, 0) => "none".into(),
        (0, h) => format!("skipped ({h} snapshot(s) belong to an account that is not loaded)"),
        (n, 0) => format!("{n} snapshot(s) found, offering restore"),
        (n, h) => format!("{n} snapshot(s) found, offering restore ({h} more belong to an account that is not loaded)"),
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

    /// The line the start-up log gets (Linux QA: a start without the question left no trace of why): what was found, what is hidden, and
    /// whether the question is asked. Counts only, never text.
    #[test]
    fn the_start_up_log_says_what_was_found_and_whether_the_question_is_asked() {
        let d = dir("rec-log");
        let c = open(&d);
        account(&c, "a1");
        let say = |c: &Connection| decision_text(list(c).unwrap().len(), counts(c).unwrap().1);
        assert_eq!(say(&c), "none");
        save(&c, &snap("m1", "a1", "one", None), 1).unwrap();
        save(&c, &snap("m2", "a1", "two", None), 2).unwrap();
        assert_eq!(say(&c), "2 snapshot(s) found, offering restore");
        // rows of an account that is not loaded are counted apart and never offered
        c.execute("INSERT INTO compose_recovery(id,account_id,saved_at,payload) VALUES('m3','ghost',5,'{}')", []).unwrap();
        assert_eq!(counts(&c).unwrap(), (3, 1));
        assert_eq!(say(&c), "2 snapshot(s) found, offering restore (1 more belong to an account that is not loaded)");
        clear(&c, "m1").unwrap();
        clear(&c, "m2").unwrap();
        assert_eq!(say(&c), "skipped (1 snapshot(s) belong to an account that is not loaded)");
        // `clear` says whether a snapshot was really there (the log only mentions the ones that were)
        save(&c, &snap("m4", "a1", "four", None), 6).unwrap();
        assert_eq!((clear(&c, "m4").unwrap(), clear(&c, "m4").unwrap()), (1, 0));
        assert_eq!(short_id("0123456789abcdef"), "01234567");
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
