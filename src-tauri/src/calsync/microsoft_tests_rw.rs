//! Contract tests of the Microsoft provider, part 2: writes with ETags, the RSVP mirror, throttling, and the consent / revoked-grant
//! states (against a fake Graph server and a fake token endpoint; no real account).
use super::super::engine;
use super::super::fake_http::{FakeServer, Resp};
use super::super::store::tests::ACC;
use super::super::{store, write, ProviderFactory, AUTH, BLOCKED, BUSY, ERROR, NOT_SET_UP, OFFLINE, OK};
use super::tests::*;
use super::*;
use crate::calendar;
use crate::lock;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

fn write_server() -> FakeServer {
    FakeServer::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/me/calendars/AAMkWORK-1_x%3D/events") => {
            let b = r.json();
            let mut v = ev_json("newid", b["subject"].as_str().unwrap_or(""), "2026-10-20T21:00:00.0000000", "2026-10-20T22:00:00.0000000");
            v["@odata.etag"] = json!("W/\"created\"");
            if b["isAllDay"] == json!(true) {
                v["isAllDay"] = json!(true);
                v["start"] = json!({ "dateTime": "2026-10-20T00:00:00.0000000", "timeZone": "UTC" });
                v["end"] = json!({ "dateTime": "2026-10-22T00:00:00.0000000", "timeZone": "UTC" });
            }
            Resp::json(201, v)
        }
        ("PATCH", "/me/events/AAMkEV%3D") => {
            let mut v = ev_json("AAMkEV=", "Updated", "2026-10-20T13:00:00.0000000", "2026-10-20T14:00:00.0000000");
            v["@odata.etag"] = json!("W/\"after\"");
            Resp::json(200, v)
        }
        ("DELETE", "/me/events/AAMkEV%3D") => Resp::empty(204),
        ("DELETE", "/me/events/gone") => Resp::json(404, json!({ "error": { "code": "ErrorItemNotFound", "message": "The specified object was not found in the store." } })),
        ("POST", p) if p.starts_with("/me/events/AAMkEV%3D/") => Resp::empty(202),
        (m, p) => panic!("unexpected {m} {p}"),
    })
}

fn guest(email: &str, role: &str) -> CalAttendee {
    CalAttendee { email: email.into(), name: None, role: role.into(), status: "needs-action".into(), is_you: false }
}

#[test]
fn create_sends_the_event_in_its_zone_with_guests_and_a_reminder_and_lets_outlook_send_the_invitations() {
    let srv = write_server();
    let draft = EventDraft {
        summary: "Dinner".into(),
        start: utc(2026, 10, 20, 21, 0),
        end: utc(2026, 10, 20, 22, 0),
        all_day: false,
        tzid: Some("America/New_York".into()),
        location: Some("Home".into()),
        description: Some("Bring wine".into()),
        attendees: vec![CalAttendee { name: Some("Guest".into()), ..guest("g@x.test", "optional") }, guest("h@x.test", "required")],
        reminder_min: Some(30),
        rrule: None,
    };
    let got = prov(&srv).create(&work(), &draft).unwrap();
    assert_eq!((got.id.as_str(), got.etag.as_str()), ("newid", "W/\"created\""));
    let r = &srv.requests()[0];
    assert!(r.query("sendUpdates").is_none() && !r.headers.contains_key("if-match"));
    let b = r.json();
    assert_eq!(b["subject"], "Dinner");
    assert_eq!(b["start"], json!({ "dateTime": "2026-10-20T17:00:00", "timeZone": "America/New_York" }), "the wall clock of the event's zone");
    assert_eq!(b["end"], json!({ "dateTime": "2026-10-20T18:00:00", "timeZone": "America/New_York" }));
    assert_eq!((b["isAllDay"].clone(), b["isReminderOn"].clone(), b["reminderMinutesBeforeStart"].clone()), (json!(false), json!(true), json!(30)));
    assert_eq!(b["location"], json!({ "displayName": "Home" }));
    assert_eq!(b["body"], json!({ "contentType": "text", "content": "Bring wine" }));
    assert_eq!(
        b["attendees"],
        json!([
            { "emailAddress": { "address": "g@x.test", "name": "Guest" }, "type": "optional" },
            { "emailAddress": { "address": "h@x.test" }, "type": "required" },
        ])
    );
    // all day: the dates as UTC midnights, the end is the day after the last day; no reminder; no guests
    let day3 = EventDraft { all_day: true, tzid: None, start: day(2026, 10, 20), end: day(2026, 10, 22), reminder_min: None, attendees: vec![], location: None, description: None, ..draft };
    let got = prov(&srv).create(&work(), &day3).unwrap();
    let b = srv.requests()[1].json();
    assert_eq!((b["isAllDay"].clone(), b["start"].clone(), b["end"].clone()), (json!(true), json!({ "dateTime": "2026-10-20T00:00:00", "timeZone": "UTC" }), json!({ "dateTime": "2026-10-22T00:00:00", "timeZone": "UTC" })));
    assert_eq!(b["isReminderOn"], json!(false));
    assert!(b.get("attendees").is_none() && b.get("body").is_none() && b.get("location").is_none());
    assert_eq!((got.all_day, got.start, got.end), (true, day(2026, 10, 20), day(2026, 10, 22)));
    // no zone: UTC
    let utc_draft = EventDraft { all_day: false, tzid: None, start: utc(2026, 10, 20, 9, 0), end: utc(2026, 10, 20, 10, 0), summary: "UTC".into(), ..Default::default() };
    prov(&srv).create(&work(), &utc_draft).unwrap();
    assert_eq!(srv.requests()[2].json()["start"], json!({ "dateTime": "2026-10-20T09:00:00", "timeZone": "UTC" }));
}

#[test]
fn a_zone_name_the_service_refuses_is_sent_once_more_in_utc() {
    let n = Arc::new(Mutex::new(0));
    let n2 = n.clone();
    let srv = FakeServer::start(move |r| {
        *n2.lock().unwrap() += 1;
        if r.json()["start"]["timeZone"] != json!("UTC") {
            return Resp::json(400, json!({ "error": { "code": "ErrorInvalidTimeZone", "message": "The time zone specified in the request is not valid." } }));
        }
        Resp::json(201, ev_json("x", "Zoned", "2026-10-20T21:00:00.0000000", "2026-10-20T22:00:00.0000000"))
    });
    let d = EventDraft { summary: "Zoned".into(), start: utc(2026, 10, 20, 21, 0), end: utc(2026, 10, 20, 22, 0), tzid: Some("Asia/Ho_Chi_Minh".into()), ..Default::default() };
    let got = prov(&srv).create(&work(), &d).unwrap();
    assert_eq!((got.id.as_str(), *n.lock().unwrap()), ("x", 2), "once more, not a loop");
    assert_eq!(srv.requests()[1].json()["start"], json!({ "dateTime": "2026-10-20T21:00:00", "timeZone": "UTC" }), "the same instant");
    // a 400 for another reason is not retried
    let bad = FakeServer::start(|_| Resp::json(400, json!({ "error": { "code": "ErrorInvalidRequest", "message": "Nope." } })));
    assert!(matches!(prov(&bad).create(&work(), &d), Err(SyncErr::Other(t)) if t.contains("Nope")));
    assert_eq!(bad.count(), 1);
}

#[test]
fn patch_sends_if_match_and_only_the_changed_fields_with_cleared_fields_empty() {
    let srv = write_server();
    let patch = EventPatch {
        summary: Some("Updated".into()),
        when: Some(When { start: utc(2026, 10, 20, 13, 0), end: utc(2026, 10, 20, 14, 0), all_day: false, tzid: Some("America/New_York".into()) }),
        location: Some(None),
        attendees: Some(vec![
            CalAttendee { status: "accepted".into(), is_you: true, ..guest("me@outlook.test", "chair") },
            CalAttendee { status: "tentative".into(), ..guest("g@x.test", "required") },
        ]),
        ..Default::default()
    };
    let got = prov(&srv).update(&work(), "AAMkEV=", "W/\"before\"", &patch).unwrap();
    assert_eq!((got.summary.as_str(), got.etag.as_str()), ("Updated", "W/\"after\""));
    let r = &srv.requests()[0];
    assert_eq!((r.method.as_str(), r.headers["if-match"].as_str()), ("PATCH", "W/\"before\""));
    let b = r.json();
    let mut keys: Vec<&str> = b.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(keys, ["attendees", "end", "isAllDay", "location", "start", "subject"], "only what changed");
    assert_eq!(b["location"], json!({ "displayName": "" }), "cleared");
    assert_eq!(b["start"], json!({ "dateTime": "2026-10-20T09:00:00", "timeZone": "America/New_York" }));
    assert_eq!(b["attendees"], json!([{ "emailAddress": { "address": "g@x.test" }, "type": "required" }]), "the whole list; the organizer is implicit");
    // all day: dates in UTC, flagged
    let all = EventPatch { when: Some(When { start: day(2026, 10, 20), end: day(2026, 10, 21), all_day: true, tzid: None }), ..Default::default() };
    prov(&srv).update(&work(), "AAMkEV=", "W/\"after\"", &all).unwrap();
    let b = srv.requests()[1].json();
    assert_eq!((b["isAllDay"].clone(), b["start"].clone()), (json!(true), json!({ "dateTime": "2026-10-20T00:00:00", "timeZone": "UTC" })));
    // reminder off, description cleared / set
    let rem = EventPatch { reminder_min: Some(None), description: Some(None), ..Default::default() };
    prov(&srv).update(&work(), "AAMkEV=", "W/\"after\"", &rem).unwrap();
    let b = srv.requests()[2].json();
    assert_eq!((b["isReminderOn"].clone(), b["body"].clone()), (json!(false), json!({ "contentType": "text", "content": "" })));
    let rem = EventPatch { reminder_min: Some(Some(60)), description: Some(Some("new".into())), ..Default::default() };
    prov(&srv).update(&work(), "AAMkEV=", "W/\"after\"", &rem).unwrap();
    let b = srv.requests()[3].json();
    assert_eq!((b["reminderMinutesBeforeStart"].clone(), b["body"]["content"].clone()), (json!(60), json!("new")));
}

#[test]
fn delete_sends_if_match_and_a_missing_event_counts_as_gone() {
    let srv = write_server();
    prov(&srv).delete(&work(), "AAMkEV=", "W/\"e\"").unwrap();
    let r = &srv.requests()[0];
    assert_eq!((r.method.as_str(), r.headers["if-match"].as_str()), ("DELETE", "W/\"e\""));
    assert_eq!(prov(&srv).delete(&work(), "gone", "W/\"e\""), Err(SyncErr::NotFound));
}

#[test]
fn an_rsvp_mirror_answers_silently() {
    let srv = write_server();
    for (rsvp, action) in [(Rsvp::Accepted, "accept"), (Rsvp::Tentative, "tentativelyAccept"), (Rsvp::Declined, "decline")] {
        prov(&srv).respond(&work(), "AAMkEV=", "W/\"e\"", rsvp, "me@outlook.test", &[]).unwrap();
        let r = srv.requests().pop().unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path(), format!("/me/events/AAMkEV%3D/{action}"));
        assert_eq!(r.json(), json!({ "sendResponse": false }), "the organizer got the reply mail from the app already");
    }
}

fn synced_event_input(db: &crate::Db, remote: &str, summary: &str) -> (calendar::CalEventInput, String) {
    let (id, cal) = {
        let c = lock(db);
        c.query_row("SELECT id,calendar_id FROM events WHERE remote_id=?1", [remote], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap()
    };
    let e = calendar::get_event(&lock(db), &id).unwrap();
    let input = calendar::CalEventInput {
        id: Some(id.clone()),
        account_id: None,
        summary: summary.into(),
        start: e.start,
        end: e.end,
        all_day: false,
        tzid: e.tzid,
        location: None,
        description: None,
        attendees: vec![],
        rrule: None,
        reminder_min: e.reminder_min,
        calendar_id: Some(cal),
        scope: None,
        occurrence_start: None,
    };
    (input, id)
}

#[test]
fn a_412_is_a_conflict_the_server_version_is_pulled_and_a_404_removes_the_row() {
    let (db, sid) = setup_db();
    let edited = Arc::new(Mutex::new(false));
    let mode = Arc::new(Mutex::new(412));
    let (e2, m2) = (edited.clone(), mode.clone());
    let srv = FakeServer::start(move |r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        match r.method.as_str() {
            "GET" => {
                let (title, etag) = if *e2.lock().unwrap() { ("Edited on the phone", "W/\"etag-new\"") } else { ("Lunch", "W/\"etag-a\"") };
                let mut v = ev_json("a", title, "2026-10-20T13:00:00.0000000", "2026-10-20T14:00:00.0000000");
                v["@odata.etag"] = json!(etag);
                Resp::json(200, page(vec![v], None, Some(format!("{}/me/calendarView/delta?$deltatoken=D{}", me(r), *e2.lock().unwrap() as u8))))
            }
            "PATCH" => {
                let want = if *e2.lock().unwrap() { "W/\"etag-new\"" } else { "W/\"etag-a\"" };
                assert_eq!(r.headers["if-match"], want, "the etag of the version this computer has");
                *e2.lock().unwrap() = true;
                match *m2.lock().unwrap() {
                    412 => Resp::json(412, json!({ "error": { "code": "ErrorIrresolvableConflict", "message": "The change key passed in the request does not match the current change key for the item." } })),
                    _ => Resp::json(404, json!({ "error": { "code": "ErrorItemNotFound", "message": "The specified object was not found in the store." } })),
                }
            }
            m => panic!("unexpected {m}"),
        }
    });
    let factory = MFactory::new(&srv);
    engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    let (input, id) = synced_event_input(&db, "a", "Edited here");
    let err = write::save(&db, &factory, &input).unwrap_err();
    assert!(err.starts_with("CAL_CONFLICT: This event was changed in Outlook, so its latest version is shown."), "{err}");
    assert_eq!(calendar::get_event(&lock(&db), &id).unwrap().summary, "Edited on the phone", "the server's version is what is shown");
    // deleted there meanwhile: CAL_GONE and the row goes
    *mode.lock().unwrap() = 404;
    let (input, _) = synced_event_input(&db, "a", "Edited again");
    let err = write::save(&db, &factory, &input).unwrap_err();
    assert!(err.starts_with("CAL_GONE: This event was deleted in Outlook."), "{err}");
    assert!(rows(&db).is_empty());
}

#[test]
fn saving_in_a_synced_outlook_calendar_creates_the_event_and_a_repeating_one_with_its_pattern() {
    let (db, sid) = setup_db();
    let srv = FakeServer::start(|r| {
        if let Some(l) = list_ok(r) {
            return l;
        }
        match r.method.as_str() {
            "GET" => Resp::json(200, page(vec![], None, Some(format!("{}/me/calendarView/delta?$deltatoken=D0", me(r))))),
            "POST" => {
                assert_eq!(r.path(), "/me/calendars/AAMkPRIMARY%3D/events");
                Resp::json(201, ev_json("new", r.json()["subject"].as_str().unwrap(), "2026-10-20T13:00:00.0000000", "2026-10-20T14:00:00.0000000"))
            }
            m => panic!("unexpected {m}"),
        }
    });
    let factory = MFactory::new(&srv);
    engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    let input = calendar::CalEventInput {
        id: None,
        account_id: None,
        summary: "New".into(),
        start: utc(2026, 10, 20, 13, 0),
        end: utc(2026, 10, 20, 14, 0),
        all_day: false,
        tzid: None,
        location: None,
        description: None,
        attendees: vec![],
        rrule: None,
        reminder_min: Some(15),
        calendar_id: Some(cal_id()),
        scope: None,
        occurrence_start: None,
    };
    let saved = write::save(&db, &factory, &input).unwrap();
    assert_eq!((saved.summary.as_str(), saved.remote_id.as_deref(), saved.etag.as_deref()), ("New", Some("new"), Some("W/\"etag-new\"")));
    // a repeating event (W7.1): the rule travels as Graph's pattern and range
    write::save(&db, &factory, &calendar::CalEventInput { rrule: Some("FREQ=WEEKLY;BYDAY=TU".into()), tzid: Some("America/New_York".into()), ..input }).unwrap();
    let sent = srv.requests().into_iter().filter(|r| r.method == "POST").last().unwrap().json();
    assert_eq!(sent["recurrence"]["pattern"]["type"], "weekly");
    assert_eq!(sent["recurrence"]["pattern"]["daysOfWeek"], json!(["tuesday"]));
    assert_eq!(sent["recurrence"]["range"]["type"], "noEnd");
    assert_eq!(sent["recurrence"]["range"]["startDate"], "2026-10-20");
    assert_eq!(sent["recurrence"]["range"]["recurrenceTimeZone"], "America/New_York");
}

// ---------------------------------------------------------------- errors

#[test]
fn errors_are_sorted_into_the_sync_states() {
    let e = |status: u16, read: bool, body: Value| map_error(status, read, Some(Duration::from_secs(7)), &body.to_string());
    let code = |status: u16, read: bool, code: &str| e(status, read, json!({ "error": { "code": code, "message": "msg" } }));
    let seven = SyncErr::RateLimited(Some(Duration::from_secs(7)));
    // throttling: Retry-After honoured
    assert_eq!(code(429, true, "TooManyRequests"), seven);
    assert_eq!(code(429, true, "ApplicationThrottled"), seven);
    assert_eq!(code(503, true, "ErrorServerBusy"), seven);
    assert_eq!(code(504, true, "x"), seven);
    assert_eq!(code(509, true, "ActivityLimitReached"), seven);
    assert_eq!(map_error(503, true, None, "<html>down</html>"), SyncErr::RateLimited(None));
    // access that ended
    assert_eq!(code(401, true, "InvalidAuthenticationToken"), SyncErr::Auth);
    // the organization has not approved the app
    assert!(matches!(
        e(403, true, json!({ "error": { "code": "Authorization_RequestDenied", "message": "AADSTS65001: The user or administrator has not consented to use the application" } })),
        SyncErr::Blocked(_)
    ));
    assert!(matches!(code(403, true, "ErrorAccessDenied"), SyncErr::Blocked(m) if m == "msg"));
    // ... but a refused write is only an error with the reason
    assert!(matches!(code(403, false, "ErrorAccessDenied"), SyncErr::Other(m) if m.contains("msg")));
    // the account has no mailbox this API reaches: nothing the person can fix
    assert!(matches!(
        e(404, true, json!({ "error": { "code": "MailboxNotEnabledForRESTAPI", "message": "The mailbox is either inactive, soft-deleted, or is hosted on-premise." } })),
        SyncErr::NotSetUp(m) if m.contains("on-premise")
    ));
    // the delta state
    assert_eq!(code(410, true, "syncStateNotFound"), SyncErr::Gone);
    assert_eq!(code(400, true, "ErrorInvalidSyncStateData"), SyncErr::Gone);
    assert_eq!(code(410, true, "resyncRequired"), SyncErr::Gone);
    // writes
    assert_eq!(code(404, true, "ErrorItemNotFound"), SyncErr::NotFound);
    assert_eq!(code(412, false, "PreconditionFailed"), SyncErr::Conflict);
    assert_eq!(code(409, false, "ErrorIrresolvableConflict"), SyncErr::Conflict);
    assert!(matches!(code(409, false, "ErrorItemSave"), SyncErr::Other(m) if m.contains("msg")));
    assert!(matches!(code(400, false, "ErrorInvalidRequest"), SyncErr::Other(m) if m.contains("rejected") && m.contains("msg")));
    assert!(matches!(map_error(418, true, None, "<html>teapot</html>"), SyncErr::Other(m) if m.contains("418") && m.contains("teapot")));
}

fn sync_with_status(status: u16, body: Value, headers: Vec<(&str, &str)>) -> (store::Source, usize) {
    let (db, sid) = setup_db();
    let hs: Vec<(String, String)> = headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let srv = FakeServer::start(move |_| Resp { status, headers: hs.clone(), body: body.to_string() });
    engine::sync_source(&db, &MFactory::new(&srv), &sid, clock(T0), &|| {}).unwrap();
    (store::get_source(&lock(&db), &sid).unwrap(), srv.count())
}

#[test]
fn a_throttled_round_waits_for_retry_after_and_the_other_failures_set_their_states() {
    let (s, n) = sync_with_status(429, json!({ "error": { "code": "TooManyRequests", "message": "Too many requests" } }), vec![("Retry-After", "120")]);
    assert_eq!((s.status.as_str(), s.retry_at, n), (BUSY, Some(T0 + 120), 1));
    // 503 without Retry-After: the back-off (1 minute after the first failure)
    let (s, _) = sync_with_status(503, json!({ "error": { "code": "ErrorServerBusy" } }), vec![]);
    assert_eq!((s.status.as_str(), s.retry_at, s.fail_count), (BUSY, Some(T0 + 60), 1));
    // admin approval needed, whatever the status
    let (s, _) = sync_with_status(403, json!({ "error": { "code": "Authorization_RequestDenied", "message": "AADSTS65001: The user or administrator has not consented to use the application with ID" } }), vec![]);
    assert_eq!((s.status.as_str(), s.retry_at), (BLOCKED, None));
    assert!(s.last_error.unwrap().contains("AADSTS65001"));
    // 401 after a fresh token: access ended
    let (s, _) = sync_with_status(401, json!({ "error": { "code": "InvalidAuthenticationToken" } }), vec![]);
    assert_eq!((s.status.as_str(), s.retry_at), (AUTH, None));
    // no Exchange Online mailbox
    let (s, _) = sync_with_status(404, json!({ "error": { "code": "MailboxNotEnabledForRESTAPI", "message": "The mailbox is either inactive, soft-deleted, or is hosted on-premise." } }), vec![]);
    assert_eq!((s.status.as_str(), s.retry_at), (NOT_SET_UP, None));
    // an unexpected failure: an error with the reason and a back-off
    let (s, _) = sync_with_status(400, json!({ "error": { "code": "ErrorInvalidRequest", "message": "Something is off" } }), vec![]);
    assert_eq!((s.status.as_str(), s.retry_at), (ERROR, Some(T0 + 60)));
    assert!(s.last_error.unwrap().contains("Something is off"));
}

#[test]
fn no_request_is_made_during_a_retry_after_and_the_next_one_is_normal() {
    let (db, sid) = setup_db();
    let limited = Arc::new(Mutex::new(true));
    let l2 = limited.clone();
    let srv = FakeServer::start(move |r| {
        if *l2.lock().unwrap() {
            return Resp::json(429, json!({ "error": { "code": "TooManyRequests" } })).with("Retry-After", "120");
        }
        list_ok(r).unwrap_or_else(|| Resp::json(200, page(vec![], None, Some(format!("{}/me/calendarView/delta?$deltatoken=D1", me(r))))))
    });
    let factory = MFactory::new(&srv);
    let req: HashSet<String> = [ACC.to_string()].into_iter().collect();
    engine::tick(&db, &factory, clock(T0), &req, &|| {});
    let n = srv.count();
    assert_eq!(n, 1);
    *limited.lock().unwrap() = false;
    assert!(engine::tick(&db, &factory, clock(T0 + 119), &req, &|| {}).is_empty());
    assert_eq!(srv.count(), n, "nothing for 120 s, not even on Sync now");
    engine::tick(&db, &factory, clock(T0 + 120), &HashSet::new(), &|| {});
    assert!(srv.count() > n);
    let s = store::get_source(&lock(&db), &sid).unwrap();
    assert_eq!((s.status.as_str(), s.last_error, s.retry_at), (OK, None, None));
}

/// The token endpoint answers with the error; the engine must settle in the state, call the API zero times and not retry.
fn token_failure(body: Value) -> (String, usize, usize) {
    let (db, sid) = setup_db();
    let token_srv = FakeServer::start(move |_| Resp::json(400, body.clone()));
    let api = FakeServer::start(|_| panic!("the API must not be called without a token"));
    let url = format!("{}/common/oauth2/v2.0/token", token_srv.base);
    let factory = MFactory {
        base: api.base.clone(),
        token: Arc::new(move || {
            crate::oauth::refresh_at(&url, "cid", "", "rt", Some(crate::oauth::Provider::Microsoft.scope_for(crate::oauth::Purpose::Calendar))).map(|r| r.access).map_err(SyncErr::from)
        }),
    };
    let req: HashSet<String> = [ACC.to_string()].into_iter().collect();
    engine::tick(&db, &factory, clock(T0), &req, &|| {});
    let status = store::get_source(&lock(&db), &sid).unwrap().status;
    for i in 1..6 {
        let again = engine::tick(&db, &factory, clock(T0 + i * 3600), &req, &|| {});
        if matches!(status.as_str(), AUTH | BLOCKED | NOT_SET_UP) {
            assert!(again.is_empty(), "no retry loop in {status}");
        }
    }
    (status, token_srv.count(), api.count())
}

#[test]
fn revoked_consent_and_admin_approval_set_their_states_with_no_api_call_and_no_retry_loop() {
    // the person removed the app at account.live.com/consent or changed the password, or the refresh token lapsed
    for body in [
        json!({ "error": "invalid_grant", "error_description": "AADSTS70008: The provided authorization code or refresh token has expired due to inactivity." }),
        json!({ "error": "invalid_grant", "error_description": "AADSTS50173: The provided grant has expired due to it being revoked, a fresh auth token is needed." }),
        json!({ "error": "interaction_required", "error_description": "AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication to access" }),
        json!({ "error": "login_required", "error_description": "AADSTS50058: A silent sign-in request was sent but no user is signed in." }),
    ] {
        assert_eq!(token_failure(body.clone()), (AUTH.to_string(), 1, 0), "{body}");
    }
    // the organization has to approve the app
    for body in [
        json!({ "error": "invalid_grant", "error_description": "AADSTS65001: The user or administrator has not consented to use the application with ID 'x'. Send an interactive authorization request for this user and resource." }),
        json!({ "error": "consent_required", "error_description": "AADSTS65001: needs consent" }),
        json!({ "error": "interaction_required", "error_description": "AADSTS90094: The grant requires admin permission." }),
        json!({ "error": "access_denied", "error_description": "AADSTS65004: ..." }),
    ] {
        assert_eq!(token_failure(body.clone()), (BLOCKED.to_string(), 1, 0), "{body}");
    }
    // the registration is wrong
    for body in [
        json!({ "error": "invalid_client", "error_description": "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'." }),
        json!({ "error": "unauthorized_client", "error_description": "AADSTS700016: Application with identifier 'x' was not found in the directory" }),
    ] {
        assert_eq!(token_failure(body.clone()), (NOT_SET_UP.to_string(), 1, 0), "{body}");
    }
    // a temporary failure of the token endpoint is not an end of access
    let (status, _, api) = token_failure(json!({ "error": "temporarily_unavailable", "error_description": "AADSTS90033: A Microsoft Entra service is temporarily unavailable." }));
    assert_eq!((status.as_str(), api), (ERROR, 0));
}

#[test]
fn no_network_is_offline_and_a_token_that_cannot_be_read_ends_access() {
    let (db, sid) = setup_db();
    let dead = crate::testutil::dead_addr();
    let factory = MFactory { base: format!("http://{dead}"), token: Arc::new(|| Ok("t".to_string())) };
    engine::sync_source(&db, &factory, &sid, clock(T0), &|| {}).unwrap();
    let s = store::get_source(&lock(&db), &sid).unwrap();
    assert_eq!((s.status.as_str(), s.retry_at, s.last_error), (OFFLINE, Some(T0 + 60), None));
    // no stored token (the credential store entry was deleted): access ended
    let factory = MFactory { base: factory.base, token: Arc::new(|| Err(crate::oauth::TokenFail::Missing("no stored Microsoft token".into()).into())) };
    engine::sync_source(&db, &factory, &sid, clock(T0 + 100), &|| {}).unwrap();
    assert_eq!(store::get_source(&lock(&db), &sid).unwrap().status, AUTH);
}

// ---------------------------------------------------------------- wiring

#[test]
fn the_app_factory_builds_a_microsoft_provider_and_the_kind_is_switched_on() {
    assert!(Kind::Microsoft.enabled() && Kind::Google.enabled());
    let (db, sid) = setup_db();
    let src = store::get_source(&lock(&db), &sid).unwrap();
    assert!(super::super::cmds::AppFactory { db: db.clone() }.provider(&src).is_ok());
    assert!(super::provider(&db, &src).is_ok());
}

#[test]
fn the_release_build_talks_to_graph_only() {
    // `provider()` takes the base from `http::base_url`, which ignores HEYLOOK_GRAPH_BASE in a release build
    assert_eq!(API, "https://graph.microsoft.com/v1.0");
    assert!(http::base_url("HEYLOOK_GRAPH_NOT_SET", API).starts_with("https://graph.microsoft.com/"));
    assert!(!prov(&FakeServer::start(|_| Resp::empty(200))).own_link("http://127.0.0.1:1/x"));
}
