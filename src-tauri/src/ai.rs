use crate::db::{err, R};
use serde_json::json;

/// OpenAI-compatible chat completion. Works with any endpoint (OpenAI, local, gateways).
pub async fn complete(endpoint: &str, key: &str, model: &str, system: &str, prompt: &str) -> R<String> {
    if endpoint.trim().is_empty() || model.trim().is_empty() {
        return Err("AI not configured: set endpoint and model in Settings > AI".into());
    }
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let mut req = reqwest::Client::new().post(url).json(&json!({
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
    let resp = req.send().await.map_err(err)?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(err)?;
    if !status.is_success() {
        return Err(format!("AI error {status}: {body}"));
    }
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("unexpected AI response: {body}"))
}
