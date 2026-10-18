// 1.0.4: clicking Flag / Unflag or Pin / Unpin several times quickly must end in the state of the LAST click and stay there (the same
// problem F-16 / F-17 fixed for read / unread). Before, every click was its own backend call finishing in any order, and each one ended
// with a re-read of the list that could show the old row over the new state. The intent layer (src/readIntent.ts) now carries flag and pin
// like read: last write wins, one call per conversation and kind under way, an idempotent set (star / unstar, pin / unpin; never a toggle),
// a stale list read does not undo it, a failed final call rolls back. Behaviour with the backend simulated (calls that finish when the test
// says, in any order), plus source checks that store.ts routes the four actions through it. Read / unread: scripts/test-read-intent.mjs.
// Run: node --experimental-strip-types scripts/test-flag-pin-intent.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StateIntents } from "../src/readIntent.ts";

const tick = () => new Promise((r) => setImmediate(r));

/** A backend whose calls finish when told. `server[kind][id]` is the state each conversation has on the server. */
function backend(initial = {}) {
  const server = { read: {}, flag: {}, pin: {}, ...initial };
  const calls = [];
  const log = [];
  const send = (ids, want, kind) =>
    new Promise((resolve, reject) => {
      const c = { ids: [...ids], want, kind, resolve: () => (ids.forEach((i) => (server[kind][i] = want)), resolve()), reject: (e) => reject(e) };
      calls.push(c);
      log.push({ ids: [...ids], want, kind });
    });
  return { server, calls, log, send, finish: (c) => (calls.splice(calls.indexOf(c), 1), c.resolve()), fail: (c, e = new Error("imap down")) => (calls.splice(calls.indexOf(c), 1), c.reject(e)) };
}
const th = (id, extra = {}) => ({ threadId: id, unread: 0, flagged: false, pinned: false, ...extra });

for (const kind of ["flag", "pin"]) {
  const field = kind === "flag" ? "flagged" : "pinned";

  // 1. rapid clicks (flag, unflag, flag ... ): one call under way, a single follow-up with the FINAL state, the server ends at the last click
  for (const lastIsOn of [true, false]) {
    const b = backend();
    const it = new StateIntents(b.send);
    const results = [];
    const clicks = lastIsOn ? [true, false, true, false, true] : [true, false, true, false, true, false];
    for (const want of clicks) {
      results.push(it.set(["a"], want, kind));
      await tick();
    }
    assert.equal(b.calls.length, 1, `${kind}: one call per conversation under way`);
    assert.deepEqual(b.log, [{ ids: ["a"], want: true, kind }], `${kind}: the first click went out at once`);
    // while it runs, the stale backend row must not be shown over the last click
    const tok = it.begin();
    assert.equal(it.threads([th("a", { [field]: !lastIsOn })], tok)[0][field], lastIsOn, `${kind}: the last click is shown, not the old row`);
    b.finish(b.calls[0]);
    await tick();
    if (lastIsOn) {
      // the call under way already carried the final state: nothing more to send
      assert.equal(b.calls.length, 0, `${kind}: no second call when the sent state is the final one`);
      assert.equal(b.log.length, 1);
    } else {
      assert.equal(b.calls.length, 1, `${kind}: the follow-up is a single call`);
      assert.deepEqual(b.log[1], { ids: ["a"], want: false, kind }, `${kind}: the follow-up sets the FINAL state (a set, not a toggle)`);
      b.finish(b.calls[0]);
    }
    const settled = await Promise.all(results);
    assert.equal(b.server[kind].a, lastIsOn, `${kind}: the server ends in the state of the last click`);
    assert.deepEqual(settled.map((r) => r.superseded), clicks.map((_, i) => i < clicks.length - 1), `${kind}: only the last click reports the outcome`);
    it.end(tok);
  }

  // 2. a list read that began before the call finished and answers after it carries the old row: it is not shown over the new state
  {
    const b = backend();
    const it = new StateIntents(b.send);
    const tok = it.begin(); // a read of the list begins ...
    const p = it.set(["a"], true, kind); // ... then the person clicks, the call goes out and finishes ...
    await tick();
    b.finish(b.calls[0]);
    await p;
    assert.equal(it.threads([th("a")], tok)[0][field], true, `${kind}: the answer is older than the change, the change is shown`);
    it.end(tok);
    const later = it.begin(); // a read that began after: the server's word counts (the mail changed elsewhere)
    assert.equal(it.threads([th("a")], later)[0][field], false, `${kind}: a later read is trusted`);
    it.end(later);
  }

  // 3. a failed final call: the intent is dropped, the next read shows the server's state, the click reports the failure
  {
    const b = backend();
    const it = new StateIntents(b.send);
    const p = it.set(["a"], true, kind);
    await tick();
    const tok = it.begin();
    assert.equal(it.threads([th("a")], tok)[0][field], true, `${kind}: shown as clicked while the call runs`);
    b.fail(b.calls[0]);
    const r = await p;
    assert.deepEqual(r.failed, ["a"]);
    assert.equal(r.superseded, false);
    assert.equal(it.threads([th("a")], tok)[0][field], false, `${kind}: rolled back to the server's state`);
    it.end(tok);
  }

  // 4. a failure of a call that was superseded is not an error: the newer state decides
  {
    const b = backend();
    const it = new StateIntents(b.send);
    const first = it.set(["a"], true, kind);
    await tick();
    const second = it.set(["a"], false, kind);
    await tick();
    b.fail(b.calls[0]);
    await tick();
    assert.equal(b.calls.length, 1, `${kind}: the final state is sent next`);
    assert.deepEqual(b.log[1], { ids: ["a"], want: false, kind });
    b.finish(b.calls[0]);
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.superseded, true);
    assert.deepEqual([r2.failed, r2.superseded], [[], false]);
    assert.equal(b.server[kind].a, false);
  }
}

// 5. the kinds do not touch each other: read, flag and pin of one conversation each have their own call and their own last word
{
  const b = backend();
  const it = new StateIntents(b.send);
  const reads = it.set(["a"], true, "read");
  const flags = it.set(["a"], true, "flag");
  const pins = it.set(["a"], true, "pin");
  await tick();
  assert.deepEqual(b.log.map((c) => c.kind).sort(), ["flag", "pin", "read"], "three calls side by side, one per kind");
  const flags2 = it.set(["a"], false, "flag"); // flag again while its call is under way; the others are not affected
  await tick();
  assert.equal(b.log.length, 3, "the second flag click waits for the first");
  const tok = it.begin();
  const row = it.threads([th("a", { unread: 2, flagged: true, pinned: false })], tok)[0];
  assert.deepEqual([row.unread, row.flagged, row.pinned], [0, false, true], "each kind is laid over its own field");
  for (const c of [...b.calls]) b.finish(c);
  await tick();
  b.finish(b.calls[0]); // the flag follow-up
  await Promise.all([reads, flags, pins, flags2]);
  assert.deepEqual([b.server.read.a, b.server.flag.a, b.server.pin.a], [true, false, true]);
  it.end(tok);
}

// 6. a batch (several conversations) is one call per kind and state; conversations are independent
{
  const b = backend();
  const it = new StateIntents(b.send);
  const p1 = it.set(["a", "b", "c"], true, "flag");
  const p2 = it.set(["d"], false, "flag");
  await tick();
  assert.deepEqual(b.log, [{ ids: ["a", "b", "c"], want: true, kind: "flag" }, { ids: ["d"], want: false, kind: "flag" }]);
  for (const c of [...b.calls]) b.finish(c);
  await Promise.all([p1, p2]);
  assert.deepEqual(b.server.flag, { a: true, b: true, c: true, d: false });
}

// 7. read / unread untouched by the generalisation: the sender is still called with (ids, want) first, kind defaults to "read"
{
  const b = backend();
  const it = new StateIntents(b.send);
  const p = it.set(["a"], false);
  await tick();
  assert.deepEqual(b.log, [{ ids: ["a"], want: false, kind: "read" }]);
  b.finish(b.calls[0]);
  await p;
}

// 8. random clicking on all three kinds with calls finishing in any order: every kind of every conversation ends where its last click put it,
//    and a list read that began before a call finished never shows a state older than the last click
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let round = 0; round < 150; round++) {
    const b = backend();
    const it = new StateIntents(b.send);
    const ids = ["a", "b", "c"];
    const kinds = ["read", "flag", "pin"];
    const last = {};
    const pending = [];
    const open = [];
    for (let step = 0; step < 30; step++) {
      const r = rnd();
      if (r < 0.5) {
        const id = ids[Math.floor(rnd() * ids.length)];
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        const want = rnd() < 0.5;
        last[`${kind}|${id}`] = want;
        pending.push(it.set([id], want, kind));
        await tick();
      } else if (r < 0.8 && b.calls.length) {
        const c = b.calls[Math.floor(rnd() * b.calls.length)];
        b.finish(c);
        await tick();
      } else if (r < 0.9) {
        open.push(it.begin());
      } else if (open.length) {
        const tok = open.splice(Math.floor(rnd() * open.length), 1)[0];
        // a read that began now: whatever the server does not have yet is shown as last clicked (the row it carries is all off)
        const rows = it.threads(ids.map((id) => th(id)), it.begin());
        for (const row of rows) {
          for (const [kind, shows] of [["read", (x) => x.unread === 0], ["flag", (x) => x.flagged], ["pin", (x) => x.pinned]]) {
            const k = `${kind}|${row.threadId}`;
            if (k in last && (b.server[kind][row.threadId] ?? false) !== last[k]) assert.equal(shows(row), last[k], `round ${round}: ${k} is shown as last clicked while the server lacks it`);
          }
        }
        it.end(tok);
      }
    }
    while (b.calls.length) {
      b.finish(b.calls[0]);
      await tick();
    }
    await Promise.all(pending);
    for (const [k, want] of Object.entries(last)) {
      const [kind, id] = k.split("|");
      assert.equal(b.server[kind][id], want, `round ${round}: ${k} ends where the last click put it`);
    }
    for (const t of open) it.end(t);
  }
}

// 9. store.ts: star / unstar and pin / unpin go through the intents like read / unread
const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(store, /flag: \["star", "unstar"\], pin: \["pin", "unpin"\]/, "a set (star / unstar, pin / unpin), never a toggle");
const act = store.slice(store.indexOf("  act: async"), store.indexOf("  openCompose: async"));
assert.match(act, /const intent = INTENT_OF\.get\(action\);\s*if \(intent\) \{[\s\S]*?intents\.set\(ids, intent\.want, intent\.kind\)[\s\S]*?return;\s*\}/);
assert.ok(act.indexOf("intents.set") < act.indexOf("api.threadAction"), "the yes/no branch comes before the generic call");
assert.match(act, /applyOptimistic\(ids, action\)/, "the click still shows at once");
// every place that flags or pins asks `act` for star / unstar / pin / unpin (none calls the backend itself)
for (const f of ["App.tsx", "components/MessageList.tsx", "components/ReadingPane.tsx", "components/Ribbon.tsx", "components/CommandBar.tsx"]) {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.doesNotMatch(src, /threadAction\(/, `${f} does not call the backend directly`);
  assert.match(src, /"unstar"|"unpin"/, `${f} uses act`);
}
console.log("flag-pin-intent: all checks passed");
