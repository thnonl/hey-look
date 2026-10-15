//! A provider that lives in memory, for the tests of the shared layer. It behaves like a service with sync tokens: a pull with a token
//! gets the changes since that token, a token it does not know is `Gone`, and writes check the etag.
use super::{CalProvider, EventDraft, EventKind, EventPatch, Kind, ProviderFactory, Pull, PullReq, RemoteCalendar, RemoteEvent, Rsvp, SyncErr};
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
    writes: Vec<String>,
    next_id: usize,
    version: usize,
    truncated: bool,
    rebaseline: Option<i64>,
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

    pub fn fail_next_write(&self, e: SyncErr) {
        self.g().fail_write.push(e);
    }

    pub fn set_truncated(&self, t: bool) {
        self.g().truncated = t;
    }

    pub fn set_rebaseline(&self, days: Option<i64>) {
        self.g().rebaseline = days;
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
            None => Pull { upserts: all, removed: vec![], next_state: Some(token.clone()), full: true, truncated },
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
                Pull { upserts, removed, next_state: Some(token.clone()), full: false, truncated }
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
        self.g().writes.push(format!("create:{}:{}", cal.id, ev.summary));
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
        Ok(())
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
