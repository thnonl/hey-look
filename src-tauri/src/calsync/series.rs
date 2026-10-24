//! Repeating events of a synced calendar (W7.1): change or delete one occurrence, this and the following ones, or the whole series.
//!
//! Google keeps a series as one master event (rule, extra and excluded dates) with an exception event for every occurrence that was changed; the master and the
//! exceptions are rows of `events` (`remote_kind` master / exception). Outlook lists occurrences and has no master among the rows: the occurrence is a row of its own
//! (`remote_kind` occurrence / exception, `series_id` = the master's id) and the master is fetched from the service when "this and following" or "the whole series" needs it
//! (`CalProvider::get_series`, D-7.1d).
//!
//! As everywhere in this layer the service is asked first and the rows are written from its answer; a write that cannot reach it changes nothing.
use super::engine::{self, Clock};
use super::store;
use super::write::{clean, diff, fail, guests, norm, read_only_text, target, Target};
use super::{EventDraft, EventPatch, Kind, ProviderFactory, Recurrence, RemoteEvent, SyncErr};
use crate::calendar::{self, CalEvent, CalEventDetail, CalEventInput};
use crate::calseries::{self, Scope};
use crate::db::R;
use crate::{lock, recur, Db};

/// The text for a repeat rule the app cannot change (an Outlook pattern outside the mapped set).
fn pattern_text(kind: Kind) -> String {
    format!("CAL_READ_ONLY: Hey Look! can’t change this repeat rule. You can change it in {}.", kind.service())
}

/// What a scoped call works on.
struct Ctx {
    t: Target,
    /// the row that was opened
    row: CalEvent,
    /// the series master as a row (Google); Outlook has none
    master: Option<CalEvent>,
    /// the row of the occurrence at `slot` when it was changed (Google exception) or listed on its own (Outlook occurrence)
    changed: Option<CalEvent>,
    slot: Option<i64>,
}

impl Ctx {
    fn series_id(&self) -> Option<String> {
        match &self.master {
            Some(m) => m.remote_id.clone(),
            None => self.row.series_id.clone(),
        }
    }
}

fn not_a_series() -> String {
    calseries::bad_scope()
}

fn prepare(db: &Db, id: &str, occurrence_start: Option<i64>) -> R<Ctx> {
    let row = calendar::get_event(&lock(db), id)?;
    let t = target(db, &row.calendar_id)?;
    let c = lock(db);
    let (master, changed, slot) = if t.src.kind.lists_occurrences() {
        match row.remote_kind.as_deref() {
            Some("occurrence" | "exception") => (None, Some(row.clone()), row.recurrence_id.parse::<i64>().ok()),
            _ => return Err(not_a_series()),
        }
    } else {
        match row.remote_kind.as_deref() {
            Some("exception") => {
                let sid = row.series_id.clone().ok_or_else(not_a_series)?;
                let master = store::find_remote(&c, &row.calendar_id, &sid).ok_or("CAL_GONE: This event is not part of a synced calendar.")?;
                let slot = row.recurrence_id.parse::<i64>().ok();
                (Some(master), Some(row.clone()), slot)
            }
            Some("master") => {
                let changed = occurrence_start.and_then(|s| {
                    c.query_row(
                        &format!("SELECT {} FROM events WHERE calendar_id=?1 AND series_id=?2 AND recurrence_id=?3", calendar::COLS),
                        rusqlite::params![row.calendar_id, row.remote_id, s.to_string()],
                        calendar::row_event,
                    )
                    .ok()
                });
                (Some(row.clone()), changed, occurrence_start)
            }
            _ => return Err(not_a_series()),
        }
    };
    drop(c);
    Ok(Ctx { t, row, master, changed, slot })
}

/// A series cannot be changed when its calendar or the event says so.
fn check_writable(ctx: &Ctx) -> R<()> {
    let name = ctx.t.cal.name.clone();
    if ctx.t.cal.read_only {
        return Err(read_only_text("calendar", &name, ctx.t.src.kind));
    }
    let owner = ctx.master.as_ref().unwrap_or(&ctx.row);
    if let Some(reason) = owner.read_only.as_deref().or(ctx.row.read_only.as_deref()) {
        return Err(read_only_text(reason, &name, ctx.t.src.kind));
    }
    Ok(())
}

/// The zone a series keeps whatever zone the form shows its times in.
fn zone(series_tz: &Option<String>, all_day: bool) -> Option<String> {
    if all_day { None } else { series_tz.clone() }
}

fn exception_count(db: &Db, ctx: &Ctx, from: Option<i64>) -> i64 {
    let Some(sid) = ctx.series_id() else { return 0 };
    let c = lock(db);
    let mut st = match c.prepare("SELECT recurrence_id FROM events WHERE calendar_id=?1 AND series_id=?2 AND remote_kind='exception'") {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let rows = st.query_map(rusqlite::params![ctx.t.cal.id, sid], |r| r.get::<_, String>(0)).map(|it| it.filter_map(|r| r.ok()).collect::<Vec<_>>()).unwrap_or_default();
    rows.iter().filter_map(|r| r.parse::<i64>().ok()).filter(|s| from.is_none_or(|f| *s >= f)).count() as i64
}

/// The master as the form edits it (Outlook): the service's master made into an event, under the id of the row that was opened.
fn master_event(ctx: &Ctx, master: &RemoteEvent) -> CalEvent {
    store::event_from_remote(&ctx.t.cal, ctx.row.account_id.as_deref().unwrap_or(&ctx.t.src.account_id), master, ctx.row.id.clone(), Some(&ctx.row))
}

// ------------------------------------------------------------------ the form

pub fn get(db: &Db, factory: &dyn ProviderFactory, id: &str, scope: Scope, occurrence_start: Option<i64>) -> R<CalEventDetail> {
    let ctx = prepare(db, id, occurrence_start)?;
    let slot = ctx.slot;
    if let Some(master) = &ctx.master {
        // Google: the master and the exceptions are rows
        let (event, count) = match scope {
            Scope::Series => (master.clone(), exception_count(db, &ctx, None)),
            Scope::Occurrence | Scope::Following => {
                let slot = slot.ok_or_else(not_a_series)?;
                let mut e = ctx.changed.clone().unwrap_or_else(|| calseries::instance_of(master, slot));
                e.instance_start = Some(slot);
                if scope == Scope::Following {
                    e.rrule = master.rrule.clone();
                    e.recurrence_text = master.recurrence_text.clone();
                }
                (e.derive(), if scope == Scope::Following { exception_count(db, &ctx, Some(slot)) } else { 0 })
            }
        };
        return Ok(CalEventDetail { event, changed_count: count, pattern_unsupported: false });
    }
    // Outlook: an occurrence is its row; the master is asked for
    if scope == Scope::Occurrence {
        return Ok(CalEventDetail { event: ctx.row.clone().derive(), changed_count: 0, pattern_unsupported: false });
    }
    let sid = ctx.row.series_id.clone().ok_or_else(not_a_series)?;
    let provider = factory.provider(&ctx.t.src).map_err(|e| fail(db, &ctx.t, e))?;
    let master = provider.get_series(&ctx.t.cal.remote(), &sid).map_err(|e| fail(db, &ctx.t, e))?;
    let mut event = master_event(&ctx, &master);
    let count = if scope == Scope::Following { exception_count(db, &ctx, slot) } else { exception_count(db, &ctx, None) };
    if scope == Scope::Following {
        // the form shows the occurrence that was opened, with the rule of the series
        let o = &ctx.row;
        event.start = o.start;
        event.end = o.end;
        event.instance_start = slot;
    }
    event.read_only = ctx.row.read_only.clone();
    Ok(CalEventDetail { event: event.derive(), changed_count: count, pattern_unsupported: master.pattern_unsupported })
}

// ------------------------------------------------------------------ saving

/// A failed write: a conflict or a series that is gone pulls the calendar so the service's version is shown.
fn failed(db: &Db, factory: &dyn ProviderFactory, t: &Target, e: SyncErr) -> String {
    if matches!(e, SyncErr::Conflict | SyncErr::NotFound) {
        let _ = engine::refresh_calendar(db, factory, &t.cal.id, Clock::real());
    }
    fail(db, t, e)
}

/// Pull the calendar after a write that changes many rows at the service (best effort): the rows then show what the service made of it.
fn pull_again(db: &Db, factory: &dyn ProviderFactory, t: &Target) {
    let _ = engine::refresh_calendar(db, factory, &t.cal.id, Clock::real());
}

fn recurrence_of(rule: Option<&str>, start: i64, all_day: bool, tzid: &Option<String>, exdates: Vec<i64>, rdates: Vec<i64>) -> Recurrence {
    Recurrence { rrule: rule.map(|r| recur::bare(r).to_string()).filter(|r| !r.is_empty()), exdates, rdates, start, all_day, tzid: tzid.clone().or_else(|| (!all_day).then(|| "UTC".to_string())) }
}

pub fn save(db: &Db, factory: &dyn ProviderFactory, inp: &CalEventInput, scope: Scope) -> R<CalEvent> {
    let id = inp.id.as_deref().ok_or_else(not_a_series)?;
    let ctx = prepare(db, id, inp.occurrence_start)?;
    check_writable(&ctx)?;
    let provider = factory.provider(&ctx.t.src).map_err(|e| fail(db, &ctx.t, e))?;
    match scope {
        Scope::Occurrence => save_occurrence(db, factory, &*provider, &ctx, inp),
        Scope::Following => save_following(db, factory, &*provider, &ctx, inp),
        Scope::Series => save_series(db, factory, &*provider, &ctx, inp),
    }
}

fn save_occurrence(db: &Db, factory: &dyn ProviderFactory, provider: &dyn super::CalProvider, ctx: &Ctx, inp: &CalEventInput) -> R<CalEvent> {
    let t = &ctx.t;
    let slot = ctx.slot.ok_or_else(not_a_series)?;
    let base = match (&ctx.changed, &ctx.master) {
        (Some(c), _) => c.clone(),
        (None, Some(m)) => calseries::instance_of(m, slot),
        _ => return Err(not_a_series()),
    };
    let me = norm(&t.email);
    let mut inp2 = inp.clone();
    inp2.tzid = zone(&base.tzid, inp.all_day);
    let patch = diff(&base, &inp2, &me);
    if patch.is_empty() {
        return Ok(base);
    }
    let remote = t.cal.remote();
    let re = match &ctx.changed {
        Some(c) => provider.update(&remote, c.remote_id.as_deref().unwrap_or(""), c.etag.as_deref().unwrap_or(""), &patch),
        None => {
            let m = ctx.master.as_ref().ok_or_else(not_a_series)?;
            provider.update_occurrence(&remote, m.remote_id.as_deref().unwrap_or(""), slot, m.all_day, &patch)
        }
    }
    .map_err(|e| failed(db, factory, t, e))?;
    let saved = {
        let c = lock(db);
        let saved = store::upsert_remote(&c, &t.cal, &t.src.account_id, &re)?;
        if let Some(sid) = &re.series_id {
            store::refresh_exdates(&c, &t.cal.id, sid)?;
        }
        saved
    };
    super::request_sync(&t.src.account_id);
    Ok(saved)
}

/// What the form changed about the time of a series master: the new first start and end, in the zone of the series.
fn series_patch(old: &CalEvent, inp: &CalEventInput, me: &str) -> EventPatch {
    let mut inp2 = inp.clone();
    inp2.tzid = zone(&old.tzid, inp.all_day);
    let mut patch = diff(old, &inp2, me);
    // a repeating event always names the zone of its rule when its time is written
    if let Some(w) = patch.when.as_mut() {
        if !w.all_day && w.tzid.is_none() {
            w.tzid = Some("UTC".into());
        }
    }
    patch
}

fn save_series(db: &Db, factory: &dyn ProviderFactory, provider: &dyn super::CalProvider, ctx: &Ctx, inp: &CalEventInput) -> R<CalEvent> {
    let t = &ctx.t;
    let me = norm(&t.email);
    let remote = t.cal.remote();
    let lists = t.src.kind.lists_occurrences();
    // the master as the service has it now (Outlook), or as the rows have it (Google)
    let (old, remote_id, etag, unsupported) = if lists {
        let sid = ctx.row.series_id.clone().ok_or_else(not_a_series)?;
        let m = provider.get_series(&remote, &sid).map_err(|e| failed(db, factory, t, e))?;
        (master_event(ctx, &m), sid, m.etag.clone(), m.pattern_unsupported)
    } else {
        let m = ctx.master.clone().ok_or_else(not_a_series)?;
        let rid = m.remote_id.clone().unwrap_or_default();
        let et = m.etag.clone().unwrap_or_default();
        (m, rid, et, false)
    };
    let mut patch = series_patch(&old, inp, &me);
    let zone_ref = zone(&old.tzid, inp.all_day);
    let rule_changed = !recur::same_rule(old.rrule.as_deref(), old.start, inp.rrule.as_deref(), inp.start, inp.all_day, zone_ref.as_deref());
    let start_day = |ts: i64, tz: &Option<String>, all_day: bool| crate::ical::wall_in(tz.as_deref().and_then(crate::ical::iana_for).filter(|_| !all_day), ts).date();
    let moved_day = start_day(old.start, &old.tzid, old.all_day) != start_day(inp.start, &zone_ref, inp.all_day);
    let wants_recurrence = rule_changed || (lists && (moved_day || patch.when.is_some()));
    if unsupported && (rule_changed || moved_day) {
        return Err(pattern_text(t.src.kind));
    }
    if wants_recurrence && !unsupported {
        let rule = inp.rrule.as_deref().filter(|r| !r.trim().is_empty()).or(if rule_changed { None } else { old.rrule.as_deref() });
        if let Some(r) = rule {
            // Outlook can only be given a rule it has a pattern for
            if lists && super::graph_recur::to_graph(r, inp.start, inp.all_day, zone_ref.as_deref()).is_none() {
                return Err(pattern_text(t.src.kind));
            }
        }
        // the extra dates of a Google series stay, the deleted dates go with a new rule (D-7.1b c); Outlook keeps neither
        let fresh = if lists { None } else { Some(provider.get_series(&remote, &remote_id).map_err(|e| failed(db, factory, t, e))?) };
        let rdates = fresh.as_ref().map(|f| f.rdates.clone()).unwrap_or_default();
        let exdates = if rule_changed { vec![] } else { fresh.map(|f| f.exdates).unwrap_or_default() };
        patch.recurrence = Some(recurrence_of(rule, inp.start, inp.all_day, &zone_ref, exdates, rdates));
    }
    if patch.is_empty() {
        return Ok(ctx.master.clone().unwrap_or_else(|| ctx.row.clone()));
    }
    let re = provider.update(&remote, &remote_id, &etag, &patch).map_err(|e| failed(db, factory, t, e))?;
    let saved = if lists {
        master_event(ctx, &re)
    } else {
        let c = lock(db);
        let saved = store::upsert_remote(&c, &t.cal, &t.src.account_id, &re)?;
        store::refresh_exdates(&c, &t.cal.id, &remote_id)?;
        saved
    };
    // the service changed more than the master (its exceptions, the occurrences): show what it made of it
    pull_again(db, factory, t);
    super::request_sync(&t.src.account_id);
    Ok(saved)
}

/// The master a "this and following" starts from: its rule and the first slot, from the rows (Google, with the own EXDATE / RDATE lists asked for) or from the
/// service (Outlook).
struct Cut {
    remote_id: String,
    etag: String,
    start: i64,
    all_day: bool,
    tzid: Option<String>,
    rrule: String,
    exdates: Vec<i64>,
    rdates: Vec<i64>,
}

fn cut_source(db: &Db, factory: &dyn ProviderFactory, provider: &dyn super::CalProvider, ctx: &Ctx) -> R<Cut> {
    let t = &ctx.t;
    let remote = t.cal.remote();
    if t.src.kind.lists_occurrences() {
        let sid = ctx.row.series_id.clone().ok_or_else(not_a_series)?;
        let m = provider.get_series(&remote, &sid).map_err(|e| failed(db, factory, t, e))?;
        if m.pattern_unsupported {
            return Err(pattern_text(t.src.kind));
        }
        return Ok(Cut { remote_id: sid, etag: m.etag, start: m.start, all_day: m.all_day, tzid: m.tzid, rrule: m.rrule.unwrap_or_default(), exdates: vec![], rdates: vec![] });
    }
    let master = ctx.master.as_ref().ok_or_else(not_a_series)?;
    let rid = master.remote_id.clone().unwrap_or_default();
    let fresh = provider.get_series(&remote, &rid).map_err(|e| failed(db, factory, t, e))?;
    // the version the person saw must still be the one at the service
    if !fresh.etag.is_empty() && master.etag.as_deref().is_some_and(|e| e != fresh.etag) {
        return Err(failed(db, factory, t, SyncErr::Conflict));
    }
    Ok(Cut {
        remote_id: rid,
        etag: master.etag.clone().unwrap_or_default(),
        start: master.start,
        all_day: master.all_day,
        tzid: master.tzid.clone(),
        rrule: master.rrule.clone().unwrap_or_default(),
        exdates: fresh.exdates,
        rdates: fresh.rdates,
    })
}

/// Cut the series before `slot`: the master keeps its rule up to there. Returns the master as the service now has it.
fn cut_before(db: &Db, factory: &dyn ProviderFactory, provider: &dyn super::CalProvider, ctx: &Ctx, cut: &Cut, old_rule: &str, slot: i64) -> R<RemoteEvent> {
    let patch = EventPatch {
        recurrence: Some(recurrence_of(
            Some(old_rule),
            cut.start,
            cut.all_day,
            &cut.tzid,
            cut.exdates.iter().copied().filter(|e| *e < slot).collect(),
            cut.rdates.iter().copied().filter(|r| *r < slot).collect(),
        )),
        ..Default::default()
    };
    provider.update(&ctx.t.cal.remote(), &cut.remote_id, &cut.etag, &patch).map_err(|e| failed(db, factory, &ctx.t, e))
}

/// The exceptions of a Google series from `slot` on that the rows know: with the cut they have no series to belong to.
fn leftover_exceptions(db: &Db, ctx: &Ctx, remote_id: &str, slot: i64) -> Vec<CalEvent> {
    let c = lock(db);
    let Ok(mut st) = c.prepare(&format!("SELECT {} FROM events WHERE calendar_id=?1 AND series_id=?2 AND recurrence_id<>''", calendar::COLS)) else { return vec![] };
    st.query_map(rusqlite::params![ctx.t.cal.id, remote_id], calendar::row_event)
        .map(|it| it.filter_map(|r| r.ok()).filter(|e| e.recurrence_id.parse::<i64>().is_ok_and(|s| s >= slot)).collect())
        .unwrap_or_default()
}

/// After a cut: the exceptions behind it go (at the service for Google, which keeps them as events of their own), and the rows follow.
fn drop_leftovers(db: &Db, provider: &dyn super::CalProvider, ctx: &Ctx, remote_id: &str, slot: i64) {
    let remote = ctx.t.cal.remote();
    let now = chrono::Utc::now().timestamp();
    for e in leftover_exceptions(db, ctx, remote_id, slot) {
        let rid = e.remote_id.clone().unwrap_or_default();
        if !ctx.t.src.kind.lists_occurrences() {
            // (best effort: an exception that cannot be deleted stays behind the end of the series, where nothing shows it)
            let _ = provider.delete(&remote, &rid, e.etag.as_deref().unwrap_or(""));
        }
        let _ = store::remove_remote(&lock(db), &ctx.t.cal.id, &rid, now);
    }
}

fn save_following(db: &Db, factory: &dyn ProviderFactory, provider: &dyn super::CalProvider, ctx: &Ctx, inp: &CalEventInput) -> R<CalEvent> {
    let t = &ctx.t;
    let slot = ctx.slot.ok_or_else(not_a_series)?;
    let cut = cut_source(db, factory, provider, ctx)?;
    // the first occurrence: this and following is the whole series
    if slot <= cut.start {
        return save_series(db, factory, provider, ctx, inp);
    }
    let me = norm(&t.email);
    let split = recur::split(&cut.rrule, cut.start, cut.all_day, cut.tzid.as_deref(), slot).ok_or_else(not_a_series)?;
    let zone_ref = zone(&cut.tzid, inp.all_day);
    let rule_changed = !recur::same_rule(Some(&cut.rrule), cut.start, inp.rrule.as_deref(), inp.start, inp.all_day, zone_ref.as_deref());
    let new_rule = if rule_changed { inp.rrule.as_deref().map(|r| recur::bare(r).to_string()).filter(|r| !r.is_empty()) } else { Some(split.new.clone()) };
    if t.src.kind.lists_occurrences() {
        // Outlook can only be given rules it has a pattern for
        for r in [Some(split.old.as_str()), new_rule.as_deref()].into_iter().flatten() {
            if super::graph_recur::to_graph(r, inp.start, inp.all_day, zone_ref.as_deref()).is_none() {
                return Err(pattern_text(t.src.kind));
            }
        }
    }
    let remote = t.cal.remote();
    let old_re = cut_before(db, factory, provider, ctx, &cut, &split.old, slot)?;
    let draft = EventDraft {
        summary: if inp.summary.trim().is_empty() { "(No title)".into() } else { inp.summary.trim().to_string() },
        start: inp.start,
        end: inp.end,
        all_day: inp.all_day,
        tzid: zone_ref.clone().or_else(|| (!inp.all_day).then(|| "UTC".to_string())),
        location: clean(&inp.location),
        description: inp.description.clone().filter(|d| !d.trim().is_empty()),
        attendees: guests(inp, None, &me),
        reminder_min: inp.reminder_min,
        rrule: new_rule,
    };
    let new_re = match provider.create(&remote, &draft) {
        Ok(n) => n,
        Err(e) => {
            // the series was cut but the new part was not made: put the cut back so nothing is lost
            let undo = EventPatch {
                recurrence: Some(recurrence_of(Some(&cut.rrule), cut.start, cut.all_day, &cut.tzid, cut.exdates.clone(), cut.rdates.clone())),
                ..Default::default()
            };
            let _ = provider.update(&remote, &cut.remote_id, &old_re.etag, &undo);
            return Err(failed(db, factory, t, e));
        }
    };
    // (Outlook: the masters are not rows; the pull below brings the occurrences)
    let saved = if t.src.kind.lists_occurrences() {
        master_event(ctx, &new_re)
    } else {
        let c = lock(db);
        store::upsert_remote(&c, &t.cal, &t.src.account_id, &old_re)?;
        store::upsert_remote(&c, &t.cal, &t.src.account_id, &new_re)?
    };
    drop_leftovers(db, provider, ctx, &cut.remote_id, slot);
    if !t.src.kind.lists_occurrences() {
        let _ = store::refresh_exdates(&lock(db), &t.cal.id, &cut.remote_id);
    }
    pull_again(db, factory, t);
    super::request_sync(&t.src.account_id);
    Ok(saved)
}

// ------------------------------------------------------------------ deleting

pub fn delete(db: &Db, factory: &dyn ProviderFactory, id: &str, scope: Scope, occurrence_start: Option<i64>) -> R<()> {
    let ctx = prepare(db, id, occurrence_start)?;
    check_writable(&ctx)?;
    let t = &ctx.t;
    let provider = factory.provider(&t.src).map_err(|e| fail(db, t, e))?;
    let remote = t.cal.remote();
    let now = chrono::Utc::now().timestamp();
    let lists = t.src.kind.lists_occurrences();
    let scope = if scope == Scope::Following && ctx.slot.is_some() {
        // the first occurrence: the whole series
        let first = match &ctx.master {
            Some(m) => m.start,
            None => cut_source(db, factory, &*provider, &ctx)?.start,
        };
        if ctx.slot.is_some_and(|s| s <= first) { Scope::Series } else { scope }
    } else {
        scope
    };
    match scope {
        Scope::Occurrence => {
            let slot = ctx.slot.ok_or_else(not_a_series)?;
            match &ctx.changed {
                Some(c) => {
                    let rid = c.remote_id.clone().unwrap_or_default();
                    match provider.delete(&remote, &rid, c.etag.as_deref().unwrap_or("")) {
                        Ok(()) | Err(SyncErr::NotFound) => {}
                        Err(e) => return Err(failed(db, factory, t, e)),
                    }
                    let cn = lock(db);
                    store::remove_remote(&cn, &t.cal.id, &rid, now)?;
                    if let Some(sid) = &c.series_id {
                        store::refresh_exdates(&cn, &t.cal.id, sid)?;
                    }
                }
                None => {
                    let m = ctx.master.as_ref().ok_or_else(not_a_series)?;
                    let sid = m.remote_id.clone().unwrap_or_default();
                    match provider.delete_occurrence(&remote, &sid, slot, m.all_day) {
                        Ok(instance) => store::forget_occurrence(&lock(db), &t.cal.id, &sid, &instance, slot, now)?,
                        // the occurrence is not there any more: the calendar shows that after a pull
                        Err(SyncErr::NotFound) => pull_again(db, factory, t),
                        Err(e) => return Err(failed(db, factory, t, e)),
                    }
                }
            }
        }
        Scope::Following => {
            let slot = ctx.slot.ok_or_else(not_a_series)?;
            let cut = cut_source(db, factory, &*provider, &ctx)?;
            let split = recur::split(&cut.rrule, cut.start, cut.all_day, cut.tzid.as_deref(), slot).ok_or_else(not_a_series)?;
            let re = cut_before(db, factory, &*provider, &ctx, &cut, &split.old, slot)?;
            if !lists {
                store::upsert_remote(&lock(db), &t.cal, &t.src.account_id, &re)?;
            }
            drop_leftovers(db, &*provider, &ctx, &cut.remote_id, slot);
            if lists {
                // Outlook lists the occurrences: the ones behind the cut are gone here too
                let cn = lock(db);
                let rows: Vec<String> = cn
                    .prepare("SELECT remote_id,recurrence_id FROM events WHERE calendar_id=?1 AND series_id=?2")
                    .and_then(|mut st| st.query_map(rusqlite::params![t.cal.id, cut.remote_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map(|it| it.filter_map(|r| r.ok()).filter(|(_, s)| s.parse::<i64>().is_ok_and(|s| s >= slot)).map(|(rid, _)| rid).collect()))
                    .unwrap_or_default();
                for rid in rows {
                    let _ = cn.execute("DELETE FROM events WHERE calendar_id=?1 AND remote_id=?2", rusqlite::params![t.cal.id, rid]);
                }
            } else {
                let _ = store::refresh_exdates(&lock(db), &t.cal.id, &cut.remote_id);
            }
        }
        Scope::Series => {
            let (sid, etag) = if lists {
                let sid = ctx.row.series_id.clone().ok_or_else(not_a_series)?;
                let m = provider.get_series(&remote, &sid).map_err(|e| failed(db, factory, t, e))?;
                (sid, m.etag)
            } else {
                let m = ctx.master.as_ref().ok_or_else(not_a_series)?;
                (m.remote_id.clone().unwrap_or_default(), m.etag.clone().unwrap_or_default())
            };
            match provider.delete(&remote, &sid, &etag) {
                Ok(()) | Err(SyncErr::NotFound) => {}
                Err(e) => return Err(failed(db, factory, t, e)),
            }
            store::remove_remote(&lock(db), &t.cal.id, &sid, now)?;
        }
    }
    super::request_sync(&t.src.account_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::fake::*;
    use super::super::store::tests::{conn, rc, ACC};
    use super::super::*;
    use super::*;
    use chrono::{NaiveDate, TimeZone};
    use chrono_tz::Tz;
    use std::sync::{Arc, Mutex};

    const T0: i64 = 1_790_000_000;

    fn berlin(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        tz.from_local_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap()).earliest().unwrap().timestamp()
    }

    struct Env {
        db: Db,
        fake: FakeProvider,
        factory: FakeFactory,
        cal: String,
    }

    /// A Google calendar with a weekly Tuesday 09:00 (Berlin) series of 8 occurrences from 13 Oct 2026.
    fn env() -> Env {
        let c = conn();
        let s = store::create_source(&c, ACC, Kind::Google, 0).unwrap();
        let db: Db = Arc::new(Mutex::new(c));
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        let start = berlin(2026, 10, 13, 9, 0);
        let mut m = series("s", "Weekly sync", start, "FREQ=WEEKLY;BYDAY=TU;COUNT=8");
        m.tzid = Some("Europe/Berlin".into());
        m.uid = "s@google.com".into();
        fake.add_event("primary", m);
        let factory = FakeFactory::new(fake.clone());
        engine::sync_source(&db, &factory, &s.id, Clock { now: T0, jitter: 0.5 }, &|| {}).unwrap();
        Env { db, fake, factory, cal: calendar_id(ACC, Kind::Google, "primary") }
    }

    fn row_id(e: &Env, remote: &str) -> String {
        lock(&e.db).query_row("SELECT id FROM events WHERE remote_id=?1", [remote], |r| r.get(0)).unwrap()
    }

    fn input(e: &Env, id: &str, title: &str, start: i64, rrule: Option<&str>, slot: Option<i64>) -> CalEventInput {
        CalEventInput {
            id: Some(id.into()),
            account_id: None,
            summary: title.into(),
            start,
            end: start + 3600,
            all_day: false,
            tzid: Some("Asia/Ho_Chi_Minh".into()),
            location: None,
            description: None,
            attendees: vec![],
            rrule: rrule.map(String::from),
            reminder_min: None,
            calendar_id: Some(e.cal.clone()),
            scope: None,
            occurrence_start: slot,
        }
    }

    /// What the calendar shows between Oct and Jan: title and local time in Berlin.
    fn shown(e: &Env) -> Vec<String> {
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        calendar::list_range(&lock(&e.db), berlin(2026, 10, 1, 0, 0), berlin(2027, 1, 1, 0, 0))
            .unwrap()
            .into_iter()
            .map(|x| format!("{} {}", x.summary, tz.timestamp_opt(x.start, 0).unwrap().format("%d.%m %H:%M")))
            .collect()
    }

    fn pull(e: &Env, at: i64) {
        engine::refresh_calendar(&e.db, &e.factory, &e.cal, Clock { now: at, jitter: 0.5 }).unwrap();
    }

    fn writes(e: &Env) -> Vec<String> {
        e.fake.writes()
    }

    #[test]
    fn google_occurrence_paths() {
        let e = env();
        let master = row_id(&e, "s");
        assert_eq!(shown(&e).len(), 8);
        // AC-7.1.9: one occurrence is found at the service by its original start, then changed with the etag of that instance
        let slot = berlin(2026, 10, 27, 9, 0);
        let mut inp = input(&e, &master, "Weekly sync", berlin(2026, 10, 27, 11, 0), None, Some(slot));
        inp.scope = Some("occurrence".into());
        let got = save(&e.db, &e.factory, &inp, Scope::Occurrence).unwrap();
        assert_eq!((got.remote_kind.as_deref(), got.series_id.as_deref(), got.start), (Some("exception"), Some("s"), berlin(2026, 10, 27, 11, 0)));
        let w = writes(&e);
        assert!(w.last().unwrap().starts_with(&format!("update_occurrence:primary:s:{slot}:")), "{w:?}");
        let list = shown(&e);
        assert_eq!(list.len(), 8, "no duplicate at the old slot: {list:?}");
        assert!(list.contains(&"Weekly sync 27.10 11:00".to_string()) && !list.contains(&"Weekly sync 27.10 09:00".to_string()));
        // the next sync brings nothing new
        pull(&e, T0 + 60);
        assert_eq!(shown(&e), list);
        // the same occurrence again goes to its exception event with the stored etag
        let exc = row_id(&e, &format!("s_{slot}"));
        let mut again = input(&e, &exc, "Weekly sync", berlin(2026, 10, 27, 12, 0), None, None);
        again.scope = Some("occurrence".into());
        save(&e.db, &e.factory, &again, Scope::Occurrence).unwrap();
        assert!(writes(&e).last().unwrap().starts_with(&format!("update:primary:s_{slot}:")), "{:?}", writes(&e));
        assert!(shown(&e).contains(&"Weekly sync 27.10 12:00".to_string()));
        // AC-7.1.10: delete another occurrence: the instance is found and deleted, the slot stays empty
        let gone = berlin(2026, 11, 3, 9, 0);
        delete(&e.db, &e.factory, &master, Scope::Occurrence, Some(gone)).unwrap();
        assert!(writes(&e).last().unwrap().starts_with(&format!("delete_occurrence:primary:s:{gone}")), "{:?}", writes(&e));
        assert_eq!(shown(&e).len(), 7);
        pull(&e, T0 + 120);
        assert_eq!(shown(&e).len(), 7, "after the sync the slot stays empty");
        // deleting the changed occurrence deletes its exception event
        delete(&e.db, &e.factory, &exc, Scope::Occurrence, None).unwrap();
        assert!(writes(&e).last().unwrap().starts_with(&format!("delete:primary:s_{slot}:")), "{:?}", writes(&e));
        assert_eq!(shown(&e).len(), 6);
        pull(&e, T0 + 180);
        assert_eq!(shown(&e).len(), 6);
        // nothing changed: nothing is sent
        let before = writes(&e).len();
        let other = berlin(2026, 11, 10, 9, 0);
        let mut same = input(&e, &master, "Weekly sync", other, None, Some(other));
        same.scope = Some("occurrence".into());
        save(&e.db, &e.factory, &same, Scope::Occurrence).unwrap();
        assert_eq!(writes(&e).len(), before);
    }

    #[test]
    fn google_series_edits_send_only_what_changed() {
        let e = env();
        let master = row_id(&e, "s");
        let start = berlin(2026, 10, 13, 9, 0);
        // a title change: one PATCH of the master, no recurrence
        let inp = input(&e, &master, "Renamed", start, Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), None);
        save(&e.db, &e.factory, &inp, Scope::Series).unwrap();
        let w = writes(&e);
        let line = w.iter().rev().find(|l| l.starts_with("update:")).unwrap();
        assert!(line.contains("summary: Some(\"Renamed\")") && line.contains("recurrence: None") && line.contains("when: None"), "{line}");
        assert!(shown(&e).iter().all(|x| x.starts_with("Renamed")));
        // AC-7.1.12: the rule changes: the new recurrence travels whole, the deleted dates are not carried
        let inp = input(&e, &master, "Renamed", start, Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), None);
        save(&e.db, &e.factory, &inp, Scope::Series).unwrap();
        let w = writes(&e);
        assert!(w.iter().any(|l| l.starts_with("get_series:primary:s")), "the own date lists are asked for: {w:?}");
        let line = w.iter().rev().find(|l| l.starts_with("update:")).unwrap();
        assert!(line.contains("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), "{line}");
        assert_eq!(e.fake.event("primary", "s").unwrap().rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));
        // a time change keeps the zone of the series, whatever zone the form was in
        let ten = berlin(2026, 10, 13, 10, 0);
        let inp = input(&e, &master, "Renamed", ten, Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), None);
        save(&e.db, &e.factory, &inp, Scope::Series).unwrap();
        assert_eq!(e.fake.event("primary", "s").unwrap().tzid.as_deref(), Some("Europe/Berlin"));
        assert_eq!(e.fake.event("primary", "s").unwrap().start, ten);
    }

    #[test]
    fn google_split() {
        let e = env();
        let master = row_id(&e, "s");
        // an exception behind the cut, which the rows know
        let late = berlin(2026, 11, 17, 9, 0);
        let mut x = input(&e, &master, "Weekly sync", berlin(2026, 11, 17, 14, 0), None, Some(late));
        x.scope = Some("occurrence".into());
        save(&e.db, &e.factory, &x, Scope::Occurrence).unwrap();
        // AC-7.1.11: this and following from 10 Nov: the master is cut (PATCH with a smaller COUNT / UNTIL), a new event is created, the leftover exception goes
        let slot = berlin(2026, 11, 10, 9, 0);
        let mut f = input(&e, &master, "Late sync", slot, Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), Some(slot));
        f.scope = Some("following".into());
        let got = save(&e.db, &e.factory, &f, Scope::Following).unwrap();
        let w = writes(&e);
        let cut = w.iter().position(|l| l.starts_with("update:primary:s:")).expect("the master is cut");
        let create = w.iter().position(|l| l.starts_with("create:primary:Late sync:")).expect("the new series is created");
        assert!(cut < create, "{w:?}");
        assert!(w[cut].contains("COUNT=4"), "{}", w[cut]);
        assert!(w[create].ends_with("FREQ=WEEKLY;BYDAY=TU;COUNT=4"), "{}", w[create]);
        assert!(w.iter().any(|l| l.starts_with(&format!("delete:primary:s_{late}:"))), "the exception behind the cut is deleted: {w:?}");
        assert_eq!(got.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=4"));
        let list = shown(&e);
        assert_eq!(
            list,
            vec![
                "Weekly sync 13.10 09:00", "Weekly sync 20.10 09:00", "Weekly sync 27.10 09:00", "Weekly sync 03.11 09:00",
                "Late sync 10.11 09:00", "Late sync 17.11 09:00", "Late sync 24.11 09:00", "Late sync 01.12 09:00"
            ],
            "no gap, no duplicate"
        );
        pull(&e, T0 + 60);
        assert_eq!(shown(&e), list, "the same after the next sync");
    }

    #[test]
    fn a_failed_create_puts_the_cut_back() {
        let e = env();
        let master = row_id(&e, "s");
        let slot = berlin(2026, 11, 10, 9, 0);
        let mut f = input(&e, &master, "Late sync", slot, Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), Some(slot));
        f.scope = Some("following".into());
        // the cut goes through (write 1), the create fails (write 2), the restore (write 3) goes through
        e.fake.fail_write_number(2, SyncErr::Other("boom".into()));
        assert!(save(&e.db, &e.factory, &f, Scope::Following).is_err());
        let back = e.fake.event("primary", "s").unwrap();
        assert_eq!(back.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), "the series is as it was");
        assert_eq!(e.fake.count("primary"), 1, "no half-made second series");
    }

    #[test]
    fn a_series_is_deleted_or_cut_at_the_service() {
        let e = env();
        let master = row_id(&e, "s");
        let slot = berlin(2026, 11, 10, 9, 0);
        delete(&e.db, &e.factory, &master, Scope::Following, Some(slot)).unwrap();
        assert_eq!(shown(&e).len(), 4);
        assert!(writes(&e).iter().any(|l| l.contains("COUNT=4")));
        delete(&e.db, &e.factory, &master, Scope::Series, None).unwrap();
        assert!(e.fake.event("primary", "s").is_none());
        assert!(shown(&e).is_empty());
    }

    #[test]
    fn conflicts_and_read_only_series_are_reported_before_anything_changes() {
        let e = env();
        let master = row_id(&e, "s");
        // changed elsewhere after the app synced: 412, the service's version is shown
        e.fake.update_summary("primary", "s", "Changed on the phone");
        let start = berlin(2026, 10, 13, 9, 0);
        let err = save(&e.db, &e.factory, &input(&e, &master, "Mine", start, Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), None), Scope::Series).unwrap_err();
        assert!(err.starts_with("CAL_CONFLICT:"), "{err}");
        assert_eq!(calendar::get_event(&lock(&e.db), &master).unwrap().summary, "Changed on the phone");
        // somebody else's series
        let e = env();
        let mut other = e.fake.event("primary", "s").unwrap();
        other.can_edit = false;
        other.etag.clear();
        e.fake.add_event("primary", other);
        pull(&e, T0 + 60);
        let master = row_id(&e, "s");
        let slot = berlin(2026, 10, 20, 9, 0);
        let before = writes(&e).len();
        let mut inp = input(&e, &master, "x", slot, None, Some(slot));
        inp.scope = Some("occurrence".into());
        assert_eq!(save(&e.db, &e.factory, &inp, Scope::Occurrence).unwrap_err(), "CAL_READ_ONLY: Only the organizer can change this event.");
        assert_eq!(delete(&e.db, &e.factory, &master, Scope::Series, None).unwrap_err(), "CAL_READ_ONLY: Only the organizer can change this event.");
        assert_eq!(writes(&e).len(), before);
        // offline changes nothing
        let e = env();
        let master = row_id(&e, "s");
        e.fake.fail_next_write(SyncErr::Offline);
        let slot = berlin(2026, 10, 20, 9, 0);
        let mut inp = input(&e, &master, "x", berlin(2026, 10, 20, 10, 0), None, Some(slot));
        inp.scope = Some("occurrence".into());
        assert!(save(&e.db, &e.factory, &inp, Scope::Occurrence).unwrap_err().starts_with("CAL_OFFLINE"));
        assert_eq!(shown(&e).len(), 8);
        assert!(shown(&e).contains(&"Weekly sync 20.10 09:00".to_string()));
    }

    #[test]
    fn a_repeating_event_is_created_in_a_synced_calendar() {
        let e = env();
        let mut inp = input(&e, "x", "Daily", berlin(2026, 12, 1, 8, 0), Some("FREQ=DAILY"), None);
        inp.id = None;
        super::super::write::save(&e.db, &e.factory, &inp).unwrap();
        assert!(writes(&e).last().unwrap().ends_with("Daily:FREQ=DAILY"), "{:?}", writes(&e));
    }

    #[test]
    fn the_form_gets_the_values_of_the_part_it_edits() {
        let e = env();
        let master = row_id(&e, "s");
        let slot = berlin(2026, 10, 27, 9, 0);
        let d = get(&e.db, &e.factory, &master, Scope::Occurrence, Some(slot)).unwrap();
        assert_eq!((d.event.start, d.event.occurrence_start, d.changed_count), (slot, Some(slot), 0));
        let mut x = input(&e, &master, "Weekly sync", berlin(2026, 10, 27, 11, 0), None, Some(slot));
        x.scope = Some("occurrence".into());
        save(&e.db, &e.factory, &x, Scope::Occurrence).unwrap();
        // the changed occurrence shows its own time; the series knows one changed occurrence
        assert_eq!(get(&e.db, &e.factory, &master, Scope::Occurrence, Some(slot)).unwrap().event.start, berlin(2026, 10, 27, 11, 0));
        let s = get(&e.db, &e.factory, &master, Scope::Series, None).unwrap();
        assert_eq!((s.event.rrule.as_deref(), s.changed_count), (Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8"), 1));
        let f = get(&e.db, &e.factory, &master, Scope::Following, Some(berlin(2026, 11, 3, 9, 0))).unwrap();
        assert_eq!((f.changed_count, f.event.rrule.as_deref()), (0, Some("FREQ=WEEKLY;BYDAY=TU;COUNT=8")), "no changed occurrence from 3 Nov on");
        // a single event is not a series
        e.fake.add_event("primary", RemoteEvent::single("one", "Lunch", T0, T0 + 3600));
        pull(&e, T0 + 60);
        let one = row_id(&e, "one");
        assert!(get(&e.db, &e.factory, &one, Scope::Series, None).unwrap_err().starts_with("CAL_EVENT_NOT_FOUND"));
    }
}
