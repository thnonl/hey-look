//! 1.0.7 W6.5 / W6.12: a message the mail server accepted is never sent a second time, a resent message keeps its Message-ID, what is due at a quit goes out once before the app ends,
//! and the question of the quit counts only what waits.
use super::*;
use crate::fakeimap::Fake;

const ACC: &str = "a-once";

fn account(smtp_host: &str) -> Account {
    Account {
        id: ACC.into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
        smtp_host: smtp_host.into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
        smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
    }
}

fn setup(tag: &str, smtp_host: &str) -> (Db, Account) {
    let db = quit_tests::test_db(tag);
    let acc = account(smtp_host);
    db::insert_account(&lock(&db), &acc).unwrap();
    db::set_setting(&lock(&db), &format!("fmap:{ACC}"), r#"{"inbox":"INBOX","sent":"Sent"}"#).unwrap();
    (db, acc)
}

fn payload(message_id: Option<&str>) -> String {
    let mut v = serde_json::json!({ "accountId": ACC, "to": ["ann@example.test"], "subject": "Hi", "html": "<p>x</p>", "text": "x" });
    if let Some(m) = message_id {
        v["messageId"] = serde_json::json!(m);
    }
    v.to_string()
}

fn put(db: &Db, id: &str, status: &str, undo: i64, send_at: i64) {
    lock(db)
        .execute("INSERT INTO outbox(id,account_id,payload,send_at,status,created_at,undo) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id, ACC, payload(None), send_at, status, now(), undo])
        .unwrap();
}

fn mark(db: &Db, id: &str, raw: &[u8]) {
    lock(db).execute("UPDATE outbox SET smtp_done_at=?2, sent_raw=?3 WHERE id=?1", params![id, now(), raw]).unwrap();
}

fn row(db: &Db, id: &str) -> Option<(String, i64)> {
    lock(db).query_row("SELECT status, undo FROM outbox WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).ok()
}

#[test]
fn a_message_accepted_by_smtp_is_not_sent_again_after_a_crash() {
    let (db, _) = setup("once-t1", "smtp.example.test");
    // the process ended after the SMTP server said 250 and before the row went (the Sent copy takes a second connection)
    put(&db, "accepted", "sending", 0, now() - 5);
    mark(&db, "accepted", b"raw");
    // ... while its Undo time row (undo = 1, claimed for the send) was marked the same way
    put(&db, "accepted-undo", "sending", 1, now() - 5);
    mark(&db, "accepted-undo", b"raw");
    // a message that was in the middle of the SMTP exchange with no answer: sent again
    put(&db, "unknown", "sending", 0, now() - 5);
    put(&db, "undo-unknown", "undo", 1, now() - 5);
    outbox_startup(&db);
    assert_eq!(row(&db, "accepted"), Some(("sending".into(), 0)), "the marker keeps it from `pending`: nothing picks it up");
    assert_eq!(row(&db, "accepted-undo"), Some(("sending".into(), 1)), "also for a message from its Undo time");
    assert_eq!(row(&db, "unknown"), Some(("pending".into(), 0)), "no answer from the server: sent again (losing it is worse)");
    assert_eq!(row(&db, "undo-unknown"), Some(("pending".into(), 2)), "an Undo-time message goes out like a scheduled one that came due");
    // what the worker would pick: only the unknown ones
    let due: Vec<String> = {
        let c = lock(&db);
        let mut st = c.prepare("SELECT id FROM outbox WHERE status='pending' AND send_at<=?1 ORDER BY id").unwrap();
        st.query_map([now()], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(due, vec!["undo-unknown".to_string(), "unknown".to_string()]);
}

#[test]
fn the_sent_copy_of_an_accepted_message_is_stored_at_the_next_start() {
    test_guard::within(60, || {
        let (db, acc) = setup("once-t2", "smtp.example.test");
        let fake = Fake::start(&[("INBOX", &[]), ("Sent", &[])]);
        put(&db, "accepted", "sending", 0, now() - 5);
        mark(&db, "accepted", b"Message-ID: <m1@example.com>\r\nSubject: Hi\r\n\r\nx");
        put(&db, "other", "pending", 0, now() + 3600); // a scheduled message that waits is not touched
        let n = finish_accepted(&db, &mut |a, raw| {
            let mut s = fake.connect();
            let done = store_sent_copy(&db, a, &mut s, raw);
            let _ = s.logout();
            done
        });
        assert_eq!(n, 1);
        let appended = fake.state.lock().unwrap().appended.clone();
        assert_eq!(appended.len(), 1, "one copy in Sent");
        assert_eq!(appended[0].0, "Sent");
        assert!(String::from_utf8_lossy(&appended[0].1).contains("<m1@example.com>"));
        assert_eq!(row(&db, "accepted"), None, "the row is gone");
        assert!(row(&db, "other").is_some());
        // run again (the next start): nothing is stored twice
        assert_eq!(finish_accepted(&db, &mut |_, _| panic!("nothing is left to store")), 0);
        // Gmail and Outlook keep their own copy: nothing is stored, the row still goes
        let (db, _) = setup("once-t2b", "smtp.gmail.com");
        put(&db, "g", "sending", 0, now() - 5);
        mark(&db, "g", b"raw");
        assert_eq!(finish_accepted(&db, &mut |_, _| panic!("the provider keeps the copy")), 1);
        assert_eq!(row(&db, "g"), None);
        // a copy that cannot be stored is a line in the log: the message was sent, the row goes
        let (db, _) = setup("once-t2c", "smtp.example.test");
        put(&db, "f", "sending", 0, now() - 5);
        mark(&db, "f", b"raw");
        assert_eq!(finish_accepted(&db, &mut |_, _| Err("no connection".into())), 1);
        assert_eq!(row(&db, "f"), None);
        let _ = acc;
    });
}

#[test]
fn a_resent_message_keeps_its_message_id() {
    let (db, acc) = setup("once-t3", "smtp.example.test");
    let d: smtp::Draft = serde_json::from_str(&payload(None)).unwrap();
    assert!(d.message_id.is_none());
    // the row is made: the id is given once and kept in the payload
    let with = with_message_id(&db, d).unwrap();
    let id = with.message_id.clone().expect("an id was given");
    assert!(id.starts_with('<') && id.ends_with("@example.com>"), "{id}");
    assert_eq!(with_message_id(&db, with.clone()).unwrap().message_id.as_deref(), Some(id.as_str()), "a second call keeps it");
    let stored = serde_json::to_string(&with).unwrap();
    let back: smtp::Draft = serde_json::from_str(&stored).unwrap();
    assert_eq!(back.message_id.as_deref(), Some(id.as_str()), "it survives the database");
    // every build of the row carries it, whatever the day: the first send and the one after a crash are the same message to the receiver
    let first = smtp::wire(&smtp::build(&acc, &back).unwrap());
    let second = smtp::wire(&smtp::build(&acc, &back).unwrap());
    let mid = |raw: &[u8]| mail::parse(1, raw, true, false, 0).unwrap().message_id.unwrap();
    assert_eq!(mid(&first), id);
    assert_eq!(mid(&second), id);
    // a draft without one still gets a new id at every build, as before; an id nobody could have made is not written into a header
    let plain: smtp::Draft = serde_json::from_str(&payload(None)).unwrap();
    assert_ne!(mid(&smtp::wire(&smtp::build(&acc, &plain).unwrap())), mid(&smtp::wire(&smtp::build(&acc, &plain).unwrap())));
    let evil: smtp::Draft = serde_json::from_str(&payload(Some("<a@b>\r\nBcc: x@y.z"))).unwrap();
    let built = smtp::wire(&smtp::build(&acc, &evil).unwrap());
    assert!(!String::from_utf8_lossy(&built).contains("Bcc: x@y.z"), "a bad id is ignored");
}

#[test]
fn the_worker_does_not_claim_during_a_quit() {
    let src = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let worker = &src[src.find("fn outbox_worker").unwrap()..];
    let worker = &worker[..worker.find("\n}\n").unwrap()];
    assert!(worker.contains("if !worker_may_claim() {\n                break;\n            }"), "{worker}");
    assert!(worker.find("worker_may_claim()").unwrap() < worker.find("claim_outbox(").unwrap(), "the check comes before the claim");
    let may = &src[src.find("fn worker_may_claim").unwrap()..];
    assert!(may[..may.find("\n}\n").unwrap()].contains("QUIT_BUSY.load"), "it reads the flag a quit sets");
    // the quit sets that flag first thing, before it asks any page
    let fin = &src[src.find("fn finish_sends_then").unwrap()..];
    assert!(fin.find("QUIT_BUSY.swap(true").unwrap() < fin.find("flush_targets(app)").unwrap());
}

#[test]
fn a_due_scheduled_message_is_sent_once_at_quit() {
    let (db, _) = setup("once-t5", "smtp.example.test");
    let t = 1_000_000;
    put(&db, "due1", "pending", 0, t - 50);
    put(&db, "due2", "pending", 0, t - 10);
    put(&db, "later", "pending", 0, t + 86_400);
    put(&db, "overdue", "overdue", 0, t - 7_200);
    put(&db, "held", "held", 0, t - 100);
    let mut sent_ids = vec![];
    let (sent, left) = send_due_at_quit(&db, t, std::time::Duration::from_secs(5), &mut |id, _payload, _attempts, _due| {
        sent_ids.push(id.to_string());
        lock(&db).execute("DELETE FROM outbox WHERE id=?1", [id]).unwrap(); // (what `deliver` does when the server accepts)
        Ok(())
    });
    assert_eq!((sent, left), (2, 0));
    assert_eq!(sent_ids, vec!["due1", "due2"], "in the order of their times");
    assert!(row(&db, "later").is_some() && row(&db, "overdue").is_some() && row(&db, "held").is_some(), "what waits stays, an Overdue row waits for the person's decision");
    assert_eq!(row(&db, "later"), Some(("pending".into(), 0)));
    // a second pass finds nothing: once
    let again = send_due_at_quit(&db, t, std::time::Duration::from_secs(5), &mut |_, _, _, _| panic!("sent twice"));
    assert_eq!(again, (0, 0));
    // a row that fails stays for the next start and is counted as left behind; the next row is still tried
    put(&db, "bad", "pending", 0, t - 30);
    put(&db, "good", "pending", 0, t - 20);
    let (sent, left) = send_due_at_quit(&db, t, std::time::Duration::from_secs(5), &mut |id, _, _, _| {
        if id == "bad" {
            lock(&db).execute("UPDATE outbox SET status='pending' WHERE id='bad'", []).unwrap();
            Err("refused".into())
        } else {
            lock(&db).execute("DELETE FROM outbox WHERE id=?1", [id]).unwrap();
            Ok(())
        }
    });
    assert_eq!((sent, left), (1, 1));
    assert_eq!(row(&db, "bad"), Some(("pending".into(), 0)));
    // the budget: nothing is started once it is used up
    put(&db, "slow", "pending", 0, t - 5);
    let (sent, left) = send_due_at_quit(&db, t, std::time::Duration::ZERO, &mut |_, _, _, _| panic!("over the budget"));
    assert_eq!((sent, left), (0, 2), "bad and slow are left");
}

#[test]
fn a_row_the_worker_is_sending_is_waited_for_within_the_budget() {
    let (db, _) = setup("once-wait", "smtp.example.test");
    let t = 1_000_000;
    put(&db, "busy", "sending", 0, t - 5);
    put(&db, "due", "pending", 0, t - 4);
    // the worker finishes its row after 300 ms: the quit waits for it, then sends the rest
    let db2 = db.clone();
    let finisher = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        lock(&db2).execute("DELETE FROM outbox WHERE id='busy'", []).unwrap();
    });
    let t0 = std::time::Instant::now();
    let (sent, _) = send_due_at_quit(&db, t, std::time::Duration::from_secs(10), &mut |id, _, _, _| {
        lock(&db).execute("DELETE FROM outbox WHERE id=?1", [id]).unwrap();
        Ok(())
    });
    finisher.join().unwrap();
    assert_eq!(sent, 1);
    assert!(t0.elapsed() >= std::time::Duration::from_millis(250), "it waited for the row that was being sent");
    // a row that never finishes does not hold the quit longer than the budget
    let (db, _) = setup("once-stuck", "smtp.example.test");
    put(&db, "stuck", "sending", 0, t - 5);
    let t0 = std::time::Instant::now();
    let r = send_due_at_quit(&db, t, std::time::Duration::from_millis(400), &mut |_, _, _, _| panic!("no budget left"));
    assert_eq!(r, (0, 0));
    assert!(t0.elapsed() < std::time::Duration::from_secs(3));
}

#[test]
fn the_quit_question_counts_only_what_waits() {
    let (db, _) = setup("once-t6", "smtp.example.test");
    let t = 1_000_000;
    // only what is due now, being sent or in its Undo time: no question
    put(&db, "due", "pending", 0, t - 50);
    put(&db, "sending", "sending", 0, t - 50);
    put(&db, "undo", "undo", 1, t + 20);
    assert_eq!(outbox_counts_at(&db, t), (0, None));
    assert_eq!(outbox_due_count(&db, t), 1);
    // a message for tomorrow, one being edited and one that waits for the person's decision
    put(&db, "tomorrow", "pending", 0, t + 86_400);
    put(&db, "next-week", "pending", 0, t + 7 * 86_400);
    put(&db, "held", "held", 0, t - 100);
    put(&db, "overdue", "overdue", 0, t - 7_200);
    assert_eq!(outbox_counts_at(&db, t), (4, Some(t + 86_400)), "the earliest time still to come");
    assert_eq!(outbox_due_count(&db, t), 1, "the due one is not in the question");
    // the log lines of the quit
    let src = crate::test_guard::non_test_code(include_str!("lib.rs"));
    assert!(src.contains("quit: {due} scheduled message(s) due now are sent before the app ends; {waiting} wait for the next start"));
    assert!(src.contains("quit: asking the page to save its draft and send the messages in their Undo time"));
}

#[test]
fn the_outbox_pause_is_a_debug_seam_only() {
    let src = crate::test_guard::non_test_code(include_str!("lib.rs"));
    let f = &src[src.find("fn outbox_tick").unwrap()..];
    let f = &f[..f.find("\n}\n").unwrap()];
    assert!(f.contains("if cfg!(debug_assertions) {") && f.contains("HEYLOOK_TEST_OUTBOX_TICK_S") && f.contains("unwrap_or(15)"), "{f}");
}
