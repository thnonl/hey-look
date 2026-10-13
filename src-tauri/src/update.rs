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
    Error,
    /// internal: automatic checks are off
    Disabled,
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

/// How this copy of the app was installed (the bundler patches the bundle type into the binary).
pub fn platform_info() -> Platform {
    use tauri::utils::config::BundleType as B;
    let os = std::env::consts::OS;
    let installer = match tauri::utils::platform::bundle_type() {
        Some(B::Nsis) => "nsis",
        Some(B::Msi) => "msi",
        Some(B::App) | Some(B::Dmg) => "app",
        Some(B::AppImage) => "appimage",
        Some(B::Deb) => "deb",
        Some(B::Rpm) => "rpm",
        None => "unknown",
    };
    let label = match (os, installer) {
        ("windows", "msi") => "Windows (MSI)".to_string(),
        ("windows", _) => "Windows".to_string(),
        ("macos", _) => "macOS".to_string(),
        ("linux", "deb") => "Linux (.deb)".to_string(),
        ("linux", "rpm") => "Linux (.rpm)".to_string(),
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
        Err(e) => failed(ctx, &e),
    }
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

/// The whole check: guard, switch, throttle, bookkeeping, request. `busy` is the in-flight guard; `ctx` carries the manifest
/// URL and the clock (tests inject both).
pub async fn run_check<R: Runtime>(app: &AppHandle<R>, db: &Db, busy: &AtomicBool, flow_active: bool, ctx: &Ctx, trigger: Trigger) -> UpdateResult {
    let Some(_guard) = try_flag(busy) else { return without_request(db, ctx, Kind::Throttled) };
    let auto = trigger != Trigger::Manual;
    if auto && !shell::pbool(&shell::prefs(db), "checkUpdates", true) {
        return without_request(db, ctx, Kind::Disabled);
    }
    if auto && flow_active {
        return without_request(db, ctx, Kind::Throttled);
    }
    if !due(trigger, ctx.now, read_last_check(db), read_last_ok(db)) {
        return without_request(db, ctx, Kind::Throttled);
    }
    // the attempt is recorded before the request: a crash or a slow server must not cause a retry storm
    let _ = db::set_setting(&lock(db), "update_last_check", &ctx.now.to_string());

    let mut r = check_once(app, ctx).await.result;
    let ok = matches!(r.kind, Kind::Available | Kind::UpToDate | Kind::NoRelease);
    {
        let c = lock(db);
        let _ = db::set_setting(&c, "update_last_ok", if ok { "1" } else { "0" });
        if matches!(r.kind, Kind::Available | Kind::UpToDate) {
            if let Some(info) = &r.info {
                let cache = serde_json::json!({ "current": ctx.current, "kind": r.kind, "info": info });
                let _ = db::set_setting(&c, "update_cache", &cache.to_string());
            }
        }
    }
    r
}

static BUSY: AtomicBool = AtomicBool::new(false);

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

    let (e1, r1, lb1, le1, st1) = (emit.clone(), received.clone(), last_bytes.clone(), last_emit.clone(), started.clone());
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
                e1(DlEvent::Progress { received: got });
            }
        },
        move || {
            f2.store(true, Ordering::SeqCst);
            e2(DlEvent::Progress { received: r2.load(Ordering::SeqCst) });
            e2(DlEvent::Verifying);
        },
    );
    let watchdog = async {
        loop {
            tokio::time::sleep(Duration::from_millis(250).min(stall)).await;
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

/// Download the update the user agreed to, with progress events on `on_event`; the verified package stays in memory.
#[tauri::command]
pub async fn update_download(app: AppHandle, state: tauri::State<'_, AppState>, upd: tauri::State<'_, UpdState>, on_event: Channel<DlEvent>) -> R<()> {
    let Some(_flag) = try_flag(&upd.downloading) else { return Err("A download is already running.".into()) };
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

    let checked = check_once(&app, &ctx).await;
    let Some(mut update) = checked.update else {
        emit(DlEvent::Failed { stage: "download".into(), message: check_failure_reason(&checked.result) });
        return Ok(());
    };
    if !update_url_ok(update.download_url.as_str(), &update.version, ctx.allow_local) {
        emit(DlEvent::Failed { stage: "badurl".into(), message: String::new() });
        return Ok(());
    }
    update.timeout = None;
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

// ---------- install ----------

fn remember_install(db: &Db, current: &str, version: &str, draft_saved: bool) {
    let c = lock(db);
    let _ = db::set_setting(&c, "update_installing", &format!("{current}>{version}"));
    if draft_saved {
        let _ = db::set_setting(&c, "update_restart_draft", "1");
    }
}

/// Install the downloaded package. Windows: the plugin starts the installer and exits the app (the installer starts the new
/// version when `restart`). macOS / Linux: the package is replaced, then the app restarts or exits.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: tauri::State<'_, AppState>, upd: tauri::State<'_, UpdState>, restart: bool, draft_saved: bool) -> R<()> {
    let (update, bytes) = upd.ready.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or("No update is ready to install.")?;
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
            let _ = db::set_setting(&lock(&db), "update_installing", "");
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
        eprintln!("update on exit failed: {e}");
        let _ = db::set_setting(&lock(&db), "update_installing", "");
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

/// After an update restart: what happened to the install that was started last time (shown once). Also drops a stale consent.
#[tauri::command]
pub fn update_startup_state(app: AppHandle, state: tauri::State<'_, AppState>) -> StartupState {
    startup_state(&state.db, &app.package_info().version.to_string())
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
        }
    }
    let _ = db::set_setting(&c, "update_installing", "");
    let _ = db::set_setting(&c, "update_restart_draft", "");
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

    #[test]
    fn startup_state_reports_the_last_install_once() {
        let db: Db = Arc::new(Mutex::new(db::test_conn(&[])));
        let set = |k: &str, val: &str| db::set_setting(&lock(&db), k, val).unwrap();
        let get = |k: &str| db::get_setting(&lock(&db), k).unwrap_or_default();

        // nothing started
        assert_eq!(startup_state(&db, "1.0.0").outcome, None);

        // updated, with a draft saved for the restart
        set("update_installing", "0.9.0>1.0.0");
        set("update_restart_draft", "1");
        set("update_consent", "1.0.0");
        let s = startup_state(&db, "1.0.0");
        assert_eq!((s.outcome.as_deref(), s.version.as_deref(), s.draft), (Some("updated"), Some("1.0.0"), true));
        assert_eq!((get("update_installing"), get("update_restart_draft"), get("update_consent")), (String::new(), String::new(), String::new()));
        assert_eq!(startup_state(&db, "1.0.0").outcome, None);

        // the install did not happen (still the old version): error outcome, consent stays
        set("update_installing", "0.9.0>1.0.0");
        set("update_consent", "1.0.0");
        let s = startup_state(&db, "0.9.0");
        assert_eq!((s.outcome.as_deref(), s.version.as_deref(), s.draft), (Some("failed"), Some("1.0.0"), false));
        assert_eq!(get("update_consent"), "1.0.0");
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
        assert_eq!(one(http(500, &[], "{}"), "1.0.0", 100).kind, Kind::NoRelease);
        assert_eq!(one(http(403, &[("x-ratelimit-remaining", "0")], "{}"), "1.0.0", 100).kind, Kind::NoRelease);
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
        assert_eq!((r.kind, s.count("/latest.json")), (Kind::NoRelease, 1), "HTTP/1.0 404");
        for (status, body) in [(404, ""), (500, "{}"), (200, "<html>"), (204, "")] {
            let s = stub(move |_| resp(http(status, &[], body)), None);
            let app = app_for(&format!("{}/latest.json", s.base));
            run(&app, &new_db(), &AtomicBool::new(false), &ctx(&s.base, 1, "1.0.0"), Trigger::Startup);
            std::thread::sleep(Duration::from_millis(300));
            assert_eq!(s.count("/latest.json"), 1, "status {status}");
        }
    }

    #[test]
    fn stub_failures_are_remembered() {
        let db = new_db();
        let s = stub(|_| resp(http(200, &[], "<html>")), None);
        let app = app_for(&format!("{}/latest.json", s.base));
        run(&app, &db, &AtomicBool::new(false), &ctx(&s.base, 100, "1.0.0"), Trigger::Manual);
        assert_eq!(db::get_setting(&lock(&db), "update_last_ok").as_deref(), Some("0"));
        // failed attempt: an automatic check is due again after 1 h, not before
        let busy = AtomicBool::new(false);
        assert_eq!(run(&app, &db, &busy, &ctx(&s.base, 100 + 3599, "1.0.0"), Trigger::Shown).kind, Kind::Throttled);
        assert_eq!(s.count("/latest.json"), 1);
        assert_eq!(run(&app, &db, &busy, &ctx(&s.base, 100 + 3600, "1.0.0"), Trigger::Shown).kind, Kind::Error);
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

        // within 6 h: no request, cached info
        let r = run(&app, &db, &busy, &ctx(&s.base, 1000 + 21599, "1.0.0"), Trigger::Shown);
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
