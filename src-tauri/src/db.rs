use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub type R<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn open(path: &Path) -> R<Connection> {
    let conn = Connection::open(path).map_err(err)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Create missing tables and columns (safe to run on every start).
pub fn migrate(conn: &Connection) -> R<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS accounts(
           id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL,
           imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_ssl INTEGER NOT NULL,
           smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_security TEXT NOT NULL,
           username TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS messages(
           id TEXT PRIMARY KEY, account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
           message_id TEXT, thread_id TEXT NOT NULL, subject TEXT NOT NULL,
           from_name TEXT NOT NULL, from_email TEXT NOT NULL,
           to_addrs TEXT NOT NULL, cc_addrs TEXT NOT NULL, date INTEGER NOT NULL,
           snippet TEXT NOT NULL, body_html TEXT, body_text TEXT,
           seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
           has_attach INTEGER NOT NULL DEFAULT 0,
           attachments TEXT NOT NULL DEFAULT '[]',
           list_unsub TEXT, list_unsub_post INTEGER NOT NULL DEFAULT 0,
           UNIQUE(account_id, folder, uid)
         );
         CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id);
         CREATE INDEX IF NOT EXISTS idx_msg_folder ON messages(account_id, folder, date DESC);
         CREATE INDEX IF NOT EXISTS idx_msg_mid ON messages(message_id);
         CREATE TABLE IF NOT EXISTS thread_meta(
           thread_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, snoozed_until INTEGER
         );
         CREATE TABLE IF NOT EXISTS blocked(email TEXT PRIMARY KEY);
         CREATE TABLE IF NOT EXISTS templates(
           id TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS signatures(
           id TEXT PRIMARY KEY, name TEXT NOT NULL, html TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS outbox(
           id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL,
           send_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT
         );
         CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS rules(
           id TEXT PRIMARY KEY, name TEXT NOT NULL, field TEXT NOT NULL, op TEXT NOT NULL,
           value TEXT NOT NULL, action TEXT NOT NULL, arg TEXT, enabled INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS pgp_keys(
           fingerprint TEXT PRIMARY KEY, key_id TEXT NOT NULL, user_ids TEXT NOT NULL, emails TEXT NOT NULL,
           algo TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
           public_armored TEXT NOT NULL, secret_armored TEXT, verified INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'paste', added_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS pgp_default(account_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS events(
           id TEXT PRIMARY KEY, uid TEXT NOT NULL, recurrence_id TEXT NOT NULL DEFAULT '',
           calendar_id TEXT NOT NULL, account_id TEXT,
           summary TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, tzid TEXT,
           location TEXT, join_url TEXT, description TEXT,
           organizer_name TEXT, organizer_email TEXT, attendees TEXT NOT NULL DEFAULT '[]',
           rrule TEXT, exdates TEXT NOT NULL DEFAULT '[]',
           status TEXT NOT NULL DEFAULT 'confirmed', my_status TEXT, responded_at INTEGER, reminder_min INTEGER,
           source_message_id TEXT, sequence INTEGER NOT NULL DEFAULT 0, prev TEXT,
           created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
           UNIQUE(calendar_id, uid, recurrence_id)
         );
         CREATE INDEX IF NOT EXISTS idx_events_range ON events(starts_at, ends_at);
         CREATE INDEX IF NOT EXISTS idx_events_uid ON events(uid);",
    )
    .map_err(err)?;
    // migrations: ignore "duplicate column" errors on already-migrated DBs
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN auth TEXT NOT NULL DEFAULT 'password'", []);
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN color TEXT", []);
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN smtp_username TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN tls_insecure INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'", []);
    // scheduled sends: when it was queued and how many delivery attempts failed so far
    let _ = conn.execute("ALTER TABLE outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0", []);
    // PGP: 1 = encrypted, 2 = signed; the raw message is kept for those (ciphertext only, never decrypted text)
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN pgp INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN pgp_raw BLOB", []);
    // calendar invitations: the iCalendar text of the message and its (lowercase) iMIP method
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN ics TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN cal_method TEXT", []);
    // signatures / templates / filter rules can apply to one account (NULL = every account)
    for t in ["rules", "signatures", "templates"] {
        let _ = conn.execute(&format!("ALTER TABLE {t} ADD COLUMN account_id TEXT"), []);
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_ssl: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    /// "ssl" | "starttls" | "none"
    pub smtp_security: String,
    pub username: String,
    /// "password" | "oauth_google" | "oauth_microsoft"
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub color: Option<String>,
    /// SMTP login when it differs from `username` (empty = same). Its password lives in the credential
    /// manager under "<id>:smtp"; without one the IMAP password is reused.
    #[serde(default)]
    pub smtp_username: String,
    /// Accept self-signed / private-CA / mismatched certificates (IMAP and SMTP).
    #[serde(default)]
    pub tls_insecure: bool,
}

fn default_auth() -> String {
    "password".into()
}

pub fn list_accounts(c: &Connection) -> R<Vec<Account>> {
    let mut st = c
        .prepare(
            "SELECT id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username,auth,color,smtp_username,tls_insecure
             FROM accounts ORDER BY rowid",
        )
        .map_err(err)?;
    let rows = st
        .query_map([], row_account)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

pub fn get_account(c: &Connection, id: &str) -> R<Account> {
    c.query_row(
        "SELECT id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username,auth,color,smtp_username,tls_insecure
         FROM accounts WHERE id=?1",
        [id],
        row_account,
    )
    .map_err(|_| format!("account not found: {id}"))
}

fn row_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        email: r.get(1)?,
        display_name: r.get(2)?,
        imap_host: r.get(3)?,
        imap_port: r.get(4)?,
        imap_ssl: r.get::<_, i64>(5)? != 0,
        smtp_host: r.get(6)?,
        smtp_port: r.get(7)?,
        smtp_security: r.get(8)?,
        username: r.get(9)?,
        auth: r.get(10)?,
        color: r.get(11)?,
        smtp_username: r.get(12)?,
        tls_insecure: r.get::<_, i64>(13)? != 0,
    })
}

pub fn insert_account(c: &Connection, a: &Account) -> R<()> {
    c.execute(
        "INSERT OR REPLACE INTO accounts(id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username,auth,color,smtp_username,tls_insecure)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            a.id,
            a.email,
            a.display_name,
            a.imap_host,
            a.imap_port,
            a.imap_ssl as i64,
            a.smtp_host,
            a.smtp_port,
            a.smtp_security,
            a.username,
            a.auth,
            a.color,
            a.smtp_username,
            a.tls_insecure as i64
        ],
    )
    .map_err(err)?;
    Ok(())
}

pub fn remove_account(c: &Connection, id: &str) -> R<()> {
    c.execute("DELETE FROM messages WHERE account_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM outbox WHERE account_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM pgp_default WHERE account_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM events WHERE account_id=?1 OR calendar_id=?2", params![id, format!("invites:{id}")]).map_err(err)?;
    c.execute("DELETE FROM accounts WHERE id=?1", [id]).map_err(err)?;
    Ok(())
}

pub fn get_setting(c: &Connection, key: &str) -> Option<String> {
    c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .ok()
}

pub fn set_setting(c: &Connection, key: &str, value: &str) -> R<()> {
    c.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map_err(err)?;
    Ok(())
}
