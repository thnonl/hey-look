//! Contract tests of the Microsoft provider against a fake Graph server (no real account): calendars, delta paging, incremental syncs,
//! `@removed`, 410, the 30-day re-baseline and the mapping (all-day, zones, reminders, attendees, series). Writes, throttling and the
//! consent / revoked-grant states are in `microsoft_tests_rw.rs`.
use super::super::engine::{self, Clock};
use super::super::fake_http::{FakeServer, Req, Resp};
use super::super::store::tests::{conn, ACC};
use super::super::{store, ProviderFactory, BUSY, OK};
use super::*;
use crate::calendar;
use crate::lock;
use std::sync::{Arc, Mutex};

pub(super) const T0: i64 = 1_800_000_000;
pub(super) const DAY: i64 = 86_400;
/// ids as Graph makes them: base64 with `=` (and `-`, `_`)
pub(super) const PRIMARY: &str = "AAMkPRIMARY=";
pub(super) const WORK: &str = "AAMkWORK-1_x=";
const D: &str = "2026-10-20T13:00:00.0000000";
const D_END: &str = "2026-10-20T14:00:00.0000000";

pub(super) fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
    Utc.with_ymd_and_hms(y, m, d, h, mi, 0).unwrap().timestamp()
}

pub(super) fn day(y: i32, m: u32, d: u32) -> i64 {
    utc(y, m, d, 0, 0)
}

pub(super) fn clock(now: i64) -> Clock {
    Clock { now, jitter: 0.5 }
}

pub(super) fn primary() -> RemoteCalendar {
    RemoteCalendar { id: PRIMARY.into(), name: "Calendar".into(), color: "#0078d4".into(), primary: true, selected: true, ..Default::default() }
}

pub(super) fn work() -> RemoteCalendar {
    RemoteCalendar { id: WORK.into(), name: "Work".into(), selected: true, ..Default::default() }
}

pub(super) fn prov(srv: &FakeServer) -> MicrosoftProvider {
    MicrosoftProvider::new(&srv.base, Box::new(|| Ok("tok-1".to_string())))
}

/// Hands the engine a Microsoft provider that talks to the fake server.
pub(super) struct MFactory {
    pub base: String,
    pub token: Arc<dyn Fn() -> Result<String, SyncErr> + Send + Sync>,
}

impl MFactory {
    pub fn new(srv: &FakeServer) -> MFactory {
        MFactory { base: srv.base.clone(), token: Arc::new(|| Ok("tok-1".to_string())) }
    }
}

impl ProviderFactory for MFactory {
    fn provider(&self, _: &store::Source) -> Result<Box<dyn CalProvider>, SyncErr> {
        let t = self.token.clone();
        Ok(Box::new(MicrosoftProvider::new(&self.base, Box::new(move || t()))))
    }
}

/// The address a request came to, to build the links of an answer.
pub(super) fn me(r: &Req) -> String {
    format!("http://{}", r.headers["host"])
}

fn cal_json(id: &str, name: &str, hex: &str, default: bool, can_edit: bool, owner: &str) -> Value {
    json!({ "id": id, "name": name, "hexColor": hex, "color": "auto", "isDefaultCalendar": default, "canEdit": can_edit, "owner": { "name": "Owner", "address": owner } })
}

fn primary_json() -> Value {
    cal_json(PRIMARY, "Calendar", "#0078d4", true, true, "me@outlook.test")
}

pub(super) fn ev_json(id: &str, subject: &str, start: &str, end: &str) -> Value {
    json!({
        "id": id, "@odata.etag": format!("W/\"etag-{id}\""), "iCalUId": format!("uid-{id}"), "subject": subject, "type": "singleInstance",
        "isAllDay": false, "isCancelled": false, "isOrganizer": true, "isReminderOn": true, "reminderMinutesBeforeStart": 15,
        "start": { "dateTime": start, "timeZone": "UTC" }, "end": { "dateTime": end, "timeZone": "UTC" },
        "originalStartTimeZone": "Eastern Standard Time", "originalEndTimeZone": "Eastern Standard Time",
        "organizer": { "emailAddress": { "name": "Me", "address": "me@outlook.test" } }, "attendees": [],
        "location": { "displayName": "" }, "body": { "contentType": "text", "content": "" },
        "responseStatus": { "response": "organizer" }, "lastModifiedDateTime": "2026-10-15T08:00:00Z",
        "showAs": "busy", "categories": ["Red category"]
    })
}

pub(super) fn page(items: Vec<Value>, next: Option<String>, delta: Option<String>) -> Value {
    let mut v = json!({ "value": items });
    if let Some(n) = next {
        v["@odata.nextLink"] = json!(n);
    }
    if let Some(d) = delta {
        v["@odata.deltaLink"] = json!(d);
    }
    v
}

pub(super) fn setup_db() -> (crate::Db, String) {
    let c = conn();
    let s = store::create_source(&c, ACC, Kind::Microsoft, 0).unwrap();
    (Arc::new(Mutex::new(c)), s.id)
}

pub(super) fn cal_id() -> String {
    super::super::calendar_id(ACC, Kind::Microsoft, PRIMARY)
}

pub(super) fn rows(db: &crate::Db) -> Vec<String> {
    let c = lock(db);
    let mut st = c.prepare("SELECT summary FROM events WHERE remote_id IS NOT NULL ORDER BY starts_at, summary").unwrap();
    st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
}

fn state_of(db: &crate::Db) -> Option<String> {
    store::get_calendar(&lock(db), &cal_id()).and_then(|c| c.sync_state)
}

/// The answer to the calendar list request: one calendar, the default one.
pub(super) fn list_ok(r: &Req) -> Option<Resp> {
    (r.path() == "/me/calendars").then(|| Resp::json(200, page(vec![primary_json()], None, None)))
}

fn req_window() -> PullReq {
    PullReq { state: None, window_from: T0 - 365 * DAY, window_to: T0 + 730 * DAY }
}

// ---------------------------------------------------------------- calendars

#[test]
fn calendars_are_listed_over_pages_with_colour_access_and_without_other_peoples_shared_calendars() {
    let srv = FakeServer::start(|r| {
        assert_eq!(r.path(), "/me/calendars");
        match r.query("$skiptoken").as_deref() {
            None => Resp::json(
                200,
                page(
                    vec![primary_json(), cal_json("AAMkBDAY=", "Birthdays", "", false, false, "me@Outlook.test")],
                    Some(format!("{}/me/calendars?$top=100&$skiptoken=2", me(r))),
                    None,
                ),
            ),
            Some("2") => Resp::json(
                200,
                page(vec![cal_json(WORK, "Work", "#d13438", false, true, "ME@outlook.test"), cal_json("AAMkSHARED=", "Boss's calendar", "#000000", false, true, "boss@contoso.test")], None, None),
            ),
            other => panic!("unexpected page {other:?}"),
        }
    });
    let got = prov(&srv).list_calendars().unwrap();
    assert_eq!(got.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Calendar", "Birthdays", "Work"], "a calendar of somebody else is not listed");
    let p = &got[0];
    assert_eq!((p.id.as_str(), p.color.as_str(), p.read_only, p.primary, p.selected), (PRIMARY, "#0078d4", false, true, true));
    let b = &got[1];
    assert_eq!((b.color.as_str(), b.read_only, b.primary, b.selected), ("", true, false, true), "no colour = the mailbox's; canEdit false = read only; Outlook shows all");
    assert!(!got[2].read_only && got[2].color == "#d13438");
    let reqs = srv.requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].headers["authorization"], "Bearer tok-1");
    assert_eq!(reqs[0].query("$top").as_deref(), Some("100"));
    assert!(reqs[0].headers["prefer"].contains("outlook.timezone=\"UTC\"") && reqs[0].headers["prefer"].contains("outlook.body-content-type=\"text\""));
}

// ---------------------------------------------------------------- delta sync

#[test]
fn a_full_sync_over_two_pages_keeps_the_rows_and_the_delta_link_only_at_the_end() {
    let (db, sid) = setup_db();
    let fail_second = Arc::new(Mutex::new(true));
    let f2 = fail_second.clone();
    let srv = FakeServer::start(move |r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        assert_eq!(r.path(), "/me/calendarView/delta", "the default calendar uses the documented path");
        match r.query("$skiptoken").as_deref() {
            None => Resp::json(200, page(vec![ev_json("a", "First", D, D_END)], Some(format!("{}/me/calendarView/delta?$skiptoken=P2", me(r))), None)),
            Some(_) if *f2.lock().unwrap() => Resp::json(503, json!({ "error": { "code": "ErrorServerBusy", "message": "busy" } })),
            Some(_) => Resp::json(
                200,
                page(vec![ev_json("b", "Second", "2026-10-21T13:00:00.0000000", "2026-10-21T14:00:00.0000000")], None, Some(format!("{}/me/calendarView/delta?$deltatoken=D1", me(r)))),
            ),
        }
    });
    let factory = MFactory::new(&srv);
    // page 2 fails: nothing of the round is kept, no token
    let r = engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    assert_eq!(r.status, BUSY);
    assert!(rows(&db).is_empty() && state_of(&db).is_none(), "the round counts completely or not at all");
    *fail_second.lock().unwrap() = false;
    let r = engine::sync_source(&db, &factory, &sid, clock(T0 + 3600), &|| {}).unwrap();
    assert_eq!(r.status, OK);
    assert_eq!(rows(&db), vec!["First", "Second"]);
    assert_eq!(state_of(&db), Some(format!("{}/me/calendarView/delta?$deltatoken=D1", srv.base)));
    // what the full request asked for: the window now-365 d .. now+730 d, UTC times, text bodies, 100 events a page
    let first = srv.requests().into_iter().rev().find(|r| r.path().ends_with("/delta") && r.query("$skiptoken").is_none()).unwrap();
    assert_eq!((first.query("startDateTime"), first.query("endDateTime")), (Some(iso(T0 + 3600 - 365 * DAY)), Some(iso(T0 + 3600 + 730 * DAY))));
    assert!(first.headers["prefer"].contains("odata.maxpagesize=100"));
    // the window the delta covers is remembered for the re-baseline
    assert_eq!(store::get_calendar(&lock(&db), &cal_id()).unwrap().window_from, Some(T0 + 3600 - 365 * DAY));
}

#[test]
fn an_incremental_sync_follows_the_stored_delta_link_removed_entries_delete_and_every_new_link_is_used_next() {
    let (db, sid) = setup_db();
    let round = Arc::new(Mutex::new(0));
    let r2 = round.clone();
    let seen = Arc::new(Mutex::new(vec![]));
    let s2 = seen.clone();
    let srv = FakeServer::start(move |r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        s2.lock().unwrap().push(r.target.clone());
        let b = me(r);
        match *r2.lock().unwrap() {
            0 => Resp::json(
                200,
                page(
                    vec![
                        ev_json("a", "Keep", D, D_END),
                        ev_json("b", "Delete me", "2026-10-21T13:00:00.0000000", "2026-10-21T14:00:00.0000000"),
                        ev_json("c", "Leaves the window", "2026-10-22T13:00:00.0000000", "2026-10-22T14:00:00.0000000"),
                    ],
                    None,
                    Some(format!("{b}/me/calendarView/delta?$deltatoken=D1")),
                ),
            ),
            1 => {
                assert_eq!(r.target, "/me/calendarView/delta?$deltatoken=D1", "exactly the link that was stored, nothing added");
                let mut renamed = ev_json("a", "Keep (renamed)", D, D_END);
                renamed["@odata.etag"] = json!("W/\"etag-a2\"");
                // the same event twice in one round: the last entry counts
                let stale = ev_json("a", "Old copy", D, D_END);
                Resp::json(
                    200,
                    page(
                        vec![stale, renamed, json!({ "id": "b", "@removed": { "reason": "deleted" } }), json!({ "id": "c", "@removed": { "reason": "changed" } })],
                        None,
                        Some(format!("{b}/me/calendarView/delta?$deltatoken=D2")),
                    ),
                )
            }
            _ => {
                assert_eq!(r.target, "/me/calendarView/delta?$deltatoken=D2");
                Resp::json(200, page(vec![], None, Some(format!("{b}/me/calendarView/delta?$deltatoken=D3"))))
            }
        }
    });
    let factory = MFactory::new(&srv);
    engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    assert_eq!(rows(&db), vec!["Keep", "Delete me", "Leaves the window"]);
    *round.lock().unwrap() = 1;
    let r = engine::sync_source(&db, &factory, &sid, clock(T0 + 300), &|| {}).unwrap();
    assert_eq!((r.status.as_str(), r.changed), (OK, true));
    assert_eq!(rows(&db), vec!["Keep (renamed)"]);
    assert_eq!(state_of(&db), Some(format!("{}/me/calendarView/delta?$deltatoken=D2", srv.base)));
    // the delta link loop: every answer's link is the next request
    *round.lock().unwrap() = 2;
    let r = engine::sync_source(&db, &factory, &sid, clock(T0 + 600), &|| {}).unwrap();
    assert_eq!((r.status.as_str(), r.changed), (OK, false));
    assert_eq!(state_of(&db), Some(format!("{}/me/calendarView/delta?$deltatoken=D3", srv.base)));
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[test]
fn a_next_link_that_loops_or_leaves_graph_ends_with_an_error_and_never_sends_the_token_elsewhere() {
    let evil = FakeServer::start(|_| panic!("the access token must not go to another server"));
    let evil_base = evil.base.clone();
    let looping = FakeServer::start(|r| Resp::json(200, page(vec![], Some(format!("{}{}", me(r), r.target)), None)));
    let err = prov(&looping).pull(&work(), &req_window()).unwrap_err();
    assert!(matches!(&err, SyncErr::Other(t) if t.contains("never ended")), "{err:?}");
    assert_eq!(looping.count(), 1, "stopped at the second visit of the same page");
    let foreign = FakeServer::start(move |_| Resp::json(200, page(vec![], Some(format!("{evil_base}/me/calendarView/delta?$skiptoken=x")), None)));
    assert!(matches!(prov(&foreign).pull(&work(), &req_window()), Err(SyncErr::Other(t)) if t.contains("another server")));
    // a stored link of another host (an old build or a damaged database) is not followed: download again
    let st = PullReq { state: Some(format!("{}/me/calendarView/delta?$deltatoken=D", evil.base)), ..req_window() };
    assert_eq!(prov(&foreign).pull(&work(), &st).unwrap_err(), SyncErr::Gone);
    assert_eq!((evil.count(), foreign.count()), (0, 1));
    // the answer of a delta that ends without a token is an error, not a lost token
    let no_token = FakeServer::start(|_| Resp::json(200, page(vec![], None, None)));
    assert!(matches!(prov(&no_token).pull(&primary(), &req_window()), Err(SyncErr::Other(t)) if t.contains("without a token")));
}

#[test]
fn a_410_sync_state_not_found_downloads_everything_again_without_duplicates_or_an_error() {
    let (db, sid) = setup_db();
    let calls = Arc::new(Mutex::new(vec![]));
    let c2 = calls.clone();
    let srv = FakeServer::start(move |r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        c2.lock().unwrap().push(r.query("$deltatoken").is_some());
        if r.query("$deltatoken").is_some() {
            return Resp::json(410, json!({ "error": { "code": "syncStateNotFound", "message": "The sync state generation is not found." } }));
        }
        Resp::json(200, page(vec![ev_json("a", "Only one", D, D_END)], None, Some(format!("{}/me/calendarView/delta?$deltatoken=D3", me(r)))))
    });
    let factory = MFactory::new(&srv);
    {
        let c = lock(&db);
        let src = store::get_source(&c, &sid).unwrap();
        store::reconcile_calendars(&c, &src, &[primary()]).unwrap();
        let cal_row = store::get_calendar(&c, &cal_id()).unwrap();
        for id in ["a", "gone"] {
            store::upsert_remote(&c, &cal_row, ACC, &RemoteEvent::single(id, id, T0, T0 + 60)).unwrap();
        }
        c.execute("UPDATE calendars SET sync_state=?1", [format!("{}/me/calendarView/delta?$deltatoken=D1", srv.base)]).unwrap();
    }
    let r = engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    assert_eq!(r.status, OK, "no error state for a 410");
    assert_eq!(rows(&db), vec!["Only one"], "no duplicates, the event deleted meanwhile is gone");
    assert_eq!(*calls.lock().unwrap(), vec![true, false], "the link was tried once, then a full download");
    assert_eq!(state_of(&db), Some(format!("{}/me/calendarView/delta?$deltatoken=D3", srv.base)));
}

#[test]
fn the_delta_window_is_started_again_after_30_days() {
    assert_eq!(prov(&FakeServer::start(|_| Resp::empty(200))).rebaseline_after_days(), Some(30));
    let (db, sid) = setup_db();
    let urls = Arc::new(Mutex::new(vec![]));
    let u2 = urls.clone();
    let srv = FakeServer::start(move |r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        let n = {
            let mut g = u2.lock().unwrap();
            g.push(r.target.clone());
            g.len()
        };
        Resp::json(200, page(vec![ev_json("a", "Only one", D, D_END)], None, Some(format!("{}/me/calendarView/delta?$deltatoken=N{n}", me(r)))))
    });
    let factory = MFactory::new(&srv);
    engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    // 10 days later: incremental
    engine::sync_source(&db, &factory, &sid, clock(T0 + 10 * DAY), &|| {}).unwrap();
    // 31 days later: the window started 31 days ago is stale, a new one is downloaded (and the old rows replaced, not doubled)
    engine::sync_source(&db, &factory, &sid, clock(T0 + 31 * DAY), &|| {}).unwrap();
    let urls = urls.lock().unwrap().clone();
    assert!(urls[0].contains("startDateTime=") && urls[1].starts_with("/me/calendarView/delta?$deltatoken=N1"), "{urls:?}");
    assert!(urls[2].contains(&format!("startDateTime={}", urlencoding::encode(&iso(T0 + 31 * DAY - 365 * DAY)))), "{urls:?}");
    assert_eq!(rows(&db), vec!["Only one"]);
}

#[test]
fn a_calendar_without_a_delta_is_downloaded_in_full_through_the_plain_view_and_a_non_default_one_has_its_own_path() {
    let calls = Arc::new(Mutex::new(vec![]));
    let c2 = calls.clone();
    let srv = FakeServer::start(move |r| {
        c2.lock().unwrap().push(r.path().to_string());
        if r.path().ends_with("/delta") {
            return Resp::json(400, json!({ "error": { "code": "ErrorInvalidRequest", "message": "The delta function is not supported for this calendar." } }));
        }
        match r.query("$skiptoken").as_deref() {
            None => Resp::json(200, page(vec![ev_json("a", "One", D, D_END)], Some(format!("{}{}&$skiptoken=2", me(r), r.target)), None)),
            Some(_) => Resp::json(
                200,
                page(vec![ev_json("b", "Two", "2026-10-21T13:00:00.0000000", "2026-10-21T14:00:00.0000000"), json!({ "id": "c", "@removed": { "reason": "deleted" } })], None, None),
            ),
        }
    });
    let got = prov(&srv).pull(&work(), &req_window()).unwrap();
    assert_eq!(got.upserts.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(), ["One", "Two"]);
    assert!(got.full && got.next_state.is_none() && got.removed.is_empty(), "everything again next round: no token");
    let enc = "AAMkWORK-1_x%3D";
    assert_eq!(*calls.lock().unwrap(), [format!("/me/calendars/{enc}/calendarView/delta"), format!("/me/calendars/{enc}/calendarView"), format!("/me/calendars/{enc}/calendarView")]);
    let plain = srv.requests().into_iter().nth(1).unwrap();
    assert_eq!((plain.query("$top").as_deref(), plain.query("startDateTime")), (Some("100"), Some(iso(T0 - 365 * DAY))));
    // a failing incremental request is an error, not a reason to download everything silently
    let st = PullReq { state: Some(format!("{}/me/calendars/{enc}/calendarView/delta?$deltatoken=D", srv.base)), ..req_window() };
    assert!(matches!(prov(&srv).pull(&work(), &st), Err(SyncErr::Other(t)) if t.contains("rejected the request")));
}

#[test]
fn a_calendar_over_the_event_limit_is_cut_and_flagged_with_no_token() {
    // 251 pages of 100 events: the 25,000-event limit is reached before the last page
    let srv = FakeServer::start(|r| {
        let n: usize = r.query("$skiptoken").and_then(|p| p.parse().ok()).unwrap_or(0);
        let items: Vec<Value> = (0..100)
            .map(|i| json!({ "id": format!("e{n}-{i}"), "subject": "x", "start": { "dateTime": "2026-10-20T09:00:00.0000000", "timeZone": "UTC" }, "end": { "dateTime": "2026-10-20T10:00:00.0000000", "timeZone": "UTC" } }))
            .collect();
        let next = (n < 251).then(|| format!("{}/me/calendarView/delta?$skiptoken={}", me(r), n + 1));
        let delta = next.is_none().then(|| format!("{}/me/calendarView/delta?$deltatoken=X", me(r)));
        Resp::json(200, page(items, next, delta))
    });
    let pull = prov(&srv).pull(&primary(), &req_window()).unwrap();
    assert!(pull.truncated && pull.next_state.is_none() && pull.full);
    assert_eq!(pull.upserts.len(), MAX_EVENTS_PER_CALENDAR);
    assert!(srv.count() < 260, "it stopped reading");
}

// ---------------------------------------------------------------- mapping

#[test]
fn timed_events_keep_their_instant_zone_reminder_location_link_and_text() {
    let mut v = ev_json("a", "Planning", D, "2026-10-20T14:30:00.0000000");
    v["location"] = json!({ "displayName": "Room 4" });
    v["onlineMeeting"] = json!({ "joinUrl": "https://teams.microsoft.com/l/meetup-join/x" });
    v["body"] = json!({ "contentType": "text", "content": "Agenda\r\n- one\r\n" });
    let e = parse_event(&v).unwrap();
    assert_eq!((e.start, e.end, e.all_day), (utc(2026, 10, 20, 13, 0), utc(2026, 10, 20, 14, 30), false));
    assert_eq!((e.tzid.as_deref(), e.reminder_min, e.location.as_deref()), (Some("America/New_York"), Some(15), Some("Room 4")));
    assert_eq!((e.id.as_str(), e.uid.as_str(), e.etag.as_str()), ("a", "uid-a", "W/\"etag-a\""));
    assert_eq!(e.join_url.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/x"));
    assert_eq!(e.description.as_deref(), Some("Agenda\n- one"));
    assert_eq!((e.kind, e.status.as_str(), e.can_edit, e.my_status.clone(), e.organizer.is_none(), e.rrule.is_none()), (EventKind::Single, "confirmed", true, None, true, true), "showAs and categories are ignored; a plain own event has no organizer shown");
    assert!(e.updated.is_some());
    // a reminder that is off, an HTML body (the service did not honour the text preference), a zone the service did not convert
    let mut v = ev_json("b", "Call", "2026-10-20T09:00:00.0000000", "2026-10-20T10:00:00.0000000");
    v["isReminderOn"] = json!(false);
    v["body"] = json!({ "contentType": "html", "content": "<html><body><p>Hello&nbsp;<b>there</b></p><div>Line 2</div></body></html>" });
    v["start"] = json!({ "dateTime": "2026-10-20T09:00:00.0000000", "timeZone": "Eastern Standard Time" });
    v["end"] = json!({ "dateTime": "2026-10-20T10:00:00.0000000", "timeZone": "Eastern Standard Time" });
    let e = parse_event(&v).unwrap();
    assert_eq!((e.reminder_min, e.start), (None, utc(2026, 10, 20, 13, 0)), "09:00 in New York in October is 13:00 UTC");
    assert!(e.description.unwrap().starts_with("Hello there"));
    // an end before the start does not break the row
    let e = parse_event(&ev_json("c", "Odd", D, "2026-10-20T12:00:00.0000000")).unwrap();
    assert_eq!(e.end, e.start);
}

#[test]
fn all_day_events_cover_exactly_their_days_whatever_zone_the_service_used() {
    let all = |start: &str, end: &str, zone: Option<&str>| {
        let mut v = ev_json("d", "Trip", start, end);
        v["isAllDay"] = json!(true);
        v["originalStartTimeZone"] = zone.map(|z| json!(z)).unwrap_or(Value::Null);
        v["originalEndTimeZone"] = zone.map(|z| json!(z)).unwrap_or(Value::Null);
        parse_event(&v).unwrap()
    };
    // midnight to midnight: a 3 day event covers the 20th, 21st and 22nd (the end is the 23rd, exclusive)
    let e = all("2026-10-20T00:00:00.0000000", "2026-10-23T00:00:00.0000000", Some("Pacific Standard Time"));
    assert_eq!((e.start, e.end, e.all_day, e.tzid), (day(2026, 10, 20), day(2026, 10, 23), true, None));
    // converted to UTC from Los Angeles (UTC-7 in October): 07:00 UTC is midnight there
    let e = all("2026-10-20T07:00:00.0000000", "2026-10-21T07:00:00.0000000", Some("Pacific Standard Time"));
    assert_eq!((e.start, e.end), (day(2026, 10, 20), day(2026, 10, 21)));
    // converted from Tokyo (UTC+9): the 19th at 15:00 UTC is the 20th there, not the 19th
    let e = all("2026-10-19T15:00:00.0000000", "2026-10-20T15:00:00.0000000", Some("Tokyo Standard Time"));
    assert_eq!((e.start, e.end), (day(2026, 10, 20), day(2026, 10, 21)));
    // no zone known and not midnight: the nearest day
    let e = all("2026-10-19T15:00:00.0000000", "2026-10-20T15:00:00.0000000", None);
    assert_eq!((e.start, e.end), (day(2026, 10, 20), day(2026, 10, 21)));
    // an all-day event with an empty span is one day
    let e = all("2026-10-20T00:00:00.0000000", "2026-10-20T00:00:00.0000000", None);
    assert_eq!(e.end, day(2026, 10, 21));
}

#[test]
fn attendees_organizer_and_my_answer_are_mapped_and_resources_are_left_out() {
    let mut v = ev_json("m", "Design review", D, D_END);
    v["isOrganizer"] = json!(false);
    v["organizer"] = json!({ "emailAddress": { "name": "Mai Khanh", "address": "Mai@Contoso.test" } });
    v["responseStatus"] = json!({ "response": "tentativelyAccepted" });
    v["attendees"] = json!([
        { "type": "required", "status": { "response": "organizer" }, "emailAddress": { "name": "Mai Khanh", "address": "mai@contoso.test" } },
        { "type": "required", "status": { "response": "tentativelyAccepted" }, "emailAddress": { "name": "me@outlook.test", "address": "me@outlook.test" } },
        { "type": "optional", "status": { "response": "declined" }, "emailAddress": { "name": "Lan", "address": "lan@contoso.test" } },
        { "type": "resource", "status": { "response": "accepted" }, "emailAddress": { "name": "Room 4", "address": "room4@contoso.test" } },
        { "type": "required", "status": { "response": "none" }, "emailAddress": { "name": "Pat", "address": "pat@contoso.test" } },
    ]);
    let e = parse_event(&v).unwrap();
    assert_eq!(
        e.attendees.iter().map(|a| (a.email.as_str(), a.role.as_str(), a.status.as_str())).collect::<Vec<_>>(),
        [("mai@contoso.test", "chair", "accepted"), ("me@outlook.test", "required", "tentative"), ("lan@contoso.test", "optional", "declined"), ("pat@contoso.test", "required", "needs-action")]
    );
    assert_eq!(e.attendees[1].name, None, "the address repeated as a name is not a name");
    assert_eq!(e.organizer.as_ref().map(|o| (o.email.as_str(), o.name.as_deref())), Some(("mai@contoso.test", Some("Mai Khanh"))));
    assert_eq!((e.my_status.as_deref(), e.can_edit), (Some("tentative"), false), "somebody else organizes: read only");
    // my own meeting with guests: I am the organizer
    let mut v = ev_json("n", "Dinner", "2026-10-20T17:00:00.0000000", "2026-10-20T18:00:00.0000000");
    v["attendees"] = json!([{ "type": "required", "status": { "response": "none" }, "emailAddress": { "name": "Guest", "address": "g@x.test" } }]);
    let e = parse_event(&v).unwrap();
    assert_eq!((e.my_status.as_deref(), e.can_edit, e.organizer.as_ref().map(|o| o.email.as_str())), (Some("organizer"), true, Some("me@outlook.test")));
    // an invitation I have not answered, one I declined
    let mut v = ev_json("o", "Invite", "2026-10-20T17:00:00.0000000", "2026-10-20T18:00:00.0000000");
    v["isOrganizer"] = json!(false);
    v["responseStatus"] = json!({ "response": "notResponded" });
    assert_eq!(parse_event(&v).unwrap().my_status.as_deref(), Some("needs-action"));
    v["responseStatus"] = json!({ "response": "declined" });
    assert_eq!(parse_event(&v).unwrap().my_status.as_deref(), Some("declined"));
}

#[test]
fn occurrences_and_exceptions_are_single_read_only_rows_a_series_master_is_not_shown_and_a_cancelled_event_is_deleted() {
    let (db, sid) = setup_db();
    let occ = |id: &str, ty: &str, orig: &str, start: &str, end: &str| {
        let mut v = ev_json(id, "Weekly sync", start, end);
        v["type"] = json!(ty);
        v["iCalUId"] = json!("uid-series");
        v["seriesMasterId"] = json!("series-1");
        v["originalStart"] = json!(orig);
        v
    };
    let mut master = ev_json("series-1", "Weekly sync", "2026-10-13T13:00:00.0000000", "2026-10-13T14:00:00.0000000");
    master["type"] = json!("seriesMaster");
    let mut cancelled = occ("o3", "occurrence", "2026-11-03T13:00:00Z", "2026-11-03T13:00:00.0000000", "2026-11-03T14:00:00.0000000");
    cancelled["isCancelled"] = json!(true);
    let srv = FakeServer::start(move |r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        Resp::json(
            200,
            page(
                vec![
                    master.clone(),
                    occ("o1", "occurrence", "2026-10-20T13:00:00Z", D, D_END),
                    // moved from the 27th, 13:00 to the 28th, 15:00
                    occ("o2", "exception", "2026-10-27T13:00:00Z", "2026-10-28T15:00:00.0000000", "2026-10-28T16:00:00.0000000"),
                    cancelled.clone(),
                    ev_json("s", "Single", "2026-10-22T13:00:00.0000000", "2026-10-22T14:00:00.0000000"),
                ],
                None,
                Some(format!("{}/me/calendarView/delta?$deltatoken=D1", me(r))),
            ),
        )
    });
    engine::sync_source(&db, &MFactory::new(&srv), &sid, clock(T0), &|| {}).unwrap();
    assert_eq!(rows(&db).len(), 3, "two instances of the series and the single event: no master, no cancelled occurrence");
    let get = |remote: &str| {
        let c = lock(&db);
        let id: String = c.query_row("SELECT id FROM events WHERE remote_id=?1", [remote], |r| r.get(0)).unwrap();
        calendar::get_event(&c, &id).unwrap()
    };
    let (o1, o2, s) = (get("o1"), get("o2"), get("s"));
    assert_eq!((o1.read_only.as_deref(), o1.rrule.is_none(), o1.series_id.as_deref(), o1.remote_kind.as_deref()), (Some("repeating"), true, Some("series-1"), Some("occurrence")));
    assert_eq!((o2.read_only.as_deref(), o2.start, o2.remote_kind.as_deref()), (Some("repeating"), utc(2026, 10, 28, 15, 0), Some("exception")), "the moved one shows at its new time");
    assert_eq!(o1.uid, o2.uid, "instances share the series' UID and differ by the original start");
    assert_ne!(o1.recurrence_id, o2.recurrence_id);
    assert_eq!(o1.recurrence_id, utc(2026, 10, 20, 13, 0).to_string());
    assert_eq!(s.read_only, None);
    // a later round: an occurrence that was deleted
    let srv = FakeServer::start(|r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        Resp::json(200, page(vec![json!({ "id": "o1", "@removed": { "reason": "deleted" } })], None, Some(format!("{}/me/calendarView/delta?$deltatoken=D2", me(r)))))
    });
    lock(&db).execute("UPDATE calendars SET sync_state=?1", [format!("{}/me/calendarView/delta?$deltatoken=D1", srv.base)]).unwrap();
    engine::sync_source(&db, &MFactory::new(&srv), &sid, clock(T0 + 300), &|| {}).unwrap();
    assert_eq!(rows(&db).len(), 2);
}
