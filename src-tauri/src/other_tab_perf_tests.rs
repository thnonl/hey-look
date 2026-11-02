//! 1.0.12: the Inbox "Other" tab of the combined view (3 mailboxes, tens of thousands of messages each) must list quickly.
//! `bench_other_tab` (ignored; `cargo test --release bench_other_tab -- --ignored --nocapture`) prints the timings, the plain test checks a generous budget.
use super::*;
use std::time::Instant;

const IDS: [&str; 3] = ["pa1", "pb2", "pc3"];

fn account(id: &str) -> Account {
    Account {
        id: id.into(), email: format!("{id}@example.com"), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
        smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
        smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
    }
}

/// `per` Inbox messages in each of three mailboxes (about 3 in 4 from a list: the Other tab; every 10th message continues the previous conversation; a third is unread),
/// plus `per / 4` messages in Sent and Archive, and a few blocked senders.
fn seeded(per: u32) -> Connection {
    seeded_in(per, None, 0)
}

/// `dir`: mail files on disk there (reused when they exist: rows are replaced, not added); `body`: bytes of HTML body of a list mail (a newsletter is big).
fn seeded_in(per: u32, dir: Option<&std::path::Path>, body: usize) -> Connection {
    if let Some(d) = dir {
        // (an earlier draft of the index in the files of a previous run)
        if let Ok(c) = Connection::open(d.join("heylook.db")) {
            for id in IDS {
                if let Ok(s) = Connection::open(d.join(shard::file_name(id))) {
                    let _ = s.execute_batch("DROP INDEX IF EXISTS idx_msg_counts; DROP INDEX IF EXISTS idx_msg_fcounts;");
                }
            }
            drop(c);
        }
    }
    if std::env::var("PERF_NOSEED").is_ok() {
        return db::open(&dir.unwrap().join("heylook.db")).unwrap(); // (the files of an earlier run: opening them is what a start does, so it shows a new index being built)
    }
    let c = match dir {
        Some(d) => db::open(&d.join("heylook.db")).unwrap(),
        None => db::test_conn(&[]),
    };
    for id in IDS {
        db::insert_account(&c, &account(id)).unwrap();
        shard::ensure(&c, id).unwrap();
    }
    let html: Option<String> = (body > 0).then(|| "<p>Newsletter paragraph with a <a href=\"https://x.example/a\">link</a> and some words.</p>".repeat(body / 80));
    c.execute_batch("BEGIN").unwrap();
    {
        let mut st = c
            .prepare(
                "INSERT OR REPLACE INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,seen,list_unsub,body_html)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'','',?9,?10,?11,?12,?13)",
            )
            .unwrap();
        let t0 = now() - 3 * 365 * 86400;
        for (ai, a) in IDS.iter().enumerate() {
            for i in 1..=per {
                let bulk = (i * 7 + ai as u32) % 4 != 0;
                let thread = if i % 10 == 0 { format!("{a}-t{}", i - 1) } else { format!("{a}-t{i}") };
                st.execute(params![
                    format!("{a}:inbox:{i}"), a, "inbox", i, thread, format!("Subject number {i} of {a}"), format!("Sender {}", i % 500),
                    format!("s{}@example{}.test", i % 500, i % 7), t0 + i as i64 * 30 + ai as i64, "a snippet of about one hundred and fifty characters of text, as the list shows it under the subject line of the conversation",
                    ((i % 3) != 0) as i64, bulk.then_some("<mailto:u@example.test>"), if bulk { html.clone() } else { None }
                ])
                .unwrap();
            }
            for i in 1..=per / 4 {
                for f in ["sent", "archive"] {
                    st.execute(params![format!("{a}:{f}:{i}"), a, f, i, format!("{a}-{f}-t{i}"), "s", "n", "x@example.test", t0 + i as i64 * 90, "", 1, None::<String>, None::<String>]).unwrap();
                }
            }
        }
    }
    c.execute_batch("COMMIT").unwrap();
    for i in 0..5 {
        c.execute("INSERT OR IGNORE INTO blocked(email) VALUES(?1)", [format!("s{i}@example0.test")]).unwrap();
    }
    c
}

fn filter(v: serde_json::Value) -> ThreadFilter {
    serde_json::from_value(v).unwrap()
}

fn other_all() -> ThreadFilter {
    filter(serde_json::json!({ "accountId": null, "folder": "inbox", "focus": "other", "search": "", "flat": false, "unreadOnly": false, "flaggedOnly": false, "sortAsc": false, "scope": "current" }))
}

/// The fastest of five runs (a loaded machine only adds time).
fn ms<T>(label: &str, mut f: impl FnMut() -> T) -> (T, f64) {
    let mut best = f64::MAX;
    let mut v = None;
    for _ in 0..5 {
        let t = Instant::now();
        v = Some(f());
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
    }
    println!("{label}: best of 5 {best:.1} ms");
    (v.unwrap(), best)
}

#[test]
#[ignore]
fn bench_other_tab() {
    let per: u32 = std::env::var("PERF_PER").ok().and_then(|v| v.parse().ok()).unwrap_or(30000);
    let body: usize = std::env::var("PERF_BODY").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let dir = std::env::var("PERF_DIR").ok().map(std::path::PathBuf::from);
    let t0 = Instant::now();
    let c = seeded_in(per, dir.as_deref(), body);
    println!("seed/open: {:.0} ms", t0.elapsed().as_secs_f64() * 1000.0);
    for (name, f) in [
        ("other all", other_all()),
        ("focused all", filter(serde_json::json!({ "accountId": null, "folder": "inbox", "focus": "focused" }))),
        ("other one account", filter(serde_json::json!({ "accountId": "pa1", "folder": "inbox", "focus": "other" }))),
        ("inbox no tab (Focused Inbox off), all", filter(serde_json::json!({ "accountId": null, "folder": "inbox" }))),
        ("other unread, all", filter(serde_json::json!({ "accountId": null, "folder": "inbox", "focus": "other", "unreadOnly": true }))),
    ] {
        let (r, _) = ms(name, || threads_for(&c, ThreadFilter { account_id: f.account_id.clone(), folder: f.folder.clone(), search: f.search.clone(), focus: f.focus.clone(), flat: f.flat, unread_only: f.unread_only, flagged_only: f.flagged_only, sort_asc: f.sort_asc, scope: f.scope.clone() }).unwrap());
        let rows = r.len();
        println!("  -> {rows} conversations, json {} bytes", serde_json::to_string(&r).unwrap().len());
    }
    ms("folder_infos", || folder_infos(&c).unwrap());
    let badge = || c.query_row("SELECT COUNT(DISTINCT m.thread_id) FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id WHERE m.folder='inbox' AND m.seen=0 AND (tm.snoozed_until IS NULL OR tm.snoozed_until<=?1) AND m.from_email NOT IN (SELECT email FROM blocked) AND (?2=1 OR m.list_unsub IS NULL)", params![now(), 1], |r| r.get::<_, i64>(0)).unwrap();
    ms("badge count (shell::unread_count query)", badge);
    for id in IDS {
        c.execute_batch(&format!("DROP INDEX m_{id}.idx_msg_fcounts")).unwrap();
    }
    println!("--- without idx_msg_fcounts (the old layout) ---");
    ms("folder_infos", || folder_infos(&c).unwrap());
    ms("badge count (shell::unread_count query)", badge);
    for q in ["SELECT 'pa1',folder,COUNT(DISTINCT thread_id), COUNT(DISTINCT CASE WHEN seen=0 AND folder!='inbox' AND thread_id NOT IN (SELECT value FROM json_each('[]')) THEN thread_id END) FROM m_pa1.messages GROUP BY folder", "SELECT COUNT(DISTINCT m.thread_id) FROM m_pa1.messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id WHERE m.account_id='pa1' AND m.folder='inbox' AND m.seen=0"] {
        let mut st = c.prepare(&format!("EXPLAIN QUERY PLAN {q}")).unwrap();
        let plan: Vec<String> = st.query_map([], |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect();
        println!("count plan: {}", plan.join(" | "));
    }
    let mut st = c.prepare("EXPLAIN QUERY PLAN SELECT m.thread_id FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id WHERE m.folder='inbox' AND (tm.snoozed_until IS NULL OR tm.snoozed_until<=1) AND m.from_email NOT IN (SELECT email FROM blocked) AND m.list_unsub IS NOT NULL ORDER BY m.date DESC LIMIT 4000").unwrap();
    let plan: Vec<String> = st.query_map([], |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect();
    println!("plan:\n{}", plan.join("\n"));
}

/// The combined Other list is exactly the newest 4000 messages of the view, in date order, made into conversations.
#[test]
fn combined_other_list_equals_the_view_read() {
    let c = seeded(2500); // 7500 inbox messages: more list mail than the 4000 cap
    let got: Vec<ThreadSummary> = threads_for(&c, other_all()).unwrap();
    let mut st = c
        .prepare(
            "SELECT DISTINCT thread_id FROM (SELECT m.thread_id FROM messages m WHERE m.folder='inbox' AND m.list_unsub IS NOT NULL
               AND m.from_email NOT IN (SELECT email FROM blocked) ORDER BY m.date DESC LIMIT 4000)",
        )
        .unwrap();
    let want: std::collections::HashSet<String> = st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
    let have: std::collections::HashSet<String> = got.iter().map(|t| t.thread_id.clone()).collect();
    assert_eq!(have, want);
    assert!(got.windows(2).all(|w| w[0].last_date >= w[1].last_date), "newest first");
    // oldest first reads the other end
    let mut f = other_all();
    f.sort_asc = true;
    let asc = threads_for(&c, f).unwrap();
    assert!(asc.windows(2).all(|w| w[0].last_date <= w[1].last_date), "oldest first");
    assert!(asc[0].last_date < got.last().unwrap().last_date, "the oldest list is another part of the mailboxes");
    // the three mailboxes all show in the merged list
    for id in IDS {
        assert!(got.iter().any(|t| t.account_id == id), "{id} is in the list");
    }
}

/// Plans, not clocks (a clock budget cannot tell the old and the new read apart on a slow CI machine): a list read of one mailbox file goes by the
/// (account, folder, date) index with no sort, and the folder counts are read from the covering index, never from the message rows with their bodies.
#[test]
fn list_and_count_reads_use_the_indexes() {
    let c = seeded(300);
    let plan = |sql: &str| -> String {
        let mut st = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        st.query_map([], |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect::<Vec<_>>().join(" | ")
    };
    let table = shard::messages_table(&c, IDS[0]).unwrap();
    let w = vec!["m.account_id=?".to_string(), "m.folder='inbox'".into(), "m.list_unsub IS NOT NULL".into()];
    let list = plan(&list_sql(&table, &w, "DESC").replace('?', "'pa1'"));
    assert!(list.contains("idx_msg_folder"), "list: {list}");
    assert!(!list.contains("TEMP B-TREE FOR ORDER BY"), "list sorts: {list}");
    let counts = plan(&format!("SELECT folder,COUNT(DISTINCT thread_id),COUNT(DISTINCT CASE WHEN seen=0 THEN thread_id END) FROM {table} GROUP BY folder"));
    assert!(counts.contains("COVERING INDEX idx_msg_fcounts"), "counts: {counts}");
}

/// Generous clock check on top (30 000 list mails): the Other tab of three mailboxes and the folder numbers, together, well under what a person notices as a stall
/// even in a debug build on a loaded machine.
#[test]
fn other_tab_and_folder_numbers_in_budget() {
    let c = seeded(10000);
    let t = Instant::now();
    let got = threads_for(&c, other_all()).unwrap();
    let list_ms = t.elapsed().as_millis();
    let t = Instant::now();
    folder_infos(&c).unwrap();
    let count_ms = t.elapsed().as_millis();
    assert!(!got.is_empty());
    assert!(list_ms < 3000 && count_ms < 3000, "list {list_ms} ms, folder numbers {count_ms} ms");
}
