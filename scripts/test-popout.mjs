// Secondary windows ("pop-outs"), the foundation (src/popout/*, src/main.tsx): which window a page is in, the title, the dev flag, the
// rule "the setting says what a click does, Shift does the opposite", and guards on how the pieces are wired. The window manager itself is
// tested in Rust (src-tauri/src/popout.rs); the quit protocol in scripts/test-quit-flush.mjs.
// Run: node --experimental-strip-types scripts/test-popout.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { isPopout, popoutDevEnabled, popoutTitle, routeOf } from "../src/popout/route.ts";
import { answerKey, draftKey, opensInWindow, outboxKey, shiftOnly } from "../src/popout/entry.ts";
import { MODIFIER_WINDOW_MS, noteInput, resetModifier, shiftNow } from "../src/popout/modifier.ts";
import { closeAction, composeFlush, GRACE_MS, runClose, secondsLeft, START, step, UNDO_SETTLE_MS } from "../src/popout/composeWindow.ts";
import { carryToasts, parseComposeRequest } from "../src/popout/composeRequests.ts";
import {
  allowedWhenGone, isFlagged, isGone, isUnread, markReadPlan, neighborOf, neighborsOf, readerAllowed, readerInit, readerKey, readerTitleText, scopeOfView, threadScope, withWanted,
} from "../src/popout/readerLogic.ts";
import { Coalescer, OPEN_COALESCE_MS, openId } from "../src/popout/coalesce.ts";
import { rowWindowTarget } from "../src/popout/readerLogic.ts";
import { Requester, UNREACHABLE } from "../src/popout/request.ts";
import { parseRequest, READER_ACTIONS, READER_LABELS } from "../src/popout/requestKinds.ts";
import { DATA_CHANGING, eventKey, prefsPatchAllowed, refocusOf, searchInit, searchKey, SETTINGS_KEY, settingsTarget } from "../src/popout/windowKinds.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---- the router: the main window has no query; a pop-out is ?w=<kind>&t=<token>; anything else mounts nothing
assert.deepEqual(routeOf(""), { kind: "main" });
assert.deepEqual(routeOf("?"), { kind: "main" });
assert.deepEqual(routeOf("?w=main"), { kind: "main" });
assert.deepEqual(routeOf("?w="), { kind: "main" });
assert.deepEqual(routeOf("?mock=1"), { kind: "main" }, "other parameters (the dev preview) do not matter");
assert.deepEqual(routeOf("?w=compose&t=abc123"), { kind: "compose", token: "abc123" });
assert.deepEqual(routeOf("?w=reader&t=zz"), { kind: "reader", token: "zz" });
assert.deepEqual(routeOf("?t=zz&w=reader"), { kind: "reader", token: "zz" }, "the order does not matter");
assert.deepEqual(routeOf("?w=compose"), { kind: "compose", token: "" }, "a missing token is the backend's to refuse (popout_init)");
assert.deepEqual(routeOf("w=compose&t=x"), { kind: "compose", token: "x" }, "also without the question mark");
// an unknown kind never mounts the app a second time
for (const bad of ["Settings", "Event", "search-1", "calendar", "Compose", "compose-1", "main2", "../x", "reader%20"]) {
  const r = routeOf(`?w=${bad}`);
  assert.equal(r.kind, "invalid", bad);
  assert.equal(isPopout(r), false);
}
assert.equal(isPopout(routeOf("?w=compose&t=1")), true);
assert.equal(isPopout(routeOf("?w=reader&t=1")), true);
// W4.6: the four kinds of window that come with the event, Settings, search and Scheduled windows
for (const k of ["event", "settings", "search", "scheduled"]) {
  assert.deepEqual(routeOf(`?w=${k}&t=abc`), { kind: k, token: "abc" }, k);
  assert.equal(isPopout(routeOf(`?w=${k}&t=1`)), true, k);
}
assert.equal(isPopout(routeOf("")), false);

// ---- the title (REQ-W7)
assert.equal(popoutTitle("Q4 contract call"), "Q4 contract call – Hey Look!");
assert.equal(popoutTitle("  padded  "), "padded – Hey Look!");
assert.equal(popoutTitle(""), "Hey Look!");
assert.equal(popoutTitle("   "), "Hey Look!");

// ---- the dev flag: a dev build, or the stored flag; nothing else
assert.equal(popoutDevEnabled(true, null), true);
assert.equal(popoutDevEnabled(false, "1"), true);
assert.equal(popoutDevEnabled(false, null), false);
assert.equal(popoutDevEnabled(false, "0"), false);
assert.equal(popoutDevEnabled(false, "true"), false);

// ---- the entry rule (REQ-C1, C2): the setting XOR Shift
assert.equal(opensInWindow(false, false), false, "setting off, plain click: inline");
assert.equal(opensInWindow(false, true), true, "setting off, Shift: a window");
assert.equal(opensInWindow(true, false), true, "setting on, plain click: a window");
assert.equal(opensInWindow(true, true), false, "setting on, Shift: inline (the opposite)");
const ev = (o) => ({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
assert.equal(shiftOnly(ev({ shiftKey: true })), true);
assert.equal(shiftOnly(ev({})), false);
assert.equal(shiftOnly(ev({ shiftKey: true, ctrlKey: true })), false, "Ctrl+Shift is another shortcut");
assert.equal(shiftOnly(ev({ shiftKey: true, metaKey: true })), false);
assert.equal(shiftOnly(ev({ shiftKey: true, altKey: true })), false);

// ---- the setting: stored, default off, and only the entry code reads it. (prefs.ts cannot be imported by node: read its text)
{
  const prefs = read("src/prefs.ts");
  assert.ok(/popoutCompose: boolean;/.test(prefs), "the field");
  assert.ok(prefs.includes("export const DEFAULT_PREFS: Prefs = {") && /closeToTray: true,\n  popoutCompose: false,/.test(prefs), "default off");
  assert.ok(prefs.includes("...DEFAULT_PREFS,\n      ...p,"), "an older prefs blob without the field gets the default");
}
{
  const users = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && read(p).includes("popoutCompose")) users.push(p);
    }
  };
  walk("src");
  // the definition, the toggle, the comments of the entry rule, the one place that applies it (startCompose / wantsWindow) and the restore after a crash
  assert.deepEqual(users.sort(), ["src/components/SettingsDialog.tsx", "src/composeRecovery.ts", "src/popout/composeOpen.ts", "src/popout/entry.ts", "src/prefs.ts"], `who mentions it: ${users}`);
}
{
  const dlg = read("src/components/SettingsDialog.tsx");
  const panel = dlg.slice(dlg.indexOf("function ComposingPanel"), dlg.indexOf("function ScopedList"));
  assert.ok(panel.includes('t("settings.composing.popout")') && panel.includes('t("settings.composing.popoutHint")'), "the toggle is in Settings > Composing");
  assert.ok(panel.includes("setPrefs({ popoutCompose: v })") && panel.includes("scope === null"), "one switch for the whole app, not per mailbox");
}

// ---- the wiring
{
  const main = read("src/main.tsx");
  assert.ok(main.includes("routeOf(window.location.search)"), "the entry asks the router");
  assert.ok(main.includes('route.kind === "main" ? <App /> : <PopoutRoot route={route} />'), "a pop-out never mounts the app");
  assert.ok(main.indexOf("applySavedLanguage(api.getSetting)") < main.indexOf("ReactDOM.createRoot("), "the language is applied before the first render in every window");
  const root = read("src/popout/PopoutRoot.tsx");
  // REQ-W12 / R-3 / R-4: a pop-out handles no quit, tray, toast, update or support event and never writes the preferences
  for (const never of ['listen("flush-sends"', "confirm-quit", "tray-compose", "open-thread", "notify-reply", "app-shown", "setSetting", "setPrefs", "frontendReady", "pageState", ".init()"]) {
    assert.ok(!root.includes(never), `PopoutRoot must not use ${never}`);
  }
  assert.ok(root.includes('listen<{ writer?: string }>("prefs-changed"'), "it follows the preferences of the main page");
  // no code of the pop-out writes the preferences blob (the main page is the only writer)
  for (const f of ["route.ts", "entry.ts", "flush.ts", "open.ts", "dev.ts", "views.tsx", "PopoutRoot.tsx", "ReaderView.tsx", "readerBridge.ts", "readerLogic.ts", "request.ts", "requestKinds.ts", "openReader.ts"]) {
    const src = read(`src/popout/${f}`);
    assert.ok(!/setSetting\(\s*["']prefs["']/.test(src) && !src.includes("useStore.getState().setPrefs"), `${f} writes the preferences`);
  }
  // the views are the place WP6b / WP6c plug in
  const views = read("src/popout/views.tsx");
  assert.ok(/export const VIEWS: Record<PopoutKind,/.test(views) && /compose: lazyView\(\{[^\n]*loadComposeWindowView/.test(views) && /reader: lazyView\(\{[^\n]*loadReaderWindowView/.test(views), "the views of the windows are chunks of their own (WP9d)");
  // the backend commands this page uses exist
  const api = read("src/api.ts");
  for (const c of ["popout_open", "popout_init", "popout_ready", "popout_focus", "popout_close", "popout_save_all", "popout_flush_alive", "popout_flush_dialog", "popout_flush_done"]) {
    assert.ok(api.includes(`"${c}"`), c);
  }
  // the update restart asks the secondary windows first
  const upd = read("src/updates.ts");
  assert.ok(upd.indexOf("api.popoutSaveAll()") > 0 && upd.indexOf("api.popoutSaveAll()") < upd.indexOf("if (st.compose) {"), "the windows save before the inline Compose");
}

// ================================================================ the reader window (WP6c)

// ---- the hand-off data: defensive, and no personal data is needed in the address
assert.equal(readerInit(null), null);
assert.equal(readerInit("x"), null);
assert.equal(readerInit({}), null, "no conversation id: the window shows the failure state");
assert.deepEqual(readerInit({ threadId: "t1", accountId: "a1", folder: "inbox", view: "starred", subject: "Hi" }), { threadId: "t1", accountId: "a1", folder: "inbox", view: "starred", subject: "Hi", listAccount: null });
assert.equal(readerInit({ threadId: "t1", listAccount: "a2" }).listAccount, "a2", "the mailbox selection of the main window when the window was opened (W4.4)");
assert.equal(readerInit({ threadId: "t1", folder: "archive" }).view, "archive", "no view given: the folder");
assert.equal(readerInit({ threadId: 5 }), null);

// ---- scopes: the same rule as the main window (store.ts scopeOf) and the one get_thread needs
for (const v of ["inbox", "sent", "archive", "trash", "junk", "f:Work"]) assert.equal(scopeOfView(v), v);
for (const v of ["starred", "pinned", "snoozed", "all", "scheduled"]) assert.equal(scopeOfView(v), undefined, v);
assert.equal(scopeOfView("unread"), "inbox");
assert.equal(threadScope("trash"), "trash");
assert.equal(threadScope("junk"), "junk");
assert.equal(threadScope("inbox"), undefined, "trash and junk mail is not part of a conversation read from the inbox");
assert.ok(read("src/store.ts").includes('const VIRTUAL = new Set(["starred", "pinned", "snoozed", "all", "scheduled"])'), "the virtual views are still the ones readerLogic.ts lists");

// ---- REQ-R9: moved or deleted elsewhere
assert.equal(isGone([], "inbox"), true, "nothing left: deleted, in Trash / Junk, or the mailbox was removed");
assert.equal(isGone([{ folder: "inbox" }, { folder: "sent" }], "inbox"), false);
assert.equal(isGone([{ folder: "archive" }, { folder: "sent" }], "inbox"), true, "archived: none left in the folder it was opened from");
assert.equal(isGone([{ folder: "archive" }], "starred"), false, "opened from a cross-folder view: only an empty conversation is gone");
assert.equal(isGone([{ folder: "archive" }], ""), false);
assert.equal(isGone([{ folder: "trash" }], "trash"), false, "opened from Trash and still there");
for (const a of ["close", "reply", "replyAll", "forward"]) assert.equal(allowedWhenGone(a), true, a);
for (const a of ["archive", "trash", "junk", "unread", "pin", "flag", "snooze", "print"]) assert.equal(allowedWhenGone(a), false, a);

// ---- draft rows and the Scheduled list do not open a reader
assert.equal(readerAllowed("inbox", "inbox"), true);
assert.equal(readerAllowed("starred", "inbox"), true);
assert.equal(readerAllowed("drafts", "drafts"), false);
assert.equal(readerAllowed("all", "drafts"), false, "a draft found in a cross-folder view is still a draft");
assert.equal(readerAllowed("scheduled", "outbox"), false);

// ---- REQ-R13: the keys
{
  const k = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  const ctx = (o = {}) => ({ mac: false, inField: false, modalOpen: false, ...o });
  const table = { r: "reply", a: "replyAll", f: "forward", e: "archive", "#": "trash", Delete: "trash", "!": "junk", u: "unread", p: "pin", "*": "flag", s: "snooze", Escape: "close" };
  for (const [key, want] of Object.entries(table)) assert.equal(readerKey(k(key), ctx()), want, key);
  assert.equal(readerKey(k("Backspace"), ctx()), null, "Backspace deletes on macOS only");
  assert.equal(readerKey(k("Backspace"), ctx({ mac: true })), "trash");
  assert.equal(readerKey(k("w", { ctrlKey: true }), ctx()), "close");
  assert.equal(readerKey(k("w", { metaKey: true }), ctx({ mac: true })), "close");
  assert.equal(readerKey(k("p", { ctrlKey: true }), ctx()), "print");
  assert.equal(readerKey(k("p", { metaKey: true }), ctx({ mac: true })), null, "Cmd+P is the File > Print… item of the menu bar on macOS (W5.11): the page takes no second one");
  assert.equal(readerKey(k("p", { ctrlKey: true }), ctx({ mac: true })), null, "Ctrl+P does not print on macOS");
  assert.equal(readerKey(k("p", { ctrlKey: true, shiftKey: true }), ctx()), null);
  // not while typing, not behind a dialog (Esc closes the dialog first), no other modifier combination
  for (const key of Object.keys(table)) {
    assert.equal(readerKey(k(key), ctx({ inField: true })), null, `${key} in a field`);
    assert.equal(readerKey(k(key), ctx({ modalOpen: true })), null, `${key} behind a dialog`);
  }
  assert.equal(readerKey(k("w", { ctrlKey: true }), ctx({ inField: true })), null);
  assert.equal(readerKey(k("r", { ctrlKey: true }), ctx()), null, "Ctrl+R is not Reply");
  assert.equal(readerKey(k("e", { altKey: true }), ctx()), null);
  assert.equal(readerKey(k("x"), ctx()), null);
}

// ---- REQ-R8: the rule of the reading pane (Mark as read delay: 0 now, n seconds, -1 never)
assert.deepEqual(markReadPlan([{ seen: true }], 0), { kind: "none" }, "nothing unread");
assert.deepEqual(markReadPlan([{ seen: true }, { seen: false }], 0), { kind: "now" });
assert.deepEqual(markReadPlan([{ seen: false }], 2), { kind: "after", ms: 2000 });
assert.deepEqual(markReadPlan([{ seen: false }], -1), { kind: "none" }, "Never leaves it unread");
assert.deepEqual(markReadPlan([], 0), { kind: "none" });

// ---- REQ-R7: the state asked for is shown at once (the rules of store.ts applyOptimistic)
{
  const m = (id, seen, flagged) => ({ id, seen, flagged });
  const base = [m("a", true, false), m("b", true, false)];
  assert.equal(withWanted(base, {}), base, "nothing asked: the very same list");
  assert.deepEqual(withWanted(base, { unread: true }).map((x) => x.seen), [true, false], "unread: the newest message");
  assert.deepEqual(withWanted([m("a", false, false), m("b", false, false)], { unread: false }).map((x) => x.seen), [true, true], "read: all");
  assert.deepEqual(withWanted(base, { flagged: true }).map((x) => x.flagged), [true, true]);
  assert.deepEqual(withWanted([m("a", true, true), m("b", true, false)], { flagged: false }).map((x) => x.flagged), [false, false]);
  assert.equal(isFlagged([m("a", true, false), m("b", true, true)]), true);
  assert.equal(isFlagged(base), false);
  assert.equal(isUnread([m("a", true, false), m("b", false, false)]), true);
  assert.equal(isUnread(base), false);
}

// ---- the title (REQ-W7)
assert.equal(readerTitleText("Q4 call", "(no subject)"), "Q4 call");
assert.equal(readerTitleText("  ", "(no subject)"), "(no subject)");
assert.equal(popoutTitle(readerTitleText("", "(no subject)")), "(no subject) – Hey Look!");

// ---- requests to the main page (REQ-S4): ids, answers, the 5 s timeout, a late answer, a refusal of the backend
{
  const sent = [];
  const timers = [];
  let cleared = 0;
  const r = new Requester({
    send: async (id, kind, payload) => {
      sent.push({ id, kind, payload });
      if (kind === "refused") throw new Error("this is not a secondary window");
    },
    setTimer: (f, ms) => (timers.push({ f, ms }), timers.length),
    clearTimer: () => void cleared++,
  });
  const a = r.ask("thread-action", { x: 1 });
  const b = r.ask("prefs", { mailCanvas: "dark" }, 60000);
  assert.deepEqual(sent.map((x) => x.id), ["r1", "r2"], "every request has its own id");
  assert.deepEqual(timers.map((t) => t.ms), [5000, 60000], "5 s unless the caller asks for more (a state change waits for the server)");
  assert.equal(r.pending, 2);
  r.answer({ id: "r2", ok: true, data: "two" });
  assert.equal(await b, "two");
  r.answer({ id: "r1", ok: false, error: "Archive folder missing" });
  await assert.rejects(a, /Archive folder missing/);
  assert.equal(r.pending, 0);
  assert.equal(cleared, 2, "the timers are cleared");
  r.answer({ id: "r1", ok: true }); // an answer nobody waits for: nothing happens
  // no answer in time
  const c = r.ask("compose", {});
  timers[timers.length - 1].f();
  await assert.rejects(c, new RegExp(UNREACHABLE));
  assert.equal(r.pending, 0);
  r.answer({ id: "r3", ok: true }); // late
  // the backend refuses the request
  await assert.rejects(r.ask("refused", {}), /not a secondary window/);
  assert.equal(r.pending, 0);
}

// ---- what the main page accepts (REQ-S2/S4): checked and cut to size
{
  const bad = (kind, payload) => assert.ok("error" in parseRequest(kind, payload), `${kind} ${JSON.stringify(payload)} must be refused`);
  const ok = (kind, payload) => {
    const p = parseRequest(kind, payload);
    assert.ok(!("error" in p), `${kind}: ${JSON.stringify(p)}`);
    return p;
  };
  // thread actions: the buttons of the toolbar, nothing else
  for (const a of ["read", "unread", "star", "unstar", "pin", "unpin", "archive", "trash", "junk", "block", "snooze", "unsnooze"]) assert.ok(READER_ACTIONS.has(a), a);
  for (const a of ["delete_forever", "move", "inbox", "sender_action", "", "ARCHIVE"]) assert.equal(READER_ACTIONS.has(a), false, a);
  assert.deepEqual(ok("thread-action", { threadId: "t1", action: "archive", labelKey: "reading.head.archived", view: "inbox" }).req, { threadId: "t1", action: "archive", arg: undefined, labelKey: "reading.head.archived", labelParams: undefined, view: "inbox" });
  // the toast text is a key the main window writes in the language in use (WP1's rule for toasts with Undo), never a finished string
  for (const k of READER_LABELS) assert.ok(/^reading.head./.test(k), k);
  bad("thread-action", { threadId: "t1", action: "archive", labelKey: "app.quit.keepWriting" });
  bad("thread-action", { threadId: "t1", action: "archive", labelKey: "Archived" });
  assert.deepEqual(ok("thread-action", { threadId: "t1", action: "block", labelKey: "reading.head.blocked", labelParams: { email: "x@y.z", n: 5 } }).req.labelParams, { email: "x@y.z" }, "only text values travel");
  bad("thread-action", { threadId: "t1", action: "delete_forever" });
  bad("thread-action", { action: "archive" });
  bad("thread-action", { threadId: "t1" });
  bad("thread-action", null);
  bad("thread-action", { threadId: "t1", action: "snooze" });
  bad("thread-action", { threadId: "t1", action: "snooze", arg: "tomorrow" });
  assert.equal(ok("thread-action", { threadId: "t1", action: "snooze", arg: "1760000000" }).req.arg, "1760000000");
  assert.equal(ok("thread-action", { threadId: "t1", action: "snooze", arg: "1760000000", labelKey: "reading.head.snoozed", labelParams: { label: "x".repeat(1000) } }).req.labelParams.label.length, 200, "a value is cut");
  // preferences: the mail background and nothing else
  assert.deepEqual(ok("prefs", { mailCanvas: "dark" }).patch, { mailCanvas: "dark" });
  assert.deepEqual(ok("prefs", { mailCanvas: "original" }).patch, { mailCanvas: "original" });
  bad("prefs", { mailCanvas: "blue" });
  bad("prefs", { mailCanvas: "dark", theme: "dark" });
  bad("prefs", { theme: "dark" });
  bad("prefs", { downloadDir: "C:\\" });
  bad("prefs", {});
  // the light theme's session mail background (WP13g): set, take off, or just ask; never a preference
  assert.deepEqual(ok("canvas-session", { dark: true }), { kind: "canvas-session", dark: true });
  assert.deepEqual(ok("canvas-session", { dark: false }), { kind: "canvas-session", dark: false });
  assert.deepEqual(ok("canvas-session", {}), { kind: "canvas-session", dark: null });
  assert.deepEqual(ok("canvas-session", { dark: "yes" }), { kind: "canvas-session", dark: null }, "anything but a boolean is only a question");
  assert.deepEqual(ok("canvas-session", null), { kind: "canvas-session", dark: null });
  // answers
  const msg = { id: "m1", subject: "Hi" };
  assert.equal(ok("compose", { mode: "replyAll", message: msg, threadMessageIds: ["<a@b>", null, 5] }).req.threadMessageIds.length, 2, "only Message-IDs travel");
  bad("compose", { mode: "send", message: msg });
  bad("compose", { mode: "reply" });
  bad("compose", { mode: "reply", message: {} });
  assert.equal(ok("compose-new", { init: { accountId: "a1", subject: "unsubscribe", to: ["x@y.z"], attachments: [{ filename: "f.txt", mime: "text/plain", dataBase64: "QQ==" }, { filename: "", dataBase64: "QQ==" }] } }).req.attachments.length, 1);
  bad("compose-new", { init: { subject: "x" } });
  // W8.10: an email link of a message - cc, bcc (50 each) and the body text (8,000 characters, cut)
  {
    const many = (n) => Array.from({ length: n }, (_, i) => `u${i}@x.test`);
    const r = ok("compose-new", { init: { accountId: "a1", to: many(60), cc: ["c@x.test", 5, "d@x.test"], bcc: many(80), subject: "S", bodyText: "b".repeat(9000) } }).req;
    assert.equal(r.to.length, 50);
    assert.deepEqual(r.cc, ["c@x.test", "d@x.test"], "only strings travel");
    assert.equal(r.bcc.length, 50);
    assert.equal(r.bodyText.length, 8000, "a body longer than 8,000 characters is cut");
    const plain = ok("compose-new", { init: { accountId: "a1", to: ["x@y.z"] } }).req;
    assert.ok(!("cc" in plain) && !("bcc" in plain) && !("bodyText" in plain), "no cc, bcc or body when none was sent");
    assert.deepEqual(ok("compose-new", { init: { accountId: "a1", cc: "x@y.z", bcc: {}, bodyText: 5 } }).req.cc, undefined, "wrong types are dropped");
    assert.equal(ok("compose-new", { init: { accountId: "a1", bodyText: "" } }).req.bodyText, undefined, "an empty body is no body");
  }
  // W8.1: "Search mail for ..." from a reader window - a string with something to search for
  assert.deepEqual(ok("search", { text: "budget review" }), { kind: "search", text: "budget review" });
  assert.deepEqual(ok("search", { text: "from:boss" }), { kind: "search", text: "from boss" }, "the main page does not take a filter from a reader");
  assert.equal(ok("search", { text: "a".repeat(200) }).text.length, 100);
  for (const t of ["", "   ", "a".repeat(201), 5, null, undefined, ["a"], {}]) bad("search", { text: t });
  bad("search", null);
  // dialogs: Settings, the event dialog and the PGP key dialogs; not the cleaner, not a dialog of the reader
  assert.equal(ok("dialog", { dialog: { type: "settings", tab: "ai" } }).req.tab, "ai");
  assert.equal(ok("dialog", { dialog: { type: "event", init: { summary: "x" } } }).req.type, "event");
  // (1.0.8) "Create rule…" in a reader window: the dialog opens in the main window, from a source that is checked field by field
  const ruleSource = { accountId: "a1", folder: "inbox", fromName: "Deals", fromEmail: "deals@shop.example", subject: "Hi", text: "hello", mine: false };
  assert.deepEqual(ok("dialog", { dialog: { type: "rule", source: ruleSource } }).req, { type: "rule", source: ruleSource });
  assert.equal(ok("dialog", { dialog: { type: "rule", source: { ...ruleSource, text: "x".repeat(9000) } } }).req.source.text.length, 2000);
  for (const source of [null, {}, { ...ruleSource, accountId: "" }, { ...ruleSource, subject: 4 }, "x"]) bad("dialog", { dialog: { type: "rule", source } });
  // (1.0.8) Run now in the Settings window: the main window runs it; only from a settings window, and the rule is checked
  const draft = { id: "r1", accountId: null, name: "x", conditions: [{ field: "from", op: "equals", values: ["a@b.c"] }], action: "move", arg: "archive", enabled: true };
  assert.deepEqual(parseRequest("rule-run", { rule: draft, folder: "inbox" }, { from: "settings-main", prefKeys: [] }), { kind: "rule-run", rule: { ...draft, accountId: null }, folder: "inbox" });
  for (const [payload, from] of [[{ rule: draft, folder: "inbox" }, "reader-a"], [{ rule: draft }, "settings-x"], [{ rule: { ...draft, action: "boom" }, folder: "inbox" }, "settings-x"], [{ rule: { ...draft, conditions: [] }, folder: "inbox" }, "settings-x"], [{ rule: { ...draft, conditions: [{ field: "x", op: "contains", values: ["a"] }] }, folder: "inbox" }, "settings-x"], [{ rule: null, folder: "inbox" }, "settings-x"]]) {
    assert.ok("error" in parseRequest("rule-run", payload, { from, prefKeys: [] }), JSON.stringify(payload).slice(0, 80));
  }
  assert.equal(ok("dialog", { dialog: { type: "pgp-key", fingerprint: "ABCD" } }).req.fingerprint, "ABCD");
  assert.equal(ok("dialog", { dialog: { type: "pgp-import", paste: true } }).req.paste, true);
  ok("dialog", { dialog: { type: "pgp-generate" } });
  for (const d of [{ type: "cleaner" }, { type: "original", messageId: "m1" }, { type: "pgp-key" }, null, "settings"]) bad("dialog", { dialog: d });
  assert.deepEqual(ok("calendar", { day: { y: 2026, m: 10, d: 17 } }), { kind: "calendar", day: { y: 2026, m: 10, d: 17 } });
  assert.deepEqual(ok("calendar", {}), { kind: "calendar", day: null });
  assert.deepEqual(ok("calendar", { day: { y: "x", m: 1, d: 1 } }), { kind: "calendar", day: null });
  assert.deepEqual(ok("import-key", { messageId: "m1", index: 0 }), { kind: "import-key", messageId: "m1", index: 0 });
  bad("import-key", { messageId: "m1", index: -1 });
  bad("import-key", { index: 0 });
  assert.deepEqual(ok("show-main", {}), { kind: "show-main" });
  bad("quit", {});
  bad("set-setting", { key: "prefs", value: "{}" });
  bad("", null);
}

// ---- the wiring of the reader
{
  const root = read("src/popout/PopoutRoot.tsx");
  assert.ok(root.includes("useStore.setState({ prefs: p })"), "the root fills the preferences of the window's store");
  // ---- the title bar theme (1.0.6, Mac QA: a compose window made in Dark kept a black title bar): one backend function, wintheme.rs `apply_all`,
  // gives every window the theme of the setting; no page and no creation path fixes a theme
  for (const f of ["src/popout/PopoutRoot.tsx", "src/popout/ComposeView.tsx", "src/popout/ReaderView.tsx", "src/App.tsx", "src/store.ts"]) {
    assert.ok(!read(f).includes("setTheme("), `${f} does not set the window theme (the backend does)`);
  }
  assert.ok(!read("src-tauri/capabilities/popout.json").includes("allow-set-theme"), "a pop-out page may not set its own theme");
  const wt = read("src-tauri/src/wintheme.rs");
  const lib = read("src-tauri/src/lib.rs");
  const pop = read("src-tauri/src/popout.rs");
  assert.ok(/mod wintheme;/.test(lib), "the module is part of the app");
  // the setting: dark / light pin, everything else (system) follows the OS
  assert.ok(wt.includes('Some("dark") => Some(Theme::Dark)') && wt.includes('Some("light") => Some(Theme::Light)') && wt.includes("_ => None,"), "only light and dark pin a theme; system follows the OS");
  assert.ok(/Step::Release => \{\s*let _ = w\.set_theme\(None\);/.test(wt), "System is given to the windows as None (follow the OS)");
  assert.equal(wt.split("\n#[cfg(test)]")[0].split(".set_theme(").length - 1, 2, "the native calls are Pin and Release, nothing else");
  // every window comes through it: a pop-out (after its build, not in the builder), the main window (start-up), the setting, the OS event
  const create = pop.slice(pop.indexOf("fn create("));
  const createBody = create.slice(0, create.indexOf("\n}\n"));
  assert.ok(createBody.indexOf("b.build()") < createBody.indexOf("crate::wintheme::apply_all(app, "), "a pop-out gets the theme right after it is built");
  assert.ok(!/\.theme\(/.test(createBody), "the window builder is not given a theme");
  assert.ok(lib.slice(lib.indexOf(".setup(|app|"), lib.indexOf(".on_window_event(")).includes("wintheme::apply_all(app.handle(), "), "the main window at start-up");
  const setSetting = lib.slice(lib.indexOf("fn set_setting("));
  assert.ok(setSetting.slice(0, setSetting.indexOf("\n}\n")).includes("wintheme::apply_all(&app, "), "a change of the preferences");
  const ev = lib.slice(lib.indexOf(".on_window_event("), lib.indexOf(".invoke_handler"));
  assert.ok(ev.indexOf("tauri::WindowEvent::ThemeChanged") < ev.indexOf('window.label() != "main"') && ev.includes("wintheme::on_os_theme_changed"), "an OS theme change reported by any window, before the label is looked at");
  // the second way (macOS safety net): the page of a pop-out asks the backend to apply its own window again; the page never sets a theme itself
  assert.ok(/windowThemeRefresh\(theme, dark\)/.test(root) && root.includes("onOsDarkChange"), "the pop-out page asks for its frame theme after it changed its own theme class, and when its colour scheme changes");
  assert.ok(root.indexOf("applyPrefs(p);") < root.indexOf("askFrameTheme();"), "asked after the page applied its theme class");
  assert.ok(read("src/api.ts").includes('invoke<void>("window_theme_refresh"'), "the api has the command");
  assert.ok(lib.includes("wintheme::window_theme_refresh,") && read("src-tauri/build.rs").includes('"window_theme_refresh"'), "the command is registered and in the manifest");
  for (const cap of ["default.json", "popout.json"]) assert.ok(read(`src-tauri/capabilities/${cap}`).includes('"allow-window-theme-refresh"'), `${cap} grants it`);
  // nowhere else is a window theme set
  for (const [name, src] of [["lib.rs", lib], ["popout.rs", pop]]) {
    assert.ok(!src.includes(".set_theme(") && !src.includes(".theme(Some"), `${name} does not set a theme by itself`);
  }
  const views = read("src/popout/views.tsx");
  assert.ok(views.includes("loadReaderWindowView") && views.includes("loadComposeWindowView"), "the reader and the compose window are plugged in (as chunks of their own, lazyViews.tsx)");
  assert.ok(read("src/lazyViews.tsx").includes('import("./popout/ReaderView")') && read("src/lazyViews.tsx").includes('import("./popout/ComposeView")'), "... by their views");
  // the main window answers requests; the reader asks, never writes
  const app = read("src/App.tsx");
  assert.ok(app.includes('listen<Envelope>("popout-request"') && app.includes("handlePopoutRequest(e.payload)"), "the main page listens for the requests of the windows");
  const reader = read("src/popout/ReaderView.tsx") + read("src/popout/readerBridge.ts");
  for (const never of ["api.setSetting", "api.threadAction", "api.queueAction", "api.prepareAction", "api.cancelAction", "api.syncAccount", "api.removeAccount", "api.pgpImport", "api.pgpDelete", "api.showWindow", "api.quitNow", "setSetting("]) {
    assert.ok(!reader.includes(never), `the reader must not call ${never}`);
  }
  assert.ok(reader.includes('askMain("thread-action"') && reader.includes('askMain("prefs"'), "state changes and the mail background go through the main page");
  assert.ok(read("src/popout/mainRequests.ts").includes("st.act([threadId], action, arg, label, view)"), "a move runs through act with the view the reader was opened from");
  // the entry points
  const list = read("src/components/MessageList.tsx");
  assert.ok(list.includes("onDoubleClick") && list.includes("e.shiftKey") && list.includes("openReader(it.t, folder)"), "double-click and Shift+Enter on a row");
  assert.ok(read("src/components/ListContextMenu.tsx").includes("openReader(first, folder)"), "the row menu");
  assert.ok(read("src/components/ReadingPane.tsx").includes("openReader(summ, folder)"), "the reading pane button");
  assert.ok(read("src/components/CommandBar.tsx").includes("openReader(cur, s.folder)"), "the command bar");
  const dlg2 = read("src/components/SettingsDialog.tsx");
  assert.ok(dlg2.includes('"settings.keys.openInWindow"') && dlg2.includes('"settings.keys.closeWindow"'), "the shortcut list says so");
  // every command the reader window and the reading-pane parts it shows call is one the secondary windows may call (REQ-S2)
  const apiSrc = read("src/api.ts");
  const cmd = new Map();
  let prop = "";
  for (const line of apiSrc.split("\n")) {
    const p = /^  (\w+):/.exec(line);
    if (p) prop = p[1];
    const c = /invoke(?:<[^(]*>)?\("(\w+)"/.exec(line);
    if (c && prop) cmd.set(prop, c[1]);
  }
  assert.equal(cmd.get("getThread"), "get_thread_packed");
  assert.equal(cmd.get("popoutRequest"), "popout_request");
  const allowed = new Set(JSON.parse(read("src-tauri/capabilities/popout.json")).permissions.filter((p) => p.startsWith("allow-")).map((p) => p.slice(6).replace(/-/g, "_")));
  let checked = 0;
  for (const f of ["src/popout/ReaderView.tsx", "src/popout/readerBridge.ts", "src/popout/open.ts", "src/components/ReadingPane.tsx", "src/components/Attachments.tsx", "src/translate.ts", "src/aiCall.ts", "src/useAiSlot.ts", "src/translateRun.ts"]) {
    for (const [, name] of read(f).matchAll(/\bapi\.(\w+)/g)) {
      assert.ok(cmd.has(name), `${f}: api.${name} is not an invoke`);
      assert.ok(allowed.has(cmd.get(name)), `${f} calls api.${name} (${cmd.get(name)}), which a secondary window may not`);
      checked++;
    }
  }
  assert.ok(checked > 20, `the scan found the calls (${checked})`);
  // Settings and the key dialogs open in the main window (REQ-R11)
  assert.ok(!reader.includes("<Settings") && !reader.includes("KeyDetailsDialog") && !reader.includes("ImportKeyDialog"));
  // REQ-R12: a translation / summary of a window stops with it (the backend tracks the calls by window)
  assert.ok(read("src-tauri/src/lib.rs").includes("popout::track_ai(window.label(), id)") && read("src-tauri/src/popout.rs").includes("crate::ai::cancel(&id)"));
  assert.ok(reader.includes("cancelRunningTranslations()"));
}

// ---- the webview's own right-click menu stays off in the reader window too (owner rule)
{
  const main = read("src/main.tsx");
  assert.ok(main.indexOf("installContextGuard();") > 0 && main.indexOf("installContextGuard();") < main.indexOf("ReactDOM.createRoot("), "the window guard is installed before any route is mounted (main, compose and reader)");
  assert.ok(!main.includes("route.kind === \"main\" && installContextGuard"), "not only for the main route");
  const reader = read("src/popout/ReaderView.tsx");
  assert.ok(!reader.includes("<GuardMenuHost />") && reader.includes("await loadPlatform()"), "the in-app menu host is mounted once by main.tsx (a second one in the view opened two menus, D-036) and the platform (debug build or not) is known");
  assert.ok(!reader.includes("<iframe"), "the reader draws its frames only through the reading-pane components");
  assert.ok(reader.includes("<MessageCard"), "the message body is the reading pane's MessageBody");
  // those components guard their frames: the message body, and the attachment preview (PDF / text)
  assert.ok(read("src/components/ReadingPane.tsx").includes("lockedNow.current ? guardFrameQuitKey(doc) : guardFrame(frame, doc, { search: true, picture: (box) => picMenuRef.current(box) })"), "message frame guarded (confidential mail has no menu at all: lockDocument, and only the Ctrl+Q handler of guardFrameQuitKey, D-112)");
  assert.ok(read("src/components/ReadingPane.tsx").includes("lockDocument(doc)"));
  assert.ok(read("src/components/Attachments.tsx").includes("guardFrame(f, f.contentDocument)"), "attachment preview frame guarded");
  const html = read("src/components/ReadingPane.tsx") + read("src/components/Attachments.tsx");
  assert.equal((html.match(/<iframe/g) || []).length, 2, "no other frame in the pieces the reader shows");
}

// =====================================================================================================================================
// The compose window (WP6b)
// =====================================================================================================================================

// ---- Shift for every way of starting a message: the click or key being handled is noted, and only for a moment
{
  const ev = (o) => ({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  resetModifier();
  assert.equal(shiftNow(1000), false, "nothing noted yet");
  noteInput(ev({ shiftKey: true }), 1000);
  assert.equal(shiftNow(1000), true);
  assert.equal(shiftNow(1000 + MODIFIER_WINDOW_MS), true, "still the same click");
  assert.equal(shiftNow(1000 + MODIFIER_WINDOW_MS + 1), false, "a call long after the click is not a Shift call");
  noteInput(ev({}), 2000);
  assert.equal(shiftNow(2000), false, "the next plain click clears it");
  noteInput(ev({ shiftKey: true, ctrlKey: true }), 3000);
  assert.equal(shiftNow(3000), false, "Ctrl+Shift is another shortcut");
  resetModifier();
}

// ---- which window shows what
assert.equal(answerKey("reply", "m1"), "re:m1");
assert.equal(answerKey("replyAll", "m1"), "ra:m1");
assert.equal(answerKey("forward", "m1"), "fw:m1");
assert.notEqual(answerKey("reply", "m1"), answerKey("replyAll", "m1"), "Reply and Reply all are two windows");
assert.equal(draftKey("t9"), "draft:t9");

// ---- the phases of a compose window around a send (REQ-C8)
{
  const run = (events, from = START) => {
    let s = from;
    const fx = [];
    for (const e of events) {
      const r = step(s, e);
      s = r.s;
      fx.push(...r.fx);
    }
    return { s, fx };
  };
  const T = 1_000_000;
  // counting: the card shows, Undo works once Compose hands it over, the time runs out, the send ends, the window ends after the grace time
  let r = run([{ t: "handoff", wait: 10, now: T }]);
  assert.equal(r.s.phase, "count");
  assert.equal(r.s.endsAt, T + 10_000);
  assert.deepEqual(r.fx, [], "the window stays: it shows the countdown");
  assert.equal(secondsLeft(r.s.endsAt, T), 10);
  assert.equal(secondsLeft(r.s.endsAt, T + 9_100), 1, "never below 1 while it runs");
  assert.equal(secondsLeft(null, T), 0);
  r = run([{ t: "undo-offer" }], r.s);
  assert.equal(r.s.canUndo, true);
  r = run([{ t: "sends", n: 1, now: T + 1 }, { t: "tick", now: T + 5_000 }], r.s);
  assert.equal(r.s.phase, "count", "not over yet");
  r = run([{ t: "tick", now: T + 10_000 }], r.s);
  assert.equal(r.s.phase, "work", "the Undo time is over: sending, no Undo any more");
  assert.equal(r.s.canUndo, false);
  r = run([{ t: "sends", n: 0, now: T + 12_000 }], r.s);
  assert.deepEqual(r.fx, ["grace"], "the send ended: a failure would bring the editor back within the grace time");
  r = run([{ t: "grace", now: T + 12_000 + GRACE_MS }], r.s);
  assert.deepEqual(r.fx, ["destroy"]);
  assert.equal(r.s.phase, "over");

  // Undo: the cancel ends the send first and then the editor comes back; the window must not end in between
  r = run([{ t: "handoff", wait: 10, now: T }, { t: "undo-offer" }, { t: "sends", n: 1, now: T }, { t: "undo-start", now: T + 3_000 }, { t: "sends", n: 0, now: T + 3_001 }], START);
  assert.deepEqual(r.fx, ["grace"]);
  const early = run([{ t: "grace", now: T + 3_001 + GRACE_MS }], r.s);
  assert.deepEqual(early.fx, ["grace"], "Undo is being cancelled: wait for the editor");
  r = run([{ t: "reopen" }, { t: "grace", now: T + 3_001 + GRACE_MS }], r.s);
  assert.equal(r.s.phase, "edit", "the editor is back");
  assert.deepEqual(r.fx.filter((x) => x === "destroy"), [], "nothing ends");
  // an Undo that failed (the send was already on its way) does not keep the window for ever
  r = run([{ t: "handoff", wait: 10, now: T }, { t: "sends", n: 1, now: T }, { t: "undo-start", now: T + 9_900 }, { t: "tick", now: T + 10_000 }, { t: "sends", n: 0, now: T + 10_500 }], START);
  r = run([{ t: "grace", now: T + 9_900 + UNDO_SETTLE_MS + 1 }], r.s);
  assert.deepEqual(r.fx, ["destroy"], "after the settle time the window ends");

  // a failed send: the error brings the editor back before the send is counted as over
  r = run([{ t: "handoff", wait: 0, now: T }, { t: "sends", n: 1, now: T }, { t: "reopen" }, { t: "sends", n: 0, now: T + 50 }], START);
  assert.equal(r.s.phase, "edit");
  assert.deepEqual(r.fx, ["park", "show"], "closed at once (no Undo time), shown again when the message comes back");
  assert.equal(r.s.parked, false);
  // the schedule path ends its send before the editor comes back: the grace time covers it
  r = run([{ t: "handoff", wait: 0, now: T }, { t: "sends", n: 1, now: T }, { t: "sends", n: 0, now: T + 10 }, { t: "reopen" }, { t: "grace", now: T + 10 + GRACE_MS }], START);
  assert.equal(r.s.phase, "edit");
  assert.ok(!r.fx.includes("destroy"), "the window is not ended under the editor that came back");
  // no Undo time: the window is gone at once (parked) and ends when the send has gone
  r = run([{ t: "handoff", wait: 0, now: T }, { t: "sends", n: 1, now: T }, { t: "sends", n: 0, now: T + 200 }, { t: "grace", now: T + 200 + GRACE_MS }], START);
  assert.deepEqual(r.fx, ["park", "grace", "destroy"]);
  // W13.1: a SEND keeps the editor on screen, locked: with or without an Undo time nothing is hidden, and the window ends when the server has answered
  r = run([{ t: "handoff", wait: 10, now: T, lock: true }]);
  assert.equal(r.s.phase, "count");
  assert.equal(r.s.parked, false);
  assert.deepEqual(r.fx, [], "locked, nothing hidden");
  r = run([{ t: "handoff", wait: 0, now: T, lock: true }, { t: "sends", n: 1, now: T }, { t: "sends", n: 0, now: T + 200 }, { t: "grace", now: T + 200 + GRACE_MS }], START);
  assert.deepEqual(r.fx, ["grace", "destroy"], "Undo send off: no park (the window stays on screen, locked); it ends when the send is over");
  assert.equal(r.s.parked, false);
  // Undo: the SAME editor is unlocked (the "reopen" event: phase edit, nothing ended, nothing re-created by the machine)
  r = run([{ t: "handoff", wait: 10, now: T, lock: true }, { t: "undo-offer" }, { t: "sends", n: 1, now: T }, { t: "undo-start", now: T + 3_000 }, { t: "sends", n: 0, now: T + 3_001 }, { t: "reopen" }, { t: "grace", now: T + 3_001 + GRACE_MS }], START);
  assert.equal(r.s.phase, "edit");
  assert.deepEqual(r.fx.filter((x) => x === "destroy" || x === "park"), [], "an Undo ends nothing and hides nothing");
  // a failed send of a window that the person closed during the send (parked): it comes forward, unlocked
  r = run([{ t: "handoff", wait: 10, now: T, lock: true }, { t: "close" }, { t: "sends", n: 1, now: T }, { t: "tick", now: T + 10_000 }, { t: "reopen" }, { t: "sends", n: 0, now: T + 10_500 }], START);
  assert.deepEqual(r.fx, ["park", "show"]);
  assert.equal(r.s.phase, "edit");
  assert.equal(r.s.parked, false);
  // a message that was only saved, discarded or closed: the window ends at once
  assert.deepEqual(run([{ t: "end" }]).fx, ["destroy"]);
  // the person closes the window while it counts down: out of sight, still running, once
  r = run([{ t: "handoff", wait: 10, now: T }, { t: "close" }, { t: "close" }], START);
  assert.deepEqual(r.fx, ["park"]);
  assert.equal(r.s.phase, "count", "the countdown goes on");
  assert.deepEqual(run([{ t: "close" }]).fx, [], "while editing the close button is the close dialog's business");
  // a second send started meanwhile keeps the window
  r = run([{ t: "handoff", wait: 0, now: T }, { t: "sends", n: 1, now: T }, { t: "sends", n: 0, now: T + 1 }, { t: "sends", n: 1, now: T + 2 }, { t: "grace", now: T + 1 + GRACE_MS }], START);
  assert.ok(!r.fx.includes("destroy"));
}

// ---- closing the window (REQ-C11)
{
  const f = (o) => ({ phase: "edit", dirty: false, hasContent: false, attaching: false, ...o });
  assert.equal(closeAction(f({})), "end", "nothing changed");
  assert.equal(closeAction(f({ dirty: true })), "end", "typed and deleted again: nothing to keep");
  // W13.5: `hasContent` here is the probe's draftContent: a message with only recipients typed is dirty but has none, so it ends without a question
  assert.equal(closeAction(f({ dirty: true, hasContent: false })), "end", "recipients only (draftContent false): the window closes, no question");
  assert.equal(closeAction(f({ dirty: true, hasContent: false, attaching: true })), "attaching", "files still coming in are waited for before it is decided");
  assert.equal(closeAction(f({ dirty: false, hasContent: true })), "end", "saved already (an autosave) or opened as it is");
  assert.equal(closeAction(f({ dirty: true, hasContent: true })), "ask");
  assert.equal(closeAction(f({ dirty: true, hasContent: true, attaching: true })), "attaching", "files still coming in");
  assert.equal(closeAction(f({ phase: "count" })), "park");
  assert.equal(closeAction(f({ phase: "work", dirty: true, hasContent: true })), "park");
  assert.equal(closeAction(f({ phase: "over" })), "end");

  const make = (facts, answers) => {
    const log = [];
    const q = { ...answers };
    return {
      log,
      d: {
        facts: () => facts,
        ask: async () => (log.push("ask"), q.ask),
        save: async () => (log.push("save"), q.save),
        askFailed: async () => (log.push("askFailed"), q.askFailed),
        discard: async () => void log.push("discard"),
        park: () => void log.push("park"),
        end: () => void log.push("end"),
        attaching: () => void log.push("attaching"),
        savedDraft: () => void log.push("savedDraft"),
      },
    };
  };
  const changed = f({ dirty: true, hasContent: true });
  let m = make(f({}), {});
  assert.equal(await runClose(m.d), "ended");
  assert.deepEqual(m.log, ["end"], "an empty message closes without a question");
  m = make(changed, { ask: "cancel" });
  assert.equal(await runClose(m.d), "cancelled");
  assert.deepEqual(m.log, ["ask"], "Cancel keeps everything");
  m = make(changed, { ask: "save", save: true });
  assert.equal(await runClose(m.d), "saved");
  assert.deepEqual(m.log, ["ask", "save", "savedDraft", "end"], "saved first, the main window told, then the window ends");
  m = make(changed, { ask: "discard" });
  assert.equal(await runClose(m.d), "discarded");
  assert.deepEqual(m.log, ["ask", "discard", "end"]);
  m = make(changed, { ask: "save", save: false, askFailed: "keep" });
  assert.equal(await runClose(m.d), "kept");
  assert.deepEqual(m.log, ["ask", "save", "askFailed"], "a failed save never ends the window");
  m = make(changed, { ask: "save", save: false, askFailed: "discard" });
  assert.equal(await runClose(m.d), "discarded");
  assert.deepEqual(m.log, ["ask", "save", "askFailed", "discard", "end"]);
  m = make(f({ phase: "count" }), {});
  assert.equal(await runClose(m.d), "parked");
  assert.deepEqual(m.log, ["park"]);
  m = make({ ...changed, attaching: true }, {});
  assert.equal(await runClose(m.d), "attaching");
  assert.deepEqual(m.log, ["attaching"]);

  // 1.0.7 W2.3: typed, autosaved, deleted again: the copy of a NEW message goes before the window ends (and only then)
  const emptied = f({ dirty: true, hasContent: false });
  m = make(emptied, {});
  m.d.emptied = async () => void m.log.push("emptied");
  assert.equal(await runClose(m.d), "ended");
  assert.deepEqual(m.log, ["emptied", "end"], "no question, the saved copy is dropped, then the window ends");
  // W13.5: the same for a window with only recipients: no question, no save, the snapshot and any autosaved copy go
  m = make(f({ dirty: true, hasContent: false }), { ask: "save", save: true });
  m.d.emptied = async () => void m.log.push("emptied");
  assert.equal(await runClose(m.d), "ended");
  assert.deepEqual(m.log, ["emptied", "end"], "a recipients-only window: neither asks nor saves");
  m = make(f({}), {});
  m.d.emptied = async () => void m.log.push("emptied");
  assert.equal(await runClose(m.d), "ended");
  assert.deepEqual(m.log, ["end"], "untouched: nothing to drop");
  m = make(f({ phase: "over", dirty: true }), {});
  m.d.emptied = async () => void m.log.push("emptied");
  await runClose(m.d);
  assert.deepEqual(m.log, ["end"], "a window that is over drops nothing");

  // 1.0.7 W2.2: Discard on an opened draft that cannot be put back (the server refused): the window stays, Compose has said why
  m = make(changed, { ask: "discard" });
  m.d.discard = async () => (m.log.push("discard"), false);
  assert.equal(await runClose(m.d), "kept");
  assert.deepEqual(m.log, ["ask", "discard"], "the window does not end");
  m = make(changed, { ask: "save", save: false, askFailed: "discard" });
  m.d.discard = async () => (m.log.push("discard"), false);
  assert.equal(await runClose(m.d), "kept");
  assert.deepEqual(m.log, ["ask", "save", "askFailed", "discard"]);
  // a discard that returns nothing (the old shape) or true ends the window
  m = make(changed, { ask: "discard" });
  m.d.discard = async () => (m.log.push("discard"), true);
  assert.equal(await runClose(m.d), "discarded");
}

// ---- quit and update restart (REQ-C12)
{
  const make = (o) => {
    const log = [];
    return {
      log,
      d: {
        phase: () => o.phase ?? "edit",
        dirty: () => !!o.dirty,
        hasContent: () => o.hasContent ?? true,
        ...(o.emptied ? { emptied: async () => void log.push("emptied") } : {}),
        save: async () => (log.push("save"), o.save ?? true),
        ask: async (why) => (log.push(`ask:${why}`), o.answer ?? "keep"),
        showWindow: () => log.push("show"),
        dialog: (open) => log.push(`dialog:${open}`),
        discarded: async () => void log.push("discarded"),
        flushSends: async () => void log.push("flushSends"),
      },
    };
  };
  let m = make({});
  assert.equal(await composeFlush(m.d, "quit"), true);
  assert.deepEqual(m.log, [], "nothing changed: nothing to do");
  m = make({ dirty: true });
  assert.equal(await composeFlush(m.d, "quit"), true);
  assert.deepEqual(m.log, ["save"], "saved quietly, no question");
  m = make({ dirty: true, hasContent: false });
  assert.equal(await composeFlush(m.d, "quit"), true);
  assert.deepEqual(m.log, [], "typed and deleted: no empty draft");
  // W13.5: quit and update restart with only recipients typed: no draft, no question; the snapshot and the autosaved copy of a new message go
  for (const why of ["quit", "update"]) {
    m = make({ dirty: true, hasContent: false, emptied: true });
    assert.equal(await composeFlush(m.d, why), true);
    assert.deepEqual(m.log, ["emptied"], `${why}: recipients only is closed silently`);
  }
  m = make({ dirty: false, hasContent: false, emptied: true });
  assert.equal(await composeFlush(m.d, "quit"), true);
  assert.deepEqual(m.log, [], "not changed: nothing to drop");
  m = make({ dirty: true, hasContent: true, emptied: true });
  await composeFlush(m.d, "quit");
  assert.deepEqual(m.log, ["save"], "draft content: saved as before, nothing emptied");
  m = make({ dirty: true, save: false, answer: "keep" });
  assert.equal(await composeFlush(m.d, "quit"), false, "Keep writing cancels the whole quit");
  assert.deepEqual(m.log, ["save", "show", "dialog:true", "ask:quit", "dialog:false"]);
  m = make({ dirty: true, save: false, answer: "discard" });
  assert.equal(await composeFlush(m.d, "update"), true);
  assert.deepEqual(m.log, ["save", "show", "dialog:true", "ask:update", "dialog:false", "discarded"], "the question knows it is an update");
  m = make({ phase: "count" });
  assert.equal(await composeFlush(m.d, "quit"), true);
  assert.deepEqual(m.log, ["flushSends"], "a message in its Undo time goes out now (and is waited for)");
  m = make({ phase: "work", dirty: true });
  assert.equal(await composeFlush(m.d, "update"), true);
  assert.deepEqual(m.log, ["flushSends"]);
  // a question that throws still closes the dialog bracket (the backend must stop waiting for the person)
  m = make({ dirty: true, save: false });
  m.d.ask = async () => { throw new Error("x"); };
  await assert.rejects(() => composeFlush(m.d, "quit"));
  assert.deepEqual(m.log, ["save", "show", "dialog:true", "dialog:false"]);
}

// ---- what a compose window may tell the main window (REQ-S4)
{
  assert.equal(parseComposeRequest("thread-action", {}), null, "the reader's kinds are not ours");
  assert.equal(parseComposeRequest("compose", {}), null);
  assert.deepEqual(parseComposeRequest("cw-toast", { text: "Message sent", level: "success" }), { kind: "toast", text: "Message sent", level: "success" });
  assert.equal(parseComposeRequest("cw-toast", { text: "x", level: "weird" }).level, "info");
  assert.equal(parseComposeRequest("cw-toast", { text: "x".repeat(900) }).text.length, 400);
  assert.ok("error" in parseComposeRequest("cw-toast", { text: "  " }));
  assert.deepEqual(parseComposeRequest("cw-draft-saved", { threadId: "t1", plain: true }), { kind: "draft-saved", threadId: "t1", plain: true });
  assert.ok("error" in parseComposeRequest("cw-draft-saved", {}));
  assert.deepEqual(parseComposeRequest("cw-scheduled", { outboxId: "o1", sendAt: 1790000000 }), { kind: "scheduled", outboxId: "o1", sendAt: 1790000000 }, "Scheduled for ... with Undo and View is made in the main window");
  assert.ok("error" in parseComposeRequest("cw-scheduled", { outboxId: "o1" }) && "error" in parseComposeRequest("cw-scheduled", { sendAt: 5 }) && "error" in parseComposeRequest("cw-scheduled", { outboxId: "o1", sendAt: "soon" }));
  assert.deepEqual(parseComposeRequest("cw-sync", null), { kind: "sync" });
  assert.deepEqual(parseComposeRequest("cw-refresh", 5), { kind: "refresh" });
  assert.deepEqual(parseComposeRequest("cw-dialog", { dialog: { type: "pgp-generate", accountId: "a1" } }), { kind: "dialog", dialog: { type: "pgp-generate", accountId: "a1" } });
  assert.deepEqual(parseComposeRequest("cw-dialog", { dialog: { type: "settings", tab: "pgp" } }), { kind: "dialog", dialog: { type: "settings", tab: "pgp", focus: undefined } });
  for (const bad of [{ type: "cleaner" }, { type: "original", messageId: "m" }, { type: "event" }, { type: "pgp-key" }, null]) {
    assert.ok("error" in parseComposeRequest("cw-dialog", { dialog: bad }), JSON.stringify(bad));
  }
  assert.ok("error" in parseComposeRequest("cw-quit", {}));
  assert.ok("error" in parseComposeRequest("cw-", {}));
  // the toasts that go to the main window when the window ends: those raised at or after the hand-over
  const raised = [{ at: 100, kind: "info" }, { at: 900, kind: "success" }, { at: 1000, kind: "success" }];
  assert.deepEqual(carryToasts(raised, 900).map((x) => x.at), [900, 1000]);
  assert.deepEqual(carryToasts([], 0), []);
}

// ---- the wiring of the compose window
{
  const view = read("src/popout/ComposeView.tsx");
  const compose = read("src/components/Compose.tsx");
  // a window never writes the preferences and handles no main-window event
  for (const never of ["setPrefs", 'setSetting("prefs"', 'listen("flush-sends"', "tray-compose", "open-thread", "frontendReady", ".init()"]) {
    assert.ok(!view.includes(never), `ComposeView must not use ${never}`);
  }
  // it asks to be closed through its page: the close request is held back, the window ends itself or goes out of sight
  assert.ok(view.includes("onCloseRequested(") && view.includes("e.preventDefault()"), "the close request is held back until the person answered");
  const composeSrc = readFileSync(new URL("../src/components/Compose.tsx", import.meta.url), "utf8");
  const initOf = composeSrc.slice(composeSrc.indexOf("const initOf = ("), composeSrc.indexOf("const reopen = ("));
  assert.ok(initOf.includes("restore: { encrypt: encIntent, sign: signOn, attachKey },") && /\n\s+sigId, \/\//.test(initOf), "a message moved into a window, back after Undo or reopened after a failed send carries the signature picker (W2.7)");
  assert.ok(initOf.includes("...init,") && initOf.includes("openedDraft: openedDraft || undefined"), "and the opened-draft mark (W2.2)");
  assert.ok(view.includes("composeEnd?.({ dropDraft: true })") && view.includes("=== false) return false"), "an opened draft that cannot be put back keeps the window open (W2.2)");
  assert.ok(view.includes("emptied: async () => void (await st.getState().composeEnd?.({ emptied: true }))"), "an emptied message drops the copy an autosave made before the window ends (W2.3)");
  assert.ok(view.includes("api.popoutDestroy()") && view.includes("api.popoutPark()"));
  assert.ok(view.includes("registerFlushHandler(") && view.includes("composeFlush("), "a quit and an update restart ask the window");
  // W13.5: closing and quitting go by the draft rule (a recipients-only message is neither saved nor asked about), not by the crash snapshot's
  assert.ok(view.includes("hasContent: !!p?.draftContent") && view.includes("hasContent: () => !!st.getState().composeProbe?.().draftContent"), "the window closes and flushes by draftContent");
  assert.ok(!/composeProbe\?\.\(\)\.hasContent|p\?\.hasContent/.test(view), "no path of the window goes by the snapshot's hasContent");
  assert.ok(view.includes("emptied: async () => void (await st.getState().composeEnd?.({ emptied: true }))"), "a quit with nothing worth a draft drops the snapshot and the autosaved copy");
  assert.ok(view.includes("<PassphraseHost />") && !view.includes("<GuardMenuHost />"), "the passphrase question is drawn in this window; the in-app menu comes from main.tsx (one host per window, D-036)");
  // the store actions that mean something else in a window are replaced before Compose is drawn
  for (const a of ["openCompose:", "sync:", "refresh:", "setDialog:", "showToast:"]) assert.ok(view.includes(a), a);
  assert.ok(view.indexOf("setReady(true)") > view.indexOf("openCompose:"), "Compose is drawn after the actions are replaced");
  // Compose.tsx: the seam is the only difference, and the main window (no seam) behaves as before
  assert.equal(compose.match(/composeSeam\(\)/g).length, 18, "the places where Compose asks the seam (one tells the window's log that the in-place fill of a Reply / Forward shell fell back to a fresh Compose, WP13f-3; two of them: a message scheduled in a window is announced by the main window, which owns the outbox; the two for the draft the pane shows (W2.11) are in draftOpen.ts since WP9d; one tells a window that the scheduled message it holds paused is handled, W2.10; three for the lock of a send, W13.1; two for the \"Sending…\" toasts that only the pane needs, W13.14 A9; one reports the snapshot id to the window, W4.2; the one that makes Ctrl+Shift+O a Move to main window in a window, W4.5)");
  assert.ok(compose.includes("composeSeam()?.scheduled(") && view.includes("scheduled: (outboxId, sendAt) => notifyMain(\"scheduled\""), "Scheduled for ... with Undo and View comes from the main window");
  assert.ok(!compose.includes("openCompose(null, { sending: wait })") && compose.includes("openCompose(null, { sending: 0 })"), "a scheduled message and Send now hand the message over, it does not end it; the Undo-time send keeps the pane (1.0.11)");
  assert.ok(compose.includes('else showToast(() => t("compose.toast.sending"), undoSend, "info", undefined, wait * 1000)'), "the main window has the Undo toast, as long as the message is held (W13.1)");
  // W13.1: a window keeps the editor on screen while it sends: locked, one toast, unlocked in place on Undo or a failure; no card, no unmounting
  assert.ok(compose.includes("lockForSend(wait);") && !compose.includes("if (composeSeam()) lockForSend(wait);"), "a send locks the editor, in a window and (1.0.11) in the pane");
  assert.ok(compose.includes("if (lockedRef.current && aliveRef.current) return unlock(d);"), "Undo and a failed send unlock the same editor (reopen in a window that is locked)");
  assert.ok(compose.includes("inert={locked || movingIn || undefined}") && compose.includes("aria-busy={locked || movingIn || !!preparing || undefined}"), "locked = inert and aria-busy (a shell that is being prepared is busy too, W13.13; so is a window that waits for the main window, W4.5)");
  assert.ok(compose.includes("if (lockedRef.current) return; // (a draft of a message that is in the outbox would stay behind)") && compose.includes("if (lockedRef.current) return; // (the message is on its way"), "no autosave and no snapshot of a message that is being sent");
  assert.ok(compose.includes("setTo(d.to);") && compose.includes("if (d.security && !d.security.encrypt && encIntent !== \"off\") setEncIntent(\"off\");"), "what the send questions changed is applied to the unlocked editor");
  assert.ok(compose.includes("touch();\n    composeSeam()?.unlock();"), "the unlocked message counts as changed");
  assert.ok(compose.includes("el.focus({ preventScroll: true })") && compose.includes("scrollsWas.current"), "the focus and the scroll position come back");
  assert.ok(!view.includes("popout-sending") && !view.includes("closesWhenSent") && !read("src/App.css").includes(".popout-sending"), "the Sending card is gone");
  assert.ok(view.includes("{ready && editor && <Compose key={editor.n} init={editor.init} />}") && !view.includes('win.phase === "edit" && <Compose'), "the editor is drawn in every phase");
  assert.ok(view.includes('lock: (wait) => dispatchRef.current({ t: "handoff", wait, now: Date.now(), lock: true })') && view.includes('unlock: () => dispatchRef.current({ t: "reopen" })'), "the seam");
  assert.ok(view.includes("setStickyToast(SEND_TOAST") && view.includes('readAs: () => tNow("compose.toast.sending")') && view.includes('compose.popout.sending'), "one toast, in place, read once");
  assert.ok(read("src/store.ts").includes("const ttl = ttlMs ?? (undo ?"), "showToast takes the time a toast stays");
  assert.ok(compose.includes("if (composeSeam() || busy) return;"), "no pop-out from a window (a scheduled message pops out like any other, W2.10)");
  assert.ok(compose.includes('openPopout("compose", key, moved)') && compose.includes('const key = init.outboxId ? outboxKey(init.outboxId) :') && compose.includes("if (init.outboxId) savedRef.current = true;"), "a scheduled message moves to a window keyed outbox:<id> and the pane does not release its pause as it closes");
  assert.ok(!compose.includes("!init.outboxId && !composeSeam() && (") && !compose.includes('"o" && !init.outboxId'), "the Pop out button and Ctrl+Shift+O are there for a scheduled message too");
  assert.ok(compose.includes('e.key.toLowerCase() === "o"') && compose.includes("compose.popout.popOutTip"), "Ctrl+Shift+O and the button");
  assert.ok(compose.includes("init.recoveryId || init.carried"), "a moved message counts as changed");
  // ... but only one that is changed: a pane as it was opened moves as it is (no question, no autosave in the window, nothing written; 1.0.7 WP2a QA BUG-2), and a
  // window that an opened draft was moved into after a save starts with the saved copy, so Discard there can put the opened version back
  assert.ok(compose.includes("carried: touched.current || !!savedDraftRef.current"), "moved as carried only when something was changed or saved");
  assert.ok(compose.includes('useRef<string | null>(openedDraft && init.replaces && !init.replaces.startsWith("m:") ? init.replaces : null)'), "the window starts with the draft the pane saved");
    // a pane that is moved to a window gives it the key of the draft (the one a save of the pane made, else the one it was opened from): the draft is open in one editor only
  // from the moment the window exists (1.0.7 WP2a retest BUG-2); and Save draft builds from the pane as it is NOW (retest BUG-1, the signature that arrives after the first draw)
  assert.ok(compose.includes("const key = init.outboxId ? outboxKey(init.outboxId) : savedTid.current ? draftKey(savedTid.current) : init.draftKey ?? null;") && compose.includes('openPopout("compose", key, moved)'), "Pop out passes the draft's key");
  assert.ok(read("src/draftOpen.ts").includes("draftKey: key, // (a Pop out of this pane gives the window this key"), "openDraftThread hands the key to the message");
  assert.ok(compose.includes("const d = buildDraftRef.current();") && compose.includes("buildDraftRef.current = buildDraft;"), "Save draft builds from the current pane");
{ const lib = read("src-tauri/src/lib.rs"); assert.ok(lib.includes("async fn discard_draft_changes(app: tauri::AppHandle,") && lib.includes("sync_drafts_after_restore(&app, &db, &acc.id)") && lib.includes("let _ = app.emit(\"mail-synced\", ());"), "after the opened version is put back the backend reads Drafts again and every window re-reads"); }
  assert.ok(compose.includes("poppingRef.current = true") && compose.includes("sending: sendingRef.current || poppingRef.current"), "moving a message to a window must not make the pane autosave it (the window takes the focus)");
  // every way of starting a message goes through startCompose; none opens the pane by itself any more
  for (const [file, never] of [["src/components/Ribbon.tsx", "openCompose("], ["src/components/CommandBar.tsx", "openCompose("], ["src/components/Attachments.tsx", "openCompose("], ["src/components/ReadingPane.tsx", ".openCompose("], ["src/actions.ts", "st.openCompose("]]) {
    assert.ok(!read(file).includes(never), `${file} starts a message with ${never}`);
  }
  const app = read("src/App.tsx");
  assert.ok(app.includes('case "c": case "C":') && app.includes('case "r": case "R":') && app.includes('case "a": case "A":') && app.includes('case "f": case "F":'), "Shift+C / R / A / F");
  assert.ok(app.includes("newMail({ shift: false })"), "the tray follows the setting only");
  assert.ok(app.includes("replyLast(undefined, { shift: false })"), "a notification's Reply follows the setting only");
  assert.ok(app.includes("startComposeHub()"));
  assert.ok(read("src/main.tsx").includes('if (route.kind === "main") installModifierTracking();'));
  // the reader answers in a compose window, whatever the setting says (REQ-R5)
  const mr = read("src/popout/mainRequests.ts");
  assert.ok(mr.includes("forward(m, thread, { window: true, shift: false })") && mr.includes("replyTo(m, p.req.mode === \"replyAll\", thread, { window: true, shift: false })"));
  // a draft: one editor, a double click or Shift+Enter opens a window
  const list = read("src/components/MessageList.tsx");
  assert.ok(list.includes('rowWindowTarget(folder, it.t.folder) === "draft" ? () => void openDraftInWindow('), "double click / Shift+Enter on a draft");
  const draftOpen = read("src/draftOpen.ts"); // (openDraftThread and its helpers moved out of Compose.tsx, WP9d)
  assert.ok(draftOpen.includes("if (await focusDraftWindow(key)) return true;") && draftOpen.includes("if (mine !== latestDraftOpen) return false;"));
  // W2.11: ONE check for every entry point, in openDraftThread, before anything is read: the draft the pane shows gets the focus and nothing else opens
  {
    const open = draftOpen.slice(draftOpen.indexOf("export async function openDraftThread("), draftOpen.indexOf("/** Counts the openings"));
    const at = (needle) => { const i = open.indexOf(needle); assert.ok(i >= 0, needle); return i; };
    assert.ok(at("if (inlineHasDraft(threadId)) return focusInlineEditor();") < at("if (await focusDraftWindow(key))") && at("focusDraftWindow(key)") < at("api.getThread("), "the pane is asked first, before a window and before the draft is read");
    assert.ok(compose.includes("noteInlineDraft(tid);"), "a save makes its new conversation the pane's too (an autosave replaces the draft)");
    assert.ok(draftOpen.includes("return !composeSeam() && !!st.compose && !!inlineDraft && inlineDraft.composeKey === st.composeKey && inlineDraft.tids.has(threadId);"), "a window has no pane");
    assert.ok(list.includes("if (!inlineHasDraft(t.threadId) && !wantsWindow({ shift }) && !(await useStore.getState().leaveCompose())) return;"), "a click on the row of the draft in the pane does not leave the pane first");
    // every other way to a draft ends in openDraftThread (the toast's Edit, the crash restore, the hub's Edit; Shift+Enter and the menu go through openDraftInWindow)
    assert.ok(read("src/composeRecovery.ts").includes("openDraftThread(threadId, true, o)") && read("src/popout/composeHub.ts").includes("openDraftThread(p.threadId, true)") && compose.includes("void openDraftThread(tid, true)"));
    assert.ok(draftOpen.includes("return openDraftThread(threadId, false, { window: true });"), "openDraftInWindow asks the same check");
    for (const f of ["src/components/CommandBar.tsx", "src/components/ListContextMenu.tsx", "src/components/Ribbon.tsx", "src/App.tsx"]) assert.ok(!read(f).includes("api.getThread(") || !read(f).includes("startCompose"), `${f} opens a draft by itself`);
  }
  // W2.10: Edit in the Scheduled list is a way of starting a message like the others, and a second Edit focuses the editor that has it
  {
    const sl = read("src/components/ScheduledList.tsx");
    assert.ok(sl.includes("}, { shift, key });") && sl.includes("startCompose({") && !sl.includes("openCompose("), "the Scheduled list starts the message through startCompose with an outbox: key");
    assert.ok(sl.indexOf("focusInlineEditor()") < sl.indexOf("focusDraftWindow(key)") && sl.indexOf("focusDraftWindow(key)") < sl.indexOf("api.outboxOpenForEdit("), "an editor that has the message is asked before the message is paused for edit");
    assert.ok(sl.includes("api.outboxRelease(o.id)"), "a message that could not be shown goes back to its schedule");
    assert.equal(outboxKey("ob1"), "outbox:ob1");
    const view = read("src/popout/ComposeView.tsx");
    assert.ok(view.includes("scheduled: held.current !== null") && view.includes("compose.leave.scheduledTitle") && view.includes("void releasePause().then(() => api.popoutDestroy()"), "the window asks the scheduled question and releases the pause as it ends");
    assert.ok(view.includes("scheduledHandled: () => {") && compose.includes("composeSeam()?.scheduledHandled();"), "a rescheduled / sent / deleted / moved message is not released");
    assert.ok(compose.includes("const done = beginSend(); // (a window ends when the last send of it is over)") && compose.includes("void openCompose(null, { sending: 0 }); // (a window waits for the send under way before it ends)"), "Schedule and Send now count as a send, so the window waits and ends");
    const cap = JSON.parse(read("src-tauri/capabilities/popout.json")).permissions;
    for (const c of ["allow-outbox-open-for-edit", "allow-outbox-update", "allow-outbox-release", "allow-outbox-to-draft", "allow-cancel-outbox", "allow-outbox-send-now"]) assert.ok(cap.includes(c), c);
    // the close table of a scheduled message
    const f = (o) => ({ phase: "edit", dirty: false, hasContent: true, attaching: false, scheduled: true, ...o });
    assert.equal(closeAction(f({})), "end", "nothing changed: closes, the schedule stays");
    assert.equal(closeAction(f({ hasContent: false })), "end");
    assert.equal(closeAction(f({ dirty: true })), "ask-scheduled", "changed: asked, whatever the content");
    assert.equal(closeAction(f({ dirty: true, hasContent: false })), "ask-scheduled");
    assert.equal(closeAction(f({ dirty: true, attaching: true })), "attaching");
    assert.equal(closeAction(f({ phase: "work", dirty: true })), "park");
    const log = [];
    const d = (answer) => ({ facts: () => f({ dirty: true }), ask: async () => (log.push("ask"), "save"), save: async () => (log.push("save"), true), askFailed: async () => "keep", discard: async () => void log.push("discard"), askScheduled: async () => (log.push("askScheduled"), answer), park() {}, end: () => void log.push("end"), attaching() {}, savedDraft: () => void log.push("savedDraft") });
    assert.equal(await runClose(d("keep")), "cancelled");
    assert.deepEqual(log.splice(0), ["askScheduled"], "Keep editing keeps everything: nothing saved, nothing ended");
    assert.equal(await runClose(d("discard")), "discarded");
    assert.deepEqual(log.splice(0), ["askScheduled", "end"], "Discard: the window ends (and releases the pause); no draft is saved, nothing is put back");
    // quit and update restart: changes are not saved, the pause is released, the schedule stays
    const fl = [];
    const fd = { phase: () => "edit", dirty: () => true, hasContent: () => true, scheduled: () => true, release: async () => void fl.push("release"), save: async () => (fl.push("save"), true), ask: async () => "keep", showWindow() {}, dialog() {}, discarded: async () => void fl.push("discarded"), flushSends: async () => void fl.push("flushSends") };
    assert.equal(await composeFlush(fd, "quit"), true);
    assert.deepEqual(fl, ["release"]);
  }
  // W2.12: a window answers to every key it was given (the registry keeps the reply key after a save)
  { const reg = read("src-tauri/src/popout.rs"); assert.ok(reg.includes("fn a_window_keeps_its_answer_key_after_a_save()") && reg.includes("pub keys: Vec<String>,") && reg.includes("keys: key.map(String::from).into_iter().collect()"), "popout.rs holds a list of keys"); }
  // the crash restore: a message written in a window comes back in one
  const rec = read("src/recovery.ts");
  assert.ok(rec.includes("inWindow: snapshotInWindow(l)") && rec.includes("const window = k.inWindow || undefined") && compose.includes("win: true as const"));
  // the support reminder counts a compose window as writing
  assert.ok(read("src/supportNudgeHost.ts").includes("composeWindowsOpen() > 0"));
  // the backend: the new commands are in the compose window's allowlist; the count and the hub
  const cap = JSON.parse(read("src-tauri/capabilities/popout.json")).permissions;
  for (const c of ["allow-popout-park", "allow-popout-destroy", "allow-popout-set-key", "allow-popout-request", "allow-cancel-outbox", "allow-save-draft", "allow-outbox-hold", "allow-outbox-hold-send", "allow-send-message"]) {
    assert.ok(cap.includes(c), c);
  }
  const hub = read("src/popout/composeHub.ts");
  assert.ok(hub.includes('listen<Envelope>("popout-request"') && hub.includes('listen<{ compose?: number; reader?: number }>("popout-count"') && hub.includes('startsWith("compose-")'), "only a compose window's requests");
  for (const f of ["src/popout/composeHub.ts", "src/popout/composeBridge.ts", "src/popout/ComposeView.tsx"]) {
    assert.ok(!/setSetting\(\s*["']prefs["']/.test(read(f)), `${f} writes the preferences`);
  }
}

// ---- one gesture opens one window (Mac QA 1.0.6 macfix2): the row decides reader or draft, and a repeated ask is the same ask
assert.equal(rowWindowTarget("inbox", "inbox"), "reader", "a received mail is read, never written");
assert.equal(rowWindowTarget("starred", "inbox"), "reader");
assert.equal(rowWindowTarget("all", "inbox"), "reader");
assert.equal(rowWindowTarget("sent", "sent"), "reader");
assert.equal(rowWindowTarget("drafts", "drafts"), "draft", "only the Drafts folder opens the compose window on a double click");
assert.equal(rowWindowTarget("all", "drafts"), "none", "a draft found in a cross-folder view opens nothing by double click");
assert.equal(rowWindowTarget("scheduled", "outbox"), "none");
for (const [view, folder] of [["inbox", "inbox"], ["unread", "inbox"], ["pinned", "inbox"], ["archive", "archive"], ["trash", "trash"], ["junk", "junk"]]) {
  assert.notEqual(rowWindowTarget(view, folder), "draft", `${view}/${folder}`);
}
{
  const c = new Coalescer(OPEN_COALESCE_MS);
  let made = 0;
  const open = (id, at) => c.run(id, at, () => ++made);
  const id = openId("reader", "thread-1");
  assert.equal(open(id, 1000), 1);
  assert.equal(open(id, 1260), 1, "the second click of a double click, 0.26 s later: the same window, nothing made");
  assert.equal(made, 1);
  assert.equal(open(openId("reader", "thread-2"), 1270), 2, "another conversation is another ask");
  assert.equal(open(openId("compose", "thread-1"), 1280), 3, "another kind is another ask");
  assert.equal(open(id, 1000 + OPEN_COALESCE_MS), 4, "a later ask is a new gesture");
  // a message without a key (New mail) is one ask too, and a failed ask may be repeated at once
  const n = openId("compose", null);
  assert.equal(n, "compose:-");
  assert.equal(open(n, 5000), 5);
  assert.equal(open(n, 5100), 5, "two quick clicks on New mail open one window");
  c.forget(n);
  assert.equal(open(n, 5150), 6, "after a refusal (too many windows) the person may try again");
  assert.equal(open(n, 5000 + OPEN_COALESCE_MS * 2), 7);
}
{
  const openTs = read("src/popout/open.ts");
  assert.ok(openTs.includes("asked.run(id, Date.now(), () => openOnce(") && openTs.includes("asked.forget(id)"), "every ask for a window goes through the coalescer");
  const list = read("src/components/MessageList.tsx");
  assert.ok(list.includes('rowWindowTarget(folder, it.t.folder) === "draft"') && list.includes('rowWindowTarget(folder, it.t.folder) === "reader"'), "the row's double click uses the one decision");
  const root = read("src/popout/PopoutRoot.tsx");
  assert.ok(root.includes('api.popoutNote("content"') && root.includes('window.addEventListener("error"') && root.includes('"unhandledrejection"'), "a page tells the log about its errors and that it drew");
  assert.ok(JSON.parse(read("src-tauri/capabilities/popout.json")).permissions.includes("allow-popout-note"));
}

// ---- W4.2: a window whose page process died is loaded again with its message, and ended with a message the second time
{
  const view = read("src/popout/ComposeView.tsx");
  assert.ok(view.includes("reloaded && handedRecovery") && view.includes("api.recoveryLoad(handedRecovery)") && view.includes("composeFromSnapshot(l)"), "the compose page restores its message from the snapshot when the init says it was reloaded");
  assert.ok(view.includes('recovery: (id) => void api.popoutNote("recovery", id)'), "the compose page tells the backend which snapshot is its message's");
  assert.ok(read("src/components/Compose.tsx").includes("composeSeam()?.recovery(recoveryId)"), "Compose reports its snapshot id through the seam");
  const root = read("src/popout/PopoutRoot.tsx");
  assert.ok(root.includes("reloaded: !!info.reloaded") && root.includes("recoveryId={known.recoveryId}"), "the view gets the reloaded flag and the snapshot id");
  const hub = read("src/popout/composeHub.ts");
  assert.ok(hub.includes('listen<{ label?: unknown; kind?: unknown; recoveryId?: unknown }>("popout-crashed"') && hub.includes('t("app.popout.crashed")') && hub.includes('setStickyToast("popout-crashed"') && hub.includes("recoverOne(p.recoveryId)"), "main says so and saves the message at once (the start-up recovery road)");
  assert.ok(hub.includes('p.kind === "compose"'), "only a compose window has a message to save");
  const rec = read("src/composeRecovery.ts");
  assert.ok(rec.includes("export async function recoverOne(") && rec.includes("(await api.recoveryList()).filter(pick)"), "one snapshot goes through the same settle road");
  // the toast text exists in all 8 languages (no raw key)
  const files = ["src/i18n/ns/app.ts", ...["de", "es", "fr", "ja", "ru", "vi", "zh-Hans"].map((l) => `src/i18n/locales/${l}/app.ts`)];
  for (const f of files) assert.ok(new RegExp('"app\.popout\.crashed": "[^"]{8,}"').test(read(f)), `${f} has app.popout.crashed`);
}

// ---- W4.4: Next / Previous conversation in a reader window
{
  const rows = [{ threadId: "A", folder: "inbox" }, { threadId: "B", folder: "inbox" }, { threadId: "C", folder: "inbox" }, { threadId: "D", folder: "drafts" }, { threadId: "E", folder: "inbox" }];
  const can = (r) => rowWindowTarget("all", r.folder) === "reader";
  assert.equal(neighborOf(rows, "B", 1, can).threadId, "C");
  assert.equal(neighborOf(rows, "B", -1, can).threadId, "A");
  assert.equal(neighborOf(rows, "A", -1, can), null, "no wrap at the start");
  assert.equal(neighborOf(rows, "E", 1, can), null, "no wrap at the end");
  assert.equal(neighborOf(rows, "C", 1, can).threadId, "E", "a draft row between C and E is skipped (AC-4.4.6)");
  assert.equal(neighborOf(rows, "E", -1, can).threadId, "C", "and skipped going back");
  assert.equal(neighborOf(rows, "nope", 1, can), null, "a conversation that is not in the list has no neighbours");
  assert.equal(neighborOf([{ threadId: "A", folder: "inbox" }, { threadId: "S", folder: "inbox" }], "A", 1, (r) => rowWindowTarget("scheduled", r.folder) === "reader"), null, "the Scheduled list has no rows a reader can show");
  assert.equal(neighborOf([], "A", 1, can), null);
  // what the main page answers, read defensively
  assert.deepEqual(neighborsOf(null), { prev: null, next: null });
  assert.deepEqual(neighborsOf({ prev: 5, next: { threadId: "" } }), { prev: null, next: null });
  assert.deepEqual(neighborsOf({ prev: { threadId: "X", accountId: "a1", folder: "inbox", subject: "S", view: "all" }, next: null }).prev, { threadId: "X", accountId: "a1", folder: "inbox", subject: "S", view: "all" });
  // the keys: j = next, k = previous, the guards of the other reader keys
  const key = (k, o = {}) => readerKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o }, { mac: false, inField: false, modalOpen: false });
  assert.equal(key("j"), "next");
  assert.equal(key("k"), "prev");
  assert.equal(key("J", { shiftKey: true }), null, "only j and k");
  assert.equal(key("j", { ctrlKey: true }), null);
  assert.equal(readerKey({ key: "j", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, { mac: false, inField: true, modalOpen: false }), null, "not while typing");
  assert.equal(readerKey({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, { mac: false, inField: false, modalOpen: true }), null, "not behind a dialog");
  assert.equal(allowedWhenGone("next"), false);
  assert.equal(allowedWhenGone("prev"), false);
  // the request: the conversation and where the window was opened from; nothing else is taken
  assert.deepEqual(parseRequest("neighbors", { threadId: "t1", view: "inbox", accountId: "a1", folder: "inbox", listAccount: null, extra: 1 }), { kind: "neighbors", req: { threadId: "t1", view: "inbox", accountId: "a1", folder: "inbox", listAccount: null } });
  assert.ok("error" in parseRequest("neighbors", {}), "no conversation");
  // wiring: the buttons come first in the toolbar, are icon-only, say why they are off, and the window shows the new conversation through popout_show
  const rv = read("src/popout/ReaderView.tsx");
  assert.ok(rv.indexOf('{navBtn("prev")}') < rv.indexOf('{rb("reply"') && rv.indexOf('{navBtn("next")}') < rv.indexOf('{rb("reply"'), "Previous and Next are before Reply");
  assert.ok(rv.includes('"reading.popout.noPrev"') && rv.includes('"reading.popout.noNext"') && rv.includes("api.popoutShow(n.threadId, next)"));
  const nav = rv.slice(rv.indexOf("const navBtn"), rv.indexOf("const sender = last"));
  assert.ok(nav.includes("<ChevronUp") && nav.includes("<ChevronDown") && !nav.includes("<span>"), "the buttons never show a word");
  assert.ok(rv.includes("<Reader key={info.threadId} info={info} onShow={setInfo} />"), "a new conversation starts the reader over (translations and summary cancelled, focus on the subject, scroll at the top)");
  assert.ok(JSON.parse(read("src-tauri/capabilities/popout.json")).permissions.includes("allow-popout-show"));
  const mr = read("src/popout/mainRequests.ts");
  assert.ok(mr.includes('case "neighbors":') && read("src/popout/mainLazy.ts").includes('rowWindowTarget(view, x.folder) === "reader"'));
  assert.ok(read("src/popout/openReader.ts").includes("listAccount: useStore.getState().accountId"), "the window is opened with the mailbox selection of the main window");
  // the main window's j / k row in Settings > Shortcuts stays the one row
  assert.equal((read("src/components/SettingsDialog.tsx").match(/"settings\.keys\.nextPrev"/g) ?? []).length, 1);
}

// ---- W4.5: move a compose window back to the main window
{
  assert.deepEqual(parseComposeRequest("cw-pop-in", { init: { subject: "S", to: ["a@b"] } }), { kind: "pop-in", init: { subject: "S", to: ["a@b"] } });
  assert.ok("error" in parseComposeRequest("cw-pop-in", {}), "no message");
  assert.ok("error" in parseComposeRequest("cw-pop-in", { init: "x" }));
  assert.deepEqual(parseComposeRequest("cw-pop-in-result", null), { kind: "pop-in-result" });
  const comp = read("src/components/Compose.tsx");
  assert.ok(comp.includes("SquareArrowDownLeft") && comp.includes('t("compose.popout.popIn")') && comp.includes('kbd(t("compose.popout.popInTip"))'), "the button, its name and its tooltip with the key");
  assert.ok(comp.includes("void (composeSeam() ? popIn() : popOut());"), "Ctrl+Shift+O: Pop out in the main window, Move to main window in a window");
  assert.ok(/!locked && !movingIn && !busy/.test(comp), "no button while Sending… or busy");
  assert.ok(comp.includes("initOf(buildDraft(), { replaces: replacesRef() ?? undefined, isReply: !!init.isReply, carried: touched.current || !!savedDraftRef.current })"), "the same mapping as Pop out");
  const view = read("src/popout/ComposeView.tsx");
  assert.ok(view.includes('requester.ask<{ state?: string; opened?: boolean } | null>("cw-pop-in", { init: moved }, 5000)') && view.includes('"cw-pop-in-result"'), "5 s for the main window, then as long as the question is open");
  assert.ok(view.includes("held.current = null;\n        raised.current = [];\n        await st.getState().composeEnd?.();"), "the window ends silently: the pause passes on, no toast is carried, its snapshot goes");
  const hub = read("src/popout/mainLazy.ts");
  assert.ok(read("src/popout/composeHub.ts").includes("m.popIn(env, p.init as ComposeInit)") && hub.includes("st.openCompose(init).then(() => useStore.getState().compose === init)") && hub.includes("showMain();"), "the main window comes forward and opens the message inline; the 'unsent' question is openCompose's own");
  assert.ok(read("src/popout/mainRequests.ts").includes("if (env.kind.startsWith(CW_PREFIX)) return;"), "the reader's handler does not answer a compose window's request");
  assert.ok(read("src/components/SettingsDialog.tsx").includes('["Ctrl+Shift+O", "settings.keys.popOutCompose"], ["Ctrl+Shift+O", "settings.keys.popInCompose"]'), "the Shortcuts row follows the Pop out row");
}

// ---- W4.6: the windows for events, Settings, search results and the Scheduled list
{
  // the router and the keys
  assert.equal(eventKey("e1"), "event:e1");
  assert.equal(eventKey(undefined), null, "a new event has no key");
  assert.equal(eventKey(""), null);
  assert.equal(SETTINGS_KEY, "settings");
  // the search window: what it is opened with, and its key (the same search focuses its window)
  const base = { search: "invoice", scope: "all", folder: "inbox", accountId: null, filter: "all" };
  assert.deepEqual(searchInit(base), base);
  assert.equal(searchInit({ ...base, search: "   " }), null, "no search, nothing to show");
  assert.equal(searchInit(null), null);
  assert.deepEqual(searchInit({ search: " from:bob  has:attachment ", scope: "nonsense", filter: "x", accountId: "" }), { search: "from:bob  has:attachment", scope: "current", folder: "inbox", accountId: null, filter: "all" });
  const k = (o) => searchKey({ ...base, ...o });
  assert.equal(k({}), k({ search: "  INVOICE " }), "case and outer spacing do not make another search");
  assert.equal(k({ search: "from:bob   urgent" }), k({ search: "from:bob urgent" }), "inner spacing neither");
  for (const other of [{ search: "invoices" }, { scope: "current" }, { scope: "account" }, { folder: "archive" }, { accountId: "a1" }, { filter: "unread" }]) assert.notEqual(k(other), k({}), JSON.stringify(other));
  // the preferences a window may ask the main page to change: the Settings window any key of Prefs, every other window the mail background only (REQ-4.6.3)
  const known = ["theme", "language", "accent", "mailCanvas", "density"];
  assert.equal(prefsPatchAllowed("settings-1", { theme: "dark", density: "compact" }, known), true);
  assert.equal(prefsPatchAllowed("settings-1", { notAPref: 1 }, known), false, "only keys of Prefs");
  assert.equal(prefsPatchAllowed("settings-1", {}, known), false);
  for (const w of ["reader-1", "compose-2", "event-1", "search-3", "scheduled-1", "main-x", ""]) {
    assert.equal(prefsPatchAllowed(w, { theme: "dark" }, known), false, w);
    assert.equal(prefsPatchAllowed(w, { mailCanvas: "dark", theme: "dark" }, known), false, w);
    assert.equal(prefsPatchAllowed(w, { mailCanvas: "original" }, known), true, w);
    assert.equal(prefsPatchAllowed(w, { mailCanvas: "blue" }, known), false, w);
  }
  // the same through the request parser (the main page's check), with who asks
  const ctx = (from) => ({ from, prefKeys: known });
  assert.deepEqual(parseRequest("prefs", { theme: "dark" }, ctx("settings-1")), { kind: "prefs", patch: { theme: "dark" } });
  assert.ok("error" in parseRequest("prefs", { theme: "dark" }, ctx("reader-1")));
  assert.deepEqual(parseRequest("prefs", { mailCanvas: "dark" }, ctx("reader-1")), { kind: "prefs", patch: { mailCanvas: "dark" } });
  assert.deepEqual(parseRequest("prefs", { mailCanvas: "dark" }), { kind: "prefs", patch: { mailCanvas: "dark" } }, "no context: the reader's rule");
  assert.deepEqual(parseRequest("toast", { text: " Event saved ", level: "success" }, ctx("event-2")), { kind: "toast", text: "Event saved", level: "success" });
  assert.ok("error" in parseRequest("toast", { text: "x" }, ctx("reader-1")), "only an event window raises a toast of its own");
  assert.ok("error" in parseRequest("toast", { text: " " }, ctx("event-1")));
  assert.deepEqual(parseRequest("update-restart", {}, ctx("settings-1")), { kind: "update-restart" });
  assert.ok("error" in parseRequest("update-restart", {}, ctx("compose-1")), "only the Settings window asks for the restart of an update");
  assert.deepEqual(parseRequest("refresh", {}), { kind: "refresh" });
  assert.deepEqual(parseRequest("sync", {}), { kind: "sync" });
  // where "open Settings" goes (REQ-4.6.9)
  assert.equal(settingsTarget(true), "window");
  assert.equal(settingsTarget(false), "dialog");
  assert.deepEqual(refocusOf({ tab: "ai", focus: "aiKey", nonce: 5 }), { tab: "ai", focus: "aiKey", section: undefined });
  assert.deepEqual(refocusOf({ tab: "mb:all", section: "filters" }), { tab: "mb:all", focus: undefined, section: "filters" });
  assert.deepEqual(refocusOf(null), { tab: undefined, focus: undefined, section: undefined });
  // the commands that tell the other windows (REQ-4.6.4): accounts, signatures, templates, rules, PGP keys, the calendar connections
  for (const c of ["add_account", "update_account", "remove_account", "save_signature", "delete_signature", "save_template", "delete_template", "save_rule", "delete_rule", "pgp_generate_key", "pgp_delete_key", "calendar_connect", "calendar_disconnect"]) assert.ok(DATA_CHANGING[c], c);
  assert.equal(DATA_CHANGING.add_account, "accounts");
  assert.ok(!("set_setting" in DATA_CHANGING) && !("get_thread" in DATA_CHANGING), "reads and the preferences do not tell anyone");
  assert.ok(read("src/api.ts").includes('if (what) void emit("data-changed"'), "api.ts tells every window after the command succeeded");

  // the wiring
  const store = read("src/store.ts");
  assert.ok(store.includes('settingsTarget(settingsWindowOpen()) === "window"') && store.includes('m.openPopout("settings", SETTINGS_KEY'), "setDialog sends Settings to the window while it exists");
  assert.ok(read("src/popout/popoutCount.ts").includes("settings: Math.max(0, Number(c?.settings) || 0)"), "the backend's count says whether the Settings window exists");
  const views = read("src/popout/views.tsx");
  for (const kind of ["event", "settings", "search", "scheduled"]) assert.ok(views.includes(`${kind}: lazyView({ key: "popout-${kind}"`), `${kind} has its lazy view`);
  const lazy = read("src/lazyViews.tsx");
  for (const m of ["EventView", "SettingsView", "SearchView", "ScheduledView"]) assert.ok(lazy.includes(`import("./popout/${m}")`), `${m} is imported in lazyViews.tsx only`);
  const budget = JSON.parse(read("scripts/bundle-budget.json"));
  for (const m of ["src/popout/EventView.tsx", "src/popout/SettingsView.tsx", "src/popout/SearchView.tsx", "src/popout/ScheduledView.tsx", "src/popout/mainLazy.ts", "src/dropMail.ts"]) assert.ok(budget.mustBeLazy.some((e) => e.module === m && e.since === "1.0.7"), `${m} must be lazy`);
  // a message started in a window of its own from a window (the Scheduled list, W4.6)
  assert.ok(read("src/popout/composeOpen.ts").includes("o.window ?? (inSecondaryWindow() ||"), "from a window a message always opens in a window");
  // the event window: Shift gestures and the buttons
  const cal = read("src/components/Calendar.tsx");
  // (W7.1: the key is read before the question about a series is asked; the window gets the part of the series and the occurrence)
  assert.ok(cal.includes('const alone = shiftNow();') && cal.includes('void openPopout("event", eventKey(ev.id, scope, occurrenceStart), { eventId: ev.id, scope, occurrenceStart });') && cal.includes('e.key === "Enter" && (e.ctrlKey || e.metaKey || (e.shiftKey && !e.altKey))'), "Shift+double-click and Shift+Enter open the event in a window");
  assert.ok(read("src/components/Ribbon.tsx").includes("e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey ? newEventWindow() : newEvent()"), "Shift+click on New event opens a window");
  assert.ok(cal.includes("headExtra={") && cal.includes('title={t("app.cmd.openInWindow")}'), "the event dialog has Open in new window");
  assert.ok(read("src/components/SettingsDialog.tsx").includes('openPopout("settings", SETTINGS_KEY, { tab, section: mbTab })'), "the Settings dialog has Open in new window, on the same tab and section");
  assert.ok(read("src/components/MessageList.tsx").includes('(searching || folder === "scheduled") && ('), "the list header has the button for the results of a search and for the Scheduled view");
  // the windows never write the preferences or set their own caption (W4.9)
  const kinds = [["EventView", "setPrefs: () => undefined"], ["SettingsView", 'askMain("prefs", patch, 15_000)']];
  for (const [f, needle] of kinds) assert.ok(read(`src/popout/${f}.tsx`).includes(needle), f);
  for (const f of ["EventView", "SearchView", "ScheduledView", "SettingsView"]) assert.ok(!read(`src/popout/${f}.tsx`).includes('api.setSetting("prefs"'), `${f} never writes prefs`);
  // Rust side in the three places
  assert.ok(read("src-tauri/src/popout.rs").includes("pub const KINDS: [Kind; 6]"));
  for (const cap of ["event", "search", "scheduled", "settings"]) assert.ok(JSON.parse(read(`src-tauri/capabilities/${cap}.json`)).windows[0] === `${cap}-*`, cap);
}

console.log("ok - test-popout");
