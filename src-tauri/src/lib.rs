mod ai;
mod attach;
mod calendar;
mod db;
mod discover;
mod ical;
mod idle;
mod legacy_names;
// the checked open of links and files on Linux; compiled everywhere so that its rules are tested everywhere
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linuxopen;
#[cfg(target_os = "macos")]
mod macquit;
mod mail;
mod oauth;
mod oauth_page;
mod openpgp;
mod pgpmail;
mod pgpstore;
mod rawcache;
use oauth::Provider;
mod schedule;
mod sessionend;
mod shard;
mod shell;
mod smtp;
mod snippet;
mod update;
mod winframe;
mod startup;
mod webview_health;
mod winproc;

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

/// Name under which passwords, tokens and secrets are kept in the system credential store.
pub(crate) const KEYRING_SERVICE: &str = "heylook";

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
    keyring::Entry::new(KEYRING_SERVICE, account_id).and_then(|e| e.get_password()).map_err(|e| match e {
        keyring::Error::NoEntry => format!("no stored password: {e}"),
        other => keyring_error_text(std::env::consts::OS, "read", &other.to_string()),
    })
}

/// What the user is told when the system credential store refuses (`action`: "save" or "read"). Windows keeps the technical text.
fn keyring_error_text(os: &str, action: &str, err: &str) -> String {
    match os {
        "linux" => format!("Couldn’t {action} the password: no system keyring is available. On Linux, start and unlock GNOME Keyring or KWallet, then try again."),
        "macos" => format!("Couldn’t {action} the password in your macOS Keychain: {err}"),
        _ => format!("cannot {} password: {err}", if action == "save" { "store" } else { "read" }),
    }
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
    keyring::Entry::new(KEYRING_SERVICE, &format!("secret:{name}"))
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

fn secret_set(name: &str, value: &str) -> R<()> {
    let e = keyring::Entry::new(KEYRING_SERVICE, &format!("secret:{name}")).map_err(err)?;
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
        if let Some(pw) = keyring::Entry::new(KEYRING_SERVICE, &format!("{}:smtp", acc.id)).ok().and_then(|e| e.get_password().ok()) {
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
        // a separate SMTP login is verified up front; a shared one never was and a refusal of it still is not held against the account,
        // but a server that cannot be secured (a plain port with SSL/TLS or STARTTLS) is reported now, as the IMAP side is (REQ-53)
        if test_smtp {
            smtp::test(&a2, &smtp_pw)?;
        } else if let Err(e) = smtp::test(&a2, &smtp_pw) {
            if mail::is_secure_connection_error(&e) {
                return Err(e);
            }
        }
        Ok(())
    })
    .await?;
    keyring::Entry::new(KEYRING_SERVICE, &acc.id)
        .and_then(|e| e.set_password(&password_value))
        .map_err(|e| keyring_error_text(std::env::consts::OS, "save", &e.to_string()))?;
    if let Some(sp) = &smtp_password {
        let stored = keyring::Entry::new(KEYRING_SERVICE, &format!("{}:smtp", acc.id)).and_then(|e| e.set_password(sp));
        if let Err(e) = stored {
            // nothing half-added: the first secret goes again, no account row is made
            if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &acc.id) {
                let _ = entry.delete_credential();
            }
            return Err(keyring_error_text(std::env::consts::OS, "save", &e.to_string()));
        }
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
    open_target(&app, &pending.url, true)?;
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
    keyring::Entry::new(KEYRING_SERVICE, &acc.id)
        .and_then(|e| e.set_password(&signed.refresh_token))
        .map_err(|e| keyring_error_text(std::env::consts::OS, "save", &e.to_string()))?;
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

/// The UI has painted its first screen: the window may be shown (startup.rs).
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) {
    startup::mark_ready(&app);
}

/// The page's report on whether it is painting, a moment after the window was shown (startup.rs).
#[tauri::command]
fn page_state(app: tauri::AppHandle, visibility: String, frames: bool) {
    startup::page_state(&app, &visibility, frames);
}

/// The frontend tells whether any account exists: without one the tray's "New mail" and "Check mail now" are disabled.
#[tauri::command]
fn set_mail_available(available: bool) {
    shell::set_mail_available(available);
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
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &name) {
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

/// The server folder for a role (drafts, archive, trash ...). Hey Look! does not create standard folders a server lacks (README, known
/// limitations): the action that needs one fails with a message that says which folder is missing (QA BUG-M4 / M8).
fn folder_for(db: &Db, acc: &Account, role: &str) -> R<String> {
    fmap(db, &acc.id).get(role).cloned().ok_or_else(|| match role {
        "drafts" => "this account has no Drafts folder".to_string(),
        r => format!("no '{r}' folder on this account"),
    })
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
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22 | COALESCE((SELECT pgp FROM messages WHERE id=?1),0),?23,?24,?25)",
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
    let mut fresh: std::collections::HashSet<String> = Default::default(); // ids stored by this sync: never pruned
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
        // the first sync of a folder is only a taste (the newest page, so the UI has mail at once); `backfill_run` brings the rest
        let ff = match mail::fetch_folder(&mut s, name, max_uid, min_uid, PAGE) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let c = lock(db);
        c.execute_batch("BEGIN").map_err(err)?;
        for p in &ff.new {
            let tid = insert_parsed(&c, &acc, &role, p)?;
            result.added += 1;
            fresh.insert(format!("{}:{}:{}", acc.id, role, p.uid));
            if role == "inbox" && max_uid > 0 {
                if !p.seen {
                    result.new_inbox.push(NewMsg {
                        thread_id: tid.clone(),
                        account_id: acc.id.clone(),
                        // a confidential mail's text never goes into a toast, which screen capture protection does not cover
                        snippet: if p.pgp & pgpmail::FLAG_CONFIDENTIAL != 0 { "Confidential message".into() } else { p.snippet.chars().take(160).collect() },
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
    startup::line("filters", &format!("account {}: {} new inbox message(s) to check", acc.id, to_rule.len()));
    if !to_rule.is_empty() {
        let rules: Vec<Rule> = load_rules(&lock(db))
            .into_iter()
            .filter(|r| r.account_id.as_deref().map_or(true, |a| a == acc.id))
            .collect();
        startup::line("filters", &format!("{} filter(s) apply to this account", rules.len()));
        let outcome = apply_rules(&rules, &to_rule, &mut |r, tid| {
            let res = action_impl(db, vec![tid.to_string()], r.action.clone(), r.arg.clone(), Some("inbox".into()));
            // a move that reports success but left the message in the inbox did not happen
            if res.is_ok() && matches!(r.action.as_str(), "archive" | "trash" | "junk" | "move") {
                let still = thread_msgs(&lock(db), &[tid.to_string()]).map(|m| m.iter().any(|x| x.role == "inbox")).unwrap_or(false);
                if still {
                    return Err("the message is still in the Inbox after the move".to_string());
                }
            }
            res
        });
        for why in &outcome.errors {
            startup::line("filters", why);
            note_rule_error(why.clone());
        }
        result.new_inbox.retain(|n| !outcome.moved.contains(&n.thread_id));
    }
    // new mail arrived: keep the account at its cap by dropping its oldest local mail (a failure here never fails the sync)
    if result.added > 0 {
        match prune_oldest(db, account_id, max_download(db), &fresh) {
            Ok(0) => {}
            Ok(n) => eprintln!("pruned {n} oldest local messages of account {account_id} (download cap)"),
            Err(e) => eprintln!("pruning account {account_id} failed: {e}"),
        }
    }
    Ok(result)
}

/// What running the filters over new mail came to: the threads that left the inbox, and one message per failed filter run.
struct RuleOutcome {
    moved: std::collections::HashSet<String>,
    errors: Vec<String>,
}

/// Run every matching filter on every new message. `run` performs the action of a filter on a thread. A failed action leaves the message
/// where it is (it still counts as new mail for notifications and the badge) and is reported as `Filter “{name}” couldn’t run on new
/// mail: {error}` (REQ-52); the other filters and messages carry on.
fn apply_rules(rules: &[Rule], msgs: &[(String, String, String, String)], run: &mut dyn FnMut(&Rule, &str) -> R<()>) -> RuleOutcome {
    let mut out = RuleOutcome { moved: Default::default(), errors: vec![] };
    for (tid, from, to, subject) in msgs {
        for r in rules {
            if !rule_matches(r, from, to, subject) {
                continue;
            }
            match run(r, tid) {
                Ok(()) => {
                    startup::line("filters", &format!("filter “{}” ({}) matched a new message: done", r.name, r.action));
                    if matches!(r.action.as_str(), "archive" | "trash" | "junk" | "move") {
                        out.moved.insert(tid.clone());
                    }
                }
                Err(e) => out.errors.push(if r.name.trim().is_empty() {
                    format!("A filter couldn’t run on new mail: {e}")
                } else {
                    format!("Filter “{}” couldn’t run on new mail: {e}", r.name.trim())
                }),
            }
        }
    }
    out
}

/// Reasons rules failed during syncs, waiting to be told to the person; a reason is told once per run.
static RULE_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static RULE_ERRORS_TOLD: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn note_rule_error(why: String) {
    let told = RULE_ERRORS_TOLD.lock().unwrap_or_else(|p| p.into_inner());
    let mut waiting = RULE_ERRORS.lock().unwrap_or_else(|p| p.into_inner());
    if !told.contains(&why) && !waiting.contains(&why) {
        waiting.push(why);
    }
}

/// The reasons to tell the person now (each reason once per run); they are marked as told.
fn take_rule_errors_to_tell() -> Vec<String> {
    let mut told = RULE_ERRORS_TOLD.lock().unwrap_or_else(|p| p.into_inner());
    let mut out = vec![];
    for why in std::mem::take(&mut *RULE_ERRORS.lock().unwrap_or_else(|p| p.into_inner())) {
        if !told.contains(&why) {
            told.push(why.clone());
            out.push(why);
        }
    }
    out
}

static SYNC_LOCK: Mutex<()> = Mutex::new(());

/// One sync pass for an account, then toasts + tray badge. Serialized so the UI and the background worker never overlap.
fn run_sync(app: &tauri::AppHandle, db: &Db, account_id: &str) -> R<SyncResult> {
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let r = sync_impl(db, account_id)?;
    for why in take_rule_errors_to_tell() {
        let _ = app.emit("filter-failed", why);
    }
    backfill_start(app, db, account_id);
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
            // while the account's IDLE push session is healthy, polling is only the safety net (and the way to check the other folders)
            let mins = idle::poll_minutes_for(&id, mins);
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

/// Messages per IMAP fetch: the first sync, every "load older" page and every backfill chunk. Gmail drops or throttles a
/// FETCH of hundreds of full messages, so mail always arrives in small steps.
const PAGE: u32 = 50;

/// How many messages a folder should hold locally after the background download: the inbox is worth a long history, other
/// folders get a shorter one. "Load older" goes beyond it on request.
fn backfill_target(role: &str) -> u32 {
    if role == "inbox" { 500 } else { 100 }
}

/// "Max emails to download per mailbox" (setting `max_download`): most messages stored for ONE account, all its folders together.
/// It limits the background download and "load older"; new mail from a normal sync is never held back, instead the oldest
/// local mail is pruned when new mail arrives and the account is over the cap (`prune_oldest`). Changing the setting alone
/// deletes nothing.
const MAX_DOWNLOAD_DEFAULT: u32 = 2000;
const MAX_DOWNLOAD_MIN: u32 = 100;
const MAX_DOWNLOAD_MAX: u32 = 5000;

/// The setting's stored text as a cap: missing or not a number = the default, otherwise clamped to the allowed range (same
/// rule as `clampMaxDownload` in prefs.ts).
fn parse_max_download(v: Option<&str>) -> u32 {
    match v.and_then(|t| t.trim().parse::<f64>().ok()).filter(|f| f.is_finite()) {
        Some(f) => f.trunc().clamp(MAX_DOWNLOAD_MIN as f64, MAX_DOWNLOAD_MAX as f64) as u32,
        None => MAX_DOWNLOAD_DEFAULT,
    }
}

/// Read every time it is needed, so a change in Settings applies to the next chunk without a restart.
fn max_download(db: &Db) -> u32 {
    parse_max_download(setting(db, "max_download").as_deref())
}

/// How many of `want` messages may still be stored when `total` are already there and the cap is `cap`.
fn clamp_chunk(want: u32, total: u32, cap: u32) -> u32 {
    want.min(cap.saturating_sub(total))
}

/// Messages stored for the account, all folders (the `messages` view routes to the account's own shard).
fn account_total(db: &Db, account_id: &str) -> R<u32> {
    lock(db)
        .query_row("SELECT COUNT(*) FROM messages WHERE account_id=?1", params![account_id], |r| r.get(0))
        .map_err(err)
}

/// Bring an account back to `cap` messages after new mail arrived: delete its OLDEST messages (by date, across folders) from the
/// local database only - nothing is sent to the server, so the mail stays there. Never deleted: drafts, flagged messages,
/// messages of pinned or snoozed threads, the newest message of every folder (the sync's high-water mark: a folder that lost
/// every row would be fetched afresh, and pruned again, on each sync) and `keep` (what the running sync just stored). If those
/// alone exceed the cap the rest is still pruned and the account stays above it, without an error. Rows go by id, straight from
/// the account's own table in one transaction (the `messages` view cannot count deletes). A folder that lost rows is no longer
/// "downloaded to the oldest message", so its `exhausted:` mark is cleared. Never holds the lock across network IO (it has none).
/// Returns how many messages were deleted.
fn prune_oldest(db: &Db, account_id: &str, cap: u32, keep: &std::collections::HashSet<String>) -> R<u32> {
    let ids: Vec<(String, String)> = {
        let c = lock(db);
        let total: u32 = c
            .query_row("SELECT COUNT(*) FROM messages WHERE account_id=?1", params![account_id], |r| r.get(0))
            .map_err(err)?;
        if total <= cap {
            return Ok(0);
        }
        let excess = (total - cap) as usize;
        let mut st = c.prepare("SELECT folder, MAX(uid) FROM messages WHERE account_id=?1 GROUP BY folder").map_err(err)?;
        let newest: std::collections::HashMap<String, u32> = st
            .query_map(params![account_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .filter_map(|r| r.ok())
            .collect();
        drop(st);
        // enough candidates to still have `excess` left after the ones that are skipped below
        let want = (excess + keep.len() + newest.len()) as i64;
        let mut st = c
            .prepare(
                "SELECT m.id, m.folder, m.uid FROM messages m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id
                 WHERE m.account_id=?1 AND m.folder<>'drafts' AND m.flagged=0 AND COALESCE(tm.pinned,0)=0 AND tm.snoozed_until IS NULL
                 ORDER BY m.date ASC, m.id ASC LIMIT ?2",
            )
            .map_err(err)?;
        let found: Vec<(String, String, u32)> = st
            .query_map(params![account_id, want], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?
            .filter_map(|r| r.ok())
            .collect();
        drop(st);
        found
            .into_iter()
            .filter(|(id, folder, uid)| !keep.contains(id) && newest.get(folder) != Some(uid))
            .take(excess)
            .map(|(id, folder, _)| (id, folder))
            .collect()
    };
    if ids.is_empty() {
        return Ok(0);
    }
    {
        let c = lock(db);
        let table = shard::messages_table(&c, account_id)?;
        c.execute_batch("BEGIN").map_err(err)?;
        let res = (|| -> R<()> {
            let mut del = c.prepare(&format!("DELETE FROM {table} WHERE id=?1")).map_err(err)?;
            for (id, _) in &ids {
                del.execute(params![id]).map_err(err)?;
            }
            let folders: std::collections::HashSet<&String> = ids.iter().map(|(_, f)| f).collect();
            for f in folders {
                c.execute("DELETE FROM settings WHERE key=?1", params![exhausted_key(account_id, f)]).map_err(err)?;
            }
            Ok(())
        })();
        match res {
            Ok(()) => c.execute_batch("COMMIT").map_err(err)?,
            Err(e) => {
                let _ = c.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    for (id, _) in &ids {
        rawcache::forget(id);
    }
    Ok(ids.len() as u32)
}

/// Pause between two chunks of the background download, so the server (and the database lock) are never hammered.
const BACKFILL_PAUSE: std::time::Duration = std::time::Duration::from_millis(1500);

fn exhausted_key(account_id: &str, role: &str) -> String {
    format!("exhausted:{account_id}:{role}")
}

/// The folder was downloaded down to its oldest message (kept, so it is not asked again on every visit).
fn is_exhausted(db: &Db, account_id: &str, role: &str) -> bool {
    db::get_setting(&lock(db), &exhausted_key(account_id, role)).is_some()
}

/// (messages stored, lowest stored uid) of a folder; the uid is 0 for an empty folder.
fn folder_state(db: &Db, account_id: &str, role: &str) -> R<(u32, u32)> {
    lock(db)
        .query_row(
            "SELECT COUNT(*), COALESCE(MIN(uid),0) FROM messages WHERE account_id=?1 AND folder=?2",
            params![account_id, role],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)
}

/// Store a page of older messages in one transaction (all or nothing). Never holds the lock while talking to the server.
fn store_page(db: &Db, acc: &Account, role: &str, found: &[mail::Parsed]) -> R<()> {
    let c = lock(db);
    c.execute_batch("BEGIN").map_err(err)?;
    for p in found {
        if let Err(e) = insert_parsed(&c, acc, role, p) {
            let _ = c.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    c.execute_batch("COMMIT").map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadOlder {
    added: u32,
    /// the folder has nothing older than what is stored now
    exhausted: bool,
    /// the "Max emails to download" cap stopped it, not the server: more can be loaded after raising the cap
    limited: bool,
}

fn load_older_impl(db: &Db, account_id: &str, role: &str, limit: u32) -> R<LoadOlder> {
    if is_exhausted(db, account_id, role) {
        return Ok(LoadOlder { added: 0, exhausted: true, limited: false });
    }
    let cap = max_download(db);
    let total = account_total(db, account_id)?;
    if total >= cap {
        return Ok(LoadOlder { added: 0, exhausted: false, limited: true }); // no network at all
    }
    let acc = db::get_account(&lock(db), account_id)?;
    let sec = secret(db, &acc)?;
    let name = fmap(db, account_id).get(role).cloned().ok_or("folder unknown")?;
    let (_, min_uid) = folder_state(db, account_id, role)?;
    if min_uid == 0 {
        return Ok(LoadOlder { added: 0, exhausted: true, limited: false }); // nothing stored: there is no "older" to speak of
    }
    let mut s = mail::connect(&acc, &sec)?;
    let (found, exhausted) = mail::fetch_older(&mut s, &name, min_uid, clamp_chunk(limit, total, cap) as usize)?;
    let _ = s.logout();
    store_page(db, &acc, role, &found)?;
    if exhausted {
        db::set_setting(&lock(db), &exhausted_key(account_id, role), "1")?;
    }
    let added = found.len() as u32;
    Ok(LoadOlder { added, exhausted, limited: !exhausted && total + added >= cap })
}

/// Fetch the next page (default and maximum 50) of older messages for a folder. An IMAP failure is an error, never "nothing
/// older": `exhausted` is true only when the server has no older message, `limited` only when the download cap stopped it.
#[tauri::command]
async fn load_older(state: tauri::State<'_, AppState>, account_id: String, role: String, limit: Option<u32>) -> R<LoadOlder> {
    let db = state.db.clone();
    let limit = limit.unwrap_or(PAGE).clamp(1, PAGE);
    blocking(move || load_older_impl(&db, &account_id, &role, limit)).await
}

// ---------- background download of the history ----------

/// Accounts whose backfill thread is running (one per account).
static BACKFILLING: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct BackfillGuard(String);

impl Drop for BackfillGuard {
    fn drop(&mut self) {
        BACKFILLING.lock().unwrap_or_else(|p| p.into_inner()).retain(|a| *a != self.0);
    }
}

/// The next folder that still has history to download: (role, IMAP name, stored, target), in sync order (inbox first). A folder
/// with nothing stored yet waits for its first sync; `skip` holds folders given up on during this run. The target never goes
/// beyond the account's cap: the folder's own target, the cap, and what is left of it after the other folders (`have + room`).
fn next_backfill(db: &Db, account_id: &str, skip: &std::collections::HashSet<String>, cap: u32) -> Option<(String, String, u32, u32)> {
    let room = cap.saturating_sub(account_total(db, account_id).ok()?);
    if room == 0 {
        return None;
    }
    let map = fmap(db, account_id);
    let mut roles: Vec<String> = mail::ROLES.iter().filter(|r| map.contains_key(**r)).map(|r| r.to_string()).collect();
    let mut custom: Vec<String> = map.keys().filter(|k| k.starts_with("f:")).cloned().collect();
    custom.sort();
    roles.extend(custom);
    for role in roles {
        if skip.contains(&role) || is_exhausted(db, account_id, &role) {
            continue;
        }
        let Ok((have, min_uid)) = folder_state(db, account_id, &role) else { continue };
        let target = backfill_target(&role).min(cap).min(have + room);
        if have > 0 && min_uid > 1 && have < target {
            return Some((role.clone(), map[&role].clone(), have, target));
        }
    }
    None
}

/// Start the background download for an account unless one is already running or there is nothing left to download.
fn backfill_start(app: &tauri::AppHandle, db: &Db, account_id: &str) {
    if next_backfill(db, account_id, &Default::default(), max_download(db)).is_none() {
        return;
    }
    {
        let mut running = BACKFILLING.lock().unwrap_or_else(|p| p.into_inner());
        if running.iter().any(|a| a == account_id) {
            return;
        }
        running.push(account_id.to_string());
    }
    let (app, db, id) = (app.clone(), db.clone(), account_id.to_string());
    let spawned = std::thread::Builder::new().name("backfill".into()).spawn(move || {
        let _guard = BackfillGuard(id.clone());
        if let Err(e) = backfill_run(&app, &db, &id) {
            // not fatal: the next sync starts again where this one stopped
            eprintln!("background download for account {id} stopped: {e}");
        }
    });
    if spawned.is_err() {
        BACKFILLING.lock().unwrap_or_else(|p| p.into_inner()).retain(|a| a != account_id);
    }
}

/// Download older mail in chunks of `PAGE`, one folder after the other, until every folder holds its target (or the account
/// its cap) or has nothing older. Resumable (it works from what is stored), stops when the account is removed, and on an error (after one reconnect).
fn backfill_run(app: &tauri::AppHandle, db: &Db, account_id: &str) -> R<()> {
    let mut sess: Option<mail::Sess> = None;
    let mut skip: std::collections::HashSet<String> = Default::default();
    let mut failures = 0;
    loop {
        // the account can be removed while this runs: its mail file is gone, so stop
        let acc = db::get_account(&lock(db), account_id)?;
        let Some((role, name, have, target)) = next_backfill(db, account_id, &skip, max_download(db)) else { break };
        let (_, below) = folder_state(db, account_id, &role)?;
        let step = (|| -> R<(usize, bool)> {
            if sess.is_none() {
                sess = Some(mail::connect(&acc, &secret(db, &acc)?)?);
            }
            let s = sess.as_mut().ok_or("no session")?;
            let (found, exhausted) = mail::fetch_older(s, &name, below, (target - have).min(PAGE) as usize)?;
            store_page(db, &acc, &role, &found)?;
            Ok((found.len(), exhausted))
        })();
        match step {
            Ok((added, exhausted)) => {
                failures = 0;
                if exhausted {
                    db::set_setting(&lock(db), &exhausted_key(account_id, &role), "1")?;
                } else if added == 0 {
                    skip.insert(role.clone()); // a page that yields nothing must not loop forever
                }
                let (now_have, _) = folder_state(db, account_id, &role)?;
                let done = exhausted || now_have >= target || added == 0;
                let _ = app.emit(
                    "backfill-progress",
                    serde_json::json!({ "accountId": account_id, "role": role, "have": now_have, "target": target, "done": done }),
                );
                std::thread::sleep(BACKFILL_PAUSE);
            }
            Err(e) => {
                sess = None; // a failed session is not reused
                failures += 1;
                if failures > 1 {
                    return Err(e);
                }
                std::thread::sleep(BACKFILL_PAUSE);
            }
        }
    }
    if let Some(mut s) = sess {
        let _ = s.logout();
    }
    Ok(())
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
fn test_notification(app: tauri::AppHandle, state: tauri::State<AppState>) -> R<()> {
    shell::test_notification(&app, &state.db)
}

/// What the UI needs to know about the shell it runs in: the OS (per-OS copy and shortcut labels) and whether a tray exists.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    os: &'static str,
    tray: bool,
    /// debug builds only: the test data folder in use (the About page says so)
    test_data: Option<String>,
}

#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo { os: std::env::consts::OS, tray: shell::tray_ready(), test_data: legacy_names::test_data_dir().map(|p| p.display().to_string()) }
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
    /// a message of the conversation was labelled confidential by its sender
    confidential: bool,
    /// request | reply | cancel when a message of the conversation carries a calendar invitation
    invite: Option<String>,
}

#[tauri::command]
fn list_threads(state: tauri::State<AppState>, filter: ThreadFilter) -> R<Vec<ThreadSummary>> {
    threads_for(&lock(&state.db), filter)
}

fn threads_for(c: &Connection, filter: ThreadFilter) -> R<Vec<ThreadSummary>> {
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
        // viewing Trash/Junk itself: the search stays inside it (the open folder is already pinned above)
        let in_bin = matches!(filter.folder.as_str(), "trash" | "junk");
        if explicit_folder.is_none() && !cross && !in_bin {
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
                confidential: false,
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
        e.confidential |= pgp & pgpmail::FLAG_CONFIDENTIAL as i64 != 0;
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
    /// labelled confidential by the sender: shown without screen capture, copy, print or forwarding
    confidential: bool,
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
    let pgp: i64 = r.get(16)?;
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
            confidential: pgp & pgpmail::FLAG_CONFIDENTIAL as i64 != 0,
            ics: r.get(18)?,
            invite: None,
        },
        pgp,
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

/// A signature inside an encrypted message cannot be seen before it is decrypted, so the sync step only stored "encrypted".
/// Once the message was opened and carried a signature, remember that one bit (no content) so the list's signed mark and the
/// thread's `signed` flag include it from then on.
fn note_signed(c: &Connection, id: &str, sec: &pgpmail::Security) {
    if sec.signature.is_some() {
        let _ = c.execute("UPDATE messages SET pgp = pgp | ?2 WHERE id=?1 AND pgp & ?2 = 0", params![id, pgpmail::FLAG_SIGNED as i64]);
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
            note_signed(c, &m.id, &o.security);
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
        // a move to a folder the server does not have fails at once and says which one, before any connection is made
        if let Some(dst) = &dst_role {
            let moves = list.iter().any(|m| {
                &m.role != dst
                    && match &scope {
                        Some(sc) => &m.role == sc,
                        None => !matches!(m.role.as_str(), "sent" | "drafts" | "trash" | "junk"),
                    }
            });
            if moves {
                folder_for(db, &acc, dst)?;
            }
        }
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
                    let real = folder_for(db, &acc, &dst)?;
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
    // downloaded once per session (bounded, see rawcache.rs): the second picture or click of the same message is instant
    let raw = rawcache::get_or_fetch(message_id, || {
        let acc = db::get_account(&lock(db), &acct)?;
        let sec = secret(db, &acc)?;
        let name = fmap(db, &acct).get(&role).cloned().ok_or("folder unknown")?;
        let mut s = mail::connect(&acc, &sec)?;
        let raw = mail::fetch_raw(&mut s, &name, uid)?;
        let _ = s.logout();
        Ok::<_, String>(raw)
    })?;
    Ok((raw.as_ref().clone(), att))
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

/// Confidential mail (sender's Sensitivity / label, see mail::is_confidential) must not leave the app: the UI hides these
/// actions, and this refuses them here too. Showing a picture or previewing an attachment inside the app stays allowed.
pub(crate) fn ensure_not_confidential(c: &Connection, message_id: &str) -> R<()> {
    let pgp: i64 = c.query_row("SELECT pgp FROM messages WHERE id=?1", [message_id], |r| r.get(0)).unwrap_or(0);
    if pgp & pgpmail::FLAG_CONFIDENTIAL as i64 != 0 {
        return Err("This message is confidential, so that isn’t allowed.".into());
    }
    Ok(())
}

#[tauri::command]
async fn get_raw(state: tauri::State<'_, AppState>, message_id: String) -> R<String> {
    let db = state.db.clone();
    let (raw, _) = blocking(move || {
        ensure_not_confidential(&lock(&db), &message_id)?;
        fetch_raw_for(&db, &message_id)
    })
    .await?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

/// Folder for "Save" (Settings → Attachments), falling back to the system Downloads folder.
fn download_folder(app: &tauri::AppHandle, db: &Db) -> R<std::path::PathBuf> {
    let (system, from_home) = system_download_dir(app.path().download_dir().ok(), app.path().home_dir().ok())?;
    let (dir, replaced) = resolve_download_dir(setting(db, "download_dir").as_deref(), system);
    // no Downloads folder on this system (a bare Linux install): the home folder is used, and the user is told once
    if from_home && replaced.is_none() && first_time_for(&DOWNLOAD_WARNED, "Downloads") {
        let _ = app.emit("download-dir-fallback", serde_json::json!({ "configured": "Downloads", "used": dir.to_string_lossy() }));
    }
    // a chosen folder that is gone is no secret: say so (once per folder and session) instead of quietly saving elsewhere
    if let Some(bad) = replaced.filter(|b| first_time_for(&DOWNLOAD_WARNED, b)) {
        let _ = app.emit("download-dir-fallback", serde_json::json!({ "configured": bad, "used": dir.to_string_lossy() }));
    }
    Ok(dir)
}

static DOWNLOAD_WARNED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// True the first time `key` is seen in `seen`.
fn first_time_for(seen: &Mutex<Vec<String>>, key: &str) -> bool {
    let mut g = seen.lock().unwrap_or_else(|p| p.into_inner());
    if g.iter().any(|k| k == key) {
        return false;
    }
    g.push(key.to_string());
    true
}

/// The system folder for downloads, or the home folder when there is none (second value: it is the home folder).
fn system_download_dir(download: Option<std::path::PathBuf>, home: Option<std::path::PathBuf>) -> R<(std::path::PathBuf, bool)> {
    match (download, home) {
        (Some(d), _) => Ok((d, false)),
        (None, Some(h)) => Ok((h, true)),
        (None, None) => Err("No folder to save into: set one in Settings > Mailboxes > Reading & sync.".into()),
    }
}

/// The folder attachments are saved to: the configured one when it is an existing folder, else the system Downloads folder.
/// The second value is the configured path when it had to be replaced (so the user can be told).
fn resolve_download_dir(configured: Option<&str>, system: std::path::PathBuf) -> (std::path::PathBuf, Option<String>) {
    match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) if std::path::Path::new(p).is_dir() => (p.into(), None),
        Some(p) => (system, Some(p.to_string())),
        None => (system, None),
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
        ensure_not_confidential(&lock(&db), &message_id)?;
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
        ensure_not_confidential(&lock(&db), &message_id)?;
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
        ensure_not_confidential(&lock(&db), &message_id)?;
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

/// Open a link (`is_url`) or a file with the system's default program. Linux checks what the launcher did and says so when
/// nothing opened (linuxopen.rs); Windows and macOS use the opener plugin as before.
fn open_target(app: &tauri::AppHandle, target: &str, is_url: bool) -> R<()> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linuxopen::open(target, is_url)
    }
    #[cfg(not(target_os = "linux"))]
    {
        if is_url { app.opener().open_url(target, None::<&str>) } else { app.opener().open_path(target, None::<&str>) }.map_err(err)
    }
}

/// A link of a message, the About page or an update, in the default browser or mail program. The page calls this only on Linux
/// (elsewhere it uses the opener plugin directly); the other systems get the same behaviour here for completeness.
#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> R<()> {
    if !linuxopen::url_allowed(&url) {
        return Err("That kind of link is not opened.".into()); // the same schemes as the opener plugin allows
    }
    blocking(move || open_target(&app, &url, true)).await
}

/// Put text on the system clipboard. The page calls this only on Linux, where the web view's own clipboard call
/// (`navigator.clipboard`) is not available to a page that does not run in a secure context or has no user gesture left (the
/// "link is copied" toast after a failed open copied nothing, QA BUG-L4); the text goes to the GTK clipboard the web view and
/// every other GTK program use. Other systems report that it is not available.
#[tauri::command]
async fn copy_text(app: tauri::AppHandle, text: String) -> R<()> {
    #[cfg(target_os = "linux")]
    {
        blocking(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            // GTK is used on the main thread only
            app.run_on_main_thread(move || {
                let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
                clipboard.set_text(&text);
                let _ = tx.send(());
            })
            .map_err(err)?;
            rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "the clipboard did not answer".to_string())
        })
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, text);
        Err("copying from the backend is only available on Linux".into())
    }
}

/// Write an attachment to the temp folder and open it with the default app. Programs and scripts need
/// `confirmed = true`; otherwise the error starts with `ATT_RISKY` (unless the user turned the warning off).
#[tauri::command]
async fn attachment_open(app: tauri::AppHandle, state: tauri::State<'_, AppState>, message_id: String, index: usize, confirmed: bool) -> R<String> {
    let db = state.db.clone();
    blocking(move || {
        ensure_not_confidential(&lock(&db), &message_id)?;
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
        open_target(&app, &shown, false)?;
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

/// Store a message that is in its "Undo" time (REQ-49): it is in the local outbox from the moment Send is pressed, so a process that ends
/// in that time (a kill, an installer, a crash) does not lose it; the next start sends it like a scheduled message that came due.
fn insert_outbox_hold(db: &Db, draft: &smtp::Draft, due_at: i64, replaces: Option<&str>) -> R<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::to_string(draft).map_err(err)?;
    lock(db)
        .execute(
            "INSERT INTO outbox(id,account_id,payload,send_at,status,created_at,undo,replaces) VALUES(?1,?2,?3,?4,'undo',?5,1,?6)",
            params![id, draft.account_id, payload, due_at, now(), replaces],
        )
        .map_err(err)?;
    Ok(id)
}

/// Send was pressed with an Undo time: keep the message in the outbox until the time is over (or a quit sends it early).
#[tauri::command]
async fn outbox_hold(app: tauri::AppHandle, state: tauri::State<'_, AppState>, draft: smtp::Draft, due_at: i64, replaces: Option<String>) -> R<String> {
    let db = state.db.clone();
    let mut draft = draft;
    // a meeting made in Compose: create the event and the calendar part now (as for a message that is sent at once)
    if draft.meeting.is_some() {
        calendar::prepare_meeting(&lock(&db), &mut draft)?;
        let _ = app.emit("calendar-changed", serde_json::json!({}));
    }
    blocking(move || {
        let acc = db::get_account(&lock(&db), &draft.account_id)?;
        let draft = pgpstore::seal_for_outbox(&lock(&db), &acc, &draft)?;
        insert_outbox_hold(&db, &draft, due_at, replaces.as_deref())
    })
    .await
}

/// What happens to the row of an Undo-window message whose delivery failed: it stays for the next start (`keep`: the app is quitting,
/// REQ-48 c) or leaves the outbox (the app keeps running: Compose reopens with the text, as before).
fn finish_failed_hold(db: &Db, id: &str, payload: &str, error: &str, keep: bool) {
    let c = lock(db);
    if keep {
        let _ = c.execute("UPDATE outbox SET status='pending', undo=2, error=?2, attempts=1, send_at=?3 WHERE id=?1", params![id, error, now()]);
    } else {
        let _ = c.execute("DELETE FROM outbox WHERE id=?1", [id]);
        calendar::forget_prepared(&c, payload);
    }
}

/// The Undo time of a held message is over (or a quit ends it early): send it now. `keep`: on failure the row stays (quit).
#[tauri::command]
async fn outbox_hold_send(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String, keep: bool) -> R<()> {
    let db = state.db.clone();
    blocking(move || {
        let (payload, _attempts) = claim_outbox(&db, &id, &["undo"])?.ok_or("This message is no longer waiting to be sent.")?;
        let replaces: Option<String> = lock(&db).query_row("SELECT replaces FROM outbox WHERE id=?1", [&id], |r| r.get(0)).ok().flatten();
        let res = serde_json::from_str::<smtp::Draft>(&payload).map_err(err).and_then(|d| send_now(&db, &d));
        match res {
            Ok(()) => {
                let _ = lock(&db).execute("DELETE FROM outbox WHERE id=?1", [&id]);
                drop_replaced_draft(&db, replaces);
                let _ = app.emit("outbox-changed", serde_json::json!({ "id": id, "status": "sent" }));
                Ok(())
            }
            Err(e) => {
                finish_failed_hold(&db, &id, &payload, &e, keep);
                Err(e)
            }
        }
    })
    .await
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
        let raw = draft_bytes(&db, &acc, &draft)?;
        let mut s = mail::connect(&acc, &sec)?;
        let folder = folder_for(&db, &acc, "drafts")?;
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
        .prepare("SELECT id,account_id,payload,send_at,status,error,created_at,attempts FROM outbox WHERE status!='sent' AND undo!=1 ORDER BY send_at")
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
        .query_row("SELECT COUNT(*) FROM outbox WHERE status IN ('pending','held','sending','overdue') AND undo!=1", [], |r| r.get(0))
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
        let raw = draft_bytes(&db, &acc, &d)?;
        let mut s = mail::connect(&acc, &sec)?;
        let folder = folder_for(&db, &acc, "drafts")?;
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
fn deliver(app: &tauri::AppHandle, db: &Db, id: &str, payload: &str, attempts: i64, late: &mut i64, left: &mut i64, due_at: i64) -> R<()> {
    let res = serde_json::from_str::<smtp::Draft>(payload).map_err(err).and_then(|d| send_now(db, &d));
    // 2 = left behind by an earlier run (REQ-49 d): told apart from a scheduled message that came due while the app was closed
    let (undo, replaces): (i64, Option<String>) =
        lock(db).query_row("SELECT undo, replaces FROM outbox WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap_or((0, None));
    match res {
        Ok(()) => {
            if undo == 2 {
                *left += 1;
            } else if due_at < now() - 600 {
                *late += 1;
            }
            let _ = lock(db).execute("DELETE FROM outbox WHERE id=?1", [id]);
            drop_replaced_draft(db, replaces);
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
        let (mut late, mut left) = (0, 0);
        let due = now();
        deliver(&app, &db, &id, &payload, attempts, &mut late, &mut left, due)
    })
    .await
}

/// Startup: a message interrupted mid-send is queued again, and with "ask" anything whose time passed while the
/// app was closed waits as Overdue instead of going out without a word.
fn outbox_startup(db: &Db) {
    let c = lock(db);
    let _ = c.execute("UPDATE outbox SET status='pending' WHERE status='sending'", []);
    // messages that were in their Undo time when the last run ended (REQ-49 d): they go out like a scheduled message that came due
    let _ = c.execute("UPDATE outbox SET status='pending', undo=2 WHERE undo=1", []);
    if setting_in(&c, "scheduled_catchup").as_deref() == Some("ask") {
        let _ = c.execute("UPDATE outbox SET status='overdue' WHERE status='pending' AND send_at < ?1", [now() - schedule::GRACE_SECS]);
    }
    // ... and one that waits for the person's decision is an ordinary Overdue row of the Scheduled list from here on
    let _ = c.execute("UPDATE outbox SET undo=0 WHERE undo=2 AND status='overdue'", []);
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
        let (mut late, mut left) = (0, 0);
        for (id, due_at) in due {
            let Ok(Some((payload, attempts))) = claim_outbox(&db, &id, &["pending"]) else { continue };
            let _ = deliver(&app, &db, &id, &payload, attempts, &mut late, &mut left, due_at);
        }
        if late > 0 {
            let _ = app.emit("outbox-catchup", serde_json::json!({ "count": late }));
        }
        if left > 0 {
            let _ = app.emit("outbox-leftover", serde_json::json!({ "count": left }));
        }
    }
}

/// The page is carrying out its part of a quit (REQ-48 b, c): further quit requests start nothing (REQ-48 f).
static QUIT_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The scheduled-messages question is on screen: a second quit request shows it, it does not ask again.
static QUESTION_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The page is asking the person something (a draft that could not be saved): the quit waits for the answer, however long it takes.
static USER_DIALOG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Where the page's answer to `flush-sends` goes: `true` = go on quitting, `false` = the person chose to keep the window open.
static FLUSH_ACK: Mutex<Option<std::sync::mpsc::Sender<bool>>> = Mutex::new(None);
/// How long a quit waits for the page (it holds the sends for at most 20 s itself; this only guards against a page that hangs).
const FLUSH_WAIT: std::time::Duration = std::time::Duration::from_secs(45);

/// Steps (b) to (d) of a quit (REQ-48): the page saves a dirty Compose (and asks when that fails), lets every message still in its
/// "Undo" time go out at once and waits for the sends under way; only then `then` runs (queued actions, install, exit). The Undo timer and
/// the open Compose live in the page, so the backend alone could not do this (QA BUG-M6: a quit during "Sending... Undo" lost the
/// message). `then` is not run when the page answers "no" (the person chose to keep writing) or when a quit is already running.
fn finish_sends_then(app: &tauri::AppHandle, then: impl FnOnce(&tauri::AppHandle) + Send + 'static) {
    if QUIT_BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    USER_DIALOG.store(false, std::sync::atomic::Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    // a page that never loaded has nothing to finish
    let asked = startup::is_ready() && app.get_webview_window("main").is_some();
    if asked {
        *FLUSH_ACK.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
        startup::stage(Some(app), "quit: asking the page to save its draft and send what is waiting");
        let _ = app.emit("flush-sends", ());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let go = after_flush(asked, &rx, FLUSH_WAIT, &USER_DIALOG);
        startup::stage(Some(&app), &format!("quit: the page is done (go on: {go})"));
        if go {
            then(&app);
        }
        QUIT_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

/// Whether the quit goes on: the page's answer when it was asked, `true` when it was not asked or gave no answer within `wait`
/// (the time a dialog to the person is open does not count).
fn after_flush(asked: bool, rx: &std::sync::mpsc::Receiver<bool>, wait: std::time::Duration, dialog: &std::sync::atomic::AtomicBool) -> bool {
    use std::sync::mpsc::RecvTimeoutError;
    if !asked {
        return true;
    }
    let tick = std::time::Duration::from_millis(200);
    let mut waited = std::time::Duration::ZERO;
    loop {
        match rx.recv_timeout(tick) {
            Ok(go) => return go,
            Err(RecvTimeoutError::Disconnected) => return true,
            Err(RecvTimeoutError::Timeout) => {
                if !dialog.load(std::sync::atomic::Ordering::SeqCst) {
                    waited += tick;
                    if waited >= wait {
                        return true;
                    }
                }
            }
        }
    }
}

/// The page has done its part (and saved its draft): `go` false = the person wants to keep the window open.
#[tauri::command]
fn sends_flushed(go: bool) {
    USER_DIALOG.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Some(tx) = FLUSH_ACK.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = tx.send(go);
    }
}

/// The page opened (`true`) or closed (`false`) a dialog that the quit has to wait for.
#[tauri::command]
fn quit_dialog(open: bool) {
    USER_DIALOG.store(open, std::sync::atomic::Ordering::SeqCst);
}

/// The page needs the window in front of the person (a question about unsaved text while the app sat in the tray).
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    shell::show_main(&app);
}

/// Quit (REQ-48): the question about scheduled messages first, when there are any; `Cancel` there changes nothing at all. Otherwise
/// the sequence runs: draft, sends, queued actions, install, exit.
pub(crate) fn request_quit(app: &tauri::AppHandle) {
    // a quit is already running or waiting for its answer: no second sequence, no second question (REQ-48 f)
    if QUIT_BUSY.load(std::sync::atomic::Ordering::SeqCst) || QUESTION_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
        startup::stage(Some(app), "quit: asked again while a quit is running or being asked about: the window is shown");
        shell::show_main(app);
        return;
    }
    let db = app.state::<AppState>().db.clone();
    let (count, next) = outbox_counts(&db);
    if count > 0 {
        startup::stage(Some(app), &format!("quit: {count} scheduled message(s) are waiting: asking the person first"));
        QUESTION_OPEN.store(true, std::sync::atomic::Ordering::SeqCst);
        shell::show_main(app);
        let _ = app.emit("confirm-quit", serde_json::json!({ "count": count, "next": next }));
        return;
    }
    finish_sends_then(app, quit_final);
}

/// Steps (d) and (e): queued archive / delete actions are committed, then the app exits (install on quit runs in `ExitRequested`).
fn quit_final(app: &tauri::AppHandle) {
    flush_pending(app);
    QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/// "Quit anyway" in the scheduled-messages question: the rest of the sequence (draft, sends, queued actions, install).
#[tauri::command]
fn quit_now(app: tauri::AppHandle) {
    QUESTION_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
    finish_sends_then(&app, quit_final);
}

/// "Cancel" / "Keep running in tray" in the question: nothing happens, a later quit asks again.
#[tauri::command]
fn quit_cancelled() {
    QUESTION_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Set right before this app calls `app.exit` itself (the quit guard has run by then).
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// An exit nobody here asked for (the last window closing, `app.exit` from a plugin): the same way as tray "Quit". Always stops this
/// exit; `request_quit` makes it again (with `QUITTING` set) once the page has finished its sends. On macOS Cmd+Q, the app menu's
/// Quit and the Dock's Quit do NOT arrive here (they are `[NSApp terminate:]`, which skips `ExitRequested`): see `shell::mac_app_menu`
/// and `macquit.rs`.
fn guard_exit(app: &tauri::AppHandle) -> bool {
    request_quit(app);
    false
}

/// macOS `applicationShouldTerminate:` (Dock "Quit", a `quit` Apple event, log out, restart, shut down): `true` lets the process end,
/// `false` stops it and starts the quit sequence, which exits through `app.exit(0)` afterwards. `session_end` (log out, restart, shut
/// down; see `sessionend.rs`) is **always** answered "now" (OWNER DECISION A1, REQ-42 b): never a question, never a cancel, whatever
/// the quit sequence is doing; a message in its Undo time goes out at the next start, unsaved Compose text is lost.
#[cfg(target_os = "macos")]
fn terminate_allowed(app: &tauri::AppHandle, session_end: bool) -> bool {
    match sessionend::plan(session_end, QUITTING.load(std::sync::atomic::Ordering::SeqCst)) {
        sessionend::Plan::EndNow => {
            if session_end {
                startup::stage(Some(app), "quit: session end (log out / restart / shut down): the app ends now without questions");
            }
            true
        }
        sessionend::Plan::RunSequence => {
            startup::stage(Some(app), "quit: asked by the system (Dock Quit, ...): the quit sequence runs first");
            request_quit(app);
            false
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
    startup::init_clock();
    // a restart or an installer relaunch starts this process while the previous run's web view processes are still going away: a web
    // view created now would join them and die with them (see webview_health.rs)
    webview_health::wait_for_previous_run();
    let builder = tauri::Builder::default();
    // macOS and Linux notifications (Windows has its own toasts in shell.rs)
    #[cfg(not(windows))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    // macOS: the app menu's Quit item (and Cmd+Q) goes through the quit sequence like the tray's (see shell::mac_app_menu)
    #[cfg(target_os = "macos")]
    let builder = builder.menu(shell::mac_app_menu).on_menu_event(shell::mac_menu_event);
    builder
        // a second launch just brings the running instance forward
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            startup::stage(Some(app), "a second start was handed to this instance: showing the window");
            shell::show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // the data folder of this identifier (data saved under the old names is moved there once, see legacy_names.rs)
            let dir = legacy_names::data_dir(app.handle())?;
            app.manage(legacy_names::DataDir(dir.clone()));
            startup::init_log_dir(dir.clone());
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
            app.manage(update::UpdState::default());
            legacy_names::migrate_keyring(&db, &SECRET_NAMES);
            // (secrets of an old database go to the system credential store, which a test data folder must not touch)
            if !legacy_names::data_dir_overridden() {
                migrate_secrets(&db);
            }
            // settings and rows that still point at an account that no longer exists are removed
            if let Err(e) = db::prune_orphans(&lock(&db)) {
                eprintln!("could not clean up leftovers of removed accounts: {e}");
            }
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
            // macOS: a Dock "Quit" or a log out ends in `[NSApp terminate:]` too, which raises no `ExitRequested`
            #[cfg(target_os = "macos")]
            {
                let quit_app = app.handle().clone();
                let hooked = macquit::install_terminate_hook(Box::new(move |session_end| terminate_allowed(&quit_app, session_end)));
                startup::stage(Some(app.handle()), &format!("macos: applicationShouldTerminate hook: {}", hooked.err().unwrap_or_else(|| "installed".into())));
                // the second sign of a session end (the first is the reason of the quit Apple event, read in the hook)
                let noticed = macquit::observe_power_off();
                startup::stage(Some(app.handle()), &format!("macos: power-off notice (log out / restart / shut down): {}", noticed.err().unwrap_or_else(|| "observed".into())));
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || sync_worker(handle));
            idle::start(app.handle().clone());

            // started by "launch at login" => stay in the tray (only when there is a tray to come back from). The window is shown
            // when its page has reported itself (not here: see startup.rs), and the page is reloaded if it never does.
            let show_at_start = !std::env::args().any(|a| a == "--minimized") || !shell::tray_ready();
            startup::start(app.handle(), show_at_start);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let db = window.app_handle().state::<AppState>().db.clone();
                startup::stage(Some(window.app_handle()), &format!("window close requested (hides to the tray: {})", shell::close_to_tray(&db)));
                if shell::close_to_tray(&db) {
                    api.prevent_close();
                    let _ = window.hide();
                    shell::tray_hint_once(window.app_handle(), &db);
                } else {
                    // closing would quit: the page first finishes its sends and saves what is being written, and scheduled
                    // messages (which wait until the next start) are asked about; the window stays until then
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
            open_external,
            copy_text,
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
            outbox_hold,
            outbox_hold_send,
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
            ai_list_models,
            shell_info,
            update::check_update,
            update::update_download,
            update::update_cancel,
            update::update_discard,
            update::update_defer,
            update::update_note,
            set_mail_available,
            frontend_ready,
            sends_flushed,
            quit_dialog,
            quit_cancelled,
            show_window,
            page_state,
            update::update_install,
            update::update_startup_state,
            update::update_startup_ack,
            update::outbox_busy,
            idle::idle_states
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Dock icon / Finder / Spotlight while the window is hidden
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => shell::show_main(app),
            // the ways out of the app that raise `ExitRequested`: tray Quit, the close button when it quits, `app.exit`, the last window
            // closing. (macOS Cmd+Q, the app menu's Quit and the Dock's Quit do not: shell::mac_app_menu, macquit.rs)
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // not requested by this app (`code` is None, no `QUITTING`): run the quit guard first; a quit the user is asked about installs nothing
                if code.is_none() && !QUITTING.load(std::sync::atomic::Ordering::SeqCst) && !guard_exit(app) {
                    api.prevent_exit();
                    return;
                }
                // from here the exit goes on: the web view's processes ending is no failure
                startup::mark_exiting();
                // a downloaded update the user chose to keep for later is installed now
                update::install_on_exit(app);
            }
            tauri::RunEvent::Exit => {
                // macOS: reached without the quit sequence = a `terminate:` that nobody stopped (the log tells the Mac tester)
                #[cfg(target_os = "macos")]
                if !QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
                    startup::stage(Some(app), "exit: the process ends without the quit sequence (a terminate that was not stopped)");
                }
                startup::mark_exiting();
                idle::shutdown();
                flush_pending(app);
                update::install_on_exit(app);
            }
            _ => {}
        });
}

#[cfg(test)]
mod filter_tests {
    use super::*;

    fn rule(name: &str, field: &str, value: &str, action: &str) -> Rule {
        Rule { id: name.into(), name: name.into(), field: field.into(), op: "contains".into(), value: value.into(), action: action.into(), arg: None, enabled: true, account_id: None }
    }

    fn msg(tid: &str, subject: &str) -> (String, String, String, String) {
        (tid.into(), "peer@example.com".into(), "me@example.com".into(), subject.into())
    }

    /// QA BUG-10 through the real action code (no server needed: the missing folder is found before any connection): an account without
    /// an Archive folder, a new message that a filter wants to archive.
    #[test]
    fn archiving_on_an_account_without_an_archive_folder_fails_clearly_and_leaves_the_message() {
        let db = quit_tests::test_db("no-archive");
        let acc = Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false,
        };
        db::insert_account(&lock(&db), &acc).unwrap();
        db::set_setting(&lock(&db), "fmap:a1", r#"{"inbox":"INBOX","sent":"Sent","trash":"Trash"}"#).unwrap();
        lock(&db)
            .execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES('m1','a1','inbox',1,'t1','QA-M8 hello','n','peer@example.com','','',1,'')",
                [],
            )
            .unwrap();
        let err = action_impl(&db, vec!["t1".into()], "archive".into(), None, Some("inbox".into())).unwrap_err();
        assert_eq!(err, "no 'archive' folder on this account");
        // the message is untouched
        let n: i64 = lock(&db).query_row("SELECT COUNT(*) FROM messages WHERE thread_id='t1' AND folder='inbox'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // the same through the filter code: reported once, not moved, still new mail
        let rules = vec![Rule { id: "r".into(), name: "QA-M8".into(), field: "subject".into(), op: "contains".into(), value: "qa-m8".into(), action: "archive".into(), arg: None, enabled: true, account_id: None }];
        let msgs = vec![("t1".to_string(), "peer@example.com".to_string(), String::new(), "QA-M8 hello".to_string())];
        let out = apply_rules(&rules, &msgs, &mut |r, tid| action_impl(&db, vec![tid.to_string()], r.action.clone(), r.arg.clone(), Some("inbox".into())));
        assert!(out.moved.is_empty());
        assert_eq!(out.errors, vec!["Filter “QA-M8” couldn’t run on new mail: no 'archive' folder on this account".to_string()]);
    }

    /// QA BUG-M8 / BUG-10: a filter whose target folder is missing leaves the message in the Inbox (it still counts as new mail) and says why.
    #[test]
    fn a_filter_that_cannot_run_leaves_the_message_and_reports_once_per_message() {
        let rules = vec![rule("QA-M8", "subject", "qa-m8", "archive")];
        let msgs = vec![msg("t1", "QA-M8 first"), msg("t2", "something else"), msg("t3", "qa-m8 second")];
        let out = apply_rules(&rules, &msgs, &mut |_, _| Err("no 'archive' folder on this account".to_string()));
        assert!(out.moved.is_empty(), "nothing moved, so nothing is hidden from the notifications");
        assert_eq!(out.errors, vec!["Filter “QA-M8” couldn’t run on new mail: no 'archive' folder on this account".to_string(); 2]);
        // a filter without a name
        let out = apply_rules(&[rule("", "subject", "qa", "archive")], &msgs[..1], &mut |_, _| Err("boom".into()));
        assert_eq!(out.errors, vec!["A filter couldn’t run on new mail: boom".to_string()]);
    }

    #[test]
    fn a_filter_that_works_moves_and_one_that_fails_does_not_stop_the_others() {
        let rules = vec![rule("A", "subject", "news", "archive"), rule("B", "subject", "news", "read")];
        let mut calls = vec![];
        let out = apply_rules(&rules, &[msg("t1", "News today")], &mut |r, t| {
            calls.push(format!("{}:{t}", r.name));
            if r.name == "A" { Err("server said no".into()) } else { Ok(()) }
        });
        assert_eq!(calls, ["A:t1", "B:t1"]);
        assert!(out.moved.is_empty(), "B marks read, A failed: the message stays in the Inbox");
        assert_eq!(out.errors.len(), 1);
        let out = apply_rules(&rules[..1], &[msg("t1", "News today")], &mut |_, _| Ok(()));
        assert!(out.moved.contains("t1") && out.errors.is_empty());
    }

    /// The toast comes once per filter and error text per run; the log line is written every time.
    #[test]
    fn rule_errors_are_told_once_per_run() {
        RULE_ERRORS.lock().unwrap().clear();
        RULE_ERRORS_TOLD.lock().unwrap().clear();
        note_rule_error("Filter “X” couldn’t run on new mail: e1".into());
        note_rule_error("Filter “X” couldn’t run on new mail: e1".into());
        let first = take_rule_errors_to_tell();
        assert_eq!(first, vec!["Filter “X” couldn’t run on new mail: e1".to_string()]);
        note_rule_error("Filter “X” couldn’t run on new mail: e1".into());
        assert!(take_rule_errors_to_tell().is_empty(), "already told in this run");
        note_rule_error("Filter “X” couldn’t run on new mail: e2".into());
        assert_eq!(take_rule_errors_to_tell().len(), 1, "another error text is told");
    }
}

#[cfg(test)]
mod quit_tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    #[test]
    fn the_quit_waits_for_the_page_and_respects_its_answer() {
        let (tx, rx) = channel::<bool>();
        // not asked (the page never loaded): go on at once
        let no_dialog = std::sync::atomic::AtomicBool::new(false);
        assert!(after_flush(false, &rx, Duration::from_secs(5), &no_dialog));
        // the page says "done": go on; "keep the window": stop
        tx.send(true).unwrap();
        assert!(after_flush(true, &rx, Duration::from_secs(5), &no_dialog));
        tx.send(false).unwrap();
        assert!(!after_flush(true, &rx, Duration::from_secs(5), &no_dialog));
        // no answer in time (a page that hangs): go on, the app must not stay alive for ever
        let t0 = std::time::Instant::now();
        assert!(after_flush(true, &rx, Duration::from_millis(150), &no_dialog));
        assert!(t0.elapsed() < Duration::from_secs(3));
        // a dialog to the person is open: the time limit does not run, the answer decides however late it comes
        let (tx3, rx3) = channel::<bool>();
        let open = std::sync::atomic::AtomicBool::new(true);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(900));
            tx3.send(false).unwrap();
        });
        assert!(!after_flush(true, &rx3, Duration::from_millis(200), &open), "a quit does not run away from an open question");
        // the answer travels through the command
        let (tx2, rx2) = channel::<bool>();
        *FLUSH_ACK.lock().unwrap() = Some(tx2);
        sends_flushed(false);
        assert_eq!(rx2.recv_timeout(Duration::from_secs(1)), Ok(false));
        assert!(FLUSH_ACK.lock().unwrap().is_none(), "one answer per question");
        sends_flushed(true); // an answer nobody waits for does nothing
    }

    pub(super) fn test_db(tag: &str) -> Db {
        let dir = crate::shard::tests::temp_dir(tag);
        Arc::new(Mutex::new(db::open(&dir.join("heylook.db")).unwrap()))
    }

    fn put_row(db: &Db, id: &str, status: &str, undo: i64, send_at: i64) {
        lock(db)
            .execute(
                "INSERT INTO outbox(id,account_id,payload,send_at,status,created_at,undo) VALUES(?1,'a','{}',?2,?3,?4,?5)",
                params![id, send_at, status, now(), undo],
            )
            .unwrap();
    }

    fn row(db: &Db, id: &str) -> (String, i64) {
        lock(db).query_row("SELECT status, undo FROM outbox WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    }

    /// REQ-49: a message in its Undo time is in the outbox but is not a scheduled message (not counted by the quit question), and an
    /// earlier run's rows are picked up at the next start like a scheduled message that came due while the app was closed.
    #[test]
    fn undo_window_rows_are_not_scheduled_messages_and_survive_a_restart() {
        let db = test_db("undo-rows");
        put_row(&db, "u1", "undo", 1, now() + 20);
        assert_eq!(outbox_counts(&db).0, 0, "an Undo-window row is not counted by the scheduled-messages question");
        put_row(&db, "s1", "pending", 0, now() + 3600);
        assert_eq!(outbox_counts(&db).0, 1);

        // next start, default setting (send as soon as it opens): the row is queued, flagged as left behind
        outbox_startup(&db);
        assert_eq!(row(&db, "u1"), ("pending".to_string(), 2));
        assert_eq!(row(&db, "s1"), ("pending".to_string(), 0));

        // a row that was being delivered when the process ended is queued again as well
        put_row(&db, "u2", "sending", 1, now() - 5);
        outbox_startup(&db);
        assert_eq!(row(&db, "u2"), ("pending".to_string(), 2));

        // "Ask me first" and more than 60 s ago: an ordinary Overdue row of the Scheduled list
        db::set_setting(&lock(&db), "scheduled_catchup", "ask").unwrap();
        put_row(&db, "u3", "undo", 1, now() - 600);
        put_row(&db, "u4", "undo", 1, now() - 10);
        outbox_startup(&db);
        assert_eq!(row(&db, "u3"), ("overdue".to_string(), 0));
        assert_eq!(row(&db, "u4"), ("pending".to_string(), 2), "within 60 s it still goes out");
    }

    #[test]
    fn a_failed_undo_window_send_leaves_the_outbox_or_stays_for_the_next_start() {
        let db = test_db("undo-fail");
        put_row(&db, "k", "sending", 1, now());
        finish_failed_hold(&db, "k", "{}", "connection reset", true);
        assert_eq!(row(&db, "k"), ("pending".to_string(), 2), "quitting: kept for the next start");
        put_row(&db, "r", "sending", 1, now());
        finish_failed_hold(&db, "r", "{}", "connection reset", false);
        let gone: i64 = lock(&db).query_row("SELECT COUNT(*) FROM outbox WHERE id='r'", [], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0, "running: the row leaves and Compose reopens");
    }

    /// QA BUG-M4 / M8: a folder the server lacks is named in the error; one it has is used.
    #[test]
    fn a_missing_folder_is_named_in_the_error() {
        let db = test_db("folders");
        let acc = Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false,
        };
        db::set_setting(&lock(&db), "fmap:a1", r#"{"inbox":"INBOX","drafts":"Entwürfe"}"#).unwrap();
        assert_eq!(folder_for(&db, &acc, "drafts").unwrap(), "Entwürfe");
        assert_eq!(folder_for(&db, &acc, "archive").unwrap_err(), "no 'archive' folder on this account");
        let acc2 = Account { id: "a2".into(), ..acc };
        assert_eq!(folder_for(&db, &acc2, "drafts").unwrap_err(), "this account has no Drafts folder");
    }

    /// QA BUG-M6: every way out of the app has to pass the flush. The window can no longer be reached once it is destroyed, so the
    /// close button must stop the close and go through `request_quit`, and an exit nobody here asked for is stopped and redone.
    #[test]
    fn every_way_out_goes_through_the_flush() {
        let src = include_str!("lib.rs");
        let close = &src[src.find("tauri::WindowEvent::CloseRequested").expect("close handler")..];
        let close = &close[..close.find(".invoke_handler").expect("end of handler")];
        assert!(close.contains("api.prevent_close();
                    request_quit("), "closing that quits must go through request_quit: {close}");
        let guard = &src[src.find("fn guard_exit").expect("guard_exit")..];
        let guard = &guard[..guard.find("
}
").unwrap()];
        assert!(guard.contains("request_quit(app)") && guard.contains("false"), "{guard}");
        assert!(src.contains("finish_sends_then(app, quit_final)") && src.contains("finish_sends_then(&app, quit_final)"));
        // the question comes before anything is flushed, sent or saved (REQ-48 a): `Cancel` changes nothing
        let rq = &src[src.find("pub(crate) fn request_quit").expect("request_quit")..];
        let rq = &rq[..rq.find("\n}\n").unwrap()];
        assert!(rq.find("confirm-quit").unwrap() < rq.find("finish_sends_then").unwrap(), "{rq}");
        // the tray's Quit item
        assert!(include_str!("shell.rs").contains("\"quit\" => crate::request_quit(app)"));
        // the quit that follows the page's answer is not asked again
        let last = &src[src.find("fn quit_final").expect("quit_final")..];
        let last = &last[..last.find("\n}\n").unwrap()];
        assert!(last.contains("flush_pending") && last.contains("QUITTING.store(true") && last.contains("app.exit(0)"), "{last}");
    }

    /// QA Mac round 2 (Q3 Cmd+Q, Q4 app menu Quit): on macOS the predefined Quit item, Cmd+Q and the Dock's Quit are `[NSApp terminate:]`,
    /// which tao turns into `RunEvent::Exit` without an `ExitRequested`, so the flush never ran and a message in its Undo time was
    /// sent only after the next start. The macOS routes have to be taken over explicitly; this reads the sources (the macOS code
    /// cannot be compiled on every machine that runs the tests).
    #[test]
    fn the_macos_quit_routes_go_through_the_flush() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        // (not this test's own text)
        let lib = &lib[..lib.find("#[cfg(test)]").unwrap()];
        let shell = include_str!("shell.rs").replace("\r\n", "\n");
        let mac = include_str!("macquit.rs").replace("\r\n", "\n");
        // (1) the app menu's Quit (and Cmd+Q) is our own item: no predefined Quit item is ever put into a menu we build
        assert!(!lib.contains("PredefinedMenuItem::quit") && !shell.contains("PredefinedMenuItem::quit"), "a predefined Quit item skips the flush on macOS");
        assert!(lib.contains("builder.menu(shell::mac_app_menu).on_menu_event(shell::mac_menu_event)"), "the macOS menu is not installed");
        let at = lib.find("let builder = builder.menu(shell::mac_app_menu)").unwrap();
        assert!(lib[..at].trim_end().ends_with("#[cfg(target_os = \"macos\")]"), "the macOS menu is for macOS only");
        let item = &shell[shell.find("fn replace_quit_item").unwrap()..];
        let item = &item[..item.find("\n}\n").unwrap()];
        assert!(item.contains("app_menu.remove(quit)") && item.contains("MAC_QUIT_ID") && item.contains("\"CmdOrCtrl+Q\""), "{item}");
        let event = &shell[shell.find("pub fn mac_menu_event").unwrap()..];
        let event = &event[..event.find("\n}\n").unwrap()];
        assert!(event.contains("MAC_QUIT_ID") && event.contains("crate::request_quit(app)"), "{event}");
        // the tray's item has another id, so the one global menu listener never starts a second quit for it
        assert!(shell.contains("\"quit\" => crate::request_quit(app)") && shell.contains("pub const MAC_QUIT_ID: &str = \"app-quit\""));
        // (2) a terminate that does not come from the menu (Dock "Quit", log out) is stopped and redone through the sequence
        assert!(mac.contains("applicationShouldTerminate:") && mac.contains("class_addMethod") && mac.contains("TERMINATE_CANCEL"), "no terminate hook");
        assert!(
            lib.contains("macquit::install_terminate_hook(Box::new(move |session_end| terminate_allowed(&quit_app, session_end)))"),
            "the hook is never installed"
        );
        let allowed = &lib[lib.find("fn terminate_allowed").unwrap()..];
        let allowed = &allowed[..allowed.find("\n}\n").unwrap()];
        // the decision is `sessionend::plan(session_end, quitting)`: a session end ends now (tested in sessionend.rs), everything else
        // is stopped and started through request_quit
        assert!(
            allowed.contains("sessionend::plan(session_end, QUITTING.load") && allowed.contains("sessionend::Plan::EndNow") && allowed.contains("sessionend::Plan::RunSequence"),
            "{allowed}"
        );
        let (end_now, run) = (allowed.find("Plan::EndNow =>").unwrap(), allowed.find("Plan::RunSequence =>").unwrap());
        assert!(end_now < run && !allowed[end_now..run].contains("request_quit") && allowed[end_now..run].contains("true"), "the EndNow arm only ends: {allowed}");
        assert!(allowed[run..].contains("request_quit(app)") && allowed[run..].trim_end().ends_with("false\n        }\n    }"), "an unfinished quit is stopped and started through request_quit: {allowed}");
        assert!(allowed.contains("quit: session end (log out / restart / shut down): the app ends now without questions"));
        // (2b) a session end (log out, restart, shut down) is never cancelled or held (OWNER DECISION A1, REQ-42 b r3.6): the hook reads
        // it first and by itself, and no path of the hook answers "cancel" for it
        let hook = &mac[mac.find("extern \"C-unwind\" fn should_terminate").unwrap()..];
        let hook = &hook[..hook.find("\n}\n").unwrap()];
        assert!(hook.find("is_session_end_now()").unwrap() < hook.find("DECIDE.get()").unwrap(), "{hook}");
        assert!(hook.contains("decide(session_end)") && hook.contains("if go || session_end { TERMINATE_NOW } else { TERMINATE_CANCEL }"), "{hook}");
        assert!(mac.contains("sessionend::QUIT_REASON_KEY") && mac.contains("NSWorkspaceWillPowerOffNotification") && mac.contains("power_off_recently_seen()"));
        assert!(lib.contains("macquit::observe_power_off()"), "the power-off notice is never observed");
        // (3) a terminate that slipped through anyway is at least written down
        let exit = &lib[lib.find("tauri::RunEvent::Exit =>").unwrap()..];
        assert!(exit[..300].contains("without the quit sequence"), "{}", &exit[..300]);
    }

    /// Every place that ends the process or restarts it, outside of tests: a new one fails here until it is looked at (does the page
    /// save its draft and send what waits first? the quit sequence is `request_quit` -> `quit_final`). Known and justified:
    /// - lib.rs `quit_final`: the end of the quit sequence itself.
    /// - update.rs `update_install`: the page saved the draft and waited for the sends before it asked for the install (REQ-27 / 28).
    /// - startup.rs: the restart for a dead web view (the page is gone, there is nothing to ask; Undo-window messages are in the outbox).
    #[test]
    fn every_place_that_ends_the_process_is_known() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found: Vec<(String, usize, usize)> = vec![];
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            // the part that is not tests
            let code = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
            let code: String = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            let exits = code.matches(".exit(").count() + code.matches("process::exit(").count() + code.matches("libc::_exit(").count();
            let restarts = code.matches(".restart()").count();
            if exits + restarts > 0 {
                found.push((path.file_name().unwrap().to_string_lossy().into_owned(), exits, restarts));
            }
        }
        found.sort();
        assert_eq!(
            found,
            vec![("lib.rs".to_string(), 1, 0), ("startup.rs".to_string(), 0, 1), ("update.rs".to_string(), 1, 1)],
            "a way to end or restart the process was added or removed: make sure it goes through the quit sequence (request_quit) or is justified in the comment above"
        );
    }

    /// The macOS menu wiring type-checks on every platform (the calls themselves are `cfg(target_os = "macos")`).
    #[allow(dead_code)]
    fn macos_menu_wiring_type_checks() -> tauri::Builder<tauri::Wry> {
        tauri::Builder::<tauri::Wry>::default().menu(shell::mac_app_menu).on_menu_event(shell::mac_menu_event)
    }
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

    #[test]
    fn searching_inside_trash_or_junk_finds_its_mail() {
        let c = db::test_conn(&["a1"]);
        let put = |id: &str, folder: &str, uid: i64, thread: &str| {
            c.execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,'a1',?2,?3,?4,'token invoice','x','x@y.z','','',?3,'')",
                params![id, folder, uid, thread],
            )
            .unwrap();
        };
        put("m1", "inbox", 1, "t-inbox");
        put("m2", "trash", 2, "t-trash");
        put("m3", "junk", 3, "t-junk");
        let run = |folder: &str, search: &str, scope: Option<&str>| -> Vec<String> {
            let f: ThreadFilter = serde_json::from_value(serde_json::json!({
                "accountId": "a1", "folder": folder, "search": search, "scope": scope
            }))
            .unwrap();
            let mut v: Vec<String> = threads_for(&c, f).unwrap().into_iter().map(|t| format!("{}:{}", t.thread_id, t.folder)).collect();
            v.sort();
            v
        };
        // current scope inside Trash / Junk
        assert_eq!(run("trash", "token", Some("current")), vec!["t-trash:trash"]);
        assert_eq!(run("junk", "token", None), vec!["t-junk:junk"]);
        assert_eq!(run("trash", "", Some("current")), vec!["t-trash:trash"]);
        // current scope in the inbox does not leak trash/junk
        assert_eq!(run("inbox", "token", Some("current")), vec!["t-inbox:inbox"]);
        // whole mailbox / every account: trash and junk stay out
        assert_eq!(run("inbox", "token", Some("account")), vec!["t-inbox:inbox"]);
        assert_eq!(run("trash", "token", Some("all")), vec!["t-inbox:inbox"]);
        assert_eq!(run("all", "token", Some("current")), vec!["t-inbox:inbox"]);
        // explicit folder operators find them from anywhere, and report their folder
        assert_eq!(run("inbox", "token folder:trash", Some("account")), vec!["t-trash:trash"]);
        assert_eq!(run("inbox", "token in:junk", Some("all")), vec!["t-junk:junk"]);
        assert_eq!(run("inbox", "token folder:spam", Some("current")), vec!["t-junk:junk"]);
        assert_eq!(run("inbox", "token folder:bin", Some("current")), vec!["t-trash:trash"]);
    }
}

#[cfg(test)]
mod backfill_tests {
    use super::*;

    const ACC: &str = "11111111-2222-4333-8444-555555555555";
    const CAP: u32 = MAX_DOWNLOAD_DEFAULT;

    fn db_with(rows: &[(&str, u32)]) -> Db {
        let c = db::test_conn(&[ACC]);
        db::set_setting(&c, &format!("fmap:{ACC}"), r#"{"inbox":"INBOX","sent":"Sent","f:Work":"Work"}"#).unwrap();
        for (folder, uid) in rows {
            c.execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,?3,?4,'t','s','n','e','','',?4,'')",
                params![format!("{folder}:{uid}"), ACC, folder, uid],
            )
            .unwrap();
        }
        Arc::new(Mutex::new(c))
    }

    #[test]
    fn targets_are_500_for_the_inbox_and_100_elsewhere() {
        assert_eq!((backfill_target("inbox"), backfill_target("sent"), backfill_target("f:Work")), (500, 100, 100));
    }

    #[test]
    fn the_next_folder_to_download_is_chosen_from_what_is_stored() {
        let none = Default::default();
        // nothing stored: the first sync comes first
        assert!(next_backfill(&db_with(&[]), ACC, &none, CAP).is_none());
        // some inbox mail, older mail may exist
        let db = db_with(&[("inbox", 900), ("inbox", 901), ("sent", 5)]);
        assert_eq!(next_backfill(&db, ACC, &none, CAP), Some(("inbox".into(), "INBOX".into(), 2, 500)));
        // the inbox is complete: on to the next folder in sync order
        db::set_setting(&lock(&db), &exhausted_key(ACC, "inbox"), "1").unwrap();
        assert!(is_exhausted(&db, ACC, "inbox") && !is_exhausted(&db, ACC, "sent"));
        assert_eq!(next_backfill(&db, ACC, &none, CAP), Some(("sent".into(), "Sent".into(), 1, 100)));
        // a folder given up on during this run is skipped
        let skip = ["sent".to_string()].into_iter().collect();
        assert_eq!(next_backfill(&db, ACC, &skip, CAP), None);
        // a folder whose lowest stored uid is 1 has nothing below it
        assert_eq!(next_backfill(&db_with(&[("inbox", 1), ("inbox", 2)]), ACC, &none, CAP), None);
        // a folder that holds its target is done
        let full: Vec<(&str, u32)> = (1..=500).map(|u| ("inbox", u + 5)).collect();
        assert_eq!(next_backfill(&db_with(&full), ACC, &none, CAP), None);
        // 499 stored: one more chunk (of one message) is needed
        let almost: Vec<(&str, u32)> = (1..=499).map(|u| ("inbox", u + 5)).collect();
        assert_eq!(next_backfill(&db_with(&almost), ACC, &none, CAP).map(|t| (t.2, t.3)), Some((499, 500)));
    }

    #[test]
    fn the_cap_text_is_parsed_with_a_default_and_clamped() {
        assert_eq!(parse_max_download(None), 2000);
        for bad in ["", "  ", "abc", "NaN", "inf", "2k"] {
            assert_eq!(parse_max_download(Some(bad)), 2000, "{bad:?}");
        }
        assert_eq!(parse_max_download(Some("500")), 500);
        assert_eq!(parse_max_download(Some(" 1000 ")), 1000);
        assert_eq!(parse_max_download(Some("5000")), 5000);
        assert_eq!(parse_max_download(Some("2000.9")), 2000);
        // out of range: clamped, a stored value above the maximum counts as the maximum
        assert_eq!(parse_max_download(Some("5001")), 5000);
        assert_eq!(parse_max_download(Some("20000")), 5000);
        assert_eq!(parse_max_download(Some("99")), 100);
        assert_eq!(parse_max_download(Some("0")), 100);
        assert_eq!(parse_max_download(Some("-5")), 100);
        // the stored setting is what max_download() reads, every time
        let db = db_with(&[]);
        assert_eq!(max_download(&db), 2000);
        db::set_setting(&lock(&db), "max_download", "500").unwrap();
        assert_eq!(max_download(&db), 500);
        db::set_setting(&lock(&db), "max_download", "9999").unwrap();
        assert_eq!(max_download(&db), 5000);
        db::set_setting(&lock(&db), "max_download", "x").unwrap();
        assert_eq!(max_download(&db), 2000);
    }

    #[test]
    fn a_chunk_is_clamped_to_what_is_left_of_the_cap() {
        assert_eq!(clamp_chunk(50, 0, 2000), 50);
        assert_eq!(clamp_chunk(50, 1950, 2000), 50);
        assert_eq!(clamp_chunk(50, 1951, 2000), 49);
        assert_eq!(clamp_chunk(50, 1999, 2000), 1);
        assert_eq!(clamp_chunk(50, 2000, 2000), 0);
        // already over the cap (it was lowered): nothing, no underflow
        assert_eq!(clamp_chunk(50, 3000, 2000), 0);
        assert_eq!(clamp_chunk(0, 0, 2000), 0);
    }

    #[test]
    fn the_background_download_stops_at_the_cap_of_the_whole_account() {
        let none = Default::default();
        let rows = |inbox: u32, sent: u32| -> Vec<(&'static str, u32)> {
            (0..inbox).map(|u| ("inbox", u + 5)).chain((0..sent).map(|u| ("sent", u + 5))).collect()
        };
        // inbox target = min(500, cap)
        let db = db_with(&rows(10, 0));
        assert_eq!(next_backfill(&db, ACC, &none, 300).map(|t| t.3), Some(300));
        assert_eq!(next_backfill(&db, ACC, &none, 5000).map(|t| t.3), Some(500));
        // the other folders' mail counts: 450 stored in total, 500 allowed, so the inbox may grow by 50 only
        let db = db_with(&rows(300, 150));
        assert_eq!(next_backfill(&db, ACC, &none, 500).map(|t| (t.2, t.3)), Some((300, 350)));
        // the cap is reached: nothing more to download in any folder
        assert_eq!(next_backfill(&db_with(&rows(300, 200)), ACC, &none, 500), None);
        // lowered below what is stored: nothing is downloaded (and nothing is deleted)
        let db = db_with(&rows(300, 200));
        assert_eq!(next_backfill(&db, ACC, &none, 100), None);
        assert_eq!(account_total(&db, ACC).unwrap(), 500);
        // raised again: downloading continues
        assert!(next_backfill(&db, ACC, &none, 2000).is_some());
        // other folders: 100 each, never beyond the cap
        let db = db_with(&rows(0, 5));
        assert_eq!(next_backfill(&db, ACC, &none, 5000).map(|t| t.3), Some(100));
        assert_eq!(next_backfill(&db, ACC, &none, 100).map(|t| t.3), Some(100));
        assert_eq!(next_backfill(&db_with(&rows(0, 100)), ACC, &none, 100), None);
    }

    #[test]
    fn load_older_at_the_cap_answers_limited_without_any_network_call() {
        let db = db_with(&(0..100).map(|u| ("inbox", u + 5)).collect::<Vec<_>>());
        db::set_setting(&lock(&db), "max_download", "100").unwrap();
        // there is no mail server (or password) in this test: reaching the network would be an error, not Ok
        let r = load_older_impl(&db, ACC, "inbox", 50).unwrap();
        assert_eq!((r.added, r.exhausted, r.limited), (0, false, true));
        // below the cap the request goes on towards the server (and fails here, there is none)
        db::set_setting(&lock(&db), "max_download", "101").unwrap();
        assert!(load_older_impl(&db, ACC, "inbox", 50).is_err());
        // a folder the server has nothing older for stays "exhausted", not "limited"
        db::set_setting(&lock(&db), &exhausted_key(ACC, "inbox"), "1").unwrap();
        db::set_setting(&lock(&db), "max_download", "100").unwrap();
        let r = load_older_impl(&db, ACC, "inbox", 50).unwrap();
        assert_eq!((r.added, r.exhausted, r.limited), (0, true, false));
    }

    /// One stored message with everything the pruning looks at.
    fn put(db: &Db, folder: &str, uid: u32, date: i64, thread: &str, flagged: bool) -> String {
        let id = format!("{ACC}:{folder}:{uid}");
        lock(db)
            .execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,flagged) VALUES(?1,?2,?3,?4,?5,'s','n','e','','',?6,'',?7)",
                params![id, ACC, folder, uid, thread, date, flagged as i64],
            )
            .unwrap();
        id
    }

    fn have(db: &Db, id: &str) -> bool {
        lock(db).query_row("SELECT COUNT(*) FROM messages WHERE id=?1", [id], |r| r.get::<_, u32>(0)).unwrap() == 1
    }

    fn none() -> std::collections::HashSet<String> {
        Default::default()
    }

    #[test]
    fn pruning_keeps_the_newest_messages_across_all_folders() {
        let db = db_with(&[]);
        for u in 1..=120 {
            put(&db, "inbox", u, 1000 + u as i64, &format!("t{u}"), false);
        }
        for u in 1..=30 {
            put(&db, "sent", u, 100 + u as i64, &format!("s{u}"), false); // old mail of another folder goes first
        }
        assert_eq!(prune_oldest(&db, ACC, 100, &none()).unwrap(), 50);
        assert_eq!(account_total(&db, ACC).unwrap(), 100);
        // the 29 oldest of Sent (its newest stays) and the 21 oldest of the Inbox
        assert_eq!(folder_state(&db, ACC, "sent").unwrap(), (1, 30));
        assert_eq!(folder_state(&db, ACC, "inbox").unwrap(), (99, 22));
        // the old mail is gone for good, the newest is untouched: a second pass has nothing to do
        assert_eq!(prune_oldest(&db, ACC, 100, &none()).unwrap(), 0);
        assert_eq!(account_total(&db, ACC).unwrap(), 100);
        // under the cap: nothing happens
        assert_eq!(prune_oldest(&db, ACC, 5000, &none()).unwrap(), 0);
        assert_eq!(account_total(&db, ACC).unwrap(), 100);
    }

    #[test]
    fn lowering_the_cap_is_trimmed_in_one_go_by_the_next_arrival() {
        let db = db_with(&[]);
        for u in 1..=300 {
            put(&db, "inbox", u, u as i64, &format!("t{u}"), false);
        }
        db::set_setting(&lock(&db), "max_download", "100").unwrap();
        // changing the setting alone deletes nothing
        assert_eq!(account_total(&db, ACC).unwrap(), 300);
        assert_eq!(prune_oldest(&db, ACC, max_download(&db), &none()).unwrap(), 200);
        assert_eq!(folder_state(&db, ACC, "inbox").unwrap(), (100, 201));
    }

    #[test]
    fn pruning_never_deletes_protected_or_just_stored_mail() {
        let db = db_with(&[]);
        for u in 1..=130 {
            put(&db, "inbox", u, 1000 + u as i64, &format!("t{u}"), false);
        }
        // every kind of protected mail is older than all the rest
        let drafts: Vec<String> = (1..=5).map(|u| put(&db, "drafts", u, 1, "d", false)).collect();
        let flagged = put(&db, "inbox", 200, 2, "tf", true);
        let pinned = put(&db, "inbox", 201, 3, "tp", false);
        let snoozed = put(&db, "inbox", 202, 4, "ts", false);
        lock(&db).execute("INSERT INTO thread_meta(thread_id,pinned) VALUES('tp',1)", []).unwrap();
        lock(&db).execute("INSERT INTO thread_meta(thread_id,snoozed_until) VALUES('ts',99999999999)", []).unwrap();
        let fresh = put(&db, "f:Work", 5, 5, "w1", false);
        let newest_of_folder = put(&db, "f:Work", 9, 6, "w2", false);
        let doomed = put(&db, "f:Work", 6, 7, "w3", false); // old, unprotected: goes first
        let keep: std::collections::HashSet<String> = [fresh.clone()].into_iter().collect();
        let total = account_total(&db, ACC).unwrap();
        assert_eq!(total, 130 + 5 + 3 + 3);
        assert_eq!(prune_oldest(&db, ACC, 100, &keep).unwrap(), total - 100);
        assert_eq!(account_total(&db, ACC).unwrap(), 100);
        for id in drafts.iter().chain([&flagged, &pinned, &snoozed, &fresh, &newest_of_folder]) {
            assert!(have(&db, id), "{id} must stay");
        }
        assert!(!have(&db, &doomed));
        // the oldest unprotected inbox mail went, the newer did not
        assert!(!have(&db, &format!("{ACC}:inbox:1")));
        assert!(have(&db, &format!("{ACC}:inbox:130")));
    }

    #[test]
    fn protected_mail_alone_above_the_cap_is_not_an_error() {
        let db = db_with(&[]);
        for u in 1..=120 {
            put(&db, "drafts", u, u as i64, "d", false);
        }
        put(&db, "inbox", 1, 1, "t1", false); // the newest of its folder: stays
        assert_eq!(prune_oldest(&db, ACC, 100, &none()).unwrap(), 0);
        assert_eq!(account_total(&db, ACC).unwrap(), 121);
        // some can go, the rest stays above the cap
        for u in 2..=11 {
            put(&db, "inbox", u, 1000 + u as i64, "t", false);
        }
        assert_eq!(prune_oldest(&db, ACC, 100, &none()).unwrap(), 10);
        assert_eq!(folder_state(&db, ACC, "drafts").unwrap().0, 120);
    }

    #[test]
    fn just_stored_mail_survives_even_when_it_is_the_oldest() {
        let db = db_with(&[]);
        let mut keep = std::collections::HashSet::new();
        for u in 1..=105 {
            let id = put(&db, "inbox", u, u as i64, &format!("t{u}"), false);
            if u <= 3 {
                keep.insert(id); // dated before everything else
            }
        }
        assert_eq!(prune_oldest(&db, ACC, 100, &keep).unwrap(), 5);
        for u in 1..=3 {
            assert!(have(&db, &format!("{ACC}:inbox:{u}")));
        }
        assert!(!have(&db, &format!("{ACC}:inbox:4")) && !have(&db, &format!("{ACC}:inbox:8")));
        assert!(have(&db, &format!("{ACC}:inbox:9")));
    }

    #[test]
    fn a_folder_that_lost_mail_is_no_longer_marked_as_downloaded_to_the_end() {
        let db = db_with(&[]);
        for u in 1..=110 {
            put(&db, "inbox", u, 1000 + u as i64, &format!("t{u}"), false);
        }
        for u in 1..=3 {
            put(&db, "sent", u, 500 + u as i64, &format!("s{u}"), false);
        }
        for role in ["inbox", "sent", "archive"] {
            db::set_setting(&lock(&db), &exhausted_key(ACC, role), "1").unwrap();
        }
        // another account's mark is not ours to touch
        db::set_setting(&lock(&db), "exhausted:other:inbox", "1").unwrap();
        // 113 stored, 100 allowed: Sent loses 2 (its newest stays) and the Inbox 11
        assert_eq!(prune_oldest(&db, ACC, 100, &none()).unwrap(), 13);
        assert!(!is_exhausted(&db, ACC, "inbox") && !is_exhausted(&db, ACC, "sent"));
        assert!(is_exhausted(&db, ACC, "archive"), "a folder that lost nothing keeps its mark");
        assert!(db::get_setting(&lock(&db), "exhausted:other:inbox").is_some());
    }

    #[test]
    fn a_page_is_stored_or_nothing_is() {
        let db = db_with(&[]);
        let acc = db::Account {
            id: ACC.into(), email: "a@b.c".into(), display_name: "N".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false,
        };
        let msg = |uid: u32| mail::parse(uid, format!("From: x@y.z
Subject: m{uid}
Message-ID: <{uid}@t>

body {uid}
").as_bytes(), false, false, 0).unwrap();
        store_page(&db, &acc, "inbox", &[msg(7), msg(8)]).unwrap();
        assert_eq!(folder_state(&db, ACC, "inbox").unwrap(), (2, 7));
        // storing again is idempotent (a chunk fetched twice by the sync and the UI)
        store_page(&db, &acc, "inbox", &[msg(8), msg(6)]).unwrap();
        assert_eq!(folder_state(&db, ACC, "inbox").unwrap(), (3, 6));
        // no transaction is left open afterwards
        assert!(lock(&db).execute_batch("BEGIN; COMMIT").is_ok());
    }
}

#[cfg(test)]
mod signed_flag_tests {
    use super::*;

    fn filter() -> ThreadFilter {
        serde_json::from_str(r#"{"folder":"inbox"}"#).unwrap()
    }

    fn put(c: &Connection, uid: i64, thread: &str, pgp: i64) {
        c.execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,pgp) VALUES(?1,'a1','inbox',?2,?3,'s','x','x@y.z','','',?2,'',?4)",
            params![format!("m{uid}"), uid, thread, pgp],
        )
        .unwrap();
    }

    fn sig() -> pgpmail::Security {
        pgpmail::Security {
            encrypted: true,
            decryption: "ok".into(),
            signature: Some(pgpmail::SigInfo {
                status: "valid".into(),
                signer: None,
                fingerprint: None,
                key_id: "AB".into(),
                signed_at: None,
                verified: true,
                matches_from: true,
                inline: false,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn encrypted_and_signed_thread_is_flagged_signed_once_opened() {
        let c = db::test_conn(&["a1"]);
        put(&c, 1, "t-enc", pgpmail::FLAG_ENCRYPTED as i64); // encrypted + signed inside (unknown until opened)
        put(&c, 2, "t-plain-enc", pgpmail::FLAG_ENCRYPTED as i64); // encrypted, no signature
        put(&c, 3, "t-signed", pgpmail::FLAG_SIGNED as i64);
        let by = |c: &Connection| -> HashMap<String, (bool, bool)> { threads_for(c, filter()).unwrap().into_iter().map(|t| (t.thread_id, (t.encrypted, t.signed))).collect() };
        let before = by(&c);
        assert_eq!(before["t-enc"], (true, false));
        assert_eq!(before["t-signed"], (false, true));
        // opening the first message finds the signature; the second has none
        note_signed(&c, "m1", &sig());
        note_signed(&c, "m2", &pgpmail::Security { encrypted: true, decryption: "ok".into(), ..Default::default() });
        let after = by(&c);
        assert_eq!(after["t-enc"], (true, true), "the list shows both marks");
        assert_eq!(after["t-plain-enc"], (true, false));
        // idempotent, and the encrypted bit stays
        note_signed(&c, "m1", &sig());
        let bits: i64 = c.query_row("SELECT pgp FROM messages WHERE id='m1'", [], |r| r.get(0)).unwrap();
        assert_eq!(bits, 3);
    }

    #[test]
    fn confidential_mail_is_refused_for_actions_that_leave_the_app() {
        let c = db::test_conn(&["a1"]);
        put(&c, 1, "t1", 0);
        put(&c, 2, "t2", pgpmail::FLAG_CONFIDENTIAL as i64);
        put(&c, 3, "t3", (pgpmail::FLAG_CONFIDENTIAL | pgpmail::FLAG_ENCRYPTED) as i64); // bits are OR-ed
        put(&c, 4, "t4", (pgpmail::FLAG_ENCRYPTED | pgpmail::FLAG_SIGNED) as i64);
        assert!(ensure_not_confidential(&c, "m1").is_ok());
        assert!(ensure_not_confidential(&c, "m4").is_ok());
        assert!(ensure_not_confidential(&c, "nope").is_ok(), "an unknown id fails later, with its own error");
        for id in ["m2", "m3"] {
            assert_eq!(ensure_not_confidential(&c, id).unwrap_err(), "This message is confidential, so that isn’t allowed.");
        }
    }
}

#[cfg(test)]
mod download_dir_tests {
    use super::*;

    #[test]
    fn a_missing_download_folder_falls_back_and_says_so() {
        let sys = std::env::temp_dir().join("hl-system-downloads");
        let ok = std::env::temp_dir();
        // not set, or blank: the system folder, nothing to report
        assert_eq!(resolve_download_dir(None, sys.clone()), (sys.clone(), None));
        assert_eq!(resolve_download_dir(Some("  "), sys.clone()), (sys.clone(), None));
        // an existing folder is used as written
        assert_eq!(resolve_download_dir(Some(ok.to_str().unwrap()), sys.clone()), (ok.clone(), None));
        // a folder that is gone (or a file) falls back and reports the configured path
        let gone = ok.join("hl-folder-that-does-not-exist-9f2c");
        let (dir, note) = resolve_download_dir(Some(gone.to_str().unwrap()), sys.clone());
        assert_eq!(dir, sys);
        assert_eq!(note.as_deref(), gone.to_str());
        let file = ok.join("hl-a-file-not-a-folder.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(resolve_download_dir(file.to_str(), sys.clone()).1.is_some());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn the_notice_is_given_once_per_folder() {
        let seen = Mutex::new(Vec::new());
        assert!(first_time_for(&seen, "C:/Gone"));
        assert!(!first_time_for(&seen, "C:/Gone"));
        assert!(first_time_for(&seen, "D:/Other"));
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn keyring_failures_are_explained_per_os() {
        let l = keyring_error_text("linux", "save", "boom");
        assert!(l.starts_with("Couldn’t save the password: no system keyring is available. On Linux, start and unlock GNOME Keyring or KWallet"), "{l}");
        assert!(!l.contains("boom"));
        assert_eq!(keyring_error_text("macos", "save", "denied"), "Couldn’t save the password in your macOS Keychain: denied");
        assert_eq!(keyring_error_text("windows", "save", "x"), "cannot store password: x");
        assert!(keyring_error_text("linux", "read", "x").starts_with("Couldn’t read the password"));
    }

    #[test]
    fn download_folder_falls_back_to_home() {
        let d = PathBuf::from("/dl");
        let h = PathBuf::from("/home/u");
        assert_eq!(system_download_dir(Some(d.clone()), Some(h.clone())).unwrap(), (d, false));
        assert_eq!(system_download_dir(None, Some(h.clone())).unwrap(), (h, true));
        assert!(system_download_dir(None, None).is_err());
    }
}
