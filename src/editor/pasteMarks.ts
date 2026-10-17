// The format around the caret, for the pasted text that has none of its own (spec-rich-text.md REQ-23, Merge formatting and Keep text only).
// Pure (ProseMirror's model only): a plain Node script tests it on the editor's schema (scripts/test-paste-options.mjs).

import { Fragment, Slice, type Mark, type Node as PmNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { PasteMode } from "./pasteClean.ts";

/** `marks` on every text of the content that does not have a mark of the same type yet. */
export function withMarks(f: Fragment, marks: readonly Mark[]): Fragment {
  const out: PmNode[] = [];
  f.forEach((n) => out.push(n.isText ? n.mark(marks.reduce((set, m) => (set.some((x) => x.type === m.type) ? set : m.addToSet(set)), n.marks)) : n.copy(withMarks(n.content, marks))));
  return Fragment.fromArray(out);
}

/**
 * The format the person would type in at the caret: the marks they switched on or off with the toolbar (stored marks), else those of the text around the
 * caret. Read from the state BEFORE the paste: once the pasted text is in the document the caret's neighbours are the pasted text itself, and a paste at the
 * start of a paragraph would take the format of the text it is about to replace (a switch from Keep source to Keep text only stayed bold).
 */
export function caretMarks(state: Pick<EditorState, "storedMarks" | "selection">): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

/** Merge formatting takes the font, size and colour of `around` (the format at the caret); text only takes all of it but a link (like typing there); Keep source takes nothing. */
export function inherit(slice: Slice, around: readonly Mark[], mode: PasteMode): Slice {
  if (mode === "source") return slice;
  const marks = around.filter((m) => (mode === "merge" ? m.type.name === "textStyle" : m.type.name !== "link"));
  return marks.length ? new Slice(withMarks(slice.content, marks), slice.openStart, slice.openEnd) : slice;
}
