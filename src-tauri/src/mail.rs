use crate::db::{err, Account, R};
use base64::Engine;
use mail_parser::{Address, MessageParser, MimeHeaders, PartType};
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

/// Opening the connection may take this long (per resolved address).
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// A read or write on the socket that makes no progress for this long fails: a server that stops answering in the middle of a
/// big FETCH (Gmail does that when it throttles) gives an error instead of freezing the sync forever.
const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn tcp(host: &str, port: u16) -> R<std::net::TcpStream> {
    use std::net::ToSocketAddrs;
    let mut last: Option<std::io::Error> = None;
    for addr in (host, port).to_socket_addrs().map_err(err)? {
        match std::net::TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                // set on the socket under TLS, so it covers the handshake and every later read / write
                s.set_read_timeout(Some(IO_TIMEOUT)).map_err(err)?;
                s.set_write_timeout(Some(IO_TIMEOUT)).map_err(err)?;
                return Ok(s);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.map(err).unwrap_or_else(|| format!("cannot resolve {host}")))
}

/// A failure while the connection is being secured (STARTTLS refused or failed, the SSL/TLS handshake failed), in words (QA BUG-M1:
/// a server without encryption answered "Bad Response: Invalid command." and the person could not tell that the app only connects over
/// an encrypted connection). A certificate that is not trusted is a different matter with its own advice and is left as it is.
pub fn secure_connection_error(host: &str, port: u16, raw: &str) -> String {
    let l = raw.to_lowercase();
    if l.contains("certificate") || l.contains("verify") || l.contains("hostname") || l.contains("expired") {
        return raw.to_string();
    }
    let server: String = raw.trim().chars().take(120).collect();
    format!(
        "Couldn\u{2019}t start a secure connection to {host}:{port}. Hey Look! connects only with SSL/TLS or STARTTLS. Check the port and the security setting. (Server: {server})"
    )
}

/// Whether an error text is the hint of `secure_connection_error`.
pub fn is_secure_connection_error(text: &str) -> bool {
    text.starts_with("Couldn\u{2019}t start a secure connection to ")
}

/// Whether an SMTP error text is a failure of the TLS step (lettre words it as "tls", "starttls" or "handshake" errors).
pub fn is_tls_step_failure(raw: &str) -> bool {
    let l = raw.to_lowercase();
    ["tls", "starttls", "handshake", "wrong version", "ssl"].iter().any(|k| l.contains(k))
}

/// `secret` is the password, or the OAuth access token when `acc.auth` is an `oauth_*` method.
pub fn connect(acc: &Account, secret: &str) -> R<Sess> {
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(acc.tls_insecure)
        .danger_accept_invalid_hostnames(acc.tls_insecure)
        .build()
        .map_err(err)?;
    let host = acc.imap_host.as_str();
    let sock = tcp(host, acc.imap_port)?;
    let client = if acc.imap_ssl {
        let mut c = imap::Client::new(tls.connect(host, sock).map_err(|e| secure_connection_error(host, acc.imap_port, &e.to_string()))?);
        c.read_greeting().map_err(err)?;
        c
    } else {
        let mut c = imap::Client::new(sock);
        c.read_greeting().map_err(err)?;
        c.secure(host, &tls).map_err(|e| secure_connection_error(host, acc.imap_port, &e.to_string()))?
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

#[cfg(test)]
mod connect_tests {
    use super::*;

    #[test]
    fn a_failed_secure_connection_is_explained_and_a_bad_certificate_is_left_alone() {
        let m = secure_connection_error("mail.example.com", 143, "Bad Response: Invalid command.");
        assert_eq!(
            m,
            "Couldn\u{2019}t start a secure connection to mail.example.com:143. Hey Look! connects only with SSL/TLS or STARTTLS. Check the port and the security setting. (Server: Bad Response: Invalid command.)"
        );
        // the server's words are cut at 120 characters
        let long = "x".repeat(300);
        assert!(secure_connection_error("h", 1, &long).ends_with(&format!("(Server: {})", "x".repeat(120))));
        // an untrusted certificate keeps its own advice
        assert_eq!(secure_connection_error("h", 993, "certificate verify failed"), "certificate verify failed");
        assert!(is_tls_step_failure("error:0A00010B:SSL routines:wrong version number") && is_tls_step_failure("invalid tls handshake"));
        assert!(!is_tls_step_failure("connection refused"));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttMeta {
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: usize,
    /// The part carries a Content-ID (embedded picture or other cid part).
    #[serde(default)]
    pub inline: bool,
    /// Content-ID without angle brackets.
    #[serde(default)]
    pub cid: Option<String>,
    /// The HTML body refers to the part as `cid:<cid>`.
    #[serde(default)]
    pub referenced: bool,
}

/// Inline pictures up to this size are embedded in the stored HTML at sync time. Larger ones stay as `cid:`
/// references and are fetched on demand (`inline_part`), so nothing is dropped.
pub const INLINE_SYNC_MAX: usize = 2_000_000;

fn part_cid(part: &mail_parser::MessagePart) -> Option<String> {
    part.content_id().map(|c| c.trim().trim_matches(['<', '>']).to_string()).filter(|c| !c.is_empty())
}

fn part_mime(part: &mail_parser::MessagePart) -> String {
    part.content_type()
        .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("octet-stream")))
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// The bytes of an attachment part as they were sent. mail-parser turns text/* parts into UTF-8 text (charset conversion, lossy
/// for bytes that are not valid in it), so a text attachment is decoded from its raw body again (base64 and quoted-printable);
/// every other part is returned as parsed.
fn part_data<'a>(raw: &'a [u8], part: &'a mail_parser::MessagePart<'_>) -> std::borrow::Cow<'a, [u8]> {
    if matches!(part.body, PartType::Text(_) | PartType::Html(_)) {
        if let Some(body) = raw.get(part.raw_body_offset() as usize..part.raw_end_offset() as usize) {
            let decoded = match part.content_transfer_encoding().map(|e| e.to_ascii_lowercase()).as_deref() {
                Some("base64") => mail_parser::decoders::base64::base64_decode(body),
                Some("quoted-printable") => mail_parser::decoders::quoted_printable::quoted_printable_decode(body),
                _ => None,
            };
            if let Some(d) = decoded {
                return std::borrow::Cow::Owned(d);
            }
        }
    }
    std::borrow::Cow::Borrowed(part.contents())
}

fn default_name(i: usize, mime: &str) -> String {
    match mime.strip_prefix("image/") {
        Some(ext) => format!("picture-{}.{}", i + 1, ext.split(['+', ';']).next().unwrap_or("img")),
        None => format!("attachment-{}", i + 1),
    }
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
    /// pgpmail::FLAG_ENCRYPTED | FLAG_SIGNED
    pub pgp: u8,
    /// the raw message, kept only for PGP messages (decrypted at view time, never stored decrypted)
    pub pgp_raw: Option<Vec<u8>>,
    /// iCalendar text of an invitation (text/calendar part or .ics attachment)
    pub ics: Option<String>,
    /// lowercase iMIP method of that calendar data (request, reply, cancel, publish, ...)
    pub cal_method: Option<String>,
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
    let mut text = m.body_text(0).map(|s| s.to_string());

    // Every part is kept (never silently dropped). Referenced inline pictures up to INLINE_SYNC_MAX are embedded
    // as data: URIs; the rest keep their cid: reference and are loaded on demand.
    let mut attachments = vec![];
    for (i, part) in m.attachments().enumerate() {
        let mime = part_mime(part);
        let size = part_data(raw, part).len();
        let cid = part_cid(part);
        let referenced = match (&cid, &html) {
            (Some(c), Some(h)) => !cid_ref_spans(h, c).is_empty(),
            _ => false,
        };
        if let (true, Some(c), Some(h)) = (referenced && mime.starts_with("image/") && size <= INLINE_SYNC_MAX, &cid, html.as_mut()) {
            let uri = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(part.contents()));
            *h = replace_cid_refs(h, c, &uri);
        }
        let name = part.attachment_name().map(|s| s.to_string()).unwrap_or_else(|| default_name(i, &mime));
        attachments.push(AttMeta { index: i, name, mime, size, inline: cid.is_some(), cid, referenced });
    }

    // PGP: encrypted mail keeps no readable body in the database; signed mail drops its signature part
    let (pgp, keep) = crate::pgpmail::flags_for(raw, text.as_deref());
    let mut snippet_override = None;
    if pgp & crate::pgpmail::FLAG_ENCRYPTED != 0 {
        html = None;
        text = None;
        attachments.clear();
        snippet_override = Some("Encrypted message".to_string());
    } else if pgp & crate::pgpmail::FLAG_SIGNED != 0 {
        attachments.retain(|a| a.mime != "application/pgp-signature");
    }

    // calendar invitations: keep the iCalendar text (never for encrypted mail, which is read after decrypting)
    let ics = if pgp & crate::pgpmail::FLAG_ENCRYPTED != 0 { None } else { extract_ics(&m) };
    let cal = ics.as_deref().and_then(|t| crate::ical::parse(t).ok());
    let cal_method = cal.as_ref().map(|c| c.method.clone().unwrap_or_else(|| "PUBLISH".into()).to_ascii_lowercase());

    // the snippet comes from a real text/plain part, else from the visible text of the HTML (never from the HTML-to-text
    // conversion of the parser, which can let style sheet text through)
    let real_text = m.text_body.first().and_then(|i| m.parts.get(*i as usize)).and_then(|p| match &p.body {
        PartType::Text(t) => Some(t.to_string()),
        _ => None,
    });
    let mut basis = crate::snippet::make(real_text.as_deref(), html.as_deref());
    if basis.is_empty() {
        basis = text.as_deref().map(crate::snippet::clean_text).unwrap_or_default();
    }
    if basis.trim().is_empty() {
        if let Some(ev) = cal.as_ref().and_then(|c| c.events.first()) {
            basis = invite_snippet(ev);
        }
    }
    let snippet: String = snippet_override.unwrap_or_else(|| crate::snippet::truncate_words(&basis));
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
        pgp,
        pgp_raw: keep.then(|| raw.to_vec()),
        ics,
        cal_method,
    })
}

/// Cap for stored calendar text.
const ICS_MAX: usize = 512 * 1024;

/// "Wed 14 Oct 10:00–11:00 · Room 4B" (this computer's time zone) for messages that only carry an invitation.
fn invite_snippet(ev: &crate::ical::IcsEvent) -> String {
    use chrono::{Local, TimeZone};
    let at = |t: i64| Local.timestamp_opt(t, 0).single();
    let mut out = match (at(ev.start), at(ev.end)) {
        (Some(s), Some(e)) if ev.all_day => format!("{} · All day{}", s.format("%a %-d %b"), if e.date_naive() > s.date_naive() + chrono::Duration::days(1) { " (multi-day)" } else { "" }),
        (Some(s), Some(e)) => format!("{} {}–{}", s.format("%a %-d %b"), s.format("%H:%M"), e.format("%H:%M")),
        _ => String::new(),
    };
    if let Some(l) = &ev.location {
        out.push_str(&format!(" · {l}"));
    }
    out
}

/// The first iCalendar document of a message: a text/calendar part (or application/ics), or an attached .ics file.
/// A METHOD given only in the Content-Type is copied into the text.
pub fn extract_ics(m: &mail_parser::Message) -> Option<String> {
    for part in m.parts.iter() {
        let ct = part.content_type();
        let is_cal = ct
            .map(|c| {
                let (a, b) = (c.ctype().to_ascii_lowercase(), c.subtype().unwrap_or("").to_ascii_lowercase());
                (a == "text" && b == "calendar") || (a == "application" && (b == "ics" || b == "calendar"))
            })
            .unwrap_or(false);
        let named = part.attachment_name().map(|n| n.to_ascii_lowercase().ends_with(".ics")).unwrap_or(false);
        if !is_cal && !named {
            continue;
        }
        let bytes = part.contents();
        if bytes.is_empty() || bytes.len() > ICS_MAX {
            continue;
        }
        let mut text = String::from_utf8_lossy(bytes).into_owned();
        if !text.to_ascii_uppercase().contains("BEGIN:VCALENDAR") {
            continue;
        }
        if let Some(method) = ct.and_then(|c| c.attribute("method")) {
            let upper = text.to_ascii_uppercase();
            if !upper.contains("\nMETHOD:") {
                if let Some(i) = upper.find("BEGIN:VCALENDAR") {
                    let eol = text[i..].find('\n').map(|n| i + n + 1).unwrap_or(text.len());
                    text.insert_str(eol, &format!("METHOD:{}\r\n", method.to_ascii_uppercase()));
                }
            }
        }
        return Some(text);
    }
    None
}

/// Raw attachment bytes for `index` (position among the parsed attachment parts).
pub fn attachment_bytes(raw: &[u8], index: usize) -> R<(String, Vec<u8>)> {
    let m = MessageParser::default().parse(raw).ok_or("cannot parse message")?;
    let part = m.attachments().nth(index).ok_or("attachment not found")?;
    // same fallback name as the metadata (AttMeta.name), so a saved file and its card agree
    let name = part.attachment_name().map(|s| s.to_string()).unwrap_or_else(|| default_name(index, &part_mime(part)));
    Ok((name, part_data(raw, part).into_owned()))
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

/// The `count` highest UIDs below `below` among `uids`, ascending, and whether that leaves nothing older (the server has no
/// UID under the lowest one returned). Works on the UIDs that really exist, so holes in the numbering (Gmail's INBOX loses
/// archived mail) never make a page come up empty while older mail is still there.
pub fn pick_older(uids: impl IntoIterator<Item = u32>, below: u32, count: usize) -> (Vec<u32>, bool) {
    let mut older: Vec<u32> = uids.into_iter().filter(|u| *u < below).collect();
    older.sort_unstable();
    older.dedup();
    let exhausted = older.len() <= count;
    let from = older.len().saturating_sub(count);
    (older.split_off(from), exhausted)
}

/// IMAP sequence set for ascending UIDs: runs become `a:b`, e.g. [10,11,12,500] -> "10:12,500".
pub fn uid_set(uids: &[u32]) -> String {
    let mut parts: Vec<String> = vec![];
    let mut i = 0;
    while i < uids.len() {
        let mut j = i;
        while j + 1 < uids.len() && uids[j + 1] == uids[j] + 1 {
            j += 1;
        }
        parts.push(if j > i { format!("{}:{}", uids[i], uids[j]) } else { uids[i].to_string() });
        i = j + 1;
    }
    parts.join(",")
}

/// The next `count` messages older than `below_uid` (the lowest UID already stored): `UID SEARCH` for the UIDs that exist
/// below it, then one `UID FETCH` of exactly the highest `count` of them. Returns the parsed messages and whether the folder
/// has nothing older than the lowest one returned.
pub fn fetch_older(s: &mut Sess, folder: &str, below_uid: u32, count: usize) -> R<(Vec<Parsed>, bool)> {
    s.select(folder).map_err(err)?;
    if below_uid <= 1 || count == 0 {
        return Ok((vec![], below_uid <= 1));
    }
    let all = s.uid_search(format!("UID 1:{}", below_uid - 1)).map_err(err)?;
    let (pick, exhausted) = pick_older(all, below_uid, count);
    if pick.is_empty() {
        return Ok((vec![], true));
    }
    let fetched = s.uid_fetch(uid_set(&pick), "(UID FLAGS INTERNALDATE BODY.PEEK[])").map_err(err)?;
    let mut out = vec![];
    for f in fetched.iter() {
        let (Some(uid), Some(body)) = (f.uid, f.body()) else { continue };
        if pick.binary_search(&uid).is_err() {
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
    Ok((out, exhausted))
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

/// One inline (cid) part of a raw message: (mime, bytes, file name).
pub fn inline_part(raw: &[u8], cid: &str) -> R<(String, Vec<u8>, String)> {
    let m = MessageParser::default().parse(raw).ok_or("cannot parse message")?;
    for (i, part) in m.attachments().enumerate() {
        if part_cid(part).as_deref() == Some(cid) {
            let mime = part_mime(part);
            let name = part.attachment_name().map(|s| s.to_string()).unwrap_or_else(|| default_name(i, &mime));
            return Ok((mime, part_data(raw, part).into_owned(), name));
        }
    }
    Err(format!("picture missing from this message (cid:{cid})"))
}

/// Where `cid:<cid>` is used in the html as a whole reference (so `cid:logo@x` does not match inside `cid:logo@xy`).
fn cid_ref_spans(html: &str, cid: &str) -> Vec<(usize, usize)> {
    let needle = format!("cid:{cid}");
    let lower_html = html.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    lower_html
        .match_indices(&lower_needle)
        .filter(|(i, _)| {
            // the reference ends at a quote, bracket, space or the end of the text (not inside a longer id)
            let after = lower_html[i + lower_needle.len()..].chars().next();
            after.map(|c| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | '>' | '<' | ';' | ',' | '&')).unwrap_or(true)
        })
        .map(|(i, _)| (i, i + needle.len()))
        .collect()
}

fn replace_cid_refs(html: &str, cid: &str, uri: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut last = 0;
    for (a, b) in cid_ref_spans(html, cid) {
        out.push_str(&html[last..a]);
        out.push_str(uri);
        last = b;
    }
    out.push_str(&html[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_page_is_picked_from_the_uids_that_exist_so_gaps_do_not_matter() {
        // sparse numbering: nothing between 11 and 500 (Gmail's INBOX after archiving)
        let uids = [10, 11, 500, 501, 900];
        assert_eq!(pick_older(uids, 1000, 2), (vec![501, 900], false));
        assert_eq!(pick_older(uids, 501, 2), (vec![11, 500], false));
        assert_eq!(pick_older(uids, 500, 2), (vec![10, 11], true), "exactly two left: nothing older afterwards");
        assert_eq!(pick_older(uids, 1000, 5), (vec![10, 11, 500, 501, 900], true));
        assert_eq!(pick_older(uids, 1000, 50), (vec![10, 11, 500, 501, 900], true));
        assert_eq!(pick_older(uids, 10, 50), (vec![], true), "nothing below the lowest stored uid");
        assert_eq!(pick_older([7, 7, 3], 8, 1), (vec![7], false), "duplicates are counted once");
        assert_eq!(pick_older(Vec::<u32>::new(), 100, 50), (vec![], true));
    }

    #[test]
    fn uid_sets_join_runs() {
        assert_eq!(uid_set(&[]), "");
        assert_eq!(uid_set(&[501, 900]), "501,900");
        assert_eq!(uid_set(&[10, 11, 12, 500, 502, 503]), "10:12,500,502:503");
        assert_eq!(uid_set(&[5]), "5");
    }

    #[test]
    fn a_cid_that_is_a_prefix_of_another_does_not_get_the_wrong_picture() {
        // F14: replacing `cid:logo@x` must leave `cid:logo@xy` alone
        let html = r#"<img src="cid:logo@x"><img src='cid:logo@xy'><div style="background:url(cid:logo@x)"></div><img src="CID:logo@x">"#;
        let out = replace_cid_refs(html, "logo@x", "data:1");
        assert_eq!(out, r#"<img src="data:1"><img src='cid:logo@xy'><div style="background:url(data:1)"></div><img src="data:1">"#);
        assert!(cid_ref_spans("<img src=\"cid:logo@xy\">", "logo@x").is_empty());
        assert_eq!(cid_ref_spans("cid:abc", "abc").len(), 1, "reference at the very end of the text");
        // multi-byte text around the reference
        assert_eq!(replace_cid_refs("Đỗ <img src=\"cid:a\"> é", "a", "U"), "Đỗ <img src=\"U\"> é");
    }

    fn related_msg(cid: &str, png: &[u8], extra_part: &str, html_ref: bool) -> Vec<u8> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let img = if html_ref { format!("<img src=\"cid:{cid}\" alt=\"logo\">") } else { "no pictures".into() };
        format!(
            "From: Ann <ann@example.com>\r\nTo: me@example.com\r\nSubject: Pics\r\nMessage-ID: <m1@example.com>\r\nDate: Mon, 12 Oct 2026 09:00:00 +0000\r\n\
MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"MIX\"\r\n\r\n\
--MIX\r\nContent-Type: multipart/related; boundary=\"REL\"\r\n\r\n\
--REL\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi</p>{img}\r\n\
--REL\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <{cid}>\r\nContent-Disposition: inline\r\n\r\n{b64}\r\n\
--REL--\r\n{extra_part}\
--MIX--\r\n"
        )
        .into_bytes()
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 1, 2, 3, 4];

    #[test]
    fn small_referenced_picture_is_embedded_and_listed() {
        let raw = related_msg("logo@x", PNG, "", true);
        let p = parse(1, &raw, true, false, 0).expect("parses");
        let html = p.html.expect("html body");
        assert!(html.contains("data:image/png;base64,"), "cid replaced with data uri: {html}");
        assert!(!html.contains("cid:logo@x"));
        assert_eq!(p.attachments.len(), 1);
        let a = &p.attachments[0];
        assert!(a.inline && a.referenced);
        assert_eq!(a.cid.as_deref(), Some("logo@x"));
        assert_eq!(a.name, "picture-1.png", "pictures without a file name get a name");
    }

    #[test]
    fn large_referenced_picture_is_kept_as_cid_not_dropped() {
        let big = vec![7u8; INLINE_SYNC_MAX + 10];
        let raw = related_msg("big@x", &big, "", true);
        let p = parse(2, &raw, true, false, 0).expect("parses");
        let html = p.html.expect("html body");
        assert!(html.contains("cid:big@x"), "large picture stays a cid reference");
        assert_eq!(p.attachments.len(), 1, "large picture is still listed");
        assert_eq!(p.attachments[0].size, big.len());
        assert!(p.attachments[0].referenced);
        let (mime, bytes, _) = inline_part(&raw, "big@x").expect("fetchable on demand");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, big);
    }

    #[test]
    fn unreferenced_inline_part_is_listed_as_attachment() {
        let extra = "--MIX\r\nContent-Type: image/jpeg; name=\"whiteboard.jpg\"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <orphan@x>\r\nContent-Disposition: inline; filename=\"whiteboard.jpg\"\r\n\r\naGVsbG8=\r\n";
        let raw = related_msg("logo@x", PNG, extra, true);
        let p = parse(3, &raw, true, false, 0).expect("parses");
        let orphan = p.attachments.iter().find(|a| a.cid.as_deref() == Some("orphan@x")).expect("orphan kept");
        assert!(!orphan.referenced);
        assert!(orphan.inline);
        assert_eq!(orphan.name, "whiteboard.jpg");
        assert!(p.html.unwrap().contains("data:image/png"), "referenced logo still embedded");
    }

    #[test]
    fn text_only_message_with_inline_picture_keeps_it() {
        let raw = format!(
            "From: Ann <ann@example.com>\r\nTo: me@example.com\r\nSubject: Plain\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"R\"\r\n\r\n\
--R\r\nContent-Type: text/plain\r\n\r\nSee attached picture\r\n\
--R\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <p@x>\r\n\r\n{}\r\n--R--\r\n",
            base64::engine::general_purpose::STANDARD.encode(PNG)
        );
        let p = parse(4, raw.as_bytes(), true, false, 0).expect("parses");
        assert!(!p.html.unwrap_or_default().contains("cid:p@x"), "nothing references the picture");
        assert_eq!(p.attachments.len(), 1, "inline part of a text-only message is listed");
        assert!(!p.attachments[0].referenced);
    }

    #[test]
    fn attachment_bytes_and_inline_part_agree_on_index() {
        let raw = related_msg("logo@x", PNG, "", true);
        let (name, bytes) = attachment_bytes(&raw, 0).expect("index 0");
        assert_eq!(bytes, PNG);
        assert_eq!(name, "picture-1.png");
        assert!(inline_part(&raw, "missing@x").is_err());
    }

    const ICS_BODY: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u1@x\r\nDTSTART:20261014T100000Z\r\nDTEND:20261014T110000Z\r\nSUMMARY:Sync\r\nLOCATION:Room 4B\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn calendar_alternative_is_extracted_and_method_comes_from_the_content_type() {
        let raw = format!(
            "From: Mai <mai@contoso.com>\r\nTo: me@example.com\r\nSubject: Invitation: Sync\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"B\"\r\n\r\n\
--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMai invites you.\r\n\
--B\r\nContent-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\n{ICS_BODY}\
--B--\r\n"
        );
        let p = parse(1, raw.as_bytes(), false, false, 0).unwrap();
        assert_eq!(p.cal_method.as_deref(), Some("request"), "METHOD only in the Content-Type");
        assert!(p.ics.as_deref().unwrap().contains("METHOD:REQUEST"));
        assert_eq!(p.text.as_deref().map(str::trim), Some("Mai invites you."));
        assert!(crate::ical::parse(p.ics.as_deref().unwrap()).is_ok());
    }

    #[test]
    fn invitation_only_message_gets_a_readable_snippet_and_an_attached_ics_is_found() {
        let b64 = base64::engine::general_purpose::STANDARD.encode(ICS_BODY);
        let raw = format!(
            "From: Mai <mai@contoso.com>\r\nTo: me@example.com\r\nSubject: Event\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"M\"\r\n\r\n\
--M\r\nContent-Type: application/ics; name=\"invite.ics\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"invite.ics\"\r\n\r\n{b64}\r\n\
--M--\r\n"
        );
        let p = parse(2, raw.as_bytes(), false, false, 0).unwrap();
        assert!(p.ics.is_some(), "an .ics attachment is read as an invitation");
        assert_eq!(p.cal_method.as_deref(), Some("publish"), "no METHOD at all is a plain event file");
        assert!(p.snippet.contains("Room 4B") && p.snippet.contains(':'), "snippet shows when and where: {}", p.snippet);
        assert_eq!(p.attachments.len(), 1, "the file stays in the attachment list");
        assert_eq!(p.attachments[0].name, "invite.ics");
    }

    #[test]
    fn messages_without_calendar_data_and_junk_calendar_parts_have_no_ics() {
        let raw = related_msg("logo@x", PNG, "", true);
        let p = parse(3, &raw, true, false, 0).unwrap();
        assert!(p.ics.is_none() && p.cal_method.is_none());
        let raw = "From: a@b.c\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"M\"\r\n\r\n--M\r\nContent-Type: text/plain\r\n\r\nhi\r\n--M\r\nContent-Type: text/calendar; name=\"x.ics\"\r\n\r\nthis is not ical\r\n--M--\r\n";
        assert!(parse(4, raw.as_bytes(), true, false, 0).unwrap().ics.is_none());
    }

    #[test]
    fn html_only_newsletter_snippet_has_no_style_sheet_text() {
        let html = "<html><head><title>News</title><!--[if mso]><style>td{x:y}</style><![endif]--><style type=\"text/css\">#outlook a { padding: 0; } body{margin:0}</style></head><body><div style=\"display:none\">Preview words &zwnj;&nbsp;&zwnj;&nbsp;&#8199;</div><p>Main   content</p></body></html>";
        let raw = format!("From: a@b.c
Subject: News
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

{html}
");
        let p = parse(10, raw.as_bytes(), false, false, 0).unwrap();
        assert_eq!(p.snippet, "Preview words Main content");
        // with a real text/plain alternative that one is used
        let alt = format!("From: a@b.c
Subject: News
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary=\"B\"

--B
Content-Type: text/plain; charset=utf-8

Plain   version
here
--B
Content-Type: text/html; charset=utf-8

{html}
--B--
");
        assert_eq!(parse(11, alt.as_bytes(), false, false, 0).unwrap().snippet, "Plain version here");
        // an empty text/plain part falls back to the HTML
        let empty = format!("From: a@b.c
Subject: News
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary=\"B\"

--B
Content-Type: text/plain; charset=utf-8

 
--B
Content-Type: text/html; charset=utf-8

{html}
--B--
");
        assert_eq!(parse(12, empty.as_bytes(), false, false, 0).unwrap().snippet, "Preview words Main content");
    }
}
