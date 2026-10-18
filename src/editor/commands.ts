// Commands of the formatting toolbar and the keys that work on the editor's document: what the selection looks like (one font? one size? mixed?),
// font family / size / colour / highlight, growing and shrinking the font, clearing the formatting, and the paragraph formats (alignment, indent,
// line spacing, lists, styles: the ProseMirror commands are in blockCommands.ts). The toolbar and the key maps both call these.

import type { Editor } from "@tiptap/react";
import type { Mark, Node as PmNode } from "@tiptap/pm/model";
import { liftTarget } from "@tiptap/pm/transform";
import type { Align } from "./blockFormat";
import {
  indentList, indentPlain, listKind, resetBlockFormats, setAlign, setLineHeight, setListStyle, setSpaceAfter, setStyle, textblocksOf,
  type Command, type StyleName,
} from "./blockCommands";
import { normColor } from "./colors";
import type { BaseFont } from "./emailHtml";
import { normFamily, ptText, sizePt, stepSize } from "./fonts";

type Attrs = Record<string, unknown>;

/** What one property is over the selection: the same everywhere (`value`, null when nothing sets it), or `mixed`. */
export interface Uniform<T> {
  mixed: boolean;
  value: T | null;
}

/** The size, in pt, a heading has without a size of its own (emailHtml.ts HEADING_STYLE). */
const HEADING_PT: Record<number, number> = { 1: 18, 2: 14, 3: 12 };

interface Run {
  attrs: Attrs;
  /** the size this run has when no size is set on it: the message's font size, or the heading's */
  plainPt: number;
}

const textStyleOf = (marks: readonly Mark[]): Attrs => marks.find((m) => m.type.name === "textStyle")?.attrs ?? {};
const plainOf = (parent: PmNode | null | undefined, base: BaseFont): number => (parent?.type.name === "heading" ? HEADING_PT[Number(parent.attrs.level)] ?? base.size : base.size);

/** The text runs the selection covers, each with its textStyle attributes; for a caret, the style the next typed character gets. */
function runs(editor: Editor, base: BaseFont): Run[] {
  const { state } = editor;
  const { from, to, empty, $from } = state.selection;
  if (empty) return [{ attrs: textStyleOf(state.storedMarks ?? $from.marks()), plainPt: plainOf($from.parent, base) }];
  const out: Run[] = [];
  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (node.isText) out.push({ attrs: textStyleOf(node.marks), plainPt: plainOf(parent, base) });
  });
  return out.length ? out : [{ attrs: {}, plainPt: base.size }];
}

function uniform<T>(list: T[], same: (a: T, b: T) => boolean): Uniform<T> {
  if (!list.length) return { mixed: false, value: null };
  return list.every((x) => same(x, list[0])) ? { mixed: false, value: list[0] } : { mixed: true, value: null };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** The font family over the selection: the stack as stored (null = the message's default font). */
export function selectionFamily(editor: Editor, base: BaseFont): Uniform<string> {
  const u = uniform(runs(editor, base).map((r) => normFamily(str(r.attrs.fontFamily))), (a, b) => a.toLowerCase() === b.toLowerCase());
  return { mixed: u.mixed, value: u.value || null };
}

/** The size in pt over the selection (the default size where none is set). */
export function selectionSize(editor: Editor, base: BaseFont): Uniform<number> {
  return uniform(runs(editor, base).map((r) => sizePt(str(r.attrs.fontSize)) ?? r.plainPt), (a, b) => Math.abs(a - b) < 1e-6);
}

/** The colour (`color` / `backgroundColor`) over the selection, `#RRGGBB` or null for none. */
export function selectionColor(editor: Editor, key: "color" | "backgroundColor", base: BaseFont): Uniform<string> {
  const u = uniform(runs(editor, base).map((r) => normColor(str(r.attrs[key]))), (a, b) => a === b);
  return { mixed: u.mixed, value: u.value || null };
}

/** The text has the key focus again, at once (TipTap's own `focus()` waits a frame, and a key typed in that frame would go to the toolbar button). */
export function focusText(editor: Editor): void {
  if (!editor.view.hasFocus()) editor.view.focus();
}

export function setFamily(editor: Editor, stack: string | null): void {
  const c = editor.chain().focus();
  (stack ? c.setFontFamily(normFamily(stack)) : c.unsetFontFamily()).run();
  focusText(editor);
}

export function setSize(editor: Editor, pt: number): void {
  editor.chain().focus().setFontSize(ptText(pt)).run();
  focusText(editor);
}

/** Automatic (null) takes the colour off, so the reader's own light or dark mode decides. */
export function setTextColor(editor: Editor, hex: string | null): void {
  const c = editor.chain().focus();
  (hex ? c.setColor(normColor(hex)) : c.unsetColor()).run();
  focusText(editor);
}

export function setHighlight(editor: Editor, hex: string | null): void {
  const c = editor.chain().focus();
  (hex ? c.setBackgroundColor(normColor(hex)) : c.unsetBackgroundColor()).run();
  focusText(editor);
}

/**
 * Ctrl+] / Ctrl+[ : every run of the selection goes to the next (previous) listed size, the ends of the list stay; a caret changes the size
 * of what is typed next.
 */
export function stepFontSize(editor: Editor, dir: 1 | -1, base: BaseFont): boolean {
  const { state } = editor;
  const ts = state.schema.marks.textStyle;
  const { from, to, empty } = state.selection;
  if (empty) {
    const cur = selectionSize(editor, base).value ?? base.size;
    setSize(editor, stepSize(cur, dir));
    return true;
  }
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      state.doc.nodesBetween(from, to, (node, pos, parent) => {
        if (!node.isText) return;
        const a = Math.max(from, pos);
        const b = Math.min(to, pos + node.nodeSize);
        const mark = node.marks.find((m) => m.type === ts);
        const cur = sizePt(str(mark?.attrs.fontSize)) ?? plainOf(parent, base);
        tr.addMark(a, b, ts.create({ ...(mark?.attrs ?? {}), fontSize: ptText(stepSize(cur, dir)) }));
      });
      return true;
    })
    .run();
}

/**
 * Clear formatting (button, Ctrl+Space, Ctrl+\): font, size, colour, highlight, bold, italic, underline, strikethrough, sub/superscript and code go;
 * headings, code blocks and quotes become Normal text, alignment, indent and spacing go back to the defaults. Links, lists and pictures stay. With a caret the whole paragraph is cleared (as in Word).
 */
export function clearFormatting(editor: Editor): boolean {
  const keep = new Set(["link"]);
  const types = Object.values(editor.state.schema.marks).filter((m) => !keep.has(m.name));
  // one chain: one undo step
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      let { from, to } = tr.selection;
      const { empty, $from } = tr.selection;
      if (empty) {
        from = $from.start();
        to = $from.end();
        tr.setStoredMarks((tr.storedMarks ?? $from.marks()).filter((m) => keep.has(m.type.name)));
      }
      for (const t of types) tr.removeMark(from, to, t);
      return true;
    })
    .command(({ commands, tr }) => {
      // block styles: heading / code block -> paragraph, out of every quote the selection touches
      let styled = false;
      tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node) => {
        if (node.type.name === "heading" || node.type.name === "codeBlock") styled = true;
      });
      if (styled) commands.setParagraph();
      for (let i = 0; i < 8; i++) {
        let quote = -1;
        tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
          if (quote < 0 && node.type.name === "blockquote") quote = pos;
          return quote < 0;
        });
        if (quote < 0) break;
        const node = tr.doc.nodeAt(quote)!;
        const range = tr.doc.resolve(quote + 1).blockRange(tr.doc.resolve(quote + node.nodeSize - 1));
        const target = range ? liftTarget(range) : null;
        if (!range || target === null) break;
        tr.lift(range, target);
      }
      return true;
    })
    .command(({ state, dispatch }) => {
      // paragraph formats: alignment, indent, line spacing, space after (links, lists and pictures stay)
      resetBlockFormats(state, dispatch);
      return true;
    })
    .run();
}

/**
 * Subscript (Ctrl+=) and superscript (Ctrl+Shift+=): one or the other, never both. Applying one to text that has the other replaces it (a mark that
 * excludes another does not replace it in ProseMirror, it is refused, so the other is taken off first).
 */
export function toggleScript(editor: Editor, which: "subscript" | "superscript"): boolean {
  const other = which === "subscript" ? "superscript" : "subscript";
  const chain = editor.chain().focus();
  if (editor.isActive(which)) return chain.unsetMark(which).run();
  return chain.unsetMark(other).setMark(which).run();
}

// ---------------------------------------------------------------- paragraph formats (blockCommands.ts has the ProseMirror commands)

/** Run a ProseMirror command on the editor's selection as one step, and leave the focus in the text. */
function runBlock(editor: Editor, cmd: Command): boolean {
  const ok = editor.chain().focus().command(({ state, dispatch }) => cmd(state, dispatch)).run();
  focusText(editor);
  return ok;
}

export const setAlignment = (editor: Editor, value: Align | "left"): boolean => runBlock(editor, setAlign(value));
export const setSpacing = (editor: Editor, lineHeight: string | null): boolean => runBlock(editor, setLineHeight(lineHeight));
export const setSpaceAfterParagraph = (editor: Editor, add: boolean): boolean => runBlock(editor, setSpaceAfter(add));
export const applyStyle = (editor: Editor, name: StyleName): boolean => runBlock(editor, setStyle(name));

/**
 * Increase / decrease indent (Ctrl+T, Ctrl+Shift+T and the buttons): list items go one level in / out, any other paragraph or heading one 40 px step.
 * True when there was a paragraph to act on, so the key is not left to the browser.
 */
export function changeIndent(editor: Editor, dir: 1 | -1): boolean {
  if (!textblocksOf(editor.state).length) return false;
  const ok = editor
    .chain()
    .focus()
    .command(({ state, dispatch }) => (indentPlain(dir)(state, dispatch), true))
    .command(({ state, dispatch }) => (indentList(dir)(state, dispatch), true))
    .run();
  focusText(editor);
  return ok;
}

/** Choose the marker style of the selection's list; outside a list of that kind, the selection becomes one first (a list of the other kind is converted). */
export function chooseListStyle(editor: Editor, ordered: boolean, style: string | null): boolean {
  const chain = editor.chain().focus();
  if (listKind(editor.state) !== (ordered ? "ordered" : "bullet")) (ordered ? chain.toggleOrderedList() : chain.toggleBulletList());
  const ok = chain.command(({ state, dispatch }) => setListStyle(ordered, style)(state, dispatch)).run();
  focusText(editor);
  return ok;
}

export function insertHorizontalLine(editor: Editor): boolean {
  const ok = editor.chain().focus().setHorizontalRule().run();
  focusText(editor);
  return ok;
}
