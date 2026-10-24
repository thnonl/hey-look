//! Editing the iCalendar text of a resource the way the server holds it (W7.4 write, D-7.4h).
//!
//! A CalDAV server keeps the text a client sent and gives it back to every other client. Rewriting an event from parsed fields would lose what this app does not know
//! (X- properties, alarms of another kind, attachments, other events of the resource), so a write starts from the server's own text: the text is read into components and
//! lines, the lines the app changes are replaced, and every other line is written back exactly as it was read, with its folding. A line the app writes is folded at
//! 75 octets (never inside a UTF-8 character).
use crate::ical;
use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::{OffsetComponents, OffsetName, Tz};

/// One content line. `raw` is the text as it was read (its physical lines, folds included); a line the app wrote has none and is folded when it is written.
#[derive(Clone, Debug, PartialEq)]
pub struct Prop {
    raw: Option<Vec<String>>,
    /// the unfolded line
    pub text: String,
}

/// Split a line at the first `:` or `;` that is not inside quotes; returns the byte index of the `:` that starts the value.
fn value_start(text: &str) -> Option<usize> {
    let mut quoted = false;
    for (i, c) in text.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some(i),
            _ => {}
        }
    }
    None
}

/// The parts of the head (`NAME;P=V;Q=W`) at the `;` outside quotes.
fn head_parts(head: &str) -> Vec<&str> {
    let mut parts = vec![];
    let mut quoted = false;
    let mut from = 0;
    for (i, c) in head.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                parts.push(&head[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&head[from..]);
    parts
}

impl Prop {
    pub fn new(text: impl Into<String>) -> Prop {
        Prop { raw: None, text: text.into() }
    }

    fn head(&self) -> &str {
        value_start(&self.text).map(|i| &self.text[..i]).unwrap_or(&self.text)
    }

    pub fn name(&self) -> String {
        head_parts(self.head())[0].trim().to_ascii_uppercase()
    }

    pub fn value(&self) -> &str {
        value_start(&self.text).map(|i| &self.text[i + 1..]).unwrap_or("")
    }

    /// The value of a parameter (without its quotes), the name compared without case.
    pub fn param(&self, name: &str) -> Option<String> {
        head_parts(self.head()).iter().skip(1).find_map(|p| {
            let (k, v) = p.split_once('=')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim().trim_matches('"').to_string())
        })
    }

    /// This line with a parameter set (added, or its value replaced); every other part stays as it was.
    pub fn with_param(&self, name: &str, value: &str) -> Prop {
        let mut parts: Vec<String> = head_parts(self.head()).iter().map(|s| s.to_string()).collect();
        let shown = if value.contains([',', ';', ':']) { format!("\"{value}\"") } else { value.to_string() };
        let new = format!("{name}={shown}");
        match parts.iter().skip(1).position(|p| p.split_once('=').is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case(name))) {
            Some(i) => parts[i + 1] = new,
            None => parts.push(new),
        }
        Prop::new(format!("{}:{}", parts.join(";"), self.value()))
    }
}

/// A component (`BEGIN:X` ... `END:X`) with its lines and nested components.
#[derive(Clone, Debug, PartialEq)]
pub struct Comp {
    begin: Prop,
    items: Vec<Item>,
    end: Prop,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    P(Prop),
    C(Comp),
}

impl Comp {
    pub fn name(&self) -> String {
        self.begin.value().trim().to_ascii_uppercase()
    }

    /// The component's own lines (not those of nested components).
    pub fn props(&self) -> impl Iterator<Item = &Prop> {
        self.items.iter().filter_map(|i| if let Item::P(p) = i { Some(p) } else { None })
    }

    pub fn prop(&self, name: &str) -> Option<&Prop> {
        self.props().find(|p| p.name() == name)
    }

    pub fn comps(&self) -> impl Iterator<Item = &Comp> {
        self.items.iter().filter_map(|i| if let Item::C(c) = i { Some(c) } else { None })
    }

    /// Replace every line named `name` with these lines (at the place of the first one; at the end of the lines, before the nested components, when there was none). An empty
    /// list removes them.
    pub fn set(&mut self, name: &str, lines: Vec<Prop>) {
        let first = self.items.iter().position(|i| matches!(i, Item::P(p) if p.name() == name));
        self.items.retain(|i| !matches!(i, Item::P(p) if p.name() == name));
        let at = first.unwrap_or_else(|| self.items.iter().position(|i| matches!(i, Item::C(_))).unwrap_or(self.items.len()));
        for (k, l) in lines.into_iter().enumerate() {
            self.items.insert(at + k, Item::P(l));
        }
    }

    pub fn remove(&mut self, name: &str) {
        self.set(name, vec![]);
    }

    /// Add a line after the other lines (before nested components).
    pub fn add(&mut self, line: Prop) {
        let at = self.items.iter().position(|i| matches!(i, Item::C(_))).unwrap_or(self.items.len());
        self.items.insert(at, Item::P(line));
    }

    /// Remove the nested components for which `drop` says so.
    pub fn drop_comps(&mut self, mut drop: impl FnMut(&Comp) -> bool) {
        self.items.retain(|i| !matches!(i, Item::C(c) if drop(c)));
    }

    pub fn add_comp(&mut self, c: Comp) {
        self.items.push(Item::C(c));
    }
}

/// A calendar document: the components and lines as they were read.
#[derive(Clone, Debug)]
pub struct Doc {
    eol: String,
    final_eol: bool,
    bom: bool,
    pub root: Comp,
}

impl Doc {
    pub fn parse(text: &str) -> Result<Doc, String> {
        let bom = text.starts_with('\u{feff}');
        let text = text.trim_start_matches('\u{feff}');
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let final_eol = text.ends_with('\n');
        let mut phys: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
        if final_eol {
            phys.pop();
        }
        let mut lines: Vec<Prop> = vec![];
        for l in phys {
            if (l.starts_with(' ') || l.starts_with('\t')) && !lines.is_empty() {
                let p = lines.last_mut().unwrap();
                p.raw.as_mut().unwrap().push(l.to_string());
                p.text.push_str(&l[1..]);
            } else {
                lines.push(Prop { raw: Some(vec![l.to_string()]), text: l.to_string() });
            }
        }
        let mut stack: Vec<Comp> = vec![];
        let mut done: Option<Comp> = None;
        for p in lines {
            match p.name().as_str() {
                "BEGIN" => stack.push(Comp { begin: p, items: vec![], end: Prop::new("") }),
                "END" => {
                    let mut c = stack.pop().ok_or("an END with no BEGIN")?;
                    if c.name() != p.value().trim().to_ascii_uppercase() {
                        return Err(format!("{} ends with END:{}", c.name(), p.value()));
                    }
                    c.end = p;
                    match stack.last_mut() {
                        Some(parent) => parent.items.push(Item::C(c)),
                        None if done.is_none() => done = Some(c),
                        None => return Err("a second calendar in one resource".into()),
                    }
                }
                _ => match stack.last_mut() {
                    Some(parent) => parent.items.push(Item::P(p)),
                    None if p.text.trim().is_empty() => {}
                    None => return Err("text outside the calendar".into()),
                },
            }
        }
        if !stack.is_empty() {
            return Err("a component is not closed".into());
        }
        let root = done.ok_or("no calendar")?;
        if root.name() != "VCALENDAR" {
            return Err("not a VCALENDAR".into());
        }
        Ok(Doc { eol: eol.to_string(), final_eol, bom, root })
    }

    fn put_prop(&self, p: &Prop, out: &mut String) {
        match &p.raw {
            Some(parts) => {
                for part in parts {
                    out.push_str(part);
                    out.push_str(&self.eol);
                }
            }
            None => {
                for part in fold(&p.text) {
                    out.push_str(&part);
                    out.push_str(&self.eol);
                }
            }
        }
    }

    fn put_comp(&self, c: &Comp, out: &mut String) {
        self.put_prop(&c.begin, out);
        for i in &c.items {
            match i {
                Item::P(p) => self.put_prop(p, out),
                Item::C(n) => self.put_comp(n, out),
            }
        }
        self.put_prop(&c.end, out);
    }

    pub fn text(&self) -> String {
        let mut out = String::new();
        if self.bom {
            out.push('\u{feff}');
        }
        self.put_comp(&self.root, &mut out);
        if !self.final_eol {
            out.truncate(out.len() - self.eol.len());
        }
        out
    }

    /// The indexes (among the calendar's items) of its VEVENTs.
    pub fn events(&self) -> Vec<usize> {
        self.root.items.iter().enumerate().filter(|(_, i)| matches!(i, Item::C(c) if c.name() == "VEVENT")).map(|(n, _)| n).collect()
    }

    pub fn event(&self, at: usize) -> &Comp {
        match &self.root.items[at] {
            Item::C(c) => c,
            Item::P(_) => unreachable!("not a component"),
        }
    }

    pub fn event_mut(&mut self, at: usize) -> &mut Comp {
        match &mut self.root.items[at] {
            Item::C(c) => c,
            Item::P(_) => unreachable!("not a component"),
        }
    }

    /// Add an event after the last one (or at the end of the calendar). Returns its index.
    pub fn push_event(&mut self, c: Comp) -> usize {
        let at = self.events().last().map(|i| i + 1).unwrap_or(self.root.items.len());
        self.root.items.insert(at, Item::C(c));
        at
    }

    /// Remove every event that replaces one occurrence of a series (RECURRENCE-ID).
    pub fn drop_overrides(&mut self) {
        self.root.items.retain(|i| !matches!(i, Item::C(c) if c.name() == "VEVENT" && c.prop("RECURRENCE-ID").is_some()));
    }

    pub fn remove_item(&mut self, at: usize) {
        self.root.items.remove(at);
    }

    /// The name a VTIMEZONE of this document has (its TZID), for each.
    pub fn zones(&self) -> Vec<String> {
        self.root.comps().filter(|c| c.name() == "VTIMEZONE").filter_map(|c| c.prop("TZID").map(|p| p.value().trim().to_string())).collect()
    }

    /// Add a VTIMEZONE (lines from `vtimezone`) before the first event.
    pub fn add_zone(&mut self, lines: Vec<String>) -> Result<(), String> {
        let zone = comp(lines)?;
        let at = self.root.items.iter().position(|i| matches!(i, Item::C(c) if c.name() == "VEVENT")).unwrap_or(self.root.items.len());
        self.root.items.insert(at, Item::C(zone));
        Ok(())
    }

    /// The event at `at` as the app's reader sees it (the document's zones come along so TZID resolves).
    pub fn read_event(&self, at: usize) -> Option<ical::IcsEvent> {
        let mut out = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
        for z in self.root.comps().filter(|c| c.name() == "VTIMEZONE") {
            self.put_comp(z, &mut out);
        }
        self.put_comp(self.event(at), &mut out);
        out.push_str("END:VCALENDAR\r\n");
        ical::parse(&out).ok()?.events.into_iter().next()
    }
}

/// A component made of these lines (a VALARM, a VTIMEZONE): written by the app, folded on output.
pub fn comp(lines: Vec<String>) -> Result<Comp, String> {
    let frag = Doc::parse(&format!("BEGIN:VCALENDAR\r\n{}\r\nEND:VCALENDAR\r\n", lines.join("\r\n")))?;
    let Some(Item::C(mut c)) = frag.root.items.into_iter().next() else { return Err("no component".into()) };
    c.begin.raw = None;
    c.end.raw = None;
    c.items.iter_mut().for_each(strip_raw);
    Ok(c)
}

fn strip_raw(i: &mut Item) {
    match i {
        Item::P(p) => p.raw = None,
        Item::C(c) => {
            c.begin.raw = None;
            c.end.raw = None;
            c.items.iter_mut().for_each(strip_raw);
        }
    }
}

// ------------------------------------------------------------------ folding

/// Fold a line at 75 octets (RFC 5545 3.1): the first physical line holds up to 75, the others a space and up to 74. A character is never split.
pub fn fold(line: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    let mut octets = 0usize;
    for c in line.chars() {
        let w = c.len_utf8();
        let limit = 75;
        if octets + w > limit {
            out.push(std::mem::take(&mut cur));
            cur.push(' ');
            octets = 1;
        }
        cur.push(c);
        octets += w;
    }
    out.push(cur);
    out
}

// ------------------------------------------------------------------ date values

/// How the date-times of an event are written.
#[derive(Clone, Debug, PartialEq)]
pub enum Zone {
    Utc,
    /// a zone by its TZID text (an IANA name, or the name the resource already uses for it)
    Named { tzid: String, tz: Tz },
}

impl Zone {
    pub fn iana(tz: Tz) -> Zone {
        Zone::Named { tzid: tz.name().to_string(), tz }
    }

    /// The zone a date line is written in: `TZID` of the line when the app can resolve it, UTC otherwise (a `Z` value, a floating one, a TZID of the resource's own making).
    pub fn of(p: &Prop) -> Zone {
        match p.param("TZID") {
            Some(name) => match ical::iana_for(&name) {
                Some(tz) => Zone::Named { tzid: name, tz },
                None => Zone::Utc,
            },
            None => Zone::Utc,
        }
    }

    /// The zone to write for a wanted zone name: the resource's own spelling when it means the same zone, else the IANA name. `UTC` and no zone are UTC.
    pub fn wanted(name: Option<&str>, existing: &Zone) -> Zone {
        let Some(name) = name.filter(|n| !n.trim().is_empty()) else { return Zone::Utc };
        match ical::iana_for(name) {
            Some(tz) if tz == chrono_tz::UTC => Zone::Utc,
            Some(tz) => match existing {
                Zone::Named { tzid, tz: have } if *have == tz => Zone::Named { tzid: tzid.clone(), tz },
                _ => Zone::iana(tz),
            },
            None => Zone::Utc,
        }
    }
}

/// A date-time line: `NAME;VALUE=DATE:20301015`, `NAME;TZID=Europe/Berlin:20301015T090000` or `NAME:20301015T070000Z`.
pub fn dt_line(name: &str, ts: i64, all_day: bool, zone: &Zone) -> String {
    let at = chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default();
    if all_day {
        return format!("{name};VALUE=DATE:{}", at.format("%Y%m%d"));
    }
    match zone {
        Zone::Utc => format!("{name}:{}", ical::fmt_utc(ts)),
        Zone::Named { tzid, tz } => format!("{name};TZID={tzid}:{}", ical::wall_in(Some(*tz), ts).format("%Y%m%dT%H%M%S")),
    }
}

/// `-PT15M` style trigger for a reminder of this many minutes before the start.
pub fn trigger(minutes: i64) -> String {
    if minutes > 0 && minutes % 1440 == 0 {
        format!("-P{}D", minutes / 1440)
    } else if minutes > 0 && minutes % 60 == 0 {
        format!("-PT{}H", minutes / 60)
    } else {
        format!("-PT{minutes}M")
    }
}

// ------------------------------------------------------------------ VTIMEZONE (D-7.4i)

fn offset_text(secs: i32) -> String {
    let sign = if secs < 0 { '-' } else { '+' };
    let a = secs.abs();
    format!("{sign}{:02}{:02}", a / 3600, (a % 3600) / 60)
}

struct Shift {
    at: i64,
    from: i32,
    to: i32,
    dst: bool,
    name: String,
}

fn offset_at(tz: Tz, ts: i64) -> (i32, bool, String) {
    let u = chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default().naive_utc();
    let o = tz.offset_from_utc_datetime(&u);
    let total = o.base_utc_offset().num_seconds() + o.dst_offset().num_seconds();
    (total as i32, o.dst_offset().num_seconds() != 0, o.abbreviation().unwrap_or("").to_string())
}

fn shifts_in(tz: Tz, year: i32) -> Vec<Shift> {
    let from = NaiveDate::from_ymd_opt(year, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let to = NaiveDate::from_ymd_opt(year + 1, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let mut out = vec![];
    let mut prev = offset_at(tz, from).0;
    let mut t = from;
    while t < to {
        let next = (t + 3600).min(to);
        let now = offset_at(tz, next).0;
        if now != prev {
            // the exact second: the first instant in (t, next] with the new offset
            let (mut lo, mut hi) = (t, next);
            while hi - lo > 1 {
                let mid = lo + (hi - lo) / 2;
                if offset_at(tz, mid).0 == prev { lo = mid } else { hi = mid }
            }
            let (to_off, dst, name) = offset_at(tz, hi);
            out.push(Shift { at: hi, from: prev, to: to_off, dst, name });
            prev = now;
        }
        t = next;
    }
    out
}

fn dim(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (NaiveDate::from_ymd_opt(ny, nm, 1).unwrap() - NaiveDate::from_ymd_opt(y, m, 1).unwrap()).num_days() as u32
}

fn byday(w: Weekday) -> &'static str {
    ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][w.num_days_from_monday() as usize]
}

/// The same rule ("the 2nd Sunday of March") in 1970, where a yearly VTIMEZONE rule starts.
fn rule_start(month: u32, wd: Weekday, nth: i32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
    let days = dim(1970, month);
    let date = if nth < 0 {
        (1..=days).rev().map(|d| NaiveDate::from_ymd_opt(1970, month, d).unwrap()).find(|d| d.weekday() == wd).unwrap()
    } else {
        (1..=days).map(|d| NaiveDate::from_ymd_opt(1970, month, d).unwrap()).filter(|d| d.weekday() == wd).nth(nth as usize - 1).unwrap()
    };
    date.and_hms_opt(h, mi, s).unwrap()
}

/// The lines of a VTIMEZONE for an IANA zone, derived from the zone's transitions in `year`: no transition = one STANDARD; two = a STANDARD and a DAYLIGHT with a yearly rule
/// ("the 2nd Sunday of March"); any other pattern = one component per transition of that year, without a rule. `None` for a name the tz database does not know.
pub fn vtimezone(name: &str, year: i32) -> Option<Vec<String>> {
    let tz = ical::iana_for(name)?;
    let shifts = shifts_in(tz, year);
    let mut l: Vec<String> = vec!["BEGIN:VTIMEZONE".into(), format!("TZID:{name}"), format!("X-LIC-LOCATION:{name}")];
    if shifts.is_empty() {
        let (off, _, abbr) = offset_at(tz, NaiveDate::from_ymd_opt(year, 1, 1)?.and_hms_opt(12, 0, 0)?.and_utc().timestamp());
        l.extend(["BEGIN:STANDARD".into(), "DTSTART:19700101T000000".into(), format!("TZOFFSETFROM:{}", offset_text(off)), format!("TZOFFSETTO:{}", offset_text(off))]);
        if !abbr.is_empty() {
            l.push(format!("TZNAME:{abbr}"));
        }
        l.push("END:STANDARD".into());
    } else {
        let yearly = shifts.len() == 2 && shifts[0].dst != shifts[1].dst;
        for s in &shifts {
            let kind = if s.dst { "DAYLIGHT" } else { "STANDARD" };
            // (the wall clock before the change, in the offset before it)
            let wall = chrono::DateTime::from_timestamp(s.at + s.from as i64, 0).unwrap_or_default().naive_utc();
            l.push(format!("BEGIN:{kind}"));
            if yearly {
                let d = wall.date();
                let last = d.day() + 7 > dim(d.year(), d.month());
                let nth = if last { -1 } else { ((d.day() - 1) / 7 + 1) as i32 };
                let start = rule_start(d.month(), d.weekday(), nth, wall.hour(), wall.minute(), wall.second());
                l.push(format!("DTSTART:{}", start.format("%Y%m%dT%H%M%S")));
                l.push(format!("RRULE:FREQ=YEARLY;BYMONTH={};BYDAY={}{}", d.month(), nth, byday(d.weekday())));
            } else {
                l.push(format!("DTSTART:{}", wall.format("%Y%m%dT%H%M%S")));
            }
            l.push(format!("TZOFFSETFROM:{}", offset_text(s.from)));
            l.push(format!("TZOFFSETTO:{}", offset_text(s.to)));
            if !s.name.is_empty() {
                l.push(format!("TZNAME:{}", s.name));
            }
            l.push(format!("END:{kind}"));
        }
    }
    l.push("END:VTIMEZONE".into());
    Some(l)
}

/// The year a VTIMEZONE is made for: the year of the event's first start.
pub fn year_of(ts: i64) -> i32 {
    Utc.timestamp_opt(ts, 0).single().map(|d| d.year()).unwrap_or(2026)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//other//EN\r\nBEGIN:VEVENT\r\nUID:abc@x\r\nDTSTAMP:20261001T080000Z\r\nDTSTART;TZID=Europe/Berlin:20261020T090000\r\nDTEND;TZID=Europe/Berlin:20261020T100000\r\nSUMMARY:A very long title that the other client folded at a column the app would not choose to fold\r\n  at, with a second line\r\nX-HL-TEST:keep\r\nATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf\r\nBEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn a_document_is_written_back_byte_for_byte() {
        for text in [SAMPLE, &SAMPLE.replace("\r\n", "\n"), &SAMPLE.trim_end().to_string(), &format!("\u{feff}{SAMPLE}")] {
            assert_eq!(Doc::parse(text).unwrap().text(), text);
        }
    }

    #[test]
    fn unclosed_or_foreign_text_is_refused() {
        assert!(Doc::parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n").is_err());
        assert!(Doc::parse("hello").is_err());
        assert!(Doc::parse("BEGIN:VCARD\r\nEND:VCARD\r\n").is_err());
        assert!(Doc::parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").is_err());
    }

    #[test]
    fn a_changed_line_leaves_every_other_line_untouched() {
        let mut d = Doc::parse(SAMPLE).unwrap();
        let ev = d.events()[0];
        d.event_mut(ev).set("LOCATION", vec![Prop::new("LOCATION:Room 1")]);
        d.event_mut(ev).set("SUMMARY", vec![Prop::new("SUMMARY:New")]);
        let out = d.text();
        // the new SUMMARY is where the old one was; LOCATION is after the other lines and before the alarms
        assert!(out.contains("SUMMARY:New\r\nX-HL-TEST:keep\r\n"));
        assert!(out.contains("ATTACH;FMTTYPE=application/pdf:https://example.org/a.pdf\r\nLOCATION:Room 1\r\nBEGIN:VALARM\r\n"));
        assert!(out.contains("X-HL-TEST:keep\r\n") && out.contains("ACTION:AUDIO\r\nTRIGGER:-PT5M\r\n"));
        // everything but those lines is the original text
        let rest = |s: &str| s.lines().filter(|l| !l.starts_with("SUMMARY") && !l.starts_with("LOCATION") && !l.starts_with("  at,") && !l.contains("very long")).collect::<Vec<_>>().join("\n");
        assert_eq!(rest(&out), rest(SAMPLE));
    }

    #[test]
    fn lines_are_folded_at_75_octets_and_never_inside_a_character() {
        let long = format!("SUMMARY:{}", "é".repeat(100));
        let parts = fold(&long);
        assert!(parts.len() > 2);
        for (i, p) in parts.iter().enumerate() {
            assert!(p.len() <= 75, "line {i} has {} octets", p.len());
            if i > 0 {
                assert!(p.starts_with(' '));
            }
        }
        let back: String = parts.iter().enumerate().map(|(i, p)| if i == 0 { p.as_str() } else { &p[1..] }).collect();
        assert_eq!(back, long);
        assert_eq!(fold("SUMMARY:short"), vec!["SUMMARY:short".to_string()]);
        // exactly 75 octets stays on one line, 76 folds
        let l75 = format!("X:{}", "a".repeat(73));
        assert_eq!(fold(&l75).len(), 1);
        assert_eq!(fold(&format!("{l75}a")).len(), 2);
        // a three-byte character at the limit moves to the next line whole
        let l = format!("X:{}{}", "a".repeat(72), "あ");
        assert_eq!(fold(&l).len(), 2);
        // the text goes through the parser of the app intact
        let mut d = Doc::parse(SAMPLE).unwrap();
        let ev = d.events()[0];
        d.event_mut(ev).set("DESCRIPTION", vec![Prop::new(format!("DESCRIPTION:{}", "ü ".repeat(80)))]);
        let ev2 = Doc::parse(&d.text()).unwrap();
        assert_eq!(ev2.read_event(ev2.events()[0]).unwrap().description.unwrap(), "ü ".repeat(80));
    }

    #[test]
    fn properties_know_their_parameters() {
        let p = Prop::new("ATTENDEE;CN=\"Doe, Jane\";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:jane@x.y");
        assert_eq!(p.name(), "ATTENDEE");
        assert_eq!(p.value(), "mailto:jane@x.y");
        assert_eq!(p.param("partstat").as_deref(), Some("NEEDS-ACTION"));
        assert_eq!(p.param("CN").as_deref(), Some("Doe, Jane"));
        let q = p.with_param("PARTSTAT", "ACCEPTED");
        assert_eq!(q.text, "ATTENDEE;CN=\"Doe, Jane\";PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:jane@x.y");
        assert_eq!(p.with_param("X-NUM", "1").text, "ATTENDEE;CN=\"Doe, Jane\";PARTSTAT=NEEDS-ACTION;RSVP=TRUE;X-NUM=1:mailto:jane@x.y");
        assert_eq!(Prop::new("DTSTART;TZID=Europe/Berlin:20261020T090000").param("TZID").as_deref(), Some("Europe/Berlin"));
    }

    #[test]
    fn date_lines_follow_the_zone() {
        let berlin = Zone::iana(chrono_tz::Europe::Berlin);
        let ts = 1_793_000_000; // 2026-10-26 ... any instant
        let l = dt_line("DTSTART", ts, false, &berlin);
        assert!(l.starts_with("DTSTART;TZID=Europe/Berlin:") && !l.ends_with('Z'), "{l}");
        assert!(dt_line("DTSTART", ts, false, &Zone::Utc).ends_with('Z'));
        assert_eq!(dt_line("DTSTART", 1_793_059_200, true, &berlin), "DTSTART;VALUE=DATE:20261027");
        assert_eq!(trigger(15), "-PT15M");
        assert_eq!(trigger(60), "-PT1H");
        assert_eq!(trigger(1440), "-P1D");
        assert_eq!(trigger(0), "-PT0M");
        // the resource's own spelling of a zone is kept
        let own = Zone::Named { tzid: "W. Europe Standard Time".into(), tz: chrono_tz::Europe::Berlin };
        assert_eq!(Zone::wanted(Some("Europe/Berlin"), &own), own);
        assert_eq!(Zone::wanted(Some("Europe/Paris"), &own), Zone::iana(chrono_tz::Europe::Paris));
        assert_eq!(Zone::wanted(Some("UTC"), &own), Zone::Utc);
        assert_eq!(Zone::wanted(None, &own), Zone::Utc);
    }

    /// The offset a generated VTIMEZONE gives a wall clock time, worked out from its own lines (STANDARD / DAYLIGHT with a yearly rule), the way a client would.
    fn offset_by_block(lines: &[String], wall: NaiveDateTime) -> i32 {
        struct Obs {
            to: i32,
            from: i32,
            month: u32,
            wd: Weekday,
            nth: i32,
            time: (u32, u32, u32),
        }
        let off = |v: &str| {
            let s = if v.starts_with('-') { -1 } else { 1 };
            s * (v[1..3].parse::<i32>().unwrap() * 3600 + v[3..5].parse::<i32>().unwrap() * 60)
        };
        let mut obs: Vec<Obs> = vec![];
        for l in lines {
            if l.starts_with("BEGIN:STANDARD") || l.starts_with("BEGIN:DAYLIGHT") {
                obs.push(Obs { to: 0, from: 0, month: 0, wd: Weekday::Mon, nth: 0, time: (0, 0, 0) });
            } else if let Some(o) = obs.last_mut() {
                if let Some(v) = l.strip_prefix("TZOFFSETTO:") {
                    o.to = off(v);
                } else if let Some(v) = l.strip_prefix("TZOFFSETFROM:") {
                    o.from = off(v);
                } else if let Some(v) = l.strip_prefix("DTSTART:") {
                    o.time = (v[9..11].parse().unwrap(), v[11..13].parse().unwrap(), v[13..15].parse().unwrap());
                    o.month = v[4..6].parse().unwrap();
                } else if let Some(v) = l.strip_prefix("RRULE:") {
                    let p = |k: &str| v.split(';').find_map(|x| x.strip_prefix(k)).unwrap().to_string();
                    o.month = p("BYMONTH=").parse().unwrap();
                    let b = p("BYDAY=");
                    let (n, d) = b.split_at(b.len() - 2);
                    o.nth = n.parse().unwrap();
                    o.wd = match d { "MO" => Weekday::Mon, "TU" => Weekday::Tue, "WE" => Weekday::Wed, "TH" => Weekday::Thu, "FR" => Weekday::Fri, "SA" => Weekday::Sat, _ => Weekday::Sun };
                }
            }
        }
        if obs.len() == 1 {
            return obs[0].to;
        }
        // the onset of every observance in the year of `wall`, as a wall clock time before the change
        let mut onsets: Vec<(NaiveDateTime, i32)> = obs
            .iter()
            .map(|o| {
                let y = wall.year();
                let days = dim(y, o.month);
                let date = if o.nth < 0 {
                    (1..=days).rev().map(|d| NaiveDate::from_ymd_opt(y, o.month, d).unwrap()).find(|d| d.weekday() == o.wd).unwrap()
                } else {
                    (1..=days).map(|d| NaiveDate::from_ymd_opt(y, o.month, d).unwrap()).filter(|d| d.weekday() == o.wd).nth(o.nth as usize - 1).unwrap()
                };
                (date.and_hms_opt(o.time.0, o.time.1, o.time.2).unwrap(), o.to)
            })
            .collect();
        onsets.sort();
        // a wall time before the first onset of the year is in the offset the last onset of the year before left
        let mut cur = onsets.last().unwrap().1;
        for (at, to) in &onsets {
            if wall >= *at {
                cur = *to;
            }
        }
        cur
    }

    #[test]
    fn generated_zones_give_the_offsets_of_the_tz_database() {
        for name in ["Europe/Berlin", "America/New_York", "Australia/Sydney", "Asia/Ho_Chi_Minh", "Pacific/Auckland", "Asia/Kolkata", "Europe/London", "America/Sao_Paulo"] {
            let tz = ical::iana_for(name).unwrap();
            let block = vtimezone(name, 2027).unwrap();
            assert_eq!(block.first().unwrap(), "BEGIN:VTIMEZONE");
            assert!(block.contains(&format!("TZID:{name}")));
            for year in 2026..=2028 {
                // twice a day over the year, away from the changes themselves
                let mut d = NaiveDate::from_ymd_opt(year, 1, 1).unwrap();
                while d.year() == year {
                    for hour in [3, 15] {
                        let wall = d.and_hms_opt(hour, 30, 0).unwrap();
                        // skip the hours around a change (the wall time is then ambiguous or does not exist)
                        let before = wall - chrono::Duration::hours(4);
                        let after = wall + chrono::Duration::hours(4);
                        let (o1, o2, o3) = (offset_at(tz, ical::instant_of(Some(tz), before)).0, offset_at(tz, ical::instant_of(Some(tz), wall)).0, offset_at(tz, ical::instant_of(Some(tz), after)).0);
                        if o1 != o2 || o2 != o3 {
                            continue;
                        }
                        assert_eq!(offset_by_block(&block, wall), o2, "{name} at {wall}");
                    }
                    d = d.succ_opt().unwrap();
                }
            }
        }
    }

    #[test]
    fn a_zone_without_daylight_saving_is_one_standard_component() {
        let b = vtimezone("Asia/Ho_Chi_Minh", 2026).unwrap();
        assert_eq!(b.iter().filter(|l| l.starts_with("BEGIN:")).count(), 2);
        assert!(b.contains(&"BEGIN:STANDARD".to_string()) && !b.iter().any(|l| l.starts_with("RRULE")));
        assert!(b.contains(&"TZOFFSETTO:+0700".to_string()));
        let ny = vtimezone("America/New_York", 2026).unwrap();
        assert!(ny.contains(&"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU".to_string()), "{ny:?}");
        assert!(ny.contains(&"RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU".to_string()));
        let berlin = vtimezone("Europe/Berlin", 2026).unwrap();
        assert!(berlin.contains(&"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU".to_string()) && berlin.contains(&"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU".to_string()), "{berlin:?}");
        assert!(vtimezone("Nowhere/Land", 2026).is_none());
    }

    #[test]
    fn a_generated_zone_is_understood_by_the_reader_of_the_app() {
        // under a name the app does not know, so only the block can explain it
        for (name, summer, winter) in [("Europe/Berlin", "20270715T090000", "20270115T090000"), ("America/New_York", "20270715T090000", "20270115T090000"), ("Australia/Sydney", "20270715T090000", "20270115T090000")] {
            let mut block = vtimezone(name, 2027).unwrap();
            block = block.into_iter().filter(|l| !l.starts_with("X-LIC")).map(|l| l.replace(&format!("TZID:{name}"), "TZID:Custom/Zone")).collect();
            let text = format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{}\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=Custom/Zone:{summer}\r\nDTEND;TZID=Custom/Zone:{summer}\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=Custom/Zone:{winter}\r\nDTEND;TZID=Custom/Zone:{winter}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", block.join("\r\n"));
            let cal = ical::parse(&text).unwrap();
            let tz = ical::iana_for(name).unwrap();
            for (e, wall) in cal.events.iter().zip([summer, winter]) {
                let n = NaiveDateTime::parse_from_str(wall, "%Y%m%dT%H%M%S").unwrap();
                assert_eq!(e.start, ical::instant_of(Some(tz), n), "{name} {wall}");
            }
        }
    }

    #[test]
    fn a_zone_can_be_added_to_a_document_before_its_events() {
        let mut d = Doc::parse(SAMPLE).unwrap();
        assert!(d.zones().is_empty());
        d.add_zone(vtimezone("Europe/Berlin", 2026).unwrap()).unwrap();
        assert_eq!(d.zones(), vec!["Europe/Berlin".to_string()]);
        let out = d.text();
        assert!(out.find("BEGIN:VTIMEZONE").unwrap() < out.find("BEGIN:VEVENT").unwrap());
        assert!(Doc::parse(&out).is_ok() && ical::parse(&out).is_ok());
        // the event's own lines are untouched
        assert!(out.contains("X-HL-TEST:keep\r\n"));
    }
}
