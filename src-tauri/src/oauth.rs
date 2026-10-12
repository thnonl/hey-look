//! Google OAuth 2.0 (installed-app flow with PKCE + loopback redirect) for Gmail IMAP/SMTP via XOAUTH2.
//! The user supplies their own OAuth client id/secret (Google Cloud Console, "Desktop app").
use crate::db::{err, R};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://mail.google.com/ openid email profile";

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
pub fn begin(client_id: &str) -> R<Pending> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let verifier = b64url(&rand::random::<[u8; 32]>());
    let state = b64url(&rand::random::<[u8; 16]>());
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let q = |s: &str| urlencoding::encode(s).into_owned();
    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        q(client_id),
        q(&format!("http://127.0.0.1:{port}")),
        q(SCOPE),
        challenge,
        state
    );
    Ok(Pending { listener, port, verifier, state, url })
}

fn query_param(line: &str, key: &str) -> Option<String> {
    let path = line.split_whitespace().nth(1)?;
    let q = path.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default())
    })
}

impl Pending {
    /// Wait for the browser redirect (max 5 min), then exchange the code for tokens.
    pub fn finish(self, client_id: &str, client_secret: &str) -> R<Signed> {
        self.listener.set_nonblocking(true).map_err(err)?;
        let deadline = Instant::now() + Duration::from_secs(300);
        let code = loop {
            if Instant::now() > deadline {
                return Err("Google sign-in timed out".into());
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
                        return Err(format!("Google sign-in refused: {e}"));
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
        let resp: serde_json::Value = reqwest::blocking::Client::new()
            .post(TOKEN_URL)
            .form(&[
                ("code", code.as_str()),
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("redirect_uri", &format!("http://127.0.0.1:{}", self.port)),
                ("grant_type", "authorization_code"),
                ("code_verifier", self.verifier.as_str()),
            ])
            .send()
            .map_err(err)?
            .json()
            .map_err(err)?;
        let access = resp["access_token"].as_str().ok_or_else(|| format!("token exchange failed: {resp}"))?;
        let refresh = resp["refresh_token"]
            .as_str()
            .ok_or("Google returned no refresh token. Remove the app at myaccount.google.com/permissions and sign in again.")?;
        let id_token = resp["id_token"].as_str().ok_or("no id_token in response")?;
        let payload = id_token.split('.').nth(1).ok_or("bad id_token")?;
        let claims: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).map_err(err)?,
        )
        .map_err(err)?;
        let email = claims["email"].as_str().ok_or("no email in id_token")?.to_string();
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
pub fn access_token(account_id: &str, client_id: &str, client_secret: &str) -> R<String> {
    if let Some((t, exp)) = cache().lock().unwrap().get(account_id) {
        if *exp - 60 > now() {
            return Ok(t.clone());
        }
    }
    let refresh = keyring::Entry::new("hey-look", account_id)
        .and_then(|e| e.get_password())
        .map_err(|e| format!("no stored Google token: {e}"))?;
    let resp: serde_json::Value = reqwest::blocking::Client::new()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .map_err(err)?
        .json()
        .map_err(err)?;
    match resp["access_token"].as_str() {
        Some(t) => {
            cache_token(account_id, t, resp["expires_in"].as_i64().unwrap_or(3600));
            Ok(t.to_string())
        }
        None => Err(format!(
            "Google sign-in expired or revoked ({}). Remove the account and sign in again.",
            resp["error"].as_str().unwrap_or("unknown")
        )),
    }
}
