// Calendar sync with Google Calendar / Outlook: the rules that Settings, the calendar sidebar and the event dialog share.
// Pure functions without Tauri or React, so scripts/test-calendar-sync.mjs can check them. The wording follows the design
// (reports/v1-0-1/04-calendar-sync.md section 6); the sentences live in the dictionary (i18n/ns/calendar.ts).
import type { CalEvent, CalendarInfo, CalSource } from "./api";
import { t } from "./i18n/index.ts"; // (explicit path: scripts/test-calendar-sync.mjs loads this file with node)
import type { Key } from "./i18n/index.ts";

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

/**
 * The name of a calendar as the sidebar shows it: the backend names "local" "My events" and an account's invitations calendar
 * "Invitations · address" in English; both are shown in the language in use. Any other name is the calendar's own.
 */
export function calendarTitle(c: { id: string; name: string }): string {
  if (c.id === "local") return t("calendar.myEvents");
  const inv = /^Invitations · (.+)$/.exec(c.name);
  return c.id.startsWith("invites:") && inv ? t("calendar.invitationsOf", { email: inv[1] }) : c.name;
}

/** The calendar's own name from the sidebar label "Name · address". */
export const calendarName = (label: string) => label.split(" · ")[0] || label;

export function lastSyncedText(last: number | null, nowSec: number, fmtTime: (sec: number) => string): string {
  if (last === null || last === undefined) return t("calendar.sync.never");
  const age = Math.max(0, nowSec - last);
  if (age < 60) return t("calendar.sync.justNow");
  if (age < 3600) return t("calendar.sync.minAgo", { n: Math.floor(age / 60) });
  return t("calendar.sync.syncedAt", { time: fmtTime(last) });
}

export interface StatusLine {
  text: string;
  /** "bad" is drawn as a notice, anything else as small muted text */
  tone: "muted" | "bad";
  /** the `Sync now` button: shown and usable, shown and disabled, or not shown */
  syncNow: "on" | "disabled" | "off";
  /** the `Allow access again` button */
  allow: boolean;
  /** the technical part of an error (what the server said), shown apart in smaller type */
  detail?: string;
}

const minutes = (retryAt: number | null, nowSec: number) => Math.max(1, Math.ceil(((retryAt ?? nowSec) - nowSec) / 60));

/** The status line under the switch (design 6.1). `email` is the mailbox address. */
export function statusLine(src: CalSource, ctx: { email: string; nowSec: number; fmtTime: (sec: number) => string }): StatusLine {
  const kind = kindOf(src.kind);
  const service = serviceName(kind);
  const reason = (src.lastError ?? "").trim() || t("calendar.sync.noReason");
  switch (src.status) {
    case "syncing":
      return { text: src.firstSync ? t("calendar.sync.downloading") : t("calendar.sync.syncing"), tone: "muted", syncNow: "disabled", allow: false };
    case "offline":
      return { text: t("calendar.sync.offline"), tone: "muted", syncNow: "on", allow: false };
    case "busy":
      return { text: t("calendar.sync.busy", { service, n: minutes(src.retryAt, ctx.nowSec) }), tone: "muted", syncNow: "on", allow: false };
    case "auth":
      return { text: t("calendar.sync.auth", { email: ctx.email }), tone: "bad", syncNow: "off", allow: true };
    case "blocked":
      // the organization has to approve the app first: asking for access again cannot help until the admin has acted (switching the sync off and on starts over)
      return { text: t("calendar.sync.blocked", { email: ctx.email }), tone: "bad", syncNow: "off", allow: false };
    case "notsetup":
      return { text: t("calendar.sync.notSetUp", { provider: providerName(kind), reason }), tone: "bad", syncNow: "off", allow: false };
    case "error":
      return { text: t("calendar.sync.error", { n: minutes(src.retryAt, ctx.nowSec) }), tone: "muted", syncNow: "on", allow: false, detail: t("calendar.sync.details", { reason }) };
    default:
      return { text: lastSyncedText(src.lastSync, ctx.nowSec, ctx.fmtTime), tone: "muted", syncNow: "on", allow: false };
  }
}

/** The extra line when a calendar has more events than the app keeps. */
export function truncatedNote(src: CalSource): string | null {
  const c = src.calendars.find((x) => x.truncated && x.syncOn);
  return c ? t("calendar.sync.truncated", { name: c.name }) : null;
}

/** Mailboxes whose calendar sync is paused until the person acts (access ended, blocked by the organization). */
export function pausedSources(sources: CalSource[]): CalSource[] {
  return sources.filter((s) => s.status === "auth" || s.status === "blocked");
}

/** Why an event of a synced calendar has no Edit / Delete. `label` is the calendar's sidebar label. */
export function readOnlyNote(e: Pick<CalEvent, "readOnly">, label: string, service: string | null | undefined): string | null {
  const cal = calendarName(label);
  const svc = service || t("calendar.sync.ownApp");
  switch (e.readOnly) {
    case "repeating":
      return t("calendar.sync.readOnlyRepeating", { calendar: cal, service: svc });
    case "calendar":
      return t("calendar.sync.readOnlyCalendar", { calendar: cal });
    case "organizer":
      return t("calendar.sync.readOnlyOrganizer");
    default:
      return null;
  }
}

/** The calendars the sidebar lists: the Invitations entry of a mailbox whose main calendar is synced is part of that calendar and not listed (W7.11). */
export function sidebarCalendars<T extends Pick<CalendarInfo, "foldedInto">>(cals: T[]): T[] {
  return cals.filter((c) => !c.foldedInto);
}

/** The calendar whose colour and checkbox the events of calendar `id` follow: the one it is folded into, else itself. */
export function foldTarget<T extends Pick<CalendarInfo, "id" | "foldedInto">>(cals: T[], id: string): T | undefined {
  const own = cals.find((c) => c.id === id);
  return (own?.foldedInto ? cals.find((c) => c.id === own.foldedInto) : undefined) ?? own;
}

/** The calendars a new event can go to: My events, then the synced calendars the person may write to. */
export function writableCalendars(cals: CalendarInfo[]): CalendarInfo[] {
  return cals.filter((c) => c.id === "local" || (c.remote && c.writable));
}

/** The calendar a new event starts in: the last one used when it is still there, else My events. */
export function defaultCalendar(cals: CalendarInfo[], last: string | null | undefined): string {
  return last && writableCalendars(cals).some((c) => c.id === last) ? last : "local";
}

/**
 * The sentences the backend writes for its calendar sync errors, in the shape they arrive ("CAL_CONFLICT: <text>"): each pattern
 * names the dictionary key of its translation and the `{placeholders}` its capture groups fill, in order.
 */
export const BACKEND_ERRORS: { re: RegExp; key: Key; names: string[] }[] = [
  { re: /^You’re offline\. Changes to (.+) need a connection\.$/s, key: "calendar.err.offline", names: ["calendar"] },
  { re: /^This event was changed in (.+), so its latest version is shown\.$/s, key: "calendar.err.conflict", names: ["service"] },
  { re: /^This event was deleted in (.+)\.$/s, key: "calendar.err.deleted", names: ["service"] },
  { re: /^This calendar is no longer synced\.$/s, key: "calendar.err.noLongerSynced", names: [] },
  { re: /^This event is not part of a synced calendar\.$/s, key: "calendar.err.notSynced", names: [] },
  { re: /^Calendar access for (.+) ended\. Allow access again in Settings > Mailboxes > Calendar to keep syncing\.$/s, key: "calendar.err.auth", names: ["email"] },
  { re: /^(.+) is busy\. Try again in a moment\.$/s, key: "calendar.err.busy", names: ["service"] },
  { re: /^Calendar sync isn’t available in this version of Hey Look! \((.*)\)\.$/s, key: "calendar.err.notSetUp", names: ["reason"] },
  { re: /^This mailbox has no calendar that Hey Look! can sync\.$/s, key: "calendar.err.noCalendar", names: [] },
  { re: /^Couldn’t save to ([^:]+): (.*)\.$/s, key: "calendar.err.saveFailed", names: ["service", "reason"] },
  { re: /^Couldn’t turn on calendar sync: (.*)$/s, key: "calendar.err.turnOnFailed", names: ["reason"] },
  { re: /^Couldn’t save the calendar sign-in: (.*)$/s, key: "calendar.err.signInSaveFailed", names: ["reason"] },
  { re: /^Repeating events of (.+) can be changed in (.+) for now\.$/s, key: "calendar.sync.readOnlyRepeating", names: ["calendar", "service"] },
  { re: /^Repeating events can be added to (.+) in (.+) for now\.$/s, key: "calendar.sync.repeatAddOnly", names: ["calendar", "service"] },
  { re: /^Only the organizer can change this event\.$/s, key: "calendar.sync.readOnlyOrganizer", names: [] },
  { re: /^(.+) is read only\.$/s, key: "calendar.sync.readOnlyCalendar", names: ["calendar"] },
  { re: /^(.+?)’s organization may need to approve Hey Look! for calendar access\. Ask your IT admin\.$/s, key: "calendar.sync.blocked", names: ["email"] },
  { re: /^Calendar access wasn’t allowed\. You can try again when you’re ready\.$/s, key: "calendar.err.denied", names: [] },
  { re: /^Calendar sign-in timed out\. You can try again when you’re ready\.$/s, key: "calendar.err.timeout", names: [] },
  { re: /^Calendar sign-in was cancelled\.$/s, key: "calendar.err.cancelled", names: [] },
  { re: /^You allowed access for (.+?)\. Sign in as (.+?) to sync this mailbox’s calendar\.$/s, key: "calendar.err.wrongAccount", names: ["signedIn", "mailbox"] },
  { re: /^Hey Look! needs every calendar permission it asked for\. Try again and keep all boxes ticked\.$/s, key: "calendar.err.partial", names: [] },
  { re: /^This build of Hey Look! can’t sync calendars with (.+)\.$/s, key: "calendar.err.noClient", names: ["provider"] },
];

/**
 * The sentence for the backend's calendar sync errors ("CAL_CONFLICT: text"), or null for any other error. A sentence the app knows
 * is shown in the language in use; any other text of such an error is shown as the backend wrote it.
 */
export function calendarErrorText(raw: string): string | null {
  const m = /^CAL_(OFFLINE|CONFLICT|GONE|READ_ONLY|AUTH|BUSY|NOT_SET_UP|DENIED|WRONG_ACCOUNT|PARTIAL|TIMEOUT|CANCELLED|BLOCKED|ERROR):\s*(.+)$/s.exec(raw.trim());
  if (!m) return null;
  const text = m[2].trim();
  for (const e of BACKEND_ERRORS) {
    const hit = e.re.exec(text);
    if (!hit) continue;
    const params: Record<string, string> = {};
    e.names.forEach((n, i) => (params[n] = hit[i + 1]));
    return t(e.key, params);
  }
  return text;
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
  const svc = service || t("calendar.sync.ownApp");
  const calendar = calendarName(label);
  return {
    title: t("calendar.delete.title"),
    body: guests > 0 ? t("calendar.delete.bodyGuests", { calendar, service: svc }) : t("calendar.delete.body", { calendar, service: svc }),
  };
}

/** The setting that remembers the sidebar offer was answered (or that a calendar was connected); `"1"` = done, for every mailbox. */
export const CAL_OFFER_DONE = "cal_offer_done";

export interface CalendarOffer {
  accountId: string;
  email: string;
  kind: SyncKind;
}

/**
 * The mailbox the Calendar sidebar offers calendar sync for (W7.9, REQ-7.9.8): the first mailbox, in account order, that can sync
 * (`calendarSyncKind`), whose service this build can connect (`kinds`) and that has no calendar source yet. Null once the offer was
 * answered (`done` = "1") and while `kinds` (null) or `done` (undefined) are not read yet, so a mailbox that already syncs never
 * sees the notice flash up. `sources` must be the loaded list.
 */
export function calendarOffer(
  accounts: { id: string; email: string; auth: string; imapHost: string }[],
  sources: { accountId: string }[],
  kinds: string[] | null,
  done: string | null | undefined,
): CalendarOffer | null {
  if (done === undefined || done === "1" || kinds === null) return null;
  for (const a of accounts) {
    const kind = calendarSyncKind(a);
    if (kind && kinds.includes(kind) && !sources.some((s) => s.accountId === a.id)) return { accountId: a.id, email: a.email, kind };
  }
  return null;
}

/**
 * How the calendar step of Add account ended when `calendar_connect` failed (REQ-7.9.5): a cancelled consent is the person's Skip (nothing to
 * say, the account is already added); any other end keeps the card with Retry and Continue and its notice.
 */
export function calendarStepFailure(e: unknown): "skip" | "failed" {
  return calendarErrorCode(String(e)) === "CANCELLED" ? "skip" : "failed";
}
