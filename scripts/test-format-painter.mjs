// Format painter (spec-107-wp3.md W3.1, AC-3.1.1 .. AC-3.1.12): the state machine, the pick-up (marks of the first character / of a caret, the paragraph rule), the paint on real documents built from
// the editor's own schema (replaces and does not merge, links stay, the paragraph formats on every touched paragraph also in list items and table cells, the list and the table unchanged, the Code
// style, the signature region and the reply quote untouched, one undo step), and the plugin on a fake view with the history plugin (the end conditions, Esc, Ctrl+Shift+D).
// Run: node --experimental-strip-types scripts/test-format-painter.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Node as TipNode, getSchema } from "@tiptap/core";
import { Strike } from "@tiptap/extension-strike";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TextStyleKit } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { history, undo, redo } from "@tiptap/pm/history";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { BlockFormat } from "../src/editor/blockExtension.ts";
import { COPYABLE, FormatPainter, applyPainter, blocksBetween, nextMode, painterClick, painterKey, painterMode, painterShortcut, pickUp, wordAt, CURSOR } from "../src/editor/formatPainter.ts";
import { tableExtensions } from "../src/editor/tableExtension.ts";
import { BAR_META } from "../src/editor/toolbarLayout.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");

// ---- the state machine (REQ-3.1.1, REQ-3.1.5)
{
  const T = [
    ["off", "click", "once"], ["once", "click", "off"], ["sticky", "click", "off"],
    ["off", "dblclick", "sticky"], ["once", "dblclick", "sticky"], ["sticky", "dblclick", "sticky"],
    ["off", "key", "once"], ["once", "key", "once"], ["sticky", "key", "sticky"],
    ["once", "applied", "off"], ["sticky", "applied", "sticky"], ["off", "applied", "off"],
    ["once", "esc", "off"], ["sticky", "esc", "off"], ["once", "edit", "off"], ["sticky", "edit", "off"],
    ["once", "focusout", "off"], ["sticky", "focusout", "off"], ["once", "close", "off"], ["sticky", "close", "off"],
    ["once", "undo", "once"], ["sticky", "undo", "sticky"], ["once", "move", "once"], ["sticky", "move", "sticky"], ["off", "esc", "off"],
  ];
  for (const [from, ev, to] of T) assert.equal(nextMode(from, ev), to, `${from} + ${ev}`);
  // a click on the button followed by the second press of a double click: sticky
  assert.equal(nextMode(nextMode("off", "click"), "dblclick"), "sticky");
  // a double click while it was on: the first click turns it off, the second turns it on again, sticky
  assert.equal(nextMode(nextMode("once", "click"), "dblclick"), "sticky");
}

// ---- words
assert.deepEqual(wordAt("Alpha Beta", 2), [0, 5], "inside a word");
assert.deepEqual(wordAt("Alpha Beta", 0), [0, 5], "at the start of a word");
assert.deepEqual(wordAt("Alpha Beta", 5), [0, 5], "at the end of a word");
assert.deepEqual(wordAt("Alpha Beta", 6), [6, 10], "after the space");
assert.equal(wordAt("Alpha  Beta", 6), null, "between two spaces");
assert.equal(wordAt("", 0), null, "an empty paragraph");
assert.deepEqual(wordAt("x a1b2 y", 4), [2, 6], "digits are part of the word");
assert.deepEqual(wordAt("café go", 3), [0, 4], "an accented letter");
assert.deepEqual(wordAt("a \u{1D400}\u{1D401} b", 4), [2, 6], "a letter outside the BMP (two code units)");
assert.equal(wordAt("a, b", 2), null, "punctuation is no word");

// ---- the editor's schema
const Quote = TipNode.create({ name: "quoteBlock", group: "block", atom: true, addAttributes: () => ({ html: { default: "" } }) });
const Signature = TipNode.create({ name: "signatureBlock", group: "block", atom: true, selectable: false });
const schema = getSchema([
  StarterKit.configure({ strike: false, hardBreak: false, heading: { levels: [1, 2, 3] } }),
  Strike, Subscript, Superscript, TextStyleKit.configure({ lineHeight: false }), BlockFormat, ...tableExtensions(), Quote, Signature,
]);
assert.ok(COPYABLE.every((n) => schema.marks[n]), "every copyable mark is a mark of the schema");
const M = (name, attrs) => schema.marks[name].create(attrs);
const txt = (s, ...marks) => schema.text(s, marks);
const P = (attrs, ...kids) => schema.node("paragraph", attrs ?? null, kids);
const H = (level, attrs, ...kids) => schema.node("heading", { level, ...(attrs ?? {}) }, kids);
const doc = (...blocks) => schema.node("doc", null, blocks);
const stateOf = (d, from, to = from, plugins = [history()]) => {
  const st = EditorState.create({ doc: d, plugins });
  return st.apply(st.tr.setSelection(TextSelection.create(d, from, to)));
};
/** The position of the first occurrence of `word` in the document. */
function at(d, word, nth = 0) {
  let hit = -1, n = 0;
  d.descendants((node, pos) => {
    if (hit >= 0 || !node.isText) return;
    let i = -1;
    while ((i = node.text.indexOf(word, i + 1)) >= 0) if (n++ === nth) { hit = pos + i; return; }
  });
  assert.ok(hit >= 0, `no "${word}"`);
  return hit;
}
const sel = (d, word, nth = 0) => [at(d, word, nth), at(d, word, nth) + word.length];
const marksOf = (d, word, nth = 0) => d.nodeAt(at(d, word, nth)).marks.map((m) => m.type.name + (Object.keys(m.attrs).length ? JSON.stringify(Object.fromEntries(Object.entries(m.attrs).filter(([k, v]) => v !== null && (m.type.name !== "link" || k === "href")))) : "")).sort();
const apply = (st, src, opts) => {
  const r = applyPainter(st, src, opts);
  return { ...r, state: r.tr ? st.apply(r.tr) : st };
};
const fmt = [M("bold"), M("textStyle", { fontFamily: "Georgia, serif", fontSize: "14pt", color: "#FF0000" })];

// ---- AC-3.1.1 pick-up and paint: bold red 14 pt Georgia from "Alpha" onto "Gamma"
{
  const d = doc(P(null, txt("Alpha", ...fmt), txt(" Beta Gamma")));
  const src = pickUp(stateOf(d, ...sel(d, "Alpha")));
  assert.deepEqual(src.marks.map((m) => m.type.name).sort(), ["bold", "textStyle"]);
  assert.equal(src.block, null, "a word inside a paragraph copies the characters only");
  const r = apply(stateOf(d, ...sel(d, "Gamma")), src);
  assert.ok(r.targeted);
  assert.deepEqual(marksOf(r.state.doc, "Gamma"), marksOf(d, "Alpha"), "Gamma has what Alpha has");
  assert.deepEqual(marksOf(r.state.doc, "Beta"), [], "Beta is untouched");
  assert.deepEqual([r.state.selection.from, r.state.selection.to], sel(r.state.doc, "Gamma"), "the painted text stays selected");
  // the HTML the sent message holds comes from the marks: the same attributes on both words
  assert.equal(JSON.stringify(r.state.doc.nodeAt(at(r.state.doc, "Gamma")).marks.map((m) => m.toJSON())), JSON.stringify(d.nodeAt(at(d, "Alpha")).marks.map((m) => m.toJSON())));
}

// ---- AC-3.1.3 replace, not merge; links stay
{
  const link = M("link", { href: "https://a.test" });
  const d = doc(P(null, txt("plain"), txt(" "), txt("target", M("italic"), M("textStyle", { backgroundColor: "#FFFF00" })), txt(" "), txt("site", link)));
  const src = pickUp(stateOf(d, ...sel(d, "plain")));
  assert.deepEqual(src.marks, []);
  const r = apply(stateOf(d, ...sel(d, "target")), src);
  assert.deepEqual(marksOf(r.state.doc, "target"), [], "neither italic nor highlighted any more");
  const bold = pickUp(stateOf(doc(P(null, txt("b", M("bold")))), 1, 2));
  const r2 = apply(stateOf(d, ...sel(d, "site")), bold);
  assert.deepEqual(marksOf(r2.state.doc, "site"), ["bold", "link" + JSON.stringify({ href: "https://a.test" })].sort(), "bold and still a link");
  // inline code is neither copied nor removed
  const dc = doc(P(null, txt("code", M("code")), txt(" x")));
  const r3 = apply(stateOf(dc, ...sel(dc, "code")), bold);
  assert.deepEqual(marksOf(r3.state.doc, "code"), ["code"], "inline code stays code");
  assert.deepEqual(pickUp(stateOf(dc, ...sel(dc, "code"))).marks, [], "inline code is not copied");
}

// ---- the first character of the selection gives the marks; a caret gives the stored marks, else the marks at the caret
{
  const d = doc(P(null, txt("ab", M("bold")), txt("cd", M("italic"))));
  assert.deepEqual(pickUp(stateOf(d, 2, 5)).marks.map((m) => m.type.name), ["bold"], "the first character of the selection");
  assert.deepEqual(pickUp(stateOf(d, 3, 3)).marks.map((m) => m.type.name), ["bold"], "at the join the caret has the marks of the text before it");
  const st = stateOf(d, 5, 5);
  const stored = st.apply(st.tr.setStoredMarks([M("underline")]));
  assert.deepEqual(pickUp(stored).marks.map((m) => m.type.name), ["underline"], "stored marks win at a caret");
  assert.deepEqual(pickUp(stateOf(d, 1, 3)).marks.map((m) => m.type.name), ["bold"]);
  // a selection that starts with a picture-less gap: the first text counts
  const dp = doc(P(null, txt("zz")), P(null, txt("yy", M("italic"))));
  assert.deepEqual(pickUp(stateOf(dp, 1, 7)).marks.map((m) => m.type.name), []);
}

// ---- AC-3.1.4 the paragraph rule
{
  const centred = { textAlign: "center", lineHeight: "1.5", indent: 2, spaceAfter: "add" };
  const d = doc(P(centred, txt("Alpha ", M("bold"), M("textStyle", { color: "#FF0000" })), txt("beta")), P(null, txt("left words here")), P(null, txt("second left")));
  // a caret: the paragraph formats come along
  const caret = pickUp(stateOf(d, at(d, "Alpha") + 2));
  assert.ok(caret.block, "a caret copies the paragraph");
  assert.deepEqual([caret.block.style, caret.block.attrs.textAlign, caret.block.attrs.lineHeight, caret.block.attrs.indent, caret.block.attrs.spaceAfter], ["normal", "center", "1.5", 2, "add"]);
  const r = apply(stateOf(d, ...sel(d, "words")), caret);
  const target = r.state.doc.child(1);
  assert.deepEqual([target.attrs.textAlign, target.attrs.lineHeight, target.attrs.indent, target.attrs.spaceAfter], ["center", "1.5", 2, "add"], "the whole paragraph is centred with spacing 1.5");
  assert.deepEqual(marksOf(r.state.doc, "words"), ["bold", 'textStyle{"color":"#FF0000"}'], "and the word is bold red");
  assert.deepEqual(marksOf(r.state.doc, "left"), [], "the other words of the paragraph keep their format");
  // part of the paragraph: characters only
  const part = pickUp(stateOf(d, ...sel(d, "Alpha")));
  assert.equal(part.block, null, "part of one paragraph copies the characters only");
  const r2 = apply(stateOf(d, ...sel(d, "second")), part);
  assert.equal(r2.state.doc.child(2).attrs.textAlign, null, "the paragraph stays left-aligned");
  assert.deepEqual(marksOf(r2.state.doc, "second"), ["bold", 'textStyle{"color":"#FF0000"}']);
  // a whole paragraph
  const whole = pickUp(stateOf(d, 1, 1 + d.child(0).content.size));
  assert.ok(whole.block, "a selection that covers a whole paragraph copies it");
  // a triple click ends at the start of the next paragraph
  const triple = pickUp(stateOf(d, 1, d.child(0).nodeSize + 1));
  assert.ok(triple.block && triple.block.attrs.textAlign === "center", "a triple click selection is the paragraph");
  // two paragraphs
  const two = pickUp(stateOf(d, at(d, "beta"), at(d, "words")));
  assert.ok(two.block, "several paragraphs copy the first one's formats");
  assert.equal(two.block.attrs.textAlign, "center");
}

// ---- the style: a heading, the Code style, a quote
{
  const d = doc(H(2, { textAlign: "right" }, txt("Heading")), P(null, txt("body one")), P(null, txt("body two")));
  const src = pickUp(stateOf(d, at(d, "Heading") + 2));
  assert.deepEqual([src.block.style, src.block.attrs.textAlign], ["h2", "right"]);
  const r = apply(stateOf(d, ...sel(d, "body one")), src);
  assert.deepEqual([r.state.doc.child(1).type.name, r.state.doc.child(1).attrs.level, r.state.doc.child(1).attrs.textAlign], ["heading", 2, "right"], "Heading 2, right aligned");
  assert.equal(r.state.doc.child(2).type.name, "paragraph", "the next paragraph is not the target");
  // Normal onto a heading
  const dn = doc(P(null, txt("plain")), H(1, null, txt("Title")));
  const rn = apply(stateOf(dn, ...sel(dn, "Title")), pickUp(stateOf(dn, 3)));
  assert.equal(rn.state.doc.child(1).type.name, "paragraph", "a heading painted with Normal is a paragraph");
  // the Code style
  const dcode = doc(schema.node("codeBlock", null, [schema.text("let x")]), P({ textAlign: "center" }, txt("words")));
  const code = pickUp(stateOf(dcode, 3));
  assert.deepEqual([code.block.style, code.block.attrs], ["code", null]);
  const rc = apply(stateOf(dcode, ...sel(dcode, "words")), code);
  assert.equal(rc.state.doc.child(1).type.name, "codeBlock", "painted with the Code style");
  // a quote
  const dq = doc(schema.node("blockquote", null, [P(null, txt("quoted"))]), P(null, txt("target")));
  const quote = pickUp(stateOf(dq, 3));
  assert.equal(quote.block.style, "quote");
  const rq = apply(stateOf(dq, ...sel(dq, "target")), quote);
  assert.equal(rq.state.doc.lastChild.type.name === "blockquote" || rq.state.doc.childCount === 1, true, "the paragraph is quoted");
}

// ---- lists and tables: the paragraphs change, the list and the table do not; nothing of them is copied
{
  const li = (...ps) => schema.node("listItem", null, ps);
  const list = schema.node("bulletList", { listStyle: "square" }, [li(P(null, txt("item one"))), li(P(null, txt("item two")))]);
  const centred = P({ textAlign: "center", lineHeight: "2", indent: 3 }, txt("Source", M("italic")));
  const d = doc(centred, list);
  const src = pickUp(stateOf(d, 3));
  const r = apply(stateOf(d, at(d, "item one"), at(d, "item two") + 4), src);
  const l = r.state.doc.child(1);
  assert.equal(l.type.name, "bulletList");
  assert.equal(l.attrs.listStyle, "square", "the list style is unchanged");
  assert.equal(l.childCount, 2, "the list has its items");
  for (let i = 0; i < 2; i++) {
    const p = l.child(i).child(0);
    assert.deepEqual([p.attrs.textAlign, p.attrs.lineHeight, p.attrs.indent], ["center", "2", 0], `item ${i}: the paragraph formats, the indent of a list item is left alone`);
    assert.ok(p.firstChild.marks.some((m) => m.type.name === "italic"), `item ${i}: italic`);
  }
  // a list item as the source: it is not a list that is copied, and its indent does not travel
  const fromItem = pickUp(stateOf(doc(list, P({ indent: 1 }, txt("target"))), at(doc(list, P(null, txt("x"))), "item one") + 1));
  assert.equal(fromItem.block.attrs.indent, null, "the indent of a list item is not copied");
  const dd = doc(list, P({ indent: 1 }, txt("target")));
  const r2 = apply(stateOf(dd, ...sel(dd, "target")), fromItem);
  assert.equal(r2.state.doc.child(1).attrs.indent, 1, "the target keeps its indent");
  assert.equal(r2.state.doc.child(1).type.name, "paragraph", "a list item source does not make the target a list");
  // a table cell
  const cell = (t) => schema.node("tableCell", null, [P(null, txt(t))]);
  const table = schema.node("table", { borders: "all" }, [schema.node("tableRow", null, [cell("cell a"), cell("cell b")])]);
  const dt = doc(P({ textAlign: "right" }, txt("Src", M("bold"))), table);
  const rt = apply(stateOf(dt, ...sel(dt, "cell a")), pickUp(stateOf(dt, 3)));
  const row = rt.state.doc.child(1).child(0);
  assert.equal(rt.state.doc.child(1).type.name, "table");
  assert.equal(rt.state.doc.child(1).attrs.borders, "all", "the table is unchanged");
  assert.equal(row.childCount, 2);
  assert.equal(row.child(0).child(0).attrs.textAlign, "right", "the paragraph in the cell is right aligned");
  assert.ok(row.child(0).child(0).firstChild.marks.some((m) => m.type.name === "bold"));
  assert.equal(row.child(1).child(0).attrs.textAlign, null, "the other cell is untouched");
  // a cell selection of both cells paints both
  const dt2 = doc(table);
  let first = -1, second = -1;
  dt2.descendants((n, pos) => { if (n.type.name === "tableCell") (first < 0 ? (first = pos) : (second = pos)); });
  const st = EditorState.create({ doc: dt2, plugins: [history()] });
  const cs = st.apply(st.tr.setSelection(CellSelection.create(dt2, first, second)));
  const rcs = apply(cs, { marks: [M("bold")], block: null });
  assert.ok(rcs.targeted);
  let boldCells = 0;
  rcs.state.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === "bold")) boldCells++; });
  assert.equal(boldCells, 2, "a cell selection paints every cell");
}

// ---- protected parts: the signature region and the reply quote are not changed
{
  const d = doc(P(null, txt("body words")), Signature.type ? schema.node("signatureBlock") : null, schema.node("quoteBlock", { html: "<p>orig</p>" }), P(null, txt("below")));
  const bold = { marks: [M("bold")], block: { style: "h1", attrs: { textAlign: "center", direction: null, lineHeight: null, spaceAfter: null, indent: 0 } } };
  // a selection from the body into the quote and below: the body text and the text below are painted, the atoms are as they were
  const r = apply(stateOf(d, 2, d.content.size - 1), bold);
  assert.ok(r.targeted);
  assert.equal(r.state.doc.child(1).type.name, "signatureBlock", "the signature region is still there");
  assert.equal(r.state.doc.child(2).attrs.html, "<p>orig</p>", "the quote keeps its HTML");
  assert.equal(r.state.doc.child(0).type.name, "heading");
  // only the quote selected as a node: nothing to paint, the painter keeps its state
  const only = EditorState.create({ doc: d, plugins: [history()] });
  const ns = only.apply(only.tr.setSelection(NodeSelection.create(d, d.child(0).nodeSize + d.child(1).nodeSize)));
  const r2 = applyPainter(ns, bold);
  assert.deepEqual([r2.tr, r2.targeted], [null, false], "a selected quote is not a target");
  // a picture alone is not a target either
  const pic = schema.nodes.image;
  if (pic) {
    const dp = doc(P(null, schema.node("image", { src: "data:image/png;base64,AA" })));
    const rp = applyPainter(stateOf(dp, 1, 2), bold);
    assert.equal(rp.targeted && rp.state, undefined);
  }
  assert.deepEqual(blocksBetween(d, 0, d.content.size).map((b) => b.node.type.name), ["paragraph", "paragraph"], "the blocks of the document without the atoms");
}

// ---- the click rule: the caret paints a word; no word, no text change but the paragraph and the stored marks
{
  const d = doc(P({ textAlign: "center" }, txt("Gamma value")), P(null), P(null, txt("left")));
  const src = { marks: [M("bold")], block: { style: "normal", attrs: { textAlign: "right", direction: null, lineHeight: null, spaceAfter: null, indent: 0 } } };
  const st = stateOf(d, at(d, "Gamma") + 2);
  const word = apply(st, src, { word: [at(d, "Gamma"), at(d, "Gamma") + 5] });
  assert.deepEqual(marksOf(word.state.doc, "Gamma"), ["bold"], "the whole word is painted");
  assert.deepEqual(marksOf(word.state.doc, "value"), [], "only that word");
  assert.equal(word.state.doc.child(0).attrs.textAlign, "right", "and the paragraph");
  assert.deepEqual([word.state.selection.from, word.state.selection.to], sel(word.state.doc, "Gamma"), "the word stays selected");
  // an empty paragraph: no text changes, the paragraph is set, the next typed character is bold
  const empty = stateOf(d, d.child(0).nodeSize + 1);
  const r = apply(empty, src);
  assert.equal(r.targeted, true);
  assert.equal(r.state.doc.child(1).attrs.textAlign, "right");
  assert.equal(r.state.doc.child(1).content.size, 0);
  assert.deepEqual(r.state.storedMarks.map((m) => m.type.name), ["bold"], "the next typed character gets the characters' formatting");
  // the stored marks keep a link or code the caret was in, and drop the copyable ones
  const dl = doc(P(null, txt("go", M("link", { href: "https://a.test" }), M("italic"))));
  const inLink = stateOf(dl, 2);
  const r2 = apply(inLink, { marks: [M("bold")], block: null });
  assert.deepEqual(r2.state.storedMarks.map((m) => m.type.name).sort(), ["bold", "link"], "link stays, italic goes, bold comes");
}

// ---- AC-3.1.6 one undo step
{
  const d = doc(P({ textAlign: "left" }, txt("Source", ...fmt)), P(null, txt("one two three")));
  const src = pickUp(stateOf(d, 3));
  const st = stateOf(d, at(d, "one"), at(d, "three") + 5);
  const r = applyPainter(st, { ...src, block: { style: "h1", attrs: { textAlign: "center", direction: null, lineHeight: "2", spaceAfter: null, indent: 0 } } });
  const painted = st.apply(r.tr);
  assert.notDeepEqual(painted.doc.toJSON(), st.doc.toJSON());
  const back = [];
  undo(painted, (tr) => back.push(tr));
  assert.equal(back.length, 1);
  assert.deepEqual(painted.apply(back[0]).doc.toJSON(), st.doc.toJSON(), "one Ctrl+Z restores the whole target: the style, the paragraph formats and the characters");
}

// ---- the plugin on a fake view
function editor(d, plugins = []) {
  const ext = FormatPainter;
  const plugin = ext.config.addProseMirrorPlugins.call(ext);
  const view = {
    isDestroyed: false,
    state: EditorState.create({ doc: d, plugins: [history(), ...plugin, ...plugins] }),
    dispatch(tr) { this.state = this.state.apply(tr); },
    dom: { contains: () => false, ownerDocument: null },
  };
  view.select = (a, b = a) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a, b)));
  view.mode = () => painterMode(view.state);
  view.plug = view.state.plugins.find((p) => p.spec.key === painterKey);
  view.editor = { view };
  return view;
}
{
  const d = doc(P(null, txt("Alpha", ...fmt), txt(" Beta Gamma")));
  const v = editor(d);
  assert.equal(v.mode(), "off");
  v.select(...sel(d, "Alpha"));
  painterClick(v.editor, 1);
  assert.equal(v.mode(), "once", "a click turns it on once");
  // the pointer: the editor gets the class and the brush while it is on
  assert.deepEqual(Object.keys(v.plug.props.attributes(v.state)), ["class", "style"]);
  assert.equal(v.plug.props.attributes(v.state).class, "fmt-painting");
  assert.ok(v.plug.props.attributes(v.state).style.includes("--fmt-cursor:url("), "the cursor is an inline data: image");
  assert.ok(/^url\("data:image\/svg\+xml,[^"]+"\) \d+ \d+, copy$/.test(CURSOR), "a data: SVG with a hotspot and the fallback copy");
  // caret moves and keyboard selections keep it
  v.select(at(d, "Gamma"), at(d, "Gamma") + 5);
  assert.equal(v.mode(), "once", "a keyboard selection never applies by itself");
  // Ctrl+Shift+D at a selection paints it and (once) switches off
  assert.equal(painterShortcut(v), true);
  assert.equal(v.mode(), "off", "applied once: off");
  assert.deepEqual(marksOf(v.state.doc, "Gamma"), marksOf(d, "Alpha"), "Gamma is painted");
  assert.equal(v.plug.props.attributes(v.state).class, undefined, "the pointer is normal again");
  // the key when off picks up
  v.select(...sel(v.state.doc, "Alpha"));
  assert.equal(painterShortcut(v), true);
  assert.equal(v.mode(), "once", "the key when off switches it on");
  // Esc: off, and the key press is consumed
  let stopped = false;
  assert.equal(v.plug.props.handleKeyDown(v, { key: "Escape", stopPropagation: () => (stopped = true) }), true);
  assert.equal(v.mode(), "off");
  assert.ok(stopped, "Esc does nothing else on that press");
  assert.equal(v.plug.props.handleKeyDown(v, { key: "Escape", stopPropagation: () => assert.fail("not ours") }), false, "off: Esc is not ours");
}
{
  // sticky: paints several targets, stays on, Undo does not switch it off, Esc does
  const d = doc(P(null, txt("Src", M("bold"))), P(null, txt("one")), P(null, txt("two")), P(null, txt("three")));
  const v = editor(d);
  v.select(...sel(d, "Src"));
  painterClick(v.editor, 1);
  painterClick(v.editor, 2);
  assert.equal(v.mode(), "sticky", "a double click keeps it on");
  for (const w of ["one", "two", "three"]) {
    v.select(...sel(v.state.doc, w));
    painterShortcut(v);
    assert.deepEqual(marksOf(v.state.doc, w), ["bold"], `${w} painted`);
    assert.equal(v.mode(), "sticky");
  }
  undo(v.state, (tr) => v.dispatch(tr));
  assert.equal(v.mode(), "sticky", "Ctrl+Z does not switch it off (a wrong paint can be undone)");
  assert.deepEqual(marksOf(v.state.doc, "three"), [], "and the last paint is undone");
  redo(v.state, (tr) => v.dispatch(tr));
  assert.equal(v.mode(), "sticky", "Redo neither");
  v.plug.props.handleKeyDown(v, { key: "Escape", stopPropagation() {} });
  assert.equal(v.mode(), "off");
}
{
  // AC-3.1.8: typing, Backspace, a formatting command, a stored mark, a paste end it
  const d = doc(P(null, txt("Src", M("bold")), txt(" word")));
  const on = () => {
    const v = editor(d);
    v.select(...sel(d, "Src"));
    painterClick(v.editor, 1);
    assert.equal(v.mode(), "once");
    return v;
  };
  let v = on();
  v.dispatch(v.state.tr.insertText("x"));
  assert.equal(v.mode(), "off", "typing a character");
  v = on();
  v.dispatch(v.state.tr.delete(1, 2));
  assert.equal(v.mode(), "off", "Backspace / Delete");
  v = on();
  v.dispatch(v.state.tr.addMark(5, 9, M("italic")));
  assert.equal(v.mode(), "off", "a formatting command");
  v = on();
  v.dispatch(v.state.tr.setStoredMarks([M("underline")]));
  assert.equal(v.mode(), "off", "a toolbar control at a caret");
  v = on();
  v.dispatch(v.state.tr.insertText("paste").setMeta("uiEvent", "paste"));
  assert.equal(v.mode(), "off", "a paste");
  v = on();
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)));
  v.dispatch(v.state.tr.scrollIntoView());
  assert.equal(v.mode(), "once", "a caret move and a scroll keep it");
  // not applicable: a picture selected keeps the state
  const dp = doc(P(null, txt("a"), schema.nodes.image ? schema.node("image", { src: "data:image/png;base64,AA" }) : txt("b")));
  if (schema.nodes.image) {
    const vp = editor(dp);
    vp.select(1, 2);
    painterClick(vp.editor, 1);
    vp.dispatch(vp.state.tr.setSelection(NodeSelection.create(vp.state.doc, 2)));
    painterShortcut(vp);
    assert.equal(vp.mode(), "once", "a selected picture is not a target: the painter keeps its state");
  }
}
{
  // the editor without the plugin: the toolbar's calls do nothing
  const v = { state: EditorState.create({ doc: doc(P(null, txt("a"))) }) };
  v.editor = { view: v };
  assert.equal(painterMode(v.state), "off");
  painterClick(v.editor, 1);
  assert.equal(painterShortcut(v), false);
}

// ---- the wiring
{
  assert.deepEqual(BAR_META.painter, { group: "clipboard", order: 10, priority: 185, width: 28, variants: ["compose", "compact"] }, "BAR_META.painter");
  assert.ok(BAR_META.painter.priority > BAR_META.insert.priority && BAR_META.painter.priority < BAR_META.clear.priority, "after Insert, before Clear formatting");
  assert.ok(BAR_META.painter.order > BAR_META.redo.order && BAR_META.painter.order < BAR_META.font.order, "right after Undo / Redo, before Font");
  const ctl = read("src/editor/controls.tsx");
  assert.ok(/Paintbrush/.test(ctl) && /id: "painter"/.test(ctl) && /on=\{c\.st\.painter !== "off"\}/.test(ctl), "the control shows the pressed state");
  assert.ok(/kind: "check", checked: c\.st\.painter !== "off"/.test(ctl) && /hint: kbd\("Ctrl\+Shift\+D"\)/.test(ctl), "the More row is a check row with the key");
  assert.ok(/run\(e\.detail\)/.test(ctl), "the button tells a double click from a click");
  const ext = read("src/editor/extensions.ts");
  assert.ok(/^\s*FormatPainter,$/m.test(ext), "baseExtensions has the painter");
  const dlg = read("src/components/SettingsDialog.tsx");
  assert.ok(/\["Shift\+F3", "compose\.fmt\.case"\], \["Ctrl\+Shift\+D", "compose\.fmt\.painter"\]/.test(dlg), "Settings > Shortcuts: the row right after Shift+F3");
  const bar = read("src/editor/FormatBar.tsx");
  assert.ok(/role="status" aria-live="polite"/.test(bar) && /compose\.painter\.onSticky/.test(bar), "the live message");
  const css = read("src/App.css");
  assert.ok(/\.ProseMirror\.fmt-painting, \.ProseMirror\.fmt-painting \* \{ cursor: var\(--fmt-cursor, copy\); \}/.test(css), "the cursor class");
  const budget = JSON.parse(read("scripts/bundle-budget.json"));
  assert.ok(budget.mustBeLazy.some((m) => m.module === "src/editor/formatPainter.ts" && m.since === "1.0.7"), "formatPainter.ts must stay lazy");
  const painter = read("src/editor/formatPainter.ts");
  assert.ok(!/from "\.\.\/(store|i18n)/.test(painter), "no store in the painter: it is pure ProseMirror");
}
console.log("test-format-painter: ok");
