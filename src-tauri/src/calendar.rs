//! Calendar: invitations that arrive by mail (iMIP, RFC 6047), a local event store, RSVP replies and invitations
//! sent from here. There is no CalDAV; events live in the `events` table.

use crate::db::{self, err, Account, R};
use crate::ical::{self, Attendee, IcsEvent, Person};
use crate::{lock, now, Db};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

pub const LOCAL: &str = "local";
const DAY: i64 = 86_400;

static DIRTY: AtomicBool = AtomicBool::new(false);

/// Set when mail processing changed the calendar; the sync wrapper turns it into a `calendar-changed` event.
pub fn mark_dirty() {
    DIRTY.store(true, Ordering::SeqCst);
}

pub fn take_dirty() -> bool {
    DIRTY.swap(false, Ordering::SeqCst)
}

// ------------------------------------------------------------------ types

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalPerson {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

fn role_default() -> String {
    "required".into()
}
fn status_default() -> String {
    "needs-action".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalAttendee {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    /// chair | required | optional
    #[serde(default = "role_default")]
    pub role: String,
    /// accepted | tentative | declined | needs-action | delegated
    #[serde(default = "status_default")]
    pub status: String,
    #[serde(default)]
    pub is_you: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub id: String,
    pub uid: String,
    /// "local" | "invites:<accountId>"
    pub calendar_id: String,
    pub account_id: Option<String>,
    pub summary: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub tzid: Option<String>,
    pub location: Option<String>,
    pub join_url: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<CalPerson>,
    pub attendees: Vec<CalAttendee>,
    pub rrule: Option<String>,
    pub recurrence_text: Option<String>,
    /// confirmed | tentative | cancelled
    pub status: String,
    /// organizer | accepted | tentative | declined | needs-action | null
    pub my_status: Option<String>,
    pub responded_at: Option<i64>,
    pub reminder_min: Option<i64>,
    pub source_message_id: Option<String>,
    pub sequence: i64,
    /// made from confidential mail (see mail::is_confidential): no export, no copy; set when the event is read
    pub confidential: bool,
    /// set for expanded recurrence instances
    pub instance_start: Option<i64>,
    /// Why a synced event cannot be changed here: "calendar" (read-only calendar) | "repeating" | "organizer" (organized by someone
    /// else). `None` = editable.
    pub read_only: Option<String>,
    /// The id, version tag, series and kind the provider gave a synced event (see calsync); `None` for local events and invitations.
    #[serde(skip)]
    pub remote_id: Option<String>,
    #[serde(skip)]
    pub etag: Option<String>,
    #[serde(skip)]
    pub series_id: Option<String>,
    #[serde(skip)]
    pub remote_kind: Option<String>,
    #[serde(skip)]
    pub recurrence_id: String,
    #[serde(skip)]
    pub exdates: Vec<i64>,
    #[serde(skip)]
    pub prev: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalEventInput {
    #[serde(default)]
    pub id: Option<String>,
    /// the account the event belongs to / is sent from
    #[serde(default)]
    pub account_id: Option<String>,
    pub summary: String,
    pub start: i64,
    pub end: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub tzid: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub attendees: Vec<CalAttendee>,
    #[serde(default)]
    pub rrule: Option<String>,
    #[serde(default)]
    pub reminder_min: Option<i64>,
    /// the calendar a new event goes to (`None` / "local" = My events; a synced calendar's id otherwise); fixed when editing
    #[serde(default)]
    pub calendar_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub account_id: Option<String>,
    pub visible: bool,
    /// a calendar of a connected provider (Google / Microsoft)
    pub remote: bool,
    /// new events can be added to it (My events and the writable synced calendars)
    pub writable: bool,
    /// "Google Calendar" / "Outlook": the service that holds a synced calendar
    pub service: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct You {
    pub email: String,
    pub status: String,
    pub on_list: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Responded {
    pub status: String,
    pub sent_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Previous {
    pub start: i64,
    pub end: i64,
    pub location: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub fields: Vec<String>,
    pub previous: Previous,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplyInfo {
    pub from: CalPerson,
    pub status: String,
    pub comment: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub event_id: String,
    pub summary: String,
    pub start: i64,
    pub end: i64,
}

/// What the reading pane shows for a message that carries calendar data.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CalInvite {
    /// REQUEST | CANCEL | REPLY | PUBLISH | COUNTER | OTHER
    pub method: String,
    pub uid: String,
    pub sequence: i64,
    pub summary: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub tzid: Option<String>,
    pub location: Option<String>,
    pub join_url: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<CalPerson>,
    pub attendees: Vec<CalAttendee>,
    pub rrule: Option<String>,
    pub recurrence_text: Option<String>,
    pub you: Option<You>,
    pub responded: Option<Responded>,
    pub changed: Option<Changed>,
    pub reply: Option<ReplyInfo>,
    pub event_id: Option<String>,
    pub ended: bool,
    pub cancelled: bool,
    /// a newer version of this invitation was received
    pub outdated: bool,
    pub conflicts: Vec<Conflict>,
    pub parse_error: Option<String>,
    /// the invitation was over a size cap and some details (repeat rule, guests, excluded dates) were not imported
    pub trimmed: bool,
}

// ------------------------------------------------------------------ rows

pub(crate) const COLS: &str = "id,uid,recurrence_id,calendar_id,account_id,summary,starts_at,ends_at,all_day,tzid,location,join_url,description,\
organizer_name,organizer_email,attendees,rrule,exdates,status,my_status,responded_at,reminder_min,source_message_id,sequence,prev,\
remote_id,etag,series_id,remote_kind,read_only";

pub(crate) fn row_event(r: &Row) -> rusqlite::Result<CalEvent> {
    let org_email: Option<String> = r.get(14)?;
    let attendees: String = r.get(15)?;
    let exdates: String = r.get(17)?;
    let rrule: Option<String> = r.get(16)?;
    let start: i64 = r.get(6)?;
    Ok(CalEvent {
        id: r.get(0)?,
        uid: r.get(1)?,
        recurrence_id: r.get(2)?,
        calendar_id: r.get(3)?,
        account_id: r.get(4)?,
        summary: r.get(5)?,
        start,
        end: r.get(7)?,
        all_day: r.get::<_, i64>(8)? != 0,
        tzid: r.get(9)?,
        location: r.get(10)?,
        join_url: r.get(11)?,
        description: r.get(12)?,
        organizer: org_email.map(|email| CalPerson { email, name: r.get::<_, Option<String>>(13).ok().flatten() }),
        attendees: serde_json::from_str(&attendees).unwrap_or_default(),
        recurrence_text: rrule.as_deref().and_then(|x| ical::describe_rrule(x, start)),
        rrule,
        exdates: serde_json::from_str(&exdates).unwrap_or_default(),
        status: r.get(18)?,
        my_status: r.get(19)?,
        responded_at: r.get(20)?,
        reminder_min: r.get(21)?,
        source_message_id: r.get(22)?,
        sequence: r.get(23)?,
        confidential: false,
        prev: r.get(24)?,
        instance_start: None,
        remote_id: r.get(25)?,
        etag: r.get(26)?,
        series_id: r.get(27)?,
        remote_kind: r.get(28)?,
        read_only: crate::calsync::store::read_only_reason(r.get::<_, i64>(29)?),
    })
}

pub(crate) fn save_row(c: &Connection, e: &CalEvent) -> R<()> {
    c.execute(
        &format!(
            "INSERT OR REPLACE INTO events({COLS},created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,
               ?26,?27,?28,?29,?30,COALESCE((SELECT created_at FROM events WHERE id=?1),?31),?31)"
        ),
        params![
            e.id,
            e.uid,
            e.recurrence_id,
            e.calendar_id,
            e.account_id,
            e.summary,
            e.start,
            e.end,
            e.all_day as i64,
            e.tzid,
            e.location,
            e.join_url,
            e.description,
            e.organizer.as_ref().and_then(|o| o.name.clone()),
            e.organizer.as_ref().map(|o| o.email.clone()),
            serde_json::to_string(&e.attendees).map_err(err)?,
            e.rrule,
            serde_json::to_string(&e.exdates).map_err(err)?,
            e.status,
            e.my_status,
            e.responded_at,
            e.reminder_min,
            e.source_message_id,
            e.sequence,
            e.prev,
            e.remote_id,
            e.etag,
            e.series_id,
            e.remote_kind,
            crate::calsync::store::read_only_code(e.read_only.as_deref()),
            now()
        ],
    )
    .map_err(err)?;
    Ok(())
}

pub(crate) fn find(c: &Connection, calendar: &str, uid: &str, rid: &str) -> Option<CalEvent> {
    c.query_row(
        &format!("SELECT {COLS} FROM events WHERE calendar_id=?1 AND uid=?2 AND recurrence_id=?3"),
        params![calendar, uid, rid],
        row_event,
    )
    .optional()
    .ok()
    .flatten()
}

pub fn get_event(c: &Connection, id: &str) -> R<CalEvent> {
    let mut e = c.query_row(&format!("SELECT {COLS} FROM events WHERE id=?1"), [id], row_event).map_err(|_| "CAL_EVENT_NOT_FOUND: event not found".to_string())?;
    mark_confidential(c, &mut e);
    Ok(e)
}

/// Flag an event that came from a confidential invitation: its summary, description and location are as confidential as the mail.
fn mark_confidential(c: &Connection, e: &mut CalEvent) {
    e.confidential = ensure_event_exportable(c, e).is_err();
}

/// Refuses the events of confidential invitations (for "Save .ics" and the like), with the same error as the mail itself.
fn ensure_event_exportable(c: &Connection, e: &CalEvent) -> R<()> {
    match e.source_message_id.as_deref() {
        Some(mid) => crate::ensure_not_confidential(c, mid),
        None => Ok(()),
    }
}

/// Account id -> its address (lower case), for deciding who "you" are in an event.
fn account_emails(c: &Connection) -> std::collections::HashMap<String, String> {
    db::list_accounts(c).map(|a| a.into_iter().map(|x| (x.id, x.email.to_ascii_lowercase())).collect()).unwrap_or_default()
}

/// Flag the attendee that is you. "You" is the account the event belongs to (the one that organized it, or the one that
/// received the invitation), never another account that happens to be in the same app: with two mailboxes in one app, the
/// invitation in the recipient's mailbox is not "organized by you".
fn mark_you(e: &mut CalEvent, accounts: &std::collections::HashMap<String, String>) {
    let own = e.account_id.as_ref().and_then(|id| accounts.get(id)).cloned().unwrap_or_default();
    for a in e.attendees.iter_mut() {
        a.is_you = !own.is_empty() && a.email.to_ascii_lowercase() == own;
    }
}

fn setting_bool(c: &Connection, key: &str, default: bool) -> bool {
    match db::get_setting(c, key).as_deref() {
        Some("0") | Some("false") => false,
        Some("1") | Some("true") => true,
        _ => default,
    }
}

/// Reminder (minutes before) given to events that arrive by mail; `None` = no reminder.
fn default_reminder(c: &Connection) -> Option<i64> {
    match db::get_setting(c, "event_reminder_min") {
        Some(v) => v.trim().parse::<i64>().ok().filter(|m| *m >= 0),
        None => Some(15),
    }
}

fn hidden_calendars(c: &Connection) -> HashSet<String> {
    db::get_setting(c, "cal_hidden").and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default().into_iter().collect()
}

// ------------------------------------------------------------------ queries

/// Work one `list_range` call may spend expanding repeating events (days / weeks / months walked, summed over all events).
const LIST_EXPAND_BUDGET: usize = 1_000_000;
/// Most event instances one `list_range` call returns.
const LIST_MAX_INSTANCES: usize = 20_000;

/// An invitation that is also an event of a synced calendar of the same mailbox (the provider adds it there by itself) is shown once:
/// the synced copy wins. Matched by UID; occurrences that the provider reports as separate events are matched by title and start.
struct SyncedTwins {
    uids: HashSet<(String, String)>,
    occurrences: HashSet<(String, String, i64)>,
}

impl SyncedTwins {
    fn of(rows: &[CalEvent], hidden: &HashSet<String>) -> SyncedTwins {
        let mut t = SyncedTwins { uids: HashSet::new(), occurrences: HashSet::new() };
        // (a synced calendar the user hid does not count: the event would vanish from the views altogether)
        for e in rows.iter().filter(|e| e.remote_id.is_some() && !hidden.contains(&e.calendar_id) && e.status != "cancelled") {
            let Some(acc) = e.account_id.clone() else { continue };
            if matches!(e.remote_kind.as_deref(), Some("occurrence" | "exception")) {
                t.occurrences.insert((acc.clone(), e.summary.clone(), e.start));
            }
            t.uids.insert((acc, e.uid.clone()));
        }
        t
    }

    fn hides(&self, e: &CalEvent) -> bool {
        e.calendar_id.starts_with("invites:") && e.account_id.clone().is_some_and(|a| self.uids.contains(&(a, e.uid.clone())))
    }

    fn hides_instance(&self, e: &CalEvent) -> bool {
        e.calendar_id.starts_with("invites:") && e.account_id.clone().is_some_and(|a| self.occurrences.contains(&(a, e.summary.clone(), e.start)))
    }
}

/// Events touching `[from, to)` with repeating events expanded, from visible calendars, ordered by start.
/// All-day events are matched with one day of slack on both sides (they are dates, not instants).
pub fn list_range(c: &Connection, from: i64, to: i64) -> R<Vec<CalEvent>> {
    let hidden = hidden_calendars(c);
    let mine = account_emails(c);
    let mut st = c
        .prepare(&format!(
            "SELECT {COLS} FROM events WHERE (rrule IS NULL AND starts_at < ?2 AND ends_at >= ?1) OR (rrule IS NOT NULL AND starts_at < ?2)"
        ))
        .map_err(err)?;
    let rows = st.query_map(params![from - DAY, to + DAY], row_event).map_err(err)?.filter_map(|r| r.ok()).collect::<Vec<_>>();
    let mut out = vec![];
    // One call spends at most this much work on repeating events, however many (or however hostile) they are.
    let mut budget = LIST_EXPAND_BUDGET;
    // timed events must really touch the window; all-day events keep a day of slack (they are dates)
    let touches = |e: &CalEvent| e.all_day || (e.start < to && e.end.max(e.start + 1) > from);
    let synced = SyncedTwins::of(&rows, &hidden);
    for mut e in rows {
        if hidden.contains(&e.calendar_id) || synced.hides(&e) {
            continue;
        }
        mark_you(&mut e, &mine);
        mark_confidential(c, &mut e);
        match e.rrule.clone() {
            Some(rule) => {
                for (s, en) in ical::expand_budgeted(e.start, e.end, e.all_day, e.tzid.as_deref(), &rule, &e.exdates, from - DAY, to + DAY, &mut budget) {
                    if out.len() >= LIST_MAX_INSTANCES {
                        break;
                    }
                    let mut i = e.clone();
                    i.start = s;
                    i.end = en;
                    i.instance_start = Some(s);
                    if touches(&i) && !synced.hides_instance(&i) {
                        out.push(i);
                    }
                }
            }
            None => {
                if touches(&e) {
                    out.push(e)
                }
            }
        }
    }
    out.sort_by_key(|e| (e.start, e.end));
    Ok(out)
}

fn upcoming_conflicts(c: &Connection, ev: &IcsEvent, uid: &str) -> Vec<Conflict> {
    if ev.all_day {
        return vec![];
    }
    list_range(c, ev.start, ev.end.max(ev.start + 1))
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.uid != uid && !e.all_day && e.status != "cancelled" && e.my_status.as_deref() != Some("declined") && e.start < ev.end.max(ev.start + 1) && e.end > ev.start)
        .take(2)
        .map(|e| Conflict { event_id: e.id, summary: e.summary, start: e.start, end: e.end })
        .collect()
}

// ------------------------------------------------------------------ ingest (mail -> events)

pub struct Ingested {
    pub changed: bool,
    pub event_id: Option<String>,
}

fn to_att(a: &Attendee) -> CalAttendee {
    CalAttendee { email: a.email.clone(), name: a.name.clone(), role: a.role.clone(), status: a.status.clone(), is_you: false }
}

fn first_event(cal: &ical::IcsCalendar) -> Option<&IcsEvent> {
    cal.events.iter().find(|e| e.recurrence_id.is_none()).or_else(|| cal.events.first())
}

/// The invitation event as a new row (no response yet).
fn event_from_ics(ev: &IcsEvent, calendar: &str, account: Option<&Account>, message_id: &str, method: &str, reminder: Option<i64>) -> CalEvent {
    let mine = account.map(|a| a.email.to_ascii_lowercase());
    let my_status = if method == "PUBLISH" {
        None
    } else if ev.organizer.as_ref().map(|o| Some(&o.email) == mine.as_ref()).unwrap_or(false) {
        Some("organizer".to_string())
    } else {
        Some(ev.attendees.iter().find(|a| Some(&a.email) == mine.as_ref()).map(|a| a.status.clone()).unwrap_or_else(|| "needs-action".into()))
    };
    let responded = my_status.as_deref().map(|s| matches!(s, "accepted" | "tentative" | "declined")).unwrap_or(false);
    CalEvent {
        id: uuid::Uuid::new_v4().to_string(),
        uid: ev.uid.clone(),
        calendar_id: calendar.to_string(),
        account_id: account.map(|a| a.id.clone()),
        summary: if ev.summary.is_empty() { "(No title)".into() } else { ev.summary.clone() },
        start: ev.start,
        end: ev.end,
        all_day: ev.all_day,
        tzid: ev.tzid.clone(),
        location: ev.location.clone(),
        join_url: ical::join_url(ev),
        description: ev.description.clone(),
        organizer: ev.organizer.as_ref().map(|o| CalPerson { email: o.email.clone(), name: o.name.clone() }),
        attendees: ev.attendees.iter().map(to_att).collect(),
        rrule: ev.rrule.clone(),
        recurrence_text: ev.rrule.as_deref().and_then(|r| ical::describe_rrule(r, ev.start)),
        status: ev.status.clone(),
        my_status,
        responded_at: if responded { Some(now()) } else { None },
        reminder_min: reminder,
        source_message_id: Some(message_id.to_string()),
        sequence: ev.sequence,
        confidential: false,
        instance_start: None,
        read_only: None,
        remote_id: None,
        etag: None,
        series_id: None,
        remote_kind: None,
        recurrence_id: ev.recurrence_id.map(|r| r.to_string()).unwrap_or_default(),
        exdates: ev.exdates.clone(),
        prev: None,
    }
}

/// An address as compared between a message sender and an organizer or attendee: trimmed, lower case, no `mailto:`.
fn sender_key(addr: &str) -> String {
    let a = addr.trim();
    let a = match a.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("mailto:") => a.get(7..).unwrap_or(""),
        _ => a,
    };
    a.trim().to_ascii_lowercase()
}

/// True when `uid` is an event this very account organized (a "My events" row filed under it) and the message was sent by
/// this account: the copy of its own invitation, not a new invitation.
fn own_copy(c: &Connection, acc: &Account, sender: &str, uid: &str, rid: &str) -> bool {
    !sender.is_empty()
        && sender == acc.email.trim().to_ascii_lowercase()
        && find(c, LOCAL, uid, rid).map(|e| e.account_id.as_deref() == Some(acc.id.as_str())).unwrap_or(false)
}

fn add_exdate(c: &Connection, calendar: &str, uid: &str, at: i64) -> bool {
    let Some(mut parent) = find(c, calendar, uid, "") else { return false };
    if parent.exdates.contains(&at) {
        return false;
    }
    parent.exdates.push(at);
    save_row(c, &parent).is_ok()
}

/// Apply the calendar data of a received message. REQUEST / PUBLISH add or update an event (an update with a higher
/// SEQUENCE resets your answer), CANCEL marks it cancelled, REPLY updates attendee answers on events you organized.
/// `force` adds the event even when "add invitations automatically" is off (the Add to calendar button).
///
/// Changes to an event that is already stored are applied only when the message comes from the right person:
/// updates and cancellations from the stored organizer, an answer (REPLY) from the attendee it speaks for.
/// `from_email` is the sender of the message.
pub fn ingest(c: &Connection, acc: &Account, message_id: &str, from_email: &str, text: &str, force: bool) -> R<Ingested> {
    let cal = ical::parse(text)?;
    let method = cal.method.clone().unwrap_or_else(|| "PUBLISH".into());
    let calendar = format!("invites:{}", acc.id);
    let auto = setting_bool(c, "auto_add_invites", true);
    let mut out = Ingested { changed: false, event_id: None };
    let sender = sender_key(from_email);
    // Known limit (F28): the only evidence of who sent the message is its From header (no DKIM / SPF / S/MIME check, and
    // SENT-BY is not honoured). A forged From equal to the organizer, plus the event UID and a higher SEQUENCE, can still
    // change or cancel the event. Mail servers normally reject such spoofing; see README, Known limitations.
    // true when the sender is the organizer recorded for the stored event (no stored organizer: nobody may change it)
    let from_organizer = |ex: &CalEvent| ex.organizer.as_ref().map(|o| !sender.is_empty() && sender_key(&o.email) == sender).unwrap_or(false);
    for ev in &cal.events {
        let rid = ev.recurrence_id.map(|r| r.to_string()).unwrap_or_default();
        match method.as_str() {
            "REQUEST" | "PUBLISH" => {
                // a copy of an invitation this account sent itself (Cc to yourself, a shared mailbox) is not a second event.
                // Only when the same account organized it (events are per account) and the message really comes from that
                // account: the same invitation delivered to another account of this app is that account's own event.
                if own_copy(c, acc, &sender, &ev.uid, &rid) {
                    continue;
                }
                let existing = find(c, &calendar, &ev.uid, &rid);
                match existing {
                    Some(mut ex) => {
                        out.event_id = Some(ex.id.clone());
                        if ev.sequence <= ex.sequence || !from_organizer(&ex) {
                            continue;
                        }
                        // a newer version: remember what changed and reset the answer
                        ex.prev = Some(serde_json::json!({ "start": ex.start, "end": ex.end, "location": ex.location, "sequence": ex.sequence, "summary": ex.summary }).to_string());
                        let fresh = event_from_ics(ev, &calendar, Some(acc), message_id, &method, ex.reminder_min);
                        let keep_status = ex.my_status.as_deref() == Some("organizer");
                        ex.summary = fresh.summary;
                        ex.start = fresh.start;
                        ex.end = fresh.end;
                        ex.all_day = fresh.all_day;
                        ex.tzid = fresh.tzid;
                        ex.location = fresh.location;
                        ex.join_url = fresh.join_url;
                        ex.description = fresh.description;
                        ex.organizer = fresh.organizer;
                        ex.attendees = fresh.attendees;
                        ex.rrule = fresh.rrule;
                        ex.exdates = fresh.exdates;
                        ex.status = fresh.status;
                        ex.sequence = ev.sequence;
                        ex.source_message_id = Some(message_id.to_string());
                        if !keep_status {
                            ex.my_status = if method == "PUBLISH" { None } else { Some("needs-action".into()) };
                            ex.responded_at = None;
                        }
                        save_row(c, &ex)?;
                        out.changed = true;
                    }
                    None => {
                        if !(auto || force) {
                            continue;
                        }
                        let e = event_from_ics(ev, &calendar, Some(acc), message_id, &method, default_reminder(c));
                        save_row(c, &e)?;
                        if let Some(at) = ev.recurrence_id {
                            // the moved occurrence leaves the series, if the organizer of the series sent it
                            if find(c, &calendar, &ev.uid, "").map(|parent| from_organizer(&parent)).unwrap_or(false) {
                                add_exdate(c, &calendar, &ev.uid, at);
                            }
                        }
                        out.event_id = Some(e.id);
                        out.changed = true;
                    }
                }
            }
            "CANCEL" => {
                if let Some(mut ex) = find(c, &calendar, &ev.uid, &rid) {
                    if ev.sequence >= ex.sequence && ex.status != "cancelled" && from_organizer(&ex) {
                        ex.status = "cancelled".into();
                        ex.sequence = ev.sequence.max(ex.sequence);
                        save_row(c, &ex)?;
                        out.event_id = Some(ex.id);
                        out.changed = true;
                    }
                } else if let Some(at) = ev.recurrence_id {
                    // one occurrence of a series was cancelled
                    let allowed = find(c, &calendar, &ev.uid, "").map(|parent| from_organizer(&parent)).unwrap_or(false);
                    if allowed && add_exdate(c, &calendar, &ev.uid, at) {
                        out.changed = true;
                    }
                }
            }
            "REPLY" => {
                // an answer to an event you organized (it lives in "My events", filed under the account that received the answer)
                let target = find(c, LOCAL, &ev.uid, "").filter(|e| e.account_id.as_deref() == Some(acc.id.as_str()) || e.account_id.is_none());
                if let Some(mut ex) = target {
                    for a in &ev.attendees {
                        // an answer counts only when it comes from the person it speaks for
                        if sender.is_empty() || sender_key(&a.email) != sender {
                            continue;
                        }
                        match ex.attendees.iter_mut().find(|x| x.email == a.email) {
                            Some(x) => {
                                if x.status != a.status {
                                    x.status = a.status.clone();
                                    out.changed = true;
                                }
                            }
                            // F27: an answer only updates a row that already exists; a stranger who knows the UID cannot add themselves
                            None => {}
                        }
                    }
                    if out.changed {
                        save_row(c, &ex)?;
                    }
                    out.event_id = Some(ex.id);
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ the invite card

fn status_of(my: &str) -> Option<&'static str> {
    match my {
        "accepted" => Some("accepted"),
        "tentative" => Some("tentative"),
        "declined" => Some("declined"),
        _ => None,
    }
}

/// Build what the reading pane shows. For a decrypted message the calendar data is also ingested here (it was
/// not readable at sync time).
pub fn invite_for(c: &Connection, account_id: &str, message_id: &str, folder: &str, from_email: &str, text: &str, decrypted: bool) -> CalInvite {
    let mut inv = CalInvite { method: "OTHER".into(), ..Default::default() };
    let cal = match ical::parse(text) {
        Ok(c) => c,
        Err(e) => {
            inv.parse_error = Some(e);
            return inv;
        }
    };
    let acc = db::get_account(c, account_id).ok();
    if decrypted && !matches!(folder, "sent" | "drafts" | "trash" | "junk") {
        if let Some(a) = &acc {
            if ingest(c, a, message_id, from_email, text, false).map(|o| o.changed).unwrap_or(false) {
                mark_dirty();
            }
        }
    }
    let Some(ev) = first_event(&cal) else {
        inv.parse_error = Some("no event".into());
        return inv;
    };
    let method = cal.method.clone().unwrap_or_else(|| "PUBLISH".into());
    inv.method = match method.as_str() {
        "REQUEST" | "CANCEL" | "REPLY" | "PUBLISH" | "COUNTER" => method.clone(),
        _ => "OTHER".into(),
    };
    inv.uid = ev.uid.clone();
    inv.sequence = ev.sequence;
    inv.summary = if ev.summary.is_empty() { "(No title)".into() } else { ev.summary.clone() };
    inv.start = ev.start;
    inv.end = ev.end;
    inv.all_day = ev.all_day;
    inv.tzid = ev.tzid.clone();
    inv.location = ev.location.clone();
    inv.join_url = ical::join_url(ev);
    inv.description = ev.description.clone();
    inv.organizer = ev.organizer.as_ref().map(|o| CalPerson { email: o.email.clone(), name: o.name.clone() });
    inv.rrule = ev.rrule.clone();
    inv.recurrence_text = ev.rrule.as_deref().and_then(|r| ical::describe_rrule(r, ev.start));
    inv.trimmed = ev.trimmed;
    inv.cancelled = ev.status == "cancelled" || method == "CANCEL";
    inv.ended = ev.rrule.is_none() && ev.end.max(ev.start) < now();
    // "you" = the account that received this message, not every account in the app
    let own = acc.as_ref().map(|a| a.email.trim().to_ascii_lowercase()).unwrap_or_default();
    let is_own = |email: &str| !own.is_empty() && email.trim().to_ascii_lowercase() == own;
    inv.attendees = ev.attendees.iter().map(to_att).collect();
    for a in inv.attendees.iter_mut() {
        a.is_you = is_own(&a.email);
    }
    let me = inv.attendees.iter().find(|a| a.is_you).cloned();
    // the "My events" row of an event this account organized
    let own_event = |uid: &str| find(c, LOCAL, uid, "").filter(|e| e.account_id.as_deref() == Some(account_id));
    let row = find(c, &format!("invites:{account_id}"), &ev.uid, &ev.recurrence_id.map(|r| r.to_string()).unwrap_or_default());

    match method.as_str() {
        "REPLY" => {
            if let Some(a) = ev.attendees.first() {
                inv.reply = Some(ReplyInfo {
                    from: CalPerson { email: a.email.clone(), name: a.name.clone() },
                    status: a.status.clone(),
                    comment: ev.comment.clone(),
                });
            } else {
                inv.reply = Some(ReplyInfo { from: CalPerson { email: from_email.to_string(), name: None }, status: "needs-action".into(), comment: ev.comment.clone() });
            }
            // the local event, with the current answers of everyone
            if let Some(local) = own_event(&ev.uid) {
                inv.event_id = Some(local.id.clone());
                inv.attendees = local.attendees.clone();
                for a in inv.attendees.iter_mut() {
                    a.is_you = is_own(&a.email);
                }
            }
        }
        _ => {
            let organizer_is_me = ev.organizer.as_ref().map(|o| is_own(&o.email)).unwrap_or(false);
            let on_list = me.is_some() || organizer_is_me;
            let status = row.as_ref().and_then(|r| r.my_status.clone()).or_else(|| me.as_ref().map(|m| m.status.clone())).unwrap_or_else(|| "needs-action".into());
            inv.you = Some(You { email: own.clone(), status: if organizer_is_me { "organizer".into() } else { status.clone() }, on_list });
            if organizer_is_me {
                // your own invitation: its event is the one in "My events"
                if let Some(local) = own_event(&ev.uid) {
                    inv.event_id = Some(local.id.clone());
                    inv.attendees = local.attendees.clone();
                    for a in inv.attendees.iter_mut() {
                        a.is_you = is_own(&a.email);
                    }
                }
            }
            if let Some(r) = &row {
                inv.event_id = Some(r.id.clone());
                // your own attendee row shows the stored answer, not the "needs-action" the invitation text was sent with
                for a in inv.attendees.iter_mut().filter(|a| a.is_you) {
                    let stored = r.attendees.iter().find(|x| x.email.trim().eq_ignore_ascii_case(a.email.trim())).map(|x| x.status.clone());
                    if let Some(s) = stored.filter(|s| s != "needs-action").or_else(|| r.my_status.as_deref().and_then(status_of).map(String::from)) {
                        a.status = s;
                    }
                }
                if let Some(s) = r.my_status.as_deref().and_then(status_of) {
                    inv.responded = Some(Responded { status: s.into(), sent_at: r.responded_at });
                }
                inv.outdated = r.sequence > ev.sequence;
                if r.status == "cancelled" {
                    inv.cancelled = true;
                }
                // every copy of this version of the invitation (Inbox and All Mail hold the same message) shows the change: the
                // event is the same (account + UID, the row above) and so is the SEQUENCE; older copies are "outdated"
                if r.sequence == ev.sequence {
                    if let Some(p) = r.prev.as_deref().and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok()) {
                        let (ps, pe) = (p["start"].as_i64().unwrap_or(r.start), p["end"].as_i64().unwrap_or(r.end));
                        let pl = p["location"].as_str().map(|s| s.to_string());
                        let mut fields = vec![];
                        if ps != r.start || pe != r.end {
                            fields.push("time".to_string());
                        }
                        if pl != r.location {
                            fields.push("location".to_string());
                        }
                        if fields.is_empty() {
                            fields.push("details".to_string());
                        }
                        inv.changed = Some(Changed { fields, previous: Previous { start: ps, end: pe, location: pl } });
                    }
                }
            }
            if method == "REQUEST" && !inv.cancelled && !inv.ended {
                inv.conflicts = upcoming_conflicts(c, ev, &ev.uid);
            }
        }
    }
    inv
}

/// The iCalendar text of a message (decrypting PGP mail when needed), with its account, folder and sender.
fn message_ics(db: &Db, message_id: &str) -> R<(String, String, String, String)> {
    let (account, folder, from, ics, pgp): (String, String, String, Option<String>, i64) = lock(db)
        .query_row("SELECT account_id,folder,from_email,ics,pgp FROM messages WHERE id=?1", [message_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|_| "MSG_NOT_FOUND: message not found".to_string())?;
    if let Some(t) = ics {
        return Ok((account, folder, from, t));
    }
    if pgp & crate::pgpmail::FLAG_ENCRYPTED as i64 != 0 {
        let (raw, _) = crate::fetch_view_for(db, message_id)?;
        if let Some(t) = crate::mail::parse(0, &raw, true, false, 0).and_then(|p| p.ics) {
            return Ok((account, folder, from, t));
        }
    }
    Err("CAL_NO_DATA: this message has no calendar data".into())
}

// ------------------------------------------------------------------ writing and sending

fn fmt_when(ev: &IcsEvent) -> String {
    use chrono::{Local, TimeZone};
    let (Some(s), Some(e)) = (Local.timestamp_opt(ev.start, 0).single(), Local.timestamp_opt(ev.end, 0).single()) else { return String::new() };
    if ev.all_day {
        return s.format("%a, %-d %b %Y (all day)").to_string();
    }
    let tz = ev.tzid.as_deref().map(|t| format!(" ({t})")).unwrap_or_default();
    format!("{} {}–{}{}", s.format("%a, %-d %b %Y"), s.format("%H:%M"), e.format("%H:%M"), tz)
}

fn to_ics_event(e: &CalEvent) -> IcsEvent {
    IcsEvent {
        uid: e.uid.clone(),
        sequence: e.sequence,
        summary: e.summary.clone(),
        description: e.description.clone(),
        location: e.location.clone(),
        url: None,
        conference: None,
        start: e.start,
        end: e.end,
        all_day: e.all_day,
        tzid: e.tzid.clone(),
        organizer: e.organizer.as_ref().map(|o| Person { email: o.email.clone(), name: o.name.clone() }),
        attendees: e
            .attendees
            .iter()
            .map(|a| Attendee { email: a.email.clone(), name: a.name.clone(), role: a.role.clone(), status: a.status.clone(), rsvp: a.role != "chair" })
            .collect(),
        rrule: e.rrule.clone(),
        exdates: e.exdates.clone(),
        recurrence_id: e.recurrence_id.parse().ok(),
        status: e.status.clone(),
        comment: None,
        dtstamp: now(),
        trimmed: false,
    }
}

fn send_message(db: &Db, acc: &Account, msg: lettre::Message) -> R<()> {
    let secret = crate::smtp_secret(db, acc)?;
    crate::smtp::send_raw(acc, &secret, msg.envelope(), &crate::smtp::wire(&msg))
}

fn iso_part(method: &str, ev: &IcsEvent) -> crate::smtp::CalendarPart {
    crate::smtp::CalendarPart { method: method.into(), ics: ical::to_ics(Some(method), std::slice::from_ref(ev)) }
}

fn display_name(a: &Account) -> String {
    if a.display_name.trim().is_empty() { a.email.clone() } else { a.display_name.clone() }
}

fn body_text(who: &str, verb: &str, ev: &IcsEvent) -> String {
    let mut t = format!("{who} {verb}: {}\n\nWhen: {}\n", ev.summary, fmt_when(ev));
    if let Some(l) = &ev.location {
        t.push_str(&format!("Where: {l}\n"));
    }
    if let Some(d) = &ev.description {
        t.push_str(&format!("\n{d}\n"));
    }
    t
}

fn mailto_list(addrs: &[CalAttendee], skip: &str) -> Vec<String> {
    addrs
        .iter()
        .filter(|a| a.email != skip.to_ascii_lowercase())
        .map(|a| crate::smtp::format_mailbox(a.name.as_deref(), &a.email))
        .collect()
}

/// Send the REQUEST (invitation / update) or CANCEL of an event you organize.
fn send_organizer_mail(db: &Db, acc: &Account, e: &CalEvent, method: &str) -> R<()> {
    let ev = to_ics_event(e);
    let to = mailto_list(&e.attendees, &acc.email);
    if to.is_empty() {
        return Ok(());
    }
    let (subject, verb) = match method {
        "CANCEL" => (format!("Canceled: {}", e.summary), "has canceled"),
        _ if e.sequence > 0 => (format!("Updated invitation: {}", e.summary), "has updated the invitation"),
        _ => (format!("Invitation: {}", e.summary), "invites you to"),
    };
    let text = body_text(&display_name(acc), verb, &ev);
    let msg = crate::smtp::build_calendar_mail(acc, &to, &[], &subject, &text, &iso_part(method, &ev))?;
    send_message(db, acc, msg)
}

/// Create or change a local event. Returns the saved event and the account to notify (when the event has attendees).
pub fn save_local(c: &Connection, inp: &CalEventInput) -> R<(CalEvent, Option<Account>)> {
    if inp.end < inp.start {
        return Err("CAL_BAD_TIME: End must be after start.".into());
    }
    let existing = match &inp.id {
        Some(id) => Some(get_event(c, id)?),
        None => None,
    };
    if let Some(ex) = &existing {
        if ex.calendar_id != LOCAL {
            return Err("CAL_NOT_YOURS: This invitation was sent by someone else, so it can't be edited here.".into());
        }
    }
    let attendees_in: Vec<&CalAttendee> = inp.attendees.iter().filter(|a| a.role != "chair").collect();
    let acc = match inp.account_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(db::get_account(c, id)?),
        None => None,
    };
    if !attendees_in.is_empty() && acc.is_none() {
        return Err("CAL_NO_ACCOUNT: Choose the account to send the invitation from.".into());
    }
    let same_time = existing.as_ref().map(|x| x.start == inp.start && x.end == inp.end && x.rrule == inp.rrule).unwrap_or(false);
    let mut attendees: Vec<CalAttendee> = vec![];
    if let (Some(a), false) = (&acc, attendees_in.is_empty()) {
        attendees.push(CalAttendee { email: a.email.to_ascii_lowercase(), name: Some(display_name(a)), role: "chair".into(), status: "accepted".into(), is_you: true });
        for x in attendees_in {
            let email = x.email.trim().to_ascii_lowercase();
            if email.is_empty() || attendees.iter().any(|y| y.email == email) {
                continue;
            }
            // answers are kept while the time stays the same
            let status = existing
                .as_ref()
                .filter(|_| same_time)
                .and_then(|ex| ex.attendees.iter().find(|y| y.email == email).map(|y| y.status.clone()))
                .unwrap_or_else(|| "needs-action".into());
            attendees.push(CalAttendee { email, name: x.name.clone().filter(|n| !n.trim().is_empty()), role: if x.role == "optional" { "optional".into() } else { "required".into() }, status, is_you: false });
        }
    }
    let has_att = attendees.len() > 1;
    let sequence = existing.as_ref().map(|x| x.sequence + if has_att { 1 } else { 0 }).unwrap_or(0);
    let uid = existing.as_ref().map(|x| x.uid.clone()).unwrap_or_else(|| format!("{}@heylook", uuid::Uuid::new_v4()));
    let tzid = inp.tzid.clone().filter(|t| ical::iana_for(t).is_some());
    let mut e = CalEvent {
        id: existing.as_ref().map(|x| x.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        uid,
        calendar_id: LOCAL.into(),
        account_id: acc.as_ref().map(|a| a.id.clone()),
        summary: if inp.summary.trim().is_empty() { "(No title)".into() } else { inp.summary.trim().to_string() },
        start: inp.start,
        end: inp.end,
        all_day: inp.all_day,
        tzid,
        location: inp.location.clone().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        join_url: None,
        description: inp.description.clone().filter(|s| !s.trim().is_empty()),
        organizer: if has_att { acc.as_ref().map(|a| CalPerson { email: a.email.to_ascii_lowercase(), name: Some(display_name(a)) }) } else { None },
        attendees: if has_att { attendees } else { vec![] },
        rrule: inp.rrule.clone().filter(|s| !s.trim().is_empty()),
        recurrence_text: None,
        status: "confirmed".into(),
        my_status: if has_att { Some("organizer".into()) } else { None },
        responded_at: None,
        reminder_min: inp.reminder_min,
        source_message_id: None,
        sequence,
        confidential: false,
        instance_start: None,
        read_only: None,
        remote_id: None,
        etag: None,
        series_id: None,
        remote_kind: None,
        recurrence_id: String::new(),
        exdates: existing.as_ref().map(|x| x.exdates.clone()).unwrap_or_default(),
        prev: None,
    };
    e.join_url = ical::join_url(&to_ics_event(&e));
    e.recurrence_text = e.rrule.as_deref().and_then(|r| ical::describe_rrule(r, e.start));
    save_row(c, &e)?;
    Ok((e, if has_att { acc } else { None }))
}

/// Turn the meeting of a Compose draft into a local event and the calendar part of the message.
pub fn prepare_meeting(c: &Connection, d: &mut crate::smtp::Draft) -> R<()> {
    let Some(m) = d.meeting.clone() else { return Ok(()) };
    if d.calendar.is_some() {
        return Ok(()); // already prepared (a scheduled message that is sent later)
    }
    let attendees: Vec<CalAttendee> = d
        .to
        .iter()
        .map(|a| (a, "required"))
        .chain(d.cc.iter().map(|a| (a, "optional")))
        .filter_map(|(a, role)| {
            let (name, email) = crate::smtp::split_mailbox(a);
            let email = email.to_ascii_lowercase();
            (!email.is_empty()).then(|| CalAttendee { email, name, role: role.into(), status: "needs-action".into(), is_you: false })
        })
        .collect();
    let description = if d.text.trim().is_empty() { None } else { Some(d.text.trim().to_string()) };
    let (e, _) = save_local(
        c,
        &CalEventInput {
            id: None,
            account_id: Some(d.account_id.clone()),
            summary: d.subject.clone(),
            start: m.start,
            end: m.end,
            all_day: m.all_day,
            tzid: m.tzid.clone(),
            location: m.location.clone(),
            description,
            attendees,
            rrule: m.rrule.clone(),
            reminder_min: default_reminder(c),
            calendar_id: None,
        },
    )?;
    d.calendar = Some(iso_part("REQUEST", &to_ics_event(&e)));
    mark_dirty();
    Ok(())
}

/// A scheduled meeting was cancelled, edited or moved to Drafts: remove the local event made for it when it was scheduled.
pub fn forget_prepared(c: &Connection, payload: &str) {
    let Ok(d) = serde_json::from_str::<crate::smtp::Draft>(payload) else { return };
    let Some(cal) = d.calendar else { return };
    let uid = cal
        .ics
        .lines()
        .find_map(|l| l.trim().strip_prefix("UID:").map(|u| u.trim().to_string()))
        .filter(|u| !u.is_empty());
    if let Some(uid) = uid {
        let _ = c.execute("DELETE FROM events WHERE calendar_id=?1 AND uid=?2", params![LOCAL, uid]);
        mark_dirty();
    }
}

/// True when this very answer (with no new comment) was already sent for the event row.
fn already_answered(row: &CalEvent, partstat: &str, comment: Option<&str>) -> bool {
    row.my_status.as_deref() == Some(partstat) && row.responded_at.is_some() && comment.map(|c| c.trim().is_empty()).unwrap_or(true)
}

pub fn respond(db: &Db, message_id: &str, response: &str, comment: Option<String>, send: bool) -> R<CalInvite> {
    let partstat = match response {
        "accepted" | "tentative" | "declined" => response,
        _ => return Err("CAL_BAD_RESPONSE: unknown response".into()),
    };
    let (account_id, folder, from_email, text) = message_ics(db, message_id)?;
    let cal = ical::parse(&text)?;
    let ev = first_event(&cal).ok_or("CAL_NO_EVENT: this invitation has no event")?.clone();
    let method = cal.method.clone().unwrap_or_else(|| "PUBLISH".into());
    if method != "REQUEST" && method != "PUBLISH" {
        return Err("CAL_NOT_AN_INVITATION: This message is not an invitation you can respond to.".into());
    }
    // the answer is stored for, and sent from, the account that received the invitation (with several accounts in one app,
    // another account named in the attendee list got its own copy of the message and answers that one)
    let mut skip_send = false;
    let acc = {
        let c = lock(db);
        let acc = db::get_account(&c, &account_id)?;
        // make sure the event exists, then record the answer locally first (it survives a failed send)
        ingest(&c, &acc, message_id, &from_email, &text, true)?;
        let calendar = format!("invites:{}", acc.id);
        let rid = ev.recurrence_id.map(|r| r.to_string()).unwrap_or_default();
        if let Some(mut row) = find(&c, &calendar, &ev.uid, &rid) {
            let already = already_answered(&row, partstat, comment.as_deref());
            row.my_status = Some(partstat.to_string());
            if !already {
                row.responded_at = None;
            }
            // your own attendee row shows the answer too
            let me = acc.email.trim().to_ascii_lowercase();
            for a in row.attendees.iter_mut().filter(|a| a.email.trim().to_ascii_lowercase() == me) {
                a.status = partstat.to_string();
            }
            save_row(&c, &row)?;
            skip_send = already;
        }
        acc
    };
    let who_acc = acc.clone();
    mark_dirty();
    // the same message sits in several folders (Inbox, All Mail): answering the same way from another copy does not mail the
    // organizer a second time
    if send && !skip_send {
        let to = ev.organizer.as_ref().map(|o| o.email.clone()).unwrap_or(from_email.clone());
        let me = Person { email: who_acc.email.to_ascii_lowercase(), name: Some(display_name(&who_acc)) };
        let reply = ical::reply_event(&ev, &me, partstat, comment.as_deref(), now());
        let (verb, prefix) = match partstat {
            "accepted" => ("has accepted", "Accepted"),
            "declined" => ("has declined", "Declined"),
            _ => ("has tentatively accepted", "Tentative"),
        };
        let mut text_body = body_text(&display_name(&who_acc), verb, &ev);
        if let Some(c) = comment.as_deref().filter(|c| !c.trim().is_empty()) {
            text_body.push_str(&format!("\n{}\n", c.trim()));
        }
        let msg = crate::smtp::build_calendar_mail(&who_acc, &[to], &[], &format!("{prefix}: {}", ev.summary), &text_body, &iso_part("REPLY", &reply))?;
        // SMTP failures keep the local answer; the card offers Retry
        send_message(db, &who_acc, msg).map_err(|e| format!("CAL_SEND_FAILED: {e}"))?;
        let c = lock(db);
        let calendar = format!("invites:{}", acc.id);
        let rid = ev.recurrence_id.map(|r| r.to_string()).unwrap_or_default();
        if let Some(mut row) = find(&c, &calendar, &ev.uid, &rid) {
            row.responded_at = Some(now());
            save_row(&c, &row)?;
        }
    }
    // the same event in a synced calendar of this mailbox gets the answer too (silently: the organizer was told by the reply above)
    crate::calsync::write::mirror_rsvp(
        db,
        &crate::calsync::cmds::AppFactory { db: db.clone() },
        &account_id,
        &ev.uid,
        &ev.recurrence_id.map(|r| r.to_string()).unwrap_or_default(),
        partstat,
    );
    let c = lock(db);
    Ok(invite_for(&c, &account_id, message_id, &folder, &from_email, &text, false))
}

fn reminder_worker_pass(app: &tauri::AppHandle, db: &Db, fired: &mut HashSet<(String, i64)>) {
    let t = now();
    let due: Vec<CalEvent> = {
        let c = lock(db);
        list_range(&c, t - 120, t + DAY + 60).unwrap_or_default()
    };
    for e in due {
        let Some(m) = e.reminder_min else { continue };
        if e.all_day || e.status == "cancelled" || e.my_status.as_deref() == Some("declined") {
            continue;
        }
        if e.start - m * 60 > t || e.start < t - 60 || !fired.insert((e.id.clone(), e.start)) {
            continue;
        }
        let when = {
            use chrono::{Local, TimeZone};
            Local.timestamp_opt(e.start, 0).single().map(|d| d.format("%H:%M").to_string()).unwrap_or_default()
        };
        let line2 = match &e.location {
            Some(l) => format!("{when} · {l}"),
            None => when,
        };
        let mins = ((e.start - t) / 60).max(0);
        let title = crate::i18n::event_reminder(&e.summary, mins);
        let _ = app.emit("event-reminder", serde_json::json!({ "eventId": e.id, "title": title, "line": line2, "joinUrl": e.join_url, "start": e.start }));
        crate::shell::notify_reminder(app, db, &title, &line2);
    }
    if fired.len() > 2000 {
        fired.clear();
    }
}

/// Every 30 s: fire reminders that are due (an OS notification and an `event-reminder` event for the window).
pub fn reminder_worker(app: tauri::AppHandle, db: Db) {
    let mut fired: HashSet<(String, i64)> = HashSet::new();
    loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        reminder_worker_pass(&app, &db, &mut fired);
    }
}

// ------------------------------------------------------------------ commands

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("calendar-changed", serde_json::json!({}));
}

#[tauri::command]
pub fn calendar_list_calendars(state: tauri::State<crate::AppState>) -> R<Vec<CalendarInfo>> {
    list_calendars(&lock(&state.db))
}

/// My events, each mailbox's invitations, then the synced calendars of the mailboxes that sync.
pub fn list_calendars(c: &Connection) -> R<Vec<CalendarInfo>> {
    let hidden = hidden_calendars(c);
    let mut out = vec![CalendarInfo { id: LOCAL.into(), name: "My events".into(), color: "#8764b8".into(), account_id: None, visible: !hidden.contains(LOCAL), remote: false, writable: true, service: None }];
    let accounts = db::list_accounts(c)?;
    for a in &accounts {
        let id = format!("invites:{}", a.id);
        out.push(CalendarInfo { visible: !hidden.contains(&id), id, name: format!("Invitations · {}", a.email), color: a.color.clone().unwrap_or_default(), account_id: Some(a.id.clone()), remote: false, writable: false, service: None });
    }
    // the calendars of the mailboxes that sync, in account order, with the provider's colours
    for a in &accounts {
        let Some(src) = crate::calsync::store::source_of_account(c, &a.id) else { continue };
        for cal in crate::calsync::store::calendars_of(c, &src.id)?.into_iter().filter(|x| x.sync_on) {
            let color = if cal.color.is_empty() { a.color.clone().unwrap_or_default() } else { cal.color.clone() };
            out.push(CalendarInfo {
                visible: !hidden.contains(&cal.id),
                name: format!("{} · {}", cal.name, a.email),
                id: cal.id,
                color,
                account_id: Some(a.id.clone()),
                remote: true,
                writable: !cal.read_only,
                service: Some(src.kind.service().to_string()),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn calendar_set_visible(app: tauri::AppHandle, state: tauri::State<crate::AppState>, calendar_id: String, visible: bool) -> R<()> {
    let c = lock(&state.db);
    let mut hidden = hidden_calendars(&c);
    if visible {
        hidden.remove(&calendar_id);
    } else {
        hidden.insert(calendar_id);
    }
    let mut v: Vec<String> = hidden.into_iter().collect();
    v.sort();
    db::set_setting(&c, "cal_hidden", &serde_json::to_string(&v).map_err(err)?)?;
    drop(c);
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn calendar_list_events(state: tauri::State<crate::AppState>, from: i64, to: i64) -> R<Vec<CalEvent>> {
    list_range(&lock(&state.db), from, to)
}

#[tauri::command]
pub fn calendar_get_event(state: tauri::State<crate::AppState>, id: String) -> R<CalEvent> {
    let c = lock(&state.db);
    let mut e = get_event(&c, &id)?;
    let mine = account_emails(&c);
    mark_you(&mut e, &mine);
    Ok(e)
}

/// The synced calendar an event input is for: the calendar of the event being edited, or the one chosen for a new event.
fn remote_calendar_of(c: &Connection, inp: &CalEventInput) -> Option<String> {
    let id = match &inp.id {
        Some(id) => get_event(c, id).ok()?.calendar_id,
        None => inp.calendar_id.clone()?,
    };
    crate::calsync::is_remote_calendar_id(&id).then_some(id)
}

#[tauri::command]
pub async fn calendar_save_event(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, event: CalEventInput, notify: bool) -> R<CalEvent> {
    let db = state.db.clone();
    let out = crate::blocking(move || {
        // an event of a synced calendar goes to its provider (which sends the invitations, not this app)
        if remote_calendar_of(&lock(&db), &event).is_some() {
            return crate::calsync::write::save(&db, &crate::calsync::cmds::AppFactory { db: db.clone() }, &event);
        }
        let (e, acc) = save_local(&lock(&db), &event)?;
        if let (true, Some(acc)) = (notify, acc) {
            send_organizer_mail(&db, &acc, &e, "REQUEST").map_err(|m| crate::i18n::coded("CAL_SEND_FAILED", &[("v", "saved"), ("detail", &m)], &format!("The event was saved, but the invitations weren't sent: {m}")))?;
        }
        Ok(e)
    })
    .await;
    changed(&app);
    out
}

#[tauri::command]
pub async fn calendar_delete_event(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, id: String, notify: bool) -> R<()> {
    let db = state.db.clone();
    let out = crate::blocking(move || {
        let (e, acc) = {
            let c = lock(&db);
            let e = get_event(&c, &id)?;
            let acc = e.account_id.as_deref().and_then(|a| db::get_account(&c, a).ok());
            (e, acc)
        };
        if crate::calsync::is_remote_calendar_id(&e.calendar_id) {
            return crate::calsync::write::delete(&db, &crate::calsync::cmds::AppFactory { db: db.clone() }, &id);
        }
        let mut result = Ok(());
        let organizer_is_me = e.calendar_id == LOCAL && e.my_status.as_deref() == Some("organizer") && e.attendees.len() > 1;
        if let (true, true, Some(acc)) = (notify, organizer_is_me, acc) {
            let mut cancelled = e.clone();
            cancelled.sequence += 1;
            cancelled.status = "cancelled".into();
            result = send_organizer_mail(&db, &acc, &cancelled, "CANCEL").map_err(|m| crate::i18n::coded("CAL_SEND_FAILED", &[("v", "deleted"), ("detail", &m)], &format!("The event was deleted, but the cancellation wasn't sent: {m}")));
        }
        lock(&db).execute("DELETE FROM events WHERE calendar_id=?1 AND uid=?2", params![e.calendar_id, e.uid]).map_err(err)?;
        result
    })
    .await;
    changed(&app);
    out
}

#[tauri::command]
pub async fn calendar_respond(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, message_id: String, response: String, comment: Option<String>, send: bool) -> R<CalInvite> {
    let db = state.db.clone();
    let out = crate::blocking(move || respond(&db, &message_id, &response, comment, send)).await;
    changed(&app);
    out
}

#[tauri::command]
pub async fn calendar_add_from_message(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, message_id: String) -> R<CalEvent> {
    let db = state.db.clone();
    let out = crate::blocking(move || {
        let (account_id, _, from_email, text) = message_ics(&db, &message_id)?;
        let c = lock(&db);
        let acc = db::get_account(&c, &account_id)?;
        let got = ingest(&c, &acc, &message_id, &from_email, &text, true)?;
        let id = got.event_id.ok_or_else(|| crate::i18n::coded("CAL_NO_DATA", &[("v", "add")], "nothing to add from this message"))?;
        get_event(&c, &id)
    })
    .await;
    changed(&app);
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRef {
    pub thread_id: String,
    pub folder: String,
    pub account_id: String,
}

/// Where a message lives, so the calendar can open the invitation e-mail.
#[tauri::command]
pub fn calendar_open_message(state: tauri::State<crate::AppState>, message_id: String) -> R<MessageRef> {
    lock(&state.db)
        .query_row("SELECT thread_id,folder,account_id FROM messages WHERE id=?1", [&message_id], |r| {
            Ok(MessageRef { thread_id: r.get(0)?, folder: r.get(1)?, account_id: r.get(2)? })
        })
        .map_err(|_| "CAL_MAIL_GONE: This invitation e-mail is no longer on this computer.".to_string())
}

fn ics_file_name(summary: &str) -> String {
    let clean: String = summary.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' }).collect();
    let clean = clean.trim();
    format!("{}.ics", if clean.is_empty() { "event" } else { clean })
}

/// Save the calendar data of a message, or one event, as a .ics file (native Save dialog). `None` = cancelled.
#[tauri::command]
pub async fn calendar_save_ics(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, message_id: Option<String>, event_id: Option<String>) -> R<Option<String>> {
    let db = state.db.clone();
    crate::blocking(move || {
        let (name, text) = if let Some(mid) = message_id {
            crate::ensure_not_confidential(&lock(&db), &mid)?;
            let (_, _, _, text) = message_ics(&db, &mid)?;
            let name = ical::parse(&text).ok().and_then(|c| c.events.first().map(|e| e.summary.clone())).unwrap_or_default();
            (ics_file_name(&name), text)
        } else if let Some(id) = event_id {
            let e = get_event(&lock(&db), &id)?;
            ensure_event_exportable(&lock(&db), &e)?;
            let mut ev = to_ics_event(&e);
            ev.attendees.clear();
            ev.organizer = e.organizer.as_ref().map(|o| Person { email: o.email.clone(), name: o.name.clone() });
            (ics_file_name(&e.summary), ical::to_ics(None, &[ev]))
        } else {
            return Err("nothing to save".into());
        };
        let Some(picked) = app.dialog().file().add_filter(crate::i18n::tr(crate::i18n::K::CalendarFile), &["ics"]).set_file_name(name).blocking_save_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(err)?;
        std::fs::write(&path, text).map_err(err)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[derive(Serialize, Debug)]
pub struct ImportResult {
    pub added: u32,
    pub updated: u32,
}

/// Add the events of an .ics file to "My events" (native Open dialog). `None` = cancelled.
#[tauri::command]
pub async fn calendar_import_ics(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>) -> R<Option<ImportResult>> {
    let db = state.db.clone();
    let app2 = app.clone();
    let out = crate::blocking(move || {
        let Some(picked) = app2.dialog().file().add_filter(crate::i18n::tr(crate::i18n::K::CalendarFile), &["ics"]).blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(err)?;
        let bytes = std::fs::read(&path).map_err(err)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(crate::i18n::coded("CAL_BAD_FILE", &[("v", "large")], "This file is too large to be a calendar."));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let c = lock(&db);
        Ok(Some(import_text(&c, &text)?))
    })
    .await;
    changed(&app);
    out
}

/// Import calendar text as local events (updates events with the same UID).
pub fn import_text(c: &Connection, text: &str) -> R<ImportResult> {
    let cal = ical::parse(text).map_err(|e| crate::i18n::coded("CAL_BAD_FILE", &[("v", "detail"), ("detail", &e.to_string())], &format!("This doesn't look like a calendar file ({e}).")))?;
    let mut res = ImportResult { added: 0, updated: 0 };
    for ev in &cal.events {
        let rid = ev.recurrence_id.map(|r| r.to_string()).unwrap_or_default();
        let mut e = event_from_ics(ev, LOCAL, None, "", "PUBLISH", default_reminder(c));
        e.source_message_id = None;
        e.my_status = None;
        e.responded_at = None;
        match find(c, LOCAL, &ev.uid, &rid) {
            Some(old) => {
                e.id = old.id;
                res.updated += 1;
            }
            None => res.added += 1,
        }
        save_row(c, &e)?;
        if let Some(at) = ev.recurrence_id {
            add_exdate(c, LOCAL, &ev.uid, at);
        }
    }
    Ok(res)
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn account(id: &str, email: &str) -> Account {
        Account {
            id: id.into(),
            email: email.into(),
            display_name: "Nam Hoang".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            username: email.into(),
            auth: "password".into(),
            color: None,
            smtp_username: String::new(),
            tls_insecure: false,
        }
    }

    fn setup() -> (Connection, Account) {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let a = account("a1", "nam@example.com");
        db::insert_account(&c, &a).unwrap();
        (c, a)
    }

    fn ts(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap().and_utc().timestamp()
    }

    fn request(seq: i64, start_h: u32, method: &str, extra: &str) -> String {
        format!(
            "BEGIN:VCALENDAR\r\nMETHOD:{method}\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:inv-1@contoso.com\r\nSEQUENCE:{seq}\r\nDTSTAMP:20261001T080000Z\r\n\
DTSTART:20261014T{start_h:02}0000Z\r\nDTEND:20261014T{:02}0000Z\r\nSUMMARY:Product sync\r\nLOCATION:Room 4B\r\n\
ORGANIZER;CN=Mai Khanh:mailto:mai@contoso.com\r\nATTENDEE;CN=Nam Hoang;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:nam@example.com\r\n\
ATTENDEE;CN=Bao Tran;PARTSTAT=ACCEPTED:mailto:bao@contoso.com\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n",
            start_h + 1
        )
    }

    fn put_message(c: &Connection, id: &str, ics: &str) {
        c.execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,ics) VALUES(?1,'a1','inbox',(SELECT COUNT(*)+1 FROM messages),'t','s','Mai','mai@contoso.com','nam@example.com','',0,'',?2)",
            params![id, ics],
        )
        .unwrap();
    }

    #[test]
    fn request_adds_event_with_no_answer_and_builds_the_card() {
        let (c, a) = setup();
        let ics = request(0, 8, "REQUEST", "");
        put_message(&c, "m1", &ics);
        let got = ingest(&c, &a, "m1", "mai@contoso.com", &ics, false).unwrap();
        assert!(got.changed);
        let e = get_event(&c, &got.event_id.unwrap()).unwrap();
        assert_eq!(e.calendar_id, "invites:a1");
        assert_eq!(e.my_status.as_deref(), Some("needs-action"));
        assert_eq!(e.reminder_min, Some(15));
        // the same message again changes nothing
        assert!(!ingest(&c, &a, "m1", "mai@contoso.com", &ics, false).unwrap().changed);
        let inv = invite_for(&c, "a1", "m1", "inbox", "mai@contoso.com", &ics, false);
        assert_eq!(inv.method, "REQUEST");
        assert_eq!(inv.summary, "Product sync");
        assert_eq!(inv.you.as_ref().unwrap().status, "needs-action");
        assert!(inv.you.as_ref().unwrap().on_list);
        assert!(inv.responded.is_none());
        assert!(inv.attendees.iter().any(|x| x.is_you));
        assert!(inv.event_id.is_some());
    }

    #[test]
    fn your_own_invitation_is_not_added_twice_and_has_no_rsvp() {
        let (c, a) = setup();
        let input = CalEventInput {
            id: None,
            account_id: Some("a1".into()),
            summary: "Kick-off".into(),
            start: ts(2026, 10, 20, 9, 0),
            end: ts(2026, 10, 20, 10, 0),
            all_day: false,
            tzid: None,
            location: None,
            description: None,
            attendees: vec![CalAttendee { email: "bao@contoso.com".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false }],
            rrule: None,
            reminder_min: None,
            calendar_id: None,
        };
        let (e, _) = save_local(&c, &input).unwrap();
        let req = ical::to_ics(Some("REQUEST"), &[to_ics_event(&e)]);
        put_message(&c, "m7", &req);
        // the copy that comes back to your own inbox (sent by this very account)
        assert!(!ingest(&c, &a, "m7", "nam@example.com", &req, false).unwrap().changed);
        assert_eq!(list_range(&c, 0, i64::MAX / 4).unwrap().len(), 1);
        let inv = invite_for(&c, "a1", "m7", "inbox", "nam@example.com", &req, false);
        assert_eq!(inv.you.as_ref().unwrap().status, "organizer");
        assert!(inv.you.as_ref().unwrap().on_list);
        assert_eq!(inv.event_id.as_deref(), Some(e.id.as_str()));
    }

    #[test]
    fn auto_add_off_keeps_invites_out_until_forced() {
        let (c, a) = setup();
        db::set_setting(&c, "auto_add_invites", "0").unwrap();
        let ics = request(0, 8, "REQUEST", "");
        assert!(!ingest(&c, &a, "m1", "mai@contoso.com", &ics, false).unwrap().changed);
        assert!(list_range(&c, 0, i64::MAX / 4).unwrap().is_empty());
        assert!(ingest(&c, &a, "m1", "mai@contoso.com", &ics, true).unwrap().changed);
        assert_eq!(list_range(&c, 0, i64::MAX / 4).unwrap().len(), 1);
    }

    #[test]
    fn updated_invite_resets_the_answer_and_remembers_what_changed() {
        let (c, a) = setup();
        let v0 = request(0, 8, "REQUEST", "");
        put_message(&c, "m1", &v0);
        let id = ingest(&c, &a, "m1", "mai@contoso.com", &v0, false).unwrap().event_id.unwrap();
        let mut e = get_event(&c, &id).unwrap();
        e.my_status = Some("accepted".into());
        e.responded_at = Some(100);
        save_row(&c, &e).unwrap();
        // an older or equal SEQUENCE never overwrites the answer
        assert!(!ingest(&c, &a, "m1", "mai@contoso.com", &v0, false).unwrap().changed);
        assert_eq!(get_event(&c, &id).unwrap().my_status.as_deref(), Some("accepted"));
        // SEQUENCE 1 moves the meeting by two hours
        let v1 = request(1, 10, "REQUEST", "");
        put_message(&c, "m2", &v1);
        assert!(ingest(&c, &a, "m2", "mai@contoso.com", &v1, false).unwrap().changed);
        let e = get_event(&c, &id).unwrap();
        assert_eq!(e.start, ts(2026, 10, 14, 10, 0));
        assert_eq!(e.sequence, 1);
        assert_eq!(e.my_status.as_deref(), Some("needs-action"), "answer reset");
        assert!(e.responded_at.is_none());
        let inv = invite_for(&c, "a1", "m2", "inbox", "mai@contoso.com", &v1, false);
        let ch = inv.changed.expect("shows what changed");
        assert_eq!(ch.fields, vec!["time".to_string()]);
        assert_eq!(ch.previous.start, ts(2026, 10, 14, 8, 0));
        assert!(!inv.outdated);
        // the old message is marked as outdated
        let old = invite_for(&c, "a1", "m1", "inbox", "mai@contoso.com", &v0, false);
        assert!(old.outdated);
        assert!(old.changed.is_none());
    }

    #[test]
    fn cancel_marks_the_event_and_the_card() {
        let (c, a) = setup();
        let v0 = request(0, 8, "REQUEST", "");
        let id = ingest(&c, &a, "m1", "mai@contoso.com", &v0, false).unwrap().event_id.unwrap();
        let cancel = request(1, 8, "CANCEL", "STATUS:CANCELLED\r\n");
        put_message(&c, "m2", &cancel);
        assert!(ingest(&c, &a, "m2", "mai@contoso.com", &cancel, false).unwrap().changed);
        assert_eq!(get_event(&c, &id).unwrap().status, "cancelled");
        let inv = invite_for(&c, "a1", "m2", "inbox", "mai@contoso.com", &cancel, false);
        assert_eq!(inv.method, "CANCEL");
        assert!(inv.cancelled);
        // a cancellation for an event we never had does nothing
        let (c2, a2) = setup();
        assert!(!ingest(&c2, &a2, "m9", "mai@contoso.com", &cancel, false).unwrap().changed);
    }

    #[test]
    fn updates_and_cancellations_need_the_organizer_as_sender() {
        // F5: any sender with the UID used to be able to rewrite or cancel a stored invitation
        let (c, a) = setup();
        let v0 = request(0, 8, "REQUEST", "");
        let id = ingest(&c, &a, "m1", "mai@contoso.com", &v0, false).unwrap().event_id.unwrap();
        // a forged update (higher SEQUENCE, new time) from a stranger changes nothing
        let forged = request(5, 20, "REQUEST", "");
        assert!(!ingest(&c, &a, "m2", "eve@evil.example", &forged, false).unwrap().changed);
        assert!(!ingest(&c, &a, "m2", "", &forged, false).unwrap().changed);
        let e = get_event(&c, &id).unwrap();
        assert_eq!(e.start, ts(2026, 10, 14, 8, 0));
        assert_eq!(e.sequence, 0);
        // a forged cancellation likewise
        let cancel = request(1, 8, "CANCEL", "STATUS:CANCELLED
");
        assert!(!ingest(&c, &a, "m3", "eve@evil.example", &cancel, false).unwrap().changed);
        assert_eq!(get_event(&c, &id).unwrap().status, "confirmed");
        // the organizer (any case, with a display-name style address) can do both
        assert!(ingest(&c, &a, "m4", " Mai@Contoso.com ", &request(1, 10, "REQUEST", ""), false).unwrap().changed);
        assert_eq!(get_event(&c, &id).unwrap().start, ts(2026, 10, 14, 10, 0));
        assert!(ingest(&c, &a, "m5", "MAI@contoso.com", &request(2, 10, "CANCEL", "STATUS:CANCELLED
"), false).unwrap().changed);
        assert_eq!(get_event(&c, &id).unwrap().status, "cancelled");
        // one cancelled occurrence of a series is also organizer-only
        let (c, a) = setup();
        let series = "BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:ser@x
SEQUENCE:0
DTSTART:20261014T090000Z
DTEND:20261014T100000Z
RRULE:FREQ=WEEKLY
SUMMARY:Series
ORGANIZER:mailto:mai@contoso.com
ATTENDEE:mailto:nam@example.com
END:VEVENT
END:VCALENDAR
";
        let id = ingest(&c, &a, "m1", "mai@contoso.com", series, false).unwrap().event_id.unwrap();
        let one = "BEGIN:VCALENDAR
METHOD:CANCEL
BEGIN:VEVENT
UID:ser@x
SEQUENCE:1
DTSTART:20261021T090000Z
RECURRENCE-ID:20261021T090000Z
STATUS:CANCELLED
ORGANIZER:mailto:mai@contoso.com
END:VEVENT
END:VCALENDAR
";
        assert!(!ingest(&c, &a, "m2", "eve@evil.example", one, false).unwrap().changed);
        assert!(get_event(&c, &id).unwrap().exdates.is_empty());
        assert!(ingest(&c, &a, "m3", "mai@contoso.com", one, false).unwrap().changed);
        assert_eq!(get_event(&c, &id).unwrap().exdates.len(), 1);
    }

    #[test]
    fn reply_updates_the_attendee_of_an_event_you_organized() {
        let (c, _a) = setup();
        let input = CalEventInput {
            id: None,
            account_id: Some("a1".into()),
            summary: "Kick-off".into(),
            start: ts(2026, 10, 20, 9, 0),
            end: ts(2026, 10, 20, 10, 0),
            all_day: false,
            tzid: None,
            location: None,
            description: None,
            attendees: vec![CalAttendee { email: "Bao@Contoso.com".into(), name: Some("Bao Tran".into()), role: "required".into(), status: "needs-action".into(), is_you: false }],
            rrule: None,
            reminder_min: Some(10),
            calendar_id: None,
        };
        let (e, acc) = save_local(&c, &input).unwrap();
        assert!(acc.is_some(), "attendees: an invitation has to be sent");
        assert_eq!(e.my_status.as_deref(), Some("organizer"));
        assert_eq!(e.attendees.len(), 2);
        assert_eq!(e.attendees[1].email, "bao@contoso.com");
        // the REQUEST we would send reads back to the same event
        let req = ical::to_ics(Some("REQUEST"), &[to_ics_event(&e)]);
        let back = ical::parse(&req).unwrap();
        assert_eq!(back.events[0].uid, e.uid);
        assert_eq!(back.events[0].organizer.as_ref().unwrap().email, "nam@example.com");
        // Bao answers
        let reply = ical::to_ics(Some("REPLY"), &[ical::reply_event(&to_ics_event(&e), &Person { email: "bao@contoso.com".into(), name: None }, "declined", Some("Out of office"), 1)]);
        put_message(&c, "m5", &reply);
        let a1 = db::get_account(&c, "a1").unwrap();
        // F5: the same answer from someone else's address is ignored, and so is an answer on behalf of another person
        assert!(!ingest(&c, &a1, "m5", "eve@evil.example", &reply, false).unwrap().changed, "REPLY from a stranger");
        assert!(!ingest(&c, &a1, "m5", "", &reply, false).unwrap().changed, "REPLY without a sender");
        assert_eq!(get_event(&c, &e.id).unwrap().attendees[1].status, "needs-action");
        let for_other = ical::to_ics(Some("REPLY"), &[ical::reply_event(&to_ics_event(&e), &Person { email: "carol@contoso.com".into(), name: None }, "accepted", None, 1)]);
        assert!(!ingest(&c, &a1, "m6", "bao@contoso.com", &for_other, false).unwrap().changed, "Bao cannot answer for Carol");
        assert_eq!(get_event(&c, &e.id).unwrap().attendees.len(), 2, "no attendee was added");
        // F27: a stranger answering with their own address is not added as an attendee either
        let stranger = ical::to_ics(Some("REPLY"), &[ical::reply_event(&to_ics_event(&e), &Person { email: "eve@evil.example".into(), name: None }, "accepted", None, 1)]);
        assert!(!ingest(&c, &a1, "m7", "eve@evil.example", &stranger, false).unwrap().changed, "REPLY from a non-attendee");
        assert_eq!(get_event(&c, &e.id).unwrap().attendees.len(), 2, "the stranger was not added");
        assert!(ingest(&c, &a1, "m5", "bao@contoso.com", &reply, false).unwrap().changed);
        let after = get_event(&c, &e.id).unwrap();
        assert_eq!(after.attendees[1].status, "declined");
        let inv = invite_for(&c, "a1", "m5", "inbox", "bao@contoso.com", &reply, false);
        assert_eq!(inv.method, "REPLY");
        let r = inv.reply.unwrap();
        assert_eq!(r.status, "declined");
        assert_eq!(r.comment.as_deref(), Some("Out of office"));
        assert_eq!(inv.attendees[1].status, "declined", "card shows the current answers");
        // editing with the same time keeps the answers; moving the time resets them
        let mut edit = input.clone();
        edit.id = Some(e.id.clone());
        let (same, _) = save_local(&c, &edit).unwrap();
        assert_eq!(same.attendees[1].status, "declined");
        assert_eq!(same.sequence, 1);
        edit.start += 3600;
        edit.end += 3600;
        let (moved, _) = save_local(&c, &edit).unwrap();
        assert_eq!(moved.attendees[1].status, "needs-action");
        assert_eq!(moved.sequence, 2);
    }

    #[test]
    fn local_event_without_attendees_is_just_an_event() {
        let (c, _) = setup();
        let (e, acc) = save_local(
            &c,
            &CalEventInput { id: None, account_id: None, summary: "  ".into(), start: ts(2026, 10, 20, 9, 0), end: ts(2026, 10, 20, 9, 30), all_day: false, tzid: Some("Nowhere".into()), location: Some(" ".into()), description: None, attendees: vec![], rrule: None, reminder_min: None, calendar_id: None },
        )
        .unwrap();
        assert!(acc.is_none());
        assert_eq!(e.summary, "(No title)");
        assert!(e.tzid.is_none() && e.location.is_none() && e.my_status.is_none());
        assert!(save_local(&c, &CalEventInput { id: None, account_id: None, summary: "x".into(), start: 10, end: 5, all_day: false, tzid: None, location: None, description: None, attendees: vec![], rrule: None, reminder_min: None, calendar_id: None }).is_err());
        // attendees need an account to send from
        let r = save_local(&c, &CalEventInput { id: None, account_id: None, summary: "x".into(), start: 1, end: 2, all_day: false, tzid: None, location: None, description: None, attendees: vec![CalAttendee { email: "a@b.c".into(), name: None, role: "required".into(), status: "needs-action".into(), is_you: false }], rrule: None, reminder_min: None, calendar_id: None });
        assert!(r.unwrap_err().starts_with("CAL_NO_ACCOUNT"));
    }

    #[test]
    fn range_query_expands_repeating_events_and_skips_hidden_calendars() {
        let (c, _) = setup();
        let mk = |summary: &str, start: i64, end: i64, all_day: bool, rrule: Option<&str>| {
            save_local(
                &c,
                &CalEventInput { id: None, account_id: None, summary: summary.into(), start, end, all_day, tzid: None, location: None, description: None, attendees: vec![], rrule: rrule.map(|s| s.to_string()), reminder_min: None, calendar_id: None },
            )
            .unwrap()
            .0
        };
        mk("One-off", ts(2026, 10, 14, 9, 0), ts(2026, 10, 14, 10, 0), false, None);
        mk("Weekly", ts(2026, 10, 7, 15, 0), ts(2026, 10, 7, 16, 0), false, Some("FREQ=WEEKLY;BYDAY=WE"));
        mk("Offsite", ts(2026, 10, 15, 0, 0), ts(2026, 10, 17, 0, 0), true, None);
        mk("Later", ts(2026, 12, 1, 9, 0), ts(2026, 12, 1, 10, 0), false, None);
        let got = list_range(&c, ts(2026, 10, 12, 0, 0), ts(2026, 10, 19, 0, 0)).unwrap();
        let names: Vec<&str> = got.iter().map(|e| e.summary.as_str()).collect();
        assert_eq!(names, vec!["One-off", "Weekly", "Offsite"], "{names:?}"); // 14 Oct 09:00, 14 Oct 15:00 (Wed), 15-16 Oct; the next Wednesday is outside
        let weekly: Vec<&CalEvent> = got.iter().filter(|e| e.summary == "Weekly").collect();
        assert!(weekly.iter().all(|e| e.instance_start == Some(e.start) && e.recurrence_text.as_deref() == Some("Every Wednesday")));
        // boundaries: an event ending exactly at the window start is not in it, one starting at the window end is not either
        assert!(list_range(&c, ts(2026, 10, 14, 10, 0), ts(2026, 10, 14, 15, 0)).unwrap().iter().all(|e| e.all_day), "timed events must really touch the window (all-day ones keep a day of slack)");
        // the series keeps going: Wednesday 6 Jan 2027
        assert_eq!(list_range(&c, ts(2027, 1, 6, 0, 0), ts(2027, 1, 7, 0, 0)).unwrap().len(), 1);
        // an empty range
        assert!(list_range(&c, ts(2020, 1, 1, 0, 0), ts(2020, 1, 2, 0, 0)).unwrap().is_empty());
        // hidden calendar
        db::set_setting(&c, "cal_hidden", "[\"local\"]").unwrap();
        assert!(list_range(&c, ts(2026, 10, 12, 0, 0), ts(2026, 10, 19, 0, 0)).unwrap().is_empty());
    }

    #[test]
    fn listing_many_hostile_repeating_events_stays_fast() {
        // F32: every list call re-expands stored rules, so the work of one call is bounded however many events there are
        let (c, a) = setup();
        let days: Vec<String> = (0..300).map(|i| ((i % 31) as i32 + 1).to_string()).collect();
        let rule = format!("FREQ=MONTHLY;BYMONTHDAY={}", days.join(","));
        for i in 0..60 {
            let ics = format!("BEGIN:VCALENDAR\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:hostile{i}\r\nDTSTART:19710101T090000Z\r\nDTEND:19710101T100000Z\r\nSUMMARY:x\r\nRRULE:{rule}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
            put_message(&c, &format!("h{i}"), &ics);
            ingest(&c, &a, &format!("h{i}"), "mai@contoso.com", &ics, true).unwrap();
        }
        let t = std::time::Instant::now();
        let got = list_range(&c, ts(2026, 1, 1, 0, 0), ts(2027, 1, 1, 0, 0)).unwrap();
        let took = t.elapsed();
        assert!(took.as_millis() < 2000, "took {took:?}");
        assert!(got.len() <= 20_000);
    }

    #[test]
    fn occurrence_override_and_cancel_of_one_occurrence_use_exdates() {
        let (c, a) = setup();
        let series = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:ser@x\r\nSEQUENCE:0\r\nDTSTART:20261014T090000Z\r\nDTEND:20261014T100000Z\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Series\r\nORGANIZER:mailto:mai@contoso.com\r\nATTENDEE:mailto:nam@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(ingest(&c, &a, "m1", "mai@contoso.com", series, false).unwrap().changed);
        let cancel_one = "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:ser@x\r\nSEQUENCE:1\r\nDTSTART:20261021T090000Z\r\nRECURRENCE-ID:20261021T090000Z\r\nSUMMARY:Series\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(ingest(&c, &a, "m2", "mai@contoso.com", cancel_one, false).unwrap().changed);
        let moved = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:ser@x\r\nSEQUENCE:1\r\nDTSTART:20261029T140000Z\r\nDTEND:20261029T150000Z\r\nRECURRENCE-ID:20261028T090000Z\r\nSUMMARY:Series (moved)\r\nORGANIZER:mailto:mai@contoso.com\r\nATTENDEE:mailto:nam@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(ingest(&c, &a, "m3", "mai@contoso.com", moved, false).unwrap().changed);
        let got = list_range(&c, ts(2026, 10, 13, 0, 0), ts(2026, 11, 5, 0, 0)).unwrap();
        let mut seen: Vec<(String, i64)> = got.iter().map(|e| (e.summary.clone(), e.start)).collect();
        seen.sort_by_key(|x| x.1);
        assert_eq!(
            seen,
            vec![
                ("Series".to_string(), ts(2026, 10, 14, 9, 0)),
                ("Series (moved)".to_string(), ts(2026, 10, 29, 14, 0)),
                ("Series".to_string(), ts(2026, 11, 4, 9, 0)),
            ],
            "21 Oct cancelled, 28 Oct replaced by the override"
        );
    }

    #[test]
    fn import_adds_updates_and_rejects_garbage() {
        let (c, _) = setup();
        let f = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a@x\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b@x\r\nDTSTART:20261102T080000Z\r\nDTEND:20261102T090000Z\r\nSUMMARY:Call\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let r = import_text(&c, f).unwrap();
        assert_eq!((r.added, r.updated), (2, 0));
        let r = import_text(&c, &f.replace("Holiday", "Public holiday")).unwrap();
        assert_eq!((r.added, r.updated), (0, 2));
        let n: i64 = c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        assert!(import_text(&c, "not a calendar").unwrap_err().starts_with("CAL_BAD_FILE"));
    }

    #[test]
    fn invalid_calendar_data_gives_a_parse_error_card() {
        let (c, _) = setup();
        let inv = invite_for(&c, "a1", "m1", "inbox", "x@y.z", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:no start\r\nEND:VEVENT\r\nEND:VCALENDAR", false);
        assert!(inv.parse_error.is_some());
        assert_eq!(inv.method, "OTHER");
    }

    #[test]
    fn imip_messages_have_a_readable_part_and_a_calendar_part() {
        let a = account("a1", "nam@example.com");
        let inv = ical::parse(&request(2, 8, "REQUEST", "")).unwrap().events.remove(0);
        let me = Person { email: "nam@example.com".into(), name: Some("Nam Hoang".into()) };
        let reply = ical::reply_event(&inv, &me, "tentative", Some("Maybe"), 5);
        let part = iso_part("REPLY", &reply);
        let msg = crate::smtp::build_calendar_mail(&a, &["mai@contoso.com".into()], &[], "Tentative: Product sync", &body_text("Nam Hoang", "has tentatively accepted", &inv), &part).unwrap();
        let raw = String::from_utf8_lossy(&msg.formatted()).into_owned();
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("text/calendar; charset=utf-8; method=REPLY") || raw.to_lowercase().contains("method=reply"), "{raw}");
        assert!(raw.contains("Subject: Tentative: Product sync"));
        // read it back the way a receiving client (this app) would
        let back = crate::mail::parse(1, &msg.formatted(), true, false, 0).unwrap();
        assert_eq!(back.cal_method.as_deref(), Some("reply"));
        let cal = ical::parse(back.ics.as_deref().unwrap()).unwrap();
        assert_eq!(cal.events[0].uid, "inv-1@contoso.com");
        assert_eq!(cal.events[0].sequence, 2);
        assert_eq!(cal.events[0].attendees[0].status, "tentative");
        assert_eq!(cal.events[0].comment.as_deref(), Some("Maybe"));
        assert!(back.text.unwrap().contains("has tentatively accepted: Product sync"));
        assert!(!raw.contains("invite.ics"), "replies carry no attachment");
        // an invitation additionally attaches invite.ics
        let req = iso_part("REQUEST", &inv);
        let msg = crate::smtp::build_calendar_mail(&a, &["bao@contoso.com".into()], &[], "Invitation: x", "x", &req).unwrap();
        let raw = String::from_utf8_lossy(&msg.formatted()).into_owned();
        assert!(raw.contains("multipart/mixed") && raw.contains("invite.ics") && raw.to_lowercase().contains("method=request"));
    }

    #[test]
    fn meeting_draft_gets_a_calendar_part_and_a_local_event() {
        let (c, _) = setup();
        let mut d = crate::smtp::Draft {
            account_id: "a1".into(),
            to: vec!["Bao Tran <bao@contoso.com>".into()],
            cc: vec!["linh@example.com".into()],
            bcc: vec![],
            subject: "Q4 call".into(),
            html: "<p>Agenda</p>".into(),
            text: "Agenda".into(),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            inline: vec![],
            security: None,
            prebuilt: None,
            meeting: Some(crate::smtp::Meeting { start: ts(2026, 10, 20, 9, 0), end: ts(2026, 10, 20, 10, 0), all_day: false, tzid: Some("Asia/Ho_Chi_Minh".into()), location: Some("Room 1".into()), rrule: None }),
            calendar: None,
            confidential: false,
        };
        prepare_meeting(&c, &mut d).unwrap();
        let cal = d.calendar.clone().unwrap();
        assert_eq!(cal.method, "REQUEST");
        let parsed = ical::parse(&cal.ics).unwrap();
        let ev = &parsed.events[0];
        assert_eq!(ev.summary, "Q4 call");
        assert_eq!(ev.attendees.len(), 3);
        assert_eq!(ev.attendees[1].name.as_deref(), Some("Bao Tran"));
        assert_eq!(ev.attendees[2].role, "optional", "Cc = optional attendee");
        let e = list_range(&c, ts(2026, 10, 20, 0, 0), ts(2026, 10, 21, 0, 0)).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].uid, ev.uid);
        // preparing twice does not create a second event
        prepare_meeting(&c, &mut d).unwrap();
        assert_eq!(list_range(&c, 0, i64::MAX / 4).unwrap().len(), 1);
        // the sent message contains the invitation twice-over: alternative + invite.ics
        let acc = db::get_account(&c, "a1").unwrap();
        let raw = String::from_utf8_lossy(&crate::smtp::build(&acc, &d).unwrap().formatted()).into_owned();
        assert!(raw.contains("multipart/mixed") && raw.contains("multipart/alternative") && raw.to_lowercase().contains("method=request") && raw.contains("invite.ics"));
        assert!(raw.contains("<p>Agenda</p>"), "the body is still there");
    }

    // ---- two accounts in one app: A organizes, B is invited (both live in the same database)

    const A_ID: &str = "acc-a";
    const B_ID: &str = "acc-b";
    const C_ID: &str = "acc-c";
    const A_MAIL: &str = "a.owner@gmail.example";
    const B_MAIL: &str = "b.guest@gmail.example";
    const C_MAIL: &str = "c.guest@gmail.example";

    fn two_accounts() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        for (id, mail, name) in [(A_ID, A_MAIL, "Nam Thái (namth.onl)"), (B_ID, B_MAIL, "Nam Thái (thnonline)"), (C_ID, C_MAIL, "Cee, \"C\"")] {
            let mut a = account(id, mail);
            a.display_name = name.into();
            db::insert_account(&c, &a).unwrap();
        }
        c
    }

    fn acct(c: &Connection, id: &str) -> Account {
        db::get_account(c, id).unwrap()
    }

    /// A message as it is stored for one account.
    fn put_for(c: &Connection, id: &str, account: &str, folder: &str, from: &str, ics: &str) {
        c.execute(
            "INSERT INTO messages(id,account_id,folder,uid,thread_id,subject,from_name,from_email,to_addrs,cc_addrs,date,snippet,ics) VALUES(?1,?2,?3,(SELECT COUNT(*)+1 FROM messages),'t','s','x',?4,'','',0,'',?5)",
            params![id, account, folder, from, ics],
        )
        .unwrap();
    }

    fn att(email: &str, name: Option<&str>) -> CalAttendee {
        CalAttendee { email: email.into(), name: name.map(|n| n.into()), role: "required".into(), status: "needs-action".into(), is_you: false }
    }

    fn organize(c: &Connection, attendees: Vec<CalAttendee>) -> CalEvent {
        let input = CalEventInput {
            id: None,
            account_id: Some(A_ID.into()),
            summary: "Planning".into(),
            start: ts(2026, 10, 20, 9, 0),
            end: ts(2026, 10, 20, 10, 0),
            all_day: false,
            tzid: None,
            location: None,
            description: None,
            attendees,
            rrule: None,
            reminder_min: None,
            calendar_id: None,
        };
        save_local(c, &input).unwrap().0
    }

    fn request_ics(e: &CalEvent) -> String {
        ical::to_ics(Some("REQUEST"), &[to_ics_event(e)])
    }

    #[test]
    fn events_of_confidential_invitations_are_not_exportable() {
        let c = two_accounts();
        let e = organize(&c, vec![att(B_MAIL, None)]);
        let req = request_ics(&e);
        put_for(&c, "inv-plain", A_ID, "inbox", B_MAIL, &req);
        put_for(&c, "inv-conf", A_ID, "inbox", B_MAIL, &req);
        c.execute("UPDATE messages SET pgp=?1 WHERE id='inv-conf'", [crate::pgpmail::FLAG_CONFIDENTIAL as i64]).unwrap();
        let from = |mid: &str| -> CalEvent {
            let mut ev = organize(&c, vec![]);
            ev.id = format!("ev-{mid}");
            ev.calendar_id = format!("invites:{A_ID}");
            ev.source_message_id = Some(mid.to_string());
            save_row(&c, &ev).unwrap();
            get_event(&c, &ev.id).unwrap()
        };
        let (plain, conf) = (from("inv-plain"), from("inv-conf"));
        assert!(!plain.confidential && ensure_event_exportable(&c, &plain).is_ok());
        assert!(conf.confidential);
        assert_eq!(ensure_event_exportable(&c, &conf).unwrap_err(), "CONFIDENTIAL: This message is confidential, so that isn’t allowed.");
        // an event of your own, or one without a source message, is never held back
        assert!(ensure_event_exportable(&c, &e).is_ok());
        assert!(list_range(&c, 0, i64::MAX / 4).unwrap().iter().any(|x| x.id == conf.id && x.confidential));
    }

    #[test]
    fn invitee_in_the_same_app_is_not_the_organizer() {
        let c = two_accounts();
        let (a, b) = (acct(&c, A_ID), acct(&c, B_ID));
        let e = organize(&c, vec![att(B_MAIL, Some("Nam Thái (thnonline)"))]);
        let req = request_ics(&e);
        put_for(&c, "a-copy", A_ID, "inbox", A_MAIL, &req); // Cc / copy in the organizer's own mailbox
        put_for(&c, "b-msg", B_ID, "inbox", A_MAIL, &req); // the delivery to the guest
        // the organizer's own copy is not a second event
        assert!(!ingest(&c, &a, "a-copy", A_MAIL, &req, false).unwrap().changed);
        // the guest's mailbox gets its own event
        let got = ingest(&c, &b, "b-msg", A_MAIL, &req, false).unwrap();
        assert!(got.changed, "the invitation reaches the second account of the app");
        let row = get_event(&c, &got.event_id.clone().unwrap()).unwrap();
        assert_eq!(row.calendar_id, format!("invites:{B_ID}"));
        assert_eq!(row.account_id.as_deref(), Some(B_ID));
        assert_eq!(row.my_status.as_deref(), Some("needs-action"));
        assert_ne!(row.id, e.id, "independent of the organizer's event");

        // the guest's card: not the organizer, only the guest is "you"
        let inv = invite_for(&c, B_ID, "b-msg", "inbox", A_MAIL, &req, false);
        let you = inv.you.clone().unwrap();
        assert_eq!(you.status, "needs-action", "not 'organizer'");
        assert_eq!(you.email, B_MAIL);
        assert!(you.on_list);
        assert_eq!(inv.event_id.as_deref(), Some(row.id.as_str()), "points at the guest's own row");
        let mine: Vec<&str> = inv.attendees.iter().filter(|x| x.is_you).map(|x| x.email.as_str()).collect();
        assert_eq!(mine, vec![B_MAIL]);

        // the organizer's card for its copy
        let inv_a = invite_for(&c, A_ID, "a-copy", "inbox", A_MAIL, &req, false);
        assert_eq!(inv_a.you.clone().unwrap().status, "organizer");
        assert_eq!(inv_a.event_id.as_deref(), Some(e.id.as_str()));
        let mine: Vec<&str> = inv_a.attendees.iter().filter(|x| x.is_you).map(|x| x.email.as_str()).collect();
        assert_eq!(mine, vec![A_MAIL]);

        // the calendar views: each event only flags its own account
        let list = list_range(&c, 0, i64::MAX / 4).unwrap();
        assert_eq!(list.len(), 2);
        for ev in list {
            let flagged: Vec<&str> = ev.attendees.iter().filter(|x| x.is_you).map(|x| x.email.as_str()).collect();
            let want = if ev.calendar_id == LOCAL { A_MAIL } else { B_MAIL };
            assert_eq!(flagged, vec![want], "{}", ev.calendar_id);
        }
    }

    #[test]
    fn one_invitation_delivered_to_two_local_accounts_makes_two_independent_events() {
        let c = two_accounts();
        let (b, cc) = (acct(&c, B_ID), acct(&c, C_ID));
        let e = organize(&c, vec![att(B_MAIL, None), att(C_MAIL, None)]);
        let req = request_ics(&e);
        put_for(&c, "mb", B_ID, "inbox", A_MAIL, &req);
        put_for(&c, "mc", C_ID, "inbox", A_MAIL, &req);
        let eb = ingest(&c, &b, "mb", A_MAIL, &req, false).unwrap().event_id.unwrap();
        let ec = ingest(&c, &cc, "mc", A_MAIL, &req, false).unwrap().event_id.unwrap();
        assert_ne!(eb, ec);
        // B accepts, C is still undecided
        let db: crate::Db = std::sync::Arc::new(std::sync::Mutex::new(c));
        let after = respond(&db, "mb", "accepted", None, false).unwrap();
        assert_eq!(after.responded.as_ref().map(|r| r.status.as_str()), Some("accepted"));
        // the returned card equals the stored state: B's own attendee row is accepted, the others keep theirs
        let mine: Vec<(&str, &str)> = after.attendees.iter().filter(|x| x.is_you).map(|x| (x.email.as_str(), x.status.as_str())).collect();
        assert_eq!(mine, vec![(B_MAIL, "accepted")]);
        assert!(after.attendees.iter().filter(|x| !x.is_you && x.role != "chair").all(|x| x.status == "needs-action"));
        let c = lock(&db);
        assert_eq!(get_event(&c, &eb).unwrap().my_status.as_deref(), Some("accepted"));
        assert_eq!(get_event(&c, &ec).unwrap().my_status.as_deref(), Some("needs-action"));
        let inv_c = invite_for(&c, C_ID, "mc", "inbox", A_MAIL, &req, false);
        assert!(inv_c.responded.is_none());
        assert_eq!(inv_c.you.unwrap().email, C_MAIL);
        // deleting one guest's copy leaves the other
        c.execute("DELETE FROM events WHERE id=?1", [&eb]).unwrap();
        assert!(get_event(&c, &ec).is_ok());
        assert!(get_event(&c, &e.id).is_ok());
    }

    #[test]
    fn answer_from_a_local_account_updates_the_organizers_event() {
        let c = two_accounts();
        let (a, b) = (acct(&c, A_ID), acct(&c, B_ID));
        let e = organize(&c, vec![att(B_MAIL, None)]);
        let req = request_ics(&e);
        put_for(&c, "mb", B_ID, "inbox", A_MAIL, &req);
        ingest(&c, &b, "mb", A_MAIL, &req, false).unwrap();
        // B answers (the reply message is built from B's account, as respond() does)
        let parsed = ical::parse(&req).unwrap();
        let me = Person { email: B_MAIL.into(), name: Some("B".into()) };
        let reply = ical::to_ics(Some("REPLY"), &[ical::reply_event(&parsed.events[0], &me, "accepted", None, now())]);
        // ... and it arrives in A's inbox, from B
        put_for(&c, "a-reply", A_ID, "inbox", B_MAIL, &reply);
        let got = ingest(&c, &a, "a-reply", B_MAIL, &reply, false).unwrap();
        assert!(got.changed, "a REPLY from the other local account is not treated as an own copy");
        assert_eq!(got.event_id.as_deref(), Some(e.id.as_str()));
        let ev = get_event(&c, &e.id).unwrap();
        assert_eq!(ev.attendees.iter().find(|x| x.email == B_MAIL).unwrap().status, "accepted");
        // the card in A's mailbox shows the organizer's event, and only A is "you"
        let inv = invite_for(&c, A_ID, "a-reply", "inbox", B_MAIL, &reply, false);
        assert_eq!(inv.method, "REPLY");
        assert_eq!(inv.event_id.as_deref(), Some(e.id.as_str()));
        assert_eq!(inv.attendees.iter().filter(|x| x.is_you).map(|x| x.email.as_str()).collect::<Vec<_>>(), vec![A_MAIL]);
        // the same answer read in B's own Sent folder never touches anything
        put_for(&c, "b-sent", B_ID, "sent", B_MAIL, &reply);
        let own = invite_for(&c, B_ID, "b-sent", "sent", B_MAIL, &reply, false);
        assert!(own.event_id.is_none());
        // a stranger's answer for B does nothing
        let again = ical::to_ics(Some("REPLY"), &[ical::reply_event(&parsed.events[0], &me, "declined", None, now())]);
        assert!(!ingest(&c, &a, "forged", "eve@evil.example", &again, false).unwrap().changed);
        assert_eq!(get_event(&c, &e.id).unwrap().attendees.iter().find(|x| x.email == B_MAIL).unwrap().status, "accepted");
    }

    #[test]
    fn own_copy_rule_needs_same_account_and_same_sender() {
        let c = two_accounts();
        let (a, b) = (acct(&c, A_ID), acct(&c, B_ID));
        let e = organize(&c, vec![att(B_MAIL, None)]);
        let req = request_ics(&e);
        // A's own copy: skipped
        assert!(!ingest(&c, &a, "x1", A_MAIL, &req, false).unwrap().changed);
        // the same invitation in A that is not from A (somebody forwarded it back): a regular invitation row
        assert!(ingest(&c, &a, "x2", "forwarder@example.com", &req, false).unwrap().changed);
        // an event organized by A is not B's own even when B is the sender
        assert!(ingest(&c, &b, "x4", B_MAIL, &req, false).unwrap().changed);
    }

    #[test]
    fn reschedule_shows_what_changed_for_the_guest_account() {
        let c = two_accounts();
        let b = acct(&c, B_ID);
        let e = organize(&c, vec![att(B_MAIL, None)]);
        let v0 = request_ics(&e);
        put_for(&c, "m0", B_ID, "inbox", A_MAIL, &v0);
        ingest(&c, &b, "m0", A_MAIL, &v0, false).unwrap();
        // A moves the event by two hours: SEQUENCE 0 -> 1
        let (moved, _) = save_local(
            &c,
            &CalEventInput {
                id: Some(e.id.clone()),
                account_id: Some(A_ID.into()),
                summary: e.summary.clone(),
                start: e.start + 7200,
                end: e.end + 7200,
                all_day: false,
                tzid: None,
                location: None,
                description: None,
                attendees: vec![att(B_MAIL, None)],
                rrule: None,
                reminder_min: None,
                calendar_id: None,
            },
        )
        .unwrap();
        assert_eq!(moved.sequence, 1);
        let v1 = request_ics(&moved);
        put_for(&c, "m1", B_ID, "inbox", A_MAIL, &v1);
        assert!(ingest(&c, &b, "m1", A_MAIL, &v1, false).unwrap().changed);
        let inv = invite_for(&c, B_ID, "m1", "inbox", A_MAIL, &v1, false);
        let ch = inv.changed.expect("the update card shows the previous time");
        assert_eq!(ch.fields, vec!["time".to_string()]);
        assert_eq!(ch.previous.start, e.start);
        assert_eq!(ch.previous.end, e.end);
        assert_eq!(inv.start, e.start + 7200);
        assert!(!inv.outdated);
        assert_eq!(inv.you.unwrap().status, "needs-action", "answer reset by the update");
    }

    /// Gmail stores one message twice (Inbox and All Mail): the reading pane may open either copy.
    #[test]
    fn every_stored_copy_of_an_update_shows_the_same_card_and_answers_once() {
        let c = two_accounts();
        let b = acct(&c, B_ID);
        let e = organize(&c, vec![att(B_MAIL, None)]);
        let v0 = request_ics(&e);
        put_for(&c, "m0-inbox", B_ID, "inbox", A_MAIL, &v0);
        put_for(&c, "m0-all", B_ID, "archive", A_MAIL, &v0);
        ingest(&c, &b, "m0-inbox", A_MAIL, &v0, false).unwrap();
        let (moved, _) = save_local(
            &c,
            &CalEventInput {
                id: Some(e.id.clone()),
                account_id: Some(A_ID.into()),
                summary: e.summary.clone(),
                start: e.start + 3600,
                end: e.end + 3600,
                all_day: false,
                tzid: None,
                location: Some("Room 2".into()),
                description: None,
                attendees: vec![att(B_MAIL, None)],
                rrule: None,
                reminder_min: None,
                calendar_id: None,
            },
        )
        .unwrap();
        let v1 = request_ics(&moved);
        put_for(&c, "m1-inbox", B_ID, "inbox", A_MAIL, &v1);
        put_for(&c, "m1-all", B_ID, "archive", A_MAIL, &v1);
        // the Inbox copy is the one that was ingested ...
        assert!(ingest(&c, &b, "m1-inbox", A_MAIL, &v1, false).unwrap().changed);
        // ... the All Mail copy of the same message is the same card
        let inbox = invite_for(&c, B_ID, "m1-inbox", "inbox", A_MAIL, &v1, false);
        let all = invite_for(&c, B_ID, "m1-all", "archive", A_MAIL, &v1, false);
        let (ci, ca) = (inbox.changed.expect("inbox copy shows the change"), all.changed.expect("All Mail copy shows the change"));
        assert_eq!(ci.fields, ca.fields);
        assert_eq!(ci.fields, vec!["time".to_string(), "location".to_string()]);
        assert_eq!(ca.previous.start, e.start);
        assert_eq!(all.event_id, inbox.event_id);
        assert!(!all.outdated && !inbox.outdated);
        // copies of the superseded version are outdated and show no change
        let old = invite_for(&c, B_ID, "m0-all", "archive", A_MAIL, &v0, false);
        assert!(old.outdated);
        assert!(old.changed.is_none());
        // answering from the All Mail copy: stored once on the one event; B's own attendee row follows
        let db: crate::Db = std::sync::Arc::new(std::sync::Mutex::new(c));
        let after = respond(&db, "m1-all", "accepted", None, false).unwrap();
        assert_eq!(after.responded.as_ref().map(|r| r.status.as_str()), Some("accepted"));
        {
            let c = lock(&db);
            let row = get_event(&c, after.event_id.as_deref().unwrap()).unwrap();
            assert_eq!(row.my_status.as_deref(), Some("accepted"));
            assert_eq!(row.attendees.iter().find(|x| x.email == B_MAIL).unwrap().status, "accepted", "own attendee row updated");
            assert_eq!(c.query_row("SELECT COUNT(*) FROM events WHERE calendar_id=?1", [format!("invites:{B_ID}")], |r| r.get::<_, i64>(0)).unwrap(), 1);
            // pretend the answer went out, then the same answer from the other copy must not be mailed again
            c.execute("UPDATE events SET responded_at=?1 WHERE id=?2", params![now(), row.id]).unwrap();
            assert!(already_answered(&get_event(&c, &row.id).unwrap(), "accepted", None));
            assert!(!already_answered(&get_event(&c, &row.id).unwrap(), "declined", None));
            assert!(!already_answered(&get_event(&c, &row.id).unwrap(), "accepted", Some("see you")));
        }
        // send = true would reach SMTP; no error here proves nothing was sent
        let again = respond(&db, "m1-inbox", "accepted", None, true).expect("no second mail for the same answer");
        assert_eq!(again.responded.as_ref().map(|r| r.status.as_str()), Some("accepted"));
        assert!(again.responded.unwrap().sent_at.is_some());
    }

    #[test]
    fn invitation_mail_survives_hostile_display_names() {
        let c = two_accounts();
        let a = acct(&c, A_ID);
        let names = [
            "Nam Thái (thnonline)",
            "Tran, Bao",
            "He said \"hi\"",
            "Back\\slash <b@x.y>",
            "semi;colon: ok",
            "Đỗ Văn Ánh",
            "a\r\nBcc: evil@x.y",
        ];
        for n in names {
            let e = organize(&c, vec![att(B_MAIL, Some(n)), att(C_MAIL, Some(n))]);
            let to = mailto_list(&e.attendees, &a.email);
            assert_eq!(to.len(), 2, "organizer skipped for {n:?}");
            let ev = to_ics_event(&e);
            let msg = crate::smtp::build_calendar_mail(&a, &to, &[], "Invitation: x", "body", &iso_part("REQUEST", &ev)).unwrap_or_else(|er| panic!("{n:?}: {er}"));
            let raw = msg.formatted();
            let parsed = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
            let rcpt: Vec<String> = parsed.to().unwrap().iter().filter_map(|x| x.address.as_ref().map(|s| s.to_string())).collect();
            assert_eq!(rcpt, vec![B_MAIL.to_string(), C_MAIL.to_string()], "{n:?}");
            assert!(parsed.bcc().is_none(), "no injected Bcc for {n:?}");
            let shown = parsed.to().unwrap().first().unwrap().name.as_ref().map(|s| s.to_string()).unwrap_or_default();
            let want = n.split_whitespace().collect::<Vec<_>>().join(" ");
            assert_eq!(shown, want, "display name survives for {n:?}");
            assert_eq!(msg.envelope().to().len(), 2);
        }
        // the sending account's own display name is just as hostile and still builds
        let mut hostile = a.clone();
        hostile.display_name = "Nam Thái (namth), \"Boss\"; <x@y.z>".into();
        let e = organize(&c, vec![att(B_MAIL, None)]);
        let msg = crate::smtp::build_calendar_mail(&hostile, &mailto_list(&e.attendees, &a.email), &[], "s", "b", &iso_part("REQUEST", &to_ics_event(&e))).unwrap();
        let raw = msg.formatted();
        let parsed = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
        assert_eq!(parsed.from().unwrap().first().unwrap().address.as_ref().unwrap().to_string(), A_MAIL);
    }

    #[test]
    fn a_backslash_in_a_guest_name_reaches_the_invitation() {
        let c = two_accounts();
        let hostile = r#"Nam; Thái: "test" \ (x)"#;
        for to in [crate::smtp::format_mailbox(Some(hostile), B_MAIL), format!("{hostile} <{B_MAIL}>"), format!(r#""Nam; Thái: \"test\" \ (x)" <{B_MAIL}>"#)] {
            let mut d = crate::smtp::Draft {
                account_id: A_ID.into(),
                to: vec![to.clone()],
                cc: vec![],
                bcc: vec![],
                subject: "Sync".into(),
                html: "<p>x</p>".into(),
                text: "x".into(),
                in_reply_to: None,
                references: vec![],
                attachments: vec![],
                inline: vec![],
                security: None,
                prebuilt: None,
                meeting: Some(crate::smtp::Meeting { start: ts(2026, 10, 21, 9, 0), end: ts(2026, 10, 21, 10, 0), all_day: false, tzid: None, location: None, rrule: None }),
                calendar: None,
                confidential: false,
            };
            prepare_meeting(&c, &mut d).unwrap();
            let back = ical::parse(&d.calendar.as_ref().unwrap().ics).unwrap();
            let b = back.events[0].attendees.iter().find(|x| x.email == B_MAIL).unwrap();
            assert_eq!(b.name.as_deref(), Some(r"Nam; Thái: 'test' \ (x)"), "{to}");
        }
    }

    #[test]
    fn meeting_recipients_with_hostile_names_become_attendees() {
        let c = two_accounts();
        let mut d = crate::smtp::Draft {
            account_id: A_ID.into(),
            to: vec![crate::smtp::format_mailbox(Some("Nam Thái (thnonline), Esq."), B_MAIL)],
            cc: vec![format!("\"Cee, \\\"C\\\"\" <{C_MAIL}>")],
            bcc: vec![],
            subject: "Sync".into(),
            html: "<p>x</p>".into(),
            text: "x".into(),
            in_reply_to: None,
            references: vec![],
            attachments: vec![],
            inline: vec![],
            security: None,
            prebuilt: None,
            meeting: Some(crate::smtp::Meeting { start: ts(2026, 10, 21, 9, 0), end: ts(2026, 10, 21, 10, 0), all_day: false, tzid: None, location: None, rrule: None }),
            calendar: None,
            confidential: false,
        };
        prepare_meeting(&c, &mut d).unwrap();
        let ev = d.calendar.as_ref().unwrap().ics.clone();
        let back = ical::parse(&ev).unwrap();
        let at = &back.events[0].attendees;
        let b = at.iter().find(|x| x.email == B_MAIL).expect("B invited");
        assert_eq!(b.name.as_deref(), Some("Nam Thái (thnonline), Esq."));
        let cc = at.iter().find(|x| x.email == C_MAIL).expect("C invited");
        assert_eq!(cc.name.as_deref(), Some("Cee, 'C'"));
        // and the draft itself still builds into a message
        assert!(crate::smtp::build(&acct(&c, A_ID), &d).is_ok());
    }

    // ---- synced calendars (calsync)

    mod synced {
        use super::*;
        use crate::calsync::store::tests::{conn, rc, setup, ACC};
        use crate::calsync::{store, EventKind, RemoteCalendar, RemoteEvent};

        const T: i64 = 1_800_000_000;

        fn invite_copy(remote: &CalEvent, id: &str, account: &str) -> CalEvent {
            let mut inv = remote.clone();
            inv.id = id.into();
            inv.calendar_id = format!("invites:{account}");
            inv.account_id = Some(account.into());
            inv.remote_id = None;
            inv.etag = None;
            inv.series_id = None;
            inv.remote_kind = None;
            inv.read_only = None;
            inv
        }

        fn shown(c: &Connection) -> Vec<(String, String)> {
            list_range(c, T - 3600, T + 7200).unwrap().into_iter().map(|e| (e.id, e.calendar_id)).collect()
        }

        #[test]
        fn an_invitation_that_is_also_in_a_synced_calendar_shows_once() {
            let c = conn();
            let (_, cal) = setup(&c);
            let mut re = RemoteEvent::single("r1", "Review", T, T + 3600);
            re.uid = "u1@google.com".into();
            let remote = store::upsert_remote(&c, &cal, ACC, &re).unwrap();
            save_row(&c, &invite_copy(&remote, "inv1", ACC)).unwrap();
            // an invitation with another UID, and the same UID in another mailbox, stay
            let mut other = invite_copy(&remote, "inv2", ACC);
            other.uid = "u2@x".into();
            save_row(&c, &other).unwrap();
            let elsewhere = invite_copy(&remote, "inv3", "someone-else");
            save_row(&c, &elsewhere).unwrap();
            let got = shown(&c);
            assert!(got.contains(&(remote.id.clone(), cal.id.clone())), "the synced copy is shown");
            assert!(!got.iter().any(|(id, _)| id == "inv1"), "its invitation copy is hidden: {got:?}");
            assert!(got.iter().any(|(id, _)| id == "inv2") && got.iter().any(|(id, _)| id == "inv3"));
            // the user hid the synced calendar: the invitation shows instead of the event vanishing
            db::set_setting(&c, "cal_hidden", &format!("[\"{}\"]", cal.id)).unwrap();
            let got = shown(&c);
            assert!(got.iter().any(|(id, _)| id == "inv1") && !got.iter().any(|(id, _)| *id == remote.id));
        }

        #[test]
        fn occurrences_without_a_shared_uid_are_matched_by_title_and_start() {
            let c = conn();
            let (_, cal) = setup(&c);
            let mut occ = RemoteEvent::single("o1", "Standup", T, T + 1800);
            occ.kind = EventKind::Occurrence;
            occ.series_id = Some("master".into());
            occ.recurrence_id = Some(T);
            occ.uid = "other-uid".into();
            let remote = store::upsert_remote(&c, &cal, ACC, &occ).unwrap();
            let mut inv = invite_copy(&remote, "invs", ACC);
            inv.uid = "series-uid".into();
            inv.rrule = Some("FREQ=DAILY".into());
            inv.recurrence_id = String::new();
            save_row(&c, &inv).unwrap();
            let got: Vec<(String, i64)> = list_range(&c, T - 60, T + 3 * 86_400).unwrap().into_iter().map(|e| (e.calendar_id, e.start)).collect();
            assert_eq!(got.iter().filter(|(cal_id, start)| *start == T && cal_id.starts_with("google:")).count(), 1);
            assert_eq!(got.iter().filter(|(cal_id, start)| *start == T && cal_id.starts_with("invites:")).count(), 0, "the day the provider lists it, the invitation's instance is hidden");
            assert!(got.iter().any(|(cal_id, start)| cal_id.starts_with("invites:") && *start == T + 86_400), "the other days of the series stay");
        }

        #[test]
        fn the_calendar_list_has_the_synced_calendars_with_colour_label_and_access() {
            let c = conn();
            let (s, _) = setup(&c);
            let mut work = rc("work", "Work");
            work.color = "#d50000".into();
            let holidays = RemoteCalendar { read_only: true, color: String::new(), ..rc("holidays", "Holidays") };
            let off = RemoteCalendar { selected: false, ..rc("off", "Not synced") };
            store::reconcile_calendars(&c, &s, &[rc("primary", "Me"), work, holidays, off]).unwrap();
            let list = list_calendars(&c).unwrap();
            let ids: Vec<&str> = list.iter().map(|x| x.id.as_str()).collect();
            assert_eq!(ids[0], "local");
            assert_eq!(ids[1], format!("invites:{ACC}"));
            let remote: Vec<&CalendarInfo> = list.iter().filter(|x| x.remote).collect();
            assert_eq!(remote.len(), 3, "a calendar whose Sync is off is not in the sidebar");
            let work = remote.iter().find(|x| x.name == "Work · me@gmail.test").unwrap();
            assert_eq!((work.color.as_str(), work.writable, work.service.as_deref(), work.account_id.as_deref()), ("#d50000", true, Some("Google Calendar"), Some(ACC)));
            let hol = remote.iter().find(|x| x.name.starts_with("Holidays")).unwrap();
            assert!(!hol.writable);
            // the visibility checkbox is the same list as for the other calendars
            let work_id = work.id.clone();
            db::set_setting(&c, "cal_hidden", &format!("[\"{work_id}\"]")).unwrap();
            let list = list_calendars(&c).unwrap();
            assert!(!list.iter().find(|x| x.name.starts_with("Work")).unwrap().visible);
            assert!(list.iter().find(|x| x.id == "local").unwrap().writable);
            assert!(!list.iter().find(|x| x.id.starts_with("invites:")).unwrap().writable);
        }

        #[test]
        fn a_new_event_routes_by_the_chosen_calendar_and_an_edit_by_the_events_own() {
            let c = conn();
            let (_, cal) = setup(&c);
            let mk = |id: Option<&str>, calendar: Option<&str>| CalEventInput {
                id: id.map(String::from),
                account_id: None,
                summary: "x".into(),
                start: T,
                end: T + 60,
                all_day: false,
                tzid: None,
                location: None,
                description: None,
                attendees: vec![],
                rrule: None,
                reminder_min: None,
                calendar_id: calendar.map(String::from),
            };
            assert_eq!(remote_calendar_of(&c, &mk(None, Some(&cal.id))), Some(cal.id.clone()));
            assert_eq!(remote_calendar_of(&c, &mk(None, Some("local"))), None);
            assert_eq!(remote_calendar_of(&c, &mk(None, None)), None);
            let (e, _) = save_local(&c, &mk(None, None)).unwrap();
            assert_eq!(remote_calendar_of(&c, &mk(Some(&e.id), Some(&cal.id))), None, "an existing event keeps its own calendar");
            let mut re = RemoteEvent::single("r", "R", T, T + 60);
            re.uid = "r@g".into();
            let remote = store::upsert_remote(&c, &cal, ACC, &re).unwrap();
            assert_eq!(remote_calendar_of(&c, &mk(Some(&remote.id), None)), Some(cal.id.clone()));
        }
    }
}
