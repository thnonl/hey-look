// Calendar sync with Google Calendar / Outlook: the rules that Settings, the calendar sidebar and the event dialog share.
// Pure functions without Tauri or React, so scripts/test-calendar-sync.mjs can check them. The wording follows the design
// (reports/v1-0-1/04-calendar-sync.md section 6); an i18n pass will move the strings later.
import type { CalEvent, CalendarInfo, CalSource } from "./api";

export type SyncKind = "google" | "microsoft";

/** The services this build can sync. Keep in sync with `ENABLED_KINDS` in src-tauri/src/calsync/mod.rs (a Rust test compares them). */
export const CALENDAR_SYNC_KINDS: string[] = ["google", "microsoft"];

/** Which service a mailbox could sync its calendar with: Google and Gmail mailboxes, Microsoft mailboxes; none for iCloud / IMAP. */
export function calendarSyncKind(a: { auth: string; imapHost: string }): SyncKind | null {
  const kind: SyncKind | null =
    a.auth === "oauth_google" || a.imapHost.toLowerCase() === "imap.gmail.com" ? "google" : a.auth === "oauth_microsoft" ? "microsoft" : null;
  return kind && CALENDAR_SYNC_KINDS.includes(kind) ? kind : null;
}

export const providerName = (k: SyncKind) => (k === "google" ? "Google" : "Microsoft");
export const serviceName = (k: SyncKind) => (k === "google" ? "Google Calendar" : "Outlook");
const kindOf = (s: string): SyncKind => (s === "microsoft" ? "microsoft" : "google");

/** True for the id of a calendar that is synced from a service (not "local", not "invites:<account>"). */
export const isSyncedCalendarId = (id: string) => /^(google|ms|caldav):/.test(id);

/** The calendar's own name from the sidebar label "Name · address". */
export const calendarName = (label: string) => label.split(" · ")[0] || label;

export function lastSyncedText(last: number | null, nowSec: number, fmtTime: (sec: number) => string): string {
  if (last === null || last === undefined) return "Not synced yet";
  const age = Math.max(0, nowSec - last);
  if (age < 60) return "Last synced just now";
  if (age < 3600) return `Last synced ${Math.floor(age / 60)} min ago`;
  return `Last synced at ${fmtTime(last)}`;
}

export interface StatusLine {
  text: string;
  /** "bad" is drawn as a notice, anything else as small muted text */
  tone: "muted" | "bad";
  /** the `Sync now` button: shown and usable, shown and disabled, or not shown */
  syncNow: "on" | "disabled" | "off";
  /** the `Allow access again` button */
  allow: boolean;
}

const minutes = (retryAt: number | null, nowSec: number) => Math.max(1, Math.ceil(((retryAt ?? nowSec) - nowSec) / 60));

/** The status line under the switch (design 6.1). `email` is the mailbox address. */
export function statusLine(src: CalSource, ctx: { email: string; nowSec: number; fmtTime: (sec: number) => string }): StatusLine {
  const kind = kindOf(src.kind);
  const service = serviceName(kind);
  const reason = (src.lastError ?? "").trim() || "no reason given";
  switch (src.status) {
    case "syncing":
      return { text: src.firstSync ? "Downloading your calendars…" : "Syncing…", tone: "muted", syncNow: "disabled", allow: false };
    case "offline":
      return { text: "Offline. The calendar shows the events saved on this computer.", tone: "muted", syncNow: "on", allow: false };
    case "busy":
      return { text: `${service} is busy. Hey Look! tries again in ${minutes(src.retryAt, ctx.nowSec)} min.`, tone: "muted", syncNow: "on", allow: false };
    case "auth":
      return { text: `Calendar access for ${ctx.email} ended. Allow access again to keep syncing.`, tone: "bad", syncNow: "off", allow: true };
    case "blocked":
      return { text: `${ctx.email}’s organization hasn’t approved Hey Look! for calendar access. Ask your IT admin.`, tone: "bad", syncNow: "off", allow: true };
    case "notsetup":
      return { text: `Calendar sync isn’t available in this version of Hey Look! (${providerName(kind)} reported: ${reason}).`, tone: "bad", syncNow: "off", allow: false };
    case "error":
      return { text: `Couldn’t sync the calendar: ${reason}. Hey Look! tries again in ${minutes(src.retryAt, ctx.nowSec)} min.`, tone: "muted", syncNow: "on", allow: false };
    default:
      return { text: lastSyncedText(src.lastSync, ctx.nowSec, ctx.fmtTime), tone: "muted", syncNow: "on", allow: false };
  }
}

/** The extra line when a calendar has more events than the app keeps. */
export function truncatedNote(src: CalSource): string | null {
  const c = src.calendars.find((x) => x.truncated && x.syncOn);
  return c ? `Only part of ${c.name} was downloaded: it has more than 25,000 events.` : null;
}

/** Mailboxes whose calendar sync is paused until the person acts (access ended, blocked by the organization). */
export function pausedSources(sources: CalSource[]): CalSource[] {
  return sources.filter((s) => s.status === "auth" || s.status === "blocked");
}

/** Why an event of a synced calendar has no Edit / Delete. `label` is the calendar's sidebar label. */
export function readOnlyNote(e: Pick<CalEvent, "readOnly">, label: string, service: string | null | undefined): string | null {
  const cal = calendarName(label);
  const svc = service || "its own app";
  switch (e.readOnly) {
    case "repeating":
      return `Repeating events of ${cal} can be changed in ${svc} for now.`;
    case "calendar":
      return `${cal} is read only.`;
    case "organizer":
      return "Only the organizer can change this event.";
    default:
      return null;
  }
}

/** The calendars a new event can go to: My events, then the synced calendars the person may write to. */
export function writableCalendars(cals: CalendarInfo[]): CalendarInfo[] {
  return cals.filter((c) => c.id === "local" || (c.remote && c.writable));
}

/** The calendar a new event starts in: the last one used when it is still there, else My events. */
export function defaultCalendar(cals: CalendarInfo[], last: string | null | undefined): string {
  return last && writableCalendars(cals).some((c) => c.id === last) ? last : "local";
}

/** The sentence for the backend's calendar sync errors ("CAL_CONFLICT: text"), or null for any other error. */
export function calendarErrorText(raw: string): string | null {
  const m = /^CAL_(OFFLINE|CONFLICT|GONE|READ_ONLY|AUTH|BUSY|NOT_SET_UP|DENIED|WRONG_ACCOUNT|PARTIAL|TIMEOUT|CANCELLED|BLOCKED|ERROR):\s*(.+)$/s.exec(raw.trim());
  return m ? m[2].trim() : null;
}

/** The code of such an error ("CONFLICT"), or null. */
export function calendarErrorCode(raw: string): string | null {
  return /^CAL_(OFFLINE|CONFLICT|GONE|READ_ONLY|AUTH|BUSY|NOT_SET_UP|DENIED|WRONG_ACCOUNT|PARTIAL|TIMEOUT|CANCELLED|BLOCKED|ERROR):/.exec(raw.trim())?.[1] ?? null;
}

/** Colour for a synced calendar's events and sidebar box: its own colour, else the mailbox's. */
export function syncedColor(cal: Pick<CalendarInfo, "color"> | undefined, fallback: string | undefined): string | undefined {
  return cal?.color ? cal.color : fallback;
}

/** The confirm dialog for deleting an event of a synced calendar. */
export function deleteConfirm(label: string, service: string | null | undefined, guests: number): { title: string; body: string } {
  const svc = service || "its own app";
  return {
    title: "Delete this event?",
    body: `It’s also deleted from ${calendarName(label)} in ${svc}.${guests > 0 ? ` Guests get a cancellation from ${svc}.` : ""}`,
  };
}
