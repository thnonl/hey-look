// W6.14: the link warning (src/linkCheck.ts): the agreed look-alike cases L1 to L4 and the cases that are NOT warned.
// Run: node --experimental-strip-types scripts/test-link-check.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { addressHost, isLookalikeLabel, labelUnicode, linkWarning, LOOKALIKES, mailDomain, punycodeDecode, trimmedText } from "../src/linkCheck.ts";

const kind = (text, href) => linkWarning(text, href)?.kind ?? null;

// ---- the ten links of the kit mail (AC-6.14.1)
const kit = [
  ["https://www.bank.test", "https://bank.test/login", null],
  ["bank.test", "https://login.bank.test", null],
  ["paypal.test", "https://paypal.test.evil.test", "mismatch"], // L1
  ["support@bank.test", "https://evil.test", "mismatch"], // L2
  ["Click here", "https://xn--pple-43d.test", "lookalike"], // L3 (аpple)
  ["Click here", "https://bank.test@evil.test/", "hidden"], // L4
  ["Visit shop.test for more", "https://tracker.test/r?u=1", null],
  ["https://shop.test/sale", "https://shop.test/sale?utm=1", null],
  ["Read more", "https://news.test/a", null],
  ["Write to us", "mailto:info@bank.test", null],
];
for (const [text, href, want] of kit) assert.equal(kind(text, href), want, `${text} -> ${href}`);
assert.deepEqual(linkWarning("paypal.test", "https://paypal.test.evil.test"), { kind: "mismatch", text: "paypal.test", target: "paypal.test.evil.test" });
assert.deepEqual(linkWarning("Click here", "https://xn--pple-43d.test"), { kind: "lookalike", target: "xn--pple-43d.test" });
assert.deepEqual(linkWarning("Click here", "https://bank.test@evil.test/"), { kind: "hidden", target: "evil.test" });
assert.deepEqual(linkWarning("Click here", "https://user:secret@bank.test/"), { kind: "hidden", target: "bank.test" });

// ---- L1: a web address as text, another host as target
assert.equal(kind("https://bank.test", "https://evil.test"), "mismatch");
assert.equal(kind("BANK.TEST", "https://bank.test/x"), null, "upper case");
assert.equal(kind("bank.test", "https://BANK.test/x"), null);
assert.equal(kind("www.bank.test", "https://bank.test"), null, "www is not a difference");
assert.equal(kind("bank.test", "https://www.bank.test"), null);
assert.equal(kind("bank.test", "http://bank.test:8080/a"), null, "a port is not a host");
assert.equal(kind("bank.test:8443/path", "https://bank.test/path"), null);
assert.equal(kind("bank.test.", "https://bank.test"), null, "a final dot in the text");
assert.equal(kind("bank.test,", "https://evil.test"), "mismatch", "a final comma is not part of the address");
assert.equal(kind("(bank.test)", "https://bank.test"), null, "brackets");
assert.equal(kind("“bank.test”", "https://evil.test"), "mismatch", "quotes");
assert.equal(kind("  bank.test  ", "https://evil.test"), "mismatch", "spaces");
assert.equal(kind("bank.test", "https://bank.test.evil.test"), "mismatch", "the text host as a prefix of the target");
assert.equal(kind("bank.test", "https://evilbank.test"), "mismatch", "a longer name is not a sub-domain");
assert.equal(kind("login.bank.test", "https://bank.test"), "mismatch", "the target is the parent: not a sub-domain of the text");
assert.equal(kind("bank.test", "https://a.b.bank.test/"), null, "any depth of sub-domain");
assert.equal(kind("bank​.test", "https://evil.test"), "mismatch", "a zero width space inside the text does not hide it");
assert.equal(kind("192.168.1.10", "https://192.168.1.10/a"), null);
assert.equal(kind("report.pdf", "https://files.test/r"), null, "a file name is not an address");
assert.equal(kind("www.report.pdf", "https://files.test/r"), "mismatch", "but www. makes it one");
assert.equal(kind("Visit bank.test", "https://evil.test"), null, "text in a sentence");
assert.equal(kind("bank.test and more", "https://evil.test"), null);
assert.equal(kind("bank.test/a b", "https://evil.test"), null);
assert.equal(kind("http://bank.test", "https://evil.test/"), "mismatch", "scheme in the text");
// a real non-Latin domain with matching text is fine
assert.equal(kind("пример.рф", "https://xn--e1afmkfd.xn--p1ai/"), null);
assert.equal(kind("пример.рф", "https://evil.test/"), "mismatch");
// the text of the warning is the trimmed text, cut at 80
assert.equal(linkWarning("(bank.test).", "https://evil.test").text, "bank.test");
assert.equal(linkWarning("a".repeat(100) + ".test", "https://evil.test").text.length, 80);

// ---- L2: an e-mail address as text
assert.equal(kind("support@bank.test", "https://www.bank.test/help"), null);
assert.equal(kind("support@bank.test", "https://help.bank.test/"), null, "sub-domain");
assert.equal(kind("Support@Bank.TEST", "https://bank.test/"), null, "upper case");
assert.equal(kind("support@bank.test", "https://bank.test.evil.test/"), "mismatch");
assert.equal(kind("<support@bank.test>", "https://evil.test"), "mismatch", "angle brackets");
assert.equal(kind("support@bank.test", "mailto:support@bank.test"), null, "mailto is not judged");
assert.equal(kind("support@bank.test", "tel:+10000000"), null);
assert.equal(kind("write to support@bank.test", "https://evil.test"), null, "in a sentence");
assert.equal(mailDomain("a@b.test"), "b.test");
assert.equal(mailDomain("a b@c.test"), null);
assert.equal(mailDomain("@c.test"), null);

// ---- other schemes are never judged
for (const href of ["mailto:a@b.test", "tel:123", "javascript:alert(1)", "data:text/html,x", "ftp://evil.test/", "not a url", ""]) assert.equal(kind("bank.test", href), null, href);

// ---- L3: look-alike labels
assert.equal(punycodeDecode("pple-43d"), "аpple", "Cyrillic a + pple");
assert.equal(labelUnicode("xn--pple-43d"), "аpple");
assert.equal(labelUnicode("bank"), "bank");
assert.equal(labelUnicode("xn--e1afmkfd"), "пример");
assert.equal(labelUnicode("xn--bcher-kva"), "bücher");
assert.equal(labelUnicode("xn--!"), "xn--!", "not valid: left as it is");
assert.equal(isLookalikeLabel("xn--pple-43d"), true, "Latin mixed with Cyrillic");
assert.equal(isLookalikeLabel("xn--bcher-kva"), false, "an accent is Latin");
assert.equal(isLookalikeLabel("xn--e1afmkfd"), false, "a real Russian word");
assert.equal(isLookalikeLabel("apple"), false);
assert.equal(isLookalikeLabel("bank-1"), false);
// only look-alike Cyrillic letters (all of these look like Latin: c o p e x a), none that is not
assert.equal(isLookalikeLabel("сореx".replace("x", "х")), true, "pure Cyrillic, all letters of the look-alike set");
assert.equal(isLookalikeLabel("аеорс"), true);
assert.equal(isLookalikeLabel("аеорсб"), false, "one letter outside the set (б): a real word");
// Greek: mixed with Latin, and pure look-alikes
assert.equal(isLookalikeLabel("gοogle"), true, "Latin with Greek omicron");
assert.equal(isLookalikeLabel("ορα"), true);
assert.equal(isLookalikeLabel("αβγ"), false, "a Greek word");
// whole hosts through the URL parser (it gives the xn-- form)
assert.equal(kind("Click here", "https://аpple.test/"), "lookalike");
assert.equal(kind("apple.test", "https://аpple.test/"), "lookalike", "whatever the text");
assert.equal(kind("Click", "https://paypal.xn--e1afmkfd.test"), null, "a label that is a real word is not warned");
assert.equal(kind("Click", "https://xn--80ak6aa92e.test"), "lookalike", "xn--80ak6aa92e is the famous Cyrillic “apple” look-alike");
assert.equal(kind("Click here", "https://xn--e1afmkfd.xn--p1ai/"), null, "a real Russian host");
assert.equal(kind("Click here", "https://xn--bcher-kva.test/"), null, "bücher");
assert.equal(kind("Click here", "https://xn--pple-43d.xn--p1ai/"), "lookalike", "one bad label is enough");
// the pinned set
assert.equal([...LOOKALIKES].sort().join(""), [..."аеорсухіјѕԁӏԛԝοανρτυικϲ"].sort().join(""));
for (const c of LOOKALIKES) assert.ok(/\p{Script=Cyrillic}|\p{Script=Greek}/u.test(c), c);

// ---- L4 wins and does not depend on the text
assert.equal(kind("bank.test", "https://bank.test@evil.test/"), "hidden");
assert.equal(kind("https://bank.test", "https://bank.test:443@evil.test/"), "hidden");
assert.equal(kind("Click", "https://@bank.test/"), null, "an empty user name is none");
assert.equal(kind("Click", "https://user@xn--pple-43d.test/"), "hidden");

// ---- helpers
assert.equal(trimmedText(' ("bank.test"). '), "bank.test");
assert.equal(addressHost("https://www.Bank.test/a?b#c"), "bank.test");
assert.equal(addressHost("bank"), null);
assert.equal(addressHost("a b.test"), null);

// ---- the wiring: one place, both windows (the reader window shows the same ReadingPane); the three bodies exist in 8 languages with {target}
const pane = readFileSync(new URL("../src/components/ReadingPane.tsx", import.meta.url), "utf8");
assert.ok(pane.includes("linkWarning(text, a.href)") && pane.includes("reading.body.linkWarnLookalike") && pane.includes("reading.body.linkWarnHidden"));
assert.ok(!pane.includes("looksLikeUrl"), "the old inline check is gone");
const files = ["src/i18n/ns/reading.ts", ...readdirSync(new URL("../src/i18n/locales", import.meta.url)).map((l) => `src/i18n/locales/${l}/reading.ts`)];
assert.equal(files.length, 8);
for (const f of files) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const k of ["linkWarnLookalike", "linkWarnHidden"]) {
    const m = new RegExp(`"reading\\.body\\.${k}": ("(?:[^"\\\\]|\\\\.)*"),`).exec(src);
    assert.ok(m, `${f}: ${k}`);
    assert.ok(JSON.parse(m[1]).includes("{target}"), `${f}: ${k} has {target}`);
  }
}
console.log("test-link-check: ok");
