// A click on a notification opens the message wherever it is (1.0.7 D-051): the decision (src/notifyOpen.ts planOpen) and the pieces that carry it.
// Run: node --experimental-strip-types scripts/test-notify-plan.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planOpen } from "../src/notifyOpen.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const home = (over = {}) => ({ accountId: "a1", folder: "inbox", focused: true, other: false, ...over });
const view = (over = {}) => ({ folder: "inbox", accountId: null, search: "", filter: "all", focus: "focused", focusedInbox: true, ...over });

// the bulk message of the unified Inbox with Focused open: the Other tab, no other change
assert.deepEqual(planOpen(home({ focused: false, other: true }), view()), { view: null, focus: "other", clearFilter: false });
// the same from the Other tab: it stays
assert.deepEqual(planOpen(home({ focused: false, other: true }), view({ focus: "other" })), { view: null, focus: "other", clearFilter: false });
// a normal message while the Other tab is open: back to Focused
assert.equal(planOpen(home(), view({ focus: "other" })).focus, "focused");
// a conversation of both kinds: the tab the person is in stays
assert.equal(planOpen(home({ focused: true, other: true }), view({ focus: "other" })).focus, "other");
assert.equal(planOpen(home({ focused: true, other: true }), view({ focus: "focused" })).focus, "focused");
// Focused Inbox off: the Inbox has no tabs
assert.equal(planOpen(home({ focused: false, other: true }), view({ focusedInbox: false })).focus, null);
// another mailbox: the open mailbox is the unified Inbox -> stays; the Inbox of one mailbox that is not it -> that mailbox's Inbox
assert.equal(planOpen(home({ accountId: "a2" }), view()).view, null);
assert.deepEqual(planOpen(home({ accountId: "a2" }), view({ accountId: "a1" })).view, { folder: "inbox", accountId: "a2" });
assert.equal(planOpen(home({ accountId: "a2" }), view({ accountId: "a2" })).view, null);
// another folder (Snoozed, Archive, a folder of its own): that folder, no tab
assert.deepEqual(planOpen(home({ folder: "snoozed", focused: false }), view()), { view: { folder: "snoozed", accountId: "a1" }, focus: null, clearFilter: false });
assert.deepEqual(planOpen(home({ folder: "f:Clients/Acme", focused: false }), view({ folder: "archive", accountId: "a1" })).view, { folder: "f:Clients/Acme", accountId: "a1" });
// a search is left (the list of a search does not have it), a filter is flagged for clearing
assert.deepEqual(planOpen(home(), view({ search: "invoice" })).view, { folder: "inbox", accountId: "a1" });
assert.equal(planOpen(home(), view({ search: "   " })).view, null, "blank text is no search");
assert.equal(planOpen(home(), view({ filter: "unread" })).clearFilter, true);
// the Unread quick view is not the Inbox: the Inbox is shown
assert.deepEqual(planOpen(home(), view({ folder: "unread" })).view, { folder: "inbox", accountId: "a1" });

// the pieces: the page asks the backend where it lives, App hands the click to the store, the store does the steps in this order
const app = read("src/App.tsx");
assert.match(app, /const open = \(threadId: string\) => useStore\.getState\(\)\.openNotified\(threadId\);/);
assert.match(app, /if \(await open\(e\.payload\.threadId\)\) replyLast\(/, "Reply from a toast replies only to a conversation that opened");
const store = read("src/store.ts");
const at = store.indexOf("openNotified: async (id) => {");
assert.ok(at > 0);
const body = store.slice(at, store.indexOf("leaveCompose: () =>", at));
const order = ["popoutOpen(\"reader\", id, null, true)", "api.locateThread(id)", "planOpen(home", "get().setView(plan.view.folder", "get().setFocus(plan.focus)", "get().setFilter(\"all\")", "get().openMail(id)"].map((s) => body.indexOf(s));
assert.ok(order.every((i) => i > 0), `a step is missing: ${order}`);
assert.deepEqual([...order].sort((a, b) => a - b), order, "the steps are in order: a window of its own, locate, view, tab, filter, open");
assert.match(body, /t\("reading\.popout\.gone"\)/, "a conversation that is gone says so with the words the reader window already has");
assert.match(read("src/api.ts"), /locateThread: \(threadId: string\) => invoke<ThreadHome \| null>\("locate_thread", \{ threadId \}\)/);
// the command is registered, allowed to the main window, and nothing else changed there
assert.match(read("src-tauri/src/lib.rs"), /fn locate_thread\(state: tauri::State<AppState>, thread_id: String\) -> Option<ThreadHome>/);
assert.match(read("src-tauri/src/lib.rs"), /list_threads,\n\s+locate_thread,/);
assert.match(read("src-tauri/build.rs"), /"list_threads", "locate_thread"/);
assert.match(read("src-tauri/capabilities/default.json"), /"allow-locate-thread"/);
assert.ok(!/locate_thread|locate-thread/.test(read("src-tauri/capabilities/popout.json")), "the secondary windows do not ask where a conversation lives");

console.log("ok - test-notify-plan");
