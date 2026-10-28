//! The senders whose remote content always loads (1.0.10, spec ba-v1010-trusted-senders-images.md). One global list, kept in the app's database next to
//! `blocked`: the exact From address, lower case, at most `MAX` of them. The policy that decides whether a message loads its content is in the page
//! (src/trustedSenders.ts); this module is only the list. The address the page sends is already in Unicode normal form C (NFC); here it is trimmed and
//! lower-cased, and has to be one `@` with something on both sides, at most 320 characters.
use rusqlite::{params, Connection};
use serde::Serialize;

/// The list holds at most this many addresses (it is loaded into the page whole).
pub const MAX: usize = 1000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub email: String,
    /// when it was added (ms since the epoch)
    pub added: i64,
}

/// The stored form of an address, or `None` when it is not one the list takes.
pub fn normalize(raw: &str) -> Option<String> {
    let e = raw.trim().to_lowercase();
    if e.is_empty() || e.chars().count() > 320 || e.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let mut parts = e.split('@');
    let (local, domain, rest) = (parts.next()?, parts.next()?, parts.next());
    if rest.is_some() || local.is_empty() || domain.is_empty() {
        return None;
    }
    Some(e)
}

pub fn list(c: &Connection) -> rusqlite::Result<Vec<Entry>> {
    let mut st = c.prepare("SELECT email, added FROM remote_ok ORDER BY email")?;
    let rows = st.query_map([], |r| Ok(Entry { email: r.get(0)?, added: r.get(1)? }))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// What `add` did: the address is new, was there already (nothing changes, the first date stays), or the list is full.
#[derive(Debug, PartialEq, Eq)]
pub enum Added {
    New,
    Already,
    Full,
}

pub fn add(c: &Connection, raw: &str, now_ms: i64) -> Result<Added, String> {
    let email = normalize(raw).ok_or_else(|| "this is not an address the list can take".to_string())?;
    let sql_err = |e: rusqlite::Error| e.to_string();
    let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM remote_ok WHERE email=?1)", [&email], |r| r.get(0)).map_err(sql_err)?;
    if exists {
        return Ok(Added::Already);
    }
    let n: i64 = c.query_row("SELECT COUNT(*) FROM remote_ok", [], |r| r.get(0)).map_err(sql_err)?;
    if n as usize >= MAX {
        return Ok(Added::Full);
    }
    c.execute("INSERT OR IGNORE INTO remote_ok(email, added) VALUES(?1, ?2)", params![email, now_ms]).map_err(sql_err)?;
    // "always show" and "not automatically" contradict each other: the newer choice wins
    c.execute("DELETE FROM remote_noauto WHERE email=?1", [&email]).map_err(sql_err)?;
    Ok(Added::New)
}

/// The senders whose pictures are NOT shown automatically (the list of the people you wrote to / well-known services the person turned off): same form as the list above.
pub fn noauto_list(c: &Connection) -> rusqlite::Result<Vec<Entry>> {
    let mut st = c.prepare("SELECT email, added FROM remote_noauto ORDER BY email")?;
    let rows = st.query_map([], |r| Ok(Entry { email: r.get(0)?, added: r.get(1)? }))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn noauto_add(c: &Connection, raw: &str, now_ms: i64) -> Result<Added, String> {
    let email = normalize(raw).ok_or_else(|| "this is not an address the list can take".to_string())?;
    let sql_err = |e: rusqlite::Error| e.to_string();
    let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM remote_noauto WHERE email=?1)", [&email], |r| r.get(0)).map_err(sql_err)?;
    if exists {
        return Ok(Added::Already);
    }
    let n: i64 = c.query_row("SELECT COUNT(*) FROM remote_noauto", [], |r| r.get(0)).map_err(sql_err)?;
    if n as usize >= MAX {
        return Ok(Added::Full);
    }
    c.execute("INSERT OR IGNORE INTO remote_noauto(email, added) VALUES(?1, ?2)", params![email, now_ms]).map_err(sql_err)?;
    // the two lists would contradict each other
    c.execute("DELETE FROM remote_ok WHERE email=?1", [&email]).map_err(sql_err)?;
    Ok(Added::New)
}

pub fn noauto_remove(c: &Connection, raw: &str) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM remote_noauto WHERE email=?1", [raw.trim()])
}

pub fn remove(c: &Connection, raw: &str) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM remote_ok WHERE email=?1", [raw.trim()])
}

pub fn clear(c: &Connection) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM remote_ok", [])
}

/// Blocking a sender takes the address off the list (the two lists would contradict each other). `from_email` values of the messages are matched without case.
pub fn forget_blocked(c: &Connection) -> rusqlite::Result<usize> {
    let _ = c.execute("DELETE FROM remote_noauto WHERE email IN (SELECT lower(trim(email)) FROM blocked)", []);
    c.execute("DELETE FROM remote_ok WHERE email IN (SELECT lower(trim(email)) FROM blocked)", [])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c
    }

    #[test]
    fn an_address_is_trimmed_lower_cased_and_must_be_one_address() {
        assert_eq!(normalize("  A@Example.COM "), Some("a@example.com".into()));
        assert_eq!(normalize("a+News@x.org"), Some("a+news@x.org".into()), "+tag is part of the address");
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize("no-at-sign"), None);
        assert_eq!(normalize("a@b@c"), None);
        assert_eq!(normalize("@x.org"), None);
        assert_eq!(normalize("a@"), None);
        assert_eq!(normalize("a b@x.org"), None);
        let long = format!("{}@x.org", "a".repeat(320));
        assert_eq!(normalize(&long), None, "more than 320 characters");
        let ok = format!("{}@x.org", "a".repeat(314));
        assert_eq!(normalize(&ok).map(|s| s.chars().count()), Some(320));
    }

    #[test]
    fn add_is_idempotent_without_case_and_keeps_the_first_date() {
        let c = db();
        assert_eq!(add(&c, "A@Example.COM", 100).unwrap(), Added::New);
        assert_eq!(add(&c, "a@example.com", 200).unwrap(), Added::Already);
        assert_eq!(add(&c, " a@EXAMPLE.com ", 300).unwrap(), Added::Already);
        assert_eq!(list(&c).unwrap(), vec![Entry { email: "a@example.com".into(), added: 100 }]);
        assert!(add(&c, "nonsense", 1).is_err());
        assert_eq!(list(&c).unwrap().len(), 1);
    }

    #[test]
    fn the_list_is_sorted_removed_one_by_one_and_cleared() {
        let c = db();
        for (e, t) in [("b@x.org", 2), ("a@x.org", 1), ("c@x.org", 3)] {
            add(&c, e, t).unwrap();
        }
        assert_eq!(list(&c).unwrap().iter().map(|e| e.email.as_str()).collect::<Vec<_>>(), ["a@x.org", "b@x.org", "c@x.org"]);
        assert_eq!(remove(&c, "B@X.org").unwrap(), 1, "without case");
        assert_eq!(remove(&c, "b@x.org").unwrap(), 0);
        assert_eq!(clear(&c).unwrap(), 2);
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn the_1001st_address_is_refused_and_the_list_does_not_change() {
        let c = db();
        for i in 0..MAX {
            assert_eq!(add(&c, &format!("u{i}@x.org"), i as i64).unwrap(), Added::New);
        }
        assert_eq!(add(&c, "one-more@x.org", 5000).unwrap(), Added::Full);
        assert_eq!(list(&c).unwrap().len(), MAX);
        assert_eq!(add(&c, "U7@x.org", 5000).unwrap(), Added::Already, "an address that is on the list is not 'full'");
        remove(&c, "u0@x.org").unwrap();
        assert_eq!(add(&c, "one-more@x.org", 5000).unwrap(), Added::New);
    }

    #[test]
    fn blocking_a_sender_takes_it_off_the_list() {
        let c = db();
        add(&c, "x@shop.example", 1).unwrap();
        add(&c, "y@shop.example", 2).unwrap();
        c.execute("INSERT INTO blocked(email) VALUES('X@Shop.example')", []).unwrap();
        assert_eq!(forget_blocked(&c).unwrap(), 1);
        assert_eq!(list(&c).unwrap().iter().map(|e| e.email.as_str()).collect::<Vec<_>>(), ["y@shop.example"]);
    }

    #[test]
    fn a_database_from_before_the_list_gets_the_table_and_keeps_its_data() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE blocked(email TEXT PRIMARY KEY); INSERT INTO blocked VALUES('old@x.org');").unwrap();
        migrate_only(&c);
        assert!(list(&c).unwrap().is_empty(), "the table exists and is empty");
        let n: i64 = c.query_row("SELECT COUNT(*) FROM blocked", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the other data stays");
        migrate_only(&c); // a second start changes nothing
    }

    #[test]
    fn the_sender_check_reaches_the_page_as_pass_fail_or_nothing() {
        assert_eq!(crate::auth_for_page(Some("pass".into())).as_deref(), Some("pass"));
        assert_eq!(crate::auth_for_page(Some("fail".into())).as_deref(), Some("fail"));
        assert_eq!(crate::auth_for_page(None), None);
        assert_eq!(crate::auth_for_page(Some("neutral".into())), None);
    }

    fn migrate_only(c: &Connection) {
        crate::db::migrate(c).unwrap();
    }

    /// T-R5: the list of senders whose pictures are not shown automatically.
    #[test]
    fn the_noauto_list_is_a_list_of_its_own_and_the_two_lists_never_contradict_each_other() {
        let c = db();
        assert_eq!(noauto_add(&c, "A@Example.COM", 100).unwrap(), Added::New);
        assert_eq!(noauto_add(&c, "a@example.com", 200).unwrap(), Added::Already, "without case, once");
        assert_eq!(noauto_list(&c).unwrap(), vec![Entry { email: "a@example.com".into(), added: 100 }]);
        assert!(noauto_add(&c, "nonsense", 1).is_err());
        // "always show" takes the sender off the noauto list, and "not automatically" takes it off the always list
        assert_eq!(add(&c, "a@example.com", 300).unwrap(), Added::New);
        assert!(noauto_list(&c).unwrap().is_empty());
        assert_eq!(list(&c).unwrap().len(), 1);
        assert_eq!(noauto_add(&c, "a@example.com", 400).unwrap(), Added::New);
        assert!(list(&c).unwrap().is_empty());
        assert_eq!(noauto_remove(&c, "A@example.com").unwrap(), 1, "without case");
        assert_eq!(noauto_add(&c, "a@example.com", 450).unwrap(), Added::New);
        assert_eq!(noauto_remove(&c, "a@example.com").unwrap(), 1);
        // the limit
        for i in 0..MAX {
            assert_eq!(noauto_add(&c, &format!("u{i}@x.org"), i as i64).unwrap(), Added::New);
        }
        assert_eq!(noauto_add(&c, "one-more@x.org", 1).unwrap(), Added::Full);
        assert_eq!(noauto_add(&c, "U3@x.org", 1).unwrap(), Added::Already);
        // blocking a sender drops both
        add(&c, "b@x.org", 1).unwrap();
        c.execute("INSERT INTO blocked(email) VALUES('b@x.org'),('u1@x.org')", []).unwrap();
        forget_blocked(&c).unwrap();
        assert!(!list(&c).unwrap().iter().any(|e| e.email == "b@x.org"));
        assert!(!noauto_list(&c).unwrap().iter().any(|e| e.email == "u1@x.org"));
    }
}
