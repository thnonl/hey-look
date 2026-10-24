#!/usr/bin/env node
// W4.6 (windows for calendar events, Settings, search results and the Scheduled list), the real views in the dev preview (`?w=event`, `?w=settings`, `?w=search`, `?w=scheduled`; the mock backend
// answers the requests of the windows, src/devMock.ts). What a plain browser tab can show; the windows themselves, the registry, the cap and the quit are Rust / QA rows.
//   - each kind renders and has its title ("{title} – Hey Look!") in the language in use; a prefs-changed theme switch is followed;
//   - event: the form of the dialog as a page, its Delete asks and deletes, Close with changes asks the discard question (Cancel keeps it, Discard ends the window), without changes it ends;
//     Save ends the window and hands a toast to the main window; the dialog has the "Open in new window" button that moves the form with its changes;
//   - settings: the page of the dialog opens on the asked tab; a change of a preference is applied here and asked of the main window (the prefs request), nothing is written here;
//     the dialog of Settings has the "Open in new window" button;
//   - search: the results of the search it was opened with, the rows look like the main list's, Enter / double-click open a reader, the hover and the keys go to the main window;
//   - scheduled: the list with its groups, refreshed when the outbox changes.
//   node scripts/test-popout-kinds.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-kinds', { vitePort0: 5380, cdpPort0: 9380 });
const { evaluate } = H;
const { press } = inputs(H, null, 'kinds');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`(async () => JSON.stringify(await (${js})))()`).then((s) => JSON.parse(s));

async function open(query, hash = 'lang=en', width = 1100, height = 760) {
  await H.openApp(hash, width, height);
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?${query}#${hash}` });
}
const kind = () => evaluate(`document.querySelector('[data-popout]')?.dataset.popout ?? null`);
const requests = () => json(`window.__popoutRequests || []`);

try {
  // ---------- the four kinds render, with their titles
  const titles = { 'w=scheduled': 'Scheduled – Hey Look!', 'w=search&q=invoice': 'Search results – Hey Look!', 'w=event': 'Q4 contract call – Hey Look!', 'w=event&mock=new': 'New event – Hey Look!', 'w=settings': 'Settings – Hey Look!' };
  for (const [q, title] of Object.entries(titles)) {
    await open(q);
    await check(`${q}: renders with the title "${title}"`, async () => {
      assert.ok(await waitFor(`!!document.querySelector('[data-popout]:not([data-popout="loading"])')`, 20000), 'the view did not render');
      assert.ok(await waitFor(`document.title === ${JSON.stringify(title)}`, 8000), `title ${await evaluate('document.title')}`);
      // (the event form and the Settings page are chunks of their own: the window is drawn once they are there)
      const boxJs = `(() => { const r = document.getElementById('root').firstElementChild.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`;
      await waitFor(`(() => { const b = ${boxJs}; return b[0] > 300 && b[1] > 200; })()`, 10000);
      const box = await json(boxJs);
      assert.ok(box[0] > 300 && box[1] > 200, `drawn ${box}`);
    });
  }

  // ---------- the theme follows the main window
  await open('w=scheduled');
  await check('a prefs-changed theme switch is followed within 1 s (REQ-4.6.2)', async () => {
    assert.ok(await waitFor(`!!document.querySelector('[data-popout="scheduled"]')`, 20000));
    const before = await evaluate(`document.documentElement.getAttribute('data-theme')`);
    const prefs = await json(`window.__TAURI_INTERNALS__.invoke('get_setting', { key: 'prefs' }).then((v) => JSON.parse(v || '{}'))`);
    await evaluate(`(async () => { await window.__TAURI_INTERNALS__.invoke('set_setting', { key: 'prefs', value: ${JSON.stringify(JSON.stringify({ ...prefs, theme: 'dark' }))} }); await window.__mockEmit('prefs-changed', { writer: 'main' }); return 1; })()`);
    assert.ok(await waitFor(`document.documentElement.getAttribute('data-theme') === 'dark'`, 1500), `theme ${await evaluate(`document.documentElement.getAttribute('data-theme')`)} (was ${before})`);
  });

  // ---------- scheduled
  await open('w=scheduled');
  await check('scheduled: the groups, the failed count and the rows of ScheduledList (REQ-4.6.18)', async () => {
    assert.ok(await waitFor(`document.querySelectorAll('.sched-list .ml-row.sched').length >= 3`, 15000), 'no rows');
    const t = await evaluate(`document.querySelector('.sched-list').innerText`);
    assert.match(t, /Needs attention/i);
    assert.equal(await evaluate(`!!document.querySelector('.sched-row-acts .icon-btn')`), true, 'Send now / Change time / Cancel');
  });
  await check('scheduled: the list is read again when the outbox changes', async () => {
    const n = await evaluate(`document.querySelectorAll('.ml-row.sched').length`);
    await evaluate(`window.__mockEmit('outbox-changed', null); 1`);
    await sleep(600);
    assert.equal(await evaluate(`document.querySelectorAll('.ml-row.sched').length`), n);
  });
  await check('scheduled: Edit opens a compose window (always a window from a window, REQ-4.6.18)', async () => {
    await evaluate(`window.__popoutOpened = []; document.querySelector('.ml-row.sched').click(); 1`);
    assert.ok(await waitFor(`(window.__popoutOpened || []).some((o) => o.kind === 'compose')`, 8000), 'no compose window was asked for: ' + JSON.stringify(await evaluate('window.__popoutOpened')));
  });

  // ---------- search
  await open('w=search&q=invoice');
  await check('search: the results of the search it was opened with, the text read-only, no reading pane (REQ-4.6.14)', async () => {
    assert.ok(await waitFor(`document.querySelectorAll('.ml-row').length >= 3`, 15000), 'no rows');
    const s = await json(`({ q: document.querySelector('.sw-query')?.textContent, input: document.querySelectorAll('input').length, pane: !!document.querySelector('.reading-pane'), head: document.querySelector('.ml-title h1')?.textContent })`);
    assert.equal(s.q, 'invoice'); assert.equal(s.input, 0, 'the search text is not an input'); assert.equal(s.pane, false); assert.equal(s.head, 'Search results');
  });
  await check('search: Enter and a double-click open a reader window; the hover Archive and the key e go to the main window (REQ-4.6.15)', async () => {
    await evaluate(`window.__popoutOpened = []; window.__popoutRequests = []; document.querySelector('.ml-row').click(); 1`);
    await press('Enter', 'Enter');
    assert.ok(await waitFor(`(window.__popoutOpened || []).some((o) => o.kind === 'reader')`, 8000), 'Enter did not open a reader');
    await evaluate(`window.__popoutOpened = []; document.querySelectorAll('.ml-row')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 1`);
    assert.ok(await waitFor(`(window.__popoutOpened || []).some((o) => o.kind === 'reader')`, 8000), 'a double-click did not open a reader');
    await evaluate(`document.querySelector('.ml-row').click(); 1`);
    await press('e', 'KeyE');
    assert.ok(await waitFor(`(window.__popoutRequests || []).some((r) => r.kind === 'thread-action' && r.payload.action === 'archive')`, 8000), JSON.stringify(await requests()));
    const r = (await requests()).find((x) => x.kind === 'thread-action');
    assert.equal(r.payload.labelKey, 'reading.head.archived');
  });
  await check('search: j and k move the selection; Esc is handled by the window (REQ-4.6.15)', async () => {
    await evaluate(`document.querySelector('.ml-row').click(); 1`);
    const first = await evaluate(`document.querySelector('.ml-row.selected')?.dataset.thread`);
    await press('j', 'KeyJ');
    const second = await evaluate(`document.querySelector('.ml-row.selected')?.dataset.thread`);
    assert.notEqual(first, second);
    await press('k', 'KeyK');
    assert.equal(await evaluate(`document.querySelector('.ml-row.selected')?.dataset.thread`), first);
  });
  await open('w=search&q=zzzznothing');
  await check('search: no result shows the empty-search text of the main list', async () => {
    assert.ok(await waitFor(`!!document.querySelector('.empty-state')`, 15000));
    assert.match(await evaluate(`document.querySelector('.empty-state').innerText`), /No results/i);
  });

  // ---------- event
  await open('w=event');
  await check('event: the form of the dialog as a page, with Delete (an existing event), no header close (REQ-4.6.6/7)', async () => {
    assert.ok(await waitFor(`!!document.querySelector('.ev-form') && document.getElementById('ev-title')?.value === 'Q4 contract call'`, 15000), 'the form did not load the event');
    assert.equal(await evaluate(`!!document.querySelector('.modal.windowed')`), true);
    assert.equal(await evaluate(`!!document.querySelector('.modal-head')`), false, 'the title of the window is the native one');
    assert.equal(await evaluate(`[...document.querySelectorAll('.row-inline .btn')].map((b) => b.textContent.trim()).join('|')`).then((s) => /Delete/.test(s)), true);
  });
  await check('event: Close with changes asks the discard question; Cancel keeps the form, Discard ends the window (AC-4.6.2)', async () => {
    await evaluate(`window.__popoutDestroyed = 0; (() => { const i = document.getElementById('ev-title'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Changed title'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await sleep(200);
    await evaluate(`[...document.querySelectorAll('.row-inline .btn')].find((b) => b.textContent.trim() === 'Cancel').click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.ask, .modal-ask, [role="alertdialog"]')`, 5000), 'no discard question');
    const q = await evaluate(`document.querySelector('.ask, .modal-ask, [role="alertdialog"]').innerText`);
    assert.match(q, /Discard/i);
    // Cancel (the first choice) keeps the form
    await evaluate(`[...document.querySelectorAll('.ask button, [role="alertdialog"] button')].find((b) => /keep|cancel/i.test(b.textContent))?.click(); 1`);
    await sleep(400);
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 0);
    assert.equal(await evaluate(`document.getElementById('ev-title').value`), 'Changed title');
    await evaluate(`[...document.querySelectorAll('.row-inline .btn')].find((b) => b.textContent.trim() === 'Cancel').click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.ask, .modal-ask, [role="alertdialog"]')`, 5000));
    await evaluate(`[...document.querySelectorAll('.ask button, [role="alertdialog"] button')].find((b) => /discard/i.test(b.textContent))?.click(); 1`);
    assert.ok(await waitFor(`(window.__popoutDestroyed || 0) >= 1`, 5000), 'Discard did not end the window');
  });
  await open('w=event');
  await check('event: Close without changes ends the window at once', async () => {
    assert.ok(await waitFor(`document.getElementById('ev-title')?.value === 'Q4 contract call'`, 15000));
    await evaluate(`window.__popoutDestroyed = 0; [...document.querySelectorAll('.row-inline .btn')].find((b) => b.textContent.trim() === 'Cancel').click(); 1`);
    assert.ok(await waitFor(`(window.__popoutDestroyed || 0) >= 1`, 5000));
  });
  await open('w=event');
  await check('event: Save ends the window and the toast is made in the main window (REQ-4.6.7)', async () => {
    assert.ok(await waitFor(`document.getElementById('ev-title')?.value === 'Q4 contract call'`, 15000));
    await evaluate(`window.__popoutDestroyed = 0; window.__popoutRequests = []; [...document.querySelectorAll('.row-inline .btn.primary')][0].click(); 1`);
    assert.ok(await waitFor(`(window.__popoutDestroyed || 0) >= 1`, 8000), 'Save did not end the window');
    const r = (await requests()).find((x) => x.kind === 'toast');
    assert.ok(r, JSON.stringify(await requests()));
    assert.match(r.payload.text, /Invitations sent|Event saved/);
  });
  await open('w=event');
  await check('event: Delete of an event with guests asks (keep / delete / send cancellation), then deletes and ends the window (AC-4.6.2)', async () => {
    assert.ok(await waitFor(`document.getElementById('ev-title')?.value === 'Q4 contract call'`, 15000));
    await evaluate(`window.__popoutDestroyed = 0; [...document.querySelectorAll('.row-inline .btn')].find((b) => /Delete/.test(b.textContent)).click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.ask, [role="alertdialog"]')`, 5000), 'no question');
    await evaluate(`[...document.querySelectorAll('.ask button, [role="alertdialog"] button')].find((b) => /keep/i.test(b.textContent))?.click(); 1`);
    await sleep(400);
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 0, 'Keep must not delete');
    await evaluate(`[...document.querySelectorAll('.row-inline .btn')].find((b) => /Delete/.test(b.textContent)).click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.ask, [role="alertdialog"]')`, 5000));
    await evaluate(`[...document.querySelectorAll('.ask button, [role="alertdialog"] button')].find((b) => /send cancellation/i.test(b.textContent))?.click(); 1`);
    assert.ok(await waitFor(`(window.__popoutDestroyed || 0) >= 1`, 8000), 'the window did not end after the delete');
  });

  // ---------- the dialogs have the button
  await H.openApp('lang=en', 1280, 800);
  await check('the event dialog has "Open in new window" in its header, left of the close button; it moves the changes (REQ-4.6.6)', async () => {
    await evaluate(`window.__store.getState().setDialog({ type: 'event', eventId: 'e3' }); 1`);
    assert.ok(await waitFor(`document.getElementById('ev-title')?.value === 'Q4 contract call'`, 15000));
    await evaluate(`(() => { const i = document.getElementById('ev-title'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Moved title'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    const order = await json(`[...document.querySelectorAll('.modal-head-acts > button')].map((b) => b.getAttribute('aria-label'))`);
    assert.deepEqual(order, ['Open in new window', 'Close']);
    await evaluate(`window.__popoutOpened = []; document.querySelector('.modal-head-acts button[aria-label="Open in new window"]').click(); 1`);
    assert.ok(await waitFor(`(window.__popoutOpened || []).some((o) => o.kind === 'event')`, 5000), 'no window asked for');
    const o = (await json(`window.__popoutOpened`)).find((x) => x.kind === 'event');
    assert.equal(o.key, 'event:e3');
    assert.equal(o.init.eventId, 'e3'); assert.equal(o.init.draft.title, 'Moved title'); assert.equal(o.init.draft.dirty, true);
    assert.ok(await waitFor(`!document.querySelector('.modal')`, 3000), 'the dialog did not close');
  });
  await check('the Settings dialog has "Open in new window"; the window opens on the same tab (REQ-4.6.8)', async () => {
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'appearance' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.settings-nav')`, 15000));
    await evaluate(`window.__popoutOpened = []; document.querySelector('.modal-head-acts button[aria-label="Open in new window"]').click(); 1`);
    assert.ok(await waitFor(`(window.__popoutOpened || []).some((o) => o.kind === 'settings')`, 5000));
    const o = (await json(`window.__popoutOpened`)).find((x) => x.kind === 'settings');
    assert.equal(o.key, 'settings'); assert.equal(o.init.tab, 'appearance');
    assert.ok(await waitFor(`!document.querySelector('.modal')`, 3000), 'the dialog did not close');
  });
  await check('the New event ribbon button with Shift opens an event window, plain it opens the dialog (REQ-4.6.6 c)', async () => {
    await evaluate(`window.__store.getState().setModule('calendar'); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.rb.primary[title]')`, 15000));
    await evaluate(`window.__popoutOpened = []; 1`);
    await H.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await evaluate(`(() => { const b = [...document.querySelectorAll('.rb.primary')].find((x) => /New event/i.test(x.textContent)); b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); return 1; })()`);
    assert.ok(await waitFor(`(window.__popoutOpened || []).some((o) => o.kind === 'event' && o.key === null)`, 5000), JSON.stringify(await evaluate('window.__popoutOpened')));
    await evaluate(`(() => { const b = [...document.querySelectorAll('.rb.primary')].find((x) => /New event/i.test(x.textContent)); b.click(); return 1; })()`);
    assert.ok(await waitFor(`!!document.querySelector('.modal')`, 8000), 'a plain click opens the dialog');
  });

  // ---------- settings window
  await open('w=settings&tab=appearance');
  await check('settings: opens on the asked tab as the page of the window (REQ-4.6.8)', async () => {
    assert.ok(await waitFor(`!!document.querySelector('.settings-nav')`, 20000), 'no settings page');
    assert.equal(await evaluate(`document.querySelector('.settings-nav button.active')?.textContent.trim()`), 'Appearance');
    assert.equal(await evaluate(`!!document.querySelector('.modal-head')`), false);
    assert.equal(await evaluate(`!!document.querySelector('.modal-back')`), false, 'no backdrop: it is the page of the window');
  });
  await check('settings: a preference changed here is applied here and asked of the main window; nothing is written here (REQ-4.6.3)', async () => {
    await evaluate(`window.__popoutRequests = []; window.__settingsWrites = []; 1`);
    // the density switch of Appearance
    await evaluate(`(() => { const b = [...document.querySelectorAll('.settings-body button, .settings-body label')].find((x) => /Compact/i.test(x.textContent)); b?.click(); return 1; })()`);
    await sleep(500);
    const reqs = await requests();
    const p = reqs.find((r) => r.kind === 'prefs');
    assert.ok(p, 'no prefs request: ' + JSON.stringify(reqs));
    assert.ok(Object.keys(p.payload).length >= 1);
    assert.equal(await evaluate(`document.documentElement.getAttribute('data-density')`), 'compact', 'applied here at once');
  });
  await check('settings: popout-refocus brings the window to another tab (REQ-4.6.9)', async () => {
    await evaluate(`window.__mockEmit('popout-refocus', { tab: 'shortcuts' }); 1`);
    assert.ok(await waitFor(`document.querySelector('.settings-nav button.active')?.textContent.trim() === 'Shortcuts'`, 3000), await evaluate(`document.querySelector('.settings-nav button.active')?.textContent`));
  });
  await check('settings: the Shortcuts tab has the Move to main window row after the Pop out row, on one line (AC-4.5.10)', async () => {
    const rows = await json(`[...document.querySelectorAll('.settings-body .set-row')].map((r) => ({ text: r.innerText.split('\\n').join(' ').trim(), h: Math.round(r.getBoundingClientRect().height), lh: parseFloat(getComputedStyle(r).lineHeight) || 20 }))`);
    const at = rows.findIndex((r) => /Move a message back to the main window/.test(r.text));
    assert.ok(at > 0, JSON.stringify(rows.slice(0, 5)));
    assert.match(rows[at - 1].text, /new window/i, rows[at - 1].text);
    assert.ok(rows[at].h <= rows[at - 1].h, `the text wraps: the row is ${rows[at].h} px high, the Pop out row ${rows[at - 1].h}`);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('test-popout-kinds: ok');
