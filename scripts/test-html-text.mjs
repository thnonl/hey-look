// Checks src/htmlText.ts, the text/plain alternative of a sent message (QA round 17, BUG-13 / MA-16 / J-16 / CF-7). The fixtures are the
// HTML the editor produces for the compose test plan's S1, S3 (rich) and S7 (reply with a quote), plus the shapes pasted web pages bring.
// Run: node --experimental-strip-types scripts/test-html-text.mjs
import assert from "node:assert/strict";
import { decodeEntities, htmlToText } from "../src/htmlText.ts";

const eq = (html, want, why) => assert.equal(htmlToText(html), want, why ?? html.slice(0, 60));

// S1: paragraphs on their own lines, an empty paragraph is a blank line, <br> a line break (D-01)
eq("<p>one</p><p>two</p>", "one\ntwo");
eq("<p>one</p><p></p><p>three</p>", "one\n\nthree");
eq("<p>line a<br>line b</p>", "line a\nline b");
eq("<p>x</p><p></p><p></p><p></p><p>y</p>", "x\n\ny", "never more than one blank line");
// the signature: the "-- " line keeps its blank, in front of the signature text
eq('<p>Hi</p><br><div class="sig">-- <br>Nam<br>Hey Look!</div>', "Hi\n\n-- \nNam\nHey Look!");
eq('<p>Hi</p><div class="sig">-- <br></div>', "Hi\n--", "an empty signature leaves no stray blank");

// J-16 (the QA harness): a link and a list
eq('<p>See the docs<a target="_blank" rel="noopener noreferrer nofollow" href="https://example.test/docs"> page</a></p><ul><li><p>first item</p></li><li><p>second item</p></li></ul>', "See the docs page (https://example.test/docs)\n- first item\n- second item");

// links: text (address); only the address when the text is the address; none for anchors, scripts and embedded pictures
eq('<a href="https://example.test/">https://example.test/</a>', "https://example.test/");
eq('<a href="https://example.test">https://example.test/</a>', "https://example.test/", "a slash more or less is the same address");
eq('<a href="mailto:ann@x.test">ann@x.test</a>', "ann@x.test");
eq('<a href="mailto:ann@x.test">Ann</a>', "Ann (mailto:ann@x.test)");
eq('<a href="https://example.test/?a=1&amp;b=2">go</a>', "go (https://example.test/?a=1&b=2)", "the address is decoded");
eq('<a href="#top">top</a> <a href="javascript:alert(1)">x</a> <a href="cid:abc">y</a>', "top x y");
eq('<a href="https://example.test/"><b>bold</b> link</a>', "bold link (https://example.test/)");
eq('<a href="https://example.test/"></a>', "https://example.test/", "a link without text shows its address");
eq("<a>no address</a>", "no address");
const longUrl = "https://example.test/" + "a".repeat(2000);
eq(`<p>x <a href="${longUrl}">long</a></p>`, `x long (${longUrl})`, "a 2000 character address is kept whole");

// lists: bullets, numbers, nesting, start
eq("<ul><li><p>a</p></li><li><p>b</p></li></ul>", "- a\n- b");
eq("<ol><li><p>a</p></li><li><p>b</p></li></ol>", "1. a\n2. b");
eq('<ol start="3"><li>c</li><li>d</li></ol>', "3. c\n4. d");
eq("<ul><li><p>a</p><ul><li><p>a1</p></li><li><p>a2</p></li></ul></li><li><p>b</p><ol><li><p>b1</p></li></ol></li></ul>", "- a\n  - a1\n  - a2\n- b\n  1. b1");
eq("<p>before</p><ul><li>x</li></ul><p>after</p>", "before\n- x\nafter");
eq("<ul><li></li><li>y</li></ul>", "-\n- y");

// blockquote: every line has its mark, nested quotes have two
eq("<blockquote><p>one</p><p>two</p></blockquote>", "> one\n> two");
eq("<p>On Thu, Ann wrote:</p><blockquote><p>quoted<br>more</p><blockquote><p>deeper</p></blockquote></blockquote><p>my answer</p>", "On Thu, Ann wrote:\n> quoted\n> more\n> > deeper\nmy answer");
eq("<blockquote><p>Reply all probe body.<br><br></p></blockquote><p>end</p>", "> Reply all probe body.\nend", "no blank quote lines at the end of a quote");
eq("<blockquote><p>a</p><p></p><p>b</p></blockquote>", "> a\n>\n> b");
// quoted plain-text mail keeps its line breaks (white-space: pre-wrap)
eq('<blockquote><div style="white-space:pre-wrap">line 1\nline 2\n\nline 4</div></blockquote>', "> line 1\n> line 2\n>\n> line 4");

// S7: a reply with the signature in front of the attribution line and the quote
eq('<p>Thanks!</p><br><div class="sig">-- <br>Nam</div><p></p><p>On Thu, 15 Oct, Ann &lt;a@x.test&gt; wrote:</p><blockquote><p>Hello <a href="https://example.test/p">the page</a></p><ul><li>one</li></ul></blockquote>',
  "Thanks!\n\n-- \nNam\n\nOn Thu, 15 Oct, Ann <a@x.test> wrote:\n> Hello the page (https://example.test/p)\n> - one");

// tables: tab separated cells, one row per line
eq("<table><tbody><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr><tr><td>Pear <b>x</b></td><td><p>7</p><p>8</p></td></tr></tbody></table>", "Name\tQty\nApple\t3\nPear x\t7 8");
eq("<p>before</p><table><tr><td>a</td><td></td><td>c</td></tr></table><p>after</p>", "before\na\t\tc\nafter");

// headings on their own line
eq("<h1>Title</h1><p>text</p><h3>Sub</h3>after", "Title\ntext\nSub\nafter");
eq("<p>x</p><h2>Head</h2><p>y</p>", "x\nHead\ny");

// images: the alt text; text styles leave nothing behind
eq('<p>See <img src="cid:x" alt="company logo"> here</p>', "See [company logo] here");
eq('<p><img src="cid:x" alt=""> only a picture</p>', "only a picture");
eq("<p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <code>c</code></p>", "b i u s c");

// entities: no stray `&...;` is left
eq("<p>Tom &amp; Jerry &lt;tj@x.test&gt; &quot;hi&quot; it&#39;s&nbsp;fine&mdash;ok &euro;5 &#x1F680; &copy; &unknownthing;</p>", 'Tom & Jerry <tj@x.test> "hi" it\'s fine—ok €5 🚀 © &unknownthing;');
assert.equal(decodeEntities("&amp;lt;"), "&lt;", "decoded once");
assert.equal(decodeEntities("&#0; &#xD800; &#1114112;"), "&#0; &#xD800; &#1114112;", "impossible code points stay as written");
// text that looks like markup was escaped by the editor and stays text
eq("<p>if a &lt; b and c &gt; d, use &lt;b&gt;bold&lt;/b&gt;</p>", "if a < b and c > d, use <b>bold</b>");
eq("<p>a < b</p>", "a < b", "a lone < is text");

// whitespace and the rest of the markup
eq("<p>  lots   of \n source   spacing  </p>", "lots of source spacing");
eq("<pre>  keep\n    this\n</pre><p>x</p>", "keep\n    this\nx", "the breaks and blanks inside <pre> stay (the very first blanks of the message go)");
eq("<style>p{color:red}</style><script>alert(1)</script><p>visible</p><!-- hidden -->", "visible");
eq("<!doctype html><html><head><title>t</title><style>a{}</style></head><body><p>body</p></body></html>", "body");
eq('<div><div>nested</div></div><div>next</div>', "nested\nnext");
eq("<p>zero​width</p>", "zerowidth");
eq("", "");
eq("   ", "");
eq("plain text with no markup", "plain text with no markup");
eq('<p data-x="a>b">attribute with a &gt; inside</p>', "attribute with a > inside");
eq("<p>unclosed <b>bold", "unclosed bold");

// the editor's own forms (src/editor/emailHtml.ts): numbering types per level, an empty last item, a horizontal line, an empty paragraph that keeps its height
eq('<ol style="list-style-type:decimal"><li>a<ol type="a" style="list-style-type:lower-alpha"><li>b<ol type="i"><li>c</li></ol></li><li>d</li></ol></li></ol>', "1. a\n  a. b\n    i. c\n  b. d");
eq('<ol type="A"><li>x</li><li>y</li></ol><ol type="I" start="4"><li>z</li></ol>', "A. x\nB. y\nIV. z");
eq("<ul><li>a</li><li></li></ul><p>after</p>", "- a\n-\nafter", "an empty last item keeps its marker on its own line");
eq('<p style="margin:0">one</p><hr style="border:0"><p style="margin:0">two</p>', "one\n----------\ntwo");
eq('<p style="margin:0">one</p><p style="margin:0"><br></p><p style="margin:0">three</p>', "one\n\nthree");
eq("<blockquote><p>q</p><hr><p>r</p></blockquote>", "> q\n> ----------\n> r");

// no tag or entity survives in a rich message
const rich = '<p><strong>Bold</strong>, <em>italic</em> and <u>underline</u> &amp; more&nbsp;text</p><ul><li><p>one</p><ol><li><p>sub one</p></li></ol></li></ul><p><a href="https://example.test/x">a link</a></p><h2># not a heading</h2><p>done</p>';
const out = htmlToText(rich);
assert.ok(!/<[a-z/]|&[a-z#0-9]+;/i.test(out), out);
assert.equal(out, "Bold, italic and underline & more text\n- one\n  1. sub one\na link (https://example.test/x)\n# not a heading\ndone");
console.log("html-text: all checks passed");
