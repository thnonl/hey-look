// While a message is being written no mail is selected and nothing that works on the selected mail has a target (F-21).
// Behaviour of src/composeSelection.ts.
// Run: node --experimental-strip-types scripts/test-compose-selection.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { actionTargets, isReopen, mayOpenMail, ribbonAvailability, selectionAfterCompose } from "../src/composeSelection.ts";

const none = new Set();

// action targets: the ticked ones, else the open one ...
assert.deepEqual(actionTargets(none, "t1", false), ["t1"]);
assert.deepEqual(actionTargets(new Set(["a", "b"]), "t1", false), ["a", "b"]);
assert.deepEqual(actionTargets(none, null, false), []);
// ... and none at all while composing, whatever is still ticked or selected (archive, delete, flag, move, read/unread, junk, snooze)
assert.deepEqual(actionTargets(none, "t1", true), []);
assert.deepEqual(actionTargets(new Set(["a", "b"]), "t1", true), []);
// back after the message closes
assert.deepEqual(actionTargets(none, "t1", false), ["t1"]);

// the ribbon: ONE rule for every button that works on the selected mail (QA round 18 BUG-1: Report and Snooze looked usable while writing)
const usable = (a) => [a.onSelection, a.reply, a.forward];
assert.deepEqual(usable(ribbonAvailability(1, 1, false, false)), [true, true, true]);
assert.deepEqual(usable(ribbonAvailability(2, 0, false, false)), [true, false, false], "ticked rows, no open conversation: no reply");
assert.deepEqual(usable(ribbonAvailability(0, 0, false, false)), [false, false, false], "nothing selected");
assert.deepEqual(usable(ribbonAvailability(1, 1, false, true)), [true, true, false], "no forward of confidential mail");
// while writing every one of them is off, even if a conversation is still listed as open or ticked
assert.deepEqual(usable(ribbonAvailability(1, 1, true, false)), [false, false, false]);
assert.deepEqual(usable(ribbonAvailability(3, 5, true, false)), [false, false, false]);
// every selection-dependent button of the Home tab (Delete, Archive, Report, Move to, Reply, Reply all, Forward, Mark read, Flag, Pin, Snooze)
// takes its state from that function: no button decides on its own (source guard)
const ribbon = readFileSync(new URL("../src/components/Ribbon.tsx", import.meta.url), "utf8");
const home = ribbon.slice(ribbon.indexOf("function HomeTab"), ribbon.indexOf("function CalendarHomeTab"));
assert.ok(home.includes("ribbonAvailability("));
const dis = [...home.matchAll(/disabled={([^}]*)}/g)].map((m) => m[1]);
assert.equal(dis.length, 11, "eleven buttons work on the selected mail");
assert.ok(dis.every((d) => /^!?s*av.(onSelection|reply|forward)$/.test(d.trim())), `a ribbon button has its own rule: ${dis.join(" | ")}`);
assert.ok(/disabled={disabled}>/.test(ribbon), "a menu button (Report, Move to, Snooze) is off itself, not only through its fieldset");

// opening a mail while composing is refused (a refresh, an undo or an auto-advance must not select one); closing the selection is fine
assert.equal(mayOpenMail("t2", true), false);
assert.equal(mayOpenMail(null, true), true);
assert.equal(mayOpenMail("t2", false), true);

// (1.0.10 R1) a click on the open conversation's row opens nothing new: loaded, or its read is still in flight; a failed open, another mail or a message being written still go through
const st = (o) => ({ selected: "t1", messages: [{}], openError: null, composing: false, ...o });
assert.equal(isReopen(st({}), "t1", null), true, "open and loaded: nothing to do");
assert.equal(isReopen(st({ messages: [] }), "t1", "t1"), true, "still loading (a read in flight): no second read");
assert.equal(isReopen(st({ messages: [] }), "t1", null), false, "selected, empty, no read running: open it");
assert.equal(isReopen(st({ messages: [] }), "t1", "t2"), false, "the read in flight is another mail's");
assert.equal(isReopen(st({ openError: "t1" }), "t1", null), false, "the last open failed: a click tries again");
assert.equal(isReopen(st({ openError: "t2" }), "t1", null), true, "an error of another mail does not matter");
assert.equal(isReopen(st({}), "t2", null), false, "another conversation opens as before");
assert.equal(isReopen(st({ selected: null, messages: [] }), "t1", null), false, "nothing open");
assert.equal(isReopen(st({ composing: true }), "t1", null), false, "while writing the click leaves the message first");

// when writing ends the reading pane gets the mail that was open before, unless another was picked or it left the list
assert.equal(selectionAfterCompose("t1", null, ["t0", "t1"]), "t1");
assert.equal(selectionAfterCompose("t1", "t2", ["t0", "t1", "t2"]), null);
assert.equal(selectionAfterCompose("t1", null, ["t0"]), null);
assert.equal(selectionAfterCompose(null, null, ["t0"]), null);

console.log("test-compose-selection: ok");
