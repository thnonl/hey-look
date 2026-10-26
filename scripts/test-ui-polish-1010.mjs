#!/usr/bin/env node
// 1.0.10 UI polish in the dev preview (src/devMock.ts has five mailboxes a1..a5 and PGP mail), driven over CDP:
//   R4  One Inbox (`*|inbox`) is always in Favorites: the star is a filled, aria-disabled button that does nothing; Settings > All accounts > Folders has the Inbox
//       switch on and disabled; setPrefs puts it back; stored favorites without it are read with it (rev 1 and rev 2); the stars of other rows still work
//   R1  a click, Enter or Space on the open conversation's row reloads nothing (no fetch, same `messages`, no removed card or iframe); another row opens as before;
//       a failed open is retried by the next click
//   R3  the account menu ends with "Account settings…" (rail avatar too), it opens Settings on that account's Profile; reauth keeps it enabled
//   R5  One Inbox has a menu with "All accounts settings…" (rail too), it opens All accounts > Folders; no other row gets one
//   R2  an account is dragged by its whole header, the rail avatar and the Settings nav entry; a click is still a click; no click after a drag; Escape cancels;
//       modifiers, other buttons and touch do not start a drag from the row (touch: only the grip)
//
//   node scripts/test-ui-polish-1010.mjs --require-browser
//   node scripts/test-ui-polish-1010.mjs --url=http://127.0.0.1:1420/ --shots=<dir>      use a dev server that is already running, PNGs of the lit states
import fs from 'node:fs';
import path from 'node:path';
import { arg, flag, inputs, languageJs, ROOT, sleep, startHarness } from './cdp-harness.mjs';
import { hitProbe } from './lib/settings-search-probe.mjs';

const SHOTS = arg('shots');
const H = await startHarness('test-ui-polish-1010', { vitePort0: 5660 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let section = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${section}] ${msg}`); console.error(`FAIL [${section}] ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const S = (expr) => `window.__store.getState().${expr}`;
const io = inputs(H, SHOTS, 'ui1010');

const VK = { Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ContextMenu: 93, Enter: 13, Space: 32 };
const press = async (key, modifiers = 0) => {
  const p = { key: key === 'Space' ? ' ' : key, code: key, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key], modifiers };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  if (key === 'Enter' || key === 'Space') await cdp('Input.dispatchKeyEvent', { type: 'char', ...p, text: key === 'Space' ? ' ' : '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
};
const centre = (selector, nth = 0) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, ...extra });
const rightClick = async (selector, nth = 0) => {
  const [x, y] = await centre(selector, nth);
  await mouse('mouseMoved', x, y);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
};
const until = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(expr); } catch { /* between two renders */ } if (v) return true; await sleep(25); } return false; };
/** The star of a row that is not a favorite shows on hover only: the pointer goes to the row first, as a person's would. */
const clickStar = async (rowSel) => { const [x, y] = await centre(rowSel); await mouse('mouseMoved', x, y); await sleep(60); await io.click(`${rowSel} .fp-star`); };
const prefsSaved = async () => JSON.parse(JSON.parse(await evaluate(`localStorage.getItem('hl-mock-settings')`)).prefs);

/** Opens the preview with stored settings (the dev preview keeps them in localStorage with #persist; a script before the page's own puts them there). */
async function openWith(hash, stored, w = 1280, h = 800) {
  const s = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('hl-mock-settings', ${JSON.stringify(JSON.stringify(stored))});` });
  try { await H.openApp(hash + '&persist', w, h); } finally { await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.identifier }); }
  await evaluate(`window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason))); 1`);
}
const fresh = async (hash = 'light&lang=en', w = 1280, h = 800) => { await openWith(hash, { prefs: JSON.stringify({ language: 'en', prefsRev: 2 }) }, w, h); };

const ONE = `.fp-row[data-key="inbox"]:not([data-acct])`;
const favRows = () => evaluate(`[...document.querySelectorAll('.fp-tree .fp-group:first-child .fp-row')].map((r) => (r.dataset.acct || '*') + '|' + r.dataset.key)`);

// ======================================================================== R4
async function r4() {
  section = 'R4';
  await fresh();
  const star = `${ONE} .fp-star`;
  const st = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(star)}); return { on: b.classList.contains('on'), aria: b.getAttribute('aria-disabled'), dis: b.disabled, title: b.title, label: b.getAttribute('aria-label'), cursor: getComputedStyle(b).cursor, filled: b.querySelector('svg').getAttribute('fill'), shown: getComputedStyle(b).display }; })()`);
  ok(st.on && st.aria === 'true' && st.dis === false, `the One Inbox star is on and aria-disabled, not disabled: ${JSON.stringify(st)}`);
  eq([st.title, st.label], ['The Inbox of all accounts always stays in Favorites', 'The Inbox of all accounts always stays in Favorites'], 'tooltip and name');
  ok(st.cursor === 'default' && st.filled === 'currentColor' && st.shown !== 'none', `cursor default, filled, shown: ${JSON.stringify(st)}`);
  await io.shot('r4-star-light');
  // three clicks: the row stays, the list does not open from the star
  const before = await evaluate(S('view?.key ?? null'));
  for (let i = 0; i < 3; i++) await io.click(star);
  await sleep(150);
  eq((await favRows()).slice(0, 3), ['*|inbox', '*|sent', '*|drafts'], 'favorites after 3 clicks');
  ok(!(await evaluate(`document.querySelector(${JSON.stringify(ONE)}).classList.contains('active')`)) || before !== undefined, 'the star click did not open the row');
  // keyboard: Tab order keeps it, Enter and Space do nothing
  await evaluate(`document.querySelector(${JSON.stringify(star)}).focus(); 1`);
  ok(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(star)})`), 'the locked star can be focused');
  await press('Enter'); await press('Space'); await sleep(150);
  eq((await favRows()).slice(0, 3), ['*|inbox', '*|sent', '*|drafts'], 'favorites after Enter and Space');
  // other rows still work: Sent (all accounts) off and on, an account's Inbox on and off
  await io.click(`.fp-tree .fp-group:first-child .fp-row[data-key="sent"] .fp-star`);
  await sleep(150);
  eq((await favRows()), ['*|inbox', '*|drafts'], 'Sent star removes the row');
  await clickStar(`.fp-tree .fp-group:nth-child(n+3) .fp-row[data-acct="a1"][data-key="inbox"]`);
  await sleep(150);
  ok((await evaluate(S('prefs.favorites'))).includes('a1|inbox'), "an account's Inbox star adds its row");
  await io.click(`.fp-tree .fp-group:first-child .fp-row[data-acct="a1"][data-key="inbox"] .fp-star`);
  await sleep(150);
  ok(!(await evaluate(S('prefs.favorites'))).includes('a1|inbox'), "...and removes it again");
  // the write guard (AC-4.6)
  await evaluate(`${S('setPrefs')}({ favorites: ['*|sent'] }); 1`);
  await sleep(150);
  eq(await evaluate(S('prefs.favorites')), ['*|inbox', '*|sent'], 'setPrefs puts One Inbox back at index 0');
  eq((await prefsSaved()).favorites, ['*|inbox', '*|sent'], '...and saves it so');
  await evaluate(`${S('setPrefs')}({ favorites: ['*|sent', '*|inbox'] }); 1`);
  eq(await evaluate(S('prefs.favorites')), ['*|sent', '*|inbox'], 'a list that has it is not reordered');

  // Settings > Mailboxes > All accounts > Folders
  await fresh();
  await evaluate(`${S('setDialog')}({ type: 'settings', tab: 'mb:all', section: 'folders', nonce: Date.now() }); 1`);
  ok(await until(`!!document.querySelector('#set-sec')`), 'Settings opened on All accounts > Folders');
  await sleep(300);
  const sw = await evaluate(`(() => { const rows = [...document.querySelectorAll('#set-sec .set-row')]; return rows.map((r) => ({ label: r.querySelector('.set-label, label, .set-lbl')?.textContent?.trim() || r.textContent.trim().slice(0, 40), text: r.textContent.trim(), dis: r.querySelector('input[type=checkbox]')?.disabled, on: r.querySelector('input[type=checkbox]')?.checked })); })()`);
  ok(sw.length >= 5, `the folder switches are there: ${JSON.stringify(sw)}`);
  const inbox = sw[0];
  ok(inbox.dis === true && inbox.on === true && inbox.text.includes('Always in Favorites'), `Inbox switch on, disabled, hint: ${JSON.stringify(inbox)}`);
  ok(sw.slice(1).every((r) => r.dis === false), `the other switches are enabled: ${JSON.stringify(sw.slice(1))}`);
  await io.shot('r4-settings-folders');
  // a click on the disabled switch changes nothing
  { const [x, y] = await centre('#set-sec .set-row .switch', 0); await io.clickAt(x, y); }
  await sleep(150);
  ok((await evaluate(S('prefs.favorites'))).includes('*|inbox'), 'a click on the Inbox switch keeps it');
  // another switch acts at once
  { const [x, y] = await centre('#set-sec .set-row .switch', 2); await io.clickAt(x, y); }
  await sleep(200);
  ok(!(await evaluate(S('prefs.favorites'))).includes('*|drafts') || !(await evaluate(S('prefs.favorites'))).includes('*|sent'), 'another switch changes its row');

  // stored favorites (AC-4.5, 4.7, 4.8, 4.9)
  await openWith('light&lang=en', { prefs: JSON.stringify({ language: 'en', prefsRev: 1, favorites: ['*|sent', '*|drafts'] }) });
  eq((await favRows()), ['*|inbox', '*|sent', '*|drafts'], 'rev 1 without One Inbox: first in the list');
  await evaluate(`${S('setPrefs')}({ focused: false }); 1`);
  await sleep(200);
  const sv = await prefsSaved();
  eq([sv.favorites, sv.prefsRev], [['*|inbox', '*|sent', '*|drafts'], 2], 'saved with One Inbox and rev 2');
  await openWith('light&lang=en', { prefs: JSON.stringify({ language: 'en', prefsRev: 2, favorites: ['*|sent'] }) });
  eq((await favRows()), ['*|inbox', '*|sent'], 'rev 2 without One Inbox: shown anyway');
  await openWith('light&lang=en', { prefs: JSON.stringify({ language: 'en', favorites: ['*|sent', '*|inbox'] }) });
  eq((await favRows()), ['*|sent', '*|inbox'], 'present: the order stays');
  await openWith('light&lang=en', { prefs: JSON.stringify({ language: 'en', prefsRev: 1, countOtherMail: false }) });
  eq(await evaluate(S('prefs.countOtherMail')), false, 'rev 1: countOtherMail stays false');
  // one account: the row is shown with a locked star
  await fresh();
  await evaluate(`window.__store.setState({ accounts: window.__store.getState().accounts.slice(0, 1) }); 1`);
  await sleep(200);
  ok(await evaluate(`document.querySelector(${JSON.stringify(star)})?.getAttribute('aria-disabled') === 'true'`), 'one account: the Favorites > Inbox row is there with a locked star');
}

// ======================================================================== R1
async function r1() {
  section = 'R1';
  await fresh('light&lang=en&smallmailbox');
  // the conversations: one with several messages and one more
  const ids = await evaluate(`window.__store.getState().threads.map((t) => [t.threadId, t.count ?? t.messageCount ?? 1])`);
  const multi = ids.find(([, n]) => n > 1)?.[0], other = ids.find(([id]) => id !== multi)?.[0];
  ok(multi && other, `the mock has a conversation with several messages and another one: ${JSON.stringify(ids.slice(0, 8))}`);
  const row = (id) => `.ml-row[data-thread="${id}"]`;
  const loaded = (id) => `${S('selected')} === ${JSON.stringify(id)} && ${S('messages.length')} > 0 && !!document.querySelector('.rp-msg')`;
  // what happens in the page: every get_thread call, every removed iframe / mail card / reading pane
  const probe = `(() => {
    const w = window; if (!w.__calls1) { w.__calls1 = []; const inv = w.__TAURI_INTERNALS__.invoke; w.__TAURI_INTERNALS__.invoke = function (cmd, ...a) { if (/^get_thread/.test(cmd)) w.__calls1.push(cmd); return inv.call(this, cmd, ...a); }; }
    w.__calls1.length = 0; w.__removed1 = []; w.__msgs1 = w.__store.getState().messages; w.__pend1 = 0;
    w.__obs1?.disconnect();
    w.__obs1 = new MutationObserver((list) => { for (const m of list) for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches('iframe, .rp-msg, .reading-pane, .rp-msg-body') || n.querySelector('iframe, .rp-msg'))) w.__removed1.push(n.className || n.tagName); });
    w.__obs1.observe(document.querySelector('.reading-region') || document.body, { childList: true, subtree: true });
    w.__txt1 = new MutationObserver(() => { if (/Opening message/.test(document.body.innerText)) w.__pend1++; });
    return 1; })()`;
  const state = () => evaluate(`({ calls: window.__calls1.length, removed: window.__removed1.slice(), same: window.__store.getState().messages === window.__msgs1, sel: ${S('selected')}, n: ${S('messages.length')}, err: ${S('openError')}, opening: /Opening message/.test(document.body.innerText) })`);

  await io.click(row(multi));
  ok(await until(loaded(multi)), 'the conversation opens');
  await sleep(500);
  // expand all messages (AC-1.2): the row click must not collapse them again
  const nmsg = await evaluate(S('messages.length'));
  await evaluate(`[...document.querySelectorAll('.rp-msg:not(.open) .rp-msg-head')].forEach((h) => h.click()); 1`);
  await sleep(200);
  const openBefore = await evaluate(`document.querySelectorAll('.rp-msg.open').length`);
  const scrollTop = await evaluate(`(() => { const e = document.querySelector('.rp-scroll, .rp-body, .reading-pane'); return e ? e.scrollTop : 0; })()`);
  await evaluate(probe);
  for (let i = 0; i < 5; i++) { await io.click(row(multi)); await sleep(i % 2 ? 30 : 160); }
  await evaluate(`document.querySelector(${JSON.stringify(row(multi))}).focus(); 1`);
  await press('Enter'); await sleep(120); await press('Space'); await sleep(250);
  let st = await state();
  eq([st.calls, st.removed, st.same, st.sel, st.opening], [0, [], true, multi, false], `re-click on the open mail (5 clicks, Enter, Space): no fetch, nothing removed, same messages array, no "Opening message"`);
  eq(await evaluate(`document.querySelectorAll('.rp-msg.open').length`), openBefore, 'the expanded messages stay expanded');
  ok(openBefore >= Math.min(nmsg, 2), `more than one message was expanded before: ${openBefore} of ${nmsg}`);
  ok((await evaluate(`document.querySelector(${JSON.stringify(row(multi))}).classList.contains('selected')`)), 'the row stays selected');

  // mark unread, then click the open row: it stays unread (Q3)
  await evaluate(`${S('act')}([${JSON.stringify(multi)}], 'unread'); 1`);
  await sleep(300);
  const unread0 = await evaluate(`${S('threads')}.find((t) => t.threadId === ${JSON.stringify(multi)}).unread`);
  await io.click(row(multi)); await sleep(300);
  eq(await evaluate(`${S('threads')}.find((t) => t.threadId === ${JSON.stringify(multi)}).unread`), unread0, 'Mark as unread, then a click on the open mail: it stays as it was');
  ok(unread0 === true || unread0 > 0, `the mail is unread after "Mark as unread": ${unread0}`);

  // another conversation opens as before
  await evaluate(probe);
  await io.click(row(other));
  ok(await until(loaded(other)), 'another row opens its conversation');
  st = await state();
  ok(st.calls >= 1, `another row fetches its thread: ${st.calls} call(s)`);
  ok(!st.same, 'another row replaces the messages');

  // a read in flight: a second click starts no second read
  await evaluate(`window.__mockDelays = { thread: 500 }; 1`);
  await evaluate(probe);
  await io.click(row(multi)); await sleep(100); await io.click(row(multi)); await sleep(100); await press('Enter');
  ok(await until(loaded(multi)), 'the slow read ends and shows the conversation');
  st = await state();
  eq(st.calls, 1, 'three clicks while the read is running: one get_thread');
  await evaluate(`window.__mockDelays = {}; 1`);

  // a failed open is tried again by the next click (AC-1.7)
  await evaluate(`window.__mockDelays = { thread: 20, threadFail: true }; 1`);
  await evaluate(probe);
  await io.click(row(other));
  ok(await until(`${S('openError')} === ${JSON.stringify(other)}`), 'the failed open is recorded');
  const failedCalls = (await state()).calls;
  ok(failedCalls >= 1, 'the failing read was made');
  await evaluate(`window.__mockDelays = {}; 1`);
  await io.click(row(other));
  ok(await until(loaded(other)), 'the next click on the failed row opens it');
  ok((await state()).calls > failedCalls, 'the retry made a new get_thread call');

  // a message being written: the click still leaves it, then shows the mail (AC-1.8)
  await evaluate(`${S('openCompose')}?.({ mode: 'new' }); 1`).catch(() => {});
  await sleep(400);
  if (await evaluate(`!!${S('compose')}`)) {
    await evaluate(probe);
    await io.click(row(other));
    ok(await until(`!${S('compose')} || document.querySelector('[role=dialog]')`), 'with Compose open the click leaves it (or asks)');
  }
}

// ======================================================================== R6
async function r6() {
  section = 'R6';
  const targets = [
    { tab: 'mb:all', focus: 'loadRemote', kind: 'row' }, { tab: 'about', focus: 'pg-about', kind: 'heading' }, { tab: 'appearance', focus: 'theme', kind: 'block' },
    { tab: 'about', focus: 'updateCheck', kind: 'control' },
  ];
  const runOne = async (label, w, h, lang, theme, forced) => {
    await openWith(`${theme}&lang=${lang}`, { prefs: JSON.stringify({ language: lang === 'en' ? 'en' : lang, prefsRev: 2 }) }, w, h);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: forced ? 'active' : 'none' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const t of targets) {
      await evaluate(`${S('setDialog')}(null); 1`);
      await sleep(150);
      await evaluate(`${S('setDialog')}({ type: 'settings', tab: ${JSON.stringify(t.tab)}, focus: ${JSON.stringify(t.focus)}, nonce: Date.now() }); 1`);
      const lit = await until(`!!document.getElementById('set-${t.focus}')?.classList.contains('set-hit')`);
      ok(lit, `${label} ${t.kind}: the target is lit`);
      if (!lit) continue;
      await sleep(150);
      const r = JSON.parse(await evaluate(hitProbe(t.focus, true)));
      const L = `${label} ${t.kind} ${t.focus}`;
      ok(r.bodyNoHScroll, `${L}: no horizontal scroll in the settings body`);
      if (t.kind === 'control') {
        ok(r.lit === 'element' && r.outline.style === 'solid' && parseFloat(r.outline.width) === 2, `${L}: a control is lit by its outline as before: ${JSON.stringify(r.outline)}`);
      } else {
        ok(r.lit === '::before' && r.outline.style === 'solid' && parseFloat(r.outline.width) === 2, `${L}: the ring is on the ::before: ${JSON.stringify(r.outline)}`);
        eq([r.outLeft, r.outRight], [10, 10], `${L}: the lit area is 10 px wider on both sides`);
        ok(Math.abs(r.labelLeft - r.labelLeftWithout) <= 0.5, `${L}: the label does not move (${r.labelLeftWithout} -> ${r.labelLeft})`);
        ok(Math.abs(r.hitLeft - (r.labelLeft - 10)) <= 1, `${L}: the fill starts 10 px left of the first letter (fill ${r.hitLeft}, letter ${r.labelLeft})`);
        ok(r.gapBarToLabel >= 6 - 0.5, `${L}: the bar is at least 6 px from the first letter (${r.gapBarToLabel})`);
        if (t.kind === 'row') ok(Math.abs(r.hitRight - (r.ctlRight + 10)) <= 1, `${L}: the fill ends 10 px right of the control (fill ${r.hitRight}, control ${r.ctlRight})`);
        ok(parseFloat(r.radius) === 10 || forced, `${L}: radius 10 px (${r.radius})`);
        if (!forced) ok(r.background !== 'rgba(0, 0, 0, 0)', `${L}: the fill is there (${r.background})`);
        // inside the 26 px of side padding: nothing is clipped
        const clip = await evaluate(`(() => { const e = document.getElementById('set-${t.focus}'), b = document.querySelector('.settings-body'), r = e.getBoundingClientRect(), br = b.getBoundingClientRect(); return [r.left - 10 - br.left, br.right - (r.right + 10)]; })()`);
        ok(clip[0] >= 0 && clip[1] >= 0, `${L}: the lit area is inside the settings body (${clip})`);
      }
      if (label.startsWith('en 1280') || forced) await io.shot(`r6-${t.kind}-${theme}${forced ? '-forced' : ''}`);
    }
  };
  for (const [w, h] of [[1280, 800], [960, 560]]) for (const theme of ['light', 'dark']) await runOne(`en ${w}x${h} ${theme}`, w, h, 'en', theme, false);
  await runOne('en 960x560 forced', 960, 560, 'en', 'light', true);
  for (const lang of ['de', 'ru']) await runOne(`${lang} 960x560 light`, 960, 560, lang, 'light', false);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // without a search the rows are the ones of 1.0.9: no rule of the highlight matches a row that is not lit
  await fresh();
  await evaluate(`${S('setDialog')}({ type: 'settings', tab: 'general', nonce: Date.now() }); 1`);
  ok(await until(`!!document.querySelector('.set-row')`), 'Settings open');
  const plain = await evaluate(`(() => { const r = document.querySelector('.set-row'), cs = getComputedStyle(r), b = getComputedStyle(r, '::before'); return { pos: cs.position, iso: cs.isolation, before: b.content, bg: cs.backgroundColor }; })()`);
  eq([plain.pos, plain.iso, plain.before], ['static', 'auto', 'none'], 'a row that is not lit has no position, no isolation, no ::before');
  const css = fs.readFileSync(path.join(ROOT, 'src/settingsSearch.css'), 'utf8');
  ok(!/\.set-row\s*[{,]/.test(css), 'settingsSearch.css has no rule on .set-row itself');
}

// ======================================================================== R3 + R5
const menuRows = () => evaluate(`[...document.querySelectorAll('.ctx-menu .menu-row')].map((b) => ({ text: b.querySelector('.menu-lbl')?.textContent, disabled: b.getAttribute('aria-disabled') === 'true' }))`);
const menuDividers = () => evaluate(`document.querySelectorAll('.ctx-menu .menu-div').length`);
const settingsShows = (tab, section) => evaluate(`(() => { const d = ${S('dialog')}; return !!d && d.type === 'settings' && d.tab === ${JSON.stringify(tab)} && d.section === ${JSON.stringify(section)}; })()`);
const closeMenu = async () => { await press('Escape'); await sleep(120); };
const shiftF10 = async () => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
};
const MENU = ['Move up', 'Move down', 'New folder…', 'Manage rules…', 'Account settings…'];

async function r3() {
  section = 'R3';
  await fresh();
  const head = (id) => `.fp-group[data-reorder-id="${id}"] .fp-head`;
  await rightClick(head('a2'));
  ok(await until(`!!document.querySelector('.ctx-menu')`), 'right-click on the 2nd mailbox opens its menu');
  eq((await menuRows()).map((r) => r.text), MENU, 'the entries, in order');
  eq(await menuDividers(), 1, 'one divider (before the extras), none before the new entry');
  await io.shot('r3-account-menu');
  await evaluate(`[...document.querySelectorAll('.ctx-menu .menu-row')].pop().click(); 1`);
  ok(await until(`!!document.querySelector('#set-sec')`), 'Settings opens');
  ok(await settingsShows('mb:a2', 'profile'), 'on the profile of that mailbox');
  await sleep(300);
  const pg = await evaluate(`({ nav: [...document.querySelectorAll('.settings-nav button.active')].map((b) => b.textContent.trim()), focus: document.activeElement?.id, aria: document.activeElement?.getAttribute('aria-label'), text: document.querySelector('.settings-body')?.innerText.slice(0, 600) })`);
  ok(pg.focus === 'set-sec' && pg.aria === 'Profile' && /Display name/.test(pg.text) && /Reply-to/i.test(pg.text) && /Color/.test(pg.text), `Profile shown, focus in the section: ${JSON.stringify(pg)}`);
  await io.shot('r3-settings-profile');
  const email = await evaluate(`${S('accounts')}.find((a) => a.id === 'a2').email`);
  ok((await evaluate(`document.querySelector('.settings-body').innerText`)).includes(email), `the page is the 2nd mailbox (${email})`);
  await evaluate(`${S('setDialog')}(null); 1`);
  await sleep(300);

  // the keyboard: Shift+F10 / ContextMenu key, arrows, Enter; Escape returns to the header
  await fresh();
  for (const how of ['ContextMenu', 'Shift+F10']) {
    await evaluate(`document.querySelector(${JSON.stringify(head('a3'))}).focus(); 1`);
    if (how === 'ContextMenu') await press('ContextMenu'); else await shiftF10();
    ok(await until(`!!document.querySelector('.ctx-menu')`), `${how}: the menu opens`);
    eq(await evaluate(`document.activeElement?.querySelector?.('.menu-lbl')?.textContent`), 'Move up', `${how}: the first entry is focused`);
    await closeMenu();
    ok(await until(`document.activeElement === document.querySelector(${JSON.stringify(head('a3'))})`), `${how}: Escape gives the focus back to the header`);
  }
  await press('ContextMenu');
  await until(`!!document.querySelector('.ctx-menu')`);
  for (let i = 0; i < 4; i++) await press('ArrowDown');
  eq(await evaluate(`document.activeElement?.querySelector?.('.menu-lbl')?.textContent`), 'Account settings…', 'the arrows reach the new entry');
  await press('Enter');
  ok((await until(`!!document.querySelector('#set-sec')`)) && (await settingsShows('mb:a3', 'profile')), 'Enter opens the profile of the 3rd mailbox');
  await evaluate(`${S('setDialog')}(null); 1`);
  ok(await until(`document.activeElement === document.querySelector(${JSON.stringify(head('a3'))})`), 'after Settings closes the focus is back on the header');

  // a mailbox that needs a new sign-in: New folder is off, Account settings is on (AC-3.6)
  await fresh();
  await evaluate(`window.__store.setState({ reauth: { a2: 'again' } }); 1`);
  await sleep(150);
  await rightClick(head('a2'));
  await until(`!!document.querySelector('.ctx-menu')`);
  const rr = await menuRows();
  ok(rr[2].disabled && !rr[4].disabled && rr[4].text === 'Account settings…', `reauth: New folder is off, Account settings is on: ${JSON.stringify(rr)}`);
  await closeMenu();

  // the icon column: right-click the 3rd avatar (AC-3.2)
  await fresh('light&lang=en', 960, 700);
  ok(await until(`!!document.querySelector('.is-rail')`), 'the menu is the icon column at 960 px');
  await rightClick('.is-rail .fp-avatar', 2);
  ok(await until(`!!document.querySelector('.ctx-menu')`), 'right-click on an avatar opens the menu');
  eq((await menuRows()).map((r) => r.text), MENU, 'the rail menu has the same entries');
  await evaluate(`[...document.querySelectorAll('.ctx-menu .menu-row')].pop().click(); 1`);
  ok((await until(`!!document.querySelector('#set-sec')`)) && (await settingsShows('mb:a3', 'profile')), 'the 3rd avatar opens the 3rd mailbox profile');
  await evaluate(`${S('setDialog')}(null); 1`);

  // one account: Move up / down are off, the new entry works (AC-3.7)
  await fresh();
  await evaluate(`window.__store.setState({ accounts: window.__store.getState().accounts.slice(0, 1) }); 1`);
  await sleep(200);
  await rightClick(head('a1'));
  await until(`!!document.querySelector('.ctx-menu')`);
  const one = await menuRows();
  ok(one[0].disabled && one[1].disabled && !one[4].disabled, `one account: ${JSON.stringify(one)}`);
  await closeMenu();
}

async function r5() {
  section = 'R5';
  await fresh();
  await rightClick(ONE);
  ok(await until(`!!document.querySelector('.ctx-menu')`), 'right-click on One Inbox opens a menu');
  eq((await menuRows()).map((r) => r.text), ['All accounts settings…'], 'one entry');
  await io.shot('r5-one-inbox-menu');
  await evaluate(`document.querySelector('.ctx-menu .menu-row').click(); 1`);
  ok(await until(`!!document.querySelector('#set-sec')`), 'Settings opens');
  ok(await settingsShows('mb:all', 'folders'), 'on All accounts > Folders');
  await sleep(400);
  const pg = await evaluate(`({ h: document.querySelector('.settings-body h3')?.textContent?.trim(), nav: [...document.querySelectorAll('.settings-nav button.active')].map((b) => b.textContent.trim()), focus: document.activeElement?.id, aria: document.activeElement?.getAttribute('aria-label'), sw: !!document.querySelector('#set-sec input[type=checkbox]:disabled:checked') })`);
  ok(pg.h === 'All accounts' && pg.nav.includes('Folders') && pg.focus === 'set-sec' && pg.aria === 'Folders' && pg.sw, `All accounts, Folders lit, focus on the section, the locked Inbox switch is there: ${JSON.stringify(pg)}`);
  await io.shot('r5-settings');
  await evaluate(`${S('setDialog')}(null); 1`);
  await sleep(300);
  // the keyboard: the focused row, ContextMenu key or Shift+F10, Enter; Escape returns to the row
  await fresh();
  await evaluate(`document.querySelector(${JSON.stringify(ONE)}).focus(); 1`);
  await press('ContextMenu');
  ok(await until(`!!document.querySelector('.ctx-menu')`), 'the ContextMenu key opens the menu on the row');
  eq(await evaluate(`document.activeElement?.querySelector?.('.menu-lbl')?.textContent`), 'All accounts settings…', 'the entry is focused');
  await closeMenu();
  ok(await until(`document.activeElement === document.querySelector(${JSON.stringify(ONE)})`), 'Escape gives the focus back to the row');
  await shiftF10();
  ok(await until(`!!document.querySelector('.ctx-menu')`), 'Shift+F10 opens it too');
  await press('Enter');
  ok((await until(`!!document.querySelector('#set-sec')`)) && (await settingsShows('mb:all', 'folders')), 'Enter opens All accounts > Folders');
  await evaluate(`${S('setDialog')}(null); 1`);
  await sleep(300);
  // a left click still opens One Inbox
  await fresh();
  await io.click(`.fp-row[data-key="sent"]:not([data-acct])`);
  await sleep(300);
  await io.click(ONE);
  ok(await until(`${S('folder')} === 'inbox' && ${S('accountId')} === null`), 'a left click opens One Inbox');
  // no other row of Favorites or Quick views has a menu
  for (const sel of [`.fp-row[data-key="sent"]:not([data-acct])`, `.fp-row[data-key="unread"]`, `.fp-row[data-acct="a1"][data-key="inbox"]`]) {
    await rightClick(sel);
    await sleep(200);
    ok(!(await evaluate(`!!document.querySelector('.ctx-menu')`)), `no app menu on ${sel}`);
    await closeMenu();
  }
  // the icon column: the Inbox icon under the first separator (AC-5.2)
  await fresh('light&lang=en', 960, 700);
  ok(await until(`!!document.querySelector('.is-rail')`), 'icon column at 960 px');
  await rightClick(`.is-rail ${ONE}`);
  ok(await until(`!!document.querySelector('.ctx-menu')`), 'right-click on the Inbox icon opens the menu');
  eq((await menuRows()).map((r) => r.text), ['All accounts settings…'], 'rail: one entry');
  await evaluate(`document.querySelector('.ctx-menu .menu-row').click(); 1`);
  ok((await until(`!!document.querySelector('#set-sec')`)) && (await settingsShows('mb:all', 'folders')), 'rail: opens All accounts > Folders');
  await evaluate(`${S('setDialog')}(null); 1`);
  // one account
  await fresh();
  await evaluate(`window.__store.setState({ accounts: window.__store.getState().accounts.slice(0, 1) }); 1`);
  await sleep(200);
  await rightClick(ONE);
  ok(await until(`!!document.querySelector('.ctx-menu')`), 'one account: the menu is there too');
  await closeMenu();
}

// ======================================================================== R2
const order = () => evaluate(`${S('accounts')}.map((a) => a.id).join()`);
const rectOf = (selector, nth = 0) => evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
const down = (x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, ...extra });
const moveTo = (x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, ...extra });
const up = (x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, ...extra });
const reordering = () => evaluate(`document.body.classList.contains('reordering')`);
const liveText = () => evaluate(`[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join('|')`);
const gid = (id) => `.fp-group[data-reorder-id="${id}"]`;

async function r2() {
  section = 'R2';
  // ---- the header, by its name (AC-2.1, 2.2)
  await fresh();
  eq(await order(), 'a1,a2,a3,a4,a5', 'the order to start from');
  const collapsedBefore = await evaluate(S('prefs.collapsed'));
  const hd = await rectOf(`${gid('a4')} .fp-head .fp-acct`);
  const gap = await rectOf(`${gid('a2')} .fp-head`);
  await moveTo(hd.x, hd.y, { buttons: 0, button: 'none' });
  await down(hd.x, hd.y);
  await moveTo(hd.x, hd.y - 10);
  await moveTo(hd.x, hd.y - 80);
  await moveTo(gap.x, gap.top + 4);
  ok(await until(`!!document.querySelector('.reorder-ghost') && !!document.querySelector('.reorder-line') && document.body.classList.contains('reordering')`), 'dragging a mailbox by its name shows the ghost and the line, the cursor is grabbing');
  const line = await evaluate(`(() => { const l = document.querySelector('.reorder-line').getBoundingClientRect(), a = document.querySelector(${JSON.stringify(gid('a1'))}).getBoundingClientRect(), b = document.querySelector(${JSON.stringify(gid('a2'))}).getBoundingClientRect(); return { top: l.top, a1Bottom: a.bottom, a2Top: b.top, srcDim: document.querySelector(${JSON.stringify(gid('a4'))}).classList.contains('reorder-src'), cursor: getComputedStyle(document.body).cursor }; })()`);
  ok(Math.abs(line.top - line.a1Bottom) <= 3 && line.srcDim && line.cursor === 'grabbing', `the line is in the gap between 1 and 2, the source is dimmed: ${JSON.stringify(line)}`);
  await io.shot('r2-header-drag');
  await up(gap.x, gap.top + 4);
  await until(`${S('accounts')}.map((a) => a.id).join() !== 'a1,a2,a3,a4,a5'`);
  eq(await order(), 'a1,a4,a2,a3,a5', 'a4 lands at position 2');
  await sleep(250);
  eq(await evaluate(S('prefs.collapsed')), collapsedBefore, 'no collapse toggle after the drop');
  ok(await evaluate(`document.querySelector(${JSON.stringify(gid('a4') + ' .fp-head')}).getAttribute('aria-expanded') === 'true'`), 'its group stays expanded');
  ok(!(await reordering()), 'the drag is over');
  eq((await prefsSaved()).accountOrder, ['a1', 'a4', 'a2', 'a3', 'a5'], 'saved');
  // reload: the order stays, and Settings and the pickers list it so (AC-2.2)
  await H.openApp('light&lang=en&persist', 1280, 800);
  eq(await order(), 'a1,a4,a2,a3,a5', 'after a reload');
  await evaluate(`${S('setDialog')}({ type: 'settings', tab: 'general', nonce: Date.now() }); 1`);
  await until(`!!document.querySelector('.nav-acct')`);
  eq(await evaluate(`[...document.querySelectorAll('.nav-acct')].map((e) => e.dataset.reorderId).join()`), 'a1,a4,a2,a3,a5', 'Settings > Mailboxes lists them in the new order');
  await evaluate(`${S('setDialog')}(null); 1`);

  // ---- a press that stays under 4 px is a click (AC-2.5); nothing after a drag opens (AC-2.2), Escape cancels (AC-2.6)
  await fresh();
  const h1 = await rectOf(`${gid('a1')} .fp-head`);
  await down(h1.x, h1.y); await moveTo(h1.x + 2, h1.y + 1); await up(h1.x + 2, h1.y + 1);
  await sleep(200);
  eq(await evaluate(`!!${S('prefs.collapsed')}['a1']`), true, 'a press and release under 4 px collapses the group');
  ok(!(await reordering()) && (await order()) === 'a1,a2,a3,a4,a5', 'no drag from a short press');
  await io.click(`${gid('a1')} .fp-head`);
  await sleep(200);
  eq(await evaluate(`!!${S('prefs.collapsed')}['a1']`), false, 'a plain click expands it again');
  // Escape
  const h3 = await rectOf(`${gid('a3')} .fp-head`);
  await down(h3.x, h3.y); await moveTo(h3.x, h3.y - 20); await moveTo(h3.x, h3.y - 90);
  ok(await until(`!!document.querySelector('.reorder-ghost')`), 'a drag is on');
  await press('Escape');
  await sleep(150);
  ok(!(await evaluate(`!!document.querySelector('.reorder-ghost')`)) && !(await reordering()), 'Escape ends the drag');
  ok((await liveText()).includes('Reordering cancelled'), `cancelled is announced: ${await liveText()}`);
  await moveTo(h3.x, h3.y); await up(h3.x, h3.y);
  await sleep(250);
  eq(await order(), 'a1,a2,a3,a4,a5', 'the order is unchanged after Escape');
  eq(await evaluate(`!!${S('prefs.collapsed')}['a3']`), false, 'the release after Escape toggles nothing');

  // ---- what does not start a drag: a modifier, the right button, the warning icon
  for (const [name, mod] of [['Ctrl', 2], ['Shift', 8], ['Alt', 1], ['Meta', 4]]) {
    await down(h3.x, h3.y, { modifiers: mod }); await moveTo(h3.x, h3.y - 30, { modifiers: mod }); await moveTo(h3.x, h3.y - 90, { modifiers: mod });
    await sleep(120);
    ok(!(await reordering()) && !(await evaluate(`!!document.querySelector('.reorder-ghost')`)), `${name}+press and move starts no drag`);
    await up(h3.x, h3.y - 90, { modifiers: mod });
    await sleep(80);
  }
  eq(await order(), 'a1,a2,a3,a4,a5', 'no modifier press moved anything');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: h3.x, y: h3.y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h3.x, y: h3.y - 60, button: 'right', buttons: 2 });
  ok(!(await reordering()), 'a right-button press starts no drag');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h3.x, y: h3.y - 60, button: 'right', buttons: 0, clickCount: 1 });
  await closeMenu();
  // the warning icon of a mailbox with a sync error: a press on it is its own click, no drag
  await evaluate(`window.__store.setState({ syncErrors: { a3: 'mock: sign-in failed' } }); 1`);
  await sleep(200);
  if (await evaluate(`!!document.querySelector(${JSON.stringify(gid('a3') + ' .fp-warn')})`)) {
    const w = await rectOf(`${gid('a3')} .fp-warn`);
    await down(w.x, w.y); await moveTo(w.x, w.y - 30); await moveTo(w.x, w.y - 90);
    ok(!(await reordering()), 'a press on the warning icon starts no drag');
    await up(w.x, w.y - 90);
    await sleep(100);
  }
  await evaluate(`window.__store.setState({ syncErrors: {} }); 1`);

  // ---- touch: only the grip drags (Q4)
  await fresh();
  const touch = async (type, x, y) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const th = await rectOf(`${gid('a3')} .fp-head`);
  await touch('touchStart', th.x, th.y); await touch('touchMove', th.x, th.y - 20); await touch('touchMove', th.x, th.y - 90);
  ok(!(await reordering()), 'a touch drag on the header starts no reorder');
  await touch('touchEnd', th.x, th.y - 90);
  await sleep(150);
  eq(await order(), 'a1,a2,a3,a4,a5', 'a touch drag on the header moved nothing');

  // ---- the rail: the avatar (AC-2.3)
  await fresh('light&lang=en', 960, 900);
  ok(await until(`!!document.querySelector('.is-rail')`), 'icon column');
  const selBefore = await evaluate(`[${S('folder')}, ${S('accountId')}].join('|')`);
  const av1 = await rectOf('.is-rail .fp-avatar', 0), av3 = await rectOf('.is-rail .fp-avatar', 2);
  await down(av1.x, av1.y); await moveTo(av1.x, av1.y + 12); await moveTo(av1.x, av3.y + 8);
  ok(await until(`!!document.querySelector('.reorder-line')`), 'the line shows in the icon column');
  const rail = await evaluate(`(() => { const l = document.querySelector('.reorder-line').getBoundingClientRect(), p = document.querySelector('.folder-pane').getBoundingClientRect(); return { left: l.left, width: l.width, pane: p.width }; })()`);
  ok(rail.width >= 36 && rail.width <= rail.pane, `the line spans the rail: ${JSON.stringify(rail)}`);
  await up(av1.x, av3.y + 8);
  await until(`${S('accounts')}.map((a) => a.id).join() !== 'a1,a2,a3,a4,a5'`);
  eq(await order(), 'a2,a3,a1,a4,a5', 'the 1st avatar lands below the 3rd');
  await sleep(250);
  eq(await evaluate(`[${S('folder')}, ${S('accountId')}].join('|')`), selBefore, 'the drop opened no Inbox');
  // a click on an avatar still opens its Inbox
  await io.click('.is-rail .fp-avatar', 'first');
  ok(await until(`${S('accountId')} === ${JSON.stringify((await order()).split(',')[0])}`), 'a click on an avatar opens its Inbox');

  // ---- the Settings navigation (AC-2.4)
  await fresh();
  await evaluate(`${S('setDialog')}({ type: 'settings', tab: 'general', nonce: Date.now() }); 1`);
  await until(`document.querySelectorAll('.nav-acct').length === 5`);
  const n4 = await rectOf('.nav-acct > button', 3), n1 = await rectOf('.nav-acct > button', 0);
  await down(n4.x, n4.y); await moveTo(n4.x, n4.y - 15); await moveTo(n1.x, n1.top + 2);
  ok(await until(`!!document.querySelector('.reorder-ghost')`), 'dragging a mailbox of the Settings navigation by its address shows the preview');
  await up(n1.x, n1.top + 2);
  await until(`${S('accounts')}.map((a) => a.id).join() !== 'a1,a2,a3,a4,a5'`);
  eq(await order(), 'a4,a1,a2,a3,a5', 'the 4th lands first');
  await sleep(250);
  ok(await evaluate(`${S('dialog')}.tab === 'general' && !!document.getElementById('set-pg-general')`), 'the page did not change because of the release');
  // a plain click on the entry opens its page
  await io.click('.nav-acct > button', 'first');
  ok(await until(`${S('dialog')}?.tab === 'mb:a4' || !!document.querySelector('.settings-nav button.active.has-sub')`), 'a click on the entry opens the mailbox page');
  await evaluate(`${S('setDialog')}(null); 1`);

  // ---- the keyboard way stays (AC-2.8)
  await fresh();
  await evaluate(`document.querySelector(${JSON.stringify(gid('a2') + ' .fp-head')}).focus(); 1`);
  await press('ArrowDown', 1);
  await until(`${S('accounts')}.map((a) => a.id).join() !== 'a1,a2,a3,a4,a5'`);
  eq(await order(), 'a1,a3,a2,a4,a5', 'Alt+Down moves the mailbox');
  ok((await liveText()).includes('position 3 of 5'), `announced: ${await liveText()}`);

  // ---- auto-scroll at the bottom of a short window (AC-2.7)
  await fresh('light&lang=en', 1280, 560);
  const sc = await evaluate(`(() => { const t = document.querySelector('.fp-tree'), s = document.querySelector('.fp-surface'); const el = [t, s, t.parentElement].find((e) => e.scrollHeight > e.clientHeight + 4); return el ? { cls: el.className, over: el.scrollHeight - el.clientHeight } : null; })()`);
  ok(sc && sc.over > 40, `the menu is taller than the window: ${JSON.stringify(sc)}`);
  const a1 = await rectOf(`${gid('a1')} .fp-head`);
  const box = await evaluate(`(() => { const t = document.querySelector('.fp-tree'); let p = t; while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; const r = p.getBoundingClientRect(); return { bottom: r.bottom, top: r.top }; })()`);
  await down(a1.x, a1.y); await moveTo(a1.x, a1.y + 20); await moveTo(a1.x, box.bottom - 6);
  await sleep(1200);
  const scrolled = await evaluate(`(() => { const t = document.querySelector('.fp-tree'); let p = t; while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; return p.scrollTop; })()`);
  ok(scrolled > 20, `the pane scrolled while the pointer rested near the bottom edge: ${scrolled}`);
  await up(a1.x, box.bottom - 6);
  await until(`${S('accounts')}.map((a) => a.id).join() !== 'a1,a2,a3,a4,a5'`);
  ok((await order()).split(',').indexOf('a1') >= 3, `the drop below the visible part works: ${await order()}`);

  // ---- one account: no drag from anywhere (AC-2.9)
  await fresh();
  await evaluate(`window.__store.setState({ accounts: window.__store.getState().accounts.slice(0, 1) }); 1`);
  await sleep(200);
  const o1 = await rectOf(`${gid('a1')} .fp-head`);
  await down(o1.x, o1.y); await moveTo(o1.x, o1.y + 10); await moveTo(o1.x + 20, o1.y + 1);
  ok(!(await reordering()), 'one account: no drag');
  await up(o1.x + 20, o1.y + 1);
  await sleep(200);
  eq(await evaluate(`!!${S('prefs.collapsed')}['a1']`), true, 'one account: the press is a normal click');
}

// ======================================================================== run
const only = arg('only');
const parts = { r4, r1, r6, r3, r5, r2 };
for (const [name, fn] of Object.entries(parts)) {
  if (only && !only.split(',').includes(name)) continue;
  try { await fn(); } catch (e) { failures.push(`[${name}] threw: ${e.stack || e.message}`); console.error(`FAIL [${name}] threw`, e); }
}
const errs = await evaluate(`window.__errs || []`).catch(() => []);
ok(errs.length === 0, `page errors: ${JSON.stringify(errs)}`);
await H.shutdown();
if (failures.length) { console.error(`test-ui-polish-1010: ${failures.length} failure(s) of ${checks} checks`); process.exit(1); }
console.log(`test-ui-polish-1010: ok (${checks} checks)`);
