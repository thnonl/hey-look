// The page's part of a quit (REQ-48 b, c; QA Linux v1.0.6, tray "Quit" that never ended): the page says at once that it got the request, saves a
// message being written, brings the window in front BEFORE it asks anything (the window may sit in the tray), tells the backend when a question
// is open, always answers once, and lets the sends go out. Behaviour of src/quitFlush.ts.
// Run: node --experimental-strip-types scripts/test-quit-flush.mjs
import assert from "node:assert/strict";
import { runQuitFlush } from "../src/quitFlush.ts";
import { currentFlushHandlers, flushHandlerCount, registerFlushHandler, runPopoutFlush } from "../src/popout/flush.ts";

/** Deps that write down what happens, in order. `unsaved` and `choice` set the situation. */
function page({ unsaved = null, choice = "quit", inFlight = 0, flushThrows = false } = {}) {
  const log = [];
  const d = {
    alive: () => log.push("alive"),
    showWindow: () => log.push("show"),
    dialog: (open) => log.push(`dialog:${open}`),
    done: (go) => log.push(`done:${go}`),
    unsaved: () => unsaved && { scheduled: !!unsaved.scheduled, empty: !!unsaved.empty, save: unsaved.save ?? null },
    ask: async (kind) => (log.push(`ask:${kind}`), typeof choice === "function" ? choice(kind) : choice),
    saved: async () => void log.push("saved"),
    emptied: async () => void log.push("emptied"),
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

// W13.5: a message with nothing worth a draft (only recipients, or typed and deleted again): not saved, not asked about, the pane is emptied
{
  const { d, log } = page({ unsaved: { empty: true, save: async () => assert.fail("no draft is saved") }, choice: () => assert.fail("no question") });
  assert.equal(await runQuitFlush(d), true);
  assert.deepEqual(log, ["alive", "emptied", "flush:20000", "done:true"]);
}
// ... but a scheduled message being edited still asks (it is not a draft)
{
  const { d, log } = page({ unsaved: { scheduled: true, empty: true }, choice: "quit" });
  assert.equal(await runQuitFlush(d), true);
  assert.ok(log.includes("ask:scheduledEdit") && !log.includes("emptied"), log.join());
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

// ---- the part of a secondary window (pop-out): src/popout/flush.ts, answered to the backend with its own commands (popout_flush_*)

/** Deps that write down what happens, in order; `handlers` are what the views registered. */
function popout(handlers) {
  const log = [];
  const d = {
    alive: () => log.push("alive"),
    done: (go) => log.push(`done:${go}`),
    ctx: { why: "quit", dialog: (open) => log.push(`dialog:${open}`), showWindow: () => log.push("show") },
    handlers: () => handlers(log),
  };
  return { d, log };
}

// a window with nothing to save (the placeholder, an unchanged compose window): alive, then "go on" at once
{
  const { d, log } = popout(() => []);
  assert.equal(await runPopoutFlush(d), true);
  assert.deepEqual(log, ["alive", "done:true"]);
}

// handlers run in order; each may take time; the window answers once, after the last one
{
  const { d, log } = popout((l) => [async () => void l.push("save-a"), () => void l.push("save-b")]);
  assert.equal(await runPopoutFlush(d), true);
  assert.deepEqual(log, ["alive", "save-a", "save-b", "done:true"]);
}

// a handler that cannot save asks the person: the window first, then the backend is told a question is open, and closed again;
// "Keep writing" (false) cancels the whole quit and nothing after it runs
{
  const { d, log } = popout((l) => [
    async (ctx) => {
      ctx.showWindow();
      ctx.dialog(true);
      ctx.dialog(false);
      return false;
    },
    () => void l.push("must-not-run"),
  ]);
  assert.equal(await runPopoutFlush(d), false);
  assert.deepEqual(log, ["alive", "show", "dialog:true", "dialog:false", "done:false"]);
}

// "Close and discard" (true) goes on
{
  const { d, log } = popout(() => [async () => true]);
  assert.equal(await runPopoutFlush(d), true);
  assert.deepEqual(log, ["alive", "done:true"]);
}

// whatever fails, the backend gets its answer exactly once (otherwise it would wait out its limit): the quit goes on
{
  const { d, log } = popout(() => [async () => { throw new Error("imap"); }]);
  assert.equal(await runPopoutFlush(d), true);
  assert.deepEqual(log.filter((l) => l.startsWith("done")), ["done:true"]);
}

// the registry: a view registers for its lifetime and removes itself
{
  assert.equal(flushHandlerCount(), 0);
  const h = () => false;
  const off = registerFlushHandler(h);
  assert.deepEqual(currentFlushHandlers(), [h]);
  off();
  assert.equal(flushHandlerCount(), 0);
}

// the wiring: the root listens before it says it is ready (the backend asks only ready windows), and answers with the pop-out commands
// (the quit commands of the main page are not granted to a pop-out)
{
  const { readFileSync } = await import("node:fs");
  const root = readFileSync(new URL("../src/popout/PopoutRoot.tsx", import.meta.url), "utf8");
  const listen = root.indexOf('>("popout-flush"');
  assert.ok(listen > 0 && listen < root.indexOf("api.popoutReady()"), "listener before ready");
  for (const call of ["api.popoutFlushAlive()", "api.popoutFlushDone(go)", "api.popoutFlushDialog(open)"]) assert.ok(root.includes(call), call);
  for (const main of ["api.sendsFlushed", "api.quitPageAlive", "api.quitDialog", '"flush-sends"']) assert.ok(!root.includes(main), `a pop-out must not use ${main}`);
}

// W6.12: the main page is told how many scheduled messages are due (they go out after its part) and the toast counts them with the messages in their Undo time
{
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes('listen<{ due?: number } | null>("flush-sends"'), "the request carries { due }");
  assert.ok(app.includes("inFlight: () => useStore.getState().sendsInFlight + due,"), "the toast counts the due scheduled messages too");
  // a page that gets no number (an older backend, null) counts none
  const n = (p) => Math.max(0, Math.floor(Number(p?.due ?? 0)) || 0);
  assert.deepEqual([n(null), n(undefined), n({}), n({ due: 3 }), n({ due: "x" }), n({ due: -2 })], [0, 0, 0, 3, 0, 0]);
  // the toast of a quit with only scheduled messages due: the flush says "go" and tells the count
  const log = [];
  const go = await runQuitFlush({
    alive() {}, showWindow() {}, dialog() {}, done: (g) => log.push("done:" + g),
    unsaved: () => null, ask: async () => "quit", saved: async () => {}, emptied: async () => {}, discarded: async () => {},
    inFlight: () => 0 + 2, tell: (k) => log.push("tell:" + k), flush: async () => {},
  });
  assert.equal(go, true);
  assert.deepEqual(log, ["tell:2", "done:true"]);
}

console.log("quit flush ok");
