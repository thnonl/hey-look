// Checks Reply / Reply all / Forward opening at once (1.0.7 W13.13, D-064): src/answerShell.ts (the order of the steps, the repeat press, Discard while it prepares, the failures and the safety end),
// src/popout/composeFill.ts (the hand-over to a window), src/composeShell.ts (the status minimum), and the source guards of the wiring. Run:
// node --experimental-strip-types scripts/test-answer-shell.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createAnswerShell } from "../src/answerShell.ts";
import { FILL_ID, FillHub } from "../src/popout/composeFill.ts";
import { SAFETY_MS, STATUS_AFTER_MS, STATUS_MIN_MS, shellDone, statusRemaining, statusShown } from "../src/composeShell.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** deps that log what happens; `pane` is the id of the shell in the pane (null: none) */
function rig(over = {}) {
  const log = [];
  const r = {
    log,
    pane: null,
    opened: 0,
    filled: [],
    filledIds: [],
    delivered: [],
    failed: [],
    busy: [],
    remaining: 0,
    deps: {
      open: async (init) => {
        log.push("open");
        r.opened++;
        r.last = init;
        r.pane = init.preparing.id;
        await tick(5);
        return { ok: true, where: "pane" };
      },
      paneHas: (id) => r.pane === id,
      fillPane: async (id, init) => {
        log.push("fill");
        r.filledIds.push(id);
        r.filled.push(init);
        r.pane = null;
      },
      fillWindow: (label, init) => r.delivered.push([label, init]),
      focusPrepared: async () => false,
      paint: async () => {
        log.push("paint");
      },
      wait: async (ms) => {
        log.push(`wait ${ms}`);
        await tick(1);
      },
      remaining: () => r.remaining,
      done: () => {},
      newId: (() => { let n = 0; return () => `id${++n}`; })(),
      fail: (e) => r.failed.push(String(e.message ?? e)),
      busy: (key, on) => r.busy.push(`${key}:${on}`),
      ...over,
    },
  };
  return r;
}
const job = (r, over = {}) => ({
  kind: "reply",
  key: "re:m1",
  o: {},
  shell: { accountId: "a1", subject: "Re: x", isReply: true },
  prepare: async (painted) => {
    r.log.push("prepare");
    await painted;
    r.log.push("prepared");
    return { quote: "<q>" };
  },
  build: (x) => ({ subject: "Re: x", bodyHtml: x.quote, to: ["a@b.c"] }),
  fallback: () => ({ subject: "Re: x", bodyHtml: "", to: [] }),
  ...over,
});

// ---- the steps start before the shell is open, side by side; heavy work waits for the paint
{
  const r = rig();
  const as = createAnswerShell(r.deps);
  await as.open(job(r));
  assert.deepEqual(r.log.slice(0, 2), ["prepare", "open"], "the slow steps start in the same moment as the shell, not after it");
  assert.ok(r.log.indexOf("paint") < r.log.indexOf("prepared"), "the work that needs the CPU waits until the shell was painted");
  assert.ok(r.log.indexOf("prepared") < r.log.indexOf("fill"));
  assert.equal(r.filled.length, 1);
  assert.equal(r.filled[0].afterShell, true, "the message that replaces the shell does not fade in again");
  assert.equal(r.filled[0].preparing, undefined, "and is not a shell");
  assert.equal(r.filledIds[0], r.last.preparing.id, "the message replaces the shell it was made for (fillPane gets the id of the shell: filled in place, WP13f-3)");
  assert.deepEqual(r.filled[0].to, ["a@b.c"]);
  // the shell: what is known, flagged
  assert.deepEqual(r.last.preparing.kind, "reply");
  assert.equal(r.last.preparing.key, "re:m1");
  assert.equal(typeof r.last.preparing.at, "number", "the press time: the status is counted from it");
  assert.equal(r.last.subject, "Re: x");
  assert.deepEqual(r.busy, ["re:m1:true", "re:m1:false", "re:m1:false"].slice(0, r.busy.length), "the button is busy from the press until the shell is open");
  assert.equal(r.busy[0], "re:m1:true");
  assert.equal(as.preparing("re:m1"), false, "nothing is left behind");
}

// ---- a forward whose attachments are fetched says so in the shell
{
  const r = rig();
  await createAnswerShell(r.deps).open(job(r, { kind: "forward", key: "fw:m1", fetching: true }));
  assert.equal(r.last.preparing.fetching, true);
  const r2 = rig();
  await createAnswerShell(r2.deps).open(job(r2, { kind: "forward", key: "fw:m1" }));
  assert.equal(r2.last.preparing.fetching, undefined);
}

// ---- the status stays for its minimum (300 ms once shown) before the message replaces the shell
{
  const r = rig();
  r.remaining = 250;
  await createAnswerShell(r.deps).open(job(r));
  assert.ok(r.log.includes("wait 250"), "the fill waits for the rest of the status minimum");
  assert.ok(r.log.indexOf("wait 250") < r.log.indexOf("fill"));
  assert.equal(r.filled.length, 1);
}

// ---- Discard / another message while it prepares: the result is dropped, nothing is told
{
  const r = rig();
  const as = createAnswerShell(r.deps);
  let release;
  const slow = job(r, { prepare: async (painted) => { await painted; await new Promise((x) => (release = x)); return { quote: "<q>" }; } });
  const p = as.open(slow);
  await tick(30);
  r.pane = null; // the person discarded the shell
  release();
  await p;
  assert.equal(r.filled.length, 0, "a discarded shell is not filled again");
  assert.deepEqual(r.failed, [], "and says nothing");
  assert.equal(as.preparing("re:m1"), false);
  // replaced by another message's shell: the same
  const r2 = rig();
  const as2 = createAnswerShell(r2.deps);
  let release2;
  const p2 = as2.open(job(r2, { prepare: async (painted) => { await painted; await new Promise((x) => (release2 = x)); return { quote: "<q>" }; } }));
  await tick(30);
  r2.pane = "someone-else";
  release2();
  await p2;
  assert.equal(r2.filled.length, 0);
  // discarded while the status minimum is waited for
  const r3 = rig();
  r3.remaining = 40;
  r3.deps.wait = async (ms) => { if (ms === 40) r3.pane = null; await tick(1); };
  await createAnswerShell(r3.deps).open(job(r3));
  assert.equal(r3.filled.length, 0, "discard during the minimum");
}

// ---- the same answer again: the shell comes forward, nothing new starts
{
  const r = rig();
  const as = createAnswerShell(r.deps);
  let release;
  let prepared = 0;
  const j = () => job(r, { prepare: async (painted) => { prepared++; await painted; await new Promise((x) => (release = x)); return { quote: "<q>" }; } });
  const first = as.open(j());
  await tick(30);
  assert.equal(as.preparing("re:m1"), true);
  let focused = 0;
  r.deps.focusPrepared = async () => (focused++, true);
  await as.open(j());
  assert.equal(focused, 1, "the second press brings the first shell forward");
  assert.equal(prepared, 1, "and starts nothing");
  assert.equal(r.opened, 1, "no second shell");
  release();
  await first;
  assert.equal(r.filled.length, 1);
  // another answer (Reply all of the same message) is its own preparation
  const r2 = rig();
  const as2 = createAnswerShell(r2.deps);
  await Promise.all([as2.open(job(r2)), as2.open(job(r2, { key: "ra:m1" }))]);
  assert.equal(r2.opened, 2);
  // the window of the earlier press is gone (focus finds none): a new preparation starts
  const r3 = rig();
  const as3 = createAnswerShell(r3.deps);
  let release3;
  const p3 = as3.open(job(r3, { prepare: async () => { await new Promise((x) => (release3 = x)); return { quote: "<q>" }; } }));
  await tick(20);
  await as3.open(job(r3)); // focusPrepared says false
  assert.equal(r3.opened, 2, "nothing there to bring forward: the press is a new one");
  release3();
  await p3;
}

// ---- a step that fails: today's fallback (to From, no quote), told once; a build that throws too
{
  const r = rig();
  await createAnswerShell(r.deps).open(job(r, { prepare: async () => { throw new Error("boom"); } }));
  assert.equal(r.filled.length, 1);
  assert.equal(r.filled[0].bodyHtml, "", "no quote");
  assert.deepEqual(r.filled[0].to, []);
  assert.deepEqual(r.failed, ["boom"]);
  const r2 = rig();
  await createAnswerShell(r2.deps).open(job(r2, { build: () => { throw new Error("bad quote"); } }));
  assert.equal(r2.filled[0].bodyHtml, "");
  assert.deepEqual(r2.failed, ["bad quote"]);
}

// ---- the safety end: a step that never ends does not keep the status on screen
{
  const r = rig();
  const t0 = Date.now();
  await createAnswerShell(r.deps, 60).open(job(r, { prepare: () => new Promise(() => {}) }));
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.filled.length, 1, "filled with what is there");
  assert.deepEqual(r.failed, ["timeout"]);
  assert.equal(SAFETY_MS, 15000, "5 s headers + 8 s pictures + 2 s");
}

// ---- nothing opened (no mailbox, the person kept writing another message): no fill, no work left, the button is free
{
  const r = rig({ open: async () => ({ ok: false }) });
  await createAnswerShell(r.deps).open(job(r));
  assert.equal(r.filled.length, 0);
  assert.equal(r.busy.at(-1), "re:m1:false");
}

// ---- a window: the message is handed to it; a window that was only brought forward gets nothing
{
  const r = rig({ open: async () => ({ ok: true, where: "window", label: "compose-7", fresh: true }) });
  await createAnswerShell(r.deps).open(job(r));
  assert.equal(r.filled.length, 0, "not in the pane");
  assert.equal(r.delivered.length, 1);
  assert.equal(r.delivered[0][0], "compose-7");
  assert.equal(r.delivered[0][1].afterShell, true);
  const r2 = rig({ open: async () => ({ ok: true, where: "window", label: "compose-7", fresh: false }) });
  await createAnswerShell(r2.deps).open(job(r2));
  assert.equal(r2.delivered.length, 0, "the window of this answer was there: it has its own preparation");
}

// ---- after(): what could not come along is told once the message is filled in, not before and not when the result was dropped
{
  const r = rig();
  const told = [];
  await createAnswerShell(r.deps).open(job(r, { after: (x) => told.push([x.quote, r.filled.length]) }));
  assert.deepEqual(told, [["<q>", 1]]);
}

// ---- a Reply / Reply all carries the recipients it is expected to have into the shell (REQ-13.13.12: the Cc rows, and the room a wrapping row needs); a Forward carries none
{
  const r = rig();
  const rcpt = { to: ["a@x.test", "b@x.test"], cc: ["c@x.test"] };
  await createAnswerShell(r.deps).open(job(r, { rcpt }));
  assert.deepEqual(r.last.preparing.rcpt, rcpt, "the shell knows who the answer is expected to go to");
  const r2 = rig();
  await createAnswerShell(r2.deps).open(job(r2));
  assert.equal(r2.last.preparing.rcpt, undefined, "a Forward has no such list");
}

// ---- the hand-over to a window waits for both sides, in either order, and sends once
{
  const sent = [];
  const hub = new FillHub((label, v) => sent.push([label, v]));
  hub.deliver("compose-1", { n: 1 });
  assert.equal(sent.length, 0, "the window is not listening yet");
  hub.listening("compose-1");
  assert.deepEqual(sent, [["compose-1", { n: 1 }]]);
  hub.listening("compose-1"); // the window asks again every second until it has the message
  assert.equal(sent.length, 1, "nothing is sent twice");
  hub.listening("compose-2");
  hub.deliver("compose-2", { n: 2 });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], ["compose-2", { n: 2 }]);
  hub.deliver("compose-3", { n: 3 });
  assert.equal(hub.size, 2, "compose-3 waits; compose-1 and compose-2 left a listening mark after the repeated asks");
  assert.equal(FILL_ID, "shell-fill");
}

// ---- the status minimum
{
  assert.equal(STATUS_MIN_MS, 300);
  assert.ok(STATUS_AFTER_MS <= 150 - 10, "painted by 150 ms");
  assert.equal(statusRemaining("none"), 0, "a status never shown has no minimum");
  statusShown("s1", 1000);
  assert.equal(statusRemaining("s1", 1100), 200);
  assert.equal(statusRemaining("s1", 1400), 0);
  statusShown("s1", 1200); // (drawn again: the first time counts)
  assert.equal(statusRemaining("s1", 1250), 50);
  shellDone("s1");
  assert.equal(statusRemaining("s1", 1250), 0);
}

// ---- source guards of the wiring
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
{
  const actions = read("src/actions.ts");
  assert.ok(!/await\s+headersOf\(/.test(actions), "no await of headersOf before the shell: the headers are one of the side by side steps");
  assert.equal((actions.match(/Promise\.all\(\[headersOf\(/g) ?? []).length, 2, "Reply and Forward start the headers together with the pictures / attachments and the quote module");
  assert.ok(!/await\s+quoteBlockOf\(/.test(actions) && !/await\s+forwardFiles\(/.test(actions.replace(/hasFiles \? forwardFiles/g, "")), "nothing awaits a slow step on its own");
  assert.ok(!/setTimeout\(\(\) => st\.showToast\(t\("compose\.fwd\.fetching"\)/.test(actions), "the 700 ms toast of Forward is gone: the status says it");
  assert.ok(/answers\.open\(\{\s*kind: "reply"/.test(actions) && /answers\.open\(\{\s*kind: "forward"/.test(actions), "Reply and Forward go through the shell");
  assert.ok(!/startCompose\(\{[\s\S]{0,200}isReply/.test(actions), "Reply no longer starts the compose with the finished message");
  const compose = read("src/components/Compose.tsx");
  assert.ok(/compose\.preparing\.forward/.test(compose) && /compose\.preparing\.reply/.test(compose) && /compose\.fwd\.fetching/.test(compose));
  assert.ok(/function PreparingStatus[\s\S]*role="status" aria-busy="true"/.test(compose) && compose.includes("<PreparingStatus p={preparing} />"), "the status is a status, in a component of its own (its timer must not re-render the whole composer)");
  // the finished message replaces the shell IN PLACE (WP13f-3, DEC-023): the store action does not bump the key, the pane uses it, the window keeps the editor number
  assert.ok(/fillCompose: \(id, full\) => \{[^}]*set\(\{ compose: full \}\)/.test(read("src/store.ts")), "fillCompose replaces the compose and nothing else (no composeKey bump)");
  assert.ok(/fillPane: async \(id, init\) => void useStore\.getState\(\)\.fillCompose\(id, init\)/.test(actions), "the pane fill goes through fillCompose");
  assert.ok(/const fillWith = async[\s\S]*?\{ init: full, n: prev\.n \}/.test(read("src/popout/ComposeView.tsx")), "the compose window keeps its editor number at the fill");
  const view = read("src/popout/ComposeView.tsx");
  assert.ok(view.includes("FILL_ID") && view.includes('notifyMain("fill-ready")'), "the compose window asks for its message");
  assert.ok(read("src/popout/composeHub.ts").includes("fills.listening("), "the main window answers");
  const app = read("src/App.tsx");
  assert.ok(!/composeShell|answerShell|composeFill/.test(app), "App.tsx imports nothing of the shell: the editor stack stays where WP9d can load it later");
}

console.log("test-answer-shell: ok");
