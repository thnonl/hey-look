//! F-14: archive / delete / junk when the target folder is missing or the saved folder list is out of date, against a fake IMAP server.
//! The saved list (`fmap:<account>`) is refreshed only by a sync; an action used to trust it, so an Archive that appeared during the
//! session stayed unknown, one that was removed gave a raw server error, and nothing ever created a missing one.
use super::*;
use crate::fakeimap::Fake;

const ACC: &str = "a1";

fn account() -> Account {
    Account {
        id: ACC.into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
        smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
        smtp_username: String::new(), tls_insecure: false,
    }
}

/// A database with the account, its saved folder list `fmap`, and one inbox message per UID (thread `t<uid>`).
fn setup(tag: &str, fmap: &str, inbox: &[u32]) -> (Db, Account) {
    let db = quit_tests::test_db(tag);
    let acc = account();
    db::insert_account(&lock(&db), &acc).unwrap();
    db::set_setting(&lock(&db), &format!("fmap:{ACC}"), fmap).unwrap();
    for uid in inbox {
        lock(&db)
            .execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,'inbox',?3,?4,'hello','n','peer@example.com','','',1,'')",
                params![format!("m{uid}"), ACC, uid, format!("t{uid}")],
            )
            .unwrap();
    }
    (db, acc)
}

fn run(db: &Db, acc: &Account, fake: &Fake, uid: u32, action: &str, create_missing: bool) -> R<()> {
    let mut s = fake.connect();
    let list = thread_msgs(&lock(db), &[format!("t{uid}")]).unwrap();
    let dst = matches!(action, "archive" | "trash" | "junk" | "inbox").then_some(action);
    let done = act_on_session(db, acc, &mut s, &list, action, dst, &Some("inbox".to_string()), create_missing);
    let _ = s.logout();
    done
}

fn local_folder(db: &Db, uid: u32) -> Option<String> {
    lock(db).query_row("SELECT folder FROM messages WHERE id=?1", [format!("m{uid}")], |r| r.get(0)).ok()
}

fn saved(db: &Db) -> HashMap<String, String> {
    fmap(db, ACC)
}

fn sent(fake: &Fake, word: &str) -> usize {
    fake.commands().iter().filter(|c| c.to_uppercase().starts_with(word)).count()
}

const NO_ARCHIVE: &str = r#"{"inbox":"INBOX","sent":"Sent"}"#;

#[test]
fn a_missing_archive_is_created_and_the_mail_is_moved() {
    test_guard::within(60, || {
        let (db, acc) = setup("f14-create", NO_ARCHIVE, &[1, 2, 3]);
        let fake = Fake::start(&[("INBOX", &[1, 2, 3]), ("Sent", &[])]);
        run(&db, &acc, &fake, 2, "archive", true).unwrap();
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1), "Archive was created and holds the mail");
        assert_eq!(fake.uids("INBOX"), Some(vec![1, 3]));
        assert_eq!(sent(&fake, "CREATE"), 1);
        assert_eq!(local_folder(&db, 2), None, "the local copy goes only after the server moved it");
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"));
        assert_eq!(saved(&db).get("archive").map(String::as_str), Some("Archive"), "the saved list knows it now");
    });
}

#[test]
fn a_missing_trash_is_created_but_the_servers_own_trash_is_used_when_there_is_one() {
    test_guard::within(60, || {
        // no trash at all: Trash is made
        let (db, acc) = setup("f14-trash-create", NO_ARCHIVE, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2])]);
        run(&db, &acc, &fake, 1, "trash", true).unwrap();
        assert_eq!(fake.uids("Trash").map(|u| u.len()), Some(1));
        assert_eq!(fake.uids("INBOX"), Some(vec![2]));
        // the saved list lacks the trash but the server has "Deleted Items" (SPECIAL-USE): no folder is made
        let (db, acc) = setup("f14-trash-found", NO_ARCHIVE, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2]), ("Deleted Items", &[])]);
        fake.state.lock().unwrap().special.insert("Deleted Items".into(), "\\Trash".into());
        run(&db, &acc, &fake, 1, "trash", true).unwrap();
        assert_eq!(fake.uids("Deleted Items").map(|u| u.len()), Some(1));
        assert_eq!(sent(&fake, "CREATE"), 0);
        assert!(!fake.has_folder("Trash"));
    });
}

#[test]
fn when_the_folder_cannot_be_created_the_action_fails_clearly_and_nothing_changes() {
    test_guard::within(60, || {
        let (db, acc) = setup("f14-refused", NO_ARCHIVE, &[1, 2, 3]);
        let fake = Fake::start(&[("INBOX", &[1, 2, 3])]);
        fake.state.lock().unwrap().refuse_create = true;
        let e = run(&db, &acc, &fake, 2, "archive", true).unwrap_err();
        assert!(e.starts_with("FOLDER_NOT_CREATED|folder=Archive|why="), "{e}");
        assert!(e.contains("Couldn’t find or create the Archive folder on this account"), "{e}");
        assert_eq!(fake.uids("INBOX"), Some(vec![1, 2, 3]), "the mail is still on the server");
        assert_eq!(local_folder(&db, 2).as_deref(), Some("inbox"), "and still listed in the Inbox here");
        assert_eq!(sent(&fake, "UID MOVE") + sent(&fake, "UID COPY"), 0, "nothing was moved or copied");
        assert!(!fake.has_folder("Archive"));
    });
}

#[test]
fn a_folder_that_appears_later_works_in_the_same_session() {
    test_guard::within(60, || {
        // the QA sequence: the folder is missing (and cannot be made), then it is there, the app is not restarted
        let (db, acc) = setup("f14-later", NO_ARCHIVE, &[1, 2, 3]);
        let fake = Fake::start(&[("INBOX", &[1, 2, 3])]);
        fake.state.lock().unwrap().refuse_create = true;
        assert!(run(&db, &acc, &fake, 1, "archive", true).is_err());
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"));
        fake.put_folder("Archive", &[]);
        let creates = sent(&fake, "CREATE");
        run(&db, &acc, &fake, 2, "archive", true).unwrap();
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
        assert_eq!(fake.uids("INBOX"), Some(vec![1, 3]));
        assert_eq!(sent(&fake, "CREATE"), creates, "found by LIST, not created");
        // and the earlier mail can be archived now too
        run(&db, &acc, &fake, 1, "archive", true).unwrap();
        assert_eq!(fake.uids("INBOX"), Some(vec![3]));
        assert_eq!(local_folder(&db, 1), None);
    });
}

#[test]
fn a_saved_name_that_the_server_no_longer_has_is_replaced_from_a_fresh_list() {
    test_guard::within(60, || {
        // the saved list says "Archive", the server now calls it "Archives" (found by name): the move goes there, nothing is created
        let (db, acc) = setup("f14-renamed", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2]), ("Archives", &[])]);
        run(&db, &acc, &fake, 1, "archive", true).unwrap();
        assert_eq!(fake.uids("Archives").map(|u| u.len()), Some(1));
        assert_eq!(sent(&fake, "CREATE"), 0);
        assert_eq!(saved(&db).get("archive").map(String::as_str), Some("Archives"));
        // the saved list says "Archive" and the server has nothing like it (renamed away): it is made again
        let (db, acc) = setup("f14-gone", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2]), ("Archive-off", &[])]);
        run(&db, &acc, &fake, 2, "archive", true).unwrap();
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
        assert_eq!(fake.uids("Archive-off"), Some(vec![]));
        assert_eq!(fake.uids("INBOX"), Some(vec![1]));
    });
}

#[test]
fn the_usual_case_asks_the_server_for_nothing_extra() {
    test_guard::within(60, || {
        for no_move in [false, true] {
            let (db, acc) = setup("f14-normal", r#"{"inbox":"INBOX","archive":"Archive","trash":"Trash"}"#, &[1, 2]);
            let fake = Fake::start(&[("INBOX", &[1, 2]), ("Archive", &[]), ("Trash", &[])]);
            fake.state.lock().unwrap().no_move = no_move;
            run(&db, &acc, &fake, 1, "archive", true).unwrap();
            run(&db, &acc, &fake, 2, "trash", true).unwrap();
            assert_eq!(fake.uids("INBOX"), Some(vec![]));
            assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
            assert_eq!(fake.uids("Trash").map(|u| u.len()), Some(1));
            assert_eq!(sent(&fake, "LIST") + sent(&fake, "CREATE"), 0, "no LIST and no CREATE when the saved folder works (MOVE absent: {no_move})");
            assert_eq!((local_folder(&db, 1), local_folder(&db, 2)), (None, None));
        }
    });
}

#[test]
fn junk_and_folders_the_person_made_are_never_created() {
    test_guard::within(60, || {
        let (db, acc) = setup("f14-junk", NO_ARCHIVE, &[1]);
        let fake = Fake::start(&[("INBOX", &[1])]);
        let e = run(&db, &acc, &fake, 1, "junk", true).unwrap_err();
        assert!(e.starts_with("FOLDER_MISSING|folder=Junk: Couldn’t find the Junk folder on this account."), "{e}");
        assert_eq!(sent(&fake, "CREATE"), 0);
        assert_eq!(fake.uids("INBOX"), Some(vec![1]));
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"));
    });
}

#[test]
fn a_filter_does_not_create_folders_and_keeps_the_old_message() {
    test_guard::within(60, || {
        // REQ-52 / AC-66: the filter fails visibly, the message stays; now after a fresh look at the server
        let (db, acc) = setup("f14-filter", NO_ARCHIVE, &[1]);
        let fake = Fake::start(&[("INBOX", &[1])]);
        let rules = vec![Rule { id: "r".into(), name: "QA-M8".into(), field: "subject".into(), op: "contains".into(), value: "hello".into(), action: "archive".into(), arg: None, enabled: true, account_id: None }];
        let msgs = vec![("t1".to_string(), "peer@example.com".to_string(), String::new(), "hello".to_string())];
        let out = apply_rules(&rules, &msgs, &mut |r, tid| {
            let uid: u32 = tid[1..].parse().unwrap();
            run(&db, &acc, &fake, uid, &r.action, false)
        });
        assert!(out.moved.is_empty());
        assert_eq!(out.errors, vec!["Filter “QA-M8” couldn’t run on new mail: no 'archive' folder on this account".to_string()]);
        assert_eq!(sent(&fake, "CREATE"), 0);
        assert_eq!(fake.uids("INBOX"), Some(vec![1]));
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"));
        // the folder exists on the server but the saved list does not know it yet: the filter finds it
        fake.put_folder("Archive", &[]);
        let out = apply_rules(&rules, &msgs, &mut |r, _| run(&db, &acc, &fake, 1, &r.action, false));
        assert!(out.errors.is_empty() && out.moved.contains("t1"), "{:?}", out.errors);
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
    });
}

#[test]
fn a_server_that_keeps_its_folders_in_the_inbox_namespace_gets_inbox_dot_archive() {
    test_guard::within(60, || {
        let (db, acc) = setup("f14-ns", NO_ARCHIVE, &[1]);
        let fake = Fake::start(&[("INBOX", &[1]), ("INBOX.Sent", &[])]);
        fake.state.lock().unwrap().delimiter = ".".into();
        run(&db, &acc, &fake, 1, "archive", true).unwrap();
        assert_eq!(fake.uids("INBOX.Archive").map(|u| u.len()), Some(1));
        assert!(!fake.has_folder("Archive"));
        // a flat or top-level server gets the plain name
        let l = |names: &[&str], d: Option<&str>| mail::Listing { map: names.iter().map(|n| (format!("f:{n}"), n.to_string())).collect(), delimiter: d.map(str::to_string) };
        assert_eq!(mail::name_to_create("archive", &l(&["Sent", "Work"], Some("/"))).as_deref(), Some("Archive"));
        assert_eq!(mail::name_to_create("trash", &l(&["INBOX/Sent"], Some("/"))).as_deref(), Some("INBOX/Trash"));
        assert_eq!(mail::name_to_create("trash", &l(&[], None)).as_deref(), Some("Trash"));
        assert_eq!(mail::name_to_create("junk", &l(&[], None)), None);
        assert_eq!(mail::name_to_create("f:Work", &l(&[], None)), None);
    });
}

#[test]
fn a_failure_that_is_not_about_the_folder_is_reported_as_it_is_and_the_mail_stays() {
    test_guard::within(60, || {
        let (db, acc) = setup("f14-other", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[1]);
        let fake = Fake::start(&[("INBOX", &[1]), ("Archive", &[])]);
        fake.state.lock().unwrap().fail_moves = true;
        let e = run(&db, &acc, &fake, 1, "archive", true).unwrap_err();
        assert!(e.contains("quota exceeded") && !e.starts_with("FOLDER_"), "{e}");
        assert_eq!(sent(&fake, "CREATE"), 0, "the folder exists: nothing is created");
        assert_eq!(fake.uids("INBOX"), Some(vec![1]));
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"));
    });
}
