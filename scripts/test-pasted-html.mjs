// Pasted / dropped / quoted HTML never starts a request while the message is being written (O-01, O-03, O-14; CF-16).
// Run: node --experimental-strip-types scripts/test-pasted-html.mjs
import assert from "node:assert/strict";
import { cleanPastedHtml, decodeEntities, isLocalPictureSrc, rewriteTags, stripRemotePictures } from "../src/pastedHtml.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const UNC = "\\\\127.0.0.1\\share\\x.png"; // the string \\127.0.0.1\share\x.png

// --- sources that stay / go -----------------------------------------------------------------------------------------------------
for (const ok of [PNG, "data:image/jpeg;base64,/9j/4AAQ", "data:image/gif;base64,R0lGOD", "data:image/webp;base64,UklGR", "cid:abc-123@heylook", "CID:ABC", " \tdata:image/png;base64,AAAA"]) {
  assert.ok(isLocalPictureSrc(ok), ok);
}
for (const bad of [
  "http://127.0.0.1:19080/pixel?id=paste-img", "https://x.test/a.png", "HTTP://X/A.PNG", "//127.0.0.1/pixel", "ftp://x/y.png", UNC, "file:///C:/Windows/win.ini",
  "FILE:///etc/passwd", "javascript:alert(1)", "vbscript:x", "data:text/html,<script>alert(1)</script>", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png,notbase64", "data:image/SVG+xml;base64,PHN2Zz4=",
  "blob:http://x/1", "about:blank", "x.png", "", "&#104;ttp://x/y", "jav&#x61;script:alert(1)", "cid:", "cid:a b", "data:image/png;base64,",
]) {
  assert.ok(!isLocalPictureSrc(bad), JSON.stringify(bad));
}
// a browser ignores a tab or newline inside the scheme, so ht<TAB>tp:// is still http://
assert.ok(!isLocalPictureSrc("ht\ntp://x/y"));
assert.ok(isLocalPictureSrc("da\nta:image/png;base64,AAAA"), "and the same blanks inside a data: URI do not make it remote");

// --- the tracking pixel of O-01 / O-03 -------------------------------------------------------------------------------------------
const pixel = '<p>Hostile paste r17</p><img src="http://127.0.0.1:19080/pixel?id=paste-img"><p>js</p>';
assert.deepEqual(stripRemotePictures(pixel), { html: "<p>Hostile paste r17</p><p>js</p>", removed: 1 });
const o14 = `<img src="${UNC}"><img src="file:///C:/Windows/win.ini"><img src=//evil.test/p.gif><img src='ftp://x/y'>`;
assert.deepEqual(stripRemotePictures(o14), { html: "", removed: 4 });
// data pictures and cid pictures stay exactly as they were
const keep = `<p>a</p><img src="${PNG}" alt="shot" width="480"><img src="cid:x@heylook"><p>b</p>`;
assert.deepEqual(stripRemotePictures(keep), { html: keep, removed: 0 });
// no src at all, srcset only, uppercase tag, attributes in odd order, self-closing
assert.equal(stripRemotePictures("<IMG SRCSET='http://x/a.png 2x'>t").html, "t");
assert.equal(stripRemotePictures('<img alt="a>b" src="http://x/y.png" />t').html, "t", "a > inside a quoted value does not end the tag");
assert.equal(stripRemotePictures('<img/src="http://x/y.png"/onerror=alert(1)>t').html, "t");
assert.equal(stripRemotePictures('<img src="http://x/y.png" onerror="alert(1)">t').html, "t");
assert.equal(stripRemotePictures("<img src=http://x/y.png>t").html, "t", "unquoted value");
assert.equal(stripRemotePictures("<img\nsrc\n=\n'http://x/y.png'\n>t").html, "t", "blanks around =");
assert.equal(stripRemotePictures('<img src="&#104;ttp://x/y.png">t').html, "t", "entity-encoded scheme");
assert.equal(stripRemotePictures('<img src="&#x68;ttp://x/y.png">t').html, "t");
assert.equal(stripRemotePictures('<imgsrc="http://x/y.png">t').html, '<imgsrc="http://x/y.png">t', "a tag named imgsrc is not an img (the editor schema ignores it)");
// an unterminated tag swallows the rest, like a browser; nothing after it can be a tag of its own
assert.equal(stripRemotePictures('ok<img src="http://x/y.png').html, "ok");
assert.equal(stripRemotePictures("ok<img src=http://x/y.png").html, "ok");
// comments are left alone (the browser does not fetch from them) and a lone < is text
assert.equal(stripRemotePictures("a < b <!-- <img src=http://x/y.png> --> c").html, "a < b <!-- <img src=http://x/y.png> --> c");
assert.equal(stripRemotePictures("1<2 and 3>2").html, "1<2 and 3>2");
// text and other markup are not touched
const doc = '<h1 style="color:red">T</h1><p><a href="https://x.test/">link</a> <b>bold</b></p><table><tr><td>1</td></tr></table>';
assert.deepEqual(stripRemotePictures(doc), { html: doc, removed: 0 });

// --- the full hostile fixture of the plan (O-01) -------------------------------------------------------------------------------
const hostile = `<!--StartFragment--><p>Hostile paste r17</p><script>window.__pwned=1</script><iframe src="http://127.0.0.1:19080/frame"></iframe>
<img src=x onerror="window.__pwned=2"><img src="http://127.0.0.1:19080/pixel?id=paste-img"><img src="${UNC}"><img src="file:///C:/Windows/win.ini">
<a href="javascript:alert(1)">js</a><p style="background:url(http://127.0.0.1:19080/bg)">Styled</p><div data-sig-block>fake signature</div><!--EndFragment-->`;
const r = cleanPastedHtml(hostile);
assert.equal(r.removed, 4, "every picture except data: / cid: goes (img src=x included: it is not self-contained)");
assert.ok(!/<img/i.test(r.html), r.html);
assert.ok(!/data-sig-block/i.test(r.html), "no copy of the signature region");
assert.ok(r.html.includes("<div>fake signature</div>") && r.html.includes("Hostile paste r17") && r.html.includes("Styled"), "text stays");

// --- signature marker: only the paste cleaner removes it, quoted / opened bodies keep it ------------------------------------------
const sig = "<p></p><div data-sig-block></div><p>x</p>";
assert.equal(stripRemotePictures(sig).html, sig, "stripRemotePictures leaves the signature region (it is used on the editor's own content)");
assert.equal(cleanPastedHtml('<div data-sig-block="" class="a">s</div>').html, '<div class="a">s</div>');
assert.equal(cleanPastedHtml("<div DATA-SIG-BLOCK>s</div>").html, "<div>s</div>");

// --- helpers -----------------------------------------------------------------------------------------------------------------------
assert.equal(decodeEntities("&#x41;&#66;&amp;&lt;&unknown;&#0;"), "AB&<&unknown;" + String.fromCharCode(0xfffd));
const seen = [];
rewriteTags('<p class="a">x</p><br/><img src="a" alt=b>', (t) => (seen.push([t.name, t.end, t.selfClosing, t.attrs.map((a) => a.name + "=" + a.value).join(",")]), null));
assert.deepEqual(seen, [["p", false, false, "class=a"], ["p", true, false, ""], ["br", false, true, ""], ["img", false, false, "src=a,alt=b"]]);

// --- large input stays fast ------------------------------------------------------------------------------------------------------
const big = '<p>text</p><img src="http://x/p.png">'.repeat(50_000);
const t0 = Date.now();
const rb = stripRemotePictures(big);
assert.equal(rb.removed, 50_000);
assert.ok(Date.now() - t0 < 3000, "50 000 tags took " + (Date.now() - t0) + " ms");

console.log("test-pasted-html: ok");
