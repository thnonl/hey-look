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
import { docToHtml } from "../src/editor/emailHtml.ts";
import { EMOJI_GROUPS, osEmojiKeys } from "../src/editor/emojiData.ts";
import { PictureNode } from "../src/editor/pictureNode.ts";
import { cellShading, hasHeaderRow, insertTable, setBorders, tableAt, tableBorders, MAX_COLS, MAX_ROWS } from "../src/editor/tableCommands.ts";
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
