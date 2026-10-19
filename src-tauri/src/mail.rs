use crate::db::{err, Account, R};
use base64::Engine;
use mail_parser::{Address, MessageParser, MimeHeaders, PartType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};

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
pub(crate) const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

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

pub(crate) const SILENT_TLS: &str = "no answer to the TLS handshake";
pub(crate) const SILENT_STARTTLS: &str = "no answer to the STARTTLS request";

/// Why a bounded connection probe (`probe_tls_handshake`, `probe_imap_starttls`, and the SMTP one in smtp.rs) gave up.
pub(crate) enum Probe {
    /// The server accepted the connection but did not answer in time while the connection was being secured (the text says what
    /// was waited for: the TLS handshake, or the greeting and the STARTTLS reply).
    Silent(&'static str),
    /// The connection itself timed out (the text is the I/O error).
    ConnectTimedOut(String),
}

impl Probe {
    /// The error text: a silent server gets the secure connection hint, a timed out connection the usual connection words, put into
    /// the caller’s own phrasing by `wrap`.
    pub(crate) fn explain(self, host: &str, port: u16, wrap: impl Fn(&str) -> String) -> String {
        match self {
            Probe::Silent(what) => secure_connection_error(host, port, what),
            Probe::ConnectTimedOut(e) => wrap(&format!("Connection error: {e}")),
        }
    }
}

/// Run the SSL/TLS handshake once on a socket that has read and write timeouts and throw the result away. A server that accepts the
/// connection and then stays silent (a plain port, a firewall that swallows packets) is `Probe::Silent`; anything that is not a timeout
/// (refused, a handshake that failed, an untrusted certificate) is `Ok` and left to the real connection, which words it as before.
pub(crate) fn probe_tls_handshake(host: &str, port: u16, insecure: bool, timeout: std::time::Duration) -> Result<(), Probe> {
    use std::net::ToSocketAddrs;
    let Ok(connector) = native_tls::TlsConnector::builder().danger_accept_invalid_certs(insecure).danger_accept_invalid_hostnames(insecure).build() else { return Ok(()) };
    let Ok(addrs) = (host, port).to_socket_addrs() else { return Ok(()) };
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
        let _ = sock.set_read_timeout(Some(timeout));
        let _ = sock.set_write_timeout(Some(timeout));
        let started = std::time::Instant::now();
        return match connector.connect(host, sock) {
            Ok(mut stream) => {
                let _ = stream.shutdown();
                Ok(())
            }
            Err(native_tls::HandshakeError::WouldBlock(_)) => Err(Probe::Silent(SILENT_TLS)),
            Err(native_tls::HandshakeError::Failure(e)) => {
                use std::error::Error as _;
                let io_timeout = e.source().and_then(|s| s.downcast_ref::<std::io::Error>()).is_some_and(|io| matches!(io.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock));
                // platforms word a read that timed out differently, so the time the handshake took counts too
                if io_timeout || started.elapsed() >= timeout.mul_f32(0.9) { Err(Probe::Silent(SILENT_TLS)) } else { Ok(()) }
            }
        };
    }
    timed_out.map_or(Ok(()), |e| Err(Probe::ConnectTimedOut(e)))
}

/// The STARTTLS probe of an IMAP server: the greeting, CAPABILITY and the STARTTLS request are run once on a socket whose reads are
/// bound by one deadline (`timeout` for all three together), and the result is thrown away. `Probe::Silent` when the server accepts the
/// connection and then stops answering (a port that waits for the client, such as an implicit TLS port used with STARTTLS, or a
/// firewall that swallows packets); anything else (a refusal, a reply that is not IMAP, a server without STARTTLS) is `Ok` and left to
/// the real connection, which words it as before.
fn probe_imap_starttls(host: &str, port: u16, timeout: std::time::Duration) -> Result<(), Probe> {
    use std::io::BufRead;
    use std::net::ToSocketAddrs;
    let Ok(addrs) = (host, port).to_socket_addrs() else { return Ok(()) };
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
        let mut input = std::io::BufReader::new(sock);
        // The next line (`tag` None) or the next line that starts with `tag`. Err(()): the server did not answer in time.
        // Ok(None): it went away or sent something that is not text.
        let read = |input: &mut std::io::BufReader<std::net::TcpStream>, tag: Option<&str>| -> Result<Option<String>, ()> {
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    return Err(());
                }
                let _ = input.get_ref().set_read_timeout(Some(left));
                let mut line = String::new();
                match input.read_line(&mut line) {
                    Ok(0) => return Ok(None),
                    Ok(_) => match tag {
                        None => return Ok(Some(line)),
                        Some(t) if line.starts_with(t) => return Ok(Some(line)),
                        Some(_) => {}
                    },
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) => return Err(()),
                    Err(_) => return Ok(None),
                }
            }
        };
        let silent = || Err(Probe::Silent(SILENT_STARTTLS));
        match read(&mut input, None) {
            Err(()) => return silent(),
            Ok(Some(g)) if g.starts_with("* OK") => {}
            _ => return Ok(()),
        }
        for (command, tag) in [("hl1 CAPABILITY\r\n", "hl1 "), ("hl2 STARTTLS\r\n", "hl2 ")] {
            if out.write_all(command.as_bytes()).is_err() {
                return Ok(());
            }
            match read(&mut input, Some(tag)) {
                Err(()) => return silent(),
                Ok(Some(r)) if r.starts_with(&format!("{tag}OK")) => {}
                _ => return Ok(()),
            }
        }
        let _ = out.write_all(b"hl3 LOGOUT\r\n");
        return Ok(());
    }
    timed_out.map_or(Ok(()), |e| Err(Probe::ConnectTimedOut(e)))
}

/// The connection check of an account being added (and only that: a normal sync does not run it): before the real login the
/// connection is secured once under `timeout` for the whole of it, so a server that cannot be secured and says nothing gets the secure
/// connection hint after `timeout`, not the error of a 60 s socket timeout that reads as "the mail server did not respond". These are
/// the words the SMTP side uses.
pub fn probe_secure_connection(acc: &Account, timeout: std::time::Duration) -> R<()> {
    let probed = if acc.imap_ssl {
        probe_tls_handshake(&acc.imap_host, acc.imap_port, acc.tls_insecure, timeout)
    } else {
        probe_imap_starttls(&acc.imap_host, acc.imap_port, timeout)
    };
    probed.map_err(|p| p.explain(&acc.imap_host, acc.imap_port, |detail| detail.to_string()))
}

/// `secret` is the password, or the OAuth access token when `acc.auth` is an `oauth_*` method.
pub fn connect(acc: &Account, secret: &str) -> R<Sess> {
    connect_with_socket(acc, secret).map(|(s, _)| s)
}

/// `connect`, plus a second handle on the same socket: `idle.rs` shuts it down to end a read that blocks (stop, quit, a peer that
/// went silent), and sets its read timeout again after the IDLE wait (the imap crate clears it).
pub fn connect_with_socket(acc: &Account, secret: &str) -> R<(Sess, std::net::TcpStream)> {
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(acc.tls_insecure)
        .danger_accept_invalid_hostnames(acc.tls_insecure)
        .build()
        .map_err(err)?;
    let host = acc.imap_host.as_str();
    let sock = tcp(host, acc.imap_port)?;
    let handle = sock.try_clone().map_err(err)?;
    let client = if acc.imap_ssl {
        let mut c = imap::Client::new(tls.connect(host, sock).map_err(|e| secure_connection_error(host, acc.imap_port, &e.to_string()))?);
        c.read_greeting().map_err(err)?;
        c
    } else {
        let mut c = imap::Client::new(sock);
        c.read_greeting().map_err(err)?;
        c.secure(host, &tls).map_err(|e| secure_connection_error(host, acc.imap_port, &e.to_string()))?
    };
    let session = if acc.auth.starts_with("oauth_") {
        client
            .authenticate("XOAUTH2", &XOAuth2 { user: &acc.email, token: secret })
            .map_err(|e| format!("IMAP OAuth login failed: {}", e.0))
    } else {
        client.login(&acc.username, secret).map_err(|e| format!("IMAP login failed: {}", e.0))
    }?;
    Ok((session, handle))
}

/// role -> real IMAP folder name. Standard roles use their plain name, everything else "f:<name>".
pub fn discover_folders<T: Read + Write>(s: &mut imap::Session<T>) -> R<HashMap<String, String>> {
    list_folders(s).map(|l| l.map)
}

/// The server's folders as `discover_folders` maps them, and the hierarchy delimiter of the first folder that has one.
pub struct Listing {
    pub map: HashMap<String, String>,
    pub delimiter: Option<String>,
}

pub fn list_folders<T: Read + Write>(s: &mut imap::Session<T>) -> R<Listing> {
    use imap::types::NameAttribute as A;
    let names = s.list(Some(""), Some("*")).map_err(err)?;
    let delimiter = names.iter().find_map(|n| n.delimiter().map(str::to_string));
    let mut entries: Vec<FolderEntry> = vec![];
    for n in names.iter() {
        let mut e = FolderEntry { name: n.name().to_string(), delimiter: n.delimiter().map(str::to_string), role: None };
        let mut skip = false;
        for a in n.attributes() {
            match a {
                A::NoSelect => skip = true,
                A::Custom(c) => match c.to_lowercase().as_str() {
                    "\\sent" => e.role = Some("sent"),
                    "\\drafts" => e.role = Some("drafts"),
                    "\\archive" | "\\all" => e.role = Some("archive"),
                    "\\trash" => e.role = Some("trash"),
                    "\\junk" => e.role = Some("junk"),
                    "\\flagged" | "\\important" => skip = true,
                    _ => {}
                },
                _ => {}
            }
        }
        if !skip {
            entries.push(e);
        }
    }
    Ok(Listing { map: assign_roles(&entries), delimiter })
}

/// One selectable folder of a LIST answer: its name, the hierarchy delimiter and the role its SPECIAL-USE attribute gives it, if any.
pub(crate) struct FolderEntry {
    pub name: String,
    pub delimiter: Option<String>,
    pub role: Option<&'static str>,
}

/// role -> folder name for the standard roles, and `f:<name>` for every other folder. The server's SPECIAL-USE attributes decide first.
/// A role no attribute names is taken from a folder's name, but only from a name that is a standard one (`role_by_name`) at the top
/// level or just under the INBOX / Gmail namespace, so `Old/Trash`, `Trash-old` or `Archive 2019` stay folders of the person's own.
/// When several folders qualify the shallowest wins, then the first listed.
pub(crate) fn assign_roles(entries: &[FolderEntry]) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    map.insert("inbox".into(), "INBOX".into());
    let mut taken = vec![false; entries.len()];
    let mut pending = vec![];
    for (i, e) in entries.iter().enumerate() {
        if e.name.eq_ignore_ascii_case("INBOX") {
            taken[i] = true;
        } else if let Some(r) = e.role {
            if !map.contains_key(r) {
                map.insert(r.to_string(), e.name.clone());
                taken[i] = true;
            }
        } else {
            pending.push(i);
        }
    }
    for r in ROLES.iter().copied().filter(|r| *r != "inbox") {
        if map.contains_key(r) {
            continue;
        }
        let best = pending.iter().copied().filter(|i| !taken[*i]).filter_map(|i| role_by_name(&entries[i].name, entries[i].delimiter.as_deref()).filter(|(role, _)| *role == r).map(|(_, depth)| (depth, i))).min();
        if let Some((_, i)) = best {
            map.insert(r.to_string(), entries[i].name.clone());
            taken[i] = true;
        }
    }
    for (i, e) in entries.iter().enumerate() {
        if !taken[i] {
            map.insert(format!("f:{}", e.name), e.name.clone());
        }
    }
    map
}

/// The role a folder name stands for when the server flags none, and how deep the folder is (1 = top level, 2 = under a namespace
/// folder). Only a whole name counts: the standard English names and the well-known ones of other languages, case-insensitive, with
/// the accents and the modified UTF-7 of IMAP (`&AOk-` for `é`) taken out of the way. A folder that is deeper than the namespace
/// level, or has anything more in its name (`Trash-old`, `Archive 2019`), is none of them.
fn role_by_name(name: &str, delimiter: Option<&str>) -> Option<(&'static str, usize)> {
    let name = decode_imap_utf7(name);
    let parts: Vec<&str> = match delimiter {
        Some(d) if !d.is_empty() => name.split(d).collect(),
        _ => vec![name.as_str()],
    };
    let depth = match parts.as_slice() {
        [_] => 1,
        [ns, _] if ["inbox", "[gmail]", "[google mail]"].contains(&ns.to_lowercase().as_str()) => 2,
        _ => return None,
    };
    let leaf = parts.last()?.trim().to_lowercase();
    let role = match leaf.as_str() {
        // English
        "sent" | "sent items" | "sent mail" | "sent messages" => "sent",
        "drafts" | "draft" => "drafts",
        "archive" | "archives" => "archive",
        "trash" | "deleted items" | "deleted messages" | "bin" => "trash",
        "junk" | "spam" | "junk e-mail" | "junk email" => "junk",
        // German
        "gesendet" | "gesendete elemente" | "gesendete objekte" => "sent",
        "entwürfe" => "drafts",
        "archiv" => "archive",
        "papierkorb" | "gelöschte elemente" | "gelöschte objekte" => "trash",
        "junk-e-mail" => "junk",
        // French
        "envoyés" | "éléments envoyés" | "messages envoyés" => "sent",
        "brouillons" => "drafts",
        "corbeille" | "éléments supprimés" => "trash",
        "courrier indésirable" | "pourriel" => "junk",
        // Spanish
        "enviados" | "elementos enviados" => "sent",
        "borradores" => "drafts",
        "archivo" => "archive",
        "papelera" | "elementos eliminados" => "trash",
        "correo no deseado" => "junk",
        // Italian
        "posta inviata" | "inviati" => "sent",
        "bozze" => "drafts",
        "archivio" => "archive",
        "cestino" | "posta eliminata" => "trash",
        "posta indesiderata" => "junk",
        // Portuguese
        "itens enviados" | "enviadas" => "sent",
        "rascunhos" => "drafts",
        "arquivo morto" => "archive",
        "lixeira" | "itens excluídos" => "trash",
        "lixo eletrônico" => "junk",
        // Vietnamese
        "thư đã gửi" => "sent",
        "thư nháp" => "drafts",
        "thùng rác" => "trash",
        "thư rác" => "junk",
        _ => return None,
    };
    Some((role, depth))
}

/// IMAP folder names are in modified UTF-7 (RFC 3501 5.1.3): `&` starts a run of UTF-16 in base64 (with `,` for `/`) that `-` ends, and
/// `&-` is a plain `&`. Used only to compare a name; a run that does not decode is left as it was.
fn decode_imap_utf7(s: &str) -> String {
    use base64::Engine;
    if !s.contains('&') {
        return s.to_string();
    }
    let mut parts = s.split('&');
    let mut out = parts.next().unwrap_or("").to_string();
    for part in parts {
        let Some(end) = part.find('-') else {
            out.push('&');
            out.push_str(part);
            continue;
        };
        let (run, rest) = (&part[..end], &part[end + 1..]);
        if run.is_empty() {
            out.push('&');
        } else {
            let decoded = base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(run.replace(',', "/"))
                .ok()
                .filter(|b| b.len() % 2 == 0)
                .and_then(|b| String::from_utf16(&b.chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect::<Vec<_>>()).ok());
            match decoded {
                Some(text) => out.push_str(&text),
                None => {
                    out.push('&');
                    out.push_str(run);
                    out.push('-');
                }
            }
        }
        out.push_str(rest);
    }
    out
}

/// The name to create for a standard role the server lacks, or None for a role that is never created (drafts, junk, custom folders).
/// Archive, Trash and Sent (for the copy of a sent message) use their plain English names. A server that keeps every folder inside the INBOX namespace (`INBOX.Sent`, Courier and
/// older Dovecot setups) gets `INBOX.Archive`: a top-level folder is refused there.
pub fn name_to_create(role: &str, listing: &Listing) -> Option<String> {
    let leaf = match role {
        "archive" => "Archive",
        "trash" => "Trash",
        "sent" => "Sent",
        _ => return None,
    };
    let in_inbox_namespace = listing.delimiter.as_deref().is_some_and(|d| {
        let prefix = format!("INBOX{d}");
        listing.map.values().any(|n| n.len() > prefix.len() && n[..prefix.len()].eq_ignore_ascii_case(&prefix))
    });
    Some(match (&listing.delimiter, in_inbox_namespace) {
        (Some(d), true) => format!("INBOX{d}{leaf}"),
        _ => leaf.to_string(),
    })
}

/// CREATE a folder (and subscribe to it, so other mail programs list it). A server that says the folder is there already is no failure.
pub fn create_folder<T: Read + Write>(s: &mut imap::Session<T>, name: &str) -> R<()> {
    if let Err(e) = s.create(name) {
        let why = e.to_string();
        if !why.to_lowercase().contains("exist") {
            return Err(why);
        }
    }
    let _ = s.subscribe(name);
    Ok(())
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
    /// pgpmail::FLAG_ENCRYPTED | FLAG_SIGNED | FLAG_CONFIDENTIAL
    pub pgp: u8,
    /// the raw message, kept only for PGP messages (decrypted at view time, never stored decrypted)
    pub pgp_raw: Option<Vec<u8>>,
    /// iCalendar text of an invitation (text/calendar part or .ics attachment)
    pub ics: Option<String>,
    /// lowercase iMIP method of that calendar data (request, reply, cancel, publish, ...)
    pub cal_method: Option<String>,
    /// High / Low as the sender marked it (Importance, X-Priority, X-MSMail-Priority, Priority headers)
    pub importance: crate::importance::Importance,
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

/// Words in a sensitivity label name that make a message confidential.
const LABEL_WORDS: [&str; 3] = ["confidential", "secret", "restricted"];

/// The words of a label name, lower case: split at anything that is not an ASCII letter or digit and between camelCase words
/// ("HighlyConfidential" -> highly, confidential).
fn label_tokens(name: &str) -> Vec<String> {
    let (mut out, mut cur, mut prev_lower) = (vec![], String::new(), false);
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && prev_lower {
            out.push(std::mem::take(&mut cur));
        }
        cur.push(c.to_ascii_lowercase());
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Does a label name call the mail confidential: one of LABEL_WORDS as a word of its own (so "Secretariat" and "Unrestricted"
/// are not), and not negated by the word before it ("Non-Confidential", "Not_Secret", "NotConfidential").
fn label_is_confidential(name: &str) -> bool {
    const NOT: [&str; 4] = ["non", "not", "no", "un"];
    let tokens = label_tokens(name);
    tokens.iter().enumerate().any(|(i, t)| LABEL_WORDS.contains(&t.as_str()) && !(i > 0 && NOT.contains(&tokens[i - 1].as_str())))
}

/// Did the sender mark this message confidential? Outlook's Sensitivity option sends `Sensitivity: Company-Confidential`
/// (Normal / Personal / Private are not enough); Microsoft Purview sensitivity labels add `msip_labels:
/// MSIP_Label_<guid>_Name=Highly Confidential; ...` or a `MSIP_Label_<guid>_Name:` header of their own.
pub fn is_confidential(raw: &[u8]) -> bool {
    let (headers, _) = crate::pgpmail::parse_headers(raw);
    let label = label_is_confidential;
    headers.iter().any(|(name, value)| {
        let n = name.to_ascii_lowercase();
        if n == "sensitivity" {
            matches!(value.trim().to_ascii_lowercase().as_str(), "company-confidential" | "confidential")
        } else if n == "msip_labels" || n == "x-msip_labels" {
            value.split(';').any(|kv| {
                let (k, v) = kv.split_once('=').unwrap_or(("", ""));
                let k = k.trim().to_ascii_lowercase();
                k.starts_with("msip_label_") && k.ends_with("_name") && label(v)
            })
        } else {
            n.trim_start_matches("x-").starts_with("msip_label_") && n.ends_with("_name") && label(value)
        }
    })
}

/// The text of a text/plain message as HTML that keeps its layout (1.0.7 W2.25). HTML collapses runs of spaces, so a table, an indented line or a
/// signature lost its columns in the reader and in the quote of a reply: `&`, `<` and `>` are escaped, every line break is `<br>` (blank lines stay),
/// a run of two or more spaces is `&nbsp;` and a space alternately (the line can still wrap, the width is kept), a space at the start of a line is
/// `&nbsp;`, a tab is `&nbsp;` up to the next multiple of 8 columns. No `white-space` style: other mail programs drop it from a quote. A web
/// address stays text; the reader finds links itself. The whole text is one `<div>`.
pub fn plain_text_to_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8 + 16);
    out.push_str("<div>"); // one block: the quote cleaner (and any reader) takes text before the first tag for a preamble, so the text must not start the fragment
    let (mut col, mut line_start) = (0usize, true);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {}
            '\n' => {
                out.push_str("<br>");
                col = 0;
                line_start = true;
            }
            ' ' | '\t' => {
                // the whole run of spaces and tabs
                let (mut width, mut tab, mut cur) = (0usize, false, c);
                loop {
                    if cur == '\t' {
                        tab = true;
                        width += 8 - (col + width) % 8;
                    } else {
                        width += 1;
                    }
                    match chars.peek() {
                        Some(' ') | Some('\t') => cur = chars.next().unwrap_or(' '),
                        _ => break,
                    }
                }
                if width == 1 && !tab && !line_start {
                    out.push(' '); // a single space inside a line is just a space
                } else {
                    for k in 0..width {
                        if tab || k % 2 == 0 {
                            out.push_str("&nbsp;");
                        } else {
                            out.push(' ');
                        }
                    }
                }
                col += width;
                line_start = false;
            }
            '&' => {
                out.push_str("&amp;");
                col += 1;
                line_start = false;
            }
            '<' => {
                out.push_str("&lt;");
                col += 1;
                line_start = false;
            }
            '>' => {
                out.push_str("&gt;");
                col += 1;
                line_start = false;
            }
            c => {
                out.push(c);
                col += 1;
                line_start = false;
            }
        }
    }
    out.push_str("</div>");
    out
}

/// The HTML (a plain-text body converted), the text and the list of attachment parts of a parsed message. `raw` is the message `m` was parsed from.
fn body_and_parts(m: &mail_parser::Message, raw: &[u8]) -> (Option<String>, Option<String>, Vec<AttMeta>) {
    // a message with no text/html part: its text as HTML, by our own converter (mail-parser's collapses runs of spaces, indents and tables)
    let mut html = match m.html_part(0).map(|p| &p.body) {
        Some(PartType::Text(t)) => Some(plain_text_to_html(t)),
        _ => m.body_html(0).map(|s| s.to_string()),
    };
    let text = m.body_text(0).map(|s| s.to_string());

    // Every part is kept (never silently dropped). Referenced inline pictures up to INLINE_SYNC_MAX are embedded
    // as data: URIs; the rest keep their cid: reference and are loaded on demand.
    let mut attachments = vec![];
    // The references are looked up in the HTML as it came, lower-cased once, and the pictures are put in with ONE copy of the HTML at the end: every picture used to
    // copy and lower-case the HTML that had grown by the pictures before it (14 pictures of 1.3 MB: about 0.7 s of every parse, and a draft is parsed on every open).
    let lower_html = html.as_ref().map(|h| h.to_ascii_lowercase());
    let mut uris: Vec<String> = vec![];
    let mut embeds: Vec<(usize, usize, usize)> = vec![]; // (start, end, index into `uris`)
    let mut embedded: std::collections::HashSet<String> = Default::default(); // the cids that are in the HTML already (a second part with the same cid finds no reference any more)
    for (i, part) in m.attachments().enumerate() {
        let mime = part_mime(part);
        let size = part_data(raw, part).len();
        let cid = part_cid(part);
        let spans = match (&cid, &lower_html) {
            (Some(c), Some(l)) if !embedded.contains(&c.to_ascii_lowercase()) => cid_ref_spans_in(l, c),
            _ => vec![],
        };
        let referenced = !spans.is_empty();
        if let (true, Some(c)) = (referenced && mime.starts_with("image/") && size <= INLINE_SYNC_MAX, &cid) {
            uris.push(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(part.contents())));
            embeds.extend(spans.into_iter().map(|(a, b)| (a, b, uris.len() - 1)));
            embedded.insert(c.to_ascii_lowercase());
        }
        let name = part.attachment_name().map(|s| s.to_string()).unwrap_or_else(|| default_name(i, &mime));
        attachments.push(AttMeta { index: i, name, mime, size, inline: cid.is_some(), cid, referenced });
    }
    if let (false, Some(h)) = (embeds.is_empty(), html.as_mut()) {
        embeds.sort_unstable();
        *h = splice_uris(h, &embeds, &uris);
    }
    (html, text, attachments)
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
    let (mut html, mut text, mut attachments) = body_and_parts(&m, raw);

    // PGP: encrypted mail keeps no readable body in the database; signed mail drops its signature part
    let (mut pgp, keep) = crate::pgpmail::flags_for(raw, text.as_deref());
    if is_confidential(raw) {
        pgp |= crate::pgpmail::FLAG_CONFIDENTIAL;
    }
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
        basis = text.as_deref().map(crate::snippet::preview_text).unwrap_or_default();
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
        importance: crate::importance::from_raw(raw),
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
    let part = m.attachments().nth(index).ok_or("ATT_NOT_FOUND: attachment not found")?;
    // same fallback name as the metadata (AttMeta.name), so a saved file and its card agree
    let name = part.attachment_name().map(|s| s.to_string()).unwrap_or_else(|| default_name(index, &part_mime(part)));
    Ok((name, part_data(raw, part).into_owned()))
}

/// A message read once for opening a draft (`draftopen.rs`): its body and attachment list as `parse` makes them (`view`, without the rest of what `parse` works out: snippet,
/// calendar text, PGP flags, headers) and its parts' bytes (`for_each_attachment`; `attachment_bytes` parses the whole message again for every part it is asked for).
pub struct Parts<'a> {
    raw: &'a [u8],
    msg: mail_parser::Message<'a>,
}

pub fn open_parts(raw: &[u8]) -> Option<Parts<'_>> {
    Some(Parts { raw, msg: MessageParser::default().parse(raw)? })
}

impl Parts<'_> {
    /// The HTML (a plain-text body converted), the text and the attachment list.
    pub fn view(&self) -> (Option<String>, Option<String>, Vec<AttMeta>) {
        body_and_parts(&self.msg, self.raw)
    }

    /// Every attachment part, in the order of the list `view` makes (`index` is the position in it): the name (the same fallback as `AttMeta.name`) and the bytes as
    /// `attachment_bytes` gives them.
    pub fn for_each_attachment(&self, mut f: impl FnMut(usize, String, &[u8])) {
        for (i, part) in self.msg.attachments().enumerate() {
            let name = part.attachment_name().map(|s| s.to_string()).unwrap_or_else(|| default_name(i, &part_mime(part)));
            f(i, name, &part_data(self.raw, part));
        }
    }
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

pub fn fetch_raw<T: Read + Write>(s: &mut imap::Session<T>, folder: &str, uid: u32) -> R<Vec<u8>> {
    s.select(folder).map_err(err)?;
    let f = s.uid_fetch(uid.to_string(), "BODY.PEEK[]").map_err(err)?;
    // the answer for this UID (a server that sends other messages' items along must not give us the wrong message), else the first one
    f.iter()
        .find(|m| m.uid == Some(uid))
        .or_else(|| f.iter().next())
        .and_then(|m| m.body().map(|b| b.to_vec()))
        .ok_or_else(|| "MSG_NOT_ON_SERVER: message not found on server".into())
}

pub fn store_flag<T: Read + Write>(s: &mut imap::Session<T>, folder: &str, uids: &[u32], flag: &str, add: bool) -> R<()> {
    if uids.is_empty() {
        return Ok(());
    }
    s.select(folder).map_err(err)?;
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let q = if add { format!("+FLAGS ({flag})") } else { format!("-FLAGS ({flag})") };
    s.uid_store(set, q).map_err(err)?;
    Ok(())
}

pub fn move_to<T: Read + Write>(s: &mut imap::Session<T>, src: &str, uids: &[u32], dst: &str) -> R<()> {
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

pub fn delete_forever<T: Read + Write>(s: &mut imap::Session<T>, src: &str, uids: &[u32]) -> R<()> {
    if uids.is_empty() {
        return Ok(());
    }
    s.select(src).map_err(err)?;
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    s.uid_store(&set, "+FLAGS (\\Deleted)").map_err(err)?;
    s.expunge().map_err(err)?;
    Ok(())
}

pub fn append<T: Read + Write>(s: &mut imap::Session<T>, folder: &str, raw: &[u8], draft: bool) -> R<()> {
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
#[cfg(test)]
fn cid_ref_spans(html: &str, cid: &str) -> Vec<(usize, usize)> {
    cid_ref_spans_in(&html.to_ascii_lowercase(), cid)
}

/// `cid_ref_spans` on the HTML that is lower-cased already (ASCII only: every offset is the same in both).
pub(crate) fn cid_ref_spans_in(lower_html: &str, cid: &str) -> Vec<(usize, usize)> {
    let needle = format!("cid:{cid}");
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

/// `html` with the spans (sorted, not overlapping) replaced by the data URI each names.
pub(crate) fn splice_uris(html: &str, spans: &[(usize, usize, usize)], uris: &[String]) -> String {
    let mut out = String::with_capacity(html.len() + spans.iter().map(|s| uris[s.2].len()).sum::<usize>());
    let mut last = 0;
    for &(a, b, u) in spans {
        if a < last {
            continue; // (overlapping: the first one wins)
        }
        out.push_str(&html[last..a]);
        out.push_str(&uris[u]);
        last = b;
    }
    out.push_str(&html[last..]);
    out
}

#[cfg(test)]
pub(crate) fn replace_cid_refs(html: &str, cid: &str, uri: &str) -> String {
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

    /// D-044: the pictures a message refers to are put in with one copy of the HTML; the result is what one replacement per picture made.
    #[test]
    fn embedded_pictures_are_put_in_in_one_pass_and_a_second_part_with_the_same_cid_finds_no_reference() {
        let png = |tag: u8| base64::engine::general_purpose::STANDARD.encode([tag; 40]);
        let part = |cid: &str, tag: u8| format!("--B\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <{cid}>\r\nContent-Disposition: inline\r\n\r\n{}\r\n", png(tag));
        let msg = format!(
            "From: a@x.test\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<img src=\"cid:a@x\"><p>Đỗ</p><img src='cid:b@x'><img src=\"CID:A@X\"><img src=\"cid:c@x\">\r\n{}{}{}{}--B--\r\n",
            part("a@x", 1),
            part("b@x", 2),
            part("a@x", 3),
            part("d@x", 4)
        );
        let p = parse(1, msg.as_bytes(), false, false, 0).unwrap();
        let uri = |tag: u8| format!("data:image/png;base64,{}", png(tag));
        assert_eq!(
            p.html.as_deref().unwrap().trim(),
            format!("<img src=\"{}\"><p>Đỗ</p><img src='{}'><img src=\"{}\"><img src=\"cid:c@x\">", uri(1), uri(2), uri(1)),
            "both references of a@x (any case) get the FIRST part; a reference nobody has a part for stays"
        );
        let refd: Vec<bool> = p.attachments.iter().map(|a| a.referenced).collect();
        assert_eq!(refd, [true, true, false, false], "the second part with the cid a@x finds no reference left, d@x is not in the HTML");
    }

    /// W2.25: the converter keeps runs of spaces, the indent of a line, tabs and blank lines, and escapes what HTML would take for markup.
    #[test]
    fn a_plain_text_body_keeps_its_spaces_and_blank_lines() {
        // the text as one <div>; the tests below look at what is inside
        let inner = |t: &str| {
            let h = plain_text_to_html(t);
            h.strip_prefix("<div>").and_then(|h| h.strip_suffix("</div>")).unwrap_or_else(|| panic!("one div: {h}")).to_string()
        };
        // runs: n >= 2 spaces are &nbsp; and a space alternately, starting with &nbsp;; a single space is a space
        assert_eq!(inner("a b"), "a b");
        assert_eq!(inner("a  b"), "a&nbsp; b");
        assert_eq!(inner("a   b"), "a&nbsp; &nbsp;b");
        assert_eq!(inner("a    b"), "a&nbsp; &nbsp; b");
        // a space at the start of a line is &nbsp; (also the first line), and an indent keeps its width
        assert_eq!(inner(" a"), "&nbsp;a");
        assert_eq!(inner("x\n a\n    b"), "x<br>&nbsp;a<br>&nbsp; &nbsp; b");
        // tabs go to the next multiple of 8 columns (as &nbsp; only), in the first column and after text
        assert_eq!(inner("\tx"), "&nbsp;".repeat(8) + "x");
        assert_eq!(inner("abc\tx"), "abc".to_string() + &"&nbsp;".repeat(5) + "x");
        assert_eq!(inner("12345678\tx"), "12345678".to_string() + &"&nbsp;".repeat(8) + "x");
        assert_eq!(inner("a \tb"), "a".to_string() + &"&nbsp;".repeat(7) + "b", "a space and a tab are one run up to column 8");
        // blank lines stay, CR LF is one break, a lone CR is dropped
        assert_eq!(inner("one\r\n\r\n\r\ntwo"), "one<br><br><br>two");
        assert_eq!(inner("a\rb"), "ab");
        // markup is text; a web address and entities are left to the reader
        assert_eq!(inner("<b>bold</b> & &amp; 1 > 0"), "&lt;b&gt;bold&lt;/b&gt; &amp; &amp;amp; 1 &gt; 0");
        assert_eq!(inner("see https://example.org/a?b=1&c=2 now"), "see https://example.org/a?b=1&amp;c=2 now");
        assert_eq!(inner("Đỗ  Văn"), "Đỗ&nbsp; Văn", "the column counts characters, not bytes");
        assert_eq!(inner(""), "");
        // a table: every column keeps its place
        let table = "Name      Qty   Price\n----      ---   -----\nTea         2    3.50\n";
        let html = inner(table);
        assert!(html.starts_with("Name&nbsp; &nbsp; &nbsp; Qty&nbsp; &nbsp;Price<br>"), "{html}");
        assert!(!html.contains("white-space"));
        // the whole message: a text/plain only mail gets this HTML (not mail-parser's, which collapses the runs), a mail with an HTML part keeps its HTML
        let plain = format!("From: a@example.org\r\nTo: b@example.org\r\nSubject: t\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nTable:\r\n{}\r\n\r\n\r\nend\r\n", "  Tea       2");
        let p = parse(1, plain.as_bytes(), false, false, 0).unwrap();
        let h = p.html.expect("html");
        assert!(h.contains("Table:<br>&nbsp; Tea&nbsp; &nbsp; &nbsp; &nbsp;2<br><br><br>end"), "{h}");
        assert!(h.starts_with("<div>") && h.ends_with("</div>") && !h.contains("<html>"), "{h}");
        assert!(p.text.unwrap().contains("  Tea       2"), "the text part is untouched");
        let both = "From: a@example.org\r\nSubject: t\r\nContent-Type: multipart/alternative; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nplain  text\r\n--B\r\nContent-Type: text/html\r\n\r\n<p>html  text</p>\r\n--B--\r\n";
        assert_eq!(parse(2, both.as_bytes(), false, false, 0).unwrap().html.as_deref(), Some("<p>html  text</p>"));
    }

    /// W2.25: the fixture the quote test (scripts/test-quote.mjs) uses as the HTML of a text/plain original is what the converter makes of its source.
    #[test]
    fn the_plain_layout_quote_fixture_is_what_the_converter_makes() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures");
        let source = std::fs::read_to_string(dir.join("plain-layout/source.txt")).unwrap().replace("\r\n", "\n");
        let stored = std::fs::read_to_string(dir.join("quote/plain-layout.html")).unwrap().replace("\r\n", "\n");
        assert_eq!(plain_text_to_html(&source), stored.trim_end_matches('\n'), "scripts/fixtures/quote/plain-layout.html is out of date: rewrite it from plain-layout/source.txt");
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

    /// F-27: the text/plain alternative of a marketing mail starts with a Markdown link to a tracking address. The snippet (list row and
    /// notification) has the readable preheader only; the stored text, which search reads, is the message as it came.
    #[test]
    fn markdown_link_markup_of_a_plain_text_part_stays_out_of_the_snippet_but_in_the_search_text() {
        let text = "[View in browser](https://ecafgcd.r.af.d.sendibt2.com/tr/mr/Tri_95Hx3VWzJfQSa7ggBekbb0Elk9qsx0y6UH1lWEQ8lP4o2bJ6sXAn1ZcR7u?p=eyJ1IjoiMSJ9)\r\n\r\n\
                    Ưu đãi lớn cho khách hàng thân thiết. Xem chi tiết tại https://shop.example/offer?id=77\r\n\r\n[Unsubscribe](https://ecafgcd.r.af.d.sendibt2.com/unsub/abc)\r\n";
        let raw = format!("From: CellphoneS <hi@cellphones.example>\r\nSubject: =?utf-8?B?8J+UpSBN4bufIMSQ4bq3dCBD4buNYyBpUGhvbmUgRHVv?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}");
        let p = parse(20, raw.as_bytes(), false, false, 0).unwrap();
        assert_eq!(p.snippet, "Ưu đãi lớn cho khách hàng thân thiết. Xem chi tiết tại");
        let stored = p.text.unwrap();
        for word in ["View in browser", "sendibt2.com", "khách hàng thân thiết", "shop.example/offer?id=77", "Unsubscribe"] {
            assert!(stored.contains(word), "search text keeps {word:?}");
        }
    }

    #[test]
    fn confidential_mail_is_recognised_from_sensitivity_and_purview_labels() {
        let msg = |h: &str| format!("From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\n{h}\r\n\r\nbody\r\n").into_bytes();
        for yes in [
            "Sensitivity: Company-Confidential\r\n",
            "sensitivity:  confidential \r\n",
            "msip_labels: MSIP_Label_1f2e_Enabled=true; MSIP_Label_1f2e_Name=Highly Confidential; MSIP_Label_1f2e_Method=Standard\r\n",
            "X-MSIP_Label_1f2e_Name: Secret\r\n",
            "MSIP_Label_1f2e_Name: Restricted\r\n",
            "MSIP_Label_1f2e_Name: Confidential\r\n",
            "MSIP_Label_1f2e_Name: Secret Project X\r\n",
            "MSIP_Label_1f2e_Name: Confidential - Not for distribution\r\n",
            "msip_labels: MSIP_Label_1f2e_Name=Internal; MSIP_Label_9a8b_Name=Highly Confidential\r\n",
            "MSIP_Label_1f2e_Name: Highly Confidential\r\n",
            "MSIP_Label_1f2e_Name: Confidential\\All Employees\r\n",
            "MSIP_Label_1f2e_Name: Company Confidential\r\n",
            "MSIP_Label_1f2e_Name: HighlyConfidential\r\n",
            "MSIP_Label_1f2e_Name: Anon Confidential\r\n",
            "MSIP_Label_1f2e_Name: Public Confidential\r\n",
            "MSIP_Label_1f2e_Name: Confidential, not secret\r\n",
            "MSIP_Label_1f2e_Name: Not Secret, Confidential\r\n",
            "MSIP_Label_1f2e_Name: Not for distribution: Confidential\r\n",
            "MSIP_Label_1f2e_Name: Non-Confidential Secret\r\n",
            "MSIP_Label_1f2e_Name: 🔒 Confidential\r\n",
            "MSIP_Label_1f2e_Name: 日本Confidential\r\n",
            "MSIP_Label_1f2e_Name: éConfidential\r\n",
            "MSIP_Label_1f2e_Name: CONFIDENTIAL\r\n",
        ] {
            assert!(is_confidential(&msg(yes)), "{yes}");
            let p = parse(1, &msg(yes), false, false, 0).unwrap();
            assert_eq!(p.pgp & crate::pgpmail::FLAG_CONFIDENTIAL, crate::pgpmail::FLAG_CONFIDENTIAL, "{yes}");
        }
        for no in [
            "",
            "Sensitivity: Normal\r\n",
            "Sensitivity: Private\r\n",
            "msip_labels: MSIP_Label_1f2e_Enabled=true; MSIP_Label_1f2e_Name=Public\r\n",
            "X-Note: Sensitivity: Confidential\r\n",
            // a label that says it is not confidential
            "MSIP_Label_1f2e_Name: Non-Confidential\r\n",
            "MSIP_Label_1f2e_Name: Non Confidential\r\n",
            "msip_labels: MSIP_Label_1f2e_Enabled=true; MSIP_Label_1f2e_Name=Not Confidential\r\n",
            "MSIP_Label_1f2e_Name: Unclassified/Non Confidential\r\n",
            "MSIP_Label_1f2e_Name: Unrestricted\r\n",
            "MSIP_Label_1f2e_Name: Not Secret\r\n",
            "MSIP_Label_1f2e_Name: NotConfidential\r\n",
            "MSIP_Label_1f2e_Name: Not_Confidential\r\n",
            "MSIP_Label_1f2e_Name: NotSecret\r\n",
            "MSIP_Label_1f2e_Name: NoSecret\r\n",
            "MSIP_Label_1f2e_Name: NotRestricted\r\n",
            "MSIP_Label_1f2e_Name: Public-NotConfidential\r\n",
            "MSIP_Label_1f2e_Name: PublicNonConfidential\r\n",
            "MSIP_Label_1f2e_Name: Public (not confidential)\r\n",
            "MSIP_Label_1f2e_Name: UNCONFIDENTIAL\r\n",
            "MSIP_Label_1f2e_Name: NONCONFIDENTIAL\r\n",
            "MSIP_Label_1f2e_Name: Secretariat\r\n",
            "MSIP_Label_1f2e_Name: Secretary Use Only\r\n",
            "MSIP_Label_1f2e_Name: Un-restricted\r\n",
        ] {
            assert!(!is_confidential(&msg(no)), "{no}");
            assert_eq!(parse(1, &msg(no), false, false, 0).unwrap().pgp, 0, "{no}");
        }
        // very long label names are neither slow nor a panic
        assert!(!is_confidential(&msg(&format!("MSIP_Label_1f2e_Name: {}Unconfidential\r\n", "A".repeat(5000)))));
        assert!(is_confidential(&msg(&format!("MSIP_Label_1f2e_Name: {} Confidential\r\n", "\u{e9}".repeat(5000)))));
        // a header-looking line in the body is not a header
        assert!(!is_confidential(b"From: a@example.com\r\n\r\nSensitivity: Confidential\r\n"));
    }
}
#[cfg(test)]
mod folder_role_tests {
    use super::*;

    fn entry(name: &str, delimiter: &str, role: Option<&'static str>) -> FolderEntry {
        FolderEntry { name: name.into(), delimiter: Some(delimiter.into()), role }
    }

    fn roles(entries: &[FolderEntry]) -> Vec<(String, String)> {
        let mut v: Vec<_> = assign_roles(entries).into_iter().collect();
        v.sort();
        v
    }

    fn role_of(map: &HashMap<String, String>, folder: &str) -> Option<String> {
        map.iter().find(|(_, v)| v.as_str() == folder).map(|(k, _)| k.clone())
    }

    #[test]
    fn only_a_whole_standard_name_counts() {
        let map = assign_roles(
            &["Sent", "Drafts", "Archives", "Trash", "Spam"].map(|n| entry(n, "/", None)),
        );
        for (role, folder) in [("sent", "Sent"), ("drafts", "Drafts"), ("archive", "Archives"), ("trash", "Trash"), ("junk", "Spam")] {
            assert_eq!(map.get(role).map(String::as_str), Some(folder));
        }
        // lookalikes: a prefix or suffix, another folder's subfolder, a longer name
        let map = assign_roles(
            &["Trash-old", "Archive 2019", "Sent Items 2018", "Old/Trash", "Work/Drafts", "a/b/Archive", "Spam folder", "Junkyard"].map(|n| entry(n, "/", None)),
        );
        for role in ["sent", "drafts", "archive", "trash", "junk"] {
            assert!(!map.contains_key(role), "{role} was taken from a lookalike: {map:?}");
        }
        assert_eq!(map.len(), 1 + 8, "INBOX and the eight folders of the person");
        assert!(map.contains_key("f:Trash-old") && map.contains_key("f:Archive 2019") && map.contains_key("f:Old/Trash"));
    }

    #[test]
    fn the_servers_flags_win_over_names_and_over_the_order_of_the_list() {
        // `Archive` is listed first, but the server says `Archives` is the archive; `Bin` has no flag, `Deleted` is the flagged trash
        let map = assign_roles(&[entry("Archive", "/", None), entry("Archives", "/", Some("archive")), entry("Bin", "/", None), entry("Deleted", "/", Some("trash"))]);
        assert_eq!(map.get("archive").map(String::as_str), Some("Archives"));
        assert_eq!(map.get("trash").map(String::as_str), Some("Deleted"));
        assert!(map.contains_key("f:Archive") && map.contains_key("f:Bin"), "the unflagged names stay folders: {map:?}");
        // two flagged for one role: the first, as before; the other is a folder
        let map = assign_roles(&[entry("[Gmail]/All Mail", "/", Some("archive")), entry("Old", "/", Some("archive"))]);
        assert_eq!(map.get("archive").map(String::as_str), Some("[Gmail]/All Mail"));
        assert!(map.contains_key("f:Old"));
    }

    #[test]
    fn the_namespace_level_counts_and_the_top_level_goes_first() {
        let r = |names: &[&str], d: &str| {
            let map = assign_roles(&names.iter().map(|n| entry(n, d, None)).collect::<Vec<_>>());
            ["sent", "trash", "archive"].map(|k| map.get(k).cloned())
        };
        assert_eq!(r(&["INBOX.Sent", "INBOX.Trash", "INBOX.Archive"], "."), [Some("INBOX.Sent".into()), Some("INBOX.Trash".into()), Some("INBOX.Archive".into())]);
        assert_eq!(r(&["[Gmail]/Sent Mail", "[Gmail]/Trash"], "/"), [Some("[Gmail]/Sent Mail".into()), Some("[Gmail]/Trash".into()), None]);
        // a top-level folder beats one in the namespace, whatever the order
        assert_eq!(r(&["INBOX.Trash", "Trash"], "."), [None, Some("Trash".into()), None]);
        // the delimiter of the server decides what a subfolder is: a dot in a name on a slash server is just a character
        assert_eq!(r(&["Old.Trash"], "/"), [None, None, None]);
        assert_eq!(r(&["Old/Trash"], "."), [None, None, None]);
        // case does not matter
        assert_eq!(r(&["TRASH", "sent"], "/"), [Some("sent".into()), Some("TRASH".into()), None]);
    }

    #[test]
    fn standard_names_in_other_languages_and_in_modified_utf7_are_found() {
        for (name, role) in [
            ("Papierkorb", "trash"),
            ("Gesendete Elemente", "sent"),
            ("Entw&APw-rfe", "drafts"),
            ("Corbeille", "trash"),
            ("&AMk-l&AOk-ments envoy&AOk-s", "sent"),
            ("Courrier ind&AOk-sirable", "junk"),
            ("Brouillons", "drafts"),
            ("Papelera", "trash"),
            ("Thùng rác", "trash"),
            ("Th&AbA- nh&AOE-p", "drafts"),
        ] {
            let map = assign_roles(&[entry(name, "/", None)]);
            assert_eq!(role_of(&map, name).as_deref(), Some(role), "{name}: {map:?}");
        }
        // the same words with something added are the person's own
        assert_eq!(role_of(&assign_roles(&[entry("Papierkorb alt", "/", None)]), "Papierkorb alt").as_deref(), Some("f:Papierkorb alt"));
        assert_eq!(decode_imap_utf7("a&-b"), "a&b");
        assert_eq!(decode_imap_utf7("&AOk-"), "é");
        assert_eq!(decode_imap_utf7("&broken"), "&broken");
        assert_eq!(decode_imap_utf7("&!!!-x"), "&!!!-x");
        assert_eq!(roles(&[]), vec![("inbox".to_string(), "INBOX".to_string())]);
    }
}

