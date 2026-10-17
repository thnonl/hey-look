// Secondary windows ("pop-outs"), the foundation (src/popout/*, src/main.tsx): which window a page is in, the title, the dev flag, the
// rule "the setting says what a click does, Shift does the opposite", and guards on how the pieces are wired. The window manager itself is
// tested in Rust (src-tauri/src/popout.rs); the quit protocol in scripts/test-quit-flush.mjs.
// Run: node --experimental-strip-types scripts/test-popout.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { isPopout, popoutDevEnabled, popoutTitle, routeOf } from "../src/popout/route.ts";
import { answerKey, draftKey, opensInWindow, shiftOnly } from "../src/popout/entry.ts";
import { MODIFIER_WINDOW_MS, noteInput, resetModifier, shiftNow } from "../src/popout/modifier.ts";
import { closeAction, composeFlush, GRACE_MS, runClose, secondsLeft, START, step, UNDO_SETTLE_MS } from "../src/popout/composeWindow.ts";
import { carryToasts, parseComposeRequest } from "../src/popout/composeRequests.ts";
import {
  allowedWhenGone, isFlagged, isGone, isUnread, markReadPlan, readerAllowed, readerInit, readerKey, readerTitleText, scopeOfView, threadScope, withWanted,
} from "../src/popout/readerLogic.ts";
import { Requester, UNREACHABLE } from "../src/popout/request.ts";
import { parseRequest, READER_ACTIONS, READER_LABELS } from "../src/popout/requestKinds.ts";

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
for (const bad of ["settings", "Compose", "compose-1", "main2", "../x", "reader%20"]) {
  const r = routeOf(`?w=${bad}`);
  assert.equal(r.kind, "invalid", bad);
  assert.equal(isPopout(r), false);
}
assert.equal(isPopout(routeOf("?w=compose&t=1")), true);
assert.equal(isPopout(routeOf("?w=reader&t=1")), true);
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
  assert.ok(/export const VIEWS: Record<PopoutKind,/.test(views) && views.includes("compose: ComposeView") && views.includes("reader: ReaderView"));
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
assert.deepEqual(readerInit({ threadId: "t1", accountId: "a1", folder: "inbox", view: "starred", subject: "Hi" }), { threadId: "t1", accountId: "a1", folder: "inbox", view: "starred", subject: "Hi" });
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
  assert.equal(readerKey(k("p", { metaKey: true }), ctx({ mac: true })), null, "no Print on macOS");
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
  // answers
  const msg = { id: "m1", subject: "Hi" };
  assert.equal(ok("compose", { mode: "replyAll", message: msg, threadMessageIds: ["<a@b>", null, 5] }).req.threadMessageIds.length, 2, "only Message-IDs travel");
  bad("compose", { mode: "send", message: msg });
  bad("compose", { mode: "reply" });
  bad("compose", { mode: "reply", message: {} });
  assert.equal(ok("compose-new", { init: { accountId: "a1", subject: "unsubscribe", to: ["x@y.z"], attachments: [{ filename: "f.txt", mime: "text/plain", dataBase64: "QQ==" }, { filename: "", dataBase64: "QQ==" }] } }).req.attachments.length, 1);
  bad("compose-new", { init: { subject: "x" } });
  // dialogs: Settings, the event dialog and the PGP key dialogs; not the cleaner, not a dialog of the reader
  assert.equal(ok("dialog", { dialog: { type: "settings", tab: "ai" } }).req.tab, "ai");
  assert.equal(ok("dialog", { dialog: { type: "event", init: { summary: "x" } } }).req.type, "event");
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
  assert.ok(root.includes("useStore.setState({ prefs: p })") && root.includes("getCurrentWindow().setTheme("), "the root fills the preferences of the window's store and the title bar follows the theme (REQ-W8)");
  const views = read("src/popout/views.tsx");
  assert.ok(views.includes("reader: ReaderView,") && views.includes("compose: ComposeView,"), "the reader and the compose window are plugged in");
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
  assert.equal(cmd.get("getThread"), "get_thread");
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
  assert.ok(reader.includes("<GuardMenuHost />") && reader.includes("await loadPlatform()"), "the in-app menu host is mounted and the platform (debug build or not) is known");
  assert.ok(!reader.includes("<iframe"), "the reader draws its frames only through the reading-pane components");
  assert.ok(reader.includes("<MessageCard"), "the message body is the reading pane's MessageBody");
  // those components guard their frames: the message body, and the attachment preview (PDF / text)
  assert.ok(read("src/components/ReadingPane.tsx").includes("lockedNow.current ? undefined : guardFrame(frame, doc)"), "message frame guarded (confidential mail has no menu at all: lockDocument)");
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
  assert.ok(view.includes("api.popoutDestroy()") && view.includes("api.popoutPark()"));
  assert.ok(view.includes("registerFlushHandler(") && view.includes("composeFlush("), "a quit and an update restart ask the window");
  assert.ok(view.includes("<PassphraseHost />") && view.includes("<GuardMenuHost />"), "the passphrase question and the in-app menu are drawn in this window");
  // the store actions that mean something else in a window are replaced before Compose is drawn
  for (const a of ["openCompose:", "sync:", "refresh:", "setDialog:", "showToast:"]) assert.ok(view.includes(a), a);
  assert.ok(view.indexOf("setReady(true)") > view.indexOf("openCompose:"), "Compose is drawn after the actions are replaced");
  // Compose.tsx: the seam is the only difference, and the main window (no seam) behaves as before
  assert.equal(compose.match(/composeSeam\(\)/g).length, 8, "the places where Compose asks the seam");
  assert.ok(compose.includes("openCompose(null, { sending: wait })") && compose.includes("openCompose(null, { sending: 0 })"), "a send hands the message over, it does not end it");
  assert.ok(compose.includes('else showToast(() => t("compose.toast.sending"), undoSend, "info")'), "the main window still has the Undo toast");
  assert.ok(compose.includes("if (init.outboxId || composeSeam() || busy) return;"), "no pop-out of a scheduled message or from a window");
  assert.ok(compose.includes('e.key.toLowerCase() === "o"') && compose.includes("compose.popout.popOutTip"), "Ctrl+Shift+O and the button");
  assert.ok(compose.includes("init.recoveryId || init.carried"), "a moved message counts as changed");
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
  assert.ok(list.includes('folder === "drafts" ? () => void openDraftInWindow('), "double click / Shift+Enter on a draft");
  assert.ok(compose.includes("if (await focusDraftWindow(key)) return true;") && compose.includes("if (mine !== latestDraftOpen) return false;"));
  // the crash restore: a message written in a window comes back in one
  const rec = read("src/composeRecovery.ts");
  assert.ok(rec.includes("snapshotInWindow(l)") && compose.includes("win: true as const"));
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

console.log("ok - test-popout");
