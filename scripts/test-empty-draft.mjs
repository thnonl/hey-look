#!/usr/bin/env node
// A message with nothing in it is never saved as a draft (1.0.7 W13.5; the Mac QA of WP2a found it: a new message with only a recipient was autosaved to
// Drafts 35 s later). The pure rule is scripts/test-compose-content.mjs, the timers scripts/test-autosave.mjs, the backend guard `cargo test --lib
// an_empty_draft_is_refused`; this is the real pane and the real compose window in the dev preview (src/devMock.ts: `__draftSaveCalls` counts every
// save_draft call that reaches the "backend", `__draftCount()` the drafts the mock holds, and the mock refuses an empty draft like lib.rs does).
//
// Per scenario, in the main window and in the compose window (?w=compose):
//   - only a recipient typed: the autosave timer (500 ms here) fires many times and on losing the focus, and not one save_draft call is made; leaving
//     the message (another mail), Discard, closing the window (X) and a quit all end it with no question and no draft;
//   - Save draft with nothing: the toast "Nothing to save yet ...", nothing written, the message stays open;
//   - a subject only, text only, a file only, a meeting place only: a draft is made (or, for a file, Discard / X asks);
//   - a reply nobody changed ends silently; a reply with "ok" typed is autosaved; a reply with only an address added is not.
//   node scripts/test-empty-draft.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-empty-draft', { vitePort0: 5990 });
const { evaluate, cdp } = H;
const io = inputs(H, null, 'ed');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

const TIMERS = 'autosave=500&snapshot=300';
const saves = () => evaluate(`window.__draftSaveCalls || 0`);
const count = () => evaluate(`window.__draftCount ? window.__draftCount() : 0`);
const paneUp = () => evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor`);
const dialog = () => evaluate(`(() => { const d = document.querySelector('[role=alertdialog]'); return d ? { text: d.innerText.replace(/\\s+/g, ' '), buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`);
const probe = () => evaluate(`JSON.stringify((({ hasContent, draftContent }) => ({ hasContent, draftContent }))(window.__store.getState().composeProbe?.() ?? {}))`).then(JSON.parse);
const toasts = () => evaluate(`[...document.querySelectorAll('.toasts .toast')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim())`);
const press = (label, within = 'button') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(within)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
// a header action: its button in the row, or (what did not fit the row) its row in "More actions"
const saveDraftButton = async () => {
  if (await press('Save draft', '.cp-bar button')) return true;
  if (!(await evaluate(`!!document.querySelector('.cp-bar .rb.more')`))) return false;
  await evaluate(`document.querySelector('.cp-bar .rb.more').click(); 1`);
  await sleep(250);
  return press('Save draft', '.dd-fixed [role^=menuitem]');
};
const leaveWindow = () => evaluate(`window.dispatchEvent(new Event('blur')); 1`); // the window loses the focus: an autosave would start at once
const waitPane = async () => { for (let i = 0; i < 80 && !(await paneUp()); i++) await sleep(100); await sleep(700); };
const QUOTE_HTML = '<p>Hello <b>team</b></p>';

/** The main window with a compose pane. `init` is the openCompose argument; a reply gets its quote block like a real one. */
async function pane(init, hash = `lang=en&${TIMERS}`) {
  await H.openApp(hash, 1280, 720);
  await evaluate(`(async () => {
    const init = ${JSON.stringify(init)};
    if (init.reply) { init.bodyHtml = (await import('/src/editor/quoteBlock.ts')).quoteSentHtml({ kind: 'reply', head: 'On Sun, Board wrote:', html: ${JSON.stringify(QUOTE_HTML)} }); init.isReply = true; init.inReplyTo = '<m1@x>'; delete init.reply; }
    window.__hlTiming = { autosaveMs: 500, snapshotMs: 300 };
    await window.__store.getState().openCompose(init);
    return 1;
  })()`);
  await waitPane();
}
/** The compose window of the dev preview (`mock` = new | reply). */
async function win(mock, hash = `lang=en&${TIMERS}`) {
  await H.openApp(hash, 1280, 720);
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=${mock}#${hash}` });
  await sleep(800);
  await waitPane();
}
const typeRecipient = async () => { await evaluate(`document.querySelector('.cf-field.rcpt input').focus(); 1`); await io.typeText('new.person@x.test,', 10); await sleep(300); };
const typeSubject = async () => { await evaluate(`document.querySelector('input[aria-label="Subject"]').focus(); 1`); await io.typeText('Only a subject', 8); await sleep(200); };
const typeBody = async (text) => { await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('start'); 1`); await io.typeText(text, 8); await sleep(200); };
const attachFile = async () => {
  const f = path.join(os.tmpdir(), 'hl-empty-draft-test.txt');
  fs.writeFileSync(f, 'a file');
  const { root } = await cdp('DOM.getDocument', { depth: 1 });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [f] });
  await sleep(600);
};
/** the timers run: 3 s is six autosave intervals here, and the window loses the focus twice */
const letTimersRun = async () => { await sleep(1700); await leaveWindow(); await sleep(1700); await leaveWindow(); await sleep(500); };
const closeWindow = async () => { await evaluate(`window.__mockEmit('tauri://close-requested', null); 1`); await sleep(1000); };

try {
  // ---------- 1. the Mac QA finding: a new message with only a recipient (main window)
  await pane({ accountId: 'a1' });
  await typeRecipient();
  await check('recipient only: the person wrote something (the crash snapshot keeps it) but there is no draft content', async () => {
    const p = await probe();
    assert.deepEqual(p, { hasContent: true, draftContent: false });
  });
  await letTimersRun();
  await check('recipient only: the autosave timer fired and nothing was saved (no APPEND)', async () => {
    assert.equal(await saves(), 0, 'save_draft was called');
    assert.equal(await count(), 0);
  });
  await evaluate(`window.__store.getState().leaveCompose(); 1`);
  await sleep(1000);
  await check('recipient only: leaving for another mail closes with no question and no draft', async () => {
    assert.equal(await dialog(), null);
    assert.equal(await paneUp(), false);
    assert.equal(await saves(), 0);
    assert.equal(await count(), 0);
  });

  // another message replacing the pane (a Reply / New while writing): no question
  await pane({ accountId: 'a1', to: ['alice@fabrikam.com'] });
  await evaluate(`window.__store.getState().composeSaver && 1; window.__store.getState().openCompose({ accountId: 'a1', to: ['bob@x.test'], subject: 'second' }); 1`);
  await sleep(800);
  await check('recipient only: another message replacing the pane asks nothing and writes nothing', async () => {
    assert.equal(await dialog(), null);
    assert.equal(await saves(), 0);
    assert.equal(await count(), 0);
  });

  // Discard
  await pane({ accountId: 'a1' });
  await typeRecipient();
  await press('Discard', '.cp-bar button, .cp-bar .rb');
  await sleep(700);
  await check('recipient only: Discard closes with no question', async () => {
    assert.equal(await dialog(), null);
    assert.equal(await paneUp(), false);
    assert.equal(await saves(), 0);
  });

  // quit (the page's part of it: the event the backend sends)
  await pane({ accountId: 'a1' });
  await typeRecipient();
  await evaluate(`window.__mockEmit('flush-sends', null); 1`);
  await sleep(1500);
  await check('recipient only: a quit asks nothing, writes no draft and empties the pane', async () => {
    assert.equal(await dialog(), null);
    assert.equal(await saves(), 0);
    assert.equal(await paneUp(), false);
    assert.equal(await count(), 0);
  });

  // ---------- 2. Save draft with nothing to save
  await pane({ accountId: 'a1' });
  await check('Save draft on an empty new message: the info toast, nothing written, the message stays', async () => {
    assert.ok(await saveDraftButton(), 'no Save draft button');
    await sleep(600);
    assert.ok((await toasts()).some((x) => /Nothing to save yet\. Add some text, a subject or a file first\./.test(x)), JSON.stringify(await toasts()));
    assert.equal(await saves(), 0);
    assert.equal(await paneUp(), true);
  });
  await typeRecipient();
  await saveDraftButton();
  await sleep(600);
  await check('Save draft with only a recipient: the same toast, nothing written', async () => {
    assert.equal(await saves(), 0);
    assert.equal(await paneUp(), true);
  });

  // ---------- 3. things that ARE content
  await pane({ accountId: 'a1' });
  await typeSubject();
  await letTimersRun();
  await check('a subject only: the autosave makes one draft', async () => {
    assert.deepEqual(await probe(), { hasContent: true, draftContent: true });
    assert.equal(await count(), 1);
  });
  await pane({ accountId: 'a1', to: ['alice@fabrikam.com'] });
  await typeBody('some words');
  await letTimersRun();
  await check('text only: the autosave makes one draft', async () => assert.equal(await count(), 1));

  await pane({ accountId: 'a1' });
  await attachFile();
  await check('a file only: draft content', async () => assert.deepEqual(await probe(), { hasContent: true, draftContent: true }));
  await press('Discard', '.cp-bar button, .cp-bar .rb');
  await sleep(500);
  await check('a file only: Discard asks', async () => {
    const q = await dialog();
    assert.ok(q && /Discard this message\?/.test(q.text), JSON.stringify(q));
  });
  await press('Cancel', '[role=alertdialog] button');
  await sleep(300);
  await evaluate(`window.__store.getState().leaveCompose(); 1`);
  await sleep(1200);
  await check('a file only: leaving saves a draft (a file counts)', async () => {
    assert.equal(await count(), 1);
    assert.equal(await paneUp(), false);
  });

  // a file that came with a NEW message ("send this file") is the person's; the files a forward carries are the original's
  const FILE = [{ filename: 'f.txt', mime: 'text/plain', dataBase64: 'YQ==' }];
  await pane({ accountId: 'a1', subject: '', attachments: FILE });
  await typeRecipient();
  await check('a new message that came with a file: draft content once it is touched', async () => assert.deepEqual(await probe(), { hasContent: true, draftContent: true }));
  await pane({ accountId: 'a1', subject: 'Fwd: x', attachments: FILE, answers: { kind: 'forwarded', accountId: 'a1', messageId: '<m1@x>' } });
  await typeRecipient();
  await check('a forward with its carried file and an address added: no draft content', async () => assert.equal((await probe()).draftContent, false));

  // a meeting with a place typed (AC-13.5.6); the strip alone is nothing
  await pane({ accountId: 'a1', to: ['alice@fabrikam.com'], meeting: { on: true } });
  await check('the meeting strip on, no place: no draft content', async () => {
    assert.ok(await evaluate(`!!document.querySelector('.cp-event')`), 'no meeting strip');
    await evaluate(`document.getElementById('mt-where').focus(); 1`);
    await io.typeText('x', 8);
    await evaluate(`(() => { const i = document.getElementById('mt-where'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await sleep(300);
    assert.equal((await probe()).draftContent, false);
  });
  await evaluate(`(() => { const i = document.getElementById('mt-where'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Room 4'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(300);
  await check('a meeting place typed: draft content, saved when the message is left', async () => {
    assert.equal((await probe()).draftContent, true);
    await evaluate(`window.__store.getState().leaveCompose(); 1`);
    await sleep(1200);
    assert.equal(await count(), 1);
    assert.equal(await paneUp(), false);
  });

  // ---------- 4. a reply
  await pane({ accountId: 'a1', to: ['Board <board@x.test>'], subject: 'Re: Board note', reply: true });
  await letTimersRun();
  await check('a reply nobody changed: nothing saved, leaving asks nothing', async () => {
    assert.equal(await saves(), 0);
    await evaluate(`window.__store.getState().leaveCompose(); 1`);
    await sleep(800);
    assert.equal(await dialog(), null);
    assert.equal(await paneUp(), false);
    assert.equal(await saves(), 0);
  });
  await pane({ accountId: 'a1', to: ['Board <board@x.test>'], subject: 'Re: Board note', reply: true });
  await typeRecipient();
  await letTimersRun();
  await check('a reply with only an address added: nothing saved', async () => {
    assert.deepEqual(await probe(), { hasContent: true, draftContent: false });
    assert.equal(await saves(), 0);
  });
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('start'); 1`);
  await io.typeText('ok', 10);
  await letTimersRun();
  await check('the same reply with "ok" typed: the autosave makes a draft', async () => {
    assert.equal(await count(), 1);
    assert.ok(await saves() >= 1);
  });

  // ---------- 5. a draft that is already in Drafts: its edits are kept, an untouched one can still be saved as it is; a refusal of the backend gets the same toast
  await pane({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'D1', bodyHtml: '<p>Original text</p>', replaces: 'm:a1:drafts:dx', openedDraft: true });
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('end'); 1`);
  await typeRecipient();
  await check('an opened draft with an address added counts (it exists already, the edit is not thrown away)', async () => assert.deepEqual(await probe(), { hasContent: true, draftContent: true }));
  await pane({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'D1', bodyHtml: '<p>Original text</p>', replaces: 'm:a1:drafts:dx', openedDraft: true }, `lang=en&${TIMERS}&draftempty`);
  await saveDraftButton();
  await sleep(800);
  await check('the backend refuses (DRAFT_EMPTY): the toast "Nothing to save yet", the message stays, no error toast', async () => {
    assert.equal(await saves(), 1);
    const t = await toasts();
    assert.ok(t.some((x) => /Nothing to save yet/.test(x)), JSON.stringify(t));
    assert.ok(!t.some((x) => /DRAFT_EMPTY|couldn.t save|failed/i.test(x)), JSON.stringify(t));
    assert.equal(await paneUp(), true);
  });

  // ---------- 6. the compose window
  await win('new');
  await typeRecipient();
  await letTimersRun();
  await check('window, recipient only: the timers fire, nothing is saved', async () => {
    assert.deepEqual(await probe(), { hasContent: true, draftContent: false });
    assert.equal(await saves(), 0);
  });
  await closeWindow();
  await check('window, recipient only: X closes the window with no question and no draft', async () => {
    assert.equal(await dialog(), null);
    assert.equal(await saves(), 0);
    assert.equal(await count(), 0);
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 1, 'the window did not end');
  });
  await win('new');
  await saveDraftButton();
  await sleep(600);
  await check('window, Save draft with nothing: the toast, nothing written, the window stays', async () => {
    assert.ok((await toasts()).some((x) => /Nothing to save yet/.test(x)), JSON.stringify(await toasts()));
    assert.equal(await saves(), 0);
    assert.equal(await paneUp(), true);
  });
  await win('reply');
  await letTimersRun();
  await closeWindow();
  await check('window, a reply nobody changed: nothing saved, X closes it with no question', async () => {
    assert.equal(await saves(), 0);
    assert.equal(await dialog(), null);
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 1);
  });
  await win('reply');
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('start'); 1`);
  await io.typeText('ok', 10);
  await letTimersRun();
  await check('window, a reply with "ok" typed: the autosave makes a draft', async () => assert.equal(await count(), 1));
  await win('new');
  await attachFile();
  await closeWindow();
  await check('window, a file only: X asks Save / Discard / Cancel', async () => {
    const q = await dialog();
    assert.ok(q && /Save your message\?/.test(q.text), JSON.stringify(q));
    assert.deepEqual(q.buttons, ['Cancel', 'Save', 'Discard']);
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 0);
  });
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-empty-draft: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-empty-draft: ok');
