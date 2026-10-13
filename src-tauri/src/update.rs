//! "Check for updates": asks GitHub for the latest release of Hey Look!, compares it with the running
//! version and picks the installer for this system. Nothing is downloaded or run here; the UI opens the
//! returned link in the browser. Throttle state lives in the settings table (`update_last_check`,
//! `update_last_ok`, `update_cache`).
use crate::{db, lock, now, shell, AppState, Db};
use db::R;
use semver::{BuildMetadata, Version};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const API_BASE: &str = "https://api.github.com";
const LATEST_PATH: &str = "/repos/thnonl/hey-look/releases/latest";
const RELEASES_LATEST: &str = "https://github.com/thnonl/hey-look/releases/latest";
const NOTES_MAX_CHARS: usize = 4000;
const BODY_MAX_BYTES: usize = 2_000_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Automatic checks: at most every 6 h, every hour after a failed attempt.
const EVERY_SECS: i64 = 6 * 3600;
const RETRY_SECS: i64 = 3600;

// ---------- types ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Available,
    UpToDate,
    NoRelease,
    Offline,
    RateLimited,
    Error,
    /// internal: automatic checks are off
    Disabled,
    /// internal: not due yet (or another check is running)
    Throttled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub latest: String,
    pub notes: String,
    pub notes_truncated: bool,
    pub published_at: Option<i64>,
    pub release_url: String,
    pub asset: Option<Asset>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub os: String,
    pub arch: String,
    pub label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub kind: Kind,
    pub current: String,
    pub platform: Platform,
    /// last attempt (unix seconds)
    pub checked_at: Option<i64>,
    pub retry_at: Option<i64>,
    pub message: Option<String>,
    pub info: Option<UpdateInfo>,
    pub from_cache: bool,
    /// For `throttled`/`disabled` results that carry cached `info`: whether that cache says `available` or `upToDate`.
    pub cached_kind: Option<Kind>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Trigger {
    Startup,
    Shown,
    Manual,
}

impl Trigger {
    fn parse(s: &str) -> Option<Trigger> {
        match s {
            "startup" => Some(Trigger::Startup),
            "shown" => Some(Trigger::Shown),
            "manual" => Some(Trigger::Manual),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LinuxFmt {
    AppImage,
    Deb,
    Rpm,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

// ---------- pure helpers ----------

/// `v1.2.3`, `1.2` (= 1.2.0), `1` (= 1.0.0), `1.0.0-rc.1`. Build metadata is dropped (ignored for precedence).
/// More than 3 numeric parts, empty or non-numeric -> None.
pub fn parse_version(s: &str) -> Option<Version> {
    let t = s.trim();
    let t = t.strip_prefix(['v', 'V']).unwrap_or(t).trim();
    let split = t.find(['-', '+']).unwrap_or(t.len());
    let (core, rest) = t.split_at(split);
    let mut parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    while parts.len() < 3 {
        parts.push("0");
    }
    let mut v = Version::parse(&format!("{}{rest}", parts.join("."))).ok()?;
    v.build = BuildMetadata::EMPTY;
    Some(v)
}

pub fn linux_pref_from(os_release: Option<&str>, appimage_env: bool) -> LinuxFmt {
    if appimage_env {
        return LinuxFmt::AppImage;
    }
    let Some(text) = os_release else { return LinuxFmt::AppImage };
    let words = |key: &str| -> Vec<String> {
        text.lines()
            .filter_map(|l| l.trim().strip_prefix(key)?.strip_prefix('='))
            .flat_map(|v| {
                v.trim().trim_matches(|c| c == '"' || c == '\'').split_whitespace().map(|w| w.to_ascii_lowercase()).collect::<Vec<_>>()
            })
            .collect()
    };
    let mut all = words("ID");
    all.extend(words("ID_LIKE"));
    if all.iter().any(|w| w == "debian" || w == "ubuntu") {
        LinuxFmt::Deb
    } else if all.iter().any(|w| matches!(w.as_str(), "fedora" | "rhel" | "centos" | "suse" | "opensuse")) {
        LinuxFmt::Rpm
    } else {
        LinuxFmt::AppImage
    }
}

pub fn platform(os: &str, arch: &str, linux: LinuxFmt) -> Platform {
    let label = match os {
        "windows" => "Windows".to_string(),
        "macos" => "macOS".to_string(),
        "linux" => match linux {
            LinuxFmt::AppImage => "Linux (.AppImage)".to_string(),
            LinuxFmt::Deb => "Linux (.deb)".to_string(),
            LinuxFmt::Rpm => "Linux (.rpm)".to_string(),
        },
        other => other.to_string(),
    };
    let arch_label = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    Platform { os: os.to_string(), arch: arch_label.to_string(), label }
}

/// Parsed URL with the host rules shared by asset and release links: https, host github.com, no user info,
/// no explicit port, no query, no fragment. The raw text must not hide dot segments or backslashes.
fn github_url(raw: &str) -> Option<reqwest::Url> {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("%2e") || lower.contains('\\') || lower.contains("/../") || lower.contains("/./") || lower.ends_with("/..") || lower.ends_with("/.") {
        return None;
    }
    let u = reqwest::Url::parse(raw).ok()?;
    if u.scheme() != "https"
        || !u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("github.com"))
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return None;
    }
    Some(u)
}

fn clean_segments(u: &reqwest::Url) -> Option<Vec<String>> {
    let segs: Vec<String> = u.path_segments()?.map(String::from).collect();
    segs.iter().all(|s| !s.is_empty() && s != "." && s != "..").then_some(segs)
}

/// `https://github.com/thnonl/hey-look/releases/download/<tag>/<file>` and nothing else.
pub fn safe_asset_url(raw: &str) -> bool {
    let Some(u) = github_url(raw) else { return false };
    let Some(s) = clean_segments(&u) else { return false };
    s.len() == 6 && s[0] == "thnonl" && s[1] == "hey-look" && s[2] == "releases" && s[3] == "download"
}

/// The release page link from GitHub if it is on our repo, else the "latest release" page.
pub fn safe_release_url(raw: &str) -> String {
    if let Some(u) = github_url(raw) {
        if let Some(s) = clean_segments(&u) {
            if s.len() >= 3 && s[0] == "thnonl" && s[1] == "hey-look" && s[2] == "releases" {
                return raw.to_string();
            }
        }
    }
    RELEASES_LATEST.to_string()
}

#[derive(Clone, Copy, PartialEq)]
enum Ext {
    Setup,
    Msi,
    Dmg,
    AppImage,
    Deb,
    Rpm,
}

fn ext_of(lower: &str) -> Option<Ext> {
    if lower.ends_with("-setup.exe") || lower.ends_with("_setup.exe") {
        Some(Ext::Setup)
    } else if lower.ends_with(".msi") {
        Some(Ext::Msi)
    } else if lower.ends_with(".dmg") {
        Some(Ext::Dmg)
    } else if lower.ends_with(".appimage") {
        Some(Ext::AppImage)
    } else if lower.ends_with(".deb") {
        Some(Ext::Deb)
    } else if lower.ends_with(".rpm") {
        Some(Ext::Rpm)
    } else {
        None
    }
}

/// `token` between delimiters (`_`, `.`, `-`, start, end) so `x64` never matches inside `x86_64`.
fn has_token(lower: &str, token: &str) -> bool {
    let b = lower.as_bytes();
    let delim = |c: u8| matches!(c, b'_' | b'.' | b'-');
    lower.match_indices(token).any(|(i, _)| {
        (i == 0 || delim(b[i - 1])) && (i + token.len() == b.len() || delim(b[i + token.len()]))
    })
}

fn arch_tokens(arch: &str) -> &'static [&'static str] {
    match arch {
        "x86_64" => &["x64", "x86_64", "amd64"],
        "aarch64" => &["arm64", "aarch64"],
        _ => &[],
    }
}

/// The installer for this system, or None. `assets` are `(name, url, size)`; links that fail `safe_asset_url` are dropped first.
pub fn pick_asset(assets: &[Asset], os: &str, arch: &str, linux: LinuxFmt) -> Option<Asset> {
    let cands: Vec<(String, Ext, &Asset)> = assets
        .iter()
        .filter(|a| safe_asset_url(&a.url))
        .filter_map(|a| {
            let l = a.name.to_ascii_lowercase();
            ext_of(&l).map(|e| (l, e, a))
        })
        .collect();
    let find = |ext: Ext, tokens: &[&str]| {
        cands.iter().find(|(l, e, _)| *e == ext && tokens.iter().any(|t| has_token(l, t))).map(|(_, _, a)| (*a).clone())
    };
    let native = arch_tokens(arch);
    if native.is_empty() {
        return None;
    }
    match os {
        "windows" => {
            let mut sets: Vec<&[&str]> = vec![native];
            if arch == "aarch64" {
                sets.push(arch_tokens("x86_64"));
            }
            sets.iter().find_map(|t| find(Ext::Setup, t).or_else(|| find(Ext::Msi, t)))
        }
        "macos" => find(Ext::Dmg, native).or_else(|| find(Ext::Dmg, &["universal"])),
        "linux" => {
            let first = match linux {
                LinuxFmt::AppImage => Ext::AppImage,
                LinuxFmt::Deb => Ext::Deb,
                LinuxFmt::Rpm => Ext::Rpm,
            };
            [first, Ext::AppImage, Ext::Deb, Ext::Rpm].into_iter().find_map(|e| find(e, native))
        }
        _ => None,
    }
}

/// Automatic checks: every 6 h, every hour after a failure; a missing or future timestamp is due. Manual is always due.
pub fn due(trigger: Trigger, now: i64, last: Option<i64>, last_ok: bool) -> bool {
    if trigger == Trigger::Manual {
        return true;
    }
    match last {
        None => true,
        Some(l) if l > now => true,
        Some(l) => now - l >= if last_ok { EVERY_SECS } else { RETRY_SECS },
    }
}

/// First `max` characters (never splits a character) and whether anything was cut. CRLF becomes LF.
pub fn truncate_notes(s: &str, max: usize) -> (String, bool) {
    let s = s.replace("\r\n", "\n");
    match s.char_indices().nth(max) {
        Some((i, _)) => (s[..i].to_string(), true),
        None => (s, false),
    }
}

#[derive(Debug, PartialEq)]
enum Class {
    Ok,
    NotFound,
    RateLimited(i64),
    Error(String),
}

/// HTTP status + the rate limit headers -> what it means (REQ-14).
fn classify(status: u16, remaining: Option<&str>, reset: Option<&str>, retry_after: Option<&str>, now: i64) -> Class {
    let retry_at = || {
        reset
            .and_then(|v| v.trim().parse::<i64>().ok())
            .or_else(|| retry_after.and_then(|v| v.trim().parse::<i64>().ok()).map(|s| now + s))
            .unwrap_or(now + 60)
    };
    match status {
        200..=299 => Class::Ok,
        404 => Class::NotFound,
        429 => Class::RateLimited(retry_at()),
        403 if remaining.map(str::trim) == Some("0") || retry_after.is_some() => Class::RateLimited(retry_at()),
        s => Class::Error(format!("GitHub answered {s}")),
    }
}

/// The cached result if it is still true for the running version: same `current`, and `upToDate`
/// or an `available` that is still newer than the running version.
fn valid_cache(json: Option<&str>, current: &Version) -> Option<(Kind, UpdateInfo)> {
    #[derive(Deserialize)]
    struct Cache {
        current: String,
        kind: Kind,
        info: UpdateInfo,
    }
    let c: Cache = serde_json::from_str(json?).ok()?;
    if parse_version(&c.current)? != *current {
        return None;
    }
    let latest = parse_version(&c.info.latest)?;
    match c.kind {
        Kind::UpToDate => Some((Kind::UpToDate, c.info)),
        Kind::Available if latest > *current => Some((Kind::Available, c.info)),
        _ => None,
    }
}

// ---------- check ----------

#[derive(Clone)]
pub struct Ctx {
    pub base: String,
    pub now: i64,
    pub timeout: Duration,
    pub current: String,
    pub os: String,
    pub arch: String,
    pub linux: LinuxFmt,
}

impl Ctx {
    fn result(&self, kind: Kind, checked_at: Option<i64>) -> UpdateResult {
        UpdateResult {
            kind,
            current: self.current.clone(),
            platform: platform(&self.os, &self.arch, self.linux),
            checked_at,
            retry_at: None,
            message: None,
            info: None,
            from_cache: false,
            cached_kind: None,
        }
    }
}

/// Released on every exit path (also `?` returns and panics).
struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn try_busy(flag: &AtomicBool) -> Option<Busy<'_>> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| Busy(flag))
}

fn read_last_check(db: &Db) -> Option<i64> {
    let v = db::get_setting(&lock(db), "update_last_check")?;
    let n = v.trim().parse::<i64>().ok();
    if n.is_none() {
        eprintln!("update check: ignoring bad update_last_check {v:?}");
    }
    n
}

fn read_last_ok(db: &Db) -> bool {
    match db::get_setting(&lock(db), "update_last_ok").as_deref() {
        None | Some("1") => true,
        Some("0") => false,
        Some(v) => {
            eprintln!("update check: ignoring bad update_last_ok {v:?}");
            true
        }
    }
}

/// `throttled` / `disabled`: no request, carrying the cached info when it is still valid.
fn without_request(db: &Db, ctx: &Ctx, kind: Kind) -> UpdateResult {
    let mut r = ctx.result(kind, read_last_check(db));
    let cache = db::get_setting(&lock(db), "update_cache");
    if let Some(cur) = parse_version(&ctx.current) {
        if let Some((k, info)) = valid_cache(cache.as_deref(), &cur) {
            r.info = Some(info);
            r.cached_kind = Some(k);
            r.from_cache = true;
        }
    }
    r
}

enum Fetched {
    Body(String),
    NotFound,
    RateLimited(i64),
    Offline,
    Failed(String),
}

const UNEXPECTED: &str = "GitHub sent an unexpected answer";

async fn fetch(ctx: &Ctx) -> Fetched {
    let client = match reqwest::Client::builder().timeout(ctx.timeout).build() {
        Ok(c) => c,
        Err(e) => return Fetched::Failed(e.to_string()),
    };
    let resp = client
        .get(format!("{}{LATEST_PATH}", ctx.base))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", format!("HeyLook/{}", ctx.current))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) if e.is_builder() => return Fetched::Failed(UNEXPECTED.into()),
        Err(_) => return Fetched::Offline,
    };
    let h = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(String::from);
    let class = classify(
        resp.status().as_u16(),
        h("x-ratelimit-remaining").as_deref(),
        h("x-ratelimit-reset").as_deref(),
        h("retry-after").as_deref(),
        ctx.now,
    );
    match class {
        Class::NotFound => Fetched::NotFound,
        Class::RateLimited(at) => Fetched::RateLimited(at),
        Class::Error(m) => Fetched::Failed(m),
        Class::Ok => match resp.bytes().await {
            Ok(b) if b.len() <= BODY_MAX_BYTES => Fetched::Body(String::from_utf8_lossy(&b).into_owned()),
            Ok(_) => Fetched::Failed(UNEXPECTED.into()),
            Err(e) if e.is_timeout() || e.is_connect() => Fetched::Offline,
            Err(_) => Fetched::Failed(UNEXPECTED.into()),
        },
    }
}

/// GitHub's JSON -> `available` / `upToDate` / `error`.
fn interpret(ctx: &Ctx, body: &str) -> UpdateResult {
    let mut r = ctx.result(Kind::Error, Some(ctx.now));
    let Ok(rel) = serde_json::from_str::<GhRelease>(body) else {
        r.message = Some(UNEXPECTED.into());
        return r;
    };
    let (Some(latest), Some(current)) = (parse_version(&rel.tag_name), parse_version(&ctx.current)) else {
        let tag: String = rel.tag_name.chars().take(40).collect();
        r.message = Some(format!("couldn\u{2019}t read the latest version ({tag})"));
        return r;
    };
    let assets: Vec<Asset> =
        rel.assets.into_iter().map(|a| Asset { name: a.name, url: a.browser_download_url, size: a.size }).collect();
    let (notes, notes_truncated) = truncate_notes(rel.body.as_deref().unwrap_or(""), NOTES_MAX_CHARS);
    let published_at = rel
        .published_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp());
    r.info = Some(UpdateInfo {
        latest: latest.to_string(),
        notes,
        notes_truncated,
        published_at,
        release_url: safe_release_url(&rel.html_url),
        asset: pick_asset(&assets, &ctx.os, &ctx.arch, ctx.linux),
    });
    r.kind = if latest > current { Kind::Available } else { Kind::UpToDate };
    r
}

/// The whole check. `busy` is the in-flight guard, `ctx` carries the base URL and the clock (tests inject both).
pub async fn run_check(db: &Db, busy: &AtomicBool, ctx: &Ctx, trigger: Trigger) -> UpdateResult {
    let Some(_guard) = try_busy(busy) else { return without_request(db, ctx, Kind::Throttled) };
    let auto = trigger != Trigger::Manual;
    if auto && !shell::pbool(&shell::prefs(db), "checkUpdates", true) {
        return without_request(db, ctx, Kind::Disabled);
    }
    if !due(trigger, ctx.now, read_last_check(db), read_last_ok(db)) {
        return without_request(db, ctx, Kind::Throttled);
    }
    // the attempt is recorded before the request: a crash or a slow server must not cause a retry storm
    let _ = db::set_setting(&lock(db), "update_last_check", &ctx.now.to_string());

    let r = match fetch(ctx).await {
        Fetched::Body(b) => interpret(ctx, &b),
        Fetched::NotFound => ctx.result(Kind::NoRelease, Some(ctx.now)),
        Fetched::RateLimited(at) => {
            let mut r = ctx.result(Kind::RateLimited, Some(ctx.now));
            r.retry_at = Some(at);
            r
        }
        Fetched::Offline => ctx.result(Kind::Offline, Some(ctx.now)),
        Fetched::Failed(m) => {
            let mut r = ctx.result(Kind::Error, Some(ctx.now));
            r.message = Some(m);
            r
        }
    };
    let ok = matches!(r.kind, Kind::Available | Kind::UpToDate | Kind::NoRelease);
    let c = lock(db);
    let _ = db::set_setting(&c, "update_last_ok", if ok { "1" } else { "0" });
    if matches!(r.kind, Kind::Available | Kind::UpToDate) {
        if let Some(info) = &r.info {
            let cache = serde_json::json!({ "current": ctx.current, "kind": r.kind, "info": info });
            let _ = db::set_setting(&c, "update_cache", &cache.to_string());
        }
    }
    r
}

static BUSY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle, state: tauri::State<'_, AppState>, trigger: String) -> R<UpdateResult> {
    let trigger = Trigger::parse(&trigger).ok_or_else(|| format!("unknown trigger: {trigger}"))?;
    let os_release = if std::env::consts::OS == "linux" { std::fs::read_to_string("/etc/os-release").ok() } else { None };
    let ctx = Ctx {
        base: API_BASE.to_string(),
        now: now(),
        timeout: REQUEST_TIMEOUT,
        current: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        linux: linux_pref_from(os_release.as_deref(), std::env::var_os("APPIMAGE").is_some()),
    };
    Ok(run_check(&state.db, &BUSY, &ctx, trigger).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    // ---------- version ----------

    fn v(s: &str) -> Version {
        parse_version(s).unwrap_or_else(|| panic!("{s} should parse"))
    }

    #[test]
    fn version_order_and_forms() {
        assert!(v("1.0.0") < v("1.0.1"));
        assert!(v("1.0.9") < v("1.1.0"));
        assert_eq!(v("v1.2"), v("1.2.0"));
        assert_eq!(v("V1.2.3"), v("1.2.3"));
        assert_eq!(v("1"), v("1.0.0"));
        assert_eq!(v("1.2.3+build5"), v("1.2.3"));
        assert!(v("1.0.0-rc.1") < v("1.0.0"));
        assert_eq!(v(" v2.0.1 \n"), v("2.0.1"));
        assert_eq!(v("1.2.3+build5").to_string(), "1.2.3");
    }

    #[test]
    fn version_errors() {
        for bad in ["banana", "", "v", "1.2.3.4", "1..2", "a.b.c", "-1.0.0", "1.0.0-", "release-1", "1.x"] {
            assert!(parse_version(bad).is_none(), "{bad:?} should not parse");
        }
    }

    // ---------- URLs ----------

    const GOOD: &str = "https://github.com/thnonl/hey-look/releases/download/v1.0.0/HeyLook_1.0.0_windows_x64-setup.exe";

    #[test]
    fn asset_url_rules() {
        assert!(safe_asset_url(GOOD));
        assert!(safe_asset_url("https://GITHUB.com/thnonl/hey-look/releases/download/v1.0.0/x.exe"));
        for bad in [
            "https://evil.example/thnonl/hey-look/releases/download/v1/x.exe",
            "https://github.com/other/repo/releases/download/v1/x.exe",
            "http://github.com/thnonl/hey-look/releases/download/v1/x.exe",
            "https://github.com.evil.example/thnonl/hey-look/releases/download/v1/x.exe",
            "https://github.com@evil.example/thnonl/hey-look/releases/download/v1/x.exe",
            "https://user:pw@github.com/thnonl/hey-look/releases/download/v1/x.exe",
            "https://github.com:444/thnonl/hey-look/releases/download/v1/x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1/../../../x",
            "https://github.com/thnonl/hey-look/releases/download/v1/%2e%2e/x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1/%2E%2E/x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1/x.exe?a=b",
            "https://github.com/thnonl/hey-look/releases/download/v1/x.exe#f",
            "https://github.com/thnonl/hey-look/releases/download//x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1",
            "https://github.com/thnonl/hey-look/releases/download/v1/a/b",
            "https://github.com/thnonl/hey-look/archive/v1/x.exe",
            "https://github.com/thnonl\\hey-look/releases/download/v1/x.exe",
            "not a url",
            "",
        ] {
            assert!(!safe_asset_url(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn release_url_falls_back() {
        let ok = "https://github.com/thnonl/hey-look/releases/tag/v1.1.0";
        assert_eq!(safe_release_url(ok), ok);
        for bad in [
            "https://evil.example/thnonl/hey-look/releases/tag/v1",
            "https://github.com/other/repo/releases/tag/v1",
            "http://github.com/thnonl/hey-look/releases/tag/v1",
            "https://github.com/thnonl/hey-look/releases/tag/v1?x=1",
            "https://github.com/thnonl/hey-look/issues/1",
            "",
        ] {
            assert_eq!(safe_release_url(bad), RELEASES_LATEST, "{bad:?}");
        }
    }

    // ---------- asset pick ----------

    fn assets(names: &[&str]) -> Vec<Asset> {
        names
            .iter()
            .map(|n| Asset {
                name: n.to_string(),
                url: format!("https://github.com/thnonl/hey-look/releases/download/v1.0.0/{n}"),
                size: 1000,
            })
            .collect()
    }

    const CLEAN: &[&str] = &[
        "HeyLook_1.0.0_windows_x64-setup.exe",
        "HeyLook_1.0.0_windows_x64.msi",
        "HeyLook_1.0.0_darwin_universal.dmg",
        "HeyLook_1.0.0_darwin_universal.app.tar.gz",
        "HeyLook_1.0.0_linux_amd64.AppImage",
        "HeyLook_1.0.0_linux_amd64.deb",
        "HeyLook_1.0.0_linux_x86_64.rpm",
        "HeyLook_1.0.0_windows_x64-setup.exe.sig",
        "latest.json",
        "HeyLook_1.0.0_windows_x64.msi.zip",
        "HeyLook_1.0.0_x64.blockmap",
    ];
    const DEFAULT: &[&str] = &[
        "Hey.Look._1.0.0_x64-setup.exe",
        "Hey.Look._1.0.0_x64_en-US.msi",
        "Hey.Look._1.0.0_universal.dmg",
        "Hey.Look._1.0.0_universal.app.tar.gz",
        "Hey.Look._1.0.0_amd64.AppImage",
        "Hey.Look._1.0.0_amd64.deb",
        "Hey.Look.-1.0.0-1.x86_64.rpm",
        "Hey.Look._1.0.0_x64-setup.exe.sig",
        "latest.json",
        "Hey.Look._1.0.0_x64_en-US.msi.zip",
    ];

    fn pick(list: &[&str], os: &str, arch: &str, fmt: LinuxFmt) -> Option<String> {
        pick_asset(&assets(list), os, arch, fmt).map(|a| a.name)
    }

    fn both(os: &str, arch: &str, fmt: LinuxFmt, clean: Option<&str>, default: Option<&str>) {
        assert_eq!(pick(CLEAN, os, arch, fmt).as_deref(), clean, "clean names {os}/{arch}/{fmt:?}");
        assert_eq!(pick(DEFAULT, os, arch, fmt).as_deref(), default, "default names {os}/{arch}/{fmt:?}");
    }

    #[test]
    fn picks_per_platform() {
        use LinuxFmt::*;
        both("windows", "x86_64", AppImage, Some("HeyLook_1.0.0_windows_x64-setup.exe"), Some("Hey.Look._1.0.0_x64-setup.exe"));
        both("windows", "aarch64", AppImage, Some("HeyLook_1.0.0_windows_x64-setup.exe"), Some("Hey.Look._1.0.0_x64-setup.exe"));
        both("macos", "aarch64", AppImage, Some("HeyLook_1.0.0_darwin_universal.dmg"), Some("Hey.Look._1.0.0_universal.dmg"));
        both("macos", "x86_64", AppImage, Some("HeyLook_1.0.0_darwin_universal.dmg"), Some("Hey.Look._1.0.0_universal.dmg"));
        both("linux", "x86_64", Deb, Some("HeyLook_1.0.0_linux_amd64.deb"), Some("Hey.Look._1.0.0_amd64.deb"));
        both("linux", "x86_64", Rpm, Some("HeyLook_1.0.0_linux_x86_64.rpm"), Some("Hey.Look.-1.0.0-1.x86_64.rpm"));
        both("linux", "x86_64", AppImage, Some("HeyLook_1.0.0_linux_amd64.AppImage"), Some("Hey.Look._1.0.0_amd64.AppImage"));
        both("linux", "aarch64", AppImage, None, None);
        both("freebsd", "x86_64", AppImage, None, None);
    }

    #[test]
    fn msi_when_no_setup_exe() {
        let l = ["HeyLook_1.0.0_windows_x64.msi", "HeyLook_1.0.0_windows_x64-setup.exe.sig", "HeyLook_1.0.0_windows_x64.msi.zip"];
        assert_eq!(pick(&l, "windows", "x86_64", LinuxFmt::AppImage).as_deref(), Some("HeyLook_1.0.0_windows_x64.msi"));
        assert_eq!(pick(&["Hey.Look._1.0.0_x64_en-US.msi"], "windows", "x86_64", LinuxFmt::AppImage).as_deref(), Some("Hey.Look._1.0.0_x64_en-US.msi"));
    }

    #[test]
    fn never_picks_sidecar_files_and_ignores_case() {
        let l = ["HeyLook_1.0.0_darwin_universal.app.tar.gz", "latest.json", "x.zip", "x.blockmap", "x64.sig"];
        for os in ["windows", "macos", "linux"] {
            assert_eq!(pick(&l, os, "x86_64", LinuxFmt::AppImage), None);
        }
        assert_eq!(
            pick(&["HEYLOOK_1.0.0_LINUX_AMD64.APPIMAGE"], "linux", "x86_64", LinuxFmt::AppImage).as_deref(),
            Some("HEYLOOK_1.0.0_LINUX_AMD64.APPIMAGE")
        );
    }

    #[test]
    fn arch_tokens_are_delimited() {
        // "64" inside x86_64 / aarch64 must not satisfy x64, and aarch64 must not take an x64 file on macOS/Linux
        assert_eq!(pick(&["HeyLook_1.0.0_linux_x86_64.deb"], "linux", "x86_64", LinuxFmt::Deb).as_deref(), Some("HeyLook_1.0.0_linux_x86_64.deb"));
        assert_eq!(pick(&["HeyLook_1.0.0_linux_x86_64.deb"], "linux", "aarch64", LinuxFmt::Deb), None);
        assert_eq!(pick(&["HeyLook_1.0.0_linux_xx64y.deb"], "linux", "x86_64", LinuxFmt::Deb), None);
        assert_eq!(pick(&["HeyLook_1.0.0_darwin_aarch64.dmg", "HeyLook_1.0.0_darwin_universal.dmg"], "macos", "aarch64", LinuxFmt::AppImage).as_deref(), Some("HeyLook_1.0.0_darwin_aarch64.dmg"));
    }

    #[test]
    fn unsafe_asset_link_is_dropped() {
        let mut a = assets(&["HeyLook_1.0.0_windows_x64-setup.exe"]);
        a[0].url = "https://evil.example/HeyLook_1.0.0_windows_x64-setup.exe".into();
        assert_eq!(pick_asset(&a, "windows", "x86_64", LinuxFmt::AppImage), None);
    }

    #[test]
    fn linux_format_from_os_release() {
        use LinuxFmt::*;
        assert_eq!(linux_pref_from(Some("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n"), false), Deb);
        assert_eq!(linux_pref_from(Some("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"), false), Deb);
        assert_eq!(linux_pref_from(Some("ID=fedora\n"), false), Rpm);
        assert_eq!(linux_pref_from(Some("ID=\"opensuse-leap\"\nID_LIKE=\"suse opensuse\"\n"), false), Rpm);
        assert_eq!(linux_pref_from(Some("ID=rocky\nID_LIKE=\"rhel centos fedora\"\n"), false), Rpm);
        assert_eq!(linux_pref_from(Some("ID=arch\n"), false), AppImage);
        assert_eq!(linux_pref_from(Some("ID=debian-like-not\n"), false), AppImage);
        assert_eq!(linux_pref_from(None, false), AppImage);
        assert_eq!(linux_pref_from(Some("ID=ubuntu\n"), true), AppImage);
    }

    #[test]
    fn platform_labels() {
        assert_eq!(platform("windows", "x86_64", LinuxFmt::Deb), Platform { os: "windows".into(), arch: "x64".into(), label: "Windows".into() });
        assert_eq!(platform("macos", "aarch64", LinuxFmt::Deb).label, "macOS");
        assert_eq!(platform("macos", "aarch64", LinuxFmt::Deb).arch, "arm64");
        assert_eq!(platform("linux", "x86_64", LinuxFmt::Deb).label, "Linux (.deb)");
        assert_eq!(platform("linux", "aarch64", LinuxFmt::Rpm).label, "Linux (.rpm)");
        assert_eq!(platform("linux", "x86_64", LinuxFmt::AppImage).label, "Linux (.AppImage)");
    }

    // ---------- throttle, cache, notes ----------

    #[test]
    fn due_boundaries() {
        use Trigger::*;
        let now = 1_000_000;
        assert!(due(Manual, now, Some(now), true));
        for t in [Startup, Shown] {
            assert!(!due(t, now, Some(now - 3599), true));
            assert!(!due(t, now, Some(now - 3600), true));
            assert!(!due(t, now, Some(now - 21599), true));
            assert!(due(t, now, Some(now - 21600), true));
            // after a failed attempt: 1 h
            assert!(!due(t, now, Some(now - 3599), false));
            assert!(due(t, now, Some(now - 3600), false));
            // missing or in the future
            assert!(due(t, now, None, true));
            assert!(due(t, now, Some(now + 5), true));
        }
    }

    #[test]
    fn truncation_keeps_characters_whole() {
        assert_eq!(truncate_notes("abc", 4000), ("abc".into(), false));
        assert_eq!(truncate_notes("abc", 3), ("abc".into(), false));
        assert_eq!(truncate_notes("abcd", 3), ("abc".into(), true));
        let three = "\u{20AC}".repeat(10); // 3 bytes each
        assert_eq!(truncate_notes(&three, 4), ("\u{20AC}".repeat(4), true));
        let four = "\u{1F600}".repeat(10); // 4 bytes each
        assert_eq!(truncate_notes(&four, 4), ("\u{1F600}".repeat(4), true));
        let big = "x".repeat(5000);
        let (t, cut) = truncate_notes(&big, NOTES_MAX_CHARS);
        assert!(cut && t.chars().count() == 4000);
        assert_eq!(truncate_notes("a\r\nb", 10).0, "a\nb");
    }

    fn info(latest: &str) -> UpdateInfo {
        UpdateInfo { latest: latest.into(), notes: "n".into(), notes_truncated: false, published_at: Some(5), release_url: RELEASES_LATEST.into(), asset: None }
    }

    fn cache(current: &str, kind: Kind, latest: &str) -> String {
        serde_json::json!({ "current": current, "kind": kind, "info": info(latest) }).to_string()
    }

    #[test]
    fn cache_validity() {
        let cur = v("1.0.0");
        assert_eq!(valid_cache(Some(&cache("1.0.0", Kind::UpToDate, "1.0.0")), &cur).map(|c| c.0), Some(Kind::UpToDate));
        assert_eq!(valid_cache(Some(&cache("1.0.0", Kind::Available, "1.1.0")), &cur).map(|c| c.0), Some(Kind::Available));
        // update installed: the cache was made for another running version
        assert!(valid_cache(Some(&cache("0.9.0", Kind::Available, "1.0.0")), &cur).is_none());
        // available but no longer newer
        assert!(valid_cache(Some(&cache("1.0.0", Kind::Available, "1.0.0")), &cur).is_none());
        assert!(valid_cache(Some(&cache("1.0.0", Kind::Error, "1.1.0")), &cur).is_none());
        assert!(valid_cache(Some("not json"), &cur).is_none());
        assert!(valid_cache(Some("{}"), &cur).is_none());
        assert!(valid_cache(None, &cur).is_none());
    }

    #[test]
    fn http_mapping() {
        assert_eq!(classify(200, None, None, None, 100), Class::Ok);
        assert_eq!(classify(404, None, None, None, 100), Class::NotFound);
        assert_eq!(classify(403, Some("0"), Some("500"), None, 100), Class::RateLimited(500));
        assert_eq!(classify(403, None, None, Some("60"), 100), Class::RateLimited(160));
        assert_eq!(classify(429, None, None, None, 100), Class::RateLimited(160));
        assert_eq!(classify(403, Some("12"), None, None, 100), Class::Error("GitHub answered 403".into()));
        assert_eq!(classify(500, None, None, None, 100), Class::Error("GitHub answered 500".into()));
    }

    // ---------- stub server ----------

    fn raw(status: u16, headers: &[(&str, &str)], body: &str) -> String {
        let mut s = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for (k, v) in headers {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
        s.push_str("\r\n");
        s.push_str(body);
        s
    }

    struct Stub {
        base: String,
        hits: Arc<AtomicUsize>,
        request: Arc<Mutex<String>>,
        /// `update_last_check` as the stub saw it when the request arrived
        seen_last_check: Arc<Mutex<Option<String>>>,
    }

    fn stub(response: String, delay: Duration, db: Option<Db>) -> Stub {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (hits, request, seen) = (Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(String::new())), Arc::new(Mutex::new(None)));
        let (h2, r2, s2) = (hits.clone(), request.clone(), seen.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut c) = conn else { break };
                let mut buf = vec![0u8; 8192];
                let mut got = 0;
                loop {
                    let n = c.read(&mut buf[got..]).unwrap_or(0);
                    got += n;
                    if n == 0 || buf[..got].windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                h2.fetch_add(1, Ordering::SeqCst);
                *r2.lock().unwrap() = String::from_utf8_lossy(&buf[..got]).into_owned();
                if let Some(db) = &db {
                    *s2.lock().unwrap() = db::get_setting(&lock(db), "update_last_check");
                }
                std::thread::sleep(delay);
                let _ = c.write_all(response.as_bytes());
                let _ = c.flush();
            }
        });
        Stub { base, hits, request, seen_last_check: seen }
    }

    fn new_db() -> Db {
        Arc::new(Mutex::new(db::test_conn(&[])))
    }

    fn ctx(base: &str, now: i64, current: &str) -> Ctx {
        Ctx {
            base: base.into(),
            now,
            timeout: Duration::from_secs(5),
            current: current.into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            linux: LinuxFmt::AppImage,
        }
    }

    fn run(db: &Db, busy: &AtomicBool, c: &Ctx, t: Trigger) -> UpdateResult {
        tauri::async_runtime::block_on(run_check(db, busy, c, t))
    }

    fn release_json(tag: &str) -> String {
        let dl = |n: &str| format!("https://github.com/thnonl/hey-look/releases/download/{tag}/{n}");
        serde_json::json!({
            "tag_name": tag,
            "html_url": format!("https://github.com/thnonl/hey-look/releases/tag/{tag}"),
            "body": "## Highlights\n- Faster",
            "published_at": "2026-10-12T10:00:00Z",
            "assets": [
                { "name": "HeyLook_1.1.0_windows_x64-setup.exe", "browser_download_url": dl("HeyLook_1.1.0_windows_x64-setup.exe"), "size": 10276044 },
                { "name": "HeyLook_1.1.0_windows_x64.msi", "browser_download_url": dl("HeyLook_1.1.0_windows_x64.msi"), "size": 5 },
                { "name": "HeyLook_1.1.0_darwin_universal.dmg", "browser_download_url": dl("HeyLook_1.1.0_darwin_universal.dmg"), "size": 5 }
            ]
        })
        .to_string()
    }

    fn one(response: String, current: &str, now: i64) -> UpdateResult {
        let s = stub(response, Duration::ZERO, None);
        run(&new_db(), &AtomicBool::new(false), &ctx(&s.base, now, current), Trigger::Manual)
    }

    #[test]
    fn stub_available_and_persistence() {
        let db = new_db();
        let s = stub(raw(200, &[], &release_json("v1.1.0")), Duration::ZERO, Some(db.clone()));
        let r = run(&db, &AtomicBool::new(false), &ctx(&s.base, 5000, "1.0.0"), Trigger::Manual);
        assert_eq!(r.kind, Kind::Available);
        let i = r.info.clone().unwrap();
        assert_eq!(i.latest, "1.1.0");
        assert_eq!(i.published_at, Some(1_791_799_200));
        assert_eq!(i.release_url, "https://github.com/thnonl/hey-look/releases/tag/v1.1.0");
        let a = i.asset.unwrap();
        assert_eq!((a.name.as_str(), a.size), ("HeyLook_1.1.0_windows_x64-setup.exe", 10276044));
        assert_eq!(r.checked_at, Some(5000));
        assert!(!r.from_cache);
        // the attempt was already stored when the server saw the request
        assert_eq!(s.seen_last_check.lock().unwrap().as_deref(), Some("5000"));
        let c = lock(&db);
        assert_eq!(db::get_setting(&c, "update_last_ok").as_deref(), Some("1"));
        assert!(valid_cache(db::get_setting(&c, "update_cache").as_deref(), &v("1.0.0")).is_some());
    }

    #[test]
    fn stub_up_to_date_and_newer_build() {
        assert_eq!(one(raw(200, &[], &release_json("v1.1.0")), "1.1.0", 1).kind, Kind::UpToDate);
        let r = one(raw(200, &[], &release_json("v1.1.0")), "1.2.0", 1);
        assert_eq!(r.kind, Kind::UpToDate);
        assert_eq!(r.info.unwrap().latest, "1.1.0");
    }

    #[test]
    fn stub_http_statuses() {
        assert_eq!(one(raw(404, &[], "{}"), "1.0.0", 100).kind, Kind::NoRelease);
        let r = one(raw(403, &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "9999")], "{}"), "1.0.0", 100);
        assert_eq!((r.kind, r.retry_at), (Kind::RateLimited, Some(9999)));
        let r = one(raw(429, &[], "{}"), "1.0.0", 100);
        assert_eq!((r.kind, r.retry_at), (Kind::RateLimited, Some(160)));
        let r = one(raw(403, &[("retry-after", "60")], "{}"), "1.0.0", 100);
        assert_eq!((r.kind, r.retry_at), (Kind::RateLimited, Some(160)));
        let r = one(raw(403, &[], "{}"), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("GitHub answered 403")));
        let r = one(raw(500, &[], "{}"), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("GitHub answered 500")));
        let r = one(raw(200, &[], "<html>login</html>"), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("GitHub sent an unexpected answer")));
        let r = one(raw(200, &[], &release_json("release-1")), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("couldn\u{2019}t read the latest version (release-1)")));
    }

    #[test]
    fn stub_failures_are_remembered() {
        let db = new_db();
        let s = stub(raw(500, &[], "{}"), Duration::ZERO, None);
        run(&db, &AtomicBool::new(false), &ctx(&s.base, 100, "1.0.0"), Trigger::Manual);
        assert_eq!(db::get_setting(&lock(&db), "update_last_ok").as_deref(), Some("0"));
        // failed attempt: an automatic check is due again after 1 h, not before
        let busy = AtomicBool::new(false);
        assert_eq!(run(&db, &busy, &ctx(&s.base, 100 + 3599, "1.0.0"), Trigger::Shown).kind, Kind::Throttled);
        assert_eq!(s.hits.load(Ordering::SeqCst), 1);
        assert_eq!(run(&db, &busy, &ctx(&s.base, 100 + 3600, "1.0.0"), Trigger::Shown).kind, Kind::Error);
        assert_eq!(s.hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stub_offline_closed_port_and_timeout() {
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let r = run(&new_db(), &AtomicBool::new(false), &ctx(&closed, 1, "1.0.0"), Trigger::Manual);
        assert_eq!(r.kind, Kind::Offline);
        // the real timeout is 15 s; the test uses a short one against a slow server
        let s = stub(raw(200, &[], &release_json("v1.1.0")), Duration::from_secs(3), None);
        let mut c = ctx(&s.base, 1, "1.0.0");
        c.timeout = Duration::from_millis(400);
        assert_eq!(run(&new_db(), &AtomicBool::new(false), &c, Trigger::Manual).kind, Kind::Offline);
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn stub_request_headers() {
        let s = stub(raw(404, &[], "{}"), Duration::ZERO, None);
        run(&new_db(), &AtomicBool::new(false), &ctx(&s.base, 1, "1.0.0"), Trigger::Manual);
        let req = s.request.lock().unwrap().to_ascii_lowercase();
        assert!(req.starts_with("get /repos/thnonl/hey-look/releases/latest http/1.1\r\n"), "{req}");
        assert!(req.contains("\r\naccept: application/vnd.github+json\r\n"));
        assert!(req.contains("\r\nx-github-api-version: 2022-11-28\r\n"));
        assert!(req.contains("\r\nuser-agent: heylook/1.0.0\r\n"));
        for forbidden in ["authorization:", "cookie:", "referer:", "?"] {
            assert!(!req.contains(forbidden), "request must not contain {forbidden}");
        }
    }

    #[test]
    fn stub_concurrent_calls_make_one_request() {
        let db = new_db();
        let s = stub(raw(200, &[], &release_json("v1.1.0")), Duration::from_millis(600), None);
        let busy = Arc::new(AtomicBool::new(false));
        let c = ctx(&s.base, 100, "1.0.0");
        let (d1, b1, c1) = (db.clone(), busy.clone(), c.clone());
        let first = tauri::async_runtime::spawn(async move { run_check(&d1, &b1, &c1, Trigger::Manual).await });
        std::thread::sleep(Duration::from_millis(200));
        let second = run(&db, &busy, &c, Trigger::Manual);
        assert_eq!(second.kind, Kind::Throttled);
        let first = tauri::async_runtime::block_on(first).unwrap();
        assert_eq!(first.kind, Kind::Available);
        assert_eq!(s.hits.load(Ordering::SeqCst), 1);
        // the guard is released afterwards
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn stub_disabled_and_throttled_use_the_cache() {
        let db = new_db();
        let s = stub(raw(200, &[], &release_json("v1.1.0")), Duration::ZERO, None);
        let busy = AtomicBool::new(false);
        let first = run(&db, &busy, &ctx(&s.base, 1000, "1.0.0"), Trigger::Startup);
        assert_eq!(first.kind, Kind::Available);

        // within 6 h: no request, cached info, no second write
        let r = run(&db, &busy, &ctx(&s.base, 1000 + 21599, "1.0.0"), Trigger::Shown);
        assert_eq!((r.kind, r.from_cache, r.cached_kind), (Kind::Throttled, true, Some(Kind::Available)));
        assert_eq!(r.info.as_ref().unwrap().latest, "1.1.0");
        assert_eq!(r.checked_at, Some(1000));
        assert_eq!(db::get_setting(&lock(&db), "update_last_check").as_deref(), Some("1000"));
        assert_eq!(s.hits.load(Ordering::SeqCst), 1);

        // another running version (an update was installed): the cache is discarded
        let r = run(&db, &busy, &ctx(&s.base, 1000 + 60, "1.1.0"), Trigger::Shown);
        assert_eq!((r.kind, r.info, r.from_cache), (Kind::Throttled, None, false));

        // switched off: automatic triggers make no request and write nothing; manual still works
        db::set_setting(&lock(&db), "prefs", r#"{"checkUpdates":false}"#).unwrap();
        let r = run(&db, &busy, &ctx(&s.base, 1000 + 99999, "1.0.0"), Trigger::Startup);
        assert_eq!((r.kind, r.from_cache), (Kind::Disabled, true));
        assert_eq!(run(&db, &busy, &ctx(&s.base, 1000 + 99999, "1.0.0"), Trigger::Shown).kind, Kind::Disabled);
        assert_eq!(s.hits.load(Ordering::SeqCst), 1);
        assert_eq!(db::get_setting(&lock(&db), "update_last_check").as_deref(), Some("1000"));
        let r = run(&db, &busy, &ctx(&s.base, 1000 + 99999, "1.0.0"), Trigger::Manual);
        assert_eq!(r.kind, Kind::Available);
        assert_eq!(s.hits.load(Ordering::SeqCst), 2);

        // after 6 h with the switch back on: one new request
        db::set_setting(&lock(&db), "prefs", r#"{"checkUpdates":true}"#).unwrap();
        let t = 1000 + 99999 + 21600;
        assert_eq!(run(&db, &busy, &ctx(&s.base, t, "1.0.0"), Trigger::Shown).kind, Kind::Available);
        assert_eq!(db::get_setting(&lock(&db), "update_last_check").as_deref(), Some(t.to_string().as_str()));
    }

    #[test]
    fn bad_stored_values_count_as_missing() {
        let db = new_db();
        let s = stub(raw(200, &[], &release_json("v1.1.0")), Duration::ZERO, None);
        {
            let c = lock(&db);
            db::set_setting(&c, "update_last_check", "yesterday").unwrap();
            db::set_setting(&c, "update_last_ok", "maybe").unwrap();
            db::set_setting(&c, "update_cache", "{broken").unwrap();
        }
        let r = run(&db, &AtomicBool::new(false), &ctx(&s.base, 7, "1.0.0"), Trigger::Startup);
        assert_eq!(r.kind, Kind::Available);
    }

    #[test]
    fn unknown_trigger_is_refused() {
        assert!(Trigger::parse("startup").is_some());
        assert!(Trigger::parse("shown").is_some());
        assert!(Trigger::parse("manual").is_some());
        assert!(Trigger::parse("now").is_none());
    }
}
