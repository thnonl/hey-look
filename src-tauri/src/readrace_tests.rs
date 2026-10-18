//! F-16 / F-17: a sync that read the flags of a message before a read / unread action reached the server must not write them over the
//! action's own state afterwards (the mail "flipped back to unread" until the next sync). Against a fake IMAP server, with the order of
//! the two made explicit: the sync reads first (`started`), the action runs, then the sync writes.
use super::*;
use crate::fakeimap::Fake;

const ACC: &str = "a-race";

fn account() -> Account {
    Account {
        id: ACC.into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
        smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
        smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
    }
}

/// One inbox message per UID (thread `t<uid>`), read state `seen`.
fn setup(tag: &str, uids: &[u32], seen: bool) -> (Db, Account) {
    let db = quit_tests::test_db(tag);
    let acc = account();
    db::insert_account(&lock(&db), &acc).unwrap();
    db::set_setting(&lock(&db), &format!("fmap:{ACC}"), r#"{"inbox":"INBOX"}"#).unwrap();
    for uid in uids {
        lock(&db)
            .execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,seen) VALUES(?1,?2,'inbox',?3,?4,'hello','n','peer@example.com','','',1,'',?5)",
                params![format!("m{uid}"), ACC, uid, format!("t{uid}"), seen as i64],
            )
            .unwrap();
    }
    (db, acc)
}

fn act(db: &Db, acc: &Account, fake: &Fake, uid: u32, action: &str) {
    let mut s = fake.connect();
    let list = thread_msgs(&lock(db), &[format!("t{uid}")]).unwrap();
    act_on_session(db, acc, &mut s, &list, action, None, &Some("inbox".to_string()), false).unwrap();
    let _ = s.logout();
}

fn seen(db: &Db, uid: u32) -> bool {
    lock(db).query_row("SELECT seen FROM messages WHERE id=?1", [format!("m{uid}")], |r| r.get::<_, i64>(0)).unwrap() != 0
}

fn sync_writes(db: &Db, started: u64, flags: &[(u32, bool, bool)]) {
    apply_server_flags(&lock(db), &flagguard::GUARD, started, ACC, "inbox", flags).unwrap();
}

#[test]
fn a_sync_that_read_the_flags_before_a_mark_read_does_not_undo_it() {
    test_guard::within(60, || {
        let (db, acc) = setup("f17-stale-sync", &[1, 2], false);
        let fake = Fake::start(&[("INBOX", &[1, 2])]);
        // the sync reads the server's flags: both unread
        let started = flagguard::GUARD.epoch();
        let read_by_sync = [(1, false, false), (2, false, false)];
        // meanwhile the person reads mail 1 (server first, then the row)
        act(&db, &acc, &fake, 1, "read");
        assert!(seen(&db, 1));
        // the sync now writes what it read: mail 1 must stay read, mail 2 (untouched) takes the server's state
        sync_writes(&db, started, &read_by_sync);
        assert!(seen(&db, 1), "the older answer of the sync did not undo the mark-as-read");
        assert!(!seen(&db, 2));
        // a sync that began after the action reads the new state and is trusted again
        let later = flagguard::GUARD.epoch();
        sync_writes(&db, later, &[(1, true, false)]);
        assert!(seen(&db, 1));
        sync_writes(&db, later, &[(1, false, false)]);
        assert!(!seen(&db, 1), "a later sync is the truth (the mail was marked unread on another device)");
    });
}

#[test]
fn a_mark_unread_stays_unread_against_a_stale_sync_too() {
    test_guard::within(60, || {
        let (db, acc) = setup("f16-stale-sync-unread", &[5], true);
        let fake = Fake::start(&[("INBOX", &[5])]);
        let started = flagguard::GUARD.epoch();
        act(&db, &acc, &fake, 5, "unread");
        assert!(!seen(&db, 5));
        sync_writes(&db, started, &[(5, true, false)]);
        assert!(!seen(&db, 5));
    });
}
