#!/usr/bin/env node
// New mail while the mailboxes are not read yet (W1.3, 1.0.7), in the dev preview (src/devMock.ts: `#accountsdelay=<ms>` makes the store take the mailboxes that late, the way a debug
// build does with HEYLOOK_TEST_ACCOUNTS_DELAY_MS). Real key events:
//   wait     the key `c` pressed three times during the delay: the message "Opening a new message as soon as your mailboxes are ready..." with a spinner shows on the loading
//            screen, and when the mailboxes arrive ONE message opens and the toast is gone
//   tray     a "New mail" of the tray menu that reached the backend before the page listened (the backend keeps it, `take_tray_compose`): it opens when the mailboxes arrive
//   none     with no mailbox at all the key does nothing and says nothing (the Welcome screen)
//   (--full) the delay is longer than 30 s: after 30 s the message is replaced by "Couldn't open a new message." with Retry; the mailboxes arriving later clear it and open one
//            message by themselves; Retry while they are not read waits again; closing the message drops the request (about 2 minutes)
//
//   node scripts/test-new-mail-wait.mjs [--full] [--require-browser | --url=http://127.0.0.1:1420/]
import { flag, sleep, startHarness } from './cdp-harness.mjs';

const FULL = flag('full');
const H = await startHarness('test-new-mail-wait', { vitePort0: 5760, cdpPort0: 9760 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };

const keyC = async () => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', text: 'c', windowsVirtualKeyCode: 67 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 });
  await sleep(120);
};
const toast = () => evaluate(`(() => { const t = document.querySelector('.toasts .toast'); return t ? { text: t.textContent.trim(), spinner: !!t.querySelector('.spin, .busy, [class*=spin]'), buttons: [...t.querySelectorAll('.toast-act')].map((b) => b.textContent.trim()), count: document.querySelectorAll('.toasts .toast').length } : null; })()`);
const composes = () => evaluate(`document.querySelectorAll('.compose-pane').length`);
const loadingScreen = () => evaluate(`!!document.querySelector('.app-loading')`);

/** Loads the preview with the switches and returns as soon as the page runs (the store is not up when the delay is long). */
async function load(hash, before) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'about:blank' });
  const script = before ? await cdp('Page.addScriptToEvaluateOnNewDocument', { source: before }) : null;
  await cdp('Page.navigate', { url: `${H.base}#${hash}` });
  await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.app-loading, .app') || Date.now() - t0 > 15000) { clearInterval(t); ok(1); } }, 50); })`);
  return script;
}
const untilUi = (ms) => evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.ribbon, .rb.primary, .welcome') || Date.now() - t0 > ${ms}) { clearInterval(t); ok(Date.now() - t0); } }, 50); })`);

try {
  // ---- wait: three presses of `c` during a 4 s delay
  tag = 'wait';
  await load('lang=en&accountsdelay=4000');
  await sleep(600);
  ok(await loadingScreen(), 'the loading screen is not up during the delay');
  await keyC(); await keyC(); await keyC();
  const w = await toast();
  ok(!!w, 'no message while the request waits');
  ok(w && /Opening a new message as soon as your mailboxes are ready/.test(w.text), `the message reads "${w?.text}"`);
  ok(w && w.count === 1, `${w?.count} messages for three presses, expected one`);
  ok(await composes() === 0, 'a message opened before the mailboxes were read');
  await untilUi(8000);
  await sleep(1500);
  ok(await composes() === 1, `${await composes()} messages open after the mailboxes arrived, expected one`);
  const after = await toast();
  ok(!after || !/Opening a new message/.test(after.text), 'the waiting message is still there after the message opened');

  // ---- tray: the request is kept by the backend until the page takes it
  tag = 'tray';
  await load('lang=en&accountsdelay=2500', 'window.__trayCompose = true;');
  await sleep(500);
  const t = await toast();
  ok(!!t && /Opening a new message/.test(t.text), `the tray request shows the waiting message while the mailboxes are read: ${JSON.stringify(t)}`);
  await untilUi(8000);
  await sleep(1500);
  ok(await composes() === 1, `${await composes()} messages after the tray request, expected one`);
  ok(await evaluate(`window.__trayCompose === false`), 'the page did not take the request from the backend');

  // ---- none: no mailbox, the key does nothing
  tag = 'none';
  await load('lang=en&noaccounts');
  await untilUi(6000);
  await sleep(500);
  await keyC();
  await sleep(500);
  ok(await composes() === 0, 'a message opened without a mailbox');
  ok(!(await toast()), 'a message was shown without a mailbox');

  // ---- a normal start: the key opens one at once
  tag = 'ready';
  await load('lang=en');
  await untilUi(8000);
  await sleep(800);
  await keyC();
  await sleep(600);
  ok(await composes() === 1, 'the key c did not open a message when the mailboxes were read');

  if (FULL) {
    // the delay is longer than 30 s: after 30 s the error message with Retry; then (a) the mailboxes arrive: the message goes and ONE message opens by itself (QA O-4),
    // (b) Retry while they are not read is a new wait and ONE message opens when they arrive, (c) closing the error message drops the request
    const errorToast = async () => {
      const f = await toast();
      ok(!!f && /Couldn’t open a new message\./.test(f.text), `after 30 s: ${JSON.stringify(f)}`);
      ok(!!f && f.buttons.includes('Retry'), `no Retry: ${JSON.stringify(f)}`);
    };
    tag = 'timeout';
    await load('lang=en&accountsdelay=33000');
    await sleep(500);
    await keyC();
    ok(!!(await toast()), 'no message while the request waits (full)');
    await sleep(30_000);
    await errorToast();
    await untilUi(12_000);
    await sleep(1500);
    ok(await composes() === 1, `${await composes()} messages after the mailboxes arrived behind the error message, expected one`);
    ok(!(await toast()), `the error message is still there: ${JSON.stringify(await toast())}`);
    await sleep(1000);
    ok(await composes() === 1, 'the request was served twice');

    tag = 'timeout-retry';
    await load('lang=en&accountsdelay=33000');
    await sleep(500);
    await keyC();
    await sleep(30_000);
    await errorToast();
    await evaluate(`[...document.querySelectorAll('.toasts .toast .toast-act')].find((b) => b.textContent.trim() === 'Retry').click(); 1`);
    await sleep(300);
    const again = await toast();
    ok(!!again && /Opening a new message/.test(again.text), `Retry before the mailboxes arrived should wait again: ${JSON.stringify(again)}`);
    ok(await composes() === 0, 'Retry opened a message before the mailboxes arrived');
    await untilUi(12_000);
    await sleep(1500);
    ok(await composes() === 1, `${await composes()} messages after Retry, expected one`);
    ok(!(await toast()), 'a message is still shown after the message opened');

    tag = 'timeout-close';
    await load('lang=en&accountsdelay=33000');
    await sleep(500);
    await keyC();
    await sleep(30_000);
    await errorToast();
    await evaluate(`document.querySelector('.toasts .toast .toast-x').click(); 1`);
    await sleep(200);
    ok(!(await toast()), 'the error message did not close');
    await untilUi(12_000);
    await sleep(1500);
    ok(await composes() === 0, 'a closed error message still opened a message');
  }
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-new-mail-wait: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-new-mail-wait: ${checks} checks passed`);
