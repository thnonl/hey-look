// Calendar sync (Google Calendar / Outlook): which mailboxes get the switch, the status line of every state, the read-only notes,
// the calendar choice of a new event and the error sentences. Checks src/calendarSync.ts.
// Run: node --experimental-strip-types scripts/test-calendar-sync.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calendarDavEligible, calendarErrorCode, calendarErrorText, calendarName, calendarOffer, calendarStepFailure, calendarSyncKind, defaultCalendar, deleteConfirm, foldTarget, isSyncedCalendarId, lastSyncedText,
  davPreset, pausedSources, readOnlyNote, sidebarCalendars, statusLine, syncedColor, truncatedNote, writableCalendars, CALENDAR_SYNC_KINDS,
} from "../src/calendarSync.ts";
import { LANGUAGES, loadLanguage, setLangPref, t } from "../src/i18n/index.ts";

// ---- who gets the switch (AC-1)
assert.equal(calendarSyncKind({ auth: "oauth_google", imapHost: "imap.gmail.com" }), "google");
assert.equal(calendarSyncKind({ auth: "password", imapHost: "IMAP.GMAIL.COM" }), "google", "Gmail with an app password");
assert.equal(calendarSyncKind({ auth: "password", imapHost: "imap.mail.me.com" }), null, "iCloud has none");
assert.equal(calendarSyncKind({ auth: "password", imapHost: "mail.example.com" }), null);
// Microsoft mailboxes (Outlook.com, Hotmail, Microsoft 365) have it too, whatever their IMAP host
assert.equal(calendarSyncKind({ auth: "oauth_microsoft", imapHost: "outlook.office365.com" }), "microsoft");
assert.equal(calendarSyncKind({ auth: "password", imapHost: "outlook.office365.com" }), null, "a password mailbox on Outlook has no OAuth grant to extend");
assert.deepEqual(CALENDAR_SYNC_KINDS, ["google", "microsoft", "caldav"]);

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
  text: "me@gmail.com’s organization may need to approve Hey Look! for calendar access. Ask your IT admin.", tone: "bad", syncNow: "off", allow: false,
});
assert.deepEqual(line({ status: "notsetup", lastError: "Google Calendar API has not been used in project 1 before" }), {
  text: "Calendar sync isn’t available in this version of Hey Look! (Google reported: Google Calendar API has not been used in project 1 before).",
  tone: "bad", syncNow: "off", allow: false,
});
assert.equal(line({ status: "notsetup", lastError: null }).text, "Calendar sync isn’t available in this version of Hey Look! (Google reported: no reason given).");
assert.deepEqual(line({ status: "error", lastError: "HTTP 500", retryAt: NOW + 240 }), {
  text: "Couldn’t sync the calendar. Hey Look! tries again in 4 min.", tone: "muted", syncNow: "on", allow: false, detail: "Details: HTTP 500",
});
assert.equal(statusLine(src({ kind: "microsoft", status: "busy", retryAt: NOW + 60 }), ctx).text, "Outlook is busy. Hey Look! tries again in 1 min.");
// Microsoft: admin approval needed, no mailbox the API reaches
assert.deepEqual(statusLine(src({ kind: "microsoft", status: "blocked", lastError: "AADSTS65001: The user or administrator has not consented" }), { ...ctx, email: "me@contoso.com" }), {
  text: "me@contoso.com’s organization may need to approve Hey Look! for calendar access. Ask your IT admin.", tone: "bad", syncNow: "off", allow: false,
});
assert.equal(
  statusLine(src({ kind: "microsoft", status: "notsetup", lastError: "The mailbox is either inactive, soft-deleted, or is hosted on-premise." }), ctx).text,
  "Calendar sync isn’t available in this version of Hey Look! (Microsoft reported: The mailbox is either inactive, soft-deleted, or is hosted on-premise.).",
);

// ---- too many events, and the sidebar notice
const cal = (over) => ({ id: "google:a:x", name: "Big", color: "#039be5", readOnly: false, primary: false, syncOn: true, eventCount: 25000, truncated: false, ...over });
assert.equal(truncatedNote(src({ calendars: [cal({})] })), null);
assert.equal(truncatedNote(src({ calendars: [cal({ truncated: true })] })), "Only part of Big was downloaded: it has more than 25,000 events.");
assert.equal(truncatedNote(src({ calendars: [cal({ truncated: true, syncOn: false })] })), null, "a calendar that is off says nothing");
const all = [src({ id: "1" }), src({ id: "2", status: "auth" }), src({ id: "3", status: "blocked" }), src({ id: "4", status: "error" }), src({ id: "5", status: "offline" })];
assert.deepEqual(pausedSources(all).map((s) => s.id), ["2", "3"], "only the states that need the person");

// ---- read-only notes (AC-10)
// (a repeating event is no longer read-only since 1.0.7: W7.1)
assert.equal(readOnlyNote({ readOnly: "repeating" }, "Work · me@x.y", "Google Calendar"), null, "a row from 1.0.6 that says repeating is editable now");
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
assert.equal(calendarErrorText("CAL_TIMEOUT: Calendar sign-in timed out. You can try again when you’re ready."), "Calendar sign-in timed out. You can try again when you’re ready.");
assert.equal(calendarErrorText("CAL_OFFLINE: You’re offline. Changes to Work need a connection."), "You’re offline. Changes to Work need a connection.");
assert.equal(calendarErrorText("CAL_WRONG_ACCOUNT: You allowed access for x@y.z. Sign in as a@b.c to sync this mailbox’s calendar."), "You allowed access for x@y.z. Sign in as a@b.c to sync this mailbox’s calendar.");
assert.equal(calendarErrorText("CAL_SEND_FAILED: The event was saved, but the invitations weren't sent"), null, "mail errors keep their own handling");
assert.equal(calendarErrorText("something else"), null);
assert.equal(calendarErrorCode("CAL_CANCELLED: Calendar sign-in was cancelled."), "CANCELLED");
assert.equal(calendarErrorCode("Error: CAL_GONE: x"), null, "the code is at the start");
assert.equal(calendarErrorCode("nothing"), null);

// ---- a build without the OAuth client of the service (W7.8): the backend sentence is mapped to a key, in the language in use
assert.equal(calendarErrorText("CAL_NOT_SET_UP: This build of Hey Look! can’t sync calendars with Google."), "This build of Hey Look! can’t sync calendars with Google.");
assert.equal(calendarErrorText("CAL_NOT_SET_UP: This build of Hey Look! can’t sync calendars with Microsoft."), "This build of Hey Look! can’t sync calendars with Microsoft.");
assert.equal(calendarErrorCode("CAL_NOT_SET_UP: This build of Hey Look! can’t sync calendars with Google."), "NOT_SET_UP");

// ---- one confirmation before the browser opens (W7.7): the connect path of Settings asks first and calls the backend only after "Open browser"
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = fs.readFileSync(path.join(root, "src/components/SettingsDialog.tsx"), "utf8");
const connectAt = settings.indexOf("const connect = async () => {"); // (the CalDAV panel, W7.4, has its own "stop" before it)
const connect = settings.slice(connectAt, settings.indexOf("const stop = async () => {", connectAt));
assert.ok(connect.length > 200 && connect.length < 3000, "found the connect function");
const asked = connect.indexOf("await confirm(");
const called = connect.indexOf("api.calendarConnect(");
assert.ok(asked > 0 && called > asked, "the question comes before the call");
for (const key of ["calendar.consent.title", "calendar.consent.body", "calendar.consent.open"]) assert.ok(connect.includes(key), key);
assert.match(connect.slice(asked, called), /if \(!go\) \{[\s\S]*\.focus\(\);[\s\S]*return;\s*\}/, "Cancel returns before the call and puts the focus back");
// every start of the consent goes through it: the one call site is that function (the switch and "Allow access again" both call connect)
const sites = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name) && !/devMock|api\.ts$/.test(f.name) && fs.readFileSync(p, "utf8").includes("calendarConnect(")) sites.push(path.relative(root, p).split(path.sep).join("/")); } };
walk(path.join(root, "src"));
assert.deepEqual(sites, ["src/components/SettingsDialog.tsx"], "no other start of the calendar consent");
// (and the one other call is the second step of Add account, W7.9: it has no question, the ticked box is the confirmation, D-7.9d)
assert.equal(settings.split("calendarConnect(").length - 1, 2);
const starts = settings.split("onChange={(v) => void (v ? connect() : stop())}").length - 1 + settings.split("onClick={() => void connect()}").length - 1;
assert.equal(starts, 2, "the switch and Allow access again both call connect()");

// ---- the calendar step of Add account (W7.9): only after a mail sign-in that made the account, only with the box ticked, never from "Sign in again"
const oauth = settings.slice(settings.indexOf("function OAuthBlock("), settings.indexOf("const SOURCE_LABEL"));
assert.ok(oauth.length > 3000 && oauth.length < 20000, "found OAuthBlock");
const step = oauth.slice(oauth.indexOf("const calendarStep = async"), oauth.indexOf("const skipCalendar"));
assert.ok(step.includes("api.calendarConnect(acc.id)") && !step.includes("confirm("), "step 2 calls the backend without a question");
const signedIn = oauth.indexOf("await api.googleSignIn(");
assert.ok(signedIn > 0 && oauth.indexOf("void calendarStep(acc)") > signedIn, "the calendar step comes after the mail sign-in");
assert.match(oauth, /alsoCal && showCal && !\(await api\.calendarSources\(\)[^;]*\.some\(\(x\) => x\.accountId === acc\.id\);/, "ticked box, a build that can connect the service, and no source yet");
assert.ok(oauth.includes("useState(true)"), "the box is ticked every time the card opens");
const reauth = fs.readFileSync(path.join(root, "src/components/SignInHelp.tsx"), "utf8");
assert.ok(!reauth.includes("calendarConnect") && !reauth.includes("calendarStep"), "Sign in again never starts a calendar step");
assert.ok(oauth.includes("calendarCancelConnect") && oauth.includes("accountAddedDone(acc, false)") && oauth.includes("accountAddedDone(acc, true)"), "Skip / leaving cancel and finish; success finishes with the calendar toast");
assert.equal(calendarStepFailure("CAL_CANCELLED: Calendar sign-in was cancelled."), "skip");
for (const code of ["DENIED", "TIMEOUT", "WRONG_ACCOUNT", "PARTIAL", "BLOCKED", "NOT_SET_UP", "ERROR"]) assert.equal(calendarStepFailure(`CAL_${code}: x`), "failed", code);
assert.equal(calendarStepFailure("something else"), "failed");

// ---- the sidebar offer for mailboxes that existed before (W7.9, REQ-7.9.8): the first mailbox that can sync and does not, until answered once
const A = (id, email, auth, imapHost) => ({ id, email, auth, imapHost });
const imap = A("a1", "me@fastmail.test", "password", "imap.fastmail.test");
const g = A("a2", "nam@gmail.com", "oauth_google", "imap.gmail.com");
const gp = A("a3", "work@gmail.com", "password", "imap.gmail.com"); // Gmail with an app password counts too (W7.8)
const ms = A("a4", "nam@outlook.com", "oauth_microsoft", "outlook.office365.com");
const both = ["google", "microsoft"];
assert.deepEqual(calendarOffer([imap, g, gp, ms], [], both, null), { accountId: "a2", email: "nam@gmail.com", kind: "google" }, "the first one, in account order");
assert.deepEqual(calendarOffer([imap, ms, g], [], both, null), { accountId: "a4", email: "nam@outlook.com", kind: "microsoft" }, "account order, not the order of the services");
assert.deepEqual(calendarOffer([imap, g, gp, ms], [{ accountId: "a2" }], both, null)?.accountId, "a3", "a mailbox that syncs is skipped");
assert.equal(calendarOffer([imap, g, gp, ms], [{ accountId: "a2" }, { accountId: "a3" }, { accountId: "a4" }], both, null), null, "every eligible mailbox syncs");
assert.equal(calendarOffer([imap, A("a5", "x@example.test", "password", "mail.example.test")], [], both, null), null, "only IMAP mailboxes without a calendar service");
assert.equal(calendarOffer([g, ms], [], both, "1"), null, "answered once, for good");
assert.deepEqual(calendarOffer([g, ms], [], both, ""), calendarOffer([g, ms], [], both, null), "anything but 1 is not an answer");
assert.equal(calendarOffer([g, ms], [], null, null), null, "the services this build can connect are not read yet");
assert.equal(calendarOffer([g, ms], [], both, undefined), null, "the setting is not read yet");
assert.equal(calendarOffer([g, ms], [], [], null), null, "a build without any OAuth client");
assert.equal(calendarOffer([g, ms], [], ["microsoft"], null)?.accountId, "a4", "a service this build cannot connect is skipped");
assert.equal(calendarOffer([], [], both, null), null);
// the backend sentences of a refused / timed out / partial consent no longer tell the person to turn the switch on (it is also seen at Add account)
assert.equal(calendarErrorText("CAL_DENIED: Calendar access wasn’t allowed. You can try again when you’re ready."), "Calendar access wasn’t allowed. You can try again when you’re ready.");
assert.equal(calendarErrorText("CAL_PARTIAL: Hey Look! needs every calendar permission it asked for. Try again and keep all boxes ticked."), "Hey Look! needs every calendar permission it asked for. Try again and keep all boxes ticked.");
const dictEn = fs.readFileSync(path.join(root, "src/i18n/ns/calendar.ts"), "utf8");
assert.ok(dictEn.includes('"calendar.err.denied": "Calendar access wasn’t allowed. You can try again when you’re ready."'));
assert.ok(dictEn.includes('"calendar.err.partial": "Hey Look! needs every calendar permission it asked for. Try again and keep all boxes ticked."'));
// no text of the app, the backend or the tests says "Turn the switch on" any more (AC-7.9.14)
const stale = [];
const scan = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== "target") scan(q); } else if (/\.(tsx?|rs|mjs)$/.test(f.name) && fs.readFileSync(q, "utf8").includes("Turn the switch")) stale.push(path.relative(root, q).split(path.sep).join("/")); } };
scan(path.join(root, "src")); scan(path.join(root, "src-tauri", "src"));
assert.deepEqual(stale.filter((f) => f !== "scripts/test-calendar-sync.mjs"), [], "no text tells the person to turn the switch on");

// ---- the Invitations entry of a synced mailbox is part of its main calendar (W7.11, REQ-7.11.2): not listed, drawn like the calendar it is folded into
const L = (id, extra = {}) => ({ id, name: id, color: "", accountId: null, visible: true, ...extra });
const list = [L("local"), L("invites:a1", { accountId: "a1" }), L("invites:a2", { accountId: "a2", foldedInto: "google:a2:primary" }), L("invites:a4", { accountId: "a4", foldedInto: "ms:a4:primary" }), L("google:a2:primary", { remote: true }), L("ms:a4:primary", { remote: true })];
assert.deepEqual(sidebarCalendars(list).map((c) => c.id), ["local", "invites:a1", "google:a2:primary", "ms:a4:primary"], "the folded entries are left out, the IMAP mailbox keeps its own");
assert.deepEqual(sidebarCalendars([L("local")]).map((c) => c.id), ["local"]);
assert.equal(foldTarget(list, "invites:a2")?.id, "google:a2:primary", "a folded entry follows its calendar");
assert.equal(foldTarget(list, "invites:a1")?.id, "invites:a1", "an unfolded one is itself");
assert.equal(foldTarget(list, "google:a2:primary")?.id, "google:a2:primary");
assert.equal(foldTarget(list, "nothing"), undefined);
assert.equal(foldTarget([L("invites:a9", { foldedInto: "gone" })], "invites:a9")?.id, "invites:a9", "a target that is not listed leaves the entry as it is");

// ---- CalDAV (W7.4): who is offered it, the services of the dialog, the sentences of the server
assert.equal(davPreset("imap.mail.me.com"), "icloud");
assert.equal(davPreset("IMAP.FASTMAIL.COM"), "fastmail");
assert.equal(davPreset("mail.example.com"), "other");
assert.equal(calendarDavEligible({ auth: "password", imapHost: "mail.example.com" }), true);
assert.equal(calendarDavEligible({ auth: "password", imapHost: "imap.gmail.com" }), false, "Gmail has Google Calendar");
assert.equal(calendarDavEligible({ auth: "oauth_microsoft", imapHost: "outlook.office365.com" }), false, "Outlook has its own service");
const dav = { label: "Nextcloud", username: "nam", host: "cloud.example.org", preset: "nextcloud", scheduling: false };
assert.deepEqual(statusLine(src({ kind: "caldav", status: "auth", dav }), ctx), {
  text: "Couldn’t sign in to Nextcloud as nam. Enter the password again to keep syncing.", tone: "bad", syncNow: "off", allow: false, enterPassword: true,
});
assert.equal(statusLine(src({ kind: "caldav", status: "ok", dav }), ctx).enterPassword, undefined);
assert.equal(calendarErrorCode("CAL_DAV_AUTH: Couldn’t sign in to the calendar server. Check the username and the password."), "DAV_AUTH");
assert.equal(calendarErrorText("CAL_DAV_NOT_FOUND: No server answered at this address. Check the server address."), "No server answered at this address. Check the server address.");
assert.equal(calendarErrorText("CAL_DAV_REDIRECT: The server sent Hey Look! to another address (login.example.net). Hey Look! stopped there to keep your password safe."), "The server sent Hey Look! to another address (login.example.net). Hey Look! stopped there to keep your password safe.");

// ---- a calendar that could not be CREATED (fix51): the sentences Rust sends (write.rs create_error_text) are not the "save" / "read only" ones, in the English wording and in every language
assert.equal(calendarErrorText("CAL_ERROR: Couldn’t create the calendar in Outlook: HTTP 500."), "Couldn’t create the calendar in Outlook: HTTP 500.");
assert.equal(calendarErrorText("CAL_ERROR: Couldn’t create the calendar. Nextcloud doesn’t allow it."), "Couldn’t create the calendar. Nextcloud doesn’t allow it.");
assert.equal(calendarErrorCode("CAL_ERROR: Couldn’t create the calendar. Nextcloud doesn’t allow it."), "ERROR");
for (const { code } of LANGUAGES) {
  await loadLanguage(code);
  setLangPref(code);
  const failed = calendarErrorText("CAL_ERROR: Couldn’t create the calendar in Outlook: HTTP 500.");
  const denied = calendarErrorText("CAL_ERROR: Couldn’t create the calendar. Nextcloud doesn’t allow it.");
  assert.equal(failed, t("calendar.err.createFailed", { service: "Outlook", reason: "HTTP 500" }), `${code}: the failure sentence is translated with its reason`);
  assert.equal(denied, t("calendar.err.createDenied", { service: "Nextcloud" }), `${code}: the refusal sentence is translated`);
  assert.ok(failed.includes("Outlook") && failed.includes("HTTP 500") && denied.includes("Nextcloud"), `${code}: service and reason are in the sentences`);
  if (code !== "en") {
    assert.ok(!/Couldn’t|doesn’t allow/.test(failed + denied), `${code}: no English left`);
    assert.notEqual(failed, t("calendar.err.saveFailed", { service: "Outlook", reason: "HTTP 500" }), `${code}: not the save sentence`);
  }
}
await loadLanguage("en");
setLangPref("en");

console.log("calendar sync: all checks passed");
