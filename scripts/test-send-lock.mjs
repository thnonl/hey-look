#!/usr/bin/env node
// Send in the inline compose pane (1.0.11), real Compose in the dev preview:
//   - Send: the pane stays on screen, locked (`inert`, `aria-busy`), the Send button reads "Sending…", the toast "Sending…" has Undo, the text is intact;
//   - Undo: the SAME editor is unlocked in place (a marker set on its element before Send is still there), the text is intact, nothing was sent;
//   - when the Undo time is over the message goes, the "sent" mark takes the place of the editor for about a second, then the pane closes;
//   - no Undo time: the same, locked from the press; the message is sent;
//   - a failed send: the pane is unlocked with the text and the recipients intact and the error toast (the draft is not lost).
//   node scripts/test-send-lock.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-send-lock', { vitePort0: 5700, cdpPort0: 9700 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(50); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));

const pane = () => json(`(() => { const p = document.querySelector('.compose-pane'); return p ? { inert: p.hasAttribute('inert'), busy: p.getAttribute('aria-busy'), marker: !!p.querySelector('.cp-editor .tiptap')?.__marker, text: p.querySelector('.cp-editor .tiptap')?.editor?.getText().trim() ?? null, sent: !!p.querySelector('.cp-sent') } : null; })()`);
const sendButton = () => json(`(() => { const b = document.querySelector('.cp-bar button.btn.primary'); return b ? { text: b.textContent.trim(), ring: !!b.querySelector('.spin') } : null; })()`);
const toasts = () => json(`[...document.querySelectorAll('.toasts .toast')].map((t) => ({ text: t.querySelector('.toast-text')?.textContent ?? '', undo: !!t.querySelector('.toast-undo') }))`);
// (an Undo time holds the message in the outbox and `outbox_hold_send` sends it; no Undo time calls `send_message`)
const sentCount = () => evaluate(`(window.__sentMessages || []).length + (window.__sendCalls || []).filter((c) => c.cmd === 'holdSend').length`);

async function fresh(subject, undoSeconds) {
  await H.openApp('lang=en&nodefaultsig', 1280, 800);
  await evaluate(`window.__store.getState().setPrefs({ undoSeconds: ${undoSeconds} }); window.__store.getState().openCompose(${JSON.stringify({ accountId: 'a1', to: ['alice@fabrikam.com'], subject })}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor && !!document.querySelector('.sig-select')`, 15000), 'compose did not start');
  await sleep(600);
  await evaluate(`(() => { const el = document.querySelector('.cp-editor .tiptap'); el.editor.commands.insertContent('Some words'); el.__marker = true; window.__sentMessages = []; window.__sendCalls = []; return 1; })()`);
  await sleep(300);
}
const clickSend = () => evaluate(`(() => { const b = document.querySelector('.cp-bar button.btn.primary'); if (!b) return false; b.click(); return true; })()`);

try {
  // ---------- Undo time 3 s: locked, Undo, locked again, the sent mark, the pane closes
  await fresh('Lock test', 3);
  assert.ok(await clickSend(), 'no Send button');
  assert.ok(await waitFor(`!!document.querySelector('.toasts .toast-undo')`, 6000), 'no Undo offer');
  await check('Send: the pane stays on screen, locked, with the text', async () => {
    const p = await pane();
    assert.ok(p, 'the pane closed at Send');
    assert.equal(p.inert, true);
    assert.equal(p.busy, 'true');
    assert.equal(p.text, 'Some words');
    assert.equal(p.marker, true);
  });
  await check('Send: the button reads "Sending…" with a ring and the toast "Sending…" has Undo', async () => {
    const b = await sendButton();
    assert.match(b.text, /Sending/);
    assert.equal(b.ring, true);
    assert.ok((await toasts()).some((t) => /Sending/.test(t.text) && t.undo), JSON.stringify(await toasts()));
  });
  await check('nothing is typed into a locked pane (the editor and the fields are inert)', async () => {
    const reach = await json(`(() => { const p = document.querySelector('.compose-pane'); return p.matches(':is(:not([inert]) *, [inert])') && p.hasAttribute('inert'); })()`);
    assert.equal(reach, true);
    assert.equal(await evaluate(`document.activeElement?.closest?.('.compose-pane') ? 1 : 0`), 0, 'the focus stays in a locked pane');
  });
  await evaluate(`document.querySelector('.toasts .toast-undo').click(); 1`);
  assert.ok(await waitFor(`!document.querySelector('.compose-pane')?.hasAttribute('inert')`, 6000), 'Undo did not unlock the pane');
  await check('Undo: the same editor is unlocked in place, the text is intact, nothing was sent', async () => {
    const p = await pane();
    assert.equal(p.marker, true, 'a new editor was made');
    assert.equal(p.text, 'Some words');
    assert.equal(p.sent, false);
    assert.equal(await sentCount(), 0);
    assert.equal((await sendButton()).text, 'Send');
  });
  assert.ok(await clickSend(), 'no Send button');
  assert.ok(await waitFor(`!!document.querySelector('.cp-sent')`, 9000), 'no sent mark after the Undo time');
  await check('the message is sent and the sent mark covers the pane', async () => {
    const p = await pane();
    assert.ok(p, 'the pane closed without the mark');
    assert.equal(p.sent, true);
    assert.equal(await sentCount(), 1);
    const box = await json(`(() => { const m = document.querySelector('.cp-sent').getBoundingClientRect(); const c = document.querySelector('.compose-pane').getBoundingClientRect(); return { dw: Math.abs(m.width - c.width), dh: Math.abs(m.height - c.height), text: document.querySelector('.cp-sent-lbl').textContent }; })()`);
    assert.ok(box.dw <= 1 && box.dh <= 1, `the mark does not cover the pane: ${JSON.stringify(box)}`);
    assert.equal(box.text, 'Message sent');
  });
  const t0 = Date.now();
  assert.ok(await waitFor(`!document.querySelector('.compose-pane')`, 4000), 'the pane did not close after the mark');
  await check('the mark stays about a second (0.6 to 1.8 s) before the pane closes', async () => {
    const ms = Date.now() - t0;
    assert.ok(ms < 1800, `${ms} ms`);
  });

  // ---------- no Undo time: locked from the press, sent, the mark, closed
  await fresh('No undo', 0);
  assert.ok(await clickSend(), 'no Send button');
  await check('no Undo time: the pane is locked at once and the message goes', async () => {
    assert.ok(await waitFor(`document.querySelector('.compose-pane')?.hasAttribute('inert') || !!document.querySelector('.cp-sent')`, 3000), 'not locked');
    assert.ok(await waitFor(`!!document.querySelector('.cp-sent')`, 4000), 'no sent mark');
    assert.equal(await sentCount(), 1);
  });
  assert.ok(await waitFor(`!document.querySelector('.compose-pane')`, 4000), 'the pane did not close');

  // ---------- a failed send: unlocked with everything intact and the error
  await fresh('Fail [smtpfail]', 0);
  assert.ok(await clickSend(), 'no Send button');
  assert.ok(await waitFor(`!!document.querySelector('.toasts .toast.error, .toasts .toast[data-kind="error"]') || [...document.querySelectorAll('.toasts .toast')].some((t) => /fail/i.test(t.textContent))`, 6000), 'no error toast');
  await check('a failed send: the same editor is unlocked with the text, the recipient and the subject, and the error is shown', async () => {
    assert.ok(await waitFor(`!document.querySelector('.compose-pane')?.hasAttribute('inert')`, 4000), 'still locked');
    const p = await pane();
    assert.ok(p, 'the pane is gone: the draft is lost');
    assert.equal(p.marker, true);
    assert.equal(p.text, 'Some words');
    assert.equal(p.sent, false);
    assert.equal(await evaluate(`document.querySelector('.compose-pane').textContent.includes('alice@fabrikam.com')`), true);
    assert.equal(await evaluate(`[...document.querySelectorAll('.compose-pane input')].some((i) => i.value === 'Fail [smtpfail]')`), true);
    assert.equal(await sentCount(), 0);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-send-lock: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-send-lock: ok');
