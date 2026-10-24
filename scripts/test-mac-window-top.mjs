#!/usr/bin/env node
// D-097 (the three macOS window buttons drawn over the page headers): the fix is native - no window has the full-size content view, so the page starts BELOW the title bar band
// (tauri.conf.json `titleBarStyle: Transparent`, the secondary windows' builder, macwin.rs `set_one`; the Rust source guard is `no_window_has_the_full_size_content_view_on_macos`).
// What the page side has to hold with the macOS class forced (`data-os="macos"`), in the dev preview of every kind of window:
//   - the page starts at y = 0 of the viewport and nothing adds a safe-area inset for the buttons (no spacer, no 78 px left padding on a header: the band is native);
//   - the strip above the page is the window's native colour, which shows the ground colour (--bg): the reader bar and the Settings nav of a window use --bg, so the page top edge
//     and the strip are one colour (D-092);
//   - the CSS never moves a header out of the drag region the page set (a header that starts a drag keeps `data-tauri-drag-region` where it had one).
// The real thing - AX rectangles of the buttons against the rectangles of the header children - is the Mac row WK-35.B-D097 (webkit-checks-107.md).
//   node scripts/test-mac-window-top.mjs [--require-browser]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';

const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
assert.ok(!/data-os="macos"\][^{]*\{[^}]*(padding-left|margin-left|padding-top)\s*:\s*(7[0-9]|8[0-9]|9[0-9])px/.test(css), 'a macOS rule pads a header for the window buttons');
assert.ok(!/safe-area-inset|traffic/i.test(css), 'a safe-area rule for the window buttons exists');

const H = await startHarness('test-mac-window-top', { vitePort0: 5180, cdpPort0: 9180 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(80); } return false; };
const probe = (sel) => evaluate(`JSON.stringify((() => {
  document.documentElement.dataset.os = 'macos';
  const root = document.getElementById('root').getBoundingClientRect();
  const el = document.querySelector(${JSON.stringify(sel)});
  const r = el && el.getBoundingClientRect();
  const bg = el && getComputedStyle(el).backgroundColor;
  const ground = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const probeEl = document.createElement('div'); probeEl.style.background = ground; document.body.appendChild(probeEl);
  const groundRgb = getComputedStyle(probeEl).backgroundColor; probeEl.remove();
  const kids = el ? [...el.children].map((c) => { const q = c.getBoundingClientRect(); return [q.left, q.top, q.right, q.bottom]; }) : [];
  return { rootTop: root.top, found: !!el, top: r && r.top, left: r && r.left, bg, groundRgb, kids };
})())`).then(JSON.parse);

try {
  for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const [w, h] of [[960, 560], [1280, 800]]) {
      await check(`main window ${w}x${h} ${theme}`, async () => {
        await H.openApp('lang=en', w, h);
        assert.ok(await waitFor(`!!document.querySelector('.brand, .side-brand, header')`));
        const p = await probe('.brand, .side-brand, header');
        assert.equal(p.rootTop, 0, 'the page starts at the top of the viewport');
        assert.ok(p.top < 80, `the first header is at y ${p.top}`);
      });
    }
    await check(`reader window ${theme}`, async () => {
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=dk1#lang=en` });
      assert.ok(await waitFor(`!!document.querySelector('.reader-bar')`));
      const p = await probe('.reader-bar');
      assert.equal(p.rootTop, 0);
      assert.equal(p.top, 0, 'the bar is the top of the page');
      assert.equal(p.bg, p.groundRgb, `the bar is the ground colour (${p.bg} vs ${p.groundRgb}): one colour with the strip above`);
      // nothing in the bar is pushed right by a spacer: its first button starts at the bar's own padding
      assert.ok(p.kids[0][0] <= 16, `the first button starts at x ${p.kids[0][0]}`);
    });
    await check(`compose window ${theme}`, async () => {
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en` });
      assert.ok(await waitFor(`!!document.querySelector('.compose-pane')`));
      const p = await probe('.compose-pane');
      assert.equal(p.rootTop, 0);
      assert.equal(p.top, 0);
    });
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-mac-window-top: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-mac-window-top: ok');
