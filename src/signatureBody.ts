// The typing area above the signature region of the compose body. The block right above the signature gets the class `sig-above`
// (App.css gives it a minimum height), so an empty message has a body that is clearly taller than the signature under it and a click
// anywhere in that area is a click in the paragraph, not on the signature. A decoration (not :has()) so it works on every WebKit.
// Pure ProseMirror, so it runs in node tests.
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** The top-level block right above the signature region: its start position and node, or null. */
export function blockAboveSignature(state: EditorState, name: string): { pos: number; size: number } | null {
  let found: { pos: number; size: number } | null = null;
  let prev: { pos: number; size: number } | null = null;
  state.doc.forEach((n, off) => {
    if (n.type.name === name && prev && !found) found = prev;
    prev = { pos: off, size: n.nodeSize };
  });
  return found;
}

/** The caret position at the end of the typing block above the signature (null when it is not a text block). */
export function bodyCaretPos(state: EditorState, name: string): number | null {
  const b = blockAboveSignature(state, name);
  if (!b) return null;
  const node = state.doc.nodeAt(b.pos);
  return node && node.isTextblock ? b.pos + node.nodeSize - 1 : null;
}

/** A selection at the end of the typing block above the signature (the document's end when there is none). */
export function bodyCaretSelection(state: EditorState, name: string): TextSelection | null {
  const at = bodyCaretPos(state, name);
  return at === null ? null : TextSelection.create(state.doc, at);
}

export const sigAboveDecor = (name: string) =>
  new Plugin({
    key: new PluginKey("sigAbove"),
    props: {
      decorations(state) {
        const b = blockAboveSignature(state, name);
        return b ? DecorationSet.create(state.doc, [Decoration.node(b.pos, b.pos + b.size, { class: "sig-above" })]) : null;
      },
    },
  });
