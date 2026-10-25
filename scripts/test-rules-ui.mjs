#!/usr/bin/env node
// 1.0.8 Mail rules (spec-108-mail-rules.md): "Create rule…" from a message and the rule dialog, Settings > Rules, the entry points, Run now and Undo. The dev preview with the mock backend
// (`#rules` adds the fixture conversations: twelve from Deals <deals@shop.example>, three from news@shop.example); CDP only, no real input device. Port hint 5820.
//   node scripts/test-rules-ui.mjs [--require-browser] [--shots=<dir>]
import assert from 'node:assert/strict';
import path from 'node:path';
import { arg, sleep, startHarness, languageJs, inputs } from './cdp-harness.mjs';

const failures = [];
const H = await startHarness('test-rules-ui', { vitePort0: 5820 });
const { evaluate, cdp } = H;
const SHOTS = arg('shots');
const { press, shot } = inputs(H, SHOTS ? path.resolve(SHOTS) : null, 'rules');
const ONLY = arg('only') ? new RegExp(arg('only')) : null;
const QUICK = process.argv.includes('--quick');
const check = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  const t0 = Date.now();
  try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); } catch (e) { console.log(`FAIL ${name}`); failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); }
};
const waitFor = async (js, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const S = (p) => `window.__store.getState().${p}`;
const openApp = (hash = 'rules&lang=en', w = 1280, h = 800) => H.openApp(hash, w, h);
const J = JSON.stringify;

const rightClick = async (x, y) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(150);
};
const centre = (sel) => evaluate(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
const menu = () => evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((e) => ({ text: e.querySelector('.menu-lbl').textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true', title: e.getAttribute('title') || '' }))`);
const clickMenu = (start) => evaluate(`(() => { const e = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((x) => x.querySelector('.menu-lbl').textContent.trim().startsWith(${J(start)})); if (!e) return false; e.click(); return true; })()`);
const row = (id) => `[data-thread="${id}"]`;
const toasts = () => evaluate(`[...document.querySelectorAll('.toast')].map((t) => ({ text: (t.querySelector('.toast-text') || {}).textContent, undo: !!t.querySelector('.toast-undo') }))`);

/** What the rule dialog shows. */
const dlg = () => evaluate(`(() => {
  const d = document.querySelector('[role=dialog] .rd-form'); if (!d) return null;
  const title = d.closest('[role=dialog]').querySelector('.modal-head b').textContent;
  const rows = [...d.querySelectorAll('.rd-row')].map((r) => { const s = [...r.querySelectorAll('select')]; const i = r.querySelector('input:not([type=checkbox])'); return { on: r.querySelector('input[type=checkbox]').checked, field: s[0].value, op: s[1] ? s[1].value : 'static', text: i.value }; });
  const links = [...d.querySelectorAll('.rd-link')].map((x) => x.textContent);
  const chips = [...d.querySelectorAll('.rd-chips .sb-chip')].map((x) => ({ text: x.textContent, on: x.getAttribute('aria-pressed') === 'true' }));
  const folder = d.querySelector('select[aria-label="Target folder"]');
  const now = d.querySelector('.rd-now');
  const ae = document.activeElement;
  return { title, rows, links, chips, noChips: !!d.querySelector('.rd-chips:not([role=group])'), name: d.querySelector('#rd-name').value, account: d.querySelector('#rd-account').value,
    action: d.querySelector('select[aria-label="Rule action"]').value, folder: folder ? folder.value : null, folderOpts: folder ? [...folder.options].map((o) => o.textContent) : [],
    now: now ? now.textContent.trim() : null, nowChecked: now && now.querySelector('input') ? now.querySelector('input').checked : null,
    focus: ae ? (ae.getAttribute('aria-label') || ae.id || ae.tagName) : null, err: [...d.querySelectorAll('[role=alert]')].map((x) => x.textContent), saveBusy: !!d.querySelector('.rd-actions .btn.primary[aria-busy]'),
    overflow: d.scrollWidth > d.clientWidth + 1 };
})()`);
const setSelect = (sel, value) => evaluate(`(() => { const e = document.querySelector(${J(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${J(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
const typeInto = async (sel, text) => {
  await evaluate(`(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select(); return 1; })()`);
  await cdp('Input.insertText', { text });
  await sleep(60);
};
const clickEl = (sel) => evaluate(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return false; e.click(); return true; })()`);
const openRuleFrom = async (id) => {
  const p = await centre(row(id));
  await rightClick(p[0], p[1]);
  assert.ok(await clickMenu('Create rule'), 'no "Create rule…" in the menu');
  assert.ok(await waitFor(`!!document.querySelector('.rd-form')`), 'the rule dialog did not open');
  await sleep(450); // the count
};
const closeDialog = async () => { await evaluate(`${S('setDialog')}(null); 1`); await sleep(150); };
const savedRules = () => evaluate(`window.__mockRuleSaves || []`);

try {
  await openApp();
  await evaluate(`${S('setView')}('inbox', 'a1').then(() => 1)`);
  await sleep(300);

  await check('AC-2.1 the row menu: Create rule… after Move to Junk, before the copy entries; off for several conversations and in Drafts', async () => {
    const p = await centre(row('tdeals'));
    await rightClick(p[0], p[1]);
    const m = await menu();
    const names = m.map((x) => x.text);
    const at = names.indexOf('Create rule…');
    assert.ok(at > 0, `no Create rule…: ${names}`);
    assert.equal(names[at - 1], 'Move to Junk');
    assert.equal(names[at + 1], 'Copy sender email');
    assert.equal(m[at].disabled, false);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
    await sleep(100);
    // two conversations checked: off with the existing hint
    await evaluate(`${S('setChecked')}(['tdeals', 'tacme']); 1`);
    await sleep(100);
    const q = await centre(row('tdeals'));
    await rightClick(q[0], q[1]);
    const m2 = await menu();
    const it = m2.find((x) => x.text === 'Create rule…');
    assert.ok(it && it.disabled, 'disabled for two conversations');
    assert.equal(it.title, 'Available for one conversation at a time');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); ${S('setChecked')}([]); 1`);
    await sleep(100);
  });

  await check('AC-3.1 the dialog from a message: sender checked and exact, the subject core unchecked, the name, the focus on the folder', async () => {
    await openRuleFrom('tdeals');
    const d = await dlg();
    assert.equal(d.title, 'Create rule');
    assert.deepEqual(d.rows[0], { on: true, field: 'from', op: 'equals', text: 'deals@shop.example' });
    assert.deepEqual(d.rows[1], { on: false, field: 'subject', op: 'contains', text: 'Your order' });
    assert.deepEqual(d.rows[2], { on: false, field: 'subjectBody', op: 'static', text: '' });
    assert.deepEqual(d.links, ['Any address at shop.example']);
    assert.equal(d.name, 'Mail from Deals');
    assert.equal(d.account, 'a1');
    assert.equal(d.action, 'move');
    assert.equal(d.focus, 'Target folder', 'the focus starts on the one thing to choose');
    assert.ok(d.chips.length >= 3, `chips: ${J(d.chips)}`);
    assert.equal(d.overflow, false);
    await shot('create-from-message');
    await closeDialog();
  });

  await check('AC-3.2 / 3.3 the domain switch and back; no switch for a public domain or my own mailbox', async () => {
    await openRuleFrom('tdeals');
    assert.ok(await clickEl('.rd-link'));
    await sleep(100);
    let d = await dlg();
    assert.deepEqual(d.rows[0], { on: true, field: 'from', op: 'contains', text: '@shop.example' });
    assert.deepEqual(d.links, ['Only deals@shop.example']);
    assert.equal(d.name, 'Mail from @shop.example');
    assert.ok(await clickEl('.rd-link'));
    await sleep(100);
    d = await dlg();
    assert.deepEqual(d.rows[0], { on: true, field: 'from', op: 'equals', text: 'deals@shop.example' });
    assert.equal(d.name, 'Mail from Deals');
    await closeDialog();
    // a source from a public domain and one of my own mailboxes
    for (const [email, mine] of [['x@gmail.com', false], ['nam@example.com', true]]) {
      await evaluate(`${S('setDialog')}({ type: 'rule', source: { accountId: 'a1', folder: 'inbox', fromName: 'X', fromEmail: ${J(email)}, subject: 'Hello there', text: 'hello', mine: ${mine} } }); 1`);
      assert.ok(await waitFor(`!!document.querySelector('.rd-form')`));
      await sleep(200);
      assert.deepEqual((await dlg()).links, [], `no domain switch for ${email}`);
      await closeDialog();
    }
  });

  await check('AC-3.5 / 3.6 the chips are invoice, Acme, payment; they toggle and fill the words row', async () => {
    await openRuleFrom('tacme');
    let d = await dlg();
    assert.deepEqual(d.chips.map((c) => c.text), ['invoice', 'Acme', 'payment']);
    await evaluate(`[...document.querySelectorAll('.rd-chips .sb-chip')][0].click(); 1`);
    await sleep(60);
    await evaluate(`[...document.querySelectorAll('.rd-chips .sb-chip')][1].click(); 1`);
    await sleep(60);
    d = await dlg();
    assert.deepEqual(d.rows[2], { on: true, field: 'subjectBody', op: 'static', text: 'invoice, Acme' });
    assert.deepEqual(d.chips.map((c) => c.on), [true, true, false]);
    await evaluate(`[...document.querySelectorAll('.rd-chips .sb-chip')][0].click(); 1`);
    await sleep(60);
    assert.equal((await dlg()).rows[2].text, 'Acme');
    await evaluate(`[...document.querySelectorAll('.rd-chips .sb-chip')][1].click(); 1`);
    await sleep(60);
    d = await dlg();
    assert.deepEqual(d.rows[2], { on: false, field: 'subjectBody', op: 'static', text: '' });
    await closeDialog();
  });

  await check('AC-3.4 the subject row: "is exactly" shows the whole subject, "contains" brings the core back', async () => {
    await openRuleFrom('tdeals');
    await setSelect('.rd-row:nth-child(1) select[aria-label="Rule condition"]', 'equals');
    // (the second row is the subject row)
    const sel = '.rd-item:nth-child(2) select[aria-label="Rule condition"]';
    await setSelect(sel, 'equals');
    await sleep(80);
    assert.equal((await dlg()).rows[1].text, '[Shop] Your order #48213 shipped on 2026-10-24');
    await setSelect(sel, 'contains');
    await sleep(80);
    assert.equal((await dlg()).rows[1].text, 'Your order');
    await closeDialog();
  });

  await check('AC-3.8 validation: no folder, no condition; Esc cancels; Enter in a field does nothing', async () => {
    await openRuleFrom('tdeals');
    await clickEl('.rd-actions .btn.primary');
    await sleep(120);
    let d = await dlg();
    assert.deepEqual(d.err, ['Choose where to move the mail.']);
    assert.equal(d.focus, 'Target folder');
    // uncheck every row
    await evaluate(`document.querySelector('.rd-row input[type=checkbox]').click(); 1`);
    await sleep(80);
    await clickEl('.rd-actions .btn.primary');
    await sleep(120);
    d = await dlg();
    assert.ok(d.err.includes('Add at least one condition with a value.'), J(d.err));
    assert.equal((await savedRules()).length, 0, 'nothing was saved');
    // Enter in a text field does nothing
    await evaluate(`document.querySelector('.rd-row input:not([type=checkbox])').focus(); 1`);
    await press('Enter', 'Enter');
    await sleep(100);
    assert.ok(await dlg(), 'still open');
    await press('Escape', 'Escape');
    await sleep(150);
    assert.equal(await dlg(), null, 'Esc closed it');
    assert.equal((await savedRules()).length, 0);
  });

  await check('AC-4.1 / 4.2 the folder picker: Archive, Junk, Deleted Items, the folders in tree order, New folder… last; no Inbox / Drafts / Sent', async () => {
    await openRuleFrom('tdeals');
    const d = await dlg();
    assert.deepEqual(d.folderOpts.slice(0, 4), ['Choose folder', 'Archive', 'Junk Email', 'Deleted Items']);
    assert.equal(d.folderOpts[d.folderOpts.length - 1], 'New folder…');
    assert.ok(!d.folderOpts.some((o) => /^(Inbox|Drafts|Sent)$/.test(o)), J(d.folderOpts));
    assert.ok(d.folderOpts.some((o) => o.startsWith('— Hey Look') || o === 'Hey Look' || o.includes('Projects')), J(d.folderOpts));
    // New folder…: the folder dialog on top; Esc closes only it; creating it selects it
    await setSelect('select[aria-label="Target folder"]', '__new__');
    assert.ok(await waitFor(`document.querySelectorAll('[role=dialog]').length === 2`), 'the New folder dialog');
    await press('Escape', 'Escape');
    await sleep(200);
    assert.equal(await evaluate(`document.querySelectorAll('[role=dialog]').length`), 1, 'Esc closed only the New folder dialog');
    assert.ok((await dlg()).rows[0].text === 'deals@shop.example', 'the rule dialog kept everything');
    await setSelect('select[aria-label="Target folder"]', '__new__');
    assert.ok(await waitFor(`document.querySelectorAll('[role=dialog]').length === 2`));
    await evaluate(`(() => { const i = document.getElementById('fd-name'); i.focus(); return 1; })()`);
    await cdp('Input.insertText', { text: 'Newsletters' });
    await press('Enter', 'Enter');
    assert.ok(await waitFor(`document.querySelectorAll('[role=dialog]').length === 1`), 'the New folder dialog closed');
    await sleep(200);
    const e = await dlg();
    assert.equal(e.folder, 'f:Newsletters', 'the new folder is selected');
    assert.equal(e.focus, 'Target folder', 'the focus is back on the picker');
    await closeDialog();
  });

  await check('AC-7.1 / 3.10 save with "also move": the rule is stored, 12 leave the list, a toast with Undo, Undo brings them back', async () => {
    await openApp();
    await evaluate(`${S('setView')}('inbox', 'a1').then(() => 1)`);
    await sleep(300);
    const before = await evaluate(`${S('threads')}.length`);
    await openRuleFrom('tdeals');
    await setSelect('select[aria-label="Target folder"]', 'archive');
    await sleep(700);
    const d = await dlg();
    assert.equal(d.now, 'Also move the 12 matching messages already in Inbox');
    assert.equal(d.nowChecked, true, 'on by default when made from a message');
    await clickEl('.rd-actions .btn.primary');
    assert.ok(await waitFor(`!document.querySelector('.rd-form')`), 'the dialog closed');
    await sleep(500);
    const saved = await savedRules();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Mail from Deals');
    assert.deepEqual(saved[0].conditions, [{ field: 'from', op: 'equals', values: ['deals@shop.example'] }]);
    assert.equal(saved[0].action, 'move');
    assert.equal(saved[0].arg, 'archive');
    assert.equal(saved[0].accountId, 'a1');
    assert.equal(await evaluate(`${S('threads')}.length`), before - 12, 'the twelve left the list');
    const t = await toasts();
    assert.ok(t.some((x) => x.text === 'Rule saved'), J(t));
    const moved = t.find((x) => /^Rule “Mail from Deals”: moved 12 messages to Archive$/.test(x.text || ''));
    assert.ok(moved && moved.undo, J(t));
    await evaluate(`[...document.querySelectorAll('.toast')].find((t) => /moved 12/.test(t.textContent)).querySelector('.toast-undo').click(); 1`);
    await sleep(600);
    assert.equal(await evaluate(`${S('threads')}.length`), before, 'Undo: all twelve are back');
  });

  await check('BUG-1 Save right after the folder change (the count is still loading) still moves the 12', async () => {
    await openApp();
    await evaluate(`${S('setView')}('inbox', 'a1').then(() => 1)`);
    await sleep(300);
    const before = await evaluate(`${S('threads')}.length`);
    await openRuleFrom('tdeals');
    // the folder is chosen and Save is pressed 50 ms later: the count that the change restarted (400 ms debounce, then the answer) has not come back
    await setSelect('select[aria-label="Target folder"]', 'archive');
    await sleep(50);
    const state = await evaluate(`(() => { const label = document.querySelector('.rd-now'); const text = label ? label.textContent.trim() : null; document.querySelector('.rd-actions .btn.primary').click(); return text; })()`);
    assert.ok(state === null || !/\b12\b/.test(state), `the label had no count yet: ${state}`);
    assert.ok(await waitFor(`!document.querySelector('.rd-form')`), 'the dialog closed');
    assert.ok(await waitFor(`${S('threads')}.length === ${before - 12}`, 6000), 'the twelve left the list although the count was still loading');
    const t = await toasts();
    assert.ok(t.some((x) => /moved 12 messages to Archive/.test(x.text || '') && x.undo), J(t));
  });

  await check('AC-7.2 the count follows the condition (the domain form counts the 3 more from news@shop.example)', async () => {
    await openApp();
    await evaluate(`${S('setView')}('inbox', 'a1').then(() => 1)`);
    await sleep(300);
    await openRuleFrom('tdeals');
    assert.ok(await clickEl('.rd-link'));
    await sleep(900);
    const d = await dlg();
    assert.equal(d.now, 'Also move the 15 matching messages already in Inbox');
    await closeDialog();
  });

  await check('AC-10.1 Settings > Rules: list, Edit, Move up, Run now, Delete; the section is called Rules', async () => {
    await openApp('rules&lang=en');
    await evaluate(`${S('setDialog')}({ type: 'settings', tab: 'mb:all', section: 'filters', nonce: 1 }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.list-row')`), 'the rules list');
    await sleep(300);
    const info = await evaluate(`(() => ({ rows: [...document.querySelectorAll('.list-row')].map((r) => ({ title: r.querySelector('.lr-title').textContent, btns: [...r.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent) })), nav: [...document.querySelectorAll('nav button')].map((b) => b.textContent) }))()`);
    assert.ok(info.nav.includes('Rules'), J(info.nav));
    assert.equal(info.rows[0].title, 'Move newsletters');
    assert.deepEqual(info.rows[0].btns, ['Move up', 'Move down', 'Run now', 'Delete']);
    // Move down on the first row swaps the two
    await evaluate(`document.querySelector('.list-row button[aria-label="Move down"]').click(); 1`);
    await sleep(300);
    assert.notEqual(await evaluate(`document.querySelector('.list-row .lr-title').textContent`), 'Move newsletters');
    await evaluate(`document.querySelectorAll('.list-row')[1].querySelector('button[aria-label="Move up"]').click(); 1`);
    await sleep(300);
    assert.equal(await evaluate(`document.querySelector('.list-row .lr-title').textContent`), 'Move newsletters');
    // Run now with no match: the info toast, no question
    await evaluate(`[...document.querySelectorAll('.list-row')[0].querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Run now').click(); 1`);
    await sleep(500);
    assert.ok((await toasts()).some((x) => x.text === 'No messages in the Inbox match this rule.'), J(await toasts()));
    // New rule opens the dialog with one empty From row, no chips, no domain switch
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New rule').click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.rd-form')`));
    await sleep(300);
    const d = await dlg();
    assert.equal(d.title, 'Create rule');
    assert.deepEqual(d.rows, [{ on: true, field: 'from', op: 'contains', text: '' }]);
    assert.deepEqual(d.links, []);
    assert.equal(d.chips.length, 0);
    assert.equal(d.focus, 'Rule text', 'from Settings the focus starts on the first field');
    assert.equal(d.nowChecked, null, 'nothing to count yet');
    // Esc closes only the rule dialog, Settings stays
    await press('Escape', 'Escape');
    await sleep(200);
    assert.equal(await dlg(), null);
    assert.ok(await evaluate(`!!document.querySelector('.list-row')`), 'Settings is still open');
    await shot('settings-rules');
  });

  await check('REQ-8 the mailbox heading menu and the command bar open Settings > Rules', async () => {
    await openApp('rules&lang=en');
    await evaluate(`${S('setView')}('inbox', 'a1').then(() => 1)`);
    await sleep(300);
    const p = await centre('.fp-group[data-reorder-id="a1"] .fp-head');
    await rightClick(p[0], p[1]);
    assert.deepEqual((await menu()).map((m) => m.text), ['Move up', 'Move down', 'New folder…', 'Manage rules…']);
    assert.ok(await clickMenu('Manage rules'));
    assert.ok(await waitFor(`!!document.querySelector('.list-row') || !!document.querySelector('.muted.pad')`), 'Settings opened on the rules');
    await sleep(300);
    assert.equal(await evaluate(`(document.querySelector('nav button.active, nav button[aria-current=page].sub') || {}).textContent || ''`).then((x) => x.includes('nam@example.com') || x.includes('Rules')), true);
    await closeDialog();
    // the command bar: Manage rules; Create rule from this message only with a conversation open
    await evaluate(`${S('setCommandOpen')}(true); 1`);
    await sleep(150);
    const cmds = async (q) => { await evaluate(`(() => { const i = document.querySelector('.modal.cmd input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${J(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`); await sleep(80); return evaluate(`[...document.querySelectorAll('.modal.cmd .menu-row')].map((r) => r.textContent.trim())`); };
    assert.deepEqual(await cmds('rule'), ['Manage rules']);
    await evaluate(`${S('setCommandOpen')}(false); 1`);
    await evaluate(`${S('select')}('tdeals').then(() => 1)`);
    await sleep(600);
    await evaluate(`${S('setCommandOpen')}(true); 1`);
    await sleep(150);
    assert.deepEqual(await cmds('rule'), ['Manage rules', 'Create rule from this message']);
    await evaluate(`document.querySelectorAll('.modal.cmd .menu-row')[1].click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.rd-form')`), 'the dialog opened from the command bar');
    await sleep(300);
    assert.equal((await dlg()).rows[0].text, 'deals@shop.example');
    await closeDialog();
  });

  await check('AC-2.2 the reading pane More actions: Create rule… for that message', async () => {
    await openApp('rules&lang=en');
    await evaluate(`${S('setView')}('inbox', 'a1').then(() => 1)`);
    await evaluate(`${S('select')}('tdeals').then(() => 1)`);
    await sleep(700);
    await evaluate(`(() => { const b = document.querySelector('.rp-msg-actions button[aria-label="More actions"], .rp-msg-actions .icon-btn[title="More actions"]'); b.click(); return 1; })()`);
    await sleep(150);
    const items = await evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((e) => e.textContent.trim())`);
    const at = items.indexOf('Create rule…');
    assert.ok(at > 0 && items[at - 1] === 'Copy sender email', J(items));
    await evaluate(`[...document.querySelectorAll('[role=menu] [role=menuitem]')][${at}].click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.rd-form')`));
    await sleep(300);
    assert.equal((await dlg()).rows[0].text, 'deals@shop.example');
    await closeDialog();
  });

  await check('a confidential message and an HTML-only one: no chips / chips from its text', async () => {
    await openRuleFrom('tdealsconf');
    let d = await dlg();
    assert.equal(d.chips.length, 0);
    assert.equal(d.noChips, true, 'the "No suggested words" line');
    assert.equal(d.rows[0].text, 'board@corp.example');
    await closeDialog();
    await openRuleFrom('tdealshtml');
    d = await dlg();
    assert.ok(d.chips.some((c) => c.text.toLowerCase() === 'gutscheine'), J(d.chips));
    await closeDialog();
  });

  // ---------------------------------------------------------------- layout: de, fr, ru and en at 960x560 and 1280x800, light and dark; the narrow 375 px
  const LAYOUTS = QUICK ? [['en', 'light'], ['de', 'light'], ['ru', 'dark']] : [['en', 'light'], ['de', 'light'], ['fr', 'dark'], ['ru', 'dark'], ['vi', 'light'], ['ja', 'light'], ['zh-Hans', 'dark'], ['es', 'light']];
  for (const [lang, theme] of LAYOUTS) {
    for (const [w, h] of QUICK ? [[960, 560], [375, 700]] : [[960, 560], [1280, 800], [375, 700]]) {
      await check(`layout ${lang} ${theme} ${w}x${h}: nothing clipped, the dialog and the menu fit`, async () => {
        await openApp(`rules&lang=${lang}`, w, h);
        await evaluate(`${S('setPrefs')}({ theme: ${J(theme)} }); ${S('setView')}('inbox', 'a1').then(() => 1)`);
        await sleep(400);
        const p = await centre(row('tdeals'));
        await rightClick(p[0], p[1]);
        const menuBox = await evaluate(`(() => { const m = document.querySelector('[role=menu]'); if (!m) return null; const r = m.getBoundingClientRect(); const bad = [...m.querySelectorAll('.menu-lbl')].filter((l) => l.scrollWidth > l.clientWidth + 1).map((l) => l.textContent); return { inView: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, bad }; })()`);
        assert.ok(menuBox && menuBox.inView, `the menu is in the window ${J(menuBox)}`);
        assert.deepEqual(menuBox.bad, [], 'no clipped menu label');
        const items = await menu();
        assert.ok(items.length >= 15, `${items.length} items`);
        // click the rule entry by position: the 4th of the group before the last divider pair = index of "Create rule" (the one before the last two items)
        await evaluate(`(() => { const e = [...document.querySelectorAll('[role=menu] [role=menuitem]')]; e[e.length - 3].click(); return 1; })()`);
        assert.ok(await waitFor(`!!document.querySelector('.rd-form')`), 'the rule dialog opened');
        await sleep(500);
        const lay = await evaluate(`(() => {
          const d = document.querySelector('.rd-form'); const m = d.closest('.modal'); const r = m.getBoundingClientRect();
          const clip = [...d.querySelectorAll('label, .rd-head, .sb-chip, .rd-link, .rd-now span, .btn, option, .muted')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible' && e.tagName !== 'OPTION').map((e) => e.textContent.trim().slice(0, 40));
          const wide = [...d.querySelectorAll('select')].filter((s) => s.scrollWidth > s.clientWidth + 1).length;
          const chipLines = [...d.querySelectorAll('.rd-now span')].map((s) => Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight || '20')));
          return { fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1, hscroll: d.scrollWidth > d.clientWidth + 1 || m.scrollWidth > m.clientWidth + 1, clip, chipLines, bodyScroll: document.documentElement.scrollWidth > innerWidth + 1 };
        })()`);
        assert.ok(lay.fits, `the dialog is inside the window ${J(lay)}`);
        assert.equal(lay.hscroll, false, 'no horizontal scroll in the dialog');
        assert.deepEqual(lay.clip, [], `clipped: ${J(lay.clip)}`);
        assert.ok(lay.chipLines.every((n) => n <= 3), `the "also move" label is at most 3 lines ${J(lay.chipLines)}`);
        if (w === 960 && h === 560 && (lang === 'de' || lang === 'ru')) await shot(`dialog-${lang}-${theme}`);
        await closeDialog();
      });
    }
  }
} finally {
  await H.shutdown();
}

if (failures.length) {
  console.error(`test-rules-ui: ${failures.length} FAILED\n- ` + failures.join('\n- '));
  process.exit(1);
}
console.log('test-rules-ui: ok');
