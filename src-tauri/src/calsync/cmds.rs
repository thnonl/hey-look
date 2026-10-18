//! Tauri commands of calendar sync, the consent flow and the worker thread.
use super::engine::{self, Clock};
use super::store::{self, SourceInfo};
use super::{CalProvider, Kind, ProviderFactory, SyncErr};
use crate::db::{self, R};
use crate::oauth::{self, Provider, Purpose};
use crate::{blocking, lock, AppState, Db};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// Builds the provider of a source from the app's OAuth client and the calendar grant in the credential store.
pub struct AppFactory {
    pub db: Db,
}

impl ProviderFactory for AppFactory {
    fn provider(&self, src: &store::Source) -> Result<Box<dyn CalProvider>, SyncErr> {
        match src.kind {
            Kind::Google => super::google::provider(&self.db, src),
            Kind::Microsoft => super::microsoft::provider(&self.db, src),
            Kind::CalDav => Err(SyncErr::NotSetUp(format!("{} sync is not part of this version", src.kind.service()))),
        }
    }
}

/// The access token of a source's calendar grant, as the providers ask for it before every request.
pub fn calendar_token(db: &Db, kind: Kind, account_id: &str) -> Result<String, SyncErr> {
    let provider = kind.oauth().ok_or_else(|| SyncErr::NotSetUp("no sign-in for this service".into()))?;
    let (id, secret) = crate::oauth_creds(db, provider);
    if id.trim().is_empty() {
        return Err(SyncErr::NotSetUp(format!("no {} OAuth client configured", provider.label())));
    }
    let tenant = crate::oauth_tenant(db, provider);
    oauth::access_token_for(provider, Purpose::Calendar, &tenant, &oauth::calendar_key(account_id), &id, &secret).map_err(SyncErr::from)
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("calendar-changed", serde_json::json!({}));
}

#[tauri::command]
pub fn calendar_sources(state: tauri::State<AppState>) -> R<Vec<SourceInfo>> {
    store::sources_info(&lock(&state.db))
}

static CONNECTING: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn connecting() -> std::sync::MutexGuard<'static, Option<Arc<AtomicBool>>> {
    CONNECTING.lock().unwrap_or_else(|p| p.into_inner())
}

/// The calendar scopes that must all be granted (the consent page lets the user untick some). Compared by their last path segment, because
/// Microsoft answers `Calendars.ReadWrite` where Google answers the full URL.
fn required_scopes(provider: Provider) -> Vec<String> {
    provider
        .scope_for(Purpose::Calendar)
        .split_whitespace()
        .filter(|s| !matches!(*s, "openid" | "email" | "profile" | "offline_access"))
        .map(|s| s.rsplit('/').next().unwrap_or(s).to_ascii_lowercase())
        .collect()
}

pub fn granted_all(provider: Provider, granted: &str) -> bool {
    let have: Vec<String> = granted.split_whitespace().map(|s| s.rsplit('/').next().unwrap_or(s).to_ascii_lowercase()).collect();
    required_scopes(provider).iter().all(|r| have.contains(r))
}

/// What the person is told when the consent did not end in access.
pub fn connect_error(raw: &str, email: &str) -> String {
    let l = raw.to_ascii_lowercase();
    if ["admin_policy_enforced", "org_internal", "aadsts65001", "aadsts90094", "consent_required"].iter().any(|k| l.contains(k)) {
        format!("CAL_BLOCKED: {email}’s organization may need to approve Hey Look! for calendar access. Ask your IT admin.")
    } else if l.contains("access_denied") {
        "CAL_DENIED: Calendar access wasn’t allowed. Turn the switch on to try again.".into()
    } else if l.contains("timed out") {
        "CAL_TIMEOUT: Calendar sign-in timed out. Turn the switch on to try again.".into()
    } else if l.contains("cancelled") {
        "CAL_CANCELLED: Calendar sign-in was cancelled.".into()
    } else {
        format!("CAL_ERROR: Couldn’t turn on calendar sync: {raw}")
    }
}

/// Check what the consent returned against the mailbox. Nothing is stored unless this passes.
pub fn check_grant(provider: Provider, mailbox: &str, signed_email: &str, granted: &str) -> R<()> {
    if !signed_email.eq_ignore_ascii_case(mailbox) {
        return Err(format!("CAL_WRONG_ACCOUNT: You allowed access for {signed_email}. Sign in as {mailbox} to sync this mailbox’s calendar."));
    }
    if !granted_all(provider, granted) {
        return Err("CAL_PARTIAL: Hey Look! needs every calendar permission it asked for. Turn the switch on again and keep all boxes ticked.".into());
    }
    Ok(())
}

/// Turn calendar sync on for a mailbox: a separate consent in the browser with only the calendar scopes. The mail sign-in and its token
/// are not touched. On success the calendar token is kept in the credential store and the first sync starts.
#[tauri::command]
pub async fn calendar_connect(app: tauri::AppHandle, state: tauri::State<'_, AppState>, account_id: String) -> R<SourceInfo> {
    let db = state.db.clone();
    let (acc, kind) = {
        let c = lock(&db);
        let acc = db::get_account(&c, &account_id)?;
        let kind = Kind::for_account(&acc).filter(|k| k.enabled()).ok_or("CAL_NOT_SET_UP: This mailbox has no calendar that Hey Look! can sync.")?;
        (acc, kind)
    };
    let provider = kind.oauth().ok_or("CAL_NOT_SET_UP: This mailbox has no calendar that Hey Look! can sync.")?;
    let (client_id, client_secret) = crate::oauth_creds(&db, provider);
    if client_id.trim().is_empty() {
        return Err(format!("CAL_NOT_SET_UP: No {} OAuth client configured: set {}_CLIENT_ID, or enter it in Settings > Accounts", provider.label(), provider.label().to_uppercase()));
    }
    let tenant = crate::oauth_tenant(&db, provider);
    let pending = oauth::begin_for(provider, Purpose::Calendar, &tenant, client_id.trim(), Some(&acc.email))?;
    *connecting() = Some(pending.canceller());
    if let Err(e) = crate::open_target(&app, &pending.url, true) {
        *connecting() = None;
        return Err(e);
    }
    let (cid, csec) = (client_id.trim().to_string(), client_secret.trim().to_string());
    let signed = blocking(move || pending.finish(&cid, &csec)).await;
    *connecting() = None;
    let signed = signed.map_err(|e| connect_error(&e, &acc.email))?;
    check_grant(provider, &acc.email, &signed.email, &signed.scope)?;
    let key = oauth::calendar_key(&acc.id);
    crate::identity::entry(&key)
        .and_then(|e| e.set_password(&signed.refresh_token))
        .map_err(|e| format!("CAL_ERROR: Couldn’t save the calendar sign-in: {e}"))?;
    oauth::cache_token(&key, &signed.access_token, signed.expires_in.saturating_sub(300).max(60));
    let info = {
        let c = lock(&db);
        let src = store::create_source(&c, &acc.id, kind, chrono::Utc::now().timestamp())?;
        store::sources_info(&c)?.into_iter().find(|s| s.id == src.id).ok_or("calendar source missing")?
    };
    super::request_sync(&acc.id);
    changed(&app);
    Ok(info)
}

/// The Cancel button of the consent: ends the wait for the browser.
#[tauri::command]
pub fn calendar_cancel_connect() {
    if let Some(flag) = connecting().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

fn forget_grant(account_id: &str) {
    let key = oauth::calendar_key(account_id);
    if let Ok(e) = crate::identity::entry(&key) {
        let _ = e.delete_credential();
    }
    oauth::forget_token(&key);
}

/// Stop syncing a mailbox's calendars: the local calendars, events and the token go; nothing changes on the server.
#[tauri::command]
pub fn calendar_disconnect(app: tauri::AppHandle, state: tauri::State<AppState>, account_id: String) -> R<()> {
    {
        let c = lock(&state.db);
        if let Some(s) = store::source_of_account(&c, &account_id) {
            store::disconnect(&c, &s.id)?;
        }
    }
    forget_grant(&account_id);
    changed(&app);
    Ok(())
}

/// The `Sync` switch of one calendar.
#[tauri::command]
pub fn calendar_set_sync(app: tauri::AppHandle, state: tauri::State<AppState>, calendar_id: String, on: bool) -> R<()> {
    let account = {
        let c = lock(&state.db);
        store::set_calendar_sync(&c, &calendar_id, on)?;
        store::get_calendar(&c, &calendar_id).and_then(|cal| store::get_source(&c, &cal.source_id)).map(|s| s.account_id)
    };
    if let (true, Some(a)) = (on, account) {
        super::request_sync(&a);
    }
    changed(&app);
    Ok(())
}

/// `Sync now` (one mailbox, or all when `account_id` is empty). With `only_if_stale` a source that synced in the last minute is left
/// alone (the Calendar view opening).
#[tauri::command]
pub fn calendar_sync_now(state: tauri::State<AppState>, account_id: Option<String>, only_if_stale: Option<bool>) -> R<()> {
    let now = chrono::Utc::now().timestamp();
    let sources = store::list_sources(&lock(&state.db))?;
    for s in sources {
        if account_id.as_deref().is_some_and(|a| a != s.account_id) {
            continue;
        }
        if only_if_stale.unwrap_or(false) && s.last_sync.is_some_and(|t| now - t < 60) {
            continue;
        }
        super::request_sync(&s.account_id);
    }
    Ok(())
}

/// Runs for the whole app lifetime next to the mail sync, so mail is never slowed by a calendar round. First round 10 seconds after
/// the start; then whatever is due or requested.
pub fn calsync_worker(app: tauri::AppHandle) {
    {
        let db = app.state::<AppState>().db.clone();
        let _ = store::reset_syncing(&lock(&db));
    }
    std::thread::sleep(std::time::Duration::from_secs(10));
    loop {
        let db = app.state::<AppState>().db.clone();
        let requested = super::take_requests();
        let factory = AppFactory { db: db.clone() };
        engine::tick(&db, &factory, Clock::real(), &requested, &|| changed(&app));
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOGLE_ALL: &str = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";

    #[test]
    fn a_partial_grant_is_refused() {
        assert!(granted_all(Provider::Google, GOOGLE_ALL));
        assert!(!granted_all(Provider::Google, "openid email https://www.googleapis.com/auth/calendar.events"));
        assert!(!granted_all(Provider::Google, "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly"));
        assert!(!granted_all(Provider::Google, ""));
        // the mail scope does not stand in for a calendar scope
        assert!(!granted_all(Provider::Google, "https://mail.google.com/ openid email"));
        assert!(granted_all(Provider::Microsoft, "Calendars.ReadWrite openid profile email"));
        assert!(!granted_all(Provider::Microsoft, "User.Read openid profile email"));
    }

    #[test]
    fn the_account_must_be_the_mailbox() {
        assert!(check_grant(Provider::Google, "Me@Gmail.com", "me@gmail.com", GOOGLE_ALL).is_ok());
        let e = check_grant(Provider::Google, "me@gmail.com", "other@gmail.com", GOOGLE_ALL).unwrap_err();
        assert_eq!(e, "CAL_WRONG_ACCOUNT: You allowed access for other@gmail.com. Sign in as me@gmail.com to sync this mailbox’s calendar.");
        let e = check_grant(Provider::Google, "me@gmail.com", "me@gmail.com", "openid email").unwrap_err();
        assert!(e.starts_with("CAL_PARTIAL: Hey Look! needs every calendar permission it asked for."));
    }

    #[test]
    fn consent_errors_are_sorted() {
        let e = |raw: &str| connect_error(raw, "me@x.y");
        assert!(e("Google sign-in refused: access_denied").starts_with("CAL_DENIED: Calendar access wasn’t allowed."));
        assert!(e("Google sign-in timed out").starts_with("CAL_TIMEOUT: Calendar sign-in timed out."));
        assert!(e("Google sign-in cancelled").starts_with("CAL_CANCELLED"));
        assert_eq!(e("Google sign-in refused: admin_policy_enforced"), "CAL_BLOCKED: me@x.y’s organization may need to approve Hey Look! for calendar access. Ask your IT admin.");
        assert!(e("Microsoft sign-in refused: access_denied AADSTS65001: The user or administrator has not consented").starts_with("CAL_BLOCKED"));
        assert!(e("token exchange failed: invalid_grant").starts_with("CAL_ERROR: Couldn’t turn on calendar sync: token exchange failed"));
    }

    #[test]
    fn the_consent_url_asks_only_for_the_calendar_scopes_and_names_the_mailbox() {
        let p = oauth::begin_for(Provider::Google, Purpose::Calendar, "", "client-id", Some("me@gmail.com")).unwrap();
        let q = |s: &str| urlencoding::encode(s).into_owned();
        assert!(p.url.contains(&format!("scope={}", q("https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly openid email"))), "{}", p.url);
        assert!(!p.url.contains("mail.google.com"));
        assert!(p.url.contains("login_hint=me%40gmail.com") && p.url.contains("access_type=offline") && p.url.contains("prompt=consent"));
        let m = oauth::begin_for(Provider::Microsoft, Purpose::Calendar, "common", "cid", Some("me@outlook.com")).unwrap();
        assert!(m.url.contains(&q("https://graph.microsoft.com/Calendars.ReadWrite offline_access openid email profile")), "{}", m.url);
        assert!(!m.url.contains("outlook.office.com") && m.url.contains("login_hint=me%40outlook.com"));
        // a known mailbox goes straight to that account (no account picker); without a hint, and for the mail sign-in, the picker stays
        assert!(!m.url.contains("prompt="), "{}", m.url);
        assert!(oauth::begin_for(Provider::Microsoft, Purpose::Calendar, "common", "cid", None).unwrap().url.contains("prompt=select_account"));
        assert!(oauth::begin(Provider::Microsoft, "common", "cid").unwrap().url.contains("prompt=select_account"));
        // organisations and personal accounts: the tenant of the app's setting is the authority, as for mail
        assert!(m.url.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
        let org = oauth::begin_for(Provider::Microsoft, Purpose::Calendar, "contoso.onmicrosoft.com", "cid", Some("me@contoso.com")).unwrap();
        assert!(org.url.starts_with("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize?"));
        // a mail sign-in is unchanged
        let mail = oauth::begin(Provider::Google, "", "client-id").unwrap();
        assert!(mail.url.contains(&q("https://mail.google.com/ openid email profile")) && !mail.url.contains("login_hint"));
    }
}
