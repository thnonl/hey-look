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

    fn scope(self) -> &'static str {
        self.scope_for(Purpose::Mail)
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

    fn extra_auth_params(self) -> &'static str {
        match self {
            Provider::Google => "&access_type=offline&prompt=consent",
            Provider::Microsoft => "&prompt=select_account",
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

/// Bind the loopback listener and build the consent URL of a mail sign-in.
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
    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}{}",
        provider.auth_url(tenant),
        q(client_id),
        q(&provider.redirect(port)),
        q(provider.scope_for(purpose)),
        challenge,
        state,
        provider.extra_auth_params()
    );
    let url = match login_hint.map(str::trim).filter(|h| !h.is_empty()) {
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
    /// Setting it ends `finish` early ("cancelled"): the Cancel button of the calendar consent.
    pub fn canceller(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// Wait for the browser redirect (max 5 min), then exchange the code for tokens.
    /// `client_secret` may be empty (Microsoft public clients have none).
    pub fn finish(self, client_id: &str, client_secret: &str) -> R<Signed> {
        let label = self.provider.label();
        self.listener.set_nonblocking(true).map_err(err)?;
        let deadline = Instant::now() + Duration::from_secs(300);
        // the browser connection of the redirect stays open until the token exchange is done, so the page can show the address
        let (code, mut conn) = loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(format!("{label} sign-in cancelled"));
            }
            if Instant::now() > deadline {
                return Err(format!("{label} sign-in timed out"));
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
                            ("Sign-in was cancelled", "Hey Look! needs your permission to show and change events in your calendars. Return to Hey Look! and turn the switch on again when you are ready.")
                        } else if e == "access_denied" {
                            ("Sign-in was cancelled", "Hey Look! needs your permission to read and send mail for this account. Return to Hey Look! and choose Sign in again when you are ready.")
                        } else {
                            ("Sign-in didn't finish", "Return to Hey Look!, check the sign-in settings (client ID, secret, redirect) and try again.")
                        };
                        let reason = format!("{label} reported: {e}{}{detail}", if detail.is_empty() { "" } else { " - " });
                        reply(&mut s, 200, &Outcome::Error { title, reason: &reason, next });
                        return Err(format!("{label} sign-in refused: {e} {detail}").trim().to_string());
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
                            reply(&mut s, 404, &Outcome::Error { title: "Waiting for sign-in", reason: "This address is only used to finish signing in to Hey Look!.", next: "Return to Hey Look! to continue." });
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
            .post(self.provider.token_url(&self.tenant))
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
    /// The grant ended: revoked, expired (a Google app in Testing mode: 7 days), password changed. Signing in again fixes it.
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

impl TokenFail {
    pub fn text(&self) -> String {
        match self {
            TokenFail::Revoked(t) | TokenFail::Blocked(t) | TokenFail::NotSetUp(t) | TokenFail::Missing(t) | TokenFail::Other(t) | TokenFail::Offline(t) => t.clone(),
        }
    }
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
    access_token_for(provider, Purpose::Mail, tenant, account_id, client_id, client_secret).map_err(|f| match f {
        // the transport error as it was before the calendar existed
        TokenFail::Missing(m) | TokenFail::Offline(m) => m,
        other => format!("{} sign-in expired or revoked ({}). Remove the account and sign in again.", provider.label(), other.text()),
    })
}

/// Access token of one grant. `key` is the credential-store entry and the cache key: the account id for mail, `<id>:calendar` for calendar.
pub fn access_token_for(provider: Provider, purpose: Purpose, tenant: &str, key: &str, client_id: &str, client_secret: &str) -> Result<String, TokenFail> {
    if let Some((t, exp)) = cache().lock().unwrap().get(key) {
        if *exp - 60 > now() {
            return Ok(t.clone());
        }
    }
    let label = provider.label();
    let entry = keyring::Entry::new(crate::KEYRING_SERVICE, key).map_err(|e| TokenFail::Missing(format!("no stored {label} token: {e}")))?;
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
