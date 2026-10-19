#!/usr/bin/env node
// Discard pressed in quick succession (QA 1.0.7 part B BUG-1 / D-029: "Discard removed the saved copy from Drafts with no question, the message stayed open and the autosave
// wrote it back"; three presses within about 2 s). Real Compose in the dev preview (mock backend: `__discardDrafts`, `__discardChanges`, `__draftSaveCalls`, `__draftCount()`),
// real mouse clicks and real Enter key presses, in the pane and in the compose window (`?w=compose`), with a NEW message that an autosave made a draft of and with a draft that
// was OPENED from Drafts and changed (autosave replaced it):
//   - 1, 2, 3 and 5 presses of the toolbar Discard (mouse), the same with the keyboard (focus + Enter), and one press followed by repeated Enter in the question:
//     nothing is removed from Drafts before the person confirmed (the mock counts the removals), the message and its text stay, no second save made a copy;
//   - a press that the question's backdrop takes (the question dismisses like Esc) leaves the same state; a second question is never open on top of the first;
//   - then ONE confirmed Discard: exactly one removal, the message ends (the pane goes / the window ends), the Drafts count is what it should be (a new message: none; an
//     opened draft: the original is back), and nothing is written afterwards (the window losing the focus and the autosave timer run: no new draft, "resurrection");
//   - the store's one question at a time: a second `choose` while one is open answers the first as dismissed (nobody waits for ever).
//   node scripts/test-discard-rapid.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-discard-rapid', { vitePort0: 5980 });
const { evaluate, cdp } = H;
const io = inputs(H, null, 'dr');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));

const counters = () => json(`({ removed: window.__discardDrafts ?? 0, restored: window.__discardChanges ?? 0, saves: window.__draftSaveCalls ?? 0, drafts: window.__draftCount ? window.__draftCount() : 0 })`);
const state = () => json(`({ pane: !!document.querySelector('.compose-pane'), dialogs: document.querySelectorAll('[role=alertdialog]').length, opened: window.__qOpened ?? 0, text: document.querySelector('.cp-editor .tiptap')?.editor.getText() ?? null })`);
const discardBox = () => json(`(() => { const b = [...document.querySelectorAll('.cp-bar button')].find((x) => /^Discard$/.test(x.textContent.trim())); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const watchQuestions = () => evaluate(`(() => { window.__qOpened = 0; let open = false; new MutationObserver(() => { const now = !!document.querySelector('[role=alertdialog]'); if (now && !open) window.__qOpened++; open = now; }).observe(document.body, { childList: true, subtree: true }); return 1; })()`);
const hasDiscard = `[...document.querySelectorAll('.cp-bar button')].some((x) => /^Discard$/.test(x.textContent.trim()))`;
const clickDiscard = async () => { assert.ok(await waitFor(hasDiscard, 5000), 'the toolbar has no Discard button'); const b = await discardBox(); await io.clickAt(b.x, b.y); };
const enterOnDiscard = async () => {
  await evaluate(`[...document.querySelectorAll('.cp-bar button')].find((x) => /^Discard$/.test(x.textContent.trim())).focus(); 1`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const enter = async () => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
const answer = async (label) => { const p = await json(`(() => { const all = [...document.querySelectorAll('[role=alertdialog] button')]; const b = ${label === 'Discard' ? 'all[all.length - 1]' : `all.find((x) => x.textContent.trim() === ${JSON.stringify(label)})`}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); assert.ok(p, `no "${label}" in the question`); await io.clickAt(p.x, p.y); };
const leaveWindow = () => evaluate(`window.dispatchEvent(new Event('blur')); 1`);

/** A message with To, subject and text whose autosave has made a draft (count 1). */
async function newAutosaved(win) {
  if (win) {
    await H.openApp('lang=en', 1280, 720);
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'the window did not start');
    await sleep(900);
    await evaluate(`window.__popoutCalls = []; 1`);
  } else {
    await H.openApp('lang=en', 1280, 720);
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: '' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
    await sleep(700);
  }
  await evaluate(`window.__hlTiming = { autosaveMs: 400, snapshotMs: 300 }; 1`);
  if (win) { await evaluate(`document.querySelector('.cf-field.rcpt input').focus(); 1`); await io.typeText('alice@fabrikam.com,', 4); }
  await evaluate(`document.querySelector('input[aria-label="Subject"]').focus(); 1`);
  await io.typeText('Rapid discard', 4);
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('end'); 1`);
  await io.typeText('x text that must stay', 4);
  await leaveWindow();
  assert.ok(await waitFor(`window.__draftCount && window.__draftCount() === 1`, 8000), 'the autosave made no draft');
  await sleep(800);
}
/** A draft opened from Drafts, changed, and replaced by an autosave (the original is kept by the mock). */
async function openedChanged() {
  await newAutosaved(false);
  await evaluate(`window.__store.getState().composeSaver?.({ quiet: true }); 1`);
  await sleep(600);
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await sleep(500);
  await evaluate(`[...document.querySelectorAll('.fp-row')].filter((r) => /^Drafts/.test(r.innerText.trim())).pop()?.click(); 1`);
  assert.ok(await waitFor(`!!document.querySelector('[data-thread]')`, 8000), 'no draft in Drafts');
  const p = await json(`(() => { const r = document.querySelector('[data-thread]'); const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  await io.clickAt(p.x, p.y);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 10000), 'the draft did not open');
  await sleep(900);
  await evaluate(`window.__hlTiming = { autosaveMs: 400, snapshotMs: 300 }; document.querySelector('.cp-editor .tiptap').editor.commands.focus('end'); 1`);
  await io.typeText(' plus a change', 4);
  await leaveWindow();
  await sleep(1800);
}

const MODES = {
  mouse: async (n) => { for (let i = 0; i < n; i++) { await clickDiscard(); await sleep(70); } },
  keyboard: async (n) => { for (let i = 0; i < n; i++) { await enterOnDiscard(); await sleep(70); } },
  'one press, repeated Enter in the question': async (n) => { await clickDiscard(); await sleep(250); for (let i = 0; i < n; i++) { await enter(); await sleep(70); } },
};

async function rapid(where, make, n, modeName, { win = false, opened = false } = {}) {
  const at = `${where} ${modeName} x${n}`;
  await check(at, async () => {
    await make();
    await watchQuestions();
    const before = await counters();
    await MODES[modeName](n);
    await sleep(900);
    let s = await state();
    const mid = await counters();
    assert.equal(mid.removed, before.removed, `a copy was removed before the person confirmed: ${JSON.stringify({ before, mid })}`);
    assert.equal(mid.restored, before.restored, `the opened version was put back before the person confirmed: ${JSON.stringify({ before, mid })}`);
    assert.ok(s.dialogs <= 1, `${s.dialogs} questions are open`);
    assert.equal(s.pane, true, 'the message was closed by the presses');
    assert.match(String(s.text), /that must stay/);
    assert.equal(mid.drafts, before.drafts, 'Drafts changed');
    // the way out is always one clean press and one answer
    if (s.dialogs === 0) { await clickDiscard(); await sleep(500); s = await state(); assert.equal(s.dialogs, 1, 'a press after the presses did not ask'); }
    const saves0 = (await counters()).saves;
    await answer('Discard');
    if (win) assert.ok(await waitFor(`(window.__popoutCalls || []).includes('popout_destroy')`, 6000), 'the window did not end');
    else assert.ok(await waitFor(`!document.querySelector('.compose-pane')`, 6000), 'the message did not end');
    await sleep(700);
    const after = await counters();
    if (opened) { assert.equal(after.restored, before.restored + 1, `the opened version was put back ${after.restored - before.restored} times`); assert.equal(after.removed, before.removed, 'the discard of a new message ran for an opened draft'); assert.equal(after.drafts, 1, 'the original is not back'); }
    else { assert.equal(after.removed, before.removed + 1, `the saved copy was removed ${after.removed - before.removed} times`); assert.equal(after.drafts, 0, 'a draft is left'); }
    // nothing is written afterwards: the window loses the focus, the autosave timer runs
    await leaveWindow();
    await sleep(2500);
    const late = await counters();
    assert.equal(late.saves, saves0, `a save after the Discard: ${JSON.stringify({ saves0, late })}`);
    assert.equal(late.drafts, after.drafts, 'a draft came back after the Discard');
  });
}

try {
  for (const modeName of Object.keys(MODES)) for (const n of [1, 2, 3, 5]) await rapid('pane, new message', () => newAutosaved(false), n, modeName);
  for (const n of [1, 3, 5]) await rapid('pane, opened draft', openedChanged, n, 'mouse', { opened: true });
  for (const n of [3, 5]) await rapid('pane, opened draft', openedChanged, n, 'keyboard', { opened: true });
  for (const modeName of Object.keys(MODES)) for (const n of [1, 3, 5]) await rapid('window, new message', () => newAutosaved(true), n, modeName, { win: true });

  // the store answers a question that is replaced as dismissed
  await check('a second question replaces the first: the first is answered as dismissed, nobody waits for ever', async () => {
    await H.openApp('lang=en', 1280, 720);
    const r = await evaluate(`(async () => {
      const st = window.__store.getState();
      const first = st.choose({ title: 'First?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], dismiss: 'b' });
      const second = st.choose({ title: 'Second?', choices: [{ id: 'x', label: 'X' }] });
      const one = await Promise.race([first, new Promise((ok) => setTimeout(() => ok('NEVER'), 1500))]);
      const title = document.querySelector('[role=alertdialog] h3')?.textContent;
      st.resolveAsk('x');
      return JSON.stringify({ one, two: await second, title });
    })()`);
    assert.deepEqual(JSON.parse(r), { one: 'b', two: 'x', title: 'Second?' });
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-discard-rapid: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-discard-rapid: ok');
