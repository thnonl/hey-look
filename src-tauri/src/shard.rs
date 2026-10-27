//! One SQLite file per mailbox for the `messages` data (`mail-<account id>.db` next to `heylook.db`).
//!
//! Why: one account's mail (a 1000-message inbox is ~100 MB of bodies) must not bloat, lock or slow down the file that holds
//! accounts, settings, rules and the rest, and removing an account is "delete its file".
//!
//! How: every shard is ATTACHed to the app's single connection as `m_<id with - as _>`, and a TEMP VIEW named `messages`
//! (UNION ALL of the shards) with INSTEAD OF INSERT / UPDATE / DELETE triggers that route by `account_id` keeps every
//! existing `FROM messages` / `INSERT OR REPLACE INTO messages` statement working unchanged. Limits of a view that callers
//! must know: it has no `rowid`; `execute()` reports 0 changed rows for UPDATE / DELETE on it (SQLite does not count
//! INSTEAD OF work); a statement that updates or deletes many rows first copies the matching full rows (bodies included) into
//! a temp table, so never bulk-delete a mailbox through it - `drop_account` removes the file instead.
//!
//! If the old single-file layout cannot be converted safely (`migrate_legacy` fails), the old `messages` table is left
//! untouched and the app keeps running on it: `legacy()` is true and every function here does nothing.

use crate::db::{add_column, err, R};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Columns of `messages`, in the order of the shard table (the view, its triggers and the legacy copy name them explicitly,
/// so the column order of an old database does not matter). A new column: add it to `create_sql` and here, and give old
/// shards an `ALTER TABLE ... ADD COLUMN` through `db::add_column` in `attach`.
const COLS: [&str; 30] = [
    "id", "account_id", "folder", "uid", "message_id", "thread_id", "subject", "from_name", "from_email", "to_addrs", "cc_addrs", "date",
    "snippet", "body_html", "body_text", "seen", "flagged", "has_attach", "attachments", "list_unsub", "list_unsub_post", "pgp", "pgp_raw",
    "ics", "cal_method", "importance", "auth_result", "reply_hdr", "auth_ev", "list_hdr",
];

/// Columns an old (pre-shard) `main.messages` may still lack; same list the single-file layout migrated with.
const LEGACY_ADD_COLUMNS: [&str; 10] = [
    "ALTER TABLE main.messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE main.messages ADD COLUMN pgp INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE main.messages ADD COLUMN pgp_raw BLOB",
    "ALTER TABLE main.messages ADD COLUMN ics TEXT",
    "ALTER TABLE main.messages ADD COLUMN cal_method TEXT",
    "ALTER TABLE main.messages ADD COLUMN importance INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE main.messages ADD COLUMN auth_result TEXT",
    "ALTER TABLE main.messages ADD COLUMN reply_hdr TEXT",
    "ALTER TABLE main.messages ADD COLUMN auth_ev TEXT",
    "ALTER TABLE main.messages ADD COLUMN list_hdr INTEGER NOT NULL DEFAULT 0",
];

/// The `messages` table and its three indexes inside the attached database `schema`.
fn create_sql(schema: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {schema}.messages(
           id TEXT PRIMARY KEY, account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
           message_id TEXT, thread_id TEXT NOT NULL, subject TEXT NOT NULL,
           from_name TEXT NOT NULL, from_email TEXT NOT NULL,
           to_addrs TEXT NOT NULL, cc_addrs TEXT NOT NULL, date INTEGER NOT NULL,
           snippet TEXT NOT NULL, body_html TEXT, body_text TEXT,
           seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
           has_attach INTEGER NOT NULL DEFAULT 0,
           attachments TEXT NOT NULL DEFAULT '[]',
           list_unsub TEXT, list_unsub_post INTEGER NOT NULL DEFAULT 0,
           pgp INTEGER NOT NULL DEFAULT 0, pgp_raw BLOB, ics TEXT, cal_method TEXT,
           importance INTEGER NOT NULL DEFAULT 0, auth_result TEXT, reply_hdr TEXT, auth_ev TEXT, list_hdr INTEGER NOT NULL DEFAULT 0,
           UNIQUE(account_id, folder, uid)
         );
         CREATE INDEX IF NOT EXISTS {schema}.idx_msg_thread ON messages(thread_id);
         CREATE INDEX IF NOT EXISTS {schema}.idx_msg_folder ON messages(account_id, folder, date DESC);
         CREATE INDEX IF NOT EXISTS {schema}.idx_msg_mid ON messages(message_id);"
    )
}

/// Account ids are UUIDs; anything else (path separators, quotes) is refused because the id becomes a file name and is
/// written into SQL text of the view / triggers.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn check_id(id: &str) -> R<()> {
    if valid_id(id) { Ok(()) } else { Err(format!("invalid account id for a mail file: {id:?}")) }
}

fn alias(id: &str) -> String {
    format!("m_{}", id.replace('-', "_"))
}

fn id_of_alias(a: &str) -> Option<String> {
    a.strip_prefix("m_").map(|r| r.replace('_', "-")).filter(|id| valid_id(id))
}

pub fn file_name(id: &str) -> String {
    format!("mail-{id}.db")
}

/// Folder of the main database file; `None` for an in-memory database (tests), whose shards are in memory too.
pub fn data_dir(conn: &Connection) -> Option<PathBuf> {
    let p = conn.path().filter(|p| !p.is_empty())?;
    Some(Path::new(p).parent().filter(|d| !d.as_os_str().is_empty()).map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(".")))
}

/// The old layout: `messages` is still a real table in the main file.
pub fn legacy(conn: &Connection) -> bool {
    conn.query_row("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='messages'", [], |_| Ok(())).is_ok()
}

/// The table that holds one account's messages (`m_<id>.messages`, or `main.messages` in the old layout). For code that must
/// delete rows by id and count them, which the view cannot do (see the header).
pub fn messages_table(conn: &Connection, id: &str) -> R<String> {
    check_id(id)?;
    Ok(if legacy(conn) { "main.messages".into() } else { format!("{}.messages", alias(id)) })
}

/// Account ids whose shard is attached, sorted.
fn attached(conn: &Connection) -> R<Vec<String>> {
    let mut st = conn.prepare("PRAGMA database_list").map_err(err)?;
    let mut ids: Vec<String> = st
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?
        .iter()
        .filter_map(|n| id_of_alias(n))
        .collect();
    ids.sort();
    Ok(ids)
}

/// Schemas that hold `messages` rows: the attached shards, or `main` while the old layout is in use. For code that needs
/// `rowid` (a view has none) or wants to walk one file at a time.
pub fn message_schemas(conn: &Connection) -> Vec<String> {
    if legacy(conn) {
        return vec!["main".into()];
    }
    attached(conn).unwrap_or_default().iter().map(|id| alias(id)).collect()
}

/// Create (when missing) and attach one shard; the view is not touched. `false` when it was attached already.
fn attach(conn: &Connection, dir: Option<&Path>, id: &str) -> R<bool> {
    check_id(id)?;
    if attached(conn)?.iter().any(|a| a == id) {
        return Ok(false);
    }
    let a = alias(id);
    let target = dir.map(|d| d.join(file_name(id)).to_string_lossy().into_owned()).unwrap_or_else(|| ":memory:".into());
    conn.execute(&format!("ATTACH DATABASE ?1 AS {a}"), [&target]).map_err(|e| {
        if e.to_string().contains("too many attached") {
            // SQLite's text names the cap ("too many attached databases - max N")
            format!("too many mailboxes: {e}")
        } else {
            format!("cannot open the mail file of account {id}: {e}")
        }
    })?;
    if dir.is_some() {
        conn.query_row(&format!("PRAGMA {a}.journal_mode=WAL"), [], |_| Ok(())).map_err(err)?;
    }
    conn.execute_batch(&create_sql(&a)).map_err(err)?;
    // a shard made by an earlier version lacks the columns added since (a new shard has them already: "duplicate column" is fine)
    add_column(conn, &format!("ALTER TABLE {a}.messages ADD COLUMN importance INTEGER NOT NULL DEFAULT 0"))?;
    // the receiving server's verdict on the sender of an invitation mail ('pass' | 'fail'; NULL = unknown), 1.0.7 W7.3
    add_column(conn, &format!("ALTER TABLE {a}.messages ADD COLUMN auth_result TEXT"))?;
    // the headers an answer needs, as JSON (NULL = not kept yet: Reply reads the header block from the server once and keeps it), 1.0.7 W13.13
    add_column(conn, &format!("ALTER TABLE {a}.messages ADD COLUMN reply_hdr TEXT"))?;
    // what the sender check proves about the From domain, and the mailing-list headers (1.0.10: pictures of people you wrote to and of services); NULL / 0 for mail stored before
    add_column(conn, &format!("ALTER TABLE {a}.messages ADD COLUMN auth_ev TEXT"))?;
    add_column(conn, &format!("ALTER TABLE {a}.messages ADD COLUMN list_hdr INTEGER NOT NULL DEFAULT 0"))?;
    Ok(true)
}

fn detach(conn: &Connection, id: &str) -> R<()> {
    conn.execute_batch(&format!("DETACH DATABASE {}", alias(id))).map_err(err)
}

/// (Re)create the TEMP VIEW `messages` and its routing triggers for the shards attached right now.
fn rebuild(conn: &Connection) -> R<()> {
    let ids = attached(conn)?;
    let cols = COLS.join(",");
    let mut sql = String::from("DROP VIEW IF EXISTS temp.messages;");
    let old: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name LIKE 'msg\\_%' ESCAPE '\\'").map_err(err)?;
        st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?
    };
    for t in old {
        sql.push_str(&format!("DROP TRIGGER IF EXISTS temp.\"{t}\";"));
    }
    if ids.is_empty() {
        sql.push_str(&format!("CREATE TEMP VIEW messages AS SELECT {} WHERE 0;", COLS.iter().map(|c| format!("NULL AS {c}")).collect::<Vec<_>>().join(",")));
    } else {
        let arms: Vec<String> = ids.iter().map(|id| format!("SELECT {cols} FROM {}.messages", alias(id))).collect();
        sql.push_str(&format!("CREATE TEMP VIEW messages AS {};", arms.join(" UNION ALL ")));
    }
    let new_values: Vec<String> = COLS
        .iter()
        .map(|c| match *c {
            // the view has no column defaults: a statement that leaves these out must get the table's defaults
            "seen" | "flagged" | "has_attach" | "list_unsub_post" | "pgp" | "importance" | "list_hdr" => format!("COALESCE(NEW.{c},0)"),
            "attachments" => "COALESCE(NEW.attachments,'[]')".into(),
            _ => format!("NEW.{c}"),
        })
        .collect();
    let set: Vec<String> = COLS.iter().map(|c| format!("{c}=NEW.{c}")).collect();
    for id in &ids {
        let a = alias(id);
        // INSERT OR REPLACE on the view carries its conflict mode into the trigger body (checked by a test)
        sql.push_str(&format!(
            "CREATE TEMP TRIGGER msg_ins_{a} INSTEAD OF INSERT ON messages WHEN NEW.account_id='{id}' BEGIN
               INSERT INTO {a}.messages({cols}) VALUES({}); END;
             CREATE TEMP TRIGGER msg_upd_{a} INSTEAD OF UPDATE ON messages WHEN OLD.account_id='{id}' BEGIN
               UPDATE {a}.messages SET {} WHERE id=OLD.id; END;
             CREATE TEMP TRIGGER msg_del_{a} INSTEAD OF DELETE ON messages WHEN OLD.account_id='{id}' BEGIN
               DELETE FROM {a}.messages WHERE id=OLD.id; END;",
            new_values.join(","),
            set.join(",")
        ));
    }
    let known = ids.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",");
    sql.push_str(&format!(
        "CREATE TEMP TRIGGER msg_ins_none INSTEAD OF INSERT ON messages WHEN NEW.account_id IS NULL OR NEW.account_id NOT IN ({}) BEGIN
           SELECT RAISE(ABORT, 'no mail file for this account (it was removed)'); END;",
        if ids.is_empty() { "''".to_string() } else { known }
    ));
    // rows that belong to no attached shard (none at all on a fresh folder or after the last account was removed): the view holds
    // none of them, so a DELETE / UPDATE on `messages` changes nothing - but SQLite refuses the statement outright
    // ("cannot modify messages because it is a view") unless some INSTEAD OF trigger exists for it
    let none_of = if ids.is_empty() { "''".to_string() } else { ids.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",") };
    sql.push_str(&format!(
        "CREATE TEMP TRIGGER msg_del_none INSTEAD OF DELETE ON messages WHEN OLD.account_id IS NULL OR OLD.account_id NOT IN ({none_of}) BEGIN SELECT 1; END;
         CREATE TEMP TRIGGER msg_upd_none INSTEAD OF UPDATE ON messages WHEN OLD.account_id IS NULL OR OLD.account_id NOT IN ({none_of}) BEGIN SELECT 1; END;"
    ));
    conn.execute_batch(&sql).map_err(err)
}

/// Make sure the account has a shard and that `messages` reaches it (a new account, or one signing in again).
pub fn ensure(conn: &Connection, id: &str) -> R<()> {
    if legacy(conn) {
        return Ok(());
    }
    let dir = data_dir(conn);
    if attach(conn, dir.as_deref(), id)? {
        rebuild(conn)?;
    }
    Ok(())
}

/// Attach exactly these accounts (tests, and `open_all`): shards not in `ids` are detached.
#[cfg(test)]
pub fn set_attached(conn: &Connection, ids: &[String]) -> R<()> {
    if legacy(conn) {
        return Ok(());
    }
    let dir = data_dir(conn);
    for id in ids {
        attach(conn, dir.as_deref(), id)?;
    }
    for id in attached(conn)? {
        if !ids.contains(&id) {
            detach(conn, &id)?;
        }
    }
    rebuild(conn)
}

/// An account is removed: forget its shard and delete the file (+ -wal / -shm). A file that cannot be deleted now (open in
/// another program) is logged and removed at the next start by `open_all`.
pub fn drop_account(conn: &Connection, id: &str) -> R<()> {
    if legacy(conn) {
        conn.execute("DELETE FROM main.messages WHERE account_id=?1", [id]).map_err(err)?;
        return Ok(());
    }
    check_id(id)?;
    let dir = data_dir(conn);
    if attached(conn)?.iter().any(|a| a == id) {
        detach(conn, id)?;
        rebuild(conn)?;
    }
    if let Some(d) = dir {
        remove_files(&d, id);
    }
    Ok(())
}

fn remove_files(dir: &Path, id: &str) {
    let base = dir.join(file_name(id));
    for suffix in ["", "-wal", "-shm"] {
        let mut p = base.clone().into_os_string();
        p.push(suffix);
        let p = PathBuf::from(p);
        match std::fs::remove_file(&p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => eprintln!("could not delete {}: {e} (retried at the next start)", p.display()),
            _ => {}
        }
    }
}

/// Shard files in `dir` that belong to no account (an interrupted removal): their conversations' pins / snoozes go, then
/// the files.
fn remove_orphan_files(conn: &Connection, dir: &Path, accounts: &HashSet<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_prefix("mail-").and_then(|n| n.strip_suffix(".db")).filter(|id| valid_id(id)) else { continue };
        if accounts.contains(id) {
            continue;
        }
        eprintln!("removing the mail file of an account that no longer exists: {name}");
        let path = e.path().to_string_lossy().into_owned();
        if conn.execute("ATTACH DATABASE ?1 AS m_orphan", [&path]).is_ok() {
            let _ = conn.execute_batch(
                "DELETE FROM thread_meta WHERE thread_id IN (SELECT thread_id FROM m_orphan.messages); DETACH DATABASE m_orphan;",
            );
            let _ = conn.execute_batch("DETACH DATABASE m_orphan");
        }
        remove_files(dir, id);
    }
}

/// Start-up: convert the old layout if needed, attach the shard of every account, delete leftovers, build the view.
/// A failed conversion is reported (stderr + the `shard_migration_error` setting) and leaves the old table in use.
pub fn open_all(conn: &Connection) -> R<()> {
    let main_file = conn.path().filter(|p| !p.is_empty()).map(PathBuf::from);
    if let (true, Some(file)) = (legacy(conn), &main_file) {
        match migrate_legacy(conn, file) {
            Ok(Some(r)) => eprintln!(
                "mail moved to one file per account: {} messages in {} accounts, {} of removed accounts dropped; backup: {}",
                r.copied, r.accounts, r.orphans, r.backup.display()
            ),
            Ok(None) => {}
            Err(e) => {
                eprintln!("mail files per account: conversion failed, the old database stays in use: {e}");
                let _ = crate::db::set_setting(conn, "shard_migration_error", &e);
                for id in attached(conn).unwrap_or_default() {
                    let _ = detach(conn, &id);
                }
                return Ok(());
            }
        }
        let _ = conn.execute("DELETE FROM settings WHERE key='shard_migration_error'", []);
    }
    if legacy(conn) {
        return Ok(()); // in-memory database that still has the old table: nothing to shard
    }
    let accounts: Vec<String> = crate::db::list_accounts(conn)?.into_iter().map(|a| a.id).collect();
    let dir = data_dir(conn);
    for id in &accounts {
        attach(conn, dir.as_deref(), id)?;
    }
    rebuild(conn)?;
    if let Some(d) = &dir {
        remove_orphan_files(conn, d, &accounts.iter().cloned().collect());
    }
    Ok(())
}

#[derive(Debug)]
pub struct Migrated {
    pub copied: i64,
    pub accounts: usize,
    pub orphans: i64,
    pub backup: PathBuf,
}

fn counts_by_account(conn: &Connection, table: &str) -> R<Vec<(String, i64)>> {
    let mut st = conn.prepare(&format!("SELECT account_id, COUNT(*) FROM {table} GROUP BY account_id ORDER BY account_id")).map_err(err)?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(rows)
}

/// A backup file is good when it is a readable database whose per-account message counts equal `counts`.
fn verify_backup(path: &Path, counts: &[(String, i64)]) -> R<()> {
    let b = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| format!("backup does not open: {e}"))?;
    let check: String = b.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| format!("backup check failed: {e}"))?;
    if check != "ok" {
        return Err(format!("backup is damaged: {check}"));
    }
    let got = counts_by_account(&b, "messages").map_err(|e| format!("backup is unreadable: {e}"))?;
    if got != counts {
        return Err("backup holds different message counts than the database".into());
    }
    Ok(())
}

/// `heylook.db.pre-shard.bak`: a byte-for-byte copy of the main file, verified (same size as the source, opens read-only,
/// quick_check ok, same per-account counts) before it gets its final name. An existing backup is reused only when it
/// matches the current counts; otherwise a new one is written next to it (`...pre-shard.<unix time>.bak`), never over it.
fn make_backup(conn: &Connection, main_file: &Path, counts: &[(String, i64)]) -> R<PathBuf> {
    let dir = main_file.parent().unwrap_or_else(|| Path::new("."));
    let plain = dir.join("heylook.db.pre-shard.bak");
    if plain.exists() && verify_backup(&plain, counts).is_ok() {
        return Ok(plain);
    }
    let target = if plain.exists() {
        dir.join(format!("heylook.db.pre-shard.{}.bak", chrono::Utc::now().timestamp()))
    } else {
        plain
    };
    // move the write-ahead log into the main file so that a plain file copy is complete (nothing else uses the database yet)
    let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0)).map_err(err)?;
    if busy != 0 {
        return Err("cannot make a backup: the database is busy".into());
    }
    let src_len = std::fs::metadata(main_file).map_err(err)?.len();
    let tmp = dir.join("heylook.db.pre-shard.bak.tmp");
    let _ = std::fs::remove_file(&tmp);
    let result = (|| -> R<()> {
        std::fs::copy(main_file, &tmp).map_err(|e| format!("cannot write the backup: {e}"))?;
        let copied = std::fs::metadata(&tmp).map_err(err)?.len();
        if copied != src_len || std::fs::metadata(main_file).map_err(err)?.len() != src_len {
            return Err(format!("backup size {copied} differs from the database size {src_len}"));
        }
        verify_backup(&tmp, counts)
    })();
    // the read-only check may leave its own -wal / -shm next to the copy
    for s in ["-wal", "-shm"] {
        let mut p = tmp.clone().into_os_string();
        p.push(s);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, &target).map_err(|e| format!("cannot finish the backup: {e}"))?;
    Ok(target)
}

/// Move the rows of the old `main.messages` table into one shard per account. Order, so that every failure leaves the old
/// table intact and a re-run converges: (1) bring the old table's columns up to date, (2) verified backup, (3) per account,
/// in one transaction: empty its shard, copy its rows, compare the counts (mismatch = rollback + error), (4) only when every
/// account matched and no row is unaccounted for, drop the old table. Rows of accounts that no longer exist are dropped with
/// it (they are in the backup) and counted. `Ok(None)`: nothing to convert.
pub fn migrate_legacy(conn: &Connection, main_file: &Path) -> R<Option<Migrated>> {
    if !legacy(conn) {
        return Ok(None);
    }
    for ddl in LEGACY_ADD_COLUMNS {
        add_column(conn, ddl)?;
    }
    let counts = counts_by_account(conn, "main.messages")?;
    let total: i64 = counts.iter().map(|c| c.1).sum();
    let accounts = crate::db::list_accounts(conn)?;
    let backup = if total > 0 { make_backup(conn, main_file, &counts)? } else { PathBuf::new() };
    let dir = data_dir(conn);
    let cols = COLS.join(",");
    let mut copied = 0i64;
    for a in &accounts {
        attach(conn, dir.as_deref(), &a.id)?;
        let want = counts.iter().find(|c| c.0 == a.id).map(|c| c.1).unwrap_or(0);
        let s = alias(&a.id);
        conn.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        let step = (|| -> R<()> {
            conn.execute(&format!("DELETE FROM {s}.messages"), []).map_err(err)?;
            conn.execute(&format!("INSERT INTO {s}.messages({cols}) SELECT {cols} FROM main.messages WHERE account_id=?1"), [&a.id]).map_err(err)?;
            let got: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {s}.messages"), [], |r| r.get(0)).map_err(err)?;
            if got != want {
                return Err(format!("account {}: copied {got} of {want} messages", a.id));
            }
            Ok(())
        })();
        match step {
            Ok(()) => conn.execute_batch("COMMIT").map_err(err)?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
        copied += want;
    }
    let orphans = total - copied;
    if orphans < 0 || orphans != counts.iter().filter(|c| !accounts.iter().any(|a| a.id == c.0)).map(|c| c.1).sum::<i64>() {
        return Err("message counts do not add up; the old table was kept".into());
    }
    conn.execute_batch("DROP TABLE main.messages").map_err(err)?;
    // give the freed space back; failing here only costs disk space
    if total > 0 {
        let _ = conn.execute_batch("VACUUM main");
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    }
    Ok(Some(Migrated { copied, accounts: accounts.len(), orphans, backup }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rusqlite::params;

    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("heylook-shard-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const A: &str = "11111111-2222-4333-8444-555555555555";
    const B: &str = "e079e7e1-42ea-4a5b-bddc-c68316d66182";

    fn put(c: &Connection, id: &str, acct: &str, uid: i64, subject: &str) {
        c.execute(
            "INSERT OR REPLACE INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet)
             VALUES(?1,?2,'inbox',?3,'t','s','n','x@y.z','','',?3,?4)",
            params![id, acct, uid, subject],
        )
        .unwrap();
    }

    fn n(c: &Connection, sql: &str) -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn id_rules_and_alias_round_trip() {
        assert!(valid_id(A) && valid_id("a1"));
        for bad in ["", "a/b", "..", "a b", "a'b", "a_b", "a.db"] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert_eq!(id_of_alias(&alias(A)).as_deref(), Some(A));
        assert_eq!(id_of_alias("temp"), None);
    }

    #[test]
    fn view_routes_insert_update_delete_and_replace_to_the_account_shard() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        set_attached(&c, &[A.to_string(), B.to_string()]).unwrap();
        put(&c, "a1", A, 1, "one");
        put(&c, "b1", B, 1, "other");
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 2);
        assert_eq!(n(&c, &format!("SELECT COUNT(*) FROM {}.messages", alias(A))), 1);
        assert_eq!(n(&c, &format!("SELECT COUNT(*) FROM {}.messages WHERE id='b1'", alias(B))), 1);
        // defaults of columns the statement leaves out
        let (seen, att): (i64, String) = c.query_row("SELECT seen, attachments FROM messages WHERE id='a1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((seen, att.as_str()), (0, "[]"));
        // INSERT OR REPLACE: same id replaces, same (account, folder, uid) under another id replaces too, never duplicates
        put(&c, "a1", A, 1, "one again");
        put(&c, "a1-new-id", A, 1, "same uid");
        assert_eq!(n(&c, &format!("SELECT COUNT(*) FROM {}.messages", alias(A))), 1);
        assert_eq!(c.query_row::<String, _, _>("SELECT snippet FROM messages WHERE account_id=?1", [A], |r| r.get(0)).unwrap(), "same uid");
        // a plain INSERT of an existing key is still an error
        assert!(c.execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('a1-new-id',?1,'inbox',9,'t','s','n','e','','',0,'')", [A]).is_err());
        // UPDATE touches only the targeted row, in its own shard
        c.execute("UPDATE messages SET seen=1, flagged=1 WHERE id='a1-new-id'", []).unwrap();
        assert_eq!(n(&c, "SELECT seen+flagged FROM messages WHERE id='a1-new-id'"), 2);
        assert_eq!(n(&c, "SELECT seen FROM messages WHERE id='b1'"), 0);
        c.execute("UPDATE messages SET pgp = pgp | 2 WHERE id='b1' AND pgp & 2 = 0", []).unwrap();
        assert_eq!(n(&c, "SELECT pgp FROM messages WHERE id='b1'"), 2);
        // DELETE
        c.execute("DELETE FROM messages WHERE account_id=?1 AND folder='inbox' AND uid=1", [A]).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 1);
        c.execute("DELETE FROM messages WHERE id='b1'", []).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 0);
        // an account without a shard cannot get mail (a removed account racing a background download)
        let e = c.execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('x','nope','inbox',1,'t','s','n','e','','',0,'')", []).unwrap_err();
        assert!(e.to_string().contains("no mail file"), "{e}");
    }

    #[test]
    fn many_accounts_work_or_fail_with_a_clear_message() {
        // src-tauri/.cargo/config.toml raises SQLite's cap of 10 attached files to 60; a build made elsewhere keeps 10
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        let ids: Vec<String> = (0..12).map(|i| format!("00000000-0000-4000-8000-{i:012}")).collect();
        match set_attached(&c, &ids) {
            Ok(()) => {
                for (i, id) in ids.iter().enumerate() {
                    put(&c, &format!("m{i}"), id, 1, "x");
                }
                assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 12);
                println!("attach cap raised: 12 mailboxes work");
            }
            Err(e) => assert!(e.contains("too many mailboxes"), "{e}"),
        }
    }

    #[test]
    fn query_plans_keep_using_the_folder_index() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        set_attached(&c, &[A.to_string(), B.to_string()]).unwrap();
        let plan: Vec<String> = c
            .prepare("EXPLAIN QUERY PLAN SELECT m.id FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id WHERE m.account_id=?1 AND m.folder='inbox' ORDER BY m.date DESC LIMIT 4000")
            .unwrap()
            .query_map([A], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let text = plan.join("\n");
        assert!(text.contains("idx_msg_folder"), "{text}");
        assert!(!text.contains("SCAN m_") && !text.contains("SCAN messages"), "no full scan of a shard: {text}");
    }

    #[test]
    fn dropping_an_account_deletes_its_file_and_keeps_the_others() {
        let dir = temp_dir("drop");
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        for id in [A, B] {
            let acc = crate::db::Account {
                id: id.into(), email: format!("{id}@x.example"), display_name: "N".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
            };
            crate::db::insert_account(&c, &acc).unwrap();
        }
        put(&c, "a1", A, 1, "one");
        put(&c, "b1", B, 1, "two");
        assert!(dir.join(file_name(A)).exists() && dir.join(file_name(B)).exists());
        crate::db::remove_account(&c, A).unwrap();
        assert!(!dir.join(file_name(A)).exists(), "shard file removed");
        assert!(!dir.join(format!("{}-wal", file_name(A))).exists() && !dir.join(format!("{}-shm", file_name(A))).exists());
        assert!(dir.join(file_name(B)).exists());
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 1);
        drop(c);
        // a leftover file of an account that is gone is cleaned at the next start
        std::fs::copy(dir.join(file_name(B)), dir.join(file_name(A))).unwrap();
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert!(!dir.join(file_name(A)).exists());
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 1);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh folder has no account and so no shard: the start-up cleanup (DELETE ... FROM messages) must not fail on the empty view,
    /// and neither must removing the last account (which runs the same cleanup).
    #[test]
    fn a_fresh_folder_and_the_last_removal_can_run_the_cleanup() {
        let dir = temp_dir("fresh-cleanup");
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert!(crate::db::prune_orphans(&c).is_ok(), "{:?}", crate::db::prune_orphans(&c).err());
        c.execute("DELETE FROM messages WHERE account_id NOT IN (SELECT id FROM accounts)", []).unwrap();
        c.execute("UPDATE messages SET seen=1 WHERE account_id='nobody'", []).unwrap();
        // one account, then removed: the view ends up with no shard again
        let acc = crate::db::Account {
            id: A.into(), email: "a@x.example".into(), display_name: "N".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
        };
        crate::db::insert_account(&c, &acc).unwrap();
        put(&c, "a1", A, 1, "one");
        crate::db::remove_account(&c, A).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 0);
        assert!(crate::db::prune_orphans(&c).is_ok());
        drop(c);
        // and a restart of the same folder
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert!(crate::db::prune_orphans(&c).is_ok());
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pre-shard database: `messages` in the main file (with an old column order, `attachments` added late), 2 accounts and
    /// an orphan row.
    fn legacy_db(dir: &Path) -> PathBuf {
        let file = dir.join("heylook.db");
        let c = Connection::open(&file).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        crate::db::migrate(&c).unwrap();
        c.execute_batch(
            "CREATE TABLE messages(
               id TEXT PRIMARY KEY, account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
               message_id TEXT, thread_id TEXT NOT NULL, subject TEXT NOT NULL,
               from_name TEXT NOT NULL, from_email TEXT NOT NULL,
               to_addrs TEXT NOT NULL, cc_addrs TEXT NOT NULL, date INTEGER NOT NULL,
               snippet TEXT NOT NULL, body_html TEXT, body_text TEXT,
               seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
               has_attach INTEGER NOT NULL DEFAULT 0,
               list_unsub TEXT, list_unsub_post INTEGER NOT NULL DEFAULT 0,
               UNIQUE(account_id, folder, uid)
             );
             CREATE INDEX idx_msg_folder ON messages(account_id, folder, date DESC);",
        )
        .unwrap();
        for id in [A, B] {
            c.execute(
                "INSERT INTO accounts(id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username) VALUES(?1,?2,'N','h',993,1,'s',465,'ssl','u')",
                params![id, format!("{id}@x.example")],
            )
            .unwrap();
        }
        for (acct, count) in [(A, 120), (B, 7), ("gone-account", 3)] {
            for i in 1..=count {
                c.execute(
                    "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,body_html) VALUES(?1,?2,'inbox',?3,'t','s','n','x@y.z','','',?3,'sn','<p>body</p>')",
                    params![format!("{acct}:{i}"), acct, i],
                )
                .unwrap();
            }
        }
        file
    }

    #[test]
    fn legacy_table_is_copied_verified_backed_up_and_dropped_and_a_rerun_is_a_no_op() {
        let dir = temp_dir("mig");
        let file = legacy_db(&dir);
        let c = crate::db::open(&file).unwrap();
        assert!(!legacy(&c), "old table dropped");
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 127, "orphans of the removed account are not carried over");
        assert_eq!(n(&c, &format!("SELECT COUNT(*) FROM {}.messages", alias(A))), 120);
        assert_eq!(n(&c, &format!("SELECT COUNT(*) FROM {}.messages", alias(B))), 7);
        assert_eq!(c.query_row::<String, _, _>("SELECT attachments FROM messages WHERE id=?1", [format!("{A}:5")], |r| r.get(0)).unwrap(), "[]");
        assert_eq!(c.query_row::<String, _, _>("SELECT body_html FROM messages WHERE id=?1", [format!("{B}:2")], |r| r.get(0)).unwrap(), "<p>body</p>");
        assert!(get_err(&c).is_none());
        // backup (make_backup itself checks size, integrity and counts): a database with all 130 old rows, no temp leftovers
        let bak = dir.join("heylook.db.pre-shard.bak");
        let b = Connection::open_with_flags(&bak, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(n(&b, "SELECT COUNT(*) FROM messages"), 130);
        drop(b);
        drop(c);
        // second start: nothing to convert, nothing duplicated, the backup untouched
        let c = crate::db::open(&file).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 127);
        assert!(!dir.join("heylook.db.pre-shard.bak.tmp").exists());
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F-24: a mail file made before the `importance` column existed gets it (value 0 = normal) when it is attached; its rows stay,
    /// new rows can carry an importance, the view and its triggers see the column, and attaching again changes nothing.
    #[test]
    fn an_older_mail_file_gets_the_importance_column_and_keeps_its_rows() {
        let dir = temp_dir("importance");
        {
            let c = crate::db::open(&dir.join("heylook.db")).unwrap();
            let acc = crate::db::Account {
                id: A.into(), email: "a@x.example".into(), display_name: "N".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
            };
            crate::db::insert_account(&c, &acc).unwrap();
        }
        remove_files(&dir, A); // the file the line above created has the new layout
        // the shard as the previous version wrote it: the same table without the column
        {
            let old = Connection::open(dir.join(file_name(A))).unwrap();
            old.execute_batch(&create_sql("main").replace("importance INTEGER NOT NULL DEFAULT 0,", "")).unwrap();
            assert!(old.prepare("SELECT importance FROM messages").is_err(), "the old file really lacks the column");
            old.execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('old',?1,'inbox',1,'t','s','n','x@y.z','','',1,'')", [A]).unwrap();
        }
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 1);
        assert_eq!(n(&c, "SELECT importance FROM messages WHERE id='old'"), 0, "an old row is Normal");
        c.execute("UPDATE messages SET importance=1 WHERE id='old'", []).unwrap();
        c.execute("INSERT OR REPLACE INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,importance) VALUES('new',?1,'inbox',2,'t','s','n','x@y.z','','',2,'',2)", [A]).unwrap();
        assert_eq!(n(&c, "SELECT importance FROM messages WHERE id='old'"), 1);
        assert_eq!(n(&c, "SELECT importance FROM messages WHERE id='new'"), 2);
        put(&c, "plain", A, 3, "no importance given");
        assert_eq!(n(&c, "SELECT importance FROM messages WHERE id='plain'"), 0, "the view gives a statement that leaves it out the default");
        drop(c);
        // a second start (column already there) is fine and keeps the values
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT SUM(importance) FROM messages"), 3);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// W7.3: a mail file made before the `auth_result` column existed gets it when it is attached (NULL = no verdict), its rows stay, the view and its
    /// triggers see the column, and attaching again changes nothing.
    #[test]
    fn an_older_mail_file_gets_the_auth_result_column_and_keeps_its_rows() {
        let dir = temp_dir("authresult");
        {
            let c = crate::db::open(&dir.join("heylook.db")).unwrap();
            let acc = crate::db::Account {
                id: A.into(), email: "a@x.example".into(), display_name: "N".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
            };
            crate::db::insert_account(&c, &acc).unwrap();
        }
        remove_files(&dir, A);
        {
            let old = Connection::open(dir.join(file_name(A))).unwrap();
            old.execute_batch(&create_sql("main").replace(", auth_result TEXT", "")).unwrap();
            assert!(old.prepare("SELECT auth_result FROM messages").is_err(), "the old file really lacks the column");
            old.execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('old',?1,'inbox',1,'t','s','n','x@y.z','','',1,'')", [A]).unwrap();
        }
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 1);
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='old' AND auth_result IS NULL"), 1, "an old row has no verdict");
        c.execute("UPDATE messages SET auth_result='fail' WHERE id='old'", []).unwrap();
        c.execute("INSERT OR REPLACE INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,auth_result) VALUES('new',?1,'inbox',2,'t','s','n','x@y.z','','',2,'','pass')", [A]).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='old' AND auth_result='fail'"), 1);
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='new' AND auth_result='pass'"), 1);
        put(&c, "plain", A, 3, "no verdict given");
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='plain' AND auth_result IS NULL"), 1);
        drop(c);
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE auth_result IS NOT NULL"), 2);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// W13.13: a mail file made before the `reply_hdr` column existed gets it when it is attached (NULL = the headers are read from the server once), its rows stay, the
    /// view and its triggers see the column, and attaching again changes nothing.
    #[test]
    fn an_older_mail_file_gets_the_reply_hdr_column_and_keeps_its_rows() {
        let dir = temp_dir("replyhdr");
        {
            let c = crate::db::open(&dir.join("heylook.db")).unwrap();
            let acc = crate::db::Account {
                id: A.into(), email: "a@x.example".into(), display_name: "N".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
            };
            crate::db::insert_account(&c, &acc).unwrap();
        }
        remove_files(&dir, A);
        {
            let old = Connection::open(dir.join(file_name(A))).unwrap();
            old.execute_batch(&create_sql("main").replace(", reply_hdr TEXT", "")).unwrap();
            assert!(old.prepare("SELECT reply_hdr FROM messages").is_err(), "the old file really lacks the column");
            old.execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('old',?1,'inbox',1,'t','s','n','x@y.z','','',1,'')", [A]).unwrap();
        }
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 1);
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='old' AND reply_hdr IS NULL"), 1, "an old row has no headers kept");
        c.execute("UPDATE messages SET reply_hdr='{}' WHERE id='old'", []).unwrap();
        c.execute("INSERT OR REPLACE INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,reply_hdr) VALUES('new',?1,'inbox',2,'t','s','n','x@y.z','','',2,'','{\"references\":[]}')", [A]).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE reply_hdr IS NOT NULL"), 2);
        drop(c);
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE reply_hdr IS NOT NULL"), 2, "attaching again keeps the values");
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn get_err(c: &Connection) -> Option<String> {
        crate::db::get_setting(c, "shard_migration_error")
    }

    #[test]
    fn an_interrupted_conversion_converges_on_the_second_run() {
        let dir = temp_dir("resume");
        let file = legacy_db(&dir);
        {
            // simulate a crash after account A was copied (and a stray extra row got into its shard)
            let c = Connection::open(&file).unwrap();
            for ddl in LEGACY_ADD_COLUMNS {
                add_column(&c, ddl).unwrap();
            }
            let dirp = data_dir(&c);
            attach(&c, dirp.as_deref(), A).unwrap();
            let s = alias(A);
            let cols = COLS.join(",");
            c.execute_batch(&format!("INSERT INTO {s}.messages({cols}) SELECT {cols} FROM main.messages WHERE account_id='{A}' AND uid<=50;")).unwrap();
            c.execute(&format!("INSERT INTO {s}.messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('stray','{A}','inbox',999,'t','s','n','e','','',0,'')"), []).unwrap();
        }
        let c = crate::db::open(&file).unwrap();
        assert!(!legacy(&c));
        assert_eq!(n(&c, &format!("SELECT COUNT(*) FROM messages WHERE account_id='{A}'")), 120, "no duplicates, no stray row");
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 127);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_conversion_keeps_the_old_table_and_the_app_usable() {
        let dir = temp_dir("fail");
        let file = legacy_db(&dir);
        // an account whose id cannot become a file name makes the conversion fail
        {
            let c = Connection::open(&file).unwrap();
            c.execute("INSERT INTO accounts(id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username) VALUES('bad/id','e','N','h',993,1,'s',465,'ssl','u')", []).unwrap();
        }
        let c = crate::db::open(&file).unwrap();
        assert!(legacy(&c), "old table intact");
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 130);
        assert!(get_err(&c).unwrap().contains("invalid account id"));
        // ... and still works: insert / update / delete go to the old table
        put(&c, "new", A, 500, "x");
        c.execute("UPDATE messages SET seen=1 WHERE id='new'", []).unwrap();
        c.execute("DELETE FROM messages WHERE id='new'", []).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 130);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_row_count_stops_before_the_old_table_is_dropped() {
        let dir = temp_dir("count");
        let file = legacy_db(&dir);
        let c = Connection::open(&file).unwrap();
        // a trigger on the shard that swallows rows makes the copy come out short
        let dirp = data_dir(&c);
        attach(&c, dirp.as_deref(), A).unwrap();
        c.execute_batch(&format!("CREATE TEMP TRIGGER eat BEFORE INSERT ON {}.messages WHEN NEW.uid=7 BEGIN SELECT RAISE(IGNORE); END;", alias(A))).unwrap();
        let e = migrate_legacy(&c, &file).unwrap_err();
        assert!(e.contains("copied 119 of 120"), "{e}");
        assert!(legacy(&c));
        assert_eq!(n(&c, "SELECT COUNT(*) FROM main.messages"), 130);
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_existing_backup_is_never_overwritten() {
        let dir = temp_dir("bak");
        let file = legacy_db(&dir);
        std::fs::write(dir.join("heylook.db.pre-shard.bak"), b"old and different").unwrap();
        let c = crate::db::open(&file).unwrap();
        assert!(!legacy(&c));
        assert_eq!(std::fs::read(dir.join("heylook.db.pre-shard.bak")).unwrap(), b"old and different");
        let extra = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("heylook.db.pre-shard.1")).count();
        assert_eq!(extra, 1, "a second, timestamped backup was written");
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Manual check on a COPY of a real database: `HEYLOOK_PERF_SRC=<folder with heylook.db[-wal]> cargo test --lib perf_on_a_copy -- --ignored --nocapture`.
    /// Never point it at the live data folder: it is copied first, and the copy is what gets converted.
    #[test]
    #[ignore]
    fn perf_on_a_copy_of_a_real_database() {
        use std::time::Instant;
        let src = PathBuf::from(std::env::var("HEYLOOK_PERF_SRC").expect("HEYLOOK_PERF_SRC"));
        let dir = temp_dir("perf");
        for f in ["heylook.db", "heylook.db-wal", "heylook.db-shm"] {
            if src.join(f).exists() {
                std::fs::copy(src.join(f), dir.join(f)).unwrap();
            }
        }
        let file = dir.join("heylook.db");
        let list = "SELECT m.thread_id,m.id,m.account_id,m.folder,m.subject,m.from_name,m.from_email,m.snippet,m.date,m.seen,m.flagged,m.has_attach,
                COALESCE(tm.pinned,0), tm.snoozed_until, m.list_unsub IS NOT NULL, m.pgp, m.cal_method
         FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id
         WHERE m.account_id=?1 AND m.folder='inbox' AND (tm.snoozed_until IS NULL OR tm.snoozed_until<=?2) AND m.from_email NOT IN (SELECT email FROM blocked)
         ORDER BY m.date DESC LIMIT 4000";
        let time_list = |c: &Connection, acct: &str| -> (usize, u128) {
            let t = Instant::now();
            let mut st = c.prepare(list).unwrap();
            let rows = st.query_map(params![acct, i64::MAX], |r| r.get::<_, String>(1)).unwrap().count();
            (rows, t.elapsed().as_millis())
        };
        let before = Connection::open(&file).unwrap();
        assert!(legacy(&before), "the copy has the old layout");
        let per_acct = counts_by_account(&before, "messages").unwrap();
        println!("accounts (rows): {per_acct:?}");
        let biggest = per_acct.iter().max_by_key(|c| c.1).unwrap().0.clone();
        println!("OLD single table: inbox list of the biggest account: {:?} (rows, ms); again {:?}", time_list(&before, &biggest), time_list(&before, &biggest));
        let t = Instant::now();
        let total_old = n(&before, "SELECT COUNT(*) FROM messages");
        println!("OLD count(*): {total_old} in {} ms", t.elapsed().as_millis());
        drop(before);

        let t = Instant::now();
        let c = crate::db::open(&file).unwrap();
        println!("MIGRATION + open: {} ms; legacy left: {}", t.elapsed().as_millis(), legacy(&c));
        for f in std::fs::read_dir(&dir).unwrap().flatten() {
            println!("  {} {} bytes", f.file_name().to_string_lossy(), f.metadata().unwrap().len());
        }
        let after = counts_by_account(&c, "messages").unwrap();
        println!("per-account counts through the view: {after:?}");
        assert_eq!(after.iter().map(|c| c.1).sum::<i64>(), per_acct.iter().filter(|p| attached(&c).unwrap().contains(&p.0)).map(|p| p.1).sum::<i64>());
        println!("NEW view: inbox list of the biggest account: {:?} (rows, ms); again {:?}", time_list(&c, &biggest), time_list(&c, &biggest));
        let t = Instant::now();
        println!("NEW count(*): {} in {} ms", n(&c, "SELECT COUNT(*) FROM messages"), t.elapsed().as_millis());
        let t = Instant::now();
        let folders: usize = c.prepare("SELECT account_id,folder,COUNT(DISTINCT thread_id) FROM messages GROUP BY account_id,folder").unwrap().query_map([], |_| Ok(())).unwrap().count();
        println!("NEW list_folders GROUP BY: {folders} groups in {} ms", t.elapsed().as_millis());
        let plan: Vec<String> = c.prepare(&format!("EXPLAIN QUERY PLAN {list}")).unwrap().query_map(params![biggest, i64::MAX], |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect();
        println!("EXPLAIN QUERY PLAN (view):
  {}", plan.join("
  "));
        let id: String = c.query_row("SELECT id FROM messages WHERE account_id=?1 LIMIT 1", [&biggest], |r| r.get(0)).unwrap();
        let t = Instant::now();
        c.execute("UPDATE messages SET seen=1 WHERE id=?1", [&id]).unwrap();
        println!("NEW single UPDATE via view: {} ms", t.elapsed().as_millis());
        let t = Instant::now();
        let sn = c.query_row("SELECT COUNT(*) FROM messages WHERE thread_id IN (SELECT thread_id FROM messages WHERE id=?1)", [&id], |r| r.get::<_, i64>(0)).unwrap();
        println!("NEW thread lookup ({sn} msgs): {} ms", t.elapsed().as_millis());
        let t = Instant::now();
        crate::db::prune_orphans(&c).unwrap();
        println!("NEW prune_orphans: {} ms", t.elapsed().as_millis());
        drop(c);
        let c = crate::db::open(&file).unwrap();
        assert_eq!(counts_by_account(&c, "messages").unwrap(), after, "second start changes nothing");
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 1.0.10 T-R6: a mail file from 1.0.9 (no `auth_ev`, no `list_hdr`) gets both columns when it is attached: its rows stay with NULL evidence and no list header, new rows carry both, the
    /// view and its triggers see them, and attaching again changes nothing.
    #[test]
    fn an_older_mail_file_gets_the_evidence_columns_and_keeps_its_rows() {
        let dir = temp_dir("authev");
        {
            let c = crate::db::open(&dir.join("heylook.db")).unwrap();
            let acc = crate::db::Account {
                id: A.into(), email: "a@x.example".into(), display_name: "N".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
            };
            crate::db::insert_account(&c, &acc).unwrap();
        }
        remove_files(&dir, A);
        {
            let old = Connection::open(dir.join(file_name(A))).unwrap();
            old.execute_batch(&create_sql("main").replace(", auth_ev TEXT, list_hdr INTEGER NOT NULL DEFAULT 0", "")).unwrap();
            assert!(old.prepare("SELECT auth_ev FROM messages").is_err() && old.prepare("SELECT list_hdr FROM messages").is_err(), "the old file really lacks the columns");
            old.execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('old',?1,'inbox',1,'t','s','n','x@y.z','','',1,'')", [A]).unwrap();
        }
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages"), 1, "no message lost");
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='old' AND auth_ev IS NULL AND list_hdr=0"), 1, "an old row has no evidence: it never shows pictures by itself");
        c.execute("INSERT OR REPLACE INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,auth_ev,list_hdr) VALUES('new',?1,'inbox',2,'t','s','n','x@y.z','','',2,'','{}',1)", [A]).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='new' AND auth_ev='{}' AND list_hdr=1"), 1);
        put(&c, "plain", A, 3, "nothing given");
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE id='plain' AND auth_ev IS NULL AND list_hdr=0"), 1);
        drop(c);
        let c = crate::db::open(&dir.join("heylook.db")).unwrap();
        assert_eq!(n(&c, "SELECT COUNT(*) FROM messages WHERE auth_ev IS NOT NULL"), 1, "attaching again changes nothing");
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
