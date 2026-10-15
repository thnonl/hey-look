//! HTTP helpers every calendar provider shares: the client, the debug-only base-URL override, `Retry-After`, and the first
//! reading of an error status.
use super::SyncErr;
use std::time::Duration;

/// The base URL of a service. Debug builds and tests may redirect it with an environment variable (`HEYLOOK_GCAL_BASE`,
/// `HEYLOOK_GRAPH_BASE`, `HEYLOOK_TOKEN_BASE`) to a fake server; a release build ignores the variables, so it can never send a
/// token anywhere else.
pub fn base_url(env_key: &str, default: &str) -> String {
    #[cfg(debug_assertions)]
    {
        if let Some(v) = std::env::var(env_key).ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty()) {
            return v;
        }
    }
    let _ = env_key;
    default.to_string()
}

pub fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("HeyLook/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// A request that did not get an answer (no network, DNS, TLS, timeout, reset): the calendar shows what is saved here.
pub fn is_offline(e: &reqwest::Error) -> bool {
    !e.is_builder() && !e.is_decode()
}

pub fn send(req: reqwest::blocking::RequestBuilder) -> Result<reqwest::blocking::Response, SyncErr> {
    req.send().map_err(|e| if is_offline(&e) { SyncErr::Offline } else { SyncErr::Other(e.to_string()) })
}

/// `Retry-After`: a number of seconds, or an HTTP date.
pub fn retry_after(h: &reqwest::header::HeaderMap) -> Option<Duration> {
    let v = h.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(secs) = v.parse::<u64>() {
        return Some(Duration::from_secs(secs.min(24 * 3600)));
    }
    let at = chrono::DateTime::parse_from_rfc2822(v).ok()?.timestamp();
    Some(Duration::from_secs((at - chrono::Utc::now().timestamp()).clamp(0, 24 * 3600) as u64))
}

/// The status codes that mean the same everywhere. Providers look at the body first for the cases that differ (Google's 403
/// reasons, Graph's `syncStateNotFound`) and fall back to this.
pub fn status_err(status: u16, retry: Option<Duration>, body: &str) -> SyncErr {
    match status {
        401 => SyncErr::Auth,
        404 => SyncErr::NotFound,
        410 => SyncErr::Gone,
        412 => SyncErr::Conflict,
        429 | 500 | 502 | 503 | 504 => SyncErr::RateLimited(retry),
        s => SyncErr::Other(format!("HTTP {s}: {}", short(body))),
    }
}

/// The start of an error body, for a message.
pub fn short(body: &str) -> String {
    let t: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > 160 { format!("{}...", t.chars().take(160).collect::<String>()) } else { t }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};

    #[test]
    fn retry_after_reads_seconds_and_dates() {
        let mut h = HeaderMap::new();
        assert_eq!(retry_after(&h), None);
        h.insert(RETRY_AFTER, HeaderValue::from_static("120"));
        assert_eq!(retry_after(&h), Some(Duration::from_secs(120)));
        h.insert(RETRY_AFTER, HeaderValue::from_static("99999999"));
        assert_eq!(retry_after(&h), Some(Duration::from_secs(24 * 3600)));
        h.insert(RETRY_AFTER, HeaderValue::from_static("soon"));
        assert_eq!(retry_after(&h), None);
        let past = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc2822();
        h.insert(RETRY_AFTER, HeaderValue::from_str(&past).unwrap());
        assert_eq!(retry_after(&h), Some(Duration::from_secs(0)));
        let soon = (chrono::Utc::now() + chrono::Duration::seconds(90)).to_rfc2822();
        h.insert(RETRY_AFTER, HeaderValue::from_str(&soon).unwrap());
        let d = retry_after(&h).unwrap().as_secs();
        assert!((85..=91).contains(&d), "{d}");
    }

    #[test]
    fn statuses_map_the_same_way_everywhere() {
        let ra = Some(Duration::from_secs(7));
        assert_eq!(status_err(401, None, ""), SyncErr::Auth);
        assert_eq!(status_err(404, None, ""), SyncErr::NotFound);
        assert_eq!(status_err(410, None, ""), SyncErr::Gone);
        assert_eq!(status_err(412, None, ""), SyncErr::Conflict);
        assert_eq!(status_err(429, ra, ""), SyncErr::RateLimited(ra));
        assert_eq!(status_err(503, None, ""), SyncErr::RateLimited(None));
        assert!(matches!(status_err(418, None, "teapot"), SyncErr::Other(t) if t.contains("418") && t.contains("teapot")));
    }

    #[test]
    fn release_default_is_used_when_no_override() {
        assert_eq!(base_url("HEYLOOK_NO_SUCH_VARIABLE", "https://example.test"), "https://example.test");
    }

    #[test]
    fn short_collapses_and_cuts() {
        assert_eq!(short("a\n  b"), "a b");
        assert!(short(&"x".repeat(500)).ends_with("..."));
    }
}
