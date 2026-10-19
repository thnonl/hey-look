#!/usr/bin/env node
// Merge cells and Split cell in the real editor (1.0.7 W2.19), real Compose in the dev preview (src/devMock.ts) with real mouse and key events:
//   - a mouse drag across two cells makes a cell selection (the selected cells are tinted, light and dark), Merge cells (the table tools bar and the Table button's menu) makes one
//     cell that spans two columns with both texts; Shift+Arrow from a cell's edge selects the next cell the same way;
//   - Merge is off with one cell, Split is off on a normal cell, Split cell on the merged one gives single cells again, Ctrl+Z undoes each in one step;
//   - the draft round trip (document -> HTML -> document) keeps colspan and rowspan.
//   node scripts/test-table-merge.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-table-merge', { vitePort0: 5420 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const check = async (name, fn) => { checks++; try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const key = async (k, code, vk, modifiers = 0) => {
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(120);
};
const ED = `document.querySelector('.cp-editor .tiptap').editor`;
const rows = () => json(`(() => ${ED}.state.doc.firstChild.type.name === 'table' || 1 ? (() => { let t = null; ${ED}.state.doc.descendants((n) => { if (!t && n.type.name === 'table') t = n; }); return t.content.content.map((r) => r.content.content.map((c) => ({ t: c.textContent, cs: c.attrs.colspan, rs: c.attrs.rowspan }))); })() : 0)()`);
const cellRect = (text) => json(`(() => { const td = [...document.querySelectorAll('.cp-editor .tiptap td, .cp-editor .tiptap th')].find((c) => c.textContent.trim().startsWith(${JSON.stringify(text)})); const r = td.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const mouse = (type, x, y, extra = {}) => H.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const drag = async (from, to) => {
  const a = await cellRect(from), b = await cellRect(to);
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6);
  await mouse('mouseReleased', b.x, b.y);
  await sleep(250);
};
const selKind = () => json(`(() => { const s = ${ED}.state.selection; return { kind: s.constructor.name, cells: document.querySelectorAll('.cp-editor .selectedCell').length }; })()`);
const barButton = (label) => json(`(() => { const b = [...document.querySelectorAll('.tbl-tools button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); return b ? { disabled: b.disabled } : null; })()`);
const clickBar = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.tbl-tools button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); b.click(); return 1; })()`);

const TABLE = (() => {
  const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const c = (t) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [P(t)] });
  return { type: 'table', attrs: { borders: 'all' }, content: ['A', 'B', 'C'].map((_, i) => ({ type: 'tableRow', content: ['A', 'B', 'C'].map((l, j) => c(`${['A', 'B', 'C'][j]}${i + 1}`)) })) };
})();

async function run(theme) {
  await H.openApp(`lang=en&theme=${theme}`, 1280, 800);
  await evaluate(`window.__store.getState().setPrefs({ theme: '${theme}' }); window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Tables', bodyHtml: '<p>x</p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  await evaluate(`(() => { const e = ${ED}; e.commands.focus('end'); e.commands.insertContent(${JSON.stringify(TABLE)}); return 1; })()`);
  await sleep(500);
  const t = `[${theme}] `;
  // a caret in a cell: the tools bar is there, Merge and Split are off
  await evaluate(`(() => { const e = ${ED}; let at = -1; e.state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text === 'A1') at = p + 1; }); e.commands.focus(); e.commands.setTextSelection(at); return at; })()`);
  await sleep(400);
  await check(t + 'one cell: Merge cells and Split cell are off', async () => { assert.deepEqual(await barButton('Merge cells'), { disabled: true }); assert.deepEqual(await barButton('Split cell'), { disabled: true }); });
  // a mouse drag across A1:B1
  await drag('A1', 'B1');
  await check(t + 'a drag across two cells is a cell selection, both cells are tinted', async () => {
    const s = await selKind();
    assert.equal(s.kind, 'CellSelection'); assert.equal(s.cells, 2);
    const tint = await evaluate(`(() => { const c = document.querySelector('.cp-editor .selectedCell'); const bg = getComputedStyle(c, '::after').backgroundColor; return bg; })()`);
    assert.ok(tint && tint !== 'rgba(0, 0, 0, 0)' && tint !== 'transparent', `the selection colour is ${tint}`);
  });
  await check(t + 'Merge cells is on with two cells, Split cell is off', async () => { assert.deepEqual(await barButton('Merge cells'), { disabled: false }); assert.deepEqual(await barButton('Split cell'), { disabled: true }); });
  await clickBar('Merge cells');
  await sleep(300);
  await check(t + 'Merge cells: one cell of two columns holds both texts', async () => { const r = await rows(); assert.deepEqual(r[0].map((c) => [c.t, c.cs, c.rs]), [['A1B1', 2, 1], ['C1', 1, 1]]); assert.equal(r[1].length, 3); });
  await key('z', 'KeyZ', 90, 2);
  await check(t + 'Ctrl+Z restores the cells in one step', async () => { const r = await rows(); assert.deepEqual(r[0].map((c) => c.t), ['A1', 'B1', 'C1']); assert.ok(r.flat().every((c) => c.cs === 1 && c.rs === 1)); });
  // Shift+Arrow from the edge of a cell: A2 -> B2, merged from the Table button's menu
  await evaluate(`(() => { const e = ${ED}; let at = -1; e.state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text === 'A2') at = p + 2; }); e.commands.focus(); e.commands.setTextSelection(at); return at; })()`);
  await sleep(200);
  await key('ArrowRight', 'ArrowRight', 39, 8);
  await check(t + 'Shift+Right from the end of a cell selects the next cell', async () => { const s = await selKind(); assert.equal(s.kind, 'CellSelection', JSON.stringify(s)); assert.ok(s.cells >= 2, JSON.stringify(s)); });
  // (the Table button is in the More menu at this width: More > Table opens the table menu)
  await evaluate(`document.querySelector('.fmt-tb [aria-label="Table"]')?.click() ?? document.querySelector('.fmt-tb .fmt-more').click(); 1`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('.dd-fixed [role^=menuitem]')].find((x) => x.textContent.trim().startsWith('Table'))?.click(); 1`);
  await sleep(300);
  await check(t + 'the Table button menu has Merge cells (on) and Split cell (off)', async () => {
    const r = await json(`(() => [...document.querySelectorAll('.dd-fixed [role^=menuitem]')].map((x) => [x.textContent.trim(), x.disabled]))()`);
    assert.deepEqual(r.find((x) => x[0] === 'Merge cells'), ['Merge cells', false], JSON.stringify(r));
    assert.deepEqual(r.find((x) => x[0] === 'Split cell'), ['Split cell', true]);
  });
  await evaluate(`[...document.querySelectorAll('.dd-fixed [role^=menuitem]')].find((x) => x.textContent.trim() === 'Merge cells').click(); 1`);
  await sleep(300);
  await check(t + 'Merge cells from the menu merged A2 and B2', async () => { const r = await rows(); assert.deepEqual(r[1].map((c) => [c.t, c.cs]), [['A2B2', 2], ['C2', 1]]); });
  // Split cell: the caret in the merged cell
  await evaluate(`(() => { const e = ${ED}; let at = -1; e.state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text === 'A2') at = p + 1; }); e.commands.focus(); e.commands.setTextSelection(at); return at; })()`);
  await sleep(300);
  await check(t + 'in the merged cell Split cell is on and Merge cells is off', async () => { assert.deepEqual(await barButton('Split cell'), { disabled: false }); assert.deepEqual(await barButton('Merge cells'), { disabled: true }); });
  // the draft round trip keeps the spans (document -> email HTML -> document)
  const rt = JSON.parse(await evaluate(`(async () => { const { docToHtml } = await import('/src/editor/emailHtml.ts'); const e = ${ED}; const html = docToHtml(e.getJSON()); const ok = html.includes('colspan="2"'); e.commands.setContent(html); let t = null; e.state.doc.descendants((n) => { if (!t && n.type.name === 'table') t = n; }); return JSON.stringify({ ok, row: t.content.content[1].content.content.map((c) => [c.textContent, c.attrs.colspan]) }); })()`));
  await check(t + 'the sent HTML has colspan and the reopened document keeps it', async () => { assert.equal(rt.ok, true); assert.deepEqual(rt.row, [['A2B2', 2], ['C2', 1]]); });
  await evaluate(`(() => { const e = ${ED}; let at = -1; e.state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text === 'A2') at = p + 1; }); e.commands.focus(); e.commands.setTextSelection(at); return at; })()`);
  await sleep(400);
  await clickBar('Split cell');
  await sleep(300);
  await check(t + 'Split cell: two cells again, the text in the left one', async () => { const r = await rows(); assert.deepEqual(r[1].map((c) => [c.t, c.cs]), [['A2B2', 1], ['', 1], ['C2', 1]]); });
  await key('z', 'KeyZ', 90, 2);
  await check(t + 'Ctrl+Z puts the merged cell back', async () => { const r = await rows(); assert.deepEqual(r[1].map((c) => [c.t, c.cs]), [['A2B2', 2], ['C2', 1]]); });
}

try {
  for (const theme of ['light', 'dark']) await run(theme);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-table-merge: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-table-merge: ${checks} checks passed`);
