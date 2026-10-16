// The start and end of an event (event dialog, edit dialog, Compose meeting strip): moving the START moves the END with it and keeps the
// length, later or earlier, all day too; the END never moves the start (it is not touched by moveStart at all). Checks src/dateTimeFields.ts moveStart.
// Run: node --experimental-strip-types scripts/test-event-when.mjs
process.env.TZ = "Europe/Berlin";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { moveStart } = await import("../src/dateTimeFields.ts");

const W = (sd, st, ed, et) => ({ sd, st, ed, et });
const hour = W("2026-10-16", "09:00", "2026-10-16", "10:00");

// ---- timed: the length is kept, whichever way the start moves
assert.deepEqual(moveStart(hour, { st: "11:30" }, false), W("2026-10-16", "11:30", "2026-10-16", "12:30"), "later, past the old end");
assert.deepEqual(moveStart(hour, { st: "09:30" }, false), W("2026-10-16", "09:30", "2026-10-16", "10:30"), "later, before the old end");
assert.deepEqual(moveStart(hour, { st: "07:00" }, false), W("2026-10-16", "07:00", "2026-10-16", "08:00"), "earlier");
assert.deepEqual(moveStart(hour, { st: "09:00" }, false), hour, "same start");
assert.deepEqual(moveStart(hour, { sd: "2026-10-20" }, false), W("2026-10-20", "09:00", "2026-10-20", "10:00"), "date later");
assert.deepEqual(moveStart(hour, { sd: "2026-10-01" }, false), W("2026-10-01", "09:00", "2026-10-01", "10:00"), "date earlier");
assert.deepEqual(moveStart(hour, { sd: "2026-10-20", st: "13:15" }, false), W("2026-10-20", "13:15", "2026-10-20", "14:15"), "both at once");
// across midnight
assert.deepEqual(moveStart(hour, { st: "23:30" }, false), W("2026-10-16", "23:30", "2026-10-17", "00:30"), "end rolls over midnight");
assert.deepEqual(moveStart(W("2026-10-16", "23:00", "2026-10-17", "01:00"), { st: "08:00" }, false), W("2026-10-16", "08:00", "2026-10-16", "10:00"), "a night event comes back");
assert.deepEqual(moveStart(W("2026-10-16", "22:00", "2026-10-18", "10:00"), { sd: "2026-10-30" }, false), W("2026-10-30", "22:00", "2026-11-01", "10:00"), "a multi-day event, month end");
// year end, leap day
assert.deepEqual(moveStart(hour, { sd: "2026-12-31", st: "23:30" }, false), W("2026-12-31", "23:30", "2027-01-01", "00:30"));
assert.deepEqual(moveStart(W("2028-02-28", "10:00", "2028-02-28", "11:00"), { st: "23:45" }, false), W("2028-02-28", "23:45", "2028-02-29", "00:45"));
// a clock change does not shift anything (Berlin: 2026-10-25 02:00-03:00 is repeated, 2026-03-29 02:00 does not exist)
assert.deepEqual(moveStart(W("2026-10-24", "01:00", "2026-10-24", "03:00"), { sd: "2026-10-25" }, false), W("2026-10-25", "01:00", "2026-10-25", "03:00"));
assert.deepEqual(moveStart(W("2026-03-28", "01:00", "2026-03-28", "03:00"), { sd: "2026-03-29" }, false), W("2026-03-29", "01:00", "2026-03-29", "03:00"));
// the length of a long event is kept to the minute
assert.deepEqual(moveStart(W("2026-10-16", "09:00", "2026-10-16", "09:01"), { st: "10:00" }, false), W("2026-10-16", "10:00", "2026-10-16", "10:01"));

// ---- a wrong end (end <= start, shown as an error at Save) stays where it is while the start is still before it ...
const wrong = W("2026-10-16", "09:00", "2026-10-16", "08:00");
assert.deepEqual(moveStart(wrong, { st: "07:00" }, false), W("2026-10-16", "07:00", "2026-10-16", "08:00"), "start moves under a wrong end: end stays");
assert.deepEqual(moveStart(wrong, { st: "07:59" }, false), W("2026-10-16", "07:59", "2026-10-16", "08:00"));
// ... and the event gets an hour when the start reaches the end
assert.deepEqual(moveStart(wrong, { st: "08:00" }, false), W("2026-10-16", "08:00", "2026-10-16", "09:00"), "start reaches the end");
assert.deepEqual(moveStart(wrong, { st: "12:00" }, false), W("2026-10-16", "12:00", "2026-10-16", "13:00"), "start passes the end");
const zero = W("2026-10-16", "09:00", "2026-10-16", "09:00");
assert.deepEqual(moveStart(zero, { st: "09:30" }, false), W("2026-10-16", "09:30", "2026-10-16", "10:30"), "an event with no length gets an hour");

// ---- all day: the last day follows the first day, a one-day event stays one day
const day = W("2026-10-16", "09:00", "2026-10-16", "10:00");
assert.deepEqual(moveStart(day, { sd: "2026-10-20" }, true), W("2026-10-20", "09:00", "2026-10-20", "10:00"), "one day later");
assert.deepEqual(moveStart(day, { sd: "2026-10-10" }, true), W("2026-10-10", "09:00", "2026-10-10", "10:00"), "one day earlier");
const week = W("2026-10-16", "09:00", "2026-10-22", "10:00");
assert.deepEqual(moveStart(week, { sd: "2026-10-30" }, true), W("2026-10-30", "09:00", "2026-11-05", "10:00"), "a week keeps its 7 days");
assert.deepEqual(moveStart(week, { sd: "2026-10-01" }, true), W("2026-10-01", "09:00", "2026-10-07", "10:00"));
assert.deepEqual(moveStart(week, { sd: "2026-10-16" }, true), week, "same day");
// all day with an end before the start: stays unless the start reaches it
const wrongDay = W("2026-10-16", "09:00", "2026-10-14", "10:00");
assert.deepEqual(moveStart(wrongDay, { sd: "2026-10-13" }, true), W("2026-10-13", "09:00", "2026-10-14", "10:00"));
assert.deepEqual(moveStart(wrongDay, { sd: "2026-10-14" }, true), W("2026-10-14", "09:00", "2026-10-14", "10:00"), "reaches the end: a one-day event");
assert.deepEqual(moveStart(wrongDay, { sd: "2026-10-20" }, true), W("2026-10-20", "09:00", "2026-10-20", "10:00"));
// the time of an all-day event is not read (the fields are hidden): a stale or empty time changes nothing
assert.deepEqual(moveStart(W("2026-10-16", "", "2026-10-17", ""), { sd: "2026-10-20" }, true), W("2026-10-20", "", "2026-10-21", ""));

// ---- values that are not a date or a time leave the end alone (and the change is still applied)
assert.deepEqual(moveStart(W("2026-10-16", "09:00", "", ""), { st: "10:00" }, false), W("2026-10-16", "10:00", "", ""));
assert.deepEqual(moveStart(W("", "09:00", "2026-10-16", "10:00"), { sd: "2026-10-16" }, false), W("2026-10-16", "09:00", "2026-10-16", "10:00"));
assert.deepEqual(moveStart(hour, { sd: "" }, false), W("", "09:00", "2026-10-16", "10:00"));
// no change at all
assert.deepEqual(moveStart(hour, {}, false), hour);
// past year 9999 the end stays
assert.deepEqual(moveStart(W("9999-12-31", "09:00", "9999-12-31", "10:00"), { st: "23:30" }, false), W("9999-12-31", "23:30", "9999-12-31", "10:00"));
// the input is not changed
const before = JSON.stringify(hour);
moveStart(hour, { st: "11:00" }, false);
assert.equal(JSON.stringify(hour), before);

// ---- the end alone never moves the start: both dialogs set the end fields directly; the start only ever goes through moveStart
const cal = readFileSync(new URL("../src/components/Calendar.tsx", import.meta.url), "utf8");
assert.match(cal, /onChange=\{\(v\) => \(setEd\(v\), touch\(\)\)\}/, "event dialog: the end date sets the end date only");
assert.match(cal, /onChange=\{\(v\) => \(setEt\(v\), touch\(\)\)\}/, "event dialog: the end time sets the end time only");
assert.match(cal, /onChange=\{\(v\) => set\(\{ ed: v \}\)\}/, "meeting strip: the end date sets the end date only");
assert.match(cal, /onChange=\{\(v\) => set\(\{ et: v \}\)\}/, "meeting strip: the end time sets the end time only");
assert.ok(!/ed < v/.test(cal) && !/value\.ed < v/.test(cal), "no hand-made 'end before start' fix-up left next to the start fields");
// the existing check at Save stays
assert.match(cal, /if \(e <= s && !allDay\) return setError\(t\("calendar\.endBeforeStart"\)\)/);
assert.match(cal, /"error" in bad && bad\.error === t\("calendar\.meeting\.errEnd"\) \? t\("calendar\.endBeforeStart"\)/);

console.log("event when: ok");
