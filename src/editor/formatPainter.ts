// Format painter (spec-107-wp3.md W3.1, spec-rich-text.md REQ-45): copy the formatting of the selection and paint it onto the next text the person selects.
//
//  - The state machine is `off` / `once` / `sticky` (`nextMode`, pure). The toolbar button (a click turns it on for one use, a double click keeps it on), Ctrl+Shift+D and the More row switch it;
//    Esc, typing or any other edit, a formatting command, the focus moving out of the editor and its toolbar switch it off; Undo and Redo, caret moves and keyboard selections do not.
//  - `pickUp` reads the source from the selection when it goes on: the marks of the first character (or the marks a typed character would get at a caret) and, when the source is a caret,
//    a whole paragraph or several paragraphs, the paragraph formatting (style, alignment, indent, line spacing, space after, direction). Lists, tables and pictures are never copied.
//  - `applyPainter` paints it onto the target as ONE transaction: the copyable marks of the target text are replaced (links and inline code stay), the paragraph formatting is set on every
//    paragraph and heading the target touches. The signature region and the reply quote are atoms with no text of their own, so they are not changed; pictures are not changed.
//  - The plugin applies on the release of the mouse button (a drag, a double or triple click, Shift+click; a click without a drag paints the word under it), and with Ctrl+Shift+D at the
//    keyboard selection. The cursor over the text is a brush while it is on.
// Pure apart from the plugin and the extension (ProseMirror only): a plain Node script runs the very code the editor uses (scripts/test-format-painter.mjs).

import { Extension, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Mark, Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { setStyle, styleAt, type Blk, type StyleName } from "./blockCommands.ts";

export type PainterMode = "off" | "once" | "sticky";

/** What happens to the painter. `click`: one click of the button or the More row; `dblclick`: the second press of a double click; `key`: Ctrl+Shift+D when it is off. */
export type PainterEvent = "click" | "dblclick" | "key" | "applied" | "esc" | "edit" | "focusout" | "close" | "undo" | "move";

/** The table of REQ-3.1.1 / REQ-3.1.5: the mode after an event. Undo, Redo and caret moves leave it as it is. */
export function nextMode(mode: PainterMode, ev: PainterEvent): PainterMode {
  switch (ev) {
    case "click":
      return mode === "off" ? "once" : "off";
    case "dblclick":
      return "sticky";
    case "key":
      return mode === "off" ? "once" : mode;
    case "applied":
      return mode === "once" ? "off" : mode;
    case "esc":
    case "edit":
    case "focusout":
    case "close":
      return "off";
    default:
      return mode;
  }
}

/** The marks that are copied and replaced. Links and inline code are neither. */
export const COPYABLE: readonly string[] = ["bold", "italic", "underline", "strike", "subscript", "superscript", "textStyle"];
const PROTECTED = new Set(["quoteBlock", "signatureBlock"]);
const FORMATTED = new Set(["paragraph", "heading"]);

export interface PainterBlock {
  style: StyleName;
  /** the paragraph formats of a paragraph or heading; null for the Code style (it has none). `indent` null: leave the indent of the target alone (a list item) */
  attrs: { textAlign: unknown; direction: unknown; lineHeight: unknown; spaceAfter: unknown; indent: number | null } | null;
}

export interface PainterSource {
  marks: Mark[];
  /** null: the source is part of one paragraph, only the character formatting is copied */
  block: PainterBlock | null;
}

const insideListItem = (doc: PmNode, pos: number): boolean => {
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === "listItem") return true;
  return false;
};

/** The text blocks a range touches, without the protected parts; a range that ends at the very start of a block does not take that block in. */
export function blocksBetween(doc: PmNode, from: number, to: number): Blk[] {
  const out: Blk[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (PROTECTED.has(node.type.name)) return false;
    if (node.isTextblock) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  if (from !== to && out.length > 1 && to <= out[out.length - 1].pos + 1) out.pop();
  return out;
}

const rangesOf = (state: EditorState): [number, number][] => state.selection.ranges.map((r) => [r.$from.pos, r.$to.pos] as [number, number]);

/** The formatting of the selection, as the painter takes it (REQ-3.1.2). */
export function pickUp(state: EditorState): PainterSource {
  const sel = state.selection;
  const [from, to] = rangesOf(state)[0] ?? [sel.from, sel.to];
  let marks: readonly Mark[] = [];
  if (sel.empty) marks = state.storedMarks ?? sel.$from.marks();
  else {
    const first: { node: PmNode | null } = { node: null };
    state.doc.nodesBetween(from, to, (n) => {
      if (!first.node && n.isText) first.node = n;
      return !first.node;
    });
    marks = first.node?.marks ?? [];
  }
  const copy = marks.filter((m) => COPYABLE.includes(m.type.name));
  const blocks = blocksBetween(state.doc, from, to);
  const b = blocks[0];
  // the paragraph formatting goes with a caret, a whole paragraph or several paragraphs (Word's rule); part of one paragraph copies the characters only
  const whole = !!b && from <= b.pos + 1 && to >= b.pos + b.node.nodeSize - 1;
  if (!b || !(sel.empty || blocks.length > 1 || whole)) return { marks: copy, block: null };
  const style = styleAt(state, b);
  if (!FORMATTED.has(b.node.type.name)) return { marks: copy, block: { style, attrs: null } };
  const a = b.node.attrs;
  return {
    marks: copy,
    block: { style, attrs: { textAlign: a.textAlign ?? null, direction: a.direction ?? null, lineHeight: a.lineHeight ?? null, spaceAfter: a.spaceAfter ?? null, indent: insideListItem(state.doc, b.pos) ? null : Number(a.indent ?? 0) } },
  };
}

const WORD = "\\p{L}\\p{N}\\p{M}";
const endsWord = new RegExp(`[${WORD}]$`, "u");
const startsWord = new RegExp(`^[${WORD}]`, "u");

/** The word (letters and digits) the offset touches, as [start, end) offsets of `text`; null when it is on a space or punctuation with no word next to it. */
export function wordAt(text: string, offset: number): [number, number] | null {
  let a = offset;
  let b = offset;
  while (endsWord.test(text.slice(0, a))) a -= /.$/u.exec(text.slice(0, a))![0].length;
  while (startsWord.test(text.slice(b))) b += /^./u.exec(text.slice(b))![0].length;
  return a === b ? null : [a, b];
}

export interface Applied {
  /** the paint as one transaction (without the painter's own meta); null when the selection cannot be painted (a picture) */
  tr: Transaction | null;
  /** there was text or a paragraph to paint (a target that is only a picture or a protected part does not count, and the painter keeps its state) */
  targeted: boolean;
}

/**
 * Paints `src` onto the selection (REQ-3.1.3). `opts.word`: the click rule, the word under the click is the target and stays selected. A caret with no word under it
 * changes no text: the paragraph formatting is set on its paragraph and the characters' formatting becomes what is typed next.
 */
export function applyPainter(state: EditorState, src: PainterSource, opts: { word?: [number, number] } = {}): Applied {
  const sel = state.selection;
  if (sel instanceof NodeSelection) return { tr: null, targeted: false };
  const caret = !opts.word && sel.empty;
  const ranges: [number, number][] = opts.word ? [opts.word] : rangesOf(state);
  const start = ranges.flatMap(([a, b]) => blocksBetween(state.doc, a, b));
  const text = { found: false };
  for (const [a, b] of ranges) {
    state.doc.nodesBetween(a, b, (n) => {
      if (PROTECTED.has(n.type.name)) return false;
      if (n.isText) text.found = true;
      return true;
    });
  }
  if (!start.length && !text.found) return { tr: null, targeted: false };

  let tr: Transaction = state.tr;
  // 1. the style (Normal, Heading 1-3, Quote, Code) through the Styles command, which keeps the alignment, indent and spacing of the blocks
  if (src.block && start.some((b) => (FORMATTED.has(b.node.type.name) || b.node.type.name === "codeBlock") && styleAt(state, b) !== src.block!.style)) {
    const made: { tr: Transaction | null } = { tr: null };
    setStyle(src.block.style)(state, (t) => (made.tr = t));
    if (made.tr) tr = made.tr;
  }
  const at = ranges.map(([a, b]) => [tr.mapping.map(a, 1), tr.mapping.map(b, -1)] as [number, number]);

  // 2. the characters: the copyable marks of the target text go, the source's come
  const types = COPYABLE.map((n) => state.schema.marks[n]).filter(Boolean);
  for (const [a, b] of at) {
    if (a >= b) continue;
    const spans: [number, number][] = [];
    tr.doc.nodesBetween(a, b, (n, pos) => {
      if (PROTECTED.has(n.type.name)) return false;
      if (n.isText) spans.push([Math.max(a, pos), Math.min(b, pos + n.nodeSize)]);
      return true;
    });
    for (const t of types) for (const [x, y] of spans) tr.removeMark(x, y, t);
    for (const [x, y] of spans) for (const m of src.marks) tr.addMark(x, y, m);
  }

  // 3. the paragraphs: the formats of the source on every paragraph and heading the target touches (a list or a table around them is not changed)
  const patch = src.block?.attrs;
  if (patch) {
    for (const [a, b] of at) {
      for (const blk of blocksBetween(tr.doc, a, b)) {
        if (!FORMATTED.has(blk.node.type.name)) continue;
        const next: Record<string, unknown> = { ...blk.node.attrs, textAlign: patch.textAlign, direction: patch.direction, lineHeight: patch.lineHeight, spaceAfter: patch.spaceAfter };
        if (patch.indent !== null && !insideListItem(tr.doc, blk.pos)) next.indent = patch.indent;
        if (Object.keys(next).some((k) => (blk.node.attrs[k] ?? null) !== (next[k] ?? null))) tr.setNodeMarkup(blk.pos, undefined, next);
      }
    }
  }

  // 4. a caret: what is typed next has the characters' formatting; a word: it stays selected
  if (caret) {
    const around = state.storedMarks ?? sel.$from.marks();
    tr.setStoredMarks([...around.filter((m) => !COPYABLE.includes(m.type.name)), ...src.marks]);
  } else if (opts.word) {
    tr.setSelection(TextSelection.create(tr.doc, at[0][0], at[0][1]));
  }
  return { tr, targeted: true };
}

// ---------------------------------------------------------------- the plugin

interface PainterState {
  mode: PainterMode;
  source: PainterSource | null;
}
interface Meta {
  ev: PainterEvent;
  source?: PainterSource | null;
}
const OFF: PainterState = { mode: "off", source: null };
export const painterKey = new PluginKey<PainterState>("formatPainter");

/** The mode of the painter in this state ("off" for an editor without the plugin). */
export const painterMode = (state: EditorState): PainterMode => painterKey.getState(state)?.mode ?? "off";

/** The brush that is the pointer over the text while the painter is on: a black brush with a white outline (it shows on the light and the dark canvas), the hotspot on the bristles. */
const BRUSH =
  "m14.622 17.897-10.68-2.913M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0zM9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15";
export const CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'><path d='${BRUSH}' stroke='#fff' stroke-width='4'/><path d='${BRUSH}' stroke='#000' stroke-width='2'/></svg>`,
)}") 6 16, copy`;

/** The parts of the page that belong to the editor: the focus moving into them does not end the painter. */
const OWN = ".fmt-tb, .mini-tb, .img-tools, .menu, .popover, .paste-opt";

function send(view: EditorView, ev: PainterEvent, source?: PainterSource | null): void {
  view.dispatch(view.state.tr.setMeta(painterKey, { ev, source } satisfies Meta));
}

/** Paints the selection now: the mouse button was released (`at`: where, for the click rule) or Ctrl+Shift+D was pressed (`at` null). */
function paintNow(view: EditorView, at: { x: number; y: number } | null): void {
  const st = painterKey.getState(view.state);
  if (!st || st.mode === "off" || !st.source) return;
  const { selection: sel } = view.state;
  let word: [number, number] | undefined;
  if (sel.empty && sel instanceof TextSelection) {
    const p = sel.$from;
    if (p.parent.isTextblock) {
      const w = wordAt(p.parent.textBetween(0, p.parent.content.size, undefined, "￼"), p.parentOffset);
      if (w) {
        const start = p.start();
        // a click that is not on the word itself (on a space, past the end of the line) is not a click on it
        if (!at || pointInside(view, start + w[0], start + w[1], at)) word = [start + w[0], start + w[1]];
      }
    }
  }
  const r = applyPainter(view.state, st.source, word ? { word } : {});
  if (!r.targeted || !r.tr) return;
  closeHistory(r.tr);
  r.tr.setMeta(painterKey, { ev: "applied" } satisfies Meta);
  view.dispatch(r.tr);
}

function pointInside(view: EditorView, from: number, to: number, at: { x: number; y: number }): boolean {
  try {
    const a = view.domAtPos(from);
    const b = view.domAtPos(to);
    const range = view.dom.ownerDocument.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const rects = Array.from(range.getClientRects());
    return rects.length === 0 || rects.some((q) => at.x >= q.left - 1 && at.x <= q.right + 1 && at.y >= q.top - 1 && at.y <= q.bottom + 1);
  } catch {
    return true;
  }
}

function painterPlugin(): Plugin<PainterState> {
  let down = false;
  return new Plugin<PainterState>({
    key: painterKey,
    state: {
      init: () => OFF,
      apply: (tr, prev) => {
        const m = tr.getMeta(painterKey) as Meta | undefined;
        if (m) {
          const mode = nextMode(prev.mode, m.ev);
          return mode === "off" ? OFF : { mode, source: m.source ?? prev.source };
        }
        if (prev.mode === "off" || tr.getMeta("history$") || tr.getMeta("appendedTransaction")) return prev;
        // typing, Enter, Backspace, Delete, a paste or a drop, and any formatting command (a mark or a stored mark changes) end it; Undo and Redo do not
        return tr.docChanged || tr.storedMarksSet ? OFF : prev;
      },
    },
    props: {
      attributes: (state): Record<string, string> => (painterMode(state) === "off" ? {} : { class: "fmt-painting", style: `--fmt-cursor:${CURSOR}` }),
      handleDOMEvents: {
        mousedown: (view, e) => {
          down = e.button === 0 && painterMode(view.state) !== "off";
          return false;
        },
      },
      handleKeyDown: (view, e) => {
        // Esc ends the painter and does nothing else on that press (the paste button, the compose pane and the mini toolbar get the next one)
        if (e.key !== "Escape" || painterMode(view.state) === "off") return false;
        e.stopPropagation();
        send(view, "esc");
        return true;
      },
    },
    view: (view) => {
      const up = (e: MouseEvent) => {
        if (!down) return;
        down = false;
        if (e.button !== 0) return;
        const at = { x: e.clientX, y: e.clientY };
        // (the editor reads the selection the browser made a moment after the button is released; a double or triple click selects on the press and the editor may not have it yet)
        setTimeout(() => {
          if (view.isDestroyed) return;
          const d = doc.getSelection();
          if (view.state.selection.empty && d && !d.isCollapsed) setTimeout(() => !view.isDestroyed && paintNow(view, at), 60);
          else paintNow(view, at);
        }, 0);
      };
      const focusin = (e: FocusEvent) => {
        const t = e.target;
        if (painterMode(view.state) === "off" || !(t instanceof Element) || view.dom.contains(t) || t.closest(OWN)) return;
        send(view, "focusout");
      };
      const doc = view.dom.ownerDocument;
      doc.addEventListener("mouseup", up, true);
      doc.addEventListener("focusin", focusin);
      return {
        destroy: () => {
          doc.removeEventListener("mouseup", up, true);
          doc.removeEventListener("focusin", focusin);
        },
      };
    },
  });
}

/** The button, the More row (`detail` 1) and a double click (`detail` 2): REQ-3.1.1. */
export function painterClick(editor: Editor, detail: number): void {
  const view = editor.view;
  if (!painterKey.getState(view.state)) return;
  const off = painterMode(view.state) === "off";
  send(view, detail >= 2 ? "dblclick" : "click", off ? pickUp(view.state) : undefined);
}

/** Ctrl+Shift+D: off -> picks up; on -> paints the selection (or the caret by the click rule). Always true, the key is the painter's. */
export function painterShortcut(view: EditorView): boolean {
  if (!painterKey.getState(view.state)) return false;
  if (painterMode(view.state) === "off") send(view, "key", pickUp(view.state));
  else paintNow(view, null);
  return true;
}

export const FormatPainter = Extension.create({
  name: "formatPainter",
  // ahead of the paste options, whose button also takes Esc (REQ-3.1.5: the painter has the first Esc)
  priority: 1000,
  addProseMirrorPlugins: () => [painterPlugin()],
  addKeyboardShortcuts() {
    return { "Mod-Shift-d": () => painterShortcut(this.editor.view) };
  },
});
