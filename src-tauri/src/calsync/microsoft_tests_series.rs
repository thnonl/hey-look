//! Contract tests of repeating events in Outlook calendars (W7.1, D-7.1d / D-7.1e) against a fake Graph server: changing and deleting one occurrence, the series master
//! that is fetched when "the whole series" or "this and following" needs it, the pattern mapping on writes, patterns the app does not map, and no connection.
use super::super::engine;
use super::super::fake_http::{FakeServer, Req, Resp};
use super::super::series;
use super::super::write;
use super::tests::*;
use super::*;
use crate::calendar::{self, CalEventInput};
use crate::calseries::Scope;
use crate::lock;
use std::sync::{Arc, Mutex};

/// One occurrence of series `ser1` (weekly on Tuesday 09:00 New York) as the calendar view lists it.
fn occurrence(id: &str, start: &str, end: &str, kind: &str) -> Value {
    let mut v = ev_json(id, "Weekly sync", start, end);
    v["type"] = json!(kind);
    v["seriesMasterId"] = json!("ser1");
    v["originalStart"] = json!(format!("{}Z", start.trim_end_matches("0000000").trim_end_matches('.')));
    v["iCalUId"] = json!("uid-ser1");
    v
}

fn master(pattern: Value, range: Value) -> Value {
    let mut v = ev_json("ser1", "Weekly sync", "2026-10-20T13:00:00.0000000", "2026-10-20T14:00:00.0000000");
    v["type"] = json!("seriesMaster");
    v["@odata.etag"] = json!("W/\"m1\"");
    v["iCalUId"] = json!("uid-ser1");
    v["recurrence"] = json!({ "pattern": pattern, "range": range });
    v
}

fn weekly_tuesday() -> Value {
    master(
        json!({ "type": "weekly", "interval": 1, "daysOfWeek": ["tuesday"], "firstDayOfWeek": "monday" }),
        json!({ "type": "noEnd", "startDate": "2026-10-20", "recurrenceTimeZone": "Eastern Standard Time" }),
    )
}

struct Env {
    db: crate::Db,
    srv: FakeServer,
    factory: MFactory,
    master: Arc<Mutex<Value>>,
}

/// An Outlook calendar with three occurrences of a weekly series (the master is not among the events), a master that answers `GET /me/events/ser1`, and writes
/// that answer the way Graph does.
fn env(master_json: Value) -> Env {
    let (db, sid) = setup_db();
    let master = Arc::new(Mutex::new(master_json));
    let m = master.clone();
    let srv = FakeServer::start(move |r: &Req| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        let path = r.path().to_string();
        let master_now = || m.lock().unwrap().clone();
        match (r.method.as_str(), path.as_str()) {
            ("GET", "/me/calendarView/delta") => {
                let link = Some(format!("{}/me/calendarView/delta?$deltatoken=D1", me(r)));
                if r.query("$deltatoken").is_some() {
                    Resp::json(200, page(vec![], None, link))
                } else {
                    Resp::json(
                        200,
                        page(
                            vec![
                                occurrence("o1", "2026-10-20T13:00:00.0000000", "2026-10-20T14:00:00.0000000", "occurrence"),
                                occurrence("o2", "2026-10-27T13:00:00.0000000", "2026-10-27T14:00:00.0000000", "occurrence"),
                                occurrence("o3", "2026-11-03T14:00:00.0000000", "2026-11-03T15:00:00.0000000", "occurrence"),
                            ],
                            None,
                            link,
                        ),
                    )
                }
            }
            ("GET", "/me/events/ser1") => Resp::json(200, master_now()),
            ("PATCH", "/me/events/ser1") => {
                let mut v = master_now();
                v["@odata.etag"] = json!("W/\"m2\"");
                if let Some(s) = r.json()["subject"].as_str() {
                    v["subject"] = json!(s);
                }
                if !r.json()["recurrence"].is_null() {
                    v["recurrence"] = r.json()["recurrence"].clone();
                }
                *m.lock().unwrap() = v.clone();
                Resp::json(200, v)
            }
            ("PATCH", p) if p.starts_with("/me/events/o") => {
                let id = p.trim_start_matches("/me/events/");
                let mut v = occurrence(id, "2026-10-27T15:00:00.0000000", "2026-10-27T16:00:00.0000000", "exception");
                v["subject"] = r.json()["subject"].clone();
                v["@odata.etag"] = json!(format!("W/\"after-{id}\""));
                Resp::json(200, v)
            }
            ("DELETE", _) => Resp::empty(204),
            ("POST", "/me/calendars/AAMkPRIMARY%3D/events") => Resp::json(201, ev_json("newser", r.json()["subject"].as_str().unwrap_or(""), "2026-11-10T14:00:00.0000000", "2026-11-10T15:00:00.0000000")),
            (m, p) => panic!("unexpected {m} {p}"),
        }
    });
    let factory = MFactory::new(&srv);
    engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    Env { db, srv, factory, master }
}

fn row_id(e: &Env, remote: &str) -> String {
    lock(&e.db).query_row("SELECT id FROM events WHERE remote_id=?1", [remote], |r| r.get(0)).unwrap()
}

fn input(_e: &Env, id: &str, title: &str, start: i64, rrule: Option<&str>) -> CalEventInput {
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
        reminder_min: Some(15),
        calendar_id: Some(cal_id()),
        scope: None,
        occurrence_start: None,
    }
}

fn requests(e: &Env, method: &str) -> Vec<Req> {
    e.srv.requests().into_iter().filter(|r| r.method == method).collect()
}

#[test]
fn an_occurrence_is_changed_and_deleted_by_its_own_id_with_its_etag() {
    let e = env(weekly_tuesday());
    assert_eq!(rows(&e.db).len(), 3);
    // AC-7.1.14: change one occurrence
    let o2 = row_id(&e, "o2");
    let mut inp = input(&e, &o2, "Moved sync", utc(2026, 10, 27, 15, 0), None);
    inp.occurrence_start = Some(utc(2026, 10, 27, 13, 0));
    let got = write::save(&e.db, &e.factory, &CalEventInput { scope: Some("occurrence".into()), ..inp }).unwrap();
    assert_eq!((got.summary.as_str(), got.start), ("Moved sync", utc(2026, 10, 27, 15, 0)));
    let patch = requests(&e, "PATCH").pop().unwrap();
    assert_eq!(patch.path(), "/me/events/o2");
    assert_eq!(patch.headers.get("if-match").map(String::as_str), Some("W/\"etag-o2\""));
    let b = patch.json();
    assert_eq!(b["subject"], "Moved sync");
    assert!(b.get("recurrence").is_none(), "an occurrence has no recurrence of its own: {b}");
    assert_eq!(rows(&e.db).len(), 3, "no row twice");
    // delete another one
    let o3 = row_id(&e, "o3");
    write::delete(&e.db, &e.factory, &o3, Some(Scope::Occurrence), None).unwrap();
    let del = requests(&e, "DELETE").pop().unwrap();
    assert_eq!((del.path(), del.headers.get("if-match").map(String::as_str)), ("/me/events/o3", Some("W/\"etag-o3\"")));
    assert_eq!(rows(&e.db).len(), 2);
    // the slot stays empty: it is remembered as deleted
    let gone: i64 = lock(&e.db).query_row("SELECT COUNT(*) FROM cal_tombstones WHERE series_id='ser1'", [], |r| r.get(0)).unwrap();
    assert_eq!(gone, 1);
}

#[test]
fn the_whole_series_is_fetched_then_patched_and_shows_the_mapped_rule() {
    let e = env(weekly_tuesday());
    let o1 = row_id(&e, "o1");
    // AC-7.1.15: the form for the whole series: the master is fetched, its pattern is the rule "every week on Tuesday"
    let d = series::get(&e.db, &e.factory, &o1, Scope::Series, None).unwrap();
    assert_eq!((d.event.rrule.as_deref(), d.pattern_unsupported, d.event.start), (Some("FREQ=WEEKLY;BYDAY=TU"), false, utc(2026, 10, 20, 13, 0)));
    assert_eq!(requests(&e, "GET").iter().filter(|r| r.path() == "/me/events/ser1").count(), 1);
    // a title change: GET (the version tag) then PATCH of the master with that tag, no recurrence
    let inp = input(&e, &o1, "Renamed", utc(2026, 10, 20, 13, 0), Some("FREQ=WEEKLY;BYDAY=TU"));
    write::save(&e.db, &e.factory, &CalEventInput { scope: Some("series".into()), ..inp }).unwrap();
    let p = requests(&e, "PATCH").pop().unwrap();
    assert_eq!((p.path(), p.headers.get("if-match").map(String::as_str)), ("/me/events/ser1", Some("W/\"m1\"")));
    assert_eq!(p.json()["subject"], "Renamed");
    assert!(p.json().get("recurrence").is_none() && p.json().get("start").is_none(), "{}", p.json());
    // the rule changes to every weekday: the pattern travels with the start date of the series
    let inp = input(&e, &o1, "Renamed", utc(2026, 10, 20, 13, 0), Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));
    write::save(&e.db, &e.factory, &CalEventInput { scope: Some("series".into()), ..inp }).unwrap();
    let b = requests(&e, "PATCH").pop().unwrap().json();
    assert_eq!(b["recurrence"]["pattern"]["daysOfWeek"], json!(["monday", "tuesday", "wednesday", "thursday", "friday"]));
    assert_eq!(b["recurrence"]["range"]["startDate"], "2026-10-20");
    assert_eq!(b["recurrence"]["range"]["recurrenceTimeZone"], "America/New_York", "the zone of the series, not the one the form was in");
}

#[test]
fn a_pattern_outside_the_mapped_set_is_kept_and_a_title_change_still_saves() {
    let relative = master(
        json!({ "type": "relativeMonthly", "interval": 1, "daysOfWeek": ["monday", "tuesday"], "index": "first" }),
        json!({ "type": "noEnd", "startDate": "2026-10-20", "recurrenceTimeZone": "Eastern Standard Time" }),
    );
    let e = env(relative);
    let o1 = row_id(&e, "o1");
    // AC-7.1.16: the form is told the rule cannot be changed, and has no rule
    let d = series::get(&e.db, &e.factory, &o1, Scope::Series, None).unwrap();
    assert!(d.pattern_unsupported && d.event.rrule.is_none());
    // a title change saves, with no recurrence in the body
    let inp = input(&e, &o1, "New title", utc(2026, 10, 20, 13, 0), None);
    write::save(&e.db, &e.factory, &CalEventInput { scope: Some("series".into()), ..inp }).unwrap();
    let b = requests(&e, "PATCH").pop().unwrap().json();
    assert_eq!(b["subject"], "New title");
    assert!(b.get("recurrence").is_none());
    // a new rule, or this and following (which needs the rule), is refused with the sentence for it
    let inp = input(&e, &o1, "New title", utc(2026, 10, 20, 13, 0), Some("FREQ=DAILY"));
    let err = write::save(&e.db, &e.factory, &CalEventInput { scope: Some("series".into()), ..inp }).unwrap_err();
    assert_eq!(err, "CAL_READ_ONLY: Hey Look! can’t change this repeat rule. You can change it in Outlook.");
    let o2 = row_id(&e, "o2");
    let mut f = input(&e, &o2, "Later", utc(2026, 10, 27, 13, 0), None);
    f.occurrence_start = Some(utc(2026, 10, 27, 13, 0));
    let err = write::save(&e.db, &e.factory, &CalEventInput { scope: Some("following".into()), ..f }).unwrap_err();
    assert!(err.starts_with("CAL_READ_ONLY: Hey Look! can’t change this repeat rule"), "{err}");
}

#[test]
fn this_and_following_cuts_the_master_and_makes_a_new_series() {
    let e = env(weekly_tuesday());
    let o3 = row_id(&e, "o3");
    let slot = utc(2026, 11, 3, 14, 0);
    let mut f = input(&e, &o3, "Late sync", slot, Some("FREQ=WEEKLY;BYDAY=TU"));
    f.occurrence_start = Some(slot);
    f.tzid = Some("America/New_York".into());
    write::save(&e.db, &e.factory, &CalEventInput { scope: Some("following".into()), ..f }).unwrap();
    let cut = requests(&e, "PATCH").pop().unwrap();
    assert_eq!((cut.path(), cut.headers.get("if-match").map(String::as_str)), ("/me/events/ser1", Some("W/\"m1\"")));
    assert_eq!(cut.json()["recurrence"]["range"]["type"], "endDate");
    assert_eq!(cut.json()["recurrence"]["range"]["endDate"], "2026-11-02", "the day before the slot's date: the 3rd's 09:00 occurrence is after the cut, the 27th is the last Tuesday that stays");
    let new = requests(&e, "POST").pop().unwrap().json();
    assert_eq!(new["subject"], "Late sync");
    assert_eq!(new["recurrence"]["pattern"]["daysOfWeek"], json!(["tuesday"]));
    assert_eq!(new["recurrence"]["range"]["startDate"], "2026-11-03");
    // the order: the master is cut, then the new series is made
    let order: Vec<String> = e.srv.requests().iter().filter(|r| matches!(r.method.as_str(), "PATCH" | "POST")).map(|r| format!("{} {}", r.method, r.path())).collect();
    assert_eq!(order, vec!["PATCH /me/events/ser1".to_string(), "POST /me/calendars/AAMkPRIMARY%3D/events".to_string()]);
    // delete this and following: only the cut
    let e = env(weekly_tuesday());
    let o3 = row_id(&e, "o3");
    write::delete(&e.db, &e.factory, &o3, Some(Scope::Following), Some(slot)).unwrap();
    assert_eq!(requests(&e, "PATCH").len(), 1);
    assert!(requests(&e, "POST").is_empty());
    assert_eq!(rows(&e.db).len(), 2, "the occurrence behind the cut is gone here too");
    assert_eq!(lock(&e.db).query_row::<i64, _, _>("SELECT COUNT(*) FROM events WHERE remote_kind='master'", [], |r| r.get(0)).unwrap(), 0, "no master is ever a row");
    // the whole series
    let e = env(weekly_tuesday());
    let o1 = row_id(&e, "o1");
    write::delete(&e.db, &e.factory, &o1, Some(Scope::Series), None).unwrap();
    let del = requests(&e, "DELETE").pop().unwrap();
    assert_eq!((del.path(), del.headers.get("if-match").map(String::as_str)), ("/me/events/ser1", Some("W/\"m1\"")));
    assert!(rows(&e.db).is_empty());
    let _ = e.master;
}

#[test]
fn without_a_connection_the_series_is_not_fetched_and_nothing_changes() {
    let e = env(weekly_tuesday());
    let o1 = row_id(&e, "o1");
    // AC-7.1.17: nothing answers
    let dead = MFactory { base: "http://127.0.0.1:1".into(), token: Arc::new(|| Ok("tok".to_string())) };
    let err = series::get(&e.db, &dead, &o1, Scope::Series, None).unwrap_err();
    assert!(err.starts_with("CAL_OFFLINE:"), "{err}");
    let inp = input(&e, &o1, "x", utc(2026, 10, 20, 13, 0), None);
    let err = write::save(&e.db, &dead, &CalEventInput { scope: Some("series".into()), ..inp }).unwrap_err();
    assert!(err.starts_with("CAL_OFFLINE:"), "{err}");
    assert_eq!(calendar::get_event(&lock(&e.db), &o1).unwrap().summary, "Weekly sync");
}
