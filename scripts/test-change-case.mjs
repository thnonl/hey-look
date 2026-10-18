// Change case (spec-rich-text.md REQ-50, AC-76): the five cases and the Shift+F3 cycle, as pure text functions (src/editor/changeCase.ts), and on a real
// ProseMirror document: the marks of the text stay, a caret takes its word, a selection over several runs is cut back into them.
// Run: node --experimental-strip-types scripts/test-change-case.mjs
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { applyCase, changeCase, nextInCycle, sentenceCase, titleCase, toggleCase } from "../src/editor/changeCase.ts";

assert.equal(applyCase("hello World. how ARE you? fine!", "sentence"), "Hello world. How are you? Fine!");
assert.equal(sentenceCase("one\ntwo"), "One\nTwo", "a line break starts a sentence");
assert.equal(sentenceCase("  leading blanks"), "  Leading blanks");
assert.equal(sentenceCase("3 apples. then 4"), "3 apples. Then 4", "a number does not start a sentence over");
assert.equal(applyCase("Hello World", "lower"), "hello world");
assert.equal(applyCase("Hello World", "upper"), "HELLO WORLD");
assert.equal(applyCase("hELLO wORLD", "title"), "Hello World");
assert.equal(titleCase("o'neil's co-op, 3rd floor"), "O'neil's Co-op, 3rd Floor", "an apostrophe, a hyphen or a digit does not start a new word");
assert.equal(toggleCase("Hello World 1"), "hELLO wORLD 1");
assert.equal(applyCase("straße", "upper"), "STRASSE", "the length can change");
assert.equal(applyCase("tiếng Việt đẹp", "upper"), "TIẾNG VIỆT ĐẸP");
assert.equal(applyCase("ÉCOLE", "title"), "École");
// the cycle (Shift+F3): lowercase -> UPPERCASE -> Capitalize Each Word -> lowercase; mixed text starts with lowercase
assert.equal(nextInCycle("Hello there"), "lower");
assert.equal(nextInCycle("hello there"), "upper");
assert.equal(nextInCycle("HELLO THERE"), "title");
assert.equal(nextInCycle("Hello There"), "lower");

// ---- on a document
const schema = getSchema([StarterKit.configure({ heading: { levels: [1, 2, 3] } })]);
const T = (text, marks) => ({ type: "text", text, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
const make = (para, from, to = from) => {
  const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: para }] });
  const dispatched = [];
  const editor = {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, from, to) }),
    view: { dispatch(tr) { editor.state = editor.state.apply(tr); } },
  };
  return editor;
};
const textOf = (e) => e.state.doc.textContent;
const marksOf = (e) => {
  const out = [];
  e.state.doc.descendants((n) => void (n.isText && out.push([n.text, n.marks.map((m) => m.type.name).join("+")])));
  return out;
};

{
  // "hello big world": "big" is bold; select everything -> UPPERCASE keeps the bold on "BIG"
  const e = make([T("hello "), T("big", ["bold"]), T(" world")], 1, 16);
  assert.equal(changeCase(e, "upper"), true);
  assert.equal(textOf(e), "HELLO BIG WORLD");
  assert.deepEqual(marksOf(e), [["HELLO ", ""], ["BIG", "bold"], [" WORLD", ""]]);
  // the selection is still there
  assert.deepEqual([e.state.selection.from, e.state.selection.to], [1, 16]);
}
{
  // sentence case over runs: the second run starts mid-sentence and is not capitalised
  const e = make([T("hello. "), T("WORLD", ["italic"]), T(" is big")], 1, 19);
  changeCase(e, "sentence");
  assert.equal(textOf(e), "Hello. World is big");
  assert.deepEqual(marksOf(e).map((x) => x[1]), ["", "italic", ""]);
}
{
  // a caret takes its word
  const e = make([T("one two three")], 7);
  changeCase(e, "upper");
  assert.equal(textOf(e), "one TWO three");
  // a caret between two spaces: nothing to change
  const b = make([T("a  b")], 3);
  assert.equal(changeCase(b, "upper"), false);
  assert.equal(textOf(b), "a  b");
}
{
  // Shift+F3 on a selection goes round
  const e = make([T("Hello there")], 1, 12);
  changeCase(e, null);
  assert.equal(textOf(e), "hello there");
  changeCase(e, null);
  assert.equal(textOf(e), "HELLO THERE");
  changeCase(e, null);
  assert.equal(textOf(e), "Hello There");
}
{
  // a length change ("ß" -> "SS") keeps the text whole and the marks of the first run
  const e = make([T("stra", ["bold"]), T("ße")], 1, 7);
  changeCase(e, "upper");
  assert.equal(textOf(e), "STRASSE");
}
{
  // nothing changes: no transaction
  const e = make([T("ABC")], 1, 4);
  const before = e.state.doc;
  changeCase(e, "upper");
  assert.equal(e.state.doc, before);
}

// ---- wiring
import { readFileSync } from "node:fs";
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
assert.match(read("src/editor/extensions.ts"), /"Shift-F3": .*import\("\.\/changeCase"\)/, "Shift+F3 cycles the case and the code is fetched with the first use");
assert.match(read("src/editor/controls.tsx"), /import\("\.\/changeCase"\)/, "the Change case menu fetches the code with the first use");
assert.ok(!/from "\.\/changeCase/.test(read("src/editor/controls.tsx") + read("src/editor/extensions.ts")), "changeCase is never imported statically (it is not in the first bundle)");

console.log("change-case: ok");
