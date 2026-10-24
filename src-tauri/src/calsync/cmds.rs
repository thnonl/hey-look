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
            Kind::CalDav => super::caldav::provider(&self.db, src),
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
        "CAL_DENIED: Calendar access wasn’t allowed. You can try again when you’re ready.".into()
    } else if l.contains("timed out") {
        "CAL_TIMEOUT: Calendar sign-in timed out. You can try again when you’re ready.".into()
    } else if l.contains("cancelled") {
        "CAL_CANCELLED: Calendar sign-in was cancelled.".into()
    } else {
        format!("CAL_ERROR: Couldn’t turn on calendar sync: {raw}")
    }
}

/// An address as Google compares it: a Gmail address (gmail.com or googlemail.com) is lower case, has no dots in its name and nothing after
/// a `+`, and its domain is gmail.com, so `J.Doe+news@googlemail.com` and `jdoe@gmail.com` are one mailbox. Any other address is only
/// compared without regard to case.
fn google_address_key(addr: &str) -> String {
    let a = addr.trim().to_ascii_lowercase();
    match a.rsplit_once('@') {
        Some((name, domain)) if domain == "gmail.com" || domain == "googlemail.com" => {
            let name = name.split('+').next().unwrap_or(name).replace('.', "");
            format!("{name}@gmail.com")
        }
        _ => a,
    }
}

/// Is the address Google signed in the mailbox the app has? Gmail spellings count as one (W7.8: an app-password mailbox typed `j.doe@googlemail.com`
/// gets `jdoe@gmail.com` back); for Microsoft and every other domain the addresses must be equal apart from case.
fn same_account(provider: Provider, mailbox: &str, signed_email: &str) -> bool {
    match provider {
        Provider::Google => google_address_key(mailbox) == google_address_key(signed_email),
        Provider::Microsoft => signed_email.trim().eq_ignore_ascii_case(mailbox.trim()),
    }
}

/// Check what the consent returned against the mailbox. Nothing is stored unless this passes.
pub fn check_grant(provider: Provider, mailbox: &str, signed_email: &str, granted: &str) -> R<()> {
    if !same_account(provider, mailbox, signed_email) {
        return Err(format!("CAL_WRONG_ACCOUNT: You allowed access for {signed_email}. Sign in as {mailbox} to sync this mailbox’s calendar."));
    }
    if !granted_all(provider, granted) {
        return Err("CAL_PARTIAL: Hey Look! needs every calendar permission it asked for. Try again and keep all boxes ticked.".into());
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
        return Err(not_set_up_text(provider));
    }
    // the consent: the browser (a debug build with HEYLOOK_TEST_CAL_CONSENT set skips it, see `test_consent`)
    let seam = test_consent(provider);
    let signed = match seam {
        Some(s) => {
            crate::startup::line("calsync", &format!("{}: calendar consent from the test seam (no browser), signed in as {}", acc.id, s.email));
            s
        }
        None => {
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
            signed.map_err(|e| connect_error(&e, &acc.email))?
        }
    };
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

/// What the CalDAV dialog sends (REQ-7.4.2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DavConnect {
    pub account_id: String,
    /// "icloud" | "fastmail" | "nextcloud" | "other"
    pub service: String,
    /// the server address (ignored for iCloud and Fastmail, which have a fixed one)
    #[serde(default)]
    pub url: String,
    pub username: String,
    /// the app password typed in the dialog (not used when `use_mail_password`)
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub use_mail_password: bool,
    /// trust the server's certificate (Nextcloud and Other only)
    #[serde(default)]
    pub trust_cert: bool,
}

const NOT_AVAILABLE: &str = "CAL_NOT_SET_UP: This mailbox has no calendar that Hey Look! can sync.";

/// Find the calendars of a server with these credentials (blocking: run it off the main thread). Nothing is stored here.
fn find_on_server(args: &DavConnect, password: &str) -> Result<(super::caldav::DavSource, super::caldav::Discovered), super::caldav::DavErr> {
    use super::caldav::{discover, parse_url, DavErr, DavHttp, DavSource, Preset};
    let preset = Preset::from_str(&args.service);
    let entered = preset.fixed_url().map(String::from).unwrap_or_else(|| args.url.trim().to_string());
    let base = parse_url(&entered).ok_or(DavErr::NoServer)?;
    let trust = args.trust_cert && matches!(preset, Preset::Nextcloud | Preset::Other);
    let http = DavHttp::new(&base, args.username.trim(), password, preset, trust);
    let found = discover(&http, &entered, preset)?;
    let dav = DavSource { url: entered, username: args.username.trim().to_string(), preset, homes: found.homes.clone(), addresses: found.addresses.clone(), scheduling: found.scheduling, trust_cert: trust };
    Ok((dav, found))
}

/// Turn calendar sync on for a mailbox with a CalDAV server (W7.4): discovery first; nothing is stored unless it finds at least one calendar. The password goes to the credential
/// store as `<account id>:calendar` (the mailbox's own password is copied there when the person asked, so the two can differ later).
#[tauri::command]
pub async fn calendar_connect_caldav(app: tauri::AppHandle, state: tauri::State<'_, AppState>, args: DavConnect) -> R<SourceInfo> {
    let db = state.db.clone();
    let acc = {
        let c = lock(&db);
        let acc = db::get_account(&c, &args.account_id)?;
        if !Kind::CalDav.enabled() || Kind::for_account(&acc).is_some() || store::source_of_account(&c, &acc.id).is_some() {
            return Err(NOT_AVAILABLE.into());
        }
        acc
    };
    let password = if args.use_mail_password && Provider::from_auth(&acc.auth).is_none() { crate::password(&acc.id)? } else { args.password.clone() };
    if password.is_empty() || args.username.trim().is_empty() {
        return Err(super::caldav::DavErr::Auth.connect_text());
    }
    let a2 = DavConnect { account_id: args.account_id.clone(), service: args.service.clone(), url: args.url.clone(), username: args.username.clone(), password: String::new(), use_mail_password: false, trust_cert: args.trust_cert };
    let pw = password.clone();
    let (dav, found) = blocking(move || find_on_server(&a2, &pw).map_err(|e| e.connect_text())).await?;
    crate::startup::line("calsync", &format!("{}: caldav connected to {} ({} calendars{})", acc.id, dav.host(), found.calendars.len(), if found.scheduling { ", the server sends invitations" } else { "" }));
    let key = oauth::calendar_key(&acc.id);
    crate::identity::entry(&key).and_then(|e| e.set_password(&password)).map_err(|e| format!("CAL_ERROR: Couldn’t save the calendar sign-in: {e}"))?;
    let info = {
        let c = lock(&db);
        let src = store::create_dav_source(&c, &acc.id, chrono::Utc::now().timestamp(), &dav)?;
        store::sources_info(&c)?.into_iter().find(|s| s.id == src.id).ok_or("calendar source missing")?
    };
    super::request_sync(&acc.id);
    changed(&app);
    Ok(info)
}

/// The password of a CalDAV source was refused: check the new one against the server, keep it, and sync again. The local copy of the calendars stays.
#[tauri::command]
pub async fn calendar_dav_password(app: tauri::AppHandle, state: tauri::State<'_, AppState>, account_id: String, password: String) -> R<SourceInfo> {
    let db = state.db.clone();
    let src = {
        let c = lock(&db);
        store::source_of_account(&c, &account_id).filter(|s| s.kind == Kind::CalDav && s.dav.is_some()).ok_or(NOT_AVAILABLE)?
    };
    let dav = src.dav.clone().ok_or(NOT_AVAILABLE)?;
    if password.is_empty() {
        return Err(super::caldav::DavErr::Auth.connect_text());
    }
    let args = DavConnect { account_id: account_id.clone(), service: dav.preset.as_str().into(), url: dav.url.clone(), username: dav.username.clone(), password: String::new(), use_mail_password: false, trust_cert: dav.trust_cert };
    let pw = password.clone();
    blocking(move || find_on_server(&args, &pw).map(|_| ()).map_err(|e| e.connect_text())).await?;
    let key = oauth::calendar_key(&account_id);
    crate::identity::entry(&key).and_then(|e| e.set_password(&password)).map_err(|e| format!("CAL_ERROR: Couldn’t save the calendar sign-in: {e}"))?;
    let info = {
        let c = lock(&db);
        store::set_status(&c, &src.id, super::SYNCING, None, None, 0)?;
        store::sources_info(&c)?.into_iter().find(|s| s.id == src.id).ok_or("calendar source missing")?
    };
    super::request_sync(&account_id);
    changed(&app);
    Ok(info)
}

/// What the person is told when this build has no OAuth client for the service (W7.8). The switch is disabled in that case, so this is
/// only seen when something calls the command anyway.
fn not_set_up_text(provider: Provider) -> String {
    format!("CAL_NOT_SET_UP: This build of Hey Look! can’t sync calendars with {}.", provider.label())
}

/// The kinds a build can connect: Google and Microsoft when an OAuth client is configured for them (the environment, the build or Settings),
/// the others (CalDAV, 7d) need none. `has_client` is asked per provider.
pub fn kinds_available(has_client: impl Fn(Provider) -> bool) -> Vec<String> {
    [Kind::Google, Kind::Microsoft, Kind::CalDav].into_iter().filter(|k| k.enabled()).filter(|k| k.oauth().map(&has_client).unwrap_or(true)).map(|k| k.as_str().to_string()).collect()
}

/// The services this build can connect (`google`, `microsoft`, ...). The Calendar section of a mailbox whose kind is not in the list shows
/// its switch off and says so, instead of ending in an error after a click.
#[tauri::command]
pub fn calendar_kinds_available(state: tauri::State<AppState>) -> Vec<String> {
    kinds_available(|p| !crate::oauth_creds(&state.db, p).0.trim().is_empty())
}

/// Debug builds only (a release build does not compile this in and never reads the variable): `HEYLOOK_TEST_CAL_CONSENT=<email>` makes the
/// calendar consent finish at once, as if the person had signed in as `<email>` and allowed every calendar permission; `partial:<email>` as if
/// a box had been unticked. The address check, the permission check, the credential store and the first sync run as in production, so the QA
/// kit's fake servers can be used without a browser or an account. The refresh token is `hl-test-refresh`.
#[cfg(debug_assertions)]
fn test_consent(provider: Provider) -> Option<oauth::Signed> {
    consent_from_seam(provider, &std::env::var("HEYLOOK_TEST_CAL_CONSENT").ok()?)
}

#[cfg(not(debug_assertions))]
fn test_consent(_provider: Provider) -> Option<oauth::Signed> {
    None
}

#[cfg(debug_assertions)]
fn consent_from_seam(provider: Provider, value: &str) -> Option<oauth::Signed> {
    let value = value.trim();
    let (partial, email) = match value.strip_prefix("partial:") {
        Some(rest) => (true, rest.trim()),
        None => (false, value),
    };
    if email.is_empty() {
        return None;
    }
    Some(oauth::Signed {
        email: email.to_string(),
        name: String::new(),
        refresh_token: "hl-test-refresh".into(),
        access_token: "hl-test-access".into(),
        scope: if partial { "openid email".into() } else { provider.scope_for(Purpose::Calendar).to_string() },
        expires_in: 3600,
    })
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

/// Move an event (a whole series as one) to another calendar (REQ-7.5.1).
#[tauri::command]
pub async fn calendar_move_event(app: tauri::AppHandle, state: tauri::State<'_, AppState>, event_id: String, target_calendar_id: String) -> R<crate::calendar::CalEvent> {
    let db = state.db.clone();
    let out = blocking(move || super::write::move_event(&db, &AppFactory { db: db.clone() }, &event_id, &target_calendar_id)).await;
    changed(&app);
    out
}

/// Make a new calendar in the service of a mailbox (REQ-7.5.3), with an optional colour of Hey Look!'s own; the calendar is listed and its (empty) events pulled at once.
#[tauri::command]
pub async fn calendar_create_calendar(app: tauri::AppHandle, state: tauri::State<'_, AppState>, account_id: String, name: String, color: Option<String>) -> R<SourceInfo> {
    let db = state.db.clone();
    let out = blocking(move || {
        let name = name.trim().chars().take(100).collect::<String>();
        if name.is_empty() {
            return Err("CAL_GONE: This calendar is no longer synced.".to_string());
        }
        let (src, email) = {
            let c = lock(&db);
            let src = store::source_of_account(&c, &account_id).ok_or("CAL_GONE: This calendar is no longer synced.")?;
            (src, db::get_account(&c, &account_id).map(|a| a.email).unwrap_or_default())
        };
        let factory = AppFactory { db: db.clone() };
        let provider = factory.provider(&src).map_err(|e| super::write::error_text(&e, &src.service_name(), &name, &email))?;
        let rc = provider.create_calendar(&name).map_err(|e| super::write::create_error_text(&e, &src.service_name(), &name, &email))?;
        let cal_id = super::calendar_id(&src.account_id, src.kind, &rc.id);
        {
            let c = lock(&db);
            store::apply_calendar_delta(&c, &src, &[rc], &[])?;
            if color.is_some() {
                store::set_color_override(&c, &cal_id, color.as_deref())?;
            }
        }
        let _ = engine::refresh_calendar(&db, &factory, &cal_id, Clock::real());
        super::request_sync(&src.account_id);
        let c = lock(&db);
        store::sources_info(&c)?.into_iter().find(|s| s.id == src.id).ok_or_else(|| "calendar source missing".to_string())
    })
    .await;
    changed(&app);
    out
}

/// The colour of a synced calendar in Hey Look! (REQ-7.5.2): `#rrggbb`, or none for the service's own. Never sent to the service.
#[tauri::command]
pub fn calendar_set_color(app: tauri::AppHandle, state: tauri::State<AppState>, calendar_id: String, color: Option<String>) -> R<()> {
    store::set_color_override(&lock(&state.db), &calendar_id, color.as_deref())?;
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
        let _ = store::retry_not_set_up(&lock(&db));
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
    fn gmail_addresses_are_compared_like_google_does() {
        let g = |mailbox: &str, signed: &str| check_grant(Provider::Google, mailbox, signed, GOOGLE_ALL).is_ok();
        // dots, plus tags, googlemail.com and case are one Gmail mailbox
        assert!(g("j.doe@googlemail.com", "jdoe@gmail.com"));
        assert!(g("jdoe@gmail.com", "J.Doe@GMail.com"));
        assert!(g("jdoe+news@gmail.com", "jdoe@gmail.com"));
        assert!(g("J.D.o.e+a+b@googlemail.com", "jdoe@googlemail.com"));
        assert!(g("jdoe@gmail.com", "jdoe+x@googlemail.com"));
        // different people stay different
        assert!(!g("jdoe@gmail.com", "other@gmail.com"));
        assert!(!g("jdoe@gmail.com", "jdoe2@gmail.com"));
        assert!(!g("j.doe@gmail.com", "j_doe@gmail.com"));
        // other domains: the case only (a dot or a plus tag is part of the name there)
        assert!(g("Jane.Doe@Example.com", "jane.doe@example.com"));
        assert!(!g("jane.doe@example.com", "janedoe@example.com"));
        assert!(!g("jane+x@example.com", "jane@example.com"));
        // a Google Workspace address on a gmail-looking name is not a Gmail address
        assert!(!g("jdoe@gmail.example.com", "jdoe@example.com"));
        assert!(!g("jdoe@gmail.com", "jdoe@gmail.co"));
        // the wrong-account text names both addresses as they were written
        let e = check_grant(Provider::Google, "j.doe@googlemail.com", "other@gmail.com", GOOGLE_ALL).unwrap_err();
        assert_eq!(e, "CAL_WRONG_ACCOUNT: You allowed access for other@gmail.com. Sign in as j.doe@googlemail.com to sync this mailbox’s calendar.");
        // Microsoft is compared as before: the case only
        assert!(check_grant(Provider::Microsoft, "Me@Outlook.com", "me@outlook.com", "Calendars.ReadWrite").is_ok());
        assert!(check_grant(Provider::Microsoft, "m.e@outlook.com", "me@outlook.com", "Calendars.ReadWrite").is_err());
    }

    #[test]
    fn an_app_password_gmail_mailbox_uses_the_oauth_calendar_flow_with_its_address_as_hint() {
        let acc = crate::db::Account {
            id: "a".into(),
            email: "j.doe@googlemail.com".into(),
            display_name: "J".into(),
            imap_host: "imap.gmail.com".into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "smtp.gmail.com".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            username: "j.doe@googlemail.com".into(),
            auth: "password".into(),
            color: None,
            smtp_username: String::new(),
            tls_insecure: false,
            reply_to: String::new(),
        };
        // the mailbox is a Google one by its server, and the kind is available when the build has a Google client
        let kind = Kind::for_account(&acc).filter(|k| k.enabled()).expect("Gmail by app password has a calendar");
        assert_eq!(kind, Kind::Google);
        assert_eq!(kind.oauth(), Some(Provider::Google));
        // the consent is the calendar one: the calendar scopes only, the mailbox address as login_hint, a separate token key; no mail scope and no password
        let p = oauth::begin_for(Provider::Google, Purpose::Calendar, "", "client-id", Some(&acc.email)).unwrap();
        assert!(p.url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"), "{}", p.url);
        assert!(p.url.contains("login_hint=j.doe%40googlemail.com"), "{}", p.url);
        assert!(!p.url.contains("mail.google.com") && !p.url.to_ascii_lowercase().contains("password"), "{}", p.url);
        assert_eq!(oauth::calendar_key(&acc.id), "a:calendar");
        assert_ne!(oauth::calendar_key(&acc.id), acc.id, "the mail credential is another entry");
    }

    #[test]
    fn a_missing_client_is_said_in_one_sentence_and_kinds_follow_the_clients() {
        assert_eq!(not_set_up_text(Provider::Google), "CAL_NOT_SET_UP: This build of Hey Look! can’t sync calendars with Google.");
        assert_eq!(not_set_up_text(Provider::Microsoft), "CAL_NOT_SET_UP: This build of Hey Look! can’t sync calendars with Microsoft.");
        assert_eq!(kinds_available(|_| true), vec!["google", "microsoft", "caldav"]);
        assert_eq!(kinds_available(|p| p == Provider::Microsoft), vec!["microsoft", "caldav"]);
        assert_eq!(kinds_available(|_| false), vec!["caldav"], "CalDAV needs no OAuth client");
    }

    #[test]
    fn the_test_consent_seam_signs_in_as_the_given_address_and_can_grant_part() {
        let ok = consent_from_seam(Provider::Google, " jdoe@gmail.com ").unwrap();
        assert_eq!((ok.email.as_str(), ok.refresh_token.as_str()), ("jdoe@gmail.com", "hl-test-refresh"));
        assert!(check_grant(Provider::Google, "j.doe@googlemail.com", &ok.email, &ok.scope).is_ok(), "the full grant passes the production checks");
        assert!(granted_all(Provider::Microsoft, &consent_from_seam(Provider::Microsoft, "me@outlook.com").unwrap().scope));
        let part = consent_from_seam(Provider::Google, "partial:jdoe@gmail.com").unwrap();
        assert!(check_grant(Provider::Google, "jdoe@gmail.com", &part.email, &part.scope).unwrap_err().starts_with("CAL_PARTIAL:"));
        assert!(consent_from_seam(Provider::Google, "").is_none() && consent_from_seam(Provider::Google, "partial:").is_none());
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
