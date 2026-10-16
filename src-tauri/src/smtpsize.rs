//! The largest message the SMTP server of an account takes: the SIZE extension of EHLO (RFC 1870), e.g. `250-SIZE 35882577`.
//! Compose uses it (the smaller of it and the usual 25 MB) when it checks the size of what is about to be sent (QA round 17, G-07 /
//! CF-21; round 19A BUG-16). It is asked when a message is opened, when its attachments change and before Send, answered from a cache
//! for a while (a limit is remembered for 10 minutes, a failed question for one minute), and every failure (no connection, no SIZE,
//! `SIZE 0` = no declared limit) is just "unknown": the usual limit then applies.

use crate::db::{Account, R};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const EHLO_NAME: &str = "hey-look.local";
const TIMEOUT: Duration = Duration::from_secs(8);
const KEEP: Duration = Duration::from_secs(10 * 60);
const KEEP_FAILED: Duration = Duration::from_secs(60);

/// `SIZE n` in the lines of an EHLO reply. `None` when the server does not name one or says 0 (no fixed limit).
pub fn parse_size(reply: &[String]) -> Option<u64> {
    reply.iter().skip(1).find_map(|l| {
        let ext = l.get(4..)?.trim();
        let mut it = ext.split_ascii_whitespace();
        it.next().filter(|k| k.eq_ignore_ascii_case("SIZE"))?;
        it.next()?.parse::<u64>().ok().filter(|n| *n > 0)
    })
}

fn offers_starttls(reply: &[String]) -> bool {
    reply.iter().skip(1).any(|l| l.get(4..).is_some_and(|e| e.trim().eq_ignore_ascii_case("STARTTLS")))
}

/// One SMTP reply (all its lines, `250-...` continuing, `250 ...` last). `None` when the server went away or answered nothing.
fn read_reply<S: Read>(r: &mut BufReader<S>) -> Option<Vec<String>> {
    let mut lines = vec![];
    for _ in 0..200 {
        let mut line = String::new();
        match r.read_line(&mut line) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        let line = line.trim_end().to_string();
        let more = line.as_bytes().get(3) == Some(&b'-');
        lines.push(line);
        if !more {
            return Some(lines);
        }
    }
    None
}

fn command<S: Read + Write>(r: &mut BufReader<S>, cmd: &str) -> Option<Vec<String>> {
    r.get_mut().write_all(cmd.as_bytes()).ok()?;
    r.get_mut().flush().ok()?;
    read_reply(r)
}

/// Greeting, EHLO. `Some((size, starttls))`; `None` when the server does not talk SMTP the way expected.
fn greet<S: Read + Write>(r: &mut BufReader<S>, expect_greeting: bool) -> Option<(Option<u64>, bool)> {
    if expect_greeting && !read_reply(r)?.first()?.starts_with("220") {
        return None;
    }
    let reply = command(r, &format!("EHLO {EHLO_NAME}\r\n"))?;
    reply.first()?.starts_with("250").then(|| (parse_size(&reply), offers_starttls(&reply)))
}

fn tls(acc: &Account) -> Option<native_tls::TlsConnector> {
    native_tls::TlsConnector::builder().danger_accept_invalid_certs(acc.tls_insecure).danger_accept_invalid_hostnames(acc.tls_insecure).build().ok()
}

fn connect(host: &str, port: u16) -> Option<std::net::TcpStream> {
    use std::net::ToSocketAddrs;
    let sock = (host, port).to_socket_addrs().ok()?.find_map(|a| std::net::TcpStream::connect_timeout(&a, TIMEOUT).ok())?;
    sock.set_read_timeout(Some(TIMEOUT)).ok()?;
    sock.set_write_timeout(Some(TIMEOUT)).ok()?;
    Some(sock)
}

/// Asks the server of `acc` for its SIZE limit (a fresh connection; nothing is sent but EHLO, STARTTLS and QUIT; no login).
pub fn probe(acc: &Account) -> Option<u64> {
    let (host, port) = (acc.smtp_host.as_str(), acc.smtp_port);
    let sock = connect(host, port)?;
    match acc.smtp_security.as_str() {
        "ssl" => {
            let mut r = BufReader::new(tls(acc)?.connect(host, sock).ok()?);
            let size = greet(&mut r, true)?.0;
            let _ = r.get_mut().write_all(b"QUIT\r\n");
            size
        }
        "starttls" => {
            let mut r = BufReader::new(sock);
            let (size, starttls) = greet(&mut r, true)?;
            if size.is_some() || !starttls {
                let _ = r.get_mut().write_all(b"QUIT\r\n");
                return size;
            }
            // some servers name SIZE only inside the secure session
            if !command(&mut r, "STARTTLS\r\n")?.first()?.starts_with("220") {
                return None;
            }
            let mut r = BufReader::new(tls(acc)?.connect(host, r.into_inner()).ok()?);
            let size = greet(&mut r, false)?.0;
            let _ = r.get_mut().write_all(b"QUIT\r\n");
            size
        }
        _ => {
            let mut r = BufReader::new(sock);
            let size = greet(&mut r, true)?.0;
            let _ = r.get_mut().write_all(b"QUIT\r\n");
            size
        }
    }
}

static CACHE: LazyLock<Mutex<HashMap<String, (Instant, Option<u64>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The cache key: the account and everything the question depends on (a changed server, port or security asks again).
fn cache_key(acc: &Account) -> String {
    format!("{}|{}:{}:{}:{}", acc.id, acc.smtp_host, acc.smtp_port, acc.smtp_security, acc.tls_insecure)
}

/// `probe`, remembered per account for a while. A limit stays for 10 minutes, a failure (the server did not answer) for one minute only,
/// so a short outage does not hide a limit for long. `refresh` asks again whatever the cache holds (a send the server refused for its size).
pub fn limit_cached(acc: &Account, refresh: bool) -> Option<u64> {
    let key = cache_key(acc);
    if !refresh {
        if let Some((at, v)) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            if at.elapsed() < if v.is_some() { KEEP } else { KEEP_FAILED } {
                return *v;
            }
        }
    }
    let v = probe(acc);
    CACHE.lock().unwrap_or_else(|p| p.into_inner()).insert(key, (Instant::now(), v));
    v
}

/// Drops what is remembered for an account (its settings were saved or it was removed).
pub fn forget(account_id: &str) {
    let prefix = format!("{account_id}|");
    CACHE.lock().unwrap_or_else(|p| p.into_inner()).retain(|k, _| !k.starts_with(&prefix));
}

/// The SIZE limit of the server of an account, in bytes; `null` when it names none or could not be asked. `refresh` skips the cache.
#[tauri::command]
pub async fn smtp_size_limit(state: tauri::State<'_, crate::AppState>, account_id: String, refresh: Option<bool>) -> R<Option<f64>> {
    let acc = crate::db::get_account(&crate::lock(&state.db), &account_id)?;
    Ok(crate::blocking(move || Ok(limit_cached(&acc, refresh.unwrap_or(false)))).await?.map(|n| n as f64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn lines(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn size_is_read_from_the_ehlo_reply() {
        assert_eq!(parse_size(&lines(&["250-mx.example.com at your service", "250-SIZE 35882577", "250-8BITMIME", "250 SMTPUTF8"])), Some(35_882_577));
        assert_eq!(parse_size(&lines(&["250-mx", "250 size 10485760"])), Some(10_485_760), "last line, any case");
        assert_eq!(parse_size(&lines(&["250-mx", "250-SIZE", "250 PIPELINING"])), None, "SIZE without a number");
        assert_eq!(parse_size(&lines(&["250-mx", "250 SIZE 0"])), None, "0 = no fixed limit");
        assert_eq!(parse_size(&lines(&["250-mx", "250 SIZE abc"])), None);
        assert_eq!(parse_size(&lines(&["250 mx SIZE 99"])), None, "the greeting line is the server name, not an extension");
        assert_eq!(parse_size(&lines(&["250-mx", "250 AUTH LOGIN"])), None);
        assert!(offers_starttls(&lines(&["250-mx", "250-STARTTLS", "250 AUTH"])));
        assert!(!offers_starttls(&lines(&["250-mx", "250 AUTH STARTTLSX"])));
    }

    /// The TLS side of the fake servers: rustls with a self-signed certificate for localhost that is generated when the tests run (once per
    /// process, in memory; the accounts under test set `tls_insecure`, so the client does not check it). No key is stored anywhere.
    fn tls_accept(s: std::net::TcpStream) -> rustls::StreamOwned<rustls::ServerConnection, std::net::TcpStream> {
        static CONFIG: std::sync::OnceLock<Arc<rustls::ServerConfig>> = std::sync::OnceLock::new();
        let config = CONFIG.get_or_init(|| {
            let made = rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()]).unwrap();
            let key = rustls::pki_types::PrivateKeyDer::try_from(made.signing_key.serialize_der()).unwrap();
            let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
            let cfg = rustls::ServerConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![made.cert.der().clone()], key)
                .unwrap();
            Arc::new(cfg)
        });
        // (the handshake runs with the first read or write)
        rustls::StreamOwned::new(rustls::ServerConnection::new(config.clone()).unwrap(), s)
    }

    /// How a fake server is reached: plain, or TLS from the first byte (port 465), or plain until STARTTLS (port 587).
    #[derive(Clone, Copy, PartialEq)]
    enum Kind {
        Plain,
        Implicit,
        StartTls,
    }

    /// Answers EHLO with `ehlo` and QUIT until the client quits; true when the client asked for STARTTLS and it was accepted (`allow_starttls`).
    fn talk<S: Read + Write>(r: &mut BufReader<S>, ehlo: &[&str], allow_starttls: bool, refuse_starttls: bool) -> bool {
        loop {
            let mut line = String::new();
            if r.read_line(&mut line).unwrap_or(0) == 0 {
                return false;
            }
            let up = line.to_ascii_uppercase();
            let out = r.get_mut();
            if up.starts_with("EHLO") {
                for e in ehlo {
                    out.write_all(format!("{e}\r\n").as_bytes()).unwrap();
                }
            } else if up.starts_with("STARTTLS") && allow_starttls {
                if refuse_starttls {
                    out.write_all(b"454 TLS not available\r\n").unwrap();
                    continue;
                }
                out.write_all(b"220 go ahead\r\n").unwrap();
                out.flush().unwrap();
                return true;
            } else if up.starts_with("QUIT") {
                let _ = out.write_all(b"221 bye\r\n");
                return false;
            }
        }
    }

    /// A tiny SMTP server on localhost. `plain` is its EHLO reply before any TLS, `secure` the reply inside TLS (implicit or after STARTTLS).
    /// Returns the port and the number of connections it was asked for.
    fn serve_kind(kind: Kind, plain: &'static [&'static str], secure: &'static [&'static str], refuse_starttls: bool) -> (u16, Arc<AtomicUsize>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(AtomicUsize::new(0));
        let count = seen.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                count.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || match kind {
                    Kind::Plain => {
                        let mut r = BufReader::new(s);
                        r.get_mut().write_all(b"220 test ESMTP\r\n").unwrap();
                        talk(&mut r, plain, false, false);
                    }
                    Kind::Implicit => {
                        let mut r = BufReader::new(tls_accept(s));
                        r.get_mut().write_all(b"220 test ESMTP\r\n").unwrap();
                        talk(&mut r, secure, false, false);
                    }
                    Kind::StartTls => {
                        let mut r = BufReader::new(s);
                        r.get_mut().write_all(b"220 test ESMTP\r\n").unwrap();
                        if talk(&mut r, plain, true, refuse_starttls) {
                            talk(&mut BufReader::new(tls_accept(r.into_inner())), secure, false, false);
                        }
                    }
                });
            }
        });
        (port, seen)
    }

    fn serve(ehlo: &'static [&'static str]) -> u16 {
        serve_kind(Kind::Plain, ehlo, ehlo, false).0
    }

    fn account(port: u16) -> Account {
        Account {
            id: "a1".into(),
            email: "me@example.com".into(),
            display_name: "Me".into(),
            imap_host: "127.0.0.1".into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "127.0.0.1".into(),
            smtp_port: port,
            smtp_security: "none".into(),
            username: "me@example.com".into(),
            auth: "password".into(),
            color: None,
            smtp_username: String::new(),
            // (the fake servers use a throw-away certificate)
            tls_insecure: true,
        }
    }

    fn with(mut a: Account, id: &str, security: &str) -> Account {
        a.id = id.into();
        a.smtp_security = security.into();
        a
    }

    #[test]
    fn a_server_that_names_its_limit_is_asked_once() {
        let port = serve(&["250-test", "250-SIZE 10485760", "250 8BITMIME"]);
        assert_eq!(probe(&account(port)), Some(10_485_760));
        let port = serve(&["250-test", "250 8BITMIME"]);
        assert_eq!(probe(&account(port)), None, "no SIZE: unknown, the usual limit applies");
        let port = serve(&["250-test", "250 SIZE 0"]);
        assert_eq!(probe(&account(port)), None);
        // nothing listens: unknown, quickly
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert_eq!(probe(&account(closed)), None);
    }

    /// QA 19A BUG-16: the stub advertised `SIZE 5000000` on a TLS port and the limit never reached the composer.
    #[test]
    fn the_limit_is_read_through_implicit_tls() {
        let (port, _) = serve_kind(Kind::Implicit, &[], &["250-test", "250-SIZE 5000000", "250 8BITMIME"], false);
        assert_eq!(probe(&with(account(port), "t1", "ssl")), Some(5_000_000));
        let (port, _) = serve_kind(Kind::Implicit, &[], &["250-test", "250 8BITMIME"], false);
        assert_eq!(probe(&with(account(port), "t2", "ssl")), None, "no SIZE inside TLS: unknown");
        let (port, _) = serve_kind(Kind::Implicit, &[], &["250-test", "250 SIZE 0"], false);
        assert_eq!(probe(&with(account(port), "t3", "ssl")), None, "SIZE 0 inside TLS: no limit declared");
    }

    #[test]
    fn the_limit_is_read_through_starttls() {
        // named before the upgrade: no STARTTLS needed
        let (port, _) = serve_kind(Kind::StartTls, &["250-test", "250-STARTTLS", "250 SIZE 7340032"], &["250-test", "250 SIZE 1"], false);
        assert_eq!(probe(&with(account(port), "s1", "starttls")), Some(7_340_032));
        // named only inside the secure session (some servers hide it until then)
        let (port, _) = serve_kind(Kind::StartTls, &["250-test", "250 STARTTLS"], &["250-test", "250-SIZE 5000000", "250 8BITMIME"], false);
        assert_eq!(probe(&with(account(port), "s2", "starttls")), Some(5_000_000));
        // never named
        let (port, _) = serve_kind(Kind::StartTls, &["250-test", "250 STARTTLS"], &["250-test", "250 8BITMIME"], false);
        assert_eq!(probe(&with(account(port), "s3", "starttls")), None);
        // STARTTLS offered but refused: unknown, not a hang
        let (port, _) = serve_kind(Kind::StartTls, &["250-test", "250 STARTTLS"], &["250 SIZE 99"], true);
        assert_eq!(probe(&with(account(port), "s4", "starttls")), None);
        // no STARTTLS and no SIZE on a starttls account: unknown
        let (port, _) = serve_kind(Kind::StartTls, &["250-test", "250 8BITMIME"], &["250 SIZE 99"], false);
        assert_eq!(probe(&with(account(port), "s5", "starttls")), None);
    }

    #[test]
    fn the_answer_is_remembered_per_account_and_can_be_asked_again() {
        let (port, seen) = serve_kind(Kind::Implicit, &[], &["250-test", "250 SIZE 5000000"], false);
        let acc = with(account(port), "c1", "ssl");
        assert_eq!(limit_cached(&acc, false), Some(5_000_000));
        assert_eq!(limit_cached(&acc, false), Some(5_000_000));
        assert_eq!(seen.load(Ordering::SeqCst), 1, "the second question is answered from the cache");
        assert_eq!(limit_cached(&acc, true), Some(5_000_000));
        assert_eq!(seen.load(Ordering::SeqCst), 2, "refresh asks the server again");
        // another account on the same server is asked for itself
        assert_eq!(limit_cached(&with(account(port), "c2", "ssl"), false), Some(5_000_000));
        assert_eq!(seen.load(Ordering::SeqCst), 3);
        // changed server settings are a new question; a removed account is forgotten
        let mut moved = acc.clone();
        moved.smtp_security = "starttls".into();
        assert_ne!(cache_key(&moved), cache_key(&acc));
        forget("c1");
        assert_eq!(limit_cached(&acc, false), Some(5_000_000));
        assert_eq!(seen.load(Ordering::SeqCst), 4, "after forget the server is asked again");
        forget("c2");
    }

    #[test]
    fn a_limit_the_server_names_later_is_seen_after_a_refresh() {
        // the first answer names no limit; the limit that the server then gets is found with refresh (and not with the cache)
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            let n = Arc::new(AtomicUsize::new(0));
            std::thread::spawn(move || {
                for s in l.incoming().flatten() {
                    let size = if n.fetch_add(1, Ordering::SeqCst) == 0 { "250 8BITMIME" } else { "250 SIZE 5000000" };
                    std::thread::spawn(move || {
                        let mut r = BufReader::new(s);
                        r.get_mut().write_all(b"220 test ESMTP\r\n").unwrap();
                        talk(&mut r, &["250-test", size], false, false);
                    });
                }
            });
            port
        };
        let acc = with(account(port), "c3", "none");
        assert_eq!(limit_cached(&acc, false), None);
        assert_eq!(limit_cached(&acc, false), None, "a failed or empty answer is remembered (for a minute)");
        assert_eq!(limit_cached(&acc, true), Some(5_000_000));
        assert_eq!(limit_cached(&acc, false), Some(5_000_000));
        forget("c3");
    }

    /// The composer's estimate (src/sendSize.ts) rests on one fact: lettre writes an attachment as base64 in lines of 76 characters + CRLF.
    #[test]
    fn an_attachment_is_base64_in_lines_of_76_on_the_wire() {
        use base64::Engine;
        let raw = 3 * 1024 * 1024 + 1;
        let d: crate::smtp::Draft = serde_json::from_value(serde_json::json!({
            "accountId": "a1", "to": ["ann@example.com"], "subject": "s", "html": "<p>x</p>", "text": "x",
            "attachments": [{ "filename": "big.bin", "mime": "application/octet-stream", "dataBase64": base64::engine::general_purpose::STANDARD.encode(vec![7u8; raw]) }]
        }))
        .unwrap();
        let acc = Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "i".into(), imap_port: 993, imap_ssl: true, smtp_host: "s".into(),
            smtp_port: 465, smtp_security: "ssl".into(), username: "me".into(), auth: "password".into(), color: None, smtp_username: String::new(), tls_insecure: false,
        };
        let wire = crate::smtp::build(&acc, &d).unwrap().formatted().len();
        let chars = raw.div_ceil(3) * 4;
        let estimate = chars + 2 * chars.div_ceil(76);
        assert!(wire >= estimate && wire - estimate < 1500, "wire {wire} vs base64 estimate {estimate}");
    }
}
