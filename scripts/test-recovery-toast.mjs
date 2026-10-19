// The toast that replaces the question "Restore your unsaved message?" (1.0.6): ONE sticky toast per start that says how many messages from the
// last session were kept and where (saved in Drafts / kept on this computer), with Continue writing, Show all and an X.
//  - it has no timer at all: still there after 60 s (and after 10 minutes), nothing in its source arms one;
//  - it goes only when the person answers it: X / Esc, Continue writing, Show all (or opening the messages another way);
//  - a language switch changes its text on screen (its text is a function), and a plural follows the count;
//  - the window hidden to the tray and shown again: the toast nobody answered is put back if anything took it off the screen;
//  - Continue writing opens the newest message like a draft of Drafts (pane or window by the setting and where it was written), also the
//    ones that are only on this computer (from the snapshot, with Cc and Bcc), and does not send or discard anything.
// Run: node --experimental-strip-types scripts/test-recovery-toast.mjs
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { createRecoveryToast, toastText, RECOVERY_TOAST_KEY } from "../src/recoveryToast.ts";
import { openKept } from "../src/recovery.ts";
import { setLangPref, t } from "../src/i18n/index.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const kept = (id, where, savedAt, o = {}) => ({ id, accountId: "a1", subject: `Subject ${id}`, savedAt, where, threadId: where === "drafts" ? `t-${id}` : null, inWindow: false, ...o });

/** A stand-in for the store's toast list: the toast is on the screen from setSticky(key, spec) until setSticky(key, null) or `take`. */
function screen() {
  const s = {
    spec: null,
    puts: 0,
    opened: [],
    drafts: [],
    picks: [],
    pickAnswer: [],
    openOk: true,
  };
  s.deps = {
    setSticky: (key, spec) => {
      assert.equal(key, RECOVERY_TOAST_KEY);
      s.spec = spec;
      if (spec) s.puts++;
    },
    isShown: () => s.spec !== null,
    open: async (k) => (s.opened.push(k.id), s.openOk),
    showDrafts: (acc) => void s.drafts.push(acc),
    pick: async (items) => (s.picks.push(items.map((i) => i.id)), items.filter((i) => s.pickAnswer.includes(i.id))),
  };
  /** the person presses the button with this label (the UI first removes the toast, then runs the action) */
  s.press = async (label) => {
    setLangPref("en");
    const a = s.spec.actions.find((x) => x.label() === label);
    assert.ok(a, `no button "${label}" among ${s.spec.actions.map((x) => x.label())}`);
    s.spec = null;
    a.run();
    await new Promise((r) => setImmediate(r));
  };
  /** the X, or Esc on a button */
  s.close = () => {
    const sp = s.spec;
    s.spec = null;
    sp.onDismiss();
  };
  return s;
}

// 1. the text: how many, and where (saved in Drafts / kept on this computer / both)
{
  setLangPref("en");
  assert.equal(toastText([kept("a", "drafts", 1)]), "Hey Look! kept 1 unsaved message from the last session.\nIt is saved in Drafts.");
  assert.equal(toastText([kept("a", "drafts", 1), kept("b", "drafts", 2)]), "Hey Look! kept 2 unsaved messages from the last session.\nThey are saved in Drafts.");
  assert.equal(toastText([kept("a", "local", 1)]), "Hey Look! kept 1 unsaved message from the last session.\nIt is kept on this computer.", "no Drafts folder: kept on this computer");
  assert.equal(toastText([kept("a", "local", 1), kept("b", "local", 2), kept("c", "local", 3)]), "Hey Look! kept 3 unsaved messages from the last session.\nThey are kept on this computer.");
  assert.equal(toastText([kept("a", "drafts", 1), kept("b", "local", 2), kept("c", "local", 3)]), "Hey Look! kept 3 unsaved messages from the last session.\nSaved in Drafts: 1. Kept on this computer: 2.");
}

// 2. one toast, the buttons: Continue writing always; Show all only for several; the label says Drafts only when everything is there
{
  const s = screen();
  const toast = createRecoveryToast(s.deps);
  toast.show([kept("a", "drafts", 5)]);
  assert.equal(s.puts, 1);
  assert.deepEqual(s.spec.actions.map((a) => a.label()), ["Continue writing"], "one message: no Show all");
  assert.deepEqual([s.spec.kind, s.spec.escCloses, s.spec.guide], ["info", true, true], "Esc closes it; no ttl is part of the spec");
  assert.ok(!("ttl" in s.spec), "no timer");
  toast.show([kept("a", "drafts", 5), kept("b", "drafts", 9)]);
  assert.equal(s.puts, 2, "a second show replaces the first in place (the store keeps one toast per key)");
  assert.deepEqual(s.spec.actions.map((a) => a.label()), ["Continue writing", "Show all in Drafts"]);
  toast.show([kept("a", "drafts", 5), kept("b", "local", 9)]);
  assert.deepEqual(s.spec.actions.map((a) => a.label()), ["Continue writing", "Show all"], "something is only on this computer: Show all lists them");
}

// 3. STICKY: no timer is armed, and the toast is still there after 60 s, 10 minutes, and after the window was hidden and shown again
{
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let armed = 0;
  const realSet = globalThis.setTimeout;
  const realInt = globalThis.setInterval;
  globalThis.setTimeout = (...a) => (armed++, realSet(...a));
  globalThis.setInterval = (...a) => (armed++, realInt(...a));
  try {
    const s = screen();
    const toast = createRecoveryToast(s.deps);
    toast.show([kept("a", "local", 5), kept("b", "drafts", 6)]);
    mock.timers.tick(60_000);
    assert.ok(s.spec, "still present after 60 s");
    assert.equal(toast.pending, true);
    mock.timers.tick(10 * 60_000);
    assert.ok(s.spec, "still present after 10 minutes");
    // hidden to the tray and shown again: nothing took it off the screen, nothing changes (no second toast)
    toast.reshow();
    assert.equal(s.puts, 1, "no duplicate");
    // something took it off the screen without an answer (a crowded stack, a reload of the list): it comes back
    s.spec = null;
    toast.reshow();
    assert.ok(s.spec, "put back after hide / show");
    assert.equal(s.puts, 2);
    mock.timers.tick(60_000);
    assert.ok(s.spec);
    assert.equal(armed, 0, "the toast arms no timer of its own");
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.setInterval = realInt;
    mock.timers.reset();
  }
  // the source says the same: no timer anywhere in the toast, its wiring or the sticky toast of the store
  for (const f of ["src/recoveryToast.ts", "src/composeRecovery.ts"]) {
    assert.ok(!/setTimeout|setInterval|stickyTimers|\bttl\b/.test(read(f)), `${f} arms a timer / sets a ttl`);
  }
  const store = read("src/store.ts");
  const sticky = store.slice(store.indexOf("setStickyToast: (key, spec) =>"), store.indexOf("beginSend: (flush)"));
  assert.ok(sticky.length > 100 && !/setTimeout/.test(sticky), "the store's sticky toasts have no timer");
  const ui = read("src/components/overlays.tsx");
  assert.ok(/t\.sticky && !t\.ttl \? " sticky"/.test(ui) && /\(!t\.sticky \|\| t\.ttl > 0\) && <span className="toast-bar"/.test(ui), "a sticky toast without ttl has no countdown bar");
}

// 4. answered by the person: the X / Esc, Continue writing and Show all take it away for good (reshow does not bring it back)
{
  const s = screen();
  const toast = createRecoveryToast(s.deps);
  toast.show([kept("a", "drafts", 5), kept("b", "drafts", 9)]);
  s.close();
  assert.equal(toast.pending, false);
  toast.reshow();
  assert.equal(s.spec, null, "closed with the X: it stays closed after the window is shown again");

  const c = screen();
  const t2 = createRecoveryToast(c.deps);
  t2.show([kept("a", "drafts", 5), kept("b", "drafts", 9, { accountId: "a1" })]);
  await c.press("Continue writing");
  assert.deepEqual(c.opened, ["b"], "the NEWEST message is opened");
  assert.equal(t2.pending, false);
  t2.reshow();
  assert.equal(c.spec, null);

  const d = screen();
  const t3 = createRecoveryToast(d.deps);
  t3.show([kept("a", "drafts", 5), kept("b", "drafts", 9)]);
  await d.press("Show all in Drafts");
  assert.deepEqual(d.drafts, ["a1"], "selects the Drafts folder of the account");
  assert.equal(t3.pending, false);
  const two = screen();
  const t4 = createRecoveryToast(two.deps);
  t4.show([kept("a", "drafts", 5), kept("b", "drafts", 9, { accountId: "a2" })]);
  await two.press("Show all in Drafts");
  assert.deepEqual(two.drafts, [null], "two accounts: all of them");
}

// 5. Continue writing that fails (the message could not be opened): the toast stays so that the person can try again
{
  const s = screen();
  s.openOk = false;
  const toast = createRecoveryToast(s.deps);
  toast.show([kept("a", "local", 5)]);
  await s.press("Continue writing");
  assert.ok(s.spec, "put back");
  assert.equal(toast.pending, true);
}

// 6. Show all with messages that are only on this computer: the list; what was opened leaves the toast, the rest stays until answered
{
  const s = screen();
  const toast = createRecoveryToast(s.deps);
  toast.show([kept("a", "local", 5), kept("b", "local", 9), kept("c", "drafts", 7)]);
  s.pickAnswer = ["a"];
  await s.press("Show all");
  assert.deepEqual(s.picks, [["a", "b", "c"]]);
  assert.ok(s.spec, "two are left: the toast is back");
  assert.equal(toastText(toast.items), "Hey Look! kept 2 unsaved messages from the last session.\nSaved in Drafts: 1. Kept on this computer: 1.");
  assert.equal(s.spec.text(), toastText(toast.items));
  // the list closed without opening anything: answered
  s.pickAnswer = [];
  await s.press("Show all");
  assert.equal(s.spec, null);
  assert.equal(toast.pending, false);
  // a message opened another way (its Compose is up) is struck off
  const o = screen();
  const t2 = createRecoveryToast(o.deps);
  t2.show([kept("a", "local", 5), kept("b", "local", 9)]);
  t2.opened("b");
  assert.equal(toastText(t2.items), "Hey Look! kept 1 unsaved message from the last session.\nIt is kept on this computer.");
  t2.opened("a");
  assert.equal(o.spec, null);
}

// 7. a language switch: the toast on the screen is written again in the new language (its texts are functions), also the buttons and the X
{
  const s = screen();
  const toast = createRecoveryToast(s.deps);
  toast.show([kept("a", "drafts", 5), kept("b", "drafts", 9)]);
  setLangPref("en");
  const spec = s.spec;
  assert.match(spec.text(), /^Hey Look! kept 2 unsaved messages/);
  assert.equal(spec.actions[0].label(), "Continue writing");
  const seen = new Map();
  for (const lang of ["de", "fr", "es", "ja", "ru", "vi", "zh-Hans", "en"]) {
    setLangPref(lang);
    const text = spec.text();
    assert.notEqual(text, "", lang);
    if (lang !== "en") assert.notEqual(text, toastText([]) , lang);
    seen.set(lang, [text, spec.actions[0].label(), spec.actions[1].label(), spec.closeLabel()]);
    assert.ok(!/compose\.recover|\{n\}|\{drafts\}|\{local\}/.test(seen.get(lang).join("|")), `${lang}: untranslated key or placeholder: ${seen.get(lang)}`);
  }
  assert.match(seen.get("de")[0], /Entwürfe/);
  assert.match(seen.get("de")[1], /Weiterschreiben/);
  assert.notEqual(seen.get("de")[0], seen.get("en")[0]);
  assert.match(seen.get("ja")[0], /2/);
  setLangPref("en");
  // plurals follow the count in a language with several forms (Russian one / few / many)
  setLangPref("ru");
  const n = (c) => t("compose.recover.toast.drafts", { n: c });
  assert.match(n(1), /1 несохранённое письмо/);
  assert.match(n(2), /2 несохранённых письма/);
  assert.match(n(5), /5 несохранённых писем/);
  setLangPref("en");
}

// 8. Continue writing: the way the message opens (pane or window by the setting and where it was written; a local one from its snapshot)
{
  const calls = [];
  const deps = (o = {}) => ({
    openDraft: async (tid, opts) => (calls.push(["draft", tid, opts]), true),
    loadSnapshot: async (id) => ("snapshot" in o ? o.snapshot : { id, accountId: "a1", savedAt: 5, payload: JSON.stringify({ v: 1, to: ["a@x.org"], cc: ["c@x.org"], bcc: ["Hidden <b@x.org>"], subject: "Plan", html: "<p>Hi there</p>", inReplyTo: null, references: [], replaces: null, isReply: false, encrypt: "off", sign: false, attachKey: false, confidential: false }), files: [] }),
    start: async (init, opts) => (calls.push(["start", init, opts]), true),
    popoutSetting: () => !!o.popout,
    notFound: () => calls.push(["notFound"]),
  });
  // saved in Drafts: opened like a draft of the Drafts folder; the setting decides (window undefined), a message written in a window opens in one
  assert.equal(await openKept(kept("a", "drafts", 1), deps()), true);
  assert.deepEqual(calls.pop(), ["draft", "t-a", { window: undefined, shift: false }]);
  await openKept(kept("a", "drafts", 1, { inWindow: true }), deps());
  assert.deepEqual(calls.pop(), ["draft", "t-a", { window: true, shift: false }], "written in a pop-out window: comes back in one");
  // only on this computer: Compose from the snapshot, with the text, the Cc and the Bcc; the snapshot keeps its id until the message is saved or sent
  await openKept(kept("b", "local", 1), deps());
  let [, init, opts] = calls.pop();
  assert.deepEqual([init.to, init.cc, init.bcc, init.subject, init.recoveryId], [["a@x.org"], ["c@x.org"], ["Hidden <b@x.org>"], "Plan", "b"]);
  assert.ok(init.bodyHtml.includes("Hi there"));
  assert.deepEqual(opts, { window: undefined, shift: false, key: undefined }, "the pane, no window key");
  // the pop-out setting is on: a window with a key of its own (two messages = two windows)
  await openKept(kept("b", "local", 1), deps({ popout: true }));
  [, , opts] = calls.pop();
  assert.deepEqual(opts, { window: undefined, shift: false, key: "recovery:b" });
  await openKept(kept("w", "local", 1, { inWindow: true }), deps());
  [, , opts] = calls.pop();
  assert.deepEqual(opts, { window: true, shift: false, key: "recovery:w" }, "written in a window: a window, whatever the setting");
  // a snapshot that is gone: the person is told and nothing opens
  assert.equal(await openKept(kept("c", "local", 1), deps({ snapshot: null })), false);
  assert.deepEqual(calls.pop(), ["notFound"]);
  // a draft whose conversation is unknown falls back to the snapshot
  await openKept(kept("d", "drafts", 1, { threadId: null }), deps());
  assert.equal(calls.pop()[0], "start");
  assert.equal(calls.length, 0);
}

// 9. wiring: the start settles first and tells afterwards (no question), the toast is re-shown when the window is shown, nothing of the old dialog is left
{
  const wiring = read("src/composeRecovery.ts");
  assert.ok(!/choose\(\{\s*\n?\s*title: t\("compose\.recover\.title/.test(wiring) && !/recover\.(restore|later|body|title)\b/.test(wiring), "the question is gone");
  assert.match(wiring, /settleRecovery\(\{/);
  assert.match(wiring, /toast\.show\(kept\)/);
  const app = read("src/App.tsx");
  assert.match(app, /void recoverUnsaved\(\)/);
  assert.match(app, /const shown = \(\) => \{\n\s*reshowRecoveryToast\(\)/, "the toast is put back when the window is shown (app-shown / focus)");
  for (const f of ["src/composeRecovery.ts", "src/App.tsx"]) assert.ok(!/offerRestore|offerRecovery/.test(read(f)), `${f}: the old question is still wired`);
  // nothing is sent, discarded or removed unasked by the start
  const dropLine = /drop: \(k\) => api\.recoveryClear\(k\.id, "toast dismissed, nothing but recipients"\)/;
  assert.ok(!/sendMessage|outboxHold|discardDraft|recoveryClear/.test(wiring.replace(/clear: \(id, why\) => api\.recoveryClear\(id, why\)/, "").replace(dropLine, "")), "the start only saves drafts");
  assert.match(wiring, dropLine, "a message with only recipients goes when the toast is dismissed (W13.5)");
}

// 10. W13.5 (REQ-13.5.6): a message with only recipients is kept on this computer (never a draft); closing the toast without opening it removes that snapshot, and
//     only that one: a message that could not be saved (offline) stays for the next start, and Continue writing keeps what it opens
{
  const s = screen();
  const dropped = [];
  s.deps.drop = async (k) => void dropped.push(k.id);
  const toast = createRecoveryToast(s.deps);
  toast.show([kept("rcpt", "local", 3, { draftless: true }), kept("offline", "local", 2), kept("saved", "drafts", 1)]);
  assert.equal(toastText(toast.items), "Hey Look! kept 3 unsaved messages from the last session.\nSaved in Drafts: 1. Kept on this computer: 2.");
  s.close();
  assert.deepEqual(dropped, ["rcpt"], "only the recipients-only snapshot is removed");
  assert.deepEqual(toast.items.map((i) => i.id), ["offline", "saved"]);
  assert.equal(toast.pending, false);
}
{
  const s = screen();
  const dropped = [];
  s.deps.drop = async (k) => void dropped.push(k.id);
  const toast = createRecoveryToast(s.deps);
  toast.show([kept("rcpt", "local", 3, { draftless: true })]);
  await s.press("Continue writing");
  assert.deepEqual(s.opened, ["rcpt"], "Continue writing opens it from the snapshot with its recipients");
  assert.deepEqual(dropped, [], "opened: it is not removed (it goes when the message is sent, saved or closed)");
  // no drop handler (an older wiring): dismissing is harmless
  const s2 = screen();
  const t2 = createRecoveryToast(s2.deps);
  t2.show([kept("rcpt", "local", 3, { draftless: true })]);
  assert.doesNotThrow(() => s2.close());
}

console.log("recovery-toast: all checks passed");
