//! What a saved draft says about its recipients (QA round 17 BUG-01 / BUG-10).
//!
//! The synced copy of a message keeps only bare To / Cc addresses (and nothing for Bcc), which is right for mail that was received but loses
//! the display names and the Bcc recipients of a draft when it is opened again. A draft is read back from the headers of the message that
//! was saved to the Drafts folder instead: To, Cc and Bcc as the person had them in the chips, names included.

use serde::Serialize;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecipients {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    /// The message this draft answers (its In-Reply-To) and the chain it was threaded with (References): a reopened reply draft is sent with
    /// the same threading headers as before it was saved (WP5f).
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    /// The meeting that was switched on in Compose when the draft was saved (base64url JSON written by src/meetingDraft.ts, checked here only for
    /// its alphabet and size; the interface checks what is in it). From the private header `X-HeyLook-Meeting` of the draft, else from the copy this
    /// computer kept (`remember_meeting`: a server may drop headers it does not know). v1.0.6 QA round 3 BUG-R3-4.
    pub meeting: Option<String>,
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The meeting of a draft

/// The private header that carries the meeting. Only DRAFT copies have it (smtp::headers writes it for a draft and never for a message that is sent).
pub const MEETING_HEADER: &str = "X-HeyLook-Meeting";
/// Longest meeting value accepted, written or read (a meeting is a few lines; anything bigger is not one of ours).
pub const MEETING_MAX: usize = 4096;
/// Longest piece of the header value on one line: the value has no spaces of its own, so it is written in pieces that mail software may fold between.
const MEETING_LINE: usize = 64;

/// The meeting value when it is one we could have written (base64url alphabet, not empty, not too long; white space from folding ignored), else None.
pub fn meeting_blob(v: &str) -> Option<String> {
    let s: String = v.split_whitespace().collect();
    (!s.is_empty() && s.len() <= MEETING_MAX && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then_some(s)
}

/// The header value for a meeting value: pieces of at most `MEETING_LINE` characters separated by a space (a long header line is not allowed to run
/// past 998 characters, and a folding point needs white space).
pub fn meeting_header_value(blob: &str) -> String {
    blob.as_bytes().chunks(MEETING_LINE).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

/// How long this computer keeps the meeting of a draft it saved (the copy is only a fallback for a server that drops the header).
const MEETING_KEEP_SECS: i64 = 60 * 24 * 3600;

fn meeting_key(account_id: &str, raw: &[u8]) -> Option<String> {
    message_id_of(raw).map(|m| format!("dmeet:{account_id}|{m}"))
}

/// Keep the meeting of the draft that was just appended, keyed by its account and Message-ID (older copies than `MEETING_KEEP_SECS` go).
pub fn remember_meeting(c: &rusqlite::Connection, account_id: &str, raw: &[u8], blob: &str) {
    let (Some(key), Some(blob)) = (meeting_key(account_id, raw), meeting_blob(blob)) else { return };
    let now = chrono::Utc::now().timestamp();
    let _ = crate::db::set_setting(c, &key, &format!("{now}|{blob}"));
    let _ = c.execute(
        "DELETE FROM settings WHERE key LIKE 'dmeet:%' AND CAST(substr(value, 1, instr(value, '|') - 1) AS INTEGER) < ?1",
        [now - MEETING_KEEP_SECS],
    );
}

/// The meeting this computer kept for the draft with this Message-ID.
pub fn recall_meeting(c: &rusqlite::Connection, account_id: &str, raw: &[u8]) -> Option<String> {
    let v = crate::db::get_setting(c, &meeting_key(account_id, raw)?)?;
    meeting_blob(v.split_once('|')?.1)
}

/// Split a header value at the commas that separate recipients: not inside a quoted string, an angle-bracket address or a comment.
fn split_list(v: &str) -> Vec<String> {
    let (mut out, mut cur) = (vec![], String::new());
    let (mut quoted, mut angle, mut comment, mut esc) = (false, false, 0u32, false);
    for c in v.chars() {
        if esc {
            cur.push(c);
            esc = false;
            continue;
        }
        match c {
            '\\' if quoted || comment > 0 => {
                cur.push(c);
                esc = true;
                continue;
            }
            '"' if comment == 0 => quoted = !quoted,
            '<' if !quoted && comment == 0 => angle = true,
            '>' if !quoted && comment == 0 => angle = false,
            '(' if !quoted => comment += 1,
            ')' if !quoted && comment > 0 => comment -= 1,
            ',' | ';' if !quoted && !angle && comment == 0 => {
                if c == ';' && cur.contains(':') && !cur.trim_end().ends_with(':') {
                    // the end of a group (`undisclosed-recipients:;`, `Team: a@x, b@x;`) is not a separator
                    cur.push(c);
                    continue;
                }
                out.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    out.push(cur);
    out.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

/// A display name that needs no quotes in the chip (letters of any script, digits, spaces and a few marks); anything else is quoted.
fn plain_name(n: &str) -> bool {
    n.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '\'' | '-' | '_'))
}

/// `Name <address>` the way a chip shows it, quoted only when the name needs it; just the address without a name.
fn chip(name: Option<&str>, address: &str) -> String {
    match name.map(str::trim).filter(|n| !n.is_empty() && *n != address) {
        Some(n) if plain_name(n) => format!("{n} <{address}>"),
        Some(n) => crate::smtp::format_mailbox(Some(n), address),
        None => address.to_string(),
    }
}

/// One recipient as written in the header. Parsed on its own (so encoded names are decoded and the address is split off); text that is
/// not an address (`ann bob`, `ann@`: a half-typed draft keeps what was typed) is kept as it is.
fn one(piece: &str) -> String {
    let fake = format!("To: {piece}\r\n\r\n");
    let parsed = mail_parser::MessageParser::default().parse(fake.as_bytes());
    let addrs: Vec<(Option<String>, String)> = parsed
        .as_ref()
        .and_then(|m| m.to())
        .map(|a| a.iter().filter_map(|x| x.address.as_ref().map(|ad| (x.name.as_ref().map(|n| n.to_string()), ad.to_string()))).collect())
        .unwrap_or_default();
    match addrs.as_slice() {
        [(name, address)] if address.contains('@') => chip(name.as_deref(), address),
        _ => piece.to_string(),
    }
}

fn list(h: &crate::pgpmail::Headers, name: &str) -> Vec<String> {
    crate::pgpmail::header(h, name).map(|v| split_list(v).iter().map(|p| one(p)).collect()).unwrap_or_default()
}

/// To, Cc and Bcc of a raw draft, as chips, and its threading headers.
pub fn recipients(raw: &[u8]) -> DraftRecipients {
    let (h, _) = crate::pgpmail::parse_headers(raw);
    let ids = |name: &str| crate::pgpmail::header(&h, name).map(crate::replyhdr::ids_in).unwrap_or_default();
    DraftRecipients {
        to: list(&h, "To"),
        cc: list(&h, "Cc"),
        bcc: list(&h, "Bcc"),
        in_reply_to: ids("In-Reply-To").into_iter().next(),
        references: ids("References"),
        meeting: crate::pgpmail::header(&h, MEETING_HEADER).and_then(meeting_blob),
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Which draft a save or a send replaces
//
// A draft used to be replaced by deleting every Drafts message of its conversation. That also removed a second draft of the same
// conversation (two replies to one mail) and a version that another mail program had saved meanwhile (QA round 17, CF-20), and with an
// autosave it would do so every half minute. A reference now names ONE message:
//   m:<local message id>        a draft that was opened (the message the person opened)
//   mid:<account>|<Message-ID>  a draft this app appended (found locally, else on the server: it may not be synced yet)
//   <anything else>             a conversation, as before (older callers, the mock)

#[derive(Debug, PartialEq)]
pub enum Target {
    Thread(String),
    Local(String),
    Mid { account: String, mid: String },
}

impl Target {
    pub fn parse(s: &str) -> Target {
        if let Some(id) = s.strip_prefix("m:") {
            return Target::Local(id.to_string());
        }
        if let Some((account, mid)) = s.strip_prefix("mid:").and_then(|r| r.split_once('|')) {
            return Target::Mid { account: account.to_string(), mid: mid.to_string() };
        }
        Target::Thread(s.to_string())
    }
}

/// The Message-ID header of a raw message, with its angle brackets.
pub(crate) fn message_id_of(raw: &[u8]) -> Option<String> {
    let (h, _) = crate::pgpmail::parse_headers(raw);
    crate::pgpmail::header(&h, "Message-ID").map(|v| v.trim().to_string()).filter(|v| v.starts_with('<') && v.ends_with('>'))
}

/// The reference to hand back to the interface for the draft that was just appended (`mid:` form).
pub fn draft_ref(account_id: &str, raw: &[u8]) -> Option<String> {
    message_id_of(raw).map(|m| format!("mid:{account_id}|{m}"))
}

/// A Message-ID that is safe to put into a SEARCH command in quotes.
fn plain_mid(mid: &str) -> bool {
    mid.len() > 2 && mid.starts_with('<') && mid.ends_with('>') && !mid.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '"' | '\\' | '(' | ')'))
}

/// Most messages one replace operation removes. A draft has one Message-ID and one copy on the server; a few more are another program's
/// duplicates. More than this after the check means something is wrong (a duplicated Message-ID is suspicious): nothing is removed.
pub const MAX_REPLACED: usize = 5;
/// Most answers of a SEARCH whose headers are looked at. A server that ignores HEADER answers with the whole folder; a Drafts folder is
/// small, a bigger answer is not worth a download of the headers: nothing is removed (an extra stale draft costs nothing).
const MAX_CANDIDATES: usize = 2000;
const FETCH_CHUNK: usize = 200;

/// Which of the SEARCH answers carry the wanted Message-ID, by their own headers. A SEARCH is only a hint (a server may ignore HEADER, match
/// part of a word, or answer with the whole folder), so nothing is removed because it was found; it is removed because its header says so.
/// An error (the headers cannot be fetched) is an error: the caller removes nothing.
fn verified_uids<T: std::io::Read + std::io::Write>(s: &mut imap::Session<T>, candidates: &[u32], mid: &str) -> crate::db::R<Vec<u32>> {
    let mut out = vec![];
    for chunk in candidates.chunks(FETCH_CHUNK) {
        let fetched = s.uid_fetch(crate::mail::uid_set(chunk), "(UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])").map_err(crate::db::err)?;
        for f in fetched.iter() {
            let (Some(uid), Some(head)) = (f.uid, f.header()) else { continue };
            // only the UIDs that were asked about count, and only an exact, bracketed Message-ID
            if chunk.contains(&uid) && message_id_of(head).as_deref() == Some(mid) {
                out.push(uid);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// Remove the messages of the Drafts folder that carry this Message-ID. The server's SEARCH only proposes; every candidate is checked by its
/// own Message-ID header before anything is flagged. Never more than `MAX_REPLACED` go in one operation; when the check cannot be made (an
/// error) or too many match, nothing is removed. Returns how many were removed.
pub fn delete_by_message_id<T: std::io::Read + std::io::Write>(s: &mut imap::Session<T>, folder: &str, mid: &str) -> crate::db::R<usize> {
    if !plain_mid(mid) {
        return Err(format!("not a Message-ID: {mid}"));
    }
    s.select(folder).map_err(crate::db::err)?;
    let mut found: Vec<u32> = s.uid_search(format!("HEADER Message-ID \"{mid}\"")).map_err(crate::db::err)?.into_iter().collect();
    found.sort_unstable();
    found.dedup();
    if found.is_empty() {
        return Ok(0);
    }
    if found.len() > MAX_CANDIDATES {
        crate::startup::line("draft", &format!("{folder}: the search for {mid} answered with {} messages, too many to check: no draft was removed", found.len()));
        return Ok(0);
    }
    let uids = verified_uids(s, &found, mid).map_err(|e| format!("{folder}: the answers of the search for {mid} could not be checked, no draft was removed ({e})"))?;
    if uids.len() > MAX_REPLACED {
        crate::startup::line("draft", &format!("{folder}: {} messages carry the Message-ID {mid}, more than {MAX_REPLACED}: no draft was removed", uids.len()));
        return Ok(0);
    }
    if uids.len() < found.len() {
        crate::startup::line("draft", &format!("{folder}: the search for {mid} answered with {} messages, {} of them carry it", found.len(), uids.len()));
    }
    if uids.is_empty() {
        return Ok(0);
    }
    crate::mail::delete_forever(s, folder, &uids)?;
    Ok(uids.len())
}

/// The drafts of the Drafts folder that were made from this crash-recovery snapshot: `(uid, Message-ID)`. The server is asked with a HEADER search
/// on the start of the Message-ID (recover.rs) and its answer is CHECKED against the headers it gives back: a server whose SEARCH ignores
/// HEADER (or matches loosely) answers with every message, and none of those may count as "the draft of this snapshot".
pub fn find_by_recovery_id<T: std::io::Read + std::io::Write>(s: &mut imap::Session<T>, folder: &str, recovery_id: &str) -> crate::db::R<Vec<(u32, String)>> {
    if !crate::recover::id_in_message_id(recovery_id) {
        return Err(format!("not a snapshot id: {recovery_id}"));
    }
    let prefix = crate::recover::message_id_prefix(recovery_id);
    s.select(folder).map_err(crate::db::err)?;
    let mut uids: Vec<u32> = s.uid_search(format!("HEADER Message-ID \"{prefix}\"")).map_err(crate::db::err)?.into_iter().collect();
    if uids.is_empty() {
        return Ok(vec![]);
    }
    uids.sort_unstable();
    let set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let fetched = s.uid_fetch(set, "(UID BODY.PEEK[HEADER])").map_err(crate::db::err)?;
    let mut out = vec![];
    for f in fetched.iter() {
        let (Some(uid), Some(head)) = (f.uid, f.header()) else { continue };
        if let Some(mid) = message_id_of(head).filter(|m| m.starts_with(&prefix)) {
            out.push((uid, mid));
        }
    }
    out.sort();
    Ok(out)
}

/// The part of `drop_draft` that talks to one server: only the message(s) the reference names are removed, here and there.
pub fn drop_on_session<T: std::io::Read + std::io::Write>(db: &crate::Db, acc: &crate::db::Account, s: &mut imap::Session<T>, target: &Target) -> crate::db::R<()> {
    let drafts = Some("drafts".to_string());
    let refs = match target {
        Target::Thread(_) => return Err("a conversation is not dropped on a session".into()),
        Target::Local(id) => local_refs(db, "id=?1 AND account_id=?2 AND folder='drafts'", &[id, &acc.id])?,
        Target::Mid { mid, .. } => local_refs(db, "message_id=?1 AND account_id=?2 AND folder='drafts'", &[mid, &acc.id])?,
    };
    if !refs.is_empty() {
        return crate::act_on_session(db, acc, s, &refs, "delete_forever", None, &drafts, false);
    }
    if let Target::Mid { mid, .. } = target {
        // not in the local store (yet): ask the server
        let folder = crate::folder_for(db, acc, "drafts")?;
        delete_by_message_id(s, &folder, mid)?;
    }
    Ok(())
}

fn local_refs(db: &crate::Db, filter: &str, args: &[&String; 2]) -> crate::db::R<Vec<crate::MsgRef>> {
    let c = crate::lock(db);
    let mut st = c.prepare(&format!("SELECT account_id,folder,uid,id FROM messages WHERE {filter}")).map_err(crate::db::err)?;
    let rows = st
        .query_map(rusqlite::params![args[0], args[1]], |r| Ok(crate::MsgRef { account_id: r.get(0)?, role: r.get(1)?, uid: r.get(2)?, id: r.get(3)? }))
        .map_err(crate::db::err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(crate::db::err)
}

/// Remove the draft a reference names (see above): a save replaced it, or the message written from it was sent.
pub fn drop_draft(db: &crate::Db, reference: &str) -> crate::db::R<()> {
    let target = Target::parse(reference);
    let account_id = match &target {
        Target::Thread(t) => return crate::action_impl(db, vec![t.clone()], "delete_forever".into(), None, Some("drafts".into())),
        Target::Local(id) => match crate::lock(db).query_row("SELECT account_id FROM messages WHERE id=?1 AND folder='drafts'", [id], |r| r.get::<_, String>(0)) {
            Ok(a) => a,
            // the message is not there any more (another program replaced or removed it): there is nothing of ours to remove
            Err(_) => return Ok(()),
        },
        Target::Mid { account, .. } => account.clone(),
    };
    let acc = crate::db::get_account(&crate::lock(db), &account_id)?;
    let sec = crate::secret(db, &acc)?;
    let mut s = crate::mail::connect(&acc, &sec)?;
    let done = drop_on_session(db, &acc, &mut s, &target);
    let _ = s.logout();
    done
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The version of a draft as it was opened (1.0.7 W2.2)
//
// Opening a draft and saving it (Save draft, every autosave) replaces the opened message by the new one. Discard on such a message promises
// that the draft goes back to how it was when it was opened, so the bytes of the opened version are kept when the first save is about to
// replace it, under the reference of the draft that save makes; every further save moves the entry on to the reference of its own draft.
// "Discard changes" appends these bytes again and removes the autosaved copy (`restore_on_session`). The bytes are the message exactly as
// the server had it (an encrypted draft stays encrypted). They live in the local database only and are never written to the log.

/// How long an entry is kept (a window that stays open for longer has no way back; the person is told by an error, nothing is lost).
const ORIGINAL_KEEP_SECS: i64 = 14 * 24 * 3600;
/// Most entries kept at once (the oldest go first).
const ORIGINAL_MAX_ROWS: i64 = 40;

pub fn create_original_table(c: &rusqlite::Connection) -> crate::db::R<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS draft_original(
           draft_ref TEXT PRIMARY KEY, account_id TEXT NOT NULL, saved_at INTEGER NOT NULL, raw BLOB NOT NULL
         );",
    )
    .map_err(crate::db::err)
}

/// Keep the opened version of the draft that `draft_ref` names (the one the first save made).
pub fn keep_original(c: &rusqlite::Connection, draft_ref: &str, account_id: &str, raw: &[u8]) -> crate::db::R<()> {
    let now = chrono::Utc::now().timestamp();
    c.execute("INSERT OR REPLACE INTO draft_original(draft_ref,account_id,saved_at,raw) VALUES(?1,?2,?3,?4)", rusqlite::params![draft_ref, account_id, now, raw])
        .map_err(crate::db::err)?;
    let _ = c.execute("DELETE FROM draft_original WHERE saved_at < ?1 OR account_id NOT IN (SELECT id FROM accounts)", [now - ORIGINAL_KEEP_SECS]);
    let _ = c.execute(
        "DELETE FROM draft_original WHERE draft_ref IN (SELECT draft_ref FROM draft_original ORDER BY saved_at DESC, rowid DESC LIMIT -1 OFFSET ?1)",
        [ORIGINAL_MAX_ROWS],
    );
    Ok(())
}

/// A later save replaced the draft `from` by the draft `to`: the opened version belongs to `to` now.
pub fn move_original(c: &rusqlite::Connection, from: &str, to: &str) {
    if from == to {
        return;
    }
    let _ = c.execute("DELETE FROM draft_original WHERE draft_ref=?2 AND EXISTS(SELECT 1 FROM draft_original WHERE draft_ref=?1)", rusqlite::params![from, to]);
    let _ = c.execute("UPDATE draft_original SET draft_ref=?2 WHERE draft_ref=?1", rusqlite::params![from, to]);
}

/// The opened version kept for the draft `draft_ref`.
pub fn original(c: &rusqlite::Connection, draft_ref: &str) -> Option<Vec<u8>> {
    c.query_row("SELECT raw FROM draft_original WHERE draft_ref=?1", [draft_ref], |r| r.get(0)).ok()
}

/// The message is over (sent, scheduled, discarded): its opened version is not needed any more.
pub fn forget_original(c: &rusqlite::Connection, draft_ref: &str) {
    let _ = c.execute("DELETE FROM draft_original WHERE draft_ref=?1", [draft_ref]);
}

/// The bytes of the draft `m:<local id>` as they are now, for the first save to keep: from the session-wide raw cache, the copy kept for
/// encrypted mail, else a fetch on the session that is open anyway.
pub fn read_opened<T: std::io::Read + std::io::Write>(db: &crate::Db, s: &mut imap::Session<T>, acc: &crate::db::Account, local_id: &str) -> crate::db::R<Vec<u8>> {
    let (role, uid, kept): (String, u32, Option<Vec<u8>>) = crate::lock(db)
        .query_row("SELECT folder,uid,pgp_raw FROM messages WHERE id=?1 AND account_id=?2 AND folder='drafts'", rusqlite::params![local_id, acc.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(crate::db::err)?;
    if let Some(raw) = kept {
        return Ok(raw);
    }
    if let Some(raw) = crate::rawcache::get(local_id) {
        return Ok(raw.as_ref().clone());
    }
    let folder = crate::fmap(db, &acc.id).get(&role).cloned().ok_or("folder unknown")?;
    crate::mail::fetch_raw(s, &folder, uid)
}

/// What a save does with the opened version (see above), after the new draft `new_ref` was appended: the first save of an opened draft
/// (`opened` holds its bytes) keeps them under `new_ref`; a later save (it replaced `old_ref`, a `mid:` reference) takes the entry along.
pub fn note_save(c: &rusqlite::Connection, account_id: &str, opened: Option<&[u8]>, replaced: Option<&Target>, new_ref: Option<&str>) {
    let Some(new_ref) = new_ref else { return };
    match (opened, replaced) {
        (Some(raw), _) => {
            if let Err(e) = keep_original(c, new_ref, account_id, raw) {
                crate::startup::line("draft", &format!("account {account_id}: the opened version of a draft could not be kept: {e}"));
            }
        }
        (None, Some(Target::Mid { account, mid })) => move_original(c, &format!("mid:{account}|{mid}"), new_ref),
        _ => {}
    }
}

/// "Discard changes" on a session: the opened version is put back into Drafts (flags \Draft \Seen) and, only after that worked, the autosaved
/// copy named by `draft_ref` is removed, so a failure on the way never leaves fewer drafts than before. An APPEND that fails leaves
/// everything as it was (the error goes to the caller); a copy that cannot be removed is logged and left (two drafts, nothing lost).
pub fn restore_on_session<T: std::io::Read + std::io::Write>(db: &crate::Db, acc: &crate::db::Account, s: &mut imap::Session<T>, draft_ref: &str) -> crate::db::R<()> {
    let raw = original(&crate::lock(db), draft_ref).ok_or("The opened version of this draft is no longer available.")?;
    let folder = crate::folder_for(db, acc, "drafts")?;
    crate::mail::append(s, &folder, &raw, true)?;
    if let Err(e) = drop_on_session(db, acc, s, &Target::parse(draft_ref)) {
        crate::startup::line("draft", &format!("account {}: the draft was put back, but the saved copy of the changes could not be removed: {e}", acc.id));
    }
    forget_original(&crate::lock(db), draft_ref);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(h: &str) -> Vec<u8> {
        format!("From: me@example.com\r\n{h}Subject: x\r\n\r\nbody\r\n").into_bytes()
    }

    #[test]
    fn names_and_bcc_come_back_from_the_headers() {
        let r = recipients(&raw(
            "To: =?utf-8?b?Tmd1eeG7hW4gVsSDbiBCw6k=?= <nguyen@example.test>, bob@example.test\r\nCc: cc@example.test\r\nBcc: \"Hidden, Person\" <bcc@example.test>\r\n",
        ));
        assert_eq!(r.to, vec!["Nguyễn Văn Bé <nguyen@example.test>", "bob@example.test"]);
        assert_eq!(r.cc, vec!["cc@example.test"]);
        assert_eq!(r.bcc, vec!["\"Hidden, Person\" <bcc@example.test>"], "a name with a comma stays one recipient, quoted");
    }

    #[test]
    fn a_folded_list_and_a_name_with_special_characters() {
        let r = recipients(&raw("To: \"Smith, John (Sales)\" <john@example.test>,\r\n \"O'Neil\" <on@example.test>,\r\n Ann <ann@example.test>\r\n"));
        assert_eq!(r.to, vec!["\"Smith, John (Sales)\" <john@example.test>", "O'Neil <on@example.test>", "Ann <ann@example.test>"]);
    }

    #[test]
    fn half_typed_recipients_are_kept_as_typed() {
        let r = recipients(&raw("To: ann@, Carl <carl@example.test>, ann bob\r\n"));
        assert_eq!(r.to, vec!["ann@", "Carl <carl@example.test>", "ann bob"]);
    }

    #[test]
    fn no_header_no_recipients() {
        assert_eq!(recipients(&raw("")), DraftRecipients::default());
    }

    #[test]
    fn the_draft_the_backend_writes_is_read_back_whole() {
        // the real writer: smtp::build_draft (names, a quoted comma, Bcc, an invalid entry kept as typed)
        let mut d = crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![]);
        d.to = vec!["Nguyễn Văn Bé <nguyen@example.test>".into(), "bob@example.test".into()];
        d.cc = vec!["\"Doe, Jane\" <jane@example.test>".into()];
        d.bcc = vec!["Quiet <quiet@example.test>".into(), "silent@example.test".into()];
        let bytes = crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted();
        let r = recipients(&bytes);
        assert_eq!(r.to, d.to);
        assert_eq!(r.cc, d.cc);
        assert_eq!(r.bcc, d.bcc);
        // and with a half-typed entry in the list, the others are not lost
        d.bcc = vec!["silent@".into(), "Quiet <quiet@example.test>".into()];
        let bytes = crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted();
        assert_eq!(recipients(&bytes).bcc, d.bcc);
    }

    #[test]
    fn a_reply_draft_gives_back_its_threading_headers() {
        // the real writer, a reply with a long chain: In-Reply-To is the last id, References keep their order
        let mut d = crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![]);
        d.references = vec!["<root@x.org>".into(), "<mid@x.org>".into(), "<orig@x.org>".into()];
        d.in_reply_to = Some("<orig@x.org>".into());
        let bytes = crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted();
        let r = recipients(&bytes);
        assert_eq!(r.in_reply_to.as_deref(), Some("<orig@x.org>"));
        assert_eq!(r.references, d.references);
        // a new message has neither
        let d = crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![]);
        let r = recipients(&crate::smtp::build_draft(&crate::smtp::tests::account(), &d).unwrap().formatted());
        assert_eq!((r.in_reply_to, r.references), (None, vec![]));
        // a folded References header is read whole
        let r = recipients(&raw("In-Reply-To: <b@x.org>\r\nReferences: <a@x.org>\r\n <b@x.org>\r\n"));
        assert_eq!(r.references, vec!["<a@x.org>", "<b@x.org>"]);
    }

    // ---- which draft is replaced

    use crate::fakeimap::Fake;
    use rusqlite::params;

    const ACC: &str = "a1";
    const FMAP: &str = r#"{"inbox":"INBOX","drafts":"Drafts"}"#;

    /// An account with Drafts messages: (uid, message id, thread).
    fn setup(tag: &str, drafts: &[(u32, &str, &str)]) -> (crate::Db, crate::db::Account) {
        let db = crate::quit_tests::test_db(tag);
        let acc = crate::smtp::tests::account_with_id(ACC);
        crate::db::insert_account(&crate::lock(&db), &acc).unwrap();
        crate::db::set_setting(&crate::lock(&db), &format!("fmap:{ACC}"), FMAP).unwrap();
        for (uid, mid, thread) in drafts {
            crate::lock(&db)
                .execute(
                    "INSERT INTO messages(id,account_id,folder,uid,message_id,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,'drafts',?3,?4,?5,'s','n','me@example.com','','',1,'')",
                    params![format!("{ACC}:drafts:{uid}"), ACC, uid, mid, thread],
                )
                .unwrap();
        }
        (db, acc)
    }

    fn local_uids(db: &crate::Db) -> Vec<u32> {
        let c = crate::lock(db);
        let mut st = c.prepare("SELECT uid FROM messages WHERE folder='drafts' ORDER BY uid").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn references_name_one_message() {
        assert_eq!(Target::parse("m:a1:drafts:10"), Target::Local("a1:drafts:10".into()));
        assert_eq!(Target::parse("mid:a1|<x@y.z>"), Target::Mid { account: "a1".into(), mid: "<x@y.z>".into() });
        assert_eq!(Target::parse("0123abcd"), Target::Thread("0123abcd".into()), "a conversation id works as before");
        // what a save hands back is the Message-ID of the draft it appended
        let acc = crate::smtp::tests::account();
        let raw = crate::smtp::build_draft(&acc, &crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![])).unwrap().formatted();
        let r = draft_ref("a1", &raw).expect("a draft has a Message-ID");
        assert!(r.starts_with("mid:a1|<") && r.ends_with("@example.com>"), "{r}");
        assert!(matches!(Target::parse(&r), Target::Mid { .. }));
        assert_eq!(draft_ref("a1", b"Subject: x\r\n\r\nno id"), None);
    }

    /// QA round 17 CF-20: saving an opened draft removed every Drafts message of its conversation, also the version another mail program had
    /// saved meanwhile. Now only the message that was opened goes.
    #[test]
    fn saving_an_opened_draft_removes_that_message_only() {
        crate::test_guard::within(60, || {
            let (db, acc) = setup("draft-local", &[(10, "<a@x>", "T"), (11, "<b@x>", "T"), (12, "<c@x>", "T2")]);
            let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[10, 11, 12])]);
            let mut s = fake.connect();
            drop_on_session(&db, &acc, &mut s, &Target::parse("m:a1:drafts:10")).unwrap();
            let _ = s.logout();
            assert_eq!(fake.uids("Drafts"), Some(vec![11, 12]), "the other version of the same conversation stays on the server");
            assert_eq!(local_uids(&db), vec![11, 12]);
            // a message that is not in the local store any more (another program replaced it): nothing of ours to remove, nothing is touched
            let (db, _) = setup("draft-local-gone", &[(11, "<b@x>", "T")]);
            drop_draft(&db, "m:a1:drafts:10").expect("a vanished draft is not an error");
            assert_eq!(local_uids(&db), vec![11]);
        });
    }

    #[test]
    fn a_draft_this_app_appended_is_found_by_its_message_id() {
        crate::test_guard::within(60, || {
            // known locally: removed by its uid, the neighbours stay
            let (db, acc) = setup("draft-mid-local", &[(10, "<a@x>", "T"), (11, "<b@x>", "T")]);
            let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[10, 11])]);
            let mut s = fake.connect();
            drop_on_session(&db, &acc, &mut s, &Target::parse("mid:a1|<b@x>")).unwrap();
            let _ = s.logout();
            assert_eq!(fake.uids("Drafts"), Some(vec![10]));
            assert_eq!(local_uids(&db), vec![10]);
            assert!(!fake.commands().iter().any(|c| c.to_uppercase().contains("SEARCH")), "no server search when the local store knows it");

            // not synced yet: the server is asked for the Message-ID, and only what it finds (and its header confirms) is removed
            let (db, acc) = setup("draft-mid-server", &[(10, "<a@x>", "T")]);
            let fake = drafts_folder(&[(10, "<a@x>"), (11, "<b@x>"), (12, "<fresh@x>")]);
            let mut s = fake.connect();
            drop_on_session(&db, &acc, &mut s, &Target::parse("mid:a1|<fresh@x>")).unwrap();
            let _ = s.logout();
            assert_eq!(fake.uids("Drafts"), Some(vec![10, 11]));
            assert!(fake.commands().iter().any(|c| c == "UID SEARCH HEADER Message-ID \"<fresh@x>\""), "{:?}", fake.commands());
            assert_eq!(local_uids(&db), vec![10], "the local store is left to the next sync");

            // nothing found: nothing deleted
            let fake = drafts_folder(&[(10, "<a@x>")]);
            fake.state.lock().unwrap().search_hits = Some(vec![]);
            let mut s = fake.connect();
            drop_on_session(&db, &acc, &mut s, &Target::parse("mid:a1|<none@x>")).unwrap();
            let _ = s.logout();
            assert_eq!(fake.uids("Drafts"), Some(vec![10]));
            assert!(!fake.commands().iter().any(|c| c.to_uppercase().contains("STORE")));
        });
    }

    /// 1.0.6: the draft of a crash-recovery snapshot is found by the snapshot id at the start of its Message-ID, and only drafts that really
    /// carry it count, whatever the server's SEARCH does.
    #[test]
    fn the_draft_of_a_snapshot_is_found_by_the_id_in_its_message_id() {
        crate::test_guard::within(60, || {
            let rid = "0f8e7d6c-1111-4222-8333-444455556666";
            let msg = |mid: &str| format!("From: me@example.com\r\nMessage-ID: {mid}\r\nSubject: s\r\n\r\nbody\r\n").into_bytes();
            let mine = format!("<{rid}.1700000100.aaaa@example.com>");
            let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
            fake.put_message("Drafts", 10, &msg("<other@example.com>"));
            fake.put_message("Drafts", 11, &msg(&mine));
            fake.put_message("Drafts", 12, &msg(&format!("<{rid}.1700000200.bbbb@example.com>")));
            fake.put_message("Drafts", 13, &msg("<ffff-eeee.1700000100.cccc@example.com>"));
            let mut s = fake.connect();
            let found = find_by_recovery_id(&mut s, "Drafts", rid).unwrap();
            assert_eq!(found.iter().map(|f| f.0).collect::<Vec<_>>(), vec![11, 12]);
            assert_eq!(found[0].1, mine);
            // a server whose SEARCH ignores HEADER answers with every message: the headers decide, nothing else is "ours"
            fake.state.lock().unwrap().search_ignores_header = true;
            let found = find_by_recovery_id(&mut s, "Drafts", rid).unwrap();
            assert_eq!(found.iter().map(|f| f.0).collect::<Vec<_>>(), vec![11, 12], "{:?}", fake.commands());
            // nothing of ours in the folder
            let none = find_by_recovery_id(&mut s, "Drafts", "1111-2222").unwrap();
            assert!(none.is_empty());
            // and an id that is not safe in a search is refused before anything is sent
            let before = fake.commands().len();
            assert!(find_by_recovery_id(&mut s, "Drafts", "a\" ALL").is_err());
            assert_eq!(fake.commands().len(), before);
            let _ = s.logout();
            // a draft this app appends is found by the next look (APPEND keeps the text)
            let acc = crate::smtp::tests::account();
            let mut d = crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![]);
            d.recovery_id = Some(rid.into());
            let raw = crate::smtp::build_draft(&acc, &d).unwrap().formatted();
            let mut s = fake.connect();
            crate::mail::append(&mut s, "Drafts", &raw, true).unwrap();
            fake.state.lock().unwrap().search_ignores_header = false;
            let found = find_by_recovery_id(&mut s, "Drafts", rid).unwrap();
            assert_eq!(found.len(), 3, "{found:?}");
            assert!(crate::recover::saved_secs(&found[2].1, rid).is_some_and(|t| t > 1_700_000_000));
            let _ = s.logout();
        });
    }

    #[test]
    fn a_reference_cannot_inject_into_the_search() {
        crate::test_guard::within(60, || {
            let (db, acc) = setup("draft-mid-inject", &[]);
            let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[10])]);
            let mut s = fake.connect();
            for bad in ["<a\" ALL>", "<a b@x>", "a@x", "<>", "<a\\b@x>"] {
                assert!(drop_on_session(&db, &acc, &mut s, &Target::Mid { account: ACC.into(), mid: bad.into() }).is_err(), "{bad}");
            }
            let _ = s.logout();
            assert!(!fake.commands().iter().any(|c| c.to_uppercase().contains("SEARCH")), "{:?}", fake.commands());
            assert_eq!(fake.uids("Drafts"), Some(vec![10]));
        });
    }

    // ---- 1.0.6: a SEARCH only proposes, the headers decide (data safety)

    fn msg(mid: &str) -> Vec<u8> {
        format!("From: me@example.com\r\nMessage-ID: {mid}\r\nSubject: s\r\n\r\nbody\r\n").into_bytes()
    }

    /// A server whose Drafts folder holds these (uid, Message-ID) messages, with their text (so the fake can search and fetch headers).
    fn drafts_folder(msgs: &[(u32, &str)]) -> Fake {
        let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
        for (uid, mid) in msgs {
            fake.put_message("Drafts", *uid, &msg(mid));
        }
        fake
    }

    fn flagged(fake: &Fake) -> bool {
        fake.commands().iter().any(|c| c.to_uppercase().contains("STORE") || c.to_uppercase().contains("EXPUNGE"))
    }

    fn delete(fake: &Fake, mid: &str) -> crate::db::R<usize> {
        let mut s = fake.connect();
        let r = delete_by_message_id(&mut s, "Drafts", mid);
        let _ = s.logout();
        r
    }

    /// A server whose SEARCH ignores HEADER answers with every message of the folder. It must lose nothing but the draft whose own header
    /// says it is the one.
    #[test]
    fn a_server_that_ignores_header_in_a_search_loses_nothing() {
        crate::test_guard::within(60, || {
            let fake = drafts_folder(&[(10, "<a@x>"), (11, "<b@x>"), (12, "<old@x>"), (13, "<c@x>")]);
            fake.state.lock().unwrap().search_ignores_header = true;
            assert_eq!(delete(&fake, "<old@x>"), Ok(1));
            assert_eq!(fake.uids("Drafts"), Some(vec![10, 11, 13]), "{:?}", fake.commands());
            // the draft is not there any more (already removed by hand): the whole folder was proposed, nothing is removed
            let before = fake.commands().len();
            assert_eq!(delete(&fake, "<old@x>"), Ok(0));
            assert_eq!(fake.uids("Drafts"), Some(vec![10, 11, 13]));
            assert!(!fake.commands()[before..].iter().any(|c| c.to_uppercase().contains("STORE")), "{:?}", fake.commands());
        });
    }

    /// A server that searches properly still replaces the draft in place, and only the answers whose header matches go.
    #[test]
    fn a_server_that_searches_properly_replaces_the_draft() {
        crate::test_guard::within(60, || {
            let fake = drafts_folder(&[(10, "<a@x>"), (11, "<old@x>"), (12, "<c@x>")]);
            assert_eq!(delete(&fake, "<old@x>"), Ok(1));
            assert_eq!(fake.uids("Drafts"), Some(vec![10, 12]));
            assert!(fake.commands().iter().any(|c| c.starts_with("UID FETCH")), "the answer was checked: {:?}", fake.commands());
            // an answer that is wrong (a loose match, a message that merely mentions the id) is dropped by the check
            let fake = drafts_folder(&[(10, "<a@x>"), (11, "<old@x>"), (12, "<older@x>")]);
            fake.state.lock().unwrap().search_hits = Some(vec![10, 11, 12]);
            assert_eq!(delete(&fake, "<old@x>"), Ok(1));
            assert_eq!(fake.uids("Drafts"), Some(vec![10, 12]));
            // the id has to be the whole header, not a part of it
            let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
            fake.put_message("Drafts", 10, b"From: a@x\r\nMessage-ID: <old@x> <other@x>\r\nSubject: s\r\n\r\nb\r\n");
            fake.put_message("Drafts", 11, b"From: a@x\r\nReferences: <old@x>\r\nMessage-ID: <z@x>\r\nSubject: s\r\n\r\nb\r\n");
            fake.state.lock().unwrap().search_hits = Some(vec![10, 11]);
            assert_eq!(delete(&fake, "<old@x>"), Ok(0));
            assert_eq!(fake.uids("Drafts"), Some(vec![10, 11]));
            assert!(!flagged(&fake), "{:?}", fake.commands());
        });
    }

    /// A few copies of one Message-ID (another program's duplicates) are replaced; more than `MAX_REPLACED` is suspicious: none is removed.
    #[test]
    fn at_most_a_few_messages_are_removed_in_one_replace() {
        crate::test_guard::within(60, || {
            let copies = |n: u32| (0..n).map(|i| (20 + i, "<dup@x>")).chain([(10, "<keep@x>")]).collect::<Vec<_>>();
            let fake = drafts_folder(&copies(MAX_REPLACED as u32));
            assert_eq!(delete(&fake, "<dup@x>"), Ok(MAX_REPLACED));
            assert_eq!(fake.uids("Drafts"), Some(vec![10]));
            let fake = drafts_folder(&copies(MAX_REPLACED as u32 + 1));
            assert_eq!(delete(&fake, "<dup@x>"), Ok(0));
            assert_eq!(fake.uids("Drafts").map(|u| u.len()), Some(MAX_REPLACED + 2), "nothing was removed");
            assert!(!flagged(&fake), "{:?}", fake.commands());
            // a SEARCH that answers with a huge part of the folder is not even looked into
            let fake = drafts_folder(&[(10, "<keep@x>")]);
            fake.state.lock().unwrap().search_hits = Some((1..=(MAX_CANDIDATES as u32 + 1)).collect());
            assert_eq!(delete(&fake, "<keep@x>"), Ok(0));
            assert!(!flagged(&fake) && !fake.commands().iter().any(|c| c.starts_with("UID FETCH")), "{:?}", fake.commands());
        });
    }

    /// When the headers cannot be fetched nothing can be checked: an error, and nothing is flagged or expunged.
    #[test]
    fn nothing_is_removed_when_the_answers_cannot_be_checked() {
        crate::test_guard::within(60, || {
            let fake = drafts_folder(&[(10, "<a@x>"), (11, "<old@x>")]);
            fake.state.lock().unwrap().fail_fetch = true;
            let e = delete(&fake, "<old@x>").unwrap_err();
            assert!(e.contains("could not be checked"), "{e}");
            assert_eq!(fake.uids("Drafts"), Some(vec![10, 11]));
            assert!(!flagged(&fake), "{:?}", fake.commands());
            // a message without a usable header (no Message-ID) is never "found"
            let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
            fake.put_message("Drafts", 10, b"From: a@x\r\nSubject: s\r\n\r\nb\r\n");
            fake.state.lock().unwrap().search_hits = Some(vec![10]);
            assert_eq!(delete(&fake, "<old@x>"), Ok(0));
            assert_eq!(fake.uids("Drafts"), Some(vec![10]));
        });
    }

    // ---- 1.0.7 W2.2: Discard on an opened draft puts the opened version back

    /// A server whose Drafts holds the opened draft (uid 10) and the local store that knows it, as after a sync.
    fn opened_draft() -> (Fake, crate::Db, crate::db::Account, Vec<u8>) {
        let acc = crate::smtp::tests::account();
        let original = crate::smtp::build_draft(&acc, &crate::smtp::tests::draft("<p>Original text</p>", vec![], vec![])).unwrap().formatted();
        let (db, acc) = setup("draft-original", &[(10, "<orig@x>", "T")]);
        let fake = Fake::start(&[("INBOX", &[]), ("Drafts", &[])]);
        fake.put_message("Drafts", 10, &original);
        (fake, db, acc, original)
    }

    /// One save of the compose, as `save_draft` does it (Save draft or an autosave).
    fn save(fake: &Fake, db: &crate::Db, acc: &crate::db::Account, text: &str, replaces: Option<String>) -> Option<String> {
        let raw = crate::smtp::build_draft(acc, &crate::smtp::tests::draft(&format!("<p>{text}</p>"), vec![], vec![])).unwrap().formatted();
        let mut s = fake.connect();
        let saved = crate::save_draft_on(db, acc, &mut s, &raw, replaces).unwrap();
        let _ = s.logout();
        saved.draft_ref
    }

    fn drafts_with(fake: &Fake, needle: &str) -> usize {
        let st = fake.state.lock().unwrap();
        st.folders["Drafts"].iter().filter(|u| st.messages.get(&("Drafts".to_string(), **u)).is_some_and(|m| String::from_utf8_lossy(m).contains(needle))).count()
    }

    #[test]
    fn discard_changes_puts_the_opened_draft_back() {
        crate::test_guard::within(60, || {
            let (fake, db, acc, original) = opened_draft();
            // opened from Drafts, then two autosaves (the second replaces the first, the first replaced the opened message)
            let r1 = save(&fake, &db, &acc, "Original text plus edits", Some("m:a1:drafts:10".into()));
            assert_eq!(fake.uids("Drafts").map(|u| u.len()), Some(1), "the first save replaced the opened message");
            let r2 = save(&fake, &db, &acc, "Original text plus more edits", r1.clone());
            assert_eq!(fake.uids("Drafts").map(|u| u.len()), Some(1));
            assert_ne!(r1, r2);
            assert!(original_of(&db, r2.as_deref().unwrap()).is_some(), "the opened version follows the draft");
            assert!(original_of(&db, r1.as_deref().unwrap()).is_none());
            // Discard changes
            let mut s = fake.connect();
            restore_on_session(&db, &acc, &mut s, r2.as_deref().unwrap()).unwrap();
            let _ = s.logout();
            let st = fake.state.lock().unwrap();
            let left: Vec<&Vec<u8>> = st.folders["Drafts"].iter().filter_map(|u| st.messages.get(&("Drafts".to_string(), *u))).collect();
            assert_eq!(left.len(), 1, "Drafts holds one message");
            assert_eq!(left[0], &original, "byte for byte the version that was opened");
            drop(st);
            let last_append = fake.commands().into_iter().rev().find(|c| c.starts_with("APPEND")).expect("an APPEND");
            assert!(last_append.contains("Seen") && last_append.contains("Draft"), "the flags are Draft and Seen: {last_append}");
            assert_eq!(drafts_with(&fake, "plus"), 0, "the autosaved copy is gone");
            assert!(original_of(&db, r2.as_deref().unwrap()).is_none(), "nothing is left to restore twice");
        });
    }

    fn original_of(db: &crate::Db, r: &str) -> Option<Vec<u8>> {
        original(&crate::lock(db), r)
    }

    #[test]
    fn discard_changes_without_a_save_writes_nothing() {
        crate::test_guard::within(60, || {
            let (fake, db, acc, _) = opened_draft();
            let before = fake.commands().len();
            let mut s = fake.connect();
            // no save happened: there is no version kept and nothing to put back
            assert!(restore_on_session(&db, &acc, &mut s, "mid:a1|<never-saved@x>").is_err());
            let _ = s.logout();
            let sent = &fake.commands()[before..];
            assert!(!sent.iter().any(|c| { let u = c.to_uppercase(); u.starts_with("APPEND") || u.contains("STORE") || u.contains("EXPUNGE") }), "{sent:?}");
            assert_eq!(fake.uids("Drafts"), Some(vec![10]));
        });
    }

    #[test]
    fn discard_changes_keeps_the_autosave_when_the_append_fails() {
        crate::test_guard::within(60, || {
            let (fake, db, acc, _) = opened_draft();
            let r1 = save(&fake, &db, &acc, "Original text plus edits", Some("m:a1:drafts:10".into())).unwrap();
            // the server refuses the APPEND (here: the Drafts folder is gone)
            crate::db::set_setting(&crate::lock(&db), &format!("fmap:{ACC}"), r#"{"inbox":"INBOX","drafts":"Gone"}"#).unwrap();
            let mut s = fake.connect();
            assert!(restore_on_session(&db, &acc, &mut s, &r1).is_err());
            let _ = s.logout();
            assert_eq!(drafts_with(&fake, "plus edits"), 1, "the autosaved version is still there: never zero drafts");
            assert!(original_of(&db, &r1).is_some(), "and the way back stays, a later try can work");
            let removed_after_failure = fake.commands().iter().rev().take_while(|c| !c.starts_with("APPEND")).any(|c| c.to_uppercase().contains("STORE"));
            assert!(!removed_after_failure, "{:?}", fake.commands());
        });
    }

    #[test]
    fn the_opened_version_goes_when_the_message_is_over() {
        let (_, db, _, original_bytes) = opened_draft();
        keep_original(&crate::lock(&db), "mid:a1|<x@y>", "a1", &original_bytes).unwrap();
        crate::drop_replaced_draft(&db, Some("mid:a1|<x@y>".into()));
        assert!(original_of(&db, "mid:a1|<x@y>").is_none(), "sent, scheduled or discarded: not kept");
        // and the table is bounded (the oldest entries go)
        for i in 0..(ORIGINAL_MAX_ROWS + 5) {
            keep_original(&crate::lock(&db), &format!("mid:a1|<{i}@y>"), "a1", b"x").unwrap();
        }
        let n: i64 = crate::lock(&db).query_row("SELECT count(*) FROM draft_original", [], |r| r.get(0)).unwrap();
        assert_eq!(n, ORIGINAL_MAX_ROWS);
    }

    /// Save draft three times, as the app does it: append the new copy, then remove the previous one by the Message-ID the last save gave
    /// back. Exactly one copy of the message stays, every other draft stays, with a server that searches and with one that ignores HEADER.
    #[test]
    fn save_draft_three_times_leaves_one_copy_and_the_other_drafts() {
        crate::test_guard::within(60, || {
            for ignores in [false, true] {
                let fake = drafts_folder(&[(10, "<other-1@x>"), (11, "<other-2@x>")]);
                fake.state.lock().unwrap().search_ignores_header = ignores;
                let acc = crate::smtp::tests::account();
                let mut reference: Option<String> = None;
                for _ in 0..3 {
                    let raw = crate::smtp::build_draft(&acc, &crate::smtp::tests::draft("<p>Hi</p>", vec![], vec![])).unwrap().formatted();
                    let mut s = fake.connect();
                    crate::mail::append(&mut s, "Drafts", &raw, true).unwrap();
                    if let Some(Target::Mid { mid, .. }) = reference.as_deref().map(Target::parse) {
                        assert_eq!(delete_by_message_id(&mut s, "Drafts", &mid), Ok(1), "ignores HEADER: {ignores}");
                    }
                    let _ = s.logout();
                    reference = draft_ref("a1", &raw);
                }
                let all = fake.uids("Drafts").unwrap();
                assert_eq!(all.len(), 3, "ignores HEADER: {ignores}: two other drafts and one copy of ours: {all:?}");
                assert!(all.contains(&10) && all.contains(&11), "ignores HEADER: {ignores}: {all:?}");
                let st = fake.state.lock().unwrap();
                let ours = all.iter().filter(|u| st.messages.get(&("Drafts".to_string(), **u)).is_some_and(|m| String::from_utf8_lossy(m).contains("@example.com>"))).count();
                assert_eq!(ours, 1, "ignores HEADER: {ignores}");
            }
        });
    }
}
