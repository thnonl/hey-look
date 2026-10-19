// Leaving a message being written to read another mail (F-21): nothing written closes it without a draft; something written is saved FIRST
// and the pane closes only when the save worked; a failed save keeps it open; files still coming in are waited for; a scheduled message
// with unsaved changes asks. Behaviour of src/leaveCompose.ts.
// Run: node --experimental-strip-types scripts/test-leave-compose.mjs
import assert from "node:assert/strict";
import { leaveCompose, MAX_SAVES, nothingToKeep } from "../src/leaveCompose.ts";

/** A fake pane: `s` is its state, `log` the order things happened in. */
function pane(over = {}) {
  const s = { open: true, scheduled: false, dirty: true, hasContent: true /* worth a draft (draftContent) */, recipientsOnly: false, attaching: false, rev: 1, saveResult: true, attachResult: true, answer: "keep", typeDuringSave: 0, emptyDuringSave: false, ...over };
  const log = [];
  const env = {
    open: () => s.open,
    scheduled: () => s.scheduled,
    dirty: () => s.dirty,
    probe: () => ({ hasContent: s.hasContent || s.recipientsOnly, draftContent: s.hasContent, attaching: s.attaching, rev: s.rev }),
    attached: async () => {
      log.push("wait-files");
      if (s.attachResult) s.attaching = false;
      return s.attachResult;
    },
    save: async (onSaved) => {
      log.push("save");
      if (s.typeDuringSave > 0) {
        s.typeDuringSave--;
        if (s.emptyDuringSave) s.hasContent = false; // ... and deleted everything again
        s.rev++; // the person typed while the draft was on its way
        s.dirty = true;
      } else if (s.saveResult === true) s.dirty = false;
      if (s.saveResult === true) onSaved({ plain: false, edit: () => log.push("edit") });
      return s.saveResult;
    },
    askScheduled: async () => (log.push("ask"), s.answer),
    dropEmptied: async () => void log.push("drop-copy"),
    close: async () => {
      log.push("close");
      s.open = false;
    },
  };
  return { s, log, env };
}

// 1. nothing open: nothing to do
{
  const p = pane({ open: false });
  assert.deepEqual(await leaveCompose(p.env), { kind: "none" });
  assert.deepEqual(p.log, []);
}

// 2. never touched (an opened draft, an untouched reply or forward): closes, no draft
{
  const p = pane({ dirty: false, hasContent: false });
  assert.deepEqual(await leaveCompose(p.env), { kind: "closed", why: "empty" });
  assert.deepEqual(p.log, ["close"]);
}

// 3. touched, then emptied again (typed and deleted; a reply whose quote is all that is left): closes, no draft; the copy an autosave made goes first
//    (W2.3), never after the pane is gone
{
  const p = pane({ dirty: true, hasContent: false });
  assert.deepEqual(await leaveCompose(p.env), { kind: "closed", why: "empty" });
  assert.deepEqual(p.log, ["drop-copy", "close"]);
}
// 3b. untouched: nothing was saved by this message, nothing to drop
{
  const p = pane({ dirty: false, hasContent: false });
  await leaveCompose(p.env);
  assert.ok(!p.log.includes("drop-copy"));
}

// 3c. W13.5: only recipients typed (the local snapshot has content, a draft does not): closes with no question and no save, the copy an autosave made goes
{
  const p = pane({ dirty: true, hasContent: false, recipientsOnly: true });
  assert.deepEqual(await leaveCompose(p.env), { kind: "closed", why: "empty" });
  assert.deepEqual(p.log, ["drop-copy", "close"], "no save, no draft");
  assert.equal(nothingToKeep(p.env.probe()), true);
  assert.equal(nothingToKeep(pane({ hasContent: true }).env.probe()), false, "text: something to keep");
  assert.equal(nothingToKeep(pane({ hasContent: false, attaching: true }).env.probe()), false, "files still coming in: not decided yet");
  assert.equal(nothingToKeep(null), false, "no pane to ask");
}

// 4. something written: saved first, then closed (the order matters: nothing is lost if the save never comes back)
{
  const p = pane();
  const out = await leaveCompose(p.env);
  assert.equal(out.kind, "saved");
  assert.equal(typeof out.saved.edit, "function");
  assert.deepEqual(p.log, ["save", "close"]);
  out.saved.edit();
  assert.deepEqual(p.log.at(-1), "edit");
}

// 5. the save fails: the pane stays open, nothing is closed
{
  const p = pane({ saveResult: false });
  assert.deepEqual(await leaveCompose(p.env), { kind: "stay", why: "save-failed" });
  assert.deepEqual(p.log, ["save"]);
  assert.equal(p.s.open, true);
}
{
  // a saver that answers nothing (void) is not a success either
  const p = pane({ saveResult: undefined });
  assert.deepEqual(await leaveCompose(p.env), { kind: "stay", why: "save-failed" });
  assert.equal(p.s.open, true);
}

// 6. typed while the draft was being saved: saved again, closed after the last one
{
  const p = pane({ typeDuringSave: 1 });
  assert.equal((await leaveCompose(p.env)).kind, "saved");
  assert.deepEqual(p.log, ["save", "save", "close"]);
}
// W13.5: ... but everything was deleted again during the save: no second save (it would be refused: nothing to save), the copy the first one made goes, closed
{
  const p = pane({ typeDuringSave: 1, emptyDuringSave: true });
  assert.deepEqual(await leaveCompose(p.env), { kind: "closed", why: "empty" });
  assert.deepEqual(p.log, ["save", "drop-copy", "close"]);
}
// ... and a person who keeps typing through every save is not cut off: the pane stays
{
  const p = pane({ typeDuringSave: 99 });
  assert.deepEqual(await leaveCompose(p.env), { kind: "stay", why: "typing" });
  assert.equal(p.log.filter((x) => x === "save").length, MAX_SAVES);
  assert.equal(p.s.open, true);
}

// 7. files still coming in: waited for, then they are part of the draft
{
  const p = pane({ attaching: true });
  assert.equal((await leaveCompose(p.env)).kind, "saved");
  assert.deepEqual(p.log, ["wait-files", "save", "close"]);
}
// ... even when only a file was dropped on an otherwise untouched message
{
  const p = pane({ attaching: true, dirty: false, hasContent: false });
  p.env.attached = async () => {
    p.log.push("wait-files");
    p.s.attaching = false;
    p.s.dirty = true;
    p.s.hasContent = true;
    return true;
  };
  assert.equal((await leaveCompose(p.env)).kind, "saved");
  assert.deepEqual(p.log, ["wait-files", "save", "close"]);
}
// ... and when they do not come in, the pane stays open with a word about it
{
  const p = pane({ attaching: true, attachResult: false });
  assert.deepEqual(await leaveCompose(p.env), { kind: "stay", why: "attaching" });
  assert.deepEqual(p.log, ["wait-files"]);
  assert.equal(p.s.open, true);
}

// 8. a scheduled message is not a draft: untouched it closes; with unsaved changes the person decides; nothing is saved either way
{
  const p = pane({ scheduled: true, dirty: false });
  assert.deepEqual(await leaveCompose(p.env), { kind: "closed", why: "scheduled" });
  assert.deepEqual(p.log, ["close"]);
}
{
  const p = pane({ scheduled: true, dirty: true, answer: "keep" });
  assert.deepEqual(await leaveCompose(p.env), { kind: "stay", why: "kept" });
  assert.deepEqual(p.log, ["ask"]);
}
{
  const p = pane({ scheduled: true, dirty: true, answer: "discard" });
  assert.deepEqual(await leaveCompose(p.env), { kind: "closed", why: "discarded" });
  assert.deepEqual(p.log, ["ask", "close"]);
}

// 9. no probe at all (the pane is still starting): a touched message is saved rather than guessed empty
{
  const p = pane();
  p.env.probe = () => null;
  assert.equal((await leaveCompose(p.env)).kind, "saved");
  assert.deepEqual(p.log, ["save", "close"]);
}

console.log("test-leave-compose: ok");
