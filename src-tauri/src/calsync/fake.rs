//! A provider that lives in memory, for the tests of the shared layer. It behaves like a service with sync tokens: a pull with a token
//! gets the changes since that token, a token it does not know is `Gone`, and writes check the etag.
use super::{CalList, CalProvider, EventDraft, EventKind, EventPatch, Kind, ProviderFactory, Pull, PullReq, RemoteCalendar, RemoteEvent, Rsvp, SyncErr};
use crate::calendar::CalAttendee;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Inner {
    calendars: Vec<RemoteCalendar>,
    events: HashMap<String, Vec<RemoteEvent>>,
    /// per calendar: what changed, in order (`true` = upserted, `false` = removed)
    log: HashMap<String, Vec<(String, bool)>>,
    /// token -> position in the log of its calendar
    tokens: HashMap<String, usize>,
    issued: HashMap<String, usize>,
    pulls: Vec<(String, PullReq)>,
    list_calls: usize,
    fail_list: Vec<SyncErr>,
    fail_pull: HashMap<String, Vec<SyncErr>>,
    fail_pull_forever: HashMap<String, SyncErr>,
    fail_write: Vec<SyncErr>,
    /// fail the n-th write from now (counted over every write call), once
    fail_number: Option<(usize, SyncErr)>,
    write_calls: usize,
    writes: Vec<String>,
    next_id: usize,
    version: usize,
    truncated: bool,
    rebaseline: Option<i64>,
    /// the list answers like Google's `calendarList` with a sync token (see `enable_list_tokens`)
    list_tokens_on: bool,
    /// what changed in the calendar list, in order (`true` = new or changed, `false` = removed)
    list_log: Vec<(String, bool)>,
    list_token_pos: HashMap<String, usize>,
    list_issued: usize,
    /// the token each list request carried
    list_requests: Vec<Option<String>>,
}

#[derive(Clone, Default)]
pub struct FakeProvider(Arc<Mutex<Inner>>);

impl FakeProvider {
    pub fn new() -> FakeProvider {
        FakeProvider::default()
    }

    fn g(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_calendars(&self, cals: Vec<RemoteCalendar>) {
        self.g().calendars = cals;
    }

    pub fn add_event(&self, cal: &str, ev: RemoteEvent) {
        let mut g = self.g();
        g.version += 1;
        let mut ev = ev;
        if ev.etag.is_empty() {
            ev.etag = format!("\"v{}\"", g.version);
        }
        let id = ev.id.clone();
        let list = g.events.entry(cal.to_string()).or_default();
        list.retain(|e| e.id != id);
        list.push(ev);
        g.log.entry(cal.to_string()).or_default().push((id, true));
    }

    pub fn update_summary(&self, cal: &str, id: &str, summary: &str) {
        let mut ev = self.event(cal, id).expect("event");
        ev.summary = summary.into();
        ev.etag.clear();
        self.add_event(cal, ev);
    }

    pub fn delete_event(&self, cal: &str, id: &str) {
        let mut g = self.g();
        if let Some(l) = g.events.get_mut(cal) {
            l.retain(|e| e.id != id);
        }
        g.log.entry(cal.to_string()).or_default().push((id.to_string(), false));
    }

    /// Gone from the service without any change record: only a full download shows it.
    pub fn remove_event_silently(&self, cal: &str, id: &str) {
        if let Some(l) = self.g().events.get_mut(cal) {
            l.retain(|e| e.id != id);
        }
    }

    pub fn event(&self, cal: &str, id: &str) -> Option<RemoteEvent> {
        self.g().events.get(cal)?.iter().find(|e| e.id == id).cloned()
    }

    pub fn count(&self, cal: &str) -> usize {
        self.g().events.get(cal).map(|l| l.len()).unwrap_or(0)
    }

    pub fn expire_tokens(&self) {
        self.g().tokens.clear();
    }

    pub fn fail_next_list(&self, e: SyncErr) {
        self.g().fail_list.push(e);
    }

    pub fn fail_next_pull(&self, cal: &str, e: SyncErr) {
        self.g().fail_pull.entry(cal.to_string()).or_default().push(e);
    }

    pub fn fail_pull_forever(&self, cal: &str, e: SyncErr) {
        self.g().fail_pull_forever.insert(cal.to_string(), e);
    }

    /// The `n`-th write call from now on (1 = the next one) fails with `e`; the others go through.
    pub fn fail_write_number(&self, n: usize, e: SyncErr) {
        let mut g = self.g();
        g.write_calls = 0;
        g.fail_number = Some((n, e));
    }

    pub fn fail_next_write(&self, e: SyncErr) {
        self.g().fail_write.push(e);
    }

    pub fn set_truncated(&self, t: bool) {
        self.g().truncated = t;
    }

    pub fn set_rebaseline(&self, days: Option<i64>) {
        self.g().rebaseline = days;
    }

    /// The calendar list gets sync tokens: a request with a token brings the changes since it, a token it does not know is `Gone`.
    pub fn enable_list_tokens(&self) {
        self.g().list_tokens_on = true;
    }

    pub fn expire_list_tokens(&self) {
        self.g().list_token_pos.clear();
    }

    pub fn rename_calendar(&self, id: &str, name: &str) {
        let mut g = self.g();
        if let Some(c) = g.calendars.iter_mut().find(|c| c.id == id) {
            c.name = name.into();
        }
        g.list_log.push((id.to_string(), true));
    }

    pub fn add_calendar(&self, cal: RemoteCalendar) {
        let mut g = self.g();
        g.list_log.push((cal.id.clone(), true));
        g.calendars.push(cal);
    }

    pub fn delete_calendar(&self, id: &str) {
        let mut g = self.g();
        g.calendars.retain(|c| c.id != id);
        g.list_log.push((id.to_string(), false));
    }

    /// The token (if any) of every list request so far.
    pub fn list_requests(&self) -> Vec<Option<String>> {
        self.g().list_requests.clone()
    }

    /// How many pulls a calendar got.
    pub fn pull_count(&self, cal: &str) -> usize {
        self.g().pulls.iter().filter(|(c, _)| c == cal).count()
    }

    pub fn last_pull(&self, cal: &str) -> Option<PullReq> {
        self.g().pulls.iter().rev().find(|(c, _)| c == cal).map(|(_, r)| r.clone())
    }

    pub fn list_calls(&self) -> usize {
        self.g().list_calls
    }

    pub fn writes(&self) -> Vec<String> {
        self.g().writes.clone()
    }

    fn check_write(&self) -> Result<(), SyncErr> {
        let mut g = self.g();
        g.write_calls += 1;
        if let Some((n, _)) = &g.fail_number {
            if *n == g.write_calls {
                return Err(g.fail_number.take().map(|(_, e)| e).unwrap());
            }
        }
        if g.fail_write.is_empty() { Ok(()) } else { Err(g.fail_write.remove(0)) }
    }
}

impl CalProvider for FakeProvider {
    fn list_calendars(&self) -> Result<Vec<RemoteCalendar>, SyncErr> {
        let mut g = self.g();
        g.list_calls += 1;
        if !g.fail_list.is_empty() {
            return Err(g.fail_list.remove(0));
        }
        Ok(g.calendars.clone())
    }

    fn list_calendars_since(&self, state: Option<&str>) -> Result<CalList, SyncErr> {
        if !self.g().list_tokens_on {
            return Ok(CalList { calendars: self.list_calendars()?, removed: vec![], full: true, next_state: None });
        }
        let mut g = self.g();
        g.list_calls += 1;
        g.list_requests.push(state.map(String::from));
        if !g.fail_list.is_empty() {
            return Err(g.fail_list.remove(0));
        }
        let log_len = g.list_log.len();
        let token = format!("ltok-{}", g.list_issued);
        g.list_issued += 1;
        let out = match state {
            None => CalList { calendars: g.calendars.clone(), removed: vec![], full: true, next_state: Some(token.clone()) },
            Some(t) => {
                let from = *g.list_token_pos.get(t).ok_or(SyncErr::Gone)?;
                let mut calendars: Vec<RemoteCalendar> = vec![];
                let mut removed: Vec<String> = vec![];
                for (id, up) in g.list_log.iter().skip(from) {
                    calendars.retain(|c| &c.id != id);
                    removed.retain(|r| r != id);
                    if *up {
                        calendars.extend(g.calendars.iter().find(|c| &c.id == id).cloned());
                    } else {
                        removed.push(id.clone());
                    }
                }
                CalList { calendars, removed, full: false, next_state: Some(token.clone()) }
            }
        };
        g.list_token_pos.insert(token, log_len);
        Ok(out)
    }

    fn pull(&self, cal: &RemoteCalendar, req: &PullReq) -> Result<Pull, SyncErr> {
        let mut g = self.g();
        g.pulls.push((cal.id.clone(), req.clone()));
        if let Some(e) = g.fail_pull_forever.get(&cal.id) {
            return Err(e.clone());
        }
        if let Some(list) = g.fail_pull.get_mut(&cal.id) {
            if !list.is_empty() {
                return Err(list.remove(0));
            }
        }
        let log_len = g.log.get(&cal.id).map(|l| l.len()).unwrap_or(0);
        let n = g.issued.entry(cal.id.clone()).or_insert(0);
        let token = format!("tok-{n}");
        *n += 1;
        let truncated = g.truncated;
        let all = g.events.get(&cal.id).cloned().unwrap_or_default();
        let pull = match &req.state {
            None => Pull { upserts: all, removed: vec![], next_state: Some(token.clone()).filter(|_| !truncated), full: true, truncated, ..Default::default() },
            Some(t) => {
                let from = *g.tokens.get(t).ok_or(SyncErr::Gone)?;
                let log = g.log.get(&cal.id).cloned().unwrap_or_default();
                let mut upserts: Vec<RemoteEvent> = vec![];
                let mut removed: Vec<String> = vec![];
                for (id, up) in log.iter().skip(from) {
                    upserts.retain(|e| &e.id != id);
                    removed.retain(|r| r != id);
                    if *up {
                        if let Some(e) = all.iter().find(|e| &e.id == id) {
                            upserts.push(e.clone());
                        }
                    } else {
                        removed.push(id.clone());
                    }
                }
                Pull { upserts, removed, next_state: Some(token.clone()), full: false, truncated, ..Default::default() }
            }
        };
        g.tokens.insert(token, log_len);
        Ok(pull)
    }

    fn create(&self, cal: &RemoteCalendar, ev: &EventDraft) -> Result<RemoteEvent, SyncErr> {
        self.check_write()?;
        let id = {
            let mut g = self.g();
            g.next_id += 1;
            format!("new-{}", g.next_id)
        };
        let mut re = RemoteEvent::single(&id, &ev.summary, ev.start, ev.end);
        re.all_day = ev.all_day;
        re.tzid = ev.tzid.clone();
        re.location = ev.location.clone();
        re.description = ev.description.clone();
        re.attendees = ev.attendees.clone();
        re.reminder_min = ev.reminder_min;
        re.uid = format!("{id}@fake");
        if let Some(r) = &ev.rrule {
            re.rrule = Some(r.clone());
            re.kind = EventKind::Master;
        }
        self.g().writes.push(format!("create:{}:{}:{}", cal.id, ev.summary, ev.rrule.clone().unwrap_or_default()));
        self.add_event(&cal.id, re);
        Ok(self.event(&cal.id, &id).unwrap())
    }

    fn update(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, changed: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        self.check_write()?;
        let mut cur = self.event(&cal.id, remote_id).ok_or(SyncErr::NotFound)?;
        if cur.etag != etag {
            return Err(SyncErr::Conflict);
        }
        if let Some(s) = &changed.summary {
            cur.summary = s.clone();
        }
        if let Some(w) = &changed.when {
            cur.start = w.start;
            cur.end = w.end;
            cur.all_day = w.all_day;
            cur.tzid = w.tzid.clone();
        }
        if let Some(l) = &changed.location {
            cur.location = l.clone();
        }
        if let Some(d) = &changed.description {
            cur.description = d.clone();
        }
        if let Some(a) = &changed.attendees {
            cur.attendees = a.clone();
        }
        if let Some(r) = &changed.reminder_min {
            cur.reminder_min = *r;
        }
        if let Some(rec) = &changed.recurrence {
            cur.rrule = rec.rrule.clone();
            cur.exdates = rec.exdates.clone();
            cur.rdates = rec.rdates.clone();
            cur.kind = if rec.rrule.is_some() || !rec.rdates.is_empty() { EventKind::Master } else { EventKind::Single };
        }
        cur.etag.clear();
        self.g().writes.push(format!("update:{}:{remote_id}:{etag}:{changed:?}", cal.id));
        self.add_event(&cal.id, cur);
        Ok(self.event(&cal.id, remote_id).unwrap())
    }

    fn delete(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str) -> Result<(), SyncErr> {
        self.check_write()?;
        let cur = self.event(&cal.id, remote_id).ok_or(SyncErr::NotFound)?;
        if cur.etag != etag {
            return Err(SyncErr::Conflict);
        }
        self.g().writes.push(format!("delete:{}:{remote_id}:{etag}", cal.id));
        self.delete_event(&cal.id, remote_id);
        // (a series takes its exceptions along)
        let kids: Vec<String> = self.g().events.get(&cal.id).map(|l| l.iter().filter(|e| e.series_id.as_deref() == Some(remote_id)).map(|e| e.id.clone()).collect()).unwrap_or_default();
        for k in kids {
            self.delete_event(&cal.id, &k);
        }
        Ok(())
    }

    fn get_series(&self, cal: &RemoteCalendar, series_id: &str) -> Result<RemoteEvent, SyncErr> {
        self.g().writes.push(format!("get_series:{}:{series_id}", cal.id));
        self.event(&cal.id, series_id).filter(|e| e.kind == EventKind::Master).ok_or(SyncErr::NotFound)
    }

    fn update_occurrence(&self, cal: &RemoteCalendar, series_id: &str, original_start: i64, all_day: bool, changed: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        self.check_write()?;
        let master = self.event(&cal.id, series_id).ok_or(SyncErr::NotFound)?;
        let id = format!("{series_id}_{original_start}");
        let mut cur = self.event(&cal.id, &id).unwrap_or_else(|| {
            let mut i = master.clone();
            i.id = id.clone();
            i.kind = EventKind::Exception;
            i.series_id = Some(series_id.to_string());
            i.recurrence_id = Some(original_start);
            i.start = original_start;
            i.end = original_start + (master.end - master.start);
            i.all_day = all_day;
            i.rrule = None;
            i.exdates = vec![];
            i.rdates = vec![];
            i
        });
        if let Some(s) = &changed.summary {
            cur.summary = s.clone();
        }
        if let Some(w) = &changed.when {
            cur.start = w.start;
            cur.end = w.end;
        }
        if let Some(l) = &changed.location {
            cur.location = l.clone();
        }
        if let Some(d) = &changed.description {
            cur.description = d.clone();
        }
        cur.etag.clear();
        self.g().writes.push(format!("update_occurrence:{}:{series_id}:{original_start}:{changed:?}", cal.id));
        self.add_event(&cal.id, cur);
        Ok(self.event(&cal.id, &id).unwrap())
    }

    fn delete_occurrence(&self, cal: &RemoteCalendar, series_id: &str, original_start: i64, all_day: bool) -> Result<String, SyncErr> {
        self.check_write()?;
        let master = self.event(&cal.id, series_id).ok_or(SyncErr::NotFound)?;
        let id = format!("{series_id}_{original_start}");
        let mut gone = master.clone();
        gone.id = id.clone();
        gone.kind = EventKind::Exception;
        gone.series_id = Some(series_id.to_string());
        gone.recurrence_id = Some(original_start);
        gone.start = original_start;
        gone.all_day = all_day;
        gone.rrule = None;
        gone.status = "cancelled".into();
        gone.etag.clear();
        self.g().writes.push(format!("delete_occurrence:{}:{series_id}:{original_start}", cal.id));
        self.add_event(&cal.id, gone);
        Ok(id)
    }

    fn respond(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, status: Rsvp, me: &str, _attendees: &[CalAttendee]) -> Result<(), SyncErr> {
        self.check_write()?;
        let cur = self.event(&cal.id, remote_id).ok_or(SyncErr::NotFound)?;
        if cur.etag != etag {
            return Err(SyncErr::Conflict);
        }
        self.g().writes.push(format!("respond:{}:{remote_id}:{status:?}:{me}", cal.id));
        Ok(())
    }

    fn rebaseline_after_days(&self) -> Option<i64> {
        self.g().rebaseline
    }
}

/// Hands out the same fake provider, or fails like a source whose credentials are gone.
pub struct FakeFactory {
    provider: FakeProvider,
    fail: Option<SyncErr>,
}

impl FakeFactory {
    pub fn new(provider: FakeProvider) -> FakeFactory {
        FakeFactory { provider, fail: None }
    }

    pub fn failing(e: SyncErr) -> FakeFactory {
        FakeFactory { provider: FakeProvider::new(), fail: Some(e) }
    }
}

impl ProviderFactory for FakeFactory {
    fn provider(&self, source: &super::store::Source) -> Result<Box<dyn CalProvider>, SyncErr> {
        let _ = source.kind == Kind::Google;
        match &self.fail {
            Some(e) => Err(e.clone()),
            None => Ok(Box::new(self.provider.clone())),
        }
    }
}

/// A repeating event for tests that need a series.
pub fn series(id: &str, summary: &str, start: i64, rrule: &str) -> RemoteEvent {
    let mut e = RemoteEvent::single(id, summary, start, start + 3600);
    e.kind = EventKind::Master;
    e.rrule = Some(rrule.into());
    e
}
