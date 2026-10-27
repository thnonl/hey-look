#!/usr/bin/env node
// 1.0.10 (owner screenshot, "Loading..." pill over the TODAY header): the loading indicator of the message list when a tab, a filter or a search is asked for while the old rows are on screen.
//   markup      no floating pill any more; a zero-height sticky wrapper with a 2 px bar (absolute: nothing moves), a visually hidden status region with the text, aria-busy on the list
//   timing      the bar and the dim come after 200 ms of waiting (a fast answer shows nothing), stay at least 200 ms, fade out; the rows stay put
//   dim         the old rows are at about 0.6 opacity and ignore the pointer while it waits
//   overlap     the bar is the top 2 px of the list: the text of the TODAY header (and of the first row) is below it
//   motion      prefers-reduced-motion: no sliding animation (a static bar)
//   the cause   the rows' answer ends the waiting (loading false) when the threads are set, not when the folder counts and the outbox have answered too
//   node scripts/test-list-loading-indicator.mjs [--require-browser] [--shots=<dir>]
import fs from 'node:fs';
import path from 'node:path';
import { arg, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-list-loading-indicator', { vitePort0: 5890 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
const SHOTS = arg('shots') || process.env.LD_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const S = (e) => `window.__store.getState().${e}`;

/** Samples the list every 20 ms for `ms`: when the bar was on, the opacity of a row, whether the rows moved. */
const watch = (start, ms) => evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const top = () => { const r = q('.ml-row'); return r ? Math.round(r.getBoundingClientRect().top) : null; };
  const t0 = performance.now(), y0 = top();
  let on = null, off = null, moved = false, dimmed = null, status = null, busy = null, noPointer = null;
  ${start}
  while (performance.now() - t0 < ${ms}) {
    const b = q('.ml-loadbar'), now = Math.round(performance.now() - t0);
    const isOn = !!b && b.classList.contains('on');
    if (isOn && on === null) { on = now; }
    if (isOn && dimmed === null && now >= on + 160) { const row = q('.ml-body > :not(.ml-loadwrap):not(.sr-only)'); dimmed = row ? parseFloat(getComputedStyle(row).opacity) : null; noPointer = row ? getComputedStyle(row).pointerEvents : null; status = (q('.ml-body > [role=status].sr-only') || {}).textContent; busy = q('.ml-body').getAttribute('aria-busy'); }
    if (on !== null && !isOn && off === null) off = now;
    if (top() !== y0) moved = true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { on, off, moved, dimmed, status, busy, noPointer };
})()`);

try {
  await H.openApp('light&lang=en', 1280, 800);
  await sleep(600);
  // ---- the markup and the CSS
  const m = await evaluate(`(() => {
    const w = document.querySelector('.ml-loadwrap'), b = document.querySelector('.ml-loadbar'), body = document.querySelector('.ml-body');
    const cs = b && getComputedStyle(b), ws = w && getComputedStyle(w);
    return { pill: !!document.querySelector('.ml-loadpill'), wrap: w && { pos: ws.position, h: w.getBoundingClientRect().height, pe: ws.pointerEvents, aria: w.getAttribute('aria-hidden') }, bar: b && { pos: cs.position, h: b.getBoundingClientRect().height, op: cs.opacity },
      status: !!document.querySelector('.ml-body > [role=status].sr-only'), busy: body.getAttribute('aria-busy'), text: (document.querySelector('.ml-body > [role=status].sr-only') || {}).textContent };
  })()`);
  ok(!m.pill, 'no floating pill in the page');
  ok(m.wrap && m.wrap.pos === 'sticky' && m.wrap.h === 0 && m.wrap.pe === 'none' && m.wrap.aria === 'true', `the wrapper is a zero-height sticky, no pointer events, hidden from screen readers: ${JSON.stringify(m.wrap)}`);
  ok(m.bar && m.bar.pos === 'absolute' && m.bar.h === 2 && m.bar.op === '0', `the bar is absolute, 2 px, invisible while nothing loads: ${JSON.stringify(m.bar)}`);
  ok(m.status && m.text === '' && m.busy === null, `the status region is there, empty and not busy while idle: ${JSON.stringify({ t: m.text, b: m.busy })}`);
  const css = await evaluate(`(() => { let reduced = false, slide = false; for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { continue; } for (const r of rules) { if (r.type === CSSRule.MEDIA_RULE && (r.conditionText || r.media.mediaText).includes('prefers-reduced-motion')) { for (const x of r.cssRules) if (x.selectorText && x.selectorText.includes('.ml-loadbar') && x.style.animationName === 'none') reduced = true; } if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'ml-slide') slide = true; } } return { reduced, slide }; })()`);
  ok(css.slide && css.reduced, `the keyframes and the prefers-reduced-motion rule (no animation) are in the stylesheet: ${JSON.stringify(css)}`);

  // ---- a slow answer (900 ms): the bar after about 200 ms, the dim, the status text, the rows stay where they are
  await evaluate(`window.__mockDelays = { cmds: { list_threads: 900 } }; 1`);
  const slow = await watch(`${S("setFocus('other')")};`, 2000);
  ok(slow.on !== null && slow.on >= 170 && slow.on <= 360, `slow answer: the bar comes at ${slow.on} ms (200 ms of waiting, not before)`);
  ok(slow.off !== null && slow.off >= 850, `slow answer: the bar goes with the answer (${slow.off} ms)`);
  ok(slow.dimmed !== null && slow.dimmed > 0.5 && slow.dimmed < 0.8 && slow.noPointer === 'none', `the old rows are dimmed and ignore the pointer: opacity ${slow.dimmed}, pointer-events ${slow.noPointer}`);
  ok(slow.status === 'Loading…' && slow.busy === 'true', `the status text and aria-busy while it waits: ${JSON.stringify({ s: slow.status, b: slow.busy })}`);
  ok(!slow.moved, 'no row moved');
  await evaluate(`window.__mockDelays = {}; ${S("setFocus('focused')")}; 1`);
  await sleep(500);
  // ---- a fast answer (120 ms): nothing at all
  await evaluate(`window.__mockDelays = { cmds: { list_threads: 120 } }; 1`);
  const fast = await watch(`${S("setFocus('other')")};`, 900);
  ok(fast.on === null, `fast answer (120 ms): no bar, no dim (${fast.on})`);
  await evaluate(`window.__mockDelays = {}; ${S("setFocus('focused')")}; 1`);
  await sleep(500);
  // ---- the cause: the folder counts answer slowly, the rows are not held back by them
  await evaluate(`window.__mockDelays = { cmds: { list_folders: 1500 } }; 1`);
  const t = await evaluate(`(async () => { const t0 = performance.now(); const p = ${S("setFocus('other')")}; let done = null; while (performance.now() - t0 < 2500) { if (!${S('loading')}) { done = Math.round(performance.now() - t0); break; } await new Promise((r) => setTimeout(r, 10)); } await p; return done; })()`);
  ok(t !== null && t < 400, `the list stops loading when its rows are here, not after the folder counts (1.5 s): ${t} ms`);
  await evaluate(`window.__mockDelays = {}; ${S("setFocus('focused')")}; 1`);
  await sleep(500);

  // ---- overlap with the first date header and the first row, and the screenshots (light and dark)
  for (const theme of ['light', 'dark']) {
    await H.openApp(`${theme}&lang=en`, 1280, 800);
    await sleep(600);
    await evaluate(`window.__mockDelays = { cmds: { list_threads: 4000 } }; ${S("setFocus('other')")}; 1`);
    ok(await (async () => { for (let i = 0; i < 60; i++) { if (await evaluate(`!!document.querySelector('.ml-loadbar.on')`)) return true; await sleep(50); } return false; })(), `${theme}: the bar shows while the answer is awaited`);
    await sleep(250);
    const o = await evaluate(`(() => {
      const bar = document.querySelector('.ml-loadbar').getBoundingClientRect(), body = document.querySelector('.ml-body').getBoundingClientRect();
      const hdr = [...document.querySelectorAll('.ml-body *')].find((e) => /^(today|yesterday|heute|gestern)$/i.test((e.children.length === 0 && e.textContent || '').trim()));
      let textTop = null; if (hdr) { const r = document.createRange(); r.selectNodeContents(hdr); textTop = Math.round(r.getBoundingClientRect().top); }
      const first = document.querySelector('.ml-row'); const fr = first && first.getBoundingClientRect();
      const color = getComputedStyle(document.querySelector('.ml-loadbar'), '::before').backgroundColor;
      return { barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom), listTop: Math.round(body.top), textTop, firstRowTop: fr && Math.round(fr.top), width: Math.round(bar.width), bodyW: Math.round(body.width), color };
    })()`);
    ok(o.barTop === o.listTop && o.barBottom - o.barTop === 2 && o.width === o.bodyW, `${theme}: the bar is the top 2 px of the list, the whole width: ${JSON.stringify(o)}`);
    ok(o.textTop === null || o.textTop >= o.barBottom, `${theme}: the text of the date header starts below the bar (${o.textTop} >= ${o.barBottom})`);
    ok(o.firstRowTop === null || o.firstRowTop >= o.barBottom - 1, `${theme}: the first row starts below the bar`);
    ok(/rgb/.test(o.color) && o.color !== 'rgba(0, 0, 0, 0)', `${theme}: the bar has the accent colour (${o.color})`);
    if (SHOTS) {
      const clip = await evaluate(`(() => { const r = document.querySelector('.ml-body').getBoundingClientRect(); const t = document.querySelector('.ml-head, .ml-top, .list-pane')?.getBoundingClientRect(); return { x: Math.max(0, r.left - 4), y: Math.max(0, r.top - 90), width: r.width + 8, height: 320 }; })()`);
      const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      fs.writeFileSync(path.join(SHOTS, `loading-bar-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await evaluate(`window.__mockDelays = {}; 1`);
    await sleep(300);
  }

  // ---- reduced motion: no sliding animation
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`window.__mockDelays = { cmds: { list_threads: 1500 } }; ${S("setFocus('other')")}; 1`);
  await sleep(500);
  const rm = await evaluate(`(() => { const cs = getComputedStyle(document.querySelector('.ml-loadbar'), '::before'); return { anim: cs.animationName, w: cs.width, on: document.querySelector('.ml-loadbar').classList.contains('on') }; })()`);
  ok(rm.on && rm.anim === 'none', `reduced motion: the bar shows and does not slide (${JSON.stringify(rm)})`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const mo = await evaluate(`getComputedStyle(document.querySelector('.ml-loadbar'), '::before').animationName`);
  ok(mo === 'ml-slide', `with motion the bar slides (${mo})`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-list-loading-indicator: ${failures.length} failure(s) of ${checks} checks`); process.exit(1); }
console.log(`test-list-loading-indicator: ok (${checks} checks)`);
