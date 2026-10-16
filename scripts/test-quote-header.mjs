// Reply / forward header lines (CF-26 / O-08): sender name, address, subject, recipients and date of the ORIGINAL message are text, never markup.
// Run: node --experimental-strip-types scripts/test-quote-header.mjs
import assert from "node:assert/strict";
import { escapeHtml, forwardHeaderHtml, headerValueHtml, senderHtml } from "../src/quoteHeader.ts";

const labels = { header: "---------- Forwarded message ----------", from: "From:", date: "Date:", subject: "Subject:", to: "To:" };
const fwd = (m) => forwardHeaderHtml(labels, { fromName: "", fromEmail: "a@b.c", dateText: "Fri, 16 Oct 2026", subject: "s", to: "me@x.y", ...m });

// every tag-forming character is an entity
assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
assert.equal(escapeHtml("plain text 東京 Báo cáo"), "plain text 東京 Báo cáo");
assert.equal(escapeHtml(undefined), "");

// hostile sender names and subjects (plan O-08 and friends)
const hostile = [
  "<b>x</b>",
  "<img src=x onerror=alert(1)>",
  `"><script>alert(1)</script>`,
  "<a href=\"javascript:alert(1)\">click</a>",
  "javascript:alert(1)",
  "<svg onload=alert(1)>",
  "<iframe srcdoc='<script>1</script>'></iframe>",
  "&lt;already&gt; &amp; <",
  "<style>body{display:none}</style>",
  "<!-- c --><![CDATA[x]]>",
  "'><img src='http://127.0.0.1/pixel'>",
];
for (const h of hostile) {
  for (const out of [fwd({ fromName: h }), fwd({ subject: h }), fwd({ to: h }), fwd({ fromEmail: h }), fwd({ dateText: h }), senderHtml(h, "a@b.c"), headerValueHtml(h)]) {
    assert.ok(!/<\s*(b|img|script|a|svg|iframe|style)\b/i.test(out.replace(/<br>/g, "")), `markup survived for ${JSON.stringify(h)}: ${out}`);
    assert.ok(!out.includes("<!--") && !out.includes("<!["), "comment / CDATA survived");
    assert.ok(!/onerror=[^&]*>/i.test(out) || !out.includes("<img"), "attribute survived as a tag");
  }
}
// the text is still readable
assert.ok(fwd({ fromName: "<b>x</b>" }).includes("&lt;b&gt;x&lt;/b&gt; &lt;a@b.c&gt;"));
assert.ok(fwd({ subject: "<img src=x onerror=alert(1)>" }).includes("Subject: &lt;img src=x onerror=alert(1)&gt;<br>"));
assert.ok(fwd({ to: `"Bob <b>" <bob@x.y>` }).includes("To: &quot;Bob &lt;b&gt;&quot; &lt;bob@x.y&gt;"));

// the frame of the header is the same as before (labels, order, the two <br> that end it)
assert.equal(
  fwd({ fromName: "Ann", subject: "Hi" }),
  "<br><br>---------- Forwarded message ----------<br>From: Ann &lt;a@b.c&gt;<br>Date: Fri, 16 Oct 2026<br>Subject: Hi<br>To: me@x.y<br><br>",
);
assert.equal(senderHtml("", "a@b.c"), "a@b.c", "no name: just the address");
assert.equal(senderHtml("Ann", "a@b.c"), "Ann &lt;a@b.c&gt;");

// CR / LF / tab / NUL / U+2028 cannot add a line or a header: one line each
for (const bad of ["a\r\nBcc: evil@x.y", "a\nb", "a\rb", "a\tb", "a\u0000b", "a\u2028b", "a\u0085b"]) {
  const out = headerValueHtml(bad);
  assert.ok(!/[\r\n\t\u0000\u2028\u0085]/.test(out), JSON.stringify(out));
  assert.ok(!out.includes("<br>"));
}
assert.equal(headerValueHtml("a\r\n\r\nb"), "a b");
assert.ok(!fwd({ subject: "x\r\n<br><br>Fake: line" }).slice(60).includes("<br><br>Fake"), "a subject cannot add a line break");

// very long values are handled (linear, no truncation of what the person wrote)
const long = "<".repeat(200_000);
const t0 = Date.now();
const out = fwd({ subject: long });
assert.ok(out.includes("&lt;".repeat(200_000)));
assert.ok(Date.now() - t0 < 2000, "escaping 200 000 characters took too long");

console.log("test-quote-header: ok");
