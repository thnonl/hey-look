//! In-app updates. The check asks GitHub for `latest.json` of the latest release (through the updater plugin, used from
//! Rust only), compares it with the running version and tells the UI what is on offer. When the user agrees,
//! `update_download` downloads the package into memory with progress events and verifies its minisign signature;
//! `update_install` installs it (the plugin restarts the app) and `install_on_exit` installs a package the user chose to
//! keep for later when the app quits. Throttle state lives in the settings table (`update_last_check`,
//! `update_last_ok`, `update_cache`, `update_installing`, `update_restart_draft`).
use crate::{db, lock, now, shell, AppState, Db};
use db::R;
use semver::{BuildMetadata, Version};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Error as UpdErr, Update, UpdaterExt};
use tokio::sync::oneshot;

const RELEASES_PAGE: &str = "https://github.com/thnonl/hey-look/releases/tag/";
const NOTES_MAX_CHARS: usize = 4000;
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
/// No new bytes for this long = the download failed.
const STALL: Duration = Duration::from_secs(60);
/// Automatic checks (F-20): a launch asks again once the last attempt is 5 minutes old (whatever it said), a window that comes back
/// after 2 h, or 15 minutes after a failed attempt. It used to be 6 h / 1 h, and a Mac, whose app lives for days in the Dock, found the
/// gate closed after a quit and relaunch: the stored "up to date" was shown instead of a freshly published version. The requests go to
/// github.com's release-download redirect (not the REST API), at most one per 5 minutes per launch.
const STARTUP_GAP_SECS: i64 = 300;
const EVERY_SECS: i64 = 2 * 3600;
const RETRY_SECS: i64 = 900;

// ---------- types ----------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Available,
    UpToDate,
    NoRelease,
    Offline,
    Error,
    /// internal: automatic checks are off
    Disabled,
    /// the Snap Store, which installed this copy, updates it: the app never asks GitHub
    Managed,
    /// internal: not due yet, another check is running, or an update is already on its way
    Throttled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: Option<u64>,
    /// the link passes the allow-list (https://github.com/thnonl/hey-look/releases/download/v<version>/<file>)
    pub url_ok: bool,
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
    /// nsis | msi | app | appimage | deb | rpm | unknown
    pub installer: String,
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

/// Parsed URL with the host rules shared by installer and release links: https, host github.com, no user info,
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
pub fn safe_asset_url(raw: &str) -> Option<Vec<String>> {
    let u = github_url(raw)?;
    let s = clean_segments(&u)?;
    (s.len() == 6 && s[0] == "thnonl" && s[1] == "hey-look" && s[2] == "releases" && s[3] == "download").then_some(s)
}

/// Whether an update may be downloaded from `raw`: a GitHub release link whose tag is `v<version>`; with
/// `allow_local` (debug override only) also `http(s)://127.0.0.1:<port>/…` and `http(s)://localhost:<port>/…`.
pub fn update_url_ok(raw: &str, version: &str, allow_local: bool) -> bool {
    if let Some(s) = safe_asset_url(raw) {
        return s[4] == format!("v{version}");
    }
    if !allow_local {
        return false;
    }
    let lower = raw.to_ascii_lowercase();
    if lower.contains("%2e") || lower.contains('\\') || lower.contains("/../") || lower.contains("/./") {
        return false;
    }
    reqwest::Url::parse(raw).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && matches!(u.host_str(), Some("127.0.0.1") | Some("localhost"))
            && u.port().is_some()
            && u.username().is_empty()
            && u.password().is_none()
    })
}

/// Seconds an automatic trigger waits after the last attempt: 5 minutes for a launch, else 2 h (15 minutes after a failed attempt).
pub fn gap_secs(trigger: Trigger, last_ok: bool) -> i64 {
    match (trigger, last_ok) {
        (Trigger::Startup, _) => STARTUP_GAP_SECS,
        (_, true) => EVERY_SECS,
        (_, false) => RETRY_SECS,
    }
}

/// Whether a check may ask the server now: a manual one always, an automatic one when the last attempt is old enough (`gap_secs`);
/// a missing or future timestamp is due.
pub fn due(trigger: Trigger, now: i64, last: Option<i64>, last_ok: bool) -> bool {
    if trigger == Trigger::Manual {
        return true;
    }
    match last {
        None => true,
        Some(l) if l > now => true,
        Some(l) => now - l >= gap_secs(trigger, last_ok),
    }
}

/// The keys of `latest.json`'s `platforms` this copy of the app looks for, in the order the updater plugin tries them
/// (`<os>-<arch>-<installer>`, then `<os>-<arch>`; the plugin calls macOS `darwin` and the CPU `x86_64` / `aarch64`).
pub fn manifest_keys(p: &Platform) -> Vec<String> {
    let os = if p.os == "macos" { "darwin" } else { p.os.as_str() };
    let arch = match p.arch.as_str() {
        "x64" => "x86_64",
        "arm64" => "aarch64",
        other => other,
    };
    let mut keys = Vec::new();
    if p.installer != "unknown" {
        keys.push(format!("{os}-{arch}-{}", p.installer));
    }
    keys.push(format!("{os}-{arch}"));
    keys
}

/// First `max` characters (never splits a character) and whether anything was cut. CRLF becomes LF.
pub fn truncate_notes(s: &str, max: usize) -> (String, bool) {
    let s = s.replace("\r\n", "\n");
    match s.char_indices().nth(max) {
        Some((i, _)) => (s[..i].to_string(), true),
        None => (s, false),
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

/// Who updates this copy, if not the app itself: `snap` when this is the Hey Look! snap (snapd sets `SNAP_NAME` and `SNAP`
/// for every confined app, and the binary lives under `$SNAP`). All three are required: a child of a classic snap (a terminal or
/// an IDE installed as a snap) inherits `SNAP_NAME` and `SNAP` from its parent, and a .deb or AppImage started from such a
/// terminal must keep its own updater. `apt` when this is the .deb and an enabled APT source for the Hey Look! repository exists
/// (see `managed_from`). Such a copy is updated by that store or package manager, so the in-app updater stays quiet and Settings >
/// About says who updates it (`Kind::Managed`). None for the AppImage, .rpm, Windows and macOS, and for a .deb without the repository.
/// Read once, at the first call (the snap variables and the APT source files do not change while the app runs).
pub fn managed_by() -> Option<&'static str> {
    static MANAGED: std::sync::OnceLock<Option<&'static str>> = std::sync::OnceLock::new();
    *MANAGED.get_or_init(|| {
        if let Some(forced) = test_managed() {
            return forced;
        }
        let snap = managed_by_env(std::env::var("SNAP_NAME").ok().as_deref(), std::env::var_os("SNAP").map(std::path::PathBuf::from).as_deref(), std::env::current_exe().ok().as_deref());
        let is_deb = cfg!(target_os = "linux") && matches!(tauri::utils::platform::bundle_type(), Some(tauri::utils::config::BundleType::Deb));
        let sources = if is_deb && snap.is_none() { read_apt_sources(std::path::Path::new("/etc/apt")) } else { Vec::new() };
        managed_from(snap, crate::pkg::ui_packaged(), is_deb, &sources)
    })
}

/// Debug builds only: `HEYLOOK_TEST_MANAGED=apt|snap|msstore` pretends this copy is managed (QA of the About texts on a system without the
/// store), any other value (`none`) pretends it is not. Release builds never read it (compiled out). The outer Option is "the
/// variable decides".
fn test_managed() -> Option<Option<&'static str>> {
    #[cfg(debug_assertions)]
    {
        std::env::var("HEYLOOK_TEST_MANAGED").ok().map(|v| match v.trim() {
            "apt" => Some("apt"),
            "snap" => Some("snap"),
            "msstore" => Some("msstore"),
            _ => None,
        })
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// The name snapcraft.yaml registers; the store name, the data folder `~/snap/<name>` and the plugs all carry it.
pub const SNAP_NAME: &str = "hey-look";

fn managed_by_env(snap_name: Option<&str>, snap: Option<&std::path::Path>, exe: Option<&std::path::Path>) -> Option<&'static str> {
    match (snap_name, snap, exe) {
        (Some(name), Some(root), Some(exe)) if name == SNAP_NAME && !root.as_os_str().is_empty() && exe.starts_with(root) => Some("snap"),
        _ => None,
    }
}

/// The address of the Hey Look! APT repository (docs/apt/heylook.sources, PACKAGING.md).
const APT_REPO: &str = "heylook.namthai.site/apt";

/// A file of the APT source configuration: its name (the extension says the format) and its text.
struct AptSource {
    name: String,
    text: String,
}

/// The snap wins; else the Microsoft Store package (WP14: the Store updates it, pkg.rs) is managed by `msstore`; else the `.deb` build with an enabled APT
/// source for the Hey Look! repository is managed by `apt`. A pure function: the caller reads the files (`read_apt_sources`).
fn managed_from(snap: Option<&'static str>, packaged: bool, is_deb: bool, sources: &[AptSource]) -> Option<&'static str> {
    if snap.is_some() {
        return snap;
    }
    if packaged {
        return Some("msstore");
    }
    if is_deb && sources.iter().any(apt_source_enabled) {
        return Some("apt");
    }
    None
}

/// `/etc/apt/sources.list` and the `*.list` / `*.sources` files of `/etc/apt/sources.list.d` that can be read. A file that cannot
/// be read (permissions, not text) is skipped; a file larger than 1 MB is not read.
fn read_apt_sources(etc: &std::path::Path) -> Vec<AptSource> {
    let mut files = vec![etc.join("sources.list")];
    if let Ok(dir) = std::fs::read_dir(etc.join("sources.list.d")) {
        let mut found: Vec<_> = dir.flatten().map(|e| e.path()).filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("list" | "sources"))).collect();
        found.sort();
        files.extend(found);
    }
    files
        .into_iter()
        .filter_map(|p| {
            if std::fs::metadata(&p).ok()?.len() > 1_000_000 {
                return None;
            }
            let text = std::fs::read_to_string(&p).ok()?;
            Some(AptSource { name: p.file_name()?.to_string_lossy().into_owned(), text })
        })
        .collect()
}

/// Does `word` name the Hey Look! repository: http or https, the host and path of `APT_REPO`, an optional trailing slash.
fn is_repo_uri(word: &str) -> bool {
    let w = word.trim().to_ascii_lowercase();
    let rest = w.strip_prefix("https://").or_else(|| w.strip_prefix("http://"));
    matches!(rest, Some(r) if r.trim_end_matches('/') == APT_REPO)
}

/// Is there an enabled source for the repository in this file? `*.sources` is deb822 (stanzas of `Key: value`, `Types:` has `deb`,
/// `URIs:` has the address, no `Enabled: no`); every other file is the one-line format (`deb [options] URI suite component`, a line
/// that starts with `deb`, not commented out; `deb-src` does not count).
fn apt_source_enabled(f: &AptSource) -> bool {
    if f.name.ends_with(".sources") {
        let mut stanza: Vec<(String, String)> = Vec::new();
        let mut stanzas: Vec<Vec<(String, String)>> = Vec::new();
        for line in f.text.lines() {
            if line.trim().is_empty() {
                if !stanza.is_empty() {
                    stanzas.push(std::mem::take(&mut stanza));
                }
            } else if line.starts_with('#') {
                continue;
            } else if line.starts_with(' ') || line.starts_with('\t') {
                // a continuation line belongs to the field above
                if let Some(last) = stanza.last_mut() {
                    last.1.push(' ');
                    last.1.push_str(line.trim());
                }
            } else if let Some((k, v)) = line.split_once(':') {
                stanza.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
            }
        }
        if !stanza.is_empty() {
            stanzas.push(stanza);
        }
        return stanzas.iter().any(|st| {
            let field = |name: &str| st.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
            let deb = field("types").is_some_and(|v| v.split_whitespace().any(|t| t.eq_ignore_ascii_case("deb")));
            let uri = field("uris").is_some_and(|v| v.split_whitespace().any(is_repo_uri));
            // the words apt reads as "no" for Enabled
            let off = field("enabled").is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "no" | "false" | "0" | "off" | "without" | "disable"));
            deb && uri && !off
        });
    }
    f.text.lines().any(|line| {
        let line = line.trim_start();
        if line.starts_with('#') {
            return false;
        }
        let mut words = line.split_whitespace();
        words.next() == Some("deb") && words.any(is_repo_uri)
    })
}

/// How this copy of the app was installed (the bundler patches the bundle type into the binary).
pub fn platform_info() -> Platform {
    use tauri::utils::config::BundleType as B;
    let os = std::env::consts::OS;
    let installer = match (managed_by(), tauri::utils::platform::bundle_type()) {
        (Some(store), _) => store,
        (None, bundle) => match bundle {
        Some(B::Nsis) => "nsis",
        Some(B::Msi) => "msi",
        Some(B::App) | Some(B::Dmg) => "app",
        Some(B::AppImage) => "appimage",
        Some(B::Deb) => "deb",
        Some(B::Rpm) => "rpm",
        None => "unknown",
        },
    };
    let label = match (os, installer) {
        ("windows", "msi") => "Windows (MSI)".to_string(),
        ("windows", _) => "Windows".to_string(),
        ("macos", _) => "macOS".to_string(),
        ("linux", "deb") => "Linux (.deb)".to_string(),
        ("linux", "rpm") => "Linux (.rpm)".to_string(),
        ("linux", "snap") => "Linux (Snap)".to_string(),
        ("linux", "apt") => "Linux (APT)".to_string(),
        ("linux", _) => "Linux (.AppImage)".to_string(),
        (other, _) => other.to_string(),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    Platform { os: os.to_string(), arch: arch.to_string(), installer: installer.to_string(), label }
}

/// Debug builds only: `HEYLOOK_UPDATE_ENDPOINT` replaces the manifest URL (and allows localhost download links).
/// Release builds never read it.
fn endpoint_override() -> Option<reqwest::Url> {
    #[cfg(debug_assertions)]
    {
        std::env::var("HEYLOOK_UPDATE_ENDPOINT")
            .ok()
            .and_then(|s| reqwest::Url::parse(s.trim()).ok())
            .filter(|u| matches!(u.scheme(), "http" | "https"))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

// ---------- check ----------

#[derive(Clone)]
pub struct Ctx {
    /// manifest URL instead of the one in tauri.conf.json (debug override, tests)
    pub endpoint: Option<reqwest::Url>,
    pub allow_local: bool,
    pub now: i64,
    pub timeout: Duration,
    pub current: String,
    pub platform: Platform,
    /// the store that updates this copy (`managed_by`): the check answers `Managed` without a request
    pub managed: Option<&'static str>,
}

impl Ctx {
    fn live<R: Runtime>(app: &AppHandle<R>) -> Ctx {
        let endpoint = endpoint_override();
        Ctx {
            allow_local: endpoint.is_some(),
            endpoint,
            now: now(),
            timeout: CHECK_TIMEOUT,
            current: app.package_info().version.to_string(),
            platform: platform_info(),
            managed: managed_by(),
        }
    }

    fn result(&self, kind: Kind, checked_at: Option<i64>) -> UpdateResult {
        UpdateResult {
            kind,
            current: self.current.clone(),
            platform: self.platform.clone(),
            checked_at,
            message: None,
            info: None,
            from_cache: false,
            cached_kind: None,
        }
    }
}

/// Released on every exit path (also `?` returns and panics).
struct Flag<'a>(&'a AtomicBool);

impl Drop for Flag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn try_flag(flag: &AtomicBool) -> Option<Flag<'_>> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).ok().map(|_| Flag(flag))
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

fn short(s: &str) -> String {
    s.chars().take(120).collect()
}

fn info_from(ctx: &Ctx, version: &str, body: Option<&str>, date: Option<i64>, asset: Option<(String, Option<u64>)>) -> UpdateInfo {
    let (notes, notes_truncated) = truncate_notes(body.unwrap_or(""), NOTES_MAX_CHARS);
    UpdateInfo {
        latest: version.to_string(),
        notes,
        notes_truncated,
        published_at: date,
        release_url: format!("{RELEASES_PAGE}v{version}"),
        asset: asset.map(|(url, size)| {
            let name = url.rsplit('/').next().unwrap_or("").to_string();
            let url_ok = update_url_ok(&url, version, ctx.allow_local);
            Asset { name, url, size, url_ok }
        }),
    }
}

pub struct Checked {
    pub result: UpdateResult,
    pub update: Option<Update>,
}

type Seen = Arc<Mutex<Option<(Version, Option<String>, Option<i64>)>>>;

/// One request for the manifest and the mapping of its answer. No settings, no guard.
pub async fn check_once<R: Runtime>(app: &AppHandle<R>, ctx: &Ctx) -> Checked {
    let seen: Seen = Arc::new(Mutex::new(None));
    let seen2 = seen.clone();
    let mut builder = app.updater_builder().timeout(ctx.timeout).version_comparator(move |current, remote| {
        *seen2.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((remote.version.clone(), remote.notes.clone(), remote.pub_date.map(|d| d.unix_timestamp())));
        remote.version > current
    });
    if let Some(ep) = &ctx.endpoint {
        builder = match builder.endpoints(vec![ep.clone()]) {
            Ok(b) => b,
            Err(e) => return failed(ctx, &e),
        };
    }
    let outcome = match builder.build() {
        Ok(updater) => updater.check().await,
        Err(e) => return failed(ctx, &e),
    };
    let seen = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let mut r = ctx.result(Kind::Error, Some(ctx.now));
    match outcome {
        Ok(Some(u)) => {
            let size = u.raw_json["platforms"]
                .as_object()
                .and_then(|p| p.values().find(|e| e["url"].as_str() == Some(u.download_url.as_str())))
                .and_then(|e| e["size"].as_u64());
            r.kind = Kind::Available;
            r.info = Some(info_from(ctx, &u.version, u.body.as_deref(), u.date.map(|d| d.unix_timestamp()), Some((u.download_url.to_string(), size))));
            Checked { result: r, update: Some(u) }
        }
        Ok(None) => {
            // not newer (or a 204): up to date, with what the manifest said when it said anything
            r.kind = Kind::UpToDate;
            if let Some((v, notes, date)) = &seen {
                r.info = Some(info_from(ctx, &v.to_string(), notes.as_deref(), *date, None));
            }
            Checked { result: r, update: None }
        }
        Err(UpdErr::TargetNotFound(_) | UpdErr::TargetsNotFound(_)) if seen.is_some() => {
            // the manifest has no installer for this system: still tells whether a newer version exists
            let (v, notes, date) = seen.unwrap();
            let newer = parse_version(&ctx.current).is_some_and(|c| v > c);
            r.kind = if newer { Kind::Available } else { Kind::UpToDate };
            r.info = Some(info_from(ctx, &v.to_string(), notes.as_deref(), date, None));
            Checked { result: r, update: None }
        }
        // the plugin calls every answer that is not a success "release not found"; only the status tells a missing release from a server
        // that is busy or broken (F-20 follow-up)
        Err(UpdErr::ReleaseNotFound) => status_failure(app, ctx).await,
        Err(e) => failed(ctx, &e),
    }
}

/// What a non-success HTTP status of the manifest means: 404 / 410 = there is no such release asset (the stored offer is gone), anything
/// else (429, 5xx, 403, ...) = the server could not answer now: a failed check that keeps what the app already knows. `None` = a success.
pub fn status_kind(status: u16) -> Option<(Kind, Option<String>)> {
    match status {
        200..=299 => None,
        404 | 410 => Some((Kind::NoRelease, None)),
        other => Some((Kind::Error, Some(format!("HTTP {other}")))),
    }
}

/// The manifest URL of the updater (the debug override, else the first endpoint of tauri.conf.json).
fn manifest_url<R: Runtime>(app: &AppHandle<R>, ctx: &Ctx) -> Option<reqwest::Url> {
    if let Some(u) = &ctx.endpoint {
        return Some(u.clone());
    }
    let cfg = app.config().plugins.0.get("updater")?;
    reqwest::Url::parse(cfg.get("endpoints")?.as_array()?.first()?.as_str()?).ok()
}

/// The updater plugin did not say what the server answered (every non-success status is the same error to it): one more request for
/// the status, only on this failure path (a successful check is still one request). A request that fails is offline / error as usual.
async fn status_failure<R: Runtime>(app: &AppHandle<R>, ctx: &Ctx) -> Checked {
    let mut r = ctx.result(Kind::NoRelease, Some(ctx.now));
    let Some(url) = manifest_url(app, ctx) else { return Checked { result: r, update: None } };
    let client = match reqwest::Client::builder().timeout(ctx.timeout).user_agent("hey-look-update-check").build() {
        Ok(c) => c,
        Err(_) => return Checked { result: r, update: None },
    };
    match client.get(url).header(reqwest::header::ACCEPT, "application/json").send().await {
        Ok(resp) => match status_kind(resp.status().as_u16()) {
            Some((kind, message)) => {
                r.kind = kind;
                r.message = message;
            }
            // it answered fine this time: the first answer was not usable, nothing else is known
            None => {
                r.kind = Kind::Error;
                r.message = Some("GitHub sent an unexpected answer".to_string());
            }
        },
        Err(e) if e.is_connect() || e.is_timeout() || e.is_request() => r.kind = Kind::Offline,
        Err(_) => r.kind = Kind::Error,
    }
    Checked { result: r, update: None }
}

/// An updater error as a check result (REQ-14).
fn failed(ctx: &Ctx, e: &UpdErr) -> Checked {
    let mut r = ctx.result(Kind::Error, Some(ctx.now));
    match e {
        UpdErr::ReleaseNotFound => r.kind = Kind::NoRelease,
        UpdErr::Reqwest(re) if re.is_connect() || re.is_timeout() || re.is_request() => r.kind = Kind::Offline,
        // a 200 answer that is not a manifest (a captive portal's HTML, a bad version) is a decode / serde error
        UpdErr::Reqwest(_) | UpdErr::Serialization(_) | UpdErr::Semver(_) => r.message = Some("GitHub sent an unexpected answer".to_string()),
        other => r.message = Some(short(&other.to_string())),
    }
    Checked { result: r, update: None }
}

/// State shared by the download, ready and install commands.
#[derive(Default)]
pub struct UpdState {
    downloading: AtomicBool,
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    /// the verified package, in memory only
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    /// the user chose "Later" / "Not now" for the package in `ready`, in THIS run: only then is it installed when the app quits
    deferred: AtomicBool,
}

impl UpdState {
    /// A download is running or a package is waiting: automatic checks stay quiet.
    /// The package to install now that the app is quitting: only one the user explicitly chose to keep for later (never one that merely
    /// finished downloading), and never across a restart (it lives in memory only).
    fn take_for_exit(&self) -> Option<(Update, Vec<u8>)> {
        let mut ready = self.ready.lock().unwrap_or_else(|p| p.into_inner());
        if self.deferred.load(Ordering::SeqCst) { ready.take() } else { None }
    }

    fn flow_active(&self) -> bool {
        self.downloading.load(Ordering::SeqCst) || self.ready.lock().unwrap_or_else(|p| p.into_inner()).is_some()
    }
}

impl Trigger {
    fn name(self) -> &'static str {
        match self {
            Trigger::Startup => "startup",
            Trigger::Shown => "shown",
            Trigger::Manual => "manual",
        }
    }
}

/// One line in `startup.log` per decision of a check (F-20: an automatic check that asks nothing and shows nothing left no trace, so
/// nobody could tell a switched-off setting, a throttle and a failed request apart). Starts with the clock of the check, UTC.
fn note(ctx: &Ctx, trigger: Trigger, what: &str) {
    let at = chrono::DateTime::from_timestamp(ctx.now, 0).map(|d| d.format("%Y-%m-%d %H:%M:%SZ").to_string()).unwrap_or_default();
    crate::startup::line("update", &format!("check {} {at}: {what}", trigger.name()));
}

/// What the stored answer says, for the log: `available 1.0.4`, `up to date (latest 1.0.3)` or `none`.
fn cached_offer(db: &Db, ctx: &Ctx) -> String {
    let cache = db::get_setting(&lock(db), "update_cache");
    match parse_version(&ctx.current).and_then(|cur| valid_cache(cache.as_deref(), &cur)) {
        Some((Kind::Available, i)) => format!("available {}", i.latest),
        Some((_, i)) => format!("up to date (latest {})", i.latest),
        None if cache.as_deref().is_none_or(|c| c.is_empty()) => "none".to_string(),
        None => "none (the stored answer is for another version or unreadable)".to_string(),
    }
}

/// The answer of a check, for the log.
fn answer_text(r: &UpdateResult) -> String {
    let latest = r.info.as_ref().map(|i| i.latest.as_str()).unwrap_or("-");
    match r.kind {
        Kind::Available => format!(
            "available {latest} (running {}); installer for this system: {}",
            r.current,
            r.info.as_ref().and_then(|i| i.asset.as_ref()).map(|a| a.name.as_str()).unwrap_or("none in the manifest")
        ),
        Kind::UpToDate => format!("up to date (running {}, latest {latest})", r.current),
        Kind::NoRelease => "no release (the server answered 404: there is no latest.json)".to_string(),
        Kind::Offline => "offline (no answer from the server)".to_string(),
        Kind::Error => match r.message.as_deref().and_then(|m| m.strip_prefix("HTTP ")) {
            Some(status) => format!("error (status {status})"),
            None => format!("error: {}", r.message.as_deref().unwrap_or("-")),
        },
        Kind::Managed => format!("managed: this copy is updated by its package manager or store ({}), no request is made", r.platform.installer),
        Kind::Disabled | Kind::Throttled => format!("{:?}", r.kind),
    }
}

/// The whole check: guard, switch, throttle, bookkeeping, request. `busy` is the in-flight guard; `ctx` carries the manifest
/// URL and the clock (tests inject both).
pub async fn run_check<R: Runtime>(app: &AppHandle<R>, db: &Db, busy: &AtomicBool, flow_active: bool, ctx: &Ctx, trigger: Trigger) -> UpdateResult {
    let Some(_guard) = try_flag(busy) else {
        note(ctx, trigger, "skipped, another check is running");
        return without_request(db, ctx, Kind::Throttled);
    };
    if ctx.managed.is_some() {
        note(ctx, trigger, &format!("skipped, this copy is updated by its package manager or store ({})", ctx.platform.installer));
        return ctx.result(Kind::Managed, read_last_check(db));
    }
    let auto = trigger != Trigger::Manual;
    if auto && !shell::pbool(&shell::prefs(db), "checkUpdates", true) {
        note(ctx, trigger, &format!("skipped, \"Check for updates automatically\" is off in Settings; stored answer: {}", cached_offer(db, ctx)));
        return without_request(db, ctx, Kind::Disabled);
    }
    if auto && flow_active {
        note(ctx, trigger, "skipped, a download or a downloaded package is waiting");
        return without_request(db, ctx, Kind::Throttled);
    }
    let (last, last_ok) = (read_last_check(db), read_last_ok(db));
    if !due(trigger, ctx.now, last, last_ok) {
        let gap = gap_secs(trigger, last_ok);
        let age = last.map_or(0, |l| ctx.now - l);
        note(
            ctx,
            trigger,
            &format!(
                "skipped, not due: the last attempt was {age} s ago and {} (an automatic check waits {gap} s, so the next one is in {} s); stored answer: {}",
                if last_ok { "got an answer" } else { "failed" },
                gap - age,
                cached_offer(db, ctx)
            ),
        );
        return without_request(db, ctx, Kind::Throttled);
    }
    note(
        ctx,
        trigger,
        &format!(
            "asking the server (running {}, {} {}, installer {}; looks for {}; the last attempt was {})",
            ctx.current,
            ctx.platform.os,
            ctx.platform.arch,
            ctx.platform.installer,
            manifest_keys(&ctx.platform).join(" then "),
            last.map_or("never".to_string(), |l| format!("{} s ago", ctx.now - l))
        ),
    );
    // the attempt is recorded before the request: a crash or a slow server must not cause a retry storm
    let _ = db::set_setting(&lock(db), "update_last_check", &ctx.now.to_string());

    let mut r = check_once(app, ctx).await.result;
    note(ctx, trigger, &format!("answer: {}", answer_text(&r)));
    let ok = matches!(r.kind, Kind::Available | Kind::UpToDate | Kind::NoRelease);
    {
        let c = lock(db);
        let _ = db::set_setting(&c, "update_last_ok", if ok { "1" } else { "0" });
        match r.kind {
            Kind::Available | Kind::UpToDate => {
                if let Some(info) = &r.info {
                    let cache = serde_json::json!({ "current": ctx.current, "kind": r.kind, "info": info });
                    let _ = db::set_setting(&c, "update_cache", &cache.to_string());
                }
            }
            // GitHub answered that there is no release (any non-2xx): the offer is gone, and a later throttled / disabled answer
            // must not bring it back
            Kind::NoRelease => {
                let _ = db::set_setting(&c, "update_cache", "");
            }
            // a failed check says nothing about the release: the offer the app already knows stays (never written back: the cache
            // is only ever the last real answer)
            Kind::Offline | Kind::Error => {
                if let Some(cur) = parse_version(&ctx.current) {
                    if let Some((Kind::Available, info)) = valid_cache(db::get_setting(&c, "update_cache").as_deref(), &cur) {
                        r.info = Some(info);
                        r.cached_kind = Some(Kind::Available);
                        r.from_cache = true;
                    }
                }
            }
            _ => {}
        }
    }
    r
}

static BUSY: AtomicBool = AtomicBool::new(false);

/// A store- or apt-managed copy never downloads or installs a package itself (the UI never offers it; the commands can still be called).
fn refuse_if_managed() -> R<()> {
    match managed_by() {
        Some(store) => Err(format!("this copy is updated by its package manager or store ({store}): the app downloads and installs no update itself")),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: tauri::State<'_, AppState>, upd: tauri::State<'_, UpdState>, trigger: String) -> R<UpdateResult> {
    let trigger = Trigger::parse(&trigger).ok_or_else(|| format!("unknown trigger: {trigger}"))?;
    let ctx = Ctx::live(&app);
    Ok(run_check(&app, &state.db, &BUSY, upd.flow_active(), &ctx, trigger).await)
}

// ---------- download ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum DlEvent {
    Started { total: Option<u64>, version: String },
    Progress { received: u64 },
    Verifying,
    Ready,
    Failed { stage: String, message: String },
    Cancelled,
}

type Emit = Arc<dyn Fn(DlEvent) + Send + Sync>;

#[derive(Debug, PartialEq)]
enum DlEnd {
    Cancelled,
    Failed { stage: &'static str, message: String },
}

fn dl_failed(stage: &'static str, message: impl Into<String>) -> DlEnd {
    DlEnd::Failed { stage, message: message.into() }
}

/// Why a download or its verification failed (stage + the reason shown in the UI).
fn map_download_error(e: &UpdErr) -> DlEnd {
    match e {
        UpdErr::Minisign(_) | UpdErr::Base64(_) | UpdErr::SignatureUtf8(_) | UpdErr::SignedVersionMismatch { .. } | UpdErr::MissingSignedVersion => {
            dl_failed("verify", short(&e.to_string()))
        }
        UpdErr::Reqwest(r) if r.is_connect() => dl_failed("download", "You seem to be offline."),
        UpdErr::Reqwest(r) if r.is_timeout() => dl_failed("download", "The download stopped. Check your connection."),
        UpdErr::Network(m) => {
            let code: String = m.rsplit("status: ").next().unwrap_or("").chars().take_while(|c| c.is_ascii_digit()).collect();
            if code.is_empty() {
                dl_failed("download", "The connection was lost.")
            } else {
                dl_failed("download", format!("GitHub answered {code}."))
            }
        }
        _ => dl_failed("download", "The connection was lost."),
    }
}

/// Download into memory with progress (at most 10 per second), cancel and a stall watchdog. The plugin verifies the
/// signature (and the signed version) before it returns the bytes.
async fn download_update(update: &Update, emit: Emit, cancel: oneshot::Receiver<()>, stall: Duration) -> Result<Vec<u8>, DlEnd> {
    let received = Arc::new(AtomicU64::new(0));
    let last_bytes = Arc::new(Mutex::new(Instant::now()));
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let finished = Arc::new(AtomicBool::new(false));
    let started = Arc::new(AtomicBool::new(false));
    // the byte count the UI was last told: the throttle below drops events, so the watchdog tops it up (a burst followed by a stall
    // must not leave the progress line stuck at the first chunk)
    let told = Arc::new(AtomicU64::new(0));

    let (e1, r1, lb1, le1, st1, t1) = (emit.clone(), received.clone(), last_bytes.clone(), last_emit.clone(), started.clone(), told.clone());
    let version = update.version.clone();
    let (e2, r2, f2) = (emit.clone(), received.clone(), finished.clone());
    let download = update.download(
        move |len, total| {
            *lb1.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
            let got = r1.fetch_add(len as u64, Ordering::SeqCst) + len as u64;
            if !st1.swap(true, Ordering::SeqCst) {
                e1(DlEvent::Started { total, version: version.clone() });
            }
            let mut le = le1.lock().unwrap_or_else(|p| p.into_inner());
            if le.elapsed() >= Duration::from_millis(100) {
                *le = Instant::now();
                t1.store(got, Ordering::SeqCst);
                e1(DlEvent::Progress { received: got });
            }
        },
        move || {
            f2.store(true, Ordering::SeqCst);
            e2(DlEvent::Progress { received: r2.load(Ordering::SeqCst) });
            e2(DlEvent::Verifying);
        },
    );
    let (e3, r3, t3) = (emit.clone(), received.clone(), told.clone());
    let watchdog = async {
        loop {
            tokio::time::sleep(Duration::from_millis(250).min(stall)).await;
            let got = r3.load(Ordering::SeqCst);
            if got != t3.swap(got, Ordering::SeqCst) && !finished.load(Ordering::SeqCst) {
                e3(DlEvent::Progress { received: got });
            }
            let idle = last_bytes.lock().unwrap_or_else(|p| p.into_inner()).elapsed();
            if !finished.load(Ordering::SeqCst) && idle >= stall {
                break;
            }
        }
    };
    tokio::select! {
        r = download => r.map_err(|e| map_download_error(&e)),
        _ = cancel => Err(DlEnd::Cancelled),
        _ = watchdog => Err(dl_failed("download", "The download stopped. Check your connection.")),
    }
}

fn check_failure_reason(r: &UpdateResult) -> String {
    match r.kind {
        Kind::Offline => "You seem to be offline.".to_string(),
        Kind::NoRelease => "Couldn\u{2019}t find update information on GitHub.".to_string(),
        Kind::Error => format!("{}.", r.message.clone().unwrap_or_else(|| "Unknown error".into())),
        _ => "The update is no longer available.".to_string(),
    }
}

/// The fresh check that starts a download, and the rules that stop it before any package request: no update, a version other than the
/// one the user agreed to (consent is per version: the card, possibly a cached offer, named `agreed`), a link outside the allow-list.
/// Returns the update to download, or has already told the UI why not.
async fn prepare_download<R: Runtime>(app: &AppHandle<R>, ctx: &Ctx, agreed: &str, emit: &Emit) -> Option<Update> {
    let checked = check_once(app, ctx).await;
    let Some(mut update) = checked.update else {
        emit(DlEvent::Failed { stage: "download".into(), message: check_failure_reason(&checked.result) });
        return None;
    };
    if !same_version(&update.version, agreed) {
        emit(DlEvent::Failed { stage: "changed".into(), message: update.version.clone() });
        return None;
    }
    if !update_url_ok(update.download_url.as_str(), &update.version, ctx.allow_local) {
        emit(DlEvent::Failed { stage: "badurl".into(), message: String::new() });
        return None;
    }
    update.timeout = None;
    Some(update)
}

/// Whether two version strings name the same version (a `v` prefix and build metadata do not matter).
fn same_version(a: &str, b: &str) -> bool {
    matches!((parse_version(a), parse_version(b)), (Some(x), Some(y)) if x == y)
}

/// Download the update the user agreed to, with progress events on `on_event`; the verified package stays in memory.
#[tauri::command]
pub async fn update_download(app: AppHandle, state: tauri::State<'_, AppState>, upd: tauri::State<'_, UpdState>, version: String, on_event: Channel<DlEvent>) -> R<()> {
    refuse_if_managed()?;
    let Some(_flag) = try_flag(&upd.downloading) else { return Err("UPDATE_BUSY: A download is already running.".into()) };
    upd.deferred.store(false, Ordering::SeqCst);
    let ch = on_event.clone();
    let emit: Emit = Arc::new(move |e| {
        let _ = ch.send(e);
    });
    let (tx, rx) = oneshot::channel();
    *upd.cancel.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
    let ctx = Ctx::live(&app);
    let db = state.db.clone();
    let _ = db::set_setting(&lock(&db), "update_last_check", &ctx.now.to_string());

    let Some(update) = prepare_download(&app, &ctx, &version, &emit).await else { return Ok(()) };
    match download_update(&update, emit.clone(), rx, STALL).await {
        Ok(bytes) => {
            *upd.ready.lock().unwrap_or_else(|p| p.into_inner()) = Some((update, bytes));
            emit(DlEvent::Ready);
        }
        Err(DlEnd::Cancelled) => emit(DlEvent::Cancelled),
        Err(DlEnd::Failed { stage, message }) => emit(DlEvent::Failed { stage: stage.into(), message }),
    }
    Ok(())
}

#[tauri::command]
pub fn update_cancel(upd: tauri::State<'_, UpdState>) {
    if let Some(tx) = upd.cancel.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = tx.send(());
    }
}

/// Forget a downloaded package (a newer version was found).
#[tauri::command]
pub fn update_discard(upd: tauri::State<'_, UpdState>) {
    *upd.ready.lock().unwrap_or_else(|p| p.into_inner()) = None;
    upd.deferred.store(false, Ordering::SeqCst);
}

/// The user chose "Later" / "Not now" (true) or asked to restart / took it back (false): the kept package is installed at quit only after a "true".
#[tauri::command]
pub fn update_defer(upd: tauri::State<'_, UpdState>, deferred: bool) {
    upd.deferred.store(deferred, Ordering::SeqCst);
}

/// The page records in `startup.log` why a restart it was asked for did not start (QA BUG-13: nothing in the log said so).
#[tauri::command]
pub fn update_note(text: String) {
    crate::startup::line("update", &text.chars().take(300).collect::<String>());
}

// ---------- install ----------

/// Written before the installer is started (the installer ends this process, so nothing can be written afterwards): which version was
/// running and which one is being installed. The next start reads it (`startup_state`).
fn remember_install(db: &Db, current: &str, version: &str, draft_saved: bool) {
    let c = lock(db);
    let _ = db::set_setting(&c, "update_installing", &format!("{current}>{version}"));
    if draft_saved {
        let _ = db::set_setting(&c, "update_restart_draft", "1");
    }
    // (the log is the data folder's `startup.log`: the one record a release build keeps, for the QA of the next start)
    crate::startup::line("update", &format!("install of {version} started from {current}: marker written{}", if draft_saved { " (a draft was saved for the restart)" } else { "" }));
}

/// The installer did not start (or refused): nothing is going to be installed, so the next start has nothing to report.
fn forget_install(db: &Db) {
    let c = lock(db);
    let _ = db::set_setting(&c, "update_installing", "");
    let _ = db::set_setting(&c, "update_restart_draft", "");
}

/// Install the downloaded package. Windows: the plugin starts the installer and exits the app (the installer starts the new
/// version when `restart`). macOS / Linux: the package is replaced, then the app restarts or exits.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: tauri::State<'_, AppState>, upd: tauri::State<'_, UpdState>, restart: bool, draft_saved: bool) -> R<()> {
    refuse_if_managed()?;
    let (update, bytes) = upd.ready.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or("UPDATE_NONE_READY: No update is ready to install.")?;
    upd.deferred.store(false, Ordering::SeqCst);
    let db = state.db.clone();
    let current = app.package_info().version.to_string();
    remember_install(&db, &current, &update.version, draft_saved);
    crate::flush_pending(&app);
    let u = update.clone().restart_after_install(restart);
    let (result, bytes) = tauri::async_runtime::spawn_blocking(move || (u.install(&bytes), bytes)).await.map_err(|e| short(&e.to_string()))?;
    match result {
        Ok(()) => {
            // only reached on macOS / Linux: on Windows the plugin exits the app inside `install`
            if restart {
                app.restart()
            }
            app.exit(0);
            Ok(())
        }
        Err(e) => {
            // the package stays ready so that "Try again" installs the same bytes
            *upd.ready.lock().unwrap_or_else(|p| p.into_inner()) = Some((update, bytes));
            forget_install(&db);
            Err(short(&e.to_string()))
        }
    }
}

/// The user chose "Later" in this run: install what is kept when the app ends (every exit path ends in `ExitRequested` / `Exit`).
pub fn install_on_exit(app: &AppHandle) {
    let Some(upd) = app.try_state::<UpdState>() else { return };
    let Some((update, bytes)) = upd.take_for_exit() else { return };
    let db = app.state::<AppState>().db.clone();
    remember_install(&db, &app.package_info().version.to_string(), &update.version, false);
    crate::flush_pending(app);
    if let Err(e) = update.restart_after_install(false).install(&bytes) {
        crate::startup::line("update", &format!("the install on quit failed: {e}"));
        forget_install(&db);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupState {
    /// "updated" | "failed" | null
    pub outcome: Option<String>,
    pub version: Option<String>,
    pub draft: bool,
}

/// After an update restart: what happened to the install that was started last time. The marker stays until the page says it showed
/// the result (`update_startup_ack`): when the web view dies before the person saw it (the app then restarts itself), the next start
/// tells it again. Also drops a stale consent.
#[tauri::command]
pub fn update_startup_state(app: AppHandle, state: tauri::State<'_, AppState>) -> StartupState {
    let out = startup_state(&state.db, &app.package_info().version.to_string());
    crate::startup::line(
        "update",
        &match (&out.outcome, &out.version) {
            (Some(o), Some(v)) => format!("this start follows an install of {v}: running {}, outcome \"{o}\", the page is told", app.package_info().version),
            _ => "this start follows no install (no marker)".to_string(),
        },
    );
    out
}

/// The page showed the result of the last install: the marker is cleared, so it is told once.
#[tauri::command]
pub fn update_startup_ack(state: tauri::State<'_, AppState>) {
    forget_install(&state.db);
    crate::startup::line("update", "the page showed the install result: marker cleared");
}

fn startup_state(db: &Db, current: &str) -> StartupState {
    let c = lock(db);
    let installing = db::get_setting(&c, "update_installing").filter(|s| !s.is_empty());
    let draft = db::get_setting(&c, "update_restart_draft").as_deref() == Some("1");
    let running = parse_version(current);
    let mut out = StartupState { outcome: None, version: None, draft: false };
    if let Some(s) = installing {
        if let Some((_, target)) = s.split_once('>') {
            let ok = matches!((parse_version(target), &running), (Some(t), Some(r)) if *r >= t);
            out = StartupState { outcome: Some(if ok { "updated" } else { "failed" }.into()), version: Some(target.to_string()), draft: ok && draft };
        } else {
            // not a marker this version wrote: nothing to tell, and nothing to keep
            let _ = db::set_setting(&c, "update_installing", "");
        }
    }
    if let (Some(cons), Some(r)) = (db::get_setting(&c, "update_consent").and_then(|v| parse_version(&v)), &running) {
        if *r >= cons {
            let _ = db::set_setting(&c, "update_consent", "");
        }
    }
    out
}

/// A scheduled message is being delivered right now (the restart waits for it).
#[tauri::command]
pub fn outbox_busy(state: tauri::State<'_, AppState>) -> bool {
    lock(&state.db).query_row("SELECT COUNT(*) FROM outbox WHERE status='sending'", [], |r| r.get::<_, i64>(0)).map(|n| n > 0).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicUsize;

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
    fn update_url_rules() {
        assert!(update_url_ok(GOOD, "1.0.0", false));
        assert!(update_url_ok("https://GITHUB.com/thnonl/hey-look/releases/download/v1.0.0/x.exe", "1.0.0", false));
        // the tag has to be v<version> of the update
        assert!(!update_url_ok(GOOD, "1.0.1", false));
        assert!(!update_url_ok("https://github.com/thnonl/hey-look/releases/download/v1.0.1/x.exe", "1.0.0", false));
        for bad in [
            "https://evil.example/thnonl/hey-look/releases/download/v1.0.0/x.exe",
            "https://github.com/other/repo/releases/download/v1.0.0/x.exe",
            "http://github.com/thnonl/hey-look/releases/download/v1.0.0/x.exe",
            "https://github.com.evil.example/thnonl/hey-look/releases/download/v1.0.0/x.exe",
            "https://github.com@evil.example/thnonl/hey-look/releases/download/v1.0.0/x.exe",
            "https://user:pw@github.com/thnonl/hey-look/releases/download/v1.0.0/x.exe",
            "https://github.com:444/thnonl/hey-look/releases/download/v1.0.0/x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1.0.0/../../../x",
            "https://github.com/thnonl/hey-look/releases/download/v1.0.0/%2e%2e/x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1.0.0/%2E%2E/x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1.0.0/x.exe?a=b",
            "https://github.com/thnonl/hey-look/releases/download/v1.0.0/x.exe#f",
            "https://github.com/thnonl/hey-look/releases/download//x.exe",
            "https://github.com/thnonl/hey-look/releases/download/v1.0.0",
            "https://github.com/thnonl/hey-look/releases/download/v1.0.0/a/b",
            "https://github.com/thnonl/hey-look/archive/v1.0.0/x.exe",
            "https://github.com/thnonl/hey-look\\releases/download/v1.0.0/x.exe",
            "not a url",
            "",
            "http://127.0.0.1:8787/x.exe",
            "http://localhost:8787/x.exe",
        ] {
            assert!(!update_url_ok(bad, "1.0.0", false), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn localhost_links_only_with_the_debug_override() {
        assert!(update_url_ok("http://127.0.0.1:8787/x.exe", "1.0.0", true));
        assert!(update_url_ok("http://localhost:8787/dir/x.exe", "1.0.0", true));
        assert!(update_url_ok(GOOD, "1.0.0", true));
        for bad in [
            "http://127.0.0.1/x.exe",
            "http://evil.example:8787/x.exe",
            "http://127.0.0.1.evil.example:8787/x.exe",
            "http://user@127.0.0.1:8787/x.exe",
            "ftp://127.0.0.1:8787/x.exe",
            "http://127.0.0.1:8787/../x.exe",
        ] {
            assert!(!update_url_ok(bad, "1.0.0", true), "{bad:?} should be rejected even with the override");
        }
    }

    // ---------- throttle, cache, notes ----------

    #[test]
    fn due_boundaries() {
        use Trigger::*;
        let now = 1_000_000;
        assert!(due(Manual, now, Some(now), true));
        assert!(due(Manual, now, Some(now), false));
        // a launch: 5 minutes after the last attempt, whatever it said
        for ok in [true, false] {
            assert!(!due(Startup, now, Some(now), ok));
            assert!(!due(Startup, now, Some(now - 299), ok));
            assert!(due(Startup, now, Some(now - 300), ok));
        }
        // a window that comes back: 2 h, 15 minutes after a failed attempt
        assert!(!due(Shown, now, Some(now - 7199), true));
        assert!(due(Shown, now, Some(now - 7200), true));
        assert!(!due(Shown, now, Some(now - 899), false));
        assert!(due(Shown, now, Some(now - 900), false));
        // missing or in the future
        for t in [Startup, Shown] {
            assert!(due(t, now, None, true));
            assert!(due(t, now, Some(now + 5), true));
        }
        assert_eq!((gap_secs(Startup, true), gap_secs(Startup, false)), (300, 300));
        assert_eq!((gap_secs(Shown, true), gap_secs(Shown, false)), (7200, 900));
    }

    #[test]
    fn a_status_is_a_missing_release_only_when_it_is_404_or_410() {
        assert_eq!(status_kind(200), None);
        assert_eq!(status_kind(204), None);
        assert_eq!(status_kind(404), Some((Kind::NoRelease, None)));
        assert_eq!(status_kind(410), Some((Kind::NoRelease, None)));
        for code in [403u16, 429, 500, 502, 503, 504, 400, 401] {
            assert_eq!(status_kind(code), Some((Kind::Error, Some(format!("HTTP {code}")))), "{code}");
        }
    }

    #[test]
    fn the_manifest_keys_are_the_ones_the_updater_plugin_tries() {
        let p = |os: &str, arch: &str, installer: &str| Platform { os: os.into(), arch: arch.into(), installer: installer.into(), label: String::new() };
        assert_eq!(manifest_keys(&p("macos", "arm64", "app")), ["darwin-aarch64-app", "darwin-aarch64"]);
        assert_eq!(manifest_keys(&p("macos", "x64", "app")), ["darwin-x86_64-app", "darwin-x86_64"]);
        assert_eq!(manifest_keys(&p("windows", "x64", "nsis")), ["windows-x86_64-nsis", "windows-x86_64"]);
        assert_eq!(manifest_keys(&p("windows", "x64", "msi")), ["windows-x86_64-msi", "windows-x86_64"]);
        assert_eq!(manifest_keys(&p("linux", "x64", "deb")), ["linux-x86_64-deb", "linux-x86_64"]);
        // a copy whose bundle type is unknown looks for the plain key only
        assert_eq!(manifest_keys(&p("macos", "arm64", "unknown")), ["darwin-aarch64"]);
    }

    /// Every key the app can ask for exists in what the release workflow publishes (`make-latest-json.cjs`), for the universal macOS
    #[test]
    fn managed_store_from_the_sandbox_variables() {
        use std::path::Path;
        let root = Path::new("/snap/hey-look/42");
        let inside = Path::new("/snap/hey-look/42/usr/bin/hey-look");
        let outside = Path::new("/usr/bin/hey-look");
        let cases: [(Option<&str>, Option<&Path>, Option<&Path>, Option<&str>, &str); 8] = [
            (None, None, Some(outside), None, "AppImage, .deb, .rpm, Windows, macOS: no variables"),
            (Some("hey-look"), Some(root), Some(inside), Some("snap"), "the Hey Look! snap"),
            (Some("code"), Some(Path::new("/snap/code/1")), Some(outside), None, "a .deb started from a terminal that is a classic snap"),
            (Some("hey-look"), None, Some(outside), None, "SNAP_NAME alone (set by hand)"),
            (Some("hey-look"), Some(root), Some(outside), None, "the variables of the snap but the binary of the .deb"),
            (Some("hey-look"), Some(Path::new("")), Some(inside), None, "an empty SNAP"),
            (Some("hey-look"), Some(root), None, None, "the executable path is unknown"),
            (Some("HEY-LOOK"), Some(root), Some(inside), None, "the name is compared exactly"),
        ];
        for (name, snap, exe, want, why) in cases {
            assert_eq!(managed_by_env(name, snap, exe), want, "{why}");
        }
    }

    fn src(name: &str, text: &str) -> AptSource {
        AptSource { name: name.to_string(), text: text.to_string() }
    }

    /// WP15: the .deb is managed by apt when an enabled source for the Hey Look! repository exists, in the one-line and in the deb822 format.
    #[test]
    fn apt_source_one_line_and_deb822() {
        let cases: Vec<(AptSource, bool, &str)> = vec![
            (src("heylook.list", "deb [arch=amd64 signed-by=/etc/apt/keyrings/heylook-archive-keyring.gpg] https://heylook.namthai.site/apt stable main\n"), true, "one line, https, options"),
            (src("heylook.list", "deb https://heylook.namthai.site/apt/ stable main\n"), true, "a trailing slash"),
            (src("heylook.list", "  deb http://heylook.namthai.site/apt stable main # my comment\n"), true, "http, leading spaces, comment after"),
            (src("heylook.list", "deb https://HeyLook.NamThai.Site/apt stable main\n"), true, "the host is not case sensitive"),
            (src("sources.list", "deb http://archive.ubuntu.com/ubuntu jammy main\ndeb https://heylook.namthai.site/apt stable main\n"), true, "the line after other lines"),
            (src("heylook.list", "# deb https://heylook.namthai.site/apt stable main\n"), false, "a commented line"),
            (src("heylook.list", "deb-src https://heylook.namthai.site/apt stable main\n"), false, "deb-src only"),
            (src("heylook.list", "deb https://example.org/heylook.namthai.site/apt stable main\n"), false, "the address inside another address"),
            (src("heylook.list", "deb https://heylook.namthai.site/apt-extra stable main\n"), false, "another path that starts the same"),
            (src("heylook.list", "deb https://heylook.namthai.site/ stable main\n"), false, "the site without /apt"),
            (src("other.list", "deb https://mirror.example.org/apt stable main\n"), false, "another host"),
            (src("heylook.sources", "Types: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nComponents: main\nSigned-By: /etc/apt/keyrings/heylook-archive-keyring.gpg\n"), true, "deb822 as the page writes it"),
            (src("heylook.sources", "Types: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nComponents: main\nEnabled: yes\n"), true, "deb822 with Enabled: yes"),
            (src("heylook.sources", "Types: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nComponents: main\nEnabled: no\n"), false, "deb822 with Enabled: no"),
            (src("heylook.sources", "Types: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nComponents: main\nenabled: No\n"), false, "field names and the answer are not case sensitive"),
            (src("heylook.sources", "Types: deb-src\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nComponents: main\n"), false, "deb822 deb-src only"),
            (src("heylook.sources", "Types: deb deb-src\nURIs: http://heylook.namthai.site/apt\nSuites: stable\nComponents: main\n"), true, "deb822 with both types, http"),
            (src("heylook.sources", "Types: deb\nURIs: https://other.example.org/x\n https://heylook.namthai.site/apt/\nSuites: stable\n"), true, "the address on a continuation line"),
            (src("heylook.sources", "Types: deb\nURIs: https://other.example.org/x\nSuites: stable\n\nTypes: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nEnabled: no\n"), false, "the second stanza is switched off"),
            (src("heylook.sources", "Types: deb\nURIs: https://other.example.org/x\nSuites: stable\n\nTypes: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\n"), true, "the second stanza"),
            (src("heylook.sources", "# Types: deb\n# URIs: https://heylook.namthai.site/apt\n"), false, "deb822 all commented"),
            (src("heylook.sources", "Types: deb\nURIs: https://mirror.example.org/\nSuites: stable\n"), false, "deb822, another host"),
            (src("heylook.sources", ""), false, "an empty file"),
        ];
        for (file, want, why) in &cases {
            assert_eq!(apt_source_enabled(file), *want, "{why}");
        }
    }

    /// WP15: the bundle type, the snap and the sources together.
    #[test]
    fn managed_from_bundle_snap_and_sources() {
        let on = vec![src("heylook.sources", "Types: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nComponents: main\n")];
        let off = vec![src("heylook.sources", "Types: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\nComponents: main\nEnabled: no\n")];
        assert_eq!(managed_from(None, false, true, &on), Some("apt"), ".deb with the repository");
        assert_eq!(managed_from(None, false, true, &off), None, ".deb with the source switched off keeps its own updater");
        assert_eq!(managed_from(None, false, true, &[]), None, ".deb without the repository keeps its own updater");
        assert_eq!(managed_from(None, false, false, &on), None, "AppImage or .rpm with the source present is not managed by apt");
        assert_eq!(managed_from(Some("snap"), false, true, &on), Some("snap"), "the snap wins");
        assert_eq!(managed_from(Some("snap"), false, false, &[]), Some("snap"), "the snap without sources");
        // WP14 WA.2.5: the Microsoft Store package is updated by the Store, whatever else is true
        assert_eq!(managed_from(None, true, false, &[]), Some("msstore"), "a package: the Store updates it");
        assert_eq!(managed_from(None, true, true, &on), Some("msstore"), "a package wins over apt (it cannot be a .deb, but the order is fixed)");
        assert_eq!(managed_from(Some("snap"), true, false, &[]), Some("snap"), "the snap wins");
        assert_eq!(managed_from(None, false, false, &[]), None, "an unpackaged Windows or macOS copy updates itself");
    }

    /// WP15: the files of /etc/apt are read as they are: sources.list, *.list and *.sources of sources.list.d, nothing else; a file that
    /// cannot be read as text is skipped without a failure; a missing folder gives an empty list.
    #[test]
    fn apt_sources_are_read_from_the_apt_folder() {
        let etc = std::env::temp_dir().join(format!("heylook-apt-{}", uuid::Uuid::new_v4()));
        assert!(read_apt_sources(&etc).is_empty(), "a missing folder");
        let d = etc.join("sources.list.d");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(etc.join("sources.list"), "deb http://archive.ubuntu.com/ubuntu jammy main\n").unwrap();
        std::fs::write(d.join("heylook.sources"), "Types: deb\nURIs: https://heylook.namthai.site/apt\nSuites: stable\n").unwrap();
        std::fs::write(d.join("old.list.save"), "deb https://heylook.namthai.site/apt stable main\n").unwrap();
        std::fs::write(d.join("binary.list"), [0xff, 0xfe, 0x00, 0x80]).unwrap(); // not text: skipped
        std::fs::create_dir_all(d.join("a-folder.list")).unwrap(); // a folder with a .list name: skipped
        let found = read_apt_sources(&etc);
        let mut names: Vec<_> = found.iter().map(|f| f.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["heylook.sources", "sources.list"]);
        assert_eq!(managed_from(None, false, true, &found), Some("apt"));
        let _ = std::fs::remove_dir_all(&etc);
    }

    /// WP15: `HEYLOOK_TEST_MANAGED` is read only in debug builds: the read sits inside a `#[cfg(debug_assertions)]` block (the release
    /// workflow also searches the built app for the name, .github/scripts/check-no-test-bridge.cjs).
    #[test]
    fn test_managed_switch_is_debug_only() {
        let src = include_str!("update.rs");
        let f = src.find("fn test_managed()").expect("test_managed exists");
        let var = f + src[f..].find("HEYLOOK_TEST_MANAGED").expect("the variable is read");
        let gate = src[f..var].rfind("#[cfg(debug_assertions)]").expect("a debug-only gate before the read");
        assert!(gate < var - f, "the gate is before the read");
        let read = format!("env::var(\"{}\")", ["HEYLOOK", "TEST", "MANAGED"].join("_")); // (spelled in pieces: this test must not count itself)
        assert_eq!(src.matches(&read).count(), 1, "one place reads it");
    }

    /// A managed copy answers `Managed` to every trigger without one request, whatever the manifest says, and keeps nothing.
    #[test]
    fn managed_copy_never_asks_the_server() {
        let s = manifest_stub(manifest("9.9.9", "https://github.com/thnonl/hey-look/releases/download/v9.9.9/x"));
        let app = app_for(&format!("{}/latest.json", s.base));
        let db = new_db();
        let mut c = ctx(&s.base, 1, "1.0.0");
        // (the snap, the APT repository and, WP14, the Microsoft Store package: whoever manages the copy, the app asks nobody)
        for store in ["snap", "apt", "msstore"] {
            c.managed = Some(store);
            for t in [Trigger::Startup, Trigger::Manual, Trigger::Shown] {
                let r = run(&app, &db, &AtomicBool::new(false), &c, t);
                assert_eq!((r.kind, r.info.is_none(), r.from_cache), (Kind::Managed, true, false), "{store} {t:?}");
            }
        }
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(s.count("/latest.json"), 0, "no request");
        assert_eq!(read_last_check(&db), None, "nothing stored");
        c.managed = None;
        assert_eq!(run(&app, &db, &AtomicBool::new(false), &c, Trigger::Manual).kind, Kind::Available, "the same context without a store asks");
    }

    /// build on both CPUs and for every installer type we ship. The same list is asserted from the other side by
    /// scripts/test-latest-json-keys.mjs, with a manifest the script really generates.
    #[test]
    fn every_key_the_app_asks_for_is_published_by_the_release_script() {
        let script = include_str!("../../.github/scripts/make-latest-json.cjs");
        let published: Vec<&str> = script
            .lines()
            .filter_map(|l| l.trim().strip_prefix('"')?.split_once("\": \"").map(|(k, _)| k))
            .filter(|k| k.contains('-'))
            .collect();
        assert!(published.contains(&"darwin-aarch64-app") && published.contains(&"windows-x86_64-nsis"), "parsed the script: {published:?}");
        for (os, arch, installer) in [
            ("macos", "arm64", "app"),
            ("macos", "x64", "app"),
            ("macos", "arm64", "unknown"),
            ("windows", "x64", "nsis"),
            ("windows", "x64", "msi"),
            ("linux", "x64", "appimage"),
            ("linux", "x64", "deb"),
            ("linux", "x64", "rpm"),
        ] {
            let platform = Platform { os: os.into(), arch: arch.into(), installer: installer.into(), label: String::new() };
            for key in manifest_keys(&platform) {
                assert!(published.contains(&key.as_str()), "{os} {arch} {installer}: the app asks for {key}, the release does not publish it");
            }
        }
    }

    #[test]
    fn the_log_tells_what_the_stored_answer_and_the_new_answer_are() {
        let db = new_db();
        let c = ctx("http://127.0.0.1:1", 10, "1.0.3");
        assert_eq!(cached_offer(&db, &c), "none");
        db::set_setting(&lock(&db), "update_cache", &cache("1.0.3", Kind::UpToDate, "1.0.3")).unwrap();
        assert_eq!(cached_offer(&db, &c), "up to date (latest 1.0.3)");
        db::set_setting(&lock(&db), "update_cache", &cache("1.0.3", Kind::Available, "1.0.4")).unwrap();
        assert_eq!(cached_offer(&db, &c), "available 1.0.4");
        db::set_setting(&lock(&db), "update_cache", &cache("1.0.2", Kind::Available, "1.0.4")).unwrap();
        assert!(cached_offer(&db, &c).starts_with("none (the stored answer is for another version"));
        let mut r = c.result(Kind::Available, Some(10));
        r.info = Some(info("1.0.4"));
        assert_eq!(answer_text(&r), "available 1.0.4 (running 1.0.3); installer for this system: none in the manifest");
        r.kind = Kind::Error;
        r.message = Some("boom".into());
        assert_eq!(answer_text(&r), "error: boom");
        r.kind = Kind::Offline;
        assert!(answer_text(&r).starts_with("offline"));
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
        UpdateInfo { latest: latest.into(), notes: "n".into(), notes_truncated: false, published_at: Some(5), release_url: format!("{RELEASES_PAGE}v{latest}"), asset: None }
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
    fn platform_names_are_known() {
        let p = platform_info();
        assert!(["nsis", "msi", "app", "appimage", "deb", "rpm", "unknown"].contains(&p.installer.as_str()));
        assert!(!p.label.is_empty() && !p.arch.is_empty());
    }

    #[test]
    fn unknown_trigger_is_refused() {
        assert!(Trigger::parse("startup").is_some());
        assert!(Trigger::parse("shown").is_some());
        assert!(Trigger::parse("manual").is_some());
        assert!(Trigger::parse("now").is_none());
    }

    // ---------- the install marker (QA BUG-12: no success toast after an update) ----------

    /// A database file in its own folder, the way the app has it: the process that writes the marker ends (the installer takes over),
    /// the next start opens the file again.
    fn data_folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("heylook-marker-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn open_db(dir: &std::path::Path) -> Db {
        Arc::new(Mutex::new(db::open(&dir.join("heylook.db")).unwrap()))
    }

    fn marker(db: &Db) -> String {
        db::get_setting(&lock(db), "update_installing").unwrap_or_default()
    }

    #[test]
    fn the_marker_is_written_before_the_installer_starts_and_is_there_at_the_next_start() {
        let dir = data_folder("lifecycle");
        {
            // the running 0.9.0: marker first (`update_install` and `install_on_exit` call this before `install`, which ends the process)
            let db = open_db(&dir);
            assert_eq!(startup_state(&db, "0.9.0").outcome, None, "nothing started yet");
            remember_install(&db, "0.9.0", "1.0.0", false);
            assert_eq!(marker(&db), "0.9.0>1.0.0");
            // the process ends here without closing anything (`std::process::exit` inside the plugin): the connection is only dropped
        }
        // the next start (the new version) opens the same file
        let db = open_db(&dir);
        assert_eq!(marker(&db), "0.9.0>1.0.0", "the marker survived the end of the process");
        let s = startup_state(&db, "1.0.0");
        assert_eq!((s.outcome.as_deref(), s.version.as_deref(), s.draft), (Some("updated"), Some("1.0.0"), false));
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_result_is_told_until_the_page_has_shown_it_and_then_never_again() {
        let dir = data_folder("once");
        let db = open_db(&dir);
        remember_install(&db, "0.9.0", "1.0.0", true);
        // the page asked, then its web view died before it could show anything (the app restarts itself): the next start tells it again
        let first = startup_state(&db, "1.0.0");
        assert_eq!((first.outcome.as_deref(), first.draft), (Some("updated"), true));
        let again = startup_state(&db, "1.0.0");
        assert_eq!((again.outcome.as_deref(), again.version.as_deref(), again.draft), (Some("updated"), Some("1.0.0"), true), "not told yet: told again");
        // the page showed the toast and said so
        forget_install(&db);
        assert_eq!(marker(&db), "");
        assert_eq!(db::get_setting(&lock(&db), "update_restart_draft").unwrap_or_default(), "");
        assert_eq!(startup_state(&db, "1.0.0").outcome, None, "told once");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_install_that_did_not_finish_is_told_as_such_with_the_target_version() {
        let dir = data_folder("partial");
        let db = open_db(&dir);
        db::set_setting(&lock(&db), "update_consent", "1.0.0").unwrap();
        remember_install(&db, "0.9.0", "1.0.0", false);
        // the installer ran but the old version is still what runs (cancelled, refused, partial)
        let s = startup_state(&db, "0.9.0");
        assert_eq!((s.outcome.as_deref(), s.version.as_deref(), s.draft), (Some("failed"), Some("1.0.0"), false));
        assert_eq!(db::get_setting(&lock(&db), "update_consent").unwrap_or_default(), "1.0.0", "a consent for a version that is not running stays");
        // an older build than the target is the same
        assert_eq!(startup_state(&db, "0.9.5").outcome.as_deref(), Some("failed"));
        // a draft is only promised when the update really happened
        remember_install(&db, "0.9.0", "1.0.0", true);
        assert!(!startup_state(&db, "0.9.0").draft);
        assert!(startup_state(&db, "1.0.0").draft);
        // a newer build than the target counts as updated (a second update ran in between)
        assert_eq!(startup_state(&db, "1.0.1").outcome.as_deref(), Some("updated"));
        forget_install(&db);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_installer_that_could_not_start_leaves_no_marker_behind() {
        let db: Db = Arc::new(Mutex::new(db::test_conn(&[])));
        remember_install(&db, "0.9.0", "1.0.0", true);
        // `update_install` and `install_on_exit` call this when `install` returns an error: the package stays ready for "Try again"
        forget_install(&db);
        assert_eq!(startup_state(&db, "0.9.0").outcome, None, "no \"didn't finish\" toast for an install that never began");
    }

    #[test]
    fn a_marker_of_another_shape_or_with_a_version_that_does_not_parse_is_dropped_or_ignored() {
        let db: Db = Arc::new(Mutex::new(db::test_conn(&[])));
        db::set_setting(&lock(&db), "update_installing", "garbage").unwrap();
        assert_eq!(startup_state(&db, "1.0.0").outcome, None);
        assert_eq!(marker(&db), "", "not kept");
        db::set_setting(&lock(&db), "update_installing", "0.9.0>banana").unwrap();
        // a target that is no version cannot be compared: told as not finished rather than as done
        assert_eq!(startup_state(&db, "1.0.0").outcome.as_deref(), Some("failed"));
    }

    #[test]
    fn the_marker_is_compared_with_the_version_that_runs_not_with_a_cached_check() {
        // the update check keeps the version it saw (`update_cache` still says 0.9.0 after the update): the result must not depend on it
        let db: Db = Arc::new(Mutex::new(db::test_conn(&[])));
        db::set_setting(&lock(&db), "update_cache", r#"{"current":"0.9.0","latest":"1.0.0"}"#).unwrap();
        remember_install(&db, "0.9.0", "1.0.0", false);
        assert_eq!(startup_state(&db, "1.0.0").outcome.as_deref(), Some("updated"));
    }

    #[test]
    fn a_legacy_consent_of_a_version_that_runs_is_cleared_at_the_start() {
        let db: Db = Arc::new(Mutex::new(db::test_conn(&[])));
        db::set_setting(&lock(&db), "update_consent", "1.0.0").unwrap();
        assert_eq!(startup_state(&db, "1.0.0").outcome, None);
        assert_eq!(db::get_setting(&lock(&db), "update_consent").unwrap_or_default(), "");
    }

    #[test]
    fn the_install_paths_write_the_marker_first_and_clear_it_only_when_the_installer_failed() {
        // `install()` ends the process on Windows, so the order inside both callers is what keeps the marker: write, then install, and
        // forget only in the error branch
        let src = include_str!("update.rs").replace('\r', "");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        for func in ["pub async fn update_install", "pub fn install_on_exit"] {
            let body = &code[code.find(func).unwrap()..];
            let body = &body[..body[1..].find("\n}\n").unwrap()];
            let remember = body.find("remember_install(").unwrap_or_else(|| panic!("{func}: no marker written"));
            let install = body.find(".install(").unwrap_or_else(|| panic!("{func}: no install call"));
            let forget = body.find("forget_install(").unwrap_or_else(|| panic!("{func}: no clean-up"));
            assert!(remember < install && install < forget, "{func}: write, install, then (on failure) forget");
            assert_eq!(body.matches("forget_install(").count(), 1, "{func}: the marker is cleared in one place only, the error branch");
        }
    }

    // ---------- stub server + mock app ----------

    struct Resp {
        raw: Vec<u8>,
        delay: Duration,
        /// keep the connection open this long after writing (a stalled download)
        hold: Duration,
    }

    fn resp(raw: impl Into<Vec<u8>>) -> Resp {
        Resp { raw: raw.into(), delay: Duration::ZERO, hold: Duration::ZERO }
    }

    fn http(status: u16, headers: &[(&str, &str)], body: &str) -> Vec<u8> {
        let mut s = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for (k, v) in headers {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
        s.push_str("\r\n");
        s.push_str(body);
        s.into_bytes()
    }

    struct Stub {
        base: String,
        hits: Arc<Mutex<Vec<String>>>,
        /// `update_last_check` as the stub saw it when the first request arrived
        seen_last_check: Arc<Mutex<Option<String>>>,
    }

    impl Stub {
        fn count(&self, path: &str) -> usize {
            self.hits.lock().unwrap().iter().filter(|p| p.as_str() == path).count()
        }
    }

    fn stub(handler: impl Fn(&str) -> Resp + Send + Sync + 'static, db: Option<Db>) -> Stub {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = Arc::new(Mutex::new(None));
        let (h2, s2) = (hits.clone(), seen.clone());
        let handler = Arc::new(handler);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut c) = conn else { break };
                let (h, s, handler, db) = (h2.clone(), s2.clone(), handler.clone(), db.clone());
                std::thread::spawn(move || {
                    let mut buf = vec![0u8; 8192];
                    let mut got = 0;
                    loop {
                        let n = c.read(&mut buf[got..]).unwrap_or(0);
                        got += n;
                        if n == 0 || buf[..got].windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let req = String::from_utf8_lossy(&buf[..got]).into_owned();
                    let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                    if h.lock().unwrap().is_empty() {
                        if let Some(db) = &db {
                            *s.lock().unwrap() = db::get_setting(&lock(db), "update_last_check");
                        }
                    }
                    h.lock().unwrap().push(path.clone());
                    let r = handler(&path);
                    std::thread::sleep(r.delay);
                    let _ = c.write_all(&r.raw);
                    let _ = c.flush();
                    std::thread::sleep(r.hold);
                });
            }
        });
        Stub { base, hits, seen_last_check: seen }
    }

    fn manifest(version: &str, url: &str) -> String {
        let target = tauri_plugin_updater::target().unwrap();
        serde_json::json!({
            "version": version,
            "notes": "## Highlights\n- Faster",
            "pub_date": "2026-10-12T10:00:00Z",
            "platforms": { target: { "url": url, "signature": "c2lnbmF0dXJl", "size": 10276044 } }
        })
        .to_string()
    }

    fn app_for(endpoint: &str) -> tauri::App<tauri::test::MockRuntime> {
        app_at(endpoint, "1.0.0")
    }

    /// A mock app that runs as version `current` (the plugin compares the manifest with the app's own version).
    fn app_at(endpoint: &str, current: &str) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = v(current);
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({ "pubkey": "not a real key", "endpoints": [endpoint], "requireSignedVersion": true }),
        );
        tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap()
    }

    fn new_db() -> Db {
        Arc::new(Mutex::new(db::test_conn(&[])))
    }

    fn ctx(base: &str, now: i64, current: &str) -> Ctx {
        Ctx {
            endpoint: Some(reqwest::Url::parse(&format!("{base}/latest.json")).unwrap()),
            allow_local: true,
            now,
            timeout: Duration::from_secs(5),
            current: current.into(),
            platform: platform_info(),
            managed: None,
        }
    }

    fn run(app: &tauri::App<tauri::test::MockRuntime>, db: &Db, busy: &AtomicBool, c: &Ctx, t: Trigger) -> UpdateResult {
        tauri::async_runtime::block_on(run_check(app.handle(), db, busy, false, c, t))
    }

    /// Serve `body` as the manifest and everything else as 404.
    fn manifest_stub(body: String) -> Stub {
        stub(move |p| if p == "/latest.json" { resp(http(200, &[], &body)) } else { resp(http(404, &[], "")) }, None)
    }

    fn one(response: Vec<u8>, current: &str, now: i64) -> UpdateResult {
        let s = stub(move |_| resp(response.clone()), None);
        let app = app_at(&format!("{}/latest.json", s.base), current);
        run(&app, &new_db(), &AtomicBool::new(false), &ctx(&s.base, now, current), Trigger::Manual)
    }

    #[test]
    fn stub_available_and_persistence() {
        let db = new_db();
        let s = stub(
            |p| if p == "/latest.json" { resp(http(200, &[], &manifest("1.1.0", "http://127.0.0.1:1/pkg/HeyLook_1.1.0_windows_x64-setup.exe"))) } else { resp(http(404, &[], "")) },
            Some(db.clone()),
        );
        let app = app_for(&format!("{}/latest.json", s.base));
        let r = run(&app, &db, &AtomicBool::new(false), &ctx(&s.base, 5000, "1.0.0"), Trigger::Manual);
        assert_eq!(r.kind, Kind::Available);
        let i = r.info.clone().unwrap();
        assert_eq!(i.latest, "1.1.0");
        assert_eq!(i.notes, "## Highlights\n- Faster");
        assert_eq!(i.published_at, Some(1_791_799_200));
        assert_eq!(i.release_url, "https://github.com/thnonl/hey-look/releases/tag/v1.1.0");
        let a = i.asset.unwrap();
        assert_eq!((a.name.as_str(), a.size, a.url_ok), ("HeyLook_1.1.0_windows_x64-setup.exe", Some(10276044), true));
        assert_eq!(r.checked_at, Some(5000));
        assert!(!r.from_cache);
        // the attempt was already stored when the server saw the request
        assert_eq!(s.seen_last_check.lock().unwrap().as_deref(), Some("5000"));
        let c = lock(&db);
        assert_eq!(db::get_setting(&c, "update_last_ok").as_deref(), Some("1"));
        assert!(valid_cache(db::get_setting(&c, "update_cache").as_deref(), &v("1.0.0")).is_some());
    }

    #[test]
    fn stub_asset_link_outside_the_allow_list_is_flagged() {
        let s = manifest_stub(manifest("1.1.0", "http://127.0.0.1:1/x.exe"));
        let app = app_for(&format!("{}/latest.json", s.base));
        let mut c = ctx(&s.base, 1, "1.0.0");
        c.allow_local = false;
        let r = run(&app, &new_db(), &AtomicBool::new(false), &c, Trigger::Manual);
        assert_eq!(r.kind, Kind::Available);
        assert!(!r.info.unwrap().asset.unwrap().url_ok);
    }

    #[test]
    fn stub_up_to_date_and_newer_build() {
        let m = manifest("1.1.0", "https://github.com/thnonl/hey-look/releases/download/v1.1.0/x.exe");
        let r = one(http(200, &[], &m), "1.1.0", 1);
        assert_eq!(r.kind, Kind::UpToDate);
        assert_eq!(r.info.unwrap().latest, "1.1.0");
        let r = one(http(200, &[], &m), "1.2.0", 1);
        assert_eq!(r.kind, Kind::UpToDate);
        assert_eq!(r.info.unwrap().latest, "1.1.0");
    }

    #[test]
    fn stub_manifest_with_a_v_prefix_and_no_platform_for_us() {
        let m = serde_json::json!({ "version": "v1.1.0", "notes": null, "platforms": { "plan9-mips": { "url": "https://x", "signature": "c2ln" } } }).to_string();
        let r = one(http(200, &[], &m), "1.0.0", 1);
        assert_eq!(r.kind, Kind::Available);
        let i = r.info.unwrap();
        assert_eq!((i.latest.as_str(), i.notes.as_str(), i.asset.is_none()), ("1.1.0", "", true));
        // nothing for us and not newer: up to date
        assert_eq!(one(http(200, &[], &m), "1.1.0", 1).kind, Kind::UpToDate);
    }

    #[test]
    fn stub_statuses_and_garbage() {
        assert_eq!(one(http(404, &[], "{}"), "1.0.0", 100).kind, Kind::NoRelease);
        // a server that cannot answer now is an error, not "no release" (F-20 follow-up)
        let r = one(http(500, &[], "{}"), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("HTTP 500")));
        let r = one(http(403, &[("x-ratelimit-remaining", "0")], "{}"), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("HTTP 403")));
        let r = one(http(200, &[], "<html>login</html>"), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("GitHub sent an unexpected answer")));
        let r = one(http(200, &[], &manifest("banana", "https://x/y")), "1.0.0", 100);
        assert_eq!((r.kind, r.message.as_deref()), (Kind::Error, Some("GitHub sent an unexpected answer")));
        assert_eq!(one(http(204, &[], ""), "1.0.0", 100).kind, Kind::UpToDate);
    }

    #[test]
    fn one_check_is_one_request_whatever_the_answer() {
        // the answer of Python's http.server for a missing file (HTTP/1.0, an HTML body). QA saw two log lines per 404 from such a server: that server
        // logs an error response twice (log_error + log_request); counted at the socket the app makes exactly one request
        let py404 = "<!DOCTYPE HTML><html><head><title>Error</title></head><body><h1>Error response</h1><p>Error code: 404</p></body></html>";
        let py = format!("HTTP/1.0 404 File not found
Server: SimpleHTTP/0.6 Python/3.13.0
Connection: close
Content-Type: text/html;charset=utf-8
Content-Length: {}

{py404}", py404.len());
        let s = stub(move |_| resp(py.clone().into_bytes()), None);
        let app = app_for(&format!("{}/latest.json", s.base));
        let r = run(&app, &new_db(), &AtomicBool::new(false), &ctx(&s.base, 1, "1.0.0"), Trigger::Startup);
        std::thread::sleep(Duration::from_millis(300));
        // a status that is not a success costs one more request, the one that reads the status (the updater plugin only says "release not
        // found"); every other answer is one request
        assert_eq!((r.kind, s.count("/latest.json")), (Kind::NoRelease, 2), "HTTP/1.0 404: the check and the status request");
        for (status, body, requests) in [(404, "", 2), (500, "{}", 2), (429, "{}", 2), (200, "<html>", 1), (204, "", 1)] {
            let s = stub(move |_| resp(http(status, &[], body)), None);
            let app = app_for(&format!("{}/latest.json", s.base));
            run(&app, &new_db(), &AtomicBool::new(false), &ctx(&s.base, 1, "1.0.0"), Trigger::Startup);
            std::thread::sleep(Duration::from_millis(300));
            assert_eq!(s.count("/latest.json"), requests, "status {status}");
        }
    }

    #[test]
    fn stub_failures_are_remembered() {
        let db = new_db();
        let s = stub(|_| resp(http(200, &[], "<html>")), None);
        let app = app_for(&format!("{}/latest.json", s.base));
        run(&app, &db, &AtomicBool::new(false), &ctx(&s.base, 100, "1.0.0"), Trigger::Manual);
        assert_eq!(db::get_setting(&lock(&db), "update_last_ok").as_deref(), Some("0"));
        // failed attempt: a returning window asks again after 15 minutes, not before
        let busy = AtomicBool::new(false);
        assert_eq!(run(&app, &db, &busy, &ctx(&s.base, 100 + 899, "1.0.0"), Trigger::Shown).kind, Kind::Throttled);
        assert_eq!(s.count("/latest.json"), 1);
        assert_eq!(run(&app, &db, &busy, &ctx(&s.base, 100 + 900, "1.0.0"), Trigger::Shown).kind, Kind::Error);
        assert_eq!(s.count("/latest.json"), 2);
    }

    #[test]
    fn stub_offline_closed_port_and_timeout() {
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let app = app_for(&format!("{closed}/latest.json"));
        let r = run(&app, &new_db(), &AtomicBool::new(false), &ctx(&closed, 1, "1.0.0"), Trigger::Manual);
        assert_eq!(r.kind, Kind::Offline);
        // the real timeout is 15 s; the test uses a short one against a slow server
        let s = stub(|_| Resp { raw: http(200, &[], "{}"), delay: Duration::from_secs(3), hold: Duration::ZERO }, None);
        let app = app_for(&format!("{}/latest.json", s.base));
        let mut c = ctx(&s.base, 1, "1.0.0");
        c.timeout = Duration::from_millis(400);
        assert_eq!(run(&app, &new_db(), &AtomicBool::new(false), &c, Trigger::Manual).kind, Kind::Offline);
        assert_eq!(CHECK_TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn stub_sends_only_the_manifest_request() {
        let s = manifest_stub(manifest("1.0.0", "https://github.com/x"));
        let app = app_for(&format!("{}/latest.json", s.base));
        run(&app, &new_db(), &AtomicBool::new(false), &ctx(&s.base, 1, "1.0.0"), Trigger::Manual);
        assert_eq!(s.hits.lock().unwrap().as_slice(), ["/latest.json"]);
    }

    #[test]
    fn stub_concurrent_calls_make_one_request() {
        let db = new_db();
        let s = stub(|_| Resp { raw: http(200, &[], &manifest("1.1.0", "https://x/y")), delay: Duration::from_millis(600), hold: Duration::ZERO }, None);
        let app = app_for(&format!("{}/latest.json", s.base));
        let busy = Arc::new(AtomicBool::new(false));
        let c = ctx(&s.base, 100, "1.0.0");
        let handle = app.handle().clone();
        let (d1, b1, c1) = (db.clone(), busy.clone(), c.clone());
        let first = tauri::async_runtime::spawn(async move { run_check(&handle, &d1, &b1, false, &c1, Trigger::Manual).await });
        std::thread::sleep(Duration::from_millis(200));
        let second = run(&app, &db, &busy, &c, Trigger::Manual);
        assert_eq!(second.kind, Kind::Throttled);
        let first = tauri::async_runtime::block_on(first).unwrap();
        assert_eq!(first.kind, Kind::Available);
        assert_eq!(s.count("/latest.json"), 1);
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn stub_disabled_throttled_and_flow_use_the_cache() {
        let db = new_db();
        let s = manifest_stub(manifest("1.1.0", "https://github.com/thnonl/hey-look/releases/download/v1.1.0/x.exe"));
        let app = app_for(&format!("{}/latest.json", s.base));
        let busy = AtomicBool::new(false);
        let first = run(&app, &db, &busy, &ctx(&s.base, 1000, "1.0.0"), Trigger::Startup);
        assert_eq!(first.kind, Kind::Available);

        // within 2 h: no request, cached info
        let r = run(&app, &db, &busy, &ctx(&s.base, 1000 + 7199, "1.0.0"), Trigger::Shown);
        assert_eq!((r.kind, r.from_cache, r.cached_kind), (Kind::Throttled, true, Some(Kind::Available)));
        assert_eq!(r.info.as_ref().unwrap().latest, "1.1.0");
        assert_eq!(r.checked_at, Some(1000));
        assert_eq!(s.count("/latest.json"), 1);

        // another running version (an update was installed): the cache is discarded
        let r = run(&app, &db, &busy, &ctx(&s.base, 1000 + 60, "1.1.0"), Trigger::Shown);
        assert_eq!((r.kind, r.info, r.from_cache), (Kind::Throttled, None, false));

        // a download or a ready package is on its way: automatic checks stay quiet, manual ones run
        let c = ctx(&s.base, 1000 + 99999, "1.0.0");
        let r = tauri::async_runtime::block_on(run_check(app.handle(), &db, &busy, true, &c, Trigger::Startup));
        assert_eq!(r.kind, Kind::Throttled);
        assert_eq!(s.count("/latest.json"), 1);
        let r = tauri::async_runtime::block_on(run_check(app.handle(), &db, &busy, true, &c, Trigger::Manual));
        assert_eq!(r.kind, Kind::Available);
        assert_eq!(s.count("/latest.json"), 2);

        // switched off: automatic triggers make no request and write nothing; manual still works
        db::set_setting(&lock(&db), "prefs", r#"{"checkUpdates":false}"#).unwrap();
        let c = ctx(&s.base, 1000 + 99999 + 100000, "1.0.0");
        let r = run(&app, &db, &busy, &c, Trigger::Startup);
        assert_eq!((r.kind, r.from_cache), (Kind::Disabled, true));
        assert_eq!(run(&app, &db, &busy, &c, Trigger::Shown).kind, Kind::Disabled);
        assert_eq!(s.count("/latest.json"), 2);
        assert_eq!(db::get_setting(&lock(&db), "update_last_check").as_deref(), Some((1000 + 99999).to_string().as_str()));
        assert_eq!(run(&app, &db, &busy, &c, Trigger::Manual).kind, Kind::Available);
        assert_eq!(s.count("/latest.json"), 3);
    }

    /// F-20 through the whole check, on every system: the user saw "up to date" (1.0.3) a little while ago, 1.0.4 is published, the app
    /// is launched again.
    #[test]
    fn a_launch_a_little_after_a_check_asks_again_instead_of_showing_the_stored_answer() {
        let s = manifest_stub(manifest("1.0.4", "https://github.com/thnonl/hey-look/releases/download/v1.0.4/HeyLook_1.0.4_darwin_universal.app.tar.gz"));
        let app = app_at(&format!("{}/latest.json", s.base), "1.0.3");
        let db = new_db();
        let busy = AtomicBool::new(false);
        // an earlier check at t = 1000 found nothing newer: stored by hand, as a 1.0.3 check would have done
        db::set_setting(&lock(&db), "update_last_check", "1000").unwrap();
        db::set_setting(&lock(&db), "update_last_ok", "1").unwrap();
        db::set_setting(&lock(&db), "update_cache", &cache("1.0.3", Kind::UpToDate, "1.0.3")).unwrap();
        // a minute later the launch only shows the stored answer
        let r = run(&app, &db, &busy, &ctx(&s.base, 1060, "1.0.3"), Trigger::Startup);
        assert_eq!((r.kind, r.cached_kind), (Kind::Throttled, Some(Kind::UpToDate)));
        assert_eq!(s.count("/latest.json"), 0);
        // half an hour later it asks and finds the new version
        let r = run(&app, &db, &busy, &ctx(&s.base, 1000 + 1800, "1.0.3"), Trigger::Startup);
        assert_eq!((r.kind, r.info.as_ref().map(|i| i.latest.as_str())), (Kind::Available, Some("1.0.4")));
        assert_eq!(s.count("/latest.json"), 1);
        assert!(valid_cache(db::get_setting(&lock(&db), "update_cache").as_deref(), &v("1.0.3")).is_some_and(|c| c.0 == Kind::Available));
        // two launches a minute apart: the second one does not ask again
        let again = run(&app, &db, &busy, &ctx(&s.base, 1000 + 1800 + 60, "1.0.3"), Trigger::Startup);
        assert_eq!((again.kind, again.cached_kind), (Kind::Throttled, Some(Kind::Available)));
        assert_eq!(s.count("/latest.json"), 1);
    }

    /// F-20 follow-up: what each kind of answer does to the stored offer and to the retry delay. A server that cannot answer (429, 5xx, 403, a
    /// timeout) is a FAILED check: the offer the app knows stays, the attempt is recorded as failed (retry after 5 minutes for a launch, 15
    /// for a window), nothing is cleared. A 404 (there is no latest.json) is the only "no release", as before.
    #[test]
    fn a_server_that_cannot_answer_keeps_the_stored_offer_and_is_retried_soon() {
        let state = Arc::new(Mutex::new(200u16));
        let st = state.clone();
        let s = stub(
            move |_| match *st.lock().unwrap() {
                200 => resp(http(200, &[], &manifest("1.1.0", "https://github.com/thnonl/hey-look/releases/download/v1.1.0/x.exe"))),
                201 => resp(http(200, &[], &manifest("1.0.0", "https://github.com/thnonl/hey-look/releases/download/v1.0.0/x.exe"))),
                code => resp(http(code, &[], "")),
            },
            None,
        );
        let app = app_for(&format!("{}/latest.json", s.base));
        let db = new_db();
        let busy = AtomicBool::new(false);
        let at = |now: i64| ctx(&s.base, now, "1.0.0");
        // 200 with a newer version
        let r = run(&app, &db, &busy, &at(1000), Trigger::Manual);
        assert_eq!((r.kind, r.info.as_ref().map(|i| i.latest.as_str())), (Kind::Available, Some("1.1.0")));
        assert_eq!(s.count("/latest.json"), 1, "a good answer is one request");
        let offer = db::get_setting(&lock(&db), "update_cache");
        assert!(offer.as_deref().is_some_and(|c| !c.is_empty()));
        // 429, 500, 503, 403: a failed check that keeps the offer
        let mut now = 1000;
        for code in [429u16, 500, 503, 403] {
            now += 10_000;
            *state.lock().unwrap() = code;
            let before = s.count("/latest.json");
            let r = run(&app, &db, &busy, &at(now), Trigger::Shown);
            assert_eq!(r.kind, Kind::Error, "{code}");
            assert_eq!(r.message.as_deref(), Some(format!("HTTP {code}").as_str()), "{code}");
            assert_eq!((r.from_cache, r.cached_kind), (true, Some(Kind::Available)), "{code}: the offer stays");
            assert_eq!(r.info.as_ref().map(|i| i.latest.as_str()), Some("1.1.0"), "{code}");
            assert_eq!(db::get_setting(&lock(&db), "update_cache"), offer, "{code}: the stored answer is not touched");
            assert_eq!(db::get_setting(&lock(&db), "update_last_ok").as_deref(), Some("0"), "{code}: recorded as failed");
            assert_eq!(s.count("/latest.json"), before + 2, "{code}: the check and the status request");
            // the retry delay: a launch after 5 minutes, a window after 15
            let busy2 = AtomicBool::new(false);
            assert_eq!(run(&app, &db, &busy2, &at(now + 299), Trigger::Startup).kind, Kind::Throttled, "{code}");
            assert_eq!(run(&app, &db, &busy2, &at(now + 899), Trigger::Shown).kind, Kind::Throttled, "{code}");
            assert_eq!(s.count("/latest.json"), before + 2, "{code}: nothing asked before the delay");
            // the throttled answer still carries the offer, so the toast logic keeps it
            let t = run(&app, &db, &busy2, &at(now + 100), Trigger::Startup);
            assert_eq!((t.kind, t.cached_kind), (Kind::Throttled, Some(Kind::Available)), "{code}");
        }
        // a launch 5 minutes after a failure asks again and a good answer is good again
        *state.lock().unwrap() = 200;
        now += 300;
        let r = run(&app, &db, &busy, &at(now), Trigger::Startup);
        assert_eq!(r.kind, Kind::Available);
        assert_eq!(db::get_setting(&lock(&db), "update_last_ok").as_deref(), Some("1"));
        // 200 with the same version
        *state.lock().unwrap() = 201;
        now += 10_000;
        let r = run(&app, &db, &busy, &at(now), Trigger::Manual);
        assert_eq!((r.kind, r.info.as_ref().map(|i| i.latest.as_str())), (Kind::UpToDate, Some("1.0.0")));
        assert_eq!(db::get_setting(&lock(&db), "update_last_ok").as_deref(), Some("1"));
        // 404: there is no latest.json: "no release", the offer is gone
        *state.lock().unwrap() = 200;
        now += 10_000;
        assert_eq!(run(&app, &db, &busy, &at(now), Trigger::Manual).kind, Kind::Available);
        *state.lock().unwrap() = 404;
        now += 10_000;
        let r = run(&app, &db, &busy, &at(now), Trigger::Manual);
        assert_eq!((r.kind, r.info, r.from_cache), (Kind::NoRelease, None, false));
        assert!(valid_cache(db::get_setting(&lock(&db), "update_cache").as_deref(), &v("1.0.0")).is_none());
        // a timeout is offline and keeps the offer too
        *state.lock().unwrap() = 200;
        now += 10_000;
        assert_eq!(run(&app, &db, &busy, &at(now), Trigger::Manual).kind, Kind::Available);
        let slow = stub(|_| Resp { raw: http(200, &[], "{}"), delay: Duration::from_secs(3), hold: Duration::ZERO }, None);
        let slow_app = app_for(&format!("{}/latest.json", slow.base));
        let mut c = ctx(&slow.base, now + 10_000, "1.0.0");
        c.timeout = Duration::from_millis(400);
        let r = run(&slow_app, &db, &busy, &c, Trigger::Manual);
        assert_eq!((r.kind, r.from_cache, r.cached_kind), (Kind::Offline, true, Some(Kind::Available)));
        assert_eq!(db::get_setting(&lock(&db), "update_last_ok").as_deref(), Some("0"));
    }

    /// The state of a user who saw 1.1.0 and now has no connection: a manual check fails and the offer stays.
    fn db_with_offer(s: &Stub, app: &tauri::App<tauri::test::MockRuntime>) -> Db {
        let db = new_db();
        assert_eq!(run(app, &db, &AtomicBool::new(false), &ctx(&s.base, 1000, "1.0.0"), Trigger::Manual).kind, Kind::Available);
        db
    }

    #[test]
    fn a_failed_check_keeps_the_known_offer_and_never_rewrites_the_cache() {
        let state = Arc::new(Mutex::new(0u8)); // 0 = ok, 1 = garbage, 2 = 404
        let st = state.clone();
        let s = stub(
            move |_| match *st.lock().unwrap() {
                0 => resp(http(200, &[], &manifest("1.1.0", "https://github.com/thnonl/hey-look/releases/download/v1.1.0/x.exe"))),
                1 => resp(http(200, &[], "<html>captive portal</html>")),
                _ => resp(http(404, &[], "")),
            },
            None,
        );
        let app = app_for(&format!("{}/latest.json", s.base));
        let db = db_with_offer(&s, &app);
        let cache_before = db::get_setting(&lock(&db), "update_cache");
        let busy = AtomicBool::new(false);

        // error answer (not JSON): the offer is carried, flagged as cached, and the cache is untouched
        *state.lock().unwrap() = 1;
        let r = run(&app, &db, &busy, &ctx(&s.base, 2000, "1.0.0"), Trigger::Manual);
        assert_eq!(r.kind, Kind::Error);
        assert_eq!((r.from_cache, r.cached_kind), (true, Some(Kind::Available)));
        assert_eq!(r.info.as_ref().map(|i| i.latest.as_str()), Some("1.1.0"));
        assert!(r.message.is_some());
        assert_eq!(db::get_setting(&lock(&db), "update_cache"), cache_before);

        // offline (nothing listens): same
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let dead_app = app_for(&format!("{closed}/latest.json"));
        let r = run(&dead_app, &db, &busy, &ctx(&closed, 3000, "1.0.0"), Trigger::Manual);
        assert_eq!((r.kind, r.from_cache, r.cached_kind), (Kind::Offline, true, Some(Kind::Available)));
        assert_eq!(r.info.as_ref().map(|i| i.latest.as_str()), Some("1.1.0"));
        assert_eq!(db::get_setting(&lock(&db), "update_cache"), cache_before);

        // a cache for another running version, or one that is not newer, is never carried
        let r = run(&dead_app, &db, &busy, &ctx(&closed, 4000, "1.1.0"), Trigger::Manual);
        assert_eq!((r.kind, r.info, r.from_cache), (Kind::Offline, None, false));

        // an upToDate cache is not carried either (the UI shows the red notice)
        let db2 = new_db();
        let s2 = manifest_stub(manifest("1.0.0", "https://github.com/x"));
        let app2 = app_for(&format!("{}/latest.json", s2.base));
        assert_eq!(run(&app2, &db2, &busy, &ctx(&s2.base, 1000, "1.0.0"), Trigger::Manual).kind, Kind::UpToDate);
        let r = run(&dead_app, &db2, &busy, &ctx(&closed, 2000, "1.0.0"), Trigger::Manual);
        assert_eq!((r.kind, r.info, r.from_cache), (Kind::Offline, None, false));

        // no cache at all: nothing to carry
        let r = run(&dead_app, &new_db(), &busy, &ctx(&closed, 2000, "1.0.0"), Trigger::Manual);
        assert_eq!((r.kind, r.info), (Kind::Offline, None));

        // GitHub answers "no release": the offer is gone and a later throttled answer does not bring it back
        *state.lock().unwrap() = 2;
        let r = run(&app, &db, &busy, &ctx(&s.base, 5000, "1.0.0"), Trigger::Manual);
        assert_eq!((r.kind, r.info, r.from_cache), (Kind::NoRelease, None, false));
        assert!(valid_cache(db::get_setting(&lock(&db), "update_cache").as_deref(), &v("1.0.0")).is_none());
        let r = run(&app, &db, &busy, &ctx(&s.base, 5100, "1.0.0"), Trigger::Shown);
        assert_eq!((r.kind, r.info, r.from_cache), (Kind::Throttled, None, false));
    }

    #[test]
    fn a_download_only_fetches_the_version_the_user_agreed_to() {
        let (s, app, _update) = update_for(|| resp(http(200, &[], "package")));
        let c = ctx(&s.base, 1, "1.0.0");
        let run_prepare = |agreed: &str| {
            let (emit, events) = recorder();
            let got = tauri::async_runtime::block_on(prepare_download(app.handle(), &c, agreed, &emit));
            let ev = events.lock().unwrap().clone();
            (got.map(|u| u.version), ev)
        };
        // the card's version equals the one found now (a "v" prefix does not matter): the download goes on
        for agreed in ["1.1.0", "v1.1.0"] {
            let (got, ev) = run_prepare(agreed);
            assert_eq!(got.as_deref(), Some("1.1.0"));
            assert!(ev.is_empty(), "{ev:?}");
        }
        let manifest_requests = s.count("/latest.json");
        // another version: nothing is downloaded, and the UI is told which version GitHub has now
        let (got, ev) = run_prepare("1.0.5");
        assert_eq!(got, None);
        assert_eq!(ev, vec![DlEvent::Failed { stage: "changed".into(), message: "1.1.0".into() }]);
        assert_eq!(s.count("/latest.json"), manifest_requests + 1, "one fresh check");
        assert_eq!(s.count("/HeyLook_1.1.0_windows_x64-setup.exe"), 0, "no package request");
        // an unreadable version never matches
        assert_eq!(run_prepare("").0, None);
        assert!(same_version("1.2.3", "v1.2.3") && !same_version("1.2.3", "1.2.4") && !same_version("x", "x"));
    }

    #[test]
    fn a_kept_package_is_installed_at_quit_only_after_later_in_this_run() {
        let (_s, _app, update) = update_for(|| resp(http(200, &[], "hello")));
        let st = UpdState::default();
        // nothing kept: nothing to install
        assert!(st.take_for_exit().is_none());
        // downloaded and ready, but the user did not choose Later (a countdown, a prompt): quitting installs nothing
        *st.ready.lock().unwrap() = Some((update.clone(), b"bytes".to_vec()));
        assert!(st.take_for_exit().is_none());
        assert!(st.ready.lock().unwrap().is_some(), "the package is not consumed by a quit that installs nothing");
        // "Later" / "Not now" in this run
        st.deferred.store(true, Ordering::SeqCst);
        assert_eq!(st.take_for_exit().map(|(_, b)| b), Some(b"bytes".to_vec()));
        assert!(st.take_for_exit().is_none(), "installed once");
        // a restart builds a fresh state: nothing persisted can install anything
        assert!(UpdState::default().take_for_exit().is_none());
    }

    #[test]
    fn switched_off_means_no_request_and_no_cached_download_offer_to_resume() {
        let db = new_db();
        let s = manifest_stub(manifest("1.1.0", "https://github.com/thnonl/hey-look/releases/download/v1.1.0/x.exe"));
        let app = app_for(&format!("{}/latest.json", s.base));
        let busy = AtomicBool::new(false);
        assert_eq!(run(&app, &db, &busy, &ctx(&s.base, 1000, "1.0.0"), Trigger::Manual).kind, Kind::Available);
        // an old build stored a consent; it has no effect any more
        db::set_setting(&lock(&db), "update_consent", "1.1.0").unwrap();
        db::set_setting(&lock(&db), "prefs", r#"{"checkUpdates":false}"#).unwrap();
        let hits = s.count("/latest.json");
        for t in [Trigger::Startup, Trigger::Shown] {
            let r = run(&app, &db, &busy, &ctx(&s.base, 1000 + 99_999, "1.0.0"), t);
            assert_eq!(r.kind, Kind::Disabled);
        }
        assert_eq!(s.count("/latest.json"), hits, "no request at all while automatic checks are off");
    }

    #[test]
    fn bad_stored_values_count_as_missing() {
        let db = new_db();
        let s = manifest_stub(manifest("1.1.0", "https://x/y"));
        let app = app_for(&format!("{}/latest.json", s.base));
        {
            let c = lock(&db);
            db::set_setting(&c, "update_last_check", "yesterday").unwrap();
            db::set_setting(&c, "update_last_ok", "maybe").unwrap();
            db::set_setting(&c, "update_cache", "{broken").unwrap();
        }
        let r = run(&app, &db, &AtomicBool::new(false), &ctx(&s.base, 7, "1.0.0"), Trigger::Startup);
        assert_eq!(r.kind, Kind::Available);
    }

    // ---------- download ----------

    type Events = Arc<Mutex<Vec<DlEvent>>>;

    fn recorder() -> (Emit, Events) {
        let ev: Events = Arc::new(Mutex::new(vec![]));
        let e2 = ev.clone();
        (Arc::new(move |e| e2.lock().unwrap().push(e)), ev)
    }

    /// Serve a manifest whose package is answered by `package`, and get the `Update` for it.
    fn update_for(package: impl Fn() -> Resp + Send + Sync + 'static) -> (Stub, tauri::App<tauri::test::MockRuntime>, Update) {
        let base = Arc::new(Mutex::new(String::new()));
        let b2 = base.clone();
        let s = stub(
            move |p| {
                if p == "/latest.json" {
                    let url = format!("{}/HeyLook_1.1.0_windows_x64-setup.exe", b2.lock().unwrap());
                    resp(http(200, &[], &manifest("1.1.0", &url)))
                } else {
                    package()
                }
            },
            None,
        );
        *base.lock().unwrap() = s.base.clone();
        let app = app_for(&format!("{}/latest.json", s.base));
        let checked = tauri::async_runtime::block_on(check_once(app.handle(), &ctx(&s.base, 1, "1.0.0")));
        let update = checked.update.expect("an update");
        (s, app, update)
    }

    fn download(update: &Update, stall: Duration, cancel_after: Option<Duration>) -> (Result<Vec<u8>, DlEnd>, Vec<DlEvent>) {
        let (emit, events) = recorder();
        let (tx, rx) = oneshot::channel();
        let res = tauri::async_runtime::block_on(async {
            if let Some(d) = cancel_after {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(d).await;
                    let _ = tx.send(());
                });
            } else {
                std::mem::forget(tx);
            }
            download_update(update, emit, rx, stall).await
        });
        let ev = events.lock().unwrap().clone();
        (res, ev)
    }

    #[test]
    fn download_with_a_bad_signature_fails_at_verify() {
        let (_s, _app, update) = update_for(|| resp(http(200, &[], "hello")));
        let (res, ev) = download(&update, Duration::from_secs(5), None);
        assert!(matches!(res, Err(DlEnd::Failed { stage: "verify", .. })), "{res:?}");
        assert_eq!(ev.first(), Some(&DlEvent::Started { total: Some(5), version: "1.1.0".into() }));
        assert!(ev.contains(&DlEvent::Verifying));
        assert!(ev.contains(&DlEvent::Progress { received: 5 }));
    }

    #[test]
    fn download_http_error_and_dropped_connection() {
        let (_s, _app, update) = update_for(|| resp(http(404, &[], "")));
        let (res, _) = download(&update, Duration::from_secs(5), None);
        assert_eq!(res, Err(dl_failed("download", "GitHub answered 404.")));

        // promises 1000 bytes, sends 10, closes
        let (_s, _app, update) = update_for(|| {
            resp(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n0123456789".to_vec())
        });
        let (res, _) = download(&update, Duration::from_secs(5), None);
        assert_eq!(res, Err(dl_failed("download", "The connection was lost.")));
    }

    #[test]
    fn download_stall_and_cancel() {
        let slow = || Resp { raw: b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n0123456789".to_vec(), delay: Duration::ZERO, hold: Duration::from_secs(5) };
        let (_s, _app, update) = update_for(slow);
        let t0 = Instant::now();
        let (res, ev) = download(&update, Duration::from_millis(500), None);
        assert_eq!(res, Err(dl_failed("download", "The download stopped. Check your connection.")));
        assert!(t0.elapsed() < Duration::from_secs(4));
        assert!(matches!(ev.first(), Some(DlEvent::Started { total: Some(1000), .. })));

        let (_s, _app, update) = update_for(slow);
        let t0 = Instant::now();
        let (res, _) = download(&update, Duration::from_secs(30), Some(Duration::from_millis(300)));
        assert_eq!(res, Err(DlEnd::Cancelled));
        assert!(t0.elapsed() < Duration::from_secs(3));
    }

    /// QA OBS-6: a burst of data and then silence left the progress line at the first chunk (the events are throttled to 10 per second
    /// and nothing sent the last value). The UI must be told the byte count that really arrived.
    #[test]
    fn the_last_byte_count_reaches_the_ui_even_when_the_download_stalls() {
        let burst = || {
            let mut raw = b"HTTP/1.1 200 OK
Content-Length: 1000000
Connection: close

".to_vec();
            raw.extend(std::iter::repeat(b'x').take(300_000));
            Resp { raw, delay: Duration::ZERO, hold: Duration::from_secs(5) }
        };
        let (_s, _app, update) = update_for(burst);
        let (res, ev) = download(&update, Duration::from_millis(1500), None);
        assert_eq!(res, Err(dl_failed("download", "The download stopped. Check your connection.")));
        let last = ev.iter().rev().find_map(|e| if let DlEvent::Progress { received } = e { Some(*received) } else { None });
        assert_eq!(last, Some(300_000), "events: {ev:?}");
    }

    #[test]
    fn download_events_serialize_as_the_ui_expects() {
        let j = |e: DlEvent| serde_json::to_string(&e).unwrap();
        assert_eq!(j(DlEvent::Started { total: None, version: "1.1.0".into() }), r#"{"event":"started","data":{"total":null,"version":"1.1.0"}}"#);
        assert_eq!(j(DlEvent::Progress { received: 7 }), r#"{"event":"progress","data":{"received":7}}"#);
        assert_eq!(j(DlEvent::Verifying), r#"{"event":"verifying"}"#);
        assert_eq!(j(DlEvent::Failed { stage: "verify".into(), message: "m".into() }), r#"{"event":"failed","data":{"stage":"verify","message":"m"}}"#);
    }

    #[test]
    fn busy_flag_is_released() {
        let f = AtomicBool::new(false);
        {
            let g = try_flag(&f);
            assert!(g.is_some() && try_flag(&f).is_none());
        }
        assert!(try_flag(&f).is_some());
        let _ = AtomicUsize::new(0);
    }
}
