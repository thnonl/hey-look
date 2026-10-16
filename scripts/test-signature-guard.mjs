// The signature region of the compose body (F-26b / F-26c). Deleting the only picture above it left a body with nothing to type in, and
// Backspace under it deleted the region, which a guard then put back at the END of the document ("the signature moves down").
// Now the region never moves: a missing one is restored where it was, a paragraph above it always exists, there is only one, and
// Backspace / Delete at its edges only move the caret. Pure ProseMirror state (no DOM), same plugin the editor uses.
// Run: node --experimental-strip-types scripts/test-signature-guard.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection, AllSelection } from "@tiptap/pm/state";
import { history, undo, redo } from "@tiptap/pm/history";
import { repairSignature, signatureGuard } from "../src/signatureGuard.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    blockquote: { group: "block", content: "block+", toDOM: () => ["blockquote", 0] },
    image: { group: "block", atom: true, toDOM: () => ["img"] },
    signatureBlock: { group: "block", atom: true, selectable: false, toDOM: () => ["div"] },
    text: { group: "inline" },
  },
});
const N = schema.nodes;
const p = (text) => N.paragraph.create(null, text ? schema.text(text) : undefined);
const doc = (...kids) => N.doc.create(null, kids);
const sig = () => N.signatureBlock.create();
const img = () => N.image.create();
const names = (d) => d.content.content.map((n) => (n.type.name === "paragraph" ? `p(${n.textContent})` : n.type.name === "blockquote" ? `q(${n.textContent})` : n.type.name)).join(" ");

const mk = (d) => EditorState.create({ doc: d, plugins: [history(), signatureGuard("signatureBlock")] });
const run = (state, fn) => { const tr = state.tr; fn(tr); return state.apply(tr); };
const sigCount = (d) => { let n = 0; d.descendants((x) => { if (x.type.name === "signatureBlock") n++; }); return n; };
const key = (state, k) => { let next = state; const handled = state.plugins.at(-1).props.handleKeyDown({ state, dispatch: (tr) => (next = state.apply(tr)) }, { key: k }); return { handled, state: next }; };
const caretAt = (state, text, offset = 0) => { let at = -1; state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === text && at < 0) at = pos + 1 + offset; }); assert.ok(at >= 0, `paragraph ${text}`); return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at))); };

// 1. F-26b: delete the only picture that sits above the signature -> an empty paragraph is there to type in
{
  let s = mk(doc(img(), sig(), p("")));
  s = run(s, (tr) => tr.setSelection(NodeSelection.create(tr.doc, 0)).deleteSelection());
  assert.equal(names(s.doc), "p() signatureBlock p()", "a paragraph above the signature after deleting the picture");
  assert.equal(s.doc.firstChild.type.name, "paragraph");
  // undo brings the picture back in one step, still one signature, no extra paragraphs
  const u = undo(s, (tr) => (s = s.apply(tr)));
  assert.ok(u);
  assert.equal(names(s.doc), "image p() signatureBlock p()", `undo brings the picture back (${names(s.doc)})`); // the paragraph between picture and region is the guard's own
  redo(s, (tr) => (s = s.apply(tr)));
  assert.equal(names(s.doc), "p() signatureBlock p()", "redo deletes it again");
  assert.equal(sigCount(s.doc), 1);
}

// 2. a body that starts with the signature (draft saved by the old build) is repaired when the editor opens
{
  const s = mk(doc(sig(), p("")));
  const tr = repairSignature(s, "signatureBlock", null);
  assert.ok(tr);
  assert.equal(names(tr.doc), "p() signatureBlock p()");
  assert.equal(repairSignature(s.apply(tr), "signatureBlock", null), null, "a repaired body needs nothing more");
  assert.equal(names(repairSignature(mk(doc(p("x"))), "signatureBlock", null).doc), "p(x) signatureBlock p()", "no region at all: one is added (after the text)");
}

// 3. Pasting a picture into the empty first paragraph (picture replaces it) still leaves a paragraph between picture and region
{
  let s = mk(doc(p(""), sig(), p("")));
  s = run(s, (tr) => tr.replaceWith(0, 2, img()));
  assert.equal(names(s.doc), "image p() signatureBlock p()");
  // two pictures, delete one
  s = run(s, (tr) => tr.insert(0, img()));
  assert.equal(sigCount(s.doc), 1);
  s = run(s, (tr) => tr.setSelection(NodeSelection.create(tr.doc, 0)).deleteSelection());
  assert.equal(names(s.doc), "image p() signatureBlock p()", "one of two pictures deleted");
}

// 4. F-26c: Backspace in the paragraph under the region moves the caret above it; the region does not move and nothing is added
{
  let s = mk(doc(p("above"), sig(), p("below")));
  s = caretAt(s, "below", 0);
  const r = key(s, "Backspace");
  assert.ok(r.handled);
  assert.equal(names(r.state.doc), "p(above) signatureBlock p(below)");
  assert.equal(r.state.selection.$from.parent.textContent, "above", "caret is in the text above the region");
  assert.equal(r.state.selection.$from.parentOffset, 5, "at its end");
  // Backspace in the middle of the lower paragraph is the browser's business
  assert.equal(key(caretAt(s, "below", 2), "Backspace").handled, false);
  // Delete at the end of the paragraph above only crosses the region
  const d = key(caretAt(s, "above", 5), "Delete");
  assert.ok(d.handled);
  assert.equal(names(d.state.doc), "p(above) signatureBlock p(below)");
  assert.equal(d.state.selection.$from.parent.textContent, "below");
  assert.equal(key(caretAt(s, "above", 5), "Backspace").handled, false, "Backspace at the end of the upper text is a normal delete");
}

// 5. a deletion that does remove the region puts it back in the same place, not at the end
{
  let s = mk(doc(p("above"), sig(), p("below"), p("last")));
  // removing the region itself (any command or old key binding)
  s = run(s, (tr) => tr.delete(7, 8));
  assert.equal(names(s.doc), "p(above) signatureBlock p(below) p(last)", `restored in place (${names(s.doc)})`);
  // select from the middle of the text above to the middle of the text below and delete: only text goes, the region stays between
  s = mk(doc(p("above"), sig(), p("below")));
  s = run(s, (tr) => tr.delete(3, 3 + 5 + 3 + 1)); // "ove", the region and "bel" are selected
  assert.equal(names(s.doc), "p(ab) signatureBlock p(ow)", `cut across the region (${names(s.doc)})`);
  assert.equal(sigCount(s.doc), 1);
}

// 6. select all + Backspace / typing: the region survives, the typed text is above it, the quoted message is gone
{
  let s = mk(doc(p("mine"), sig(), N.blockquote.create(null, p("quoted"))));
  const all = run(s, (tr) => tr.setSelection(new AllSelection(tr.doc)).deleteSelection());
  assert.equal(sigCount(all.doc), 1);
  assert.equal(all.doc.firstChild.type.name, "paragraph", "something to type in above");
  assert.ok(/^p\(\) signatureBlock/.test(names(all.doc)), names(all.doc));
  const typed = run(s, (tr) => tr.setSelection(new AllSelection(tr.doc)).replaceSelectionWith(schema.text("hello"), false));
  assert.ok(/^p\(hello\) signatureBlock/.test(names(typed.doc)) || /hello/.test(names(typed.doc)), names(typed.doc));
  assert.equal(sigCount(typed.doc), 1);
  assert.ok(typed.doc.firstChild.isTextblock, "typed text sits in a paragraph above");
  // undo is one step and does not duplicate the region
  let u = all;
  undo(u, (tr) => (u = u.apply(tr)));
  assert.equal(names(u.doc), "p(mine) signatureBlock q(quoted)");
  assert.equal(sigCount(u.doc), 1);
}

// 7. text typed below the region, then Backspace until it is empty: the region does not move
{
  let s = mk(doc(p("above"), sig(), p("x")));
  s = caretAt(s, "x", 1);
  s = run(s, (tr) => tr.delete(tr.selection.from - 1, tr.selection.from));
  assert.equal(names(s.doc), "p(above) signatureBlock p()");
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 9)));
  const r = key(s, "Backspace");
  assert.ok(r.handled, "Backspace in the empty paragraph under the region only moves the caret");
  assert.equal(names(r.state.doc), "p(above) signatureBlock p()");
}

// 8. pasted content never brings a second region; two regions in a stored body collapse to the first
{
  const s = mk(doc(p("a"), sig(), p("b")));
  const guard = s.plugins.at(-1);
  const slice = guard.props.transformPasted(s.doc.slice(0, s.doc.content.size));
  let inSlice = 0;
  slice.content.descendants((n) => { if (n.type.name === "signatureBlock") inSlice++; });
  assert.equal(inSlice, 0, "slice without the region");
  const twice = mk(doc(p("a"), sig(), p("b"), sig(), p("c")));
  assert.equal(names(repairSignature(twice, "signatureBlock", null).doc), "p(a) signatureBlock p(b) p(c)");
}

// 9. Compose.tsx really uses it, and the old "re-add at the end" guard is gone
const src = readFileSync(new URL("../src/components/Compose.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(src, /signatureGuard\("signatureBlock"\)/, "the editor registers the guard");
assert.doesNotMatch(src, /insertContentAt\(ed\.state\.doc\.content\.size, \[\{ type: "signatureBlock" \}/, "no re-insert at the end of the document");
console.log("ok - test-signature-guard");
