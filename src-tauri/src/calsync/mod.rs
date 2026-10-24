//! Calendar sync with a mailbox's online calendars (Google Calendar, Outlook / Microsoft 365, later CalDAV).
//!
//! The layer is provider-agnostic. A provider (`google.rs`, `microsoft.rs`) implements `CalProvider`: it lists the calendars of
//! an account, pulls what changed since a token, and writes single events with a version tag (etag). Everything else is shared:
//!
//! * `store.rs` - the local model: `cal_sources` (one per mailbox and provider, with its status), `calendars` (colour, read-only
//!   flag, sync switch, sync token), remote events as rows of `events` (`calendar_id` = the calendar's id, `remote_id`, `etag`),
//!   and `cal_tombstones` (what was deleted there: a deleted instance of a repeating event keeps its slot hidden).
//! * `engine.rs` - one sync round of a source (calendars, then every calendar's pull applied in one transaction with its new token),
//!   the error states and the back-off, and the scheduler tick that decides which sources are due.
//! * `write.rs` - create / change / delete of a single event: the provider first, the local row from its answer.
//! * `cmds.rs` - the Tauri commands, the consent flow and the worker thread.
//!
//! Rules of the model: the provider is the truth. A pull overwrites the local row (last write wins; the local copy only differs
//! between a write and its confirmation, and a write that loses a race with another device gets `Conflict`, after which the
//! server version is pulled and shown with a note). Repeating events can be changed as a whole, from one occurrence on, or one occurrence at a time
//! (`series.rs`; Google keeps the series as one master, Outlook lists occurrences and its master is fetched when needed). There is no offline queue:
//! a write without a connection fails with `CAL_OFFLINE` and changes nothing.

pub mod caldav;
pub mod cmds;
pub mod dav_xml;
pub mod engine;
pub mod google;
pub mod graph_recur;
pub mod http;
pub mod microsoft;
pub mod series;
pub mod store;
pub mod write;

#[cfg(test)]
pub mod fake;
#[cfg(test)]
pub mod fake_http;

use crate::calendar::{CalAttendee, CalPerson};
use std::time::Duration;

// ------------------------------------------------------------------ kinds

/// The online services Hey Look! can sync a calendar with.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Google,
    Microsoft,
    CalDav,
}

/// The kinds a build offers. A kind that is not listed has no switch in Settings and refuses `calendar_connect`. Keep in sync with
/// `CALENDAR_SYNC_KINDS` in src/calendarSync.ts (a test compares them). Leaving a kind out switches it off (the cut line).
pub const ENABLED_KINDS: [Kind; 3] = [Kind::Google, Kind::Microsoft, Kind::CalDav];

impl Kind {
    /// Value stored in `cal_sources.kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Google => "google",
            Kind::Microsoft => "microsoft",
            Kind::CalDav => "caldav",
        }
    }

    pub fn from_str(s: &str) -> Option<Kind> {
        match s {
            "google" => Some(Kind::Google),
            "microsoft" => Some(Kind::Microsoft),
            "caldav" => Some(Kind::CalDav),
            _ => None,
        }
    }

    /// Prefix of the ids of this kind's calendars (`google:<account>:<calendar>`).
    pub fn prefix(self) -> &'static str {
        match self {
            Kind::Google => "google",
            Kind::Microsoft => "ms",
            Kind::CalDav => "caldav",
        }
    }

    /// The service as the UI names it ("Google Calendar", "Outlook").
    pub fn service(self) -> &'static str {
        match self {
            Kind::Google => "Google Calendar",
            Kind::Microsoft => "Outlook",
            Kind::CalDav => "the calendar server",
        }
    }

    /// The service lists a series occurrence by occurrence, with no master among the events (Outlook); the master is fetched when it is needed.
    pub fn lists_occurrences(self) -> bool {
        self == Kind::Microsoft
    }

    /// Is this kind switched on in this build?
    pub fn enabled(self) -> bool {
        ENABLED_KINDS.contains(&self)
    }

    /// The kind an account can sync, `None` for a mailbox with no calendar service (iCloud, plain IMAP). Gmail by app password counts
    /// as Google (its calendar sign-in is separate from the mail sign-in anyway).
    pub fn for_account(acc: &crate::db::Account) -> Option<Kind> {
        match acc.auth.as_str() {
            "oauth_google" => Some(Kind::Google),
            "oauth_microsoft" => Some(Kind::Microsoft),
            _ if acc.imap_host.eq_ignore_ascii_case("imap.gmail.com") => Some(Kind::Google),
            _ => None,
        }
    }

    pub fn oauth(self) -> Option<crate::oauth::Provider> {
        match self {
            Kind::Google => Some(crate::oauth::Provider::Google),
            Kind::Microsoft => Some(crate::oauth::Provider::Microsoft),
            Kind::CalDav => None,
        }
    }
}

pub fn source_id(account_id: &str, kind: Kind) -> String {
    format!("{account_id}:{}", kind.as_str())
}

pub fn calendar_id(account_id: &str, kind: Kind, remote_id: &str) -> String {
    format!("{}:{account_id}:{remote_id}", kind.prefix())
}

/// True for the id of a synced calendar (not `local`, not `invites:<account>`).
pub fn is_remote_calendar_id(id: &str) -> bool {
    ["google:", "ms:", "caldav:"].iter().any(|p| id.starts_with(p))
}

// ------------------------------------------------------------------ status of a source

pub const OK: &str = "ok";
pub const SYNCING: &str = "syncing";
pub const OFFLINE: &str = "offline";
pub const BUSY: &str = "busy";
/// Access ended (revoked, expired, 7-day test grant): needs `Allow access again`.
pub const AUTH: &str = "auth";
/// The organization does not allow the app.
pub const BLOCKED: &str = "blocked";
/// This build / project cannot use the service (API not enabled, client not registered for it).
pub const NOT_SET_UP: &str = "notsetup";
pub const ERROR: &str = "error";

/// Seconds between two automatic syncs of a source that works.
pub const SYNC_INTERVAL: i64 = 300;
/// First-sync window: events that ended up to a year ago, and events up to two years ahead.
pub const WINDOW_PAST_DAYS: i64 = 365;
pub const WINDOW_FUTURE_DAYS: i64 = 730;
/// Most events one calendar keeps; the rest is not downloaded and the status says so.
pub const MAX_EVENTS_PER_CALENDAR: usize = 25_000;

// ------------------------------------------------------------------ what providers speak

/// One calendar of the account, as the provider describes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteCalendar {
    /// The provider's id of the calendar (Google calendarId, Graph calendar id).
    pub id: String,
    pub name: String,
    /// "#rrggbb", empty when the provider gives none
    pub color: String,
    pub read_only: bool,
    pub primary: bool,
    /// The provider shows it by default (Google `selected`); a new calendar syncs when this is set.
    pub selected: bool,
    pub time_zone: Option<String>,
    /// The calendar's default reminder (minutes before), applied to events that use it.
    pub default_reminder_min: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EventKind {
    /// not part of a series
    Single,
    /// the master of a repeating series (Google: has `recurrence`; carries `rrule` + `exdates`)
    Master,
    /// a changed instance of a series (Google exception, Graph exception)
    Exception,
    /// one occurrence of a series as its own row (Outlook / Microsoft 365: the calendar view lists occurrences)
    Occurrence,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Single => "single",
            EventKind::Master => "master",
            EventKind::Exception => "exception",
            EventKind::Occurrence => "occurrence",
        }
    }
}

/// One event as the provider holds it, already mapped to the local model (UTC seconds, an IANA `tzid`).
#[derive(Clone, Debug)]
pub struct RemoteEvent {
    /// The provider's id of this event (an instance has its own).
    pub id: String,
    /// Version tag for `If-Match`; empty when the provider has none.
    pub etag: String,
    /// iCalendar UID (Google iCalUID, Graph iCalUId); the provider's id when it has none
    pub uid: String,
    /// The provider's own UID when `uid` is a different one worked out from it (Graph: the hex Global Object ID of a meeting from a
    /// service outside Exchange carries the original UID, see `microsoft::original_uid`); kept for the writes that need the provider's.
    pub ext_uid: Option<String>,
    pub kind: EventKind,
    /// the id of the series master (exceptions, occurrences)
    pub series_id: Option<String>,
    /// the original start of an instance of a series
    pub recurrence_id: Option<i64>,
    pub summary: String,
    pub start: i64,
    /// all-day: the UTC midnight of the first day / of the day after the last (end exclusive)
    pub end: i64,
    pub all_day: bool,
    pub tzid: Option<String>,
    pub location: Option<String>,
    pub join_url: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<CalPerson>,
    pub attendees: Vec<CalAttendee>,
    /// RRULE of a master (without the `RRULE:` prefix)
    pub rrule: Option<String>,
    /// the master's own EXDATEs (instants); the engine adds the slots of its exceptions and cancelled instances
    pub exdates: Vec<i64>,
    /// the master's RDATEs (instants): extra dates of the series
    pub rdates: Vec<i64>,
    /// A series master whose repeat rule Hey Look! cannot express (an Outlook pattern outside the mapped set): `rrule` is empty and the rule must be left alone.
    pub pattern_unsupported: bool,
    /// "confirmed" | "tentative" | "cancelled". A cancelled instance (`series_id` + `recurrence_id`) hides its slot; a cancelled
    /// single event or master counts as deleted.
    pub status: String,
    /// "organizer" | "accepted" | "tentative" | "declined" | "needs-action" | None
    pub my_status: Option<String>,
    pub reminder_min: Option<i64>,
    /// the user may change this event (Google: organizer is the user or guests may modify; Graph: `isOrganizer`)
    pub can_edit: bool,
    /// SEQUENCE of the event (CalDAV: the invitations this app sends carry the next one); 0 where the provider keeps no such number
    pub sequence: i64,
    /// when the provider last changed it (UTC seconds), for telling a stale page from a newer deletion
    pub updated: Option<i64>,
}

impl RemoteEvent {
    /// The event as a draft for another calendar of the same or another service (a move that makes a copy and deletes the original). Guests are not carried.
    pub fn as_draft(&self) -> EventDraft {
        EventDraft {
            summary: self.summary.clone(),
            start: self.start,
            end: self.end,
            all_day: self.all_day,
            tzid: self.tzid.clone().or_else(|| (!self.all_day && self.rrule.is_some()).then(|| "UTC".to_string())),
            location: self.location.clone(),
            description: self.description.clone(),
            attendees: vec![],
            reminder_min: self.reminder_min,
            rrule: self.rrule.clone(),
            exdates: self.exdates.clone(),
        }
    }

    /// A plain single event (tests build their events from it).
    #[cfg(test)]
    pub fn single(id: &str, summary: &str, start: i64, end: i64) -> RemoteEvent {
        RemoteEvent {
            id: id.into(),
            etag: String::new(),
            uid: id.into(),
            ext_uid: None,
            kind: EventKind::Single,
            series_id: None,
            recurrence_id: None,
            summary: summary.into(),
            start,
            end,
            all_day: false,
            tzid: None,
            location: None,
            join_url: None,
            description: None,
            organizer: None,
            attendees: vec![],
            rrule: None,
            exdates: vec![],
            rdates: vec![],
            pattern_unsupported: false,
            status: "confirmed".into(),
            my_status: None,
            reminder_min: None,
            can_edit: true,
            sequence: 0,
            updated: None,
        }
    }
}

/// A new event to create at the provider.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EventDraft {
    pub summary: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub tzid: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    /// guests (never the user); the provider sends the invitations
    pub attendees: Vec<CalAttendee>,
    pub reminder_min: Option<i64>,
    /// RRULE (without the prefix) of a repeating event to create
    pub rrule: Option<String>,
    /// slots of the rule that are deleted from the start (a series that begins partway through an older one: CalDAV and Google write them with the rule)
    pub exdates: Vec<i64>,
}

/// The fields of an event that changed; `None` = leave as it is. The attendee list, when it changed, is the whole new list
/// (Google replaces arrays as a whole).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EventPatch {
    pub summary: Option<String>,
    /// start, end, all_day and tzid travel together: the new time of the event
    pub when: Option<When>,
    pub location: Option<Option<String>>,
    pub description: Option<Option<String>>,
    pub attendees: Option<Vec<CalAttendee>>,
    pub reminder_min: Option<Option<i64>>,
    /// the repeat rule of a series, with the extra dates it keeps; sent whole
    pub recurrence: Option<Recurrence>,
}

/// The recurrence of a series master as a write sends it. The service applies its own rules to the occurrences it already has.
#[derive(Clone, Debug, PartialEq)]
pub struct Recurrence {
    /// the rule without the `RRULE:` prefix; `None` makes the series a single event
    pub rrule: Option<String>,
    /// dates of the series that do not happen (EXDATE)
    pub exdates: Vec<i64>,
    /// extra dates (RDATE)
    pub rdates: Vec<i64>,
    /// the first occurrence as the series will have it after the write (a service that keeps the rule with the start needs it)
    pub start: i64,
    pub all_day: bool,
    pub tzid: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct When {
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub tzid: Option<String>,
}

impl EventPatch {
    pub fn is_empty(&self) -> bool {
        *self == EventPatch::default()
    }
}

/// An answer to an invitation, mirrored silently to the provider.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rsvp {
    Accepted,
    Tentative,
    Declined,
}

impl Rsvp {
    pub fn from_partstat(s: &str) -> Option<Rsvp> {
        match s {
            "accepted" => Some(Rsvp::Accepted),
            "tentative" => Some(Rsvp::Tentative),
            "declined" => Some(Rsvp::Declined),
            _ => None,
        }
    }
}

/// A resource of a CalDAV server as it was downloaded: its address, version tag, UID and the server's own iCalendar text (the source of later writes, D-7.4f).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RawResource {
    pub href: String,
    pub etag: String,
    pub uid: String,
    pub raw: String,
}

/// What to pull for one calendar.
#[derive(Clone, Debug)]
pub struct PullReq {
    /// The token of the last successful pull (Google syncToken, Graph deltaLink); `None` = download everything in the window.
    pub state: Option<String>,
    /// The window of a full download (UTC seconds): `now - 365 days` .. `now + 730 days`. Ignored while `state` is set.
    pub window_from: i64,
    /// (Google reads everything after `window_from`; a provider whose delta covers a window, like Graph, uses both ends)
    pub window_to: i64,
    /// The resources the app already has with their version tags (address, etag), for a provider that has to compare (CalDAV without sync tokens); `None` for the others.
    pub known: Option<Vec<(String, String)>>,
}

/// The answer of a pull. `upserts` and `removed` are applied together with `next_state`.
#[derive(Clone, Debug, Default)]
pub struct Pull {
    pub upserts: Vec<RemoteEvent>,
    /// provider ids of events deleted there
    pub removed: Vec<String>,
    /// the token for the next pull; `None` = the provider has no incremental sync (every pull is a full one)
    pub next_state: Option<String>,
    /// `upserts` is the complete content of the window: events that are not in it are deleted locally
    pub full: bool,
    /// more than `MAX_EVENTS_PER_CALENDAR` events: the rest was not downloaded
    pub truncated: bool,
    /// CalDAV: the resources that were downloaded again: every row of such a resource (the master, its overrides) is replaced by what `upserts` holds for it
    pub replace: Vec<String>,
    /// CalDAV: the iCalendar text of the resources in `replace`, kept for later writes (`cal_resources`); `removed` resources are forgotten there
    pub resources: Vec<RawResource>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SyncErr {
    /// access ended: refresh token revoked / expired, 401 after a fresh token, insufficient scope
    Auth,
    /// the organization does not allow the app (text from the provider)
    Blocked(String),
    /// the API / client is not set up for this (text from the provider)
    NotSetUp(String),
    /// 412: the event changed on the server since the etag
    Conflict,
    /// 403: the server says the calendar (or the event) cannot be changed by this user
    ReadOnly,
    /// the grant lacks a permission that making a calendar needs (Google): allow access again; the source itself keeps working
    NeedsScope,
    /// 410: the sync token is no longer valid, download everything again
    Gone,
    /// 404: the event (or the calendar) does not exist (any more)
    NotFound,
    /// 429, quota 403, 5xx: try again later (after the given time when the server said so)
    RateLimited(Option<Duration>),
    /// no connection
    Offline,
    Other(String),
}

impl std::fmt::Display for SyncErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncErr::Auth => write!(f, "access ended"),
            SyncErr::Blocked(t) => write!(f, "blocked: {t}"),
            SyncErr::NotSetUp(t) => write!(f, "not set up: {t}"),
            SyncErr::Conflict => write!(f, "the event changed on the server"),
            SyncErr::ReadOnly => write!(f, "read only"),
            SyncErr::NeedsScope => write!(f, "more permission is needed"),
            SyncErr::Gone => write!(f, "the sync token expired"),
            SyncErr::NotFound => write!(f, "not found"),
            SyncErr::RateLimited(Some(d)) => write!(f, "busy, retry in {} s", d.as_secs()),
            SyncErr::RateLimited(None) => write!(f, "busy"),
            SyncErr::Offline => write!(f, "no connection"),
            SyncErr::Other(t) => write!(f, "{t}"),
        }
    }
}

impl From<crate::oauth::TokenFail> for SyncErr {
    fn from(f: crate::oauth::TokenFail) -> SyncErr {
        use crate::oauth::TokenFail as T;
        match f {
            T::Revoked(_) | T::Missing(_) => SyncErr::Auth,
            T::Blocked(t) => SyncErr::Blocked(t),
            T::NotSetUp(t) => SyncErr::NotSetUp(t),
            T::Offline(_) => SyncErr::Offline,
            T::Other(t) => SyncErr::Other(t),
        }
    }
}

/// The calendar list of an account as a provider answers it: the whole list (`full`), or only what changed since `state`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CalList {
    /// the calendars of a full list; in an incremental answer the new and the changed ones
    pub calendars: Vec<RemoteCalendar>,
    /// provider ids of calendars that are gone (incremental answers only)
    pub removed: Vec<String>,
    /// `calendars` is the complete list: calendars that are not in it are gone
    pub full: bool,
    /// the token for the next call; `None` = the provider has no incremental list
    pub next_state: Option<String>,
}

/// A calendar service. Calls are blocking and run on worker threads, never under the database lock. Every call is one account's
/// own credentials (the provider fetches its access token itself, so a token that expires mid-round is refreshed).
pub trait CalProvider: Send {
    /// All calendars of the account with their access level.
    fn list_calendars(&self) -> Result<Vec<RemoteCalendar>, SyncErr>;
    /// The list again, only what changed since `state` when the provider can say (Google `syncToken`); `Gone` = the token is no longer valid.
    /// The default asks for the whole list every time (Microsoft: a small list without a delta).
    fn list_calendars_since(&self, _state: Option<&str>) -> Result<CalList, SyncErr> {
        Ok(CalList { calendars: self.list_calendars()?, removed: vec![], full: true, next_state: None })
    }
    /// What changed in `cal` since `req.state` (or everything in the window). Pages are the provider's business.
    fn pull(&self, cal: &RemoteCalendar, req: &PullReq) -> Result<Pull, SyncErr>;
    /// Create a single event; the provider sends the invitations to the guests. Returns the event as stored (with its etag).
    fn create(&self, cal: &RemoteCalendar, ev: &EventDraft) -> Result<RemoteEvent, SyncErr>;
    /// Change the given fields of an event if its etag still matches (`Conflict` otherwise). Returns the stored event.
    fn update(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, changed: &EventPatch) -> Result<RemoteEvent, SyncErr>;
    /// Delete an event if its etag still matches. `NotFound` means it is gone already.
    fn delete(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str) -> Result<(), SyncErr>;
    /// Set the user's own answer on an event without telling the organizer again (the iMIP reply is sent by the app).
    /// `attendees` is the event's stored guest list with the user's answer already set.
    fn respond(&self, cal: &RemoteCalendar, remote_id: &str, etag: &str, status: Rsvp, me: &str, attendees: &[CalAttendee]) -> Result<(), SyncErr>;
    /// The provider compares version tags itself and wants the ones the app has (`PullReq::known`): CalDAV.
    fn wants_known_etags(&self) -> bool {
        false
    }
    /// Delta tokens that only cover a window (Microsoft): download everything again when the window started more than this many
    /// days ago. `None` = never.
    fn rebaseline_after_days(&self) -> Option<i64> {
        None
    }
    /// Change one occurrence of a series that the service keeps as one event (Google): finds the instance that starts at `original_start` and changes it (the
    /// service creates the exception). Returns the instance as stored (kind `Exception`).
    fn update_occurrence(&self, _cal: &RemoteCalendar, _series_id: &str, _original_start: i64, _all_day: bool, _changed: &EventPatch) -> Result<RemoteEvent, SyncErr> {
        Err(SyncErr::NotSetUp("changing one occurrence is not part of this service".into()))
    }
    /// Delete one occurrence of such a series; returns the provider id of the instance that was deleted.
    fn delete_occurrence(&self, _cal: &RemoteCalendar, _series_id: &str, _original_start: i64, _all_day: bool) -> Result<String, SyncErr> {
        Err(SyncErr::NotSetUp("deleting one occurrence is not part of this service".into()))
    }
    /// Move an event (a whole series moves as one) to another calendar of the same account. Returns the event as it is in the target. Services without a move make a copy and delete the original.
    fn move_event(&self, _cal: &RemoteCalendar, _remote_id: &str, _etag: &str, _target: &RemoteCalendar) -> Result<RemoteEvent, SyncErr> {
        Err(SyncErr::NotSetUp("moving an event is not part of this service".into()))
    }
    /// Make a calendar with this name in the account. Returns it as the service lists it.
    fn create_calendar(&self, _name: &str) -> Result<RemoteCalendar, SyncErr> {
        Err(SyncErr::NotSetUp("making a calendar is not part of this service".into()))
    }
    /// The series master as the service has it now (its own EXDATEs and RDATEs, the repeat rule, the version tag).
    fn get_series(&self, _cal: &RemoteCalendar, _series_id: &str) -> Result<RemoteEvent, SyncErr> {
        Err(SyncErr::NotSetUp("series are not part of this service".into()))
    }
}

/// Builds the provider of a source (its credentials come from the app). The app's factory lives in `cmds.rs`; tests use `fake.rs`.
pub trait ProviderFactory: Send + Sync {
    fn provider(&self, source: &store::Source) -> Result<Box<dyn CalProvider>, SyncErr>;
}

// ------------------------------------------------------------------ sync requests

static REQUESTED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Ask for a sync of a mailbox's calendars soon (`Sync now`, after a write, when the Calendar view opens). The worker takes it at its
/// next tick (every few seconds).
pub fn request_sync(account_id: &str) {
    let mut g = REQUESTED.lock().unwrap_or_else(|p| p.into_inner());
    if !g.iter().any(|a| a == account_id) {
        g.push(account_id.to_string());
    }
}

pub fn take_requests() -> std::collections::HashSet<String> {
    std::mem::take(&mut *REQUESTED.lock().unwrap_or_else(|p| p.into_inner())).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_have_stable_names_and_ids() {
        for k in [Kind::Google, Kind::Microsoft, Kind::CalDav] {
            assert_eq!(Kind::from_str(k.as_str()), Some(k));
        }
        assert_eq!(source_id("acc", Kind::Google), "acc:google");
        assert_eq!(calendar_id("acc", Kind::Google, "me@x.y"), "google:acc:me@x.y");
        assert_eq!(calendar_id("acc", Kind::Microsoft, "AAMk"), "ms:acc:AAMk");
        assert!(is_remote_calendar_id("google:a:b") && is_remote_calendar_id("ms:a:b"));
        assert!(!is_remote_calendar_id("local") && !is_remote_calendar_id("invites:google:x"));
    }

    #[test]
    fn requests_are_deduplicated_and_drained() {
        // (the queue is process-wide and the write tests of the providers also ask for a sync: look at this test's own ids only)
        request_sync("queue-a");
        request_sync("queue-a");
        request_sync("queue-b");
        assert_eq!(REQUESTED.lock().unwrap().iter().filter(|x| x.starts_with("queue-")).count(), 2, "asking twice queues once");
        let got = take_requests();
        assert!(got.contains("queue-a") && got.contains("queue-b"));
        assert!(!take_requests().iter().any(|x| x.starts_with("queue-")));
    }

    #[test]
    fn enabled_kinds_match_the_frontend_list() {
        let ts = include_str!("../../../src/calendarSync.ts");
        let start = ts.find("export const CALENDAR_SYNC_KINDS").expect("CALENDAR_SYNC_KINDS in calendarSync.ts");
        let line = ts[start..].lines().next().unwrap();
        let found: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
        let ours: Vec<&str> = ENABLED_KINDS.iter().map(|k| k.as_str()).collect();
        assert_eq!(found, ours);
    }

    #[test]
    fn the_google_calendar_creation_switch_matches_the_frontend() {
        let ts = include_str!("../../../src/calendarSync.ts");
        let line = ts.lines().find(|l| l.starts_with("export const GOOGLE_CREATE_CALENDARS")).expect("GOOGLE_CREATE_CALENDARS in calendarSync.ts");
        assert_eq!(line.contains("= true"), crate::oauth::GOOGLE_CREATE_CALENDARS, "{line}");
        // the scope is only asked for when the switch is on
        assert_eq!(crate::oauth::Provider::Google.scope_for(crate::oauth::Purpose::Calendar).contains("calendar.app.created"), crate::oauth::GOOGLE_CREATE_CALENDARS);
    }

    #[test]
    fn only_google_and_microsoft_mailboxes_have_a_calendar() {
        let acc = |auth: &str, host: &str| crate::db::Account {
            id: "a".into(),
            email: "a@b.c".into(),
            display_name: "A".into(),
            imap_host: host.into(),
            imap_port: 993,
            imap_ssl: true,
            smtp_host: "s".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            username: "a".into(),
            auth: auth.into(),
            color: None,
            smtp_username: String::new(),
            tls_insecure: false,
            reply_to: String::new(),
        };
        assert_eq!(Kind::for_account(&acc("oauth_google", "imap.gmail.com")), Some(Kind::Google));
        assert_eq!(Kind::for_account(&acc("password", "IMAP.gmail.com")), Some(Kind::Google));
        assert_eq!(Kind::for_account(&acc("oauth_microsoft", "outlook.office365.com")), Some(Kind::Microsoft));
        assert_eq!(Kind::for_account(&acc("password", "imap.mail.me.com")), None);
        assert_eq!(Kind::for_account(&acc("password", "mail.example.com")), None);
    }
}
