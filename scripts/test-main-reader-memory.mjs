#!/usr/bin/env node
// 1.0.7 fix33 (Mac QA: the main window's page grew by about 5 MB per reader window opened on the SAME 2 MB mail, +100 MB in 20 cycles, no plateau; a short mail +6 MB): what the main page does
// each time a reader window opens, marks the mail read, asks for its neighbours and the list is read again, with the big fixture mails of the Reply timing (2 MB HTML, 1 MB plain text):
//   the open mail is NOT parsed again (DOMParser.parseFromString is called 0 times per cycle once the mail is shown: before, 4 parses of 2 MB per cycle left parsed documents that WebKit collects
//   late), no get_thread result or cleaned copy piles up (JS heap after GC grows by less than 3 MB over 20 cycles after 15 of warm-up, the number is calibrated: the same run before the fix
//   gave the same heap in Chrome, because V8 collects the parsed documents at once; the parse count is the part that does not depend on the engine's collector), the DOM and listener
//   counts do not grow, 50 reads of the 2 MB conversation through the packed command keep no bytes (D-103), and a changed picture state or language still rebuilds the html
//   node scripts/test-main-reader-memory.mjs [--require-browser]
import assert from 'node:assert/strict';
import { languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';

const H = await startHarness('test-main-reader-memory', { vitePort0: 6210 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const metrics = async () => {
  await cdp('HeapProfiler.collectGarbage');
  await cdp('HeapProfiler.collectGarbage');
  const m = Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  return { heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents };
};
// what the main page sees when a reader window opens on the open mail: its read request, its neighbour request, the state event, a sync, and the conversation read again
const cycle = async (id, i) => {
  const env = (kind, payload) => JSON.stringify({ from: `reader-${i + 1}`, id: `r${i}${kind}`, kind, payload });
  await evaluate(`window.__mockEmit('popout-request', ${env('thread-action', { threadId: id, action: 'read', view: 'inbox' })}); window.__mockEmit('popout-request', ${env('neighbors', { threadId: id, view: 'inbox', accountId: '', folder: 'inbox', listAccount: null })});
    window.__mockEmit('thread-state', { threadIds: [${JSON.stringify(id)}] }); window.__mockEmit('mail-synced', {}); window.__store.getState().reloadMessages().then(() => 1); 1`);
  await sleep(350);
};
const open = async (id, shown) => {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(FIXTURES);
  await evaluate(`(async () => { await window.__store.getState().refresh(); await window.__store.getState().select(${JSON.stringify(id)}); return 1; })()`);
  assert.ok(await waitFor(shown), `${id} did not open`);
  await sleep(1500);
  await evaluate(`window.__pc = 0; if (!window.__pcPatched) { window.__pcPatched = true; const o = DOMParser.prototype.parseFromString; DOMParser.prototype.parseFromString = function (...a) { window.__pc++; return o.apply(this, a); }; } 1`);
};

try {
  await cdp('HeapProfiler.enable');
  await cdp('Performance.enable');
  for (const [name, id, shown] of [
    ['the 2 MB HTML mail', IDS.huge, `(document.querySelector('.msg-frame')?.contentDocument?.body?.innerText ?? '').length > 1000`],
    ['the 1 MB plain-text mail', IDS.plain, `(document.querySelector('.msg-frame')?.contentDocument?.body?.innerText ?? '').length > 1000`],
  ]) {
    await check(`${name}: reader cycles do not parse the open mail again and do not grow the page`, async () => {
      await open(id, shown);
      for (let i = 0; i < 15; i++) await cycle(id, i);
      await sleep(500);
      const a = await metrics();
      await evaluate('window.__pc = 0; 1');
      for (let i = 15; i < 35; i++) await cycle(id, i);
      await sleep(500);
      const z = await metrics();
      const parses = await evaluate('window.__pc');
      assert.equal(parses, 0, `${parses} DOMParser parses in 20 cycles (each one is a parsed document of the whole mail)`);
      assert.ok(z.heapMB - a.heapMB < 3, `JS heap grew by ${(z.heapMB - a.heapMB).toFixed(2)} MB in 20 cycles`);
      assert.ok(z.nodes - a.nodes <= 50, `DOM nodes ${a.nodes} -> ${z.nodes}`);
      assert.ok(z.listeners - a.listeners <= 10, `listeners ${a.listeners} -> ${z.listeners}`);
      assert.ok(z.docs - a.docs <= 1, `documents ${a.docs} -> ${z.docs}`);
      // the mail is still shown, once
      assert.equal(await evaluate(`document.querySelectorAll('.msg-frame').length`), 1);
    });
  }
  await check('a change of the language rebuilds the html (the picture placeholders carry text) and a second pass with the same inputs does not', async () => {
    await open(IDS.huge, `(document.querySelector('.msg-frame')?.contentDocument?.body?.innerText ?? '').length > 1000`);
    const before = await evaluate(`document.querySelector('.msg-frame').contentDocument.documentElement.outerHTML.length`);
    await evaluate('window.__pc = 0; 1');
    await evaluate(languageJs('de')); // (waits until the language pack is loaded and applied)
    await sleep(1500);
    const parses = await evaluate('window.__pc');
    assert.ok(parses >= 1, 'the language change did not rebuild the picture placeholders');
    assert.ok(before > 100000);
    await evaluate('window.__pc = 0; 1');
    for (let i = 0; i < 3; i++) await cycle(IDS.huge, i);
    assert.equal(await evaluate('window.__pc'), 0);
  });
  // D-103 (fix39): the conversation arrives as one raw buffer (src/threadPack.ts); the bytes of the answers are not kept: the heap after 60 reads of the 2 MB conversation is where it was after 10 (the Mac QA loop, invoke x80,
  // grew WebContent by 0.8 MB per call while the answer was a JSON string; the page cannot see WebKit Malloc, so this counts what the page itself could keep)
  await check('reads of the 2 MB conversation through the packed command keep no bytes', async () => {
    await evaluate('window.__store.getState().select(null); 1');
    await sleep(500);
    const read = (k) => evaluate(`(async () => { const { api } = await import('/src/api.ts'); let n = 0; for (let i = 0; i < ${k}; i++) n += (await api.getThread(${JSON.stringify(IDS.huge)})).length; return n; })()`);
    await read(10);
    const a = await metrics();
    await read(50);
    const z = await metrics();
    assert.ok(z.heapMB - a.heapMB < 3, `JS heap grew by ${(z.heapMB - a.heapMB).toFixed(2)} MB over 50 reads of a 2 MB conversation`);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-main-reader-memory: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-main-reader-memory: ok');
