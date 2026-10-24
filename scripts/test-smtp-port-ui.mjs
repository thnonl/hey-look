#!/usr/bin/env node
// 1.0.7 D-006 in the dev preview: a port typed in Settings > Add account > Other account (IMAP / SMTP port boxes) is the port that is sent to the backend.
//   1.0.6 QA saw a typed SMTP port 31501 saved as 31502: a +1 is what an ArrowUp or a mouse wheel does to a focused <input type="number">, so the boxes are plain text boxes
//   (inputmode numeric) now. Tried: typed 31501 / 587 / 465 / 65535 / 993 / 143 (real key events), ArrowUp / ArrowDown, the mouse wheel over the focused box, a paste ("587", " 31501 ",
//   "smtp:465"), a number over 65535 (refused, the previous one stays), Backspace to empty (empty box, not "0"), then Add account: the `add_account` call carries the typed ports.
//   node scripts/test-smtp-port-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-smtp-port-ui', { vitePort0: 6190 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };

const SMTP = `input[aria-label="SMTP port"]`;
const IMAP = `input[aria-label="IMAP port"]`;
const value = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).value`);
const focus = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); e.focus(); e.select(); return document.activeElement === e; })()`);
/** a real key press: key, code, virtual key code, and the text it types (if any) */
const press = async (key, code, vk, text) => {
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text, unmodifiedText: text });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
};
const typeDigits = async (digits) => { for (const d of digits) await press(d, `Digit${d}`, 48 + Number(d), d); await sleep(60); };
/** replaces the content of the focused box with the typed digits */
const typeInto = async (sel, digits) => { assert.ok(await focus(sel), `${sel}: no focus`); await press('Backspace', 'Backspace', 8); await typeDigits(digits); return value(sel); };
const centre = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);

async function openForm() {
  await H.openApp('lang=en&os=windows', 1280, 800);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'add-account' }); 1`);
  assert.ok(await waitFor(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'iCloud, Yahoo, other')`), 'no add account tab');
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'iCloud, Yahoo, other').click(); 1`);
  assert.ok(await waitFor(`!!document.querySelector('${SMTP}')`), 'no SMTP port box (the Other provider shows the server boxes)');
  await evaluate(`(() => {
    window.__adds = [];
    if (window.__spied) return 1;
    window.__spied = true;
    const inv = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    window.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => { if (cmd === 'add_account') window.__adds.push(JSON.parse(JSON.stringify(args.input))); return inv(cmd, args, opts); };
    return 1;
  })()`);
}

try {
  await check('typed ports stay what they are (31501, 587, 465, 65535, 993, 143), nothing adds one', async () => {
    await openForm();
    for (const p of ['31501', '587', '465', '65535', '993', '143']) {
      assert.equal(await typeInto(SMTP, p), p, `SMTP typed ${p}`);
      assert.equal(await typeInto(IMAP, p), p, `IMAP typed ${p}`);
    }
    // let go of the box and look again after a while: still the typed value
    assert.equal(await typeInto(SMTP, '31501'), '31501');
    await evaluate(`document.activeElement.blur(); 1`);
    await sleep(400);
    assert.equal(await value(SMTP), '31501');
  });
  await check('ArrowUp / ArrowDown / PageUp in the box do not change the port', async () => {
    await openForm();
    await typeInto(SMTP, '31501');
    for (const [k, vk] of [['ArrowUp', 38], ['ArrowUp', 38], ['ArrowDown', 40], ['PageUp', 33], ['PageDown', 34]]) await press(k, k, vk);
    await sleep(80);
    assert.equal(await value(SMTP), '31501');
  });
  await check('the mouse wheel over the focused box does not change the port (either direction)', async () => {
    await openForm();
    await typeInto(SMTP, '31501');
    const [x, y] = await centre(SMTP);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const deltaY of [-120, -120, 120, -53, 300]) await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    await sleep(150);
    assert.equal(await value(SMTP), '31501');
    assert.equal(await evaluate(`document.activeElement === document.querySelector('${SMTP}')`), true, 'the box kept the focus');
  });
  await check('a paste: digits are taken, anything else around them is dropped, a number over 65535 is refused', async () => {
    await openForm();
    assert.ok(await focus(SMTP));
    await cdp('Input.insertText', { text: '587' });
    assert.equal(await value(SMTP), '587');
    assert.ok(await focus(SMTP));
    await cdp('Input.insertText', { text: ' 31501 ' });
    assert.equal(await value(SMTP), '31501');
    assert.ok(await focus(SMTP));
    await cdp('Input.insertText', { text: 'smtp:465' });
    assert.equal(await value(SMTP), '465');
    assert.ok(await focus(SMTP));
    await cdp('Input.insertText', { text: '99999' });
    assert.equal(await value(SMTP), '465', 'over 65535: the previous port stays');
    assert.equal(await typeInto(SMTP, '6553'), '6553');
    await typeDigits('6');
    assert.equal(await value(SMTP), '6553', '65536 is refused');
    await typeDigits('5');
    assert.equal(await value(SMTP), '65535');
  });
  await check('Backspace to empty gives an empty box (not 0), and letters are not typed', async () => {
    await openForm();
    assert.equal(await typeInto(SMTP, ''), '');
    assert.equal(await evaluate(`document.querySelector('${SMTP}').placeholder`), '465');
    await press('e', 'KeyE', 69, 'e');
    await press('-', 'Minus', 189, '-');
    await press('.', 'Period', 190, '.');
    await sleep(60);
    assert.equal(await value(SMTP), '');
  });
  await check('the box says what it takes: numeric keypad hint, no spinner', async () => {
    await openForm();
    const a = await evaluate(`(() => { const e = document.querySelector('${SMTP}'); return { type: e.type, mode: e.inputMode, label: e.getAttribute('aria-label') }; })()`);
    assert.deepEqual(a, { type: 'text', mode: 'numeric', label: 'SMTP port' });
  });
  await check('Add account sends the typed ports to the backend', async () => {
    await openForm();
    const set = (label, v) => evaluate(`(() => { const e = document.querySelector('input[aria-label=${JSON.stringify(label)}]'); if (!e) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    for (const [label, v] of [['Email', 'qa@example.test'], ['Password / app password', 'secret'], ['IMAP host', 'imap.example.test'], ['SMTP host', 'smtp.example.test']]) assert.ok(await set(label, v), `no box "${label}"`);
    await typeInto(IMAP, '31500');
    await typeInto(SMTP, '31501');
    await evaluate(`(() => { const b = document.querySelector('.set-card button.btn.primary'); b.click(); return 1; })()`);
    assert.ok(await waitFor(`window.__adds.length > 0`, 5000), 'add_account was not called');
    const sent = await evaluate(`window.__adds[0]`);
    assert.equal(sent.smtpPort, 31501);
    assert.equal(sent.imapPort, 31500);
    assert.equal(typeof sent.smtpPort, 'number');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-smtp-port-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-smtp-port-ui: ok');
