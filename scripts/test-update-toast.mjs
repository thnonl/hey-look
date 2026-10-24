#!/usr/bin/env node
// W6.17b (OBS-R7-4): the toast "Downloading Hey Look! ..." goes when the download leaves `downloading`: a fast download shows the ready text and no "Downloading" toast next to it;
// a slow one still shows it until it is ready; a cancelled one drops it too. The real page with the pretend download of the dev preview (src/devMock.ts: `#update=available&dl=fast|slow`).
//   node scripts/test-update-toast.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-update-toast', { vitePort0: 5140, cdpPort0: 9140 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(50); } return false; };
const toasts = () => evaluate(`JSON.stringify(window.__store.getState().toasts.map((t) => ({ key: t.key ?? null, text: t.textFn ? t.textFn() : t.text })))`).then(JSON.parse);
const downloading = (ts) => ts.filter((t) => /Downloading/i.test(t.text));

try {
  await check('a fast download: the ready text, no "Downloading" toast beside it', async () => {
    await H.openApp('lang=en&update=available&dl=fast', 1280, 800);
    await evaluate('window.__mockUpdates.start(); 1');
    assert.ok(await waitFor(`(async () => (await window.__mockUpdates.flow()) === 'ready' || (await window.__mockUpdates.flow()) === 'waiting')()`, 15000), 'the download did not get ready');
    await sleep(300);
    const ts = await toasts();
    assert.deepEqual(downloading(ts), [], `a "Downloading" toast is still on screen: ${JSON.stringify(ts)}`);
  });

  await check('a slow download: "Downloading" shows until it is over, a cancel takes it away', async () => {
    await H.openApp('lang=en&update=available&dl=slow', 1280, 800);
    await evaluate('window.__mockUpdates.start(); 1');
    assert.ok(await waitFor(`window.__store.getState().toasts.some((t) => t.key === 'update-downloading')`, 8000), 'no "Downloading" toast');
    await sleep(1500);
    assert.equal(downloading(await toasts()).length, 1, 'still there while the download runs');
    await evaluate(`window.__mockUpdates.cancel(); 1`);
    assert.ok(await waitFor(`!window.__store.getState().toasts.some((t) => t.key === 'update-downloading')`, 4000), 'the toast stays after a cancel');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-update-toast: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-update-toast: ok');
