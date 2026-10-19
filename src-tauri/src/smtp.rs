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

/// The message a new one answers or forwards (W2.22 CF-18). After the new message was really sent (the Undo time is over, a scheduled one is due) the original
/// gets `\Answered` (Reply, Reply all) or `$Forwarded` (Forward) on its own server. It travels in the send payload, in the outbox row of a scheduled message
/// and, in the private header `X-HeyLook-Answers` (`kind account-id message-id`), in a saved draft, so a reply that is sent later still flags.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Answers {
    /// `answered` or `forwarded`
    pub kind: String,
    /// the account the original is in (not necessarily the one the answer is sent from)
    pub account_id: String,
    /// the Message-ID header of the original, with its angle brackets
    pub message_id: String,
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
    /// Outlook's Importance: High / Low add the importance headers (see importance.rs); Normal adds none. Old queued items have no field.
    #[serde(default)]
    pub importance: crate::importance::Importance,
    /// Only for a DRAFT: the id of the crash-recovery snapshot of the message. It is written at the start of the draft's Message-ID, which is how the
    /// next start finds the draft of a snapshot instead of making a second one (recover.rs). Never part of a message that is sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_id: Option<String>,
    /// Only for a DRAFT: the meeting switch of Compose as the interface wrote it (base64url JSON, see src/meetingDraft.ts). It goes into the private header
    /// `X-HeyLook-Meeting` of the draft so that a reopened draft shows its meeting again (v1.0.6 QA round 3 BUG-R3-4). Never part of a message that is sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_form: Option<String>,
    /// The message this one answers or forwards: it gets its server flag once this one is sent (see `Answers`). Old queued items have no field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<Answers>,
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

/// The four importance headers (lettre has no typed header for them).
macro_rules! importance_header {
    ($t:ident, $name:literal) => {
        #[derive(Clone)]
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
importance_header!(ImportanceH, "Importance");
importance_header!(XPriorityH, "X-Priority");
importance_header!(PriorityH, "Priority");
importance_header!(XMsMailPriorityH, "X-MSMail-Priority");

/// Add the importance headers of `level` (nothing for Normal). The names and values come from `importance::Importance::headers`.
fn importance_headers(mut b: lettre::message::MessageBuilder, level: crate::importance::Importance) -> lettre::message::MessageBuilder {
    for (name, value) in level.headers() {
        let v = value.to_string();
        b = match *name {
            "Importance" => b.header(ImportanceH(v)),
            "X-Priority" => b.header(XPriorityH(v)),
            "Priority" => b.header(PriorityH(v)),
            _ => b.header(XMsMailPriorityH(v)),
        };
    }
    b
}

/// Header text that comes from received data (the subject of a reply, the names of the people answered): a line break, a tab and the other white-space
/// separators become one space each (CR LF counts once), every other control character (C0, DEL, C1) is dropped. Nothing else changes (spaces, case and
/// order stay: the subject decodes to exactly what the person sees). lettre encodes a raw CR LF inside an RFC 2047 word instead of refusing it, so there is no
/// header injection without this, but the decoded text would still have two lines (QA round 2 BUG-1). The front end cleans the same way where an answer is made
/// (src/headerText.ts); this is the defence at the point where the MIME is built.
pub fn clean_header_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\r' if it.peek() == Some(&'\n') => {
                it.next();
                out.push(' ');
            }
            '\r' | '\n' | '\t' | '\u{b}' | '\u{c}' | '\u{85}' | '\u{2028}' | '\u{2029}' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
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

/// The address with its domain in the ASCII form (`user@bücher.example` -> `user@xn--bcher-kva.example`): lettre accepts an
/// internationalized domain but writes it as it is, and a server without SMTPUTF8 refuses that in RCPT TO and in the headers. A domain
/// that cannot be converted, or is ASCII already, stays as it is (lettre then judges it).
pub fn ascii_address(email: &str) -> String {
    match email.rsplit_once('@') {
        Some((user, domain)) if !domain.is_ascii() => match idna::domain_to_ascii(domain) {
            Ok(d) if !d.is_empty() => format!("{user}@{d}"),
            _ => email.to_string(),
        },
        _ => email.to_string(),
    }
}

/// The address of an account as lettre holds it (ASCII domain).
fn account_address(acc: &Account) -> R<Address> {
    ascii_address(acc.email.trim()).parse::<Address>().map_err(err)
}

/// The Reply-To of mail sent from `acc` (1.0.7 W2.21): the mailbox's own setting (an IDN domain in its ASCII form, like every address), none when
/// it is empty or the mailbox's own address (a reply would go there anyway).
fn reply_to_of(acc: &Account) -> Option<Mailbox> {
    let addr = ascii_address(acc.reply_to.trim()).parse::<Address>().ok()?;
    let me = account_address(acc).ok()?;
    (!addr.to_string().eq_ignore_ascii_case(&me.to_string())).then(|| Mailbox::new(None, addr))
}

/// A Reply-To as the setting stores it: empty, or ONE bare address (no name part, no list). The same rule as the field in Settings.
pub fn check_reply_to(text: &str) -> R<String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    let bad = || "EMAIL_INVALID: Enter a valid email address".to_string();
    if t.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | ',' | ';' | '"' | '(' | ')')) {
        return Err(bad());
    }
    ascii_address(t).parse::<Address>().map_err(|_| bad())?;
    Ok(t.to_string())
}

/// Parse a recipient as the interface writes it. Unlike a strict RFC 5322 parse this accepts any display name, and still
/// rejects an address that is not one.
pub fn parse_mailbox(s: &str) -> R<Mailbox> {
    let (name, email) = split_mailbox(s);
    let addr = ascii_address(&email).parse::<Address>().map_err(|e| format!("bad address '{s}': {e}"))?;
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
raw_recipients!(RawMeeting, "X-HeyLook-Meeting");
raw_recipients!(RawAnswers, "X-HeyLook-Answers");

/// `lenient`: for a DRAFT. A draft is saved as it is: no recipient, a half-typed one, an empty subject all save. lettre derives the
/// SMTP envelope from the recipient headers and refuses a message without one ("missing destination address, invalid envelope"), so
/// a draft gets an explicit envelope (from the account to the account; it is never sent, the envelope is not part of the text) and
/// recipients that are not valid addresses are written as typed. A message that is SENT is built strict (`lenient = false`).
/// `<random@domain-of-the-account>`: no host name of this computer is written into the draft.
/// A draft of a message that has a crash-recovery snapshot starts it with the snapshot's id (`recover::draft_message_id`).
fn draft_message_id(email: &str, recovery_id: Option<&str>) -> String {
    let domain = email.rsplit_once('@').map(|(_, d)| d.trim()).filter(|d| !d.is_empty()).unwrap_or("heylook.invalid");
    crate::recover::draft_message_id(recovery_id, domain, chrono::Utc::now().timestamp())
}

/// `<random@domain-of-the-account>` for a message that is SENT: the Message-ID is made here, not left to lettre (which writes the name of this
/// computer into it) or to the server (the Sent copy would not know it, and a reply to your own mail would have nothing to answer). The same
/// bytes go to the server and into the Sent folder, so the copy carries the same id. The domain is the account's own address domain (as lettre
/// holds it: an internationalized domain in its ASCII form), never `localhost` or a host name.
fn sent_message_id(me: &Address) -> String {
    format!("<{}@{}>", uuid::Uuid::new_v4().simple(), me.domain())
}

fn headers(acc: &Account, d: &Draft, lenient: bool) -> R<lettre::message::MessageBuilder> {
    let me = account_address(acc)?;
    let from = Mailbox::new(Some(clean_header_text(&acc.display_name)).filter(|n| !n.is_empty()), me.clone());
    let mut b = Message::builder().from(from).subject(clean_header_text(&d.subject));
    if let Some(rt) = reply_to_of(acc) {
        b = b.reply_to(rt);
    }
    if lenient {
        // A draft carries its own Message-ID: the sync derives the draft's thread from it, so Save draft can tell the app which thread the
        // draft will be (an "Edit" action can open it again). Mail that is sent keeps getting its Message-ID from the server.
        b = b.message_id(Some(draft_message_id(&acc.email, d.recovery_id.as_deref())));
        b = b.envelope(lettre::address::Envelope::new(Some(me.clone()), vec![me]).map_err(err)?);
        // The Bcc header stays in the DRAFT copy (QA round 17 BUG-01: lettre drops it by default, so a saved draft lost its Bcc recipients and
        // sending the reopened draft silently skipped them). It is only the person's own Drafts folder; a message that is SENT is built below
        // without it (the SMTP envelope carries the Bcc recipients, the message must not name them).
        b = b.keep_bcc();
        // the meeting of the message (a private header, DRAFT copies only: `headers(.., false)`, the one a message is sent with, never writes it)
        if let Some(blob) = d.meeting_form.as_deref().and_then(crate::draftmail::meeting_blob) {
            b = b.header(RawMeeting(crate::draftmail::meeting_header_value(&blob)));
        }
        // the message this one answers or forwards (a private header, DRAFT copies only): a reply that is sent from the reopened draft still flags it
        if let Some(a) = d.answers.as_ref().filter(|a| crate::draftmail::answers_valid(a)) {
            b = b.header(RawAnswers(crate::draftmail::answers_header_value(a)));
        }
        // each list: typed addresses when every entry is one, else the text as written
        let all_ok = |l: &[String]| l.iter().all(|t| parse_mailbox(t).is_ok());
        let raw = |l: &[String]| l.iter().map(|t| clean_header_text(t)).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(", ");
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
        b = b.message_id(Some(sent_message_id(&me)));
        // each address once, in the first field it is in (To, then Cc, then Bcc), whatever the case
        let (to, cc, bcc) = unique_recipients(d);
        for t in &to {
            b = b.to(mailbox(t)?);
        }
        for c in &cc {
            b = b.cc(mailbox(c)?);
        }
        for c in &bcc {
            b = b.bcc(mailbox(c)?);
        }
        // Bcc recipients only (Gmail and Outlook allow it): To says so, as RFC 5322 3.6.3 suggests. The envelope delivers the message; the
        // Bcc header itself is never written.
        if to.is_empty() && cc.is_empty() && !bcc.is_empty() {
            b = b.header(RawTo("undisclosed-recipients:;".to_string()));
            b = b.envelope(envelope_of(&me, d)?);
        }
    }
    // the ids come from the message answered: one token each, no white space or control character inside
    let id = |r: &str| clean_header_text(r).split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(r) = d.in_reply_to.as_deref().map(id).filter(|r| !r.is_empty()) {
        b = b.in_reply_to(r);
    }
    let refs: Vec<String> = d.references.iter().map(|r| id(r)).filter(|r| !r.is_empty()).collect();
    if !refs.is_empty() {
        b = b.references(refs.join(" "));
    }
    if d.confidential {
        b = b.header(Sensitivity("Company-Confidential".into()));
    }
    b = importance_headers(b, d.importance);
    Ok(b)
}

/// `s` with every line feed that does not follow a carriage return written as CR LF, in one pass. This is what lettre does to a text body
/// (`Body::new`), but lettre does it by inserting a `\r` into the string once per line (`String::insert` moves the rest of the text each time):
/// the armored text of an encrypted draft with pictures (27 MB, 400 000 lines) took minutes, and the time grew with the square of the size
/// (QA D-025: the app did not answer for half an hour). Text that has no such line feed is returned as it is.
fn crlf(s: String) -> String {
    let b = s.as_bytes();
    let bare = |i: usize| b[i] == b'\n' && (i == 0 || b[i - 1] != b'\r');
    let n = (0..b.len()).filter(|&i| bare(i)).count();
    if n == 0 {
        return s;
    }
    let mut out = Vec::with_capacity(b.len() + n);
    for i in 0..b.len() {
        if bare(i) {
            out.push(b'\r');
        }
        out.push(b[i]);
    }
    // (only ASCII bytes were added to valid UTF-8)
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// The body of a text part, the same bytes as `Body::new(text)` of lettre: the transfer encoding is chosen from the text as it is written (line
/// feeds only), then the line ends become CR LF and the text is encoded. Only the line-end step differs: `crlf` is linear.
fn text_body(text: String) -> Body {
    let encoding = match email_encoding::body::Encoding::choose(text.as_str(), false) {
        email_encoding::body::Encoding::SevenBit => ContentTransferEncoding::SevenBit,
        email_encoding::body::Encoding::EightBit => ContentTransferEncoding::EightBit,
        email_encoding::body::Encoding::QuotedPrintable => ContentTransferEncoding::QuotedPrintable,
        email_encoding::body::Encoding::Base64 => ContentTransferEncoding::Base64,
    };
    let text = crlf(text);
    match encoding {
        // (7bit / 8bit text is not changed by the encoding step, and `new_with_encoding` would choose again on the CR LF text, whose lines are one
        // character longer: a text that was just short enough for 7bit would be refused)
        ContentTransferEncoding::SevenBit | ContentTransferEncoding::EightBit | ContentTransferEncoding::Binary => Body::dangerous_pre_encoded(text.into_bytes(), encoding),
        _ => Body::new_with_encoding(text, encoding).unwrap_or_else(|b| Body::new(b)),
    }
}

fn html_part(html: String) -> SinglePart {
    SinglePart::builder().header(ContentType::TEXT_HTML).body(text_body(html))
}

fn plain_part(text: String) -> SinglePart {
    SinglePart::builder().header(ContentType::TEXT_PLAIN).body(text_body(text))
}

/// An attachment's bytes as they are, whatever the type. Without this lettre sends text files as 7bit / 8bit text and the
/// line endings become CRLF on the wire, so the saved file would differ from the original (checksum, diff, signatures).
fn exact_body(bytes: Vec<u8>) -> Body {
    Body::new_with_encoding(bytes, ContentTransferEncoding::Base64).unwrap_or_else(|b| Body::new(b))
}

/// The content: text/plain + text/html (+ related pictures), then the real attachments.
fn body(d: &Draft) -> R<MultiPart> {
    // the allow-list sanitiser (outgoing.rs) is the last step before the HTML becomes a MIME part: send, schedule, hold, outbox and drafts
    let html = html_part(crate::outgoing::clean_html(&d.html));
    let mut alt = if d.inline.is_empty() {
        MultiPart::alternative().singlepart(plain_part(d.text.clone())).singlepart(html)
    } else {
        let mut related = MultiPart::related().singlepart(html);
        for img in &d.inline {
            let bytes = base64::engine::general_purpose::STANDARD.decode(&img.data_base64).map_err(err)?;
            let ct = ContentType::parse(&img.mime).unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            related = related.singlepart(Attachment::new_inline_with_name(img.cid.clone(), crate::attach::outgoing_name(&img.filename)).body(bytes, ct));
        }
        MultiPart::alternative().singlepart(plain_part(d.text.clone())).multipart(related)
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
    // file names are cleaned when the MIME is built (attach::outgoing_name): no folder, no control or hidden characters, a length that fits
    let names = crate::attach::outgoing_names(&d.attachments.iter().map(|a| a.filename.clone()).collect::<Vec<_>>());
    for (a, name) in d.attachments.iter().zip(names) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&a.data_base64).map_err(err)?;
        let ct = ContentType::parse(&a.mime).unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
        mixed = mixed.singlepart(Attachment::new(name.clone()).body(exact_body(bytes), ct));
    }
    Ok(mixed)
}

/// The text/calendar part of an iMIP message.
pub fn calendar_part(method: &str, ics: &str) -> R<SinglePart> {
    let ct = ContentType::parse(&format!("text/calendar; charset=UTF-8; method={method}")).map_err(err)?;
    Ok(SinglePart::builder().header(ct).body(text_body(ics.to_string())))
}

/// A small iMIP message (reply, update or cancellation): readable text plus the calendar part, from the account to the recipients.
pub fn build_calendar_mail(acc: &Account, to: &[String], cc: &[String], subject: &str, text: &str, cal: &CalendarPart) -> R<Message> {
    let me = account_address(acc)?;
    let from = Mailbox::new(Some(clean_header_text(&acc.display_name)).filter(|n| !n.is_empty()), me.clone());
    let mut b = Message::builder().from(from).subject(clean_header_text(subject)).message_id(Some(sent_message_id(&me)));
    if let Some(rt) = reply_to_of(acc) {
        b = b.reply_to(rt);
    }
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

/// The finished message as it goes on the wire and into the Sent / Drafts folder: lettre's text with the lines of the header block and of every
/// part's header block folded to 78 characters (headerfold.rs; lettre leaves a long To / Cc / References list or media type on one line).
pub fn wire(m: &Message) -> Vec<u8> {
    crate::headerfold::fold(m.formatted())
}

/// multipart/signed (RFC 3156): the signature covers the content entity exactly as it is written, without the
/// line break that belongs to the next boundary line.
pub fn build_signed(acc: &Account, d: &Draft, lenient: bool, sign: &dyn Fn(&[u8]) -> R<(String, String)>) -> R<Message> {
    let inner = body(d)?;
    // the part headers are folded BEFORE the signature is made: `wire` folds the finished message the same way, so the signed bytes are the ones sent
    let mut bytes = crate::headerfold::fold(inner.formatted());
    if bytes.ends_with(b"\r\n") {
        bytes.truncate(bytes.len() - 2);
    }
    let (armored, micalg) = sign(&bytes)?;
    let sig = SinglePart::builder()
        .header(ContentType::parse("application/pgp-signature; name=\"signature.asc\"").map_err(err)?)
        .body(text_body(armored));
    let outer = MultiPart::signed("application/pgp-signature".to_string(), micalg).multipart(inner).singlepart(sig);
    headers(acc, d, lenient)?.multipart(outer).map_err(err)
}

/// multipart/encrypted (RFC 3156): a control part and the armored OpenPGP message.
pub fn build_encrypted(acc: &Account, d: &Draft, lenient: bool, encrypt: &dyn Fn(&[u8]) -> R<String>) -> R<Message> {
    // what is encrypted has its part headers folded as well (the finished message folds only what it shows: the two parts of the envelope)
    let armored = encrypt(&crate::headerfold::fold(body(d)?.formatted()))?;
    let control = SinglePart::builder().header(ContentType::parse("application/pgp-encrypted").map_err(err)?).body(String::from("Version: 1"));
    let data = SinglePart::builder()
        .header(ContentType::parse("application/octet-stream; name=\"encrypted.asc\"").map_err(err)?)
        .header(lettre::message::header::ContentDisposition::inline_with_name("encrypted.asc"))
        .body(text_body(armored));
    let outer = MultiPart::encrypted("application/pgp-encrypted".to_string()).singlepart(control).singlepart(data);
    headers(acc, d, lenient)?.multipart(outer).map_err(err)
}

/// The key two recipients are the same by: the address in lower case, its domain in the ASCII form (an upper / lower case spelling of the same
/// address is the same mailbox in every mail system in use; keeping both would send it twice). Text that is not an address is its own key.
fn recipient_key(entry: &str) -> String {
    ascii_address(&split_mailbox(entry).1).to_lowercase()
}

/// To, Cc and Bcc of a message that is SENT with every address once: an address that is already in To is not repeated in To, Cc or Bcc,
/// one in Cc not in Cc or Bcc, and the first spelling stays (`Ann@X.test` then `ann@x.test` is one recipient written `Ann@X.test`).
fn unique_recipients(d: &Draft) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    let mut take = |l: &[String]| l.iter().filter(|e| !e.trim().is_empty() && seen.insert(recipient_key(e))).cloned().collect::<Vec<_>>();
    let to = take(&d.to);
    let cc = take(&d.cc);
    let bcc = take(&d.bcc);
    (to, cc, bcc)
}

/// The envelope of a message from `from` to every recipient (To, Cc, Bcc) of the draft, each address once.
fn envelope_of(from: &Address, d: &Draft) -> R<lettre::address::Envelope> {
    let (to_l, cc_l, bcc_l) = unique_recipients(d);
    let mut to: Vec<Address> = vec![];
    for r in to_l.iter().chain(cc_l.iter()).chain(bcc_l.iter()) {
        to.push(mailbox(r)?.email);
    }
    lettre::address::Envelope::new(Some(from.clone()), to).map_err(err)
}

/// Addresses of every recipient (To, Cc, Bcc) of a draft, for sending a prebuilt message.
pub fn envelope(acc: &Account, d: &Draft) -> R<lettre::address::Envelope> {
    envelope_of(&account_address(acc)?, d)
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

/// What this program calls itself in EHLO: the address literal `[127.0.0.1]`. lettre's default is the name of this computer (a privacy leak:
/// "NamPC" in the Received header of every message, and a spam signal). RFC 5321 4.1.4 asks for a fully qualified name or, when the client
/// has none (a desktop behind NAT has no name of its own), an address literal. The account's domain is not used: a server may refuse a
/// client that claims to be its own domain or somebody else's, and the literal says nothing about the person or the computer. Thunderbird
/// also sends a literal. It is not configurable.
fn ehlo_name() -> lettre::transport::smtp::extension::ClientId {
    lettre::transport::smtp::extension::ClientId::Ipv4(std::net::Ipv4Addr::new(127, 0, 0, 1))
}

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
    let b = b.hello_name(ehlo_name()).credentials(Credentials::new(smtp_user(acc), secret.to_string()));
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
        if out.write_all(format!("EHLO {}\r\n", ehlo_name()).as_bytes()).is_err() {
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

/// A finished message as the SMTP DATA command carries it, and the copy to keep. lettre ends the data with CRLF "." CRLF, which supplies the
/// line break after the last line, so a message that already ends with one would gain an empty line: the message is handed over without that
/// last line break (`wire`), and the copy for the Sent folder is the bytes the server receives (`copy`, QA round 17 BUG-19: the Sent copy was
/// two bytes shorter than the DATA that was sent).
pub fn as_data(raw: &[u8]) -> (&[u8], Vec<u8>) {
    let wire = raw.strip_suffix(b"\r\n").unwrap_or(raw);
    let mut copy = Vec::with_capacity(wire.len() + 2);
    copy.extend_from_slice(wire);
    copy.extend_from_slice(b"\r\n");
    (wire, copy)
}

/// The date of a header as RFC 5322 writes it ("Mon, 19 Oct 2026 08:00:00 +0700").
pub fn rfc5322_date(at: chrono::DateTime<chrono::FixedOffset>) -> String {
    at.format("%a, %d %b %Y %H:%M:%S %z").to_string()
}

/// The message with its top-level `Date:` header set to `at` (1.0.7 W2.22 CF-24). A scheduled message that is signed or encrypted is built when it is
/// scheduled (`pgpstore::seal_for_outbox`), so it would go out with the date of the day it was scheduled on; this puts the time of the send in. Only the
/// header block of the message itself is read and rewritten: everything after it (the PGP/MIME signature covers the part below the headers, never
/// these) is returned byte for byte. A message without a `Date:` header is returned as it is.
pub fn restamp_date(raw: &[u8], at: chrono::DateTime<chrono::FixedOffset>) -> Vec<u8> {
    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 2).unwrap_or(raw.len());
    let (head, rest) = raw.split_at(head_end);
    let mut out = Vec::with_capacity(raw.len() + 16);
    let mut replaced = false;
    let mut i = 0;
    while i < head.len() {
        // one header: its first line and the folded lines that follow (they start with a space or a tab)
        let mut end = head[i..].windows(2).position(|w| w == b"\r\n").map(|p| i + p + 2).unwrap_or(head.len());
        while end < head.len() && (head[end] == b' ' || head[end] == b'\t') {
            end = head[end..].windows(2).position(|w| w == b"\r\n").map(|p| end + p + 2).unwrap_or(head.len());
        }
        let line = &head[i..end];
        if !replaced && line.len() >= 5 && line[..5].eq_ignore_ascii_case(b"date:") {
            out.extend_from_slice(format!("Date: {}\r\n", rfc5322_date(at)).as_bytes());
            replaced = true;
        } else {
            out.extend_from_slice(line);
        }
        i = end;
    }
    out.extend_from_slice(rest);
    out
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
pub(crate) mod tests {
    use super::*;

    pub(crate) fn account() -> Account {
        account_with_id("a1")
    }

    pub(crate) fn account_with_id(id: &str) -> Account {
        Account {
            id: id.into(),
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
            reply_to: String::new(),
        }
    }

    pub(crate) fn draft(html: &str, inline: Vec<InlineImage>, attachments: Vec<Att>) -> Draft {
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
            importance: Default::default(),
            recovery_id: None,
            meeting_form: None,
            answers: None,
        }
    }

    /// D-025: `text_body` is lettre's `Body::new` with a linear line-end step: the same transfer encoding and the same bytes for every kind of text
    /// (7bit, quoted-printable and base64 are each chosen for some of these; the lines of 74 to 77 characters are where the CR LF can change the choice).
    #[test]
    fn text_body_is_the_same_as_lettres_body_new() {
        let long = |n: usize| "x".repeat(n);
        let mut cases: Vec<String> = vec![
            "".into(), "a".into(), "\n".into(), "\n\n".into(), "\r\n".into(), "\r".into(), "a\rb".into(), "a\nb".into(), "a\r\nb\n".into(), "a\n\r\nb\r\n\n".into(),
            "\n\r\n\n".into(), "é\n".into(), "héllo\nwörld\n".into(), "日本語\n日本語\n".into(), "<p>a</p>\n<p>b</p>\n".into(), "no end".into(), "ends\n".into(),
            "ends\r\n".into(), "\r\r\n\n\n".into(),
        ];
        for n in [60, 73, 74, 75, 76, 77, 78, 200, 1000] {
            cases.push(format!("{}\n{}\n", long(n), long(n)));
            cases.push(format!("{}\r\n{}\r\n", long(n), long(n)));
            cases.push(format!("{}", long(n)));
            cases.push(format!("é{}\n{}\n", long(n), long(n)));
            cases.push(format!("{}\n", "é".repeat(n)));
            cases.push(format!("{}\n", "日".repeat(n)));
        }
        // armor shaped: lines of 64 characters with LF (what the encrypted part is)
        cases.push((0..300).map(|i| format!("{}\n", base64::engine::general_purpose::STANDARD.encode([i as u8; 48]))).collect());
        cases.push(format!("-----BEGIN PGP MESSAGE-----\n\n{}=abcd\n-----END PGP MESSAGE-----\n", (0..50).map(|i| format!("{}\n", base64::engine::general_purpose::STANDARD.encode([i as u8; 48]))).collect::<String>()));
        for s in cases {
            let want = Body::new(s.clone());
            let got = text_body(s.clone());
            assert_eq!(got.encoding(), want.encoding(), "encoding of {s:?}");
            assert_eq!(got.as_ref(), want.as_ref(), "bytes of {s:?}");
        }
    }

    /// D-025: the whole message of a draft with text, pictures and files is the same as lettre's own writing of it, and a big armored part is fast
    /// (it took minutes: lettre inserted a `\r` into the string once per line).
    #[test]
    fn a_big_text_part_is_converted_in_linear_time() {
        let lines = 400_000;
        let armored: String = (0..lines).map(|i| format!("{}\n", base64::engine::general_purpose::STANDARD.encode([(i % 251) as u8; 48]))).collect();
        assert!(armored.len() >= 26_000_000);
        let t0 = std::time::Instant::now();
        let b = text_body(armored.clone());
        let took = t0.elapsed();
        assert_eq!(b.as_ref().len(), armored.len() + lines);
        assert_eq!(b.encoding(), ContentTransferEncoding::SevenBit);
        assert!(took < std::time::Duration::from_secs(5), "27 MB of armor took {took:?}");
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

    fn at(s: &str) -> chrono::DateTime<chrono::FixedOffset> {
        chrono::DateTime::parse_from_rfc2822(s).unwrap()
    }

    /// 1.0.7 W2.22 CF-24: only the Date of the message's own header block is replaced; everything else is byte for byte what it was.
    #[test]
    fn restamping_changes_the_date_header_and_nothing_else() {
        let raw = b"From: a@example.com\r\nDate: Mon, 12 Oct 2026 09:00:00 +0000\r\nSubject: Date: not this\r\nContent-Type: multipart/signed;\r\n boundary=\"b\"\r\n\r\n--b\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\nbody\r\n--b--\r\n";
        let out = restamp_date(raw, at("Fri, 16 Oct 2026 15:30:05 +0700"));
        let t = String::from_utf8(out.clone()).unwrap();
        assert!(t.starts_with("From: a@example.com\r\nDate: Fri, 16 Oct 2026 15:30:05 +0700\r\nSubject: Date: not this\r\n"), "{t}");
        // the part below the headers (what a signature covers) is untouched, a Date line inside it too
        let body_at = |b: &[u8]| b.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        assert_eq!(out[body_at(&out)..], raw[body_at(raw)..]);
        assert!(t.contains("\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\n\r\nbody"));
        // a folded Date goes whole, the headers after it stay
        let folded = b"Date: Mon, 12 Oct\r\n 2026 09:00:00 +0000\r\nTo: b@example.com\r\n\r\nx";
        assert_eq!(String::from_utf8(restamp_date(folded, at("Fri, 16 Oct 2026 15:30:05 +0000"))).unwrap(), "Date: Fri, 16 Oct 2026 15:30:05 +0000\r\nTo: b@example.com\r\n\r\nx");
        // lower case name; no Date header: as it is
        assert!(String::from_utf8(restamp_date(b"date: x\r\n\r\n", at("Fri, 16 Oct 2026 15:30:05 +0000"))).unwrap().starts_with("Date: Fri, 16 Oct 2026 15:30:05 +0000\r\n"));
        assert_eq!(restamp_date(b"To: b@example.com\r\n\r\nDate: x\r\n", at("Fri, 16 Oct 2026 15:30:05 +0000")), b"To: b@example.com\r\n\r\nDate: x\r\n");
        // a message built here parses back with the new date
        let built = wire(&build(&account(), &draft("<p>Hi</p>", vec![], vec![])).unwrap());
        let stamped = restamp_date(&built, at("Fri, 16 Oct 2026 15:30:05 +0700"));
        let parsed = mail_parser::MessageParser::default().parse(&stamped).unwrap();
        assert_eq!(parsed.date().map(|d| d.to_timestamp()), Some(at("Fri, 16 Oct 2026 15:30:05 +0700").timestamp()));
    }

    /// W2.22 CF-18: the private header of a draft carries the message it answers (never a message that is sent); a bad value is not read back.
    #[test]
    fn a_draft_names_the_message_it_answers_and_a_sent_message_does_not() {
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.answers = Some(Answers { kind: "answered".into(), account_id: "acc-1".into(), message_id: "<orig@example.org>".into() });
        let saved = String::from_utf8(wire(&build_draft(&account(), &d).unwrap())).unwrap();
        assert!(saved.contains("X-HeyLook-Answers: answered acc-1 <orig@example.org>"), "{saved}");
        let back = crate::draftmail::recipients(saved.as_bytes()).answers;
        assert_eq!(back, d.answers);
        let sent = String::from_utf8(wire(&build(&account(), &d).unwrap())).unwrap();
        assert!(!sent.to_lowercase().contains("x-heylook-answers"), "{sent}");
        // not ours: nothing is written, nothing is read
        for bad in [("answered", "a b", "<x@y>"), ("replied", "a", "<x@y>"), ("answered", "a", "x@y"), ("forwarded", "a", "<x y@z>")] {
            d.answers = Some(Answers { kind: bad.0.into(), account_id: bad.1.into(), message_id: bad.2.into() });
            assert!(!String::from_utf8(wire(&build_draft(&account(), &d).unwrap())).unwrap().contains("X-HeyLook-Answers"), "{bad:?}");
        }
        assert_eq!(crate::draftmail::answers_from_header("answered a <x@y> extra"), None);
        // the send payload (the outbox row) keeps it, with the camelCase names the page uses, and an old row has none
        d.answers = Some(Answers { kind: "forwarded".into(), account_id: "acc-1".into(), message_id: "<orig@example.org>".into() });
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains(r#""answers":{"kind":"forwarded","accountId":"acc-1","messageId":"<orig@example.org>"}"#), "{json}");
        assert_eq!(serde_json::from_str::<Draft>(&json).unwrap().answers, d.answers);
        let mut plain = serde_json::to_value(draft("<p>Hi</p>", vec![], vec![])).unwrap();
        plain.as_object_mut().unwrap().remove("answers");
        assert!(serde_json::from_value::<Draft>(plain).unwrap().answers.is_none());
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

    /// QA round 17, BUG-15 (CF-28 / B-17): Gmail and Outlook send a message that has only Bcc recipients; so does this.
    #[test]
    fn a_message_with_only_bcc_recipients_can_be_sent() {
        let acc = account();
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.to.clear();
        d.bcc = vec!["Hidden <hidden@example.org>".into(), "other@example.org".into()];
        let msg = build(&acc, &d).expect("Bcc only is built");
        let raw = msg.formatted();
        let out = String::from_utf8_lossy(&raw).into_owned();
        // delivered to every Bcc address, from the account
        let rcpt: Vec<String> = msg.envelope().to().iter().map(|a| a.to_string()).collect();
        assert_eq!(rcpt, vec!["hidden@example.org", "other@example.org"]);
        assert_eq!(msg.envelope().from().map(|a| a.to_string()).as_deref(), Some("me@example.com"));
        // nobody sees the Bcc addresses; To says the recipients are not disclosed
        assert!(!out.to_ascii_lowercase().contains("bcc:") && !out.contains("hidden@example.org") && !out.contains("other@example.org"), "{out}");
        assert!(out.contains("To: undisclosed-recipients:;"), "{out}");
        let p = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
        assert!(p.bcc().is_none());
        assert_eq!(p.to().map(|a| a.iter().filter(|x| x.address.is_some()).count()), Some(0), "no address in To");
        assert!(crate::mail::parse(1, &raw, true, false, 0).unwrap().to.is_empty());
        // the prebuilt-message route has the same envelope
        assert_eq!(envelope(&acc, &d).unwrap().to().len(), 2);
        // Cc only: Cc is shown, there is no To header
        let mut cc_only = draft("<p>Hi</p>", vec![], vec![]);
        cc_only.to.clear();
        cc_only.cc = vec!["cc@example.org".into()];
        let out = text(&build(&acc, &cc_only).unwrap());
        assert!(out.contains("Cc: cc@example.org") && !out.contains("
To:") && !out.contains("undisclosed"), "{out}");
        // Bcc together with To: To is the visible one, no placeholder
        let mut both = draft("<p>Hi</p>", vec![], vec![]);
        both.bcc = vec!["hidden@example.org".into()];
        let m = build(&acc, &both).unwrap();
        assert!(!text(&m).contains("undisclosed") && !text(&m).contains("hidden@example.org"));
        assert_eq!(m.envelope().to().len(), 2);
        // really no recipient: still refused
        let mut none = draft("<p>Hi</p>", vec![], vec![]);
        none.to.clear();
        assert!(build(&acc, &none).is_err());
        // a signed or encrypted message to Bcc recipients only is built the same way
        let mut s = d.clone();
        s.security = None;
        assert!(build_signed(&acc, &s, false, &|_| Ok(("sig".into(), "pgp-sha256".into()))).is_ok());
        assert!(build_encrypted(&acc, &s, false, &|_| Ok("armored".into())).is_ok());
    }

    /// QA round 17, BUG-20 (CF-17 / B-08): A@X.test and a@x.test were both kept, and an address in To and in Cc was sent twice.
    #[test]
    fn an_address_is_sent_to_once_whatever_its_case_and_the_field() {
        let acc = account();
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.to = vec!["Ann@X.test".into(), "ann@x.test".into(), "Bob <bob@y.test>".into(), "BOB@Y.TEST".into()];
        d.cc = vec!["ANN@x.test".into(), "cy@z.test".into(), "Cy <CY@z.test>".into()];
        d.bcc = vec!["cy@z.test".into(), "bob@Y.test".into(), "dee@w.test".into(), "dee@w.test".into()];
        let msg = build(&acc, &d).unwrap();
        let rcpt: Vec<String> = msg.envelope().to().iter().map(|a| a.to_string()).collect();
        assert_eq!(rcpt, vec!["Ann@X.test", "bob@y.test", "cy@z.test", "dee@w.test"], "one RCPT each, first spelling");
        let raw = msg.formatted();
        let p = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
        let addrs = |a: Option<&mail_parser::Address>| a.map(|a| a.iter().filter_map(|x| x.address.as_ref().map(|s| s.to_string())).collect::<Vec<_>>()).unwrap_or_default();
        assert_eq!(addrs(p.to()), vec!["Ann@X.test", "bob@y.test"], "one header entry each");
        assert_eq!(addrs(p.cc()), vec!["cy@z.test"]);
        assert!(p.bcc().is_none());
        assert!(!String::from_utf8_lossy(&raw).contains("dee@w.test"));
        // a Bcc address that is also in To is just in To; the envelope of a prebuilt message agrees
        assert_eq!(envelope(&acc, &d).unwrap().to().len(), 4);
        // a Bcc that repeats the only To address leaves a message with To and no Bcc
        let mut only = draft("<p>Hi</p>", vec![], vec![]);
        only.bcc = vec!["ANN@example.com".into()];
        let m = build(&acc, &only).unwrap();
        assert_eq!(m.envelope().to().len(), 1);
        assert!(!text(&m).contains("undisclosed"));
        // invalid entries are not merged into valid ones and still fail the send
        let mut bad = draft("<p>Hi</p>", vec![], vec![]);
        bad.to = vec!["ann@example.com".into(), "ann@".into()];
        assert!(build(&acc, &bad).is_err());
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

        // the message that is sent gets its own, new id (a_sent_message_carries_its_own_message_id)
        let sent = text(&build(&acc, &d).unwrap());
        assert_eq!(sent.to_ascii_lowercase().matches("message-id:").count(), 1, "{sent}");
    }

    /// QA round 17, BUG-14 (MA-12): a hundred recipients were one 2202-octet To line. The header block is folded at 78 characters, and
    /// still reads back as the same recipients.
    #[test]
    fn long_recipient_lists_and_reference_chains_are_folded_at_78_characters() {
        let acc = account();
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.to = (0..100).map(|i| format!("r13-{i:03}@example.test")).collect();
        d.cc = (0..30).map(|i| format!("\"Doe, John {i}\" <cc-{i:03}@example.test>")).collect();
        d.subject = "Báo cáo Q4 – 東京 🚀 Привет, a subject that is long enough to be folded by the encoder as well".into();
        d.references = (0..15).map(|i| format!("<ref-{i:02}-0123456789abcdef@mail.example.org>")).collect();
        d.in_reply_to = d.references.last().cloned();
        let msg = build(&acc, &d).unwrap();
        let raw = wire(&msg);
        let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8(raw[..head_end].to_vec()).expect("headers are ASCII");
        for l in head.split("\r\n") {
            assert!(l.len() <= 78, "{} octets: {l}", l.len());
        }
        assert!(head.is_ascii(), "{head}");
        // the folded message reads back as the same message
        let p = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
        assert_eq!(p.to().unwrap().iter().count(), 100);
        assert_eq!(p.cc().unwrap().iter().count(), 30);
        assert_eq!(p.cc().unwrap().first().and_then(|a| a.name.as_deref()), Some("Doe, John 0"), "a quoted name with a comma stays whole");
        assert_eq!(p.subject(), Some(d.subject.as_str()));
        let parsed = crate::mail::parse(3, &raw, true, false, 0).unwrap();
        assert_eq!(&parsed.refs[..15], &d.references[..], "References read back, each id whole and in order");
        assert_eq!(parsed.to.len(), 100);
        // the envelope is unaffected: 130 recipients, each once
        assert_eq!(msg.envelope().to().len(), 130);
        // the body is not touched
        assert!(String::from_utf8_lossy(&raw).contains("<p>Hi</p>"));
    }

    /// A header line is fine when it is at most 78 octets, or when it is a continuation line that holds one single token (an address or an
    /// encoded word) longer than 76 octets: that one cannot be cut and stands alone.
    fn assert_lines_fit(lines: &[String], what: &str) {
        for l in lines {
            let token = l.trim().trim_end_matches(',');
            assert!(l.len() <= 78 || (l.starts_with(' ') && !token.contains(' ') && token.len() > 76), "{what}: {} octets: {l}", l.len());
        }
    }

    /// W2.8: names of 10 to 70 characters, some with commas, quotes and backslashes, and an address of 90 characters: every header line is at most 78
    /// characters (an unbreakable token stands alone), unfolding gives the typed names back and the envelope is unchanged.
    #[test]
    fn long_quoted_names_and_a_long_address_are_folded_at_78_characters() {
        let acc = account();
        let words = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"];
        let mut names = vec![];
        for i in 0..100usize {
            let want = 10 + i * 60 / 99;
            let mut n = String::new();
            let mut k = i;
            while n.len() < want {
                if !n.is_empty() {
                    n.push(' ');
                }
                n.push_str(words[k % words.len()]);
                k += 3;
            }
            n.truncate(want);
            let n = n.trim_end().to_string();
            // pieces without white space at their ends: the reader keeps a double space as written only in some libraries
            let (h, t) = (n.len() / 2, n.len() / 3);
            let (a, b, c) = (n[..t].trim(), n[t..h].trim(), n[h..].trim());
            names.push(match i % 5 {
                1 => format!("{}, {}", n[..h].trim(), c),
                2 => format!("{a} \"{b}\" {c}"),
                3 => format!("{} \\ {c}", n[..h].trim()),
                _ => n,
            });
        }
        let typed = |name: &str, i: usize| format!("\"{}\" <q{i:03}@example.test>", name.replace('\\', "\\\\").replace('"', "\\\""));
        let long_addr = format!("<{}@{}.example.test>", "x".repeat(40), "h".repeat(34));
        assert_eq!(long_addr.len(), 90);
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.to = names.iter().enumerate().map(|(i, n)| typed(n, i)).collect();
        d.to.push(format!("Wide Address {long_addr}"));
        d.to.push(format!("{}@{}.example.test", "y".repeat(40), "h".repeat(34)));
        d.cc = names.iter().enumerate().take(40).map(|(i, n)| typed(n, 500 + i)).collect();
        let msg = build(&acc, &d).unwrap();
        let raw = wire(&msg);
        let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8(raw[..head_end].to_vec()).expect("headers are ASCII");
        let lines: Vec<String> = head.split("\r\n").map(String::from).collect();
        assert_lines_fit(&lines, "sent");
        assert!(lines.iter().any(|l| l.trim().trim_end_matches(',') == long_addr), "the 90-character address stands alone on its line: {head}");
        // the names read back as typed
        let p = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
        let got: Vec<Option<String>> = p.to().unwrap().iter().map(|a| a.name.as_deref().map(String::from)).collect();
        assert_eq!(got.len(), 102);
        for (i, n) in names.iter().enumerate() {
            assert_eq!(got[i].as_deref(), Some(n.as_str()), "name {i}");
        }
        assert_eq!(p.cc().unwrap().iter().count(), 40);
        for (i, a) in p.cc().unwrap().iter().enumerate() {
            assert_eq!(a.name.as_deref(), Some(names[i].as_str()), "cc name {i}");
        }
        // the envelope is the same as without folding: 102 To + 40 Cc recipients
        assert_eq!(msg.envelope().to().len(), 142);
        // a draft copy and a signed copy are folded the same way
        for (what, raw) in [("draft", wire(&build_draft(&acc, &d).unwrap())), ("signed", wire(&build_signed(&acc, &d, false, &signer).unwrap()))] {
            let he = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let lines: Vec<String> = String::from_utf8(raw[..he].to_vec()).unwrap().split("\r\n").map(String::from).collect();
            assert_lines_fit(&lines, what);
        }
    }

    /// Every physical header line of every part of a message (the top-level block and the block after each boundary line), with its place.
    fn header_lines_of_all_parts(raw: &[u8]) -> Vec<String> {
        let text = String::from_utf8_lossy(raw).into_owned();
        let (mut out, mut in_head) = (vec![], true);
        for l in text.split("\r\n") {
            if in_head {
                if l.is_empty() {
                    in_head = false;
                } else {
                    out.push(l.to_string());
                }
            } else if l.starts_with("--") {
                // a boundary line: a part header block follows (the closing boundary has no header block, but it is followed by the next
                // boundary or by the end, which holds no header-looking line)
                in_head = !l.ends_with("--");
            }
        }
        out
    }

    /// W2.9: an attachment name of 120 characters in Vietnamese and Japanese, a long ASCII one and a long media type: no header line of any part is over 78
    /// characters (a single token longer than that stands alone on its line), the name arrives unchanged, a signed message still verifies.
    #[test]
    fn part_headers_of_a_long_non_ascii_attachment_name_are_folded() {
        let acc = account();
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let viet_jp = "Báo cáo tài chính quý bốn năm hai nghìn hai mươi sáu của công ty 東京支店 売上報告書 最終版 すべてのデータ.pdf";
        let ascii = "a long plain file name with spaces and (brackets) that goes on and on and on and on for quite a while.txt";
        let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        let pic_name = "Ảnh chụp màn hình rất dài của cuộc họp 会議のスクリーンショット 二〇二六年十月.png";
        let atts = vec![
            Att { filename: viet_jp.into(), mime: "application/pdf".into(), data_base64: b64(b"%PDF") },
            Att { filename: ascii.into(), mime: "text/plain".into(), data_base64: b64(b"text") },
            Att { filename: "Quarterly figures.docx".into(), mime: docx.into(), data_base64: b64(b"PK") },
        ];
        let pic = InlineImage { cid: "c1".into(), filename: pic_name.into(), mime: "image/png".into(), data_base64: b64(&[1u8, 2, 3]) };
        let d = draft("<p>Hi</p><img src=\"cid:c1\">", vec![pic], atts);

        // the reader of the app itself (mail.rs, mail-parser underneath)
        let names_of = |raw: &[u8]| crate::mail::parse(1, raw, true, false, 0).unwrap().attachments.iter().map(|a| a.name.clone()).collect::<Vec<_>>();
        let sent = wire(&build(&acc, &d).unwrap());
        let draft_copy = wire(&build_draft(&acc, &d).unwrap());
        let signed_input = std::cell::RefCell::new(vec![]);
        let signed = wire(&build_signed(&acc, &d, false, &|b: &[u8]| { *signed_input.borrow_mut() = b.to_vec(); Ok(("sig".into(), "pgp-sha256".into())) }).unwrap());
        let encrypted_inner = std::cell::RefCell::new(vec![]);
        let enc = wire(&build_encrypted(&acc, &d, false, &|inner| { *encrypted_inner.borrow_mut() = inner.to_vec(); Ok("armored".into()) }).unwrap());
        let inner = encrypted_inner.borrow().clone();
        for (what, raw) in [("sent", &sent), ("draft", &draft_copy), ("signed", &signed), ("encrypted", &enc), ("what is encrypted", &inner)] {
            assert_lines_fit(&header_lines_of_all_parts(raw), what);
        }
        for (what, raw) in [("sent", &sent), ("draft", &draft_copy), ("signed", &signed)] {
            let names = names_of(raw);
            for want in [viet_jp, ascii, "Quarterly figures.docx", pic_name] {
                assert!(names.iter().any(|n| n == want), "{what}: {want} not in {names:?}");
            }
        }
        // the signature covers the entity exactly as it stands in the finished message (folding after signing would break it)
        let signed_input = signed_input.borrow().clone();
        assert!(signed.windows(signed_input.len()).any(|w| w == &signed_input[..]), "the signed bytes are in the message as they were signed");
        assert!(signed.starts_with(b"From:") || String::from_utf8_lossy(&signed).contains("multipart/signed"));
    }

    /// W2.21: the mailbox's own Reply-To is written in every message sent from it (sent, Sent copy, draft, signed, encrypted, meeting reply), in the
    /// outer headers, unless it is empty or the From address (any case); another mailbox uses its own value; a name part or a list is refused.
    #[test]
    fn a_mailbox_reply_to_is_written_unless_it_is_the_from_address() {
        let reply_lines = |raw: &[u8]| {
            let (h, _) = crate::pgpmail::parse_headers(raw);
            h.iter().filter(|(n, _)| n.eq_ignore_ascii_case("reply-to")).map(|(_, v)| v.trim().to_string()).collect::<Vec<_>>()
        };
        let mut acc = account();
        acc.reply_to = "team@x.test".into();
        let d = draft("<p>Hi</p>", vec![], vec![]);
        let team = vec!["team@x.test".to_string()];
        assert_eq!(reply_lines(&wire(&build(&acc, &d).unwrap())), team, "sent (and so the Sent copy: the same bytes)");
        assert_eq!(reply_lines(&wire(&build_draft(&acc, &d).unwrap())), team, "a saved draft");
        assert_eq!(reply_lines(&wire(&build_signed(&acc, &d, false, &signer).unwrap())), team, "signed: the outer header");
        assert_eq!(reply_lines(&wire(&build_encrypted(&acc, &d, false, &|_| Ok("armored".into())).unwrap())), team, "encrypted: the outer header");
        let cal = CalendarPart { method: "REPLY".into(), ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".into() };
        assert_eq!(reply_lines(&wire(&build_calendar_mail(&acc, &["org@x.test".to_string()], &[], "Accepted", "ok", &cal).unwrap())), team, "a meeting reply");
        // the envelope and the other headers do not change
        let msg = build(&acc, &d).unwrap();
        assert_eq!(msg.envelope().to().iter().map(|a| a.to_string()).collect::<Vec<_>>(), vec!["ann@example.com".to_string()]);
        // the From address in any case, or nothing: no header
        for same in ["me@example.com", "Me@Example.COM", " me@example.com "] {
            acc.reply_to = same.into();
            assert!(reply_lines(&wire(&build(&acc, &d).unwrap())).is_empty(), "{same:?}");
        }
        acc.reply_to = String::new();
        assert!(reply_lines(&wire(&build(&acc, &d).unwrap())).is_empty());
        // a mailbox that has none does not use another one's (the draft names the mailbox it is sent from)
        let mut other = account_with_id("a2");
        other.email = "other@example.com".into();
        assert!(reply_lines(&wire(&build(&other, &d).unwrap())).is_empty());
        // an internationalized domain goes as its ASCII form
        acc.reply_to = "team@bücher.example".into();
        assert_eq!(reply_lines(&wire(&build(&acc, &d).unwrap())), vec!["team@xn--bcher-kva.example".to_string()]);
        // what the setting accepts: empty or one bare address
        assert_eq!(check_reply_to("  Team@X.test ").unwrap(), "Team@X.test");
        assert_eq!(check_reply_to("").unwrap(), "");
        assert_eq!(check_reply_to("   ").unwrap(), "");
        for bad in ["not an address", "Team <team@x.test>", "a@x.test, b@x.test", "a@x.test;b@x.test", "\"Team\" <a@x.test>", "team", "@x.test", "team@", "a b@x.test", "team@x.test\r\nBcc: evil@x.test"] {
            assert!(check_reply_to(bad).unwrap_err().starts_with("EMAIL_INVALID:"), "{bad:?}");
        }
    }

    /// QA round 2, BUG-1 (O-04): a reply to a message whose Subject held CR LF was sent with those bytes inside the encoded Subject (the mail library encodes a raw
    /// line break instead of refusing it): no header injection, but the subject decoded to two lines. Every header text made from received data is cleaned when the
    /// MIME is built: the subject, the names and ids of a reply, a draft's raw recipients.
    #[test]
    fn header_text_from_received_data_has_no_line_break_or_control_character() {
        assert_eq!(clean_header_text("O04\r\nBcc: bcc@x.test"), "O04 Bcc: bcc@x.test");
        assert_eq!(clean_header_text("a\nb\rc\td\u{b}e\u{c}f\u{85}g\u{2028}h\u{2029}i"), "a b c d e f g h i");
        assert_eq!(clean_header_text("a\r\n\r\nb"), "a  b", "two breaks are two spaces; a typed double space is kept as it is");
        assert_eq!(clean_header_text("a\u{0}b\u{1}c\u{1b}d\u{7f}e\u{80}f\u{9f}g"), "abcdefg");
        for same in ["", "Re: plain", "  two  spaces  ", "Đỗ Văn Ánh", "東京 🚀 Привет", "a\u{a0}b", "\"Doe, John\" <john@x.test>"] {
            assert_eq!(clean_header_text(same), same);
        }
        let hostile = ["x\r\nBcc: evil@x.test", "x\r\n\r\nBody injection", "x\n\rBcc: a", "\r\n\r\n", "a\r\n b\r\n\tc", "x\u{85}Bcc: a", "x\u{2028}Bcc: a", "a\u{0}\r\nb", "\u{1b}[31mred"];
        for h in hostile {
            let c = clean_header_text(h);
            assert!(!c.chars().any(|ch| ch.is_control() || ch == '\u{2028}' || ch == '\u{2029}'), "{h:?} -> {c:?}");
        }

        let acc = account();
        for subject in ["Re: O04\r\nBcc: bcc@x.test", "Re: \r\n\r\nHi\u{0}there", "Re: x\u{85}y\u{2028}z\tw"] {
            let mut d = draft("<p>Hi</p>", vec![], vec![]);
            d.subject = subject.into();
            d.to = vec!["\"Evil\r\nBcc: e@x.test\" <ann@example.test>".into()];
            d.references = vec!["<a@x.test>\r\nBcc: e@x.test".into(), "<b@x.test> <c@x.test>".into()];
            d.in_reply_to = Some("<b@x.test>\r\n".into());
            for lenient in [false, true] {
                let msg = if lenient { build_draft(&acc, &d).unwrap() } else { build(&acc, &d).unwrap() };
                let raw = wire(&msg);
                let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                let head = String::from_utf8(raw[..head_end].to_vec()).unwrap();
                // the headers are what a header block is: every line is a header or a fold of one, and no header the data made up exists
                let names: Vec<&str> = head.split("\r\n").filter(|l| !l.starts_with(' ') && !l.starts_with('\t')).map(|l| l.split(':').next().unwrap()).collect();
                assert!(!names.iter().any(|n| n.eq_ignore_ascii_case("bcc") && !lenient), "{subject:?}: a Bcc header appeared in a sent message\n{head}");
                let p = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
                let decoded = p.subject().unwrap();
                assert!(!decoded.contains(['\r', '\n', '\u{0}', '\u{85}', '\u{2028}']), "{subject:?} decodes to {decoded:?}");
                assert_eq!(decoded, clean_header_text(subject), "lenient={lenient}");
                if !lenient {
                    assert_eq!(msg.envelope().to().len(), 1, "one recipient, not the ones the name tried to add");
                }
                // the ids: one each, the reference list keeps its ids apart
                let parsed = crate::mail::parse(3, &raw, true, false, 0).unwrap();
                assert!(parsed.refs.iter().all(|r| !r.contains(['\r', '\n', ' '])), "{:?}", parsed.refs);
                assert!(parsed.refs.contains(&"<b@x.test>".to_string()) && parsed.refs.contains(&"<c@x.test>".to_string()), "{:?}", parsed.refs);
            }
        }
        // a calendar mail's subject too
        let acc2 = account();
        let cal = CalendarPart { method: "REPLY".into(), ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".into() };
        let msg = build_calendar_mail(&acc2, &["ann@example.test".into()], &[], "Accepted: Q4\r\nBcc: e@x.test", "ok", &cal).unwrap();
        let raw = wire(&msg);
        let p = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
        assert_eq!(p.subject(), Some("Accepted: Q4 Bcc: e@x.test"));
    }

    fn message_id_of(raw: &[u8]) -> String {
        let p = mail_parser::MessageParser::default().parse(raw).unwrap();
        format!("<{}>", p.message_id().expect("a Message-ID"))
    }

    /// QA round 17, BUG-11 (MA-03 / MA-04): a sent message had no Message-ID, so the Sent copy had none and a reply to your own mail had
    /// nothing to answer. The id is made here, from the account's domain, once per message.
    #[test]
    fn a_sent_message_carries_its_own_message_id() {
        let acc = account();
        let d = draft("<p>Hi</p>", vec![], vec![]);
        let one = build(&acc, &d).unwrap().formatted();
        let two = build(&acc, &d).unwrap().formatted();
        let (a, b) = (message_id_of(&one), message_id_of(&two));
        assert!(a.ends_with("@example.com>") && a.starts_with('<'), "{a}");
        assert_ne!(a, b, "a new id for every message");
        let head = String::from_utf8_lossy(&one).to_ascii_lowercase();
        assert_eq!(head.matches("\r\nmessage-id:").count(), 1, "exactly one Message-ID: {head}");
        // never the name of this computer
        if let Ok(host) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
            if !host.is_empty() && !"example.com".contains(&host.to_lowercase()) {
                assert!(!head.contains(&host.to_lowercase()), "host name {host} leaked: {head}");
            }
        }
        assert!(!head.contains("localhost"));
        // the sent message and its Sent copy are the same bytes, so the same id; the app reads it back from the stored copy
        let p = crate::mail::parse(5, &one, true, false, 0).unwrap();
        assert_eq!(p.message_id.as_deref(), Some(a.as_str()));
        // signed and encrypted messages carry it in the outer headers too
        let signed = build_signed(&acc, &d, false, &|_| Ok(("-----BEGIN PGP SIGNATURE-----".into(), "pgp-sha256".into()))).unwrap().formatted();
        assert!(message_id_of(&signed).ends_with("@example.com>"));
        let enc = build_encrypted(&acc, &d, false, &|_| Ok("armored".into())).unwrap().formatted();
        assert!(message_id_of(&enc).ends_with("@example.com>"));
        // an internationalized domain is written in its ASCII form (the account's, and a recipient's)
        let mut idn = account();
        idn.email = "me@bücher.example".into();
        assert!(message_id_of(&build(&idn, &d).unwrap().formatted()).ends_with("@xn--bcher-kva.example>"));
        let mut to_idn = d.clone();
        to_idn.to = vec!["Büro <user@bücher.example>".into()];
        let out = build(&acc, &to_idn).unwrap();
        assert_eq!(out.envelope().to()[0].to_string(), "user@xn--bcher-kva.example", "RCPT TO is ASCII");
        assert!(String::from_utf8_lossy(&out.formatted()).contains("<user@xn--bcher-kva.example>"));
        assert_eq!(envelope(&acc, &to_idn).unwrap().to()[0].to_string(), "user@xn--bcher-kva.example");
        // an iMIP mail has one too
        let cal = CalendarPart { method: "REPLY".into(), ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".into() };
        let m = build_calendar_mail(&acc, &["ann@example.com".to_string()], &[], "Accepted", "ok", &cal).unwrap().formatted();
        assert!(message_id_of(&m).ends_with("@example.com>"));
        // an answer to a message keeps its own id apart from In-Reply-To / References
        let mut r = d.clone();
        r.in_reply_to = Some("<orig@x.org>".into());
        r.references = vec!["<root@x.org>".into(), "<orig@x.org>".into()];
        let raw = build(&acc, &r).unwrap().formatted();
        let p = mail_parser::MessageParser::default().parse(&raw).unwrap();
        assert_ne!(format!("<{}>", p.message_id().unwrap()), "<orig@x.org>");
        assert!(String::from_utf8_lossy(&raw).contains("In-Reply-To: <orig@x.org>\r\n"));
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

    /// A plain SMTP server that records the lines it receives and lets a whole mail through (no AUTH is offered). Returns its port and the
    /// receiver of the lines.
    fn recording_smtp_server() -> (u16, std::sync::mpsc::Receiver<String>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                    let mut w = conn.try_clone().unwrap();
                    let _ = w.write_all(b"220 stub.test ESMTP\r\n");
                    let mut data = false;
                    for line in BufReader::new(conn).lines().map_while(Result::ok) {
                        if data {
                            data = line != ".";
                            if !data {
                                let _ = w.write_all(b"250 queued\r\n");
                            }
                            continue;
                        }
                        let _ = tx.send(line.clone());
                        let up = line.to_uppercase();
                        let reply: &[u8] = if up.starts_with("EHLO") { b"250 stub.test\r\n" } else if up.starts_with("DATA") { data = true; b"354 go\r\n" } else if up.starts_with("QUIT") { b"221 bye\r\n" } else { b"250 ok\r\n" };
                        let _ = w.write_all(reply);
                        if up.starts_with("QUIT") {
                            break;
                        }
                    }
                });
            }
        });
        (port, rx)
    }

    /// A minimal SMTP server that answers one message and hands back the DATA it received (dot-stuffing undone), as the server stores it.
    fn data_server() -> (u16, std::sync::mpsc::Receiver<Vec<u8>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            let mut out = sock.try_clone().unwrap();
            let mut input = BufReader::new(sock);
            let _ = out.write_all(b"220 test ESMTP\r\n");
            let mut line = Vec::new();
            loop {
                line.clear();
                if input.read_until(b'\n', &mut line).unwrap_or(0) == 0 {
                    return;
                }
                let cmd = String::from_utf8_lossy(&line).to_ascii_uppercase();
                if cmd.starts_with("EHLO") {
                    let _ = out.write_all(b"250-test\r\n250 AUTH PLAIN LOGIN\r\n");
                } else if cmd.starts_with("AUTH") {
                    let _ = out.write_all(b"235 ok\r\n");
                } else if cmd.starts_with("DATA") {
                    let _ = out.write_all(b"354 go\r\n");
                    let mut data = Vec::new();
                    loop {
                        line.clear();
                        if input.read_until(b'\n', &mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        if line == b".\r\n" {
                            break;
                        }
                        // transparency (RFC 5321 4.5.2): a leading dot of a line was doubled
                        data.extend_from_slice(if line.starts_with(b"..") { &line[1..] } else { &line });
                    }
                    let _ = tx.send(data);
                    let _ = out.write_all(b"250 queued\r\n");
                } else if cmd.starts_with("QUIT") {
                    let _ = out.write_all(b"221 bye\r\n");
                    return;
                } else {
                    let _ = out.write_all(b"250 ok\r\n");
                }
            }
        });
        (port, rx)
    }

    /// QA round 17, BUG-17 (CF-13): EHLO carried the name of this computer ("NamPC"). It is the address literal `[127.0.0.1]` now, for the
    /// sent mail and for the connection checks, whatever the computer or the account is called.
    #[test]
    fn ehlo_does_not_tell_the_name_of_this_computer() {
        crate::test_guard::within(60, || {
            let (port, lines) = recording_smtp_server();
            let mut acc = account();
            acc.smtp_host = "127.0.0.1".into();
            acc.smtp_port = port;
            acc.smtp_security = "none".into();
            // the message is delivered or refused for lack of AUTH: either way the EHLO line is on record
            let _ = send_raw(&acc, "secret", &envelope_for_tests(), b"Subject: x\r\n\r\nhi");
            let _ = test(&acc, "secret");
            let ehlos: Vec<String> = std::iter::from_fn(|| lines.recv_timeout(std::time::Duration::from_millis(300)).ok()).filter(|l| l.to_uppercase().starts_with("EHLO")).collect();
            assert!(ehlos.len() >= 2, "{ehlos:?}");
            for l in &ehlos {
                assert_eq!(l, "EHLO [127.0.0.1]", "the address literal, nothing about this computer");
            }
            let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default().to_lowercase();
            if !host.is_empty() {
                assert!(ehlos.iter().all(|l| !l.to_lowercase().contains(&host) || host == "127.0.0.1"), "{ehlos:?}");
            }
        });
    }

    /// QA round 17 BUG-19 (MA-22): the copy that goes to the Sent folder is the DATA the server received, byte for byte.
    #[test]
    fn the_sent_copy_is_the_data_the_server_received() {
        crate::test_guard::within(60, || {
            let acc0 = account();
            let mut d = draft("<p>Hi</p>", vec![], vec![]);
            d.text = ".a line that starts with a dot\r\n\r\nthe end".into();
            let msg = build(&acc0, &d).unwrap();
            let raw = msg.formatted();
            assert!(raw.ends_with(b"\r\n"), "lettre ends a message with a line break");
            let mut without = raw.clone();
            without.truncate(without.len() - 2);
            // a message with and without the final line break (a finished PGP message may lack it)
            for message in [raw.clone(), without] {
                let (port, rx) = data_server();
                let mut acc = account();
                acc.smtp_host = "127.0.0.1".into();
                acc.smtp_port = port;
                acc.smtp_security = "none".into();
                let (wire, copy) = as_data(&message);
                send_raw(&acc, "secret", msg.envelope(), wire).expect("the fake server accepts the message");
                let data = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("DATA received");
                assert_eq!(data, copy, "the Sent copy equals the DATA");
                assert!(copy.ends_with(b"\r\n") && !copy.ends_with(b"\r\n\r\n"), "one line break at the end, no empty line added");
                assert_eq!(&copy[..copy.len() - 2], &raw[..raw.len() - 2], "nothing else changed");
            }
        });
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

    /// WP5f: a credential store that does not answer (locked Secret Service) or a Cancel while the add waits leaves no account row, and the
    /// connection checks that came before are not repeated by a retry that follows.
    #[test]
    fn add_account_with_a_keyring_that_times_out_or_is_cancelled_saves_nothing() {
        let ok = |_: &Account, _: &str| -> R<()> { Ok(()) };
        let db = memory_db();
        // the keyring did not answer
        let timed_out = |_: &str, _: &str, _: &dyn Fn() -> bool| -> R<()> { Err(crate::keyring_timeout_error()) };
        let e = crate::add_account_cancellable(&db, input(1, true, 1, "ssl"), "secret", None, &ok, &ok, &|| false, &timed_out).unwrap_err();
        assert!(e.starts_with("KEYRING_TIMEOUT:"), "{e}");
        assert_eq!(account_rows(&db), 0);
        // cancelled before anything was stored: the keyring is not even asked
        let asked = std::cell::Cell::new(0);
        let counting = |_: &str, _: &str, _: &dyn Fn() -> bool| -> R<()> {
            asked.set(asked.get() + 1);
            Ok(())
        };
        let e = crate::add_account_cancellable(&db, input(1, true, 1, "ssl"), "secret", None, &ok, &ok, &|| true, &counting).unwrap_err();
        assert!(e.starts_with("ADD_CANCELLED:"), "{e}");
        assert_eq!((asked.get(), account_rows(&db)), (0, 0));
        // a keyring that answers: the account is added as before
        let a = crate::add_account_cancellable(&db, input(1, true, 1, "ssl"), "secret", None, &ok, &ok, &|| false, &counting).unwrap();
        assert_eq!((asked.get(), account_rows(&db)), (1, 1));
        assert_eq!(a.email, "qa@example.test");
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
            // (the probe has 30 s and must not use them: "passes at once" is proved by finishing in a third of that, whatever else runs)
            assert!(crate::mail::probe_secure_connection(&acc, std::time::Duration::from_secs(30)).is_ok());
            assert!(t.elapsed() < std::time::Duration::from_secs(10), "{:?}", t.elapsed());
            // a plain server saying BAD is the real connection's to word
            acc.imap_port = plain_imap_server();
            assert!(crate::mail::probe_secure_connection(&acc, one_sec).is_ok());
            // so is a port nothing listens on (Windows takes about 2 s to refuse a local connection, so a longer time than the others)
            acc.imap_port = crate::testutil::dead_addr().port();
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
    /// The header names of a message (outer block), lower case, in order.
    fn header_names(raw: &str) -> Vec<String> {
        let head = raw.split("\r\n\r\n").next().unwrap_or("");
        head.lines().filter(|l| !l.starts_with(' ') && !l.starts_with('\t')).filter_map(|l| l.split_once(':').map(|(n, _)| n.to_ascii_lowercase())).collect()
    }

    const IMPORTANCE_NAMES: [&str; 4] = ["importance", "x-priority", "priority", "x-msmail-priority"];

    fn with(importance: crate::importance::Importance) -> Draft {
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.importance = importance;
        d
    }

    fn signer(_: &[u8]) -> R<(String, String)> {
        Ok(("sig".into(), "pgp-sha256".into()))
    }

    /// F-24: High and Low write the four importance headers, Normal writes none (not even `Importance: normal`).
    #[test]
    fn importance_headers_are_written_per_level_and_never_for_normal() {
        use crate::importance::Importance::*;
        let acc = account();
        let out = text(&build(&acc, &with(High)).unwrap());
        for line in ["Importance: high\r\n", "X-Priority: 1 (Highest)\r\n", "Priority: urgent\r\n", "X-MSMail-Priority: High\r\n"] {
            assert!(out.contains(line), "{line:?} missing in {out}");
        }
        let out = text(&build(&acc, &with(Low)).unwrap());
        for line in ["Importance: low\r\n", "X-Priority: 5 (Lowest)\r\n", "Priority: non-urgent\r\n", "X-MSMail-Priority: Low\r\n"] {
            assert!(out.contains(line), "{line:?} missing in {out}");
        }
        assert!(!out.contains("Importance: high") && !out.contains("Priority: urgent") && !out.contains("X-Priority: 1"), "a Low message carries no High value: {out}");
        let out = text(&build(&acc, &with(Normal)).unwrap());
        let names = header_names(&out);
        for n in IMPORTANCE_NAMES {
            assert!(!names.contains(&n.to_string()), "{n} must not be added for Normal: {out}");
        }
        assert!(!out.contains("Importance: normal"));
        // exactly one of each for High (no duplicates)
        let names = header_names(&text(&build(&acc, &with(High)).unwrap()));
        for n in IMPORTANCE_NAMES {
            assert_eq!(names.iter().filter(|x| *x == n).count(), 1, "{n}");
        }
    }

    /// The same headers are on every kind of message that is built from a draft: the Sent copy is the sent bytes, a draft saved to
    /// Drafts, a signed and an encrypted message.
    #[test]
    fn importance_headers_are_on_drafts_signed_and_encrypted_messages_too() {
        use crate::importance::Importance::*;
        let acc = account();
        for level in [High, Low] {
            let d = with(level);
            let want = level.headers();
            let check = |what: &str, raw: String| {
                for (n, v) in want {
                    assert!(raw.contains(&format!("{n}: {v}\r\n")), "{what}: {n} missing in {raw}");
                }
            };
            check("draft", text(&build_draft(&acc, &d).unwrap()));
            check("signed", text(&build_signed(&acc, &d, false, &signer).unwrap()));
            check("encrypted", text(&build_encrypted(&acc, &d, false, &|_| Ok("armored".into())).unwrap()));
            let mut empty = d.clone();
            empty.to.clear();
            check("draft without recipients", text(&build_draft(&acc, &empty).unwrap()));
        }
        // and none of them add a header for Normal
        let n = with(Normal);
        for raw in [text(&build_draft(&acc, &n).unwrap()), text(&build_signed(&acc, &n, false, &signer).unwrap())] {
            assert!(!header_names(&raw).iter().any(|h| IMPORTANCE_NAMES.contains(&h.as_str())), "{raw}");
        }
    }

    /// A draft saved with an importance gives it back when it is read from the saved bytes (the way a reopened draft learns it).
    #[test]
    fn importance_survives_the_draft_round_trip() {
        use crate::importance::Importance::*;
        let acc = account();
        for level in [Normal, High, Low] {
            let raw = build_draft(&acc, &with(level)).unwrap().formatted();
            assert_eq!(crate::importance::from_raw(&raw), level, "{level:?}");
            let parsed = crate::mail::parse(1, &raw, false, false, 0).expect("parses");
            assert_eq!(parsed.importance, level);
            // the sent message too
            let sent = build(&acc, &with(level)).unwrap().formatted();
            assert_eq!(crate::mail::parse(2, &sent, true, false, 0).unwrap().importance, level);
        }
    }

    /// The queue (scheduled sends, the Undo window) keeps the draft as JSON: the importance is in it and is still there after a restart;
    /// an item queued by a version without the field loads as Normal.
    #[test]
    fn importance_is_kept_in_the_queued_json_and_old_items_still_load() {
        use crate::importance::Importance::*;
        for level in [Normal, High, Low] {
            let json = serde_json::to_string(&with(level)).unwrap();
            let back: Draft = serde_json::from_str(&json).unwrap();
            assert_eq!(back.importance, level);
        }
        let json = serde_json::to_string(&with(High)).unwrap();
        assert!(json.contains("\"importance\":\"high\""), "{json}");
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v.as_object_mut().unwrap().remove("importance");
        let old: Draft = serde_json::from_value(v).unwrap();
        assert_eq!(old.importance, Normal);
        // what the interface sends
        let from_ui: Draft = serde_json::from_str(r#"{"accountId":"a1","to":[],"subject":"s","html":"","text":"","importance":"low"}"#).unwrap();
        assert_eq!(from_ui.importance, Low);
        let no_field: Draft = serde_json::from_str(r#"{"accountId":"a1","to":[],"subject":"s","html":"","text":""}"#).unwrap();
        assert_eq!(no_field.importance, Normal);
        // a message queued with High, rebuilt from the stored JSON at send time, still carries the headers
        let stored = serde_json::to_string(&with(High)).unwrap();
        let rebuilt = build(&account(), &serde_json::from_str::<Draft>(&stored).unwrap()).unwrap();
        assert!(text(&rebuilt).contains("Importance: high\r\n"));
    }

    /// 1.0.6 integration: the features of the compose branches work together on every route that makes bytes (send, draft, signed,
    /// encrypted): Importance + Message-ID + header folding + Bcc in drafts only + the outgoing sanitiser + the Sent copy equal to DATA.
    #[test]
    fn importance_message_id_folding_bcc_and_the_sanitiser_work_together() {
        use crate::importance::Importance::High;
        let acc = account();
        let html = r#"<p>Hi</p><script>alert(1)</script><img src="\\host\share\x.png"><img src="file:///c:/x.png"><a href="javascript:alert(2)">x</a>"#;
        let mut d = draft(html, vec![], vec![]);
        d.importance = High;
        d.to = (0..60).map(|i| format!("Person Number {i} <person{i}@example.org>")).collect();
        d.bcc = vec!["Quiet <quiet@example.com>".into()];
        d.references = (0..12).map(|i| format!("<ref{i}-0123456789abcdef0123456789abcdef@example.org>")).collect();
        d.in_reply_to = Some("<parent@example.org>".into());
        let head_of = |raw: &str| raw.split("\r\n\r\n").next().unwrap_or("").to_string();

        // sent: the strict builder, then the wire form and the copy that is kept in Sent
        let sent_msg = build(&acc, &d).unwrap();
        let wired = wire(&sent_msg);
        let (_, sent_copy) = as_data(&wired);
        let sent = String::from_utf8_lossy(&sent_copy).into_owned();
        assert!(sent.contains("Importance: high\r\n") && sent.contains("X-Priority: 1 (Highest)\r\n"), "{sent}");
        assert_eq!(sent.matches("Message-ID: <").count(), 1, "{sent}");
        assert!(head_of(&sent).contains("@example.com>"), "the id carries the account domain");
        assert!(!sent.to_ascii_lowercase().contains("bcc:") && !sent.contains("quiet@example.com"), "a sent message never names the Bcc");
        assert!(sent_msg.envelope().to().iter().any(|a| a.to_string() == "quiet@example.com"), "the envelope still delivers to the Bcc");
        // lettre wraps To lists with display names itself (a little over 78 characters per line); the unquoted References are folded by headerfold.rs
        assert!(head_of(&sent).lines().all(|l| l.len() <= 998), "no header line near the 998 limit: {}", head_of(&sent));
        assert!(head_of(&sent).lines().filter(|l| l.starts_with(" <ref") || l.starts_with("References:")).all(|l| l.len() <= 78), "References is folded at 78: {}", head_of(&sent));
        let parsed = mail_parser::MessageParser::default().parse(sent.as_bytes()).unwrap();
        assert_eq!(parsed.to().map(|a| a.iter().filter(|x| x.address.is_some()).count()), Some(60), "unfolding gives the same 60 recipients");
        for bad in ["<script", "alert(", "host", "file:", "javascript:"] {
            assert!(!sent.contains(bad), "{bad} must not reach the wire: {sent}");
        }

        // the draft copy (APPEND to Drafts): Bcc and Importance are kept, the sanitiser and the folding ran as well
        let saved = String::from_utf8_lossy(&wire(&build_draft(&acc, &d).unwrap())).into_owned();
        assert!(saved.contains("Quiet <quiet@example.com>") && saved.contains("Importance: high\r\n"), "{saved}");
        assert!(head_of(&saved).lines().all(|l| l.len() <= 998), "{}", head_of(&saved));
        for bad in ["<script", "alert(", "file:", "javascript:"] {
            assert!(!saved.contains(bad), "{bad} must not be saved either: {saved}");
        }

        // a signed and an encrypted message use the same header builder and the same sanitiser
        let signed = text(&build_signed(&acc, &d, false, &signer).unwrap());
        assert!(signed.contains("Importance: high\r\n") && signed.contains("Message-ID: <") && !signed.to_ascii_lowercase().contains("bcc:") && !signed.contains("<script"), "{signed}");
        let enc = build_encrypted(&acc, &d, false, &|inner| {
            assert!(!String::from_utf8_lossy(inner).contains("<script"), "the sanitiser runs before the encryption");
            Ok("armored".into())
        })
        .unwrap();
        let enc = text(&enc);
        assert!(enc.contains("Importance: high\r\n") && enc.contains("Message-ID: <") && !enc.to_ascii_lowercase().contains("bcc:"), "{enc}");
    }
}

/// BUG-R3-4: the meeting of a draft travels in a private header of the DRAFT copy and nowhere else.
#[cfg(test)]
mod meeting_form_tests {
    use super::tests::{account, draft};
    use super::*;

    const BLOB: &str = "eyJ2IjoxLCJ0eiI6IkFzaWEvSG9fQ2hpX01pbmgiLCJzZCI6IjIwMjYtMTAtMjAiLCJzdCI6IjA5OjAwIiwiZWQiOiIyMDI2LTEwLTIwIiwiZXQiOiIxMDowMCIsImFsbERheSI6ZmFsc2UsIndoZXJlIjoiUm9vbSAxIn0";

    fn with_meeting(form: Option<&str>) -> Draft {
        let mut d = draft("<p>Hi</p>", vec![], vec![]);
        d.meeting_form = form.map(str::to_string);
        d
    }

    fn names(raw: &[u8]) -> Vec<String> {
        let (h, _) = crate::pgpmail::parse_headers(raw);
        h.into_iter().map(|(k, _)| k.to_ascii_lowercase()).collect()
    }

    #[test]
    fn a_draft_writes_the_header_and_reads_it_back() {
        let raw = build_draft(&account(), &with_meeting(Some(BLOB))).unwrap().formatted();
        assert_eq!(names(&raw).iter().filter(|n| *n == "x-heylook-meeting").count(), 1);
        assert_eq!(crate::draftmail::recipients(&raw).meeting.as_deref(), Some(BLOB));
        // no line of the header block is too long for a mail server (RFC 5322: 998)
        let head = String::from_utf8_lossy(&raw).split("\r\n\r\n").next().unwrap().to_string();
        assert!(head.lines().all(|l| l.len() <= 998), "{head}");
    }

    /// A long value (a long location) is written in folded pieces and still comes back whole.
    #[test]
    fn a_long_value_is_folded_and_comes_back_whole() {
        let long: String = "aB3-_".repeat(400); // 2000 characters
        let raw = build_draft(&account(), &with_meeting(Some(&long))).unwrap().formatted();
        let head = String::from_utf8_lossy(&raw).split("\r\n\r\n").next().unwrap().to_string();
        assert!(head.lines().all(|l| l.len() <= 998), "a header line is too long");
        assert_eq!(crate::draftmail::recipients(&raw).meeting.as_deref(), Some(long.as_str()));
    }

    /// MA-05: the message that is SENT (plain, signed, with a scheduled copy) never has the header, whatever the draft carries.
    #[test]
    fn a_sent_message_never_has_the_header() {
        let d = with_meeting(Some(BLOB));
        let sent = build(&account(), &d).unwrap().formatted();
        assert!(!names(&sent).contains(&"x-heylook-meeting".to_string()));
        assert!(!String::from_utf8_lossy(&sent).contains(BLOB));
        let signed = build_signed(&account(), &d, false, &|_: &[u8]| Ok(("sig".into(), "pgp-sha256".into()))).unwrap().formatted();
        assert!(!String::from_utf8_lossy(&signed).contains(BLOB));
        // the wire form (what the SMTP server gets and what the Sent folder keeps) is the same bytes
        assert!(!String::from_utf8_lossy(&wire(&build(&account(), &d).unwrap())).contains("X-HeyLook"));
    }

    /// A draft without a meeting is as it was: no header, and the queue's JSON has no new field.
    #[test]
    fn a_draft_without_a_meeting_is_unchanged() {
        let d = with_meeting(None);
        let raw = build_draft(&account(), &d).unwrap().formatted();
        assert!(!names(&raw).contains(&"x-heylook-meeting".to_string()));
        assert_eq!(crate::draftmail::recipients(&raw).meeting, None);
        assert!(!serde_json::to_string(&d).unwrap().contains("meetingForm"));
        // an item queued by an older version loads
        let json = serde_json::to_string(&d).unwrap();
        assert!(serde_json::from_str::<Draft>(&json).unwrap().meeting_form.is_none());
    }

    /// A value that is not ours (other alphabet, too long, empty) is not written and not read.
    #[test]
    fn a_malformed_or_oversized_value_is_ignored() {
        for bad in ["", "   ", "not base64url!", "a=b", "<script>", &"A".repeat(crate::draftmail::MEETING_MAX + 1)] {
            let raw = build_draft(&account(), &with_meeting(Some(bad))).unwrap().formatted();
            assert!(!names(&raw).contains(&"x-heylook-meeting".to_string()), "written for {bad:?}");
        }
        // a header that was written by somebody else
        for bad in ["not base64url!", "a=b", "", &"A".repeat(crate::draftmail::MEETING_MAX + 1)] {
            let raw = format!("From: me@example.com\r\nX-HeyLook-Meeting: {bad}\r\nSubject: x\r\n\r\nbody\r\n");
            assert_eq!(crate::draftmail::recipients(raw.as_bytes()).meeting, None, "read for {bad:?}");
        }
        // at the limit it is still read
        let ok = "A".repeat(crate::draftmail::MEETING_MAX);
        let raw = format!("From: me@example.com\r\nX-HeyLook-Meeting: {ok}\r\nSubject: x\r\n\r\nbody\r\n");
        assert_eq!(crate::draftmail::recipients(raw.as_bytes()).meeting.as_deref(), Some(ok.as_str()));
    }

    /// A server that drops the header: the copy this computer kept (by account and Message-ID) gives the meeting back; another draft has none.
    #[test]
    fn a_server_that_drops_the_header_loses_nothing() {
        let c = crate::db::test_conn(&["a1"]);
        let raw = build_draft(&account(), &with_meeting(Some(BLOB))).unwrap().formatted();
        crate::draftmail::remember_meeting(&c, "a1", &raw, BLOB);
        // what the server hands back: the same message without the private header
        let text = String::from_utf8_lossy(&raw).to_string();
        let stripped: String = text.split("\r\n").filter(|l| !l.starts_with("X-HeyLook-Meeting") && !l.starts_with(' ')).collect::<Vec<_>>().join("\r\n");
        assert!(!stripped.contains("X-HeyLook-Meeting"));
        assert_eq!(crate::draftmail::recipients(stripped.as_bytes()).meeting, None);
        assert_eq!(crate::draftmail::recall_meeting(&c, "a1", stripped.as_bytes()).as_deref(), Some(BLOB));
        assert_eq!(crate::draftmail::recall_meeting(&c, "a2", stripped.as_bytes()), None, "another account");
        let other = build_draft(&account(), &with_meeting(Some(BLOB))).unwrap().formatted();
        assert_eq!(crate::draftmail::recall_meeting(&c, "a1", &other), None, "another draft");
        // old copies go when a new one is written, and a copy of a removed account is pruned
        c.execute("INSERT INTO settings(key,value) VALUES('dmeet:a1|<old@x>', '1|AAAA'), ('dmeet:gone|<z@x>', '9999999999|AAAA')", []).unwrap();
        crate::draftmail::remember_meeting(&c, "a1", &other, BLOB);
        assert!(crate::db::get_setting(&c, "dmeet:a1|<old@x>").is_none());
        assert_eq!(crate::draftmail::recall_meeting(&c, "a1", &other).as_deref(), Some(BLOB));
    }
}
