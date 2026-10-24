// Moving an event to another calendar (W7.5): which calendars are offered and when guests stop the move (src/calendarMove.ts), who may make a calendar (src/calendarSync.ts), and the three-place rule of the new commands.
// Run: node --experimental-strip-types scripts/test-calendar-move.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guestCount, guestsBlock, moveTargets } from "../src/calendarMove.ts";
import { canCreateCalendar, sourceService } from "../src/calendarSync.ts";

const cal = (id, accountId, over = {}) => ({ id, name: id, color: "", accountId, visible: true, remote: id !== "local" && !id.startsWith("invites:"), writable: true, service: "Google Calendar", ...over });
const cals = [
  cal("local", null, { remote: false }),
  cal("invites:a2", "a2", { remote: false, writable: false }),
  cal("google:a2:primary", "a2"),
  cal("google:a2:work", "a2"),
  cal("google:a2:holidays", "a2", { writable: false }),
  cal("ms:a4:primary", "a4", { service: "Outlook", movesGuests: false }),
  cal("ms:a4:family", "a4", { service: "Outlook", movesGuests: false }),
  cal("caldav:a5:work", "a5", { service: "Nextcloud", movesGuests: true }),
  cal("caldav:a5:team", "a5", { service: "Nextcloud", movesGuests: true }),
];
const ids = (l) => l.map((c) => c.id);
const ev = (calendarId, over = {}) => ({ calendarId, readOnly: null, attendees: [], ...over });

// the targets: the same mailbox for a synced event, every writable synced calendar for My events
assert.deepEqual(ids(moveTargets(ev("google:a2:primary"), cals)), ["google:a2:work"], "not itself, not the read-only calendar, not another mailbox");
assert.deepEqual(ids(moveTargets(ev("ms:a4:primary"), cals)), ["ms:a4:family"]);
assert.deepEqual(ids(moveTargets(ev("local"), cals)), ["google:a2:primary", "google:a2:work", "ms:a4:primary", "ms:a4:family", "caldav:a5:work", "caldav:a5:team"], "My events: every writable synced calendar");
assert.deepEqual(moveTargets(ev("google:a2:holidays"), cals), [], "an event of a read-only calendar stays");
assert.deepEqual(moveTargets(ev("google:a2:primary", { readOnly: "organizer" }), cals), [], "an event only its organizer may change stays");
assert.deepEqual(moveTargets(ev("invites:a2"), cals), [], "an invitation stays");
assert.deepEqual(moveTargets(ev("caldav:a5:work"), [cal("caldav:a5:work", "a5")]), [], "no other calendar: no Move");
assert.deepEqual(ids(moveTargets(ev("local"), cals.map((c) => (c.id === "google:a2:work" ? { ...c, foldedInto: "x" } : c)))).includes("google:a2:work"), false, "an entry that is folded into another is not a target");

// the guests: the chair entry of an event the user organizes is not a guest
const chair = { email: "me@x.y", role: "chair", status: "accepted" };
const g = { email: "g@x.y", role: "required", status: "needs-action" };
assert.equal(guestCount({ attendees: [chair] }), 0);
assert.equal(guestCount({ attendees: [chair, g] }), 1);
const t = (id) => moveTargets(ev(id), cals);
assert.equal(guestsBlock(ev("google:a2:primary", { attendees: [g] }), cals, t("google:a2:primary")), null, "Google moves an event with guests");
assert.equal(guestsBlock(ev("ms:a4:primary", { attendees: [chair, g] }), cals, t("ms:a4:primary")), "Outlook", "Outlook has no move: the sentence names it");
assert.equal(guestsBlock(ev("ms:a4:primary", { attendees: [chair] }), cals, t("ms:a4:primary")), null, "no guests, no block");
assert.equal(guestsBlock(ev("caldav:a5:work", { attendees: [g] }), cals, t("caldav:a5:work")), null, "a CalDAV server that sends no invitations moves it");
assert.equal(guestsBlock(ev("caldav:a5:work", { attendees: [g] }), cals.map((c) => (c.service === "Nextcloud" ? { ...c, movesGuests: false } : c)), t("caldav:a5:work")), "Nextcloud", "one that does would send them again");
assert.equal(guestsBlock(ev("local", { attendees: [chair, g] }), cals, t("local")), "Google Calendar", "My events with guests: named by the first target");

// who may make a calendar: Outlook and CalDAV; Google not until its permission is part of the consent
assert.equal(canCreateCalendar("microsoft"), true);
assert.equal(canCreateCalendar("caldav"), true);
assert.equal(canCreateCalendar("google"), false, "owner step O-03 (GOOGLE_CREATE_CALENDARS)");
assert.equal(sourceService({ kind: "caldav", dav: { label: "Nextcloud", host: "cloud.example.org" } }), "Nextcloud");
assert.equal(sourceService({ kind: "caldav", dav: { label: "", host: "cloud.example.org" } }), "cloud.example.org");
assert.equal(sourceService({ kind: "microsoft" }), "Outlook");
assert.equal(sourceService({ kind: "google" }), "Google Calendar");

// the three-place rule for the new commands
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
for (const cmd of ["calendar_move_event", "calendar_create_calendar", "calendar_set_color"]) {
  const perm = "allow-" + cmd.replace(/_/g, "-");
  assert.ok(read("src-tauri/build.rs").includes(`"${cmd}"`), `${cmd} in APP_COMMANDS`);
  assert.ok(read("src-tauri/src/lib.rs").includes(`calsync::cmds::${cmd},`), `${cmd} in generate_handler`);
  for (const f of ["default", "settings"]) assert.ok(read(`src-tauri/capabilities/${f}.json`).includes(`"${perm}"`), `${perm} in capabilities/${f}.json`);
  assert.ok(read("src/api.ts").includes(`"${cmd}"`), `${cmd} in api.ts`);
}
console.log("calendar move: all checks passed");
