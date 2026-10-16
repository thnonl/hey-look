use crate::db::{err, Account, R};
use base64::Engine;
use lettre::message::header::ContentType;
use lettre::message::header::ContentTransferEncoding;
use lettre::message::{Attachment, Body, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Address, Message, SmtpTransport, Transport};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Att {
    pub filename: String,
    pub mime: String,
    pub data_base64: String,
}

/// A picture placed in the message body. The HTML refers to it as `cid:<cid>`; it is sent as a related part
/// (Content-ID + Content-Disposition: inline), so it is not listed as an attachment.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InlineImage {
    /// Content-ID without angle brackets.
    pub cid: String,
    pub filename: String,
    pub mime: String,
    pub data_base64: String,
}

/// An iCalendar (iMIP) part: sent as a text/calendar alternative (and, for invitations, as invite.ics).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPart {
    /// REQUEST | CANCEL | REPLY
    pub method: String,
    pub ics: String,
}

/// A meeting made in Compose: the backend turns it into an event and a calendar invitation when it is sent.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub start: i64,
    pub end: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub tzid: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub rrule: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub account_id: String,
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub html: String,
    pub text: String,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<Att>,
    #[serde(default)]
    pub inline: Vec<InlineImage>,
    /// Encrypt / sign / attach the public key (PGP/MIME). `None` = plain message.
    #[serde(default)]
    pub security: Option<crate::pgpstore::Security>,
    /// Finished message (base64 of the raw MIME) made at schedule time for encrypted/signed sends. When set, it
    /// is sent as is and the other content fields are not used (encrypted ones are emptied).
    #[serde(default)]
    pub prebuilt: Option<String>,
    /// Meeting details set in Compose (turned into the calendar part at send / schedule time).
    #[serde(default)]
    pub meeting: Option<Meeting>,
    /// Calendar invitation part, made from the meeting.
    #[serde(default)]
    pub calendar: Option<CalendarPart>,
    /// Send with `Sensitivity: Company-Confidential` (Outlook's "Confidential"): receiving clients show it without
    /// screen capture, copy, print or forwarding.
    #[serde(default)]
    pub confidential: bool,
}

/// Outlook's Sensitivity header. Lettre has no typed header for it.
#[derive(Clone)]
struct Sensitivity(String);

impl lettre::message::header::Header for Sensitivity {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Sensitivity")
    }
    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_string()))
    }
    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// A display name made safe to put in front of an address: control characters (header injection) are dropped and runs of
/// white space collapse to one space.
fn clean_name(n: &str) -> String {
    n.chars().filter(|c| !c.is_control() || c.is_whitespace()).map(|c| if c.is_whitespace() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `Name <address>` as one RFC 5322 mailbox string that survives any display name: the name is always a quoted-string
/// (`"` and `\` escaped), so parentheses, commas, colons, semicolons, angle brackets, quotes and non-ASCII text are all fine.
/// Without a name (or with a blank one) it is just the address.
pub fn format_mailbox(name: Option<&str>, email: &str) -> String {
    let email = email.trim();
    match name.map(clean_name).filter(|n| !n.is_empty()) {
        Some(n) => format!("\"{}\" <{email}>", n.replace('\\', "\\\\").replace('"', "\\\"")),
        None => email.to_string(),
    }
}

/// Undo the quoting of a display name: `"a \"b\""` -> `a "b"`. An unquoted name is taken as written. Only the two escapes
/// `format_mailbox` writes (`\"` and `\\`) are undone; any other backslash is part of the name (`"a \ b"` stays `a \ b`).
fn unquote_name(raw: &str) -> String {
    let t = raw.trim();
    let Some(inner) = t.strip_prefix('"').and_then(|x| x.strip_suffix('"')).filter(|_| t.len() >= 2) else { return clean_name(t) };
    let mut out = String::with_capacity(inner.len());
    let mut it = inner.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\\' if matches!(it.peek(), Some('"') | Some('\\')) => out.extend(it.next()),
            c => out.push(c),
        }
    }
    clean_name(&out)
}

/// Split `Name <address>` / `"Name" <address>` / `address` into (display name, address). The address is the part in the last
/// angle brackets, so a name that contains `<`, `>`, `,`, parentheses or quotes does not matter.
pub fn split_mailbox(s: &str) -> (Option<String>, String) {
    let t = s.trim();
    if t.ends_with('>') {
        if let Some(lt) = t.rfind('<') {
            let name = unquote_name(&t[..lt]);
            return (Some(name).filter(|n| !n.is_empty()), t[lt + 1..t.len() - 1].trim().to_string());
        }
    }
    (None, t.to_string())
}

/// Parse a recipient as the interface writes it. Unlike a strict RFC 5322 parse this accepts any display name, and still
/// rejects an address that is not one.
pub fn parse_mailbox(s: &str) -> R<Mailbox> {
    let (name, email) = split_mailbox(s);
    let addr = email.parse::<Address>().map_err(|e| format!("bad address '{s}': {e}"))?;
    Ok(Mailbox::new(name, addr))
}

fn mailbox(s: &str) -> R<Mailbox> {
    parse_mailbox(s)
}

/// A recipient header written exactly as typed, for a draft whose recipients are not all valid addresses yet (`ann@`, `ann bob`):
/// the draft keeps what the person wrote. Never used for a message that is sent (that one is strict).
macro_rules! raw_recipients {
    ($t:ident, $name:literal) => {
        #[derive(Clone, Debug, PartialEq)]
        struct $t(String);
        impl lettre::message::header::Header for $t {
            fn name() -> lettre::message::header::HeaderName {
                lettre::message::header::HeaderName::new_from_ascii_str($name)
            }
            fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
                Ok(Self(s.to_string()))
            }
            fn display(&self) -> lettre::message::header::HeaderValue {
                lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
            }
        }
    };
}
raw_recipients!(RawTo, "To");
raw_recipients!(RawCc, "Cc");
raw_recipients!(RawBcc, "Bcc");

/// `lenient`: for a DRAFT. A draft is saved as it is: no recipient, a half-typed one, an empty subject all save. lettre derives the
/// SMTP envelope from the recipient headers and refuses a message without one ("missing destination address, invalid envelope"), so
/// a draft gets an explicit envelope (from the account to the account; it is never sent, the envelope is not part of the text) and
/// recipients that are not valid addresses are written as typed. A message that is SENT is built strict (`lenient = false`).
/// `<random@domain-of-the-account>`: no host name of this computer is written into the draft.
fn draft_message_id(email: &str) -> String {
    let domain = email.rsplit_once('@').map(|(_, d)| d.trim()).filter(|d| !d.is_empty()).unwrap_or("heylook.invalid");
    format!("<{}@{}>", uuid::Uuid::new_v4().simple(), domain)
}

fn headers(acc: &Account, d: &Draft, lenient: bool) -> R<lettre::message::MessageBuilder> {
    let me = acc.email.parse::<Address>().map_err(err)?;
    let from = Mailbox::new(Some(acc.display_name.clone()).filter(|n| !n.is_empty()), me.clone());
    let mut b = Message::builder().from(from).subject(d.subject.clone());
    if lenient {
        // A draft carries its own Message-ID: the sync derives the draft's thread from it, so Save draft can tell the app which thread the
        // draft will be (an "Edit" action can open it again). Mail that is sent keeps getting its Message-ID from the server.
        b = b.message_id(Some(draft_message_id(&acc.email)));
        b = b.envelope(lettre::address::Envelope::new(Some(me.clone()), vec![me]).map_err(err)?);
        // The Bcc header stays in the DRAFT copy (QA round 17 BUG-01: lettre drops it by default, so a saved draft lost its Bcc recipients and
        // sending the reopened draft silently skipped them). It is only the person's own Drafts folder; a message that is SENT is built below
        // without it (the SMTP envelope carries the Bcc recipients, the message must not name them).
        b = b.keep_bcc();
        // each list: typed addresses when every entry is one, else the text as written
        let all_ok = |l: &[String]| l.iter().all(|t| parse_mailbox(t).is_ok());
        let raw = |l: &[String]| l.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(", ");
        if all_ok(&d.to) {
            for t in &d.to {
                b = b.to(mailbox(t)?);
            }
        } else {
            b = b.header(RawTo(raw(&d.to)));
        }
        if all_ok(&d.cc) {
            for t in &d.cc {
                b = b.cc(mailbox(t)?);
            }
        } else {
            b = b.header(RawCc(raw(&d.cc)));
        }
        if all_ok(&d.bcc) {
            for t in &d.bcc {
                b = b.bcc(mailbox(t)?);
            }
        } else {
            b = b.header(RawBcc(raw(&d.bcc)));
        }
    } else {
        for t in &d.to {
            b = b.to(mailbox(t)?);
        }
        for c in &d.cc {
            b = b.cc(mailbox(c)?);
        }
        for c in &d.bcc {
            b = b.bcc(mailbox(c)?);
        }
    }
    if let Some(r) = &d.in_reply_to {
        b = b.in_reply_to(r.clone());
    }
    if !d.references.is_empty() {
        b = b.references(d.references.join(" "));
    }
    if d.confidential {
        b = b.header(Sensitivity("Company-Confidential".into()));
    }
    Ok(b)
}

/// An attachment's bytes as they are, whatever the type. Without this lettre sends text files as 7bit / 8bit text and the
/// line endings become CRLF on the wire, so the saved file would differ from the original (checksum, diff, signatures).
fn exact_body(bytes: Vec<u8>) -> Body {
    Body::new_with_encoding(bytes, ContentTransferEncoding::Base64).unwrap_or_else(|b| Body::new(b))
}

/// The content: text/plain + text/html (+ related pictures), then the real attachments.
fn body(d: &Draft) -> R<MultiPart> {
    let html = SinglePart::html(d.html.clone());
    let mut alt = if d.inline.is_empty() {
        MultiPart::alternative().singlepart(SinglePart::plain(d.text.clone())).singlepart(html)
    } else {
        let mut related = MultiPart::related().singlepart(html);
        for img in &d.inline {
            let bytes = base64::engine::general_purpose::STANDARD.decode(&img.data_base64).map_err(err)?;
            let ct = ContentType::parse(&img.mime).unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            related = related.singlepart(Attachment::new_inline_with_name(img.cid.clone(), img.filename.clone()).body(bytes, ct));
        }
        MultiPart::alternative().singlepart(SinglePart::plain(d.text.clone())).multipart(related)
    };
    // a calendar invitation travels as the last alternative and, for invitations, also as invite.ics
    let invite_file = d.calendar.as_ref().filter(|c| c.method == "REQUEST");
    if let Some(c) = &d.calendar {
        alt = alt.singlepart(calendar_part(&c.method, &c.ics)?);
    }
    if d.attachments.is_empty() && invite_file.is_none() {
        return Ok(alt);
    }
    let mut mixed = MultiPart::mixed().multipart(alt);
    if let Some(c) = invite_file {
        let ct = ContentType::parse("application/ics; name=\"invite.ics\"").map_err(err)?;
        mixed = mixed.singlepart(Attachment::new("invite.ics".to_string()).body(c.ics.clone().into_bytes(), ct));
    }
    for a in &d.attachments {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&a.data_base64).map_err(err)?;
        let ct = ContentType::parse(&a.mime).unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
        mixed = mixed.singlepart(Attachment::new(a.filename.clone()).body(exact_body(bytes), ct));
    }
    Ok(mixed)
}

/// The text/calendar part of an iMIP message.
pub fn calendar_part(method: &str, ics: &str) -> R<SinglePart> {
    let ct = ContentType::parse(&format!("text/calendar; charset=UTF-8; method={method}")).map_err(err)?;
    Ok(SinglePart::builder().header(ct).body(ics.to_string()))
}

/// A small iMIP message (reply, update or cancellation): readable text plus the calendar part, from the account to the recipients.
pub fn build_calendar_mail(acc: &Account, to: &[String], cc: &[String], subject: &str, text: &str, cal: &CalendarPart) -> R<Message> {
    let from = Mailbox::new(Some(acc.display_name.clone()).filter(|n| !n.is_empty()), acc.email.parse::<Address>().map_err(err)?);
    let mut b = Message::builder().from(from).subject(subject.to_string());
    for t in to {
        b = b.to(mailbox(t)?);
    }
    for c in cc {
        b = b.cc(mailbox(c)?);
    }
    let alt = MultiPart::alternative().singlepart(SinglePart::plain(text.to_string())).singlepart(calendar_part(&cal.method, &cal.ics)?);
    if cal.method == "REQUEST" {
        let ct = ContentType::parse("application/ics; name=\"invite.ics\"").map_err(err)?;
        let mixed = MultiPart::mixed().multipart(alt).singlepart(Attachment::new("invite.ics".to_string()).body(cal.ics.clone().into_bytes(), ct));
        return b.multipart(mixed).map_err(err);
    }
    b.multipart(alt).map_err(err)
}

pub fn build(acc: &Account, d: &Draft) -> R<Message> {
    headers(acc, d, false)?.multipart(body(d)?).map_err(err)
}

/// multipart/signed (RFC 3156): the signature covers the content entity exactly as it is written, without the
/// line break that belongs to the next boundary line.
pub fn build_signed(acc: &Account, d: &Draft, lenient: bool, sign: &dyn Fn(&[u8]) -> R<(String, String)>) -> R<Message> {
    let inner = body(d)?;
    let mut bytes = inner.formatted();
    if bytes.ends_with(b"\r\n") {
        bytes.truncate(bytes.len() - 2);
    }
    let (armored, micalg) = sign(&bytes)?;
    let sig = SinglePart::builder()
        .header(ContentType::parse("application/pgp-signature; name=\"signature.asc\"").map_err(err)?)
        .body(armored);
    let outer = MultiPart::signed("application/pgp-signature".to_string(), micalg).multipart(inner).singlepart(sig);
    headers(acc, d, lenient)?.multipart(outer).map_err(err)
}

/// multipart/encrypted (RFC 3156): a control part and the armored OpenPGP message.
pub fn build_encrypted(acc: &Account, d: &Draft, lenient: bool, encrypt: &dyn Fn(&[u8]) -> R<String>) -> R<Message> {
    let armored = encrypt(&body(d)?.formatted())?;
    let control = SinglePart::builder().header(ContentType::parse("application/pgp-encrypted").map_err(err)?).body(String::from("Version: 1"));
    let data = SinglePart::builder()
        .header(ContentType::parse("application/octet-stream; name=\"encrypted.asc\"").map_err(err)?)
        .header(lettre::message::header::ContentDisposition::inline_with_name("encrypted.asc"))
        .body(armored);
    let outer = MultiPart::encrypted("application/pgp-encrypted".to_string()).singlepart(control).singlepart(data);
    headers(acc, d, lenient)?.multipart(outer).map_err(err)
}

/// Addresses of every recipient (To, Cc, Bcc) of a draft, for sending a prebuilt message.
pub fn envelope(acc: &Account, d: &Draft) -> R<lettre::address::Envelope> {
    let from: Address = acc.email.parse().map_err(err)?;
    let mut to: Vec<Address> = vec![];
    for r in d.to.iter().chain(d.cc.iter()).chain(d.bcc.iter()) {
        to.push(mailbox(r)?.email);
    }
    lettre::address::Envelope::new(Some(from), to).map_err(err)
}

/// SMTP login name: the account email for OAuth, else the separate SMTP user, else the IMAP user.
fn smtp_user(acc: &Account) -> String {
    if acc.auth.starts_with("oauth_") {
        acc.email.clone()
    } else if !acc.smtp_username.trim().is_empty() {
        acc.smtp_username.trim().to_string()
    } else {
        acc.username.clone()
    }
}

/// How long one step of sending (connect, TLS handshake, greeting, each reply) may take. lettre's own default is a minute; a server that
/// accepts and then stays silent (a plain SMTP port with SSL/TLS, a firewall that swallows packets) must not keep a send waiting that long.
const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// `timeout`: how long a connection step may take (lettre's own default is a minute); the checks made while an account is added use less.
fn transport_with(acc: &Account, secret: &str, timeout: Option<std::time::Duration>) -> R<SmtpTransport> {
    let host = acc.smtp_host.as_str();
    let mut b = match acc.smtp_security.as_str() {
        "ssl" => SmtpTransport::relay(host).map_err(err)?.port(acc.smtp_port),
        "starttls" => SmtpTransport::starttls_relay(host).map_err(err)?.port(acc.smtp_port),
        _ => SmtpTransport::builder_dangerous(host).port(acc.smtp_port),
    };
    if acc.tls_insecure && matches!(acc.smtp_security.as_str(), "ssl" | "starttls") {
        let params = TlsParameters::builder(host.to_string())
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true)
            .build()
            .map_err(err)?;
        b = b.tls(if acc.smtp_security == "ssl" { Tls::Wrapper(params) } else { Tls::Required(params) });
    }
    let b = b.credentials(Credentials::new(smtp_user(acc), secret.to_string()));
    let b = if timeout.is_some() { b.timeout(timeout) } else { b };
    Ok((if acc.auth.starts_with("oauth_") { b.authentication(vec![Mechanism::Xoauth2]) } else { b }).build())
}

use crate::mail::{Probe, SILENT_STARTTLS};

/// The SSL/TLS (implicit TLS) handshake check of `mail::probe_tls_handshake`, for the SMTP connection of `acc`: lettre sets the read and
/// write timeouts of such a connection only after the handshake has finished, so a server that accepts the connection and then stays
/// silent (a plain SMTP port, a firewall that swallows packets) would keep a send or an account check waiting with no bound at all.
fn probe_ssl_handshake(acc: &Account, timeout: std::time::Duration) -> Result<(), Probe> {
    if acc.smtp_security != "ssl" {
        return Ok(());
    }
    crate::mail::probe_tls_handshake(&acc.smtp_host, acc.smtp_port, acc.tls_insecure, timeout)
}

/// The STARTTLS counterpart of `probe_ssl_handshake`, used by the connection check of an account being added: the greeting, EHLO and the
/// STARTTLS request are run once on a socket whose reads are bound by one deadline, and the result is thrown away. A server that
/// accepts the connection and then says nothing (a port that waits for the client, a firewall that swallows packets) cannot be secured,
/// so it gets the secure connection hint and the account is not added; anything else (a refusal, a server without STARTTLS, a reply
/// that is not understood) is left to lettre, which words it as before.
fn probe_starttls(acc: &Account, timeout: std::time::Duration) -> Result<(), Probe> {
    use std::io::{BufRead, BufReader, Write};
    use std::net::ToSocketAddrs;
    if acc.smtp_security != "starttls" {
        return Ok(());
    }
    let Ok(addrs) = (acc.smtp_host.as_str(), acc.smtp_port).to_socket_addrs() else { return Ok(()) };
    let mut timed_out = None;
    for addr in addrs {
        let sock = match std::net::TcpStream::connect_timeout(&addr, timeout) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                timed_out = Some(e.to_string());
                continue;
            }
            Err(_) => continue,
        };
        let _ = sock.set_write_timeout(Some(timeout));
        let deadline = std::time::Instant::now() + timeout;
        let Ok(mut out) = sock.try_clone() else { return Ok(()) };
        let mut input = BufReader::new(sock);
        // one reply: lines until one reads "NNN text" (not "NNN-text"); None when the server did not answer in time or went away
        let reply = |input: &mut BufReader<std::net::TcpStream>| -> Result<Option<String>, ()> {
            let mut first = None;
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    return Err(());
                }
                let _ = input.get_ref().set_read_timeout(Some(left));
                let mut line = String::new();
                match input.read_line(&mut line) {
                    Ok(0) => return Ok(first),
                    Ok(_) => {
                        let multi = line.as_bytes().get(3) == Some(&b'-');
                        first.get_or_insert(line);
                        if !multi {
                            return Ok(first);
                        }
                    }
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) => return Err(()),
                    Err(_) => return Ok(first),
                }
            }
        };
        let silent = || Err(Probe::Silent(SILENT_STARTTLS));
        match reply(&mut input) {
            Err(()) => return silent(),
            Ok(Some(g)) if g.starts_with("220") => {}
            _ => return Ok(()),
        }
        if out.write_all(b"EHLO hey-look.local\r\n").is_err() {
            return Ok(());
        }
        match reply(&mut input) {
            Err(()) => return silent(),
            Ok(Some(r)) if r.starts_with("250") => {}
            _ => return Ok(()),
        }
        if out.write_all(b"STARTTLS\r\n").is_err() {
            return Ok(());
        }
        let r = reply(&mut input);
        let _ = out.write_all(b"QUIT\r\n");
        return if r.is_err() { silent() } else { Ok(()) };
    }
    timed_out.map_or(Ok(()), |e| Err(Probe::ConnectTimedOut(e)))
}

/// Send an already finished message (encrypted/signed ones are built once, at schedule time).
pub fn send_raw(acc: &Account, secret: &str, env: &lettre::address::Envelope, raw: &[u8]) -> R<()> {
    send_raw_with(acc, secret, env, raw, SEND_TIMEOUT)
}

fn send_raw_with(acc: &Account, secret: &str, env: &lettre::address::Envelope, raw: &[u8], timeout: std::time::Duration) -> R<()> {
    if let Err(p) = probe_ssl_handshake(acc, timeout) {
        return Err(p.explain(&acc.smtp_host, acc.smtp_port, |detail| explain_send_error(None, detail)));
    }
    transport_with(acc, secret, Some(timeout))?.send_raw(env, raw).map_err(|e| {
        let text = e.to_string();
        // a failure of the TLS step has its own hint (REQ-53); everything else is explained as before
        if e.status().is_none() && is_tls_failure(&e) {
            crate::mail::secure_connection_error(&acc.smtp_host, acc.smtp_port, &text)
        } else {
            explain_send_error(e.status().map(|c| c.to_string()).as_deref(), &text)
        }
    })?;
    Ok(())
}

/// The text of a failed send. Replies that a person can act on get a plain sentence (with a code the interface strips);
/// everything else keeps the server's own words.
pub fn explain_send_error(code: Option<&str>, detail: &str) -> String {
    let d = detail.to_lowercase();
    let rejected = matches!(code, Some("552" | "554" | "550" | "553")) || d.contains("(552)") || d.contains("(554)") || d.contains("(550)");
    // Gmail: "552 5.7.0 ... blocked because its content presents a potential security issue"; others name the attachment or the file type
    let blocked = rejected
        && ["attachment", "executable", "file type", "security issue", "malware", "virus", "blocked because", "contents rejected", "5.7.0"].iter().any(|k| d.contains(k));
    if blocked && !d.contains("too large") && !d.contains("5.3.4") {
        let reply = detail.trim().trim_start_matches("permanent error ").trim();
        return crate::i18n::coded(
            "SMTP_ATTACHMENT_BLOCKED",
            &[("reply", reply)],
            &format!("The server rejected the attachment type. Gmail, Outlook and Yahoo refuse programs and scripts such as .exe, .bat, .js or .msi, even inside a zip file. Remove the attachment or share it as a link instead. (Server reply: {reply})"),
        );
    }
    if code == Some("552") && (d.contains("too large") || d.contains("5.3.4") || d.contains("size")) {
        let reply = detail.trim();
        return crate::i18n::coded("SMTP_TOO_LARGE", &[("reply", reply)], &format!("The message is larger than this server accepts. Remove attachments or shrink pictures. (Server reply: {reply})"));
    }
    format!("SMTP send failed: {detail}")
}

/// Whether a failed SMTP step failed while the connection was being secured (STARTTLS refused, the SSL/TLS handshake failed), as
/// opposed to a refused or timed out connection or a refused login. lettre words a failed STARTTLS in its own words ("tls",
/// "starttls"), but a failed SSL/TLS handshake of the native-tls backend only as "Connection error: ..." (Windows: "The token supplied
/// to the function is invalid"), so the cause decides: a connection that could not be opened has an I/O error as its cause, a handshake
/// that failed has the TLS library's own error (QA round 6: a plain SMTP port with SSL/TLS gave the raw text, not the REQ-53 hint).
pub fn is_tls_failure(e: &lettre::transport::smtp::Error) -> bool {
    use std::error::Error as _;
    if e.status().is_some() || e.is_timeout() {
        return false;
    }
    let text = e.to_string();
    if crate::mail::is_tls_step_failure(&text) {
        return true;
    }
    let from_io = e.source().is_some_and(|s| s.downcast_ref::<std::io::Error>().is_some());
    text.starts_with("Connection error") && !from_io && !text.contains("resolve") && !text.contains("DNS name")
}

/// How long the connection test of an account being added may take.
const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Connect and authenticate without sending anything.
pub fn test(acc: &Account, secret: &str) -> R<()> {
    test_with(acc, secret, TEST_TIMEOUT)
}

pub(crate) fn test_with(acc: &Account, secret: &str, timeout: std::time::Duration) -> R<()> {
    if let Err(p) = probe_ssl_handshake(acc, timeout).and_then(|()| probe_starttls(acc, timeout)) {
        return Err(p.explain(&acc.smtp_host, acc.smtp_port, |detail| format!("SMTP login failed: {detail}")));
    }
    match transport_with(acc, secret, Some(timeout))?.test_connection() {
        Ok(true) => Ok(()),
        Ok(false) => Err("SMTP server did not accept the connection".into()),
        Err(e) => {
            let text = e.to_string();
            // a failure of the TLS step has its own hint (REQ-53); a refused login stays "SMTP login failed"
            if e.status().is_none() && is_tls_failure(&e) {
                Err(crate::mail::secure_connection_error(&acc.smtp_host, acc.smtp_port, &text))
            } else {
                Err(format!("SMTP login failed: {e}"))
            }
        }
    }
}

/// What is saved to the Drafts folder: like `build`, but a draft needs no recipient, no subject and may hold half-typed addresses.
pub fn build_draft(acc: &Account, d: &Draft) -> R<Message> {
    headers(acc, d, true)?.multipart(body(d)?).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> Account {
        Account {
            id: "a1".into(),
            email: "me@example.com".into(),
            display_name: "Me".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            username: "me@example.com".into(),
            auth: "password".into(),
            color: None,
            smtp_username: String::new(),
            tls_insecure: false,
        }
    }

    fn draft(html: &str, inline: Vec<InlineImage>, attachments: Vec<Att>) -> Draft {
        Draft {
            account_id: "a1".into(),
            to: vec!["ann@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Pictures".into(),
            html: html.into(),
            text: "Hello".into(),
            in_reply_to: None,
            references: vec![],
            attachments,
            inline,
            security: None,
            prebuilt: None,
            meeting: None,
            calendar: None,
            confidential: false,
        }
    }

    fn pic(cid: &str) -> InlineImage {
        InlineImage {
            cid: cid.into(),
            filename: "logo.png".into(),
            mime: "image/png".into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode([137u8, 80, 78, 71]),
        }
    }

    fn text(m: &Message) -> String {
        String::from_utf8_lossy(&m.formatted()).into_owned()
    }

    /// A draft saves whatever the person has typed so far (QA BUG-7: "missing destination address, invalid envelope"); a message that is
    /// sent still needs a valid recipient.
    /// QA BUG-M3: local servers have addresses like `qa@localhost`; the backend must take them too (the composer checks first).
    #[test]
    fn addresses_on_a_single_label_host_can_be_sent_to() {
        for a in ["qa@localhost", "Local QA <qa@localhost>", "me@intranet"] {
            assert!(parse_mailbox(a).is_ok(), "{a}");
        }
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.to = vec!["qa@localhost".into()];
        assert!(build(&account(), &d).is_ok());
        assert!(envelope(&account(), &d).is_ok());
    }

    #[test]
    fn a_draft_needs_no_recipient_no_subject_and_may_hold_half_typed_addresses() {
        let acc = account();
        // nothing but a body, an empty subject
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.to.clear();
        d.subject.clear();
        let out = text(&build_draft(&acc, &d).expect("empty To saves"));
        assert!(out.contains("From:") && out.contains("Hi"));
        assert!(!out.contains("
To:"), "no To header is invented: {out}");
        // only Cc
        d.cc = vec!["bob@example.com".into()];
        let out = text(&build_draft(&acc, &d).expect("only Cc saves"));
        assert!(out.contains("Cc: bob@example.com"), "{out}");
        // half-typed / invalid recipients are kept as typed
        d.to = vec!["ann@".into(), "Carl <carl@example.com>".into()];
        d.bcc = vec!["not an address".into()];
        let out = text(&build_draft(&acc, &d).expect("invalid recipients save"));
        assert!(out.contains("To: ann@, Carl <carl@example.com>"), "{out}");
        assert!(out.contains("Bcc: not an address"), "a half-typed Bcc is kept as typed too: {out}");
        // valid recipients are typed headers as before
        d.to = vec!["Ann <ann@example.com>".into()];
        d.bcc.clear();
        let out = text(&build_draft(&acc, &d).unwrap());
        assert!(out.contains("To: Ann <ann@example.com>") || out.contains("To: \"Ann\" <ann@example.com>"), "{out}");
        // the encrypted-draft route builds the same way
        let enc = build_encrypted(&acc, &{ let mut e = d.clone(); e.to.clear(); e }, true, &|_| Ok("armored".to_string()));
        assert!(enc.is_ok(), "{:?}", enc.err());

        // sending stays strict: no recipient, or one that is not an address, is refused
        let mut s = draft("<p>Hi</p>", vec![], vec![]);
        s.to.clear();
        assert!(build(&acc, &s).is_err(), "a message without recipients must not be built for sending");
        assert!(envelope(&acc, &s).is_err());
        s.to = vec!["ann@".into()];
        assert!(build(&acc, &s).is_err());
        assert!(envelope(&acc, &s).is_err());
    }

    /// QA round 17 BUG-01 (CF-1): the Bcc recipients were missing from the saved draft, so a reopened draft was sent without them.
    #[test]
    fn a_saved_draft_keeps_its_bcc_but_a_sent_message_never_names_it() {
        let acc = account();
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.cc = vec!["cc@example.com".into()];
        d.bcc = vec!["Quiet <quiet@example.com>".into(), "silent@example.com".into()];
        let saved = text(&build_draft(&acc, &d).unwrap());
        assert!(saved.contains("Bcc: Quiet <quiet@example.com>, silent@example.com"), "the draft copy has the Bcc header: {saved}");
        // only the draft copy: what is sent has no Bcc header, whatever the route (plain, signed, encrypted)
        let sent = text(&build(&acc, &d).unwrap());
        assert!(!sent.to_ascii_lowercase().contains("bcc:"), "{sent}");
        assert!(!sent.contains("quiet@example.com") && !sent.contains("silent@example.com"), "{sent}");
        let signed = text(&build_signed(&acc, &d, false, &|_| Ok(("sig".to_string(), "pgp-sha256".to_string()))).unwrap());
        assert!(!signed.to_ascii_lowercase().contains("bcc:"), "{signed}");
        let enc = text(&build_encrypted(&acc, &d, false, &|_| Ok("armored".to_string())).unwrap());
        assert!(!enc.to_ascii_lowercase().contains("bcc:"), "{enc}");
        // ... while the SMTP envelope delivers to all of them
        let env = build(&acc, &d).unwrap().envelope().clone();
        let to: Vec<String> = env.to().iter().map(|a| a.to_string()).collect();
        for a in ["ann@example.com", "cc@example.com", "quiet@example.com", "silent@example.com"] {
            assert!(to.contains(&a.to_string()), "{a} is an envelope recipient: {to:?}");
        }
        // an encrypted draft (to your own key) keeps it in the outer headers as well
        let encd = text(&build_encrypted(&acc, &d, true, &|_| Ok("armored".to_string())).unwrap());
        assert!(encd.contains("Bcc: Quiet <quiet@example.com>, silent@example.com"), "{encd}");
        // the draft copy is still never sent anywhere by its envelope: it is the account's own
        let env = build_draft(&acc, &d).unwrap().envelope().clone();
        assert_eq!(env.to().iter().map(|a| a.to_string()).collect::<Vec<_>>(), vec!["me@example.com"]);
    }

    /// A scheduled message and a message in its Undo time are stored as the JSON of the draft: the Bcc recipients are part of it, still
    /// recipients of the envelope when it is built from the stored copy, and still not named in the message.
    #[test]
    fn the_stored_copy_of_a_queued_message_keeps_its_bcc() {
        let acc = account();
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.bcc = vec!["quiet@example.com".into()];
        let stored = serde_json::to_string(&d).unwrap();
        assert!(stored.contains("\"bcc\":[\"quiet@example.com\"]"), "{stored}");
        let back: Draft = serde_json::from_str(&stored).unwrap();
        assert_eq!(back.bcc, d.bcc);
        let msg = build(&acc, &back).unwrap();
        assert!(msg.envelope().to().iter().any(|a| a.to_string() == "quiet@example.com"));
        assert!(!text(&msg).to_ascii_lowercase().contains("bcc:"));
        // a finished (prebuilt) message is sent to the same recipients through its envelope
        assert!(envelope(&acc, &back).unwrap().to().iter().any(|a| a.to_string() == "quiet@example.com"));
    }

    #[test]
    fn a_saved_draft_says_which_thread_the_sync_will_put_it_in() {
        let acc = account();
        // a new message: its own Message-ID (account domain, no host name) is the thread root
        let d = draft("<p>Hi</p>", vec![], vec![]);
        let raw = build_draft(&acc, &d).unwrap().formatted();
        let p = crate::mail::parse(41, &raw, true, false, 0).expect("the draft parses");
        let id = p.message_id.clone().expect("a draft carries a Message-ID");
        assert!(id.starts_with('<') && id.ends_with("@example.com>"), "{id}");
        let tid = crate::draft_thread_id("a1", &raw).expect("thread of a new draft");
        assert_eq!(tid, crate::thread_id_of("a1", "drafts", &p), "same thread as the sync gives it, whatever uid the server picks");
        let again = crate::draft_thread_id("a1", &build_draft(&acc, &d).unwrap().formatted()).unwrap();
        assert_ne!(tid, again, "two drafts are two threads");

        // an answer: the thread of the mail it answers (its first reference)
        let mut r = draft("<p>Re</p>", vec![], vec![]);
        r.in_reply_to = Some("<orig@x.org>".into());
        r.references = vec!["<root@x.org>".into(), "<orig@x.org>".into()];
        let raw = build_draft(&acc, &r).unwrap().formatted();
        let p = crate::mail::parse(42, &raw, true, false, 0).unwrap();
        assert_eq!(crate::draft_thread_id("a1", &raw), Some(crate::thread_id_of("a1", "drafts", &p)));
        assert_eq!(p.refs.first().map(String::as_str), Some("<root@x.org>"));

        // sending is unchanged: no Message-ID is made here (the server writes it)
        let sent = text(&build(&acc, &d).unwrap());
        assert!(!sent.to_ascii_lowercase().contains("message-id:"), "{sent}");
    }

    #[test]
    fn inline_picture_is_a_related_part_with_content_id() {
        let d = draft("<p>Logo <img src=\"cid:logo@heylook\" alt=\"Logo\"></p>", vec![pic("logo@heylook")], vec![]);
        let out = text(&build(&account(), &d).unwrap());
        assert!(out.contains("multipart/related"), "related wrapper present");
        assert!(out.contains("multipart/alternative"), "text and html alternatives present");
        assert!(out.contains("Content-ID: <logo@heylook>"), "content id header: {out}");
        assert!(out.contains("Content-Disposition: inline"), "inline disposition");
        assert!(out.contains("cid:logo@heylook"));
        assert!(!out.contains("Content-Disposition: attachment"), "pictures are not attachments");
    }

    #[test]
    fn real_attachments_stay_separate_from_inline_pictures() {
        let att = Att { filename: "report.pdf".into(), mime: "application/pdf".into(), data_base64: "JVBERi0=".into() };
        let d = draft("<p>x</p>", vec![pic("logo@heylook")], vec![att]);
        let out = text(&build(&account(), &d).unwrap());
        assert!(out.contains("multipart/mixed"));
        assert!(out.contains("Content-Disposition: attachment"));
        assert!(out.contains("filename=\"report.pdf\""));
        assert!(out.contains("Content-ID: <logo@heylook>"));
    }


    #[test]
    fn text_attachments_arrive_byte_for_byte() {
        // LF-only text, CRLF text, a lone CR, Latin-1 bytes that are not valid UTF-8, no final newline, a very long line
        let files: Vec<(&str, &str, Vec<u8>)> = vec![
            ("lf.txt", "text/plain", b"first line\nsecond line\n".to_vec()),
            ("crlf.txt", "text/plain", b"a\r\nb\r\n".to_vec()),
            ("mixed.csv", "text/csv", b"a,b\rc,d\ne,f".to_vec()),
            ("latin1.txt", "text/plain; charset=iso-8859-1", vec![b'c', b'a', b'f', 0xE9, b'\n']),
            ("page.html", "text/html", b"<p>x</p>\n<p>\xff\xfe</p>\n".to_vec()),
            ("long.txt", "text/plain", format!("{}\n", "x".repeat(5000)).into_bytes()),
        ];
        let atts: Vec<Att> = files.iter().map(|(n, m, b)| Att { filename: (*n).into(), mime: (*m).into(), data_base64: base64::engine::general_purpose::STANDARD.encode(b) }).collect();
        let d = draft("<p>x</p>", vec![], atts);
        let raw = build(&account(), &d).unwrap().formatted();
        let out = String::from_utf8_lossy(&raw).into_owned();
        assert!(!out.contains("Content-Transfer-Encoding: 7bit\r\n\r\nfirst line"), "attachments are not sent as plain text");
        let metas = crate::mail::parse(0, &raw, true, false, 0).unwrap().attachments;
        assert_eq!(metas.len(), files.len());
        for (i, (name, _, bytes)) in files.iter().enumerate() {
            let (got_name, got) = crate::mail::attachment_bytes(&raw, i).unwrap();
            assert_eq!(&got_name, name);
            assert_eq!(&got, bytes, "{name} unchanged");
            assert_eq!(metas[i].size, bytes.len(), "{name} size");
        }
    }
    #[test]
    fn draft_without_pictures_has_no_related_part() {
        let out = text(&build(&account(), &draft("<p>plain</p>", vec![], vec![])).unwrap());
        assert!(!out.contains("multipart/related"));
        assert!(!out.contains("Content-ID"));
    }

    #[test]
    fn bad_picture_data_is_an_error_not_a_silent_drop() {
        let mut img = pic("x@heylook");
        img.data_base64 = "!!not base64!!".into();
        assert!(build(&account(), &draft("<p>x</p>", vec![img], vec![])).is_err());
    }

    #[test]
    fn draft_json_without_inline_field_still_deserializes() {
        let json = r#"{"accountId":"a1","to":["a@b.c"],"subject":"s","html":"<p>x</p>","text":"x"}"#;
        let d: Draft = serde_json::from_str(json).unwrap();
        assert!(d.inline.is_empty());
    }

    #[test]
    fn display_names_with_specials_round_trip_through_format_and_parse() {
        let names = [
            "Nam Thái (thnonline)",
            "Tran, Bao",
            "He said \"hi\"",
            "Back\\slash",
            "semi;colon: <angle>",
            "Đỗ Văn Ánh",
            "[brackets] @ at",
            "a\r\nBcc: evil@x.y",
        ];
        for n in names {
            let s = format_mailbox(Some(n), "to@example.com");
            let (name, email) = split_mailbox(&s);
            assert_eq!(email, "to@example.com", "{n:?}");
            assert_eq!(name.as_deref(), Some(n.split_whitespace().collect::<Vec<_>>().join(" ").as_str()), "{n:?}");
            let m = parse_mailbox(&s).unwrap_or_else(|e| panic!("{n:?}: {e}"));
            assert_eq!(m.email.to_string(), "to@example.com");
            // the finished message carries exactly one To address and no injected header
            let mut d = draft("<p>x</p>", vec![], vec![]);
            d.to = vec![s.clone()];
            let out = build(&account(), &d).unwrap();
            let raw = out.formatted();
            let parsed = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
            assert_eq!(parsed.to().unwrap().iter().count(), 1, "{n:?}");
            assert!(parsed.bcc().is_none(), "{n:?}");
            assert_eq!(out.envelope().to().len(), 1);
            assert_eq!(envelope(&account(), &d).unwrap().to().len(), 1);
        }
        assert_eq!(format_mailbox(None, " a@b.c "), "a@b.c");
        assert_eq!(format_mailbox(Some("  "), "a@b.c"), "a@b.c");
    }

    #[test]
    fn a_backslash_in_a_display_name_is_kept_even_when_the_name_was_quoted_by_hand() {
        // quoted by hand with only the quotes escaped: a lone backslash (before a space or a letter) is part of the name
        let (n, e) = split_mailbox(r#""Nam; Thái: \"test\" \ (x)" <b@x.y>"#);
        assert_eq!(e, "b@x.y");
        assert_eq!(n.as_deref(), Some(r#"Nam; Thái: "test" \ (x)"#));
        let (n, _) = split_mailbox(r#""C:\dir\sub" <b@x.y>"#);
        assert_eq!(n.as_deref(), Some(r"C:\dir\sub"));
        // written by format_mailbox, unquoted, or doubled: all the same
        let (n, _) = split_mailbox(&format_mailbox(Some(r"a \ b \\ c"), "b@x.y"));
        assert_eq!(n.as_deref(), Some(r"a \ b \\ c"));
        let (n, _) = split_mailbox(r"Nam \ (x) <b@x.y>");
        assert_eq!(n.as_deref(), Some(r"Nam \ (x)"));
    }

    #[test]
    fn plain_recipients_still_parse_and_garbage_is_rejected() {
        assert_eq!(parse_mailbox("ann@example.com").unwrap().email.to_string(), "ann@example.com");
        let m = parse_mailbox("Ann Lee <ann@example.com>").unwrap();
        assert_eq!(m.name.as_deref(), Some("Ann Lee"));
        let m = parse_mailbox("\"Lee, Ann\" <ann@example.com>").unwrap();
        assert_eq!(m.name.as_deref(), Some("Lee, Ann"));
        let m = parse_mailbox("<ann@example.com>").unwrap();
        assert!(m.name.is_none());
        assert!(parse_mailbox("not an address").is_err());
        assert!(parse_mailbox("Ann <nope>").is_err());
        assert!(parse_mailbox("").is_err());
        assert!(parse_mailbox("a@b.c, d@e.f").is_err(), "one recipient per entry");
    }

    #[test]
    fn blocked_attachment_replies_get_a_plain_message() {
        let gmail = explain_send_error(Some("552"), "permanent error (552): 5.7.0 This message was blocked because its content presents a potential security issue. For more information go to https://support.google.com/mail/?p=BlockedMessage");
        assert!(gmail.starts_with("SMTP_ATTACHMENT_BLOCKED|reply=") && gmail.contains(": The server rejected the attachment type"), "{gmail}");
        assert!(gmail.contains(".exe"));
        assert!(gmail.contains("5.7.0"), "the server's words are kept: {gmail}");
        let other = explain_send_error(Some("554"), "permanent error (554): 5.7.1 attachment type not allowed");
        assert!(other.starts_with("SMTP_ATTACHMENT_BLOCKED|"));
        // a size error is not an attachment-type error
        let big = explain_send_error(Some("552"), "permanent error (552): 5.3.4 Message size exceeds fixed limit");
        assert!(big.starts_with("SMTP_TOO_LARGE|reply="), "{big}");
        // other failures keep the old text
        assert_eq!(explain_send_error(Some("535"), "permanent error (535): bad credentials"), "SMTP send failed: permanent error (535): bad credentials");
        assert_eq!(explain_send_error(None, "connection timed out"), "SMTP send failed: connection timed out");
        // a blocked-attachment failure is permanent for the scheduled-send retry rules
        assert!(!crate::schedule::is_transient(&gmail));
        assert!(!crate::schedule::is_transient(&other));
    }

    #[test]
    fn confidential_draft_carries_the_outlook_sensitivity_header() {
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        let plain = String::from_utf8(build(&account(), &d).unwrap().formatted()).unwrap();
        assert!(!plain.contains("Sensitivity:"), "{plain}");
        d.confidential = true;
        let raw = build(&account(), &d).unwrap().formatted();
        assert!(String::from_utf8_lossy(&raw).contains("Sensitivity: Company-Confidential"));
        // what we send is what we recognise on receipt
        assert!(crate::mail::is_confidential(&raw));
    }

    /// A mail server that does not speak TLS (QA round 6: GreenMail on 127.0.0.1:3025): it greets in plain text, knows no STARTTLS,
    /// and answers everything else with an error. Returns its port; it serves connections until the test ends. It never waits for
    /// ever: input that is not text (a TLS ClientHello, which has no line end) makes it drop the connection, as a real server does, and
    /// a connection that sends nothing for 5 s is closed.
    fn plain_smtp_server() -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    let mut w = conn.try_clone().unwrap();
                    let _ = w.write_all(b"220 plain.test ESMTP\r\n");
                    let mut r = &conn;
                    let (mut buf, mut chunk) = (Vec::<u8>::new(), [0u8; 4096]);
                    'serve: loop {
                        match r.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                        if buf.iter().any(|b| !matches!(b, b'\r' | b'\n' | b'\t' | 0x20..=0x7e)) {
                            break;
                        }
                        while let Some(end) = buf.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=end).collect();
                            let l = String::from_utf8_lossy(&line).to_uppercase();
                            let reply: &[u8] = if l.starts_with("EHLO") { b"250 plain.test\r\n" } else if l.starts_with("QUIT") { b"221 bye\r\n" } else { b"500 Command not recognized\r\n" };
                            if w.write_all(reply).is_err() || l.starts_with("QUIT") {
                                break 'serve;
                            }
                        }
                    }
                    let _ = conn.shutdown(std::net::Shutdown::Both);
                });
            }
        });
        port
    }

    /// A server that accepts connections and never says a word (a firewall that swallows packets, a service that waits for the client to
    /// speak first). Connections are held open until the returned sender is dropped.
    fn silent_server() -> (u16, std::sync::mpsc::Sender<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, gone) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            while !matches!(gone.try_recv(), Err(std::sync::mpsc::TryRecvError::Disconnected)) {
                match listener.accept() {
                    Ok((c, _)) => held.push(c),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
        });
        (port, stop)
    }

    fn envelope_for_tests() -> lettre::address::Envelope {
        lettre::address::Envelope::new(Some("me@example.com".parse().unwrap()), vec!["you@example.com".parse().unwrap()]).unwrap()
    }

    /// QA round 6 (OBS-R6-2, REQ-53 / AC-69): a plain SMTP port with SSL/TLS or STARTTLS is reported with the hint, not the library's
    /// words (on Windows "The token supplied to the function is invalid").
    #[test]
    fn a_plain_smtp_port_with_ssl_or_starttls_gets_the_secure_connection_hint() {
        // hard bound: macOS QA saw this test wait for ever when the fixture never answered a TLS ClientHello
        crate::test_guard::within(120, || {
            let port = plain_smtp_server();
            for security in ["ssl", "starttls"] {
                let mut acc = account();
                acc.smtp_host = "127.0.0.1".into();
                acc.smtp_port = port;
                acc.smtp_security = security.into();
                acc.tls_insecure = true; // the certificate is not the question here
                let e = test(&acc, "secret").unwrap_err();
                assert!(crate::mail::is_secure_connection_error(&e), "{security}: {e}");
                assert!(e.contains(&format!("127.0.0.1:{port}")) && e.contains("SSL/TLS or STARTTLS") && e.contains("(Server: "), "{security}: {e}");
                // sending uses the same words
                let e = send_raw(&acc, "secret", &envelope_for_tests(), b"Subject: x\r\n\r\nhi").unwrap_err();
                assert!(crate::mail::is_secure_connection_error(&e), "send, {security}: {e}");
            }
        });
    }

    /// A server that accepts and stays silent ends the connection check and the send with an error after the timeout, whatever the
    /// security setting says; it never waits for ever.
    #[test]
    fn a_silent_smtp_server_is_given_up_on_after_the_timeout() {
        crate::test_guard::within(90, || {
            assert!(SEND_TIMEOUT <= std::time::Duration::from_secs(30) && TEST_TIMEOUT <= std::time::Duration::from_secs(30));
            let (port, _keep_open) = silent_server();
            let short = std::time::Duration::from_secs(2);
            for security in ["none", "ssl", "starttls"] {
                let mut acc = account();
                acc.smtp_host = "127.0.0.1".into();
                acc.smtp_port = port;
                acc.smtp_security = security.into();
                acc.tls_insecure = true;
                let t = std::time::Instant::now();
                let e = test_with(&acc, "secret", short).unwrap_err();
                // a server that cannot be secured gets the hint (the add is refused); with no security asked for, it is an ordinary timeout
                assert_eq!(crate::mail::is_secure_connection_error(&e), security != "none", "{security}: connection check: {e}");
                assert!(t.elapsed() < std::time::Duration::from_secs(15), "{security}: connection check took {:?}", t.elapsed());
                let t = std::time::Instant::now();
                assert!(send_raw_with(&acc, "secret", &envelope_for_tests(), b"Subject: x\r\n\r\nhi", short).is_err(), "{security}: send");
                assert!(t.elapsed() < std::time::Duration::from_secs(15), "{security}: send took {:?}", t.elapsed());
            }
        });
    }

    #[test]
    fn a_closed_smtp_port_is_a_connection_problem_not_a_secure_connection_hint() {
        crate::test_guard::within(60, || {
            // a port nothing listens on: refused, which has an I/O error as its cause
            let port = {
                let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                l.local_addr().unwrap().port()
            };
            let mut acc = account();
            acc.smtp_host = "127.0.0.1".into();
            acc.smtp_port = port;
            let e = test(&acc, "secret").unwrap_err();
            assert!(!crate::mail::is_secure_connection_error(&e), "{e}");
            assert!(e.starts_with("SMTP login failed: "), "{e}");
        });
    }

    #[test]
    fn the_secure_connection_hint_is_recognised_by_its_first_words() {
        let hint = crate::mail::secure_connection_error("h", 25, "x");
        assert!(crate::mail::is_secure_connection_error(&hint));
        assert!(!crate::mail::is_secure_connection_error("SMTP login failed: bad password"));
        assert!(!crate::mail::is_secure_connection_error("certificate verify failed"));
    }

    // ---- Add account: a mailbox whose server cannot be secured is never saved (QA v1.0.1 round 2, BUG-1) ----

    /// A server that speaks SMTP up to STARTTLS (greeting, EHLO with the STARTTLS extension, "220 Ready to start TLS") and stays silent
    /// after the step named in `silent_after` ("greeting", "ehlo", "starttls"; anything else: it never goes silent).
    fn starttls_smtp_server(silent_after: &'static str) -> (u16, std::sync::mpsc::Sender<()>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, gone) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            while !matches!(gone.try_recv(), Err(std::sync::mpsc::TryRecvError::Disconnected)) {
                match listener.accept() {
                    Ok((c, _)) => {
                        let _ = c.set_nonblocking(false);
                        let mut w = c.try_clone().unwrap();
                        let r = c.try_clone().unwrap();
                        held.push(c);
                        std::thread::spawn(move || {
                            let _ = w.write_all(b"220 fake.test ESMTP\r\n");
                            if silent_after == "greeting" {
                                return;
                            }
                            for line in BufReader::new(r).lines().map_while(Result::ok) {
                                let l = line.to_uppercase();
                                if l.starts_with("EHLO") {
                                    if silent_after == "ehlo" {
                                        return;
                                    }
                                    let _ = w.write_all(b"250-fake.test\r\n250 STARTTLS\r\n");
                                } else if l.starts_with("STARTTLS") {
                                    if silent_after == "starttls" {
                                        return;
                                    }
                                    let _ = w.write_all(b"220 Ready to start TLS\r\n");
                                } else if l.starts_with("QUIT") {
                                    let _ = w.write_all(b"221 bye\r\n");
                                    return;
                                }
                            }
                        });
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
        });
        (port, stop)
    }

    /// A mail server that does not speak TLS on its IMAP port: greets in plain text, knows no STARTTLS, answers every command with BAD.
    fn plain_imap_server() -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                    let mut w = conn.try_clone().unwrap();
                    let _ = w.write_all(b"* OK plain IMAP ready\r\n");
                    let mut r = &conn;
                    let (mut buf, mut chunk) = (Vec::<u8>::new(), [0u8; 4096]);
                    loop {
                        match r.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                        if buf.iter().any(|b| !matches!(b, b'\r' | b'\n' | b'\t' | 0x20..=0x7e)) {
                            break;
                        }
                        while let Some(end) = buf.iter().position(|b| *b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=end).collect();
                            let tag = String::from_utf8_lossy(&line).split_whitespace().next().unwrap_or("*").to_string();
                            if w.write_all(format!("{tag} BAD command not recognized\r\n").as_bytes()).is_err() {
                                return;
                            }
                        }
                    }
                    let _ = conn.shutdown(std::net::Shutdown::Both);
                });
            }
        });
        port
    }

    fn memory_db() -> crate::Db {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        std::sync::Arc::new(std::sync::Mutex::new(c))
    }

    fn account_rows(db: &crate::Db) -> i64 {
        crate::lock(db).query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap()
    }

    fn input(imap_port: u16, imap_ssl: bool, smtp_port: u16, smtp_security: &str) -> crate::AccountInput {
        crate::AccountInput {
            email: "qa@example.test".into(),
            display_name: "QA".into(),
            imap_host: "127.0.0.1".into(),
            imap_port,
            imap_ssl,
            smtp_host: "127.0.0.1".into(),
            smtp_port,
            smtp_security: smtp_security.into(),
            username: "qa".into(),
            smtp_username: String::new(),
            tls_insecure: true,
        }
    }

    /// QA v1.0.1 round 2, BUG-1: an SMTP server that cannot be secured (a plain port or a silent one, with SSL/TLS or STARTTLS) gets the
    /// secure connection hint and no account is stored, whatever the security mode and whether the SMTP login is shared or separate.
    /// The IMAP login is stood in for by a check that passes: the point is what the SMTP side does to the add.
    #[test]
    fn add_account_with_an_smtp_server_that_cannot_be_secured_saves_nothing() {
        crate::test_guard::within(120, || {
            let plain = plain_smtp_server();
            let (silent, _keep_open) = silent_server();
            let (silent_after_greeting, _k1) = starttls_smtp_server("greeting");
            let (silent_after_ehlo, _k2) = starttls_smtp_server("ehlo");
            let (silent_after_starttls_request, _k3) = starttls_smtp_server("starttls");
            let short = std::time::Duration::from_secs(2);
            let imap_ok = |_: &Account, _: &str| -> R<()> { Ok(()) };
            let smtp_check = |a: &Account, s: &str| test_with(a, s, short);
            let db = memory_db();
            let mut cases: Vec<(&str, u16, &str)> = vec![];
            for security in ["ssl", "starttls"] {
                cases.push(("plain port", plain, security));
                cases.push(("silent port", silent, security));
            }
            cases.push(("silent after the greeting", silent_after_greeting, "starttls"));
            cases.push(("silent after EHLO", silent_after_ehlo, "starttls"));
            cases.push(("silent after the STARTTLS request", silent_after_starttls_request, "starttls"));
            for (what, port, security) in cases {
                for (login, smtp_pw) in [("shared", None), ("separate", Some("smtp-secret".to_string()))] {
                    let t = std::time::Instant::now();
                    let e = crate::add_account_with(&db, input(1, true, port, security), "secret", smtp_pw, &imap_ok, &smtp_check)
                        .expect_err(&format!("{what}, {security}, {login} login: the add must be refused"));
                    assert!(crate::mail::is_secure_connection_error(&e), "{what}, {security}, {login} login: {e}");
                    assert!(e.contains(&format!("127.0.0.1:{port}")), "{what}, {security}, {login} login: {e}");
                    assert!(t.elapsed() < std::time::Duration::from_secs(15), "{what}, {security}, {login} login took {:?}", t.elapsed());
                    assert_eq!(account_rows(&db), 0, "{what}, {security}, {login} login: an account row was left behind");
                }
            }
        });
    }

    /// An IMAP server that greets and answers CAPABILITY and the STARTTLS request like one that supports STARTTLS (it cannot do the TLS
    /// part), except that it falls silent after `silent_after` (greeting, capability or starttls); "never" does not.
    fn starttls_imap_server(silent_after: &'static str) -> (u16, std::sync::mpsc::Sender<()>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, gone) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            while !matches!(gone.try_recv(), Err(std::sync::mpsc::TryRecvError::Disconnected)) {
                match listener.accept() {
                    Ok((c, _)) => {
                        let _ = c.set_nonblocking(false);
                        let mut w = c.try_clone().unwrap();
                        let r = c.try_clone().unwrap();
                        held.push(c);
                        std::thread::spawn(move || {
                            let _ = w.write_all(b"* OK [CAPABILITY IMAP4rev1 STARTTLS] fake ready\r\n");
                            if silent_after == "greeting" {
                                return;
                            }
                            for line in BufReader::new(r).lines().map_while(Result::ok) {
                                let mut words = line.split_whitespace();
                                let (tag, cmd) = (words.next().unwrap_or("*").to_string(), words.next().unwrap_or("").to_uppercase());
                                match cmd.as_str() {
                                    "CAPABILITY" => {
                                        if silent_after == "capability" {
                                            return;
                                        }
                                        let _ = w.write_all(format!("* CAPABILITY IMAP4rev1 STARTTLS\r\n{tag} OK done\r\n").as_bytes());
                                    }
                                    "STARTTLS" => {
                                        if silent_after == "starttls" {
                                            return;
                                        }
                                        let _ = w.write_all(format!("{tag} OK Begin TLS negotiation now\r\n").as_bytes());
                                    }
                                    "LOGOUT" => return,
                                    _ => {}
                                }
                            }
                        });
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
        });
        (port, stop)
    }

    /// QA v1.0.1 round 3, BUG-2: the IMAP side of the add check. A plain port, and a silent one (no greeting, or silence after the
    /// greeting, after CAPABILITY or after the STARTTLS request), with SSL/TLS or STARTTLS, is refused with the secure connection hint
    /// within the probe time (here 2 s; 20 s in the app) and nothing is saved. Before, a silent STARTTLS server waited for the 60 s
    /// socket timeout and ended as "the mail server did not respond".
    #[test]
    fn add_account_with_an_imap_server_that_cannot_be_secured_saves_nothing() {
        crate::test_guard::within(120, || {
            let plain = plain_imap_server();
            let (silent, _keep_open) = silent_server();
            let (after_greeting, _k1) = starttls_imap_server("greeting");
            let (after_capability, _k2) = starttls_imap_server("capability");
            let (after_starttls, _k3) = starttls_imap_server("starttls");
            let db = memory_db();
            let probe_time = std::time::Duration::from_secs(2);
            let imap_login = move |acc: &Account, pw: &str| crate::imap_login_check(acc, pw, probe_time);
            let smtp_ok = |_: &Account, _: &str| -> R<()> { Ok(()) };
            let mut cases: Vec<(&str, u16, bool)> = vec![("plain port", plain, true), ("plain port", plain, false), ("silent port", silent, true), ("silent port", silent, false)];
            // these servers only talk STARTTLS, so they are tried with STARTTLS
            for (what, port) in [("silent after the greeting", after_greeting), ("silent after CAPABILITY", after_capability), ("silent after the STARTTLS request", after_starttls)] {
                cases.push((what, port, false));
            }
            std::thread::scope(|scope| {
                let mut runs = vec![];
                for (what, port, ssl) in cases {
                    let (db, imap_login, smtp_ok) = (&db, &imap_login, &smtp_ok);
                    runs.push((
                        what,
                        port,
                        ssl,
                        scope.spawn(move || {
                            let t = std::time::Instant::now();
                            (crate::add_account_with(db, input(port, ssl, 1, "ssl"), "secret", None, imap_login, smtp_ok), t.elapsed())
                        }),
                    ));
                }
                for (what, port, ssl, run) in runs {
                    let (result, took) = run.join().unwrap();
                    let e = result.expect_err(&format!("{what}, imap ssl={ssl}: the add must be refused"));
                    assert!(crate::mail::is_secure_connection_error(&e), "{what}, imap ssl={ssl}: {e}");
                    assert!(e.contains(&format!("127.0.0.1:{port}")), "{what}, imap ssl={ssl}: {e}");
                    assert!(took < std::time::Duration::from_secs(15), "{what}, imap ssl={ssl} took {took:?}");
                }
            });
            assert_eq!(account_rows(&db), 0, "an account row was left behind");
        });
    }

    /// The IMAP STARTTLS probe lets a server that answers through (here: up to the "Begin TLS" reply) pass at once, answers of a server
    /// that is not IMAP are left to the real connection, and a silent server is told apart. The SSL/TLS probe passes a port that
    /// refuses the handshake quickly (the real connection words that) and flags one that never answers.
    #[test]
    fn the_imap_probe_lets_a_cooperative_server_through_and_flags_a_silent_one() {
        crate::test_guard::within(60, || {
            let one_sec = std::time::Duration::from_secs(1);
            let mut acc = account();
            acc.imap_host = "127.0.0.1".into();
            acc.imap_ssl = false;
            let (coop, _k) = starttls_imap_server("never");
            acc.imap_port = coop;
            let t = std::time::Instant::now();
            assert!(crate::mail::probe_secure_connection(&acc, std::time::Duration::from_secs(5)).is_ok());
            assert!(t.elapsed() < std::time::Duration::from_secs(3), "{:?}", t.elapsed());
            // a plain server saying BAD is the real connection's to word
            acc.imap_port = plain_imap_server();
            assert!(crate::mail::probe_secure_connection(&acc, one_sec).is_ok());
            // so is a port nothing listens on (Windows takes about 2 s to refuse a local connection, so a longer time than the others)
            acc.imap_port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            assert!(crate::mail::probe_secure_connection(&acc, std::time::Duration::from_secs(8)).is_ok());
            let (silent, _k2) = silent_server();
            acc.imap_port = silent;
            let e = crate::mail::probe_secure_connection(&acc, one_sec).unwrap_err();
            assert!(crate::mail::is_secure_connection_error(&e) && e.contains("STARTTLS"), "{e}");
            acc.imap_ssl = true;
            let e = crate::mail::probe_secure_connection(&acc, one_sec).unwrap_err();
            assert!(crate::mail::is_secure_connection_error(&e) && e.contains("TLS handshake"), "{e}");
            acc.imap_port = plain_imap_server();
            assert!(crate::mail::probe_secure_connection(&acc, std::time::Duration::from_secs(5)).is_ok());
        });
    }

    /// A server that does secure its connection (here: up to the "220 Ready to start TLS" reply) is not held up by the STARTTLS probe,
    /// a connection that is not asked to use STARTTLS is not probed at all, and a silent server is told apart.
    #[test]
    fn the_starttls_probe_lets_a_cooperative_server_through() {
        crate::test_guard::within(60, || {
            let (port, _keep_open) = starttls_smtp_server("never");
            let mut acc = account();
            acc.smtp_host = "127.0.0.1".into();
            acc.smtp_port = port;
            acc.smtp_security = "starttls".into();
            assert!(probe_starttls(&acc, std::time::Duration::from_secs(5)).is_ok());
            let (silent, _k) = silent_server();
            acc.smtp_port = silent;
            acc.smtp_security = "none".into();
            assert!(probe_starttls(&acc, std::time::Duration::from_secs(1)).is_ok());
            acc.smtp_security = "starttls".into();
            assert!(matches!(probe_starttls(&acc, std::time::Duration::from_secs(1)), Err(Probe::Silent(_))));
        });
    }
}
