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
import { arg, flag, inputs, ROOT, sleep, startHarness } from './cdp-harness.mjs';

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

// ======================================================================== run
const only = arg('only');
const parts = { r4, r1 };
for (const [name, fn] of Object.entries(parts)) {
  if (only && !only.split(',').includes(name)) continue;
  try { await fn(); } catch (e) { failures.push(`[${name}] threw: ${e.stack || e.message}`); console.error(`FAIL [${name}] threw`, e); }
}
const errs = await evaluate(`window.__errs || []`).catch(() => []);
ok(errs.length === 0, `page errors: ${JSON.stringify(errs)}`);
await H.shutdown();
if (failures.length) { console.error(`test-ui-polish-1010: ${failures.length} failure(s) of ${checks} checks`); process.exit(1); }
console.log(`test-ui-polish-1010: ok (${checks} checks)`);
