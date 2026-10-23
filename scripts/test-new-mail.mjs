// "New since you last looked" (1.0.7 W13.2, REQ-13.2.3 / 13.2.4): the rules of the session-only map in src/newMail.ts, and the wiring (the store, the window events, the side menu).
// Run: node --experimental-strip-types scripts/test-new-mail.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addArrivals, clearByCounts, clearOnFocus, clearOnOpen, hasNew, hasNewMailbox, isShown, newKey } from "../src/newMail.ts";

const arr = (accountId, ...folders) => ({ accountId, folders: folders.map(([folder, ...threads]) => ({ folder, threads })) });
const inFront = (folder, accountId, front = true) => ({ folder, accountId, front });

// 1. an arrival marks the folder (and the mailbox, through its Inbox) - REQ-13.2.5 / 13.2.6
let m = addArrivals({}, arr("A", ["inbox", "t1"], ["f:Projects", "t2"]), inFront("inbox", "B"), 1000);
assert.deepEqual(Object.keys(m).sort(), ["A|f:Projects", "A|inbox"]);
assert.ok(hasNew(m, "A", "inbox") && hasNew(m, "A", "f:Projects") && !hasNew(m, "B", "inbox"));
assert.ok(hasNewMailbox(m, "A"), "the Inbox marks the mailbox");
m = addArrivals({}, arr("A", ["f:Projects", "t2"]), inFront("inbox", "B"), 1000);
assert.ok(hasNew(m, "A", "f:Projects") && !hasNewMailbox(m, "A"), "only the Inbox marks the mailbox (AC-13.2.4)");

// 2. an arrival for the folder that is on screen while the window is in front is ignored; with the window behind (minimised, in the tray) it is marked (AC-13.2.2 / 13.2.3)
assert.deepEqual(addArrivals({}, arr("A", ["inbox", "t1"]), inFront("inbox", "A", true), 1), {});
assert.ok(hasNew(addArrivals({}, arr("A", ["inbox", "t1"]), inFront("inbox", "A", false), 1), "A", "inbox"));
assert.ok(hasNew(addArrivals({}, arr("A", ["inbox", "t1"]), inFront("inbox", "B", true), 1), "A", "inbox"), "another mailbox's Inbox is on screen");
assert.ok(hasNew(addArrivals({}, arr("A", ["f:Projects", "t1"]), inFront("inbox", "A", true), 1), "A", "f:Projects"), "another folder of the same mailbox");
// the "all mailboxes" Inbox shows every mailbox's Inbox; the Unread view shows no folder
assert.deepEqual(addArrivals({}, arr("A", ["inbox", "t1"]), inFront("inbox", null, true), 1), {});
assert.ok(hasNew(addArrivals({}, arr("A", ["inbox", "t1"]), inFront("unread", null, true), 1), "A", "inbox"));
assert.ok(hasNew(addArrivals({}, arr("A", ["f:Projects", "t1"]), inFront("f:Projects", null, true), 1), "A", "f:Projects"), "a folder is never an all-mailboxes view");
assert.ok(isShown("A", "inbox", { folder: "inbox", accountId: null }) && !isShown("A", "inbox", { folder: "unread", accountId: null }));

// 3. clearing: opening the folder (side menu, Favorites, keyboard) - REQ-13.2.4 a
const both = addArrivals(addArrivals({}, arr("A", ["inbox", "t1"]), inFront("x", "B"), 1), arr("B", ["inbox", "t9"], ["f:X", "t3"]), inFront("x", "B"), 2);
assert.deepEqual(Object.keys(clearOnOpen(both, "inbox", "A")).sort(), ["B|f:X", "B|inbox"], "A's Inbox opened: A's marker goes");
assert.deepEqual(Object.keys(clearOnOpen(both, "inbox", null)), ["B|f:X"], "the all-mailboxes Inbox clears every Inbox marker, not the folders");
assert.deepEqual(Object.keys(clearOnOpen(both, "unread", null)).sort(), ["A|inbox", "B|f:X", "B|inbox"], "the Unread view clears nothing");
assert.deepEqual(Object.keys(clearOnOpen(both, "starred", null)).length, 3);
assert.equal(clearOnOpen(both, "archive", "A"), both, "nothing to clear: the same object (no re-render)");
// the window comes to the front with the folder on screen - b
assert.deepEqual(Object.keys(clearOnFocus(both, "inbox", "B")).sort(), ["A|inbox", "B|f:X"]);

// 4. the unread count becomes 0 - c; an arrival noted after the read of the counts began is newer and stays
const counts = (...rows) => rows.map(([accountId, key, unread]) => ({ accountId, key, unread }));
assert.deepEqual(Object.keys(clearByCounts(both, counts(["A", "inbox", 0], ["B", "inbox", 4], ["B", "f:X", 0]), 10)), ["B|inbox"]);
assert.deepEqual(Object.keys(clearByCounts(both, counts(["A", "inbox", 0], ["B", "inbox", 0]), 0)).sort(), ["A|inbox", "B|f:X", "B|inbox"], "A's arrival (at 1) and B's (at 2) came after a read that began at 0: their counts are older, nothing clears");
assert.deepEqual(Object.keys(clearByCounts(both, counts(["A", "inbox", 0], ["B", "inbox", 0]), 1)).sort(), ["B|f:X", "B|inbox"], "a read that began at 1 knows A's arrival (at 1) but not B's (at 2)");
assert.equal(clearByCounts(both, counts(["C", "inbox", 0]), 9), both, "a folder the list does not name keeps its marker");
assert.equal(clearByCounts(both, [], 9), both);

// 5. more arrivals add threads without repeating them and keep the first marker alive
const more = addArrivals(m, arr("A", ["f:Projects", "t2", "t3"]), inFront("inbox", "B"), 5);
assert.deepEqual(more["A|f:Projects"].threads, ["t2", "t3"]);
assert.equal(more["A|f:Projects"].at, 5);
assert.equal(newKey("A", "inbox"), "A|inbox");
assert.deepEqual(addArrivals({}, arr("A", ["inbox"]), inFront("x", "B"), 1), {}, "no thread, no marker");

// 6. nothing is stored: no localStorage / prefs / database call in the module (session only, REQ-13.2.3)
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const mod = read("src/newMail.ts");
assert.ok(!/localStorage|sessionStorage|setPrefs|invoke\(|api\./.test(mod.replace(/\/\/.*$/gm, "")), "the map is not stored");

// 7. the wiring: the store clears on a view change and by the counts of the folder list, the window wire listens for the arrivals and the window coming forward, the side menu draws the marker
const store = read("src/store.ts");
assert.ok(/newMail: clearOnOpen\(get\(\)\.newMail, folder, accountId\)/.test(store), "setView clears the opened folder");
assert.ok(/clearByCounts\(s\.newMail, folders, readAt\)/.test(store) && /const readAt = Date\.now\(\);/.test(store), "the folder list clears by the counts, with the time the read began");
const wire = read("src/newMailWire.ts");
assert.ok(/listen<Arrivals>\("mail-arrived"/.test(wire) && /noteArrivals\(e\.payload, windowInFront\(\)\)/.test(wire), "mail-arrived");
assert.ok(/addEventListener\("focus"/.test(wire) && /visibilitychange/.test(wire) && /"app-shown"/.test(wire), "the window coming forward");
assert.ok(/windowInFront = \(\): boolean => document\.visibilityState === "visible" && document\.hasFocus\(\)/.test(wire), "in front = visible and focused");
assert.ok(/watchNewMail\(\)/.test(read("src/App.tsx")), "App starts it");
const pane = read("src/components/FolderPane.tsx");
assert.ok(/hasNew\(newMail, acct, key\)/.test(pane) && /fp-new/.test(pane) && /hasNewMailbox\(newMail, a\.id\)/.test(pane), "the side menu");
assert.ok((pane.match(/mail\.side\.newMail/g) ?? []).length >= 3, "tooltip / name / hidden text use the agreed key");
const css = read("src/App.css");
assert.ok(/\.fp-new \{[^}]*width: 8px; height: 8px; border-radius: 50%; background: var\(--accent-text\)/.test(css), "an 8 px circle in --accent-text");
assert.ok(/\.fp-row\.fresh \.fp-lbl \{ font-weight: 650/.test(css), "weight 650");
assert.ok(/forced-colors: active\) \{[^}]*\.fp-new \{ background: CanvasText/.test(css.replace(/\s+/g, " ")), "forced colors: CanvasText");
assert.ok(!/@keyframes fp-new-in \{[^}]*\}\s*\{[^}]*infinite/.test(css) && !/\.fp-new[^{]*\{[^}]*infinite/.test(css), "no blinking or pulsing");
console.log("test-new-mail: ok");
