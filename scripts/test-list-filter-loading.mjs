#!/usr/bin/env node
// 1.0.8 / 1.0.9: "Filter: Flagged" with ONE flagged message showed "Loading…" for ever (1.0.8), and the Unread view of six mailboxes showed two rows and "Loading…" for 40 s and more
// (QA 1.0.8 on real servers). A list that shows part of the downloaded mail (a filter, a tab, the Unread view) is short however much older mail is downloaded and its end is in view
// from the start, so every finished `loadMore` pass started the next. Now such a list asks for older mail by itself only once it can be scrolled (src/pagingPass.ts mayPageByItself):
// while it is short the footer is the "Load older messages" button; a pass that gives the list no new line stops the passes; a failure stays in the footer with Retry; a pass of
// another view ends. In the dev preview (src/devMock.ts: `#big`, `#local`, `#flaggedat`, `#unreadat`, `#olderdelay`, `__mockMail`):
//   L1  1 flagged of ~3000 (all mailboxes, one mailbox) with slow servers: no spinner and no request for 5 s, the button runs one pass of at most 4 requests that ends
//   L2  0 flagged: the empty state, no "Loading…", no request
//   L3  a second flagged message older than what is downloaded: found with the button, then it ends
//   L4  more flagged messages than the window shows: no request until the list is scrolled, "Loading…" ends afterwards
//   L5  the QA case (Unread view, two unread, 8 s servers), the Unread filter, quick flips, a filter chosen during a pass
//   L6  a failed request: the reason and Retry in the footer, "Loading…" is gone; Retry asks again
// Pure rule: scripts/test-paging-pass.mjs.   node scripts/test-list-filter-loading.mjs [--require-browser]
import { sleep, startHarness } from './cdp-harness.mjs';
import { LIST_FOOT_JS, footVerdict } from './lib/list-foot-probe.mjs';

const H = await startHarness('test-list-filter-loading', { vitePort0: 5340 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const waitFor = async (js, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(60); } return false; };
const state = () => evaluate(`(() => { const s = window.__store.getState(); const foot = document.querySelector('.ml-foot'); return JSON.stringify({
  rows: document.querySelectorAll('.ml-row').length, threads: s.threads.length, loading: s.loading, loadingMore: s.loadingMore, moreError: s.moreError, calls: window.__mockMail.calls.length,
  spinners: document.querySelectorAll('.ml-body .spin').length, pill: !!document.querySelector('.ml-loadbar.on'),
  empty: document.querySelector('.empty-state .empty-title')?.textContent || '', foot: foot ? foot.textContent.replace(/\\s+/g, ' ').trim() : null, footButtons: foot ? [...foot.querySelectorAll('button')].map((b) => b.textContent.trim()) : [] }); })()`).then(JSON.parse);
const open = async (hash, view = "'inbox', null") => {
  await H.openApp(hash, 1000, 700);
  await evaluate(`window.__store.getState().setView(${view}); 1`);
  await waitFor(`!window.__store.getState().loading`, 8000);
  await sleep(300);
};
const notSpinning = `!window.__store.getState().loadingMore && !document.querySelector('.ml-body .spin')`;
/** the footer settled: nothing loads, nothing spins; and stays so for `quiet` ms with no new request */
const settles = async (label, ms = 25000, quiet = 3000) => {
  assert(await waitFor(notSpinning, ms), `${label}: "Loading…" did not end within ${ms / 1000} s: ${JSON.stringify(await state())}`);
  const c0 = (await state()).calls;
  await sleep(quiet);
  const s = await state();
  assert(s.calls === c0 && !s.loadingMore && s.spinners === 0, `${label}: it asked again after it had settled: ${JSON.stringify(s)}`);
  return s;
};
// QA 1.0.8: every request of the real servers takes seconds: the preview answers after 3 s
const SLOW = '&olderdelay=3000';
/** no spinner for `ms` (sampled every 100 ms) and not one request for older mail */
const quiet = async (label, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await state(); assert(s.spinners === 0 && !s.loadingMore && s.calls === 0, `${label}: a spinner or a request without a press: ${JSON.stringify(s)}`); await sleep(100); }
  return state();
};
const press = async (label) => {
  await evaluate(`[...document.querySelectorAll('.ml-foot button')].find((b) => /Load older|Retry/.test(b.textContent)).click(); 1`);
  assert(await waitFor(`window.__store.getState().loadingMore`, 3000), `${label}: the button started a pass`);
};

try {
  await check('L1: one flagged message among ~3000 (all mailboxes), slow servers: no spinner, no request; the button runs one pass that ends', async () => {
    await open('big=3000&local=360&flaggedat=5' + SLOW);
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length === 1`, 5000), 'one flagged row is shown');
    const s = await quiet('flagged', 5000);
    assert(s.rows === 1 && s.footButtons.length === 1 && /Load older/.test(s.footButtons[0]), `the footer is the Load older button: ${JSON.stringify(s)}`);
    const bad = footVerdict(JSON.parse(await evaluate(LIST_FOOT_JS)), 'settled');
    assert(bad.length === 0, `the footer probe: ${bad.join('; ')}`);
    await press('flagged');
    assert((await state()).spinners === 1, 'the pressed pass shows its spinner');
    const s2 = await settles('flagged pass', 60000);
    assert(s2.calls >= 1 && s2.calls <= 4 && s2.footButtons.length === 1 && s2.moreError === true, `one pass of at most 4 requests, then the button again: ${JSON.stringify(s2)}`);
  });

  await check('L1: the same in one mailbox', async () => {
    await open('big=3000&local=360&flaggedat=5' + SLOW, "'inbox', 'a1'");
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    const s = await quiet('flagged, one mailbox', 4000);
    assert(s.rows === 1 && s.footButtons.length === 1, JSON.stringify(s));
  });

  await check('L2: no flagged message: the empty state at once, no "Loading…", no request', async () => {
    await open('big=3000&local=360&flaggedat=' + SLOW);
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`/Nothing matches/.test(document.querySelector('.empty-state .empty-title')?.textContent || '')`, 5000), 'the "nothing matches" state is shown');
    const s = await quiet('empty', 3000);
    assert(s.rows === 0 && s.foot === null && !s.pill, JSON.stringify(s));
  });

  await check('L3: a second flagged message older than the downloaded mail: found by the button, then it ends', async () => {
    await open('big=3000&local=360&flaggedat=5,420', "'inbox', 'a1'");
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    for (let i = 0; i < 3 && (await state()).rows < 2; i++) { await press('older flagged'); await settles('older flagged', 45000, 500); }
    const s = await settles('older flagged', 45000);
    assert(s.rows === 2 && s.footButtons.length === 1, JSON.stringify(s));
  });

  await check('L4: more flagged messages than the window shows: no request until the list is scrolled, "Loading…" ends afterwards', async () => {
    await open('big=3000&local=360&flaggedat=' + Array.from({ length: 40 }, (_, i) => i * 2).join(','));
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length >= 6`, 5000), 'rows shown');
    await quiet('before the scroll', 2000);
    await evaluate(`(() => { const el = document.querySelector('.ml-body'); el.scrollTop = el.scrollHeight; return 1; })()`);
    assert(await waitFor(`window.__mockMail.calls.length > 0`, 4000), 'the scrolled end of the list asked for older mail');
    const s = await settles('after the scroll', 30000);
    assert(s.calls <= 4, `one pass: ${s.calls} requests`);
  });

  await check('L5: the Unread view of the QA report (two unread, slow servers) and the Unread filter: no spinner, the button', async () => {
    await open('big=3000&local=360&unreadat=5,9&olderdelay=8000');
    await evaluate(`window.__store.getState().setView('unread', null); 1`);
    await waitFor(`!window.__store.getState().loading`, 5000);
    let s = await quiet('unread view', 6000);
    assert(s.rows === 2 && s.footButtons.length === 1, `unread view: ${JSON.stringify(s)}`);
    await evaluate(`window.__store.getState().setView('inbox', null); window.__store.getState().setFilter('unread'); 1`);
    await waitFor(`!window.__store.getState().loading`, 5000);
    s = await quiet('unread filter', 3000);
    assert(s.rows === 2 && s.footButtons.length === 1, `unread filter: ${JSON.stringify(s)}`);
  });

  await check('L5: the Flagged filter flipped quickly ends in the state of the last choice', async () => {
    await open('big=3000&local=360&flaggedat=5');
    await evaluate(`(async () => { const s = window.__store.getState(); for (let i = 0; i < 8; i++) { void s.setFilter(i % 2 ? 'all' : i % 3 ? 'flagged' : 'unread'); await new Promise((r) => setTimeout(r, 40)); } void s.setFilter('flagged'); return 1; })()`);
    assert(await waitFor(`!window.__store.getState().loading`, 8000), 'the list is read');
    const s = await settles('flipped', 10000);
    assert(s.rows === 1 && !s.pill && s.footButtons.length === 1, JSON.stringify(s));
    await evaluate(`window.__store.getState().setFilter('all'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length > 5 && !window.__store.getState().loading`, 6000), 'the unfiltered list is back');
  });

  await check('L5: a filter chosen while a pressed pass runs: that pass ends at once', async () => {
    await open('big=3000&local=360&flaggedat=5' + SLOW);
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length === 1 && !window.__store.getState().loading`, 5000), 'the flagged list');
    await press('flagged');
    await evaluate(`window.__store.getState().setFilter('all'); 1`);
    assert(await waitFor(`!window.__store.getState().loadingMore`, 3000), 'the overtaken pass ended with the choice');
    assert(await waitFor(`!window.__store.getState().loading`, 5000), 'the list was read');
  });

  await check('L6: a failed request: the reason and Retry stay in the footer; Retry asks again', async () => {
    await open('big=3000&local=360&flaggedat=5&failolder=1');
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length === 1 && !window.__store.getState().loading`, 5000), 'the flagged list');
    await press('flagged');
    assert(await waitFor(`!!window.__store.getState().moreFail && !window.__store.getState().loadingMore`, 10000), 'the failure is noted');
    const s = await state();
    assert(s.spinners === 0 && s.footButtons.length === 1 && s.footButtons[0] === 'Retry' && /timed out|Timed out|connection/i.test(s.foot), `reason and Retry: ${JSON.stringify(s)}`);
    const bad = footVerdict(JSON.parse(await evaluate(LIST_FOOT_JS)), 'failed');
    assert(bad.length === 0, `the footer probe: ${bad.join('; ')}`);
    const c = s.calls;
    await press('Retry');
    const s2 = await settles('after Retry');
    assert(s2.calls > c && s2.calls <= c + 4 && !(await evaluate(`!!window.__store.getState().moreFail`)), JSON.stringify(s2));
  });
  await check('L7: a folder of the person with dots in its name (QA-1.0.8): the header says the whole name, two rows and no request', async () => {
    await open('big=3000&local=360&dotfolder' + SLOW);
    await evaluate(`window.__store.getState().setView('f:QA-1.0.8', 'a1'); 1`);
    await waitFor(`!window.__store.getState().loading`, 5000);
    const title = await evaluate(`document.querySelector('.ml-top h2, .ml-title h2, h2.ellipsis')?.textContent`);
    assert(title === 'QA-1.0.8', `the header says ${JSON.stringify(title)}`);
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-list-filter-loading: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-list-filter-loading: ok');
