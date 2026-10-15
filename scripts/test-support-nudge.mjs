// The support nudge schedule (src/supportNudge.ts): first due date, +2 months, +6 months after "Buy me a coffee", switched off, busy moments,
// one nudge per due date, an upgrade without a stored first-run date. The clock and the random source are passed in; no real time passes.
// Run: node --experimental-strip-types scripts/test-support-nudge.mjs
import assert from "node:assert/strict";
import {
  DEFAULT_NUDGE, FIRST_MAX_DAYS, FIRST_MIN_DAYS, MIN_SESSION_MS, addMonths, decide, ensureSchedule, isCalm, normalizeNudge, setEnabled, shown, supported,
} from "../src/supportNudge.ts";

const DAY = 86_400_000;
const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h, 0, 0, 0).getTime(); // local time, like the app
const calm = { focused: true, sessionMs: MIN_SESSION_MS, composing: false, modalOpen: false, toastShowing: false, busy: false };
const rnd = (x) => () => x;

// ---- first due date: between day 7 and day 30 after the first run, drawn once
{
  const first = at(2026, 3, 1);
  const lo = ensureSchedule(DEFAULT_NUDGE, first, null, rnd(0));
  const hi = ensureSchedule(DEFAULT_NUDGE, first, null, rnd(0.999999));
  assert.equal(lo.firstRunAt, first);
  assert.equal(lo.nextDueAt, first + FIRST_MIN_DAYS * DAY, "the earliest is day 7");
  assert.equal(hi.nextDueAt, first + FIRST_MAX_DAYS * DAY, "the latest is day 30");
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const s = ensureSchedule(DEFAULT_NUDGE, first, null, Math.random);
    const days = (s.nextDueAt - first) / DAY;
    assert.ok(Number.isInteger(days) && days >= 7 && days <= 30, `day ${days} is within 7..30`);
    seen.add(days);
  }
  assert.equal(seen.size, 24, "every day from 7 to 30 can be drawn");
  // an odd random source cannot leave the range
  assert.equal(ensureSchedule(DEFAULT_NUDGE, first, null, rnd(1)).nextDueAt, first + 30 * DAY);
  assert.equal(ensureSchedule(DEFAULT_NUDGE, first, null, rnd(-3)).nextDueAt, first + 7 * DAY);
  assert.equal(ensureSchedule(DEFAULT_NUDGE, first, null, rnd(NaN)).nextDueAt, first + 7 * DAY);
}

// ---- not before 7 days; due from the drawn day on
{
  const first = at(2026, 3, 1);
  const s = ensureSchedule(DEFAULT_NUDGE, first, null, rnd(0)); // day 7
  assert.equal(decide(s, first, calm), "none", "day 0");
  assert.equal(decide(s, first + 6 * DAY + 23 * 3_600_000, calm), "none", "just under 7 days");
  assert.equal(decide(s, first + 7 * DAY - 1, calm), "none");
  assert.equal(decide(s, first + 7 * DAY, calm), "show", "day 7");
  const late = ensureSchedule(DEFAULT_NUDGE, first, null, rnd(0.999999)); // day 30
  assert.equal(decide(late, first + 29 * DAY, calm), "none");
  assert.equal(decide(late, first + 30 * DAY, calm), "show");
}

// ---- the schedule is set once: a second call keeps what is stored (the draw is not repeated)
{
  const first = at(2026, 3, 1);
  const s = ensureSchedule(DEFAULT_NUDGE, first, null, rnd(0.5));
  assert.equal(ensureSchedule(s, first + 5 * DAY, null, rnd(0.99)), s);
  assert.equal(ensureSchedule(s, first + 5 * DAY, first - 400 * DAY, rnd(0.99)), s, "a stored first-run date is never replaced by the hint");
}

// ---- later due date: 2 calendar months after it was shown, month ends included
{
  assert.equal(addMonths(at(2026, 1, 15), 2), at(2026, 3, 15));
  assert.equal(addMonths(at(2026, 12, 31), 2), at(2027, 2, 28), "31 Dec -> end of Feb");
  assert.equal(addMonths(at(2027, 12, 31), 2), at(2028, 2, 29), "31 Dec -> 29 Feb in a leap year");
  assert.equal(addMonths(at(2026, 8, 31), 2), at(2026, 10, 31));
  assert.equal(addMonths(at(2026, 10, 31), 2), at(2026, 12, 31));
  assert.equal(addMonths(at(2026, 12, 15), 2), at(2027, 2, 15), "crosses the year");
  assert.equal(addMonths(at(2026, 3, 31), 6), at(2026, 9, 30), "+6: 31 Mar -> 30 Sep");
  assert.equal(addMonths(at(2026, 10, 31), 6), at(2027, 4, 30), "+6 crosses the year");
  assert.equal(addMonths(at(2026, 1, 31, 23), 1), at(2026, 2, 28, 23), "the time of day stays");
  const s = shown({ ...DEFAULT_NUDGE, nextDueAt: at(2026, 12, 1) }, at(2026, 12, 31));
  assert.equal(s.nextDueAt, at(2027, 2, 28));
  assert.equal(s.lastShownAt, at(2026, 12, 31));
  assert.equal(decide(s, at(2027, 2, 27), calm), "none");
  assert.equal(decide(s, at(2027, 2, 28), calm), "show");
}

// ---- "Buy me a coffee": the next one is due in 6 months (counted from the click), no jitter
{
  const s0 = shown({ ...DEFAULT_NUDGE, nextDueAt: at(2026, 5, 1) }, at(2026, 5, 3)); // due 3 Jul
  const click = at(2026, 5, 3, 10);
  const s = supported(s0, click);
  assert.equal(s.nextDueAt, at(2026, 11, 3));
  assert.equal(decide(s, at(2026, 10, 1), calm), "none", "the 2-month date no longer applies");
  assert.equal(decide(s, at(2026, 11, 3), calm), "show");
}

// ---- switched off: never shows, whatever the date and the moment; switching on again does not pop up at once
{
  const off = setEnabled({ ...DEFAULT_NUDGE, nextDueAt: at(2026, 1, 1) }, false, at(2026, 2, 1));
  assert.equal(off.enabled, false);
  assert.equal(decide(off, at(2030, 1, 1), calm), "none");
  const on = setEnabled(off, true, at(2026, 6, 1));
  assert.equal(on.enabled, true);
  assert.equal(on.nextDueAt, at(2026, 8, 1), "a due date in the past moves 2 months from now");
  assert.equal(decide(on, at(2026, 6, 2), calm), "none");
  const farOff = setEnabled({ ...DEFAULT_NUDGE, enabled: false, nextDueAt: at(2027, 1, 1) }, true, at(2026, 6, 1));
  assert.equal(farOff.nextDueAt, at(2027, 1, 1), "a later date is kept");
  const nothing = { ...DEFAULT_NUDGE };
  assert.equal(setEnabled(nothing, true, 5), nothing);
}

// ---- busy moments defer: it stays due, and shows at the first calm moment
{
  const s = { ...DEFAULT_NUDGE, nextDueAt: at(2026, 4, 1) };
  const now = at(2026, 4, 2);
  assert.equal(decide(s, now, calm), "show");
  const busy = {
    unfocused: { focused: false },
    "short session": { sessionMs: MIN_SESSION_MS - 1 },
    composing: { composing: true },
    "dialog open": { modalOpen: true },
    "another toast": { toastShowing: true },
    "download or send": { busy: true },
  };
  for (const [what, patch] of Object.entries(busy)) {
    const m = { ...calm, ...patch };
    assert.equal(isCalm(m), false, what);
    assert.equal(decide(s, now, m), "wait", `${what}: deferred, not dropped`);
    assert.equal(decide(s, now + 40 * DAY, m), "wait", `${what}: still due weeks later`);
  }
  assert.equal(decide(s, now + 40 * DAY, calm), "show", "the first calm moment of a later session");
  assert.equal(decide({ ...s, nextDueAt: at(2026, 6, 1) }, now, { ...calm, busy: true }), "none", "not due: nothing to defer");
}

// ---- only one per due date: showing moves the date away at once
{
  let s = { ...DEFAULT_NUDGE, nextDueAt: at(2026, 4, 1) };
  const now = at(2026, 4, 2);
  assert.equal(decide(s, now, calm), "show");
  s = shown(s, now);
  for (const dt of [0, 1, 60_000, DAY, 30 * DAY, 58 * DAY]) assert.equal(decide(s, now + dt, calm), "none", `+${dt} ms`);
  assert.equal(decide(s, at(2026, 6, 2), calm), "show", "2 months later");
}

// ---- an upgrade: no first-run date stored
{
  const now = at(2026, 10, 20);
  // the local database file is 100 days old: the first nudge is already due (day 7..30 after its creation has passed)
  const old = ensureSchedule(DEFAULT_NUDGE, now, now - 100 * DAY, rnd(0.5));
  assert.equal(old.firstRunAt, now - 100 * DAY);
  assert.equal(decide(old, now, calm), "show");
  // a database created 3 days ago: not before day 7..30 of its life
  const young = ensureSchedule(DEFAULT_NUDGE, now, now - 3 * DAY, rnd(0));
  assert.equal(young.nextDueAt, now + 4 * DAY);
  assert.equal(decide(young, now + 3 * DAY, calm), "none");
  // not readable: today counts as the first run
  const unknown = ensureSchedule(DEFAULT_NUDGE, now, null, rnd(0));
  assert.equal(unknown.firstRunAt, now);
  assert.equal(unknown.nextDueAt, now + 7 * DAY);
  // a hint in the future (a wrong clock) or nonsense is not trusted
  assert.equal(ensureSchedule(DEFAULT_NUDGE, now, now + DAY, rnd(0)).firstRunAt, now);
  assert.equal(ensureSchedule(DEFAULT_NUDGE, now, NaN, rnd(0)).firstRunAt, now);
  assert.equal(ensureSchedule(DEFAULT_NUDGE, now, 0, rnd(0)).firstRunAt, now);
}

// ---- stored values from older versions or by hand
{
  assert.deepEqual(normalizeNudge(undefined), DEFAULT_NUDGE);
  assert.deepEqual(normalizeNudge(null), DEFAULT_NUDGE);
  assert.deepEqual(normalizeNudge("x"), DEFAULT_NUDGE);
  assert.deepEqual(normalizeNudge({ enabled: false, firstRunAt: 5, nextDueAt: "soon", lastShownAt: NaN }), { enabled: false, firstRunAt: 5, nextDueAt: null, lastShownAt: null });
  assert.equal(normalizeNudge({ enabled: 0 }).enabled, true, "only an explicit false switches it off");
  const s = { enabled: true, firstRunAt: 1, nextDueAt: 2, lastShownAt: 3 };
  assert.deepEqual(normalizeNudge(JSON.parse(JSON.stringify(s))), s);
}

console.log("ok - test-support-nudge");
