// The address of a link made in the composer (BUG-21 / CF-12): only http, https, mailto and tel; bare domains get https://.
// Run: node --experimental-strip-types scripts/test-link-url.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkLinkUrl, linkDisplayText, planLinkEdit } from "../src/linkUrl.ts";

const ok = (input, href) => assert.deepEqual(checkLinkUrl(input), { ok: true, href }, input);
const no = (input, reason) => assert.deepEqual(checkLinkUrl(input), { ok: false, reason }, JSON.stringify(input));

// web addresses
ok("https://example.com", "https://example.com");
ok("https://example.com/", "https://example.com/");
ok("heylook.app", "https://heylook.app"); // AC-47
ok("https://example.com?x=1", "https://example.com/?x=1");
ok("https://example.com/a/b?x=1&y=2#frag", "https://example.com/a/b?x=1&y=2#frag");
ok("HTTP://Example.COM/Path", "http://example.com/Path");
ok("  https://example.com  ", "https://example.com");
ok("http://localhost:3000/app", "http://localhost:3000/app");
ok("http://192.168.1.10:8080", "http://192.168.1.10:8080");
ok("http://[::1]:8080/x", "http://[::1]:8080/x");
// a bare domain gets https://
ok("example.com", "https://example.com");
ok("www.example.com/path?q=1", "https://www.example.com/path?q=1");
ok("example.com:8080/x", "https://example.com:8080/x");
ok("localhost:3000", "https://localhost:3000");
ok("sub.domain.co.uk", "https://sub.domain.co.uk");
ok("//example.com/x", "https://example.com/x");
ok("münchen.de", "https://xn--mnchen-3ya.de");
// email and phone
ok("ann@example.com", "mailto:ann@example.com");
ok("first.last+tag@sub.example.co.uk", "mailto:first.last+tag@sub.example.co.uk");
ok("mailto:ann@example.com", "mailto:ann@example.com");
ok("MAILTO:ann@example.com?subject=Hi%20there", "mailto:ann@example.com?subject=Hi%20there");
ok("tel:+4930123456", "tel:+4930123456");
ok("tel:(030)-123-456", "tel:(030)-123-456");

// schemes that can run code, read local files or are simply not links of a mail
for (const bad of [
  "javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD4=", "file:///C:/Windows/win.ini", "FILE:///etc/passwd", "ftp://example.com/x", "blob:https://example.com/1", "about:blank", "sms:123",
  "intent://x#Intent;end", "chrome://settings", "view-source:https://example.com", "x-apple:foo", "ssh://host", "smb://host/share", "ws://host", "wss://host",
]) {
  no(bad, "scheme");
}
// a control character inside the scheme is dropped like a browser does, so it is the same refusal
no("jav\u0001ascript:alert(1)", "scheme");
// not an address at all
for (const bad of [
  "java\tscript:alert(1)", "java\nscript:alert(1)", "not a link", "hello world.com", "https://", "http://", "https:///path", "http://.com", "http://a..b", "http://nodots", "example", "x", "//", "/path/only", "#frag", "?q=1",
  "https://exa mple.com", "https://example.com/<script>", 'https://example.com/"onmouseover=', "https://example.com\\evil", "\\\\host\\share\\x.png", "https://bank.com@evil.test/",
  "https://user:pass@example.com/", "ann@", "@example.com", "ann@example", "ann@@example.com", "mailto:", "mailto:notanemail", "mailto:a b@example.com", "tel:", "tel:abc", "tel:12", "tel:+",
]) {
  no(bad, "invalid");
}
no("", "empty");
no("   ", "empty");
no("\u0000", "empty");
no("https://example.com/" + "a".repeat(2100), "invalid");

// whatever is accepted is one of the four schemes and has no markup or blanks
for (const x of ["example.com", "ann@example.com", "tel:+4930123456", "http://localhost:3000", "mailto:ann@example.com?subject=a%20b"]) {
  const r = checkLinkUrl(x);
  assert.ok(r.ok && /^(https?|mailto|tel):/.test(r.href) && !/[\s<>"]/.test(r.href), x);
}

// what applying does
assert.deepEqual(planLinkEdit({ rangeEmpty: true, original: "", typed: "", href: "https://example.com/" }), { kind: "insert", text: "https://example.com/" });
assert.deepEqual(planLinkEdit({ rangeEmpty: true, original: "", typed: "  Our site ", href: "https://example.com/" }), { kind: "insert", text: "Our site" });
assert.deepEqual(planLinkEdit({ rangeEmpty: true, original: "", typed: "", href: "mailto:ann@example.com" }), { kind: "insert", text: "ann@example.com" });
assert.deepEqual(planLinkEdit({ rangeEmpty: false, original: "Our site", typed: "Our site", href: "https://example.com/" }), { kind: "mark" });
assert.deepEqual(planLinkEdit({ rangeEmpty: false, original: "Our site", typed: "", href: "https://example.com/" }), { kind: "mark" }, "an empty text keeps the selected text");
assert.deepEqual(planLinkEdit({ rangeEmpty: false, original: "Our site", typed: "Home page", href: "https://example.com/" }), { kind: "replace", text: "Home page" });
assert.equal(linkDisplayText("tel:+49 30"), "+49 30");

// wiring: no native prompt anywhere in the app's editors, one popover for the toolbar button and Ctrl/Cmd+K
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
for (const f of ["src/components/Compose.tsx", "src/components/RichEditor.tsx", "src/composeKeys.ts"]) {
  assert.ok(!/\bprompt\(/.test(read(f).replace(/\/\/.*$/gm, "")), `${f} still calls window.prompt`);
}
assert.ok(/useLinkEditor\(/.test(read("src/components/Compose.tsx")) && /useLinkEditor\(/.test(read("src/components/RichEditor.tsx")));
assert.ok(/checkLinkUrl\(/.test(read("src/components/LinkPopover.tsx")));

console.log("test-link-url: ok");
