#!/usr/bin/env node
// Ctrl+Shift+K opens the command bar from anywhere, the message body included (1.0.7 W2.14), real Compose in the dev preview with real key events:
//   - in the body with "ell" of "Hello" selected: the command bar opens with the focus in its search box and nothing is typed or linked; Esc closes it and the focus and
//     the selection are as they were (the body still reads "Hello", "ell" is selected, no link mark);
//   - from the Subject field and the To field: the same, the field text is unchanged and the caret is back in the field;
//   - Ctrl+K in the body is still the link dialog (the command bar stays closed), Ctrl+K in the To field opens the command bar;
//   - AltGr+Shift+K (Ctrl+Alt+Shift+K) opens nothing.
//   node scripts/test-command-bar-key.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-command-bar-key', { vitePort0: 5640, cdpPort0: 9640 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 400)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const barOpen = () => evaluate(`!!document.querySelector('.modal.cmd')`);
const barFocused = () => evaluate(`document.activeElement === document.querySelector('.modal.cmd input')`);
// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8
const key = async (k, code, vk, modifiers, text) => {
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const ctrlShiftK = () => key('K', 'KeyK', 75, 2 | 8);
const esc = () => key('Escape', 'Escape', 27, 0);
const editorState = () => json(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; const { from, to } = ed.state.selection; return { text: ed.getText(), sel: ed.state.doc.textBetween(from, to), link: ed.getHTML().includes('<a '), focus: !!document.activeElement?.closest('.ProseMirror') }; })()`);

const selectEll = () => evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; let at = -1; ed.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('Hello')) at = pos + n.text.indexOf('Hello'); return at < 0; }); ed.commands.focus(); ed.commands.setTextSelection({ from: at + 1, to: at + 4 }); return at; })()`);

try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello subject', bodyHtml: '<p>Hello</p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  // select "ell" of "Hello" in the body
  await selectEll();
  await sleep(300);
  const before = await editorState();
  assert.equal(before.sel, 'ell', JSON.stringify(before));
  await ctrlShiftK();
  await check('body: Ctrl+Shift+K opens the command bar with the focus in its search box', async () => {
    assert.ok(await waitFor(`!!document.querySelector('.modal.cmd')`, 3000), 'the command bar did not open');
    assert.ok(await barFocused(), 'the search box has no focus');
    assert.equal(await evaluate(`document.querySelector('.modal.cmd input').value`), '');
    const s = await editorState();
    assert.equal(s.text.trim(), 'Hello');
    assert.equal(s.link, false);
  });
  await esc();
  await check('body: Esc closes it; the body still reads "Hello", "ell" is selected, the focus is back, no link', async () => {
    assert.ok(await waitFor(`!document.querySelector('.modal.cmd')`, 3000), 'still open');
    assert.ok(await waitFor(`!!document.activeElement?.closest('.ProseMirror')`, 3000), String(await evaluate(`document.activeElement?.tagName + '.' + document.activeElement?.className`)));
    const s = await editorState();
    assert.equal(s.text.trim(), 'Hello');
    assert.equal(s.sel, 'ell');
    assert.equal(s.link, false);
  });
  // the subject field
  await evaluate(`document.querySelector('input[aria-label="Subject"]').focus(); 1`);
  await ctrlShiftK();
  await check('Subject: Ctrl+Shift+K opens the bar, Esc gives the field back with its text', async () => {
    assert.ok(await waitFor(`!!document.querySelector('.modal.cmd')`, 3000));
    await esc();
    assert.ok(await waitFor(`!document.querySelector('.modal.cmd')`, 3000));
    assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), 'Subject');
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Subject"]').value`), 'Hello subject');
  });
  // the To field
  await evaluate(`document.querySelector('.cp-fields input[aria-label="To"], input[aria-label="To"]')?.focus(); 1`);
  await ctrlShiftK();
  await check('To: Ctrl+Shift+K opens the bar and types nothing in the field', async () => {
    assert.ok(await waitFor(`!!document.querySelector('.modal.cmd')`, 3000));
    await esc();
    assert.ok(await waitFor(`!document.querySelector('.modal.cmd')`, 3000));
    assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')`), 'To');
    assert.equal(await evaluate(`document.activeElement?.value ?? ''`), '');
  });
  // Ctrl+K: the link dialog in the body, the command bar in the To field
  await key('k', 'KeyK', 75, 2);
  await check('Ctrl+K in the To field opens the command bar', async () => {
    assert.ok(await waitFor(`!!document.querySelector('.modal.cmd')`, 3000));
    await esc();
    assert.ok(await waitFor(`!document.querySelector('.modal.cmd')`, 3000));
  });
  await selectEll();
  await sleep(200);
  await key('k', 'KeyK', 75, 2);
  await sleep(500);
  await check('Ctrl+K in the body is still the link dialog (no command bar)', async () => {
    assert.equal(await barOpen(), false, 'the command bar opened');
    assert.ok(await evaluate(`!!document.querySelector('.link-pop, [role=dialog][aria-label*="ink"]')`), 'no link dialog');
  });
  await esc();
  await sleep(300);
  // AltGr + Shift + K = Ctrl+Alt+Shift+K: a character, not a command
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus(); 1`);
  await key('K', 'KeyK', 75, 1 | 2 | 8);
  await sleep(500);
  await check('Ctrl+Alt+Shift+K (AltGr+Shift+K) opens nothing', async () => assert.equal(await barOpen(), false));
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-command-bar-key: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-command-bar-key: ok');
