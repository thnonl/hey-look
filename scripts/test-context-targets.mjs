#!/usr/bin/env node
// Right-click on every kind of target (D-036, v1.0.7): the webview's own menu is OFF everywhere except in fields that take text.
//
// Real pane in the dev preview (src/devMock.ts, `#nativemenu=off` = the release behaviour; the app shell of a built app, debug or release, has it without
// the switch, see nativeMenuWanted), REAL right clicks (Input.dispatchMouseEvent button right) and, in the message's frame, a synthetic contextmenu
// too (what the bridge probe of the Mac / Linux checks does). After the guard a recorder listener reads `defaultPrevented`: true = the engine shows no
// menu; false = the engine's own menu would show. For each target:
//   message body (frame, inline pane)      prevented, ONE app text menu, at the click point in window coordinates (frame offset added)
//   message body, text selected            same, Copy enabled
//   reader window (?w=reader) body         prevented, ONE app text menu (the pop-out windows must not mount a second host)
//   list row, folder label, mailbox header, ribbon button, reading-pane header and subject, top bar, Settings text and select, dialog backdrop
//                                          prevented (an app menu or nothing, never the engine's)
//   search box, Subject, To, compose body (ProseMirror), Settings text input
//                                          NOT prevented, no app menu: the engine's menu (spell check, Paste)
//   <object> / <embed> (a PDF in the engine's viewer)  NOT prevented
// and in the preview the native menu stays by default (Inspect) and `#nativemenu=on` / `off` behave as documented. Light and dark.
//
//   node scripts/test-context-targets.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';
import { runProbe } from './lib/context-menu-probe.mjs';

const H = await startHarness('test-context-targets', { vitePort0: 5800 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };

const waitFrame = () => evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { const f = document.querySelector('iframe.msg-frame'); if ((f && f.contentDocument?.body?.textContent.trim() && f.offsetHeight > 40) || Date.now() - t0 > 12000) { clearInterval(t); ok(1); } }, 100); })`);
// a recorder behind the guard: window / frame document, bubble phase (the guard is in the capture phase), one entry per contextmenu event
const RECORD = `(() => {
  window.__ctx = [];
  const seen = (window.__ctxSeen ||= new WeakSet());
  const rec = (where) => (e) => window.__ctx.push({ where, prevented: e.defaultPrevented, tag: e.target.tagName || '', cls: String(e.target.className && e.target.className.baseVal !== undefined ? e.target.className.baseVal : e.target.className || '').slice(0, 40) });
  if (!seen.has(window)) { seen.add(window); window.addEventListener('contextmenu', rec('window'), false); }
  for (const f of document.querySelectorAll('iframe.msg-frame')) { try { if (!seen.has(f.contentDocument)) { seen.add(f.contentDocument); f.contentDocument.addEventListener('contextmenu', rec('frame'), false); } } catch {} }
  return 1;
})()`;
const record = () => evaluate(RECORD);
const last = () => evaluate(`window.__ctx[window.__ctx.length - 1] || null`);
const menus = () => evaluate(`[...document.querySelectorAll('.ctx-menu')].map((m) => { const r = m.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, items: [...m.querySelectorAll('[role=menuitem]')].map((x) => ({ text: x.textContent.trim(), disabled: x.getAttribute('aria-disabled') === 'true' })) }; })`);
const closeMenus = async () => { if (!(await evaluate(`!!document.querySelector('.ctx-menu')`))) return; await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(120); };

const rightClick = async (x, y) => {
  await evaluate(`window.__ctx.length = 0`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(220);
};
/** window point of the first element of `sel` (scrolled into view; inside a dialog body too) */
const centre = (sel, nth = 0) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + Math.min(r.width / 2, 24)), Math.round(r.top + r.height / 2)]; })()`);
/** window point on the first words of the message text inside the first message frame */
const framePoint = (select) => evaluate(`(() => {
  const f = document.querySelector('iframe.msg-frame'); const d = f.contentDocument; const fr = f.getBoundingClientRect();
  const w = document.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.nodeValue.trim() || n.parentElement.closest('a')) continue;
    const r = d.createRange(); r.setStart(n, 0); r.setEnd(n, Math.min(n.nodeValue.length, 4));
    const q = r.getClientRects()[0]; if (!q || !q.width) continue;
    if (${select ? 'true' : 'false'}) { const s = d.getSelection(); const all = d.createRange(); all.selectNodeContents(n); s.removeAllRanges(); s.addRange(all); }
    return [Math.round(fr.left + q.left + q.width / 2), Math.round(fr.top + q.top + q.height / 2), Math.round(fr.left), Math.round(fr.top)];
  }
  return null; })()`);

/** The event reached the page and the engine's menu is suppressed (prevented) or left alone (native), and how many app menus are open. */
async function expectAt(label, x, y, want, appMenus = null) {
  await rightClick(x, y);
  const e = await last();
  if (process.env.DBG) console.log(label, x, y, JSON.stringify(await evaluate(`({ ctx: window.__ctx, at: (document.elementFromPoint(${x}, ${y}) || {}).className, fr: !!document.querySelector('iframe.msg-frame') })`)));
  ok(!!e, `${label}: no contextmenu event reached the page at ${x},${y}`);
  if (!e) return null;
  if (want === 'prevented') ok(e.prevented === true, `${label}: the engine's menu would show (defaultPrevented false on ${e.tag}.${e.cls})`);
  else ok(e.prevented === false, `${label}: the field's own menu was suppressed (defaultPrevented true on ${e.tag}.${e.cls})`);
  const m = await menus();
  if (appMenus !== null) ok(m.length === appMenus, `${label}: ${m.length} app menu(s) open, expected ${appMenus}`);
  return { e, m };
}
async function expectOn(label, sel, want, appMenus = null, nth = 0) {
  const p = await centre(sel, nth);
  ok(!!p, `${label}: nothing matches ${sel}`);
  if (!p) return null;
  const r = await expectAt(label, p[0], p[1], want, appMenus);
  await closeMenus();
  return r;
}

async function app(theme, w = 1280, h = 800, hash = 'lang=en&nativemenu=off') {
  await H.openApp(hash, w, h);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); 1`);
  await sleep(250);
  await record();
}
const selectFirst = async () => {
  await evaluate(`(async () => { const s = window.__store.getState(); await s.select(s.threads[0].threadId); return 1; })()`);
  await waitFrame();
  await sleep(500);
  await record();
};

async function mainCases(theme) {
  tag = `main ${theme}`;
  await app(theme);

  // ---- outside the reading pane, nothing selected yet
  await expectOn('list row', '.ml-row', 'prevented', 1);
  await expectOn('folder label', '.fp-lbl', 'prevented');
  const mb = await evaluate(`document.querySelectorAll('[data-own-menu]').length`);
  ok(mb >= 1, 'no element marked data-own-menu');
  await expectOn('ribbon button', '.ribbon-row .rb, .ribbon-row button', 'prevented', 0);
  await expectOn('top bar', '.topbar', 'prevented');
  // the search box is a field that takes text
  await expectOn('search box', '.topbar input', 'native', 0);
  await evaluate(`document.activeElement && document.activeElement.blur(); 1`);
  if (await evaluate(`!!document.querySelector('.sb-title')`)) { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(200); }
  ok(!(await evaluate(`!!document.querySelector('.sb-title')`)), 'the search popover is still open');

  // ---- the open message: header, subject and the frame
  await selectFirst();
  await expectOn('reading-pane subject', '.rp-head h2', 'prevented', 1);
  await expectOn('message header sender', '.rp-msg-head .rp-from', 'prevented', 1);
  await expectOn('reading-pane tool button', '.rp-tools button', 'prevented', 0);

  const p = await framePoint(false);
  ok(!!p, 'no text in the message frame');
  if (p) {
    const r = await expectAt('message body', p[0], p[1], 'prevented', 1);
    if (r) {
      ok(r.e.where === 'frame', `message body: the event reached ${r.e.where}, expected the frame's document`);
      const m = r.m[0];
      ok(!!m && Math.abs(m.left - p[0]) <= 2 && Math.abs(m.top - p[1]) <= 2, `message body: the menu is at ${m && Math.round(m.left)},${m && Math.round(m.top)}, the click was at ${p[0]},${p[1]} (frame offset ${p[2]},${p[3]} must be added)`);
      const names = (m?.items ?? []).map((x) => x.text.replace(/Ctrl\+\w$/, '').replace(/Cmd\+\w$/, '').trim());
      ok(names.some((n) => /^Copy/.test(n)) && names.some((n) => /Select all/.test(n)), `message body: entries ${JSON.stringify(names)}`);
      ok(m?.items.find((x) => /^Copy/.test(x.text))?.disabled === true, 'message body without a selection: Copy is greyed');
    }
    await closeMenus();
    // text selected in the frame: Copy is enabled
    const q = await framePoint(true);
    const r2 = await expectAt('message body, selected', q[0], q[1], 'prevented', 1);
    ok(r2?.m[0]?.items.find((x) => /^Copy/.test(x.text))?.disabled === false, 'message body, selected: Copy is enabled');
    await closeMenus();
    // a synthetic event in the frame's document (what the Mac / Linux bridge probe does)
    const synth = await evaluate(`(() => { const d = document.querySelector('iframe.msg-frame').contentDocument; const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 20, view: d.defaultView }); d.body.dispatchEvent(ev); return ev.defaultPrevented; })()`);
    ok(synth === true, 'synthetic contextmenu in the frame document: defaultPrevented is false');
    await sleep(150);
    await closeMenus();
  }

  // the QA probe of the Mac / Linux session (scripts/lib/context-menu-probe.mjs): the same verdicts on this window
  const pr = await runProbe((body) => evaluate(`(async () => { ${body} })()`), sleep);
  ok(pr.pass && pr.frame?.ok && pr.closed, `the QA probe fails: ${JSON.stringify(pr)}`);

  // ---- Settings: label text, a select, a text input, the backdrop
  await evaluate(`window.__store.getState().setDialog({ type: 'settings' }); 1`);
  await sleep(700);
  const lbl = await evaluate(`(() => { const e = [...document.querySelectorAll('.settings *')].find((x) => x.children.length === 0 && x.getBoundingClientRect().width > 0 && /^(Undo window|Date format|Default account|Language)/.test(x.textContent.trim())); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + 8), Math.round(r.top + r.height / 2)]; })()`);
  ok(!!lbl, 'no label text in Settings');
  if (lbl) { await expectAt('Settings text', lbl[0], lbl[1], 'prevented', 1); await closeMenus(); }
  await expectOn('Settings select/menu button', '.settings button[aria-haspopup]', 'prevented', 0);
  const inp = await evaluate(`!!document.querySelector('.settings input[type=text], .settings input:not([type]), .settings textarea')`);
  if (inp) await expectOn('Settings text input', '.settings input[type=text], .settings input:not([type]), .settings textarea', 'native', 0);
  await expectAt('dialog backdrop', 4, 4, 'prevented', 0);
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await sleep(200);

  // ---- Compose: To, Subject and the body are fields that take text
  tag = `compose ${theme}`;
  await evaluate(`(async () => { await window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello there', bodyHtml: '<p>Some text to write</p>' }); return 1; })()`);
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.cf-subject input') && document.querySelector('.ProseMirror') || Date.now() - t0 > 10000) { clearInterval(t); ok(1); } }, 100); })`);
  await sleep(500);
  await expectOn('compose Subject', '.cf-subject input', 'native', 0);
  await expectOn('compose To input', '.cf-field input', 'native', 0);
  await expectOn('compose body', '.ProseMirror', 'native', 0);
  await expectOn('compose Subject label', '.cf-subject label', 'prevented');
  const pc = await runProbe((body) => evaluate(`(async () => { ${body} })()`), sleep);
  ok(pc.targets.every((t) => !t.found || t.ok) && pc.targets.some((t) => t.name === 'compose Subject (field)' && t.found && t.ok) && pc.targets.some((t) => t.name === 'compose body (field)' && t.found && t.ok), `the QA probe with a compose open: ${JSON.stringify(pc.targets)}`);
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
}

async function readerCases(theme) {
  tag = `reader ${theme}`;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  for (let attempt = 0; attempt < 5; attempt++) {
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=t1#lang=en&nativemenu=off` });
    await sleep(800);
    try { await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.reader-win iframe.msg-frame') || Date.now() - t0 > 15000) { clearInterval(t); document.querySelector('.reader-win iframe.msg-frame') ? ok(1) : no(new Error('reader did not start')); } }, 100); })`); break; } catch (e) { if (attempt === 4) throw e; }
  }
  await waitFrame();
  await sleep(500);
  await record();
  const p = await framePoint(false);
  ok(!!p, 'reader: no text in the message frame');
  if (p) {
    const r = await expectAt('reader body', p[0], p[1], 'prevented', 1);
    if (r) {
      ok(r.e.where === 'frame', `reader body: the event reached ${r.e.where}, expected the frame's document`);
      const m = r.m[0];
      ok(!!m && Math.abs(m.left - p[0]) <= 2 && Math.abs(m.top - p[1]) <= 2, `reader body: the menu is at ${m && Math.round(m.left)},${m && Math.round(m.top)}, the click was at ${p[0]},${p[1]}`);
    }
    await closeMenus();
  }
  await expectOn('reader header', '.reader-win .rp-msg-head .rp-from', 'prevented', 1);
  await expectOn('reader toolbar button', '.reader-win button', 'prevented', 0);
  await evaluate(`window.__ctx.length = 0; 1`);
  await cdp('Emulation.setEmulatedMedia', { features: [] });
}

/** The compose pop-out (?w=compose): its fields keep the native menu, its labels get the app's. */
async function composeWindowCases(theme) {
  tag = `compose window ${theme}`;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  for (let attempt = 0; attempt < 5; attempt++) {
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=reply#lang=en&nativemenu=off` });
    await sleep(800);
    try { await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.popout-compose .cf-subject input') && document.querySelector('.popout-compose .ProseMirror') || Date.now() - t0 > 15000) { clearInterval(t); document.querySelector('.popout-compose .ProseMirror') ? ok(1) : no(new Error('compose did not start')); } }, 100); })`); break; } catch (e) { if (attempt === 4) throw e; }
  }
  await sleep(500);
  await record();
  await expectOn('compose window Subject', '.popout-compose .cf-subject input', 'native', 0);
  await expectOn('compose window body', '.popout-compose .ProseMirror', 'native', 0);
  await expectOn('compose window label', '.popout-compose .cf-subject label', 'prevented');
  await cdp('Emulation.setEmulatedMedia', { features: [] });
}

/** The switch: in the browser preview the native menu stays by default (Inspect); #nativemenu=off is the release behaviour; =on keeps it. */
async function switchCases() {
  tag = 'switch';
  await app('light', 1280, 800, 'lang=en'); // no switch: the dev preview keeps the native menu
  await expectOn('preview default, label', '.fp-lbl', 'native', 0);
  await app('light', 1280, 800, 'lang=en&nativemenu=on');
  await expectOn('nativemenu=on, label', '.fp-lbl', 'native', 0);
  await app('light', 1280, 800, 'lang=en&nativemenu=off');
  await expectOn('nativemenu=off, label', '.fp-lbl', 'prevented');
  // a PDF in the engine's viewer: the guard leaves it alone (a synthetic event on the host element: the viewer itself is not in this document)
  const plugin = await evaluate(`(() => { const out = {}; for (const tagName of ['object', 'embed']) { const e = document.createElement(tagName); e.setAttribute('type', 'application/pdf'); document.body.appendChild(e); const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); e.dispatchEvent(ev); out[tagName] = ev.defaultPrevented; e.remove(); } return out; })()`);
  ok(plugin.object === false && plugin.embed === false, `a PDF host (<object>, <embed>): the engine's menu stays (${JSON.stringify(plugin)})`);
}

try {
  for (const theme of ['light', 'dark']) {
    await mainCases(theme);
    await readerCases(theme);
    await composeWindowCases(theme);
  }
  await switchCases();
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-context-targets: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-context-targets: ${checks} checks passed`);
