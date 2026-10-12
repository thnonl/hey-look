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
    // migrations: a column that is already there is fine, any other failure (locked file, full disk) is reported
    add_column(conn, "ALTER TABLE accounts ADD COLUMN auth TEXT NOT NULL DEFAULT 'password'")?;
    add_column(conn, "ALTER TABLE accounts ADD COLUMN color TEXT")?;
    add_column(conn, "ALTER TABLE accounts ADD COLUMN smtp_username TEXT NOT NULL DEFAULT ''")?;
    add_column(conn, "ALTER TABLE accounts ADD COLUMN tls_insecure INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")?;
    // scheduled sends: when it was queued and how many delivery attempts failed so far
    add_column(conn, "ALTER TABLE outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")?;
    // PGP: 1 = encrypted, 2 = signed; the raw message is kept for those (ciphertext only, never decrypted text)
    add_column(conn, "ALTER TABLE messages ADD COLUMN pgp INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "ALTER TABLE messages ADD COLUMN pgp_raw BLOB")?;
    // calendar invitations: the iCalendar text of the message and its (lowercase) iMIP method
    add_column(conn, "ALTER TABLE messages ADD COLUMN ics TEXT")?;
    add_column(conn, "ALTER TABLE messages ADD COLUMN cal_method TEXT")?;
    // signatures / templates / filter rules can apply to one account (NULL = every account)
    for t in ["rules", "signatures", "templates"] {
        add_column(conn, &format!("ALTER TABLE {t} ADD COLUMN account_id TEXT"))?;
    }
    Ok(())
}

/// Run one `ALTER TABLE ... ADD COLUMN`. Only "duplicate column name" (an already migrated database) is ignored: any other
/// failure leaves the schema incomplete and is returned instead of being swallowed.
fn add_column(conn: &Connection, ddl: &str) -> R<()> {
    match conn.execute(ddl, []) {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(()),
        Err(e) => Err(format!("database migration failed ({ddl}): {e}")),
    }
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

/// Curated mailbox colors: ten clearly different hues, each with a relative luminance that keeps a flat 16x4 mark at >= 3:1 on a
/// white row and on the dark surface (#1b1c20). Keep in sync with `ACCOUNT_PALETTE` in src/prefs.ts (a test compares them).
pub const ACCOUNT_PALETTE: [&str; 10] = [
    "#0f6cbd", "#ca5010", "#13803c", "#8764b8", "#d13438", "#038387", "#e3008c", "#b8860b", "#5c7e9e", "#6b8e23",
];

/// The color for a new account: the first palette color no existing account uses; when all are used, the least used one
/// (the earliest in the palette on a tie). Comparison ignores case; colors outside the palette (custom) count for nothing.
pub fn pick_account_color<'a, I: IntoIterator<Item = Option<&'a str>>>(used: I) -> String {
    let used: Vec<String> = used.into_iter().flatten().map(|c| c.trim().to_ascii_lowercase()).collect();
    let uses = |p: &str| used.iter().filter(|u| u.as_str() == p).count();
    let best = ACCOUNT_PALETTE.iter().min_by_key(|p| uses(p)).copied().unwrap_or(ACCOUNT_PALETTE[0]);
    best.to_string()
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
    // pins and snoozes of this account's conversations go with the conversations
    c.execute("DELETE FROM thread_meta WHERE thread_id IN (SELECT thread_id FROM messages WHERE account_id=?1)", [id]).map_err(err)?;
    c.execute("DELETE FROM messages WHERE account_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM outbox WHERE account_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM pgp_default WHERE account_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM events WHERE account_id=?1 OR calendar_id=?2", params![id, format!("invites:{id}")]).map_err(err)?;
    c.execute("DELETE FROM accounts WHERE id=?1", [id]).map_err(err)?;
    // the account's rules / signatures / templates, folder map, hidden-calendar mark and preferences
    prune_orphans(c)?;
    Ok(())
}

/// Delete everything that still refers to an account that is not in `accounts`: its mail, outbox, key defaults, events,
/// rules / signatures / templates, folder map (`fmap:<id>`), hidden-calendar marks and the preferences that name it
/// (default account, per-account overrides, favorites, collapsed groups). Runs when the app starts and after a removal, so
/// leftovers of an interrupted removal or of an older version do not pile up. PGP keys are not touched: they belong to the
/// person, not to the mailbox. Returns how many rows / settings were removed or changed.
pub fn prune_orphans(c: &Connection) -> R<usize> {
    let ids: std::collections::HashSet<String> = list_accounts(c)?.into_iter().map(|a| a.id).collect();
    let mut n = 0usize;
    let gone = "NOT IN (SELECT id FROM accounts)";
    for sql in [
        format!("DELETE FROM thread_meta WHERE thread_id IN (SELECT thread_id FROM messages WHERE account_id {gone})"),
        format!("DELETE FROM messages WHERE account_id {gone}"),
        format!("DELETE FROM outbox WHERE account_id {gone}"),
        format!("DELETE FROM pgp_default WHERE account_id {gone}"),
        format!("DELETE FROM events WHERE (account_id IS NOT NULL AND account_id {gone}) OR (calendar_id LIKE 'invites:%' AND substr(calendar_id, 9) {gone})"),
        format!("DELETE FROM rules WHERE account_id IS NOT NULL AND account_id != '' AND account_id {gone}"),
        format!("DELETE FROM signatures WHERE account_id IS NOT NULL AND account_id != '' AND account_id {gone}"),
        format!("DELETE FROM templates WHERE account_id IS NOT NULL AND account_id != '' AND account_id {gone}"),
    ] {
        n += c.execute(&sql, []).map_err(err)?;
    }
    // folder maps of removed accounts
    let keys: Vec<String> = {
        let mut st = c.prepare("SELECT key FROM settings WHERE key LIKE 'fmap:%'").map_err(err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
        rows
    };
    for k in keys {
        if !ids.contains(k.trim_start_matches("fmap:")) {
            n += c.execute("DELETE FROM settings WHERE key=?1", [&k]).map_err(err)?;
        }
    }
    // calendars hidden by the user: "invites:<account>" of a removed account
    if let Some(raw) = get_setting(c, "cal_hidden") {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&raw) {
            let kept: Vec<String> = list.iter().filter(|k| k.strip_prefix("invites:").map(|a| ids.contains(a)).unwrap_or(true)).cloned().collect();
            if kept.len() != list.len() {
                set_setting(c, "cal_hidden", &serde_json::to_string(&kept).map_err(err)?)?;
                n += 1;
            }
        }
    }
    if let Some(raw) = get_setting(c, "prefs") {
        if let Some(clean) = clean_prefs(&raw, &ids) {
            set_setting(c, "prefs", &clean)?;
            n += 1;
        }
    }
    Ok(n)
}

fn looks_like_account_id(k: &str) -> bool {
    k.len() == 36 && k.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// The stored preferences (JSON) without references to accounts that are not in `valid`; `None` when nothing needed to change
/// (or the text is not a JSON object). Same rules as `staleAccountPrefs` in src/prefs.ts.
pub fn clean_prefs(raw: &str, valid: &std::collections::HashSet<String>) -> Option<String> {
    let mut v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let o = v.as_object_mut()?;
    let mut changed = false;
    if let Some(d) = o.get("defaultAccount").and_then(|d| d.as_str()) {
        if !d.is_empty() && !valid.contains(d) {
            o.insert("defaultAccount".into(), serde_json::Value::String(String::new()));
            changed = true;
        }
    }
    if let Some(m) = o.get_mut("accountPrefs").and_then(|m| m.as_object_mut()) {
        let before = m.len();
        m.retain(|k, _| valid.contains(k));
        changed |= m.len() != before;
    }
    if let Some(a) = o.get_mut("favorites").and_then(|a| a.as_array_mut()) {
        let before = a.len();
        a.retain(|f| {
            f.as_str()
                .map(|s| {
                    let acct = s.split('|').next().unwrap_or("");
                    acct == "*" || valid.contains(acct)
                })
                .unwrap_or(true)
        });
        changed |= a.len() != before;
    }
    if let Some(m) = o.get_mut("collapsed").and_then(|m| m.as_object_mut()) {
        let before = m.len();
        m.retain(|k, _| !looks_like_account_id(k) || valid.contains(k));
        changed |= m.len() != before;
    }
    changed.then(|| v.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lum(h: &str) -> f64 {
        let v = |i: usize| {
            let c = u8::from_str_radix(&h[i..i + 2], 16).unwrap() as f64 / 255.0;
            if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * v(1) + 0.7152 * v(3) + 0.0722 * v(5)
    }

    #[test]
    fn palette_is_distinct_and_readable_on_light_and_dark() {
        for (i, a) in ACCOUNT_PALETTE.iter().enumerate() {
            assert!(!ACCOUNT_PALETTE[..i].contains(a), "duplicate {a}");
            let l = lum(a);
            assert!(1.05 / (l + 0.05) >= 3.0, "{a} too light for a white row");
            assert!((l + 0.05) / (lum("#1b1c20") + 0.05) >= 3.0, "{a} too dark for the dark surface");
        }
    }

    #[test]
    fn palette_matches_the_frontend_list() {
        let ts = include_str!("../../src/prefs.ts");
        let start = ts.find("ACCOUNT_PALETTE").expect("ACCOUNT_PALETTE in prefs.ts");
        let block = &ts[start..ts[start..].find("];").unwrap() + start];
        let found: Vec<&str> = block.split('"').skip(1).step_by(2).collect();
        assert_eq!(found, ACCOUNT_PALETTE.to_vec());
    }

    #[test]
    fn new_account_gets_first_unused_color() {
        assert_eq!(pick_account_color([]), ACCOUNT_PALETTE[0]);
        assert_eq!(pick_account_color([Some(ACCOUNT_PALETTE[0])]), ACCOUNT_PALETTE[1]);
        // order of use does not matter; a gap is filled, case and spaces are ignored, custom colors and None are ignored
        let used = [Some("#0F6CBD"), None, Some("#123456"), Some(" #13803c "), Some(ACCOUNT_PALETTE[3])];
        assert_eq!(pick_account_color(used), ACCOUNT_PALETTE[1]);
    }

    #[test]
    fn all_used_picks_least_used_then_earliest() {
        let mut used: Vec<Option<&str>> = ACCOUNT_PALETTE.iter().map(|c| Some(*c)).collect();
        assert_eq!(pick_account_color(used.clone()), ACCOUNT_PALETTE[0]); // all once: earliest
        used.push(Some(ACCOUNT_PALETTE[0]));
        used.push(Some(ACCOUNT_PALETTE[1]));
        assert_eq!(pick_account_color(used.clone()), ACCOUNT_PALETTE[2]); // 0 and 1 used twice
        used.extend(ACCOUNT_PALETTE.iter().skip(2).map(|c| Some(*c)));
        used.retain(|c| *c != Some(ACCOUNT_PALETTE[7]));
        assert_eq!(pick_account_color(used), ACCOUNT_PALETTE[7]);
    }

    #[test]
    fn migrate_is_idempotent() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        migrate(&c).unwrap(); // every ALTER now hits "duplicate column name"
        c.execute("INSERT INTO outbox(id,account_id,payload,send_at,status) VALUES('o','a','{}',0,'pending')", []).unwrap();
    }

    #[test]
    fn only_duplicate_column_errors_are_ignored() {
        let c = Connection::open_in_memory().unwrap();
        c.execute("CREATE TABLE t(a INTEGER)", []).unwrap();
        add_column(&c, "ALTER TABLE t ADD COLUMN b TEXT").unwrap();
        add_column(&c, "ALTER TABLE t ADD COLUMN b TEXT").unwrap();
        assert!(add_column(&c, "ALTER TABLE missing ADD COLUMN b TEXT").is_err());
    }

    fn put_account(c: &Connection, id: &str) {
        c.execute(
            "INSERT INTO accounts(id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username) VALUES(?1,?2,'N','h',993,1,'s',465,'ssl','u')",
            params![id, format!("{id}@x.example")],
        )
        .unwrap();
    }

    fn count(c: &Connection, sql: &str) -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    const GONE: &str = "e079e7e1-42ea-4a5b-bddc-c68316d66182";
    const LIVE: &str = "11111111-2222-4333-8444-555555555555";

    fn seed_for(c: &Connection, id: &str) {
        c.execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,'inbox',1,?3,'s','n','e@x.y','','',0,'')", params![format!("{id}:m"), id, format!("t-{id}")]).unwrap();
        c.execute("INSERT INTO thread_meta(thread_id,pinned) VALUES(?1,1)", [format!("t-{id}")]).unwrap();
        c.execute("INSERT INTO outbox(id,account_id,payload,send_at) VALUES(?1,?2,'{}',1)", params![format!("o-{id}"), id]).unwrap();
        c.execute("INSERT INTO pgp_default(account_id,fingerprint) VALUES(?1,'ABCD')", [id]).unwrap();
        c.execute("INSERT INTO events(id,uid,calendar_id,account_id,summary,starts_at,ends_at) VALUES(?1,?1,?2,?3,'e',1,2)", params![format!("ev-{id}"), format!("invites:{id}"), id]).unwrap();
        c.execute("INSERT INTO rules(id,name,field,op,value,action,account_id) VALUES(?1,'r','from','is','x','archive',?2)", params![format!("r-{id}"), id]).unwrap();
        c.execute("INSERT INTO signatures(id,name,html,account_id) VALUES(?1,'s','<p>x</p>',?2)", params![format!("s-{id}"), id]).unwrap();
        c.execute("INSERT INTO templates(id,name,subject,body,account_id) VALUES(?1,'t','s','b',?2)", params![format!("tp-{id}"), id]).unwrap();
        set_setting(c, &format!("fmap:{id}"), "{\"inbox\":\"INBOX\"}").unwrap();
    }

    /// Rows and settings that name `id`, over every table that has per-account data.
    fn rows_for(c: &Connection, id: &str) -> i64 {
        let tables = ["messages", "outbox", "pgp_default", "events", "rules", "signatures", "templates"];
        tables.iter().map(|t| count(c, &format!("SELECT COUNT(*) FROM {t} WHERE account_id='{id}'"))).sum::<i64>()
            + count(c, &format!("SELECT COUNT(*) FROM settings WHERE key='fmap:{id}'"))
            + count(c, &format!("SELECT COUNT(*) FROM thread_meta WHERE thread_id='t-{id}'"))
            + count(c, &format!("SELECT COUNT(*) FROM events WHERE calendar_id='invites:{id}'"))
    }

    #[test]
    fn removing_an_account_removes_every_row_and_setting_that_names_it() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        put_account(&c, GONE);
        put_account(&c, LIVE);
        seed_for(&c, GONE);
        seed_for(&c, LIVE);
        set_setting(&c, "cal_hidden", &format!("[\"local\",\"invites:{GONE}\",\"invites:{LIVE}\"]")).unwrap();
        set_setting(
            &c,
            "prefs",
            &format!(r#"{{"theme":"dark","defaultAccount":"{GONE}","accountPrefs":{{"{GONE}":{{"autoCc":"x"}},"{LIVE}":{{"autoCc":"y"}}}},"favorites":["*|inbox","{GONE}|sent","{LIVE}|sent"],"collapsed":{{"fav":true,"{GONE}":true,"{LIVE}":true}}}}"#),
        )
        .unwrap();
        assert!(rows_for(&c, GONE) > 0);
        remove_account(&c, GONE).unwrap();
        assert_eq!(rows_for(&c, GONE), 0, "nothing of the removed account is left");
        assert!(rows_for(&c, LIVE) >= 9, "the other account keeps everything");
        let hidden: Vec<String> = serde_json::from_str(&get_setting(&c, "cal_hidden").unwrap()).unwrap();
        assert_eq!(hidden, vec!["local".to_string(), format!("invites:{LIVE}")]);
        let p: serde_json::Value = serde_json::from_str(&get_setting(&c, "prefs").unwrap()).unwrap();
        assert_eq!(p["defaultAccount"], "");
        assert_eq!(p["theme"], "dark");
        assert!(p["accountPrefs"].get(GONE).is_none() && p["accountPrefs"].get(LIVE).is_some());
        assert_eq!(p["favorites"], serde_json::json!(["*|inbox", format!("{LIVE}|sent")]));
        assert!(p["collapsed"].get(GONE).is_none() && p["collapsed"].get(LIVE).is_some() && p["collapsed"].get("fav").is_some());
    }

    #[test]
    fn leftovers_of_an_account_removed_earlier_are_cleaned_on_start() {
        // a database where the account row is already gone (older version, interrupted removal): orphans + a stale default
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        put_account(&c, LIVE);
        seed_for(&c, GONE); // no account row for GONE
        set_setting(&c, "prefs", &format!(r#"{{"defaultAccount":"{GONE}"}}"#)).unwrap();
        assert!(rows_for(&c, GONE) > 0);
        assert!(prune_orphans(&c).unwrap() > 0);
        assert_eq!(rows_for(&c, GONE), 0);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&get_setting(&c, "prefs").unwrap()).unwrap()["defaultAccount"], "");
        // a second run finds nothing, and a valid default account is left alone
        assert_eq!(prune_orphans(&c).unwrap(), 0);
        set_setting(&c, "prefs", &format!(r#"{{"defaultAccount":"{LIVE}"}}"#)).unwrap();
        assert_eq!(prune_orphans(&c).unwrap(), 0);
        assert!(get_setting(&c, "prefs").unwrap().contains(LIVE));
        // events without an account (a plain local event) survive
        c.execute("INSERT INTO events(id,uid,calendar_id,summary,starts_at,ends_at) VALUES('solo','solo','local','e',1,2)", []).unwrap();
        prune_orphans(&c).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE id='solo'"), 1);
    }

    #[test]
    fn clean_prefs_ignores_garbage_and_valid_prefs() {
        let valid: std::collections::HashSet<String> = [LIVE.to_string()].into_iter().collect();
        assert!(clean_prefs("not json", &valid).is_none());
        assert!(clean_prefs("[1,2]", &valid).is_none());
        assert!(clean_prefs("{}", &valid).is_none());
        assert!(clean_prefs(&format!(r#"{{"defaultAccount":"{LIVE}","favorites":["*|inbox"],"accountPrefs":{{}}}}"#), &valid).is_none());
        assert!(clean_prefs(r#"{"defaultAccount":""}"#, &valid).is_none());
    }
}
