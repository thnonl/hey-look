#!/usr/bin/env node
// Putting several pictures into the editor at once (v1.0.6 QA round 2, BUG-A1-1: choosing three files in the Picture button kept only the last picture,
// because tiptap leaves the last inserted picture selected and the next insert replaced it). The transaction of src/editor/insertPictures.ts on a small
// document in Node (plain ProseMirror, no DOM): where the pictures go for each kind of caret, that they are all there in order, and where the caret is after.
//   node --experimental-strip-types scripts/test-insert-pictures.mjs
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { insertPicturesInto } from '../src/editor/insertPictures.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    image: { group: 'block', attrs: { src: { default: '' }, alt: { default: '' }, 'data-name': { default: null }, width: { default: null } }, atom: true, selectable: true, toDOM: () => ['img'] },
    signature: { group: 'block', content: 'paragraph+', isolating: true, toDOM: () => ['div', 0] },
    list: { group: 'block', content: 'item+', toDOM: () => ['ul', 0] },
    item: { content: 'paragraph block*', toDOM: () => ['li', 0] },
    text: { group: 'inline' },
  },
});
const P = (t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : null);
const IMG = (n) => schema.nodes.image.create({ src: `data:image/png;base64,${n}`, 'data-name': n });
const doc = (...kids) => schema.nodes.doc.create(null, kids);
const SIG = () => schema.nodes.signature.create(null, [P('-- sig')]);
const pic = (n) => ({ src: `data:image/png;base64,${n}`, alt: '', 'data-name': n });
const three = ['a', 'b', 'c'].map(pic);
/** the document as a short string: P(text), I(name), S(signature) */
const show = (d) => { const out = []; d.forEach((n) => out.push(n.type.name === 'image' ? `I(${n.attrs['data-name']})` : n.type.name === 'paragraph' ? `P(${n.textContent})` : n.type.name === 'signature' ? `S(${n.textContent})` : `${n.type.name}[${n.textContent}]`)); return out.join(' '); };
/** run the insert with a selection set by `pick(doc)` */
function run(d, pick, pictures = three) {
  const state = EditorState.create({ doc: d, selection: pick(d) });
  const tr = state.tr;
  const at = insertPicturesInto(tr, pictures);
  if (at !== null) tr.setSelection(TextSelection.create(tr.doc, at.caret)); // (the editor sets the caret in an update of its own)
  if (at !== null) assert.equal(tr.doc.nodeAt(at.last)?.type.name, 'image', 'the last picture is where it says');
  return { done: at !== null, doc: show(tr.doc), caret: tr.selection, tr };
}
const at = (d, text, offset) => { let found = -1; d.descendants((n, pos) => { if (found < 0 && n.isText && n.text.includes(text)) found = pos + n.text.indexOf(text) + offset; }); return found; };
const caretIn = (r) => `${r.caret.$from.parent.type.name}:${r.caret.$from.parent.textContent}@${r.caret.$from.parentOffset}`;

// 1. caret in an empty paragraph: the three pictures, then that paragraph with the caret in it
{
  const r = run(doc(P(''), SIG()), (d) => TextSelection.create(d, 1));
  assert.equal(r.doc, 'I(a) I(b) I(c) P() S(-- sig)');
  assert.equal(caretIn(r), 'paragraph:@0');
}
// 2. the start of a paragraph with text
{
  const r = run(doc(P('hello'), SIG()), (d) => TextSelection.create(d, 1));
  assert.equal(r.doc, 'I(a) I(b) I(c) P(hello) S(-- sig)');
  assert.equal(caretIn(r), 'paragraph:hello@0');
}
// 3. the middle of a paragraph: the text is split, the pictures sit between the halves, the caret is at the start of the second half
{
  const r = run(doc(P('hello world'), SIG()), (d) => TextSelection.create(d, at(d, 'hello world', 5)));
  assert.equal(r.doc, 'P(hello) I(a) I(b) I(c) P( world) S(-- sig)');
  assert.equal(caretIn(r), 'paragraph: world@0');
}
// 4. the end of a paragraph: the pictures, then a NEW empty paragraph with the caret
{
  const r = run(doc(P('hello'), P('next'), SIG()), (d) => TextSelection.create(d, at(d, 'hello', 5)));
  assert.equal(r.doc, 'P(hello) I(a) I(b) I(c) P() P(next) S(-- sig)');
  assert.equal(caretIn(r), 'paragraph:@0');
}
// 5. a selected picture (what the editor holds after one insert): not replaced, the new ones go after it
{
  const r = run(doc(P(''), IMG('one'), SIG()), (d) => NodeSelection.create(d, 2));
  assert.equal(r.doc, 'P() I(one) I(a) I(b) I(c) P() S(-- sig)');
  assert.equal(caretIn(r), 'paragraph:@0');
}
// 5b. the picture is followed by a paragraph: the caret goes to its start, no extra paragraph
{
  const r = run(doc(IMG('one'), P('after'), SIG()), (d) => NodeSelection.create(d, 0));
  assert.equal(r.doc, 'I(one) I(a) I(b) I(c) P(after) S(-- sig)');
  assert.equal(caretIn(r), 'paragraph:after@0');
}
// 6. selected text is replaced by the pictures
{
  const r = run(doc(P('hello world'), SIG()), (d) => TextSelection.create(d, at(d, 'hello world', 5), at(d, 'hello world', 11)));
  assert.equal(r.doc, 'P(hello) I(a) I(b) I(c) P() S(-- sig)');
  assert.equal(caretIn(r), 'paragraph:@0');
}
// 7. in a list item: three pictures inside the item, the caret in a paragraph of the item
{
  const d0 = doc(schema.nodes.list.create(null, [schema.nodes.item.create(null, [P('item text')])]), SIG());
  const r = run(d0, (d) => TextSelection.create(d, at(d, 'item text', 4)));
  let imgs = 0;
  r.tr.doc.descendants((n) => { if (n.type.name === 'image') imgs++; });
  assert.equal(imgs, 3, 'three pictures in the list item');
  assert.equal(r.caret.$from.parent.type.name, 'paragraph');
  assert.equal(r.caret.$from.node(r.caret.$from.depth - 1).type.name, 'item', 'the caret stays in the list item');
}
// 8. one picture works the same; nothing to insert does nothing
{
  const r = run(doc(P(''), SIG()), (d) => TextSelection.create(d, 1), three.slice(0, 1));
  assert.equal(r.doc, 'I(a) P() S(-- sig)');
  assert.equal(run(doc(P('x'), SIG()), (d) => TextSelection.create(d, 1), []).done, false);
}
// 9. twice in a row (the next choice goes behind the first one): five pictures in order
{
  const first = run(doc(P(''), SIG()), (d) => TextSelection.create(d, 1));
  const tr = EditorState.create({ doc: first.tr.doc, selection: first.caret }).tr;
  insertPicturesInto(tr, ['d', 'e'].map(pic));
  assert.equal(show(tr.doc), 'I(a) I(b) I(c) I(d) I(e) P() S(-- sig)');
}
// 10. the order is the order given, whatever the sizes
{
  const r = run(doc(P(''), SIG()), (d) => TextSelection.create(d, 1), ['z', 'y', 'x', 'w'].map((n) => ({ src: n.repeat(n === 'z' ? 500 : 3), alt: '', 'data-name': n })));
  assert.equal(r.doc, 'I(z) I(y) I(x) I(w) P() S(-- sig)');
}
console.log('ok - test-insert-pictures');
