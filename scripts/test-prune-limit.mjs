#!/usr/bin/env node
// W6.3 in the real page (dev preview, mock backend): lowering the download limit asks the backend to prune at once (with the conversation in the pane kept), raising it asks nothing;
// `mail-pruned` (the mailbox is at its cap after a sync, a push or the limit lowered) shows "Download limit reached (N mails per mailbox)" at the end of an unfiltered list
// without a Sync, not under a filtered one; a sync in progress keeps what it was told.
//   node scripts/test-prune-limit.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-prune-limit', { vitePort0: 5160, cdpPort0: 9160 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(60); } return false; };
const S = 'window.__store.getState()';
const calls = () => evaluate('JSON.stringify(window.__pruneCalls || [])').then(JSON.parse);
const limited = () => evaluate(`JSON.stringify(Object.keys(${S}.limited).sort())`).then(JSON.parse);
const footer = () => evaluate(`(() => {
  const row = document.querySelector('.ml-row'); if (!row) return null;
  for (let p = row.parentElement; p; p = p.parentElement) { if (p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { p.scrollTop = p.scrollHeight; break; } }
  return document.querySelector('.ml-foot')?.textContent ?? null; })()`);

try {
  await H.openApp('lang=en&local=900', 1280, 800);
  assert.ok(await waitFor(`${S}.threads.length > 3`, 20000), 'the Inbox has conversations');
  await evaluate(`${S}.setView('inbox', 'a1'); 1`);
  assert.ok(await waitFor(`${S}.folder === 'inbox' && ${S}.accountId === 'a1' && ${S}.threads.length > 3`));

  await check('raising the limit asks for no prune', async () => {
    await evaluate(`${S}.setPrefs({ maxDownload: 3000 }); 1`);
    await sleep(600);
    assert.deepEqual(await calls(), []);
    assert.deepEqual(await limited(), []);
  });

  await check('lowering it prunes at once, keeps the open conversation, and the notice shows without a sync', async () => {
    const id = await evaluate(`${S}.threads[0].threadId`);
    await evaluate(`${S}.select(${JSON.stringify(id)}); 1`);
    assert.ok(await waitFor(`${S}.selected === ${JSON.stringify(id)}`));
    await evaluate(`${S}.setPrefs({ maxDownload: 500 }); 1`);
    assert.ok(await waitFor(`(window.__pruneCalls || []).length === 1`, 5000), 'the backend was not asked to prune');
    const c = (await calls())[0];
    assert.deepEqual(c.keep, [id], 'the conversation in the pane is kept');
    assert.equal(c.cap, 500);
    assert.ok(await waitFor(`${S}.limited['a1|inbox'] === true`, 5000), JSON.stringify(await limited()));
    const keys = await limited();
    for (const k of ['a1|inbox', 'a1|sent', 'a1|archive', 'a1|trash']) assert.ok(keys.includes(k), `${k} in ${keys}`);
    assert.ok(keys.includes('a2|inbox'), 'every mailbox that is at the cap is marked (the mock holds 900 mails in each)');
    assert.ok(await waitFor(`(document.querySelector('.ml-foot, .ml-progress')?.textContent ?? '').includes('Download limit reached (500 mails per mailbox)')`, 6000), `the notice: ${await footer()}`);
  });

  await check('a filtered list shows the plain end line, not the notice', async () => {
    await evaluate(`${S}.setFilter('unread'); 1`);
    await sleep(800);
    const f = (await footer()) ?? '';
    assert.ok(!/Download limit reached/.test(f), f);
    await evaluate(`${S}.setFilter('all'); 1`);
  });

  await check('mail-pruned during a sync survives the sync, and only that mailbox is marked', async () => {
    await evaluate(`${S}.setPrefs({ maxDownload: 2000 }); 1`); // raising: the marks are cleared
    await sleep(300);
    assert.deepEqual(await limited(), []);
    await evaluate(`(async () => { const p = ${S}.sync(); await new Promise((r) => setTimeout(r, 30)); await window.__mockEmit('mail-pruned', { accountId: 'a2', removed: 3 }); await p; return 1; })()`);
    const keys = await limited();
    assert.ok(keys.includes('a2|inbox') && !keys.some((k) => k.startsWith('a1|')), JSON.stringify(keys));
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-prune-limit: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-prune-limit: ok');
