use crate::db::{err, Account, R};
use base64::Engine;
use mail_parser::{Address, MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type Sess = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

/// Roles synced first, in this order. Other folders are stored under the role "f:<imap name>".
pub const ROLES: [&str; 6] = ["inbox", "sent", "drafts", "archive", "trash", "junk"];

struct XOAuth2<'a> {
    user: &'a str,
    token: &'a str,
}

impl imap::Authenticator for XOAuth2<'_> {
    type Response = String;
    fn process(&self, _challenge: &[u8]) -> Self::Response {
        format!("user={}\x01auth=Bearer {}\x01\x01", self.user, self.token)
    }
}

/// `secret` is the password, or the OAuth access token when `acc.auth` is an `oauth_*` method.
pub fn connect(acc: &Account, secret: &str) -> R<Sess> {
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(acc.tls_insecure)
        .danger_accept_invalid_hostnames(acc.tls_insecure)
        .build()
        .map_err(err)?;
    let host = acc.imap_host.as_str();
    let addr = (host, acc.imap_port);
    let client = if acc.imap_ssl {
        imap::connect(addr, host, &tls).map_err(err)?
    } else {
        imap::connect_starttls(addr, host, &tls).map_err(err)?
    };
    if acc.auth.starts_with("oauth_") {
        client
            .authenticate("XOAUTH2", &XOAuth2 { user: &acc.email, token: secret })
            .map_err(|e| format!("IMAP OAuth login failed: {}", e.0))
    } else {
        client.login(&acc.username, secret).map_err(|e| format!("IMAP login failed: {}", e.0))
    }
}

/// role -> real IMAP folder name. Standard roles use their plain name, everything else "f:<name>".
pub fn discover_folders(s: &mut Sess) -> R<HashMap<String, String>> {
    use imap::types::NameAttribute as A;
    let names = s.list(Some(""), Some("*")).map_err(err)?;
    let mut map: HashMap<String, String> = HashMap::new();
    map.insert("inbox".into(), "INBOX".into());
    let mut custom: Vec<String> = vec![];
    for n in names.iter() {
        let name = n.name().to_string();
        if name.eq_ignore_ascii_case("INBOX") {
            continue;
        }
        let lower = name.to_lowercase();
        let mut role: Option<&str> = None;
        let mut skip = false;
        for a in n.attributes() {
            match a {
                A::NoSelect => skip = true,
                A::Custom(c) => match c.to_lowercase().as_str() {
                    "\\sent" => role = Some("sent"),
                    "\\drafts" => role = Some("drafts"),
                    "\\archive" | "\\all" => role = Some("archive"),
                    "\\trash" => role = Some("trash"),
                    "\\junk" => role = Some("junk"),
                    "\\flagged" | "\\important" => skip = true,
                    _ => {}
                },
                _ => {}
            }
        }
        if skip {
            continue;
        }
        if role.is_none() {
            let leaf = lower.rsplit(['/', '.']).next().unwrap_or(&lower).to_string();
            role = match leaf.as_str() {
                "sent" | "sent items" | "sent mail" | "sent messages" => Some("sent"),
                "drafts" | "draft" => Some("drafts"),
                "archive" | "archives" => Some("archive"),
                "trash" | "deleted items" | "deleted messages" | "bin" => Some("trash"),
                "junk" | "spam" | "junk e-mail" | "junk email" => Some("junk"),
                _ => None,
            };
        }
        match role {
            Some(r) if !map.contains_key(r) => {
                map.insert(r.to_string(), name);
            }
            _ => custom.push(name),
        }
    }
    for c in custom {
        map.insert(format!("f:{c}"), c);
    }
    Ok(map)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttMeta {
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: usize,
}

#[derive(Debug, Clone)]
pub struct Parsed {
    pub uid: u32,
    pub message_id: Option<String>,
    pub refs: Vec<String>,
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub date: i64,
    pub snippet: String,
    pub html: Option<String>,
    pub text: Option<String>,
    pub seen: bool,
    pub flagged: bool,
    pub attachments: Vec<AttMeta>,
    pub list_unsub: Option<String>,
    pub list_unsub_post: bool,
}

pub struct FolderFetch {
    pub new: Vec<Parsed>,
    /// (uid, seen, flagged) for messages already stored in the scanned range
    pub flags: Vec<(u32, bool, bool)>,
}

fn ids_in(raw: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = raw;
    while let Some(a) = rest.find('<') {
        let Some(b) = rest[a..].find('>') else { break };
        out.push(rest[a..a + b + 1].to_string());
        rest = &rest[a + b + 1..];
    }
    out
}

fn addrs(a: Option<&Address>) -> Vec<String> {
    a.map(|a| a.iter().filter_map(|x| x.address.as_ref().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

fn strip_html(h: &str) -> String {
    let mut out = String::with_capacity(h.len() / 2);
    let mut in_tag = false;
    for ch in h.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

pub fn parse(uid: u32, raw: &[u8], seen: bool, flagged: bool, fallback_date: i64) -> Option<Parsed> {
    let m = MessageParser::default().parse(raw)?;
    let (from_name, from_email) = m
        .from()
        .and_then(|a| a.first())
        .map(|f| {
            (
                f.name.as_ref().map(|s| s.to_string()).unwrap_or_default(),
                f.address.as_ref().map(|s| s.to_string()).unwrap_or_default(),
            )
        })
        .unwrap_or_default();
    let mut html = m.body_html(0).map(|s| s.to_string());
    let text = m.body_text(0).map(|s| s.to_string());

    // attachments + inline cid images (embedded as data: URIs, max 2 MB each)
    let mut attachments = vec![];
    for (i, part) in m.attachments().enumerate() {
        let mime = part
            .content_type()
            .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("octet-stream")))
            .unwrap_or_else(|| "application/octet-stream".into());
        let size = part.contents().len();
        if let (Some(cid), Some(h)) = (part.content_id(), html.as_mut()) {
            if mime.starts_with("image/") && size <= 2_000_000 {
                let cid = cid.trim_matches(['<', '>']);
                let uri = format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(part.contents())
                );
                *h = h.replace(&format!("cid:{cid}"), &uri);
                continue;
            }
        }
        if let Some(name) = part.attachment_name() {
            attachments.push(AttMeta { index: i, name: name.to_string(), mime, size });
        }
    }

    let basis = text.clone().unwrap_or_else(|| html.as_deref().map(strip_html).unwrap_or_default());
    let snippet: String = basis.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
    let mut refs = m.header_raw("References").map(ids_in).unwrap_or_default();
    if let Some(r) = m.header_raw("In-Reply-To") {
        refs.extend(ids_in(r));
    }
    Some(Parsed {
        uid,
        message_id: m.message_id().map(|s| format!("<{s}>")),
        refs,
        subject: m.subject().unwrap_or("(no subject)").to_string(),
        from_name,
        from_email,
        to: addrs(m.to()),
        cc: addrs(m.cc()),
        date: m.date().map(|d| d.to_timestamp()).unwrap_or(fallback_date),
        snippet,
        html,
        text,
        seen,
        flagged,
        attachments,
        list_unsub: m.header_raw("List-Unsubscribe").map(|s| s.trim().to_string()),
        list_unsub_post: m.header_raw("List-Unsubscribe-Post").is_some(),
    })
}

/// Raw attachment bytes for `index` (position among the parsed attachment parts).
pub fn attachment_bytes(raw: &[u8], index: usize) -> R<(String, Vec<u8>)> {
    let m = MessageParser::default().parse(raw).ok_or("cannot parse message")?;
    let part = m.attachments().nth(index).ok_or("attachment not found")?;
    let name = part.attachment_name().unwrap_or("attachment").to_string();
    Ok((name, part.contents().to_vec()))
}

pub fn fetch_folder(s: &mut Sess, folder: &str, max_known_uid: u32, min_known_uid: u32, initial: u32) -> R<FolderFetch> {
    let mb = s.select(folder).map_err(err)?;
    let mut res = FolderFetch { new: vec![], flags: vec![] };
    if mb.exists == 0 {
        return Ok(res);
    }
    let fetched = if max_known_uid == 0 {
        let start = mb.exists.saturating_sub(initial.saturating_sub(1)).max(1);
        s.fetch(format!("{start}:*"), "(UID FLAGS INTERNALDATE BODY.PEEK[])")
    } else {
        s.uid_fetch(format!("{}:*", max_known_uid + 1), "(UID FLAGS INTERNALDATE BODY.PEEK[])")
    }
    .map_err(err)?;
    for f in fetched.iter() {
        let Some(uid) = f.uid else { continue };
        if uid <= max_known_uid {
            continue;
        }
        let Some(body) = f.body() else { continue };
        let flags = f.flags();
        let seen = flags.iter().any(|x| matches!(x, imap::types::Flag::Seen));
        let flagged = flags.iter().any(|x| matches!(x, imap::types::Flag::Flagged));
        let fb = f.internal_date().map(|d| d.timestamp()).unwrap_or(0);
        if let Some(p) = parse(uid, body, seen, flagged, fb) {
            res.new.push(p);
        }
    }
    // refresh flags for already-known range
    if max_known_uid > 0 && min_known_uid > 0 {
        let fl = s.uid_fetch(format!("{min_known_uid}:{max_known_uid}"), "(UID FLAGS)").map_err(err)?;
        for f in fl.iter() {
            if let Some(uid) = f.uid {
                let flags = f.flags();
                res.flags.push((
                    uid,
                    flags.iter().any(|x| matches!(x, imap::types::Flag::Seen)),
                    flags.iter().any(|x| matches!(x, imap::types::Flag::Flagged)),
                ));
            }
        }
    }
    Ok(res)
}

/// Messages with UIDs in `lo..=hi` (used to page back into older mail).
pub fn fetch_range(s: &mut Sess, folder: &str, lo: u32, hi: u32) -> R<Vec<Parsed>> {
    s.select(folder).map_err(err)?;
    let fetched = s.uid_fetch(format!("{lo}:{hi}"), "(UID FLAGS INTERNALDATE BODY.PEEK[])").map_err(err)?;
    let mut out = vec![];
    for f in fetched.iter() {
        let (Some(uid), Some(body)) = (f.uid, f.body()) else { continue };
        if uid < lo || uid > hi {
            continue;
        }
        let flags = f.flags();
        let seen = flags.iter().any(|x| matches!(x, imap::types::Flag::Seen));
        let flagged = flags.iter().any(|x| matches!(x, imap::types::Flag::Flagged));
        let fb = f.internal_date().map(|d| d.timestamp()).unwrap_or(0);
        if let Some(p) = parse(uid, body, seen, flagged, fb) {
            out.push(p);
        }
    }
    Ok(out)
}

pub fn fetch_raw(s: &mut Sess, folder: &str, uid: u32) -> R<Vec<u8>> {
    s.select(folder).map_err(err)?;
    let f = s.uid_fetch(uid.to_string(), "BODY.PEEK[]").map_err(err)?;
    f.iter()
        .next()
        .and_then(|m| m.body().map(|b| b.to_vec()))
        .ok_or_else(|| "message not found on server".into())
}

pub fn store_flag(s: &mut Sess, folder: &str, uids: &[u32], flag: &str, add: bool) -> R<()> {
    if uids.is_empty() {
        return Ok(());
    }
    s.select(folder).map_err(err)?;
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let q = if add { format!("+FLAGS ({flag})") } else { format!("-FLAGS ({flag})") };
    s.uid_store(set, q).map_err(err)?;
    Ok(())
}

pub fn move_to(s: &mut Sess, src: &str, uids: &[u32], dst: &str) -> R<()> {
    if uids.is_empty() {
        return Ok(());
    }
    s.select(src).map_err(err)?;
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    if s.uid_mv(&set, dst).is_ok() {
        return Ok(());
    }
    s.uid_copy(&set, dst).map_err(err)?;
    s.uid_store(&set, "+FLAGS (\\Deleted)").map_err(err)?;
    s.expunge().map_err(err)?;
    Ok(())
}

pub fn delete_forever(s: &mut Sess, src: &str, uids: &[u32]) -> R<()> {
    if uids.is_empty() {
        return Ok(());
    }
    s.select(src).map_err(err)?;
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    s.uid_store(&set, "+FLAGS (\\Deleted)").map_err(err)?;
    s.expunge().map_err(err)?;
    Ok(())
}

pub fn append(s: &mut Sess, folder: &str, raw: &[u8], draft: bool) -> R<()> {
    let flags: Vec<imap::types::Flag> = if draft {
        vec![imap::types::Flag::Seen, imap::types::Flag::Draft]
    } else {
        vec![imap::types::Flag::Seen]
    };
    s.append_with_flags(folder, raw, &flags).map_err(err)?;
    Ok(())
}
