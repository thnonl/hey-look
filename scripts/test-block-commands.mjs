// The commands of the paragraph formats on real documents (src/editor/blockCommands.ts): alignment, indent, line spacing, space after, styles, list
// markers, and the questions the toolbar asks. They are ProseMirror commands, so this runs them on an EditorState built from the editor's schema, with no
// DOM. Covers AC-30 .. AC-34 (the document side; keys and menus are checked in the dev mock).
// Run: node --experimental-strip-types scripts/test-block-commands.mjs
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TextStyleKit } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { BlockFormat } from "../src/editor/blockExtension.ts";
import {
  indentList, indentPlain, listKind, listsOf, resetBlockFormats, selectionAlign, selectionDirection, selectionHasSpaceAfter, selectionLineHeight, selectionListStyle, selectionStyle,
  setAlign, setDirection, setLineHeight, setListStyle, setSpaceAfter, setStyle, textblocksOf,
} from "../src/editor/blockCommands.ts";
import { docToHtml } from "../src/editor/emailHtml.ts";

// the same pieces as editor/extensions.ts (that file needs the browser to load)
const schema = getSchema([StarterKit.configure({ strike: false, code: false, heading: { levels: [1, 2, 3] } }), Subscript, Superscript, TextStyleKit.configure({ lineHeight: false }), BlockFormat]);

const T = (text, marks) => ({ type: "text", text, ...(marks ? { marks } : {}) });
const P = (text, attrs) => ({ type: "paragraph", ...(attrs ? { attrs } : {}), content: text ? [T(text)] : [] });
const H = (level, text, attrs) => ({ type: "heading", attrs: { level, ...(attrs ?? {}) }, content: [T(text)] });
const LI = (...kids) => ({ type: "listItem", content: kids });
const UL = (...items) => ({ type: "bulletList", content: items });
const OL = (...items) => ({ type: "orderedList", content: items });
const doc = (...blocks) => schema.nodeFromJSON({ type: "doc", content: blocks });

/** The position of `at` characters into the first text that contains `needle`. */
function pos(d, needle, at = 0) {
  let found = -1;
  d.descendants((node, p) => {
    if (found < 0 && node.isText && node.text.includes(needle)) found = p + node.text.indexOf(needle) + at;
  });
  assert.ok(found >= 0, `no text "${needle}"`);
  return found;
}
const stateAt = (d, from, to = from) => EditorState.create({ doc: d, selection: TextSelection.create(d, from, to) });
/** Run a command; the new state, or null when the command said no. */
function run(state, cmd) {
  let tr = null;
  const ok = cmd(state, (t) => (tr = t));
  return ok ? (tr ? state.apply(tr) : state) : null;
}
const html = (state) => docToHtml(state.doc.toJSON());
const attrsOf = (state, needle) => {
  let a = null;
  state.doc.descendants((n, p) => {
    if (a === null && n.isTextblock && n.textContent.includes(needle)) a = n.attrs;
  });
  return a;
};

// ---- alignment (AC-32)
{
  const d = doc(P("one"), P("two"), P("three"));
  let s = run(stateAt(d, pos(d, "two", 1)), setAlign("center"));
  assert.equal(attrsOf(s, "two").textAlign, "center");
  assert.equal(attrsOf(s, "one").textAlign, null, "only the paragraph with the caret");
  assert.deepEqual(selectionAlign(s), { mixed: false, value: "center" });
  assert.match(html(s), /<p style="margin:0;text-align:center">two<\/p>/);
  s = run(s, setAlign("left"));
  assert.equal(attrsOf(s, "two").textAlign, null, "left is no attribute");
  // a selection over two paragraphs
  s = run(stateAt(d, pos(d, "one", 1), pos(d, "two", 2)), setAlign("right"));
  assert.equal(attrsOf(s, "one").textAlign, "right");
  assert.equal(attrsOf(s, "two").textAlign, "right");
  assert.equal(attrsOf(s, "three").textAlign, null);
  // ... ending at the very start of the next paragraph does not take that one
  s = run(stateAt(d, pos(d, "one", 0), pos(d, "two", 0)), setAlign("justify"));
  assert.equal(attrsOf(s, "one").textAlign, "justify");
  assert.equal(attrsOf(s, "two").textAlign, null, "a selection that ends at the start of a paragraph leaves it alone");
  // mixed: one centred, the others left
  const mixed = run(stateAt(d, pos(d, "two", 1)), setAlign("center"));
  assert.equal(selectionAlign(stateAt(mixed.doc, pos(mixed.doc, "one"), pos(mixed.doc, "three", 2))).mixed, true);
  assert.deepEqual(selectionAlign(stateAt(mixed.doc, pos(mixed.doc, "two", 1))), { mixed: false, value: "center" });
  // headings and list items
  const h = doc(H(2, "Title"), UL(LI(P("item"))));
  s = run(stateAt(h, pos(h, "Title", 2)), setAlign("center"));
  assert.match(html(s), /<h2 style="font-size:14pt;font-weight:bold;margin:12pt 0 4pt;text-align:center">/);
  s = run(stateAt(h, pos(h, "item", 1)), setAlign("right"));
  assert.match(html(s), /<li><p style="margin:0;text-align:right">item<\/p><\/li>/, "a list item paragraph is aligned too");
  // an image-only or code block: no formatted block, the key is left alone
  const c = doc({ type: "codeBlock", content: [T("x")] });
  assert.equal(run(stateAt(c, 2), setAlign("center")), null);
}

// ---- indent (AC-31)
{
  const d = doc(P("body"));
  let s = stateAt(d, pos(d, "body", 1));
  for (let i = 0; i < 3; i++) s = run(s, indentPlain(1));
  assert.equal(attrsOf(s, "body").indent, 3);
  assert.match(html(s), /<p style="margin:0 0 0 120px">body<\/p>/, "three steps: margin-left 120px");
  s = run(s, indentPlain(-1));
  assert.equal(attrsOf(s, "body").indent, 2);
  for (let i = 0; i < 12; i++) s = run(s, indentPlain(1));
  assert.equal(attrsOf(s, "body").indent, 8, "8 steps at most");
  for (let i = 0; i < 12; i++) s = run(s, indentPlain(-1));
  assert.equal(attrsOf(s, "body").indent, 0, "decrease at 0 does nothing");
  assert.match(html(s), /<p style="margin:0">body<\/p>/);
  // headings indent; list items do not (they nest)
  const h = doc(H(1, "Title"), UL(LI(P("a")), LI(P("b"))));
  const hs = run(stateAt(h, pos(h, "Title", 1)), indentPlain(1));
  assert.equal(attrsOf(hs, "Title").indent, 1);
  assert.equal(run(stateAt(h, pos(h, "a")), indentPlain(1)), null, "a list item is not indented by 40 px");
  // in a list, increase nests under the item above and decrease brings it back (indentList = Tab / Shift+Tab)
  let l = stateAt(h, pos(h, "b", 0));
  assert.equal(listsOf(l).length, 1);
  l = run(l, indentList(1));
  assert.equal(listsOf(l)[0].depth, 1, "b is nested under a");
  assert.match(html(l), /<li>a<ul style="list-style-type:circle;[^"]*"><li>b<\/li><\/ul><\/li>/);
  l = run(l, indentList(-1));
  assert.equal(listsOf(l)[0].depth, 0, "and back");
  // the first item has nothing above to nest under
  assert.equal(run(stateAt(h, pos(h, "a", 0)), indentList(1)), null);
}

// ---- line spacing and space after (AC-33)
{
  const d = doc(P("one"), H(2, "head"));
  let s = run(stateAt(d, pos(d, "one", 1)), setLineHeight("1.5"));
  assert.match(html(s), /<p style="margin:0;line-height:1.5">one<\/p>/);
  assert.deepEqual(selectionLineHeight(s), { mixed: false, value: "1.5" });
  s = run(s, setLineHeight(null));
  assert.match(html(s), /<p style="margin:0">one<\/p>/, "single spacing writes nothing");
  // space after
  assert.equal(selectionHasSpaceAfter(stateAt(d, pos(d, "one", 1))), false);
  s = run(stateAt(d, pos(d, "one", 1)), setSpaceAfter(true));
  assert.match(html(s), /<p style="margin:0 0 10pt">one<\/p>/);
  assert.equal(selectionHasSpaceAfter(s), true);
  s = run(s, setSpaceAfter(false));
  assert.equal(attrsOf(s, "one").spaceAfter, null, "a paragraph without space is the default");
  assert.match(html(s), /<p style="margin:0">one<\/p>/, "Remove space after: margin-bottom 0");
  // a heading has space after by default; removing it is "none"
  assert.equal(selectionHasSpaceAfter(stateAt(d, pos(d, "head", 1))), true);
  s = run(stateAt(d, pos(d, "head", 1)), setSpaceAfter(false));
  assert.equal(attrsOf(s, "head").spaceAfter, "none");
  assert.match(html(s), /<h2 style="font-size:14pt;font-weight:bold;margin:12pt 0 0">/);
  assert.equal(selectionHasSpaceAfter(s), false);
}

// ---- styles (AC-34)
{
  const d = doc(P("one", { textAlign: "center", indent: 2, spaceAfter: "add" }), P("two"));
  let s = run(stateAt(d, pos(d, "one", 1)), setStyle("h2"));
  assert.equal(s.doc.child(0).type.name, "heading");
  assert.equal(s.doc.child(0).attrs.level, 2);
  assert.equal(s.doc.child(0).attrs.textAlign, "center", "a heading keeps the alignment");
  assert.equal(s.doc.child(0).attrs.indent, 2);
  assert.equal(selectionStyle(s).value, "h2");
  s = run(s, setStyle("normal"));
  assert.equal(s.doc.child(0).type.name, "paragraph");
  assert.equal(s.doc.child(0).attrs.textAlign, "center");
  assert.equal(selectionStyle(s).value, "normal");
  // several blocks at once
  const both = run(stateAt(d, pos(d, "one"), pos(d, "two", 2)), setStyle("h1"));
  assert.deepEqual([both.doc.child(0).type.name, both.doc.child(1).type.name, both.doc.child(1).attrs.level], ["heading", "heading", 1]);
  assert.equal(selectionStyle(stateAt(both.doc, pos(both.doc, "one"), pos(both.doc, "two", 2))).value, "h1");
  // quote
  s = run(stateAt(d, pos(d, "two", 1)), setStyle("quote"));
  assert.equal(s.doc.child(1).type.name, "blockquote");
  assert.equal(selectionStyle(s).value, "quote");
  assert.match(html(s), /<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p style="margin:0">two<\/p><\/blockquote>/);
  // a heading is taken out of a quote, Normal too
  const q = run(s, setStyle("h3"));
  assert.equal(q.doc.child(1).type.name, "heading", "Heading 3 on a quote leaves the quote");
  const n = run(s, setStyle("normal"));
  assert.equal(n.doc.child(1).type.name, "paragraph");
  assert.equal(n.doc.childCount, 2);
  // code: marks and formats do not come along
  const m = doc({ type: "paragraph", attrs: { textAlign: "right" }, content: [T("bold", [{ type: "bold" }]), T(" rest")] });
  const c = run(stateAt(m, 2), setStyle("code"));
  assert.equal(c.doc.child(0).type.name, "codeBlock");
  assert.equal(c.doc.child(0).textContent, "bold rest");
  assert.equal(c.doc.child(0).child(0).marks.length, 0, "no marks in code");
  assert.equal(selectionStyle(c).value, "code");
  assert.match(html(c), /<pre style=/);
  const back = run(c, setStyle("normal"));
  assert.equal(back.doc.child(0).type.name, "paragraph");
  // mixed selection has no style
  assert.equal(selectionStyle(stateAt(d, pos(d, "one"), pos(d, "two", 2))).value, "normal");
  {
    const hy = doc(H(1, "x"), P("y"));
    assert.equal(selectionStyle(stateAt(hy, pos(hy, "x"), pos(hy, "y", 1))).mixed, true, "a heading and a paragraph: no style");
  }
  // the heading is not allowed as the first block of a list item: it stays a paragraph, the command still says it handled the key
  const li = doc(UL(LI(P("item"))));
  const hl = run(stateAt(li, pos(li, "item", 1)), setStyle("h1"));
  assert.equal(hl.doc.firstChild.firstChild.firstChild.type.name, "paragraph");
}

// ---- reset (Clear formatting resets alignment, indent and spacing: AC-28)
{
  const d = doc(H(2, "x", { textAlign: "center", indent: 3, lineHeight: "2", spaceAfter: "add" }));
  const s = run(stateAt(d, 2), resetBlockFormats);
  assert.deepEqual([s.doc.child(0).attrs.textAlign, s.doc.child(0).attrs.indent, s.doc.child(0).attrs.lineHeight, s.doc.child(0).attrs.spaceAfter], [null, 0, null, null]);
  assert.equal(s.doc.child(0).attrs.level, 2, "the style is the business of the style reset");
}

// ---- list marker styles (AC-29, AC-30)
{
  const d = doc(UL(LI(P("a"), UL(LI(P("b"), UL(LI(P("c"))))))));
  assert.equal(listKind(stateAt(d, pos(d, "a"))), "bullet");
  assert.deepEqual(["a", "b", "c"].map((t) => selectionListStyle(stateAt(d, pos(d, t)), false).value), ["disc", "circle", "square"], "the shown style follows the level");
  // choose "square" for the top list
  let s = run(stateAt(d, pos(d, "a")), setListStyle(false, "square"));
  assert.equal(s.doc.child(0).attrs.listStyle, "square");
  assert.equal(selectionListStyle(s, false).value, "square");
  assert.match(html(s), /^<ul style="list-style-type:square;/);
  // the level's own style is not stored
  s = run(stateAt(d, pos(d, "a")), setListStyle(false, "disc"));
  assert.equal(s.doc.child(0).attrs.listStyle, null);
  s = run(stateAt(d, pos(d, "b")), setListStyle(false, "circle"));
  assert.equal(s.doc.child(0).child(0).child(1).attrs.listStyle, null, "circle is the second level's own");
  s = run(stateAt(d, pos(d, "b")), setListStyle(false, "disc"));
  assert.equal(s.doc.child(0).child(0).child(1).attrs.listStyle, "disc");
  assert.equal(s.doc.child(0).attrs.listStyle, null, "only the list the caret is in");
  // a selection over the three levels sets each of their innermost lists
  s = run(stateAt(d, pos(d, "a"), pos(d, "c", 1)), setListStyle(false, "square"));
  assert.match(html(s), /^<ul style="list-style-type:square;[^>]*><li>a<ul style="list-style-type:square;[^>]*><li>b<ul style="list-style-type:square;/, "the same marker on all three levels");
  // numbering: the kind decides which names are accepted
  const o = doc(OL(LI(P("x")), LI(P("y"))));
  assert.equal(listKind(stateAt(o, pos(o, "x"))), "ordered");
  assert.equal(run(stateAt(o, pos(o, "x")), setListStyle(false, "square")), null, "a bullet style on a numbered list is not this command's business");
  s = run(stateAt(o, pos(o, "x")), setListStyle(true, "upper-alpha"));
  assert.equal(s.doc.child(0).attrs.listStyle, "upper-alpha");
  assert.equal(s.doc.child(0).attrs.type, null, "the editor's own type attribute does not disagree");
  assert.match(html(s), /^<ol type="A" style="list-style-type:upper-alpha;/);
  assert.equal(selectionListStyle(s, true).value, "upper-alpha");
  assert.equal(selectionListStyle(s, false).value, null, "no bullet list in the selection");
  s = run(s, setListStyle(true, "lower-roman"));
  assert.match(html(s), /^<ol type="i" style="list-style-type:lower-roman;/);
  s = run(s, setListStyle(true, null));
  assert.equal(s.doc.child(0).attrs.listStyle, null, "back to the level's own");
  // not in a list: nothing to set
  const p = doc(P("plain"));
  assert.equal(run(stateAt(p, 2), setListStyle(false, "disc")), null);
  assert.equal(listKind(stateAt(p, 2)), null);
}

// ---- which blocks
{
  const d = doc(P("a"), UL(LI(P("b"), UL(LI(P("c"))))), P("d"));
  assert.deepEqual(textblocksOf(stateAt(d, pos(d, "a"), pos(d, "d", 1))).map((b) => b.node.textContent), ["a", "b", "c", "d"]);
  assert.deepEqual(textblocksOf(stateAt(d, pos(d, "c", 0))).map((b) => b.node.textContent), ["c"]);
}

// ---- text direction (REQ-43, AC-66)
{
  const d = doc(P("one"), P("two"), H(2, "head"), UL(LI(P("item1"), UL(LI(P("item2")))), LI(P("item3"))), P("tail"));
  // a paragraph: right-to-left with the caret in it, only that one
  let s = run(stateAt(d, pos(d, "two", 1)), setDirection("rtl"));
  assert.equal(attrsOf(s, "two").direction, "rtl");
  assert.equal(attrsOf(s, "one").direction, null);
  assert.deepEqual(selectionDirection(s), { mixed: false, value: "rtl" });
  assert.match(html(s), /<p dir="rtl" style="margin:0;direction:rtl;text-align:right">two<\/p>/, "dir, direction and the alignment it implies");
  assert.deepEqual(selectionAlign(s), { mixed: false, value: "right" }, "the alignment icon shows right in a right-to-left paragraph");
  // left-to-right again
  s = run(s, setDirection(null));
  assert.equal(attrsOf(s, "two").direction, null);
  assert.equal(html(s), html(stateAt(d, 1)), "back to the document it was");
  // right-to-left: "left" is a choice, "right" is the default; back to left-to-right drops the "left"
  s = run(stateAt(d, pos(d, "two", 1)), setDirection("rtl"));
  s = run(s, setAlign("left"));
  assert.equal(attrsOf(s, "two").textAlign, "left");
  assert.match(html(s), /direction:rtl;text-align:left">two/);
  assert.deepEqual(selectionAlign(s), { mixed: false, value: "left" });
  s = run(s, setAlign("right"));
  assert.equal(attrsOf(s, "two").textAlign, null, "right is the default of a right-to-left paragraph");
  s = run(s, setAlign("center"));
  assert.match(html(s), /text-align:center">two/);
  s = run(run(s, setAlign("left")), setDirection(null));
  assert.equal(attrsOf(s, "two").textAlign, null, "the 'left' of a right-to-left paragraph does not stay when it is left-to-right again");
  // a selection over a paragraph and a heading
  s = run(stateAt(d, pos(d, "two", 1), pos(d, "head", 2)), setDirection("rtl"));
  assert.equal(attrsOf(s, "two").direction, "rtl");
  assert.equal(attrsOf(s, "head").direction, "rtl");
  assert.match(html(s), /<h2 dir="rtl" style="font-size:14pt;font-weight:bold;margin:12pt 0 4pt;direction:rtl;text-align:right">head<\/h2>/);
  // mixed
  s = run(stateAt(d, pos(d, "one", 1), pos(d, "two", 1)), setDirection("rtl"));
  s = run(stateAt(s.doc, pos(s.doc, "one", 1), pos(s.doc, "tail", 1)), (st, dispatch) => (dispatch?.(st.tr), true));
  assert.equal(selectionDirection(s).mixed, true);
  // a list: the whole list changes, the lists in it too, the items keep no direction of their own
  s = run(stateAt(d, pos(d, "item3", 0)), setDirection("rtl"));
  const lists = [];
  s.doc.descendants((n) => void (n.type.name === "bulletList" && lists.push(n.attrs.direction)));
  assert.deepEqual(lists, ["rtl", "rtl"], "the outer list and the one in it");
  assert.equal(attrsOf(s, "item1").direction, null);
  assert.match(html(s), /<ul dir="rtl" style="list-style-type:disc;margin:0 40px 0 0;padding:0;direction:rtl"><li>item1<ul dir="rtl" style="list-style-type:circle;margin:0 40px 0 0;padding:0;direction:rtl"><li>item2<\/li><\/ul><\/li><li>item3<\/li><\/ul>/);
  assert.deepEqual(selectionDirection(stateAt(s.doc, pos(s.doc, "item2", 0))), { mixed: false, value: "rtl" }, "an item takes the direction of its list");
  s = run(stateAt(s.doc, pos(s.doc, "item1", 0)), setDirection(null));
  assert.equal(html(s), html(stateAt(d, 1)), "the whole list back");
  // the indent is on the right of a right-to-left paragraph
  const ind = doc(P("x", { direction: "rtl", indent: 2 }));
  assert.match(docToHtml(ind.toJSON()), /<p dir="rtl" style="margin:0 80px 0 0;direction:rtl;text-align:right">x<\/p>/);
}

console.log("block-commands: all checks passed");
