mod ai;
mod attach;
mod calendar;
mod calsync;
mod clipdecode;
mod db;
mod discover;
mod draftmail;
mod draftopen;
mod draftupload;
mod tempstore;
mod flagguard;
mod headerfold;
mod ical;
mod i18n;
mod identity;
mod authres;
mod importance;
mod idle;
mod legacy_names;
// the checked open of links and files on Linux; compiled everywhere so that its rules are tested everywhere
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linuxopen;
mod linuxview;
// macOS notification diagnostic (HEYLOOK_MAC_NOTIFY); compiled everywhere so that its rules are tested everywhere
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macnotify;
#[cfg(target_os = "macos")]
mod macclip;
#[cfg(target_os = "macos")]
mod macquit;
// the native window of a pop-out, finished by hand once it is gone (popout.rs)
#[cfg(target_os = "macos")]
mod macwin;
// the macOS title bar repaint strategies (HEYLOOK_TITLEBAR_MODE); pure, so compiled and tested everywhere
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod titlebar;
mod mail;
// the main window never leaves the app for a website (the PDF frame has no sandbox on Windows and macOS); the pure decision is compiled and tested everywhere
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
mod navguard;
mod pdfmode;
mod oauth;
mod oauth_page;
mod outgoing;
mod openpgp;
mod pgpmail;
mod pgpstore;
mod popout;
mod quitwait;
mod rawcache;
mod recover;
mod replyhdr;
use oauth::Provider;
mod schedule;
mod sessionend;
mod shard;
mod shell;
mod smtp;
mod smtpsize;
mod snippet;
mod update;
mod winframe;
mod wintheme;
// the app that could not start (Windows: a native message box); the message selection is compiled and tested everywhere
#[cfg_attr(not(windows), allow(dead_code))]
mod startfail;
mod startup;
mod loadfail;
mod webview_health;
mod winproc;
// debug builds only: the QA's remote control of the windows (off unless the environment asks for it, see testbridge/mod.rs); a release build has none of it
#[cfg(debug_assertions)]
mod testbridge;

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
    identity::entry(account_id).and_then(|e| e.get_password()).map_err(|e| match e {
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
    identity::entry(&format!("secret:{name}"))
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

fn secret_set(name: &str, value: &str) -> R<()> {
    let e = identity::entry(&format!("secret:{name}")).map_err(err)?;
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
        if let Some(pw) = identity::entry(&format!("{}:smtp", acc.id)).ok().and_then(|e| e.get_password().ok()) {
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
    let db = state.db.clone();
    // this attempt's number: "Cancel" in the form cancels the attempts started up to now, a later one is its own
    let attempt = ADD_STARTED.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    blocking(move || {
        let imap_login = |acc: &Account, pw: &str| imap_login_check(acc, pw, ADD_ACCOUNT_PROBE_TIMEOUT);
        let cancelled = || ADD_CANCELLED_TO.load(std::sync::atomic::Ordering::SeqCst) >= attempt;
        add_account_cancellable(&db, input, &password_value, smtp_password, &imap_login, &smtp::test, &cancelled, &keyring_store)
    })
    .await
}

/// The newest attempt to add an account that was started, and the newest one the person cancelled (the form's Cancel while it waits).
static ADD_STARTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ADD_CANCELLED_TO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// "Cancel" while the add account form waits (for the server, or for the system keyring): the attempt stops before it stores anything. The
/// form does not wait for the answer; whatever the attempt still does is undone.
#[tauri::command]
fn cancel_add_account() {
    ADD_CANCELLED_TO.store(ADD_STARTED.load(std::sync::atomic::Ordering::SeqCst), std::sync::atomic::Ordering::SeqCst);
}

/// How long the system credential store may take to answer while an account is added. A locked or absent keyring (Secret Service on Linux
/// before the login keyring is unlocked) can leave the call waiting for ever.
const KEYRING_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// The error of a credential store that did not answer in time (the UI shows its translation, `backend.KEYRING_TIMEOUT`).
fn keyring_timeout_error() -> String {
    i18n::coded("KEYRING_TIMEOUT", &[], "Your system keyring is locked or not answering. Unlock it (Passwords and Keys / KWallet) and try again.")
}

/// The error of an attempt the person cancelled (nothing was stored).
fn add_cancelled_error() -> String {
    i18n::coded("ADD_CANCELLED", &[], "Adding the account was cancelled.")
}

/// Run `set` (a call to the credential store) on a thread of its own and wait for it at most `wait`, looking at `cancelled` ten times a
/// second. When the wait ends first the call is abandoned: if it ever finishes, `undo` removes what it stored, so nothing is left behind
/// for an account that was not added. The answer of a keyring that answers is returned as it is.
fn store_within(wait: std::time::Duration, cancelled: &dyn Fn() -> bool, set: impl FnOnce() -> R<()> + Send + 'static, undo: impl FnOnce() + Send + 'static) -> R<()> {
    #[derive(PartialEq)]
    enum Phase {
        Running,
        Done,
        Abandoned,
    }
    let phase = std::sync::Arc::new(Mutex::new(Phase::Running));
    let (tx, rx) = std::sync::mpsc::channel::<R<()>>();
    let worker_phase = phase.clone();
    std::thread::spawn(move || {
        let r = set();
        let abandoned = {
            let mut p = worker_phase.lock().unwrap_or_else(|e| e.into_inner());
            if *p == Phase::Abandoned {
                true
            } else {
                *p = Phase::Done;
                false
            }
        };
        if abandoned {
            if r.is_ok() {
                undo();
            }
        } else {
            let _ = tx.send(r);
        }
    });
    let started = std::time::Instant::now();
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(r) => return r,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err("the credential store call ended without an answer".into()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        let (timed_out, cancel) = (started.elapsed() >= wait, cancelled());
        if timed_out || cancel {
            let mut p = phase.lock().unwrap_or_else(|e| e.into_inner());
            if *p == Phase::Done {
                // it answered just now: the answer is in the channel
                drop(p);
                return rx.recv().unwrap_or_else(|_| Err("the credential store call ended without an answer".into()));
            }
            *p = Phase::Abandoned;
            return Err(if cancel { add_cancelled_error() } else { keyring_timeout_error() });
        }
    }
}

/// Store a secret in the system credential store (waiting at most [`KEYRING_WAIT`]).
fn keyring_store(user: &str, value: &str, cancelled: &dyn Fn() -> bool) -> R<()> {
    let (u, v, undo_user) = (user.to_string(), value.to_string(), user.to_string());
    store_within(
        KEYRING_WAIT,
        cancelled,
        move || identity::entry(&u).and_then(|e| e.set_password(&v)).map_err(|e| keyring_error_text(std::env::consts::OS, "save", &e.to_string())),
        move || {
            if let Ok(e) = identity::entry(&undo_user) {
                let _ = e.delete_credential();
            }
        },
    )
}

/// How long the IMAP server may take to greet and to answer the STARTTLS request (or the SSL/TLS handshake) while an account is added.
const ADD_ACCOUNT_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The IMAP connection check of an account being added: the bounded secure-connection probe first (a server that stays silent gets the
/// secure connection hint within `probe_timeout`, like SMTP), then the real login. The normal sync path does not probe.
fn imap_login_check(acc: &Account, pw: &str, probe_timeout: std::time::Duration) -> R<()> {
    mail::probe_secure_connection(acc, probe_timeout)?;
    let mut s = mail::connect(acc, pw)?;
    let _ = s.logout();
    Ok(())
}

/// The whole of "Add account": the connection checks come first and the first thing written (the password, then the account row)
/// only after both have passed, so an add that is refused leaves nothing behind.
/// `imap_login` and `smtp_check` are the two connection checks (the real ones, or stand-ins in tests).
#[cfg(test)]
fn add_account_with(
    db: &Db,
    input: AccountInput,
    password_value: &str,
    smtp_password: Option<String>,
    imap_login: &dyn Fn(&Account, &str) -> R<()>,
    smtp_check: &dyn Fn(&Account, &str) -> R<()>,
) -> R<Account> {
    add_account_cancellable(db, input, password_value, smtp_password, imap_login, smtp_check, &|| false, &keyring_store)
}

/// [`add_account_with`] that can be cancelled (`cancelled`) and whose credential store is `store(user, value, cancelled)` (stood in for in tests).
#[allow(clippy::too_many_arguments)]
fn add_account_cancellable(
    db: &Db,
    input: AccountInput,
    password_value: &str,
    smtp_password: Option<String>,
    imap_login: &dyn Fn(&Account, &str) -> R<()>,
    smtp_check: &dyn Fn(&Account, &str) -> R<()>,
    cancelled: &dyn Fn() -> bool,
    store: &dyn Fn(&str, &str, &dyn Fn() -> bool) -> R<()>,
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
        reply_to: String::new(),
    };
    let smtp_password = smtp_password.filter(|p| !p.is_empty());
    let smtp_pw = smtp_password.clone().unwrap_or_else(|| password_value.to_string());
    let test_smtp = !acc.smtp_username.is_empty() || smtp_password.is_some();
    check_new_account(&acc, password_value, &smtp_pw, test_smtp, imap_login, smtp_check)?;
    if cancelled() {
        return Err(add_cancelled_error());
    }
    store(&acc.id, password_value, cancelled)?;
    if let Some(sp) = &smtp_password {
        if let Err(e) = store(&format!("{}:smtp", acc.id), sp, cancelled) {
            // nothing half-added: the first secret goes again, no account row is made
            if let Ok(entry) = identity::entry(&acc.id) {
                let _ = entry.delete_credential();
            }
            return Err(e);
        }
    }
    if cancelled() {
        // cancelled while the keyring was answering: the secrets go again, no account row is made
        for user in [acc.id.clone(), format!("{}:smtp", acc.id)] {
            if let Ok(entry) = identity::entry(&user) {
                let _ = entry.delete_credential();
            }
        }
        return Err(add_cancelled_error());
    }
    // the color is chosen and stored here, so every window shows the same one from the first moment
    let c = lock(db);
    let mut acc = acc;
    acc.color = Some(db::pick_account_color(db::list_accounts(&c)?.iter().map(|a| a.color.as_deref())));
    db::insert_account(&c, &acc)?;
    Ok(acc)
}

/// What an account must pass before it is stored: the IMAP login, and the SMTP side. A separate SMTP login is verified up front; a
/// shared one never was and a refusal of it still is not held against the account, but a server that cannot be secured (a plain port
/// or a silent one, with SSL/TLS or STARTTLS) is reported now, as the IMAP side is (REQ-53), and the account is not added.
fn check_new_account(
    acc: &Account,
    password_value: &str,
    smtp_pw: &str,
    test_smtp: bool,
    imap_login: &dyn Fn(&Account, &str) -> R<()>,
    smtp_check: &dyn Fn(&Account, &str) -> R<()>,
) -> R<()> {
    imap_login(acc, password_value)?;
    if test_smtp {
        smtp_check(acc, smtp_pw)?;
    } else if let Err(e) = smtp_check(acc, smtp_pw) {
        if mail::is_secure_connection_error(&e) {
            return Err(e);
        }
    }
    Ok(())
}

#[tauri::command]
async fn google_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
    client_secret: String,
    display_name: String,
) -> R<Account> {
    oauth_sign_in(app, state, Provider::Google, client_id, client_secret, None, display_name, None).await
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
    oauth_sign_in(app, state, Provider::Microsoft, client_id, client_secret, tenant, display_name, None).await
}

/// The mail sign-in that waits for the browser (Add account, Sign in again): what the Cancel button ends.
static MAIL_WAIT: oauth::Waiting = oauth::Waiting::new();

/// Cancel button of a mail sign-in: it stops waiting at once, the loopback port is freed and no account is added or changed.
#[tauri::command]
fn oauth_cancel() {
    MAIL_WAIT.cancel();
}

/// "Sign in again" for a Google / Microsoft mailbox whose sign-in ended: the same address, the same account (its mail stays), a new token.
#[tauri::command]
async fn reauth_account(app: tauri::AppHandle, state: tauri::State<'_, AppState>, account_id: String) -> R<Account> {
    let (acc, provider) = {
        let c = lock(&state.db);
        let acc = db::get_account(&c, &account_id)?;
        let provider = Provider::from_auth(&acc.auth).ok_or("This mailbox does not sign in with Google or Microsoft.")?;
        (acc, provider)
    };
    let (client_id, client_secret) = oauth_creds(&state.db, provider);
    let tenant = oauth_tenant(&state.db, provider);
    oauth_sign_in(app, state, provider, client_id, client_secret, Some(tenant), String::new(), Some(acc.email)).await
}

/// `expect`: the address the sign-in must be for (Sign in again); another account is refused before anything is stored.
async fn oauth_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    provider: Provider,
    client_id: String,
    client_secret: String,
    tenant: Option<String>,
    display_name: String,
    expect: Option<String>,
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
    let pending = oauth::begin_for(provider, oauth::Purpose::Mail, &tenant, client_id.trim(), expect.as_deref())?;
    let wait = pending.canceller();
    MAIL_WAIT.begin(wait.clone());
    if let Err(e) = open_target(&app, &pending.url, true) {
        MAIL_WAIT.end(&wait);
        return Err(e);
    }
    let (cid, csec) = (client_id.trim().to_string(), client_secret.trim().to_string());
    let signed = blocking(move || pending.finish(&cid, &csec)).await;
    MAIL_WAIT.end(&wait);
    // (a cancel or a timeout ends here: nothing was stored, no account was added or changed)
    let signed = signed?;
    if let Some(want) = &expect {
        if !signed.email.eq_ignore_ascii_case(want) {
            return Err(i18n::coded(
                "OAUTH_WRONG_ACCOUNT",
                &[("got", &signed.email), ("expected", want)],
                &format!("You signed in as {}. Sign in as {} to renew this mailbox’s sign-in.", signed.email, want),
            ));
        }
    }

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
        reply_to: String::new(),
    };
    identity::entry(&acc.id)
        .and_then(|e| e.set_password(&signed.refresh_token))
        .map_err(|e| keyring_error_text(std::env::consts::OS, "save", &e.to_string()))?;
    oauth::cache_token(&acc.id, &signed.access_token, 3300);
    // verify the IMAP login works with the new token
    let (a2, tok) = (acc.clone(), signed.access_token.clone());
    let verified = blocking(move || {
        let mut s = mail::connect(&a2, &tok)?;
        let _ = s.logout();
        Ok(())
    })
    .await;
    if let Err(e) = verified {
        // a new mailbox that cannot be used leaves no token behind (an existing one keeps the token it has just been given)
        if existing.is_none() {
            if let Ok(entry) = identity::entry(&acc.id) {
                let _ = entry.delete_credential();
            }
            oauth::forget_token(&acc.id);
        }
        return Err(e);
    }
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

/// The page answers a ping of the backend (Linux, `linuxview.rs`: does the page still run after the window sat in the tray?).
#[tauri::command]
fn page_pong(nonce: u64, visibility: String) {
    linuxview::pong(nonce, &visibility);
}

/// The page takes the "New mail" of the tray menu that is still waiting for it (see `shell::TRAY_COMPOSE_PENDING`): true once per request.
#[tauri::command]
fn take_tray_compose() -> bool {
    shell::TRAY_COMPOSE_PENDING.swap(false, std::sync::atomic::Ordering::SeqCst)
}

/// The frontend tells whether any account exists: without one the tray's "New mail" and "Check mail now" are disabled.
#[tauri::command]
fn set_mail_available(available: bool) {
    shell::set_mail_available(available);
}

#[tauri::command]
fn update_account(state: tauri::State<AppState>, account_id: String, display_name: String, color: Option<String>, reply_to: Option<String>) -> R<()> {
    // `reply_to` None: the setting stays as it is (the colour and name callers do not know it); a text that is not one address is refused before anything is written
    let reply_to = reply_to.map(|r| smtp::check_reply_to(&r)).transpose()?;
    db::update_profile(&lock(&state.db), &account_id, &display_name, color.as_deref(), reply_to.as_deref())
}

#[tauri::command]
fn remove_account(app: tauri::AppHandle, state: tauri::State<AppState>, account_id: String) -> R<()> {
    db::remove_account(&lock(&state.db), &account_id)?;
    // the windows that show mail of this mailbox (a reader window) read their conversation again: it is gone
    let _ = app.emit("mail-synced", ());
    smtpsize::forget(&account_id);
    // (the calendar grant of the mailbox goes with it)
    for name in [account_id.clone(), format!("{account_id}:smtp"), oauth::calendar_key(&account_id)] {
        if let Ok(e) = identity::entry(&name) {
            let _ = e.delete_credential();
        }
    }
    oauth::forget_token(&oauth::calendar_key(&account_id));
    Ok(())
}

// ---------- sync ----------

fn fmap(db: &Db, account_id: &str) -> HashMap<String, String> {
    db::get_setting(&lock(db), &format!("fmap:{account_id}"))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The server folder for a role from the saved list (drafts ...). Save draft and send do not create a folder the server lacks (README, known
/// limitations): the action that needs one fails with a message that says which folder is missing (QA BUG-M4 / M8). A move (archive,
/// delete ...) looks at the server and may create Archive / Trash instead: `move_to_role`.
fn folder_for(db: &Db, acc: &Account, role: &str) -> R<String> {
    fmap(db, &acc.id).get(role).cloned().ok_or_else(|| match role {
        "drafts" => "this account has no Drafts folder".to_string(),
        r => format!("no '{r}' folder on this account"),
    })
}

/// The conversation a message belongs to: its first reference, else its own Message-ID, else (no ID at all) its place in the folder.
fn thread_id_of(acc_id: &str, role: &str, p: &mail::Parsed) -> String {
    let root = p
        .refs
        .first()
        .cloned()
        .or_else(|| p.message_id.clone())
        .unwrap_or_else(|| format!("{}:{}:{}", acc_id, role, p.uid));
    fnv(&format!("{}|{}", acc_id, root))
}

/// The thread a just-saved draft will have once the sync has read it (None when the message has neither reference nor Message-ID, so
/// its thread would depend on the uid the server gives it).
fn draft_thread_id(acc_id: &str, raw: &[u8]) -> Option<String> {
    let p = mail::parse(0, raw, true, false, 0)?;
    if p.refs.is_empty() && p.message_id.is_none() {
        return None;
    }
    Some(thread_id_of(acc_id, "drafts", &p))
}

fn insert_parsed(c: &Connection, acc: &Account, role: &str, p: &mail::Parsed) -> R<String> {
    let thread_id = thread_id_of(&acc.id, role, p);
    c.execute(
        "INSERT OR REPLACE INTO messages(id,account_id,folder,uid,message_id,thread_id,subject,from_name,from_email,
           to_addrs,cc_addrs,date,snippet,body_html,body_text,seen,flagged,has_attach,attachments,list_unsub,list_unsub_post,pgp,pgp_raw,ics,cal_method,importance,auth_result)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22 | COALESCE((SELECT pgp FROM messages WHERE id=?1),0),?23,?24,?25,?26,?27)",
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
            p.cal_method,
            p.importance.to_db(),
            p.auth.to_db()
        ],
    )
    .map_err(err)?;
    // invitations, updates, cancellations and replies reach the calendar as they arrive
    if let Some(ics) = &p.ics {
        if !matches!(role, "sent" | "drafts" | "trash" | "junk") {
            let id = format!("{}:{}:{}", acc.id, role, p.uid);
            if let Ok(o) = calendar::ingest_checked(c, acc, &id, &p.from_email, ics, false, p.auth, false) {
                if o.changed {
                    calendar::mark_dirty();
                }
                if o.held {
                    startup::line("calendar", &format!("{id}: sender check failed, change held"));
                }
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

/// Write the server's read / flagged state of known messages into their rows - except those a read / flag action changed while the
/// flags were being read (`started` = `flagguard` epoch before the fetch): the action's own state is newer than the server's answer.
fn apply_server_flags(c: &Connection, guard: &flagguard::FlagGuard, started: u64, account_id: &str, role: &str, flags: &[(u32, bool, bool)]) -> R<()> {
    for (uid, seen, flagged) in flags {
        if guard.skip(&(account_id.to_string(), role.to_string(), *uid), started) {
            continue;
        }
        c.execute(
            "UPDATE messages SET seen=?1, flagged=?2 WHERE account_id=?3 AND folder=?4 AND uid=?5",
            params![*seen as i64, *flagged as i64, account_id, role, uid],
        )
        .map_err(err)?;
    }
    Ok(())
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
        // (F-16/F-17) flags of messages an action changes while this fetch runs are not written back: see `flagguard`
        let flags_started = flagguard::GUARD.epoch();
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
            apply_server_flags(&c, &flagguard::GUARD, flags_started, account_id, &role, &ff.flags)?;
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
            let res = action_impl_in(db, vec![tid.to_string()], r.action.clone(), r.arg.clone(), Some("inbox".into()), false);
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

/// The mailboxes known to need a new sign-in (account id -> `again` / `blocked`), so the UI is told once when that changes.
static SIGNIN_FLAGGED: Mutex<std::collections::BTreeMap<String, &'static str>> = Mutex::new(std::collections::BTreeMap::new());

/// Note the outcome of a sync of one account. The change to announce: `Some(Some(kind))` it now needs a new sign-in,
/// `Some(None)` it works again, `None` nothing changed.
fn track_signin(flagged: &mut std::collections::BTreeMap<String, &'static str>, account_id: &str, error: Option<&str>) -> Option<Option<&'static str>> {
    match error {
        // (an error that is not about the sign-in, such as no network, changes nothing: the mailbox still needs it)
        Some(e) => oauth::signin_kind(e).and_then(|kind| (flagged.insert(account_id.to_string(), kind) != Some(kind)).then_some(Some(kind))),
        None => flagged.remove(account_id).map(|_| None),
    }
}

/// One sync pass for an account, then toasts + tray badge. A rejected sign-in is announced to the UI (`signin-state`), also when the
/// background worker found it, so the mailbox shows "Sign in again" instead of failing quietly.
fn run_sync(app: &tauri::AppHandle, db: &Db, account_id: &str) -> R<SyncResult> {
    let r = run_sync_inner(app, db, account_id);
    let change = track_signin(&mut SIGNIN_FLAGGED.lock().unwrap_or_else(|p| p.into_inner()), account_id, r.as_ref().err().map(String::as_str));
    if let Some(state) = change {
        let _ = app.emit_to("main", "signin-state", serde_json::json!({ "accountId": account_id, "state": state, "error": r.as_ref().err() }));
    }
    r
}

fn run_sync_inner(app: &tauri::AppHandle, db: &Db, account_id: &str) -> R<SyncResult> {
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let r = sync_impl(db, account_id)?;
    for why in take_rule_errors_to_tell() {
        let _ = app.emit_to("main", "filter-failed", why);
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
    /// (W2.5) the messages of those conversations at the moment the move was queued: the move acts on exactly these, not on what the conversations hold
    /// when the Undo time is over (a sync in between can thread another message into one, or reuse an id). `None` for what is not a move of mail.
    msgs: Option<Vec<MsgRef>>,
    action: String,
    arg: Option<String>,
    scope: Option<String>,
    due: std::time::Instant,
    /// (BUG-1) the check, running during the Undo window, that the saved folder this move goes to still exists on the server
    verify: Option<Arc<Verify>>,
}

/// The outcome of the folder check of one queued move. The check runs on its own thread; the move waits for it (`wait`) and does not
/// send anything to a folder that was not checked, unless the check is taking longer than `max` (a slow or offline server: then the move
/// is tried as before, and its own folder look-up on failure still applies).
struct Verify {
    result: Mutex<Option<R<()>>>,
    done: std::sync::Condvar,
}

impl Verify {
    fn new() -> Arc<Verify> {
        Arc::new(Verify { result: Mutex::new(None), done: std::sync::Condvar::new() })
    }

    fn finish(&self, r: R<()>) {
        *self.result.lock().unwrap_or_else(|p| p.into_inner()) = Some(r);
        self.done.notify_all();
    }

    /// The result of the check, waiting at most `max` for it; None when it is still running.
    fn wait(&self, max: std::time::Duration) -> Option<R<()>> {
        let g = self.result.lock().unwrap_or_else(|p| p.into_inner());
        let (g, _) = self.done.wait_timeout_while(g, max, |r| r.is_none()).unwrap_or_else(|p| p.into_inner());
        g.clone()
    }
}

/// How long a due move waits for its folder check (a flush at quit does not hold the app up as long).
const VERIFY_WAIT: std::time::Duration = std::time::Duration::from_secs(20);
const VERIFY_WAIT_AT_QUIT: std::time::Duration = std::time::Duration::from_secs(4);

static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());

fn pending_lock() -> std::sync::MutexGuard<'static, Vec<Pending>> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner())
}

/// The moves whose Undo time is over and that are being done right now (the server move, then the local rows): their threads stay hidden from
/// the lists until that is finished. Without this the threads were in neither set while the move ran, so a list read in that moment (the 30 s
/// refresh of the page, a sync) showed the message again, and a window that was hidden to the tray showed it after it was reopened (BUG-B3).
static COMMITTING: Mutex<Vec<(String, Vec<String>)>> = Mutex::new(Vec::new());

fn committing_lock() -> std::sync::MutexGuard<'static, Vec<(String, Vec<String>)>> {
    COMMITTING.lock().unwrap_or_else(|p| p.into_inner())
}

/// Threads that a list must not show: waiting out their Undo time, or being moved right now.
fn pending_thread_ids() -> std::collections::HashSet<String> {
    // (always this order: a mover holds PENDING while it registers in COMMITTING, so a thread is never in neither)
    let waiting = pending_lock();
    let running = committing_lock();
    waiting.iter().flat_map(|p| p.threads.iter().cloned()).chain(running.iter().flat_map(|(_, t)| t.iter().cloned())).collect()
}

/// Take the moves that are due (all of them when `due` is None) out of the waiting list and register them as running, in one step.
fn take_due(due: Option<std::time::Instant>) -> Vec<Pending> {
    let mut g = pending_lock();
    let (taken, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut *g).into_iter().partition(|p| due.map_or(true, |now| p.due <= now));
    *g = rest;
    let mut running = committing_lock();
    running.extend(taken.iter().map(|p| (p.id.clone(), p.threads.clone())));
    taken
}

/// The move is over (done or failed): its threads show in the lists again if they are still there.
fn committing_done(id: &str) {
    committing_lock().retain(|(i, _)| i != id);
}

/// The first characters of a queued move's token: what the log calls it.
fn short_token(id: &str) -> &str {
    &id[..id.len().min(8)]
}

/// The messages of a log line: `folder:UID` of each and the first characters of the account id (no subject, no address; short, the log is small), at most 12.
fn describe_msgs(msgs: &[MsgRef]) -> String {
    let mut accounts: Vec<&str> = msgs.iter().map(|m| short_token(&m.account_id)).collect();
    accounts.sort_unstable();
    accounts.dedup();
    let shown: Vec<String> = msgs.iter().take(12).map(|m| format!("{}:{}", m.role, m.uid)).collect();
    format!("{} message(s) of {} [{}{}]", msgs.len(), accounts.join("+"), shown.join(" "), if msgs.len() > shown.len() { " ..." } else { "" })
}

/// Does this action move mail out of the folder it is in (the actions that wait out an Undo time)?
fn is_queued_move(action: &str) -> bool {
    matches!(action, "archive" | "trash" | "junk" | "inbox" | "move" | "delete_forever" | "block")
}

fn queue(thread_ids: Vec<String>, msgs: Option<Vec<MsgRef>>, action: String, arg: Option<String>, scope: Option<String>, delay_secs: u64, verify: Option<Arc<Verify>>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    startup::line(
        "action",
        &format!(
            "queued {}: {action} from {} in {delay_secs} s, {} conversation(s) [{}], {}",
            short_token(&id),
            scope.as_deref().unwrap_or("any folder"),
            thread_ids.len(),
            thread_ids.iter().take(12).cloned().collect::<Vec<_>>().join(" "),
            msgs.as_deref().map(describe_msgs).unwrap_or_else(|| "resolved when it runs (not a move of mail)".into()),
        ),
    );
    pending_lock().push(Pending {
        id: id.clone(),
        threads: thread_ids,
        msgs,
        action,
        arg,
        scope,
        due: std::time::Instant::now() + std::time::Duration::from_secs(delay_secs),
        verify,
    });
    id
}

/// Remove a queued move; true when it was still waiting.
fn unqueue(id: &str) -> bool {
    let mut g = pending_lock();
    let before = g.len();
    g.retain(|p| p.id != id);
    g.len() != before
}

/// The app is told that a queued move was dropped because its folder is gone and cannot be made: the mail is back in the list.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VerifyFailed {
    id: String,
    error: String,
}

/// A folder check ended. A failure drops the move if it is still waiting (Undo already took it: nothing to do; the move is already
/// running: it sees the failure itself, `run_pending`) and returns the error for the app to show.
fn verify_finished(id: &str, v: &Verify, result: R<()>) -> Option<String> {
    let failed = result.clone().err();
    v.finish(result);
    let error = failed?;
    unqueue(id).then_some(error)
}

/// Hide the threads now and run the action on the server after `delay_secs`, unless it is cancelled. `verify`: the saved folder list was
/// trusted for the folder this move goes to (see `prepare_action`), so it is looked up on the server now, while the Undo window runs; when
/// it is gone and cannot be made, the move is dropped and the app gets `action-verify-failed`.
#[tauri::command]
fn queue_action(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    thread_ids: Vec<String>,
    action: String,
    arg: Option<String>,
    scope: Option<String>,
    delay_secs: u64,
    verify: Option<bool>,
) -> String {
    let db = state.db.clone();
    let targets = if verify == Some(true) { move_targets(&db, &thread_ids, &action, arg.as_deref(), &scope).unwrap_or_default() } else { vec![] };
    // (W2.5) which messages this is about is decided now, when the person pressed the key, not when the Undo time is over
    let msgs = if is_queued_move(&action) {
        match thread_msgs(&lock(&db), &thread_ids) {
            Ok(m) => Some(m),
            Err(e) => {
                startup::line("action", &format!("the messages of the conversations could not be read at queue time, the move will resolve them when it runs: {e}"));
                None
            }
        }
    } else {
        None
    };
    if targets.is_empty() {
        return queue(thread_ids, msgs, action, arg, scope, delay_secs, None);
    }
    let gate = Verify::new();
    let id = queue(thread_ids, msgs, action, arg, scope, delay_secs, Some(gate.clone()));
    let task = id.clone();
    std::thread::spawn(move || {
        let wanted: Vec<(String, String)> = targets.into_iter().map(|(a, d, _)| (a, d)).collect();
        if let Some(error) = verify_finished(&task, &gate, verify_targets(&db, &wanted)) {
            let _ = app.emit_to("main", "action-verify-failed", VerifyFailed { id: task, error });
        }
    });
    id
}

#[tauri::command]
fn cancel_action(id: String) -> bool {
    let cancelled = unqueue(&id);
    startup::line("action", &format!("undo {}: {}", short_token(&id), if cancelled { "the move was still waiting and is cancelled" } else { "not waiting (already running, done or never queued): nothing cancelled" }));
    cancelled
}

/// The threads whose move is done, for the main page (`moves-committed`): it takes them out of its list at once.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MovesCommitted {
    thread_ids: Vec<String>,
}

fn run_pending(app: &tauri::AppHandle, items: Vec<Pending>, verify_wait: std::time::Duration) {
    if items.is_empty() {
        return;
    }
    let db = app.state::<AppState>().db.clone();
    let mut moved: Vec<String> = vec![];
    for p in items {
        // never move into a folder that was not checked: a failed check ends the move here
        if let Some(Err(error)) = p.verify.as_ref().and_then(|v| v.wait(verify_wait)) {
            committing_done(&p.id);
            let _ = app.emit_to("main", "action-verify-failed", VerifyFailed { id: p.id, error });
            continue;
        }
        let id = p.id.clone();
        let threads = p.threads.clone();
        let done = run_queued(&db, p, &mut |m, a, d, s, c| act_on_refs(&db, m, a, d, s, c));
        startup::line("action", &format!("done {}: {}", short_token(&id), match &done { Ok(()) => "ok".to_string(), Err(e) => format!("failed: {}", e.chars().take(160).collect::<String>()) }));
        // (the local rows are changed by now: the threads stop being hidden only here, so no list read in between shows them)
        committing_done(&id);
        match done {
            Ok(()) => moved.extend(threads),
            // the id says which queued move this was: the app puts the mail, the selection and the next mail's unread state back (autoAdvance.ts)
            Err(error) => {
                let _ = app.emit_to("main", "action-failed", VerifyFailed { id, error });
            }
        }
    }
    shell::update_badge(app, &db);
    // the Undo time is over and the move is done: the page drops the messages from its list at this moment, whether its window is in front or
    // hidden to the tray, and does not wait for a sync or a re-read to find out
    if !moved.is_empty() {
        let _ = app.emit_to("main", "moves-committed", MovesCommitted { thread_ids: moved });
    }
    let _ = app.emit("mail-synced", ());
}

/// The doer of a queued move: moves these messages (as `act_on_refs` does). A seam for the tests, which run it against a fake server.
type MoveMessages<'a> = &'a mut dyn FnMut(Vec<MsgRef>, &str, Option<&str>, &Option<String>, bool) -> R<()>;

/// What a queued move does when its Undo time is over (W2.5): it acts on the messages it was queued with. One that has left the folder it was in
/// meanwhile (moved by another program, removed by a sync) is skipped, a message that arrived in the conversation since stays where it is.
fn run_queued(db: &Db, p: Pending, act: MoveMessages) -> R<()> {
    let Some(queued) = p.msgs else {
        return action_impl(db, p.threads, p.action, p.arg, p.scope);
    };
    let live = still_there(db, &queued);
    startup::line(
        "action",
        &format!("running {}: {} from {}, queued with {} message(s), {} still there: {}", short_token(&p.id), p.action, p.scope.as_deref().unwrap_or("any folder"), queued.len(), live.len(), describe_msgs(&live)),
    );
    if live.is_empty() {
        return Ok(());
    }
    if p.action == "block" {
        // block the senders of those messages, then move them to Junk
        {
            let c = lock(db);
            for m in live.iter().filter(|m| m.role != "sent") {
                c.execute("INSERT OR IGNORE INTO blocked(email) SELECT DISTINCT from_email FROM messages WHERE id=?1", [&m.id]).map_err(err)?;
            }
        }
        return act(live, "junk", Some("junk"), &p.scope, true);
    }
    let dst = dst_role_of(&p.action, &p.arg)?;
    act(live, &p.action, dst.as_deref(), &p.scope, true)
}

/// The queued messages that are still in the folder and at the UID they were queued with.
fn still_there(db: &Db, queued: &[MsgRef]) -> Vec<MsgRef> {
    let c = lock(db);
    queued
        .iter()
        .filter(|m| c.query_row("SELECT 1 FROM messages WHERE id=?1 AND account_id=?2 AND folder=?3 AND uid=?4", params![m.id, m.account_id, m.role, m.uid], |_| Ok(())).is_ok())
        .cloned()
        .collect()
}

fn commit_due(app: &tauri::AppHandle) {
    run_pending(app, take_due(Some(std::time::Instant::now())), VERIFY_WAIT);
}

/// Run everything still waiting (called before the app quits).
pub(crate) fn flush_pending(app: &tauri::AppHandle) {
    run_pending(app, take_due(None), VERIFY_WAIT_AT_QUIT);
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

/// The `backfill-progress` event the UI shows "Downloading mails..." from. `done` ends the line for the account (the UI keys it by account).
fn backfill_event(account_id: &str, role: &str, have: u32, target: u32, done: bool) -> serde_json::Value {
    serde_json::json!({ "accountId": account_id, "role": role, "have": have, "target": target, "done": done })
}

/// Download older mail in chunks of `PAGE`, one folder after the other, until every folder holds its target (or the account
/// its cap) or has nothing older. Resumable (it works from what is stored), stops when the account is removed, and on an error (after one reconnect).
fn backfill_run(app: &tauri::AppHandle, db: &Db, account_id: &str) -> R<()> {
    let mut sess: Option<mail::Sess> = None;
    let r = backfill_loop(
        db,
        account_id,
        BACKFILL_PAUSE,
        &mut |acc, name, below, count| {
            let step = (|| -> R<(Vec<mail::Parsed>, bool)> {
                if sess.is_none() {
                    sess = Some(mail::connect(acc, &secret(db, acc)?)?);
                }
                mail::fetch_older(sess.as_mut().ok_or("no session")?, name, below, count)
            })();
            if step.is_err() {
                sess = None; // a failed session is not reused
            }
            step
        },
        &mut |ev| {
            let _ = app.emit_to("main", "backfill-progress", ev);
        },
    );
    if let Some(mut s) = sess {
        let _ = s.logout();
    }
    r
}

/// The loop of `backfill_run` without the network (`fetch`: account, IMAP folder, lowest stored uid, count) and without the
/// window (`emit`: the `backfill-progress` payloads). However it ends - nothing left, the account removed, two failures in a row -
/// the line the UI shows is closed: every run that ended after a progress event that was not the last of its folder emits a final
/// `done` one. The UI keeps the last event until a `done` arrives, and the loop can stop between two chunks without having
/// finished the folder: `load_older` (the list asks for older mail by itself when its end is in view) marks the folder as
/// complete in the pause, a sync brings the account to its cap, the cap is lowered.
fn backfill_loop(
    db: &Db,
    account_id: &str,
    pause: std::time::Duration,
    fetch: &mut dyn FnMut(&Account, &str, u32, usize) -> R<(Vec<mail::Parsed>, bool)>,
    emit: &mut dyn FnMut(serde_json::Value),
) -> R<()> {
    let mut open: Option<(String, u32, u32)> = None; // the last progress event, unless it ended its folder
    let r = backfill_chunks(db, account_id, pause, fetch, emit, &mut open);
    if let Some((role, have, target)) = open {
        emit(backfill_event(account_id, &role, have, target, true));
    }
    r
}

fn backfill_chunks(
    db: &Db,
    account_id: &str,
    pause: std::time::Duration,
    fetch: &mut dyn FnMut(&Account, &str, u32, usize) -> R<(Vec<mail::Parsed>, bool)>,
    emit: &mut dyn FnMut(serde_json::Value),
    open: &mut Option<(String, u32, u32)>,
) -> R<()> {
    let mut skip: std::collections::HashSet<String> = Default::default();
    let mut failures = 0;
    loop {
        // the account can be removed while this runs: its mail file is gone, so stop
        let acc = db::get_account(&lock(db), account_id)?;
        let Some((role, name, have, target)) = next_backfill(db, account_id, &skip, max_download(db)) else { break };
        let (_, below) = folder_state(db, account_id, &role)?;
        let step = (|| -> R<(usize, bool)> {
            let (found, exhausted) = fetch(&acc, &name, below, (target - have).min(PAGE) as usize)?;
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
                *open = if done { None } else { Some((role.clone(), now_have, target)) };
                emit(backfill_event(account_id, &role, now_have, target, done));
                std::thread::sleep(pause);
            }
            Err(e) => {
                failures += 1;
                if failures > 1 {
                    return Err(e);
                }
                std::thread::sleep(pause);
            }
        }
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
    /// the store that updates this copy ("snap"), None when the app updates itself (update.rs `managed_by`)
    managed: Option<&'static str>,
    /// how a PDF attachment is previewed here: "frame", "object" or "card" (pdfmode.rs)
    pdf_view: &'static str,
    /// the PDF experiment of macOS / Linux is on (HEYLOOK_PDF_INLINE): the page shows a readout of what the engine did
    pdf_test: bool,
    /// debug builds only, `HEYLOOK_TEST_COPY_FAIL=1`: every copy to the clipboard fails (QA of the "Couldn't copy" toasts)
    copy_fail: bool,
    /// debug builds only, `HEYLOOK_TEST_ACCOUNTS_DELAY_MS=<ms>`: the page waits that long before it takes the mailboxes it has read (QA of "New mail" while they are not read yet)
    accounts_delay_ms: u64,
}

/// A debug build can make every copy fail (`HEYLOOK_TEST_COPY_FAIL=1`), to see the error toasts of the Copy buttons. Never in a release build.
fn copy_forced_to_fail() -> bool {
    cfg!(debug_assertions) && std::env::var("HEYLOOK_TEST_COPY_FAIL").is_ok_and(|v| v == "1")
}

/// A debug build can make the page wait before it takes the mailboxes (`HEYLOOK_TEST_ACCOUNTS_DELAY_MS`, at most 120 s). Never in a release build.
fn accounts_delay_ms() -> u64 {
    if !cfg!(debug_assertions) {
        return 0;
    }
    std::env::var("HEYLOOK_TEST_ACCOUNTS_DELAY_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0).min(120_000)
}

#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo { os: std::env::consts::OS, tray: shell::tray_ready(), test_data: legacy_names::test_data_dir().map(|p| p.display().to_string()), managed: update::managed_by(), pdf_view: pdfmode::view().name(), pdf_test: pdfmode::experiment_on(), copy_fail: copy_forced_to_fail(), accounts_delay_ms: accounts_delay_ms() }
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
    /// Inbox rows only (0 elsewhere): unread conversations of the Focused tab (a message without a List-Unsubscribe header) and of the
    /// Other tab (with one), counted like the tab lists (`INBOX_NOT_SNOOZED`, `INBOX_NOT_BLOCKED`) and whatever "Count Other (bulk) mail" says
    unread_focused: u32,
    unread_other: u32,
    /// the account's saved folder list (`fmap:<id>`) names a server folder for this one. The app hides the Junk row and disables
    /// "Mark as junk" where this is false for `junk` (Junk is never created); Archive and Trash rows stay (created on first use).
    listed: bool,
}

/// Every account lists the six standard folders (inbox, sent, drafts, archive, trash, junk) plus the server's own folders, whether the
/// server has the standard ones or not (QA v1.0.1 round 10, OBS-2: "Archive and Junk Email are listed when the server has neither").
/// That is by design: Archive and Trash are what "Archive" and "Delete" move to, and a missing one is created the first time it is
/// needed (F-14, `prepare_action`), so the row has to exist before the folder does. A row for a folder the server lacks is just empty;
/// the app never claims it is a server folder. Junk is never created: marking mail as junk on a server without a Junk folder says
/// at once that the folder is missing (`FOLDER_MISSING`), and the row fills as soon as the server has one (the next sync picks it up).
/// (1.0.5) The rows stay, but each says whether the saved list names the folder (`listed`): the app hides the Junk row of an account
/// whose list has no Junk, and a Junk folder the server gains later is listed by the next sync (it rewrites the saved list).
#[tauri::command]
fn list_folders(state: tauri::State<AppState>) -> R<Vec<FolderInfo>> {
    folder_infos(&lock(&state.db))
}

/// What the Inbox leaves out of every list and every Inbox number: a snoozed conversation (until its time) and mail from a blocked sender.
/// One place for `threads_for` (the lists and the Focused / Other tabs) and `inbox_unread` (the side menu and the tab numbers). `?` is the
/// current time.
const INBOX_NOT_SNOOZED: &str = "(tm.snoozed_until IS NULL OR tm.snoozed_until<=?)";
const INBOX_NOT_BLOCKED: &str = "m.from_email NOT IN (SELECT email FROM blocked)";
/// Conversations waiting out their Undo time (or being moved right now) are gone from every list (`pending_thread_ids`), so they are not in the unread
/// numbers either: the row and the numbers of the side menu and the tabs go together, and Undo puts both back. The parameter is a JSON array of thread ids.
const NOT_HIDDEN: &str = "m.thread_id NOT IN (SELECT value FROM json_each(?))";

/// The thread ids as the JSON array that `NOT_HIDDEN` reads.
fn hidden_json(hidden: &std::collections::HashSet<String>) -> String {
    serde_json::to_string(&hidden.iter().collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into())
}

/// SQL for `inbox_unread` over one mailbox's `messages` table. Parameters in order: count bulk mail in the Inbox number (0 / 1), the
/// account, the current time, the hidden thread ids (`hidden_json`). It reads only unread Inbox rows of one account, so it runs on
/// `idx_msg_folder (account_id, folder, date)`.
fn inbox_unread_sql(table: &str) -> String {
    format!(
        "SELECT COUNT(DISTINCT CASE WHEN m.list_unsub IS NULL THEN m.thread_id END),
                COUNT(DISTINCT CASE WHEN m.list_unsub IS NOT NULL THEN m.thread_id END),
                COUNT(DISTINCT CASE WHEN ?=1 OR m.list_unsub IS NULL THEN m.thread_id END)
         FROM {table} m LEFT JOIN thread_meta tm ON tm.thread_id=m.thread_id
         WHERE m.account_id=? AND m.folder='inbox' AND m.seen=0 AND {INBOX_NOT_SNOOZED} AND {INBOX_NOT_BLOCKED}
           AND {NOT_HIDDEN}"
    )
}

/// Unread conversations of one mailbox's Inbox as (Focused tab, Other tab, the side-menu number). The side-menu number leaves bulk mail
/// out unless `include_other`; the two tab numbers do not depend on it. A conversation with unread mail of both kinds is in both tabs.
fn inbox_unread(c: &Connection, account_id: &str, include_other: bool, hidden: &str) -> R<(u32, u32, u32)> {
    let table = shard::messages_table(c, account_id)?;
    c.query_row(&inbox_unread_sql(&table), params![include_other as i64, account_id, now(), hidden], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(err)
}

fn folder_infos(c: &Connection) -> R<Vec<FolderInfo>> {
    folder_infos_hiding(c, &pending_thread_ids())
}

/// `folder_infos` with the conversations that the lists hide (waiting out their Undo time, being moved) left out of the unread numbers.
fn folder_infos_hiding(c: &Connection, hidden: &std::collections::HashSet<String>) -> R<Vec<FolderInfo>> {
    let hidden = hidden_json(hidden);
    let accounts = db::list_accounts(c)?;
    let mut counts: HashMap<(String, String), (u32, u32)> = HashMap::new();
    let p: serde_json::Value = db::get_setting(c, "prefs")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    // unread numbers count conversations, and (with Focused Inbox on) leave bulk mail out of the inbox figure unless "Count Other (bulk)
    // mail" is on, which is the default
    let include_other = p.get("countOtherMail").and_then(|v| v.as_bool()).unwrap_or(true)
        || !p.get("focused").and_then(|v| v.as_bool()).unwrap_or(true);
    // (the Inbox's own unread number is read by `inbox_unread`, which also leaves out snoozed conversations and blocked senders)
    let mut st = c
        .prepare(
            "SELECT account_id,folder,COUNT(DISTINCT thread_id),
                    COUNT(DISTINCT CASE WHEN seen=0 AND folder!='inbox' AND thread_id NOT IN (SELECT value FROM json_each(?1)) THEN thread_id END)
             FROM messages GROUP BY account_id,folder",
        )
        .map_err(err)?;
    let rows = st
        .query_map([&hidden], |r| {
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
        let map: HashMap<String, String> = db::get_setting(c, &format!("fmap:{}", a.id))
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut keys: Vec<String> = mail::ROLES.iter().map(|r| r.to_string()).collect();
        let mut custom: Vec<String> = map.keys().filter(|k| k.starts_with("f:")).cloned().collect();
        custom.sort();
        keys.extend(custom);
        // (a mailbox whose file cannot be read shows no unread numbers; the other mailboxes still do)
        let (focused, other, inbox) = inbox_unread(c, &a.id, include_other, &hidden).unwrap_or_else(|e| {
            eprintln!("could not count the unread Inbox mail of {}: {e}", a.id);
            (0, 0, 0)
        });
        for k in keys {
            let (total, mut unread) = counts.get(&(a.id.clone(), k.clone())).copied().unwrap_or((0, 0));
            let is_inbox = k == "inbox";
            if is_inbox {
                unread = inbox;
            }
            out.push(FolderInfo {
                account_id: a.id.clone(),
                name: map.get(&k).cloned().unwrap_or_else(|| k.clone()),
                listed: map.contains_key(&k),
                key: k,
                unread,
                total,
                unread_focused: if is_inbox { focused } else { 0 },
                unread_other: if is_inbox { other } else { 0 },
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
    /// high when a message of the conversation was sent with high importance, else low when one was sent with low importance
    importance: importance::Importance,
}

#[tauri::command]
fn list_threads(state: tauri::State<AppState>, filter: ThreadFilter) -> R<Vec<ThreadSummary>> {
    threads_for(&lock(&state.db), filter)
}

/// Where a conversation lives: the view (mailbox, folder and, in the Inbox, tab) whose list has it. The page asks when a notification is clicked (1.0.7 D-051): the
/// notification of a bulk message is in the Other tab, of another mailbox in that mailbox, and the list the person was looking at is none of them.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ThreadHome {
    account_id: String,
    /// "inbox", "snoozed" (a conversation that is snoozed is in no Inbox list) or the folder key of its newest message
    folder: String,
    /// in the Inbox: a message the Focused list has / one the Other list has (a conversation of both kinds is in both lists)
    focused: bool,
    other: bool,
}

fn thread_home(c: &Connection, thread_id: &str) -> Option<ThreadHome> {
    let mut st = c.prepare("SELECT account_id, folder, list_unsub IS NOT NULL FROM messages WHERE thread_id=?1 ORDER BY date DESC, uid DESC").ok()?;
    let rows: Vec<(String, String, bool)> = st.query_map([thread_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok()?.filter_map(|r| r.ok()).collect();
    let (newest_account, newest_folder, _) = rows.first()?.clone();
    let snoozed = c.query_row("SELECT 1 FROM thread_meta WHERE thread_id=?1 AND snoozed_until>?2", params![thread_id, now()], |_| Ok(())).is_ok();
    let inbox: Vec<&(String, String, bool)> = rows.iter().filter(|r| r.1 == "inbox").collect();
    if snoozed {
        return Some(ThreadHome { account_id: newest_account, folder: "snoozed".into(), focused: false, other: false });
    }
    if let Some(first) = inbox.first() {
        return Some(ThreadHome { account_id: first.0.clone(), folder: "inbox".into(), focused: inbox.iter().any(|r| !r.2), other: inbox.iter().any(|r| r.2) });
    }
    Some(ThreadHome { account_id: newest_account, folder: newest_folder, focused: false, other: false })
}

#[tauri::command]
fn locate_thread(state: tauri::State<AppState>, thread_id: String) -> Option<ThreadHome> {
    thread_home(&lock(&state.db), &thread_id)
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
            w.push(format!("m.folder='inbox' AND {INBOX_NOT_SNOOZED}"));
            p.push(t.into());
        }
        "unread" => {
            w.push(format!("m.folder='inbox' AND m.seen=0 AND {INBOX_NOT_SNOOZED}"));
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
        w.push(INBOX_NOT_BLOCKED.into());
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
                COALESCE(tm.pinned,0), tm.snoozed_until, m.list_unsub IS NOT NULL, m.pgp, m.cal_method, m.importance
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
                r.get::<_, i64>(17)?,
            ))
        })
        .map_err(err)?;
    let mut order: Vec<String> = vec![];
    let mut map: HashMap<String, ThreadSummary> = HashMap::new();
    for row in rows {
        let (tid, mid, acct, folder, subject, fname, femail, snippet, date, seen, flagged, att, pinned, snooze, bulk, pgp, cal, imp) =
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
                importance: importance::Importance::Normal,
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
        e.importance = match (e.importance, importance::Importance::from_db(imp)) {
            (importance::Importance::High, _) | (_, importance::Importance::High) => importance::Importance::High,
            (importance::Importance::Low, _) | (_, importance::Importance::Low) => importance::Importance::Low,
            _ => importance::Importance::Normal,
        };
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
    /// how the sender marked it: normal | high | low
    importance: importance::Importance,
}

const MESSAGE_COLS: &str = "id,account_id,folder,message_id,subject,from_name,from_email,to_addrs,cc_addrs,date,body_html,body_text,
                    seen,flagged,attachments,list_unsub,pgp,pgp_raw,ics,importance";
/// `MESSAGE_COLS` without the body, the invitation and the kept PGP data (same positions: `row_message` reads both).
const MESSAGE_COLS_LIGHT: &str = "id,account_id,folder,message_id,subject,from_name,from_email,to_addrs,cc_addrs,date,NULL,NULL,
                    seen,flagged,attachments,list_unsub,pgp,NULL,NULL,importance";

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
            importance: importance::Importance::from_db(r.get(19)?),
        },
        pgp,
        r.get(17)?,
    ))
}

/// Decrypt / verify a PGP message for display, then read its calendar invitation (also from decrypted content). `a` is the database as a connection the caller holds,
/// or the shared one (`Db`): then it is locked only for the moments that need it, never for the decryption (D-044: a 20 MB draft takes seconds, and every command that
/// waits for the lock waited with it).
fn finish_message<A: pgpstore::Access + ?Sized>(a: &A, m: &mut MessageFull, pgp: i64, raw: Option<Vec<u8>>) {
    apply_pgp(a, m, pgp, raw);
    if let Some(ics) = m.ics.clone() {
        m.invite = Some(a.with(|c| calendar::invite_for(c, &m.account_id, &m.id, &m.folder, &m.from_email, &ics, pgp & pgpmail::FLAG_ENCRYPTED as i64 != 0)));
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

/// What a PGP message that cannot be opened says: no local copy of its data.
fn data_not_here(encrypted: bool) -> Option<pgpmail::Security> {
    encrypted.then(|| pgpmail::Security {
        encrypted: true,
        decryption: "error".into(),
        error: Some("the message data is not on this computer".into()),
        ..Default::default()
    })
}

/// Decrypt / verify a PGP message for display. The decrypted content only lives in the returned value (and the
/// in-memory session cache); it is never written to the database.
fn apply_pgp<A: pgpstore::Access + ?Sized>(a: &A, m: &mut MessageFull, pgp: i64, raw: Option<Vec<u8>>) {
    if pgp == 0 {
        return;
    }
    let encrypted = pgp & pgpmail::FLAG_ENCRYPTED as i64 != 0;
    let Some(raw) = raw else {
        if let Some(sec) = data_not_here(encrypted) {
            m.security = Some(sec);
        }
        return;
    };
    match pgpstore::open_message(a, &m.id, &raw) {
        Ok(o) => {
            a.with(|c| note_signed(c, &m.id, &o.security));
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

/// `apply_pgp` for a caller that wants the state of a message and not its content (opening a draft: `draft_editor_parts` reads the content): the message is opened (the
/// result is kept for the session) and `security` set, nothing of the body is read.
fn apply_pgp_state(db: &Db, m: &mut MessageFull, pgp: i64) {
    if pgp == 0 {
        return;
    }
    let encrypted = pgp & pgpmail::FLAG_ENCRYPTED as i64 != 0;
    let opened = match pgpstore::cached_view(&m.id) {
        Some(o) => Ok(o),
        None => {
            // (the data is read only when the message was not opened in this session: it can be 20 MB)
            let raw: Option<Vec<u8>> = lock(db).query_row("SELECT pgp_raw FROM messages WHERE id=?1", [&m.id], |r| r.get(0)).ok().flatten();
            match raw {
                Some(raw) => pgpstore::open_message(db, &m.id, &raw),
                None => {
                    if let Some(sec) = data_not_here(encrypted) {
                        m.security = Some(sec);
                    }
                    return;
                }
            }
        }
    };
    match opened {
        Ok(o) => {
            note_signed(&lock(db), &m.id, &o.security);
            m.security = Some(o.security.clone());
        }
        Err(e) => m.security = Some(pgpmail::Security { encrypted, decryption: "error".into(), error: Some(e), ..Default::default() }),
    }
}

pub(crate) fn message_full(c: &Connection, message_id: &str) -> R<MessageFull> {
    let (mut m, pgp, raw) = c
        .query_row(&format!("SELECT {MESSAGE_COLS} FROM messages WHERE id=?1"), [message_id], row_message)
        .map_err(|_| "MSG_NOT_FOUND: message not found".to_string())?;
    finish_message(c, &mut m, pgp, raw);
    Ok(m)
}

/// `message_full` for the shared database: it is locked to read the row and for the moments the decryption needs it, not for the decryption itself. `light`: see `get_thread`.
pub(crate) fn message_full_in(db: &Db, message_id: &str, light: bool) -> R<MessageFull> {
    let cols = if light { MESSAGE_COLS_LIGHT } else { MESSAGE_COLS };
    let (mut m, pgp, raw) = lock(db)
        .query_row(&format!("SELECT {cols} FROM messages WHERE id=?1"), [message_id], row_message)
        .map_err(|_| "MSG_NOT_FOUND: message not found".to_string())?;
    if light {
        apply_pgp_state(db, &mut m, pgp);
    } else {
        finish_message(db, &mut m, pgp, raw);
    }
    Ok(m)
}

/// The messages of a conversation. `light` (opening a draft): without the body and the attachment parts of a message (`html`, `text`, the invitation), which a caller that
/// reads them itself (`draft_editor_parts`) would only receive twice - an encrypted message is still opened, for its `security`.
/// Runs on a thread of its own: it decrypts, and a command that is not `async` runs on the main thread of the app and stops every window for as long as it takes (D-044).
#[tauri::command]
async fn get_thread(state: tauri::State<'_, AppState>, thread_id: String, scope: Option<String>, light: Option<bool>) -> R<Vec<MessageFull>> {
    let db = state.db.clone();
    blocking(move || get_thread_in(&db, &thread_id, scope, light.unwrap_or(false))).await
}

fn get_thread_in(db: &Db, thread_id: &str, scope: Option<String>, light: bool) -> R<Vec<MessageFull>> {
    let cols = if light { MESSAGE_COLS_LIGHT } else { MESSAGE_COLS };
    // the rows are read with the lock; the messages are opened without it
    let rows = {
        let c = lock(db);
        let mut st = c
            .prepare(&format!(
                "SELECT {cols} FROM messages WHERE thread_id=?1 AND (folder NOT IN ('trash','junk') OR folder=?2) ORDER BY date ASC"
            ))
            .map_err(err)?;
        let rows = st
            .query_map(params![thread_id, scope.unwrap_or_default()], row_message)
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        rows
    };
    Ok(rows
        .into_iter()
        .map(|(mut m, pgp, raw)| {
            if light {
                apply_pgp_state(db, &mut m, pgp);
            } else {
                finish_message(db, &mut m, pgp, raw);
            }
            m
        })
        .collect())
}

/// What the database knows about a conversation beyond its messages (the pin and the snooze of `thread_meta`): the reader window draws its
/// Pin button from it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMeta {
    pinned: bool,
    snoozed_until: Option<i64>,
}

#[tauri::command]
fn thread_meta(state: tauri::State<AppState>, thread_id: String) -> R<ThreadMeta> {
    thread_meta_in(&lock(&state.db), &thread_id)
}

/// A conversation nobody pinned or snoozed has no row: not pinned, not snoozed.
fn thread_meta_in(c: &Connection, thread_id: &str) -> R<ThreadMeta> {
    let row: Option<(i64, Option<i64>)> = match c.query_row("SELECT pinned, snoozed_until FROM thread_meta WHERE thread_id=?1", [thread_id], |r| Ok((r.get(0)?, r.get(1)?))) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(err(e)),
    };
    let (pinned, snoozed_until) = row.unwrap_or((0, None));
    Ok(ThreadMeta { pinned: pinned != 0, snoozed_until })
}

// ---------- thread actions ----------

#[derive(Clone, Debug)]
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
/// A move to a standard Archive / Trash the server lacks creates it (an action the person asked for).
fn action_impl(db: &Db, thread_ids: Vec<String>, action: String, arg: Option<String>, scope: Option<String>) -> R<()> {
    action_impl_in(db, thread_ids, action, arg, scope, true)
}

/// `action_impl`; `create_missing` says whether a standard folder the server lacks may be created. Filters run by themselves on new mail
/// and do not create folders (REQ-52: they fail visibly instead).
fn action_impl_in(db: &Db, thread_ids: Vec<String>, action: String, arg: Option<String>, scope: Option<String>, create_missing: bool) -> R<()> {
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
            return action_impl_in(db, thread_ids, "junk".into(), None, scope, create_missing);
        }
        _ => {}
    }

    let dst_role = dst_role_of(&action, &arg)?;

    let msgs = thread_msgs(&lock(db), &thread_ids)?;
    act_on_refs(db, msgs, &action, dst_role.as_deref(), &scope, create_missing)
}

/// The folder role a move goes to (None: not a move into a folder).
fn dst_role_of(action: &str, arg: &Option<String>) -> R<Option<String>> {
    Ok(match action {
        "archive" | "trash" | "junk" | "inbox" => Some(action.to_string()),
        "move" => Some(arg.clone().ok_or("move needs a destination folder")?),
        _ => None,
    })
}

/// `action_impl` for messages that are already picked (not a whole conversation): one connection per account.
fn act_on_refs(db: &Db, msgs: Vec<MsgRef>, action: &str, dst_role: Option<&str>, scope: &Option<String>, create_missing: bool) -> R<()> {
    let mut by_acct: HashMap<String, Vec<MsgRef>> = HashMap::new();
    for m in msgs {
        by_acct.entry(m.account_id.clone()).or_default().push(m);
    }
    for (acct_id, list) in by_acct {
        let acc = db::get_account(&lock(db), &acct_id)?;
        let sec = secret(db, &acc)?;
        let mut s = mail::connect(&acc, &sec)?;
        let done = act_on_session(db, &acc, &mut s, &list, action, dst_role, scope, create_missing);
        let _ = s.logout();
        done?;
    }
    Ok(())
}

/// The part of `action_impl` that talks to the server for one account. A local row is changed only after the server did it.
#[allow(clippy::too_many_arguments)]
fn act_on_session<T: std::io::Read + std::io::Write>(
    db: &Db,
    acc: &Account,
    s: &mut imap::Session<T>,
    list: &[MsgRef],
    action: &str,
    dst_role: Option<&str>,
    scope: &Option<String>,
    create_missing: bool,
) -> R<()> {
    let mut folders = Folders { map: fmap(db, &acc.id), listing: None };
    let mut roles: Vec<String> = list.iter().map(|m| m.role.clone()).collect();
    roles.sort();
    roles.dedup();
    for role in roles {
        let group: Vec<&MsgRef> = list.iter().filter(|m| m.role == role).collect();
        let uids: Vec<u32> = group.iter().map(|m| m.uid).collect();
        let src = folders.map.get(&role).cloned().ok_or("source folder unknown")?;
        let is_move = dst_role.is_some() || action == "delete_forever";
        if is_move {
            let allowed = match scope {
                Some(sc) => &role == sc,
                None => !matches!(role.as_str(), "sent" | "drafts" | "trash" | "junk"),
            };
            if !allowed {
                continue;
            }
        }
        match action {
            "read" | "unread" => {
                // (F-16/F-17) a sync that read the old flags must not write them over this change: see `flagguard`
                let _writing = flagguard::GUARD.writing(group.iter().map(|m| (acc.id.clone(), role.clone(), m.uid)));
                mail::store_flag(s, &src, &uids, "\\Seen", action == "read")?;
                let c = lock(db);
                for m in &group {
                    c.execute("UPDATE messages SET seen=?1 WHERE id=?2", params![(action == "read") as i64, m.id])
                        .map_err(err)?;
                }
            }
            "star" | "unstar" => {
                let _writing = flagguard::GUARD.writing(group.iter().map(|m| (acc.id.clone(), role.clone(), m.uid)));
                mail::store_flag(s, &src, &uids, "\\Flagged", action == "star")?;
                let c = lock(db);
                for m in &group {
                    c.execute("UPDATE messages SET flagged=?1 WHERE id=?2", params![(action == "star") as i64, m.id])
                        .map_err(err)?;
                }
            }
            "delete_forever" => {
                mail::delete_forever(s, &src, &uids)?;
                let c = lock(db);
                for m in &group {
                    c.execute("DELETE FROM messages WHERE id=?1", [&m.id]).map_err(err)?;
                }
            }
            _ => {
                let dst = dst_role.ok_or_else(|| format!("unknown action: {action}"))?;
                if dst == role {
                    continue;
                }
                if dst == "trash" && role == "trash" {
                    continue;
                }
                move_to_role(db, acc, s, &mut folders, &src, &uids, dst, create_missing)?;
                let c = lock(db);
                for m in &group {
                    c.execute("DELETE FROM messages WHERE id=?1", [&m.id]).map_err(err)?;
                }
            }
        }
    }
    Ok(())
}

/// The account's folders while an action runs: the saved list (from the last sync), replaced by a fresh LIST once that is needed.
struct Folders {
    map: HashMap<String, String>,
    /// set once this action has asked the server (so it asks only once)
    listing: Option<mail::Listing>,
}

/// Move messages to the folder of a role. The saved folder list is tried first (the usual case costs nothing extra). When that fails
/// or has no such folder, the server is asked (LIST) before giving up: a folder made, renamed or removed since the last sync is
/// then found (F-14: the saved list was only refreshed by a sync, so an Archive that appeared during the session stayed unknown
/// until the next start). A standard Archive / Trash the server still lacks is created when `create_missing`; if that is not
/// possible the error says so and nothing was moved (the caller keeps the local mail).
#[allow(clippy::too_many_arguments)]
fn move_to_role<T: std::io::Read + std::io::Write>(
    db: &Db,
    acc: &Account,
    s: &mut imap::Session<T>,
    folders: &mut Folders,
    src: &str,
    uids: &[u32],
    dst: &str,
    create_missing: bool,
) -> R<()> {
    let tried = folders.map.get(dst).cloned();
    let mut first_error = None;
    if let Some(name) = &tried {
        match mail::move_to(s, src, uids, name) {
            Ok(()) => return Ok(()),
            Err(e) => first_error = Some(e),
        }
    }
    let (name, created) = resolve_folder(db, acc, s, folders, dst, create_missing)?;
    if !created && tried.as_ref() == Some(&name) {
        // the server has the folder we tried: the move failed for another reason
        return Err(first_error.unwrap_or_else(|| folder_missing(dst)));
    }
    mail::move_to(s, src, uids, &name)
}

/// The server folder for a role, looked up on the server: the saved list is replaced by a fresh LIST (once per action), and a standard
/// Archive / Trash the server still lacks is created when `create_missing`. Returns the folder name and whether it was just created.
fn resolve_folder<T: std::io::Read + std::io::Write>(
    db: &Db,
    acc: &Account,
    s: &mut imap::Session<T>,
    folders: &mut Folders,
    dst: &str,
    create_missing: bool,
) -> R<(String, bool)> {
    if folders.listing.is_none() {
        let listing = mail::list_folders(s)?;
        folders.map = listing.map.clone();
        folders.listing = Some(listing);
        save_fmap(db, &acc.id, &folders.map)?;
    }
    if let Some(n) = folders.map.get(dst).cloned() {
        return Ok((n, false));
    }
    let create = if create_missing { folders.listing.as_ref().and_then(|l| mail::name_to_create(dst, l)) } else { None };
    let Some(create) = create else {
        return Err(if create_missing { folder_missing(dst) } else { format!("no '{dst}' folder on this account") });
    };
    mail::create_folder(s, &create).map_err(|why| folder_not_created(dst, &why))?;
    folders.map.insert(dst.to_string(), create.clone());
    save_fmap(db, &acc.id, &folders.map)?;
    Ok((create, true))
}

/// (OBS-1) Make sure the folder a move is going to exists BEFORE the person is told "Archived": the saved list is trusted when it names
/// the folder (the usual case: no server call at all), otherwise the server is asked and a missing Archive / Trash is created now.
/// When that is impossible the error is the one the move would have given after the Undo time, but at once, and nothing was queued.
fn prepare_on_session<T: std::io::Read + std::io::Write>(db: &Db, acc: &Account, s: &mut imap::Session<T>, dst: &str) -> R<()> {
    let mut folders = Folders { map: fmap(db, &acc.id), listing: None };
    if folders.map.contains_key(dst) {
        return Ok(());
    }
    resolve_folder(db, acc, s, &mut folders, dst, true).map(|_| ())
}

/// Every (account, destination role, whether the saved folder list names that folder) a move of these conversations goes to, with the same
/// skips as the move itself (`act_on_session`: the view it is done from, mail already there, a delete from the Trash that removes for good).
/// Not a move (read, star, pin, snooze ...): nothing.
fn move_targets(db: &Db, thread_ids: &[String], action: &str, arg: Option<&str>, scope: &Option<String>) -> R<Vec<(String, String, bool)>> {
    let dst = match action {
        "archive" | "trash" | "junk" | "inbox" => action,
        "block" => "junk",
        "move" => arg.ok_or("move needs a destination folder")?,
        _ => return Ok(vec![]),
    };
    let msgs = thread_msgs(&lock(db), thread_ids)?;
    let mut out: Vec<(String, String, bool)> = vec![];
    for m in msgs {
        let allowed = match scope {
            Some(sc) => &m.role == sc,
            None => !matches!(m.role.as_str(), "sent" | "drafts" | "trash" | "junk"),
        };
        if !allowed || m.role == dst || (dst == "trash" && m.role == "trash") {
            continue;
        }
        if !out.iter().any(|(a, d, _)| *a == m.account_id && d == dst) {
            let cached = fmap(db, &m.account_id).contains_key(dst);
            out.push((m.account_id.clone(), dst.to_string(), cached));
        }
    }
    Ok(out)
}

/// The accounts and destination roles whose saved folder list does not name the destination (those need the server now: `prepare_on_session`).
#[cfg(test)]
fn targets_to_prepare(db: &Db, thread_ids: &[String], action: &str, arg: Option<&str>, scope: &Option<String>) -> R<Vec<(String, String)>> {
    Ok(move_targets(db, thread_ids, action, arg, scope)?.into_iter().filter(|t| !t.2).map(|t| (t.0, t.1)).collect())
}

/// Resolve (find, refresh, create) the destination folder of a move on the server, before the move is queued, for the folders the saved
/// list does not name. Returns true when the saved list was trusted for at least one destination: the caller must then have it checked
/// in the background while the Undo window runs (`queue_action` with `verify`), because the folder may be gone since the last sync (BUG-1).
fn prepare_action_impl(db: &Db, thread_ids: &[String], action: &str, arg: Option<&str>, scope: &Option<String>) -> R<bool> {
    let targets = move_targets(db, thread_ids, action, arg, scope)?;
    for (acct_id, dst, _) in targets.iter().filter(|t| !t.2) {
        let acc = db::get_account(&lock(db), acct_id)?;
        let sec = secret(db, &acc)?;
        let mut s = mail::connect(&acc, &sec)?;
        let done = prepare_on_session(db, &acc, &mut s, dst);
        let _ = s.logout();
        done?;
    }
    Ok(targets.iter().any(|t| t.2))
}

/// (BUG-1) Look at the server for the folder a move goes to although the saved folder list names it: a fresh LIST replaces the saved list
/// (a renamed folder is found), a folder that is gone is created again (Archive / Trash), and when that is impossible the same coded error
/// as in `prepare_on_session` comes back. Nothing is moved.
fn verify_on_session<T: std::io::Read + std::io::Write>(db: &Db, acc: &Account, s: &mut imap::Session<T>, dst: &str) -> R<()> {
    let mut folders = Folders { map: fmap(db, &acc.id), listing: None };
    resolve_folder(db, acc, s, &mut folders, dst, true).map(|_| ())
}

fn verify_targets(db: &Db, targets: &[(String, String)]) -> R<()> {
    for (acct_id, dst) in targets {
        let acc = db::get_account(&lock(db), acct_id)?;
        let sec = secret(db, &acc)?;
        let mut s = mail::connect(&acc, &sec)?;
        let done = verify_on_session(db, &acc, &mut s, dst);
        let _ = s.logout();
        done?;
    }
    Ok(())
}

/// (OBS-1) Called by the app before it hides the mail and shows "Archived" / "Deleted ...": fails at once when the target folder cannot be
/// found or created, so the success message never comes before the error. The answer says whether the saved folder list was trusted for a
/// folder (true = ask `queue_action` to check it on the server during the Undo window).
#[tauri::command]
async fn prepare_action(
    state: tauri::State<'_, AppState>,
    thread_ids: Vec<String>,
    action: String,
    arg: Option<String>,
    scope: Option<String>,
) -> R<bool> {
    let db = state.db.clone();
    blocking(move || prepare_action_impl(&db, &thread_ids, &action, arg.as_deref(), &scope)).await
}

fn save_fmap(db: &Db, account_id: &str, map: &HashMap<String, String>) -> R<()> {
    db::set_setting(&lock(db), &format!("fmap:{account_id}"), &serde_json::to_string(map).map_err(err)?)
}

/// How a role is named in a message: Archive, Trash, Junk, or the folder's own name.
fn role_label(role: &str) -> String {
    match role {
        "archive" => "Archive".into(),
        "trash" => "Trash".into(),
        "junk" => "Junk".into(),
        r => r.strip_prefix("f:").unwrap_or(r).to_string(),
    }
}

fn folder_missing(role: &str) -> String {
    let folder = role_label(role);
    i18n::coded("FOLDER_MISSING", &[("folder", &folder)], &format!("Couldn’t find the {folder} folder on this account. The mail stays where it is."))
}

fn folder_not_created(role: &str, why: &str) -> String {
    let folder = role_label(role);
    i18n::coded(
        "FOLDER_NOT_CREATED",
        &[("folder", &folder), ("why", why)],
        &format!("Couldn’t find or create the {folder} folder on this account ({why}). The mail stays where it is."),
    )
}

#[tauri::command]
async fn thread_action(
    app: tauri::AppHandle,
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
    let (ids, what) = (thread_ids.clone(), action.clone());
    blocking(move || action_impl(&db, thread_ids, action, arg, scope)).await?;
    // a reader window open on one of these conversations shows the new state (read / flag / pin / snooze) from the database
    let _ = app.emit(popout::THREAD_STATE_EVENT, serde_json::json!({ "threadIds": ids, "action": what }));
    Ok(())
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
    let opened = pgpstore::open_message(db, message_id, &raw)?;
    match &opened.plain {
        Some(plain) => {
            let metas = mail::parse(0, plain, true, false, 0).map(|p| p.attachments).unwrap_or_default();
            Ok((plain.clone(), serde_json::to_string(&metas).unwrap_or_else(|_| "[]".into())))
        }
        None => Err(not_opened_error(&opened)),
    }
}

/// Why an encrypted message has no content to show: the key is locked (the page asks for the passphrase), or the reason it cannot be decrypted.
fn not_opened_error(opened: &pgpmail::Opened) -> String {
    match &opened.security.locked_key {
        Some(f) => format!("PGP_LOCKED:{f}"),
        None => match opened.security.error.clone() {
            Some(e) => format!("PGP_FAILED: {e}"),
            None => "PGP_CANT_DECRYPT: this message can't be decrypted".to_string(),
        },
    }
}

/// Confidential mail (sender's Sensitivity / label, see mail::is_confidential) must not leave the app: the UI hides these
/// actions, and this refuses them here too. Showing a picture or previewing an attachment inside the app stays allowed.
pub(crate) fn ensure_not_confidential(c: &Connection, message_id: &str) -> R<()> {
    let pgp: i64 = c.query_row("SELECT pgp FROM messages WHERE id=?1", [message_id], |r| r.get(0)).unwrap_or(0);
    if pgp & pgpmail::FLAG_CONFIDENTIAL as i64 != 0 {
        return Err("CONFIDENTIAL: This message is confidential, so that isn’t allowed.".into());
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

/// The headers an answer to this message needs (Reply-To, Message-ID, the References of the answer), read from the message as the server
/// holds it. Only headers: allowed for confidential mail too (the answer to it is confidential as well).
#[tauri::command]
async fn reply_headers(state: tauri::State<'_, AppState>, message_id: String) -> R<replyhdr::ReplyHeaders> {
    let db = state.db.clone();
    blocking(move || {
        let downloaded = rawcache::get(&message_id).is_some();
        let (raw, _) = fetch_raw_for(&db, &message_id)?;
        let h = replyhdr::from_raw(&raw);
        // so that a Reply that did not go where the sender asked can be explained afterwards (the page drops the Reply-To addresses that are the person's own accounts)
        let own: Vec<String> = lock(&db)
            .prepare("SELECT email FROM accounts")
            .and_then(|mut q| q.query_map([], |r| r.get::<_, String>(0))?.collect())
            .unwrap_or_default();
        startup::line("reply", &replyhdr::log_text(&h, if downloaded { "body" } else { "fetch" }, &own));
        Ok(h)
    })
    .await
}

/// Folder for "Save" (Settings → Attachments), falling back to the system Downloads folder, and then to the home folder.
fn download_folder(app: &tauri::AppHandle, db: &Db) -> R<std::path::PathBuf> {
    let (dir, replaced) = pick_save_dir(setting(db, "download_dir").as_deref(), app.path().download_dir().ok(), app.path().home_dir().ok())?;
    // a chosen folder that is gone (or no Downloads folder that can be used, a bare Linux install) is no secret: say so (once per folder
    // and session) instead of quietly saving elsewhere
    if let Some(bad) = replaced.filter(|b| first_time_for(&DOWNLOAD_WARNED, b)) {
        let _ = app.emit_to("main", "download-dir-fallback", serde_json::json!({ "configured": bad, "used": dir.to_string_lossy() }));
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

/// Whether files can be written into `dir`: it is a folder (with `create`, one that is created now when nothing is there) and a file
/// can be made in it. Checked by doing it (a read-only folder, a full disk, a permission the mode bits do not show).
fn usable_dir(dir: &std::path::Path, create: bool) -> bool {
    if !dir.is_dir() && !(create && !dir.exists() && std::fs::create_dir_all(dir).is_ok()) {
        return false;
    }
    let probe = dir.join(format!(".heylook-write-test-{}", uuid::Uuid::new_v4()));
    let made = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_ok();
    let _ = std::fs::remove_file(&probe);
    made
}

/// The folder attachments are saved to, in this order: the configured one when it is a folder that can be written to; the system
/// Downloads folder (created when it is missing: an XDG profile whose `~/Downloads` was never made, or was moved away); the home
/// folder. The second value says why the first choice was not used, for the notice: the configured path, or "Downloads".
fn pick_save_dir(
    configured: Option<&str>,
    download: Option<std::path::PathBuf>,
    home: Option<std::path::PathBuf>,
) -> R<(std::path::PathBuf, Option<String>)> {
    let mut replaced = None;
    if let Some(p) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        if usable_dir(std::path::Path::new(p), false) {
            return Ok((p.into(), None));
        }
        replaced = Some(p.to_string());
    }
    if let Some(d) = download {
        if usable_dir(&d, true) {
            return Ok((d, replaced));
        }
    }
    let replaced = replaced.unwrap_or_else(|| "Downloads".to_string());
    match home {
        Some(h) if usable_dir(&h, false) => Ok((h, Some(replaced))),
        _ => Err("NO_SAVE_FOLDER: No folder to save into: set one in Settings > Mailboxes > Reading & sync.".into()),
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
            let Some(p) = app.dialog().file().set_title(i18n::tr(i18n::K::SaveAttachmentsTo)).blocking_pick_folder() else {
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
        return Err("LINK_NOT_OPENED: That kind of link is not opened.".into()); // the same schemes as the opener plugin allows
    }
    blocking(move || open_target(&app, &url, true)).await
}

/// Put text on the system clipboard. The page calls this first on Linux and macOS, where the web view's own clipboard call
/// (`navigator.clipboard`) is not available to a page that does not run in a secure context or has no user gesture left (the
/// "link is copied" toast after a failed open copied nothing, QA BUG-L4; a copy that follows a backend call, "Copy public key", is refused by
/// WKWebView). Linux: the text goes to the GTK clipboard the web view and every other GTK program use. macOS: the general pasteboard
/// (`macclip::write`). Both run on the main thread and give up after 3 s. Windows reports that it is not available (the page's clipboard works).
#[tauri::command]
async fn copy_text(app: tauri::AppHandle, text: String) -> R<()> {
    if copy_forced_to_fail() {
        return Err("the clipboard is switched off for this test run".into());
    }
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
    #[cfg(target_os = "macos")]
    {
        blocking(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || {
                let _ = tx.send(macclip::write(&text));
            })
            .map_err(err)?;
            rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "the clipboard did not answer".to_string())?
        })
        .await
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, text);
        Err("copying from the backend is only available on Linux and macOS".into())
    }
}

/// The text on the system clipboard (plain text and HTML, either may be empty). The page calls this on macOS, for Cmd+Shift+V in the
/// editors: WKWebView sends no `paste` event for that key (it is not an accelerator of the Edit menu), and `navigator.clipboard.readText()`
/// would ask the person to click a "Paste" button first. Linux reads it too, for Ctrl+Shift+V when the web view pasted nothing (W2.23). Windows reports that it is not available (it pastes through the `paste` event).
#[derive(serde::Serialize)]
struct ClipboardText {
    text: String,
    html: String,
}

#[tauri::command]
async fn read_clipboard_text(app: tauri::AppHandle) -> R<ClipboardText> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        blocking(|| macclip::read().map(|c| ClipboardText { text: c.text, html: c.html })).await
    }
    // Linux (W2.23): Ctrl+Shift+V pastes "as plain text" from the text part of the GTK clipboard only; the page asks here when that pasted nothing (a clipboard with HTML only).
    // GTK is used on the main thread only (as in `copy_text`); the `text/html` part comes as bytes, decoded by clipdecode.
    #[cfg(target_os = "linux")]
    {
        blocking(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || {
                let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
                let text = clipboard.wait_for_text().map(|t| t.to_string()).unwrap_or_default();
                let html = clipboard
                    .wait_for_contents(&gtk::gdk::Atom::intern("text/html"))
                    .map(|d| clipdecode::html_from_clipboard_bytes(&d.data()))
                    .unwrap_or_default();
                let _ = tx.send(ClipboardText { text, html });
            })
            .map_err(err)?;
            rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "the clipboard did not answer".to_string())
        })
        .await
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        Err("reading the clipboard from the backend is only available on macOS and Linux".into())
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

/// Show a saved file selected in Explorer / Finder / the file manager. On Linux the file manager must be on the session bus to select the
/// file; when it is not, the folder that holds the file is opened instead (`linuxopen::reveal_fallback_dir`), and only when that fails too
/// the error goes to the page (which shows it, `src/reveal.ts`). Windows and macOS: Explorer / Finder select the file, no fallback.
#[tauri::command]
async fn attachment_reveal(app: tauri::AppHandle, path: String) -> R<()> {
    blocking(move || {
        let p = std::path::PathBuf::from(&path);
        if !p.is_absolute() || !p.exists() {
            return Err("FILE_GONE: That file no longer exists.".to_string());
        }
        let shown = app.opener().reveal_item_in_dir(&p).map_err(err);
        #[cfg(target_os = "linux")]
        {
            if shown.is_err() {
                if let Some(dir) = linuxopen::reveal_fallback_dir(&p) {
                    if linuxopen::open(&dir.to_string_lossy(), false).is_ok() {
                        return Ok(());
                    }
                }
            }
        }
        shown
    })
    .await
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
    // the Sent copy is byte for byte the DATA the server received (smtp::as_data)
    let (wire, raw) = smtp::as_data(&raw);
    smtp::send_raw(&acc, &smtp_secret(db, &acc)?, &env, wire)?;
    // the message is out: the one it answers or forwards gets its flag on its own server (in the background; a failure is a line in the log, never the send's)
    flag_original(db, d);
    let h = acc.smtp_host.to_lowercase();
    let auto_saves = h.contains("gmail") || h.contains("googlemail") || h.contains("office365") || h.contains("outlook");
    if !auto_saves {
        // best effort, after the send went through: a copy that cannot be stored is a line in the log, never an error of the send
        match mail::connect(&acc, &sec) {
            Ok(mut s) => {
                if let Err(e) = store_sent_copy(db, &acc, &mut s, &raw) {
                    startup::line("send", &format!("account {}: the sent message was sent, but no copy was stored in a Sent folder: {e}", acc.id));
                }
                let _ = s.logout();
            }
            Err(e) => startup::line("send", &format!("account {}: the sent message was sent, but no copy was stored (no connection to the mail server: {e})", acc.id)),
        }
    }
    Ok(())
}

/// W2.22 CF-18: after an answer or a forward went out, the original gets `\Answered` / `$Forwarded` on the server it is on. Best effort and off the send's
/// path: its own connection on its own thread, every failure (no connection, the original is gone or was never synced, a server that refuses the keyword)
/// goes to the log and nothing else. Nothing is shown in the app (the flags are not read back in 1.0.7).
fn flag_original(db: &Db, d: &smtp::Draft) {
    let Some(a) = d.answers.clone() else { return };
    if let Some(why) = answers_problem(&a) {
        startup::line("send", &format!("the original of {} could not be flagged ({}): {why}", a.kind, a.account_id));
        return;
    }
    let db = db.clone();
    std::thread::spawn(move || {
        if let Err(e) = flag_original_now(&db, &a) {
            startup::line("send", &format!("the original of {} could not be flagged ({}): {e}", a.kind, a.account_id));
        }
    });
}

/// Why the original that `a` names cannot be flagged before any server is asked (None: it can be tried). For the log only.
fn answers_problem(a: &smtp::Answers) -> Option<&'static str> {
    if draftmail::answers_valid(a) {
        None
    } else if a.message_id.len() <= 2 || !a.message_id.starts_with('<') || !a.message_id.ends_with('>') {
        Some("the original has no usable Message-ID (it is empty or not in angle brackets)")
    } else {
        Some("the record of the original is not one this app wrote (an odd kind, account id or Message-ID)")
    }
}

fn flag_original_now(db: &Db, a: &smtp::Answers) -> R<()> {
    let acc = db::get_account(&lock(db), &a.account_id)?;
    let sec = secret(db, &acc)?;
    let mut s = mail::connect(&acc, &sec)?;
    let done = flag_on_session(db, &acc, &mut s, a);
    let _ = s.logout();
    done
}

/// What the search of the local store for the original answered; the reason for the log when it found nothing. The store is searched by Message-ID: a message
/// that IS in the store but has no Message-ID of its own (or another one than the header the server sends now) is not found either, so the line says what was
/// looked for and not that the message is gone (1.0.7 WP2a QA BUG-4).
fn original_found(found: rusqlite::Result<(String, u32)>) -> R<(String, u32)> {
    match found {
        Ok(x) => Ok(x),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err("no message of this account in the local store has the Message-ID of the original (it was removed, or the store has it without a Message-ID or with another one)".to_string()),
        Err(e) => Err(format!("the local store could not be read: {e}")),
    }
}

/// The part of `flag_original` that talks to the server: found by its Message-ID in the local store (it may have been archived since), in the folder it is
/// in now. At most one STORE.
fn flag_on_session<T: std::io::Read + std::io::Write>(db: &Db, acc: &Account, s: &mut imap::Session<T>, a: &smtp::Answers) -> R<()> {
    let found = lock(db).query_row(
        "SELECT folder, uid FROM messages WHERE account_id=?1 AND message_id=?2 AND folder!='drafts' ORDER BY (folder='inbox') DESC, uid DESC LIMIT 1",
        params![acc.id, a.message_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)),
    );
    let (role, uid) = original_found(found)?;
    let folder = fmap(db, &acc.id).get(&role).cloned().ok_or("the folder of the original is unknown")?;
    let flag = if a.kind == "forwarded" { "$Forwarded" } else { "\\Answered" };
    mail::store_flag(s, &folder, &[uid], flag, true)
}

/// Put the copy of a sent message into the account's Sent folder, with the F-14 rule for a missing folder: the saved name first; when
/// there is none, or the server refuses it, a fresh LIST (the server may have created or renamed the folder, and its SPECIAL-USE flag or
/// a standard name tells which); when the server has no Sent folder at all, `Sent` is created (`INBOX.Sent` on a server that keeps its
/// folders in the INBOX namespace). The saved folder list is refreshed on the way. Errors are for the log: the caller sends anyway.
fn store_sent_copy<T: std::io::Read + std::io::Write>(db: &Db, acc: &Account, s: &mut imap::Session<T>, raw: &[u8]) -> R<()> {
    let saved = fmap(db, &acc.id).get("sent").cloned();
    let mut first_error = None;
    if let Some(name) = &saved {
        match mail::append(s, name, raw, false) {
            Ok(()) => return Ok(()),
            Err(e) => first_error = Some(e),
        }
    }
    let listing = mail::list_folders(s)?;
    save_fmap(db, &acc.id, &listing.map)?;
    let (name, created) = match listing.map.get("sent").cloned() {
        Some(n) => (n, false),
        None => {
            let create = mail::name_to_create("sent", &listing).ok_or("no Sent folder on this account")?;
            mail::create_folder(s, &create).map_err(|why| format!("no Sent folder on this account and it could not be created ({why})"))?;
            let mut map = listing.map.clone();
            map.insert("sent".to_string(), create.clone());
            save_fmap(db, &acc.id, &map)?;
            (create, true)
        }
    };
    if !created && saved.as_ref() == Some(&name) {
        // the server has the folder we tried: the append failed for another reason
        return Err(first_error.unwrap_or_else(|| "the Sent folder refused the message".to_string()));
    }
    mail::append(s, &name, raw, false)
}

/// The bytes to send and their envelope. Encrypted or signed messages (PGP/MIME) are built here, or were built
/// when they were scheduled (`prebuilt`), so they are never sent in the clear by accident.
fn finished_message(db: &Db, acc: &Account, d: &smtp::Draft) -> R<(Vec<u8>, lettre::address::Envelope)> {
    if let Some(pre) = &d.prebuilt {
        let raw = base64::engine::general_purpose::STANDARD.decode(pre).map_err(err)?;
        // built when it was scheduled (or held for Undo): it goes out with the date of the send, not the day it was built (W2.22 CF-24)
        let raw = smtp::restamp_date(&raw, chrono::Local::now().fixed_offset());
        return Ok((raw, smtp::envelope(acc, d)?));
    }
    let sec = d.security.clone().unwrap_or_default();
    let msg = if sec.encrypt || sec.sign { pgpstore::build_secure(db, acc, d, false)? } else { smtp::build(acc, d)? };
    Ok((smtp::wire(&msg), msg.envelope().clone()))
}

/// The most a draft may hold: the text of the message and of the pictures and files in it as the page keeps them (base64), in bytes. A draft is
/// built into one message in memory (the pictures and files again as base64 lines, encrypted drafts once more as armor: five to seven copies of
/// the data at the same time) and appended to the server in one piece; far above the 25 MB a message may be sent with (`sendSize.ts`) is
/// still allowed for a draft, since the person is taking pictures out or splitting the message, but not without a bound (D-025: 20 MB of pictures
/// stopped the app for half an hour). `DRAFT_LIMIT` of src/sendSize.ts is the same number (the page does not even ask; scripts/test-send-size.mjs
/// compares the two).
const DRAFT_LIMIT: usize = 100 * 1024 * 1024;

/// What a draft weighs for `DRAFT_LIMIT`: the characters of its HTML, text, pictures, files and finished bytes.
fn draft_size(d: &smtp::Draft) -> usize {
    d.html.len()
        + d.text.len()
        + d.attachments.iter().map(|a| a.data_base64.len()).sum::<usize>()
        + d.inline.iter().map(|i| i.data_base64.len()).sum::<usize>()
        + d.prebuilt.as_ref().map_or(0, |p| p.len())
}

fn ensure_draft_size(d: &smtp::Draft) -> R<()> {
    let size = draft_size(d);
    if size <= DRAFT_LIMIT {
        return Ok(());
    }
    let mb = |n: usize| format!("{} MB", n.div_ceil(1024 * 1024));
    let (size, limit) = (mb(size), mb(DRAFT_LIMIT));
    Err(i18n::coded(
        "DRAFT_TOO_LARGE",
        &[("size", &size), ("limit", &limit)],
        &format!("This message is too large to keep as a draft ({size}; the limit is {limit}). Remove attachments or shrink pictures."),
    ))
}

/// What goes into the Drafts folder. THE RULE (W2.4): a draft is encrypted to your own key only, whoever its recipients are and whether or not
/// their keys are known; the recipients' keys are used when the message is sent. "Encrypt drafts" off is decided by the page: it sends such a
/// draft without `security`, and it is stored as a plain draft.
fn draft_bytes(db: &Db, acc: &Account, d: &smtp::Draft) -> R<Vec<u8>> {
    ensure_draft_size(d)?;
    let sec = d.security.clone().unwrap_or_default();
    if sec.encrypt {
        // a scheduled message that was sealed is for its recipients and the account ("Move to Drafts"): it is opened with your key and encrypted
        // again for your key only, so the stored draft is like every other one (a locked key asks for its passphrase: PGP_LOCKED)
        // (no copy of the pictures unless something has to change: a draft with 100 MB of them is not held twice)
        let d: std::borrow::Cow<smtp::Draft> = if d.prebuilt.is_some() { std::borrow::Cow::Owned(pgpstore::unseal_from_outbox(db, acc, d)?) } else { std::borrow::Cow::Borrowed(d) };
        // the meeting header is plain text outside the encryption: an encrypted draft keeps its meeting on this computer only (`remember_meeting`)
        // (`answers` is also plain text outside the encryption: an encrypted draft that is sent later does not flag what it answered)
        let d = if d.meeting_form.is_some() || d.answers.is_some() {
            let mut own = d.into_owned();
            own.meeting_form = None;
            own.answers = None;
            std::borrow::Cow::Owned(own)
        } else {
            d
        };
        return Ok(smtp::wire(&pgpstore::build_secure(db, acc, &d, true)?));
    }
    Ok(smtp::wire(&smtp::build_draft(acc, d)?))
}

/// The meeting of a draft that was just appended is also kept on this computer, by Message-ID: a server that drops the header it does not know
/// would otherwise take the meeting with it (BUG-R3-4). Failures do not matter: the header is the copy that travels.
fn remember_draft_meeting(db: &Db, acc: &Account, raw: &[u8], d: &smtp::Draft) {
    if let Some(blob) = d.meeting_form.as_deref() {
        draftmail::remember_meeting(&lock(db), &acc.id, raw, blob);
    }
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
        let draft = pgpstore::seal_for_outbox(&db, &acc, &draft)?;
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
        let (payload, _attempts) = claim_outbox(&db, &id, &["undo"])?.ok_or("OUTBOX_GONE: This message is no longer waiting to be sent.")?;
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
        draftmail::forget_original(&lock(db), &t); // (the message is over: the version that was opened is not needed any more)
        if let Err(e) = draftmail::drop_draft(db, &t) {
            startup::line("draft", &format!("the draft that a sent or scheduled message was written from could not be removed: {e}"));
        }
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
            let draft = pgpstore::seal_for_outbox(&db, &acc, &draft)?;
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

/// What Save draft tells the interface: the thread the draft will have, and the reference to give to the next save (or to the send) so that
/// it replaces exactly this draft (`draftmail::drop_draft`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedDraft {
    thread_id: Option<String>,
    draft_ref: Option<String>,
}

/// W13.5: a draft with nothing in it is never written to the server. "Nothing" = no subject, no non-white-space text, no attachment, no inline
/// picture and no meeting place. The page never asks for such a save (it checks first and says "Nothing to save yet"); this is the last guard, for a
/// caller that does (an older page, a snapshot of recipients only). A draft that carries finished bytes (`prebuilt`, a scheduled message) is not judged.
fn ensure_draft_has_content(d: &smtp::Draft) -> R<()> {
    use base64::Engine;
    if d.prebuilt.is_some() || !d.subject.trim().is_empty() || !d.text.trim().is_empty() || !d.attachments.is_empty() || !d.inline.is_empty() {
        return Ok(());
    }
    let place = |l: &str| !l.trim().is_empty();
    // the meeting strip with a place typed (the place is in the parsed meeting, or in the form of the strip as the page wrote it)
    if d.meeting.as_ref().and_then(|m| m.location.as_deref()).is_some_and(place) {
        return Ok(());
    }
    let form_place = d
        .meeting_form
        .as_deref()
        .and_then(draftmail::meeting_blob)
        .and_then(|b| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("where").and_then(|w| w.as_str()).map(place));
    if form_place == Some(true) {
        return Ok(());
    }
    Err("DRAFT_EMPTY: There is nothing to save yet.".into())
}

/// A big picture or attachment of a draft, sent ahead of `save_draft` (see draftupload.rs): the page sends the data of each part in a request of its own, so that no request is
/// big enough to hold the app's main thread (D-045).
#[tauri::command]
fn draft_upload(id: String, data_base64: String) {
    draftupload::put(id, data_base64);
}

#[tauri::command]
async fn save_draft(state: tauri::State<'_, AppState>, draft: smtp::Draft, replaces: Option<String>, uploads: Option<Vec<draftupload::UploadRef>>) -> R<SavedDraft> {
    let mut draft = draft;
    draftupload::resolve(&mut draft, uploads)?;
    ensure_draft_has_content(&draft)?;
    ensure_draft_size(&draft)?; // (before the keyring is read and a connection is made)
    let db = state.db.clone();
    blocking(move || {
        let acc = db::get_account(&lock(&db), &draft.account_id)?;
        let sec = secret(&db, &acc)?;
        let raw = draft_bytes(&db, &acc, &draft)?;
        let mut s = mail::connect(&acc, &sec)?;
        let saved = save_draft_on(&db, &acc, &mut s, &raw, replaces);
        let _ = s.logout();
        if saved.is_ok() {
            remember_draft_meeting(&db, &acc, &raw, &draft);
        }
        saved
    })
    .await
}

/// The part of `save_draft` that talks to the server: append the draft, keep the version that was opened (the first save of an opened draft,
/// see draftmail.rs "The version of a draft as it was opened"), and remove the draft this one replaces.
fn save_draft_on<T: std::io::Read + std::io::Write>(db: &Db, acc: &Account, s: &mut imap::Session<T>, raw: &[u8], replaces: Option<String>) -> R<SavedDraft> {
    let folder = folder_for(db, acc, "drafts")?;
    let target = replaces.as_deref().map(draftmail::Target::parse);
    // read before the append: the opened message is the one this save is about to replace. The bytes remembered when the draft was opened come first (the
    // local row may be gone by now); the row is the fallback.
    let opened_id = match &target {
        Some(draftmail::Target::Local(id)) => Some(id.clone()),
        _ => None,
    };
    let opened = match &opened_id {
        Some(id) => match draftmail::opened_from_memory(id) {
            Some(bytes) => Some(bytes),
            None => match draftmail::read_opened(db, s, acc, id) {
                Ok(bytes) => Some(bytes),
                Err(e) => {
                    startup::line("draft", &format!("account {}: the opened version of a draft could not be read, Discard cannot put it back: {e}", acc.id));
                    None
                }
            },
        },
        None => None,
    };
    // the draft being replaced is not in the local store any more (a sync removed it, another save replaced it): it is found on the server by its own Message-ID
    let opened_row_gone = opened_id.as_deref().is_some_and(|id| !draftmail::local_draft_exists(db, &acc.id, id));
    mail::append(s, &folder, raw, true)?;
    let draft_ref = draftmail::draft_ref(&acc.id, raw);
    if let Some(t) = replaces {
        // never remove the draft that was just appended (a reference to its own Message-ID)
        if draft_ref.as_deref() == Some(t.as_str()) {
            startup::line("draft", &format!("account {}: the draft to replace is the one just saved, nothing removed", acc.id));
        } else {
            draftmail::note_save_on(db, &acc.id, opened.as_deref(), target.as_ref(), draft_ref.as_deref());
            if let Some(id) = &opened_id {
                draftmail::forget_opened_memory(id);
            }
            let dropped = match target.as_ref() {
                Some(draftmail::Target::Thread(_)) | None => draftmail::drop_draft(db, &t), // (a conversation id of an older caller: its own connection)
                // the opened draft by its local row (its UID), then ALWAYS by its own Message-ID (from the bytes that were remembered or read): no local row, a UID that
                // no longer fits (UIDVALIDITY, a move) or a removal that did not take leaves the opened version on the server next to the saved copy (Mac QA D-016/D-020)
                Some(target @ draftmail::Target::Local(_)) => {
                    let by_uid = if opened_row_gone { Ok(()) } else { draftmail::drop_on_session(db, acc, s, target) };
                    let by_mid = match opened.as_deref().and_then(draftmail::message_id_of).filter(|m| Some(format!("mid:{}|{m}", acc.id)) != draft_ref) {
                        Some(mid) => draftmail::delete_by_message_id(s, &folder, &mid).map(|_| ()),
                        None => Ok(()),
                    };
                    by_uid.and(by_mid)
                }
                Some(target) => draftmail::drop_on_session(db, acc, s, target),
            };
            if let Err(e) = dropped {
                startup::line("draft", &format!("account {}: the draft that was replaced could not be removed: {e}", acc.id));
            }
        }
    }
    // the thread the draft gets in the local store (the toast "Draft saved" can open it again with Edit)
    Ok(SavedDraft { thread_id: draft_thread_id(&acc.id, raw), draft_ref })
}

/// To, Cc and Bcc of a saved draft with their display names, read from the headers of the message in the Drafts folder (the synced copy
/// keeps bare To / Cc addresses and no Bcc). Opening a draft in Compose restores the chips from this.
#[tauri::command]
async fn draft_recipients(state: tauri::State<'_, AppState>, message_id: String) -> R<draftmail::DraftRecipients> {
    let db = state.db.clone();
    blocking(move || {
        let (raw, _) = fetch_raw_for(&db, &message_id)?;
        // the draft is being opened: keep its bytes, so Discard can put them back even when the local row is gone by the first save (draftmail.rs "opened version")
        draftmail::remember_opened(&message_id, &raw);
        let mut r = draftmail::recipients(&raw);
        if r.meeting.is_none() {
            // the server dropped the private header (or the draft is encrypted): the copy this computer kept when the draft was saved
            let acct: Option<String> = lock(&db).query_row("SELECT account_id FROM messages WHERE id=?1", [&message_id], |x| x.get(0)).ok();
            r.meeting = acct.and_then(|a| draftmail::recall_meeting(&lock(&db), &a, &raw));
        }
        Ok(r)
    })
    .await
}

/// What Compose needs to open the draft `message_id`: its body with the pictures as `data:` URIs and the attachments, from one read of the message (draftopen.rs, D-044).
/// An encrypted draft is the decrypted message of this session (`get_thread` opened it); the key must be unlocked (`PGP_LOCKED:<fingerprint>` otherwise).
/// `all`: everything in the answer; else the data of a part of 190 KB or more is left out and the page asks for it with `draft_data`, one request each (draftopen.rs).
#[tauri::command]
async fn draft_editor_parts(state: tauri::State<'_, AppState>, message_id: String, all: Option<bool>) -> R<draftopen::EditorParts> {
    let defer = !all.unwrap_or(false);
    let db = state.db.clone();
    blocking(move || {
        let (html, text, atts, pgp): (Option<String>, Option<String>, String, i64) = lock(&db)
            .query_row("SELECT body_html, body_text, attachments, pgp FROM messages WHERE id=?1", [&message_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|_| "MSG_NOT_FOUND: message not found".to_string())?;
        if pgp & pgpmail::FLAG_ENCRYPTED as i64 != 0 {
            let opened = match pgpstore::cached_view(&message_id) {
                Some(o) => o,
                None => {
                    let (raw, _) = fetch_raw_for(&db, &message_id)?;
                    pgpstore::open_message(&db, &message_id, &raw)?
                }
            };
            let Some(plain) = opened.plain.as_deref() else { return Err(not_opened_error(&opened)) };
            let msg = mail::open_parts(plain).ok_or("cannot parse message")?;
            let (html, text, metas) = msg.view();
            return Ok(draftopen::editor_parts(html, text, &metas, Some(&msg), defer));
        }
        // a message that is not encrypted: the body the database holds; its parts are read (from this computer's copy or the server's) only when it has any
        let metas: Vec<mail::AttMeta> = serde_json::from_str(&atts).unwrap_or_default();
        let raw = if metas.is_empty() { None } else { fetch_raw_for(&db, &message_id).ok().map(|(raw, _)| raw) };
        let msg = raw.as_deref().and_then(mail::open_parts);
        // with the message in hand the body is read from it (the pictures as cid: references: editor_parts puts them in, or leaves their data out); without it, the database's
        let (html, text, metas) = match &msg {
            Some(m) => m.view(),
            None => (html, text, metas),
        };
        Ok(draftopen::editor_parts(html, text, &metas, msg.as_ref(), defer))
    })
    .await
}

/// The data `draft_editor_parts` left out under `token`, once (the base64 of a picture or an attachment). Gone after 5 minutes or when it was taken: the page then asks for
/// the parts again with `all`.
#[tauri::command]
async fn draft_data(token: String) -> R<String> {
    draftopen::take_deferred(&token).ok_or_else(|| "draft data is gone".to_string())
}

/// Remove the draft a reference names (Discard on a new message whose autosave had made a draft).
#[tauri::command]
async fn discard_draft(state: tauri::State<'_, AppState>, reference: String) -> R<()> {
    let db = state.db.clone();
    blocking(move || {
        draftmail::forget_original(&lock(&db), &reference);
        draftmail::drop_draft(&db, &reference)
    })
    .await
}

/// 1.0.7 W2.2: Discard on a draft that was opened from Drafts and saved since (an autosave counts): the draft goes back to how it was when it
/// was opened. `reference` names the draft the last save made; see draftmail.rs `restore_on_session`. An error leaves the saved version in place.
/// `reference` can also be `m:<local id>`, the opened draft itself when no save has replaced it yet: Discard then puts the opened version back only if the server lost it.
/// When it worked, the Drafts folder is read again in the background (`sync_drafts_after_restore`): the local list lost the saved copy and does not have the
/// version put back yet, so without it the list of Drafts stayed empty until the next sync (1.0.7 WP2a QA BUG-2).
#[tauri::command]
async fn discard_draft_changes(app: tauri::AppHandle, state: tauri::State<'_, AppState>, reference: String) -> R<bool> {
    let db = state.db.clone();
    blocking(move || {
        // an opened draft that no save has replaced yet is named by its local id (`m:<id>`): there are no edits on the server to take back, the opened version is put back only
        // when the server lost it (D-043, draftmail.rs `restore_unsaved_on_session`)
        if let Some(local_id) = reference.strip_prefix("m:") {
            let account_id = draftmail::account_of_local_id(local_id).ok_or("not a draft")?.to_string();
            let acc = db::get_account(&lock(&db), &account_id)?;
            let sec = secret(&db, &acc)?;
            let mut s = mail::connect(&acc, &sec)?;
            let done = draftmail::restore_unsaved_on_session(&db, &acc, &mut s, local_id);
            let _ = s.logout();
            if done.is_ok() {
                draftmail::forget_opened_memory(local_id);
            }
            if matches!(done, Ok(true)) {
                sync_drafts_after_restore(&app, &db, &acc.id);
            }
            return done;
        }
        // true = the opened version was put back; false = none was kept: nothing was written and the saved copy stays as the one draft (the page says so)
        let Ok(account_id) = lock(&db).query_row::<String, _, _>("SELECT account_id FROM draft_original WHERE draft_ref=?1", [&reference], |r| r.get(0)) else {
            startup::line("draft", "Discard changes found no opened version to put back, the saved copy stays as the draft");
            return Ok(false);
        };
        let acc = db::get_account(&lock(&db), &account_id)?;
        let sec = secret(&db, &acc)?;
        let mut s = mail::connect(&acc, &sec)?;
        let done = draftmail::restore_on_session(&db, &acc, &mut s, &reference);
        let _ = s.logout();
        if matches!(done, Ok(true)) {
            sync_drafts_after_restore(&app, &db, &acc.id);
        }
        done
    })
    .await
}

/// A sync pass of the account on a thread of its own (it waits for a pass that is running: `SYNC_LOCK`, so it always reads after the restore), then every
/// window re-reads its lists. The answer of `discard_draft_changes` does not wait for it. Failures are for the log.
fn sync_drafts_after_restore(app: &tauri::AppHandle, db: &Db, account_id: &str) {
    let (app, db, id) = (app.clone(), db.clone(), account_id.to_string());
    std::thread::spawn(move || {
        if let Err(e) = run_sync(&app, &db, &id) {
            startup::line("draft", &format!("account {id}: the Drafts list could not be refreshed after the opened version was put back: {}", e.chars().take(160).collect::<String>()));
        }
        let _ = app.emit("mail-synced", ());
    });
}

// ---------- crash recovery of the message being written (recover.rs) ----------

/// Snapshots written in this run whose first write was logged, and how many writes failed (the log says the first failure and then every
/// tenth: a disk that stays full must not fill `startup.log`).
static RECOVERY_SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
static RECOVERY_FAILED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn recovery_log(text: &str) {
    startup::line("recovery", text);
}

/// Compose writes a snapshot of the message every few seconds while something changed.
#[tauri::command]
async fn recovery_save(state: tauri::State<'_, AppState>, snap: recover::SnapIn) -> R<()> {
    let db = state.db.clone();
    let (id, bytes, files) = (snap.id.clone(), snap.payload.len(), snap.files.as_ref().map(|f| f.len()));
    let r = blocking(move || recover::save(&lock(&db), &snap, now())).await;
    match &r {
        Ok(()) => {
            let mut seen = RECOVERY_SEEN.lock().unwrap_or_else(|p| p.into_inner());
            if !seen.contains(&id) && seen.len() < 50 {
                seen.push(id.clone());
                recovery_log(&format!("snapshot saved (message {}, {bytes} bytes{})", recover::short_id(&id), files.map(|n| format!(", {n} file(s)")).unwrap_or_default()));
            }
        }
        Err(e) => {
            let n = RECOVERY_FAILED.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if n == 1 || n % 10 == 0 {
                recovery_log(&format!("snapshot of message {} could not be written ({n} failed so far): {}", recover::short_id(&id), e.chars().take(160).collect::<String>()));
            }
        }
    }
    r
}

/// The message was sent, discarded or saved: no snapshot is needed any more. `why` is for the log only.
#[tauri::command]
async fn recovery_clear(state: tauri::State<'_, AppState>, id: String, why: Option<String>) -> R<()> {
    let db = state.db.clone();
    let log_id = id.clone();
    let removed = blocking(move || recover::clear(&lock(&db), &id)).await?;
    if removed > 0 {
        recovery_log(&format!("snapshot removed ({}; message {})", why.as_deref().unwrap_or("message over").chars().take(60).collect::<String>(), recover::short_id(&log_id)));
    }
    Ok(())
}

/// Messages that were being written when the app ended without saving or sending them. The decision is logged (what was found and what
/// happens to it), so a start that shows no toast can be told from one that had nothing to keep. Snapshots of an account that no longer
/// exists are dropped here, with a line in the log.
#[tauri::command]
async fn recovery_list(state: tauri::State<'_, AppState>) -> R<Vec<recover::Info>> {
    let db = state.db.clone();
    let (list, dropped) = blocking(move || {
        let c = lock(&db);
        let dropped = recover::counts(&c)?.1;
        if dropped > 0 {
            recover::prune(&c)?;
        }
        Ok((recover::list(&c)?, dropped))
    })
    .await?;
    recovery_log(&recover::decision_text(list.len(), dropped));
    Ok(list)
}

/// What saving a snapshot as a draft tells the interface (`status`: `saved` = the draft was appended now, `covered` = a draft saved at or after
/// the snapshot was on the server already and no second one was made) and the draft to open from it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveredDraft {
    status: &'static str,
    thread_id: Option<String>,
    draft_ref: Option<String>,
}

/// 1.0.6: the snapshot `id` is saved as a real draft, the way Save draft does it (APPEND to the Drafts folder with \Draft and \Seen, Bcc kept,
/// the draft it takes the place of removed), and removed once the draft is confirmed. A draft of the same message that is on the server already
/// (found by the snapshot id at the start of its Message-ID) is never joined by a second one: a newer or equal one covers the snapshot, an older one
/// is replaced. Any failure (no Drafts folder, no connection, a refused APPEND) is an error and the snapshot stays, nothing is lost.
#[tauri::command]
async fn recovery_save_draft(state: tauri::State<'_, AppState>, id: String, mut draft: smtp::Draft, replaces: Option<String>) -> R<RecoveredDraft> {
    let db = state.db.clone();
    let short = recover::short_id(&id);
    let r = blocking(move || save_recovered(&db, &id, &mut draft, replaces)).await;
    match &r {
        Ok(d) => recovery_log(&format!("snapshot {short} {}", if d.status == "covered" { "is covered by a draft that is on the server already" } else { "saved as a draft" })),
        Err(e) => recovery_log(&format!("snapshot {short} could not be saved as a draft, kept on this computer: {}", e.chars().take(160).collect::<String>())),
    }
    r
}

fn save_recovered(db: &Db, id: &str, draft: &mut smtp::Draft, replaces: Option<String>) -> R<RecoveredDraft> {
    let snap = recover::load(&lock(db), id)?.ok_or("this snapshot is gone")?;
    if snap.account_id != draft.account_id {
        return Err("the snapshot belongs to another account".into());
    }
    if draft.security.as_ref().is_some_and(|s| s.encrypt || s.sign) {
        // (Compose writes no snapshot of an encrypted message; if one exists it is not saved to the server in plain text)
        return Err("an encrypted message is not saved from a snapshot".into());
    }
    let acc = db::get_account(&lock(db), &draft.account_id)?;
    let folder = folder_for(db, &acc, "drafts")?;
    let sec = secret(db, &acc)?;
    let mut s = mail::connect(&acc, &sec)?;
    let done: R<RecoveredDraft> = (|| {
        let found = draftmail::find_by_recovery_id(&mut s, &folder, id)?;
        match recover::verdict(&found, id, snap.saved_at) {
            recover::Verdict::Covered(uid) => {
                let raw = mail::fetch_raw(&mut s, &folder, uid)?;
                Ok(RecoveredDraft { status: "covered", thread_id: draft_thread_id(&acc.id, &raw), draft_ref: draftmail::draft_ref(&acc.id, &raw) })
            }
            recover::Verdict::Save { replace } => {
                ensure_draft_has_content(draft)?; // (a snapshot of recipients only stays on this computer, W13.5)
                draft.recovery_id = Some(id.to_string());
                let raw = draft_bytes(db, &acc, draft)?;
                mail::append(&mut s, &folder, &raw, true)?;
                remember_draft_meeting(db, &acc, &raw, draft);
                // the draft is on the server: what it replaces goes (a failure here is only logged, like Save draft). The older drafts of this
                // very message are removed by the uids that were checked against their headers, on this session.
                if let Err(e) = mail::delete_forever(&mut s, &folder, &replace) {
                    startup::line("draft", &format!("account {}: an older draft of this message could not be removed: {e}", acc.id));
                }
                if let Some(t) = replaces {
                    if let Err(e) = draftmail::drop_draft(db, &t) {
                        startup::line("draft", &format!("account {}: the draft that was replaced could not be removed: {e}", acc.id));
                    }
                }
                Ok(RecoveredDraft { status: "saved", thread_id: draft_thread_id(&acc.id, &raw), draft_ref: draftmail::draft_ref(&acc.id, &raw) })
            }
        }
    })();
    let _ = s.logout();
    let saved = done?;
    // confirmed: only now does the snapshot go
    if recover::clear(&lock(db), id)? > 0 {
        recovery_log(&format!("snapshot removed (draft saved at start; message {})", recover::short_id(id)));
    }
    Ok(saved)
}

#[tauri::command]
async fn recovery_load(state: tauri::State<'_, AppState>, id: String) -> R<Option<recover::Loaded>> {
    let db = state.db.clone();
    blocking(move || recover::load(&lock(&db), &id)).await
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
        return Err("OUTBOX_SENDING: This message is being sent right now.".into());
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
/// The database is locked to read the row and to pause it, not while an encrypted message is decrypted (it can be big; D-025).
#[tauri::command]
async fn outbox_open_for_edit(state: tauri::State<'_, AppState>, id: String) -> R<OutboxEdit> {
    let db = state.db.clone();
    blocking(move || {
        let (stored, acc, send_at, status) = {
            let c = lock(&db);
            let (payload, send_at, status): (String, i64, String) = c
                .query_row("SELECT payload,send_at,status FROM outbox WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|_| "OUTBOX_MISSING: This scheduled message no longer exists.".to_string())?;
            if status == "sending" {
                return Err("OUTBOX_SENDING: This message is being sent right now.".into());
            }
            let stored: smtp::Draft = serde_json::from_str(&payload).map_err(err)?;
            let acc = db::get_account(&c, &stored.account_id)?;
            (stored, acc, send_at, status)
        };
        // an encrypted message is read back with the account's key (PGP_LOCKED:<fpr> while it is locked)
        let draft = pgpstore::unseal_from_outbox(&db, &acc, &stored)?;
        if status == "pending" || status == "overdue" {
            let c = lock(&db);
            let n = c.execute("UPDATE outbox SET status='held' WHERE id=?1 AND status IN ('pending','overdue')", [&id]).map_err(err)?;
            if n == 0 {
                // the sender took it (or it was removed) while it was being read
                let gone = c.query_row("SELECT 1 FROM outbox WHERE id=?1", [&id], |_| Ok(())).is_err();
                return Err(if gone { "OUTBOX_MISSING: This scheduled message no longer exists.".into() } else { "OUTBOX_SENDING: This message is being sent right now.".into() });
            }
        }
        let shown = if status == "pending" || status == "overdue" { "held".to_string() } else { status };
        Ok(OutboxEdit { draft, send_at, status: shown })
    })
    .await
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
async fn outbox_update(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: String, draft: smtp::Draft, send_at: i64) -> R<()> {
    schedule::validate_send_at(send_at, now())?;
    const GONE: &str = "OUTBOX_NOT_WAITING: This scheduled message is no longer waiting to be sent.";
    let db = state.db.clone();
    let (has_meeting, id) = blocking(move || {
        // first look at the row, under the lock: the calendar event is only made once the row is known to be editable
        let (acc, old, draft) = {
            let c = lock(&db);
            let acc = db::get_account(&c, &draft.account_id)?;
            let (old, status) = c
                .query_row("SELECT payload, status FROM outbox WHERE id=?1", [&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|_| GONE.to_string())?;
            if status == "sending" {
                return Err(GONE.to_string());
            }
            // a meeting: drop the event made when it was first scheduled and make it again from the edited details
            let mut draft = draft;
            draft.calendar = None;
            if draft.meeting.is_some() {
                calendar::prepare_meeting(&c, &mut draft)?;
            }
            (acc, old, draft)
        };
        // encrypting / signing a message with big pictures takes seconds: not under the lock (the folder list waits for it on the main thread, D-025).
        // The sender could claim the row meanwhile; the UPDATE below says so (`status!='sending'`), as it always did.
        let sealed = match pgpstore::seal_for_outbox(&db, &acc, &draft) {
            Ok(d) => d,
            Err(e) => {
                // the edit failed (for example the key is locked): the queued message keeps its own event, so
                // only the event made for this attempt goes
                if let Ok(attempt) = serde_json::to_string(&draft) {
                    calendar::forget_prepared(&lock(&db), &attempt);
                }
                return Err(e);
            }
        };
        let payload = serde_json::to_string(&sealed).map_err(err)?;
        let c = lock(&db);
        let n = c
            .execute(
                "UPDATE outbox SET payload=?2, send_at=?3, status='pending', error=NULL, attempts=0 WHERE id=?1 AND status!='sending'",
                params![id, payload, send_at],
            )
            .map_err(err)?;
        if n == 0 {
            // lost the race after all: keep the queued message's own event, drop the one made for this attempt
            calendar::forget_prepared(&c, &payload);
            return Err(GONE.to_string());
        }
        // the edit worked: the event made when it was first scheduled is replaced by the new one
        calendar::forget_prepared(&c, &old);
        Ok((sealed.meeting.is_some(), id))
    })
    .await?;
    if has_meeting {
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
        return Err("OUTBOX_SENDING: This message is being sent right now.".into());
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
            .map_err(|_| "OUTBOX_SENDING: This message is being sent right now.".to_string())?;
        let d: smtp::Draft = serde_json::from_str(&payload).map_err(err)?;
        let acc = db::get_account(&lock(&db), &d.account_id)?;
        let sec = secret(&db, &acc)?;
        let raw = draft_bytes(&db, &acc, &d)?;
        let mut s = mail::connect(&acc, &sec)?;
        let folder = folder_for(&db, &acc, "drafts")?;
        mail::append(&mut s, &folder, &raw, true)?;
        let _ = s.logout();
        remember_draft_meeting(&db, &acc, &raw, &d);
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
            .ok_or("OUTBOX_ALREADY_SENDING: This message is already being sent.")?;
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
            let _ = app.emit_to("main", "outbox-catchup", serde_json::json!({ "count": late }));
        }
        if left > 0 {
            let _ = app.emit_to("main", "outbox-leftover", serde_json::json!({ "count": left }));
        }
    }
}

/// The page is carrying out its part of a quit (REQ-48 b, c): further quit requests start nothing (REQ-48 f).
static QUIT_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The scheduled-messages question is on screen: a second quit request shows it, it does not ask again.
static QUESTION_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Where the windows' messages during a quit go: one channel per window that was asked (`quitwait::Msg`: it got the request, it asks the
/// person, it is done). Keyed by window label, so each window is waited for with a wait of its own.
static FLUSH_ACK: Mutex<Vec<(String, std::sync::mpsc::Sender<quitwait::Msg>)>> = Mutex::new(Vec::new());

/// The windows whose pages must answer the flush request of a quit before the app ends: they hold what the backend does not (a message
/// being written, the Undo timers of messages that were just sent). That is the main window once its page has loaded, and every secondary
/// window (a compose or reader window popped out of the main one, popout.rs) whose page is ready; a window whose page never loaded has
/// nothing to finish. A quit asks the secondary windows first and the main window last (`quitwait::steps`).
fn flush_targets(app: &tauri::AppHandle) -> Vec<String> {
    let mut targets = vec![];
    if startup::is_ready() && app.get_webview_window("main").is_some() {
        targets.push("main".to_string());
    }
    targets.extend(popout::ready_labels(app));
    targets
}

/// The event that asks a window to answer: the main page listens to `flush-sends`, a secondary window to `popout-flush`.
fn flush_event(label: &str) -> &'static str {
    if label == "main" { "flush-sends" } else { popout::FLUSH_EVENT }
}

/// What the request carries: nothing for the main page; a secondary window is told why it is asked (`quit` or `update`), because the question
/// it may have to put to the person says "quit" or "restart".
fn flush_payload(label: &str, why: &str) -> serde_json::Value {
    if label == "main" { serde_json::Value::Null } else { serde_json::json!({ "why": why }) }
}

/// Test seam for QA (`HEYLOOK_TEST_QUIT_PAGE=silent`): the page is not asked, so for the quit it is a page that never answers (a hung or dead
/// page). The quit must then end after `quitwait::FIRST_SIGN_WAIT` with "the page did not answer". Anything else does nothing.
fn test_silent_page() -> bool {
    std::env::var("HEYLOOK_TEST_QUIT_PAGE").is_ok_and(|v| v == "silent")
}

/// Ask the windows of one step of a quit together and wait for each on a thread of its own, with the bounds of `quitwait.rs`. The
/// channel of every window is in place before the first request goes out. (Generic over the runtime so that a test can use mock windows.)
fn ask_windows<R: tauri::Runtime>(app: &tauri::AppHandle<R>, labels: &[String], limits: quitwait::Limits, why: &str) -> Vec<(String, quitwait::Verdict)> {
    let mut waits = vec![];
    for label in labels {
        let (tx, rx) = std::sync::mpsc::channel::<quitwait::Msg>();
        {
            let mut acks = FLUSH_ACK.lock().unwrap_or_else(|p| p.into_inner());
            acks.retain(|(l, _)| l != label);
            acks.push((label.clone(), tx));
        }
        waits.push((label.clone(), rx));
    }
    for label in labels {
        if test_silent_page() {
            startup::stage(None, &format!("quit: test seam HEYLOOK_TEST_QUIT_PAGE=silent: the page of {label} is not asked"));
        } else {
            let _ = app.emit_to(label.as_str(), flush_event(label), flush_payload(label, why));
        }
    }
    let answers: Vec<(String, quitwait::Verdict)> = std::thread::scope(|scope| {
        let handles: Vec<_> = waits
            .into_iter()
            .map(|(label, rx)| {
                scope.spawn(move || {
                    let t0 = std::time::Instant::now();
                    let who = quit_who(&label);
                    let verdict = quitwait::drive(
                        |t| rx.recv_timeout(t),
                        || t0.elapsed(),
                        limits,
                        std::time::Duration::from_millis(200),
                        |msg, phase| startup::stage(None, &format!("quit{who}: the page says {msg:?} ({phase})")),
                    );
                    (label, verdict)
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    // the windows' ends of the channels stay only for a late answer to find nobody (a second quit starts new ones)
    FLUSH_ACK.lock().unwrap_or_else(|p| p.into_inner()).retain(|(l, _)| !labels.contains(l));
    answers
}

/// " (compose-1)" for a secondary window, nothing for the main page (the lines of its quit stay as QA knows them).
fn quit_who(label: &str) -> String {
    if label == "main" { String::new() } else { format!(" ({label})") }
}

/// Steps (b) to (d) of a quit (REQ-48): the page saves a dirty Compose (and asks when that fails), lets every message still in its
/// "Undo" time go out at once and waits for the sends under way; only then `then` runs (queued actions, install, exit). The Undo timer and
/// the open Compose live in the page, so the backend alone could not do this (QA BUG-M6: a quit during "Sending... Undo" lost the
/// message). `then` is not run when the page answers "no" (the person chose to keep writing) or when a quit is already running.
///
/// The wait is bounded in every phase (`quitwait.rs`): a page that says nothing for 8 s, one that works for more than 45 s and a question
/// nobody answers within 60 s end in "go on" (hardening after a QA Linux run, v1.0.6, in which a quit seemed to hang; a direct launch could
/// not repeat it). Nothing is lost by that: a message being written has its recovery snapshot, a message in its Undo time is a row of the
/// outbox that goes out at the next start (tested in `a_quit_without_the_page_loses_no_send_and_no_draft`).
///
/// With secondary windows open (popout.rs) every one of them is asked first, together, each with a wait of its own; the main page is asked
/// after them. One "no" from any window ends the quit.
fn finish_sends_then(app: &tauri::AppHandle, then: impl FnOnce(&tauri::AppHandle) + Send + 'static) {
    if QUIT_BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let targets = flush_targets(app);
    if !targets.is_empty() {
        startup::stage(Some(app), &format!("quit: asking the page to save its draft and send what is waiting (window visible: {}; windows asked: {})", window_shown(app), targets.join(", ")));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let limits = quitwait::Limits::default();
        let (verdict, answers) = quitwait::run_steps(&quitwait::steps(&targets), |labels| ask_windows(&app, labels, limits, "quit"));
        for (label, v) in &answers {
            let text = v.text(&limits);
            startup::stage(Some(&app), &if label == "main" { text } else { text.replacen("quit:", &format!("quit ({label}):"), 1) });
        }
        if answers.is_empty() {
            startup::stage(Some(&app), &verdict.text(&limits));
        }
        if matches!(verdict, quitwait::Verdict::Go(_)) {
            then(&app);
        }
        QUIT_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

/// Is the main window on screen (shown and not minimized)? For the log.
fn window_shown(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

/// A message of a window's page to the quit that is waiting for it. False when no quit is waiting for that window.
fn tell_quit(label: &str, msg: quitwait::Msg) -> bool {
    FLUSH_ACK.lock().unwrap_or_else(|p| p.into_inner()).iter().find(|(l, _)| l == label).is_some_and(|(_, tx)| tx.send(msg).is_ok())
}

/// The window has done its part (and saved its draft): `go` false = the person wants to keep the window open. One answer per question.
fn flush_answer(label: &str, go: bool) {
    let tx = {
        let mut acks = FLUSH_ACK.lock().unwrap_or_else(|p| p.into_inner());
        acks.iter().position(|(l, _)| l == label).map(|i| acks.remove(i).1)
    };
    if let Some(tx) = tx {
        let _ = tx.send(quitwait::Msg::Answer(go));
    }
}

/// A window opened (`open` true) or closed a question to the person that the quit has to wait for (for 60 s at most). The window is
/// brought to the front for it: a question in a window that sits in the tray could not be answered.
fn flush_dialog(app: &tauri::AppHandle, label: &str, open: bool) {
    if open && label == "main" && !window_shown(app) {
        startup::stage(Some(app), "quit: the page asks a question and the window is not on screen: showing it");
        shell::show_main(app);
    } else if open && label != "main" && !popout::is_shown(app, label) {
        startup::stage(Some(app), &format!("quit ({label}): the page asks a question and the window is not on screen: showing it"));
        popout::bring_to_front(app, label);
    }
    tell_quit(label, quitwait::Msg::Dialog(open));
}

/// The page has done its part (and saved its draft): `go` false = the person wants to keep the window open.
#[tauri::command]
fn sends_flushed(window: tauri::Window, go: bool) {
    flush_answer(window.label(), go);
}

/// The page got the request of the quit and is doing its part: the quit waits for it longer than for a page that says nothing.
#[tauri::command]
fn quit_page_alive(window: tauri::Window) {
    tell_quit(window.label(), quitwait::Msg::Alive);
}

/// The page opened (`true`) or closed (`false`) a question to the person that the quit has to wait for (for 60 s at most). The window is
/// brought to the front for it: a question in a window that sits in the tray could not be answered.
#[tauri::command]
fn quit_dialog(app: tauri::AppHandle, window: tauri::Window, open: bool) {
    flush_dialog(&app, window.label(), open);
}

/// A secondary window got `popout-flush` and is doing its part (the secondary counterpart of `quit_page_alive`).
#[tauri::command]
fn popout_flush_alive(window: tauri::Window) {
    if popout::is_secondary(window.label()) {
        tell_quit(window.label(), quitwait::Msg::Alive);
    }
}

/// A secondary window opened or closed a question to the person (the secondary counterpart of `quit_dialog`).
#[tauri::command]
fn popout_flush_dialog(app: tauri::AppHandle, window: tauri::Window, open: bool) {
    if popout::is_secondary(window.label()) {
        flush_dialog(&app, window.label(), open);
    }
}

/// A secondary window has saved what it holds: `go` false = the person keeps the window open (the secondary counterpart of `sends_flushed`).
#[tauri::command]
fn popout_flush_done(window: tauri::Window, go: bool) {
    if popout::is_secondary(window.label()) {
        flush_answer(window.label(), go);
    }
}

/// Ask every secondary window to save what it holds, before the update restart saves the inline Compose (spec 3.4, "Update restart").
/// Returns `true` when the restart may go on (every window answered, or gave up, or none is open) and `false` when a person keeps a window
/// open (or a quit is running). The same bounded wait as a quit; no window is closed here (the restart ends them).
#[tauri::command]
async fn popout_save_all(app: tauri::AppHandle) -> bool {
    let targets = popout::ready_labels(&app);
    if targets.is_empty() {
        return true;
    }
    if QUIT_BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    startup::stage(Some(&app), &format!("update: asking the secondary windows to save what they hold: {}", targets.join(", ")));
    let limits = quitwait::Limits::default();
    let (verdict, answers) = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || quitwait::run_steps(&quitwait::steps(&targets), |labels| ask_windows(&app, labels, limits, "update"))
    })
    .await
    .unwrap_or((quitwait::Verdict::Stay, vec![]));
    for (label, v) in &answers {
        startup::stage(Some(&app), &v.text(&limits).replacen("quit:", &format!("update ({label}):"), 1));
    }
    QUIT_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    matches!(verdict, quitwait::Verdict::Go(_))
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
        let _ = app.emit_to("main", "confirm-quit", serde_json::json!({ "count": count, "next": next }));
        return;
    }
    finish_sends_then(app, quit_final);
}

/// Quit from the "could not load its window" message (startup.rs): the page that would be asked to save its draft and send what waits
/// is not there (a page that answered after all is asked as usual), and the question about scheduled messages would go to nobody.
pub(crate) fn quit_without_page(app: &tauri::AppHandle) {
    finish_sends_then(app, quit_final);
}

/// Steps (d) and (e): queued archive / delete actions are committed, then the app exits (install on quit runs in `ExitRequested`).
fn quit_final(app: &tauri::AppHandle) {
    exit_watchdog(app);
    startup::stage(Some(app), "quit: committing the queued actions");
    flush_pending(app);
    QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    startup::stage(Some(app), "quit: asking the event loop to exit");
    app.exit(0);
}

/// How long the quit sequence may take from `quit_final` to the end of the process (queued actions up to a few seconds, the exit itself).
const EXIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(40);

/// A quit must end the process: when something after the page's part hangs (a server that does not answer a queued move, the tray icon
/// or the web view going down, the event loop not handling the exit), the process is ended after `EXIT_LIMIT`. Everything that matters is
/// on disk by then: messages in their Undo time are outbox rows, the message being written has its snapshot, mail actions that did not
/// run are picked up by the next sync.
fn exit_watchdog(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_LIMIT);
        startup::stage(Some(&app), &format!("quit: the process is still alive {} s after the quit began: ending it now", EXIT_LIMIT.as_secs()));
        #[cfg(unix)]
        std::thread::spawn(|| {
            // `exit` runs the handlers of the libraries (GTK, WebKit), which may be what hangs: a second way out that skips them
            std::thread::sleep(std::time::Duration::from_secs(3));
            // SAFETY: `_exit` ends the process at once; nothing is left to clean up that matters (see above)
            unsafe { libc::_exit(0) };
        });
        std::process::exit(0);
    });
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
fn set_setting(app: tauri::AppHandle, window: tauri::Window, state: tauri::State<AppState>, key: String, value: String) -> R<()> {
    db::set_setting(&lock(&state.db), &key, &value)?;
    // the preferences changed: every other window re-reads them (the main page is the only writer, popout.rs)
    if key == "prefs" {
        let _ = app.emit(popout::PREFS_EVENT, serde_json::json!({ "writer": window.label() }));
        // the title bar of every window follows the theme setting (wintheme.rs)
        wintheme::apply_all(&app, "theme setting changed");
    }
    // the UI mirrors its language here: the tray menu, the macOS Quit item and the tray tooltip follow at once (native texts, see i18n.rs)
    if key == "ui_language" && i18n::set_lang(&value) {
        shell::refresh_language(&app, &state.db);
    }
    Ok(())
}

/// When this computer first used the app, as far as the system can tell: the creation time of the main database file, in milliseconds
/// since the epoch (`None` when the file or its creation time cannot be read). The page asks once, for an install from before the
/// support reminder existed (it has no stored first-run date). Nothing is sent anywhere.
#[tauri::command]
fn first_run_hint(dir: tauri::State<legacy_names::DataDir>) -> Option<i64> {
    let made = std::fs::metadata(dir.0.join("heylook.db")).ok()?.created().ok()?;
    let ms = made.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(ms).ok()
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
    Err("UNSUBSCRIBE_NO_TARGET: This message has no unsubscribe link.".into())
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
async fn ai_complete(window: tauri::Window, state: tauri::State<'_, AppState>, system: String, prompt: String, job_id: Option<String>) -> R<String> {
    let (ep, key, model) = {
        let c = lock(&state.db);
        (
            db::get_setting(&c, "ai_endpoint").unwrap_or_default(),
            secret_get("ai_key").unwrap_or_default(),
            db::get_setting(&c, "ai_model").unwrap_or_default(),
        )
    };
    // a call of a reader window stops with the window (REQ-R12)
    let _tracked = job_id.as_deref().and_then(|id| popout::track_ai(window.label(), id));
    ai::complete(&ep, &key, &model, &system, &prompt, job_id.as_deref()).await
}

/// Cancel the `ai_complete` call that was started with this `job_id`: its request to the provider is dropped.
#[tauri::command]
fn ai_cancel(job_id: String) {
    ai::cancel(&job_id);
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
    // (the names shared with other copies of the app: credential store service, notification id; see identity.rs)
    let mut context = tauri::generate_context!();
    // (the policy of this run: the PDF experiment on macOS / Linux changes one directive, see pdfmode.rs)
    pdfmode::apply_csp(context.config_mut());
    identity::init(&context.config().identifier);
    // a QA build has no inspector, its native menus are the release's (D-037, see identity.rs)
    if identity::devtools_off() {
        for w in context.config_mut().app.windows.iter_mut() {
            w.devtools = Some(false);
        }
        startup::line("devtools", "this QA build makes its windows without the web view inspector (no Inspect Element; HEYLOOK_DEVTOOLS=1 keeps it)");
    }
    // a start that fails ends in a message the person can read, not in a silent exit (see startfail.rs)
    startfail::install_panic_hook();
    #[cfg(windows)]
    if startfail::webview_runtime_missing() {
        startfail::fail_start("the Microsoft WebView2 Runtime was not found on this computer");
    }
    // a restart or an installer relaunch starts this process while the previous run's web view processes are still going away: a web
    // view created now would join them and die with them (see webview_health.rs)
    webview_health::wait_for_previous_run();
    let builder = tauri::Builder::default();
    // debug builds only: when the bridge is on, its page side (console buffer, input helpers) goes into every window
    #[cfg(debug_assertions)]
    let builder = if testbridge::requested().is_some() { builder.plugin(testbridge::plugin()) } else { builder };
    // macOS and Linux notifications (Windows has its own toasts in shell.rs)
    #[cfg(not(windows))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    // macOS: the app menu's Quit item (and Cmd+Q) goes through the quit sequence like the tray's (see shell::mac_app_menu)
    #[cfg(target_os = "macos")]
    let builder = builder.menu(shell::mac_app_menu).on_menu_event(shell::mac_menu_event);
    #[cfg(any(windows, target_os = "macos"))]
    // a frame of the window (the PDF preview has no sandbox here, see src/pdfFrame.ts) can never take the whole window to a website
    let builder = builder.plugin(navguard::plugin());
    let built = builder
        // a second launch just brings the running instance forward
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            startup::stage(Some(app), "a second start was handed to this instance: showing the window");
            shell::show_main(app)
        }))
        // "Open at login": the autostart entry is named after the app ("Hey Look!.desktop" on Linux, kept for the installed .deb and AppImage
        // entries); in the snap it must be hey-look.desktop, the one name snapd starts (snapcraft.yaml `autostart`)
        .plugin({
            let b = tauri_plugin_autostart::Builder::new().args(["--minimized"]); // (macOS: the launch agent, the builder's default)
            let b = if update::managed_by() == Some("snap") { b.app_name(update::SNAP_NAME) } else { b };
            b.build()
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // (test seam of a debug build: the setup stops, as it does when the data folder or the database cannot be opened)
            if startfail::seam().as_deref() == Some("setup") {
                return Err("test: the setup was stopped on purpose (HEYLOOK_TEST_START_FAIL=setup)".into());
            }
            app.manage(popout::State::default());
            // the data folder of this identifier (data saved under the old names is moved there once, see legacy_names.rs)
            let dir = legacy_names::data_dir(app.handle())?;
            app.manage(legacy_names::DataDir(dir.clone()));
            startup::init_log_dir(dir.clone());
            let conn = db::open(&dir.join("heylook.db"))?;
            let db: Db = Arc::new(Mutex::new(conn));
            // the language of the native texts (tray, notifications) as the UI last mirrored it; English until the first run mirrors it
            if let Some(code) = db::get_setting(&lock(&db), "ui_language") {
                i18n::set_lang(&code);
            }
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
            // one-time preference changes (`prefsRev`), before the tray is drawn so its first number is already right
            if let Err(e) = db::migrate_stored_prefs(&lock(&db)) {
                eprintln!("could not update the stored preferences: {e}");
            }
            let pending_app = app.handle().clone();
            std::thread::spawn(move || pending_worker(pending_app));
            let cal_app = app.handle().clone();
            let cal_db = db.clone();
            std::thread::spawn(move || calendar::reminder_worker(cal_app, cal_db));
            // calendar sync (Google / Microsoft calendars of the mailboxes that turned it on) has its own thread: mail never waits for it
            let sync_app = app.handle().clone();
            std::thread::spawn(move || calsync::cmds::calsync_worker(sync_app));

            winframe::setup(app);
            // the native frame of the main window follows the theme setting from the start (a pop-out gets it when it is created)
            wintheme::apply_all(app.handle(), "start");
            #[cfg(target_os = "macos")]
            wintheme::watch_os(app.handle());
            shell::register_aumid(app.handle());
            // a missing tray is not fatal: without it the close button quits instead of hiding (shell::close_to_tray)
            if let Err(e) = shell::setup_tray(app.handle(), &db) {
                eprintln!("tray icon unavailable: {e}");
            }
            // (also puts the stored language into the macOS app menu, which is built before the settings can be read)
            shell::refresh_language(app.handle(), &db);
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
            // debug builds only; does nothing unless the environment asks for the bridge
            #[cfg(debug_assertions)]
            testbridge::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // the OS changed its theme (any window says so): with the System setting every window's frame follows (wintheme.rs)
            if let tauri::WindowEvent::ThemeChanged(theme) = event {
                wintheme::on_os_theme_changed(window.app_handle(), &format!("tao ThemeChanged({theme:?}) of {}", window.label()));
            }
            // a secondary window (compose / reader) closes only itself: it never hides to the tray and never starts a quit (popout.rs)
            if window.label() != "main" {
                popout::on_window_event(window, event);
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let db = window.app_handle().state::<AppState>().db.clone();
                startup::stage(Some(window.app_handle()), &format!("window close requested (hides to the tray: {})", shell::close_to_tray(&db)));
                if shell::close_to_tray(&db) {
                    api.prevent_close();
                    let _ = window.hide();
                    linuxview::note_hidden();
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
            cancel_add_account,
            google_sign_in,
            oauth_cancel,
            reauth_account,
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
            read_clipboard_text,
            get_autostart,
            set_autostart,
            list_folders,
            list_threads,
            locate_thread,
            get_thread,
            thread_meta,
            thread_action,
            prepare_action,
            list_senders,
            sender_action,
            list_blocked,
            unblock,
            list_rules,
            save_rule,
            delete_rule,
            get_raw,
            reply_headers,
            save_attachments,
            attachment_save_as,
            attachment_save_all,
            attachment_open,
            attachment_reveal,
            pick_folder,
            inline_image,
            send_message,
            save_draft,
            draft_recipients,
            draft_editor_parts,
            draft_data,
            draft_upload,
            discard_draft,
            discard_draft_changes,
            recovery_save,
            recovery_clear,
            recovery_list,
            recovery_load,
            recovery_save_draft,
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
            smtpsize::smtp_size_limit,
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
            calsync::cmds::calendar_sources,
            calsync::cmds::calendar_kinds_available,
            calsync::cmds::calendar_connect,
            calsync::cmds::calendar_cancel_connect,
            calsync::cmds::calendar_disconnect,
            calsync::cmds::calendar_set_sync,
            calsync::cmds::calendar_sync_now,
            list_templates,
            save_template,
            delete_template,
            list_signatures,
            save_signature,
            delete_signature,
            get_setting,
            set_setting,
            first_run_hint,
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
            ai_cancel,
            ai_list_models,
            shell_info,
            update::check_update,
            update::update_download,
            update::update_cancel,
            update::update_discard,
            update::update_defer,
            update::update_note,
            set_mail_available,
            take_tray_compose,
            frontend_ready,
            sends_flushed,
            quit_page_alive,
            popout_flush_alive,
            popout_flush_dialog,
            popout_flush_done,
            popout_save_all,
            popout::popout_open,
            popout::popout_init,
            popout::popout_ready,
            popout::popout_focus,
            popout::popout_close,
            popout::popout_park,
            popout::popout_destroy,
            popout::popout_note,
            wintheme::window_theme_refresh,
            popout::popout_set_key,
            popout::popout_request,
            popout::popout_reply,
            page_pong,
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
        .build(context);
    // (test seam of a debug build: pretend that the builder failed)
    let built = if startfail::seam().as_deref() == Some("build") { Err(tauri::Error::Io(std::io::Error::other("test: Builder::build() was made to fail (HEYLOOK_TEST_START_FAIL=build)"))) } else { built };
    let app = match built {
        Ok(app) => app,
        Err(e) => {
            // Windows: the message box and the end of the process happen inside; the other systems get the line in startup.log and the panic they always had
            startfail::fail_start(&format!("Builder::build() failed: {e}"));
            panic!("error while building tauri application: {e}");
        }
    };
    app.run(|app, event| match event {
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
                startup::stage(Some(app), &format!("exit: the exit goes on (code {code:?})"));
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
                startup::stage(Some(app), "exit: the event loop ended, closing the push sessions and committing the queued actions");
                idle::shutdown();
                flush_pending(app);
                update::install_on_exit(app);
                startup::stage(Some(app), "exit: done, the process ends");
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

    // (QA BUG-10 through the real action code, an account without an Archive folder: foldermove_tests.rs, against a fake server.)

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

    /// The tests that use `FLUSH_ACK` (one global table of the quit that is running) take turns.
    static FLUSH_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// A quit over real (mock) windows: every window gets its own request event, answers on its own, and the verdicts are told apart. This
    /// is the wiring of `ask_windows` (events, the table of channels, one wait per window); the timing rules are tested in quitwait.rs.
    #[test]
    fn a_quit_asks_each_window_and_hears_each_one() {
        use crate::quitwait::{Limits, Verdict, Why};
        use std::time::Duration;
        use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};
        let _one_at_a_time = FLUSH_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let labels = ["compose-71", "reader-72", "compose-73", "compose-74"];
        for l in labels {
            let w = WebviewWindowBuilder::new(&app, l, WebviewUrl::App("index.html".into())).build().unwrap();
            // the page of the window: compose-71 saves and goes on, reader-72 works first, compose-73 keeps its message, compose-74 never answers
            let who = l.to_string();
            let go = l != "compose-73";
            if l != "compose-74" {
                w.listen(flush_event(l), move |_| {
                    assert!(tell_quit(&who, crate::quitwait::Msg::Alive), "the table has a channel for {who} before the request goes out");
                    flush_answer(&who, go);
                });
            }
        }
        let limits = Limits { first_sign: Duration::from_millis(600), work: Duration::from_secs(5), dialog: Duration::from_secs(5) };
        let asked: Vec<String> = labels.iter().map(|l| l.to_string()).collect();
        let t0 = std::time::Instant::now();
        let got = ask_windows(app.handle(), &asked, limits, "quit");
        let by = |l: &str| got.iter().find(|(n, _)| n == l).map(|(_, v)| *v).unwrap();
        assert_eq!(by("compose-71"), Verdict::Go(Why::Answered));
        assert_eq!(by("reader-72"), Verdict::Go(Why::Answered));
        assert_eq!(by("compose-73"), Verdict::Stay, "the person kept the message: that window's own answer");
        assert_eq!(by("compose-74"), Verdict::Go(Why::NoSign), "a page that says nothing is given up after the first-sign time");
        assert_eq!(crate::quitwait::merge(&got.iter().map(|(_, v)| *v).collect::<Vec<_>>()), Verdict::Stay, "one no ends the quit");
        assert!(t0.elapsed() < Duration::from_secs(4), "the windows were waited for together, not one after the other");
        assert!(FLUSH_ACK.lock().unwrap().is_empty(), "the table is cleaned up for the next quit");
    }

    /// The page's messages reach the quit that asked its window; an answer nobody waits for does nothing. (The waiting itself, with a page
    /// that never answers, answers late or asks a question, is tested in quitwait.rs.)
    #[test]
    fn the_pages_messages_travel_through_the_commands() {
        use crate::quitwait::Msg;
        let _one_at_a_time = FLUSH_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (tx, rx) = channel::<Msg>();
        let (tx2, rx2) = channel::<Msg>();
        *FLUSH_ACK.lock().unwrap() = vec![("main".to_string(), tx), ("compose-1".to_string(), tx2)];
        assert!(tell_quit("main", Msg::Alive) && tell_quit("main", Msg::Dialog(true)) && tell_quit("main", Msg::Dialog(false)));
        assert!(tell_quit("compose-1", Msg::Alive));
        assert!(!tell_quit("reader-9", Msg::Alive), "a window that was not asked has no channel");
        flush_answer("main", false);
        let got: Vec<Msg> = rx.try_iter().collect();
        assert_eq!(got, vec![Msg::Alive, Msg::Dialog(true), Msg::Dialog(false), Msg::Answer(false)]);
        assert_eq!(rx2.try_iter().collect::<Vec<_>>(), vec![Msg::Alive], "every window has a channel of its own");
        assert_eq!(FLUSH_ACK.lock().unwrap().len(), 1, "one answer per question: main's channel is gone, compose-1 still waits");
        // nobody waits for main any more: nothing happens, nothing blocks
        assert!(!tell_quit("main", Msg::Alive));
        flush_answer("main", true);
        flush_answer("compose-1", true);
        assert_eq!(rx2.try_iter().collect::<Vec<_>>(), vec![Msg::Answer(true)]);
        assert!(FLUSH_ACK.lock().unwrap().is_empty());
        // a page that is gone: the sender is closed, the message is dropped
        let (tx, rx) = channel::<Msg>();
        drop(rx);
        *FLUSH_ACK.lock().unwrap() = vec![("main".to_string(), tx)];
        assert!(!tell_quit("main", Msg::Alive));
        FLUSH_ACK.lock().unwrap().clear();
    }

    /// The quit that goes on WITHOUT the page (it never answered, kept working too long, or its question stayed open) loses nothing: what the
    /// page holds is on disk by then. A message in its Undo time is an outbox row (`undo=1`) that the next start sends like a scheduled message
    /// that came due, a scheduled message stays what it was, and the message being written is in its recovery snapshot, which the next start
    /// offers. The test ends the "process" (drops the connection) after the wait and opens the database again, as the next start does.
    #[test]
    fn a_quit_without_the_page_loses_no_send_and_no_draft() {
        use crate::quitwait::{drive, Limits, Msg, Verdict, Why};
        use std::cell::Cell;
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::Duration;

        // three pages that do not finish: silent, working for ever, a question nobody answers
        let pages: [(&str, Vec<(u64, Msg)>, Verdict); 3] = [
            ("silent", vec![], Verdict::Go(Why::NoSign)),
            ("working", vec![(500, Msg::Alive)], Verdict::Go(Why::WorkTooLong)),
            ("question", vec![(500, Msg::Alive), (900, Msg::Dialog(true))], Verdict::Go(Why::DialogTooLong)),
        ];
        for (tag, script, want) in pages {
            let dir = crate::shard::tests::temp_dir(&format!("quit-lost-{tag}"));
            let path = dir.join("heylook.db");
            {
                let db: Db = Arc::new(Mutex::new(db::open(&path).unwrap()));
                db::insert_account(&lock(&db), &crate::smtp::tests::account_with_id("a")).unwrap();
                put_row(&db, "undo-msg", "undo", 1, now() + 20); // "Sending... Undo": the page's timer was still running
                put_row(&db, "later-msg", "pending", 0, now() + 3600); // a scheduled message
                recover::save(
                    &lock(&db),
                    &recover::SnapIn {
                        id: "writing".into(),
                        account_id: "a".into(),
                        subject: "Plan".into(),
                        preview: "Hi".into(),
                        payload: r#"{"to":["ann@example.com"],"bcc":["quiet@example.com"],"html":"<p>Hi</p>"}"#.into(),
                        files: None,
                    },
                    now(),
                )
                .unwrap();

                // the wait, with a page that does what `script` says and a clock that moves 200 ms per look
                let clock = Cell::new(Duration::ZERO);
                let mut script: std::collections::VecDeque<(u64, Msg)> = script.into();
                let verdict = drive(
                    |t| match script.front() {
                        Some(&(at, m)) if Duration::from_millis(at) <= clock.get() + t => {
                            script.pop_front();
                            clock.set(Duration::from_millis(at).max(clock.get()));
                            Ok(m)
                        }
                        _ => {
                            clock.set(clock.get() + t);
                            Err(RecvTimeoutError::Timeout)
                        }
                    },
                    || clock.get(),
                    Limits::default(),
                    Duration::from_millis(200),
                    |_, _| {},
                );
                assert_eq!(verdict, want, "{tag}");
                // (the quit then goes on: finish_sends_then runs `then` for every Go, see the_quit_never_waits_for_ever)
            } // the process ends: nothing of it is left but the file

            // the next start
            let db: Db = Arc::new(Mutex::new(db::open(&path).unwrap()));
            outbox_startup(&db);
            assert_eq!(row(&db, "undo-msg"), ("pending".to_string(), 2), "{tag}: the message in its Undo time goes out at the next start");
            assert_eq!(row(&db, "later-msg"), ("pending".to_string(), 0), "{tag}: the scheduled message is untouched");
            let offered = recover::list(&lock(&db)).unwrap();
            assert_eq!(offered.len(), 1, "{tag}: the message being written is offered back");
            let l = recover::load(&lock(&db), "writing").unwrap().expect("there");
            assert!(l.payload.contains("quiet@example.com"), "{tag}: with its Bcc");
        }
    }

    /// A quit must always finish (QA Linux v1.0.6): the wait for the page is the bounded one of quitwait.rs in every phase (no flag that
    /// stops the clock), the window is brought to the front for a question, and the end of the sequence has a watchdog.
    #[test]
    fn the_quit_never_waits_for_ever() {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let fin = &lib[lib.find("fn finish_sends_then").expect("finish_sends_then")..];
        let fin = &fin[..fin.find("\n}\n").unwrap()];
        let ask = &lib[lib.find("fn ask_windows").expect("ask_windows")..];
        let ask = &ask[..ask.find("\n}\n").unwrap()];
        assert!(ask.contains("quitwait::drive(") && fin.contains("quitwait::Limits::default()"), "{ask}");
        assert!(fin.contains("quitwait::run_steps(&quitwait::steps(&targets)") && fin.contains("ask_windows(&app, labels, limits, \"quit\")"), "{fin}");
        assert!(!fin.contains("USER_DIALOG") && !lib.contains("static USER_DIALOG"), "a flag that stops the clock lets a quit hang for ever");
        assert!(fin.contains("quit: asking the page to save its draft and send what is waiting"));
        // which windows must answer is decided in one place
        assert!(fin.contains("flush_targets(app)") && lib.contains("fn flush_targets(app: &tauri::AppHandle) -> Vec<String>"));
        assert!(ask.contains("test_silent_page()") && lib.contains("HEYLOOK_TEST_QUIT_PAGE"));
        // every window gets a wait of its own (a thread each), so one person's question does not use up another window's time
        assert!(ask.contains("std::thread::scope") && ask.contains("scope.spawn"), "{ask}");
        // every "go on" runs the rest of the sequence (queued actions, exit); only the person's "keep the window" does not
        assert!(fin.contains("if matches!(verdict, quitwait::Verdict::Go(_)) {\n            then(&app);"), "{fin}");
        let q = crate::test_guard::non_test_code(include_str!("quitwait.rs"));
        assert!(q.contains("FIRST_SIGN_WAIT: Duration = Duration::from_secs(8)") && q.contains("DIALOG_WAIT: Duration = Duration::from_secs(60)"));
        assert!(q.contains("the page did not answer in {} s, quitting"));
        // a question is answered in a window that can be seen
        let dialog = &lib[lib.find("fn flush_dialog").expect("flush_dialog")..];
        let dialog = &dialog[..dialog.find("\n}\n").unwrap()];
        assert!(dialog.contains("window_shown(app)") && dialog.contains("shell::show_main(app)") && dialog.contains("popout::bring_to_front(app, label)"), "{dialog}");
        let qd = &lib[lib.find("fn quit_dialog").expect("quit_dialog")..];
        assert!(qd[..qd.find("\n}\n").unwrap()].contains("flush_dialog(&app, window.label(), open)"));
        // the watchdog is armed before anything of the end of the sequence can hang, and it ends the process
        let last = &lib[lib.find("fn quit_final").expect("quit_final")..];
        let last = &last[..last.find("\n}\n").unwrap()];
        assert!(last.find("exit_watchdog(app)").unwrap() < last.find("flush_pending").unwrap(), "{last}");
        let dog = &lib[lib.find("fn exit_watchdog").expect("exit_watchdog")..];
        let dog = &dog[..dog.find("\n}\n").unwrap()];
        assert!(dog.contains("std::process::exit(0)") && dog.contains("EXIT_LIMIT"), "{dog}");
    }

    /// A secondary window (popout.rs) closes only itself: the close handler looks at the label before anything else, so no pop-out ever
    /// hides to the tray or starts a quit (REQ-W9, risk R-2); the main window's close keeps its rules below the branch.
    #[test]
    fn closing_a_secondary_window_never_hides_or_quits() {
        let src = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let h = &src[src.find(".on_window_event(").expect("window event handler")..];
        let h = &h[..h.find(".invoke_handler").expect("end of handler")];
        let branch = h.find("window.label() != \"main\"").expect("a branch on the label");
        let close = h.find("tauri::WindowEvent::CloseRequested").expect("close handler");
        assert!(branch < close, "the label is looked at before the close-to-tray / quit rules: {h}");
        let arm = &h[branch..close];
        assert!(arm.contains("popout::on_window_event(window, event);") && arm.contains("return;"), "{arm}");
        // the secondary handler itself never hides, quits or asks for a quit
        let pop = crate::test_guard::non_test_code(include_str!("popout.rs"));
        let pop = &pop[pop.find("pub fn on_window_event").unwrap()..];
        let pop = &pop[..pop.find("\n}\n").unwrap()];
        for never in [".hide()", "request_quit", "close_to_tray", "app.exit", "show_main"] {
            assert!(!pop.contains(never), "a secondary window must not use {never}: {pop}");
        }
    }

    /// Every window the quit asks must be able to answer: the secondary windows are asked with their own event and answer with their own
    /// commands, the main page with `flush-sends` and the old commands; the messages are matched by window label.
    #[test]
    fn every_asked_window_has_its_event_and_its_answer() {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        assert_eq!(flush_event("main"), "flush-sends");
        assert_eq!(flush_event("compose-1"), "popout-flush");
        assert_eq!(flush_event("reader-7"), popout::FLUSH_EVENT);
        // the main page's commands take the label of the window that calls
        for f in ["fn sends_flushed(window: tauri::Window", "fn quit_page_alive(window: tauri::Window", "fn quit_dialog(app: tauri::AppHandle, window: tauri::Window"] {
            assert!(lib.contains(f), "{f}");
        }
        // the secondary windows have commands of their own, and only a secondary window may use them
        for f in ["fn popout_flush_alive", "fn popout_flush_dialog", "fn popout_flush_done"] {
            let body = &lib[lib.find(f).expect(f)..];
            assert!(body[..body.find("\n}\n").unwrap()].contains("popout::is_secondary(window.label())"), "{f}");
        }
        // the secondary windows are asked before the main one, and only when their page is ready
        let targets = &lib[lib.find("fn flush_targets").unwrap()..];
        assert!(targets[..targets.find("\n}\n").unwrap()].contains("popout::ready_labels(app)"));
        // the update restart asks them too, with the same bounded wait
        let save = &lib[lib.find("async fn popout_save_all").unwrap()..];
        let save = &save[..save.find("\n}\n").unwrap()];
        assert!(save.contains("quitwait::run_steps(") && save.contains("QUIT_BUSY.swap"), "{save}");
    }

    /// `prefs-changed` goes out when (and only when) the `prefs` blob is written, with the writer's label (REQ-W11).
    #[test]
    fn prefs_changed_is_emitted_for_the_prefs_key_only() {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let f = &lib[lib.find("fn set_setting(").unwrap()..];
        let f = &f[..f.find("\n}\n").unwrap()];
        assert!(f.contains("if key == \"prefs\" {") && f.contains("popout::PREFS_EVENT") && f.contains("window.label()"), "{f}");
        assert_eq!(f.matches("popout::PREFS_EVENT").count(), 1);
    }

    /// REQ-W12: what is meant for the main page is sent to the main page only, so a secondary window never handles a quit, a tray click, a
    /// toast click or the page's own bookkeeping. The events that every window needs stay broadcast.
    #[test]
    fn events_for_the_main_page_are_sent_to_it_only() {
        let mut code = String::new();
        for src in [include_str!("lib.rs"), include_str!("shell.rs"), include_str!("calendar.rs"), include_str!("winframe.rs"), include_str!("idle.rs")] {
            code.push_str(&crate::test_guard::non_test_code(src));
        }
        let main_only = [
            "confirm-quit", "tray-compose", "open-thread", "notify-reply", "app-shown", "signin-state", "backfill-progress", "action-verify-failed",
            "action-failed", "moves-committed", "outbox-leftover", "outbox-catchup", "filter-failed", "event-reminder", "download-dir-fallback", "frame-caption",
        ];
        for ev in main_only {
            assert!(!code.contains(&format!("emit(\"{ev}\"")), "{ev} is broadcast");
            assert!(code.contains(&format!("emit_to(\"main\", \"{ev}\"")), "{ev} is not sent to main");
        }
        // the flush request goes to the window that is asked (main: flush-sends, the others: popout-flush)
        assert!(code.contains("app.emit_to(label.as_str(), flush_event(label), flush_payload(label, why))"));
        // the main page gets no payload; a secondary window is told whether the app quits or restarts for an update
        assert_eq!(flush_payload("main", "quit"), serde_json::Value::Null);
        assert_eq!(flush_payload("compose-2", "update"), serde_json::json!({ "why": "update" }));
        // these are for every window: the data they show changed
        for ev in ["mail-synced", "outbox-changed", "calendar-changed", "idle-state"] {
            assert!(code.contains(&format!("emit(\"{ev}\"")), "{ev} should stay a broadcast");
            assert!(!code.contains(&format!("emit_to(\"main\", \"{ev}\"")), "{ev} must reach every window");
        }
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

    /// (1.0.5) The folder list says which rows the saved folder list names: the app hides Junk where it is not named (Junk is never
    /// created) and keeps Archive / Trash (created on first use). A sync rewrites the saved list, so a Junk folder the server gained later
    /// is named after it.
    #[test]
    fn the_folder_list_says_which_folders_the_saved_list_names() {
        let db = test_db("listed");
        let acc = Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
        };
        db::insert_account(&lock(&db), &acc).unwrap();
        let listed = |db: &Db| -> HashMap<String, bool> {
            folder_infos(&lock(db)).unwrap().into_iter().filter(|f| f.account_id == "a1").map(|f| (f.key, f.listed)).collect()
        };
        // never synced: nothing is named, every standard row is still there
        let none = listed(&db);
        assert_eq!(none.len(), 6);
        assert!(none.values().all(|l| !l));
        // a server without a Junk folder
        db::set_setting(&lock(&db), "fmap:a1", r#"{"inbox":"INBOX","sent":"Sent","f:Work":"Work"}"#).unwrap();
        let l = listed(&db);
        assert_eq!((l["inbox"], l["sent"], l["f:Work"]), (true, true, true));
        assert!(!l["junk"], "no Junk folder in the saved list");
        assert!(l.contains_key("junk") && l.contains_key("archive") && l.contains_key("trash"), "the standard rows are still listed");
        assert!(!l["archive"] && !l["trash"], "created on first use, so not named yet");
        // the server gains a Junk folder: the next sync writes the list again and Junk is named
        db::set_setting(&lock(&db), "fmap:a1", r#"{"inbox":"INBOX","sent":"Sent","f:Work":"Work","junk":"Spam"}"#).unwrap();
        let l = listed(&db);
        assert!(l["junk"]);
        let spam = folder_infos(&lock(&db)).unwrap().into_iter().find(|f| f.key == "junk").unwrap();
        assert_eq!(spam.name, "Spam");
    }

    /// QA BUG-M4 / M8: a folder the server lacks is named in the error; one it has is used.
    #[test]
    fn a_missing_folder_is_named_in_the_error() {
        let db = test_db("folders");
        let acc = Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
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
        let guard = &guard[..guard.find("\n}\n").unwrap()];
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
        // (not the test modules' own text; cut at the first test MODULE: a lone `#[cfg(test)]` fn in the code must not hide the rest)
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let lib = &lib[..];
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
    /// - lib.rs `quit_final`: the end of the quit sequence itself; `exit_watchdog` (`process::exit`, and `libc::_exit` on Unix) ends the
    ///   process when that sequence hangs, 40 s after `quit_final` began (the page's part is over by then, see quitwait.rs).
    /// - update.rs `update_install`: the page saved the draft and waited for the sends before it asked for the install (REQ-27 / 28).
    /// - startup.rs: the restart for a dead web view (the page is gone, there is nothing to ask; Undo-window messages are in the outbox).
    /// - startfail.rs: the app could not start (Windows message box, then exit code 1): there is no page and no draft or send yet.
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
            let code = crate::test_guard::non_test_code(&src);
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
            vec![("lib.rs".to_string(), 3, 0), ("startfail.rs".to_string(), 1, 0), ("startup.rs".to_string(), 0, 1), ("update.rs".to_string(), 1, 1)],
            "a way to end or restart the process was added or removed: make sure it goes through the quit sequence (request_quit) or is justified in the comment above"
        );
    }

    /// The macOS menu wiring type-checks on every platform (the calls themselves are `cfg(target_os = "macos")`).
    #[allow(dead_code)]
    fn macos_menu_wiring_type_checks() -> tauri::Builder<tauri::Wry> {
        tauri::Builder::<tauri::Wry>::default().menu(shell::mac_app_menu).on_menu_event(shell::mac_menu_event)
    }
}

/// Who may call which command (REQ-S2): build.rs lists every command for the app manifest, capabilities/default.json grants all of them to
/// the main window, capabilities/popout.json grants the secondary windows a short allowlist. A command added to `generate_handler!` and
/// not to the other two lists would not be callable from any window, so these tests fail until it is placed.
#[cfg(test)]
mod capability_tests {
    use std::collections::BTreeSet;

    fn handler_commands() -> BTreeSet<String> {
        let lib = crate::test_guard::non_test_code(include_str!("lib.rs"));
        let at = lib.find("tauri::generate_handler![").expect("generate_handler");
        let body = &lib[at + "tauri::generate_handler![".len()..];
        let body = &body[..body.find("])").expect("end of the handler list")];
        body.lines()
            .map(|l| l.trim().trim_end_matches(','))
            .filter(|l| !l.is_empty() && !l.starts_with("//"))
            .map(|l| l.rsplit("::").next().unwrap().to_string())
            .collect()
    }

    fn manifest_commands() -> BTreeSet<String> {
        let b = include_str!("../build.rs");
        let start = "const APP_COMMANDS: &[&str] = &[";
        let body = &b[b.find(start).expect("APP_COMMANDS") + start.len()..];
        let body = &body[..body.find("];").unwrap()];
        body.split(',').map(|s| s.trim().trim_matches('"').to_string()).filter(|s| !s.is_empty()).collect()
    }

    fn capability(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn granted(cap: &serde_json::Value) -> BTreeSet<String> {
        cap["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).filter_map(|p| p.strip_prefix("allow-")).map(|p| p.replace('-', "_")).collect()
    }

    fn windows(cap: &serde_json::Value) -> Vec<String> {
        cap["windows"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn every_command_is_in_the_manifest_and_granted_to_the_main_window() {
        let handler = handler_commands();
        assert!(handler.len() > 100 && handler.contains("popout_open") && handler.contains("frame_info"), "{handler:?}");
        assert_eq!(handler, manifest_commands(), "build.rs APP_COMMANDS and generate_handler! differ");
        let main = capability("default.json");
        assert_eq!(windows(&main), ["main"]);
        assert_eq!(handler, granted(&main), "capabilities/default.json and generate_handler! differ");
    }

    #[test]
    fn the_secondary_windows_get_a_short_allowlist_without_the_dangerous_commands() {
        let handler = handler_commands();
        let pop = capability("popout.json");
        assert_eq!(windows(&pop), ["compose-*", "reader-*"], "exactly the labels of popout.rs, and never main");
        let ok = granted(&pop);
        assert!(ok.is_subset(&handler), "granted but not a command: {:?}", ok.difference(&handler).collect::<Vec<_>>());
        assert!(ok.len() < handler.len() / 2, "an allowlist, not everything");
        // REQ-S2: denied for the secondary windows
        let denied = [
            // accounts and secrets
            "add_account", "update_account", "remove_account", "google_sign_in", "microsoft_sign_in", "oauth_cancel", "reauth_account", "discover_server", "set_secret",
            // PGP key management
            "pgp_generate_key", "pgp_import_key", "pgp_import_from_message", "pgp_export_public", "pgp_export_secret", "pgp_delete_key", "pgp_set_verified", "pgp_set_default",
            "pgp_change_passphrase", "pgp_set_expiry", "pgp_lock_all", "pgp_pick_key_file", "pgp_inspect_key",
            // settings, rules, autostart, the lists of the main page
            "set_setting", "save_rule", "delete_rule", "list_rules", "set_autostart", "get_autostart", "save_template", "delete_template", "save_signature", "delete_signature",
            // updates
            "check_update", "update_download", "update_cancel", "update_discard", "update_defer", "update_note", "update_install", "update_startup_state", "update_startup_ack",
            // quit and the main page's start-up
            "quit_now", "quit_cancelled", "sends_flushed", "quit_page_alive", "quit_dialog", "frontend_ready", "page_state", "page_pong", "show_window", "set_mail_available", "take_tray_compose",
            // calendar connections, sync triggers, mail actions that belong to the main page's intent layer
            "calendar_connect", "calendar_disconnect", "calendar_sources", "calendar_set_sync", "calendar_sync_now", "sync_account", "refresh_badge", "thread_action",
            "queue_action", "cancel_action", "sender_action", "load_older", "idle_states", "frame_info", "frame_caption_rect", "frame_system_menu", "test_notification",
            // a secondary window asks the main page (popout_request); only the main page answers
            "popout_reply", "popout_save_all",
        ];
        for c in denied {
            assert!(handler.contains(c), "{c} is not a command any more: update this list");
            assert!(!ok.contains(c), "a secondary window may call {c}");
        }
        // what they need to answer a quit: their own commands, not the main page's
        for c in ["popout_flush_alive", "popout_flush_dialog", "popout_flush_done", "popout_init", "popout_ready", "popout_request", "thread_meta"] {
            assert!(ok.contains(c), "{c}");
        }
        // no window creates windows, and no page gets more of the window API than the spec lists (REQ-W1, S5)
        let perms: Vec<&str> = pop["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        for p in &perms {
            assert!(!p.contains("create-webview") && !p.contains("webview:allow") && !p.contains("allow-destroy") && !p.contains("set-fullscreen"), "{p}");
        }
        for p in ["core:window:allow-close", "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-start-dragging", "core:window:allow-set-title", "core:window:allow-set-focus", "core:window:allow-set-content-protected", "core:event:default"] {
            assert!(perms.contains(&p), "{p}");
        }
        assert!(!perms.contains(&"core:default"), "core:default also grants what a pop-out does not need");
    }
}

#[cfg(test)]
mod thread_meta_tests {
    use super::*;

    #[test]
    fn the_pin_and_the_snooze_of_a_conversation_are_read_from_thread_meta() {
        let c = db::test_conn(&["a1"]);
        let meta = |id: &str| thread_meta_in(&c, id).unwrap();
        // no row: nothing is set
        let none = meta("t-none");
        assert!(!none.pinned && none.snoozed_until.is_none());
        c.execute("INSERT INTO thread_meta(thread_id,pinned) VALUES('t-pin',1)", []).unwrap();
        c.execute("INSERT INTO thread_meta(thread_id,snoozed_until) VALUES('t-snooze',1760000000)", []).unwrap();
        c.execute("INSERT INTO thread_meta(thread_id,pinned,snoozed_until) VALUES('t-both',1,1760000001)", []).unwrap();
        c.execute("INSERT INTO thread_meta(thread_id,pinned) VALUES('t-unpinned',0)", []).unwrap();
        let (p, s, b, u) = (meta("t-pin"), meta("t-snooze"), meta("t-both"), meta("t-unpinned"));
        assert!(p.pinned && p.snoozed_until.is_none());
        assert!(!s.pinned && s.snoozed_until == Some(1_760_000_000));
        assert!(b.pinned && b.snoozed_until == Some(1_760_000_001));
        assert!(!u.pinned && u.snoozed_until.is_none(), "an unpinned conversation keeps its row");
        // the answer the page reads: camelCase
        assert_eq!(serde_json::to_value(&p).unwrap(), serde_json::json!({ "pinned": true, "snoozedUntil": null }));
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

    // ----- the "Downloading mails..." line must end however the background download ends -----

    fn account() -> Account {
        Account {
            id: ACC.into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
        }
    }

    /// A manually added account holding the newest `n` inbox messages (uids `total-n+1 ..= total`): what the first sync leaves.
    fn first_sync(total: u32, n: u32) -> Db {
        let db = db_with(&((total - n + 1)..=total).map(|u| ("inbox", u)).collect::<Vec<_>>());
        db::insert_account(&lock(&db), &account()).unwrap();
        db
    }

    fn parsed(uid: u32) -> mail::Parsed {
        mail::Parsed {
            uid, message_id: None, refs: vec![], subject: "s".into(), from_name: "n".into(), from_email: "e@example.com".into(), to: vec![], cc: vec![],
            date: uid as i64, snippet: String::new(), html: None, text: Some("t".into()), seen: true, flagged: false, attachments: vec![],
            list_unsub: None, list_unsub_post: false, pgp: 0, pgp_raw: None, ics: None, cal_method: None, importance: importance::Importance::Normal, auth: authres::Auth::Unknown,
        }
    }

    /// A server holding uids 1..=`total`: the `count` highest below `below`, like `mail::fetch_older`.
    fn server(total: u32) -> impl FnMut(&Account, &str, u32, usize) -> R<(Vec<mail::Parsed>, bool)> {
        move |_, _, below, count| {
            let (pick, exhausted) = mail::pick_older((1..=total).filter(|u| *u < below), below, count);
            Ok((pick.into_iter().map(parsed).collect(), exhausted))
        }
    }

    /// (role, have, target, done) of the events a run emitted.
    type Ev = (String, u64, u64, bool);

    fn run(db: &Db, fetch: &mut dyn FnMut(&Account, &str, u32, usize) -> R<(Vec<mail::Parsed>, bool)>, between: &mut dyn FnMut(&Db, usize)) -> (R<()>, Vec<Ev>) {
        let mut events: Vec<Ev> = vec![];
        let r = backfill_loop(db, ACC, std::time::Duration::ZERO, fetch, &mut |ev| {
            assert_eq!(ev["accountId"], ACC);
            events.push((ev["role"].as_str().unwrap().into(), ev["have"].as_u64().unwrap(), ev["target"].as_u64().unwrap(), ev["done"].as_bool().unwrap()));
            between(db, events.len()); // what happens in the pause after an event
        });
        (r, events)
    }

    /// The last event is what the UI keeps showing: it must end the line (`done`), whatever stopped the run.
    fn ends_the_line(events: &[Ev]) -> bool {
        events.last().map(|e| e.3).unwrap_or(true)
    }

    #[test]
    fn a_complete_download_ends_with_its_own_done_event_and_no_extra_one() {
        // 101 inbox messages: the first sync took the newest 50, two chunks follow (50, then the last 1)
        let db = first_sync(101, 50);
        let (r, ev) = run(&db, &mut server(101), &mut |_, _| {});
        assert!(r.is_ok());
        assert_eq!(ev, vec![("inbox".into(), 100, 500, false), ("inbox".into(), 101, 500, true)]);
        assert_eq!(folder_state(&db, ACC, "inbox").unwrap(), (101, 1));
    }

    /// The repro of the stuck "Downloading mails... 100/500": the list asks for older mail by itself when its end is in view
    /// (`loadMore` -> `load_older_impl`), and in the pause after a chunk it reaches the end of the folder and marks it as complete.
    /// The background download then finds nothing to do, stops, and no event says so.
    #[test]
    fn a_folder_completed_by_load_older_between_two_chunks_still_ends_the_line() {
        let db = first_sync(300, 50);
        let (r, ev) = run(&db, &mut server(300), &mut |db, n| {
            if n == 1 {
                // load_older got everything that is left and set the mark
                for u in 1..=200 {
                    lock(db).execute("INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet) VALUES(?1,?2,'inbox',?3,'t','s','n','e','','',?3,'')", params![format!("l{u}"), ACC, u]).unwrap();
                }
                db::set_setting(&lock(db), &exhausted_key(ACC, "inbox"), "1").unwrap();
            }
        });
        assert!(r.is_ok());
        assert_eq!(ev[0], ("inbox".into(), 100, 500, false), "{ev:?}");
        assert!(ends_the_line(&ev), "the last event still says 'downloading': {ev:?}");
        assert_eq!(ev.iter().filter(|e| e.3).count(), 1, "one closing event: {ev:?}");
    }

    #[test]
    fn a_cap_reached_or_lowered_between_two_chunks_still_ends_the_line() {
        let db = first_sync(900, 50);
        let (r, ev) = run(&db, &mut server(900), &mut |db, n| {
            if n == 1 {
                db::set_setting(&lock(db), "max_download", "100").unwrap(); // lowered in Settings: applies to the next chunk
            }
        });
        assert!(r.is_ok());
        assert_eq!(ev[0], ("inbox".into(), 100, 500, false));
        assert!(ends_the_line(&ev), "{ev:?}");
        // new mail from a sync fills the account up to its cap
        let db = first_sync(900, 50);
        let (_, ev) = run(&db, &mut server(900), &mut |db, n| {
            if n == 2 {
                db::set_setting(&lock(db), "max_download", "100").unwrap();
            }
        });
        assert!(ends_the_line(&ev), "{ev:?}");
    }

    #[test]
    fn a_download_that_fails_twice_in_a_row_ends_the_line_and_reports_the_error() {
        let db = first_sync(900, 50);
        let mut good = server(900);
        let mut calls = 0;
        let (r, ev) = run(
            &db,
            &mut |a, n, b, c| {
                calls += 1;
                if calls == 1 { good(a, n, b, c) } else { Err("connection reset".to_string()) }
            },
            &mut |_, _| {},
        );
        assert_eq!(r, Err("connection reset".to_string()));
        assert_eq!(calls, 3, "one chunk, then the failure and one retry");
        assert_eq!(ev[0], ("inbox".into(), 100, 500, false));
        assert!(ends_the_line(&ev), "{ev:?}");
        // a single failure is retried and does not end anything
        let db = first_sync(120, 50);
        let mut good = server(120);
        let mut calls = 0;
        let (r, ev) = run(&db, &mut |a, n, b, c| { calls += 1; if calls == 1 { Err("hiccup".to_string()) } else { good(a, n, b, c) } }, &mut |_, _| {});
        assert!(r.is_ok());
        assert_eq!(ev.last(), Some(&("inbox".into(), 120, 500, true)));
    }

    #[test]
    fn a_removed_account_ends_the_line() {
        let db = first_sync(900, 50);
        let (r, ev) = run(&db, &mut server(900), &mut |db, n| {
            if n == 1 {
                lock(db).execute("DELETE FROM accounts WHERE id=?1", params![ACC]).unwrap();
            }
        });
        assert!(r.is_err());
        assert!(ends_the_line(&ev), "{ev:?}");
    }

    #[test]
    fn nothing_to_download_emits_nothing() {
        let db = first_sync(30, 30); // the first sync took everything: lowest uid 1
        let (r, ev) = run(&db, &mut server(30), &mut |_, _| {});
        assert!(r.is_ok() && ev.is_empty());
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
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
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
            assert_eq!(ensure_not_confidential(&c, id).unwrap_err(), "CONFIDENTIAL: This message is confidential, so that isn’t allowed.");
        }
    }
}

/// 1.0.7 W7.3: the receiving server's verdict is stored with the message at sync time and holds a calendar update that fails the check.
#[cfg(test)]
mod sender_check_tests {
    use super::*;

    fn account() -> Account {
        Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
        }
    }

    /// An invitation mail from the organizer; `headers` are the lines (with their CRLF) the receiving server put on top.
    fn invitation(uid: u32, seq: i64, hour: u32, headers: &str) -> Vec<u8> {
        format!(
            "{headers}From: Mai <mai@contoso.com>\r\nTo: me@example.com\r\nSubject: Product sync\r\nMessage-ID: <m{uid}@contoso.com>\r\nDate: Mon, 12 Oct 2026 10:00:0{uid} +0000\r\n\
MIME-Version: 1.0\r\nContent-Type: text/calendar; method=REQUEST; charset=utf-8\r\n\r\n\
BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:sync-1@contoso.com\r\nSEQUENCE:{seq}\r\nDTSTAMP:20261001T080000Z\r\n\
DTSTART:20261014T{hour:02}0000Z\r\nDTEND:20261014T{:02}0000Z\r\nSUMMARY:Product sync\r\nORGANIZER;CN=Mai:mailto:mai@contoso.com\r\n\
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            hour + 1
        )
        .into_bytes()
    }

    fn store(c: &Connection, uid: u32, seq: i64, hour: u32, headers: &str) {
        let p = mail::parse(uid, &invitation(uid, seq, hour, headers), false, false, 0).unwrap();
        insert_parsed(c, &account(), "inbox", &p).unwrap();
    }

    fn start_of_event(c: &Connection) -> i64 {
        calendar::list_range(c, 0, i64::MAX / 4).unwrap().first().map(|e| e.start).unwrap_or(0)
    }

    fn at(hour: u32) -> i64 {
        chrono::NaiveDate::from_ymd_opt(2026, 10, 14).unwrap().and_hms_opt(hour, 0, 0).unwrap().and_utc().timestamp()
    }

    fn verdict(c: &Connection, uid: u32) -> Option<String> {
        c.query_row("SELECT auth_result FROM messages WHERE id=?1", [format!("a1:inbox:{uid}")], |r| r.get(0)).unwrap()
    }

    #[test]
    fn the_verdict_is_stored_and_a_failed_update_waits_for_the_person() {
        let c = db::test_conn(&["a1"]);
        db::insert_account(&c, &account()).unwrap();
        // the first invitation (no Authentication-Results at all, as many self-hosted servers): added as in 1.0.6, verdict unknown
        store(&c, 1, 0, 8, "");
        assert_eq!(verdict(&c, 1), None);
        assert_eq!(start_of_event(&c), at(8));
        // an update that passes (topmost header) with a forged "fail" below: applied
        store(&c, 2, 1, 9, "Authentication-Results: mx.example; dmarc=pass header.from=contoso.com\r\nAuthentication-Results: mx.evil; dmarc=fail\r\n");
        assert_eq!(verdict(&c, 2).as_deref(), Some("pass"));
        assert_eq!(start_of_event(&c), at(9));
        // an update that fails the check: stored with its verdict, not applied; Apply anyway (the command's ingest) applies it
        store(&c, 3, 2, 10, "Authentication-Results: mx.example; spf=pass; dmarc=fail action=none header.from=contoso.com; compauth=fail reason=000\r\n");
        assert_eq!(verdict(&c, 3).as_deref(), Some("fail"));
        assert_eq!(start_of_event(&c), at(9), "the event keeps its time");
        let (text, from): (String, String) = c.query_row("SELECT ics,from_email FROM messages WHERE id='a1:inbox:3'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let card = calendar::invite_for(&c, "a1", "a1:inbox:3", "inbox", &from, &text, false);
        assert!(card.unverified && card.held, "the card warns and offers the held change");
        let applied = calendar::ingest_checked(&c, &account(), "a1:inbox:3", &from, &text, true, calendar::stored_auth(&c, "a1:inbox:3"), true).unwrap();
        assert!(applied.changed);
        assert_eq!(start_of_event(&c), at(10));
        // re-syncing the same message (a restart, a second folder) does not change anything and keeps the verdict
        store(&c, 3, 2, 10, "Authentication-Results: mx.example; dmarc=fail header.from=contoso.com\r\n");
        assert_eq!(verdict(&c, 3).as_deref(), Some("fail"));
        assert_eq!(start_of_event(&c), at(10));
    }

    #[test]
    fn a_new_invitation_that_fails_the_check_is_not_added_by_the_sync() {
        let c = db::test_conn(&["a1"]);
        store(&c, 1, 0, 8, "Authentication-Results: mx.example; dmarc=fail header.from=contoso.com\r\n");
        assert_eq!(verdict(&c, 1).as_deref(), Some("fail"));
        assert!(calendar::list_range(&c, 0, i64::MAX / 4).unwrap().is_empty());
        store(&c, 2, 0, 8, "Authentication-Results: mx.example; dkim=pass header.d=contoso.com\r\n");
        assert_eq!(start_of_event(&c), at(8), "the same invitation with a passing check is added");
    }
}

/// F-24: importance read from received mail is stored, shown in the list and the reading pane, and changes nothing else.
#[cfg(test)]
mod importance_tests {
    use super::*;
    use importance::Importance::{self, *};

    fn account() -> Account {
        Account {
            id: "a1".into(), email: "me@example.com".into(), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
        }
    }

    fn raw(uid: u32, subject: &str, extra: &str) -> Vec<u8> {
        format!("From: Ann <ann@example.com>\r\nTo: me@example.com\r\nSubject: {subject}\r\nMessage-ID: <m{uid}@example.com>\r\nDate: Mon, 12 Oct 2026 10:00:0{uid} +0000\r\n{extra}\r\nbody\r\n").into_bytes()
    }

    fn store(c: &Connection, uid: u32, subject: &str, extra: &str) {
        let p = mail::parse(uid, &raw(uid, subject, extra), false, false, 0).unwrap();
        insert_parsed(c, &account(), "inbox", &p).unwrap();
    }

    fn filter() -> ThreadFilter {
        serde_json::from_str(r#"{"folder":"inbox"}"#).unwrap()
    }

    #[test]
    fn received_importance_is_stored_listed_and_read_back_without_touching_order() {
        let c = db::test_conn(&["a1"]);
        store(&c, 1, "plain", "");
        store(&c, 2, "urgent", "X-Priority: 1 (Highest)\r\nImportance: High\r\n");
        store(&c, 3, "later", "Importance: low\r\n");
        store(&c, 4, "outlook", "X-MSMail-Priority: High\r\n");
        store(&c, 5, "old school", "Priority: non-urgent\r\n");
        store(&c, 6, "three", "X-Priority: 3 (Normal)\r\n");
        let list = threads_for(&c, filter()).unwrap();
        let by: HashMap<String, Importance> = list.iter().map(|t| (t.subject.clone(), t.importance)).collect();
        assert_eq!(by["plain"], Normal);
        assert_eq!(by["urgent"], High);
        assert_eq!(by["later"], Low);
        assert_eq!(by["outlook"], High);
        assert_eq!(by["old school"], Low);
        assert_eq!(by["three"], Normal);
        // order is by date as before (newest first), whatever the importance
        let subjects: Vec<&str> = list.iter().map(|t| t.subject.as_str()).collect();
        assert_eq!(subjects, ["three", "old school", "outlook", "later", "urgent", "plain"]);
        // the reading pane
        assert_eq!(message_full(&c, "a1:inbox:2").unwrap().importance, High);
        assert_eq!(message_full(&c, "a1:inbox:3").unwrap().importance, Low);
        assert_eq!(message_full(&c, "a1:inbox:1").unwrap().importance, Normal);
        // wire names for the interface
        let urgent = list.iter().find(|t| t.subject == "urgent").unwrap();
        assert_eq!(serde_json::to_value(urgent).unwrap()["importance"], "high");
        assert_eq!(serde_json::to_value(message_full(&c, "a1:inbox:3").unwrap()).unwrap()["importance"], "low");
        // syncing the same message again with different headers updates the stored value (INSERT OR REPLACE)
        store(&c, 1, "plain", "Importance: high\r\n");
        assert_eq!(message_full(&c, "a1:inbox:1").unwrap().importance, High);
    }

    #[test]
    fn a_conversation_shows_high_over_low_over_normal() {
        let c = db::test_conn(&["a1"]);
        // one thread: a root and replies that reference it
        store(&c, 1, "topic", "");
        store(&c, 2, "Re: topic", "In-Reply-To: <m1@example.com>\r\nReferences: <m1@example.com>\r\nImportance: low\r\n");
        let l = threads_for(&c, filter()).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].importance, Low);
        store(&c, 3, "Re: topic", "In-Reply-To: <m1@example.com>\r\nReferences: <m1@example.com>\r\nX-Priority: 1\r\n");
        let l = threads_for(&c, filter()).unwrap();
        assert_eq!((l.len(), l[0].count, l[0].importance), (1, 3, High));
    }

    #[test]
    fn a_sent_high_importance_message_comes_back_high_from_the_sent_folder() {
        let c = db::test_conn(&["a1"]);
        let acc = account();
        let d = smtp::Draft {
            account_id: "a1".into(), to: vec!["ann@example.com".into()], cc: vec![], bcc: vec![], subject: "Ship it".into(), html: "<p>x</p>".into(), text: "x".into(),
            in_reply_to: None, references: vec![], attachments: vec![], inline: vec![], security: None, prebuilt: None, meeting: None, calendar: None,
            confidential: false, importance: High, recovery_id: None, meeting_form: None, answers: None,
        };
        let sent = smtp::build(&acc, &d).unwrap().formatted();
        let p = mail::parse(1, &sent, true, false, 0).unwrap();
        insert_parsed(&c, &acc, "sent", &p).unwrap();
        let f: ThreadFilter = serde_json::from_str(r#"{"folder":"sent"}"#).unwrap();
        assert_eq!(threads_for(&c, f).unwrap()[0].importance, High);
    }

    /// W2.21: the Reply-To saved in Settings (`update_profile`, as the command does) is read back with the mailbox and written into the message that is
    /// finished for sending; a mailbox that has none, or whose own address it is, writes none.
    #[test]
    fn a_mailbox_reply_to_saved_in_settings_reaches_the_message_that_is_sent() {
        let c = db::test_conn(&["a1"]);
        let mine = account();
        db::insert_account(&c, &mine).unwrap();
        let own = mine.email.clone();
        assert_eq!(mine.id, "a1");
        let d = smtp::Draft {
            account_id: "a1".into(), to: vec!["ann@example.com".into()], cc: vec![], bcc: vec![], subject: "Hi".into(), html: "<p>x</p>".into(), text: "x".into(),
            in_reply_to: None, references: vec![], attachments: vec![], inline: vec![], security: None, prebuilt: None, meeting: None, calendar: None,
            confidential: false, importance: Default::default(), recovery_id: None, meeting_form: None, answers: None,
        };
        let reply_to = |c: &Connection| {
            let acc = db::get_account(c, "a1").unwrap();
            let shared: Db = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
            let (raw, _) = finished_message(&shared, &acc, &d).unwrap();
            let (h, _) = pgpmail::parse_headers(&raw);
            h.into_iter().filter(|(n, _)| n.eq_ignore_ascii_case("reply-to")).map(|(_, v)| v.trim().to_string()).collect::<Vec<_>>()
        };
        assert!(reply_to(&c).is_empty(), "none until it is set");
        db::update_profile(&c, "a1", "Me", None, Some("team@x.test")).unwrap();
        assert_eq!(reply_to(&c), vec!["team@x.test".to_string()]);
        db::update_profile(&c, "a1", "Me renamed", Some("#0f6cbd"), None).unwrap();
        assert_eq!(reply_to(&c), vec!["team@x.test".to_string()], "a new name or colour leaves it");
        db::update_profile(&c, "a1", "Me", None, Some(&own)).unwrap();
        assert!(reply_to(&c).is_empty(), "the mailbox's own address needs no header");
    }
}

#[cfg(test)]
mod download_dir_tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh scratch "home" for one test: nothing in it, removed by the caller.
    fn temp_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("hl-home-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn a_missing_download_folder_falls_back_and_says_so() {
        let home = temp_home("configured");
        let sys = home.join("Downloads");
        std::fs::create_dir_all(&sys).unwrap();
        let ok = home.join("chosen");
        std::fs::create_dir_all(&ok).unwrap();
        let pick = |configured: Option<&str>| pick_save_dir(configured, Some(sys.clone()), Some(home.clone())).unwrap();
        // not set, or blank: the system folder, nothing to report
        assert_eq!(pick(None), (sys.clone(), None));
        assert_eq!(pick(Some("  ")), (sys.clone(), None));
        // an existing folder is used as written
        assert_eq!(pick(Some(ok.to_str().unwrap())), (ok.clone(), None));
        // a folder that is gone (or a file) falls back and reports the configured path
        let gone = home.join("hl-folder-that-does-not-exist-9f2c");
        assert_eq!(pick(Some(gone.to_str().unwrap())), (sys.clone(), gone.to_str().map(String::from)));
        assert!(!gone.exists(), "a configured folder is never created behind the person's back");
        let file = home.join("hl-a-file-not-a-folder.txt");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(pick(file.to_str()), (sys.clone(), file.to_str().map(String::from)));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// QA Linux round 3, BUG-L7: `~/Downloads` is set in the XDG file but the folder is not there (never made, or moved away): the
    /// save made it fail with "No such file or directory (os error 2)". The folder is created now, and nothing is said (it is where
    /// the person expects it).
    #[test]
    fn a_missing_downloads_folder_is_created() {
        let home = temp_home("missing");
        let sys = home.join("Downloads");
        assert!(!sys.exists());
        assert_eq!(pick_save_dir(None, Some(sys.clone()), Some(home.clone())).unwrap(), (sys.clone(), None));
        assert!(sys.is_dir(), "the folder was created");
        assert!(std::fs::read_dir(&sys).unwrap().next().is_none(), "the write probe leaves nothing behind");
        // a save into it works
        assert!(write_unique(&sys, "note.txt", b"hello").unwrap().starts_with(&sys));
        // a missing configured folder falls back to the (created) Downloads folder and says which one was not there
        let gone = home.join("gone");
        assert_eq!(pick_save_dir(gone.to_str(), Some(sys.clone()), Some(home.clone())).unwrap(), (sys.clone(), gone.to_str().map(String::from)));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A Downloads folder that cannot be made or used (a file is in its place, its parent is not a folder, the system names none, as on
    /// a bare Linux install) gives the home folder and the notice about "Downloads".
    #[test]
    fn a_downloads_folder_that_cannot_be_used_falls_back_to_the_home_folder() {
        let home = temp_home("blocked");
        let blocker = home.join("Downloads");
        std::fs::write(&blocker, b"a file where the folder should be").unwrap();
        let under_a_file = blocker.join("sub");
        for system in [Some(blocker.clone()), Some(under_a_file), None] {
            let (dir, notice) = pick_save_dir(None, system.clone(), Some(home.clone())).unwrap();
            assert_eq!((dir.as_path(), notice.as_deref()), (home.as_path(), Some("Downloads")), "system folder {system:?}");
            assert!(write_unique(&dir, "note.txt", b"hello").is_ok());
        }
        // a configured folder that is gone gets reported under its own name, not "Downloads"
        let gone = home.join("gone");
        let (dir, notice) = pick_save_dir(gone.to_str(), None, Some(home.clone())).unwrap();
        assert_eq!((dir.as_path(), notice), (home.as_path(), gone.to_str().map(String::from)));
        // nothing to save into at all
        assert!(pick_save_dir(None, None, None).unwrap_err().starts_with("NO_SAVE_FOLDER"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A folder that exists but cannot be written to (read-only) is not used either. Unix permissions: not run on Windows, and a run
    /// as root (which can write anywhere) proves nothing and passes.
    #[cfg(unix)]
    #[test]
    fn a_read_only_downloads_folder_falls_back_to_the_home_folder() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("readonly");
        let sys = home.join("Downloads");
        std::fs::create_dir_all(&sys).unwrap();
        std::fs::set_permissions(&sys, std::fs::Permissions::from_mode(0o555)).unwrap();
        if std::fs::write(sys.join("probe"), b"x").is_ok() {
            let _ = std::fs::remove_file(sys.join("probe"));
        } else {
            let (dir, notice) = pick_save_dir(None, Some(sys.clone()), Some(home.clone())).unwrap();
            assert_eq!((dir.as_path(), notice.as_deref()), (home.as_path(), Some("Downloads")));
        }
        std::fs::set_permissions(&sys, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(&home);
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

    #[test]
    fn a_keyring_that_does_not_answer_ends_in_a_message_and_leaves_nothing() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::{Duration, Instant};
        // a locked keyring: the call answers only after 1.5 s; the wait is 300 ms
        let stored = Arc::new(AtomicBool::new(false));
        let undone = Arc::new(AtomicBool::new(false));
        let (s, u) = (stored.clone(), undone.clone());
        let t = Instant::now();
        let e = store_within(
            Duration::from_millis(300),
            &|| false,
            move || {
                std::thread::sleep(Duration::from_millis(1500));
                s.store(true, Ordering::SeqCst);
                Ok(())
            },
            move || u.store(true, Ordering::SeqCst),
        )
        .expect_err("no answer in time");
        assert!(t.elapsed() < Duration::from_millis(1200), "the form does not wait for the keyring: {:?}", t.elapsed());
        assert!(e.starts_with("KEYRING_TIMEOUT: Your system keyring is locked or not answering. Unlock it (Passwords and Keys / KWallet) and try again."), "{e}");
        // the keyring answers late: what it stored for the account that was never added is removed again
        std::thread::sleep(Duration::from_millis(1500));
        assert!(stored.load(Ordering::SeqCst) && undone.load(Ordering::SeqCst), "the late write is undone");
    }

    #[test]
    fn a_keyring_that_answers_behaves_as_before() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        let undone = Arc::new(AtomicBool::new(false));
        let u = undone.clone();
        assert!(store_within(Duration::from_secs(5), &|| false, || Ok(()), move || u.store(true, Ordering::SeqCst)).is_ok());
        // its own refusal comes back untouched
        let e = store_within(Duration::from_secs(5), &|| false, || Err("no Secret Service".into()), || ()).unwrap_err();
        assert_eq!(e, "no Secret Service");
        std::thread::sleep(Duration::from_millis(200));
        assert!(!undone.load(Ordering::SeqCst), "an answered write is kept");
    }

    #[test]
    fn cancel_ends_the_wait_at_once() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::{Duration, Instant};
        let flag = Arc::new(AtomicBool::new(false));
        let f = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            f.store(true, Ordering::SeqCst);
        });
        let t = Instant::now();
        let e = store_within(Duration::from_secs(30), &|| flag.load(Ordering::SeqCst), || {
            std::thread::sleep(Duration::from_secs(2));
            Ok(())
        }, || ()).unwrap_err();
        assert!(e.starts_with("ADD_CANCELLED"), "{e}");
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    }

    #[test]
    fn the_wait_is_thirty_seconds_and_runs_off_the_ui_thread() {
        assert_eq!(KEYRING_WAIT, std::time::Duration::from_secs(30));
        // add_account is async and runs the add in `blocking` (a worker); the keyring call is on a thread of its own inside that
        let code = include_str!("lib.rs");
        let add = &code[code.find("async fn add_account(").unwrap()..];
        assert!(add[..add.find("\n}\n").unwrap()].contains("blocking(move ||"));
    }

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
    fn a_rejected_sign_in_is_announced_once_and_again_when_it_works() {
        let mut f = std::collections::BTreeMap::new();
        let reauth = "OAUTH_REAUTH|label=Google: Google sign-in expired or revoked (invalid_grant). Sign in again.";
        let blocked = "OAUTH_BLOCKED|label=Microsoft: Your organization may need to approve Hey Look! for this Microsoft account.";
        assert_eq!(track_signin(&mut f, "a", Some(reauth)), Some(Some("again")));
        // the next failed syncs (every 2 minutes, and the push session) say nothing new
        assert_eq!(track_signin(&mut f, "a", Some(reauth)), None);
        assert_eq!(track_signin(&mut f, "a", Some(reauth)), None);
        // another account is its own case; so is another kind of problem on the same one
        assert_eq!(track_signin(&mut f, "b", Some(blocked)), Some(Some("blocked")));
        assert_eq!(track_signin(&mut f, "a", Some(blocked)), Some(Some("blocked")));
        // an error that is not about the sign-in (offline) neither flags nor clears
        assert_eq!(track_signin(&mut f, "c", Some("dns error")), None);
        assert_eq!(track_signin(&mut f, "a", Some("dns error")), None);
        assert_eq!(f.get("a"), Some(&"blocked"));
        // a good sync announces the recovery once
        assert_eq!(track_signin(&mut f, "a", None), Some(None));
        assert_eq!(track_signin(&mut f, "a", None), None);
        assert_eq!(track_signin(&mut f, "b", None), Some(None));
    }

}

// helper of the socket tests (the source-reading tests cut the file at the first inline test module, `test_guard::non_test_code`)
#[cfg(test)]
mod test_guard;
#[cfg(test)]
mod testutil;
#[cfg(test)]
mod fakeimap;
#[cfg(test)]
mod foldermove_tests;
#[cfg(test)]
mod readrace_tests;
#[cfg(test)]
mod testbridge_guard;

/// W13.5: a draft with nothing in it is refused with `DRAFT_EMPTY` before anything is built or sent to the server.
#[cfg(test)]
mod empty_draft_tests {
    use super::*;
    use base64::Engine;

    fn draft() -> smtp::Draft {
        smtp::Draft {
            account_id: "a1".into(), to: vec!["ann@example.com".into()], cc: vec![], bcc: vec![], subject: String::new(), html: String::new(), text: String::new(),
            in_reply_to: None, references: vec![], attachments: vec![], inline: vec![], security: None, prebuilt: None, meeting: None, calendar: None,
            confidential: false, importance: importance::Importance::Normal, recovery_id: None, meeting_form: None, answers: None,
        }
    }

    fn refused(d: &smtp::Draft) -> bool {
        ensure_draft_has_content(d).is_err_and(|e| e.starts_with("DRAFT_EMPTY:"))
    }

    /// D-025: a draft that is far too big is refused with a coded, translated message before any work is done; the limit is a number the page knows
    /// too (src/sendSize.ts `DRAFT_LIMIT`), and the limit itself is still allowed.
    #[test]
    fn a_draft_over_the_limit_is_refused_with_a_friendly_message() {
        let mut d = draft();
        d.text = "x".into();
        d.inline = vec![smtp::InlineImage { cid: "p1@heylook".into(), filename: "p.png".into(), mime: "image/png".into(), data_base64: "A".repeat(DRAFT_LIMIT - 1) }];
        assert_eq!(draft_size(&d), DRAFT_LIMIT);
        assert!(ensure_draft_size(&d).is_ok(), "exactly the limit is allowed");
        d.attachments = vec![smtp::Att { filename: "a.bin".into(), mime: "application/octet-stream".into(), data_base64: "A".into() }];
        let e = ensure_draft_size(&d).unwrap_err();
        assert_eq!(e, "DRAFT_TOO_LARGE|size=101 MB|limit=100 MB: This message is too large to keep as a draft (101 MB; the limit is 100 MB). Remove attachments or shrink pictures.");
        // a message that was sealed for the outbox counts by its finished bytes
        let mut s = draft();
        s.prebuilt = Some("A".repeat(DRAFT_LIMIT + 1));
        assert!(ensure_draft_size(&s).is_err());
        assert_eq!(DRAFT_LIMIT, 100 * 1024 * 1024);
        // the page asks the same number (src/sendSize.ts)
        let ts = include_str!("../../src/sendSize.ts");
        assert!(ts.contains("export const DRAFT_LIMIT = 100 * 1024 * 1024;"), "sendSize.ts DRAFT_LIMIT is not the number of lib.rs");
    }

    #[test]
    fn an_empty_draft_is_refused() {
        // recipients alone (and white space, an empty html shell, other switches) are not content
        let mut d = draft();
        assert!(refused(&d));
        d.subject = "   ".into();
        d.text = "\r\n \t".into();
        d.html = "<p><br></p>".into();
        d.bcc = vec!["bob@example.com".into()];
        d.confidential = true;
        d.importance = importance::Importance::High;
        assert!(refused(&d), "recipients, white space, Importance and Confidential are not content");
        // the refusal is the coded error the page knows
        assert_eq!(ensure_draft_has_content(&d).unwrap_err(), "DRAFT_EMPTY: There is nothing to save yet.");
    }

    #[test]
    fn a_draft_with_something_in_it_is_accepted() {
        let mut d = draft();
        d.subject = "Hello".into();
        assert!(ensure_draft_has_content(&d).is_ok(), "a subject");
        let mut d = draft();
        d.text = "ok".into();
        assert!(ensure_draft_has_content(&d).is_ok(), "text");
        let mut d = draft();
        d.attachments = vec![smtp::Att { filename: "a.txt".into(), mime: "text/plain".into(), data_base64: "YQ==".into() }];
        assert!(ensure_draft_has_content(&d).is_ok(), "an attachment");
        let mut d = draft();
        d.inline = vec![smtp::InlineImage { cid: "p1@heylook".into(), filename: "p.png".into(), mime: "image/png".into(), data_base64: "AA==".into() }];
        assert!(ensure_draft_has_content(&d).is_ok(), "an inline picture");
        let mut d = draft();
        d.prebuilt = Some("AAAA".into());
        assert!(ensure_draft_has_content(&d).is_ok(), "finished bytes are not judged");
    }

    #[test]
    fn a_meeting_place_counts_and_a_meeting_without_one_does_not() {
        let enc = |v: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.as_bytes());
        let mut d = draft();
        d.meeting_form = Some(enc(r#"{"v":1,"sd":"2026-10-20","st":"09:00","ed":"2026-10-20","et":"10:00","allDay":false,"where":"","tz":"UTC"}"#));
        assert!(refused(&d), "the strip on with no place");
        d.meeting_form = Some(enc(r#"{"v":1,"sd":"2026-10-20","st":"09:00","ed":"2026-10-20","et":"10:00","allDay":false,"where":"Room 4","tz":"UTC"}"#));
        assert!(ensure_draft_has_content(&d).is_ok(), "the strip with a place (the form the page wrote)");
        let mut d = draft();
        d.meeting = Some(smtp::Meeting { start: 1, end: 2, all_day: false, tzid: None, location: Some(" ".into()), rrule: None });
        assert!(refused(&d), "a blank place");
        d.meeting = Some(smtp::Meeting { start: 1, end: 2, all_day: false, tzid: None, location: Some("Room 4".into()), rrule: None });
        assert!(ensure_draft_has_content(&d).is_ok(), "the parsed meeting with a place");
        let mut d = draft();
        d.meeting_form = Some("not base64 json!".into());
        assert!(refused(&d), "a form that is not ours is not content");
    }
}

#[cfg(test)]
mod inbox_tab_count_tests {
    use super::*;

    const M1: &str = "m1";
    const M2: &str = "m2";

    fn account(id: &str) -> Account {
        Account {
            id: id.into(), email: format!("{id}@example.com"), display_name: "Me".into(), imap_host: "h".into(), imap_port: 993, imap_ssl: true,
            smtp_host: "s".into(), smtp_port: 465, smtp_security: "ssl".into(), username: "u".into(), auth: "password".into(), color: None,
            smtp_username: String::new(), tls_insecure: false, reply_to: String::new(),
        }
    }

    /// Two mailboxes. M1 Inbox: F1 unread normal; F2 read normal; B1 unread bulk; X unread bulk + unread normal (both tabs); S unread normal but
    /// snoozed; BL unread normal from a blocked sender; P unread normal whose snooze has passed; an unread archived mail. M2 Inbox: 1 unread
    /// normal and 2 unread bulk.
    fn fixture() -> Connection {
        let c = db::test_conn(&[]);
        for id in [M1, M2] {
            db::insert_account(&c, &account(id)).unwrap();
        }
        let mut uid = 0;
        let mut put = |acct: &str, folder: &str, thread: &str, seen: bool, bulk: bool, from: &str| {
            uid += 1;
            c.execute(
                "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,seen,list_unsub)
                 VALUES(?1,?2,?3,?4,?5,'s','n',?6,'','',?4,'',?7,?8)",
                params![format!("{acct}:{folder}:{uid}"), acct, folder, uid, thread, from, seen as i64, bulk.then_some("<mailto:u@example.test>")],
            )
            .unwrap();
        };
        put(M1, "inbox", "f1", false, false, "a@example.com");
        put(M1, "inbox", "f2", true, false, "a@example.com");
        put(M1, "inbox", "b1", false, true, "news@example.com");
        put(M1, "inbox", "x", false, true, "news@example.com");
        put(M1, "inbox", "x", false, false, "a@example.com");
        put(M1, "inbox", "s", false, false, "a@example.com");
        put(M1, "inbox", "bl", false, false, "blocked@example.com");
        put(M1, "inbox", "p", false, false, "a@example.com");
        put(M1, "archive", "arch", false, false, "a@example.com");
        put(M2, "inbox", "m2a", false, false, "a@example.com");
        put(M2, "inbox", "m2b", false, true, "news@example.com");
        put(M2, "inbox", "m2c", false, true, "news@example.com");
        c.execute("INSERT INTO thread_meta(thread_id,snoozed_until) VALUES('s',?1)", [now() + 3600]).unwrap();
        c.execute("INSERT INTO thread_meta(thread_id,snoozed_until) VALUES('p',?1)", [now() - 60]).unwrap();
        c.execute("INSERT INTO blocked(email) VALUES('blocked@example.com')", []).unwrap();
        c
    }

    fn inbox(c: &Connection, acct: &str) -> FolderInfo {
        folder_infos(c).unwrap().into_iter().find(|f| f.account_id == acct && f.key == "inbox").unwrap()
    }

    /// Conversations a tab lists with the unread filter on, by the real list query.
    fn listed(c: &Connection, acct: &str, focus: &str) -> usize {
        let f: ThreadFilter = serde_json::from_value(serde_json::json!({ "accountId": acct, "folder": "inbox", "focus": focus, "unreadOnly": true })).unwrap();
        threads_for(c, f).unwrap().into_iter().map(|t| t.thread_id).collect::<std::collections::HashSet<_>>().len()
    }

    #[test]
    fn inbox_tab_counts_match_the_tab_lists() {
        let c = fixture();
        let m1 = inbox(&c, M1);
        // F1, X and P (its snooze is over) are in Focused; B1 and X in Other; the snoozed S, the blocked sender and the archived mail in neither
        assert_eq!((m1.unread_focused, m1.unread_other), (3, 2));
        assert_eq!((m1.unread_focused as usize, m1.unread_other as usize), (listed(&c, M1, "focused"), listed(&c, M1, "other")));
        let m2 = inbox(&c, M2);
        assert_eq!((m2.unread_focused, m2.unread_other), (1, 2));
        assert_eq!((m2.unread_focused as usize, m2.unread_other as usize), (listed(&c, M2, "focused"), listed(&c, M2, "other")));
        // the side-menu number leaves out the snoozed and the blocked too (F1, X, P, B1), and counts a conversation of both kinds once
        assert_eq!(m1.unread, 4);
        assert_eq!(m2.unread, 3);
        // only the Inbox rows carry tab numbers
        let all = folder_infos(&c).unwrap();
        assert!(all.iter().filter(|f| f.key != "inbox").all(|f| f.unread_focused == 0 && f.unread_other == 0));
        let archive = all.iter().find(|f| f.account_id == M1 && f.key == "archive").unwrap();
        assert_eq!((archive.unread, archive.total), (1, 1), "other folders still count their own unread");
        // the JSON the page reads
        let v = serde_json::to_value(&m1).unwrap();
        assert_eq!((v["unreadFocused"].as_u64(), v["unreadOther"].as_u64()), (Some(3), Some(2)));
    }

    /// D-051: where the notification of a conversation has to open it. F1 normal, B1 bulk, X both kinds, S snoozed, ARCH archived, a second mailbox's bulk M2B.
    #[test]
    fn a_notification_finds_the_list_that_has_the_conversation() {
        let c = fixture();
        let home = |t: &str| thread_home(&c, t);
        let h = |a: &str, f: &str, focused: bool, other: bool| Some(ThreadHome { account_id: a.into(), folder: f.into(), focused, other });
        assert_eq!(home("f1"), h(M1, "inbox", true, false), "a normal message: the Focused tab");
        assert_eq!(home("b1"), h(M1, "inbox", false, true), "a bulk message: the Other tab only");
        assert_eq!(home("x"), h(M1, "inbox", true, true), "a conversation of both kinds is in both tabs");
        assert_eq!(home("m2b"), h(M2, "inbox", false, true), "another mailbox: its own account and the Other tab");
        assert_eq!(home("m2a"), h(M2, "inbox", true, false));
        assert_eq!(home("s"), h(M1, "snoozed", false, false), "a snoozed conversation is in the Snoozed list, not the Inbox");
        assert_eq!(home("p"), h(M1, "inbox", true, false), "its snooze is over: back in the Inbox");
        assert_eq!(home("arch"), h(M1, "archive", false, false), "another folder: that folder");
        assert_eq!(home("gone"), None, "a conversation that is not on this computer");
        // the answer is what the page reads
        let v = serde_json::to_value(home("b1").unwrap()).unwrap();
        assert_eq!((v["accountId"].as_str(), v["folder"].as_str(), v["focused"].as_bool(), v["other"].as_bool()), (Some(M1), Some("inbox"), Some(false), Some(true)));
        // and the tab it names is the list that really holds it
        let in_tab = |focus: &str, acct: &str, t: &str| {
            let f: ThreadFilter = serde_json::from_value(serde_json::json!({ "accountId": acct, "folder": "inbox", "focus": focus })).unwrap();
            threads_for(&c, f).unwrap().iter().any(|x| x.thread_id == t)
        };
        for (t, acct) in [("f1", M1), ("b1", M1), ("x", M1), ("m2b", M2), ("m2a", M2)] {
            let at = home(t).unwrap();
            assert_eq!((in_tab("focused", acct, t), in_tab("other", acct, t)), (at.focused, at.other), "{t}");
        }
    }

    #[test]
    fn inbox_tab_counts_ignore_count_other_mail() {
        let c = fixture();
        let tabs = |c: &Connection| {
            let f = inbox(c, M1);
            (f.unread, f.unread_focused, f.unread_other)
        };
        // not set at all: bulk mail counts (the default)
        assert_eq!(tabs(&c), (4, 3, 2));
        db::set_setting(&c, "prefs", r#"{"countOtherMail":true}"#).unwrap();
        assert_eq!(tabs(&c), (4, 3, 2));
        // off with Focused Inbox on: the side-menu number leaves out B1 (X still counts through its normal mail), the tabs do not change
        db::set_setting(&c, "prefs", r#"{"countOtherMail":false}"#).unwrap();
        assert_eq!(tabs(&c), (3, 3, 2));
        assert_eq!(inbox(&c, M2).unread, 1);
        // Focused Inbox off: bulk mail always counts
        db::set_setting(&c, "prefs", r#"{"focused":false,"countOtherMail":false}"#).unwrap();
        assert_eq!(tabs(&c), (4, 3, 2));
        // damaged text: the defaults
        db::set_setting(&c, "prefs", "{oops").unwrap();
        assert_eq!(tabs(&c), (4, 3, 2));
    }

    #[test]
    fn folder_infos_inbox_counts_bulk_by_default() {
        let c = fixture();
        assert_eq!(inbox(&c, M1).unread, 4, "no prefs stored");
        db::set_setting(&c, "prefs", r#"{"countOtherMail":false}"#).unwrap();
        assert_eq!(inbox(&c, M1).unread, 3);
        db::set_setting(&c, "prefs", r#"{"focused":false,"countOtherMail":false}"#).unwrap();
        assert_eq!(inbox(&c, M1).unread, 4);
    }

    #[test]
    fn inbox_tab_count_query_uses_the_folder_index() {
        let c = fixture();
        let sql = format!("EXPLAIN QUERY PLAN {}", inbox_unread_sql(&shard::messages_table(&c, M1).unwrap()));
        let mut st = c.prepare(&sql).unwrap();
        let plan: Vec<String> = st
            .query_map(params![1, M1, now(), "[]"], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(plan.iter().any(|d| d.contains("idx_msg_folder")), "plan: {plan:?}");
    }

    /// Fix batch 6 (Q3): a conversation that waits out its Undo time is gone from the lists, so it is gone from the side-menu number and the tab numbers too
    /// (they used to count it until the move was done). The hidden set is explicit here: the real one is process-wide and other tests queue moves.
    #[test]
    fn hidden_conversations_are_left_out_of_the_unread_numbers() {
        let c = fixture();
        let hide = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<std::collections::HashSet<_>>();
        let inbox_of = |c: &Connection, hidden: &[&str], acct: &str| {
            folder_infos_hiding(c, &hide(hidden)).unwrap().into_iter().find(|f| f.account_id == acct && f.key == "inbox").unwrap()
        };
        let none = inbox_of(&c, &[], M1);
        assert_eq!((none.unread, none.unread_focused, none.unread_other), (4, 3, 2));
        // a normal conversation: Focused and the side-menu number go down by one, Other does not move
        let f1 = inbox_of(&c, &["f1"], M1);
        assert_eq!((f1.unread, f1.unread_focused, f1.unread_other), (3, 2, 2));
        // a bulk one: Other and the side-menu number
        let b1 = inbox_of(&c, &["b1"], M1);
        assert_eq!((b1.unread, b1.unread_focused, b1.unread_other), (3, 3, 1));
        // a conversation with unread mail of both kinds leaves both tabs
        let x = inbox_of(&c, &["x"], M1);
        assert_eq!((x.unread, x.unread_focused, x.unread_other), (3, 2, 1));
        // the other mailbox and a read conversation are not touched
        assert_eq!(inbox_of(&c, &["f1", "f2"], M2).unread, 3);
        assert_eq!(inbox_of(&c, &["f2"], M1).unread, 4);
        // the hidden set is the one the lists use: the numbers still equal the tab lists of the real query once the same threads are left out
        let listed_without = |focus: &str, hidden: &[&str]| {
            let f: ThreadFilter = serde_json::from_value(serde_json::json!({ "accountId": M1, "folder": "inbox", "focus": focus, "unreadOnly": true })).unwrap();
            threads_for(&c, f).unwrap().into_iter().filter(|t| !hidden.contains(&t.thread_id.as_str())).map(|t| t.thread_id).collect::<std::collections::HashSet<_>>().len()
        };
        let both = inbox_of(&c, &["f1", "b1"], M1);
        assert_eq!((both.unread_focused as usize, both.unread_other as usize), (listed_without("focused", &["f1", "b1"]), listed_without("other", &["f1", "b1"])));
        // other folders count their own unread the same way
        let arch = |hidden: &[&str]| folder_infos_hiding(&c, &hide(hidden)).unwrap().into_iter().find(|f| f.account_id == M1 && f.key == "archive").unwrap();
        assert_eq!(arch(&[]).unread, 1);
        assert_eq!(arch(&["arch"]).unread, 0);
        assert_eq!(arch(&["arch"]).total, 1, "the total is not a number of unread mail");
    }

    /// `folder_infos` itself reads the process-wide set: a queued move hides its thread from the numbers until it is cancelled (Undo).
    #[test]
    fn a_queued_move_leaves_the_numbers_and_undo_puts_it_back() {
        let c = fixture();
        // a thread of its own: the queue is process-wide, so no other test's fixture may contain the id
        c.execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,seen,list_unsub)
             VALUES('fix6-undo',?1,'inbox',900,'fix6-undo-thread','s','n','a@example.com','','',900,'',0,NULL)",
            [M2],
        )
        .unwrap();
        let n = |c: &Connection| inbox(c, M2).unread_focused;
        assert_eq!(n(&c), 2);
        let token = queue(vec!["fix6-undo-thread".to_string()], None, "archive".into(), None, Some("inbox".into()), 600, None);
        assert_eq!(n(&c), 1, "gone from the numbers with the row");
        assert!(cancel_action(token), "Undo");
        assert_eq!(n(&c), 2, "back");
    }

    /// The readers of the setting use the same fallback (on), so a missing key means the same everywhere.
    #[test]
    fn the_count_other_fallback_is_on_in_every_reader() {
        let lib = include_str!("lib.rs");
        let shell = include_str!("shell.rs");
        assert!(lib.contains("get(\"countOtherMail\").and_then(|v| v.as_bool()).unwrap_or(true)"), "folder_infos");
        assert!(shell.contains("pbool(&p, \"countOtherMail\", true)"), "unread_count");
    }
}
