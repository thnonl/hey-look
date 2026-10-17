// Crash recovery of the message being written (QA round 17 BUG-02): the writer that keeps the snapshot (one at a time, newest wins, attachments
// only when they changed and the last send of them worked, nothing after the message is over), and what the next start does with what is left
// (1.0.6: every snapshot is saved as a real draft without a question; what cannot be saved is kept on this computer). Behaviour of src/recovery.ts.
// Run: node --experimental-strip-types scripts/test-recovery.mjs
import assert from "node:assert/strict";
import { RecoveryWriter, composeFromSnapshot, draftFromSnapshot, settleRecovery, snapshotInWindow, LOCAL_KEEP_SECS } from "../src/recovery.ts";

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

// ---- the next start (1.0.6): no question, every snapshot is saved as a draft

const NOW = 1_800_000_000;
const snapForm = (o = {}) => ({
  v: 1, to: ["a@x.org"], cc: [], bcc: [], subject: "S", html: "<p>Hi</p>", inReplyTo: null, references: [], replaces: null, isReply: false,
  encrypt: "off", sign: false, attachKey: false, confidential: false, ...o,
});
const snap = (id, o = {}, over = {}) => ({ id, accountId: "a1", savedAt: NOW - 60, payload: JSON.stringify(snapForm(o)), files: [], ...over });
const infoOf = (l) => ({ id: l.id, accountId: l.accountId, savedAt: l.savedAt, subject: "", preview: "", files: l.files.length });

/** A backend with these snapshots. `over.save` decides per id: a result, or an Error (the server said no). */
function start(snaps, over = {}) {
  const log = [];
  const rows = new Map(snaps.map((l) => [l.id, l]));
  const drafts = [];
  const deps = {
    list: async () => [...rows.values()].map(infoOf),
    load: async (id) => (log.push(`load ${id}`), rows.get(id) ?? null),
    saveDraft: async (id, draft, replaces) => {
      log.push(`save ${id}`);
      const r = over.save ? over.save(id, draft, replaces) : { status: "saved", threadId: `t-${id}`, draftRef: `mid:a1|<${id}@x>` };
      if (r instanceof Error) throw r;
      drafts.push({ id, draft, replaces });
      rows.delete(id); // (the backend removes the snapshot once the draft is confirmed)
      return r;
    },
    clear: async (id, why) => (log.push(`clear ${id} (${why})`), void rows.delete(id)),
    now: () => NOW,
    ...over.deps,
  };
  return { deps, log, rows, drafts };
}

// 6. nothing was left: nothing happens
{
  const s = start([]);
  assert.deepEqual(await settleRecovery(s.deps), []);
  assert.deepEqual(s.log, []);
}

// 7. N snapshots -> N drafts, no question, nothing is opened, sent or discarded; newest first; the snapshots are gone only because the backend
//    removed them after the save
{
  const s = start([snap("old", {}, { savedAt: NOW - 500 }), snap("new", {}, { savedAt: NOW - 10 }), snap("mid", {}, { savedAt: NOW - 100 })]);
  const kept = await settleRecovery(s.deps);
  assert.deepEqual(kept.map((k) => [k.id, k.where]), [["new", "drafts"], ["mid", "drafts"], ["old", "drafts"]], "newest first, all in Drafts");
  assert.deepEqual(s.drafts.map((d) => d.id), ["new", "mid", "old"], "three drafts saved");
  assert.ok(s.log.every((l) => /^(load|save) /.test(l)), `only loads and saves, no clear/open/ask: ${s.log}`);
  assert.deepEqual(kept.map((k) => k.threadId), ["t-new", "t-mid", "t-old"]);
  assert.equal(s.rows.size, 0);
}

// 8. the draft: Bcc kept, pictures become inline parts (and the data: URIs leave the html), the text part is made, the draft it replaces is named
{
  const png = "iVBORw0KGgo=";
  const l = snap("p1", { to: ["Ann <a@x.org>"], cc: ["c@x.org"], bcc: ["Hidden <h@x.org>", "z@x.org"], subject: "Pic", html: `<p>Hi</p><img src="data:image/png;base64,${png}" data-name="my logo.png">`, inReplyTo: "<m1@x.org>", references: ["<m0@x.org>", "<m1@x.org>"], replaces: "mid:a1|<prev@x>", confidential: true, importance: "high" }, { files: [att("f")] });
  const d = draftFromSnapshot(l);
  assert.deepEqual(d.bcc, ["Hidden <h@x.org>", "z@x.org"], "Bcc is kept in the draft");
  assert.deepEqual([d.to, d.cc, d.subject, d.inReplyTo, d.references], [["Ann <a@x.org>"], ["c@x.org"], "Pic", "<m1@x.org>", ["<m0@x.org>", "<m1@x.org>"]]);
  assert.equal(d.inline.length, 1);
  assert.deepEqual([d.inline[0].filename, d.inline[0].mime, d.inline[0].dataBase64], ["my logo.png", "image/png", png], "the name the picture was added with");
  assert.ok(d.html.includes(`cid:${d.inline[0].cid}`) && !d.html.includes("data:image"), d.html);
  assert.ok(d.text.includes("Hi"), "a text part");
  assert.equal(d.attachments.length, 1);
  assert.deepEqual([d.confidential, d.importance], [true, "high"]);
  assert.equal(d.security, undefined, "a draft is plain here; an encrypted message is not saved from a snapshot");
  const s = start([l]);
  await settleRecovery(s.deps);
  assert.equal(s.drafts[0].replaces, "mid:a1|<prev@x>", "the draft it takes the place of is passed on: replaced in place");
  // normal importance leaves no header; an encrypted message is never sent to the server in plain text
  assert.equal(draftFromSnapshot(snap("n1")).importance, undefined);
  assert.equal(draftFromSnapshot(snap("e1", { encrypt: "on" })), null);
  assert.equal(draftFromSnapshot(snap("bad", {}, { payload: "x" })), null);
}

// 9. no Drafts folder / the server is down or refuses: nothing is lost, the snapshot stays and the message is "kept on this computer"
{
  const s = start([snap("a"), snap("b", {}, { savedAt: NOW - 5 })], { save: () => new Error("this account has no Drafts folder") });
  const kept = await settleRecovery(s.deps);
  assert.deepEqual(kept.map((k) => [k.id, k.where, k.threadId]), [["b", "local", null], ["a", "local", null]]);
  assert.equal(s.rows.size, 2, "both snapshots are still there");
  assert.ok(!s.log.some((l) => l.startsWith("clear")), "nothing was removed");
  // one fails, the others go on
  const m = start([snap("x"), snap("y", {}, { savedAt: NOW - 5 }), snap("z", {}, { savedAt: NOW - 9 })], { save: (id) => (id === "y" ? new Error("APPEND refused") : { status: "saved", threadId: `t-${id}`, draftRef: null }) });
  const k2 = await settleRecovery(m.deps);
  assert.deepEqual(k2.map((k) => [k.id, k.where]), [["y", "local"], ["z", "drafts"], ["x", "drafts"]]);
  assert.deepEqual([...m.rows.keys()], ["y"]);
  // an encrypted message has no snapshot normally; if there is one it stays local and is never sent to the server
  const e = start([snap("enc", { encrypt: "on" })]);
  assert.deepEqual((await settleRecovery(e.deps)).map((k) => k.where), ["local"]);
  assert.ok(!e.log.some((l) => l.startsWith("save")), "no save for an encrypted message");
}

// 10. a draft of the same message is on the server already (the backend says "covered"): no second draft, reported as saved in Drafts
{
  const s = start([snap("dup")], { save: () => ({ status: "covered", threadId: "t-dup", draftRef: "mid:a1|<d@x>" }) });
  const kept = await settleRecovery(s.deps);
  assert.deepEqual(kept.map((k) => [k.where, k.threadId]), [["drafts", "t-dup"]]);
  assert.equal(s.log.filter((l) => l.startsWith("save")).length, 1, "asked once; the backend decides it needs no second draft");
}

// 11. local-only snapshots older than 30 days are removed silently (with the reason for the log); newer ones stay; saved ones are never aged out
{
  assert.equal(LOCAL_KEEP_SECS, 30 * 24 * 3600);
  const s = start([snap("ancient", {}, { savedAt: NOW - LOCAL_KEEP_SECS - 5 }), snap("recent", {}, { savedAt: NOW - LOCAL_KEEP_SECS + 600 })], { save: () => new Error("offline") });
  const kept = await settleRecovery(s.deps);
  assert.deepEqual(kept.map((k) => k.id), ["recent"], "the old one is not reported");
  assert.ok(s.log.includes("clear ancient (kept on this computer for more than 30 days)"), s.log.join("\n"));
  assert.deepEqual([...s.rows.keys()], ["recent"]);
  // an old one that CAN be saved is saved (30 days only limits what stays on this computer)
  const o = start([snap("old-ok", {}, { savedAt: NOW - 90 * 86400 })]);
  assert.deepEqual((await settleRecovery(o.deps)).map((k) => k.where), ["drafts"]);
}

// 12. a snapshot that cannot be read is removed (asking again would not help); one that cannot be loaded now stays for the next start; a failing list does nothing
{
  const s = start([snap("junk", {}, { payload: "not json" }), snap("gone"), snap("fine", {}, { savedAt: NOW - 1 })]);
  const rows = s.rows;
  s.deps.load = async (id) => (s.log.push(`load ${id}`), id === "gone" ? null : rows.get(id) ?? null);
  const kept = await settleRecovery(s.deps);
  assert.deepEqual(kept.map((k) => k.id), ["fine"]);
  assert.ok(s.log.includes("clear junk (unreadable)"));
  assert.ok(s.rows.has("gone"), "kept for the next start");
  const f = start([snap("q")], { deps: { list: async () => { throw new Error("db"); } } });
  assert.deepEqual(await settleRecovery(f.deps), []);
}

// 13. where each message was written: a window message is marked so Continue opens it in a window
{
  const s = start([snap("w", { win: true }), snap("p", {}, { savedAt: NOW - 1 })]);
  const kept = await settleRecovery(s.deps);
  assert.deepEqual(kept.map((k) => [k.id, k.inWindow]), [["p", false], ["w", true]]);
}

// 15. what a snapshot gives back to Compose: Bcc, Cc, threading, toggles and the window flag
{
  const form = {
    v: 1, to: ["a@x.org"], cc: ["c@x.org"], bcc: ["Hidden <b@x.org>", "z@x.org"], subject: "S", html: "<p>Hi</p>",
    inReplyTo: "<m1@x.org>", references: ["<m0@x.org>", "<m1@x.org>"], replaces: null, isReply: true, encrypt: "off", sign: false, attachKey: false, confidential: false, win: true,
  };
  const l = { id: "r1", accountId: "a1", savedAt: 1, payload: JSON.stringify(form), files: [att("f")] };
  const init = composeFromSnapshot(l);
  assert.deepEqual(init.bcc, ["Hidden <b@x.org>", "z@x.org"], "Bcc survives the snapshot");
  assert.deepEqual(init.cc, ["c@x.org"]);
  assert.deepEqual(init.to, ["a@x.org"]);
  assert.equal(init.inReplyTo, "<m1@x.org>");
  assert.deepEqual(init.references, ["<m0@x.org>", "<m1@x.org>"]);
  assert.equal(init.recoveryId, "r1");
  assert.equal(init.attachments.length, 1);
  assert.equal(snapshotInWindow(l), true);
  assert.equal(snapshotInWindow({ ...l, payload: JSON.stringify({ ...form, win: undefined }) }), false);
  // recipients only: no subject, no body text
  const only = composeFromSnapshot({ ...l, payload: JSON.stringify({ v: 1, to: ["only@x.org"], cc: [], bcc: ["b@x.org"], subject: "", html: "" }) });
  assert.deepEqual([only.to, only.bcc, only.subject, only.bodyHtml], [["only@x.org"], ["b@x.org"], "", ""]);
  assert.equal(composeFromSnapshot({ ...l, payload: "not json" }), null);
  assert.equal(composeFromSnapshot({ ...l, payload: JSON.stringify({ to: [] }) }), null, "no html: unreadable");
}

console.log("recovery: ok");
