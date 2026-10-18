// The rule for "something the person wrote" in a message being composed (src/composeContent.ts), the one rule behind the Discard button, leaving the
// message, closing a compose window, the autosave and the crash snapshot (v1.0.6 final QA, BUG-3: a reply with nothing typed asked "Discard this
// message?"). The real panes are checked by scripts/test-compose-discard.mjs. Run: node --experimental-strip-types scripts/test-compose-content.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeHasContent, isPersonEdit } from "../src/composeContent.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// a reply as Compose opens it: recipients, subject and quote are its own
const opened = { text: "On Sun, Board wrote: Hello team", pics: 0, to: ["Board <board@x.test>", "ann@x.test"], cc: 0, bcc: 0, subject: "Re: Board note", atts: 0 };
const now = (o = {}) => ({ ...opened, ...o });

// nothing typed: never content, touched or not
assert.equal(composeHasContent(false, now(), opened), false, "an untouched reply is not content");
assert.equal(composeHasContent(true, now(), opened), false, "a touched reply that equals what it opened with is not content (the guards' paragraph, a focus move)");
assert.equal(composeHasContent(true, now({ subject: "Re: Board note  " }), opened), false, "trailing spaces in the subject are not writing");
// the person wrote
assert.equal(composeHasContent(true, now({ text: opened.text + "x" }), opened), true, "one letter in the body");
assert.equal(composeHasContent(true, now({ subject: "Re: Board notes" }), opened), true, "one letter in the subject");
assert.equal(composeHasContent(true, now({ to: [...opened.to, "new@x.test"] }), opened), true, "an address added to To");
assert.equal(composeHasContent(true, now({ to: [opened.to[0]] }), opened), true, "an address taken out of To");
assert.equal(composeHasContent(true, now({ cc: 1 }), opened), true, "an address in Cc");
assert.equal(composeHasContent(true, now({ bcc: 1 }), opened), true, "an address in Bcc");
assert.equal(composeHasContent(true, now({ pics: 1 }), opened), true, "a picture in the body");
assert.equal(composeHasContent(true, now({ atts: 1 }), opened), true, "an attachment");
// not touched: whatever differs (a late signature, the quote being fetched) is Compose's own doing
assert.equal(composeHasContent(false, now({ text: "different" }), opened), false, "nobody touched it");
// a forward with attachments of its own: they are the baseline
const fwd = { ...opened, to: [], subject: "Fwd: x", atts: 2 };
assert.equal(composeHasContent(true, { ...fwd }, fwd), false, "a forward with its own attachments, nothing added");
assert.equal(composeHasContent(true, { ...fwd, atts: 3 }, fwd), true, "a third attachment added");
assert.equal(composeHasContent(true, { ...fwd, atts: 1 }, fwd), true, "one of the forwarded files taken off");
// a restored message / one carried to another window opens with an empty baseline: all of it is the person's
const empty = { text: "", pics: 0, to: [], cc: 0, bcc: 0, subject: "", atts: 0 };
assert.equal(composeHasContent(true, now(), empty), true, "a restored reply is content");
assert.equal(composeHasContent(true, empty, empty), false, "a restored message that is empty");
// a new message
assert.equal(composeHasContent(true, empty, empty), false, "an empty new message");
assert.equal(composeHasContent(true, { ...empty, subject: "Hi" }, empty), true, "a subject typed in a new message");

// the editor's own transactions are not edits
const tr = (docChanged, meta = {}) => ({ docChanged, getMeta: (k) => meta[k] });
assert.equal(isPersonEdit(tr(true)), true, "typing");
assert.equal(isPersonEdit(tr(false)), false, "a focus or selection move whose appended guard transaction added an empty paragraph");
assert.equal(isPersonEdit(tr(true, { signatureInit: true })), false, "the signature set-up");

// the pieces use it: the probe (leaving, closing, autosave, snapshot) and the Discard button share the rule; the editor reports edits through isPersonEdit
const src = read("../src/components/Compose.tsx");
assert.match(src, /import \{ composeHasContent, isPersonEdit \} from "\.\.\/composeContent";/);
assert.match(src, /const hasContent = composeHasContent\(\s*touched\.current,/, "probe uses the rule");
assert.match(src, /if \(isPersonEdit\(transaction\)\) touch\(\);/, "onUpdate asks isPersonEdit");
const discard = src.slice(src.indexOf("const discard = async () => {"));
const rule = discard.slice(0, discard.indexOf("await dropSavedCopy();"));
assert.match(rule, /const written = probe\(\)\.hasContent \|\|/, "Discard asks only when something was written (the probe's rule)");
assert.doesNotMatch(rule, /touched\.current &&/, "Discard no longer decides from `touched` and the recipients alone");
// the recovery snapshot and the autosave read the same probe
assert.match(src, /const p = \{ \.\.\.probe\(\), hasContent: probe\(\)\.hasContent \|\|/, "the snapshot and the autosave read the probe");
console.log("test-compose-content: ok");
