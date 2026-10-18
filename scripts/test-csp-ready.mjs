// BUG-12 / CF-16: the main webview's Content-Security-Policy (`app.security.csp` in src-tauri/tauri.conf.json, switched on in 1.0.6).
// This test keeps the policy honest: every directive is derived from a fact about the front-end code, and the facts are checked here, so
// nothing in the app can silently grow a need the policy does not cover (a fetch, a remote script or font, an asset: picture, a new iframe).
// A CSP is static: there is no runtime switch. `devCsp` stays unset (the dev server needs inline scripts and a websocket).
// Run: node scripts/test-csp-ready.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The policy for `app.security.csp`. Tauri sends it as a response header with the app's HTML (all platforms), see the notes under the directives. */
export const PROPOSED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' ipc: http://ipc.localhost",
  "frame-src blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const dir = Object.fromEntries(PROPOSED_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

// --- the app is loaded as module scripts from its own origin: no inline script, no inline handler, no remote script / stylesheet --------
const html = read("index.html");
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  assert.ok(/type="module"/.test(m[1]) && /\bsrc="\/src\//.test(m[1]) && m[2].trim() === "", `index.html has an inline or classic script: ${m[0]}`);
}
assert.ok(!/\son[a-z]+\s*=/i.test(html), "index.html has an inline event handler");
assert.ok(!/(src|href)="(https?:)?\/\//i.test(html), "index.html loads something from another origin");
assert.ok(dir["script-src"].join(" ") === "'self'", "no 'unsafe-inline' / 'unsafe-eval' for scripts");

// --- no source file evaluates strings, opens a socket, or fetches (the only channel to the backend is Tauri's invoke) ----------------
const files = [];
(function walk(d) {
  for (const n of readdirSync(new URL(d, root))) {
    const rel = `${d}${n}`;
    if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`);
    else if (/\.(ts|tsx)$/.test(n) && !/^dev[A-Z]/.test(n) && !/devMock/.test(n)) files.push(rel);
  }
})("src/");
assert.ok(files.length > 50);
const banned = [
  [/\beval\s*\(/, "eval("], [/\bnew Function\s*\(/, "new Function("], [/\bfetch\s*\(/, "fetch("], [/\bXMLHttpRequest\b/, "XMLHttpRequest"], [/\bnew WebSocket\b/, "WebSocket"],
  [/\bnew EventSource\b/, "EventSource"], [/\bnew (Shared)?Worker\b/, "Worker"], [/\bimportScripts\s*\(/, "importScripts"], [/\bsendBeacon\b/, "sendBeacon"], [/\bdocument\.write\s*\(/, "document.write"],
  [/setTimeout\(\s*["'`]/, "setTimeout(string)"], [/setInterval\(\s*["'`]/, "setInterval(string)"],
];
for (const f of files) {
  const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const [re, name] of banned) assert.ok(!re.test(src), `${f} uses ${name}: connect-src / script-src would need to change`);
}
const apis = new Set();
for (const f of files) for (const m of read(f).matchAll(/from "(@tauri-apps\/[^"]+)"/g)) apis.add(m[1]);
assert.deepEqual([...apis].sort(), ["@tauri-apps/api/app", "@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/plugin-opener"], "a new Tauri API: check what it needs (asset: / ipc:)");
assert.ok(!files.some((f) => /convertFileSrc|asset:\/\/|asset\.localhost/.test(read(f))), "the asset protocol is used: img-src needs asset: http://asset.localhost");
assert.ok(dir["connect-src"].includes("ipc:") && dir["connect-src"].includes("http://ipc.localhost"), "invoke() goes through ipc: (macOS, Linux) / http://ipc.localhost (Windows)");

// --- the message frame (srcdoc) inherits the policy of the page: it must allow what the frame's own policy allows --------------------------
const reading = read("src/components/ReadingPane.tsx");
const frameCsp = /frameCsp\(allowed \? "([^"]+)" : "([^"]+)"\)/.exec(reading);
assert.ok(frameCsp, "the message frame's CSP (ReadingPane.tsx) changed: update the proposal");
assert.ok(/img-src data: https: http:/.test(frameCsp[1]) && /style-src 'unsafe-inline'/.test(frameCsp[1]) && /font-src data:/.test(frameCsp[1]));
assert.ok(dir["img-src"].includes("https:") && dir["img-src"].includes("http:"), "Load content shows https: / http: pictures in the frame; an srcdoc frame inherits the page's img-src (checked in Chrome: no http: in the page = no picture)");
assert.ok(dir["style-src"].includes("'unsafe-inline'"), "the srcdoc frame carries an inline <style>; the page's style-src applies to it as well");
assert.ok(dir["font-src"].includes("data:"));
assert.ok(/srcDoc=\{srcDoc\}/.test(reading) && !/<iframe[^>]*src=\{/.test(reading), "the message frame is srcdoc only");

// --- the attachment preview: pictures as data: URIs, PDF in a blob: frame, text as text ---------------------------------------------
const att = read("src/components/Attachments.tsx");
// the blob is made in pdfFrame.ts (only bytes that start with %PDF-, always typed application/pdf) and the frame has no hard-coded sandbox:
// WebView2's PDF viewer does not run in a sandboxed frame (1.0.6 WP1b), so on Chromium the frame has none; scripts/test-pdf-frame.mjs pins the rest
const pdf = read("src/pdfFrame.ts");
assert.ok(/URL\.createObjectURL\(pdf\.blob\)/.test(att) && !/URL\.createObjectURL\(new Blob\(/.test(att), "PDF preview = blob: frame, the blob comes from pdfPreview()");
assert.ok(/new Blob\(\[bytes as BlobPart\], \{ type: "application\/pdf" \}\)/.test(pdf), "the PDF blob is typed application/pdf by the app");
assert.ok(/<iframe\s+title=\{name\}\s+src=\{url\}\s+sandbox=\{sandbox\}/.test(att) && /<PdfFrame key=\{data\.url\} url=\{data\.url\} sandbox=\{data\.sandbox\}/.test(att), "PDF preview = blob: frame");
assert.ok(dir["frame-src"].includes("blob:"), "the PDF preview is a blob: iframe (checked: frame-src without blob: is a violation)");
assert.ok(/setData\(\{ url: `data:\$\{d\.mime\};base64,/.test(att) && dir["img-src"].includes("data:"));
assert.equal((att.match(/<iframe\b/g) ?? []).length, 1, "a new iframe: check frame-src");
for (const f of files) if (f !== "src/components/Attachments.tsx" && f !== "src/components/ReadingPane.tsx") assert.ok(!/<iframe\b/.test(read(f)), `${f} has an iframe`);

// --- images of the UI itself --------------------------------------------------------------------------------------------------------
for (const f of files) assert.ok(!/<img[^>]+src=["']https?:/.test(read(f)), `${f} has a remote <img>`);
const css = read("src/App.css");
assert.ok(!/url\(\s*["']?(https?:)?\/\//.test(css) && !/@import/.test(css) && !/@font-face/.test(css), "App.css loads something remote (or has @font-face: font-src)");
assert.ok(!/url\(["']?data:(?!image\/svg)/.test(css), "App.css has a non-svg data: URL");

// --- directives that are there for defence only: the code must not need them either ------------------------------------------------------
assert.ok(dir["base-uri"].join(" ") === "'none'" && dir["form-action"].join(" ") === "'none'" && dir["object-src"].join(" ") === "'none'");
assert.equal(dir["frame-ancestors"].join(" "), "'none'", "nothing may frame the app (a header directive: Tauri sends the policy as a response header, a <meta> would ignore it)");
for (const f of files) assert.ok(!/<form\b/.test(read(f)), `${f} has a <form>: form-action 'none' would stop its submit`);
// the message frame carries `<base target="_blank">` (links open outside): a <base> without href is allowed under base-uri 'none'; one with href is not, and the sanitiser removes them
assert.ok(/<base target="_blank">/.test(reading) && !/<base [^>]*href/.test(reading), "the frame's <base> has no href");
assert.ok(/FORBID_TAGS: \[[^\]]*"base"/.test(read("src/util.ts")), "a mail's own <base href> is removed before it gets to the frame");
assert.ok(!/<embed[\s>/]/.test(files.map(read).join("\n")), "an <embed> in the UI: object-src 'none' blocks it");
// the one <object> is the PDF of the macOS / Linux experiment (HEYLOOK_PDF_INLINE=object), which runs under object-src blob: (pdfmode.rs)
for (const f of files) assert.ok(f === "src/components/Attachments.tsx" ? (read(f).match(/<object\b/g) ?? []).length === 1 : !/<object[\s>/]/.test(read(f)), `${f}: an <object> in the UI`);

// --- what Tauri does to the policy ---------------------------------------------------------------------------------------------------------
// Tauri 2 sends the configured policy as the `Content-Security-Policy` header of the app's HTML (every system) and, at build time, adds a
// nonce or a hash to `script-src` / `style-src` for every inline <script>, every inline <style> and every <script src="http...">
// of that HTML. A nonce or hash in a directive makes the browser IGNORE 'unsafe-inline' there: the message frame's <style> and the
// style attributes of the page would stop working. The HTML has none of those, so nothing is added (checked on the source and, when
// there is one, on the build), and the switch that would turn the modification off stays at its default.
const noInline = (name, text) => {
  assert.ok(!/<style\b/i.test(text), `${name} has an inline <style>: Tauri would put a nonce in style-src and 'unsafe-inline' would stop working`);
  assert.ok(!/<script\b(?![^>]*\bsrc=)/i.test(text), `${name} has an inline <script>`);
  assert.ok(!/<script\b[^>]*\bsrc="https?:/i.test(text), `${name} has a script from another origin`);
};
noInline("index.html", html);
if (existsSync(new URL("dist/index.html", root))) noInline("dist/index.html", read("dist/index.html"));

// --- the config -----------------------------------------------------------------------------------------------------------------------------
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
assert.equal(typeof conf.app.security.csp, "string", "the policy is on (BUG-12)");
assert.equal(conf.app.security.csp, PROPOSED_CSP, "tauri.conf.json csp differs from the policy checked here");
assert.ok(!("devCsp" in conf.app.security) && !("dev-csp" in conf.app.security), "devCsp stays unset: the dev server needs inline scripts and a websocket");
assert.ok(!("dangerousDisableAssetCspModification" in conf.app.security), "Tauri's own additions to the policy stay at their default");
const noUpdater = JSON.parse(read("src-tauri/tauri.no-updater.conf.json"));
assert.ok(!noUpdater.app?.security || noUpdater.app.security.csp === undefined, "the other config does not change the policy");
assert.ok(!existsSync(new URL("src/csp.json", root)));
// the policy is the configured one: no setting, no command, no switch of its own reads or changes it. The only run-time change is the PDF
// experiment of macOS / Linux (HEYLOOK_PDF_INLINE, pdfmode.rs): object-src 'none' becomes object-src blob:, nothing else, never on Windows
assert.ok(!/HEYLOOK_[A-Z_]*CSP|csp_off|disable_csp/i.test(read("src-tauri/src/lib.rs")), "no runtime switch for the policy");
assert.equal((read("src-tauri/src/lib.rs").match(/security\.csp/g) ?? []).length, 0, "lib.rs does not touch the policy itself");
assert.ok(/config\.app\.security\.csp/.test(read("src-tauri/src/pdfmode.rs")));

console.log("test-csp-ready: ok");
