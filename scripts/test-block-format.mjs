// The paragraph formats of the compose editor (spec-rich-text.md REQ-17 .. REQ-21, AC-29 .. AC-34): how alignment, indent, line spacing, space after a
// paragraph and the marker style of a list are read from HTML and written to it (src/editor/blockFormat.ts), and what the serializer makes of them.
// Run: node --experimental-strip-types scripts/test-block-format.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BULLET_STYLES, LINE_HEIGHTS, MAX_INDENT, NUMBER_STYLES, clampIndent, defaultListStyle, indentFromMargin, lengthPx, listStyleFromHtml, marginCss, normAlign, normLineHeight, normListStyle, olType,
  spaceAfterFromMargin, tailCss,
} from "../src/editor/blockFormat.ts";
import { docToHtml } from "../src/editor/emailHtml.ts";
import { parseTypedSize } from "../src/editor/fonts.ts";

// ---- lengths
assert.equal(lengthPx("40px"), 40);
assert.equal(lengthPx("30pt"), 40);
assert.equal(lengthPx(".5in"), 48);
assert.equal(lengthPx("1.27cm") !== null && Math.round(lengthPx("1.27cm")), 48);
assert.equal(lengthPx("0"), 0);
assert.equal(lengthPx("2em"), 32);
assert.equal(lengthPx("auto"), null);
assert.equal(lengthPx("10%"), null);
assert.equal(lengthPx("12"), null, "a number without a unit is no length (except 0)");
assert.equal(lengthPx(null), null);

// ---- alignment
assert.equal(normAlign("center"), "center");
assert.equal(normAlign(" Right "), "right");
assert.equal(normAlign("justify"), "justify");
assert.equal(normAlign("-webkit-center"), "center");
assert.equal(normAlign("left"), null, "left is what a paragraph is");
assert.equal(normAlign("start"), null);
assert.equal(normAlign("center;color:red"), null, "nothing can be smuggled in");
assert.equal(normAlign(undefined), null);

// ---- indent: steps of 40 px, 8 at most (AC-31)
assert.equal(indentFromMargin("40px"), 1);
assert.equal(indentFromMargin("120px"), 3);
assert.equal(indentFromMargin("0"), 0);
assert.equal(indentFromMargin("19px"), 0, "under half a step is none");
assert.equal(indentFromMargin("21px"), 1);
assert.equal(indentFromMargin("1000px"), MAX_INDENT);
assert.equal(indentFromMargin("-40px"), 0);
assert.equal(indentFromMargin("36pt"), 1, "Word's half inch");
assert.equal(indentFromMargin("auto"), 0);
assert.equal(clampIndent(3.4), 3);
assert.equal(clampIndent(99), 8);
assert.equal(clampIndent(-2), 0);
assert.equal(clampIndent("x"), 0);

// ---- line spacing: 1.0 / 1.15 / 1.5 / 2.0 (AC-33); 1 (single) is no declaration
assert.deepEqual([...LINE_HEIGHTS], [1, 1.15, 1.5, 2]);
assert.equal(normLineHeight("1.5"), "1.5");
assert.equal(normLineHeight(2), "2");
assert.equal(normLineHeight("2.0"), "2");
assert.equal(normLineHeight("1.15"), "1.15");
assert.equal(normLineHeight("115%"), "1.15");
assert.equal(normLineHeight("1"), null);
assert.equal(normLineHeight("100%"), null);
assert.equal(normLineHeight("normal"), null);
assert.equal(normLineHeight("15pt"), null, "a fixed length is not a spacing we keep");
assert.equal(normLineHeight("9"), null, "out of range");
assert.equal(normLineHeight("0.2"), null);
assert.equal(normLineHeight(null), null);

// ---- space after a paragraph
assert.equal(spaceAfterFromMargin("10pt", false), "add");
assert.equal(spaceAfterFromMargin("14px", false), "add");
assert.equal(spaceAfterFromMargin("1em", false), "add");
assert.equal(spaceAfterFromMargin("0", false), null, "a paragraph has none anyway");
assert.equal(spaceAfterFromMargin(".0001pt", false), null);
assert.equal(spaceAfterFromMargin("4pt", true), null, "a heading's own space");
assert.equal(spaceAfterFromMargin("0", true), "none");
assert.equal(spaceAfterFromMargin(".0001pt", true), "none", "what Word writes");
assert.equal(spaceAfterFromMargin("10pt", true), "add");
assert.equal(spaceAfterFromMargin("auto", true), null);

// ---- the style written for a block
assert.equal(marginCss("0", "0", {}), "margin:0");
assert.equal(marginCss("0", "0", { indent: 3 }), "margin:0 0 0 120px");
assert.equal(marginCss("0", "0", { spaceAfter: "add" }), "margin:0 0 10pt");
assert.equal(marginCss("0", "0", { spaceAfter: "add", indent: 1 }), "margin:0 0 10pt 40px");
assert.equal(marginCss("0", "0", { spaceAfter: "none" }), "margin:0");
assert.equal(marginCss("12pt", "4pt", {}), "margin:12pt 0 4pt");
assert.equal(marginCss("12pt", "4pt", { spaceAfter: "none" }), "margin:12pt 0 0");
assert.equal(marginCss("12pt", "4pt", { spaceAfter: "add", indent: 2 }), "margin:12pt 0 10pt 80px");
assert.equal(marginCss("0", "0", { indent: 99 }), "margin:0 0 0 320px", "8 steps at most");
assert.equal(tailCss({}), "");
assert.equal(tailCss({ textAlign: "center" }), ";text-align:center");
assert.equal(tailCss({ textAlign: "justify", lineHeight: "1.5" }), ";text-align:justify;line-height:1.5");
assert.equal(tailCss({ textAlign: "left", lineHeight: "1" }), "", "left and single are no declarations");
assert.equal(tailCss({ textAlign: "center;x:y", lineHeight: "1;x:y" }), "", "nothing can be smuggled in");

// ---- list styles (AC-29, AC-30)
assert.deepEqual([...BULLET_STYLES], ["disc", "circle", "square"]);
assert.deepEqual([...NUMBER_STYLES], ["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"]);
assert.deepEqual([0, 1, 2, 3].map((d) => defaultListStyle(false, d)), ["disc", "circle", "square", "disc"], "bullets cycle disc, circle, square");
assert.deepEqual([0, 1, 2, 3].map((d) => defaultListStyle(true, d)), ["decimal", "lower-alpha", "lower-roman", "decimal"], "numbers cycle 1. a. i.");
assert.equal(normListStyle(true, "upper-alpha"), "upper-alpha");
assert.equal(normListStyle(true, "lower-latin"), "lower-alpha");
assert.equal(normListStyle(true, "A"), "upper-alpha");
assert.equal(normListStyle(true, "I"), "upper-roman");
assert.equal(normListStyle(true, "disc"), null, "a bullet name is no numbering");
assert.equal(normListStyle(false, "decimal"), null, "a numbering is no bullet");
assert.equal(normListStyle(false, "SQUARE"), "square");
assert.equal(normListStyle(false, "url(x)"), null);
assert.equal(olType("decimal"), "1");
assert.equal(olType("lower-alpha"), "a");
assert.equal(olType("upper-alpha"), "A");
assert.equal(olType("lower-roman"), "i");
assert.equal(olType("upper-roman"), "I");
// reading a list back: the style that the nesting level gives anyway is "not set"
assert.equal(listStyleFromHtml(false, "disc", null, 0), null);
assert.equal(listStyleFromHtml(false, "circle", null, 0), "circle");
assert.equal(listStyleFromHtml(false, "circle", null, 1), null);
assert.equal(listStyleFromHtml(true, "lower-alpha", "a", 1), null);
assert.equal(listStyleFromHtml(true, "", "A", 0), "upper-alpha", "type attribute without a style");
assert.equal(listStyleFromHtml(true, "upper-roman", "I", 0), "upper-roman");
assert.equal(listStyleFromHtml(false, "", "square", 0), null, "a bullet list has no type attribute");

// ---- the size box (decision 1: an editable combo)
assert.equal(parseTypedSize("14"), 14);
assert.equal(parseTypedSize(" 10,5 "), 10.5);
assert.equal(parseTypedSize("12pt"), 12);
assert.equal(parseTypedSize("0"), null);
assert.equal(parseTypedSize("401"), null);
assert.equal(parseTypedSize("400"), 400);
assert.equal(parseTypedSize("1"), 1);
assert.equal(parseTypedSize("abc"), null);
assert.equal(parseTypedSize(""), null);
assert.equal(parseTypedSize("12 24"), null);
assert.equal(parseTypedSize("-5"), null);

// ---- the serializer
const P = (t, attrs) => ({ type: "paragraph", ...(attrs ? { attrs } : {}), content: [{ type: "text", text: t }] });
const H = (level, t, attrs) => ({ type: "heading", attrs: { level, ...(attrs ?? {}) }, content: [{ type: "text", text: t }] });
const html = (...blocks) => docToHtml({ type: "doc", content: blocks });
assert.equal(html(P("a")), '<p style="margin:0">a</p>');
assert.equal(html(P("a", { textAlign: "center" })), '<p style="margin:0;text-align:center">a</p>');
assert.equal(html(P("a", { textAlign: null, indent: 0, lineHeight: null, spaceAfter: null })), '<p style="margin:0">a</p>', "null attributes write nothing");
assert.equal(html(P("a", { indent: 3 })), '<p style="margin:0 0 0 120px">a</p>', "AC-31: three steps is margin-left 120px");
assert.equal(html(P("a", { lineHeight: "1.5" })), '<p style="margin:0;line-height:1.5">a</p>', "AC-33");
assert.equal(html(P("a", { spaceAfter: "add" })), '<p style="margin:0 0 10pt">a</p>');
assert.equal(html(P("a", { spaceAfter: "none" })), '<p style="margin:0">a</p>', "AC-33: no space after is margin-bottom 0");
assert.equal(html(P("a", { textAlign: "justify", indent: 1, lineHeight: "2", spaceAfter: "add" })), '<p style="margin:0 0 10pt 40px;text-align:justify;line-height:2">a</p>');
assert.equal(html(P("a", { textAlign: "evil;x:y", lineHeight: "1;x:y", indent: "z" })), '<p style="margin:0">a</p>', "a stored value cannot add a declaration");
assert.equal(html(H(2, "T", { textAlign: "right" })), '<h2 style="font-size:14pt;font-weight:bold;margin:12pt 0 4pt;text-align:right">T</h2>');
assert.equal(html(H(1, "T", { spaceAfter: "none", indent: 2 })), '<h1 style="font-size:18pt;font-weight:bold;margin:12pt 0 0 80px">T</h1>');
assert.equal(html(H(3, "T", { spaceAfter: "add", lineHeight: "1.15" })), '<h3 style="font-size:12pt;font-weight:bold;margin:12pt 0 10pt;line-height:1.15">T</h3>');
// lists: the nesting level gives the marker unless the list has its own
const item = (t, ...rest) => ({ type: "listItem", content: [P(t), ...rest] });
const ul = (attrs, ...items) => ({ type: "bulletList", ...(attrs ? { attrs } : {}), content: items });
const ol = (attrs, ...items) => ({ type: "orderedList", ...(attrs ? { attrs } : {}), content: items });
const BOX = "margin:0 0 0 40px;padding:0";
assert.equal(html(ul(null, item("a"))), `<ul style="list-style-type:disc;${BOX}"><li>a</li></ul>`);
assert.equal(html(ul({ listStyle: "square" }, item("a"))), `<ul style="list-style-type:square;${BOX}"><li>a</li></ul>`);
assert.equal(html(ul({ listStyle: "circle" }, item("a"))), `<ul style="list-style-type:circle;${BOX}"><li>a</li></ul>`);
assert.equal(html(ul({ listStyle: "decimal" }, item("a"))), `<ul style="list-style-type:disc;${BOX}"><li>a</li></ul>`, "a numbering name on a bullet list is ignored");
assert.equal(html(ol(null, item("a"))), `<ol style="list-style-type:decimal;${BOX}"><li>a</li></ol>`);
assert.equal(html(ol({ listStyle: "upper-alpha" }, item("a"))), `<ol type="A" style="list-style-type:upper-alpha;${BOX}"><li>a</li></ol>`);
assert.equal(html(ol({ listStyle: "lower-roman", start: 3 }, item("a"))), `<ol type="i" start="3" style="list-style-type:lower-roman;${BOX}"><li>a</li></ol>`);
assert.equal(html(ol({ listStyle: "upper-roman" }, item("a"))), `<ol type="I" style="list-style-type:upper-roman;${BOX}"><li>a</li></ol>`);
assert.equal(html(ol({ listStyle: "bogus" }, item("a"))), `<ol style="list-style-type:decimal;${BOX}"><li>a</li></ol>`);
// AC-30: three levels with Tab are disc, circle, square and 1. a. i.
assert.equal(
  html(ul(null, item("a", ul(null, item("b", ul(null, item("c"))))))),
  `<ul style="list-style-type:disc;${BOX}"><li>a<ul style="list-style-type:circle;${BOX}"><li>b<ul style="list-style-type:square;${BOX}"><li>c</li></ul></li></ul></li></ul>`,
);
assert.equal(
  html(ol(null, item("a", ol(null, item("b", ol(null, item("c"))))))),
  `<ol style="list-style-type:decimal;${BOX}"><li>a<ol type="a" style="list-style-type:lower-alpha;${BOX}"><li>b<ol type="i" style="list-style-type:lower-roman;${BOX}"><li>c</li></ol></li></ol></li></ol>`,
);
// a nested list with its own style keeps it, one level up it would have the level's
assert.equal(
  html(ul(null, item("a", ul({ listStyle: "square" }, item("b"))))),
  `<ul style="list-style-type:disc;${BOX}"><li>a<ul style="list-style-type:square;${BOX}"><li>b</li></ul></li></ul>`,
);
// a list item whose paragraph has a format keeps its <p> (it carries the style); a plain one has its text straight in the <li>
assert.equal(html(ul(null, { type: "listItem", content: [P("a", { textAlign: "center" })] })), `<ul style="list-style-type:disc;${BOX}"><li><p style="margin:0;text-align:center">a</p></li></ul>`);
assert.equal(html(ul(null, { type: "listItem", content: [P("a", { textAlign: "center" }), ul(null, item("b"))] })), `<ul style="list-style-type:disc;${BOX}"><li><p style="margin:0;text-align:center">a</p><ul style="list-style-type:circle;${BOX}"><li>b</li></ul></li></ul>`);
// quoted paragraphs carry the formats too
assert.equal(html({ type: "blockquote", content: [P("q", { indent: 1 })] }), '<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p style="margin:0 0 0 40px">q</p></blockquote>');


// ---- wiring guards (the editor itself needs a browser; the dev mock checks the behaviour, these keep the pieces connected)
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ext = read("src/editor/extensions.ts");
assert.match(ext, /BlockFormat,\n\s+FormatKeys\(o\.getBase, o\.focusToolbar, o\.openStyles\)/, "the block formats and the keys are in the one extension set (message, signature, template)");
for (const key of ["Mod-l", "Mod-e", "Mod-r", "Mod-Shift-j", "Mod-t", "Mod-Shift-t", "Mod-Shift-s", "Mod-Shift-n", "Mod-Alt-1", "Mod-Alt-2", "Mod-Alt-3", "Mod-Shift-l"]) assert.ok(ext.includes(`"${key}":`), `the key ${key}`);
assert.match(ext, /priority: 1000/, "the keys come before the editor's own Ctrl+Alt+1..3");
assert.match(ext, /hardBreak: false/, "the line break is the one with the empty-paragraph rule");
assert.match(ext, /tag: "br", getAttrs: .*childNodes\.length === 1 \? false : null/, "<p><br></p> is an empty paragraph, not a paragraph holding a line break");
for (const host of ["src/components/Compose.tsx", "src/components/RichEditor.tsx"]) assert.match(read(host), /openStyles: \(\) => barApi\.current\?\.openStyles\(\)/, `${host} opens the Styles menu for Ctrl+Shift+S`);
const ctl = read("src/editor/controls.tsx");
for (const id of ["listControl(false)", "listControl(true)", "alignControl", "stylesControl", "insertControl", 'id: "indentLess"', 'id: "indentMore"']) assert.ok(ctl.includes(id), `the registry has ${id}`);
assert.match(ctl, /id: "spacing"[\s\S]*id: "hr"/, "Line spacing and Horizontal line live in the More menu");
assert.match(read("src/editor/FormatBar.tsx"), /trailing\?\.ids/, "the host's controls share the roving focus");

console.log("block-format: all checks passed");
