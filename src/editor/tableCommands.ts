// What the table controls do (spec-rich-text.md REQ-31, REQ-32): insert a table at the caret, add and delete rows and columns, the border style, the
// shading of cells, the header row. ProseMirror transactions on the editor's document; the buttons that call them are in insertUi.tsx.

import { mergeCells, splitCell } from "@tiptap/pm/tables";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { TableBorders } from "./tableExtension.ts";

/** The size limits of the Insert table dialog (spec REQ-31). */
export const MAX_COLS = 20;
export const MAX_ROWS = 100;
export const DEFAULT_COLS = 3;
export const DEFAULT_ROWS = 2;

/** The table the selection is in, with its position. */
export function tableAt(state: EditorState): { node: PmNode; pos: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "table") return { node, pos: $from.before(d) };
  }
  return null;
}

/**
 * A table of `cols` x `rows` empty cells at the caret: in place of an empty paragraph, else after the block the caret is in. There is always a paragraph after it to
 * go on typing in. One undo step. Not inside a table (no nested tables); false then.
 */
export function insertTable(editor: Editor, cols: number, rows: number): boolean {
  const { state, view } = editor;
  const n = state.schema.nodes;
  if (!n.table || tableAt(state) || !(cols >= 1 && cols <= MAX_COLS && rows >= 1 && rows <= MAX_ROWS)) return false;
  const cell = () => n.tableCell.createAndFill()!;
  const row = () => n.tableRow.create(null, Array.from({ length: cols }, cell));
  const table = n.table.create({ borders: "all" }, Array.from({ length: rows }, row));
  const sel = state.selection;
  const tr = state.tr;
  let at: number;
  if (sel instanceof NodeSelection || sel.$from.depth === 0) {
    at = sel.to;
    tr.insert(at, table);
  } else {
    const top = sel.$from.node(1);
    const start = sel.$from.before(1);
    if (top.type.name === "paragraph" && top.content.size === 0) {
      at = start;
      tr.replaceWith(start, start + top.nodeSize, table);
    } else {
      at = start + top.nodeSize;
      tr.insert(at, table);
    }
  }
  const end = at + table.nodeSize;
  if (tr.doc.resolve(end).nodeAfter?.type.name !== "paragraph") tr.insert(end, n.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3))).scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

export type TableAction = "rowAbove" | "rowBelow" | "colLeft" | "colRight" | "deleteRow" | "deleteCol" | "deleteTable";

/** One of the structure commands of the table tools. */
export function tableAction(editor: Editor, a: TableAction): boolean {
  const chain = editor.chain().focus();
  switch (a) {
    case "rowAbove": return chain.addRowBefore().run();
    case "rowBelow": return chain.addRowAfter().run();
    case "colLeft": return chain.addColumnBefore().run();
    case "colRight": return chain.addColumnAfter().run();
    case "deleteRow": return chain.deleteRow().run();
    case "deleteCol": return chain.deleteColumn().run();
    case "deleteTable": return chain.deleteTable().run();
  }
}

/**
 * Merge cells (W2.19): the selected rectangle of cells (a cell selection: a drag across cells, or Shift+Arrow from a cell's edge) becomes one cell that keeps all their
 * content in reading order, with colspan / rowspan set; the shading of the top-left cell stays. One undo step. prosemirror-tables refuses a selection that is not a rectangle
 * (a cell that spans out of it) and a single cell.
 */
export function canMergeCells(state: EditorState): boolean {
  return mergeCells(state);
}
export function mergeSelectedCells(editor: Editor): boolean {
  const done = mergeCells(editor.state, (tr) => editor.view.dispatch(tr));
  if (done) editor.view.focus();
  return done;
}

/** Split cell: the cell the caret is in (or a single selected cell) with a colspan or rowspan above 1 becomes single cells again, its content in the top-left one. */
export function canSplitCell(state: EditorState): boolean {
  return splitCell(state);
}
export function splitSelectedCell(editor: Editor): boolean {
  const done = splitCell(editor.state, (tr) => editor.view.dispatch(tr));
  if (done) editor.view.focus();
  return done;
}

/** The border style of the table the caret is in (null outside a table). */
export function tableBorders(state: EditorState): TableBorders | null {
  const t = tableAt(state);
  const b = t?.node.attrs.borders;
  return t ? (b === "outside" || b === "none" ? b : "all") : null;
}

export function setBorders(editor: Editor, borders: TableBorders): boolean {
  const t = tableAt(editor.state);
  if (!t) return false;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, borders }));
  editor.view.focus();
  return true;
}

/** Whether the first row of the table is a header row (every cell of it a header cell). */
export function hasHeaderRow(state: EditorState): boolean {
  const t = tableAt(state);
  const first = t?.node.firstChild;
  if (!first || first.childCount === 0) return false;
  let all = true;
  first.forEach((c) => {
    if (c.type.name !== "tableHeader") all = false;
  });
  return all;
}

export const toggleHeaderRow = (editor: Editor): boolean => editor.chain().focus().toggleHeaderRow().run();

/** The shading of the selected cells (the cell the caret is in): `#RRGGBB`, or null for none. */
export const setShading = (editor: Editor, hex: string | null): boolean => editor.chain().focus().setCellAttribute("background", hex).run();

/** The shading of the cell the caret is in, "" when it has none. */
export function cellShading(state: EditorState): string {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") return typeof node.attrs.background === "string" ? node.attrs.background : "";
  }
  return "";
}
