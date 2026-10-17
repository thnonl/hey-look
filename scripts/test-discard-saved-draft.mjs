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
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-discard-saved-draft: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-discard-saved-draft: ok');
