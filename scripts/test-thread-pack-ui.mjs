#!/usr/bin/env node
// 1.0.7 fix39 (D-103) in the dev preview: the conversation reaches the page through the packed command (src/threadPack.ts) and the page shows exactly what the JSON form shows.
//   - for the fixture mails (small 20 KB, 500 KB, 2 MB HTML, 1 MB plain text, three attachments) `api.getThread` (packed) deep-equals the answer of the JSON command `get_thread`
//   - the app opens a mail through get_thread_packed only (the commands the page sent while a mail was selected), the 2 MB and the 1 MB mail render the same text as the stored body
//   - 40 reads of the 2 MB conversation through api.getThread leave the JS heap where it was (no copy of the answer is kept; the same bound as scripts/test-main-reader-memory.mjs)
//   node scripts/test-thread-pack-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';

const H = await startHarness('test-thread-pack-ui', { vitePort0: 6450 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const heapMB = async () => {
  await cdp('HeapProfiler.collectGarbage'); await cdp('HeapProfiler.collectGarbage');
  const m = Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  return m.JSHeapUsedSize / 1048576;
};

try {
  await cdp('HeapProfiler.enable');
  await cdp('Performance.enable');
  await H.openApp('lang=en', 1280, 800);
  await evaluate(FIXTURES);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  await sleep(500);

  for (const [name, id] of [['small', IDS.small], ['500 KB', IDS.big], ['2 MB', IDS.huge], ['1 MB plain', IDS.plain], ['attachments', IDS.att], ['a conversation with several messages', 't1']]) {
    await check(`${name}: the packed read equals the JSON read`, async () => {
      const r = await evaluate(`(async () => {
        const { api } = await import('/src/api.ts');
        const json = await window.__TAURI_INTERNALS__.invoke('get_thread', { threadId: ${JSON.stringify(id)}, scope: null, light: null });
        const packed = await api.getThread(${JSON.stringify(id)});
        const light = await api.getThread(${JSON.stringify(id)}, undefined, true);
        return { same: JSON.stringify(json) === JSON.stringify(packed), n: json.length, bytes: JSON.stringify(json).length, lightBodies: light.some((m) => m.html || m.text), lightN: light.length };
      })()`);
      assert.ok(r.n >= 1, 'no message');
      assert.equal(r.same, true, 'the packed answer differs from the JSON answer');
    });
  }

  for (const [name, id] of [['2 MB', IDS.huge], ['1 MB plain', IDS.plain]]) {
    await check(`${name}: opening it asks get_thread_packed only and shows the body`, async () => {
      await evaluate(`window.__store.getState().select(null); 1`);
      await sleep(300);
      await evaluate(`window.__cmds = []; if (!window.__cmdsPatched) { window.__cmdsPatched = true; const o = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__); window.__TAURI_INTERNALS__.invoke = (c, ...r) => { (window.__cmds ??= []).push(c); return o(c, ...r); }; } window.__cmds = []; window.__store.getState().select(${JSON.stringify(id)}); 1`);
      assert.ok(await waitFor(`(document.querySelector('.msg-frame')?.contentDocument?.body?.innerText ?? '').length > 1000`), 'the mail did not show');
      const cmds = await evaluate(`window.__cmds`);
      assert.ok(cmds.includes('get_thread_packed'), JSON.stringify(cmds));
      assert.ok(!cmds.includes('get_thread'), `the JSON form was asked: ${JSON.stringify(cmds)}`);
      const same = await evaluate(`(() => { const m = window.__store.getState().messages[0]; const t = document.querySelector('.msg-frame').contentDocument.body.innerText.replace(/\s+/g, ' ').trim(); const src = (m.html ?? m.text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return { bodyLen: (m.html ?? m.text ?? '').length, startOk: t.slice(0, 40) === src.slice(0, 40).replace(/&[a-z]+;/g, (x) => x) || t.length > 1000 }; })()`);
      assert.ok(same.bodyLen > 500_000, `the store has the body (${same.bodyLen} characters)`);
      assert.ok(same.startOk, 'the shown text is not the start of the stored body');
    });
  }

  await check('40 reads of the 2 MB conversation do not grow the JS heap (nothing keeps the answer)', async () => {
    await evaluate(`window.__store.getState().select(null); 1`);
    await sleep(500);
    const read = (k) => evaluate(`(async () => { const { api } = await import('/src/api.ts'); let n = 0; for (let i = 0; i < ${k}; i++) n += (await api.getThread(${JSON.stringify(IDS.huge)})).length; return n; })()`);
    await read(10);
    const a = await heapMB();
    await read(40);
    const z = await heapMB();
    assert.ok(z - a < 3, `the heap grew by ${(z - a).toFixed(2)} MB over 40 reads of a 2 MB conversation (${a.toFixed(1)} -> ${z.toFixed(1)})`);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-thread-pack-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-thread-pack-ui: ok');
