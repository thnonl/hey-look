use crate::db::R;
use serde_json::json;

/// How long one completion may take before it is given up. A long email on a slow model can need a minute or two; the UI waits a little
/// longer than this (src/translateJobs.ts TRANSLATE_TIMEOUT_MS) so that this coded error is the one the person sees.
pub const COMPLETE_TIMEOUT_SECS: u64 = 180;

/// OpenAI-compatible chat completion. Works with any endpoint (OpenAI, local, gateways).
/// With a `job` id the call can be cancelled by `cancel(job)`: the request is dropped, which closes the connection to the provider.
pub async fn complete(endpoint: &str, key: &str, model: &str, system: &str, prompt: &str, job: Option<&str>) -> R<String> {
    complete_job(endpoint, key, model, system, prompt, COMPLETE_TIMEOUT_SECS, job).await
}

/// The error of a call that `cancel` ended. The UI has dropped the job already, so the person never reads it.
const CANCELLED: &str = "AI_CANCELLED: The AI Assistant request was cancelled.";

/// Cancellable calls: the live ones by job id, and the ids cancelled before their call got as far as registering (a cancel that
/// overtook its own request), kept briefly so that the call still ends at once instead of running for minutes.
#[derive(Default)]
struct Jobs {
    live: std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>,
    early: std::collections::VecDeque<String>,
}

/// Cancelled-too-early ids remembered at most (the oldest go first).
const EARLY_MAX: usize = 32;

impl Jobs {
    fn note_early(&mut self, id: &str) {
        if self.early.len() >= EARLY_MAX {
            self.early.pop_front();
        }
        self.early.push_back(id.to_string());
    }
}

fn jobs() -> &'static std::sync::Mutex<Jobs> {
    static JOBS: std::sync::OnceLock<std::sync::Mutex<Jobs>> = std::sync::OnceLock::new();
    JOBS.get_or_init(Default::default)
}

fn jobs_lock() -> std::sync::MutexGuard<'static, Jobs> {
    jobs().lock().unwrap_or_else(|p| p.into_inner())
}

/// Unregisters its job when the call ends, however it ends.
struct JobGuard(String);

impl Drop for JobGuard {
    fn drop(&mut self) {
        jobs_lock().live.remove(&self.0);
    }
}

/// Registers `id`; None when it was cancelled before this call started. A second call with the same id takes the place of the first,
/// which then ends as cancelled (its sender is dropped).
fn register(id: &str) -> Option<(tokio::sync::oneshot::Receiver<()>, JobGuard)> {
    let mut j = jobs_lock();
    if let Some(i) = j.early.iter().position(|e| e == id) {
        j.early.remove(i);
        return None;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    j.live.insert(id.to_string(), tx);
    Some((rx, JobGuard(id.to_string())))
}

/// Cancel the call of `id`: it ends at once with `AI_CANCELLED` and its request is dropped. An id nobody knows (yet) is remembered for a
/// call that has not registered; one that already ended does no harm (the id is simply pushed out later).
pub fn cancel(id: &str) {
    let mut j = jobs_lock();
    match j.live.remove(id) {
        Some(tx) => {
            let _ = tx.send(());
        }
        None => j.note_early(id),
    }
}

async fn complete_job(endpoint: &str, key: &str, model: &str, system: &str, prompt: &str, secs: u64, job: Option<&str>) -> R<String> {
    let Some(id) = job.filter(|j| !j.is_empty()) else {
        return complete_within(endpoint, key, model, system, prompt, secs).await;
    };
    let Some((cancelled, _guard)) = register(id) else { return Err(CANCELLED.into()) };
    // when `cancelled` wins, the request future is dropped here: reqwest closes the connection and the provider stops working on it
    tokio::select! {
        r = complete_within(endpoint, key, model, system, prompt, secs) => r,
        _ = cancelled => Err(CANCELLED.into()),
    }
}

fn timed_out(secs: u64) -> String {
    crate::i18n::coded("AI_TIMEOUT", &[("secs", &secs.to_string())], &format!("The AI Assistant didn’t answer within {secs} seconds."))
}

async fn complete_within(endpoint: &str, key: &str, model: &str, system: &str, prompt: &str, secs: u64) -> R<String> {
    if endpoint.trim().is_empty() || model.trim().is_empty() {
        return Err("AI_NOT_CONFIGURED: AI not configured: set endpoint and model in Settings > AI".into());
    }
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    // the whole exchange (connect, send, wait for the answer, read it) ends after `secs`: no request waits for ever
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(secs)).build().map_err(net_error)?;
    let mut req = client.post(url).json(&json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.4
    }));
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| if e.is_timeout() { timed_out(secs) } else { net_error(e) })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| if e.is_timeout() { timed_out(secs) } else { net_error(e) })?;
    if !status.is_success() {
        return Err(http_error(status.as_u16(), &text, key));
    }
    reply_text(&text)
}

/// A failed request as text for the person: what failed and where, with the address cut down to scheme, host and path. reqwest names the
/// whole URL, and the endpoint of the setting may carry a password (`user:pw@host`) or a token (`?key=…`) that must not reach a toast.
fn net_error(e: reqwest::Error) -> String {
    let shown = e.url().map(|u| {
        let mut u = u.clone();
        let _ = u.set_username("");
        let _ = u.set_password(None);
        u.set_query(None);
        u.set_fragment(None);
        u.to_string()
    });
    let what = e.without_url().to_string();
    match shown {
        Some(u) => format!("{what} for url ({u})"),
        None => what,
    }
}

/// The coded error for a success answer the app cannot use (not JSON, or no text in it). It never carries the answer: that is the
/// provider's JSON, which the person must not be shown.
fn bad_response() -> String {
    crate::i18n::coded("AI_BAD_RESPONSE", &[], "The AI Assistant sent an answer the app can’t read.")
}

/// The text of a chat completion answer: `choices[0].message.content`.
fn reply_text(answer: &str) -> R<String> {
    let body: serde_json::Value = serde_json::from_str(answer).map_err(|_| bad_response())?;
    body["choices"][0]["message"]["content"].as_str().map(|s| s.trim().to_string()).ok_or_else(bad_response)
}

/// Longest provider message shown to the person (characters).
const DETAIL_MAX: usize = 160;

/// The coded error for a non-success answer: `AI_HTTP|status=500|detail=<what the provider said>: English text`, without `detail`
/// (and with `v=plain`) when the answer has no readable message. Never carries the raw body, the request or the API key.
fn http_error(status: u16, body: &str, key: &str) -> String {
    match provider_message(body, key) {
        Some(d) => crate::i18n::coded("AI_HTTP", &[("status", &status.to_string()), ("detail", &d)], &format!("The AI Assistant returned an error ({status}): {d}")),
        None => crate::i18n::coded("AI_HTTP", &[("v", "plain"), ("status", &status.to_string())], &format!("The AI Assistant returned an error ({status}).")),
    }
}

/// The short human message in an error answer of an OpenAI-compatible endpoint: `{"error":{"message":..}}`, `{"error":".."}`,
/// `{"message":..}`, `{"detail":..}`, `{"error_description":..}` (also as the first element of an array), or a plain text body.
/// None for an empty or HTML body, or a message that is itself JSON. One line, at most `DETAIL_MAX` characters, with the API key hidden.
fn provider_message(body: &str, key: &str) -> Option<String> {
    let body = body.trim();
    let raw: String = match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => {
            let v = if let Some(first) = v.as_array().and_then(|a| a.first()) { first.clone() } else { v };
            let s = |x: &serde_json::Value| x.as_str().map(str::to_string);
            s(&v["error"]["message"])
                .or_else(|| s(&v["error"]))
                .or_else(|| s(&v["message"]))
                .or_else(|| s(&v["detail"]))
                .or_else(|| s(&v["error_description"]))
                .or_else(|| s(&v["error"]["detail"]))?
        }
        // not JSON: a plain text answer is the message, an HTML page is not
        Err(_) if body.starts_with('<') => return None,
        Err(_) => body.to_string(),
    };
    let mut line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if !key.trim().is_empty() && key.trim().len() >= 4 {
        line = line.replace(key.trim(), "…");
    }
    // providers sometimes echo a (masked) key: any word that looks like one goes too
    let mut words: Vec<&str> = Vec::new();
    let mut after_bearer = false;
    for w in line.split(' ') {
        words.push(if after_bearer || w.starts_with("sk-") { "…" } else { w });
        after_bearer = w == "Bearer";
    }
    line = words.join(" ");
    if line.is_empty() || line.starts_with('{') || line.starts_with('[') {
        return None;
    }
    if line.chars().count() > DETAIL_MAX {
        let cut: String = line.chars().take(DETAIL_MAX - 1).collect();
        line = format!("{}…", cut.trim_end());
    }
    Some(line)
}

/// How the model list URL of Settings > AI Assistant > Advanced is read (W8.11). The same rules as `resolveModelsUrl` in src/aiModelsUrl.ts; scripts/fixtures/ai-models-url/cases.json is run by both.
#[derive(Debug, PartialEq)]
pub enum ModelsUrl {
    /// no Base URL: nothing to ask
    None,
    /// the list URL is none of the three forms (empty, a path starting with one /, a full http(s) URL), or is longer than 2,000 characters
    Invalid,
    /// the address that is asked (for an empty list URL: the Base URL and /models, not parsed)
    Url(String),
}

/// The longest list URL (characters).
const MODELS_URL_MAX: usize = 2000;

/// A web address (scheme http or https, a host), or None.
fn web_url(text: &str) -> Option<reqwest::Url> {
    reqwest::Url::parse(text).ok().filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()))
}

/// The origin of an address (scheme, host, the port unless it is the default one), or None when it is not an http(s) address.
pub fn origin_of(url: &str) -> Option<String> {
    web_url(url.trim()).map(|u| u.origin().ascii_serialization())
}

/// Where the model list is asked: no Base URL = None; an empty list URL = the Base URL and /models; a value that starts with a single / = the Base URL's scheme, user info, host and
/// port with that path and query (fragment dropped); a full http(s) URL = that URL (fragment dropped); anything else, or too long = Invalid.
pub fn resolve_models_url(base: &str, value: &str) -> ModelsUrl {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return ModelsUrl::None;
    }
    let value = value.trim();
    if value.is_empty() {
        return ModelsUrl::Url(format!("{base}/models"));
    }
    if value.chars().count() > MODELS_URL_MAX {
        return ModelsUrl::Invalid;
    }
    if value.starts_with('/') && !value.starts_with("//") {
        let Some(b) = web_url(base) else { return ModelsUrl::Invalid };
        // (a browser reads "/\host" like "//host": whatever the rules said, the result must stay on the Base URL's server)
        return match b.join(value) {
            Ok(mut u) if u.origin() == b.origin() && u.username() == b.username() && u.password() == b.password() => {
                u.set_fragment(None);
                ModelsUrl::Url(u.to_string())
            }
            _ => ModelsUrl::Invalid,
        };
    }
    match web_url(value) {
        Some(mut u) => {
            u.set_fragment(None);
            ModelsUrl::Url(u.to_string())
        }
        None => ModelsUrl::Invalid,
    }
}

/// The coded error of a model list URL that is none of the three forms.
fn models_url_bad() -> String {
    crate::i18n::coded("AI_MODELS_URL_BAD", &[], "The model list URL must start with “https://”, “http://” or “/”.")
}

/// The coded error of a redirect to another server that was not followed (nothing was sent there).
fn models_redirect(host: &str) -> String {
    crate::i18n::coded("AI_MODELS_REDIRECT", &[("host", host)], &format!("Redirect to {host} was not followed"))
}

/// The most the list answer may be (bytes), and the most of an error answer that is read for its message.
const MODELS_BODY_MAX: usize = 8 * 1024 * 1024;
const MODELS_ERROR_BODY_MAX: usize = 64 * 1024;
/// The most redirects (on the list's own server) that are followed.
const MODELS_MAX_HOPS: usize = 5;
/// The most ids kept, the longest id, and what an id may not contain.
const MODELS_MAX_IDS: usize = 5000;
const MODEL_ID_MAX: usize = 200;

/// The body of an answer, at most `max` bytes; None when it is longer (the rest is not read and the connection is dropped with `resp`).
async fn read_limited(mut resp: reqwest::Response, max: usize) -> Result<Option<Vec<u8>>, reqwest::Error> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if buf.len() + chunk.len() > max {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(Some(buf))
}

/// The model ids of a list answer: the first of `data`, `models` or the body itself that is an array; per item a string as it is, or the first non-empty string of
/// `id`, `name`, `model`, `model_name` of an object; trimmed; an empty id, one over 200 characters or with a control character is dropped; sorted, unique, at most 5,000.
/// (OpenAI and Anthropic `data[].id`, Ollama `models[].name`, LiteLLM `data[].model_name`, Google `models[].name`, bare arrays.)
fn models_from(body: &serde_json::Value) -> Vec<String> {
    let items = body["data"].as_array().or_else(|| body["models"].as_array()).or_else(|| body.as_array());
    let mut ids: Vec<String> = items
        .map(|a| {
            a.iter()
                .filter_map(|m| match m {
                    serde_json::Value::String(s) => Some(s.as_str()),
                    serde_json::Value::Object(_) => ["id", "name", "model", "model_name"].iter().find_map(|k| m[*k].as_str().filter(|s| !s.trim().is_empty())),
                    _ => None,
                })
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s.chars().count() <= MODEL_ID_MAX && !s.chars().any(char::is_control))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids.truncate(MODELS_MAX_IDS);
    ids
}

/// The model ids the endpoint offers (sorted, unique): `GET {Base URL}/models`, or the list URL of the settings (W8.11).
/// - The key goes as `Authorization: Bearer` only when there is one AND the list is on the Base URL's server (an empty list URL always is) or `key_origin` is the list's origin.
/// - A redirect is followed only on the list's own server (at most 5 hops, the key kept); any other ends with `AI_MODELS_REDIRECT`: nothing was sent to the other server.
/// - The status is read first (`AI_HTTP`), at most 8 MB are read, an answer that is not JSON is `AI_BAD_RESPONSE`.
pub async fn list_models(endpoint: &str, key: &str, models_url: &str, key_origin: &str) -> R<Vec<String>> {
    let url = match resolve_models_url(endpoint, models_url) {
        ModelsUrl::None => return Ok(vec![]),
        ModelsUrl::Invalid => return Err(models_url_bad()),
        ModelsUrl::Url(u) => u,
    };
    let list_origin = origin_of(&url);
    let same_server = models_url.trim().is_empty() || (list_origin.is_some() && list_origin == origin_of(endpoint.trim().trim_end_matches('/')));
    let allowed = !key_origin.trim().is_empty() && list_origin.as_deref() == Some(key_origin.trim());
    let send_key = !key.is_empty() && (same_server || allowed);
    let first = list_origin.clone().unwrap_or_default();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > MODELS_MAX_HOPS || attempt.url().origin().ascii_serialization() != first {
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).redirect(policy).build().map_err(net_error)?;
    let mut req = client.get(url);
    if send_key {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(net_error)?;
    let status = resp.status();
    if status.is_redirection() {
        // (stopped by the policy above: another server, or too many hops)
        let target = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|l| resp.url().join(l).ok())
            .and_then(|u| u.host_str().map(|h| u.port().map_or_else(|| h.to_string(), |p| format!("{h}:{p}"))));
        if let Some(host) = target {
            return Err(models_redirect(&host));
        }
    }
    if !status.is_success() {
        let body = read_limited(resp, MODELS_ERROR_BODY_MAX).await.ok().flatten().unwrap_or_default();
        return Err(http_error(status.as_u16(), &String::from_utf8_lossy(&body), key));
    }
    let Some(bytes) = read_limited(resp, MODELS_BODY_MAX).await.map_err(net_error)? else { return Err(bad_response()) };
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| bad_response())?;
    Ok(models_from(&body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    /// An endpoint that takes the request and never answers ends with the coded timeout, not with a request that waits for ever.
    #[test]
    fn a_silent_endpoint_ends_with_the_coded_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let holder = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf);
            std::thread::sleep(std::time::Duration::from_secs(3)); // longer than the 1 s allowed below
        });
        let started = std::time::Instant::now();
        let r = tauri::async_runtime::block_on(complete_within(&format!("http://127.0.0.1:{port}"), "", "m", "s", "p", 1));
        let e = r.unwrap_err();
        assert!(e.starts_with("AI_TIMEOUT|secs=1: "), "{e}");
        assert!(started.elapsed().as_secs() < 3, "gave up after the timeout, not after the server");
        holder.join().unwrap();
    }

    /// A server that takes the request and then waits: reports (on the channel) that the request arrived, then whether the client closed
    /// the connection ("closed") or the connection was still open after `wait` ("answered": a late answer is sent).
    fn slow_server(wait: std::time::Duration) -> (u16, std::sync::mpsc::Receiver<&'static str>, std::thread::JoinHandle<()>) {
        use std::io::Write;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        let h = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = sock.read(&mut buf);
            tx.send("request").unwrap();
            sock.set_read_timeout(Some(wait)).unwrap();
            // read() returns 0 (or fails) as soon as the client has closed the connection; a timeout means it is still open
            match sock.read(&mut buf) {
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                    let body = r#"{"choices":[{"message":{"content":"late"}}]}"#;
                    let _ = write!(sock, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                    tx.send("answered").unwrap();
                }
                _ => tx.send("closed").unwrap(),
            }
        });
        (port, rx, h)
    }

    /// Cancel drops the request: the call ends at once with AI_CANCELLED, the provider's connection is closed (the server sees it, so a
    /// late answer has nowhere to go) and the job is unregistered.
    #[test]
    fn a_cancelled_call_drops_the_connection_and_ends_at_once() {
        use std::time::Duration;
        let (port, seen, server) = slow_server(Duration::from_secs(5));
        let ep = format!("http://127.0.0.1:{port}");
        let started = std::time::Instant::now();
        let call = tauri::async_runtime::spawn(async move { complete_job(&ep, "", "m", "s", "p", 30, Some("job-cancel-1")).await });
        assert_eq!(seen.recv_timeout(Duration::from_secs(5)), Ok("request"), "the request reached the server");
        cancel("job-cancel-1");
        let r = tauri::async_runtime::block_on(call).unwrap();
        assert_eq!(r.unwrap_err(), CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(3), "ended at once, not after the 30 s timeout or the server's answer");
        assert_eq!(seen.recv_timeout(Duration::from_secs(3)), Ok("closed"), "the server saw the connection close");
        server.join().unwrap();
        assert!(!jobs_lock().live.contains_key("job-cancel-1"), "the job is unregistered");
    }

    /// Every feature that asks the model cancels the same way, by the id of its request (src/aiCall.ts `aiCallId`, src/translateJobs.ts
    /// `aiJobId`): Summarize, Write with AI, and each part of a translation (and the automatic second try of a part, `.1`). The request is
    /// dropped (the provider's connection closes), the call ends at once with AI_CANCELLED and the job is unregistered.
    #[test]
    fn summarize_write_and_translation_parts_are_cancelled_like_any_call() {
        use std::time::Duration;
        for id in ["summarize-k3j9x2-1", "write-k3j9x2-2", "translate-k3j9x2-7-3", "translate-k3j9x2-7-3.1"] {
            let (port, seen, server) = slow_server(Duration::from_secs(5));
            let ep = format!("http://127.0.0.1:{port}");
            let started = std::time::Instant::now();
            let call = tauri::async_runtime::spawn(async move { complete_job(&ep, "", "m", "s", "p", 30, Some(id)).await });
            assert_eq!(seen.recv_timeout(Duration::from_secs(5)), Ok("request"), "{id}: the request reached the server");
            cancel(id);
            assert_eq!(tauri::async_runtime::block_on(call).unwrap().unwrap_err(), CANCELLED, "{id}");
            assert!(started.elapsed() < Duration::from_secs(3), "{id}: ended at once");
            assert_eq!(seen.recv_timeout(Duration::from_secs(3)), Ok("closed"), "{id}: the server saw the connection close");
            server.join().unwrap();
            assert!(!jobs_lock().live.contains_key(id), "{id}: unregistered");
        }
    }

    /// The UI drops a request that timed out on its side and then asks again under a new id: the first id's cancel (which arrives after
    /// that request ended, so it is only remembered) must not stop the second try, nor the next part of the translation.
    #[test]
    fn a_late_cancel_of_one_request_does_not_stop_the_next_try_or_part() {
        use std::io::Write;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for word in ["eins", "zwei"] {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = [0u8; 8192];
                let _ = sock.read(&mut buf);
                let body = format!(r#"{{"choices":[{{"message":{{"content":"{word}"}}}}]}}"#);
                let _ = write!(sock, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            }
        });
        let ep = format!("http://127.0.0.1:{port}");
        cancel("translate-late-1-0"); // the first try is over already: remembered, nothing to stop
        let r = tauri::async_runtime::block_on(complete_job(&ep, "", "m", "s", "p", 5, Some("translate-late-1-0.1")));
        assert_eq!(r.unwrap(), "eins", "the second try (own id) runs");
        let r = tauri::async_runtime::block_on(complete_job(&ep, "", "m", "s", "p", 5, Some("translate-late-1-1")));
        assert_eq!(r.unwrap(), "zwei", "the next part runs");
        server.join().unwrap();
    }

    /// A cancel that arrives before its call registered (the request overtaken) still ends the call, without any request.
    #[test]
    fn a_cancel_that_came_first_ends_the_call_without_a_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        cancel("job-early-1");
        let r = tauri::async_runtime::block_on(complete_job(&format!("http://127.0.0.1:{port}"), "", "m", "s", "p", 5, Some("job-early-1")));
        assert_eq!(r.unwrap_err(), CANCELLED);
        assert!(listener.accept().is_err(), "no connection was made");
        assert!(jobs_lock().early.iter().all(|e| e != "job-early-1"), "the early cancel is used up");
    }

    /// Cancelling another job (or one nobody knows) leaves a running call alone; a call without a job id is not cancellable at all.
    #[test]
    fn cancelling_another_job_leaves_a_call_alone() {
        use std::io::Write;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = sock.read(&mut buf);
            std::thread::sleep(std::time::Duration::from_millis(400));
            let body = r#"{"choices":[{"message":{"content":" Hallo "}}]}"#;
            let _ = write!(sock, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        });
        let ep = format!("http://127.0.0.1:{port}");
        let call = tauri::async_runtime::spawn(async move { complete_job(&ep, "", "m", "s", "p", 5, Some("job-keep-1")).await });
        std::thread::sleep(std::time::Duration::from_millis(100));
        cancel("job-other-9");
        assert_eq!(tauri::async_runtime::block_on(call).unwrap().unwrap(), "Hallo");
        server.join().unwrap();
    }

    #[test]
    fn early_cancels_are_remembered_only_up_to_a_limit() {
        let mut j = Jobs::default();
        for i in 0..(EARLY_MAX + 10) {
            j.note_early(&format!("job-{i}"));
        }
        assert_eq!(j.early.len(), EARLY_MAX);
        assert!(j.early.iter().any(|e| e == &format!("job-{}", EARLY_MAX + 9)), "the newest is kept");
        assert!(!j.early.iter().any(|e| e == "job-0"), "the oldest went");
    }

    #[test]
    fn provider_errors_become_a_short_coded_message() {
        let e = http_error(500, r#"{"error":{"message":"The model is overloaded.","type":"server_error","code":null}}"#, "sk-secret-key-123");
        assert_eq!(e, "AI_HTTP|status=500|detail=The model is overloaded.: The AI Assistant returned an error (500): The model is overloaded.");
        // other common shapes
        assert_eq!(provider_message(r#"{"error":"Model not found"}"#, "").as_deref(), Some("Model not found"));
        assert_eq!(provider_message(r#"{"message":"Rate limit reached"}"#, "").as_deref(), Some("Rate limit reached"));
        assert_eq!(provider_message(r#"{"detail":"Not authenticated"}"#, "").as_deref(), Some("Not authenticated"));
        assert_eq!(provider_message(r#"[{"error":{"message":"Bad request","status":"INVALID_ARGUMENT"}}]"#, "").as_deref(), Some("Bad request"));
        assert_eq!(provider_message("upstream connect error\n or disconnect", "").as_deref(), Some("upstream connect error or disconnect"));
    }

    #[test]
    fn an_unreadable_answer_has_no_detail_and_never_raw_json() {
        for body in ["", "   ", "<html><body>502 Bad Gateway</body></html>", r#"{"error":{"code":500}}"#, r#"{"error":"{\"nested\":1}"}"#, "{broken json"] {
            assert_eq!(provider_message(body, ""), None, "{body}");
        }
        let e = http_error(502, "<html>x</html>", "");
        assert_eq!(e, "AI_HTTP|v=plain|status=502: The AI Assistant returned an error (502).");
        assert!(!e.contains('{') && !e.contains("html"));
    }

    #[test]
    fn the_message_is_cut_and_never_shows_the_key() {
        let long = format!(r#"{{"error":{{"message":"{}"}}}}"#, "word ".repeat(100));
        let d = provider_message(&long, "").unwrap();
        assert!(d.chars().count() <= DETAIL_MAX && d.ends_with('…'), "{d}");
        let key = "sk-abcdef1234567890";
        let d = provider_message(&format!(r#"{{"error":{{"message":"Incorrect API key provided: {key}. Use Bearer abc123 instead sk-proj-xyz"}}}}"#), key).unwrap();
        assert!(!d.contains("abcdef") && !d.contains("abc123") && !d.contains("xyz"), "{d}");
        assert_eq!(d, "Incorrect API key provided: …. Use Bearer … instead …");
        // the coded text keeps the separators of the format intact
        let e = http_error(400, r#"{"error":{"message":"a|b: c%d"}}"#, "");
        assert!(e.starts_with("AI_HTTP|status=400|detail=a%7Cb%3A c%25d: "), "{e}");
    }

    /// End to end: a 500 with a JSON body from a local endpoint reaches the caller as the short coded error.
    #[test]
    fn an_error_answer_from_the_endpoint_is_the_short_coded_error() {
        use std::io::Write;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = sock.read(&mut buf);
            let body = r#"{"error":{"message":"Model overloaded, try later","type":"server_error"}}"#;
            let _ = write!(sock, "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        });
        let r = tauri::async_runtime::block_on(complete_within(&format!("http://127.0.0.1:{port}"), "sk-test-key-0000", "m", "s", "p", 5));
        assert_eq!(r.unwrap_err(), "AI_HTTP|status=500|detail=Model overloaded, try later: The AI Assistant returned an error (500): Model overloaded, try later");
        server.join().unwrap();
    }

    /// An answer that is not what a chat completion looks like never reaches the person as the provider's JSON.
    #[test]
    fn an_unusable_answer_is_a_short_coded_error_and_never_the_raw_json() {
        let bad = "AI_BAD_RESPONSE: The AI Assistant sent an answer the app can’t read.";
        for body in [
            r#"{"choices":[]}"#,
            r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_1"}]}}]}"#,
            r#"{"choices":[{"message":{"content":[{"type":"text","text":"hi"}]}}]}"#,
            r#"{"id":"x","error":{"message":"odd"},"usage":{"total_tokens":12}}"#,
            "<html>gateway page</html>",
            "",
            "not json at all",
            "[1,2",
        ] {
            let e = reply_text(body).unwrap_err();
            assert_eq!(e, bad, "{body}");
            assert!(!e.contains('{') && !e.contains("choices") && !e.contains("tool_calls") && !e.contains("gateway"), "{e}");
        }
        assert_eq!(reply_text(r#"{"choices":[{"message":{"content":"  Hallo\n"}}]}"#).unwrap(), "Hallo");
    }

    /// Every error a call can end with is free of the API key and of anything that looks like raw JSON: a refused key echoed by the
    /// provider, an answer that is not JSON, a connection that fails (reqwest names the URL, which may carry a password), a timeout, a cancel.
    #[test]
    fn no_error_of_a_call_shows_the_key_or_raw_json() {
        use std::io::Write;
        let key = "sk-live-0123456789abcdef";
        let leaks = |e: &str, what: &str| {
            assert!(!e.contains(key) && !e.contains("0123456789"), "{what}: the key is in {e}");
            assert!(!e.contains('{') && !e.contains("\"error\"") && !e.contains("\"choices\""), "{what}: raw JSON in {e}");
        };
        // 1. the provider refuses and echoes the key in its JSON
        for body in [
            format!(r#"{{"error":{{"message":"Incorrect API key provided: {key}.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}}}"#),
            format!(r#"{{"message":"Bearer {key} is not allowed"}}"#),
            format!("Unauthorized: {key}"),
            format!(r#"{{"error":"{{\"nested\":\"{key}\"}}"}}"#),
            format!(r#"["{key}"]"#),
        ] {
            leaks(&http_error(401, &body, key), &body);
        }
        // 2. a 200 whose body is not a chat completion, and one that quotes the key
        leaks(&reply_text(&format!(r#"{{"error":"{key}"}}"#)).unwrap_err(), "200 without text");
        // 3. the connection fails: nobody listens; the endpoint of the setting carries a password and a token that must not come back
        let ep = "http://person:hunter2pw@127.0.0.1:1/v1?token=qrst9876";
        let e = tauri::async_runtime::block_on(complete_within(ep, key, "m", "s", "p", 5)).unwrap_err();
        leaks(&e, "connection refused");
        assert!(!e.contains("hunter2pw") && !e.contains("qrst9876"), "the endpoint's secrets are in {e}");
        // 4. an answer that is not JSON at all, from a real endpoint
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = sock.read(&mut buf);
            let body = "<html><body>welcome, this is the login page of the gateway</body></html>";
            let _ = write!(sock, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        });
        let e = tauri::async_runtime::block_on(complete_within(&format!("http://127.0.0.1:{port}"), key, "m", "s", "p", 5)).unwrap_err();
        server.join().unwrap();
        leaks(&e, "html answer");
        assert!(e.starts_with("AI_BAD_RESPONSE: ") && !e.contains("login page"), "{e}");
        // 5. the coded timeout and the cancel carry nothing of the request
        leaks(&timed_out(180), "timeout");
        leaks(CANCELLED, "cancel");
    }

    #[test]
    fn an_unconfigured_assistant_is_said_so_before_any_request() {
        let r = tauri::async_runtime::block_on(complete_within("", "", "", "s", "p", 1));
        assert!(r.unwrap_err().starts_with("AI_NOT_CONFIGURED: "));
    }

    // ---------------------------------------------------------------------------------------------------------------- model list URL (W8.11)

    /// What a local test server answers: status, extra headers, body (the body is cut to the Content-Length the client is told).
    struct Answer {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        /// tell the client this many bytes and send them (for an answer larger than the app reads); 0 = the length of `body`
        length: usize,
    }

    fn answer(status: u16, body: &str) -> Answer {
        Answer { status, headers: vec![("Content-Type".into(), "application/json".into())], body: body.as_bytes().to_vec(), length: 0 }
    }

    fn redirect(to: &str) -> Answer {
        Answer { status: 302, headers: vec![("Location".into(), to.to_string())], body: vec![], length: 0 }
    }

    /// A local HTTP server: every request line (target) and whether it had an Authorization header is recorded, \`route\` answers per target. It never ends (a thread of the test run).
    struct Server {
        port: u16,
        seen: std::sync::Arc<std::sync::Mutex<Vec<(String, bool)>>>,
    }

    impl Server {
        fn start(route: impl Fn(&str) -> Answer + Send + Sync + 'static) -> Server {
            use std::io::Write;
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen: std::sync::Arc<std::sync::Mutex<Vec<(String, bool)>>> = Default::default();
            let log = seen.clone();
            let route = std::sync::Arc::new(route);
            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    let Ok(mut sock) = conn else { continue };
                    let (log, route) = (log.clone(), route.clone());
                    std::thread::spawn(move || {
                        let mut head = Vec::new();
                        let mut buf = [0u8; 2048];
                        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                            match sock.read(&mut buf) {
                                Ok(0) | Err(_) => return,
                                Ok(n) => head.extend_from_slice(&buf[..n]),
                            }
                        }
                        let text = String::from_utf8_lossy(&head).to_string();
                        let target = text.lines().next().unwrap_or("").split(' ').nth(1).unwrap_or("").to_string();
                        let auth = text.lines().any(|l| l.to_ascii_lowercase().starts_with("authorization:"));
                        log.lock().unwrap().push((target.clone(), auth));
                        let a = route(&target);
                        let len = if a.length > 0 { a.length } else { a.body.len() };
                        let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", a.status, len).into_bytes();
                        for (k, v) in &a.headers {
                            out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
                        }
                        out.extend_from_slice(b"\r\n");
                        if sock.write_all(&out).is_err() {
                            return;
                        }
                        if a.length > a.body.len() {
                            // (more than the app reads: stream until it hangs up)
                            let chunk = vec![b' '; 64 * 1024];
                            let mut sent = 0;
                            let _ = sock.write_all(&a.body);
                            while sent < a.length - a.body.len() && sock.write_all(&chunk).is_ok() {
                                sent += chunk.len();
                            }
                        } else {
                            let _ = sock.write_all(&a.body);
                        }
                    });
                }
            });
            Server { port, seen }
        }
        fn base(&self) -> String {
            format!("http://127.0.0.1:{}/v1", self.port)
        }
        fn origin(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
        fn log(&self) -> Vec<(String, bool)> {
            self.seen.lock().unwrap().clone()
        }
    }

    fn list(base: &str, key: &str, url: &str, origin: &str) -> R<Vec<String>> {
        tauri::async_runtime::block_on(list_models(base, key, url, origin))
    }

    #[test]
    fn models_url_is_resolved_like_the_settings_tab() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../scripts/fixtures/ai-models-url/cases.json")).unwrap();
        let cases = cases["cases"].as_array().unwrap();
        assert!(cases.len() >= 30);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let base = c["base"].as_str().unwrap();
            let value = match c["valueLen"].as_u64() {
                Some(n) => format!("/{}", "a".repeat(n as usize - 1)),
                None => c["value"].as_str().unwrap().to_string(),
            };
            let want = match c["result"].as_str().unwrap() {
                "none" => ModelsUrl::None,
                "invalid" => ModelsUrl::Invalid,
                "long" => ModelsUrl::Url(format!("https://x.test/{}", "a".repeat(c["valueLen"].as_u64().unwrap() as usize - 1))),
                u => ModelsUrl::Url(u.to_string()),
            };
            let got = resolve_models_url(base, &value);
            assert_eq!(got, want, "{name}");
            if let (Some(o), ModelsUrl::Url(u)) = (c["origin"].as_str(), &got) {
                assert_eq!(origin_of(u).as_deref(), Some(o), "{name}: origin");
            }
        }
    }

    #[test]
    fn models_list_reads_every_known_answer_shape() {
        let shapes = |body: &str| models_from(&serde_json::from_str(body).unwrap());
        assert_eq!(shapes(r#"{"object":"list","data":[{"id":"qa-stub-model"},{"id":"qa-stub-model-2"}]}"#), ["qa-stub-model", "qa-stub-model-2"], "OpenAI data[].id");
        assert_eq!(shapes(r#"{"models":[{"name":"llama3.2:latest"},{"name":"qwen2.5:7b"}]}"#), ["llama3.2:latest", "qwen2.5:7b"], "Ollama models[].name");
        assert_eq!(shapes(r#"{"data":[{"model_name":"litellm-gpt"},{"model_name":"litellm-claude"}]}"#), ["litellm-claude", "litellm-gpt"], "LiteLLM data[].model_name, sorted");
        assert_eq!(shapes(r#"{"models":[{"name":"models/gemini-1.5-pro"}]}"#), ["models/gemini-1.5-pro"], "Google: no prefix is removed");
        assert_eq!(shapes(r#"{"models":["a","b"]}"#), ["a", "b"], "models[] as strings");
        assert_eq!(shapes(r#"["str-a","str-b","str-a"," "]"#), ["str-a", "str-b"], "a bare array: duplicates and blanks go");
        assert_eq!(shapes(r#"{"data":[{"id":"ok-1"},{"foo":1},42,null,{"id":""},{"id":"x\u0007y"},{"name":"ok-2"}]}"#), ["ok-1", "ok-2"], "AC-8.11.9 /mixed");
        assert_eq!(shapes(r#"{"data":[{"id":"","name":"second"},{"id":"  trimmed  "},{"model":"third"}]}"#), ["second", "third", "trimmed"], "the first non-empty of id, name, model, model_name; trimmed");
        assert!(shapes("{}").is_empty() && shapes(r#"{"data":[]}"#).is_empty() && shapes(r#"{"data":{}}"#).is_empty() && shapes("null").is_empty(), "no list: empty");
        let long = "x".repeat(201);
        assert_eq!(shapes(&format!(r#"{{"data":[{{"id":"{long}"}},{{"id":"{}"}}]}}"#, "y".repeat(200))), ["y".repeat(200)], "an id over 200 characters is dropped, 200 stay");
        let many: Vec<String> = (0..6000).map(|i| format!(r#"{{"id":"m{i:05}"}}"#)).collect();
        let ids = shapes(&format!(r#"{{"data":[{}]}}"#, many.join(",")));
        assert_eq!(ids.len(), MODELS_MAX_IDS, "at most 5,000 ids");
        assert_eq!(ids[0], "m00000");
    }

    #[test]
    fn models_list_failures_are_coded_and_hide_the_key_and_query() {
        let srv = Server::start(|t| match t.split('?').next().unwrap() {
            "/v1/missing-json" => answer(404, r#"{"error":{"message":"no such route"}}"#),
            "/v1/missing-html" => Answer { status: 404, headers: vec![("Content-Type".into(), "text/html".into())], body: b"<html>Not found</html>".to_vec(), length: 0 },
            "/v1/html" => Answer { status: 200, headers: vec![("Content-Type".into(), "text/html".into())], body: b"<html>login</html>".to_vec(), length: 0 },
            "/v1/huge" => Answer { status: 200, headers: vec![], body: b"{\"data\":[".to_vec(), length: 9 * 1024 * 1024 },
            _ => answer(200, r#"{"data":[{"id":"ok"}]}"#),
        });
        let to = |p: &str| list(&srv.base(), "qa-key-1", &format!("{}{p}", srv.origin()), "");
        let e = to("/v1/missing-json").unwrap_err();
        assert_eq!(e, "AI_HTTP|status=404|detail=no such route: The AI Assistant returned an error (404): no such route", "the status first, with the provider's message");
        let e = to("/v1/missing-html").unwrap_err();
        assert_eq!(e, "AI_HTTP|v=plain|status=404: The AI Assistant returned an error (404).", "a 404 page is the status, not a decode error");
        let e = to("/v1/html").unwrap_err();
        assert!(e.starts_with("AI_BAD_RESPONSE: ") && !e.contains("login"), "200 with HTML: {e}");
        let started = std::time::Instant::now();
        let e = to("/v1/huge").unwrap_err();
        assert!(e.starts_with("AI_BAD_RESPONSE: "), "more than 8 MB: {e}");
        assert!(started.elapsed().as_secs() < 10, "and it ends within the 10 s");
        assert_eq!(to("/v1/models").unwrap(), ["ok"], "an ordinary answer");
        // an invalid list URL makes no request and is the coded error
        let before = srv.log().len();
        for bad in ["models", "ftp://127.0.0.1/x", "//127.0.0.1/x", "javascript:alert(1)"] {
            assert_eq!(list(&srv.base(), "qa-key-1", bad, "").unwrap_err(), models_url_bad(), "{bad}");
        }
        assert_eq!(srv.log().len(), before, "no request for an invalid URL");
        // a nothing-listens address with ?key=SECRET in the URL: the text has neither the query nor the key
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let e = list("http://127.0.0.1:1/v1", "qa-key-1", &format!("http://127.0.0.1:{dead}/missing?key=SECRET-QA-123"), "").unwrap_err();
        assert!(!e.contains("SECRET-QA-123") && !e.contains("qa-key-1") && !e.contains("key="), "no query and no key in: {e}");
        assert!(e.contains(&format!("127.0.0.1:{dead}/missing")), "the address without its query is there: {e}");
        // a key echoed by the provider is hidden
        let echo = Server::start(|_| answer(401, r#"{"error":{"message":"Incorrect API key provided: qa-key-1."}}"#));
        let e = list(&echo.base(), "qa-key-1", "", "").unwrap_err();
        assert!(!e.contains("qa-key-1"), "the key is hidden: {e}");
    }

    #[test]
    fn models_list_sends_the_key_only_to_the_base_url_server_or_the_allowed_one() {
        let ok = |_: &str| answer(200, r#"{"data":[{"id":"m"}]}"#);
        let (a, b) = (Server::start(ok), Server::start(ok));
        let auth = |s: &Server| s.log().last().map(|l| l.1);
        // the list on the Base URL's server (an empty list URL, a path, an absolute URL): the key goes
        assert_eq!(list(&a.base(), "k", "", "").unwrap(), ["m"]);
        assert_eq!(auth(&a), Some(true), "empty list URL: Bearer present");
        list(&a.base(), "k", "/api/tags", "").unwrap();
        assert_eq!(a.log().last().unwrap(), &("/api/tags".to_string(), true), "a path on the Base URL's server: Bearer present");
        list(&a.base(), "k", &format!("{}/x?api-version=1", a.origin()), "").unwrap();
        assert_eq!(a.log().last().unwrap(), &("/x?api-version=1".to_string(), true), "an absolute URL on the same server: Bearer present");
        // on another server: not without the permission
        list(&a.base(), "k", &format!("{}/v1/models", b.origin()), "").unwrap();
        assert_eq!(auth(&b), Some(false), "another server without keyOrigin: no Authorization header");
        list(&a.base(), "k", &format!("{}/v1/models", b.origin()), &b.origin()).unwrap();
        assert_eq!(auth(&b), Some(true), "keyOrigin = that server's origin: present");
        list(&a.base(), "k", &format!("{}/v1/models", b.origin()), "http://127.0.0.1:9").unwrap();
        assert_eq!(auth(&b), Some(false), "keyOrigin of another server: absent");
        list(&a.base(), "k", &format!("{}/v1/models", b.origin()), &a.origin()).unwrap();
        assert_eq!(auth(&b), Some(false), "keyOrigin = the Base URL's own server does not open the other one");
        // no key: never
        list(&a.base(), "", "", "").unwrap();
        assert_eq!(auth(&a), Some(false), "an empty key: absent");
        list(&a.base(), "", &format!("{}/v1/models", b.origin()), &b.origin()).unwrap();
        assert_eq!(auth(&b), Some(false), "an empty key even for the allowed server");
        // localhost is not 127.0.0.1
        list(&a.base(), "k", &format!("http://localhost:{}/v1/models", b.port), "").ok();
        assert!(b.log().iter().rev().take(1).all(|l| !l.1), "localhost: another server");
    }

    #[test]
    fn models_list_never_follows_a_redirect_to_another_server() {
        let b = Server::start(|_| answer(200, r#"{"data":[{"id":"m"}]}"#));
        let target = format!("{}/v1/models", b.origin());
        let a = Server::start(move |t| if t.starts_with("/redirect-other") { redirect(&target) } else { answer(200, r#"{"data":[{"id":"m"}]}"#) });
        for key in ["k", ""] {
            let e = list(&a.base(), key, "/redirect-other", "").unwrap_err();
            assert_eq!(e, format!("AI_MODELS_REDIRECT|host=127.0.0.1%3A{}: Redirect to 127.0.0.1:{} was not followed", b.port, b.port), "with key {key:?}");
        }
        assert!(b.log().is_empty(), "the other server received nothing: {:?}", b.log());
        // also when the other server was allowed to get the key: a redirect is never followed to it
        let e = list(&a.base(), "k", "/redirect-other", &b.origin()).unwrap_err();
        assert!(e.starts_with("AI_MODELS_REDIRECT|host="), "{e}");
        assert!(b.log().is_empty(), "still nothing: {:?}", b.log());
    }

    #[test]
    fn models_list_follows_a_redirect_on_the_same_server_with_the_key() {
        let a = Server::start(|t| match t {
            "/redirect-same" => redirect("/v1/models"),
            t if t.starts_with("/hop/") => redirect(&format!("/hop/{}", t[5..].parse::<u32>().unwrap() + 1)),
            _ => answer(200, r#"{"data":[{"id":"after-redirect"}]}"#),
        });
        assert_eq!(list(&a.base(), "k", "/redirect-same", "").unwrap(), ["after-redirect"]);
        assert_eq!(a.log(), [("/redirect-same".to_string(), true), ("/v1/models".to_string(), true)], "both hops carry the key");
        let before = a.log().len();
        let e = list(&a.base(), "k", "/hop/0", "").unwrap_err();
        assert!(e.starts_with("AI_MODELS_REDIRECT|host=127.0.0.1"), "after 5 hops the request stops: {e}");
        assert_eq!(a.log().len() - before, 6, "the first request and five hops");
    }
}
