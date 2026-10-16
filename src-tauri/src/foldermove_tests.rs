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

/// QA v1.0.1 round 6, OBS-2: the person renamed the Trash to `Trash-old` and had `Archives`. `Archives` is a standard name and is the
/// archive; `Trash-old`, `Archive 2019` and a `Trash` that sits inside another folder are folders of the person's own: Delete makes a new
/// `Trash`, nothing is moved into a lookalike and no second Archive is made.
#[test]
fn a_folder_that_only_looks_like_the_trash_or_archive_is_not_taken_for_it() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs2-trash", r#"{"inbox":"INBOX"}"#, &[1, 2, 3]);
        let fake = Fake::start(&[("INBOX", &[1, 2, 3]), ("Trash-old", &[]), ("Archives", &[]), ("Archive 2019", &[]), ("Old/Trash", &[]), ("Work/Archive", &[])]);
        run(&db, &acc, &fake, 1, "trash", true).unwrap();
        assert_eq!(fake.uids("Trash").map(|u| u.len()), Some(1), "a new Trash was made");
        assert_eq!(fake.uids("Trash-old"), Some(vec![]));
        assert_eq!(fake.uids("Old/Trash"), Some(vec![]));
        assert_eq!(sent(&fake, "CREATE"), 1);
        run(&db, &acc, &fake, 2, "archive", true).unwrap();
        assert_eq!(fake.uids("Archives").map(|u| u.len()), Some(1), "Archives is the archive");
        assert_eq!(fake.uids("Archive 2019"), Some(vec![]));
        assert_eq!(fake.uids("Work/Archive"), Some(vec![]));
        assert!(!fake.has_folder("Archive"), "no second archive was made");
        assert_eq!(sent(&fake, "CREATE"), 1, "only the Trash was created");
        let s = saved(&db);
        assert_eq!((s.get("trash").map(String::as_str), s.get("archive").map(String::as_str)), (Some("Trash"), Some("Archives")));
        // the lookalikes stay folders of their own
        assert!(["Trash-old", "Archive 2019", "Old/Trash", "Work/Archive"].iter().all(|n| s.get(&format!("f:{n}")).is_some()), "{s:?}");
    });
}

/// A folder the server names in another language is the standard folder (no `Trash` is made next to `Papierkorb`).
#[test]
fn a_localised_standard_folder_is_found_and_no_second_one_is_made() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs2-de", r#"{"inbox":"INBOX"}"#, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2]), ("Papierkorb", &[]), ("Archiv", &[])]);
        run(&db, &acc, &fake, 1, "trash", true).unwrap();
        run(&db, &acc, &fake, 2, "archive", true).unwrap();
        assert_eq!((fake.uids("Papierkorb").map(|u| u.len()), fake.uids("Archiv").map(|u| u.len())), (Some(1), Some(1)));
        assert_eq!(sent(&fake, "CREATE"), 0);
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

const NO_ARCHIVE_NO_SENT: &str = r#"{"inbox":"INBOX"}"#;

// ---- the copy of a sent message (QA v1.0.1 round 6, OBS-5): the same folder rule as Archive and Trash

const RAW: &[u8] = b"From: me@example.com\r\nTo: peer@example.com\r\nSubject: hello\r\n\r\nbody\r\n";

fn store_copy(db: &Db, acc: &Account, fake: &Fake) -> R<()> {
    let mut s = fake.connect();
    let done = store_sent_copy(db, acc, &mut s, RAW);
    let _ = s.logout();
    done
}

fn appended(fake: &Fake) -> Vec<(String, Vec<u8>)> {
    fake.state.lock().unwrap().appended.clone()
}

#[test]
fn a_server_without_a_sent_folder_gets_one_and_the_copy_goes_into_it() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs5-create", NO_ARCHIVE_NO_SENT, &[]);
        let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
        store_copy(&db, &acc, &fake).unwrap();
        assert_eq!(appended(&fake), vec![("Sent".to_string(), RAW.to_vec())]);
        assert_eq!(sent(&fake, "CREATE"), 1);
        assert_eq!(saved(&db).get("sent").map(String::as_str), Some("Sent"), "the saved list knows it now");
        // the next one finds the saved folder: nothing to list or create
        let before = fake.commands().len();
        store_copy(&db, &acc, &fake).unwrap();
        assert_eq!(appended(&fake).len(), 2);
        let after: Vec<String> = fake.commands().into_iter().skip(before).filter(|c| c.to_uppercase().starts_with("LIST") || c.to_uppercase().starts_with("CREATE")).collect();
        assert!(after.is_empty(), "{after:?}");
    });
}

#[test]
fn the_servers_own_sent_folder_is_used_when_the_saved_list_does_not_know_it() {
    test_guard::within(60, || {
        // not saved at all, and named in another way (flagged by the server)
        let (db, acc) = setup("obs5-found", NO_ARCHIVE_NO_SENT, &[]);
        let fake = Fake::start(&[("INBOX", &[]), ("Gesendete Objekte", &[])]);
        store_copy(&db, &acc, &fake).unwrap();
        assert_eq!(appended(&fake).iter().map(|a| a.0.as_str()).collect::<Vec<_>>(), vec!["Gesendete Objekte"]);
        assert_eq!(sent(&fake, "CREATE"), 0);
        // saved "Sent", but the server calls it "Sent Items" now: found by the fresh list
        let (db, acc) = setup("obs5-renamed", r#"{"inbox":"INBOX","sent":"Sent"}"#, &[]);
        let fake = Fake::start(&[("INBOX", &[]), ("Sent Items", &[])]);
        fake.state.lock().unwrap().special.insert("Sent Items".into(), "\\Sent".into());
        store_copy(&db, &acc, &fake).unwrap();
        assert_eq!(appended(&fake).iter().map(|a| a.0.as_str()).collect::<Vec<_>>(), vec!["Sent Items"]);
        assert_eq!(sent(&fake, "CREATE"), 0);
        assert_eq!(saved(&db).get("sent").map(String::as_str), Some("Sent Items"));
        // a lookalike is not the Sent folder: one is made
        let (db, acc) = setup("obs5-lookalike", NO_ARCHIVE_NO_SENT, &[]);
        let fake = Fake::start(&[("INBOX", &[]), ("Sent 2019", &[]), ("Work/Sent", &[])]);
        store_copy(&db, &acc, &fake).unwrap();
        assert_eq!(appended(&fake).iter().map(|a| a.0.as_str()).collect::<Vec<_>>(), vec!["Sent"]);
    });
}

#[test]
fn a_server_that_keeps_its_folders_in_the_inbox_namespace_gets_inbox_dot_sent() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs5-ns", NO_ARCHIVE_NO_SENT, &[]);
        let fake = Fake::start(&[("INBOX", &[]), ("INBOX.Drafts", &[])]);
        fake.state.lock().unwrap().delimiter = ".".into();
        store_copy(&db, &acc, &fake).unwrap();
        assert_eq!(appended(&fake).iter().map(|a| a.0.as_str()).collect::<Vec<_>>(), vec!["INBOX.Sent"]);
        assert!(!fake.has_folder("Sent"));
    });
}

#[test]
fn when_no_sent_folder_can_be_made_the_copy_is_given_up_with_a_reason_and_nothing_else_happens() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs5-refused", NO_ARCHIVE_NO_SENT, &[]);
        let fake = Fake::start(&[("INBOX", &[])]);
        fake.state.lock().unwrap().refuse_create = true;
        let e = store_copy(&db, &acc, &fake).unwrap_err();
        assert!(e.contains("no Sent folder on this account and it could not be created"), "{e}");
        assert!(appended(&fake).is_empty());
        assert_eq!(fake.uids("INBOX"), Some(vec![]), "nothing else was touched");
    });
}

