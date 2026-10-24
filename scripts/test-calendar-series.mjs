// Repeating events, W7.1 (src/calendarSeries.ts, src/devMockSeries.ts, the wiring in src/components/Calendar.tsx): the question before an event of a series opens or is deleted (its choices
// per case), the title and note of the event form per part of the series, when saving asks "Change every occurrence?", the toasts, the sentence for a repeat rule the app cannot change,
// the 21 new texts in 8 languages (and the three that went), the wiring (the question comes before the dialog, the delete questions are one function), and the dev preview's scopes (the same
// rules as src-tauri/src/calseries.rs: the DST, all-day and zone cases of the spec).
// Run: node --experimental-strip-types scripts/test-calendar-series.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deletedToast, dialogTitleKey, needsResetQuestion, savedToastKey, scopeAsk, scopeNote, slotOf } from "../src/calendarSeries.ts";
import { calendarErrorText } from "../src/calendarSync.ts";
import { deleteScoped, expandRow, getScoped, saveScoped, slots, splitRule } from "../src/devMockSeries.ts";
import { eventKey } from "../src/popout/windowKinds.ts";
import { LANGUAGES, loadDict } from "./lib/i18n-dicts.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// ---- the question (REQ-7.1.1)
{
  const q = scopeAsk("open", { summary: "Weekly sync", firstOccurrence: false });
  assert.equal(q.title, "Open a repeating event");
  assert.equal(q.body, "“Weekly sync” is part of a series. What do you want to open?");
  assert.deepEqual(q.choices.map((c) => [c.id, c.label, c.kind]), [["occurrence", "This occurrence", "primary"], ["following", "This and following", undefined], ["series", "The whole series", undefined], ["cancel", "Cancel", undefined]]);
  assert.equal(q.dismiss, "cancel", "Esc and a click outside cancel (the first choice would be This occurrence)");
  const first = scopeAsk("open", { summary: "x", firstOccurrence: true });
  assert.deepEqual(first.choices.map((c) => c.id), ["occurrence", "series", "cancel"], "the first occurrence has no This and following");
  const del = scopeAsk("delete", { summary: "Weekly sync" }, "It’s also deleted from Work in Google Calendar.");
  assert.equal(del.title, "Delete a repeating event");
  assert.equal(del.body, "“Weekly sync” is part of a series. What do you want to delete? It’s also deleted from Work in Google Calendar.", "a synced calendar adds its sentence about the service and the guests");
  assert.equal(scopeAsk("delete", { summary: "x" }, null).body, "“x” is part of a series. What do you want to delete?");
}

// ---- the form
assert.equal(dialogTitleKey("occurrence", true), "calendar.dialog.editOccurrence");
assert.equal(dialogTitleKey("following", true), "calendar.dialog.editFollowing");
assert.equal(dialogTitleKey("series", true), "calendar.dialog.editSeries");
assert.equal(dialogTitleKey(undefined, true), "calendar.dialog.editTitle");
assert.equal(dialogTitleKey(undefined, false), "calendar.newEvent");
assert.equal(scopeNote("occurrence", "Tue, 27 Oct 2026"), "Changes apply only to the occurrence on Tue, 27 Oct 2026.");
assert.equal(scopeNote("following", "Tue, 10 Nov 2026"), "Changes apply from Tue, 10 Nov 2026 on. Earlier occurrences stay as they are.");
assert.equal(scopeNote("series", "x"), null, "the whole series keeps the repeat note by the Repeat choice");
assert.equal(scopeNote(undefined, "x"), null);

// ---- when saving asks (REQ-7.1.3)
{
  const n = needsResetQuestion;
  const base = { scope: "series", synced: false, changedCount: 1, timeChanged: true, ruleChanged: false };
  assert.equal(n(base), true, "My events: the time changes and an occurrence was changed one by one");
  assert.equal(n({ ...base, timeChanged: false, ruleChanged: true }), true);
  assert.equal(n({ ...base, timeChanged: false }), false, "a title-only change goes to the series without a question");
  assert.equal(n({ ...base, changedCount: 0 }), false, "no occurrence was changed: nothing to lose");
  assert.equal(n({ ...base, changedCount: 0, synced: true }), true, "Google and Outlook: always when the time or rule changed");
  assert.equal(n({ ...base, scope: "following" }), true);
  assert.equal(n({ ...base, scope: "occurrence" }), false);
  assert.equal(n({ ...base, scope: undefined }), false);
}

// ---- toasts and slots
assert.equal(savedToastKey("occurrence", false), "calendar.toast.occurrenceSaved");
assert.equal(savedToastKey("following", false), "calendar.toast.seriesSaved");
assert.equal(savedToastKey("series", false), "calendar.toast.seriesSaved");
assert.equal(savedToastKey(undefined, false), "calendar.toast.eventSaved");
assert.equal(savedToastKey(undefined, true), "calendar.toast.eventAdded");
assert.equal(deletedToast("occurrence", "x"), "Occurrence deleted");
assert.equal(deletedToast("following", "Tue, 10 Nov 2026"), "Occurrences from Tue, 10 Nov 2026 on deleted");
assert.equal(deletedToast("series", "x"), null, "the whole series says what it always said");
assert.equal(slotOf({ series: true, occurrenceStart: 123 }), 123);
assert.equal(slotOf({ series: false, occurrenceStart: 123 }), undefined, "a single event has no slot");
assert.equal(slotOf({ series: true, occurrenceStart: null }), undefined);
assert.equal(eventKey("e1", "occurrence", 99), "event:e1:occurrence:99", "another occurrence is another window");
assert.equal(eventKey("e1", undefined, undefined), "event:e1");

// ---- the sentence for a repeat rule the app cannot change, as the backend writes it
assert.equal(calendarErrorText("CAL_READ_ONLY: Hey Look! can’t change this repeat rule. You can change it in Outlook."), "Hey Look! can’t change this repeat rule. You can change it in Outlook.");
assert.equal(calendarErrorText("CAL_READ_ONLY: Only the organizer can change this event."), "Only the organizer can change this event.");

// ---- the texts: 21 new, 3 gone, 8 languages
const NEW = [
  "calendar.series.openTitle", "calendar.series.openBody", "calendar.series.deleteTitle", "calendar.series.deleteBody", "calendar.series.this", "calendar.series.following", "calendar.series.all",
  "calendar.dialog.editOccurrence", "calendar.dialog.editFollowing", "calendar.dialog.editSeries", "calendar.dialog.occurrenceNote", "calendar.dialog.followingNote",
  "calendar.series.resetTitle", "calendar.series.resetBody", "calendar.series.resetConfirm", "calendar.pop.changedOccurrence",
  "calendar.toast.occurrenceSaved", "calendar.toast.seriesSaved", "calendar.toast.occurrenceDeleted", "calendar.toast.followingDeleted", "calendar.sync.patternUnsupported",
];
const GONE = ["calendar.sync.readOnlyRepeating", "calendar.sync.repeatAddOnly", "calendar.pop.deleteRepeating"];
for (const l of LANGUAGES) {
  const d = await loadDict(l.code);
  assert.ok(d, `${l.code} loads`);
  for (const k of NEW) assert.ok(typeof d[k] === "string" && d[k].length > 0, `${l.code} has ${k}`);
  for (const k of GONE) assert.ok(!(k in d), `${l.code} no longer has ${k}`);
  // the placeholders the code fills
  assert.ok(d["calendar.series.openBody"].includes("{summary}") && d["calendar.series.deleteBody"].includes("{summary}"), `${l.code}: {summary}`);
  assert.ok(d["calendar.dialog.occurrenceNote"].includes("{date}") && d["calendar.dialog.followingNote"].includes("{date}") && d["calendar.toast.followingDeleted"].includes("{date}"), `${l.code}: {date}`);
  assert.ok(d["calendar.sync.patternUnsupported"].includes("{service}"), `${l.code}: {service}`);
}
{
  const fr = await loadDict("fr");
  assert.equal(fr["calendar.series.openBody"], "« {summary} » fait partie d’une série. Que voulez-vous ouvrir ?", "fr: no-break spaces inside « » and before ?");
  const de = await loadDict("de");
  assert.equal(de["calendar.dialog.editFollowing"], "Diesen und alle folgenden Termine bearbeiten");
  const ja = await loadDict("ja");
  assert.equal(ja["calendar.series.this"], "この回のみ");
}

// ---- the wiring
{
  const cal = read("src/components/Calendar.tsx");
  const edit = cal.slice(cal.indexOf("async function openEventForEdit"), cal.indexOf("async function openEventForEdit") + 1400);
  assert.ok(edit.indexOf("scopeAsk(\"open\", ev)") > 0 && edit.indexOf("scopeAsk(\"open\", ev)") < edit.indexOf("setDialog("), "the question is asked before the dialog opens");
  assert.ok(/if \(a === "cancel"\) return false;/.test(edit), "Cancel opens nothing");
  assert.ok(cal.includes("deleteEventAsked(ev, syncedCal, tz,") && cal.includes("deleteEventAsked(target, calInfo, tz,"), "the popover and the event window ask the same delete questions");
  assert.ok(!cal.includes("calendar.pop.deleteRepeating") && !cal.includes("calendar.sync.repeatAddOnly") && !cal.includes("calendar.sync.readOnlyRepeating"), "the removed texts are not used");
  assert.ok(/scope !== "occurrence" && \(/.test(cal), "an occurrence has no Repeat choice");
  assert.ok(cal.includes("disabled={!!existing?.patternUnsupported}") && !cal.includes("disabled={remote}"), "Repeat is enabled in a synced calendar, disabled only for a pattern the app cannot change");
  assert.ok(cal.includes("data-changed-occurrence") && cal.includes("calendar.pop.changedOccurrence"), "the popover says a changed occurrence was changed");
  const rs = read("src-tauri/src/calsync/store.rs");
  assert.ok(!/Some\("repeating"\)/.test(rs.slice(rs.indexOf("fn read_only_for"), rs.indexOf("fn read_only_for") + 600)), "a repeating event is not read-only");
}
for (const f of ["src-tauri/src/lib.rs"]) assert.ok(read(f).includes("mod calseries;") && read(f).includes("mod recur;"), "the modules are in the crate");

// ---- the dev preview's scopes (the same rules as the backend)
{
  const BERLIN = "Europe/Berlin";
  const at = (iso) => Date.parse(iso) / 1000;
  // Tue 13 Oct 2026 09:00 Berlin = 07:00Z (summer time); from 25 Oct the offset is +1
  const start = at("2026-10-13T07:00:00Z");
  const series = { id: "s", uid: "s@mock", calendarId: "local", summary: "Weekly sync", start, end: start + 3600, allDay: false, tzid: BERLIN, rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=8", exdates: [] };
  const hm = (t) => new Date(t * 1000).toLocaleString("en-GB", { timeZone: BERLIN, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const list = (rows) => rows.flatMap((r) => expandRow(r, at("2026-10-01T00:00:00Z"), at("2027-01-01T00:00:00Z"))).sort((a, b) => a.start - b.start).map((r) => `${r.summary} ${hm(r.start)}`);
  let id = 100;
  const newId = () => `n${++id}`;
  const all = slots(series, at("2027-01-01T00:00:00Z"));
  assert.equal(all.length, 8);
  assert.deepEqual(all.map((s) => hm(s).slice(-5)), Array(8).fill("09:00"), "09:00 Berlin on both sides of the change of 25 Oct");
  assert.equal(all[2] - all[1], 7 * 86400 + 3600, "27 Oct is an hour later in UTC");
  // AC-7.1.1 / 7.1.2: 27 Oct to 11:00, delete 3 Nov
  const slot = all[2];
  let rows = saveScoped([series], { id: "s", summary: "Weekly sync", start: at("2026-10-27T10:00:00Z"), end: at("2026-10-27T11:00:00Z"), allDay: false, scope: "occurrence", occurrenceStart: slot }, "occurrence", newId).rows;
  assert.equal(list(rows).filter((x) => x.includes("27/10")).join(), "Weekly sync 27/10, 11:00");
  assert.equal(list(rows).length, 8);
  rows = deleteScoped(rows, "s", "occurrence", all[3]);
  assert.equal(list(rows).length, 7);
  // the flags the views need
  const ex = rows.flatMap((r) => expandRow(r, at("2026-10-01T00:00:00Z"), at("2027-01-01T00:00:00Z")));
  assert.ok(ex.every((r) => r.series === true));
  assert.ok(ex.find((r) => r.start === all[0]).firstOccurrence === true && ex.find((r) => r.start === all[1]).firstOccurrence === false);
  assert.ok(ex.find((r) => r.changedOccurrence)?.occurrenceStart === slot, "a changed occurrence keeps its slot");
  // AC-7.1.4 / 7.1.5
  const detail = getScoped(rows, "s", "series", null);
  assert.equal(detail.changedCount, 1);
  const titleOnly = saveScoped(rows, { id: "s", summary: "New title", start, end: start + 3600, allDay: false, rrule: series.rrule, scope: "series" }, "series", newId).rows;
  assert.ok(list(titleOnly).includes("New title 27/10, 11:00"), "title only: the changed occurrence keeps its time and takes the new title");
  const later = saveScoped(rows, { id: "s", summary: "Weekly sync", start: start + 3600, end: start + 7200, allDay: false, rrule: series.rrule, scope: "series" }, "series", newId).rows;
  assert.deepEqual(list(later).map((x) => x.slice(-5)), Array(7).fill("10:00"), "every occurrence at 10:00, 3 Nov still deleted");
  assert.ok(!list(later).some((x) => x.includes("03/11")));
  // AC-7.1.3: this and following from 10 Nov
  const slot10 = all[4];
  const fol = saveScoped(rows, { id: "s", summary: "Late sync", start: slot10, end: slot10 + 3600, allDay: false, rrule: series.rrule, scope: "following", occurrenceStart: slot10 }, "following", newId).rows;
  assert.deepEqual(list(fol), ["Weekly sync 13/10, 09:00", "Weekly sync 20/10, 09:00", "Weekly sync 27/10, 11:00", "Late sync 10/11, 09:00", "Late sync 17/11, 09:00", "Late sync 24/11, 09:00", "Late sync 01/12, 09:00"]);
  // the first occurrence has only the whole series
  const firstOnly = saveScoped(rows, { id: "s", summary: "Same uid", start, end: start + 3600, allDay: false, rrule: series.rrule, scope: "following", occurrenceStart: start }, "following", newId).rows;
  assert.equal(new Set(firstOnly.map((r) => r.uid)).size, 1);
  // delete following and the whole series
  const cut = deleteScoped(rows, "s", "following", slot10);
  assert.equal(list(cut).length, 3);
  assert.equal(cut.find((r) => r.id === "s").rrule, "FREQ=WEEKLY;BYDAY=TU;COUNT=4");
  assert.equal(deleteScoped(rows, "s", "series", null).length, 0);
  // split rules: COUNT is divided, anything else gets UNTIL
  assert.deepEqual(splitRule(series, slot10), { old: "FREQ=WEEKLY;BYDAY=TU;COUNT=4", next: "FREQ=WEEKLY;BYDAY=TU;COUNT=4" });
  assert.equal(splitRule({ ...series, rrule: "FREQ=WEEKLY;BYDAY=TU" }, slot10).old, "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261110T075959Z", "one second before the slot, in UTC");
  // all day: UNTIL is the day before, as a date
  const mon = at("2026-10-12T00:00:00Z");
  const day = { ...series, id: "d", uid: "d@mock", allDay: true, tzid: null, start: mon, end: mon + 86400, rrule: "FREQ=WEEKLY;BYDAY=MO" };
  assert.equal(splitRule(day, at("2026-11-02T00:00:00Z")).old, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101");
  // the form of a part: the changed occurrence's own values, the occurrence's with the rule of the series
  const f = getScoped(rows, "s", "following", slot10);
  assert.equal(f.rrule, series.rrule);
  assert.equal(f.changedCount, 0);
  assert.equal(getScoped(rows, "s", "occurrence", slot).start, at("2026-10-27T10:00:00Z"));
  // a rule the app cannot change
  const locked = { ...series, summary: "Odd [pattern]" };
  const g = getScoped([locked], "s", "series", null);
  assert.equal(g.patternUnsupported, true);
  assert.equal(g.rrule, null);
}

console.log("calendar series: all checks passed");
