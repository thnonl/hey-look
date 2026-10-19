// The rule for "something the person wrote" in a message being composed (src/composeContent.ts), the one rule behind the Discard button, leaving the
// message, closing a compose window, the autosave and the crash snapshot (v1.0.6 final QA, BUG-3: a reply with nothing typed asked "Discard this
// message?"). The real panes are checked by scripts/test-compose-discard.mjs. Run: node --experimental-strip-types scripts/test-compose-content.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeHasContent, draftContent, isPersonEdit } from "../src/composeContent.ts";

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

// ---- W13.5: what is worth a DRAFT on the server (draftContent). Recipients alone are not; composeHasContent (above) stays the rule of the local crash snapshot.
const dx = (o = {}) => ({ meetingWhere: "", openedWhere: "", existing: false, ...o });
const dc = (t, n, o, x) => draftContent(t, n, o, dx(x));
// a new message
assert.equal(dc(true, { ...empty, to: ["ann@x.test"] }, empty), false, "recipients only (the Mac QA finding): no draft");
assert.equal(dc(true, { ...empty, to: ["ann@x.test"], cc: 1, bcc: 1 }, empty), false, "To, Cc and Bcc only: no draft");
assert.equal(dc(true, empty, empty), false, "nothing at all");
assert.equal(dc(true, { ...empty, subject: "   " }, empty), false, "a blank subject");
assert.equal(dc(true, { ...empty, text: "" }, empty), false, "no text (whitespace is trimmed before: ComposeParts.text is trimmed)");
assert.equal(dc(true, { ...empty, subject: "Hi" }, empty), true, "a subject only");
assert.equal(dc(true, { ...empty, text: "x" }, empty), true, "text only");
assert.equal(dc(true, { ...empty, pics: 1 }, empty), true, "a picture only");
assert.equal(dc(true, { ...empty, atts: 1 }, empty), true, "an attachment only");
assert.equal(dc(true, { ...empty, to: ["a@x.test"], subject: "Hi" }, empty), true, "recipient and subject");
assert.equal(dc(false, { ...empty, subject: "Hi", text: "x" }, empty), false, "nobody touched it");
// the meeting strip: a place typed counts, the strip alone does not
assert.equal(dc(true, empty, empty, { meetingWhere: "" }), false, "the meeting strip on with no place");
assert.equal(dc(true, empty, empty, { meetingWhere: "  " }), false, "a blank place");
assert.equal(dc(true, empty, empty, { meetingWhere: "Room 4" }), true, "a place typed");
assert.equal(dc(true, empty, empty, { meetingWhere: "Room 4", openedWhere: "Room 4" }), false, "the place the meeting opened with (not the person's)");
// a reply: its recipients, subject and quote are Compose's own
assert.equal(dc(true, now(), opened), false, "an untouched reply");
assert.equal(dc(true, now({ to: [...opened.to, "new@x.test"], cc: 1 }), opened), false, "a reply with only an address added");
assert.equal(dc(true, now({ text: opened.text + " ok" }), opened), true, "a reply with text typed");
assert.equal(dc(true, now({ subject: "Re: Board notes" }), opened), true, "a reply with the subject changed");
assert.equal(dc(true, now({ subject: "" }), opened), false, "a reply whose subject was cleared");
assert.equal(dc(true, now({ text: "" }), opened), false, "a reply whose quote was taken out and nothing written");
assert.equal(dc(true, now({ atts: 1 }), opened), true, "a reply with a file added");
// a forward: the attachments it carries are the baseline
assert.equal(dc(true, { ...fwd }, fwd), false, "a forward with its carried attachment and nothing typed");
assert.equal(dc(true, { ...fwd, atts: 3 }, fwd), true, "a forward with one more file");
assert.equal(dc(true, { ...fwd, atts: 1 }, fwd), false, "a forward with a carried file taken off is not writing");
// a restored message or one carried to another window: all of it is the person's, but recipients are still not draft content
assert.equal(dc(true, now(), empty), true, "a restored reply has text (its quote)");
assert.equal(dc(true, { ...empty, to: ["a@x.test"] }, empty), false, "a restored recipients-only message");
// a draft that is already in Drafts (opened from there): an edit to it is not thrown away
assert.equal(dc(true, { ...opened, subject: "Draft", to: [...opened.to, "z@x.test"] }, { ...opened, subject: "Draft" }, { existing: true }), true, "an opened draft with an address added");
assert.equal(dc(true, { ...opened, subject: "Draft", pics: 0, atts: 0 }, { ...opened, subject: "Draft", atts: 1 }, { existing: true }), true, "an opened draft with a file taken off");
assert.equal(dc(true, { ...empty, to: ["z@x.test"] }, empty, { existing: true }), false, "an old recipients-only draft with an address added: still nothing to save (the server refuses it too)");
assert.equal(dc(true, { ...opened, text: "", subject: "", to: [] }, { ...opened, subject: "Draft" }, { existing: true }), false, "an opened draft emptied: it keeps the version saved last, nothing is written");
assert.equal(dc(false, { ...opened, to: [...opened.to, "z@x.test"], subject: "Draft" }, { ...opened, subject: "Draft" }, { existing: true }), false, "an opened draft nobody touched");

// the editor's own transactions are not edits
const tr = (docChanged, meta = {}) => ({ docChanged, getMeta: (k) => meta[k] });
assert.equal(isPersonEdit(tr(true)), true, "typing");
assert.equal(isPersonEdit(tr(false)), false, "a focus or selection move whose appended guard transaction added an empty paragraph");
assert.equal(isPersonEdit(tr(true, { signatureInit: true })), false, "the signature set-up");

// the pieces use it: the probe (leaving, closing, autosave, snapshot) and the Discard button share the rule; the editor reports edits through isPersonEdit
const src = read("../src/components/Compose.tsx");
assert.match(src, /import \{ composeHasContent, draftContent, isPersonEdit \} from "\.\.\/composeContent";/);
assert.match(src, /const hasContent = composeHasContent\(touched\.current,/, "probe uses the rule");
assert.match(src, /const hasDraftContent = draftContent\(\s*touched\.current,/, "probe also asks the draft rule (W13.5)");
assert.match(src, /return \{ hasContent, draftContent: hasDraftContent,/, "probe returns both");
assert.match(src, /if \(isPersonEdit\(transaction\)\) touch\(\);/, "onUpdate asks isPersonEdit");
const discard = src.slice(src.indexOf("const discard = async () => {"));
const rule = discard.slice(0, discard.indexOf("await dropSavedCopy();"));
assert.match(rule, /const written = probe\(\)\.draftContent;/, "Discard asks only when something worth a draft was written (the probe's draft rule, W13.5)");
assert.doesNotMatch(rule, /touched\.current &&/, "Discard no longer decides from `touched` and the recipients alone");
// the recovery snapshot and the autosave read the same probe
assert.match(src, /const p = \{ \.\.\.probe\(\), hasContent: probe\(\)\.hasContent \|\|/, "the snapshot and the autosave read the probe");
// W13.5: the autosave and Save draft go by the draft rule, the crash snapshot by the wider one
assert.match(src, /failures: failuresRef\.current, draftContent: p\.draftContent,/, "the autosave facts carry the draft rule");
assert.match(src, /if \(!auto && !probeRef\.current\(\)\.draftContent && /, "Save draft without draft content writes nothing (REQ-13.5.3)");
assert.match(src, /backendCode\(String\(e instanceof Error \? e\.message : e\)\) === "DRAFT_EMPTY"/, "the backend refusal gets the same toast (REQ-13.5.7)");
console.log("test-compose-content: ok");
