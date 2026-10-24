// 1.0.7 D-112, no browser. Run: node scripts/test-quit-key-frames.mjs
// Ctrl+Q on Linux only reaches the page while the focus is in the window's own document. A key pressed inside a frame never reaches the window, so every frame that can
// hold the focus needs the key handler on ITS document (quitKey.ts `guardFrameQuitKey`). D-112: the frame of a Confidential mail was hooked with `lockDocument` only
// (no `guardFrame`), so Ctrl+Q did nothing while the person had clicked into a Confidential mail. This is the source guard: every place that makes a frame installs the handler
// (also for each document that is written into the frame: the mail is rewritten per mail and per "Show pictures", and the hooking runs again for each new document), and a NEW
// frame fails this test until it is listed here with its reason.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
const rel = (f) => path.relative(SRC, f).split(path.sep).join("/");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [path.join(d, e.name)] : []));
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const code = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"); // (a comment does not create a frame)

// 1. every file that creates a frame is known
const makers = new Map();
for (const f of walk(SRC)) {
  const text = code(fs.readFileSync(f, "utf8"));
  const k = (text.match(/<iframe\b/g) || []).length + (text.match(/createElement\(\s*["'`]iframe["'`]\s*\)/g) || []).length;
  if (k) makers.set(rel(f), k);
}
const KNOWN = {
  "components/ReadingPane.tsx": 1, // the frame of a message: reading pane, reader window (MessageCard), every message of a conversation
  "components/Attachments.tsx": 1, // the preview frame of a PDF / text / HTML attachment
  "darkMail.ts": 1, // the hidden scratch frame of the dark walk
};
for (const [f, k] of makers) ok(KNOWN[f] === k, `${f} makes ${k} frame(s) (listed: ${KNOWN[f] ?? 0}): a new frame needs the Ctrl+Q handler (guardFrame / guardFrameQuitKey on its document) and an entry in this test`);
for (const f of Object.keys(KNOWN)) ok(makers.has(f), `${f} is listed but makes no frame any more`);

// 2. the handler: on the frame's document, capture phase, removable
const qk = read("quitKey.ts");
ok(/export function guardFrameQuitKey\(doc: Document\)/.test(qk) && /doc\.addEventListener\("keydown", onKey, true\)/.test(qk) && /doc\.removeEventListener\("keydown", onKey, true\)/.test(qk), "guardFrameQuitKey adds and removes the capture keydown handler on the document");

// 3. the message frame: hooked for each written document, Confidential or not
const rp = read("components/ReadingPane.tsx");
const hook = rp.slice(rp.indexOf("const hookDoc = () =>"), rp.indexOf("const onLoad = () => hookDoc()"));
ok(hook.length > 500, "hookDoc found");
ok(/lockedNow\.current \? guardFrameQuitKey\(doc\) : guardFrame\(frame, doc, \{ search: true \}\)/.test(hook), "hookDoc: a Confidential mail gets the Ctrl+Q handler, any other mail the full guard (which has it)");
ok(/unguard\?\.\(\)/.test(hook), "hookDoc: the handler is removed when the document is left");
ok(/import \{ guardFrameQuitKey \} from "\.\.\/quitKey"/.test(rp), "ReadingPane imports guardFrameQuitKey");
// the mail is written into the same frame again for each mail: the hooking is forgotten and runs again for the new document
const at = rp.indexOf("writeMailDocument(frame");
const layout = rp.slice(rp.lastIndexOf("useLayoutEffect(() => {", at), rp.indexOf("[docParts, frameRef]", at));
ok(at > 0 && /hooked\.current = null;\s*stopObserve\.current\(\);/.test(layout), "the write forgets the hooked document and stops the old observers, so the new document is hooked");
ok(/if \(hooked\.current === doc\) return measure\(\)/.test(hook) && /hooked\.current = doc;\s*stopObserve\.current\(\);/.test(hook), "a document is hooked once; the hooking of the old one is undone first");
// only mailFrame.ts and the scratch frame write documents into a frame: a document.open drops every listener of the document
for (const f of walk(SRC)) {
  if (rel(f) === "mailFrame.ts" || rel(f) === "darkMail.ts") continue;
  ok(!/\.contentDocument[^;\n]*\.open\(|\bdoc\.open\(\)/.test(code(fs.readFileSync(f, "utf8"))), `${rel(f)} writes a document into a frame: that drops the listeners of the guard`);
}

// 4. the reader window shows its message through the same card, the attachment preview through guardFrame (which includes the handler)
ok(/MessageCard/.test(read("popout/ReaderView.tsx")), "the reader window uses MessageCard (the message frame above)");
ok(/guardFrame\(f, f\.contentDocument\)/.test(read("components/Attachments.tsx")), "the attachment preview frame is guarded");
const cg = read("contextGuard.ts");
const gf = cg.slice(cg.indexOf("export function guardFrame("));
ok(/const dropQuitKey = guardFrameQuitKey\(doc\)/.test(gf) && /dropQuitKey\(\);/.test(gf), "guardFrame installs and removes the Ctrl+Q handler");

// 5. the hidden scratch frame of the dark walk can never hold the focus
const dm = read("darkMail.ts");
const sc = dm.slice(dm.indexOf('document.createElement("iframe")'), dm.indexOf('document.createElement("iframe")') + 700);
ok(/tabIndex = -1/.test(sc) && /aria-hidden/.test(sc) && /pointer-events:none/.test(sc) && /visibility:hidden/.test(sc), "the scratch frame is hidden, unreachable by Tab and by the pointer");

console.log(`test-quit-key-frames: ok (${n} checks)`);
