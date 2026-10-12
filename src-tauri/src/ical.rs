//! A small, forgiving iCalendar (RFC 5545) reader and writer for iMIP invitations, plus basic RRULE expansion.
//!
//! Times are kept as epoch seconds (UTC). All-day events are stored as UTC midnight of their date ("floating" days)
//! and are always shown by date, never converted to another zone.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Person {
    pub email: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Attendee {
    pub email: String,
    pub name: Option<String>,
    /// chair | required | optional
    pub role: String,
    /// accepted | tentative | declined | needs-action | delegated
    pub status: String,
    pub rsvp: bool,
}

#[derive(Debug, Clone, Default)]
pub struct IcsEvent {
    pub uid: String,
    pub sequence: i64,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub url: Option<String>,
    pub conference: Option<String>,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    /// IANA zone the event was written in (None = UTC / floating / unknown)
    pub tzid: Option<String>,
    pub organizer: Option<Person>,
    pub attendees: Vec<Attendee>,
    pub rrule: Option<String>,
    pub exdates: Vec<i64>,
    /// RECURRENCE-ID: this event replaces one occurrence of a series
    pub recurrence_id: Option<i64>,
    /// confirmed | tentative | cancelled
    pub status: String,
    pub comment: Option<String>,
    pub dtstamp: i64,
    /// part of the event was left out because it was over a size cap (very long RRULE, huge attendee or EXDATE list)
    pub trimmed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct IcsCalendar {
    pub method: Option<String>,
    pub events: Vec<IcsEvent>,
}

// ------------------------------------------------------------------ lines

#[derive(Debug)]
struct Line {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Line {
    fn param(&self, n: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str())
    }
}

/// Undo RFC 5545 line folding (a line that starts with a space or tab continues the previous one).
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for raw in text.split('\n') {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        if (l.starts_with(' ') || l.starts_with('\t')) && !out.is_empty() {
            out.last_mut().unwrap().push_str(&l[1..]);
        } else {
            out.push(l.to_string());
        }
    }
    out
}

fn parse_line(l: &str) -> Option<Line> {
    let b = l.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i] != b';' && b[i] != b':' {
        i += 1;
    }
    if i == 0 || i >= b.len() {
        return None;
    }
    let name = l[..i].trim().to_ascii_uppercase();
    let mut params = vec![];
    while i < b.len() && b[i] == b';' {
        i += 1;
        let ns = i;
        while i < b.len() && b[i] != b'=' && b[i] != b';' && b[i] != b':' {
            i += 1;
        }
        let pname = l[ns..i].trim().to_ascii_uppercase();
        let mut val = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            let mut inq = false;
            let vs = i;
            while i < b.len() && (inq || (b[i] != b';' && b[i] != b':')) {
                if b[i] == b'"' {
                    inq = !inq;
                }
                i += 1;
            }
            val = l[vs..i].trim().replace('"', "");
        }
        params.push((pname, val));
    }
    if i >= b.len() || b[i] != b':' {
        return None;
    }
    Some(Line { name, params, value: l[i + 1..].to_string() })
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(o) => out.push(o),
            None => out.push('\\'),
        }
    }
    out
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\r' => {}
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out
}

// ------------------------------------------------------------------ time zones

/// Windows zone names (Exchange / Outlook write these) -> IANA.
const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("UTC", "UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("Greenwich Standard Time", "Atlantic/Reykjavik"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("Romance Standard Time", "Europe/Paris"),
    ("E. Europe Standard Time", "Europe/Chisinau"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("GTB Standard Time", "Europe/Bucharest"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("Turkey Standard Time", "Europe/Istanbul"),
    ("Israel Standard Time", "Asia/Jerusalem"),
    ("Arab Standard Time", "Asia/Riyadh"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Pakistan Standard Time", "Asia/Karachi"),
    ("Bangladesh Standard Time", "Asia/Dhaka"),
    ("SE Asia Standard Time", "Asia/Bangkok"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Taipei Standard Time", "Asia/Taipei"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("E. Australia Standard Time", "Australia/Brisbane"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("Hawaiian Standard Time", "Pacific/Honolulu"),
    ("Alaskan Standard Time", "America/Anchorage"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("US Mountain Standard Time", "America/Phoenix"),
    ("Mountain Standard Time", "America/Denver"),
    ("Central Standard Time", "America/Chicago"),
    ("Canada Central Standard Time", "America/Regina"),
    ("Eastern Standard Time", "America/New_York"),
    ("Atlantic Standard Time", "America/Halifax"),
    ("Mexico Standard Time", "America/Mexico_City"),
    ("SA Pacific Standard Time", "America/Bogota"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("Argentina Standard Time", "America/Argentina/Buenos_Aires"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("Egypt Standard Time", "Africa/Cairo"),
    ("W. Central Africa Standard Time", "Africa/Lagos"),
];

/// IANA name for a TZID as written in a message (IANA, Windows, or an Olson path such as `/mozilla.org/…/Europe/Berlin`).
pub fn iana_for(tzid: &str) -> Option<Tz> {
    let t = tzid.trim().trim_matches('"');
    if t.is_empty() {
        return None;
    }
    if let Ok(z) = t.parse::<Tz>() {
        return Some(z);
    }
    if let Some((_, iana)) = WINDOWS_ZONES.iter().find(|(w, _)| w.eq_ignore_ascii_case(t)) {
        return iana.parse().ok();
    }
    let parts: Vec<&str> = t.split('/').filter(|p| !p.is_empty()).collect();
    for n in [3usize, 2, 1] {
        if parts.len() >= n {
            let cand = parts[parts.len() - n..].join("/");
            if let Ok(z) = cand.parse::<Tz>() {
                return Some(z);
            }
        }
    }
    None
}

/// A zone defined by a VTIMEZONE block (used only when the TZID is not a known name).
#[derive(Debug, Clone, Default)]
struct VZone {
    iana: Option<Tz>,
    std: Option<i32>,
    dst: Option<i32>,
    std_month: Option<u32>,
    dst_month: Option<u32>,
}

#[derive(Debug, Clone)]
enum Zone {
    Utc,
    Iana(Tz),
    Fixed(VZone),
}

fn offset_secs(v: &str) -> Option<i32> {
    let v = v.trim();
    let (sign, rest) = match v.as_bytes().first()? {
        b'-' => (-1, v.get(1..)?),
        b'+' => (1, v.get(1..)?),
        _ => (1, v),
    };
    // HHMM or HHMMSS, ASCII digits only (never slice by bytes: the text can hold multi-byte characters)
    if !(rest.len() == 4 || rest.len() == 6) || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let h: i32 = rest.get(0..2)?.parse().ok()?;
    let m: i32 = rest.get(2..4)?.parse().ok()?;
    let s: i32 = rest.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
    if h > 23 || m > 59 || s > 59 {
        return None;
    }
    Some(sign * (h * 3600 + m * 60 + s))
}

/// Local wall time in an IANA zone -> UTC epoch seconds; a time inside a DST gap moves forward an hour.
fn local_in(tz: Tz, n: NaiveDateTime) -> i64 {
    match tz.from_local_datetime(&n) {
        chrono::LocalResult::Single(d) => d.timestamp(),
        chrono::LocalResult::Ambiguous(a, _) => a.timestamp(),
        chrono::LocalResult::None => match n.checked_add_signed(Duration::hours(1)).map(|m| tz.from_local_datetime(&m)) {
            Some(chrono::LocalResult::Single(d)) => d.timestamp(),
            Some(chrono::LocalResult::Ambiguous(a, _)) => a.timestamp(),
            _ => n.and_utc().timestamp(),
        },
    }
}

fn zone_to_utc(z: &Zone, n: NaiveDateTime) -> i64 {
    match z {
        Zone::Utc => n.and_utc().timestamp(),
        Zone::Iana(tz) => local_in(*tz, n),
        Zone::Fixed(v) => {
            if let Some(tz) = v.iana {
                return local_in(tz, n);
            }
            let off = match (v.std, v.dst, v.std_month, v.dst_month) {
                (Some(s), Some(d), Some(sm), Some(dm)) => {
                    let m = n.month();
                    let in_dst = if dm < sm { m >= dm && m < sm } else { m >= dm || m < sm };
                    if in_dst { d } else { s }
                }
                (Some(s), _, _, _) => s,
                (None, Some(d), _, _) => d,
                _ => 0,
            };
            n.and_utc().timestamp() - off as i64
        }
    }
}

/// UTC midnight of a date (how all-day events are stored).
pub fn day_utc(d: NaiveDate) -> i64 {
    d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp()
}

fn parse_naive(v: &str) -> Option<NaiveDateTime> {
    let v = v.trim().trim_end_matches(['Z', 'z']);
    if v.len() < 8 {
        return None;
    }
    // digits only: a sign or other character would parse as a number and give odd years
    let digits = |r: std::ops::Range<usize>| -> Option<&str> { v.get(r).filter(|x| x.bytes().all(|b| b.is_ascii_digit())) };
    let d = NaiveDate::from_ymd_opt(digits(0..4)?.parse().ok()?, digits(4..6)?.parse().ok()?, digits(6..8)?.parse().ok()?)?;
    if v.len() >= 15 && v.as_bytes()[8] == b'T' {
        let t = NaiveTime::from_hms_opt(digits(9..11)?.parse().ok()?, digits(11..13)?.parse().ok()?, digits(13..15)?.parse().ok()?)?;
        Some(d.and_time(t))
    } else {
        Some(d.and_hms_opt(0, 0, 0)?)
    }
}

struct Ctx<'a> {
    vzones: &'a HashMap<String, VZone>,
}

struct Dt {
    ts: i64,
    all_day: bool,
    tz: Option<String>,
}

fn resolve_zone(tzid: &str, ctx: &Ctx) -> (Zone, Option<String>) {
    if let Some(z) = iana_for(tzid) {
        return (Zone::Iana(z), Some(z.name().to_string()));
    }
    if let Some(v) = ctx.vzones.get(tzid) {
        if let Some(tz) = v.iana {
            return (Zone::Iana(tz), Some(tz.name().to_string()));
        }
        return (Zone::Fixed(v.clone()), None);
    }
    (Zone::Utc, None)
}

fn parse_dt_value(value: &str, line: Option<&Line>, ctx: &Ctx) -> Option<Dt> {
    let v = value.trim();
    let is_date = line.and_then(|l| l.param("VALUE")).map(|x| x.eq_ignore_ascii_case("DATE")).unwrap_or(false) || v.len() == 8;
    let n = parse_naive(v)?;
    if is_date {
        return Some(Dt { ts: day_utc(n.date()), all_day: true, tz: None });
    }
    if v.ends_with('Z') || v.ends_with('z') {
        return Some(Dt { ts: n.and_utc().timestamp(), all_day: false, tz: None });
    }
    match line.and_then(|l| l.param("TZID")) {
        Some(tzid) => {
            let (z, name) = resolve_zone(tzid, ctx);
            Some(Dt { ts: zone_to_utc(&z, n), all_day: false, tz: name })
        }
        None => {
            // floating time: read it in this computer's zone
            let ts = match chrono::Local.from_local_datetime(&n) {
                chrono::LocalResult::Single(d) => d.timestamp(),
                chrono::LocalResult::Ambiguous(a, _) => a.timestamp(),
                chrono::LocalResult::None => n.and_utc().timestamp(),
            };
            Some(Dt { ts, all_day: false, tz: None })
        }
    }
}

fn parse_duration(v: &str) -> Option<i64> {
    let v = v.trim();
    let (neg, v) = match v.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, v.strip_prefix('+').unwrap_or(v)),
    };
    let v = v.strip_prefix('P')?;
    let mut total = 0i64;
    let mut num = String::new();
    let mut seen = false;
    for c in v.chars() {
        match c {
            '0'..='9' => num.push(c),
            'T' => {}
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                seen = true;
                let unit: i64 = match c {
                    'W' => 604800,
                    'D' => 86400,
                    'H' => 3600,
                    'M' => 60,
                    _ => 1,
                };
                total = total.checked_add(n.checked_mul(unit)?)?;
            }
            _ => return None,
        }
    }
    if !seen || !num.is_empty() {
        return None;
    }
    Some(if neg { -total } else { total })
}

fn mailto(v: &str) -> Option<String> {
    let t = v.trim();
    let t = match t.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("mailto:") => t.get(7..).unwrap_or(""),
        _ => t,
    };
    let t = t.split('?').next().unwrap_or(t).trim();
    (t.contains('@') && !t.contains(' ')).then(|| t.to_ascii_lowercase())
}

fn person(l: &Line) -> Option<Person> {
    let email = mailto(&l.value).or_else(|| l.param("EMAIL").and_then(mailto))?;
    let name = l.param("CN").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Some(Person { email, name })
}

fn attendee(l: &Line) -> Option<Attendee> {
    if matches!(l.param("CUTYPE").map(|s| s.to_ascii_uppercase()).as_deref(), Some("RESOURCE") | Some("ROOM")) {
        return None;
    }
    let p = person(l)?;
    let role = match l.param("ROLE").map(|s| s.to_ascii_uppercase()).as_deref() {
        Some("CHAIR") => "chair",
        Some("OPT-PARTICIPANT") | Some("NON-PARTICIPANT") => "optional",
        _ => "required",
    };
    let status = match l.param("PARTSTAT").map(|s| s.to_ascii_uppercase()).as_deref() {
        Some("ACCEPTED") => "accepted",
        Some("TENTATIVE") => "tentative",
        Some("DECLINED") => "declined",
        Some("DELEGATED") => "delegated",
        _ => "needs-action",
    };
    Some(Attendee {
        email: p.email,
        name: p.name,
        role: role.into(),
        status: status.into(),
        rsvp: l.param("RSVP").map(|s| s.eq_ignore_ascii_case("TRUE")).unwrap_or(false),
    })
}

// ------------------------------------------------------------------ parsing

/// Parse iCalendar text. Fails only when there is nothing usable; unknown properties are ignored and
/// events without a start time are skipped.
pub fn parse(text: &str) -> Result<IcsCalendar, String> {
    let text = text.trim_start_matches('\u{feff}');
    let lines = unfold(text);
    if !lines.iter().any(|l| l.trim().eq_ignore_ascii_case("BEGIN:VCALENDAR")) {
        return Err("not a calendar (no BEGIN:VCALENDAR)".into());
    }
    // pass 1: VTIMEZONE definitions
    let mut vzones: HashMap<String, VZone> = HashMap::new();
    {
        let mut cur: Option<(String, VZone)> = None;
        let mut sub: Option<String> = None; // STANDARD | DAYLIGHT
        for l in &lines {
            let Some(p) = parse_line(l) else { continue };
            match (p.name.as_str(), p.value.to_ascii_uppercase().as_str()) {
                ("BEGIN", "VTIMEZONE") => cur = Some((String::new(), VZone::default())),
                ("END", "VTIMEZONE") => {
                    if let Some((id, z)) = cur.take() {
                        if !id.is_empty() {
                            vzones.insert(id, z);
                        }
                    }
                }
                ("BEGIN", s @ ("STANDARD" | "DAYLIGHT")) if cur.is_some() => sub = Some(s.to_string()),
                ("END", "STANDARD" | "DAYLIGHT") => sub = None,
                _ => {
                    if let Some((id, z)) = cur.as_mut() {
                        match (p.name.as_str(), sub.as_deref()) {
                            ("TZID", None) => *id = p.value.trim().to_string(),
                            ("X-LIC-LOCATION", None) => z.iana = iana_for(&p.value),
                            ("TZOFFSETTO", Some("STANDARD")) => z.std = offset_secs(&p.value),
                            ("TZOFFSETTO", Some("DAYLIGHT")) => z.dst = offset_secs(&p.value),
                            ("RRULE", Some(which)) => {
                                let month = p.value.split(';').find_map(|kv| kv.strip_prefix("BYMONTH=")).and_then(|m| m.parse::<u32>().ok());
                                if which == "STANDARD" {
                                    z.std_month = month;
                                } else {
                                    z.dst_month = month;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    let ctx = Ctx { vzones: &vzones };

    // pass 2: calendar properties and events
    let mut cal = IcsCalendar::default();
    let mut depth_event: Option<Vec<Line>> = None;
    let mut skip_depth = 0usize; // nested VALARM / VTIMEZONE etc. inside the walk
    let mut in_tz = false;
    for l in &lines {
        let Some(p) = parse_line(l) else { continue };
        if p.name == "BEGIN" {
            let v = p.value.trim().to_ascii_uppercase();
            if v == "VEVENT" {
                depth_event = Some(vec![]);
                skip_depth = 0;
            } else if v == "VTIMEZONE" {
                in_tz = true;
            } else if depth_event.is_some() {
                skip_depth += 1;
            }
            continue;
        }
        if p.name == "END" {
            let v = p.value.trim().to_ascii_uppercase();
            if v == "VEVENT" {
                if let Some(props) = depth_event.take() {
                    if let Some(ev) = build_event(&props, &ctx) {
                        cal.events.push(ev);
                    }
                }
            } else if v == "VTIMEZONE" {
                in_tz = false;
            } else if depth_event.is_some() && skip_depth > 0 {
                skip_depth -= 1;
            }
            continue;
        }
        if in_tz {
            continue;
        }
        match depth_event.as_mut() {
            Some(props) if skip_depth == 0 => props.push(p),
            Some(_) => {}
            None => {
                if p.name == "METHOD" {
                    cal.method = Some(p.value.trim().to_ascii_uppercase());
                }
            }
        }
    }
    // a message cut off inside the event: keep what was read
    if let Some(props) = depth_event.take() {
        if let Some(ev) = build_event(&props, &ctx) {
            cal.events.push(ev);
        }
    }
    if cal.events.is_empty() {
        return Err("the calendar data has no readable event".into());
    }
    Ok(cal)
}

/// Longest DURATION accepted (100 years); anything larger is treated as missing.
const MAX_DURATION_SECS: i64 = 100 * 366 * 86400;

fn build_event(props: &[Line], ctx: &Ctx) -> Option<IcsEvent> {
    let mut ev = IcsEvent { status: "confirmed".into(), ..Default::default() };
    let mut dtstart: Option<Dt> = None;
    let mut dtend: Option<Dt> = None;
    let mut duration: Option<i64> = None;
    for p in props {
        match p.name.as_str() {
            "UID" => ev.uid = p.value.trim().to_string(),
            "SEQUENCE" => ev.sequence = p.value.trim().parse().unwrap_or(0),
            "SUMMARY" => ev.summary = unescape(&p.value).trim().to_string(),
            "DESCRIPTION" => ev.description = Some(unescape(&p.value)).filter(|s| !s.trim().is_empty()),
            "LOCATION" => ev.location = Some(unescape(&p.value).trim().to_string()).filter(|s| !s.is_empty()),
            "URL" => ev.url = Some(p.value.trim().to_string()).filter(|s| !s.is_empty()),
            "X-GOOGLE-CONFERENCE" | "X-MICROSOFT-SKYPETEAMSMEETINGURL" | "X-MICROSOFT-ONLINEMEETINGEXTERNALLINK" | "CONFERENCE" => {
                if ev.conference.is_none() {
                    ev.conference = Some(p.value.trim().to_string()).filter(|s| s.starts_with("http"));
                }
            }
            "COMMENT" => ev.comment = Some(unescape(&p.value)).filter(|s| !s.trim().is_empty()),
            "STATUS" => {
                ev.status = match p.value.trim().to_ascii_uppercase().as_str() {
                    "CANCELLED" => "cancelled",
                    "TENTATIVE" => "tentative",
                    _ => "confirmed",
                }
                .into()
            }
            "ORGANIZER" => ev.organizer = person(p),
            "ATTENDEE" => {
                if let Some(a) = attendee(p) {
                    if ev.attendees.len() >= MAX_ATTENDEES {
                        ev.trimmed = true;
                    } else if !ev.attendees.iter().any(|x| x.email == a.email) {
                        ev.attendees.push(a);
                    }
                }
            }
            "RRULE" => {
                let r = p.value.trim();
                if r.len() > MAX_RRULE_LEN {
                    ev.trimmed = true; // dropped: the event shows once instead of repeating
                } else if !r.is_empty() {
                    ev.rrule = Some(r.to_string());
                }
            }
            "DTSTART" => dtstart = parse_dt_value(&p.value, Some(p), ctx),
            "DTEND" | "DUE" => dtend = parse_dt_value(&p.value, Some(p), ctx),
            "DURATION" => duration = parse_duration(&p.value),
            "DTSTAMP" => ev.dtstamp = parse_dt_value(&p.value, Some(p), ctx).map(|d| d.ts).unwrap_or(0),
            "RECURRENCE-ID" => ev.recurrence_id = parse_dt_value(&p.value, Some(p), ctx).map(|d| d.ts),
            "EXDATE" => {
                for part in p.value.split(',') {
                    if ev.exdates.len() >= MAX_EXDATES {
                        ev.trimmed = true;
                        break;
                    }
                    if let Some(d) = parse_dt_value(part, Some(p), ctx) {
                        if !ev.exdates.contains(&d.ts) {
                            ev.exdates.push(d.ts);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let s = dtstart?;
    ev.start = s.ts;
    ev.all_day = s.all_day;
    ev.tzid = s.tz.clone();
    ev.end = match (dtend, duration) {
        (Some(e), _) if e.ts >= s.ts => e.ts,
        (_, Some(d)) if (0..=MAX_DURATION_SECS).contains(&d) => s.ts + d,
        _ => {
            if s.all_day {
                s.ts + 86400
            } else {
                s.ts
            }
        }
    };
    if ev.uid.is_empty() {
        ev.uid = format!("noid-{}-{}", ev.start, ev.summary.len());
    }
    if let Some(o) = &ev.organizer {
        // the organizer is also a participant when the sender listed them
        if let Some(a) = ev.attendees.iter_mut().find(|a| a.email == o.email) {
            if a.name.is_none() {
                a.name = o.name.clone();
            }
        }
    }
    Some(ev)
}

// ------------------------------------------------------------------ join links and text

const MEETING_HOSTS: &[&str] = &["teams.microsoft.com", "teams.live.com", "meet.google.com", "zoom.us", "webex.com", "gotomeeting.com", "whereby.com", "meet.jit.si", "chime.aws"];

fn urls_in(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = s;
    while let Some(i) = rest.find("http") {
        let tail = &rest[i..];
        if !(tail.starts_with("http://") || tail.starts_with("https://")) {
            rest = &rest[i + 4..];
            continue;
        }
        let end = tail.find(|c: char| c.is_whitespace() || matches!(c, '>' | '<' | '"' | ')' | ']')).unwrap_or(tail.len());
        out.push(tail[..end].trim_end_matches(['.', ',', ';']).to_string());
        rest = &tail[end..];
    }
    out
}

/// The video-meeting link of an event, if it has one.
pub fn join_url(ev: &IcsEvent) -> Option<String> {
    let mut cands: Vec<String> = vec![];
    cands.extend(ev.conference.clone());
    cands.extend(ev.url.clone());
    for s in [ev.location.as_deref(), ev.description.as_deref()].into_iter().flatten() {
        cands.extend(urls_in(s));
    }
    cands
        .iter()
        .find(|u| MEETING_HOSTS.iter().any(|h| u.to_ascii_lowercase().contains(h)))
        .cloned()
        .or_else(|| ev.conference.clone())
}

// ------------------------------------------------------------------ RRULE

#[derive(Debug, Clone, PartialEq)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
struct Rule {
    freq: Freq,
    interval: u32,
    count: Option<u32>,
    until: Option<i64>,
    by_day: Vec<(i32, Weekday)>,
    by_month_day: Vec<i32>,
    by_month: Vec<u32>,
    wkst: Weekday,
}

fn wd(s: &str) -> Option<Weekday> {
    Some(match s.to_ascii_uppercase().as_str() {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

/// Longest list accepted for BYDAY / BYMONTHDAY / BYMONTH after removing duplicates (a month has at most 62 distinct
/// BYMONTHDAY values, so real rules are far below this). Stops a hostile 100,000-entry list from multiplying the work.
const MAX_RULE_LIST: usize = 64;
/// Longest RRULE text kept from an invite; a longer one is dropped (the event is then shown once, not repeated).
pub const MAX_RRULE_LEN: usize = 1000;
/// Most EXDATE values kept per event.
pub const MAX_EXDATES: usize = 1000;
/// Most ATTENDEE lines kept per event.
pub const MAX_ATTENDEES: usize = 500;
/// Most occurrences one `expand` call returns.
const MAX_OCCURRENCES: usize = 3000;
/// Iteration budget of one `expand` call (days / weeks / months walked from DTSTART). `list_range` shares a budget
/// between all events of one call (see `expand_budgeted`).
pub const MAX_EXPAND_STEPS: usize = 60_000;

fn capped_set<T: PartialEq>(it: impl Iterator<Item = T>) -> Vec<T> {
    let mut out: Vec<T> = vec![];
    for x in it {
        if out.len() >= MAX_RULE_LIST {
            break;
        }
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

fn parse_rule(s: &str) -> Option<Rule> {
    if s.len() > MAX_RRULE_LEN {
        return None; // rules stored before the cap, or typed by hand: do not walk a huge string on every list
    }
    let mut r = Rule { freq: Freq::Daily, interval: 1, count: None, until: None, by_day: vec![], by_month_day: vec![], by_month: vec![], wkst: Weekday::Mon };
    let mut freq = None;
    for kv in s.trim().trim_start_matches("RRULE:").split(';') {
        let Some((k, v)) = kv.split_once('=') else { continue };
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.to_ascii_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                })
            }
            "INTERVAL" => r.interval = v.parse::<u32>().ok().filter(|n| *n >= 1)?,
            "COUNT" => r.count = v.parse().ok(),
            "UNTIL" => {
                let n = parse_naive(v)?;
                let is_date = v.trim().len() == 8;
                r.until = Some(if is_date { n.and_utc().timestamp() + 86399 } else { n.and_utc().timestamp() });
            }
            "BYDAY" => {
                for d in v.split(',') {
                    let d = d.trim();
                    // the weekday is the last two characters (never split by byte index: the text may be multi-byte)
                    let Some((cut, _)) = d.char_indices().rev().nth(1) else { continue };
                    let (num, name) = d.split_at(cut);
                    let ord: i32 = if num.is_empty() { 0 } else { num.trim_start_matches('+').parse().ok().filter(|n: &i32| n.unsigned_abs() <= 53)? };
                    let item = (ord, wd(name)?);
                    if !r.by_day.contains(&item) && r.by_day.len() < MAX_RULE_LIST {
                        r.by_day.push(item);
                    }
                }
            }
            "BYMONTHDAY" => r.by_month_day = capped_set(v.split(',').filter_map(|x| x.trim().parse::<i32>().ok()).filter(|d| (-31..=31).contains(d))),
            "BYMONTH" => r.by_month = capped_set(v.split(',').filter_map(|x| x.trim().parse::<u32>().ok()).filter(|m| (1..=12).contains(m))),
            "WKST" => r.wkst = wd(v)?,
            _ => {}
        }
    }
    r.freq = freq?;
    Some(r)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y.saturating_add(1), 1) } else { (y, m + 1) };
    match (NaiveDate::from_ymd_opt(ny, nm, 1), NaiveDate::from_ymd_opt(y, m, 1)) {
        (Some(next), Some(first)) => (next - first).num_days() as u32,
        _ => 0,
    }
}

fn add_months(y: i32, m: u32, add: u32) -> (i32, u32) {
    let idx = y as i64 * 12 + (m as i64 - 1) + add as i64;
    ((idx / 12) as i32, (idx % 12) as u32 + 1)
}

/// The dates of one month selected by BYMONTHDAY / BYDAY (ordinals count within the month).
fn month_days(y: i32, m: u32, r: &Rule, base_day: u32) -> Vec<NaiveDate> {
    let dim = days_in_month(y, m);
    let mut out: Vec<u32> = vec![];
    if !r.by_month_day.is_empty() {
        for d in &r.by_month_day {
            let day = if *d > 0 { *d } else { dim as i32 + 1 + *d };
            if day >= 1 && day <= dim as i32 {
                out.push(day as u32);
            }
        }
    } else if !r.by_day.is_empty() {
        // the days of the month per weekday, built once (not once per BYDAY entry)
        let mut per_wd: [Vec<u32>; 7] = Default::default();
        for d in 1..=dim {
            if let Some(x) = NaiveDate::from_ymd_opt(y, m, d) {
                per_wd[x.weekday().num_days_from_monday() as usize].push(d);
            }
        }
        for (ord, w) in &r.by_day {
            let matching: &Vec<u32> = &per_wd[w.num_days_from_monday() as usize];
            match *ord {
                0 => out.extend(matching.iter().copied()),
                n if n > 0 => out.extend(matching.get(n as usize - 1).copied()),
                n => {
                    let i = (matching.len() as i32).saturating_add(n);
                    if i >= 0 {
                        out.extend(matching.get(i as usize).copied());
                    }
                }
            }
        }
    } else if base_day <= dim {
        out.push(base_day);
    }
    out.sort_unstable();
    out.dedup();
    out.into_iter().filter_map(|d| NaiveDate::from_ymd_opt(y, m, d)).collect()
}

/// All occurrences (start, end) of a recurring event that touch `[win_from, win_to)`, with EXDATEs removed.
/// The first instance is always DTSTART itself. Unknown rules fall back to the single base occurrence.
#[cfg(test)]
pub fn expand(start: i64, end: i64, all_day: bool, tzid: Option<&str>, rrule: &str, exdates: &[i64], win_from: i64, win_to: i64) -> Vec<(i64, i64)> {
    expand_budgeted(start, end, all_day, tzid, rrule, exdates, win_from, win_to, &mut MAX_EXPAND_STEPS.clone())
}

/// `expand` with an iteration budget the caller shares between several events: each call spends what it walked, and stops
/// (returning the occurrences found so far) when the budget is used up. One call never walks more than `MAX_EXPAND_STEPS`.
#[allow(clippy::too_many_arguments)]
pub fn expand_budgeted(start: i64, end: i64, all_day: bool, tzid: Option<&str>, rrule: &str, exdates: &[i64], win_from: i64, win_to: i64, budget: &mut usize) -> Vec<(i64, i64)> {
    let ex: std::collections::HashSet<i64> = exdates.iter().copied().take(MAX_EXDATES * 2).collect();
    let limit = (*budget).min(MAX_EXPAND_STEPS);
    let mut used = 0usize;
    let out = expand_inner(start, end, all_day, tzid, rrule, &ex, win_from, win_to, limit, &mut used);
    *budget = budget.saturating_sub(used);
    out
}

#[allow(clippy::too_many_arguments)]
fn expand_inner(
    start: i64,
    end: i64,
    all_day: bool,
    tzid: Option<&str>,
    rrule: &str,
    exdates: &std::collections::HashSet<i64>,
    win_from: i64,
    win_to: i64,
    limit: usize,
    used: &mut usize,
) -> Vec<(i64, i64)> {
    let dur = end.saturating_sub(start).max(0);
    let touches = |s: i64| s < win_to && s.saturating_add(dur).max(s.saturating_add(1)) > win_from;
    let Some(rule) = parse_rule(rrule) else {
        return if touches(start) && !exdates.contains(&start) { vec![(start, end)] } else { vec![] };
    };
    let tz: Option<Tz> = tzid.and_then(iana_for);
    let base: NaiveDateTime = match (all_day, tz) {
        (true, _) | (_, None) => chrono::DateTime::from_timestamp(start, 0).unwrap_or_default().naive_utc(),
        (false, Some(z)) => z.from_utc_datetime(&chrono::DateTime::from_timestamp(start, 0).unwrap_or_default().naive_utc()).naive_local(),
    };
    let tod = base.time();
    let bdate = base.date();
    let to_utc = |d: NaiveDate| -> i64 {
        let n = d.and_time(tod);
        match (all_day, tz) {
            (true, _) => day_utc(d),
            (false, Some(z)) => local_in(z, n),
            (false, None) => n.and_utc().timestamp(),
        }
    };
    let mut out = vec![];
    let mut emitted = 0u32;
    let mut guard = 0usize;
    // returns false to stop
    let take = |d: NaiveDate, out: &mut Vec<(i64, i64)>, emitted: &mut u32| -> bool {
        if d < bdate {
            return true;
        }
        if !rule.by_month.is_empty() && !rule.by_month.contains(&d.month()) {
            return true;
        }
        let s = to_utc(d);
        if rule.until.map(|u| s > u).unwrap_or(false) || s >= win_to {
            return false;
        }
        if let Some(c) = rule.count {
            if *emitted >= c {
                return false;
            }
        }
        *emitted += 1;
        if touches(s) && !exdates.contains(&s) {
            out.push((s, s.saturating_add(dur)));
            if out.len() >= MAX_OCCURRENCES {
                return false;
            }
        }
        true
    };
    match rule.freq {
        Freq::Daily => {
            let mut d = bdate;
            loop {
                guard += 1;
                if guard > limit || !take(d, &mut out, &mut emitted) {
                    break;
                }
                match Duration::try_days(rule.interval as i64).and_then(|step| d.checked_add_signed(step)) {
                    Some(next) => d = next,
                    None => break,
                }
            }
        }
        Freq::Weekly => {
            let back = (bdate.weekday().num_days_from_monday() + 7 - rule.wkst.num_days_from_monday()) % 7;
            let Some(mut week) = bdate.checked_sub_signed(Duration::days(back as i64)) else { return out };
            let days: Vec<Weekday> = if rule.by_day.is_empty() { vec![bdate.weekday()] } else { rule.by_day.iter().map(|x| x.1).collect() };
            let mut offs: Vec<i64> = days.iter().map(|w| ((w.num_days_from_monday() + 7 - rule.wkst.num_days_from_monday()) % 7) as i64).collect();
            offs.sort_unstable();
            offs.dedup();
            'w: loop {
                for o in &offs {
                    guard += 1;
                    let Some(day) = week.checked_add_signed(Duration::days(*o)) else { break 'w };
                    if guard > limit || !take(day, &mut out, &mut emitted) {
                        break 'w;
                    }
                }
                match Duration::try_weeks(rule.interval as i64).and_then(|step| week.checked_add_signed(step)) {
                    Some(next) => week = next,
                    None => break,
                }
            }
        }
        Freq::Monthly => {
            let mut k = 0u32;
            'm: loop {
                let Some(add) = k.checked_mul(rule.interval) else { break };
                let (y, m) = add_months(bdate.year(), bdate.month(), add);
                if y > 9000.max(bdate.year()) {
                    break;
                }
                for d in month_days(y, m, &rule, bdate.day()) {
                    guard += 1;
                    if guard > limit || !take(d, &mut out, &mut emitted) {
                        break 'm;
                    }
                }
                guard += 1;
                if guard > limit {
                    break;
                }
                // a month that yields nothing past the window end must still end the loop
                if NaiveDate::from_ymd_opt(y, m, 1).map(|f| to_utc(f) >= win_to).unwrap_or(true) {
                    break;
                }
                k += 1;
            }
        }
        Freq::Yearly => {
            let mut k = 0u32;
            'y: loop {
                let y = bdate.year() as i64 + k as i64 * rule.interval as i64;
                if y > 9000i64.max(bdate.year() as i64) {
                    break;
                }
                let y = y as i32;
                let months: Vec<u32> = if rule.by_month.is_empty() { vec![bdate.month()] } else { rule.by_month.clone() };
                for m in months {
                    for d in month_days(y, m, &rule, bdate.day()) {
                        guard += 1;
                        if guard > limit || !take(d, &mut out, &mut emitted) {
                            break 'y;
                        }
                    }
                }
                guard += 1;
                if guard > limit {
                    break;
                }
                if NaiveDate::from_ymd_opt(y, 1, 1).map(|f| to_utc(f) >= win_to).unwrap_or(true) {
                    break;
                }
                k += 1;
            }
        }
    }
    *used = guard;
    out
}

const DAY_NAMES: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/// "Every Wednesday", "Every 2 weeks", "Every day, 5 times" …
pub fn describe_rrule(rrule: &str, start: i64) -> Option<String> {
    let r = parse_rule(rrule)?;
    let n = r.interval;
    let base = match r.freq {
        Freq::Daily => if n == 1 { "Every day".to_string() } else { format!("Every {n} days") },
        Freq::Weekly => {
            let days: Vec<String> = r.by_day.iter().map(|(_, w)| DAY_NAMES[w.num_days_from_monday() as usize].to_string()).collect();
            let days = if days.is_empty() {
                let d = chrono::DateTime::from_timestamp(start, 0).unwrap_or_default().weekday();
                vec![DAY_NAMES[d.num_days_from_monday() as usize].to_string()]
            } else {
                days
            };
            let list = match days.len() {
                1 => days[0].clone(),
                _ => format!("{} and {}", days[..days.len() - 1].join(", "), days[days.len() - 1]),
            };
            if n == 1 { format!("Every {list}") } else { format!("Every {n} weeks on {list}") }
        }
        Freq::Monthly => if n == 1 { "Every month".to_string() } else { format!("Every {n} months") },
        Freq::Yearly => if n == 1 { "Every year".to_string() } else { format!("Every {n} years") },
    };
    let tail = match (r.count, r.until) {
        (Some(c), _) => format!(", {c} time{}", if c == 1 { "" } else { "s" }),
        (None, Some(u)) => format!(", until {}", chrono::DateTime::from_timestamp(u, 0).unwrap_or_default().format("%-d %b %Y")),
        _ => String::new(),
    };
    Some(format!("{base}{tail}"))
}

// ------------------------------------------------------------------ writing

fn fold(line: &str, out: &mut String) {
    let mut cur = 0usize;
    let mut first = true;
    for c in line.chars() {
        let w = c.len_utf8();
        let limit = if first { 75 } else { 74 };
        if cur + w > limit {
            out.push_str("\r\n ");
            cur = 0;
            first = false;
        }
        out.push(c);
        cur += w;
    }
    out.push_str("\r\n");
}

fn fmt_utc(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

fn fmt_dt(prop: &str, ts: i64, all_day: bool, tz: Option<Tz>) -> String {
    if all_day {
        return format!("{prop};VALUE=DATE:{}", chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default().format("%Y%m%d"));
    }
    match tz {
        Some(z) => {
            let l = z.from_utc_datetime(&chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default().naive_utc());
            format!("{prop};TZID={}:{}", z.name(), l.format("%Y%m%dT%H%M%S"))
        }
        None => format!("{prop}:{}", fmt_utc(ts)),
    }
}

/// The `CN=` parameter (RFC 5545 3.2.2). The value is always written as a quoted-string, which is what allows `,` `;` `:`
/// and parentheses; a DQUOTE cannot appear inside one, so it becomes an apostrophe, and control characters (a line break
/// would start a new property) are dropped.
fn cn(name: &Option<String>) -> String {
    let n: String = name.as_deref().unwrap_or("").chars().map(|c| if c == '"' { '\'' } else { c }).filter(|c| !c.is_control()).collect();
    let n = n.trim();
    if n.is_empty() { String::new() } else { format!(";CN=\"{n}\"") }
}

/// A calendar address for `mailto:`: no white space or control characters, so it cannot end the property value early or
/// start a new line.
fn cal_addr(email: &str) -> String {
    email.chars().filter(|c| !c.is_control() && !c.is_whitespace()).collect()
}

/// Serialize events as an iCalendar document. `method` = REQUEST / REPLY / CANCEL / PUBLISH, or None for a plain file.
pub fn to_ics(method: Option<&str>, events: &[IcsEvent]) -> String {
    let mut out = String::new();
    let mut l = |s: String| fold(&s, &mut out);
    l("BEGIN:VCALENDAR".into());
    l("PRODID:-//Hey Look!//Mail//EN".into());
    l("VERSION:2.0".into());
    l("CALSCALE:GREGORIAN".into());
    if let Some(m) = method {
        l(format!("METHOD:{m}"));
    }
    for ev in events {
        l("BEGIN:VEVENT".into());
        l(format!("UID:{}", ev.uid));
        l(format!("DTSTAMP:{}", fmt_utc(if ev.dtstamp > 0 { ev.dtstamp } else { Utc::now().timestamp() })));
        // a repeating event keeps its wall-clock time across daylight saving: write it in its own zone
        let tz = ev.tzid.as_deref().and_then(iana_for).filter(|_| ev.rrule.is_some() && !ev.all_day);
        l(fmt_dt("DTSTART", ev.start, ev.all_day, tz));
        l(fmt_dt("DTEND", ev.end, ev.all_day, tz));
        if let Some(r) = ev.recurrence_id {
            l(fmt_dt("RECURRENCE-ID", r, ev.all_day, tz));
        }
        if let Some(r) = &ev.rrule {
            l(format!("RRULE:{r}"));
        }
        for x in &ev.exdates {
            l(fmt_dt("EXDATE", *x, ev.all_day, tz));
        }
        l(format!("SEQUENCE:{}", ev.sequence));
        l(format!("SUMMARY:{}", escape(&ev.summary)));
        if let Some(d) = &ev.description {
            l(format!("DESCRIPTION:{}", escape(d)));
        }
        if let Some(loc) = &ev.location {
            l(format!("LOCATION:{}", escape(loc)));
        }
        if let Some(u) = &ev.url {
            l(format!("URL:{u}"));
        }
        l(format!(
            "STATUS:{}",
            match ev.status.as_str() {
                "cancelled" => "CANCELLED",
                "tentative" => "TENTATIVE",
                _ => "CONFIRMED",
            }
        ));
        if let Some(c) = &ev.comment {
            l(format!("COMMENT:{}", escape(c)));
        }
        if let Some(o) = &ev.organizer {
            l(format!("ORGANIZER{}:mailto:{}", cn(&o.name), cal_addr(&o.email)));
        }
        for a in &ev.attendees {
            let role = match a.role.as_str() {
                "chair" => "CHAIR",
                "optional" => "OPT-PARTICIPANT",
                _ => "REQ-PARTICIPANT",
            };
            let ps = match a.status.as_str() {
                "accepted" => "ACCEPTED",
                "tentative" => "TENTATIVE",
                "declined" => "DECLINED",
                "delegated" => "DELEGATED",
                _ => "NEEDS-ACTION",
            };
            l(format!("ATTENDEE{};ROLE={role};PARTSTAT={ps};RSVP={}:mailto:{}", cn(&a.name), if a.rsvp { "TRUE" } else { "FALSE" }, cal_addr(&a.email)));
        }
        l("END:VEVENT".into());
    }
    l("END:VCALENDAR".into());
    out
}

/// The REPLY event for one invitation: the same UID / SEQUENCE / times, only the responding attendee.
pub fn reply_event(inv: &IcsEvent, who: &Person, partstat: &str, comment: Option<&str>, now: i64) -> IcsEvent {
    IcsEvent {
        uid: inv.uid.clone(),
        sequence: inv.sequence,
        summary: inv.summary.clone(),
        start: inv.start,
        end: inv.end,
        all_day: inv.all_day,
        tzid: inv.tzid.clone(),
        recurrence_id: inv.recurrence_id,
        organizer: inv.organizer.clone(),
        attendees: vec![Attendee { email: who.email.clone(), name: who.name.clone(), role: "required".into(), status: partstat.into(), rsvp: false }],
        comment: comment.map(|c| c.to_string()).filter(|c| !c.trim().is_empty()),
        status: "confirmed".into(),
        dtstamp: now,
        ..Default::default()
    }
}

/// `HH:MM` helper used by tests and plain-text fallbacks.
#[allow(dead_code)]
pub fn hm(ts: i64, tz: Option<&str>) -> String {
    let u = chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default();
    match tz.and_then(iana_for) {
        Some(z) => {
            let l = z.from_utc_datetime(&u.naive_utc());
            format!("{:02}:{:02}", l.hour(), l.minute())
        }
        None => format!("{:02}:{:02}", u.hour(), u.minute()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nPRODID:-//Test//EN\r\nVERSION:2.0\r\n\
BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10\r\nEND:STANDARD\r\n\
BEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n\
BEGIN:VEVENT\r\nUID:abc-123@contoso.com\r\nSEQUENCE:2\r\nDTSTAMP:20261001T080000Z\r\n\
DTSTART;TZID=W. Europe Standard Time:20261014T100000\r\nDTEND;TZID=W. Europe Standard Time:20261014T110000\r\n\
SUMMARY:Product sync\\, weekly\r\nLOCATION:Room 4B\r\n\
DESCRIPTION:Agenda in the doc.\\nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x\r\n\
ORGANIZER;CN=\"Mai Khanh\":mailto:Mai@contoso.com\r\n\
ATTENDEE;CN=Nam Hoang;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:nam@example.com\r\n\
ATTENDEE;CN=\"Bao, Tran\";PARTSTAT=ACCEPTED:mailto:bao@contoso.com\r\n\
ATTENDEE;CUTYPE=ROOM:mailto:room4b@contoso.com\r\n\
RRULE:FREQ=WEEKLY;BYDAY=WE\r\n\
BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\n\
END:VEVENT\r\nEND:VCALENDAR\r\n";

    fn ts(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap().and_utc().timestamp()
    }

    #[test]
    fn parses_request_with_windows_zone_and_attendees() {
        let c = parse(REQUEST).unwrap();
        assert_eq!(c.method.as_deref(), Some("REQUEST"));
        assert_eq!(c.events.len(), 1);
        let e = &c.events[0];
        assert_eq!(e.uid, "abc-123@contoso.com");
        assert_eq!(e.sequence, 2);
        assert_eq!(e.summary, "Product sync, weekly");
        // W. Europe Standard Time -> Europe/Berlin; 14 Oct 2026 is CEST (UTC+2)
        assert_eq!(e.start, ts(2026, 10, 14, 8, 0));
        assert_eq!(e.end, ts(2026, 10, 14, 9, 0));
        assert_eq!(e.tzid.as_deref(), Some("Europe/Berlin"));
        assert!(!e.all_day);
        assert_eq!(e.organizer.as_ref().unwrap().email, "mai@contoso.com");
        assert_eq!(e.organizer.as_ref().unwrap().name.as_deref(), Some("Mai Khanh"));
        assert_eq!(e.attendees.len(), 2, "the ROOM resource is not a person");
        assert_eq!(e.attendees[0].status, "needs-action");
        assert!(e.attendees[0].rsvp);
        assert_eq!(e.attendees[1].name.as_deref(), Some("Bao, Tran"));
        assert_eq!(e.attendees[1].status, "accepted");
        assert_eq!(e.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=WE"));
        assert_eq!(e.location.as_deref(), Some("Room 4B"));
        assert!(e.description.as_deref().unwrap().contains('\n'));
        assert!(join_url(e).unwrap().starts_with("https://teams.microsoft.com/l/meetup-join/"));
    }

    #[test]
    fn unfolds_long_lines_and_lf_only_input() {
        let s = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u1\nDTSTART:20261014T100000Z\nSUMMARY:A very long title that was folded by the sender because it went\n  past the limit\nDESCRIPTION:line one\\nline two\nEND:VEVENT\nEND:VCALENDAR\n";
        let c = parse(s).unwrap();
        assert_eq!(c.events[0].summary, "A very long title that was folded by the sender because it went past the limit");
        assert_eq!(c.events[0].description.as_deref(), Some("line one\nline two"));
        // no DTEND/DURATION: zero length for a timed event
        assert_eq!(c.events[0].end, c.events[0].start);
    }

    #[test]
    fn utc_floating_and_duration_times() {
        let s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u2\r\nDTSTART:20261014T100000Z\r\nDURATION:PT1H30M\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let e = &parse(s).unwrap().events[0];
        assert_eq!(e.start, ts(2026, 10, 14, 10, 0));
        assert_eq!(e.end, ts(2026, 10, 14, 11, 30));
        assert_eq!(parse_duration("P1DT2H"), Some(93600));
        assert_eq!(parse_duration("-PT15M"), Some(-900));
        assert_eq!(parse_duration("nonsense"), None);
    }

    #[test]
    fn all_day_events_are_dates() {
        let s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u3\r\nDTSTART;VALUE=DATE:20261014\r\nDTEND;VALUE=DATE:20261017\r\nSUMMARY:Offsite\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let e = &parse(s).unwrap().events[0];
        assert!(e.all_day);
        assert_eq!(e.start, ts(2026, 10, 14, 0, 0));
        assert_eq!(e.end, ts(2026, 10, 17, 0, 0));
        // a single date without DTEND lasts one day
        let s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u4\r\nDTSTART;VALUE=DATE:20261014\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let e = &parse(s).unwrap().events[0];
        assert_eq!(e.end - e.start, 86400);
    }

    #[test]
    fn iana_zone_and_unknown_zone_fall_back() {
        let s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u5\r\nDTSTART;TZID=Asia/Ho_Chi_Minh:20261014T100000\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let e = &parse(s).unwrap().events[0];
        assert_eq!(e.start, ts(2026, 10, 14, 3, 0));
        assert_eq!(e.tzid.as_deref(), Some("Asia/Ho_Chi_Minh"));
        // TZID with an Olson path prefix
        assert_eq!(iana_for("/mozilla.org/20050126_1/Europe/Berlin"), Some(chrono_tz::Europe::Berlin));
        // a custom VTIMEZONE with only fixed offsets
        let s = "BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Custom Zone\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:u6\r\nDTSTART;TZID=Custom Zone:20261014T100000\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let e = &parse(s).unwrap().events[0];
        assert_eq!(e.start, ts(2026, 10, 14, 4, 30));
        // an unknown zone name is read as UTC rather than failing
        let s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u7\r\nDTSTART;TZID=Nowhere/Land:20261014T100000\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR";
        assert_eq!(parse(s).unwrap().events[0].start, ts(2026, 10, 14, 10, 0));
    }

    #[test]
    fn dst_gap_time_moves_forward() {
        // 2026-03-29 02:30 does not exist in Berlin (clocks go 02:00 -> 03:00)
        let n = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap().and_hms_opt(2, 30, 0).unwrap();
        let t = local_in(chrono_tz::Europe::Berlin, n);
        assert_eq!(t, ts(2026, 3, 29, 1, 30)); // 03:30 CEST
    }

    #[test]
    fn method_cancel_and_status_and_override() {
        let s = "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:u8\r\nSEQUENCE:3\r\nSTATUS:CANCELLED\r\nDTSTART:20261014T100000Z\r\nRECURRENCE-ID:20261021T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let c = parse(s).unwrap();
        assert_eq!(c.method.as_deref(), Some("CANCEL"));
        assert_eq!(c.events[0].status, "cancelled");
        assert_eq!(c.events[0].recurrence_id, Some(ts(2026, 10, 21, 10, 0)));
    }

    #[test]
    fn malformed_input_is_an_error_not_a_panic() {
        assert!(parse("").is_err());
        assert!(parse("hello world").is_err());
        assert!(parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR").is_err());
        // an event without a start time is skipped
        assert!(parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:no start\r\nEND:VEVENT\r\nEND:VCALENDAR").is_err());
        // garbage dates and truncated input
        assert!(parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:2026-xx\r\nEND:VEVENT\r\nEND:VCALENDAR").is_err());
        assert_eq!(parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261014T100000Z\r\nSUMMARY:cut off").unwrap().events[0].summary, "cut off", "truncated input keeps what was read");
        // junk lines between properties are ignored
        let c = parse("BEGIN:VCALENDAR\r\n???\r\n:novalue\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261014T100000Z\r\nBAD LINE\r\nSUMMARY:ok\r\nEND:VEVENT\r\nEND:VCALENDAR").unwrap();
        assert_eq!(c.events[0].summary, "ok");
        // a UTF-8 BOM and multibyte text survive
        let c = parse("\u{feff}BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261014T100000Z\r\nSUMMARY:Họp nhóm — đồng bộ\r\nEND:VEVENT\r\nEND:VCALENDAR").unwrap();
        assert_eq!(c.events[0].summary, "Họp nhóm — đồng bộ");
    }

    fn ics_with(extra: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VTIMEZONE\r\nTZID:Custom\r\n{extra}END:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:f1\r\nDTSTART;TZID=Custom:20261014T100000\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    }

    #[test]
    fn multibyte_tz_offset_does_not_panic() {
        // F1: TZOFFSETTO with a multi-byte character in the digits
        for bad in ["+€12", "€€€€", "+12é4", "-é", "+", "-", "", "+99999999", "+2599", "+1260", "+12:30"] {
            let ics = ics_with(&format!("BEGIN:STANDARD\r\nTZOFFSETTO:{bad}\r\nEND:STANDARD\r\n"));
            let _ = parse(&ics);
            assert_eq!(offset_secs(bad), None, "{bad}");
        }
        assert_eq!(offset_secs("+0530"), Some(19800));
        assert_eq!(offset_secs("-0800"), Some(-28800));
        assert_eq!(offset_secs("+053015"), Some(19815));
    }

    #[test]
    fn multibyte_byday_does_not_panic() {
        // F2: BYDAY with multi-byte characters, on every path that reads a rule
        let s = ts(2026, 10, 14, 9, 0);
        for rule in [
            "FREQ=WEEKLY;BYDAY=éM",
            "FREQ=WEEKLY;BYDAY=é",
            "FREQ=WEEKLY;BYDAY=€€€",
            "FREQ=MONTHLY;BYDAY=1é",
            "FREQ=WEEKLY;BYDAY=日本語",
            "FREQ=WEEKLY;BYDAY=,,,",
            "FREQ=WEEKLY;BYDAY=99999999999MO",
            "FREQ=MONTHLY;BYDAY=-2147483648MO",
            "FREQ=MONTHLY;BYDAY=2147483647TU",
        ] {
            let _ = expand(s, s + 3600, false, None, rule, &[], 0, ts(2030, 1, 1, 0, 0));
            let _ = describe_rrule(rule, s);
        }
        assert!(parse_rule("FREQ=WEEKLY;BYDAY=éM").is_none());
        assert_eq!(parse_rule("FREQ=MONTHLY;BYDAY=-1FR").unwrap().by_day, vec![(-1, Weekday::Fri)]);
    }

    #[test]
    fn multibyte_attendee_and_organizer_do_not_panic() {
        // F3: mailto() sliced bytes
        assert_eq!(mailto("aaaaaa€x@y.z").as_deref(), Some("aaaaaa€x@y.z"));
        assert_eq!(mailto("MAILTO:Bob@Example.com").as_deref(), Some("bob@example.com"));
        assert_eq!(mailto("€€€").as_deref(), None);
        assert_eq!(mailto("mail€o:a@b").as_deref(), Some("mail€o:a@b"));
        let s = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m\r\nDTSTART:20261014T100000Z\r\nORGANIZER:aaaaaa€x@y.z\r\nATTENDEE;EMAIL=€€€€€€€€:€€€€€€€€\r\nATTENDEE;CN=Đỗ:mailto:€@x\r\nEND:VEVENT\r\nEND:VCALENDAR";
        let e = &parse(s).unwrap().events[0];
        assert_eq!(e.organizer.as_ref().unwrap().email, "aaaaaa€x@y.z");
    }

    #[test]
    fn huge_interval_and_counts_do_not_overflow() {
        // F4: INTERVAL and friends near the integer and date limits
        let s = ts(2026, 10, 14, 9, 0);
        for rule in [
            "FREQ=DAILY;INTERVAL=100000000",
            "FREQ=DAILY;INTERVAL=4294967295",
            "FREQ=WEEKLY;INTERVAL=20000000",
            "FREQ=WEEKLY;INTERVAL=4294967295;BYDAY=MO,TU",
            "FREQ=MONTHLY;INTERVAL=4294967295",
            "FREQ=MONTHLY;INTERVAL=2147483647;COUNT=4294967295",
            "FREQ=YEARLY;INTERVAL=4294967295",
            "FREQ=YEARLY;INTERVAL=2147483647",
            "FREQ=YEARLY;INTERVAL=1000000;BYMONTH=0,13,99,4294967295",
            "FREQ=YEARLY;BYMONTH=0",
            "FREQ=YEARLY;BYMONTH=13;BYMONTHDAY=-2147483648,2147483647,0",
            "FREQ=MONTHLY;BYMONTHDAY=-2147483648,32,-32",
            "FREQ=DAILY;COUNT=99999999999999",
        ] {
            let o = expand(s, s + 3600, false, None, rule, &[], 0, i64::MAX);
            assert!(o.len() <= 60_000, "{rule}");
            let _ = expand(s, s + 3600, false, Some("Europe/Berlin"), rule, &[], i64::MIN, i64::MAX);
            let _ = expand(s, i64::MAX, false, None, rule, &[], 0, i64::MAX);
            let _ = expand(i64::MAX / 2, i64::MIN, true, None, rule, &[], i64::MIN, i64::MAX);
            let _ = describe_rrule(rule, s);
        }
        // dates at the edge of the calendar
        let far = NaiveDate::from_ymd_opt(9999, 12, 30).unwrap().and_hms_opt(23, 0, 0).unwrap().and_utc().timestamp();
        for rule in ["FREQ=DAILY", "FREQ=WEEKLY;BYDAY=SA,SU", "FREQ=MONTHLY", "FREQ=YEARLY"] {
            let o = expand(far, far + 3600, false, Some("Europe/Berlin"), rule, &[], 0, i64::MAX);
            assert!(!o.is_empty() && o.len() < 100_000, "{rule}");
        }
        // an enormous DURATION does not overflow the end time
        let c = parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d\r\nDTSTART:20261014T100000Z\r\nDURATION:P9223372036854775807W\r\nEND:VEVENT\r\nEND:VCALENDAR").unwrap();
        assert_eq!(c.events[0].end, c.events[0].start);
        assert_eq!(parse_duration("PT9223372036854775807S"), Some(i64::MAX));
        assert_eq!(parse_duration("P9223372036854775807D"), None);
        assert_eq!(parse_duration("P9223372036854775807DT9223372036854775807S"), None);
    }

    #[test]
    fn odd_dates_are_rejected_not_panicked_on() {
        for v in ["+2026", "-2026-14", "2026€1014", "２０２６1014", "20261014T1000", "20261014T10€000", "20261014Tzzzzzz", "00000000", "99999999", "20261332", "€€€€€€€€", "20261014T250000Z"] {
            let ics = format!("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:o\r\nDTSTART:{v}\r\nRRULE:FREQ=DAILY;UNTIL={v}\r\nEXDATE:{v},{v}\r\nRECURRENCE-ID:{v}\r\nEND:VEVENT\r\nEND:VCALENDAR");
            let _ = parse(&ics);
        }
        assert!(parse_naive("-2026-14").is_none());
        assert!(parse_naive("+2026101").is_none());
    }

    #[test]
    fn fuzz_truncation_and_mutation_never_panics() {
        // every prefix of a rich invitation, at every char boundary, plus splices of multi-byte and numeric junk
        let rich = format!("{REQUEST}BEGIN:VEVENT\r\nUID:z\r\nDTSTART;VALUE=DATE:20261014\r\nRRULE:FREQ=YEARLY;BYMONTH=2;BYDAY=-1MO;UNTIL=20300101\r\nEXDATE;VALUE=DATE:20271014,20281014\r\nDURATION:P1DT2H3M4S\r\nATTENDEE;CN=\"Đỗ Văn\";PARTSTAT=ACCEPTED:mailto:dv@x.vn\r\nEND:VEVENT\r\n");
        let exercise = |c: &IcsCalendar| {
            for e in &c.events {
                if let Some(r) = &e.rrule {
                    let _ = describe_rrule(r, e.start);
                    let _ = expand(e.start, e.end, e.all_day, e.tzid.as_deref(), r, &e.exdates, 0, ts(2032, 1, 1, 0, 0));
                }
                let _ = to_ics(Some("REQUEST"), &[e.clone()]);
                let _ = join_url(e);
            }
        };
        for (i, _) in rich.char_indices() {
            if let Ok(c) = parse(&rich[..i]) {
                exercise(&c);
            }
        }
        let junk = ["€", "é", "日", "😀", "\u{0}", ";", ":", "=", "\\", "\"", ",", "9999999999", "-", "+"];
        let chars: Vec<(usize, char)> = rich.char_indices().collect();
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..1500 {
            let cut = chars[(next() % chars.len() as u64) as usize].0;
            let resume = chars[(next() % chars.len() as u64) as usize].0;
            let t = format!("{}{}{}", &rich[..cut], junk[(next() % junk.len() as u64) as usize], &rich[resume..]);
            if let Ok(c) = parse(&t) {
                exercise(&c);
            }
        }
        // rule strings built from junk fragments
        for _ in 0..2000 {
            let mut r = String::from(["FREQ=DAILY", "FREQ=WEEKLY", "FREQ=MONTHLY", "FREQ=YEARLY"][(next() % 4) as usize]);
            for _ in 0..(next() % 4) {
                r.push(';');
                r.push_str(["BYDAY=", "BYMONTH=", "BYMONTHDAY=", "INTERVAL=", "COUNT=", "UNTIL=", "WKST="][(next() % 7) as usize]);
                r.push_str(junk[(next() % junk.len() as u64) as usize]);
                r.push_str(["MO", "1", "-1", "12", "0", "99999999999", "20261014", "TU,WE", ""][(next() % 9) as usize]);
            }
            let s = ts(2026, 10, 14, 9, 0);
            let _ = describe_rrule(&r, s);
            let _ = expand(s, s + 3600, false, Some("Europe/Berlin"), &r, &[], 0, ts(2032, 1, 1, 0, 0));
        }
    }

    fn series(rule: &str, start: i64, from: i64, to: i64) -> Vec<i64> {
        expand(start, start + 3600, false, None, rule, &[], from, to).into_iter().map(|x| x.0).collect()
    }

    #[test]
    fn rrule_weekly_byday_count_interval_until() {
        let start = ts(2026, 10, 12, 9, 0); // Monday
        let all = series("FREQ=WEEKLY;BYDAY=MO,WE", start, ts(2026, 10, 1, 0, 0), ts(2026, 11, 1, 0, 0));
        let days: Vec<u32> = all.iter().map(|t| chrono::DateTime::from_timestamp(*t, 0).unwrap().day()).collect();
        assert_eq!(days, vec![12, 14, 19, 21, 26, 28]);
        // COUNT counts from DTSTART, not from the window
        let c = series("FREQ=DAILY;COUNT=3", start, ts(2026, 10, 13, 0, 0), ts(2026, 12, 1, 0, 0));
        assert_eq!(c, vec![ts(2026, 10, 13, 9, 0), ts(2026, 10, 14, 9, 0)]);
        // INTERVAL=2 weeks
        let i = series("FREQ=WEEKLY;INTERVAL=2", start, ts(2026, 10, 1, 0, 0), ts(2026, 11, 30, 0, 0));
        assert_eq!(i, vec![start, ts(2026, 10, 26, 9, 0), ts(2026, 11, 9, 9, 0), ts(2026, 11, 23, 9, 0)]);
        // UNTIL (date) is inclusive
        let u = series("FREQ=DAILY;UNTIL=20261014", start, ts(2026, 10, 1, 0, 0), ts(2026, 12, 1, 0, 0));
        assert_eq!(u.len(), 3);
        let u = series("FREQ=DAILY;UNTIL=20261014T090000Z", start, ts(2026, 10, 1, 0, 0), ts(2026, 12, 1, 0, 0));
        assert_eq!(u.len(), 3);
    }

    #[test]
    fn rrule_monthly_and_yearly() {
        let start = ts(2026, 1, 31, 9, 0);
        let m = series("FREQ=MONTHLY", start, ts(2026, 1, 1, 0, 0), ts(2026, 6, 1, 0, 0));
        let ds: Vec<(u32, u32)> = m.iter().map(|t| { let d = chrono::DateTime::from_timestamp(*t, 0).unwrap(); (d.month(), d.day()) }).collect();
        assert_eq!(ds, vec![(1, 31), (3, 31), (5, 31)], "months without the 31st are skipped");
        // second Tuesday of every month
        let s = ts(2026, 10, 13, 9, 0);
        let m = series("FREQ=MONTHLY;BYDAY=2TU", s, ts(2026, 10, 1, 0, 0), ts(2027, 1, 1, 0, 0));
        assert_eq!(m, vec![s, ts(2026, 11, 10, 9, 0), ts(2026, 12, 8, 9, 0)]);
        // last Friday
        let m = series("FREQ=MONTHLY;BYDAY=-1FR", ts(2026, 10, 30, 9, 0), ts(2026, 10, 1, 0, 0), ts(2026, 12, 31, 0, 0));
        assert_eq!(m, vec![ts(2026, 10, 30, 9, 0), ts(2026, 11, 27, 9, 0), ts(2026, 12, 25, 9, 0)]);
        // BYMONTHDAY
        let m = series("FREQ=MONTHLY;BYMONTHDAY=1,15", ts(2026, 10, 1, 9, 0), ts(2026, 10, 1, 0, 0), ts(2026, 11, 20, 0, 0));
        assert_eq!(m.len(), 4);
        // yearly
        let y = series("FREQ=YEARLY", ts(2024, 2, 29, 9, 0), ts(2024, 1, 1, 0, 0), ts(2033, 1, 1, 0, 0));
        assert_eq!(y.len(), 3, "29 Feb only exists in 2024, 2028, 2032");
    }

    #[test]
    fn rrule_keeps_local_time_across_dst_and_excludes_exdates() {
        // 09:00 in Berlin every week; the clocks change on 2026-10-25
        let start = ts(2026, 10, 19, 7, 0); // 09:00 CEST
        let o = expand(start, start + 3600, false, Some("Europe/Berlin"), "FREQ=WEEKLY", &[], ts(2026, 10, 1, 0, 0), ts(2026, 11, 3, 0, 0));
        let starts: Vec<i64> = o.iter().map(|x| x.0).collect();
        assert_eq!(starts, vec![start, ts(2026, 10, 26, 8, 0), ts(2026, 11, 2, 8, 0)], "09:00 local = 08:00 UTC after the change");
        let o = expand(start, start + 3600, false, Some("Europe/Berlin"), "FREQ=WEEKLY", &[ts(2026, 10, 26, 8, 0)], ts(2026, 10, 1, 0, 0), ts(2026, 11, 3, 0, 0));
        assert_eq!(o.len(), 2);
        // all-day recurrence stays on its dates
        let d = ts(2026, 10, 14, 0, 0);
        let o = expand(d, d + 86400, true, None, "FREQ=DAILY;COUNT=2", &[], d, d + 10 * 86400);
        assert_eq!(o, vec![(d, d + 86400), (d + 86400, d + 2 * 86400)]);
        // unknown rule: only the base occurrence
        let o = expand(start, start + 3600, false, None, "FREQ=HOURLY", &[], 0, i64::MAX / 2);
        assert_eq!(o.len(), 1);
        // window that ends before the start yields nothing and does not loop forever
        assert!(series("FREQ=DAILY", start, 0, ts(2026, 1, 1, 0, 0)).is_empty());
    }

    fn took(f: impl FnOnce()) -> std::time::Duration {
        let t = std::time::Instant::now();
        f();
        t.elapsed()
    }

    #[test]
    fn hostile_rule_lists_are_bounded_and_fast() {
        // F32: a 200 KB invite with a 100,000-entry BYMONTHDAY list used to take about a minute in a debug build
        let list = vec!["1"; 100_000].join(",");
        let ics = format!("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:h1\nDTSTART:20261014T100000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY={list}\nEND:VEVENT\nEND:VCALENDAR\n");
        assert!(ics.len() > 200_000);
        let mut got = vec![];
        let t = took(|| {
            let c = parse(&ics).unwrap();
            let e = &c.events[0];
            assert!(e.rrule.is_none(), "an oversized RRULE is dropped");
            got = expand(e.start, e.end, false, None, &format!("FREQ=MONTHLY;BYMONTHDAY={list}"), &[], 0, ts(2060, 1, 1, 0, 0));
        });
        assert_eq!(got.len(), 1, "unusable rule: only the base occurrence");
        assert!(t.as_millis() < 1000, "took {t:?}");
    }

    #[test]
    fn rule_lists_below_the_text_cap_are_deduplicated_and_capped() {
        // about 900 characters of repeated values: only the distinct ones survive
        let days: Vec<String> = (0..300).map(|i| ((i % 31) as i32 + 1).to_string()).collect();
        let r = parse_rule(&format!("FREQ=MONTHLY;BYMONTHDAY={}", days.join(","))).unwrap();
        assert_eq!(r.by_month_day.len(), 31);
        let r = parse_rule(&format!("FREQ=MONTHLY;BYDAY={}", vec!["MO"; 300].join(","))).unwrap();
        assert_eq!(r.by_day.len(), 1);
        let many: Vec<String> = (-53..=53).flat_map(|n| ["MO", "TU", "WE"].map(|d| format!("{n}{d}"))).collect();
        let r = parse_rule(&format!("FREQ=MONTHLY;BYDAY={}", many.join(","))).unwrap_or_else(|| parse_rule("FREQ=MONTHLY;BYDAY=MO").unwrap());
        assert!(r.by_day.len() <= MAX_RULE_LIST);
        // worst case within the text cap, walked from a very old DTSTART to a far window
        let start = ts(1971, 1, 1, 9, 0);
        let rule = format!("FREQ=MONTHLY;BYMONTHDAY={}", (1..=31).map(|d| d.to_string()).collect::<Vec<_>>().join(","));
        let mut n = 0;
        let t = took(|| n = expand(start, start + 3600, false, Some("Europe/Berlin"), &rule, &[], ts(2026, 1, 1, 0, 0), ts(2027, 1, 1, 0, 0)).len());
        assert!(n > 300, "{n}");
        assert!(t.as_millis() < 1000, "took {t:?}");
        let rule = format!("FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;BYDAY={}", &many.join(",")[..600].trim_end_matches(','));
        let t = took(|| {
            let _ = expand(start, start + 3600, false, Some("Europe/Berlin"), &rule, &[], ts(2026, 1, 1, 0, 0), ts(2027, 1, 1, 0, 0));
        });
        assert!(t.as_millis() < 1000, "took {t:?}");
    }

    #[test]
    fn many_exdates_are_capped_on_parse_and_cheap_to_expand() {
        let ex: Vec<String> = (0..10_000).map(|i| format!("{}", 20270101 + (i % 28))).collect();
        let ics = format!("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:h2\nDTSTART:20261014T100000Z\nRRULE:FREQ=DAILY\nEXDATE;VALUE=DATE:{}\nEND:VEVENT\nEND:VCALENDAR\n", ex.join(","));
        let c = parse(&ics).unwrap();
        assert!(c.events[0].exdates.len() <= MAX_EXDATES);
        // duplicates collapse
        let ex2: Vec<String> = (0..500).map(|_| "20261015T100000Z".to_string()).collect();
        let c = parse(&format!("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:h3\nDTSTART:20261014T100000Z\nEXDATE:{}\nEND:VEVENT\nEND:VCALENDAR\n", ex2.join(","))).unwrap();
        assert_eq!(c.events[0].exdates.len(), 1);
        // a long stored list (rows written by an older version) is a set lookup, not a scan per occurrence
        let start = ts(2026, 10, 14, 10, 0);
        let exd: Vec<i64> = (0..10_000).map(|i| start + 86400 * (i % 5000)).collect();
        let mut n = 0;
        let t = took(|| n = expand(start, start + 3600, false, None, "FREQ=DAILY", &exd, start, start + 30_000 * 86400).len());
        assert!(t.as_millis() < 1000, "took {t:?}");
        assert!(n <= MAX_OCCURRENCES);
    }

    #[test]
    fn expand_budget_is_shared_and_spent() {
        let start = ts(2026, 10, 14, 10, 0);
        let mut budget = MAX_EXPAND_STEPS;
        let _ = expand_budgeted(start, start + 3600, false, None, "FREQ=DAILY", &[], start, start + 40_000 * 86400, &mut budget);
        assert!(budget < MAX_EXPAND_STEPS);
        let mut none = 0usize;
        let out = expand_budgeted(start, start + 3600, false, None, "FREQ=DAILY", &[], start, start + 100 * 86400, &mut none);
        assert!(out.is_empty(), "no budget left: nothing is walked");
        let mut b = MAX_EXPAND_STEPS;
        let out = expand_budgeted(start, start + 3600, false, None, "FREQ=DAILY", &[], start, start + 10 * 86400, &mut b);
        assert_eq!(out.len(), 10);
    }

    #[test]
    fn oversized_attendee_lists_are_cut_and_normal_rules_kept() {
        let att: String = (0..2000).map(|i| format!("ATTENDEE:mailto:p{i}@example.com\n")).collect();
        let c = parse(&format!("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:h4\nDTSTART:20261014T100000Z\nRRULE:FREQ=DAILY\n{att}END:VEVENT\nEND:VCALENDAR\n")).unwrap();
        assert_eq!(c.events[0].attendees.len(), MAX_ATTENDEES);
        assert_eq!(c.events[0].rrule.as_deref(), Some("FREQ=DAILY"), "a normal rule is kept");
        assert!(c.events[0].trimmed, "cutting the list is reported");
    }

    #[test]
    fn dropped_details_are_flagged_and_normal_events_are_not() {
        let plain = parse("BEGIN:VCALENDAR
BEGIN:VEVENT
UID:t1
DTSTART:20261014T100000Z
RRULE:FREQ=WEEKLY;BYDAY=WE
ATTENDEE:mailto:a@example.com
EXDATE:20261021T100000Z
END:VEVENT
END:VCALENDAR
").unwrap();
        assert!(!plain.events[0].trimmed);
        let long_rule = format!("FREQ=WEEKLY;BYDAY={}", "MO,".repeat(500));
        let c = parse(&format!("BEGIN:VCALENDAR
BEGIN:VEVENT
UID:t2
DTSTART:20261014T100000Z
RRULE:{long_rule}
END:VEVENT
END:VCALENDAR
")).unwrap();
        assert!(c.events[0].rrule.is_none() && c.events[0].trimmed);
        let ex: Vec<String> = (30..40).flat_map(|y| (1..=12).flat_map(move |m| (1..=28).map(move |d| format!("20{y}{m:02}{d:02}")))).collect();
        assert!(ex.len() > MAX_EXDATES);
        let c = parse(&format!("BEGIN:VCALENDAR
BEGIN:VEVENT
UID:t3
DTSTART:20261014T100000Z
EXDATE;VALUE=DATE:{}
END:VEVENT
END:VCALENDAR
", ex.join(","))).unwrap();
        assert_eq!(c.events[0].exdates.len(), MAX_EXDATES);
        assert!(c.events[0].trimmed);
    }

    #[test]
    fn describes_rules_in_words() {
        let s = ts(2026, 10, 14, 9, 0);
        assert_eq!(describe_rrule("FREQ=WEEKLY;BYDAY=WE", s).as_deref(), Some("Every Wednesday"));
        assert_eq!(describe_rrule("FREQ=WEEKLY", s).as_deref(), Some("Every Wednesday"));
        assert_eq!(describe_rrule("FREQ=WEEKLY;BYDAY=MO,WE,FR", s).as_deref(), Some("Every Monday, Wednesday and Friday"));
        assert_eq!(describe_rrule("FREQ=DAILY;INTERVAL=2;COUNT=5", s).as_deref(), Some("Every 2 days, 5 times"));
        assert_eq!(describe_rrule("FREQ=MONTHLY;UNTIL=20261231", s).as_deref(), Some("Every month, until 31 Dec 2026"));
        assert!(describe_rrule("garbage", s).is_none());
    }

    #[test]
    fn writes_and_reads_back_a_request() {
        let ev = IcsEvent {
            uid: "heylook-1@example.com".into(),
            sequence: 1,
            summary: "Review; plan, and notes".into(),
            description: Some("Line 1\nLine 2 with a very long sentence that should be folded because it exceeds seventy-five octets by far".into()),
            location: Some("Room 4B".into()),
            start: ts(2026, 10, 14, 3, 0),
            end: ts(2026, 10, 14, 4, 0),
            tzid: Some("Asia/Ho_Chi_Minh".into()),
            organizer: Some(Person { email: "nam@example.com".into(), name: Some("Nam Hoang".into()) }),
            attendees: vec![
                Attendee { email: "nam@example.com".into(), name: Some("Nam Hoang".into()), role: "chair".into(), status: "accepted".into(), rsvp: false },
                Attendee { email: "linh@example.com".into(), name: None, role: "optional".into(), status: "needs-action".into(), rsvp: true },
            ],
            rrule: Some("FREQ=WEEKLY;BYDAY=WE".into()),
            exdates: vec![ts(2026, 10, 21, 3, 0)],
            status: "confirmed".into(),
            dtstamp: ts(2026, 10, 1, 0, 0),
            ..Default::default()
        };
        let text = to_ics(Some("REQUEST"), &[ev.clone()]);
        assert!(text.contains("METHOD:REQUEST\r\n"));
        assert!(text.contains("DTSTART;TZID=Asia/Ho_Chi_Minh:20261014T100000"), "recurring events keep their zone: {text}");
        assert!(text.lines().all(|l| l.len() <= 75), "lines are folded at 75 octets");
        let back = parse(&text).unwrap();
        let b = &back.events[0];
        assert_eq!(back.method.as_deref(), Some("REQUEST"));
        assert_eq!(b.uid, ev.uid);
        assert_eq!(b.sequence, 1);
        assert_eq!(b.summary, ev.summary);
        assert_eq!(b.description, ev.description);
        assert_eq!(b.start, ev.start);
        assert_eq!(b.end, ev.end);
        assert_eq!(b.exdates, ev.exdates);
        assert_eq!(b.rrule, ev.rrule);
        assert_eq!(b.attendees.len(), 2);
        assert_eq!(b.attendees[1].role, "optional");
        assert!(b.attendees[1].rsvp);
        assert_eq!(b.organizer.as_ref().unwrap().name.as_deref(), Some("Nam Hoang"));
        // a non-recurring event is written in UTC
        let mut one = ev.clone();
        one.rrule = None;
        one.exdates.clear();
        assert!(to_ics(None, &[one]).contains("DTSTART:20261014T030000Z"));
    }

    #[test]
    fn reply_keeps_uid_sequence_and_has_one_attendee() {
        let inv = &parse(REQUEST).unwrap().events[0];
        let me = Person { email: "nam@example.com".into(), name: Some("Nam Hoang".into()) };
        let r = reply_event(inv, &me, "accepted", Some("See you there"), ts(2026, 10, 12, 0, 0));
        let text = to_ics(Some("REPLY"), &[r]);
        assert!(text.contains("METHOD:REPLY\r\n"));
        let back = parse(&text).unwrap();
        assert_eq!(back.method.as_deref(), Some("REPLY"));
        let b = &back.events[0];
        assert_eq!(b.uid, inv.uid);
        assert_eq!(b.sequence, inv.sequence);
        assert_eq!(b.start, inv.start);
        assert_eq!(b.attendees.len(), 1);
        assert_eq!(b.attendees[0].email, "nam@example.com");
        assert_eq!(b.attendees[0].status, "accepted");
        assert_eq!(b.comment.as_deref(), Some("See you there"));
        assert_eq!(b.organizer.as_ref().unwrap().email, "mai@contoso.com");
        assert!(b.rrule.is_none(), "a reply never carries the rule");
    }

    #[test]
    fn hostile_common_names_are_written_as_valid_cn_parameters() {
        let names = [
            "Nam Thái (thnonline)",
            "Tran, Bao; Jr.: \"the Boss\"",
            "a=b;c:d,e",
            "Line

ATTENDEE;CN=Evil:mailto:evil@x.y",
            "Đỗ Văn \\ back",
            "  ",
        ];
        for n in names {
            let ev = IcsEvent {
                uid: "h@x".into(),
                summary: "s".into(),
                start: ts(2026, 10, 14, 3, 0),
                end: ts(2026, 10, 14, 4, 0),
                organizer: Some(Person { email: "o@x.y".into(), name: Some(n.into()) }),
                attendees: vec![Attendee { email: "a@x.y".into(), name: Some(n.into()), role: "required".into(), status: "needs-action".into(), rsvp: true }],
                status: "confirmed".into(),
                dtstamp: ts(2026, 10, 1, 0, 0),
                ..Default::default()
            };
            let text = to_ics(Some("REQUEST"), &[ev]);
            // every CN value is a quoted-string with no DQUOTE inside, and no property was injected
            for l in unfold(&text) {
                if l.starts_with("ATTENDEE") || l.starts_with("ORGANIZER") {
                    assert_eq!(l.matches('"').count() % 2, 0, "balanced quotes: {l}");
                    assert!(l.matches('"').count() <= 2, "no DQUOTE inside the value: {l}");
                }
            }
            assert_eq!(unfold(&text).iter().filter(|l| l.starts_with("ATTENDEE")).count(), 1, "no injected property for {n:?}: {text}");
            let back = parse(&text).unwrap();
            let b = &back.events[0];
            assert_eq!(b.attendees.len(), 1);
            assert_eq!(b.attendees[0].email, "a@x.y", "{n:?}");
            assert_eq!(b.organizer.as_ref().unwrap().email, "o@x.y");
            let want: String = n.replace('"', "'").chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
            let got = b.attendees[0].name.clone().unwrap_or_default();
            assert_eq!(got, want, "CN round trip for {n:?}");
        }
    }

    #[test]
    fn hostile_addresses_cannot_break_the_property() {
        let ev = IcsEvent {
            uid: "h@x".into(),
            summary: "s".into(),
            start: ts(2026, 10, 14, 3, 0),
            end: ts(2026, 10, 14, 4, 0),
            attendees: vec![Attendee { email: "a@x.y

ATTENDEE:mailto:evil@x.y".into(), name: None, role: "required".into(), status: "needs-action".into(), rsvp: true }],
            status: "confirmed".into(),
            dtstamp: ts(2026, 10, 1, 0, 0),
            ..Default::default()
        };
        let text = to_ics(Some("REQUEST"), &[ev]);
        assert_eq!(unfold(&text).iter().filter(|l| l.starts_with("ATTENDEE")).count(), 1, "{text}");
    }
}
