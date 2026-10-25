// No browser autofill: the "Saved info" dropdown of WebView2 (Edge) must never open over the app's own panels (the search box showed
// `quarterly` / `has:attachment` over its Recent searches). Two layers keep it away: every text field of the page says autoComplete="off"
// (this test, so a new field cannot forget it), and the Windows web views have general autofill and password saving switched off
// (src-tauri/src/autofill.rs; its real-web-view check is the cargo test `a_real_web_view_has_its_autofill_off_after_switch_off`).
// Run: node scripts/test-no-autofill.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// types that never offer saved text: no autoComplete needed
const NOT_TEXT = new Set(["checkbox", "radio", "color", "file", "range", "button", "submit", "reset", "hidden", "image"]);
// the only tokens a field of this app may carry. "new-password" is for a passphrase the person is choosing now (no stored value is ever offered for it).
const TOKENS = new Set(["off", "new-password"]);

/** Source with the comments blanked out (same length, same line numbers), so `<input>` in a comment is not a field. A `//` that follows a `:` is a URL, not a comment. */
export function withoutComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\w"'`])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
}

/** End of the JSX tag whose attributes start at `i`: the first `>` outside braces and strings. */
function tagEnd(s, i) {
  let depth = 0, q = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

/** Every `<input>` / `<textarea>` of a source: { line, name, attrs (text of the tag) }. */
export function fields(src) {
  const s = withoutComments(src);
  const out = [];
  const re = /<(input|textarea)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = tagEnd(s, start);
    out.push({ line: s.slice(0, m.index).split("\n").length, name: m[1], attrs: s.slice(start, end < 0 ? s.length : end) });
  }
  return out;
}

const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|\\{([^}]*)\\})`).exec(attrs);
  return m ? (m[1] ?? m[2]).trim() : null;
};

/** The problems of one source, as readable lines. */
export function problems(file, src) {
  const bad = [];
  for (const f of fields(src)) {
    const where = `${file}:${f.line} <${f.name}>`;
    const type = attr(f.attrs, "type");
    if (/(?:^|\s)name=/.test(f.attrs)) bad.push(`${where}: has a name attribute (the browser keys its saved entries by name: a field called "email" / "search" gets suggestions)`);
    if (f.name === "input" && type && NOT_TEXT.has(type)) continue;
    const ac = attr(f.attrs, "autoComplete");
    if (ac === null) bad.push(`${where}: no autoComplete attribute (add autoComplete="off")`);
    else if (!TOKENS.has(ac.replace(/^"|"$/g, ""))) bad.push(`${where}: autoComplete=${ac} (only "off" or "new-password": the app keeps its passwords in the system credential store, not in the browser's)`);
  }
  return bad;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

// the checker itself: it must catch what it is for
{
  const ok = `const a = <input autoComplete="off" value={v} />; const b = <textarea autoComplete="off" />; const c = <input type="checkbox" checked />;`;
  assert.deepEqual(problems("x.tsx", ok), []);
  assert.equal(problems("x.tsx", `<input value={v} />`).length, 1, "a text field without autoComplete");
  assert.equal(problems("x.tsx", `<textarea rows={2}\n  value={v}\n/>`).length, 1, "a textarea without autoComplete, over several lines");
  assert.equal(problems("x.tsx", `<input type={kind} onChange={() => 1} />`).length, 1, "a dynamic type counts as text");
  assert.equal(problems("x.tsx", `<input type="password" autoComplete="on" />`).length, 1, "autoComplete on");
  assert.equal(problems("x.tsx", `<input type="password" autoComplete="current-password" />`).length, 1, "a password token that asks for stored passwords");
  assert.equal(problems("x.tsx", `<input type="password" autoComplete="new-password" />`).length, 0, "a new passphrase");
  assert.equal(problems("x.tsx", `<input autoComplete="off" name="email" />`).length, 1, "a name attribute");
  assert.equal(problems("x.tsx", `// an <input> in a comment\n/* <textarea> */\n<input autoComplete="off" placeholder="https://x.example" />`).length, 0, "comments and URLs");
  assert.equal(problems("x.tsx", `<input onChange={(e) => (set(e.target.value), touch())} autoComplete="off" />`).length, 0, "braces in handlers");
  assert.equal(problems("x.tsx", `<input onChange={(e) => (set(e.target.value), touch())} />`).length, 1, "braces in handlers, no autoComplete");
}

const files = walk(join(ROOT, "src"));
assert.ok(files.length > 20, "found the sources");
let count = 0;
const all = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  count += fields(src).length;
  all.push(...problems(relative(ROOT, f).replace(/\\/g, "/"), src));
}
assert.ok(count > 60, `found the fields (${count})`);
assert.deepEqual(all, [], `\n${all.join("\n")}\n`);

// the search box: the one field that has a suggestion panel of its own
{
  const src = readFileSync(join(ROOT, "src/components/SearchBox.tsx"), "utf8");
  const f = fields(src).find((x) => attr(x.attrs, "id") === '"search-input"' || /id="search-input"/.test(x.attrs));
  assert.ok(f, "the search input");
  assert.equal(attr(f.attrs, "autoComplete"), "off");
  assert.equal(attr(f.attrs, "autoCorrect"), "off");
  assert.equal(attr(f.attrs, "autoCapitalize"), "off");
  assert.equal(attr(f.attrs, "spellCheck"), "false");
  assert.ok(!/(?:^|\s)type="(search|email)"/.test(f.attrs), "a plain text field: type=search/email invite the browser's own history");
}

// the backend half: the switches and the hook are in the sources of the Windows build (the cargo test reads them back from a real web view)
{
  const rs = readFileSync(join(ROOT, "src-tauri/src/autofill.rs"), "utf8");
  assert.ok(/SetIsGeneralAutofillEnabled\(false\)/.test(rs) && /SetIsPasswordAutosaveEnabled\(false\)/.test(rs), "autofill.rs switches both off");
  assert.ok(/on_webview_ready/.test(rs), "autofill.rs hooks every web view when it is made");
  const lib = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert.ok(/\.plugin\(autofill::plugin\(\)\)/.test(lib), "lib.rs registers the plugin");
}

console.log(`ok: ${count} fields in ${files.length} files carry autoComplete (or are not text)`);
