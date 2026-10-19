#!/usr/bin/env node
// The table tools bar never covers the table (Mac QA 1.0.7 D-027, P3): with the table as the first thing in the message body there was no room above it inside the editor pane, the bar was
// clamped to the pane's top edge and sat on the first row. Now it goes above the table when there is room, else below it, else (a table as tall as the pane) above the pane's top edge.
// Real Compose in the dev preview with a real mouse click in a cell, at 960 x 560 and 1280 x 800: the bar's box and the table's box do not intersect, the bar is inside the window.
//   node scripts/test-table-tools-pos.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-table-tools-pos', { vitePort0: 5960 });
const { evaluate } = H;
const io = inputs(H, null, 'tt');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const ED = `document.querySelector('.cp-editor .tiptap').editor`;

const P = (t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] });
const cell = (t) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [P(t)] });
const table = (rows) => ({ type: 'table', attrs: { borders: 'all' }, content: Array.from({ length: rows }, (_, i) => ({ type: 'tableRow', content: ['A', 'B', 'C'].map((l) => cell(`${l}${i + 1}`)) })) });

async function open(w, h, doc) {
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Tables', bodyHtml: '' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
  await sleep(900);
  await evaluate(`(() => { const e = ${ED}; e.commands.setContent(${JSON.stringify({ type: 'doc', content: doc })}); return 1; })()`);
  await sleep(500);
}
/** A real click in a cell of the table (the one with this text), then the geometry of the bar and of the table. */
async function barAndTable(cellText) {
  const p = await json(`(() => { const td = [...document.querySelectorAll('.cp-editor .tiptap td')].find((c) => c.textContent.trim() === ${JSON.stringify(cellText)}); td.scrollIntoView({ block: 'nearest' }); const r = td.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await io.clickAt(p.x, p.y);
  assert.ok(await waitFor(`!!document.querySelector('.tbl-tools') && getComputedStyle(document.querySelector('.tbl-tools')).visibility !== 'hidden'`, 5000), 'the bar did not show');
  await sleep(400);
  return json(`(() => { const b = document.querySelector('.tbl-tools').getBoundingClientRect(), t = document.querySelector('.cp-editor .tiptap table').getBoundingClientRect(), pane = document.querySelector('.cp-editor').getBoundingClientRect(); const r = (x) => ({ top: Math.round(x.top * 10) / 10, bottom: Math.round(x.bottom * 10) / 10, left: Math.round(x.left), right: Math.round(x.right) }); return { bar: r(b), table: r(t), pane: r(pane), win: innerHeight, winW: innerWidth }; })()`);
}
const clear = (g) => g.bar.bottom <= g.table.top + 0.5 || g.bar.top >= g.table.bottom - 0.5;

try {
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    const at = `${w}x${h}`;
    await open(w, h, [table(3), P('after')]);
    await check(`${at}: a table first in the body: the bar is below it, not on row 1`, async () => {
      const g = await barAndTable('B1');
      assert.ok(clear(g), JSON.stringify(g));
      assert.ok(g.bar.top >= g.table.bottom - 0.5, `below expected: ${JSON.stringify(g)}`);
      assert.ok(g.bar.top >= 0 && g.bar.bottom <= g.win && g.bar.left >= 0 && g.bar.right <= g.winW, JSON.stringify(g));
    });
    await open(w, h, [P('Intro'), P('More'), P('Even more'), table(3), P('after')]);
    await check(`${at}: a table with text above it: the bar is above it (as before)`, async () => {
      const g = await barAndTable('B2');
      assert.ok(clear(g) && g.bar.bottom <= g.table.top + 0.5, JSON.stringify(g));
    });
    await open(w, h, [table(30), P('after')]);
    await check(`${at}: a table as tall as the pane, first in the body: the bar does not cover it`, async () => {
      const g = await barAndTable('B1');
      assert.ok(clear(g), JSON.stringify(g));
      assert.ok(g.bar.top >= 0, JSON.stringify(g));
    });
    await check(`${at}: the table scrolls: the bar follows and never covers it`, async () => {
      await evaluate(`document.querySelector('.cp-editor').scrollTop = 60; 1`);
      await sleep(500);
      const g = await json(`(() => { const bar = document.querySelector('.tbl-tools'); if (!bar || getComputedStyle(bar).visibility === 'hidden') return null; const b = bar.getBoundingClientRect(), t = document.querySelector('.cp-editor .tiptap table').getBoundingClientRect(); return { bar: { top: b.top, bottom: b.bottom }, table: { top: t.top, bottom: t.bottom } }; })()`);
      assert.ok(g === null || clear(g), JSON.stringify(g));
    });
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-table-tools-pos: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-table-tools-pos: ok');
