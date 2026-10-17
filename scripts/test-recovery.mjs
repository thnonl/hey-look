// Crash recovery of the message being written (QA round 17 BUG-02): the writer that keeps the snapshot (one at a time, newest wins, attachments
// only when they changed and the last send of them worked, nothing after the message is over), and the question at the next start (restore opens
// a message and never sends it, discard removes it, anything else keeps it). Behaviour of src/recovery.ts.
// Run: node --experimental-strip-types scripts/test-recovery.mjs
import assert from "node:assert/strict";
import { RecoveryWriter, offerRecovery } from "../src/recovery.ts";

const att = (n) => ({ filename: `${n}.txt`, mime: "text/plain", dataBase64: btoa(n) });
const form = (subject) => ({ accountId: "a1", subject, preview: subject, payload: JSON.stringify({ subject }) });

/** A backend that remembers what it was given; `gate` holds a save until `release()` and `fail` makes saves fail. */
function backend() {
  const b = { saves: [], clears: [], whys: [], fail: 0, gate: null, stored: null };
  b.api = {
    save: async (s) => {
      if (b.gate) await b.gate.promise;
      if (b.fail > 0) {
        b.fail--;
        throw new Error("disk");
      }
      b.saves.push(s);
      b.stored = { ...s, files: s.files ?? b.stored?.files ?? [] };
    },
    clear: async (id, why) => {
      b.clears.push(id);
      b.whys.push(why);
      b.stored = null;
    },
  };
  b.hold = () => {
    let resolve;
    b.gate = { promise: new Promise((r) => (resolve = r)) };
    b.release = () => {
      const g = b.gate;
      b.gate = null;
      resolve();
      return g;
    };
  };
  return b;
}

// 1. a write goes out; the attachments go with the first one and are not sent again while they are the same
{
  const b = backend();
  const w = new RecoveryWriter("m1", b.api);
  w.write(form("one"), "k1", () => [att("a")]);
  await w.idle();
  w.write(form("two"), "k1", () => assert.fail("the same attachments are not read again"));
  await w.idle();
  w.write(form("three"), "k2", () => [att("a"), att("b")]);
  await w.idle();
  assert.deepEqual(b.saves.map((s) => [s.subject, s.files?.length ?? null]), [["one", 1], ["two", null], ["three", 2]]);
  assert.equal(b.stored.files.length, 2);
  assert.equal(w.writes, 3);
}

// 2. one at a time, the newest wins: writes that pile up while one is running become one
{
  const b = backend();
  const w = new RecoveryWriter("m1", b.api);
  b.hold();
  w.write(form("a"), "k", () => []);
  w.write(form("b"), "k", () => []);
  w.write(form("c"), "k", () => []);
  b.release();
  await w.idle();
  assert.deepEqual(b.saves.map((s) => s.subject), ["a", "c"], "the one that was running, then the newest");
}

// 3. a failed write: nothing breaks, the next one carries the attachments again (they were not stored)
{
  const b = backend();
  const w = new RecoveryWriter("m1", b.api);
  w.write(form("a"), "k1", () => [att("a")]);
  await w.idle();
  b.fail = 1;
  w.write(form("b"), "k2", () => [att("a"), att("b")]); // fails: k2 was not stored
  await w.idle();
  assert.equal(w.failures, 1);
  w.write(form("c"), "k2", () => [att("a"), att("b")]);
  await w.idle();
  assert.equal(w.failures, 0, "a success starts over");
  assert.deepEqual(b.stored.files.map((f) => f.filename), ["a.txt", "b.txt"], "the attachments are there although the write that carried them failed");
  // a failed first write too
  const b2 = backend();
  const w2 = new RecoveryWriter("m2", b2.api);
  b2.fail = 1;
  w2.write(form("x"), "k", () => [att("x")]);
  await w2.idle();
  w2.write(form("y"), "k", () => [att("x")]);
  await w2.idle();
  assert.equal(b2.stored.files.length, 1);
}

// 4. clear: waits for the running write, removes the snapshot, and nothing is written for this message afterwards
{
  const b = backend();
  const w = new RecoveryWriter("m1", b.api);
  b.hold();
  w.write(form("a"), "k", () => []);
  const cleared = w.clear();
  w.write(form("late"), "k", () => []); // the message is over: ignored
  b.release();
  await cleared;
  w.write(form("later"), "k", () => []);
  await w.idle();
  assert.deepEqual(b.saves.map((s) => s.subject), ["a"]);
  assert.deepEqual(b.clears, ["m1"]);
  assert.equal(b.stored, null, "the snapshot is gone, in that order: write, then clear");
  assert.equal(w.isClosed, true);
  // a clear that fails does not throw (the snapshot is offered at the next start)
  const b2 = backend();
  b2.api.clear = async () => {
    throw new Error("locked");
  };
  await new RecoveryWriter("m2", b2.api).clear();
}

// 4b. a pane mounted twice in a row (React strict mode in the dev page): the clear between the two mounts does not stop the writer for good
{
  const b = backend();
  const w = new RecoveryWriter("m1", b.api);
  await w.clear(); // the first mount is undone
  w.open(); // the second mount
  w.write(form("a"), "k", () => []);
  await w.idle();
  assert.deepEqual(b.saves.map((s) => s.subject), ["a"]);
  assert.equal(w.isClosed, false);
}

// 5. release: the message is saved to Drafts, the snapshot goes, but the message goes on and its next change writes a new one
{
  const b = backend();
  const w = new RecoveryWriter("m1", b.api);
  w.write(form("a"), "k1", () => [att("a")]);
  await w.idle();
  await w.release();
  assert.equal(b.stored, null);
  assert.equal(w.isClosed, false);
  w.write(form("b"), "k1", () => [att("a")]);
  await w.idle();
  assert.equal(b.stored.subject, "b");
  assert.equal(b.stored.files.length, 1, "the attachments are sent again after a release (the backend dropped them)");
  // a write that is waiting while release runs is the newer one: it is kept
  const b2 = backend();
  const w2 = new RecoveryWriter("m2", b2.api);
  b2.hold();
  w2.write(form("a"), "k", () => []);
  const released = w2.release();
  b2.release();
  await released;
  w2.write(form("b"), "k", () => []);
  await w2.idle();
  assert.equal(b2.stored?.subject, "b");
  // release after clear does nothing
  const w3 = new RecoveryWriter("m3", backend().api);
  await w3.clear();
  await w3.release();
}

// 5b. the reason goes to the backend, for startup.log ("snapshot removed (draft saved)" or "message over")
{
  const b = backend();
  const w = new RecoveryWriter("m1", b.api);
  w.write(form("a"), "k", () => []);
  await w.idle();
  await w.release();
  await w.clear();
  assert.deepEqual(b.whys, ["draft saved", "message over"]);
}

// ---- the question at the next start

const info = (id, subject, savedAt = 100) => ({ id, accountId: "a1", savedAt, subject, preview: "", files: 0 });
const loaded = (id) => ({ id, accountId: "a1", savedAt: 100, payload: "{}", files: [] });

function start(items, answers, over = {}) {
  const log = [];
  const state = { composing: false, idle: [] };
  const answer = [...answers];
  const deps = {
    list: async () => items,
    load: async (id) => (log.push(`load ${id}`), over.loadResult === undefined ? loaded(id) : over.loadResult),
    ask: async (i) => (log.push(`ask ${i.id}`), answer.shift() ?? "later"),
    open: async (l) => {
      log.push(`open ${l.id}`);
      state.composing = true;
    },
    clear: async (id) => void log.push(`clear ${id}`),
    composing: () => state.composing,
    whenIdle: () => new Promise((r) => state.idle.push(r)),
    failed: (i) => void log.push(`failed ${i.id}`),
    ...over.deps,
  };
  return { deps, log, state };
}

// 6. nothing was left: nothing is asked
{
  const s = start([], []);
  const r = await offerRecovery(s.deps);
  assert.deepEqual(r, { restored: [], discarded: [], later: [], gone: [] });
  assert.deepEqual(s.log, []);
}

// 7. restore opens it (and does nothing else: no send, no clear: the snapshot lives on with the open message)
{
  const s = start([info("m1", "Plan")], ["restore"]);
  const r = await offerRecovery(s.deps);
  assert.deepEqual(s.log, ["ask m1", "load m1", "open m1"]);
  assert.deepEqual(r.restored, ["m1"]);
}

// 8. discard removes it; "not now" (also Esc) keeps it
{
  const s = start([info("m1", "Plan")], ["discard"]);
  const r = await offerRecovery(s.deps);
  assert.deepEqual(s.log, ["ask m1", "clear m1"]);
  assert.deepEqual(r.discarded, ["m1"]);
  const k = start([info("m1", "Plan")], ["later"]);
  const r2 = await offerRecovery(k.deps);
  assert.deepEqual(k.log, ["ask m1"], "nothing is cleared or opened");
  assert.deepEqual(r2.later, ["m1"]);
}

// 9. several: newest first, one at a time; "not now" holds back the rest too; a restored one is open before the next question
{
  const items = [info("new", "N", 300), info("mid", "M", 200), info("old", "O", 100)];
  const s = start(items, ["discard", "restore", "restore"]);
  const run = offerRecovery(s.deps);
  await new Promise((r) => setTimeout(r, 10));
  // "new" was discarded, "mid" restored and is open: the question for "old" waits until the pane is free
  assert.deepEqual(s.log, ["ask new", "clear new", "ask mid", "load mid", "open mid"]);
  s.state.composing = false;
  s.state.idle.splice(0).forEach((r) => r());
  const r = await run;
  assert.deepEqual(s.log.slice(5), ["ask old", "load old", "open old"]);
  assert.deepEqual(r, { restored: ["mid", "old"], discarded: ["new"], later: [], gone: [] });
  const k = start(items, ["later", "restore", "restore"]);
  const r2 = await offerRecovery(k.deps);
  assert.deepEqual(k.log, ["ask new"], "not now: the rest is asked at the next start");
  assert.deepEqual(r2.later, ["new", "mid", "old"]);
}

// 10. a message is being written when the question comes: it waits, nothing is asked over it
{
  const s = start([info("m1", "Plan")], ["restore"]);
  s.state.composing = true;
  const run = offerRecovery(s.deps);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s.log, [], "no question while the person is writing");
  s.state.composing = false;
  s.state.idle.splice(0).forEach((r) => r());
  await run;
  assert.deepEqual(s.log, ["ask m1", "load m1", "open m1"]);
}

// 11. a snapshot that cannot be loaded is reported and kept; a list that fails asks nothing
{
  const s = start([info("m1", "Plan"), info("m2", "Other", 50)], ["restore", "restore"], { loadResult: null });
  const r = await offerRecovery(s.deps);
  assert.deepEqual(s.log, ["ask m1", "load m1", "failed m1", "ask m2", "load m2", "failed m2"]);
  assert.deepEqual(r.gone, ["m1", "m2"]);
  assert.ok(!s.log.some((l) => l.startsWith("clear") || l.startsWith("open")), "not dropped, not opened");
  const bad = start([], [], { deps: { list: async () => Promise.reject(new Error("db")) } });
  assert.deepEqual(await offerRecovery(bad.deps), { restored: [], discarded: [], later: [], gone: [] });
}

console.log("recovery: ok");
