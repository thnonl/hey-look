#!/usr/bin/env node
// "Generate a key" (Settings > Encryption (PGP), and Set up encryption in the compose bar, dialog `pgp-generate`): how the dialog ends (v1.0.6 QA round 2, BUG-2:
// "does not close after Done, the X or Escape; blocks Settings until restart"). Cause: a key that was not backed up asks "Close without a backup?" first, as
// designed, but Esc and a click outside that question answered with ITS FIRST BUTTON, "Back up now", which opened the system's save dialog (behind the
// window on the QA machine) instead of ever leaving the dialog; Esc, Esc, Esc never closed it. Now Esc and a click outside the question answer "stay" (nothing
// happens, nothing opens), and the question is asked once at a time; "Close anyway" closes, "Back up now" backs up and Done then closes without asking.
//
// Real dialog in the dev preview (src/devMock.ts: pgp_generate_key, pgp_export_secret), both entry points. Per entry: Done -> question -> Close anyway; Done ->
// question -> Esc (stays, no backup made) -> X -> question -> click outside (stays) -> Close anyway; Esc on the dialog -> question -> Back up now -> the backup is
// listed -> Done closes at once; Cancel before a key exists closes without a question; two quick Done clicks make one question. After every close nothing is left
// over the app (no overlay) and a control of the page can be pressed.
//   node scripts/test-pgp-generate.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-pgp-generate', { vitePort0: 5900, cdpPort0: 9900 });
const { evaluate, cdp } = H;
const io = inputs(H, null, 'pg');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

const state = () => evaluate(`JSON.stringify({
  dialogs: [...document.querySelectorAll('[role=dialog]')].map((d) => d.querySelector('.modal-head b')?.textContent ?? d.getAttribute('aria-label') ?? ''),
  asks: [...document.querySelectorAll('[role=alertdialog]')].map((d) => d.querySelector('h3')?.textContent ?? ''),
  overlays: document.querySelectorAll('.modal-back').length, ready: document.body.innerText.includes('Your key is ready'), backedUp: !!document.querySelector('.modal .notice.good'),
})`).then(JSON.parse);
const btn = (label, within = '.modal') => evaluate(`(() => { const b = [...document.querySelectorAll('${within} button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} || x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const ask = (label) => btn(label, '[role=alertdialog]');
const esc = async () => { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(350); };
const outsideAsk = async () => { await evaluate(`document.querySelector('.ask-back')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`); await sleep(350); };

async function open(entry) {
  await H.openApp('lang=en', 1280, 720);
  if (entry === 'settings') {
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'pgp' }); 1`);
    await sleep(700);
    await evaluate(`[...document.querySelectorAll('button')].find((b) => /Generate key/.test(b.textContent)).click(); 1`);
  } else {
    // the compose bar's "Set up encryption" opens this dialog from a message that is being written
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hi' }); 1`);
    await sleep(900);
    await evaluate(`window.__store.getState().setDialog({ type: 'pgp-generate', accountId: 'a1' }); 1`);
  }
  await sleep(500);
}
async function generate() {
  for (const id of ['gk-pw', 'gk-pw2']) {
    await evaluate(`document.getElementById('${id}').focus(); 1`);
    await io.typeText('a passphrase 123', 4);
  }
  await btn('Generate');
  for (let i = 0; i < 60 && !(await state()).ready; i++) await sleep(100);
}
/** nothing is left over the app and a control of the page still works */
async function free(entry, label) {
  const s = await state();
  assert.equal(s.asks.length, 0, `${label}: a question is left (${s.asks})`);
  if (entry === 'compose') {
    assert.equal(s.overlays, 0, `${label}: an overlay is left over the app`);
    assert.deepEqual(s.dialogs, [], `${label}: a dialog is left`);
    await evaluate(`document.querySelector('.split-caret').click(); 1`);
    await sleep(250);
    assert.ok(await evaluate(`!!document.querySelector('.sched-pop')`), `${label}: the page does not react (Send later did not open)`);
  }
}

try {
  for (const entry of ['settings', 'compose']) {
    const back = entry === 'settings' ? ['Settings'] : [];
    // 1. Done, then "Close anyway"
    await open(entry); await generate();
    await check(`${entry}: the key is made, the dialog says so`, async () => assert.ok((await state()).ready));
    await btn('Done'); await sleep(350);
    await check(`${entry}: Done asks "Close without a backup?"`, async () => { const s = await state(); assert.deepEqual(s.asks, ['Close without a backup?']); assert.ok(s.ready, 'the dialog is still there behind the question'); });
    await ask('Close anyway'); await sleep(400);
    await check(`${entry}: Close anyway closes the dialog`, async () => { const s = await state(); assert.ok(!s.ready); assert.ok(!s.dialogs.includes('Generate a key')); assert.deepEqual(s.dialogs, back); await free(entry, 'after Close anyway'); });

    // 2. Esc and a click outside the question stay (they used to open the save dialog), X asks too, Close anyway closes
    await open(entry); await generate();
    await btn('Done'); await sleep(300);
    await esc();
    await check(`${entry}: Esc on the question leaves it without a backup and without closing`, async () => { const s = await state(); assert.deepEqual(s.asks, []); assert.ok(s.ready); assert.ok(!s.backedUp, 'Esc made a backup (opened the save dialog)'); });
    await btn('Close'); await sleep(300); // the X
    await check(`${entry}: the X asks again`, async () => assert.deepEqual((await state()).asks, ['Close without a backup?']));
    await outsideAsk();
    await check(`${entry}: a click outside the question stays too`, async () => { const s = await state(); assert.deepEqual(s.asks, []); assert.ok(s.ready); assert.ok(!s.backedUp); });
    await esc(); // Esc on the dialog itself
    await check(`${entry}: Esc on the dialog asks`, async () => assert.deepEqual((await state()).asks, ['Close without a backup?']));
    await ask('Close anyway'); await sleep(400);
    await check(`${entry}: ... and Close anyway closes it`, async () => { const s = await state(); assert.ok(!s.ready); await free(entry, 'after Esc, X, Esc'); });

    // 3. Back up now, then Done closes at once
    await open(entry); await generate();
    await esc();
    await check(`${entry}: Esc on the dialog asks`, async () => assert.deepEqual((await state()).asks, ['Close without a backup?']));
    await ask('Back up now'); await sleep(500);
    await check(`${entry}: Back up now saves the backup and stays in the dialog`, async () => { const s = await state(); assert.ok(s.ready && s.backedUp, JSON.stringify(s)); assert.deepEqual(s.asks, []); });
    await btn('Done'); await sleep(400);
    await check(`${entry}: Done after the backup closes without a question`, async () => { const s = await state(); assert.deepEqual(s.asks, []); assert.ok(!s.ready); await free(entry, 'after the backup'); });

    // 4. two quick clicks on Done: one question
    await open(entry); await generate();
    await evaluate(`(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === 'Done'); b.click(); b.click(); return 1; })()`);
    await sleep(350);
    await check(`${entry}: two quick Done clicks make one question`, async () => assert.deepEqual((await state()).asks, ['Close without a backup?']));
    await ask('Close anyway'); await sleep(400);
    await check(`${entry}: ... which closes`, async () => assert.ok(!(await state()).ready));

    // 5. Cancel before there is a key: no question
    await open(entry);
    await btn('Cancel'); await sleep(400);
    await check(`${entry}: Cancel before a key exists closes at once`, async () => { const s = await state(); assert.deepEqual(s.asks, []); assert.ok(!s.dialogs.includes('Generate a key')); });
    // and Esc before there is a key
    await open(entry);
    await esc();
    await check(`${entry}: Esc before a key exists closes at once`, async () => { const s = await state(); assert.deepEqual(s.asks, []); assert.ok(!s.dialogs.includes('Generate a key')); });
  }
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-pgp-generate: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-pgp-generate: ok');
