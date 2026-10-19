#!/usr/bin/env node
// 1.0.7 D-012, D-003, D-018: the scrolled header of the compose pane with the meeting strip on.
//
// QA r4 (Windows) and the Mac round: at 960 x 480 with Meeting on, a focus in Where scrolled the header so that To sat ABOVE the header box and the When row was cut in half by the
// sticky action row; the Where row had no sign of being there until it was focused. The cause is the room, not the scroll: the header box has 77 px under the action row at that size
// (142 px of window chrome above the pane, 42 px action row, 39 px formatting row and a body that keeps 180 px), and To down to Where is 170 px. What the page can do is to leave
// the box at rest on WHOLE rows (src/headerRows.ts: no row cut by the top of the part that shows, the focused control whole), and to say that more is below (the shade over the last
// 14 px, `data-more-below`). Where the box is tall enough for To down to the focused field - a window of 960 x 480 of its own (the pop-out), 1280 x 800 - To is in sight.
//
// This measures it with the bounding boxes of the real page (the dev preview, src/devMock.ts) at 960 x 480 and 1280 x 800 - and 946 x 552, a 960 x 560 window, the least there is -
// in the main window and in the compose window, light and dark: for every control of the header focused (from the top and from the bottom of the scroll)
//   - it is whole inside the part of the header that shows (under the sticky action row, above the formatting row) and is what is under its own pixels,
//   - no row of the header is cut by the top of that part (a row is whole, or wholly out of it),
//   - with Where focused: To is whole in sight when the part that shows is tall enough for To down to Where, and wholly out of sight (not half) when it is not,
//   - the shade is there when more of the header is below the box, and not when the header is at its end or fits whole (the pixel of the shade against the pane: light and dark).
//
//   node --experimental-strip-types scripts/test-header-rows.mjs --require-browser          (24 combinations, about 100 s)
//   node --experimental-strip-types scripts/test-header-rows.mjs --quick --require-browser   (4 combinations: what CI runs)
//   --only="main 960x480 light"   one combination
import { settledScroll } from '../src/headerRows.ts';
import { HEADER_PROBE_JS } from './lib/header-rows-probe.mjs';
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

// ---------- the rule itself ----------
{
  const rows = [{ top: 0, bottom: 28 }, { top: 28, bottom: 62 }, { top: 62, bottom: 96 }, { top: 96, bottom: 126 }, { top: 126, bottom: 155 }, { top: 161, bottom: 190 }];
  const base = { max: 200, view: 119, bar: 42, rows };
  // nothing cut: left alone
  assert.equal(settledScroll({ ...base, s: 96 - 42, focus: { top: 161, bottom: 190 } }), 54);
  // the row 126-155 is cut by the top of the part that shows (s + bar = 140): scrolled up to its top, when the control stays whole
  assert.equal(settledScroll({ ...base, s: 98, focus: { top: 161, bottom: 190 } }), 84, 'the cut row is shown whole (126 - 42)');
  // ... and down (the row gone) when the control would not be whole with it: the control ends at 230, the box shows [s, s + 119]
  assert.equal(settledScroll({ ...base, s: 98, rows: [...rows, { top: 200, bottom: 230 }], focus: { top: 200, bottom: 230 } }), 113, 'the cut row is gone: 155 - 42');
  // no position that keeps the control whole: the browser's own
  assert.equal(settledScroll({ ...base, s: 98, view: 60, focus: { top: 126, bottom: 180 } }), 98);
  // an action row that scrolls away (bar 0)
  assert.equal(settledScroll({ ...base, bar: 0, s: 40, focus: { top: 62, bottom: 96 } }), 28, 'row 28-62 is cut at 40: shown whole');
  // never out of the box
  assert.equal(settledScroll({ ...base, max: 70, s: 69, focus: { top: 161, bottom: 190 } }) <= 70, true);
}

// ---------- the real page ----------
const H = await startHarness('test-header-rows', { vitePort0: 5940 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (cfg, c, m) => { checks++; if (!c) { failures.push(`[${cfg.tag}] ${m}`); console.error(`FAIL [${cfg.tag}] ${m}`); } };
const press = async (key, code, modifiers = 0) => { const p = { key, code, modifiers }; await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p }); };

const BAR_SEL = '[data-fit=meeting]';
async function switchMeetingOn() {
  if (await evaluate(`(() => { const e = document.querySelector('.cp-bar ${BAR_SEL}'); if (!e) return false; e.click(); return true; })()`)) return;
  // a small pane: Meeting is the first row of "More actions"
  await evaluate(`document.querySelector('.cp-bar .rb.more').click(); 1`); await sleep(150);
  await evaluate(`document.querySelectorAll('.dd-fixed [role^=menuitem][aria-checked]')[0].click(); 1`); await sleep(150);
}

async function open(cfg) {
  const hash = 'lang=en&aiset';
  if (cfg.mode === 'main') {
    await H.openApp(hash, cfg.w, cfg.h);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); window.__store.setState({ aiConfigured: true }); 1`);
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], cc: ['bob@northwind.io'], subject: 'Q4 contract call' }); 1`);
    await sleep(900);
  } else {
    await cdp('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#${hash}` });
    await sleep(600);
    await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap')) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('compose window did not start')); } }, 100); })`);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); 1`);
    await sleep(300);
    // To and Cc as in the main window
    await evaluate(`document.querySelectorAll('.cp-fields .rcpt input')[0].focus()`); await cdp('Input.insertText', { text: 'alice@fabrikam.com,' }); await sleep(120);
    await evaluate(`document.querySelector('.compose-pane').dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true })); 1`); await sleep(150);
    await evaluate(`document.querySelectorAll('.cp-fields .rcpt input')[1].focus()`); await cdp('Input.insertText', { text: 'bob@northwind.io,' }); await sleep(120);
    await evaluate(`document.querySelector('.cf-subject input').focus()`); await cdp('Input.insertText', { text: 'Q4 contract call' }); await sleep(100);
    await sleep(300);
  }
  await switchMeetingOn();
  await sleep(500);
  await evaluate(`document.activeElement && document.activeElement.blur(); 1`);
}

// the page side: the probe that the QA sessions of the Mac and Linux run through the test bridge (scripts/lib/header-rows-probe.mjs)
const GEO = HEADER_PROBE_JS;
const headBox = () => evaluate(`(() => { const r = document.querySelector('.cp-head').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);

// the colour of a pixel of the page (a screenshot of one pixel decoded in the page)
async function pixel(x, y) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1, scale: 1 } });
  return evaluate(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(i, 0, 0); ok(Array.from(g.getImageData(0, 0, 1, 1).data).slice(0, 3)); }; i.src = 'data:image/png;base64,${shot.data}'; })`);
}
const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

const CONFIGS = [];
for (const [w, h] of [[960, 480], [946, 552], [1280, 800]]) for (const mode of ['main', 'popout']) for (const theme of ['light', 'dark']) CONFIGS.push({ w, h, mode, theme, tag: `${mode} ${w}x${h} ${theme}` });
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const QUICK = ['main 960x480 dark', 'popout 960x480 light', 'main 946x552 light', 'main 1280x800 dark'];

// every control of the header, in the order of the page: To, Cc, Subject, the strip (When, the times, All day), Where
const STOPS = `[...document.querySelectorAll('.cp-fields .rcpt input, .cf-subject input, .cp-event input, .cp-event select, .cp-event button, #mt-where')].filter((e) => e.getBoundingClientRect().height > 0 && !e.disabled).map((e, i) => { e.setAttribute('data-stop', i); return i; })`;

for (const cfg of CONFIGS) {
  if (only && !cfg.tag.includes(only)) continue;
  if (process.argv.includes('--quick') && !QUICK.includes(cfg.tag)) continue;
  await open(cfg);
  const stops = await evaluate(STOPS);
  ok(cfg, stops.length >= 5, `only ${stops.length} controls in the header`);
  const geo0 = await evaluate(GEO);
  // the shade follows the content: at rest (scrolled to the top) it is on when the header overflows its box, and off when everything fits
  const overflow = geo0.scrollH > geo0.clientH + 1;
  await evaluate(`document.querySelector('.cp-head').scrollTop = 0; 1`); await sleep(120);
  const rest = await evaluate(GEO);
  ok(cfg, rest.cueOpacity === (overflow ? '1' : '0'), `the shade (::after) has opacity ${rest.cueOpacity} at rest, the header ${overflow ? 'overflows' : 'fits'}`);
  ok(cfg, rest.more === overflow, `at rest the cue is ${rest.more ? 'on' : 'off'} but the header ${overflow ? 'overflows' : 'fits'} (${rest.scrollH} in ${rest.clientH})`);
  if (overflow) {
    // the pixel: the shade darkens a light pane and lightens a dark one at the lower edge of the box, in the left margin where no field is
    const hb = await headBox();
    const x = hb.l + 5, edge = await pixel(x, hb.b - 2), plain = await pixel(x, hb.b - 24);
    ok(cfg, Math.abs(lum(edge) - lum(plain)) >= 4, `no shade at the lower edge of the header: ${edge} against ${plain}`);
  }
  // the end of the scroll: no cue
  await evaluate(`const h = document.querySelector('.cp-head'); h.scrollTop = h.scrollHeight; 1`); await sleep(120);
  const end = await evaluate(GEO);
  ok(cfg, !end.more, 'at the end of the scroll the cue is still on');
  // every control, focused from the top and from the bottom of the scroll
  for (const from of ['top', 'bottom']) {
    for (const i of stops) {
      await evaluate(`(() => { const h = document.querySelector('.cp-head'); document.activeElement && document.activeElement.blur(); h.scrollTop = ${from === 'top' ? 0 : 'h.scrollHeight'}; })()`); await sleep(60);
      await evaluate(`document.querySelector('[data-stop="${i}"]').focus(); 1`); await sleep(110);
      const g = await evaluate(GEO);
      const f = g.focus;
      if (cfg.mode === 'main' && g.paneH > 0) ok(cfg, g.paneClass.includes('has-meeting') && (cfg.h > 600 || g.bodyH >= 119.5), `the body of a message with a meeting is ${g.bodyH} px (pane ${g.paneH}, ${g.paneClass})`);
      if (!f) { ok(cfg, false, `stop ${i} did not take the focus`); continue; }
      const where = `${f.name} from the ${from} (box shows ${Math.round(g.top)}-${Math.round(g.bottom)}, scroll ${Math.round(g.scroll)} of ${Math.round(g.scrollH - g.clientH)})`;
      ok(cfg, f.t >= g.top - 1 && f.b <= g.bottom + 1, `${where}: not whole in the part that shows: ${Math.round(f.t)}-${Math.round(f.b)}`);
      ok(cfg, f.hit, `${where}: something else is on top of it`);
      ok(cfg, g.cut.length === 0, `${where}: a row is cut by the top of the part that shows: ${g.cut.join(', ')}`);
      if (f.name.startsWith('input#mt-where')) {
        // To down to Where in one piece when the part that shows is tall enough
        const needed = f.b - g.to.t;
        if (g.band >= needed) ok(cfg, g.to.t >= g.top - 1 && g.to.b <= g.bottom + 1, `${where}: the part that shows is ${Math.round(g.band)} px, To down to Where ${Math.round(needed)}: To is not whole in sight (${Math.round(g.to.t)}-${Math.round(g.to.b)})`);
        else ok(cfg, g.to.b <= g.top + 1 || g.to.t >= g.bottom - 1, `${where}: To is half in sight (${Math.round(g.to.t)}-${Math.round(g.to.b)} in ${Math.round(g.top)}-${Math.round(g.bottom)})`);
        console.log(`  ${cfg.tag}: Where focused from the ${from}: the header shows ${Math.round(g.band)} px, To to Where ${Math.round(needed)} px; To ${g.to.b <= g.top + 1 ? 'is above the box' : 'is in sight'}`);
      }
    }
  }
  // the whole header fits (no scroll): everything is in sight, no cue
  if (!overflow) {
    await evaluate(`document.querySelector('.cp-head').scrollTop = 0; 1`);
    const g = await evaluate(GEO);
    ok(cfg, g.to && g.to.t >= g.top - 1, `the header fits, and To is not in sight (${JSON.stringify(g.to)} in ${g.top}-${g.bottom})`);
  }
}

await H.shutdown();
if (failures.length) { console.error(`test-header-rows: ${failures.length} of ${checks} checks FAILED`); process.exit(1); }
console.log(`test-header-rows: ${checks} checks ok`);
