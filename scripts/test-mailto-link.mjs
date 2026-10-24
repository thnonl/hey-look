// An email link in a message opens a new message in Hey Look! (W8.10): what is taken from a `mailto:` link (RFC 6068) and the HTML of the body text. Behaviour of src/mailtoLink.ts.
// Run: node --experimental-strip-types scripts/test-mailto-link.mjs
import assert from "node:assert/strict";
import { bodyTextToHtml, MAILTO_MAX_ADDRESSES, MAILTO_MAX_BODY, MAILTO_MAX_SUBJECT, parseMailto } from "../src/mailtoLink.ts";

const p = (href) => parseMailto(href);
const f = (o) => ({ to: [], cc: [], bcc: [], subject: "", body: "", ...o });

// not a mailto link
assert.equal(p("https://example.test/"), null);
assert.equal(p("tel:+123"), null);
assert.equal(p(""), null);
// AC-8.10.1: one address, nothing else
assert.deepEqual(p("mailto:qa1@example.test"), f({ to: ["qa1@example.test"] }));
assert.deepEqual(p("MAILTO:qa1@example.test"), f({ to: ["qa1@example.test"] }), "the scheme in any case");
assert.deepEqual(p("  mailto:qa1@example.test  "), f({ to: ["qa1@example.test"] }), "spaces around the link");
// AC-8.10.2
assert.deepEqual(
  p("mailto:qa1@example.test,qa2@example.test?cc=qa3@example.test&bcc=qa4@example.test&subject=Hello%20there&body=Line%201%0D%0ALine%202"),
  f({ to: ["qa1@example.test", "qa2@example.test"], cc: ["qa3@example.test"], bcc: ["qa4@example.test"], subject: "Hello there", body: "Line 1\nLine 2" }),
);
// AC-8.10.3
assert.deepEqual(p("mailto:?subject=Only%20subject"), f({ subject: "Only subject" }));
// AC-8.10.4: attach, from, in-reply-to and every other field are ignored
assert.deepEqual(
  p("mailto:qa1@example.test?attach=C:%5CWindows%5Cwin.ini&from=evil@example.test&In-Reply-To=%3Cx@y%3E"),
  f({ to: ["qa1@example.test"] }),
);
for (const name of ["attachment", "attach", "from", "in-reply-to", "references", "x-custom", "reply-to", "sender", "return-path", "content-type", "importance"]) {
  assert.deepEqual(p(`mailto:a@b.test?${name}=zzz`), f({ to: ["a@b.test"] }), `${name} is ignored`);
}
// field names in any case; to, cc and bcc add up; subject and body keep the first
assert.deepEqual(p("mailto:a@b.test?TO=c@d.test&To=e@f.test&CC=g@h.test&Cc=i@j.test&BCC=k@l.test&Subject=One&SUBJECT=Two&Body=B1&body=B2"), f({
  to: ["a@b.test", "c@d.test", "e@f.test"], cc: ["g@h.test", "i@j.test"], bcc: ["k@l.test"], subject: "One", body: "B1",
}));
assert.deepEqual(p("mailto:a@b.test?to=c@d.test,e@f.test"), f({ to: ["a@b.test", "c@d.test", "e@f.test"] }), "a field with a list");
// decoding: UTF-8 percent sequences, a plus stays a plus, a bad % keeps the raw text
assert.equal(p("mailto:a@b.test?subject=caf%C3%A9").subject, "café");
assert.equal(p("mailto:a@b.test?subject=%E8%AB%8B%E6%B1%82").subject, "請求");
assert.equal(p("mailto:a@b.test?subject=1+1%3D2").subject, "1+1=2", "+ is a plus");
assert.equal(p("mailto:a@b.test?subject=100%").subject, "100%", "a bad % keeps the raw text");
assert.equal(p("mailto:a@b.test?subject=%E8%AB").subject, "%E8%AB", "a cut UTF-8 sequence keeps the raw text");
assert.deepEqual(p("mailto:j%C3%B6rg@example.test").to, ["jörg@example.test"], "the address part is decoded");
assert.equal(p("mailto:a@b.test?body=a%26b%3Dc%3F").body, "a&b=c?", "an encoded & = ? is text");
assert.equal(p("mailto:a@b.test?subject=a%2Bb").subject, "a+b");
// a link with no value, an empty part, odd shapes
assert.deepEqual(p("mailto:a@b.test?"), f({ to: ["a@b.test"] }));
assert.deepEqual(p("mailto:a@b.test?&&subject=x&"), f({ to: ["a@b.test"], subject: "x" }));
assert.deepEqual(p("mailto:a@b.test?subject"), f({ to: ["a@b.test"] }), "a field with no = has no value");
assert.deepEqual(p("mailto:a@b.test?subject=#frag"), f({ to: ["a@b.test"] }), "the fragment is not part of the link");
assert.deepEqual(p("mailto:,,a@b.test,,"), f({ to: ["a@b.test"] }), "empty entries are dropped");
assert.deepEqual(p("mailto:"), f());
// header cleaning: no line break or control character in the subject or an address
assert.equal(p("mailto:a@b.test?subject=one%0D%0ABcc:%20evil@x.test").subject, "one Bcc: evil@x.test", "a line break in the subject becomes a space");
assert.equal(p("mailto:a@b.test?subject=a%00b%07c").subject, "abc", "control characters are dropped");
assert.deepEqual(p("mailto:a%0D%0AB@c.test").to, ["a B@c.test"], "a line break in an address becomes a space");
assert.equal(p("mailto:a@b.test?body=l1%0D%0Al2%0Dl3%0Al4").body, "l1\nl2\nl3\nl4", "the body keeps its line breaks (as LF)");
// limits: 50 addresses over To + Cc + Bcc in that order, subject 255, body 8000
{
  const many = (n, d) => Array.from({ length: n }, (_, i) => `u${i}@${d}`);
  const r = p(`mailto:${many(60, "a.test").join(",")}`);
  assert.equal(r.to.length, MAILTO_MAX_ADDRESSES, "60 addresses: 50");
  assert.equal(r.to[49], "u49@a.test");
  const r2 = p(`mailto:${many(30, "a.test").join(",")}?cc=${many(30, "b.test").join(",")}&bcc=${many(30, "c.test").join(",")}`);
  assert.deepEqual([r2.to.length, r2.cc.length, r2.bcc.length], [30, 20, 0], "To first, then Cc, then Bcc");
  const r3 = p(`mailto:x@y.test?subject=${"s".repeat(400)}&body=${"b".repeat(10000)}`);
  assert.equal(r3.subject.length, MAILTO_MAX_SUBJECT);
  assert.equal(r3.body.length, MAILTO_MAX_BODY, "AC-8.10.5: a body of 10,000 characters is cut at 8,000");
  const r4 = p(`mailto:${many(3, "a.test").join(",")}?bcc=${many(60, "c.test").join(",")}`);
  assert.deepEqual([r4.to.length, r4.bcc.length], [3, 47]);
}

// the HTML of the body: escaped, a blank line starts a paragraph, a single line break is a <br>, an empty paragraph follows
assert.equal(bodyTextToHtml(""), "");
assert.equal(bodyTextToHtml("\n\n"), "");
assert.equal(bodyTextToHtml("Hello"), "<p>Hello</p><p></p>");
assert.equal(bodyTextToHtml("Line 1\nLine 2"), "<p>Line 1<br>Line 2</p><p></p>", "AC-8.10.2: two lines");
assert.equal(bodyTextToHtml("Line 1\r\nLine 2"), "<p>Line 1<br>Line 2</p><p></p>");
assert.equal(bodyTextToHtml("A\n\nB\n\n\nC"), "<p>A</p><p>B</p><p>C</p><p></p>");
assert.equal(bodyTextToHtml("<b>x</b> & \"y\" 'z'"), "<p>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot; &#39;z&#39;</p><p></p>", "never markup");
assert.equal(bodyTextToHtml("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p><p></p>");
console.log("ok - test-mailto-link");
