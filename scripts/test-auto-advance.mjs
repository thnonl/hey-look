// After Archive / Delete the app opens the next mail (After-action setting) and marks it read as it opens. When the move is refused by
// the server, or Undo is pressed, the mail comes back: the selection must go back to it, and the next mail must not stay read when only
// the app (not the person) read it. Rules of src/autoAdvance.ts, and that src/store.ts wires them.
// Run: node --experimental-strip-types scripts/test-auto-advance.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AdvanceTracker, planRestore, REVERT_WITHIN_MS, startAdvance, touchAdvance } from "../src/autoAdvance.ts";

const T0 = 1_000_000;
const adv = (extra = {}) => ({ ...startAdvance("A", "B", true, T0), ...extra });

assert.equal(REVERT_WITHIN_MS, 10_000);

// 1. refused / undone right away, still on the next mail that was unread: back to A, B unread again
assert.deepEqual(planRestore(adv(), T0 + 1500, "B", false), { reselect: "A", markUnread: "B" });

// 2. the next mail was already read before: the selection goes back, nothing is marked unread
assert.deepEqual(planRestore(startAdvance("A", "B", false, T0), T0 + 1000, "B", false), { reselect: "A", markUnread: null });

// 3. the list shows B unread already (the app's mark never happened, e.g. the mark-read delay): nothing to set
assert.deepEqual(planRestore(adv(), T0 + 1000, "B", true), { reselect: "A", markUnread: null });

// 4. the person did something to B themselves (marked it read, flagged it ...): B's state is theirs; the selection still goes back
{
  const touched = touchAdvance(adv(), ["B"]);
  assert.equal(touched.touched, true);
  assert.deepEqual(planRestore(touched, T0 + 1000, "B", false), { reselect: "A", markUnread: null });
  // acting on another conversation does not count
  assert.equal(touchAdvance(adv(), ["C"]).touched, false);
}

// 5. the person selected something else meanwhile: nothing is touched
assert.deepEqual(planRestore(adv(), T0 + 1000, "C", false), { reselect: null, markUnread: null });
assert.deepEqual(planRestore(adv(), T0 + 1000, null, false), { reselect: null, markUnread: null });

// 6. they have been on B for longer than the limit: they read it, nothing is touched (the exact limit still counts as quick)
assert.deepEqual(planRestore(adv(), T0 + REVERT_WITHIN_MS, "B", false), { reselect: "A", markUnread: "B" });
assert.deepEqual(planRestore(adv(), T0 + REVERT_WITHIN_MS + 1, "B", false), { reselect: null, markUnread: null });

// 7. After-action "list" (or nothing left): the selection was cleared; still cleared -> back to A; nothing to mark unread
{
  const a = startAdvance("A", null, false, T0);
  assert.equal(a.wasUnread, false);
  assert.deepEqual(planRestore(a, T0 + 1000, null, false), { reselect: "A", markUnread: null });
  assert.deepEqual(planRestore(a, T0 + 1000, "X", false), { reselect: null, markUnread: null });
  assert.equal(touchAdvance(a, ["A"]), a);
}

// 8. the one way back, `AdvanceTracker.mailBack`, for every way a move can end: the same plan whichever path calls it. The fakes record what
//    the app was asked to do; `selected` / `unread` are what the app shows when the failure arrives.
const world = (selected, unread = {}, now = T0) => {
  const calls = [];
  return {
    calls,
    deps: {
      now: () => now,
      selected: () => selected,
      isUnread: (id) => !!unread[id],
      select: async (id) => void calls.push(["select", id]),
      markUnread: async (id) => void calls.push(["unread", id]),
    },
  };
};
const tracked = (token = "tok", a = adv()) => {
  const t = new AdvanceTracker();
  t.record(token, a);
  return t;
};
// the four paths are the same call; the cases differ in time and state
{
  // (a) the folder check failed during the Undo window (moveDropped): 1.2 s after the advance, still on B (read by the app)
  const w = world("B", {}, T0 + 1200);
  const plan = await tracked().mailBack("tok", w.deps);
  assert.deepEqual(plan, { reselect: "A", markUnread: "B" });
  assert.deepEqual(w.calls, [["select", "A"], ["unread", "B"]], "the mail is selected again first, then B is unread again");
}
{
  // (b) the server refused the MOVE after the Undo window (moveRefused): 6.5 s after the advance, within 10 s
  const w = world("B", {}, T0 + 6500);
  assert.deepEqual(await tracked().mailBack("tok", w.deps), { reselect: "A", markUnread: "B" });
  assert.deepEqual(w.calls, [["select", "A"], ["unread", "B"]]);
}
{
  // (b2) ... and later than 10 s: the person is reading B, the selection stays where it is, B stays read; the caller's refresh has put A back in the list
  const w = world("B", {}, T0 + 11_000);
  assert.deepEqual(await tracked().mailBack("tok", w.deps), { reselect: null, markUnread: null });
  assert.deepEqual(w.calls, []);
}
{
  // (c) Undo (a few seconds in)
  const w = world("B", {}, T0 + 3000);
  assert.deepEqual(await tracked().mailBack("tok", w.deps), { reselect: "A", markUnread: "B" });
}
{
  // (d) the move could not be queued: the app never advanced, so there is no record and nothing to do
  const w = world("A", {}, T0 + 100);
  assert.deepEqual(await new AdvanceTracker().mailBack("never-recorded", w.deps), { reselect: null, markUnread: null });
  assert.deepEqual(w.calls, []);
}
{
  // (e) normal success: nothing calls mailBack; a later, unrelated failure of another token does not touch this record
  const t = tracked("ok-move");
  const w = world("B", {}, T0 + 2000);
  await t.mailBack("other-token", w.deps);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(await t.mailBack("ok-move", w.deps), { reselect: "A", markUnread: "B" }, "the record is still there for its own token");
}
{
  // a record is used once: a second report for the same move (a duplicate event) does nothing more
  const t = tracked();
  const w = world("B", {}, T0 + 1000);
  await t.mailBack("tok", w.deps);
  w.calls.length = 0;
  assert.deepEqual(await t.mailBack("tok", w.deps), { reselect: null, markUnread: null });
  assert.deepEqual(w.calls, []);
}
{
  // the person marked B themselves meanwhile (touch): the selection goes back, B keeps their state; the app's own mark does not count
  const t = tracked();
  t.touch(["C"]);
  const w = world("B", {}, T0 + 2000);
  assert.deepEqual(await t.mailBack("tok", w.deps), { reselect: "A", markUnread: "B" }, "another conversation is not B");
  const t2 = tracked();
  t2.touch(["B"]);
  const w2 = world("B", {}, T0 + 2000);
  assert.deepEqual(await t2.mailBack("tok", w2.deps), { reselect: "A", markUnread: null });
  assert.deepEqual(w2.calls, [["select", "A"]]);
}
{
  // the person went to another mail before the failure arrived: nothing is touched
  const w = world("C", {}, T0 + 2000);
  assert.deepEqual(await tracked().mailBack("tok", w.deps), { reselect: null, markUnread: null });
}
{
  // memory stays bounded
  const t = new AdvanceTracker();
  for (let i = 0; i < 500; i++) t.record(`t${i}`, adv());
  assert.ok(t.moves.size <= 51);
}

// 9. wiring: the store records the advance when the move is queued, sends Undo, the folder-check failure and the late refusal through
//    `mailBack`, does not move on when the move is refused before the app got to it, and does not count its own mark-as-read as the person's;
//    the backend names the move in `action-failed` and the app listens with it
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const src = read("../src/store.ts");
  assert.match(src, /advances\.record\(token, startAdvance\(/);
  assert.match(src, /export function moveDropped[\s\S]*void st\.refresh\(\)\.then\(\(\) => mailBack\(token\)\)/, "folder check failed");
  assert.match(src, /export function moveRefused[\s\S]*void st\.refresh\(\)\.then\(\(\) => mailBack\(token\)\)/, "MOVE refused after the window");
  assert.match(src, /\.then\(\(\) => get\(\)\.refresh\(\)\)\.then\(\(\) => mailBack\(token\)\)/, "Undo");
  assert.match(src, /advance = queued\.queued\(token\);/);
  assert.match(src, /if \(advance && selected && ids\.includes\(selected\)\) await get\(\)\.select\(nextSel\)/);
  assert.match(src, /autoMarking = true;/);
  assert.match(src, /if \(!autoMarking\) advances\.touch\(ids\)/);
  assert.doesNotMatch(src, /restoreAdvance/, "one way back only");
  assert.match(read("../src/App.tsx"), /listen<\{ id: string; error: string \}>\("action-failed", \(e\) => moveRefused\(e\.payload\.id, e\.payload\.error\)\)/);
  assert.match(read("../src-tauri/src/lib.rs"), /app\.emit_to\("main", "action-failed", VerifyFailed \{ id, error \}\)/, "the backend names the move");
}

console.log("ok - test-auto-advance");
