#!/usr/bin/env node
// 1.0.7 W13.4 (REQ-13.4.1 to 13.4.5, AC-13.4.1 to AC-13.4.6): the search panel opens SIMPLE ("Search in", the recent searches, "Advanced search"); the filters, dates, fields and operators sit behind the button.
//   - AC-13.4.1 the simple panel has only the scope group, the recent searches (when there are any) and the button; AC-13.4.5 the scope group in the all-mailboxes view;
//   - AC-13.4.2 Advanced search opens, closes, is remembered while the program runs (a reload starts closed);
//   - AC-13.4.3 7 searches leave the last 5, newest first; the cross removes one (the focus goes to the next row); Clear all empties the list (the focus is in the box); a restart keeps the rest;
//   - AC-13.4.4 the keyboard flow (/, Down, Right, Down, Enter; /, Down, Down, Delete), Esc in the panel, the Tab order, radio group semantics, the accessible name of the cross;
//   - AC-13.4.6 the width is the width of the box, the simple panel needs no scrolling at 960x560, nothing clipped in the 8 languages, light and dark.
//   node scripts/test-search-panel.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness, languageJs, inputs } from './cdp-harness.mjs';

const H = await startHarness('test-search-panel', { vitePort0: 5280 });
const { evaluate, cdp } = H;
const { press, typeText } = inputs(H, null, 'search-panel');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(40); } return false; };
const S = (path) => `window.__store.getState().${path}`;
const recents = () => evaluate(S('prefs.recentSearches'));
const rows = () => evaluate(`[...document.querySelectorAll('.sb-panel [data-sb-nav="recent"]')].map((b) => b.textContent.trim())`);
const radios = () => evaluate(`[...document.querySelectorAll('.sb-panel [role="radio"]')].map((b) => [b.textContent.trim(), b.getAttribute('aria-checked')])`);
const active = () => evaluate(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, id: a.id, nav: a.dataset.sbNav || '', role: a.getAttribute('role') || '', text: (a.textContent || '').trim(), label: a.getAttribute('aria-label') || '' } : null; })()`);
const panelOpen = () => evaluate(`!!document.querySelector('.sb-panel')`);
// Enter carries its character like a real key press: a focused button is activated by that
const key = async (k, mod = 0) => {
  if (k === 'Enter') { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: String.fromCharCode(13), windowsVirtualKeyCode: 13 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); return; }
  await press(k, k.length === 1 ? (k === '/' ? 'Slash' : `Key${k.toUpperCase()}`) : k, mod);
};
/** put the preview in the Inbox of the first mailbox (three choices) or in the all-mailboxes Inbox (two) */
const view = async (one) => { await evaluate(`${S('setView')}('inbox', ${one ? S('accounts[0].id') : 'null'}).then(() => 1)`); await sleep(250); };
/** the focus comes into the box from outside (a click or a Tab): the panel opens */
const focusBox = async () => { await evaluate(`(() => { const i = document.getElementById('search-input'); i.blur(); i.focus(); return 1; })()`); await sleep(120); };
/** type a search into the box and press Enter (a real input) */
const search = async (text) => {
  await evaluate(`${S('setSearch')}('', false).then(() => 1)`);
  await focusBox();
  await evaluate(`(() => { const i = document.getElementById('search-input'); i.select(); return 1; })()`);
  await typeText(text, 5);
  await key('Enter');
  await sleep(150);
};
const openFresh = async (hash = 'lang=en', w = 1280, h = 800, stored = null) => {
  const s = stored ? await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('hl-mock-settings', ${JSON.stringify(JSON.stringify(stored))});` }) : null;
  try { await H.openApp(hash, w, h); } finally { if (s) await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.identifier }); }
};

try {
  await openFresh('lang=en&persist');
  await view(true);

  await check('AC-13.4.1 the box opens the simple panel: only "Search in" (3 choices) and "Advanced search" at the start', async () => {
    await focusBox();
    assert.ok(await panelOpen());
    const p = await evaluate(`(() => { const p = document.querySelector('.sb-panel'); return { titles: [...p.querySelectorAll('.sb-title')].map((e) => e.textContent), chips: p.querySelectorAll('.sb-chip').length, fields: p.querySelectorAll('.sb-field').length, foot: p.querySelectorAll('.sb-foot').length, recent: p.querySelectorAll('.sb-recent').length, adv: p.querySelector('.sb-advanced').textContent.trim(), expanded: p.querySelector('.sb-advanced').getAttribute('aria-expanded'), controls: p.querySelector('.sb-advanced').getAttribute('aria-controls'), chevron: !!p.querySelector('.sb-advanced svg') }; })()`);
    assert.deepEqual(p.titles, ['Search in']);
    assert.deepEqual([p.chips, p.fields, p.foot, p.recent], [0, 0, 0, 0], 'no filters, dates, fields, operators, no recent section');
    assert.equal(p.adv, 'Advanced search');
    assert.equal(p.expanded, 'false');
    assert.ok(p.chevron);
    assert.deepEqual(await radios(), [['Current folder', 'true'], ['All folders', 'false'], ['All mailboxes', 'false']], 'with a mailbox selected "All folders" is labelled so');
  });

  await check('AC-13.4.5 the all-mailboxes view offers only "Current folder" and "All mailboxes"', async () => {
    await view(false);
    await focusBox();
    assert.deepEqual((await radios()).map((r) => r[0]), ['Current folder', 'All mailboxes']);
    // a stored scope that is not offered shows the one it is the same as
    await evaluate(`${S('setSearchScope')}('account').then(() => 1)`);
    await sleep(100);
    assert.deepEqual(await radios(), [['Current folder', 'false'], ['All mailboxes', 'true']]);
    await evaluate(`${S('setSearchScope')}('current').then(() => 1)`);
    await view(true);
    await focusBox();
  });

  await check('radio group semantics: role radiogroup named by "Search in", aria-checked, one tab stop', async () => {
    const r = await evaluate(`(() => { const g = document.querySelector('.sb-panel [role="radiogroup"]'); const name = document.getElementById(g.getAttribute('aria-labelledby')).textContent; const tabs = [...g.querySelectorAll('[role="radio"]')].map((b) => b.tabIndex); return { name, tabs }; })()`);
    assert.equal(r.name, 'Search in');
    assert.deepEqual(r.tabs, [0, -1, -1]);
  });

  await check('AC-13.4.2 Advanced search opens the old sections, closes them, is remembered while the program runs; a reload starts closed', async () => {
    await evaluate(`document.querySelector('.sb-advanced').click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('#sb-adv .sb-chip')`), 'the sections load');
    const o = await evaluate(`(() => { const a = document.querySelector('#sb-adv'); return { titles: [...a.querySelectorAll('.sb-title')].map((e) => e.textContent), foot: !!a.querySelector('.sb-foot'), exp: document.querySelector('.sb-advanced').getAttribute('aria-expanded') }; })()`);
    assert.deepEqual(o.titles, ['Filters', 'Date', 'Fields']);
    assert.ok(o.foot && o.exp === 'true');
    // close and open the panel: still expanded
    await key('Escape');
    await sleep(100);
    assert.ok(!(await panelOpen()), 'Esc in the panel closes it');
    await focusBox();
    assert.ok(await waitFor(`!!document.querySelector('#sb-adv .sb-chip')`), 'still expanded');
    // the sections still work: a filter chip changes the text of the box
    await evaluate(`document.querySelector('#sb-adv .sb-chip').click(); 1`);
    await sleep(150);
    assert.equal(await evaluate(`document.getElementById('search-input').value`), 'is:unread');
    await evaluate(`document.querySelector('.sb-advanced').click(); 1`);
    await sleep(80);
    assert.equal(await evaluate(`!!document.querySelector('#sb-adv')`), false, 'collapsed again');
    assert.equal(await evaluate(`document.querySelector('.sb-advanced').getAttribute('aria-expanded')`), 'false');
    await evaluate(`document.querySelector('.sb-advanced').click(); 1`);
    await waitFor(`!!document.querySelector('#sb-adv .sb-chip')`);
    await openFresh('lang=en&persist');
    await view(true);
    await focusBox();
    assert.equal(await evaluate(`document.querySelector('.sb-advanced').getAttribute('aria-expanded')`), 'false', 'after a restart it starts collapsed');
    await evaluate(`${S('setSearch')}('', false).then(() => 1)`);
  });

  await check('AC-13.4.3 7 searches (a to g) leave the last 5, newest first', async () => {
    // one letter each: the people suggestions (they need two) stay out of the list under test
    for (const c of 'abcdefg') await search(c);
    assert.deepEqual(await recents(), ['g', 'f', 'e', 'd', 'c']);
    await focusBox();
    assert.deepEqual(await rows(), ['g', 'f', 'e', 'd', 'c']);
  });

  await check('the Tab order: scope group, row, its cross, next row ... Clear all, Advanced search', async () => {
    const order = await evaluate(`(() => [...document.querySelectorAll('.sb-panel button, .sb-panel input')].filter((e) => e.tabIndex >= 0).map((e) => e.dataset.sbNav || (e.classList.contains('sb-recent-x') ? 'x' : e.tagName)))()`);
    assert.deepEqual(order, ['scope', 'recent', 'x', 'recent', 'x', 'recent', 'x', 'recent', 'x', 'recent', 'x', 'clear', 'advanced']);
  });

  await check('the cross has the name and the tooltip "Remove “…” from recent searches"; Clear all is on the line of the title', async () => {
    const r = await evaluate(`(() => { const x = document.querySelector('.sb-recent-x'); const t = document.querySelector('.sb-recent .sb-title').getBoundingClientRect(), c = document.querySelector('.sb-clear').getBoundingClientRect(); return { name: x.getAttribute('aria-label'), title: x.title, sameLine: Math.abs((t.top + t.bottom) / 2 - (c.top + c.bottom) / 2) < 8, right: c.left > t.left + 40 }; })()`);
    assert.equal(r.name, 'Remove “g” from recent searches');
    assert.equal(r.title, r.name);
    assert.ok(r.sameLine && r.right, JSON.stringify(r));
  });

  await check('AC-13.4.3 the cross on the 2nd removes it at once and the focus is on the next row', async () => {
    await evaluate(`document.querySelectorAll('.sb-recent-x')[1].click(); 1`);
    await sleep(120);
    assert.deepEqual(await recents(), ['g', 'e', 'd', 'c']);
    assert.ok(await panelOpen(), 'the panel stays open');
    const a = await active();
    assert.equal(a.nav, 'recent');
    assert.equal(a.text, 'e', JSON.stringify(a));
  });

  await check('Clear all empties the list, the section goes, the focus is in the box, the panel stays open', async () => {
    await evaluate(`document.querySelector('.sb-clear').click(); 1`);
    await sleep(120);
    assert.deepEqual(await recents(), []);
    assert.equal(await evaluate(`!!document.querySelector('.sb-recent')`), false);
    assert.equal((await active()).id, 'search-input');
    assert.ok(await panelOpen());
  });

  await check('AC-13.4.3 a restart keeps the remaining list', async () => {
    await evaluate(`${S('setPrefs')}({ recentSearches: ['b', 'a'] }); 1`);
    await sleep(200);
    await openFresh('lang=en&persist');
    assert.deepEqual(await recents(), ['b', 'a']);
  });

  await check('older stored lists (8 entries) are cut to 5 when they are read', async () => {
    await openFresh('lang=en&persist', 1280, 800, { prefs: JSON.stringify({ language: 'en', prefsRev: 1, recentSearches: ['1', '2', '3', '4', '5', '6', '7', '8'] }) });
    assert.deepEqual(await recents(), ['1', '2', '3', '4', '5']);
  });

  await check('AC-13.4.4 keyboard only: /, Down, Right (scope "All folders", the list runs again), Down to the first recent row, Enter runs it and closes the panel', async () => {
    await openFresh('lang=en', 1280, 800);
    await view(true);
    await evaluate(`${S('setPrefs')}({ recentSearches: ['alpha', 'beta', 'gamma'] }); ${S('setSearch')}('budget', false).then(() => 1)`);
    await sleep(200);
    await evaluate(`(() => { document.activeElement && document.activeElement.blur(); const s = window.__store; const old = s.getState().refresh; window.__refreshes = 0; s.setState({ refresh: () => { window.__refreshes++; return old(); } }); return 1; })()`);
    await key('/');
    await sleep(120);
    assert.equal((await active()).id, 'search-input');
    assert.ok(await panelOpen());
    await key('ArrowDown');
    let a = await active();
    assert.deepEqual([a.role, a.text], ['radio', 'Current folder'], JSON.stringify(a));
    await key('ArrowRight');
    await sleep(150);
    assert.equal(await evaluate(S('searchScope')), 'account');
    a = await active();
    assert.deepEqual([a.role, a.text], ['radio', 'All folders'], 'the focus moves with the choice');
    assert.ok((await evaluate('window.__refreshes')) >= 1, 'the list ran again with the text in the box');
    await key('ArrowDown');
    a = await active();
    assert.deepEqual([a.nav, a.text], ['recent', 'alpha']);
    await key('Enter');
    await sleep(200);
    assert.equal(await evaluate(S('search')), 'alpha');
    assert.equal(await evaluate(`document.getElementById('search-input').value`), 'alpha');
    assert.equal(await panelOpen(), false, 'the panel closed');
    assert.equal((await active()).id, 'search-input', 'the focus is back in the box');
    assert.deepEqual(await recents(), ['alpha', 'beta', 'gamma'], 'the picked search stays on top');
    // Left wraps around the group
    await focusBox();
    await key('ArrowDown');
    await key('ArrowLeft');
    await sleep(100);
    assert.equal(await evaluate(S('searchScope')), 'current');
    await key('ArrowLeft');
    await sleep(100);
    assert.equal(await evaluate(S('searchScope')), 'all', 'Left from the first choice wraps to the last');
    await evaluate(`${S('setSearchScope')}('current').then(() => 1)`);
  });

  await check('AC-13.4.4 /, Down, Down, Delete removes the row; Up from the first control returns to the box; Esc in the panel keeps the text', async () => {
    await evaluate(`${S('setPrefs')}({ recentSearches: ['alpha', 'beta', 'gamma'] }); document.activeElement.blur(); 1`);
    await key('/');
    await sleep(100);
    await key('ArrowDown');
    await key('ArrowDown');
    assert.equal((await active()).text, 'alpha');
    await key('Delete');
    await sleep(120);
    assert.deepEqual(await recents(), ['beta', 'gamma']);
    assert.equal((await active()).text, 'beta', 'the focus is on the row that took its place');
    await key('Delete');
    await key('Delete');
    await sleep(120);
    assert.deepEqual(await recents(), []);
    assert.equal((await active()).id, 'search-input', 'with the list empty the focus is on the box');
    // Up from the first control
    await key('ArrowDown');
    await key('ArrowUp');
    assert.equal((await active()).id, 'search-input');
    // Esc in the panel
    await evaluate(`${S('setPrefs')}({ recentSearches: ['x1'] }); 1`);
    await sleep(80);
    await key('ArrowDown');
    await key('ArrowDown');
    assert.equal((await active()).nav, 'recent');
    await key('Escape');
    await sleep(100);
    assert.equal(await panelOpen(), false);
    const a = await active();
    assert.equal(a.id, 'search-input');
    assert.equal(await evaluate(`document.getElementById('search-input').value`), 'alpha', 'the text of the box stays');
    // Esc in the box keeps today's rule: the first clears the text, the second leaves the box
    await key('Escape');
    await sleep(120);
    assert.equal(await evaluate(`document.getElementById('search-input').value`), '');
    await key('Escape');
    await sleep(80);
    assert.notEqual((await active()).id, 'search-input');
  });

  await check('Down in the box with the panel closed opens it and enters it', async () => {
    await evaluate(`${S('setPrefs')}({ recentSearches: [] }); ${S('setSearch')}('', false).then(() => 1)`);
    await focusBox();
    await key('ArrowDown');
    await key('Escape'); // the panel closes, the focus is in the box
    await sleep(100);
    assert.equal(await panelOpen(), false);
    assert.equal((await active()).id, 'search-input');
    await key('ArrowDown');
    await sleep(120);
    assert.ok(await panelOpen());
    const a = await active();
    assert.deepEqual([a.role, a.text], ['radio', 'Current folder'], JSON.stringify(a));
    await key('Escape');
    await sleep(80);
  });

  // ---------------------------------------------------------------- the look
  const look = async (w, h) => {
    await evaluate(`${S('setPrefs')}({ recentSearches: ['quarterly report', 'invoice from acme', 'from:ann is:unread', 'travel', 'x'] }); 1`);
    await focusBox();
    await sleep(150);
    return evaluate(`(() => { const p = document.querySelector('.sb-panel'), b = document.querySelector('.search-wrap'), pr = p.getBoundingClientRect(), br = b.getBoundingClientRect();
      const cut = [...p.querySelectorAll('.sb-advanced, .sb-clear, .sb-title, [role="radio"], .sb-recent-x')].filter((e) => { const r = e.getBoundingClientRect(); return r.left < pr.left - 0.5 || r.right > pr.right + 0.5 || (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible'); }).map((e) => e.className || e.textContent);
      const seg = p.querySelector('.seg').getBoundingClientRect();
      return { panelW: Math.round(pr.width), boxW: Math.round(br.width), scroll: p.scrollHeight - p.clientHeight, h: Math.round(pr.height), bottom: Math.round(pr.bottom), cut, segInside: seg.right <= pr.right + 0.5 }; })()`);
  };

  await check('REQ-13.4.5 AC-13.4.6 the width is the width of the box; at 960x560 the simple panel with 5 recent searches needs no scrolling', async () => {
    for (const [w, h] of [[960, 560], [1280, 800]]) {
      await openFresh('lang=en', w, h);
      await view(true);
      const r = await look(w, h);
      assert.ok(Math.abs(r.panelW - r.boxW) <= 1, `${w}: panel ${r.panelW} box ${r.boxW}`);
      assert.equal(r.scroll, 0, `${w}x${h}: scrolls by ${r.scroll} (panel ${r.h} px)`);
      assert.ok(r.bottom <= h, `${w}x${h}: bottom ${r.bottom}`);
      assert.deepEqual(r.cut, [], `${w}: clipped ${JSON.stringify(r.cut)}`);
      assert.ok(r.segInside);
    }
  });

  await check('AC-13.4.6 dark theme: the button, the cross and Clear all keep their colours apart from the panel', async () => {
    await evaluate(`${S('setPrefs')}({ theme: 'dark' }); 1`);
    await sleep(200);
    const r = await evaluate(`(() => { const p = getComputedStyle(document.querySelector('.sb-panel')), a = getComputedStyle(document.querySelector('.sb-advanced')), c = getComputedStyle(document.querySelector('.sb-clear')); return { bg: p.backgroundColor, a: a.color, c: c.color }; })()`);
    assert.notEqual(r.a, r.bg);
    assert.notEqual(r.c, r.bg);
    await evaluate(`${S('setPrefs')}({ theme: 'light' }); 1`);
  });

  await check('D-068 the panel is as wide as the box, and at its left edge, on EVERY frame from the first (the opening animation does not scale it)', async () => {
    for (const [w, h] of [[960, 560], [1280, 800]]) {
      await openFresh('lang=en', w, h);
      await view(true);
      await evaluate(`window.__pw = { worst: 0, n: 0, stop: false }; const tick = () => { if (window.__pw.stop) return; const p = document.querySelector('.sb-panel'), b = document.querySelector('.search-wrap'); if (p && b) { const pr = p.getBoundingClientRect(), br = b.getBoundingClientRect(); window.__pw.n++; window.__pw.worst = Math.max(window.__pw.worst, Math.abs(pr.width - br.width), Math.abs(pr.left - br.left)); } requestAnimationFrame(tick); }; requestAnimationFrame(tick); 1`);
      await focusBox();
      await sleep(500);
      const r = await evaluate(`window.__pw.stop = true; window.__pw`);
      assert.ok(r.n >= 3, `${w}: only ${r.n} frames were looked at`);
      assert.ok(r.worst <= 1, `${w}: the panel was ${r.worst} px off the box in some frame`);
    }
  });

  await check('AC-13.4.6 the 8 languages: the three texts show, nothing is clipped at 960x560 (panel expanded too)', async () => {
    await openFresh('lang=en', 960, 560);
    await view(true);
    for (const lang of ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru']) {
      await evaluate(languageJs(lang));
      const r = await look(960, 560);
      assert.deepEqual(r.cut, [], `${lang}: clipped ${JSON.stringify(r.cut)}`);
      assert.equal(r.scroll, 0, `${lang}: the simple panel scrolls by ${r.scroll}`);
      const t = await evaluate(`({ adv: document.querySelector('.sb-advanced').textContent.trim(), clear: document.querySelector('.sb-clear').textContent.trim(), name: document.querySelector('.sb-recent-x').getAttribute('aria-label'), key: /app\\.search\\./.test(document.querySelector('.sb-panel').textContent) })`);
      assert.ok(t.adv && t.clear && t.name.includes('quarterly report') && !t.key, `${lang}: ${JSON.stringify(t)}`);
      await evaluate(`document.querySelector('.sb-advanced').click(); 1`);
      assert.ok(await waitFor(`!!document.querySelector('#sb-adv .sb-chip')`));
      const w = await evaluate(`(() => { const p = document.querySelector('.sb-panel'); return [...p.querySelectorAll('#sb-adv .sb-chip, #sb-adv .sb-title, #sb-adv label')].filter((e) => e.getBoundingClientRect().right > p.getBoundingClientRect().right + 0.5).length; })()`);
      assert.equal(w, 0, `${lang}: ${w} parts of Advanced search stick out`);
      await evaluate(`document.querySelector('.sb-advanced').click(); 1`);
    }
    await evaluate(languageJs('en'));
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-search-panel: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-search-panel: ok');
