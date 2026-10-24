#!/usr/bin/env node
// 1.0.7 D-092 (Mac QA round 9e / 10b): on macOS the native title bar of a secondary window is transparent, so what shows in the strip at the top of the window is the colour under it. The reader
// window's strip was (35,36,41) = `--bg2`, the colour of the reader's own toolbar, against the ground (27,28,32) = `--bg` of the compose window. On macOS (`<html data-os="macos">`, set from
// shell_info) the topmost 32 px of EVERY kind of window - reader, compose-less views, search results, Scheduled, event, Settings - must be the ground colour `--bg`, in Light and Dark, at 960x560 and
// 1280x800 (the dev preview with `#os=macos`; the native strip itself is measured on the Mac, webkit-checks-107.md 35.B WK-35.19).
//   node scripts/test-mac-strip-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-mac-strip-ui', { vitePort0: 6100 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* loading */ } await sleep(60); } return false; };

const open = async (query, theme, w, h, os = 'macos') => {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}?${query}#lang=en&os=${os}` });
  assert.ok(await waitFor(`document.documentElement.dataset.os === ${JSON.stringify(os)} && !!document.querySelector('.reader-win, [data-popout]:not([data-popout=loading])')`), `${query}: the window did not come up`);
  await sleep(900);
};
/** The colour the eye sees at (x, y): the first element from the top whose own background is opaque. */
const SAMPLE = (pts) => `(() => {
  const probe = document.createElement('div'); probe.style.background = 'var(--bg)'; document.body.appendChild(probe);
  const ground = getComputedStyle(probe).backgroundColor; probe.remove();
  const seen = ${JSON.stringify(pts)}.map(([x, y]) => {
    for (const el of document.elementsFromPoint(x, y)) { const c = getComputedStyle(el).backgroundColor; if (/^rgb\\(/.test(c) || /, 1\\)$/.test(c)) return { x, y, color: c, el: el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] }; }
    return { x, y, color: 'none', el: '-' };
  });
  return { ground, seen };
})()`;
const points = (w) => [4, 14, 26, 31].flatMap((y) => [8, 48, 90, 300, Math.round(w / 2), w - 90, w - 8].map((x) => [x, y]));

const KINDS = [
  ['reader', 'w=reader&thread=tlayer'],
  ['search', 'w=search&q=invoice'],
  ['scheduled', 'w=scheduled'],
  ['event', 'w=event'],
  ['settings', 'w=settings&tab=appearance'],
];
try {
  for (const [name, query] of KINDS) {
    for (const theme of ['dark', 'light']) {
      for (const [w, h] of [[960, 560], [1280, 800]]) {
        await check(`${name} ${theme} ${w}x${h}: the top 32 px are the ground colour on macOS`, async () => {
          await open(query, theme, w, h);
          const { ground, seen } = await evaluate(SAMPLE(points(w)));
          const off = seen.filter((s) => s.color !== ground);
          assert.equal(off.length, 0, `ground ${ground}, but: ${off.slice(0, 4).map((s) => `(${s.x},${s.y}) ${s.color} ${s.el}`).join(' | ')}`);
        });
      }
    }
  }
  await check('the rule is for macOS only: Windows keeps the toolbar colour of the reader', async () => {
    await open('w=reader&thread=tlayer', 'dark', 1280, 800, 'windows');
    const bar = await evaluate(`(() => { const p = document.createElement('div'); p.style.background = 'var(--bg2)'; document.body.appendChild(p); const bg2 = getComputedStyle(p).backgroundColor; p.remove(); return { bar: getComputedStyle(document.querySelector('.reader-bar')).backgroundColor, bg2 }; })()`);
    assert.equal(bar.bar, bar.bg2);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-mac-strip-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-mac-strip-ui: ok');
