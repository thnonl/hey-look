// After Archive / Delete the app opens the next mail (After-action setting) and marks it read as it opens. When the move is refused by
// the server, or Undo is pressed, the mail comes back: the selection must go back to it, and the next mail must not stay read when only
// the app (not the person) read it. Rules of src/autoAdvance.ts, and that src/store.ts wires them.
// Run: node --experimental-strip-types scripts/test-auto-advance.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planRestore, REVERT_WITHIN_MS, startAdvance, touchAdvance } from "../src/autoAdvance.ts";

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

// 8. wiring: the store records the advance when the move is queued, restores it on a refused move and on Undo, does not move on when the
//    move is refused before the app got to it, and does not count its own mark-as-read as the person's
{
  const src = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  assert.match(src, /advances\.set\(token, startAdvance\(/);
  assert.match(src, /void st\.refresh\(\)\.then\(\(\) => restoreAdvance\(token\)\)/, "refused move");
  assert.match(src, /\.then\(\(\) => get\(\)\.refresh\(\)\)\.then\(\(\) => restoreAdvance\(token\)\)/, "Undo");
  assert.match(src, /advance = queued\.queued\(token\);/);
  assert.match(src, /if \(advance && selected && ids\.includes\(selected\)\) await get\(\)\.select\(nextSel\)/);
  assert.match(src, /autoMarking = true;/);
  assert.match(src, /if \(!autoMarking\) for \(const \[k, a\] of advances\)/);
}

console.log("ok - test-auto-advance");
