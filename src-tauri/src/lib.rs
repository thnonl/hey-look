mod ai;
mod db;
mod discover;
mod mail;
mod oauth;
use oauth::Provider;
mod shell;
mod smtp;

use base64::Engine;
use db::{err, Account, R};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

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

/// OAuth client from the environment: a runtime variable wins over the value embedded at build
/// time (from the build environment or a `.env` file, see build.rs).
fn oauth_env(p: Provider) -> Option<(String, String)> {
    let pick = |runtime: Option<String>, built: Option<&'static str>| {
        runtime.filter(|v| !v.trim().is_empty()).or_else(|| built.map(String::from)).filter(|v| !v.trim().is_empty())
    };
    let (id, secret) = match p {
        Provider::Google => (
            pick(std::env::var("GOOGLE_CLIENT_ID").ok(), option_env!("GOOGLE_CLIENT_ID")),
            pick(std::env::var("GOOGLE_CLIENT_SECRET").ok(), option_env!("GOOGLE_CLIENT_SECRET")),
        ),
        Provider::Microsoft => (
            pick(std::env::var("MICROSOFT_CLIENT_ID").ok(), option_env!("MICROSOFT_CLIENT_ID")),
            pick(std::env::var("MICROSOFT_CLIENT_SECRET").ok(), option_env!("MICROSOFT_CLIENT_SECRET")),
        ),
    };
    Some((id?.trim().to_string(), secret.unwrap_or_default().trim().to_string()))
}

/// Microsoft tenant the user typed in the app ("common" when empty); needed again for every token refresh.
fn oauth_tenant(db: &Db, p: Provider) -> String {
    if p != Provider::Microsoft {
        return String::new();
    }
    let t = db::get_setting(&lock(db), "microsoft_tenant").unwrap_or_default();
    oauth::clean_tenant(&t).unwrap_or_else(|_| "common".into())
}

/// Saved tenant for the sign-in form ("" = common).
#[tauri::command]
fn microsoft_tenant(state: tauri::State<AppState>) -> String {
    let t = oauth_tenant(&state.db, Provider::Microsoft);
    if t == "common" { String::new() } else { t }
}

/// Settings / credential-manager names for a provider's client id and secret.
fn client_id_key(p: Provider) -> &'static str {
    match p {
        Provider::Google => "google_client_id",
        Provider::Microsoft => "microsoft_client_id",
    }
}

fn client_secret_key(p: Provider) -> &'static str {
    match p {
        Provider::Google => "google_client_secret",
        Provider::Microsoft => "microsoft_client_secret",
    }
}

// Secrets (AI key, OAuth client secrets) live in the Windows Credential Manager, not in the SQLite file.
const SECRET_NAMES: [&str; 3] = ["ai_key", "google_client_secret", "microsoft_client_secret"];

fn secret_get(name: &str) -> Option<String> {
    keyring::Entry::new("hey-look", &format!("secret:{name}"))
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

fn secret_set(name: &str, value: &str) -> R<()> {
    let e = keyring::Entry::new("hey-look", &format!("secret:{name}")).map_err(err)?;
    if value.is_empty() {
        let _ = e.delete_credential();
        Ok(())
    } else {
        e.set_password(value).map_err(err)
    }
}

/// Move values saved by older versions out of the settings table.
fn migrate_secrets(db: &Db) {
    let c = lock(db);
    for name in SECRET_NAMES {
        if let Some(v) = db::get_setting(&c, name).filter(|v| !v.is_empty()) {
            if secret_set(name, &v).is_ok() {
                let _ = db::set_setting(&c, name, "");
            }
        }
    }
}

#[tauri::command]
fn set_secret(name: String, value: String) -> R<()> {
    if !SECRET_NAMES.contains(&name.as_str()) {
        return Err("unknown secret".into());
    }
    secret_set(&name, &value)
}

#[tauri::command]
fn has_secret(name: String) -> bool {
    SECRET_NAMES.contains(&name.as_str()) && secret_get(&name).is_some()
}

/// Client id/secret to use: environment first, then what the user typed in Settings.
fn oauth_creds(db: &Db, p: Provider) -> (String, String) {
    oauth_env(p).unwrap_or_else(|| {
        let c = lock(db);
        (db::get_setting(&c, client_id_key(p)).unwrap_or_default(), secret_get(client_secret_key(p)).unwrap_or_default())
    })
}

#[tauri::command]
fn google_env_configured() -> bool {
    oauth_env(Provider::Google).is_some()
}

#[tauri::command]
fn microsoft_env_configured() -> bool {
    oauth_env(Provider::Microsoft).is_some()
}

/// Password, or a fresh OAuth access token for Google / Microsoft accounts.
fn secret(db: &Db, acc: &Account) -> R<String> {
    match Provider::from_auth(&acc.auth) {
        Some(p) => {
            let (id, sec) = oauth_creds(db, p);
            oauth::access_token(p, &oauth_tenant(db, p), &acc.id, &id, &sec)
        }
        None => password(&acc.id),
    }
}

/// Password (or token) for SMTP: the separate SMTP password when one is stored, else the IMAP secret.
fn smtp_secret(db: &Db, acc: &Account) -> R<String> {
    if Provider::from_auth(&acc.auth).is_none() {
        if let Some(pw) = keyring::Entry::new("hey-look", &format!("{}:smtp", acc.id)).ok().and_then(|e| e.get_password().ok()) {
            return Ok(pw);
        }
    }
    secret(db, acc)
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
    #[serde(default)]
    smtp_username: String,
    #[serde(default)]
    tls_insecure: bool,
}

#[tauri::command]
fn list_accounts(state: tauri::State<AppState>) -> R<Vec<Account>> {
    db::list_accounts(&lock(&state.db))
}

#[tauri::command]
async fn add_account(
    state: tauri::State<'_, AppState>,
    input: AccountInput,
    password_value: String,
    smtp_password: Option<String>,
) -> R<Account> {
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
        auth: "password".into(),
        color: None,
        smtp_username: input.smtp_username.trim().to_string(),
        tls_insecure: input.tls_insecure,
    };
    let smtp_password = smtp_password.filter(|p| !p.is_empty());
    let a2 = acc.clone();
    let pw = password_value.clone();
    let smtp_pw = smtp_password.clone().unwrap_or_else(|| password_value.clone());
    let test_smtp = !acc.smtp_username.is_empty() || smtp_password.is_some();
    blocking(move || {
        let mut s = mail::connect(&a2, &pw)?;
        let _ = s.logout();
        // only a separate SMTP login is verified up front; a shared one was never checked before either
        if test_smtp {
            smtp::test(&a2, &smtp_pw)?;
        }
        Ok(())
    })
    .await?;
    keyring::Entry::new("hey-look", &acc.id)
        .and_then(|e| e.set_password(&password_value))
        .map_err(|e| format!("cannot store password: {e}"))?;
    if let Some(sp) = &smtp_password {
        keyring::Entry::new("hey-look", &format!("{}:smtp", acc.id))
            .and_then(|e| e.set_password(sp))
            .map_err(|e| format!("cannot store SMTP password: {e}"))?;
    }
    db::insert_account(&lock(&state.db), &acc)?;
    Ok(acc)
}

#[tauri::command]
async fn google_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    client_secret: String,
    display_name: String,
) -> R<Account> {
    oauth_sign_in(app, state, Provider::Google, client_id, client_secret, None, display_name).await
}

#[tauri::command]
async fn microsoft_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    client_secret: String,
    tenant: Option<String>,
    display_name: String,
) -> R<Account> {
    oauth_sign_in(app, state, Provider::Microsoft, client_id, client_secret, tenant, display_name).await
}

async fn oauth_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    provider: Provider,
    client_id: String,
    client_secret: String,
    tenant: Option<String>,
    display_name: String,
) -> R<Account> {
    let label = provider.label();
    let tenant = if provider == Provider::Microsoft { oauth::clean_tenant(&tenant.unwrap_or_default())? } else { String::new() };
    let from_env = oauth_env(provider);
    let (client_id, client_secret) = match &from_env {
        Some((i, s)) => (i.clone(), s.clone()),
        None => {
            let secret = if client_secret.trim().is_empty() { secret_get(client_secret_key(provider)).unwrap_or_default() } else { client_secret };
            (client_id, secret)
        }
    };
    if client_id.trim().is_empty() {
        return Err(format!(
            "No {label} OAuth client configured: set {}_CLIENT_ID, or enter it in Settings > Accounts",
            label.to_uppercase()
        ));
    }
    let pending = oauth::begin(provider, &tenant, client_id.trim())?;
    app.opener().open_url(pending.url.clone(), None::<&str>).map_err(err)?;
    let (cid, csec) = (client_id.trim().to_string(), client_secret.trim().to_string());
    let signed = blocking(move || pending.finish(&cid, &csec)).await?;

    let existing = db::list_accounts(&lock(&state.db))?
        .into_iter()
        .find(|a| a.email.eq_ignore_ascii_case(&signed.email));
    let (imap_host, smtp_host, smtp_port, smtp_security) = match provider {
        Provider::Google => ("imap.gmail.com", "smtp.gmail.com", 465, "ssl"),
        Provider::Microsoft => ("outlook.office365.com", "smtp.office365.com", 587, "starttls"),
    };
    let acc = Account {
        id: existing.as_ref().map(|a| a.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        email: signed.email.clone(),
        display_name: if !display_name.trim().is_empty() {
            display_name.trim().to_string()
        } else if let Some(e) = &existing {
            e.display_name.clone()
        } else {
            signed.name.clone()
        },
        imap_host: imap_host.into(),
        imap_port: 993,
        imap_ssl: true,
        smtp_host: smtp_host.into(),
        smtp_port,
        smtp_security: smtp_security.into(),
        username: signed.email.clone(),
        auth: provider.auth().into(),
        color: existing.and_then(|a| a.color),
        smtp_username: String::new(),
        tls_insecure: false,
    };
    keyring::Entry::new("hey-look", &acc.id)
        .and_then(|e| e.set_password(&signed.refresh_token))
        .map_err(|e| format!("cannot store token: {e}"))?;
    oauth::cache_token(&acc.id, &signed.access_token, 3300);
    // verify the IMAP login works with the new token
    let (a2, tok) = (acc.clone(), signed.access_token.clone());
    blocking(move || {
        let mut s = mail::connect(&a2, &tok)?;
        let _ = s.logout();
        Ok(())
    })
    .await?;
    let c = lock(&state.db);
    if provider == Provider::Microsoft {
        // always kept: token refresh uses the same tenant, whether the client id came from the env or the form
        db::set_setting(&c, "microsoft_tenant", if tenant == "common" { "" } else { &tenant })?;
    }
    if from_env.is_none() {
        db::set_setting(&c, client_id_key(provider), client_id.trim())?;
        if !client_secret.trim().is_empty() {
            secret_set(client_secret_key(provider), client_secret.trim())?;
        }
    }
    db::insert_account(&c, &acc)?;
    Ok(acc)
}

/// Look up IMAP / SMTP settings for an address (presets, autoconfig, DNS SRV, MX, probing).
#[tauri::command]
async fn discover_server(email: String) -> R<Option<discover::Discovered>> {
    discover::run(&email).await
}

#[tauri::command]
fn update_account(state: tauri::State<AppState>, account_id: String, display_name: String, color: Option<String>) -> R<()> {
    lock(&state.db)
        .execute(
            "UPDATE accounts SET display_name=?1, color=?2 WHERE id=?3",
            params![display_name, color, account_id],
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn remove_account(state: tauri::State<AppState>, account_id: String) -> R<()> {
    db::remove_account(&lock(&state.db), &account_id)?;
    for name in [account_id.clone(), format!("{account_id}:smtp")] {
        if let Ok(e) = keyring::Entry::new("hey-look", &name) {
            let _ = e.delete_credential();
        }
    }
    Ok(())
}

// ---------- sync ----------

fn fmap(db: &Db, account_id: &str) -> HashMap<String, String> {
    db::get_setting(&lock(db), &format!("fmap:{account_id}"))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn insert_parsed(c: &Connection, acc: &Account, role: &str, p: &mail::Parsed) -> R<String> {
    let root = p
        .refs
        .first()
        .cloned()
        .or_else(|| p.message_id.clone())
        .unwrap_or_else(|| format!("{}:{}:{}", acc.id, role, p.uid));
    let thread_id = fnv(&format!("{}|{}", acc.id, root));
    c.execute(
        "INSERT OR REPLACE INTO messages(id,account_id,folder,uid,message_id,thread_id,subject,from_name,from_email,
           to_addrs,cc_addrs,date,snippet,body_html,body_text,seen,flagged,has_attach,attachments,list_unsub,list_unsub_post)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
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
            !p.attachments.is_empty() as i64,
            serde_json::to_string(&p.attachments).unwrap_or_else(|_| "[]".into()),
            p.list_unsub,
            p.list_unsub_post as i64
        ],
    )
    .map_err(err)?;
    Ok(thread_id)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NewMsg {
    thread_id: String,
    account_id: String,
    from: String,
    subject: String,
    snippet: String,
    bulk: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResult {
    added: u32,
    new_inbox: Vec<NewMsg>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Rule {
    id: String,
    /// None = applies to every account
    #[serde(default)]
    account_id: Option<String>,
    name: String,
    /// from | to | subject | any
    field: String,
    /// contains | equals
    op: String,
    value: String,
    /// archive | trash | junk | read | star | pin | move
    action: String,
    arg: Option<String>,
    enabled: bool,
}

fn rule_matches(r: &Rule, from: &str, to: &str, subject: &str) -> bool {
    let v = r.value.to_lowercase();
    let test = |s: &str| {
        let s = s.to_lowercase();
        if r.op == "equals" { s == v } else { s.contains(&v) }
    };
    match r.field.as_str() {
        "from" => test(from),
        "to" => test(to),
        "subject" => test(subject),
        _ => test(from) || test(to) || test(subject),
    }
}

fn load_rules(c: &Connection) -> Vec<Rule> {
    let Ok(mut st) = c.prepare("SELECT id,name,field,op,value,action,arg,enabled,account_id FROM rules WHERE enabled=1") else {
        return vec![];
    };
    st.query_map([], |r| {
        Ok(Rule {
            id: r.get(0)?,
            name: r.get(1)?,
            field: r.get(2)?,
            op: r.get(3)?,
            value: r.get(4)?,
            action: r.get(5)?,
            arg: r.get(6)?,
            enabled: r.get::<_, i64>(7)? != 0,
            account_id: r.get(8)?,
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

fn sync_impl(db: &Db, account_id: &str) -> R<SyncResult> {
    let acc = db::get_account(&lock(db), account_id)?;
    let sec = secret(db, &acc)?;
    let mut s = mail::connect(&acc, &sec)?;
    let map = mail::discover_folders(&mut s)?;
    db::set_setting(&lock(db), &format!("fmap:{account_id}"), &serde_json::to_string(&map).map_err(err)?)?;

    let mut roles: Vec<String> = mail::ROLES.iter().filter(|r| map.contains_key(**r)).map(|r| r.to_string()).collect();
    let mut custom: Vec<String> = map.keys().filter(|k| k.starts_with("f:")).cloned().collect();
    custom.sort();
    roles.extend(custom);

    let mut result = SyncResult { added: 0, new_inbox: vec![] };
    let mut to_rule: Vec<(String, String, String, String)> = vec![]; // thread, from, to, subject
    for role in roles {
        let Some(name) = map.get(&role) else { continue };
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
            let tid = insert_parsed(&c, &acc, &role, p)?;
            result.added += 1;
            if role == "inbox" && max_uid > 0 {
                if !p.seen {
                    result.new_inbox.push(NewMsg {
                        thread_id: tid.clone(),
                        account_id: acc.id.clone(),
                        snippet: p.snippet.chars().take(160).collect(),
                        from: if p.from_name.is_empty() { p.from_email.clone() } else { p.from_name.clone() },
                        subject: p.subject.clone(),
                        bulk: p.list_unsub.is_some(),
                    });
                }
                to_rule.push((tid, p.from_email.clone(), p.to.join(","), p.subject.clone()));
            }
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

    // apply filter rules to newly arrived inbox mail
    if !to_rule.is_empty() {
        let rules: Vec<Rule> = load_rules(&lock(db))
            .into_iter()
            .filter(|r| r.account_id.as_deref().map_or(true, |a| a == acc.id))
            .collect();
        let mut moved: std::collections::HashSet<String> = Default::default();
        for (tid, from, to, subject) in &to_rule {
            for r in &rules {
                if rule_matches(r, from, to, subject) {
                    let _ = action_impl(db, vec![tid.clone()], r.action.clone(), r.arg.clone(), Some("inbox".into()));
                    if matches!(r.action.as_str(), "archive" | "trash" | "junk" | "move") {
                        moved.insert(tid.clone());
                    }
                }
            }
        }
        result.new_inbox.retain(|n| !moved.contains(&n.thread_id));
    }
    Ok(result)
}

static SYNC_LOCK: Mutex<()> = Mutex::new(());

/// One sync pass for an account, then toasts + tray badge. Serialized so the UI and the background worker never overlap.
fn run_sync(app: &tauri::AppHandle, db: &Db, account_id: &str) -> R<SyncResult> {
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let r = sync_impl(db, account_id)?;
    shell::notify_new(app, db, &r.new_inbox);
    shell::update_badge(app, db);
    Ok(r)
}

/// Sync every account (tray "Check mail now" and the background worker).
pub(crate) fn sync_all(app: &tauri::AppHandle) {
    let db = app.state::<AppState>().db.clone();
    let ids: Vec<String> = db::list_accounts(&lock(&db))
        .map(|a| a.into_iter().map(|x| x.id).collect())
        .unwrap_or_default();
    let mut any = false;
    for id in ids {
        any |= run_sync(app, &db, &id).is_ok();
    }
    if any {
        let _ = app.emit("mail-synced", ());
    }
}

/// Runs for the whole app lifetime (also while the window is hidden in the tray).
fn sync_worker(app: tauri::AppHandle) {
    let mut last: HashMap<String, std::time::Instant> = HashMap::new();
    loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let db = app.state::<AppState>().db.clone();
        shell::check_snoozes(&app, &db);
        let p = shell::prefs(&db);
        let ids: Vec<String> = db::list_accounts(&lock(&db)).map(|a| a.into_iter().map(|x| x.id).collect()).unwrap_or_default();
        let mut any = false;
        for id in ids {
            // an account can override the "all accounts" interval
            let mins = shell::eff(&p, &id, "syncMinutes").and_then(|v| v.as_u64()).unwrap_or(2).max(1);
            let due = last.get(&id).map_or(true, |t| t.elapsed() >= std::time::Duration::from_secs(mins * 60));
            if due {
                last.insert(id.clone(), std::time::Instant::now());
                any |= run_sync(&app, &db, &id).is_ok();
            }
        }
        if any {
            let _ = app.emit("mail-synced", ());
        }
    }
}

// ---------- delayed actions (archive / delete / junk with Undo) ----------

struct Pending {
    id: String,
    threads: Vec<String>,
    action: String,
    arg: Option<String>,
    scope: Option<String>,
    due: std::time::Instant,
}

static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());

fn pending_lock() -> std::sync::MutexGuard<'static, Vec<Pending>> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner())
}

fn pending_thread_ids() -> std::collections::HashSet<String> {
    pending_lock().iter().flat_map(|p| p.threads.iter().cloned()).collect()
}

/// Hide the threads now and run the action on the server after `delay_secs`, unless it is cancelled.
#[tauri::command]
fn queue_action(thread_ids: Vec<String>, action: String, arg: Option<String>, scope: Option<String>, delay_secs: u64) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    pending_lock().push(Pending {
        id: id.clone(),
        threads: thread_ids,
        action,
        arg,
        scope,
        due: std::time::Instant::now() + std::time::Duration::from_secs(delay_secs),
    });
    id
}

#[tauri::command]
fn cancel_action(id: String) -> bool {
    let mut g = pending_lock();
    let before = g.len();
    g.retain(|p| p.id != id);
    g.len() != before
}

fn run_pending(app: &tauri::AppHandle, items: Vec<Pending>) {
    if items.is_empty() {
        return;
    }
    let db = app.state::<AppState>().db.clone();
    for p in items {
        if let Err(e) = action_impl(&db, p.threads, p.action, p.arg, p.scope) {
            let _ = app.emit("action-failed", e);
        }
    }
    shell::update_badge(app, &db);
    let _ = app.emit("mail-synced", ());
}

fn commit_due(app: &tauri::AppHandle) {
    let due: Vec<Pending> = {
        let mut g = pending_lock();
        let now = std::time::Instant::now();
        let (due, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut *g).into_iter().partition(|p| p.due <= now);
        *g = rest;
        due
    };
    run_pending(app, due);
}

/// Run everything still waiting (called before the app quits).
pub(crate) fn flush_pending(app: &tauri::AppHandle) {
    let all: Vec<Pending> = std::mem::take(&mut *pending_lock());
    run_pending(app, all);
}

fn pending_worker(app: tauri::AppHandle) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        commit_due(&app);
    }
}

// ---------- older mail / attachment data ----------

fn load_older_impl(db: &Db, account_id: &str, role: &str) -> R<u32> {
    let acc = db::get_account(&lock(db), account_id)?;
    let sec = secret(db, &acc)?;
    let map = fmap(db, account_id);
    let name = map.get(role).cloned().ok_or("folder unknown")?;
    let min_uid: u32 = lock(db)
        .query_row(
            "SELECT COALESCE(MIN(uid),0) FROM messages WHERE account_id=?1 AND folder=?2",
            params![account_id, role],
            |r| r.get(0),
        )
        .map_err(err)?;
    if min_uid <= 1 {
        return Ok(0);
    }
    let hi = min_uid - 1;
    let lo = hi.saturating_sub(300).max(1);
    let mut s = mail::connect(&acc, &sec)?;
    let found = mail::fetch_range(&mut s, &name, lo, hi)?;
    let _ = s.logout();
    let c = lock(db);
    c.execute_batch("BEGIN").map_err(err)?;
    for p in &found {
        insert_parsed(&c, &acc, role, p)?;
    }
    c.execute_batch("COMMIT").map_err(err)?;
    Ok(found.len() as u32)
}

/// Fetch the next page of older messages for a folder; returns how many were added (0 = nothing older).
#[tauri::command]
async fn load_older(state: tauri::State<'_, AppState>, account_id: String, role: String) -> R<u32> {
    let db = state.db.clone();
    blocking(move || load_older_impl(&db, &account_id, &role)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttData {
    name: String,
    mime: String,
    data_base64: String,
}

/// One attachment of a stored message as base64 (used to restore attachments when a draft is reopened).
#[tauri::command]
async fn attachment_data(state: tauri::State<'_, AppState>, message_id: String, index: usize) -> R<AttData> {
    let db = state.db.clone();
    blocking(move || {
        let (raw, att_json) = fetch_raw_for(&db, &message_id)?;
        let metas: Vec<mail::AttMeta> = serde_json::from_str(&att_json).unwrap_or_default();
        let (name, bytes) = mail::attachment_bytes(&raw, index)?;
        let mime = metas.iter().find(|m| m.index == index).map(|m| m.mime.clone()).unwrap_or_else(|| "application/octet-stream".into());
        Ok(AttData { name, mime, data_base64: base64::engine::general_purpose::STANDARD.encode(bytes) })
    })
    .await
}

#[tauri::command]
async fn sync_account(app: tauri::AppHandle, state: tauri::State<'_, AppState>, account_id: String) -> R<SyncResult> {
    let db = state.db.clone();
    blocking(move || run_sync(&app, &db, &account_id)).await
}

#[tauri::command]
fn refresh_badge(app: tauri::AppHandle, state: tauri::State<AppState>) {
    shell::update_badge(&app, &state.db);
}

#[tauri::command]
fn test_notification(app: tauri::AppHandle, state: tauri::State<AppState>) {
    shell::test_notification(&app, &state.db);
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> R<()> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled { m.enable() } else { m.disable() }.map_err(err)
}

// ---------- folders ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderInfo {
    account_id: String,
    key: String,
    name: String,
    unread: u32,
    total: u32,
}

#[tauri::command]
fn list_folders(state: tauri::State<AppState>) -> R<Vec<FolderInfo>> {
    let c = lock(&state.db);
    let accounts = db::list_accounts(&c)?;
    let mut counts: HashMap<(String, String), (u32, u32)> = HashMap::new();
    let p: serde_json::Value = db::get_setting(&c, "prefs")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    // unread numbers count conversations, and (with Focused Inbox on) leave bulk mail out of the inbox figure
    let include_other = p.get("countOtherMail").and_then(|v| v.as_bool()).unwrap_or(false)
        || !p.get("focused").and_then(|v| v.as_bool()).unwrap_or(true);
    let mut st = c
        .prepare(
            "SELECT account_id,folder,COUNT(DISTINCT thread_id),
                    COUNT(DISTINCT CASE WHEN seen=0 AND (folder!='inbox' OR ?1=1 OR list_unsub IS NULL) THEN thread_id END)
             FROM messages GROUP BY account_id,folder",
        )
        .map_err(err)?;
    let rows = st
        .query_map([include_other as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?, r.get::<_, Option<u32>>(3)?.unwrap_or(0)))
        })
        .map_err(err)?;
    for r in rows {
        let (a, f, t, u) = r.map_err(err)?;
        counts.insert((a, f), (t, u));
    }
    drop(st);
    let mut out = vec![];
    for a in accounts {
        let map: HashMap<String, String> = db::get_setting(&c, &format!("fmap:{}", a.id))
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut keys: Vec<String> = mail::ROLES.iter().map(|r| r.to_string()).collect();
        let mut custom: Vec<String> = map.keys().filter(|k| k.starts_with("f:")).cloned().collect();
        custom.sort();
        keys.extend(custom);
        for k in keys {
            let (total, unread) = counts.get(&(a.id.clone(), k.clone())).copied().unwrap_or((0, 0));
            out.push(FolderInfo {
                account_id: a.id.clone(),
                name: map.get(&k).cloned().unwrap_or_else(|| k.clone()),
                key: k,
                unread,
                total,
            });
        }
    }
    Ok(out)
}

// ---------- threads ----------

/// Structured search query: free words plus `from:` `to:` `subject:` `body:` `folder:` `is:` `has:` `after:` `before:`.
#[derive(Default)]
struct Query {
    words: Vec<String>,
    from: Vec<String>,
    to: Vec<String>,
    subject: Vec<String>,
    body: Vec<String>,
    has_attachment: bool,
    unread: Option<bool>,
    flagged: bool,
    pinned: bool,
    after: Option<i64>,
    before: Option<i64>,
    folder: Option<String>,
}

fn split_tokens(q: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted) = (vec![], String::new(), false);
    for ch in q.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `2026-01-31`, or `7d` / `30d` meaning "that many days ago".
fn parse_when(v: &str) -> Option<i64> {
    if let Some(n) = v.strip_suffix('d').and_then(|n| n.parse::<i64>().ok()) {
        return Some(now() - n * 86_400);
    }
    chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc().timestamp())
}

fn parse_query(q: &str) -> Query {
    let mut out = Query::default();
    for tok in split_tokens(q) {
        let lower = tok.to_lowercase();
        let Some((key, val)) = lower.split_once(':').filter(|(_, v)| !v.is_empty()) else {
            out.words.push(tok);
            continue;
        };
        let val = val.to_string();
        match key {
            "from" => out.from.push(val),
            "to" | "cc" => out.to.push(val),
            "subject" => out.subject.push(val),
            "body" => out.body.push(val),
            "has" | "hasattachment" | "hasattachments" => {
                if val.starts_with("att") || val == "yes" || val == "true" {
                    out.has_attachment = true
                } else {
                    out.words.push(tok)
                }
            }
            "is" => match val.as_str() {
                "unread" => out.unread = Some(true),
                "read" => out.unread = Some(false),
                "flagged" | "starred" => out.flagged = true,
                "pinned" => out.pinned = true,
                _ => out.words.push(tok),
            },
            "after" | "since" => out.after = parse_when(&val).or(out.after),
            "before" | "until" => out.before = parse_when(&val).or(out.before),
            "folder" | "in" => out.folder = Some(val),
            _ => out.words.push(tok),
        }
    }
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadFilter {
    account_id: Option<String>,
    /// inbox|sent|drafts|archive|trash|junk|f:<name>|starred|pinned|snoozed|unread|all
    folder: String,
    search: Option<String>,
    /// focused | other (inbox only)
    focus: Option<String>,
    #[serde(default)]
    flat: bool,
    #[serde(default)]
    unread_only: bool,
    #[serde(default)]
    flagged_only: bool,
    #[serde(default)]
    sort_asc: bool,
    /// search only: current (open folder) | account (every folder of the mailbox) | all (every account)
    scope: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSummary {
    thread_id: String,
    row_key: String,
    account_id: String,
    folder: String,
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
    bulk: bool,
}

#[tauri::command]
fn list_threads(state: tauri::State<AppState>, filter: ThreadFilter) -> R<Vec<ThreadSummary>> {
    let c = lock(&state.db);
    let t = now();
    let mut w: Vec<String> = vec![];
    let mut p: Vec<rusqlite::types::Value> = vec![];
    let query = filter.search.as_deref().filter(|q| !q.trim().is_empty()).map(parse_query);
    let scope = filter.scope.as_deref().unwrap_or("current");
    // a search can leave the open folder: whole mailbox, or every account
    let cross = query.is_some() && (scope == "account" || scope == "all");
    if let Some(a) = filter.account_id.as_ref().filter(|_| !(query.is_some() && scope == "all")) {
        w.push("m.account_id=?".into());
        p.push(a.clone().into());
    }
    let inboxish = (filter.folder == "inbox" || filter.folder == "unread") && !cross;
    let explicit_folder = query.as_ref().and_then(|q| q.folder.clone());
    if let Some(f) = &explicit_folder {
        let key = match f.as_str() {
            "sent" | "drafts" | "archive" | "trash" | "junk" | "inbox" => f.clone(),
            "spam" => "junk".to_string(),
            "deleted" | "bin" => "trash".to_string(),
            other => format!("f:{other}"),
        };
        w.push("(m.folder=? OR LOWER(m.folder)=?)".into());
        p.push(key.clone().into());
        p.push(key.to_lowercase().into());
    } else if cross {
        w.push("m.folder NOT IN ('trash','junk')".into());
    } else {
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
    }
    if inboxish {
        w.push("m.from_email NOT IN (SELECT email FROM blocked)".into());
        match filter.focus.as_deref() {
            Some("focused") => w.push("m.list_unsub IS NULL".into()),
            Some("other") => w.push("m.list_unsub IS NOT NULL".into()),
            _ => {}
        }
    }
    if filter.unread_only {
        w.push("m.seen=0".into());
    }
    if filter.flagged_only {
        w.push("m.flagged=1".into());
    }
    if let Some(q) = &query {
        if explicit_folder.is_none() && !cross {
            w.push("m.folder NOT IN ('trash','junk')".into());
        }
        let like = |v: &str| format!("%{}%", v.replace('%', "").replace('_', ""));
        for word in &q.words {
            w.push("(m.subject LIKE ? OR m.from_email LIKE ? OR m.from_name LIKE ? OR m.to_addrs LIKE ? OR m.snippet LIKE ? OR m.body_text LIKE ?)".into());
            for _ in 0..6 {
                p.push(like(word).into());
            }
        }
        for v in &q.from {
            w.push("(m.from_email LIKE ? OR m.from_name LIKE ?)".into());
            p.push(like(v).into());
            p.push(like(v).into());
        }
        for v in &q.to {
            w.push("(m.to_addrs LIKE ? OR m.cc_addrs LIKE ?)".into());
            p.push(like(v).into());
            p.push(like(v).into());
        }
        for v in &q.subject {
            w.push("m.subject LIKE ?".into());
            p.push(like(v).into());
        }
        for v in &q.body {
            w.push("(m.body_text LIKE ? OR m.snippet LIKE ?)".into());
            p.push(like(v).into());
            p.push(like(v).into());
        }
        if q.has_attachment {
            w.push("m.has_attach=1".into());
        }
        match q.unread {
            Some(true) => w.push("m.seen=0".into()),
            Some(false) => w.push("m.seen=1".into()),
            None => {}
        }
        if q.flagged {
            w.push("m.flagged=1".into());
        }
        if q.pinned {
            w.push("tm.pinned=1".into());
        }
        if let Some(a) = q.after {
            w.push("m.date>=?".into());
            p.push(a.into());
        }
        if let Some(b) = q.before {
            w.push("m.date<?".into());
            p.push(b.into());
        }
    }
    let sql = format!(
        "SELECT m.thread_id,m.id,m.account_id,m.folder,m.subject,m.from_name,m.from_email,m.snippet,m.date,m.seen,m.flagged,m.has_attach,
                COALESCE(tm.pinned,0), tm.snoozed_until, m.list_unsub IS NOT NULL
         FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id
         WHERE {} ORDER BY m.date {} LIMIT 4000",
        w.join(" AND "),
        if filter.sort_asc { "ASC" } else { "DESC" }
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
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)? != 0,
                r.get::<_, i64>(10)? != 0,
                r.get::<_, i64>(11)? != 0,
                r.get::<_, i64>(12)? != 0,
                r.get::<_, Option<i64>>(13)?,
                r.get::<_, i64>(14)? != 0,
            ))
        })
        .map_err(err)?;
    let mut order: Vec<String> = vec![];
    let mut map: HashMap<String, ThreadSummary> = HashMap::new();
    for row in rows {
        let (tid, mid, acct, folder, subject, fname, femail, snippet, date, seen, flagged, att, pinned, snooze, bulk) =
            row.map_err(err)?;
        let who = if fname.is_empty() { femail } else { fname };
        let key = if filter.flat { mid } else { tid.clone() };
        let e = map.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            ThreadSummary {
                thread_id: tid.clone(),
                row_key: key.clone(),
                account_id: acct,
                folder,
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
                bulk: false,
            }
        });
        e.count += 1;
        if !seen {
            e.unread += 1;
        }
        e.flagged |= flagged;
        e.has_attach |= att;
        e.bulk |= bulk;
        if e.participants.len() < 3 && !e.participants.contains(&who) {
            e.participants.push(who);
        }
    }
    let mut out: Vec<ThreadSummary> = order.into_iter().filter_map(|k| map.remove(&k)).collect();
    let waiting = pending_thread_ids();
    if !waiting.is_empty() {
        out.retain(|t| !waiting.contains(&t.thread_id));
    }
    if filter.folder == "inbox" && !filter.sort_asc {
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
    attachments: Vec<mail::AttMeta>,
    can_unsubscribe: bool,
}

#[tauri::command]
fn get_thread(state: tauri::State<AppState>, thread_id: String, scope: Option<String>) -> R<Vec<MessageFull>> {
    let c = lock(&state.db);
    let mut st = c
        .prepare(
            "SELECT id,account_id,folder,message_id,subject,from_name,from_email,to_addrs,cc_addrs,date,body_html,body_text,
                    seen,flagged,attachments,list_unsub
             FROM messages WHERE thread_id=?1 AND (folder NOT IN ('trash','junk') OR folder=?2) ORDER BY date ASC",
        )
        .map_err(err)?;
    let rows = st
        .query_map(params![thread_id, scope.unwrap_or_default()], |r| {
            let att: String = r.get(14)?;
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
                attachments: serde_json::from_str(&att).unwrap_or_default(),
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
            .query_map([t], |r| Ok(MsgRef { account_id: r.get(0)?, role: r.get(1)?, uid: r.get(2)?, id: r.get(3)? }))
            .map_err(err)?;
        for r in rows {
            out.push(r.map_err(err)?);
        }
    }
    Ok(out)
}

/// `scope`: the folder the user is acting from. Moves only touch messages in that folder
/// (or inbox/archive/custom folders when the view is virtual, never sent/drafts/trash/junk).
fn action_impl(db: &Db, thread_ids: Vec<String>, action: String, arg: Option<String>, scope: Option<String>) -> R<()> {
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
            {
                let c = lock(db);
                for t in &thread_ids {
                    c.execute(
                        "INSERT OR IGNORE INTO blocked(email) SELECT DISTINCT from_email FROM messages WHERE thread_id=?1 AND folder!='sent'",
                        [t],
                    )
                    .map_err(err)?;
                }
            }
            return action_impl(db, thread_ids, "junk".into(), None, scope);
        }
        _ => {}
    }

    let dst_role: Option<String> = match action.as_str() {
        "archive" | "trash" | "junk" | "inbox" => Some(action.clone()),
        "move" => Some(arg.clone().ok_or("move needs a destination folder")?),
        _ => None,
    };

    let msgs = thread_msgs(&lock(db), &thread_ids)?;
    let mut by_acct: HashMap<String, Vec<MsgRef>> = HashMap::new();
    for m in msgs {
        by_acct.entry(m.account_id.clone()).or_default().push(m);
    }
    for (acct_id, list) in by_acct {
        let acc = db::get_account(&lock(db), &acct_id)?;
        let sec = secret(db, &acc)?;
        let map = fmap(db, &acct_id);
        let mut s = mail::connect(&acc, &sec)?;
        let mut roles: Vec<String> = list.iter().map(|m| m.role.clone()).collect();
        roles.sort();
        roles.dedup();
        for role in roles {
            let group: Vec<&MsgRef> = list.iter().filter(|m| m.role == role).collect();
            let uids: Vec<u32> = group.iter().map(|m| m.uid).collect();
            let src = map.get(&role).cloned().ok_or("source folder unknown")?;
            let is_move = dst_role.is_some() || action == "delete_forever";
            if is_move {
                let allowed = match &scope {
                    Some(sc) => &role == sc,
                    None => !matches!(role.as_str(), "sent" | "drafts" | "trash" | "junk"),
                };
                if !allowed {
                    continue;
                }
            }
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
                "delete_forever" => {
                    mail::delete_forever(&mut s, &src, &uids)?;
                    let c = lock(db);
                    for m in &group {
                        c.execute("DELETE FROM messages WHERE id=?1", [&m.id]).map_err(err)?;
                    }
                }
                _ => {
                    let dst = dst_role.clone().ok_or_else(|| format!("unknown action: {action}"))?;
                    if dst == role {
                        continue;
                    }
                    if dst == "trash" && role == "trash" {
                        continue;
                    }
                    let real = map.get(&dst).cloned().ok_or_else(|| format!("no '{dst}' folder on this account"))?;
                    mail::move_to(&mut s, &src, &uids, &real)?;
                    let c = lock(db);
                    for m in &group {
                        c.execute("DELETE FROM messages WHERE id=?1", [&m.id]).map_err(err)?;
                    }
                }
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
    scope: Option<String>,
) -> R<()> {
    let db = state.db.clone();
    // permanently deleting from Trash
    let (action, scope) = if action == "trash" && scope.as_deref() == Some("trash") {
        ("delete_forever".to_string(), scope)
    } else {
        (action, scope)
    };
    blocking(move || action_impl(&db, thread_ids, action, arg, scope)).await
}

// ---------- senders (bulk cleaner) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SenderInfo {
    email: String,
    name: String,
    count: u32,
    unread: u32,
    can_unsubscribe: bool,
    last_date: i64,
}

#[tauri::command]
fn list_senders(state: tauri::State<AppState>, account_id: Option<String>) -> R<Vec<SenderInfo>> {
    let c = lock(&state.db);
    let mut st = c
        .prepare(
            "SELECT from_email, MAX(from_name), COUNT(*), SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END),
                    MAX(list_unsub IS NOT NULL), MAX(date)
             FROM messages WHERE folder='inbox' AND (?1 IS NULL OR account_id=?1) AND from_email!=''
             GROUP BY from_email ORDER BY COUNT(*) DESC LIMIT 300",
        )
        .map_err(err)?;
    let rows = st
        .query_map([account_id], |r| {
            Ok(SenderInfo {
                email: r.get(0)?,
                name: r.get(1)?,
                count: r.get(2)?,
                unread: r.get::<_, Option<u32>>(3)?.unwrap_or(0),
                can_unsubscribe: r.get::<_, i64>(4)? != 0,
                last_date: r.get(5)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

/// Archive / trash / junk / move / read all inbox mail from one sender.
#[tauri::command]
async fn sender_action(
    state: tauri::State<'_, AppState>,
    account_id: Option<String>,
    email: String,
    action: String,
    arg: Option<String>,
) -> R<u32> {
    let db = state.db.clone();
    blocking(move || {
        let ids: Vec<String> = {
            let c = lock(&db);
            let mut st = c
                .prepare(
                    "SELECT DISTINCT thread_id FROM messages WHERE folder='inbox' AND from_email=?1 AND (?2 IS NULL OR account_id=?2)",
                )
                .map_err(err)?;
            let rows = st
                .query_map(params![email, account_id], |r| r.get(0))
                .map_err(err)?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        let n = ids.len() as u32;
        action_impl(&db, ids, action, arg, Some("inbox".into()))?;
        Ok(n)
    })
    .await
}

#[tauri::command]
fn list_blocked(state: tauri::State<AppState>) -> R<Vec<String>> {
    let c = lock(&state.db);
    let mut st = c.prepare("SELECT email FROM blocked ORDER BY email").map_err(err)?;
    let rows = st
        .query_map([], |r| r.get(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

#[tauri::command]
fn unblock(state: tauri::State<AppState>, email: String) -> R<()> {
    lock(&state.db).execute("DELETE FROM blocked WHERE email=?1", [email]).map_err(err)?;
    Ok(())
}

// ---------- rules ----------

#[tauri::command]
fn list_rules(state: tauri::State<AppState>) -> R<Vec<Rule>> {
    let c = lock(&state.db);
    let mut st = c
        .prepare("SELECT id,name,field,op,value,action,arg,enabled,account_id FROM rules ORDER BY rowid")
        .map_err(err)?;
    let rows = st
        .query_map([], |r| {
            Ok(Rule {
                id: r.get(0)?,
                name: r.get(1)?,
                field: r.get(2)?,
                op: r.get(3)?,
                value: r.get(4)?,
                action: r.get(5)?,
                arg: r.get(6)?,
                enabled: r.get::<_, i64>(7)? != 0,
                account_id: r.get(8)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

#[tauri::command]
fn save_rule(state: tauri::State<AppState>, rule: Rule) -> R<()> {
    lock(&state.db)
        .execute(
            "INSERT OR REPLACE INTO rules(id,name,field,op,value,action,arg,enabled,account_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![rule.id, rule.name, rule.field, rule.op, rule.value, rule.action, rule.arg, rule.enabled as i64, rule.account_id],
        )
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn delete_rule(state: tauri::State<AppState>, id: String) -> R<()> {
    lock(&state.db).execute("DELETE FROM rules WHERE id=?1", [id]).map_err(err)?;
    Ok(())
}

// ---------- raw message / attachments ----------

fn fetch_raw_for(db: &Db, message_id: &str) -> R<(Vec<u8>, String)> {
    let (acct, role, uid, att): (String, String, u32, String) = lock(db)
        .query_row(
            "SELECT account_id,folder,uid,attachments FROM messages WHERE id=?1",
            [message_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(err)?;
    let acc = db::get_account(&lock(db), &acct)?;
    let sec = secret(db, &acc)?;
    let name = fmap(db, &acct).get(&role).cloned().ok_or("folder unknown")?;
    let mut s = mail::connect(&acc, &sec)?;
    let raw = mail::fetch_raw(&mut s, &name, uid)?;
    let _ = s.logout();
    Ok((raw, att))
}

#[tauri::command]
async fn get_raw(state: tauri::State<'_, AppState>, message_id: String) -> R<String> {
    let db = state.db.clone();
    let (raw, _) = blocking(move || fetch_raw_for(&db, &message_id)).await?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

/// Save one attachment (`index`) or all of them into the Downloads folder; returns the saved paths.
#[tauri::command]
async fn save_attachments(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    message_id: String,
    index: Option<usize>,
) -> R<Vec<String>> {
    let db = state.db.clone();
    let dir = app.path().download_dir().map_err(err)?;
    blocking(move || {
        let (raw, att_json) = fetch_raw_for(&db, &message_id)?;
        let metas: Vec<mail::AttMeta> = serde_json::from_str(&att_json).unwrap_or_default();
        let wanted: Vec<usize> = match index {
            Some(i) => vec![i],
            None => metas.iter().map(|m| m.index).collect(),
        };
        let mut saved = vec![];
        for i in wanted {
            let (name, bytes) = mail::attachment_bytes(&raw, i)?;
            let clean: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
            let mut path = dir.join(&clean);
            let mut n = 1;
            while path.exists() {
                let p = std::path::Path::new(&clean);
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
                let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
                path = dir.join(format!("{stem} ({n}){ext}"));
                n += 1;
            }
            std::fs::write(&path, bytes).map_err(err)?;
            saved.push(path.to_string_lossy().into_owned());
        }
        Ok(saved)
    })
    .await
}

// ---------- send / drafts / outbox ----------

fn send_now(db: &Db, d: &smtp::Draft) -> R<()> {
    let acc = db::get_account(&lock(db), &d.account_id)?;
    let sec = secret(db, &acc)?;
    let msg = smtp::build(&acc, d)?;
    smtp::send(&acc, &smtp_secret(db, &acc)?, &msg)?;
    let h = acc.smtp_host.to_lowercase();
    let auto_saves = h.contains("gmail") || h.contains("googlemail") || h.contains("office365") || h.contains("outlook");
    if !auto_saves {
        if let Some(sent) = fmap(db, &acc.id).get("sent").cloned() {
            if let Ok(mut s) = mail::connect(&acc, &sec) {
                let _ = mail::append(&mut s, &sent, &msg.formatted(), false);
                let _ = s.logout();
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, AppState>,
    draft: smtp::Draft,
    send_at: Option<i64>,
    replaces: Option<String>,
) -> R<String> {
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
    blocking(move || {
        send_now(&db, &draft)?;
        if let Some(t) = replaces {
            let _ = action_impl(&db, vec![t], "delete_forever".into(), None, Some("drafts".into()));
        }
        Ok(())
    })
    .await?;
    Ok("sent".into())
}

#[tauri::command]
async fn save_draft(state: tauri::State<'_, AppState>, draft: smtp::Draft, replaces: Option<String>) -> R<()> {
    let db = state.db.clone();
    blocking(move || {
        let acc = db::get_account(&lock(&db), &draft.account_id)?;
        let sec = secret(&db, &acc)?;
        let map = fmap(&db, &acc.id);
        let folder = map.get("drafts").cloned().ok_or("this account has no Drafts folder")?;
        let msg = smtp::build_draft(&acc, &draft)?;
        let mut s = mail::connect(&acc, &sec)?;
        mail::append(&mut s, &folder, &msg.formatted(), true)?;
        let _ = s.logout();
        if let Some(t) = replaces {
            let _ = action_impl(&db, vec![t], "delete_forever".into(), None, Some("drafts".into()));
        }
        Ok(())
    })
    .await
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
#[serde(rename_all = "camelCase")]
struct Template {
    id: String,
    #[serde(default)]
    account_id: Option<String>,
    name: String,
    subject: String,
    body: String,
}

#[tauri::command]
fn list_templates(state: tauri::State<AppState>) -> R<Vec<Template>> {
    let c = lock(&state.db);
    let mut st = c.prepare("SELECT id,name,subject,body,account_id FROM templates ORDER BY name").map_err(err)?;
    let rows = st
        .query_map([], |r| Ok(Template { id: r.get(0)?, name: r.get(1)?, subject: r.get(2)?, body: r.get(3)?, account_id: r.get(4)? }))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows)
}

#[tauri::command]
fn save_template(state: tauri::State<AppState>, template: Template) -> R<()> {
    lock(&state.db)
        .execute(
            "INSERT OR REPLACE INTO templates(id,name,subject,body,account_id) VALUES(?1,?2,?3,?4,?5)",
            params![template.id, template.name, template.subject, template.body, template.account_id],
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
    #[serde(default)]
    account_id: Option<String>,
    name: String,
    html: String,
    is_default: bool,
}

#[tauri::command]
fn list_signatures(state: tauri::State<AppState>) -> R<Vec<Signature>> {
    let c = lock(&state.db);
    let mut st = c.prepare("SELECT id,name,html,is_default,account_id FROM signatures ORDER BY name").map_err(err)?;
    let rows = st
        .query_map([], |r| {
            Ok(Signature { id: r.get(0)?, name: r.get(1)?, html: r.get(2)?, is_default: r.get::<_, i64>(3)? != 0, account_id: r.get(4)? })
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
        // one default per scope (all accounts, or a single account)
        c.execute(
            "UPDATE signatures SET is_default=0 WHERE COALESCE(account_id,'')=COALESCE(?1,'')",
            params![signature.account_id],
        )
        .map_err(err)?;
    }
    c.execute(
        "INSERT OR REPLACE INTO signatures(id,name,html,is_default,account_id) VALUES(?1,?2,?3,?4,?5)",
        params![signature.id, signature.name, signature.html, signature.is_default as i64, signature.account_id],
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
    if SECRET_NAMES.contains(&key.as_str()) {
        return None; // secrets are never sent to the UI
    }
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
    let needle = prefix.trim().to_lowercase();
    let like = format!("%{}%", needle);
    let mut score: HashMap<String, (String, u32)> = HashMap::new(); // email -> (name, weight)

    // people who wrote to you
    let mut st = c
        .prepare(
            "SELECT MAX(from_name), from_email, COUNT(*) FROM messages
             WHERE from_email!='' AND (from_email LIKE ?1 OR from_name LIKE ?1)
             GROUP BY from_email ORDER BY COUNT(*) DESC LIMIT 40",
        )
        .map_err(err)?;
    let rows = st
        .query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?)))
        .map_err(err)?;
    for r in rows.flatten() {
        let e = score.entry(r.1.to_lowercase()).or_insert((r.0.clone(), 0));
        e.1 += r.2;
        if e.0.is_empty() {
            e.0 = r.0;
        }
    }
    drop(st);

    // people you wrote to (recipients of sent mail weigh more: you chose them)
    let mut st = c
        .prepare("SELECT to_addrs, cc_addrs FROM messages WHERE folder='sent' AND (to_addrs LIKE ?1 OR cc_addrs LIKE ?1) ORDER BY date DESC LIMIT 300")
        .map_err(err)?;
    let rows = st.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
    for (to, cc) in rows.flatten() {
        for addr in to.split(',').chain(cc.split(',')) {
            let a = addr.trim().to_lowercase();
            if !a.is_empty() && a.contains(&needle) {
                score.entry(a).or_insert((String::new(), 0)).1 += 3;
            }
        }
    }
    drop(st);

    let mut out: Vec<(String, String, u32)> = score.into_iter().map(|(email, (name, n))| (email, name, n)).collect();
    out.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    Ok(out.into_iter().take(8).map(|(email, name, _)| Contact { name, email }).collect())
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

/// Download remote images in the backend and hand them to the UI as data: URIs. The webview never
/// contacts the sender's servers itself (no Referer, and WebView2 tracking prevention cannot block them).
#[tauri::command]
async fn fetch_remote_images(urls: Vec<String>) -> R<HashMap<String, String>> {
    const MAX_BYTES: usize = 6_000_000;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
        .build()
        .map_err(err)?;
    let mut handles = vec![];
    for u in urls.into_iter().filter(|u| u.starts_with("http://") || u.starts_with("https://")).take(60) {
        let c = client.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let r = c.get(&u).send().await.ok()?;
            if !r.status().is_success() {
                return None;
            }
            let ct = r
                .headers()
                .get(reqwest::header::CONTENT_TYPE)?
                .to_str()
                .ok()?
                .split(';')
                .next()?
                .trim()
                .to_lowercase();
            if !ct.starts_with("image/") || r.content_length().map_or(false, |l| l as usize > MAX_BYTES) {
                return None;
            }
            let bytes = r.bytes().await.ok()?;
            if bytes.len() > MAX_BYTES {
                return None;
            }
            Some((u, format!("data:{ct};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))))
        }));
    }
    let mut out = HashMap::new();
    for h in handles {
        if let Ok(Some((u, d))) = h.await {
            out.insert(u, d);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn ai_complete(state: tauri::State<'_, AppState>, system: String, prompt: String) -> R<String> {
    let (ep, key, model) = {
        let c = lock(&state.db);
        (
            db::get_setting(&c, "ai_endpoint").unwrap_or_default(),
            secret_get("ai_key").unwrap_or_default(),
            db::get_setting(&c, "ai_model").unwrap_or_default(),
        )
    };
    ai::complete(&ep, &key, &model, &system, &prompt).await
}

#[tauri::command]
async fn ai_list_models(endpoint: String, key: Option<String>) -> R<Vec<String>> {
    // a key typed in Settings but not saved yet wins over the saved one
    let key = key.filter(|k| !k.trim().is_empty()).unwrap_or_else(|| secret_get("ai_key").unwrap_or_default());
    ai::list_models(&endpoint, key.trim()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // a second launch just brings the running instance forward
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("heylook.db"))?;
            let db: Db = Arc::new(Mutex::new(conn));
            let worker_db = db.clone();
            std::thread::spawn(move || outbox_worker(worker_db));
            app.manage(AppState { db: db.clone() });
            migrate_secrets(&db);
            let pending_app = app.handle().clone();
            std::thread::spawn(move || pending_worker(pending_app));

            shell::register_aumid(app.handle());
            shell::setup_tray(app.handle(), &db)?;
            shell::update_badge(app.handle(), &db);
            let handle = app.handle().clone();
            std::thread::spawn(move || sync_worker(handle));

            // started by "launch at login" => stay in the tray
            if !std::env::args().any(|a| a == "--minimized") {
                shell::show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let db = window.app_handle().state::<AppState>().db.clone();
                if shell::close_to_tray(&db) {
                    api.prevent_close();
                    let _ = window.hide();
                    shell::tray_hint_once(window.app_handle(), &db);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_accounts,
            add_account,
            google_sign_in,
            google_env_configured,
            microsoft_sign_in,
            microsoft_env_configured,
            microsoft_tenant,
            discover_server,
            update_account,
            remove_account,
            sync_account,
            refresh_badge,
            test_notification,
            get_autostart,
            set_autostart,
            list_folders,
            list_threads,
            get_thread,
            thread_action,
            list_senders,
            sender_action,
            list_blocked,
            unblock,
            list_rules,
            save_rule,
            delete_rule,
            get_raw,
            save_attachments,
            send_message,
            save_draft,
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
            fetch_remote_images,
            queue_action,
            cancel_action,
            load_older,
            attachment_data,
            set_secret,
            has_secret,
            ai_complete,
            ai_list_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
