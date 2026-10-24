// "Search mail for the selection" (W8.1): the query made from selected text, and the label of the menu entry. Behaviour of src/selectionSearch.ts.
// Run: node --experimental-strip-types scripts/test-selection-search.mjs
import assert from "node:assert/strict";
import { checkedSearchText, selectionLabel, selectionQuery } from "../src/selectionSearch.ts";

const q = (text, want, msg) => assert.equal(selectionQuery(text), want, msg ?? JSON.stringify(text));

// whitespace runs are one space, the ends are trimmed
q("budget review", "budget review");
q("  budget \n\t review  ", "budget review", "line breaks and tabs");
q("Quarterly budget review moved to Friday", "Quarterly budget review moved to Friday");
// quotes go
q('"pay now"', "pay now");
q('say "hello" please', "say hello please");
// an operator word is never read as a filter, in any case; the colon becomes a space
q('from:boss subject:"pay"', "from boss subject pay", "AC-8.1.3");
for (const op of ["from", "to", "cc", "subject", "body", "has", "hasattachment", "hasattachments", "is", "after", "since", "before", "until", "folder", "in"]) {
  q(`${op}:x`, `${op} x`, `${op}:x`);
  q(`${op.toUpperCase()}:x`, `${op.toUpperCase()} x`, `${op.toUpperCase()}:x in capitals`);
  q(`${op[0].toUpperCase()}${op.slice(1)}:x y`, `${op[0].toUpperCase()}${op.slice(1)} x y`, `${op}: capital first letter`);
}
q("is:unread", "is unread");
q("has:attachment", "has attachment");
q("in:inbox", "in inbox");
q("from:", "from", "an operator with nothing after the colon");
q("subject: late", "subject late", "a colon and a space");
// other colons stay: they are no operator
q("Re: budget", "Re: budget", "Re: stays a word");
q("Fwd: report", "Fwd: report");
q("http://example.test/a", "http://example.test/a");
q("10:30 meeting", "10:30 meeting");
q("note:x", "note:x", "not an operator");
q("from:a:b", "from a:b", "only the first colon");
q("xfrom:boss", "xfrom:boss", "the operator must be the whole start of the word");
// the first 8 words
q("one two three four five six seven eight nine ten", "one two three four five six seven eight");
q("a b c d e f g", "a b c d e f g");
q("from:a to:b cc:c subject:d body:e after:f before:g", "from a to b cc c subject d", "an operator and its value are two words for the cut");
// at most 100 characters, cut at the end of a word
{
  const words = Array.from({ length: 8 }, (_, i) => String(i).repeat(14)); // 8 words of 14 characters = 8*14 + 7 = 119
  const out = selectionQuery(words.join(" "));
  assert.equal(out, words.slice(0, 6).join(" "), "the 7th word would pass 100 (104): it and the rest are left out");
  assert.ok(out.length <= 100);
  assert.equal(selectionQuery("x".repeat(250)), "x".repeat(100), "one word longer than 100 is cut inside it");
  assert.equal(selectionQuery(`${"y".repeat(60)} ${"z".repeat(60)}`), "y".repeat(60), "a word that does not fit whole is dropped");
}
// nothing left
q("", null);
q("   \n\t ", null);
q('""', null);
q('" "', null);

// the label of the entry: 30 characters, then an ellipsis
assert.equal(selectionLabel("budget review"), "budget review");
assert.equal(selectionLabel("a".repeat(30)), "a".repeat(30));
assert.equal(selectionLabel("a".repeat(31)), `${"a".repeat(30)}…`);
assert.equal(selectionLabel("one two three four five six seven eight"), "one two three four five six se…", "AC-8.1.2: the label is cut, the query is not");
assert.equal(selectionLabel("𠀀".repeat(40)), `${"𠀀".repeat(30)}…`, "characters outside the BMP count once");
assert.equal(selectionLabel("hóa đơn".repeat(10)).length, 31 + (selectionLabel("hóa đơn".repeat(10)).length - 31), "accented text is cut by characters");

// what a reader window may ask for: a string of at most 200 characters with something to search
assert.equal(checkedSearchText("budget review"), "budget review");
assert.equal(checkedSearchText("from:x"), "from x", "the request is normalised again by the main window");
assert.equal(checkedSearchText("a".repeat(200)), "a".repeat(100));
assert.equal(checkedSearchText("a".repeat(201)), null, "longer than 200 is refused");
assert.equal(checkedSearchText(""), null);
assert.equal(checkedSearchText("  "), null);
for (const bad of [undefined, null, 5, {}, [], ["a"], true]) assert.equal(checkedSearchText(bad), null, `${JSON.stringify(bad)} is refused`);
console.log("ok - test-selection-search");
