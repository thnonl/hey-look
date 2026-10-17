// Find and replace in the body (spec-rich-text.md REQ-44, AC-67, AC-68): the search on real ProseMirror documents (src/editor/findReplace.ts) and the wiring.
// Run: node --experimental-strip-types scripts/test-find-replace.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { clearSearch, findMatches, findPlugin, getFind, replaceAll, replaceCurrent, selectedWord, setSearch, stepSearch } from "../src/editor/findReplace.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const schema = getSchema([StarterKit.configure({ heading: { levels: [1, 2, 3] } })]);
const T = (text, marks) => ({ type: "text", text, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
const P = (...kids) => ({ type: "paragraph", content: kids });
const doc = (...blocks) => schema.nodeFromJSON({ type: "doc", content: blocks });

// ---- the matches
{
  const d = doc(P(T("The cat sat. THE CAT")), P(T("a cat"), T("alog", ["bold"])), { type: "horizontalRule" }, P());
  assert.equal(findMatches(d, "cat", false).length, 3, "cat, CAT, and the cat of catalog");
  assert.equal(findMatches(d, "cat", true).length, 2, "match case: cat, and the cat of catalog");
  assert.equal(findMatches(d, "", false).length, 0, "an empty query matches nothing");
  assert.equal(findMatches(d, "xyz", false).length, 0);
  // a match across two runs with different marks (the bold "alog" after "cat")
  assert.equal(findMatches(d, "catalog", false).length, 1, "a match goes across runs with different marks");
  const d2 = doc(P(T("a cat"), T("alog", ["bold"])));
  // the positions are the document's
  const [h] = findMatches(d, "sat", false);
  assert.equal(d.textBetween(h.from, h.to), "sat");
  // matches do not overlap, and never cross a block
  assert.equal(findMatches(doc(P(T("aaaa"))), "aa", false).length, 2);
  assert.equal(findMatches(doc(P(T("ab")), P(T("cd"))), "bc", false).length, 0);
  // an inline break is one character no query matches
  assert.equal(findMatches(doc(P(T("a"), { type: "hardBreak" }, T("b"))), "ab", false).length, 0);
  // a letter that changes its length when folded (İ) does not move the positions
  const e = doc(P(T("İ x")));
  const [x] = findMatches(e, "x", false);
  assert.equal(e.textBetween(x.from, x.to), "x");
  // special characters are not a pattern
  assert.equal(findMatches(doc(P(T("a.b a+b (x)"))), ".", false).length, 1);
  assert.equal(findMatches(doc(P(T("a.b a+b (x)"))), "(x)", false).length, 1);
}

// ---- the plugin: highlights, stepping, replacing
const view = (d) => {
  const v = {
    state: EditorState.create({ doc: d, plugins: [findPlugin()] }),
    dispatch(tr) { v.state = v.state.apply(tr); },
    domAtPos() { throw new Error("no DOM here"); },
  };
  return v;
};
{
  const v = view(doc(P(T("one two one")), P(T("one"))));
  const s = setSearch(v, "one", false);
  assert.equal(s.hits.length, 3);
  assert.equal(s.current, 0, "the first match at or after the caret");
  assert.equal(stepSearch(v, 1).current, 1);
  assert.equal(stepSearch(v, 1).current, 2);
  assert.equal(stepSearch(v, 1).current, 0, "round the end");
  assert.equal(stepSearch(v, -1).current, 2, "and back");
  // the count the panel shows: "{n} of {total}"
  assert.deepEqual([getFind(v.state).current + 1, getFind(v.state).hits.length], [3, 3]);
  // match case changes the hits
  assert.equal(setSearch(v, "ONE", true).hits.length, 0);
  assert.equal(getFind(v.state).current, -1);
  assert.equal(setSearch(v, "ONE", false).hits.length, 3);
  // the highlights
  const decos = findPlugin().props.decorations(v.state);
  assert.equal(decos.find().length, 3);
  assert.equal(decos.find().filter((x) => /find-cur/.test(x.type.attrs.class)).length, 1, "one of them is the current one");
  clearSearch(v);
  assert.equal(getFind(v.state).hits.length, 0);
  assert.equal(findPlugin().props.decorations(v.state), null);
}
{
  // the first match is the one at or after the caret
  const d = doc(P(T("ab ab ab")));
  const v = view(d);
  v.state = v.state.apply(v.state.tr.setSelection(TextSelection.create(d, 5)));
  assert.equal(setSearch(v, "ab", false).current, 1);
}
{
  // Replace: the current one, then the next; the marks of the replaced text stay
  const v = view(doc(P(T("one "), T("two", ["bold"]), T(" one"))));
  setSearch(v, "two", false);
  replaceCurrent(v, "three");
  assert.equal(v.state.doc.textContent, "one three one");
  const marks = [];
  v.state.doc.descendants((n) => void (n.isText && marks.push([n.text, n.marks.map((m) => m.type.name).join()])));
  assert.deepEqual(marks.filter((m) => m[0].includes("three")), [["three", "bold"]], "the replacement is bold like the word it replaced");
  assert.equal(getFind(v.state).hits.length, 0, "no 'two' left");
  // Replace goes on to the next one
  const w = view(doc(P(T("a a a"))));
  setSearch(w, "a", false);
  replaceCurrent(w, "b");
  assert.equal(w.state.doc.textContent, "b a a");
  assert.equal(getFind(w.state).hits.length, 2);
  assert.equal(getFind(w.state).current, 0);
  replaceCurrent(w, "b");
  replaceCurrent(w, "b");
  assert.equal(w.state.doc.textContent, "b b b");
  // a replacement that holds the query again does not loop: one step per call
  const l = view(doc(P(T("a"))));
  setSearch(l, "a", false);
  replaceCurrent(l, "aa");
  assert.equal(l.state.doc.textContent, "aa");
  // an empty replacement deletes the match
  const z = view(doc(P(T("x-y-z"))));
  setSearch(z, "-", false);
  replaceCurrent(z, "");
  assert.equal(z.state.doc.textContent, "xy-z");
}
{
  // Replace all: every match, one undo step (one transaction), "Replaced {n} times"
  const v = view(doc(P(T("cat Cat")), P(T("a "), T("cat", ["italic"]), T("!"))));
  setSearch(v, "cat", false);
  let transactions = 0;
  const dispatch = v.dispatch;
  v.dispatch = (tr) => (transactions++, dispatch(tr));
  const n = replaceAll(v, "dog");
  assert.equal(n, 3);
  assert.equal(transactions, 1, "one transaction = one undo step");
  assert.deepEqual(v.state.doc.textBetween(0, v.state.doc.content.size, "|"), "dog dog|a dog!");
  assert.equal(getFind(v.state).hits.length, 0);
  assert.equal(replaceAll(v, "x"), 0, "nothing to replace");
}

// ---- the selected word starts a search
{
  const d = doc(P(T("hello world")));
  const sel = (from, to) => EditorState.create({ doc: d, selection: TextSelection.create(d, from, to) });
  assert.equal(selectedWord(sel(1, 6)), "hello");
  assert.equal(selectedWord(sel(3, 3)), "");
}

// ---- the wiring
const kit = read("src/editor/kitExtensions.ts");
assert.match(kit, /FindReplace/, "the plugin is in the kit chunk");
const ext = read("src/editor/extensions.ts");
assert.match(ext, /"Mod-f": /, "Ctrl+F in the body");
assert.match(ext, /"Mod-h"/, "Ctrl+H in the body");
assert.ok(!/from "\.\/findReplace/.test(ext + read("src/editor/controls.tsx") + read("src/components/Compose.tsx")), "findReplace.ts is never imported statically by the first bundle's code");
assert.match(read("src/components/Compose.tsx"), /import\("\.\.\/editor\/FindBar"\)/, "the panel is fetched when it is first opened");

console.log("find-replace: ok");
