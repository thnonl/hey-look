#!/usr/bin/env node
// The unread numbers on the Focused / Other tabs (1.0.7 W13.12) and Count Other (W13.11), in the real app in the dev preview (mock backend, #smallmailbox).
//   - AC-13.12.1/.2: the tab text, `aria-label` ("Focused, 8 unread") and tooltip ("8 unread") equal the conversations in bold in that tab;
//   - AC-13.12.3: mark read / unread through the hover button, the key U and the context menu's action: the number changes within 300 ms (the optimistic
//     change), the other tab does not move;
//   - AC-13.12.6: Other read to 0: no badge, no aria-label, no title, the tab is as narrow as its label;
//   - AC-13.12.7: `#tabcounts=150,1234`: "99+", the exact number in the name and the tooltip;
//   - AC-13.12.11/.12/.13: search typed, Focused Inbox off, another folder: no tabs, and they come back with the numbers;
//   - AC-13.12.15: Tab order Focused, Other, Filter with real key events, the number is never focused, Enter switches the tab;
//   - AC-13.12.16 layout: 960 x 480 (and 960 x 560, 1280 x 800 with --full), the list at its minimum width, Filter = Unread, `99+` on both tabs: one row, no
//     clip, the label on one line, the number inside the list; when the whole Filter does not fit it is its icon only, with the full text as tooltip and name;
//   - AC-13.12.17 look: colour and weight of the Inbox number of the side menu (Focused) and the muted colour (Other), 0.86 x font size, tabular digits, baseline
//     within 1 px, contrast >= 4.5:1 in light and dark for every accent preset;
//   - W13.11: stored old preferences ("countOtherMail":false, no marker) start with the switch on and the marker saved; "off" saved with the marker stays off;
//     the Appearance preview's Inbox number follows the switch and its tabs carry the numbers.
//   node scripts/test-focus-tabs.mjs [--full] [--require-browser] [--url=http://127.0.0.1:1420/]
// Default: en, de, ru, ja at 960 x 480, light and dark. --full: all 8 languages at 960 x 480, 960 x 560 and 1280 x 800.
import assert from 'node:assert/strict';
import { arg, flag, sleep, startHarness } from './cdp-harness.mjs';
import { TABN_JS, verdict } from './lib/tab-number-probe.mjs';

const FULL = flag('full');
const H = await startHarness('test-focus-tabs', { vitePort0: 5400 });
const { evaluate, cdp } = H;
// Font stress (--font=Verdana, --spacing=0.02): a CI machine (Linux, DejaVu Sans) and macOS / Linux WebKit have wider fallback fonts than this Windows PC. The layout
// of the tabs must hold whatever the metrics are, so the whole run can be repeated here with a wider family and/or extra letter spacing (em) on every element.
// --log prints the numbers of the layout cases (widths of the tabs, the Filter, the list).
const FONT = arg('font'), SPACING = arg('spacing'), LOG = flag('log');
if (FONT || SPACING) {
  const css = '*,*::before,*::after{' + (FONT ? 'font-family:' + FONT + '!important;' : '') + (SPACING ? 'letter-spacing:' + SPACING + 'em!important;' : '') + '}';
  // a constructed sheet: the page's CSP blocks an inline <style>
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const sh = new CSSStyleSheet(); sh.replaceSync(${JSON.stringify(css)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; })()` });
}
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(50); } return false; };
const S = (js) => `window.__store.getState().${js}`;

const tabs = () => evaluate(`[...document.querySelectorAll('.pivots [role=tab]')].map((t) => ({ text: t.textContent.trim(), badge: t.querySelector('.fp-badge')?.textContent ?? null, aria: t.getAttribute('aria-label'), title: t.getAttribute('title'), selected: t.getAttribute('aria-selected'), width: t.getBoundingClientRect().width, focusable: t.tabIndex >= 0 }))`);
const folderNums = (acct = 'a1') => evaluate(`(() => { const f = ${S('folders')}.find((x) => x.accountId === ${JSON.stringify(acct)} && x.key === 'inbox'); return { focused: f.unreadFocused, other: f.unreadOther }; })()`);
const unreadRows = () => evaluate(`${S('threads')}.filter((t) => t.unread > 0).length`);
const idle = () => waitFor(`!${S('loading')} && !!document.querySelector('.pivots')`, 10000);
const openTab = async (which) => { await evaluate(`[...document.querySelectorAll('.pivots [role=tab]')][${which === 'focused' ? 0 : 1}].click()`); await sleep(120); await idle(); await sleep(150); };
const num = (t) => (t.badge === null ? 0 : Number(t.badge.replace('+', '')));

async function fresh(hash = '', w = 1280, h = 800) {
  await H.openApp('lang=en&smallmailbox' + (hash ? '&' + hash : ''), w, h);
  await waitFor(`${S('folders')}.some((f) => f.key === 'inbox' && f.unreadFocused !== undefined)`, 15000);
  await idle();
  await sleep(300);
}

const contrast = (a, b) => {
  const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = ([r, g, bl]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
  const [la, lb] = [lum(rgb(a)), lum(rgb(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

try {
  // ---------------------------------------------------------------- the numbers equal the bold rows (AC-13.12.1, .2)
  await fresh();
  await check('AC-13.12.1/.2 text, name and tooltip equal the conversations in bold of the tab', async () => {
    const f = await folderNums();
    for (const [i, which] of ['focused', 'other'].entries()) {
      await openTab(which);
      const t = (await tabs())[i];
      const n = f[which];
      assert.ok(n > 0, `the mock has unread mail for ${which}`);
      assert.equal(await unreadRows(), n, `${which}: bold rows`);
      const name = which === 'focused' ? 'Focused' : 'Other';
      assert.equal(t.badge, n > 99 ? '99+' : String(n));
      assert.equal(t.aria, `${name}, ${n} unread`);
      assert.equal(t.title, `${n} unread`);
      assert.equal(t.text, `${name}${t.badge}`);
      assert.equal(t.selected, 'true');
    }
    // the number and the badge classes (aria-hidden, strong for Focused only)
    assert.equal(await evaluate(`[...document.querySelectorAll('.pivots .fp-badge')].map((b) => b.className + '|' + b.getAttribute('aria-hidden')).join(',')`), 'fp-badge strong|true,fp-badge |true');
  });

  // ---------------------------------------------------------------- live: mark read / unread (AC-13.12.3)
  await check('AC-13.12.3 hover button: the number changes within 300 ms and Other does not move', async () => {
    await evaluate(`${S('setPrefs')}({ hoverActions: ['read', 'archive'] })`);
    await openTab('focused');
    const before = await folderNums();
    const row = await evaluate(`${S('threads')}.find((t) => t.unread > 0).threadId`);
    const n0 = num((await tabs())[0]);
    assert.equal(n0, before.focused);
    await evaluate(`document.querySelector('[data-thread="${row}"] .hover-actions button[aria-label="Mark as read"]').click()`);
    await sleep(120);
    let t = await tabs();
    assert.equal(num(t[0]), n0 - 1, 'Focused went down at once');
    assert.equal(num(t[1]), before.other, 'Other did not move');
    assert.equal(t[0].aria, `Focused, ${n0 - 1} unread`);
    // and back: the hover button now says "Mark as unread"
    await evaluate(`document.querySelector('[data-thread="${row}"] .hover-actions button[aria-label="Mark as unread"]').click()`);
    await sleep(120);
    t = await tabs();
    assert.equal(num(t[0]), n0, 'marked unread again');
    assert.equal(num(t[1]), before.other);
  });
  await check('AC-13.12.3 (the key U) the number goes up by one', async () => {
    await fresh();
    await evaluate(`${S('setPrefs')}({ hoverActions: ['read'] })`);
    await openTab('focused');
    const n0 = num((await tabs())[0]);
    const readRow = await evaluate(`${S('threads')}.find((t) => t.unread === 0)?.threadId`);
    assert.ok(readRow, 'a read conversation in the tab');
    await evaluate(`${S('setChecked')}([${JSON.stringify(readRow)}]); document.activeElement && document.activeElement.blur(); 1`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'u', code: 'KeyU', text: 'u' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU' });
    await sleep(150);
    assert.equal(num((await tabs())[0]), n0 + 1);
  });
  await check('AC-13.12.3 the same through the app\'s action (context menu, notification button, reader window)', async () => {
    await fresh();
    await openTab('focused');
    const n0 = num((await tabs())[0]);
    const row = await evaluate(`${S('threads')}.find((t) => t.unread > 0).threadId`);
    await evaluate(`${S('act')}([${JSON.stringify(row)}], 'read'); 1`);
    await sleep(120);
    assert.equal(num((await tabs())[0]), n0 - 1);
    await sleep(900);
    assert.equal(num((await tabs())[0]), n0 - 1, 'the refresh after the call confirms the number');
  });

  // ---------------------------------------------------------------- Other read to zero (AC-13.12.6)
  await check('AC-13.12.6 Other read to 0: no badge, no name, no tooltip, as narrow as the label', async () => {
    await fresh();
    await openTab('other');
    const w0 = (await tabs())[1].width;
    await evaluate(`${S('act')}(${S('threads')}.filter((t) => t.unread > 0).map((t) => t.threadId), 'read'); 1`);
    await sleep(1500);
    const t = (await tabs())[1];
    assert.equal(t.badge, null);
    assert.equal(t.aria, null, 'no aria-label left');
    assert.equal(t.title, null, 'no tooltip left');
    assert.equal(t.text, 'Other');
    assert.ok(t.width < w0 - 6, `the tab shrank (${w0} -> ${t.width})`);
    // the width is the label's own: the same as the tab of a mailbox without numbers
    assert.equal(await evaluate(`(() => { const b = document.querySelector('.pivots [role=tab]:nth-child(2)'); return b.scrollWidth <= b.clientWidth; })()`), true);
  });

  // ---------------------------------------------------------------- the Undo window (WP13e decision Q3, fix batch 6)
  // A delete / archive / move hides the row at once and runs on the server after the Undo time. The numbers (tabs, side menu) go with the row, stay down through a
  // refresh in the window (the backend leaves a waiting conversation out of them too; the mock does the same) and come back with Undo.
  await check('Q3 the row, the tab number and the side-menu number go together in the Undo window and come back with Undo', async () => {
    await fresh();
    await openTab('focused');
    const nums = () => evaluate(`(() => { const f = ${S('folders')}.find((x) => x.accountId === 'a1' && x.key === 'inbox'); const t = [...document.querySelectorAll('.pivots .fp-badge')].map((b) => b.textContent); const side = [...document.querySelectorAll('.fp-row')].find((r) => r.querySelector('.fp-badge.strong'))?.querySelector('.fp-badge.strong')?.textContent ?? null; return { state: [f.unread, f.unreadFocused, f.unreadOther], tabs: t, side }; })()`);
    const before = await nums();
    const unreadIds = await evaluate(`${S('threads')}.filter((t) => t.unread > 0).map((t) => t.threadId)`);
    const readId = await evaluate(`${S('threads')}.find((t) => t.unread === 0)?.threadId`);
    assert.ok(unreadIds.length >= 2 && readId, 'the mock has unread and read conversations in Focused');
    // a read conversation leaves: no number moves
    await evaluate(`${S('act')}([${JSON.stringify(readId)}], 'trash', undefined, 'Deleted'); 1`);
    await sleep(250);
    assert.deepEqual(await nums(), before, 'a read conversation changes no number');
    await evaluate(`${S('toasts')}.forEach((t) => t.undo && t.undo()); 1`);
    await sleep(500);
    // an unread one: the three numbers drop at once
    const id = unreadIds[0];
    await evaluate(`${S('act')}([${JSON.stringify(id)}], 'archive', undefined, 'Archived'); 1`);
    await sleep(250);
    const gone = await nums();
    assert.equal(await evaluate(`${S('threads')}.some((t) => t.threadId === ${JSON.stringify(id)})`), false, 'the row is gone');
    assert.deepEqual(gone.state, [before.state[0] - 1, before.state[1] - 1, before.state[2]], `the folder numbers dropped: ${JSON.stringify(before.state)} -> ${JSON.stringify(gone.state)}`);
    assert.equal(gone.tabs[0], String(before.state[1] - 1), 'the Focused tab number dropped');
    assert.equal(gone.tabs[1], String(before.state[2]), 'Other did not move');
    // a refresh inside the Undo window keeps the numbers down (the sync, the 30 s refresh)
    await evaluate(`${S('refresh')}().then(() => 1)`);
    await sleep(400);
    assert.deepEqual((await nums()).state, gone.state, 'a refresh in the Undo window keeps the numbers');
    // Undo: row and numbers back
    await evaluate(`${S('toasts')}.forEach((t) => t.undo && t.undo()); 1`);
    assert.ok(await waitFor(`${S('threads')}.some((t) => t.threadId === ${JSON.stringify(id)})`, 5000), 'Undo brings the row back');
    await sleep(300);
    assert.deepEqual(await nums(), before, 'Undo brings the numbers back');
    // a bulk (Other) conversation: Other and, with Count Other on, the side-menu number
    await openTab('other');
    const bulkId = await evaluate(`${S('threads')}.find((t) => t.unread > 0).threadId`);
    await evaluate(`${S('act')}([${JSON.stringify(bulkId)}], 'trash', undefined, 'Deleted'); 1`);
    await sleep(250);
    const b = await nums();
    assert.deepEqual(b.state, [before.state[0] - 1, before.state[1], before.state[2] - 1], 'Other and the side-menu number drop, Focused does not');
    await evaluate(`${S('toasts')}.forEach((t) => t.undo && t.undo()); 1`);
    await sleep(600);
    assert.deepEqual((await nums()).state, before.state, 'back with Undo');
    // Count Other off: the side-menu number never counted the bulk conversation, so only the tab number drops
    await evaluate(`${S('setPrefs')}({ countOtherMail: false }); 1`);
    await sleep(500);
    const off = await nums();
    await evaluate(`${S('act')}([${JSON.stringify(bulkId)}], 'trash', undefined, 'Deleted'); 1`);
    await sleep(250);
    const off2 = await nums();
    assert.deepEqual(off2.state, [off.state[0], off.state[1], off.state[2] - 1], 'with Count Other off only the Other number drops');
    await evaluate(`${S('toasts')}.forEach((t) => t.undo && t.undo()); ${S('setPrefs')}({ countOtherMail: true }); 1`);
    await sleep(600);
  });

  // ---------------------------------------------------------------- 99+ (AC-13.12.7)
  await fresh('tabcounts=150,1234');
  await check('AC-13.12.7 99+ with the exact number in the name and the tooltip', async () => {
    const t = await tabs();
    assert.deepEqual(t.map((x) => x.badge), ['99+', '99+']);
    assert.deepEqual(t.map((x) => x.aria), ['Focused, 150 unread', 'Other, 1234 unread']);
    assert.deepEqual(t.map((x) => x.title), ['150 unread', '1234 unread']);
  });

  // ---------------------------------------------------------------- where the tabs are (AC-13.12.11 to .13)
  await fresh();
  await check('AC-13.12.11 a search takes the tabs away, clearing brings them back with the numbers', async () => {
    const before = await tabs();
        await evaluate(`${S('setSearch')}('digest'); 1`);
    await sleep(500);
    assert.equal((await tabs()).length, 0);
    assert.ok(await evaluate(`!!document.querySelector('.ml-title h2')`), 'the search title shows');
    await evaluate(`${S('setSearch')}(''); 1`);
    await sleep(500);
    assert.deepEqual((await tabs()).map((t) => t.badge), before.map((t) => t.badge));
  });
  await check('AC-13.12.12 Focused Inbox off: no tabs, the title; on: the tabs with numbers', async () => {
    await evaluate(`${S('setPrefs')}({ focused: false }); 1`);
    await sleep(500);
    assert.equal((await tabs()).length, 0);
    assert.equal(await evaluate(`document.querySelector('.ml-title h2')?.textContent`), 'Inbox');
    await evaluate(`${S('setPrefs')}({ focused: true }); 1`);
    await sleep(500);
    const t = await tabs();
    assert.equal(t.length, 2);
    assert.ok(t.every((x) => x.badge !== null));
  });
  await check('AC-13.12.13 another folder or view: no tabs', async () => {
    for (const view of ['archive', 'sent', 'starred', 'unread', 'snoozed', 'scheduled']) {
      await evaluate(`${S('setView')}(${JSON.stringify(view)}); 1`);
      await sleep(400);
      assert.equal((await tabs()).length, 0, view);
    }
    await evaluate(`${S('setView')}('inbox'); 1`);
    await sleep(400);
    assert.equal((await tabs()).length, 2);
  });
  await check('AC-13.12.9 the switch "Count Other" does not change the tab numbers', async () => {
    const before = (await tabs()).map((t) => t.badge);
    await evaluate(`${S('setPrefs')}({ countOtherMail: false }); 1`);
    await sleep(500);
    assert.deepEqual((await tabs()).map((t) => t.badge), before);
    await evaluate(`${S('setPrefs')}({ countOtherMail: true }); 1`);
    await sleep(500);
    assert.deepEqual((await tabs()).map((t) => t.badge), before);
  });
  await check('AC-13.12.14 Conversations off: the numbers stay (they count conversations)', async () => {
    const before = (await tabs()).map((t) => t.badge);
    await evaluate(`${S('setPrefs')}({ conversations: false }); 1`);
    await sleep(600);
    assert.deepEqual((await tabs()).map((t) => t.badge), before);
    await evaluate(`${S('setPrefs')}({ conversations: true }); 1`);
    await sleep(400);
  });

  // ---------------------------------------------------------------- keyboard (AC-13.12.15)
  await fresh();
  await check('AC-13.12.15 Tab order Focused, Other, Filter; the number is never focused; Enter switches the tab', async () => {
    assert.equal(await evaluate(`document.querySelectorAll('.pivots .fp-badge[tabindex], .pivots .fp-badge a, .pivots .fp-badge button').length`), 0);
    const focused = () => evaluate(`(() => { const a = document.activeElement; return a ? (a.getAttribute('role') === 'tab' ? 'tab:' + a.textContent.trim() : a.closest('.ml-tools') ? 'filter' : a.tagName + '.' + a.className) : null; })()`);
    // start before the list header: the search box, then press Tab until the first tab (other controls may lie between)
    await evaluate(`document.getElementById('search-input').focus(); 1`);
    const seen = [];
    for (let i = 0; i < 200; i++) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
      seen.push(await focused());
      if (seen[seen.length - 1] === 'filter') break;
    }
    const at = seen.findIndex((s) => s.startsWith('tab:'));
    assert.ok(at >= 0, `the Tab key reaches the tabs: ${seen.join(' > ')}`);
    assert.match(seen[at], /^tab:Focused/);
    assert.match(seen[at + 1], /^tab:Other/);
    assert.equal(seen[at + 2], 'filter');
    assert.ok(seen.every((s) => !/fp-badge/.test(s)), 'the number never has the focus');
    // Enter on Other switches the tab
    await evaluate(`[...document.querySelectorAll('.pivots [role=tab]')][1].focus(); 1`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    await sleep(300);
    assert.equal((await tabs())[1].selected, 'true');
  });

  // ---------------------------------------------------------------- W13.11 stored preferences
  await check('W13.11 stored old preferences start with the switch on and the marker saved; off with the marker stays off', async () => {
    // the dev preview keeps its settings in localStorage with #persist; the first load stores the old preferences, the second one reads them
    await H.openApp('lang=en&smallmailbox&persist', 1280, 800);
    await evaluate(`localStorage.setItem('hl-mock-settings', JSON.stringify({ prefs: JSON.stringify({ language: 'en', countOtherMail: false, listW: 420 }) })); 1`);
    await H.openApp('lang=en&smallmailbox&persist', 1280, 800);
    assert.equal(await evaluate(S('prefs.countOtherMail')), true, 'a stored false without the marker is switched on');
    assert.equal(await evaluate(S('prefs.prefsRev')), 1);
    assert.equal(await evaluate(S('prefs.listW')), 420, 'other keys are kept');
    await evaluate(`${S('setPrefs')}({ countOtherMail: false }); 1`);
    await sleep(300);
    const saved = JSON.parse(JSON.parse(await evaluate(`localStorage.getItem('hl-mock-settings')`)).prefs);
    assert.deepEqual([saved.countOtherMail, saved.prefsRev], [false, 1], 'the choice is saved together with the marker');
    await H.openApp('lang=en&smallmailbox&persist', 1280, 800);
    assert.equal(await evaluate(S('prefs.countOtherMail')), false, 'the next start keeps the choice');
    // a damaged value gives the defaults
    await evaluate(`localStorage.setItem('hl-mock-settings', JSON.stringify({ prefs: 'not json' })); 1`);
    await H.openApp('lang=en&smallmailbox&persist', 1280, 800);
    assert.equal(await evaluate(S('prefs.countOtherMail')), true);
    await evaluate(`localStorage.removeItem('hl-mock-settings'); 1`);
  });

  await check('W13.11 the switch refreshes the folder numbers after the save (setPrefs saves, then refreshes)', async () => {
    await fresh();
    await evaluate(`(() => { window.__calls = []; const w = window.__store.getState(); const old = w.refresh; window.__store.setState({ refresh: async () => { window.__calls.push('refresh'); return old(); } }); })()`);
    await evaluate(`${S('setPrefs')}({ countOtherMail: false }); 1`);
    await sleep(300);
    assert.ok((await evaluate(`window.__calls.length`)) >= 1, 'a refresh ran after the switch changed');
    const n = await evaluate(`window.__calls.length`);
    await evaluate(`${S('setPrefs')}({ density: 'compact' }); 1`);
    await sleep(200);
    assert.equal(await evaluate(`window.__calls.length`), n, 'another setting does not refresh');
    await evaluate(`${S('setPrefs')}({ density: 'full' }); 1`);
  });

  // ---------------------------------------------------------------- the Appearance preview (AC-13.11.8, AC-13.12.20)
  await check('AC-13.11.8 / AC-13.12.20 the Appearance preview: tab numbers and the Inbox number', async () => {
    await fresh();
    await evaluate(`${S('setDialog')}({ type: 'settings', tab: 'appearance' }); 1`);
    const opened = await waitFor(`!!document.querySelector('.ap-preview')`, 8000);
    assert.ok(opened, 'Settings > Appearance shows the preview');
    await sleep(300);
    const read = () => evaluate(`(() => { const p = document.querySelector('.ap-preview'); const bold = (g) => [...p.querySelectorAll('.ap-list .ml-row.unread')].length; return { inbox: p.querySelector('.ap-folders .fp-badge')?.textContent || '', focused: p.querySelector('.ap-pivots span:nth-child(1) .fp-badge')?.textContent || '', other: p.querySelector('.ap-pivots span:nth-child(2) .fp-badge')?.textContent || '', bold: bold(), classes: p.querySelector('.ap-pivots .fp-badge')?.className }; })()`);
    await evaluate(`${S('setPrefs')}({ focused: true, countOtherMail: true }); 1`);
    await sleep(200);
    const on = await read();
    assert.ok(on.focused !== '' && on.other !== '', `the preview tabs carry numbers: ${JSON.stringify(on)}`);
    assert.equal(Number(on.focused), on.bold, 'Focused number = bold rows of the Focused list');
    assert.equal(Number(on.inbox), Number(on.focused) + Number(on.other), 'the Inbox number counts the newsletter row with the switch on');
    await evaluate(`${S('setPrefs')}({ countOtherMail: false }); 1`);
    await sleep(200);
    const off = await read();
    assert.equal(Number(off.inbox), Number(on.focused), 'with the switch off the newsletter row is left out');
    assert.equal(off.other, on.other, 'the tab numbers do not depend on the switch');
    // Focused Inbox off: no tabs and the Inbox number counts every unread row
    await evaluate(`${S('setPrefs')}({ focused: false, countOtherMail: false }); 1`);
    await sleep(200);
    const flat = await read();
    assert.equal(Number(flat.inbox), flat.bold, 'without Focused Inbox the Inbox number equals the bold rows');
    await evaluate(`${S('setPrefs')}({ focused: true, countOtherMail: true }); 1`);
  });

  // ---------------------------------------------------------------- layout and look (AC-13.12.16, .17)
  const LANGS = FULL ? ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'] : ['en', 'de', 'ru', 'ja'];
  const SIZES = FULL ? [[960, 480], [960, 560], [1280, 800]] : [[960, 480]];
  const probe = async () => JSON.parse(await evaluate(TABN_JS));
  const seenFilter = { icon: 0, full: 0, below: 0 };
  for (const [w, h] of SIZES) {
    await fresh('tabcounts=150,1234', w, h);
    await evaluate(`${S('setPrefs')}({ listW: 300 }); ${S('setFilter')}('unread'); 1`);
    for (const lang of LANGS) {
      for (const theme of ['light', 'dark']) {
        await evaluate(`${S('setPrefs')}({ language: ${JSON.stringify(lang)}, theme: ${JSON.stringify(theme)} }); 1`);
        await sleep(350);
        await check(`AC-13.12.16 layout ${w}x${h} ${lang} ${theme}`, async () => {
          const p = await probe();
          if (LOG) console.log('LOG', w + 'x' + h, lang, theme, JSON.stringify({ filterIcon: p.filterIcon, filterBelow: p.filterBelow, rowOk: p.rowOk, headOk: p.headOk, ...p.nums }));
          assert.equal(p.tabs.length, 2, 'two tabs');
          assert.ok(p.listW >= 300 && p.listW <= 330, `the list is at its minimum (${p.listW})`);
          assert.equal(p.tabsOk, true, `both tabs in one row: ${JSON.stringify(p.tabs.map((t) => [t.top, t.bottom]))}`);
          assert.ok(p.rowOk || p.filterBelow, 'the Filter is in the row of the tabs, or (last resort) on a line of its own under them');
          seenFilter.below += p.filterBelow ? 1 : 0;
          assert.deepEqual(verdict(p), [], 'the pass criteria of the QA probe (scripts/lib/tab-number-probe.mjs)');
          assert.equal(p.headOk, true, 'the header does not scroll sideways and the Filter is inside the list');
          for (const t of p.tabs) {
            assert.equal(t.clipped, false, `${t.name} is not clipped`);
            assert.equal(t.labelLines, 1, `${t.name} label on one line`);
            assert.equal(t.sameLine, true, `${t.name} number on the label's line`);
            assert.equal(t.inside, true, `${t.name} number inside the list`);
            assert.equal(t.badge, '99+');
            assert.ok(Math.abs(t.offset) <= 1, `${t.name} baseline offset ${t.offset}`);
          }
          if (p.filterIcon) {
            seenFilter.icon++;
            assert.ok(p.filterTitle && p.filterTitle === p.filterText, `icon only: the tooltip is the full text (${p.filterTitle} / ${p.filterText})`);
            assert.equal(p.filterAria, p.filterTitle, 'the accessible name is the full text too');
          } else {
            seenFilter.full++;
            assert.equal(p.filterClipped, false, 'the full Filter text is not clipped');
          }
        });
        await check(`AC-13.12.17 look ${w}x${h} ${lang} ${theme}`, async () => {
          const p = await probe();
          const [f, o] = p.tabs;
          assert.equal(f.color, p.strongColor, 'Focused: the colour of the side menu Inbox number');
          assert.equal(f.weight, '650');
          assert.equal(o.color, p.mutedColor, 'Other: the muted colour (as the Junk number)');
          for (const t of p.tabs) {
            assert.ok(Math.abs(t.ratio - 0.86) <= 0.01, `font ratio ${t.ratio}`);
            assert.ok(/tabular-nums/.test(t.fvn), `tabular-nums (${t.fvn})`);
            assert.equal(t.tabular, true, 'digits 1 and 8 take the same width');
            assert.ok(contrast(t.color, p.listBg) >= 4.5, `contrast ${contrast(t.color, p.listBg).toFixed(2)} for ${t.color} on ${p.listBg}`);
          }
        });
      }
    }
  }
  await check('the Filter gives way (icon only) in the narrowest cases and the full text shows when there is room', async () => {
    assert.ok(seenFilter.icon + seenFilter.full > 0);
    await fresh('tabcounts=150,1234', 1280, 800);
    await evaluate(`${S('setPrefs')}({ listW: 600, language: 'en', theme: 'light' }); 1`);
    await sleep(300);
    const wide = await probe();
    assert.equal(wide.filterIcon, false, 'at 600 px the Filter shows its text');
    assert.equal(wide.filterText, 'Filter');
    await evaluate(`${S('setPrefs')}({ listW: 300, language: 'ru' }); ${S('setFilter')}('unread'); 1`);
    await sleep(400);
    const narrow = await probe();
    assert.equal(narrow.filterIcon, true, 'Russian at 300 px with Filter = Unread: icon only');
    // where the icon goes depends on the font (Windows: the tabs take 268 of 272 px, so it has a line of its own; a narrower or wider fallback font may leave room beside them)
    assert.ok(narrow.rowOk || narrow.filterBelow, `Russian with 99+ on both tabs: the icon is beside the tabs or on a line of its own (${JSON.stringify(narrow.nums)})`);
    assert.equal(narrow.headOk, true);
    assert.match(narrow.filterTitle, /Непрочитанные/, 'the tooltip is the full text of the Filter');
    assert.equal(await evaluate(`document.querySelector('.ml-tools .dd > button').getAttribute('aria-label')`), narrow.filterTitle);
    // the menu still opens from the icon
    await evaluate(`document.querySelector('.ml-tools .dd > button').click(); 1`);
    await sleep(200);
    assert.ok(await evaluate(`!!document.querySelector('.dd-fixed')`), 'the Filter menu opens');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  });
  await check('AC-13.12.17 contrast of both numbers with every accent preset, light and dark', async () => {
    await fresh('tabcounts=150,1234');
    for (const accent of ['#0f6cbd', '#0e7c86', '#1a7f4b', '#6d4aff', '#c2327d', '#c4570c', '#475569']) {
      for (const theme of ['light', 'dark']) {
        await evaluate(`${S('setPrefs')}({ accent: ${JSON.stringify(accent)}, theme: ${JSON.stringify(theme)} }); 1`);
        await sleep(120);
        const p = await probe();
        for (const t of p.tabs) assert.ok(contrast(t.color, p.listBg) >= 4.5, `${accent} ${theme}: ${t.name} ${contrast(t.color, p.listBg).toFixed(2)}`);
      }
    }
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-focus-tabs: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-focus-tabs: ok');
