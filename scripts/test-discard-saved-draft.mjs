#!/usr/bin/env node
// Discard takes the draft that an autosave made away too, in every case (v1.0.6 QA round 2, observation O4: a "(no subject)" draft stayed in Drafts after one
// Discard). Cause: Compose's Discard button removed "the saved copy" at once, but an autosave that was still on its way to the server (the question "Discard this
// message?" stays open for a while, the window lost the focus a moment before) makes its draft only when it is done: the copy was not known yet, nothing was
// removed, and the draft stayed. Leaving the message with "Discard" in the "unsent message" question and the compose window already waited for a running save;
// the Discard button did not. Now Discard stops further autosaves, waits for the one that runs, then removes the copy.
//
// Real compose pane in the dev preview (src/devMock.ts: `#draftslow` makes a save take 1.5 s, the mock holds the draft at once like the server does when the
// APPEND is done; `__draftCount()`), real clicks on Discard and on the question: the draft count must be 0 afterwards, however the autosave and the Discard
// overlap. The compose window (`?w=compose`) is the same component with the same end-of-message hook.
//   node scripts/test-discard-saved-draft.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-discard-saved-draft', { vitePort0: 5920, cdpPort0: 9920 });
const { evaluate } = H;
const io = inputs(H, null, 'ds');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

const count = () => evaluate(`window.__draftCount ? window.__draftCount() : 0`);
const pane = () => evaluate(`!!document.querySelector('.compose-pane')`);
const press = (label, within = 'button') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(within)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

async function fresh(slow) {
  await H.openApp(`lang=en${slow ? '&draftslow' : ''}`, 1280, 720);
  await evaluate(`window.__hlTiming = { autosaveMs: 500, snapshotMs: 300 }; window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: '' }); 1`);
  for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor`)); i++) await sleep(100);
  await sleep(500);
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('start'); 1`);
  await io.typeText('some words to keep', 6);
  await sleep(200);
}
const leaveWindow = () => evaluate(`window.dispatchEvent(new Event('blur')); 1`); // the window loses the focus: an autosave starts at once

try {
  // 1. Discard while the autosave is on its way to the server
  await fresh(true);
  await leaveWindow();
  await sleep(150);
  await check('the autosave made a draft (the test is a real one)', async () => assert.equal(await count(), 1));
  await press('Discard', '.cp-bar button, .cp-bar .rb');
  await sleep(300);
  await check('the question "Discard this message?" is asked', async () => assert.ok(await press('Discard', '[role=alertdialog] button')));
  await sleep(3500);
  await check('Discard while an autosave runs: no draft is left', async () => assert.equal(await count(), 0));
  await check('Discard closes the compose pane', async () => assert.equal(await pane(), false));

  // 2. Discard after the autosave finished
  await fresh(true);
  await leaveWindow();
  await sleep(2200);
  await check('the autosave made its draft', async () => assert.equal(await count(), 1));
  await press('Discard', '.cp-bar button, .cp-bar .rb');
  await sleep(300);
  await press('Discard', '[role=alertdialog] button');
  await sleep(1500);
  await check('Discard after an autosave: no draft is left', async () => assert.equal(await count(), 0));

  // 3. Discard answered at once while the save is still running, and nothing saves again afterwards (the timers keep running until the pane is gone)
  await fresh(true);
  await leaveWindow();
  await press('Discard', '.cp-bar button, .cp-bar .rb');
  await sleep(120);
  await press('Discard', '[role=alertdialog] button');
  await sleep(5000);
  await check('Discard answered at once: no draft is left, and none comes later', async () => { assert.equal(await count(), 0); assert.equal(await pane(), false); });

  // 4. leaving the message for another one with "Discard" in the question (the same hook the compose window and a quit use)
  await fresh(true);
  await leaveWindow();
  await sleep(150);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['bob@x.test'], subject: 'second' }); 1`);
  await sleep(400);
  await press('Discard', '[role=alertdialog] button');
  await sleep(3500);
  await check('leaving with Discard while an autosave runs: no draft of the first message is left', async () => assert.equal(await count(), 0));
  await evaluate(`window.__store.getState().openCompose(null); 1`);

  // 5. a save that does not close the message (the one "Save and continue" of the leave question makes), then Discard: the draft that save made goes too (a NEW message)
  await fresh(false);
  await evaluate(`window.__store.getState().composeSaver({ quiet: true }); 1`);
  await sleep(700);
  await check('the save made a draft', async () => assert.equal(await count(), 1));
  await press('Discard', '.cp-bar button, .cp-bar .rb');
  await sleep(300);
  await press('Discard', '[role=alertdialog] button');
  await sleep(1200);
  await check('Discard after a save that kept the message open: the draft goes', async () => assert.equal(await count(), 0));

  // ---------- 1.0.7 W2.2: a draft that was opened from Drafts. Discard puts the version that was opened back (never deletes the draft)
  const mod = (path) => `import(${JSON.stringify(path)})`;
  const drafts = () => evaluate(`${mod('/src/api.ts')}.then(async (m) => { const rows = await m.api.listThreads({ folder: 'drafts' }); const out = []; for (const r of rows) { const th = await m.api.getThread(r.threadId, 'drafts'); out.push({ id: r.threadId, text: th[th.length - 1].text || '' }); } return out; })`);
  const dialog = () => evaluate(`(() => { const d = document.querySelector('[role=alertdialog]'); return d ? { text: d.innerText.replace(/\\s+/g, ' '), buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`);
  const paneUp = () => evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor`);
  const editText = () => evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`);
  const waitPane = async () => { for (let i = 0; i < 80 && !(await paneUp()); i++) await sleep(100); await sleep(500); };
  const openFromDrafts = async (id) => { await evaluate(`${mod('/src/components/Compose.tsx')}.then((m) => m.openDraftThread(${JSON.stringify(id)}, true))`); await waitPane(); };
  /** a saved draft with the text 'Original text', then opened again and given ' plus edits', and the autosave has run */
  async function openedAndEdited(flags = '') {
    await H.openApp(`lang=en${flags}`, 1280, 720);
    await evaluate(`window.__hlTiming = { autosaveMs: 500, snapshotMs: 300 }; window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'D1', bodyHtml: '<p>Original text</p>' }); 1`);
    await waitPane();
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent(' '); 1`); // a change, so Save draft has something
    await evaluate(`window.__store.getState().composeSaver({ quiet: true }); 1`);
    await sleep(700);
    await evaluate(`window.__store.getState().openCompose(null); 1`);
    await sleep(300);
    const saved = await drafts();
    assert.equal(saved.length, 1, 'the first draft was not saved');
    await openFromDrafts(saved[0].id);
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('end'); 1`);
    await io.typeText(' plus edits', 6);
    await leaveWindow(); // the window loses the focus: the autosave runs
    await sleep(1500);
    return saved[0].text;
  }

  {
    const original = await openedAndEdited();
    await check('opened draft: the autosave replaced the opened version (one draft, with the edits)', async () => {
      const d = await drafts();
      assert.equal(d.length, 1);
      assert.ok(d[0].text.includes('plus edits'), d[0].text);
    });
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    await sleep(400);
    await check('opened draft with changes: its own question and button', async () => {
      const q = await dialog();
      assert.ok(q, 'no question');
      assert.match(q.text, /Discard your changes\?/);
      assert.match(q.text, /The draft goes back to how it was when you opened it\./);
      assert.deepEqual(q.buttons, ['Cancel', 'Discard changes']);
      assert.doesNotMatch(q.text, /What you wrote will be lost/);
    });
    // Cancel keeps the message and its edits
    await press('Cancel', '[role=alertdialog] button');
    await sleep(300);
    await check('Cancel: the message stays with the edits, nothing was restored', async () => {
      assert.equal(await paneUp(), true);
      assert.ok((await editText()).includes('plus edits'));
      assert.equal(await dialog(), null);
      assert.ok(!(await evaluate(`window.__discardChanges`)));
    });
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    await sleep(300);
    await press('Discard changes', '[role=alertdialog] button');
    await sleep(1200);
    await check('Discard changes: Drafts holds one draft, the version that was opened, and the pane is gone', async () => {
      const d = await drafts();
      assert.equal(d.length, 1, JSON.stringify(d));
      assert.equal(d[0].text.trim(), original.trim());
      assert.ok(!d[0].text.includes('plus edits'));
      assert.equal(await paneUp(), false);
      assert.equal(await evaluate(`window.__discardChanges`), 1);
    });

    // an opened draft without changes: Discard closes at once, writes nothing
    const saves = await evaluate(`window.__draftSaveCalls || 0`);
    await openFromDrafts((await drafts())[0].id);
    await sleep(800);
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    await sleep(500);
    await check('opened draft without changes: no question, closed, nothing written', async () => {
      assert.equal(await dialog(), null);
      assert.equal(await paneUp(), false);
      assert.equal(await evaluate(`window.__draftSaveCalls || 0`), saves);
      assert.equal(await evaluate(`window.__discardChanges`), 1, 'no restore ran');
      assert.equal((await drafts()).length, 1);
    });
  }
  {
    // the server refuses to put the original back: the message stays open, the saved edits stay in Drafts
    await openedAndEdited('&restorefail');
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    await sleep(300);
    await press('Discard changes', '[role=alertdialog] button');
    await sleep(1200);
    await check('a failed restore: the pane stays open, the autosaved edits stay (never zero drafts), the error shows', async () => {
      assert.equal(await paneUp(), true);
      const d = await drafts();
      assert.equal(d.length, 1);
      assert.ok(d[0].text.includes('plus edits'));
      assert.match(await evaluate(`document.body.innerText`), /refused the draft/);
    });
  }
  {
    // a NEW message: the old question and the old effect
    await fresh(false);
    await leaveWindow();
    await sleep(1200);
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    await sleep(300);
    await check('new message: "Discard this message?" as before, and no copy is left', async () => {
      const q = await dialog();
      assert.match(q.text, /Discard this message\?/);
      assert.match(q.text, /What you wrote will be lost\./);
      await press('Discard', '[role=alertdialog] button');
      await sleep(1000);
      assert.equal(await count(), 0);
      assert.ok(!(await evaluate(`window.__discardChanges`)));
    });
  }

  // ---------- 1.0.7 W2.3: a new message that was autosaved and then emptied leaves no copy behind, on every way out
  async function savedThenEmptied() {
    await fresh(false);
    await leaveWindow();
    await sleep(1200);
    assert.equal(await count(), 1, 'the autosave did not make a draft');
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.clearContent(); 1`);
    await sleep(300);
  }
  await savedThenEmptied();
  await check('emptied and left (another mail): no question, no copy', async () => {
    await evaluate(`window.__store.getState().leaveCompose(); 1`);
    await sleep(1200);
    assert.equal(await dialog(), null);
    assert.equal(await paneUp(), false);
    assert.equal(await count(), 0);
  });
  await savedThenEmptied();
  await check('emptied, then another message replaces the pane: no question, no copy', async () => {
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['bob@x.test'], subject: 'second' }); 1`);
    await sleep(1200);
    assert.equal(await dialog(), null);
    assert.equal(await count(), 0);
    await evaluate(`window.__store.getState().openCompose(null); 1`);
  });
  await savedThenEmptied();
  await check('emptied and Discard: no question, no copy (as before)', async () => {
    await press('Discard', '.cp-bar button, .cp-bar .rb');
    await sleep(1200);
    assert.equal(await dialog(), null);
    assert.equal(await count(), 0);
  });
  {
    // a subject alone is content: closing saves as today
    await savedThenEmptied();
    await evaluate(`document.querySelector('input[aria-label="Subject"]').focus(); 1`);
    await io.typeText('keep me', 6);
    await sleep(300);
    await evaluate(`window.__store.getState().leaveCompose(); 1`);
    await sleep(1500);
    await check('emptied but with a subject: saved as a draft, closed', async () => {
      assert.equal(await paneUp(), false);
      assert.equal(await count(), 1);
    });
  }
  {
    // the compose window: closing it (X) when the message was emptied after an autosave
    await H.openApp('lang=en&autosave=500&snapshot=300', 1280, 720);
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en&autosave=500&snapshot=300` });
    await sleep(800);
    for (let i = 0; i < 60 && !(await paneUp()); i++) await sleep(100);
    await sleep(600);
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('start'); 1`);
    await io.typeText('window words', 6);
    await leaveWindow();
    await sleep(1500);
    const had = await count();
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.clearContent(); 1`);
    await sleep(300);
    await evaluate(`window.__mockEmit('tauri://close-requested', null); 1`);
    await sleep(1500);
    await check('window: emptied after an autosave, closed with X: no question, no copy', async () => {
      assert.equal(had, 1, 'the autosave did not make a draft');
      assert.equal(await dialog(), null);
      assert.equal(await count(), 0);
    });
  }

  // ---------- 1.0.7 WP2a fix 1 (QA BUG-2): a draft moved into a window the way it was opened is not "changed" there: closing the window asks nothing and writes
  // nothing (before, the window counted every moved message as changed: the question showed, and losing the focus autosaved the original again, so a
  // Discard wrote it twice). A message that has changes, or that a save has replaced, still moves as changed.
  const popped = () => evaluate(`(window.__popoutOpened || []).slice(-1)[0] || null`);
  const popOutPane = async () => { await evaluate(`document.querySelector('button[aria-label="Pop out"]').click(); 1`); await sleep(700); };
  async function openedClean() {
    await H.openApp('lang=en', 1280, 720);
    await evaluate(`window.__hlTiming = { autosaveMs: 500, snapshotMs: 300 }; window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'D1', bodyHtml: '<p>Original text</p>' }); 1`);
    await waitPane();
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent(' '); 1`);
    await evaluate(`window.__store.getState().composeSaver({ quiet: true }); 1`);
    await sleep(700);
    await evaluate(`window.__store.getState().openCompose(null); 1`);
    await sleep(300);
    await openFromDrafts((await drafts())[0].id);
    await sleep(500);
  }
  {
    await openedClean();
    await popOutPane();
    await check('pane: an opened draft nobody touched moves to a window as it is (not "carried")', async () => {
      const p = await popped();
      assert.ok(p && p.kind === 'compose', 'no window was asked for');
      assert.ok(!p.init.carried, `carried: ${p.init.carried}`);
      assert.equal(p.init.openedDraft, true);
      assert.ok(p.init.replaces.startsWith('m:'), p.init.replaces);
      assert.equal(await paneUp(), false, 'the pane closes once the window exists');
    });
    await openedClean();
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('end'); 1`);
    await io.typeText(' more', 6);
    await popOutPane();
    await check('pane: an opened draft with changes moves as carried (the window asks when it is closed)', async () => {
      const p = await popped();
      assert.equal(p.init.carried, true);
      assert.equal(p.init.openedDraft, true);
    });
    await openedAndEdited(); // edited, and the autosave replaced the opened version
    await popOutPane();
    await check('pane: an opened draft that a save replaced moves as carried, with the reference of the saved copy', async () => {
      const p = await popped();
      assert.equal(p.init.carried, true);
      assert.ok(p.init.replaces.startsWith('mid:'), p.init.replaces);
      assert.equal(p.init.openedDraft, true);
    });
  }
  async function windowOf(mock, timers = 'autosave=500&snapshot=300') {
    await H.openApp(`lang=en&${timers}`, 1280, 720);
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=${mock}#lang=en&${timers}` });
    await sleep(800);
    for (let i = 0; i < 60 && !(await paneUp()); i++) await sleep(100);
    await sleep(600);
  }
  {
    await windowOf('opened');
    await leaveWindow(); // the window loses the focus: a changed message would autosave now
    await sleep(1500);
    const saves = await evaluate(`window.__draftSaveCalls || 0`);
    await evaluate(`window.__mockEmit('tauri://close-requested', null); 1`);
    await sleep(1000);
    await check('window: an opened draft moved as it was opened: losing the focus writes nothing, X closes it without a question', async () => {
      assert.equal(saves, 0, 'it saved by itself');
      assert.equal(await dialog(), null, 'a question was asked');
      assert.equal(await evaluate(`window.__draftSaveCalls || 0`), 0);
      assert.ok(!(await evaluate(`window.__discardChanges`)), 'something was put back');
    });
    await windowOf('openedcarried');
    await leaveWindow();
    await sleep(1500);
    await evaluate(`window.__mockEmit('tauri://close-requested', null); 1`);
    await sleep(800);
    await check('window: an opened draft moved WITH changes still autosaves and asks when it is closed', async () => {
      assert.equal(await evaluate(`window.__draftSaveCalls || 0`), 1);
      const q = await dialog();
      assert.ok(q && /Save your message\?/.test(q.text), JSON.stringify(q));
      assert.deepEqual(q.buttons, ['Cancel', 'Save', 'Discard']);
    });
    await windowOf('openedsaved', 'autosave=600000&snapshot=600000'); // (no autosave of its own in the window: the saved copy it takes back is the one the pane made)
    await evaluate(`window.__mockEmit('tauri://close-requested', null); 1`);
    await sleep(800);
    await press('Discard', '[role=alertdialog] button');
    await sleep(1000);
    await check('window: an opened draft that the pane had saved (a mid: reference): Discard asks the backend to put the opened version back', async () => {
      assert.equal(await evaluate(`window.__discardChanges`), 1, 'the window did not know the saved copy it has to take back');
    });
  }
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-discard-saved-draft: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-discard-saved-draft: ok');
