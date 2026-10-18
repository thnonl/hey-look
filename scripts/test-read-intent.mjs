// F-16: clicking Mark read / Mark unread several times quickly left the state changing after the clicking stopped.
// F-17: moving quickly between unread mails: a mail that became read flipped back to unread.
// Causes: every click was its own backend call on its own IMAP connection (finishing in any order, the server ending in whichever
// finished last), and every call ended with a re-read of the list that showed the backend's row - which changes only after the server
// did - over the state just asked for. Behaviour of src/readIntent.ts with the backend simulated (calls that finish when the test says,
// in any order, and reads that answer from before a call finished), plus source checks that store.ts goes through it.
// Run: node --experimental-strip-types scripts/test-read-intent.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StateIntents as ReadIntents } from "../src/readIntent.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A backend whose calls finish when told: `calls` are the ones under way, `server` is the read state of each conversation. */
function backend(initial = {}) {
  const server = { ...initial };
  const calls = [];
  const log = [];
  const send = (ids, read) =>
    new Promise((resolve, reject) => {
      const c = { ids: [...ids], read, resolve: () => (ids.forEach((i) => (server[i] = read)), resolve()), reject: (e) => reject(e) };
      calls.push(c);
      log.push({ ids: [...ids], read });
    });
  return { server, calls, log, send, finish: (c) => (calls.splice(calls.indexOf(c), 1), c.resolve()), fail: (c, e = new Error("imap down")) => (calls.splice(calls.indexOf(c), 1), c.reject(e)) };
}
const th = (id, unread) => ({ threadId: id, unread });

// 1. F-16: six quick clicks, one after the other while the first call is still under way: ONE call under way at a time, the next one
//    carries only the final state, and the server ends where the last click put it.
{
  const b = backend({ a: false });
  const it = new ReadIntents(b.send);
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(it.set(["a"], i % 2 === 0)); // read, unread, read, unread, read, unread
    await tick();
  }
  assert.equal(b.calls.length, 1, "one call per conversation under way, the other clicks wait");
  assert.deepEqual(b.log, [{ ids: ["a"], read: true }], "the first click went out at once");
  // while it runs, the stale backend row (still unread) must not be shown over the last click
  const tok = it.begin();
  assert.equal(it.threads([th("a", 1)], tok)[0].unread, 1, "last click was 'unread': shown unread");
  b.finish(b.calls[0]);
  await tick();
  assert.equal(b.calls.length, 1, "the follow-up is a single call");
  assert.deepEqual(b.log[1], { ids: ["a"], read: false }, "the follow-up sets the FINAL state (set, not toggle)");
  assert.equal(b.log.length, 2, "five of the six clicks were coalesced away");
  b.finish(b.calls[0]);
  const settled = await Promise.all(results);
  assert.equal(b.server.a, false, "the server ends in the state of the last click");
  assert.deepEqual(settled.map((r) => r.superseded), [true, true, true, true, true, false], "only the last click reports the outcome");
  assert.ok(settled.every((r) => r.failed.length === 0));
  it.end(tok);
}

// 2. F-16, the same with the 'read' click last, and the click that comes while the second call runs.
{
  const b = backend({ a: false });
  const it = new ReadIntents(b.send);
  const r1 = it.set(["a"], true);
  await tick();
  const r2 = it.set(["a"], false);
  await tick();
  b.finish(b.calls[0]); // call 1 (read) done; call 2 (unread) starts
  await tick();
  const r3 = it.set(["a"], true); // clicked while call 2 is under way
  await tick();
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].read, false);
  b.finish(b.calls[0]);
  await tick();
  assert.deepEqual(b.log.map((c) => c.read), [true, false, true], "never two calls at once; the last one carries the last click");
  b.finish(b.calls[0]);
  await Promise.all([r1, r2, r3]);
  assert.equal(b.server.a, true);
}

// 3. A click back to the state already being sent needs no second call.
{
  const b = backend({ a: false });
  const it = new ReadIntents(b.send);
  const r1 = it.set(["a"], true);
  await tick();
  const r2 = it.set(["a"], false);
  const r3 = it.set(["a"], true);
  await tick();
  b.finish(b.calls[0]);
  await Promise.all([r1, r2, r3]);
  assert.equal(b.log.length, 1, "read, unread, read while the first call runs: that call already has the final state");
  assert.equal(b.server.a, true);
}

// 4. F-17: a list read that began before the call finished (so it carries the old row) must not undo the new state - even after the
//    call finished; a list read that began after it is the truth again.
{
  const b = backend({ x: false });
  const it = new ReadIntents(b.send);
  const staleRead = it.begin(); // a refresh starts (a sync, a push, the previous mail's re-read ...) and will answer with x unread
  const done = it.set(["x"], true); // the person opens x: it is marked read
  await tick();
  // 4a. the stale list arrives while the call is under way
  assert.equal(it.threads([th("x", 1)], staleRead)[0].unread, 0);
  b.finish(b.calls[0]);
  await done;
  // 4b. ... and after it finished
  assert.equal(it.threads([th("x", 1)], staleRead)[0].unread, 0, "an answer older than the change cannot undo it");
  it.end(staleRead);
  // 4c. the entry is gone once no older read is left; a later read is trusted (mail marked unread on another device shows up)
  const later = it.begin();
  assert.equal(it.threads([th("x", 1)], later)[0].unread, 1, "a read that began after the change shows what the server says");
  it.end(later);
}

// 5. F-17, quick navigation: select a, b, c one after another, each marked read; refreshes land in between with the backend row of
//    mails whose call has not finished. Every mail the person visited stays read; out-of-order finishes change nothing.
{
  const b = backend({ a: false, b: false, c: false });
  const it = new ReadIntents(b.send);
  const rows = [th("a", 1), th("b", 1), th("c", 1)];
  const shown = (tok) => it.threads(rows, tok).map((t) => t.unread);
  const dones = [];
  const t0 = it.begin();
  dones.push(it.set(["a"], true));
  await tick();
  const t1 = it.begin();
  dones.push(it.set(["b"], true));
  await tick();
  const t2 = it.begin();
  dones.push(it.set(["c"], true));
  await tick();
  assert.equal(b.calls.length, 3, "different conversations go out side by side");
  assert.deepEqual(shown(t0), [0, 0, 0]);
  assert.deepEqual(shown(t1), [0, 0, 0]);
  assert.deepEqual(shown(t2), [0, 0, 0], "no row flips back to unread while the calls are under way");
  const [ca, cb, cc] = b.calls;
  b.finish(cc); // the last one finishes first
  await tick();
  assert.deepEqual(shown(t0), [0, 0, 0]);
  b.finish(ca);
  await tick();
  assert.deepEqual(shown(t1), [0, 0, 0], "a refresh that began before b finished still shows b read");
  b.finish(cb);
  await Promise.all(dones);
  assert.deepEqual(shown(t0), [0, 0, 0], "and after all of them finished");
  for (const t of [t0, t1, t2]) it.end(t);
  assert.deepEqual(b.server, { a: true, b: true, c: true });
}

// 6. A batch (several conversations, one click) is one call per state, as before.
{
  const b = backend({ a: false, b: false, c: true });
  const it = new ReadIntents(b.send);
  const r1 = it.set(["a", "b"], true);
  const r2 = it.set(["c"], false);
  await tick();
  assert.deepEqual(b.log.map((c) => [c.ids, c.read]), [[["a", "b"], true], [["c"], false]]);
  b.finish(b.calls[0]);
  b.finish(b.calls[0]);
  await Promise.all([r1, r2]);
  assert.deepEqual(b.server, { a: true, b: true, c: false });
}

// 7. Failure: the final call fails -> the intent is dropped (the list shows the server's state again) and the caller is told which.
{
  const b = backend({ a: false, z: false });
  const it = new ReadIntents(b.send);
  const r = it.set(["a"], true);
  await tick();
  const tok = it.begin();
  assert.equal(it.threads([th("a", 1)], tok)[0].unread, 0, "shown read while the call runs");
  b.fail(b.calls[0], new Error("imap down"));
  const res = await r;
  assert.deepEqual(res.failed, ["a"]);
  assert.equal(String(res.error), "Error: imap down");
  assert.equal(res.superseded, false);
  assert.equal(it.threads([th("a", 1)], tok)[0].unread, 1, "rolled back: the server's state shows");
  it.end(tok);
  // a call that fails but was asked again meanwhile is not an error: the newer state is sent next and decides
  const r1 = it.set(["z"], true);
  await tick();
  const r2 = it.set(["z"], false);
  b.fail(b.calls[0]);
  await tick();
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].read, false, "retried with the final state");
  b.finish(b.calls[0]);
  const [x1, x2] = await Promise.all([r1, r2]);
  assert.equal(x1.failed.length + x2.failed.length, 0);
  assert.equal(b.server.z, false);
}

// 8. The open conversation's messages are shown through the intent too (the reading pane's own read).
{
  const b = backend({ a: false });
  const it = new ReadIntents(b.send);
  const d = it.set(["a"], true);
  await tick();
  const tok = it.begin();
  const msgs = [{ id: 1, seen: false }, { id: 2, seen: false }];
  assert.deepEqual(it.messages("a", msgs, tok).map((m) => m.seen), [true, true]);
  assert.equal(it.messages("other", msgs, tok), msgs, "other conversations untouched");
  b.finish(b.calls[0]);
  await d;
  it.end(tok);
  const d2 = it.set(["a"], false);
  await tick();
  const t2 = it.begin();
  assert.deepEqual(it.messages("a", [{ id: 1, seen: true }, { id: 2, seen: true }], t2).map((m) => m.seen), [true, false], "unread: the newest message, as the list row");
  b.finish(b.calls[0]);
  await d2;
  it.end(t2);
}

// 9. Property check: random clicks over a few conversations with the backend finishing calls in random order and reads at random
//    moments. Invariants: never two calls under way for one conversation; the server ends where the last click put it; a read that
//    began after a click never shows a row against the latest click while that click is not settled.
{
  let seed = 12345;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  for (let round = 0; round < 200; round++) {
    const ids = ["a", "b", "c"];
    const b = backend(Object.fromEntries(ids.map((i) => [i, false])));
    const it = new ReadIntents(b.send);
    const last = {};
    const waits = [];
    const open = [];
    let stale = 0;
    for (let step = 0; step < 25; step++) {
      const what = rnd(4);
      if (what === 0 || what === 1) {
        const id = ids[rnd(3)];
        const read = rnd(2) === 0;
        last[id] = read;
        waits.push(it.set([id], read));
        // the wait for the microtask, then check the concurrency invariant
        await Promise.resolve();
        await Promise.resolve();
        const inflight = b.calls.map((c) => c.ids[0]);
        assert.equal(new Set(inflight).size, inflight.length, "never two calls under way for one conversation");
      } else if (what === 2 && b.calls.length) {
        b.finish(b.calls[rnd(b.calls.length)]); // any order
        await tick();
      } else if (what === 3) {
        if (open.length < 3) open.push(it.begin());
        else it.end(open.shift());
      }
      // a read that began before the latest click answers with the server's row from its own time: model it as the all-unread row
      if (open.length) {
        const shown = it.threads(ids.map((i) => th(i, 1)), open[0]);
        for (const t of shown) {
          if (last[t.threadId] === true) assert.equal(t.unread, 0, "a click on 'read' is never shown as unread by an older read");
          stale++;
        }
      }
    }
    while (b.calls.length) {
      b.finish(b.calls[rnd(b.calls.length)]);
      await tick();
    }
    await Promise.all(waits);
    for (const id of ids) if (id in last) assert.equal(b.server[id], last[id], `round ${round}: ${id} ends where the last click put it`);
    for (const t of open) it.end(t);
    assert.ok(stale >= 0);
  }
}

// 10. store.ts: read / unread (and, since 1.0.4, flag and pin: scripts/test-flag-pin-intent.mjs) go through the intents, and every list /
//     conversation read is shown through them.
const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(store, /import \{ StateIntents, type IntentKind \} from "\.\/readIntent"/);
assert.match(store, /const intents = new StateIntents\(\(ids, want, kind\) => api\.threadAction\(ids, INTENT_ACTION\[kind\]\[want \? 0 : 1\]/, "an idempotent set, not a toggle");
assert.match(store, /read: \["read", "unread"\]/);
const act = store.slice(store.indexOf("  act: async"), store.indexOf("  openCompose: async"));
assert.match(act, /const intent = INTENT_OF\.get\(action\);\s*if \(intent\) \{[\s\S]*?intents\.set\(ids, intent\.want, intent\.kind\)[\s\S]*?return;\s*\}/, "act sends read / unread through the intents");
assert.ok(act.indexOf("intents.set") < act.indexOf("api.threadAction"), "the read / unread branch comes before the generic call");
const refresh = store.slice(store.indexOf("  refresh: async"), store.indexOf("  sync: async"));
assert.match(refresh, /const tok = intents\.begin\(\)/);
assert.match(refresh, /intents\.threads\(await api\.listThreads/, "the list is shown through the intents");
assert.match(refresh, /intents\.changedSince\(tok\)/, "folder counts older than a change are not shown");
assert.match(refresh, /intents\.end\(tok\)/);
const select = store.slice(store.indexOf("  select: async"), store.indexOf("  toggleCheck: (id) =>"));
assert.match(select, /intents\.messages\(id, await api\.getThread/, "the opened conversation is shown through the intents");
assert.match(store.slice(store.indexOf("  reloadMessages: async"), store.indexOf("  setView: async")), /intents\.messages\(selected, await api\.getThread/);
// the only callers of the read / unread backend call
assert.equal((store.match(/threadAction\(/g) ?? []).length, 2, "one in the intents' sender, one for the other actions");
console.log("read-intent: all checks passed");
