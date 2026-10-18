#!/usr/bin/env node
// A press elsewhere closes an open popover - inside a dialog (W1.1, v1.0.6 QA BUG-2) and on the Windows title bar or in the message text (W1.2, BUG-3).
// Why it failed: the outside-press listeners were on document in the bubble phase; the Modal box stops the press (stopPropagation) and Tauri's drag script
// stops a press on a drag region (stopImmediatePropagation) before it got there. They are in the capture phase now (a press in the message's iframe is
// relayed by contextGuard.ts guardFrame).
//
// Real pane in the dev preview (src/devMock.ts), REAL mouse presses (Input.dispatchMouseEvent), no dispatched DOM events:
//   dialog   Settings > General: "Default account" menu open, a press on the blank header, on the General tab, on a label of the body closes it and
//            leaves Settings open; Esc closes only the menu and the second Esc the dialog; a press on a menu row runs it
//   popups   the event dialog: the 4 date / time popups (Start / End date and time) close on a press on the blank header; the dialog and the fields stay
//   palette  Settings > Signatures, signature editor: the font colour palette closes on a press on the name field, which gets the focus
//   topbar   ?frame=win (the simulated custom title bar) with a document listener that copies Tauri's drag script (stopImmediatePropagation on a press
//            in a data-tauri-drag-region): Send later and the Language menu close on a press on the logo and on an empty part of the bar, and the
//            listener did see the press (the drag still starts; nothing here stops the press)
//   message  a press inside the message text (the iframe) closes the snooze menu of the reading pane
//
//   node scripts/test-outside-press.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-outside-press', { vitePort0: 5700, cdpPort0: 9700 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };

const mouse = async (x, y, button = 'left') => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  await sleep(150);
};
const centre = (sel, nth = 0) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; if (e.closest('.settings-body, .modal-body, .modal')) e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const clickSel = async (sel, nth = 0) => { const p = await centre(sel, nth); if (!p) throw new Error(`no ${sel}`); await mouse(p[0], p[1]); };
const press = async (key, vk) => {
  const p = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
  await sleep(150);
};
const count = (sel) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
// a point of the dialog header with nothing interactive under it (right of the title, left of the close button)
const headerBlank = () => evaluate(`(() => { const h = document.querySelector('.modal-head, .modal > header, .modal .mh'); if (!h) return null; const r = h.getBoundingClientRect(); const y = r.top + r.height / 2; for (let x = r.left + r.width * 0.6; x < r.right; x += 8) { const t = document.elementFromPoint(x, y); if (t && h.contains(t) && !t.closest('button, a, input, select, textarea, [role=button]')) return [x, y]; } return null; })()`);
const waitStore = () => evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (window.__store && window.__store.getState().accounts.length) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('app did not start')); } }, 100); })`);

async function dialogCases(w, h, theme) {
  tag = `dialog ${w}x${h} ${theme}`;
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); window.__store.getState().setDialog({ type: 'settings' }); 1`);
  await sleep(600);
  const OPEN = '.modal .settings button[aria-haspopup]';
  const trigger = `(() => { const b = [...document.querySelectorAll('.settings button[aria-haspopup]')].find((x) => x.getAttribute('aria-label') === 'Default account' || x.closest('.set-row, .row')?.textContent.includes('Default account')); return b ? [...document.querySelectorAll('.settings button[aria-haspopup]')].indexOf(b) : -1; })()`;
  const at = await evaluate(trigger);
  ok(at >= 0, 'no Default account button');
  const open = async () => { await clickSel(OPEN, at); await sleep(250); };

  // press on the blank header
  await open();
  ok(await count('.dd-fixed') === 1, 'the Default account menu did not open');
  const hb = await headerBlank();
  ok(!!hb, 'no blank point in the dialog header');
  if (hb) await mouse(hb[0], hb[1]);
  ok(await count('.dd-fixed') === 0, 'the menu stays open after a press on the blank dialog header');
  ok(await count('.modal') === 1, 'the dialog closed with the menu (header press)');
  // press on the General tab text
  await open();
  await clickSel('.settings-nav button.active');
  ok(await count('.dd-fixed') === 0, 'the menu stays open after a press on the General tab');
  ok(await count('.modal') === 1, 'the dialog closed (tab press)');
  // press on a label of the dialog body
  await open();
  const lbl = await evaluate(`(() => { const e = [...document.querySelectorAll('.settings *')].find((x) => x.children.length === 0 && /^Undo window|^Date format/.test(x.textContent.trim())); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + 6, r.top + r.height / 2]; })()`);
  ok(!!lbl, 'no label in the dialog body');
  if (lbl) await mouse(lbl[0], lbl[1]);
  ok(await count('.dd-fixed') === 0, 'the menu stays open after a press on the dialog body');
  ok(await count('.modal') === 1, 'the dialog closed (body press)');
  // middle and right button
  for (const b of ['middle', 'right']) {
    await open();
    if (hb) await mouse(hb[0], hb[1], b);
    ok(await count('.dd-fixed') === 0, `the menu stays open after a ${b}-button press on the header`);
    await press('Escape', 27); // (a context menu from the right press, if any)
    if (await count('.modal') === 0) await evaluate(`window.__store.getState().setDialog({ type: 'settings' }); 1`), await sleep(500);
  }
  // Esc: only the menu; the second Esc the dialog
  await open();
  await press('Escape', 27);
  ok(await count('.dd-fixed') === 0 && await count('.modal') === 1, 'the first Esc must close only the menu');
  await press('Escape', 27);
  ok(await count('.modal') === 0, 'the second Esc must close the dialog');
  // a press on a menu row runs it
  await evaluate(`window.__store.getState().setDialog({ type: 'settings' }); 1`);
  await sleep(500);
  await open();
  const before = await evaluate(`window.__store.getState().prefs.defaultAccount ?? ''`);
  const rows = await count('.dd-fixed [role=menuitem], .dd-fixed button');
  ok(rows >= 2, 'the menu has no rows');
  const pick = await evaluate(`(() => { const rs = [...document.querySelectorAll('.dd-fixed [role=menuitem], .dd-fixed button')]; return rs.length - 1; })()`);
  await clickSel('.dd-fixed [role=menuitem], .dd-fixed button', pick);
  await sleep(250);
  ok(await count('.dd-fixed') === 0, 'the menu stays open after a press on a row');
  ok((await evaluate(`window.__store.getState().prefs.defaultAccount ?? ''`)) !== before, 'a press on a menu row did not run the row');
  ok(await count('.modal') === 1, 'a press on a menu row closed the dialog');
  // a press on the backdrop closes the dialog with its menu
  await open();
  await mouse(4, 4);
  ok(await count('.modal') === 0 && await count('.dd-fixed') === 0, 'a press on the backdrop must close the dialog and the menu');
}

async function eventCases(w, h, theme) {
  tag = `event ${w}x${h} ${theme}`;
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); window.__store.getState().setDialog({ type: 'event' }); 1`);
  await sleep(600);
  const n = await count('.modal button.dt-pick');
  ok(n === 4, `the event dialog has ${n} date / time buttons, expected 4`);
  for (let i = 0; i < n; i++) {
    await clickSel('.modal button.dt-pick', i);
    await sleep(250);
    ok(await count('.fld-pop') === 1, `popup ${i + 1} did not open`);
    const hb = await headerBlank();
    if (hb) await mouse(hb[0], hb[1]);
    ok(await count('.fld-pop') === 0, `popup ${i + 1} stays open after a press on the dialog header`);
    ok(await count('.modal') === 1, `the event dialog closed with popup ${i + 1}`);
  }
  // a press on a field closes the popup and focuses the field
  await clickSel('.modal button.dt-pick', 0);
  await sleep(250);
  await clickSel('.modal input[type=text], .modal input:not([type])');
  ok(await count('.fld-pop') === 0, 'popup stays open after a press on the title field');
  ok(await evaluate(`document.activeElement?.tagName === 'INPUT'`), 'the press on the title field did not focus it');
}

async function paletteCase(w, h) {
  tag = `palette ${w}x${h}`;
  await H.openApp('lang=en', w, h);
  const id = await evaluate(`window.__store.getState().accounts[0].id`);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:' + ${JSON.stringify(id)} }); 1`);
  await sleep(600);
  const sig = await evaluate(`(() => { const b = [...document.querySelectorAll('.nav-sub button')].find((x) => /Signatures/i.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  ok(sig, 'no Signatures section');
  await sleep(400);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.settings button.btn')].find((x) => /New signature/i.test(x.textContent)); b?.click(); return !!b; })()`);
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.settings .rich .ProseMirror') || Date.now() - t0 > 8000) { clearInterval(t); ok(1); } }, 100); })`);
  await sleep(500);
  const col = await evaluate(`(() => { const b = [...document.querySelectorAll('.settings .rich button')].find((x) => x.getAttribute('aria-label') === 'Font color options'); return b ? [...document.querySelectorAll('.settings .rich button')].indexOf(b) : -1; })()`);
  ok(col >= 0, 'no Font color button in the signature editor');
  if (col < 0) return;
  await clickSel('.settings .rich button', col);
  await sleep(300);
  ok(await count('.fmt-pop-color') === 1, 'the font colour palette did not open');
  await clickSel('.settings input[aria-label="Name"]');
  ok(await count('.fmt-pop-color') === 0, 'the palette stays open after a press on the name field');
  ok(await evaluate(`document.activeElement?.getAttribute('aria-label') === 'Name'`), 'the press on the name field did not focus it');
  ok(await count('.modal') === 1, 'Settings closed with the palette');
  // Esc closes only the palette
  await clickSel('.settings .rich button', col);
  await sleep(300);
  await press('Escape', 27);
  ok(await count('.fmt-pop-color') === 0 && await count('.modal') === 1, 'Esc must close only the palette');
}

// Tauri's drag script (tauri-2.x/src/window/scripts/drag.js): on document, bubble phase, registered before the app: a press on a drag region is stopped for every
// later listener. Copied here so the fix is tested against the same kind of blocker.
const TAURI_DRAG = `
  window.__dragSeen = 0;
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const path = e.composedPath();
    for (const el of path) {
      if (!(el instanceof HTMLElement)) continue;
      const v = el.getAttribute('data-tauri-drag-region');
      if (v === 'false') return;
      if (el.matches('a, button, input, select, textarea, [role=button]')) return;
      if (v === 'deep' || v === 'true' || v === '') { window.__dragSeen++; e.stopImmediatePropagation(); return; }
    }
  });`;

async function topBarCases(w, h, theme) {
  tag = `topbar ${w}x${h} ${theme}`;
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const script = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: TAURI_DRAG });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: `${H.base}?frame=win#lang=en` });
      await sleep(600);
      try { await waitStore(); break; } catch (e) { if (attempt === 4) throw e; }
    }
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); 1`);
    await sleep(400);
    ok(await evaluate(`document.querySelector('.topbar')?.getAttribute('data-tauri-drag-region') === 'deep'`), 'the top bar has no drag region (?frame=win did not give the custom frame)');
    // an empty point of the bar between the search box and the buttons
    const empty = await evaluate(`(() => { const bar = document.querySelector('.topbar'), r = bar.getBoundingClientRect(), y = r.top + r.height / 2; const stop = document.querySelector('.top-actions').getBoundingClientRect().left - 4; for (let x = stop; x > r.left + 200; x -= 6) { const t = document.elementFromPoint(x, y); if (t === bar || t?.classList.contains('top-spacer')) return [x, y]; } return null; })()`);
    ok(!!empty, 'no empty point in the top bar');
    const spots = [['logo', await centre('.topbar .brand img')], ['title', await centre('.topbar .brand span')], ['empty bar', empty]];
    // Language menu
    for (const [name, p] of spots) {
      if (!p) continue;
      await clickSel('.top-actions button[aria-haspopup]');
      await sleep(250);
      const opened = await count('.dd-fixed');
      ok(opened === 1, `the Language menu did not open (${name})`);
      const seen0 = await evaluate('window.__dragSeen');
      await mouse(p[0], p[1]);
      ok(await count('.dd-fixed') === 0, `the Language menu stays open after a press on the ${name}`);
      ok((await evaluate('window.__dragSeen')) === seen0 + 1, `the drag script did not see the press on the ${name} (it must still run: the window drag starts from it)`);
    }
    // Send later (compose, Send later popover)
    await evaluate(`window.__store.getState().openCompose({ accountId: window.__store.getState().accounts[0].id, to: [], subject: '' }); 1`);
    await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap') || Date.now() - t0 > 12000) { clearInterval(t); ok(1); } }, 100); })`);
    await sleep(500);
    for (const [name, p] of spots) {
      if (!p) continue;
      await clickSel('.compose-pane button.split-caret');
      await sleep(300);
      ok(await count('.sched-pop') === 1, `Send later did not open (${name})`);
      await mouse(p[0], p[1]);
      ok(await count('.sched-pop') === 0, `Send later stays open after a press on the ${name}`);
    }
  } finally {
    await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
  }
}

async function messageCase(w, h) {
  tag = `message ${w}x${h}`;
  await H.openApp('lang=en', w, h);
  await evaluate(`(async () => { const s = window.__store.getState(); await s.select(s.threads[0].threadId); return 1; })()`);
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { const f = document.querySelector('iframe.msg-frame'); if ((f && f.contentDocument?.body?.textContent.trim()) || Date.now() - t0 > 10000) { clearInterval(t); ok(1); } }, 100); })`);
  await sleep(600);
  ok(await count('iframe.msg-frame') >= 1, 'no message frame');
  await clickSel('.rp-tools .snooze-btn');
  await sleep(250);
  ok(await count('.dd-fixed') === 1, 'the snooze menu did not open');
  const f = await evaluate(`(() => { const e = document.querySelector('iframe.msg-frame'), r = e.getBoundingClientRect(); return [r.left + 20, r.top + 12]; })()`);
  await mouse(f[0], f[1]);
  ok(await count('.dd-fixed') === 0, 'the snooze menu stays open after a press inside the message text');
}

try {
  for (const [w, h, theme] of [[960, 560, 'light'], [1280, 800, 'dark']]) {
    await dialogCases(w, h, theme);
    await eventCases(w, h, theme);
  }
  await paletteCase(960, 560);
  await topBarCases(960, 560, 'light');
  await topBarCases(1280, 800, 'dark');
  await messageCase(1280, 800);
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-outside-press: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-outside-press: ${checks} checks passed`);
