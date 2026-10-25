#!/usr/bin/env node
// 1.0.8: "Filter: Flagged" with ONE flagged message showed the message and a "Loading…" that never went away. The list under a filter (or the Unread view, or a tab) is short
// however much older mail is downloaded, its end stays in view, so every finished `loadMore` pass started the next one and the whole mailbox was downloaded behind it.
// A pass that stored mail but gave the list no new line now stops the passes (the footer's button asks again), a failure stays in the footer with Retry, and an overtaken pass
// ends. In the dev preview (src/devMock.ts: `#big`, `#local`, `#flaggedat`, `#unreadat`, `__mockMail`):
//   L1  1 flagged of ~3000 (all mailboxes, and one mailbox): "Loading…" ends after one pass (at most 4 requests), the footer is the "Load older messages" button, nothing asks again
//   L2  0 flagged: the empty state, no "Loading…", no request
//   L3  a second flagged message older than what is downloaded: it is found, then the passes end
//   L4  more flagged messages than the window shows: no request until the end is scrolled to, "Loading…" ends afterwards
//   L5  Unread filter, the Unread view and the Flagged filter flipped quickly: always ends, one view's pass never leaves "Loading…" on another
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
  spinners: document.querySelectorAll('.ml-body .spin').length, pill: !!document.querySelector('.ml-loadpill'), skeleton: !!document.querySelector('.ml-body .skeleton, .ml-body [class*="skel"]'),
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

try {
  await check('L1: one flagged message among ~3000 (all mailboxes): the footer ends after one pass with the button', async () => {
    await open('big=3000&local=360&flaggedat=5');
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length === 1`, 5000), 'one flagged row is shown');
    const s = await settles('flagged');
    assert(s.rows === 1, `still one row: ${s.rows}`);
    assert(s.calls <= 4, `one pass is at most 4 requests, it made ${s.calls}`);
    assert(s.footButtons.length === 1 && /Load older/.test(s.footButtons[0]), `the footer is the Load older button: ${JSON.stringify(s)}`);
    assert(s.moreError === true, 'the passes are stopped');
    const bad = footVerdict(JSON.parse(await evaluate(LIST_FOOT_JS)), 'settled');
    assert(bad.length === 0, `the footer probe: ${bad.join('; ')}`);
    // the button asks again, once, and ends again
    await evaluate(`[...document.querySelectorAll('.ml-foot button')].find((b) => /Load older/.test(b.textContent)).click(); 1`);
    assert(await waitFor(`window.__store.getState().loadingMore`, 3000), 'the button started a pass');
    const s2 = await settles('flagged again');
    assert(s2.calls > s.calls && s2.calls <= s.calls + 4, `the second pass is at most 4 requests (${s.calls} -> ${s2.calls})`);
  });

  await check('L1: the same in one mailbox', async () => {
    await open('big=3000&local=360&flaggedat=5', "'inbox', 'a1'");
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    const s = await settles('flagged, one mailbox');
    assert(s.rows === 1 && s.calls <= 4 && s.footButtons.length === 1, JSON.stringify(s));
  });

  await check('L2: no flagged message: the empty state at once, no "Loading…", no request', async () => {
    await open('big=3000&local=360&flaggedat=');
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`/Nothing matches/.test(document.querySelector('.empty-state .empty-title')?.textContent || '')`, 5000), 'the "nothing matches" state is shown');
    const s = await settles('empty', 5000, 1500);
    assert(s.rows === 0 && s.calls === 0 && s.foot === null && !s.pill, JSON.stringify(s));
  });

  await check('L3: a second flagged message older than the downloaded mail is found, then "Loading…" ends', async () => {
    await open('big=3000&local=360&flaggedat=5,420', "'inbox', 'a1'");
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length === 2`, 45000), `the older flagged message arrived: ${JSON.stringify(await state())}`);
    const s = await settles('older flagged', 45000);
    assert(s.rows === 2 && s.footButtons.length === 1, JSON.stringify(s));
  });

  await check('L4: more flagged messages than the window shows: no request while the end is far, "Loading…" ends after the scroll', async () => {
    await open('big=3000&local=360&flaggedat=' + Array.from({ length: 40 }, (_, i) => i * 2).join(','));
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length >= 6`, 5000), 'rows shown');
    await sleep(1500);
    const s0 = await state();
    assert(s0.calls === 0 && s0.spinners === 0, `no request while the end is far away: ${JSON.stringify(s0)}`);
    await evaluate(`(() => { const el = document.querySelector('.ml-body'); el.scrollTop = el.scrollHeight; return 1; })()`);
    assert(await waitFor(`window.__mockMail.calls.length > 0`, 4000), 'the end of the list asked for older mail');
    const s = await settles('after the scroll', 30000);
    assert(s.calls <= 4 + 4, `bounded: ${s.calls} requests`);
  });

  await check('L5: Unread filter and Unread view: one row each ends with the button', async () => {
    await open('big=3000&local=360&unreadat=5');
    await evaluate(`window.__store.getState().setFilter('unread'); 1`);
    let s = await settles('unread filter');
    assert(s.rows === 1 && s.footButtons.length === 1, `unread filter: ${JSON.stringify(s)}`);
    await evaluate(`window.__store.getState().setFilter('all'); window.__store.getState().setView('unread', null); 1`);
    await waitFor(`!window.__store.getState().loading`, 5000);
    s = await settles('unread view');
    assert(s.rows === 1 && s.footButtons.length === 1, `unread view: ${JSON.stringify(s)}`);
  });

  await check('L5: the Flagged filter flipped quickly ends in the state of the last choice', async () => {
    await open('big=3000&local=360&flaggedat=5');
    await evaluate(`(async () => { const s = window.__store.getState(); for (let i = 0; i < 8; i++) { void s.setFilter(i % 2 ? 'all' : i % 3 ? 'flagged' : 'unread'); await new Promise((r) => setTimeout(r, 40)); } void s.setFilter('flagged'); return 1; })()`);
    assert(await waitFor(`!window.__store.getState().loading`, 8000), 'the list is read');
    const s = await settles('flipped');
    assert(s.rows === 1 && !s.pill && s.footButtons.length === 1, JSON.stringify(s));
    // and off again: the whole mailbox is shown, the footer pages as before (it is not stuck in the stopped state)
    await evaluate(`window.__store.getState().setFilter('all'); 1`);
    assert(await waitFor(`document.querySelectorAll('.ml-row').length > 5 && !window.__store.getState().loading`, 6000), 'the unfiltered list is back');
    assert((await state()).moreError === false, 'the stop belongs to the filtered view only');
  });

  await check('L5: a filter chosen while a pass of the other view runs: that pass ends at once', async () => {
    await open('big=3000&local=360&flaggedat=5');
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`window.__store.getState().loadingMore`, 4000), 'a pass runs');
    await evaluate(`window.__store.getState().setFilter('all'); 1`);
    assert(await waitFor(`!window.__store.getState().loadingMore || window.__store.getState().threads.length > 5`, 3000), 'the overtaken pass ended with the choice');
    assert(await waitFor(`!window.__store.getState().loading`, 5000), 'the list was read');
  });

  await check('L6: a failed request: the reason and Retry stay in the footer; Retry asks again', async () => {
    await open('big=3000&local=360&flaggedat=5&failolder=1');
    await evaluate(`window.__store.getState().setFilter('flagged'); 1`);
    assert(await waitFor(`!!window.__store.getState().moreFail && !window.__store.getState().loadingMore`, 10000), 'the failure is noted');
    const s = await state();
    assert(s.spinners === 0 && s.footButtons.length === 1 && s.footButtons[0] === 'Retry' && /timed out|Timed out|connection/i.test(s.foot), `reason and Retry: ${JSON.stringify(s)}`);
    const bad = footVerdict(JSON.parse(await evaluate(LIST_FOOT_JS)), 'failed');
    assert(bad.length === 0, `the footer probe: ${bad.join('; ')}`);
    const c = s.calls;
    await evaluate(`[...document.querySelectorAll('.ml-foot button')].find((b) => b.textContent.trim() === 'Retry').click(); 1`);
    assert(await waitFor(`window.__store.getState().loadingMore`, 3000), 'Retry started a pass');
    const s2 = await settles('after Retry');
    assert(s2.calls > c && s2.calls <= c + 4 && !(await evaluate(`!!window.__store.getState().moreFail`)), JSON.stringify(s2));
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-list-filter-loading: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-list-filter-loading: ok');
