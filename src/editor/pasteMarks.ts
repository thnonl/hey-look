// The format around the caret, for the pasted text that has none of its own (spec-rich-text.md REQ-23, Merge formatting and Keep text only).
// Pure (ProseMirror's model only): a plain Node script tests it on the editor's schema (scripts/test-paste-options.mjs).

import { Fragment, Slice, type Mark, type Node as PmNode, type ResolvedPos } from "@tiptap/pm/model";
import type { PasteMode } from "./pasteClean.ts";

/** `marks` on every text of the content that does not have a mark of the same type yet. */
export function withMarks(f: Fragment, marks: readonly Mark[]): Fragment {
  const out: PmNode[] = [];
  f.forEach((n) => out.push(n.isText ? n.mark(marks.reduce((set, m) => (set.some((x) => x.type === m.type) ? set : m.addToSet(set)), n.marks)) : n.copy(withMarks(n.content, marks))));
  return Fragment.fromArray(out);
}

/** Merge formatting takes the font, size and colour around the caret; text only takes all its marks but a link (like typing there); Keep source takes nothing. */
export function inherit(slice: Slice, $at: ResolvedPos, mode: PasteMode): Slice {
  if (mode === "source") return slice;
  const marks = $at.marks().filter((m) => (mode === "merge" ? m.type.name === "textStyle" : m.type.name !== "link"));
  return marks.length ? new Slice(withMarks(slice.content, marks), slice.openStart, slice.openEnd) : slice;
}
