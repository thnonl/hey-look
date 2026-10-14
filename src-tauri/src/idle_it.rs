//! Integration tests of the IDLE worker against a real IMAP server in Docker. Opt-in: nothing runs unless `HEYLOOK_IDLE_IT=1` (the
//! tests then return at once, so `cargo test` and CI stay as they are). `scripts/idle-it/run.ps1` / `run.sh` start the servers, set
//! the variables below and run `cargo test --lib idle_it -- --test-threads=1 --nocapture`.
//!
//! Variables: `HL_IT_PORT` (IMAPS port of the IDLE server on 127.0.0.1), `HL_IT_USER`, `HL_IT_PASS`, `HL_IT_SMTP_PORT` (optional: mail
//! is delivered by SMTP; without it by IMAP APPEND), `HL_IT_CONTAINER` (optional: the container the restart test restarts),
//! `HL_IT_NOIDLE_PORT` (optional: IMAPS port of a server that does not offer IDLE; the fallback test needs it).
//! The servers use a self-signed certificate: the account has `tls_insecure` set, as a user's account would.
use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};

/// The tests share the servers: one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

struct Env {
    port: u16,
    user: String,
    pass: String,
    smtp: Option<u16>,
    container: Option<String>,
    noidle: Option<u16>,
}

fn env() -> Option<Env> {
    if std::env::var("HEYLOOK_IDLE_IT").ok().as_deref() != Some("1") {
        eprintln!("idle integration test skipped (set HEYLOOK_IDLE_IT=1; see scripts/idle-it)");
        return None;
    }
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    Some(Env {
        port: get("HL_IT_PORT").expect("HL_IT_PORT").parse().expect("HL_IT_PORT is a number"),
        user: get("HL_IT_USER").expect("HL_IT_USER"),
        pass: get("HL_IT_PASS").expect("HL_IT_PASS"),
        smtp: get("HL_IT_SMTP_PORT").map(|v| v.parse().expect("HL_IT_SMTP_PORT is a number")),
        container: get("HL_IT_CONTAINER"),
        noidle: get("HL_IT_NOIDLE_PORT").map(|v| v.parse().expect("HL_IT_NOIDLE_PORT is a number")),
    })
}

fn account(user: &str, port: u16) -> Account {
    Account {
        id: "it".into(),
        email: format!("{user}@example.test"),
        display_name: "IT".into(),
        imap_host: "127.0.0.1".into(),
        imap_port: port,
        imap_ssl: true,
        smtp_host: "127.0.0.1".into(),
        smtp_port: 0,
        smtp_security: "none".into(),
        username: user.into(),
        auth: "password".into(),
        color: None,
        smtp_username: String::new(),
        tls_insecure: true,
    }
}

#[derive(Debug)]
enum Ev {
    Changed(Instant),
    State(Push),
    Log(String),
    Renewed,
}

struct TestHost {
    acc: Account,
    pass: String,
    tx: Mutex<Sender<Ev>>,
    /// Counts `account()` calls = connections the worker opened.
    connects: std::sync::atomic::AtomicU32,
}

impl Host for TestHost {
    fn account(&self) -> R<(Account, String)> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        Ok((self.acc.clone(), self.pass.clone()))
    }
    fn changed(&self) {
        let _ = self.tx.lock().unwrap().send(Ev::Changed(Instant::now()));
    }
    fn state(&self, s: Push) {
        let _ = self.tx.lock().unwrap().send(Ev::State(s));
    }
    fn log(&self, what: &str) {
        eprintln!("[host] {what}");
        let _ = self.tx.lock().unwrap().send(Ev::Log(what.to_string()));
    }
    fn renewed(&self) {
        let _ = self.tx.lock().unwrap().send(Ev::Renewed);
    }
}

/// A worker thread plus a watchdog thread that does what the supervisor's tick does.
struct Worker {
    sh: Arc<Shared>,
    host: Arc<TestHost>,
    rx: Receiver<Ev>,
    threads: Vec<JoinHandle<()>>,
    done: Arc<AtomicBool>,
}

fn fast() -> Timing {
    Timing {
        keepalive: Duration::from_secs(25 * 60),
        grace: Duration::from_secs(30),
        poll: Duration::from_millis(500),
        finish: Duration::from_secs(5),
        debounce: Duration::from_millis(300),
        min_gap: Duration::from_millis(500),
        backoff: vec![Duration::from_secs(1), Duration::from_secs(1), Duration::from_secs(2)],
        stable_after: Duration::from_secs(120),
        polling_after_failures: 2,
        healthy_poll_min: 10,
        unsupported_retry: Duration::from_secs(3600),
    }
}

impl Worker {
    fn start(acc: Account, pass: &str, t: Timing) -> Worker {
        let (tx, rx) = channel();
        let host = Arc::new(TestHost { acc, pass: pass.into(), tx: Mutex::new(tx), connects: Default::default() });
        let sh = Shared::new();
        let done = Arc::new(AtomicBool::new(false));
        let (h2, s2, t2) = (host.clone(), sh.clone(), t.clone());
        let worker = std::thread::spawn(move || run_account(&s2, h2.as_ref(), &t2, false));
        let (s3, d3) = (sh.clone(), done.clone());
        let dog = std::thread::spawn(move || {
            while !d3.load(Ordering::SeqCst) {
                if s3.watchdog(Instant::now()) {
                    eprintln!("[watchdog] cut a silent connection");
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
        Worker { sh, host, rx, threads: vec![worker, dog], done }
    }

    /// Waits for an event the predicate picks; the others are skipped.
    fn wait<T>(&self, within: Duration, mut pick: impl FnMut(&Ev) -> Option<T>) -> Option<T> {
        let end = Instant::now() + within;
        loop {
            let left = end.checked_duration_since(Instant::now())?;
            match self.rx.recv_timeout(left) {
                Ok(e) => {
                    if let Some(v) = pick(&e) {
                        return Some(v);
                    }
                }
                Err(_) => return None,
            }
        }
    }

    fn wait_state(&self, want: Push, within: Duration) -> bool {
        self.wait(within, |e| matches!(e, Ev::State(s) if *s == want).then_some(())).is_some()
    }

    /// Stops it the way the app does and checks that it ends fast.
    fn stop(self) -> Duration {
        let t0 = Instant::now();
        self.sh.stop_now();
        self.done.store(true, Ordering::SeqCst);
        for t in self.threads {
            t.join().expect("thread ended without a panic");
        }
        t0.elapsed()
    }
}

fn raw_mail(user: &str, subject: &str) -> String {
    format!(
        "From: sender@example.test\r\nTo: {user}@example.test\r\nSubject: {subject}\r\nDate: Wed, 14 Oct 2026 10:00:00 +0000\r\nMessage-ID: <{}@it.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody of {subject}\r\n",
        uuid::Uuid::new_v4()
    )
}

/// New mail arrives at `port` the way real mail does (SMTP) or, without a SMTP port, through a second IMAP connection (APPEND).
fn deliver(e: &Env, port: u16, subject: &str) {
    match (e.smtp, port == e.port) {
        (Some(p), true) => {
            use lettre::{Message, SmtpTransport, Transport};
            let m = Message::builder()
                .from("sender@example.test".parse().unwrap())
                .to(format!("{}@example.test", e.user).parse().unwrap())
                .subject(subject)
                .body(format!("body of {subject}"))
                .unwrap();
            SmtpTransport::builder_dangerous("127.0.0.1").port(p).build().send(&m).expect("SMTP delivery");
        }
        _ => {
            let (mut s, _) = mail::connect_with_socket(&account(&e.user, port), &e.pass).expect("second connection");
            mail::append(&mut s, "INBOX", raw_mail(&e.user, subject).as_bytes(), false).expect("APPEND");
            let _ = s.logout();
        }
    }
}

/// The subjects of the INBOX, read the way the sync does (`fetch_folder`).
fn inbox_subjects(e: &Env, port: u16) -> Vec<String> {
    let (mut s, _) = mail::connect_with_socket(&account(&e.user, port), &e.pass).expect("connect");
    let ff = mail::fetch_folder(&mut s, "INBOX", 0, 0, 200).expect("fetch");
    let _ = s.logout();
    ff.new.into_iter().map(|p| p.subject).collect()
}

/// A TCP relay between the worker and the server (TLS passes through untouched) that can cut every connection or swallow the traffic.
struct Proxy {
    port: u16,
    blackhole: Arc<AtomicBool>,
    conns: Arc<Mutex<Vec<TcpStream>>>,
    closing: Arc<AtomicBool>,
}

impl Proxy {
    fn start(upstream_port: u16) -> Proxy {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let p = Proxy { port, blackhole: Arc::new(AtomicBool::new(false)), conns: Default::default(), closing: Arc::new(AtomicBool::new(false)) };
        let (bh, conns, closing) = (p.blackhole.clone(), p.conns.clone(), p.closing.clone());
        std::thread::spawn(move || {
            for c in l.incoming() {
                if closing.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(client) = c else { continue };
                let Ok(server) = TcpStream::connect(("127.0.0.1", upstream_port)) else { continue };
                for (from, to) in [(client.try_clone().unwrap(), server.try_clone().unwrap()), (server.try_clone().unwrap(), client.try_clone().unwrap())] {
                    let bh = bh.clone();
                    std::thread::spawn(move || {
                        let (mut from, mut to) = (from, to);
                        let mut buf = [0u8; 8192];
                        loop {
                            match from.read(&mut buf) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    if !bh.load(Ordering::SeqCst) && to.write_all(&buf[..n]).is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                        let _ = to.shutdown(Shutdown::Both);
                    });
                }
                let mut g = conns.lock().unwrap();
                g.push(client);
                g.push(server);
            }
        });
        p
    }

    /// The server closes every connection.
    fn cut_all(&self) {
        for c in self.conns.lock().unwrap().drain(..) {
            let _ = c.shutdown(Shutdown::Both);
        }
    }

    fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        self.cut_all();
    }
}

const WAIT: Duration = Duration::from_secs(30);

#[test]
fn it_new_mail_appears_within_5_seconds_without_a_poll() {
    let Some(e) = env() else { return };
    let _g = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    // the production debounce (2 s), so the 5 s bound is the real one
    let t = Timing { debounce: Timing::default().debounce, ..fast() };
    let w = Worker::start(account(&e.user, e.port), &e.pass, t);
    assert!(w.wait_state(Push::On, WAIT), "IDLE came up");
    // the poll interval of a healthy account is the long one
    assert_eq!(poll_minutes(Push::On, 2, &Timing::default()), 10);
    let subject = format!("push-{}", uuid::Uuid::new_v4());
    let t0 = Instant::now();
    deliver(&e, e.port, &subject);
    let at = w.wait(Duration::from_secs(5), |ev| if let Ev::Changed(t) = ev { Some(*t) } else { None }).expect("a change was reported within 5 s");
    let took = at.duration_since(t0);
    eprintln!("[it] mail delivered, sync triggered after {took:?}");
    assert!(took < Duration::from_secs(5));
    assert!(inbox_subjects(&e, e.port).contains(&subject), "the sync path sees the mail");
    // a burst of three is one or two syncs, not three
    for i in 0..3 {
        deliver(&e, e.port, &format!("burst-{i}-{}", uuid::Uuid::new_v4()));
    }
    std::thread::sleep(Duration::from_secs(3));
    let mut n = 0;
    while w.rx.try_recv().map(|ev| n += matches!(ev, Ev::Changed(_)) as u32).is_ok() {}
    eprintln!("[it] burst of 3 mails: {n} sync(s)");
    assert!((1..=2).contains(&n), "burst coalesced, got {n}");
    let took = w.stop();
    eprintln!("[it] stopped in {took:?}");
    assert!(took < Duration::from_secs(3), "stop is quick");
}

#[test]
fn it_the_session_survives_the_server_closing_the_connection() {
    let Some(e) = env() else { return };
    let _g = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let proxy = Proxy::start(e.port);
    let w = Worker::start(account(&e.user, proxy.port), &e.pass, fast());
    assert!(w.wait_state(Push::On, WAIT));
    let before = w.host.connects.load(Ordering::SeqCst);
    proxy.cut_all();
    // the worker notices at once, waits its backoff, reconnects
    let line = w.wait(Duration::from_secs(15), |ev| if let Ev::Log(l) = ev { l.starts_with("reconnect in").then(|| l.clone()) } else { None });
    assert!(line.is_some(), "the loss is logged with the reconnect delay");
    let subject = format!("after-cut-{}", uuid::Uuid::new_v4());
    // mail delivered while the push connection was gone is found by the catch-up sync that follows the new IDLE
    deliver(&e, e.port, &subject);
    let got = w.wait(Duration::from_secs(20), |ev| matches!(ev, Ev::Changed(_)).then_some(()));
    assert!(got.is_some(), "a sync follows the reconnect (catch-up or push event)");
    assert!(w.host.connects.load(Ordering::SeqCst) > before, "a new connection was made");
    // and push works on the new connection
    std::thread::sleep(Duration::from_secs(2));
    while w.rx.try_recv().is_ok() {}
    let s2 = format!("push-after-cut-{}", uuid::Uuid::new_v4());
    let t0 = Instant::now();
    deliver(&e, e.port, &s2);
    let at = w.wait(Duration::from_secs(5), |ev| if let Ev::Changed(t) = ev { Some(*t) } else { None }).expect("push after the reconnect");
    eprintln!("[it] after reconnect: sync triggered after {:?}", at.duration_since(t0));
    w.stop();
    proxy.close();
}

#[test]
fn it_a_server_restart_is_survived() {
    let Some(e) = env() else { return };
    let Some(c) = e.container.clone() else {
        eprintln!("[it] HL_IT_CONTAINER not set: restart test skipped");
        return;
    };
    let _g = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let w = Worker::start(account(&e.user, e.port), &e.pass, fast());
    assert!(w.wait_state(Push::On, WAIT));
    let out = crate::winproc::hidden("docker").args(["restart", "-t", "1", &c]).output().expect("docker");
    assert!(out.status.success(), "docker restart: {}", String::from_utf8_lossy(&out.stderr));
    // wait until the server answers again (it takes a few seconds), then deliver
    let end = Instant::now() + Duration::from_secs(90);
    let subject = format!("after-restart-{}", uuid::Uuid::new_v4());
    loop {
        assert!(Instant::now() < end, "server did not come back");
        if mail::connect_with_socket(&account(&e.user, e.port), &e.pass).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    std::thread::sleep(Duration::from_secs(6)); // lets the worker's backoff run out and IDLE come up again
    while w.rx.try_recv().is_ok() {}
    let t0 = Instant::now();
    deliver(&e, e.port, &subject);
    let at = w.wait(Duration::from_secs(20), |ev| if let Ev::Changed(t) = ev { Some(*t) } else { None }).expect("push after the server restart");
    eprintln!("[it] after the server restart: sync triggered after {:?}", at.duration_since(t0));
    w.stop();
}

#[test]
fn it_the_idle_is_renewed_and_still_works() {
    let Some(e) = env() else { return };
    let _g = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let mut t = fast();
    t.keepalive = Duration::from_secs(2);
    let w = Worker::start(account(&e.user, e.port), &e.pass, t);
    assert!(w.wait_state(Push::On, WAIT));
    let mut renewals = 0;
    w.wait(Duration::from_secs(12), |ev| {
        renewals += matches!(ev, Ev::Renewed) as u32;
        (renewals >= 3).then_some(())
    })
    .expect("IDLE was ended and issued again three times");
    assert_eq!(w.host.connects.load(Ordering::SeqCst), 1, "renewal reuses the connection");
    let t0 = Instant::now();
    deliver(&e, e.port, &format!("renewed-{}", uuid::Uuid::new_v4()));
    let at = w.wait(Duration::from_secs(5), |ev| if let Ev::Changed(t) = ev { Some(*t) } else { None }).expect("push after renewals");
    eprintln!("[it] after 3 renewals: sync triggered after {:?}", at.duration_since(t0));
    w.stop();
}

#[test]
fn it_a_peer_that_goes_silent_is_given_up_on_by_the_read_timeouts_and_the_worker_reconnects() {
    let Some(e) = env() else { return };
    let _g = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let proxy = Proxy::start(e.port);
    let mut t = fast();
    t.keepalive = Duration::from_secs(2);
    t.finish = Duration::from_secs(2);
    // the watchdog (socket shutdown) must not be what saves it: Windows does not wake a read that way when the peer is silent
    t.grace = Duration::from_secs(120);
    let w = Worker::start(account(&e.user, proxy.port), &e.pass, t);
    assert!(w.wait_state(Push::On, WAIT));
    // the network swallows everything (sleep, a dropped NAT entry): the DONE after the renewal is never answered
    proxy.blackhole.store(true, Ordering::SeqCst);
    let line = w.wait(Duration::from_secs(20), |ev| if let Ev::Log(l) = ev { l.starts_with("reconnect in").then(|| l.clone()) } else { None });
    eprintln!("[it] silent peer: {line:?}");
    assert!(line.is_some(), "the read timeouts freed the worker");
    proxy.blackhole.store(false, Ordering::SeqCst);
    proxy.cut_all();
    std::thread::sleep(Duration::from_secs(4));
    while w.rx.try_recv().is_ok() {}
    let t0 = Instant::now();
    deliver(&e, e.port, &format!("after-silence-{}", uuid::Uuid::new_v4()));
    let at = w.wait(Duration::from_secs(20), |ev| if let Ev::Changed(t) = ev { Some(*t) } else { None }).expect("push works again");
    eprintln!("[it] after the silence: sync triggered after {:?}", at.duration_since(t0));
    w.stop();
    proxy.close();
}

#[test]
fn it_a_server_without_idle_is_left_to_the_poller() {
    let Some(e) = env() else { return };
    let Some(port) = e.noidle else {
        eprintln!("[it] HL_IT_NOIDLE_PORT not set: fallback test skipped");
        return;
    };
    let _g = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let w = Worker::start(account(&e.user, port), &e.pass, fast());
    assert!(w.wait_state(Push::Polling, WAIT), "state is polling");
    let line = w.wait(Duration::from_secs(5), |ev| if let Ev::Log(l) = ev { l.contains("no IDLE").then(|| l.clone()) } else { None });
    assert!(line.is_some(), "the log names the reason");
    // the poller keeps its normal interval for this account
    assert_eq!(poll_minutes(Push::Polling, 2, &Timing::default()), 2);
    // nothing is pushed, no connection is held open and none is made again and again
    deliver(&e, port, &format!("nopush-{}", uuid::Uuid::new_v4()));
    assert!(w.wait(Duration::from_secs(4), |ev| matches!(ev, Ev::Changed(_)).then_some(())).is_none(), "no push event without IDLE");
    assert_eq!(w.host.connects.load(Ordering::SeqCst), 1, "no reconnect loop");
    let took = w.stop();
    assert!(took < Duration::from_secs(3));
}
