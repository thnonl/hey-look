//! The local model of calendar sync: sources, calendars, tombstones and the rows of remote events.
use super::{EventKind, Kind, Pull, RemoteCalendar, RemoteEvent};
use crate::calendar::{self, CalEvent, CalPerson, COLS};
use crate::db::{err, R};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};

/// Tombstones of plain events are only kept to ignore a stale page; instances of a series are kept for as long as the series.
const TOMBSTONE_KEEP_SECS: i64 = 30 * 86_400;

// ------------------------------------------------------------------ read-only reasons

/// `events.read_only`: 0 editable, 1 read-only calendar, 2 repeating, 3 organized by someone else.
pub fn read_only_code(reason: Option<&str>) -> i64 {
    match reason {
        Some("calendar") => 1,
        Some("repeating") => 2,
        Some("organizer") => 3,
        _ => 0,
    }
}

pub fn read_only_reason(code: i64) -> Option<String> {
    match code {
        1 => Some("calendar".into()),
        2 => Some("repeating".into()),
        3 => Some("organizer".into()),
        _ => None,
    }
}

// ------------------------------------------------------------------ sources

#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub id: String,
    pub account_id: String,
    pub kind: Kind,
    pub status: String,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
    pub retry_at: Option<i64>,
    pub fail_count: i64,
    pub connected_at: i64,
    /// the token of the provider's calendar list (Google `nextSyncToken`); `None` = ask for the whole list
    pub list_state: Option<String>,
}

const SOURCE_COLS: &str = "id,account_id,kind,status,last_sync,last_error,retry_at,fail_count,connected_at,list_state";

fn row_source(r: &rusqlite::Row) -> rusqlite::Result<Source> {
    let kind: String = r.get(2)?;
    Ok(Source {
        id: r.get(0)?,
        account_id: r.get(1)?,
        kind: Kind::from_str(&kind).unwrap_or(Kind::Google),
        status: r.get(3)?,
        last_sync: r.get(4)?,
        last_error: r.get(5)?,
        retry_at: r.get(6)?,
        fail_count: r.get(7)?,
        connected_at: r.get(8)?,
        list_state: r.get(9)?,
    })
}

pub fn get_source(c: &Connection, id: &str) -> Option<Source> {
    c.query_row(&format!("SELECT {SOURCE_COLS} FROM cal_sources WHERE id=?1"), [id], row_source).optional().ok().flatten()
}

pub fn source_of_account(c: &Connection, account_id: &str) -> Option<Source> {
    c.query_row(&format!("SELECT {SOURCE_COLS} FROM cal_sources WHERE account_id=?1 ORDER BY connected_at LIMIT 1"), [account_id], row_source)
        .optional()
        .ok()
        .flatten()
}

pub fn list_sources(c: &Connection) -> R<Vec<Source>> {
    let mut st = c.prepare(&format!("SELECT {SOURCE_COLS} FROM cal_sources ORDER BY connected_at, id")).map_err(err)?;
    let rows = st.query_map([], row_source).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(rows)
}

/// Start syncing a mailbox's calendars: the source is there, the first round is due at once. Starting again (access allowed again)
/// keeps the calendars and events and only clears the error.
pub fn create_source(c: &Connection, account_id: &str, kind: Kind, now: i64) -> R<Source> {
    let id = super::source_id(account_id, kind);
    c.execute(
        "INSERT INTO cal_sources(id,account_id,kind,status,connected_at) VALUES(?1,?2,?3,'syncing',?4)
         ON CONFLICT(id) DO UPDATE SET status='syncing', last_error=NULL, retry_at=NULL, fail_count=0",
        params![id, account_id, kind.as_str(), now],
    )
    .map_err(err)?;
    get_source(c, &id).ok_or_else(|| "calendar source missing".to_string())
}

pub fn set_status(c: &Connection, id: &str, status: &str, error: Option<&str>, retry_at: Option<i64>, fail_count: i64) -> R<()> {
    c.execute("UPDATE cal_sources SET status=?2, last_error=?3, retry_at=?4, fail_count=?5 WHERE id=?1", params![id, status, error, retry_at, fail_count]).map_err(err)?;
    Ok(())
}

pub fn set_list_state(c: &Connection, id: &str, state: Option<&str>) -> R<()> {
    c.execute("UPDATE cal_sources SET list_state=?2 WHERE id=?1", params![id, state]).map_err(err)?;
    Ok(())
}

pub fn mark_synced(c: &Connection, id: &str, now: i64) -> R<()> {
    c.execute("UPDATE cal_sources SET status='ok', last_sync=?2, last_error=NULL, retry_at=NULL, fail_count=0 WHERE id=?1", params![id, now]).map_err(err)?;
    Ok(())
}

/// A round that was running when the app ended: due again at once.
pub fn reset_syncing(c: &Connection) -> R<()> {
    c.execute("UPDATE cal_sources SET status='ok', last_sync=0 WHERE status='syncing' AND last_sync IS NOT NULL", []).map_err(err)?;
    Ok(())
}

/// "Not set up" is what the build or the service said at the last round (no OAuth client in this build, the Calendar API off in the project, an
/// unregistered client). It waits for the user in the normal run, but a new start may have changed the cause (a build with a client, the API
/// switched on), and the card offers neither Sync now nor Allow access again for it (D-061): so a start gives the source one new round. It
/// ends in "not set up" again with the current text when nothing changed.
pub fn retry_not_set_up(c: &Connection) -> R<()> {
    c.execute("UPDATE cal_sources SET status='ok', last_error=NULL, retry_at=NULL, fail_count=0, last_sync=0 WHERE status='notsetup' AND last_sync IS NOT NULL", []).map_err(err)?;
    c.execute("UPDATE cal_sources SET status='syncing', last_error=NULL, retry_at=NULL, fail_count=0 WHERE status='notsetup' AND last_sync IS NULL", []).map_err(err)?;
    Ok(())
}

// ------------------------------------------------------------------ calendars

#[derive(Clone, Debug, PartialEq)]
pub struct CalRow {
    pub id: String,
    pub source_id: String,
    pub remote_id: String,
    pub name: String,
    pub color: String,
    pub read_only: bool,
    pub primary: bool,
    pub sync_on: bool,
    pub sync_state: Option<String>,
    pub time_zone: Option<String>,
    pub default_reminder_min: Option<i64>,
    pub event_count: i64,
    pub truncated: bool,
    pub window_from: Option<i64>,
    /// when the calendar was last downloaded in full (a calendar over the event cap is downloaded in full at most once a day)
    pub full_at: Option<i64>,
}

impl CalRow {
    pub fn remote(&self) -> RemoteCalendar {
        RemoteCalendar {
            id: self.remote_id.clone(),
            name: self.name.clone(),
            color: self.color.clone(),
            read_only: self.read_only,
            primary: self.primary,
            selected: self.sync_on,
            time_zone: self.time_zone.clone(),
            default_reminder_min: self.default_reminder_min,
        }
    }
}

const CAL_COLS: &str = "id,source_id,remote_id,name,color,read_only,is_primary,sync_on,sync_state,time_zone,default_reminder_min,event_count,truncated,window_from,full_at";

fn row_cal(r: &rusqlite::Row) -> rusqlite::Result<CalRow> {
    Ok(CalRow {
        id: r.get(0)?,
        source_id: r.get(1)?,
        remote_id: r.get(2)?,
        name: r.get(3)?,
        color: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
        read_only: r.get::<_, i64>(5)? != 0,
        primary: r.get::<_, i64>(6)? != 0,
        sync_on: r.get::<_, i64>(7)? != 0,
        sync_state: r.get(8)?,
        time_zone: r.get(9)?,
        default_reminder_min: r.get(10)?,
        event_count: r.get(11)?,
        truncated: r.get::<_, i64>(12)? != 0,
        window_from: r.get(13)?,
        full_at: r.get(14)?,
    })
}

pub fn calendars_of(c: &Connection, source_id: &str) -> R<Vec<CalRow>> {
    let mut st = c.prepare(&format!("SELECT {CAL_COLS} FROM calendars WHERE source_id=?1 ORDER BY is_primary DESC, name COLLATE NOCASE, id")).map_err(err)?;
    let rows = st.query_map([source_id], row_cal).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(rows)
}

pub fn get_calendar(c: &Connection, id: &str) -> Option<CalRow> {
    c.query_row(&format!("SELECT {CAL_COLS} FROM calendars WHERE id=?1"), [id], row_cal).optional().ok().flatten()
}

pub fn all_calendar_ids(c: &Connection) -> HashSet<String> {
    let Ok(mut st) = c.prepare("SELECT id FROM calendars") else { return HashSet::new() };
    st.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.filter_map(|r| r.ok()).collect()).unwrap_or_default()
}

/// Make the local calendars match the provider's list. A new calendar syncs when the provider shows it by default (or it is the
/// primary one); a calendar the user switched off stays off; a calendar that is gone is removed with its events. Returns whether
/// anything changed.
pub fn reconcile_calendars(c: &Connection, src: &Source, remote: &[RemoteCalendar]) -> R<bool> {
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut changed = false;
    let have: HashMap<String, CalRow> = calendars_of(&tx, &src.id)?.into_iter().map(|r| (r.remote_id.clone(), r)).collect();
    let mut seen = HashSet::new();
    for rc in remote {
        seen.insert(rc.id.clone());
        changed |= upsert_calendar(&tx, src, have.get(&rc.id), rc)?;
    }
    for (rid, old) in have.iter().filter(|(rid, _)| !seen.contains(*rid)) {
        let _ = rid;
        drop_calendar(&tx, &old.id)?;
        changed = true;
    }
    tx.commit().map_err(err)?;
    Ok(changed)
}

/// An incremental calendar list (W7.6): the entries that are new or changed are stored like a full list stores them, the ones that are gone
/// go with their events. Returns whether anything changed.
pub fn apply_calendar_delta(c: &Connection, src: &Source, changed_entries: &[RemoteCalendar], removed: &[String]) -> R<bool> {
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut changed = false;
    let have: HashMap<String, CalRow> = calendars_of(&tx, &src.id)?.into_iter().map(|r| (r.remote_id.clone(), r)).collect();
    for rc in changed_entries {
        changed |= upsert_calendar(&tx, src, have.get(&rc.id), rc)?;
    }
    for rid in removed {
        if let Some(old) = have.get(rid) {
            drop_calendar(&tx, &old.id)?;
            changed = true;
        }
    }
    tx.commit().map_err(err)?;
    Ok(changed)
}

/// Store one calendar of the provider's list: insert it, or update the row when something about it changed. Returns whether it did.
fn upsert_calendar(tx: &Connection, src: &Source, old: Option<&CalRow>, rc: &RemoteCalendar) -> R<bool> {
    let id = super::calendar_id(&src.account_id, src.kind, &rc.id);
    match old {
        Some(old) => {
            let same = old.name == rc.name
                && old.color == rc.color
                && old.read_only == rc.read_only
                && old.primary == rc.primary
                && old.time_zone == rc.time_zone
                && old.default_reminder_min == rc.default_reminder_min;
            if same {
                return Ok(false);
            }
            tx.execute(
                "UPDATE calendars SET name=?2, color=?3, read_only=?4, is_primary=?5, time_zone=?6, default_reminder_min=?7 WHERE id=?1",
                params![id, rc.name, rc.color, rc.read_only as i64, rc.primary as i64, rc.time_zone, rc.default_reminder_min],
            )
            .map_err(err)?;
            if old.read_only != rc.read_only {
                if rc.read_only {
                    tx.execute("UPDATE events SET read_only=1 WHERE calendar_id=?1", [&id]).map_err(err)?;
                } else {
                    // which events are editable is decided per event: download the calendar again
                    tx.execute("UPDATE calendars SET sync_state=NULL, full_at=NULL WHERE id=?1", [&id]).map_err(err)?;
                }
            }
            Ok(true)
        }
        None => {
            tx.execute(
                "INSERT INTO calendars(id,source_id,remote_id,name,color,read_only,is_primary,sync_on,time_zone,default_reminder_min)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![id, src.id, rc.id, rc.name, rc.color, rc.read_only as i64, rc.primary as i64, (rc.selected || rc.primary) as i64, rc.time_zone, rc.default_reminder_min],
            )
            .map_err(err)?;
            Ok(true)
        }
    }
}

pub fn drop_calendar(c: &Connection, id: &str) -> R<()> {
    c.execute("DELETE FROM events WHERE calendar_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM cal_tombstones WHERE calendar_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM calendars WHERE id=?1", [id]).map_err(err)?;
    Ok(())
}

/// The per-calendar `Sync` switch. Off: the calendar's events leave this computer now and its sync token is forgotten; on: it is
/// downloaded at the next round.
pub fn set_calendar_sync(c: &Connection, id: &str, on: bool) -> R<()> {
    let n = c.execute("UPDATE calendars SET sync_on=?2 WHERE id=?1", params![id, on as i64]).map_err(err)?;
    if n == 0 {
        return Err("calendar not found".into());
    }
    if !on {
        clear_events(c, id)?;
    }
    Ok(())
}

/// Drop the events, tombstones and token of a calendar that stays in the list.
pub fn clear_events(c: &Connection, id: &str) -> R<()> {
    c.execute("DELETE FROM events WHERE calendar_id=?1", [id]).map_err(err)?;
    c.execute("DELETE FROM cal_tombstones WHERE calendar_id=?1", [id]).map_err(err)?;
    c.execute("UPDATE calendars SET sync_state=NULL, event_count=0, truncated=0, window_from=NULL, full_at=NULL WHERE id=?1", [id]).map_err(err)?;
    Ok(())
}

// ------------------------------------------------------------------ removing

fn drop_hidden(c: &Connection, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let Some(raw) = crate::db::get_setting(c, "cal_hidden") else { return };
    let Ok(list) = serde_json::from_str::<Vec<String>>(&raw) else { return };
    let kept: Vec<&String> = list.iter().filter(|k| !ids.contains(k)).collect();
    if kept.len() != list.len() {
        let _ = crate::db::set_setting(c, "cal_hidden", &serde_json::to_string(&kept).unwrap_or_else(|_| "[]".into()));
    }
}

/// Stop syncing a source: its calendars, events, tombstones and the source row go; nothing changes on the server.
pub fn disconnect(c: &Connection, source_id: &str) -> R<()> {
    let ids: Vec<String> = calendars_of(c, source_id)?.into_iter().map(|r| r.id).collect();
    for id in &ids {
        drop_calendar(c, id)?;
    }
    c.execute("DELETE FROM cal_sources WHERE id=?1", [source_id]).map_err(err)?;
    drop_hidden(c, &ids);
    Ok(())
}

/// A mailbox is removed: everything of its calendar sync goes.
pub fn forget_account(c: &Connection, account_id: &str) -> R<()> {
    let ids: Vec<String> = {
        let mut st = c.prepare("SELECT id FROM cal_sources WHERE account_id=?1").map_err(err)?;
        let rows = st.query_map([account_id], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
        rows
    };
    for id in ids {
        disconnect(c, &id)?;
    }
    Ok(())
}

/// Leftovers: sources of a mailbox that is gone, calendars without a source, tombstones without a calendar, events of a calendar
/// that no longer exists. Returns how many rows went.
pub fn prune_orphans(c: &Connection) -> R<usize> {
    let mut n = 0;
    let gone: Vec<String> = {
        let mut st = c.prepare("SELECT id FROM cal_sources WHERE account_id NOT IN (SELECT id FROM accounts)").map_err(err)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
        rows
    };
    for id in &gone {
        disconnect(c, id)?;
        n += 1;
    }
    for sql in [
        "DELETE FROM calendars WHERE source_id NOT IN (SELECT id FROM cal_sources)",
        "DELETE FROM cal_tombstones WHERE calendar_id NOT IN (SELECT id FROM calendars)",
        "DELETE FROM events WHERE remote_id IS NOT NULL AND calendar_id NOT IN (SELECT id FROM calendars)",
    ] {
        n += c.execute(sql, []).map_err(err)?;
    }
    Ok(n)
}

// ------------------------------------------------------------------ remote events

/// Why an event of this calendar cannot be changed in Hey Look!, `None` when it can.
fn read_only_for(cal: &CalRow, re: &RemoteEvent) -> Option<String> {
    if cal.read_only {
        Some("calendar".into())
    } else if re.rrule.is_some() || re.kind != EventKind::Single {
        Some("repeating".into())
    } else if !re.can_edit {
        Some("organizer".into())
    } else {
        None
    }
}

/// The local row for a remote event. `id` is the id of the row it replaces (a new id for a new event).
pub fn event_from_remote(cal: &CalRow, account_id: &str, re: &RemoteEvent, id: String, old: Option<&CalEvent>) -> CalEvent {
    let instance = matches!(re.kind, EventKind::Exception | EventKind::Occurrence);
    let recurrence_id = if instance { re.recurrence_id.unwrap_or(re.start).to_string() } else { String::new() };
    let tzid = re.tzid.clone().filter(|t| crate::ical::iana_for(t).is_some());
    let rrule = re.rrule.clone().filter(|r| !r.trim().is_empty());
    CalEvent {
        id,
        uid: if re.uid.is_empty() { re.id.clone() } else { re.uid.clone() },
        calendar_id: cal.id.clone(),
        account_id: Some(account_id.to_string()),
        summary: if re.summary.trim().is_empty() { "(No title)".into() } else { re.summary.clone() },
        start: re.start,
        end: re.end.max(re.start),
        all_day: re.all_day,
        tzid,
        location: re.location.clone().filter(|s| !s.trim().is_empty()),
        join_url: re.join_url.clone().filter(|s| !s.trim().is_empty()),
        description: re.description.clone().filter(|s| !s.trim().is_empty()),
        organizer: re.organizer.as_ref().map(|o| CalPerson { email: o.email.clone(), name: o.name.clone() }),
        attendees: re.attendees.clone(),
        recurrence_text: rrule.as_deref().and_then(|r| crate::ical::describe_rrule(r, re.start)),
        rrule,
        status: if re.status.is_empty() { "confirmed".into() } else { re.status.clone() },
        my_status: re.my_status.clone(),
        responded_at: old.and_then(|o| o.responded_at),
        reminder_min: re.reminder_min,
        source_message_id: None,
        sequence: 0,
        confidential: false,
        instance_start: None,
        read_only: read_only_for(cal, re),
        remote_id: Some(re.id.clone()),
        etag: Some(re.etag.clone()).filter(|e| !e.is_empty()),
        series_id: re.series_id.clone(),
        remote_kind: Some(re.kind.as_str().to_string()),
        recurrence_id,
        exdates: re.exdates.clone(),
        has_rdates: !re.rdates.is_empty(),
        rdates: re.rdates.clone(),
        prev: None,
    }
}

fn find_remote(c: &Connection, cal_id: &str, remote_id: &str) -> Option<CalEvent> {
    c.query_row(&format!("SELECT {COLS} FROM events WHERE calendar_id=?1 AND remote_id=?2"), params![cal_id, remote_id], calendar::row_event).optional().ok().flatten()
}

/// Store one remote event (create or replace by `(calendar, remote id)`). Used for the answer of a write and by `apply_pull`.
pub fn upsert_remote(c: &Connection, cal: &CalRow, account_id: &str, re: &RemoteEvent) -> R<CalEvent> {
    let old = find_remote(c, &cal.id, &re.id);
    let id = old.as_ref().map(|o| o.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let e = event_from_remote(cal, account_id, re, id, old.as_ref());
    calendar::save_row(c, &e)?;
    Ok(e)
}

fn tombstone(c: &Connection, cal_id: &str, remote_id: &str, series: Option<&str>, rec: Option<i64>, now: i64) -> R<()> {
    c.execute(
        "INSERT OR REPLACE INTO cal_tombstones(calendar_id,remote_id,series_id,recurrence_id,deleted_at) VALUES(?1,?2,?3,?4,?5)",
        params![cal_id, remote_id, series, rec, now],
    )
    .map_err(err)?;
    Ok(())
}

/// The event is deleted at the provider (or we just deleted it there): the row goes, a tombstone stays. A deleted instance of a
/// series keeps its slot hidden through its tombstone; a deleted series takes its instances along.
pub fn remove_remote(c: &Connection, cal_id: &str, remote_id: &str, now: i64) -> R<bool> {
    let mut changed = false;
    if let Some(old) = find_remote(c, cal_id, remote_id) {
        c.execute("DELETE FROM events WHERE id=?1", [&old.id]).map_err(err)?;
        let rec = old.recurrence_id.parse::<i64>().ok();
        match (&old.series_id, rec) {
            (Some(s), Some(r)) => tombstone(c, cal_id, remote_id, Some(s), Some(r), now)?,
            _ => tombstone(c, cal_id, remote_id, None, None, now)?,
        }
        changed = true;
    } else {
        tombstone(c, cal_id, remote_id, None, None, now)?;
    }
    // a series that goes takes its instances and their tombstones along
    changed |= c.execute("DELETE FROM events WHERE calendar_id=?1 AND series_id=?2", params![cal_id, remote_id]).map_err(err)? > 0;
    c.execute("DELETE FROM cal_tombstones WHERE calendar_id=?1 AND series_id=?2 AND remote_id!=?3", params![cal_id, remote_id, remote_id]).map_err(err)?;
    Ok(changed)
}

/// The master's exclusion list: its own EXDATEs plus the original slot of every exception and every cancelled instance, so an
/// expanded series never shows a moved or deleted instance at its old time as well.
fn refresh_exdates(c: &Connection, cal_id: &str, series: &str) -> R<()> {
    let Some(master) = find_remote(c, cal_id, series) else { return Ok(()) };
    let mut all: BTreeSet<i64> = master.exdates.iter().copied().collect();
    let mut st = c.prepare("SELECT recurrence_id FROM events WHERE calendar_id=?1 AND series_id=?2 AND recurrence_id!=''").map_err(err)?;
    for r in st.query_map(params![cal_id, series], |r| r.get::<_, String>(0)).map_err(err)? {
        if let Ok(v) = r.map_err(err)?.parse::<i64>() {
            all.insert(v);
        }
    }
    let mut st = c.prepare("SELECT recurrence_id FROM cal_tombstones WHERE calendar_id=?1 AND series_id=?2 AND recurrence_id IS NOT NULL").map_err(err)?;
    for r in st.query_map(params![cal_id, series], |r| r.get::<_, i64>(0)).map_err(err)? {
        all.insert(r.map_err(err)?);
    }
    let merged: Vec<i64> = all.into_iter().collect();
    if merged != master.exdates {
        c.execute("UPDATE events SET exdates=?2 WHERE id=?1", params![master.id, serde_json::to_string(&merged).map_err(err)?]).map_err(err)?;
    }
    Ok(())
}

/// Apply one pull to its calendar, in one transaction with the new sync token: either the whole round counts or none of it
/// (a crash repeats the round, and upserts are idempotent by `(calendar, remote id)`). `full_window_from` is the start of the
/// window when the pull was a full download. Returns whether any event changed.
pub fn apply_pull(c: &Connection, cal: &CalRow, account_id: &str, pull: &Pull, full_window_from: Option<i64>, now: i64) -> R<bool> {
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut changed = false;
    if pull.full {
        let seen: HashSet<&str> = pull.upserts.iter().map(|e| e.id.as_str()).collect();
        let mut st = tx.prepare("SELECT id,remote_id FROM events WHERE calendar_id=?1 AND remote_id IS NOT NULL").map_err(err)?;
        let stale: Vec<String> = st
            .query_map([&cal.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .filter_map(|r| r.ok())
            .filter(|(_, rid)| !seen.contains(rid.as_str()))
            .map(|(id, _)| id)
            .collect();
        drop(st);
        for id in stale {
            tx.execute("DELETE FROM events WHERE id=?1", [id]).map_err(err)?;
            changed = true;
        }
        // the download is the whole truth: what was deleted is not in it, and the cancelled instances come with it
        tx.execute("DELETE FROM cal_tombstones WHERE calendar_id=?1", [&cal.id]).map_err(err)?;
    }
    let mut series: BTreeSet<String> = BTreeSet::new();
    for rid in &pull.removed {
        if let Some(old) = find_remote(&tx, &cal.id, rid) {
            if let Some(s) = &old.series_id {
                series.insert(s.clone());
            }
        }
        changed |= remove_remote(&tx, &cal.id, rid, now)?;
    }
    for re in &pull.upserts {
        let cancelled = re.status == "cancelled";
        let instance = matches!(re.kind, EventKind::Exception | EventKind::Occurrence);
        if cancelled && instance && re.series_id.is_some() {
            // a deleted instance of a repeating event: its slot stays hidden
            if let Some(old) = find_remote(&tx, &cal.id, &re.id) {
                tx.execute("DELETE FROM events WHERE id=?1", [old.id]).map_err(err)?;
            }
            let s = re.series_id.clone().unwrap_or_default();
            tombstone(&tx, &cal.id, &re.id, Some(&s), Some(re.recurrence_id.unwrap_or(re.start)), now)?;
            series.insert(s);
            changed = true;
            continue;
        }
        if cancelled {
            changed |= remove_remote(&tx, &cal.id, &re.id, now)?;
            continue;
        }
        // a page that was read before we deleted the event there must not bring it back
        let stale: Option<(Option<String>, i64)> = tx
            .query_row("SELECT series_id,deleted_at FROM cal_tombstones WHERE calendar_id=?1 AND remote_id=?2", params![cal.id, re.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(err)?;
        if let Some((None, deleted_at)) = &stale {
            if re.updated.is_some_and(|u| u <= *deleted_at) {
                continue;
            }
        }
        if stale.is_some() {
            tx.execute("DELETE FROM cal_tombstones WHERE calendar_id=?1 AND remote_id=?2", params![cal.id, re.id]).map_err(err)?;
        }
        upsert_remote(&tx, cal, account_id, re)?;
        changed = true;
        match (&re.kind, &re.series_id) {
            (EventKind::Master, _) => {
                series.insert(re.id.clone());
            }
            (_, Some(s)) => {
                series.insert(s.clone());
            }
            _ => {}
        }
    }
    for s in &series {
        refresh_exdates(&tx, &cal.id, s)?;
    }
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM events WHERE calendar_id=?1", [&cal.id], |r| r.get(0)).map_err(err)?;
    tx.execute(
        "UPDATE calendars SET sync_state=?2, event_count=?3, truncated=?4, window_from=COALESCE(?5, window_from), full_at=COALESCE(?6, full_at) WHERE id=?1",
        params![cal.id, pull.next_state, count, pull.truncated as i64, full_window_from, full_window_from.map(|_| now)],
    )
    .map_err(err)?;
    // old tombstones of plain events are not needed any more
    tx.execute("DELETE FROM cal_tombstones WHERE series_id IS NULL AND deleted_at < ?1", [now - TOMBSTONE_KEEP_SECS]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(changed)
}

// ------------------------------------------------------------------ what the UI shows

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub read_only: bool,
    pub primary: bool,
    pub sync_on: bool,
    pub event_count: i64,
    /// more than 25,000 events: only part of it was downloaded
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub account_id: String,
    /// "google" | "microsoft" | "caldav"
    pub kind: String,
    /// ok | syncing | offline | busy | auth | blocked | notsetup | error
    pub status: String,
    pub last_sync: Option<i64>,
    /// what the provider reported (for `blocked`, `notsetup`, `error`)
    pub last_error: Option<String>,
    /// when the next try is due after a failure
    pub retry_at: Option<i64>,
    /// the first download is running: nothing was synced yet
    pub first_sync: bool,
    pub calendars: Vec<CalendarSyncInfo>,
}

pub fn sources_info(c: &Connection) -> R<Vec<SourceInfo>> {
    let mut out = vec![];
    for s in list_sources(c)? {
        let calendars = calendars_of(c, &s.id)?
            .into_iter()
            .map(|r| CalendarSyncInfo { id: r.id, name: r.name, color: r.color, read_only: r.read_only, primary: r.primary, sync_on: r.sync_on, event_count: r.event_count, truncated: r.truncated })
            .collect();
        out.push(SourceInfo {
            first_sync: s.status == super::SYNCING && s.last_sync.is_none(),
            id: s.id,
            account_id: s.account_id,
            kind: s.kind.as_str().into(),
            status: s.status,
            last_sync: s.last_sync,
            last_error: s.last_error,
            retry_at: s.retry_at,
            calendars,
        });
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::calsync::{calendar_id, EventKind};

    pub const ACC: &str = "11111111-2222-4333-8444-555555555555";

    pub fn conn() -> Connection {
        let c = crate::db::test_conn(&[ACC]);
        c.execute(
            "INSERT INTO accounts(id,email,display_name,imap_host,imap_port,imap_ssl,smtp_host,smtp_port,smtp_security,username,auth) VALUES(?1,'me@gmail.test','Me','imap.gmail.com',993,1,'smtp.gmail.com',465,'ssl','me@gmail.test','oauth_google')",
            [ACC],
        )
        .unwrap();
        c
    }

    pub fn rc(id: &str, name: &str) -> RemoteCalendar {
        RemoteCalendar { id: id.into(), name: name.into(), color: "#039be5".into(), selected: true, ..Default::default() }
    }

    pub fn setup(c: &Connection) -> (Source, CalRow) {
        let s = create_source(c, ACC, Kind::Google, 1000).unwrap();
        reconcile_calendars(c, &s, &[rc("primary", "Me")]).unwrap();
        let cal = get_calendar(c, &calendar_id(ACC, Kind::Google, "primary")).unwrap();
        (s, cal)
    }

    fn ev(id: &str, start: i64) -> RemoteEvent {
        RemoteEvent::single(id, &format!("event {id}"), start, start + 3600)
    }

    fn count(c: &Connection, sql: &str) -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn pull(upserts: Vec<RemoteEvent>, removed: Vec<&str>, state: &str, full: bool) -> Pull {
        Pull { upserts, removed: removed.into_iter().map(String::from).collect(), next_state: Some(state.into()), full, truncated: false }
    }

    #[test]
    fn migration_creates_the_tables_and_is_idempotent() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        crate::db::migrate(&c).unwrap();
        for t in ["cal_sources", "calendars", "cal_tombstones"] {
            assert_eq!(count(&c, &format!("SELECT COUNT(*) FROM sqlite_master WHERE name='{t}'")), 1, "{t}");
        }
        for col in ["remote_id", "etag", "series_id", "remote_kind", "read_only", "rdates"] {
            assert_eq!(count(&c, &format!("SELECT COUNT(*) FROM pragma_table_info('events') WHERE name='{col}'")), 1, "{col}");
        }
        assert_eq!(count(&c, "SELECT COUNT(*) FROM pragma_table_info('cal_sources') WHERE name='list_state'"), 1);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM pragma_table_info('calendars') WHERE name='full_at'"), 1);
    }

    #[test]
    fn migration_upgrades_a_1_0_0_events_table_and_keeps_its_rows() {
        // the table as 1.0.0 created it, with an event in it
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE events(
               id TEXT PRIMARY KEY, uid TEXT NOT NULL, recurrence_id TEXT NOT NULL DEFAULT '',
               calendar_id TEXT NOT NULL, account_id TEXT,
               summary TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, tzid TEXT,
               location TEXT, join_url TEXT, description TEXT,
               organizer_name TEXT, organizer_email TEXT, attendees TEXT NOT NULL DEFAULT '[]',
               rrule TEXT, exdates TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'confirmed', my_status TEXT, responded_at INTEGER, reminder_min INTEGER,
               source_message_id TEXT, sequence INTEGER NOT NULL DEFAULT 0, prev TEXT,
               created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
               UNIQUE(calendar_id, uid, recurrence_id)
             );
             INSERT INTO events(id,uid,calendar_id,summary,starts_at,ends_at) VALUES('old','u','local','Dentist',100,200);",
        )
        .unwrap();
        crate::db::migrate(&c).unwrap();
        let e = calendar::get_event(&c, "old").unwrap();
        assert_eq!((e.summary.as_str(), e.remote_id.clone(), e.read_only.clone()), ("Dentist", None, None));
        // and a local event still saves and reads back
        let mut n = e.clone();
        n.id = "new".into();
        n.uid = "u2".into();
        calendar::save_row(&c, &n).unwrap();
        assert_eq!(calendar::get_event(&c, "new").unwrap().uid, "u2");
    }

    #[test]
    fn reconcile_adds_updates_and_removes_calendars_and_keeps_the_users_switch() {
        let c = conn();
        let s = create_source(&c, ACC, Kind::Google, 1).unwrap();
        let mut other = rc("work", "Work");
        other.selected = false;
        let mut ro = rc("holidays", "Holidays");
        ro.read_only = true;
        assert!(reconcile_calendars(&c, &s, &[rc("primary", "Me"), other.clone(), ro.clone()]).unwrap());
        let cals = calendars_of(&c, &s.id).unwrap();
        assert_eq!(cals.len(), 3);
        let by = |n: &str| cals.iter().find(|x| x.name == n).unwrap().clone();
        assert!(by("Me").sync_on && by("Holidays").sync_on, "the provider shows them by default");
        assert!(!by("Work").sync_on, "not shown at the provider: not downloaded");
        assert!(by("Holidays").read_only);
        // the user switches Work on and sets a token; a second identical list changes nothing
        set_calendar_sync(&c, &by("Work").id, true).unwrap();
        c.execute("UPDATE calendars SET sync_state='tok' WHERE name='Work'", []).unwrap();
        assert!(!reconcile_calendars(&c, &s, &[rc("primary", "Me"), other.clone(), ro.clone()]).unwrap());
        // renamed + recoloured: updated, switch and token kept; Holidays vanished: removed with its events
        upsert_remote(&c, &by("Holidays"), ACC, &ev("h1", 10)).unwrap();
        let mut renamed = other.clone();
        renamed.name = "Work 2".into();
        renamed.color = "#ff0000".into();
        assert!(reconcile_calendars(&c, &s, &[rc("primary", "Me"), renamed]).unwrap());
        let cals = calendars_of(&c, &s.id).unwrap();
        assert_eq!(cals.len(), 2);
        let w = cals.iter().find(|x| x.remote_id == "work").unwrap();
        assert_eq!((w.name.as_str(), w.color.as_str(), w.sync_on, w.sync_state.as_deref()), ("Work 2", "#ff0000", true, Some("tok")));
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id='h1'"), 0);
    }

    #[test]
    fn a_calendar_that_becomes_writable_is_downloaded_again_and_a_read_only_one_locks_its_events() {
        let c = conn();
        let (s, cal) = setup(&c);
        upsert_remote(&c, &cal, ACC, &ev("e1", 10)).unwrap();
        c.execute("UPDATE calendars SET sync_state='tok'", []).unwrap();
        let mut locked = rc("primary", "Me");
        locked.read_only = true;
        reconcile_calendars(&c, &s, &[locked.clone()]).unwrap();
        assert_eq!(calendar::get_event(&c, &find_id(&c, "e1")).unwrap().read_only.as_deref(), Some("calendar"));
        locked.read_only = false;
        reconcile_calendars(&c, &s, &[locked]).unwrap();
        assert_eq!(get_calendar(&c, &cal.id).unwrap().sync_state, None, "which events are editable is decided again");
    }

    fn find_id(c: &Connection, remote_id: &str) -> String {
        c.query_row("SELECT id FROM events WHERE remote_id=?1", [remote_id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn the_sync_switch_off_removes_the_events_and_the_token() {
        let c = conn();
        let (_, cal) = setup(&c);
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10), ev("b", 20)], vec![], "tok1", true), Some(5), 100).unwrap();
        let cal = get_calendar(&c, &cal.id).unwrap();
        assert_eq!((cal.event_count, cal.sync_state.as_deref(), cal.window_from), (2, Some("tok1"), Some(5)));
        set_calendar_sync(&c, &cal.id, false).unwrap();
        let cal = get_calendar(&c, &cal.id).unwrap();
        assert_eq!((cal.sync_on, cal.event_count, cal.sync_state, cal.window_from), (false, 0, None, None));
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE calendar_id LIKE 'google:%'"), 0);
        assert!(set_calendar_sync(&c, "google:nope", true).is_err());
    }

    #[test]
    fn incremental_pull_updates_inserts_and_deletes_rows_by_remote_id() {
        let c = conn();
        let (_, cal) = setup(&c);
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10), ev("b", 20)], vec![], "t1", true), Some(0), 100).unwrap();
        let id_a = find_id(&c, "a");
        let mut a2 = ev("a", 30);
        a2.summary = "moved".into();
        a2.etag = "\"v2\"".into();
        assert!(apply_pull(&c, &cal, ACC, &pull(vec![a2, ev("c", 40)], vec!["b"], "t2", false), None, 200).unwrap());
        assert_eq!(find_id(&c, "a"), id_a, "the row id stays");
        let a = calendar::get_event(&c, &id_a).unwrap();
        assert_eq!((a.summary.as_str(), a.start, a.etag.as_deref()), ("moved", 30, Some("\"v2\"")));
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id='b'"), 0);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id='c'"), 1);
        let cal = get_calendar(&c, &cal.id).unwrap();
        assert_eq!((cal.sync_state.as_deref(), cal.event_count), (Some("t2"), 2));
        // the same pull again changes nothing and fails nothing (idempotent)
        apply_pull(&c, &cal, ACC, &pull(vec![ev("c", 40)], vec!["b"], "t2", false), None, 300).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE calendar_id LIKE 'google:%'"), 2);
    }

    #[test]
    fn a_full_pull_replaces_everything_without_duplicates() {
        let c = conn();
        let (_, cal) = setup(&c);
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10), ev("b", 20)], vec![], "t1", true), Some(0), 100).unwrap();
        // 410: download again; "a" is unchanged, "b" was deleted meanwhile, "c" is new
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10), ev("c", 40)], vec![], "t9", true), Some(0), 200).unwrap();
        let rids: Vec<String> = {
            let mut st = c.prepare("SELECT remote_id FROM events WHERE calendar_id LIKE 'google:%' ORDER BY remote_id").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(rids, vec!["a", "c"]);
    }

    #[test]
    fn deleted_events_leave_a_tombstone_and_a_stale_page_does_not_bring_them_back() {
        let c = conn();
        let (_, cal) = setup(&c);
        let mut a = ev("a", 10);
        a.updated = Some(500);
        apply_pull(&c, &cal, ACC, &pull(vec![a.clone()], vec![], "t1", true), Some(0), 600).unwrap();
        // we delete it at the provider (write path) ...
        assert!(remove_remote(&c, &cal.id, "a", 1000).unwrap());
        assert_eq!(count(&c, "SELECT COUNT(*) FROM cal_tombstones WHERE remote_id='a'"), 1);
        // ... and a page that was read before that still lists it
        apply_pull(&c, &cal, ACC, &pull(vec![a.clone()], vec![], "t2", false), None, 1100).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id='a'"), 0, "older than the deletion: ignored");
        // a version changed after the deletion (an event restored there) is real
        a.updated = Some(2000);
        apply_pull(&c, &cal, ACC, &pull(vec![a], vec![], "t3", false), None, 2100).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id='a'"), 1);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM cal_tombstones WHERE remote_id='a'"), 0);
        // tombstones of plain events are dropped after 30 days
        remove_remote(&c, &cal.id, "a", 3000).unwrap();
        apply_pull(&c, &cal, ACC, &pull(vec![], vec![], "t4", false), None, 3000 + TOMBSTONE_KEEP_SECS + 1).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM cal_tombstones"), 0);
    }

    fn series(id: &str, start: i64) -> RemoteEvent {
        let mut m = ev(id, start);
        m.kind = EventKind::Master;
        m.uid = format!("{id}@g");
        m.rrule = Some("FREQ=WEEKLY".into());
        m
    }

    fn instance(id: &str, series_id: &str, orig: i64, start: i64, status: &str) -> RemoteEvent {
        let mut e = ev(id, start);
        e.kind = EventKind::Exception;
        e.uid = format!("{series_id}@g");
        e.series_id = Some(series_id.into());
        e.recurrence_id = Some(orig);
        e.status = status.into();
        e
    }

    const WEEK: i64 = 7 * 86_400;

    #[test]
    fn a_series_with_a_moved_and_a_cancelled_instance_shows_each_instance_once() {
        let c = conn();
        let (_, cal) = setup(&c);
        let t0 = 1_700_000_000 - 1_700_000_000 % 3600; // a Tuesday-ish instant; only the spacing matters
        let moved = instance("s_2", "s", t0 + WEEK, t0 + WEEK + 7200, "confirmed");
        let gone = instance("s_3", "s", t0 + 2 * WEEK, t0 + 2 * WEEK, "cancelled");
        // the instances arrive BEFORE the master in the page
        apply_pull(&c, &cal, ACC, &pull(vec![moved, gone, series("s", t0)], vec![], "t1", true), Some(0), 100).unwrap();
        let master = calendar::get_event(&c, &find_id(&c, "s")).unwrap();
        assert_eq!(master.exdates, vec![t0 + WEEK, t0 + 2 * WEEK], "the old slot of the moved and of the cancelled instance");
        assert_eq!(master.read_only.as_deref(), Some("repeating"));
        let from = t0 - 3600;
        let shown = calendar::list_range(&c, from, from + 5 * WEEK).unwrap();
        let starts: Vec<i64> = shown.iter().map(|e| e.start).collect();
        assert_eq!(starts, vec![t0, t0 + WEEK + 7200, t0 + 3 * WEEK, t0 + 4 * WEEK], "moved one at its new time, none on the deleted date, no duplicate");
        assert!(shown.iter().all(|e| e.read_only.as_deref() == Some("repeating")));
        // the cancelled instance is a tombstone and no row
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id='s_3'"), 0);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM cal_tombstones WHERE remote_id='s_3' AND series_id='s'"), 1);
        // the master changes (title) without its instances: the exclusions survive the replacement of the master
        let mut m2 = series("s", t0);
        m2.summary = "renamed".into();
        apply_pull(&c, &cal, ACC, &pull(vec![m2], vec![], "t2", false), None, 200).unwrap();
        assert_eq!(calendar::get_event(&c, &find_id(&c, "s")).unwrap().exdates, vec![t0 + WEEK, t0 + 2 * WEEK]);
        // the series is deleted: the instances and their tombstones go with it
        apply_pull(&c, &cal, ACC, &pull(vec![], vec!["s"], "t3", false), None, 300).unwrap();
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE calendar_id LIKE 'google:%'"), 0);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM cal_tombstones WHERE series_id IS NOT NULL"), 0);
    }

    #[test]
    fn a_removed_instance_keeps_its_slot_hidden() {
        let c = conn();
        let (_, cal) = setup(&c);
        let t0 = 1_700_000_000;
        apply_pull(&c, &cal, ACC, &pull(vec![series("s", t0), instance("s_2", "s", t0 + WEEK, t0 + WEEK + 60, "confirmed")], vec![], "t1", true), Some(0), 100).unwrap();
        // the provider reports the exception as removed (Graph `@removed`)
        apply_pull(&c, &cal, ACC, &pull(vec![], vec!["s_2"], "t2", false), None, 200).unwrap();
        assert_eq!(calendar::get_event(&c, &find_id(&c, "s")).unwrap().exdates, vec![t0 + WEEK]);
    }

    #[test]
    fn remote_event_fields_are_mapped_and_read_only_reasons_are_decided() {
        let c = conn();
        let (s, cal) = setup(&c);
        let mut e = ev("x", 1_700_000_000);
        e.uid = "uid-x@google.com".into();
        e.etag = "\"3\"".into();
        e.all_day = false;
        e.tzid = Some("America/New_York".into());
        e.location = Some(" ".into());
        e.description = Some("notes".into());
        e.join_url = Some("https://meet.example/abc".into());
        e.reminder_min = Some(10);
        e.my_status = Some("accepted".into());
        e.organizer = Some(CalPerson { email: "boss@x.y".into(), name: Some("Boss".into()) });
        e.can_edit = false;
        let got = upsert_remote(&c, &cal, ACC, &e).unwrap();
        assert_eq!((got.uid.as_str(), got.calendar_id.as_str(), got.account_id.as_deref()), ("uid-x@google.com", cal.id.as_str(), Some(ACC)));
        assert_eq!((got.tzid.as_deref(), got.location, got.reminder_min, got.read_only.as_deref()), (Some("America/New_York"), None, Some(10), Some("organizer")));
        let back = calendar::get_event(&c, &got.id).unwrap();
        assert_eq!((back.etag.as_deref(), back.remote_id.as_deref(), back.remote_kind.as_deref()), (Some("\"3\""), Some("x"), Some("single")));
        assert_eq!(back.organizer.unwrap().email, "boss@x.y");
        // an unknown time zone is dropped instead of breaking the expansion
        e.tzid = Some("Mars/Base".into());
        e.can_edit = true;
        assert_eq!(upsert_remote(&c, &cal, ACC, &e).unwrap().tzid, None);
        // a read-only calendar wins over everything
        reconcile_calendars(&c, &s, &[RemoteCalendar { read_only: true, ..rc("primary", "Me") }]).unwrap();
        let cal = get_calendar(&c, &cal.id).unwrap();
        assert_eq!(upsert_remote(&c, &cal, ACC, &e).unwrap().read_only.as_deref(), Some("calendar"));
    }

    #[test]
    fn disconnect_and_account_removal_clean_every_table() {
        let c = conn();
        let (s, cal) = setup(&c);
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10), series("s", 20)], vec![], "t", true), Some(0), 100).unwrap();
        remove_remote(&c, &cal.id, "a", 200).unwrap();
        crate::db::set_setting(&c, "cal_hidden", &format!("[\"local\",\"{}\"]", cal.id)).unwrap();
        // an event of the local calendar and an invitation of the same mailbox are not the sync's
        c.execute("INSERT INTO events(id,uid,calendar_id,summary,starts_at,ends_at) VALUES('mine','m','local','Mine',1,2)", []).unwrap();
        disconnect(&c, &s.id).unwrap();
        for t in ["cal_sources", "calendars", "cal_tombstones"] {
            assert_eq!(count(&c, &format!("SELECT COUNT(*) FROM {t}")), 0, "{t}");
        }
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id IS NOT NULL"), 0);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE id='mine'"), 1);
        assert_eq!(crate::db::get_setting(&c, "cal_hidden").unwrap(), "[\"local\"]");
        // removing the mailbox does the same
        let (_, cal) = setup(&c);
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10)], vec![], "t", true), Some(0), 100).unwrap();
        crate::db::remove_account(&c, ACC).unwrap();
        for t in ["cal_sources", "calendars", "cal_tombstones"] {
            assert_eq!(count(&c, &format!("SELECT COUNT(*) FROM {t}")), 0, "{t}");
        }
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id IS NOT NULL"), 0);
    }

    #[test]
    fn leftovers_are_pruned_at_start() {
        let c = conn();
        let (_, cal) = setup(&c);
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10)], vec![], "t", true), Some(0), 100).unwrap();
        // the mailbox row vanished without the cleanup (older version, interrupted removal)
        c.execute("DELETE FROM accounts", []).unwrap();
        c.execute("INSERT INTO cal_tombstones(calendar_id,remote_id,deleted_at) VALUES('google:gone:x','t',1)", []).unwrap();
        c.execute("INSERT INTO events(id,uid,calendar_id,account_id,summary,starts_at,ends_at,remote_id) VALUES('orph','o','google:gone:x',NULL,'o',1,2,'o')", []).unwrap();
        crate::db::prune_orphans(&c).unwrap();
        for t in ["cal_sources", "calendars", "cal_tombstones"] {
            assert_eq!(count(&c, &format!("SELECT COUNT(*) FROM {t}")), 0, "{t}");
        }
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id IS NOT NULL"), 0);
    }

    #[test]
    fn starting_again_keeps_the_local_copy_and_clears_the_error() {
        let c = conn();
        let (s, cal) = setup(&c);
        apply_pull(&c, &cal, ACC, &pull(vec![ev("a", 10)], vec![], "tok", true), Some(0), 100).unwrap();
        set_status(&c, &s.id, "auth", Some("invalid_grant"), None, 3).unwrap();
        let s2 = create_source(&c, ACC, Kind::Google, 2000).unwrap();
        assert_eq!((s2.status.as_str(), s2.last_error, s2.fail_count, s2.connected_at), ("syncing", None, 0, 1000));
        assert_eq!(get_calendar(&c, &cal.id).unwrap().sync_state.as_deref(), Some("tok"), "no re-download, no duplicates");
        assert_eq!(count(&c, "SELECT COUNT(*) FROM events WHERE remote_id='a'"), 1);
    }

    #[test]
    fn a_start_gives_a_not_set_up_source_a_new_round() {
        // D-061: a run of a build without the Google client left "not set up" behind; the next start (with a client) must not keep showing it
        let c = conn();
        let (s, _) = setup(&c);
        mark_synced(&c, &s.id, 5000).unwrap();
        set_status(&c, &s.id, "notsetup", Some("no Google OAuth client configured"), None, 0).unwrap();
        assert!(!crate::calsync::engine::is_due(&list_sources(&c).unwrap()[0], 99_999, true), "waits for the user while the app runs");
        retry_not_set_up(&c).unwrap();
        let after = list_sources(&c).unwrap();
        assert_eq!((after[0].status.as_str(), after[0].last_error.clone()), ("ok", None));
        assert!(crate::calsync::engine::is_due(&after[0], 99_999, false), "due again at once");
        // a source that never synced goes back to the first-sync state; the other states are not touched
        c.execute("UPDATE cal_sources SET last_sync=NULL", []).unwrap();
        set_status(&c, &s.id, "notsetup", Some("x"), None, 0).unwrap();
        retry_not_set_up(&c).unwrap();
        assert_eq!(list_sources(&c).unwrap()[0].status, "syncing");
        set_status(&c, &s.id, "auth", None, None, 0).unwrap();
        retry_not_set_up(&c).unwrap();
        assert_eq!(list_sources(&c).unwrap()[0].status, "auth", "access that ended still waits for Allow access again");
    }

    #[test]
    fn sources_info_reports_the_first_sync_and_the_calendars() {
        let c = conn();
        let (s, _) = setup(&c);
        let i = sources_info(&c).unwrap();
        assert_eq!((i.len(), i[0].first_sync, i[0].calendars.len(), i[0].kind.as_str()), (1, true, 1, "google"));
        mark_synced(&c, &s.id, 5000).unwrap();
        let i = sources_info(&c).unwrap();
        assert_eq!((i[0].first_sync, i[0].status.as_str(), i[0].last_sync), (false, "ok", Some(5000)));
        assert!(serde_json::to_value(&i[0]).unwrap().get("lastSync").is_some());
    }

    #[test]
    fn read_only_codes_round_trip() {
        for r in [None, Some("calendar"), Some("repeating"), Some("organizer")] {
            assert_eq!(read_only_reason(read_only_code(r)).as_deref(), r);
        }
        assert_eq!(read_only_code(Some("whatever")), 0);
    }
}
