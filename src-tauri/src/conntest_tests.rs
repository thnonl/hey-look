//! Tests of conntest.rs (a child module of it, so the private stages can be called): the classifier tables of recorded texts per platform, and tiny
//! scripted servers on 127.0.0.1 for every error class that does not need a real certificate.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};

// ------------------------------------------------------------ the classifier: recorded texts per platform

#[test]
fn tls_texts_of_every_platform_are_classified() {
    let cases = [
        // Windows (SChannel)
        (CERT_UNTRUSTED, "The certificate chain was issued by an authority that is not trusted. (0x80090325)"),
        (CERT_UNTRUSTED, "A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider. (os error -2146762487)"),
        (CERT_NAME, "The target principal name is incorrect. (0x80090322)"),
        (CERT_NAME, "The certificate's CN name does not match the passed value. (os error -2146762481)"),
        (CERT_EXPIRED, "A required certificate is not within its validity period when verifying against the current system clock or the timestamp in the signed file. (os error -2146762495)"),
        (SECURE, "The token supplied to the function is invalid. (os error -2146893048)"),
        // macOS (Security.framework)
        (CERT_UNTRUSTED, "The operation couldn\u{2019}t be completed. (OSStatus error -9807.)"),
        (CERT_UNTRUSTED, "OSStatus error -67843"),
        (CERT_UNTRUSTED, "OSStatus error -9812: the root certificate is unknown"),
        (CERT_NAME, "OSStatus error -9843"),
        (CERT_EXPIRED, "OSStatus error -9814"),
        (SECURE, "OSStatus error -9806: connection closed via error"),
        // Linux (OpenSSL)
        (CERT_UNTRUSTED, "error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed: self-signed certificate (18)"),
        (CERT_UNTRUSTED, "certificate verify failed: unable to get local issuer certificate (20)"),
        (CERT_NAME, "certificate verify failed: Hostname mismatch, certificate is not valid for 'imap.example.com'. (64)"),
        (CERT_EXPIRED, "certificate verify failed: certificate has expired (10)"),
        (SECURE, "error:0A00010B:SSL routines::wrong version number"),
        (SECURE, "unexpected EOF"),
        (SECURE, "connection reset by peer"),
    ];
    for (kind, text) in cases {
        assert_eq!(classify_tls(text), kind, "{text}");
    }
}

#[test]
fn server_refusals_are_classified() {
    let cases = [
        (AUTH, "imap", "imap.example.com", "No Response: [AUTHENTICATIONFAILED] Invalid credentials (Failure)"),
        (AUTH, "imap", "imap.mail.me.com", "No Response: LOGIN failed (Failure)"),
        (AUTH, "smtp", "smtp.example.com", "permanent error (535): 5.7.8 Username and Password not accepted"),
        (APP_PASSWORD, "imap", "imap.gmail.com", "No Response: [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)"),
        (APP_PASSWORD, "smtp", "smtp.gmail.com", "permanent error (534): 5.7.9 Application-specific password required."),
        (MICROSOFT_PASSWORD, "imap", "outlook.office365.com", "No Response: LOGIN failed. (Failure)"),
        (MICROSOFT_PASSWORD, "smtp", "smtp.office365.com", "permanent error (535): 5.7.3 Authentication unsuccessful"),
        (MICROSOFT_PASSWORD, "imap", "imap.example.com", "No Response: BasicAuthBlocked"),
        (SMTP_AUTH_OFF, "smtp", "smtp.office365.com", "permanent error (535): 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant."),
        (IMAP_OFF, "imap", "imap.example.com", "No Response: [ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access."),
        (IMAP_OFF, "imap", "imap.example.com", "No Response: IMAP access is disabled for your domain"),
        (WEB_LOGIN, "imap", "imap.gmail.com", "No Response: [WEBALERT https://accounts.google.com/signin/continue] Web login required"),
        (TOO_MANY, "imap", "imap.example.com", "No Response: [UNAVAILABLE] Too many login failures"),
        (TOO_MANY, "smtp", "smtp.example.com", "transient error (454): 4.7.0 Too many login attempts, please try again later"),
        (TOO_MANY, "smtp", "smtp.example.com", "transient error (421): 4.7.0 Try again later, closing connection."),
        (NO_AUTH, "smtp", "smtp.example.com", "No compatible authentication mechanism was found"),
        (UNKNOWN, "smtp", "smtp.example.com", "response error: incomplete response"),
    ];
    for (kind, part, host, text) in cases {
        // (the IMAP LOGIN stage passes AUTH as the default for a NO that says nothing special, SMTP passes UNKNOWN)
        let default = if part == "imap" && text.starts_with("No Response") { AUTH } else { UNKNOWN };
        assert_eq!(classify_refusal(part, host, text, default), kind, "{text}");
    }
    assert_eq!(classify_refusal("imap", "imap.example.com", "no idea", AUTH), AUTH);
    assert_eq!(classify_refusal("imap", "imap.example.com", "command unknown", UNKNOWN), UNKNOWN);
}

#[test]
fn socket_errors_are_classified() {
    use std::io::{Error, ErrorKind};
    assert_eq!(classify_io(&Error::from(ErrorKind::ConnectionRefused)), REFUSED);
    assert_eq!(classify_io(&Error::from(ErrorKind::TimedOut)), TIMEOUT);
    assert_eq!(classify_io(&Error::from(ErrorKind::WouldBlock)), TIMEOUT);
    assert_eq!(classify_io(&Error::from(ErrorKind::NetworkUnreachable)), UNREACHABLE);
    assert_eq!(classify_io(&Error::from(ErrorKind::HostUnreachable)), UNREACHABLE);
    assert_eq!(classify_io(&Error::new(ErrorKind::Other, "something strange")), UNKNOWN);
    #[cfg(windows)]
    for (code, kind) in [(10061, REFUSED), (10060, TIMEOUT), (10051, UNREACHABLE), (10065, UNREACHABLE)] {
        assert_eq!(classify_io(&Error::from_raw_os_error(code)), kind, "{code}");
    }
}

#[test]
fn the_checks_of_add_account_are_classified_from_their_words() {
    let secure = crate::mail::secure_connection_error("h", 993, "x");
    let cases = [
        (DNS, "imap", "Connection error: failed to lookup address information: No such host is known. (os error 11001)"),
        (DNS, "imap", "cannot resolve nx.test"),
        (REFUSED, "imap", "No connection could be made because the target machine actively refused it. (os error 10061)"),
        (TIMEOUT, "smtp", "SMTP login failed: Connection error: connection timed out"),
        (UNREACHABLE, "smtp", "SMTP login failed: Connection error: A socket operation was attempted to an unreachable network. (os error 10051)"),
        (AUTH, "imap", "IMAP login failed: No Response: [AUTHENTICATIONFAILED] Invalid credentials (Failure)"),
        (AUTH, "smtp", "SMTP login failed: permanent error (535): 5.7.8 Username and Password not accepted"),
        (SECURE, "imap", secure.as_str()),
        (CERT_UNTRUSTED, "imap", "The certificate chain was issued by an authority that is not trusted. (0x80090325)"),
        (CERT_NAME, "smtp", "invalid peer certificate: certificate verify failed: Hostname mismatch"),
        (APP_PASSWORD, "imap", "IMAP login failed: No Response: [ALERT] Application-specific password required"),
        (UNKNOWN, "smtp", "SMTP login failed: response error: incomplete response"),
    ];
    for (kind, part, text) in cases {
        assert_eq!(classify_text(part, "mail.example.com", text), kind, "{text}");
    }
}

#[test]
fn the_catalogue_has_21_kinds_and_each_has_a_sentence() {
    assert_eq!(KINDS.len(), 21);
    let mut seen = std::collections::BTreeSet::new();
    for k in KINDS {
        assert!(seen.insert(k), "{k} twice");
        assert!(!english("imap", k).ends_with(": "), "{k}");
    }
}

// ------------------------------------------------------------ text helpers

#[test]
fn scrub_removes_the_password_and_its_base64_forms() {
    use base64::Engine;
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
    let pw = "Pw-Test-4711";
    assert_eq!(b64(pw), "UHctVGVzdC00NzEx");
    let echoed = format!("LOGIN \"qa\" \"{pw}\" / AUTH PLAIN {} / {} / {}", b64(&format!("\0qa\0{pw}")), b64(pw), b64(&format!("qa\0{pw}")));
    let clean = scrub(&echoed, &["qa"], &[pw]);
    assert!(!clean.contains(pw) && !clean.contains(&b64(pw)) && !clean.contains(&b64(&format!("\0qa\0{pw}"))) && !clean.contains(&b64(&format!("qa\0{pw}"))), "{clean}");
    assert_eq!(clean.matches("••••").count(), 4, "{clean}");
    // nothing to hide: the text is as it was; an empty or tiny secret does not wreck it
    assert_eq!(scrub("hello world", &["qa"], &["", "ab"]), "hello world");
}

#[test]
fn detail_is_cut_and_shows_bytes_that_are_not_text() {
    let raw = format!("{}\u{1}\u{0}\u{7f}", "a".repeat(2500));
    let t = tidy(&raw);
    assert!(t.chars().count() <= DETAIL_MAX + 1 && t.ends_with('…'), "{}", t.len());
    assert_eq!(tidy("ok\u{1}\u{0}\r\nnext\ttab"), "ok\\x01\\x00\\x0d\nnext\ttab");
}

#[test]
fn names_are_read_from_the_subject_alternative_name_extension() {
    let name = |s: &str| {
        let mut v = vec![0x82, s.len() as u8];
        v.extend_from_slice(s.as_bytes());
        v
    };
    let mut names = name("imap.example.com");
    names.extend(name("mail.example.com"));
    names.extend([0x87, 4, 127, 0, 0, 1]); // an IP address entry is not a name
    let mut seq = vec![0x30, names.len() as u8];
    seq.extend(names);
    let mut ext = vec![0x30, 0x00, 0x06, 0x03, 0x55, 0x1d, 0x11, 0x04, seq.len() as u8];
    ext.extend(seq);
    let mut der = vec![0xAA; 20];
    der.extend(ext);
    der.extend([0xBB; 10]);
    assert_eq!(dns_names_from_der(&der), vec!["imap.example.com", "mail.example.com"]);
    // no extension at all, a cut certificate
    assert!(dns_names_from_der(&[0x30, 0x03, 1, 2, 3]).is_empty());
    assert!(dns_names_from_der(&der[..der.len() - 40]).len() <= 2);
    assert!(dns_names_from_der(&[0x55, 0x1d, 0x11]).is_empty());
}

// ------------------------------------------------------------ scripted servers on 127.0.0.1

fn serve(handler: impl Fn(TcpStream) + Send + Sync + 'static) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let handler = Arc::new(handler);
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let h = handler.clone();
            std::thread::spawn(move || h(c));
        }
    });
    port
}

/// accepts and never writes (a black hole as far as a client can tell)
fn silent() -> u16 {
    serve(|c| {
        std::thread::sleep(Duration::from_secs(30));
        drop(c);
    })
}

fn account(imap_port: u16, imap_ssl: bool, smtp_port: u16, smtp_security: &str) -> Account {
    let mut a = crate::smtp::tests::account();
    a.imap_host = "127.0.0.1".into();
    a.imap_port = imap_port;
    a.imap_ssl = imap_ssl;
    a.smtp_host = "127.0.0.1".into();
    a.smtp_port = smtp_port;
    a.smtp_security = smtp_security.into();
    a.username = "qa".into();
    a.tls_insecure = true;
    a
}

fn go(a: &Account, which: Which, secs: u64) -> ConnTestReport {
    run(a, "secret", "secret", which, Duration::from_secs(secs), &|| false)
}

fn imap(r: &ConnTestReport) -> &PartReport {
    r.imap.as_ref().unwrap()
}

fn smtp(r: &ConnTestReport) -> &PartReport {
    r.smtp.as_ref().unwrap()
}

fn greeting_server(text: &'static str) -> u16 {
    serve(move |mut c| {
        let _ = c.write_all(text.as_bytes());
        std::thread::sleep(Duration::from_millis(300));
    })
}

/// An SMTP server over a plain connection that logs every line it gets: `auth_reply` answers AUTH, `auth_offered` says whether EHLO lists it.
fn smtp_server(auth_offered: bool, auth_reply: &'static str, log: Arc<Mutex<Vec<String>>>) -> u16 {
    serve(move |c| {
        let mut w = c.try_clone().unwrap();
        let _ = w.write_all(b"220 test ESMTP\r\n");
        let mut r = BufReader::new(c);
        let mut line = String::new();
        loop {
            line.clear();
            if r.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let l = line.trim_end().to_string();
            log.lock().unwrap().push(l.clone());
            let up = l.to_uppercase();
            let out: String = if up.starts_with("EHLO") {
                if auth_offered { "250-test\r\n250 AUTH PLAIN LOGIN\r\n".into() } else { "250 test\r\n".into() }
            } else if up.starts_with("AUTH PLAIN") {
                format!("{auth_reply}\r\n")
            } else if up.starts_with("AUTH LOGIN") {
                let _ = w.write_all(b"334 VXNlcm5hbWU6\r\n");
                let (mut a, mut b) = (String::new(), String::new());
                let _ = r.read_line(&mut a);
                let _ = w.write_all(b"334 UGFzc3dvcmQ6\r\n");
                let _ = r.read_line(&mut b);
                format!("{auth_reply}\r\n")
            } else if up.starts_with("NOOP") {
                "250 ok\r\n".into()
            } else if up.starts_with("QUIT") {
                let _ = w.write_all(b"221 bye\r\n");
                return;
            } else {
                "500 what\r\n".into()
            };
            if w.write_all(out.as_bytes()).is_err() {
                return;
            }
        }
    })
}

#[test]
fn a_closed_port_is_refused_on_both_sides() {
    crate::test_guard::within(60, || {
        let p = crate::testutil::dead_addr().port();
        let r = go(&account(p, true, p, "ssl"), Which::Both, 10);
        assert_eq!((imap(&r).kind.as_str(), smtp(&r).kind.as_str()), (REFUSED, REFUSED), "{r:?}");
        assert_eq!((imap(&r).status.as_str(), imap(&r).port), ("error", p));
    });
}

#[test]
fn a_name_that_does_not_exist_is_a_dns_failure() {
    crate::test_guard::within(60, || {
        let mut a = account(993, true, 465, "ssl");
        a.imap_host = "nothing.invalid".into();
        let r = go(&a, Which::Imap, 15);
        assert_eq!(imap(&r).kind, DNS, "{r:?}");
        assert!(r.smtp.is_none());
    });
}

#[test]
fn a_server_that_says_nothing_is_secure_or_timeout_within_the_limit() {
    crate::test_guard::within(90, || {
        let port = silent();
        let limit = 2u64;
        // SSL/TLS waits for a server hello, STARTTLS for a greeting: the port is not what the form says
        for (ssl, what) in [(true, "ssl"), (false, "starttls")] {
            let t = Instant::now();
            let r = go(&account(port, ssl, port, what), Which::Both, limit);
            assert_eq!(imap(&r).kind, SECURE, "imap {what}: {r:?}");
            assert_eq!(smtp(&r).kind, SECURE, "smtp {what}: {r:?}");
            assert!(t.elapsed() < Duration::from_secs(limit + 3), "{what}: {:?}", t.elapsed());
        }
        // SMTP without security: nothing to secure, the greeting never comes: a plain timeout
        let t = Instant::now();
        let r = go(&account(port, true, port, "none"), Which::Smtp, limit);
        assert_eq!(smtp(&r).kind, TIMEOUT, "{r:?}");
        assert!(t.elapsed() < Duration::from_secs(limit + 3), "{:?}", t.elapsed());
    });
}

#[test]
fn a_plain_port_with_ssl_is_a_secure_connection_problem() {
    crate::test_guard::within(60, || {
        let imap_port = greeting_server("* OK plain IMAP ready\r\n");
        let smtp_port = greeting_server("220 plain SMTP ready\r\n");
        let r = go(&account(imap_port, true, smtp_port, "ssl"), Which::Both, 10);
        assert_eq!(imap(&r).kind, SECURE, "{r:?}");
        assert_eq!(smtp(&r).kind, SECURE, "{r:?}");
    });
}

#[test]
fn a_port_of_the_other_protocol_is_named() {
    crate::test_guard::within(60, || {
        // IMAP asked of an SMTP server and the other way round (STARTTLS mode reads the greeting before it secures)
        let smtp_like = greeting_server("220 mail.example.com ESMTP ready\r\n");
        let imap_like = greeting_server("* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n");
        let r = go(&account(smtp_like, false, imap_like, "starttls"), Which::Both, 10);
        assert_eq!((imap(&r).kind.as_str(), imap(&r).sees.as_deref()), (NOT_IMAP, Some("smtp")), "{r:?}");
        assert_eq!((smtp(&r).kind.as_str(), smtp(&r).sees.as_deref()), (NOT_SMTP, Some("imap")), "{r:?}");
        // something that is neither
        let web = greeting_server("HTTP/1.1 400 Bad Request\r\n");
        let r = go(&account(web, false, web, "none"), Which::Both, 10);
        assert_eq!((imap(&r).kind.as_str(), imap(&r).sees.clone()), (NOT_IMAP, None), "{r:?}");
        assert_eq!((smtp(&r).kind.as_str(), smtp(&r).sees.clone()), (NOT_SMTP, None), "{r:?}");
    });
}

#[test]
fn a_server_that_hangs_up_or_says_bye_is_busy() {
    crate::test_guard::within(60, || {
        let bye = greeting_server("* BYE too busy right now\r\n");
        let busy_smtp = greeting_server("421 4.3.2 Service not available\r\n");
        let r = go(&account(bye, false, busy_smtp, "starttls"), Which::Both, 10);
        assert_eq!(imap(&r).kind, BUSY, "{r:?}");
        assert_eq!(smtp(&r).kind, BUSY, "{r:?}");
        let closed = serve(drop);
        let r = go(&account(closed, false, closed, "none"), Which::Both, 10);
        assert_eq!(imap(&r).kind, BUSY, "{r:?}");
        assert_eq!(smtp(&r).kind, BUSY, "{r:?}");
    });
}

#[test]
fn starttls_that_is_not_offered_or_refused_is_a_secure_connection_problem() {
    crate::test_guard::within(60, || {
        // SMTP: EHLO does not list STARTTLS
        let log = Arc::new(Mutex::new(vec![]));
        let no_starttls = smtp_server(true, "235 ok", log);
        // IMAP: STARTTLS answered with BAD
        let imap_no = serve(|mut c| {
            let _ = c.write_all(b"* OK ready\r\n");
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut l = String::new();
            while r.read_line(&mut l).unwrap_or(0) > 0 {
                let tag = l.split_whitespace().next().unwrap_or("x").to_string();
                let _ = c.write_all(format!("{tag} BAD command not understood\r\n").as_bytes());
                l.clear();
            }
        });
        let r = go(&account(imap_no, false, no_starttls, "starttls"), Which::Both, 10);
        assert_eq!(imap(&r).kind, SECURE, "{r:?}");
        assert_eq!(smtp(&r).kind, SECURE, "{r:?}");
        assert!(smtp(&r).detail.contains("STARTTLS"), "{r:?}");
    });
}

#[test]
fn the_smtp_login_is_classified_and_nothing_is_sent() {
    crate::test_guard::within(120, || {
        let cases = [
            ("535 5.7.8 Username and Password not accepted", AUTH),
            ("534 5.7.9 Application-specific password required", APP_PASSWORD),
            ("535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant", SMTP_AUTH_OFF),
            ("454 4.7.0 Too many login attempts, please try again later", TOO_MANY),
            ("235 2.7.0 Accepted", "ok"),
        ];
        for (reply, kind) in cases {
            let log = Arc::new(Mutex::new(vec![]));
            let port = smtp_server(true, reply, log.clone());
            let r = go(&account(1, true, port, "none"), Which::Smtp, 10);
            assert_eq!(smtp(&r).kind, kind, "{reply}: {r:?}");
            assert_eq!(smtp(&r).status, if kind == "ok" { "ok" } else { "error" });
            let log = log.lock().unwrap().join("\n").to_uppercase();
            assert!(!log.contains("MAIL FROM") && !log.contains("RCPT") && !log.contains("DATA"), "{reply}: a message was started:\n{log}");
            assert!(log.contains("EHLO") && log.contains("QUIT"), "{log}");
        }
        // no AUTH offered at all
        let log = Arc::new(Mutex::new(vec![]));
        let port = smtp_server(false, "235 ok", log);
        let r = go(&account(1, true, port, "none"), Which::Smtp, 10);
        assert_eq!(smtp(&r).kind, NO_AUTH, "{r:?}");
    });
}

#[test]
fn the_password_is_not_in_the_details() {
    crate::test_guard::within(60, || {
        // a server that repeats what it was sent in its refusal (it should not; the report must not repeat it either)
        let pw = "Pw-Test-4711";
        let port = serve(move |c| {
            let mut w = c.try_clone().unwrap();
            let _ = w.write_all(b"220 test\r\n");
            let mut r = BufReader::new(c);
            let mut l = String::new();
            while r.read_line(&mut l).unwrap_or(0) > 0 {
                let up = l.to_uppercase();
                let out = if up.starts_with("EHLO") {
                    "250-test\r\n250 AUTH PLAIN\r\n".to_string()
                } else if up.starts_with("AUTH PLAIN") {
                    format!("535 5.7.8 rejected {} / {}\r\n", l.trim_end(), pw)
                } else if up.starts_with("QUIT") {
                    return;
                } else {
                    "250 ok\r\n".into()
                };
                let _ = w.write_all(out.as_bytes());
                l.clear();
            }
        });
        let r = run(&account(1, true, port, "none"), pw, pw, Which::Smtp, Duration::from_secs(10), &|| false);
        let d = &smtp(&r).detail;
        assert_eq!(smtp(&r).kind, AUTH, "{r:?}");
        assert!(d.contains("••••") && !d.contains(pw) && !d.contains("UHctVGVzdC00NzEx"), "{d}");
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains(pw), "{json}");
    });
}

#[test]
fn an_imap_login_lists_the_folders_and_says_nothing_else() {
    crate::test_guard::within(60, || {
        let fake = crate::fakeimap::Fake::start(&[("Archive", &[1, 2]), ("Sent", &[])]);
        let mut a = account(fake.addr.port(), false, 1, "none");
        a.imap_host = fake.addr.ip().to_string();
        // the stages after the connection is secured, on a plain stream (the TLS part is the library's)
        let sock = TcpStream::connect(fake.addr).unwrap();
        let ctl = sock.try_clone().unwrap();
        let mut client = imap::Client::new(sock);
        let clock = Clock::new(Duration::from_secs(10));
        greet_imap(&mut client, &ctl, clock, false).ok().unwrap();
        let done = imap_session(client, &ctl, &a, "secret", clock).ok().unwrap();
        assert_eq!((done.folders, done.warn), (Some(3), None), "INBOX, Archive, Sent");
        let log = fake.commands().join("\n").to_uppercase();
        for banned in ["SELECT", "EXAMINE", "FETCH", "STORE", "APPEND", "SEARCH", "EXPUNGE", "CREATE", "DELETE", "COPY", "MOVE"] {
            assert!(!log.contains(banned), "{banned} was sent:\n{log}");
        }
        assert!(log.contains("LOGIN") && log.contains("LIST"), "{log}");
    });
}

fn imap_script(login_reply: &'static str, list_reply: &'static str) -> u16 {
    serve(move |mut c| {
        let _ = c.write_all(b"* OK scripted ready\r\n");
        let mut r = BufReader::new(c.try_clone().unwrap());
        let mut l = String::new();
        while r.read_line(&mut l).unwrap_or(0) > 0 {
            let mut w = l.split_whitespace();
            let (tag, cmd) = (w.next().unwrap_or("x").to_string(), w.next().unwrap_or("").to_uppercase());
            let out = match cmd.as_str() {
                "LOGIN" => format!("{tag} {login_reply}\r\n"),
                "CAPABILITY" => format!("* CAPABILITY IMAP4rev1\r\n{tag} OK done\r\n"),
                "LIST" => format!("{list_reply}\r\n").replace("TAG", &tag),
                "LOGOUT" => format!("* BYE bye\r\n{tag} OK logout\r\n"),
                _ => format!("{tag} BAD what\r\n"),
            };
            let _ = c.write_all(out.as_bytes());
            l.clear();
        }
    })
}

fn session_result(port: u16, host: &str) -> Result<ImapDone, Fail> {
    let mut a = account(port, false, 1, "none");
    a.imap_host = host.into();
    let sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let ctl = sock.try_clone().unwrap();
    let mut client = imap::Client::new(sock);
    let clock = Clock::new(Duration::from_secs(10));
    greet_imap(&mut client, &ctl, clock, false)?;
    imap_session(client, &ctl, &a, "secret", clock)
}

#[test]
fn imap_refusals_have_their_kinds_and_a_list_that_fails_is_a_warning() {
    crate::test_guard::within(60, || {
        for (reply, host, kind) in [
            ("NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)", "imap.example.com", AUTH),
            ("NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)", "imap.gmail.com", APP_PASSWORD),
            ("NO LOGIN failed.", "outlook.office365.com", MICROSOFT_PASSWORD),
            ("NO [ALERT] Your account is not enabled for IMAP use.", "imap.example.com", IMAP_OFF),
            ("NO [WEBALERT https://accounts.google.com/signin] Web login required", "imap.gmail.com", WEB_LOGIN),
            ("NO [UNAVAILABLE] Too many login failures", "imap.example.com", TOO_MANY),
        ] {
            let port = imap_script(reply, "TAG OK LIST done");
            let e = session_result(port, host).err().unwrap_or_else(|| panic!("{reply}: signed in"));
            assert_eq!(e.kind, kind, "{reply}: {}", e.detail);
        }
        let port = imap_script("OK logged in", "TAG NO [SERVERBUG] list failed");
        let done = session_result(port, "imap.example.com").ok().unwrap();
        assert_eq!(done.folders, None);
        assert!(done.warn.as_deref().unwrap().contains("LIST"));
        let r = report_of("imap", &account(port, false, 1, "none"), Ok(ImapDone { folders: None, warn: Some("LIST: x".into()) }), Duration::ZERO, &[], &[]);
        assert_eq!((r.status.as_str(), r.kind.as_str()), ("warn", LIST_FAILED));
    });
}

#[test]
fn both_parts_run_at_the_same_time() {
    crate::test_guard::within(60, || {
        // each side answers "wrong protocol" after a delay: 2 s for IMAP, 1 s for SMTP. One after the other this would take 3 s.
        let slow_imap = serve(|mut c| {
            std::thread::sleep(Duration::from_secs(2));
            let _ = c.write_all(b"220 hello\r\n");
            std::thread::sleep(Duration::from_millis(200));
        });
        let slow_smtp = serve(|mut c| {
            std::thread::sleep(Duration::from_secs(1));
            let _ = c.write_all(b"* OK hello\r\n");
            std::thread::sleep(Duration::from_millis(200));
        });
        let t = Instant::now();
        let r = go(&account(slow_imap, false, slow_smtp, "none"), Which::Both, 10);
        let took = t.elapsed();
        assert_eq!((imap(&r).kind.as_str(), smtp(&r).kind.as_str()), (NOT_IMAP, NOT_SMTP), "{r:?}");
        assert!(took >= Duration::from_millis(1900) && took < Duration::from_millis(2800), "{took:?}");
        // each part reports its own time
        assert!(smtp(&r).ms < 1800 && imap(&r).ms >= 1900, "imap {} ms, smtp {} ms", imap(&r).ms, smtp(&r).ms);
    });
}

#[test]
fn cancel_ends_both_parts_at_once_and_a_late_answer_is_dropped() {
    crate::test_guard::within(60, || {
        let late = serve(|mut c| {
            std::thread::sleep(Duration::from_secs(3));
            let _ = c.write_all(b"* OK late\r\n");
        });
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            s.store(true, Ordering::SeqCst);
        });
        let t = Instant::now();
        let a = account(late, false, late, "none");
        let r = run(&a, "secret", "secret", Which::Both, Duration::from_secs(20), &|| stop.load(Ordering::SeqCst));
        assert!(t.elapsed() < Duration::from_millis(1200), "{:?}", t.elapsed());
        assert_eq!((imap(&r).status.as_str(), smtp(&r).status.as_str()), ("cancelled", "cancelled"), "{r:?}");
        // asked to cancel before it starts: nothing is waited for
        let t = Instant::now();
        let r = run(&a, "secret", "secret", Which::Both, Duration::from_secs(20), &|| true);
        assert!(t.elapsed() < Duration::from_millis(800), "{:?}", t.elapsed());
        assert_eq!(imap(&r).status, "cancelled");
    });
}

#[test]
fn a_part_that_outlives_its_limit_is_reported_as_timed_out() {
    crate::test_guard::within(60, || {
        // the server answers its greeting after 6 s: past a 1 s limit (plus the grace) the part is a timeout and the late greeting is not heard
        let slow = serve(|mut c| {
            std::thread::sleep(Duration::from_secs(6));
            let _ = c.write_all(b"220 late\r\n");
        });
        let t = Instant::now();
        let r = go(&account(1, true, slow, "none"), Which::Smtp, 1);
        assert_eq!(smtp(&r).kind, TIMEOUT, "{r:?}");
        assert!(t.elapsed() < Duration::from_millis(1000 + 1500 + 1500), "{:?}", t.elapsed());
    });
}

fn memory_db() -> crate::Db {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrate(&c).unwrap();
    Arc::new(Mutex::new(c))
}

fn account_rows(db: &crate::Db) -> i64 {
    crate::lock(db).query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap()
}

fn form() -> crate::AccountInput {
    crate::AccountInput {
        email: " qa@example.test ".into(),
        display_name: "QA".into(),
        imap_host: " imap.example.test ".into(),
        imap_port: 993,
        imap_ssl: true,
        smtp_host: "smtp.example.test".into(),
        smtp_port: 587,
        smtp_security: "starttls".into(),
        username: "qa".into(),
        smtp_username: String::new(),
        tls_insecure: false,
    }
}

#[test]
fn a_refused_add_carries_part_and_kind_and_stores_nothing() {
    crate::test_guard::within(60, || {
        let db = memory_db();
        let stored = std::cell::Cell::new(0);
        let store = |_: &str, _: &str, _: &dyn Fn() -> bool| -> R<()> {
            stored.set(stored.get() + 1);
            Ok(())
        };
        let ok = |_: &Account, _: &str| -> R<()> { Ok(()) };
        // an IMAP sign-in refused: part imap, kind auth, nothing stored, the SMTP side not asked
        let asked = std::cell::Cell::new(false);
        let imap_refused = |a: &Account, pw: &str| check_imap(a, pw, Err("IMAP login failed: No Response: [AUTHENTICATIONFAILED] Invalid credentials (Failure)".into()));
        let smtp_spy = |_: &Account, _: &str| -> R<()> {
            asked.set(true);
            Ok(())
        };
        let e = crate::add_account_cancellable(&db, form(), "secret", None, &imap_refused, &smtp_spy, &|| false, &store).unwrap_err();
        assert!(e.starts_with("ACCOUNT_CHECK|part=imap|kind=auth|host=imap.example.test|port=993|sec=ssl|"), "{e}");
        assert!(!asked.get() && stored.get() == 0 && account_rows(&db) == 0);
        // an SMTP port that cannot be secured, with the shared login: the add is refused as before
        let smtp_secure = |a: &Account, pw: &str| check_smtp(a, pw, Err(crate::mail::secure_connection_error("smtp.example.test", 587, "x")));
        let e = crate::add_account_cancellable(&db, form(), "secret", None, &ok, &smtp_secure, &|| false, &store).unwrap_err();
        assert!(e.starts_with("ACCOUNT_CHECK|part=smtp|kind=secure|") && is_secure_kind(&e), "{e}");
        assert_eq!(account_rows(&db), 0);
        // a refused shared SMTP sign-in does not hold the account back (unchanged), a separate one does
        let smtp_auth = |a: &Account, pw: &str| check_smtp(a, pw, Err("SMTP login failed: permanent error (535): 5.7.8 Username and Password not accepted".into()));
        let a = crate::add_account_cancellable(&db, form(), "secret", None, &ok, &smtp_auth, &|| false, &store).unwrap();
        assert_eq!((a.email.as_str(), a.imap_host.as_str(), stored.get()), ("qa@example.test", "imap.example.test", 1), "the form's spaces are trimmed");
        let e = crate::add_account_cancellable(&db, form(), "secret", Some("other".into()), &ok, &smtp_auth, &|| false, &store).unwrap_err();
        assert!(e.starts_with("ACCOUNT_CHECK|part=smtp|kind=auth|"), "{e}");
        assert_eq!(account_rows(&db), 1);
        // the password is not in a coded error
        let e = check_imap(&a, "Pw-Test-4711", Err("IMAP login failed: rejected Pw-Test-4711".into())).unwrap_err();
        assert!(!e.contains("Pw-Test-4711") && e.contains("••••"), "{e}");
    });
}

// ------------------------------------------------------------ opt-in: a real server with real TLS (GreenMail, self-signed certificate)

/// `HL_CT_IT=1`: the rows of the QA kit (E:\hey-mail\test-builds\v1010-testconn\README.md) that need a server that speaks TLS. Start GreenMail first:
///   docker run --rm -d --name hl-ct-gm -p 127.0.0.1:13025:3025 -p 127.0.0.1:13143:3143 -p 127.0.0.1:13465:3465 -p 127.0.0.1:13993:3993 \
///     -e "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=u1:pw1@example.test" greenmail/standalone:2.1.0
/// then `HL_CT_IT=1 cargo test --lib conntest_it -- --nocapture`. Skipped (passes) without the variable, so `cargo test` and CI are unchanged.
#[test]
fn conntest_it_greenmail() {
    if std::env::var("HL_CT_IT").is_err() {
        return;
    }
    let run_with = |a: &Account, pw: &str| run(a, pw, pw, Which::Both, Duration::from_secs(20), &|| false);
    let mut a = account(13993, true, 13465, "ssl");
    a.username = "u1".into();
    a.email = "u1@example.test".into();
    // K1: both work, the folders are counted
    let r = run_with(&a, "pw1");
    println!("K1 {r:?}");
    assert_eq!((imap(&r).status.as_str(), smtp(&r).status.as_str()), ("ok", "ok"), "{r:?}");
    assert!(imap(&r).folders.unwrap_or(0) >= 1);
    // K6: the same with the certificate checked: self-signed
    let mut strict = a.clone();
    strict.tls_insecure = false;
    let r = run_with(&strict, "pw1");
    println!("K6 {r:?}");
    assert_eq!((imap(&r).kind.as_str(), smtp(&r).kind.as_str()), (CERT_UNTRUSTED, CERT_UNTRUSTED), "{r:?}");
    // K8: a wrong password
    let r = run_with(&a, "not-the-password");
    println!("K8 {r:?}");
    assert_eq!((imap(&r).kind.as_str(), smtp(&r).kind.as_str()), (AUTH, AUTH), "{r:?}");
    assert!(!serde_json::to_string(&r).unwrap().contains("not-the-password"));
    // K3: nothing listens
    let dead = crate::testutil::dead_addr().port();
    let r = run_with(&account(dead, true, dead, "ssl"), "pw1");
    assert_eq!((imap(&r).kind.as_str(), smtp(&r).kind.as_str()), (REFUSED, REFUSED), "{r:?}");
    // K4: plain ports used with SSL/TLS
    let mut b = account(13143, true, 13025, "ssl");
    b.username = "u1".into();
    let r = run_with(&b, "pw1");
    println!("K4 {r:?}");
    assert_eq!((imap(&r).kind.as_str(), smtp(&r).kind.as_str()), (SECURE, SECURE), "{r:?}");
    // STARTTLS asked of GreenMail: it does not offer it
    let mut c = account(13143, false, 13025, "starttls");
    c.username = "u1".into();
    let r = run_with(&c, "pw1");
    println!("STARTTLS {r:?}");
    assert_eq!((imap(&r).kind.as_str(), smtp(&r).kind.as_str()), (SECURE, SECURE), "{r:?}");
    // K9, K10: the ports of the other protocol
    let mut d = account(13465, true, 13993, "ssl");
    d.username = "u1".into();
    let r = run_with(&d, "pw1");
    println!("K9/K10 {r:?}");
    assert_eq!((imap(&r).kind.as_str(), imap(&r).sees.as_deref()), (NOT_IMAP, Some("smtp")), "{r:?}");
    assert_eq!((smtp(&r).kind.as_str(), smtp(&r).sees.as_deref()), (NOT_SMTP, Some("imap")), "{r:?}");
}

/// `HL_CT_NET=1`: the rows of the QA kit that need the internet (certificates of other people's servers, K7, K11 to K14). No account is signed in to except a made-up
/// address at Microsoft (K14, which refuses it at once). Skipped (passes) without the variable.
#[test]
fn conntest_it_internet() {
    if std::env::var("HL_CT_NET").is_err() {
        return;
    }
    use std::net::ToSocketAddrs;
    let go = |host: &str, port: u16, ssl: bool, insecure: bool, secs: u64| {
        let mut a = account(port, ssl, 1, "ssl");
        a.imap_host = host.into();
        a.tls_insecure = insecure;
        a.username = "nobody@example.invalid".into();
        let r = run(&a, "not-a-password", "not-a-password", Which::Imap, Duration::from_secs(secs), &|| false);
        println!("{host}:{port} {r:?}");
        r.imap.unwrap()
    };
    // K11, K12: the badssl.com certificates (the TLS handshake fails before anything is said)
    assert_eq!(go("expired.badssl.com", 443, true, false, 20).kind, CERT_EXPIRED);
    assert_eq!(go("self-signed.badssl.com", 443, true, false, 20).kind, CERT_UNTRUSTED);
    let w = go("wrong.host.badssl.com", 443, true, false, 20);
    assert_eq!(w.kind, CERT_NAME);
    assert!(w.cert_names.iter().any(|n| n.contains("badssl.com")), "the names of the certificate: {:?}", w.cert_names);
    // K7 (the address of imap.gmail.com used by number) is not a certName row: Google serves a certificate for "invalid2.invalid" to a client that sends no name, which no system trusts; wrong.host.badssl.com above is the row for a trusted certificate of another name
    // K13: Gmail on the SSL/TLS port with STARTTLS: it waits for the client, the part ends as a secure connection problem
    assert_eq!(go("imap.gmail.com", 993, false, false, 6).kind, SECURE);
    // K14: Outlook with any password: Microsoft does not take a password
    let m = go("outlook.office365.com", 993, true, false, 20);
    assert!(matches!(m.kind.as_str(), MICROSOFT_PASSWORD | AUTH), "{m:?}");
}
