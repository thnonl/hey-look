// The quote block of a reply / forward must survive the keys and gestures around it (spec-rich-text.md REQ-35, AC-60, AC-62; compose-test-plan D-07 / F-05 family):
// typing, pasting or Enter while it is selected go below it, Backspace / Delete next to it never touch it, Delete on the selection removes it and one Undo brings it
// back, a copied block is not pasted as a second one, there is never more than one. Pure ProseMirror state (no DOM): the very plugin the editor uses.
// Run: node --experimental-strip-types scripts/test-quote-guard.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Fragment, Schema, Slice } from "@tiptap/pm/model";
import { AllSelection, EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { quoteGuard } from "../src/editor/quoteGuard.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    signatureBlock: { group: "block", atom: true, selectable: false, toDOM: () => ["div"] },
    quoteBlock: { group: "block", atom: true, selectable: true, attrs: { html: { default: "" } }, toDOM: () => ["div"] },
    text: { group: "inline" },
  },
});
const N = schema.nodes;
const p = (text) => N.paragraph.create(null, text ? schema.text(text) : undefined);
const sig = () => N.signatureBlock.create();
const quote = (html = "<p>orig</p>") => N.quoteBlock.create({ html });
const doc = (...kids) => N.doc.create(null, kids);
const names = (d) => d.content.content.map((n) => (n.type.name === "paragraph" ? `p(${n.textContent})` : n.type.name)).join(" ");
const mk = (d) => EditorState.create({ doc: d, plugins: [history(), quoteGuard()] });
const guard = (state) => state.plugins.at(-1);
const view = (state, box) => ({ state, dispatch: (tr) => (box.state = state.apply(tr)) });
const sel = (state, pos) => state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
const caret = (state, text, offset = 0) => {
  let at = -1;
  state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === text && at < 0) at = pos + 1 + offset; });
  assert.ok(at >= 0, `paragraph ${text}`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
};
const key = (state, k, extra = {}) => {
  const box = { state };
  const handled = guard(state).props.handleKeyDown(view(state, box), { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  return { handled, state: box.state };
};
const quotes = (d) => { let n = 0; d.descendants((x) => { if (x.type.name === "quoteBlock") n++; }); return n; };

// the usual body of a reply: text, signature region, the quote, an empty line below (the editor keeps one)
const reply = () => doc(p("Hello"), sig(), quote(), p(""));

// 1. typing on the selected block goes below it (into the paragraph that follows), the block stays
{
  const s = sel(mk(reply()), 8); // p(Hello) = 7, the signature region = 1: the block starts at 8
  const box = { state: s };
  assert.equal(guard(s).props.handleTextInput(view(s, box), 8, 9, "x"), true);
  assert.equal(names(box.state.doc), "p(Hello) signatureBlock quoteBlock p(x)", names(box.state.doc));
  assert.ok(box.state.selection instanceof TextSelection && box.state.selection.from === box.state.doc.content.size - 1, "the caret is after the typed letter");
  // not on a text selection
  assert.equal(guard(s).props.handleTextInput(view(caret(mk(reply()), "Hello"), {}), 1, 1, "x"), false);
  // no paragraph below: a new one
  const bare = sel(mk(doc(p("a"), sig(), quote())), 4);
  const b2 = { state: bare };
  assert.equal(guard(bare).props.handleTextInput(view(bare, b2), 4, 5, "z"), true);
  assert.equal(names(b2.state.doc), "p(a) signatureBlock quoteBlock p(z)");
}

// 2. Enter on the selected block: the caret goes below it, nothing is replaced, no extra line is made when one is there
{
  const s = sel(mk(reply()), 8);
  const r = key(s, "Enter");
  assert.equal(r.handled, true);
  assert.equal(names(r.state.doc), "p(Hello) signatureBlock quoteBlock p()");
  assert.ok(r.state.selection instanceof TextSelection);
  assert.equal(key(s, "Enter", { shiftKey: true }).handled, false, "Shift+Enter is the editor's");
  assert.equal(key(caret(mk(reply()), "Hello"), "Enter").handled, false, "Enter in text is the editor's");
}

// 3. a paste on the selected block lands below it
{
  const s = sel(mk(reply()), 8);
  const box = { state: s };
  assert.equal(guard(s).props.handlePaste(view(s, box)), false, "the default paste goes on...");
  assert.ok(box.state.selection instanceof TextSelection, "...from a caret below the block");
  assert.equal(quotes(box.state.doc), 1);
}

// 4. Backspace at the start of the text below the block, Delete at the end of the text above it: nothing happens (the block would be selected, then deleted by a second key)
{
  const below = mk(doc(p("Hello"), sig(), quote(), p("below")));
  assert.equal(key(caret(below, "below", 0), "Backspace").handled, true);
  assert.equal(key(caret(below, "below", 2), "Backspace").handled, false, "inside the text it is the editor's");
  const above = mk(doc(p("x"), quote(), p("y")));
  assert.equal(key(caret(above, "x", 1), "Delete").handled, true);
  assert.equal(key(caret(above, "x", 0), "Delete").handled, false);
  // an empty line goes as usual
  const emptyBelow = mk(doc(p("a"), quote(), p("")));
  let at = -1;
  emptyBelow.doc.descendants((n, pos) => { if (n.isTextblock && n.content.size === 0 && at < 0) at = pos + 1; });
  assert.equal(key(emptyBelow.apply(emptyBelow.tr.setSelection(TextSelection.create(emptyBelow.doc, at))), "Backspace").handled, false, "an empty line below the block: Backspace is the editor's");
  // other keys
  assert.equal(key(caret(below, "below", 0), "a").handled, false);
}

// 5. Delete on the selected block removes it (the editor's own deleteSelection), one Undo brings it back identical
{
  let s = sel(mk(doc(p("Hello"), sig(), quote("<p>X</p>"), p(""))), 8);
  const before = s.doc.child(2).attrs.html;
  s = s.apply(s.tr.deleteSelection());
  assert.equal(quotes(s.doc), 0);
  undo(s, (tr) => (s = s.apply(tr)));
  assert.equal(quotes(s.doc), 1);
  assert.equal(s.doc.child(2).attrs.html, before);
}

// 6. a copied block is not pasted back (transformPasted), a second block never stays (appendTransaction)
{
  const s = mk(reply());
  const slice = new Slice(Fragment.from([p("a"), quote("<p>copy</p>"), p("b")]), 0, 0);
  const out = guard(s).props.transformPasted(slice);
  assert.equal(out.content.childCount, 2);
  assert.ok(out.content.content.every((n) => n.type.name === "paragraph"));
  const keep = new Slice(Fragment.from([p("only text")]), 0, 0);
  assert.equal(guard(s).props.transformPasted(keep), keep, "a slice without a block is left as it is");
  // two blocks (from anything): the first stays
  let t = mk(reply());
  t = t.apply(t.tr.insert(t.doc.content.size, quote("<p>second</p>")));
  assert.equal(quotes(t.doc), 1, "the second block is removed");
  assert.equal(t.doc.child(2).attrs.html, "<p>orig</p>", "the first one stays");
}

// 7. select all + type replaces everything the person can see (the signature region is the signature guard's job); the block goes with it, and Undo brings it back
{
  let s = mk(reply());
  s = s.apply(s.tr.setSelection(new AllSelection(s.doc)));
  s = s.apply(s.tr.insertText("new"));
  assert.equal(quotes(s.doc), 0);
  undo(s, (tr) => (s = s.apply(tr)));
  assert.equal(quotes(s.doc), 1);
}

// 8. the wiring: the node is part of the kit and the plugin is the one the node installs
const node = readFileSync(new URL("../src/editor/quoteNode.ts", import.meta.url), "utf8");
assert.ok(node.includes("quoteGuard()") && node.includes("atom: true") && node.includes("draggable: false") && node.includes("selectable: true"));
const kit = readFileSync(new URL("../src/editor/kitExtensions.ts", import.meta.url), "utf8");
assert.ok(kit.includes("QuoteBlock.configure"));
console.log("test-quote-guard: all passed");
