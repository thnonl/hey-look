// 1.0.7 W13.3 (REQ-13.3.1): no text selection outside fields, the message and a few reference texts. The CSS is checked as text: `body` is `user-select: none` (with the -webkit- prefix WKWebView
// needs), and the only rules that say `user-select: text` are the allow list below (A fields, B the open message, C reference text); a new place that may be selected is a conscious change of
// this test. There is no `user-select: all`, and the confidential rule (none) comes after the message-body rule and covers its children. The behaviour in a browser is
// scripts/test-user-select-ui.mjs.
// Run: node --experimental-strip-types scripts/test-user-select.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "src/App.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// A. fields   B. the open message   C. reference text   (+ the two rules that were there before: the custom title bar's search field, handled as a field)
const ALLOW = [
  "input", "textarea", '[contenteditable="true"]', ".ProseMirror", ':root[data-frame="custom"] .topbar input',
  ".rp-head h2", ".rp-from", ".rp-to", ".rp-date", ".rp-msg-body", ".summary",
  "pre.original", ".pv-diag", ".sig-block", ".fpr", ".mono", ".selectable", ".toast.error .toast-text",
];

// every rule (selector list + body), in file order; @media blocks are flattened (their inner rules count)
const rules = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) rules.push({ selectors: m[1].split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean), body: m[2], at: m.index });

const says = (body, value) => new RegExp(`(^|[;\\s])(-webkit-)?user-select\\s*:\\s*${value}\\b`).test(body);

// 1. body: none, both spellings
{
  const r = rules.find((x) => x.selectors.length === 1 && x.selectors[0] === "body" && says(x.body, "none"));
  assert.ok(r, "a `body` rule with user-select: none");
  assert.ok(/(^|[;\s])user-select\s*:\s*none/.test(r.body) && /-webkit-user-select\s*:\s*none/.test(r.body), "body: both user-select and -webkit-user-select");
}

// 2. the allow list is the only place with `text`; both spellings are given together (an input under -webkit-user-select: none cannot be typed into on WKWebView)
const found = new Set();
for (const r of rules) {
  const std = /(^|[;\s])user-select\s*:\s*text\b/.test(r.body);
  const web = /-webkit-user-select\s*:\s*text\b/.test(r.body);
  if (!std && !web) continue;
  assert.ok(std && web, `${r.selectors.join(", ")}: user-select: text needs the -webkit- spelling too`);
  for (const s of r.selectors) {
    assert.ok(ALLOW.includes(s), `"${s}" says user-select: text but is not on the allow list (a new place that may be selected must be added to scripts/test-user-select.mjs on purpose)`);
    found.add(s);
  }
}
// the allow list is not a dead list: every group has its rule
for (const s of ["input", "textarea", '[contenteditable="true"]', ".ProseMirror", ".rp-head h2", ".rp-from", ".rp-to", ".rp-date", ".rp-msg-body", ".summary", "pre.original", ".fpr", ".mono", ".selectable", ".toast.error .toast-text", ".sig-block", ".pv-diag"]) {
  assert.ok(found.has(s), `${s} is on the allow list but has no user-select: text rule`);
}

// 3. no `user-select: all` anywhere (a click would select a whole block), no stylesheet but App.css says `text`
assert.ok(!/user-select\s*:\s*all\b/.test(css), "no user-select: all");
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const f of walk(path.join(root, "src")).filter((f) => /\.(css|tsx?)$/.test(f))) {
  const t = readFileSync(f, "utf8");
  if (!/\.css$/.test(f)) {
    assert.ok(!/userSelect\s*:\s*["']?(all|text)\b/.test(t) || /protect\.ts|Attachments\.tsx/.test(f), `${path.relative(root, f)}: inline userSelect other than none`);
    continue;
  }
  if (path.basename(f) === "pdfView.css") {
    // the PDF preview (W5.1): its text layer is the one text outside App.css that may be selected (the words of the page, drawn by PDF.js over the canvas); never `all`
    const stripped = t.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/user-select\s*:\s*all/.test(stripped), "pdfView.css: no user-select: all");
    const selectable = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /(^|[;\s])user-select\s*:\s*text\b/.test(m[2]));
    assert.ok(selectable.length > 0, "the PDF text layer can be selected");
    for (const m of selectable) {
      assert.ok(/-webkit-user-select\s*:\s*text\b/.test(m[2]), "pdfView.css: the -webkit- spelling too");
      assert.ok(m[1].split(",").every((x) => /^\s*\.pv-text-layer\b/.test(x)), `pdfView.css: only the text layer may say text (${m[1].trim()})`);
    }
    continue;
  }
  if (path.basename(f) !== "App.css") assert.ok(!/user-select\s*:\s*(text|all)/.test(t), `${path.relative(root, f)} says user-select: text/all`);
}

// 4. confidential mail: its `none` rule comes after the `.rp-msg-body` text rule and covers the children
{
  const text = rules.find((r) => r.selectors.includes(".rp-msg-body") && says(r.body, "text"));
  const conf = rules.find((r) => r.selectors.includes(".rp-msg-body.confidential *") && says(r.body, "none"));
  assert.ok(text && conf, "both rules exist");
  assert.ok(conf.at > text.at, "the confidential none rule comes after the message-body text rule");
  assert.ok(rules.some((r) => r.selectors.includes(".rp-msg-body.confidential") && says(r.body, "none")));
}

// 5. things that must stay selectable by an explicit mark: the About version line and the test-data line (`selectable`), the reader's header lines
const read = (p) => readFileSync(path.join(root, p), "utf8");
assert.ok((read("src/components/Updates.tsx").match(/<b className="selectable">\{t\("updates\.status\.version"/g) ?? []).length === 2, "the version line (both layouts) is .selectable");
assert.ok(/notice info selectable/.test(read("src/components/SettingsDialog.tsx")), "the test-data folder line is .selectable");
const rp = read("src/components/ReadingPane.tsx");
assert.ok(/rp-to/.test(rp) && /className="rp-from ellipsis"/.test(rp) && /rp-date/.test(rp), "the header lines carry the classes the allow list names");

// 6. a click that ends a selection in the header does not toggle the message (REQ-13.3.3), and "Select all" reaches the block under the pointer (REQ-13.3.4)
assert.ok(/headClickIsSelection\(e\)/.test(rp) && /head\.contains\(sel\.anchorNode\)/.test(rp) && /e\.detail >= 3/.test(rp), "the header click guard");
const policy = read("src/contextPolicy.ts");
for (const s of [".rp-head h2", ".rp-from", ".rp-to", ".rp-date", ".rp-msg-body"]) assert.ok(policy.includes(s), `SELECT_SCOPE names ${s}`);
assert.ok(policy.indexOf(".rp-from") < policy.indexOf("section, aside"), "the narrow scopes come before the wide ones");

console.log("test-user-select: ok");
