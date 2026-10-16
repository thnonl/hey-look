#!/usr/bin/env node
// Renders the website's Appearance customiser ("Make it yours", docs/index.html and its 7 translations) in a headless Chrome and measures
// the live preview for every combination of the controls that change its layout. No dependencies; the browser is started with a
// throw-away profile and talks over the DevTools protocol (Node 22+, global WebSocket). Run:
//
//   node scripts/test-site-appearance.mjs                       all 8 languages x 5 widths x every layout combination (about 2 minutes)
//   node scripts/test-site-appearance.mjs --quick               a sample of the combinations (what CI runs, about 20 seconds)
//   node scripts/test-site-appearance.mjs --lang=en,de --width=375,1280 --font=Verdana   (a wider font than the site's, to stress the layout)
//   node scripts/test-site-appearance.mjs --shots=<dir>         also writes PNGs of the key combinations (en, de, ja, ru)
//   node scripts/test-site-appearance.mjs --require-browser     fail (instead of skipping) when no Chrome/Chromium/Edge is installed
//   CHROME_PATH=/path/to/chrome overrides the browser lookup.
//
// For each page (language x width) and each combination of Density x Reading pane x Text size x the four Message-list options, plus a
// Theme x Primary colour (and custom colour) sweep, it asserts: no two message rows overlap; no row is shorter than its own content
// (nothing is cut); the list rows keep their natural height (they scroll, they are never squeezed); the reading area is visible below
// or beside the list and shows the subject; no horizontal overflow of the page, the window or any row; the console stays clean. A second
// pass runs with prefers-reduced-motion. The page's own transitions are switched off while measuring (a half-finished transition would
// only measure the animation); the reduced-motion pass keeps the site's real CSS, which must still settle to the same layout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = (name) => process.argv.includes(`--${name}`);
const ALL_LANGS = ['en', 'vi', 'fr', 'zh', 'es', 'ja', 'de', 'ru'];
const LANGS = (arg('lang') || ALL_LANGS.join(',')).split(',');
const WIDTHS = (arg('width') || '375,768,1024,1280,1920').split(',').map(Number);
const QUICK = flag('quick');
const SHOTS = arg('shots');
const FONT = arg('font'); // e.g. --font=Verdana: stress the layout with a wider font than the site's own (the CI machine has other fonts than a Windows PC)

// ---------- the browser ----------
function findChrome() {
  const env = process.env.CHROME_PATH; if (env && fs.existsSync(env)) return env;
  const win = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map((k) => process.env[k]).filter(Boolean);
  const cands = [
    ...win.map((b) => path.join(b, 'Google/Chrome/Application/chrome.exe')),
    ...win.map((b) => path.join(b, 'Chromium/Application/chrome.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}
const chrome = findChrome();
if (!chrome) {
  if (flag('require-browser')) { console.error('test-site-appearance: no Chrome/Chromium found (set CHROME_PATH)'); process.exit(1); }
  console.log('test-site-appearance: SKIPPED, no Chrome/Chromium found (set CHROME_PATH, or pass --require-browser to fail instead)'); process.exit(0);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webp': 'image/webp', '.mp4': 'video/mp4', '.xml': 'application/xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(DOCS, p);
  if (!f.startsWith(DOCS) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const freePort = async () => { for (let p = 9400; p < 9500; p++) { const ok = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); }); if (ok) return p; } throw new Error('no free port in 9400-9499'); };
const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-appearance-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
let closed = false;
async function shutdown() {
  if (closed) return; closed = true;
  try { server.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the profile is in the temp folder anyway */ }
}
process.on('exit', () => { try { proc.kill(); } catch { /* ignore */ } });

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await new Promise((r) => setTimeout(r, 150)); } }
if (!wsUrl) { await shutdown(); console.error('test-site-appearance: Chrome did not start'); process.exit(1); }
const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1; const waiting = new Map(), listeners = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { ok, bad } = waiting.get(m.id); waiting.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); } else listeners.forEach((l) => l(m)); };
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const id = nextId++; waiting.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
const evaluate = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };

let consoleProblems = [];
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') consoleProblems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) consoleProblems.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) consoleProblems.push(`log ${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
});
await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');

// ---------- the page-side measurement ----------
const PAGE_FN = `(() => {
  const form = document.getElementById('mk-form'), app = document.querySelector('.mk-view .app'), color = document.getElementById('mk-color');
  const set = (name, value) => { const el = [...form.elements[name]].find((e) => e.value === String(value)); el.checked = true; };
  const tick = (name, on) => { form.elements[name].checked = !!on; };
  const fire = () => form.dispatchEvent(new Event('change', { bubbles: true }));
  const R = (el) => el.getBoundingClientRect();
  const measure = () => {
    const bad = [];
    const rows = [...app.querySelectorAll('.a-row')].filter((r) => !r.classList.contains('out') && R(r).height > 0);
    const list = app.querySelector('.a-rows'), read = app.querySelector('.a-read'), ar = R(app), lr = R(list), rr = R(read);
    if (rows.length < 5) bad.push('only ' + rows.length + ' rows rendered');
    const sorted = rows.map((r) => ({ r, b: R(r) })).sort((x, y) => x.b.top - y.b.top);
    sorted.forEach(({ r, b }, i) => {
      const name = r.querySelector('.a-from b')?.textContent;
      if (i && b.top < sorted[i - 1].b.bottom - 0.5) bad.push('rows overlap: "' + sorted[i - 1].r.querySelector('.a-from b')?.textContent + '" and "' + name + '" by ' + (sorted[i - 1].b.bottom - b.top).toFixed(1) + 'px');
      if (r.scrollHeight > r.clientHeight + 1) bad.push('row "' + name + '" is cut: content ' + r.scrollHeight + 'px in a ' + r.clientHeight + 'px row');
      const own = [...r.querySelectorAll('.a-from, .a-subj, .a-prev, .a-av')].filter((e) => R(e).height > 0);
      const need = own.length ? Math.max(...own.map((e) => R(e).bottom)) - Math.min(...own.map((e) => R(e).top)) : 0;
      if (b.height < need - 0.5) bad.push('row "' + name + '" is ' + b.height.toFixed(1) + 'px high but its content needs ' + need.toFixed(1) + 'px');
      if (r.scrollWidth > r.clientWidth + 1) bad.push('row "' + name + '" overflows sideways (' + r.scrollWidth + ' > ' + r.clientWidth + ')');
    });
    // the list starts at its first row (a reversed flex would open scrolled to the end), and oldest-on-top really lists the oldest first
    if (Math.abs(sorted[0].b.top - lr.top) > 2) bad.push('the list does not start at its first row (first row top ' + sorted[0].b.top.toFixed(0) + ', list top ' + lr.top.toFixed(0) + ')');
    const first = sorted[0].r.querySelector('.a-av')?.textContent, want = app.getAttribute('data-oldest') === 'on' ? 'MP' : 'LT';
    if (first !== want) bad.push('the first row is "' + first + '", expected "' + want + '"');
    // every row keeps its natural height: the list scrolls instead of squeezing them
    const hs = sorted.map(({ b }) => b.height), hmax = Math.max(...hs), hmin = Math.min(...hs);
    if (hmax - hmin > 14) bad.push('rows differ in height by ' + (hmax - hmin).toFixed(1) + 'px (' + hs.map((h) => h.toFixed(0)).join(',') + '): some are squeezed');
    const natural = Math.max(...rows.map((r) => r.scrollHeight));
    if (hmin < natural - 14) bad.push('a row is ' + hmin.toFixed(1) + 'px high, the tallest content is ' + natural + 'px');
    // the list scrolls (or fits), the reading area is shown
    if (lr.height < 60) bad.push('the list area is only ' + lr.height.toFixed(0) + 'px high');
    const pane = app.getAttribute('data-pane');
    if (rr.height < 90 || rr.width < 120) bad.push('the reading area is ' + rr.width.toFixed(0) + 'x' + rr.height.toFixed(0) + 'px');
    if (pane === 'bottom' && rr.top < lr.bottom - 1) bad.push('bottom pane: the reading area starts at ' + rr.top.toFixed(0) + ' above the list end ' + lr.bottom.toFixed(0));
    // the reading area opens with the toolbar and the start of the subject in view (a long message scrolls, so the rest may be below)
    for (const sel of ['.r-tools', '.r-subj']) { const e = read.querySelector(sel); if (e) { const b = R(e); if (b.top < rr.top - 0.5 || b.top > rr.bottom - 16) bad.push(sel + ' of the reading area starts at ' + b.top.toFixed(0) + ', outside the visible ' + rr.top.toFixed(0) + '-' + rr.bottom.toFixed(0)); if (b.right > rr.right + 0.5) bad.push(sel + ' sticks out on the right'); }}
    if (read.scrollWidth > read.clientWidth + 1) bad.push('the reading area overflows sideways');
    if (list.scrollWidth > list.clientWidth + 1) bad.push('the list overflows sideways');
    // the folder column keeps its unread badge whole and is not cut at the bottom; a long label may end in an ellipsis (a warning, not a failure, when under three quarters of it shows: it depends on the machine's fonts)
    if (R(app.querySelector('.a-folders')).width > 0) for (const e of app.querySelectorAll('.a-f > span')) { if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth < e.scrollWidth * 0.75) { bad.push('WARN folder label "' + e.textContent + '" is mostly cut (' + e.clientWidth + ' of ' + e.scrollWidth + 'px shown)'); break; } }
    { const fo = app.querySelector('.a-folders'); if (R(fo).width > 0 && fo.scrollHeight > fo.clientHeight + 1) bad.push('the folder column is cut at the bottom (' + fo.scrollHeight + ' > ' + fo.clientHeight + ')'); const ac = app.querySelector('.a-acct span'); if (ac && ac.scrollWidth > ac.clientWidth + 1) bad.push('the "all mailboxes" label sticks out'); }
    for (const e of app.querySelectorAll('.a-f b:not(.zero)')) { const b = R(e), f = R(e.parentElement); if (b.right > f.right + 1) { bad.push('the unread badge is cut off'); break; } }
    // whole window and page
    if (app.scrollWidth > app.clientWidth + 1) bad.push('the window overflows sideways (' + app.scrollWidth + ' > ' + app.clientWidth + ')');
    const de = document.documentElement; if (de.scrollWidth > de.clientWidth + 1) bad.push('the page scrolls sideways (' + de.scrollWidth + ' > ' + de.clientWidth + ')');
    for (const e of app.querySelectorAll('.a-top *, .a-body, .a-list, .a-tabs')) { const b = R(e); if (b.width && (b.right > ar.right + 1 || b.left < ar.left - 1)) { bad.push('<' + e.tagName.toLowerCase() + ' class="' + e.className + '"> sticks out of the window'); break; } }
    return bad;
  };
  return { form, app, color, set, tick, fire, measure, R };
})`;
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__mk = ${PAGE_FN}; window.__font = ${JSON.stringify(FONT)}; window.__noMotion = () => { const sh = new CSSStyleSheet(); sh.replaceSync('*,*::before,*::after{transition:none!important;animation:none!important}' + (window.__font ? '.mk-view .app{font-family:' + window.__font + '!important}' : '')); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; }; /* a constructed sheet: the page's CSP blocks an inline <style> */` });

const VAL = { density: ['full', 'medium', 'compact'], pane: ['right', 'bottom'], fs: [12, 13, 14, 15, 16, 18] };
function layoutCombos() {
  const out = [];
  const lists = QUICK ? [[1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 1, 1], [0, 1, 0, 1]] : Array.from({ length: 16 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1, (i >> 3) & 1]);
  for (const density of VAL.density) for (const pane of VAL.pane) for (const fs of (QUICK ? [12, 14, 18] : VAL.fs)) for (const l of lists) out.push({ density, pane, fs, preview: l[0], conv: l[1], focused: l[2], oldest: l[3] });
  return out;
}
const COMBOS = layoutCombos();
const ACCENTS = ['#0f6cbd', '#0e7c86', '#1a7f4b', '#6d4aff', '#c2327d', '#c4570c', '#475569', 'custom'];
const CUSTOM = ['#ff00aa', '#ffff00', '#000000', '#ffffff'];

const failures = []; let checked = 0, pages = 0; const t0 = Date.now();
const warnings = new Map();
const fail = (page, combo, msg) => { if (failures.length < 60) failures.push(`${page}  ${combo}\n      ${msg}`); else if (failures.length === 60) failures.push('... more failures not listed'); };
function report(tag, combo, bad) {
  const hard = bad.filter((b) => !b.startsWith('WARN '));
  for (const w of bad.filter((b) => b.startsWith('WARN '))) { const k = w.slice(5).replace(/\(.*\)/, ''); warnings.set(k, (warnings.get(k) || 0) + 1); }
  if (hard.length) fail(tag, combo, hard.join('\n      '));
}
const name = (c) => Object.entries(c).map(([k, v]) => `${k}=${typeof v === 'number' && !['fs'].includes(k) ? (v ? 'on' : 'off') : v}`).join(' ');

async function loadPage(lang, width, reduced, dark) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: width <= 768 ? 900 : 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }, { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  consoleProblems = [];
  await cdp('Page.navigate', { url: `${base}/${lang === 'en' ? '' : lang + '/'}index.html` });
  for (let i = 0; i < 200; i++) { if (await evaluate(`document.readyState === 'complete' && !!document.getElementById('mk-form') && !!window.__mk`).catch(() => false)) break; await new Promise((r) => setTimeout(r, 50)); }
  await evaluate(`new Promise((r) => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(r, 150)))`);
  await evaluate(`document.getElementById('make-it-yours').scrollIntoView({block:'start'})`);
  if (!reduced) await evaluate('window.__noMotion()');
  await evaluate(`window.__ctx = window.__mk()`);
}

async function runPage(lang, width, { reduced = false, dark = false } = {}) {
  await loadPage(lang, width, reduced, dark);
  const tag = `${lang} ${width}px${reduced ? ' reduced-motion' : ''}${dark ? ' dark' : ''}`;
  pages++;
  const combos = reduced ? COMBOS.filter((_, i) => i % 29 === 0) : COMBOS;
  // all layout combinations in one round trip (a few thousand; measuring is cheap), in slices so one call stays short
  for (let from = 0; from < combos.length; from += 200) {
    const slice = combos.slice(from, from + 200);
    const res = await evaluate(`(async () => { const { form, set, tick, fire, measure } = window.__ctx; const out = [];
      for (const c of ${JSON.stringify(slice)}) { set('density', c.density); set('pane', c.pane); set('fs', c.fs); tick('preview', c.preview); tick('conv', c.conv); tick('focused', c.focused); tick('oldest', c.oldest); fire();
        if (${reduced}) await new Promise((r) => setTimeout(r, 450));
        const bad = measure(); if (bad.length) out.push([c, bad.slice(0, 3)]); }
      return out; })()`);
    checked += slice.length;
    for (const [c, bad] of res) report(tag, name(c), bad);
  }
  // theme x primary colour: the colours never change the layout, but they must not break it (nor throw)
  const sweep = await evaluate(`(async () => { const { form, color, set, tick, fire, measure } = window.__ctx; const out = [];
    for (const k of ['density', 'pane', 'fs']) set(k, k === 'density' ? 'full' : k === 'pane' ? 'bottom' : 14);
    for (const k of ['preview', 'conv', 'focused']) tick(k, 1); tick('oldest', 0);
    let n = 0;
    for (const theme of ['light', 'dark', 'system']) for (const acc of ${JSON.stringify(ACCENTS)}) for (const cc of (acc === 'custom' ? ${JSON.stringify(CUSTOM)} : [null])) {
      set('theme', theme); set('accent', acc); if (cc) { color.value = cc; color.dispatchEvent(new Event('input', { bubbles: true })); } else fire();
      n++; const bad = measure(); if (bad.length) out.push([theme + ' ' + acc + ' ' + (cc || ''), bad.slice(0, 3)]);
      const app = document.querySelector('.mk-view .app'); const top = getComputedStyle(app.querySelector('.a-top')).backgroundImage; if (!top || top === 'none') out.push([theme + ' ' + acc, ['the title bar has no background']]); }
    set('theme', 'system'); set('accent', '#0f6cbd'); fire(); return { out, n }; })()`);
  checked += sweep.n; for (const [c, bad] of sweep.out) report(tag, c, bad);
  if (consoleProblems.length) fail(tag, 'console', [...new Set(consoleProblems)].slice(0, 5).join('\n      '));
}

// the pages that carry the advantages (free, no account, no ads): the page never scrolls sideways and the hero chips stay inside their column
async function scanPages() {
  for (const lang of LANGS) for (const width of (QUICK ? [375, 1280] : WIDTHS)) for (const page of ['index', 'download', 'features']) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    consoleProblems = [];
    await cdp('Page.navigate', { url: `${base}/${lang === 'en' ? '' : lang + '/'}${page}.html` });
    for (let i = 0; i < 200; i++) { if (await evaluate("document.readyState === 'complete'").catch(() => false)) break; await new Promise((r) => setTimeout(r, 50)); }
    await evaluate('new Promise((r) => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(r, 100)))');
    const bad = await evaluate(`(() => { const out = [], de = document.documentElement; if (de.scrollWidth > de.clientWidth + 1) out.push('the page scrolls sideways (' + de.scrollWidth + ' > ' + de.clientWidth + ')');
      const meta = document.querySelector('.hero-meta'); if (meta) { const mr = meta.getBoundingClientRect(); for (const c of meta.children) { const r = c.getBoundingClientRect(); if (r.right > mr.right + 1 || r.left < mr.left - 1) out.push('hero chip "' + c.textContent + '" sticks out'); } }
      const lead = document.querySelector('.page-head .lead'); if (lead && lead.scrollWidth > lead.clientWidth + 1) out.push('the lead sticks out');
      for (const t of document.querySelectorAll('.cmp-wrap')) { /* the table scrolls inside its own box on a phone: that is fine */ }
      return out; })()`);
    pages++; checked++;
    const where = `${lang} ${width}px ${page}.html`;
    if (SHOTS && page === 'index' && ['en', 'de', 'ja', 'ru'].includes(lang) && (width === 375 || width === 1280)) {
      for (const [label, sel] of [['hero', '.hero-copy'], ['free-table-end', '.cmp tbody tr:last-child']]) {
        const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left + scrollX - 8), y: r.top + scrollY - 8, width: Math.min(r.width + 16, innerWidth), height: r.height + 16 }; })()`);
        if (!box) continue; fs.mkdirSync(SHOTS, { recursive: true });
        const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
        fs.writeFileSync(path.join(SHOTS, `${lang}-${width}-${label}.png`), Buffer.from(data, 'base64'));
      }
    }
    if (bad.length) fail(where, 'page', bad.join('\n      '));
    if (consoleProblems.length) fail(where, 'console', [...new Set(consoleProblems)].slice(0, 5).join('\n      '));
  }
}

async function shots() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const KEY = [
    ['full-right', { density: 'full', pane: 'right', fs: 14 }], ['full-bottom', { density: 'full', pane: 'bottom', fs: 14 }],
    ['medium-bottom-18px', { density: 'medium', pane: 'bottom', fs: 18 }], ['compact-bottom-12px', { density: 'compact', pane: 'bottom', fs: 12 }],
    ['full-bottom-nopreview-oldest-dark', { density: 'full', pane: 'bottom', fs: 15, preview: 0, oldest: 1, theme: 'dark', accent: '#c2327d' }],
  ];
  for (const lang of ['en', 'de', 'ja', 'ru']) for (const width of [375, 1280]) {
    await loadPage(lang, width, false, false);
    for (const [label, c] of KEY) {
      await evaluate(`(() => { const { set, tick, fire } = window.__ctx; const c = ${JSON.stringify(c)}; set('density', c.density); set('pane', c.pane); set('fs', c.fs); tick('preview', c.preview ?? 1); tick('conv', 1); tick('focused', 1); tick('oldest', c.oldest ?? 0); set('theme', c.theme || 'light'); set('accent', c.accent || '#0f6cbd'); fire(); const v = document.querySelector('.mk-view'); v.scrollIntoView({ block: 'start' }); })()`);
      await new Promise((r) => setTimeout(r, 150));
      const box = await evaluate(`(() => { const r = document.querySelector('.mk-view .app').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
      fs.writeFileSync(path.join(SHOTS, `${lang}-${width}-${label}.png`), Buffer.from(data, 'base64'));
    }
  }
}

try {
  for (const lang of LANGS) for (const width of WIDTHS) await runPage(lang, width);
  for (const lang of (QUICK ? ['en'] : LANGS)) await runPage(lang, 375, { reduced: true });
  await runPage('en', 1280, { reduced: true, dark: true });
  await runPage('en', 1280, { dark: true });
  await scanPages();
  if (SHOTS) await shots();
} finally { await shutdown(); }

const secs = ((Date.now() - t0) / 1000).toFixed(0);
for (const [w, n] of warnings) console.log(`  note: ${w}in ${n} combinations (ends in an ellipsis; allowed)`);
if (failures.length) { console.error(`test-site-appearance: FAILED (${checked} combinations on ${pages} pages, ${secs}s)\n\n  ` + failures.join('\n  ')); process.exit(1); }
console.log(`test-site-appearance: ok (${checked} combinations on ${pages} pages, langs ${LANGS.join(',')}, widths ${WIDTHS.join(',')}${QUICK ? ', quick' : ''}, ${secs}s)`);
