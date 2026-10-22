// The unread numbers on the Focused / Other tabs (1.0.7 W13.12): the pure helpers of src/focusCounts.ts and that the pieces are wired.
//   - tabCounts: one mailbox, every mailbox (Favorites > Inbox), only Inbox rows count, a missing field is 0;
//   - badgeText: 0 gives nothing, 1 to 99 digits, above 99 "99+", plain ASCII digits;
//   - tabLabels: no accessible name and no tooltip at 0, both with the exact number above 99;
//   - withUnreadChange (the optimistic change, applyOptimistic in store.ts): the tab number of the conversation's kind changes, the side-menu number only
//     when that conversation is counted there, never below 0, the input is not changed;
//   - source checks: the backend fields, api.ts, the tab buttons, the texts of the 8 languages and the dev preview.
// Run: node --experimental-strip-types scripts/test-focus-counts.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { badgeText, tabCounts, tabLabels, withThreadsGone, withUnreadChange } from "../src/focusCounts.ts";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8").replace(/\r\n/g, "\n");

const row = (accountId, key, unread, unreadFocused, unreadOther) => ({ accountId, key, unread, ...(unreadFocused === undefined ? {} : { unreadFocused }), ...(unreadOther === undefined ? {} : { unreadOther }) });
const folders = [
  row("m1", "inbox", 7, 3, 4), row("m1", "archive", 5, 9, 9), row("m1", "junk", 2),
  row("m2", "inbox", 3, 1, 2), row("m2", "sent", 0),
];

// ---- tabCounts
assert.deepEqual(tabCounts(folders, "m1"), { focused: 3, other: 4 }, "one mailbox");
assert.deepEqual(tabCounts(folders, "m2"), { focused: 1, other: 2 });
assert.deepEqual(tabCounts(folders, null), { focused: 4, other: 6 }, "Favorites > Inbox adds up the mailboxes");
assert.deepEqual(tabCounts(folders, "m3"), { focused: 0, other: 0 }, "an unknown mailbox");
assert.deepEqual(tabCounts([], null), { focused: 0, other: 0 }, "before the first answer");
assert.deepEqual(tabCounts([row("m1", "inbox", 4)], "m1"), { focused: 0, other: 0 }, "an Inbox row without the fields (older answer, dev preview)");
assert.deepEqual(tabCounts([row("m1", "inbox", 4, -2, Number.NaN)], "m1"), { focused: 0, other: 0 }, "nonsense is 0");
assert.deepEqual(tabCounts([row("m1", "archive", 5, 9, 9)], "m1"), { focused: 0, other: 0 }, "only the Inbox counts");

// ---- badgeText
assert.equal(badgeText(0), "");
assert.equal(badgeText(1), "1");
assert.equal(badgeText(99), "99");
assert.equal(badgeText(100), "99+");
assert.equal(badgeText(1234), "99+");
assert.equal(badgeText(-3), "");
assert.equal(badgeText(Number.NaN), "");
assert.equal(badgeText(7.9), "7");
assert.ok(/^[0-9+]*$/.test(badgeText(150)), "plain ASCII digits, no thousands separator");

// ---- tabLabels (the translations are passed in, here: English)
const aria = ({ tab, n }) => `${tab}, ${n} unread`;
const tip = ({ n }) => `${n} unread`;
assert.deepEqual(tabLabels(3, "Focused", aria, tip), { label: "Focused, 3 unread", title: "3 unread" });
assert.deepEqual(tabLabels(0, "Focused", aria, tip), {}, "0: the accessible name is the plain tab name, no tooltip");
assert.deepEqual(tabLabels(1234, "Other", aria, tip), { label: "Other, 1234 unread", title: "1234 unread" }, "above 99 the exact number is in the name and the tooltip");
assert.deepEqual(tabLabels(150, "Focused", aria, tip).label, "Focused, 150 unread");
assert.deepEqual(tabLabels(Number.NaN, "Other", aria, tip), {});

// ---- withUnreadChange
const inbox = row("m1", "inbox", 7, 3, 4);
const frozen = JSON.stringify(inbox);
let r = withUnreadChange(inbox, false, -1, true);
assert.deepEqual([r.unread, r.unreadFocused, r.unreadOther], [6, 2, 4], "a normal conversation read: Focused and the side menu go down");
r = withUnreadChange(inbox, true, -1, true);
assert.deepEqual([r.unread, r.unreadFocused, r.unreadOther], [6, 3, 3], "a bulk conversation read, bulk is counted: Other and the side menu go down");
r = withUnreadChange(inbox, true, -1, false);
assert.deepEqual([r.unread, r.unreadFocused, r.unreadOther], [7, 3, 3], "bulk is not counted in the side menu (setting off): only the Other tab changes");
r = withUnreadChange(inbox, false, -1, false);
assert.deepEqual([r.unread, r.unreadFocused], [6, 2], "a normal conversation is always counted in the side menu");
r = withUnreadChange(inbox, false, 1, true);
assert.deepEqual([r.unread, r.unreadFocused, r.unreadOther], [8, 4, 4], "marked unread again");
assert.equal(JSON.stringify(inbox), frozen, "the row is not changed in place");
r = withUnreadChange(row("m1", "inbox", 0, 0, 0), false, -1, true);
assert.deepEqual([r.unread, r.unreadFocused, r.unreadOther], [0, 0, 0], "never below 0");
r = withUnreadChange(row("m1", "inbox", 2), true, 1, true);
assert.deepEqual([r.unread, r.unreadFocused, r.unreadOther], [3, undefined, 1], "a row without the fields starts from 0");

// ---- withThreadsGone (a row leaves the list: delete / archive / move / snooze in the Undo window; fix batch 6, WP13e decision Q3)
const mk = () => [row("m1", "inbox", 7, 3, 4), row("m1", "archive", 5), row("m2", "inbox", 3, 1, 2)];
const gone = (t) => ({ accountId: "m1", folder: "inbox", bulk: false, unread: 1, ...t });
const f0 = mk();
const frozen0 = JSON.stringify(f0);
const same = (a, b) => assert.deepEqual(a.map((x) => JSON.stringify(x)), b.map((x) => JSON.stringify(x)));
let g = withThreadsGone(f0, [gone({})], true);
assert.deepEqual([g[0].unread, g[0].unreadFocused, g[0].unreadOther], [6, 2, 4], "a normal unread conversation: Focused and the side menu");
assert.equal(g[1], f0[1], "a row that did not change is the same object");
assert.equal(g[2], f0[2]);
assert.equal(JSON.stringify(f0), frozen0, "the input is not changed");
g = withThreadsGone(f0, [gone({ bulk: true })], true);
assert.deepEqual([g[0].unread, g[0].unreadFocused, g[0].unreadOther], [6, 3, 3], "a bulk conversation: Other and the side menu");
g = withThreadsGone(f0, [gone({ bulk: true })], false);
assert.deepEqual([g[0].unread, g[0].unreadFocused, g[0].unreadOther], [7, 3, 3], "bulk not counted in the side menu: only the Other tab");
same(withThreadsGone(f0, [gone({ unread: 0 })], true), f0); // a read conversation changes nothing
g = withThreadsGone(f0, [gone({}), gone({}), gone({ bulk: true })], true);
assert.deepEqual([g[0].unread, g[0].unreadFocused, g[0].unreadOther], [4, 1, 3], "several conversations add up");
g = withThreadsGone(f0, [gone({ folder: "archive" })], true);
assert.deepEqual([g[1].unread, g[1].unreadFocused], [4, undefined], "another folder: its own unread number, no tab numbers");
g = withThreadsGone(f0, [gone({ accountId: "m2" })], true);
assert.deepEqual([g[2].unread, g[2].unreadFocused, g[0].unread], [2, 0, 7], "the mailbox of the conversation");
g = withThreadsGone([row("m1", "inbox", 0, 0, 0)], [gone({}), gone({ bulk: true })], true);
assert.deepEqual([g[0].unread, g[0].unreadFocused, g[0].unreadOther], [0, 0, 0], "never below 0");
same(withThreadsGone(f0, [gone({ accountId: "zz" }), gone({ folder: "custom" })], true), f0); // an unknown mailbox or folder changes nothing

// ---- wiring (source)
const lib = read("src-tauri/src/lib.rs");
assert.match(lib, /unread_focused: u32,\n\s+unread_other: u32,/, "FolderInfo has the two fields (camelCase on the wire)");
assert.ok(lib.includes("const INBOX_NOT_SNOOZED") && lib.includes("const INBOX_NOT_BLOCKED"), "the Inbox visibility SQL is in one place");
const threads = lib.slice(lib.indexOf("fn threads_for("), lib.indexOf("let sql = format!(", lib.indexOf("fn threads_for(")));
assert.ok(threads.includes("{INBOX_NOT_SNOOZED}") && threads.includes("INBOX_NOT_BLOCKED.into()"), "threads_for uses the shared fragments");
assert.ok(!/snoozed_until IS NULL OR tm\.snoozed_until<=\?\)"/.test(threads), "threads_for has no private copy of the snooze condition");
assert.ok(lib.slice(lib.indexOf("fn inbox_unread_sql")).includes("{INBOX_NOT_SNOOZED} AND {INBOX_NOT_BLOCKED}"), "the counts use the same fragments");
const api = read("src/api.ts");
assert.match(api, /unreadFocused\?: number;\n\s+unreadOther\?: number;/, "api.ts FolderInfo");
const list = read("src/components/MessageList.tsx");
assert.match(list, /tabCounts\(folders, accountId\)/, "the list reads the folder numbers of the side menu");
assert.match(list, /aria-label=\{label\} title=\{title\}/, "name and tooltip on the tab button");
assert.match(list, /aria-hidden="true">\{badgeText\(n\)\}/, "the number is hidden from the screen reader (the name has it)");
assert.match(list, /\{n > 0 && <span/, "no badge at 0");
assert.ok(/role="tab"/.test(list) && /aria-selected=\{focus === k\}/.test(list), "role and selected state stay");
const store = read("src/store.ts");
assert.ok(store.includes("withUnreadChange(folders[i], t.bulk, delta, countsBulk)"), "applyOptimistic changes the tab numbers");
assert.ok(/const countsBulk = st\.prefs\.countOtherMail \|\| !st\.prefs\.focused;/.test(store), "bulk is counted in the side menu only with the setting (or Focused Inbox off)");
const css = read("src/App.css");
assert.match(css, /\.pivots \{ display: flex; gap: 0 18px; flex: none; min-width: 0; max-width: 100%; flex-wrap: wrap; \}/, "the tab list does not shrink and is never wider than the header (last resort: it wraps)");
assert.match(css, /\.pivots button \{ font-size: calc\(1\.1em \* var\(--tab-scale, 1\)\); \}/, "the tab text shrinks by --tab-scale (set by MessageList from the measured width)");
assert.ok(store.includes("withThreadsGone(get().folders, gone, prefs.countOtherMail || !prefs.focused)"), "act() lowers the unread numbers when the row leaves the list (Undo window)");
assert.ok(list.includes("TAB_SCALE_MIN") && list.includes("loadingdone") && list.includes('"--tab-scale"'), "MessageList shrinks the tabs when they are wider than the header and measures again when a font has loaded");
assert.ok(lib.includes("const NOT_HIDDEN") && lib.includes("{NOT_HIDDEN}") && lib.includes("folder_infos_hiding(c, &pending_thread_ids())"), "folder_infos leaves the conversations the lists hide out of the unread numbers");
assert.match(css, /white-space: nowrap; \}\n\.pivots button \{ font-size/, "the tab buttons do not wrap");
assert.match(css, /\.pivots \.fp-badge, \.ap-pivots \.fp-badge \{ margin-inline-start: 6px; \}/, "6 px between label and number");
const mock = read("src/devMock.ts");
assert.ok(mock.includes("unreadFocused:") && mock.includes("tabcounts="), "the dev preview computes the numbers and forces them with #tabcounts");

// ---- texts: the key exists in all 8 languages with the placeholders {tab} and {n}, and the plural forms of the language
const files = { en: "src/i18n/ns/mail.ts", vi: "src/i18n/ns/mail.ts", fr: "src/i18n/ns/mail.ts", de: "src/i18n/locales/de/mail.ts", es: "src/i18n/locales/es/mail.ts", ja: "src/i18n/locales/ja/mail.ts", ru: "src/i18n/locales/ru/mail.ts", "zh-Hans": "src/i18n/locales/zh-Hans/mail.ts" };
const lines = new Set();
for (const f of new Set(Object.values(files))) for (const l of read(f).split("\n")) if (l.includes('"mail.tabs.unreadAria"')) lines.add(l.trim());
assert.equal(lines.size, 8, "eight different texts (en, vi, fr in ns/mail.ts and five locale files)");
for (const l of lines) assert.ok(l.includes("{tab}") && l.includes("{n}"), `placeholders in ${l}`);
assert.ok([...lines].some((l) => l.includes("few:") && l.includes("many:")), "Russian has its four plural forms");

console.log("test-focus-counts: ok");
