//! Microsoft Graph (Outlook.com, Hotmail, Microsoft 365) as a `CalProvider`.
//!
//! Scope (a separate calendar-only consent, see `oauth::Purpose::Calendar`): `Calendars.ReadWrite` (delegated; no admin consent for the
//! user's own calendars) plus `offline_access openid email profile`. Endpoints used, all under `https://graph.microsoft.com/v1.0`:
//! `me/calendars`, `calendarView/delta` (per calendar; `@odata.nextLink` pages, the `@odata.deltaLink` of the last page is the sync
//! state, `@removed` entries are deletions, 410 `syncStateNotFound` = download again), plain `calendarView` as the fallback where a
//! calendar has no delta, `POST` / `PATCH` / `DELETE` of events with `If-Match`, and `accept` / `tentativelyAccept` / `decline` with
//! `sendResponse: false` for the silent RSVP mirror.
//!
//! Times: every request asks for `outlook.timezone="UTC"`, so timed events arrive as UTC; the event's own zone comes from
//! `originalStartTimeZone` (a Windows or IANA name, mapped by `ical::iana_for`). All-day events are read as dates (see `all_day_date`).
//! The calendar view lists single events, occurrences and exceptions (no series master): they are stored as single read-only rows
//! (`EventKind::Single | Occurrence | Exception`, no `rrule`), so no recurrence expansion is needed.
use super::google::plain_text;
use super::http;
use super::store::Source;
use super::{CalProvider, EventDraft, EventKind, EventPatch, Kind, Pull, PullReq, RemoteCalendar, RemoteEvent, Rsvp, SyncErr, When, MAX_EVENTS_PER_CALENDAR};
use crate::calendar::{CalAttendee, CalPerson};
use crate::Db;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const API: &str = "https://graph.microsoft.com/v1.0";
/// Events per page (`Prefer: odata.maxpagesize`, `$top`).
const PAGE: usize = 100;
/// Pages one pull may read: the event limit divided by the page size, with room for pages of removals. A server that never ends its
/// paging (or points `nextLink` back at itself) stops here with an error instead of looping.
const MAX_PAGES: usize = MAX_EVENTS_PER_CALENDAR / PAGE * 4;
/// UTC for everything we read, text instead of HTML for bodies, and the page size for delta queries (it is not a URL parameter).
const PREFER: &str = "outlook.timezone=\"UTC\", outlook.body-content-type=\"text\", odata.maxpagesize=100";

/// The provider of a source, with the access token fetched (and refreshed) before every request.
pub fn provider(db: &Db, src: &Source) -> Result<Box<dyn CalProvider>, SyncErr> {
    let (db, account) = (db.clone(), src.account_id.clone());
    Ok(Box::new(MicrosoftProvider::new(
        &http::base_url("HEYLOOK_GRAPH_BASE", API),
        Box::new(move || super::cmds::calendar_token(&db, Kind::Microsoft, &account)),
    )))
}

type TokenFn = Box<dyn Fn() -> Result<String, SyncErr> + Send + Sync>;

pub struct MicrosoftProvider {
    base: String,
    token: TokenFn,
    http: reqwest::blocking::Client,
}

/// A failed request: the status and Graph's `error.code` (lower case) next to the sorted error, for the few places that decide on them.
struct Fail {
    status: u16,
    code: String,
    err: SyncErr,
}

impl From<SyncErr> for Fail {
    fn from(err: SyncErr) -> Fail {
        Fail { status: 0, code: String::new(), err }
    }
}

impl MicrosoftProvider {
    pub fn new(base: &str, token: TokenFn) -> MicrosoftProvider {
        MicrosoftProvider { base: base.trim_end_matches('/').to_string(), token, http: http::client() }
    }

    /// `path` with its query (`(key, value)`, values are encoded here, keys like `$top` are not).
    fn url(&self, path: &str, query: &[(&str, String)]) -> String {
        let mut url = format!("{}{}", self.base, path);
        for (i, (k, v)) in query.iter().enumerate() {
            url.push(if i == 0 { '?' } else { '&' });
            url.push_str(&format!("{k}={}", urlencoding::encode(v)));
        }
        url
    }

    /// A link out of an answer (`nextLink`, `deltaLink`) is only followed when it points at the same Graph host, so the access token
    /// can never be sent anywhere else, whatever an answer (or the stored sync state) says.
    fn own_link(&self, link: &str) -> bool {
        link.strip_prefix(self.base.as_str()).is_some_and(|rest| rest.starts_with('/'))
    }

    fn request(&self, method: Method, url: &str, body: Option<&Value>, if_match: Option<&str>) -> Result<Value, Fail> {
        let token = (self.token)()?;
        let read = method == Method::GET;
        let mut req = self.http.request(method, url).bearer_auth(token).header("Prefer", PREFER);
        if let Some(m) = if_match.filter(|m| !m.is_empty()) {
            req = req.header("If-Match", m);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = http::send(req)?;
        let status = resp.status().as_u16();
        let retry = http::retry_after(resp.headers());
        let text = resp.text().unwrap_or_default();
        if (200..300).contains(&status) {
            return if text.trim().is_empty() {
                Ok(Value::Null)
            } else {
                serde_json::from_str(&text).map_err(|e| Fail::from(SyncErr::Other(format!("Outlook answered with something unreadable ({e})"))))
            };
        }
        Err(Fail { status, code: error_info(&text).0, err: map_error(status, read, retry, &text) })
    }

    fn call(&self, method: Method, url: &str, body: Option<&Value>, if_match: Option<&str>) -> Result<Value, SyncErr> {
        self.request(method, url, body, if_match).map_err(|f| f.err)
    }

    /// A write that names a time zone: Graph takes IANA names as well as Windows names, but if this account's service refuses the
    /// name once, the same write is sent once more in UTC (no loop).
    fn write(&self, method: Method, url: &str, if_match: Option<&str>, zoned: bool, build: impl Fn(bool) -> Value) -> Result<Value, SyncErr> {
        match self.request(method.clone(), url, Some(&build(zoned)), if_match) {
            Err(f) if zoned && f.status == 400 && f.code.contains("timezone") => self.call(method, url, Some(&build(false)), if_match),
            other => other.map_err(|f| f.err),
        }
    }

    fn calendar_view_path(cal: &RemoteCalendar, tail: &str) -> String {
        if cal.primary {
            format!("/me/calendarView{tail}")
        } else {
            format!("/me/calendars/{}/calendarView{tail}", urlencoding::encode(&cal.id))
        }
    }

    fn event_url(&self, id: &str) -> String {
        format!("{}/me/events/{}", self.base, urlencoding::encode(id))
    }

    fn window(&self, path: &str, extra: &[(&str, String)], req: &PullReq) -> String {
        let mut q = vec![("startDateTime", iso(req.window_from)), ("endDateTime", iso(req.window_to))];
        q.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
        self.url(path, &q)
    }

    /// Read every page from `url` on. `delta` pages end with a `deltaLink` (returned), plain pages with no link (`None`).
    fn pages(&self, mut url: String, incremental: bool, delta: bool) -> Result<Pull, Fail> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut order: Vec<String> = vec![];
        let mut items: HashMap<String, Item> = HashMap::new();
        let mut pull = Pull { full: !incremental, ..Default::default() };
        loop {
            if !seen.insert(url.clone()) || seen.len() > MAX_PAGES {
                return Err(SyncErr::Other("Outlook never ended its list of events".into()).into());
            }
            let v = self.request(Method::GET, &url, None, None)?;
            for raw in v["value"].as_array().into_iter().flatten() {
                let Some(id) = raw["id"].as_str() else { continue };
                // (the same event can come twice in one round; the last entry counts, a removal after an update removes it)
                let entry = if raw.get("@removed").is_some() {
                    Some(Item::Removed)
                } else {
                    parse_event(raw).map(|ev| if ev.status == "cancelled" { Item::Removed } else { Item::Upsert(ev) })
                };
                let Some(entry) = entry else { continue };
                if items.insert(id.to_string(), entry).is_none() {
                    order.push(id.to_string());
                }
            }
            // (counted once a page)
            if items.values().filter(|i| matches!(i, Item::Upsert(_))).count() > MAX_EVENTS_PER_CALENDAR {
                pull.truncated = true;
                break;
            }
            match v["@odata.nextLink"].as_str() {
                Some(next) if self.own_link(next) => url = next.to_string(),
                Some(_) => return Err(SyncErr::Other("Outlook sent a link to another server".into()).into()),
                None => {
                    if delta {
                        match v["@odata.deltaLink"].as_str() {
                            Some(link) if self.own_link(link) => pull.next_state = Some(link.to_string()),
                            Some(_) => return Err(SyncErr::Other("Outlook sent a link to another server".into()).into()),
                            None => return Err(SyncErr::Other("Outlook ended the list of changes without a token".into()).into()),
                        }
                    }
                    break;
                }
            }
        }
        for id in order {
            match items.remove(&id) {
                Some(Item::Upsert(mut ev)) => {
                    if pull.truncated && pull.upserts.len() >= MAX_EVENTS_PER_CALENDAR {
                        continue;
                    }
                    ev.id = id;
                    pull.upserts.push(ev);
                }
                // a full download is the whole truth: a removal in it has nothing to remove
                Some(Item::Removed) if incremental => pull.removed.push(id),
                _ => {}
            }
        }
        if pull.truncated {
            // stopped before the last page: there is no token for what was not read
            pull.next_state = None;
        }
        Ok(pull)
    }
}

enum Item {
    Upsert(RemoteEvent),
    Removed,
}

/// Graph's `error.code` (lower case) and the first line of its `error.message`.
fn error_info(body: &str) -> (String, String) {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = v["error"]["code"].as_str().unwrap_or("").to_ascii_lowercase();
    let msg = v["error"]["message"].as_str().unwrap_or("").lines().next().unwrap_or("").trim().to_string();
    (code, msg)
}

/// Sort a failed answer into the states of the sync layer (design 6.4). `read` = the request only reads.
fn map_error(status: u16, read: bool, retry: Option<Duration>, body: &str) -> SyncErr {
    let (code, msg) = error_info(body);
    let shown = |fallback: &str| if msg.is_empty() { fallback.to_string() } else { msg.clone() };
    let lower = body.to_ascii_lowercase();
    // the organization has not approved the app (admin consent), whatever the status
    if ["aadsts65001", "aadsts90094", "aadsts900941", "consent_required"].iter().any(|k| lower.contains(k)) {
        return SyncErr::Blocked(shown("the organization has not approved the app"));
    }
    // the account has no Exchange Online mailbox the API can reach (inactive, on-premises, not licensed): nothing to fix in the app
    if matches!(code.as_str(), "mailboxnotenabledforrestapi" | "mailboxnotsupportedforrestapi" | "mailboxnotfound" | "erroraccountsuspend") {
        return SyncErr::NotSetUp(shown("this account has no mailbox that Outlook's calendar service can reach"));
    }
    if matches!(code.as_str(), "syncstatenotfound" | "resyncrequired" | "errorinvalidsyncstatedata" | "errorsyncstatenotfound") {
        return SyncErr::Gone;
    }
    if matches!(code.as_str(), "applicationthrottled" | "activitylimitreached" | "errorserverbusy" | "toomanyrequests") {
        return SyncErr::RateLimited(retry);
    }
    if code == "errorirresolvableconflict" || code == "errorchangekeymismatch" {
        return SyncErr::Conflict;
    }
    match status {
        401 => SyncErr::Auth,
        // the token is valid but the service refuses a read: the app may not read this mailbox (a tenant policy, consent withdrawn)
        403 if read && matches!(code.as_str(), "erroraccessdenied" | "authorization_requestdenied" | "accessdenied") => SyncErr::Blocked(shown("access denied")),
        403 => SyncErr::Other(format!("Outlook refused: {}", shown("forbidden"))),
        400 => SyncErr::Other(format!("Outlook rejected the request: {}", shown("bad request"))),
        409 => SyncErr::Other(format!("Outlook: {}", shown("conflict"))),
        s => match http::status_err(s, retry, body) {
            SyncErr::Other(_) => SyncErr::Other(format!("Outlook answered {s}: {}", shown(&http::short(body)))),
            e => e,
        },
    }
}

// ------------------------------------------------------------------ time

fn iso(sec: i64) -> String {
    Utc.timestamp_opt(sec, 0).single().map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default()
}

/// `dateTime` of Graph's `dateTimeTimeZone` ("2026-10-20T09:00:00.0000000", no offset).
fn naive(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s.trim().trim_end_matches('Z'), "%Y-%m-%dT%H:%M:%S%.f").ok()
}

/// A `dateTimeTimeZone` as an instant. "UTC" (what we ask for), or the zone named (IANA or Windows) when the service did not convert.
fn instant(o: &Value) -> Option<i64> {
    let n = naive(o["dateTime"].as_str()?)?;
    let zone = o["timeZone"].as_str().unwrap_or("UTC");
    match crate::ical::iana_for(zone).filter(|_| !zone.eq_ignore_ascii_case("utc")) {
        Some(tz) => tz.from_local_datetime(&n).earliest().map(|d| d.timestamp()),
        None => Some(n.and_utc().timestamp()),
    }
}

/// The date of an all-day boundary as the UTC midnight of that date. Graph gives all-day events as midnight in the event's own zone;
/// when the service converted them to UTC (`Prefer: outlook.timezone="UTC"`) the instant is converted back to the event's own zone
/// (`originalStartTimeZone` / `originalEndTimeZone`) before the date is taken, so the event never moves to the neighbouring day.
fn all_day_date(o: &Value, own_zone: Option<&str>) -> Option<i64> {
    let n = naive(o["dateTime"].as_str()?)?;
    if n.time().num_seconds_from_midnight() == 0 {
        return Some(crate::ical::day_utc(n.date()));
    }
    let local = instant(o).and_then(|t| {
        let tz = crate::ical::iana_for(own_zone?)?;
        Some(Utc.timestamp_opt(t, 0).single()?.with_timezone(&tz).naive_local())
    });
    let n = local.unwrap_or(n);
    // (still not midnight: the nearest day)
    let date: NaiveDate = if n.time().num_seconds_from_midnight() >= 12 * 3600 { n.date().succ_opt()? } else { n.date() };
    Some(crate::ical::day_utc(date))
}

fn date_of(sec: i64) -> String {
    Utc.timestamp_opt(sec, 0).single().map(|d| d.format("%Y-%m-%dT00:00:00").to_string()).unwrap_or_default()
}

/// Graph's `start` and `end` for a write. All-day: the dates as UTC midnights (the end is the day after the last day). Timed: the wall
/// clock in the event's zone when it has one and `zoned`, else UTC.
fn when_json(w: &When, zoned: bool) -> (Value, Value) {
    if w.all_day {
        return (json!({ "dateTime": date_of(w.start), "timeZone": "UTC" }), json!({ "dateTime": date_of(w.end), "timeZone": "UTC" }));
    }
    let tz = w.tzid.as_deref().filter(|_| zoned).and_then(|z| crate::ical::iana_for(z).map(|t| (z, t)));
    let one = |sec: i64| match &tz {
        Some((name, t)) => {
            let local = Utc.timestamp_opt(sec, 0).single().map(|d| d.with_timezone(t).format("%Y-%m-%dT%H:%M:%S").to_string()).unwrap_or_default();
            json!({ "dateTime": local, "timeZone": name })
        }
        None => json!({ "dateTime": Utc.timestamp_opt(sec, 0).single().map(|d| d.format("%Y-%m-%dT%H:%M:%S").to_string()).unwrap_or_default(), "timeZone": "UTC" }),
    };
    (one(w.start), one(w.end))
}

// ------------------------------------------------------------------ mapping

fn person(o: &Value) -> Option<CalPerson> {
    let email = o["address"].as_str()?.trim().to_ascii_lowercase();
    // (Graph repeats the address as the name when it knows none)
    let name = o["name"].as_str().filter(|n| !n.trim().is_empty() && !n.eq_ignore_ascii_case(&email)).map(String::from);
    (!email.is_empty()).then_some(CalPerson { email, name })
}

fn partstat(response: &str) -> &'static str {
    match response {
        "accepted" | "organizer" => "accepted",
        "tentativelyAccepted" => "tentative",
        "declined" => "declined",
        _ => "needs-action",
    }
}

/// The body as text (we ask for text; an HTML body is reduced anyway).
fn body_text(b: &Value) -> Option<String> {
    let content = b["content"].as_str()?;
    let t = if b["contentType"].as_str().is_some_and(|c| c.eq_ignore_ascii_case("html")) { plain_text(content) } else { content.replace("\r\n", "\n") };
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// One Graph event as a `RemoteEvent`. `None` for what the app does not show (a series master: the view lists its occurrences).
/// `showAs`, `categories`, `importance` and `sensitivity` are ignored.
fn parse_event(v: &Value) -> Option<RemoteEvent> {
    let id = v["id"].as_str()?.to_string();
    let typ = v["type"].as_str().unwrap_or("singleInstance");
    if typ == "seriesMaster" {
        return None;
    }
    let kind = match typ {
        "occurrence" => EventKind::Occurrence,
        "exception" => EventKind::Exception,
        _ => EventKind::Single,
    };
    let all_day = v["isAllDay"].as_bool() == Some(true);
    let (own_start, own_end) = (v["originalStartTimeZone"].as_str(), v["originalEndTimeZone"].as_str().or(v["originalStartTimeZone"].as_str()));
    let (start, end) = if all_day {
        (all_day_date(&v["start"], own_start)?, all_day_date(&v["end"], own_end)?)
    } else {
        (instant(&v["start"])?, instant(&v["end"])?)
    };
    let end = end.max(if all_day { start + 86_400 } else { start });
    let cancelled = v["isCancelled"].as_bool() == Some(true);
    let is_organizer = v["isOrganizer"].as_bool().unwrap_or(true);
    let organizer = person(&v["organizer"]["emailAddress"]);
    let attendees: Vec<CalAttendee> = v["attendees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["type"].as_str() != Some("resource"))
        .filter_map(|a| {
            let p = person(&a["emailAddress"])?;
            let chair = organizer.as_ref().is_some_and(|o| o.email == p.email);
            Some(CalAttendee {
                role: if chair { "chair" } else if a["type"].as_str() == Some("optional") { "optional" } else { "required" }.into(),
                status: partstat(a["status"]["response"].as_str().unwrap_or("")).into(),
                email: p.email,
                name: p.name,
                is_you: false,
            })
        })
        .collect();
    let my_status = if is_organizer && !attendees.is_empty() {
        Some("organizer".to_string())
    } else {
        match v["responseStatus"]["response"].as_str() {
            Some(r @ ("accepted" | "tentativelyAccepted" | "declined" | "notResponded")) => Some(if r == "notResponded" { "needs-action" } else { partstat(r) }.to_string()),
            _ => None,
        }
    };
    // as for Google: the organizer is shown with guests or when somebody else organizes; a plain own event has none
    let organizer = if !attendees.is_empty() || !is_organizer { organizer } else { None };
    let updated = v["lastModifiedDateTime"].as_str().and_then(|u| DateTime::parse_from_rfc3339(u).ok()).map(|d| d.timestamp());
    let join_url = v["onlineMeeting"]["joinUrl"].as_str().or_else(|| v["onlineMeetingUrl"].as_str()).filter(|u| !u.is_empty()).map(String::from);
    let instance = kind != EventKind::Single;
    let orig = v["originalStart"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp());
    Some(RemoteEvent {
        etag: v["@odata.etag"].as_str().unwrap_or("").to_string(),
        uid: v["iCalUId"].as_str().filter(|u| !u.is_empty()).unwrap_or(&id).to_string(),
        kind,
        series_id: v["seriesMasterId"].as_str().filter(|_| instance).map(String::from),
        recurrence_id: instance.then(|| orig.unwrap_or(start)),
        summary: v["subject"].as_str().unwrap_or("").to_string(),
        start,
        end,
        all_day,
        tzid: if all_day { None } else { own_start.and_then(crate::ical::iana_for).map(|t| t.name().to_string()) },
        location: v["location"]["displayName"].as_str().filter(|l| !l.trim().is_empty()).map(String::from),
        join_url,
        description: body_text(&v["body"]),
        organizer,
        attendees,
        rrule: None,
        exdates: vec![],
        rdates: vec![],
        status: if cancelled { "cancelled" } else { "confirmed" }.into(),
        my_status,
        reminder_min: (v["isReminderOn"].as_bool() == Some(true)).then(|| v["reminderMinutesBeforeStart"].as_i64()).flatten().filter(|m| *m >= 0),
        can_edit: is_organizer,
        updated,
        id,
    })
}

fn parse_calendar(v: &Value) -> Option<RemoteCalendar> {
    Some(RemoteCalendar {
        id: v["id"].as_str()?.to_string(),
        name: v["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or("Calendar").to_string(),
        // `hexColor` is empty for "auto": the app then uses the mailbox's colour
        color: v["hexColor"].as_str().filter(|c| c.starts_with('#')).unwrap_or("").to_string(),
        read_only: v["canEdit"].as_bool() == Some(false),
        primary: v["isDefaultCalendar"].as_bool() == Some(true),
        // Outlook shows all of them
        selected: true,
        time_zone: None,
        default_reminder_min: None,
    })
}

fn attendees_json(list: &[CalAttendee]) -> Value {
    // (the organizer is the user and is implicit; answers of the guests are the service's to keep)
    Value::Array(
        list.iter()
            .filter(|a| a.role != "chair")
            .map(|a| {
                let mut e = json!({ "address": a.email });
                if let Some(n) = &a.name {
                    e["name"] = json!(n);
                }
                json!({ "emailAddress": e, "type": if a.role == "optional" { "optional" } else { "required" } })
            })
            .collect(),
    )
}

fn reminder_json(min: Option<i64>) -> Value {
    match min {
        Some(m) => json!({ "isReminderOn": true, "reminderMinutesBeforeStart": m }),
        None => json!({ "isReminderOn": false }),
    }
}

fn text_body(t: &str) -> Value {
    json!({ "contentType": "text", "content": t })
}

impl CalProvider for MicrosoftProvider {
    fn list_calendars(&self) -> Result<Vec<RemoteCalendar>, SyncErr> {
        let mut url = self.url("/me/calendars", &[("$top", PAGE.to_string()), ("$select", "id,name,hexColor,isDefaultCalendar,canEdit,owner".into())]);
        let mut raw: Vec<Value> = vec![];
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            if !seen.insert(url.clone()) || seen.len() > 100 {
                return Err(SyncErr::Other("Outlook never ended its list of calendars".into()));
            }
            let v = self.call(Method::GET, &url, None, None)?;
            raw.extend(v["value"].as_array().cloned().unwrap_or_default());
            match v["@odata.nextLink"].as_str() {
                Some(next) if self.own_link(next) => url = next.to_string(),
                Some(_) => return Err(SyncErr::Other("Outlook sent a link to another server".into())),
                None => break,
            }
        }
        // calendars other people shared with the person need `Calendars.ReadWrite.Shared`, which the app does not ask for: only the
        // person's own calendars (owner = the owner of the default calendar) are listed
        let mine = raw
            .iter()
            .find(|c| c["isDefaultCalendar"].as_bool() == Some(true))
            .and_then(|c| c["owner"]["address"].as_str())
            .map(|a| a.to_ascii_lowercase());
        Ok(raw
            .iter()
            .filter(|c| match (&mine, c["owner"]["address"].as_str()) {
                (Some(m), Some(o)) => o.eq_ignore_ascii_case(m),
                _ => true,
            })
            .filter_map(parse_calendar)
            .collect())
    }

    fn pull(&self, cal: &RemoteCalendar, req: &PullReq) -> Result<Pull, SyncErr> {
        let incremental = req.state.is_some();
        let url = match &req.state {
            // a stored link that is not ours (an old build, a damaged database) is not followed: download again
            Some(link) if !self.own_link(link) => return Err(SyncErr::Gone),
            Some(link) => link.clone(),
            None => self.window(&Self::calendar_view_path(cal, "/delta"), &[], req),
        };
        match self.pages(url, incremental, true) {
            Ok(p) => Ok(p),
            // a calendar that has no delta (the per-calendar delta path is not documented for every calendar kind): its window is
            // downloaded in full every round, with no token
            Err(f) if !incremental && matches!(f.status, 400 | 405 | 501) && f.err != SyncErr::Gone => {
                let url = self.window(&Self::calendar_view_path(cal, ""), &[("$top", PAGE.to_string())], req);
                self.pages(url, false, false).map_err(|f| f.err)
            }
            Err(f) => Err(f.err),
        }
    }

    fn create(&self, cal: &RemoteCalendar, ev: &EventDraft) -> Result<RemoteEvent, SyncErr> {
        let url = format!("{}/me/calendars/{}/events", self.base, urlencoding::encode(&cal.id));
        let build = |zoned: bool| {
            let (start, end) = when_json(&When { start: ev.start, end: ev.end, all_day: ev.all_day, tzid: ev.tzid.clone() }, zoned);
            let mut body = json!({ "subject": ev.summary, "start": start, "end": end, "isAllDay": ev.all_day });
            body.as_object_mut().unwrap().extend(reminder_json(ev.reminder_min).as_object().cloned().unwrap_or_default());
            if let Some(l) = &ev.location {
                body["location"] = json!({ "displayName": l });
            }
            if let Some(d) = &ev.description {
                body["body"] = text_body(d);
            }
            if !ev.attendees.is_empty() {
                body["attendees"] = attendees_json(&ev.attendees);
            }
            body
        };
        // Outlook sends the invitations to the guests (the app sends none for these events)
        let v = self.write(Method::POST, &url, None, ev.tzid.is_some() && !ev.all_day, build)?;
        parse_event(&v).ok_or_else(|| SyncErr::Other("Outlook answered with an event that cannot be shown".into()))
    }

    fn update(&self, _cal: &RemoteCalendar, remote_id: &str, etag: &str, changed: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        let build = |zoned: bool| {
            let mut body = json!({});
            if let Some(s) = &changed.summary {
                body["subject"] = json!(s);
            }
            if let Some(w) = &changed.when {
                let (s, e) = when_json(w, zoned);
                body["isAllDay"] = json!(w.all_day);
                body["start"] = s;
                body["end"] = e;
            }
            if let Some(l) = &changed.location {
                body["location"] = json!({ "displayName": l.clone().unwrap_or_default() });
            }
            if let Some(d) = &changed.description {
                body["body"] = text_body(d.as_deref().unwrap_or(""));
            }
            if let Some(a) = &changed.attendees {
                body["attendees"] = attendees_json(a);
            }
            if let Some(r) = &changed.reminder_min {
                body.as_object_mut().unwrap().extend(reminder_json(*r).as_object().cloned().unwrap_or_default());
            }
            body
        };
        let zoned = changed.when.as_ref().is_some_and(|w| w.tzid.is_some() && !w.all_day);
        let v = self.write(Method::PATCH, &self.event_url(remote_id), Some(etag), zoned, build)?;
        parse_event(&v).ok_or_else(|| SyncErr::Other("Outlook answered with an event that cannot be shown".into()))
    }

    fn delete(&self, _cal: &RemoteCalendar, remote_id: &str, etag: &str) -> Result<(), SyncErr> {
        // (deleting a meeting the person organizes makes Outlook send the cancellation to the guests)
        match self.call(Method::DELETE, &self.event_url(remote_id), None, Some(etag)) {
            Ok(_) => Ok(()),
            Err(SyncErr::Gone) => Err(SyncErr::NotFound),
            Err(e) => Err(e),
        }
    }

    fn respond(&self, _cal: &RemoteCalendar, remote_id: &str, _etag: &str, status: Rsvp, _me: &str, _attendees: &[CalAttendee]) -> Result<(), SyncErr> {
        let action = match status {
            Rsvp::Accepted => "accept",
            Rsvp::Tentative => "tentativelyAccept",
            Rsvp::Declined => "decline",
        };
        // `sendResponse: false`: the organizer got the reply mail from the app, Outlook must not tell them again
        self.call(Method::POST, &format!("{}/{action}", self.event_url(remote_id)), Some(&json!({ "sendResponse": false })), None).map(|_| ())
    }

    fn rebaseline_after_days(&self) -> Option<i64> {
        // a delta token covers the window it was started with: start again when that window is more than 30 days old
        Some(30)
    }
}

#[cfg(test)]
#[path = "microsoft_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "microsoft_tests_rw.rs"]
mod tests_rw;
