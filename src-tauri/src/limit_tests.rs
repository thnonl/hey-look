//! 1.0.7 W6.3: lowering the download limit removes the extra local mail at once (never what is open, flagged, pinned, a draft or the newest of a folder), raising it removes nothing.
use super::*;

const ACC: &str = "a-limit";

fn setup(tag: &str, n: u32) -> Db {
    let db = quit_tests::test_db(tag);
    let acc = Account {
        id: ACC.into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
        smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
        smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
    };
    db::insert_account(&lock(&db), &acc).unwrap();
    for uid in 1..=n {
        lock(&db)
            .execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,'inbox',?3,?4,'hello','n','peer@example.com','','',?5,'')",
                params![format!("{ACC}:inbox:{uid}"), ACC, uid, format!("t{uid}"), uid as i64],
            )
            .unwrap();
    }
    db
}

fn has(db: &Db, uid: u32) -> bool {
    lock(db).query_row("SELECT 1 FROM messages WHERE id=?1", [format!("{ACC}:inbox:{uid}")], |_| Ok(())).is_ok()
}

#[test]
fn lowering_the_limit_prunes_at_once_and_keeps_open_conversations() {
    let db = setup("w63-lower", 130);
    lock(&db).execute("UPDATE messages SET flagged=1 WHERE uid=5", []).unwrap();
    lock(&db).execute("INSERT INTO thread_meta(thread_id,pinned) VALUES('t6',1)", []).unwrap();
    lock(&db).execute("INSERT INTO thread_meta(thread_id,snoozed_until) VALUES('t7',4102444800)", []).unwrap();
    lock(&db).execute("UPDATE messages SET folder='drafts', id=?1 WHERE uid=8", [format!("{ACC}:drafts:8")]).unwrap();
    db::set_setting(&lock(&db), "max_download", "100").unwrap();
    // the conversation open in the reading pane is the OLDEST one
    let done = prune_all_to_limit(&db, &["t1".to_string()]).unwrap();
    assert_eq!(done, vec![(ACC.to_string(), 30, true)], "30 over the cap went, and the mailbox is at the cap now");
    assert_eq!(account_total(&db, ACC).unwrap(), 100);
    for uid in [1, 5, 6, 7, 130] {
        assert!(has(&db, uid), "{uid}: the open conversation, a flagged, a pinned, a snoozed message and the newest one stay");
    }
    assert!(lock(&db).query_row("SELECT 1 FROM messages WHERE id=?1", [format!("{ACC}:drafts:8")], |_| Ok(())).is_ok(), "a draft stays");
    assert!(!has(&db, 2) && !has(&db, 3) && !has(&db, 4) && !has(&db, 9), "the oldest of the rest went");
    assert!(has(&db, 129), "the newer mail stays");
    // asked again: nothing more to remove, still at the cap
    assert_eq!(prune_all_to_limit(&db, &[]).unwrap(), vec![(ACC.to_string(), 0, true)]);
}

#[test]
fn raising_the_limit_prunes_nothing() {
    let db = setup("w63-raise", 130);
    db::set_setting(&lock(&db), "max_download", "5000").unwrap();
    assert_eq!(prune_all_to_limit(&db, &[]).unwrap(), vec![(ACC.to_string(), 0, false)]);
    assert_eq!(account_total(&db, ACC).unwrap(), 130);
    // the same count and a cap equal to it: at the cap, nothing removed
    db::set_setting(&lock(&db), "max_download", "100").unwrap();
    let db2 = setup("w63-equal", 100);
    db::set_setting(&lock(&db2), "max_download", "100").unwrap();
    assert_eq!(prune_all_to_limit(&db2, &[]).unwrap(), vec![(ACC.to_string(), 0, true)]);
}

#[test]
fn the_page_and_the_backend_are_wired_for_the_prune() {
    let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let cmd = &lib[lib.find("async fn prune_to_limit").unwrap()..];
    let cmd = &cmd[..cmd.find("\n}\n").unwrap()];
    assert!(cmd.contains("popout::reader_keys(&app)"), "the reader windows' conversations are kept: {cmd}");
    assert!(cmd.contains("\"mail-pruned\"") && cmd.contains("\"mail-synced\""));
    // the sync tells the page when its mailbox is at the cap
    let run = &lib[lib.find("fn run_sync_inner").unwrap()..];
    let run = &run[..run.find("\n}\n").unwrap()];
    assert!(run.contains("emit_to(\"main\", \"mail-pruned\""), "{run}");
}

// ---- W6.2: a filter "Move to Junk" on a mailbox without a Junk folder

fn rule(name: &str, action: &str) -> Rule {
    Rule { id: name.into(), account_id: None, name: name.into(), field: "from".into(), op: "contains".into(), value: "x".into(), action: action.into(), arg: None, enabled: true }
}

#[test]
fn a_junk_filter_skips_a_mailbox_without_junk_without_an_error() {
    let rules = vec![rule("a", "archive"), rule("b", "junk"), rule("c", "star"), rule("d", "junk")];
    // a mailbox with a Junk folder: every filter runs
    let (kept, skipped) = usable_rules(rules.clone(), true);
    assert_eq!((kept.len(), skipped), (4, 0));
    // without: the two Junk filters are left out, the others run; no error is made (nothing to report)
    let (kept, skipped) = usable_rules(rules.clone(), false);
    assert_eq!(kept.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
    assert_eq!(skipped, 2);
    let msgs = vec![("t1".to_string(), "x@y.z".to_string(), String::new(), "s".to_string())];
    let out = apply_rules(&kept, &msgs, &mut |_, _| Ok(()));
    assert!(out.errors.is_empty(), "{:?}", out.errors);
    // a mailbox whose only filter moves to Junk: nothing runs, the mail stays in the Inbox
    let (only, skipped) = usable_rules(vec![rule("j", "junk")], false);
    assert!(only.is_empty() && skipped == 1);
    let out = apply_rules(&only, &msgs, &mut |_, _| panic!("no filter runs"));
    assert!(out.errors.is_empty() && out.moved.is_empty());
    // the sync reads the saved list refreshed at its start, so a Junk folder that appeared makes the filter work again with no change
    let src = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let sync = &src[src.find("fn sync_impl").unwrap()..src.find("fn usable_rules").unwrap()];
    assert!(sync.contains("usable_rules(rules, map.contains_key(\"junk\"))"), "{sync}");
}
