// Calendar sync (Google Calendar / Outlook): which mailboxes get the switch, the status line of every state, the read-only notes,
// the calendar choice of a new event and the error sentences. Checks src/calendarSync.ts.
// Run: node --experimental-strip-types scripts/test-calendar-sync.mjs
import assert from "node:assert/strict";
import {
  calendarErrorCode, calendarErrorText, calendarName, calendarSyncKind, defaultCalendar, deleteConfirm, isSyncedCalendarId, lastSyncedText,
  pausedSources, readOnlyNote, statusLine, syncedColor, truncatedNote, writableCalendars, CALENDAR_SYNC_KINDS,
} from "../src/calendarSync.ts";

// ---- who gets the switch (AC-1)
assert.equal(calendarSyncKind({ auth: "oauth_google", imapHost: "imap.gmail.com" }), "google");
assert.equal(calendarSyncKind({ auth: "password", imapHost: "IMAP.GMAIL.COM" }), "google", "Gmail with an app password");
assert.equal(calendarSyncKind({ auth: "password", imapHost: "imap.mail.me.com" }), null, "iCloud has none");
assert.equal(calendarSyncKind({ auth: "password", imapHost: "mail.example.com" }), null);
// Microsoft is listed by the build only when its provider is shipped
assert.equal(calendarSyncKind({ auth: "oauth_microsoft", imapHost: "outlook.office365.com" }), CALENDAR_SYNC_KINDS.includes("microsoft") ? "microsoft" : null);
assert.ok(CALENDAR_SYNC_KINDS.includes("google"));

// ---- ids
assert.ok(isSyncedCalendarId("google:acc:primary") && isSyncedCalendarId("ms:acc:x") && isSyncedCalendarId("caldav:a:b"));
assert.ok(!isSyncedCalendarId("local") && !isSyncedCalendarId("invites:google:1"));
assert.equal(calendarName("Work · me@gmail.com"), "Work");
assert.equal(calendarName("Plain"), "Plain");

// ---- the status line (design 6.1)
const NOW = 1_800_000_000;
const clock = (sec) => `T${sec}`;
const ctx = { email: "me@gmail.com", nowSec: NOW, fmtTime: clock };
const src = (over) => ({ id: "a:google", accountId: "a", kind: "google", status: "ok", lastSync: NOW - 5, lastError: null, retryAt: null, firstSync: false, calendars: [], ...over });
const line = (over) => statusLine(src(over), ctx);

assert.deepEqual(line({}), { text: "Last synced just now", tone: "muted", syncNow: "on", allow: false });
assert.equal(line({ lastSync: NOW - 5 * 60 - 3 }).text, "Last synced 5 min ago");
assert.equal(line({ lastSync: NOW - 2 * 3600 }).text, `Last synced at T${NOW - 2 * 3600}`);
assert.equal(lastSyncedText(null, NOW, clock), "Not synced yet");
assert.equal(lastSyncedText(NOW + 30, NOW, clock), "Last synced just now", "a clock that is a little behind");
assert.deepEqual(line({ status: "syncing", firstSync: true }), { text: "Downloading your calendars…", tone: "muted", syncNow: "disabled", allow: false });
assert.deepEqual(line({ status: "syncing" }), { text: "Syncing…", tone: "muted", syncNow: "disabled", allow: false });
assert.deepEqual(line({ status: "offline" }), { text: "Offline. The calendar shows the events saved on this computer.", tone: "muted", syncNow: "on", allow: false });
assert.equal(line({ status: "busy", retryAt: NOW + 120 }).text, "Google Calendar is busy. Hey Look! tries again in 2 min.");
assert.equal(line({ status: "busy", retryAt: NOW + 5 }).text, "Google Calendar is busy. Hey Look! tries again in 1 min.", "never 0 min");
assert.equal(line({ status: "busy", retryAt: NOW - 5 }).text, "Google Calendar is busy. Hey Look! tries again in 1 min.");
assert.deepEqual(line({ status: "auth" }), { text: "Calendar access for me@gmail.com ended. Allow access again to keep syncing.", tone: "bad", syncNow: "off", allow: true });
assert.deepEqual(line({ status: "blocked", lastError: "admin_policy_enforced" }), {
  text: "me@gmail.com’s organization hasn’t approved Hey Look! for calendar access. Ask your IT admin.", tone: "bad", syncNow: "off", allow: true,
});
assert.deepEqual(line({ status: "notsetup", lastError: "Google Calendar API has not been used in project 1 before" }), {
  text: "Calendar sync isn’t available in this version of Hey Look! (Google reported: Google Calendar API has not been used in project 1 before).",
  tone: "bad", syncNow: "off", allow: false,
});
assert.equal(line({ status: "notsetup", lastError: null }).text, "Calendar sync isn’t available in this version of Hey Look! (Google reported: no reason given).");
assert.deepEqual(line({ status: "error", lastError: "HTTP 500", retryAt: NOW + 240 }), {
  text: "Couldn’t sync the calendar: HTTP 500. Hey Look! tries again in 4 min.", tone: "muted", syncNow: "on", allow: false,
});
assert.equal(statusLine(src({ kind: "microsoft", status: "busy", retryAt: NOW + 60 }), ctx).text, "Outlook is busy. Hey Look! tries again in 1 min.");

// ---- too many events, and the sidebar notice
const cal = (over) => ({ id: "google:a:x", name: "Big", color: "#039be5", readOnly: false, primary: false, syncOn: true, eventCount: 25000, truncated: false, ...over });
assert.equal(truncatedNote(src({ calendars: [cal({})] })), null);
assert.equal(truncatedNote(src({ calendars: [cal({ truncated: true })] })), "Only part of Big was downloaded: it has more than 25,000 events.");
assert.equal(truncatedNote(src({ calendars: [cal({ truncated: true, syncOn: false })] })), null, "a calendar that is off says nothing");
const all = [src({ id: "1" }), src({ id: "2", status: "auth" }), src({ id: "3", status: "blocked" }), src({ id: "4", status: "error" }), src({ id: "5", status: "offline" })];
assert.deepEqual(pausedSources(all).map((s) => s.id), ["2", "3"], "only the states that need the person");

// ---- read-only notes (AC-10)
assert.equal(readOnlyNote({ readOnly: "repeating" }, "Work · me@x.y", "Google Calendar"), "Repeating events of Work can be changed in Google Calendar for now.");
assert.equal(readOnlyNote({ readOnly: "calendar" }, "Holidays · me@x.y", "Google Calendar"), "Holidays is read only.");
assert.equal(readOnlyNote({ readOnly: "organizer" }, "Work · me@x.y", "Google Calendar"), "Only the organizer can change this event.");
assert.equal(readOnlyNote({ readOnly: null }, "Work", "Google Calendar"), null);
assert.equal(readOnlyNote({}, "Work", "Google Calendar"), null);

// ---- delete confirm
assert.deepEqual(deleteConfirm("Work · me@x.y", "Google Calendar", 0), { title: "Delete this event?", body: "It’s also deleted from Work in Google Calendar." });
assert.equal(deleteConfirm("Work", "Google Calendar", 2).body, "It’s also deleted from Work in Google Calendar. Guests get a cancellation from Google Calendar.");

// ---- the calendar of a new event (REQ-19)
const info = (id, over = {}) => ({ id, name: id, color: "", accountId: null, visible: true, remote: id.includes(":"), writable: true, ...over });
const cals = [info("local", { remote: false }), info("invites:a", { remote: false, writable: false }), info("google:a:work"), info("google:a:holidays", { writable: false })];
assert.deepEqual(writableCalendars(cals).map((c) => c.id), ["local", "google:a:work"]);
assert.equal(defaultCalendar(cals, "google:a:work"), "google:a:work");
assert.equal(defaultCalendar(cals, "google:a:holidays"), "local", "a read-only calendar is never the default");
assert.equal(defaultCalendar(cals, "google:gone:x"), "local", "a calendar that disappeared");
assert.equal(defaultCalendar(cals, ""), "local");
assert.equal(defaultCalendar([], "google:a:work"), "local");

// ---- colours
assert.equal(syncedColor({ color: "#d50000" }, "#0f6cbd"), "#d50000");
assert.equal(syncedColor({ color: "" }, "#0f6cbd"), "#0f6cbd");
assert.equal(syncedColor(undefined, undefined), undefined);

// ---- errors of the backend (shown as they are, not turned into mail-server advice)
assert.equal(calendarErrorText("CAL_CONFLICT: This event was changed in Google Calendar, so its latest version is shown."), "This event was changed in Google Calendar, so its latest version is shown.");
assert.equal(calendarErrorText("CAL_TIMEOUT: Calendar sign-in timed out. Turn the switch on to try again."), "Calendar sign-in timed out. Turn the switch on to try again.");
assert.equal(calendarErrorText("CAL_OFFLINE: You’re offline. Changes to Work need a connection."), "You’re offline. Changes to Work need a connection.");
assert.equal(calendarErrorText("CAL_WRONG_ACCOUNT: You allowed access for x@y.z. Sign in as a@b.c to sync this mailbox’s calendar."), "You allowed access for x@y.z. Sign in as a@b.c to sync this mailbox’s calendar.");
assert.equal(calendarErrorText("CAL_SEND_FAILED: The event was saved, but the invitations weren't sent"), null, "mail errors keep their own handling");
assert.equal(calendarErrorText("something else"), null);
assert.equal(calendarErrorCode("CAL_CANCELLED: Calendar sign-in was cancelled."), "CANCELLED");
assert.equal(calendarErrorCode("Error: CAL_GONE: x"), null, "the code is at the start");
assert.equal(calendarErrorCode("nothing"), null);

console.log("calendar sync: all checks passed");
