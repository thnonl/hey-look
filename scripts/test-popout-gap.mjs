#!/usr/bin/env node
// 1.0.12 (Windows QA round 12: one body blank of 0.6 s, no cover, right after a card unmount): a healthy transition of the reader never has a moment where the messages are there, no cover is
// shown and the card has no body. Which cards are open is derived in the render, not set by an effect after it (the render in between drew the new message closed). Every DOM change of the reader is watched
// (MutationObserver: it sees each committed state, before the effects of that render ran), and the body is sampled every 50 ms across a start, Next, Previous and a replaced message.
//   node scripts/test-popout-gap.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-gap', { vitePort0: 5380, cdpPort0: 9380 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(js); } catch { /* reloading */ } if (v) return true; await sleep(50); } return false; };
const STATE = `(() => { const f = document.querySelector('iframe.msg-frame'); const d = f && f.contentDocument; return { n: window.__store.getState().messages.length, frame: !!f, vis: !!f && f.style.visibility !== 'hidden', text: d && d.body ? d.body.innerText.trim().length : 0, cover: !!document.querySelector('.rp-opening'), subject: (document.querySelector('.rp-head h1') || {}).textContent || null }; })()`;
const BODY_OK = `(() => { const s = ${STATE}; return s.frame && s.vis && s.text > 10 && !s.cover; })()`;
const gaps = () => evaluate(`window.__gap.length`);
const sampleFor = async (ms) => { const out = []; const t0 = Date.now(); while (Date.now() - t0 < ms) { try { out.push(await evaluate(STATE)); } catch { /* a frame being written */ } await sleep(50); } return out; };
// messages there, no cover, and not a card with a frame in a shown state (a frame that is hidden is measuring itself: it has the cover, or its own 600 ms safety)
const blank = (s) => s.n > 0 && !s.cover && !s.frame && s.subject !== null;

try {
  await H.openApp('lang=en', 1100, 720);
  const id = JSON.parse(await evaluate(`(async () => { const l = await window.__TAURI_INTERNALS__.invoke('list_threads', { filter: { accountId: null, folder: 'inbox', search: '', focus: null, flat: false, unreadOnly: false, flaggedOnly: false, sortAsc: false, scope: 'current' } }); return JSON.stringify(l.filter((x) => !/invitation|cancel|confidential|sender check|unverified/i.test(x.subject)).slice(0, 4).map((t) => t.threadId)); })()`));
  await H.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__gap = []; document.addEventListener('DOMContentLoaded', () => { new MutationObserver(() => { const f = document.querySelectorAll('iframe.msg-frame').length; const cover = !!document.querySelector('.rp-opening'); const n = window.__store ? window.__store.getState().messages.length : 0; if (f === 0 && !cover && n > 0 && document.querySelector('.rp-head')) window.__gap.push(Math.round(performance.now())); }).observe(document.body, { childList: true, subtree: true }); });` });
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=reader&thread=${id[1]}#lang=en` });
  assert(await waitFor(BODY_OK, 20000), 'the body is shown at the start');
  await sleep(600);

  await check('start, Next and Previous: no sample and no committed state without a body', async () => {
    const g0 = await gaps();
    const all = [];
    for (const dir of [1, 0, 1, 0]) {
      await evaluate(`document.querySelectorAll('.rb.nav')[${dir}].click(); 1`);
      all.push(...await sampleFor(1200));
    }
    const bad = all.filter(blank);
    assert(bad.length === 0, `${bad.length} of ${all.length} samples had messages, no cover and no frame (${JSON.stringify(bad[0])})`);
    assert((await gaps()) === g0, `${(await gaps()) - g0} committed states had messages, no cover and no frame`);
    assert(await evaluate(BODY_OK), 'the body is there at the end');
  });

  await check('a message replaced by another one (the card unmount of the QA log): no committed state without a body', async () => {
    await sleep(800);
    const g0 = await gaps();
    await evaluate(`(() => { const s = window.__store.getState(); const m = s.messages[s.messages.length - 1]; window.__store.setState({ messages: [{ ...m, id: m.id + '-new' }] }); return 1; })()`);
    const s = await sampleFor(1200);
    assert(s.filter(blank).length === 0, 'a sample had no frame');
    assert((await gaps()) === g0, `${(await gaps()) - g0} committed states had the new message without a card body (the render before its card was opened)`);
    assert(await evaluate(BODY_OK), 'the body of the replaced message shows');
  });
  await check('a second message arrives (two cards): the last one is open at once', async () => {
    const g0 = await gaps();
    await evaluate(`(() => { const s = window.__store.getState(); const m = s.messages[s.messages.length - 1]; window.__store.setState({ messages: [...s.messages, { ...m, id: m.id + '-two' }] }); return 1; })()`);
    const s = await sampleFor(1000);
    assert(s.filter(blank).length === 0, 'a sample had no frame');
    assert((await gaps()) === g0, `${(await gaps()) - g0} committed states without any frame`);
  });
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-popout-gap: FAILED (${failures.length})`); process.exit(1); }
console.log('test-popout-gap: ok');
process.exit(0);
