use crate::db::{err, R};
use serde_json::json;

/// OpenAI-compatible chat completion. Works with any endpoint (OpenAI, local, gateways).
pub async fn complete(endpoint: &str, key: &str, model: &str, system: &str, prompt: &str) -> R<String> {
    if endpoint.trim().is_empty() || model.trim().is_empty() {
        return Err("AI_NOT_CONFIGURED: AI not configured: set endpoint and model in Settings > AI".into());
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
