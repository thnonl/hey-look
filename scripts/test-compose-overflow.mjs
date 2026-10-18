#!/usr/bin/env node
// The labelled action row of the compose pane is ONE row in every language; what does not fit is in "More actions" (W1.7, 1.0.7). The pure rule and the combinations of window sizes and
// languages are in scripts/test-compose-fit.mjs; this one drives the real row in the dev preview (src/devMock.ts):
//   resize   a compose window from 1900 px down to 600 and back: at no width two rows, nothing sticks out, the actions move into More one by one from the end (never fewer when it
//            shrinks, never more when it grows) and come back in the same order
//   language a compose open in English is switched to German and Russian: the row fits again at once (the next frame), still one row
//   menu     "More actions" lists exactly the actions that moved, in the order of the row, with a divider only between sections (none at the top, at the bottom or twice in a row)
//   works    a moved action works from the menu: Confidential and High importance (checked in the menu, the dot on More), Meeting (the strip comes and goes), Write with AI
//   keys     Tab goes through the row (Send, Discard, Attach, the actions that stayed) and then reaches More actions; nothing of the hidden measuring copy takes the focus;
//            More opens with the arrow keys and Enter runs a row
//
//   node scripts/test-compose-overflow.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const ORDER = ['picture', 'meeting', 'encrypt', 'sign', 'confidential', 'importance', 'saveDraft', 'templates', 'ai'];
const H = await startHarness('test-compose-overflow', { vitePort0: 5780, cdpPort0: 9780 });
const { evaluate, cdp, base } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };

const press = async (key, vk, modifiers = 0) => {
  const p = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
  await sleep(80);
};
const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const GEO = `(() => {
  const bar = document.querySelector('.cp-bar'); if (!bar) return null;
  const r = bar.getBoundingClientRect();
  return { h: r.height, right: r.right, kidsRight: Math.max(...[...bar.children].map((e) => e.getBoundingClientRect().right)), compact: !!document.querySelector('.compose-pane.compact'),
    fit: [...bar.querySelectorAll(':scope > [data-fit]:not([data-fit=fixed])')].map((e) => e.getAttribute('data-fit')), more: !!bar.querySelector('.rb.more'), dot: !!bar.querySelector('.rb.more .more-dot') };
})()`;
const geo = () => evaluate(GEO);

async function openWindow(lang, w, h, extra = '') {
  await size(w, h);
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${base}?w=compose&mock=new#lang=${lang}&aiset${extra}` });
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap') || Date.now() - t0 > 15000) { clearInterval(t); ok(1); } }, 100); })`);
  await sleep(700);
}
const openMore = async () => { await evaluate(`document.querySelector('.cp-bar .rb.more').click(); 1`); await sleep(250); };
const closeMenu = async () => { await press('Escape', 27); await sleep(150); };
const MENU = `(() => { const m = document.querySelector('.dd-fixed .menu'); if (!m) return null; return [...m.children].map((e) => e.classList.contains('menu-div') ? '---' : e.textContent.trim()); })()`;
const rowsClean = (rows) => rows[0] !== '---' && rows[rows.length - 1] !== '---' && rows.every((r, i) => !(r === '---' && rows[i - 1] === '---'));

try {
  // ---- resize (1900 px: everything fits even in German)
  tag = 'resize';
  await openWindow('de', 1900, 700);
  let prevMoved = -1, prevFit = null;
  const steps = [];
  for (let w = 1900; w >= 600; w -= 50) steps.push(w);
  for (const w of steps) {
    await size(w, 700);
    await sleep(160);
    const g = await geo();
    ok(g && !g.compact, `${w}: the pane is compact`);
    ok(g.h <= 52, `${w}: the action row is ${g.h} px high: two rows`);
    ok(g.kidsRight <= g.right - 14 + 0.5, `${w}: the row sticks out (${g.kidsRight} > ${g.right - 14})`);
    const kept = ORDER.slice(0, g.fit.length);
    ok(JSON.stringify(g.fit) === JSON.stringify(kept), `${w}: the row keeps ${g.fit} (not the start of the order)`);
    ok(g.more === g.fit.length < ORDER.length, `${w}: More is ${g.more ? 'there' : 'missing'} with ${g.fit.length} actions in the row`);
    const moved = ORDER.length - g.fit.length;
    if (prevMoved >= 0) ok(moved >= prevMoved, `${w}: ${moved} actions in More after ${prevMoved} at a wider pane (it must not grow back while shrinking)`);
    prevMoved = moved;
    prevFit = g.fit;
  }
  ok(prevMoved > 0, 'at 600 px nothing moved into More: the test did not reach the point where the row is full');
  // and back: they return in the same order
  prevMoved = 99;
  for (const w of [...steps].reverse()) {
    await size(w, 700);
    await sleep(160);
    const g = await geo();
    ok(g.h <= 52, `${w} (growing): the action row is ${g.h} px high`);
    const moved = ORDER.length - g.fit.length;
    ok(moved <= prevMoved, `${w} (growing): ${moved} actions in More after ${prevMoved} at a narrower pane`);
    prevMoved = moved;
  }
  ok(prevMoved === 0, `at 1900 px ${prevMoved} actions are still in More`);

  // ---- a language switch re-fits at once (the compose window follows the preferences of the main page: here the page itself)
  tag = 'language';
  await openWindow('en', 960, 560);
  const en = await geo();
  ok(en.h <= 52, `English: ${en.h} px`);
  for (const lang of ['de', 'ru', 'en']) {
    await evaluate(`window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); 1`);
    await sleep(120);
    const g = await geo();
    ok(g.h <= 52, `${lang}: the row is ${g.h} px high right after the switch`);
    ok(g.kidsRight <= g.right - 14 + 0.5, `${lang}: the row sticks out right after the switch`);
    ok(JSON.stringify(g.fit) === JSON.stringify(ORDER.slice(0, g.fit.length)), `${lang}: the order of the row is broken: ${g.fit}`);
  }

  // ---- the menu: exactly the moved actions, in order, dividers only between sections
  tag = 'menu';
  await openWindow('de', 800, 700);
  const g = await geo();
  const moved = ORDER.filter((id) => !g.fit.includes(id));
  ok(moved.length >= 3 && g.more, `at 800 px in German only ${moved.length} actions moved`);
  await openMore();
  const rows = await evaluate(MENU);
  ok(!!rows, 'More actions did not open');
  ok(rowsClean(rows), `dividers at the top / bottom / twice in a row: ${JSON.stringify(rows)}`);
  const label = (id) => evaluate(`(() => { const e = document.querySelector('.cp-probe [data-fit=${id}]'); if (!e) return []; return ${JSON.stringify(id)} === 'importance' ? [...e.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) : [(e.querySelector('button') || e).textContent.trim()]; })()`);
  let at = 0;
  for (const id of moved) {
    for (const text of await label(id)) {
      const i = rows.findIndex((r, j) => j >= at && r.startsWith(text));
      ok(i >= 0, `${id}: no row "${text}" at or after row ${at} of the menu ${JSON.stringify(rows)}`);
      if (i >= 0) at = i + 1;
    }
  }
  for (const id of ORDER.filter((x) => g.fit.includes(x))) for (const text of await label(id)) ok(!rows.some((r) => r.startsWith(text)) || id === 'templates', `${id} is in the row and in the menu`);
  await closeMenu();

  // ---- a moved action works from the menu
  tag = 'works';
  await openWindow('de', 700, 700);
  const w0 = await geo();
  ok(w0.fit.length < ORDER.length - 3, `at 700 px in German ${w0.fit} stayed in the row`);
  const act = async (id, text) => {
    await openMore();
    await evaluate(`(() => { const r = [...document.querySelectorAll('.dd-fixed [role^=menuitem]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); r.click(); return 1; })()`);
    await sleep(250);
  };
  const checked = async (text) => { await openMore(); const v = await evaluate(`(() => { const r = [...document.querySelectorAll('.dd-fixed [role=menuitemradio]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); return r ? r.getAttribute('aria-checked') : null; })()`); await closeMenu(); return v; };
  const conf = (await label('confidential'))[0], high = (await label('importance'))[0];
  if (!w0.fit.includes('confidential')) {
    await act('confidential', conf);
    ok((await checked(conf)) === 'true', 'Confidential from More actions: not checked afterwards');
    ok((await geo()).dot, 'Confidential from More actions: no dot on More actions');
    await act('confidential', conf);
    ok((await checked(conf)) === 'false', 'Confidential from More actions: still on after the second press');
  }
  if (!w0.fit.includes('importance')) {
    await act('importance', high);
    ok((await checked(high)) === 'true', 'High importance from More actions: not checked afterwards');
    ok((await geo()).dot, 'High importance from More actions: no dot on More actions');
    await act('importance', high);
    ok((await checked(high)) === 'false', 'High importance from More actions: still on after the second press');
    // the dot says whether a moved action is on (Encrypt can be on by itself): it follows the checked rows of the menu
    await openMore();
    const anyOn = await evaluate(`!![...document.querySelectorAll('.dd-fixed [role=menuitemradio][aria-checked=true]')].find((r) => !/importance|Wichtigkeit/i.test(r.textContent))`);
    await closeMenu();
    ok((await geo()).dot === anyOn, `the dot on More actions is ${(await geo()).dot}, a moved action is ${anyOn ? 'on' : 'off'}`);
  }
  if (!w0.fit.includes('meeting')) {
    const meet = (await label('meeting'))[0];
    await act('meeting', meet);
    ok(await evaluate(`!!document.querySelector('.compose-pane input[aria-label="Start date"]')`), 'Meeting from More actions: no strip');
    await act('meeting', meet);
    ok(await evaluate(`!document.querySelector('.compose-pane input[aria-label="Start date"]')`), 'Meeting from More actions: the strip stays');
  }
  if (!w0.fit.includes('ai')) {
    const ai = (await label('ai'))[0];
    await act('ai', ai);
    ok(await evaluate(`!!document.querySelector('.cp-ai textarea')`), 'Write with AI from More actions: no box');
  }
  ok((await geo()).h <= 52, 'the row is one row after the actions were used');

  // ---- keys: Tab through the row, then More; the hidden copy takes no focus; the menu opens with the keys
  tag = 'keys';
  await openWindow('de', 800, 700);
  const k = await geo();
  await evaluate(`document.querySelector('.cp-bar .split-btn button').focus(); 1`);
  const stops = [];
  for (let i = 0; i < 20; i++) {
    await press('Tab', 9);
    const s = await evaluate(`(() => { const e = document.activeElement; const fit = e.closest('[data-fit]'); const b = e.getBoundingClientRect(); return { fit: fit ? fit.getAttribute('data-fit') : (e.classList.contains('more') ? 'more' : null), probe: !!e.closest('.cp-probe'), inBar: !!e.closest('.cp-bar'), w: b.width, onscreen: b.right > 0 && b.left < innerWidth }; })()`);
    ok(!s.probe, `Tab ${i + 1}: the focus is in the hidden copy of the row`);
    if (!s.inBar) break;
    ok(s.w > 0 && s.onscreen, `Tab ${i + 1}: a stop that cannot be seen`);
    stops.push(s.fit);
    if (s.fit === 'more') break;
  }
  ok(stops[stops.length - 1] === 'more', `Tab never reached More actions: ${stops}`);
  const inRow = stops.filter((x) => x && x !== 'fixed' && x !== 'more');
  ok(JSON.stringify([...new Set(inRow)]) === JSON.stringify(k.fit), `Tab went through ${[...new Set(inRow)]}, the row has ${k.fit}`);
  await press('ArrowDown', 40);
  await sleep(250);
  ok(!!(await evaluate(MENU)), 'ArrowDown on More actions did not open the menu');
  await press('ArrowDown', 40);
  await press('Escape', 27);
  ok(!(await evaluate(MENU)), 'Escape did not close the menu');
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-compose-overflow: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-compose-overflow: ${checks} checks passed`);
