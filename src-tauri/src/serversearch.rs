//! Search on the server (1.0.7 W6.7): the button at the end of the search results asks the person's mail server for mail that is not downloaded to this computer.
//!
//! The words and operators are the local search's (`parse_query` in lib.rs); here they become IMAP SEARCH keys (or one `X-GM-RAW` on a Gmail-like server), the UIDs found minus the UIDs
//! stored locally are fetched as HEADERS only (newest 200 over everything), and a row is downloaded and stored only when the person opens it (`server_open`, the way "Load older"
//! stores a page). Nothing is stored before that, and the words are never logged (account, folder count, hit count and time only).
//!
//! The pure parts (criteria, the Gmail query, the merge) are tested without a server; the rest against `fakeimap.rs`.
use crate::db::{err, Account, R};
use crate::{db, lock, mail, startup, AppState, Db};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Most rows shown, over all folders and mailboxes.
pub const MAX_ROWS: usize = 200;
/// A mailbox that does not answer for this long (per folder) has failed.
pub const FOLDER_TIMEOUT: Duration = Duration::from_secs(20);
/// The header fields a row needs.
const HEADER_FIELDS: &str = "FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO";

// ---------------------------------------------------------------------------------------------------------------------------------
// criteria (pure)

/// A piece of the SEARCH command: text, or a literal (non-ASCII values are sent as literals, RFC 3501 4.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    Literal(Vec<u8>),
}

/// What a query asks of the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    /// the command after `UID SEARCH `
    pub pieces: Vec<Piece>,
    /// `is:pinned` / `is:snoozed` are known on this computer only: the server search leaves them out and the page says so
    pub local_only: bool,
    /// no IMAP key exists for it: the rows are filtered by their BODYSTRUCTURE after the header fetch
    pub has_attachment: bool,
}

/// White space (also line breaks) made one space, control characters taken out.
fn clean(v: &str) -> String {
    v.chars().filter(|c| !c.is_control() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A search string as the protocol wants it: a quoted string when it is plain ASCII, else a literal (the caller adds `CHARSET UTF-8`). Returns whether it is a literal.
fn string_into(v: &str, out: &mut Vec<Piece>) -> bool {
    if v.is_ascii() {
        out.push(Piece::Text(format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))));
        false
    } else {
        out.push(Piece::Literal(v.as_bytes().to_vec()));
        true
    }
}

fn text(out: &mut Vec<Piece>, t: &str) {
    match out.last_mut() {
        Some(Piece::Text(last)) => last.push_str(t),
        _ => out.push(Piece::Text(t.to_string())),
    }
}

/// `1-Jan-2024` (English month names whatever the language of the computer)
fn imap_date(ts: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(ts, 0).map(|d| d.format("%-d-%b-%Y").to_string())
}

/// The keys of the query for a server that understands IMAP SEARCH. `words` -> `TEXT`; `from:` -> `FROM`; `to:` / `cc:` -> `OR TO x CC x`; `subject:` -> `SUBJECT`; `body:` -> `BODY`;
/// `after:` -> `SINCE`; `before:` -> `BEFORE`; `is:unread` -> `UNSEEN`; `is:read` -> `SEEN`; `is:flagged` -> `FLAGGED`.
pub fn criteria(q: &crate::Query) -> Built {
    let mut pieces: Vec<Piece> = vec![];
    let mut utf8 = false;
    let mut any = false;
    let key = |pieces: &mut Vec<Piece>, name: &str, value: &str, utf8: &mut bool, any: &mut bool| {
        let v = clean(value);
        if v.is_empty() {
            return;
        }
        if *any {
            text(pieces, " ");
        }
        text(pieces, &format!("{name} "));
        *utf8 |= string_into(&v, pieces);
        *any = true;
    };
    for w in q.words.iter().filter(|w| !w.eq_ignore_ascii_case("is:snoozed")) {
        key(&mut pieces, "TEXT", w, &mut utf8, &mut any);
    }
    for v in &q.from {
        key(&mut pieces, "FROM", v, &mut utf8, &mut any);
    }
    for v in &q.to {
        let v = clean(v);
        if v.is_empty() {
            continue;
        }
        if any {
            text(&mut pieces, " ");
        }
        text(&mut pieces, "OR TO ");
        utf8 |= string_into(&v, &mut pieces);
        text(&mut pieces, " CC ");
        utf8 |= string_into(&v, &mut pieces);
        any = true;
    }
    for v in &q.subject {
        key(&mut pieces, "SUBJECT", v, &mut utf8, &mut any);
    }
    for v in &q.body {
        key(&mut pieces, "BODY", v, &mut utf8, &mut any);
    }
    let flag = |pieces: &mut Vec<Piece>, t: &str, any: &mut bool| {
        if *any {
            text(pieces, " ");
        }
        text(pieces, t);
        *any = true;
    };
    if let Some(d) = q.after.and_then(imap_date) {
        flag(&mut pieces, &format!("SINCE {d}"), &mut any);
    }
    if let Some(d) = q.before.and_then(imap_date) {
        flag(&mut pieces, &format!("BEFORE {d}"), &mut any);
    }
    match q.unread {
        Some(true) => flag(&mut pieces, "UNSEEN", &mut any),
        Some(false) => flag(&mut pieces, "SEEN", &mut any),
        None => {}
    }
    if q.flagged {
        flag(&mut pieces, "FLAGGED", &mut any);
    }
    if !any {
        text(&mut pieces, "ALL");
    }
    if utf8 {
        pieces.insert(0, Piece::Text("CHARSET UTF-8 ".to_string()));
        // (merge the new first text with the one that follows it)
        if let (Some(Piece::Text(a)), Some(Piece::Text(_))) = (pieces.first(), pieces.get(1)) {
            let a = a.clone();
            if let Piece::Text(b) = pieces.remove(1) {
                pieces[0] = Piece::Text(format!("{a}{b}"));
            }
        }
    }
    Built { pieces, local_only: q.pinned || q.snoozed_asked(), has_attachment: q.has_attachment }
}

/// A word for Gmail's search: quoted when it has a space or a character that has a meaning there.
fn gmail_word(v: &str) -> String {
    let v = clean(v).replace('"', "");
    if v.is_empty() || v.chars().any(|c| c.is_whitespace() || matches!(c, '(' | ')' | '{' | '}' | ':' | '-')) {
        format!("\"{v}\"")
    } else {
        v
    }
}

/// `X-GM-RAW`'s query for the same search (Gmail's own operators): `subject:x`, `from:x`, `to:x`, `after:2024/01/31`, `is:unread`, `is:starred`, `has:attachment`.
pub fn gmail_query(q: &crate::Query) -> String {
    let mut parts: Vec<String> = vec![];
    parts.extend(q.words.iter().filter(|w| !w.eq_ignore_ascii_case("is:snoozed")).map(|w| gmail_word(w)).filter(|w| w != "\"\""));
    parts.extend(q.from.iter().map(|v| format!("from:{}", gmail_word(v))));
    parts.extend(q.to.iter().map(|v| format!("(to:{} OR cc:{})", gmail_word(v), gmail_word(v))));
    parts.extend(q.subject.iter().map(|v| format!("subject:{}", gmail_word(v))));
    // (Gmail has no body-only key: the words of `body:` search the whole text)
    parts.extend(q.body.iter().map(|v| gmail_word(v)));
    let day = |ts: i64| chrono::DateTime::from_timestamp(ts, 0).map(|d| d.format("%Y/%m/%d").to_string());
    if let Some(d) = q.after.and_then(day) {
        parts.push(format!("after:{d}"));
    }
    if let Some(d) = q.before.and_then(day) {
        parts.push(format!("before:{d}"));
    }
    match q.unread {
        Some(true) => parts.push("is:unread".into()),
        Some(false) => parts.push("is:read".into()),
        None => {}
    }
    if q.flagged {
        parts.push("is:starred".into());
    }
    if q.has_attachment {
        parts.push("has:attachment".into());
    }
    parts.retain(|p| !p.is_empty());
    parts.join(" ")
}

/// The Gmail form: one `X-GM-RAW`.
pub fn gmail_criteria(q: &crate::Query) -> Built {
    let query = gmail_query(q);
    let mut pieces = vec![];
    let utf8 = if query.is_empty() {
        text(&mut pieces, "ALL");
        false
    } else {
        text(&mut pieces, "X-GM-RAW ");
        string_into(&query, &mut pieces)
    };
    if utf8 {
        if let Some(Piece::Text(t)) = pieces.first_mut() {
            *t = format!("CHARSET UTF-8 {t}");
        }
    }
    // (the attachment key is in the Gmail query itself: no second filter)
    Built { pieces, local_only: q.pinned || q.snoozed_asked(), has_attachment: false }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// one row, the merge (pure)

/// A message the server has and this computer does not (headers only).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub account_id: String,
    pub role: String,
    pub uid: u32,
    /// the UIDVALIDITY the UID was read under (`server_open` refuses a folder that was renumbered since)
    pub validity: Option<u32>,
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub has_attach: bool,
    #[serde(skip)]
    pub message_id: Option<String>,
}

/// The UIDs to fetch headers for: the ones the server found that this computer does not have, newest first (a higher UID is a later arrival in a folder), at most `cap`; and how many
/// were new in all.
pub fn candidates(found: &[u32], local: &HashSet<u32>, cap: usize) -> (Vec<u32>, usize) {
    let mut fresh: Vec<u32> = found.iter().copied().filter(|u| !local.contains(u)).collect();
    fresh.sort_unstable_by(|a, b| b.cmp(a));
    fresh.dedup();
    let total = fresh.len();
    fresh.truncate(cap);
    (fresh, total)
}

/// The rows to show: what this computer has (by Message-ID, any folder: Gmail's All Mail holds what the Inbox holds) is left out, then the newest `MAX_ROWS` by date, newest first.
/// The second answer: more were found than are shown.
pub fn merge(rows: Vec<Row>, local_message_ids: &HashSet<String>, found_beyond: bool) -> (Vec<Row>, bool) {
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut rows: Vec<Row> = rows
        .into_iter()
        .filter(|r| match &r.message_id {
            Some(m) => !local_message_ids.contains(m) && seen_ids.insert(m.clone()),
            None => true,
        })
        .collect();
    rows.sort_by(|a, b| b.date.cmp(&a.date).then(b.uid.cmp(&a.uid)));
    let capped = found_beyond || rows.len() > MAX_ROWS;
    rows.truncate(MAX_ROWS);
    (rows, capped)
}

/// Does a BODYSTRUCTURE hold an attachment? A part that says `attachment`, or a part that is neither text nor an inline picture and not a message body.
pub fn structure_has_attachment(b: &imap_proto::types::BodyStructure<'_>) -> bool {
    use imap_proto::types::BodyStructure as B;
    let is_attachment = |c: &imap_proto::types::BodyContentCommon<'_>| c.disposition.as_ref().is_some_and(|d| d.ty.eq_ignore_ascii_case("attachment"));
    match b {
        B::Multipart { bodies, .. } => bodies.iter().any(structure_has_attachment),
        B::Basic { common, .. } => is_attachment(common) || (common.ty.ty.eq_ignore_ascii_case("application") && !common.disposition.as_ref().is_some_and(|d| d.ty.eq_ignore_ascii_case("inline"))),
        B::Text { common, .. } => is_attachment(common),
        B::Message { common, body, .. } => is_attachment(common) || structure_has_attachment(body),
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the folders (pure)

/// The folders (role, server name) one mailbox is searched in. `current`: the folder of the open view (or `explicit` when the query names one); the whole mailbox: every folder of the
/// saved list except Deleted Items and Junk Email; `explicit` (the `folder:` operator) narrows either.
pub fn folders_to_search(map: &HashMap<String, String>, scope: &str, view_folder: &str, explicit: Option<&str>) -> Vec<(String, String)> {
    let key_of = |f: &str| match f {
        "sent" | "drafts" | "archive" | "trash" | "junk" | "inbox" => f.to_string(),
        "spam" => "junk".to_string(),
        "deleted" | "bin" => "trash".to_string(),
        other => format!("f:{other}"),
    };
    let pick = |role: &str| map.iter().find(|(k, _)| k.eq_ignore_ascii_case(role)).map(|(k, n)| (k.clone(), n.clone()));
    if let Some(e) = explicit {
        return pick(&key_of(e)).into_iter().collect();
    }
    let everywhere = || {
        let mut out: Vec<(String, String)> = map.iter().filter(|(k, _)| !matches!(k.as_str(), "trash" | "junk")).map(|(k, n)| (k.clone(), n.clone())).collect();
        out.sort();
        out
    };
    if scope == "account" || scope == "all" {
        return everywhere();
    }
    match view_folder {
        "unread" => pick("inbox").into_iter().collect(),
        "starred" | "pinned" | "snoozed" | "all" => everywhere(),
        f => pick(f).into_iter().collect(),
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the search on a connection

/// What one folder gave.
pub struct FolderHits {
    pub rows: Vec<Row>,
    /// new UIDs found in all (the rows are the newest of them)
    pub total_new: usize,
}

/// Search one folder (read-only: EXAMINE) and fetch the headers of what is not stored here yet. `local`: the UIDs stored for this folder.
pub fn search_folder<T: Read + Write>(s: &mut imap::Session<T>, account_id: &str, role: &str, folder: &str, built: &Built, local: &HashSet<u32>, cap: usize) -> R<FolderHits> {
    let mb = s.examine(folder).map_err(err)?;
    let parts: Vec<imap::SearchPart> = built.pieces.iter().map(|p| match p {
        Piece::Text(t) => imap::SearchPart::Text(t),
        Piece::Literal(b) => imap::SearchPart::Literal(b),
    }).collect();
    let found: Vec<u32> = s.uid_search_with_literals(&parts).map_err(err)?.into_iter().collect();
    let (pick, total_new) = candidates(&found, local, cap);
    let mut rows = vec![];
    for chunk in pick.chunks(100) {
        let set = mail::uid_set(&{
            let mut c = chunk.to_vec();
            c.sort_unstable();
            c
        });
        let fetched = s
            .uid_fetch(set, format!("(UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS ({HEADER_FIELDS})])"))
            .map_err(err)?;
        for f in fetched.iter() {
            let Some(uid) = f.uid else { continue };
            if !chunk.contains(&uid) {
                continue;
            }
            let Some(head) = f.header() else { continue };
            let Some(m) = mail_parser::MessageParser::default().parse(head) else { continue };
            let (from_name, from_email) = m
                .from()
                .and_then(|a| a.first())
                .map(|x| (x.name.as_ref().map(|s| s.to_string()).unwrap_or_default(), x.address.as_ref().map(|s| s.to_string()).unwrap_or_default()))
                .unwrap_or_default();
            let flags = f.flags();
            let attach = f.bodystructure().is_some_and(structure_has_attachment);
            if built.has_attachment && !attach {
                continue;
            }
            rows.push(Row {
                account_id: account_id.to_string(),
                role: role.to_string(),
                uid,
                validity: mb.uid_validity,
                subject: m.subject().unwrap_or("").to_string(),
                from_name,
                from_email,
                date: f.internal_date().map(|d| d.timestamp()).or_else(|| m.date().map(|d| d.to_timestamp())).unwrap_or(0),
                seen: flags.iter().any(|x| matches!(x, imap::types::Flag::Seen)),
                flagged: flags.iter().any(|x| matches!(x, imap::types::Flag::Flagged)),
                has_attach: attach,
                message_id: m.message_id().map(|x| format!("<{x}>")),
            });
        }
    }
    Ok(FolderHits { rows, total_new })
}

/// A mailbox: every folder in turn on one connection. `gmail`: the server has X-GM-EXT-1 (checked by the caller). `stop` is asked between folders.
pub fn search_mailbox<T: Read + Write>(
    s: &mut imap::Session<T>,
    db: &Db,
    account_id: &str,
    folders: &[(String, String)],
    q: &crate::Query,
    scope_whole: bool,
    stop: &dyn Fn() -> bool,
) -> R<(Vec<Row>, bool)> {
    let gmail = s.capabilities().map(|c| c.has_str("X-GM-EXT-1")).unwrap_or(false);
    // Gmail: one search of All Mail covers every folder of a whole-mailbox search
    let mut todo: Vec<(String, String)> = folders.to_vec();
    if gmail && scope_whole {
        if let Some(all) = folders.iter().find(|f| f.0 == "archive") {
            todo = vec![all.clone()];
        }
    }
    let built = if gmail { gmail_criteria(q) } else { criteria(q) };
    let mut rows = vec![];
    let mut beyond = false;
    for (role, name) in &todo {
        if stop() {
            return Err("cancelled".into());
        }
        let local: HashSet<u32> = {
            let c = lock(db);
            let mut st = c.prepare("SELECT uid FROM messages WHERE account_id=?1 AND folder=?2").map_err(err)?;
            let r: HashSet<u32> = st.query_map(rusqlite::params![account_id, role], |r| r.get(0)).map_err(err)?.flatten().collect();
            r
        };
        let hits = search_folder(s, account_id, role, name, &built, &local, MAX_ROWS)?;
        beyond |= hits.total_new > hits.rows.len() && !built.has_attachment;
        rows.extend(hits.rows);
    }
    Ok((rows, beyond))
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxError {
    pub account_id: String,
    pub error: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerSearchResult {
    pub rows: Vec<Row>,
    pub capped: bool,
    pub errors: Vec<MailboxError>,
    /// `is:pinned` / `is:snoozed` were left out
    pub local_only: bool,
    /// the search was cancelled (new search, Cancel): nothing is shown
    pub cancelled: bool,
}

/// The number of the search that is current: starting another, or `server_search_cancel`, makes the running one stale.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The sockets of the running search (shut down by a cancel: a blocked read returns at once).
static SOCKETS: Mutex<Vec<std::net::TcpStream>> = Mutex::new(Vec::new());

fn cancel_all() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    for s in SOCKETS.lock().unwrap_or_else(|p| p.into_inner()).drain(..) {
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
}

fn plan(db: &Db, filter: &crate::ThreadFilter, q: &crate::Query) -> Vec<(Account, Vec<(String, String)>, bool)> {
    let scope = filter.scope.as_deref().unwrap_or("current");
    let accounts = db::list_accounts(&lock(db)).unwrap_or_default();
    let chosen: Vec<Account> = accounts.into_iter().filter(|a| scope == "all" || filter.account_id.as_ref().is_none_or(|id| *id == a.id)).collect();
    let whole = scope == "account" || scope == "all" || matches!(filter.folder.as_str(), "starred" | "pinned" | "snoozed" | "all");
    chosen
        .into_iter()
        .map(|a| {
            let map = crate::fmap(db, &a.id);
            let folders = folders_to_search(&map, scope, &filter.folder, q.folder.as_deref());
            (a, folders, whole && q.folder.is_none())
        })
        .filter(|(_, f, _)| !f.is_empty())
        .collect()
}

/// Search the server(s). Never started by itself: the page asks (the button at the end of the results).
#[tauri::command]
pub async fn server_search(state: tauri::State<'_, AppState>, filter: crate::ThreadFilter) -> R<ServerSearchResult> {
    let db = state.db.clone();
    crate::blocking(move || Ok(run(&db, &filter))).await
}

fn run(db: &Db, filter: &crate::ThreadFilter) -> ServerSearchResult {
    let Some(search) = filter.search.as_deref().filter(|s| !s.trim().is_empty()) else { return ServerSearchResult::default() };
    let q = crate::parse_query(search);
    let t0 = Instant::now();
    let mine = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let stale = move || GENERATION.load(Ordering::SeqCst) != mine;
    let work = plan(db, filter, &q);
    let local_only = q.pinned || q.snoozed_asked();
    let results: Vec<(String, R<(Vec<Row>, bool)>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = work
            .iter()
            .map(|(acc, folders, whole)| {
                let (q, stale) = (&q, &stale);
                scope.spawn(move || {
                    let r = (|| -> R<(Vec<Row>, bool)> {
                        let sec = crate::secret(db, acc)?;
                        let (mut s, sock) = mail::connect_with_socket(acc, &sec)?;
                        // a folder that does not answer within 20 s fails the mailbox; a cancel shuts the socket down
                        let _ = sock.set_read_timeout(Some(FOLDER_TIMEOUT));
                        if let Ok(c) = sock.try_clone() {
                            SOCKETS.lock().unwrap_or_else(|p| p.into_inner()).push(c);
                        }
                        let done = search_mailbox(&mut s, db, &acc.id, folders, q, *whole, stale);
                        let _ = s.logout();
                        done
                    })();
                    (acc.id.clone(), r)
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    if stale() {
        return ServerSearchResult { cancelled: true, local_only, ..Default::default() };
    }
    let mut rows = vec![];
    let mut beyond = false;
    let mut errors = vec![];
    for (id, r) in results {
        match r {
            Ok((r, b)) => {
                rows.extend(r);
                beyond |= b;
            }
            Err(e) => errors.push(MailboxError { account_id: id, error: e }),
        }
    }
    let ids = local_message_ids(db, &rows);
    let (rows, capped) = merge(rows, &ids, beyond);
    startup::line("search", &format!("server search: {} mailbox(es), {} row(s), {} error(s), {} ms", work.len(), rows.len(), errors.len(), t0.elapsed().as_millis()));
    ServerSearchResult { rows, capped, errors, local_only, cancelled: false }
}

/// The Message-IDs of the rows that this computer has already (any folder of the mailbox).
fn local_message_ids(db: &Db, rows: &[Row]) -> HashSet<String> {
    let c = lock(db);
    let mut out = HashSet::new();
    for r in rows {
        let Some(m) = &r.message_id else { continue };
        if c.query_row("SELECT 1 FROM messages WHERE account_id=?1 AND message_id=?2 LIMIT 1", rusqlite::params![r.account_id, m], |_| Ok(())).is_ok() {
            out.insert(m.clone());
        }
    }
    out
}

/// Stop the search: the connections are closed, nothing is shown.
#[tauri::command]
pub fn server_search_cancel() {
    cancel_all();
}

/// The messages opened from a server row: the prune keeps them for the rest of the run (W6.7 REQ-6.7.6).
static OPENED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn protected() -> HashSet<String> {
    OPENED.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or_default()
}

/// Download one message of a server row and store it like "Load older" does; the answer is its conversation. The message is read with `BODY.PEEK[]` (it stays unread on the server).
/// A message that is gone is `MSG_NOT_ON_SERVER`, a folder that was renumbered since the search is `FOLDER_CHANGED` (nothing is stored).
#[tauri::command]
pub async fn server_open(state: tauri::State<'_, AppState>, account_id: String, role: String, uid: u32, validity: Option<u32>) -> R<String> {
    let db = state.db.clone();
    crate::blocking(move || open_row(&db, &account_id, &role, uid, validity)).await
}

fn open_row(db: &Db, account_id: &str, role: &str, uid: u32, validity: Option<u32>) -> R<String> {
    let acc = db::get_account(&lock(db), account_id)?;
    let sec = crate::secret(db, &acc)?;
    let name = crate::fmap(db, account_id).get(role).cloned().ok_or("folder unknown")?;
    let mut s = mail::connect(&acc, &sec)?;
    let done = open_on(db, &acc, &mut s, role, &name, uid, validity);
    let _ = s.logout();
    done
}

/// `open_row` on a connected session.
fn open_on<T: Read + Write>(db: &Db, acc: &Account, s: &mut imap::Session<T>, role: &str, folder: &str, uid: u32, validity: Option<u32>) -> R<String> {
    let parsed = mail::fetch_one(s, folder, uid, validity)?;
    crate::store_page(db, acc, role, std::slice::from_ref(&parsed))?;
    let id = format!("{}:{role}:{uid}", acc.id);
    OPENED.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(Default::default).insert(id);
    Ok(crate::thread_id_of(&acc.id, role, &parsed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fakeimap::Fake;

    fn q(search: &str) -> crate::Query {
        crate::parse_query(search)
    }

    fn flat(b: &Built) -> String {
        b.pieces.iter().map(|p| match p { Piece::Text(t) => t.clone(), Piece::Literal(l) => format!("<{}>", String::from_utf8_lossy(l)) }).collect()
    }

    #[test]
    fn the_query_becomes_imap_search_criteria() {
        // words, quoting
        assert_eq!(flat(&criteria(&q("invoice"))), "TEXT \"invoice\"");
        assert_eq!(flat(&criteria(&q("invoice \"big deal\""))), "TEXT \"invoice\" TEXT \"big deal\"");
        assert_eq!(flat(&criteria(&q("say\"hi"))), "TEXT \"sayhi\"", "the tokenizer drops a lone quote");
        // each operator
        assert_eq!(flat(&criteria(&q("from:ann@x.test"))), "FROM \"ann@x.test\"");
        assert_eq!(flat(&criteria(&q("to:bob@x.test"))), "OR TO \"bob@x.test\" CC \"bob@x.test\"");
        assert_eq!(flat(&criteria(&q("cc:bob@x.test"))), "OR TO \"bob@x.test\" CC \"bob@x.test\"");
        assert_eq!(flat(&criteria(&q("subject:report"))), "SUBJECT \"report\"");
        assert_eq!(flat(&criteria(&q("body:budget"))), "BODY \"budget\"");
        assert_eq!(flat(&criteria(&q("is:unread"))), "UNSEEN");
        assert_eq!(flat(&criteria(&q("is:read"))), "SEEN");
        assert_eq!(flat(&criteria(&q("is:flagged"))), "FLAGGED");
        // dates: the day as IMAP writes it
        assert_eq!(flat(&criteria(&q("after:2024-01-05"))), "SINCE 5-Jan-2024");
        assert_eq!(flat(&criteria(&q("since:2024-12-31 before:2025-02-01"))), "SINCE 31-Dec-2024 BEFORE 1-Feb-2025");
        // several keys are all required (IMAP: implicit AND)
        let all = criteria(&q("from:ann@x.test after:2024-01-01 is:unread invoice"));
        assert_eq!(flat(&all), "TEXT \"invoice\" FROM \"ann@x.test\" SINCE 1-Jan-2024 UNSEEN");
        // has:attachment has no key: it is a filter on the rows; pinned / snoozed are local
        let b = criteria(&q("has:attachment invoice"));
        assert!(b.has_attachment && flat(&b) == "TEXT \"invoice\"");
        assert!(criteria(&q("is:pinned invoice")).local_only && flat(&criteria(&q("is:pinned invoice"))) == "TEXT \"invoice\"");
        assert_eq!(flat(&criteria(&q("is:pinned"))), "ALL", "nothing left to ask: every message (the page limits it to what is not here)");
        // quotes inside a value are escaped
        let mut qq = crate::Query::default();
        qq.words.push("a\"b\\c".into());
        assert_eq!(flat(&criteria(&qq)), "TEXT \"a\\\"b\\\\c\"");
        // line breaks never reach the command
        let mut qq = crate::Query::default();
        qq.words.push("a\r\nb".into());
        assert_eq!(flat(&criteria(&qq)), "TEXT \"a b\"");
    }

    #[test]
    fn non_ascii_text_is_a_utf8_literal_with_a_charset() {
        let b = criteria(&q("Báo cáo"));
        assert_eq!(flat(&b), "CHARSET UTF-8 TEXT <Báo> TEXT <cáo>");
        assert_eq!(b.pieces[0], Piece::Text("CHARSET UTF-8 TEXT ".into()));
        assert_eq!(b.pieces[1], Piece::Literal("Báo".as_bytes().to_vec()));
        // mixed with ASCII keys: the ASCII ones stay quoted strings
        let b = criteria(&q("subject:\"Báo cáo\" from:ann@x.test"));
        assert_eq!(flat(&b), "CHARSET UTF-8 FROM \"ann@x.test\" SUBJECT <báo cáo>");
        // plain ASCII has no charset
        assert!(!flat(&criteria(&q("invoice"))).contains("CHARSET"));
    }

    #[test]
    fn the_gmail_query_is_built_for_x_gm_raw() {
        assert_eq!(gmail_query(&q("invoice")), "invoice");
        assert_eq!(gmail_query(&q("\"big deal\" from:ann@x.test")), "\"big deal\" from:ann@x.test");
        assert_eq!(gmail_query(&q("to:bob@x.test subject:report")), "(to:bob@x.test OR cc:bob@x.test) subject:report");
        assert_eq!(gmail_query(&q("after:2024-01-05 before:2024-02-01 is:unread is:flagged has:attachment")), "after:2024/01/05 before:2024/02/01 is:unread is:starred has:attachment");
        let b = gmail_criteria(&q("from:ann@x.test invoice"));
        assert_eq!(flat(&b), "X-GM-RAW \"invoice from:ann@x.test\"");
        let b = gmail_criteria(&q("Báo cáo"));
        assert_eq!(flat(&b), "CHARSET UTF-8 X-GM-RAW <Báo cáo>");
        assert_eq!(flat(&gmail_criteria(&q("has:attachment"))), "X-GM-RAW \"has:attachment\"");
        assert!(!gmail_criteria(&q("has:attachment")).has_attachment, "Gmail filters by itself");
    }

    fn row(uid: u32, mid: Option<&str>, date: i64) -> Row {
        Row { account_id: "a".into(), role: "inbox".into(), uid, validity: Some(1), subject: "s".into(), from_name: String::new(), from_email: "x@y.z".into(), date, seen: true, flagged: false, has_attach: false, message_id: mid.map(str::to_string) }
    }

    #[test]
    fn server_results_leave_out_what_is_stored_locally_and_keep_the_newest_200() {
        // the UIDs: found minus stored, newest (highest) first, bounded
        let local: HashSet<u32> = [3, 5].into_iter().collect();
        assert_eq!(candidates(&[1, 2, 3, 4, 5, 6], &local, 10), (vec![6, 4, 2, 1], 4));
        assert_eq!(candidates(&[1, 2, 3, 4, 5, 6], &local, 2), (vec![6, 4], 4), "the cap keeps the newest, the total is told");
        assert_eq!(candidates(&[], &local, 2), (vec![], 0));
        // the merge: what the computer has (by Message-ID) is left out, duplicates collapse, newest first, 200 at most
        let have: HashSet<String> = ["<have@x>".to_string()].into_iter().collect();
        let (rows, capped) = merge(vec![row(1, Some("<have@x>"), 50), row(2, Some("<a@x>"), 10), row(3, Some("<a@x>"), 10), row(4, None, 30), row(5, Some("<b@x>"), 20)], &have, false);
        assert_eq!(rows.iter().map(|r| r.uid).collect::<Vec<_>>(), vec![4, 5, 2], "newest first");
        assert!(!capped);
        let many: Vec<Row> = (1..=450).map(|u| row(u, Some(&format!("<m{u}@x>")), i64::from(u))).collect();
        let (rows, capped) = merge(many, &HashSet::new(), false);
        assert_eq!(rows.len(), MAX_ROWS);
        assert_eq!(rows[0].uid, 450, "the newest by date");
        assert!(capped);
        let (_, capped) = merge(vec![row(1, None, 1)], &HashSet::new(), true);
        assert!(capped, "more were found than were fetched");
    }

    #[test]
    fn the_scope_decides_the_folders() {
        let map: HashMap<String, String> = [("inbox", "INBOX"), ("sent", "Sent"), ("drafts", "Drafts"), ("trash", "Bin"), ("junk", "Spam"), ("archive", "Archive"), ("f:Lists", "Lists")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let names = |v: Vec<(String, String)>| v.into_iter().map(|f| f.0).collect::<Vec<_>>();
        assert_eq!(names(folders_to_search(&map, "current", "inbox", None)), vec!["inbox"]);
        assert_eq!(names(folders_to_search(&map, "current", "f:Lists", None)), vec!["f:Lists"]);
        assert_eq!(names(folders_to_search(&map, "current", "unread", None)), vec!["inbox"]);
        assert_eq!(names(folders_to_search(&map, "account", "inbox", None)), vec!["archive", "drafts", "f:Lists", "inbox", "sent"], "Deleted Items and Junk Email are left out");
        assert_eq!(names(folders_to_search(&map, "all", "inbox", None)), names(folders_to_search(&map, "account", "inbox", None)));
        assert_eq!(names(folders_to_search(&map, "current", "starred", None)), names(folders_to_search(&map, "account", "inbox", None)));
        // folder: / in: narrow it
        assert_eq!(names(folders_to_search(&map, "account", "inbox", Some("sent"))), vec!["sent"]);
        assert_eq!(names(folders_to_search(&map, "account", "inbox", Some("nowhere"))).len(), 0, "a name the mailbox has not: nothing");
        assert_eq!(names(folders_to_search(&map, "account", "inbox", Some("lists"))), vec!["f:Lists"], "the name is matched whatever its case");
        assert_eq!(names(folders_to_search(&map, "current", "inbox", Some("spam"))), vec!["junk"], "an explicit folder is searched even when it is Junk");
        assert!(folders_to_search(&HashMap::new(), "current", "inbox", None).is_empty());
    }

    fn msg(id: &str, subject: &str, attach: bool) -> Vec<u8> {
        let extra = if attach { "Content-Disposition: attachment; filename=a.pdf\r\n" } else { "" };
        format!("Message-ID: <{id}>\r\nFrom: Ann <ann@x.test>\r\nTo: me@x.test\r\nDate: Mon, 1 Jan 2024 10:00:00 +0000\r\nSubject: {subject}\r\n{extra}\r\nbody").into_bytes()
    }

    #[test]
    fn a_folder_search_fetches_headers_only_for_what_is_not_stored() {
        crate::test_guard::within(60, || {
            let fake = Fake::start(&[("INBOX", &[])]);
            for u in 1..=5u32 {
                fake.put_message("INBOX", u, &msg(&format!("m{u}@x"), &format!("invoice {u}"), u == 4));
                fake.state.lock().unwrap().dates.insert(("INBOX".into(), u), format!("0{u}-Jan-2024 10:00:00 +0000"));
            }
            fake.state.lock().unwrap().seen.insert(("INBOX".into(), 2));
            let mut s = fake.connect();
            // UIDs 1 and 2 are stored here
            let local: HashSet<u32> = [1, 2].into_iter().collect();
            let built = criteria(&q("invoice"));
            let hits = search_folder(&mut s, "a", "inbox", "INBOX", &built, &local, MAX_ROWS).unwrap();
            assert_eq!(hits.total_new, 3);
            let mut uids: Vec<u32> = hits.rows.iter().map(|r| r.uid).collect();
            uids.sort();
            assert_eq!(uids, vec![3, 4, 5]);
            let r4 = hits.rows.iter().find(|r| r.uid == 4).unwrap();
            assert!(r4.has_attach && r4.subject == "invoice 4" && r4.from_email == "ann@x.test" && r4.from_name == "Ann" && r4.validity == Some(1));
            assert!(!hits.rows.iter().find(|r| r.uid == 3).unwrap().has_attach);
            assert_eq!(r4.date, 1704362400, "INTERNALDATE 04-Jan-2024 10:00 UTC");
            // only headers: no BODY[] was fetched, and nothing was stored or changed (EXAMINE, no STORE)
            let log = fake.commands();
            assert!(!log.iter().any(|c| c.to_uppercase().contains("BODY.PEEK[]")), "{log:?}");
            assert!(log.iter().any(|c| c.starts_with("EXAMINE")) && !log.iter().any(|c| c.starts_with("SELECT") || c.contains("STORE")), "{log:?}");
            assert!(log.iter().any(|c| c.contains("HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)")), "{log:?}");
            // has:attachment keeps the rows with an attachment part
            let built = criteria(&q("has:attachment invoice"));
            let hits = search_folder(&mut s, "a", "inbox", "INBOX", &built, &local, MAX_ROWS).unwrap();
            assert_eq!(hits.rows.iter().map(|r| r.uid).collect::<Vec<_>>(), vec![4]);
            let _ = s.logout();
        });
    }

    #[test]
    fn a_vietnamese_word_is_sent_as_a_utf8_literal_and_found() {
        crate::test_guard::within(60, || {
            let fake = Fake::start(&[("INBOX", &[])]);
            fake.put_message("INBOX", 1, &msg("v@x", "Báo cáo quý", false));
            let mut s = fake.connect();
            let built = criteria(&q("Báo cáo"));
            let hits = search_folder(&mut s, "a", "inbox", "INBOX", &built, &HashSet::new(), MAX_ROWS).unwrap();
            assert_eq!(hits.rows.len(), 1);
            assert_eq!(hits.rows[0].subject, "Báo cáo quý");
            let st = fake.state.lock().unwrap();
            assert_eq!(st.literals, vec!["Báo".as_bytes().to_vec(), "cáo".as_bytes().to_vec()], "UTF-8 bytes, not a quoted string");
            assert!(st.log.iter().any(|c| c.starts_with("UID SEARCH CHARSET UTF-8 TEXT")), "{:?}", st.log);
            drop(st);
            let _ = s.logout();
        });
    }

    #[test]
    fn a_gmail_like_server_gets_one_x_gm_raw_search_in_all_mail_for_the_whole_mailbox() {
        crate::test_guard::within(60, || {
            let db = crate::quit_tests::test_db("w67-gmail");
            let acc = Account {
                id: "a-srch".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
            };
            db::insert_account(&lock(&db), &acc).unwrap();
            let fake = Fake::start(&[("INBOX", &[]), ("[Gmail]/All Mail", &[]), ("[Gmail]/Sent Mail", &[])]);
            fake.state.lock().unwrap().gmail = true;
            fake.put_message("[Gmail]/All Mail", 7, &msg("g@x", "invoice", false));
            let folders = vec![("inbox".to_string(), "INBOX".to_string()), ("archive".to_string(), "[Gmail]/All Mail".to_string()), ("sent".to_string(), "[Gmail]/Sent Mail".to_string())];
            let mut s = fake.connect();
            let (rows, beyond) = search_mailbox(&mut s, &db, "a-srch", &folders, &q("invoice"), true, &|| false).unwrap();
            assert_eq!(rows.len(), 1);
            assert!(!beyond);
            let log = fake.commands();
            let searches: Vec<&String> = log.iter().filter(|c| c.starts_with("UID SEARCH")).collect();
            assert_eq!(searches.len(), 1, "{log:?}");
            assert_eq!(searches[0], "UID SEARCH X-GM-RAW \"invoice\"");
            assert!(log.iter().any(|c| c == "EXAMINE \"[Gmail]/All Mail\""), "{log:?}");
            // the current folder only: that folder, still with X-GM-RAW
            let (_, _) = search_mailbox(&mut s, &db, "a-srch", &folders[..1], &q("invoice"), false, &|| false).unwrap();
            assert!(fake.commands().iter().any(|c| c == "EXAMINE INBOX" || c == "EXAMINE \"INBOX\""));
            // a stop between folders ends it
            assert_eq!(search_mailbox(&mut s, &db, "a-srch", &folders, &q("invoice"), false, &|| true).err().as_deref(), Some("cancelled"));
            let _ = s.logout();
        });
    }

    #[test]
    fn the_words_of_a_search_are_never_logged_and_nothing_is_stored_before_a_row_is_opened() {
        let src = crate::test_guard::non_test_code(include_str!("serversearch.rs"));
        for line in src.lines().filter(|l| l.contains("startup::line(")) {
            assert!(!line.contains("search)") && !line.contains("words") && !line.contains("{search}") && !line.contains("q."), "a log line names the search: {line}");
        }
        // only `open_row` stores (`store_page`), and nothing else in the module writes mail
        assert_eq!(src.matches("store_page(").count(), 1);
        assert!(!src.contains("insert_parsed(") && !src.contains("INSERT INTO messages"));
    }

    #[test]
    fn a_server_row_opened_is_stored_and_kept_from_pruning() {
        crate::test_guard::within(60, || {
            let db = crate::quit_tests::test_db("w67-open");
            let acc = Account {
                id: "a-open".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
                smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
                smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
            };
            db::insert_account(&lock(&db), &acc).unwrap();
            let fake = Fake::start(&[("INBOX", &[])]);
            fake.put_message("INBOX", 9, &msg("old@x", "an old invoice", false));
            fake.state.lock().unwrap().dates.insert(("INBOX".into(), 9), "01-Jan-2001 10:00:00 +0000".into());
            // 130 newer messages are stored already: the opened one is the oldest and over the cap of 100
            for uid in 100..230u32 {
                lock(&db)
                    .execute(
                        "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,'a-open','inbox',?2,?3,'s','n','p@x.test','','',?4,'')",
                        rusqlite::params![format!("a-open:inbox:{uid}"), uid, format!("t{uid}"), 1_700_000_000i64 + i64::from(uid)],
                    )
                    .unwrap();
            }
            let mut s = fake.connect();
            // a folder renumbered since the search: nothing is stored, FOLDER_CHANGED
            let e = open_on(&db, &acc, &mut s, "inbox", "INBOX", 9, Some(7)).unwrap_err();
            assert!(mail::is_folder_changed(&e), "{e}");
            assert!(lock(&db).query_row("SELECT 1 FROM messages WHERE uid=9", [], |_| Ok(())).is_err());
            // a message that is gone
            let e = open_on(&db, &acc, &mut s, "inbox", "INBOX", 77, Some(1)).unwrap_err();
            assert!(e.starts_with("MSG_NOT_ON_SERVER"), "{e}");
            // the real one: stored through the same path as "Load older", a conversation to open, read with BODY.PEEK (it stays unread on the server)
            let tid = open_on(&db, &acc, &mut s, "inbox", "INBOX", 9, Some(1)).unwrap();
            let _ = s.logout();
            let (subject, folder): (String, String) = lock(&db).query_row("SELECT subject, folder FROM messages WHERE thread_id=?1", [&tid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            assert_eq!((subject.as_str(), folder.as_str()), ("an old invoice", "inbox"));
            assert!(fake.commands().iter().any(|c| c.contains("BODY.PEEK[]")) && !fake.commands().iter().any(|c| c.contains("STORE")));
            assert!(protected().contains("a-open:inbox:9"));
            // the prune keeps it for the rest of the run
            db::set_setting(&lock(&db), "max_download", "100").unwrap();
            let removed = crate::prune_oldest(&db, "a-open", 100, &HashSet::new()).unwrap();
            assert_eq!(removed, 31, "131 stored, the cap is 100");
            assert!(lock(&db).query_row("SELECT 1 FROM messages WHERE id='a-open:inbox:9'", [], |_| Ok(())).is_ok(), "the opened message is still here although it is the oldest");
        });
    }

    #[test]
    fn a_cancel_makes_the_running_search_stale_and_shuts_its_sockets() {
        let before = GENERATION.load(Ordering::SeqCst);
        cancel_all();
        assert!(GENERATION.load(Ordering::SeqCst) > before);
        assert!(SOCKETS.lock().unwrap().is_empty());
    }
}
