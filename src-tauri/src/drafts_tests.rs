//! 1.0.7 W6.4: Save draft makes the Drafts folder when the server has none (like Archive, Trash and Sent), finds one another program made without waiting for a sync, and says so
//! in a coded error when the server refuses. Against the fake IMAP server.
use super::*;
use crate::fakeimap::Fake;

const ACC: &str = "a-drafts";

fn account() -> Account {
    Account {
        id: ACC.into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
        smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
        smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
    }
}

fn setup(tag: &str, fmap: &str) -> (Db, Account) {
    let db = quit_tests::test_db(tag);
    let acc = account();
    db::insert_account(&lock(&db), &acc).unwrap();
    db::set_setting(&lock(&db), &format!("fmap:{ACC}"), fmap).unwrap();
    (db, acc)
}

const RAW: &[u8] = b"Message-ID: <d1@x.test>\r\nFrom: me@example.com\r\nSubject: draft\r\n\r\ntext";

fn count(fake: &Fake, word: &str) -> usize {
    fake.commands().iter().filter(|c| c.to_uppercase().starts_with(word)).count()
}

#[test]
fn drafts_is_created_where_the_server_has_none() {
    test_guard::within(60, || {
        let (db, acc) = setup("w64-create", r#"{"inbox":"INBOX","sent":"Sent"}"#);
        let fake = Fake::start(&[("INBOX", &[]), ("Sent", &[])]);
        let mut s = fake.connect();
        let folder = append_draft(&db, &acc, &mut s, RAW).unwrap();
        assert_eq!(folder, "Drafts");
        assert_eq!(fake.uids("Drafts").map(|u| u.len()), Some(1), "created and holds the draft");
        assert_eq!(fake.subscribed(), vec!["Drafts".to_string()], "and subscribed to, so other programs list it");
        assert_eq!(fmap(&db, ACC).get("drafts").map(String::as_str), Some("Drafts"), "the saved folder list names it now: the folder pane shows it");
        // a second save finds it: no second CREATE, no LIST
        let before_create = count(&fake, "CREATE");
        let before_list = count(&fake, "LIST");
        append_draft(&db, &acc, &mut s, RAW).unwrap();
        assert_eq!((count(&fake, "CREATE"), count(&fake, "LIST")), (before_create, before_list));
        assert_eq!(fake.uids("Drafts").map(|u| u.len()), Some(2));
        let _ = s.logout();
    });
}

#[test]
fn drafts_goes_into_the_inbox_namespace() {
    test_guard::within(60, || {
        let (db, acc) = setup("w64-ns", r#"{"inbox":"INBOX","sent":"INBOX.Sent"}"#);
        let fake = Fake::start(&[("INBOX", &[]), ("INBOX.Sent", &[])]);
        fake.state.lock().unwrap().delimiter = ".".into();
        let mut s = fake.connect();
        let folder = append_draft(&db, &acc, &mut s, RAW).unwrap();
        assert_eq!(folder, "INBOX.Drafts");
        assert!(fake.has_folder("INBOX.Drafts") && !fake.has_folder("Drafts"), "not a top-level folder");
        let _ = s.logout();
    });
}

#[test]
fn a_refused_drafts_folder_is_a_coded_error_and_nothing_is_appended() {
    test_guard::within(60, || {
        let (db, acc) = setup("w64-refused", r#"{"inbox":"INBOX"}"#);
        let fake = Fake::start(&[("INBOX", &[])]);
        fake.state.lock().unwrap().refuse_create = true;
        let mut s = fake.connect();
        let e = append_draft(&db, &acc, &mut s, RAW).unwrap_err();
        assert!(e.starts_with("DRAFTS_NOT_CREATED|why="), "{e}");
        assert!(e.contains("Couldn’t find or create the Drafts folder on this account ("), "{e}");
        assert!(fake.state.lock().unwrap().appended.is_empty(), "nothing was appended");
        assert!(!fake.has_folder("Drafts"));
        assert_eq!(fmap(&db, ACC).get("drafts"), None, "and no folder is claimed in the saved list");
        // the reason is capped at 120 characters
        let long = drafts_not_created(&"x".repeat(400));
        assert!(long.split_once(": ").unwrap().0.len() < 160, "{long}");
        let _ = s.logout();
    });
}

#[test]
fn a_drafts_folder_made_by_another_program_is_found_without_a_sync() {
    test_guard::within(60, || {
        // the saved list has no Drafts (the last sync was before the folder was made)
        let (db, acc) = setup("w64-found", r#"{"inbox":"INBOX"}"#);
        let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
        let mut s = fake.connect();
        let folder = append_draft(&db, &acc, &mut s, RAW).unwrap();
        assert_eq!(folder, "Drafts");
        assert_eq!(count(&fake, "CREATE"), 0, "no second folder");
        assert_eq!(fake.uids("Drafts").map(|u| u.len()), Some(1));
        assert_eq!(fmap(&db, ACC).get("drafts").map(String::as_str), Some("Drafts"));
        let _ = s.logout();
        // a saved name the server has renamed since: the refusal sends us to a fresh list
        let (db, acc) = setup("w64-renamed", r#"{"inbox":"INBOX","drafts":"Old drafts"}"#);
        let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
        let mut s = fake.connect();
        let folder = append_draft(&db, &acc, &mut s, RAW).unwrap();
        assert_eq!(folder, "Drafts");
        assert_eq!(count(&fake, "CREATE"), 0);
        assert_eq!(fmap(&db, ACC).get("drafts").map(String::as_str), Some("Drafts"), "the saved list follows");
        let _ = s.logout();
    });
}

#[test]
fn a_look_up_never_creates_the_folder() {
    test_guard::within(60, || {
        // the readers (Discard changes, a draft looked up by Message-ID, a recovery snapshot's search) ask without creating; only a write creates (AC-6.4.7)
        let (db, acc) = setup("w64-lookup", r#"{"inbox":"INBOX"}"#);
        let fake = Fake::start(&[("INBOX", &[])]);
        let mut s = fake.connect();
        assert_eq!(find_drafts(&db, &acc, &mut s).unwrap(), None);
        assert_eq!(count(&fake, "CREATE"), 0);
        assert!(!fake.has_folder("Drafts"));
        // a draft reference by Message-ID on a server without Drafts: nothing to remove, nothing made
        draftmail::drop_on_session(&db, &acc, &mut s, &draftmail::Target::parse(&format!("mid:{ACC}|<none@x.test>"))).unwrap();
        assert_eq!(count(&fake, "CREATE"), 0);
        let _ = s.logout();
    });
}

#[test]
fn discard_changes_puts_the_opened_version_back_into_a_new_drafts_folder() {
    test_guard::within(60, || {
        // W6.4 + W2.2: the opened version is appended again; the folder is made when the server has none (AC-6.4.5 / the restart path of W6.17a uses the same helper)
        let (db, acc) = setup("w64-restore", r#"{"inbox":"INBOX"}"#);
        let fake = Fake::start(&[("INBOX", &[])]);
        draftmail::keep_original(&lock(&db), "mid:a-drafts|<saved@x.test>", ACC, RAW).unwrap();
        let mut s = fake.connect();
        assert!(draftmail::restore_on_session(&db, &acc, &mut s, "mid:a-drafts|<saved@x.test>").unwrap());
        let _ = s.logout();
        assert_eq!(fake.uids("Drafts").map(|u| u.len()), Some(1));
    });
}
