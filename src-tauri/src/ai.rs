use crate::db::{err, R};
use serde_json::json;

/// How long one completion may take before it is given up. A long email on a slow model can need a minute or two; the UI waits a little
/// longer than this (src/translateJobs.ts TRANSLATE_TIMEOUT_MS) so that this coded error is the one the person sees.
pub const COMPLETE_TIMEOUT_SECS: u64 = 180;

/// OpenAI-compatible chat completion. Works with any endpoint (OpenAI, local, gateways).
pub async fn complete(endpoint: &str, key: &str, model: &str, system: &str, prompt: &str) -> R<String> {
    complete_within(endpoint, key, model, system, prompt, COMPLETE_TIMEOUT_SECS).await
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
    let body: serde_json::Value = resp.json().await.map_err(|e| if e.is_timeout() { timed_out(secs) } else { err(e) })?;
    if !status.is_success() {
        return Err(format!("AI error {status}: {body}"));
    }
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("unexpected AI response: {body}"))
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

    #[test]
    fn an_unconfigured_assistant_is_said_so_before_any_request() {
        let r = tauri::async_runtime::block_on(complete_within("", "", "", "s", "p", 1));
        assert!(r.unwrap_err().starts_with("AI_NOT_CONFIGURED: "));
    }
}
