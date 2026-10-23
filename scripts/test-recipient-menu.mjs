#!/usr/bin/env node
// A right-click in the recipient fields (To, Cc, Bcc) keeps the engine's own menu (Cut, Copy, Paste, Select All ...) - D-038 (Mac QA 9a76aeb: no contextmenu event and no menu
// in the To field of a compose, Subject and the body were fine; Linux and Windows fine).
//
// WebKit on a Mac does not dispatch `contextmenu` when the press that starts the right-click was handled with preventDefault, so the press is what is checked here, not
// only the event: for REAL right-clicks (Input.dispatchMouseEvent button=right) on the input of each field, in every state the field can be in (empty / chips / text typed /
// focused or not / the suggestion list open), a recorder in the capture phase of the window notes `pointerdown`, `mousedown`, `mouseup` and `contextmenu` and reads
// `defaultPrevented` AFTER the whole dispatch (a later listener that cancels the press counts), plus the element that is hit at the click point. Expected for every state:
//   - the click point hits the input itself (nothing sits on top of it),
//   - pointerdown, mousedown and contextmenu are all NOT cancelled,
//   - no app menu opens (the input keeps the engine's menu), and the input is not disabled / read-only / inert.
// The same recorder is the Mac probe (scripts/lib/rcpt-context-probe.mjs).
//
//   node scripts/test-recipient-menu.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';
import { ARM, READ, STATIC } from './lib/rcpt-context-probe.mjs';

const H = await startHarness('test-recipient-menu', { vitePort0: 5830 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };

const body = (js) => evaluate(`(() => { ${js} })()`);
const FIELDS = ['to', 'cc', 'bcc'];
const inputOf = (f) => `document.querySelectorAll('.cf-field.rcpt')[${FIELDS.indexOf(f)}].querySelector('input')`;

async function openCompose(opts) {
  await H.openApp('lang=en&nativemenu=off', 1280, 800);
  await evaluate(`(async () => { await window.__store.getState().openCompose(${JSON.stringify({ accountId: 'a1', subject: 'Hello', bodyHtml: '<p>text</p>', ...opts })}); return 1; })()`);
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelectorAll('.cf-field.rcpt input').length >= 3 || Date.now() - t0 > 25000) { clearInterval(t); ok(1); } }, 100); })`); // (the message is a chunk of its own, WP9d)
  await sleep(500);
}

const centre = (f) => evaluate(`(() => { const e = ${inputOf(f)}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + Math.min(r.width / 2, 40)), Math.round(r.top + r.height / 2)]; })()`);

async function rightClick(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(300);
}

/** One real right-click on the input of `f` and the verdict of the recorder. */
async function check(f, what) {
  await body(ARM);
  const [x, y] = await centre(f);
  await rightClick(x, y);
  const r = await body(READ);
  const st = await body(STATIC);
  const at = (name) => r.events.find((e) => e.type === name);
  const hit = await evaluate(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e === ${inputOf(f)}; })()`);
  ok(hit, `${f} ${what}: the click point is not on the input (${r.events[0]?.target ?? 'nothing recorded'})`);
  for (const name of ['pointerdown', 'mousedown', 'mouseup', 'contextmenu']) {
    ok(!!at(name), `${f} ${what}: no ${name} event reached the window (events: ${r.events.map((e) => e.type).join(',')})`);
    if (at(name)) ok(at(name).prevented === false, `${f} ${what}: ${name} was cancelled (defaultPrevented true) - the engine would show no menu`);
  }
  ok(r.events.filter((e) => e.type === 'contextmenu').length === 1, `${f} ${what}: ${r.events.filter((e) => e.type === 'contextmenu').length} contextmenu events, expected 1`);
  ok(r.appMenus === 0, `${f} ${what}: an app menu opened over the field (${r.appMenus})`);
  const s = st.fields.find((x2) => x2.field === f);
  ok(!!s && s.ok, `${f} ${what}: the input is not in a state to take a native menu: ${JSON.stringify(s)}`);
  if (process.env.DBG) console.log(f, what, JSON.stringify({ r, s }));
}

try {
  tag = 'empty';
  await openCompose({ to: [], cc: ['c@example.com'], bcc: ['b@example.com'] });
  for (const f of FIELDS) await check(f, 'empty/chips, not focused');
  tag = 'focused';
  for (const f of FIELDS) {
    await evaluate(`${inputOf(f)}.focus(); 1`);
    await check(f, 'focused');
  }
  tag = 'typed';
  for (const f of FIELDS) {
    await evaluate(`(() => { const e = ${inputOf(f)}; e.focus(); document.execCommand('insertText', false, 'partial'); return 1; })()`);
    await check(f, 'text typed');
    await evaluate(`(() => { const e = ${inputOf(f)}; e.select(); document.execCommand('delete'); return 1; })()`);
  }
  tag = 'chips';
  await openCompose({ to: ['alice@fabrikam.com', 'bob@fabrikam.com'], cc: ['c@example.com'], bcc: ['b@example.com'] });
  for (const f of FIELDS) await check(f, 'with chips');
  tag = 'suggestions';
  await evaluate(`(() => { const e = ${inputOf('to')}; e.focus(); document.execCommand('insertText', false, 'al'); return 1; })()`);
  await sleep(600);
  ok(await evaluate(`!!document.querySelector('.suggest[role=listbox]')`), 'the suggestion list did not open');
  await check('to', 'suggestions open');
  tag = 'pop-out';
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=compose#lang=en&nativemenu=off` });
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelectorAll('.cf-field.rcpt input').length >= 1 || Date.now() - t0 > 15000) { clearInterval(t); ok(1); } }, 100); })`);
  await sleep(800);
  await check('to', 'compose window');
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-recipient-menu: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-recipient-menu: ${checks} checks passed`);
