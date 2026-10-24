//! OAuth 2.0 (installed-app flow with PKCE + loopback redirect) for IMAP/SMTP via XOAUTH2.
//! Providers: Google (Gmail) and Microsoft (Outlook.com, Microsoft 365). Apple offers no OAuth for iCloud Mail.
//! The user supplies their own OAuth client: Google Cloud Console "Desktop app", or a Microsoft Entra
//! "Mobile and desktop applications" registration (public client, no secret needed).
use crate::db::{err, R};
use crate::oauth_page::{self, Outcome};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// What a sign-in is for. Mail and calendar are two separate grants with their own refresh tokens: a desktop app cannot add scopes
/// to an existing grant (Google: no incremental authorisation for installed apps; Microsoft: a token request names one resource).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Purpose {
    Mail,
    Calendar,
}

/// Name of the credential-store entry (and of the access-token cache entry) of a calendar grant.
pub fn calendar_key(account_id: &str) -> String {
    format!("{account_id}:calendar")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    Google,
    Microsoft,
}

/// Making calendars in Google Calendar needs one more scope (`calendar.app.created`, W7.5, D-7.5c) that has to be added to the OAuth consent screen and to the verification first (owner step O-03). Until the owner confirms it
/// the scope is not asked for and the button is not offered; Outlook and CalDAV are not affected. Existing Google grants lack the scope either way: they are asked again (`CAL_NEEDS_ACCESS`).
pub const GOOGLE_CREATE_CALENDARS: bool = false;

impl Provider {
    /// Value stored in `Account.auth`.
    pub fn auth(self) -> &'static str {
        match self {
            Provider::Google => "oauth_google",
            Provider::Microsoft => "oauth_microsoft",
        }
    }

    pub fn from_auth(auth: &str) -> Option<Provider> {
        match auth {
            "oauth_google" => Some(Provider::Google),
            "oauth_microsoft" => Some(Provider::Microsoft),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::Google => "Google",
            Provider::Microsoft => "Microsoft",
        }
    }

    /// `tenant` only matters for Microsoft: "common", "organizations", "consumers", a tenant GUID or domain.
    fn auth_url(self, tenant: &str) -> String {
        match self {
            Provider::Google => "https://accounts.google.com/o/oauth2/v2/auth".into(),
            Provider::Microsoft => format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"),
        }
    }

    /// Debug builds and tests may point it at a fake server (`HEYLOOK_TOKEN_BASE`); a release build never does.
    fn token_url(self, tenant: &str) -> String {
        match self {
            Provider::Google => format!("{}/token", crate::calsync::http::base_url("HEYLOOK_TOKEN_BASE", "https://oauth2.googleapis.com")),
            Provider::Microsoft => {
                format!("{}/{tenant}/oauth2/v2.0/token", crate::calsync::http::base_url("HEYLOOK_TOKEN_BASE", "https://login.microsoftonline.com"))
            }
        }
    }

    /// The scopes of one grant. The calendar scopes are the narrowest that work: events (view and edit) and the list of calendars
    /// (read only); never the full `calendar` scope.
    pub fn scope_for(self, purpose: Purpose) -> &'static str {
        match (self, purpose) {
            (Provider::Google, Purpose::Mail) => "https://mail.google.com/ openid email profile",
            // One Outlook resource token covers both IMAP and SMTP AUTH.
            (Provider::Microsoft, Purpose::Mail) => {
                "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile"
            }
            (Provider::Google, Purpose::Calendar) if GOOGLE_CREATE_CALENDARS => {
                "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created openid email"
            }
            (Provider::Google, Purpose::Calendar) => {
                "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly openid email"
            }
            // the Graph resource; `Calendars.ReadWrite` needs no admin consent for the user's own calendars
            (Provider::Microsoft, Purpose::Calendar) => "https://graph.microsoft.com/Calendars.ReadWrite offline_access openid email profile",
        }
    }

    /// Microsoft matches the registered `http://localhost` (any port); Google takes the loopback IP.
    fn redirect(self, port: u16) -> String {
        match self {
            Provider::Google => format!("http://127.0.0.1:{port}"),
            Provider::Microsoft => format!("http://localhost:{port}"),
        }
    }

    /// `hinted`: the sign-in names the account (`login_hint`). A Microsoft calendar consent for a known mailbox goes straight to that
    /// account instead of asking which one (the consent page still lists the permissions; the address is checked afterwards).
    fn extra_auth_params(self, purpose: Purpose, hinted: bool) -> &'static str {
        match (self, purpose) {
            (Provider::Google, _) => "&access_type=offline&prompt=consent",
            (Provider::Microsoft, Purpose::Calendar) if hinted => "",
            (Provider::Microsoft, _) => "&prompt=select_account",
        }
    }
}

static CACHE: OnceLock<Mutex<HashMap<String, (String, i64)>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, (String, i64)>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Microsoft tenant segment of the endpoints. Restricted to what a tenant id/domain can contain so it can
/// never alter the URL path.
pub fn clean_tenant(raw: &str) -> R<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok("common".into());
    }
    if t.len() > 100 || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err(format!("invalid Microsoft tenant: {t}"));
    }
    Ok(t.to_string())
}

/// The mail sign-in that is waiting for the browser right now (at most one): what the Cancel button ends.
pub struct Waiting(Mutex<Option<Arc<AtomicBool>>>);

impl Waiting {
    pub const fn new() -> Self {
        Waiting(Mutex::new(None))
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<AtomicBool>>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A sign-in starts waiting. One that still waits is ended: its browser tab could no longer finish it, and its port is freed.
    pub fn begin(&self, flag: Arc<AtomicBool>) {
        if let Some(old) = self.slot().replace(flag) {
            old.store(true, Ordering::SeqCst);
        }
    }

    /// The sign-in of `flag` is over. A newer one that took the place meanwhile is left alone.
    pub fn end(&self, flag: &Arc<AtomicBool>) {
        let mut slot = self.slot();
        if slot.as_ref().is_some_and(|f| Arc::ptr_eq(f, flag)) {
            *slot = None;
        }
    }

    /// The Cancel button: the waiting sign-in ends within a fraction of a second and drops its listener.
    pub fn cancel(&self) {
        if let Some(flag) = self.slot().as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

pub struct Pending {
    provider: Provider,
    purpose: Purpose,
    cancel: Arc<AtomicBool>,
    tenant: String,
    listener: TcpListener,
    pub port: u16,
    verifier: String,
    state: String,
    pub url: String,
}

pub struct Signed {
    pub email: String,
    pub name: String,
    pub refresh_token: String,
    pub access_token: String,
    /// The scopes that were granted (the `scope` field of the token response); empty when the server did not say.
    pub scope: String,
    pub expires_in: i64,
}

/// Bind the loopback listener and build the consent URL of a mail sign-in (the app itself goes through `begin_for`, which also takes a hint).
#[cfg(test)]
pub fn begin(provider: Provider, tenant: &str, client_id: &str) -> R<Pending> {
    begin_for(provider, Purpose::Mail, tenant, client_id, None)
}

/// Same for any purpose. `login_hint` pre-fills the account on the consent page (the calendar grant is for the mailbox's own address).
pub fn begin_for(provider: Provider, purpose: Purpose, tenant: &str, client_id: &str, login_hint: Option<&str>) -> R<Pending> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let verifier = b64url(&rand::random::<[u8; 32]>());
    let state = b64url(&rand::random::<[u8; 16]>());
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let q = |s: &str| urlencoding::encode(s).into_owned();
    let hint = login_hint.map(str::trim).filter(|h| !h.is_empty());
    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}{}",
        provider.auth_url(tenant),
        q(client_id),
        q(&provider.redirect(port)),
        q(provider.scope_for(purpose)),
        challenge,
        state,
        provider.extra_auth_params(purpose, hint.is_some())
    );
    let url = match hint {
        Some(h) => format!("{url}&login_hint={}", q(h)),
        None => url,
    };
    Ok(Pending { provider, purpose, cancel: Arc::new(AtomicBool::new(false)), tenant: tenant.to_string(), listener, port, verifier, state, url })
}

fn query_param(line: &str, key: &str) -> Option<String> {
    let path = line.split_whitespace().nth(1)?;
    let q = path.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default())
    })
}

fn token_error(resp: &serde_json::Value) -> String {
    match (resp["error"].as_str(), resp["error_description"].as_str()) {
        (Some(e), Some(d)) => format!("{e}: {}", d.lines().next().unwrap_or(d)),
        (Some(e), None) => e.to_string(),
        _ => resp.to_string(),
    }
}

impl Pending {
    /// Setting it ends `finish` early ("cancelled"): the Cancel button of the mail sign-in and of the calendar consent.
    pub fn canceller(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// Wait for the browser redirect (max 5 min), then exchange the code for tokens.
    /// `client_secret` may be empty (Microsoft public clients have none).
    pub fn finish(self, client_id: &str, client_secret: &str) -> R<Signed> {
        self.finish_within(Duration::from_secs(300), client_id, client_secret)
    }

    /// `finish` with its own limit (the tests use a short one). Cancelling or timing out returns at once; the listener is dropped with
    /// `self`, so the port is free again.
    fn finish_within(self, wait: Duration, client_id: &str, client_secret: &str) -> R<Signed> {
        let label = self.provider.label();
        self.listener.set_nonblocking(true).map_err(err)?;
        let deadline = Instant::now() + wait;
        // the browser connection of the redirect stays open until the token exchange is done, so the page can show the address
        let (code, mut conn) = loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(crate::i18n::coded("OAUTH_CANCELLED", &[("label", label)], &format!("{label} sign-in cancelled")));
            }
            if Instant::now() > deadline {
                return Err(crate::i18n::coded("OAUTH_TIMEOUT", &[("label", label)], &format!("{label} sign-in timed out")));
            }
            match self.listener.accept() {
                Ok((mut s, _)) => {
                    let _ = s.set_nonblocking(false);
                    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut buf = [0u8; 4096];
                    let n = s.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let line = req.lines().next().unwrap_or("").to_string();
                    let reply = |s: &mut std::net::TcpStream, status: u16, o: &Outcome| {
                        let _ = s.write_all(&oauth_page::response(status, o));
                    };
                    if let Some(e) = query_param(&line, "error") {
                        let detail = query_param(&line, "error_description").unwrap_or_default();
                        let (title, next) = if e == "access_denied" && self.purpose == Purpose::Calendar {
                            ("Sign-in was cancelled", "Hey Look! needs your permission to show and change events in your calendars. Return to Hey Look! to try again when you are ready, or to continue without calendar sync.")
                        } else if e == "access_denied" {
                            ("Sign-in was cancelled", "Hey Look! needs your permission to read and send mail for this account. Return to Hey Look! and choose Sign in again when you are ready.")
                        } else {
                            ("Sign-in didn't finish", "Return to Hey Look!, check the sign-in settings (client ID, secret, redirect) and try again.")
                        };
                        let reason = format!("{label} reported: {e}{}{detail}", if detail.is_empty() { "" } else { " - " });
                        reply(&mut s, 200, &Outcome::Error { title, reason: &reason, next });
                        // (the code and the description go along: the UI tells "refused" from "the organization has to approve the app")
                        let why = format!("{e}{}{detail}", if detail.is_empty() { "" } else { " - " });
                        return Err(crate::i18n::coded("OAUTH_REFUSED", &[("label", label), ("reason", &why)], &format!("{label} sign-in refused: {e} {detail}").trim().to_string()));
                    }
                    match (query_param(&line, "code"), query_param(&line, "state")) {
                        (Some(c), Some(st)) if st == self.state => break (c, s),
                        (Some(_), _) => {
                            reply(&mut s, 400, &Outcome::Error {
                                title: "Sign-in could not be verified",
                                reason: "The sign-in response did not match the request that Hey Look! started (state mismatch).",
                                next: "Close this tab, return to Hey Look! and start the sign-in again.",
                            });
                            return Err("OAuth state mismatch".into());
                        }
                        _ => {
                            // favicon etc.: not the redirect, keep waiting
                            reply(&mut s, 404, &Outcome::Error { title: "Waiting for sign-in", reason: "This address is only used to finish signing in to Hey Look!", next: "Return to Hey Look! to continue." });
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(200)),
                Err(e) => return Err(err(e)),
            }
        };
        let result = self.exchange(&code, client_id, client_secret);
        match &result {
            Ok(signed) => {
                let shown = if self.purpose == Purpose::Calendar { format!("{label} Calendar") } else { label.to_string() };
                let o = Outcome::Success { provider: &shown, email: Some(&signed.email) };
                let _ = conn.write_all(&oauth_page::response(200, &o));
            }
            Err(e) => {
                let o = Outcome::Error {
                    title: "Sign-in didn't finish",
                    reason: e,
                    next: "Return to Hey Look! to see the details, then try signing in again.",
                };
                let _ = conn.write_all(&oauth_page::response(200, &o));
            }
        }
        result
    }

    /// Exchange the authorization code for tokens and read the account address from the id_token.
    fn exchange(&self, code: &str, client_id: &str, client_secret: &str) -> R<Signed> {
        self.exchange_at(&self.provider.token_url(&self.tenant), code, client_id, client_secret)
    }

    /// `exchange` against a given token endpoint (the tests use a fake one).
    fn exchange_at(&self, url: &str, code: &str, client_id: &str, client_secret: &str) -> R<Signed> {
        let redirect = self.provider.redirect(self.port);
        let mut form = vec![
            ("code", code),
            ("client_id", client_id),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", self.verifier.as_str()),
        ];
        if !client_secret.is_empty() {
            form.push(("client_secret", client_secret));
        }
        if self.provider == Provider::Microsoft {
            form.push(("scope", self.provider.scope_for(self.purpose)));
        }
        let resp: serde_json::Value = reqwest::blocking::Client::new()
            .post(url)
            .form(&form)
            .send()
            .map_err(err)?
            .json()
            .map_err(err)?;
        let access = resp["access_token"].as_str().ok_or_else(|| format!("token exchange failed: {}", token_error(&resp)))?;
        let refresh = resp["refresh_token"].as_str().ok_or_else(|| match self.provider {
            Provider::Google => "Google returned no refresh token. Remove the app at myaccount.google.com/permissions and sign in again.".to_string(),
            Provider::Microsoft => "Microsoft returned no refresh token (offline_access was not granted). Sign in again.".to_string(),
        })?;
        let id_token = resp["id_token"].as_str().ok_or("no id_token in response")?;
        let payload = id_token.split('.').nth(1).ok_or("bad id_token")?;
        let claims: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).map_err(err)?,
        )
        .map_err(err)?;
        let email = claims["email"]
            .as_str()
            .or_else(|| claims["preferred_username"].as_str()) // Microsoft personal accounts may omit `email`
            .ok_or("no email in id_token")?
            .to_string();
        let name = claims["name"].as_str().unwrap_or("").to_string();
        let expires = resp["expires_in"].as_i64().unwrap_or(3600);
        // (a mail token is cached under the address until the caller knows the account id; a calendar token is cached by the caller)
        if self.purpose == Purpose::Mail {
            cache().lock().unwrap().insert(email.clone(), (access.to_string(), now() + expires));
        }
        let scope = resp["scope"].as_str().unwrap_or("").to_string();
        Ok(Signed { email, name, refresh_token: refresh.to_string(), access_token: access.to_string(), scope, expires_in: expires })
    }
}

pub fn cache_token(account_id: &str, token: &str, expires_in: i64) {
    cache().lock().unwrap().insert(account_id.to_string(), (token.to_string(), now() + expires_in));
}

/// Why a refresh of a token failed, sorted the way the calendar sync needs it.
#[derive(Debug, Clone, PartialEq)]
pub enum TokenFail {
    /// The grant ended: revoked (myaccount.google.com/permissions, account.live.com/consent), password changed, unused for too long.
    /// Signing in again fixes it.
    Revoked(String),
    /// The organisation does not allow the app (admin approval needed, policy).
    Blocked(String),
    /// The app's own registration is wrong for this (client, API or tenant not set up).
    NotSetUp(String),
    /// There is no stored token (the credential store has no entry).
    Missing(String),
    /// No connection (the text of the transport error).
    Offline(String),
    Other(String),
}

pub struct Refreshed {
    pub access: String,
    pub expires_in: i64,
    /// A new refresh token when the server rotated it (Microsoft always does).
    pub refresh: Option<String>,
}

fn classify_token_error(resp: &serde_json::Value) -> TokenFail {
    let code = resp["error"].as_str().unwrap_or("");
    let desc = resp["error_description"].as_str().unwrap_or("");
    let text = token_error(resp);
    if desc.contains("AADSTS700016") || matches!(code, "unauthorized_client" | "invalid_client") {
        TokenFail::NotSetUp(text)
    } else if matches!(code, "admin_policy_enforced" | "org_internal" | "access_denied" | "consent_required")
        || ["AADSTS65001", "AADSTS90094", "AADSTS900941", "AADSTS50105", "AADSTS53003"].iter().any(|c| desc.contains(c))
    {
        TokenFail::Blocked(text)
    } else if matches!(code, "invalid_grant" | "interaction_required" | "login_required") {
        TokenFail::Revoked(text)
    } else {
        TokenFail::Other(text)
    }
}

/// One refresh-token request to `url`. `scope` is sent for Microsoft only (the resource of the token).
pub fn refresh_at(url: &str, client_id: &str, client_secret: &str, refresh_token: &str, scope: Option<&str>) -> Result<Refreshed, TokenFail> {
    let mut form = vec![("client_id", client_id), ("refresh_token", refresh_token), ("grant_type", "refresh_token")];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }
    if let Some(s) = scope {
        form.push(("scope", s));
    }
    // (any transport failure: no network, DNS, TLS, timeout)
    let resp = reqwest::blocking::Client::new().post(url).form(&form).send().map_err(|e| TokenFail::Offline(err(&e)))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().map_err(|e| TokenFail::Other(format!("token endpoint answered {status}: {e}")))?;
    match body["access_token"].as_str() {
        Some(t) => Ok(Refreshed {
            access: t.to_string(),
            expires_in: body["expires_in"].as_i64().unwrap_or(3600),
            refresh: body["refresh_token"].as_str().filter(|n| *n != refresh_token).map(String::from),
        }),
        None => Err(classify_token_error(&body)),
    }
}

/// A valid access token for the account; refreshes with the stored refresh token when needed.
pub fn access_token(provider: Provider, tenant: &str, account_id: &str, client_id: &str, client_secret: &str) -> R<String> {
    access_token_for(provider, Purpose::Mail, tenant, account_id, client_id, client_secret).map_err(|f| mail_token_error(provider, f))
}

/// The error of a mail token that could not be refreshed. A rejected or missing grant and an organization that has not approved the app
/// are coded (`OAUTH_REAUTH`, `OAUTH_BLOCKED`): the UI then shows the mailbox as "Sign in again" instead of a failure nobody notices.
/// A network failure is as the transport said; anything else is a refresh that did not work this time.
pub fn mail_token_error(provider: Provider, fail: TokenFail) -> String {
    let label = provider.label();
    match fail {
        TokenFail::Offline(m) => m,
        TokenFail::Revoked(t) => crate::i18n::coded("OAUTH_REAUTH", &[("label", label)], &format!("{label} sign-in expired or revoked ({t}). Sign in again.")),
        // (the credential store has no entry: signing in again writes a new one)
        TokenFail::Missing(m) => crate::i18n::coded("OAUTH_REAUTH", &[("label", label)], &format!("{m}. Sign in again.")),
        TokenFail::Blocked(t) => crate::i18n::coded("OAUTH_BLOCKED", &[("label", label)], &format!("Your organization may need to approve Hey Look! for this {label} account. Ask your IT admin. ({t})")),
        TokenFail::NotSetUp(t) | TokenFail::Other(t) => crate::i18n::coded("OAUTH_REFRESH", &[("label", label), ("reason", &t)], &format!("{label} sign-in could not be renewed right now: {t}")),
    }
}

/// Whether a mail error says the mailbox needs a new sign-in, and which kind: `again` (the grant ended) or `blocked` (the organization).
pub fn signin_kind(error: &str) -> Option<&'static str> {
    if error.starts_with("OAUTH_REAUTH") {
        Some("again")
    } else if error.starts_with("OAUTH_BLOCKED") {
        Some("blocked")
    } else {
        None
    }
}

/// Access token of one grant. `key` is the credential-store entry and the cache key: the account id for mail, `<id>:calendar` for calendar.
pub fn access_token_for(provider: Provider, purpose: Purpose, tenant: &str, key: &str, client_id: &str, client_secret: &str) -> Result<String, TokenFail> {
    if let Some((t, exp)) = cache().lock().unwrap().get(key) {
        if *exp - 60 > now() {
            return Ok(t.clone());
        }
    }
    let label = provider.label();
    let entry = crate::identity::entry(key).map_err(|e| TokenFail::Missing(format!("no stored {label} token: {e}")))?;
    let refresh = entry.get_password().map_err(|e| TokenFail::Missing(format!("no stored {label} token: {e}")))?;
    let scope = (provider == Provider::Microsoft).then(|| provider.scope_for(purpose));
    let got = refresh_at(&provider.token_url(tenant), client_id, client_secret, &refresh, scope)?;
    // Microsoft rotates refresh tokens: keep the newest one or the next refresh fails.
    if let Some(new_refresh) = &got.refresh {
        let _ = entry.set_password(new_refresh);
    }
    cache_token(key, &got.access, got.expires_in);
    Ok(got.access)
}

/// Forget the cached access token of a grant (sign-out, disconnect).
pub fn forget_token(key: &str) {
    cache().lock().unwrap().remove(key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calsync::fake_http::{FakeServer, Resp};
    use serde_json::json;

    fn id_token(claims: serde_json::Value) -> String {
        format!("x.{}.y", b64url(claims.to_string().as_bytes()))
    }

    fn token_server(body: serde_json::Value) -> FakeServer {
        FakeServer::start(move |_| Resp::json(200, body.clone()))
    }

    #[test]
    fn the_calendar_code_exchange_reads_the_address_the_granted_scopes_and_keeps_the_mail_cache_clean() {
        let granted = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";
        let srv = token_server(json!({
            "access_token": "AT", "refresh_token": "RT", "expires_in": 3599, "scope": granted,
            "id_token": id_token(json!({ "email": "Me@Gmail.test", "name": "Me" })),
        }));
        let p = begin_for(Provider::Google, Purpose::Calendar, "", "cid", Some("me@gmail.test")).unwrap();
        let got = p.exchange_at(&format!("{}/token", srv.base), "the-code", "cid", "secret").unwrap();
        assert_eq!((got.email.as_str(), got.access_token.as_str(), got.refresh_token.as_str(), got.expires_in), ("Me@Gmail.test", "AT", "RT", 3599));
        assert_eq!(got.scope, granted);
        // what was sent: the code, PKCE verifier, the client secret; no scope for Google (the grant is the one of the consent page)
        let sent = &srv.requests()[0];
        assert!(sent.body.contains("code=the-code") && sent.body.contains("code_verifier=") && sent.body.contains("client_secret=secret") && sent.body.contains("grant_type=authorization_code"), "{}", sent.body);
        assert!(!sent.body.contains("scope="));
        // a calendar token is cached by the caller under <account>:calendar, never under the address (that is the mail cache)
        assert!(cache().lock().unwrap().get("Me@Gmail.test").is_none());
        // the checks the connect command makes on it
        assert!(crate::calsync::cmds::check_grant(Provider::Google, "me@gmail.test", &got.email, &got.scope).is_ok());
    }

    #[test]
    fn a_microsoft_calendar_exchange_names_the_graph_scope_and_a_missing_refresh_token_is_explained() {
        let srv = token_server(json!({ "access_token": "AT", "expires_in": 3600, "id_token": id_token(json!({ "preferred_username": "me@outlook.test" })) }));
        let p = begin_for(Provider::Microsoft, Purpose::Calendar, "common", "cid", None).unwrap();
        let e = p.exchange_at(&format!("{}/t", srv.base), "c", "cid", "").err().unwrap();
        assert!(e.starts_with("Microsoft returned no refresh token"), "{e}");
        assert!(srv.requests()[0].body.contains("scope=https%3A%2F%2Fgraph.microsoft.com%2FCalendars.ReadWrite"), "{}", srv.requests()[0].body);
        // Google without a refresh token says what to do
        let srv = token_server(json!({ "access_token": "AT", "id_token": id_token(json!({ "email": "a@b.c" })) }));
        let p = begin_for(Provider::Google, Purpose::Calendar, "", "cid", None).unwrap();
        assert!(p.exchange_at(&format!("{}/t", srv.base), "c", "cid", "s").err().unwrap().contains("myaccount.google.com/permissions"));
        // an error from the token endpoint is shown with its code
        let srv = token_server(json!({ "error": "invalid_grant", "error_description": "Bad Request\nmore" }));
        assert_eq!(p.exchange_at(&format!("{}/t", srv.base), "c", "cid", "s").err().unwrap(), "token exchange failed: invalid_grant: Bad Request");
    }

    #[test]
    fn a_microsoft_calendar_exchange_reads_the_address_from_the_upn_and_the_granted_scope_is_checked() {
        // Microsoft answers the scope without the resource URL; a personal account may have no `email` claim
        let srv = token_server(json!({
            "access_token": "AT", "refresh_token": "RT", "expires_in": 3599, "scope": "Calendars.ReadWrite openid profile email",
            "id_token": id_token(json!({ "preferred_username": "Me@Outlook.test", "name": "Me" })),
        }));
        let p = begin_for(Provider::Microsoft, Purpose::Calendar, "common", "cid", Some("me@outlook.test")).unwrap();
        let got = p.exchange_at(&format!("{}/t", srv.base), "c", "cid", "").unwrap();
        assert!(crate::calsync::cmds::check_grant(Provider::Microsoft, "me@outlook.test", &got.email, &got.scope).is_ok());
        // another account than the mailbox, or the calendar permission missing from the grant: nothing is stored
        assert!(crate::calsync::cmds::check_grant(Provider::Microsoft, "other@outlook.test", &got.email, &got.scope).unwrap_err().starts_with("CAL_WRONG_ACCOUNT"));
        assert!(crate::calsync::cmds::check_grant(Provider::Microsoft, "me@outlook.test", &got.email, "openid profile email").unwrap_err().starts_with("CAL_PARTIAL"));
        // the Microsoft mail token is not in the calendar cache, and the form carries the Graph scope
        assert!(cache().lock().unwrap().get("Me@Outlook.test").is_none());
        assert!(srv.requests()[0].body.contains("scope=https%3A%2F%2Fgraph.microsoft.com%2FCalendars.ReadWrite"));
    }

    #[test]
    fn refresh_returns_the_token_and_a_rotated_refresh_token() {
        let srv = FakeServer::start(|r| {
            assert!(r.body.contains("grant_type=refresh_token") && r.body.contains("refresh_token=old"));
            Resp::json(200, json!({ "access_token": "NEW", "expires_in": 1800, "refresh_token": "rotated" }))
        });
        let got = refresh_at(&format!("{}/token", srv.base), "cid", "sec", "old", Some("https://graph.microsoft.com/Calendars.ReadWrite offline_access")).unwrap();
        assert_eq!((got.access.as_str(), got.expires_in, got.refresh.as_deref()), ("NEW", 1800, Some("rotated")));
        assert!(srv.requests()[0].body.contains("client_secret=sec") && srv.requests()[0].body.contains("scope=https%3A%2F%2Fgraph.microsoft.com"));
        // the same refresh token handed back is not "rotated"
        let srv = token_server(json!({ "access_token": "N", "refresh_token": "old" }));
        assert_eq!(refresh_at(&format!("{}/t", srv.base), "cid", "", "old", None).unwrap().refresh, None);
    }

    #[test]
    fn refresh_failures_are_sorted_for_the_calendar_states() {
        let fail = |v: serde_json::Value| {
            let srv = FakeServer::start(move |_| Resp::json(400, v.clone()));
            refresh_at(&format!("{}/t", srv.base), "cid", "", "rt", None).err().unwrap()
        };
        // revoked at myaccount.google.com/permissions, password change
        assert!(matches!(fail(json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." })), TokenFail::Revoked(t) if t.contains("expired or revoked")));
        assert!(matches!(fail(json!({ "error": "interaction_required" })), TokenFail::Revoked(_)));
        // the organization does not allow the app
        assert!(matches!(fail(json!({ "error": "admin_policy_enforced" })), TokenFail::Blocked(_)));
        assert!(matches!(fail(json!({ "error": "invalid_grant", "error_description": "AADSTS65001: The user or administrator has not consented" })), TokenFail::Blocked(_)));
        assert!(matches!(fail(json!({ "error": "access_denied" })), TokenFail::Blocked(_)));
        // the client is not registered for this
        assert!(matches!(fail(json!({ "error": "unauthorized_client" })), TokenFail::NotSetUp(_)));
        assert!(matches!(fail(json!({ "error": "invalid_client" })), TokenFail::NotSetUp(_)));
        assert!(matches!(fail(json!({ "error": "invalid_request", "error_description": "AADSTS700016: Application was not found" })), TokenFail::NotSetUp(_)));
        assert!(matches!(fail(json!({ "error": "temporarily_unavailable" })), TokenFail::Other(_)));
        // no network
        let dead = crate::testutil::dead_addr();
        assert!(matches!(refresh_at(&format!("http://{dead}/t"), "cid", "", "rt", None), Err(TokenFail::Offline(_))));
        // and into the sync layer's errors
        use crate::calsync::SyncErr;
        assert_eq!(SyncErr::from(TokenFail::Revoked("x".into())), SyncErr::Auth);
        assert_eq!(SyncErr::from(TokenFail::Missing("x".into())), SyncErr::Auth);
        assert_eq!(SyncErr::from(TokenFail::Offline("x".into())), SyncErr::Offline);
        assert_eq!(SyncErr::from(TokenFail::NotSetUp("x".into())), SyncErr::NotSetUp("x".into()));
        assert_eq!(SyncErr::from(TokenFail::Blocked("x".into())), SyncErr::Blocked("x".into()));
    }

    #[test]
    fn a_cached_calendar_token_is_used_without_any_request_and_kept_apart_from_the_mail_token() {
        let key = calendar_key("acc-cache-test");
        assert_eq!(key, "acc-cache-test:calendar");
        cache_token(&key, "CAL-TOKEN", 3600);
        cache_token("acc-cache-test", "MAIL-TOKEN", 3600);
        assert_eq!(access_token_for(Provider::Google, Purpose::Calendar, "", &key, "cid", "").unwrap(), "CAL-TOKEN");
        assert_eq!(access_token(Provider::Google, "", "acc-cache-test", "cid", "").unwrap(), "MAIL-TOKEN");
        forget_token(&key);
        assert!(cache().lock().unwrap().get(&key).is_none() && cache().lock().unwrap().get("acc-cache-test").is_some());
    }

    fn request(port: u16, path: &str) {
        use std::io::Write;
        let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(format!("GET {path} HTTP/1.1
Host: 127.0.0.1

").as_bytes()).unwrap();
        let _ = c.read(&mut [0u8; 64]);
    }

    #[test]
    fn cancel_ends_the_wait_at_once_frees_the_port_and_stores_nothing() {
        crate::test_guard::within(30, || {
            let p = begin(Provider::Google, "", "cid").unwrap();
            let (port, flag) = (p.port, p.canceller());
            let waiting = Waiting::new();
            waiting.begin(flag.clone());
            let h = std::thread::spawn(move || p.finish("cid", "").err());
            std::thread::sleep(Duration::from_millis(400));
            assert!(!h.is_finished(), "it waits for the browser");
            let t0 = Instant::now();
            waiting.cancel();
            let e = h.join().unwrap().expect("a cancelled sign-in is an error, not an account");
            assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
            assert_eq!(e, "OAUTH_CANCELLED|label=Google: Google sign-in cancelled");
            // the loopback port is free again
            assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
            // (the sign-in is over: a later Cancel does not touch the next one)
            waiting.end(&flag);
            let next = Arc::new(AtomicBool::new(false));
            waiting.begin(next.clone());
            waiting.end(&flag);
            waiting.cancel();
            assert!(next.load(Ordering::SeqCst), "ending the old sign-in did not take the slot of the new one");
        });
    }

    #[test]
    fn a_new_sign_in_ends_the_one_that_still_waits_and_the_wait_times_out() {
        crate::test_guard::within(30, || {
            let waiting = Waiting::new();
            let (old, new) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
            waiting.begin(old.clone());
            waiting.begin(new.clone());
            assert!(old.load(Ordering::SeqCst) && !new.load(Ordering::SeqCst));
            waiting.end(&new);
            waiting.cancel();
            assert!(!new.load(Ordering::SeqCst), "nothing waits any more");
            // no redirect ever comes: the limit ends the wait and frees the port
            let p = begin(Provider::Microsoft, "common", "cid").unwrap();
            let port = p.port;
            let e = p.finish_within(Duration::from_millis(300), "cid", "").err().unwrap();
            assert_eq!(e, "OAUTH_TIMEOUT|label=Microsoft: Microsoft sign-in timed out");
            assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
        });
    }

    #[test]
    fn a_refused_sign_in_carries_the_provider_code_so_the_organization_case_is_told_apart() {
        for (query, blocked) in [
            ("error=access_denied&error_description=AADSTS65001%3A%20The%20user%20or%20administrator%20has%20not%20consented", true),
            ("error=access_denied", false),
        ] {
            let p = begin(Provider::Microsoft, "common", "cid").unwrap();
            let port = p.port;
            let h = std::thread::spawn(move || p.finish("cid", "").err().unwrap());
            request(port, &format!("/?{query}&state=x"));
            let e = h.join().unwrap();
            assert!(e.starts_with("OAUTH_REFUSED|label=Microsoft|reason=access_denied"), "{e}");
            assert!(e.contains("AADSTS65001") == blocked, "{e}");
            // the calendar consent turns the same texts into its own states
            assert!(crate::calsync::cmds::connect_error(&e, "me@x.test").starts_with(if blocked { "CAL_BLOCKED" } else { "CAL_DENIED" }), "{e}");
        }
    }

    #[test]
    fn a_rejected_mail_grant_says_sign_in_again_and_an_organization_block_says_ask_the_admin() {
        let kind = |p: Provider, body: serde_json::Value| {
            let srv = FakeServer::start(move |_| Resp::json(400, body.clone()));
            let fail = refresh_at(&format!("{}/t", srv.base), "cid", "", "rt", None).err().unwrap();
            let text = mail_token_error(p, fail);
            (signin_kind(&text), text)
        };
        // Google: revoked at myaccount.google.com/permissions, password changed
        let (k, text) = kind(Provider::Google, json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." }));
        assert_eq!(k, Some("again"));
        assert!(text.starts_with("OAUTH_REAUTH|label=Google: Google sign-in expired or revoked"), "{text}");
        // Microsoft: the grant was revoked, or needs a new interactive sign-in
        assert_eq!(kind(Provider::Microsoft, json!({ "error": "invalid_grant", "error_description": "AADSTS50173: The provided grant has expired due to it being revoked" })).0, Some("again"));
        assert_eq!(kind(Provider::Microsoft, json!({ "error": "interaction_required", "error_description": "AADSTS50076: MFA" })).0, Some("again"));
        // the organization has to approve the app
        assert_eq!(kind(Provider::Microsoft, json!({ "error": "invalid_grant", "error_description": "AADSTS65001: The user or administrator has not consented" })).0, Some("blocked"));
        assert_eq!(kind(Provider::Microsoft, json!({ "error": "consent_required" })).0, Some("blocked"));
        // a token endpoint that is only unavailable, or an app that is not set up, is not "sign in again"
        let (k, text) = kind(Provider::Google, json!({ "error": "temporarily_unavailable" }));
        assert!(k.is_none() && text.starts_with("OAUTH_REFRESH|label=Google|reason=temporarily_unavailable"), "{text}");
        assert!(kind(Provider::Google, json!({ "error": "invalid_client" })).0.is_none());
        // no stored token (credential store entry gone): signing in again writes a new one; no network is the transport error as it was
        assert_eq!(signin_kind(&mail_token_error(Provider::Google, TokenFail::Missing("no stored Google token: x".into()))), Some("again"));
        assert_eq!(mail_token_error(Provider::Google, TokenFail::Offline("dns error".into())), "dns error");
        assert_eq!(signin_kind("Google sign-in cancelled"), None);
    }

    #[test]
    fn mail_and_calendar_scopes_never_mix() {
        for p in [Provider::Google, Provider::Microsoft] {
            let (mail, cal) = (p.scope_for(Purpose::Mail), p.scope_for(Purpose::Calendar));
            assert!(!cal.contains("mail.google.com") && !cal.contains("outlook.office.com"), "{cal}");
            assert!(!mail.to_ascii_lowercase().contains("calendar"), "{mail}");
        }
        // the narrowest calendar scopes: not the full `calendar` scope
        let g = Provider::Google.scope_for(Purpose::Calendar);
        assert_eq!(g.split_whitespace().collect::<Vec<_>>(), ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "openid", "email"]);
    }

    /// AC-7.9.12: the sign-in with "Also sync my calendar" (two grants, the calendar consent right after the mail consent) asks for exactly the
    /// scopes Google's verification was filed with and the Microsoft permissions the app is registered for. Changing any of the four strings is
    /// a decision for the owner (a new verification), not a side effect of a feature.
    #[test]
    fn the_requested_scopes_are_exactly_the_verified_set() {
        assert_eq!(Provider::Google.scope_for(Purpose::Mail), "https://mail.google.com/ openid email profile");
        assert_eq!(
            Provider::Google.scope_for(Purpose::Calendar),
            "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly openid email"
        );
        assert_eq!(
            Provider::Microsoft.scope_for(Purpose::Mail),
            "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile"
        );
        assert_eq!(Provider::Microsoft.scope_for(Purpose::Calendar), "https://graph.microsoft.com/Calendars.ReadWrite offline_access openid email profile");
    }
}
