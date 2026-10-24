//! Writing to a CalDAV calendar (W7.4 part 2): create, change and delete events, one occurrence of a series, and the silent answer to an invitation.
//!
//! A write starts from the server's own text of the resource (D-7.4h): it is read again (GET), the lines the app changes are replaced inside the right event (`ical_raw`),
//! every other line and event stays as the server gave it, and the result goes back with `If-Match` (an existing resource) or `If-None-Match: *` (a new one). An event
//! that changed on the server since the app last saw it (a different etag) is a conflict; the engine then shows the server's version.
//!
//! A resource holds the master of a series and the events that replace single occurrences (RECURRENCE-ID), so all of them share one etag: the rows of an override
//! (`<href>#<slot>`) are written without comparing the etag the caller knows (the master's change would have made it stale), the master's are not.
use super::*;
use crate::ical_raw::{self as raw, dt_line, trigger, vtimezone, year_of, Comp, Doc, Prop, Zone};
use crate::recur;
use reqwest::Url;

// ------------------------------------------------------------------ the lines

fn text_line(name: &str, value: &str) -> Prop {
    Prop::new(format!("{name}:{}", ical::escape(value)))
}

fn attendee_prop(a: &CalAttendee) -> Prop {
    let role = match a.role.as_str() {
        "chair" => "CHAIR",
        "optional" => "OPT-PARTICIPANT",
        _ => "REQ-PARTICIPANT",
    };
    let status = match a.status.as_str() {
        "accepted" => "ACCEPTED",
        "tentative" => "TENTATIVE",
        "declined" => "DECLINED",
        "delegated" => "DELEGATED",
        _ => "NEEDS-ACTION",
    };
    Prop::new(format!("ATTENDEE{};ROLE={role};PARTSTAT={status};RSVP=TRUE:mailto:{}", ical::cn(&a.name), ical::cal_addr(&a.email)))
}

fn organizer_prop(mailbox: &str) -> Prop {
    Prop::new(format!("ORGANIZER:mailto:{}", ical::cal_addr(mailbox)))
}

fn alarm_lines(minutes: i64, title: &str) -> Vec<String> {
    let title = if title.trim().is_empty() { "Reminder" } else { title };
    vec!["BEGIN:VALARM".into(), "ACTION:DISPLAY".into(), format!("DESCRIPTION:{}", ical::escape(title)), format!("TRIGGER:{}", trigger(minutes)), "END:VALARM".into()]
}

/// The address of an ATTENDEE / ORGANIZER line, lower case.
fn address(p: &Prop) -> String {
    let v = p.value().trim();
    v.get(..7).filter(|h| h.eq_ignore_ascii_case("mailto:")).map(|_| &v[7..]).unwrap_or(v).trim().to_ascii_lowercase()
}

fn joined(lines: &[String]) -> String {
    let mut out = String::new();
    for l in lines {
        for part in raw::fold(l) {
            out.push_str(&part);
            out.push_str("\r\n");
        }
    }
    out
}

// ------------------------------------------------------------------ a new resource

/// The text of a new resource (REQ-7.4.9): VCALENDAR with the zone's VTIMEZONE (D-7.4i), one VEVENT, one DISPLAY alarm for the reminder.
pub(super) fn new_resource(d: &EventDraft, uid: &str, now: i64, mailbox: &str) -> Result<String, String> {
    let zone = if d.all_day { Zone::Utc } else { Zone::wanted(d.tzid.as_deref(), &Zone::Utc) };
    let mut l: Vec<String> = vec!["BEGIN:VCALENDAR".into(), "PRODID:-//Hey Look!//Mail//EN".into(), "VERSION:2.0".into(), "CALSCALE:GREGORIAN".into()];
    if let Zone::Named { tzid, .. } = &zone {
        l.extend(vtimezone(tzid, year_of(d.start)).ok_or("unknown time zone")?);
    }
    let stamp = ical::fmt_utc(now);
    l.extend(["BEGIN:VEVENT".into(), format!("UID:{uid}"), format!("DTSTAMP:{stamp}"), format!("CREATED:{stamp}"), format!("LAST-MODIFIED:{stamp}"), "SEQUENCE:0".into()]);
    l.push(dt_line("DTSTART", d.start, d.all_day, &zone));
    l.push(dt_line("DTEND", d.end.max(d.start), d.all_day, &zone));
    if let Some(r) = d.rrule.as_deref().map(recur::bare).filter(|r| !r.is_empty()) {
        l.push(format!("RRULE:{r}"));
        let mut ex = d.exdates.clone();
        ex.sort_unstable();
        ex.dedup();
        l.extend(ex.into_iter().map(|x| dt_line("EXDATE", x, d.all_day, &zone)));
    }
    l.push(text_line("SUMMARY", &d.summary).text);
    if let Some(v) = d.location.as_deref().filter(|v| !v.trim().is_empty()) {
        l.push(text_line("LOCATION", v).text);
    }
    if let Some(v) = d.description.as_deref().filter(|v| !v.trim().is_empty()) {
        l.push(text_line("DESCRIPTION", v).text);
    }
    if !d.attendees.is_empty() {
        l.push(organizer_prop(mailbox).text);
        l.extend(d.attendees.iter().map(|a| attendee_prop(a).text));
    }
    if let Some(m) = d.reminder_min {
        l.extend(alarm_lines(m, &d.summary));
    }
    l.extend(["END:VEVENT".into(), "END:VCALENDAR".into()]);
    let text = joined(&l);
    Doc::parse(&text)?;
    Ok(text)
}

// ------------------------------------------------------------------ changing an event of a resource

pub(super) struct Ctx<'a> {
    pub now: i64,
    pub mailbox: &'a str,
}

/// The rule without its end (UNTIL, COUNT): two rules that differ only there are a cut or an extension of one series, not another rule.
fn base_rule(rule: Option<&str>, start: i64, all_day: bool, tzid: Option<&str>) -> String {
    let Some(r) = rule.filter(|r| !r.trim().is_empty()) else { return String::new() };
    recur::signature(r, start, all_day, tzid).split(';').filter(|p| !p.starts_with("UNTIL=") && !p.starts_with("COUNT=")).collect::<Vec<_>>().join(";")
}

fn set_dates(ev: &mut Comp, name: &str, values: &[i64], all_day: bool, zone: &Zone) {
    let mut v = values.to_vec();
    v.sort_unstable();
    v.dedup();
    ev.set(name, v.into_iter().map(|x| Prop::new(dt_line(name, x, all_day, zone))).collect());
}

fn same_set(a: &[i64], b: &[i64]) -> bool {
    let (mut a, mut b) = (a.to_vec(), b.to_vec());
    a.sort_unstable();
    a.dedup();
    b.sort_unstable();
    b.dedup();
    a == b
}

/// The alarms the app manages: DISPLAY alarms with a relative trigger. Others (AUDIO, EMAIL, absolute ones) are left alone.
fn managed_alarm(c: &Comp) -> bool {
    c.name() == "VALARM"
        && c.prop("ACTION").is_some_and(|a| a.value().trim().eq_ignore_ascii_case("DISPLAY"))
        && c.prop("TRIGGER").is_some_and(|t| t.param("VALUE").is_none_or(|v| v.eq_ignore_ascii_case("DURATION")) && t.value().trim().starts_with(['-', '+', 'P']))
}

fn guests_edit(ev: &mut Comp, list: &[CalAttendee], mailbox: &str) {
    let mailbox = mailbox.trim().to_ascii_lowercase();
    let mut out: Vec<Prop> = vec![];
    let mut seen: Vec<String> = vec![];
    for p in ev.props().filter(|p| p.name() == "ATTENDEE") {
        let addr = address(p);
        let Some(want) = list.iter().find(|a| a.email.trim().to_ascii_lowercase() == addr) else { continue };
        let role = match want.role.as_str() {
            "chair" => "CHAIR",
            "optional" => "OPT-PARTICIPANT",
            _ => "REQ-PARTICIPANT",
        };
        // (an answer already given and every parameter the other client wrote stay; only a changed role is written)
        out.push(if p.param("ROLE").is_some_and(|r| r.eq_ignore_ascii_case(role)) || (p.param("ROLE").is_none() && role == "REQ-PARTICIPANT") { p.clone() } else { p.with_param("ROLE", role) });
        seen.push(addr);
    }
    for a in list {
        if !seen.contains(&a.email.trim().to_ascii_lowercase()) {
            out.push(attendee_prop(a));
        }
    }
    ev.set("ATTENDEE", out);
    let guests = list.iter().any(|a| a.role != "chair" && a.email.trim().to_ascii_lowercase() != mailbox);
    if guests && ev.prop("ORGANIZER").is_none() {
        ev.add(organizer_prop(&mailbox));
    }
    if !guests && ev.prop("ORGANIZER").is_some_and(|o| address(o) == mailbox) {
        ev.remove("ORGANIZER");
    }
}

/// Apply a patch to the event at `at` (REQ-7.4.10). Only the lines the patch names are replaced, and only when they differ from what the event has now. A series master that moves
/// in time keeps its deleted and extra dates (moved with it) and loses its changed occurrences (D-7.1b b); a new rule loses both (D-7.1b c), unless it only ends the series
/// earlier or later (a cut), which keeps the occurrences that were changed.
pub(super) fn patch_event(doc: &mut Doc, at: usize, p: &EventPatch, ctx: &Ctx) -> Result<(), String> {
    let cur = doc.read_event(at).ok_or("the event cannot be read")?;
    let have = doc.zones();
    let mut need: Vec<(String, i32)> = vec![];
    let mut drop_overrides = false;
    {
        let ev = doc.event_mut(at);
        let is_override = ev.prop("RECURRENCE-ID").is_some();
        let is_series = !is_override && (ev.prop("RRULE").is_some() || ev.prop("RDATE").is_some());
        let old_zone = ev.prop("DTSTART").map(Zone::of).unwrap_or(Zone::Utc);
        let mut zone = old_zone.clone();
        let mut all_day = cur.all_day;
        let mut sequence = false;
        let mut start = cur.start;
        if let Some(s) = &p.summary {
            if *s != cur.summary {
                ev.set("SUMMARY", vec![text_line("SUMMARY", s)]);
            }
        }
        if let Some(w) = &p.when {
            all_day = w.all_day;
            zone = if w.all_day { Zone::Utc } else { Zone::wanted(w.tzid.as_deref(), &old_zone) };
            let same = w.start == cur.start && w.end == cur.end && w.all_day == cur.all_day && (w.all_day || zone == old_zone);
            if !same {
                ev.set("DTSTART", vec![Prop::new(dt_line("DTSTART", w.start, w.all_day, &zone))]);
                ev.set("DTEND", vec![Prop::new(dt_line("DTEND", w.end.max(w.start), w.all_day, &zone))]);
                ev.remove("DURATION");
                sequence = true;
                start = w.start;
                if let Zone::Named { tzid, tz } = &zone {
                    if !have.iter().any(|z| z == tzid) && tzid == tz.name() {
                        need.push((tzid.clone(), year_of(w.start)));
                    }
                }
            }
        }
        let moved_start = start != cur.start || all_day != cur.all_day || zone != old_zone;
        let shift = |x: i64| recur::shift_slot(x, cur.start, start, all_day, cur.tzid.as_deref());
        // the dates of a series follow its start (when no recurrence is named, the ones it has now; else the ones the engine names)
        let (mut ex, mut rd) = (cur.exdates.clone(), cur.rdates.clone());
        let mut dates_changed = false;
        if is_series && moved_start {
            ex = ex.into_iter().map(shift).collect();
            rd = rd.into_iter().map(shift).collect();
            dates_changed = true;
            drop_overrides = true;
        }
        if let Some(r) = &p.recurrence {
            if !is_override {
                let old_base = base_rule(cur.rrule.as_deref(), cur.start, cur.all_day, cur.tzid.as_deref());
                let new_base = base_rule(r.rrule.as_deref(), start, all_day, if all_day { None } else { cur.tzid.as_deref().or(r.tzid.as_deref()) });
                let new_rule = r.rrule.as_deref().map(recur::bare).filter(|x| !x.is_empty());
                if new_rule != cur.rrule.as_deref().map(recur::bare) {
                    match new_rule {
                        Some(rule) => ev.set("RRULE", vec![Prop::new(format!("RRULE:{rule}"))]),
                        None => ev.remove("RRULE"),
                    }
                    sequence = true;
                }
                if old_base != new_base {
                    drop_overrides = true;
                }
                ex = if moved_start { r.exdates.iter().copied().map(shift).collect() } else { r.exdates.clone() };
                rd = if moved_start { r.rdates.iter().copied().map(shift).collect() } else { r.rdates.clone() };
                dates_changed = true;
            }
        }
        if dates_changed {
            if !same_set(&ex, &cur.exdates) || moved_start {
                set_dates(ev, "EXDATE", &ex, all_day, &zone);
            }
            if !same_set(&rd, &cur.rdates) || moved_start {
                set_dates(ev, "RDATE", &rd, all_day, &zone);
            }
        }
        if let Some(l) = &p.location {
            if *l != cur.location {
                match l {
                    Some(v) => ev.set("LOCATION", vec![text_line("LOCATION", v)]),
                    None => ev.remove("LOCATION"),
                }
            }
        }
        if let Some(d) = &p.description {
            if *d != cur.description {
                match d {
                    Some(v) => ev.set("DESCRIPTION", vec![text_line("DESCRIPTION", v)]),
                    None => ev.remove("DESCRIPTION"),
                }
            }
        }
        if let Some(list) = &p.attendees {
            guests_edit(ev, list, ctx.mailbox);
            sequence = true;
        }
        if let Some(m) = p.reminder_min {
            if m != cur.reminder_min {
                ev.drop_comps(managed_alarm);
                if let Some(minutes) = m {
                    ev.add_comp(raw::comp(alarm_lines(minutes, p.summary.as_deref().unwrap_or(&cur.summary)))?);
                }
            }
        }
        if sequence {
            let n = ev.prop("SEQUENCE").and_then(|s| s.value().trim().parse::<i64>().ok()).unwrap_or(0) + 1;
            ev.set("SEQUENCE", vec![Prop::new(format!("SEQUENCE:{n}"))]);
        }
        let stamp = ical::fmt_utc(ctx.now);
        ev.set("DTSTAMP", vec![Prop::new(format!("DTSTAMP:{stamp}"))]);
        ev.set("LAST-MODIFIED", vec![Prop::new(format!("LAST-MODIFIED:{stamp}"))]);
    }
    for (name, year) in need {
        doc.add_zone(vtimezone(&name, year).ok_or("unknown time zone")?)?;
    }
    if drop_overrides {
        doc.drop_overrides();
    }
    Ok(())
}

/// The event of a resource that stands for the whole series or the single event: the first without a RECURRENCE-ID.
pub(super) fn find_main(doc: &Doc) -> Option<usize> {
    doc.events().into_iter().find(|i| doc.event(*i).prop("RECURRENCE-ID").is_none())
}

/// The event that replaces the occurrence at `slot`.
pub(super) fn find_override(doc: &Doc, slot: i64) -> Option<usize> {
    doc.events().into_iter().find(|i| doc.event(*i).prop("RECURRENCE-ID").is_some() && doc.read_event(*i).and_then(|e| e.recurrence_id) == Some(slot))
}

/// A new event for one occurrence of the series at `main`: the master's own lines without its rule and dates, at the occurrence's time (RECURRENCE-ID in the form of the master's start).
pub(super) fn make_override(doc: &mut Doc, main: usize, slot: i64) -> Result<usize, String> {
    let cur = doc.read_event(main).ok_or("the series cannot be read")?;
    let mut o = doc.event(main).clone();
    let zone = o.prop("DTSTART").map(Zone::of).unwrap_or(Zone::Utc);
    for n in ["RRULE", "EXDATE", "RDATE", "DTSTART", "DTEND", "DURATION", "RECURRENCE-ID"] {
        o.remove(n);
    }
    o.add(Prop::new(dt_line("RECURRENCE-ID", slot, cur.all_day, &zone)));
    o.add(Prop::new(dt_line("DTSTART", slot, cur.all_day, &zone)));
    o.add(Prop::new(dt_line("DTEND", slot + (cur.end - cur.start).max(0), cur.all_day, &zone)));
    Ok(doc.push_event(o))
}

/// Delete one occurrence of a series in the resource: its override goes and the master excludes the slot (unless the series already ends before it). Returns false when there was
/// nothing to change.
pub(super) fn delete_slot(doc: &mut Doc, slot: i64, now: i64) -> Result<bool, String> {
    let mut changed = false;
    if let Some(o) = find_override(doc, slot) {
        doc.remove_item(o);
        changed = true;
    }
    if let Some(main) = find_main(doc) {
        let cur = doc.read_event(main).ok_or("the series cannot be read")?;
        let ends_before = cur.rrule.as_deref().and_then(|r| recur::part(r, "UNTIL")).is_some_and(|u| {
            let day = u.len() == 8;
            let n = chrono::NaiveDateTime::parse_from_str(&format!("{}T{}", &u[..8], if day { "235959".to_string() } else { u[9..15].to_string() }), "%Y%m%dT%H%M%S").ok();
            n.is_some_and(|n| n.and_utc().timestamp() < slot)
        });
        if (cur.rrule.is_some() || !cur.rdates.is_empty()) && !cur.exdates.contains(&slot) && !ends_before {
            let ev = doc.event_mut(main);
            let zone = ev.prop("DTSTART").map(Zone::of).unwrap_or(Zone::Utc);
            ev.add(Prop::new(dt_line("EXDATE", slot, cur.all_day, &zone)));
            let stamp = ical::fmt_utc(now);
            ev.set("DTSTAMP", vec![Prop::new(format!("DTSTAMP:{stamp}"))]);
            ev.set("LAST-MODIFIED", vec![Prop::new(format!("LAST-MODIFIED:{stamp}"))]);
            changed = true;
        }
    }
    Ok(changed)
}

// ------------------------------------------------------------------ the requests

fn norm_etag(e: &str) -> &str {
    e.trim().trim_start_matches("W/").trim_matches('"')
}

enum Cond<'a> {
    IfMatch(&'a str),
    IfNoneMatch,
}

impl CalDavProvider {
    fn split_id(&self, remote_id: &str) -> Result<(Url, Option<i64>), SyncErr> {
        let (href, slot) = match remote_id.rsplit_once('#') {
            Some((h, s)) => (h, s.parse::<i64>().ok()),
            None => (remote_id, None),
        };
        let url = Url::parse(href).map_err(|_| SyncErr::Other("an event with a bad address".into()))?;
        if !self.http.allowed(&url) {
            return Err(SyncErr::Other("the event is on a server the credentials may not go to".into()));
        }
        Ok((url, slot))
    }

    fn write_err(&self, r: &Reply) -> SyncErr {
        match r.status {
            412 => SyncErr::Conflict,
            404 | 410 => SyncErr::NotFound,
            403 if r.body.contains("need-privileges") => SyncErr::ReadOnly,
            403 => SyncErr::Other(short_reason(r, "the server didn’t allow it")),
            409 | 400 | 415 => SyncErr::Other(short_reason(r, "the server didn’t accept the event")),
            413 | 507 => SyncErr::Other(short_reason(r, "the calendar is full or the event is too large")),
            s => SyncErr::Other(format!("the calendar server answered {s}")),
        }
    }

    /// The server's current text of a resource and its etag.
    fn fetch_text(&self, url: &Url) -> Result<(String, String), SyncErr> {
        let r = self.http.request("GET", url, None, None, &[("Accept", "text/calendar")]).and_then(|r| self.http.check(r)).map_err(|e| e.sync_err())?;
        if r.status != 200 {
            return Err(self.write_err(&r));
        }
        let etag = match r.header("etag").map(String::from) {
            Some(e) => e,
            None => self.etag_now(url)?,
        };
        Ok((r.body, etag))
    }

    fn etag_now(&self, url: &Url) -> Result<String, SyncErr> {
        let r = self.http.call("PROPFIND", url, Some("0"), Some(&dav_xml::propfind(&["D:getetag"]))).map_err(|e| e.sync_err())?;
        if r.status == 404 {
            return Err(SyncErr::NotFound);
        }
        multistatus(&r).and_then(|ms| ms.responses.first().and_then(|x| x.text("D:getetag").map(String::from))).ok_or_else(|| SyncErr::Other("the server gave no version of the event".into()))
    }

    fn put_text(&self, url: &Url, text: &str, cond: Cond) -> Result<String, SyncErr> {
        let header: (&str, &str) = match cond {
            Cond::IfMatch(e) => ("If-Match", e),
            Cond::IfNoneMatch => ("If-None-Match", "*"),
        };
        let r = self.http.request_as("PUT", url, None, Some(("text/calendar; charset=utf-8", text)), &[header]).and_then(|r| self.http.check(r)).map_err(|e| e.sync_err())?;
        if !matches!(r.status, 200 | 201 | 204) {
            return Err(self.write_err(&r));
        }
        match r.header("etag").map(String::from) {
            Some(e) => Ok(e),
            None => self.etag_now(url),
        }
    }

    /// The row of the event at `slot` (None: the master or single event) of a resource as the server holds it.
    fn row_from(&self, url: &Url, etag: &str, text: &str, slot: Option<i64>) -> Result<RemoteEvent, SyncErr> {
        let mapped = map_resource(url.as_str(), etag, text, &self.me()).ok_or_else(|| SyncErr::Other("the saved event cannot be read back".into()))?;
        let want = match slot {
            Some(s) => format!("{url}#{s}"),
            None => url.to_string(),
        };
        mapped.events.into_iter().find(|e| e.id == want).ok_or_else(|| SyncErr::Other("the saved event cannot be read back".into()))
    }

    fn open(&self, text: &str) -> Result<Doc, SyncErr> {
        Doc::parse(text).map_err(|e| SyncErr::Other(format!("the copy of the event on the server can’t be edited ({e})")))
    }

    pub(super) fn write_create(&self, cal: &RemoteCalendar, ev: &EventDraft) -> Result<RemoteEvent, SyncErr> {
        let col = self.collection(cal)?;
        let now = chrono::Utc::now().timestamp();
        for attempt in 0..2 {
            let id = uuid::Uuid::new_v4().to_string();
            let url = col.join(&format!("{id}.ics")).map_err(|_| SyncErr::Other("a bad calendar address".into()))?;
            let text = new_resource(ev, &format!("{id}@heylook"), now, &self.mailbox).map_err(|e| SyncErr::Other(format!("the event cannot be written ({e})")))?;
            match self.put_text(&url, &text, Cond::IfNoneMatch) {
                Ok(etag) => return self.row_from(&url, &etag, &text, None),
                // the name is taken (a 412 on If-None-Match): once more with another
                Err(SyncErr::Conflict) if attempt == 0 => continue,
                Err(e) => return Err(e),
            }
        }
        Err(SyncErr::Conflict)
    }

    pub(super) fn write_update(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, patch: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        let _ = self.collection(cal)?;
        let (url, slot) = self.split_id(remote_id)?;
        let (text, fresh) = self.fetch_text(&url)?;
        if slot.is_none() && !etag.is_empty() && norm_etag(etag) != norm_etag(&fresh) {
            return Err(SyncErr::Conflict);
        }
        let mut doc = self.open(&text)?;
        let at = match slot {
            None => find_main(&doc),
            Some(s) => find_override(&doc, s),
        }
        .ok_or(SyncErr::NotFound)?;
        patch_event(&mut doc, at, patch, &Ctx { now: chrono::Utc::now().timestamp(), mailbox: &self.mailbox }).map_err(SyncErr::Other)?;
        let out = doc.text();
        let new_etag = self.put_text(&url, &out, Cond::IfMatch(&fresh))?;
        self.row_from(&url, &new_etag, &out, slot)
    }

    pub(super) fn write_delete(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str) -> Result<(), SyncErr> {
        let _ = self.collection(cal)?;
        let (url, slot) = self.split_id(remote_id)?;
        match slot {
            Some(s) => self.remove_slot(&url, s).map(|_| ()),
            None => {
                let cond: Vec<(&str, &str)> = if etag.is_empty() { vec![] } else { vec![("If-Match", etag)] };
                let r = self.http.request("DELETE", &url, None, None, &cond).and_then(|r| self.http.check(r)).map_err(|e| e.sync_err())?;
                match r.status {
                    200 | 202 | 204 => Ok(()),
                    _ => Err(self.write_err(&r)),
                }
            }
        }
    }

    /// Delete one occurrence in the resource (see `delete_slot`); a resource with no event left is deleted.
    fn remove_slot(&self, url: &Url, slot: i64) -> Result<bool, SyncErr> {
        let (text, fresh) = self.fetch_text(url)?;
        let mut doc = self.open(&text)?;
        let changed = delete_slot(&mut doc, slot, chrono::Utc::now().timestamp()).map_err(SyncErr::Other)?;
        if !changed {
            return Ok(false);
        }
        if doc.events().is_empty() {
            let r = self.http.request("DELETE", url, None, None, &[("If-Match", &fresh)]).and_then(|r| self.http.check(r)).map_err(|e| e.sync_err())?;
            return match r.status {
                200 | 202 | 204 => Ok(true),
                _ => Err(self.write_err(&r)),
            };
        }
        self.put_text(url, &doc.text(), Cond::IfMatch(&fresh))?;
        Ok(true)
    }

    pub(super) fn write_respond(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, status: Rsvp, me: &str, _attendees: &[CalAttendee]) -> Result<(), SyncErr> {
        let _ = self.collection(cal)?;
        let (url, slot) = self.split_id(remote_id)?;
        let (text, fresh) = self.fetch_text(&url)?;
        if slot.is_none() && !etag.is_empty() && norm_etag(etag) != norm_etag(&fresh) {
            return Err(SyncErr::Conflict);
        }
        let mut doc = self.open(&text)?;
        let at = match slot {
            None => find_main(&doc),
            Some(s) => find_override(&doc, s),
        }
        .ok_or(SyncErr::NotFound)?;
        let mut mine = self.me();
        mine.push(me.trim().to_ascii_lowercase());
        let value = match status {
            Rsvp::Accepted => "ACCEPTED",
            Rsvp::Tentative => "TENTATIVE",
            Rsvp::Declined => "DECLINED",
        };
        let ev = doc.event_mut(at);
        let lines: Vec<Prop> = ev
            .props()
            .filter(|p| p.name() == "ATTENDEE")
            .map(|p| if mine.contains(&address(p)) && !p.param("PARTSTAT").is_some_and(|s| s.eq_ignore_ascii_case(value)) { p.with_param("PARTSTAT", value) } else { p.clone() })
            .collect();
        let changed = ev.props().filter(|p| p.name() == "ATTENDEE").zip(&lines).any(|(a, b)| a != b);
        if !changed {
            return Ok(());
        }
        ev.set("ATTENDEE", lines);
        self.put_text(&url, &doc.text(), Cond::IfMatch(&fresh))?;
        Ok(())
    }

    pub(super) fn write_update_occurrence(&self, cal: &RemoteCalendar, series_id: &str, slot: i64, _all_day: bool, patch: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        let _ = self.collection(cal)?;
        let (url, _) = self.split_id(series_id)?;
        let (text, fresh) = self.fetch_text(&url)?;
        let mut doc = self.open(&text)?;
        let at = match find_override(&doc, slot) {
            Some(i) => i,
            None => {
                let main = find_main(&doc).ok_or(SyncErr::NotFound)?;
                make_override(&mut doc, main, slot).map_err(SyncErr::Other)?
            }
        };
        let patch = EventPatch { recurrence: None, ..patch.clone() };
        patch_event(&mut doc, at, &patch, &Ctx { now: chrono::Utc::now().timestamp(), mailbox: &self.mailbox }).map_err(SyncErr::Other)?;
        let out = doc.text();
        let new_etag = self.put_text(&url, &out, Cond::IfMatch(&fresh))?;
        self.row_from(&url, &new_etag, &out, Some(slot))
    }

    pub(super) fn write_delete_occurrence(&self, cal: &RemoteCalendar, series_id: &str, slot: i64, _all_day: bool) -> Result<String, SyncErr> {
        let _ = self.collection(cal)?;
        let (url, _) = self.split_id(series_id)?;
        self.remove_slot(&url, slot)?;
        Ok(format!("{url}#{slot}"))
    }

    /// Move a resource to another calendar of the server (D-7.5a): the same text and UID are put in the target (`If-None-Match: *`), then the original is deleted with its version. If the
    /// original cannot be deleted the copy is taken back, so the person never has the event twice.
    pub(super) fn write_move(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, target: &RemoteCalendar) -> Result<RemoteEvent, SyncErr> {
        let _ = self.collection(cal)?;
        let dst_col = self.collection(target)?;
        let (url, slot) = self.split_id(remote_id)?;
        if slot.is_some() {
            return Err(SyncErr::Other("a changed occurrence moves with its series".into()));
        }
        let (text, fresh) = self.fetch_text(&url)?;
        if !etag.is_empty() && norm_etag(etag) != norm_etag(&fresh) {
            return Err(SyncErr::Conflict);
        }
        let own = url.path_segments().and_then(|mut s| s.next_back()).filter(|n| !n.is_empty()).unwrap_or("event.ics").to_string();
        let mut dst = dst_col.join(&own).map_err(|_| SyncErr::Other("a bad calendar address".into()))?;
        let new_etag = match self.put_text(&dst, &text, Cond::IfNoneMatch) {
            Err(SyncErr::Conflict) => {
                // the name is taken in the target: the same text under another name
                dst = dst_col.join(&format!("{}.ics", uuid::Uuid::new_v4())).map_err(|_| SyncErr::Other("a bad calendar address".into()))?;
                self.put_text(&dst, &text, Cond::IfNoneMatch)?
            }
            other => other?,
        };
        let del = self.http.request("DELETE", &url, None, None, &[("If-Match", &fresh)]).and_then(|r| self.http.check(r)).map_err(|e| e.sync_err());
        let failed = match del {
            Ok(r) if matches!(r.status, 200 | 202 | 204 | 404) => None,
            Ok(r) => Some(self.write_err(&r)),
            Err(e) => Some(e),
        };
        if let Some(e) = failed {
            let _ = self.http.request("DELETE", &dst, None, None, &[("If-Match", &new_etag)]);
            return Err(e);
        }
        self.row_from(&dst, &new_etag, &text, None)
    }

    /// MKCALENDAR in the first calendar home (RFC 4791 5.3.1): a new collection with a name, for events.
    pub(super) fn write_create_calendar(&self, name: &str) -> Result<RemoteCalendar, SyncErr> {
        let home = self.src.homes.first().and_then(|h| Url::parse(h).ok()).ok_or_else(|| SyncErr::NotSetUp("the server told of no place for calendars".into()))?;
        if !self.http.allowed(&home) {
            return Err(SyncErr::Other("the calendars are on a server the credentials may not go to".into()));
        }
        let col = home.join(&format!("{}/", uuid::Uuid::new_v4())).map_err(|_| SyncErr::Other("a bad calendar address".into()))?;
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><C:mkcalendar xmlns:D=\"DAV:\" xmlns:C=\"urn:ietf:params:xml:ns:caldav\"><D:set><D:prop><D:displayname>{}</D:displayname><C:supported-calendar-component-set><C:comp name=\"VEVENT\"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>",
            xml_escape(name)
        );
        let r = self.http.request("MKCALENDAR", &col, None, Some(&body), &[]).and_then(|r| self.http.check(r)).map_err(|e| e.sync_err())?;
        if !matches!(r.status, 200 | 201) {
            return Err(self.write_err(&r));
        }
        Ok(RemoteCalendar { id: col.to_string(), name: name.to_string(), color: String::new(), read_only: false, primary: false, selected: true, time_zone: None, default_reminder_min: None })
    }

    pub(super) fn write_get_series(&self, cal: &RemoteCalendar, series_id: &str) -> Result<RemoteEvent, SyncErr> {
        let _ = self.collection(cal)?;
        let (url, _) = self.split_id(series_id)?;
        let (text, etag) = self.fetch_text(&url)?;
        self.row_from(&url, &etag, &text, None)
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// A short reason out of an error body (`<D:error><C:valid-calendar-data/>`), else the fallback.
fn short_reason(r: &Reply, fallback: &str) -> String {
    for (tag, text) in [
        ("valid-calendar-data", "the server didn’t accept the event data"),
        ("valid-calendar-object-resource", "the server didn’t accept the event"),
        ("no-uid-conflict", "an event with this ID already exists"),
        ("max-resource-size", "the event is too large"),
        ("supported-calendar-component", "the calendar doesn’t take events"),
    ] {
        if r.body.contains(tag) {
            return text.to_string();
        }
    }
    fallback.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calsync::{When, Recurrence};

    const NOW: i64 = 1_790_000_000;

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap().and_utc().timestamp()
    }

    fn ctx() -> Ctx<'static> {
        Ctx { now: NOW, mailbox: "me@example.org" }
    }

    fn guest(email: &str) -> CalAttendee {
        CalAttendee { email: email.into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false }
    }

    const SERVER: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nBEGIN:VEVENT\r\nUID:one@other\r\nDTSTAMP:20261001T080000Z\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nSEQUENCE:3\r\nSUMMARY:Dentist\r\nX-HL-TEST:keep\r\nATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf\r\nCATEGORIES:health\r\nBEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn patched(text: &str, p: &EventPatch) -> String {
        let mut d = Doc::parse(text).unwrap();
        let at = find_main(&d).unwrap();
        patch_event(&mut d, at, p, &ctx()).unwrap();
        d.text()
    }

    /// The text with the folding undone, for assertions about long lines.
    fn flat(text: &str) -> String {
        text.replace("\r\n ", "")
    }

    fn read(text: &str) -> Vec<ical::IcsEvent> {
        ical::parse(text).unwrap().events
    }

    #[test]
    fn a_new_resource_is_a_valid_calendar_in_the_zone_of_the_event() {
        let d = EventDraft {
            summary: "Dinner; with, friends".into(),
            start: utc(2026, 10, 20, 17, 0),
            end: utc(2026, 10, 20, 18, 30),
            tzid: Some("Europe/Berlin".into()),
            location: Some("Home".into()),
            description: Some("Bring wine\nand bread".into()),
            attendees: vec![guest("g@x.test")],
            reminder_min: Some(30),
            ..Default::default()
        };
        let raw_text = new_resource(&d, "u1@heylook", NOW, "me@example.org").unwrap();
        let text = flat(&raw_text);
        assert!(text.contains("DTSTART;TZID=Europe/Berlin:20261020T190000\r\n") && text.contains("DTEND;TZID=Europe/Berlin:20261020T203000\r\n"));
        assert!(text.contains("BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\n"));
        assert!(text.contains("ORGANIZER:mailto:me@example.org\r\n") && text.contains("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:g@x.test\r\n"), "{text:?}");
        assert!(text.contains("TRIGGER:-PT30M\r\n") && text.contains("SEQUENCE:0\r\n") && text.contains("CALSCALE:GREGORIAN\r\n"));
        assert!(raw_text.lines().all(|l| l.len() <= 75));
        let e = &read(&text)[0];
        assert_eq!((e.uid.as_str(), e.summary.as_str(), e.start, e.end), ("u1@heylook", "Dinner; with, friends", d.start, d.end));
        assert_eq!((e.location.as_deref(), e.description.as_deref(), e.reminder_min, e.tzid.as_deref()), (Some("Home"), Some("Bring wine\nand bread"), Some(30), Some("Europe/Berlin")));
        assert_eq!(e.attendees.len(), 1);
        // UTC, all day, a series with deleted dates
        let u = new_resource(&EventDraft { summary: "u".into(), start: d.start, end: d.end, ..Default::default() }, "u2@heylook", NOW, "m@x.y").unwrap();
        assert!(u.contains("DTSTART:20261020T170000Z\r\n") && !u.contains("VTIMEZONE") && !u.contains("ORGANIZER") && !u.contains("VALARM"));
        let day = new_resource(&EventDraft { summary: "d".into(), all_day: true, start: utc(2026, 10, 20, 0, 0), end: utc(2026, 10, 21, 0, 0), ..Default::default() }, "u3@heylook", NOW, "m@x.y").unwrap();
        assert!(day.contains("DTSTART;VALUE=DATE:20261020\r\n") && day.contains("DTEND;VALUE=DATE:20261021\r\n"));
        let series = new_resource(
            &EventDraft { summary: "s".into(), start: d.start, end: d.end, tzid: Some("Europe/Berlin".into()), rrule: Some("FREQ=WEEKLY;BYDAY=TU".into()), exdates: vec![utc(2026, 10, 27, 16, 0)], ..Default::default() },
            "u4@heylook",
            NOW,
            "m@x.y",
        )
        .unwrap();
        assert!(series.contains("RRULE:FREQ=WEEKLY;BYDAY=TU\r\n") && series.contains("EXDATE;TZID=Europe/Berlin:20261027T170000\r\n"));
        assert_eq!(read(&series)[0].exdates, vec![utc(2026, 10, 27, 16, 0)]);
    }

    #[test]
    fn a_patch_replaces_only_the_lines_it_names() {
        let p = EventPatch { summary: Some("Dentist (moved)".into()), location: Some(Some("Clinic".into())), ..Default::default() };
        let out = patched(SERVER, &p);
        // what the other client wrote stays, byte for byte
        for keep in ["X-HL-TEST:keep\r\n", "ATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf\r\n", "CATEGORIES:health\r\n", "BEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\n", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n", "PRODID:-//Other//EN\r\n", "DTSTART:20261020T090000Z\r\n"] {
            assert!(out.contains(keep), "lost {keep}");
        }
        assert!(out.contains("SUMMARY:Dentist (moved)\r\n") && out.contains("LOCATION:Clinic\r\n"));
        // a text change does not touch the sequence; the stamps are new
        assert!(out.contains("SEQUENCE:3\r\n") && out.contains(&format!("DTSTAMP:{}\r\n", ical::fmt_utc(NOW))) && out.contains("LAST-MODIFIED:"));
        // a patch that changes nothing leaves the text as it was (apart from the stamps)
        let same = patched(SERVER, &EventPatch { summary: Some("Dentist".into()), reminder_min: Some(Some(15)), ..Default::default() });
        assert_eq!(same.replace(&format!("DTSTAMP:{}\r\n", ical::fmt_utc(NOW)), "DTSTAMP:20261001T080000Z\r\n").replace(&format!("LAST-MODIFIED:{}\r\n", ical::fmt_utc(NOW)), ""), SERVER);
    }

    #[test]
    fn a_time_change_adds_the_sequence_and_a_zone() {
        let p = EventPatch { when: Some(When { start: utc(2026, 10, 20, 12, 0), end: utc(2026, 10, 20, 13, 0), all_day: false, tzid: Some("Europe/Berlin".into()) }), ..Default::default() };
        let out = patched(SERVER, &p);
        assert!(out.contains("SEQUENCE:4\r\n"));
        assert!(out.contains("DTSTART;TZID=Europe/Berlin:20261020T140000\r\n") && out.contains("DTEND;TZID=Europe/Berlin:20261020T150000\r\n"));
        assert!(out.contains("BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\n") && out.find("VTIMEZONE").unwrap() < out.find("BEGIN:VEVENT").unwrap());
        assert_eq!(read(&out)[0].start, utc(2026, 10, 20, 12, 0));
        // a duration is replaced by an end
        let dur = SERVER.replace("DTEND:20261020T100000Z\r\n", "DURATION:PT1H\r\n");
        let out = patched(&dur, &EventPatch { when: Some(When { start: utc(2026, 10, 20, 9, 0), end: utc(2026, 10, 20, 11, 0), all_day: false, tzid: None }), ..Default::default() });
        assert!(!out.contains("DURATION") && out.contains("DTEND:20261020T110000Z\r\n"));
        // the resource's own name for the zone is kept
        let own = SERVER.replace("DTSTART:20261020T090000Z", "DTSTART;TZID=W. Europe Standard Time:20261020T110000").replace("DTEND:20261020T100000Z", "DTEND;TZID=W. Europe Standard Time:20261020T120000");
        let out = patched(&own, &EventPatch { when: Some(When { start: utc(2026, 10, 20, 10, 0), end: utc(2026, 10, 20, 11, 0), all_day: false, tzid: Some("Europe/Berlin".into()) }), ..Default::default() });
        assert!(out.contains("DTSTART;TZID=W. Europe Standard Time:20261020T120000\r\n") && !out.contains("VTIMEZONE"), "{out}");
    }

    #[test]
    fn guests_reminders_and_the_organizer() {
        let out = flat(&patched(SERVER, &EventPatch { attendees: Some(vec![guest("a@x.test"), guest("b@x.test")]), ..Default::default() }));
        assert!(out.contains("ORGANIZER:mailto:me@example.org\r\n") && out.contains("mailto:a@x.test\r\n") && out.contains("mailto:b@x.test\r\n") && out.contains("SEQUENCE:4\r\n"), "{out:?}");
        // a guest who stays keeps the line the server has (an answer already given); one who goes is removed
        let answered = out.replace("mailto:a@x.test", "mailto:a@x.test").replace("PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:a@x.test", "PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:a@x.test");
        let out2 = flat(&patched(&answered, &EventPatch { attendees: Some(vec![guest("a@x.test")]), ..Default::default() }));
        assert!(out2.contains("PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:a@x.test") && !out2.contains("b@x.test"));
        // no guests left: the organizer line of this mailbox goes
        let out3 = flat(&patched(&out2, &EventPatch { attendees: Some(vec![]), ..Default::default() }));
        assert!(!out3.contains("ATTENDEE") && !out3.contains("ORGANIZER"));
        // the reminder: the display alarm is replaced, the audio alarm stays; none removes only the display one
        let r = patched(SERVER, &EventPatch { reminder_min: Some(Some(60)), ..Default::default() });
        assert!(r.contains("TRIGGER:-PT1H\r\n") && !r.contains("TRIGGER:-PT15M") && r.contains("ACTION:AUDIO\r\nTRIGGER:-PT5M\r\n"));
        let r = patched(SERVER, &EventPatch { reminder_min: Some(None), ..Default::default() });
        assert!(!r.contains("ACTION:DISPLAY") && r.contains("ACTION:AUDIO"));
        assert_eq!(read(&r)[0].reminder_min, None);
    }

    const SERIES: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:ser@other\r\nDTSTAMP:20261001T080000Z\r\nDTSTART;TZID=Europe/Berlin:20261013T090000\r\nDTEND;TZID=Europe/Berlin:20261013T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8\r\nEXDATE;TZID=Europe/Berlin:20261027T090000\r\nSUMMARY:Weekly\r\nX-HL-TEST:keep\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:ser@other\r\nDTSTAMP:20261001T080000Z\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261103T090000\r\nDTSTART;TZID=Europe/Berlin:20261103T110000\r\nDTEND;TZID=Europe/Berlin:20261103T120000\r\nSUMMARY:Weekly (late)\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    // 2026-10-20 07:00 UTC = 09:00 Berlin (summer time); 2026-11-03 08:00 UTC = 09:00 (winter time)
    fn slot(m: u32, d: u32) -> i64 {
        if m == 10 && d < 25 { utc(2026, m, d, 7, 0) } else if m == 10 { utc(2026, m, d, 8, 0) } else { utc(2026, m, d, 8, 0) }
    }

    #[test]
    fn the_events_of_a_series_are_found_by_their_slot() {
        let d = Doc::parse(SERIES).unwrap();
        assert_eq!(find_main(&d), Some(d.events()[0]));
        assert_eq!(find_override(&d, slot(11, 3)), Some(d.events()[1]));
        assert_eq!(find_override(&d, slot(11, 10)), None);
    }

    #[test]
    fn one_occurrence_becomes_an_event_of_its_own() {
        let mut d = Doc::parse(SERIES).unwrap();
        let main = find_main(&d).unwrap();
        let at = make_override(&mut d, main, slot(10, 20)).unwrap();
        patch_event(&mut d, at, &EventPatch { summary: Some("Weekly (moved)".into()), when: Some(When { start: slot(10, 20) + 7200, end: slot(10, 20) + 10800, all_day: false, tzid: Some("Europe/Berlin".into()) }), ..Default::default() }, &ctx()).unwrap();
        let out = d.text();
        assert!(out.contains("RECURRENCE-ID;TZID=Europe/Berlin:20261020T090000\r\n"));
        assert!(out.contains("DTSTART;TZID=Europe/Berlin:20261020T110000\r\n") && out.contains("SUMMARY:Weekly (moved)\r\n"));
        let evs = read(&out);
        assert_eq!(evs.len(), 3);
        let o = evs.iter().find(|e| e.recurrence_id == Some(slot(10, 20))).unwrap();
        assert_eq!((o.start, o.end, o.rrule.as_deref(), o.exdates.len()), (slot(10, 20) + 7200, slot(10, 20) + 10800, None, 0));
        // the master did not change; the other override did not either
        assert!(out.contains("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8\r\nEXDATE;TZID=Europe/Berlin:20261027T090000\r\nSUMMARY:Weekly\r\nX-HL-TEST:keep\r\n"));
        assert!(out.contains("SUMMARY:Weekly (late)\r\n"));
    }

    #[test]
    fn a_deleted_occurrence_is_an_exdate_and_its_override_goes() {
        let mut d = Doc::parse(SERIES).unwrap();
        assert!(delete_slot(&mut d, slot(11, 3), NOW).unwrap());
        let out = d.text();
        assert!(!out.contains("Weekly (late)") && out.contains("EXDATE;TZID=Europe/Berlin:20261103T090000\r\n"));
        assert_eq!(read(&out)[0].exdates, vec![slot(10, 27), slot(11, 3)]);
        // asking again changes nothing
        assert!(!delete_slot(&mut d, slot(11, 3), NOW).unwrap());
        // a slot behind the end of the series needs no exclusion
        let cut = SERIES.replace("COUNT=8", "UNTIL=20261031T225959Z");
        let mut c = Doc::parse(&cut).unwrap();
        assert!(!delete_slot(&mut c, slot(11, 10), NOW).unwrap());
    }

    #[test]
    fn a_cut_keeps_the_changed_occurrences_a_new_rule_and_a_new_time_reset_them() {
        let cut = |rule: &str| EventPatch { recurrence: Some(Recurrence { rrule: Some(rule.into()), exdates: vec![slot(10, 27)], rdates: vec![], start: slot(10, 13), all_day: false, tzid: Some("Europe/Berlin".into()) }), ..Default::default() };
        let out = patched(SERIES, &cut("FREQ=WEEKLY;BYDAY=TU;UNTIL=20261102T225959Z"));
        assert!(out.contains("RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261102T225959Z\r\n") && out.contains("RECURRENCE-ID") && out.contains("SEQUENCE:1\r\n"));
        let out = patched(SERIES, &cut("FREQ=DAILY;COUNT=8"));
        assert!(!out.contains("RECURRENCE-ID") && out.contains("RRULE:FREQ=DAILY;COUNT=8\r\n"));
        // the deleted dates are what the engine names
        let none = EventPatch { recurrence: Some(Recurrence { rrule: Some("FREQ=DAILY;COUNT=8".into()), exdates: vec![], rdates: vec![], start: slot(10, 13), all_day: false, tzid: Some("Europe/Berlin".into()) }), ..Default::default() };
        assert!(!patched(SERIES, &none).contains("EXDATE"));
        // the whole series one hour later: the deleted date moves with it, the changed occurrence is reset
        let later = EventPatch { when: Some(When { start: utc(2026, 10, 13, 8, 0), end: utc(2026, 10, 13, 9, 0), all_day: false, tzid: Some("Europe/Berlin".into()) }), ..Default::default() };
        let out = patched(SERIES, &later);
        assert!(out.contains("DTSTART;TZID=Europe/Berlin:20261013T100000\r\n") && out.contains("EXDATE;TZID=Europe/Berlin:20261027T100000\r\n") && !out.contains("RECURRENCE-ID"), "{out}");
        assert!(out.contains("X-HL-TEST:keep"));
    }

    #[test]
    fn the_resource_text_is_edited_not_regenerated() {
        // an unreadable copy is refused, not rewritten
        assert!(Doc::parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n").is_err());
        assert_eq!(address(&Prop::new("ATTENDEE;CN=\"A, B\":MAILTO:Jane@X.Y")), "jane@x.y");
        assert_eq!(norm_etag("W/\"abc\""), "abc");
        assert_eq!(norm_etag("\"abc\""), norm_etag("abc"));
    }
}
