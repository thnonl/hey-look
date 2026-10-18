#!/usr/bin/env node
// A recipient chip can be dragged with the mouse from To to Cc to Bcc and back (1.0.7 W2.21, REQ-2.21.4 / 2.21.5). Real compose pane in the dev preview, and a real
// browser drag: the mouse is pressed on the chip and moved (the page gets its own `dragstart`), the drag is taken over with `Input.setInterceptDrags` and
// delivered with `Input.dispatchDragEvent` (enter, over, drop) at the place the mouse is released.
//   - To -> Cc: the chip is in Cc only, at the end; Cc -> Bcc; Bcc -> To; the chip text is the same;
//   - onto the same field: nothing changes; onto the Subject, the body or nowhere: nothing changes and no text is inserted anywhere;
//   - an address that is in the target already (another spelling): one chip in the target, none in the source;
//   - the drop target shows an outline while the chip is over it; the change counts as an edit (the saved draft has the new fields);
//   - the chip carries no text flavour (dropped in another program it does nothing).
//   node scripts/test-chip-drag.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-chip-drag', { vitePort0: 5660 });
const { evaluate, cdp, on } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };

/** the chips of each field as the person reads them: { to: [...], cc: [...], bcc: [...] } */
const fields = () => evaluate(`(() => { const f = [...document.querySelectorAll('.compose-pane .cf-field.rcpt')]; const out = {}; ['to', 'cc', 'bcc'].forEach((k, i) => { out[k] = f[i] ? [...f[i].querySelectorAll('.rchip .ellipsis')].map((x) => x.textContent.trim()) : null; }); return out; })()`);
const centreOf = (js) => evaluate(`(() => { const e = ${js}; if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const chipAt = (field, text) => centreOf(`[...document.querySelectorAll('.compose-pane .cf-field.rcpt')][${['to', 'cc', 'bcc'].indexOf(field)}]?.querySelectorAll('.rchip .ellipsis') && [...[...document.querySelectorAll('.compose-pane .cf-field.rcpt')][${['to', 'cc', 'bcc'].indexOf(field)}].querySelectorAll('.rchip')].find((c) => c.querySelector('.ellipsis').textContent.trim() === ${JSON.stringify(text)})`);
const fieldBox = (field) => centreOf(`document.querySelectorAll('.compose-pane .cf-field.rcpt')[${['to', 'cc', 'bcc'].indexOf(field)}]`);
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });

await cdp('Input.setInterceptDrags', { enabled: true });
let lastDrag = null;
on('Input.dragIntercepted', (p) => { lastDrag = p.data; });

/**
 * Drag with the mouse from (x0, y0) to (x1, y1) and drop there. Returns what the page offered to drag. `over` runs while the chip is over the target
 * (before the drop), with the offer.
 */
async function drag([x0, y0], [x1, y1], over) {
  lastDrag = null;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await mouse('mousePressed', x0, y0);
  // a few moves: the browser starts the drag after the pointer has moved a few pixels
  for (let i = 1; i <= 4 && !lastDrag; i++) { await mouse('mouseMoved', x0 + i * 4, y0 + i * 2); await sleep(60); }
  for (let t0 = Date.now(); !lastDrag && Date.now() - t0 < 3000;) await sleep(50);
  const offer = lastDrag;
  assert.ok(offer, 'the browser did not start a drag (is the chip draggable?)');
  await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: x1, y: y1, data: offer });
  await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: x1, y: y1, data: offer });
  await sleep(100);
  if (over) await over(offer);
  await cdp('Input.dispatchDragEvent', { type: 'drop', x: x1, y: y1, data: offer });
  await mouse('mouseReleased', x1, y1);
  await sleep(250);
  return offer;
}

async function fresh(init) {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`window.__store.getState().openCompose(${JSON.stringify(init)}); 1`);
  assert.ok(await waitFor(`document.querySelectorAll('.compose-pane .cf-field.rcpt').length === 3`, 15000), 'compose did not start with To, Cc and Bcc');
  await sleep(600);
}

try {
  await fresh({ accountId: 'a1', to: ['alice@fabrikam.com', 'Bob Lee <bob@fabrikam.com>'], cc: ['carol@fabrikam.com'], bcc: [], subject: 'Chips' });

  await check('the chips are draggable', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('.compose-pane .rchip[draggable="true"]').length`), 3);
  });

  await check('To -> Cc: the chip leaves To and is the last one in Cc', async () => {
    let outline = null;
    const offer = await drag(await chipAt('to', 'alice@fabrikam.com'), await fieldBox('cc'), async () => {
      outline = await evaluate(`getComputedStyle(document.querySelectorAll('.compose-pane .cf-field.rcpt')[1]).outlineStyle + ' ' + document.querySelectorAll('.compose-pane .cf-field.rcpt')[1].className`);
    });
    assert.match(outline, /solid.*drop-target/, `the target has an outline while the chip is over it: ${outline}`);
    const f = await fields();
    assert.deepEqual(f, { to: ['Bob Lee <bob@fabrikam.com>'], cc: ['carol@fabrikam.com', 'alice@fabrikam.com'], bcc: [] });
    assert.equal(await evaluate(`document.querySelector('.compose-pane .cf-field.rcpt.drop-target')`), null, 'the outline is gone after the drop');
    // the chip carries no text: dropped in another program (or on the message text) it does nothing
    assert.deepEqual(offer.items.map((i) => i.mimeType), ['application/x-heylook-recipient']);
  });

  await check('the change is an edit: the saved draft has the new fields', async () => {
    await evaluate(`window.__store.getState().composeSaver({ quiet: true }); 1`);
    await sleep(700);
    const d = JSON.parse(await evaluate(`JSON.stringify(window.__lastDraft ?? null)`));
    assert.ok(d, 'no draft was saved');
    assert.deepEqual([d.to, d.cc, d.bcc], [['Bob Lee <bob@fabrikam.com>'], ['carol@fabrikam.com', 'alice@fabrikam.com'], []]);
  });

  await check('Cc -> Bcc', async () => {
    await drag(await chipAt('cc', 'carol@fabrikam.com'), await fieldBox('bcc'));
    assert.deepEqual(await fields(), { to: ['Bob Lee <bob@fabrikam.com>'], cc: ['alice@fabrikam.com'], bcc: ['carol@fabrikam.com'] });
  });

  await check('Bcc -> To: a chip with a name keeps it', async () => {
    await drag(await chipAt('bcc', 'carol@fabrikam.com'), await fieldBox('to'));
    assert.deepEqual(await fields(), { to: ['Bob Lee <bob@fabrikam.com>', 'carol@fabrikam.com'], cc: ['alice@fabrikam.com'], bcc: [] });
    await drag(await chipAt('to', 'Bob Lee <bob@fabrikam.com>'), await fieldBox('cc'));
    assert.deepEqual(await fields(), { to: ['carol@fabrikam.com'], cc: ['alice@fabrikam.com', 'Bob Lee <bob@fabrikam.com>'], bcc: [] });
  });

  await check('onto the same field: nothing changes, no outline', async () => {
    const before = await fields();
    let outline = null;
    await drag(await chipAt('cc', 'alice@fabrikam.com'), await fieldBox('cc'), async () => {
      outline = await evaluate(`!!document.querySelector('.compose-pane .cf-field.rcpt.drop-target')`);
    });
    assert.deepEqual(await fields(), before);
    assert.equal(outline, false, 'the field the chip comes from is not a target');
  });

  await check('onto the Subject, the body or the empty header: nothing changes and no text is inserted', async () => {
    const before = await fields();
    const body = await evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`);
    const subj = await evaluate(`document.querySelector('.compose-pane .cf-subject input').value`);
    await drag(await chipAt('cc', 'alice@fabrikam.com'), await centreOf(`document.querySelector('.compose-pane .cf-subject input')`));
    await drag(await chipAt('cc', 'alice@fabrikam.com'), await centreOf(`document.querySelector('.cp-editor .tiptap')`));
    await drag(await chipAt('cc', 'alice@fabrikam.com'), [4, 4]);
    assert.deepEqual(await fields(), before);
    assert.equal(await evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`), body);
    assert.equal(await evaluate(`document.querySelector('.compose-pane .cf-subject input').value`), subj);
  });

  // an address that is in the target already (another spelling): one chip in the target, none in the source
  await fresh({ accountId: 'a1', to: ['dave@fabrikam.com'], cc: ['Dave@Fabrikam.com'], bcc: [], subject: 'Dup' });
  await check('a duplicate in the target is not added again; the chip just leaves the source', async () => {
    await drag(await chipAt('to', 'dave@fabrikam.com'), await fieldBox('cc'));
    assert.deepEqual(await fields(), { to: [], cc: ['Dave@Fabrikam.com'], bcc: [] });
  });
} finally {
  try { await cdp('Input.setInterceptDrags', { enabled: false }); } catch { /* the page is gone */ }
  await H.shutdown();
}

if (failures.length) { console.error(`test-chip-drag: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-chip-drag: ok');
