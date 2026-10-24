//! CalDAV (iCloud, Fastmail, Nextcloud, any server) as a `CalProvider`: a small client of its own on `reqwest` and `roxmltree` (D-7.4a), no CalDAV crate.
//!
//! * Sign-in is Basic over https with a username and an app password (stored as `<account id>:calendar`); the person's own address for the server is the mailbox's.
//!   Credentials go only where the person pointed (D-7.4e): redirects are followed here, by hand, to the same host (or the host family of a preset), never from https to http.
//! * Discovery (REQ-7.4.3): the principal, its calendar home and addresses, the calendar collections with their names, colours and rights, and whether the server sends
//!   invitations itself.
//! * Sync (D-7.4e2): RFC 6578 `sync-collection` when the collection supports it, else its ctag and a listing of the etags; changed resources come with a `calendar-multiget`
//!   in batches of 50. The whole collection is downloaded (no window), at most `MAX_EVENTS_PER_CALENDAR` resources.
//! * The server's iCalendar text is kept (`cal_resources`, D-7.4f) as the source for later writes; every resource is mapped with `ical::parse`.
use super::dav_xml::{self, DavResponse};
use super::http::retry_after;
use super::store::Source;
use super::{CalList, CalProvider, EventDraft, EventKind, EventPatch, Pull, PullReq, RawResource, RemoteCalendar, RemoteEvent, Rsvp, SyncErr, MAX_EVENTS_PER_CALENDAR};
use crate::calendar::{CalAttendee, CalPerson};
use crate::ical::{self, IcsEvent};
use crate::Db;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, LOCATION, WWW_AUTHENTICATE};
use reqwest::{Method, Url};
use std::collections::HashMap;
use std::time::Duration;

const MULTIGET_BATCH: usize = 50;
const MAX_REDIRECTS: usize = 6;
/// Pages of a sync-collection report that ends in 507 (the server sends it in parts) one pull follows.
const MAX_SYNC_PARTS: usize = 400;

// ------------------------------------------------------------------ presets

/// The kinds of server the connect dialog knows.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Preset {
    Icloud,
    Fastmail,
    Nextcloud,
    Other,
}

impl Preset {
    pub fn as_str(self) -> &'static str {
        match self {
            Preset::Icloud => "icloud",
            Preset::Fastmail => "fastmail",
            Preset::Nextcloud => "nextcloud",
            Preset::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Preset {
        match s.trim().to_ascii_lowercase().as_str() {
            "icloud" => Preset::Icloud,
            "fastmail" => Preset::Fastmail,
            "nextcloud" => Preset::Nextcloud,
            _ => Preset::Other,
        }
    }

    /// The name the person sees for the service (product names are not translated).
    pub fn label(self) -> Option<&'static str> {
        match self {
            Preset::Icloud => Some("iCloud"),
            Preset::Fastmail => Some("Fastmail"),
            Preset::Nextcloud => Some("Nextcloud"),
            Preset::Other => None,
        }
    }

    /// The address a preset with a fixed server connects to.
    pub fn fixed_url(self) -> Option<&'static str> {
        match self {
            Preset::Icloud => Some("https://caldav.icloud.com/"),
            Preset::Fastmail => Some("https://caldav.fastmail.com/"),
            _ => None,
        }
    }

    /// May the credentials also go to `host` because of this preset (iCloud answers from `p45-caldav.icloud.com`, Fastmail from its own hosts)?
    pub fn family_ok(self, host: &str) -> bool {
        let h = host.to_ascii_lowercase();
        match self {
            Preset::Icloud => h == "icloud.com" || h.ends_with(".icloud.com"),
            Preset::Fastmail => h == "fastmail.com" || h.ends_with(".fastmail.com"),
            _ => false,
        }
    }

    /// The preset an IMAP host suggests.
    pub fn for_imap_host(host: &str) -> Preset {
        match host.trim().to_ascii_lowercase().as_str() {
            "imap.mail.me.com" => Preset::Icloud,
            "imap.fastmail.com" => Preset::Fastmail,
            _ => Preset::Other,
        }
    }
}

// ------------------------------------------------------------------ errors

/// What went wrong with a request or a discovery, before it becomes a sentence for the person (connect) or a sync state.
#[derive(Debug, Clone, PartialEq)]
pub enum DavErr {
    /// 401: the username or password is not accepted
    Auth,
    /// 401 and the server offers only Digest / NTLM / Negotiate
    AuthMethod,
    /// no server answered (DNS, connection refused, timeout, reset)
    NoServer,
    /// the server answered, but not with CalDAV
    NotCalDav,
    /// the account has no calendar for events on the server
    NoCalendars,
    /// the address is `http://` where only https is allowed
    Https,
    /// the certificate of the server is not trusted
    Cert,
    /// the server sent the request to another host: the host
    Redirect(String),
    /// 429 / 5xx: busy
    Busy(Option<Duration>),
    /// 404 of a collection or resource
    Gone,
    /// anything else: status and a short text
    Status(u16, String),
}

impl DavErr {
    /// The sentence the connect dialog shows (REQ-7.4.4), with its code.
    pub fn connect_text(&self) -> String {
        match self {
            DavErr::Auth => "CAL_DAV_AUTH: Couldn’t sign in to the calendar server. Check the username and the password.".into(),
            DavErr::AuthMethod => "CAL_DAV_AUTH_METHOD: The server asks for a sign-in method that Hey Look! doesn’t support.".into(),
            DavErr::NoServer | DavErr::Busy(_) | DavErr::Gone => "CAL_DAV_NOT_FOUND: No server answered at this address. Check the server address.".into(),
            DavErr::NotCalDav | DavErr::Status(..) => "CAL_DAV_NOT_CALDAV: This address doesn’t offer CalDAV calendars.".into(),
            DavErr::NoCalendars => "CAL_DAV_NO_CALENDARS: This account has no calendars on the server.".into(),
            DavErr::Https => "CAL_DAV_HTTPS: Use an address that starts with https://.".into(),
            DavErr::Cert => "CAL_DAV_CERT: The server’s certificate isn’t trusted.".into(),
            DavErr::Redirect(host) => format!("CAL_DAV_REDIRECT: The server sent Hey Look! to another address ({host}). Hey Look! stopped there to keep your password safe."),
        }
    }

    /// The state of a sync round this ends in.
    pub fn sync_err(&self) -> SyncErr {
        match self {
            DavErr::Auth | DavErr::AuthMethod => SyncErr::Auth,
            DavErr::NoServer => SyncErr::Offline,
            DavErr::Busy(after) => SyncErr::RateLimited(*after),
            DavErr::Gone => SyncErr::NotFound,
            DavErr::Cert => SyncErr::Other("the server’s certificate is not trusted".into()),
            DavErr::Https => SyncErr::Other("the address does not use https".into()),
            DavErr::Redirect(h) => SyncErr::Other(format!("the server sent the request to another address ({h})")),
            DavErr::NotCalDav => SyncErr::Other("the server does not answer as a CalDAV server".into()),
            DavErr::NoCalendars => SyncErr::Other("no calendars on the server".into()),
            DavErr::Status(s, t) => SyncErr::Other(format!("the calendar server answered {s}: {t}")),
        }
    }
}

// ------------------------------------------------------------------ http

/// The answer of one request.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
    /// the address that answered (after the redirects that were followed)
    pub url: Url,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// The connection to one server: its credentials and where they may go.
pub struct DavHttp {
    client: reqwest::blocking::Client,
    user: String,
    pass: String,
    preset: Preset,
    /// the host the person entered: the credentials may always go there
    home_host: String,
}

fn host_of(u: &Url) -> String {
    u.host_str().unwrap_or("").to_ascii_lowercase()
}

/// `http://` is only accepted for this machine in a debug build (the QA servers); everything else is https.
fn scheme_allowed(u: &Url) -> bool {
    match u.scheme() {
        "https" => true,
        #[cfg(debug_assertions)]
        "http" => matches!(host_of(u).as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1"),
        _ => false,
    }
}

impl DavHttp {
    pub fn new(base: &Url, user: &str, pass: &str, preset: Preset, trust_cert: bool) -> DavHttp {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .danger_accept_invalid_certs(trust_cert)
            .user_agent(concat!("HeyLook/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        DavHttp { client, user: user.to_string(), pass: pass.to_string(), preset, home_host: host_of(base) }
    }

    /// May the credentials go to this address?
    pub fn allowed(&self, u: &Url) -> bool {
        if !scheme_allowed(u) {
            return false;
        }
        let h = host_of(u);
        h == self.home_host || self.preset.family_ok(&h)
    }

    /// One request, redirects followed by hand. The same method and body go to the new address (a `.well-known` redirect is a redirect of the PROPFIND).
    pub fn request(&self, method: &str, url: &Url, depth: Option<&str>, body: Option<&str>, extra: &[(&str, &str)]) -> Result<Reply, DavErr> {
        let mut at = url.clone();
        for _ in 0..=MAX_REDIRECTS {
            if !scheme_allowed(&at) {
                return Err(if at.scheme() == "http" && host_of(url) == host_of(&at) && at.scheme() == url.scheme() { DavErr::Https } else if at.scheme() == "http" { DavErr::Https } else { DavErr::Redirect(host_of(&at)) });
            }
            let m = Method::from_bytes(method.as_bytes()).map_err(|_| DavErr::Status(0, "bad method".into()))?;
            let mut req = self.client.request(m, at.clone()).basic_auth(&self.user, Some(&self.pass));
            if let Some(d) = depth {
                req = req.header("Depth", d);
            }
            if let Some(b) = body {
                req = req.header(CONTENT_TYPE, HeaderValue::from_static("application/xml; charset=utf-8")).body(b.to_string());
            }
            for (k, v) in extra {
                req = req.header(*k, *v);
            }
            let resp = req.send().map_err(map_net)?;
            let status = resp.status().as_u16();
            let headers = resp.headers().clone();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                let Some(loc) = headers.get(LOCATION).and_then(|v| v.to_str().ok()) else { return Err(DavErr::Status(status, "a redirect without a place".into())) };
                let next = at.join(loc).map_err(|_| DavErr::Status(status, "a redirect to a bad address".into()))?;
                // credentials go to the same host, or the host family of a preset; https never goes to http
                if at.scheme() == "https" && next.scheme() == "http" {
                    return Err(DavErr::Https);
                }
                if !self.allowed(&next) {
                    return Err(if next.scheme() == "http" && !scheme_allowed(&next) { DavErr::Https } else { DavErr::Redirect(host_of(&next)) });
                }
                at = next;
                continue;
            }
            let text = resp.text().unwrap_or_default();
            return Ok(Reply { status, headers, body: text, url: at });
        }
        Err(DavErr::Status(0, "too many redirects".into()))
    }

    /// Turn the answers every request shares into errors: 401, 429 / 5xx. The rest is for the caller.
    pub fn check(&self, r: Reply) -> Result<Reply, DavErr> {
        match r.status {
            401 => {
                let offers: Vec<String> = r.headers.get_all(WWW_AUTHENTICATE).iter().filter_map(|v| v.to_str().ok()).map(|v| v.to_ascii_lowercase()).collect();
                let basic = offers.is_empty() || offers.iter().any(|o| o.trim_start().starts_with("basic"));
                Err(if basic { DavErr::Auth } else { DavErr::AuthMethod })
            }
            429 | 500 | 502 | 503 | 504 => Err(DavErr::Busy(retry_after(&r.headers))),
            _ => Ok(r),
        }
    }

    pub fn call(&self, method: &str, url: &Url, depth: Option<&str>, body: Option<&str>) -> Result<Reply, DavErr> {
        let r = self.request(method, url, depth, body, &[])?;
        self.check(r)
    }
}

fn map_net(e: reqwest::Error) -> DavErr {
    let mut chain = e.to_string().to_ascii_lowercase();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        chain.push(' ');
        chain.push_str(&s.to_string().to_ascii_lowercase());
        src = s.source();
    }
    if chain.contains("certificate") || chain.contains("invalid peer") || chain.contains("unknown issuer") || chain.contains("tls handshake") && chain.contains("cert") {
        DavErr::Cert
    } else {
        DavErr::NoServer
    }
}

// ------------------------------------------------------------------ discovery

/// One calendar collection found on the server.
#[derive(Clone, Debug, PartialEq)]
pub struct DavCal {
    /// the address of the collection (absolute, with its closing slash)
    pub url: String,
    pub name: String,
    /// "#rrggbb" or empty
    pub color: String,
    pub read_only: bool,
}

/// What discovery found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Discovered {
    /// the calendar homes (collections that hold the calendars); empty when the address entered was a calendar itself
    pub homes: Vec<String>,
    /// the user's own addresses on the server (`calendar-user-address-set`)
    pub addresses: Vec<String>,
    pub calendars: Vec<DavCal>,
    /// the server sends invitations by itself (`calendar-auto-schedule`)
    pub scheduling: bool,
}

pub fn parse_url(s: &str) -> Option<Url> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let with = if t.contains("://") { t.to_string() } else { format!("https://{t}") };
    Url::parse(&with).ok().filter(|u| u.host_str().is_some())
}

/// `#RRGGBBAA` / `#RRGGBB` / `#RGB` as `#rrggbb`; anything else is no colour.
pub fn calendar_color(raw: &str) -> String {
    let t = raw.trim().trim_start_matches('#');
    let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    match t.len() {
        6 | 8 if hex(t) => format!("#{}", t[..6].to_ascii_lowercase()),
        3 if hex(t) => format!("#{}", t.chars().flat_map(|c| [c, c]).collect::<String>().to_ascii_lowercase()),
        _ => String::new(),
    }
}

fn abs(base: &Url, href: &str) -> Option<Url> {
    base.join(href.trim()).ok()
}

fn resolved(http: &DavHttp, base: &Url, href: &str) -> Result<Url, DavErr> {
    let u = abs(base, href).ok_or(DavErr::NotCalDav)?;
    // an address the server hands out is followed only where the credentials may go
    if !http.allowed(&u) {
        return Err(if scheme_allowed(&u) { DavErr::Redirect(host_of(&u)) } else { DavErr::Https });
    }
    Ok(u)
}

fn multistatus(r: &Reply) -> Option<dav_xml::Multistatus> {
    (r.status == 207 || r.status == 200).then(|| dav_xml::parse_multistatus(&r.body).ok()).flatten()
}

fn privileges_allow_writing(r: &DavResponse) -> bool {
    match r.props.get("D:current-user-privilege-set") {
        None => true,
        Some(p) => p.tags.iter().any(|t| matches!(t.as_str(), "write" | "write-content" | "all" | "bind")),
    }
}

/// The calendar collections in a Depth 1 (or Depth 0) answer: those whose resource type has `calendar` and that hold events.
fn collections_in(http: &DavHttp, at: &Url, ms: &dav_xml::Multistatus) -> Result<Vec<DavCal>, DavErr> {
    let mut out = vec![];
    for r in &ms.responses {
        if !r.has_tag("D:resourcetype", "calendar") || r.has_tag("D:resourcetype", "subscribed") {
            continue;
        }
        let comps = r.props.get("C:supported-calendar-component-set").map(|p| p.comps.clone()).unwrap_or_default();
        if !comps.is_empty() && !comps.iter().any(|c| c == "VEVENT") {
            continue;
        }
        let url = resolved(http, at, &r.href)?;
        let mut u = url.to_string();
        if !u.ends_with('/') {
            u.push('/');
        }
        let name = r.text("D:displayname").map(String::from).unwrap_or_else(|| u.trim_end_matches('/').rsplit('/').next().map(|s| urlencoding::decode(s).map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())).unwrap_or_default());
        out.push(DavCal { url: u, name, color: r.text("A:calendar-color").map(calendar_color).unwrap_or_default(), read_only: !privileges_allow_writing(r) });
    }
    Ok(out)
}

fn principal_of(http: &DavHttp, at: &Url, r: &Reply) -> Result<Option<Url>, DavErr> {
    let Some(ms) = multistatus(r) else { return Ok(None) };
    let first = ms.responses.iter().find_map(|x| x.props.get("D:current-user-principal").and_then(|p| p.hrefs.first().cloned()));
    first.map(|h| resolved(http, at, &h)).transpose()
}

/// Find the calendars of an account from the address the person entered (REQ-7.4.3).
pub fn discover(http: &DavHttp, entered: &str, preset: Preset) -> Result<Discovered, DavErr> {
    let start = match preset.fixed_url() {
        Some(u) => Url::parse(u).map_err(|_| DavErr::NotCalDav)?,
        None => parse_url(entered).ok_or(DavErr::NoServer)?,
    };
    if !scheme_allowed(&start) {
        return Err(DavErr::Https);
    }
    let mut attempts: Vec<Url> = vec![];
    let path = start.path().trim_matches('/');
    if preset != Preset::Icloud && preset != Preset::Fastmail && !path.is_empty() {
        attempts.push(start.clone());
    }
    let origin = |p: &str| {
        let mut o = start.clone();
        o.set_path(p);
        o.set_query(None);
        o
    };
    attempts.push(origin("/.well-known/caldav"));
    if preset == Preset::Nextcloud || preset == Preset::Other {
        attempts.push(origin("/remote.php/dav/"));
    }
    if path.is_empty() && !attempts.iter().any(|a| a == &start) {
        attempts.push(start.clone());
    }
    let mut collection_here: Option<(Url, dav_xml::Multistatus)> = None;
    let mut principal: Option<Url> = None;
    let mut last_err: Option<DavErr> = None;
    for at in &attempts {
        let r = match http.call("PROPFIND", at, Some("0"), Some(&dav_xml::propfind_principal())) {
            Ok(r) => r,
            Err(e @ (DavErr::Auth | DavErr::AuthMethod | DavErr::Cert | DavErr::Https | DavErr::Redirect(_))) => return Err(e),
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        };
        if let Some(p) = principal_of(http, &r.url, &r)? {
            principal = Some(p);
            break;
        }
        // the address itself may be a calendar collection (step 5)
        if let Some(ms) = multistatus(&r) {
            if ms.responses.iter().any(|x| x.has_tag("D:resourcetype", "calendar")) {
                collection_here = Some((r.url.clone(), ms));
                break;
            }
        }
        last_err = Some(DavErr::NotCalDav);
    }
    let mut found = Discovered::default();
    let mut homes: Vec<Url> = vec![];
    if let Some(p) = &principal {
        let r = http.call("PROPFIND", p, Some("0"), Some(&dav_xml::propfind_home()))?;
        let ms = multistatus(&r).ok_or(DavErr::NotCalDav)?;
        for resp in &ms.responses {
            if let Some(h) = resp.props.get("C:calendar-home-set") {
                for href in &h.hrefs {
                    let u = resolved(http, &r.url, href)?;
                    if !homes.contains(&u) {
                        homes.push(u);
                    }
                }
            }
            if let Some(a) = resp.props.get("C:calendar-user-address-set") {
                found.addresses.extend(a.hrefs.iter().map(|h| h.trim().trim_start_matches("mailto:").to_ascii_lowercase()).filter(|h| h.contains('@')));
            }
        }
        if homes.is_empty() {
            return Err(DavErr::NotCalDav);
        }
        for home in &homes {
            let r = http.call("PROPFIND", home, Some("1"), Some(&dav_xml::propfind_collections()))?;
            if r.status == 404 {
                continue;
            }
            let ms = multistatus(&r).ok_or(DavErr::NotCalDav)?;
            found.calendars.extend(collections_in(http, &r.url, &ms)?);
            found.homes.push(home.to_string());
        }
    } else if let Some((at, _)) = collection_here {
        // no principal, but the address is a calendar: that one calendar
        let r = http.call("PROPFIND", &at, Some("0"), Some(&dav_xml::propfind_collections()))?;
        let ms = multistatus(&r).ok_or(DavErr::NotCalDav)?;
        found.calendars = collections_in(http, &r.url, &ms)?;
    } else {
        return Err(last_err.filter(|e| matches!(e, DavErr::NoServer)).unwrap_or(DavErr::NotCalDav));
    }
    if found.calendars.is_empty() {
        return Err(DavErr::NoCalendars);
    }
    found.calendars.dedup_by(|a, b| a.url == b.url);
    // does the server send the invitations itself? (OPTIONS on the home: `calendar-auto-schedule` in the DAV header)
    if let Some(home) = homes.first().or(found.calendars.first().and_then(|c| Url::parse(&c.url).ok()).as_ref()) {
        if let Ok(r) = http.request("OPTIONS", home, None, None, &[]) {
            found.scheduling = r.header("dav").is_some_and(|d| d.to_ascii_lowercase().contains("calendar-auto-schedule"));
        }
    }
    Ok(found)
}

// ------------------------------------------------------------------ the source

/// What a CalDAV source remembers about its server (columns of `cal_sources`).
#[derive(Clone, Debug, PartialEq)]
pub struct DavSource {
    /// the address the person entered (or the preset's fixed one)
    pub url: String,
    pub username: String,
    pub preset: Preset,
    /// the calendar homes found at connect
    pub homes: Vec<String>,
    /// the user's addresses on the server, lower case
    pub addresses: Vec<String>,
    pub scheduling: bool,
    pub trust_cert: bool,
}

impl DavSource {
    /// How the service is named for the person: the preset's name, else the host of the address.
    pub fn label(&self) -> String {
        self.preset.label().map(String::from).unwrap_or_else(|| self.host())
    }

    pub fn host(&self) -> String {
        parse_url(&self.url).map(|u| host_of(&u)).unwrap_or_default()
    }
}

// ------------------------------------------------------------------ the provider

pub struct CalDavProvider {
    http: DavHttp,
    src: DavSource,
    /// the mailbox address (the user is also this on the server)
    mailbox: String,
}

/// The provider of a CalDAV source: its password comes from the credential store (`<account id>:calendar`); without it the source needs the person (`Auth`).
pub fn provider(_db: &Db, src: &Source) -> Result<Box<dyn CalProvider>, SyncErr> {
    let dav = src.dav.clone().ok_or_else(|| SyncErr::NotSetUp("this calendar source has no server".into()))?;
    let key = crate::oauth::calendar_key(&src.account_id);
    let pass = crate::identity::entry(&key).ok().and_then(|e| e.get_password().ok()).ok_or(SyncErr::Auth)?;
    let mailbox = crate::lock(_db).query_row("SELECT email FROM accounts WHERE id=?1", [&src.account_id], |r| r.get::<_, String>(0)).unwrap_or_default();
    Ok(Box::new(CalDavProvider::new(dav, &pass, &mailbox)))
}

impl CalDavProvider {
    pub fn new(src: DavSource, password: &str, mailbox: &str) -> CalDavProvider {
        let base = parse_url(&src.url).or_else(|| src.homes.first().and_then(|h| Url::parse(h).ok())).unwrap_or_else(|| Url::parse("https://invalid.example/").unwrap());
        let http = DavHttp::new(&base, &src.username, password, src.preset, src.trust_cert);
        CalDavProvider { http, src, mailbox: mailbox.trim().to_ascii_lowercase() }
    }

    fn me(&self) -> Vec<String> {
        let mut v = self.src.addresses.clone();
        v.push(self.mailbox.clone());
        v
    }

    fn collection(&self, cal: &RemoteCalendar) -> Result<Url, SyncErr> {
        let u = Url::parse(&cal.id).map_err(|_| SyncErr::Other("a calendar with a bad address".into()))?;
        if !self.http.allowed(&u) {
            return Err(SyncErr::Other("the calendar is on a server the credentials may not go to".into()));
        }
        Ok(u)
    }

    /// The version of a collection: its ctag and sync token, and whether the sync-collection report is offered.
    fn state_of(&self, col: &Url) -> Result<(Option<String>, Option<String>, bool), DavErr> {
        let r = self.http.call("PROPFIND", col, Some("0"), Some(&dav_xml::propfind(&["CS:getctag", "D:sync-token", "D:supported-report-set"])))?;
        if r.status == 404 {
            return Err(DavErr::Gone);
        }
        let ms = multistatus(&r).ok_or(DavErr::NotCalDav)?;
        let me = ms.responses.first();
        let ctag = me.and_then(|x| x.text("CS:getctag")).map(String::from);
        let token = me.and_then(|x| x.text("D:sync-token")).map(String::from);
        let reports = me.is_some_and(|x| x.has_tag("D:supported-report-set", "sync-collection"));
        let has_token = token.is_some();
        Ok((ctag, token, reports || has_token))
    }

    /// Download these resources (multiget in batches of 50). A resource the server no longer has is returned as removed.
    fn fetch(&self, col: &Url, hrefs: &[String]) -> Result<(Vec<RawResource>, Vec<String>), DavErr> {
        let mut got = vec![];
        let mut gone = vec![];
        for batch in hrefs.chunks(MULTIGET_BATCH) {
            // (the path of a resource on the collection's own server, the whole address otherwise)
            let asked: Vec<String> = batch.iter().map(|h| match Url::parse(h) { Ok(u) if u.origin() == col.origin() => u.path().to_string(), _ => h.clone() }).collect();
            let r = self.http.call("REPORT", col, Some("1"), Some(&dav_xml::multiget(&asked)))?;
            if r.status == 404 {
                return Err(DavErr::Gone);
            }
            let ms = multistatus(&r).ok_or(DavErr::NotCalDav)?;
            for x in &ms.responses {
                let Some(u) = abs(&r.url, &x.href).filter(|u| self.http.allowed(u)) else { continue };
                if x.status == Some(404) {
                    gone.push(u.to_string());
                    continue;
                }
                let Some(raw) = x.props.get("C:calendar-data").map(|p| p.text.clone()).filter(|t| !t.is_empty()) else { continue };
                got.push(RawResource { href: u.to_string(), etag: x.text("D:getetag").unwrap_or("").to_string(), uid: String::new(), raw });
            }
        }
        Ok((got, gone))
    }

    /// RFC 6578: what changed since `token` (empty = everything). Follows a report the server sent in parts (507). Returns (resources with etag, removed, new token).
    fn sync_report(&self, col: &Url, token: &str) -> Result<(Vec<(String, String)>, Vec<String>, Option<String>), DavErr> {
        let mut changed: Vec<(String, String)> = vec![];
        let mut removed: Vec<String> = vec![];
        let mut tok = token.to_string();
        for _ in 0..MAX_SYNC_PARTS {
            let r = self.http.call("REPORT", col, Some("0"), Some(&dav_xml::sync_collection(&tok)))?;
            match r.status {
                207 | 200 => {}
                404 => return Err(DavErr::Gone),
                // the token is not valid (any more): the caller downloads everything again
                403 | 409 if dav_xml::error_tags(&r.body).iter().any(|t| t == "valid-sync-token") => return Err(DavErr::Status(410, "sync token".into())),
                s => return Err(DavErr::Status(s, "sync-collection".into())),
            }
            let ms = multistatus(&r).ok_or(DavErr::NotCalDav)?;
            let mut partial = false;
            for x in &ms.responses {
                let Some(u) = abs(&r.url, &x.href).filter(|u| self.http.allowed(u)) else { continue };
                if u.as_str().trim_end_matches('/') == col.as_str().trim_end_matches('/') {
                    // (the collection itself: 507 = the server stops here and gives a token to go on with)
                    partial |= x.status == Some(507);
                    continue;
                }
                match x.status {
                    Some(404) => removed.push(u.to_string()),
                    Some(s) if s >= 300 => {}
                    _ => {
                        if x.has_tag("D:resourcetype", "collection") {
                            continue;
                        }
                        changed.retain(|(h, _)| *h != u.as_str());
                        changed.push((u.to_string(), x.text("D:getetag").unwrap_or("").to_string()));
                    }
                }
            }
            tok = ms.sync_token.clone().unwrap_or(tok);
            if !partial {
                return Ok((changed, removed, Some(tok).filter(|t| !t.is_empty())));
            }
        }
        Err(DavErr::Status(507, "the server never finished its answer".into()))
    }

    /// A server without sync tokens: the etag of every resource (Depth 1).
    fn list_etags(&self, col: &Url) -> Result<Vec<(String, String)>, DavErr> {
        let r = self.http.call("PROPFIND", col, Some("1"), Some(&dav_xml::propfind_etags()))?;
        if r.status == 404 {
            return Err(DavErr::Gone);
        }
        let ms = multistatus(&r).ok_or(DavErr::NotCalDav)?;
        let mut out = vec![];
        for x in &ms.responses {
            let Some(u) = abs(&r.url, &x.href).filter(|u| self.http.allowed(u)) else { continue };
            if u.as_str().trim_end_matches('/') == col.as_str().trim_end_matches('/') || x.has_tag("D:resourcetype", "collection") {
                continue;
            }
            if let Some(e) = x.text("D:getetag") {
                out.push((u.to_string(), e.to_string()));
            }
        }
        Ok(out)
    }

    fn pull_inner(&self, cal: &RemoteCalendar, req: &PullReq) -> Result<Pull, DavErr> {
        let col = self.collection(cal).map_err(|_| DavErr::Redirect(cal.id.clone()))?;
        let mut pull = Pull::default();
        let known: HashMap<String, String> = req.known.clone().unwrap_or_default().into_iter().collect();
        let (next_state, full, to_fetch, removed) = match req.state.as_deref() {
            Some(s) if s.starts_with("S:") => {
                let (changed, removed, token) = self.sync_report(&col, &s[2..])?;
                (token.map(|t| format!("S:{t}")), false, changed.into_iter().map(|(h, _)| h).collect::<Vec<_>>(), removed)
            }
            Some(s) if s.starts_with("C:") => {
                let (ctag, _, _) = self.state_of(&col)?;
                if ctag.is_some() && ctag.as_deref() == Some(&s[2..]) {
                    // nothing changed (one request)
                    return Ok(Pull { next_state: Some(s.to_string()), full: false, ..Default::default() });
                }
                let listed = self.list_etags(&col)?;
                let changed: Vec<String> = listed.iter().filter(|(h, e)| known.get(h).map(|k| k != e || e.is_empty()).unwrap_or(true)).map(|(h, _)| h.clone()).collect();
                let present: std::collections::HashSet<&String> = listed.iter().map(|(h, _)| h).collect();
                let removed: Vec<String> = known.keys().filter(|h| !present.contains(h)).cloned().collect();
                (Some(format!("C:{}", ctag.unwrap_or_default())), false, changed, removed)
            }
            _ => {
                // the first download of a collection (or the one after a token the server forgot): everything
                let (ctag, token, reports) = self.state_of(&col)?;
                let mut via_sync = None;
                if reports {
                    match self.sync_report(&col, "") {
                        Ok(r) => via_sync = Some(r),
                        // a server that lists the report and does not do it: the etag listing
                        Err(DavErr::Status(s, _)) if matches!(s, 400 | 403 | 405 | 409 | 501) => {}
                        Err(e) => return Err(e),
                    }
                }
                match via_sync {
                    Some((changed, _, tok)) => (tok.or(token).map(|t| format!("S:{t}")), true, changed.into_iter().map(|(h, _)| h).collect(), vec![]),
                    None => {
                        let listed = self.list_etags(&col)?;
                        (Some(format!("C:{}", ctag.unwrap_or_default())), true, listed.into_iter().map(|(h, _)| h).collect(), vec![])
                    }
                }
            }
        };
        let mut hrefs = to_fetch;
        if hrefs.len() > MAX_EVENTS_PER_CALENDAR {
            hrefs.truncate(MAX_EVENTS_PER_CALENDAR);
            pull.truncated = true;
        }
        let (got, gone) = self.fetch(&col, &hrefs)?;
        let me = self.me();
        for mut res in got {
            match map_resource(&res.href, &res.etag, &res.raw, &me) {
                Some(mapped) => {
                    res.uid = mapped.uid;
                    pull.replace.push(res.href.clone());
                    pull.upserts.extend(mapped.events);
                    pull.resources.push(res);
                }
                None => crate::startup::line("calsync", &format!("caldav: {} has no readable event, kept as it was", res.href)),
            }
        }
        pull.removed = removed.into_iter().chain(gone).collect();
        pull.next_state = if pull.truncated { None } else { next_state };
        pull.full = full;
        Ok(pull)
    }
}

// ------------------------------------------------------------------ mapping

/// The rows one resource gives.
pub struct Mapped {
    pub uid: String,
    pub events: Vec<RemoteEvent>,
}

fn partstat(s: &str) -> &'static str {
    match s {
        "accepted" => "accepted",
        "declined" => "declined",
        "tentative" => "tentative",
        _ => "needs-action",
    }
}

fn map_one(href: &str, etag: &str, ev: &IcsEvent, me: &[String], override_slot: Option<i64>) -> RemoteEvent {
    let is_me = |e: &str| me.iter().any(|m| m == &e.to_ascii_lowercase());
    let attendees: Vec<CalAttendee> = ev
        .attendees
        .iter()
        .map(|a| CalAttendee { email: a.email.clone(), name: a.name.clone(), role: a.role.clone(), status: partstat(&a.status).into(), is_you: false })
        .collect();
    let organizer_self = ev.organizer.as_ref().is_some_and(|o| is_me(&o.email));
    let my_status = if organizer_self && !attendees.is_empty() {
        Some("organizer".to_string())
    } else {
        ev.attendees.iter().find(|a| is_me(&a.email)).map(|a| partstat(&a.status).to_string())
    };
    // the organizer is shown when there are guests or somebody else organizes
    let organizer = ev.organizer.as_ref().filter(|_| !attendees.is_empty() || !organizer_self).map(|o| CalPerson { email: o.email.clone(), name: o.name.clone() });
    let id = match override_slot {
        Some(slot) => format!("{href}#{slot}"),
        None => href.to_string(),
    };
    let kind = match override_slot {
        Some(_) => EventKind::Exception,
        None if ev.rrule.is_some() || !ev.rdates.is_empty() => EventKind::Master,
        None => EventKind::Single,
    };
    RemoteEvent {
        id,
        etag: etag.to_string(),
        uid: ev.uid.clone(),
        ext_uid: None,
        kind,
        series_id: override_slot.map(|_| href.to_string()),
        recurrence_id: override_slot,
        summary: ev.summary.clone(),
        start: ev.start,
        end: ev.end.max(ev.start),
        all_day: ev.all_day,
        tzid: ev.tzid.clone(),
        location: ev.location.clone(),
        join_url: ical::join_url(ev),
        description: ev.description.clone(),
        organizer,
        attendees,
        rrule: ev.rrule.clone(),
        exdates: ev.exdates.clone(),
        rdates: ev.rdates.clone(),
        pattern_unsupported: false,
        status: ev.status.clone(),
        my_status,
        reminder_min: ev.reminder_min,
        // the person's own event, or one without an organizer; somebody else's meeting is only theirs to read (D-7.4g)
        can_edit: ev.organizer.is_none() || organizer_self,
        updated: None,
    }
}

/// The rows of one resource (REQ-7.4.6): the first UID's events only (the master or the single event, and the overrides of its series). `None` when the text has no event.
pub fn map_resource(href: &str, etag: &str, raw: &str, me: &[String]) -> Option<Mapped> {
    let cal = ical::parse(raw).ok()?;
    let uid = cal.events.first()?.uid.clone();
    let mut events = vec![];
    for ev in cal.events.iter().filter(|e| e.uid == uid) {
        events.push(map_one(href, etag, ev, me, ev.recurrence_id));
    }
    if cal.events.iter().any(|e| e.uid != uid) {
        crate::startup::line("calsync", &format!("caldav: {href} holds more than one event; only the first is shown"));
    }
    // a resource that only has overrides (no master) is shown as they are
    Some(Mapped { uid, events })
}

impl CalProvider for CalDavProvider {
    fn list_calendars(&self) -> Result<Vec<RemoteCalendar>, SyncErr> {
        let mut out: Vec<RemoteCalendar> = vec![];
        let mut seen = false;
        let places: Vec<(String, &str)> = if self.src.homes.is_empty() { vec![(self.src.url.clone(), "0")] } else { self.src.homes.iter().map(|h| (h.clone(), "1")).collect() };
        for (place, depth) in places {
            let url = Url::parse(&place).or_else(|_| parse_url(&place).ok_or(())).map_err(|_| SyncErr::Other("a bad calendar address".into()))?;
            let r = self.http.call("PROPFIND", &url, Some(depth), Some(&dav_xml::propfind_collections())).map_err(|e| e.sync_err())?;
            if r.status == 404 {
                continue;
            }
            let ms = multistatus(&r).ok_or_else(|| DavErr::NotCalDav.sync_err())?;
            seen = true;
            for c in collections_in(&self.http, &r.url, &ms).map_err(|e| e.sync_err())? {
                if out.iter().any(|x| x.id == c.url) {
                    continue;
                }
                out.push(RemoteCalendar { id: c.url, name: c.name, color: c.color, read_only: c.read_only, primary: false, selected: true, time_zone: None, default_reminder_min: None });
            }
        }
        if !seen {
            return Err(SyncErr::NotFound);
        }
        Ok(out)
    }

    fn pull(&self, cal: &RemoteCalendar, req: &PullReq) -> Result<Pull, SyncErr> {
        self.pull_inner(cal, req).map_err(|e| match e {
            // the sync token was not valid: the engine downloads everything again
            DavErr::Status(410, _) => SyncErr::Gone,
            other => other.sync_err(),
        })
    }

    fn wants_known_etags(&self) -> bool {
        true
    }

    // Writes come with the second half of W7.4 (7d): until then a CalDAV calendar is read-only here.
    fn create(&self, _cal: &RemoteCalendar, _ev: &EventDraft) -> Result<RemoteEvent, SyncErr> {
        Err(SyncErr::NotSetUp("writing to a CalDAV calendar is not part of this version".into()))
    }

    fn update(&self, _cal: &RemoteCalendar, _remote_id: &str, _etag: &str, _changed: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        Err(SyncErr::NotSetUp("writing to a CalDAV calendar is not part of this version".into()))
    }

    fn delete(&self, _cal: &RemoteCalendar, _remote_id: &str, _etag: &str) -> Result<(), SyncErr> {
        Err(SyncErr::NotSetUp("writing to a CalDAV calendar is not part of this version".into()))
    }

    fn respond(&self, _cal: &RemoteCalendar, _remote_id: &str, _etag: &str, _status: Rsvp, _me: &str, _attendees: &[CalAttendee]) -> Result<(), SyncErr> {
        Err(SyncErr::NotSetUp("answering through a CalDAV calendar is not part of this version".into()))
    }
}

#[allow(dead_code)]
fn _lists(_: CalList) {}

#[cfg(test)]
#[path = "caldav_tests.rs"]
mod tests;
