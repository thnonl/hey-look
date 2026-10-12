mod ai;
mod db;
mod mail;
mod smtp;

use db::{err, Account, R};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager;

type Db = Arc<Mutex<Connection>>;

struct AppState {
    db: Db,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

fn lock(db: &Db) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

fn password(account_id: &str) -> R<String> {
    keyring::Entry::new("hey-look", account_id)
        .and_then(|e| e.get_password())
        .map_err(|e| format!("no stored password: {e}"))
}

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

// ---------- accounts ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountInput {
    email: String,
    display_name: String,
    imap_host: String,
    imap_port: u16,
    imap_ssl: bool,
    smtp_host: String,
    smtp_port: u16,
    smtp_security: String,
    username: String,
}

#[tauri::command]
fn list_accounts(state: tauri::State<AppState>) -> R<Vec<Account>> {
    db::list_accounts(&lock(&state.db))
}

#[tauri::command]
async fn add_account(state: tauri::State<'_, AppState>, input: AccountInput, password_value: String) -> R<Account> {
    let acc = Account {
        id: uuid::Uuid::new_v4().to_string(),
        email: input.email,
        display_name: input.display_name,
        imap_host: input.imap_host,
        imap_port: input.imap_port,
        imap_ssl: input.imap_ssl,
        smtp_host: input.smtp_host,
        smtp_port: input.smtp_port,
        smtp_security: input.smtp_security,
        username: input.username,
    };
    let a2 = acc.clone();
    let pw = password_value.clone();
    blocking(move || {
        let mut s = mail::connect(&a2, &pw)?;
        let _ = s.logout();
        Ok(())
    })
    .await?;
    keyring::Entry::new("hey-look", &acc.id)
        .and_then(|e| e.set_password(&password_value))
        .map_err(|e| format!("cannot store password: {e}"))?;
    db::insert_account(&lock(&state.db), &acc)?;
    Ok(acc)
}

#[tauri::command]
fn remove_account(state: tauri::State<AppState>, account_id: String) -> R<()> {
    db::remove_account(&lock(&state.db), &account_id)?;
    if let Ok(e) = keyring::Entry::new("hey-look", &account_id) {
        let _ = e.delete_credential();
    }
    Ok(())
}

// ---------- sync ----------

fn fmap(db: &Db, account_id: &str) -> HashMap<String, String> {
    db::get_setting(&lock(db), &format!("fmap:{account_id}"))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn insert_parsed(c: &Connection, acc: &Account, role: &str, p: &mail::Parsed) -> R<()> {
    let root = p
        .refs
        .first()
        .cloned()
        .or_else(|| p.message_id.clone())
        .unwrap_or_else(|| format!("{}:{}:{}", acc.id, role, p.uid));
    let thread_id = fnv(&format!("{}|{}", acc.id, root));
    c.execute(
        "INSERT OR REPLACE INTO messages(id,account_id,folder,uid,message_id,thread_id,subject,from_name,from_email,
           to_addrs,cc_addrs,date,snippet,body_html,body_text,seen,flagged,has_attach,list_unsub,list_unsub_post)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![
            format!("{}:{}:{}", acc.id, role, p.uid),
            acc.id,
            role,
            p.uid,
            p.message_id,
            thread_id,
            p.subject,
            p.from_name,
            p.from_email,
            p.to.join(","),
            p.cc.join(","),
            p.date,
            p.snippet,
            p.html,
            p.text,
            p.seen as i64,
            p.flagged as i64,
            p.has_attach as i64,
            p.list_unsub,
            p.list_unsub_post as i64
        ],
    )
    .map_err(err)?;
    Ok(())
}

fn sync_impl(db: &Db, account_id: &str) -> R<u32> {
    let acc = db::get_account(&lock(db), account_id)?;
    let pw = password(account_id)?;
    let mut s = mail::connect(&acc, &pw)?;
    let map = mail::discover_folders(&mut s)?;
    db::set_setting(
        &lock(db),
        &format!("fmap:{account_id}"),
        &serde_json::to_string(&map).map_err(err)?,
    )?;
    let mut added = 0u32;
    for role in mail::ROLES {
        let Some(name) = map.get(role) else { continue };
        let (max_uid, min_uid): (u32, u32) = lock(db)
            .query_row(
                "SELECT COALESCE(MAX(uid),0), COALESCE(MIN(uid),0) FROM messages WHERE account_id=?1 AND folder=?2",
                params![account_id, role],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(err)?;
        let initial = if role == "inbox" { 300 } else { 100 };
        let ff = match mail::fetch_folder(&mut s, name, max_uid, min_uid, initial) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let c = lock(db);
        c.execute_batch("BEGIN").map_err(err)?;
        for p in &ff.new {
            insert_parsed(&c, &acc, role, p)?;
            added += 1;
        }
        if max_uid > 0 {
            let present: std::collections::HashSet<u32> = ff.flags.iter().map(|f| f.0).collect();
            for (uid, seen, flagged) in &ff.flags {
                c.execute(
                    "UPDATE messages SET seen=?1, flagged=?2 WHERE account_id=?3 AND folder=?4 AND uid=?5",
                    params![*seen as i64, *flagged as i64, account_id, role, uid],
                )
                .map_err(err)?;
            }
            let mut st = c
                .prepare("SELECT uid FROM messages WHERE account_id=?1 AND folder=?2 AND uid BETWEEN ?3 AND ?4")
                .map_err(err)?;
            let known: Vec<u32> = st
                .query_map(params![account_id, role, min_uid, max_uid], |r| r.get(0))
                .map_err(err)?
                .filter_map(|r| r.ok())
                .collect();
            drop(st);
            for uid in known {
                if !present.contains(&uid) {
                    c.execute(
                        "DELETE FROM messages WHERE account_id=?1 AND folder=?2 AND uid=?3",
                        params![account_id, role, uid],
                    )
                    .map_err(err)?;
                }
            }
        }
        c.execute_batch("COMMIT").map_err(err)?;
    }
    let _ = s.logout();
    Ok(added)
}

#[tauri::command]
async fn sync_account(state: tauri::State<'_, AppState>, account_id: String) -> R<u32> {
    let db = state.db.clone();
    blocking(move || sync_impl(&db, &account_id)).await
}

// ---------- threads ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadFilter {
    account_id: Option<String>,
    /// inbox|sent|drafts|archive|trash|junk|starred|pinned|snoozed|unread|all
    folder: String,
    search: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSummary {
    thread_id: String,
    account_id: String,
    subject: String,
    participants: Vec<String>,
    snippet: String,
    last_date: i64,
    count: u32,
    unread: u32,
    flagged: bool,
    pinned: bool,
    snoozed_until: Option<i64>,
    has_attach: bool,
}

#[tauri::command]
fn list_threads(state: tauri::State<AppState>, filter: ThreadFilter) -> R<Vec<ThreadSummary>> {
    let c = lock(&state.db);
    let t = now();
    let mut w: Vec<String> = vec![];
    let mut p: Vec<rusqlite::types::Value> = vec![];
    if let Some(a) = &filter.account_id {
        w.push("m.account_id=?".into());
        p.push(a.clone().into());
    }
    match filter.folder.as_str() {
        "inbox" => {
            w.push("m.folder='inbox' AND (tm.snoozed_until IS NULL OR tm.snoozed_until<=?)".into());
            p.push(t.into());
        }
        "unread" => {
            w.push("m.folder='inbox' AND m.seen=0 AND (tm.snoozed_until IS NULL OR tm.snoozed_until<=?)".into());
            p.push(t.into());
        }
        "starred" => w.push("m.flagged=1 AND m.folder NOT IN ('trash','junk')".into()),
        "pinned" => w.push("tm.pinned=1 AND m.folder NOT IN ('trash','junk')".into()),
        "snoozed" => {
            w.push("tm.snoozed_until>?".into());
            p.push(t.into());
        }
        "all" => w.push("m.folder NOT IN ('trash','junk')".into()),
        f => {
            w.push("m.folder=?".into());
            p.push(f.to_string().into());
        }
    }
    if filter.folder == "inbox" || filter.folder == "unread" {
        w.push("m.from_email NOT IN (SELECT email FROM blocked)".into());
    }
    if let Some(q) = filter.search.as_ref().filter(|q| !q.trim().is_empty()) {
        w.push("m.folder NOT IN ('trash','junk') AND (m.subject LIKE ? OR m.from_email LIKE ? OR m.from_name LIKE ? OR m.snippet LIKE ? OR m.body_text LIKE ?)".into());
        let like = format!("%{}%", q.trim());
        for _ in 0..5 {
            p.push(like.clone().into());
        }
    }
    let sql = format!(
        "SELECT m.thread_id,m.account_id,m.subject,m.from_name,m.from_email,m.snippet,m.date,m.seen,m.flagged,m.has_attach,
                COALESCE(tm.pinned,0), tm.snoozed_until
         FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id
         WHERE {} ORDER BY m.date DESC LIMIT 4000",
        w.join(" AND ")
    );
    let mut st = c.prepare(&sql).map_err(err)?;
    let rows = st
        .query_map(params_from_iter(p.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)? != 0,
                r.get::<_, i64>(8)? != 0,
                r.get::<_, i64>(9)? != 0,
                r.get::<_, i64>(10)? != 0,
                r.get::<_, Option<i64>>(11)?,
            ))
        })
        .map_err(err)?;
    let mut order: Vec<String> = vec![];
    let mut map: HashMap<String, ThreadSummary> = HashMap::new();
    for row in rows {
        let (tid, acct, subject, fname, femail, snippet, date, seen, flagged, att, pinned, snooze) = row.map_err(err)?;
        let who = if fname.is_empty() { femail } else { fname };
        let e = map.entry(tid.clone()).or_insert_with(|| {
            order.push(tid.clone());
            ThreadSummary {
                thread_id: tid.clone(),
                account_id: acct,
                subject,
                participants: vec![],
                snippet,
                last_date: date,
                count: 0,
                unread: 0,
                flagged: false,
                pinned,
                snoozed_until: snooze,
                has_attach: false,
            }
        });
        e.count += 1;
        if !seen {
            e.unread += 1;
        }
        e.flagged |= flagged;
        e.has_attach |= att;
        if e.participants.len() < 3 && !e.participants.contains(&who) {
            e.participants.push(who);
        }
    }
    let mut out: Vec<ThreadSummary> = order.into_iter().filter_map(|k| map.remove(&k)).collect();
    if filter.folder == "inbox" {
        out.sort_by_key(|t| !t.pinned); // stable: pinned first, date order kept
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageFull {
    id: String,
    account_id: String,
    folder: String,
    message_id: Option<String>,
    subject: String,
    from_name: String,
    from_email: String,
    to: String,
    cc: String,
    date: i64,
    html: Option<String>,
    text: Option<String>,
    seen: bool,
    flagged: bool,
    has_attach: bool,
    can_unsubscribe: bool,
}

#[tauri::command]
fn get_thread(state: tauri::State<AppState>, thread_id: String) -> R<Vec<MessageFull>> {
    let c = lock(&state.db);
    let mut st = c
        .prepare(
            "SELECT id,account_id,folder,message_id,subject,from_name,from_email,to_addrs,cc_addrs,date,body_html,body_text,
                    seen,flagged,has_attach,list_unsub
             FROM messages WHERE thread_id=?1 AND folder NOT IN ('trash','junk') ORDER BY date ASC",
        )
        .map_err(err)?;
    let rows = st
        .query_map([thread_id], |r| {
            Ok(MessageFull {
                id: r.get(0)?,
                account_id: r.get(1)?,
                folder: r.get(2)?,
                message_id: r.get(3)?,
                subject: r.get(4)?,
                from_name: r.get(5)?,
                from_email: r.get(6)?,
                to: r.get(7)?,
                cc: r.get(8)?,
                date: r.get(9)?,
                html: r.get(10)?,
                text: r.get(11)?,
                seen: r.get::<_, i64>(12)? != 0,
                flagged: r.get::<_, i64>(13)? != 0,
                has_attach: r.get::<_, i64>(14)? != 0,
                can_unsubscribe: r.get::<_, Option<String>>(15)?.is_some(),
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

// ---------- thread actions ----------

struct MsgRef {
    account_id: String,
    role: String,
    uid: u32,
    id: String,
}

fn thread_msgs(c: &Connection, thread_ids: &[String]) -> R<Vec<MsgRef>> {
    let mut out = vec![];
    for t in thread_ids {
        let mut st = c
            .prepare("SELECT account_id,folder,uid,id FROM messages WHERE thread_id=?1")
            .map_err(err)?;
        let rows = st
            .query_map([t], |r| {
                Ok(MsgRef { account_id: r.get(0)?, role: r.get(1)?, uid: r.get(2)?, id: r.get(3)? })
            })
            .map_err(err)?;
        for r in rows {
            out.push(r.map_err(err)?);
        }
    }
    Ok(out)
}

fn action_impl(db: &Db, thread_ids: Vec<String>, action: String, arg: Option<String>) -> R<()> {
    // local-only actions
    match action.as_str() {
        "pin" | "unpin" => {
            let c = lock(db);
            for t in &thread_ids {
                c.execute(
                    "INSERT INTO thread_meta(thread_id,pinned) VALUES(?1,?2)
                     ON CONFLICT(thread_id) DO UPDATE SET pinned=excluded.pinned",
                    params![t, (action == "pin") as i64],
                )
                .map_err(err)?;
            }
            return Ok(());
        }
        "snooze" | "unsnooze" => {
            let until: Option<i64> = if action == "snooze" {
                Some(arg.as_deref().and_then(|a| a.parse().ok()).ok_or("snooze needs timestamp")?)
            } else {
                None
            };
            let c = lock(db);
            for t in &thread_ids {
                c.execute(
                    "INSERT INTO thread_meta(thread_id,snoozed_until) VALUES(?1,?2)
                     ON CONFLICT(thread_id) DO UPDATE SET snoozed_until=excluded.snoozed_until",
                    params![t, until],
                )
                .map_err(err)?;
            }
            return Ok(());
        }
        "block" => {
            let c = lock(db);
            for t in &thread_ids {
                c.execute(
                    "INSERT OR IGNORE INTO blocked(email) SELECT DISTINCT from_email FROM messages WHERE thread_id=?1",
                    [t],
                )
                .map_err(err)?;
            }
            drop(c);
            return action_impl(db, thread_ids, "trash".into(), None);
        }
        _ => {}
    }

    let msgs = thread_msgs(&lock(db), &thread_ids)?;
    let mut by_acct: HashMap<String, Vec<MsgRef>> = HashMap::new();
    for m in msgs {
        by_acct.entry(m.account_id.clone()).or_default().push(m);
    }
    for (acct_id, list) in by_acct {
        let acc = db::get_account(&lock(db), &acct_id)?;
        let pw = password(&acct_id)?;
        let map = fmap(db, &acct_id);
        let mut s = mail::connect(&acc, &pw)?;
        let real = |role: &str| map.get(role).cloned();
        for role in mail::ROLES {
            let group: Vec<&MsgRef> = list.iter().filter(|m| m.role == role).collect();
            if group.is_empty() {
                continue;
            }
            let uids: Vec<u32> = group.iter().map(|m| m.uid).collect();
            let src = real(role).ok_or("source folder unknown")?;
            match action.as_str() {
                "read" | "unread" => {
                    mail::store_flag(&mut s, &src, &uids, "\\Seen", action == "read")?;
                    let c = lock(db);
                    for m in &group {
                        c.execute("UPDATE messages SET seen=?1 WHERE id=?2", params![(action == "read") as i64, m.id])
                            .map_err(err)?;
                    }
                }
                "star" | "unstar" => {
                    mail::store_flag(&mut s, &src, &uids, "\\Flagged", action == "star")?;
                    let c = lock(db);
                    for m in &group {
                        c.execute("UPDATE messages SET flagged=?1 WHERE id=?2", params![(action == "star") as i64, m.id])
                            .map_err(err)?;
                    }
                }
                "archive" | "trash" | "junk" | "inbox" => {
                    if role == action {
                        continue;
                    }
                    if action == "trash" && role == "trash" {
                        continue;
                    }
                    let dst = real(&action).ok_or_else(|| format!("no '{action}' folder on this account"))?;
                    mail::move_to(&mut s, &src, &uids, &dst)?;
                    let c = lock(db);
                    for m in &group {
                        c.execute("DELETE FROM messages WHERE id=?1", [&m.id]).map_err(err)?;
                    }
                }
                "delete_forever" => {
                    mail::delete_forever(&mut s, &src, &uids)?;
                    let c = lock(db);
                    for m in &group {
                        c.execute("DELETE FROM messages WHERE id=?1", [&m.id]).map_err(err)?;
                    }
                }
                other => return Err(format!("unknown action: {other}")),
            }
        }
        let _ = s.logout();
    }
    Ok(())
}

#[tauri::command]
async fn thread_action(
    state: tauri::State<'_, AppState>,
    thread_ids: Vec<String>,
    action: String,
    arg: Option<String>,
) -> R<()> {
    let db = state.db.clone();
    blocking(move || action_impl(&db, thread_ids, action, arg)).await
}

// ---------- send / outbox ----------

fn send_now(db: &Db, d: &smtp::Draft) -> R<()> {
    let acc = db::get_account(&lock(db), &d.account_id)?;
    let pw = password(&acc.id)?;
    let msg = smtp::build(&acc, d)?;
    smtp::send(&acc, &pw, &msg)?;
    let h = acc.smtp_host.to_lowercase();
    let auto_saves = h.contains("gmail") || h.contains("googlemail") || h.contains("office365") || h.contains("outlook");
    if !auto_saves {
        if let Some(sent) = fmap(db, &acc.id).get("sent").cloned() {
            if let Ok(mut s) = mail::connect(&acc, &pw) {
                let _ = mail::append(&mut s, &sent, &msg.formatted());
                let _ = s.logout();
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn send_message(state: tauri::State<'_, AppState>, draft: smtp::Draft, send_at: Option<i64>) -> R<String> {
    let db = state.db.clone();
    if let Some(at) = send_at.filter(|a| *a > now() + 10) {
        let payload = serde_json::to_string(&draft).map_err(err)?;
        lock(&db)
            .execute(
                "INSERT INTO outbox(id,account_id,payload,send_at) VALUES(?1,?2,?3,?4)",
                params![uuid::Uuid::new_v4().to_string(), draft.account_id, payload, at],
            )
            .map_err(err)?;
        return Ok("scheduled".into());
    }
    blocking(move || send_now(&db, &draft)).await?;
    Ok("sent".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboxItem {
    id: String,
    account_id: String,
    subject: String,
    to: Vec<String>,
    send_at: i64,
    status: String,
    error: Option<String>,
}

#[tauri::command]
fn list_outbox(state: tauri::State<AppState>) -> R<Vec<OutboxItem>> {
    let c = lock(&state.db);
    let mut st = c
        .prepare("SELECT id,account_id,payload,send_at,status,error FROM outbox WHERE status!='sent' ORDER BY send_at")
        .map_err(err)?;
    let rows = st
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(err)?;
    let mut out = vec![];
    for r in rows {
        let (id, account_id, payload, send_at, status, error) = r.map_err(err)?;
        let d: smtp::Draft = serde_json::from_str(&payload).map_err(err)?;
        out.push(OutboxItem { id, account_id, subject: d.subject, to: d.to, send_at, status, error });
    }
    Ok(out)
}

#[tauri::command]
fn cancel_outbox(state: tauri::State<AppState>, id: String) -> R<()> {
    lock(&state.db).execute("DELETE FROM outbox WHERE id=?1", [id]).map_err(err)?;
    Ok(())
}

fn outbox_worker(db: Db) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(15));
        let due: Vec<(String, String)> = {
            let c = lock(&db);
            let Ok(mut st) = c.prepare("SELECT id,payload FROM outbox WHERE status='pending' AND send_at<=?1") else {
                continue;
            };
            let Ok(rows) = st.query_map([now()], |r| Ok((r.get(0)?, r.get(1)?))) else { continue };
            rows.filter_map(|r| r.ok()).collect()
        };
        for (id, payload) in due {
            let res = serde_json::from_str::<smtp::Draft>(&payload).map_err(err).and_then(|d| send_now(&db, &d));
            let c = lock(&db);
            match res {
                Ok(()) => {
                    let _ = c.execute("UPDATE outbox SET status='sent' WHERE id=?1", [&id]);
                }
                Err(e) => {
                    let _ = c.execute("UPDATE outbox SET status='failed', error=?2 WHERE id=?1", params![id, e]);
                }
            }
        }
    }
}

// ---------- templates / signatures ----------

#[derive(Serialize, Deserialize)]
struct Template {
    id: String,
    name: String,
    subject: String,
    body: String,
}

#[tauri::command]
fn list_templates(state: tauri::State<AppState>) -> R<Vec<Template>> {
    let c = lock(&state.db);
    let mut st = c.prepare("SELECT id,name,subject,body FROM templates ORDER BY name").map_err(err)?;
    let rows = st
        .query_map([], |r| Ok(Template { id: r.get(0)?, name: r.get(1)?, subject: r.get(2)?, body: r.get(3)? }))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

#[tauri::command]
fn save_template(state: tauri::State<AppState>, template: Template) -> R<()> {
    lock(&state.db)
        .execute(
            "INSERT OR REPLACE INTO templates VALUES(?1,?2,?3,?4)",
            params![template.id, template.name, template.subject, template.body],
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn delete_template(state: tauri::State<AppState>, id: String) -> R<()> {
    lock(&state.db).execute("DELETE FROM templates WHERE id=?1", [id]).map_err(err)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Signature {
    id: String,
    name: String,
    html: String,
    is_default: bool,
}

#[tauri::command]
fn list_signatures(state: tauri::State<AppState>) -> R<Vec<Signature>> {
    let c = lock(&state.db);
    let mut st = c.prepare("SELECT id,name,html,is_default FROM signatures ORDER BY name").map_err(err)?;
    let rows = st
        .query_map([], |r| {
            Ok(Signature { id: r.get(0)?, name: r.get(1)?, html: r.get(2)?, is_default: r.get::<_, i64>(3)? != 0 })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

#[tauri::command]
fn save_signature(state: tauri::State<AppState>, signature: Signature) -> R<()> {
    let c = lock(&state.db);
    if signature.is_default {
        c.execute("UPDATE signatures SET is_default=0", []).map_err(err)?;
    }
    c.execute(
        "INSERT OR REPLACE INTO signatures VALUES(?1,?2,?3,?4)",
        params![signature.id, signature.name, signature.html, signature.is_default as i64],
    )
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn delete_signature(state: tauri::State<AppState>, id: String) -> R<()> {
    lock(&state.db).execute("DELETE FROM signatures WHERE id=?1", [id]).map_err(err)?;
    Ok(())
}

// ---------- settings / contacts / unsubscribe / AI ----------

#[tauri::command]
fn get_setting(state: tauri::State<AppState>, key: String) -> Option<String> {
    db::get_setting(&lock(&state.db), &key)
}

#[tauri::command]
fn set_setting(state: tauri::State<AppState>, key: String, value: String) -> R<()> {
    db::set_setting(&lock(&state.db), &key, &value)
}

#[derive(Serialize)]
struct Contact {
    name: String,
    email: String,
}

#[tauri::command]
fn suggest_contacts(state: tauri::State<AppState>, prefix: String) -> R<Vec<Contact>> {
    let c = lock(&state.db);
    let like = format!("%{}%", prefix.trim());
    let mut st = c
        .prepare(
            "SELECT MAX(from_name), from_email, COUNT(*) n FROM messages
             WHERE from_email!='' AND (from_email LIKE ?1 OR from_name LIKE ?1)
             GROUP BY from_email ORDER BY n DESC LIMIT 8",
        )
        .map_err(err)?;
    let rows = st
        .query_map([like], |r| Ok(Contact { name: r.get(0)?, email: r.get(1)? }))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

#[derive(Serialize)]
struct UnsubResult {
    /// "done" | "open" | "mailto"
    kind: String,
    target: String,
}

#[tauri::command]
async fn unsubscribe(state: tauri::State<'_, AppState>, message_id: String) -> R<UnsubResult> {
    let (hdr, post): (String, bool) = lock(&state.db)
        .query_row(
            "SELECT COALESCE(list_unsub,''), list_unsub_post FROM messages WHERE id=?1",
            [&message_id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .map_err(err)?;
    let targets: Vec<String> = hdr
        .split('<')
        .skip(1)
        .filter_map(|s| s.split('>').next())
        .map(|s| s.trim().to_string())
        .collect();
    if let Some(u) = targets.iter().find(|t| t.starts_with("https://")) {
        if post {
            let ok = reqwest::Client::new()
                .post(u)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body("List-Unsubscribe=One-Click")
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if ok {
                return Ok(UnsubResult { kind: "done".into(), target: u.clone() });
            }
        }
        return Ok(UnsubResult { kind: "open".into(), target: u.clone() });
    }
    if let Some(m) = targets.iter().find(|t| t.starts_with("mailto:")) {
        return Ok(UnsubResult { kind: "mailto".into(), target: m.clone() });
    }
    if let Some(u) = targets.iter().find(|t| t.starts_with("http://")) {
        return Ok(UnsubResult { kind: "open".into(), target: u.clone() });
    }
    Err("no unsubscribe target".into())
}

#[tauri::command]
async fn ai_complete(state: tauri::State<'_, AppState>, system: String, prompt: String) -> R<String> {
    let (ep, key, model) = {
        let c = lock(&state.db);
        (
            db::get_setting(&c, "ai_endpoint").unwrap_or_default(),
            db::get_setting(&c, "ai_key").unwrap_or_default(),
            db::get_setting(&c, "ai_model").unwrap_or_default(),
        )
    };
    ai::complete(&ep, &key, &model, &system, &prompt).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("heylook.db"))?;
            let db: Db = Arc::new(Mutex::new(conn));
            let worker_db = db.clone();
            std::thread::spawn(move || outbox_worker(worker_db));
            app.manage(AppState { db });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_accounts,
            add_account,
            remove_account,
            sync_account,
            list_threads,
            get_thread,
            thread_action,
            send_message,
            list_outbox,
            cancel_outbox,
            list_templates,
            save_template,
            delete_template,
            list_signatures,
            save_signature,
            delete_signature,
            get_setting,
            set_setting,
            suggest_contacts,
            unsubscribe,
            ai_complete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
