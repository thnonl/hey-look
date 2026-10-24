#!/usr/bin/env node
// 1.0.7 W5.1 (REQ-5.1.10, AC-5.1.10): PDF.js with the options of src/pdfView.tsx under the SHIPPED content security policy (tauri.conf.json, as the header of every response, the worker's and the
// asset files' too), in a real browser. The dev preview cannot show this (its page needs inline scripts and a socket, so it runs without the policy); this page is only the library, the same
// options, the same asset files (scripts/vite-pdfjs-assets.mjs) and the same worker address scheme, served by a small server that sends the policy:
//   - a one-page PDF with Helvetica (standard font files), a CJK one (cMaps), one with JavaScript (nothing runs), 30 pages: page 1 is drawn on a canvas, the text layer has text
//   - not one `securitypolicyviolation` on the page, not one "Refused to ..." line in the console (the log of the worker's violations too): no eval, no WebAssembly, no blob worker, no inline script
//   - the worker is a real module worker (not the fake one on the page's own thread)
//   node scripts/test-pdf-csp.mjs [--require-browser]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assetList } from './vite-pdfjs-assets.mjs';
import { findChrome, flag, launchChrome, sleep } from './cdp-harness.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
const skip = (why) => { if (flag('require-browser')) { console.error(`test-pdf-csp: ${why}`); process.exit(1); } console.log(`test-pdf-csp: SKIPPED, ${why} (pass --require-browser to fail instead)`); process.exit(0); };
const chrome = findChrome();
if (!chrome) skip('no Chrome / Chromium / Edge found');

// ---- the page: the library and the options of the viewer, nothing else
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-pdfcsp-'));
const entry = path.join(work, 'entry.js');
const lib = path.join(root, 'node_modules/pdfjs-dist/build/pdf.mjs').replace(/\\/g, '/');
fs.writeFileSync(entry, `
import * as pdfjs from ${JSON.stringify(lib)};
const asset = (p) => new URL('pdfjs/' + p, document.baseURI).href;
window.__violations = [];
window.__evalBlocked = (() => { try { new Function('return 1'); return false; } catch { return true; } })(); // (proves that the policy is in force here: no eval)
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.effectiveDirective + ' ' + e.blockedURI));
window.__run = async (url, scale = 1) => {
  pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');
  const worker = window.__worker ??= new pdfjs.PDFWorker({});
  const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const task = pdfjs.getDocument({ data, worker, enableXfa: false, cMapUrl: asset('cmaps/'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts/'), wasmUrl: asset('wasm/'), iccUrl: asset('iccs/'), useWasm: false, useWorkerFetch: false, verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  document.body.appendChild(canvas);
  await page.render({ canvas, viewport: vp }).promise;
  const text = document.createElement('div');
  text.className = 'pv-text-layer';
  text.style.setProperty('--total-scale-factor', String(scale));
  document.body.appendChild(text);
  await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render();
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let nonWhite = 0;
  for (let k = 0; k < d.length; k += 4) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) nonWhite++;
  const out = { pages: doc.numPages, nonWhite, text: text.innerText, module: worker.port instanceof Worker };
  canvas.remove(); text.remove();
  await task.destroy();
  return out;
};
window.__ready = true;
`);
await build({ configFile: false, root: work, logLevel: 'silent', build: { outDir: path.join(work, 'out'), emptyOutDir: true, lib: { entry, formats: ['es'], fileName: 'entry' }, minify: false } });
const bundle = fs.readFileSync(path.join(work, 'out/entry.mjs'));

// ---- the server: every response carries the shipped policy
const files = new Map(assetList().map((a) => [`/${a.url}`, a.file]));
const fixtures = path.join(root, 'scripts/fixtures/pdf');
const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const send = (type, body, status = 200) => { res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }); res.end(body); };
  if (url === '/') return send('text/html', '<!doctype html><meta charset="utf-8"><title>pdf csp</title><script type="module" src="/entry.js"></script>');
  if (url === '/entry.js') return send('text/javascript', bundle);
  if (url.startsWith('/fx/')) { const f = path.join(fixtures, path.basename(url)); return fs.existsSync(f) ? send('application/pdf', fs.readFileSync(f)) : send('text/plain', 'no', 404); }
  const f = files.get(url);
  if (!f) return send('text/plain', 'no', 404);
  const ext = path.extname(f);
  return send(ext === '.mjs' || ext === '.js' ? 'text/javascript' : 'application/octet-stream', fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const ch = await launchChrome(chrome, 'hl-pdfcsp-');
if (!ch) { server.close(); skip('the browser did not start'); }
const ws = new WebSocket(ch.wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1; const waiting = new Map(); const console_ = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { const { ok, bad } = waiting.get(m.id); waiting.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console_.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) console_.push(`log ${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  if (m.method === 'Runtime.exceptionThrown') console_.push(`exception: ${JSON.stringify(m.params.exceptionDetails).slice(0, 300)}`);
};
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const id = nextId++; waiting.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const failures = [];
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (m, p) => send(m, p, sessionId);
  // the worker's own console and violations arrive as separate targets: attach to them too
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url: base });
  const evaluate = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  for (let i = 0; i < 100 && !(await evaluate('window.__ready === true').catch(() => false)); i++) await sleep(100);
  assert.equal(await evaluate('window.__ready === true'), true, 'the page did not start under the policy (a script was refused?)');
  assert.equal(await evaluate('window.__evalBlocked'), true, 'the policy is not in force on this page');
  await sleep(200);
  await evaluate('window.__violations.length = 0'); // (the probe above made the one violation that is expected)
  const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };

  await check('a one-page PDF with Helvetica: drawn, text layer, a module worker', async () => {
    const r = await evaluate(`window.__run('/fx/one-page.pdf')`);
    assert.equal(r.pages, 1);
    assert.ok(r.nonWhite > 3000, `non-white pixels: ${r.nonWhite}`);
    assert.ok(/Hey Look one page 1 of 1/.test(r.text), r.text);
    assert.equal(r.module, true, 'the worker is the fake one on the page thread');
  });
  await check('Chinese and Japanese text without embedded fonts (cMaps from the same origin)', async () => {
    const r = await evaluate(`window.__run('/fx/cjk.pdf')`);
    assert.ok(r.text.includes('你好') && r.text.includes('こんにちは'), r.text);
  });
  await check('a PDF with JavaScript: drawn, nothing runs', async () => {
    const r = await evaluate(`window.__run('/fx/scripting.pdf')`);
    assert.equal(r.pages, 1);
  });
  await check('30 pages: page 1 at 200 %', async () => {
    const r = await evaluate(`window.__run('/fx/thirty-pages.pdf', 2)`);
    assert.equal(r.pages, 30);
    assert.ok(r.nonWhite > 20000, `${r.nonWhite}`);
  });
  await sleep(500);
  const violations = await evaluate('window.__violations');
  if (violations.length) failures.push(`security policy violations on the page: ${violations.join(' | ')}`);
  const refused = console_.filter((l) => /Refused to|Content Security Policy|violat/i.test(l));
  if (refused.length) failures.push(`the browser refused something: ${refused.slice(0, 5).join(' | ')}`);
} finally {
  try { ws.close(); } catch { /* closed */ }
  await ch.stop();
  server.close();
}
if (failures.length) { console.error(`test-pdf-csp: ${failures.length} failure(s)\n - ${failures.join('\n - ')}\nconsole: ${console_.slice(0, 8).join('\n  ')}`); process.exit(1); }
console.log('test-pdf-csp: ok');
process.exit(0);
