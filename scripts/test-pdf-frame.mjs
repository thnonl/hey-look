// Checks src/pdfFrame.ts: what may go into the PDF preview frame and how it is sandboxed (1.0.6 WP1b).
// Why: WebView2's PDF viewer does not run in a sandboxed frame (every sandbox token set was tried in the real window), so on Chromium the
// preview frame has no sandbox. That is only safe because nothing but bytes that start with "%PDF-" gets a frame, typed application/pdf
// (a blob URL is same-origin with the app; an HTML file in an unsandboxed frame would be the app's own origin).
// Run: node --experimental-strip-types scripts/test-pdf-frame.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { isPdfBytes, pdfFrameSandbox, pdfPreview } from "../src/pdfFrame.ts";
import { frameSandbox, isWebKit } from "../src/frameSandbox.ts";

const bytes = (s) => Uint8Array.from(Buffer.from(s, "latin1"));
const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";
const chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const gtk = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// ---- the magic bytes: "%PDF-" at the very start, nothing else
assert.equal(isPdfBytes(bytes("%PDF-1.4\n1 0 obj")), true);
assert.equal(isPdfBytes(bytes("%PDF-2.0 ")), true);
assert.equal(isPdfBytes(bytes("%PDF-")), false, "the header alone is no document");
assert.equal(isPdfBytes(bytes("%PDF")), false);
assert.equal(isPdfBytes(bytes("")), false);
assert.equal(isPdfBytes(new Uint8Array(0)), false);
assert.equal(isPdfBytes(bytes(" %PDF-1.4")), false, "nothing may come before the header (no 1024-byte tolerance)");
assert.equal(isPdfBytes(bytes("\n%PDF-1.4")), false);
assert.equal(isPdfBytes(bytes("\xef\xbb\xbf%PDF-1.4")), false, "a BOM before it is not accepted either");
assert.equal(isPdfBytes(bytes("%pdf-1.4")), false, "case matters");
assert.equal(isPdfBytes(bytes("<!doctype html><script>top.x=1</script>")), false, "HTML called .pdf");
assert.equal(isPdfBytes(bytes("<html><body>%PDF-1.4")), false);
assert.equal(isPdfBytes(bytes("PK\u0003\u0004 zip named .pdf")), false);
assert.equal(isPdfBytes(bytes("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>")), false);

// ---- the decision: a blob typed application/pdf, or nothing
const good = pdfPreview(bytes("%PDF-1.4\nrest of the file"), edge);
assert.equal(good.ok, true);
assert.equal(good.blob.type, "application/pdf", "the type is forced by the app, whatever the mail said");
assert.equal(good.blob.size, "%PDF-1.4\nrest of the file".length);
assert.equal(pdfPreview(bytes("<!doctype html><script>top.__pwned=1</script>"), edge).ok, false, "a file called .pdf that holds HTML gets no frame");
assert.equal(pdfPreview(bytes("<!doctype html><script>top.__pwned=1</script>"), mac).ok, false, "on every engine");
assert.equal(pdfPreview(bytes(""), edge).ok, false);
// a polyglot that starts with the header gets the frame, but only ever as application/pdf (Chromium does not sniff that type into HTML: real window test, WP1b)
const poly = pdfPreview(bytes("%PDF-1.4\n<html><script>top.__pwned=1</script>"), edge);
assert.equal(poly.ok, true);
assert.equal(poly.blob.type, "application/pdf");
assert.notEqual(poly.blob.type, "text/html");

// ---- the sandbox per engine
assert.equal(pdfFrameSandbox(edge), null, "Windows (WebView2, Chromium): no sandbox attribute, or the viewer shows the blocked page");
assert.equal(pdfFrameSandbox(chrome), null);
assert.equal(pdfFrameSandbox(""), null);
assert.equal(pdfFrameSandbox(mac), "allow-same-origin allow-scripts", "macOS (WKWebView) keeps what it always had");
assert.equal(pdfFrameSandbox(gtk), "allow-same-origin allow-scripts", "WebKitGTK too (it has no PDF preview anyway, see previewable())");
assert.equal(good.sandbox, null);
assert.equal(pdfPreview(bytes("%PDF-1.4\nx"), mac).sandbox, "allow-same-origin allow-scripts");
assert.equal(isWebKit(edge), false);
assert.equal(isWebKit(mac), true);
assert.equal(isWebKit(chrome), false);

// ---- everything else keeps its sandbox: the mail frame (frameSandbox) is untouched, and no other frame was added
assert.equal(frameSandbox(edge), "allow-same-origin allow-modals");
assert.match(frameSandbox(mac), /allow-scripts/);
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const att = read("src/components/Attachments.tsx");
const reading = read("src/components/ReadingPane.tsx");
assert.match(reading, /sandbox=\{frameSandbox\(navigator\.userAgent\)\}/, "the mail frame keeps its sandbox");
assert.equal((att.match(/<iframe\b/g) ?? []).length, 1, "one frame in the attachments: the PDF preview");
assert.doesNotMatch(att, /sandbox="/, "no literal sandbox in Attachments.tsx: the PDF frame takes it from pdfFrame.ts, images and text are not frames");
assert.match(att, /sandbox=\{data\.sandbox\}/);
// the frame is only built from the checked preview, and a refused one shows a message, not a frame
assert.match(att, /const pdf = pdfPreview\(b64ToBytes\(d\.dataBase64\), navigator\.userAgent\);/);
assert.match(att, /if \(!pdf\.ok\) \{\s*setData\(\{ url: "", notPdf: true \}\);\s*return;\s*\}/);
assert.match(att, /URL\.createObjectURL\(pdf\.blob\)/);
assert.doesNotMatch(att, /new Blob\(/, "no other blob is made in Attachments.tsx");
// no other place builds an unsandboxed frame
for (const f of fs.readdirSync(new URL("../src/components", import.meta.url)).map((n) => `src/components/${n}`)) {
  if (!/\.tsx$/.test(f) || f === "src/components/Attachments.tsx" || f === "src/components/ReadingPane.tsx") continue;
  assert.doesNotMatch(read(f), /<iframe\b/, `${f} has an iframe`);
}
// the policy the frame lives under still says no plug-ins and only blob: frames
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
assert.match(conf.app.security.csp, /frame-src blob:;/);
assert.match(conf.app.security.csp, /object-src 'none'/);
// the backend guard that stops a link in a PDF from taking the window to a website is registered on Windows
const lib = read("src-tauri/src/lib.rs");
assert.match(lib, /#\[cfg\(windows\)\]\s*\/\/[^\n]*\n\s*let builder = builder\.plugin\(navguard::plugin\(\)\);/, "navguard is registered on Windows");
console.log("pdf-frame: all checks passed");
