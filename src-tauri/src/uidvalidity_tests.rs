//! 1.0.7 W6.1: a Delete or Move never hits the wrong message, and a permanent delete removes only our own messages. Against the fake IMAP server, which can renumber a
//! folder (a new UIDVALIDITY, the UIDs given out again in another order) and mark messages `\Deleted` the way another mail program does.
use super::*;
use crate::fakeimap::Fake;

const ACC: &str = "a-uidv";

fn account() -> Account {
    Account {
        id: ACC.into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
        smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
        smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
    }
}

const FMAP: &str = r#"{"inbox":"INBOX","trash":"Trash","archive":"Archive","drafts":"Drafts"}"#;

fn mid(role: &str, uid: u32) -> String {
    format!("<{role}{uid}@x.test>")
}

fn raw_of(role: &str, uid: u32) -> Vec<u8> {
    format!("Message-ID: {}\r\nFrom: Ann <ann@x.test>\r\nTo: me@example.com\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\nSubject: {role} {uid}\r\n\r\nbody", mid(role, uid)).into_bytes()
}

/// A database with the account, the saved folder list, and a local row (with its Message-ID) per UID of the folder. `record`: the numbering a sync recorded
/// (`None`: an install from before 1.0.7).
fn setup(tag: &str, role: &str, uids: &[u32], record: Option<u32>) -> (Db, Account) {
    let db = quit_tests::test_db(tag);
    let acc = account();
    db::insert_account(&lock(&db), &acc).unwrap();
    db::set_setting(&lock(&db), &format!("fmap:{ACC}"), FMAP).unwrap();
    if let Some(v) = record {
        for (r, n) in [("inbox", "INBOX"), ("trash", "Trash"), ("archive", "Archive"), ("drafts", "Drafts")] {
            folderstate::set(&lock(&db), ACC, r, n, v).unwrap();
        }
    }
    for uid in uids {
        insert_row(&db, role, *uid, &mid(role, *uid));
    }
    (db, acc)
}

fn insert_row(db: &Db, role: &str, uid: u32, mid: &str) {
    lock(db)
        .execute(
            "INSERT INTO messages(id,account_id,folder,uid,message_id,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,?3,?4,?5,?6,'hello','n','peer@example.com','','',1,'')",
            params![format!("{ACC}:{role}:{uid}"), ACC, role, uid, mid, format!("t-{role}-{uid}")],
        )
        .unwrap();
}

/// A server whose `role` folder (named `name`) holds the messages `uids`, each with the Message-ID the local row has.
fn server(folders: &[(&str, &str, &[u32])]) -> Fake {
    let fake = Fake::start(&folders.iter().map(|(_, n, u)| (*n, *u)).collect::<Vec<_>>());
    for (role, name, uids) in folders {
        for u in *uids {
            fake.put_message(name, *u, &raw_of(role, *u));
        }
    }
    fake
}

fn act(db: &Db, acc: &Account, fake: &Fake, thread: &str, action: &str, dst: Option<&str>, scope: &str) -> R<()> {
    let list = thread_msgs(&lock(db), &[thread.to_string()]).unwrap();
    let mut s = fake.connect();
    let done = act_on_session(db, acc, &mut s, &list, action, dst, &Some(scope.to_string()), false);
    let _ = s.logout();
    done
}

fn changed_commands(fake: &Fake) -> Vec<String> {
    fake.commands().into_iter().filter(|c| ["UID STORE", "UID MOVE", "UID COPY", "EXPUNGE", "UID EXPUNGE"].iter().any(|w| c.to_uppercase().starts_with(w))).collect()
}

fn local(db: &Db, role: &str, uid: u32) -> bool {
    lock(db).query_row("SELECT 1 FROM messages WHERE id=?1", [format!("{ACC}:{role}:{uid}")], |_| Ok(())).is_ok()
}

#[test]
fn an_action_on_a_renumbered_folder_sends_no_command() {
    test_guard::within(60, || {
        for (action, dst, scope) in [("trash", Some("trash"), "inbox"), ("archive", Some("archive"), "inbox"), ("read", None, "inbox"), ("star", None, "inbox"), ("delete_forever", None, "inbox")] {
            let (db, acc) = setup(&format!("uidv-t1-{action}"), "inbox", &[1, 2, 3], Some(1));
            let fake = server(&[("inbox", "INBOX", &[1, 2, 3]), ("trash", "Trash", &[]), ("archive", "Archive", &[])]);
            // the numbering changes behind our back: UID 2 names another message now
            assert_eq!(fake.renumber("INBOX"), 2);
            let e = act(&db, &acc, &fake, "t-inbox-2", action, dst, scope).unwrap_err();
            assert!(mail::is_folder_changed(&e), "{action}: {e}");
            assert!(e.contains("This folder changed on the server, so nothing was done."), "{e}");
            assert_eq!(changed_commands(&fake), Vec::<String>::new(), "{action}: nothing that changes anything reached the server");
            assert_eq!(fake.uids("INBOX").map(|u| u.len()), Some(3));
            assert!(local(&db, "inbox", 2), "{action}: the local row stays until the folder is read again");
        }
    });
}

#[test]
fn a_queued_move_whose_folder_was_renumbered_moves_nothing() {
    test_guard::within(60, || {
        let (db, acc) = setup("uidv-t2", "inbox", &[1, 2, 3], Some(1));
        let fake = server(&[("inbox", "INBOX", &[1, 2, 3]), ("trash", "Trash", &[])]);
        // Delete is pressed: the messages are resolved now, under the numbering the folder has now
        let thread_ids = vec!["t-inbox-2".to_string()];
        let msgs = thread_msgs(&lock(&db), &thread_ids).unwrap();
        assert_eq!(msgs[0].state, Some(folderstate::State { name: "INBOX".into(), validity: 1 }));
        let p = Pending {
            id: uuid::Uuid::new_v4().to_string(),
            threads: thread_ids,
            msgs: Some(msgs),
            action: "trash".into(),
            arg: None,
            scope: Some("inbox".into()),
            due: std::time::Instant::now(),
            verify: None,
        };
        // the Undo time: the server renumbers the folder and a sync reads it again and records the new numbering - the rows have the same ids and UIDs, other messages
        fake.renumber("INBOX");
        folderstate::set(&lock(&db), ACC, "inbox", "INBOX", 2).unwrap();
        let mut act = |msgs: Vec<MsgRef>, action: &str, dst: Option<&str>, scope: &Option<String>, create: bool| {
            let mut s = fake.connect();
            let done = act_on_session(&db, &acc, &mut s, &msgs, action, dst, scope, create);
            let _ = s.logout();
            done
        };
        let e = run_queued(&db, p, &mut act).unwrap_err();
        assert!(mail::is_folder_changed(&e), "{e}");
        assert_eq!(changed_commands(&fake), Vec::<String>::new());
        assert_eq!(fake.uids("Trash"), Some(vec![]));
        assert_eq!(fake.uids("INBOX").map(|u| u.len()), Some(3));
    });
}

/// 1.0.8 (OPEN-1 of the rules QA): an Inbox whose rows are all gone (everything was moved or archived) is not a first sync. The highest UID seen is remembered, the next sync reads
/// only what is newer and that mail is new mail (rules, notifications); a renumbered folder replaces the value.
#[test]
fn an_emptied_folder_remembers_where_the_sync_stopped() {
    test_guard::within(60, || {
        let (db, _acc) = setup("uidv-maxuid", "inbox", &[], Some(1));
        assert_eq!(folderstate::max_uid(&lock(&db), ACC, "inbox"), 0, "nothing recorded: a first sync");
        folderstate::note_max_uid(&lock(&db), ACC, "inbox", 4467, false).unwrap();
        folderstate::note_max_uid(&lock(&db), ACC, "inbox", 100, false).unwrap();
        assert_eq!(folderstate::max_uid(&lock(&db), ACC, "inbox"), 4467, "it only grows");
        assert_eq!(folderstate::max_uid(&lock(&db), ACC, "archive"), 0, "per folder");
        // the server has the old message and a new one: with the remembered value only the new one is read, and it is not a "taste"
        let fake = server(&[("inbox", "INBOX", &[4466, 4467, 4468])]);
        let known = folderstate::known(folderstate::get(&lock(&db), ACC, "inbox").as_ref(), "INBOX");
        let mut s = fake.connect();
        let ff = mail::fetch_folder(&mut s, "INBOX", &known, folderstate::max_uid(&lock(&db), ACC, "inbox"), 0, PAGE).unwrap();
        let _ = s.logout();
        assert_eq!(ff.new.iter().map(|p| p.uid).collect::<Vec<_>>(), vec![4468]);
        assert!(!ff.reset);
        // renumbered: the value is replaced (also by a smaller one, also by none)
        folderstate::note_max_uid(&lock(&db), ACC, "inbox", 3, true).unwrap();
        assert_eq!(folderstate::max_uid(&lock(&db), ACC, "inbox"), 3);
        folderstate::note_max_uid(&lock(&db), ACC, "inbox", 0, true).unwrap();
        assert_eq!(folderstate::max_uid(&lock(&db), ACC, "inbox"), 0);
    });
}

/// The sync wires it: the highest UID counts with the local rows, and is recorded after every folder.
#[test]
fn the_sync_uses_the_remembered_highest_uid() {
    let src = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let sync = &src[src.find("fn sync_impl(").unwrap()..src.find("/// What running the rules over new mail came to").unwrap()];
    assert!(sync.contains("max_uid.max(seen_max)"), "the empty local folder is not a first sync");
    assert!(sync.contains("folderstate::note_max_uid("), "recorded after the folder");
}

#[test]
fn a_renumbered_folder_is_read_again_and_its_old_rows_are_gone() {
    test_guard::within(60, || {
        let (db, _acc) = setup("uidv-t3", "inbox", &[10, 11, 12], Some(1));
        insert_row(&db, "archive", 7, &mid("archive", 7));
        // pins survive (they hang on the thread, not on the UID); the folder had been downloaded to its oldest message
        lock(&db).execute("INSERT INTO thread_meta(thread_id,pinned) VALUES('t-inbox-11',1)", []).unwrap();
        db::set_setting(&lock(&db), &exhausted_key(ACC, "inbox"), "1").unwrap();
        let fake = server(&[("inbox", "INBOX", &[10, 11, 12]), ("archive", "Archive", &[7])]);
        fake.renumber("INBOX");
        // the sync's first look at the folder: the SELECT shows another UIDVALIDITY, so what is stored is not used and the newest page is read like a first sync
        let known = folderstate::known(folderstate::get(&lock(&db), ACC, "inbox").as_ref(), "INBOX");
        let mut s = fake.connect();
        let ff = mail::fetch_folder(&mut s, "INBOX", &known, 12, 10, PAGE).unwrap();
        let _ = s.logout();
        assert!(ff.reset);
        assert_eq!(ff.validity, Some(2));
        let mut got: Vec<u32> = ff.new.iter().map(|p| p.uid).collect();
        got.sort_unstable();
        assert_eq!(got, vec![1, 2, 3], "the folder is read from its start, not from the old highest UID");
        assert!(ff.flags.is_empty(), "no flags are refreshed for UIDs of the old numbering");
        // the rows of the folder go, the others stay
        {
            let c = lock(&db);
            c.execute_batch("BEGIN").unwrap();
            reset_folder(&c, ACC, "inbox", "INBOX", &known, ff.validity).unwrap();
            folderstate::set(&c, ACC, "inbox", "INBOX", 2).unwrap();
            c.execute_batch("COMMIT").unwrap();
        }
        assert!(!local(&db, "inbox", 10) && !local(&db, "inbox", 11) && !local(&db, "inbox", 12));
        assert!(local(&db, "archive", 7), "another folder is untouched");
        assert!(!is_exhausted(&db, ACC, "inbox"), "the folder has to be downloaded again");
        assert_eq!(lock(&db).query_row("SELECT pinned FROM thread_meta WHERE thread_id='t-inbox-11'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(folderstate::get(&lock(&db), ACC, "inbox").map(|s| s.validity), Some(2));
        // the same server a second time: nothing changed, nothing is read again
        let known = folderstate::known(folderstate::get(&lock(&db), ACC, "inbox").as_ref(), "INBOX");
        let mut s = fake.connect();
        let again = mail::fetch_folder(&mut s, "INBOX", &known, 3, 1, PAGE).unwrap();
        let _ = s.logout();
        assert!(!again.reset && again.new.is_empty());
    });
}

#[test]
fn a_role_that_points_to_another_server_folder_counts_as_renumbered() {
    test_guard::within(60, || {
        // the numbering was recorded for the server folder "INBOX.Old"; the role names "Archive" now (same UIDVALIDITY by accident)
        let (db, acc) = setup("uidv-rename", "archive", &[4], Some(1));
        folderstate::set(&lock(&db), ACC, "archive", "INBOX.Old", 1).unwrap();
        let fake = server(&[("inbox", "INBOX", &[]), ("archive", "Archive", &[4])]);
        let known = folderstate::known(folderstate::get(&lock(&db), ACC, "archive").as_ref(), "Archive");
        assert_eq!(known, folderstate::Known::Renamed);
        let mut s = fake.connect();
        assert!(mail::fetch_folder(&mut s, "Archive", &known, 4, 4, PAGE).unwrap().reset);
        let _ = s.logout();
        // and an action on it is refused
        let e = act(&db, &acc, &fake, "t-archive-4", "read", None, "archive").unwrap_err();
        assert!(mail::is_folder_changed(&e), "{e}");
        assert_eq!(changed_commands(&fake), Vec::<String>::new());
    });
}

#[test]
fn paging_older_mail_stops_when_the_folder_was_renumbered() {
    test_guard::within(60, || {
        let fake = server(&[("inbox", "INBOX", &[1, 2, 3, 4, 5])]);
        let mut s = fake.connect();
        let (older, _) = mail::fetch_older(&mut s, "INBOX", Some(1), 5, 3).unwrap();
        assert_eq!(older.len(), 3);
        fake.renumber("INBOX");
        let e = mail::fetch_older(&mut s, "INBOX", Some(1), 5, 3).unwrap_err();
        assert!(mail::is_folder_changed(&e), "{e}");
        // nothing recorded: not judged
        assert!(mail::fetch_older(&mut s, "INBOX", None, 5, 3).is_ok());
        let _ = s.logout();
    });
}

#[test]
fn a_draft_reference_from_before_a_renumber_deletes_no_other_draft() {
    test_guard::within(60, || {
        // D1 is open as "m:a-uidv:drafts:15" (a compose holds that reference); the server renumbers Drafts and gives UID 15 to another draft D2
        let (db, acc) = setup("uidv-t4", "drafts", &[15], Some(1));
        let fake = server(&[("inbox", "INBOX", &[]), ("drafts", "Drafts", &[])]);
        fake.put_message("Drafts", 15, b"Message-ID: <d2@x.test>\r\nSubject: other draft\r\n\r\nD2");
        fake.renumber("Drafts"); // (one message: it keeps UID 1 ... then it is put under 15 to make the collision explicit)
        fake.remove_message("Drafts", 1);
        fake.put_message("Drafts", 15, b"Message-ID: <d2@x.test>\r\nSubject: other draft\r\n\r\nD2");
        // the sync reads the folder again: the dropped ids are retired with their Message-ID, the new row has the id of D1 and the Message-ID of D2
        {
            let c = lock(&db);
            c.execute_batch("BEGIN").unwrap();
            let known = folderstate::Known::Validity(1);
            reset_folder(&c, ACC, "drafts", "Drafts", &known, Some(2)).unwrap();
            folderstate::set(&c, ACC, "drafts", "Drafts", 2).unwrap();
            c.execute_batch("COMMIT").unwrap();
        }
        insert_row(&db, "drafts", 15, "<d2@x.test>");
        let mut s = fake.connect();
        draftmail::drop_on_session(&db, &acc, &mut s, &draftmail::Target::parse(&format!("m:{ACC}:drafts:15"))).unwrap();
        let _ = s.logout();
        assert!(fake.uids("Drafts").unwrap().contains(&15), "D2 is still on the server");
        assert_eq!(changed_commands(&fake), Vec::<String>::new());
        assert!(local(&db, "drafts", 15), "and in the list");
        // the same draft under the same id after the reset (the server kept its UIDs): the reference is honoured
        let (db, acc) = setup("uidv-t4b", "drafts", &[15], Some(1));
        let fake = server(&[("inbox", "INBOX", &[]), ("drafts", "Drafts", &[15])]);
        {
            let c = lock(&db);
            c.execute_batch("BEGIN").unwrap();
            reset_folder(&c, ACC, "drafts", "Drafts", &folderstate::Known::Validity(1), Some(2)).unwrap();
            folderstate::set(&c, ACC, "drafts", "Drafts", 1).unwrap();
            c.execute_batch("COMMIT").unwrap();
        }
        insert_row(&db, "drafts", 15, &mid("drafts", 15));
        let mut s = fake.connect();
        draftmail::drop_on_session(&db, &acc, &mut s, &draftmail::Target::parse(&format!("m:{ACC}:drafts:15"))).unwrap();
        let _ = s.logout();
        assert_eq!(fake.uids("Drafts"), Some(vec![]));
    });
}

#[test]
fn uid_expunge_removes_only_our_messages() {
    test_guard::within(60, || {
        // another program marked mail 3 deleted and did not purge it (Thunderbird's "mark as deleted")
        let (db, acc) = setup("uidv-t5", "trash", &[1, 2], Some(1));
        let fake = server(&[("inbox", "INBOX", &[3, 4]), ("trash", "Trash", &[1, 2]), ("archive", "Archive", &[])]);
        fake.state.lock().unwrap().uidplus = true;
        fake.flag_deleted("Trash", 1);
        // delete forever mail 2 of the Trash
        act(&db, &acc, &fake, "t-trash-2", "delete_forever", None, "trash").unwrap();
        let cmds = fake.commands();
        assert!(cmds.iter().any(|c| c == "UID EXPUNGE 2"), "{cmds:?}");
        assert!(!cmds.iter().any(|c| c.eq_ignore_ascii_case("EXPUNGE")), "no plain EXPUNGE where UIDPLUS exists: {cmds:?}");
        assert_eq!(fake.uids("Trash"), Some(vec![1]), "the foreign marked message is still there");
        assert!(fake.state.lock().unwrap().deleted.contains(&("Trash".to_string(), 1)), "and still marked deleted");
        assert!(!local(&db, "trash", 2));
        // a move that falls back to COPY + STORE + EXPUNGE (no MOVE) keeps a foreign mark in the source too
        let (db, acc) = setup("uidv-t5b", "inbox", &[3, 4], Some(1));
        let fake = server(&[("inbox", "INBOX", &[3, 4]), ("archive", "Archive", &[])]);
        {
            let mut st = fake.state.lock().unwrap();
            st.uidplus = true;
            st.no_move = true;
        }
        fake.flag_deleted("INBOX", 3);
        act(&db, &acc, &fake, "t-inbox-4", "archive", Some("archive"), "inbox").unwrap();
        assert!(fake.commands().iter().any(|c| c == "UID EXPUNGE 4"), "{:?}", fake.commands());
        assert_eq!(fake.uids("INBOX"), Some(vec![3]));
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
    });
}

#[test]
fn without_uidplus_a_foreign_deleted_mark_survives_and_is_restored() {
    test_guard::within(60, || {
        let (db, acc) = setup("uidv-t6", "inbox", &[3, 4, 5], Some(1));
        let fake = server(&[("inbox", "INBOX", &[3, 4, 5]), ("archive", "Archive", &[])]);
        fake.state.lock().unwrap().no_move = true; // (uidplus is off by default in the fake)
        fake.flag_deleted("INBOX", 3);
        act(&db, &acc, &fake, "t-inbox-4", "archive", Some("archive"), "inbox").unwrap();
        let cmds = fake.commands();
        let at = |needle: &str| cmds.iter().position(|c| c.starts_with(needle)).unwrap_or_else(|| panic!("{needle} missing in {cmds:?}"));
        assert!(at("UID SEARCH DELETED") < at("UID STORE 3 -FLAGS.SILENT"), "{cmds:?}");
        assert!(at("UID STORE 3 -FLAGS.SILENT") < at("EXPUNGE"), "{cmds:?}");
        assert!(at("EXPUNGE") < at("UID STORE 3 +FLAGS.SILENT"), "{cmds:?}");
        assert!(!cmds.iter().any(|c| c.starts_with("UID EXPUNGE")), "{cmds:?}");
        assert_eq!(fake.uids("INBOX"), Some(vec![3, 5]), "our mail left, the other program's marked mail and the rest stay");
        assert!(fake.state.lock().unwrap().deleted.contains(&("INBOX".to_string(), 3)), "the foreign mark is back");
        assert_eq!(fake.uids("Archive").map(|u| u.len()), Some(1));
        // nothing foreign: a plain EXPUNGE, no marks touched
        let (db, acc) = setup("uidv-t6b", "inbox", &[3, 4], Some(1));
        let fake = server(&[("inbox", "INBOX", &[3, 4]), ("archive", "Archive", &[])]);
        fake.state.lock().unwrap().no_move = true;
        act(&db, &acc, &fake, "t-inbox-4", "archive", Some("archive"), "inbox").unwrap();
        assert!(fake.commands().iter().any(|c| c.eq_ignore_ascii_case("EXPUNGE")));
        assert!(!fake.commands().iter().any(|c| c.contains("FLAGS.SILENT")));
    });
}

#[test]
fn an_old_install_checks_message_ids_before_the_first_action() {
    test_guard::within(60, || {
        // no numbering recorded (1.0.6 data): the Message-IDs of the targets are compared first
        let (db, acc) = setup("uidv-t7", "inbox", &[1, 2, 3], None);
        let fake = server(&[("inbox", "INBOX", &[1, 2, 3]), ("trash", "Trash", &[])]);
        act(&db, &acc, &fake, "t-inbox-2", "trash", Some("trash"), "inbox").unwrap();
        let cmds = fake.commands();
        let check = cmds.iter().position(|c| c.contains("HEADER.FIELDS (MESSAGE-ID)")).expect("the headers were fetched first");
        let moved = cmds.iter().position(|c| c.starts_with("UID MOVE")).expect("and then the move was sent");
        assert!(check < moved, "{cmds:?}");
        assert_eq!(fake.uids("Trash").map(|u| u.len()), Some(1));
        assert_eq!(fake.uids("INBOX"), Some(vec![1, 3]));
        // the folder was renumbered before the first sync of the new version: UID 2 names another message
        let (db, acc) = setup("uidv-t7b", "inbox", &[1, 2, 3], None);
        let fake = server(&[("inbox", "INBOX", &[1, 2, 3]), ("trash", "Trash", &[])]);
        fake.renumber("INBOX");
        let e = act(&db, &acc, &fake, "t-inbox-1", "trash", Some("trash"), "inbox").unwrap_err();
        assert!(mail::is_folder_changed(&e), "{e}");
        assert_eq!(changed_commands(&fake), Vec::<String>::new());
        // a row without a Message-ID cannot be told apart: refused until the numbering is recorded
        let (db, acc) = setup("uidv-t7c", "inbox", &[], None);
        insert_row(&db, "inbox", 1, "");
        lock(&db).execute("UPDATE messages SET message_id=NULL", []).unwrap();
        let fake = server(&[("inbox", "INBOX", &[1]), ("trash", "Trash", &[])]);
        let e = act(&db, &acc, &fake, "t-inbox-1", "trash", Some("trash"), "inbox").unwrap_err();
        assert!(mail::is_folder_changed(&e), "{e}");
        assert_eq!(changed_commands(&fake), Vec::<String>::new());
        // a UID the server does not have (removed elsewhere) is no reason to refuse: a command on it reaches nothing
        let (db, acc) = setup("uidv-t7d", "inbox", &[1, 2], None);
        let fake = server(&[("inbox", "INBOX", &[1]), ("trash", "Trash", &[])]);
        act(&db, &acc, &fake, "t-inbox-2", "trash", Some("trash"), "inbox").unwrap();
    });
}

#[test]
fn message_ids_are_compared_exactly() {
    let s = |m: &str| Some(m.to_string());
    assert!(mail::message_ids_agree(&[(1, s("<a@x>"))], &[(1, s("<a@x>"))]));
    assert!(!mail::message_ids_agree(&[(1, s("<a@x>"))], &[(1, s("<b@x>"))]));
    assert!(!mail::message_ids_agree(&[(1, s("<a@x>"))], &[(1, None)]), "the server's message has none");
    assert!(!mail::message_ids_agree(&[(1, None)], &[(1, None)]), "no Message-ID on either side is no proof");
    assert!(mail::message_ids_agree(&[(1, s("<a@x>")), (2, s("<b@x>"))], &[(1, s("<a@x>"))]), "UID 2 is gone: nothing to hit");
}

#[test]
fn the_refusal_asks_for_a_sync_and_every_write_function_checks_first() {
    // the refused action asks for a sync of its account
    let (db, acc) = setup("uidv-resync", "inbox", &[1], Some(1));
    let fake = server(&[("inbox", "INBOX", &[1])]);
    fake.renumber("INBOX");
    assert!(act(&db, &acc, &fake, "t-inbox-1", "read", None, "inbox").is_err());
    assert!(folderstate::take_resync().contains(&ACC.to_string()));
    // source guard: no function of mail.rs sends a STORE / MOVE / COPY / EXPUNGE on stored UIDs without `select_guarded` in front of it
    let src = include_str!("mail.rs");
    for f in ["pub fn store_flag", "pub fn move_to", "pub fn delete_forever"] {
        let body = &src[src.find(f).unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("select_guarded("), "{f} must check the numbering before it sends anything");
        assert!(!body.contains("s.select("), "{f} must not select without the check");
    }
}

#[test]
fn the_test_seam_of_the_sync_is_read_by_debug_builds_only() {
    let src = include_str!("lib.rs");
    let f = &src[src.find("fn test_sync_delay_ms()").unwrap()..];
    let f = &f[..f.find("\n}\n").unwrap()];
    assert!(f.contains("if !cfg!(debug_assertions) {\n        return 0;"), "{f}");
    assert!(f.contains("HEYLOOK_TEST_SYNC_DELAY_MS"));
}
