//! One sync round of a source and the scheduler that decides which sources are due.
use super::store::{self, CalRow, Source};
use super::{CalProvider, ProviderFactory, PullReq, SyncErr};
use super::{AUTH, BLOCKED, BUSY, ERROR, NOT_SET_UP, OFFLINE, SYNCING, SYNC_INTERVAL, WINDOW_FUTURE_DAYS, WINDOW_PAST_DAYS};
use crate::db::R;
use crate::{lock, Db};
use std::collections::HashSet;

const DAY: i64 = 86_400;
/// How long a source without a connection waits before it tries again.
const OFFLINE_RETRY_SECS: i64 = 60;
/// The longest back-off (30 minutes).
const BACKOFF_MAX_SECS: i64 = 1800;
/// A truncated calendar (over the event cap, so without a token) is downloaded in full again at the earliest after this.
const FULL_AGAIN_SECS: i64 = DAY;

/// Time and luck as inputs, so a test can run a round at a chosen moment.
#[derive(Clone, Copy, Debug)]
pub struct Clock {
    pub now: i64,
    /// 0..1, spreads retries of many installations (+-10 %)
    pub jitter: f64,
}

impl Clock {
    pub fn real() -> Clock {
        Clock { now: chrono::Utc::now().timestamp(), jitter: rand::random::<f64>() }
    }
}

/// Seconds to wait after the `fail_count`-th failure in a row: 1, 2, 4 ... minutes, at most 30, with +-10 % jitter.
pub fn backoff_secs(fail_count: i64, jitter: f64) -> i64 {
    let n = fail_count.clamp(1, 12) as u32;
    let base = (60i64 << (n - 1)).min(BACKOFF_MAX_SECS) as f64;
    let spread = (jitter.clamp(0.0, 1.0) - 0.5) * 0.2;
    ((base * (1.0 + spread)) as i64).min(BACKOFF_MAX_SECS)
}

/// Is a sync of this source due? Access that ended, an organization that blocks the app and a missing setup wait for the user
/// (`Allow access again`); a back-off is honoured, also for `Sync now` while the service says it is busy.
pub fn is_due(s: &Source, now: i64, requested: bool) -> bool {
    if matches!(s.status.as_str(), AUTH | BLOCKED | NOT_SET_UP) {
        return false;
    }
    if let Some(at) = s.retry_at {
        if at > now && !(requested && s.status != BUSY) {
            return false;
        }
    }
    if requested {
        return true;
    }
    if matches!(s.status.as_str(), ERROR | OFFLINE | BUSY) {
        return true; // its retry time has come
    }
    match s.last_sync {
        None => true,
        Some(t) => now - t >= SYNC_INTERVAL,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub source_id: String,
    /// events or calendars changed
    pub changed: bool,
    /// the status the source ended in
    pub status: String,
}

/// Run the sources that are due. `requested` = mailboxes whose sync was asked for. `notify` is called when the data or a status
/// changed (the UI reloads then). Sources run one after the other, so a mailbox never has two rounds at once.
pub fn tick(db: &Db, factory: &dyn ProviderFactory, clock: Clock, requested: &HashSet<String>, notify: &dyn Fn()) -> Vec<Report> {
    let sources = store::list_sources(&lock(db)).unwrap_or_default();
    let mut out = vec![];
    for s in sources {
        if !s.kind.enabled() || !is_due(&s, clock.now, requested.contains(&s.account_id)) {
            continue;
        }
        if let Some(r) = sync_source(db, factory, &s.id, clock, notify) {
            out.push(r);
        }
    }
    out
}

/// One round: the calendar list, then the pull of every calendar that syncs. Records the outcome in the source.
pub fn sync_source(db: &Db, factory: &dyn ProviderFactory, source_id: &str, clock: Clock, notify: &dyn Fn()) -> Option<Report> {
    let src = store::get_source(&lock(db), source_id)?;
    let _ = store::set_status(&lock(db), &src.id, SYNCING, None, None, src.fail_count);
    notify();
    let result = match factory.provider(&src) {
        Ok(p) => round(db, &*p, &src, clock),
        Err(e) => Err(e),
    };
    let (changed, status) = {
        let c = lock(db);
        match result {
            Ok(changed) => {
                let _ = store::mark_synced(&c, &src.id, clock.now);
                (changed, super::OK.to_string())
            }
            Err(e) => {
                let (status, text, retry_at, fails) = classify(&e, src.fail_count, clock);
                let _ = store::set_status(&c, &src.id, status, text.as_deref(), retry_at, fails);
                (false, status.to_string())
            }
        }
    };
    notify();
    Some(Report { source_id: src.id, changed, status })
}

/// The state a failed round leaves the source in: (status, what the provider reported, retry time, failures in a row).
pub fn classify(e: &SyncErr, fail_count: i64, clock: Clock) -> (&'static str, Option<String>, Option<i64>, i64) {
    let fails = fail_count + 1;
    match e {
        SyncErr::Auth => (AUTH, None, None, 0),
        SyncErr::Blocked(t) => (BLOCKED, Some(t.clone()), None, 0),
        SyncErr::NotSetUp(t) => (NOT_SET_UP, Some(t.clone()), None, 0),
        SyncErr::RateLimited(after) => {
            let wait = after.map(|d| d.as_secs() as i64).filter(|s| *s > 0).unwrap_or_else(|| backoff_secs(fails, clock.jitter));
            (BUSY, None, Some(clock.now + wait), fails)
        }
        SyncErr::Offline => (OFFLINE, None, Some(clock.now + OFFLINE_RETRY_SECS), fail_count),
        other => (ERROR, Some(other.to_string()), Some(clock.now + backoff_secs(fails, clock.jitter)), fails),
    }
}

fn round(db: &Db, provider: &dyn CalProvider, src: &Source, clock: Clock) -> Result<bool, SyncErr> {
    // the calendar list: only the changes since the last round when the provider can tell (Google), the whole list after a token it no
    // longer knows (410: no error state, one full list) or when it has no token
    let list = match provider.list_calendars_since(src.list_state.as_deref()) {
        Err(SyncErr::Gone) if src.list_state.is_some() => provider.list_calendars_since(None)?,
        other => other?,
    };
    let mut changed = {
        let c = lock(db);
        let changed = if list.full {
            store::reconcile_calendars(&c, src, &list.calendars).map_err(SyncErr::Other)?
        } else {
            store::apply_calendar_delta(&c, src, &list.calendars, &list.removed).map_err(SyncErr::Other)?
        };
        store::set_list_state(&c, &src.id, list.next_state.as_deref()).map_err(SyncErr::Other)?;
        changed
    };
    if list.full {
        crate::startup::line("calsync", &format!("{} calendar list: full, {} calendars", src.account_id, list.calendars.len()));
    } else {
        crate::startup::line("calsync", &format!("{} calendar list: incremental, {} changed, {} removed", src.account_id, list.calendars.len(), list.removed.len()));
    }
    let cals = store::calendars_of(&lock(db), &src.id).map_err(SyncErr::Other)?;
    for cal in cals.into_iter().filter(|c| c.sync_on) {
        changed |= pull_calendar(db, provider, &cal, &src.account_id, clock)?;
    }
    Ok(changed)
}

/// Pull one calendar and apply it with its new token. A token the service no longer knows (410) means: download the window again.
/// A calendar that is gone (404) is removed here. Returns whether anything changed.
pub fn pull_calendar(db: &Db, provider: &dyn CalProvider, cal: &CalRow, account_id: &str, clock: Clock) -> Result<bool, SyncErr> {
    let window_from = clock.now - WINDOW_PAST_DAYS * DAY;
    let window_to = clock.now + WINDOW_FUTURE_DAYS * DAY;
    let mut state = cal.sync_state.clone();
    // a calendar over the event cap has no token (the rest was never read): its full download is repeated at most once a day, in between
    // it is not requested and keeps showing what the last one brought
    if let (true, None, Some(at)) = (cal.truncated, &state, cal.full_at) {
        if clock.now - at < FULL_AGAIN_SECS {
            crate::startup::line("calsync", &format!("{} skipped: truncated, next full download after {}", cal.id, chrono::DateTime::from_timestamp(at + FULL_AGAIN_SECS, 0).unwrap_or_default().format("%Y-%m-%d %H:%M UTC")));
            return Ok(false);
        }
    }
    // a delta token that only covers a window is started again when the window has aged (Microsoft)
    if let (Some(days), Some(_), Some(from)) = (provider.rebaseline_after_days(), &state, cal.window_from) {
        if window_from - from > days * DAY {
            state = None;
        }
    }
    let mut resynced = false;
    loop {
        let req = PullReq { state: state.clone(), window_from, window_to };
        match provider.pull(&cal.remote(), &req) {
            Ok(mut pull) => {
                if state.is_none() {
                    pull.full = true;
                }
                let from = pull.full.then_some(window_from);
                return store::apply_pull(&lock(db), cal, account_id, &pull, from, clock.now).map_err(SyncErr::Other);
            }
            Err(SyncErr::Gone) if state.is_some() && !resynced => {
                state = None;
                resynced = true;
            }
            Err(SyncErr::Gone) => return Err(SyncErr::Other("the sync token was rejected for a full download".into())),
            Err(SyncErr::NotFound) => {
                let c = lock(db);
                store::drop_calendar(&c, &cal.id).map_err(SyncErr::Other)?;
                return Ok(true);
            }
            Err(e) => return Err(e),
        }
    }
}

/// Pull one calendar now (after a conflicting write, so the server version is what is shown). Errors are for the caller to ignore.
pub fn refresh_calendar(db: &Db, factory: &dyn ProviderFactory, calendar_id: &str, clock: Clock) -> R<bool> {
    let (cal, src) = {
        let c = lock(db);
        let cal = store::get_calendar(&c, calendar_id).ok_or("calendar not found")?;
        let src = store::get_source(&c, &cal.source_id).ok_or("calendar source not found")?;
        (cal, src)
    };
    let provider = factory.provider(&src).map_err(|e| e.to_string())?;
    pull_calendar(db, &*provider, &cal, &src.account_id, clock).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::fake::*;
    use super::super::store::tests::{conn, rc, ACC};
    use super::super::*;
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn clock(now: i64) -> Clock {
        Clock { now, jitter: 0.5 }
    }

    fn db_with_source() -> (Db, String) {
        let c = conn();
        let s = store::create_source(&c, ACC, Kind::Google, 0).unwrap();
        (Arc::new(Mutex::new(c)), s.id)
    }

    fn src(db: &Db, id: &str) -> Source {
        store::get_source(&lock(db), id).unwrap()
    }

    fn rows(db: &Db) -> Vec<String> {
        let c = lock(db);
        let mut st = c.prepare("SELECT summary FROM events WHERE remote_id IS NOT NULL ORDER BY starts_at").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    const T0: i64 = 1_800_000_000;

    #[test]
    fn backoff_doubles_from_a_minute_up_to_thirty_with_jitter() {
        let secs: Vec<i64> = (1..=8).map(|n| backoff_secs(n, 0.5)).collect();
        assert_eq!(secs, vec![60, 120, 240, 480, 960, 1800, 1800, 1800]);
        assert_eq!(backoff_secs(1, 0.0), 54);
        assert_eq!(backoff_secs(1, 1.0), 66);
        assert_eq!(backoff_secs(9, 1.0), 1800, "the cap holds with jitter");
        assert_eq!(backoff_secs(0, 0.5), 60);
        assert_eq!(backoff_secs(1_000, 0.5), 1800);
    }

    #[test]
    fn due_rules() {
        let mut s = Source { id: "s".into(), account_id: "a".into(), kind: Kind::Google, status: OK.into(), last_sync: Some(1000), last_error: None, retry_at: None, fail_count: 0, connected_at: 0, list_state: None };
        assert!(!is_due(&s, 1000 + SYNC_INTERVAL - 1, false), "synced a moment ago");
        assert!(is_due(&s, 1000 + SYNC_INTERVAL, false), "every 5 minutes");
        assert!(is_due(&s, 1001, true), "Sync now / after an edit");
        s.last_sync = None;
        assert!(is_due(&s, 5, false), "never synced");
        // access ended / blocked / not set up: nothing runs, not even on request
        for st in [AUTH, BLOCKED, NOT_SET_UP] {
            s.status = st.into();
            assert!(!is_due(&s, 99_999, true) && !is_due(&s, 99_999, false), "{st}");
        }
        // busy: honours the retry time, also for a request; then it runs by itself
        s.status = BUSY.into();
        s.retry_at = Some(2000);
        assert!(!is_due(&s, 1999, false) && !is_due(&s, 1999, true));
        assert!(is_due(&s, 2000, false));
        // offline: a request does not wait for the retry time (the network may be back)
        s.status = OFFLINE.into();
        s.retry_at = Some(2000);
        assert!(!is_due(&s, 1500, false) && is_due(&s, 1500, true) && is_due(&s, 2000, false));
        s.status = ERROR.into();
        assert!(!is_due(&s, 1500, false) && is_due(&s, 2500, false));
    }

    #[test]
    fn the_first_round_lists_the_calendars_and_downloads_the_ones_that_sync() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me"), RemoteCalendar { selected: false, ..rc("other", "Other") }]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        fake.add_event("other", RemoteEvent::single("z", "Z", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        let r = sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!((r.changed, r.status.as_str()), (true, "ok"));
        assert_eq!(rows(&db), vec!["A"], "the calendar that is not shown at the provider is not downloaded");
        let s = src(&db, &sid);
        assert_eq!((s.status.as_str(), s.last_sync, s.last_error, s.retry_at), ("ok", Some(T0), None, None));
        // the window of the first download: a year back, two years ahead
        let req = fake.last_pull("primary").unwrap();
        assert_eq!((req.state, req.window_from, req.window_to), (None, T0 - 365 * DAY, T0 + 730 * DAY));
        // the token is kept; the next round asks for the changes since it
        fake.add_event("primary", RemoteEvent::single("b", "B", T0 + 10, T0 + 3600));
        sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        assert_eq!(fake.last_pull("primary").unwrap().state.as_deref(), Some("tok-0"));
        assert_eq!(rows(&db), vec!["A", "B"]);
    }

    #[test]
    fn a_failed_calendar_keeps_the_token_of_the_last_good_round() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        let cal_id = calendar_id(ACC, Kind::Google, "primary");
        fake.add_event("primary", RemoteEvent::single("b", "B", T0 + 10, T0 + 3600));
        fake.fail_next_pull("primary", SyncErr::Other("HTTP 418".into()));
        sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        assert_eq!(store::get_calendar(&lock(&db), &cal_id).unwrap().sync_state.as_deref(), Some("tok-0"));
        assert_eq!(rows(&db), vec!["A"], "nothing of the failed pull is applied");
        // the next round gets the change
        sync_source(&db, &factory, &sid, clock(T0 + 900), &|| {}).unwrap();
        assert_eq!(rows(&db), vec!["A", "B"]);
    }

    #[test]
    fn a_410_downloads_everything_again_without_duplicates_and_without_error() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        fake.add_event("primary", RemoteEvent::single("b", "B", T0 + 5, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        // the token expires, and "b" was deleted in the meantime
        fake.expire_tokens();
        fake.remove_event_silently("primary", "b");
        let r = sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        assert_eq!(r.status, "ok");
        assert_eq!(rows(&db), vec!["A"]);
        let s = src(&db, &sid);
        assert_eq!((s.status.as_str(), s.last_error, s.fail_count), ("ok", None, 0));
        assert_eq!(fake.last_pull("primary").unwrap().state, None, "the second request was a full one");
    }

    #[test]
    fn remote_deletions_remove_rows_and_leave_no_duplicates_on_update() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        fake.update_summary("primary", "a", "A2");
        sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        assert_eq!(rows(&db), vec!["A2"]);
        fake.delete_event("primary", "a");
        sync_source(&db, &factory, &sid, clock(T0 + 600), &|| {}).unwrap();
        assert!(rows(&db).is_empty());
    }

    #[test]
    fn error_states_and_their_retry_times() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        let factory = FakeFactory::new(fake.clone());
        let status = |db: &Db| {
            let s = src(db, &sid);
            (s.status, s.last_error, s.retry_at, s.fail_count)
        };
        let case = |e: SyncErr, now: i64| {
            fake.fail_next_list(e);
            sync_source(&db, &factory, &sid, clock(now), &|| {}).unwrap();
            status(&db)
        };
        // 429 with Retry-After: no retry before it, no matter what
        assert_eq!(case(SyncErr::RateLimited(Some(Duration::from_secs(120))), T0), (BUSY.into(), None, Some(T0 + 120), 1));
        // 5xx without Retry-After: 2 min after the second failure in a row
        assert_eq!(case(SyncErr::RateLimited(None), T0 + 120), (BUSY.into(), None, Some(T0 + 120 + 120), 2));
        // offline: the fail count does not grow (it is not the service's fault), retry in a minute
        assert_eq!(case(SyncErr::Offline, T0 + 300), (OFFLINE.into(), None, Some(T0 + 360), 2));
        // other errors back off 1, 2, 4 ... and show the reason
        assert_eq!(case(SyncErr::Other("HTTP 500: x".into()), T0 + 400), (ERROR.into(), Some("HTTP 500: x".into()), Some(T0 + 400 + 240), 3));
        // access ended: no retry at all
        assert_eq!(case(SyncErr::Auth, T0 + 700), (AUTH.into(), None, None, 0));
        assert_eq!(case(SyncErr::Blocked("admin approval".into()), T0 + 800), (BLOCKED.into(), Some("admin approval".into()), None, 0));
        assert_eq!(case(SyncErr::NotSetUp("API off".into()), T0 + 900), (NOT_SET_UP.into(), Some("API off".into()), None, 0));
        // a good round clears everything
        let mut s = src(&db, &sid);
        s.status = ERROR.into();
        store::set_status(&lock(&db), &sid, ERROR, Some("x"), Some(1), 4).unwrap();
        sync_source(&db, &factory, &sid, clock(T0 + 1000), &|| {}).unwrap();
        assert_eq!(status(&db), ("ok".into(), None, None, 0));
    }

    #[test]
    fn scheduler_skips_busy_sources_and_runs_due_ones_and_honours_retry_after() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        let factory = FakeFactory::new(fake.clone());
        let none = HashSet::new();
        let seen = Arc::new(Mutex::new(0));
        let n2 = seen.clone();
        let notify = move || *n2.lock().unwrap() += 1;
        // first tick: never synced -> runs
        assert_eq!(tick(&db, &factory, clock(T0), &none, &notify).len(), 1);
        assert!(*seen.lock().unwrap() >= 2, "the UI is told when the round starts and ends");
        // 1 minute later: not due
        assert!(tick(&db, &factory, clock(T0 + 60), &none, &notify).is_empty());
        // a request runs it
        let req: HashSet<String> = [ACC.to_string()].into_iter().collect();
        assert_eq!(tick(&db, &factory, clock(T0 + 61), &req, &notify).len(), 1);
        // 429 + Retry-After: 120 -> no request for 120 s (also not on request), then a normal one
        fake.fail_next_list(SyncErr::RateLimited(Some(Duration::from_secs(120))));
        tick(&db, &factory, clock(T0 + 400), &req, &notify);
        let calls = fake.list_calls();
        assert!(tick(&db, &factory, clock(T0 + 400 + 119), &req, &notify).is_empty());
        assert_eq!(fake.list_calls(), calls, "no request during the Retry-After time");
        assert_eq!(tick(&db, &factory, clock(T0 + 400 + 120), &none, &notify).len(), 1);
        assert_eq!(fake.list_calls(), calls + 1);
        assert_eq!(src(&db, &sid).status, "ok");
    }

    #[test]
    fn revoked_access_stops_the_retries_until_the_user_allows_it_again() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        fake.fail_next_list(SyncErr::Auth);
        let req: HashSet<String> = [ACC.to_string()].into_iter().collect();
        tick(&db, &factory, clock(T0 + 300), &req, &|| {});
        assert_eq!(src(&db, &sid).status, AUTH);
        let calls = fake.list_calls();
        for i in 1..5 {
            assert!(tick(&db, &factory, clock(T0 + 300 + i * 3600), &req, &|| {}).is_empty());
        }
        assert_eq!(fake.list_calls(), calls, "no retry loop");
        assert_eq!(rows(&db), vec!["A"], "the local copy stays visible");
        // Allow access again: the source starts over, the calendars and the token are kept, no duplicates
        store::create_source(&lock(&db), ACC, Kind::Google, T0 + 99_999).unwrap();
        tick(&db, &factory, clock(T0 + 100_000), &HashSet::new(), &|| {});
        assert_eq!((src(&db, &sid).status.as_str(), rows(&db)), ("ok", vec!["A".to_string()]));
    }

    #[test]
    fn a_calendar_that_is_gone_is_removed_and_a_missing_provider_is_an_error_state() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me"), rc("work", "Work")]);
        fake.add_event("work", RemoteEvent::single("w", "W", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!(rows(&db), vec!["W"]);
        fake.fail_pull_forever("work", SyncErr::NotFound);
        sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        assert!(rows(&db).is_empty());
        assert_eq!(store::calendars_of(&lock(&db), &sid).unwrap().iter().filter(|c| c.remote_id == "work").count(), 0);
        // a factory that cannot build a provider (credentials missing)
        let broken = FakeFactory::failing(SyncErr::Auth);
        sync_source(&db, &broken, &sid, clock(T0 + 600), &|| {}).unwrap();
        assert_eq!(src(&db, &sid).status, AUTH);
    }

    #[test]
    fn a_window_delta_token_is_started_again_when_the_window_has_aged() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_rebaseline(Some(30));
        fake.set_calendars(vec![rc("primary", "Me")]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        sync_source(&db, &factory, &sid, clock(T0 + 29 * DAY), &|| {}).unwrap();
        assert!(fake.last_pull("primary").unwrap().state.is_some(), "29 days: still incremental");
        sync_source(&db, &factory, &sid, clock(T0 + 31 * DAY), &|| {}).unwrap();
        let req = fake.last_pull("primary").unwrap();
        assert_eq!(req.state, None, "31 days: baseline again");
        assert_eq!(req.window_from, T0 + 31 * DAY - 365 * DAY);
        assert_eq!(rows(&db), vec!["A"]);
    }

    #[test]
    fn a_truncated_calendar_is_flagged() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        fake.set_truncated(true);
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        let cal = store::get_calendar(&lock(&db), &calendar_id(ACC, Kind::Google, "primary")).unwrap();
        assert!(cal.truncated);
        let info = store::sources_info(&lock(&db)).unwrap();
        assert!(info[0].calendars[0].truncated);
    }

    #[test]
    fn the_calendar_list_is_synced_with_its_token() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.enable_list_tokens();
        fake.set_calendars(vec![rc("primary", "Me"), rc("work", "Work"), rc("fam", "Family")]);
        fake.add_event("work", RemoteEvent::single("w", "W", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        let names = |db: &Db| {
            let mut v: Vec<String> = store::calendars_of(&lock(db), &sid).unwrap().into_iter().map(|c| c.name).collect();
            v.sort();
            v
        };
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!(names(&db), vec!["Family", "Me", "Work"]);
        assert_eq!(src(&db, &sid).list_state.as_deref(), Some("ltok-0"), "the token of the first full list is kept");
        // nothing changed: the list is asked with the token and brings nothing
        let r = sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        sync_source(&db, &factory, &sid, clock(T0 + 600), &|| {}).unwrap();
        assert_eq!(r.status, "ok");
        assert_eq!(fake.list_requests(), vec![None, Some("ltok-0".to_string()), Some("ltok-1".to_string())]);
        // a rename arrives as a changed entry
        fake.rename_calendar("fam", "Family and friends");
        sync_source(&db, &factory, &sid, clock(T0 + 900), &|| {}).unwrap();
        assert_eq!(names(&db), vec!["Family and friends", "Me", "Work"]);
        // a new calendar is added, switched on when the provider shows it
        fake.add_calendar(rc("new", "New"));
        sync_source(&db, &factory, &sid, clock(T0 + 1200), &|| {}).unwrap();
        assert_eq!(names(&db), vec!["Family and friends", "Me", "New", "Work"]);
        // a deleted calendar goes with its events
        assert_eq!(rows(&db), vec!["W"]);
        fake.delete_calendar("work");
        sync_source(&db, &factory, &sid, clock(T0 + 1500), &|| {}).unwrap();
        assert_eq!(names(&db), vec!["Family and friends", "Me", "New"]);
        assert!(rows(&db).is_empty());
        // 410: one full list, no error state, no duplicates
        fake.expire_list_tokens();
        let r = sync_source(&db, &factory, &sid, clock(T0 + 1800), &|| {}).unwrap();
        assert_eq!(r.status, "ok");
        assert_eq!(names(&db), vec!["Family and friends", "Me", "New"]);
        let s = src(&db, &sid);
        assert_eq!((s.status.as_str(), s.last_error, s.fail_count), ("ok", None, 0));
        let asked = fake.list_requests();
        assert_eq!(&asked[asked.len() - 2..], &[Some("ltok-5".to_string()), None], "the old token was tried, then a full list");
        // and the new token works
        fake.rename_calendar("me", "Me");
        sync_source(&db, &factory, &sid, clock(T0 + 2100), &|| {}).unwrap();
        assert_eq!(fake.list_requests().last().unwrap().as_deref(), Some("ltok-7"));
    }

    #[test]
    fn a_provider_without_list_tokens_is_listed_in_full_every_round() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me")]);
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
        assert_eq!(fake.list_calls(), 2);
        assert_eq!(src(&db, &sid).list_state, None);
        fake.set_calendars(vec![]);
        sync_source(&db, &factory, &sid, clock(T0 + 600), &|| {}).unwrap();
        assert!(store::calendars_of(&lock(&db), &sid).unwrap().is_empty(), "a full list drops what is not in it");
    }

    #[test]
    fn a_truncated_calendar_is_downloaded_once_a_day() {
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me"), rc("small", "Small")]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        fake.add_event("small", RemoteEvent::single("s", "S", T0, T0 + 3600));
        fake.set_truncated(true);
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!((fake.pull_count("primary"), fake.pull_count("small")), (1, 1));
        let cal = store::get_calendar(&lock(&db), &calendar_id(ACC, Kind::Google, "primary")).unwrap();
        assert!(cal.truncated && cal.sync_state.is_none(), "no token for what was not read");
        assert_eq!(cal.full_at, Some(T0));
        // the rounds of the next 24 hours do not ask for it again, and the note and the events stay
        fake.set_truncated(false);
        for i in 1..=4 {
            sync_source(&db, &factory, &sid, clock(T0 + i * 300), &|| {}).unwrap();
        }
        sync_source(&db, &factory, &sid, clock(T0 + DAY - 1), &|| {}).unwrap();
        assert_eq!(fake.pull_count("primary"), 1, "not requested within the day");
        assert!(store::get_calendar(&lock(&db), &calendar_id(ACC, Kind::Google, "primary")).unwrap().truncated, "the truncated note stays");
        assert_eq!(rows(&db), vec!["A", "S"], "what the last download brought stays");
        // a day later it is downloaded in full once more (and, now complete, gets its token)
        sync_source(&db, &factory, &sid, clock(T0 + DAY), &|| {}).unwrap();
        assert_eq!(fake.pull_count("primary"), 2);
        let cal = store::get_calendar(&lock(&db), &calendar_id(ACC, Kind::Google, "primary")).unwrap();
        assert!(!cal.truncated && cal.sync_state.is_some());
        assert_eq!(cal.full_at, Some(T0 + DAY));
        // switching the calendar off and on starts over at once
        fake.set_truncated(true);
        let id = calendar_id(ACC, Kind::Google, "primary");
        store::set_calendar_sync(&lock(&db), &id, false).unwrap();
        store::set_calendar_sync(&lock(&db), &id, true).unwrap();
        sync_source(&db, &factory, &sid, clock(T0 + DAY + 300), &|| {}).unwrap();
        assert_eq!(fake.pull_count("primary"), 3);
    }

    #[test]
    fn a_crash_between_calendars_repeats_only_the_missing_one() {
        // the first calendar is applied with its token; the second fails: the first is not downloaded again
        let (db, sid) = db_with_source();
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me"), rc("work", "Work")]);
        fake.add_event("primary", RemoteEvent::single("a", "A", T0, T0 + 3600));
        fake.add_event("work", RemoteEvent::single("w", "W", T0, T0 + 3600));
        fake.fail_next_pull("work", SyncErr::Offline);
        let factory = FakeFactory::new(fake.clone());
        sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
        assert_eq!(src(&db, &sid).status, OFFLINE);
        assert_eq!(rows(&db), vec!["A"]);
        sync_source(&db, &factory, &sid, clock(T0 + 60), &|| {}).unwrap();
        assert_eq!(rows(&db), vec!["A", "W"]);
        assert!(fake.last_pull("primary").unwrap().state.is_some());
    }
}
