// The quoted original of a reply or forward (spec-rich-text.md REQ-35, AC-59 .. AC-62): the original's HTML cleaned to what the outgoing sanitiser keeps
// (editor/quoteClean.ts), the block it is written as in the stored / sent message and read back from a draft (editor/quoteBlock.ts), its place in the message
// (editor/emailHtml.ts, editor/messageBody.ts) and the plain-text part. Every original in scripts/fixtures/quote/ (Word, Outlook desktop and web, Gmail, Apple Mail,
// Thunderbird, a newsletter, right-to-left and CJK / Vietnamese text, a thread, a wide table, pictures, a hostile one, plain text) is cleaned and the result must
// equal scripts/fixtures/quote/expected/<name>.html and the plain-text part <name>.txt byte for byte. src-tauri/src/outgoing.rs reads the same expected files and
// asserts that the sanitiser changes none of them.
//
//   node --experimental-strip-types scripts/test-quote.mjs           check
//   node --experimental-strip-types scripts/test-quote.mjs --update  write the expected files (then read the diff before you commit it)
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capText, cleanQuoteHtml, cleanStyle, MAX_QUOTE_HTML, MAX_QUOTE_TEXT, MAX_SOURCE, quoteOf, textHtml } from "../src/editor/quoteClean.ts";
import { extractQuote, quotePictureBytes, quoteSentHtml } from "../src/editor/quoteBlock.ts";
import { docToHtml } from "../src/editor/emailHtml.ts";
import { messageHtml } from "../src/editor/messageBody.ts";
import { htmlToText } from "../src/htmlText.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "quote");
const exp = join(dir, "expected");
const update = process.argv.includes("--update");
const read = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const CUT = "[… cut …]";
const fmt = (html) => html.replace(/(<\/(?:p|div|li|ul|ol|blockquote|pre|table|tr|h[1-6]|thead|tbody)>|<br>|<hr>)/g, "$1\n").replace(/\n$/, "") + "\n";
const same = (a, b, msg) => {
  if (a === b) return;
  let i = 0;
  while (a[i] === b[i]) i++;
  assert.fail(`${msg}: differs at ${i}\n  got:  ...${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))}\n  want: ...${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`);
};
const HEAD = "On Fri, 16 Oct 2026, Ann Lee &lt;ann@example.com&gt; wrote:";
const BASE = { family: "Calibri,Carlito,Arial,sans-serif", size: 11 };

// the tags / attributes the sanitiser keeps (outgoing.rs)
const TAGS = new Set("p br div span strong b em i u s strike sub sup a ul ol li h1 h2 h3 h4 h5 h6 blockquote pre code hr img table thead tbody tfoot tr th td caption colgroup col".split(" "));
const ATTRS = new Set("style dir align href src alt title width height border cellpadding cellspacing bgcolor colspan rowspan valign type start value span".split(" "));
const PROPS = new Set("font-family font-size font-weight font-style text-decoration color background-color text-align line-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-color border-style border-width border-collapse width height max-width vertical-align list-style-type direction white-space".split(" "));

/** Everything a cleaned quote must satisfy, whatever the original was. */
function invariants(name, html) {
  for (const bad of ["<script", "<style", "<iframe", "<object", "<embed", "<form", "<input", "<svg", "<link", "<meta", "<base", "<!--", "<![", " class=", " id=", "javascript:", "vbscript:", "file:", "\\\\", "url(", "expression", "@import", "position:", "mso-", "<o:p", "xmlns", "data-", "display:", "background=", "cid:", "srcset"]) {
    assert.ok(!html.toLowerCase().includes(bad.toLowerCase()), `${name}: "${bad}" in the output`);
  }
  for (const m of html.matchAll(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    assert.ok(TAGS.has(m[1].toLowerCase()), `${name}: tag <${m[1]}>`);
    for (const a of m[2].matchAll(/\s([a-z-]+)(?:="([^"]*)")?/gi)) {
      assert.ok(ATTRS.has(a[1].toLowerCase()), `${name}: attribute ${a[1]} on <${m[1]}>`);
      if (a[1] === "style") for (const d of a[2].replace(/&quot;.*?&quot;|'[^']*'/g, "Q").split(";")) assert.ok(PROPS.has(d.split(":")[0]), `${name}: style property ${d.split(":")[0]}`);
      if (a[1] === "href") assert.match(a[2], /^(?:https?:\/\/|mailto:|tel:)/i, `${name}: href ${a[2]}`);
      if (a[1] === "src") assert.match(a[2], /^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i, `${name}: src ${a[2].slice(0, 40)}`);
    }
  }
  // balanced
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const t = m[2].toLowerCase();
    if (["br", "hr", "img", "col"].includes(t)) continue;
    if (!m[1]) stack.push(t);
    else assert.equal(stack.pop(), t, `${name}: </${t}> closes ${t}`);
  }
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

// ------------------------------------------------------------------------------------------------- the fixtures
const names = readdirSync(dir).filter((f) => /\.(html|txt)$/.test(f)).sort();
assert.ok(names.length >= 12, "the fixtures are there");
const out = {};
for (const file of names) {
  const name = file.replace(/\.(html|txt)$/, "");
  const input = read(join(dir, file));
  const isText = file.endsWith(".txt");
  const q = quoteOf(isText ? { html: null, text: input } : { html: input, text: null }, CUT);
  out[name] = q;
  invariants(name, q.html.replace(/<div style="white-space:pre-wrap">/, "<div>"));
  assert.equal(q.asText, isText, `${name}: ${isText ? "plain text is quoted as text" : "HTML is quoted as HTML"}`);
  // the stored form of a reply, and its plain-text part ("> " before every line of the quote)
  const reply = quoteSentHtml({ kind: "reply", head: HEAD, html: q.html });
  const text = htmlToText(reply) + "\n";
  const fwd = htmlToText(quoteSentHtml({ kind: "forward", head: "---------- Forwarded message ----------<br>From: Ann<br><br>", html: q.html })) + "\n";
  for (const [f, got] of [[`${name}.html`, fmt(q.html)], [`${name}.txt`, text], [`${name}.fwd.txt`, fwd]]) {
    const p = join(exp, f);
    if (update) writeFileSync(p, got);
    else {
      assert.ok(existsSync(p), `${f} is missing (run with --update)`);
      same(got, read(p), `${f}`);
    }
  }
  // cleaning twice changes nothing: a reopened draft holds the cleaned form and must not drift
  if (!isText) same(cleanQuoteHtml(q.html).html, q.html, `${name}: the cleaned quote is stable`);
  // every line of a quoted reply starts with "> " in the plain part (blank quote lines are ">")
  const lines = text.split("\n").slice(1).filter((l) => l !== "");
  assert.ok(lines.every((l) => l.startsWith(">")), `${name}: the plain part quotes every line`);
  assert.ok(!/&(?:nbsp|amp|lt|gt|quot|#\d+);|<\/?(?:p|br|div|span|b|i|u|a|font|table|tr|td|th|ul|ol|li|img|blockquote|pre)/i.test(text), `${name}: no markup or entities in the plain part`);
}

// ------------------------------------------------------------------------------------------------- what each original must keep or lose
const get = (n) => out[n].html;
{
  // Word: the sheet's class rules are written into the elements, the list and the table stay, Word's markup goes
  const h = get("word");
  assert.match(h, /<p style="[^"]*font-size:11\.0pt/, "Word: MsoNormal rules inlined");
  assert.ok(h.includes("revised budget") && h.includes("color:#C00000"), "Word: the red bold text");
  assert.ok(h.includes("<table") && h.includes('width="120"') && h.includes("background-color:#D9E2F3"), "Word: the table and its shading");
  assert.ok(h.includes("Travel is capped") && h.includes("Training moves to Q3") && !h.includes("mso-list"), "Word: the list items (the typed bullets stay as text, Word's list properties go)");
  assert.ok(h.includes('href="https://intranet.example.com/budget?id=42&amp;v=2"'), "Word: link");
}
{
  // newsletter: the pre-header is gone, the tracking pixels are gone, the button and the layout stay, the unresolved cid picture and the javascript: link do not
  const h = get("newsletter");
  assert.ok(!h.includes("Save up to 40%") && !h.includes("hidden preview"), "newsletter: the pre-header text is not quoted");
  assert.ok(!h.includes("track.example.com"), "newsletter: tracking pixels");
  assert.ok(h.includes('src="https://img.example.com/hero-oct.jpg"') && h.includes('width="600"'), "newsletter: the web pictures stay in the HTML");
  assert.ok(h.includes("Shop now") && h.includes("background-color:#0070c0") && h.includes("padding:12px 24px"), "newsletter: the button");
  assert.ok(h.includes("<font") === false && h.includes("color:#555555"), "newsletter: <font> became a span");
  assert.ok(!h.includes("cid:") && h.includes("Tent") && !h.includes("javascript"), "newsletter: unresolved cid picture, javascript: link");
  assert.ok(h.includes('bgcolor="#222222"') && h.includes('valign="top"') && h.includes('cellpadding="0"'), "newsletter: table attributes");
  assert.ok(!h.includes("Open Sans") && !h.includes("max-width: 620"), "newsletter: no sheet text");
  assert.equal(out.newsletter.remote, 3, "newsletter: three pictures from the web are kept (logo, hero, product)");
}
{
  const h = get("hostile");
  assert.ok(h.includes("kept text") && h.includes("styled") && h.includes("safe part") && h.includes("The end &lt;script&gt;alert(16)&lt;/script&gt;."), "hostile: the harmless text stays (and stays text)");
  assert.ok(!h.includes("a hidden paragraph") && !h.includes("display none") && !h.includes("mso hidden"), "hostile: hidden paragraphs");
  assert.ok(!h.includes("dropped") && !h.includes("secret") && !h.includes("owned") && !h.includes("one</"), "hostile: dropped content");
  assert.ok(h.includes('href="https://ok.example.com/path?a=1&amp;b=2"'), "hostile: the https link stays");
  assert.ok(!/evil\.example/.test(h), "hostile: nothing of the attacker's hosts");
  assert.ok(h.includes('src="https://ok.example.com/a.png"') && h.includes("<a href=\"https://ok.example.com/\">"), "hostile: the linked https picture");
  assert.ok(h.includes('src="HTTP://tracker.example.com/pixel.gif?uid=9"'), "hostile: a web picture is kept as written");
  assert.ok(h.includes("local file") && h.includes("unc") && h.includes("svg"), "hostile: pictures that cannot be sent leave their alt text");
}
{
  const h = get("images");
  assert.ok(h.includes('src="data:image/png;base64,iVBORw0KGgo') && h.includes('width="120"'), "images: the data picture");
  assert.ok(h.includes("https://cdn.example.com/photos/site-01.jpg") && h.includes("https://cdn.example.com/photos/site-02.jpg?w=640"), "images: pictures from the web");
  assert.ok(!h.includes("t.example.com") && !h.includes("cid:") && h.includes("Example logo") && h.includes("my picture") && h.includes("vector art"), "images: pixels, cid, local and vector pictures");
  assert.equal(quotePictureBytes(h), 72, "images: the data picture counts toward the size of the message");
}
{
  assert.ok(get("outlook-web").includes("availability") && !get("outlook-web").includes("hidden preview"), "OWA");
  assert.ok(get("outlook-web").includes("<hr") && get("outlook-web").includes("background-color:rgb(255, 255, 0)"), "OWA: rule and highlight");
  assert.ok(get("gmail").includes("rgb(255,0,0)") && !get("gmail").includes("gmail_quote") && get("gmail").includes("<blockquote"), "Gmail: colours stay, classes go, the nested quote stays");
  assert.ok(!get("gmail").includes("mail.google.com"), "Gmail: the 1x1 picture");
  assert.ok(get("apple-mail").includes("color:#dc2e1f") && get("apple-mail").includes("<blockquote"), "Apple Mail: the sheet's colour class");
  assert.ok(get("thunderbird").includes("<pre") && get("thunderbird").includes("ERROR 12:01:07") && get("thunderbird").includes("<ol>"), "Thunderbird");
  assert.ok(get("rtl").includes('dir="rtl"') && get("rtl").includes("direction:rtl") && get("rtl").includes("مرحباً") && get("rtl").includes("מה שלומך"), "RTL: direction and text");
  assert.ok(get("cjk-vi").includes("お世話になっております") && get("cjk-vi").includes("doanh thu tăng 12%") && get("cjk-vi").includes("截止日期"), "CJK / Vietnamese");
  assert.equal((get("thread").match(/<blockquote/g) ?? []).length, 3, "thread: the nested quotes stay");
  assert.ok(get("wide-table").includes("width:1800px") && (get("wide-table").match(/<td/g) ?? []).length > 30, "wide table");
  assert.ok(out.plain.asText && get("plain").startsWith('<div style="white-space:pre-wrap">Hi Tom,'), "plain text");
}

// ------------------------------------------------------------------------------------------------- the style filter
{
  assert.equal(cleanStyle({ color: "red", display: "none", position: "fixed" }), "color:red");
  assert.equal(cleanStyle({ background: "url(http://x/y.png) #fff no-repeat" }), "background-color:#fff");
  assert.equal(cleanStyle({ background: "none" }), "");
  assert.equal(cleanStyle({ "background-color": "rgb(1, 2, 3)", width: "calc(100% - 4px)" }), "background-color:rgb(1, 2, 3)");
  assert.equal(cleanStyle({ color: "red !important", "font-family": "'Segoe UI', Arial" }), "color:red;font-family:'Segoe UI', Arial");
  assert.equal(cleanStyle({ "font-family": "a/b", margin: "0 auto", width: "expression(1)", color: "x\\41" }), "margin:0 auto");
  assert.equal(cleanStyle({ color: "red", COLOR: "blue" }) !== "", true);
  assert.equal(cleanStyle({ "mso-line-height-rule": "exactly", "-webkit-text-size-adjust": "100%" }), "");
}

// ------------------------------------------------------------------------------------------------- the block in the stored message and back (AC-62)
{
  const prefix = '<p style="margin:0">typed</p><div data-sig-block></div>';
  for (const kind of ["reply", "forward"]) {
    for (const [name, q] of Object.entries(out)) {
      const attrs = { kind, head: kind === "reply" ? HEAD : "---------- Forwarded message ----------<br>From: Ann &lt;a@b.c&gt;<br><br>", html: q.html };
      const stored = prefix + quoteSentHtml(attrs);
      const back = extractQuote(stored);
      assert.deepEqual(back.quote, attrs, `${name}/${kind}: the block is read back as it was written`);
      assert.ok(back.html.startsWith(prefix + '<div data-quote-block="' + kind + '"'), `${name}/${kind}: the marker takes the place of the block and of the <br> before it`);
      assert.ok(!back.html.includes("hl-quote"), `${name}/${kind}: nothing of the stored form is left`);
      assert.equal(prefix + quoteSentHtml(back.quote), stored, `${name}/${kind}: write, read, write is identical`);
      // inside the default-font box, followed by something (a signature written by another client)
      const boxed = extractQuote(`${prefix}${quoteSentHtml(attrs)}<p>after</p>`);
      assert.equal(boxed.quote.html, q.html);
      assert.ok(boxed.html.endsWith("<p>after</p>"));
    }
  }
  // a quote of the editor's own (Styles > Quote) or a foreign "hl-quote" is ordinary content
  const own = '<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p style="margin:0">mine</p></blockquote>';
  assert.equal(extractQuote(own).quote, null);
  assert.equal(extractQuote(own).html, own);
  for (const odd of ['<div class="hl-quote">no parts</div>', '<div class="hl-quote"><div>h</div><p>x</p></div>', '<div class="hl-quote"><div>h</div><blockquote>no style</blockquote></div>', '<div class="hl-quote"><div>h', '<div class="hl-quote"><div>h</div><div>b</div>trailing text</div>']) {
    assert.equal(extractQuote(odd).quote, null, odd);
    assert.equal(extractQuote(odd).html, odd, odd);
  }
  // the second block in a message is not taken for the first (a quote that holds an earlier hl-quote is part of the first one's html)
  const nested = quoteSentHtml({ kind: "reply", head: "h", html: `<div>inner</div>` });
  const two = extractQuote(nested + nested);
  assert.equal(two.quote.html, "<div>inner</div>");
  assert.ok(two.html.includes('class="hl-quote"'), "the second block is left as it is");
}

// ------------------------------------------------------------------------------------------------- its place in the message (REQ-35: below the signature, inside the default font box)
{
  const q = out.gmail;
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Thanks, see below." }] }, { type: "signatureBlock" }, { type: "quoteBlock", attrs: { kind: "reply", head: HEAD, html: q.html } }, { type: "paragraph" }] };
  const m = messageHtml(doc, { sig: "<p>Tom</p>", base: BASE, pictures: "cid", newCid: () => "x@y", fileName: () => "p.png" });
  const i = { text: m.html.indexOf("Thanks, see below."), sig: m.html.indexOf('class="sig"'), head: m.html.indexOf(HEAD), quote: m.html.indexOf("<blockquote style=") };
  assert.ok(0 < i.text && i.text < i.sig && i.sig < i.head && i.head < i.quote, "text, signature, attribution line, blockquote");
  assert.ok(m.html.startsWith('<div style="font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt">') && m.html.endsWith("</blockquote></div></div>"), "inside the default font box, the empty paragraph below is not written");
  assert.equal(m.html.split('class="hl-quote"').length, 2, "one block");
  // without a signature the block still follows the text
  const none = messageHtml(doc, { sig: null, base: BASE, pictures: "data" });
  assert.ok(!none.html.includes('class="sig"') && none.html.includes('<br><div class="hl-quote">'));
  // a data: picture of the original travels as a related part like any other (swapPictures), a web picture stays as it is
  const pics = messageHtml({ type: "doc", content: [{ type: "paragraph" }, { type: "quoteBlock", attrs: { kind: "forward", head: "h", html: out.images.html } }] }, { sig: null, base: BASE, pictures: "cid", newCid: () => "cid1@heylook", fileName: (mime, n) => `picture-${n}.png` });
  assert.equal(pics.inline.length, 1);
  assert.ok(pics.html.includes('src="cid:cid1@heylook"') && pics.html.includes("https://cdn.example.com/photos/site-01.jpg") && !pics.html.includes("data:image"));
  // the plain part of a reply: the typed text, then the quote with "> "
  const t = htmlToText(m.html);
  assert.ok(t.startsWith("Thanks, see below.\n"), t);
  assert.ok(t.includes("\n-- \nTom") && t.indexOf("-- \nTom") < t.indexOf("On Fri, 16 Oct 2026, Ann Lee <ann@example.com> wrote:"), "signature before the attribution line");
  assert.ok(/\n> Thanks for the quick turnaround!/.test(t) && /\n> > Hi Tom,/.test(t), "the quote is prefixed with '> ', the original's own quote with '> > '");
}

// ------------------------------------------------------------------------------------------------- big originals stay fast and capped
{
  const time = (f) => {
    const t0 = performance.now();
    const r = f();
    return [r, performance.now() - t0];
  };
  // 1 MB of ordinary HTML: kept as HTML
  const para = '<p style="margin:0 0 8px"><span style="font-family:Arial;color:#333">Quarterly <b>report</b> line with <a href="https://example.com/x?y=1&amp;z=2">a link</a> and some more words to fill the line.</span></p>\n';
  const mb = "<html><body>" + para.repeat(Math.ceil(1_000_000 / para.length)) + "</body></html>";
  let [r, ms] = time(() => quoteOf({ html: mb, text: null }, CUT));
  assert.ok(!r.asText && r.html.length > 900_000 && r.html.length <= MAX_QUOTE_HTML, `1 MB HTML is quoted as HTML (${r.html.length})`);
  assert.ok(ms < 3000, `1 MB HTML took ${Math.round(ms)} ms`);
  console.log(`  1 MB html: ${Math.round(ms)} ms, ${r.html.length} chars`);
  // more than the cap: quoted as text, which is cut
  const big = "<html><body>" + para.repeat(Math.ceil(1_800_000 / para.length)) + "</body></html>";
  [r, ms] = time(() => quoteOf({ html: big, text: null }, CUT));
  assert.ok(r.asText && r.cut && r.html.includes(CUT) && r.html.length < MAX_QUOTE_TEXT * 1.2 && r.html.includes("Quarterly report line"), `over the cap: text, cut (${r.html.length})`);
  assert.ok(ms < 3000, `over-the-cap HTML took ${Math.round(ms)} ms`);
  console.log(`  1.8 MB html -> text: ${Math.round(ms)} ms, ${r.html.length} chars`);
  // beyond the source cap the HTML is not read at all; the message's own text is used when it has one
  [r, ms] = time(() => quoteOf({ html: "<p>x</p>".repeat(MAX_SOURCE / 8 + 10), text: "the plain version\nof the message" }, CUT));
  assert.ok(r.asText && r.html.includes("the plain version") && ms < 1000, `source cap (${Math.round(ms)} ms)`);
  // deeply nested: the tree reader caps the depth, the result is balanced and quick
  const deep = "<div>".repeat(5000) + "core text" + "</div>".repeat(5000);
  [r, ms] = time(() => quoteOf({ html: deep, text: null }, CUT));
  assert.ok(r.html.includes("core text"), "deep: the text is there");
  invariants("deep", r.html);
  assert.ok(ms < 2000, `5000 nested divs took ${Math.round(ms)} ms`);
  const deepQ = "<blockquote>".repeat(3000) + "core quote" + "</blockquote>".repeat(3000);
  [r, ms] = time(() => quoteOf({ html: deepQ, text: null }, CUT));
  invariants("deepQ", r.html);
  assert.ok(ms < 2000, `3000 nested quotes took ${Math.round(ms)} ms`);
  // too many elements
  const many = "<span>a</span>".repeat(45_000);
  [r, ms] = time(() => quoteOf({ html: many, text: null }, CUT));
  assert.ok(r.asText, "45 000 elements: quoted as text");
  // a wide table: 200 columns x 60 rows
  const row = "<tr>" + '<td style="padding:2px">cell</td>'.repeat(200) + "</tr>";
  const wide = `<table border="1">${row.repeat(60)}</table>`;
  [r, ms] = time(() => quoteOf({ html: wide, text: null }, CUT));
  assert.ok(!r.asText && (r.html.match(/<tr>/g) ?? []).length === 60 && ms < 2000, `wide table (${Math.round(ms)} ms)`);
  console.log(`  200 x 60 table: ${Math.round(ms)} ms, ${r.html.length} chars`);
  // 5000 lines of plain text
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}: the quick brown fox jumps over the lazy dog`).join("\n");
  [r, ms] = time(() => quoteOf({ html: null, text: lines }, CUT));
  assert.ok(r.asText && !r.cut && r.html.includes("line 5000") && ms < 500, `5000 lines (${Math.round(ms)} ms)`);
  const pt = time(() => htmlToText(quoteSentHtml({ kind: "reply", head: "h", html: r.html })));
  assert.equal(pt[0].split("\n").length, 5001, "the plain part has one quoted line per line");
  assert.ok(pt[0].split("\n").slice(1).every((l) => l.startsWith("> ")));
  console.log(`  5000 lines: ${Math.round(ms)} ms, plain part ${Math.round(pt[1])} ms`);
  // a text that is longer than the cap is cut at a line end with the note as its last line
  const huge = lines.repeat(8);
  const c = capText(huge, CUT);
  assert.ok(c.cut && c.text.endsWith("\n\n" + CUT) && c.text.length <= MAX_QUOTE_TEXT + CUT.length + 2);
  assert.ok(/line \d+: the quick brown fox jumps over the lazy dog\n\n\[… cut …\]$/.test(c.text), "cut at a line end");
  assert.deepEqual(capText("short", CUT), { text: "short", cut: false });
  assert.equal(textHtml("a <b> & c"), '<div style="white-space:pre-wrap">a &lt;b&gt; &amp; c</div>');
  // a hostile run of tags must not be quadratic
  [r, ms] = time(() => quoteOf({ html: "<a ".repeat(300_000), text: "fallback text" }, CUT));
  assert.ok(ms < 3000, `a million-ish "<a " took ${Math.round(ms)} ms`);
}

// ------------------------------------------------------------------------------------------------- the editor writes the block like the rest
{
  assert.equal(
    docToHtml({ type: "doc", content: [{ type: "quoteBlock", attrs: { kind: "forward", head: "h<br>", html: "<p>x</p>" } }] }),
    '<br><div class="hl-quote"><div>h<br></div><div><p>x</p></div></div>',
  );
}
console.log(`test-quote: ${names.length} originals, ${update ? "expected files written" : "all passed"}`);
