//! The parts of a series in My events (W7.1): change or delete one occurrence, this and the following ones, or the whole series.
//!
//! Data model (the same one invitations use): the series is the row with the rule (`recurrence_id` empty); an occurrence that was changed is a row of the
//! same `uid` whose `recurrence_id` is its *slot* (the original start), with no rule, and the series lists that slot in its `exdates` so the rule does not
//! show it a second time; an occurrence that was deleted is only a slot in `exdates`. A slot is worked out in the zone of the series (`recur.rs`).
//!
//! The functions here change the database and say which mails the organizer sends (`calendar::Mail`); sending is the caller's.
use crate::calendar::{self, CalAttendee, CalEvent, CalEventDetail, CalEventInput, Mail, LOCAL};
use crate::db::{self, err, Account, R};
use crate::recur;
use rusqlite::{params, Connection};

/// Which part of a series a change is for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    Occurrence,
    Following,
    Series,
}

impl Scope {
    pub fn parse(s: Option<&str>) -> R<Option<Scope>> {
        match s.map(str::trim).filter(|x| !x.is_empty()) {
            None => Ok(None),
            Some("occurrence") => Ok(Some(Scope::Occurrence)),
            Some("following") => Ok(Some(Scope::Following)),
            Some("series") => Ok(Some(Scope::Series)),
            Some(other) => Err(format!("CAL_BAD_SCOPE: Unknown part of a series: {other}.")),
        }
    }
}

pub(crate) fn bad_scope() -> String {
    "CAL_BAD_SCOPE: This part of the series can’t be chosen.".to_string()
}

fn not_found() -> String {
    "CAL_EVENT_NOT_FOUND: event not found".to_string()
}

/// The pieces a scoped call works on.
#[derive(Clone, Debug)]
pub struct Parts {
    /// the row with the rule
    pub series: CalEvent,
    /// the row of the slot's changed occurrence, if there is one
    pub changed: Option<CalEvent>,
    /// the slot the call is about
    pub slot: Option<i64>,
}

/// Find the series of the event with `id`: the id of the series row (then `occurrence_start` names the slot), or of a changed occurrence (then its own slot).
pub fn resolve(c: &Connection, id: &str, occurrence_start: Option<i64>) -> R<Parts> {
    let row = calendar::get_event(c, id)?;
    if !row.recurrence_id.is_empty() {
        let slot = row.recurrence_id.parse::<i64>().ok();
        let series = calendar::find(c, &row.calendar_id, &row.uid, "").ok_or_else(not_found)?;
        return Ok(Parts { series, changed: Some(row), slot });
    }
    let changed = occurrence_start.and_then(|s| calendar::find(c, &row.calendar_id, &row.uid, &s.to_string()));
    Ok(Parts { series: row, changed, slot: occurrence_start })
}

/// The occurrence at `slot` of a series as an event (before anybody changed it): the series' values with the slot's time.
pub fn instance_of(series: &CalEvent, slot: i64) -> CalEvent {
    let mut e = series.clone();
    e.start = slot;
    e.end = slot + (series.end - series.start).max(0);
    e.instance_start = Some(slot);
    e.exdates = vec![];
    e.rdates = vec![];
    e.has_rdates = false;
    e.derive()
}

fn changed_rows(c: &Connection, series: &CalEvent) -> R<Vec<CalEvent>> {
    let mut st = c
        .prepare(&format!("SELECT {} FROM events WHERE calendar_id=?1 AND uid=?2 AND recurrence_id<>'' ORDER BY starts_at", calendar::COLS))
        .map_err(err)?;
    let rows = st.query_map(params![series.calendar_id, series.uid], calendar::row_event).map_err(err)?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

fn slot_of(e: &CalEvent) -> i64 {
    e.recurrence_id.parse::<i64>().unwrap_or(0)
}

fn resave(c: &Connection, e: &mut CalEvent) -> R<()> {
    e.recurrence_text = e.rrule.as_deref().and_then(|r| crate::ical::describe_rrule(r, e.start));
    e.has_rdates = !e.rdates.is_empty();
    calendar::save_row(c, e)
}

fn require_local(series: &CalEvent) -> R<()> {
    if series.calendar_id != LOCAL {
        return Err("CAL_NOT_YOURS: This invitation was sent by someone else, so it can't be edited here.".into());
    }
    Ok(())
}

// ------------------------------------------------------------------ reading for the form

/// The values the form edits for a scope: the occurrence's own (from its changed row when it has one), the occurrence's with the rule of the series,
/// or the series itself. `changed_count` is how many changed occurrences the save would reset.
pub fn get(c: &Connection, id: &str, scope: Scope, occurrence_start: Option<i64>) -> R<CalEventDetail> {
    let p = resolve(c, id, occurrence_start)?;
    let all = changed_rows(c, &p.series)?;
    let (event, changed_count) = match scope {
        Scope::Series => (p.series.clone(), all.len() as i64),
        Scope::Occurrence | Scope::Following => {
            let slot = p.slot.ok_or_else(bad_scope)?;
            let mut e = p.changed.clone().unwrap_or_else(|| instance_of(&p.series, slot));
            if scope == Scope::Following {
                e.rrule = p.series.rrule.clone();
                e.recurrence_text = p.series.recurrence_text.clone();
            }
            e.instance_start = Some(slot);
            let n = if scope == Scope::Following { all.iter().filter(|o| slot_of(o) >= slot).count() as i64 } else { 0 };
            (e.derive(), n)
        }
    };
    Ok(CalEventDetail { event, changed_count, pattern_unsupported: false })
}

// ------------------------------------------------------------------ saving

/// What a save did: the event the form shows next, and the mails to send.
#[derive(Debug)]
pub struct Saved {
    pub event: CalEvent,
    pub mails: Vec<Mail>,
}

fn account_and_guests<'a>(c: &Connection, inp: &'a CalEventInput) -> R<(Option<Account>, Vec<&'a CalAttendee>)> {
    let guests: Vec<&CalAttendee> = inp.attendees.iter().filter(|a| a.role != "chair").collect();
    let acc = match inp.account_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(db::get_account(c, id)?),
        None => None,
    };
    if !guests.is_empty() && acc.is_none() {
        return Err("CAL_NO_ACCOUNT: Choose the account to send the invitation from.".into());
    }
    Ok((acc, guests))
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn title_of(inp: &CalEventInput) -> String {
    if inp.summary.trim().is_empty() { "(No title)".into() } else { inp.summary.trim().to_string() }
}

/// The guests of an event as (address, role), without the chair, sorted: for telling whether the list changed.
fn guest_key(list: &[CalAttendee]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = list.iter().filter(|a| a.role != "chair").map(|a| (a.email.trim().to_ascii_lowercase(), if a.role == "optional" { "optional".into() } else { "required".into() })).collect();
    v.sort();
    v
}

fn input_guest_key(guests: &[&CalAttendee]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = guests.iter().map(|a| (a.email.trim().to_ascii_lowercase(), if a.role == "optional" { "optional".into() } else { "required".into() })).collect();
    v.sort();
    v.dedup();
    v
}

/// The zone a series keeps: its own, unless it became an all-day series.
fn series_zone(series: &CalEvent, all_day: bool) -> Option<String> {
    if all_day { None } else { series.tzid.clone() }
}

fn mail(acc: &Account, events: Vec<CalEvent>, method: &'static str) -> Mail {
    Mail { account: acc.clone(), events, method }
}

fn account_of(c: &Connection, e: &CalEvent) -> Option<Account> {
    e.account_id.as_deref().and_then(|id| db::get_account(c, id).ok())
}

/// A new row built from the form, for an occurrence or for the part of a series that starts at a slot. The caller fills `uid`, `recurrence_id`, the rule and the dates.
fn from_input(inp: &CalEventInput, series: &CalEvent, acc: &Option<Account>, attendees: Vec<CalAttendee>) -> CalEvent {
    let has_att = attendees.len() > 1;
    CalEvent {
        id: uuid::Uuid::new_v4().to_string(),
        uid: series.uid.clone(),
        calendar_id: series.calendar_id.clone(),
        account_id: acc.as_ref().map(|a| a.id.clone()).or_else(|| series.account_id.clone()),
        summary: title_of(inp),
        start: inp.start,
        end: inp.end,
        all_day: inp.all_day,
        tzid: series_zone(series, inp.all_day),
        location: clean(&inp.location),
        join_url: None,
        description: inp.description.clone().filter(|s| !s.trim().is_empty()),
        organizer: if has_att { acc.as_ref().map(|a| calendar::CalPerson { email: a.email.to_ascii_lowercase(), name: Some(calendar::display_name(a)) }) } else { None },
        attendees: if has_att { attendees } else { vec![] },
        rrule: None,
        recurrence_text: None,
        status: "confirmed".into(),
        my_status: if has_att { Some("organizer".into()) } else { None },
        responded_at: None,
        reminder_min: inp.reminder_min,
        source_message_id: None,
        sequence: 0,
        confidential: false,
        instance_start: None,
        read_only: None,
        remote_id: None,
        etag: None,
        series_id: None,
        remote_kind: None,
        recurrence_id: String::new(),
        exdates: vec![],
        rdates: vec![],
        has_rdates: false,
        prev: None,
        series: false,
        occurrence_start: None,
        changed_occurrence: false,
    }
}

/// Save one scope of a series of My events. `inp.id` is the series row or one of its changed occurrences, `inp.occurrence_start` the slot (not needed for the
/// whole series).
pub fn save(c: &Connection, inp: &CalEventInput, scope: Scope) -> R<Saved> {
    if inp.end < inp.start {
        return Err("CAL_BAD_TIME: End must be after start.".into());
    }
    let id = inp.id.as_deref().ok_or_else(bad_scope)?;
    let p = resolve(c, id, inp.occurrence_start)?;
    require_local(&p.series)?;
    match scope {
        Scope::Occurrence => save_occurrence(c, inp, p),
        // the first occurrence of a series is the whole series
        Scope::Following if p.slot.is_none_or(|s| s <= p.series.start) => save_series(c, inp, p),
        Scope::Following => save_following(c, inp, p),
        Scope::Series => save_series(c, inp, p),
    }
}

fn save_occurrence(c: &Connection, inp: &CalEventInput, p: Parts) -> R<Saved> {
    let series = &p.series;
    let slot = p.slot.ok_or_else(bad_scope)?;
    let (acc, guests) = account_and_guests(c, inp)?;
    let base = p.changed.clone().unwrap_or_else(|| instance_of(series, slot));
    let same = base.summary == title_of(inp)
        && base.start == inp.start
        && base.end == inp.end
        && base.all_day == inp.all_day
        && base.location == clean(&inp.location)
        && base.description == inp.description.clone().filter(|s| !s.trim().is_empty())
        && base.reminder_min == inp.reminder_min
        && guest_key(&base.attendees) == input_guest_key(&guests);
    if same {
        return Ok(Saved { event: base, mails: vec![] });
    }
    let keep = base.clone();
    let same_time = base.start == inp.start && base.end == inp.end;
    let attendees = match (&acc, guests.is_empty()) {
        (Some(a), false) => calendar::organized(a, &guests, Some(&keep).filter(|_| same_time)),
        _ => vec![],
    };
    let mut o = from_input(inp, series, &acc, attendees);
    o.id = p.changed.as_ref().map(|x| x.id.clone()).unwrap_or(o.id);
    o.recurrence_id = slot.to_string();
    o.sequence = base.sequence.max(series.sequence) + if o.attendees.len() > 1 { 1 } else { 0 };
    o.join_url = crate::ical::join_url(&calendar::to_ics_event(&o));
    let tx = c.unchecked_transaction().map_err(err)?;
    calendar::save_row(&tx, &o)?;
    // the slot is shown by the changed row now, not by the rule
    let mut s = series.clone();
    if !s.exdates.contains(&slot) {
        s.exdates.push(slot);
        s.exdates.sort_unstable();
        resave(&tx, &mut s)?;
    }
    tx.commit().map_err(err)?;
    let mut mails = vec![];
    if let (Some(a), true) = (&acc, o.attendees.len() > 1) {
        mails.push(mail(a, vec![o.clone()], "REQUEST"));
    }
    Ok(Saved { event: o.derive(), mails })
}

fn save_following(c: &Connection, inp: &CalEventInput, p: Parts) -> R<Saved> {
    let s = &p.series;
    let slot = p.slot.ok_or_else(bad_scope)?;
    let (acc, guests) = account_and_guests(c, inp)?;
    let zone = series_zone(s, inp.all_day);
    let zone_ref = zone.as_deref();
    let dur = (s.end - s.start).max(0);
    // does the form change the time of day / length, or the rule? (the rule is worked out against the start it belongs to)
    let time_changed = inp.all_day != s.all_day || inp.start != slot || inp.end != slot + dur;
    let rule_changed = !recur::same_rule(s.rrule.as_deref(), s.start, inp.rrule.as_deref(), inp.start, inp.all_day, zone_ref);
    let (old_rule, split_new) = match s.rrule.as_deref().filter(|r| !r.trim().is_empty()) {
        Some(r) => {
            let sp = recur::split(r, s.start, s.all_day, s.tzid.as_deref(), slot).ok_or_else(bad_scope)?;
            (Some(sp.old), Some(sp.new))
        }
        None => (None, None),
    };
    let new_rule = if rule_changed { inp.rrule.as_deref().map(|r| recur::bare(r).to_string()).filter(|r| !r.is_empty()) } else { split_new };
    let rows = changed_rows(c, s)?;
    let from_here = |o: &&CalEvent| slot_of(o) >= slot;
    // the answers already given stay while the occurrence keeps its time
    let attendees = match (&acc, guests.is_empty()) {
        (Some(a), false) => calendar::organized(a, &guests, Some(s).filter(|_| !time_changed)),
        _ => vec![],
    };
    let mut n = from_input(inp, s, &acc, attendees);
    n.uid = format!("{}@heylook", uuid::Uuid::new_v4());
    n.rrule = new_rule;
    // deleted slots of the new part follow the move of its start (unless the rule changed: then the person starts again)
    let kept_rows: Vec<&CalEvent> = rows.iter().filter(from_here).collect();
    let changed_slots: Vec<i64> = kept_rows.iter().map(|o| slot_of(o)).collect();
    let moved = |x: i64| recur::shift_slot(x, slot, inp.start, s.all_day, s.tzid.as_deref());
    if !rule_changed {
        n.exdates = s.exdates.iter().copied().filter(|e| *e >= slot && !changed_slots.contains(e)).map(moved).collect();
    }
    n.rdates = s.rdates.iter().copied().filter(|r| *r >= slot).map(moved).collect();
    let carry = !time_changed && !rule_changed;
    let tx = c.unchecked_transaction().map_err(err)?;
    // changed occurrences from the slot on move to the new series when nothing about time and rule changed; otherwise they are reset
    for o in &kept_rows {
        if carry {
            let mut o2 = (*o).clone();
            o2.uid = n.uid.clone();
            apply_series_edit(&mut o2, s, inp, &acc, &guests);
            calendar::save_row(&tx, &o2)?;
            n.exdates.push(slot_of(o));
        } else {
            tx.execute("DELETE FROM events WHERE id=?1", [&o.id]).map_err(err)?;
        }
    }
    n.exdates.sort_unstable();
    n.exdates.dedup();
    n.sequence = 0;
    n.join_url = crate::ical::join_url(&calendar::to_ics_event(&n));
    resave(&tx, &mut n)?;
    // the old series ends before the slot
    let mut old = s.clone();
    old.rrule = old_rule;
    old.exdates.retain(|e| *e < slot);
    old.rdates.retain(|r| *r < slot);
    let old_has_guests = old.attendees.len() > 1;
    old.sequence += if old_has_guests { 1 } else { 0 };
    resave(&tx, &mut old)?;
    tx.commit().map_err(err)?;
    let mut mails = vec![];
    let sender = acc.clone().or_else(|| account_of(c, s));
    if let Some(a) = &sender {
        if old_has_guests && s.calendar_id == LOCAL {
            let mut ev = vec![old.clone()];
            ev.extend(rows.iter().filter(|o| slot_of(o) < slot).cloned());
            mails.push(mail(a, ev, "REQUEST"));
        }
        if n.attendees.len() > 1 {
            let carried: Vec<CalEvent> = if carry { calendar_rows(c, &n)? } else { vec![] };
            let mut ev = vec![n.clone()];
            ev.extend(carried);
            mails.push(mail(a, ev, "REQUEST"));
        }
    }
    Ok(Saved { event: n.derive(), mails })
}

fn calendar_rows(c: &Connection, series: &CalEvent) -> R<Vec<CalEvent>> {
    changed_rows(c, series)
}

/// Rule (a) of D-7.1b for one changed occurrence: a field that still has the old value of the series takes the new one; a field the person changed
/// for this occurrence stays.
fn apply_series_edit(o: &mut CalEvent, old: &CalEvent, inp: &CalEventInput, acc: &Option<Account>, guests: &[&CalAttendee]) {
    if o.summary == old.summary {
        o.summary = title_of(inp);
    }
    if o.location == old.location {
        o.location = clean(&inp.location);
    }
    if o.description == old.description {
        o.description = inp.description.clone().filter(|s| !s.trim().is_empty());
    }
    if o.reminder_min == old.reminder_min {
        o.reminder_min = inp.reminder_min;
    }
    if guest_key(&o.attendees) == guest_key(&old.attendees) {
        let new = match (acc, guests.is_empty()) {
            (Some(a), false) => calendar::organized(a, guests, Some(o)),
            _ => vec![],
        };
        let has = new.len() > 1;
        o.organizer = if has { acc.as_ref().map(|a| calendar::CalPerson { email: a.email.to_ascii_lowercase(), name: Some(calendar::display_name(a)) }) } else { None };
        o.my_status = if has { Some("organizer".into()) } else { None };
        o.attendees = if has { new } else { vec![] };
    }
    if o.attendees.len() > 1 {
        o.sequence += 1;
    }
}

fn save_series(c: &Connection, inp: &CalEventInput, p: Parts) -> R<Saved> {
    let s = &p.series;
    let (acc, guests) = account_and_guests(c, inp)?;
    let zone = series_zone(s, inp.all_day);
    let time_changed = inp.start != s.start || inp.end != s.end || inp.all_day != s.all_day;
    let rule_changed = !recur::same_rule(s.rrule.as_deref(), s.start, inp.rrule.as_deref(), inp.start, inp.all_day, zone.as_deref());
    let reset = time_changed || rule_changed;
    let rows = changed_rows(c, s)?;
    let row_slots: Vec<i64> = rows.iter().map(slot_of).collect();
    let attendees = match (&acc, guests.is_empty()) {
        (Some(a), false) => calendar::organized(a, &guests, Some(s).filter(|_| !reset)),
        _ => vec![],
    };
    let has_att = attendees.len() > 1;
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut kept: Vec<CalEvent> = vec![];
    for mut o in rows {
        if reset {
            tx.execute("DELETE FROM events WHERE id=?1", [&o.id]).map_err(err)?;
            continue;
        }
        apply_series_edit(&mut o, s, inp, &acc, &guests);
        calendar::save_row(&tx, &o)?;
        kept.push(o);
    }
    let moved = |x: i64| recur::shift_slot(x, s.start, inp.start, s.all_day, s.tzid.as_deref());
    // deleted slots (the series' exdates that no changed row owns) follow a move of the time, and are forgotten when the rule changed (D-7.1b b, c)
    let deleted: Vec<i64> = s.exdates.iter().copied().filter(|e| !row_slots.contains(e)).collect();
    let mut exdates: Vec<i64> = if rule_changed { vec![] } else if time_changed { deleted.into_iter().map(moved).collect() } else { deleted };
    exdates.extend(kept.iter().map(slot_of));
    exdates.sort_unstable();
    exdates.dedup();
    let mut e = s.clone();
    e.summary = title_of(inp);
    e.start = inp.start;
    e.end = inp.end;
    e.all_day = inp.all_day;
    e.tzid = zone;
    e.location = clean(&inp.location);
    e.description = inp.description.clone().filter(|d| !d.trim().is_empty());
    e.reminder_min = inp.reminder_min;
    e.rrule = inp.rrule.as_deref().map(|r| recur::bare(r).to_string()).filter(|r| !r.is_empty());
    e.rdates = if time_changed { s.rdates.iter().copied().map(moved).collect() } else { s.rdates.clone() };
    e.exdates = exdates;
    e.organizer = if has_att { acc.as_ref().map(|a| calendar::CalPerson { email: a.email.to_ascii_lowercase(), name: Some(calendar::display_name(a)) }) } else { None };
    e.attendees = if has_att { attendees } else { vec![] };
    e.my_status = if has_att { Some("organizer".into()) } else { None };
    if let Some(a) = &acc {
        e.account_id = Some(a.id.clone());
    }
    e.sequence = s.sequence + if has_att { 1 } else { 0 };
    e.join_url = crate::ical::join_url(&calendar::to_ics_event(&e));
    resave(&tx, &mut e)?;
    tx.commit().map_err(err)?;
    let mut mails = vec![];
    if let (Some(a), true) = (&acc, has_att) {
        let mut ev = vec![e.clone()];
        ev.extend(kept);
        mails.push(mail(a, ev, "REQUEST"));
    }
    Ok(Saved { event: e.derive(), mails })
}

// ------------------------------------------------------------------ deleting

/// What a delete did: the mails to send (cancellations, or the shortened series).
#[derive(Debug)]
pub struct Deleted {
    pub mails: Vec<Mail>,
}

/// The cancellation of one occurrence of an organized series, as the mail carries it.
fn cancelled_occurrence(base: &CalEvent, series: &CalEvent, slot: i64) -> CalEvent {
    let mut e = base.clone();
    e.attendees = series.attendees.clone();
    e.organizer = series.organizer.clone();
    e.uid = series.uid.clone();
    e.rrule = None;
    e.exdates = vec![];
    e.rdates = vec![];
    e.recurrence_id = slot.to_string();
    e.sequence = base.sequence.max(series.sequence) + 1;
    e.status = "cancelled".into();
    e
}

/// Delete one scope of a series of My events (or of an invitations calendar: then nothing is mailed). `notify` = send the cancellation / the shortened series.
pub fn delete(c: &Connection, id: &str, scope: Scope, occurrence_start: Option<i64>, notify: bool) -> R<Deleted> {
    let p = resolve(c, id, occurrence_start)?;
    let s = &p.series;
    let organizer = s.calendar_id == LOCAL && s.my_status.as_deref() == Some("organizer") && s.attendees.len() > 1;
    let acc = account_of(c, s);
    let send = notify && organizer;
    let mut mails = vec![];
    let scope = match scope {
        Scope::Following if p.slot.is_none_or(|x| x <= s.start) => Scope::Series,
        other => other,
    };
    match scope {
        Scope::Series => {
            if let (true, Some(a)) = (send, &acc) {
                let mut gone = s.clone();
                gone.sequence += 1;
                gone.status = "cancelled".into();
                mails.push(mail(a, vec![gone], "CANCEL"));
            }
            c.execute("DELETE FROM events WHERE calendar_id=?1 AND uid=?2", params![s.calendar_id, s.uid]).map_err(err)?;
        }
        Scope::Occurrence => {
            let slot = p.slot.ok_or_else(bad_scope)?;
            let base = p.changed.clone().unwrap_or_else(|| instance_of(s, slot));
            let tx = c.unchecked_transaction().map_err(err)?;
            if let Some(o) = &p.changed {
                tx.execute("DELETE FROM events WHERE id=?1", [&o.id]).map_err(err)?;
            }
            let mut ser = s.clone();
            if !ser.exdates.contains(&slot) {
                ser.exdates.push(slot);
                ser.exdates.sort_unstable();
                resave(&tx, &mut ser)?;
            }
            tx.commit().map_err(err)?;
            if let (true, Some(a)) = (send, &acc) {
                mails.push(mail(a, vec![cancelled_occurrence(&base, s, slot)], "CANCEL"));
            }
        }
        Scope::Following => {
            let slot = p.slot.ok_or_else(bad_scope)?;
            let old_rule = match s.rrule.as_deref().filter(|r| !r.trim().is_empty()) {
                Some(r) => Some(recur::split(r, s.start, s.all_day, s.tzid.as_deref(), slot).ok_or_else(bad_scope)?.old),
                None => None,
            };
            let rows = changed_rows(c, s)?;
            let tx = c.unchecked_transaction().map_err(err)?;
            for o in rows.iter().filter(|o| slot_of(o) >= slot) {
                tx.execute("DELETE FROM events WHERE id=?1", [&o.id]).map_err(err)?;
            }
            let mut ser = s.clone();
            ser.rrule = old_rule;
            ser.exdates.retain(|e| *e < slot);
            ser.rdates.retain(|r| *r < slot);
            if organizer {
                ser.sequence += 1;
            }
            resave(&tx, &mut ser)?;
            tx.commit().map_err(err)?;
            if let (true, Some(a)) = (send, &acc) {
                let mut ev = vec![ser.clone()];
                ev.extend(rows.into_iter().filter(|o| slot_of(o) < slot));
                mails.push(mail(a, ev, "REQUEST"));
            }
        }
    }
    Ok(Deleted { mails })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone};
    use chrono_tz::Tz;

    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let a = Account {
            id: "a1".into(),
            email: "nam@example.com".into(),
            display_name: "Nam Hoang".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            username: "nam@example.com".into(),
            auth: "password".into(),
            color: None,
            smtp_username: String::new(),
            tls_insecure: false,
            reply_to: String::new(),
        };
        db::insert_account(&c, &a).unwrap();
        c
    }

    fn berlin(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        tz.from_local_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap()).earliest().unwrap().timestamp()
    }

    fn input(id: Option<&str>, title: &str, start: i64, end: i64, rrule: Option<&str>) -> CalEventInput {
        CalEventInput {
            id: id.map(String::from),
            account_id: None,
            summary: title.into(),
            start,
            end,
            all_day: false,
            tzid: Some("Europe/Berlin".into()),
            location: None,
            description: None,
            attendees: vec![],
            rrule: rrule.map(String::from),
            reminder_min: None,
            calendar_id: None,
            scope: None,
            occurrence_start: None,
        }
    }

    /// Weekly Tuesday 09:00 Berlin, 8 occurrences from 13 Oct 2026 (the spec's AC-7.1.1 series).
    fn weekly(c: &Connection) -> CalEvent {
        let s = berlin(2026, 10, 13, 9, 0);
        calendar::save_local(c, &input(None, "Weekly sync", s, s + 3600, Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"))).unwrap().0
    }

    /// The entries of the series (by title and local day/time) in a window.
    fn shown(c: &Connection) -> Vec<(String, String)> {
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        calendar::list_range(c, berlin(2026, 10, 1, 0, 0), berlin(2027, 1, 1, 0, 0))
            .unwrap()
            .into_iter()
            .map(|e| (e.summary.clone(), tz.timestamp_opt(e.start, 0).unwrap().format("%d.%m %H:%M").to_string()))
            .collect()
    }

    fn on(list: &[(String, String)], day: &str) -> Vec<String> {
        list.iter().filter(|(_, t)| t.starts_with(day)).map(|(s, t)| format!("{s} {}", &t[6..])).collect()
    }

    #[test]
    fn occurrence_edit_and_delete_on_local_series() {
        let c = setup();
        let s = weekly(&c);
        let slot = berlin(2026, 10, 27, 9, 0);
        // the form for the occurrence: its own values, no rule change offered
        let d = get(&c, &s.id, Scope::Occurrence, Some(slot)).unwrap();
        assert_eq!((d.event.start, d.event.occurrence_start), (slot, Some(slot)));
        // AC-7.1.1: 27 Oct 09:00 -> 11:00
        let mut inp = input(Some(&s.id), "Weekly sync", berlin(2026, 10, 27, 11, 0), berlin(2026, 10, 27, 12, 0), None);
        inp.occurrence_start = Some(slot);
        let saved = save(&c, &inp, Scope::Occurrence).unwrap();
        assert!(saved.event.changed_occurrence && saved.event.series);
        let list = shown(&c);
        assert_eq!(on(&list, "27.10"), vec!["Weekly sync 11:00"]);
        assert_eq!(on(&list, "20.10"), vec!["Weekly sync 09:00"]);
        assert_eq!(on(&list, "03.11"), vec!["Weekly sync 09:00"]);
        assert_eq!(list.len(), 8, "8 occurrences, none twice");
        // the form of the changed occurrence is its own row, the second save changes that row (no second row)
        let again = get(&c, &s.id, Scope::Occurrence, Some(slot)).unwrap();
        assert_eq!(again.event.start, berlin(2026, 10, 27, 11, 0));
        let mut inp2 = input(Some(&s.id), "Weekly sync", berlin(2026, 10, 27, 11, 30), berlin(2026, 10, 27, 12, 30), None);
        inp2.occurrence_start = Some(slot);
        save(&c, &inp2, Scope::Occurrence).unwrap();
        assert_eq!(shown(&c).len(), 8);
        assert_eq!(on(&shown(&c), "27.10"), vec!["Weekly sync 11:30"]);
        // saving it unchanged writes nothing
        let rows: i64 = c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        let mut same = input(Some(&s.id), "Weekly sync", berlin(2026, 10, 27, 11, 30), berlin(2026, 10, 27, 12, 30), None);
        same.occurrence_start = Some(slot);
        save(&c, &same, Scope::Occurrence).unwrap();
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap(), rows);
        // AC-7.1.2: delete the 3 Nov occurrence
        let del = delete(&c, &s.id, Scope::Occurrence, Some(berlin(2026, 11, 3, 9, 0)), false).unwrap();
        assert!(del.mails.is_empty());
        let list = shown(&c);
        assert!(on(&list, "03.11").is_empty() && list.len() == 7);
        // deleting the changed occurrence removes its row and hides its slot
        delete(&c, &s.id, Scope::Occurrence, Some(slot), false).unwrap();
        assert_eq!(shown(&c).len(), 6);
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM events WHERE recurrence_id<>''", [], |r| r.get(0)).unwrap(), 0);
        // the changed occurrence can also be reached by its own id (a click on its chip)
        let mut inp3 = input(Some(&s.id), "Moved", berlin(2026, 11, 10, 15, 0), berlin(2026, 11, 10, 16, 0), None);
        inp3.occurrence_start = Some(berlin(2026, 11, 10, 9, 0));
        let chip = save(&c, &inp3, Scope::Occurrence).unwrap().event;
        let by_row = get(&c, &chip.id, Scope::Series, None).unwrap();
        assert_eq!((by_row.event.id.as_str(), by_row.changed_count), (s.id.as_str(), 1), "the series row, one changed occurrence");
    }

    #[test]
    fn following_edit_keeps_every_slot_once() {
        let c = setup();
        let s = weekly(&c);
        // AC-7.1.3: 27 Oct changed to 11:00, 3 Nov deleted; then this and following from 10 Nov with a new title
        let mut o = input(Some(&s.id), "Weekly sync", berlin(2026, 10, 27, 11, 0), berlin(2026, 10, 27, 12, 0), None);
        o.occurrence_start = Some(berlin(2026, 10, 27, 9, 0));
        save(&c, &o, Scope::Occurrence).unwrap();
        delete(&c, &s.id, Scope::Occurrence, Some(berlin(2026, 11, 3, 9, 0)), false).unwrap();
        let slot = berlin(2026, 11, 10, 9, 0);
        let mut f = input(Some(&s.id), "Late sync", slot, slot + 3600, s.rrule.as_deref());
        f.occurrence_start = Some(slot);
        let got = save(&c, &f, Scope::Following).unwrap();
        assert_ne!(got.event.uid, s.uid, "a new series with its own UID");
        let list = shown(&c);
        // 13 Oct, 20 Oct, 27 Oct (11:00), no 3 Nov, then 10, 17, 24 Nov and 1 Dec
        let titles: Vec<String> = list.iter().map(|(t, d)| format!("{t} {d}")).collect();
        assert_eq!(
            titles,
            vec!["Weekly sync 13.10 09:00", "Weekly sync 20.10 09:00", "Weekly sync 27.10 11:00", "Late sync 10.11 09:00", "Late sync 17.11 09:00", "Late sync 24.11 09:00", "Late sync 01.12 09:00"],
            "8 slots minus the deleted one, once each"
        );
        // the old series ends before the slot and says how many occurrences it has left (COUNT is divided: 4 + 4)
        let old = calendar::get_event(&c, &s.id).unwrap();
        assert_eq!(old.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=4"));
        assert_eq!(got.event.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=4"));
        // the first occurrence has no "this and following": it is the whole series
        let first = berlin(2026, 10, 13, 9, 0);
        let mut whole = input(Some(&s.id), "Renamed", first, first + 3600, old.rrule.as_deref());
        whole.occurrence_start = Some(first);
        let r = save(&c, &whole, Scope::Following).unwrap();
        assert_eq!(r.event.uid, s.uid, "the series itself, no split");
    }

    #[test]
    fn series_edit_rules_b_and_c() {
        let c = setup();
        let s = weekly(&c);
        let mut o = input(Some(&s.id), "Weekly sync", berlin(2026, 10, 27, 11, 0), berlin(2026, 10, 27, 12, 0), None);
        o.occurrence_start = Some(berlin(2026, 10, 27, 9, 0));
        save(&c, &o, Scope::Occurrence).unwrap();
        delete(&c, &s.id, Scope::Occurrence, Some(berlin(2026, 11, 3, 9, 0)), false).unwrap();
        // the form tells how many changed occurrences a time change would reset
        assert_eq!(get(&c, &s.id, Scope::Series, None).unwrap().changed_count, 1);
        // AC-7.1.5: a title-only change goes to the series; the changed occurrence keeps its 11:00 and takes the new title
        let first = berlin(2026, 10, 13, 9, 0);
        save(&c, &input(Some(&s.id), "New title", first, first + 3600, s.rrule.as_deref()), Scope::Series).unwrap();
        let list = shown(&c);
        assert_eq!(on(&list, "27.10"), vec!["New title 11:00"]);
        assert_eq!(on(&list, "20.10"), vec!["New title 09:00"]);
        assert_eq!(list.len(), 7, "3 Nov still deleted");
        // AC-7.1.4: the time 09:00 -> 10:00 resets the changed occurrence and shifts the deleted slot with the series
        let ten = berlin(2026, 10, 13, 10, 0);
        save(&c, &input(Some(&s.id), "New title", ten, ten + 3600, s.rrule.as_deref()), Scope::Series).unwrap();
        let list = shown(&c);
        assert_eq!(list.len(), 7);
        assert_eq!(on(&list, "27.10"), vec!["New title 10:00"], "every occurrence at 10:00, including 27 Oct");
        assert!(on(&list, "03.11").is_empty(), "3 Nov stays deleted (its slot moved to 10:00)");
        assert_eq!(on(&list, "10.11"), vec!["New title 10:00"], "across the end of summer time too");
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM events WHERE recurrence_id<>''", [], |r| r.get(0)).unwrap(), 0);
        // rule (c): a new rule forgets the deleted slots and the changed occurrences
        let wed = berlin(2026, 10, 14, 10, 0);
        save(&c, &input(Some(&s.id), "New title", wed, wed + 3600, Some("FREQ=DAILY;COUNT=3")), Scope::Series).unwrap();
        assert_eq!(shown(&c).len(), 3);
        // no repeat at all: a single event
        save(&c, &input(Some(&s.id), "Single", wed, wed + 3600, None), Scope::Series).unwrap();
        let list = shown(&c);
        assert_eq!(list.len(), 1);
        assert!(!calendar::get_event(&c, &s.id).unwrap().series);
    }

    #[test]
    fn an_all_day_series_keeps_its_dates() {
        let c = setup();
        let mon = |d: u32| NaiveDate::from_ymd_opt(2026, 10, d).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
        let mut inp = input(None, "Offsite", mon(12), mon(13), Some("FREQ=WEEKLY;BYDAY=MO"));
        inp.all_day = true;
        inp.tzid = None;
        let s = calendar::save_local(&c, &inp).unwrap().0;
        // AC-7.1.7: 19 Oct moves to Tue 20 Oct
        let mut o = input(Some(&s.id), "Offsite", mon(20), mon(21), None);
        o.all_day = true;
        o.tzid = None;
        o.occurrence_start = Some(mon(19));
        save(&c, &o, Scope::Occurrence).unwrap();
        let days: Vec<i64> = calendar::list_range(&c, mon(10), mon(31)).unwrap().into_iter().map(|e| e.start).collect();
        assert_eq!(days, vec![mon(12), mon(20), mon(26)]);
        // this and following at 2 Nov: the old series ends with UNTIL in DATE form
        let nov2 = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
        let mut f = input(Some(&s.id), "Offsite 2", nov2, nov2 + 86400, s.rrule.as_deref());
        f.all_day = true;
        f.tzid = None;
        f.occurrence_start = Some(nov2);
        save(&c, &f, Scope::Following).unwrap();
        let old = calendar::get_event(&c, &s.id).unwrap();
        assert_eq!(old.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101"));
        let ics = crate::ical::to_ics(None, &[calendar::to_ics_event(&old)]);
        assert!(ics.contains("UNTIL=20261101\r\n"), "{ics}");
        assert!(ics.contains("EXDATE;VALUE=DATE:20261019"), "the moved occurrence's slot is a DATE: {ics}");
    }

    #[test]
    fn a_series_is_worked_out_in_its_own_zone() {
        let c = setup();
        // a New York series seen from Ho Chi Minh: the occurrence keeps New York's wall clock across the end of summer time there (1 Nov 2026)
        let ny: Tz = "America/New_York".parse().unwrap();
        let at = |y, m, d, h| ny.from_local_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, 0, 0).unwrap()).earliest().unwrap().timestamp();
        let mut inp = input(None, "Standup", at(2026, 10, 27, 9), at(2026, 10, 27, 10), Some("FREQ=WEEKLY;BYDAY=TU"));
        inp.tzid = Some("America/New_York".into());
        let s = calendar::save_local(&c, &inp).unwrap().0;
        // the form (in another zone) saves the series without touching the time: the zone of the series stays
        let mut same = input(Some(&s.id), "Standup 2", s.start, s.end, s.rrule.as_deref());
        same.tzid = Some("Asia/Ho_Chi_Minh".into());
        let got = save(&c, &same, Scope::Series).unwrap();
        assert_eq!(got.event.tzid.as_deref(), Some("America/New_York"));
        let list = calendar::list_range(&c, at(2026, 10, 26, 0), at(2026, 11, 20, 0)).unwrap();
        let starts: Vec<i64> = list.iter().map(|e| e.start).collect();
        assert_eq!(starts, vec![at(2026, 10, 27, 9), at(2026, 11, 3, 9), at(2026, 11, 10, 9), at(2026, 11, 17, 9)]);
        assert_eq!(starts[1] - starts[0], 7 * 86400 + 3600, "an hour more in UTC once EST starts");
    }

    fn organized_series(c: &Connection) -> CalEvent {
        let s = berlin(2026, 10, 13, 9, 0);
        let mut inp = input(None, "Weekly sync", s, s + 3600, Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"));
        inp.account_id = Some("a1".into());
        inp.attendees = vec![CalAttendee { email: "bao@contoso.com".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false }];
        calendar::save_local(c, &inp).unwrap().0
    }

    fn with_guest(mut inp: CalEventInput) -> CalEventInput {
        inp.account_id = Some("a1".into());
        inp.attendees = vec![CalAttendee { email: "bao@contoso.com".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false }];
        inp
    }

    fn ics_of(m: &Mail) -> String {
        crate::ical::to_ics(Some(m.method), &m.events.iter().map(calendar::to_ics_event).collect::<Vec<_>>()).replace("\r\n ", "")
    }

    #[test]
    fn imip_for_each_scope() {
        let c = setup();
        let s = organized_series(&c);
        assert_eq!(s.sequence, 0);
        // AC-7.1.6: this occurrence: one REQUEST that carries RECURRENCE-ID
        let slot = berlin(2026, 10, 27, 9, 0);
        let mut o = with_guest(input(Some(&s.id), "Weekly sync", berlin(2026, 10, 27, 11, 0), berlin(2026, 10, 27, 12, 0), None));
        o.occurrence_start = Some(slot);
        let got = save(&c, &o, Scope::Occurrence).unwrap();
        assert_eq!(got.mails.len(), 1);
        let ics = ics_of(&got.mails[0]);
        assert_eq!(got.mails[0].method, "REQUEST");
        assert!(ics.contains("RECURRENCE-ID;TZID=Europe/Berlin:20261027T090000"), "the slot in the form of the series' DTSTART: {ics}");
        assert!(ics.contains("DTSTART;TZID=Europe/Berlin:20261027T110000"), "{ics}");
        assert!(ics.contains("ATTENDEE") && ics.contains("bao@contoso.com"), "{ics}");
        assert!(!ics.contains("RRULE"), "an occurrence has no rule: {ics}");
        assert_eq!(ics.matches("BEGIN:VEVENT").count(), 1);
        // this and following: two REQUESTs, the old series with UNTIL / a smaller COUNT and the new one with a new UID
        let slot2 = berlin(2026, 11, 10, 9, 0);
        let mut f = with_guest(input(Some(&s.id), "Late sync", slot2, slot2 + 3600, s.rrule.as_deref()));
        f.occurrence_start = Some(slot2);
        let got = save(&c, &f, Scope::Following).unwrap();
        assert_eq!(got.mails.len(), 2);
        let (old_ics, new_ics) = (ics_of(&got.mails[0]), ics_of(&got.mails[1]));
        assert!(old_ics.contains(&format!("UID:{}", s.uid)) && old_ics.contains("COUNT=4"), "{old_ics}");
        assert_eq!(old_ics.matches("BEGIN:VEVENT").count(), 2, "the old series with its remaining changed occurrence: {old_ics}");
        assert!(new_ics.contains(&format!("UID:{}", got.event.uid)) && !new_ics.contains(&s.uid), "{new_ics}");
        // delete one occurrence with a cancellation: one CANCEL with RECURRENCE-ID
        let del = delete(&c, &s.id, Scope::Occurrence, Some(berlin(2026, 10, 20, 9, 0)), true).unwrap();
        assert_eq!(del.mails.len(), 1);
        let cancel = ics_of(&del.mails[0]);
        assert_eq!(del.mails[0].method, "CANCEL");
        assert!(cancel.contains("RECURRENCE-ID") && cancel.contains("STATUS:CANCELLED") && cancel.contains("METHOD:CANCEL"), "{cancel}");
        // ... and none without it
        assert!(delete(&c, &s.id, Scope::Occurrence, Some(berlin(2026, 10, 13, 9, 0)), false).unwrap().mails.is_empty());
        // the whole series: a REQUEST carries the series and its changed occurrences
        let s2 = organized_series(&c);
        let mut o2 = with_guest(input(Some(&s2.id), "Weekly sync", berlin(2026, 10, 27, 11, 0), berlin(2026, 10, 27, 12, 0), None));
        o2.occurrence_start = Some(berlin(2026, 10, 27, 9, 0));
        save(&c, &o2, Scope::Occurrence).unwrap();
        let first = berlin(2026, 10, 13, 9, 0);
        let got = save(&c, &with_guest(input(Some(&s2.id), "Renamed", first, first + 3600, s2.rrule.as_deref())), Scope::Series).unwrap();
        assert_eq!(got.mails.len(), 1);
        let ics = ics_of(&got.mails[0]);
        assert_eq!(ics.matches("BEGIN:VEVENT").count(), 2, "series + its changed occurrence: {ics}");
        assert!(got.event.sequence > s2.sequence);
        // deleting the whole series cancels it
        let del = delete(&c, &s2.id, Scope::Series, None, true).unwrap();
        assert_eq!(del.mails[0].method, "CANCEL");
        assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM events WHERE uid=?1", [&s2.uid], |r| r.get(0)).unwrap(), 0);
    }

    #[test]
    fn deleting_the_following_occurrences_shortens_the_series() {
        let c = setup();
        let s = weekly(&c);
        let slot = berlin(2026, 11, 10, 9, 0);
        delete(&c, &s.id, Scope::Following, Some(slot), false).unwrap();
        assert_eq!(shown(&c).len(), 4);
        assert_eq!(calendar::get_event(&c, &s.id).unwrap().rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=4"));
        // the first occurrence: the whole series goes
        delete(&c, &s.id, Scope::Following, Some(s.start), false).unwrap();
        assert!(shown(&c).is_empty());
    }

    #[test]
    fn an_invitation_series_can_be_cut_locally_and_a_foreign_one_is_not_edited() {
        let c = setup();
        let s = weekly(&c);
        let ev = calendar::get_event(&c, &s.id).unwrap();
        let mut inv = ev.clone();
        inv.id = "inv-1".into();
        inv.uid = "inv@contoso.com".into();
        inv.calendar_id = "invites:a1".into();
        calendar::save_row(&c, &inv).unwrap();
        let mut inp = input(Some("inv-1"), "x", ev.start, ev.end, None);
        inp.occurrence_start = Some(ev.start);
        assert!(save(&c, &inp, Scope::Series).unwrap_err().starts_with("CAL_NOT_YOURS"));
        let del = delete(&c, "inv-1", Scope::Occurrence, Some(berlin(2026, 10, 20, 9, 0)), true).unwrap();
        assert!(del.mails.is_empty(), "no mail for somebody else's invitation");
        let gone = calendar::get_event(&c, "inv-1").unwrap();
        assert!(gone.exdates.contains(&berlin(2026, 10, 20, 9, 0)));
        // My events are untouched
        assert!(calendar::get_event(&c, &s.id).unwrap().exdates.is_empty());
    }

    #[test]
    fn scopes_and_slots_are_validated() {
        assert_eq!(Scope::parse(None).unwrap(), None);
        assert_eq!(Scope::parse(Some("")).unwrap(), None);
        assert_eq!(Scope::parse(Some("following")).unwrap(), Some(Scope::Following));
        assert!(Scope::parse(Some("everything")).unwrap_err().starts_with("CAL_BAD_SCOPE"));
        let c = setup();
        let s = weekly(&c);
        // an occurrence needs its slot
        let inp = input(Some(&s.id), "x", s.start, s.end, None);
        assert!(save(&c, &inp, Scope::Occurrence).unwrap_err().starts_with("CAL_BAD_SCOPE"));
        assert!(get(&c, &s.id, Scope::Following, None).unwrap_err().starts_with("CAL_BAD_SCOPE"));
        assert!(get(&c, "nope", Scope::Series, None).unwrap_err().starts_with("CAL_EVENT_NOT_FOUND"));
    }
}
