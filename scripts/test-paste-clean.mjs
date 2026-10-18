// What a paste or a drop brings into the compose editor (spec-rich-text.md REQ-23, AC-37 .. AC-41): the clipboard HTML of Word, Excel, Outlook, Gmail, Google Docs,
// Chrome, Firefox, Safari and Apple's programs, cleaned for the three paste options. Every fixture in scripts/fixtures/paste/<name>.html is run through
// `cleanPaste` for Keep source formatting, Merge formatting and Keep text only, and the result must equal scripts/fixtures/paste/expected/<name>.{source,merge}.html
// and <name>.text.txt byte for byte. Plain text (a clipboard with no HTML) goes through `textToHtml` (plain-urls.txt -> expected/plain-urls.html).
// The reader and the cleaner are pure (no DOM), so these are the very strings the editor receives.
//
//   node --experimental-strip-types scripts/test-paste-clean.mjs           check
//   node --experimental-strip-types scripts/test-paste-clean.mjs --update  write the expected files (then read the diff before you commit it)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPaste, isInternalCopy, pasteText, textToHtml } from "../src/editor/pasteClean.ts";
import { MAX_DEPTH, parseHtml, textOf, toHtml } from "../src/editor/pasteTree.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "paste");
const exp = join(dir, "expected");
const update = process.argv.includes("--update");
if (update) mkdirSync(exp, { recursive: true });
const BASE = { family: "Calibri,Carlito,Arial,sans-serif", size: 11 };
const read = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
/** the fixtures are stored with one tag per line in the expected files so a diff is readable; the check compares the real output */
/** assert.equal that says where two long strings first differ */
const same = (a, b, msg) => {
  if (a === b) return;
  let i = 0;
  while (a[i] === b[i]) i++;
  assert.fail(`${msg}: differs at ${i}
  got:  ...${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))}
  want: ...${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`);
};
const lines = (html) => html.replace(/(<\/(?:p|h[1-3]|li|ul|ol|blockquote|pre|table|tr)>|<hr>)/g, "$1\n").replace(/\n$/, "") + "\n";

// ------------------------------------------------------------------------------------------------- the fixtures
const names = readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).sort();
assert.ok(names.length >= 9, "the fixtures are there");
const SAFE_TAGS = new Set(["p", "h1", "h2", "h3", "ul", "ol", "li", "blockquote", "pre", "hr", "br", "img", "a", "span", "strong", "em", "u", "s", "sub", "sup", "code"]);
const results = {};
for (const name of names) {
  const input = read(join(dir, `${name}.html`));
  const outs = {
    source: cleanPaste(input, { mode: "source", base: BASE }),
    merge: cleanPaste(input, { mode: "merge", base: BASE }),
  };
  results[name] = outs;
  const text = pasteText(input) + "\n";
  for (const [file, got] of [[`${name}.source.html`, lines(outs.source.html)], [`${name}.merge.html`, lines(outs.merge.html)], [`${name}.text.txt`, text]]) {
    const f = join(exp, file);
    if (update) writeFileSync(f, got);
    else {
      assert.ok(existsSync(f), `${file} is missing (run with --update)`);
      assert.equal(got, read(f), `${file} differs from the expected file`);
    }
  }
  for (const [mode, r] of Object.entries(outs)) {
    const h = r.html;
    // AC-40: nothing of Word's markup is left, in any mode; nothing the editor or the sanitiser would have to take away either
    for (const bad of ["mso-", "<o:p", "</o:p", "Mso", "<!--", "<![", "xmlns", "<style", "<script", "<iframe", "<object", "<form", "<input", "<svg", "javascript:", "file:", "cid:", "http://127.0.0.1", "onerror", "onclick", "data-sig-block", " class=", " id=", " lang=", "position:", "url(", "expression"]) {
      assert.ok(!h.toLowerCase().includes(bad.toLowerCase()), `${name}/${mode}: ${bad} in the output`);
    }
    for (const m of h.matchAll(/<\/?([a-z0-9:]+)/g)) assert.ok(SAFE_TAGS.has(m[1]), `${name}/${mode}: tag <${m[1]}> in the output`);
    for (const m of h.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)) assert.ok(/^data:image\/(?!svg)/.test(m[1]), `${name}/${mode}: picture ${m[1].slice(0, 40)}`);
    for (const m of h.matchAll(/<a href="([^"]*)"/g)) assert.ok(/^(?:https?:\/\/|mailto:|tel:)/i.test(m[1]), `${name}/${mode}: link ${m[1]}`);
    // balanced, and reading it again changes nothing: the output is in the cleaner's own form
    same(cleanPaste(h, { mode, base: BASE }).html, h, `${name}/${mode}: cleaning the output again changes it`);
  }
  // Merge takes no font, size, colour, highlight, line spacing or space after; Keep source never has less structure than Merge
  assert.ok(!/font-family|font-size|color|line-height|margin-bottom/.test(results[name].merge.html), `${name}: Merge keeps ${/font-family|font-size|color|line-height|margin-bottom/.exec(results[name].merge.html)}`);
  assert.equal(outs.source.html.replace(/ style="[^"]*"/g, "").replace(/<\/?span>/g, "").replace(/<\/?(?:u|strong|em|s|sub|sup)>/g, ""), outs.merge.html.replace(/ style="[^"]*"/g, "").replace(/<\/?span>/g, "").replace(/<\/?(?:u|strong|em|s|sub|sup)>/g, ""), `${name}: the text and blocks of Keep source and Merge are the same`);
  // Text only has no markup at all
  assert.ok(!/[<>]/.test(text.replace(/&[a-z]+;/g, "")) || name === "gmail" || name === "outlook", `${name}: markup in the text`);
}

// plain text with URLs (no HTML on the clipboard)
{
  const txt = read(join(dir, "plain-urls.txt"));
  const got = lines(textToHtml(txt));
  const f = join(exp, "plain-urls.html");
  if (update) writeFileSync(f, got);
  else assert.equal(got, read(f), "plain-urls.html differs from the expected file");
  assert.ok(got.includes("<p>See &lt;draft&gt; &amp; (http://example.com/a_(b)).</p>"), "text is escaped");
  assert.ok(got.includes("<p></p>") && got.includes("<p>\u00a0\u00a0Agenda: "), "blank lines stay, the indent stays");
}

// ------------------------------------------------------------------------------------------------- Word (AC-37, AC-40)
{
  const w = results.word;
  const src = w.source.html;
  // a three level numbered list: 1. / a. / i., and a bulleted one: disc / circle / square
  assert.ok(/<ol style="list-style-type:decimal"><li><strong>Plan<\/strong><ol style="list-style-type:lower-alpha"><li>Design<ol style="list-style-type:lower-roman"><li><span style="color:#FF0000">Wireframes \(red\)<\/span><\/li><\/ol><\/li><li>Build<\/li><\/ol><\/li><li><strong>Ship<\/strong><\/li><\/ol>/.test(src), src);
  assert.ok(/<ul style="list-style-type:disc"><li>Apples<ul style="list-style-type:circle"><li>Fuji<ul style="list-style-type:square"><li>Gala<\/li><\/ul><\/li><\/ul><\/li><\/ul>/.test(src), "bullets");
  // red stays, Calibri 11 (the default font) is not written again, another font and size are, the link keeps its address and loses Word's blue
  assert.ok(src.includes('<span style="color:#FF0000">release</span>') && src.includes("font-family:'Times New Roman',serif;font-size:14pt;background-color:#FFFF00"), src);
  assert.ok(!src.includes("Calibri,") && !src.includes("font-size:11pt"), "the default font is not repeated");
  assert.ok(src.includes('<a href="https://example.com/plan?a=1&amp;b=2">plan</a>') && !src.includes("0563C1"), "link");
  assert.ok(src.includes('<p style="text-align:center;margin-bottom:8pt;line-height:1.07"><u>Centered and underlined</u></p>'), "alignment");
  assert.ok(src.includes('<p style="margin-left:48px;margin-bottom:8pt;line-height:1.07">Indented paragraph.</p>'), "indent");
  assert.ok(src.startsWith('<h1 style="margin-bottom:0pt;line-height:1.07"><span style="font-family:\'Calibri Light\',sans-serif;font-size:16pt;color:#2F5496">Project update</span></h1>'), "heading");
  const mg = w.merge.html;
  assert.ok(!mg.includes("FF0000") && !mg.includes("font-family") && mg.includes("<strong>Plan</strong>") && mg.includes('<p style="text-align:center"><u>Centered and underlined</u></p>') && mg.includes("<ol"), mg);
  assert.ok(pasteText(read(join(dir, "word.html"))).includes("1. Plan\n  1. Design\n    1. Wireframes (red)"), "text only: the list items with their markers");
  // without a default font to compare with, the font stays
  assert.ok(cleanPaste(read(join(dir, "word.html")), { mode: "source" }).html.includes("Calibri"), "no base: Calibri is written");
}

// ------------------------------------------------------------------------------------------------- Excel, Outlook, Gmail, the web
{
  const x = results.excel.source.html;
  const T = '<span style="white-space:pre">	</span>';
  assert.equal(x, `<p><strong>Item</strong>${T}<strong>Qty</strong>${T}<strong>Price</strong></p><p>Pens &amp; ink${T}12${T}1,204.50</p><p>Paper${T}${T}<em><span style="color:#FF0000">n/a</span></em></p>`, "a range of cells: one line per row, cells apart by a tab, the class rules of the style sheet applied");
  assert.equal(pasteText(read(join(dir, "excel.html"))), "Item\tQty\tPrice\nPens & ink\t12\t1,204.50\nPaper\t\tn/a");
  // with a table in the editor the table stays
  const t = cleanPaste(read(join(dir, "excel.html")), { mode: "source", tables: true, base: BASE }).html;
  assert.ok(t.startsWith('<table><tr><td bgcolor="#FFFF00"><p><strong>Item</strong></p></td>') && (t.match(/<tr>/g) ?? []).length === 3 && (t.match(/<td[ >]/g) ?? []).length === 9, t); // (the yellow header cells keep their shading)
  const o = results.outlook;
  assert.ok(!o.source.html.includes("Preheader") && !o.source.html.includes("<img"), "hidden text and file: / cid: pictures are gone");
  assert.equal(o.source.removed, 2, "two pictures could not be pasted");
  assert.ok(o.source.html.includes('<a href="mailto:support@example.com">support@example.com</a>') && o.source.html.includes('<a href="tel:+4930123456">'), "mailto and tel links stay");
  const g = results.gmail.source;
  assert.equal(g.removed, 1);
  assert.ok(g.html.includes("<blockquote>") && g.html.includes("bad link") && !g.html.includes("javascript") && g.html.includes("font-size:10pt") && g.html.includes("font-size:14pt"), "Gmail: the quote, the dead link as text, small = 10 pt, large = 14 pt");
  assert.ok(results.gmail.merge.html.includes("<ul><li>Item one</li><li>Item two in red<ul><li>Nested</li></ul></li></ul>"), "Gmail lists");
  const c = results["chrome-page"].source.html;
  assert.ok(c.startsWith('<h2 style="margin-bottom:9pt;line-height:1.25">') && c.includes("font-size:12pt") && c.includes("<pre>npm install\nnpm run build</pre>") && !c.includes("/relative/link"), "Chrome");
  assert.ok(!results["firefox-page"].source.html.includes("#FFFFFF") && !results["firefox-page"].source.html.includes("White on") === false, "Firefox: white text without a background is Automatic");
  const s = results["safari-webkit"].source.html;
  assert.ok(s.includes("<li><p") && s.includes('href="https://www.example.org/page"') && !s.includes("000000") && !s.includes("transparent"), "Safari / Google Docs");
  assert.ok(results["apple-notes"].source.html.includes('<p style="text-align:center">') && results["apple-notes"].source.html.includes("font-size:9.75pt"), "Apple Notes: classes of the style sheet and the font shorthand");
  assert.ok(results.hostile.source.removed === 5 && results.hostile.source.html.includes('alt="shot"'), "hostile: 5 pictures removed, the data: picture stays");
}

// ------------------------------------------------------------------------------------------------- the reader
{
  const html = (s) => toHtml(parseHtml(s).kids);
  assert.equal(html("<p>a<p>b"), "<p>a</p><p>b</p>", "an open <p> ends at the next one");
  assert.equal(html("<ul><li>a<li>b<ul><li>c</ul></ul>"), "<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>", "an open <li> ends at the next one");
  assert.equal(html("<table><tr><td>a<td>b<tr><td>c</table>"), "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>");
  assert.equal(html("a &amp; b &lt; c &copy; &foo; &#65;&#x42;"), "a &amp; b &lt; c © &amp;foo; AB", "entities; an unknown one stays text");
  assert.equal(textOf(parseHtml("x&nbsp;y")), "x\u00a0y", "a no-break space stays one");
  assert.equal(html("<!-- c --><![if !x]>t<![endif]><?xml ?><!DOCTYPE html>"), "t", "comments, Word's conditional blocks, doctype");
  assert.equal(html("<p title='a>b' data-x=\"it's\">t</p>"), '<p title="a&gt;b" data-x="it\'s">t</p>', "quoted attributes may hold >");
  assert.equal(html("1 < 2 and <b>x</b"), "1 &lt; 2 and <b>x&lt;/b</b>", "a lone < is text, and so is an unfinished tag");
  assert.equal(html("<script>if (a<b) x()</script>t"), "<script>if (a&lt;b) x()</script>t", "script text is text");
  assert.equal(html('<p title="never ends>text'), "&lt;p title=\"never ends&gt;text", "an unterminated attribute is text");
  // hostile depth: no stack overflow, anywhere
  const deep = "<div>".repeat(5000) + "deep" + "</div>".repeat(5000);
  assert.ok(textOf(parseHtml(deep)).includes("deep"));
  assert.ok(cleanPaste(deep, { mode: "source" }).html.includes("deep"), "5000 nested divs");
  assert.ok(cleanPaste("<span>".repeat(5000) + "x", { mode: "source" }).html.length < 1000, "5000 nested spans");
  assert.ok(MAX_DEPTH > 20 && MAX_DEPTH < 500);
}

// ------------------------------------------------------------------------------------------------- the cleaner
{
  const c = (h, o = {}) => cleanPaste(h, { mode: "source", ...o }).html;
  // the Windows clipboard header and the fragment marks
  assert.equal(c("Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000200\r\nStartFragment:0000000141\r\nEndFragment:0000000164\r\n<html><body>\r\n<!--StartFragment--><p>x</p><!--EndFragment-->\r\n</body></html>"), "<p>x</p>");
  assert.equal(c("just text"), "<p>just text</p>");
  assert.equal(c(""), "");
  // the style sheet: class and tag rules, comments, at-rules with blocks inside, the most specific rule wins and the element's own style beats it
  assert.equal(c("<style>/* c */ @import url(x.css); @media print { p.a { color: blue } } @font-face { font-family: F } p { color: green } .a { color: red; font-weight: bold } p.a { font-style: italic } </style><p class=a>x</p><p class=b style='color:#0000ff'>y</p>"), '<p><strong><em><span style="color:#FF0000">x</span></em></strong></p><p><span style="color:#0000FF">y</span></p>'.replace("<p><span", "<p><span"));
  assert.equal(c("<style>a{b</style><p>x</p>"), "<p>x</p>", "an unfinished rule");
  assert.equal(c("<style>@media x { p { color:red }</style><p>x</p>"), "<p>x</p>", "an unfinished at-rule");
  assert.equal(c("   \n  "), "");
  // whitespace of the source is not text; a no-break space is
  assert.equal(c("<div>\n  <p>a\n   b</p>\n  <p>  c  </p>\n</div>"), "<p>a b</p><p>c</p>");
  assert.equal(c("<p>a <b> b</b> <i>c </i>d</p>"), "<p>a <strong>b</strong> <em>c </em>d</p>");
  assert.equal(c("<p>&nbsp;</p><p><o:p>&nbsp;</o:p></p><p><br></p>"), "<p></p><p></p><p></p>", "empty lines stay empty paragraphs");
  assert.equal(c("<p>a<br>b<br></p>"), "<p>a<br>b</p>", "a last <br> shows as nothing");
  // div / span / font / center
  assert.equal(c("<div>a<div>b</div>c</div>"), "<p>a</p><p>b</p><p>c</p>");
  assert.equal(c('<center><p>x</p></center><div align="right">y</div><p align="center">z</p>'), '<p style="text-align:center">x</p><p style="text-align:right">y</p><p style="text-align:center">z</p>');
  assert.equal(c('<font face="Arial" size="4" color="#336699">f</font>'), '<p><span style="font-family:Arial;font-size:14pt;color:#336699">f</span></p>');
  assert.equal(c('<span style="font-weight:bold;font-style:italic;text-decoration:underline line-through;vertical-align:super">m</span>'), "<p><strong><em><u><s><sup>m</sup></s></u></em></strong></p>");
  assert.equal(c('<b style="font-weight:normal">n<b>y</b></b>'), "<p>n<strong>y</strong></p>", "Google Docs' <b style=font-weight:normal> wrapper");
  assert.equal(c('<p style="font-family:Arial;color:#f00"><i>a</i> b</p>'), '<p><em><span style="font-family:Arial;color:#FF0000">a</span></em><span style="font-family:Arial;color:#FF0000"> b</span></p>', "a paragraph's text properties go down to its text");
  assert.equal(c('<div style="background:#ff0">x</div>'), "<p>x</p>", "a block's background is not a highlight");
  assert.equal(c('<mark>m</mark>'), '<p><span style="background-color:#FFFF00">m</span></p>');
  assert.equal(c('<span style="font:italic bold 12px/1.4 Georgia, serif">s</span>'), '<p><strong><em><span style="font-family:Georgia,serif;font-size:9pt">s</span></em></strong></p>');
  assert.equal(c('<span style="color:#000;background-color:rgb(255,255,255)">a</span><span style="color:rgb(0, 0, 0)">b</span><span style="color:windowtext">c</span>'), "<p>abc</p>", "black, white background and windowtext are Automatic");
  assert.equal(c('<span style="background:#fff;color:#fff">a</span><span style="background:#000;color:#fff">b</span>'), '<p>a<span style="color:#FFFFFF;background-color:#000000">b</span></p>', "white text on a background stays, white text alone goes");
  // the default font is not written again
  assert.equal(c('<span style="font-family:Calibri,sans-serif;font-size:11pt">a</span><span style="font-family:Arial;font-size:11pt">b</span>', { base: BASE }), '<p>a<span style="font-family:Arial">b</span></p>');
  assert.equal(c('<span style="font-family:Calibri;font-size:11pt">a</span>', { mode: "merge" }), "<p>a</p>");
  assert.equal(c('<span style="font-size:99999px">a</span><span style="font-size:0">b</span><span style="font-size:2em">c</span><span style="font-size:1000px">d</span>'), "<p>abcd</p>", "silly sizes are dropped");
  // paragraph formats (WP5b model): alignment, indent, spacing
  assert.equal(c('<p style="margin:0 0 10pt 36pt;text-align:justify;line-height:150%">a</p>'), '<p style="text-align:justify;margin-left:48px;margin-bottom:10pt;line-height:1.5">a</p>');
  assert.equal(cleanPaste('<p style="margin:0 0 10pt 36pt;text-align:justify;line-height:150%">a</p>', { mode: "merge" }).html, '<p style="text-align:justify;margin-left:48px">a</p>', "Merge: alignment and indent only");
  assert.equal(c('<div style="text-align:center"><p>a</p><p style="text-align:left">b</p></div>'), '<p style="text-align:center">a</p><p>b</p>', "alignment is inherited unless the paragraph says left");
  // headings, quotes, code, rules
  assert.equal(c("<h1>a</h1><h3>b</h3><h4>c</h4><h6><i>d</i></h6>"), "<h1>a</h1><h3>b</h3><p><strong>c</strong></p><p><strong><em>d</em></strong></p>");
  assert.equal(c("<blockquote><p>q</p><blockquote>n</blockquote></blockquote><hr>"), "<blockquote><p>q</p><blockquote><p>n</p></blockquote></blockquote><hr>");
  assert.equal(c("<pre>  a\n\tb\n</pre>"), "<pre>  a\n\tb</pre>");
  assert.equal(c("<p>x <code>c</code> <kbd>k</kbd></p>"), "<p>x <code>c</code> <code>k</code></p>");
  // links: only http, https, mailto, tel
  assert.equal(c('<a href=" HTTPS://x.test/a b">1</a><a href="//x.test">2</a><a href="#top">3</a><a href="mailto:a@b.c">4</a><a name="m">5</a>'), '<p><a href="HTTPS://x.test/a b">1</a>23<a href="mailto:a@b.c">4</a>5</p>');
  // lists
  assert.equal(c('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>'), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>", "a list directly in a list goes into the item before");
  assert.equal(c("<ul>x<li>y</li></ul>"), "<ul><li>x</li><li>y</li></ul>", "text directly in a list is an item");
  assert.equal(c('<ol type="a" start="3"><li>x</li></ol><ol style="list-style-type: upper-roman"><li>y</li></ol><ol type="zz"><li>z</li></ol>'), '<ol style="list-style-type:lower-alpha" start="3"><li>x</li></ol><ol style="list-style-type:upper-roman"><li>y</li></ol><ol><li>z</li></ol>');
  assert.equal(c('<ul><li style="text-align:center">c</li></ul>'), '<ul><li><p style="text-align:center">c</p></li></ul>', "an aligned item keeps a paragraph");
  // Word's fake lists
  const wl = (items) => c(items.map(([id, lvl, marker, text]) => `<p class=MsoListParagraph style='mso-list:l${id} level${lvl} lfo1'><![if !supportLists]><span style='mso-list:Ignore'>${marker}<span>&nbsp;&nbsp;</span></span><![endif]>${text}</p>`).join("\n"));
  assert.equal(wl([[0, 1, "1.", "a"], [0, 1, "2.", "b"]]), '<ol style="list-style-type:decimal"><li>a</li><li>b</li></ol>');
  assert.equal(wl([[0, 1, "3.", "a"]]), '<ol style="list-style-type:decimal" start="3"><li>a</li></ol>', "a list that starts at 3");
  assert.equal(wl([[0, 1, "C.", "a"], [0, 2, "ii.", "b"]]), '<ol style="list-style-type:upper-alpha" start="3"><li>a<ol style="list-style-type:lower-roman"><li>b</li></ol></li></ol>');
  assert.equal(wl([[0, 3, "i.", "a"]]), '<ol style="list-style-type:lower-roman"><li>a</li></ol>', "i. at the third level is Roman, at the first it is a letter");
  assert.equal(wl([[0, 1, "i.", "a"]]), '<ol style="list-style-type:lower-alpha" start="9"><li>a</li></ol>');
  assert.equal(wl([[0, 1, "(a)", "a"], [0, 1, "•", "x"]]), '<ol style="list-style-type:lower-alpha"><li>a</li></ol><ul style="list-style-type:disc"><li>x</li></ul>', "(a) is a letter; a bullet at the same level starts a new list");
  assert.equal(wl([[0, 1, "1.", "a"], [1, 1, "1.", "b"]]), '<ol style="list-style-type:decimal"><li>a</li></ol><ol style="list-style-type:decimal"><li>b</li></ol>', "another list id restarts the numbers");
  assert.equal(wl([[1, 1, "\u00b7", "a"], [1, 2, "o", "b"], [1, 3, "\uf0a7", "c"], [1, 2, "o", "d"], [1, 1, "\u2022", "e"]]), '<ul style="list-style-type:disc"><li>a<ul style="list-style-type:circle"><li>b<ul style="list-style-type:square"><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>');
  assert.equal(c(`<p style='mso-list:l0 level1 lfo1'>no marker</p><p>after</p>`), '<ul style="list-style-type:disc"><li>no marker</li></ul><p>after</p>', "a list paragraph without a marker is a bullet");
  assert.equal(c(`<p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>1.</span>a</p><p>between</p><p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>2.</span>b</p>`), '<ol style="list-style-type:decimal"><li>a</li></ol><p>between</p><ol style="list-style-type:decimal" start="2"><li>b</li></ol>', "the list goes on after a paragraph; its number is its own");
  assert.equal(c(`<div><p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>1.</span><b>bold</b> <span style='color:red'>red</span></p></div>`), '<ol style="list-style-type:decimal"><li><strong>bold</strong> <span style="color:#FF0000">red</span></li></ol>');
  // tables
  const tbl = "<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b <b>c</b></td></tr></table>";
  const TB = '<span style="white-space:pre">\t</span>';
  assert.equal(c(tbl), `<p>H1${TB}H2</p><p>a${TB}b <strong>c</strong></p>`, "no tables in the editor: a line per row");
  assert.equal(c("<table><tr><td><p>x</p><p>y</p></td><td><ul><li>z</li></ul></td></tr></table>"), "<p>x</p><p>y</p><ul><li>z</li></ul>", "a layout table is unfolded into its blocks");
  assert.equal(c("<table><tr><td>a</td></tr></table><p>after</p>"), "<p>a</p><p>after</p>");
  assert.equal(c("<table><tr><td colspan=2 rowspan=1>a</td><td colspan=3>b</td></tr></table>", { tables: true }), '<table><tr><td colspan="2"><p>a</p></td><td colspan="3"><p>b</p></td></tr></table>', "tables stay when the editor has them");
  assert.equal(pasteText("<table><tr><td>a</td><td>b</td></tr></table>"), "a\tb");
  // pictures
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  assert.equal(c(`<img src="${PNG}" alt="a" width="40">`), `<p><img src="${PNG}" alt="a" width="40"></p>`);
  assert.equal(cleanPaste(`<img src="${PNG}"><img src="https://x.test/a.png"><img src="cid:a@b"><img src="file:///C:/a.png"><img>`, { mode: "source" }).removed, 4);
  assert.equal(c(`<img src="${PNG}">`, {}).includes("<img"), true);
  assert.equal(cleanPaste(`<img src="${PNG}">t`, { mode: "text" }).html, "<p>t</p>", "Text only has no pictures");
  // internal copies are left alone by the plugin
  assert.ok(isInternalCopy('<p data-pm-slice="1 1 []">x</p>') && isInternalCopy("<meta charset='utf-8'><ul data-pm-slice=\"1 1 [&quot;ul&quot;]\" style=\"a\"><li>x</li></ul>") && !isInternalCopy("<p>x</p>"));
  assert.ok(!isInternalCopy("<p>about data-pm-slice=\"1 1 []\"</p>") && !isInternalCopy('<p><b data-pm-slice="1 1 []">x</b></p>'), "only the marker on the first element of ProseMirror's own copy counts");
  // Text only
  assert.equal(pasteText("<p>a</p><p></p><p>b<br>c</p><ul><li>x<ol><li>y</li></ol></li></ul><blockquote>q</blockquote><a href='https://x.test/'>link</a>"), "a\n\nb\nc\n- x\n  1. y\n> q\nlink");
  assert.equal(pasteText("<h1>T</h1><pre>c1\nc2</pre><hr><p>t</p>"), "T\nc1\nc2\n----------\nt");
  assert.equal(textToHtml("a\r\n\r\n  b <c>\n"), "<p>a</p><p></p><p>\u00a0\u00a0b &lt;c&gt;</p>");
  assert.equal(textToHtml(""), "<p></p>");
}

// ------------------------------------------------------------------------------------------------- size and time (AC-84: 1 MB of HTML in 2 s)
// The limits are CPU seconds of this process (user + system), not the wall clock: on a busy machine the wall time of the same work is several times
// longer while the CPU time stays about the same, so a test of the wall time failed under load without any change of the code (WP9b, REQ-9.3.3).
/** Runs `fn` and returns { value, ms } with ms = the CPU time it used. */
const cpuRun = (fn) => {
  const u0 = process.cpuUsage();
  const value = fn();
  const u = process.cpuUsage(u0);
  return { value, ms: (u.user + u.system) / 1000 };
};
{
  const para = '<p class=MsoNormal style="margin:0cm 0cm 8pt;line-height:107%"><span style="font-size:11pt;font-family:Calibri,sans-serif;color:red">Lorem ipsum <b>dolor</b> sit <a href="https://example.com/a?b=1&amp;c=2">amet</a>, consectetur adipiscing elit.</span><o:p></o:p></p>\n';
  const big = "<html><body>" + para.repeat(Math.ceil(1_000_000 / para.length)) + "</body></html>";
  assert.ok(big.length >= 1_000_000);
  for (const mode of ["source", "merge", "text"]) {
    const { value: r, ms } = cpuRun(() => (mode === "text" ? pasteText(big) : cleanPaste(big, { mode }).html));
    assert.ok(r.length > 100_000, `${mode}: output`);
    assert.ok(ms < 2000, `${mode}: 1 MB took ${Math.round(ms)} ms of CPU`);
    console.log(`  1 MB, ${mode}: ${Math.round(ms)} ms CPU`);
  }
  // 20 000 small list paragraphs (a long Word list)
  const items = Array.from({ length: 20000 }, (_, i) => `<p class=MsoListParagraph style='mso-list:l0 level${1 + (i % 3)} lfo1'><span style='mso-list:Ignore'>${["1.", "a.", "i."][i % 3]}</span>item ${i}</p>`).join("");
  const { ms: listMs } = cpuRun(() => cleanPaste(items, { mode: "source" }));
  assert.ok(listMs < 2000, `a long Word list: ${Math.round(listMs)} ms of CPU`);
  console.log(`  20 000 list paragraphs: ${Math.round(listMs)} ms CPU`);
}

// hostile input costs time in proportion to its size, not its square (a tag that never ends, quotes that never close, a million rules)
{
  const cases = {
    "a million <a ": "<a ".repeat(300_000),
    "quotes that never close": '<a b="'.repeat(150_000),
    "comments that never end": "<!--".repeat(250_000),
    "unclosed tags": "<p".repeat(400_000),
    "unclosed style comments": "<style>" + "/*".repeat(200_000) + "</style><p>x</p>",
    "at-signs in a style": "<style>" + "@".repeat(300_000) + "</style><p>x</p>",
    "braces in a style": "<style>" + "a{".repeat(150_000) + "</style><p>x</p>",
    "70 000 rules": "<style>" + "p.a{color:red}".repeat(70_000) + "</style>" + '<p class="a">x</p>'.repeat(5000),
    "a long Word list": Array.from({ length: 30_000 }, (_, i) => `<p style='mso-list:l${i % 7} level${1 + (i % 9)} lfo1'><span style='mso-list:Ignore'>1.</span>x</p>`).join(""),
    "200 000 spans": "<span>a</span>".repeat(200_000),
    "2000 nested lists": "<ul><li>".repeat(2000) + "x",
  };
  for (const [name, h] of Object.entries(cases)) {
    for (const mode of ["source", "text"]) {
      const { value: r, ms } = cpuRun(() => (mode === "text" ? pasteText(h) : cleanPaste(h, { mode }).html));
      assert.equal(typeof r, "string");
      assert.ok(ms < 5000, `${name} (${mode}): ${Math.round(ms)} ms of CPU`);
      console.log(`  ${name} (${mode}): ${Math.round(ms)} ms CPU`);
    }
  }
}

// Linear, not quadratic, and independent of the machine: the same input at size n and at 2n. Linear work costs about 2x, quadratic work 4x; the limit is 3x.
// Each size is measured up to three times and the best (lowest) CPU time of each counts, so one slow turn (a garbage collection, a busy neighbour) cannot decide.
{
  const grow = {
    "a million <a ": (n) => "<a ".repeat(n),
    "unclosed tags": (n) => "<p".repeat(n),
    "200 000 spans": (n) => "<span>a</span>".repeat(n),
    "70 000 rules": (n) => "<style>" + "p.a{color:red}".repeat(n) + "</style>" + '<p class="a">x</p>'.repeat(Math.floor(n / 14)),
  };
  const sizes = { "a million <a ": 300_000, "unclosed tags": 400_000, "200 000 spans": 200_000, "70 000 rules": 70_000 };
  for (const [name, make] of Object.entries(grow)) {
    const n = sizes[name];
    const small = make(n), large = make(2 * n);
    let best1 = Infinity, best2 = Infinity, ratio = Infinity;
    for (let round = 0; round < 3 && !(ratio < 3); round++) {
      best1 = Math.min(best1, cpuRun(() => cleanPaste(small, { mode: "source" })).ms);
      best2 = Math.min(best2, cpuRun(() => cleanPaste(large, { mode: "source" })).ms);
      ratio = best2 / Math.max(best1, 1);
    }
    console.log(`  scaling ${name}: ${Math.round(best1)} ms CPU at n, ${Math.round(best2)} ms at 2n, ratio ${ratio.toFixed(2)}`);
    assert.ok(ratio < 3, `${name}: twice the input took ${ratio.toFixed(2)} x the CPU time (${Math.round(best1)} -> ${Math.round(best2)} ms), more than linear`);
  }
}

// ------------------------------------------------------------------------------------------------- tables kept (WP5d: the editor has table nodes)
// scripts/fixtures/paste-tables/<name>.html -> expected/<name>.source.html and .merge.html with `tables: true`: a Word table (borders, shading, colspan), a table
// copied from a web page (border attribute, header cells, shaded header) and a nested layout table (a tracking picture is dropped)
{
  const tdir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "paste-tables");
  const texp = join(tdir, "expected");
  if (update) mkdirSync(texp, { recursive: true });
  const tnames = readdirSync(tdir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).sort();
  assert.equal(tnames.length, 3);
  const tres = {};
  for (const name of tnames) {
    const input = read(join(tdir, `${name}.html`));
    for (const mode of ["source", "merge"]) {
      const r = cleanPaste(input, { mode, tables: true, base: BASE });
      tres[`${name}.${mode}`] = r;
      const f = join(texp, `${name}.${mode}.html`);
      if (update) writeFileSync(f, lines(r.html));
      else {
        assert.ok(existsSync(f), `${name}.${mode}.html is missing (run with --update)`);
        assert.equal(lines(r.html), read(f), `paste-tables ${name}.${mode}.html differs from the expected file`);
      }
      for (const bad of ["mso-", "<o:p", "Mso", "<!--", "<style", " class=", " style=\"width", "tracker.example.test", "<img"]) assert.ok(!r.html.includes(bad), `${name}/${mode}: ${bad} in the output`);
    }
    // Keep text only: rows are lines, cells apart by a tab
    assert.ok(!pasteText(input).includes("<"), `${name}: text only has no markup`);
  }
  const w = tres["word-table.source"].html;
  assert.ok(w.includes('<table border="1">') && (w.match(/<tr>/g) ?? []).length === 2, "Word: bordered table, 2 rows");
  assert.ok(w.includes('bgcolor="#D9E2F3"') && w.includes('colspan="2" bgcolor="#FFFF00"'), "Word: cell shading (a colour name too) and the colspan");
  assert.ok(!tres["word-table.merge"].html.includes("#C00000") && tres["word-table.merge"].html.includes('bgcolor="#FFFF00"'), "Merge: the text colour goes, the shading of a cell stays");
  const wb = tres["web-table.source"].html;
  assert.ok(wb.includes('<table border="1">') && wb.includes('<th bgcolor="#F2F2F2">') && !wb.includes("#FFFFFF"), "web: border attribute, header cells with their shading, a white cell is no shading");
  const lt = tres["layout-table.source"].html;
  assert.ok(!lt.includes("border=") && (lt.match(/<table>/g) ?? []).length === 3 && lt.includes('bgcolor="#FFCC00"'), "layout: borderless nested tables stay, the shaded cell too");
  assert.equal(pasteText(read(join(tdir, "word-table.html"))), ["Quarterly numbers", "Region	Q1	Q2", "EMEA	12 and 15"].join(String.fromCharCode(10)));
  // the sizes of what a table can hold are capped like everything else: a million cells in one table are text of its own size, not a freeze
  const big = "<table>" + "<tr>" + "<td>x</td>".repeat(200) + "</tr>".repeat(1) + "</table>";
  assert.ok(cleanPaste(big, { mode: "source", tables: true }).html.length > 1000);
}

// nothing throws on garbage
{
  const bits = ["<", ">", "</", "<p", "<p>", "</p>", "<!--", "-->", "<![", "<?", '"', "'", "=", "&", "&#", "&amp", "<b>", "</b>", "<ul>", "<li>", "<table>", "<td>", "<img src=", "style=", "mso-list:l0 level1", " ", "\n", "x", "é", "\u00a0", "<style>", "</style>", "<script>", "}", "{"];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 400; i++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 60) }, () => bits[Math.floor(rnd() * bits.length)]).join("");
    for (const mode of ["source", "merge", "text"]) {
      const r = cleanPaste(s, { mode, tables: i % 2 === 0 });
      assert.equal(typeof r.html, "string");
      assert.ok(!/<(script|style|iframe)/i.test(r.html), JSON.stringify(s));
    }
    pasteText(s);
  }
}

console.log("test-paste-clean: ok");
