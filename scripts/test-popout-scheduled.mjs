#!/usr/bin/env node
// A scheduled message edited in a compose window (1.0.7 W2.10), real Compose in the dev preview:
//   - the window (`?w=compose&mock=scheduled`): closing it without a change releases the pause and ends it with no question; with a change it asks
//     "Close without saving your changes?" (Keep editing / Discard) and Discard releases the pause; Schedule saves it (outbox_update), the pause is not
//     released a second time and the window ends; Discard > Keep scheduled / Delete / Move to Drafts and the banner's "Send now" do what they do inline;
//   - the pane: a scheduled message has the Pop out button, it moves to a window keyed `outbox:<id>` with its outbox id and its time, and the pane does NOT release
//     the pause as it closes;
//   - the Scheduled list: Edit follows the setting "open in a separate window" and Shift (pane or window), and a second Edit of the same message focuses the
//     editor that has it instead of opening another one.
//   node scripts/test-popout-scheduled.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-scheduled', { vitePort0: 5990, cdpPort0: 9990 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };

const editorUp = () => evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor`);
const dialog = () => evaluate(`(() => { const d = document.querySelector('[role=alertdialog]'); return d ? { text: d.innerText.replace(/\\s+/g, ' '), buttons: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null; })()`);
const press = (label, within = 'button') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(within)})].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const calls = () => evaluate(`JSON.stringify(window.__outboxCalls || [])`).then((s) => JSON.parse(s));
const popCalls = () => evaluate(`JSON.stringify(window.__popoutCalls || [])`).then((s) => JSON.parse(s));
const type = () => evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent(' more'); 1`);
const names = (list) => list.map((c) => c.cmd);
const unique = (list) => list.filter((c, i) => list.findIndex((x) => x.cmd === c.cmd && x.id === c.id) === i);
const resetLog = () => evaluate(`window.__outboxCalls = []; window.__popoutCalls = []; window.__sentMessages = []; 1`);
const closeRequest = () => evaluate(`window.__mockEmit('tauri://close-requested', null); 1`);

async function windowOf() {
  await H.openApp('lang=en', 1280, 720);
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=scheduled#lang=en` });
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'the window did not start');
  await sleep(700);
  await resetLog(); // (the dev preview runs React's strict mode: it ran the clean-up of the first mount, which released once at the start)
}

try {
  // ---------- the window: the banner and the bar are those of the inline editor
  await windowOf();
  await check('window: the banner says it is scheduled and paused, the Schedule button is there', async () => {
    const txt = await evaluate(`document.querySelector('.compose-pane').innerText`);
    assert.match(txt, /Scheduled for .*Paused while you edit/s);
    assert.ok(await evaluate(`[...document.querySelectorAll('.cp-bar button')].some((b) => /Schedule/.test(b.textContent))`));
    assert.ok(await evaluate(`[...document.querySelectorAll('.compose-pane button')].some((b) => b.textContent.trim() === 'Change time') && [...document.querySelectorAll('.compose-pane button')].some((b) => b.textContent.trim() === 'Send now')`));
  });
  // closing without a change
  await closeRequest();
  await sleep(1000);
  await check('window: X without a change: no question, the pause is released, the window ends', async () => {
    assert.equal(await dialog(), null);
    assert.deepEqual(unique(await calls()), [{ cmd: 'outbox_release', id: 's1' }]);
    assert.ok((await popCalls()).includes('popout_destroy'));
  });
  await check('window: X without a change: the main window is told to reload the outbox (the row stops saying Paused), after the release and before the window is gone (D-034)', async () => {
    const reqs = await evaluate(`JSON.stringify((window.__popoutRequests || []).map((r) => r.kind))`).then((x) => JSON.parse(x));
    assert.ok(reqs.some((k) => /refresh$/.test(k)), JSON.stringify(reqs));
  });

  // closing with a change: asked, Keep editing keeps everything, Discard releases
  await windowOf();
  await type();
  await sleep(300);
  await closeRequest();
  await sleep(600);
  await check('window: X with a change asks "Close without saving your changes?" with Keep editing / Discard', async () => {
    const q = await dialog();
    assert.ok(q && /Close without saving your changes\?/.test(q.text), JSON.stringify(q));
    assert.ok(/stays scheduled as it was/.test(q.text), q.text);
    assert.deepEqual(q.buttons, ['Keep editing', 'Discard']);
  });
  await press('Keep editing', '[role=alertdialog] button');
  await sleep(500);
  await check('window: Keep editing: nothing released, nothing ended', async () => {
    assert.deepEqual(await calls(), []);
    assert.ok(!(await popCalls()).includes('popout_destroy'));
    assert.equal(await editorUp(), true);
  });
  await closeRequest();
  await sleep(500);
  await press('Discard', '[role=alertdialog] button');
  await sleep(1000);
  await check('window: Discard on the question: the pause is released (the schedule stays), the window ends', async () => {
    assert.deepEqual(unique(await calls()), [{ cmd: 'outbox_release', id: 's1' }]);
    assert.ok((await popCalls()).includes('popout_destroy'));
  });

  // Schedule from the window
  await windowOf();
  await type();
  await sleep(300);
  await press('Schedule', '.cp-bar button');
  await sleep(1800);
  await check('window: Schedule saves the change, does not release the pause again, and the window ends', async () => {
    const c = names(await calls());
    assert.deepEqual(c, ['outbox_update'], JSON.stringify(c));
    assert.ok((await popCalls()).includes('popout_destroy'), 'the window did not end');
  });

  // Discard > Delete / Move to Drafts / Keep scheduled
  for (const [choice, expected] of [['Delete', ['cancel_outbox']], ['Move to Drafts', ['outbox_to_draft']], ['Keep scheduled', ['outbox_release']]]) {
    await windowOf();
    await press('Discard', '.cp-bar button');
    await sleep(500);
    await press(choice, '[role=alertdialog] button');
    await sleep(1800);
    await check(`window: Discard > ${choice}`, async () => {
      assert.deepEqual([...new Set(names(await calls()))], expected);
      assert.ok((await popCalls()).includes('popout_destroy'), 'the window did not end');
    });
  }
  // Move to Drafts from the bar
  await windowOf();
  await press('Move to Drafts', '.cp-bar button');
  await sleep(1500);
  await check('window: the bar\'s Move to Drafts', async () => {
    assert.deepEqual(names(await calls()), ['outbox_to_draft']);
    assert.ok((await popCalls()).includes('popout_destroy'));
  });
  // Send now from the banner
  await windowOf();
  await press('Send now', '.compose-pane button');
  await sleep(2500);
  await check('window: Send now: the scheduled copy is taken out, one message is sent, the pause is not released, the window ends after the send', async () => {
    assert.deepEqual(names(await calls()), ['cancel_outbox']);
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(window.__sentMessages || [])`)), ['Scheduled one'], 'one message must be sent');
    assert.ok((await popCalls()).includes('popout_destroy'), 'the window did not end after the send');
  });

  // ---------- the pane: Pop out of a scheduled message
  await H.openApp('lang=en', 1280, 720);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Scheduled one', bodyHtml: '<p>Scheduled text</p>', outboxId: 's1', sendAt: Math.floor(Date.now() / 1000) + 10800 }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'the pane did not start');
  await sleep(700);
  await resetLog();
  await check('pane: a scheduled message has the Pop out button', async () => assert.ok(await press('Pop out')));
  await sleep(1200);
  await check('pane: Pop out moves it to a window keyed outbox:<id> with its outbox id and time; the pane closes without releasing the pause', async () => {
    const p = JSON.parse(await evaluate(`JSON.stringify((window.__popoutOpened || []).slice(-1)[0] || null)`));
    assert.equal(p.key, 'outbox:s1');
    assert.equal(p.init.outboxId, 's1');
    assert.ok(p.init.sendAt > 0);
    assert.equal(p.init.openSchedule, undefined);
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false, 'the pane stayed');
    assert.deepEqual(names(await calls()), [], 'the pane released the pause as it closed');
  });
  // Ctrl+Shift+O does the same
  await evaluate(`window.__popoutKeys = new Set(); window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Scheduled one', bodyHtml: '<p>Scheduled text</p>', outboxId: 's1', sendAt: Math.floor(Date.now() / 1000) + 10800 }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000));
  await sleep(700);
  await resetLog();
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('end'); 1`);
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'O', code: 'KeyO', windowsVirtualKeyCode: 79, modifiers: 2 | 8 });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'O', code: 'KeyO', windowsVirtualKeyCode: 79, modifiers: 2 | 8 });
  await sleep(1200);
  await check('pane: Ctrl+Shift+O pops a scheduled message out', async () => {
    assert.equal(await evaluate(`window.__popoutOpens`), 2);
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false);
  });

  // ---------- the Scheduled list: Edit and a second Edit
  const rowEdit = (name) => evaluate(`(() => { const r = [...document.querySelectorAll('.ml-row.sched')].find((x) => x.innerText.includes(${JSON.stringify(name)})); if (!r) return false; r.click(); return true; })()`);
  await H.openApp('lang=en', 1280, 720);
  await evaluate(`window.__store.getState().setView('scheduled', null); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.ml-row.sched')`, 10000), 'no scheduled rows');
  // setting off: the pane
  assert.ok(await rowEdit('Agenda for Thursday'));
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 10000), 'Edit did not open the pane');
  await sleep(700);
  await check('Scheduled > Edit with the setting off opens the pane (paused)', async () => {
    assert.equal(await evaluate(`window.__store.getState().compose?.outboxId`), 's1');
    assert.equal(await evaluate(`window.__popoutOpens || 0`), 0);
    assert.equal(names(await calls()).filter((c) => c === 'outbox_open_for_edit').length, 1);
  });
  await check('Scheduled > Edit with the setting off: the outbox read by the main window says held within 1.5 s (D-039)', async () => assert.ok(await waitFor(`window.__store.getState().outbox.find((o) => o.id === 's1')?.status === 'held'`, 1500)));
  await evaluate(`document.activeElement?.blur?.(); 1`);
  await check('a second Edit of the same message focuses the pane: no second open_for_edit, no window, the caret is in the body', async () => {
    assert.ok(await rowEdit('Agenda for Thursday'), 'the row is not there');
    await sleep(700);
    assert.equal(names(await calls()).filter((c) => c === 'outbox_open_for_edit').length, 1, 'the message was opened for edit a second time');
    assert.equal(await evaluate(`window.__popoutOpens || 0`), 0);
    assert.ok(await evaluate(`!!document.activeElement?.closest?.('.compose-pane .ProseMirror')`), 'the pane did not get the focus');
  });
  // setting on: a window
  await H.openApp('lang=en', 1280, 720);
  await evaluate(`window.__store.getState().setPrefs({ popoutCompose: true }); window.__store.getState().setView('scheduled', null); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.ml-row.sched')`, 10000));
  assert.ok(await rowEdit('Agenda for Thursday'));
  await sleep(1000);
  await check('Scheduled > Edit with the setting on opens a compose window keyed outbox:<id> (no pane), the message is paused', async () => {
    const p = JSON.parse(await evaluate(`JSON.stringify((window.__popoutOpened || []).filter((x) => !x.focusOnly).slice(-1)[0] || null)`));
    assert.equal(p.key, 'outbox:s1');
    assert.equal(p.init.outboxId, 's1');
    assert.equal(p.init.subject, 'Agenda for Thursday');
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false);
    assert.equal(names(await calls()).filter((c) => c === 'outbox_open_for_edit').length, 1);
  });
  const rowText = (name) => evaluate(`(() => { const r = [...document.querySelectorAll('.ml-row.sched')].find((x) => x.innerText.includes(${JSON.stringify(name)})); return r ? r.innerText.replace(/\\s+/g, ' ') + ' | ' + (r.getAttribute('aria-label') || '') : null; })()`);
  await check('Scheduled > Edit with the setting on: the row says "Paused · editing" within 1.5 s, from the Edit itself (no timer, no focus event; D-039: a Mac window kept the old text)', async () => {
    assert.ok(await waitFor(`(() => { const r = [...document.querySelectorAll('.ml-row.sched')].find((x) => x.innerText.includes('Agenda for Thursday')); return !!r && /Paused · editing/.test(r.innerText) && /Paused · editing/.test(r.getAttribute('aria-label') || ''); })()`, 1500), await rowText('Agenda for Thursday'));
  });
  assert.ok(await rowEdit('Agenda for Thursday'));
  await sleep(800);
  await check('a second Edit of the same message focuses the window: one window, one open_for_edit', async () => {
    assert.equal(await evaluate(`window.__popoutOpens`), 1);
    assert.equal(names(await calls()).filter((c) => c === 'outbox_open_for_edit').length, 1);
  });
  // another message is another window; and how long the row takes to say "Paused · editing" after Edit and to stop saying it after the window released the pause (owner: within about 3 s on every
  // system - Windows QA r4 measured 23.5 s for the first, the list was only read again by the 30 s timer; the clear was 263 ms). Both are measured in the page, in ms, from the click / the request.
  const says = `(() => { const r = [...document.querySelectorAll('.ml-row.sched')].find((x) => x.innerText.includes('Budget draft v3')); return !!r && /Paused · editing/.test(r.innerText); })()`;
  const msUntil = (want, from) => evaluate(`new Promise((done) => { const t0 = performance.now(); ${from}; const tick = () => { if ((${says}) === ${want}) return done(Math.round(performance.now() - t0)); if (performance.now() - t0 > 6000) return done(-1); requestAnimationFrame(tick); }; tick(); })`);
  const appearMs = await msUntil(true, `[...document.querySelectorAll('.ml-row.sched')].find((x) => x.innerText.includes('Budget draft v3')).click()`);
  console.log(`  row says "Paused · editing" ${appearMs} ms after Edit`);
  await check('Scheduled > Edit: the row says "Paused · editing" within 3 s of the click (measured in ms)', async () => assert.ok(appearMs >= 0 && appearMs <= 3000, `${appearMs} ms`));
  await sleep(500);
  await check('Edit of another scheduled message is another window', async () => assert.equal(await evaluate(`window.__popoutOpens`), 2));
  // the window ends without a change: it releases the pause (outbox_release) and tells the main window to read the outbox again (composeBridge notifyMain "refresh")
  const clearMs = await msUntil(false, `window.__TAURI_INTERNALS__.invoke('outbox_release', { id: 's2' }).then(() => window.__mockEmit('popout-request', { id: 'cw-test', from: 'compose-9', kind: 'cw-refresh', payload: null }))`);
  console.log(`  row stops saying "Paused · editing" ${clearMs} ms after the window's release`);
  await check('the row stops saying "Paused · editing" within 3 s of the window releasing the pause (measured in ms)', async () => assert.ok(clearMs >= 0 && clearMs <= 3000, `${clearMs} ms`));
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-popout-scheduled: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-popout-scheduled: ok');
