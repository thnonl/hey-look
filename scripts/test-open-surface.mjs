#!/usr/bin/env node
// 1.0.7 fix38 (owner observation on the Mac QA of a heavy mail): while a mail opens, "Opening message…" is ONE surface over the whole body area of the reading pane and of the reader window, in
// the colour the mail will have there (mailCanvas.ts: white for the original canvas, DARK_CANVAS for the dark one; WP13g decides which one the app theme shows), never a small card of the
// app colour inside a pane of the other kind. The card used to be 34em wide: `.reader-state` (App.css, later in the file) gave back the `max-width` and `margin` that `.rp-opening` had taken off, so
// 76 px of the mail (or of the pane) showed on each side of a dark (or light) box.
// Dev preview, theme Light / Dark x stored canvas original / dark x a small and a heavy (2 MB) mail x pane widths 960 and 1280, the read of the conversation slowed down so the status stays on screen:
//   - the status rectangle is the body area's rectangle (within 1 px), at three moments of the wait; no card (width and height of the area);
//   - its colour is the final canvas colour of that mode (within 4 levels: white, or 27/28/32 when the dark canvas shows), its text reads on it (contrast >= 3);
//   - when the mail's frame replaces it the body area is the same box (within 1 px) and the status is gone; nothing of the status is left in the frame's box;
//   - the reader window (?w=reader, a page of its own in the preview): the same, in both themes with the dark canvas stored;
//   - the composer's shell of a Forward ("Preview as recipient" surface): the status sits on the editor's own surface, which is the preview colour of that mode.
//   node scripts/test-open-surface.mjs [--require-browser]
import { sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';

const H = await startHarness('test-open-surface', { vitePort0: 6350 });
const { evaluate, cdp } = H;
const failures = [];
const check = (tag, cond, msg) => { if (!cond) failures.push(`[${tag}] ${msg}`); return !!cond; };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };
const WHITE = [255, 255, 255], DARK = [27, 28, 32];
const near = (a, b, tol = 4) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** What shows in each mode: WP13g (the Light app always shows the original canvas; the Dark app the stored one). */
const canvasOf = (theme, stored) => (theme === 'dark' && stored === 'dark' ? DARK : WHITE);
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The rectangles and colours of the status and of the area under it (null when no status is up). */
const SAMPLE = `(() => {
  const o = document.querySelector('.rp-body .rp-opening'); const b = document.querySelector('.rp-body');
  if (!o || !b) return null;
  const rect = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const cs = getComputedStyle(o);
  return { o: rect(o), body: rect(b), clientW: b.clientWidth, clientH: b.clientHeight, bg: rgb(cs.backgroundColor), alpha: cs.backgroundColor.startsWith('rgba') ? Number((cs.backgroundColor.match(/[\\d.]+/g) || [])[3]) : 1,
    fg: rgb(getComputedStyle(o.querySelector('p')).color), text: o.textContent.replace(/[·\\s]+/g, ' ').trim(), onClass: /on-(light|dark)/.exec(o.className)?.[0] };
})()`;
const sameBox = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);

async function judge(tag, s, want) {
  if (!check(tag, s, 'no status on screen')) return;
  check(tag, sameBox(s.o, s.body), `the status is not the body area: ${JSON.stringify(s.o.map(Math.round))} vs ${JSON.stringify(s.body.map(Math.round))}`);
  check(tag, s.o[2] >= s.clientW - 1 && s.o[3] >= s.clientH - 1, `a small card: ${Math.round(s.o[2])}x${Math.round(s.o[3])} in an area of ${s.clientW}x${s.clientH}`);
  check(tag, near(s.bg, want) && s.alpha === 1, `colour ${JSON.stringify(s.bg)} (alpha ${s.alpha}), the canvas is ${JSON.stringify(want)}`);
  check(tag, contrast(s.fg, s.bg) >= 3, `the text ${JSON.stringify(s.fg)} on ${JSON.stringify(s.bg)}: contrast ${contrast(s.fg, s.bg).toFixed(2)}`);
  check(tag, s.text === 'Opening message…', `text "${s.text}"`);
  check(tag, s.onClass === (want === DARK ? 'on-dark' : 'on-light'), `class ${s.onClass}`);
}

try {
  for (const w of [1280, 960]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
    await H.openApp('lang=en', w, 800);
    await evaluate(FIXTURES);
    await evaluate(`window.__store.getState().refresh().then(() => 1)`);
    await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
    await sleep(500);
    for (const theme of ['light', 'dark']) for (const stored of ['original', 'dark']) for (const [kind, id] of [['small', IDS.small], ['heavy 2 MB', IDS.huge]]) {
      const tag = `pane ${w} ${theme}/${stored} ${kind}`;
      const want = canvasOf(theme, stored);
      await evaluate(`window.__store.getState().setPrefs({ theme: '${theme}', mailCanvas: '${stored}' }); window.__store.getState().select(null); window.__mockDelays = { thread: 1600 }; 1`);
      await sleep(500);
      await evaluate(`window.__store.getState().select('${id}'); 1`);
      if (!check(tag, await waitFor(`!!document.querySelector('.rp-body .rp-opening')`, 4000), 'the status never showed')) continue;
      const first = await evaluate(SAMPLE);
      await judge(tag, first, want);
      await sleep(500);
      await judge(`${tag} +500`, await evaluate(SAMPLE), want);
      await sleep(500);
      await judge(`${tag} +1000`, await evaluate(SAMPLE), want);
      // the frame replaces it: the same box under it, the status gone
      check(tag, await waitFor(`!document.querySelector('.rp-body .rp-opening') && !!document.querySelector('.rp-msg.open .msg-frame')`, 30000), 'the status never ended');
      const after = await evaluate(`(() => { const r = document.querySelector('.rp-body').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
      check(tag, sameBox(after, first.body), `the body area moved when the mail came: ${JSON.stringify(first.body.map(Math.round))} -> ${JSON.stringify(after.map(Math.round))}`);
      await evaluate(`window.__mockDelays = { thread: 0 }; 1`);
      await sleep(300);
    }
  }

  // the reader window: its own page; the prefs the main page stored are what it reads (#persist)
  for (const theme of ['light', 'dark']) {
    const tag = `reader ${theme}/dark`;
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await H.openApp('lang=en&persist', 1100, 760);
    await evaluate(`window.__store.getState().setPrefs({ theme: '${theme}', mailCanvas: 'dark' }); 1`);
    await sleep(400);
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=t1#lang=en&persist&threaddelay=1600` });
    // (the status of the reader window runs from the arrival of the conversation to the first measurement of the frame: caught by polling fast, the first sight is judged)
    let seen = null;
    for (const t0 = Date.now(); !seen && Date.now() - t0 < 10000; await sleep(15)) seen = await evaluate(SAMPLE).catch(() => null);
    await judge(tag, seen, canvasOf(theme, 'dark'));
  }

  // the composer's shell of a Forward: the status sits on the editor's own surface ("Preview as recipient" colours), which is one surface for the whole editor box
  for (const theme of ['light', 'dark']) {
    const tag = `compose ${theme}/dark`;
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await H.openApp('lang=en', 1280, 800);
    await evaluate(FIXTURES);
    await evaluate(`window.__store.getState().refresh().then(() => 1)`);
    await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); window.__store.getState().setPrefs({ theme: '${theme}', mailCanvas: 'dark' }); 1`);
    await sleep(500);
    await evaluate(`window.__store.getState().select('${IDS.small}'); 1`);
    if (!check(tag, await waitFor(`!!document.querySelector('.rp-msg.open .msg-frame')`, 8000), 'the mail did not open')) continue;
    await evaluate(`window.__mockDelays = { replyHeaders: 1800 }; document.querySelector('.rp-msg-actions button[aria-label="Forward"]').click(); 1`);
    if (!check(tag, await waitFor(`!!document.querySelector('.cp-prep [role=status]')`, 4000), 'no status in the composer')) continue;
    const s = await evaluate(`(() => { const e = document.querySelector('.cp-editor'); const p = document.querySelector('.cp-prep'); const st = document.querySelector('.cp-prep [role=status] p'); const r = (x) => { const b = x.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
      const rgb = (v) => (v.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      return { e: r(e), p: r(p), bg: rgb(getComputedStyle(e).backgroundColor), fg: rgb(getComputedStyle(st).color) }; })()`);
    const want = canvasOf(theme, 'dark');
    check(tag, s.p[0] >= s.e[0] - 1 && s.p[1] >= s.e[1] - 1 && s.p[0] + s.p[2] <= s.e[0] + s.e[2] + 1 && s.p[1] + s.p[3] <= s.e[1] + s.e[3] + 1, `the status area is outside the editor: ${JSON.stringify(s.p.map(Math.round))} vs ${JSON.stringify(s.e.map(Math.round))}`);
    check(tag, near(s.bg, want), `the editor surface ${JSON.stringify(s.bg)}, the preview colour is ${JSON.stringify(want)}`);
    check(tag, contrast(s.fg, s.bg) >= 3, `the text ${JSON.stringify(s.fg)} on ${JSON.stringify(s.bg)}`);
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-open-surface: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-open-surface: ok');
