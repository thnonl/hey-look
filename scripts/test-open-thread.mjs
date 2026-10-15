// F-12: with the Unread (or Flagged) filter on, the open mail is marked read, the next list read leaves it out - and the reading pane
// fell back to "Select an item to read". The open conversation must stay in the list (and open) until the person leaves it.
// Behaviour of src/openThread.ts, plus a source check that store.ts routes every re-read of the list through it and lets go on `select`.
// Run: node --experimental-strip-types scripts/test-open-thread.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { holdOpenThread } from "../src/openThread.ts";

const th = (id, unread = 1) => ({ threadId: id, rowKey: id, unread });
const ids = (r) => r.threads.map((t) => t.threadId);

// 1. The open mail was read and the filtered answer no longer has it: it is put back where it was.
{
  const shown = [th("a"), th("b", 0), th("c")];
  const r = holdOpenThread([th("a"), th("c")], shown, "b", true);
  assert.deepEqual(ids(r), ["a", "b", "c"]);
  assert.equal(r.kept, "b");
  assert.equal(r.threads[1].unread, 0, "the held row is the one that was shown (read)");
}
// 2. The answer still has it, nothing is open, or the open one was not shown: the answer is used as it is.
{
  const fresh = [th("a"), th("b")];
  assert.equal(holdOpenThread(fresh, [th("a"), th("b")], "b", true).threads, fresh);
  assert.equal(holdOpenThread(fresh, [th("a"), th("b")], null, true).threads, fresh);
}
{
  const fresh = [th("a")];
  const r = holdOpenThread(fresh, [th("a")], "gone", true);
  assert.equal(r.threads, fresh, "an open id that was never in the shown list is not invented");
  assert.equal(r.kept, null);
}
// 3. Another view (folder, filter, search ...) is the person leaving: nothing is held back.
{
  const fresh = [th("a")];
  const r = holdOpenThread(fresh, [th("a"), th("b", 0)], "b", false);
  assert.equal(r.threads, fresh);
  assert.equal(r.kept, null);
}
// 4. The last row, and a list that shrank: the held row goes at the end, not out of range.
{
  const r = holdOpenThread([th("a")], [th("a"), th("b"), th("c", 0)], "c", true);
  assert.deepEqual(ids(r), ["a", "c"]);
  assert.deepEqual(ids(holdOpenThread([], [th("c", 0)], "c", true)), ["c"]);
}

// 5. store.ts: `refresh` uses it (the key names every part of the view), `select` lets the held row go when another one is chosen.
const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(store, /import \{ holdOpenThread \} from "\.\/openThread"/);
assert.match(store, /holdOpenThread\(fresh, now\.threads, now\.selected, view === listKey\)/, "refresh holds the open conversation");
const key = store.match(/const view = \[([^\]]*)\]\.join/)?.[1] ?? "";
for (const part of ["folder", "accountId", "search", "searchScope", "focus", "filter"]) assert.ok(key.includes(part), `the view key of refresh names ${part}`);
assert.match(store, /heldOpen && heldOpen !== id/, "select: choosing another conversation (or none) lets the held row go");
assert.match(store, /threads\.filter\(\(t\) => t\.threadId !== held\)/);
// the reading pane still finds its summary in the list - which is why the row must stay
assert.match(readFileSync(new URL("../src/components/ReadingPane.tsx", import.meta.url), "utf8"), /threads\.find\(\(th\) => th\.threadId === selected\)/);
console.log("open-thread: all checks passed");
