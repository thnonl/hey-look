#!/usr/bin/env node
// W6.7 "Search on the server" in the real page (dev preview, mock backend `#serversearch[=capped|none|fail|slow|local]`, src/devMock.ts): the button at the end of the results of a
// search (never started by itself), the running state with Cancel, the heading "On the server" and the rows, the notes (capped, nothing more, a mailbox that failed, pinned / snoozed),
// opening a row, the keyboard (Tab reaches the button, Enter starts it, arrows move between the rows, Enter opens one) and that a different search drops the results.
//   node scripts/test-server-search-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';
import { makeInput } from './lib/editor-input.mjs';

const H = await startHarness('test-server-search-ui', { vitePort0: 5200, cdpPort0: 9200 });
const { evaluate, cdp } = H;
const I = makeInput(cdp, sleep);
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(50); } return false; };
const S = 'window.__store.getState()';
const json = (js) => evaluate(`JSON.stringify(${js})`).then(JSON.parse);
const calls = () => json('window.__serverCalls || []');
const section = () => json(`(() => { const s = document.querySelector('.ml-srv'); if (!s) return null; return { phase: s.dataset.serverSearch, text: s.innerText, rows: s.querySelectorAll('.ml-srv-rows .ml-row').length, heading: s.querySelector('.ml-srv-head')?.textContent ?? null }; })()`);
/** the list scrolled to its end, so the footer is drawn */
const toEnd = () => evaluate(`(() => { const row = document.querySelector('.ml-row'); if (!row) return 0; for (let p = row.parentElement; p; p = p.parentElement) { if (p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY)) { p.scrollTop = p.scrollHeight; break; } } return 1; })()`);
const search = async (q, hash = 'serversearch') => {
  await H.openApp(`lang=en&${hash}`, 1280, 800);
  assert.ok(await waitFor(`${S}.threads.length > 2`, 20000), 'the Inbox has conversations');
  await evaluate(`${S}.setSearch(${JSON.stringify(q)}); 1`);
  assert.ok(await waitFor(`${S}.search === ${JSON.stringify(q)} && ${S}.threads.length >= 0`));
  await sleep(600);
  await toEnd();
  assert.ok(await waitFor(`!!document.querySelector('.ml-srv')`, 6000), 'the section at the end of the results is not drawn');
};

try {
  await check('the button: shown at the end of a search, with its hint, and nothing was asked of the server', async () => {
    await search('invoice');
    const s = await section();
    assert.equal(s.phase, 'idle');
    assert.match(s.text, /Search on the server/);
    const hint = await evaluate(`document.querySelector('.ml-srv button').title`);
    assert.equal(hint, 'Also looks for mail that isn’t downloaded to this computer. The search runs on your mail server.');
    assert.deepEqual(await calls(), [], 'never started by itself');
    // it comes before the "Search in <webmail>" buttons (when there are any)
    const order = await evaluate(`(() => { const a = document.querySelector('.ml-srv'); const b = document.querySelector('.gmail-search'); return !b || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })()`);
    assert.ok(order, 'before the webmail buttons');
  });

  await check('Enter on the focused button starts it; the running state has Cancel; Cancel is back to the button within 1 s and tells the backend', async () => {
    await search('invoice', 'serversearch=slow');
    await evaluate(`document.querySelector('.ml-srv button').focus(); 1`);
    await I.keys.activate('Enter');
    assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'running'`, 3000));
    const run = await section();
    assert.match(run.text, /Searching on the server…/);
    assert.ok(await evaluate(`!!document.querySelector('.ml-srv .spin')`), 'the spinner');
    const t0 = Date.now();
    await evaluate(`[...document.querySelectorAll('.ml-srv button')].find((b) => b.textContent.trim() === 'Cancel').click(); 1`);
    assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'idle'`, 1000), 'the button did not come back');
    assert.ok(Date.now() - t0 < 1000);
    const c = await calls();
    assert.deepEqual(c.map((x) => x.cmd), ['search', 'cancel']);
    assert.equal(c[0].filter.search, 'invoice');
    await sleep(500);
    assert.equal((await section()).rows, 0, 'no rows from the cancelled search');
  });

  await check('the results: heading, rows of the list look, unread, attachment; no duplicate rows; the search text is not in the rows of the local list', async () => {
    await search('invoice');
    await evaluate(`document.querySelector('.ml-srv button').click(); 1`);
    assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'done'`, 5000));
    await toEnd();
    const s = await section();
    assert.equal(s.heading, 'On the server');
    assert.equal(s.rows, 7);
    const detail = await json(`[...document.querySelectorAll('.ml-srv-rows .ml-row')].map((r) => ({ subject: r.querySelector('.subject')?.textContent, unread: r.classList.contains('unread'), attach: !!r.querySelector('[aria-label="Has attachments"], svg.lucide-paperclip'), flagged: !!r.querySelector('.flag-on'), preview: !!r.querySelector('.preview') }))`);
    assert.equal(detail[0].subject, 'Báo cáo quý 3');
    assert.equal(detail[0].unread, false);
    assert.equal(detail[1].unread, true, 'an unread message is drawn unread');
    assert.ok(detail[1].attach, 'the attachment icon');
    assert.ok(detail[3].flagged);
    assert.ok(detail.every((d) => !d.preview), 'no snippet');
    assert.equal(new Set(detail.map((d) => d.subject)).size, 7);
    assert.match((await section()).text, /^[\s\S]*On the server/);
  });

  await check('keyboard: arrows move between the rows, Enter opens one (the download is asked for and the conversation opens)', async () => {
    await evaluate(`document.querySelector('.ml-srv-rows .ml-row').focus(); 1`);
    await I.keys.down();
    assert.equal(await evaluate(`document.activeElement === document.querySelectorAll('.ml-srv-rows .ml-row')[1]`), true, 'ArrowDown');
    await I.keys.down();
    await I.keys.down();
    await I.keys.down(); // (4th row: index 4)
    assert.equal(await evaluate(`document.activeElement === document.querySelectorAll('.ml-srv-rows .ml-row')[4]`), true);
    await I.keys.home();
    assert.equal(await evaluate(`document.activeElement === document.querySelectorAll('.ml-srv-rows .ml-row')[0]`), true, 'Home');
    await I.keys.end();
    assert.equal(await evaluate(`document.activeElement === document.querySelectorAll('.ml-srv-rows .ml-row')[6]`), true, 'End');
    await I.keys.activate('Enter');
    assert.ok(await waitFor(`(window.__serverCalls || []).some((c) => c.cmd === 'open')`, 4000), 'no download was asked for');
    const open = (await calls()).find((c) => c.cmd === 'open');
    assert.equal(open.uid, 5000 - 6);
    assert.ok(await waitFor(`${S}.selected === 't1'`, 5000), 'the conversation did not open');
  });

  await check('a different search drops the results and the button returns', async () => {
    await evaluate(`${S}.setSearch('invoice 2'); 1`);
    await sleep(500);
    await toEnd();
    assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'idle'`, 3000), JSON.stringify(await section()));
    assert.equal((await section()).rows, 0);
  });

  await check('a different scope drops them too', async () => {
    await evaluate(`document.querySelector('.ml-srv button').click(); 1`);
    assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'done'`, 5000));
    await evaluate(`${S}.setSearchScope('account'); 1`);
    await sleep(600);
    await toEnd();
    assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'idle'`, 3000));
    // and the search asked with the scope of the moment
    await evaluate(`document.querySelector('.ml-srv button').click(); 1`);
    assert.ok(await waitFor(`(window.__serverCalls || []).filter((c) => c.cmd === 'search').length >= 3`, 4000));
    const last = (await calls()).filter((c) => c.cmd === 'search').at(-1);
    assert.equal(last.filter.scope, 'account');
  });

  for (const [mode, expect] of [
    ['capped', /Showing the newest 200 results from the server\. Add words to narrow the search\./],
    ['none', /Nothing more found on the server\./],
    ['fail', /Couldn’t search .* on the server: /],
    ['local', /Pinned and snoozed are known only on this computer, so the server search leaves them out\./],
  ]) {
    await check(`the ${mode} note`, async () => {
      await search('invoice', `serversearch=${mode}`);
      await evaluate(`document.querySelector('.ml-srv button').click(); 1`);
      assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'done'`, 6000));
      await toEnd();
      const s = await section();
      assert.match(s.text, expect, s.text);
      if (mode === 'capped') assert.equal(s.rows, 200);
      if (mode === 'none') assert.equal(s.heading, null, 'no heading without rows');
    });
  }

  await check('a row whose message is gone: the error is told and the row goes', async () => {
    await search('invoice', 'serversearch&serveropenfail');
    await evaluate(`document.querySelector('.ml-srv button').click(); 1`);
    assert.ok(await waitFor(`document.querySelector('.ml-srv')?.dataset.serverSearch === 'done'`, 5000));
    await toEnd();
    await evaluate(`document.querySelector('.ml-srv-rows .ml-row').click(); 1`);
    assert.ok(await waitFor(`${S}.toasts.some((t) => /Failed|not found/i.test(t.textFn ? t.textFn() : t.text))`, 4000), 'no error toast');
    assert.ok(await waitFor(`document.querySelectorAll('.ml-srv-rows .ml-row').length === 6`, 3000), 'the row stays');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-server-search-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-server-search-ui: ok');
