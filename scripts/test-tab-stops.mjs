#!/usr/bin/env node
// Tab and Shift+Tab stop only on things a person can see (W1.5 / W1.14, v1.0.7). v1.0.6 QA round 5 O-3: Tab from Start time of a meeting reached a zero-size file
// input (the attachment picker) before Room; the Appearance preview held rows with tabIndex 0 inside an aria-hidden box.
//
// Real panes in the dev preview (src/devMock.ts), real Tab key events (Input.dispatchKeyEvent):
//   compose     a new message with Meeting on, 946 x 552 and 1280 x 800 (and as the compose window of its own at 560 x 440): from To through the header to the
//               body and back with Shift+Tab. Every stop: a box with a size, whole inside the window, not a file input, not inside a hidden / display:none element,
//               an outline or other visible sign of focus. Every <input type=file> of the page has hidden, aria-hidden and tabIndex -1.
//   appearance  Settings > Appearance: a Tab walk through the whole tab never stops inside .ap-preview (the preview is inert) and does reach "Shuffle"
//
//   node scripts/test-tab-stops.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-tab-stops', { vitePort0: 5720, cdpPort0: 9720 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };

const tab = async (shift = false) => {
  const p = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
  await sleep(60);
};
// what the focused element is, and whether a person can see it
const STOP = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return { name: 'body' };
  // a switch is a visually hidden checkbox with a drawn track: its label is the box a person sees (the ring is on the track)
  const r = (e.closest('label.switch') || e).getBoundingClientRect();
  const hiddenUp = (() => { for (let x = e; x && x.nodeType === 1; x = x.parentElement) { if (x.hidden || x.getAttribute('aria-hidden') === 'true' || x.hasAttribute('inert')) return x.tagName.toLowerCase() + (x.className ? '.' + String(x.className).split(' ')[0] : ''); const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden') return 'display/visibility on ' + x.tagName.toLowerCase(); } return null; })();
  const label = e.getAttribute('aria-label') || e.title || (e.textContent || '').trim().slice(0, 30) || e.placeholder || '';
  const cs = getComputedStyle(e);
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' || e.matches(':focus-visible');
  return { name: e.tagName.toLowerCase() + (e.type ? '[' + e.type + ']' : '') + ' "' + label + '"', w: r.width, h: r.height, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, file: e.type === 'file', hiddenUp, ring, inPreview: !!e.closest('.ap-preview'), cls: String(e.className || ''), body: !!e.closest('.ProseMirror'), inCompose: !!e.closest('.compose-pane'), cy: r.top + r.height / 2 };
})()`;
const waitEditor = () => evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap') || Date.now() - t0 > 15000) { clearInterval(t); ok(1); } }, 100); })`);

async function composeWalk(label, mode, w, h) {
  tag = `compose ${label}`;
  if (mode === 'main') {
    await H.openApp('lang=en', w, h);
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Q4 contract call', meeting: { on: true } }); 1`);
    await waitEditor();
  } else {
    // the compose window in a plain tab (the mock answers popout_init); Meeting is switched on by its button, or by the More menu in a small window
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en` });
    await sleep(800);
    await waitEditor();
    await sleep(500);
    await evaluate(`(() => { const p = document.querySelector('.cp-bar [aria-pressed]'); if (p) { p.click(); return 1; } document.querySelector('.cp-bar .rb.more').click(); return 0; })()`);
    await sleep(300);
    await evaluate(`(() => { const r = [...document.querySelectorAll('.dd-fixed [role=menuitem], .dd-fixed button')].find((x) => /^Meeting/.test(x.textContent.trim())); r?.click(); return !!r; })()`);
    await evaluate(`(document.querySelector('.compose-pane input[aria-label="Subject"]') || document.querySelector('.compose-pane input[placeholder*="ubject"]')).focus(); 1`);
  }
  await sleep(700);
  ok(await evaluate(`!!document.querySelector('.compose-pane input[aria-label="Start date"]')`), 'Meeting is not on');
  const files = await evaluate(`[...document.querySelectorAll('input[type=file]')].map((i) => ({ hidden: i.hidden, aria: i.getAttribute('aria-hidden'), tab: i.tabIndex }))`);
  ok(files.length >= 2, `only ${files.length} file inputs found in the compose pane`);
  for (const f of files) ok(f.hidden && f.aria === 'true' && f.tab === -1, `a file input is not hidden / aria-hidden / tabIndex -1: ${JSON.stringify(f)}`);
  // start in the Subject field, walk down to the body, then back
  await evaluate(`(document.querySelector('.compose-pane input[aria-label="Subject"]') || document.querySelector('.compose-pane input[placeholder*="ubject"]')).focus(); 1`);
  const walk = async (shift) => {
    const seen = [];
    for (let i = 0; i < 60; i++) {
      await tab(shift);
      const s = await evaluate(STOP);
      seen.push(s);
      if (process.env.TABDEBUG) console.log(shift ? 'S+Tab' : 'Tab', i + 1, JSON.stringify(s));
      ok(s.name !== 'body', `${shift ? 'Shift+' : ''}Tab ${i + 1}: the focus is on nothing (the page body)`);
      if (s.name === 'body') break;
      ok(s.w > 0 && s.h > 0, `${shift ? 'Shift+' : ''}Tab ${i + 1}: ${s.name} has no size (${s.w} x ${s.h})`);
      ok(s.inside || (s.body && s.cy > 0 && s.cy < 9999), `${shift ? 'Shift+' : ''}Tab ${i + 1}: ${s.name} is not whole inside the window`);
      ok(!s.file, `${shift ? 'Shift+' : ''}Tab ${i + 1}: a file input has the focus`);
      ok(!s.hiddenUp, `${shift ? 'Shift+' : ''}Tab ${i + 1}: ${s.name} is inside a hidden element (${s.hiddenUp})`);
      ok(s.ring, `${shift ? 'Shift+' : ''}Tab ${i + 1}: ${s.name} shows no sign of focus`);
      if (!shift && s.body) break; // the body of the message ends the walk down
    }
    return seen;
  };
  const down = await walk(false);
  ok(down.some((s) => s.body), 'Tab never reached the body of the message');
  // back up with Shift+Tab until the top of the header (To) is reached
  await evaluate(`(document.querySelector('.compose-pane input[aria-label="Subject"]') || document.querySelector('.compose-pane input[placeholder*="ubject"]')).focus(); 1`);
  const up = [];
  for (let i = 0; i < 40; i++) {
    await tab(true);
    const s = await evaluate(STOP);
    up.push(s);
    if (process.env.TABDEBUG) console.log('S+Tab up', i + 1, JSON.stringify(s));
    if (s.name === 'body') { ok(up.length > 3, `Shift+Tab ${i + 1}: the focus is on nothing`); break; } // (past the first control of a window: the browser's own)
    if (!s.inCompose) break; // (the walk left the pane: the splitter of the list comes before it)
    ok(s.w > 0 && s.h > 0 && s.inside && !s.file && !s.hiddenUp, `Shift+Tab ${i + 1}: ${s.name} is not a visible stop (${JSON.stringify(s)})`);
  }
}

async function appearanceWalk() {
  tag = 'appearance';
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().setPrefs({ focused: true }); window.__store.getState().setDialog({ type: 'settings', tab: 'appearance' }); 1`);
  await sleep(800);
  const pv = await evaluate(`(() => { const p = document.querySelector('.ap-preview'); return p ? { inert: p.hasAttribute('inert'), aria: p.getAttribute('aria-hidden'), rows: [...p.querySelectorAll('[tabindex]')].map((e) => e.getAttribute('tabindex')) } : null; })()`);
  ok(!!pv, 'no .ap-preview in Settings > Appearance');
  if (!pv) return;
  ok(pv.inert, 'the preview has no inert attribute');
  ok(pv.aria === 'true', 'the preview lost aria-hidden');
  ok(pv.rows.length > 0 && pv.rows.every((r) => r === '-1'), `the preview rows are not tabIndex -1: ${JSON.stringify(pv.rows)}`);
  // click "Other" and a row in the preview: nothing changes (focused stays on)
  const before = await evaluate(`JSON.stringify([window.__store.getState().prefs.focused, window.__store.getState().selected])`);
  const pts = await evaluate(`(() => { const p = document.querySelector('.ap-preview'); const o = p.querySelector('.ap-pivots span:not(.active)'); const row = p.querySelector('.ml-row'); const c = (e) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }; return [c(o), c(row)]; })()`);
  for (const [x, y] of pts) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
  }
  ok((await evaluate(`JSON.stringify([window.__store.getState().prefs.focused, window.__store.getState().selected])`)) === before, 'a click in the preview changed the preferences or the selection');
  ok(await evaluate(`!document.activeElement?.closest('.ap-preview')`), 'a click in the preview moved the focus into it');
  // Tab walk from the settings navigation through the whole tab
  await evaluate(`document.querySelector('.settings-nav button.active').focus(); 1`);
  let shuffle = false;
  for (let i = 0; i < 120; i++) {
    await tab(false);
    const s = await evaluate(STOP);
    if (process.env.TABDEBUG) console.log('A Tab', i + 1, s.name);
    ok(!s.inPreview, `Tab ${i + 1}: the focus is inside the preview (${s.name})`);
    if (/Shuffle|different sample mail/.test(s.name)) shuffle = true; // (its accessible name)
    if (shuffle && i > 60) break;
    if (s.name === 'body') break;
  }
  ok(shuffle, 'Tab never reached "Shuffle"');
}

try {
  await composeWalk('main 946x552', 'main', 946, 552);
  await composeWalk('main 1280x800', 'main', 1280, 800);
  await composeWalk('window 560x440', 'popout', 560, 440);
  await appearanceWalk();
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-tab-stops: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-tab-stops: ${checks} checks passed`);
