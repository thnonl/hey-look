use crate::db::{err, Account, R};
use base64::Engine;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
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

/// Undo the quoting of a display name: `"a \"b\""` -> `a "b"`. An unquoted name is taken as written.
fn unquote_name(raw: &str) -> String {
    let t = raw.trim();
    let Some(inner) = t.strip_prefix('"').and_then(|x| x.strip_suffix('"')).filter(|_| t.len() >= 2) else { return clean_name(t) };
    let mut out = String::with_capacity(inner.len());
    let mut it = inner.chars();
    while let Some(c) = it.next() {
        match c {
            '\\' => out.extend(it.next()),
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

fn headers(acc: &Account, d: &Draft) -> R<lettre::message::MessageBuilder> {
    let from = Mailbox::new(
        Some(acc.display_name.clone()).filter(|n| !n.is_empty()),
        acc.email.parse::<Address>().map_err(err)?,
    );
    let mut b = Message::builder().from(from).subject(d.subject.clone());
    for t in &d.to {
        b = b.to(mailbox(t)?);
    }
    for c in &d.cc {
        b = b.cc(mailbox(c)?);
    }
    for c in &d.bcc {
        b = b.bcc(mailbox(c)?);
    }
    if let Some(r) = &d.in_reply_to {
        b = b.in_reply_to(r.clone());
    }
    if !d.references.is_empty() {
        b = b.references(d.references.join(" "));
    }
    Ok(b)
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
        mixed = mixed.singlepart(Attachment::new(a.filename.clone()).body(bytes, ct));
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
    headers(acc, d)?.multipart(body(d)?).map_err(err)
}

/// multipart/signed (RFC 3156): the signature covers the content entity exactly as it is written, without the
/// line break that belongs to the next boundary line.
pub fn build_signed(acc: &Account, d: &Draft, sign: &dyn Fn(&[u8]) -> R<(String, String)>) -> R<Message> {
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
    headers(acc, d)?.multipart(outer).map_err(err)
}

/// multipart/encrypted (RFC 3156): a control part and the armored OpenPGP message.
pub fn build_encrypted(acc: &Account, d: &Draft, encrypt: &dyn Fn(&[u8]) -> R<String>) -> R<Message> {
    let armored = encrypt(&body(d)?.formatted())?;
    let control = SinglePart::builder().header(ContentType::parse("application/pgp-encrypted").map_err(err)?).body(String::from("Version: 1"));
    let data = SinglePart::builder()
        .header(ContentType::parse("application/octet-stream; name=\"encrypted.asc\"").map_err(err)?)
        .header(lettre::message::header::ContentDisposition::inline_with_name("encrypted.asc"))
        .body(armored);
    let outer = MultiPart::encrypted("application/pgp-encrypted".to_string()).singlepart(control).singlepart(data);
    headers(acc, d)?.multipart(outer).map_err(err)
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

fn transport(acc: &Account, secret: &str) -> R<SmtpTransport> {
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
    Ok((if acc.auth.starts_with("oauth_") { b.authentication(vec![Mechanism::Xoauth2]) } else { b }).build())
}

/// Send an already finished message (encrypted/signed ones are built once, at schedule time).
pub fn send_raw(acc: &Account, secret: &str, env: &lettre::address::Envelope, raw: &[u8]) -> R<()> {
    transport(acc, secret)?.send_raw(env, raw).map_err(|e| format!("SMTP send failed: {e}"))?;
    Ok(())
}

/// Connect and authenticate without sending anything.
pub fn test(acc: &Account, secret: &str) -> R<()> {
    match transport(acc, secret)?.test_connection() {
        Ok(true) => Ok(()),
        Ok(false) => Err("SMTP server did not accept the connection".into()),
        Err(e) => Err(format!("SMTP login failed: {e}")),
    }
}

/// Same as `build`; lettre only needs recipients at send time, so incomplete drafts are fine.
pub fn build_draft(acc: &Account, d: &Draft) -> R<Message> {
    build(acc, d)
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
}
