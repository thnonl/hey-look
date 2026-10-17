#!/usr/bin/env node
// The attachment preview (PDF / text / picture dialog) and the picture viewer must be on top of the whole window. They used to be drawn INSIDE the
// message they were opened from, and a message of the reading pane sits in a `position: sticky` block, which is a stacking context of its own:
// the Reply / Reply all / Forward row and the head of every LATER message of the same conversation were painted over the dialog. Now both are
// rendered through a portal to document.body (src/components/Attachments.tsx).
//
// This opens a conversation of four messages in the dev preview (src/devMock.ts, thread "tlayer": the first message carries the attachments),
// opens the preview (keyboard: Space on the card) and the picture viewer (mouse: the pictures menu), and asserts, on a grid over the whole window,
// that whatever is under each point is the dialog's own layer; that the dialog is a child of <body>; that the theme variables the dialog uses
// resolve to the same colours there as in the reading pane (light / dark theme, dark mail canvas, a custom accent); that the focus goes into the
// dialog, stays in it on Tab, comes back to what opened it on Esc; and that the page behind keeps its scroll position.
//
//   node scripts/test-preview-layer.mjs                      light + dark theme x original + dark mail canvas x default + custom accent, 1280x720 and 960x560
//   node scripts/test-preview-layer.mjs --quick              two combinations (what CI runs)
//   node scripts/test-preview-layer.mjs --shots=<dir>        PNGs of the open dialogs
//   node scripts/test-preview-layer.mjs --url=http://127.0.0.1:1420/    use a dev server that is already running
//   node scripts/test-preview-layer.mjs --require-browser    fail (instead of skipping) when no Chrome/Chromium/Edge is installed
import { arg, flag, inputs, sleep, startHarness } from './cdp-harness.mjs';

const QUICK = flag('quick');
const CONFIGS = [];
if (QUICK) CONFIGS.push({ w: 960, h: 560, theme: 'light', canvas: 'original', accent: '' }, { w: 1280, h: 720, theme: 'dark', canvas: 'dark', accent: '#c0392b' });
else for (const [w, h] of [[1280, 720], [960, 560]]) for (const theme of ['light', 'dark']) for (const canvas of ['original', 'dark']) for (const accent of ['', '#c0392b']) CONFIGS.push({ w, h, theme, canvas, accent });
const READERS = QUICK ? [{ w: 960, h: 560, theme: 'dark', canvas: 'original', accent: '' }] : [{ w: 1280, h: 720, theme: 'light', canvas: 'original', accent: '' }, { w: 960, h: 560, theme: 'dark', canvas: 'original', accent: '' }];
const SHOTS = arg('shots');

const H = await startHarness('test-preview-layer', { vitePort0: 5520, cdpPort0: 9540 });
const { evaluate, cdp } = H;
const failures = [];
const fail = (cfg, msg) => failures.push(`[${cfg.w}x${cfg.h} ${cfg.theme} canvas=${cfg.canvas} accent=${cfg.accent || 'default'}] ${msg}`);

// what is on top of every point of a grid over the window: [x, y, in the dialog's layer?, what it is]
const GRID = `(() => {
  const out = [], W = innerWidth, Hh = innerHeight;
  for (let i = 1; i <= 14; i++) for (let j = 1; j <= 9; j++) {
    const x = Math.round(W * i / 15), y = Math.round(Hh * j / 10), el = document.elementFromPoint(x, y);
    out.push([x, y, !!(el && el.closest('.modal-back, .lightbox')), el ? el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] : 'none']);
  }
  return out;
})()`;
// a probe that paints with the variables the dialogs use, in the dialog and in the reading pane: the same colours
const PROBE = (where) => `(() => {
  const host = ${where};
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;width:1px;height:1px;background:var(--bg);color:var(--fg);border:1px solid var(--border);outline:1px solid var(--accent);box-shadow:var(--shadow)';
  const el2 = document.createElement('div'); el2.style.cssText = 'position:absolute;width:1px;height:1px;background:var(--bg3);color:var(--muted)';
  host.appendChild(el); host.appendChild(el2);
  const a = getComputedStyle(el), b = getComputedStyle(el2);
  const r = [a.backgroundColor, a.color, a.borderTopColor, a.outlineColor, a.boxShadow, b.backgroundColor, b.color, getComputedStyle(host).getPropertyValue('--r-lg').trim()].join(' | ');
  el.remove(); el2.remove();
  return r;
})()`;

/** The main window: the conversation opens in the reading pane. */
async function runConfig(cfg, n) {
  const tag = `${cfg.w}x${cfg.h}-${cfg.theme}-${cfg.canvas}${cfg.accent ? '-accent' : ''}`;
  await H.openApp('lang=en', cfg.w, cfg.h);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)}, mailCanvas: ${JSON.stringify(cfg.canvas)}${cfg.accent ? `, accent: ${JSON.stringify(cfg.accent)}` : ''} }); window.__store.getState().select('tlayer'); 1`);
  await exercise(cfg, tag, n);
}

/** The reader pop-out window (the dev preview of it is ?w=reader&thread=<id>): the same components in a window of their own. */
async function runReader(cfg, n) {
  const tag = `reader-${cfg.w}x${cfg.h}-${cfg.theme}`;
  await cdp('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.theme }] });
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=tlayer#lang=en` });
  await sleep(1500);
  await exercise(cfg, tag, n);
}

/** Opens the preview and the picture viewer of the first message of the open conversation and checks them. */
async function exercise(cfg, tag, n) {
  const { press, clickAt, shot } = inputs(H, SHOTS, tag);
  await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.rp-head .icon-btn[aria-label="Expand all"]')) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('the conversation did not open')); } }, 50); })`);
  // all four messages open: the later ones carry the sticky heads and Reply rows that used to paint over the dialog
  await evaluate(`(() => { const b = document.querySelector('.rp-head .icon-btn[aria-label="Expand all"]'); if (b) b.click(); })()`);
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.att-card') || Date.now() - t0 > 5000) { clearInterval(t); ok(1); } }, 50); })`);
  await sleep(500);
  const bodyState = await evaluate(`({ replies: document.querySelectorAll('.rp-reply-row').length, sticky: [...document.querySelectorAll('.rp-msg-body > *')].some((e) => getComputedStyle(e).position === 'sticky') })`);
  if (bodyState.replies < 4) fail(cfg, `only ${bodyState.replies} Reply rows: the conversation is not fully open`);
  const paneProbe = await evaluate(PROBE(`document.querySelector('.rp-body')`));

  // ---------- 1. the preview of a PDF, opened with the keyboard (Space on the card) ----------
  // (a PDF has no preview on Linux, where the engine cannot draw it in the page: a picture stands in there)
  await evaluate(`(() => { const name = /Linux/.test(navigator.userAgent) ? 'photo-orphan.png' : 'agenda.pdf'; const c = [...document.querySelectorAll('.att-card')].find((x) => x.textContent.includes(name)); c.focus(); window.__opener = c; })()`);
  await press(' ', 'Space');
  await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.pv-modal iframe, .pv-modal img, .pv-modal .pv-msg:not(:has(.spin))')) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 8000) { clearInterval(t); no(new Error('the preview did not open')); } }, 50); })`).catch((e) => fail(cfg, e.message));
  await sleep(300);
  await shot('preview-pdf');
  await checkDialog(cfg, '.modal-back', '.pv-modal', 'the preview', paneProbe, press);
  const focusAfterEsc = await closeWithEsc(cfg, press, '.pv-modal', 'the preview');
  if (!focusAfterEsc) fail(cfg, 'after Esc the focus did not go back to the attachment card that opened the preview');

  // a picture / text preview of the same message (the card's own preview button)
  await evaluate(`(() => { const c = [...document.querySelectorAll('.att-card')].find((x) => x.textContent.includes('notes.txt')); c.focus(); })()`);
  await press(' ', 'Space');
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.pv-modal .pv-text') || Date.now() - t0 > 5000) { clearInterval(t); ok(1); } }, 50); })`);
  await shot('preview-text');
  await checkDialog(cfg, '.modal-back', '.pv-modal', 'the text preview', paneProbe, press);
  // a click on the dim layer closes it (the dialog stopped the mouse-down itself: a click inside does not)
  await clickAt(cfg.w - 6, cfg.h - 6);
  await sleep(200);
  if (await evaluate(`!!document.querySelector('.pv-modal')`)) fail(cfg, 'a click on the dim layer did not close the preview');

  // ---------- 2. the picture viewer, opened with the mouse from the pictures menu ----------
  await evaluate(`document.querySelector('.inline-pics').scrollIntoView({ block: 'center' })`);
  await sleep(150);
  const scroll0 = await evaluate(`document.querySelector('.rp-body').scrollTop`);
  const opened = await evaluate(`(() => { const b = document.querySelector('.inline-pics .dd > button'); if (!b) return false; b.click(); return true; })()`);
  if (!opened) { fail(cfg, 'no pictures menu on the first message'); return; }
  await sleep(150);
  const item = await evaluate(`(() => { const i = [...document.querySelectorAll('[role=menuitem], .menu button, .menu-item')].find((x) => /Show all pictures/.test(x.textContent)); if (!i) return null; const r = i.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!item) { fail(cfg, 'no "Show all pictures" entry in the pictures menu'); return; }
  await clickAt(item[0], item[1]);
  await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.lightbox img')) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 6000) { clearInterval(t); no(new Error('the picture viewer did not open')); } }, 50); })`).catch((e) => fail(cfg, e.message));
  await sleep(200);
  await shot('lightbox');
  await checkDialog(cfg, '.lightbox', '.lightbox', 'the picture viewer', null, press);
  await closeWithEsc(cfg, press, '.lightbox', 'the picture viewer');
  const scroll1 = await evaluate(`document.querySelector('.rp-body').scrollTop`);
  if (Math.abs(scroll1 - scroll0) > 1) fail(cfg, `the reading pane scrolled while the dialogs were open (${scroll0} -> ${scroll1})`);
  console.log(`  ok ${tag}: ${n}`);
}

/** The checks both dialogs share: layer, parent, colours, focus. */
async function checkDialog(cfg, layerSel, boxSel, what, paneProbe, press) {
  const grid = await evaluate(GRID);
  const bad = grid.filter((g) => !g[2]);
  if (bad.length) fail(cfg, `${what}: ${bad.length} of ${grid.length} points of the window show something other than the dialog's layer, e.g. ${bad.slice(0, 3).map((g) => `(${g[0]},${g[1]}) ${g[3]}`).join('; ')}`);
  const where = await evaluate(`(() => { const l = document.querySelector(${JSON.stringify(layerSel)}); return { parentIsBody: !!l && l.parentElement === document.body, inRoot: !!l && !!l.closest('#root'), count: document.querySelectorAll(${JSON.stringify(layerSel)}).length }; })()`);
  if (!where.parentIsBody) fail(cfg, `${what}: the dialog's layer is not a child of <body> (it is inside the message again)`);
  if (where.count !== 1) fail(cfg, `${what}: ${where.count} layers`);
  if (paneProbe) {
    const here = await evaluate(PROBE(`document.querySelector(${JSON.stringify(boxSel)})`));
    if (here !== paneProbe) fail(cfg, `${what}: the theme variables resolve differently outside the reading pane:\n      pane   ${paneProbe}\n      dialog ${here}`);
    const colours = await evaluate(`(() => { const m = getComputedStyle(document.querySelector(${JSON.stringify(boxSel)})); return [m.backgroundColor, m.color, m.borderTopColor]; })()`);
    const want = await evaluate(`(() => { const p = document.createElement('div'); p.style.cssText = 'background:var(--bg);color:var(--fg);border:1px solid var(--border)'; document.documentElement.appendChild(p); const s = getComputedStyle(p); const r = [s.backgroundColor, s.color, s.borderTopColor]; p.remove(); return r; })()`);
    if (JSON.stringify(colours) !== JSON.stringify(want)) fail(cfg, `${what}: the dialog paints ${colours.join(' / ')}, the root theme says ${want.join(' / ')}`);
  }
  // the focus goes into the dialog and Tab stays in it
  const inside = `(() => { const l = document.querySelector(${JSON.stringify(layerSel)}); return !!l && l.contains(document.activeElement); })()`;
  if (!(await evaluate(inside))) fail(cfg, `${what}: the focus did not move into the dialog`);
  let left = 0;
  for (let i = 0; i < 14; i++) { await press('Tab', 'Tab'); if (!(await evaluate(inside))) left++; }
  if (left) fail(cfg, `${what}: Tab left the dialog ${left} times out of 14`);
  await press('Tab', 'Tab', 8); // Shift+Tab
  if (!(await evaluate(inside))) fail(cfg, `${what}: Shift+Tab left the dialog`);
}

async function closeWithEsc(cfg, press, boxSel, what) {
  await press('Escape', 'Escape');
  await sleep(250);
  if (await evaluate(`!!document.querySelector(${JSON.stringify(boxSel)})`)) { fail(cfg, `${what}: Esc did not close it`); return false; }
  return evaluate(`!!window.__opener && document.activeElement === window.__opener`);
}

const t0 = Date.now();
try {
  let i = 0;
  for (const cfg of CONFIGS) await runConfig(cfg, `${++i}/${CONFIGS.length + READERS.length}`);
  for (const cfg of READERS) await runReader(cfg, `${++i}/${CONFIGS.length + READERS.length}`);
}
catch (e) { failures.push(`crashed: ${e.stack || e}`); }
finally { await H.shutdown(); }
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (failures.length) { console.error(`test-preview-layer: FAILED (${CONFIGS.length} configurations, ${secs}s)\n\n  ` + [...new Set(failures)].join('\n  ')); process.exit(1); }
console.log(`test-preview-layer: ok (${CONFIGS.length} main window + ${READERS.length} reader window configurations; ${secs}s)`);
