// A meeting survives Save draft, the crash-recovery snapshot and a move to another window (v1.0.6 QA round 3, BUG-R3-4: Meeting on, Save draft, open the
// draft again: the toggle was off, the strip gone). Behaviour of src/meetingDraft.ts and of the snapshot side of src/recovery.ts; the backend side (the private
// header X-HeyLook-Meeting of the draft only, never in a sent message; the copy kept by Message-ID) is `cargo test --lib meeting_form`.
// Run: node --experimental-strip-types scripts/test-meeting-draft.mjs
import assert from "node:assert/strict";
import { MEETING_MAX, WHERE_MAX, decodeMeeting, encodeMeeting, meetingWire, readMeetingWire, restoreMeeting } from "../src/meetingDraft.ts";
import { composeFromSnapshot, draftFromSnapshot } from "../src/recovery.ts";

const tz = "Asia/Ho_Chi_Minh";
const form = { sd: "2026-10-20", st: "09:00", ed: "2026-10-20", et: "10:00", allDay: false, where: "Room 1" };

// 1. the form round-trips through the header value, a place with non-ASCII text too
{
  const blob = encodeMeeting(form, tz);
  assert.match(blob, /^[A-Za-z0-9_-]+$/, "base64url only: no +, / or =");
  assert.deepEqual(decodeMeeting(blob), { ...form, tz });
  const odd = { ...form, where: "Phòng họp 3 \u{1F600} - tầng 5", allDay: true };
  assert.deepEqual(decodeMeeting(encodeMeeting(odd, tz)), { ...odd, tz });
  // folded in the mail (white space between pieces) it still reads
  const folded = blob.replace(/(.{20})/g, "$1\r\n ");
  assert.deepEqual(decodeMeeting(folded), { ...form, tz });
}

// 2. a form that is not valid yet (an empty date while typing) is kept as typed, not lost
{
  const half = { ...form, ed: "", et: "" };
  assert.deepEqual(decodeMeeting(encodeMeeting(half, tz)), { ...half, tz });
}

// 3. the place is cut, control characters never get in, and a value over the cap is not written
{
  const long = { ...form, where: "x".repeat(WHERE_MAX + 200) };
  assert.equal(decodeMeeting(encodeMeeting(long, tz)).where.length, WHERE_MAX);
  assert.equal(decodeMeeting(encodeMeeting({ ...form, where: "a\r\nb\u0000c" }, tz)).where, "a  b c");
  assert.ok(encodeMeeting(long, tz).length <= MEETING_MAX);
  assert.equal(encodeMeeting({ ...form, sd: "x".repeat(MEETING_MAX) }, tz), undefined, "an invalid or oversized form is not written");
  assert.equal(encodeMeeting(form, "not a zone!"), undefined);
}

// 4. malformed values are ignored (null), never thrown on
{
  const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const good = { v: 1, ...form, tz };
  for (const bad of [
    undefined, null, "", "   ", "not base64url!", "a=b", "AAAA", "e30", b64("[1,2]"), b64("null"), b64("{not json"),
    b64({ ...good, v: 2 }), b64({ ...good, v: undefined }), b64({ ...good, sd: "2026-10-2" }), b64({ ...good, st: "9:00" }), b64({ ...good, allDay: "no" }),
    b64({ ...good, where: 5 }), b64({ ...good, tz: "bad zone" }), b64({ ...good, tz: "" }), b64({ ...good, sd: 5 }),
    "A".repeat(5000), Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url"),
  ]) assert.equal(decodeMeeting(bad), null, `ignored: ${String(bad).slice(0, 40)}`);
  assert.deepEqual(decodeMeeting(b64(good)), { ...form, tz });
  // extra fields are dropped, not carried
  assert.deepEqual(decodeMeeting(b64({ ...good, extra: "<script>" })), { ...form, tz });
}

// 5. a form of another time zone is shown at the same moments; an all-day meeting keeps its dates; a field that cannot be converted stays as typed
{
  const io = {
    // (a stand-in for src/calendar.ts: the zone's offset in hours)
    fromInputs: (date, time, z) => { const off = { A: 0, B: 7 }[z]; const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date), t = /^(\d{2}):(\d{2})$/.exec(time); return m && t ? Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1] - off, +t[2]) / 1000 : null; },
    toInputs: (sec, z) => { const off = { A: 0, B: 7 }[z]; const d = new Date((sec + off * 3600) * 1000); const p = (n) => String(n).padStart(2, "0"); return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }; },
  };
  const w = { sd: "2026-10-20", st: "23:30", ed: "2026-10-21", et: "00:30", allDay: false, where: "Hall", tz: "A" };
  assert.deepEqual(restoreMeeting(w, "A", io), { sd: "2026-10-20", st: "23:30", ed: "2026-10-21", et: "00:30", allDay: false, where: "Hall" }, "same zone: as typed");
  assert.deepEqual(restoreMeeting(w, "B", io), { sd: "2026-10-21", st: "06:30", ed: "2026-10-21", et: "07:30", allDay: false, where: "Hall" }, "same moments in another zone");
  assert.deepEqual(restoreMeeting({ ...w, allDay: true }, "B", io), { sd: "2026-10-20", st: "23:30", ed: "2026-10-21", et: "00:30", allDay: true, where: "Hall" }, "all-day: dates stay");
  assert.deepEqual(restoreMeeting({ ...w, ed: "" }, "B", io).ed, "", "an empty field stays");
}

// 6. the snapshot: the form is in the payload and comes back; a snapshot without one (older versions) or with a bad one opens without a meeting
{
  const payload = (extra) => JSON.stringify({ v: 1, to: ["ann@x.test"], cc: [], bcc: [], subject: "S", html: "<p>b</p>", inReplyTo: null, references: [], replaces: null, isReply: false, encrypt: "off", sign: false, attachKey: false, confidential: false, ...extra });
  const load = (extra) => ({ id: "r1", accountId: "a1", savedAt: 1, payload: payload(extra), files: [] });
  const wire = meetingWire(form, tz);
  assert.deepEqual(composeFromSnapshot(load({ meeting: wire })).meetingForm, { ...form, tz });
  assert.equal(composeFromSnapshot(load({})).meetingForm, undefined, "a draft without a meeting is unchanged");
  assert.equal(composeFromSnapshot(load({ meeting: { sd: 1 } })).meetingForm, undefined);
  assert.equal(composeFromSnapshot(load({ meeting: "x" })).meetingForm, undefined);
  assert.equal(composeFromSnapshot(load({ meeting: { ...wire, tz: "../../x" } })).meetingForm, undefined);
  // the draft that a recovered snapshot is saved as carries the meeting header value, and decodes to the same form
  const d = draftFromSnapshot(load({ meeting: wire }));
  assert.deepEqual(decodeMeeting(d.meetingForm), { ...form, tz });
  assert.equal(draftFromSnapshot(load({})).meetingForm, undefined);
  assert.ok(!("meeting" in d) || d.meeting === undefined, "the typed meeting is for a send only");
  assert.equal(readMeetingWire(wire).where, "Room 1");
}

console.log("test-meeting-draft: ok");
