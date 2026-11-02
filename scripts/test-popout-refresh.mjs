#!/usr/bin/env node
// 1.0.12 (Windows QA round 9): the body of an open reader window never goes blank while the conversation is read again (a sync, a change of its state: `mail-synced`, `thread-state`),
// even when the backend read takes seconds; and Next / Previous still never shows the body of the conversation before (BUG-3). The dev preview: `?w=reader`, a slow read
// (`window.__mockDelays.thread`), the body sampled every 50 ms.
//   node scripts/test-popout-refresh.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-refresh', { vitePort0: 5350, cdpPort0: 9350 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(js); } catch { /* reloading */ } if (v) return true; await sleep(60); } return false; };
const assert = (c, m) => { if (!c) throw new Error(m); };
// the body: a frame with text in it, shown (not hidden), with no cover over it
const BODY = `(() => { const f = document.querySelector('iframe.msg-frame'); const d = f && f.contentDocument; return { frame: !!f, vis: f ? f.style.visibility !== 'hidden' : false, text: d && d.body ? d.body.innerText.trim().length : 0, sig: d && d.body ? d.body.innerText.trim().slice(0, 60) : '', cover: !!document.querySelector('.rp-opening'), subject: (document.querySelector('.rp-head h1') || {}).textContent || null }; })()`;
const sampleFor = async (ms) => { const out = []; const t0 = Date.now(); while (Date.now() - t0 < ms) { try { out.push(await evaluate(BODY)); } catch { /* a frame being written */ } await sleep(50); } return out; };

try {
  await H.openApp('lang=en', 1100, 720);
  const id = JSON.parse(await evaluate(`(async () => { const l = await window.__TAURI_INTERNALS__.invoke('list_threads', { filter: { accountId: null, folder: 'inbox', search: '', focus: null, flat: false, unreadOnly: false, flaggedOnly: false, sortAsc: false, scope: 'current' } }); return JSON.stringify(l.filter((x) => !/invitation|cancel|confidential|sender check|unverified/i.test(x.subject)).slice(0, 3).map((t) => t.threadId)); })()`));
  assert(id.length === 3, 'three readable conversations');
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=reader&thread=${id[1]}#lang=en` });
  assert(await waitFor(`!!document.querySelector('.reader-bar .rb.nav')`, 20000), 'the reader window did not start');
  assert(await waitFor(`(() => { const f = document.querySelector('iframe.msg-frame'); return !!f && !!f.contentDocument && f.contentDocument.body.innerText.trim().length > 10 && !document.querySelector('.rp-opening'); })()`, 10000), 'the body is shown');
  await sleep(800);

  for (const [ev, payload] of [['mail-synced', 'null'], ['thread-state', `{ threadIds: ['${id[1]}'] }`], ['calendar-changed', 'null']]) {
    await check(`${ev} with a slow read: the body never goes blank`, async () => {
      await evaluate(`window.__mockDelays = { thread: 1500 }; 1`);
      await evaluate(`window.__mockEmit(${JSON.stringify(ev)}, ${payload}); 1`);
      const s = await sampleFor(3600);
      await evaluate(`window.__mockDelays = {}; 1`);
      const blank = s.filter((x) => !x.frame || !x.vis || x.text < 10);
      assert(blank.length === 0, `${blank.length} of ${s.length} samples had no body (${JSON.stringify(blank[0])})`);
      assert(s.every((x) => !x.cover), 'the opening cover came back over the open body');
    });
  }

  await check('Next with a slow read: the body of the conversation before never shows under the new subject', async () => {
    const before = await evaluate(`(document.querySelector('.rp-head h1') || {}).textContent`);
    const oldSig = (await evaluate(BODY)).sig;
    await evaluate(`window.__mockDelays = { thread: 1200 }; document.querySelectorAll('.rb.nav')[1].click(); 1`);
    const s = await sampleFor(2800);
    await evaluate(`window.__mockDelays = {}; 1`);
    // (1.0.12: the old conversation stays on screen, WITH its own subject, until the next one is read and the window switches in one commit: the old body under the new subject is the fault)
    const wrong = s.filter((x) => x.subject !== null && x.subject !== before && x.sig === oldSig);
    assert(wrong.length === 0, `the old conversation's body was shown under the new subject (${wrong.length} samples)`);
    assert(s.some((x) => x.subject !== before && x.text >= 10 && !x.cover), 'the new conversation was never shown');
  });
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-popout-refresh: FAILED (${failures.length})`); process.exit(1); }
console.log('test-popout-refresh: ok');
process.exit(0);
