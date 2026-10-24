//! Google Calendar API v3 (REST/JSON over HTTPS) as a `CalProvider`.
//!
//! Scopes (a separate calendar-only consent, see `oauth::Purpose::Calendar`): `calendar.events` (view and edit events) and
//! `calendar.calendarlist.readonly` (list the calendars). Endpoints used: `calendarList.list`, `events.list` (syncToken, 410 = full
//! resync), `events.insert`, `events.patch` and `events.delete` with `If-Match`.
use super::http;
use super::store::Source;
use super::{CalList, CalProvider, EventDraft, EventKind, EventPatch, Kind, Pull, PullReq, Recurrence, RemoteCalendar, RemoteEvent, Rsvp, SyncErr, When, MAX_EVENTS_PER_CALENDAR};
use crate::calendar::{CalAttendee, CalPerson};
use crate::Db;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use reqwest::Method;
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://www.googleapis.com/calendar/v3";
const PAGE: &str = "250";

/// The provider of a source, with the access token fetched (and refreshed) before every request.
pub fn provider(db: &Db, src: &Source) -> Result<Box<dyn CalProvider>, SyncErr> {
    let (db, account) = (db.clone(), src.account_id.clone());
    Ok(Box::new(GoogleProvider::new(
        &http::base_url("HEYLOOK_GCAL_BASE", API),
        Box::new(move || super::cmds::calendar_token(&db, Kind::Google, &account)),
    )))
}

type TokenFn = Box<dyn Fn() -> Result<String, SyncErr> + Send + Sync>;

pub struct GoogleProvider {
    base: String,
    token: TokenFn,
    http: reqwest::blocking::Client,
}

impl GoogleProvider {
    pub fn new(base: &str, token: TokenFn) -> GoogleProvider {
        GoogleProvider { base: base.trim_end_matches('/').to_string(), token, http: http::client() }
    }

    /// One request. `query` values are encoded here; the answer is the JSON body (`Null` for an empty one).
    fn call(&self, method: Method, path: &str, query: &[(&str, String)], body: Option<&Value>, if_match: Option<&str>) -> Result<Value, SyncErr> {
        let token = (self.token)()?;
        let mut url = format!("{}{}", self.base, path);
        for (i, (k, v)) in query.iter().enumerate() {
            url.push(if i == 0 { '?' } else { '&' });
            url.push_str(&format!("{k}={}", urlencoding::encode(v)));
        }
        let mut req = self.http.request(method, url).bearer_auth(token);
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
                serde_json::from_str(&text).map_err(|e| SyncErr::Other(format!("Google Calendar answered with something unreadable ({e})")))
            };
        }
        Err(map_error(status, retry, &text))
    }

    /// The instance of a series that starts at `original_start` (`events.instances` with `originalStart`): its id and version tag. `NotFound` when the series has none there.
    fn instance(&self, cal: &RemoteCalendar, series_id: &str, original_start: i64, all_day: bool) -> Result<RemoteEvent, SyncErr> {
        let start = if all_day { date_of(original_start) } else { rfc3339(original_start) };
        let q = vec![("originalStart", start), ("maxResults", "1".to_string())];
        let v = self.call(Method::GET, &format!("{}/instances", Self::event_path(cal, series_id)), &q, None, None)?;
        v["items"].as_array().into_iter().flatten().find_map(|i| parse_event(cal, i)).filter(|e| e.status != "cancelled").ok_or(SyncErr::NotFound)
    }

    fn events_path(cal: &RemoteCalendar) -> String {
        format!("/calendars/{}/events", urlencoding::encode(&cal.id))
    }

    fn event_path(cal: &RemoteCalendar, id: &str) -> String {
        format!("/calendars/{}/events/{}", urlencoding::encode(&cal.id), urlencoding::encode(id))
    }
}

/// Reasons Google puts in `error.errors[].reason` and `error.details[].reason`, lower-cased, with the message.
fn error_info(body: &str) -> (Vec<String>, Vec<String>, String) {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut reasons = vec![];
    let mut domains = vec![];
    for e in v["error"]["errors"].as_array().into_iter().flatten() {
        if let Some(r) = e["reason"].as_str() {
            reasons.push(r.to_ascii_lowercase());
        }
        if let Some(d) = e["domain"].as_str() {
            domains.push(d.to_ascii_lowercase());
        }
    }
    for d in v["error"]["details"].as_array().into_iter().flatten() {
        if let Some(r) = d["reason"].as_str() {
            reasons.push(r.to_ascii_lowercase());
        }
    }
    if let Some(s) = v["error"]["status"].as_str() {
        reasons.push(s.to_ascii_lowercase());
    }
    let msg = v["error"]["message"].as_str().unwrap_or("").lines().next().unwrap_or("").to_string();
    (reasons, domains, msg)
}

/// Sort a failed answer into the states of the sync layer (design 6.4).
fn map_error(status: u16, retry: Option<Duration>, body: &str) -> SyncErr {
    let (reasons, domains, msg) = error_info(body);
    let has = |names: &[&str]| reasons.iter().any(|r| names.contains(&r.as_str()));
    let shown = |fallback: &str| if msg.is_empty() { fallback.to_string() } else { msg.clone() };
    // the Calendar API is not enabled in the Cloud project of the app's client: nothing the person can fix
    if has(&["accessnotconfigured", "service_disabled"]) {
        return SyncErr::NotSetUp(shown("Google Calendar API is not enabled"));
    }
    match status {
        401 => SyncErr::Auth,
        403 if has(&["ratelimitexceeded", "userratelimitexceeded", "quotaexceeded", "dailylimitexceeded", "calendarusagelimitsexceeded", "rate_limit_exceeded"])
            || domains.iter().any(|d| d == "usagelimits") =>
        {
            SyncErr::RateLimited(retry)
        }
        403 if has(&["insufficientpermissions", "insufficient_scope", "access_token_scope_insufficient", "autherror"]) => SyncErr::Auth,
        403 if has(&["admin_policy_enforced", "org_internal", "domainpolicy"]) => SyncErr::Blocked(shown("blocked by the organization")),
        403 => SyncErr::Other(format!("Google Calendar refused: {}", shown("forbidden"))),
        409 => SyncErr::Other(format!("Google Calendar: {}", shown("conflict"))),
        s => match http::status_err(s, retry, body) {
            SyncErr::Other(_) => SyncErr::Other(format!("Google Calendar answered {s}: {}", shown(&http::short(body)))),
            e => e,
        },
    }
}

// ------------------------------------------------------------------ time

struct Point {
    instant: i64,
    all_day: bool,
    tz: Option<String>,
}

/// `start` / `end` / `originalStartTime` of an event: a `date` (all day, as the UTC midnight of that day) or a `dateTime`.
fn point(o: &Value) -> Option<Point> {
    if let Some(d) = o["date"].as_str() {
        let day = NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
        return Some(Point { instant: crate::ical::day_utc(day), all_day: true, tz: None });
    }
    let dt = DateTime::parse_from_rfc3339(o["dateTime"].as_str()?).ok()?;
    Some(Point { instant: dt.timestamp(), all_day: false, tz: o["timeZone"].as_str().map(String::from) })
}

fn rfc3339(sec: i64) -> String {
    Utc.timestamp_opt(sec, 0).single().map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default()
}

fn date_of(sec: i64) -> String {
    Utc.timestamp_opt(sec, 0).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// The times of an event as Google's `start` / `end`. A patch has to clear the keys of the other kind (all day <-> timed).
fn when_json(w: &When, patch: bool) -> (Value, Value) {
    let one = |sec: i64| {
        if w.all_day {
            let mut o = json!({ "date": date_of(sec) });
            if patch {
                o["dateTime"] = Value::Null;
                o["timeZone"] = Value::Null;
            }
            o
        } else {
            let mut o = json!({ "dateTime": rfc3339(sec) });
            if let Some(tz) = &w.tzid {
                o["timeZone"] = json!(tz);
            }
            if patch {
                o["date"] = Value::Null;
            }
            o
        }
    };
    (one(w.start), one(w.end))
}

/// One `EXDATE` / `RDATE` property value list as instants. `params` is what stands between the name and the colon.
fn ical_instants(params: &str, values: &str) -> Vec<i64> {
    let tz = params.split(';').find_map(|p| p.strip_prefix("TZID=")).and_then(crate::ical::iana_for);
    values
        .split(',')
        .filter_map(|v| {
            // VALUE=PERIOD (`start/end` or `start/duration`): the start is the date
            let v = v.split('/').next().unwrap_or(v).trim();
            if v.len() == 8 {
                return NaiveDate::parse_from_str(v, "%Y%m%d").ok().map(crate::ical::day_utc);
            }
            if let Some(utc) = v.strip_suffix('Z') {
                return NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok().map(|d| d.and_utc().timestamp());
            }
            let local = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
            match tz {
                Some(z) => z.from_local_datetime(&local).earliest().map(|d| d.timestamp()),
                None => Some(local.and_utc().timestamp()),
            }
        })
        .collect()
}

/// `recurrence[]` of a master: the first RRULE (without its prefix), the EXDATEs and the RDATEs (extra dates, in the order Google lists them).
fn recurrence(lines: &[Value]) -> (Option<String>, Vec<i64>, Vec<i64>) {
    let mut rule = None;
    let mut ex = vec![];
    let mut extra: Vec<i64> = vec![];
    for l in lines.iter().filter_map(|l| l.as_str()) {
        let Some((head, value)) = l.split_once(':') else { continue };
        let name = head.split(';').next().unwrap_or("").to_ascii_uppercase();
        match name.as_str() {
            "RRULE" if rule.is_none() => rule = Some(value.trim().to_string()),
            "EXDATE" => ex.extend(ical_instants(head, value)),
            "RDATE" => {
                for r in ical_instants(head, value) {
                    if !extra.contains(&r) && extra.len() < crate::ical::MAX_EXDATES {
                        extra.push(r);
                    }
                }
            }
            _ => {}
        }
    }
    (rule, ex, extra)
}

/// One `EXDATE` / `RDATE` line for a list of instants, in the form of the series' start: dates for an all-day series, local times with TZID for a zoned one,
/// UTC otherwise.
fn date_line(name: &str, list: &[i64], all_day: bool, tzid: Option<&str>) -> Option<String> {
    if list.is_empty() {
        return None;
    }
    let tz = tzid.and_then(crate::ical::iana_for).filter(|_| !all_day);
    let values: Vec<String> = list
        .iter()
        .map(|t| {
            if all_day {
                date_of(*t).replace('-', "")
            } else {
                crate::ical::wall_in(tz, *t).format("%Y%m%dT%H%M%S").to_string() + if tz.is_some() { "" } else { "Z" }
            }
        })
        .collect();
    let head = match (all_day, tz) {
        (true, _) => format!("{name};VALUE=DATE"),
        (false, Some(z)) => format!("{name};TZID={}", z.name()),
        (false, None) => name.to_string(),
    };
    Some(format!("{head}:{}", values.join(",")))
}

/// `recurrence[]` of a write: the rule and the dates that go with it. `Null` when there is nothing left (the event stops repeating).
fn recurrence_json(r: &Recurrence) -> Value {
    let mut lines: Vec<String> = vec![];
    if let Some(rule) = r.rrule.as_deref().map(crate::recur::bare).filter(|x| !x.is_empty()) {
        lines.push(format!("RRULE:{rule}"));
    }
    lines.extend(date_line("EXDATE", &r.exdates, r.all_day, r.tzid.as_deref()));
    lines.extend(date_line("RDATE", &r.rdates, r.all_day, r.tzid.as_deref()));
    if lines.is_empty() { Value::Null } else { json!(lines) }
}

// ------------------------------------------------------------------ mapping

fn partstat(s: &str) -> &'static str {
    match s {
        "accepted" => "accepted",
        "declined" => "declined",
        "tentative" => "tentative",
        _ => "needs-action",
    }
}

fn google_status(s: &str) -> &'static str {
    match s {
        "accepted" => "accepted",
        "declined" => "declined",
        "tentative" => "tentative",
        _ => "needsAction",
    }
}

/// Google's description is often HTML; the app keeps text.
pub(super) fn plain_text(s: &str) -> String {
    if !s.contains('<') && !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut tag = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match (in_tag, c) {
            (false, '<') => (in_tag, tag) = (true, String::new()),
            (true, '>') => {
                in_tag = false;
                let t = tag.trim_start_matches('/').split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                if matches!(t.as_str(), "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3") && !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            (true, c) => tag.push(c),
            (false, c) => out.push(c),
        }
    }
    out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&").trim().to_string()
}

fn person(o: &Value) -> Option<CalPerson> {
    let email = o["email"].as_str()?.trim().to_ascii_lowercase();
    (!email.is_empty()).then(|| CalPerson { email, name: o["displayName"].as_str().filter(|n| !n.trim().is_empty()).map(String::from) })
}

/// Reminder minutes: the event's own popup reminder, or the calendar's default when the event uses the default; email-only
/// reminders do not count (the app fires popups).
fn reminder(v: &Value, cal: &RemoteCalendar) -> Option<i64> {
    let r = &v["reminders"];
    if r["useDefault"].as_bool() == Some(true) {
        return cal.default_reminder_min;
    }
    r["overrides"].as_array()?.iter().find(|o| o["method"].as_str() == Some("popup")).and_then(|o| o["minutes"].as_i64()).filter(|m| *m >= 0)
}

/// One Google event as a `RemoteEvent`. `None` for events the app does not show (working location).
fn parse_event(cal: &RemoteCalendar, v: &Value) -> Option<RemoteEvent> {
    let id = v["id"].as_str()?.to_string();
    let event_type = v["eventType"].as_str().unwrap_or("default");
    if event_type == "workingLocation" {
        return None;
    }
    let status = match v["status"].as_str() {
        Some("cancelled") => "cancelled",
        Some("tentative") => "tentative",
        _ => "confirmed",
    };
    let series = v["recurringEventId"].as_str().map(String::from);
    let orig = point(&v["originalStartTime"]).map(|p| p.instant);
    let start = point(&v["start"]);
    let end = point(&v["end"]);
    let updated = v["updated"].as_str().and_then(|u| DateTime::parse_from_rfc3339(u).ok()).map(|d| d.timestamp());
    let uid = v["iCalUID"].as_str().unwrap_or(&id).to_string();
    let etag = v["etag"].as_str().unwrap_or("").to_string();
    let recurrence_lines = v["recurrence"].as_array().cloned().unwrap_or_default();
    let (rrule, exdates, rdates) = recurrence(&recurrence_lines);
    let kind = if series.is_some() {
        EventKind::Exception
    } else if !recurrence_lines.is_empty() {
        EventKind::Master
    } else {
        EventKind::Single
    };
    // a cancelled instance carries little more than its id and original start
    let Some(start) = start.or_else(|| (status == "cancelled").then(|| Point { instant: orig.unwrap_or(0), all_day: false, tz: None })) else {
        return None;
    };
    let all_day = start.all_day;
    let end_instant = end.map(|e| e.instant).unwrap_or(start.instant + if all_day { 86_400 } else { 3600 }).max(start.instant);
    let attendees: Vec<CalAttendee> = v["attendees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["resource"].as_bool() != Some(true))
        .filter_map(|a| {
            let p = person(a)?;
            Some(CalAttendee {
                email: p.email,
                name: p.name,
                role: if a["organizer"].as_bool() == Some(true) { "chair" } else if a["optional"].as_bool() == Some(true) { "optional" } else { "required" }.into(),
                status: partstat(a["responseStatus"].as_str().unwrap_or("")).into(),
                is_you: false,
            })
        })
        .collect();
    let organizer_self = v["organizer"]["self"].as_bool() == Some(true);
    let me = v["attendees"].as_array().into_iter().flatten().find(|a| a["self"].as_bool() == Some(true));
    let my_status = if organizer_self && !attendees.is_empty() {
        Some("organizer".to_string())
    } else {
        me.map(|a| partstat(a["responseStatus"].as_str().unwrap_or("")).to_string())
    };
    // the organizer is shown when there are guests or somebody else organizes; a plain own event has none (as a local event)
    let organizer = if !attendees.is_empty() || (!organizer_self && v["organizer"].is_object()) { person(&v["organizer"]) } else { None };
    let can_edit = event_type == "default"
        && v["locked"].as_bool() != Some(true)
        && (organizer_self || !v["organizer"].is_object() || v["guestsCanModify"].as_bool() == Some(true) || (v["creator"]["self"].as_bool() == Some(true) && v["organizer"]["email"].is_null()));
    let join_url = v["hangoutLink"].as_str().map(String::from).or_else(|| {
        v["conferenceData"]["entryPoints"].as_array()?.iter().find(|e| e["entryPointType"].as_str() == Some("video")).and_then(|e| e["uri"].as_str()).map(String::from)
    });
    Some(RemoteEvent {
        id,
        etag,
        uid,
        ext_uid: None,
        kind,
        series_id: series,
        recurrence_id: if kind == EventKind::Exception { Some(orig.unwrap_or(start.instant)) } else { None },
        summary: v["summary"].as_str().unwrap_or("").to_string(),
        start: start.instant,
        end: end_instant,
        all_day,
        tzid: if all_day { None } else { start.tz.or_else(|| cal.time_zone.clone().filter(|_| kind == EventKind::Master)) },
        location: v["location"].as_str().map(String::from),
        join_url,
        description: v["description"].as_str().map(plain_text),
        organizer,
        attendees,
        rrule,
        exdates,
        rdates,
        pattern_unsupported: false,
        status: status.into(),
        my_status,
        reminder_min: reminder(v, cal),
        can_edit,
        updated,
    })
}

fn parse_calendar(v: &Value) -> Option<RemoteCalendar> {
    if v["deleted"].as_bool() == Some(true) {
        return None;
    }
    let role = v["accessRole"].as_str().unwrap_or("reader");
    // free/busy only: no event details to show
    if role == "freeBusyReader" {
        return None;
    }
    let primary = v["primary"].as_bool() == Some(true);
    let name = v["summaryOverride"].as_str().filter(|n| !n.trim().is_empty()).or_else(|| v["summary"].as_str()).unwrap_or("Calendar");
    Some(RemoteCalendar {
        id: v["id"].as_str()?.to_string(),
        name: name.to_string(),
        color: v["backgroundColor"].as_str().unwrap_or("").to_string(),
        read_only: !matches!(role, "owner" | "writer"),
        primary,
        // `selected` is what the person sees in Google Calendar's own list
        selected: v["selected"].as_bool() == Some(true) || primary,
        time_zone: v["timeZone"].as_str().map(String::from),
        default_reminder_min: v["defaultReminders"].as_array().and_then(|l| l.iter().find(|r| r["method"].as_str() == Some("popup"))).and_then(|r| r["minutes"].as_i64()),
    })
}

fn attendees_json(list: &[CalAttendee], with_status: bool) -> Value {
    Value::Array(
        list.iter()
            .map(|a| {
                let mut o = json!({ "email": a.email, "optional": a.role == "optional" });
                if let Some(n) = &a.name {
                    o["displayName"] = json!(n);
                }
                if with_status {
                    o["responseStatus"] = json!(google_status(&a.status));
                }
                if a.role == "chair" {
                    o["organizer"] = json!(true);
                }
                o
            })
            .collect(),
    )
}

fn reminders_json(min: Option<i64>) -> Value {
    match min {
        Some(m) => json!({ "useDefault": false, "overrides": [{ "method": "popup", "minutes": m }] }),
        None => json!({ "useDefault": false, "overrides": [] }),
    }
}

impl CalProvider for GoogleProvider {
    fn list_calendars(&self) -> Result<Vec<RemoteCalendar>, SyncErr> {
        Ok(self.list_calendars_since(None)?.calendars)
    }

    /// `calendarList.list`, with the `syncToken` of the last list when there is one: then only the entries that changed come back
    /// (`deleted: true` for a calendar that was removed, `hidden: true` for one the person hid, which the full list leaves out too).
    fn list_calendars_since(&self, state: Option<&str>) -> Result<CalList, SyncErr> {
        let mut out = CalList { full: state.is_none(), ..Default::default() };
        let mut page: Option<String> = None;
        loop {
            let mut q = vec![("maxResults", PAGE.to_string())];
            if let Some(t) = state {
                q.push(("syncToken", t.to_string()));
            }
            if let Some(p) = &page {
                q.push(("pageToken", p.clone()));
            }
            let v = self.call(Method::GET, "/users/me/calendarList", &q, None, None)?;
            for item in v["items"].as_array().into_iter().flatten() {
                let hidden = state.is_some() && item["hidden"].as_bool() == Some(true);
                match parse_calendar(item) {
                    Some(c) if !hidden => out.calendars.push(c),
                    // an incremental answer names what is gone (deleted, hidden, or now free/busy only)
                    _ if state.is_some() => out.removed.extend(item["id"].as_str().map(String::from)),
                    _ => {}
                }
            }
            page = v["nextPageToken"].as_str().map(String::from);
            if page.is_none() {
                out.next_state = v["nextSyncToken"].as_str().map(String::from);
                return Ok(out);
            }
        }
    }

    fn pull(&self, cal: &RemoteCalendar, req: &PullReq) -> Result<Pull, SyncErr> {
        let full = req.state.is_none();
        let mut pull = Pull { full, ..Default::default() };
        let mut page: Option<String> = None;
        loop {
            // `showDeleted` is on for both: deletions (and cancelled instances of a series) come back as `cancelled` events
            let mut q = vec![("maxResults", PAGE.to_string()), ("showDeleted", "true".into()), ("singleEvents", "false".into())];
            match &req.state {
                Some(tok) => q.push(("syncToken", tok.clone())),
                // events that end after the start of the window; everything in the future
                None => q.push(("timeMin", rfc3339(req.window_from))),
            }
            if let Some(p) = &page {
                q.push(("pageToken", p.clone()));
            }
            let v = self.call(Method::GET, &Self::events_path(cal), &q, None, None)?;
            for item in v["items"].as_array().into_iter().flatten() {
                let Some(ev) = parse_event(cal, item) else { continue };
                let deleted = ev.status == "cancelled";
                let instance = matches!(ev.kind, EventKind::Exception) && ev.series_id.is_some();
                if deleted && !instance {
                    // a deleted single event or series: nothing to download in a full pull, a deletion in an incremental one
                    if !full {
                        pull.removed.push(ev.id);
                    }
                    continue;
                }
                if pull.upserts.len() >= MAX_EVENTS_PER_CALENDAR {
                    pull.truncated = true;
                    break;
                }
                pull.upserts.push(ev);
            }
            if pull.truncated {
                // stopped before the last page: there is no token for what was not read
                pull.next_state = None;
                return Ok(pull);
            }
            page = v["nextPageToken"].as_str().map(String::from);
            if page.is_none() {
                pull.next_state = v["nextSyncToken"].as_str().map(String::from);
                return Ok(pull);
            }
        }
    }

    fn create(&self, cal: &RemoteCalendar, ev: &EventDraft) -> Result<RemoteEvent, SyncErr> {
        let (start, end) = when_json(&When { start: ev.start, end: ev.end, all_day: ev.all_day, tzid: ev.tzid.clone() }, false);
        let mut body = json!({ "summary": ev.summary, "start": start, "end": end, "reminders": reminders_json(ev.reminder_min) });
        if let Some(l) = &ev.location {
            body["location"] = json!(l);
        }
        if let Some(d) = &ev.description {
            body["description"] = json!(d);
        }
        if !ev.attendees.is_empty() {
            body["attendees"] = attendees_json(&ev.attendees, false);
        }
        if let Some(rule) = ev.rrule.as_deref().map(crate::recur::bare).filter(|r| !r.is_empty()) {
            body["recurrence"] = json!([format!("RRULE:{rule}")]);
            // a repeating event has to name the zone its rule is worked out in
            if !ev.all_day && ev.tzid.is_none() {
                body["start"]["timeZone"] = json!("UTC");
                body["end"]["timeZone"] = json!("UTC");
            }
        }
        // Google sends the invitations to the guests (the app sends none for these events)
        let v = self.call(Method::POST, &Self::events_path(cal), &[("sendUpdates", "all".into())], Some(&body), None)?;
        parse_event(cal, &v).ok_or_else(|| SyncErr::Other("Google Calendar answered with an event that cannot be shown".into()))
    }

    fn update(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, changed: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        let mut body = json!({});
        if let Some(s) = &changed.summary {
            body["summary"] = json!(s);
        }
        if let Some(w) = &changed.when {
            let (s, e) = when_json(w, true);
            body["start"] = s;
            body["end"] = e;
        }
        if let Some(l) = &changed.location {
            body["location"] = l.as_ref().map(|l| json!(l)).unwrap_or(Value::Null);
        }
        if let Some(d) = &changed.description {
            body["description"] = d.as_ref().map(|d| json!(d)).unwrap_or(Value::Null);
        }
        if let Some(a) = &changed.attendees {
            body["attendees"] = attendees_json(a, true);
        }
        if let Some(r) = &changed.reminder_min {
            body["reminders"] = reminders_json(*r);
        }
        if let Some(rec) = &changed.recurrence {
            body["recurrence"] = recurrence_json(rec);
            // (a series names the zone of its rule whenever its time is written)
            if !rec.all_day && rec.tzid.is_none() && changed.when.is_some() {
                body["start"]["timeZone"] = json!("UTC");
                body["end"]["timeZone"] = json!("UTC");
            }
        }
        let v = self.call(Method::PATCH, &Self::event_path(cal, remote_id), &[("sendUpdates", "all".into())], Some(&body), Some(etag))?;
        parse_event(cal, &v).ok_or_else(|| SyncErr::Other("Google Calendar answered with an event that cannot be shown".into()))
    }

    fn delete(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str) -> Result<(), SyncErr> {
        match self.call(Method::DELETE, &Self::event_path(cal, remote_id), &[("sendUpdates", "all".into())], None, Some(etag)) {
            Ok(_) => Ok(()),
            // 410: already deleted
            Err(SyncErr::Gone) => Err(SyncErr::NotFound),
            Err(e) => Err(e),
        }
    }

    fn get_series(&self, cal: &RemoteCalendar, series_id: &str) -> Result<RemoteEvent, SyncErr> {
        let v = self.call(Method::GET, &Self::event_path(cal, series_id), &[], None, None)?;
        parse_event(cal, &v).ok_or_else(|| SyncErr::Other("Google Calendar answered with an event that cannot be shown".into()))
    }

    fn update_occurrence(&self, cal: &RemoteCalendar, series_id: &str, original_start: i64, all_day: bool, changed: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        let inst = self.instance(cal, series_id, original_start, all_day)?;
        let mut patch = changed.clone();
        // (an occurrence has no rule of its own)
        patch.recurrence = None;
        self.update(cal, &inst.id, &inst.etag, &patch)
    }

    fn delete_occurrence(&self, cal: &RemoteCalendar, series_id: &str, original_start: i64, all_day: bool) -> Result<String, SyncErr> {
        let inst = self.instance(cal, series_id, original_start, all_day)?;
        self.delete(cal, &inst.id, &inst.etag)?;
        Ok(inst.id)
    }

    fn respond(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, status: Rsvp, me: &str, attendees: &[CalAttendee]) -> Result<(), SyncErr> {
        let answer = match status {
            Rsvp::Accepted => "accepted",
            Rsvp::Tentative => "tentative",
            Rsvp::Declined => "declined",
        };
        let mut list = attendees.to_vec();
        for a in list.iter_mut().filter(|a| a.email.eq_ignore_ascii_case(me)) {
            a.status = answer.into();
        }
        let body = json!({ "attendees": attendees_json(&list, true) });
        // `sendUpdates=none`: the organizer got the reply mail from the app, Google must not tell them again
        self.call(Method::PATCH, &Self::event_path(cal, remote_id), &[("sendUpdates", "none".into())], Some(&body), Some(etag)).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::super::engine::{self, Clock};
    use super::super::fake_http::{FakeServer, Resp};
    use super::super::store::tests::{conn, ACC};
    use super::super::{store, write, ProviderFactory, AUTH, BUSY, NOT_SET_UP, OK};
    use super::*;
    use crate::calendar;
    use crate::lock;
    use std::sync::{Arc, Mutex};

    const T0: i64 = 1_800_000_000;

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap().timestamp()
    }

    fn cal() -> RemoteCalendar {
        RemoteCalendar { id: "primary".into(), name: "Me".into(), color: "#039be5".into(), selected: true, primary: true, default_reminder_min: Some(30), time_zone: Some("America/New_York".into()), ..Default::default() }
    }

    fn provider(srv: &FakeServer) -> GoogleProvider {
        GoogleProvider::new(&srv.base, Box::new(|| Ok("tok-1".to_string())))
    }

    /// Provides a Google provider that talks to the fake server (the token is fixed).
    struct GFactory {
        base: String,
        token: Arc<dyn Fn() -> Result<String, SyncErr> + Send + Sync>,
    }

    impl GFactory {
        fn new(srv: &FakeServer) -> GFactory {
            GFactory { base: srv.base.clone(), token: Arc::new(|| Ok("tok-1".to_string())) }
        }
    }

    impl ProviderFactory for GFactory {
        fn provider(&self, _: &store::Source) -> Result<Box<dyn CalProvider>, SyncErr> {
            let t = self.token.clone();
            Ok(Box::new(GoogleProvider::new(&self.base, Box::new(move || t()))))
        }
    }

    fn list_json(items: Vec<Value>) -> Value {
        json!({ "kind": "calendar#calendarList", "items": items })
    }

    fn primary_item() -> Value {
        json!({ "id": "primary", "summary": "Me", "backgroundColor": "#039be5", "accessRole": "owner", "primary": true, "selected": true, "timeZone": "America/New_York", "defaultReminders": [{ "method": "popup", "minutes": 30 }] })
    }

    fn ev_json(id: &str, summary: &str, start: &str, end: &str) -> Value {
        json!({ "kind": "calendar#event", "id": id, "etag": format!("\"etag-{id}\""), "iCalUID": format!("{id}@google.com"), "status": "confirmed", "summary": summary,
                "start": { "dateTime": start }, "end": { "dateTime": end }, "organizer": { "email": "me@gmail.test", "self": true }, "updated": "2026-10-15T08:00:00.000Z" })
    }

    fn events_page(items: Vec<Value>, next_page: Option<&str>, sync: Option<&str>) -> Value {
        let mut v = json!({ "kind": "calendar#events", "items": items });
        if let Some(p) = next_page {
            v["nextPageToken"] = json!(p);
        }
        if let Some(s) = sync {
            v["nextSyncToken"] = json!(s);
        }
        v
    }

    fn setup_db() -> (crate::Db, String) {
        let c = conn();
        let s = store::create_source(&c, ACC, Kind::Google, 0).unwrap();
        (Arc::new(Mutex::new(c)), s.id)
    }

    fn rows(db: &crate::Db) -> Vec<String> {
        let c = lock(db);
        let mut st = c.prepare("SELECT summary FROM events WHERE remote_id IS NOT NULL ORDER BY starts_at, summary").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn state_of(db: &crate::Db) -> Option<String> {
        store::get_calendar(&lock(db), &super::super::calendar_id(ACC, Kind::Google, "primary")).and_then(|c| c.sync_state)
    }

    fn clock(now: i64) -> Clock {
        Clock { now, jitter: 0.5 }
    }

    // ---------------------------------------------------------------- calendars

    #[test]
    fn calendars_are_listed_over_pages_with_colour_access_selection_and_defaults() {
        let srv = FakeServer::start(|r| {
            assert_eq!(r.path(), "/users/me/calendarList");
            match r.query("pageToken").as_deref() {
                None => Resp::json(200, json!({ "items": [primary_item()], "nextPageToken": "p2" })),
                Some("p2") => Resp::json(200, list_json(vec![
                    json!({ "id": "en.vietnamese#holiday@group.v.calendar.google.com", "summary": "Holidays in Vietnam", "summaryOverride": "Ngay le", "backgroundColor": "#0b8043", "accessRole": "reader", "timeZone": "Asia/Ho_Chi_Minh" }),
                    json!({ "id": "team@group.calendar.google.com", "summary": "Team", "backgroundColor": "#d50000", "accessRole": "writer", "selected": true }),
                    json!({ "id": "gone@x", "summary": "Deleted", "deleted": true, "accessRole": "owner" }),
                    json!({ "id": "busy@x", "summary": "Free/busy only", "accessRole": "freeBusyReader" }),
                ])),
                other => panic!("unexpected page {other:?}"),
            }
        });
        let got = provider(&srv).list_calendars().unwrap();
        assert_eq!(got.len(), 3, "deleted and free/busy-only calendars are not listed");
        let p = &got[0];
        assert_eq!((p.id.as_str(), p.name.as_str(), p.color.as_str(), p.read_only, p.primary, p.selected), ("primary", "Me", "#039be5", false, true, true));
        assert_eq!((p.time_zone.as_deref(), p.default_reminder_min), (Some("America/New_York"), Some(30)));
        let h = &got[1];
        assert_eq!((h.name.as_str(), h.read_only, h.selected, h.default_reminder_min), ("Ngay le", true, false, None), "the person's own name, read only, not shown by default");
        assert!(!got[2].read_only && got[2].selected);
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].headers["authorization"], "Bearer tok-1");
        assert_eq!(reqs[0].query("maxResults").as_deref(), Some("250"));
    }

    /// W7.6: the list is asked with the token of the last list; the answer names changed entries, deleted ones and hidden ones; 410 = a full list.
    #[test]
    fn the_calendar_list_asks_with_its_token_and_reads_changed_deleted_and_hidden_entries() {
        let srv = FakeServer::start(|r| {
            assert_eq!(r.path(), "/users/me/calendarList");
            assert_eq!(r.query("minAccessRole"), None, "Google refuses it together with a sync token");
            match (r.query("syncToken").as_deref(), r.query("pageToken").as_deref()) {
                (None, None) => Resp::json(200, json!({ "items": [primary_item()], "nextPageToken": "p2" })),
                (None, Some("p2")) => Resp::json(200, json!({ "items": [json!({ "id": "team", "summary": "Team", "accessRole": "writer", "selected": true })], "nextSyncToken": "L1" })),
                (Some("L1"), None) => Resp::json(
                    200,
                    json!({ "items": [
                        json!({ "id": "team", "summary": "Team renamed", "accessRole": "writer", "selected": true }),
                        json!({ "id": "gone", "deleted": true }),
                        json!({ "id": "hid", "summary": "Hidden now", "accessRole": "owner", "hidden": true }),
                        json!({ "id": "busy", "summary": "Now free/busy", "accessRole": "freeBusyReader" }),
                    ], "nextPageToken": "q2" }),
                ),
                (Some("L1"), Some("q2")) => Resp::json(200, json!({ "items": [json!({ "id": "new", "summary": "New", "accessRole": "reader" })], "nextSyncToken": "L2" })),
                (Some("L2"), None) => Resp::json(200, json!({ "items": [], "nextSyncToken": "L3" })),
                (Some("old"), None) => Resp::json(410, json!({ "error": { "code": 410, "message": "Sync token is no longer valid, a full sync is required.", "errors": [{ "reason": "fullSyncRequired" }] } })),
                other => panic!("unexpected {other:?}"),
            }
        });
        let p = provider(&srv);
        let first = p.list_calendars_since(None).unwrap();
        assert!(first.full && first.removed.is_empty());
        assert_eq!((first.calendars.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), first.next_state.as_deref()), (vec!["Me", "Team"], Some("L1")));
        let second = p.list_calendars_since(Some("L1")).unwrap();
        assert!(!second.full);
        assert_eq!(second.calendars.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["Team renamed", "New"]);
        assert_eq!(second.removed, vec!["gone", "hid", "busy"], "deleted, hidden and free/busy-only entries are gone from the list");
        assert_eq!(second.next_state.as_deref(), Some("L2"), "the token comes with the last page");
        let third = p.list_calendars_since(Some("L2")).unwrap();
        assert_eq!((third.calendars.len(), third.removed.len(), third.full, third.next_state.as_deref()), (0, 0, false, Some("L3")));
        assert_eq!(p.list_calendars_since(Some("old")).unwrap_err(), SyncErr::Gone);
        // `list_calendars` is the full list
        assert_eq!(p.list_calendars().unwrap().len(), 2);
    }

    /// W7.6 end to end: the second round asks with the token and no events are requested without theirs; a 410 gives one full list.
    #[test]
    fn a_synced_round_uses_the_list_token_and_recovers_from_410() {
        let (db, sid) = setup_db();
        let stale = Arc::new(Mutex::new(false));
        let st = stale.clone();
        let srv = FakeServer::start(move |r| match (r.path(), r.query("syncToken").as_deref()) {
            ("/users/me/calendarList", None) => Resp::json(200, json!({ "items": [primary_item()], "nextSyncToken": "L1" })),
            ("/users/me/calendarList", Some(t)) if *st.lock().unwrap() && t == "L2" => Resp::json(410, json!({ "error": { "code": 410, "message": "gone", "errors": [{ "reason": "fullSyncRequired" }] } })),
            ("/users/me/calendarList", Some(_)) => Resp::json(200, json!({ "items": [], "nextSyncToken": "L2" })),
            ("/calendars/primary/events", None) => Resp::json(200, events_page(vec![ev_json("a", "First", "2026-10-20T09:00:00-04:00", "2026-10-20T10:00:00-04:00")], None, Some("E1"))),
            ("/calendars/primary/events", Some(_)) => Resp::json(200, events_page(vec![], None, Some("E2"))),
            p => panic!("unexpected {p:?}"),
        });
        let factory = GFactory::new(&srv);
        engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        engine::sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        let reqs = srv.requests();
        let lists: Vec<Option<String>> = reqs.iter().filter(|r| r.path() == "/users/me/calendarList").map(|r| r.query("syncToken")).collect();
        assert_eq!(lists, vec![None, Some("L1".to_string())], "the second round asks for the changes only");
        let events: Vec<Option<String>> = reqs.iter().filter(|r| r.path() == "/calendars/primary/events").map(|r| r.query("syncToken")).collect();
        assert_eq!(events, vec![None, Some("E1".to_string())]);
        assert_eq!(store::get_source(&lock(&db), &sid).unwrap().list_state.as_deref(), Some("L2"));
        // the token expires: one more list without it, no error
        *stale.lock().unwrap() = true;
        let r = engine::sync_source(&db, &factory, &sid, clock(T0 + 600), &|| {}).unwrap();
        assert_eq!((r.status.as_str(), store::get_source(&lock(&db), &sid).unwrap().list_state), (OK, Some("L1".to_string())));
        assert_eq!(store::calendars_of(&lock(&db), &sid).unwrap().len(), 1, "no duplicate calendar");
        assert_eq!(rows(&db), vec!["First"]);
    }

    /// W7.2 / AC-7.2.3: a master whose `recurrence` has an RDATE line shows the extra date; an EXDATE on it hides it.
    #[test]
    fn a_master_with_an_rdate_line_shows_the_extra_date() {
        let (db, sid) = setup_db();
        let master = |lines: Value| {
            json!({
                "id": "ser", "etag": "\"m1\"", "iCalUID": "ser@google.com", "status": "confirmed", "summary": "Weekly sync",
                "start": { "dateTime": "2026-10-13T09:00:00-04:00", "timeZone": "America/New_York" }, "end": { "dateTime": "2026-10-13T10:00:00-04:00", "timeZone": "America/New_York" },
                "recurrence": lines, "organizer": { "email": "me@gmail.test", "self": true },
            })
        };
        let m = master(json!(["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2", "RDATE;TZID=America/New_York:20261029T150000"]));
        let srv = FakeServer::start(move |r| match r.path() {
            "/users/me/calendarList" => Resp::json(200, list_json(vec![primary_item()])),
            _ => Resp::json(200, events_page(vec![m.clone()], None, Some("S1"))),
        });
        engine::sync_source(&db, &GFactory::new(&srv), &sid, clock(T0), &|| {}).unwrap();
        let shown = |db: &crate::Db| -> Vec<i64> { calendar::list_range(&lock(db), utc(2026, 10, 12, 0, 0), utc(2026, 11, 30, 0, 0)).unwrap().into_iter().map(|e| e.start).collect() };
        // Tue 13 and 20 Oct (EDT, 09:00 = 13:00Z) and Thu 29 Oct 15:00 EDT = 19:00Z
        assert_eq!(shown(&db), vec![utc(2026, 10, 13, 13, 0), utc(2026, 10, 20, 13, 0), utc(2026, 10, 29, 19, 0)]);
        assert!(calendar::list_range(&lock(&db), utc(2026, 10, 12, 0, 0), utc(2026, 11, 30, 0, 0)).unwrap().iter().all(|e| e.has_rdates));
        // the same series with an EXDATE on the extra date
        let (db2, sid2) = setup_db();
        let m3 = master(json!(["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2", "RDATE;TZID=America/New_York:20261029T150000", "EXDATE;TZID=America/New_York:20261029T150000"]));
        let srv2 = FakeServer::start(move |r| match r.path() {
            "/users/me/calendarList" => Resp::json(200, list_json(vec![primary_item()])),
            _ => Resp::json(200, events_page(vec![m3.clone()], None, Some("S1"))),
        });
        engine::sync_source(&db2, &GFactory::new(&srv2), &sid2, clock(T0), &|| {}).unwrap();
        assert_eq!(shown(&db2), vec![utc(2026, 10, 13, 13, 0), utc(2026, 10, 20, 13, 0)]);
        // a master with only an RDATE is a series too
        let e = parse_event(&cal(), &master(json!(["RDATE:20261101T090000Z"]))).unwrap();
        assert_eq!((e.kind, e.rrule, e.rdates), (EventKind::Master, None, vec![utc(2026, 11, 1, 9, 0)]));
        // PERIOD values count by their start
        assert_eq!(recurrence(&[json!("RDATE;VALUE=PERIOD:20261101T090000Z/PT1H,20261102T090000Z/20261102T100000Z")]).2, vec![utc(2026, 11, 1, 9, 0), utc(2026, 11, 2, 9, 0)]);
    }

    // ---------------------------------------------------------------- sync

    #[test]
    fn a_full_sync_over_two_pages_stores_the_rows_and_the_token_only_at_the_end() {
        let (db, sid) = setup_db();
        let fail_second = Arc::new(Mutex::new(true));
        let f2 = fail_second.clone();
        let srv = FakeServer::start(move |r| match r.path() {
            "/users/me/calendarList" => Resp::json(200, list_json(vec![primary_item()])),
            "/calendars/primary/events" => match r.query("pageToken").as_deref() {
                None => Resp::json(200, events_page(vec![ev_json("a", "First", "2026-10-20T09:00:00-04:00", "2026-10-20T10:00:00-04:00")], Some("page2"), None)),
                Some(_) if *f2.lock().unwrap() => Resp::json(500, json!({ "error": { "code": 500, "message": "Backend Error" } })),
                Some(_) => Resp::json(200, events_page(vec![ev_json("b", "Second", "2026-10-21T09:00:00-04:00", "2026-10-21T10:00:00-04:00")], None, Some("SYNC-1"))),
            },
            p => panic!("unexpected {p}"),
        });
        let factory = GFactory::new(&srv);
        // page 2 fails: nothing of the round is kept, no token
        let r = engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!(r.status, BUSY);
        assert!(rows(&db).is_empty() && state_of(&db).is_none(), "the round counts completely or not at all");
        *fail_second.lock().unwrap() = false;
        // (after the back-off) it works: both pages, the token at the end
        let r = engine::sync_source(&db, &factory, &sid, clock(T0 + 3600), &|| {}).unwrap();
        assert_eq!(r.status, OK);
        assert_eq!(rows(&db), vec!["First", "Second"]);
        assert_eq!(state_of(&db).as_deref(), Some("SYNC-1"));
        // what the full request asked for: all (also deleted) events ending after now-365 days, not expanded, 250 a page
        let first = srv.requests().into_iter().find(|r| r.path().ends_with("/events") && r.query("pageToken").is_none()).unwrap();
        assert_eq!(first.query("timeMin"), Some(rfc3339(T0 - 365 * 86_400)));
        assert_eq!((first.query("singleEvents").as_deref(), first.query("showDeleted").as_deref(), first.query("maxResults").as_deref()), (Some("false"), Some("true"), Some("250")));
        assert!(first.query("syncToken").is_none() && first.query("timeMax").is_none(), "everything in the future");
        let page2 = srv.requests().into_iter().rev().find(|r| r.query("pageToken").as_deref() == Some("page2")).unwrap();
        assert_eq!(page2.query("timeMin"), Some(rfc3339(T0 + 3600 - 365 * 86_400)), "the same query on every page");
    }

    #[test]
    fn an_incremental_sync_uses_the_token_and_a_cancelled_event_removes_the_row() {
        let (db, sid) = setup_db();
        let round = Arc::new(Mutex::new(0));
        let r2 = round.clone();
        let srv = FakeServer::start(move |r| match r.path() {
            "/users/me/calendarList" => Resp::json(200, list_json(vec![primary_item()])),
            _ => {
                let n = *r2.lock().unwrap();
                if n == 0 {
                    Resp::json(200, events_page(vec![ev_json("a", "Keep", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z"), ev_json("b", "Delete me", "2026-10-21T09:00:00Z", "2026-10-21T10:00:00Z")], None, Some("S1")))
                } else {
                    assert_eq!(r.query("syncToken").as_deref(), Some("S1"));
                    assert!(r.query("timeMin").is_none(), "timeMin cannot be combined with a sync token");
                    let mut changed = ev_json("a", "Keep (renamed)", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z");
                    changed["etag"] = json!("\"etag-a2\"");
                    Resp::json(200, events_page(vec![changed, json!({ "id": "b", "status": "cancelled" })], None, Some("S2")))
                }
            }
        });
        let factory = GFactory::new(&srv);
        engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!(rows(&db), vec!["Keep", "Delete me"]);
        *round.lock().unwrap() = 1;
        let r = engine::sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        assert_eq!((r.status.as_str(), r.changed), (OK, true));
        assert_eq!(rows(&db), vec!["Keep (renamed)"]);
        assert_eq!(state_of(&db).as_deref(), Some("S2"));
    }

    #[test]
    fn a_410_gone_downloads_everything_again_without_duplicates_or_an_error() {
        let (db, sid) = setup_db();
        let calls = Arc::new(Mutex::new(vec![]));
        let c2 = calls.clone();
        let srv = FakeServer::start(move |r| match r.path() {
            "/users/me/calendarList" => Resp::json(200, list_json(vec![primary_item()])),
            _ => {
                c2.lock().unwrap().push(r.query("syncToken"));
                match r.query("syncToken").as_deref() {
                    Some("S1") => Resp::json(410, json!({ "error": { "code": 410, "message": "Sync token is no longer valid, a full sync is required.", "errors": [{ "reason": "fullSyncRequired" }] } })),
                    _ => Resp::json(200, events_page(vec![ev_json("a", "Only one", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z")], None, Some("S3"))),
                }
            }
        });
        let factory = GFactory::new(&srv);
        // an earlier state: two rows and the token S1
        {
            let c = lock(&db);
            let src = store::get_source(&c, &sid).unwrap();
            store::reconcile_calendars(&c, &src, &[cal()]).unwrap();
            let cal_row = store::get_calendar(&c, &super::super::calendar_id(ACC, Kind::Google, "primary")).unwrap();
            for id in ["a", "gone"] {
                let mut e = RemoteEvent::single(id, id, T0, T0 + 60);
                e.uid = format!("{id}@google.com");
                store::upsert_remote(&c, &cal_row, ACC, &e).unwrap();
            }
            c.execute("UPDATE calendars SET sync_state='S1'", []).unwrap();
        }
        let r = engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!(r.status, OK, "no error state for a 410");
        assert_eq!(rows(&db), vec!["Only one"], "no duplicates, the event deleted meanwhile is gone");
        assert_eq!(*calls.lock().unwrap(), vec![Some("S1".to_string()), None], "the token was tried once, then a full download");
        assert_eq!(state_of(&db).as_deref(), Some("S3"));
    }

    #[test]
    fn a_series_with_a_moved_instance_a_cancelled_instance_and_an_exdate_shows_the_right_instances() {
        let (db, sid) = setup_db();
        let master = json!({
            "id": "ser", "etag": "\"m1\"", "iCalUID": "ser@google.com", "status": "confirmed", "summary": "Weekly sync",
            "start": { "dateTime": "2026-10-13T09:00:00-04:00", "timeZone": "America/New_York" }, "end": { "dateTime": "2026-10-13T10:00:00-04:00", "timeZone": "America/New_York" },
            "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=TU", "EXDATE;TZID=America/New_York:20261027T090000"],
            "organizer": { "email": "me@gmail.test", "self": true },
        });
        // the 20 Oct instance moved to Wednesday 11:00; the 3 Nov instance cancelled (it arrives first: the order must not matter)
        let moved = json!({
            "id": "ser_20261020T130000Z", "etag": "\"x1\"", "iCalUID": "ser@google.com", "status": "confirmed", "summary": "Weekly sync (moved)", "recurringEventId": "ser",
            "originalStartTime": { "dateTime": "2026-10-20T09:00:00-04:00", "timeZone": "America/New_York" },
            "start": { "dateTime": "2026-10-21T11:00:00-04:00", "timeZone": "America/New_York" }, "end": { "dateTime": "2026-10-21T12:00:00-04:00", "timeZone": "America/New_York" },
            "organizer": { "email": "me@gmail.test", "self": true },
        });
        let cancelled = json!({ "id": "ser_20261103T140000Z", "status": "cancelled", "recurringEventId": "ser", "originalStartTime": { "dateTime": "2026-11-03T09:00:00-05:00", "timeZone": "America/New_York" } });
        let srv = FakeServer::start(move |r| match r.path() {
            "/users/me/calendarList" => Resp::json(200, list_json(vec![primary_item()])),
            _ => Resp::json(200, events_page(vec![cancelled.clone(), moved.clone(), master.clone()], None, Some("S1"))),
        });
        engine::sync_source(&db, &GFactory::new(&srv), &sid, clock(T0), &|| {}).unwrap();
        let shown: Vec<(String, i64)> = calendar::list_range(&lock(&db), utc(2026, 10, 12, 0, 0), utc(2026, 11, 11, 0, 0)).unwrap().into_iter().map(|e| (e.summary, e.start)).collect();
        assert_eq!(
            shown,
            vec![
                ("Weekly sync".to_string(), utc(2026, 10, 13, 13, 0)),
                ("Weekly sync (moved)".to_string(), utc(2026, 10, 21, 15, 0)),
                // 27 Oct is an EXDATE, 3 Nov is cancelled; 10 Nov is after the clocks changed (09:00 EST = 14:00 UTC)
                ("Weekly sync".to_string(), utc(2026, 11, 10, 14, 0)),
            ],
            "the moved one at its new time, none on the deleted dates, no duplicate"
        );
        // a series of the person's own can be changed since 1.0.7
        assert!(calendar::list_range(&lock(&db), utc(2026, 10, 12, 0, 0), utc(2026, 11, 11, 0, 0)).unwrap().iter().all(|e| e.read_only.is_none() && e.series));
        assert_eq!(rows(&db).len(), 2, "the master and the exception; the cancelled instance is a tombstone");
    }

    // ---------------------------------------------------------------- mapping

    #[test]
    fn all_day_zoned_events_reminders_and_attendees_are_mapped() {
        let c = cal();
        // a 3-day all-day event: dates, end exclusive
        let mut v = json!({ "id": "ad", "status": "confirmed", "summary": "Trip", "start": { "date": "2026-10-20" }, "end": { "date": "2026-10-23" }, "iCalUID": "ad@google.com", "organizer": { "email": "me@gmail.test", "self": true }, "reminders": { "useDefault": true } });
        let e = parse_event(&c, &v).unwrap();
        assert_eq!((e.start, e.end, e.all_day, e.tzid.clone()), (utc(2026, 10, 20, 0, 0), utc(2026, 10, 23, 0, 0), true, None));
        assert_eq!(e.reminder_min, Some(30), "the calendar's default reminder");
        // a timed event in New York with its own popup reminder (an e-mail reminder is not a popup)
        v = json!({ "id": "t", "status": "tentative", "summary": "Call", "start": { "dateTime": "2026-10-20T09:00:00-04:00", "timeZone": "America/New_York" }, "end": { "dateTime": "2026-10-20T09:30:00-04:00", "timeZone": "America/New_York" },
                    "reminders": { "useDefault": false, "overrides": [{ "method": "email", "minutes": 1440 }, { "method": "popup", "minutes": 10 }] }, "organizer": { "email": "me@gmail.test", "self": true } });
        let e = parse_event(&c, &v).unwrap();
        assert_eq!((e.start, e.end, e.tzid.as_deref(), e.reminder_min, e.status.as_str()), (utc(2026, 10, 20, 13, 0), utc(2026, 10, 20, 13, 30), Some("America/New_York"), Some(10), "tentative"));
        assert_eq!(e.uid, "t", "no iCalUID: the id");
        v["reminders"] = json!({ "useDefault": false, "overrides": [{ "method": "email", "minutes": 5 }] });
        assert_eq!(parse_event(&c, &v).unwrap().reminder_min, None);
        v["reminders"] = json!({ "useDefault": false });
        assert_eq!(parse_event(&c, &v).unwrap().reminder_min, None);
        // somebody else's event I accepted: my answer, the organizer, the guests, not editable; resources are left out
        v = json!({ "id": "o", "summary": "Review", "start": { "dateTime": "2026-10-20T09:00:00Z" }, "end": { "dateTime": "2026-10-20T10:00:00Z" },
                    "organizer": { "email": "Boss@X.test", "displayName": "Boss" },
                    "attendees": [
                        { "email": "boss@x.test", "displayName": "Boss", "organizer": true, "responseStatus": "accepted" },
                        { "email": "me@gmail.test", "self": true, "responseStatus": "accepted" },
                        { "email": "opt@x.test", "optional": true, "responseStatus": "needsAction" },
                        { "email": "room@resource.calendar.google.com", "resource": true, "responseStatus": "accepted" },
                    ],
                    "hangoutLink": "https://meet.google.com/abc-defg-hij", "description": "Agenda:<br>1. <b>Budget</b> &amp; plans<p>Bring notes" });
        let e = parse_event(&c, &v).unwrap();
        assert_eq!((e.my_status.as_deref(), e.can_edit, e.organizer.as_ref().map(|o| o.email.as_str())), (Some("accepted"), false, Some("boss@x.test")));
        assert_eq!(e.attendees.iter().map(|a| (a.email.as_str(), a.role.as_str(), a.status.as_str())).collect::<Vec<_>>(), vec![("boss@x.test", "chair", "accepted"), ("me@gmail.test", "required", "accepted"), ("opt@x.test", "optional", "needs-action")]);
        assert_eq!(e.join_url.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
        assert_eq!(e.description.as_deref(), Some("Agenda:\n1. Budget & plans\nBring notes"));
        // guests may modify: editable. My own event with guests: organizer + chair
        v["guestsCanModify"] = json!(true);
        assert!(parse_event(&c, &v).unwrap().can_edit);
        v = json!({ "id": "m", "summary": "Mine", "start": { "dateTime": "2026-10-20T09:00:00Z" }, "end": { "dateTime": "2026-10-20T10:00:00Z" }, "organizer": { "email": "me@gmail.test", "self": true },
                    "attendees": [{ "email": "me@gmail.test", "self": true, "organizer": true, "responseStatus": "accepted" }, { "email": "g@x.test", "responseStatus": "needsAction" }] });
        let e = parse_event(&c, &v).unwrap();
        assert_eq!((e.my_status.as_deref(), e.can_edit, e.organizer.is_some()), (Some("organizer"), true, true));
        // the conference link of a Teams / Zoom event, a birthday (not editable) and a working location (not shown)
        v = json!({ "id": "z", "summary": "Zoom", "start": { "dateTime": "2026-10-20T09:00:00Z" }, "end": { "dateTime": "2026-10-20T10:00:00Z" }, "organizer": { "email": "me@gmail.test", "self": true },
                    "conferenceData": { "entryPoints": [{ "entryPointType": "phone", "uri": "tel:+1" }, { "entryPointType": "video", "uri": "https://zoom.us/j/1" }] } });
        assert_eq!(parse_event(&c, &v).unwrap().join_url.as_deref(), Some("https://zoom.us/j/1"));
        v["eventType"] = json!("birthday");
        assert!(!parse_event(&c, &v).unwrap().can_edit);
        v["eventType"] = json!("workingLocation");
        assert!(parse_event(&c, &v).is_none());
        // an event without an organizer (imported) can be edited, a locked one cannot
        v = json!({ "id": "i", "summary": "Imported", "start": { "dateTime": "2026-10-20T09:00:00Z" }, "end": { "dateTime": "2026-10-20T10:00:00Z" } });
        assert!(parse_event(&c, &v).unwrap().can_edit);
        v["locked"] = json!(true);
        assert!(!parse_event(&c, &v).unwrap().can_edit);
    }

    #[test]
    fn recurrence_lines_and_exdates_are_read_in_every_form() {
        let (rule, ex, rd) = recurrence(&[json!("RRULE:FREQ=DAILY;COUNT=5"), json!("RRULE:FREQ=WEEKLY"), json!("EXDATE:20261021T130000Z,20261022T130000Z"), json!("EXDATE;VALUE=DATE:20261025"), json!("EXDATE;TZID=Europe/Paris:20261026T090000"), json!("RDATE:20261101T090000Z")]);
        assert_eq!(rule.as_deref(), Some("FREQ=DAILY;COUNT=5"), "the first rule");
        assert_eq!(ex, vec![utc(2026, 10, 21, 13, 0), utc(2026, 10, 22, 13, 0), utc(2026, 10, 25, 0, 0), utc(2026, 10, 26, 8, 0)]);
        assert_eq!(rd, vec![utc(2026, 11, 1, 9, 0)]);
        assert_eq!(recurrence(&[]).0, None);
        assert_eq!(ical_instants("", "garbage,20261021T130000Z"), vec![utc(2026, 10, 21, 13, 0)]);
    }

    #[test]
    fn a_cancelled_instance_without_times_still_maps_and_garbage_does_not_panic() {
        let c = cal();
        let e = parse_event(&c, &json!({ "id": "s_1", "status": "cancelled", "recurringEventId": "s", "originalStartTime": { "dateTime": "2026-11-03T09:00:00-05:00" } })).unwrap();
        assert_eq!((e.status.as_str(), e.series_id.as_deref(), e.recurrence_id, e.kind), ("cancelled", Some("s"), Some(utc(2026, 11, 3, 14, 0)), EventKind::Exception));
        // a deleted single event: only its id
        let e = parse_event(&c, &json!({ "id": "x", "status": "cancelled" })).unwrap();
        assert_eq!((e.id.as_str(), e.status.as_str(), e.kind), ("x", "cancelled", EventKind::Single));
        // no id / no start: nothing to show
        assert!(parse_event(&c, &json!({ "summary": "no id" })).is_none());
        assert!(parse_event(&c, &json!({ "id": "n", "summary": "no start" })).is_none());
        assert!(parse_event(&c, &json!({ "id": "n", "start": { "dateTime": "yesterday" } })).is_none());
        assert_eq!(plain_text("plain"), "plain");
        assert_eq!(plain_text("a &lt;b&gt; &quot;c&quot;"), "a <b> \"c\"");
    }

    // ---------------------------------------------------------------- writes

    fn patch_server() -> FakeServer {
        FakeServer::start(|r| match (r.method.as_str(), r.path()) {
            ("POST", "/calendars/team%40group.calendar.google.com/events") => {
                let mut v = r.json();
                v["id"] = json!("newid");
                v["etag"] = json!("\"created\"");
                v["iCalUID"] = json!("newid@google.com");
                v["organizer"] = json!({ "email": "me@gmail.test", "self": true });
                Resp::json(200, v)
            }
            ("PATCH", "/calendars/primary/events/ev1") => {
                let mut v = ev_json("ev1", "Updated", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z");
                v["etag"] = json!("\"after\"");
                Resp::json(200, v)
            }
            ("DELETE", "/calendars/primary/events/ev1") => Resp::empty(204),
            ("DELETE", "/calendars/primary/events/old") => Resp::json(410, json!({ "error": { "code": 410, "message": "Resource has been deleted", "errors": [{ "reason": "deleted" }] } })),
            (m, p) => panic!("unexpected {m} {p}"),
        })
    }

    #[test]
    fn create_sends_the_event_with_the_guests_and_asks_google_to_send_the_invitations() {
        let srv = patch_server();
        let team = RemoteCalendar { id: "team@group.calendar.google.com".into(), ..cal() };
        let draft = EventDraft {
            summary: "Dinner".into(),
            start: utc(2026, 10, 20, 17, 0),
            end: utc(2026, 10, 20, 18, 0),
            all_day: false,
            tzid: Some("America/New_York".into()),
            location: Some("Home".into()),
            description: None,
            attendees: vec![CalAttendee { email: "g@x.test".into(), name: Some("Guest".into()), role: "optional".into(), status: "needs-action".into(), is_you: false }],
            reminder_min: Some(15),
            rrule: None,
        };
        let got = provider(&srv).create(&team, &draft).unwrap();
        assert_eq!((got.id.as_str(), got.etag.as_str()), ("newid", "\"created\""));
        let r = &srv.requests()[0];
        assert_eq!(r.query("sendUpdates").as_deref(), Some("all"), "Google sends the invitations");
        let b = r.json();
        assert_eq!(b["summary"], "Dinner");
        assert_eq!(b["start"], json!({ "dateTime": "2026-10-20T17:00:00Z", "timeZone": "America/New_York" }));
        assert_eq!(b["attendees"], json!([{ "email": "g@x.test", "optional": true, "displayName": "Guest" }]), "no answer is sent for a new guest");
        assert_eq!(b["reminders"], json!({ "useDefault": false, "overrides": [{ "method": "popup", "minutes": 15 }] }));
        assert!(b.get("description").is_none(), "unset fields are left out");
        // an all-day event goes out as dates
        let day = EventDraft { all_day: true, tzid: None, start: utc(2026, 10, 20, 0, 0), end: utc(2026, 10, 22, 0, 0), reminder_min: None, attendees: vec![], location: None, ..draft };
        provider(&srv).create(&team, &day).unwrap();
        let b = srv.requests()[1].json();
        assert_eq!((b["start"].clone(), b["end"].clone()), (json!({ "date": "2026-10-20" }), json!({ "date": "2026-10-22" })));
        assert_eq!(b["reminders"], json!({ "useDefault": false, "overrides": [] }));
        assert!(b.get("attendees").is_none());
    }

    #[test]
    fn patch_sends_if_match_and_only_the_changed_fields_with_cleared_fields_as_null() {
        let srv = patch_server();
        let guests = vec![
            CalAttendee { email: "me@gmail.test".into(), name: None, role: "chair".into(), status: "accepted".into(), is_you: true },
            CalAttendee { email: "g@x.test".into(), name: None, role: "required".into(), status: "tentative".into(), is_you: false },
        ];
        let patch = EventPatch {
            summary: Some("Updated".into()),
            when: Some(When { start: utc(2026, 10, 20, 9, 0), end: utc(2026, 10, 20, 10, 0), all_day: false, tzid: None }),
            location: Some(None),
            attendees: Some(guests),
            ..Default::default()
        };
        let got = provider(&srv).update(&cal(), "ev1", "\"before\"", &patch).unwrap();
        assert_eq!((got.summary.as_str(), got.etag.as_str()), ("Updated", "\"after\""));
        let r = &srv.requests()[0];
        assert_eq!((r.method.as_str(), r.headers["if-match"].as_str(), r.query("sendUpdates").as_deref()), ("PATCH", "\"before\"", Some("all")));
        let b = r.json();
        let keys: Vec<&str> = b.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys.len(), 5, "summary, start, end, location, attendees only: {keys:?}");
        assert_eq!(b["location"], Value::Null, "cleared");
        assert_eq!(b["start"], json!({ "dateTime": "2026-10-20T09:00:00Z", "date": null }), "a timed event drops its date");
        assert_eq!(b["attendees"][1], json!({ "email": "g@x.test", "optional": false, "responseStatus": "tentative" }));
        assert_eq!(b["attendees"][0]["organizer"], json!(true), "the whole list is sent with the answers that exist");
        // all day: the date, the time keys cleared
        let day = EventPatch { when: Some(When { start: utc(2026, 10, 20, 0, 0), end: utc(2026, 10, 21, 0, 0), all_day: true, tzid: None }), ..Default::default() };
        provider(&srv).update(&cal(), "ev1", "\"after\"", &day).unwrap();
        assert_eq!(srv.requests()[1].json()["start"], json!({ "date": "2026-10-20", "dateTime": null, "timeZone": null }));
        // a reminder change and a description change
        let rem = EventPatch { reminder_min: Some(None), description: Some(Some("new".into())), ..Default::default() };
        provider(&srv).update(&cal(), "ev1", "\"after\"", &rem).unwrap();
        let b = srv.requests()[2].json();
        assert_eq!((b["reminders"].clone(), b["description"].clone()), (json!({ "useDefault": false, "overrides": [] }), json!("new")));
    }

    #[test]
    fn delete_sends_if_match_and_a_deleted_event_counts_as_gone() {
        let srv = patch_server();
        provider(&srv).delete(&cal(), "ev1", "\"e\"").unwrap();
        let r = &srv.requests()[0];
        assert_eq!((r.method.as_str(), r.headers["if-match"].as_str(), r.query("sendUpdates").as_deref()), ("DELETE", "\"e\"", Some("all")));
        assert_eq!(provider(&srv).delete(&cal(), "old", "\"e\""), Err(SyncErr::NotFound), "410: deleted already");
    }

    /// W7.1: one occurrence of a series is found by its original start and changed or deleted with the etag of that instance.
    #[test]
    fn google_occurrence_paths() {
        let srv = FakeServer::start(|r| match (r.method.as_str(), r.path()) {
            ("GET", "/calendars/primary/events/ser/instances") => {
                let mut i = ev_json("ser_20261027T080000Z", "Weekly", "2026-10-27T09:00:00+01:00", "2026-10-27T10:00:00+01:00");
                i["recurringEventId"] = json!("ser");
                i["originalStartTime"] = json!({ "dateTime": "2026-10-27T09:00:00+01:00" });
                i["etag"] = json!("\"inst\"");
                Resp::json(200, json!({ "items": [i] }))
            }
            ("GET", "/calendars/primary/events/none/instances") => Resp::json(200, json!({ "items": [] })),
            ("PATCH", "/calendars/primary/events/ser_20261027T080000Z") => {
                let mut v = ev_json("ser_20261027T080000Z", "Moved", "2026-10-27T11:00:00+01:00", "2026-10-27T12:00:00+01:00");
                v["recurringEventId"] = json!("ser");
                v["originalStartTime"] = json!({ "dateTime": "2026-10-27T09:00:00+01:00" });
                v["etag"] = json!("\"after\"");
                Resp::json(200, v)
            }
            ("DELETE", "/calendars/primary/events/ser_20261027T080000Z") => Resp::empty(204),
            (m, p) => panic!("unexpected {m} {p}"),
        });
        let patch = EventPatch { summary: Some("Moved".into()), ..Default::default() };
        let got = provider(&srv).update_occurrence(&cal(), "ser", utc(2026, 10, 27, 8, 0), false, &patch).unwrap();
        assert_eq!((got.series_id.as_deref(), got.recurrence_id, got.kind, got.summary.as_str()), (Some("ser"), Some(utc(2026, 10, 27, 8, 0)), EventKind::Exception, "Moved"));
        let (find, write) = (&srv.requests()[0], &srv.requests()[1]);
        assert_eq!(find.query("originalStart").as_deref(), Some("2026-10-27T08:00:00Z"), "the original start of the slot");
        assert_eq!(find.query("maxResults").as_deref(), Some("1"));
        assert_eq!((write.method.as_str(), write.headers["if-match"].as_str(), write.query("sendUpdates").as_deref()), ("PATCH", "\"inst\"", Some("all")));
        assert_eq!(write.json()["summary"], "Moved");
        assert!(write.json().get("recurrence").is_none(), "an instance has no rule");
        // delete: the same lookup, then DELETE with the etag of the instance; its id comes back for the tombstone
        let id = provider(&srv).delete_occurrence(&cal(), "ser", utc(2026, 10, 27, 8, 0), false).unwrap();
        assert_eq!(id, "ser_20261027T080000Z");
        let d = srv.requests().pop().unwrap();
        assert_eq!((d.method.as_str(), d.headers["if-match"].as_str()), ("DELETE", "\"inst\""));
        // all day: the date; a slot with no instance is gone
        provider(&srv).update_occurrence(&cal(), "none", utc(2026, 10, 27, 0, 0), true, &patch).unwrap_err();
        assert_eq!(srv.requests().pop().unwrap().query("originalStart").as_deref(), Some("2026-10-27"));
        assert_eq!(provider(&srv).delete_occurrence(&cal(), "none", utc(2026, 10, 27, 8, 0), false), Err(SyncErr::NotFound));
    }

    /// W7.1: the recurrence of a write, in the form of the start of the series.
    #[test]
    fn google_recurrence_lines() {
        let timed = Recurrence { rrule: Some("FREQ=WEEKLY;UNTIL=20261109T075959Z".into()), exdates: vec![utc(2026, 10, 20, 8, 0)], rdates: vec![utc(2026, 11, 1, 9, 0)], start: utc(2026, 10, 13, 8, 0), all_day: false, tzid: Some("Europe/Berlin".into()) };
        assert_eq!(
            recurrence_json(&timed),
            json!(["RRULE:FREQ=WEEKLY;UNTIL=20261109T075959Z", "EXDATE;TZID=Europe/Berlin:20261020T100000", "RDATE;TZID=Europe/Berlin:20261101T100000"]),
            "10:00 Berlin is 08:00Z on 20 Oct (summer time) and 09:00Z on 1 Nov would be 10:00 (winter time)"
        );
        let utc_series = Recurrence { tzid: None, rdates: vec![], ..timed.clone() };
        assert_eq!(recurrence_json(&utc_series), json!(["RRULE:FREQ=WEEKLY;UNTIL=20261109T075959Z", "EXDATE:20261020T080000Z"]));
        let day = Recurrence { rrule: Some("RRULE:FREQ=WEEKLY;UNTIL=20261101".into()), exdates: vec![utc(2026, 10, 19, 0, 0)], rdates: vec![], start: utc(2026, 10, 12, 0, 0), all_day: true, tzid: None };
        assert_eq!(recurrence_json(&day), json!(["RRULE:FREQ=WEEKLY;UNTIL=20261101", "EXDATE;VALUE=DATE:20261019"]));
        // nothing left: the event stops repeating
        assert_eq!(recurrence_json(&Recurrence { rrule: None, exdates: vec![utc(2026, 10, 19, 0, 0)], rdates: vec![], ..day.clone() }), json!(["EXDATE;VALUE=DATE:20261019"]));
        assert_eq!(recurrence_json(&Recurrence { rrule: None, exdates: vec![], rdates: vec![], ..day }), Value::Null);
    }

    /// W7.1: a new repeating event names its rule and the zone it is worked out in; a patch of a series carries the whole recurrence.
    #[test]
    fn google_create_and_patch_carry_the_recurrence() {
        let srv = patch_server();
        let team = RemoteCalendar { id: "team@group.calendar.google.com".into(), ..cal() };
        let draft = EventDraft { summary: "Daily".into(), start: utc(2026, 12, 1, 8, 0), end: utc(2026, 12, 1, 9, 0), rrule: Some("RRULE:FREQ=DAILY".into()), ..Default::default() };
        provider(&srv).create(&team, &draft).unwrap();
        let b = srv.requests()[0].json();
        assert_eq!(b["recurrence"], json!(["RRULE:FREQ=DAILY"]));
        assert_eq!(b["start"]["timeZone"], "UTC", "a repeating event always names a zone");
        let patch = EventPatch {
            recurrence: Some(Recurrence { rrule: Some("FREQ=DAILY;COUNT=3".into()), exdates: vec![], rdates: vec![], start: utc(2026, 12, 1, 8, 0), all_day: false, tzid: Some("Europe/Berlin".into()) }),
            ..Default::default()
        };
        provider(&srv).update(&cal(), "ev1", "\"e\"", &patch).unwrap();
        assert_eq!(srv.requests()[1].json()["recurrence"], json!(["RRULE:FREQ=DAILY;COUNT=3"]));
    }

    #[test]
    fn an_rsvp_mirror_changes_only_my_answer_and_tells_nobody() {
        let srv = patch_server();
        let attendees = vec![
            CalAttendee { email: "boss@x.test".into(), name: None, role: "chair".into(), status: "accepted".into(), is_you: false },
            CalAttendee { email: "Me@Gmail.test".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: true },
        ];
        provider(&srv).respond(&cal(), "ev1", "\"e\"", Rsvp::Declined, "me@gmail.test", &attendees).unwrap();
        let r = &srv.requests()[0];
        assert_eq!((r.query("sendUpdates").as_deref(), r.headers["if-match"].as_str()), (Some("none"), "\"e\""));
        let b = r.json();
        assert_eq!(b.as_object().unwrap().len(), 1, "only the attendee list");
        assert_eq!((b["attendees"][0]["responseStatus"].clone(), b["attendees"][1]["responseStatus"].clone()), (json!("accepted"), json!("declined")));
    }

    #[test]
    fn a_412_is_a_conflict_the_server_version_is_pulled_and_nothing_local_changes() {
        let (db, sid) = setup_db();
        let edited = Arc::new(Mutex::new(false));
        let e2 = edited.clone();
        let srv = FakeServer::start(move |r| match (r.method.as_str(), r.path()) {
            (_, "/users/me/calendarList") => Resp::json(200, list_json(vec![primary_item()])),
            ("GET", _) => {
                if *e2.lock().unwrap() {
                    let mut v = ev_json("a", "Edited on the phone", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z");
                    v["etag"] = json!("\"etag-a-new\"");
                    Resp::json(200, events_page(vec![v], None, Some("S2")))
                } else {
                    Resp::json(200, events_page(vec![ev_json("a", "Lunch", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z")], None, Some("S1")))
                }
            }
            ("PATCH", _) => {
                assert_eq!(r.headers["if-match"], "\"etag-a\"", "the etag of the version this computer has");
                *e2.lock().unwrap() = true;
                Resp::json(412, json!({ "error": { "code": 412, "message": "Precondition Failed", "errors": [{ "domain": "global", "reason": "conditionNotMet", "location": "If-Match", "locationType": "header" }] } }))
            }
            (m, p) => panic!("unexpected {m} {p}"),
        });
        let factory = GFactory::new(&srv);
        engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        let (id, cal_id) = {
            let c = lock(&db);
            c.query_row("SELECT id,calendar_id FROM events WHERE remote_id='a'", [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap()
        };
        let input = calendar::CalEventInput {
            id: Some(id.clone()), account_id: None, summary: "Edited here".into(), start: utc(2026, 10, 20, 9, 0), end: utc(2026, 10, 20, 10, 0), all_day: false, tzid: None,
            location: None, description: None, attendees: vec![], rrule: None, reminder_min: None, calendar_id: Some(cal_id),
            scope: None,
            occurrence_start: None,
        };
        let err = write::save(&db, &factory, &input).unwrap_err();
        assert!(err.starts_with("CAL_CONFLICT: This event was changed in Google Calendar, so its latest version is shown."), "{err}");
        assert_eq!(calendar::get_event(&lock(&db), &id).unwrap().summary, "Edited on the phone", "the server's version is what is shown");
    }

    // ---------------------------------------------------------------- errors

    #[test]
    fn errors_are_sorted_into_the_sync_states() {
        let e = |status: u16, body: Value| map_error(status, Some(Duration::from_secs(7)), &body.to_string());
        let reason = |status: u16, reason: &str, domain: &str| e(status, json!({ "error": { "code": status, "message": "msg", "errors": [{ "domain": domain, "reason": reason }] } }));
        // the Calendar API is not enabled in the project (both shapes Google uses)
        assert!(matches!(reason(403, "accessNotConfigured", "usageLimits"), SyncErr::NotSetUp(m) if m == "msg"));
        assert!(matches!(e(403, json!({ "error": { "code": 403, "message": "Google Calendar API has not been used in project 1 before or it is disabled.", "status": "PERMISSION_DENIED", "details": [{ "reason": "SERVICE_DISABLED" }] } })), SyncErr::NotSetUp(m) if m.contains("has not been used")));
        // quota and rate limits: Retry-After honoured
        assert_eq!(reason(403, "rateLimitExceeded", "usageLimits"), SyncErr::RateLimited(Some(Duration::from_secs(7))));
        assert_eq!(reason(403, "userRateLimitExceeded", "usageLimits"), SyncErr::RateLimited(Some(Duration::from_secs(7))));
        assert_eq!(reason(403, "quotaExceeded", "global"), SyncErr::RateLimited(Some(Duration::from_secs(7))));
        assert_eq!(reason(429, "rateLimitExceeded", "usageLimits"), SyncErr::RateLimited(Some(Duration::from_secs(7))));
        assert_eq!(e(503, json!({})), SyncErr::RateLimited(Some(Duration::from_secs(7))));
        // access that ended / scope missing
        assert_eq!(e(401, json!({ "error": { "code": 401, "message": "Invalid Credentials" } })), SyncErr::Auth);
        assert_eq!(reason(403, "insufficientPermissions", "global"), SyncErr::Auth);
        assert_eq!(e(403, json!({ "error": { "code": 403, "status": "PERMISSION_DENIED", "details": [{ "reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } })), SyncErr::Auth);
        // the organization blocks it
        assert!(matches!(reason(403, "admin_policy_enforced", "global"), SyncErr::Blocked(_)));
        // not the person's to change: an error with the reason, not a state
        assert!(matches!(reason(403, "forbiddenForNonOrganizer", "calendar"), SyncErr::Other(m) if m.contains("msg")));
        assert_eq!(e(404, json!({})), SyncErr::NotFound);
        assert_eq!(e(410, json!({ "error": { "errors": [{ "reason": "fullSyncRequired" }] } })), SyncErr::Gone);
        assert_eq!(e(412, json!({ "error": { "errors": [{ "reason": "conditionNotMet" }] } })), SyncErr::Conflict);
        assert!(matches!(e(409, json!({ "error": { "message": "The requested identifier already exists." } })), SyncErr::Other(m) if m.contains("already exists")));
        assert!(matches!(map_error(400, None, "<html>bad</html>"), SyncErr::Other(m) if m.contains("400") && m.contains("bad")));
    }

    fn sync_with_status(status: u16, body: Value, headers: Vec<(&str, &str)>) -> (store::Source, usize) {
        let (db, sid) = setup_db();
        let hs: Vec<(String, String)> = headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let srv = FakeServer::start(move |_| Resp { status, headers: hs.clone(), body: body.to_string() });
        engine::sync_source(&db, &GFactory::new(&srv), &sid, clock(T0), &|| {}).unwrap();
        (store::get_source(&lock(&db), &sid).unwrap(), srv.count())
    }

    #[test]
    fn a_429_with_retry_after_waits_that_long_and_the_other_failures_set_their_states() {
        let (s, n) = sync_with_status(429, json!({ "error": { "code": 429, "errors": [{ "domain": "usageLimits", "reason": "rateLimitExceeded" }] } }), vec![("Retry-After", "120")]);
        assert_eq!((s.status.as_str(), s.retry_at, n), (BUSY, Some(T0 + 120), 1));
        // 403 usageLimits without Retry-After: the back-off (1 min after the first failure)
        let (s, _) = sync_with_status(403, json!({ "error": { "code": 403, "errors": [{ "domain": "usageLimits", "reason": "rateLimitExceeded" }] } }), vec![]);
        assert_eq!((s.status.as_str(), s.retry_at, s.fail_count), (BUSY, Some(T0 + 60), 1));
        // the Calendar API is off in the project: shown as "not set up" with Google's words, no retry
        let (s, _) = sync_with_status(403, json!({ "error": { "code": 403, "message": "Google Calendar API has not been used in project 123 before or it is disabled.", "errors": [{ "reason": "accessNotConfigured" }] } }), vec![]);
        assert_eq!((s.status.as_str(), s.retry_at), (NOT_SET_UP, None));
        assert!(s.last_error.unwrap().contains("has not been used in project 123"));
        // 401 after a fresh token: access ended
        let (s, _) = sync_with_status(401, json!({ "error": { "code": 401 } }), vec![]);
        assert_eq!((s.status.as_str(), s.retry_at), (AUTH, None));
        // a 500: busy
        let (s, _) = sync_with_status(500, json!({}), vec![]);
        assert_eq!(s.status, BUSY);
    }

    #[test]
    fn no_request_is_made_during_a_retry_after_and_the_next_one_is_normal() {
        let (db, sid) = setup_db();
        let limited = Arc::new(Mutex::new(true));
        let l2 = limited.clone();
        let srv = FakeServer::start(move |r| {
            if *l2.lock().unwrap() {
                return Resp::json(429, json!({ "error": { "code": 429 } })).with("Retry-After", "120");
            }
            match r.path() {
                "/users/me/calendarList" => Resp::json(200, list_json(vec![primary_item()])),
                _ => Resp::json(200, events_page(vec![], None, Some("S1"))),
            }
        });
        let factory = GFactory::new(&srv);
        let req: std::collections::HashSet<String> = [ACC.to_string()].into_iter().collect();
        engine::tick(&db, &factory, clock(T0), &req, &|| {});
        let n = srv.count();
        assert_eq!(n, 1);
        *limited.lock().unwrap() = false;
        assert!(engine::tick(&db, &factory, clock(T0 + 119), &req, &|| {}).is_empty());
        assert_eq!(srv.count(), n, "nothing for 120 s, not even on Sync now");
        engine::tick(&db, &factory, clock(T0 + 120), &HashSet::new(), &|| {});
        assert!(srv.count() > n);
        let s = store::get_source(&lock(&db), &sid).unwrap();
        assert_eq!((s.status.as_str(), s.last_error, s.retry_at), (OK, None, None));
    }

    use std::collections::HashSet;

    #[test]
    fn a_revoked_refresh_token_sets_access_ended_and_never_reaches_the_api_or_loops() {
        let (db, sid) = setup_db();
        // the token endpoint answers like Google does when the grant is gone (Testing mode: 7 days; revoked at myaccount.google.com)
        let token_srv = FakeServer::start(|_| Resp::json(400, json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." })));
        let api = FakeServer::start(|_| panic!("the API must not be called without a token"));
        let url = format!("{}/token", token_srv.base);
        let factory = GFactory {
            base: api.base.clone(),
            token: Arc::new(move || crate::oauth::refresh_at(&url, "cid", "sec", "rt", None).map(|r| r.access).map_err(SyncErr::from)),
        };
        let req: HashSet<String> = [ACC.to_string()].into_iter().collect();
        engine::tick(&db, &factory, clock(T0), &req, &|| {});
        let s = store::get_source(&lock(&db), &sid).unwrap();
        assert_eq!((s.status.as_str(), s.retry_at), (AUTH, None));
        for i in 1..6 {
            assert!(engine::tick(&db, &factory, clock(T0 + i * 3600), &req, &|| {}).is_empty(), "no retry loop");
        }
        assert_eq!((token_srv.count(), api.count()), (1, 0));
        // Allow access again (a new consent) starts it over with a working token
        store::create_source(&lock(&db), ACC, Kind::Google, T0 + 9000).unwrap();
        let srv = FakeServer::start(|r| if r.path() == "/users/me/calendarList" { Resp::json(200, list_json(vec![primary_item()])) } else { Resp::json(200, events_page(vec![], None, Some("S1"))) });
        let r = engine::tick(&db, &GFactory::new(&srv), clock(T0 + 10_000), &HashSet::new(), &|| {});
        assert_eq!(r.len(), 1);
        assert_eq!(store::get_source(&lock(&db), &sid).unwrap().status, OK);
    }

    #[test]
    fn no_network_is_offline_and_a_blocked_or_unset_client_are_their_own_states() {
        let (db, sid) = setup_db();
        let dead = crate::testutil::dead_addr();
        let factory = GFactory { base: format!("http://{dead}"), token: Arc::new(|| Ok("t".to_string())) };
        engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        let s = store::get_source(&lock(&db), &sid).unwrap();
        assert_eq!((s.status.as_str(), s.retry_at, s.last_error), ("offline", Some(T0 + 60), None));
        // the token function reports the organization / the registration
        for (fail, want) in [(SyncErr::Blocked("admin_policy_enforced".into()), "blocked"), (SyncErr::NotSetUp("invalid_client".into()), NOT_SET_UP)] {
            let f2 = fail.clone();
            let factory = GFactory { base: factory.base.clone(), token: Arc::new(move || Err(f2.clone())) };
            engine::sync_source(&db, &factory, &sid, clock(T0 + 100), &|| {}).unwrap();
            assert_eq!(store::get_source(&lock(&db), &sid).unwrap().status, want);
        }
    }

    #[test]
    fn a_calendar_over_the_event_limit_is_cut_and_flagged_with_no_token() {
        // 101 pages of 250 events: the 25,000-event limit is reached before the last page
        let srv = FakeServer::start(|r| {
            let page: usize = r.query("pageToken").and_then(|p| p.parse().ok()).unwrap_or(0);
            let items: Vec<Value> = (0..250).map(|i| json!({ "id": format!("e{page}-{i}"), "summary": "x", "start": { "dateTime": "2026-10-20T09:00:00Z" }, "end": { "dateTime": "2026-10-20T10:00:00Z" } })).collect();
            let mut v = json!({ "items": items });
            if page < 100 {
                v["nextPageToken"] = json!((page + 1).to_string());
            } else {
                v["nextSyncToken"] = json!("S");
            }
            Resp::json(200, v)
        });
        let pull = provider(&srv).pull(&cal(), &PullReq { state: None, window_from: T0 - 365 * 86_400, window_to: T0 + 730 * 86_400 }).unwrap();
        assert!(pull.truncated && pull.next_state.is_none() && pull.full);
        assert_eq!(pull.upserts.len(), MAX_EVENTS_PER_CALENDAR);
    }

    #[test]
    fn calendar_ids_with_special_characters_are_encoded_in_the_path() {
        let srv = FakeServer::start(|_| Resp::json(200, events_page(vec![], None, Some("S"))));
        let c = RemoteCalendar { id: "en.vietnamese#holiday@group.v.calendar.google.com".into(), ..cal() };
        provider(&srv).pull(&c, &PullReq { state: Some("a b+c".into()), window_from: 0, window_to: 1 }).unwrap();
        let r = &srv.requests()[0];
        assert_eq!(r.path(), "/calendars/en.vietnamese%23holiday%40group.v.calendar.google.com/events");
        assert_eq!(r.query("syncToken").as_deref(), Some("a b+c"), "the token is encoded and decoded intact");
    }

    #[test]
    fn the_release_build_talks_to_google_only() {
        // `provider()` takes the base from `http::base_url`, which ignores HEYLOOK_GCAL_BASE in a release build
        assert_eq!(API, "https://www.googleapis.com/calendar/v3");
        assert!(http::base_url("HEYLOOK_GCAL_NOT_SET", API).starts_with("https://www.googleapis.com/"));
    }
}
