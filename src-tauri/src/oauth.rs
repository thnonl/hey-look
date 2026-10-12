//! OAuth 2.0 (installed-app flow with PKCE + loopback redirect) for IMAP/SMTP via XOAUTH2.
//! Providers: Google (Gmail) and Microsoft (Outlook.com, Microsoft 365). Apple offers no OAuth for iCloud Mail.
//! The user supplies their own OAuth client: Google Cloud Console "Desktop app", or a Microsoft Entra
//! "Mobile and desktop applications" registration (public client, no secret needed).
use crate::db::{err, R};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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

    fn auth_url(self) -> &'static str {
        match self {
            Provider::Google => "https://accounts.google.com/o/oauth2/v2/auth",
            Provider::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        }
    }

    fn token_url(self) -> &'static str {
        match self {
            Provider::Google => "https://oauth2.googleapis.com/token",
            Provider::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Provider::Google => "https://mail.google.com/ openid email profile",
            // One Outlook resource token covers both IMAP and SMTP AUTH.
            Provider::Microsoft => {
                "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile"
            }
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

pub struct Pending {
    provider: Provider,
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
}

/// Bind the loopback listener and build the consent URL.
pub fn begin(provider: Provider, client_id: &str) -> R<Pending> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let verifier = b64url(&rand::random::<[u8; 32]>());
    let state = b64url(&rand::random::<[u8; 16]>());
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let q = |s: &str| urlencoding::encode(s).into_owned();
    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}{}",
        provider.auth_url(),
        q(client_id),
        q(&provider.redirect(port)),
        q(provider.scope()),
        challenge,
        state,
        provider.extra_auth_params()
    );
    Ok(Pending { provider, listener, port, verifier, state, url })
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
    /// Wait for the browser redirect (max 5 min), then exchange the code for tokens.
    /// `client_secret` may be empty (Microsoft public clients have none).
    pub fn finish(self, client_id: &str, client_secret: &str) -> R<Signed> {
        let label = self.provider.label();
        self.listener.set_nonblocking(true).map_err(err)?;
        let deadline = Instant::now() + Duration::from_secs(300);
        let code = loop {
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
                    let reply = |s: &mut std::net::TcpStream, body: &str| {
                        let _ = write!(
                            s,
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                    };
                    if let Some(e) = query_param(&line, "error") {
                        reply(&mut s, "<h3>Sign-in was cancelled.</h3>You can close this tab.");
                        let detail = query_param(&line, "error_description").unwrap_or_default();
                        return Err(format!("{label} sign-in refused: {e} {detail}").trim().to_string());
                    }
                    match (query_param(&line, "code"), query_param(&line, "state")) {
                        (Some(c), Some(st)) if st == self.state => {
                            reply(&mut s, "<h3>Signed in to Hey Look!</h3>You can close this tab and return to the app.");
                            break c;
                        }
                        (Some(_), _) => {
                            reply(&mut s, "State mismatch.");
                            return Err("OAuth state mismatch".into());
                        }
                        _ => reply(&mut s, "Waiting for sign-in…"), // favicon etc.
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(200)),
                Err(e) => return Err(err(e)),
            }
        };
        let redirect = self.provider.redirect(self.port);
        let mut form = vec![
            ("code", code.as_str()),
            ("client_id", client_id),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", self.verifier.as_str()),
        ];
        if !client_secret.is_empty() {
            form.push(("client_secret", client_secret));
        }
        if self.provider == Provider::Microsoft {
            form.push(("scope", self.provider.scope()));
        }
        let resp: serde_json::Value = reqwest::blocking::Client::new()
            .post(self.provider.token_url())
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
        cache().lock().unwrap().insert(email.clone(), (access.to_string(), now() + expires));
        Ok(Signed { email, name, refresh_token: refresh.to_string(), access_token: access.to_string() })
    }
}

pub fn cache_token(account_id: &str, token: &str, expires_in: i64) {
    cache().lock().unwrap().insert(account_id.to_string(), (token.to_string(), now() + expires_in));
}

/// A valid access token for the account; refreshes with the stored refresh token when needed.
pub fn access_token(provider: Provider, account_id: &str, client_id: &str, client_secret: &str) -> R<String> {
    if let Some((t, exp)) = cache().lock().unwrap().get(account_id) {
        if *exp - 60 > now() {
            return Ok(t.clone());
        }
    }
    let label = provider.label();
    let entry = keyring::Entry::new("hey-look", account_id).map_err(|e| format!("no stored {label} token: {e}"))?;
    let refresh = entry.get_password().map_err(|e| format!("no stored {label} token: {e}"))?;
    let mut form = vec![("client_id", client_id), ("refresh_token", refresh.as_str()), ("grant_type", "refresh_token")];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }
    if provider == Provider::Microsoft {
        form.push(("scope", provider.scope()));
    }
    let resp: serde_json::Value = reqwest::blocking::Client::new()
        .post(provider.token_url())
        .form(&form)
        .send()
        .map_err(err)?
        .json()
        .map_err(err)?;
    match resp["access_token"].as_str() {
        Some(t) => {
            // Microsoft rotates refresh tokens: keep the newest one or the next refresh fails.
            if let Some(new_refresh) = resp["refresh_token"].as_str().filter(|n| *n != refresh) {
                let _ = entry.set_password(new_refresh);
            }
            cache_token(account_id, t, resp["expires_in"].as_i64().unwrap_or(3600));
            Ok(t.to_string())
        }
        None => Err(format!(
            "{label} sign-in expired or revoked ({}). Remove the account and sign in again.",
            token_error(&resp)
        )),
    }
}
