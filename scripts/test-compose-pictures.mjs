#!/usr/bin/env node
// Several picture files at once, and where a dropped picture goes (v1.0.6 QA round 2, BUG-A1-1 and the dropped PNG).
//
// BUG-A1-1: the Picture button with three files selected inserted only the LAST picture. After one insert the editor holds a NodeSelection on the
// picture, and the next insert replaced it (the same code serves a drop and a paste). Now all pictures of one choice go in with one insert, in order, and
// the caret is behind the last one (src/editor/insertPictures.ts); a picture that is selected when more come in is not replaced either.
// Drop: a PNG dropped from the system onto the compose body became an attachment although Settings > Composing > "Pasted and dropped pictures" is
// "Put in the message" by default. A drop that lands on neither zone (the pane itself) now follows the setting; the zones are the person's explicit choice
// ("Drop to insert in the message", "Drop here to attach"). Other files are attachments in every case.
//
// Real compose pane in the dev preview (src/devMock.ts), real events: the file input of the Picture button, DragEvent drops on the zones and on the pane, a
// ClipboardEvent paste of files in the body. Checked: the pictures in the body and their order, the caret (the next typed letter is behind the last
// picture), the attachment chips, and the draft that Save draft writes (its inline pictures in the same order as the body).
//   node scripts/test-compose-pictures.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-compose-pictures', { vitePort0: 5880, cdpPort0: 9880 });
const { evaluate } = H;
const io = inputs(H, null, 'cp');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

/** Page side: `files(names)` makes a DataTransfer of small PNGs (a different colour each) and `.txt` files for names that end in .txt. */
const LIB = `window.__mk = (names) => { const dt = new DataTransfer(); const cols = ['#c0392b', '#27ae60', '#2980b9', '#8e44ad']; names.forEach((n, i) => {
  if (n.endsWith('.txt')) { dt.items.add(new File(['hello'], n, { type: 'text/plain' })); return; }
  const c = document.createElement('canvas'); c.width = 200; c.height = 100; const g = c.getContext('2d'); g.fillStyle = cols[i % 4]; g.fillRect(0, 0, 200, 100);
  const bin = Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), (x) => x.charCodeAt(0)); dt.items.add(new File([bin], n, { type: 'image/png' })); }); return dt; };
window.__ev = (type, target, dt) => { const e = type === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }) : new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); target.dispatchEvent(e); return e.defaultPrevented; };
1`;
const ED = `document.querySelector('.cp-editor .tiptap').editor`;
const BODY = `(() => { const ed = ${ED}; const imgs = []; ed.state.doc.descendants((n) => { if (n.type.name === 'image') imgs.push(n.attrs['data-name']); }); return { imgs, blocks: ed.getJSON().content.map((n) => n.type + (n.type === 'paragraph' ? ':' + ed.state.doc.textBetween(0, 0) : '')), text: ed.getText() }; })()`;
const CHIPS = `[...document.querySelectorAll('.cp-tail .att-chip .ellipsis')].map((e) => e.textContent)`;
/** the paragraph(s) right behind the last picture, as text: where the caret is */
const AFTER = `(() => { const ed = ${ED}; let last = -1, end = 0; ed.state.doc.descendants((n, pos) => { if (n.type.name === 'image') { last = pos; end = pos + n.nodeSize; } }); if (last < 0) return null; const next = ed.state.doc.resolve(end).nodeAfter; return next ? next.type.name + ':' + next.textContent : 'none'; })()`;

async function fresh(prefs = {}) {
  await H.openApp('lang=en', 1280, 720);
  await evaluate(LIB);
  await evaluate(`window.__store.getState().setPrefs(${JSON.stringify({ inlinePictures: 'inline', ...prefs })}); window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Pictures' }); 1`);
  for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor`)); i++) await sleep(100);
  await sleep(500);
  await evaluate(`${ED}.commands.focus('start'); 1`);
}
const pictureButton = (names) => evaluate(`(() => { const i = document.querySelector('input[type=file][accept*="image"]'); i.files = __mk(${JSON.stringify(names)}).files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
const settle = () => sleep(900);

try {
  // ---------- the Picture button: three files, three pictures, in order, the caret behind the last
  await fresh();
  await pictureButton(['one.png', 'two.png', 'three.png']);
  await settle();
  await check('Picture button, 3 files: all three in the body, in order', async () => assert.deepEqual((await evaluate(BODY)).imgs, ['one.png', 'two.png', 'three.png']));
  await check('Picture button: the caret is behind the last picture (a paragraph follows it)', async () => assert.match(await evaluate(AFTER), /^paragraph:$/));
  await io.typeText('Z', 20);
  await check('Picture button: the next typed letter is behind the last picture, not in or over it', async () => { assert.equal(await evaluate(AFTER), 'paragraph:Z'); assert.equal((await evaluate(BODY)).imgs.length, 3); });
  // the draft Save draft writes carries the pictures in the same order (cid parts of the MIME are made from it in this order)
  await evaluate(`[...document.querySelectorAll('button')].find((b) => /^Save draft$/.test(b.textContent.trim())).click(); 1`);
  await sleep(900);
  await check('Save draft: three inline pictures, in the order of the body', async () => {
    const d = JSON.parse(await evaluate(`JSON.stringify(window.__lastDraft || null)`));
    assert.ok(d, 'no draft was saved');
    assert.deepEqual(d.inline.map((p) => p.filename), ['one.png', 'two.png', 'three.png']);
    const cids = [...d.html.matchAll(/<img[^>]*src="cid:([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(cids, d.inline.map((p) => p.cid), 'the cid order in the HTML is the order of the parts');
  });

  // ---------- a second choice goes after the first; a selected picture is not replaced
  await fresh();
  await pictureButton(['one.png']);
  await settle();
  await evaluate(`(() => { const ed = ${ED}; let at = -1; ed.state.doc.descendants((n, p) => { if (at < 0 && n.type.name === 'image') at = p; }); ed.chain().focus().setNodeSelection(at).run(); return 1; })()`);
  await pictureButton(['two.png', 'three.png']);
  await settle();
  await check('a selected picture stays: two more go after it', async () => assert.deepEqual((await evaluate(BODY)).imgs, ['one.png', 'two.png', 'three.png']));

  // ---------- drop on the zones: the person's choice
  await fresh();
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png', 'three.png', 'notes.txt']); const pane = document.querySelector('.compose-pane'); __ev('dragenter', pane, dt); __ev('dragover', pane, dt); return 1; })()`);
  await sleep(150);
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png', 'three.png', 'notes.txt']); const z = document.querySelector('.dz[data-zone=top]'); __ev('dragover', z, dt); __ev('drop', z, dt); return 1; })()`);
  await settle();
  await check('drop on "Drop to insert": 3 pictures in order, the text file attached', async () => { assert.deepEqual((await evaluate(BODY)).imgs, ['one.png', 'two.png', 'three.png']); assert.deepEqual(await evaluate(CHIPS), ['notes.txt']); });
  await check('drop on "Drop to insert": the caret is behind the last picture', async () => assert.match(await evaluate(AFTER), /^paragraph:/));

  await fresh();
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png']); const pane = document.querySelector('.compose-pane'); __ev('dragover', pane, dt); return 1; })()`);
  await sleep(150);
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png']); const z = document.querySelector('.dz[data-zone=bottom]'); __ev('drop', z, dt); return 1; })()`);
  await settle();
  await check('drop on "Drop here to attach": both attached, none in the body', async () => { assert.deepEqual((await evaluate(BODY)).imgs, []); assert.deepEqual(await evaluate(CHIPS), ['one.png', 'two.png']); });

  // ---------- drop on the pane itself (no zone): the setting decides (QA: a dropped PNG became an attachment although the setting is "Put in the message")
  await fresh();
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png', 'three.png', 'notes.txt']); __ev('drop', document.querySelector('.compose-pane'), dt); return 1; })()`);
  await settle();
  await check('drop on the pane, setting "Put in the message" (default): 3 pictures in the body, the text file attached', async () => { assert.deepEqual((await evaluate(BODY)).imgs, ['one.png', 'two.png', 'three.png']); assert.deepEqual(await evaluate(CHIPS), ['notes.txt']); });

  await fresh({ inlinePictures: 'attach' });
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png', 'notes.txt']); __ev('drop', document.querySelector('.compose-pane'), dt); return 1; })()`);
  await settle();
  await check('drop on the pane, setting "Attach as files": all three attached, none in the body', async () => { assert.deepEqual((await evaluate(BODY)).imgs, []); assert.deepEqual(await evaluate(CHIPS), ['one.png', 'two.png', 'notes.txt']); });

  // the zone is what the person pointed at, whatever the setting says
  await fresh({ inlinePictures: 'attach' });
  await evaluate(`(() => { const dt = __mk(['one.png']); const pane = document.querySelector('.compose-pane'); __ev('dragover', pane, dt); return 1; })()`);
  await sleep(150);
  await evaluate(`(() => { const dt = __mk(['one.png']); __ev('drop', document.querySelector('.dz[data-zone=top]'), dt); return 1; })()`);
  await settle();
  await check('drop on "Drop to insert" with the setting "Attach": the picture goes into the message (explicit zone)', async () => assert.deepEqual((await evaluate(BODY)).imgs, ['one.png']));

  // ---------- paste of several picture files: all in, in order; with the setting "Attach" they are attached
  await fresh();
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png', 'three.png']); __ev('paste', ${ED}.view.dom, dt); return 1; })()`);
  await settle();
  await check('paste of 3 picture files: 3 pictures in order, none attached', async () => { assert.deepEqual((await evaluate(BODY)).imgs, ['one.png', 'two.png', 'three.png']); assert.deepEqual(await evaluate(CHIPS), []); });

  await fresh({ inlinePictures: 'attach' });
  await evaluate(`(() => { const dt = __mk(['one.png', 'two.png']); __ev('paste', ${ED}.view.dom, dt); return 1; })()`);
  await settle();
  await check('paste with the setting "Attach as files": attached, not in the body', async () => { assert.deepEqual((await evaluate(BODY)).imgs, []); assert.deepEqual(await evaluate(CHIPS), ['one.png', 'two.png']); });

  // ---------- a big GIF that is made smaller is a PNG afterwards: the name, the part type and the toast say so (v1.0.6 QA round 3, BUG-R3-3: image/png under e09-anim.gif)
  // (a real 1x1 GIF padded past 1 MB with comment blocks; the page re-encodes it on a canvas, so the bytes are PNG)
  const BIG_GIF = `window.__bigGif = (name) => { const base = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (x) => x.charCodeAt(0)); const body = base.slice(0, base.length - 1);
    const comment = [0x21, 0xfe]; for (let i = 0; i < 4200; i++) { comment.push(255); for (let k = 0; k < 255; k++) comment.push(65); } comment.push(0);
    const out = new Uint8Array(body.length + comment.length + 1); out.set(body, 0); out.set(comment, body.length); out[out.length - 1] = 0x3b; return new File([out], name, { type: 'image/gif' }); }; 1`;
  const bigGifIn = (name) => evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(__bigGif(${JSON.stringify(name)})); const i = document.querySelector('input[type=file][accept*="image"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  const TOASTS = `[...document.querySelectorAll('.toasts .toast')].map((e) => e.innerText.replace(/\\s+/g, ' ')).join(' | ')`;
  const lastDraft = async () => { await evaluate(`[...document.querySelectorAll('button')].find((b) => /^Save draft$/.test(b.textContent.trim())).click(); 1`); await sleep(900); return JSON.parse(await evaluate(`JSON.stringify(window.__lastDraft || null)`)); };
  // automatic: the setting is on
  await fresh({ autoResizePictures: true });
  await evaluate(BIG_GIF);
  await bigGifIn('e09-anim.gif');
  await sleep(1800);
  await check('big GIF, auto-resize on: the picture is named .png in the editor', async () => assert.deepEqual((await evaluate(BODY)).imgs, ['e09-anim.png']));
  await check('big GIF, auto-resize on: the toast names the .png and says the animation is not kept', async () => { const t = await evaluate(TOASTS); assert.match(t, /Converted e09-anim\.png to PNG \(.*\): the animation is not kept/); assert.doesNotMatch(t, /1600|Resized/, 'a 1 px picture was not resized'); assert.doesNotMatch(t, /\.gif/); });
  await check('big GIF, auto-resize on: the draft part is image/png named .png, the HTML refers to it', async () => {
    const d = await lastDraft();
    assert.deepEqual(d.inline.map((p) => [p.mime, p.filename]), [['image/png', 'e09-anim.png']]);
    assert.ok(atob(d.inline[0].dataBase64.slice(0, 12)).startsWith('\u0089PNG'), 'the bytes are a PNG');
  });
  // asked: the Resize button of the prompt
  await fresh();
  await evaluate(BIG_GIF);
  await bigGifIn('e09-anim.gif');
  await sleep(1200);
  await check('big GIF, asked: the prompt comes and the picture is a GIF as it is', async () => { assert.deepEqual((await evaluate(BODY)).imgs, ['e09-anim.gif']); assert.match(await evaluate(TOASTS), /Resize it to 1600 px wide/); });
  await evaluate(`[...document.querySelectorAll('.toasts .toast button')].find((b) => /^Resize$/.test(b.textContent.trim())).click(); 1`);
  await sleep(1800);
  await check('big GIF, Resize clicked: the name becomes .png and the toast says the animation is lost', async () => { assert.deepEqual((await evaluate(BODY)).imgs, ['e09-anim.png']); const t = await evaluate(TOASTS); assert.match(t, /Converted e09-anim\.png to PNG \(.*\): the animation is not kept/); assert.doesNotMatch(t.replace(/Resize it to 1600 px wide/g, ''), /1600|Resized/); });
  await check('big GIF, Resize clicked: the draft part is image/png under the .png name', async () => { const d = await lastDraft(); assert.deepEqual(d.inline.map((p) => [p.mime, p.filename]), [['image/png', 'e09-anim.png']]); });
  // a GIF that is NOT re-encoded stays a GIF (small file: no prompt, nothing converted)
  await fresh();
  await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (x) => x.charCodeAt(0))], 'small.gif', { type: 'image/gif' })); const i = document.querySelector('input[type=file][accept*="image"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await sleep(900);
  await check('a small GIF stays a GIF: name, type, bytes', async () => { assert.deepEqual((await evaluate(BODY)).imgs, ['small.gif']); const d = await lastDraft(); assert.deepEqual(d.inline.map((p) => [p.mime, p.filename]), [['image/gif', 'small.gif']]); });
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-compose-pictures: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-compose-pictures: ok');
