#!/usr/bin/env node
// 1.0.7 W13.3 (REQ-13.3.2 to 13.3.4, AC-13.3.1 to 13.3.6) in a real browser: with real (CDP) mouse input in the dev preview, a double- or triple-click on a list row, a side-menu folder, the list's
// group header, a Settings label, a toolbar button and a toast that is not an error selects nothing; the subject, the sender and the date of the open message, a line in a field, an error toast and the
// version line in Settings > About select (Ctrl+C would copy them); dragging over the header of a message does not collapse it; "Select all" of the text menu stays inside the header line / the body.
// The mail itself is a frame (its own document, its own selection) and is not in this test. The rules as text: scripts/test-user-select.mjs.
//   node scripts/test-user-select-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness, inputs } from './cdp-harness.mjs';

const H = await startHarness('test-user-select-ui', { vitePort0: 5260 });
const { evaluate, cdp } = H;
const { clickAt } = inputs(H, null, 'user-select');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const sel = () => evaluate(`(() => { const s = window.getSelection(); const a = document.activeElement; const inField = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.selectionEnd > a.selectionStart ? a.value.slice(a.selectionStart, a.selectionEnd) : ''; return (s.toString() + inField).trim(); })()`);
const clear = () => evaluate(`window.getSelection().removeAllRanges(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); 1`);
const centre = (selector, which = 0) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${which}]; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + Math.min(10, r.width / 2)), Math.round(r.top + r.height / 2)]; })()`);
const multi = async (x, y, n) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= n; i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
  }
  await sleep(120);
};
const dbl = (x, y) => multi(x, y, 2);
const triple = (x, y) => multi(x, y, 3);
const reopen = async () => { await evaluate(`window.__store.getState().openCompose(null, { restore: false }); window.__store.getState().setDialog(null); window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`); await waitFor(`!!document.querySelector('[data-thread=t1]')`); await evaluate(`window.__store.getState().select('t1'); 1`); assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open .rp-from b') && !!document.querySelector('.rp-head h2')`), 'the conversation did not open: ' + await evaluate(`(() => { const s = window.__store.getState(); return JSON.stringify({ folder: s.folder, acct: s.accountId, selected: s.selected, msgs: s.messages.length, threads: s.threads.length, compose: !!s.compose, pane: (document.querySelector('.reading-pane') || document.querySelector('main') || document.body).outerHTML.slice(0, 400), module: s.module, dialog: !!s.dialog }); })()`)); await sleep(300); };
const selectedAfter = async (selector, n = 2, which = 0) => { await clear(); const p = await centre(selector, which); assert.ok(p, `no ${selector}`); await multi(p[0], p[1], n); return sel(); };

try {
  await H.openApp('lang=en', 1280, 800); await cdp('Emulation.setCPUThrottlingRate', { rate: 6 });
  await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
  await waitFor(`document.querySelectorAll('.ml-row').length > 2`);
  await evaluate(`window.__store.getState().select('t1'); 1`);
  assert.ok(await waitFor(`document.querySelectorAll('.rp-msg').length >= 1 && !!document.querySelector('.rp-head h2')`), 'the conversation did not open');
  await sleep(500);

  await check('the page is `none`, the allow list is `text` (computed)', async () => {
    const r = await evaluate(`(() => { const u = (e) => e && getComputedStyle(e).userSelect; return { body: u(document.body), row: u(document.querySelector('.ml-row')), h2: u(document.querySelector('.rp-head h2')), from: u(document.querySelector('.rp-from')), date: u(document.querySelector('.rp-date')), to: u(document.querySelector('.rp-to')), side: u(document.querySelector('.fp-lbl')), search: u(document.querySelector('.topbar input')), toolbar: u(document.querySelector('.rp-tools button')) }; })()`);
    assert.deepEqual(r, { body: 'none', row: 'none', h2: 'text', from: 'text', date: 'text', to: 'text', side: 'none', search: 'text', toolbar: 'none' }, JSON.stringify(r));
  });

  await check('a double-click on a conversation row selects nothing (AC-13.3.1)', async () => {
    assert.equal(await selectedAfter('.ml-row', 2), '');
    assert.equal(await selectedAfter('.ml-row', 3, 1), '');
  });

  await check('a double- and a triple-click on a side-menu folder, the list group header and a toolbar button select nothing (AC-13.3.2)', async () => {
    await reopen();
    assert.equal(await selectedAfter(".rp-tools button[aria-label='Pin']", 2), ''); // (Pin twice: no net change)
    if (await evaluate(`!!document.querySelector('.ml-group')`)) assert.equal(await selectedAfter('.ml-group', 3), '');
    assert.equal(await selectedAfter('.fp-head', 3), '');
    assert.equal(await selectedAfter('.fp-row .fp-lbl', 2), '');
    assert.equal(await selectedAfter('.fp-row .fp-lbl', 3, 1), '');
  });

  await check('the subject, the sender, the recipients and the date of the open message select (AC-13.3.3)', async () => {
    await reopen();
    assert.ok((await selectedAfter('.rp-head h2', 2)).length > 0, 'subject');
    assert.ok((await selectedAfter('.rp-msg.open .rp-from b', 2)).length > 0, 'sender name');
    assert.ok((await selectedAfter('.rp-msg.open .rp-to', 3)).length > 0, 'recipients');
    assert.ok((await selectedAfter('.rp-msg.open .rp-date', 2)).length > 0, 'date');
  });

  await check('dragging over the sender line does not collapse the message (AC-13.3.4)', async () => {
    await reopen();
    const open = await evaluate(`document.querySelectorAll('.rp-msg.open').length`);
    const box = await evaluate(`(() => { const e = document.querySelector('.rp-msg.open .rp-from b'); const r = e.getBoundingClientRect(); return { x0: Math.round(r.left + 2), x1: Math.round(r.right - 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await clear();
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x0, y: box.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x0, y: box.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x1, y: box.y, button: 'left' });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x1, y: box.y, button: 'left', clickCount: 1 });
    await sleep(200);
    assert.ok((await sel()).length > 0, 'the drag selected the name');
    assert.equal(await evaluate(`document.querySelectorAll('.rp-msg.open').length`), open, 'the message collapsed');
    // a plain click on the header (nothing selected) still toggles
    await clear();
    const p = await centre('.rp-msg.open .rp-meta .muted.small', 0);
    await clickAt(p[0], p[1]);
    await sleep(200);
    assert.equal(await evaluate(`document.querySelectorAll('.rp-msg.open').length`), open - 1, 'a plain click on the header no longer toggles');
    await clickAt(p[0], p[1]);
    await sleep(200);
  });

  await check('a text field selects (AC-13.3.6): the search box', async () => {
    await clear();
    await evaluate(`(() => { const i = document.querySelector('.topbar input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); 1; })()`);
    await cdp('Input.insertText', { text: 'invoice march' });
    const p = await centre('.topbar input');
    await dbl(p[0] + 40, p[1]);
    const t = await sel();
    assert.ok(t.length > 0, 'a double-click in the search box selected nothing');
    await evaluate(`window.__store.getState().setSearch('', false); 1`);
  });

  await check('Settings: a label and a hint select nothing, the version line in About selects (AC-13.3.2 / 13.3.3)', async () => {
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'general' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('[role=dialog] .row-label, [role=dialog] label, [role=dialog] .setting-label')`), 'settings did not open');
    const lab = await evaluate(`(() => { const e = document.querySelector('[role=dialog] .row-label, [role=dialog] .setting-label, [role=dialog] label'); return getComputedStyle(e).userSelect; })()`);
    assert.equal(lab, 'none');
    assert.equal(await selectedAfter('[role=dialog] .row-label, [role=dialog] .setting-label, [role=dialog] label', 3), '');
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'about' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.update-status b.selectable')`), 'About did not open');
    assert.ok((await selectedAfter('.update-status b.selectable', 3)).length > 0, 'the version line');
    await evaluate(`window.__store.getState().setDialog(null); 1`);
  });

  await check('a toast that is not an error selects nothing; the text of an error toast selects (AC-13.3.2 / 13.3.3)', async () => {
    await evaluate(`window.__store.getState().showToast('Archived for the test', undefined, 'success'); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.toast.success .toast-text')`));
    assert.equal(await selectedAfter('.toast.success .toast-text', 3), '');
    await evaluate(`window.__store.getState().showToast('Something failed with code E-4711', undefined, 'error'); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.toast.error .toast-text')`));
    const t = await selectedAfter('.toast.error .toast-text', 3);
    assert.ok(/E-4711/.test(t), `the error text: "${t}"`);
  });

  await check('the compose body and the recipient field select as before (AC-13.3.6)', async () => {
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: 'Hello select', bodyHtml: '<p>alpha bravo charlie</p>' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')`, 10000), 'compose did not open');
    await sleep(500);
    const u = await evaluate(`getComputedStyle(document.querySelector('.cp-editor .tiptap')).userSelect`);
    assert.equal(u, 'text');
    assert.ok((await selectedAfter('.cp-editor .tiptap p:nth-of-type(2)', 2)).length > 0, 'a word of the body');
    const subj = await evaluate(`getComputedStyle(document.querySelector('.compose-pane input[type=text], .compose-pane input:not([type])')).userSelect`);
    assert.equal(subj, 'text');
    await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  });

  await check('"Select all" of the text menu reaches the line under the pointer, not the page (REQ-13.3.4)', async () => {
    await reopen();
    const r = await evaluate(`(async () => {
      const m = await import('/src/contextPolicy.ts');
      const el = document.querySelector('.rp-msg.open .rp-from b');
      const scope = el.closest(m.SELECT_SCOPE);
      const date = document.querySelector('.rp-msg.open .rp-date').closest(m.SELECT_SCOPE);
      const subj = document.querySelector('.rp-head h2').closest(m.SELECT_SCOPE);
      return { from: scope.className, date: date.className, subj: subj.tagName };
    })()`);
    assert.ok(/rp-from/.test(r.from) && /rp-date/.test(r.date) && r.subj === 'H2', JSON.stringify(r));
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-user-select-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-user-select-ui: ok');
