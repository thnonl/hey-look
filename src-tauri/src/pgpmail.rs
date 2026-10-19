//! PGP/MIME (RFC 3156) and inline-PGP detection and opening for received messages. Pure functions: the caller
//! hands in the keys, nothing here touches the database or the network.

use crate::openpgp::{self, DecryptError, SigVerdict};
use base64::Engine;
use pgp::composed::{CleartextSignedMessage, SignedPublicKey, SignedSecretKey};
use pgp::types::KeyDetails as _;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const FLAG_ENCRYPTED: u8 = 1;
pub const FLAG_SIGNED: u8 = 2;
/// Not PGP: the `pgp` column is a small bit set about how a message is protected. This bit marks mail the sender labelled
/// confidential (see `mail::is_confidential`), which the reading pane shows without screen capture, copy or print.
pub const FLAG_CONFIDENTIAL: u8 = 4;

/// Largest signed (not encrypted) message whose raw bytes are kept for signature checks.
pub const KEEP_SIGNED_MAX: usize = 8_000_000;

const BEGIN_MSG: &str = "-----BEGIN PGP MESSAGE-----";
const END_MSG: &str = "-----END PGP MESSAGE-----";
const BEGIN_CLEAR: &str = "-----BEGIN PGP SIGNED MESSAGE-----";
const END_SIG: &str = "-----END PGP SIGNATURE-----";

// ---------------------------------------------------------------------------------------------------------------
// tiny MIME helpers

pub type Headers = Vec<(String, String)>;

/// Split off the header block: unfolded (name, value) pairs and the offset of the body.
pub fn parse_headers(raw: &[u8]) -> (Headers, usize) {
    let mut headers: Headers = vec![];
    let mut pos = 0;
    while pos < raw.len() {
        let end = raw[pos..].iter().position(|&b| b == b'\n').map(|i| pos + i + 1).unwrap_or(raw.len());
        let line = &raw[pos..end];
        let trimmed = line.strip_suffix(b"\n").unwrap_or(line);
        let trimmed = trimmed.strip_suffix(b"\r").unwrap_or(trimmed);
        if trimmed.is_empty() {
            return (headers, end);
        }
        if (trimmed[0] == b' ' || trimmed[0] == b'\t') && !headers.is_empty() {
            let last = headers.last_mut().unwrap();
            last.1.push(' ');
            last.1.push_str(String::from_utf8_lossy(trimmed).trim());
        } else if let Some(c) = trimmed.iter().position(|&b| b == b':') {
            headers.push((String::from_utf8_lossy(&trimmed[..c]).trim().to_string(), String::from_utf8_lossy(&trimmed[c + 1..]).trim().to_string()));
        }
        pos = end;
    }
    (headers, raw.len())
}

pub fn header<'a>(h: &'a Headers, name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// ("multipart/signed", {"boundary": "..", "protocol": ".."}) from a Content-Type value.
pub fn content_type(value: &str) -> (String, HashMap<String, String>) {
    let mut parts = split_params(value);
    let mime = if parts.is_empty() { String::new() } else { parts.remove(0).to_lowercase() };
    let mut params = HashMap::new();
    for p in parts {
        if let Some((k, v)) = p.split_once('=') {
            params.insert(k.trim().to_lowercase(), v.trim().trim_matches('"').to_string());
        }
    }
    (mime.trim().to_string(), params)
}

fn split_params(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted) = (vec![], String::new(), false);
    for ch in s.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                cur.push(ch);
            }
            ';' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    out.push(cur);
    out.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// Decode a part body according to its Content-Transfer-Encoding.
pub fn decode_body(cte: Option<&str>, body: &[u8]) -> Vec<u8> {
    match cte.map(|c| c.trim().to_lowercase()).as_deref() {
        Some("base64") => {
            let clean: Vec<u8> = body.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
            base64::engine::general_purpose::STANDARD.decode(&clean).unwrap_or_else(|_| body.to_vec())
        }
        Some("quoted-printable") => qp_decode(body),
        _ => body.to_vec(),
    }
}

fn qp_decode(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'=' {
            if i + 1 < b.len() && (b[i + 1] == b'\n' || b[i + 1] == b'\r') {
                i += 2;
                if b.get(i - 1) == Some(&b'\r') && b.get(i) == Some(&b'\n') {
                    i += 1;
                }
                continue;
            }
            if i + 2 < b.len() {
                if let Ok(v) = u8::from_str_radix(&String::from_utf8_lossy(&b[i + 1..i + 3]), 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// The parts of a multipart body. Each part is the raw entity (headers + body) without the line break that
/// belongs to the following delimiter, exactly the bytes a `multipart/signed` signature covers.
pub fn split_multipart<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let delim = format!("--{boundary}");
    let d = delim.as_bytes();
    // delimiter line starts: at 0 or after '\n'
    let mut starts: Vec<(usize, usize, bool)> = vec![]; // (line start, line end incl. newline, closing)
    let mut pos = 0;
    while pos <= body.len() {
        let end = body[pos..].iter().position(|&b| b == b'\n').map(|i| pos + i + 1).unwrap_or(body.len());
        let line = &body[pos..end];
        if line.starts_with(d) {
            let rest = &line[d.len()..];
            let closing = rest.starts_with(b"--");
            let tail = if closing { &rest[2..] } else { rest };
            if tail.iter().all(|b| b.is_ascii_whitespace()) {
                starts.push((pos, end, closing));
                if closing {
                    break;
                }
            }
        }
        if end >= body.len() {
            break;
        }
        pos = end;
    }
    let mut parts = vec![];
    for w in starts.windows(2) {
        let (_, content_start, _) = w[0];
        let (next_line, _, _) = w[1];
        let mut content_end = next_line;
        // drop the line break before the next delimiter
        if content_end > content_start && body[content_end - 1] == b'\n' {
            content_end -= 1;
            if content_end > content_start && body[content_end - 1] == b'\r' {
                content_end -= 1;
            }
        }
        parts.push(&body[content_start..content_end.max(content_start)]);
    }
    parts
}

// ---------------------------------------------------------------------------------------------------------------
// detection

#[derive(Debug, PartialEq)]
pub enum Kind {
    None,
    /// multipart/encrypted; protocol="application/pgp-encrypted": the decoded OpenPGP message
    Encrypted { cipher: Vec<u8> },
    /// multipart/signed; protocol="application/pgp-signature"
    Signed { signed: Vec<u8>, signature: Vec<u8> },
    /// `-----BEGIN PGP MESSAGE-----` in the text body
    InlineEncrypted,
    /// `-----BEGIN PGP SIGNED MESSAGE-----` in the text body
    InlineSigned,
}

fn body_text(raw: &[u8]) -> Option<String> {
    let m = mail_parser::MessageParser::default().parse(raw)?;
    m.body_text(0).map(|s| s.to_string())
}

/// Structure-only detection (no body parsing): PGP/MIME encrypted or signed.
pub fn detect_mime(raw: &[u8]) -> Kind {
    let (h, body_at) = parse_headers(raw);
    let (mime, params) = content_type(header(&h, "content-type").unwrap_or(""));
    let proto = params.get("protocol").map(|s| s.to_lowercase()).unwrap_or_default();
    if mime == "multipart/encrypted" && proto == "application/pgp-encrypted" {
        if let Some(b) = params.get("boundary") {
            let parts = split_multipart(&raw[body_at..], b);
            if parts.len() >= 2 {
                let (ph, pb) = parse_headers(parts[1]);
                let cipher = decode_body(header(&ph, "content-transfer-encoding"), &parts[1][pb..]);
                return Kind::Encrypted { cipher };
            }
        }
        return Kind::Encrypted { cipher: vec![] };
    }
    if mime == "multipart/signed" && proto == "application/pgp-signature" {
        if let Some(b) = params.get("boundary") {
            let parts = split_multipart(&raw[body_at..], b);
            if parts.len() >= 2 {
                let (ph, pb) = parse_headers(parts[1]);
                let signature = decode_body(header(&ph, "content-transfer-encoding"), &parts[1][pb..]);
                return Kind::Signed { signed: parts[0].to_vec(), signature };
            }
        }
    }
    Kind::None
}

/// Inline PGP in a decoded text body.
pub fn detect_text(text: &str) -> Kind {
    if text.contains(BEGIN_MSG) {
        Kind::InlineEncrypted
    } else if text.contains(BEGIN_CLEAR) {
        Kind::InlineSigned
    } else {
        Kind::None
    }
}

pub fn detect(raw: &[u8]) -> Kind {
    match detect_mime(raw) {
        Kind::None => body_text(raw).map(|t| detect_text(&t)).unwrap_or(Kind::None),
        k => k,
    }
}

/// (flags, keep the raw message?) for the sync step. `text` is the already decoded text body of the message.
pub fn flags_for(raw: &[u8], text: Option<&str>) -> (u8, bool) {
    let kind = match detect_mime(raw) {
        Kind::None => text.map(detect_text).unwrap_or(Kind::None),
        k => k,
    };
    match kind {
        Kind::None => (0, false),
        Kind::Encrypted { .. } | Kind::InlineEncrypted => (FLAG_ENCRYPTED, true),
        Kind::Signed { .. } | Kind::InlineSigned => (FLAG_SIGNED, raw.len() <= KEEP_SIGNED_MAX),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// opening

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SigInfo {
    pub status: String,
    pub signer: Option<String>,
    pub fingerprint: Option<String>,
    pub key_id: String,
    pub signed_at: Option<i64>,
    pub verified: bool,
    pub matches_from: bool,
    pub inline: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    pub encrypted: bool,
    pub partial: bool,
    /// ok | locked | no_key | error | none
    pub decryption: String,
    pub locked_key: Option<String>,
    /// the user ID of the locked key, for the unlock card
    pub locked_label: Option<String>,
    pub encrypted_for: Vec<String>,
    pub error: Option<String>,
    /// the armored message as it was received. Nothing in the page reads it, and for a 20 MB draft it doubled what `get_thread` sent (D-044): not serialized.
    #[serde(skip_serializing)]
    pub cipher: Option<String>,
    pub signature: Option<SigInfo>,
}

pub struct LockedKey {
    pub fingerprint: String,
    pub key_ids: Vec<String>,
    pub label: String,
    /// the addresses of the key's user IDs (lower case)
    pub emails: Vec<String>,
}

/// Put the locked keys in the order the unlock prompt should offer them: the key of the mailbox the message is in first, then
/// the keys of the other recipients, then the rest. A message encrypted to two accounts of this app (for example a copy to
/// yourself) would otherwise ask for whichever key happens to be stored first.
pub fn order_locked(locked: &mut [LockedKey], mailbox: &str, recipients: &[String]) {
    let mailbox = mailbox.trim().to_ascii_lowercase();
    let rank = |k: &LockedKey| -> u8 {
        if !mailbox.is_empty() && k.emails.iter().any(|e| *e == mailbox) {
            0
        } else if k.emails.iter().any(|e| recipients.iter().any(|r| r.trim().eq_ignore_ascii_case(e))) {
            1
        } else {
            2
        }
    };
    locked.sort_by_key(|k| rank(k));
}

/// What the opener may use. Built by the store.
pub struct Ctx<'a> {
    pub unlocked: Vec<&'a SignedSecretKey>,
    pub locked: Vec<LockedKey>,
    pub publics: &'a [SignedPublicKey],
    pub verified: &'a HashSet<String>,
}

pub struct Opened {
    pub security: Security,
    /// The message as it would have arrived without encryption (headers of the outer message + decrypted
    /// content). Only present when decryption worked. Never stored.
    pub plain: Option<Vec<u8>>,
}

fn display_name(uid: &str) -> String {
    let n = uid.split('<').next().unwrap_or(uid).trim().trim_matches('"').to_string();
    if n.is_empty() {
        uid.trim_matches(['<', '>']).to_string()
    } else {
        n
    }
}

fn sig_info(v: &SigVerdict, ctx: &Ctx, from_email: &str, inline: bool) -> SigInfo {
    let cert = v.fingerprint.as_ref().and_then(|f| ctx.publics.iter().find(|k| openpgp::fingerprint(k) == *f));
    let uids = cert.map(openpgp::user_ids).unwrap_or_default();
    let emails = openpgp::emails_of(&uids);
    let from = from_email.trim().to_lowercase();
    SigInfo {
        status: v.status.clone(),
        signer: uids.first().map(|u| display_name(u)),
        fingerprint: v.fingerprint.clone(),
        key_id: v.key_id.clone(),
        signed_at: v.signed_at,
        verified: v.fingerprint.as_ref().is_some_and(|f| ctx.verified.contains(f)),
        matches_from: from.is_empty() || emails.iter().any(|e| *e == from),
        inline,
    }
}

/// Outer message headers without the content ones, as CRLF text.
fn outer_headers(raw: &[u8]) -> String {
    let (h, _) = parse_headers(raw);
    let mut out = String::new();
    for (k, v) in h {
        let l = k.to_lowercase();
        if matches!(l.as_str(), "content-type" | "content-transfer-encoding" | "mime-version" | "content-disposition" | "content-description" | "content-id") {
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out
}

/// Outer headers + a decrypted entity (which carries its own Content-* headers).
fn synthesize(raw: &[u8], entity: &[u8]) -> Vec<u8> {
    let mut out = outer_headers(raw).into_bytes();
    out.extend_from_slice(b"MIME-Version: 1.0\r\n");
    out.extend_from_slice(entity);
    out
}

fn synthesize_text(raw: &[u8], text: &str) -> Vec<u8> {
    let mut out = outer_headers(raw).into_bytes();
    out.extend_from_slice(b"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n");
    out.extend_from_slice(text.as_bytes());
    out
}

fn from_of(raw: &[u8]) -> String {
    mail_parser::MessageParser::default()
        .parse(raw)
        .and_then(|m| m.from().and_then(|a| a.first()).and_then(|f| f.address.as_ref().map(|s| s.to_string())))
        .unwrap_or_default()
}

fn error_sec(encrypted: bool, why: String, cipher: Option<String>) -> Security {
    Security { encrypted, decryption: "error".into(), error: Some(why), cipher, ..Default::default() }
}

/// Look at an incoming message and do whatever PGP processing applies. `Security.decryption == "none"` with no
/// signature means the message is plain.
pub fn open(raw: &[u8], ctx: &Ctx) -> Opened {
    let from = from_of(raw);
    match detect(raw) {
        Kind::None => Opened { security: Security { decryption: "none".into(), ..Default::default() }, plain: None },
        Kind::Signed { signed, signature } => {
            let v = openpgp::verify_detached(&signature, &signed, ctx.publics);
            Opened {
                security: Security { decryption: "none".into(), signature: Some(sig_info(&v, ctx, &from, false)), ..Default::default() },
                plain: None,
            }
        }
        Kind::InlineSigned => {
            let text = body_text(raw).unwrap_or_default();
            let start = text.find(BEGIN_CLEAR).unwrap_or(0);
            let end = text[start..].find(END_SIG).map(|e| start + e + END_SIG.len()).unwrap_or(text.len());
            let sig = match CleartextSignedMessage::from_string(&text[start..end]) {
                Ok((msg, _)) => Some(verify_cleartext(&msg, ctx.publics)),
                Err(_) => None,
            };
            let info = sig.map(|v| sig_info(&v, ctx, &from, true)).unwrap_or(SigInfo {
                status: "invalid".into(),
                signer: None,
                fingerprint: None,
                key_id: String::new(),
                signed_at: None,
                verified: false,
                matches_from: false,
                inline: true,
            });
            Opened { security: Security { decryption: "none".into(), signature: Some(info), ..Default::default() }, plain: None }
        }
        Kind::Encrypted { cipher } => {
            if cipher.is_empty() {
                return Opened { security: error_sec(true, "the encrypted part is missing".into(), None), plain: None };
            }
            let armored = String::from_utf8_lossy(&cipher).to_string();
            let cipher_text = armored.contains("BEGIN PGP").then_some(armored);
            decrypt_flow(raw, &cipher, cipher_text, false, "", "", ctx, &from)
        }
        Kind::InlineEncrypted => {
            let text = body_text(raw).unwrap_or_default();
            let a = text.find(BEGIN_MSG).unwrap_or(0);
            let b = text[a..].find(END_MSG).map(|e| a + e + END_MSG.len()).unwrap_or(text.len());
            let block = &text[a..b];
            let (before, after) = (&text[..a], &text[b..]);
            decrypt_flow(raw, block.as_bytes(), Some(block.to_string()), true, before, after, ctx, &from)
        }
    }
}

fn verify_cleartext(msg: &CleartextSignedMessage, keys: &[SignedPublicKey]) -> SigVerdict {
    let mut last: Option<SigVerdict> = None;
    for sig in msg.signatures() {
        let ids: Vec<String> = sig.issuer_key_id().iter().map(|k| k.as_ref().iter().map(|b| format!("{b:02X}")).collect::<String>()).collect();
        let fps: Vec<String> = sig.issuer_fingerprint().iter().map(|f| f.as_bytes().iter().map(|b| format!("{b:02X}")).collect::<String>()).collect();
        let kid = fps.first().map(|f| f[f.len().saturating_sub(16)..].to_string()).or_else(|| ids.first().cloned()).unwrap_or_default();
        let at = sig.created().map(|t| t.as_secs() as i64);
        let cert = keys.iter().find(|k| {
            let fp = openpgp::fingerprint(k);
            let all = openpgp::all_key_ids(k);
            fps.iter().any(|f| *f == fp || k.public_subkeys.iter().any(|s| s.fingerprint().as_bytes().iter().map(|b| format!("{b:02X}")).collect::<String>() == *f))
                || ids.iter().any(|i| all.contains(i))
        });
        let v = match cert {
            None => SigVerdict { status: "unknown_key".into(), key_id: kid, fingerprint: None, signed_at: at },
            Some(k) => {
                let ok = msg.verify(k).is_ok() || k.public_subkeys.iter().any(|s| msg.verify(s).is_ok());
                let status = if !ok {
                    "invalid"
                } else if openpgp::is_revoked(k) {
                    "revoked_key"
                } else if openpgp::key_expiry(k).is_some_and(|e| e <= openpgp::now()) {
                    "expired_key"
                } else {
                    "valid"
                };
                SigVerdict { status: status.into(), key_id: kid, fingerprint: Some(openpgp::fingerprint(k)), signed_at: at }
            }
        };
        if v.status == "valid" {
            return v;
        }
        last = Some(v);
    }
    last.unwrap_or(SigVerdict { status: "invalid".into(), key_id: String::new(), fingerprint: None, signed_at: None })
}

#[allow(clippy::too_many_arguments)]
fn decrypt_flow(raw: &[u8], cipher: &[u8], cipher_text: Option<String>, inline: bool, before: &str, after: &str, ctx: &Ctx, from: &str) -> Opened {
    let ids = match openpgp::encrypted_for(cipher) {
        Ok(v) => v,
        Err(e) => return Opened { security: error_sec(true, e, cipher_text), plain: None },
    };
    let partial = inline && (!before.trim().is_empty() || !after.trim().is_empty());
    let base = Security { encrypted: true, partial, encrypted_for: ids.iter().filter(|i| !i.is_empty()).cloned().collect(), cipher: cipher_text.clone(), ..Default::default() };
    let result = if ctx.unlocked.is_empty() { Err(DecryptError::NoKey) } else { openpgp::decrypt(cipher, &ctx.unlocked, ctx.publics) };
    match result {
        Ok(d) => {
            let mut sec = Security { decryption: "ok".into(), ..base };
            let (entity, mut verdicts): (Vec<u8>, Vec<SigVerdict>) = (d.data, d.signatures);
            let mut sig_inline = true;
            let plain = if inline {
                let t = String::from_utf8_lossy(&entity).to_string();
                if t.trim_start().to_lowercase().starts_with("content-type:") || t.trim_start().to_lowercase().starts_with("mime-version:") {
                    synthesize(raw, &entity)
                } else {
                    synthesize_text(raw, &format!("{before}{t}{after}"))
                }
            } else {
                // PGP/MIME: the decrypted entity may itself be multipart/signed (detached signature inside)
                let (h, body_at) = parse_headers(&entity);
                let (mime, params) = content_type(header(&h, "content-type").unwrap_or(""));
                let mut content = entity.clone();
                if mime == "multipart/signed" {
                    if let Some(b) = params.get("boundary") {
                        let parts = split_multipart(&entity[body_at..], b);
                        if parts.len() >= 2 {
                            let (ph, pb) = parse_headers(parts[1]);
                            let sigbytes = decode_body(header(&ph, "content-transfer-encoding"), &parts[1][pb..]);
                            verdicts.push(openpgp::verify_detached(&sigbytes, parts[0], ctx.publics));
                            sig_inline = false;
                            content = parts[0].to_vec();
                        }
                    }
                }
                synthesize(raw, &content)
            };
            sec.signature = verdicts.first().map(|v| sig_info(v, ctx, from, inline && sig_inline));
            Opened { security: sec, plain: Some(plain) }
        }
        Err(DecryptError::NoKey) => {
            // a key of ours may match, but it is locked
            let hit = ctx.locked.iter().find(|l| ids.iter().any(|i| i.is_empty() || l.key_ids.contains(i)));
            if let Some(l) = hit {
                let sec = Security { decryption: "locked".into(), locked_key: Some(l.fingerprint.clone()), locked_label: Some(l.label.clone()), ..base };
                return Opened { security: sec, plain: None };
            }
            Opened { security: Security { decryption: "no_key".into(), ..base }, plain: None }
        }
        Err(DecryptError::Bad(e)) => Opened { security: Security { decryption: "error".into(), error: Some(e), ..base }, plain: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openpgp::{encrypt, generate, sign_detached, unlock_clone, Algo, Recipient};
    use std::collections::HashSet;

    fn key(email: &str) -> SignedSecretKey {
        let sk = generate(Algo::Cv25519, &format!("{} <{email}>", email.split('@').next().unwrap()), None, "pw-12345678").unwrap();
        unlock_clone(&sk, "pw-12345678").unwrap()
    }

    const OUTER: &str = "From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: Hi\r\nDate: Mon, 12 Oct 2026 09:00:00 +0000\r\nMessage-ID: <a@x>\r\n";

    fn mime_encrypted(armored: &str) -> Vec<u8> {
        format!(
            "{OUTER}MIME-Version: 1.0\r\nContent-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"ENC\"\r\n\r\n\
--ENC\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--ENC\r\nContent-Type: application/octet-stream; name=\"encrypted.asc\"\r\nContent-Disposition: inline; filename=\"encrypted.asc\"\r\n\r\n{}\r\n--ENC--\r\n",
            armored.replace('\n', "\r\n")
        )
        .into_bytes()
    }

    fn ctx<'a>(unlocked: Vec<&'a SignedSecretKey>, publics: &'a [SignedPublicKey], verified: &'a HashSet<String>) -> Ctx<'a> {
        Ctx { unlocked, locked: vec![], publics, verified }
    }

    #[test]
    fn splits_multipart_parts_exactly() {
        let body = b"preamble\r\n--B\r\nContent-Type: text/plain\r\n\r\nhello\r\nworld\r\n\r\n--B\r\nX: y\r\n\r\nsecond\r\n--B--\r\nepilogue";
        let parts = split_multipart(body, "B");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], b"Content-Type: text/plain\r\n\r\nhello\r\nworld\r\n");
        assert_eq!(parts[1], b"X: y\r\n\r\nsecond");
    }

    #[test]
    fn parses_headers_and_content_type() {
        let (h, at) = parse_headers(b"Content-Type: multipart/signed;\r\n\tprotocol=\"application/pgp-signature\"; micalg=pgp-sha256;\r\n boundary=\"x y\"\r\nSubject: s\r\n\r\nbody");
        let (m, p) = content_type(header(&h, "Content-Type").unwrap());
        assert_eq!(m, "multipart/signed");
        assert_eq!(p["boundary"], "x y");
        assert_eq!(p["protocol"], "application/pgp-signature");
        assert_eq!(&b"Content-Type: multipart/signed;\r\n\tprotocol=\"application/pgp-signature\"; micalg=pgp-sha256;\r\n boundary=\"x y\"\r\nSubject: s\r\n\r\nbody"[at..], b"body");
    }

    #[test]
    fn pgp_mime_structure_is_detected_and_roundtrips() {
        let (alice, bob) = (key("alice@example.com"), key("bob@example.com"));
        let (apk, bpk) = (alice.to_public_key(), bob.to_public_key());
        let inner = "Content-Type: text/plain; charset=utf-8\r\n\r\nthe secret plan\r\n";
        let armored = encrypt(inner.as_bytes(), &[Recipient { key: &bpk, hidden: false }], Some((&alice, ""))).unwrap();
        let raw = mime_encrypted(&armored);
        assert!(matches!(detect(&raw), Kind::Encrypted { .. }));
        assert_eq!(flags_for(&raw, None), (FLAG_ENCRYPTED, true));
        let publics = vec![apk.clone()];
        let verified = HashSet::new();
        let o = open(&raw, &ctx(vec![&bob], &publics, &verified));
        assert_eq!(o.security.decryption, "ok");
        assert!(o.security.encrypted && !o.security.partial);
        assert_eq!(o.security.signature.as_ref().unwrap().status, "valid");
        assert_eq!(o.security.signature.as_ref().unwrap().signer.as_deref(), Some("alice"));
        assert!(o.security.signature.as_ref().unwrap().matches_from);
        let plain = String::from_utf8(o.plain.unwrap()).unwrap();
        assert!(plain.contains("Subject: Hi") && plain.contains("the secret plan"));
        // the outer message's content headers are gone, and the result parses as an ordinary message
        let p = crate::mail::parse(1, plain.as_bytes(), true, false, 0).unwrap();
        assert_eq!(p.text.as_deref().map(str::trim), Some("the secret plan"));
        assert_eq!(p.subject, "Hi");
        // wrong recipient: no key
        let eve = key("eve@example.com");
        let o = open(&raw, &ctx(vec![&eve], &publics, &verified));
        assert_eq!(o.security.decryption, "no_key");
        assert_eq!(o.security.encrypted_for.len(), 1);
        assert!(o.plain.is_none());
        // key known but locked
        let locked = Ctx { unlocked: vec![], locked: vec![LockedKey { fingerprint: openpgp::fingerprint(&bpk), key_ids: openpgp::all_key_ids(&bpk), label: "bob".into(), emails: vec!["bob@example.com".into()] }], publics: &publics, verified: &verified };
        let o = open(&raw, &locked);
        assert_eq!(o.security.decryption, "locked");
        assert_eq!(o.security.locked_key.as_deref(), Some(openpgp::fingerprint(&bpk).as_str()));
    }

    #[test]
    fn damaged_encrypted_message_is_an_error_card() {
        let bob = key("bob@example.com");
        let raw = mime_encrypted("-----BEGIN PGP MESSAGE-----\n\nAAAAAAAA\n-----END PGP MESSAGE-----");
        let o = open(&raw, &ctx(vec![&bob], &[], &HashSet::new()));
        assert_eq!(o.security.decryption, "error", "{:?}", o.security);
        assert!(o.security.error.is_some());
    }

    #[test]
    fn multipart_signed_verifies_and_detects_tampering() {
        let alice = key("alice@example.com");
        let apk = alice.to_public_key();
        let entity = "Content-Type: text/plain; charset=utf-8\r\n\r\nsigned text";
        let (sig, mic) = sign_detached(&alice, "", entity.as_bytes()).unwrap();
        let mk = |text: &str| {
            format!(
                "{OUTER}MIME-Version: 1.0\r\nContent-Type: multipart/signed; protocol=\"application/pgp-signature\"; micalg={mic}; boundary=\"SIG\"\r\n\r\n--SIG\r\n{text}\r\n--SIG\r\nContent-Type: application/pgp-signature; name=\"signature.asc\"\r\n\r\n{}\r\n--SIG--\r\n",
                sig.replace('\n', "\r\n")
            )
            .into_bytes()
        };
        let raw = mk(entity);
        assert_eq!(flags_for(&raw, None).0, FLAG_SIGNED);
        let publics = vec![apk];
        let verified: HashSet<String> = [openpgp::fingerprint(&publics[0])].into_iter().collect();
        let o = open(&raw, &ctx(vec![], &publics, &verified));
        let s = o.security.signature.unwrap();
        assert_eq!((s.status.as_str(), s.verified, s.matches_from, s.inline), ("valid", true, true, false));
        assert!(!o.security.encrypted);
        let bad = open(&mk("Content-Type: text/plain; charset=utf-8\r\n\r\nsigned TEXT"), &ctx(vec![], &publics, &verified));
        assert_eq!(bad.security.signature.unwrap().status, "invalid");
        let unknown = open(&raw, &ctx(vec![], &[], &HashSet::new()));
        assert_eq!(unknown.security.signature.unwrap().status, "unknown_key");
    }

    #[test]
    fn inline_pgp_message_is_decrypted_and_partial_is_flagged() {
        let bob = key("bob@example.com");
        let bpk = bob.to_public_key();
        let armored = encrypt(b"inline secret", &[Recipient { key: &bpk, hidden: false }], None).unwrap();
        let raw = format!("{OUTER}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{}\r\n", armored.replace('\n', "\r\n")).into_bytes();
        assert_eq!(detect(&raw), Kind::InlineEncrypted);
        let o = open(&raw, &ctx(vec![&bob], &[], &HashSet::new()));
        assert_eq!(o.security.decryption, "ok");
        assert!(!o.security.partial);
        assert!(String::from_utf8(o.plain.unwrap()).unwrap().contains("inline secret"));
        let raw = format!("{OUTER}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHi Bob, see below\r\n{}\r\nCheers\r\n", armored.replace('\n', "\r\n")).into_bytes();
        let o = open(&raw, &ctx(vec![&bob], &[], &HashSet::new()));
        assert!(o.security.partial);
        let plain = String::from_utf8(o.plain.unwrap()).unwrap();
        assert!(plain.contains("Hi Bob") && plain.contains("inline secret") && plain.contains("Cheers"));
    }

    #[test]
    fn inline_cleartext_signature_is_verified() {
        use pgp::composed::CleartextSignedMessage;
        let alice = key("alice@example.com");
        let signed = CleartextSignedMessage::sign(rand08::thread_rng(), "Hello world\nsecond line", &alice.primary_key, &pgp::types::Password::empty()).unwrap();
        let armored = signed.to_armored_string(Default::default()).unwrap();
        let raw = format!("{OUTER}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{}\r\n", armored.replace('\n', "\r\n")).into_bytes();
        assert_eq!(detect(&raw), Kind::InlineSigned);
        let publics = vec![alice.to_public_key()];
        let o = open(&raw, &ctx(vec![], &publics, &HashSet::new()));
        let s = o.security.signature.unwrap();
        assert_eq!(s.status, "valid");
        assert!(s.inline);
        let none = open(&raw, &ctx(vec![], &[], &HashSet::new()));
        assert_eq!(none.security.signature.unwrap().status, "unknown_key");
    }

    #[test]
    fn ordinary_mail_is_untouched() {
        let raw = format!("{OUTER}MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nhello\r\n").into_bytes();
        assert_eq!(detect(&raw), Kind::None);
        assert_eq!(flags_for(&raw, Some("hello")), (0, false));
        let o = open(&raw, &ctx(vec![], &[], &HashSet::new()));
        assert_eq!(o.security.decryption, "none");
        assert!(o.security.signature.is_none() && !o.security.encrypted);
    }

    #[test]
    fn locked_prompt_names_the_key_of_the_mailbox_not_the_first_key() {
        // one message encrypted to two accounts of this app (alice's key is stored first)
        let (alice, bob) = (key("alice@example.com"), key("bob@example.com"));
        let (apk, bpk) = (alice.to_public_key(), bob.to_public_key());
        let inner = "Content-Type: text/plain; charset=utf-8\r\n\r\nhello both\r\n";
        let armored = encrypt(inner.as_bytes(), &[Recipient { key: &apk, hidden: false }, Recipient { key: &bpk, hidden: false }], None).unwrap();
        let raw = mime_encrypted(&armored);
        let lk = |k: &SignedPublicKey, mail: &str| LockedKey { fingerprint: openpgp::fingerprint(k), key_ids: openpgp::all_key_ids(k), label: mail.into(), emails: vec![mail.into()] };
        let publics = vec![];
        let verified = HashSet::new();
        let open_with = |mailbox: &str, recipients: &[String]| {
            let mut locked = vec![lk(&apk, "alice@example.com"), lk(&bpk, "bob@example.com")];
            order_locked(&mut locked, mailbox, recipients);
            open(&raw, &Ctx { unlocked: vec![], locked, publics: &publics, verified: &verified }).security
        };
        // no hint: the first stored key (the old behaviour)
        assert_eq!(open_with("", &[]).locked_label.as_deref(), Some("alice@example.com"));
        // the message sits in bob's mailbox: bob's key is asked for, with bob's address as the label
        let s = open_with("Bob@Example.com", &["alice@example.com".into()]);
        assert_eq!(s.decryption, "locked");
        assert_eq!(s.locked_label.as_deref(), Some("bob@example.com"));
        assert_eq!(s.locked_key.as_deref(), Some(openpgp::fingerprint(&bpk).as_str()));
        // in alice's mailbox: alice's
        assert_eq!(open_with("alice@example.com", &[]).locked_label.as_deref(), Some("alice@example.com"));
        // a mailbox without a key of its own falls back to a recipient's key, in recipient order of preference
        assert_eq!(open_with("carol@example.com", &["bob@example.com".into()]).locked_label.as_deref(), Some("bob@example.com"));
    }
}
