// BUG-12 / CF-16: the main webview has no Content-Security-Policy (`"csp": null` in src-tauri/tauri.conf.json). Turning one on is not
// provable without a real Tauri window (the IPC channel, the nonces Tauri adds, WKWebView), so the config is NOT changed yet. This test
// keeps the PROPOSED policy honest: every directive is derived from a fact about the front-end code, and the facts are checked here, so
// the day the policy is switched on nothing in the app has silently grown a need the policy does not cover.
// Run: node scripts/test-csp-ready.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The proposed policy for `app.security.csp` (and `devCsp` stays null: the dev server needs inline scripts and a websocket). */
export const PROPOSED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' ipc: http://ipc.localhost",
  "frame-src blob: data: about:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
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
assert.ok(/URL\.createObjectURL\(new Blob\(/.test(att) && /<iframe title=\{cur\.name\} src=\{data\.url\}/.test(att), "PDF preview = blob: frame");
assert.ok(dir["frame-src"].includes("blob:"), "the PDF preview is a blob: iframe (checked: frame-src without blob: is a violation)");
assert.ok(/setData\(\{ url: `data:\$\{d\.mime\};base64,/.test(att) && dir["img-src"].includes("data:"));
assert.equal((att.match(/<iframe\b/g) ?? []).length, 1, "a new iframe: check frame-src");
for (const f of files) if (f !== "src/components/Attachments.tsx" && f !== "src/components/ReadingPane.tsx") assert.ok(!/<iframe\b/.test(read(f)), `${f} has an iframe`);

// --- images of the UI itself --------------------------------------------------------------------------------------------------------
for (const f of files) assert.ok(!/<img[^>]+src=["']https?:/.test(read(f)), `${f} has a remote <img>`);
const css = read("src/App.css");
assert.ok(!/url\(\s*["']?(https?:)?\/\//.test(css) && !/@import/.test(css) && !/@font-face/.test(css), "App.css loads something remote (or has @font-face: font-src)");
assert.ok(!/url\(["']?data:(?!image\/svg)/.test(css), "App.css has a non-svg data: URL");

// --- the config today, and what a future switch has to do -------------------------------------------------------------------------------
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
assert.ok(conf.app.security.csp === null || typeof conf.app.security.csp === "string");
if (typeof conf.app.security.csp === "string") assert.equal(conf.app.security.csp, PROPOSED_CSP, "tauri.conf.json csp differs from the proposal checked here");
assert.ok(!existsSync(new URL("src/csp.json", root)));

console.log("test-csp-ready: ok");
