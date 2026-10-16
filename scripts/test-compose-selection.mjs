// While a message is being written no mail is selected and nothing that works on the selected mail has a target (F-21).
// Behaviour of src/composeSelection.ts.
// Run: node --experimental-strip-types scripts/test-compose-selection.mjs
import assert from "node:assert/strict";
import { actionTargets, mayOpenMail, selectionAfterCompose } from "../src/composeSelection.ts";

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

// opening a mail while composing is refused (a refresh, an undo or an auto-advance must not select one); closing the selection is fine
assert.equal(mayOpenMail("t2", true), false);
assert.equal(mayOpenMail(null, true), true);
assert.equal(mayOpenMail("t2", false), true);

// when writing ends the reading pane gets the mail that was open before, unless another was picked or it left the list
assert.equal(selectionAfterCompose("t1", null, ["t0", "t1"]), "t1");
assert.equal(selectionAfterCompose("t1", "t2", ["t0", "t1", "t2"]), null);
assert.equal(selectionAfterCompose("t1", null, ["t0"]), null);
assert.equal(selectionAfterCompose(null, null, ["t0"]), null);

console.log("test-compose-selection: ok");
