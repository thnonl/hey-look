#!/usr/bin/env node
// The text menu in the reading areas (W8.1) and the email links of a message (W8.10), real components in the dev preview (`#wp8` adds the two conversations of src/devMock.ts, `#nativemenu=off` is
// the release behaviour of the menu), real right-clicks, a real menu key and real clicks (Input.dispatch*Event):
//   - selected text in the message: Copy, Select all, a divider, "Search mail for “…”"; the entry runs the search of the main window (the box, the list, the recent searches, the scope unchanged, the focus on the list)
//   - 8 words, 100 characters, the label cut to 30 + "…", an operator word is not read as a filter (AC-8.1.1 to 8.1.3, 8.1.8)
//   - the subject heading: "Copy subject" first, with or without a selection; Shift+F10 with a selection (AC-8.1.4, 8.1.6)
//   - no search entry in Settings, in the list, or in a link menu without a selection (AC-8.1.7); a reader window asks the main page with the `search` request (AC-8.1.5)
//   - a click (left, middle, Shift) on a mailto link starts a new message here with the fields of the link; the browser is not asked; other links still open the browser (AC-8.10.1 to 8.10.7, 8.10.10)
//
//   node scripts/test-ctx-search.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { arg, flag, languageJs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-ctx-search', { vitePort0: 5040, cdpPort0: 9040 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } return !!cond; };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };

const FRAME = `document.querySelector('iframe.msg-frame')`;
/** the window point of a range of the text node of #id in the message frame (and the range is selected when `select`) */
const framePoint = (id, from, to, select = true) => evaluate(`(() => {
  const f = ${FRAME}, d = f.contentDocument, el = d.getElementById(${JSON.stringify(id)}), n = el.firstChild;
  const r = d.createRange(); r.setStart(n, ${from}); r.setEnd(n, ${to});
  if (${select}) { const s = d.getSelection(); s.removeAllRanges(); s.addRange(r); }
  const q = r.getClientRects()[0], fr = f.getBoundingClientRect();
  return [fr.left + q.left + q.width / 2, fr.top + q.top + q.height / 2];
})()`);
const linkPoint = (id) => evaluate(`(() => { const f = ${FRAME}, a = f.contentDocument.getElementById(${JSON.stringify(id)}); a.scrollIntoView({ block: 'center' }); const q = a.getBoundingClientRect(), fr = f.getBoundingClientRect(); return [fr.left + q.left + q.width / 2, fr.top + q.top + q.height / 2]; })()`);
const clearSelection = () => evaluate(`(() => { getSelection().removeAllRanges(); const f = ${FRAME}; if (f && f.contentDocument) f.contentDocument.getSelection().removeAllRanges(); return 1; })()`);
const mouse = async (x, y, button = 'left', modifiers = 0) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: 1, modifiers });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, modifiers });
};
const menuRows = () => evaluate(`(() => { const m = document.querySelector('.ctx-menu'); return m ? [...m.querySelectorAll('[role=menuitem],[role=separator]')].map((e) => (e.getAttribute('role') === 'separator' ? '---' : e.textContent.trim().replace(/(Ctrl|Cmd)\\+[A-Z]$/, ''))) : null; })()`);
const menuOpen = async () => { await waitFor(`!!document.querySelector('.ctx-menu [role=menuitem]')`, 4000); return menuRows(); };
const closeMenu = async () => { if (await evaluate(`!!document.querySelector('.ctx-menu')`)) { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(120); } };
const chooseRow = async (startsWith) => {
  const pt = await evaluate(`(() => { const e = [...document.querySelectorAll('.ctx-menu [role=menuitem]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(startsWith)})); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!pt) return false;
  await mouse(pt[0], pt[1]);
  return true;
};
const state = () => evaluate(`(() => { const s = window.__store.getState(); return { search: s.search, scope: s.searchScope, recent: s.prefs.recentSearches.slice(0, 3), box: document.getElementById('search-input').value, focusInList: !!document.activeElement && !!document.activeElement.closest('.ml-body'), rows: document.querySelectorAll('.ml-body .ml-row').length, module: s.module }; })()`);

async function boot(hash, w = 1280, h = 800) {
  await H.openApp(hash, w, h);
  await evaluate(`window.__mockMail && 1`);
}
const openThread = async (id) => {
  await evaluate(`window.__store.getState().openMail(${JSON.stringify(id)}); 1`);
  await waitFor(`(() => { const f = ${FRAME}; return !!(f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent.trim().length > 5 && f.contentDocument.getElementById('${id === 'tw8-sel' ? 'q' : 'l1'}')); })()`, 10000);
  await sleep(250);
};
const resetSearch = () => evaluate(`window.__store.getState().setSearch(''); 1`).then(() => sleep(150));

try {
  // ------------------------------------------------------------------ the text menu
  tag = 'en';
  await boot('lang=en&nativemenu=off&wp8');
  await openThread('tw8-sel');

  // AC-8.1.1: "budget review" selected in the message
  {
    const [x, y] = await framePoint('q', 10, 23);
    await mouse(x, y, 'right');
    const rows = await menuOpen();
    ok(JSON.stringify(rows) === JSON.stringify(['Copy', 'Select all', '---', 'Search mail for “budget review”']), `the menu of a selection: ${JSON.stringify(rows)}`);
    ok(await chooseRow('Search mail for'), 'the entry is there to click');
    await waitFor(`window.__store.getState().search === 'budget review'`);
    await sleep(300);
    const s = await state();
    ok(s.search === 'budget review' && s.box === 'budget review', `AC-8.1.1: the search box shows budget review (${s.search} / ${s.box})`);
    ok(s.recent[0] === 'budget review', `and the recent searches list it first (${s.recent})`);
    ok(s.rows >= 1, `and the list shows the mails with both words (${s.rows} rows)`);
    ok(s.focusInList, 'REQ-8.1.5: the focus goes to the result list');
    ok(await evaluate(`window.__store.getState().threads.some((t) => t.threadId === 'tw8-sel')`), 'the open mail is among the results');
  }
  // AC-8.1.2: a long selection: the label is cut to 30 + "…", the search keeps the first 8 words
  await resetSearch();
  await openThread('tw8-sel');
  {
    const [x, y] = await framePoint('long', 0, 62);
    await mouse(x, y, 'right');
    const rows = await menuOpen();
    const entry = (rows || []).find((r) => r.startsWith('Search mail for')) || '';
    ok(entry === 'Search mail for “one two three four five six se…”', `AC-8.1.2: the label is cut: ${entry}`);
    await chooseRow('Search mail for');
    await waitFor(`window.__store.getState().search.startsWith('one two')`);
    ok((await state()).search === 'one two three four five six seven eight', `and the search has the first 8 words (${(await state()).search})`);
  }
  // AC-8.1.3: an operator in the text is not a filter
  await resetSearch();
  await openThread('tw8-sel');
  {
    const [x, y] = await framePoint('ops', 0, 23);
    await mouse(x, y, 'right');
    const rows = await menuOpen();
    ok((rows || []).includes('Search mail for “from boss subject pay”'), `AC-8.1.3: from:boss subject:"pay" is searched as words: ${JSON.stringify(rows)}`);
    await chooseRow('Search mail for');
    await waitFor(`window.__store.getState().search === 'from boss subject pay'`);
    ok((await state()).box === 'from boss subject pay', 'the box shows the words');
  }
  // AC-8.1.8: the scope is the one the person chose, unchanged
  for (const scope of ['all', 'current']) {
    await resetSearch();
    await evaluate(`window.__store.getState().setSearchScope(${JSON.stringify(scope)}); 1`);
    await openThread('tw8-sel');
    const [x, y] = await framePoint('q', 10, 16);
    await mouse(x, y, 'right');
    await menuOpen();
    await chooseRow('Search mail for');
    await waitFor(`window.__store.getState().search === 'budget'`);
    ok((await state()).scope === scope, `AC-8.1.8: the scope stays "${scope}" (${(await state()).scope})`);
  }
  await evaluate(`window.__store.getState().setSearchScope('current'); 1`);
  // a link menu with a selection: Open link, Copy email address, divider, Copy, divider, Search
  await resetSearch();
  await openThread('tw8-sel');
  {
    const [x, y] = await framePoint('mail', 0, 4, false).then(async (p) => { await evaluate(`(() => { const f = ${FRAME}, d = f.contentDocument, a = d.getElementById('mail'); const r = d.createRange(); r.selectNodeContents(a.firstChild); const s = d.getSelection(); s.removeAllRanges(); s.addRange(r); return 1; })()`); return p; });
    await mouse(x, y, 'right');
    const rows = await menuOpen();
    ok(rows && rows[0] === 'Open link' && rows.includes('Copy') && rows.at(-1).startsWith('Search mail for') && rows.at(-2) === '---', `a link with text selected: ${JSON.stringify(rows)}`);
    await closeMenu();
    await clearSelection();
    await mouse(x, y, 'right');
    const rows2 = await menuOpen();
    ok(rows2 && !rows2.some((r) => r.startsWith('Search mail for')), `a link with nothing selected has no search entry: ${JSON.stringify(rows2)}`);
    await closeMenu();
  }
  // AC-8.1.4: the subject heading: Copy subject first, with and without a selection
  {
    await clearSelection();
    const pt = await evaluate(`(() => { const r = document.querySelector('.rp-head h2').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`);
    await mouse(pt[0], pt[1], 'right');
    const rows = await menuOpen();
    ok(rows && rows[0] === 'Copy subject' && rows[1] === '---' && rows.includes('Copy') && rows.includes('Select all'), `AC-8.1.4: the menu of the subject: ${JSON.stringify(rows)}`);
    ok(!rows.some((r) => r.startsWith('Search mail for')), 'and no search entry without a selection');
    await chooseRow('Copy subject');
    ok(await waitFor(`window.__store.getState().toasts.some((t) => (t.textFn ? t.textFn() : t.text) === 'Copied')`, 4000), 'the toast says Copied');
    // with a selection inside the heading
    await evaluate(`(() => { const h = document.querySelector('.rp-head h2'); const r = document.createRange(); r.setStart(h.firstChild, 0); r.setEnd(h.firstChild, 6); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 1; })()`);
    await mouse(pt[0] - 10, pt[1], 'right');
    const rows3 = await menuOpen();
    ok(rows3 && rows3[0] === 'Copy subject' && rows3.at(-1).startsWith('Search mail for “'), `and with a selection in it: Copy subject first, then the search: ${JSON.stringify(rows3)}`);
    await closeMenu();
  }
  // AC-8.1.6: the keyboard: a selection in the message, Shift+F10, ArrowDown to the entry, Enter
  await resetSearch();
  await openThread('tw8-sel');
  {
    await framePoint('q', 10, 23);
    await evaluate(`${FRAME}.contentWindow.focus(); 1`);
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    const rows = await menuOpen();
    ok(rows && rows.at(-1) === 'Search mail for “budget review”', `AC-8.1.6: Shift+F10 opens the same menu: ${JSON.stringify(rows)}`);
    for (let i = 0; i < 3; i++) {
      if (await evaluate(`document.activeElement && document.activeElement.textContent.trim().startsWith('Search mail for')`)) break;
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await sleep(60);
    }
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    ok(await waitFor(`window.__store.getState().search === 'budget review'`, 4000), 'and Enter runs the search');
  }
  // AC-8.1.7: no search entry in Settings, in the list, in the top bar
  {
    await closeMenu();
    const row = await evaluate(`(() => { const r = document.querySelector('.ml-row').getBoundingClientRect(); return [r.left + 80, r.top + r.height / 2]; })()`);
    await mouse(row[0], row[1], 'right');
    await sleep(250);
    const rows = await menuRows();
    ok(!rows || !rows.some((r) => r.startsWith('Search mail for')), `a row of the list has no search entry: ${JSON.stringify(rows)}`);
    await closeMenu();
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'general' }); 1`);
    await waitFor(`!!document.querySelector('.settings-body .set-lbl')`);
    await evaluate(`(() => { const e = document.querySelector('.settings-body .set-lbl div'); const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 1; })()`);
    const lab = await evaluate(`(() => { const r = document.querySelector('.settings-body .set-lbl div').getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; })()`);
    await mouse(lab[0], lab[1], 'right');
    await sleep(250);
    const rs = await menuRows();
    ok(!rs || !rs.some((r) => r.startsWith('Search mail for')), `AC-8.1.7: a Settings label has no search entry: ${JSON.stringify(rs)}`);
    await closeMenu();
    await evaluate(`window.__store.getState().setDialog(null); 1`);
  }

  // AC-8.1.9: the entry is translated and the menu is not clipped, also with 30 characters of selection (fr and de have the longest words around them), at 960x560
  for (const lang of ['fr', 'de', 'ja', 'ru']) {
    tag = lang;
    await boot('lang=en&nativemenu=off&wp8', 960, 560);
    await evaluate(languageJs(lang));
    await openThread('tw8-sel');
    const [x, y] = await framePoint('long', 0, 34);
    await mouse(x, y, 'right');
    const rows = await menuOpen();
    const entry = (rows || []).find((r) => r.includes('one two three four')) || '';
    ok(entry && entry.includes('…') && !/{text}|mail.ctx/.test(entry), `${lang}: the entry is translated and its label is cut (${entry})`);
    const m = await evaluate(`(() => { const menu = document.querySelector('.ctx-menu'), r = menu.getBoundingClientRect(); const rows = [...menu.querySelectorAll('[role=menuitem]')]; return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, clipped: rows.some((e) => e.scrollWidth > e.clientWidth + 1), width: Math.round(r.width) }; })()`);
    ok(m.inside && !m.clipped, `${lang}: the menu fits the window and nothing is cut (${JSON.stringify(m)})`);
    await closeMenu();
  }
  tag = 'en';

  // ------------------------------------------------------------------ the email links
  tag = 'mailto';
  await boot('lang=en&nativemenu=off&wp8');
  await openThread('tw8-mailto');
  const compose = () => evaluate(`(() => { const c = window.__store.getState().compose; return c ? JSON.parse(JSON.stringify({ accountId: c.accountId, to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, typedHtml: c.typedHtml, attachments: c.attachments, inReplyTo: c.inReplyTo, references: c.references, isReply: c.isReply, confidential: c.confidential })) : null; })()`);
  const clearCompose = async () => { await evaluate(`window.__store.getState().openCompose(null); 1`); await sleep(150); };
  const opened = () => evaluate(`(window.__mockMail && window.__mockMail.opened.length) || 0`);
  const popouts = () => evaluate(`window.__popoutOpens || 0`);
  const clickLink = async (id, button = 'left', modifiers = 0) => { const [x, y] = await linkPoint(id); await mouse(x, y, button, modifiers); };
  // AC-8.10.1
  await clickLink('l1');
  ok(await waitFor(`!!window.__store.getState().compose`, 5000), 'AC-8.10.1: a click on a mailto link starts a message here');
  let c = await compose();
  ok(c && JSON.stringify(c.to) === '["qa1@example.test"]' && c.accountId === 'a1' && !c.subject && !c.typedHtml && !c.inReplyTo && !c.isReply, `with the address, the receiving mailbox, no subject, no reply marks: ${JSON.stringify(c)}`);
  ok(await opened() === 0, 'and the system opener was not asked');
  await clearCompose();
  // AC-8.10.2
  await clickLink('l2');
  await waitFor(`!!window.__store.getState().compose`, 5000);
  c = await compose();
  ok(c && JSON.stringify(c.to) === '["qa1@example.test","qa2@example.test"]' && JSON.stringify(c.cc) === '["qa3@example.test"]' && JSON.stringify(c.bcc) === '["qa4@example.test"]' && c.subject === 'Hello there', `AC-8.10.2: the fields of the link: ${JSON.stringify(c)}`);
  ok(c && c.typedHtml === '<p>Line 1<br>Line 2</p><p></p>', `the body is two lines: ${c && c.typedHtml}`);
  ok(await waitFor(`(document.querySelector('.compose-pane .ProseMirror') || {}).textContent && document.querySelector('.compose-pane .ProseMirror').textContent.includes('Line 1')`, 10000), 'and the editor shows them above the signature');
  ok(await evaluate(`(() => { const t = document.querySelector('.compose-pane .ProseMirror').textContent; const i = t.indexOf('Line 2'); return i >= 0 && !(window.__store.getState().compose.bodyHtml)})()`), 'and nothing was put after the signature');
  await clearCompose();
  // AC-8.10.3
  await clickLink('l3');
  await waitFor(`!!window.__store.getState().compose`, 5000);
  c = await compose();
  ok(c && (c.to || []).length === 0 && c.subject === 'Only subject', `AC-8.10.3: only a subject: ${JSON.stringify(c)}`);
  await clearCompose();
  // AC-8.10.4
  await clickLink('l4');
  await waitFor(`!!window.__store.getState().compose`, 5000);
  c = await compose();
  ok(c && JSON.stringify(c.to) === '["qa1@example.test"]' && !c.attachments?.length && c.accountId === 'a1' && !c.inReplyTo && !(c.references || []).length, `AC-8.10.4: attach, from and In-Reply-To are ignored: ${JSON.stringify(c)}`);
  await clearCompose();
  // AC-8.10.5
  await clickLink('l5');
  await waitFor(`!!window.__store.getState().compose`, 8000);
  c = await compose();
  ok(c && c.to.length === 50 && c.typedHtml.includes('x'.repeat(8000)) && !c.typedHtml.includes('x'.repeat(8001)), `AC-8.10.5: 50 recipients, the body cut at 8,000 (${c && c.to.length}, ${c && c.typedHtml.length})`);
  await clearCompose();
  // AC-8.10.6: middle click is a click; Shift opens the other place (a window when the setting is the pane)
  await clickLink('l1', 'middle');
  ok(await waitFor(`!!window.__store.getState().compose`, 5000), 'AC-8.10.6: a middle click starts the message too');
  await clearCompose();
  const before = await popouts();
  await clickLink('l1', 'left', 8);
  await sleep(600);
  ok(!(await evaluate(`!!window.__store.getState().compose`)) && (await popouts()) === before + 1, `Shift+click opens a window, not the pane (windows ${before} -> ${await popouts()})`);
  // AC-8.10.10: a web link still opens the browser; "Copy email address" still copies the address
  const o0 = await opened();
  await clickLink('l10');
  ok(await waitFor(`(window.__mockMail.opened.length) === ${o0 + 1}`, 4000), 'AC-8.10.10: an https link still opens the browser');
  ok(await evaluate(`!window.__store.getState().compose`), 'and starts no message');
  // the right-click menu of a mailto link: "Open link" is the same click, "Copy email address" is unchanged
  {
    const [x, y] = await linkPoint('l1');
    await mouse(x, y, 'right');
    const rows = await menuOpen();
    ok(rows && rows[0] === 'Open link' && rows[1] === 'Copy email address', `the link menu of a mailto link: ${JSON.stringify(rows)}`);
    await chooseRow('Open link');
    ok(await waitFor(`!!window.__store.getState().compose`, 5000), 'Open link of the menu starts the message too');
    await clearCompose();
  }

  // ------------------------------------------------------------------ a reader window
  tag = 'reader';
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=reader&thread=tw8-sel#lang=en&nativemenu=off&wp8` });
  ok(await waitFor(`!!document.querySelector('iframe.msg-frame') && !!document.querySelector('iframe.msg-frame').contentDocument.getElementById('q')`, 20000), 'the reader window started');
  await sleep(500);
  {
    // Copy subject on the title
    await clearSelection();
    const pt = await evaluate(`(() => { const r = document.querySelector('.rp-head h1').getBoundingClientRect(); return [r.left + 12, r.top + r.height / 2]; })()`);
    await mouse(pt[0], pt[1], 'right');
    const rows = await menuOpen();
    ok(rows && rows[0] === 'Copy subject', `AC-8.1.4: the title of a reader window has Copy subject first: ${JSON.stringify(rows)}`);
    await closeMenu();
    // AC-8.1.5: a word selected in the reader: the request goes to the main page
    const [x, y] = await framePoint('q', 10, 16);
    await mouse(x, y, 'right');
    const rows2 = await menuOpen();
    ok(rows2 && rows2.at(-1) === 'Search mail for “budget”', `a selection in the reader window: ${JSON.stringify(rows2)}`);
    await chooseRow('Search mail for');
    ok(await waitFor(`(window.__popoutRequests || []).some((r) => r.kind === 'search' && r.payload && r.payload.text === 'budget')`, 4000), 'AC-8.1.5: the reader asks the main page with the search request');
    ok(!(await evaluate(`window.__store.getState().search`)), 'and does not search in its own window');
  }
  {
    // an email link in the reader: a compose window of the main page, through compose-new with the fields
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=reader&thread=tw8-mailto#lang=en&nativemenu=off&wp8` });
    ok(await waitFor(`!!document.querySelector('iframe.msg-frame') && !!document.querySelector('iframe.msg-frame').contentDocument.getElementById('l2')`, 20000), 'the reader window with the links started');
    await sleep(500);
    const [x, y] = await linkPoint('l2');
    await mouse(x, y);
    ok(await waitFor(`(window.__popoutRequests || []).some((r) => r.kind === 'compose-new')`, 4000), 'AC-8.10.7: the reader asks the main page for a compose window');
    const req = await evaluate(`(window.__popoutRequests || []).filter((r) => r.kind === 'compose-new').pop().payload.init`);
    ok(req && JSON.stringify(req.to) === '["qa1@example.test","qa2@example.test"]' && JSON.stringify(req.cc) === '["qa3@example.test"]' && JSON.stringify(req.bcc) === '["qa4@example.test"]' && req.subject === 'Hello there' && req.bodyText === 'Line 1\nLine 2' && req.accountId === 'a1', `with the fields of the link: ${JSON.stringify(req)}`);
    ok(await evaluate(`!!document.querySelector('.reader-bar')`), 'and the reader window stays');
  }
  console.log(`test-ctx-search: ${checks} checks`);
} catch (e) {
  failures.push(`[${tag}] ${e.stack || e}`);
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`test-ctx-search: FAILED (${failures.length})\n  ` + failures.slice(0, 30).join('\n  '));
  process.exit(1);
}
console.log('test-ctx-search: ok');
