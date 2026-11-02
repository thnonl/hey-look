#!/usr/bin/env node
// 1.0.12 (owner): a message written To a1 and copied (Cc) to a2 sits in both mailboxes. Answering the COPY OF a2 (here: in the combined view, no default account) is written from a1, the address it was
// written to, for Reply, Reply all and Forward; the copy of a1 is answered from a1 as before; a copy with nobody of mine in To is answered from the mailbox that holds it.
// Real buttons in the dev preview (src/devMock.ts: accounts a1 nam@example.com and a2 nam@gmail.com); the From picker of the compose pane is read.
//   node scripts/test-reply-from-to.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-reply-from-to', { vitePort0: 5911 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 600)}`); console.error('FAIL', name); } };
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };
const paneReady = `(() => { const p = document.querySelector('.compose-pane'); return !!p && !p.classList.contains('preparing') && !!p.querySelector('.cp-editor .tiptap .quote-block'); })()`;
const fromOf = () => evaluate(`(document.querySelector('.compose-pane .acct-pick')?.textContent || '').replace(/\s+/g, ' ').trim()`);

async function answer(thread, button) {
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); window.__store.getState().select(${JSON.stringify(thread)}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), 'the message did not open');
  await sleep(400);
  assert.ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(button)}); if (!b) return false; b.click(); return true; })()`), `no ${button} button`);
  assert.ok(await waitFor(paneReady, 15000), 'the compose pane never filled in');
  await sleep(300);
  return fromOf();
}

try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`(() => {
    const add = window.__mockAddThread;
    const base = { fromName: 'Carol', fromEmail: 'carol@ext.test', html: '<p>hello</p>' };
    // To nam@example.com (a1), Cc nam@gmail.com (a2); the copy that is opened sits in a2
    add('ft-cc', 'Copy in the Cc mailbox', { ...base, accountId: 'a2', to: 'nam@example.com', cc: 'nam@gmail.com', row: { accountId: 'a2' } });
    // the same message, the copy in a1 (the To address)
    add('ft-to', 'Copy in the To mailbox', { ...base, accountId: 'a1', to: 'nam@example.com', cc: 'nam@gmail.com', row: { accountId: 'a1' } });
    // nobody of mine in To (a list), the copy in a2
    add('ft-list', 'Written to a list', { ...base, accountId: 'a2', to: 'list@ext.test', cc: '', row: { accountId: 'a2' } });
    window.__store.getState().setPrefs({ defaultAccount: null });
    return true; })()`);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  for (const button of ['Reply', 'Reply all', 'Forward']) {
    await check(`${button}: the copy of the Cc mailbox is written from the To address (nam@example.com)`, async () => {
      const from = await answer('ft-cc', button);
      assert.match(from, /nam@example\.com/, from);
      assert.doesNotMatch(from, /nam@gmail\.com/, from);
    });
  }
  await check('Reply: the copy of the To mailbox is written from the To address', async () => {
    assert.match(await answer('ft-to', 'Reply'), /nam@example\.com/);
  });
  await check('Reply: nobody of mine in To: the mailbox that holds the copy (nam@gmail.com)', async () => {
    assert.match(await answer('ft-list', 'Reply'), /nam@gmail\.com/);
  });
  await check('the default account does not override the To address', async () => {
    await evaluate(`window.__store.getState().setPrefs({ defaultAccount: 'a2' }); 1`);
    assert.match(await answer('ft-cc', 'Reply'), /nam@example\.com/);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-reply-from-to: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-reply-from-to: ok');
