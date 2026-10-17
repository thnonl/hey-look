// The page's part of a quit (REQ-48 b, c; QA Linux v1.0.6, tray "Quit" that never ended): the page says at once that it got the request, saves a
// message being written, brings the window in front BEFORE it asks anything (the window may sit in the tray), tells the backend when a question
// is open, always answers once, and lets the sends go out. Behaviour of src/quitFlush.ts.
// Run: node --experimental-strip-types scripts/test-quit-flush.mjs
import assert from "node:assert/strict";
import { runQuitFlush } from "../src/quitFlush.ts";

/** Deps that write down what happens, in order. `unsaved` and `choice` set the situation. */
function page({ unsaved = null, choice = "quit", inFlight = 0, flushThrows = false } = {}) {
  const log = [];
  const d = {
    alive: () => log.push("alive"),
    showWindow: () => log.push("show"),
    dialog: (open) => log.push(`dialog:${open}`),
    done: (go) => log.push(`done:${go}`),
    unsaved: () => unsaved && { scheduled: !!unsaved.scheduled, save: unsaved.save ?? null },
    ask: async (kind) => (log.push(`ask:${kind}`), typeof choice === "function" ? choice(kind) : choice),
    saved: async () => void log.push("saved"),
    discarded: async () => void log.push("discarded"),
    inFlight: () => inFlight,
    tell: (n) => log.push(`tell:${n}`),
    flush: async (ms) => {
      log.push(`flush:${ms}`);
      if (flushThrows) throw new Error("boom");
    },
  };
  return { d, log };
}

// nothing is being written: alive first, the sends go out, one answer "go on"
{
  const { d, log } = page();
  assert.equal(await runQuitFlush(d), true);
  assert.deepEqual(log, ["alive", "flush:20000", "done:true"]);
}

// sends under way: the person is told
{
  const { d, log } = page({ inFlight: 2 });
  await runQuitFlush(d);
  assert.deepEqual(log, ["alive", "tell:2", "flush:20000", "done:true"]);
}

// a message being written that saves quietly: no question, no window, the pane is emptied
{
  const { d, log } = page({ unsaved: { save: async (o) => (assert.deepEqual(o, { quiet: true }), true) } });
  assert.equal(await runQuitFlush(d), true);
  assert.deepEqual(log, ["alive", "saved", "flush:20000", "done:true"]);
}

// a message that cannot be saved: the window first, then the backend is told a question is open (and closed), "Quit and discard" goes on
{
  const { d, log } = page({ unsaved: { save: async () => false }, choice: "quit" });
  assert.equal(await runQuitFlush(d), true);
  assert.deepEqual(log, ["alive", "show", "dialog:true", "ask:notSaved", "dialog:false", "discarded", "flush:20000", "done:true"]);
  assert.ok(log.indexOf("show") < log.indexOf("dialog:true") && log.indexOf("dialog:true") < log.indexOf("ask:notSaved"), "the window is in front before the question");
}

// "Keep writing": the quit stops, nothing is discarded, nothing is flushed, the backend hears "no"
{
  const { d, log } = page({ unsaved: { save: async () => false }, choice: "keep" });
  assert.equal(await runQuitFlush(d), false);
  assert.deepEqual(log, ["alive", "show", "dialog:true", "ask:notSaved", "dialog:false", "done:false"]);
}

// no saver at all (the pane is not ready): the same question
{
  const { d, log } = page({ unsaved: { save: null }, choice: "quit" });
  assert.equal(await runQuitFlush(d), true);
  assert.ok(log.includes("ask:notSaved") && log.includes("discarded"), log.join());
}

// a scheduled message being edited: it stays as it was; the question, then go on or stay
{
  const a = page({ unsaved: { scheduled: true }, choice: "quit" });
  assert.equal(await runQuitFlush(a.d), true);
  assert.deepEqual(a.log, ["alive", "show", "dialog:true", "ask:scheduledEdit", "dialog:false", "flush:20000", "done:true"]);
  const b = page({ unsaved: { scheduled: true }, choice: "keep" });
  assert.equal(await runQuitFlush(b.d), false);
  assert.deepEqual(b.log, ["alive", "show", "dialog:true", "ask:scheduledEdit", "dialog:false", "done:false"]);
}

// whatever fails, the backend gets its answer exactly once (otherwise it would wait out its limit): the quit goes on
{
  const a = page({ unsaved: { save: async () => { throw new Error("imap"); } } });
  assert.equal(await runQuitFlush(a.d), true);
  assert.deepEqual(a.log.filter((l) => l.startsWith("done")), ["done:true"]);
  const b = page({ flushThrows: true });
  assert.equal(await runQuitFlush(b.d), true);
  assert.deepEqual(b.log.filter((l) => l.startsWith("done")), ["done:true"]);
}

console.log("quit flush ok");
