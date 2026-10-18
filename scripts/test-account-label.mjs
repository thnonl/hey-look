// The short label of a mailbox in the main UI (v1.0.6, F-29): the display name when there is one, else the address; the tooltip carries the
// full name and the address. Rules of src/accountLabel.ts, and that the screens use them.
// Run: node --experimental-strip-types scripts/test-account-label.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountLabel } from "../src/accountLabel.ts";

const ADDR = "nam@example.com";
// a display name replaces the address; the tooltip has the name (in full) and the address
assert.deepEqual(accountLabel({ email: ADDR, displayName: "Nam Work" }), { text: "Nam Work", name: "Nam Work", tip: `Nam Work\n${ADDR}` });
// surrounding white space is not part of the name
assert.equal(accountLabel({ email: ADDR, displayName: "  Nam  " }).text, "Nam");
// no name, an empty one, white space only, a missing field: the address, no tooltip
for (const displayName of [undefined, null, "", "   ", "\t\n"]) assert.deepEqual(accountLabel({ email: ADDR, displayName }), { text: ADDR, name: null, tip: null }, JSON.stringify(displayName));
// a name that is the address (any case, any spacing around it): the address, no tooltip that repeats it
assert.deepEqual(accountLabel({ email: ADDR, displayName: ADDR }), { text: ADDR, name: null, tip: null });
assert.deepEqual(accountLabel({ email: ADDR, displayName: " NAM@Example.com " }), { text: ADDR, name: null, tip: null });
// a long name is kept whole (the screen cuts it with an ellipsis); the tooltip gives it in full
const long = "A very long display name for a mailbox ".repeat(6).trim();
assert.equal(accountLabel({ email: ADDR, displayName: long }).text, long);
assert.ok(accountLabel({ email: ADDR, displayName: long }).tip.startsWith(long));
// a name that merely contains the address is a name
assert.equal(accountLabel({ email: ADDR, displayName: `Nam <${ADDR}>` }).name, `Nam <${ADDR}>`);

// the screens
const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
assert.match(read("components/FolderPane.tsx"), /<AcctName account=\{a\}/, "folder pane header");
assert.match(read("components/FolderPane.tsx"), /accountLabel\(a\)\.text/, "favourites and the drag grip");
assert.match(read("components/MessageList.tsx"), /accountLabel\(a\)\.text/, "list header / account dots");
assert.match(read("components/SearchBox.tsx"), /accountLabel\(a\)\.text/, "search scope");
assert.match(read("components/CommandBar.tsx"), /accountLabel\(a\)\.text/, "command bar");
assert.match(read("components/AcctName.tsx"), /mail\.acct\.labelAria/, "screen readers get name and address");
// what is sent is not changed: Compose's From and the picker still show / use "Name <address>"
assert.doesNotMatch(read("components/Compose.tsx"), /accountLabel/);
assert.doesNotMatch(read("store.ts"), /accountLabel/, "notification / toast text is not part of it");

console.log("account label rules: ok");
