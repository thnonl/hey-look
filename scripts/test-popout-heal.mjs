#!/usr/bin/env node
// 1.0.12 BUG-1 (Windows QA rounds 7-9: the reader's body was empty for 1-3 s without the cover): a body that stays blank for 1 s repairs itself (the watchdog of ReaderView re-reads the conversation,
// opens the last card and lets the frame measure itself, at most twice) and does nothing while the body is there. The dev preview: `?w=reader`; the blank is simulated (the messages of the window's store
// emptied, a frame hidden); the lines of the diagnostic are caught on their way to `popout_note`.
//   node scripts/test-popout-heal.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-heal', { vitePort0: 5370, cdpPort0: 9370 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(js); } catch { /* reloading */ } if (v) return Date.now() - t0; await sleep(50); } return -1; };
const BODY_OK = `(() => { const f = document.querySelector('iframe.msg-frame'); const d = f && f.contentDocument; return !!f && f.style.visibility !== 'hidden' && !!d && !!d.body && d.body.innerText.trim().length > 10 && !document.querySelector('.rp-opening'); })()`;
const notes = () => evaluate(`JSON.stringify(window.__notes.filter((x) => x.includes('recover') ))`).then(JSON.parse);

try {
  await H.openApp('lang=en', 1100, 720);
  const id = JSON.parse(await evaluate(`(async () => { const l = await window.__TAURI_INTERNALS__.invoke('list_threads', { filter: { accountId: null, folder: 'inbox', search: '', focus: null, flat: false, unreadOnly: false, flaggedOnly: false, sortAsc: false, scope: 'current' } }); return JSON.stringify(l.filter((x) => !/invitation|cancel|confidential|sender check|unverified/i.test(x.subject)).slice(0, 3).map((t) => t.threadId)); })()`));
  await H.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__notes = []; (function hook() { const i = setInterval(() => { const t = window.__TAURI_INTERNALS__; if (!t || t.__w) return; t.__w = 1; const inv = t.invoke; t.invoke = function (c, a, o) { if (c === 'popout_note') window.__notes.push(a.text); return inv.call(this, c, a, o); }; clearInterval(i); }, 1); })();` });
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=reader&thread=${id[1]}#lang=en` });
  assert((await waitFor(BODY_OK, 20000)) >= 0, 'the body is shown at the start');

  await check('a body that is there: nothing is repaired (4 s)', async () => {
    await sleep(4000);
    assert((await evaluate(BODY_OK)) === true, 'the body is still there');
    assert((await notes()).length === 0, `a recovery ran with a good body: ${JSON.stringify(await notes())}`);
  });
  await check('after the mount: the messages of the window are gone -> the body is back within 2.5 s', async () => {
    await evaluate(`window.__store.setState({ messages: [] }); 1`);
    const t = await waitFor(BODY_OK, 2500);
    assert(t >= 0, 'the body did not come back');
    assert(t >= 700, `repaired too early (${t} ms): the try waits 1 s`);
    assert((await notes()).some((x) => /recover 1 why=no messages/.test(x)), `no recovery line: ${JSON.stringify(await notes())}`);
  });
  await check('a frame that stays hidden is shown again', async () => {
    await sleep(2000);
    await evaluate(`document.querySelector('iframe.msg-frame').style.visibility = 'hidden'; 1`);
    const t = await waitFor(BODY_OK, 2800);
    assert(t >= 0, 'the hidden frame stayed hidden');
    assert((await notes()).some((x) => /why=no body/.test(x)), `no "no body" recovery line: ${JSON.stringify(await notes())}`);
  });
  await check('at most two tries for a body that cannot come back', async () => {
    await sleep(11000); // (the count starts again after 10 s of a good body)
    const before = (await notes()).length;
    // a window whose store is emptied again and again: the tries stop at two
    for (let i = 0; i < 8; i++) { await evaluate(`window.__store.setState({ messages: [] }); 1`); await sleep(400); }
    await sleep(2500);
    const n = (await notes()).length - before;
    assert(n <= 2, `${n} recoveries in one episode (at most 2)`);
  });
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-popout-heal: FAILED (${failures.length})`); process.exit(1); }
console.log('test-popout-heal: ok');
process.exit(0);
