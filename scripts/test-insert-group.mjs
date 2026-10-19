// The Insert group of the compose editor (spec-rich-text.md REQ-30 .. REQ-34, REQ-40): what tables, pictures, links and emoji are written as, the table commands on
// real documents (ProseMirror state built from the editor's schema, no DOM), the emoji data and the wiring of the controls. The parse rules that need a DOM (a table's
// border style read back from cells, a picture's wrapper) and the keys are checked in the dev mock and in the real window; the serializer, the sanitiser
// (cargo test --lib outgoing) and the golden files (test-rich-golden.mjs) cover what is sent.
// Run: node --experimental-strip-types scripts/test-insert-group.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { history, undo } from "@tiptap/pm/history";
import { cellGrid, docToHtml } from "../src/editor/emailHtml.ts";
import { htmlToText } from "../src/htmlText.ts";
import { EMOJI_GROUPS, osEmojiKeys } from "../src/editor/emojiData.ts";
import { PictureNode } from "../src/editor/pictureNode.ts";
import { canMergeCells, canSplitCell, cellShading, hasHeaderRow, mergeSelectedCells, splitSelectedCell, insertTable, setBorders, tableAt, tableBorders, MAX_COLS, MAX_ROWS } from "../src/editor/tableCommands.ts";
import { tableExtensions } from "../src/editor/tableExtension.ts";
import { BAR_META } from "../src/editor/toolbarLayout.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");
const schema = getSchema([StarterKit.configure({ strike: false, code: false, hardBreak: false, heading: { levels: [1, 2, 3] } }), ...tableExtensions(), PictureNode]);
const BASE = { family: "Calibri,Carlito,Arial,sans-serif", size: 11 };

const P = (t) => ({ type: "paragraph", ...(t ? { content: [{ type: "text", text: t }] } : {}) });
const cell = (attrs, ...blocks) => ({ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null, ...attrs }, content: blocks.length ? blocks : [P()] });
const th = (attrs, ...blocks) => ({ ...cell(attrs, ...blocks), type: "tableHeader" });
const table = (borders, ...rows) => ({ type: "table", attrs: { borders }, content: rows.map((r) => ({ type: "tableRow", content: r })) });
const doc = (...blocks) => ({ type: "doc", content: blocks });

// ---- the serializer: tables
{
  const h = docToHtml(doc(table("all", [th({}, P("H")), cell({ background: "#ffff00" }, P("a"))])), BASE);
  assert.ok(h.startsWith('<table border="1" cellpadding="4" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%"><tbody><tr>'), "a table is full width with a border attribute");
  assert.ok(h.includes('<th style="font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt;border:1px solid #999999;padding:4px 6px;vertical-align:top;font-weight:bold;text-align:left">'), "a header cell is a bold th, with the default font repeated (classic Outlook does not inherit it)");
  assert.ok(h.includes('<td style="font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt;border:1px solid #999999;padding:4px 6px;vertical-align:top;background-color:#FFFF00" bgcolor="#FFFF00">'), "shading is written twice: bgcolor and background-color, upper case");
  assert.ok(!docToHtml(doc(table("all", [cell({})]))).includes("font-family"), "without a default font no font is repeated");
  assert.ok(!/class=|<style|data-/.test(h), "no classes, no <style>, no data- attributes");
  // a bold mark in a header cell says nothing (the cell is bold by its own style): it is not written, so a reopened draft does not gain <strong>
  const hb = docToHtml(doc(table("all", [th({}, { type: "paragraph", content: [{ type: "text", text: "B", marks: [{ type: "bold" }] }] })])));
  assert.ok(!hb.includes("<strong>") && hb.includes(">B<"), hb);
  assert.ok(docToHtml(doc(table("all", [cell({}), cell({})]), { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }] })).endsWith("<strong>x</strong></p>"), "bold outside a header is written again");
  // borders: outside = the sides of the edge cells, none = no border at all
  const out = docToHtml(doc(table("outside", [cell({}, P("1")), cell({}, P("2"))], [cell({}, P("3")), cell({}, P("4"))])));
  assert.ok(out.startsWith('<table border="0"'));
  assert.ok(out.includes("border-top:1px solid #999999;border-left:1px solid #999999;padding") && out.includes("border-top:1px solid #999999;border-right:1px solid #999999;padding"), "top row: top + left / right");
  assert.ok(out.includes("border-left:1px solid #999999;border-bottom:1px solid #999999") === false && out.includes("border-bottom:1px solid #999999;border-left:1px solid #999999;padding") && out.includes("border-right:1px solid #999999;border-bottom:1px solid #999999;padding"), "bottom row: bottom + left / right");
  const none = docToHtml(doc(table("none", [cell({}, P("1"))])));
  assert.ok(none.startsWith('<table border="0"') && !none.includes("border:1px") && !none.includes("border-top"), none);
  assert.ok(docToHtml(doc(table("bogus", [cell({})]))).startsWith('<table border="1"'), "an unknown border style is all borders");
  // spans, nothing smuggled through an attribute
  const sp = docToHtml(doc(table("all", [cell({ colspan: 2, rowspan: 3, background: "red;position:fixed" }), cell({ colspan: 1, rowspan: 1, background: "#12345" })])));
  assert.ok(sp.includes('colspan="2" rowspan="3" style="') && !sp.includes("position") && !sp.includes("bgcolor") && !sp.includes("red"), sp);
  assert.ok(docToHtml(doc(table("all", [cell({ colspan: 99999 })]))).includes('colspan="100"'), "a huge span is capped");
  // a list in a cell is a first-level list, an empty cell keeps its height
  const li = docToHtml(doc(table("all", [cell({}, { type: "bulletList", content: [{ type: "listItem", content: [P("x")] }] }), cell({})])));
  assert.ok(li.includes('<ul style="list-style-type:disc;') && li.includes('<p style="margin:0"><br></p>'), li);
}

// ---- the serializer: pictures
{
  const img = (a) => ({ type: "image", attrs: { src: "data:image/png;base64,AAAA", alt: "a", width: 100, "data-name": "x.png", align: null, href: null, ...a } });
  const html = (a) => docToHtml(doc(img(a)));
  assert.ok(html({}).startsWith('<img src="data:image/png;base64,AAAA" alt="a" width="100" style="max-width:100%;height:auto"'), "left (default): the bare picture, as before");
  assert.ok(html({ align: "center" }).startsWith('<div style="text-align:center"><img '), "centre");
  assert.ok(html({ align: "right" }).startsWith('<div style="text-align:right"><img '), "right");
  assert.ok(html({ align: "left" }).startsWith("<img "), "left is no wrapper");
  assert.ok(html({ align: "justify" }).startsWith("<img "), "an unknown alignment is left");
  const l = html({ href: "https://heylook.app", align: "center" });
  assert.ok(l.startsWith('<div style="text-align:center"><a href="https://heylook.app"><img ') && l.includes("border:0") && l.endsWith("</a></div>"), l);
  assert.ok(html({ href: "mailto:qa@test.local" }).startsWith('<a href="mailto:qa@test.local"><img '));
  for (const bad of ["javascript:alert(1)", "file:///c:/x", "data:text/html,x", "ftp://x.test/f", " JaVaScRiPt:x", "//evil.test"]) assert.ok(!html({ href: bad }).includes("<a "), `${bad} is not written as a link`);
  // a picture inside a paragraph (the rare inline one) is never wrapped in a block
  const inline = docToHtml(doc({ type: "paragraph", content: [{ type: "text", text: "a" }, img({ align: "center" })] }));
  assert.ok(!inline.includes("<div"), inline);
}

// ---- the table commands on a document
{
  const mk = (d) => EditorState.create({ doc: schema.nodeFromJSON(d), selection: undefined });
  /** a stand-in editor: the state and a view that applies what is dispatched */
  const fake = (state) => {
    const ed = { state, view: { dispatch(tr) { ed.state = ed.state.apply(tr); }, focus() {} } };
    return ed;
  };
  const caretIn = (state, needle) => {
    let at = -1;
    state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text.includes(needle)) at = p + 1; });
    assert.ok(at > 0, needle);
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
  };
  // insertion: after the block the caret is in; in place of an empty paragraph; a paragraph follows
  let ed = fake(caretIn(mk(doc(P("Hello"), P("tail"))), "Hello"));
  assert.equal(insertTable(ed, 3, 2), true);
  let names = ed.state.doc.content.content.map((n) => n.type.name);
  assert.deepEqual(names, ["paragraph", "table", "paragraph"], "after the paragraph the caret was in; the next paragraph follows");
  const t = tableAt(ed.state);
  assert.ok(t && t.node.childCount === 2 && t.node.firstChild.childCount === 3, "2 rows x 3 columns, and the caret is in the first cell");
  assert.equal(tableBorders(ed.state), "all", "a new table has borders");
  assert.equal(ed.state.doc.child(1).textContent, "");
  assert.equal(insertTable(ed, 2, 2), false, "no table inside a table");
  assert.equal(ed.state.doc.childCount, 3);
  // limits
  const ok = (c, r) => insertTable(fake(caretIn(mk(doc(P("x"))), "x")), c, r);
  assert.deepEqual([ok(0, 2), ok(MAX_COLS + 1, 2), ok(2, 0), ok(2, MAX_ROWS + 1), ok(MAX_COLS, MAX_ROWS), ok(1, 1)], [false, false, false, false, true, true]);
  // in place of an empty paragraph; a table at the end gets its paragraph; two blocks behind it stay
  ed = fake(mk(doc(P(), P("keep"))));
  ed.state = ed.state.apply(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1)));
  insertTable(ed, 2, 1);
  names = ed.state.doc.content.content.map((n) => n.type.name);
  assert.deepEqual(names, ["table", "paragraph"], "the empty paragraph is replaced (the one after it is the paragraph to type in)");
  assert.equal(ed.state.doc.lastChild.textContent, "keep");
  ed = fake(mk(doc(P())));
  ed.state = ed.state.apply(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1)));
  insertTable(ed, 2, 2);
  assert.deepEqual(ed.state.doc.content.content.map((n) => n.type.name), ["table", "paragraph"], "the only (empty) paragraph: a table and a paragraph to type in");
  // after a picture
  ed = fake(mk(doc(P("a"), { type: "image", attrs: { src: "data:image/png;base64,AAAA" } })));
  ed.state = ed.state.apply(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, ed.state.doc.child(0).nodeSize)));
  insertTable(ed, 1, 1);
  assert.deepEqual(ed.state.doc.content.content.map((n) => n.type.name), ["paragraph", "image", "table", "paragraph"]);
  // borders, header row, shading questions
  ed = fake(caretIn(mk(doc(table("outside", [th({}, P("H")), cell({ background: "#92D050" }, P("g"))], [cell({}, P("a")), cell({}, P("b"))]))), "g"));
  assert.equal(tableBorders(ed.state), "outside");
  assert.equal(hasHeaderRow(ed.state), false, "one header cell of two is not a header row");
  assert.equal(cellShading(ed.state), "#92D050");
  assert.equal(setBorders(ed, "none"), true);
  assert.equal(tableBorders(ed.state), "none");
  ed = fake(caretIn(mk(doc(table("all", [th({}, P("H")), th({}, P("I"))], [cell({}, P("a")), cell({}, P("b"))]))), "H"));
  assert.equal(hasHeaderRow(ed.state), true);
  assert.equal(cellShading(ed.state), "");
  assert.equal(tableBorders(caretIn(mk(doc(P("no table"))), "no table")), null);
}

// ---- W2.19: merge and split cells (real ProseMirror state with prosemirror-tables and the history plugin, no DOM)
{
  const state0 = (d) => EditorState.create({ doc: schema.nodeFromJSON(d), plugins: [history()] });
  const fake = (state) => { const ed = { state, view: { dispatch(tr) { ed.state = ed.state.apply(tr); }, focus() {} } }; return ed; };
  const cellAt = (state, needle) => { let at = -1; state.doc.descendants((n, p) => { if (at < 0 && (n.type.name === "tableCell" || n.type.name === "tableHeader") && n.textContent.startsWith(needle)) at = p; }); assert.ok(at >= 0, needle); return at; };
  const select = (ed, a, b) => { ed.state = ed.state.apply(ed.state.tr.setSelection(CellSelection.create(ed.state.doc, cellAt(ed.state, a), cellAt(ed.state, b)))); return ed; };
  const caret = (ed, needle) => { let at = -1; ed.state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text.includes(needle)) at = p + 1; }); ed.state = ed.state.apply(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at))); return ed; };
  const grid = () => doc(table("all",
    [cell({ background: "#92D050" }, P("A1")), cell({}, P("B1")), cell({}, P("C1"))],
    [cell({}, P("A2")), cell({}, P("B2")), cell({}, P("C2"))],
    [cell({}, P("A3")), cell({}, P("B3")), cell({}, P("C3"))]));
  const rows = (ed) => ed.state.doc.child(0).content.content.map((r) => r.content.content.map((c) => ({ t: c.textContent, p: c.childCount, cs: c.attrs.colspan, rs: c.attrs.rowspan, bg: c.attrs.background })));

  // a single cell, a caret and a text selection across two cells are not mergeable; a split is not possible on a normal cell
  let ed = fake(state0(grid()));
  assert.equal(canMergeCells(ed.state), false, "no selection");
  caret(ed, "A1");
  assert.deepEqual([canMergeCells(ed.state), canSplitCell(ed.state), mergeSelectedCells(ed), splitSelectedCell(ed)], [false, false, false, false], "a caret in a normal cell");
  select(ed, "A1", "A1");
  assert.deepEqual([canMergeCells(ed.state), canSplitCell(ed.state)], [false, false], "one cell selected: Merge is off, Split is off on a normal cell");

  // A1:B1 -> one cell spanning 2 columns with both texts (two paragraphs, reading order); the shading of the top-left cell is kept
  select(ed, "A1", "B1");
  assert.equal(canMergeCells(ed.state), true);
  assert.equal(mergeSelectedCells(ed), true);
  let r = rows(ed);
  assert.deepEqual(r[0].map((c) => [c.t, c.p, c.cs, c.rs, c.bg]), [["A1B1", 2, 2, 1, "#92D050"], ["C1", 1, 1, 1, null]], "A1 and B1 in one cell, colspan 2, shading of A1");
  assert.equal(r[1].length, 3, "the other rows are untouched");
  // A2:A3 -> rowspan 2
  select(ed, "A2", "A3");
  assert.equal(mergeSelectedCells(ed), true);
  r = rows(ed);
  assert.deepEqual([r[1][0].t, r[1][0].rs, r[2].length], ["A2A3", 2, 2], "rowspan 2, and the row below has one cell less");
  // a selection that is not a rectangle (A1:B2 while A2 spans down into row 3 and sticks out of it) is refused and nothing changes
  const wide = select(fake(state0(doc(table("all", [cell({}, P("A1")), cell({}, P("B1"))], [cell({ rowspan: 2 }, P("A2")), cell({}, P("B2"))], [cell({}, P("B3"))])))), "A1", "B2");
  const wideBefore = JSON.stringify(rows(wide));
  assert.deepEqual([canMergeCells(wide.state), mergeSelectedCells(wide)], [false, false], "a non-rectangle is refused");
  assert.equal(JSON.stringify(rows(wide)), wideBefore, "and the table is as it was");
  // (a rectangle that holds the whole spanned cell is fine: A1:A3 with A2 spanning rows 2-3)
  const whole = select(fake(state0(doc(table("all", [cell({}, P("A1")), cell({}, P("B1"))], [cell({ rowspan: 2 }, P("A2")), cell({}, P("B2"))], [cell({}, P("B3"))])))), "A1", "A2");
  assert.equal(mergeSelectedCells(whole), true);
  assert.deepEqual([rows(whole)[0][0].rs, rows(whole)[0].length], [3, 2], "A1 and the spanned A2 are one cell spanning three rows");

  // Split cell: the merged cell goes back to single cells, its content in the top-left one
  ed = fake(state0(grid()));
  select(ed, "A1", "B1");
  mergeSelectedCells(ed);
  caret(ed, "A1");
  assert.equal(canSplitCell(ed.state), true, "the caret is in a cell with a colspan");
  assert.equal(canMergeCells(ed.state), false, "a caret is not a cell selection");
  assert.equal(splitSelectedCell(ed), true);
  r = rows(ed);
  assert.deepEqual(r[0].map((c) => [c.t, c.cs, c.rs]), [["A1B1", 1, 1], ["", 1, 1], ["C1", 1, 1]], "two cells again, all the text in the left one");
  assert.equal(r[0].length, 3);
  // a selected single merged cell splits too
  select(ed, "A2", "B2");
  mergeSelectedCells(ed);
  select(ed, "A2", "A2");
  assert.equal(canSplitCell(ed.state), true, "a single selected merged cell can be split");

  // Ctrl+Z undoes a merge and a split, each in one step
  ed = fake(state0(grid()));
  select(ed, "A1", "B2");
  const before = JSON.stringify(rows(ed));
  mergeSelectedCells(ed);
  assert.notEqual(JSON.stringify(rows(ed)), before);
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.equal(JSON.stringify(rows(ed)), before, "one undo restores the four cells");
  mergeSelectedCells(select(ed, "A1", "B2"));
  caret(ed, "A1");
  const merged = JSON.stringify(rows(ed));
  splitSelectedCell(ed);
  undo(ed.state, (tr) => { ed.state = ed.state.apply(tr); });
  assert.equal(JSON.stringify(rows(ed)), merged, "one undo puts a split back");

  // header row, borders and Delete row / column keep working with spans
  ed = fake(state0(doc(table("outside", [th({}, P("H1")), th({}, P("H2")), th({}, P("H3"))], [cell({}, P("A2")), cell({}, P("B2")), cell({}, P("C2"))], [cell({}, P("A3")), cell({}, P("B3")), cell({}, P("C3"))]))));
  select(ed, "A2", "B2");
  mergeSelectedCells(ed);
  caret(ed, "H1");
  assert.equal(hasHeaderRow(ed.state), true, "the header row stays a header row");
  assert.equal(setBorders(ed, "all") && tableBorders(ed.state), "all");
}

// ---- W2.19: the serializer with spans: colspan / rowspan, and the outside frame is complete at the merged cells
{
  const span = (colspan, rowspan, text) => cell({ colspan, rowspan }, P(text));
  const h = docToHtml(doc(table("outside",
    [span(2, 1, "A1"), span(1, 1, "C1")],
    [span(1, 2, "A2"), span(1, 1, "B2"), span(1, 1, "C2")],
    [span(1, 1, "B3"), span(1, 1, "C3")])));
  assert.ok(h.includes('<td colspan="2" style=') && h.includes('<td rowspan="2" style='), "colspan and rowspan are written");
  const sides = Object.fromEntries([...h.matchAll(/<td[^>]*style="([^"]*)"[^>]*><p[^>]*>([A-C]\d)<\/p><\/td>/g)].map((m) => [m[2], ["top", "right", "bottom", "left"].filter((s) => m[1].includes(`border-${s}:`)).join("+")]));
  assert.deepEqual(sides, {
    A1: "top+left", // spans columns 1-2: no right edge, it is not on the right side of the grid
    C1: "top+right",
    A2: "bottom+left", // spans rows 2-3: the bottom edge of the grid, not the top
    B2: "",
    C2: "right",
    B3: "bottom",
    C3: "right+bottom",
  }, "every outer edge of the grid is drawn by exactly the cell that is on it");
  // all four edges of the frame are covered: walk the grid
  const g = cellGrid([[{ colspan: 2, rowspan: 1 }, { colspan: 1, rowspan: 1 }], [{ colspan: 1, rowspan: 2 }, { colspan: 1, rowspan: 1 }, { colspan: 1, rowspan: 1 }], [{ colspan: 1, rowspan: 1 }, { colspan: 1, rowspan: 1 }]]);
  assert.deepEqual([g.rows, g.cols], [3, 3]);
  assert.deepEqual(g.cells[1][0], { row: 1, col: 0, lastRow: 2, lastCol: 0 }, "A2 reaches row 3");
  assert.deepEqual(g.cells[2].map((c) => c.col), [1, 2], "the row below a rowspan starts in the next free column");
  // all borders: every cell has its four sides; none: no side at all
  assert.ok(!docToHtml(doc(table("none", [span(2, 1, "x")]))).includes("border-top"));
  assert.ok(docToHtml(doc(table("all", [span(2, 1, "x")]))).includes("border:1px solid"));
  // a span that is too big for the table (a pasted table) cannot put the frame out of the grid
  assert.deepEqual(cellGrid([[{ colspan: 1, rowspan: 9 }]]).cells[0][0], { row: 0, col: 0, lastRow: 0, lastCol: 0 }, "a rowspan past the last row ends at the last row");
}

// ---- W2.19: the plain-text part writes a merged cell once, with tabs for the columns it spans
{
  assert.equal(htmlToText('<table><tr><td colspan="2">A1 B1</td><td>C1</td></tr><tr><td>A2</td><td>B2</td><td>C2</td></tr></table>'), "A1 B1\t\tC1\nA2\tB2\tC2", "A1 B1 spans two columns: two tabs before C1");
  assert.equal(htmlToText('<table><tr><td>a</td><td colspan="3">b</td></tr></table>'), "a\tb", "a spanning cell at the end adds nothing after it");
  assert.equal(htmlToText('<table><tr><td colspan="3">a</td><td>b</td></tr><tr><td>c</td></tr></table>'), "a\t\t\tb\nc", "the span does not leak into the next row");
}

// ---- W2.19: the wiring: both menus have the two rows, the bar has the two buttons, the texts exist
{
  const ui = read("src/editor/insertUi.tsx");
  assert.ok(/compose\.table\.merge[^\n]*canMergeCells/.test(ui) && /compose\.table\.split[^\n]*canSplitCell/.test(ui), "the Table button's menu has Merge cells and Split cell (disabled when they do not apply)");
  assert.ok(/disabled=\{!canMergeCells\(st\)\}[^\n]*mergeSelectedCells/.test(ui) && /disabled=\{!canSplitCell\(st\)\}[^\n]*splitSelectedCell/.test(ui), "the table tools bar has Merge cells and Split cell buttons");
  const en = read("src/i18n/ns/compose.ts");
  assert.ok(en.includes('"compose.table.merge": "Merge cells"') && en.includes('"compose.table.split": "Split cell"'));
  assert.ok(!/no merge or split/.test(read("src/editor/tableExtension.ts")), "the extension's comment no longer says there is no merge");
}

// ---- emoji
{
  assert.equal(EMOJI_GROUPS.length, 8, "8 categories");
  const all = new Set();
  for (const g of EMOJI_GROUPS) {
    assert.equal(g.emoji.length, 32, `${g.id}: 32 emoji`);
    for (const e of g.emoji) {
      assert.ok(e.length > 0 && !/\s/.test(e) && !e.includes("\u200d"), `${g.id}: no blank, no joined sequence: ${e}`);
      assert.ok(!all.has(e), `${e} is in two places`);
      all.add(e);
    }
  }
  assert.deepEqual(EMOJI_GROUPS.map((g) => g.id), ["smileys", "people", "animals", "food", "travel", "activities", "objects", "symbols"]);
  assert.equal(osEmojiKeys("windows"), "Win + .");
  assert.equal(osEmojiKeys("macos"), "Ctrl + Cmd + Space");
  assert.equal(osEmojiKeys("linux"), null);
}

// ---- the controls and their wiring
{
  assert.deepEqual({ ...BAR_META.table, variants: [...BAR_META.table.variants] }, { group: "insert", order: 72, priority: 170, width: 40, variants: ["compose", "compact"] });
  assert.ok(BAR_META.table.order > BAR_META.picture.order && BAR_META.table.order < BAR_META.insert.order, "Link, Picture, Table, Insert");
  const controls = read("src/editor/controls.tsx");
  assert.ok(/tableControl,\s*insertControl,/.test(controls), "the Table control is in the registry, before Insert");
  assert.ok(/import\("\.\/insertUi"\)/.test(controls) && !/from "\.\/insertUi"/.test(controls) && !/from "\.\/emojiData/.test(controls), "the table menu and the emoji picker are lazy: nothing of them is imported statically");
  assert.ok(/openPicker\("emoji", trigger\)/.test(controls) && /id: "emoji"/.test(controls), "Emoji is a row of the Insert menu and of More");
  const bar = read("src/editor/FormatBar.tsx");
  assert.ok(/lazy\(\(\) => import\("\.\/insertUi"\)/.test(bar) && /st\.inTable \|\| st\.inLink \|\| st\.onPicture/.test(bar), "the floating tools are mounted only when the caret is in a table / a link or a picture is selected");
  const ext = read("src/editor/extensions.ts");
  assert.ok(/openOnClick: false/.test(ext) && /defaultProtocol: "https"/.test(ext) && /isAllowedUri: \(url: string\) => checkLinkUrl\(url\)\.ok/.test(ext), "links: no open on click, https default, web / mail / tel only");
  assert.ok(/e\.ctrlKey/.test(ext) && /e\.metaKey/.test(ext) && /openExternal/.test(ext), "Ctrl (Cmd on a Mac) + click opens a link");
  assert.ok(/kitExtensions\(\{ pictures: o\.pictures \?\? false, quote: o\.quote, find: !!o\.openFind \}\)/.test(ext), "tables for every editor, the picture node only where it is asked for");
  const kit = read("src/editor/kit.ts");
  assert.ok(/import\("\.\/kitExtensions"\)/.test(kit) && !/from "\.\/(tableExtension|pictureNode|kitExtensions)"/.test(kit), "the kit loads on demand");
  assert.ok(/useKit\(\) \? <ComposeBody init=\{init\} \/> : null/.test(read("src/components/Compose.tsx")) && /pictures: true/.test(read("src/components/Compose.tsx")), "Compose waits for the kit and asks for pictures");
  assert.ok(/useKit\(\) \? <RichEditorBody/.test(read("src/components/RichEditor.tsx")) && !/pictures: true/.test(read("src/components/RichEditor.tsx")) && /baseExtensions\(\{[^}]*\bpictures\b/.test(read("src/components/RichEditor.tsx")), "the signature and template editors wait for the kit and have the picture node only when the caller asks for it (Settings does: REQ-25)");
  // the picture toolbar: alignment and link
  const compose = read("src/editor/PictureTools.tsx"); // (the picture toolbar, one component for the message and the signature editor since 1.0.7)
  assert.ok(/role="radiogroup" aria-label=\{t\("compose\.pic\.align"\)\}/.test(compose) && /setAlign/.test(compose) && /compose\.pic\.linkTip/.test(compose));
  // the link UI works on a selected picture
  const pop = read("src/components/LinkPopover.tsx");
  assert.ok(/picture: true/.test(pop) && /updateAttributes\("image", \{ href \}\)/.test(pop) && /compose\.link\.open/.test(pop), "the link popover edits a picture's link and can open a link (keyboard)");
  // the sanitiser-facing facts the Insert group relies on
  const css = read("src/App.css");
  for (const c of [".tbl-tools", ".link-bubble", ".pic-handle", ".tbl-grid", ".emoji-grid", 'table[data-borders="all"]', 'img[data-align="center"]', ".selectedCell"]) assert.ok(css.includes(c), `App.css has ${c}`);
  // Settings > Shortcuts lists the keys of this group
  const set = read("src/components/SettingsDialog.tsx");
  for (const k of ["settings.keys.insertLink", "settings.keys.openLink", "settings.keys.tableCells"]) assert.ok(set.includes(k), k);
}

console.log("test-insert-group: ok");
