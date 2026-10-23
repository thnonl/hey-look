#!/usr/bin/env node
// Discard changes on an opened draft BEFORE any save (no autosave yet) while the server lost the draft (1.0.7 D-043, Mac QA WK-2d.09): another program expunged the
// opened message, so nothing of the person's edits is on the server and the opened version is the only copy there ever was. REQ-2.2.7: it is put back (one draft,
// the version that was opened, no notice). Before: the page had nothing to take back, did nothing, and the draft was gone (3 -> 2).
// The page asks the backend with `m:<local id>` (`discard_draft_changes`); the backend appends the opened version when no copy with its Message-ID is on the server
// (idempotent; the Rust tests are in draftmail.rs `discard_changes_before_any_save_*`). Here the real compose pane in the dev preview (mock backend: `__mockExpungeDraft`,
// `__discardUnsaved`) with real clicks:
//   - the draft is expunged, an edit is typed (autosave far away), Discard changes: Drafts holds the opened version, the pane is gone, no notice, one question to the backend;
//   - the server still has it: Drafts holds that one draft, unchanged (nothing is added), no notice;
//   - the draft was never changed (Discard closes at once) and was expunged: put back as well;
//   - the backend refuses / answers slowly: Discard still closes the pane (a server problem never keeps the person from discarding);
//   - a new message (no opened draft): the backend is not asked at all.
//   node scripts/test-discard-expunged.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-discard-expunged', { vitePort0: 5760 });
const { evaluate } = H;
const io = inputs(H, null, 'dx');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };

const mod = (path) => `import(${JSON.stringify(path)})`;
const drafts = () => evaluate(`${mod('/src/api.ts')}.then(async (m) => { const rows = await m.api.listThreads({ folder: 'drafts' }); const out = []; for (const r of rows) { const th = await m.api.getThread(r.threadId, 'drafts'); out.push({ id: r.threadId, text: th[th.length - 1].text || '' }); } return out; })`);
const dialog = () => evaluate(`(() => { const d = document.querySelector('[role=alertdialog]'); return d ? { text: d.innerText.replace(/\\s+/g, ' '), buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`);
const paneUp = () => evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor`);
const waitPane = async () => { for (let i = 0; i < 80 && !(await paneUp()); i++) await sleep(100); await sleep(500); };
const press = (label, within) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(within)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const toasts = () => evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | ')`);
const asked = () => evaluate(`window.__discardUnsaved || []`);

/** A saved draft with the text 'Original text', opened again from Drafts (its autosave is far away: nothing is saved). Resolves to the draft's id. */
async function opened(flags = '') {
  await H.openApp(`lang=en${flags}`, 1280, 720);
  await evaluate(`window.__hlTiming = { autosaveMs: 600000, snapshotMs: 300 }; window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'D43' }); 1`);
  await waitPane();
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent('<p>Original text</p>'); 1`);
  await evaluate(`window.__store.getState().composeSaver({ quiet: true }); 1`);
  await sleep(700);
  await evaluate(`window.__store.getState().openCompose(null); 1`);
  await sleep(300);
  const saved = await drafts();
  assert.equal(saved.length, 1, 'the first draft was not saved');
  await evaluate(`${mod('/src/draftOpen.ts')}.then((m) => m.openDraftThread(${JSON.stringify(saved[0].id)}, true))`);
  await waitPane();
  return saved[0].id;
}
const edit = async () => {
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('end'); 1`);
  await io.typeText(' plus edits', 6);
  await sleep(300);
};
const discardChanges = async () => {
  await press('Discard', '.cp-bar button, .cp-bar .rb');
  await sleep(400);
  assert.deepEqual((await dialog())?.buttons, ['Cancel', 'Discard changes'], 'the question of an opened draft with changes');
  await press('Discard changes', '[role=alertdialog] button');
};
const closed = async (limitMs) => { const t0 = Date.now(); while (Date.now() - t0 < limitMs) { if (!(await paneUp())) return Date.now() - t0; await sleep(100); } return null; };

try {
  // 1. the case of the report
  await check('expunged, edited, Discard changes: the opened version is put back', async () => {
    const id = await opened();
    const saves = await evaluate(`window.__draftSaveCalls || 0`);
    await edit();
    assert.equal(await evaluate(`window.__draftSaveCalls || 0`), saves, 'an autosave ran: this run does not test the no-autosave case');
    assert.equal(await evaluate(`window.__mockExpungeDraft(${JSON.stringify(id)})`), true);
    assert.equal((await drafts()).length, 0, 'the server copy is gone');
    await discardChanges();
    assert.notEqual(await closed(8000), null, 'the pane did not close');
    await sleep(300);
    const d = await drafts();
    assert.equal(d.length, 1, `Drafts holds ${d.length} drafts: ${JSON.stringify(d)}`);
    assert.ok(d[0].text.startsWith('Original text'), 'not the version that was opened: ' + d[0].text);
    assert.ok(!d[0].text.includes('plus edits'));
    assert.deepEqual(await asked(), [`m:${await evaluate(`'a1:drafts:' + ${JSON.stringify(id)}`)}`], 'the backend was asked once, with the opened draft');
    assert.equal(await evaluate(`window.__discardChanges || 0`), 0, 'no restore of a saved copy ran');
    assert.doesNotMatch(await toasts(), /no longer available|original version|moved or deleted/i, 'a notice was shown');
  });

  // 2. the server still has it: nothing is added
  await check('still on the server: nothing is written, the draft stays', async () => {
    const id = await opened();
    await edit();
    await discardChanges();
    assert.notEqual(await closed(8000), null, 'the pane did not close');
    await sleep(300);
    const d = await drafts();
    assert.equal(d.length, 1, JSON.stringify(d));
    assert.equal(d[0].id, id, 'the draft is the one that was opened, not a new copy');
    assert.ok(d[0].text.startsWith('Original text'), d[0].text);
    assert.doesNotMatch(await toasts(), /no longer available|original version/i);
  });

  // 3. never changed, then expunged: Discard closes at once (no question) and puts it back
  await check('unchanged and expunged: closed without a question, put back', async () => {
    const id = await opened();
    await evaluate(`window.__mockExpungeDraft(${JSON.stringify(id)})`);
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    assert.notEqual(await closed(8000), null, 'the pane did not close');
    await sleep(300);
    const d = await drafts();
    assert.equal(d.length, 1, JSON.stringify(d));
    assert.ok(d[0].text.startsWith('Original text'), d[0].text);
  });

  // 4. the backend refuses: Discard still closes, nothing is shown
  await check('the backend refuses: the pane closes all the same', async () => {
    const id = await opened('&restorefail');
    await edit();
    await evaluate(`window.__mockExpungeDraft(${JSON.stringify(id)})`);
    await discardChanges();
    assert.notEqual(await closed(8000), null, 'the pane did not close');
    assert.doesNotMatch(await toasts(), /refused|failed|error/i, 'an error was shown for a draft that had nothing saved');
  });

  // 5. the backend answers after a minute: the pane closes within 7 s
  await check('a slow backend does not hold the pane', async () => {
    const id = await opened();
    await edit();
    await evaluate(`window.__discardUnsavedMs = 60000; window.__mockExpungeDraft(${JSON.stringify(id)})`);
    await discardChanges();
    const ms = await closed(9000);
    assert.notEqual(ms, null, 'the pane did not close within 9 s');
    assert.ok(ms >= 5000 && ms <= 8500, `closed after ${ms} ms (the wait is 6 s)`);
  });

  // 6. a new message: the backend is not asked
  await check('a new message: no question to the backend', async () => {
    await H.openApp('lang=en', 1280, 720);
    await evaluate(`window.__hlTiming = { autosaveMs: 600000, snapshotMs: 300 }; window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'new' }); 1`);
    await waitPane();
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent('<p>words</p>'); 1`);
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    await sleep(400);
    await press('Discard', '[role=alertdialog] button');
    assert.notEqual(await closed(5000), null, 'the pane did not close');
    assert.deepEqual(await asked(), []);
  });
} catch (e) {
  failures.push(`run: ${e && e.stack ? e.stack : e}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error('test-discard-expunged: FAILED\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('ok - test-discard-expunged');
