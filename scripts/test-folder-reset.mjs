#!/usr/bin/env node
// W6.1 `folder-reset`: the server renumbered a folder and the backend read it again. In the real page (dev preview, mock backend): the event for the folder on screen drops the selection
// (the conversation in the pane, its checked rows) and reads the list again; the event for another folder or another mailbox changes nothing; the all-mailboxes view follows every mailbox.
//   node scripts/test-folder-reset.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-folder-reset', { vitePort0: 5120, cdpPort0: 9120 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(50); } return false; };
const S = 'window.__store.getState()';
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));

try {
  await H.openApp('lang=en', 1280, 800);
  assert.ok(await waitFor(`${S}.threads.length > 2`, 20000), 'the Inbox has conversations');

  const openFirst = async () => {
    const id = await evaluate(`${S}.threads[0].threadId`);
    await evaluate(`${S}.select(${JSON.stringify(id)}); 1`);
    assert.ok(await waitFor(`${S}.selected === ${JSON.stringify(id)} && ${S}.messages.length > 0`, 8000), 'the conversation opened');
    await evaluate(`${S}.setChecked([${JSON.stringify(id)}]); 1`);
    return id;
  };
  const view = () => json(`(() => { const s = ${S}; return { folder: s.folder, accountId: s.accountId, selected: s.selected, messages: s.messages.length, checked: s.checked.size, threads: s.threads.length }; })()`);
  const refreshes = () => evaluate('window.__refreshCount || 0');
  // count the re-reads of the list through the store's own action
  await evaluate(`(() => { const st = window.__store; const orig = st.getState().refresh; window.__refreshCount = 0; st.setState({ refresh: async (...a) => { window.__refreshCount++; return orig(...a); } }); return 1; })()`);

  await check('the folder on screen: the selection and the checked rows go, the list is read again', async () => {
    const accountId = await evaluate(`${S}.accounts[0].id`);
    await evaluate(`${S}.setView('inbox', ${JSON.stringify(accountId)}); 1`);
    assert.ok(await waitFor(`${S}.folder === 'inbox' && ${S}.threads.length > 0`));
    await openFirst();
    const before = await refreshes();
    await evaluate(`window.__mockEmit('folder-reset', { accountId: ${JSON.stringify(accountId)}, role: 'inbox' }); 1`);
    assert.ok(await waitFor(`${S}.selected === null && ${S}.messages.length === 0 && ${S}.checked.size === 0`), JSON.stringify(await view()));
    assert.ok(await waitFor(`(window.__refreshCount || 0) > ${before}`), 'the list was read again');
    assert.ok(await waitFor(`${S}.threads.length > 0`), 'and shows the folder');
  });

  await check('another folder, another mailbox: nothing changes', async () => {
    const accountId = await evaluate(`${S}.accounts[0].id`);
    await evaluate(`${S}.setView('inbox', ${JSON.stringify(accountId)}); 1`);
    assert.ok(await waitFor(`${S}.threads.length > 0`));
    const id = await openFirst();
    await sleep(900); // (opening a conversation may read the list once itself)
    const before = await refreshes();
    await evaluate(`window.__mockEmit('folder-reset', { accountId: ${JSON.stringify(accountId)}, role: 'archive' }); 1`);
    await evaluate(`window.__mockEmit('folder-reset', { accountId: 'some-other-mailbox', role: 'inbox' }); 1`);
    await sleep(500);
    const v = await view();
    assert.equal(v.selected, id, 'the open conversation stays');
    assert.equal(v.checked, 1);
    assert.equal(await refreshes(), before, 'no re-read');
  });

  await check('the all-mailboxes view follows the folder of every mailbox', async () => {
    await evaluate(`${S}.setView('inbox', null); 1`);
    assert.ok(await waitFor(`${S}.accountId === null && ${S}.threads.length > 0`));
    await openFirst();
    await evaluate(`window.__mockEmit('folder-reset', { accountId: 'any-mailbox', role: 'inbox' }); 1`);
    assert.ok(await waitFor(`${S}.selected === null`), JSON.stringify(await view()));
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-folder-reset: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-folder-reset: ok');
