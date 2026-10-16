//! The largest message the SMTP server of an account takes: the SIZE extension of EHLO (RFC 1870), e.g. `250-SIZE 35882577`.
//! Compose uses it instead of the usual 25 MB when it checks the size of what is about to be sent (QA round 17, G-07 / CF-21). It is
//! asked only when a message is big enough for the limit to matter, answered from a cache for a while, and every failure (no
//! connection, no SIZE, `SIZE 0` = no declared limit) is just "unknown": the usual limit then applies.

use crate::db::{Account, R};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const EHLO_NAME: &str = "hey-look.local";
const TIMEOUT: Duration = Duration::from_secs(8);
const KEEP: Duration = Duration::from_secs(15 * 60);

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

/// `probe`, remembered per server for a while (a failure is remembered too, so a server that does not answer is not asked on every Send).
pub fn limit_cached(acc: &Account) -> Option<u64> {
    let key = format!("{}:{}:{}", acc.smtp_host, acc.smtp_port, acc.smtp_security);
    if let Some((at, v)) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        if at.elapsed() < KEEP {
            return *v;
        }
    }
    let v = probe(acc);
    CACHE.lock().unwrap_or_else(|p| p.into_inner()).insert(key, (Instant::now(), v));
    v
}

/// The SIZE limit of the server of an account, in bytes; `null` when it names none or could not be asked.
#[tauri::command]
pub async fn smtp_size_limit(state: tauri::State<'_, crate::AppState>, account_id: String) -> R<Option<f64>> {
    let acc = crate::db::get_account(&crate::lock(&state.db), &account_id)?;
    Ok(crate::blocking(move || Ok(limit_cached(&acc))).await?.map(|n| n as f64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

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

    /// A tiny SMTP server on localhost that answers the greeting, EHLO and QUIT.
    fn serve(ehlo: &'static [&'static str]) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                let mut out = s.try_clone().unwrap();
                let mut r = BufReader::new(s);
                out.write_all(b"220 test ESMTP\r\n").unwrap();
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    if line.to_ascii_uppercase().starts_with("EHLO") {
                        for e in ehlo {
                            out.write_all(format!("{e}\r\n").as_bytes()).unwrap();
                        }
                    } else if line.to_ascii_uppercase().starts_with("QUIT") {
                        let _ = out.write_all(b"221 bye\r\n");
                        return;
                    }
                }
            }
        });
        port
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
            tls_insecure: false,
        }
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
