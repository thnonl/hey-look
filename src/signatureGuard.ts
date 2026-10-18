// Keeps the signature region of the compose body where it is. The region is an atom node (`signatureBlock`, see Compose.tsx) that must
// exist exactly once, with a paragraph the user can type in above it and a node after it. Edits that break this are repaired IN PLACE:
// the node is put back where the deleted one was (not appended at the end, which made it "jump down"), and a missing paragraph above
// it is added (deleting the only picture above the signature left nothing to type in: F-26b). Pure ProseMirror, so it runs in node tests.
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Mapping } from "@tiptap/pm/transform";

/** Positions (before the node) of every node with this name. */
const positions = (doc: PMNode, name: string): number[] => {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === name) out.push(pos);
    return n.type.name !== name;
  });
  return out;
};

/** Where a top-level block can go for a position that may be inside a paragraph (the paragraph is split, never filled). */
function topLevelInsertPos(tr: Transaction, pos: number): number {
  const $p = tr.doc.resolve(pos);
  if ($p.depth === 0) return pos;
  if (!$p.node(1).isTextblock) return $p.after(1);
  if ($p.parentOffset === 0) return $p.before(1);
  if ($p.parentOffset === $p.parent.content.size) return $p.after(1);
  tr.split(pos);
  return pos + 1;
}

/** The edits that put the document back in shape (one signature node, a paragraph above and a node below it), or null when it is. */
export function repairSignature(state: EditorState, name: string, at: number | null): Transaction | null {
  const type = state.schema.nodes[name];
  const para = state.schema.nodes.paragraph;
  const tr = state.tr;
  // one region only (a second one can come from a paste or a stored draft): the first stays
  const found = positions(tr.doc, name);
  for (const p of found.slice(1).reverse()) tr.delete(p, p + 1);
  if (found.length === 0) tr.insert(topLevelInsertPos(tr, Math.max(0, Math.min(at ?? tr.doc.content.size, tr.doc.content.size))), type.create());

  const first = positions(tr.doc, name)[0];
  const $b = tr.doc.resolve(first);
  const above = $b.nodeBefore;
  if (!above || !above.isTextblock) tr.insert(first, para.create());
  const pos = positions(tr.doc, name)[0];
  if (!tr.doc.resolve(pos + 1).nodeAfter) tr.insert(pos + 1, para.create());
  return tr.docChanged ? tr : null;
}

export function signatureGuard(name: string): Plugin {
  return new Plugin({
    key: new PluginKey("signatureGuard"),
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((t) => t.docChanged)) return null;
      const was = positions(oldState.doc, name)[0];
      let at: number | null = null;
      if (was !== undefined) {
        const m = new Mapping();
        trs.forEach((t) => m.appendMapping(t.mapping));
        at = m.map(was, 1);
      }
      return repairSignature(newState, name, at);
    },
    props: {
      // Backspace right below the region and Delete right above it only move the caret across; they never pull the region or merge with it
      handleKeyDown(view, e) {
        if (e.key !== "Backspace" && e.key !== "Delete") return false;
        const { selection: sel, doc } = view.state;
        if (!sel.empty || sel.$from.depth !== 1) return false;
        const $f = sel.$from;
        if (e.key === "Backspace" && $f.parentOffset === 0 && doc.maybeChild($f.index(0) - 1)?.type.name === name) {
          view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve($f.before(1) - 1), -1)).scrollIntoView());
          return true;
        }
        if (e.key === "Delete" && $f.parentOffset === $f.parent.content.size && doc.maybeChild($f.index(0) + 1)?.type.name === name) {
          view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve($f.after(1) + 1), 1)).scrollIntoView());
          return true;
        }
        return false;
      },
      // pasted or dropped content never brings a second region along
      transformPasted(slice) {
        let removed = false;
        const strip = (f: Fragment): Fragment => {
          const out: PMNode[] = [];
          f.forEach((n) => {
            if (n.type.name === name) removed = true;
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
