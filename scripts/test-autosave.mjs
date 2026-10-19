// Autosave of the message being written (QA round 17 BUG-02): when a changed message is saved to Drafts by itself, when the crash-recovery
// snapshot is written, and that the draft an autosave made is the one the next save replaces. Behaviour of src/autosave.ts (the decisions).
// Run: node --experimental-strip-types scripts/test-autosave.mjs
import assert from "node:assert/strict";
import { AUTOSAVE_MS, SNAPSHOT_MS, autosaveDue, snapshotDue, timing } from "../src/autosave.ts";

const facts = (over = {}) => ({
  now: 100_000, why: "tick", rev: 5, savedRev: 0, changedAt: 60_000, lastTryAt: 0, failures: 0, draftContent: true, attaching: false,
  saving: false, sending: false, scheduled: false, plainWouldLeak: false, ...over,
});

// 1. the timer: 30 s after the first change, not before
{
  assert.equal(AUTOSAVE_MS, 30_000);
  assert.equal(autosaveDue(facts({ now: 89_999, changedAt: 60_000 })), false, "29.999 s after the first change: not yet");
  assert.equal(autosaveDue(facts({ now: 90_000, changedAt: 60_000 })), true, "30 s: save");
  // a change right now does not save at once, even though the compose was opened long ago
  assert.equal(autosaveDue(facts({ now: 100_000, changedAt: 99_500 })), false);
  // after a save the next one is 30 s after the next try, and only when something changed
  assert.equal(autosaveDue(facts({ now: 125_000, changedAt: 60_000, lastTryAt: 100_000 })), false);
  assert.equal(autosaveDue(facts({ now: 130_000, changedAt: 60_000, lastTryAt: 100_000 })), true);
}

// 2. only a CHANGED message: nothing changed since the last save = no save, however long it has been
{
  assert.equal(autosaveDue(facts({ rev: 5, savedRev: 5, now: 10_000_000 })), false);
  assert.equal(autosaveDue(facts({ rev: 6, savedRev: 5, now: 10_000_000 })), true);
}

// 3. never in the middle of something else
{
  const late = { now: 10_000_000 };
  assert.equal(autosaveDue(facts({ ...late, saving: true })), false, "not while a save is in flight");
  assert.equal(autosaveDue(facts({ ...late, sending: true })), false, "not while the message is being sent");
  assert.equal(autosaveDue(facts({ ...late, scheduled: true })), false, "a scheduled message is not a draft");
  assert.equal(autosaveDue(facts({ ...late, attaching: true })), false, "not while files are still coming in");
  assert.equal(autosaveDue(facts({ ...late, draftContent: false })), false, "an untouched reply or forward is not saved");
  assert.equal(autosaveDue(facts({ ...late, plainWouldLeak: true })), false, "an encrypted message is not written to the server in the clear");
  for (const why of ["blur", "hidden"]) {
    for (const k of ["saving", "sending", "scheduled", "attaching"]) assert.equal(autosaveDue(facts({ why, [k]: true })), false, `${why} + ${k}`);
    assert.equal(autosaveDue(facts({ why, draftContent: false })), false, why);
    assert.equal(autosaveDue(facts({ why, rev: 5, savedRev: 5 })), false, why);
    assert.equal(autosaveDue(facts({ why, plainWouldLeak: true })), false, why);
  }
}

// 4. leaving the window (blur / hidden) does not wait for the timer, but does not hammer either
{
  for (const why of ["blur", "hidden"]) {
    assert.equal(autosaveDue(facts({ why, now: 61_000, changedAt: 60_500 })), true, `${why}: 0.5 s after the change`);
    assert.equal(autosaveDue(facts({ why, now: 100_000, lastTryAt: 99_000 })), false, `${why}: a try 1 s ago is not repeated`);
    assert.equal(autosaveDue(facts({ why, now: 102_000, lastTryAt: 100_000 })), true, `${why}: 2 s after the last try`);
  }
}

// 5. failures: the next try waits longer each time (up to 7 x), the blur path too, and a success starts over
{
  const f = (n, now, why = "tick") => autosaveDue(facts({ why, failures: n, now, changedAt: 0, lastTryAt: 1_000 }));
  assert.equal(f(0, 31_000), true);
  assert.equal(f(1, 31_000), false, "after one failure: 60 s");
  assert.equal(f(1, 61_000), true);
  assert.equal(f(2, 61_000), false);
  assert.equal(f(2, 91_000), true, "after two: 90 s");
  assert.equal(f(50, 1_000 + 30_000 * 7 - 1), false, "capped at 7 x");
  assert.equal(f(50, 1_000 + 30_000 * 7), true);
  assert.equal(f(1, 3_000, "blur"), false, "blur waits too after a failure (4 s)");
  assert.equal(f(1, 5_000, "blur"), true);
}

// 6. the interval can be shortened (the dev page: #autosave=3000)
{
  assert.equal(autosaveDue(facts({ now: 63_000, changedAt: 60_000 }), 3_000), true);
  assert.equal(autosaveDue(facts({ now: 62_999, changedAt: 60_000 }), 3_000), false);
  assert.deepEqual(timing(), { autosaveMs: 30_000, snapshotMs: 3_000 }, "defaults when nothing overrides them");
  globalThis.window = { __hlTiming: { autosaveMs: 3000, snapshotMs: 1000 } };
  assert.deepEqual(timing(), { autosaveMs: 3000, snapshotMs: 1000 });
  globalThis.window = { __hlTiming: { autosaveMs: -5, snapshotMs: 0 } };
  assert.deepEqual(timing(), { autosaveMs: 30_000, snapshotMs: 3_000 }, "nonsense falls back");
  delete globalThis.window;
}

// 7. the snapshot: every few seconds while the message changes, never for nothing
{
  const s = (over = {}) => ({ now: 100_000, rev: 3, snapRev: -1, lastWriteAt: 0, size: 100, hasContent: true, scheduled: false, encrypted: false, ...over });
  assert.equal(SNAPSHOT_MS, 3_000);
  assert.equal(snapshotDue(s()), true, "the first change is written at once");
  assert.equal(snapshotDue(s({ rev: 3, snapRev: 3 })), false, "unchanged: nothing to write");
  assert.equal(snapshotDue(s({ snapRev: 2, lastWriteAt: 98_000 })), false, "2 s after the last write");
  assert.equal(snapshotDue(s({ snapRev: 2, lastWriteAt: 97_000 })), true, "3 s");
  assert.equal(snapshotDue(s({ hasContent: false })), false, "an untouched reply has nothing to recover");
  assert.equal(snapshotDue(s({ scheduled: true })), false, "a scheduled message is in the outbox");
  assert.equal(snapshotDue(s({ encrypted: true })), false, "an encrypted message is not written to the disk in the clear");
  // a message with pictures is written less often: one more second per MB, at most ten
  assert.equal(snapshotDue(s({ snapRev: 2, lastWriteAt: 97_000, size: 2_000_000 })), false);
  assert.equal(snapshotDue(s({ snapRev: 2, lastWriteAt: 95_000, size: 2_000_000 })), true);
  assert.equal(snapshotDue(s({ snapRev: 2, lastWriteAt: 100_000 - 13_000, size: 900_000_000 })), true, "at most 3 + 10 s");
  assert.equal(snapshotDue(s({ snapRev: 2, lastWriteAt: 100_000 - 12_999, size: 900_000_000 })), false);
  assert.equal(snapshotDue(s({ snapRev: 2, lastWriteAt: 98_000 }), 1_000), true, "the dev page writes every second");
}

// 8. a session: the timeline of one message, step by step (what Compose does with these answers)
{
  const st = { rev: 0, savedRev: 0, changedAt: 0, lastTryAt: 0, failures: 0, saving: false, snapRev: -1, lastWriteAt: 0 };
  const saves = [];
  const writes = [];
  const tick = (now) => {
    if (snapshotDue({ now, rev: st.rev, snapRev: st.snapRev, lastWriteAt: st.lastWriteAt, size: 100, hasContent: true, scheduled: false, encrypted: false })) {
      st.snapRev = st.rev;
      st.lastWriteAt = now;
      writes.push(now);
    }
    if (autosaveDue(facts({ now, why: "tick", rev: st.rev, savedRev: st.savedRev, changedAt: st.changedAt, lastTryAt: st.lastTryAt, failures: st.failures, saving: st.saving }))) {
      st.lastTryAt = now;
      saves.push(now);
      st.savedRev = st.rev; // the save worked
      st.changedAt = 0;
      st.snapRev = st.rev; // ... so the snapshot was released (see Compose saveDraft)
    }
  };
  const type = (now) => {
    st.rev++;
    if (!st.changedAt) st.changedAt = now;
  };
  const B = 1_000_000; // (a real clock is far from 0)
  type(B + 1_000);
  for (let t = 1_000; t <= 100_000; t += 1_000) {
    if (t === 20_000 || t === 21_000) type(B + t); // typing continues
    tick(B + t);
  }
  assert.deepEqual(saves, [B + 31_000], "one autosave, 30 s after the first change; nothing after it while nothing changes");
  assert.deepEqual(writes, [B + 1_000, B + 20_000, B + 23_000], "snapshots at the first change, then at most every 3 s while it changes");
}

// 9. W13.5: a message with only recipients (draftContent false) is never saved to Drafts, however long the timer runs, on tick or on leaving the window; its
// local crash snapshot (hasContent true) is still written. Content that is worth a draft (draftContent true) is saved as before.
{
  const only = { draftContent: false, now: 10_000_000, changedAt: 1_000, rev: 3, savedRev: 0 };
  assert.equal(autosaveDue(facts({ ...only })), false, "recipients only: the 30 s timer does not save");
  for (const why of ["blur", "hidden"]) assert.equal(autosaveDue(facts({ ...only, why })), false, `recipients only: ${why} does not save`);
  // the same message in the session of section 8: edits go on for 5 minutes, the timer fires at every tick, nothing is saved
  const st = { rev: 0, changedAt: 0, lastTryAt: 0 };
  let saves = 0;
  const B = 1_000_000;
  st.rev++;
  st.changedAt = B;
  for (let t = 1_000; t <= 300_000; t += 1_000) if (autosaveDue(facts({ now: B + t, rev: st.rev, savedRev: 0, changedAt: st.changedAt, lastTryAt: st.lastTryAt, draftContent: false }))) saves++;
  assert.equal(saves, 0, "five minutes of a recipients-only message: no autosave");
  assert.equal(snapshotDue({ now: 100_000, rev: 3, snapRev: -1, lastWriteAt: 0, size: 100, hasContent: true, scheduled: false, encrypted: false }), true, "its local snapshot is still written");
  // the moment it gets a subject / text / a file (draftContent true) the 30 s timer saves it
  assert.equal(autosaveDue(facts({ ...only, draftContent: true })), true);
}

console.log("autosave: ok");
