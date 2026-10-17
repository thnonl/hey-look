// A deleted / archived message must leave the list when its Undo time ends, also when the window was hidden to the tray meanwhile (v1.0.6 final QA,
// BUG-B3: after "Delete", close to the tray, wait, reopen: the row was still listed until a refresh; the server was right). What was wrong, and what
// holds now (the real run, with a hidden window, is in the coder report):
//  - the move is taken off the waiting list when its Undo time is over and changes the local rows a moment later (after the server move); a list read in
//    that moment showed the message again. Now it stays hidden until the rows are changed (src-tauri/src/lib.rs COMMITTING, unit test in
//    foldermove_tests.rs);
//  - two re-reads of the list can be answered in either order and the older answer was laid over the newer one: only the last re-read started applies
//    its answer (src/latestOnly.ts, used by refresh);
//  - the backend now tells the main page when a move is done (moves-committed, the thread ids) and the page drops them from its list at that moment;
//  - the page re-reads the list when its window is shown again (app-shown), not at the next 30 s refresh.
// Run: node --experimental-strip-types scripts/test-moves-committed.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Latest } from "../src/latestOnly.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// 1. the numbering: only the last run started is current, whatever order the answers come in
{
  const l = new Latest();
  const a = l.start(); // the 30 s refresh, read before the delete
  const b = l.start(); // the re-read at the end of the Undo time
  assert.equal(l.current(b), true);
  assert.equal(l.current(a), false, "the older read does not lay its answer over the newer one");
  const answers = []; // b answers first, a (stale: still has the message) last
  for (const [run, list] of [[b, []], [a, ["deleted-message"]]]) if (l.current(run)) answers.push(list);
  assert.deepEqual(answers, [[]], "the stale answer is dropped");
  const c = l.start();
  assert.equal(l.current(c) && !l.current(b), true, "a later run supersedes");
}

// 2. the store: refresh applies its answer only when it is still the last read; dropThreads takes the ids out of the list and the checked set
const store = read("../src/store.ts");
assert.match(store, /const listReads = new Latest\(\);/);
assert.match(store, /const run = listReads\.start\(\);/);
assert.match(store, /now\.search === search && listReads\.current\(run\)\) \{/);
const drop = store.slice(store.indexOf("  dropThreads: (ids) => {"));
const dropBody = drop.slice(0, drop.indexOf("  },\n") + 5);
assert.match(dropBody, /threads: s\.threads\.filter\(\(x\) => !gone\.has\(x\.threadId\)\)/);
assert.match(dropBody, /checked: new Set\(\[\.\.\.s\.checked\]\.filter\(\(x\) => !gone\.has\(x\)\)\)/);
assert.match(dropBody, /if \(!get\(\)\.threads\.some/, "nothing to do when none of them is listed");

// 3. the page listens
const app = read("../src/App.tsx");
assert.match(app, /listen<\{ threadIds: string\[\] \}>\("moves-committed", \(e\) => useStore\.getState\(\)\.dropThreads\(e\.payload\.threadIds\)\)/);
assert.match(app, /listen\("app-shown", \(\) => void useStore\.getState\(\)\.refresh\(\)\)/);

// 4. the backend says it: to the main page, after the rows are changed, with the thread ids in camelCase
const lib = read("../src-tauri/src/lib.rs");
assert.match(lib, /app\.emit_to\("main", "moves-committed", MovesCommitted \{ thread_ids: moved \}\)/);
assert.match(lib, /struct MovesCommitted \{\n    thread_ids: Vec<String>,/);
assert.match(lib.slice(lib.indexOf("struct MovesCommitted") - 80, lib.indexOf("struct MovesCommitted")), /rename_all = "camelCase"/);
assert.match(lib, /run_pending\(app, take_due\(Some\(std::time::Instant::now\(\)\)\), VERIFY_WAIT\);/, "the timer takes what is due and registers it as running");
console.log("test-moves-committed: ok");
