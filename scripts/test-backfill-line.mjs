// The "Downloading mails…" line of the list (BUG: after a manually added IMAP account had downloaded all its mail, "Downloading mails… 100 / 500"
// stayed on screen for ever). Pure logic of src/backfill.ts; the Rust side that sends the closing event is tested in src-tauri (backfill_tests).
// Run: node --experimental-strip-types scripts/test-backfill-line.mjs
import assert from "node:assert/strict";
import { applyBackfill, downloadLine } from "../src/backfill.ts";

const ev = (accountId, have, target, done = false, role = "inbox") => ({ accountId, role, have, target, done });
const show = (state, o = {}) => downloadLine(state, { inboxish: true, searching: false, accountId: null, accountIds: ["a", "b"], ...o });

// events: the last one wins per account, `done` ends the line
let s = {};
s = applyBackfill(s, ev("a", 50, 500));
s = applyBackfill(s, ev("a", 100, 500));
assert.deepEqual(show(s), { have: 100, target: 500 });
s = applyBackfill(s, ev("a", 101, 500, true));
assert.equal(show(s), null, "the closing event removes the line");
assert.deepEqual(s, {});

// the closing event the backend sends when a run stops between two chunks has no progress of its own: it still ends the line
s = applyBackfill({}, ev("a", 100, 500));
s = applyBackfill(s, ev("a", 100, 500, true));
assert.equal(show(s), null);

// the state is not mutated, other accounts are untouched
const before = { a: ev("a", 100, 500), b: ev("b", 20, 100) };
const frozen = structuredClone(before);
const after = applyBackfill(before, ev("a", 100, 500, true));
assert.deepEqual(before, frozen);
assert.deepEqual(Object.keys(after), ["b"]);

// two mailboxes download: the unified list adds them up, a single mailbox shows its own
s = { a: ev("a", 100, 500), b: ev("b", 30, 500) };
assert.deepEqual(show(s), { have: 130, target: 1000 });
assert.deepEqual(show(s, { accountId: "b" }), { have: 30, target: 500 });
assert.equal(show(s, { accountId: "c", accountIds: ["a", "b", "c"] }), null);

// only the Inbox (other folders download quietly), never while searching, never outside the Inbox views
assert.equal(show({ a: ev("a", 10, 100, false, "sent") }), null);
assert.equal(show(s, { searching: true }), null);
assert.equal(show(s, { inboxish: false }), null);

// have never counts past the target
assert.deepEqual(show({ a: ev("a", 700, 500) }), { have: 500, target: 500 });

// a removed mailbox never sends its closing event: its line is not shown
assert.equal(show({ a: ev("a", 100, 500) }, { accountIds: ["b"] }), null);

console.log("ok - test-backfill-line");
