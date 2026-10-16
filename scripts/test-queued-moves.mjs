// BUG-1 (1.0.4, QA round 11): the saved folder list still names Archive but the server no longer has it and CREATE is refused. The app
// used to say "Archived / Undo" and show the error only after the Undo window. Now the backend checks the folder on the server during
// the window (Rust: `verify_on_session`, `Verify`, `verify_finished`, tests in foldermove_tests.rs) and drops the move with the event
// `action-verify-failed`. This checks the app side (src/queuedMoves.ts, and that store.ts / App.tsx wire it): the error path takes the
// "Archived" toast away and brings the mail back, Undo wins over a check that ends later, news that comes before the toast is shown
// means no toast at all.
// Run: node --experimental-strip-types scripts/test-queued-moves.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QueuedMoves } from "../src/queuedMoves.ts";

// 1. the normal case: queued, toast shown, the check passes (no news): nothing changes
{
  const q = new QueuedMoves();
  assert.equal(q.queued("a"), true, "the toast is shown");
  q.shown("a", 7);
  // (no event) the move runs at the end of the window; nothing to do
}

// 2. the check fails while the toast is up: that toast goes, the error is shown (store: moveDropped)
{
  const q = new QueuedMoves();
  q.queued("a");
  q.shown("a", 7);
  assert.deepEqual(q.dropped("a"), { dismiss: 7 }, "the 'Archived' toast is taken away");
  assert.deepEqual(q.dropped("a"), { dismiss: null }, "a second message for the same move only repeats the error handling, it has no toast to take away");
}

// 3. Undo wins: the person pressed Undo, then the check failed
{
  const q = new QueuedMoves();
  q.queued("a");
  q.shown("a", 7);
  q.undo("a");
  assert.equal(q.dropped("a"), null, "ignored: no error toast, no second refresh for a move that was taken back");
}

// 4. the failure was announced before the toast was shown (a fast server): no toast at all
{
  const q = new QueuedMoves();
  assert.deepEqual(q.dropped("a"), { dismiss: null }, "the error is shown now");
  assert.equal(q.queued("a"), false, "and the 'Archived' toast that would follow is not shown");
  assert.equal(q.queued("a"), true, "a token is only skipped once");
}

// 5. moves are independent
{
  const q = new QueuedMoves();
  q.queued("a"); q.shown("a", 1);
  q.queued("b"); q.shown("b", 2);
  q.undo("a");
  assert.equal(q.dropped("a"), null);
  assert.deepEqual(q.dropped("b"), { dismiss: 2 });
}

// 6. memory stays bounded
{
  const q = new QueuedMoves();
  for (let i = 0; i < 1000; i++) q.queued(`t${i}`);
  for (let i = 0; i < 1000; i++) q.dropped(`x${i}`);
  assert.ok(q.moves.size <= 201 && q.early.size <= 201);
}

// 7. wiring: store.ts keeps the token of every queued move, Undo is marked before the cancel call, the event reaches `moveDropped`, which
//    takes the toast away, shows the same error text as the other move errors and re-reads the list (the mail is back)
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const store = read("../src/store.ts");
const act = store.slice(store.indexOf("  act: async"), store.indexOf("  openCompose: async"));
assert.match(act, /if \(queued\.queued\(token\) && label\) \{\s*get\(\)\.showToast\(/, "no toast for a move already dropped");
assert.ok(act.indexOf("queued.undo(token)") < act.indexOf("api.cancelAction(token)"), "Undo is recorded before the cancel call");
assert.match(act, /queued\.shown\(token, toastSeq\)/);
const dropped = store.slice(store.indexOf("export function moveDropped"), store.indexOf("export function moveDropped") + 600);
assert.match(dropped, /const d = queued\.dropped\(token\);\s*if \(!d\) return;/, "Undo wins");
assert.match(dropped, /st\.dismissToast\(d\.dismiss\)/, "the 'Archived' toast goes");
assert.match(dropped, /st\.showToast\(t\("errors\.toast\.failed", \{ error: friendlyError\(error\) \}\), undefined, "error"\)/, "the same error text as the fresh path");
assert.match(dropped, /void st\.refresh\(\)/, "the mail is back in the list");
assert.match(read("../src/App.tsx"), /listen<\{ id: string; error: string \}>\("action-verify-failed", \(e\) => moveDropped\(e\.payload\.id, e\.payload\.error\)\)/);
assert.match(read("../src/api.ts"), /queueAction: .*verify = false\) =>\s*invoke<string>\("queue_action", \{ threadIds, action, arg, scope, delaySecs, verify \}\)/);
// the backend side exists under the same names
const lib = read("../src-tauri/src/lib.rs");
assert.match(lib, /app\.emit\("action-verify-failed", VerifyFailed \{ id: task, error \}\)/);
assert.match(lib, /if let Some\(Err\(error\)\) = p\.verify\.as_ref\(\)\.and_then\(\|v\| v\.wait\(verify_wait\)\)/, "a due move waits for its folder check and stops when it failed");
assert.match(lib, /never move into a folder that was not checked/);
console.log("queued-moves: all checks passed");
