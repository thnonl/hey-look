use crate::db::{err, R};
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(secs)).build().map_err(err)?;
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
    let resp = req.send().await.map_err(|e| if e.is_timeout() { timed_out(secs) } else { err(e) })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| if e.is_timeout() { timed_out(secs) } else { err(e) })?;
    if !status.is_success() {
        return Err(http_error(status.as_u16(), &text, key));
    }
    let body: serde_json::Value = serde_json::from_str(&text).map_err(err)?;
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("unexpected AI response: {body}"))
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

/// OpenAI-compatible `GET {endpoint}/models`: the model ids the endpoint offers (sorted, unique).
pub async fn list_models(endpoint: &str, key: &str) -> R<Vec<String>> {
    if endpoint.trim().is_empty() {
        return Ok(vec![]);
    }
    let url = format!("{}/models", endpoint.trim().trim_end_matches('/'));
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().map_err(err)?;
    let mut req = client.get(url);
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(err)?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(err)?;
    if !status.is_success() {
        return Err(format!("Models request failed ({status})"));
    }
    // OpenAI: {"data":[{"id":..}]}; some gateways return a bare array or {"models":[..]}
    let items = body["data"].as_array().or_else(|| body["models"].as_array()).or_else(|| body.as_array());
    let mut ids: Vec<String> = items
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()).or_else(|| m.as_str()).map(String::from)).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
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

    #[test]
    fn an_unconfigured_assistant_is_said_so_before_any_request() {
        let r = tauri::async_runtime::block_on(complete_within("", "", "", "s", "p", 1));
        assert!(r.unwrap_err().starts_with("AI_NOT_CONFIGURED: "));
    }
}
