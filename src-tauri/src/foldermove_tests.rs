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
        smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
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

// ---- OBS-1 (1.0.4): the folder is looked up / created BEFORE the person is told "Archived" (`prepare_on_session`)

fn prepare(db: &Db, acc: &Account, fake: &Fake, dst: &str) -> R<()> {
    let mut s = fake.connect();
    let done = prepare_on_session(db, acc, &mut s, dst);
    let _ = s.logout();
    done
}

#[test]
fn preparing_creates_a_missing_archive_without_moving_anything_and_the_move_then_finds_it() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs1-create", NO_ARCHIVE, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2]), ("Sent", &[])]);
        prepare(&db, &acc, &fake, "archive").unwrap();
        assert_eq!(fake.uids("Archive"), Some(vec![]), "Archive exists now and holds nothing");
        assert_eq!(fake.uids("INBOX"), Some(vec![1, 2]), "no mail moved yet");
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"));
        assert_eq!(saved(&db).get("archive").map(String::as_str), Some("Archive"));
        // the queued move runs later with the saved list: no LIST and no second CREATE
        let (lists, creates) = (sent(&fake, "LIST"), sent(&fake, "CREATE"));
        run(&db, &acc, &fake, 1, "archive", true).unwrap();
        assert_eq!((sent(&fake, "LIST"), sent(&fake, "CREATE")), (lists, creates));
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
    });
}

#[test]
fn preparing_fails_at_once_when_the_server_refuses_the_folder_and_nothing_changes() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs1-refused", NO_ARCHIVE, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2])]);
        fake.state.lock().unwrap().refuse_create = true;
        for role in ["archive", "trash"] {
            let e = prepare(&db, &acc, &fake, role).unwrap_err();
            assert!(e.starts_with(&format!("FOLDER_NOT_CREATED|folder={}|why=", role_label(role))), "{e}");
        }
        assert!(saved(&db).get("archive").is_none() && saved(&db).get("trash").is_none(), "nothing was saved for a folder that does not exist");
        assert_eq!(fake.uids("INBOX"), Some(vec![1, 2]));
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"));
        // junk and a folder of the person's own are never created: the same immediate error
        let e = prepare(&db, &acc, &fake, "junk").unwrap_err();
        assert!(e.starts_with("FOLDER_MISSING|folder=Junk"), "{e}");
        // the folder shows up later: preparing finds it
        fake.put_folder("Archive", &[]);
        prepare(&db, &acc, &fake, "archive").unwrap();
        assert_eq!(saved(&db).get("archive").map(String::as_str), Some("Archive"));
    });
}

#[test]
fn preparing_with_a_saved_folder_asks_the_server_for_nothing_and_a_found_folder_is_not_created() {
    test_guard::within(60, || {
        let (db, acc) = setup("obs1-saved", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[1]);
        let fake = Fake::start(&[("INBOX", &[1]), ("Archive", &[])]);
        prepare(&db, &acc, &fake, "archive").unwrap();
        assert!(fake.commands().iter().all(|c| !c.to_uppercase().starts_with("LIST") && !c.to_uppercase().starts_with("CREATE")), "{:?}", fake.commands());
        // not saved, but the server has it (SPECIAL-USE): found by LIST, not created
        let (db, acc) = setup("obs1-found", NO_ARCHIVE, &[1]);
        let fake = Fake::start(&[("INBOX", &[1]), ("Deleted Items", &[])]);
        fake.state.lock().unwrap().special.insert("Deleted Items".into(), "\\Trash".into());
        prepare(&db, &acc, &fake, "trash").unwrap();
        assert_eq!(sent(&fake, "CREATE"), 0);
        assert_eq!(saved(&db).get("trash").map(String::as_str), Some("Deleted Items"));
    });
}

#[test]
fn only_a_move_to_a_folder_the_saved_list_lacks_needs_the_server() {
    let (db, _acc) = setup("obs1-targets", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[1, 2]);
    let ids = vec!["t1".to_string(), "t2".to_string()];
    let inbox = Some("inbox".to_string());
    let want = |action: &str, arg: Option<&str>, scope: &Option<String>| targets_to_prepare(&db, &ids, action, arg, scope).unwrap();
    assert_eq!(want("archive", None, &inbox), Vec::<(String, String)>::new(), "the saved list names Archive");
    assert_eq!(want("trash", None, &inbox), vec![(ACC.to_string(), "trash".to_string())], "once per account, however many conversations");
    assert_eq!(want("junk", None, &inbox), vec![(ACC.to_string(), "junk".to_string())]);
    assert_eq!(want("block", None, &inbox), vec![(ACC.to_string(), "junk".to_string())], "blocking sends the mail to Junk");
    assert_eq!(want("move", Some("f:Work"), &inbox), vec![(ACC.to_string(), "f:Work".to_string())]);
    assert!(targets_to_prepare(&db, &ids, "move", None, &inbox).is_err(), "a move needs a destination");
    // (BUG-1) the targets also say whether the saved list was trusted: those are the ones checked during the Undo window
    let all = move_targets(&db, &ids, "archive", None, &inbox).unwrap();
    assert_eq!(all, vec![(ACC.to_string(), "archive".to_string(), true)]);
    assert_eq!(move_targets(&db, &ids, "trash", None, &inbox).unwrap(), vec![(ACC.to_string(), "trash".to_string(), false)]);
    assert_eq!(want("inbox", None, &inbox), Vec::<(String, String)>::new(), "already in the inbox");
    assert!(want("read", None, &inbox).is_empty() && want("star", None, &inbox).is_empty() && want("pin", None, &inbox).is_empty(), "other actions need no folder");
    // a view the mail is not in is not touched by the move (the same rule as the move itself)
    assert!(want("trash", None, &Some("sent".to_string())).is_empty());
    // the trash view's delete removes for good, it is not a move
    lock(&db).execute("UPDATE messages SET folder='trash' WHERE id='m2'", []).unwrap();
    assert!(targets_to_prepare(&db, &["t2".to_string()], "trash", None, &Some("trash".to_string())).unwrap().is_empty());
}

// ---- BUG-1 (1.0.4, QA round 11): the saved list names the folder but the server no longer has it. The folder is checked on the server
// while the Undo window runs (`verify_on_session`, `Verify`); a move never goes to a folder that was not checked.

fn verify(db: &Db, acc: &Account, fake: &Fake, dst: &str) -> R<()> {
    let mut s = fake.connect();
    let done = verify_on_session(db, acc, &mut s, dst);
    let _ = s.logout();
    done
}

const SAVED_ARCHIVE: &str = r#"{"inbox":"INBOX","archive":"Archive"}"#;

#[test]
fn a_saved_folder_that_is_gone_and_cannot_be_made_fails_the_check_before_anything_is_sent() {
    test_guard::within(60, || {
        // the QA case: the list still names Archive, the server deleted it, CREATE is refused
        let (db, acc) = setup("bug1-refused", SAVED_ARCHIVE, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2]), ("Sent", &[])]);
        fake.state.lock().unwrap().refuse_create = true;
        let e = verify(&db, &acc, &fake, "archive").unwrap_err();
        assert!(e.starts_with("FOLDER_NOT_CREATED|folder=Archive|why="), "{e}");
        assert_eq!(sent(&fake, "UID MOVE") + sent(&fake, "UID COPY"), 0, "no MOVE and no COPY was sent");
        assert_eq!(sent(&fake, "LIST"), 1, "the server was asked once");
        let s = saved(&db);
        assert!(s.get("archive").is_none(), "the saved list was refreshed and no longer names Archive: {s:?}");
        assert_eq!(s.get("inbox").map(String::as_str), Some("INBOX"));
        assert_eq!(fake.uids("INBOX"), Some(vec![1, 2]));
        assert_eq!(local_folder(&db, 1).as_deref(), Some("inbox"), "the mail is still listed in the Inbox here");
        // a later Archive does not trust the old name any more: the app asks the server again before it says "Archived"
        assert_eq!(targets_to_prepare(&db, &["t1".to_string()], "archive", None, &Some("inbox".to_string())).unwrap(), vec![(ACC.to_string(), "archive".to_string())]);
    });
}

#[test]
fn a_saved_folder_that_is_gone_is_made_again_when_the_server_allows_it() {
    test_guard::within(60, || {
        let (db, acc) = setup("bug1-recreate", SAVED_ARCHIVE, &[1]);
        let fake = Fake::start(&[("INBOX", &[1])]);
        verify(&db, &acc, &fake, "archive").unwrap();
        assert_eq!(fake.uids("Archive"), Some(vec![]));
        assert_eq!(sent(&fake, "CREATE"), 1);
        assert_eq!(sent(&fake, "UID MOVE") + sent(&fake, "UID COPY"), 0, "the check moves nothing");
        // Junk and a folder of the person's own are find-only, as before: a missing one is an error, nothing is created
        let e = verify(&db, &acc, &fake, "junk").unwrap_err();
        assert!(e.starts_with("FOLDER_MISSING|folder=Junk"), "{e}");
        assert_eq!(sent(&fake, "CREATE"), 1);
    });
}

#[test]
fn a_saved_folder_that_exists_is_checked_once_and_the_move_comes_after() {
    test_guard::within(60, || {
        let (db, acc) = setup("bug1-exists", SAVED_ARCHIVE, &[1, 2]);
        let fake = Fake::start(&[("INBOX", &[1, 2]), ("Archive", &[])]);
        verify(&db, &acc, &fake, "archive").unwrap();
        assert_eq!(sent(&fake, "LIST"), 1, "one look at the server");
        assert_eq!(sent(&fake, "CREATE") + sent(&fake, "UID MOVE") + sent(&fake, "UID COPY"), 0, "the check only looks");
        assert_eq!(saved(&db).get("archive").map(String::as_str), Some("Archive"));
        // the move that follows goes straight to it
        run(&db, &acc, &fake, 1, "archive", true).unwrap();
        assert_eq!(sent(&fake, "LIST"), 1, "the move needed no second look");
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
        assert_eq!(fake.uids("INBOX"), Some(vec![2]));
        // the order on the wire: the LIST came before the MOVE
        let cmds = fake.commands();
        let at = |w: &str| cmds.iter().position(|c| c.to_uppercase().starts_with(w));
        assert!(at("LIST") < at("UID MOVE").or(at("UID COPY")), "{cmds:?}");
    });
}

#[test]
fn a_saved_folder_that_was_renamed_is_found_by_the_check_and_the_saved_list_follows() {
    test_guard::within(60, || {
        let (db, acc) = setup("bug1-renamed", SAVED_ARCHIVE, &[1]);
        let fake = Fake::start(&[("INBOX", &[1]), ("Archives", &[])]);
        verify(&db, &acc, &fake, "archive").unwrap();
        assert_eq!(saved(&db).get("archive").map(String::as_str), Some("Archives"));
        assert_eq!(sent(&fake, "CREATE"), 0);
        run(&db, &acc, &fake, 1, "archive", true).unwrap();
        assert_eq!(fake.uids("Archives").map(|u| u.len()), Some(1));
    });
}

#[test]
fn the_folder_check_decides_the_queued_move_and_undo_wins() {
    use std::time::Duration;
    let queued = |gate: &Arc<Verify>| queue(vec!["t".into()], None, "archive".into(), None, Some("inbox".into()), 600, Some(gate.clone()));
    let waiting = |id: &str| pending_lock().iter().any(|p| p.id == id);
    // not finished yet: the move waits (None), and a finished check is remembered
    let gate = Verify::new();
    assert!(gate.wait(Duration::from_millis(10)).is_none());
    gate.finish(Ok(()));
    assert_eq!(gate.wait(Duration::from_millis(10)), Some(Ok(())));
    // a check that fails drops a move that is still waiting and hands the error to the app
    let gate = Verify::new();
    let id = queued(&gate);
    assert!(waiting(&id));
    assert_eq!(verify_finished(&id, &gate, Err("FOLDER_NOT_CREATED|folder=Archive|why=x: nope".into())).as_deref(), Some("FOLDER_NOT_CREATED|folder=Archive|why=x: nope"));
    assert!(!waiting(&id), "the move is gone, nothing will be sent");
    assert_eq!(gate.wait(Duration::from_millis(10)), Some(Err("FOLDER_NOT_CREATED|folder=Archive|why=x: nope".to_string())), "a move that was already due sees the failure");
    // Undo first: the failed check is ignored (no error for a move the person took back)
    let gate = Verify::new();
    let id = queued(&gate);
    assert!(cancel_action(id.clone()));
    assert_eq!(verify_finished(&id, &gate, Err("FOLDER_MISSING|folder=Archive: gone".into())), None);
    // a check that succeeds changes nothing
    let gate = Verify::new();
    let id = queued(&gate);
    assert_eq!(verify_finished(&id, &gate, Ok(())), None);
    assert!(waiting(&id), "the move stays queued and runs at the end of the Undo window");
    assert!(cancel_action(id));
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


#[test]
fn a_move_whose_undo_time_is_over_stays_hidden_from_the_lists_until_it_is_done() {
    use std::time::{Duration, Instant};
    // BUG-B3: a move that left the waiting list (its Undo time is over) and had not changed the local rows yet was in no set, so a list read in
    // that moment (the page's 30 s re-read, a sync) showed the message again
    let id = queue(vec!["t-b3-a".into(), "t-b3-b".into()], None, "trash".into(), None, Some("inbox".into()), 0, None);
    let other = queue(vec!["t-b3-other".into()], None, "archive".into(), None, Some("inbox".into()), 600, None);
    assert!(pending_thread_ids().contains("t-b3-a"), "waiting: hidden");
    let taken = take_due(Some(Instant::now() + Duration::from_secs(1)));
    assert!(taken.iter().any(|p| p.id == id), "the due move is taken");
    assert!(!taken.iter().any(|p| p.id == other), "a move that is not due stays");
    assert!(!pending_lock().iter().any(|p| p.id == id), "no longer waiting");
    let hidden = pending_thread_ids();
    assert!(hidden.contains("t-b3-a") && hidden.contains("t-b3-b"), "running: still hidden");
    assert!(hidden.contains("t-b3-other"), "the waiting one is hidden too");
    committing_done(&id);
    let hidden = pending_thread_ids();
    assert!(!hidden.contains("t-b3-a") && !hidden.contains("t-b3-b"), "done: the rows are as the move left them, the lists show what is there");
    assert!(hidden.contains("t-b3-other"));
    assert!(cancel_action(other));
}

#[test]
fn the_page_is_told_when_a_move_is_done_and_the_list_drops_the_messages_then() {
    let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let run = &lib[lib.find("fn run_pending(").unwrap()..];
    let run = &run[..run.find("fn commit_due(").unwrap()];
    // the threads stop being hidden after the local rows are changed, then the page hears of it (to the main page only), then every window re-reads
    let done = run.find("committing_done(&id);").unwrap();
    let told = run.find("\"moves-committed\"").unwrap();
    let synced = run.find("\"mail-synced\"").unwrap();
    assert!(run.find("run_queued(").unwrap() < done && done < told && told < synced, "{run}");
}

// ---- 1.0.7 W2.5: a queued move acts on the messages it was queued with

/// Add one more message to a conversation of the inbox (a mail that a sync threaded into it).
fn add_to_thread(db: &Db, uid: u32, thread: &str) {
    lock(db)
        .execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,'inbox',?3,?4,'hello','n','peer@example.com','','',1,'')",
            params![format!("m{uid}"), ACC, uid, thread],
        )
        .unwrap();
}

/// The queued move as the app makes it: the messages are read when it is queued; it is run later by the real `run_queued`, against a fake server.
/// (A `Pending` of its own: the global waiting list is shared by the tests that run side by side.)
fn queue_and_run(db: &Db, acc: &Account, fake: &Fake, threads: &[&str], action: &str, before_run: impl FnOnce()) -> Vec<String> {
    let thread_ids: Vec<String> = threads.iter().map(|t| t.to_string()).collect();
    let msgs = thread_msgs(&lock(db), &thread_ids).unwrap();
    let p = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        threads: thread_ids,
        msgs: Some(msgs),
        action: action.into(),
        arg: None,
        scope: Some("inbox".to_string()),
        due: std::time::Instant::now(),
        verify: None,
    };
    before_run(); // the Undo time: a sync brings in mail, another program moves something
    let mut moved = vec![];
    let mut act = |msgs: Vec<MsgRef>, action: &str, dst: Option<&str>, scope: &Option<String>, create: bool| {
        moved.extend(msgs.iter().map(|m| m.id.clone()));
        let mut s = fake.connect();
        let done = act_on_session(db, acc, &mut s, &msgs, action, dst, scope, create);
        let _ = s.logout();
        done
    };
    run_queued(db, p, &mut act).unwrap();
    moved
}

#[test]
fn a_queued_move_moves_the_messages_it_was_queued_with() {
    test_guard::within(60, || {
        // the conversation "t1" has the messages 1 and 2; a third one is threaded into it during the Undo time (AC-2.5.2)
        let (db, acc) = setup("w25-snapshot", r#"{"inbox":"INBOX","trash":"Trash"}"#, &[1]);
        add_to_thread(&db, 2, "t1");
        add_to_thread(&db, 9, "t9"); // another conversation: never touched
        let fake = Fake::start(&[("INBOX", &[1, 2, 9]), ("Trash", &[])]);
        let mut at_run_time = vec![];
        let moved = queue_and_run(&db, &acc, &fake, &["t1"], "trash", || {
            add_to_thread(&db, 3, "t1");
            fake.put_message("INBOX", 3, b"Subject: late\r\n\r\nx");
            // (the premise: resolving the conversation when the move runs, as before 1.0.7, would have taken the third message along)
            at_run_time = thread_msgs(&lock(&db), &["t1".to_string()]).unwrap().into_iter().map(|m| m.id).collect::<Vec<_>>();
        });
        assert!(at_run_time.contains(&"m3".to_string()), "{at_run_time:?}");
        assert_eq!(moved, vec!["m1", "m2"], "only what was in the conversation when Delete was pressed");
        assert_eq!(fake.uids("Trash").map(|u| u.len()), Some(2));
        let mut left = fake.uids("INBOX").unwrap();
        left.sort();
        assert_eq!(left, vec![3, 9], "the message that arrived meanwhile and the other conversation stay");
        assert_eq!(local_folder(&db, 3).as_deref(), Some("inbox"));
        assert_eq!(local_folder(&db, 1), None, "the local rows of the moved ones are gone");
    });
}

#[test]
fn a_message_that_vanished_during_the_undo_time_is_skipped_without_an_error() {
    test_guard::within(60, || {
        let (db, acc) = setup("w25-vanished", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[1]);
        add_to_thread(&db, 2, "t1");
        add_to_thread(&db, 3, "t1");
        let fake = Fake::start(&[("INBOX", &[1, 2, 3]), ("Archive", &[])]);
        let moved = queue_and_run(&db, &acc, &fake, &["t1"], "archive", || {
            // message 2 was removed by a sync (deleted elsewhere), message 3 was moved to another folder by another program
            lock(&db).execute("DELETE FROM messages WHERE id='m2'", []).unwrap();
            lock(&db).execute("UPDATE messages SET folder='trash' WHERE id='m3'", []).unwrap();
        });
        assert_eq!(moved, vec!["m1"]);
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
        assert_eq!(fake.uids("INBOX"), Some(vec![2, 3]), "nothing else on the server was touched");
        // all of them gone: nothing is sent to the server at all
        let (db, acc) = setup("w25-allgone", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[1]);
        let fake = Fake::start(&[("INBOX", &[1]), ("Archive", &[])]);
        let before = fake.commands().len();
        let moved = queue_and_run(&db, &acc, &fake, &["t1"], "archive", || {
            lock(&db).execute("DELETE FROM messages", []).unwrap();
        });
        assert!(moved.is_empty() && fake.commands().len() == before, "{:?}", fake.commands());
    });
}

#[test]
fn cancelling_one_queued_move_leaves_the_others() {
    // two Deletes in a row (the selection moved on after the first): two tokens, two toasts; Undo of one never touches the other (REQ-2.5.2)
    let first = queue(vec!["t-w25-a".into()], Some(vec![]), "trash".into(), None, Some("inbox".into()), 600, None);
    let second = queue(vec!["t-w25-b".into()], Some(vec![]), "trash".into(), None, Some("inbox".into()), 600, None);
    let third = queue(vec!["t-w25-c".into()], Some(vec![]), "archive".into(), None, Some("inbox".into()), 600, None);
    assert_ne!(first, second);
    let waiting = |id: &str| pending_lock().iter().any(|p| p.id == id);
    assert!(cancel_action(second.clone()), "Undo of the second");
    assert!(waiting(&first) && waiting(&third) && !waiting(&second));
    assert!(!cancel_action(second.clone()), "a second Undo of the same token finds nothing and cancels nothing else");
    assert!(waiting(&first) && waiting(&third));
    assert!(!cancel_action("not-a-token".into()));
    assert!(waiting(&first) && waiting(&third));
    assert!(pending_thread_ids().contains("t-w25-a") && !pending_thread_ids().contains("t-w25-b"));
    assert!(cancel_action(first) && cancel_action(third));
}

#[test]
fn the_queue_reads_the_messages_when_the_move_is_queued_and_the_run_does_not_resolve_conversations() {
    let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let q = &lib[lib.find("fn queue_action(").unwrap()..];
    let q = &q[..q.find("#[tauri::command]").unwrap()];
    assert!(q.contains("thread_msgs(&lock(&db), &thread_ids)") && q.contains("is_queued_move(&action)"), "{q}");
    let run = &lib[lib.find("fn run_pending(").unwrap()..];
    let run = &run[..run.find("fn run_queued(").unwrap()];
    assert!(run.contains("run_queued(&db, p,") && !run.contains("action_impl("), "the run does not resolve the conversation again");
    let rq = &lib[lib.find("fn run_queued(").unwrap()..];
    let rq = &rq[..rq.find("fn commit_due(").unwrap()];
    assert!(rq.contains("still_there(db, &queued)") && rq.contains("p.msgs"), "{rq}");
    // every step is in the log: queued, undo, running, done (token, messages; no subject or address)
    for line in ["\"queued {}:", "\"undo {}: {}\"", "\"running {}:", "\"done {}: {}\""] {
        assert!(lib.contains(line), "log line {line}");
    }
}

// ---- 1.0.7 W2.22 CF-18: a sent reply flags the original \Answered, a sent forward $Forwarded

fn stores(fake: &Fake) -> Vec<String> {
    fake.commands().into_iter().filter(|c| c.to_uppercase().starts_with("UID STORE")).collect()
}

fn answers(kind: &str) -> smtp::Answers {
    smtp::Answers { kind: kind.into(), account_id: ACC.into(), message_id: "<orig@example.org>".into() }
}

fn flag(db: &Db, acc: &Account, fake: &Fake, a: &smtp::Answers) -> R<()> {
    let mut s = fake.connect();
    let done = flag_on_session(db, acc, &mut s, a);
    let _ = s.logout();
    done
}

#[test]
fn a_sent_reply_flags_the_original_answered() {
    test_guard::within(60, || {
        let (db, acc) = setup("cf18-reply", r#"{"inbox":"INBOX","archive":"Archive"}"#, &[7]);
        lock(&db).execute("UPDATE messages SET message_id='<orig@example.org>' WHERE id='m7'", []).unwrap();
        let fake = Fake::start(&[("INBOX", &[7]), ("Archive", &[])]);
        flag(&db, &acc, &fake, &answers("answered")).unwrap();
        let s = stores(&fake);
        assert_eq!(s.len(), 1, "{s:?}");
        assert!(s[0].starts_with("UID STORE 7 ") && s[0].contains("+FLAGS") && s[0].contains("\\Answered") && !s[0].contains("Forwarded"), "{s:?}");
        // the original was archived meanwhile: it is flagged where it is now
        lock(&db).execute("UPDATE messages SET folder='archive', uid=3 WHERE id='m7'", []).unwrap();
        let fake = Fake::start(&[("INBOX", &[]), ("Archive", &[3])]);
        flag(&db, &acc, &fake, &answers("answered")).unwrap();
        assert!(stores(&fake)[0].starts_with("UID STORE 3 "), "{:?}", stores(&fake));
        assert!(fake.commands().iter().any(|c| c.to_uppercase().starts_with("SELECT") && c.contains("Archive")), "{:?}", fake.commands());
    });
}

#[test]
fn a_sent_forward_flags_the_original_forwarded() {
    test_guard::within(60, || {
        let (db, acc) = setup("cf18-forward", r#"{"inbox":"INBOX"}"#, &[7]);
        lock(&db).execute("UPDATE messages SET message_id='<orig@example.org>' WHERE id='m7'", []).unwrap();
        let fake = Fake::start(&[("INBOX", &[7])]);
        flag(&db, &acc, &fake, &answers("forwarded")).unwrap();
        let s = stores(&fake);
        assert_eq!(s.len(), 1, "{s:?}");
        assert!(s[0].starts_with("UID STORE 7 ") && s[0].contains("$Forwarded") && !s[0].contains("Answered"), "{s:?}");
    });
}

#[test]
fn a_flag_failure_does_not_fail_the_send() {
    test_guard::within(60, || {
        // the original is not in the local store (never synced, or removed): an error for the log, no STORE, no panic
        let (db, acc) = setup("cf18-gone", r#"{"inbox":"INBOX"}"#, &[7]);
        let fake = Fake::start(&[("INBOX", &[7])]);
        assert!(flag(&db, &acc, &fake, &answers("answered")).unwrap_err().contains("has the Message-ID of the original"));
        assert!(stores(&fake).is_empty());
        // the folder of the original is not known any more
        lock(&db).execute("UPDATE messages SET message_id='<orig@example.org>' WHERE id='m7'", []).unwrap();
        db::set_setting(&lock(&db), &format!("fmap:{ACC}"), "{}").unwrap();
        assert!(flag(&db, &acc, &fake, &answers("answered")).is_err());
        assert!(stores(&fake).is_empty());
        // a draft whose answers are not valid is not flagged at all (a line in the log says why, no thread is started)
        let mut d = crate::smtp::tests::draft("<p>x</p>", vec![], vec![]);
        d.answers = Some(smtp::Answers { kind: "answered".into(), account_id: ACC.into(), message_id: "no-brackets".into() });
        flag_original(&db, &d);
    });
    // the send itself: the flag is asked for after the message is out, on its own thread, and its result is not looked at
    let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let send = &lib[lib.find("fn send_now(").unwrap()..];
    let send = &send[..send.find("\n}\n").unwrap()];
    let out = send.find("smtp::send_raw(").unwrap();
    let flagged = send.find("flag_original(db, d);").unwrap();
    assert!(out < flagged, "the flag comes after the SMTP send");
    assert!(!send.contains("flag_original(db, d)?") && !send.contains("= flag_original("), "its result is not used");
    let f = &lib[lib.find("fn flag_original(").unwrap()..];
    let f = &f[..f.find("\n}\n").unwrap()];
    assert!(f.contains("std::thread::spawn") && !f.contains("-> R<"), "{f}");
}

#[test]
fn a_flag_failure_says_why() {
    test_guard::within(60, || {
        // 1.0.7 WP2a QA BUG-4: the original IS in the local store (UID 7), but the store has no Message-ID for it. The line must not say it is gone.
        let (db, acc) = setup("cf18-why", r#"{"inbox":"INBOX"}"#, &[7]);
        let fake = Fake::start(&[("INBOX", &[7])]);
        let in_store: i64 = lock(&db).query_row("SELECT count(*) FROM messages WHERE id='m7' AND message_id IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(in_store, 1, "the fixture: the message is in the store without a Message-ID");
        let why = flag(&db, &acc, &fake, &answers("answered")).unwrap_err();
        assert!(why.contains("no message of this account in the local store has the Message-ID of the original"), "{why}");
        assert!(why.contains("without a Message-ID or with another one"), "it names the possibilities, not just one: {why}");
        assert!(!why.contains("not in the local store") && !why.contains("any more"), "{why}");
        assert!(stores(&fake).is_empty());
    });
    // the store itself cannot be read: that error, not "no message"
    let why = original_found(Err(rusqlite::Error::InvalidQuery)).unwrap_err();
    assert!(why.contains("the local store could not be read"), "{why}");
    assert_eq!(original_found(Ok(("inbox".into(), 7))).unwrap(), ("inbox".to_string(), 7));
    // before any server is asked: an answers record that cannot be used says why (the line is written by flag_original)
    let mut a = answers("answered");
    assert_eq!(answers_problem(&a), None);
    a.message_id = String::new();
    assert!(answers_problem(&a).unwrap().contains("no usable Message-ID"));
    a.message_id = "no-brackets".into();
    assert!(answers_problem(&a).unwrap().contains("no usable Message-ID"));
    a.message_id = "<ok@example.org>".into();
    a.account_id = "has a space".into();
    assert!(answers_problem(&a).unwrap().contains("not one this app wrote"));
    let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let f = &lib[lib.find("fn flag_original(").unwrap()..];
    let f = &f[..f.find("
}
").unwrap()];
    assert!(f.contains("answers_problem(&a)") && f.contains("could not be flagged"), "{f}");
}
