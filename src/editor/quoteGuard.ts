// Keeps the quote block of a reply / forward (quoteNode.ts) from being destroyed by accident. The block is an atom the person selects as a whole; what
// happens next must not be a surprise:
//  - typing, pasting or Enter while it is SELECTED go below it (the paragraph that follows, or a new one) instead of replacing it;
//  - Backspace at the start of the text below it and Delete at the end of the text above it never touch it (an empty line goes as usual);
//  - Delete / Backspace on the selected block removes it (that is the one way, besides the Remove button; one Undo brings it back);
//  - a copied block is not pasted back as a second one, and there is never more than one.
// Pure ProseMirror (no DOM), so scripts/test-quote-guard.mjs runs the very plugin the editor uses.
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";

export const QUOTE_NODE = "quoteBlock";

export function quoteGuard(): Plugin {
  const isQuoteSel = (s: EditorState) => s.selection instanceof NodeSelection && s.selection.node.type.name === QUOTE_NODE;
  /** The text below the selected block, the caret in it (what typing, pasting or Enter on the selected block mean): the paragraph that follows it, or a new one. */
  const below = (state: EditorState, text = "") => {
    const sel = state.selection as NodeSelection;
    const next = state.doc.resolve(sel.to).nodeAfter;
    const tr = state.tr;
    if (next?.isTextblock) {
      tr.setSelection(TextSelection.create(tr.doc, sel.to + 1));
      return text ? tr.insertText(text) : tr;
    }
    tr.insert(sel.to, state.schema.nodes.paragraph.create(null, text ? state.schema.text(text) : undefined));
    return tr.setSelection(TextSelection.create(tr.doc, sel.to + 1 + text.length));
  };
  return new Plugin({
    key: new PluginKey("quoteGuard"),
    // never two blocks (a paste is filtered below, this catches anything else)
    appendTransaction(trs, _old, state) {
      if (!trs.some((x) => x.docChanged)) return null;
      const at: number[] = [];
      state.doc.forEach((n, o) => n.type.name === QUOTE_NODE && at.push(o));
      if (at.length < 2) return null;
      const tr = state.tr;
      for (const o of at.slice(1).reverse()) tr.delete(o, o + 1);
      return tr;
    },
    props: {
      handleTextInput(view, _from, _to, text) {
        if (!isQuoteSel(view.state)) return false;
        view.dispatch(below(view.state, text).scrollIntoView());
        return true;
      },
      handlePaste(view) {
        if (isQuoteSel(view.state)) view.dispatch(below(view.state)); // the paste lands below the block, the default paste goes on from there
        return false;
      },
      handleKeyDown(view, e) {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && isQuoteSel(view.state)) {
          view.dispatch(below(view.state).scrollIntoView());
          return true;
        }
        if (e.key !== "Backspace" && e.key !== "Delete") return false;
        const { selection: sel, doc } = view.state;
        if (!sel.empty || sel.$from.depth !== 1 || !sel.$from.parent.isTextblock) return false;
        const $f = sel.$from;
        // Backspace at the start of the text under the block and Delete at the end of the text above it do not touch the block (an empty line goes as usual)
        if (e.key === "Backspace" && $f.parentOffset === 0 && $f.parent.content.size > 0 && doc.maybeChild($f.index(0) - 1)?.type.name === QUOTE_NODE) return true;
        if (e.key === "Delete" && $f.parentOffset === $f.parent.content.size && $f.parent.content.size > 0 && doc.maybeChild($f.index(0) + 1)?.type.name === QUOTE_NODE) return true;
        return false;
      },
      // a block that is copied is not pasted back as a second one
      transformPasted(slice) {
        let removed = false;
        const strip = (f: Fragment): Fragment => {
          const out: PMNode[] = [];
          f.forEach((n) => {
            if (n.type.name === QUOTE_NODE) removed = true;
            else out.push(n.isLeaf ? n : n.copy(strip(n.content)));
          });
          return Fragment.from(out);
        };
        const content = strip(slice.content);
        return removed ? new Slice(content, 0, 0) : slice;
      },
    },
  });
}

