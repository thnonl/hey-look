#!/usr/bin/env node
// Confidential mail leftovers (1.0.7 WP8c), real components in the dev preview (`#wp8` adds the attachments and the Confidential conversations of src/devMock.ts), real clicks and keys (Input.dispatch*):
//   - W8.8c  the attachment preview steps through the previewable cards of the strip: a.png, b.txt, c.pdf, d.zip -> "1 of 3", ArrowRight twice reaches c.pdf, a third stays, ArrowLeft goes back, the
//            archive is never in the list; the same strip in a Confidential message is "1 of 2" (no PDF) and has no Open / Save as (AC-8.8c.1, 8.8c.2); the card you start from sets the place;
//   - W8.8d  an event from Confidential mail: while its popover or its dialog is open the window asks for capture protection (the mock logs every set_content_protected), the description cannot be
//            selected or copied, Duplicate and Save .ics stay on screen, greyed, with the reason as their tooltip; a normal event has none of it (AC-8.8d.1 to 8.8d.3);
//   - W8.8e  the banner of a Confidential message is the new text on Windows and macOS and the Linux text on Linux, in all 8 languages and without clipping at 960 x 560; Print Screen shows the
//            "screen capture is turned off" toast on Windows and none on Linux (AC-8.8e.1 to 8.8e.3);
//   - W8.8f  links and remote pictures are unchanged (comments only, pinned by source).
//   node scripts/test-conf-ui.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { readFileSync } from 'node:fs';
import { loadDict } from './lib/i18n-dicts.mjs';
import { languageJs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-conf-ui', { vitePort0: 5080, cdpPort0: 9080 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } return !!cond; };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const LANGS = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const dicts = {};
for (const l of LANGS) dicts[l] = await loadDict(l);
const L = (lang, key) => dicts[lang][key];

const mouse = async (x, y, clickCount = 1) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
};
const key = async (k, code = k, vk = 0) => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const ARROW_R = ['ArrowRight', 'ArrowRight', 39];
const ARROW_L = ['ArrowLeft', 'ArrowLeft', 37];
const pvHead = () => evaluate(`(() => { const n = document.querySelector('.pv-name'); const x = document.querySelector('.pv-head .muted'); return { name: n ? n.textContent : null, of: x ? x.textContent : null, open: [...document.querySelectorAll('.pv-head .btn')].map((b) => b.textContent.trim()) }; })()`);
const openThread = async (id) => {
  await evaluate(`window.__store.getState().openMail(${JSON.stringify(id)}); 1`);
  await waitFor(`document.querySelector('.att-card, .conf-banner, .ai-btn')`, 6000);
  await sleep(300);
};
const cardPoint = (name) => evaluate(`(() => { const c = [...document.querySelectorAll('.att-card')].find((x) => x.querySelector('.att-name')?.textContent === ${JSON.stringify(name)}); if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.querySelector('.att-main').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);

try {
  // ------------------------------------------------------------------ W8.8c: Previous / Next across the strip
  tag = 'preview';
  await H.openApp('lang=en&nativemenu=off&wp8', 1280, 800);
  await openThread('tw8-att');
  ok(await waitFor(`document.querySelectorAll('.att-card').length === 4`), 'four attachment cards');
  let pt = await cardPoint('a.png');
  await mouse(pt[0], pt[1], 2);
  ok(await waitFor(`!!document.querySelector('.pv-name')`), 'a.png: the preview opens');
  let h = await pvHead();
  ok(h.name === 'a.png' && h.of === L('en', 'reading.pv.xOfY').replace('{i}', '1').replace('{total}', '3'), `1 of 3 (${JSON.stringify(h)})`);
  await key(...ARROW_R);
  await waitFor(`document.querySelector('.pv-name')?.textContent === 'b.txt'`);
  h = await pvHead();
  ok(h.name === 'b.txt' && /2/.test(h.of) && /3/.test(h.of), `-> b.txt, 2 of 3 (${JSON.stringify(h)})`);
  await key(...ARROW_R);
  await waitFor(`document.querySelector('.pv-name')?.textContent === 'c.pdf'`);
  h = await pvHead();
  ok(h.name === 'c.pdf' && /3.*3/.test(h.of), `-> c.pdf, 3 of 3 (${JSON.stringify(h)})`);
  await key(...ARROW_R);
  await sleep(250);
  h = await pvHead();
  ok(h.name === 'c.pdf', `a third ArrowRight stays on the last (${JSON.stringify(h)}), the archive d.zip is never reached`);
  await key(...ARROW_L);
  await waitFor(`document.querySelector('.pv-name')?.textContent === 'b.txt'`);
  ok((await pvHead()).name === 'b.txt', 'ArrowLeft goes back');
  ok(h.open.length === 2, `an ordinary message has Open and Save as (${JSON.stringify(h.open)})`);
  await key('Escape', 'Escape', 27);
  ok(await waitFor(`!document.querySelector('.pv-name')`), 'Escape closes');

  // the card you start from sets the place
  pt = await cardPoint('b.txt');
  await mouse(pt[0], pt[1], 2);
  await waitFor(`!!document.querySelector('.pv-name')`);
  h = await pvHead();
  ok(h.name === 'b.txt' && /2/.test(h.of), `starting from b.txt: 2 of 3 (${JSON.stringify(h)})`);
  await key('Escape', 'Escape', 27);
  await waitFor(`!document.querySelector('.pv-name')`);
  // the keyboard: Space on a focused card
  await evaluate(`[...document.querySelectorAll('.att-card')].find((x) => x.querySelector('.att-name')?.textContent === 'a.png').focus(); 1`);
  await key(' ', 'Space', 32);
  ok(await waitFor(`document.querySelector('.pv-name')?.textContent === 'a.png'`), 'Space opens the focused card');
  ok(/1/.test((await pvHead()).of ?? ''), 'and it has the n of m');
  await key('Escape', 'Escape', 27);
  await waitFor(`!document.querySelector('.pv-name')`);

  // Confidential: the same strip, no PDF (AC-8.8c.2), nothing leaves the app
  await openThread('tw8-att-conf');
  ok(await waitFor(`document.querySelectorAll('.att-card').length === 4`), 'the Confidential message has the four cards');
  pt = await cardPoint('a.png');
  await mouse(pt[0], pt[1], 2);
  await waitFor(`!!document.querySelector('.pv-name')`);
  h = await pvHead();
  ok(h.name === 'a.png' && /1/.test(h.of) && /2/.test(h.of), `Confidential: 1 of 2 (${JSON.stringify(h)})`);
  ok(h.open.length === 0, `no Open / Save as in a Confidential message (${JSON.stringify(h.open)})`);
  await key(...ARROW_R);
  await waitFor(`document.querySelector('.pv-name')?.textContent === 'b.txt'`);
  await key(...ARROW_R);
  await sleep(250);
  ok((await pvHead()).name === 'b.txt', 'the PDF is not in the list: ArrowRight stays on b.txt');
  await key('Escape', 'Escape', 27);
  await waitFor(`!document.querySelector('.pv-name')`);

  // ------------------------------------------------------------------ W8.8e: the banner per system and language
  tag = 'banner';
  for (const os of ['windows', 'macos', 'linux']) {
    await H.openApp(`lang=en&nativemenu=off&wp8&os=${os}`, 1280, 800);
    await openThread('tconf');
    ok(await waitFor(`!!document.querySelector('.conf-banner')`), `${os}: the banner`);
    const text = await evaluate(`document.querySelector('.conf-banner').textContent.trim()`);
    const want = L('en', os === 'linux' ? 'reading.protect.noteLinux' : 'reading.protect.note');
    ok(text === want, `${os}: the banner says ${JSON.stringify(want)} (${JSON.stringify(text)})`);
    ok(os === 'linux' ? !/screen capture,/i.test(text) && /can’t block screen capture/.test(text) : /screen capture, copying, printing, forwarding and the AI Assistant/.test(text), `${os}: ${os === 'linux' ? 'says Linux cannot block capture' : 'names screen capture and the AI Assistant'}`);
    // Print Screen: the toast on Windows and macOS, none on Linux
    await key('PrintScreen', 'PrintScreen', 44);
    await sleep(500);
    const toast = await evaluate(`[...document.querySelectorAll('.toast-text, .toasts')].map((e) => e.textContent).join('|')`);
    const has = toast.includes(L('en', 'reading.protect.captureOff'));
    ok(os === 'linux' ? !has : has, `${os}: Print Screen ${os === 'linux' ? 'shows no "turned off" toast' : 'shows the toast'} (${JSON.stringify(toast.slice(0, 80))})`);
  }

  // all 8 languages, both texts, at 960 x 560: no raw key, nothing clipped
  tag = 'languages';
  for (const os of ['windows', 'linux']) {
    await H.openApp(`lang=en&nativemenu=off&wp8&os=${os}`, 960, 560);
    await openThread('tconf');
    await waitFor(`!!document.querySelector('.conf-banner')`);
    for (const lang of LANGS) {
      await evaluate(languageJs(lang));
      await sleep(200);
      const r = await evaluate(`(() => { const b = document.querySelector('.conf-banner'); if (!b) return null; const q = b.getBoundingClientRect(); return { text: b.textContent.trim(), over: b.scrollWidth - b.clientWidth, right: q.right, vw: innerWidth, h: q.height, lh: parseFloat(getComputedStyle(b).lineHeight) || 18 }; })()`);
      const want = L(lang, os === 'linux' ? 'reading.protect.noteLinux' : 'reading.protect.note');
      ok(r && r.text === want, `${os} ${lang}: the banner text (${JSON.stringify(r && r.text.slice(0, 60))})`);
      ok(r && r.over <= 1 && r.right <= r.vw && r.h < r.lh * 5, `${os} ${lang}: not clipped (${JSON.stringify(r && { over: r.over, right: r.right, vw: r.vw, h: r.h })})`);
      ok(r && !/reading\.protect/.test(r.text), `${os} ${lang}: no raw key`);
    }
  }

  // ------------------------------------------------------------------ W8.8d: events from Confidential mail
  tag = 'events';
  await H.openApp('lang=en&nativemenu=off&wp8', 1280, 800);
  await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  await waitFor(`document.querySelector('.cal-view')`);
  await evaluate(`(() => { const t = Math.floor(new Date().setHours(17, 0, 0, 0) / 1000); window.__mockAddEvent('confx', 'Board secret', t, t + 3600, { confidential: true, description: 'Revenue is down 12 percent' }); window.__mockAddEvent('plainx', 'Lunch plan', t - 7200, t - 3600, { description: 'Bring the menu' }); const s = window.__store.getState(); const d = new Date(); s.setCalView('agenda'); s.setCalDate({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }); return 1; })()`);
  await waitFor(`document.querySelectorAll('.ag-row').length > 1`);
  await sleep(500);
  const rowPoint = (text) => evaluate(`(() => { const e = [...document.querySelectorAll('.ag-row')].find((x) => (x.getAttribute('aria-label') || x.textContent).includes(${JSON.stringify(text)})); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 40), r.top + r.height / 2]; })()`);
  const protectLog = () => evaluate(`window.__protectLog || []`);
  const closeAll = async () => { for (let i = 0; i < 3; i++) { if (!(await evaluate(`!!document.querySelector('.ev-pop, .modal')`))) break; await key('Escape', 'Escape', 27); await sleep(150); } };
  const popState = () => evaluate(`(() => {
    const p = document.querySelector('.ev-pop'); if (!p) return null;
    const btn = (n) => { const b = [...p.querySelectorAll('.ev-foot button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === n); return b ? { disabled: b.disabled, title: b.title } : null; };
    const d = [...p.querySelectorAll('.ev-details .muted.small')].find((x) => /Revenue|menu/.test(x.textContent));
    let prevented = null;
    if (d) { const ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true }); d.dispatchEvent(ev); prevented = ev.defaultPrevented; }
    return { dup: btn('Duplicate'), ics: btn('Save .ics'), sel: d ? getComputedStyle(d).userSelect : null, webkitSel: d ? getComputedStyle(d).webkitUserSelect : null, prevented };
  })()`);
  const OFF = L('en', 'calendar.pop.confidentialOff');

  let p = await rowPoint('Board secret');
  const before = (await protectLog()).length;
  await mouse(p[0], p[1]);
  ok(await waitFor(`!!document.querySelector('.ev-pop')`), 'the popover of the Confidential event opens');
  await sleep(400);
  let s = await popState();
  const log = await protectLog();
  ok(log.length > before && log[log.length - 1] === true, `capture protection asked while it is open (${JSON.stringify(log)})`);
  ok(s.dup && s.dup.disabled && s.dup.title === OFF, `Duplicate is greyed with the reason (${JSON.stringify(s.dup)})`);
  ok(s.ics && s.ics.disabled && s.ics.title === OFF, `Save .ics is greyed with the reason (${JSON.stringify(s.ics)})`);
  ok(s.sel === 'none' || s.webkitSel === 'none', `the description cannot be selected (${s.sel})`);
  ok(s.prevented === true, 'copying the description is prevented');
  // Edit: the dialog of the event has the same protection
  await evaluate(`[...document.querySelectorAll('.ev-foot button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === 'Edit').click(); 1`);
  ok(await waitFor(`!!document.querySelector('#ev-notes')`), 'Edit opens the event dialog');
  await sleep(500);
  const dlg = await evaluate(`(() => { const t = document.querySelector('#ev-notes'); const ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true }); t.dispatchEvent(ev); const cut = new ClipboardEvent('cut', { bubbles: true, cancelable: true }); t.dispatchEvent(cut); return { copy: ev.defaultPrevented, cut: cut.defaultPrevented, value: t.value, log: window.__protectLog || [] }; })()`);
  ok(dlg.copy && dlg.cut, 'the dialog: copying and cutting the notes are prevented');
  ok(dlg.log[dlg.log.length - 1] === true, 'the dialog: capture protection is on');
  await closeAll();
  await sleep(300);
  const after = await protectLog();
  ok(after[after.length - 1] === false, `capture protection is off after it closes (${JSON.stringify(after)})`);

  // AC-8.8d.3 a normal event: nothing of it
  p = await rowPoint('Lunch plan');
  const n0 = (await protectLog()).length;
  await mouse(p[0], p[1]);
  ok(await waitFor(`!!document.querySelector('.ev-pop')`), 'the popover of a normal event opens');
  await sleep(400);
  s = await popState();
  const log2 = await protectLog();
  ok(log2.length === n0, `no protection call for a normal event (${JSON.stringify(log2.slice(n0))})`);
  ok(s.dup && !s.dup.disabled && s.ics && !s.ics.disabled, `Duplicate and Save .ics work (${JSON.stringify([s.dup, s.ics])})`);
  ok(s.prevented === false, `copying the description is not blocked (${s.prevented}; the app's own rule keeps most text unselectable anyway)`);
  await closeAll();

  // the reason in all 8 languages, as a tooltip of the greyed button
  for (const lang of LANGS) {
    await evaluate(languageJs(lang));
    await sleep(200);
    p = await rowPoint('Board secret');
    if (!p) { ok(false, `${lang}: the Confidential event is on screen`); continue; }
    await mouse(p[0], p[1]);
    await waitFor(`!!document.querySelector('.ev-pop')`);
    await sleep(350);
    const tips = await evaluate(`[...document.querySelectorAll('.ev-foot button[disabled]')].map((b) => b.title)`);
    ok(tips.length === 2 && tips.every((x) => x === L(lang, 'calendar.pop.confidentialOff')), `${lang}: both greyed buttons say ${JSON.stringify(L(lang, 'calendar.pop.confidentialOff'))} (${JSON.stringify(tips)})`);
    await closeAll();
  }

  // ------------------------------------------------------------------ W8.8f: unchanged, written down
  tag = 'links';
  const rp = readFileSync(new URL('../src/components/ReadingPane.tsx', import.meta.url), 'utf8');
  const pr = readFileSync(new URL('../src/protect.ts', import.meta.url), 'utf8');
  ok(/Confidential mail \(1\.0\.7 W8\.8f, decided and unchanged\)/.test(rp) && /W8\.8f, decided and unchanged/.test(pr), 'the decision is written down in ReadingPane.tsx and protect.ts');
  console.log(`test-conf-ui: ${checks} checks`);
} catch (e) {
  failures.push(`[${tag}] ${e.stack || e}`);
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`test-conf-ui: FAILED (${failures.length})\n  ` + failures.slice(0, 30).join('\n  '));
  process.exit(1);
}
console.log('test-conf-ui: ok');
