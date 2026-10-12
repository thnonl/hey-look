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
}

fn mailbox(s: &str) -> R<Mailbox> {
    s.trim().parse::<Mailbox>().map_err(|e| format!("bad address '{s}': {e}"))
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
    let alt = if d.inline.is_empty() {
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
    if d.attachments.is_empty() {
        return Ok(alt);
    }
    let mut mixed = MultiPart::mixed().multipart(alt);
    for a in &d.attachments {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&a.data_base64).map_err(err)?;
        let ct = ContentType::parse(&a.mime).unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
        mixed = mixed.singlepart(Attachment::new(a.filename.clone()).body(bytes, ct));
    }
    Ok(mixed)
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
}
