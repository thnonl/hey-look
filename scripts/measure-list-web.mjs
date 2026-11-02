#!/usr/bin/env node
// 1.0.12: the web side of the Inbox list with a 4000-conversation answer (what the backend sends for 3 big mailboxes: the cap of one list read), in the dev preview (vite DEV build, the
// real components; unoptimised, the release build is faster, the order of the costs is the same) with a headless Chromium. `list_threads` is answered by the page itself with synthetic rows
// of the size of real ones (about 470 bytes of JSON each, 1.9 MB in all). Prints JSON; changes nothing. With --assert it fails when the rows in the DOM are not a small window.
//   node scripts/measure-list-web.mjs [--require-browser] [--rows=4000] [--assert]
import { sleep, startHarness, arg, flag } from './cdp-harness.mjs';

const H = await startHarness('measure-list-web', { vitePort0: 6010 });
const { evaluate, cdp } = H;
const N = Number(arg('rows') ?? 4000);
const waitFor = async (js, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(50); } return false; };
const out = {};
try {
  await H.openApp('lang=en', 1280, 800);
  // synthetic answer of list_threads: N conversations, newest first, spread over ~3 years; `bulk` follows the tab
  await evaluate(`(() => {
    const inv = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    const accts = window.__store.getState().accounts.map((a) => a.id);
    const words = 'invoice meeting report update weekly digest offer receipt order shipping account security review notes agenda budget travel newsletter reminder'.split(' ');
    const make = (bulk, f) => {
      const out = [], now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < ${N}; i++) {
        const w = (k) => words[(i * 7 + k * 3) % words.length];
        out.push({ threadId: 'syn-' + (bulk ? 'o' : 'f') + '-' + i + '-0123456789abcdef', rowKey: 'syn-' + (bulk ? 'o' : 'f') + '-' + i + '-0123456789abcdef', accountId: accts[i % accts.length], folder: 'inbox',
          subject: 'Your ' + w(1) + ' ' + w(2) + ' for ' + w(3) + ' number ' + i, participants: ['Sender ' + (i % 500), 'Other Person ' + (i % 37)].slice(0, 1 + (i % 3 ? 1 : 0)),
          snippet: 'a snippet of about one hundred and fifty characters of text, as the list shows it under the subject line of the conversation ' + i,
          lastDate: now - i * 20000 - (i % 97) * 60, count: 1 + (i % 10 === 0 ? 2 : 0), unread: i % 3 === 0 ? 1 : 0, flagged: i % 41 === 0, pinned: false, snoozedUntil: null, hasAttach: i % 9 === 0,
          bulk, encrypted: false, signed: false, confidential: false, invite: null, importance: 'normal' });
      }
      return out;
    };
    const cache = { other: make(true), focused: make(false) };
    window.__synBytes = JSON.stringify(cache.other).length;
    window.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => {
      if (cmd === 'list_threads' && args?.filter?.folder === 'inbox' && !args.filter.search) {
        const f = args.filter.focus;
        const rows = f === 'other' ? cache.other : f === 'focused' ? cache.focused : [...cache.focused.slice(0, ${N} / 2), ...cache.other.slice(0, ${N} / 2)].sort((a, b) => b.lastDate - a.lastDate);
        // like the IPC: the page receives a parsed copy of a JSON text
        return Promise.resolve(JSON.parse(JSON.stringify(rows)));
      }
      return inv(cmd, args, opts);
    };
    window.__long = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true }); } catch {}
    return 1; })()`);
  out.payloadBytes = await evaluate('window.__synBytes');
  out.jsonParseMs = await evaluate(`(() => { const s = JSON.stringify(Array.from({ length: ${N} }, (_, i) => ({ threadId: 'syn-' + i + '-0123456789abcdef', rowKey: 'syn-' + i + '-0123456789abcdef', accountId: 'a', folder: 'inbox', subject: 'Your invoice meeting for budget number ' + i, participants: ['Sender ' + i, 'Other ' + i], snippet: 'a snippet of about one hundred and fifty characters of text, as the list shows it under the subject line of the conversation ' + i, lastDate: 1700000000 - i, count: 1, unread: 0, flagged: false, pinned: false, snoozedUntil: null, hasAttach: false, bulk: false, encrypted: false, signed: false, confidential: false, invite: null, importance: 'normal' }))); const t = performance.now(); JSON.parse(s); return [s.length, Math.round((performance.now() - t) * 10) / 10]; })()`);
  const probe = `(() => { const body = document.querySelector('.ml-body'); return { nodes: document.querySelectorAll('*').length, rows: document.querySelectorAll('.ml-row').length, vitems: document.querySelectorAll('.ml-vitem').length, threads: window.__store.getState().threads.length, scrollH: body ? body.scrollHeight : 0, longTasks: window.__long.slice() }; })()`;
  const heap = async () => { await cdp('HeapProfiler.enable'); await cdp('HeapProfiler.collectGarbage'); const h = await cdp('Runtime.getHeapUsage'); return Math.round(h.usedSize / 1048576 * 10) / 10; };
  out.heapBeforeMB = await heap();
  const sw = async (name, focus) => {
    await evaluate('window.__long.length = 0; 1');
    const t0 = Date.now();
    await evaluate(`window.__t0 = performance.now(); window.__store.getState().${focus ? `setFocus('${focus}')` : 'refresh()'}.then(() => { window.__tDone = performance.now() - window.__t0; }); window.__tDone = null; 1`);
    await waitFor('window.__tDone !== null');
    const done = await evaluate('window.__tDone');
    await waitFor(`document.querySelectorAll('.ml-row').length > 0`);
    const paint = await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(Math.round(performance.now() - window.__t0)))))`);
    await sleep(300);
    const idle = await evaluate(probe);
    out[name] = { storeRefreshMs: Math.round(done), firstPaintMs: paint, idle, wall: Date.now() - t0 };
  };
  await evaluate(`window.__store.getState().setPrefs({ focused: true }); window.__store.getState().select(null); 1`);
  await sw('combinedAll', null);
  await sw('other', 'other');
  await sw('focused', 'focused');
  await sw('other2', 'other');
  // scroll to the end of the loaded rows, in steps like a person (and once at once)
  await evaluate(`(() => { const b = document.querySelector('.ml-body'); b.scrollTop = b.scrollHeight; return 1; })()`);
  await sleep(600);
  out.atEnd = await evaluate(probe);
  out.heapAfterScrollMB = await heap();
  await evaluate(`(() => { const b = document.querySelector('.ml-body'); b.scrollTop = 0; return 1; })()`); await sleep(300);
  // keyboard: j x 30 keeps the DOM small and moves the selection
  out.heapMB = await heap();
  console.log(JSON.stringify(out, null, 1));
  if (flag('assert')) {
    const worst = Math.max(out.other.idle.vitems, out.atEnd.vitems, out.focused.idle.vitems, out.combinedAll.idle.vitems);
    if (!(out.atEnd.threads >= N / 2) || worst > 80) { console.error(`FAILED: ${worst} list lines in the DOM for ${out.atEnd.threads} conversations (bound 80)`); process.exitCode = 1; }
  }
} finally {
  await H.shutdown();
}
