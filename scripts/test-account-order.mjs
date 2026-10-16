// The order of the mailboxes (v1.0.6): one saved list of ids applied to the backend's list. Rules of src/accountOrder.ts, the saved shape in
// src/prefs.ts, and that the screens use them.
// Run: node --experimental-strip-types scripts/test-account-order.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoScrollStep, dropIndex, moveAccountTo, moveIndex, orderAccounts, pruneOrder, stepAccount } from "../src/accountOrder.ts";

const acc = (...ids) => ids.map((id) => ({ id, email: `${id}@x.com` }));
const ids = (l) => l.map((a) => a.id);

// 1. existing users: nothing saved -> exactly the order the backend gives (the order they were added)
assert.deepEqual(ids(orderAccounts(acc("a", "b", "c"), [])), ["a", "b", "c"]);
assert.deepEqual(ids(orderAccounts(acc("a", "b", "c"), undefined)), ["a", "b", "c"], "an older prefs blob has no list");
// 2. the saved order wins
assert.deepEqual(ids(orderAccounts(acc("a", "b", "c"), ["c", "a", "b"])), ["c", "a", "b"]);
// 3. a new account (not in the list) goes at the end, several of them in the backend's order
assert.deepEqual(ids(orderAccounts(acc("a", "b", "c", "d"), ["b", "a"])), ["b", "a", "c", "d"]);
// 4. a removed account in the list is ignored; the rest keeps its order
assert.deepEqual(ids(orderAccounts(acc("a", "c"), ["c", "gone", "a"])), ["c", "a"]);
// 5. duplicates in the saved list do not break it
assert.deepEqual(ids(orderAccounts(acc("a", "b"), ["b", "b", "a"])), ["b", "a"]);
// 6. the input is not changed
const input = acc("a", "b");
orderAccounts(input, ["b", "a"]);
assert.deepEqual(ids(input), ["a", "b"]);
// 7. no accounts
assert.deepEqual(orderAccounts([], ["a"]), []);

// move index a to b
assert.deepEqual(moveIndex(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
assert.deepEqual(moveIndex(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
assert.deepEqual(moveIndex(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
assert.deepEqual(moveIndex(["a", "b", "c"], 1, 99), ["a", "c", "b"], "clamped to the end");
assert.deepEqual(moveIndex(["a", "b", "c"], 1, -5), ["b", "a", "c"], "clamped to the start");
assert.deepEqual(moveIndex(["a", "b", "c"], 7, 0), ["a", "b", "c"], "from outside the list: nothing moves");
assert.deepEqual(moveIndex([], 0, 0), []);
const list = ["a", "b"];
assert.notEqual(moveIndex(list, 0, 1), list, "a new array");
assert.deepEqual(moveAccountTo(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
assert.deepEqual(moveAccountTo(["a", "b", "c"], "zz", 0), ["a", "b", "c"], "an unknown id changes nothing");
assert.deepEqual(stepAccount(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
assert.deepEqual(stepAccount(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
assert.deepEqual(stepAccount(["a", "b", "c"], "a", -1), ["a", "b", "c"], "the first cannot go up");
assert.deepEqual(stepAccount(["a", "b", "c"], "c", 1), ["a", "b", "c"], "the last cannot go down");

// persistence shape: the whole visible order is saved, and re-applying it to the backend's list gives the same order again (restart)
{
  const backend = acc("a", "b", "c");
  const shown = ids(orderAccounts(backend, []));
  const saved = moveAccountTo(shown, "c", 0); // what setPrefs({ accountOrder }) stores
  assert.deepEqual(saved, ["c", "a", "b"]);
  assert.deepEqual(ids(orderAccounts(backend, JSON.parse(JSON.stringify(saved)))), ["c", "a", "b"], "after a restart");
  // an account is added later, then another one removed: the arranged order stays, the new one is last, the saved list is cleaned
  const later = acc("a", "b", "c", "n");
  assert.deepEqual(ids(orderAccounts(later, saved)), ["c", "a", "b", "n"]);
  assert.deepEqual(pruneOrder(["c", "a", "b"], ["c", "b"]), ["c", "b"]);
  assert.equal(pruneOrder(["c", "a"], ["c", "a", "n"]), null, "nothing to clean");
  assert.deepEqual(pruneOrder([], []), null);
}

// drag: the landing index is the number of OTHER entries whose middle is above the pointer
const mids = [20, 60, 100, 140]; // four entries 40 px apart
assert.equal(dropIndex(mids, 0, 10), 0, "above everything: stays first");
assert.equal(dropIndex(mids, 0, 70), 1, "past the second one's middle");
assert.equal(dropIndex(mids, 0, 500), 3, "below everything: last");
assert.equal(dropIndex(mids, 3, 0), 0);
assert.equal(dropIndex(mids, 3, 65), 2);
assert.equal(dropIndex(mids, 1, 61), 1, "back over its own place: stays");
assert.equal(dropIndex([50], 0, 999), 0);
// auto-scroll near the edges of the list
assert.equal(autoScrollStep(300, 100, 500), 0, "the middle: no scroll");
assert.ok(autoScrollStep(110, 100, 500) < 0, "near the top: up");
assert.ok(autoScrollStep(490, 100, 500) > 0, "near the bottom: down");
assert.ok(autoScrollStep(100, 100, 500) <= autoScrollStep(130, 100, 500), "faster closer to the edge");
assert.ok(autoScrollStep(520, 100, 500) >= autoScrollStep(490, 100, 500), "and past it");
assert.ok(Math.abs(autoScrollStep(-900, 100, 500)) <= 14, "bounded");

// the saved shape and the screens
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const prefs = read("src/prefs.ts");
assert.match(prefs, /accountOrder: string\[\]/);
assert.match(prefs, /accountOrder: \[\],/, "default: empty = today's order");
assert.match(prefs, /pruneOrder\(prefs\.accountOrder \?\? \[\], accountIds\)/, "a removed account leaves the saved list");
const store = read("src/store.ts");
assert.equal((store.match(/orderAccounts\(/g) ?? []).length, 3, "init, accountAdded and setPrefs apply the saved order");
assert.match(store, /"accountOrder" in patch/, "a new order is applied at once");
assert.match(read("src/components/FolderPane.tsx"), /useAccountReorder\(/, "folder pane");
assert.match(read("src/components/SettingsDialog.tsx"), /useAccountReorder\(/, "Settings");
const ui = read("src/components/AccountReorder.tsx");
assert.match(ui, /e\.altKey/, "Alt+Arrow");
assert.match(ui, /aria-live="polite"/, "announcements");
assert.match(ui, /"Escape"/, "Escape cancels a drag");
assert.match(ui, /setPointerCapture/, "pointer events, not HTML5 drag");
assert.doesNotMatch(ui, /draggable|onDragStart|dataTransfer/, "the attachment drop zones never see a mailbox drag");
// the window keeps HTML5 file drops (Compose attachments): reordering must not need that to change
assert.match(read("src-tauri/tauri.conf.json"), /"dragDropEnabled": false/);

console.log("account order rules: ok");
