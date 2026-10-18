#!/usr/bin/env node
// "Discard this message?" for a reply or forward with nothing typed (v1.0.6 final QA, BUG-3; decision: close silently, like an empty new mail,
// plan case I-04). Cause: the Discard button asked when the message was `touched` and had text or recipients, and a reply is both from the start (the
// quote is text, the recipients are filled in). A reply was also `touched` without a key pressed: the guards of the quote and the signature add an
// empty paragraph after the first focus move and the editor reported that as an edit. Now the button uses the same rule as leaving, the autosave and the
// crash snapshot (src/composeContent.ts), and a transaction that changed nothing itself is not an edit.
//
// Real compose pane in the dev preview (src/devMock.ts), in the main window and as the compose window (`?w=compose`), with the quote block a reply
// really has (src/editor/quoteBlock.ts). Per scenario: Discard with nothing typed closes with no dialog and leaves no unsaved flag; one character in the
// body, in the subject, an address added to To, or a file attached asks "Discard this message?" (Cancel keeps it, Discard closes it).
//   node scripts/test-compose-discard.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-compose-discard', { vitePort0: 5860, cdpPort0: 9860 });
const { evaluate, cdp } = H;
const io = inputs(H, null, 'cd');
const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

const KINDS = {
  reply: { kind: 'reply', to: `['Board <board@x.test>', 'ann@x.test']`, subject: 'Re: Confidential board note', isReply: true },
  forward: { kind: 'forward', to: `[]`, subject: 'Fwd: Newsletter HTML', isReply: false },
  neu: { kind: null, to: `[]`, subject: '' },
};
const QUOTE_HTML = '<p>Hello <b>team</b></p><table><tr><td>a cell</td></tr></table><img src="http://127.0.0.1:1/pixel.png" alt="remote">';

async function open(k, mode) {
  const c = KINDS[k];
  if (mode === 'main') {
    await H.openApp('lang=en', 1280, 720);
    await evaluate(`(async () => {
      const body = ${c.kind ? `(await import('/src/editor/quoteBlock.ts')).quoteSentHtml({ kind: ${JSON.stringify(c.kind)}, head: 'On Sun, 18 Oct 2026 01:02, Board wrote:', html: ${JSON.stringify(QUOTE_HTML)} })` : 'undefined'};
      await window.__store.getState().openCompose({ accountId: 'a1', to: ${c.to}, subject: ${JSON.stringify(c.subject)}, bodyHtml: body, isReply: ${c.isReply}, inReplyTo: ${c.isReply ? "'<m1@x>'" : 'undefined'} });
      return 1;
    })()`);
  } else {
    // the compose window: the mock builds a reply (quote, recipient, subject) or a new message
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=${k === 'neu' ? 'new' : 'reply'}#lang=en` });
    await sleep(600);
  }
  for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('.ProseMirror')?.editor`)); i++) await sleep(100);
  await sleep(900);
}
const discardButton = `[...document.querySelectorAll('button')].find((b) => /^Discard$/.test(b.textContent.trim()))`;
const state = () => evaluate(`JSON.stringify({ dirty: window.__store.getState().composeDirty, probe: window.__store.getState().composeProbe?.() ?? null, dialog: [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map((d) => d.innerText.replace(/\\s+/g, ' ').slice(0, 90)), pane: !!document.querySelector('.compose-pane'), win: !!document.querySelector('.ProseMirror') })`).then(JSON.parse);
const pressDiscard = async () => { await evaluate(`${discardButton}.click(); 1`); await sleep(600); };
const answer = async (label) => { await evaluate(`[...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(); 1`); await sleep(500); };

const TYPE = {
  body: async () => { await evaluate(`document.querySelector('.ProseMirror').editor.commands.focus('start'); 1`); await io.typeText('x', 10); },
  subject: async () => { await evaluate(`document.querySelector('input[aria-label="Subject"]').focus(); 1`); await io.typeText('x', 10); },
  recipient: async () => { await evaluate(`document.querySelector('.cf-field.rcpt input').focus(); 1`); await io.typeText('new.person@x.test,', 10); },
  attachment: async () => {
    const f = path.join(os.tmpdir(), 'hl-discard-test.txt');
    fs.writeFileSync(f, 'a file');
    const { root } = await cdp('DOM.getDocument', { depth: 1 });
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await cdp('DOM.setFileInputFiles', { nodeId, files: [f] });
    await sleep(500);
  },
};

try {
  for (const mode of ['main', 'window']) {
    for (const k of ['reply', 'forward', 'neu']) {
      if (mode === 'window' && k === 'forward') continue; // (the compose window's mock has a reply and a new message)
      const tag = `${mode} ${k}`;
      await open(k, mode);
      let s = await state();
      check(`${tag}: nothing typed, nothing dirty`, () => { assert.equal(s.probe?.hasContent, false); if (mode === 'main') assert.equal(s.dirty, false); });
      await pressDiscard();
      s = await state();
      check(`${tag}: Discard with nothing typed closes without a question`, () => { assert.deepEqual(s.dialog, []); if (mode === 'main') assert.equal(s.pane, false, 'the compose pane is still open'); });
      if (mode === 'window') continue; // (the window closes itself; the typed cases below are the same component)
      for (const what of ['body', 'subject', 'recipient', 'attachment']) {
        await open(k, mode);
        await TYPE[what]();
        await sleep(300);
        s = await state();
        check(`${tag} + ${what}: counts as written`, () => assert.equal(s.probe?.hasContent, true));
        await pressDiscard();
        s = await state();
        check(`${tag} + ${what}: Discard asks`, () => { assert.equal(s.dialog.length, 1); assert.match(s.dialog[0], /Discard this message\?/); });
        await answer('Cancel');
        s = await state();
        check(`${tag} + ${what}: Cancel keeps the message`, () => { assert.deepEqual(s.dialog, []); assert.equal(s.pane, true); });
        await pressDiscard();
        await answer('Discard');
        s = await state();
        check(`${tag} + ${what}: Discard closes it`, () => { assert.deepEqual(s.dialog, []); assert.equal(s.pane, false); });
      }
    }
  }
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-compose-discard: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-compose-discard: ok');
