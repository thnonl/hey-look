mod ai;
mod attach;
mod calendar;
mod db;
mod discover;
mod ical;
mod mail;
mod oauth;
mod oauth_page;
mod openpgp;
mod pgpmail;
mod pgpstore;
use oauth::Provider;
mod schedule;
mod shell;
mod smtp;
mod winframe;

use base64::Engine;
use db::{err, Account, R};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
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
    // the color is chosen and stored here, so every window shows the same one from the first moment
    let c = lock(&state.db);
    let mut acc = acc;
    acc.color = Some(db::pick_account_color(db::list_accounts(&c)?.iter().map(|a| a.color.as_deref())));
    db::insert_account(&c, &acc)?;
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
        color: existing.as_ref().and_then(|a| a.color.clone()),
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
    let mut acc = acc;
    if acc.color.is_none() {
        acc.color = Some(db::pick_account_color(db::list_accounts(&c)?.iter().map(|a| a.color.as_deref())));
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
           to_addrs,cc_addrs,date,snippet,body_html,body_text,seen,flagged,has_attach,attachments,list_unsub,list_unsub_post,pgp,pgp_raw,ics,cal_method)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
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
            // pictures shown in the body are not "attachments" for the list's paperclip
            p.attachments.iter().any(|a| !(a.inline && a.referenced)) as i64,
            serde_json::to_string(&p.attachments).unwrap_or_else(|_| "[]".into()),
            p.list_unsub,
            p.list_unsub_post as i64,
            p.pgp as i64,
            p.pgp_raw,
            p.ics,
            p.cal_method
        ],
    )
    .map_err(err)?;
    // invitations, updates, cancellations and replies reach the calendar as they arrive
    if let Some(ics) = &p.ics {
        if !matches!(role, "sent" | "drafts" | "trash" | "junk") {
            let id = format!("{}:{}:{}", acc.id, role, p.uid);
            if calendar::ingest(c, acc, &id, &p.from_email, ics, false).map(|o| o.changed).unwrap_or(false) {
                calendar::mark_dirty();
            }
        }
    }
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
    if calendar::take_dirty() {
        let _ = app.emit("calendar-changed", serde_json::json!({}));
    }
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
        let (raw, att_json) = fetch_view_for(&db, &message_id)?;
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
        // checked: an absurd "99999999999999d" must not overflow (it just means "not a usable date")
        return n.checked_mul(86_400).and_then(|secs| now().checked_sub(secs));
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
    encrypted: bool,
    signed: bool,
    /// request | reply | cancel when a message of the conversation carries a calendar invitation
    invite: Option<String>,
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
                COALESCE(tm.pinned,0), tm.snoozed_until, m.list_unsub IS NOT NULL, m.pgp, m.cal_method
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
                r.get::<_, i64>(15)?,
                r.get::<_, Option<String>>(16)?,
            ))
        })
        .map_err(err)?;
    let mut order: Vec<String> = vec![];
    let mut map: HashMap<String, ThreadSummary> = HashMap::new();
    for row in rows {
        let (tid, mid, acct, folder, subject, fname, femail, snippet, date, seen, flagged, att, pinned, snooze, bulk, pgp, cal) =
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
                encrypted: false,
                signed: false,
                invite: None,
            }
        });
        e.count += 1;
        if !seen {
            e.unread += 1;
        }
        e.flagged |= flagged;
        e.has_attach |= att;
        e.bulk |= bulk;
        e.encrypted |= pgp & 1 != 0;
        e.signed |= pgp & 2 != 0;
        if e.invite.is_none() {
            e.invite = cal.filter(|m| matches!(m.as_str(), "request" | "reply" | "cancel"));
        }
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
pub(crate) struct MessageFull {
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
    /// PGP state (encryption, signature); `None` for ordinary mail
    security: Option<pgpmail::Security>,
    /// the iCalendar text of an invitation (not sent to the UI)
    #[serde(skip)]
    ics: Option<String>,
    /// calendar invitation / update / cancellation / reply carried by this message
    invite: Option<calendar::CalInvite>,
}

const MESSAGE_COLS: &str = "id,account_id,folder,message_id,subject,from_name,from_email,to_addrs,cc_addrs,date,body_html,body_text,
                    seen,flagged,attachments,list_unsub,pgp,pgp_raw,ics";

fn row_message(r: &rusqlite::Row) -> rusqlite::Result<(MessageFull, i64, Option<Vec<u8>>)> {
    let att: String = r.get(14)?;
    Ok((
        MessageFull {
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
            security: None,
            ics: r.get(18)?,
            invite: None,
        },
        r.get(16)?,
        r.get(17)?,
    ))
}

/// Decrypt / verify a PGP message for display, then read its calendar invitation (also from decrypted content).
fn finish_message(c: &Connection, m: &mut MessageFull, pgp: i64, raw: Option<Vec<u8>>) {
    apply_pgp(c, m, pgp, raw);
    if let Some(ics) = m.ics.clone() {
        m.invite = Some(calendar::invite_for(c, &m.account_id, &m.id, &m.folder, &m.from_email, &ics, pgp & pgpmail::FLAG_ENCRYPTED as i64 != 0));
    }
}

/// Decrypt / verify a PGP message for display. The decrypted content only lives in the returned value (and the
/// in-memory session cache); it is never written to the database.
fn apply_pgp(c: &Connection, m: &mut MessageFull, pgp: i64, raw: Option<Vec<u8>>) {
    if pgp == 0 {
        return;
    }
    let encrypted = pgp & pgpmail::FLAG_ENCRYPTED as i64 != 0;
    let Some(raw) = raw else {
        if encrypted {
            m.security = Some(pgpmail::Security {
                encrypted: true,
                decryption: "error".into(),
                error: Some("the message data is not on this computer".into()),
                ..Default::default()
            });
        }
        return;
    };
    match pgpstore::open_message(c, &m.id, &raw) {
        Ok(o) => {
            m.security = Some(o.security.clone());
            if let Some(plain) = &o.plain {
                if let Some(p) = mail::parse(0, plain, true, false, 0) {
                    m.html = p.html;
                    m.text = p.text;
                    m.attachments = p.attachments;
                    m.ics = p.ics;
                }
            }
        }
        Err(e) => {
            m.security = Some(pgpmail::Security { encrypted, decryption: "error".into(), error: Some(e), ..Default::default() });
        }
    }
}

pub(crate) fn message_full(c: &Connection, message_id: &str) -> R<MessageFull> {
    let (mut m, pgp, raw) = c
        .query_row(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE id=?1"), [message_id], row_message)
        .map_err(|_| "message not found".to_string())?;
    finish_message(c, &mut m, pgp, raw);
    Ok(m)
}

#[tauri::command]
fn get_thread(state: tauri::State<AppState>, thread_id: String, scope: Option<String>) -> R<Vec<MessageFull>> {
    let c = lock(&state.db);
    let mut st = c
        .prepare(&format!(
            "SELECT {MESSAGE_COLS} FROM messages WHERE thread_id=?1 AND (folder NOT IN ('trash','junk') OR folder=?2) ORDER BY date ASC"
        ))
        .map_err(err)?;
    let rows = st
        .query_map(params![thread_id, scope.unwrap_or_default()], row_message)
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|(mut m, pgp, raw)| {
            finish_message(&c, &mut m, pgp, raw);
            m
        })
        .collect())
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

/// The message exactly as stored on the server (for PGP mail: the encrypted form), plus its attachment list.
fn fetch_raw_for(db: &Db, message_id: &str) -> R<(Vec<u8>, String)> {
    let (acct, role, uid, att, kept): (String, String, u32, String, Option<Vec<u8>>) = lock(db)
        .query_row(
            "SELECT account_id,folder,uid,attachments,pgp_raw FROM messages WHERE id=?1",
            [message_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(err)?;
    if let Some(raw) = kept {
        return Ok((raw, att));
    }
    let acc = db::get_account(&lock(db), &acct)?;
    let sec = secret(db, &acc)?;
    let name = fmap(db, &acct).get(&role).cloned().ok_or("folder unknown")?;
    let mut s = mail::connect(&acc, &sec)?;
    let raw = mail::fetch_raw(&mut s, &name, uid)?;
    let _ = s.logout();
    Ok((raw, att))
}

/// The message as it is read: encrypted PGP mail is decrypted (in memory), so attachment indexes and the
/// attachment list match what get_thread shows. Fails with `PGP_LOCKED:<fingerprint>` while the key is locked.
pub(crate) fn fetch_view_for(db: &Db, message_id: &str) -> R<(Vec<u8>, String)> {
    let (raw, att) = fetch_raw_for(db, message_id)?;
    let pgp: i64 = lock(db).query_row("SELECT pgp FROM messages WHERE id=?1", [message_id], |r| r.get(0)).unwrap_or(0);
    if pgp & pgpmail::FLAG_ENCRYPTED as i64 == 0 {
        return Ok((raw, att));
    }
    let opened = pgpstore::open_message(&lock(db), message_id, &raw)?;
    match &opened.plain {
        Some(plain) => {
            let metas = mail::parse(0, plain, true, false, 0).map(|p| p.attachments).unwrap_or_default();
            Ok((plain.clone(), serde_json::to_string(&metas).unwrap_or_else(|_| "[]".into())))
        }
        None => match &opened.security.locked_key {
            Some(f) => Err(format!("PGP_LOCKED:{f}")),
            None => Err(format!("PGP_FAILED: {}", opened.security.error.clone().unwrap_or_else(|| "this message can't be decrypted".into()))),
        },
    }
}

#[tauri::command]
async fn get_raw(state: tauri::State<'_, AppState>, message_id: String) -> R<String> {
    let db = state.db.clone();
    let (raw, _) = blocking(move || fetch_raw_for(&db, &message_id)).await?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

/// Folder for "Save" (Settings → Attachments), falling back to the system Downloads folder.
fn download_folder(app: &tauri::AppHandle, db: &Db) -> R<std::path::PathBuf> {
    match setting(db, "download_dir").filter(|s| !s.trim().is_empty()) {
        Some(p) if std::path::Path::new(&p).is_dir() => Ok(p.into()),
        _ => app.path().download_dir().map_err(err),
    }
}

fn setting(db: &Db, key: &str) -> Option<String> {
    db::get_setting(&lock(db), key)
}

/// Write `bytes` into `dir` under a safe, unused name; returns the path written.
fn write_unique(dir: &std::path::Path, name: &str, bytes: &[u8]) -> R<std::path::PathBuf> {
    let path = attach::unique_path(dir, &attach::clean_name(name), |p| p.exists());
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path)
}

/// Save one attachment (`index`) or all of them into the download folder; returns the saved paths.
#[tauri::command]
async fn save_attachments(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    message_id: String,
    index: Option<usize>,
) -> R<Vec<String>> {
    let db = state.db.clone();
    blocking(move || {
        let dir = download_folder(&app, &db)?;
        let (raw, att_json) = fetch_view_for(&db, &message_id)?;
        let metas: Vec<mail::AttMeta> = serde_json::from_str(&att_json).unwrap_or_default();
        let wanted: Vec<usize> = match index {
            Some(i) => vec![i],
            None => metas.iter().map(|m| m.index).collect(),
        };
        let mut saved = vec![];
        for i in wanted {
            let (name, bytes) = mail::attachment_bytes(&raw, i)?;
            saved.push(write_unique(&dir, &name, &bytes)?.to_string_lossy().into_owned());
        }
        Ok(saved)
    })
    .await
}

/// Native "Save as" dialog for one attachment. `None` when the user cancels.
#[tauri::command]
async fn attachment_save_as(app: tauri::AppHandle, state: tauri::State<'_, AppState>, message_id: String, index: usize) -> R<Option<String>> {
    let db = state.db.clone();
    blocking(move || {
        let dir = download_folder(&app, &db)?;
        let (raw, _) = fetch_view_for(&db, &message_id)?;
        let (name, bytes) = mail::attachment_bytes(&raw, index)?;
        let Some(picked) = app.dialog().file().set_file_name(attach::clean_name(&name)).set_directory(&dir).blocking_save_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(err)?;
        std::fs::write(&path, bytes).map_err(err)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveAllFailure {
    index: usize,
    name: String,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveAllResult {
    dir: String,
    saved: Vec<String>,
    failed: Vec<SaveAllFailure>,
}

/// Save every attachment (pictures included) into one folder. `ask` shows a folder picker first; `None` = cancelled.
/// Failures do not stop the others. Emits `attachment-progress` after each file.
#[tauri::command]
async fn attachment_save_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    message_id: String,
    ask: bool,
    job_id: Option<String>,
) -> R<Option<SaveAllResult>> {
    let db = state.db.clone();
    blocking(move || {
        let (raw, att_json) = fetch_view_for(&db, &message_id)?;
        let metas: Vec<mail::AttMeta> = serde_json::from_str(&att_json).unwrap_or_default();
        let dir = if ask {
            let Some(p) = app.dialog().file().set_title("Save attachments to").blocking_pick_folder() else {
                return Ok(None);
            };
            p.into_path().map_err(err)?
        } else {
            download_folder(&app, &db)?
        };
        let total = metas.len();
        let (mut saved, mut failed) = (vec![], vec![]);
        for (n, m) in metas.iter().enumerate() {
            match mail::attachment_bytes(&raw, m.index).and_then(|(name, bytes)| write_unique(&dir, &name, &bytes)) {
                Ok(p) => saved.push(p.to_string_lossy().into_owned()),
                Err(e) => failed.push(SaveAllFailure { index: m.index, name: m.name.clone(), error: e }),
            }
            let _ = app.emit(
                "attachment-progress",
                serde_json::json!({ "jobId": job_id, "messageId": message_id, "index": m.index, "phase": "write", "received": n + 1, "total": total, "done": n + 1 == total }),
            );
        }
        Ok(Some(SaveAllResult { dir: dir.to_string_lossy().into_owned(), saved, failed }))
    })
    .await
}

/// Write an attachment to the temp folder and open it with the default app. Programs and scripts need
/// `confirmed = true`; otherwise the error starts with `ATT_RISKY` (unless the user turned the warning off).
#[tauri::command]
async fn attachment_open(app: tauri::AppHandle, state: tauri::State<'_, AppState>, message_id: String, index: usize, confirmed: bool) -> R<String> {
    let db = state.db.clone();
    blocking(move || {
        let (raw, _) = fetch_view_for(&db, &message_id)?;
        let (name, bytes) = mail::attachment_bytes(&raw, index)?;
        let warn = setting(&db, "warn_executables").map(|v| v != "0").unwrap_or(true);
        // the file that is opened is the cleaned name, so that is the name the risk check must look at
        let stored = attach::clean_name(&name);
        if warn && !confirmed && (attach::is_risky(&name) || attach::is_risky(&stored)) {
            return Err(format!("ATT_RISKY: {stored} can run programs on your computer."));
        }
        let dir = std::env::temp_dir().join("HeyLook").join(attach::safe_id(&message_id));
        std::fs::create_dir_all(&dir).map_err(err)?;
        let path = dir.join(&stored);
        std::fs::write(&path, bytes).map_err(err)?;
        let shown = path.to_string_lossy().into_owned();
        app.opener().open_path(shown.clone(), None::<&str>).map_err(err)?;
        Ok(shown)
    })
    .await
}

/// Show a saved file selected in Explorer / Finder.
#[tauri::command]
fn attachment_reveal(app: tauri::AppHandle, path: String) -> R<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() || !p.exists() {
        return Err("That file no longer exists.".into());
    }
    app.opener().reveal_item_in_dir(p).map_err(err)
}

/// Native folder picker (used for "Save to" in Settings).
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, title: Option<String>) -> R<Option<String>> {
    blocking(move || {
        let mut dlg = app.dialog().file();
        if let Some(t) = title {
            dlg = dlg.set_title(t);
        }
        match dlg.blocking_pick_folder() {
            Some(p) => Ok(Some(p.into_path().map_err(err)?.to_string_lossy().into_owned())),
            None => Ok(None),
        }
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InlineData {
    mime: String,
    data_base64: String,
    name: String,
}

/// One picture of a stored message by Content-ID, fetched from the server (for pictures that were not embedded
/// at sync time).
#[tauri::command]
async fn inline_image(state: tauri::State<'_, AppState>, message_id: String, cid: String) -> R<InlineData> {
    let db = state.db.clone();
    blocking(move || {
        let (raw, _) = fetch_view_for(&db, &message_id)?;
        let (mime, bytes, name) = mail::inline_part(&raw, &cid)?;
        Ok(InlineData { mime, data_base64: base64::engine::general_purpose::STANDARD.encode(bytes), name })
    })
    .await
}

// ---------- send / drafts / outbox ----------

fn send_now(db: &Db, d: &smtp::Draft) -> R<()> {
    let acc = db::get_account(&lock(db), &d.account_id)?;
    let sec = secret(db, &acc)?;
    let (raw, env) = finished_message(db, &acc, d)?;
    smtp::send_raw(&acc, &smtp_secret(db, &acc)?, &env, &raw)?;
    let h = acc.smtp_host.to_lowercase();
    let auto_saves = h.contains("gmail") || h.contains("googlemail") || h.contains("office365") || h.contains("outlook");
    if !auto_saves {
        if let Some(sent) = fmap(db, &acc.id).get("sent").cloned() {
            if let Ok(mut s) = mail::connect(&acc, &sec) {
                let _ = mail::append(&mut s, &sent, &raw, false);
                let _ = s.logout();
            }
        }
    }
    Ok(())
}

/// The bytes to send and their envelope. Encrypted or signed messages (PGP/MIME) are built here, or were built
/// when they were scheduled (`prebuilt`), so they are never sent in the clear by accident.
fn finished_message(db: &Db, acc: &Account, d: &smtp::Draft) -> R<(Vec<u8>, lettre::address::Envelope)> {
    if let Some(pre) = &d.prebuilt {
        let raw = base64::engine::general_purpose::STANDARD.decode(pre).map_err(err)?;
        return Ok((raw, smtp::envelope(acc, d)?));
    }
    let sec = d.security.clone().unwrap_or_default();
    let msg = if sec.encrypt || sec.sign { pgpstore::build_secure(&lock(db), acc, d, false)? } else { smtp::build(acc, d)? };
    Ok((msg.formatted(), msg.envelope().clone()))
}

/// What goes into the Drafts folder: encrypted to the account's own key when the draft is encrypted.
fn draft_bytes(db: &Db, acc: &Account, d: &smtp::Draft) -> R<Vec<u8>> {
    let sec = d.security.clone().unwrap_or_default();
    if sec.encrypt {
        if let Some(pre) = &d.prebuilt {
            return base64::engine::general_purpose::STANDARD.decode(pre).map_err(err);
        }
        return Ok(pgpstore::build_secure(&lock(db), acc, d, true)?.formatted());
    }
    Ok(smtp::build_draft(acc, d)?.formatted())
}

/// Queue a finished message (MIME is built at send time from the stored draft) for `send_at`.
fn insert_outbox(db: &Db, draft: &smtp::Draft, send_at: i64) -> R<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::to_string(draft).map_err(err)?;
    lock(db)
        .execute(
            "INSERT INTO outbox(id,account_id,payload,send_at,status,created_at) VALUES(?1,?2,?3,?4,'pending',?5)",
            params![id, draft.account_id, payload, send_at, now()],
        )
        .map_err(err)?;
    Ok(id)
}

/// Remove the original draft after a message was sent or scheduled from it (so it is not duplicated).
fn drop_replaced_draft(db: &Db, replaces: Option<String>) {
    if let Some(t) = replaces {
        let _ = action_impl(db, vec![t], "delete_forever".into(), None, Some("drafts".into()));
    }
}

#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    draft: smtp::Draft,
    send_at: Option<i64>,
    replaces: Option<String>,
) -> R<String> {
    let db = state.db.clone();
    let t = now();
    if let Some(at) = send_at {
        schedule::validate_send_at(at, t)?;
    }
    // a meeting made in Compose: create the event and the calendar part now (also when it is scheduled)
    let mut draft = draft;
    if draft.meeting.is_some() {
        calendar::prepare_meeting(&lock(&db), &mut draft)?;
        let _ = app.emit("calendar-changed", serde_json::json!({}));
    }
    if schedule::should_queue(send_at, t) {
        let at = send_at.unwrap_or(t);
        let id = blocking(move || {
            // encrypt / sign now (decision: the key is only needed at schedule time) and keep just the result
            let acc = db::get_account(&lock(&db), &draft.account_id)?;
            let draft = pgpstore::seal_for_outbox(&lock(&db), &acc, &draft)?;
            let id = insert_outbox(&db, &draft, at)?;
            drop_replaced_draft(&db, replaces);
            Ok(id)
        })
        .await?;
        let _ = app.emit("outbox-changed", serde_json::json!({ "id": id, "status": "pending" }));
        return Ok(format!("scheduled:{id}"));
    }
    blocking(move || {
        if let Err(e) = send_now(&db, &draft) {
            // the invitation never went out: do not leave its event behind (Compose reopens and can send again)
            if draft.meeting.is_some() {
                if let Ok(p) = serde_json::to_string(&draft) {
                    calendar::forget_prepared(&lock(&db), &p);
                }
            }
            return Err(e);
        }
        drop_replaced_draft(&db, replaces);
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
        let raw = draft_bytes(&db, &acc, &draft)?;
        let mut s = mail::connect(&acc, &sec)?;
        mail::append(&mut s, &folder, &raw, true)?;
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
    cc: Vec<String>,
    snippet: String,
    has_attachments: bool,
    send_at: i64,
    created_at: i64,
    /// pending | held | sending | failed | overdue (sent rows are deleted)
    status: String,
    error: Option<String>,
    attempts: i64,
}

/// Plain-text preview of a stored draft for the Scheduled list.
fn snippet_of(d: &smtp::Draft) -> String {
    let text = if d.text.trim().is_empty() { strip_tags(&d.html) } else { d.text.clone() };
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
}

fn strip_tags(h: &str) -> String {
    let mut out = String::new();
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

#[tauri::command]
fn list_outbox(state: tauri::State<AppState>) -> R<Vec<OutboxItem>> {
    let c = lock(&state.db);
    let mut st = c
        .prepare("SELECT id,account_id,payload,send_at,status,error,created_at,attempts FROM outbox WHERE status!='sent' ORDER BY send_at")
        .map_err(err)?;
    let rows = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
            ))
        })
        .map_err(err)?;
    let mut out = vec![];
    for r in rows {
        let (id, account_id, payload, send_at, status, error, created_at, attempts) = r.map_err(err)?;
        // a row that cannot be parsed is skipped rather than hiding the whole list
        let Ok(d) = serde_json::from_str::<smtp::Draft>(&payload) else { continue };
        out.push(OutboxItem {
            id,
            account_id,
            subject: d.subject.clone(),
            to: d.to.clone(),
            cc: d.cc.clone(),
            snippet: snippet_of(&d),
            has_attachments: !d.attachments.is_empty() || !d.inline.is_empty(),
            send_at,
            created_at,
            status,
            error,
            attempts,
        });
    }
    Ok(out)
}

#[tauri::command]
fn cancel_outbox(app: tauri::AppHandle, state: tauri::State<AppState>, id: String) -> R<()> {
    let c = lock(&state.db);
    let payload: Option<String> = c.query_row("SELECT payload FROM outbox WHERE id=?1 AND status!='sending'", [&id], |r| r.get(0)).ok();
    let n = c.execute("DELETE FROM outbox WHERE id=?1 AND status!='sending'", [id]).map_err(err)?;
    if n == 0 {
        return Err("This message is being sent right now.".into());
    }
    if let Some(p) = payload {
        // a scheduled meeting that never went out must not stay in the calendar
        calendar::forget_prepared(&c, &p);
        let _ = app.emit("calendar-changed", serde_json::json!({}));
    }
    Ok(())
}

/// Counts for the quit guard: everything that will not go out unless the app keeps running.
fn outbox_counts(db: &Db) -> (i64, Option<i64>) {
    let c = lock(db);
    let count = c
        .query_row("SELECT COUNT(*) FROM outbox WHERE status IN ('pending','held','sending','overdue')", [], |r| r.get(0))
        .unwrap_or(0);
    let next = c
        .query_row("SELECT MIN(send_at) FROM outbox WHERE status='pending'", [], |r| r.get::<_, Option<i64>>(0))
        .ok()
        .flatten();
    (count, next)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingCount {
    count: i64,
    next: Option<i64>,
}

#[tauri::command]
fn outbox_pending_count(state: tauri::State<AppState>) -> PendingCount {
    let (count, next) = outbox_counts(&state.db);
    PendingCount { count, next }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutboxEdit {
    draft: smtp::Draft,
    send_at: i64,
    status: String,
}

/// Load a scheduled message into Compose. Pending or overdue items are paused (`held`) while they are edited.
#[tauri::command]
fn outbox_open_for_edit(state: tauri::State<AppState>, id: String) -> R<OutboxEdit> {
    let c = lock(&state.db);
    let (payload, send_at, status): (String, i64, String) = c
        .query_row("SELECT payload,send_at,status FROM outbox WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|_| "This scheduled message no longer exists.".to_string())?;
    if status == "sending" {
        return Err("This message is being sent right now.".into());
    }
    // an encrypted message is read back with the account's key (PGP_LOCKED:<fpr> while it is locked)
    let stored: smtp::Draft = serde_json::from_str(&payload).map_err(err)?;
    let acc = db::get_account(&c, &stored.account_id)?;
    let draft = pgpstore::unseal_from_outbox(&c, &acc, &stored)?;
    if status == "pending" || status == "overdue" {
        c.execute("UPDATE outbox SET status='held' WHERE id=?1", [&id]).map_err(err)?;
    }
    let shown = if status == "pending" || status == "overdue" { "held".to_string() } else { status };
    Ok(OutboxEdit { draft, send_at, status: shown })
}

/// Leave Compose without saving: a paused message goes back to the queue (or to Overdue when its time passed).
#[tauri::command]
fn outbox_release(state: tauri::State<AppState>, id: String) -> R<()> {
    lock(&state.db)
        .execute(
            "UPDATE outbox SET status=CASE WHEN send_at < ?2 THEN 'overdue' ELSE 'pending' END WHERE id=?1 AND status='held'",
            params![id, now() - schedule::GRACE_SECS],
        )
        .map_err(err)?;
    Ok(())
}

/// Save edits to a scheduled message (new content and time). It goes back to the queue.
#[tauri::command]
fn outbox_update(app: tauri::AppHandle, state: tauri::State<AppState>, id: String, draft: smtp::Draft, send_at: i64) -> R<()> {
    schedule::validate_send_at(send_at, now())?;
    const GONE: &str = "This scheduled message is no longer waiting to be sent.";
    // one critical section from the first look at the row to the UPDATE: the sender cannot claim it in between, and a
    // calendar event is only made once the row is known to be editable
    let c = lock(&state.db);
    let acc = db::get_account(&c, &draft.account_id)?;
    let (old, status) = c
        .query_row("SELECT payload, status FROM outbox WHERE id=?1", [&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| GONE.to_string())?;
    if status == "sending" {
        return Err(GONE.into());
    }
    // a meeting: drop the event made when it was first scheduled and make it again from the edited details
    let mut draft = draft;
    draft.calendar = None;
    if draft.meeting.is_some() {
        calendar::prepare_meeting(&c, &mut draft)?;
    }
    let sealed = match pgpstore::seal_for_outbox(&c, &acc, &draft) {
        Ok(d) => d,
        Err(e) => {
            // the edit failed (for example the key is locked): the queued message keeps its own event, so
            // only the event made for this attempt goes
            if let Ok(attempt) = serde_json::to_string(&draft) {
                calendar::forget_prepared(&c, &attempt);
            }
            return Err(e);
        }
    };
    let payload = serde_json::to_string(&sealed).map_err(err)?;
    let n = c
        .execute(
            "UPDATE outbox SET payload=?2, send_at=?3, status='pending', error=NULL, attempts=0 WHERE id=?1 AND status!='sending'",
            params![id, payload, send_at],
        )
        .map_err(err)?;
    if n == 0 {
        // lost the race after all: keep the queued message's own event, drop the one made for this attempt
        calendar::forget_prepared(&c, &payload);
        return Err(GONE.into());
    }
    // the edit worked: the event made when it was first scheduled is replaced by the new one
    calendar::forget_prepared(&c, &old);
    drop(c);
    if sealed.meeting.is_some() {
        let _ = app.emit("calendar-changed", serde_json::json!({}));
    }
    let _ = app.emit("outbox-changed", serde_json::json!({ "id": id, "status": "pending" }));
    Ok(())
}

/// Change only the time of a scheduled message.
#[tauri::command]
fn outbox_reschedule(app: tauri::AppHandle, state: tauri::State<AppState>, id: String, send_at: i64) -> R<()> {
    schedule::validate_send_at(send_at, now())?;
    let n = lock(&state.db)
        .execute(
            "UPDATE outbox SET send_at=?2, status='pending', error=NULL, attempts=0 WHERE id=?1 AND status IN ('pending','held','overdue','failed')",
            params![id, send_at],
        )
        .map_err(err)?;
    if n == 0 {
        return Err("This message is being sent right now.".into());
    }
    let _ = app.emit("outbox-changed", serde_json::json!({ "id": id, "status": "pending" }));
    Ok(())
}

/// Failed items go back to the queue and are picked up by the worker on its next pass.
#[tauri::command]
fn outbox_retry(app: tauri::AppHandle, state: tauri::State<AppState>, id: String) -> R<()> {
    lock(&state.db)
        .execute("UPDATE outbox SET status='pending', send_at=?2, error=NULL, attempts=0 WHERE id=?1 AND status IN ('failed','overdue')", params![id, now()])
        .map_err(err)?;
    let _ = app.emit("outbox-changed", serde_json::json!({ "id": id, "status": "pending" }));
    Ok(())
}

/// Move the message out of the queue and into Drafts on the server.
#[tauri::command]
async fn outbox_to_draft(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String) -> R<()> {
    let db = state.db.clone();
    let event_id = id.clone();
    blocking(move || {
        let payload: String = lock(&db)
            .query_row("SELECT payload FROM outbox WHERE id=?1 AND status!='sending'", [&id], |r| r.get(0))
            .map_err(|_| "This message is being sent right now.".to_string())?;
        let d: smtp::Draft = serde_json::from_str(&payload).map_err(err)?;
        let acc = db::get_account(&lock(&db), &d.account_id)?;
        let sec = secret(&db, &acc)?;
        let folder = fmap(&db, &acc.id).get("drafts").cloned().ok_or("this account has no Drafts folder")?;
        let raw = draft_bytes(&db, &acc, &d)?;
        let mut s = mail::connect(&acc, &sec)?;
        mail::append(&mut s, &folder, &raw, true)?;
        let _ = s.logout();
        let c = lock(&db);
        c.execute("DELETE FROM outbox WHERE id=?1", [&id]).map_err(err)?;
        calendar::forget_prepared(&c, &payload);
        Ok(())
    })
    .await?;
    let _ = app.emit("outbox-changed", serde_json::json!({ "id": event_id, "status": "removed" }));
    Ok(())
}

/// Atomically take a queued item for sending. Returns its payload and attempt count, or `None` if another
/// sender already has it (the timer and "Send now" can never both send the same message).
fn claim_outbox(db: &Db, id: &str, from: &[&str]) -> R<Option<(String, i64)>> {
    let c = lock(db);
    let row: Option<(String, i64)> = c
        .query_row("SELECT payload,attempts FROM outbox WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let Some((payload, attempts)) = row else { return Ok(None) };
    let placeholders = from.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",");
    let sql = format!("UPDATE outbox SET status='sending' WHERE id=?1 AND status IN ({placeholders})");
    let n = c.execute(&sql, [id]).map_err(err)?;
    Ok(if n == 1 { Some((payload, attempts)) } else { None })
}

fn retry_enabled(db: &Db) -> bool {
    setting(db, "scheduled_retry").map(|v| v != "0").unwrap_or(true)
}

/// Send a claimed item and record the outcome: delete on success, retry later or mark failed on error.
fn deliver(app: &tauri::AppHandle, db: &Db, id: &str, payload: &str, attempts: i64, late: &mut i64, due_at: i64) -> R<()> {
    let res = serde_json::from_str::<smtp::Draft>(payload).map_err(err).and_then(|d| send_now(db, &d));
    match res {
        Ok(()) => {
            if due_at < now() - 600 {
                *late += 1;
            }
            let _ = lock(db).execute("DELETE FROM outbox WHERE id=?1", [id]);
            let _ = app.emit("outbox-changed", serde_json::json!({ "id": id, "status": "sent" }));
            Ok(())
        }
        Err(e) => {
            let attempts = attempts + 1;
            let (status, next) = match schedule::retry_at(&e, attempts, retry_enabled(db), now()) {
                Some(at) => ("pending", at),
                None => ("failed", due_at),
            };
            let _ = lock(db).execute(
                "UPDATE outbox SET status=?2, error=?3, attempts=?4, send_at=?5 WHERE id=?1",
                params![id, status, e, attempts, next],
            );
            let _ = app.emit("outbox-changed", serde_json::json!({ "id": id, "status": status, "error": e }));
            Err(e)
        }
    }
}

/// Send one scheduled message now, whatever its state (except already sending).
#[tauri::command]
async fn outbox_send_now(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String) -> R<()> {
    let db = state.db.clone();
    blocking(move || {
        let (payload, attempts) = claim_outbox(&db, &id, &["pending", "held", "overdue", "failed"])?
            .ok_or("This message is already being sent.")?;
        let mut late = 0;
        let due = now();
        deliver(&app, &db, &id, &payload, attempts, &mut late, due)
    })
    .await
}

/// Startup: a message interrupted mid-send is queued again, and with "ask" anything whose time passed while the
/// app was closed waits as Overdue instead of going out without a word.
fn outbox_startup(db: &Db) {
    let c = lock(db);
    let _ = c.execute("UPDATE outbox SET status='pending' WHERE status='sending'", []);
    if setting_in(&c, "scheduled_catchup").as_deref() == Some("ask") {
        let _ = c.execute("UPDATE outbox SET status='overdue' WHERE status='pending' AND send_at < ?1", [now() - schedule::GRACE_SECS]);
    }
}

fn setting_in(c: &Connection, key: &str) -> Option<String> {
    db::get_setting(c, key)
}

fn outbox_worker(app: tauri::AppHandle, db: Db) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(15));
        let due: Vec<(String, i64)> = {
            let c = lock(&db);
            let Ok(mut st) = c.prepare("SELECT id,send_at FROM outbox WHERE status='pending' AND send_at<=?1 ORDER BY send_at") else {
                continue;
            };
            let Ok(rows) = st.query_map([now()], |r| Ok((r.get(0)?, r.get(1)?))) else { continue };
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut late = 0;
        for (id, due_at) in due {
            let Ok(Some((payload, attempts))) = claim_outbox(&db, &id, &["pending"]) else { continue };
            let _ = deliver(&app, &db, &id, &payload, attempts, &mut late, due_at);
        }
        if late > 0 {
            let _ = app.emit("outbox-catchup", serde_json::json!({ "count": late }));
        }
    }
}

/// Quit, or ask first when scheduled messages are still waiting (they only go out while the app runs).
pub(crate) fn request_quit(app: &tauri::AppHandle) {
    let db = app.state::<AppState>().db.clone();
    let (count, next) = outbox_counts(&db);
    if count > 0 {
        shell::show_main(app);
        let _ = app.emit("confirm-quit", serde_json::json!({ "count": count, "next": next }));
        return;
    }
    flush_pending(app);
    app.exit(0);
}

#[tauri::command]
fn quit_now(app: tauri::AppHandle) {
    flush_pending(&app);
    app.exit(0);
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("heylook.db"))?;
            let db: Db = Arc::new(Mutex::new(conn));
            outbox_startup(&db);
            let worker_db = db.clone();
            let worker_app = app.handle().clone();
            std::thread::spawn(move || outbox_worker(worker_app, worker_db));
            // files from "Open" are kept for a day
            std::thread::spawn(|| {
                let _ = attach::cleanup_older_than(&std::env::temp_dir().join("HeyLook"), 24 * 3600, std::time::SystemTime::now());
            });
            app.manage(AppState { db: db.clone() });
            migrate_secrets(&db);
            let pending_app = app.handle().clone();
            std::thread::spawn(move || pending_worker(pending_app));
            let cal_app = app.handle().clone();
            let cal_db = db.clone();
            std::thread::spawn(move || calendar::reminder_worker(cal_app, cal_db));

            winframe::setup(app);
            shell::register_aumid(app.handle());
            // a missing tray is not fatal: without it the close button quits instead of hiding (shell::close_to_tray)
            if let Err(e) = shell::setup_tray(app.handle(), &db) {
                eprintln!("tray icon unavailable: {e}");
            }
            shell::update_badge(app.handle(), &db);
            let handle = app.handle().clone();
            std::thread::spawn(move || sync_worker(handle));

            // started by "launch at login" => stay in the tray (only when there is a tray to come back from)
            if !std::env::args().any(|a| a == "--minimized") || !shell::tray_ready() {
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
                } else if outbox_counts(&db).0 > 0 {
                    // closing would quit: scheduled messages would wait until the next start, so ask first
                    api.prevent_close();
                    request_quit(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            winframe::frame_info,
            winframe::frame_caption_rect,
            winframe::frame_system_menu,
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
            attachment_save_as,
            attachment_save_all,
            attachment_open,
            attachment_reveal,
            pick_folder,
            inline_image,
            send_message,
            save_draft,
            list_outbox,
            cancel_outbox,
            outbox_pending_count,
            outbox_open_for_edit,
            outbox_release,
            outbox_update,
            outbox_reschedule,
            outbox_retry,
            outbox_to_draft,
            pgpstore::pgp_list_keys,
            pgpstore::pgp_generate_key,
            pgpstore::pgp_inspect_key,
            pgpstore::pgp_import_key,
            pgpstore::pgp_import_from_message,
            pgpstore::pgp_pick_key_file,
            pgpstore::pgp_public_armored,
            pgpstore::pgp_export_public,
            pgpstore::pgp_export_secret,
            pgpstore::pgp_delete_key,
            pgpstore::pgp_set_verified,
            pgpstore::pgp_set_default,
            pgpstore::pgp_change_passphrase,
            pgpstore::pgp_set_expiry,
            pgpstore::pgp_unlock,
            pgpstore::pgp_lock_all,
            pgpstore::pgp_recipient_status,
            pgpstore::pgp_decrypt_message,
            outbox_send_now,
            quit_now,
            calendar::calendar_list_calendars,
            calendar::calendar_set_visible,
            calendar::calendar_list_events,
            calendar::calendar_get_event,
            calendar::calendar_save_event,
            calendar::calendar_delete_event,
            calendar::calendar_respond,
            calendar::calendar_add_from_message,
            calendar::calendar_save_ics,
            calendar::calendar_import_ics,
            calendar::calendar_open_message,
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

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn relative_and_absolute_dates_in_operators() {
        let n = now();
        assert!(parse_when("7d").is_some_and(|t| (n - t - 7 * 86_400).abs() <= 2));
        assert!(parse_when("2026-01-31").is_some());
        assert_eq!(parse_when("banana"), None);
        // an absurd number of days must not overflow (it is not a usable date)
        assert_eq!(parse_when("9223372036854775807d"), None);
        assert_eq!(parse_when("99999999999999999d"), None);
    }

    #[test]
    fn operators_are_parsed() {
        let q = parse_query("from:\"Linh Tran\" has:attachment is:unread");
        assert_eq!(q.from, vec!["linh tran".to_string()]);
        assert!(q.has_attachment);
        assert_eq!(q.unread, Some(true));
    }
}
