#!/usr/bin/env node
// Paste options (Keep source / Merge / Keep text only): the format the caret is left in. QA Mac: after pasting bold text with Keep source and choosing
// Keep text only, the characters typed next were still bold. Cause: the switch asked the DOCUMENT FOR THE FORMAT AT THE CARET AFTER the paste was in it, so
// at the start of a paragraph "the text around the caret" was the pasted bold text itself (the pasted text stayed bold too); and the caret kept whatever
// the last pasted text carried. Now the format is read once, before the paste (caretMarks), stored with the paste, and Merge / Keep text only leave the caret
// in it (stored marks); Keep source leaves no stored marks.
//
// Real editor, real plugin, real DOM paste events, in the dev preview (src/devMock.ts). Asserts on the document, the marks at the caret, the stored marks,
// the toolbar state (editor.isActive) and what typing next produces.
//   node scripts/test-paste-switch.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-paste-switch', { vitePort0: 5830, cdpPort0: 9830 });
const { evaluate } = H;
const io = inputs(H, null, 'ps');
const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

const ED = `document.querySelector('.ProseMirror').editor`;
const paste = (html, text) => evaluate(`(() => { const e = document.querySelector('.ProseMirror'); e.focus(); const dt = new DataTransfer(); dt.setData('text/html', ${JSON.stringify(html)}); dt.setData('text/plain', ${JSON.stringify(text)}); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
const state = async () => JSON.parse(await evaluate(`(() => { const ed = ${ED}, s = ed.state; return JSON.stringify({ html: ed.getHTML().replace(/<div data-sig-block[^>]*><\\/div>/g, '').replace(/<p><\\/p>/g, ''), stored: s.storedMarks && s.storedMarks.map((m) => m.type.name), at: s.selection.$from.marks().map((m) => m.type.name), bold: ed.isActive('bold'), color: ed.getAttributes('textStyle').color || null, caret: s.selection.empty }); })()`));
const choose = async (label) => {
  await evaluate(`document.querySelector('.paste-opt').click(); 1`);
  await sleep(150);
  await evaluate(`[...document.querySelectorAll('[role=menuitemradio], [role=menuitem]')].find((e) => ${JSON.stringify(label)} === e.textContent.trim()).click(); 1`);
  await sleep(150);
};
const open = async (bodyHtml, prefs = {}) => {
  await H.openApp('lang=en', 1280, 720);
  await evaluate(`window.__store.getState().setPrefs(${JSON.stringify(prefs)}); window.__store.getState().openCompose({ to: [], subject: 's', bodyHtml: ${JSON.stringify(bodyHtml)} }); 1`);
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('.ProseMirror')?.editor`)); i++) await sleep(100);
  await sleep(300);
  await evaluate(`${ED}.commands.focus('end'); 1`);
};
const type = async (s) => { await io.typeText(s, 10); await sleep(100); };
const RICH = '<p><b>Bold</b> <span style="color:#ff0000">red</span></p>';
const TEXT = 'Bold red';
const no = (html, tag) => assert.ok(!new RegExp(`<${tag}[ >]`).test(html), `${tag} in ${html}`);

try {
  // A: the body is empty (the paste starts a paragraph): Keep source, then Keep text only, back to Keep source, then Merge
  await open('');
  await paste('<p><b>Bold text</b></p>', 'Bold text');
  await sleep(250);
  let s = await state();
  check('A1 source is bold', () => { assert.match(s.html, /<strong>Bold text<\/strong>/); assert.equal(s.stored, null); assert.equal(s.bold, true); });
  await choose('Keep text only');
  s = await state();
  check('A2 text only: plain text', () => { assert.equal(s.html, '<p>Bold text</p>'); no(s.html, 'strong'); });
  check('A2 text only: the caret is plain (toolbar B off, no bold stored or at the caret)', () => { assert.equal(s.bold, false); assert.deepEqual(s.stored, []); assert.deepEqual(s.at, []); });
  await type('abc');
  s = await state();
  check('A3 typing after text only is not bold', () => { assert.equal(s.html, '<p>Bold textabc</p>'); assert.equal(s.bold, false); });
  // typing removed the button: paste again, flip several times
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await paste('<p><b>Bold text</b></p>', 'Bold text');
  await sleep(250);
  await choose('Keep text only');
  await choose('Keep source formatting');
  s = await state();
  check('A4 back to Keep source: bold again and NO stored marks left over', () => { assert.match(s.html, /<strong>Bold text<\/strong>/); assert.equal(s.stored, null); assert.equal(s.bold, true); });
  await choose('Merge formatting');
  s = await state();
  check('A5 Merge: the bold of the source is kept, the caret is plain', () => { assert.match(s.html, /<strong>Bold text<\/strong>/); assert.equal(s.bold, false); assert.deepEqual(s.stored, []); });
  await choose('Keep text only');
  await choose('Keep text only'); // (choosing the same again is harmless)
  s = await state();
  check('A6 after several switches: plain', () => { assert.equal(s.html, '<p>Bold text</p>'); assert.equal(s.bold, false); });

  // B: in the middle of a plain paragraph
  await open('<p>Hello </p>');
  await paste('<p><b>Bold text</b></p>', 'Bold text');
  await sleep(250);
  await choose('Keep text only');
  await type('!');
  s = await state();
  check('B text only after "Hello ": all plain, typing too', () => { assert.equal(s.html, '<p>HelloBold text!</p>'); assert.equal(s.bold, false); });

  // C: the paste default is Keep text only / Merge: the caret is plain right after the first paste, with no menu used
  for (const mode of ['text', 'merge']) {
    await open('', { pasteDefault: mode });
    await paste(RICH, TEXT);
    await sleep(250);
    s = await state();
    check(`C ${mode}: the caret is plain after the paste`, () => { assert.equal(s.bold, false); assert.equal(s.color, null); assert.deepEqual(s.stored, []); });
    await type('x');
    s = await state();
    check(`C ${mode}: typing after the paste is plain`, () => { assert.ok(s.html.endsWith('x</p>') && !/<(strong|span)[^>]*>[^<]*x<\/(strong|span)>/.test(s.html), s.html); assert.equal(s.bold, false); });
    if (mode === 'text') check('C text: no bold in the text', () => no(s.html, 'strong'));
    else check('C merge: the bold word stays, the red colour is gone', () => { assert.match(s.html, /<strong>Bold<\/strong>/); assert.ok(!/ff0000|rgb\(255, 0, 0\)/i.test(s.html), s.html); });
  }

  // D: the format BEFORE the paste is what the text takes and what the caret keeps: bold switched on, then a red text pasted as Keep text only
  await open('');
  await evaluate(`${ED}.commands.setBold(); 1`);
  await paste(RICH, TEXT);
  await sleep(250);
  await choose('Keep text only');
  s = await state();
  check('D text only takes the bold that was switched on, as typing would', () => { assert.equal(s.html, '<p><strong>Bold red</strong></p>'); assert.equal(s.bold, true); });
  await choose('Keep source formatting');
  s = await state();
  check('D source: the text keeps its own format', () => { assert.match(s.html, /<strong>Bold<\/strong>/); assert.match(s.html, /ff0000|rgb\(255, 0, 0\)/i); assert.equal(s.stored, null); });
  await choose('Keep text only');
  s = await state();
  check('D text only again: the format before the paste (bold) comes back', () => { assert.equal(s.html, '<p><strong>Bold red</strong></p>'); assert.equal(s.bold, true); });
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-paste-switch: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-paste-switch: ok');
