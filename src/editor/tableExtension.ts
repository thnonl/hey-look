// Tables in the message body (spec-rich-text.md REQ-31..33): tiptap's table nodes, kept to what an email table is. A table is always 100 % wide with
// the border style the person chose (all borders, outside borders, no borders); a cell can have a shading colour and the first row can be a header
// row. There are no column widths (the columns share the width). A cell can span columns and rows: Merge cells and Split cell are in tableCommands.ts (the cell selection that
// Merge works on is prosemirror-tables' own, from the Table extension). How a table is written to the sent HTML is
// emailHtml.ts (inline styles and plain attributes, no classes); the parse rules here read exactly that back, and also what a Word / Excel / web
// table looks like once the paste cleaner (pasteClean.ts) is through with it (`border="1"`, `bgcolor`).
//
// Keys: Tab / Shift+Tab move to the next / previous cell, Tab in the last cell adds a row; Esc and then Tab leaves the table (the editor does not
// trap the keyboard); inside a list item of a cell Tab belongs to the list.

import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import type { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { normColor } from "./colors.ts";

export type TableBorders = "all" | "outside" | "none";

const sides = ["Top", "Right", "Bottom", "Left"] as const;
/** Whether a border side of a cell is drawn (style given and not `none`, width not 0). */
function sideOn(s: CSSStyleDeclaration, side: (typeof sides)[number]): boolean {
  const style = s[`border${side}Style` as "borderTopStyle"];
  const width = s[`border${side}Width` as "borderTopWidth"];
  return !!style && style !== "none" && style !== "hidden" && !/^0(px|pt)?$/.test(width);
}

/** The border style of a table element: every cell with all four sides = all; some sides = outside (the edge cells); the `border` attribute of a pasted table = all; else none. */
function readBorders(table: HTMLElement): TableBorders {
  const cells = Array.from(table.querySelectorAll<HTMLElement>("td, th"));
  if (cells.length) {
    const full = cells.filter((c) => sides.every((s) => sideOn(c.style, s))).length;
    if (full === cells.length) return "all";
    if (cells.some((c) => sides.some((s) => sideOn(c.style, s)))) return "outside";
  }
  return Number(table.getAttribute("border")) > 0 ? "all" : "none";
}

const span = (el: HTMLElement, name: "colspan" | "rowspan"): number => {
  const n = Number.parseInt(el.getAttribute(name) ?? "", 10);
  return n > 1 && n <= 100 ? n : 1;
};

function cellAttributes() {
  return {
    colspan: { default: 1, parseHTML: (el: HTMLElement) => span(el, "colspan"), renderHTML: (a: Record<string, unknown>) => (Number(a.colspan) > 1 ? { colspan: a.colspan } : {}) },
    rowspan: { default: 1, parseHTML: (el: HTMLElement) => span(el, "rowspan"), renderHTML: (a: Record<string, unknown>) => (Number(a.rowspan) > 1 ? { rowspan: a.rowspan } : {}) },
    // (prosemirror-tables keeps a width per column here; the columns of a message table have none, but its commands expect the attribute)
    colwidth: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    /** the shading colour `#RRGGBB`, or null */
    background: {
      default: null,
      parseHTML: (el: HTMLElement) => {
        const c = normColor(el.getAttribute("bgcolor") || el.style.backgroundColor);
        return c.startsWith("#") ? c : null; // (a colour name is not written to the mail)
      },
      renderHTML: (a: Record<string, unknown>) => (typeof a.background === "string" && a.background ? { style: `background-color:${a.background}` } : {}),
    },
  };
}

/** Set while the person has pressed Esc in a table: the next Tab leaves the table (and the editor) instead of moving to a cell. */
const leaving = new WeakSet<Editor>();

const EditorTable = Table.configure({ resizable: false, View: null as never, renderWrapper: false }).extend({
  addAttributes() {
    return {
      borders: {
        default: "all",
        parseHTML: (el: HTMLElement) => readBorders(el),
        renderHTML: (a: Record<string, unknown>) => ({ "data-borders": a.borders === "outside" || a.borders === "none" ? a.borders : "all" }),
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    return ["table", HTMLAttributes, ["tbody", 0]];
  },
  addKeyboardShortcuts() {
    const ed = this.editor;
    return {
      ...this.parent?.(),
      Escape: () => {
        if (ed.isActive("table")) leaving.add(ed);
        return false; // (Esc still does what it did: close the paste button ...)
      },
      Tab: () => {
        if (!ed.isActive("table")) return false;
        if (leaving.delete(ed)) return false;
        if (ed.isActive("listItem")) return false; // a list inside a cell nests with Tab
        if (ed.commands.goToNextCell()) return true;
        return ed.can().addRowAfter() ? ed.chain().addRowAfter().goToNextCell().run() : false;
      },
      "Shift-Tab": () => {
        if (!ed.isActive("table")) return false;
        if (leaving.delete(ed)) return false;
        if (ed.isActive("listItem")) return false;
        return ed.commands.goToPreviousCell();
      },
    };
  },
  // any other key or a click takes the "leave the table" mark away
  addProseMirrorPlugins() {
    const ed = this.editor;
    return [
      new Plugin({
        props: {
          handleKeyDown: (_view, e) => (e.key !== "Tab" && e.key !== "Escape" && !["Shift", "Control", "Alt", "Meta"].includes(e.key) && leaving.delete(ed), false),
          handleClick: () => (leaving.delete(ed), false),
        },
      }),
      ...(this.parent?.() ?? []),
    ];
  },
});

const Cell = TableCell.extend({ addAttributes: cellAttributes });
const Header = TableHeader.extend({ addAttributes: cellAttributes });

/** The nodes of a table: table, row, cell, header cell. */
export const tableExtensions = () => [EditorTable, TableRow, Cell, Header];
