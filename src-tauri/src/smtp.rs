use crate::db::{err, Account, R};
use base64::Engine;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{Address, Message, SmtpTransport, Transport};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Att {
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
}

fn mailbox(s: &str) -> R<Mailbox> {
    s.trim().parse::<Mailbox>().map_err(|e| format!("bad address '{s}': {e}"))
}

pub fn build(acc: &Account, d: &Draft) -> R<Message> {
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
    let alt = MultiPart::alternative()
        .singlepart(SinglePart::plain(d.text.clone()))
        .singlepart(SinglePart::html(d.html.clone()));
    let msg = if d.attachments.is_empty() {
        b.multipart(alt)
    } else {
        let mut mixed = MultiPart::mixed().multipart(alt);
        for a in &d.attachments {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&a.data_base64)
                .map_err(err)?;
            let ct = ContentType::parse(&a.mime)
                .unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            mixed = mixed.singlepart(Attachment::new(a.filename.clone()).body(bytes, ct));
        }
        b.multipart(mixed)
    };
    msg.map_err(err)
}

pub fn send(acc: &Account, secret: &str, msg: &Message) -> R<()> {
    let creds = Credentials::new(if acc.auth == "oauth_google" { acc.email.clone() } else { acc.username.clone() }, secret.to_string());
    let host = acc.smtp_host.as_str();
    let t = match acc.smtp_security.as_str() {
        "ssl" => SmtpTransport::relay(host).map_err(err)?.port(acc.smtp_port),
        "starttls" => SmtpTransport::starttls_relay(host).map_err(err)?.port(acc.smtp_port),
        _ => SmtpTransport::builder_dangerous(host).port(acc.smtp_port),
    }
    .credentials(creds);
    let t = (if acc.auth == "oauth_google" { t.authentication(vec![Mechanism::Xoauth2]) } else { t }).build();
    t.send(msg).map_err(|e| format!("SMTP send failed: {e}"))?;
    Ok(())
}

/// Same as `build`; lettre only needs recipients at send time, so incomplete drafts are fine.
pub fn build_draft(acc: &Account, d: &Draft) -> R<Message> {
    build(acc, d)
}
