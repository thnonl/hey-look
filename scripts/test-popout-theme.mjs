#!/usr/bin/env node
// The top strip of a pop-out follows the theme (v1.0.6, macOS title bar of the compose window, third attempt).
//
// On macOS the web view runs UNDER the title bar (tauri's default title bar style has a full-size content view), so the colour a person sees
// there is painted by the PAGE: WebKit takes it from the page background, or from the colour of a fixed / sticky element at the top edge,
// which it samples and does not take again when a variable changes. The compose page was the only root that was `position: fixed`
// (App.css `.popout-compose`). This test runs the real pop-out pages in the dev preview (src/devMock.ts: `?w=compose` and `?w=reader`)
// in headless Chrome and asserts, for each of them:
//  1. nothing is fixed or sticky at the top edge of the viewport (the root of the compose page is not fixed), and the element that is topmost
//     at the top edge is painted with the page background;
//  2. a faked `prefs-changed` event (the main page changed the theme setting; the preferences the page reads are changed first) updates the
//     theme: <html data-theme>, the colour variables of the top strip (--bg, --top-dk-start / --top-dk-end after an accent change), and the
//     painted colour of html, body, the page root and the topmost element at the top edge; Light -> Dark -> Light -> System;
//  3. with the System setting the page follows the colour scheme of the browser (emulated prefers-color-scheme), in both directions, and asks the
//     backend to apply the frame theme again (`window_theme_refresh`) and logs the strip colours (`popout_note` "strip");
//  4. the `titlebar-nudge` event (safety net, HEYLOOK_TITLEBAR_MODE 7 / 8) nudges the page and puts every box back.
//   node scripts/test-popout-theme.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startHarness } from './cdp-harness.mjs';

// source guards first (these need no browser)
const css = fs.readFileSync(path.join(ROOT, 'src/App.css'), 'utf8');
const rule = css.match(/^\.popout-compose \{([^}]*)\}/m);
assert.ok(rule, 'App.css has no .popout-compose rule');
assert.ok(!/position:\s*fixed/.test(rule[1]) && !/position:\s*sticky/.test(rule[1]), `the root of the compose page must not be fixed or sticky: ${rule[1]}`);
assert.match(rule[1], /position:\s*relative/, 'the pane (position: absolute) needs a positioned root');
for (const sel of ['.reader-win', '.popout-root']) {
  const r = css.match(new RegExp(`^${sel.replace('.', '\\.')} \\{([^}]*)\\}`, 'm'));
  if (r) assert.ok(!/position:\s*(fixed|sticky)/.test(r[1]), `${sel} must not be fixed or sticky`);
}
const root = fs.readFileSync(path.join(ROOT, 'src/popout/PopoutRoot.tsx'), 'utf8');
assert.ok(root.includes('listen("titlebar-nudge"') && root.includes('topStripInfo()'), 'the pop-out page listens for the nudge and logs its strip');

const H = await startHarness('test-popout-theme', { vitePort0: 5960, cdpPort0: 9960 });
const { evaluate, cdp } = H;
const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 400)}`); } };

/** Loads a pop-out page (`?w=...`) and records every call the page makes to the backend in window.__calls. */
async function open(query, w = 960, h = 640, scheme = 'light') {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  for (let attempt = 0; attempt < 5; attempt++) {
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?${query}#lang=en` });
    await sleep(700);
    try {
      await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.popout-compose, .reader-win') && window.__TAURI_INTERNALS__) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('pop-out did not start')); } }, 100); })`);
      break;
    } catch (e) { if (attempt === 4) throw e; }
  }
  await evaluate(`(() => { window.__calls = []; const t = window.__TAURI_INTERNALS__, inv = t.invoke.bind(t); t.invoke = (cmd, args, opts) => { window.__calls.push({ cmd, args }); return inv(cmd, args, opts); }; return 1; })()`);
  await sleep(500);
}

/** The main page wrote the preferences and says so (what a pop-out hears after Settings > Appearance). */
async function setPrefs(prefs) {
  await evaluate(`(async () => { await window.__TAURI_INTERNALS__.invoke('set_setting', { key: 'prefs', value: ${JSON.stringify(JSON.stringify(prefs))} }); await window.__mockEmit('prefs-changed', { writer: 'main' }); return 1; })()`);
  await sleep(500);
}

/** What the top strip is painted with right now. */
const strip = () => evaluate(`(() => {
  const root = document.documentElement, cs = (e) => getComputedStyle(e);
  const probe = document.createElement('i'); document.body.appendChild(probe);
  const resolve = (v) => { probe.style.color = ''; probe.style.color = v; return cs(probe).color; };
  const top = document.elementFromPoint(Math.floor(window.innerWidth / 2), 1);
  // the first ancestor of the topmost element that paints a background
  let p = top, topBg = 'rgba(0, 0, 0, 0)'; while (p && cs(p).backgroundColor === 'rgba(0, 0, 0, 0)') p = p.parentElement; if (p) topBg = cs(p).backgroundColor;
  const r = { theme: root.getAttribute('data-theme'), bgVar: resolve(cs(root).getPropertyValue('--bg').trim()), bg2Var: resolve(cs(root).getPropertyValue('--bg2').trim()), html: cs(root).backgroundColor, body: cs(document.body).backgroundColor,
    page: cs(document.querySelector('.popout-compose, .reader-win')).backgroundColor, topBg, topTag: top ? top.tagName.toLowerCase() + '.' + String(top.className).split(' ')[0] : null,
    dkStart: root.style.getPropertyValue('--top-dk-start'), dkEnd: root.style.getPropertyValue('--top-dk-end'),
    pagePos: cs(document.querySelector('.popout-compose, .reader-win')).position };
  probe.remove(); return JSON.stringify(r);
})()`).then(JSON.parse);

// what the topmost element at the top edge has to be painted with: the page background; the reader's toolbar (its top row) is --bg2
let topVar = 'bgVar';
const calls = (cmd) => evaluate(`JSON.stringify(window.__calls.filter((c) => c.cmd === ${JSON.stringify(cmd)}).map((c) => c.args))`).then(JSON.parse);
const stickers = () => evaluate(`import('/src/popout/titlebarNudge.ts').then((m) => m.topEdgeElements().map((e) => e.tagName + '.' + e.className))`);

try {
  for (const [name, query] of [['compose', 'w=compose&mock=new'], ['reader', 'w=reader&thread=t1']]) {
    for (const size of [[960, 640], [560, 440]]) {
      await open(query, size[0], size[1], 'light');
      const tag = `${name} ${size.join('x')}`;
      topVar = name === 'reader' ? 'bg2Var' : 'bgVar';

      // 1. nothing sticks to the top edge; what is topmost there is painted with the page background
      let s = await strip();
      check(`${tag}: the page root is not fixed`, () => assert.notEqual(s.pagePos, 'fixed'));
      const st = await stickers();
      check(`${tag}: no element sticks to the top edge`, () => assert.deepEqual(st, []));
      check(`${tag}: the top strip is painted with the page background (light)`, () => { assert.equal(s.html, s.bgVar); assert.equal(s.topBg, s[topVar], JSON.stringify(s)); });
      const light = s.bgVar;

      // 2. theme setting changes: Dark, then Light, then Dark + another accent, then System
      await setPrefs({ theme: 'dark' });
      s = await strip();
      check(`${tag}: Dark: data-theme`, () => assert.equal(s.theme, 'dark'));
      check(`${tag}: Dark: the strip changed colour`, () => assert.notEqual(s.bgVar, light));
      check(`${tag}: Dark: html, body, page root and the topmost element are painted with --bg`, () => { for (const k of ['html', 'body', 'page']) assert.equal(s[k], s.bgVar, `${k}: ${JSON.stringify(s)}`); assert.equal(s.topBg, s[topVar], JSON.stringify(s)); });
      const dark = s.bgVar;
      check(`${tag}: the colour variables follow the accent in Dark`, () => assert.ok(s.dkStart && s.dkEnd, JSON.stringify(s)));
      const dk1 = s.dkStart;

      await setPrefs({ theme: 'light' });
      s = await strip();
      check(`${tag}: Light again: data-theme and strip`, () => { assert.equal(s.theme, 'light'); assert.equal(s.bgVar, light); assert.equal(s.topBg, s[topVar]); assert.equal(s.html, light); });

      await setPrefs({ theme: 'dark', accent: '#c026d3' });
      s = await strip();
      check(`${tag}: a new accent changes the top bar tint variables`, () => { assert.notEqual(s.dkStart, dk1); assert.equal(s.topBg, s[topVar]); assert.equal(s.bgVar, dark); });

      // 3. System: the page follows the colour scheme of the browser, both ways, and asks the backend to apply the frame theme again
      await setPrefs({ theme: 'system' });
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await sleep(500);
      s = await strip();
      check(`${tag}: System + OS dark: no data-theme, dark strip`, () => { assert.equal(s.theme, null); assert.equal(s.bgVar, dark); assert.equal(s.topBg, s[topVar]); assert.equal(s.html, dark); });
      await evaluate(`window.__calls.length = 0; 1`);
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await sleep(600);
      s = await strip();
      check(`${tag}: System + OS light: light strip`, () => { assert.equal(s.theme, null); assert.equal(s.bgVar, light); assert.equal(s.topBg, s[topVar]); assert.equal(s.html, light); });
      const refresh = await calls('window_theme_refresh');
      check(`${tag}: the OS change makes the page ask for the frame theme again`, () => { assert.ok(refresh.length >= 1, 'no window_theme_refresh'); assert.equal(refresh.at(-1).prefersDark, false); });
      const notes = await calls('popout_note');
      check(`${tag}: the page logs the strip colours`, () => assert.ok(notes.some((n) => n.kind === 'strip' && /html bg rgb/.test(n.text) && /topmost at y=1/.test(n.text)), JSON.stringify(notes).slice(0, 300)));

      // a setting change makes the page ask again, with the theme it now has
      await evaluate(`window.__calls.length = 0; 1`);
      await setPrefs({ theme: 'dark' });
      const asked = await calls('window_theme_refresh');
      check(`${tag}: a theme setting change makes the page ask again with its new theme`, () => { assert.ok(asked.length >= 1); assert.equal(asked.at(-1).pageTheme, 'dark'); });

      // 4. the nudge: a 1 px change and every box put back
      await evaluate(`window.__calls.length = 0; window.__before = document.documentElement.outerHTML.length; 1`);
      await evaluate(`window.__mockEmit('titlebar-nudge', null)`);
      await sleep(400);
      const nudged = await calls('popout_note');
      check(`${tag}: the nudge is answered in the log`, () => assert.ok(nudged.some((n) => /nudged \d+ element\(s\)/.test(n.text)), JSON.stringify(nudged)));
      const margins = await evaluate(`[...document.querySelectorAll('[style*="margin-top"]')].filter((e) => e.style.marginTop === '1px').length`);
      check(`${tag}: after the nudge every box is back`, () => assert.equal(margins, 0));
    }
  }
  // the nudge itself, on a page that has something fixed and something sticky at the top
  await open('w=reader&thread=t1', 800, 600, 'light');
  const r = await evaluate(`(async () => {
    const m = await import('/src/popout/titlebarNudge.ts');
    const a = document.createElement('div'); a.id = 'fx'; a.style.cssText = 'position:fixed;top:0;left:0;right:0;height:20px;background:#123'; document.body.appendChild(a);
    const b = document.createElement('div'); b.id = 'sk'; b.style.cssText = 'position:sticky;top:0;height:10px;background:#321'; document.body.appendChild(b);
    const found = m.topEdgeElements().map((e) => e.id).sort();
    const n = m.nudgeTopEdge();
    const during = [a.style.marginTop, b.style.marginTop];
    await new Promise((ok) => setTimeout(ok, 300));
    const after = [a.style.marginTop, b.style.marginTop];
    a.remove(); b.remove();
    return JSON.stringify({ found, n, during, after });
  })()`).then(JSON.parse);
  check('the nudge finds fixed and sticky elements at the top edge', () => assert.ok(r.found.includes('fx')));
  check('the nudge moves them by 1 px and puts them back', () => { assert.equal(r.during[0], '1px'); assert.deepEqual(r.after, ['', '']); });
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-popout-theme: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-popout-theme: ok');
