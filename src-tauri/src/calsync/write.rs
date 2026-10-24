//! Writing to a synced calendar: create, change, delete of a single event, and the silent mirror of an RSVP.
//! The provider is asked first; the local row is written from its answer (with the new etag). A write that cannot reach the provider
//! changes nothing locally (there is no offline queue).
use super::engine::{self, Clock};
use super::store::{self, CalRow, Source};
use super::{EventDraft, EventPatch, Kind, ProviderFactory, Rsvp, SyncErr, When};
use crate::calendar::{self, CalAttendee, CalEvent, CalEventInput};
use crate::db::R;
use crate::{lock, Db};

/// The error text the UI shows, with the code the front end tells them apart by.
pub fn error_text(e: &SyncErr, kind: Kind, calendar: &str, email: &str) -> String {
    let service = kind.service();
    match e {
        SyncErr::Offline => format!("CAL_OFFLINE: You’re offline. Changes to {calendar} need a connection."),
        SyncErr::Conflict => format!("CAL_CONFLICT: This event was changed in {service}, so its latest version is shown."),
        SyncErr::NotFound => format!("CAL_GONE: This event was deleted in {service}."),
        SyncErr::Auth | SyncErr::Blocked(_) => {
            format!("CAL_AUTH: Calendar access for {email} ended. Allow access again in Settings > Mailboxes > Calendar to keep syncing.")
        }
        SyncErr::RateLimited(_) => format!("CAL_BUSY: {service} is busy. Try again in a moment."),
        SyncErr::NotSetUp(t) => format!("CAL_NOT_SET_UP: Calendar sync isn’t available in this version of Hey Look! ({t})."),
        SyncErr::Gone | SyncErr::Other(_) => format!("CAL_ERROR: Couldn’t save to {service}: {e}."),
    }
}

/// Why a synced event cannot be changed, as a sentence.
fn read_only_text(reason: &str, calendar: &str, kind: Kind) -> String {
    let service = kind.service();
    match reason {
        "repeating" => format!("CAL_READ_ONLY: Repeating events of {calendar} can be changed in {service} for now."),
        "organizer" => "CAL_READ_ONLY: Only the organizer can change this event.".to_string(),
        _ => format!("CAL_READ_ONLY: {calendar} is read only."),
    }
}

struct Target {
    cal: CalRow,
    src: Source,
    email: String,
}

fn target(db: &Db, calendar_id: &str) -> R<Target> {
    let c = lock(db);
    let cal = store::get_calendar(&c, calendar_id).ok_or("CAL_GONE: This calendar is no longer synced.")?;
    let src = store::get_source(&c, &cal.source_id).ok_or("CAL_GONE: This calendar is no longer synced.")?;
    let email = crate::db::get_account(&c, &src.account_id).map(|a| a.email).unwrap_or_default();
    Ok(Target { cal, src, email })
}

/// A failure that needs the user (access ended, blocked, not set up) is shown in Settings as well.
fn note_failure(db: &Db, t: &Target, e: &SyncErr) {
    if matches!(e, SyncErr::Auth | SyncErr::Blocked(_) | SyncErr::NotSetUp(_)) {
        let (status, text, retry, fails) = engine::classify(e, t.src.fail_count, Clock::real());
        let _ = store::set_status(&lock(db), &t.src.id, status, text.as_deref(), retry, fails);
    }
}

fn fail(db: &Db, t: &Target, e: SyncErr) -> String {
    note_failure(db, t, &e);
    error_text(&e, t.src.kind, &t.cal.name, &t.email)
}

fn norm(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The guests of an input: no chair, no duplicates, lower-case addresses; the answers already given are kept.
fn guests(inp: &CalEventInput, old: Option<&CalEvent>, me: &str) -> Vec<CalAttendee> {
    let mut out: Vec<CalAttendee> = vec![];
    for a in inp.attendees.iter().filter(|a| a.role != "chair") {
        let email = norm(&a.email);
        if email.is_empty() || email == me || out.iter().any(|x| x.email == email) {
            continue;
        }
        let status = old.and_then(|o| o.attendees.iter().find(|x| norm(&x.email) == email)).map(|x| x.status.clone()).unwrap_or_else(|| "needs-action".into());
        out.push(CalAttendee {
            email,
            name: a.name.clone().filter(|n| !n.trim().is_empty()),
            role: if a.role == "optional" { "optional".into() } else { "required".into() },
            status,
            is_you: false,
        });
    }
    out
}

/// The fields that differ between the stored event and the input. Attendees travel as the whole list.
pub fn diff(old: &CalEvent, inp: &CalEventInput, me: &str) -> EventPatch {
    let mut p = EventPatch::default();
    let summary = if inp.summary.trim().is_empty() { "(No title)".to_string() } else { inp.summary.trim().to_string() };
    if summary != old.summary {
        p.summary = Some(summary);
    }
    let tzid = inp.tzid.clone().filter(|t| crate::ical::iana_for(t).is_some());
    if inp.start != old.start || inp.end != old.end || inp.all_day != old.all_day || (!inp.all_day && tzid != old.tzid) {
        p.when = Some(When { start: inp.start, end: inp.end, all_day: inp.all_day, tzid });
    }
    if clean(&inp.location) != old.location {
        p.location = Some(clean(&inp.location));
    }
    if inp.description.clone().filter(|d| !d.trim().is_empty()) != old.description {
        p.description = Some(inp.description.clone().filter(|d| !d.trim().is_empty()));
    }
    if inp.reminder_min != old.reminder_min {
        p.reminder_min = Some(inp.reminder_min);
    }
    let new = guests(inp, Some(old), me);
    let was: Vec<(String, String)> = {
        let mut v: Vec<(String, String)> = old
            .attendees
            .iter()
            .filter(|a| a.role != "chair" && norm(&a.email) != me)
            .map(|a| (norm(&a.email), if a.role == "optional" { "optional".to_string() } else { "required".to_string() }))
            .collect();
        v.sort();
        v
    };
    let mut now: Vec<(String, String)> = new.iter().map(|a| (a.email.clone(), a.role.clone())).collect();
    now.sort();
    if was != now {
        // the whole list: the user's own entry and the organizer stay, the guests are the new ones
        let mut all: Vec<CalAttendee> = old.attendees.iter().filter(|a| a.role == "chair" || norm(&a.email) == me).cloned().collect();
        all.extend(new);
        p.attendees = Some(all);
    }
    p
}

/// Create or change a single event of a synced calendar.
pub fn save(db: &Db, factory: &dyn ProviderFactory, inp: &CalEventInput) -> R<CalEvent> {
    if inp.end < inp.start {
        return Err("CAL_BAD_TIME: End must be after start.".into());
    }
    let existing = match &inp.id {
        Some(id) => Some(calendar::get_event(&lock(db), id)?),
        None => None,
    };
    let cal_id = match &existing {
        Some(e) => e.calendar_id.clone(),
        None => inp.calendar_id.clone().unwrap_or_default(),
    };
    let t = target(db, &cal_id)?;
    let name = t.cal.name.clone();
    if t.cal.read_only {
        return Err(read_only_text("calendar", &name, t.src.kind));
    }
    if let Some(reason) = existing.as_ref().and_then(|e| e.read_only.as_deref()) {
        return Err(read_only_text(reason, &name, t.src.kind));
    }
    if inp.rrule.as_deref().is_some_and(|r| !r.trim().is_empty()) {
        return Err(format!("CAL_READ_ONLY: Repeating events can be added to {name} in {} for now.", t.src.kind.service()));
    }
    let provider = factory.provider(&t.src).map_err(|e| fail(db, &t, e))?;
    let me = norm(&t.email);
    let remote = t.cal.remote();
    let re = match &existing {
        None => {
            let draft = EventDraft {
                summary: if inp.summary.trim().is_empty() { "(No title)".into() } else { inp.summary.trim().to_string() },
                start: inp.start,
                end: inp.end,
                all_day: inp.all_day,
                tzid: inp.tzid.clone().filter(|t| crate::ical::iana_for(t).is_some()),
                location: clean(&inp.location),
                description: inp.description.clone().filter(|d| !d.trim().is_empty()),
                attendees: guests(inp, None, &me),
                reminder_min: inp.reminder_min,
            };
            provider.create(&remote, &draft).map_err(|e| fail(db, &t, e))?
        }
        Some(old) => {
            let patch = diff(old, inp, &me);
            if patch.is_empty() {
                return Ok(old.clone());
            }
            let remote_id = old.remote_id.clone().ok_or("CAL_GONE: This event is not part of a synced calendar.")?;
            match provider.update(&remote, &remote_id, old.etag.as_deref().unwrap_or(""), &patch) {
                Ok(re) => re,
                Err(e) => return Err(after_failed_write(db, factory, &t, &old.id, &remote_id, e)),
            }
        }
    };
    let saved = {
        let c = lock(db);
        store::upsert_remote(&c, &t.cal, &t.src.account_id, &re)?
    };
    super::request_sync(&t.src.account_id);
    Ok(saved)
}

/// What a failed change or delete leaves behind: a conflict pulls the calendar so the server version is shown; an event that is
/// gone there is removed here.
fn after_failed_write(db: &Db, factory: &dyn ProviderFactory, t: &Target, _row_id: &str, remote_id: &str, e: SyncErr) -> String {
    match &e {
        SyncErr::Conflict => {
            let _ = engine::refresh_calendar(db, factory, &t.cal.id, Clock::real());
        }
        SyncErr::NotFound => {
            let _ = store::remove_remote(&lock(db), &t.cal.id, remote_id, chrono::Utc::now().timestamp());
        }
        _ => {}
    }
    fail(db, t, e)
}

/// Delete a single event of a synced calendar at the provider, then here. An event that is gone there already counts as deleted.
pub fn delete(db: &Db, factory: &dyn ProviderFactory, id: &str) -> R<()> {
    let e = calendar::get_event(&lock(db), id)?;
    let t = target(db, &e.calendar_id)?;
    let name = t.cal.name.clone();
    if t.cal.read_only {
        return Err(read_only_text("calendar", &name, t.src.kind));
    }
    if let Some(reason) = e.read_only.as_deref() {
        return Err(read_only_text(reason, &name, t.src.kind));
    }
    let remote_id = e.remote_id.clone().ok_or("CAL_GONE: This event is not part of a synced calendar.")?;
    let provider = factory.provider(&t.src).map_err(|x| fail(db, &t, x))?;
    match provider.delete(&t.cal.remote(), &remote_id, e.etag.as_deref().unwrap_or("")) {
        Ok(()) | Err(SyncErr::NotFound) => {
            store::remove_remote(&lock(db), &t.cal.id, &remote_id, chrono::Utc::now().timestamp())?;
            super::request_sync(&t.src.account_id);
            Ok(())
        }
        Err(x) => Err(after_failed_write(db, factory, &t, id, &remote_id, x)),
    }
}

/// An invitation was answered in Hey Look!: when the event is also in a synced calendar of that mailbox, set the answer there too,
/// silently (the organizer already gets the reply mail from the app). Best effort: a failure changes nothing.
pub fn mirror_rsvp(db: &Db, factory: &dyn ProviderFactory, account_id: &str, uid: &str, recurrence_id: &str, partstat: &str) -> bool {
    let Some(rsvp) = Rsvp::from_partstat(partstat) else { return false };
    let found: Option<(CalEvent, CalRow, Source)> = {
        let c = lock(db);
        let row = c
            .query_row(
                &format!("SELECT {} FROM events WHERE account_id=?1 AND uid=?2 AND recurrence_id=?3 AND remote_id IS NOT NULL LIMIT 1", calendar::COLS),
                rusqlite::params![account_id, uid, recurrence_id],
                calendar::row_event,
            )
            .ok();
        row.and_then(|e| {
            let cal = store::get_calendar(&c, &e.calendar_id)?;
            let src = store::get_source(&c, &cal.source_id)?;
            Some((e, cal, src))
        })
    };
    let Some((mut e, cal, src)) = found else { return false };
    let (Some(remote_id), Ok(provider)) = (e.remote_id.clone(), factory.provider(&src)) else { return false };
    let me = crate::db::get_account(&lock(db), account_id).map(|a| norm(&a.email)).unwrap_or_default();
    let mut list = e.attendees.clone();
    for a in list.iter_mut().filter(|a| norm(&a.email) == me) {
        a.status = partstat.to_string();
    }
    match provider.respond(&cal.remote(), &remote_id, e.etag.as_deref().unwrap_or(""), rsvp, &me, &list) {
        Ok(()) => {
            e.attendees = list;
            e.my_status = Some(partstat.to_string());
            let _ = calendar::save_row(&lock(db), &e);
            super::request_sync(account_id);
            true
        }
        Err(err) => {
            eprintln!("calendar sync: could not mirror the answer to {}: {err}", src.kind.service());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::fake::*;
    use super::super::store::tests::{conn, rc, ACC};
    use super::super::*;
    use super::*;
    use std::sync::{Arc, Mutex};

    const T0: i64 = 1_800_000_000;

    struct Env {
        db: Db,
        fake: FakeProvider,
        factory: FakeFactory,
        cal: String,
    }

    fn env() -> Env {
        let c = conn();
        let s = store::create_source(&c, ACC, Kind::Google, 0).unwrap();
        let db: Db = Arc::new(Mutex::new(c));
        let fake = FakeProvider::new();
        fake.set_calendars(vec![rc("primary", "Me"), RemoteCalendar { read_only: true, ..rc("holidays", "Holidays") }]);
        fake.add_event("primary", RemoteEvent::single("a", "Lunch", T0, T0 + 3600));
        let factory = FakeFactory::new(fake.clone());
        engine::sync_source(&db, &factory, &s.id, Clock { now: T0, jitter: 0.5 }, &|| {}).unwrap();
        Env { db, fake, factory, cal: calendar_id(ACC, Kind::Google, "primary") }
    }

    fn input(e: &Env, id: Option<&str>) -> CalEventInput {
        CalEventInput {
            id: id.map(String::from),
            account_id: None,
            summary: "Lunch".into(),
            start: T0,
            end: T0 + 3600,
            all_day: false,
            tzid: None,
            location: None,
            description: None,
            attendees: vec![],
            rrule: None,
            reminder_min: None,
            calendar_id: Some(e.cal.clone()),
            scope: None,
            occurrence_start: None,
        }
    }

    fn event_id(e: &Env, remote: &str) -> String {
        lock(&e.db).query_row("SELECT id FROM events WHERE remote_id=?1", [remote], |r| r.get(0)).unwrap()
    }

    fn row_count(e: &Env) -> i64 {
        lock(&e.db).query_row("SELECT COUNT(*) FROM events WHERE remote_id IS NOT NULL", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn creating_an_event_goes_to_the_provider_and_the_row_comes_from_its_answer() {
        let e = env();
        let mut inp = input(&e, None);
        inp.summary = "  Dinner ".into();
        inp.location = Some("Home".into());
        inp.attendees = vec![
            CalAttendee { email: "Guest@X.Y".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false },
            CalAttendee { email: "me@gmail.test".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false },
            CalAttendee { email: "boss@x.y".into(), name: None, role: "chair".into(), status: "accepted".into(), is_you: false },
        ];
        let saved = save(&e.db, &e.factory, &inp).unwrap();
        assert_eq!((saved.summary.as_str(), saved.location.as_deref(), saved.calendar_id.as_str()), ("Dinner", Some("Home"), e.cal.as_str()));
        assert_eq!(saved.remote_id.as_deref(), Some("new-1"));
        assert!(saved.etag.is_some(), "the etag of the provider's answer");
        assert_eq!(saved.account_id.as_deref(), Some(ACC));
        let got = e.fake.event("primary", "new-1").unwrap();
        assert_eq!(got.summary, "Dinner");
        assert_eq!(got.attendees.iter().map(|a| a.email.as_str()).collect::<Vec<_>>(), vec!["guest@x.y"], "only the guests: not the user, not the chair");
        assert_eq!(row_count(&e), 2);
    }

    #[test]
    fn changing_an_event_sends_only_the_changed_fields_with_the_etag() {
        let e = env();
        let id = event_id(&e, "a");
        let old = calendar::get_event(&lock(&e.db), &id).unwrap();
        let mut inp = input(&e, Some(&id));
        inp.summary = "Late lunch".into();
        inp.start = T0 + 1800;
        inp.end = T0 + 5400;
        let saved = save(&e.db, &e.factory, &inp).unwrap();
        assert_eq!((saved.summary.as_str(), saved.start), ("Late lunch", T0 + 1800));
        assert_ne!(saved.etag, old.etag, "the new version tag is stored");
        let w = e.fake.writes();
        let line = w.last().unwrap();
        assert!(line.contains(&format!(":a:{}:", old.etag.unwrap())), "If-Match with the stored etag: {line}");
        assert!(line.contains("summary: Some(\"Late lunch\")") && line.contains("when: Some"), "{line}");
        assert!(line.contains("location: None") && line.contains("description: None") && line.contains("attendees: None") && line.contains("reminder_min: None"), "nothing else travels: {line}");
        // saving without a change sends nothing
        let before = e.fake.writes().len();
        let same = input(&e, Some(&id));
        let mut same = same;
        same.summary = "Late lunch".into();
        same.start = T0 + 1800;
        same.end = T0 + 5400;
        save(&e.db, &e.factory, &same).unwrap();
        assert_eq!(e.fake.writes().len(), before);
    }

    #[test]
    fn a_guest_change_sends_the_whole_list() {
        let e = env();
        let id = event_id(&e, "a");
        let mut inp = input(&e, Some(&id));
        inp.attendees = vec![CalAttendee { email: "new@x.y".into(), name: None, role: "optional".into(), status: "needs-action".into(), is_you: false }];
        save(&e.db, &e.factory, &inp).unwrap();
        assert_eq!(e.fake.event("primary", "a").unwrap().attendees.iter().map(|a| (a.email.as_str(), a.role.as_str())).collect::<Vec<_>>(), vec![("new@x.y", "optional")]);
    }

    #[test]
    fn a_conflict_keeps_the_server_version_and_shows_a_note() {
        let e = env();
        let id = event_id(&e, "a");
        // somebody edits the event elsewhere; this computer has not synced yet
        e.fake.update_summary("primary", "a", "Changed on the phone");
        let mut inp = input(&e, Some(&id));
        inp.summary = "Changed here".into();
        let err = save(&e.db, &e.factory, &inp).unwrap_err();
        assert!(err.starts_with("CAL_CONFLICT: This event was changed in Google Calendar, so its latest version is shown."), "{err}");
        assert_eq!(e.fake.event("primary", "a").unwrap().summary, "Changed on the phone", "the server version is untouched");
        assert_eq!(calendar::get_event(&lock(&e.db), &id).unwrap().summary, "Changed on the phone", "and it is what is shown now");
    }

    #[test]
    fn an_event_deleted_elsewhere_is_removed_and_reported() {
        let e = env();
        let id = event_id(&e, "a");
        e.fake.delete_event("primary", "a");
        let mut inp = input(&e, Some(&id));
        inp.summary = "x".into();
        let err = save(&e.db, &e.factory, &inp).unwrap_err();
        assert!(err.starts_with("CAL_GONE: This event was deleted in Google Calendar."), "{err}");
        assert_eq!(row_count(&e), 0);
    }

    #[test]
    fn deleting_goes_to_the_provider_first_and_treats_gone_as_done() {
        let e = env();
        e.fake.add_event("primary", RemoteEvent::single("b", "Other", T0, T0 + 60));
        engine::refresh_calendar(&e.db, &e.factory, &e.cal, Clock { now: T0 + 5, jitter: 0.5 }).unwrap();
        delete(&e.db, &e.factory, &event_id(&e, "a")).unwrap();
        assert!(e.fake.event("primary", "a").is_none());
        assert_eq!(row_count(&e), 1);
        // already deleted there: still fine
        e.fake.remove_event_silently("primary", "b");
        delete(&e.db, &e.factory, &event_id(&e, "b")).unwrap();
        assert_eq!(row_count(&e), 0);
        assert_eq!(lock(&e.db).query_row::<i64, _, _>("SELECT COUNT(*) FROM cal_tombstones", [], |r| r.get(0)).unwrap(), 2);
    }

    #[test]
    fn delete_with_a_stale_etag_is_a_conflict_and_refreshes() {
        let e = env();
        let id = event_id(&e, "a");
        e.fake.update_summary("primary", "a", "Edited");
        let err = delete(&e.db, &e.factory, &id).unwrap_err();
        assert!(err.starts_with("CAL_CONFLICT"), "{err}");
        assert_eq!(row_count(&e), 1);
        assert_eq!(calendar::get_event(&lock(&e.db), &id).unwrap().summary, "Edited");
    }

    #[test]
    fn offline_changes_nothing_and_says_so() {
        let e = env();
        let id = event_id(&e, "a");
        e.fake.fail_next_write(SyncErr::Offline);
        let mut inp = input(&e, Some(&id));
        inp.summary = "typed text".into();
        let err = save(&e.db, &e.factory, &inp).unwrap_err();
        assert_eq!(err, "CAL_OFFLINE: You’re offline. Changes to Me need a connection.");
        assert_eq!(calendar::get_event(&lock(&e.db), &id).unwrap().summary, "Lunch");
        e.fake.fail_next_write(SyncErr::Offline);
        assert!(delete(&e.db, &e.factory, &id).unwrap_err().starts_with("CAL_OFFLINE"));
        assert_eq!(row_count(&e), 1);
        e.fake.fail_next_write(SyncErr::Offline);
        assert!(save(&e.db, &e.factory, &input(&e, None)).unwrap_err().starts_with("CAL_OFFLINE"));
        assert_eq!(row_count(&e), 1);
    }

    #[test]
    fn read_only_cases_are_refused_before_any_request() {
        let e = env();
        let writes = e.fake.writes().len();
        // a read-only calendar: the calendar is the reason
        let mut inp = input(&e, None);
        let hol = {
            let c = lock(&e.db);
            let src = store::source_of_account(&c, ACC).unwrap();
            store::reconcile_calendars(&c, &src, &[rc("primary", "Me"), RemoteCalendar { read_only: true, ..rc("holidays", "Holidays") }]).unwrap();
            calendar_id(ACC, Kind::Google, "holidays")
        };
        inp.calendar_id = Some(hol);
        assert_eq!(save(&e.db, &e.factory, &inp).unwrap_err(), "CAL_READ_ONLY: Holidays is read only.");
        // a repeating event cannot be created
        let mut inp = input(&e, None);
        inp.rrule = Some("FREQ=DAILY".into());
        assert!(save(&e.db, &e.factory, &inp).unwrap_err().starts_with("CAL_READ_ONLY: Repeating events can be added to Me in Google Calendar for now."));
        // an existing repeating series and an event somebody else organizes
        e.fake.add_event("primary", series("s", "Standup", T0, "FREQ=DAILY"));
        let mut other = RemoteEvent::single("o", "Theirs", T0, T0 + 60);
        other.can_edit = false;
        e.fake.add_event("primary", other);
        engine::refresh_calendar(&e.db, &e.factory, &e.cal, Clock { now: T0 + 5, jitter: 0.5 }).unwrap();
        let s_id = event_id(&e, "s");
        let mut inp = input(&e, Some(&s_id));
        inp.summary = "x".into();
        assert_eq!(save(&e.db, &e.factory, &inp).unwrap_err(), "CAL_READ_ONLY: Repeating events of Me can be changed in Google Calendar for now.");
        assert_eq!(delete(&e.db, &e.factory, &s_id).unwrap_err(), "CAL_READ_ONLY: Repeating events of Me can be changed in Google Calendar for now.");
        let o_id = event_id(&e, "o");
        let mut inp = input(&e, Some(&o_id));
        inp.summary = "x".into();
        assert_eq!(save(&e.db, &e.factory, &inp).unwrap_err(), "CAL_READ_ONLY: Only the organizer can change this event.");
        assert_eq!(e.fake.writes().len(), writes, "nothing reached the provider");
        // an end before the start
        let mut bad = input(&e, None);
        bad.end = bad.start - 1;
        assert!(save(&e.db, &e.factory, &bad).unwrap_err().starts_with("CAL_BAD_TIME"));
    }

    #[test]
    fn access_that_ended_during_a_write_is_shown_in_settings_too() {
        let e = env();
        e.fake.fail_next_write(SyncErr::Auth);
        let err = save(&e.db, &e.factory, &input(&e, None)).unwrap_err();
        assert_eq!(err, "CAL_AUTH: Calendar access for me@gmail.test ended. Allow access again in Settings > Mailboxes > Calendar to keep syncing.");
        let s = store::source_of_account(&lock(&e.db), ACC).unwrap();
        assert_eq!(s.status, AUTH);
        // a back-off state is not set by a failed write
        let e2 = env();
        e2.fake.fail_next_write(SyncErr::RateLimited(None));
        assert!(save(&e2.db, &e2.factory, &input(&e2, None)).unwrap_err().starts_with("CAL_BUSY"));
        assert_eq!(store::source_of_account(&lock(&e2.db), ACC).unwrap().status, "ok");
    }

    #[test]
    fn an_answer_to_an_invitation_is_mirrored_silently_with_the_etag() {
        let e = env();
        let mut inv = RemoteEvent::single("inv", "Meeting", T0, T0 + 3600);
        inv.uid = "inv-uid@google.com".into();
        inv.attendees = vec![CalAttendee { email: "me@gmail.test".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false }];
        inv.my_status = Some("needs-action".into());
        e.fake.add_event("primary", inv);
        engine::refresh_calendar(&e.db, &e.factory, &e.cal, Clock { now: T0 + 5, jitter: 0.5 }).unwrap();
        assert!(mirror_rsvp(&e.db, &e.factory, ACC, "inv-uid@google.com", "", "accepted"));
        assert!(e.fake.writes().last().unwrap().contains("respond:primary:inv:Accepted:me@gmail.test"));
        let inv_id = event_id(&e, "inv");
        let row = calendar::get_event(&lock(&e.db), &inv_id).unwrap();
        assert_eq!((row.my_status.as_deref(), row.attendees[0].status.as_str()), (Some("accepted"), "accepted"));
        // an event that is not in a synced calendar, a failure, and an unknown answer do nothing
        assert!(!mirror_rsvp(&e.db, &e.factory, ACC, "nobody@x", "", "accepted"));
        e.fake.fail_next_write(SyncErr::Offline);
        assert!(!mirror_rsvp(&e.db, &e.factory, ACC, "inv-uid@google.com", "", "declined"));
        assert_eq!(calendar::get_event(&lock(&e.db), &inv_id).unwrap().my_status.as_deref(), Some("accepted"));
        assert!(!mirror_rsvp(&e.db, &e.factory, ACC, "inv-uid@google.com", "", "maybe"));
    }

    /// W7.11: an invitation that is not in the synced calendar (the service did not add it) is answered by mail only. Nothing is created, imported or
    /// copied at the provider for it: the sync layer has no way to, and the answer finds no twin to mirror to.
    #[test]
    fn no_provider_write_happens_when_an_invitation_without_twin_is_answered() {
        let e = env();
        // an invitation row of the mailbox (made by mail), with no synced event of that UID
        let remote_id = event_id(&e, "a");
        let remote = calendar::get_event(&lock(&e.db), &remote_id).unwrap();
        let mut inv = remote.clone();
        inv.id = "inv-local".into();
        inv.uid = "only-by-mail@organizer.example".into();
        inv.calendar_id = format!("invites:{ACC}");
        inv.remote_id = None;
        inv.etag = None;
        inv.series_id = None;
        inv.remote_kind = None;
        inv.read_only = None;
        calendar::save_row(&lock(&e.db), &inv).unwrap();
        let before = (e.fake.writes().len(), row_count(&e));
        assert!(!mirror_rsvp(&e.db, &e.factory, ACC, "only-by-mail@organizer.example", "", "accepted"), "no twin, nothing to mirror to");
        assert!(!mirror_rsvp(&e.db, &e.factory, ACC, "only-by-mail@organizer.example", "", "declined"));
        assert_eq!((e.fake.writes().len(), row_count(&e)), before, "no create, import, respond or copy at the provider");
        assert!(e.fake.writes().iter().all(|w| !w.starts_with("create") && !w.starts_with("import")), "{:?}", e.fake.writes());
    }

    #[test]
    fn error_texts_name_the_service_and_the_calendar() {
        let t = |e: SyncErr| error_text(&e, Kind::Microsoft, "Work", "me@x.y");
        assert_eq!(t(SyncErr::Offline), "CAL_OFFLINE: You’re offline. Changes to Work need a connection.");
        assert_eq!(t(SyncErr::Conflict), "CAL_CONFLICT: This event was changed in Outlook, so its latest version is shown.");
        assert_eq!(t(SyncErr::NotFound), "CAL_GONE: This event was deleted in Outlook.");
        assert!(t(SyncErr::Other("HTTP 500".into())).starts_with("CAL_ERROR: Couldn’t save to Outlook: HTTP 500"));
    }
}
