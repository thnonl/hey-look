// The right-click menu of a mail list row (v1.0.6): which conversations it acts on, which entries it has and which of them are off,
// where it opens, and what the keys do. Rules of src/rowMenu.ts and src/contextMenu.ts; the last part checks the screens use them.
// Run: node --experimental-strip-types scripts/test-row-menu.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextTargets, moveChoices, rowMenu, senderOf } from "../src/rowMenu.ts";
import { isContextMenuKey, isKeyEcho, menuKey, placeAtPoint, placeBeside, typeAhead } from "../src/contextMenu.ts";

const order = ["a", "b", "c", "d", "e"];

// 1. targets: a row of the selection acts with the whole selection; any other row becomes the selection first
assert.deepEqual(contextTargets("c", new Set(["e", "a", "c"]), null, order), { ids: ["a", "c", "e"], makeSelection: false }, "the checked rows, in list order");
assert.deepEqual(contextTargets("b", new Set(["a", "c"]), "a", order), { ids: ["b"], makeSelection: true }, "a row outside the selection: only that row");
assert.deepEqual(contextTargets("b", new Set(), null, order), { ids: ["b"], makeSelection: true }, "nothing selected: that row is selected, not opened");
assert.deepEqual(contextTargets("b", new Set(), "b", order), { ids: ["b"], makeSelection: false }, "the open conversation is the selection already");
assert.deepEqual(contextTargets("b", new Set(), "a", order), { ids: ["b"], makeSelection: true }, "another conversation is open: the clicked one is selected, the open one stays open");
assert.deepEqual(contextTargets("b", new Set(["b", "zz"]), null, order).ids, ["b", "zz"], "a checked row that left the list goes last");

// 2. entries
const th = (threadId, over = {}) => ({ threadId, accountId: "a1", unread: 0, flagged: false, pinned: false, ...over });
const KEYS = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
const folders = [...KEYS.map((key) => ({ accountId: "a1", key, name: key, listed: true })), ...KEYS.map((key) => ({ accountId: "a2", key, name: key, listed: key !== "junk" }))];
const byAction = (items) => Object.fromEntries(items.filter((x) => x !== "-").map((x) => [x.action, x]));
const ids = (items) => items.filter((x) => x !== "-").map((x) => x.action);
const ORDER = ["reply", "replyAll", "forward", "read", "flag", "pin", "snooze", "move", "archive", "delete", "junk", "copySender", "copySubject"];

let m = rowMenu([th("a")], { view: "inbox", folders });
assert.deepEqual(ids(m), ORDER, "the entries and their order");
assert.deepEqual(m.map((x) => (x === "-" ? "-" : "e")).join(""), "eee-eeeee-eee-ee", "four groups: answer | state | file away | copy");
assert.ok(m.filter((x) => x !== "-").every((x) => !x.off), "one conversation in the inbox: nothing is off");
assert.equal(byAction(m).read.variant, "markUnread", "a read conversation offers 'Mark as unread'");
assert.equal(byAction(m).flag.variant, "flag");
assert.equal(byAction(m).pin.variant, "pin");
assert.equal(byAction(m).delete.variant, "trash");

// state labels follow the state
m = byAction(rowMenu([th("a", { unread: 2, flagged: true, pinned: true })], { view: "inbox", folders }));
assert.equal(m.read.variant, "markRead");
assert.equal(m.flag.variant, "unflag");
assert.equal(m.pin.variant, "unpin");
// several: any unread -> 'Mark as read'; 'Remove flag' / 'Unpin' only when all of them have it
m = byAction(rowMenu([th("a", { flagged: true }), th("b", { unread: 1 })], { view: "inbox", folders }));
assert.equal(m.read.variant, "markRead");
assert.equal(m.flag.variant, "flag", "one is not flagged: flag them all");
m = byAction(rowMenu([th("a", { flagged: true, pinned: true }), th("b", { flagged: true, pinned: true })], { view: "inbox", folders }));
assert.equal(m.flag.variant, "unflag");
assert.equal(m.pin.variant, "unpin");

// several conversations: answer / copy entries are off, the rest acts on all
m = byAction(rowMenu([th("a"), th("b")], { view: "inbox", folders }));
for (const k of ["reply", "replyAll", "forward", "copySender", "copySubject"]) assert.equal(m[k].off, "many", `${k} needs one conversation`);
for (const k of ["read", "flag", "pin", "snooze", "move", "archive", "delete", "junk"]) assert.ok(!m[k].off, `${k} works on several`);

// Move to: one mailbox only
m = byAction(rowMenu([th("a"), th("b", { accountId: "a2" })], { view: "inbox", folders }));
assert.equal(m.move.off, "mailbox");
// Junk: off when a mailbox of the selection has no Junk folder (the Report menu's rule); the others stay
m = byAction(rowMenu([th("a", { accountId: "a2" })], { view: "inbox", folders }));
assert.equal(m.junk.off, "junk");
assert.ok(!m.archive.off && !m.move.off);
m = byAction(rowMenu([th("a"), th("b", { accountId: "a2" })], { view: "inbox", folders }));
assert.equal(m.junk.off, "junk", "one of two mailboxes has no Junk");
// Drafts are edited, not answered
m = byAction(rowMenu([th("a")], { view: "drafts", folders }));
for (const k of ["reply", "replyAll", "forward"]) assert.equal(m[k].off, "draft");
// confidential mail cannot be forwarded (the ribbon's rule); it can be answered
m = byAction(rowMenu([th("a", { confidential: true })], { view: "inbox", folders }));
assert.equal(m.forward.off, "confidential");
assert.ok(!m.reply.off && !m.replyAll.off);
// Deleted Items: delete is permanent
assert.equal(byAction(rowMenu([th("a")], { view: "trash", folders })).delete.variant, "permanent");

// 3. Move to: the ribbon's choices
const named = folders.map((f) => ({ ...f, name: f.key }));
assert.deepEqual(moveChoices(named, "a1", "inbox").map((f) => f.key), ["archive", "junk", "trash"], "not the open folder, not Drafts / Sent");
assert.deepEqual(moveChoices(named, "a2", "inbox").map((f) => f.key), ["archive", "trash"], "no Junk where the mailbox has none");
assert.deepEqual(moveChoices(named, "a1", undefined).map((f) => f.key), ["inbox", "archive", "junk", "trash"], "a quick view has no folder of its own");
assert.deepEqual(moveChoices(named, "zz", "inbox"), []);

// 4. Copy sender address
const mine = new Set(["me@x.com"]);
assert.equal(senderOf([{ fromEmail: "Li@x.com" }, { fromEmail: "me@x.com" }], mine), "Li@x.com", "the latest message from someone else");
assert.equal(senderOf([{ fromEmail: "me@x.com" }], mine), "me@x.com", "a conversation you started");
assert.equal(senderOf([], mine), null);

// 5. placement: next to the pointer; flipped at the right / bottom edge; scrollable when it fits nowhere
const vw = 960, vh = 560, size = { w: 220, h: 300 };
let p = placeAtPoint(100, 100, size, vw, vh);
assert.deepEqual(p, { left: 100, top: 100, maxHeight: null }, "room: down and right of the pointer");
p = placeAtPoint(900, 100, size, vw, vh);
assert.equal(p.left, 900 - 220, "no room on the right: opens to the left of the pointer");
p = placeAtPoint(100, 500, size, vw, vh);
assert.equal(p.top, 500 - 300, "no room below: opens upward");
assert.equal(p.maxHeight, null);
p = placeAtPoint(950, 555, size, vw, vh);
assert.ok(p.left >= 6 && p.left + 220 <= vw - 6 && p.top >= 6 && p.top + 300 <= vh - 6, "the corner: kept inside the window");
// neither side has room, the window does: slid up so all of it shows
p = placeAtPoint(100, 280, { w: 220, h: 450 }, vw, vh);
assert.deepEqual(p, { left: 100, top: vh - 6 - 450, maxHeight: null }, "slid up, no scrolling");
// taller than the window: the roomier side, limited and scrollable, never off-screen
p = placeAtPoint(100, 200, { w: 220, h: 700 }, vw, vh);
assert.ok(p.maxHeight !== null && p.top >= 6 && p.top + p.maxHeight <= vh - 6 + 0.5, `tall menu is limited: ${JSON.stringify(p)}`);
p = placeAtPoint(100, 400, { w: 220, h: 700 }, vw, vh);
assert.ok(p.maxHeight !== null && p.top >= 6 && p.top + p.maxHeight <= vh - 6 + 0.5, `tall menu near the bottom: ${JSON.stringify(p)}`);
// a window narrower than the menu: the left edge wins
p = placeAtPoint(50, 50, { w: 400, h: 100 }, 300, 560);
assert.equal(p.left, 6);
// submenu: right of the parent row, left when there is no room, level with the row, up when it would leave the window
let s = placeBeside({ left: 100, right: 320, top: 80 }, { w: 180, h: 200 }, vw, vh);
assert.deepEqual(s, { left: 318, top: 75, maxHeight: null });
s = placeBeside({ left: 700, right: 920, top: 80 }, { w: 180, h: 200 }, vw, vh);
assert.equal(s.left, 702 - 180, "flips to the left of the menu");
s = placeBeside({ left: 100, right: 320, top: 500 }, { w: 180, h: 200 }, vw, vh);
assert.ok(s.top + 200 <= vh - 6, "moved up");

// 6. keys
assert.deepEqual(menuKey("ArrowDown", -1, 4, false, false), { kind: "focus", index: 0 });
assert.deepEqual(menuKey("ArrowDown", 3, 4, false, false), { kind: "focus", index: 0 }, "wraps");
assert.deepEqual(menuKey("ArrowUp", 0, 4, false, false), { kind: "focus", index: 3 }, "wraps");
assert.deepEqual(menuKey("ArrowUp", -1, 4, false, false), { kind: "focus", index: 3 });
assert.deepEqual(menuKey("Home", 2, 4, false, false), { kind: "focus", index: 0 });
assert.deepEqual(menuKey("End", 2, 4, false, false), { kind: "focus", index: 3 });
assert.deepEqual(menuKey("Enter", 1, 4, false, false), { kind: "activate" });
assert.deepEqual(menuKey(" ", 1, 4, false, false), { kind: "activate" });
assert.deepEqual(menuKey("Enter", 1, 4, true, false), { kind: "open-sub" }, "Enter on a row with a flyout opens it");
assert.deepEqual(menuKey("ArrowRight", 1, 4, true, false), { kind: "open-sub" });
assert.equal(menuKey("ArrowRight", 1, 4, false, false), null);
assert.deepEqual(menuKey("ArrowLeft", 0, 4, false, true), { kind: "close-sub" });
assert.equal(menuKey("ArrowLeft", 0, 4, false, false), null);
assert.deepEqual(menuKey("Escape", 0, 4, false, true), { kind: "close-sub" }, "Escape closes the flyout first");
assert.deepEqual(menuKey("Escape", 0, 4, false, false), { kind: "close" });
assert.deepEqual(menuKey("Tab", 0, 4, false, false), { kind: "close" });
assert.equal(menuKey("x", 0, 4, false, false), null);
assert.deepEqual(menuKey("Escape", -1, 0, false, false), { kind: "close" }, "an empty menu still closes");
assert.equal(typeAhead(["Reply", "Reply all", "Forward", "Éditer"], "f", 0), 2);
assert.equal(typeAhead(["Reply", "Reply all", "Forward", "Éditer"], "e", 0), 3, "accents ignored");
assert.equal(typeAhead(["Reply", "Reply all"], "reply a", -1), 1);
assert.equal(typeAhead(["Reply"], "z", 0), -1);
assert.equal(isContextMenuKey({ key: "ContextMenu", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), true);
assert.equal(isContextMenuKey({ key: "F10", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }), true);
assert.equal(isContextMenuKey({ key: "F10", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), false);
assert.equal(isContextMenuKey({ key: "F10", shiftKey: true, ctrlKey: true, altKey: false, metaKey: false }), false);
assert.equal(isKeyEcho(1000, 1200), true, "the contextmenu event right after the key press is its echo");
assert.equal(isKeyEcho(1000, 2000), false);
assert.equal(isKeyEcho(0, 100), false, "no key press: a real right-click");

// 7. the screens use them
const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const list = read("components/MessageList.tsx");
assert.ok(/useRowContextMenu\(\)/.test(list) && /\{\.\.\.ctxMenu\.handlers\}/.test(list) && /\{ctxMenu\.menu\}/.test(list), "the list wires the row menu");
const hook = read("components/ListContextMenu.tsx");
for (const call of ['act(ids, "read")', 'act(ids, "unread")', 'act(ids, "star")', 'act(ids, "unstar")', 'act(ids, "pin")', 'act(ids, "unpin")', 'act(ids, "archive"', 'act(ids, "trash"', 'act(ids, "junk"', 'act(ids, "move"', 'act(ids, "snooze"'])
  assert.ok(hook.includes(call), `the menu runs the store action ${call} (same path as the ribbon)`);
assert.ok(/isContextMenuKey\(e\)/.test(hook) && /isKeyEcho\(/.test(hook), "ContextMenu key / Shift+F10 open it");
assert.ok(/returnTo=\{open\.row\}/.test(hook), "focus goes back to the row");
const menu = read("components/ContextMenu.tsx");
assert.ok(/role="menu"/.test(menu) && /role="menuitem"/.test(menu) && /aria-disabled=/.test(menu), "menu roles");
for (const ev of ['"mousedown"', '"scroll"', '"resize"', '"blur"']) assert.ok(menu.includes(ev), `closes on ${ev}`);
const ribbon = read("components/Ribbon.tsx");
assert.ok(/moveChoices\(/.test(ribbon), "the ribbon's Move to menu and the row menu share one rule");

console.log("row context menu rules: ok");
