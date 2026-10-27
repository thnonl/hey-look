//! "Test connection" of the manual account form (1.0.10), and the words of a failed "Add account".
//!
//! The incoming (IMAP) and the outgoing (SMTP) server are checked at the same time, each on a thread of its own under one wall-clock
//! limit (20 s), and nothing is stored: no keyring entry, no database row. What is sent: IMAP connect, (STARTTLS), greeting, CAPABILITY,
//! LOGIN, LIST, LOGOUT; SMTP connect, EHLO, (STARTTLS), AUTH, NOOP, QUIT. No SELECT, no FETCH, no MAIL FROM.
//!
//! Every failure ends in one `kind` (the catalogue `KINDS`); the UI draws the sentence, the hint, the field to fix and the one-click fixes
//! from the kind alone (src/connHints.ts), so a test and a refused "Add account" show the same words. The technical text (`detail`) is cut at 2,000
//! characters, shown as `\xNN` for bytes that are not text, and scrubbed of the passwords (and of their base64) before it leaves this file.
use crate::db::{Account, R};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// How long one part (IMAP or SMTP) may take, wall clock. The same limit as `ADD_ACCOUNT_PROBE_TIMEOUT` and `smtp::TEST_TIMEOUT`.
pub const PART_TIMEOUT: Duration = Duration::from_secs(20);
/// A part that is still running this long after its limit is declared timed out by the caller (its own socket timeouts fire at the limit).
const GRACE: Duration = Duration::from_millis(1500);
const DETAIL_MAX: usize = 2000;

pub const DNS: &str = "dns";
pub const REFUSED: &str = "refused";
pub const UNREACHABLE: &str = "unreachable";
pub const TIMEOUT: &str = "timeout";
pub const SECURE: &str = "secure";
pub const CERT_UNTRUSTED: &str = "certUntrusted";
pub const CERT_NAME: &str = "certName";
pub const CERT_EXPIRED: &str = "certExpired";
pub const NOT_IMAP: &str = "notImap";
pub const NOT_SMTP: &str = "notSmtp";
pub const BUSY: &str = "busy";
pub const AUTH: &str = "auth";
pub const APP_PASSWORD: &str = "appPassword";
pub const MICROSOFT_PASSWORD: &str = "microsoftPassword";
pub const SMTP_AUTH_OFF: &str = "smtpAuthOff";
pub const IMAP_OFF: &str = "imapOff";
pub const WEB_LOGIN: &str = "webLogin";
pub const TOO_MANY: &str = "tooMany";
pub const NO_AUTH: &str = "noAuth";
pub const LIST_FAILED: &str = "listFailed";
pub const UNKNOWN: &str = "unknown";

/// The 21 kinds of a failed part (a part that works has the kind "ok").
#[cfg(test)]
pub const KINDS: [&str; 21] = [
    DNS, REFUSED, UNREACHABLE, TIMEOUT, SECURE, CERT_UNTRUSTED, CERT_NAME, CERT_EXPIRED, NOT_IMAP, NOT_SMTP, BUSY, AUTH, APP_PASSWORD, MICROSOFT_PASSWORD,
    SMTP_AUTH_OFF, IMAP_OFF, WEB_LOGIN, TOO_MANY, NO_AUTH, LIST_FAILED, UNKNOWN,
];

/// What one part found. `status`: "ok" | "warn" | "error" | "cancelled".
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartReport {
    pub status: String,
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub security: String,
    /// IMAP: the folders LIST shows (without `\Noselect`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folders: Option<u32>,
    /// names in the certificate the server showed (a certificate failure on an SSL/TLS port), at most 5
    pub cert_names: Vec<String>,
    /// the protocol the port answered like, when it is the other one ("smtp" on the IMAP port, "imap" on the SMTP port)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sees: Option<String>,
    /// technical text, scrubbed of the passwords, at most 2,000 characters
    pub detail: String,
    pub ms: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ConnTestReport {
    pub imap: Option<PartReport>,
    pub smtp: Option<PartReport>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Which {
    Both,
    Imap,
    Smtp,
}

impl Which {
    pub fn parse(s: Option<&str>) -> Which {
        match s {
            Some("imap") => Which::Imap,
            Some("smtp") => Which::Smtp,
            _ => Which::Both,
        }
    }
}

// ---------------------------------------------------------------- the clock, the sockets, the failure

#[derive(Clone, Copy)]
struct Clock {
    end: Instant,
}

impl Clock {
    fn new(total: Duration) -> Clock {
        Clock { end: Instant::now() + total }
    }
    fn left(&self) -> Duration {
        self.end.saturating_duration_since(Instant::now()).max(Duration::from_millis(1))
    }
    fn expired(&self) -> bool {
        Instant::now() >= self.end
    }
}

/// The sockets of a running part: closing them ends what the part's thread waits for (as far as the platform lets a blocked read be woken).
#[derive(Clone, Default)]
struct Abort(Arc<Mutex<(bool, Vec<TcpStream>)>>);

impl Abort {
    fn register(&self, s: &TcpStream) {
        if let Ok(c) = s.try_clone() {
            let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if g.0 {
                let _ = c.shutdown(std::net::Shutdown::Both);
            }
            g.1.push(c);
        }
    }
    fn kill(&self) {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.0 = true;
        for s in g.1.drain(..) {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }
}

struct Fail {
    kind: &'static str,
    detail: String,
    sees: Option<&'static str>,
    names: Vec<String>,
}

impl Fail {
    fn new(kind: &'static str, detail: impl Into<String>) -> Fail {
        Fail { kind, detail: detail.into(), sees: None, names: vec![] }
    }
    fn sees(mut self, what: &'static str) -> Fail {
        self.sees = Some(what);
        self
    }
}

fn refresh(sock: &TcpStream, clock: Clock) {
    let d = clock.left();
    let _ = sock.set_read_timeout(Some(d));
    let _ = sock.set_write_timeout(Some(d));
}

fn timed_out(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

/// The text of an error with the texts of its causes, each once.
fn chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        let t = c.to_string();
        if !s.contains(&t) {
            s.push_str(": ");
            s.push_str(&t);
        }
        cur = c.source();
    }
    s
}

fn io_in_chain<'a>(e: &'a (dyn std::error::Error + 'static)) -> Option<&'a std::io::Error> {
    let mut cur: Option<&'a (dyn std::error::Error + 'static)> = Some(e);
    while let Some(c) = cur {
        if let Some(io) = c.downcast_ref::<std::io::Error>() {
            return Some(io);
        }
        cur = c.source();
    }
    None
}

/// The kind of a socket error: refused, timed out, unreachable (Windows codes 10061 / 10060 / 10051 / 10065 too).
fn classify_io(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::ConnectionRefused => return REFUSED,
        K::TimedOut | K::WouldBlock => return TIMEOUT,
        K::NetworkUnreachable | K::HostUnreachable | K::NetworkDown => return UNREACHABLE,
        _ => {}
    }
    match e.raw_os_error() {
        Some(10061) => return REFUSED,
        Some(10060) => return TIMEOUT,
        Some(10051 | 10065 | 10050) => return UNREACHABLE,
        _ => {}
    }
    let l = e.to_string().to_lowercase();
    if l.contains("refused") {
        REFUSED
    } else if l.contains("unreachable") || l.contains("no route") {
        UNREACHABLE
    } else if l.contains("timed out") {
        TIMEOUT
    } else {
        UNKNOWN
    }
}

/// Resolve and connect within the part's time (the limit is for the part, not per address), and register the socket for `Abort`.
fn tcp_connect(host: &str, port: u16, clock: Clock, abort: &Abort) -> Result<TcpStream, Fail> {
    let addrs: Vec<SocketAddr> = match (host, port).to_socket_addrs() {
        Ok(a) => a.collect(),
        Err(e) => return Err(Fail::new(DNS, format!("cannot resolve {host}: {e}"))),
    };
    if addrs.is_empty() {
        return Err(Fail::new(DNS, format!("cannot resolve {host}: no address")));
    }
    let mut last: Option<std::io::Error> = None;
    for addr in addrs {
        if clock.expired() {
            break;
        }
        match TcpStream::connect_timeout(&addr, clock.left()) {
            Ok(s) => {
                refresh(&s, clock);
                abort.register(&s);
                return Ok(s);
            }
            Err(e) => last = Some(e),
        }
    }
    match last {
        Some(e) => Err(Fail::new(classify_io(&e), format!("connect to {host}:{port}: {e}"))),
        None => Err(Fail::new(TIMEOUT, format!("connect to {host}:{port}: no answer within the time limit"))),
    }
}

// ---------------------------------------------------------------- the classifier

fn is_microsoft(host: &str) -> bool {
    let h = host.to_lowercase();
    ["office365.com", "outlook.com", "hotmail.com", "live.com", "office.com"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

/// The kind of a failure while the connection was being secured (the TLS stack's own words: SChannel, Security.framework, OpenSSL).
pub fn classify_tls(text: &str) -> &'static str {
    let l = text.to_lowercase();
    let has = |keys: &[&str]| keys.iter().any(|k| l.contains(k));
    if has(&["expired", "not yet valid", "validity period", "certificate has expired", "0x800b0101", "-2146762495", "-9814", "-9815", "notafter", "not valid yet"]) {
        CERT_EXPIRED
    } else if has(&[
        "target principal name is incorrect", "0x80090322", "-2146885630", "hostname mismatch", "ip address mismatch", "does not match", "name mismatch", "-9843", "0x800b010f",
        "-2146762481", "cert_e_cn_no_match", "subject alternative name", "no alternative certificate subject name",
    ]) {
        CERT_NAME
    } else if has(&[
        "self signed", "self-signed", "unable to get local issuer", "unable to get issuer", "not trusted", "untrusted", "0x80090325", "-2146885627", "cert_e_untrustedroot",
        "0x800b0109", "-2146762487", "0x800b010a", "-2146762486", "-9807", "-9812", "-9813", "-67843", "unknown ca", "unknown_ca", "certificate verify failed",
        "root certificate which is not trusted", "revoked", "authority",
    ]) || (l.contains("certificate") && has(&["invalid", "verify", "unknown", "trust", "chain"]))
    {
        CERT_UNTRUSTED
    } else {
        SECURE
    }
}

/// The kind of a server's refusal text (a NO / BAD reply, an SMTP reply line), `default` when nothing in it is specific.
pub fn classify_refusal(part: &str, host: &str, text: &str, default: &'static str) -> &'static str {
    let l = text.to_lowercase();
    let has = |keys: &[&str]| keys.iter().any(|k| l.contains(k));
    if has(&["[unavailable]", "[limit]", "too many", "421 4.7.0", "454 4.7.0", "(454)", "(421): 4.7.0", "rate limit", "temporarily blocked"]) && !has(&["too many recipients"]) {
        return TOO_MANY;
    }
    if has(&["[webalert", "web browser", "log in via your web", "log in via the web", "sign in on the web"]) {
        return WEB_LOGIN;
    }
    if has(&["not enabled for imap", "imap access is disabled", "imap is disabled", "imap access is not enabled", "imap is not enabled", "imap disabled", "imap access disabled", "imap is turned off"]) {
        return IMAP_OFF;
    }
    if has(&["smtpclientauthentication", "5.7.139"]) {
        return SMTP_AUTH_OFF;
    }
    if has(&["application-specific password", "app password", "5.7.9"]) {
        return APP_PASSWORD;
    }
    if has(&["basicauthblocked", "basic authentication is disabled", "basic auth"]) {
        return MICROSOFT_PASSWORD;
    }
    if part == "smtp" && has(&["no compatible authentication", "no authentication mechanism", "authentication is not supported", "does not support authentication", "unsupported authentication", "auth not supported", "not offered"]) {
        return NO_AUTH;
    }
    let auth_like = has(&[
        "authenticationfailed", "authorizationfailed", "login failed", "invalid credentials", "authentication failed", "authentication unsuccessful", "auth failed", "535", "(530)",
        "(534)", "bad credentials", "invalid login", "login incorrect", "username and password not accepted", "invalid username", "incorrect password", "wrong password",
        "authentication required", "not authenticated", "credentials", "[auth]",
    ]);
    let kind = if auth_like { AUTH } else { default };
    if kind == AUTH && is_microsoft(host) {
        MICROSOFT_PASSWORD
    } else {
        kind
    }
}

// ---------------------------------------------------------------- text helpers

/// `text` with every byte that is not text shown as `\xNN` (a line break stays) and cut at 2,000 characters.
fn tidy(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if out.chars().count() >= DETAIL_MAX {
            out.push('…');
            break;
        }
        if c == '\n' || c == '\t' || !c.is_control() {
            out.push(c);
        } else {
            out.push_str(&format!("\\x{:02x}", c as u32 & 0xff));
        }
    }
    out
}

/// `text` without the passwords: the literal ones (at least 3 characters, a shorter one says nothing worth protecting and would wreck the
/// text), their base64, and the base64 of `\0user\0password` (SASL PLAIN) and `user\0password`. Scrubbed text becomes `••••`.
pub fn scrub(text: &str, users: &[&str], secrets: &[&str]) -> String {
    use base64::Engine;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let mut needles: Vec<String> = vec![];
    for s in secrets.iter().filter(|s| s.chars().count() >= 3) {
        needles.push((*s).to_string());
        needles.push(b64(s.as_bytes()));
        for u in users {
            needles.push(b64(format!("\0{u}\0{s}").as_bytes()));
            needles.push(b64(format!("{u}\0{s}").as_bytes()));
        }
    }
    needles.sort_by_key(|n| std::cmp::Reverse(n.len()));
    needles.dedup();
    let mut out = text.to_string();
    for n in needles {
        out = out.replace(&n, "••••");
    }
    out
}

// ---------------------------------------------------------------- certificate names (REQ-12)

fn der_len(b: &[u8]) -> Option<(usize, usize)> {
    let first = *b.first()?;
    if first < 0x80 {
        return Some((first as usize, 1));
    }
    let n = (first & 0x7f) as usize;
    if n == 0 || n > 3 || b.len() < 1 + n {
        return None;
    }
    Some((b[1..=n].iter().fold(0usize, |a, x| (a << 8) | *x as usize), 1 + n))
}

/// The DNS names of the subject alternative name extension of a DER certificate (at most 5; none when it has no such extension).
pub fn dns_names_from_der(der: &[u8]) -> Vec<String> {
    let mut names = vec![];
    let _ = (|| -> Option<()> {
        let at = der.windows(3).position(|w| w == [0x55, 0x1d, 0x11])?;
        let mut i = at + 3;
        if der.get(i..i + 3) == Some(&[0x01, 0x01, 0xff]) {
            i += 3;
        }
        if *der.get(i)? != 0x04 {
            return None;
        }
        let (_, n) = der_len(der.get(i + 1..)?)?;
        i += 1 + n;
        if *der.get(i)? != 0x30 {
            return None;
        }
        let (seq_len, n) = der_len(der.get(i + 1..)?)?;
        i += 1 + n;
        let end = (i + seq_len).min(der.len());
        while i < end && names.len() < 5 {
            let tag = *der.get(i)?;
            let (len, n) = der_len(der.get(i + 1..)?)?;
            let body = der.get(i + 1 + n..i + 1 + n + len)?;
            if tag == 0x82 && body.iter().all(|b| (0x20..0x7f).contains(b)) {
                names.push(String::from_utf8_lossy(body).to_string());
            }
            i += 1 + n + len;
        }
        Some(())
    })();
    names
}

/// The names in the certificate of an SSL/TLS port: a second handshake that accepts any certificate, closed right after it. No command and
/// no credential is sent. Empty when it cannot be read.
fn read_cert_names(host: &str, port: u16, clock: Clock) -> Vec<String> {
    let Ok(tls) = native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true).build() else { return vec![] };
    let Ok(mut addrs) = (host, port).to_socket_addrs() else { return vec![] };
    let wait = clock.left().min(Duration::from_secs(5));
    let Some(sock) = addrs.find_map(|a| TcpStream::connect_timeout(&a, wait).ok()) else { return vec![] };
    let _ = sock.set_read_timeout(Some(wait));
    let _ = sock.set_write_timeout(Some(wait));
    let Ok(mut stream) = tls.connect(host, sock) else { return vec![] };
    let names = match stream.peer_certificate() {
        Ok(Some(c)) => c.to_der().map(|d| dns_names_from_der(&d)).unwrap_or_default(),
        _ => vec![],
    };
    let _ = stream.shutdown();
    names
}

// ---------------------------------------------------------------- IMAP

struct ImapDone {
    folders: Option<u32>,
    /// the login worked, the folder list did not
    warn: Option<String>,
}

fn connector(insecure: bool) -> Result<native_tls::TlsConnector, Fail> {
    native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(insecure)
        .danger_accept_invalid_hostnames(insecure)
        .build()
        .map_err(|e| Fail::new(UNKNOWN, format!("TLS setup: {}", chain(&e))))
}

/// A failed TLS handshake: a silent server (read timeout, the time is up) and a server that is not TLS at all are `secure`; a certificate
/// problem has its own kinds. `names`: read the certificate's names for the hint (an SSL/TLS port only).
fn tls_fail(e: &native_tls::Error, clock: Clock, names: Option<(&str, u16)>) -> Fail {
    let text = chain(e);
    if io_in_chain(e).is_some_and(timed_out) || clock.expired() {
        return Fail::new(SECURE, format!("TLS handshake: no answer ({text})"));
    }
    let kind = classify_tls(&text);
    let mut f = Fail::new(kind, format!("TLS handshake: {text}"));
    if matches!(kind, CERT_NAME | CERT_UNTRUSTED | CERT_EXPIRED) {
        if let Some((host, port)) = names {
            f.names = read_cert_names(host, port, clock);
        }
    }
    f
}

fn handshake_fail<S>(e: native_tls::HandshakeError<S>, clock: Clock, names: Option<(&str, u16)>) -> Fail {
    match e {
        native_tls::HandshakeError::Failure(e) => tls_fail(&e, clock, names),
        native_tls::HandshakeError::WouldBlock(_) => Fail::new(SECURE, "TLS handshake: no answer"),
    }
}

fn check_imap_greeting(line: &str) -> Result<(), Fail> {
    let first = line.lines().next().unwrap_or("").trim_end();
    if first.starts_with("* OK") || first.starts_with("* PREAUTH") {
        Ok(())
    } else if first.starts_with("* BYE") {
        Err(Fail::new(BUSY, format!("greeting: {first}")))
    } else if first.starts_with("220") {
        Err(Fail::new(NOT_IMAP, format!("greeting: {first}")).sees("smtp"))
    } else {
        Err(Fail::new(NOT_IMAP, format!("greeting: {first}")))
    }
}

fn greet_imap<T: Read + Write>(client: &mut imap::Client<T>, ctl: &TcpStream, clock: Clock, starttls: bool) -> Result<(), Fail> {
    refresh(ctl, clock);
    match client.read_greeting() {
        Ok(bytes) => check_imap_greeting(&String::from_utf8_lossy(&bytes)),
        Err(imap::Error::Io(e)) if timed_out(&e) => Err(if starttls {
            Fail::new(SECURE, "no greeting: the port waits for the client (an SSL/TLS port used with STARTTLS?)")
        } else {
            Fail::new(TIMEOUT, "connected, but the server sent no greeting")
        }),
        // A plain (STARTTLS) client on a port that expects TLS first is not greeted: some servers wait and answer nothing (a time-out, above), others close the connection after a while
        // (Gmail on 993 does, after about 10 s). That is the wrong-security answer, not a busy server. In SSL/TLS or plain mode a closed connection without a greeting is "busy".
        Err(imap::Error::ConnectionLost) if starttls => Err(Fail::new(SECURE, "no greeting, the server closed the connection (an SSL/TLS port used with STARTTLS?)")),
        Err(imap::Error::ConnectionLost) => Err(Fail::new(BUSY, "the server closed the connection without a greeting")),
        Err(e) => Err(Fail::new(UNKNOWN, format!("greeting: {e}"))),
    }
}

fn imap_error(e: &imap::Error, host: &str, what: &str) -> Fail {
    match e {
        imap::Error::No(t) => Fail::new(classify_refusal("imap", host, t, AUTH), format!("{what}: NO {t}")),
        imap::Error::Bad(t) => Fail::new(classify_refusal("imap", host, t, UNKNOWN), format!("{what}: BAD {t}")),
        imap::Error::Io(io) => Fail::new(classify_io(io), format!("{what}: {io}")),
        imap::Error::ConnectionLost => Fail::new(BUSY, format!("{what}: the server closed the connection")),
        other => Fail::new(UNKNOWN, format!("{what}: {other}")),
    }
}

/// Login, CAPABILITY, LIST, LOGOUT on a connection that has been greeted (and secured).
fn imap_session<T: Read + Write>(client: imap::Client<T>, ctl: &TcpStream, acc: &Account, pw: &str, clock: Clock) -> Result<ImapDone, Fail> {
    use imap::types::NameAttribute;
    refresh(ctl, clock);
    let mut session = match client.login(&acc.username, pw) {
        Ok(s) => s,
        Err((e, _)) => return Err(imap_error(&e, &acc.imap_host, "LOGIN")),
    };
    let _ = session.capabilities();
    refresh(ctl, clock);
    let done = match session.list(Some(""), Some("*")) {
            Ok(names) => ImapDone { folders: Some(names.iter().filter(|n| !n.attributes().iter().any(|a| matches!(a, NameAttribute::NoSelect))).count() as u32), warn: None },
            Err(e) => ImapDone { folders: None, warn: Some(format!("LIST: {e}")) },
    };
    let _ = session.logout();
    Ok(done)
}

fn imap_run(acc: &Account, pw: &str, clock: Clock, abort: &Abort) -> Result<ImapDone, Fail> {
    let (host, port) = (acc.imap_host.as_str(), acc.imap_port);
    let sock = tcp_connect(host, port, clock, abort)?;
    let ctl = sock.try_clone().map_err(|e| Fail::new(UNKNOWN, e.to_string()))?;
    let tls = connector(acc.tls_insecure)?;
    if acc.imap_ssl {
        let stream = tls.connect(host, sock).map_err(|e| handshake_fail(e, clock, Some((host, port))))?;
        let mut client = imap::Client::new(stream);
        greet_imap(&mut client, &ctl, clock, false)?;
        imap_session(client, &ctl, acc, pw, clock)
    } else {
        let mut client = imap::Client::new(sock);
        greet_imap(&mut client, &ctl, clock, true)?;
        refresh(&ctl, clock);
        let client = client.secure(host, &tls).map_err(|e| match e {
            imap::Error::No(t) | imap::Error::Bad(t) => Fail::new(SECURE, format!("STARTTLS refused: {t}")),
            imap::Error::Io(io) if timed_out(&io) => Fail::new(SECURE, "STARTTLS: no answer"),
            imap::Error::ConnectionLost => Fail::new(SECURE, "STARTTLS: the server closed the connection"),
            imap::Error::TlsHandshake(h) => handshake_fail(h, clock, None),
            imap::Error::Tls(t) => tls_fail(&t, clock, None),
            other => Fail::new(SECURE, format!("STARTTLS: {other}")),
        })?;
        imap_session(client, &ctl, acc, pw, clock)
    }
}

// ---------------------------------------------------------------- SMTP

/// One SMTP reply: its lines (up to the one that reads `NNN text`, not `NNN-text`). A line that does not start like a reply ends it.
fn read_reply<R: BufRead>(r: &mut R) -> std::io::Result<Vec<String>> {
    let mut lines = vec![];
    for _ in 0..60 {
        let mut buf = Vec::new();
        let n = r.by_ref().take(4096).read_until(b'\n', &mut buf)?;
        if n == 0 {
            return if lines.is_empty() { Err(std::io::ErrorKind::UnexpectedEof.into()) } else { Ok(lines) };
        }
        let line = String::from_utf8_lossy(&buf).trim_end().to_string();
        let more = line.as_bytes().get(3) == Some(&b'-') && line.as_bytes()[..3].iter().all(u8::is_ascii_digit);
        lines.push(line);
        if !more {
            break;
        }
    }
    Ok(lines)
}

/// The greeting of an SMTP server (and, when STARTTLS is the way, EHLO and the question whether STARTTLS is offered). Nothing else is said.
fn smtp_dialog<T: Read + Write>(stream: T, ctl: &TcpStream, clock: Clock, starttls: bool) -> Result<(), Fail> {
    let mut r = BufReader::new(stream);
    refresh(ctl, clock);
    let silent = |e: &std::io::Error, stage: &str| -> Fail {
        if timed_out(e) {
            if starttls { Fail::new(SECURE, format!("{stage}: no answer (the port waits for the client?)")) } else { Fail::new(TIMEOUT, format!("{stage}: no answer")) }
        } else if e.kind() == std::io::ErrorKind::UnexpectedEof {
            // (the same reading as for IMAP: no greeting before the server hangs up, in STARTTLS mode = the port expects TLS from the start, e.g. 465)
            if starttls && stage == "greeting" { Fail::new(SECURE, format!("{stage}: the server closed the connection (an SSL/TLS port used with STARTTLS?)")) } else { Fail::new(BUSY, format!("{stage}: the server closed the connection")) }
        } else {
            Fail::new(classify_io(e), format!("{stage}: {e}"))
        }
    };
    let greeting = read_reply(&mut r).map_err(|e| silent(&e, "greeting"))?;
    let first = greeting.first().cloned().unwrap_or_default();
    if first.starts_with("220") {
    } else if first.starts_with("421") || first.starts_with("554") || first.starts_with("450") {
        return Err(Fail::new(BUSY, format!("greeting: {first}")));
    } else if first.starts_with("* OK") || first.starts_with("* PREAUTH") {
        return Err(Fail::new(NOT_SMTP, format!("greeting: {first}")).sees("imap"));
    } else {
        return Err(Fail::new(NOT_SMTP, format!("greeting: {first}")));
    }
    if starttls {
        refresh(ctl, clock);
        r.get_mut().write_all(b"EHLO [127.0.0.1]\r\n").map_err(|e| silent(&e, "EHLO"))?;
        let ehlo = read_reply(&mut r).map_err(|e| silent(&e, "EHLO"))?;
        if !ehlo.first().is_some_and(|l| l.starts_with("250")) {
            return Err(Fail::new(UNKNOWN, format!("EHLO: {}", ehlo.first().cloned().unwrap_or_default())));
        }
        if !ehlo.iter().any(|l| l.get(4..).is_some_and(|x| x.trim().eq_ignore_ascii_case("STARTTLS"))) {
            return Err(Fail::new(SECURE, format!("the server does not offer STARTTLS: {}", ehlo.join(" / "))));
        }
    }
    let _ = r.get_mut().write_all(b"QUIT\r\n");
    Ok(())
}

fn smtp_run(acc: &Account, pw: &str, clock: Clock, abort: &Abort) -> Result<(), Fail> {
    let (host, port) = (acc.smtp_host.as_str(), acc.smtp_port);
    // the greeting: is this an SMTP server, and can it be secured the way the form says
    let sock = tcp_connect(host, port, clock, abort)?;
    let ctl = sock.try_clone().map_err(|e| Fail::new(UNKNOWN, e.to_string()))?;
    if acc.smtp_security == "ssl" {
        let tls = connector(acc.tls_insecure)?;
        let stream = tls.connect(host, sock).map_err(|e| handshake_fail(e, clock, Some((host, port))))?;
        smtp_dialog(stream, &ctl, clock, false)?;
    } else {
        smtp_dialog(sock, &ctl, clock, acc.smtp_security == "starttls")?;
    }
    // the login: lettre connects again, secures, says EHLO, signs in (AUTH), NOOP, QUIT. No message is sent.
    let transport = crate::smtp::transport_with(acc, pw, Some(clock.left())).map_err(|e| Fail::new(UNKNOWN, e))?;
    match transport.test_connection() {
        Ok(true) => Ok(()),
        Ok(false) => Err(Fail::new(UNKNOWN, "the server did not accept the connection")),
        Err(e) => Err(smtp_error(&e, acc, clock)),
    }
}

fn smtp_error(e: &lettre::transport::smtp::Error, acc: &Account, clock: Clock) -> Fail {
    let text = chain(e);
    if e.status().is_none() && crate::smtp::is_tls_failure(e) {
        let kind = classify_tls(&text);
        let mut f = Fail::new(kind, format!("TLS: {text}"));
        if matches!(kind, CERT_NAME | CERT_UNTRUSTED | CERT_EXPIRED) && acc.smtp_security == "ssl" {
            f.names = read_cert_names(&acc.smtp_host, acc.smtp_port, clock);
        }
        return f;
    }
    if e.is_timeout() {
        return Fail::new(TIMEOUT, format!("SMTP: {text}"));
    }
    if e.status().is_none() {
        if let Some(io) = io_in_chain(e) {
            return Fail::new(classify_io(io), format!("SMTP: {text}"));
        }
    }
    Fail::new(classify_refusal("smtp", &acc.smtp_host, &text, UNKNOWN), format!("SMTP: {text}"))
}

// ---------------------------------------------------------------- one part, both parts

fn security_of(part: &str, acc: &Account) -> String {
    if part == "imap" {
        (if acc.imap_ssl { "ssl" } else { "starttls" }).to_string()
    } else {
        acc.smtp_security.clone()
    }
}

fn report_of(part: &str, acc: &Account, result: Result<ImapDone, Fail>, took: Duration, users: &[&str], secrets: &[&str]) -> PartReport {
    let (host, port) = if part == "imap" { (acc.imap_host.clone(), acc.imap_port) } else { (acc.smtp_host.clone(), acc.smtp_port) };
    let mut r = PartReport { host, port, security: security_of(part, acc), ms: took.as_millis() as u64, ..Default::default() };
    let clean = |s: &str| tidy(&scrub(s, users, secrets));
    match result {
        Ok(done) => {
            r.folders = done.folders;
            match done.warn {
                None => {
                    r.status = "ok".into();
                    r.kind = "ok".into();
                }
                Some(w) => {
                    r.status = "warn".into();
                    r.kind = LIST_FAILED.into();
                    r.detail = clean(&w);
                }
            }
        }
        Err(f) => {
            r.status = "error".into();
            r.kind = f.kind.into();
            r.sees = f.sees.map(str::to_string);
            r.cert_names = f.names.iter().take(5).map(|n| clean(n)).collect();
            r.detail = clean(&f.detail);
        }
    }
    // one line per part, without the user name and without what the server said
    crate::startup::line("conntest", &format!("{part} {}:{} {} -> {} ({} ms)", r.host, r.port, r.security, r.kind, r.ms));
    r
}

struct Running {
    part: &'static str,
    rx: mpsc::Receiver<PartReport>,
    abort: Abort,
    started: Instant,
    done: Option<PartReport>,
}

fn spawn_part(part: &'static str, acc: &Account, imap_pw: &str, smtp_pw: &str, timeout: Duration) -> Running {
    let (tx, rx) = mpsc::channel();
    let abort = Abort::default();
    let (acc, ab) = (acc.clone(), abort.clone());
    let (ipw, spw) = (imap_pw.to_string(), smtp_pw.to_string());
    std::thread::spawn(move || {
        let started = Instant::now();
        let clock = Clock::new(timeout);
        let result = if part == "imap" { imap_run(&acc, &ipw, clock, &ab) } else { smtp_run(&acc, &spw, clock, &ab).map(|()| ImapDone { folders: None, warn: None }) };
        let smtp_user = if acc.smtp_username.trim().is_empty() { acc.username.as_str() } else { acc.smtp_username.trim() };
        let r = report_of(part, &acc, result, started.elapsed(), &[acc.username.as_str(), smtp_user, acc.email.as_str()], &[ipw.as_str(), spw.as_str()]);
        let _ = tx.send(r);
    });
    Running { part, rx, abort, started: Instant::now(), done: None }
}

fn ended(part: &str, acc: &Account, status: &str, kind: &str, detail: &str, took: Duration) -> PartReport {
    let (host, port) = if part == "imap" { (acc.imap_host.clone(), acc.imap_port) } else { (acc.smtp_host.clone(), acc.smtp_port) };
    PartReport { status: status.into(), kind: kind.into(), host, port, security: security_of(part, acc), detail: detail.into(), ms: took.as_millis() as u64, ..Default::default() }
}

/// Run the asked parts at the same time and wait for them. A part still running `GRACE` after its limit is reported as timed out and its
/// sockets are closed; when `cancelled` turns true the parts that have not answered are reported as cancelled at once. A late answer is
/// dropped.
pub fn run(acc: &Account, imap_pw: &str, smtp_pw: &str, which: Which, timeout: Duration, cancelled: &dyn Fn() -> bool) -> ConnTestReport {
    let mut parts: Vec<Running> = vec![];
    if which != Which::Smtp {
        parts.push(spawn_part("imap", acc, imap_pw, smtp_pw, timeout));
    }
    if which != Which::Imap {
        parts.push(spawn_part("smtp", acc, imap_pw, smtp_pw, timeout));
    }
    while parts.iter().any(|p| p.done.is_none()) {
        let stop = cancelled();
        for p in parts.iter_mut().filter(|p| p.done.is_none()) {
            match p.rx.recv_timeout(Duration::from_millis(20)) {
                Ok(r) => p.done = Some(r),
                Err(mpsc::RecvTimeoutError::Disconnected) => p.done = Some(ended(p.part, acc, "error", UNKNOWN, "the check ended without an answer", p.started.elapsed())),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if stop {
                        p.abort.kill();
                        p.done = Some(ended(p.part, acc, "cancelled", "cancelled", "", p.started.elapsed()));
                    } else if p.started.elapsed() >= timeout + GRACE {
                        p.abort.kill();
                        let detail = format!("no answer within {} s", timeout.as_secs());
                        p.done = Some(ended(p.part, acc, "error", TIMEOUT, &detail, p.started.elapsed()));
                        crate::startup::line("conntest", &format!("{} {}:{} -> timeout ({} ms)", p.part, if p.part == "imap" { &acc.imap_host } else { &acc.smtp_host }, if p.part == "imap" { acc.imap_port } else { acc.smtp_port }, p.started.elapsed().as_millis()));
                    }
                }
            }
        }
    }
    let mut report = ConnTestReport::default();
    for p in parts {
        if p.part == "imap" {
            report.imap = p.done;
        } else {
            report.smtp = p.done;
        }
    }
    report
}

// ---------------------------------------------------------------- "Add account"

/// The kind of an error text of the checks "Add account" makes (mail.rs and smtp.rs words: the library's own, the coded secure connection hint,
/// the server's reply) and the protocol a wrong port answered like, if the text says so.
pub fn classify_text(part: &str, host: &str, text: &str) -> &'static str {
    // (the words of the check itself: a NO to the IMAP LOGIN is a refused sign-in unless it says more, the SMTP prefix says nothing)
    let (text, default) = match (text.strip_prefix("IMAP login failed: "), text.strip_prefix("SMTP login failed: ")) {
        (Some(rest), _) => (rest, AUTH),
        (_, Some(rest)) => (rest, UNKNOWN),
        _ => (text, UNKNOWN),
    };
    let l = text.to_lowercase();
    let has = |keys: &[&str]| keys.iter().any(|k| l.contains(k));
    if crate::mail::is_secure_connection_error(text) {
        return SECURE;
    }
    if has(&["certificate", "handshake", "tls error", "ssl error", "-2146", "-98"]) && !has(&["(535)", "(534)", "(530)", "[authenticationfailed]"]) {
        return classify_tls(text);
    }
    if has(&["no such host", "lookup", "cannot resolve", "nodename nor servname", "name or service not known", "11001", "11002", "dns name"]) {
        return DNS;
    }
    if has(&["refused", "10061"]) {
        return REFUSED;
    }
    if has(&["unreachable", "no route", "10051", "10065"]) {
        return UNREACHABLE;
    }
    if has(&["timed out", "timeout", "10060", "did not properly respond", "did not respond"]) {
        return TIMEOUT;
    }
    classify_refusal(part, host, text, default)
}

/// The English sentence of a kind: what an older page shows when it does not know `ACCOUNT_CHECK` (the page draws its own, translated).
fn english(part: &str, kind: &str) -> String {
    let which = if part == "imap" { "Incoming (IMAP)" } else { "Outgoing (SMTP)" };
    let what = match kind {
        DNS => "Server name not found. Check the host and your internet connection.",
        REFUSED => "The server refused the connection. Check the port and the security setting.",
        UNREACHABLE => "Cannot reach the server. Check your internet connection, VPN or firewall.",
        TIMEOUT => "The server did not answer within 20 seconds. Check the host and port, or your firewall.",
        SECURE => "Couldn\u{2019}t start a secure connection. The port and the security setting may not match.",
        CERT_UNTRUSTED => "The server\u{2019}s certificate is not trusted (self-signed or unknown issuer).",
        CERT_NAME => "The certificate does not match the server name.",
        CERT_EXPIRED => "The server\u{2019}s certificate has expired or is not valid yet.",
        NOT_IMAP => "This port does not answer like an incoming (IMAP) server.",
        NOT_SMTP => "This port does not answer like an outgoing (SMTP) server.",
        BUSY => "The server closed the session right away. Try again in a few minutes.",
        AUTH => "Sign-in failed. Check the username and password.",
        APP_PASSWORD => "This provider needs an app password, not your normal password.",
        MICROSOFT_PASSWORD => "Microsoft does not accept a password for this account. Sign in with the Microsoft tab instead.",
        SMTP_AUTH_OFF => "Sending with a password is turned off for this account.",
        IMAP_OFF => "IMAP is turned off for this account.",
        WEB_LOGIN => "Your provider wants you to sign in on its website first.",
        TOO_MANY => "Too many sign-in attempts. Wait a few minutes, then try again.",
        NO_AUTH => "The server does not offer sign-in on this port.",
        _ => "The check failed.",
    };
    format!("{which}: {what}")
}

/// The error of a refused part of "Add account": `ACCOUNT_CHECK|part=imap|kind=auth|host=…|port=…|sec=…|sees=…|names=…|detail=…: English`.
/// The page draws the same block as the test does from these values (src/connHints.ts `parseAccountCheck`).
pub fn coded_error(part: &str, r: &PartReport) -> String {
    let port = r.port.to_string();
    let names = r.cert_names.join(",");
    crate::i18n::coded(
        "ACCOUNT_CHECK",
        &[("part", part), ("kind", &r.kind), ("host", &r.host), ("port", &port), ("sec", &r.security), ("sees", r.sees.as_deref().unwrap_or("")), ("names", &names), ("detail", &r.detail)],
        &english(part, &r.kind),
    )
}

/// Whether an error text is a refused part of "Add account" of kind `secure` (the server cannot be secured the way the form says).
pub fn is_secure_kind(text: &str) -> bool {
    text.starts_with("ACCOUNT_CHECK|") && text.contains("|kind=secure|")
}

/// `result` (the check "Add account" made of one part) with its error, if any, in the coded form. An error that is already coded stays.
fn coded_check(part: &str, acc: &Account, pw: &str, result: R<()>) -> R<()> {
    let Err(e) = result else { return Ok(()) };
    if e.starts_with("ACCOUNT_CHECK|") {
        return Err(e);
    }
    let host = if part == "imap" { acc.imap_host.as_str() } else { acc.smtp_host.as_str() };
    let kind = classify_text(part, host, &e);
    let user = if part == "smtp" && !acc.smtp_username.trim().is_empty() { acc.smtp_username.trim() } else { acc.username.as_str() };
    let mut r = PartReport { status: "error".into(), kind: kind.into(), ..Default::default() };
    (r.host, r.port) = if part == "imap" { (acc.imap_host.clone(), acc.imap_port) } else { (acc.smtp_host.clone(), acc.smtp_port) };
    r.security = security_of(part, acc);
    r.detail = tidy(&scrub(&e, &[user, acc.email.as_str()], &[pw]));
    crate::startup::line("conntest", &format!("{part} {}:{} {} -> {} (add account)", r.host, r.port, r.security, r.kind));
    Err(coded_error(part, &r))
}

/// The incoming server check of "Add account", its refusal in the coded form (`ACCOUNT_CHECK|part=imap|…`).
pub fn check_imap(acc: &Account, pw: &str, result: R<()>) -> R<()> {
    coded_check("imap", acc, pw, result)
}

/// The outgoing server check of "Add account", its refusal in the coded form (`ACCOUNT_CHECK|part=smtp|…`).
pub fn check_smtp(acc: &Account, pw: &str, result: R<()>) -> R<()> {
    coded_check("smtp", acc, pw, result)
}

#[cfg(test)]
#[path = "conntest_tests.rs"]
mod tests;
