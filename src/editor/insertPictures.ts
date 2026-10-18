// Putting picture files into the editor at the caret (Compose: the Picture button, a drop, a paste; the signature editor: its Picture button).
//
// A picture is a block node. tiptap leaves a NodeSelection on what `insertContent` put in, and the next `insertContent` replaces a selected node:
// choosing three files inserted three pictures one after the other and kept only the last (v1.0.6 QA round 2, BUG-A1-1). So all the pictures of one
// choice go in with ONE transaction, in order, and the caret ends up behind the last of them, in a paragraph where typing goes on. A picture (or any node)
// that is selected when the files come in is never replaced: the new ones go after it.
//
//   caret in an empty paragraph      pictures, then that paragraph (the caret in it)
//   caret at the start of text       pictures, then that paragraph (the caret at its start)
//   caret in the middle of text      the text is split; pictures between the halves, the caret at the start of the second half
//   caret at the end of text         the paragraph, the pictures, a new empty paragraph (the caret in it)
//   a node selected                  after that node: pictures, then the paragraph that follows it or a new one
//
// The transaction work is plain ProseMirror (no DOM): scripts/test-insert-pictures.mjs runs it on a small document in Node.

import type { Editor } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";

/** The attributes of one `image` node (the PictureNode of pictureNode.ts). */
export type PictureAttrs = { src: string; alt: string; "data-name"?: string | null; width?: number | null };

/** Adds the pictures to `tr` at its selection. Returns the position of the last picture and where the caret belongs (in the paragraph behind it), null when nothing was added. */
export function insertPicturesInto(tr: Transaction, pictures: readonly PictureAttrs[]): { last: number; caret: number } | null {
  const image = tr.doc.type.schema.nodes.image;
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (!image || !paragraph || pictures.length === 0) return null;
  const nodes: PmNode[] = pictures.map((attrs) => image.create(attrs));
  const size = nodes.reduce((n, p) => n + p.nodeSize, 0);

  let sel = tr.selection;
  if (!(sel instanceof NodeSelection) && !sel.empty) {
    tr.deleteSelection(); // typed over: the picture replaces the selected text
    sel = tr.selection;
  }
  let at: number;
  let newLine = false; // a new empty paragraph behind the pictures
  if (sel instanceof NodeSelection) {
    at = sel.to;
  } else {
    const $from = sel.$from;
    if (!$from.parent.isTextblock) {
      at = sel.from; // (a position between blocks: a gap cursor)
    } else if ($from.parent.content.size === 0 || $from.parentOffset === 0) {
      at = $from.before();
    } else if ($from.parentOffset === $from.parent.content.size) {
      at = $from.after();
      newLine = true;
    } else {
      tr.split($from.pos);
      at = $from.pos + 1; // (between the two halves: behind the closing token of the first one)
    }
  }
  tr.insert(at, Fragment.from(nodes));
  const end = at + size;
  const next = tr.doc.resolve(end).nodeAfter;
  if (newLine || !next?.isTextblock) tr.insert(end, paragraph.create());
  return { last: end - nodes[nodes.length - 1].nodeSize, caret: end + 1 };
}

/** Inserts `pictures` in order at the caret of the editor; the caret is behind the last one. False when there was nothing to insert or the editor is gone. */
export function insertPictureNodes(editor: Editor | null | undefined, pictures: readonly PictureAttrs[]): boolean {
  if (!editor || editor.isDestroyed || pictures.length === 0) return false;
  let put: { last: number; caret: number } | null = null;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      put = insertPicturesInto(tr, pictures);
      return put !== null;
    })
    .run();
  const done = put as { last: number; caret: number } | null; // (set inside the command above)
  if (!done) return false;
  // The caret is set by updates of its own, through the last picture selected: with the caret set in the transaction that inserts (or in one update after it),
  // the first typed letter went IN FRONT of the pictures (the view's input handling reads the position wrongly after a text caret that follows leading pictures
  // until a picture has been the selection once; seen in the dev preview).
  editor.chain().setNodeSelection(done.last).run();
  editor.chain().setTextSelection(done.caret).scrollIntoView().run();
  return true;
}
