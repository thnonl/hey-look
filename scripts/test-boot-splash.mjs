#!/usr/bin/env node
// 1.0.7 (fix12, owner: "can the app show a loading indicator in its own style instead of an empty white window?", D-057): the start screen of index.html.
//
// Until React has mounted, the page is index.html: the app's own ground colour (light or dark, from the stored theme or the OS) and a small logo with a spinner
// in the accent colour inside #root, no text, no layout shift, static with prefers-reduced-motion. React's first render replaces it. This test:
//  1. (static) the files: index.html has the splash inside #root with an accessible name and aria-busy, no visible text, one classic script (the theme read, a file of its
//     own under 1 KB) and the critical stylesheet (a file of its own: an inline style block makes Tauri hash the CSP), both BEFORE the app's module; the two ground colours of
//     public/boot.css are the --bg tokens of src/App.css and the constants of src-tauri/src/bgcolor.rs; the store writes what the theme read reads;
//  2. (browser) the HTML alone (the app's script blocked, so React never mounts), in light and dark, with the theme from the OS and from the stored preference (the stored one
//     wins), reduced motion, at three sizes: the colour of the first painted frame (read from a screenshot, not only from computed styles), the logo is painted and centred, the
//     ring spins (or, with reduced motion, nothing moves and there is no ring), no text, no horizontal or vertical scroll, the accent of the stored preference reaches the ring;
//  3. (browser, built app) the same with the real stylesheet of `npm run build` (dist/), which loads after the critical one and must not change the ground or move the logo;
//  4. (browser, dev preview) after the app mounts there is no splash left in the DOM, it never comes back, and there was no moment with an empty #root between them.
//   node scripts/test-boot-splash.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, sleep, startHarness } from './cdp-harness.mjs';
import { decodePng } from './lib/paint-probe.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const DARK = [27, 28, 32], LIGHT = [255, 255, 255]; // --bg of src/App.css, the two grounds of bgcolor.rs
const hex = (rgb) => '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');

// ---- 1. static ---------------------------------------------------------------------------------------------------------------------------------------
const html = read('index.html'), boot = read('public/boot.css'), bootJs = read('public/theme-boot.js'), css = read('src/App.css'), store = read('src/store.ts');
{
  const rootAt = html.indexOf('<div id="root">'), splash = html.indexOf('class="boot-splash"');
  assert.ok(rootAt > 0 && splash > rootAt && splash < html.indexOf('</body>'), 'the splash is inside #root');
  const tag = html.slice(html.lastIndexOf('<div', splash), html.indexOf('>', splash) + 1);
  assert.ok(/role="status"/.test(tag) && /aria-busy="true"/.test(tag) && /aria-label="[^"]+"/.test(tag), `the splash has a role, aria-busy and an accessible name: ${tag}`);
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script type="module"'));
  assert.equal(body.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim(), '', 'no visible text in the splash (no translation needed)');
  assert.ok(!/<(style|text|title)\b/i.test(body), 'the inline logo has no style block or text');
  assert.ok(!/<style\b/i.test(html), 'no inline style block in index.html (Tauri would hash the CSP style-src, see test-csp-ready.mjs)');
  const order = ['<script src="/theme-boot.js"></script>', '<link rel="stylesheet" href="/boot.css" />', '<script type="module" src="/src/main.tsx"></script>'].map((s) => html.indexOf(s));
  assert.ok(order.every((n) => n > 0) && order[0] < order[1] && order[1] < order[2], `theme read, then critical CSS, then the app: ${order}`);
  assert.ok(Buffer.byteLength(bootJs) < 1024, `theme-boot.js is ${Buffer.byteLength(bootJs)} bytes (limit 1024)`);
  assert.ok(!/\b(eval|new Function|document\.write|innerHTML)\b/.test(bootJs), 'the theme read evaluates nothing');
  // the grounds: the tokens of App.css, the two grounds of boot.css
  const bgOf = (sel) => { const at = css.indexOf(sel); return /--bg:\s*(#[0-9a-f]{6})/i.exec(css.slice(at, css.indexOf('}', at)))[1].toLowerCase(); };
  assert.equal(bgOf(':root {'), hex(LIGHT), 'App.css light --bg');
  assert.equal(bgOf(':root[data-theme="dark"] {'), hex(DARK), 'App.css dark --bg');
  assert.ok(boot.includes(`:where(html) { background: ${hex(LIGHT)}; }`), 'boot.css light ground');
  assert.equal(boot.split(`{ background: ${hex(DARK)}; }`).length - 1, 2, 'boot.css dark ground (OS dark with System, and the Dark setting)');
  assert.ok(/prefers-reduced-motion: reduce[^}]*\.boot-logo \{ animation: none; \}[^}]*\.boot-ring \{ display: none; \}/.test(boot), 'reduced motion: static logo, no ring');
  assert.ok(!/\b(inset|gap|aspect-ratio)\s*:/.test(boot), 'boot.css uses no property that WebKit of macOS 11 lacks (inset, gap on flex, aspect-ratio)');
  assert.ok(/@supports \(color: color-mix/.test(boot) && /--boot-ring: #6fa7d7/.test(boot), 'color-mix only behind @supports, with a plain hex before it');
  // the store writes what the theme read reads
  assert.ok(/localStorage\.setItem\("heylook\.boot", JSON\.stringify\(\{ theme: p\.theme, accent \}\)\)/.test(store) && bootJs.includes('"heylook.boot"'), 'applyPrefs and theme-boot.js use the same key and shape');
}
console.log('ok   static: the files, the grounds, the order, the key');

// ---- 2. browser ------------------------------------------------------------------------------------------------------------------------------------
const h = await startHarness('test-boot-splash', { vitePort0: 5495 });
const { cdp, evaluate, base } = h;
await cdp('Network.enable');
const BLOCK = ['*/src/main.tsx*', '*/assets/index-*.js*'];
let step = 0;
const fail = (m) => { throw new Error(`#${step} ${m}`); };

/** Loads `url` with the app's script blocked, with the given media and stored preference; waits until the document has loaded. */
async function loadSplash(url, { scheme = 'light', reduce = false, stored = null, size = [1280, 800], blocked = BLOCK } = {}) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
  await cdp('Network.setBlockedURLs', { urls: blocked });
  await cdp('Page.navigate', { url });
  await sleep(500);
  // the stored preference is in the origin's storage: set it, then load again (what the next start of the app does)
  await evaluate(`(() => { try { localStorage.clear(); ${stored ? `localStorage.setItem('heylook.boot', ${JSON.stringify(JSON.stringify(stored))});` : ''} } catch {} return 1; })()`);
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url });
  for (let i = 0; i < 100; i++) { if ((await evaluate('document.readyState')) === 'complete') break; await sleep(100); }
  await sleep(300);
}

const shotPixels = async () => decodePng(Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const px = (img, x, y) => { const o = (y * img.width + x) * img.channels; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
/** 0..255 channels of `rgb(r, g, b)` or of `color(srgb r g b)` (what a browser answers for a colour made by color-mix()). */
const channels = (c) => { const n = (c.match(/[\d.]+/g) ?? []).map(Number); return c.startsWith('color(') ? n.slice(0, 3).map((v) => Math.round(v * 255)) : n.slice(0, 3); };
const same = (a, b, tol = 0) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

const PROBE = `(() => {
  const html = document.documentElement, root = document.getElementById('root'), sp = root.querySelector('.boot-splash');
  const logo = sp && sp.querySelector('.boot-logo'), ring = sp && sp.querySelector('.boot-ring');
  const rect = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const cs = (e) => getComputedStyle(e);
  return {
    theme: html.getAttribute('data-theme'), htmlBg: cs(html).backgroundColor, bodyBg: cs(document.body).backgroundColor,
    splash: !!sp, role: sp && sp.getAttribute('role'), busy: sp && sp.getAttribute('aria-busy'), name: sp && sp.getAttribute('aria-label'),
    text: root.innerText.trim(), logo: logo ? rect(logo) : null, ring: ring ? rect(ring) : null, ringDisplay: ring ? cs(ring).display : null,
    ringBox: ring ? [ring.offsetWidth, ring.offsetHeight] : null, ringColour: ring ? cs(ring).borderTopColor : null, animations: sp ? sp.getAnimations({ subtree: true }).map((a) => a.animationName + ':' + a.playState) : [],
    logoAnim: logo ? cs(logo).animationName : null,
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerWidth, innerHeight], rootRect: rect(root), accentBase: html.style.getPropertyValue('--accent-base'),
    splashRect: sp ? rect(sp) : null,
  };
})()`;

/** One expectation: the colour the first frame has (from the pixels), and what the splash looks like. */
async function expectSplash(label, opts, want) {
  step++;
  await loadSplash(opts.url ?? base, opts);
  const p = await evaluate(PROBE), img = await shotPixels();
  const [w, hgt] = opts.size ?? [1280, 800];
  assert.ok(p.splash, `${label}: the splash is there`);
  assert.equal(p.role, 'status', label); assert.equal(p.busy, 'true', label); assert.ok(p.name && p.name.length > 0, `${label}: accessible name`);
  assert.equal(p.text, '', `${label}: no visible text`);
  assert.equal(p.theme, want.attr, `${label}: data-theme`);
  const bg = want.dark ? DARK : LIGHT;
  // the colour of the first frame, at the corners and the edges: from the screenshot
  for (const [x, y] of [[2, 2], [w - 3, 2], [2, hgt - 3], [w - 3, hgt - 3], [w >> 1, 2], [2, hgt >> 1]]) assert.ok(same(px(img, x, y), bg), `${label}: pixel (${x},${y}) is ${px(img, x, y)}, expected ground ${bg}`);
  assert.match(p.htmlBg, new RegExp(`^rgb\\(${bg.join(', ')}\\)$`), `${label}: computed ground ${p.htmlBg}`);
  // the logo: 72 x 72, centred (1 px), and painted: more than 40 % of its pixels differ from the ground (the tile is blue, the mark is white)
  const [lx, ly, lw, lh] = p.logo;
  assert.ok(Math.abs(lw - 72) < 0.6 && Math.abs(lh - 72) < 0.6, `${label}: logo ${lw}x${lh}`);
  assert.ok(Math.abs(lx + lw / 2 - w / 2) <= 1 && Math.abs(ly + lh / 2 - hgt / 2) <= 1, `${label}: logo centred, at ${lx + lw / 2},${ly + lh / 2} of ${w}x${hgt}`);
  let diff = 0, total = 0;
  for (let y = Math.round(ly) + 4; y < ly + lh - 4; y++) for (let x = Math.round(lx) + 4; x < lx + lw - 4; x++) { total++; if (!same(px(img, x, y), bg, 6)) diff++; }
  assert.ok(diff / total > 0.4, `${label}: logo painted (${diff}/${total} differ from the ground)`);
  // no scroll, no layout shift (the splash is out of the flow)
  assert.ok(p.scroll[0] <= p.scroll[2] && p.scroll[1] <= p.scroll[3], `${label}: scroll size ${p.scroll}`);
  assert.deepEqual(p.splashRect, [0, 0, w, hgt], `${label}: the splash fills the window`);
  if (want.reduce) {
    assert.equal(p.ringDisplay, 'none', `${label}: no ring with reduced motion`);
    assert.deepEqual(p.animations, [], `${label}: nothing moves with reduced motion: ${p.animations}`);
    assert.equal(p.logoAnim, 'none', label);
    const a = await shotPixels(); await sleep(450); const b = await shotPixels();
    assert.ok(Buffer.compare(a.data, b.data) === 0, `${label}: two pictures 450 ms apart are the same`);
  } else {
    assert.notEqual(p.ringDisplay, 'none', label);
    assert.ok(p.animations.some((s) => s === 'boot-spin:running') && p.animations.some((s) => s === 'boot-pulse:running'), `${label}: the spinner and the pulse run: ${p.animations}`);
    assert.deepEqual(p.ringBox, [112, 112], `${label}: the ring is 112 px`);
    assert.ok(Math.abs(p.ring[0] + p.ring[2] / 2 - w / 2) <= 1 && Math.abs(p.ring[1] + p.ring[3] / 2 - hgt / 2) <= 1, `${label}: the ring is centred (it turns about its centre): ${p.ring}`);
  }
  if (want.ring) assert.ok(same(channels(p.ringColour), channels(want.ring), 1), `${label}: ring colour ${p.ringColour}, expected ${want.ring}`);
  console.log(`ok   ${label}: ground ${px(img, 2, 2)}, logo ${lw}x${lh} centred, ${diff}/${total} px painted${want.reduce ? ', static' : ', spinning'}`);
}

const D = { attr: null, dark: true }, L = { attr: null, dark: false };
// the OS decides when nothing is stored (System, or the first start)
await expectSplash('OS light, nothing stored', { scheme: 'light' }, { ...L, ring: 'rgb(15, 108, 189)' });
await expectSplash('OS dark, nothing stored', { scheme: 'dark' }, { ...D, ring: 'rgb(111, 167, 215)' });
await expectSplash('OS dark, stored System', { scheme: 'dark', stored: { theme: 'system', accent: '#0f6cbd' } }, D);
// the stored setting wins over the OS, both ways
await expectSplash('OS light, stored Dark', { scheme: 'light', stored: { theme: 'dark', accent: '#0f6cbd' } }, { attr: 'dark', dark: true });
await expectSplash('OS dark, stored Light', { scheme: 'dark', stored: { theme: 'light', accent: '#0f6cbd' } }, { attr: 'light', dark: false, ring: 'rgb(15, 108, 189)' });
// the stored accent reaches the ring (light: as it is; dark: lightened by 40 %, as the app does, when the engine has color-mix)
await expectSplash('stored Light, accent #c2327d', { scheme: 'dark', stored: { theme: 'light', accent: '#c2327d' } }, { attr: 'light', dark: false, ring: 'rgb(194, 50, 125)' });
// a damaged or foreign stored value changes nothing
await expectSplash('stored junk', { scheme: 'dark', stored: { theme: 'purple', accent: 'url(javascript:1)' } }, D);
// reduced motion: static logo, no ring, both themes
await expectSplash('reduced motion, light', { scheme: 'light', reduce: true }, { ...L, reduce: true });
await expectSplash('reduced motion, stored Dark', { scheme: 'light', reduce: true, stored: { theme: 'dark', accent: '#0f6cbd' } }, { attr: 'dark', dark: true, reduce: true });
// sizes: the minimum window of the app (960 x 560), a narrow one, a big one: no scroll, centred
await expectSplash('960 x 560', { scheme: 'dark', size: [960, 560] }, D);
await expectSplash('360 x 640', { scheme: 'light', size: [360, 640] }, L);
await expectSplash('2560 x 1300', { scheme: 'dark', size: [2560, 1300] }, D);

// ---- 3. the built app: the real stylesheet loads after the critical one ----------------------------------------------------------------------------
const dist = path.join(ROOT, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.log('SKIPPED the built-app part (no dist/: run `npm run build` first)');
} else {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const f = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  try {
    // (the app's script is blocked; its stylesheet, App.css, is not: it sets the same grounds with `var(--bg)` and the page must look the same)
    const built = (name, o, want) => expectSplash(`built, ${name}`, { url, blocked: ['*/assets/index-*.js*', '*/assets/dist-*.js*'], ...o }, want);
    await built('OS light', { scheme: 'light' }, L);
    await built('OS dark', { scheme: 'dark' }, D);
    await built('OS light, stored Dark', { scheme: 'light', stored: { theme: 'dark', accent: '#0f6cbd' } }, { attr: 'dark', dark: true });
    await built('OS dark, stored Light', { scheme: 'dark', stored: { theme: 'light', accent: '#0f6cbd' } }, { attr: 'light', dark: false });
    await built('reduced motion', { scheme: 'dark', reduce: true }, { ...D, reduce: true });
    const css = await evaluate(`[...document.styleSheets].map((s) => { try { return s.href.split('/').pop() + ':' + s.cssRules.length; } catch { return s.href + ':?'; } })`);
    assert.ok(css.some((s) => s.startsWith('boot.css')) && css.some((s) => /^index-.*\.css/.test(s)), `both stylesheets are loaded: ${css}`);
  } finally { server.close(); }
}

// ---- 4. the dev preview: after the mount ---------------------------------------------------------------------------------------------------------------
step++;
await cdp('Network.setBlockedURLs', { urls: [] });
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
const watcher = `(() => {
  window.__rootLog = [];
  let last = '';
  const note = () => { const r = document.getElementById('root'); const s = JSON.stringify({ splash: !!document.querySelector('.boot-splash'), kids: r ? r.children.length : -1 }); if (s !== last) { last = s; window.__rootLog.push({ t: Math.round(performance.now()), ...JSON.parse(s) }); } };
  new MutationObserver(note).observe(document, { childList: true, subtree: true }); note();
})()`;
const { identifier } = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: watcher });
await h.openApp('dark', 1280, 800);
await sleep(1500);
const all = await evaluate('window.__rootLog');
const from = all.findIndex((e) => e.splash); // (what comes before is the document being parsed: no #root, or an empty one, yet)
assert.ok(from >= 0, `the page starts with the splash in #root: ${JSON.stringify(all.slice(0, 4))}`);
const log = all.slice(from);
const first = log.findIndex((e) => !e.splash);
assert.ok(first > 0, `the splash was replaced: ${JSON.stringify(log.slice(0, 6))}`);
assert.ok(log.slice(first).every((e) => !e.splash && e.kids >= 1), `after the mount the splash never comes back and #root is never empty: ${JSON.stringify(log.slice(first - 1, first + 6))}`);
assert.ok(log.slice(0, first).every((e) => e.splash), 'no state between the splash and the app');
const after = await evaluate(`({ splash: document.querySelectorAll('.boot-splash, .boot-logo, .boot-ring').length, status: document.querySelectorAll('#root > [role="status"][aria-label="Hey Look!"]').length, store: !!window.__store })`);
assert.deepEqual(after, { splash: 0, status: 0, store: true }, 'no leftover of the splash in the DOM after the mount');
// the app's own colour is what it paints after the mount (the splash style rules stay inert), in the dark theme of the OS
const painted = await evaluate(`getComputedStyle(document.body).backgroundColor`);
assert.equal(painted, 'rgb(27, 28, 32)', 'the app paints the same ground');
console.log(`ok   after the mount: splash replaced at ${log[first].t} ms in one step (#root has ${log[first].kids} child(ren) at once), no leftover, ground ${painted}`);
await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier });

await h.shutdown();
console.log('test-boot-splash: ok');
