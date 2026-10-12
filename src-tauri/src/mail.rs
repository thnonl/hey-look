use crate::db::{err, Account, R};
use mail_parser::{Address, MessageParser, MimeHeaders};
use std::collections::HashMap;

pub type Sess = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

pub const ROLES: [&str; 6] = ["inbox", "sent", "drafts", "archive", "trash", "junk"];

pub fn connect(acc: &Account, password: &str) -> R<Sess> {
    let tls = native_tls::TlsConnector::builder().build().map_err(err)?;
    let host = acc.imap_host.as_str();
    let addr = (host, acc.imap_port);
    let client = if acc.imap_ssl {
        imap::connect(addr, host, &tls).map_err(err)?
    } else {
        imap::connect_starttls(addr, host, &tls).map_err(err)?
    };
    client
        .login(&acc.username, password)
        .map_err(|e| format!("IMAP login failed: {}", e.0))
}

/// role -> real IMAP folder name
pub fn discover_folders(s: &mut Sess) -> R<HashMap<String, String>> {
    use imap::types::NameAttribute as A;
    let names = s.list(Some(""), Some("*")).map_err(err)?;
    let mut map: HashMap<String, String> = HashMap::new();
    map.insert("inbox".into(), "INBOX".into());
    for n in names.iter() {
        let name = n.name().to_string();
        let lower = name.to_lowercase();
        let mut role: Option<&str> = None;
        for a in n.attributes() {
            if let A::Custom(c) = a {
                role = match c.to_lowercase().as_str() {
                    "\\sent" => Some("sent"),
                    "\\drafts" => Some("drafts"),
                    "\\archive" | "\\all" => Some("archive"),
                    "\\trash" => Some("trash"),
                    "\\junk" => Some("junk"),
                    _ => role,
                };
            }
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
        if let Some(r) = role {
            map.entry(r.to_string()).or_insert(name);
        }
    }
    Ok(map)
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
    pub has_attach: bool,
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
    a.map(|a| {
        a.iter()
            .filter_map(|x| x.address.as_ref().map(|s| s.to_string()))
            .collect()
    })
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
    let html = m.body_html(0).map(|s| s.to_string());
    let text = m.body_text(0).map(|s| s.to_string());
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
        has_attach: m.attachments().any(|a| a.attachment_name().is_some()),
        list_unsub: m.header_raw("List-Unsubscribe").map(|s| s.trim().to_string()),
        list_unsub_post: m.header_raw("List-Unsubscribe-Post").is_some(),
    })
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
        let fl = s
            .uid_fetch(format!("{min_known_uid}:{max_known_uid}"), "(UID FLAGS)")
            .map_err(err)?;
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

pub fn append(s: &mut Sess, folder: &str, raw: &[u8]) -> R<()> {
    s.append_with_flags(folder, raw, &[imap::types::Flag::Seen]).map_err(err)?;
    Ok(())
}
