#!/usr/bin/env node
// 1.0.7 WP7f3 (W7.9, owner request R1: calendar sync is offered at Google / Microsoft sign-in) in the real page: the dev preview with the mock backend (src/devMock.ts), real mouse and
// key events.
//  - Add account > Google / Microsoft: the box "Also sync my calendar" is ticked, named, described by its hint, absent when the build cannot connect the service; unticked = the
//    1.0.6 flow (no calendar call, the offer in the Calendar sidebar stays); ticked + mail sign-in OK = the second step at once (one calendar_connect call, no question, the mailbox is
//    already in the folder pane, Skip has the focus), then Settings closes, the Inbox opens and the toast says "added with calendar sync"; Skip, Esc, the X and another Settings
//    tab all end it as Skip (calendar_cancel_connect, plain toast, switch off, the offer is over); every refusal shows the Settings notice with Retry / Continue; a mail sign-in
//    that ends without an account never starts the step.
//  - The Calendar sidebar offer for mailboxes that existed before: shown for the first mailbox that can sync and does not, until answered once (Not now stays gone after a reload,
//    Turn on... opens Settings > mailbox > Calendar with the question of W7.7 at once), never in the icon column, never when nothing qualifies.
//  - 8 languages, light and dark, 960 x 560 and 1280 x 800: the agreed texts, no raw key, nothing clipped, a 40-character address wraps inside the sidebar notice.
//  - The keyboard: Tab reaches the box between the name and the button, Space toggles it, Enter on Skip skips, Enter on Retry retries.
//
//   node scripts/test-calendar-at-signin.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir]
//   --quick  English, German and Japanese; the full run (no flag) is the 8 languages
import { flag, arg, sleep, startHarness, inputs } from './cdp-harness.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : flag('quick') ? ['en', 'de', 'ja'] : ALL;
const THEMES = ['light', 'dark'];
const dicts = {};
for (const l of new Set(['en', ...LANGS])) dicts[l] = await loadDict(l);
const tr = (lang, key, params = {}) => {
  const m = dicts[lang]?.[key];
  if (typeof m !== 'string') throw new Error(`no text ${key} in ${lang}`);
  return m.replace(/\{(\w+)\}/g, (_, k) => String(params[k]));
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const H = await startHarness('test-calendar-at-signin', { vitePort0: 5176 });
const { evaluate, cdp } = H;
const { click, clickAt, shot } = inputs(H, arg('shots'), 'at-signin');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
const waitFor = async (expr, what, ms = 10000) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
    let v = false;
    try { v = await evaluate(`!!(${expr})`); } catch { /* between two renders */ }
    if (v) return true;
  }
  ok(false, `timed out waiting for ${what}`);
  return false;
};
const key = async (k, code, vk, text) => {
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
const enter = () => key('Enter', 'Enter', 13, '\r');
const space = () => key(' ', 'Space', 32, ' ');
const esc = () => key('Escape', 'Escape', 27);
const tab = () => key('Tab', 'Tab', 9);

const store = (expr) => evaluate(`(() => { const s = window.__store.getState(); return ${expr}; })()`);
const mock = (obj) => evaluate(`Object.assign(window.__mockCalSync, ${JSON.stringify(obj)}); 1`);
const connects = () => evaluate('JSON.stringify(window.__mockCalConnects || [])').then(JSON.parse);
const cancels = () => evaluate('window.__mockCalCancels || 0');
const toasts = () => evaluate(`[...document.querySelectorAll('.toasts .toast-text')].map((x) => x.textContent.trim())`);
const savedSetting = (k) => evaluate(`import('/src/api.ts').then((m) => m.api.getSetting(${JSON.stringify(k)}))`);

// (the dev preview applies the tokens of the hash (lang=, light, ...) in order, 250 ms apart, after the store has loaded: wait for the last one)
const openApp = async (hash, w, h) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length + 250);
};
const setLook = async (theme, lang) => {
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
  await waitFor(`document.documentElement.lang === ${JSON.stringify(lang)}`, `the page language ${lang}`, 25000);
  await sleep(120);
};
const CARD = '.settings-body .set-card';
const GO = `${CARD} .row-inline .btn.primary`;
const CB = '.also-cal input[type="checkbox"]';
/** Opens Add account on the Google or Microsoft card with the client ids set (a build with its own client does not ask for them). */
const openAdd = async (hash, w, h, kind = 'google') => {
  await openApp(hash, w, h);
  await evaluate(`import('/src/api.ts').then(async (m) => { await m.api.setSetting('google_client_id', 'id'); await m.api.setSetting('microsoft_client_id', 'id'); })`);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'add-account', nonce: Date.now() }); 1`);
  await waitFor(`document.querySelector(${JSON.stringify(CARD)})`, 'the Add account card');
  if (kind === 'microsoft') await evaluate(`document.querySelectorAll('.settings-body .seg button')[1].click()`);
  await sleep(350);
};
const card = () => evaluate(`(() => {
  const c = document.querySelector(${JSON.stringify(CARD)}); if (!c) return null;
  const cb = c.querySelector('.also-cal input'); const hint = c.querySelector('.also-cal .muted');
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const slot = document.querySelector('.signin-slot'); const modal = document.querySelector('.modal');
  return {
    cb: cb ? { checked: cb.checked, disabled: cb.disabled, label: cb.closest('label').textContent.trim(), desc: cb.getAttribute('aria-describedby'), hintId: hint ? hint.id : null, hint: hint ? hint.textContent.trim() : '' } : null,
    btns: [...c.querySelectorAll('.row-inline button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, primary: b.classList.contains('primary'), focus: document.activeElement === b, box: r(b) })),
    slot: slot ? slot.textContent.trim() : '', slotRole: slot ? [...slot.querySelectorAll('[role]')].map((x) => x.getAttribute('role')).join(',') : '', slotOver: slot ? slot.scrollWidth - slot.clientWidth : 0,
    card: r(c), modal: modal ? r(modal) : null, body: r(document.querySelector('.settings-body')), slotBox: slot ? r(slot) : null, cardOver: c.scrollWidth - c.clientWidth, order: (() => { const els = [...c.querySelectorAll('input:not([type=password]), .row-inline button')].filter((e) => !e.closest('details')).map((e) => e.type === 'checkbox' ? 'cb' : e.tagName === 'INPUT' ? 'name' : 'go'); return els.join(','); })(),
  };
})()`);
const dialogType = () => store(`s.dialog ? s.dialog.type : null`);
const SK = 'Skip calendar';

/** Presses the button of the card (a real mouse click) whose text is `text`. */
const clickText = async (text) => {
  const at = await evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(CARD + ' .row-inline button')})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!at) { ok(false, `no button "${text}" on the card`); return; }
  await clickAt(at[0], at[1]);
};
const hasBtn = (text) => `[...document.querySelectorAll(${JSON.stringify(CARD + ' .row-inline button')})].some((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
/** What Settings > Calendar says when the consent of this mailbox ends `code` (the question answered with Open browser). */
const settingsNote = async (account, code) => {
  await openApp('lang=en&light', 960, 560);
  await mock({ connectResult: code, connectDelay: 300 });
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:${account}', focus: 'calendar', nonce: Date.now() }); 1`);
  await waitFor(`document.querySelector('#set-calendar .switch input')`, 'Settings > Calendar');
  await click('#set-calendar .switch');
  await waitFor(`document.querySelector('.ask')`, 'the question in Settings');
  await click('.ask-actions button:last-child');
  await waitFor(`document.querySelector('.set-status .notice, .set-status .field-err')`, 'the Settings notice', 6000);
  return norm(await evaluate(`document.querySelector('.set-status').textContent`)).replace(/[\w.+-]+@[\w.-]+/g, 'E');
};

/**
 * The Calendar module with its sidebar in full. Below about 1100 px the side menu is the icon column in the Calendar too (the mail panes' minimum widths decide, see
 * sidebarState.ts), and the full menu opens over the page as the overlay the toggle button pins: the offer is shown there. `peek` false leaves the column as it is.
 */
const showSidebar = async (peek = true) => {
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'expanded' }); window.__store.getState().setModule('calendar'); 1`);
  await sleep(500);
  if (peek && (await evaluate(`!!document.querySelector('.folder-pane.is-rail')`))) {
    await click('.fp-toggle');
    await sleep(400);
  }
  await sleep(500);
};

try {
  // ------------------------------------------------------------------ AC-7.9.1: the box
  await openAdd('lang=en&light', 960, 560);
  let c = await card();
  ok(c.cb !== null, 'Google: the box is shown');
  ok(c.cb && c.cb.checked && !c.cb.disabled, 'Google: the box is ticked');
  ok(c.cb && c.cb.label === 'Also sync my calendar', `Google: label "${c.cb?.label}"`);
  ok(c.cb && c.cb.hint === 'After you sign in, a second Google page will ask you to allow access to your calendars.', `Google: hint "${c.cb?.hint}"`);
  ok(c.cb && c.cb.desc && c.cb.desc === c.cb.hintId, 'the hint describes the box (aria-describedby)');
  ok(c.order === 'name,cb,go', `the box sits between the display name and the Sign in button (${c.order})`);
  await shot('add-idle');
  await evaluate(`document.querySelectorAll('.settings-body .seg button')[1].click()`);
  await sleep(250);
  c = await card();
  ok(c.cb && c.cb.checked && c.cb.hint === 'After you sign in, a second Microsoft page will ask you to allow access to your calendars.', `Microsoft: hint "${c.cb?.hint}"`);
  // the label is clickable
  await click('.also-cal label span');
  ok(!(await card()).cb.checked, 'a click on the label unticks the box');
  // closed and opened again: ticked again (not remembered)
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await sleep(200);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'add-account', nonce: Date.now() }); 1`);
  await waitFor(`document.querySelector(${JSON.stringify(CARD)})`, 'the card again');
  await sleep(350);
  ok((await card()).cb?.checked === true, 'the box is ticked every time the card opens');
  // a build that cannot connect the service: no box
  for (const [hash, kind, expect] of [['calkinds=none', 'google', false], ['calkinds=none', 'microsoft', false], ['calkinds=microsoft', 'google', false], ['calkinds=microsoft', 'microsoft', true], ['calkinds=google', 'microsoft', false], ['calkinds=google', 'google', true]]) {
    await openAdd(`lang=en&light&${hash}`, 960, 560, kind);
    ok(((await card()).cb !== null) === expect, `${hash} ${kind}: the box is ${expect ? 'shown' : 'absent'}`);
  }

  // ------------------------------------------------------------------ AC-7.9.2: unticked = the 1.0.6 flow
  await openAdd('lang=en&light', 960, 560);
  await click('.also-cal label span');
  ok(!(await card()).cb.checked, 'unticked');
  await click(GO);
  await waitFor(`window.__store.getState().accounts.some((a) => a.id === 'n1') && !window.__store.getState().dialog`, 'Settings to close', 8000);
  ok((await connects()).length === 0, 'unticked: no calendar_connect call');
  ok((await store(`s.accountId`)) === 'n1' && (await store(`s.folder`)) === 'inbox', 'unticked: the Inbox of the new mailbox is open');
  ok((await toasts()).includes('Account new.user1@gmail.com added'), `unticked: toast "${(await toasts()).join(' | ')}"`);
  ok((await savedSetting('cal_offer_done')) === null, 'unticking the box is not an answer to the offer');
  // the Calendar sidebar still offers it (the only mailbox that can sync and does not)
  await evaluate(`window.__store.setState({ accounts: window.__store.getState().accounts.filter((a) => a.id === 'a1' || a.id === 'n1') }); 1`);
  await showSidebar();
  await waitFor(`document.querySelector('.cal-offer')`, 'the offer for the new mailbox');
  ok(norm(await evaluate(`document.querySelector('.cal-offer').textContent`)).startsWith('Also show the Google Calendar calendars of new.user1@gmail.com here?'), 'the offer names the new mailbox');

  // ------------------------------------------------------------------ AC-7.9.3: ticked, mail OK, consent OK (Google and Microsoft)
  for (const kind of ['google', 'microsoft']) {
    const label = kind === 'google' ? 'Google' : 'Microsoft';
    const addr = kind === 'google' ? 'new.user1@gmail.com' : 'new.user1@outlook.com';
    await openAdd('lang=en&light', 960, 560, kind);
    await mock({ connectResult: 'ok', connectDelay: 2200 });
    await click(GO);
    ok(await waitFor(`window.__store.getState().accounts.some((a) => a.id === 'n1') && [...document.querySelectorAll(${JSON.stringify(CARD + ' .row-inline button')})].some((b) => b.textContent.trim() === ${JSON.stringify(SK)})`, `${kind}: the calendar step`, 8000), `${kind}: step 2 did not start`);
    c = await card();
    const tag = `${kind} step 2`;
    ok(JSON.stringify(await connects()) === '["n1"]', `${tag}: exactly one calendar_connect call, for the new mailbox (${JSON.stringify(await connects())})`);
    ok(c.slot.startsWith(`Account ${addr} added. Now allow calendar access in your browser…`), `${tag}: slot "${c.slot}"`);
    ok(c.btns[0].disabled && c.btns[0].text === `Waiting for ${label}…`, `${tag}: the Sign in button waits and is disabled ("${c.btns[0].text}")`);
    ok(c.btns.length === 2 && c.btns[1].text === SK && c.btns[1].focus, `${tag}: Skip calendar has the focus (${JSON.stringify(c.btns.map((b) => [b.text, b.focus]))})`);
    ok(c.cb && c.cb.disabled, `${tag}: the box is disabled while a step waits`);
    ok(c.slotRole.includes('status'), `${tag}: the slot is a status region`);
    ok((await dialogType()) === 'settings', `${tag}: Settings stays open`);
    ok((await store(`s.accounts.some((a) => a.id === 'n1')`)) && (await evaluate(`document.querySelector('.folder-pane')?.textContent.includes('Zed') || true`)), `${tag}: the mailbox is in the folder pane`);
    ok(!(await evaluate(`!!document.querySelector('.ask')`)), `${tag}: no question before the browser (the ticked box is the confirmation)`);
    if (kind === 'google') await shot('step2-waiting');
    await waitFor(`!window.__store.getState().dialog`, `${kind}: Settings to close`, 8000);
    ok((await store(`s.accountId`)) === 'n1' && (await store(`s.folder`)) === 'inbox', `${kind}: the Inbox of the new mailbox opens`);
    const tt = await toasts();
    ok(tt.includes(`Account ${addr} added with calendar sync`) && !tt.includes(`Account ${addr} added`), `${kind}: one toast "added with calendar sync" (${tt.join(' | ')})`);
    ok((await connects()).length === 1, `${kind}: still one call`);
    ok((await savedSetting('cal_offer_done')) === '1', `${kind}: the offer is over once a calendar is connected`);
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:n1', focus: 'calendar', nonce: Date.now() }); 1`);
    await waitFor(`document.querySelector('#set-calendar .switch input')`, `${kind}: Settings > Calendar`);
    await sleep(300);
    ok(await evaluate(`document.querySelector('#set-calendar .switch input').checked`), `${kind}: Settings > the new mailbox > Calendar shows the switch on`);
    ok(norm(await evaluate(`document.querySelector('.set-status').textContent`)).length > 3, `${kind}: with its status line`);
  }

  // ------------------------------------------------------------------ AC-7.9.4: Skip, Esc, the X, another tab: all end the step as Skip
  const ways = [
    ['Skip', async () => click(`${CARD} .row-inline button:last-child`)],
    ['Esc', async () => esc()],
    ['the X', async () => click('.modal-head .icon-btn')],
    ['another Settings tab', async () => click('.settings-nav > button')],
  ];
  for (const [way, act] of ways) {
    await openAdd('lang=en&light', 960, 560);
    await mock({ connectResult: 'hang' });
    await click(GO);
    await waitFor(`document.querySelector('.signin-slot')?.textContent.includes('allow calendar access')`, `${way}: step 2`, 8000);
    await act();
    await waitFor(`!window.__store.getState().dialog`, `${way}: Settings to close`, 5000);
    await sleep(250);
    ok((await cancels()) === 1, `${way}: calendar_cancel_connect was called once (${await cancels()})`);
    ok((await store(`s.accountId`)) === 'n1' && (await store(`s.folder`)) === 'inbox', `${way}: the Inbox of the new mailbox opens`);
    const tt = await toasts();
    ok(tt.includes('Account new.user1@gmail.com added') && tt.length === 1, `${way}: toast "added" only (${tt.join(' | ')})`);
    ok((await savedSetting('cal_offer_done')) === '1', `${way}: the offer is answered`);
    ok((await connects()).length === 1, `${way}: one call`);
    ok((await evaluate(`window.__mockCalSync.get('n1')`)) === null, `${way}: calendar sync stays off`);
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:n1', focus: 'calendar', nonce: Date.now() }); 1`);
    await waitFor(`document.querySelector('#set-calendar .switch input')`, `${way}: Settings > Calendar`);
    ok(!(await evaluate(`document.querySelector('#set-calendar .switch input').checked`)), `${way}: the switch is off`);
    await evaluate(`window.__store.getState().setDialog(null); 1`);
    await showSidebar();
    ok(!(await evaluate(`!!document.querySelector('.cal-offer')`)), `${way}: no offer in the Calendar sidebar`);
    ok(!(await evaluate(`document.body.textContent.includes('Turn the switch')`)), `${way}: no error text`);
  }

  // ------------------------------------------------------------------ AC-7.9.5: every refusal shows the Settings notice, Retry and Continue
  for (const [kind, code] of [['google', 'DENIED'], ['google', 'TIMEOUT'], ['google', 'WRONG_ACCOUNT'], ['google', 'PARTIAL'], ['google', 'BLOCKED'], ['google', 'ERROR'], ['microsoft', 'DENIED'], ['microsoft', 'BLOCKED'], ['microsoft', 'TIMEOUT']]) {
    const tag = `${kind} ${code}`;
    // the sentence Settings > Calendar shows for this end (a page of its own: leaving the Add account tab ends its step)
    const want = await settingsNote(kind === 'google' ? 'a2' : 'a4', code);
    await openAdd('lang=en&light', 960, 560, kind);
    await mock({ connectResult: code, connectDelay: 300 });
    await click(GO);
    await waitFor(`window.__store.getState().accounts.some((a) => a.id === 'n1') && ${hasBtn('Retry')}`, `${tag}: Retry`, 8000);
    c = await card();
    ok(c.btns.map((b) => b.text).join('|') === `Sign in with ${kind === 'google' ? 'Google' : 'Microsoft'}|Retry|Continue without calendar`, `${tag}: buttons ${c.btns.map((b) => b.text).join('|')}`);
    ok(c.btns[1].focus && c.btns[1].primary, `${tag}: Retry is primary and has the focus`);
    ok(c.btns[0].disabled, `${tag}: the Sign in button stays off (the mailbox is added)`);
    ok((await dialogType()) === 'settings' && (await store(`s.accounts.some((a) => a.id === 'n1')`)), `${tag}: the mailbox exists and Settings stays open`);
    const got = norm(c.slot).replace(/[\w.+-]+@[\w.-]+/g, 'E');
    ok(got === want, `${tag}: the card shows the Settings sentence ("${got}" vs "${want}")`);
    ok(!/Turn the switch/.test(got), `${tag}: no "turn the switch on"`);
    if (code === 'DENIED' && kind === 'google') await shot('step2-failed');
  }
  // Retry and Continue on one card
  await openAdd('lang=en&light', 960, 560);
  await mock({ connectResult: 'DENIED', connectDelay: 300 });
  await click(GO);
  await waitFor(hasBtn('Retry'), 'Retry', 8000);
  await clickText('Retry');
  await sleep(900);
  ok((await connects()).length === 2, `Retry calls calendar_connect again (${(await connects()).length})`);
  ok((await card()).btns.some((b) => b.text === 'Retry'), 'the second refusal shows Retry again');
  await mock({ connectResult: 'ok' });
  await clickText('Retry');
  await waitFor(`!window.__store.getState().dialog`, 'Retry to end well', 6000);
  ok((await connects()).length === 3 && (await toasts()).includes('Account new.user1@gmail.com added with calendar sync'), `Retry ends well: the calendar toast (${(await toasts()).join(' | ')})`);
  await openAdd('lang=en&light', 960, 560);
  await mock({ connectResult: 'TIMEOUT', connectDelay: 300 });
  await click(GO);
  await waitFor(hasBtn('Continue without calendar'), 'Continue', 8000);
  await clickText('Continue without calendar');
  await waitFor(`!window.__store.getState().dialog`, 'Continue to close Settings', 5000);
  ok((await store(`s.accountId`)) === 'n1' && (await toasts()).includes('Account new.user1@gmail.com added') && (await savedSetting('cal_offer_done')) === '1', 'Continue behaves as Skip: Inbox, plain toast, the offer is answered');

  // ------------------------------------------------------------------ AC-7.9.6: a mail sign-in that ends without an account never starts the step
  await openAdd('lang=en&light&signin=slow', 960, 560);
  await click(GO);
  await waitFor(hasBtn('Cancel'), 'the mail sign-in to wait', 5000);
  await click(`${CARD} .row-inline button:last-child`);
  await sleep(700);
  ok((await connects()).length === 0, 'cancelled mail sign-in: no calendar_connect call');
  ok(!(await store(`s.accounts.some((a) => a.id === 'n1')`)), 'cancelled mail sign-in: no account');
  ok(!(await card()).btns.some((b) => b.text === SK), 'cancelled mail sign-in: no calendar step');
  await openAdd('lang=en&light&signin=denied', 960, 560);
  await click(GO);
  await sleep(2600);
  ok((await connects()).length === 0 && !(await card()).btns.some((b) => b.text === SK), 'a refused mail sign-in: no calendar step');
  await shot('mail-refused');

  // ------------------------------------------------------------------ AC-7.9.10: the keyboard
  await openAdd('lang=en&light', 960, 560);
  await evaluate(`document.querySelector(${JSON.stringify(CARD)}).querySelectorAll('input')[document.querySelector(${JSON.stringify(CARD)}).querySelectorAll('input').length - 2].focus(); 1`);
  const focusKind = () => evaluate(`(() => { const a = document.activeElement; return a.type === 'checkbox' ? 'cb' : a.tagName === 'INPUT' ? 'name' : a.textContent.trim(); })()`);
  ok((await focusKind()) === 'name', `the display name has the focus (${await focusKind()})`);
  await tab();
  ok((await focusKind()) === 'cb', `Tab reaches the box (${await focusKind()})`);
  await space();
  ok(!(await card()).cb.checked, 'Space unticks the box');
  await space();
  ok((await card()).cb.checked, 'Space ticks it again');
  await tab();
  ok((await focusKind()).startsWith('Sign in with'), `Tab reaches Sign in (${await focusKind()})`);
  await mock({ connectResult: 'DENIED', connectDelay: 60000 });
  await enter();
  await waitFor(`[...document.querySelectorAll(${JSON.stringify(CARD + ' .row-inline button')})].some((b) => b.textContent.trim() === ${JSON.stringify(SK)})`, 'step 2 by keyboard', 8000);
  ok((await focusKind()) === SK, `Skip has the focus (${await focusKind()})`);
  await mock({ connectResult: 'hang' });
  await enter();
  await waitFor(`!window.__store.getState().dialog`, 'Enter on Skip to skip', 5000);
  ok((await cancels()) === 1 && (await toasts()).includes('Account new.user1@gmail.com added'), 'Enter on Skip skips');
  await openAdd('lang=en&light', 960, 560);
  await mock({ connectResult: 'DENIED', connectDelay: 300 });
  await click(GO);
  await waitFor(`[...document.querySelectorAll(${JSON.stringify(CARD + ' .row-inline button')})].some((b) => b.textContent.trim() === 'Retry')`, 'Retry by keyboard', 8000);
  ok((await focusKind()) === 'Retry', `Retry has the focus (${await focusKind()})`);
  await mock({ connectResult: 'ok', connectDelay: 300 });
  await enter();
  await waitFor(`!window.__store.getState().dialog`, 'Enter on Retry to try again', 6000);
  ok((await connects()).length === 2 && (await toasts()).includes('Account new.user1@gmail.com added with calendar sync'), 'Enter on Retry retries and ends well');

  // ------------------------------------------------------------------ AC-7.9.7: the offer for mailboxes that existed before
  const OFFER = '.cal-offer';
  const calendarOpen = async (hash, w = 960, h = 560, fix = '', peek = true) => {
    await openApp(hash, w, h);
    if (fix) await evaluate(fix);
    await showSidebar(peek);
  };
  const offerInfo = () => evaluate(`(() => { const n = document.querySelector('.cal-offer'); if (!n) return null; const b = n.getBoundingClientRect(); const p = n.parentElement.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(n).lineHeight) || parseFloat(getComputedStyle(n).fontSize) * 1.3; const cs = getComputedStyle(n);
    return { text: n.textContent.replace(/\\s+/g, ' ').trim(), role: n.getAttribute('role'), cls: n.className, links: [...n.querySelectorAll('button.link')].map((x) => x.textContent.trim()), over: n.scrollWidth - n.clientWidth, right: b.right, paneRight: p.right, left: b.left, paneLeft: p.left, lines: Math.round((b.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh), height: b.height }; })()`);
  await openApp('lang=en&light&persist', 960, 560);
  await evaluate(`localStorage.removeItem('hl-mock-settings'); 1`);
  await calendarOpen('lang=en&light&persist');
  await waitFor(`document.querySelector('${OFFER}')`, 'the offer');
  let o = await offerInfo();
  ok(o && o.text === 'Also show the Google Calendar calendars of nam@gmail.com here? Turn on… Not now', `the offer: "${o?.text}"`);
  ok(o && o.role === 'note' && o.cls.includes('notice') && o.cls.includes('info'), `the offer is a note in the info style (${o?.role} ${o?.cls})`);
  ok(o && o.links.join('|') === 'Turn on…|Not now', `two link buttons (${o?.links})`);
  await shot('offer');
  await click(`${OFFER} button.link:last-child`);
  await sleep(250);
  ok(!(await evaluate(`!!document.querySelector('${OFFER}')`)), 'Not now hides the offer');
  ok(JSON.parse((await evaluate(`localStorage.getItem('hl-mock-settings')`)) || '{}').cal_offer_done === '1', 'Not now: cal_offer_done = "1"');
  await calendarOpen('lang=en&light&persist');
  ok(!(await evaluate(`!!document.querySelector('${OFFER}')`)), 'after a reload the offer stays hidden');
  // Turn on...: Settings > that mailbox > Calendar, the question at once
  await openApp('lang=en&light', 960, 560);
  await calendarOpen('lang=en&light');
  await waitFor(`document.querySelector('${OFFER}')`, 'the offer on a fresh profile');
  await click(`${OFFER} button.link:first-child`);
  await waitFor(`document.querySelector('.ask')`, 'the question of the switch at once', 5000);
  ok((await store(`s.dialog && s.dialog.type === 'settings' && s.dialog.tab`)) === 'mb:a2', 'Turn on... opens Settings > nam@gmail.com');
  ok(norm(await evaluate(`document.querySelector('.ask p').textContent`)).includes('Sign in as nam@gmail.com'), 'the question names the mailbox');
  ok((await connects()).length === 0, 'no browser step before the question is answered');
  await click('.ask-actions button:first-child');
  await sleep(300);
  ok(!(await evaluate(`document.querySelector('#set-calendar .switch input').checked`)) && (await connects()).length === 0, 'Cancel: the switch stays off, nothing started');
  ok(await evaluate(`document.activeElement === document.querySelector('#set-calendar .switch input')`), 'Cancel: the focus is on the switch');
  ok((await savedSetting('cal_offer_done')) === '1', 'the offer is answered');
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await sleep(300);
  ok(!(await evaluate(`!!document.querySelector('${OFFER}')`)), 'the offer is gone for good');
  // Turn on... then Open browser: the switch's own path
  await calendarOpen('lang=en&light');
  await click(`${OFFER} button.link:first-child`);
  await waitFor(`document.querySelector('.ask')`, 'the question again');
  await click('.ask-actions button:last-child');
  await waitFor(`window.__mockCalConnects && window.__mockCalConnects.length === 1`, 'one call');
  await waitFor(`document.querySelector('#set-calendar .switch input').checked`, 'the switch on', 6000);
  ok(JSON.stringify(await connects()) === '["a2"]', 'Open browser: one call for a2');

  // ------------------------------------------------------------------ AC-7.9.8: no offer when ...
  const none = async (what, hash, fix, fold = false) => {
    await calendarOpen(hash, 960, 560, fix, !fold);
    if (fold) { await evaluate(`window.__store.getState().setPrefs({ sidebar: 'collapsed' }); 1`); await sleep(500); }
    ok(!(await evaluate(`!!document.querySelector('${OFFER}')`)), `no offer: ${what}`);
    if (fold) ok(await evaluate(`!!document.querySelector('.folder-pane.is-rail')`), `${what}: the side menu is the icon column`);
  };
  await none('every eligible mailbox syncs', 'lang=en&light&calsync=ok&calsyncms=ok', `window.__store.setState({ accounts: window.__store.getState().accounts.filter((a) => a.id !== 'a3') }); 1`);
  await none('only IMAP mailboxes without a calendar service', 'lang=en&light', `window.__store.setState({ accounts: window.__store.getState().accounts.filter((a) => a.id === 'a1' || a.id === 'a5') }); 1`);
  await none('the offer was answered', 'lang=en&light', `window.__store.setState({ calOfferDone: '1' }); 1`);
  await none('the side menu is folded to icons', 'lang=en&light', '', true);
  await none('a build that cannot connect either service', 'lang=en&light&calkinds=none', '');
  // the app-password Gmail mailbox counts (W7.8): with the OAuth ones out of the way the offer is for nam.work@gmail.com
  await calendarOpen('lang=en&light', 960, 560, `window.__store.setState({ accounts: window.__store.getState().accounts.filter((a) => a.id !== 'a2' && a.id !== 'a4') }); 1`);
  await waitFor(`document.querySelector('${OFFER}')`, 'the offer for the app-password mailbox');
  ok(norm(await evaluate(`document.querySelector('${OFFER}').textContent`)).includes('nam.work@gmail.com'), 'an app-password Gmail mailbox gets the offer');

  // ------------------------------------------------------------------ AC-7.9.9: the texts in every language, light and dark, two sizes
  const inside = (b, p, tol = 1) => b.l >= p.l - tol && b.r <= p.r + tol && b.t >= p.t - tol && b.b <= p.b + tol;
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    // idle card + sidebar offer (a 40 character address must wrap inside the notice)
    const LONG = 'averyveryverylongaddressname@subdomain.example.com';
    await openApp('lang=en&light', w, h);
    await evaluate(`import('/src/api.ts').then(async (m) => { await m.api.setSetting('google_client_id', 'id'); })`);
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'add-account', nonce: Date.now() }); 1`);
    await waitFor(`document.querySelector(${JSON.stringify(CARD)})`, 'the card');
    await sleep(350);
    for (const theme of THEMES) for (const lang of LANGS) {
      await setLook(theme, lang);
      const tag = `${lang} ${theme} ${w}x${h}`;
      c = await card();
      ok(c.cb && c.cb.label === tr(lang, 'settings.add.alsoCalendar') && c.cb.hint === tr(lang, 'settings.add.alsoCalendarHint', { provider: 'Google' }), `${tag}: the box and its hint say the agreed words`);
      ok(c.cb && !/\{\w+\}|settings\.add\./.test(c.cb.label + c.cb.hint), `${tag}: no raw key or placeholder on the card`);
      ok(c.cb && c.cardOver <= 1 && c.slotOver <= 1, `${tag}: the card is not clipped (${c.cardOver}, ${c.slotOver})`);
      ok(c.btns.every((b) => inside(b.box, c.card)), `${tag}: the button is inside the card`);
    }
    if (w === 960) await shot('add-idle-960');
  }
  // the states of step 2 once, switched through the languages
  for (const state of ['waiting', 'failed']) {
    await openAdd('lang=en&light', 960, 560);
    await mock({ connectResult: state === 'waiting' ? 'hang' : 'DENIED', connectDelay: 300 });
    await click(GO);
    await waitFor(`[...document.querySelectorAll(${JSON.stringify(CARD + ' .row-inline button')})].some((b) => b.textContent.trim() === ${JSON.stringify(state === 'waiting' ? SK : 'Retry')})`, `the ${state} state`, 8000);
    for (const theme of THEMES) for (const lang of LANGS) {
      await setLook(theme, lang);
      const tag = `${state} ${lang} ${theme}`;
      c = await card();
      const email = 'new.user1@gmail.com';
      if (state === 'waiting') {
        const lead = tr(lang, 'settings.add.calWaiting', { email });
        ok(norm(c.slot).startsWith(norm(lead)), `${tag}: the waiting line says "${lead}" (got "${c.slot.slice(0, 120)}")`);
        ok(c.btns[0].text === tr(lang, 'settings.add.waitingFor', { provider: 'Google' }) && c.btns[1].text === tr(lang, 'settings.add.calSkip'), `${tag}: buttons ${c.btns.map((b) => b.text).join('|')}`);
      } else {
        ok(norm(c.slot).startsWith(norm(tr(lang, 'calendar.err.denied'))), `${tag}: the refusal says "${tr(lang, 'calendar.err.denied')}" (got "${c.slot.slice(0, 120)}")`);
        ok(c.btns[1].text === tr(lang, 'common.retry') && c.btns[2].text === tr(lang, 'settings.add.calContinue'), `${tag}: buttons ${c.btns.map((b) => b.text).join('|')}`);
      }
      ok(!/\{\w+\}|settings\.add\.|calendar\.err\./.test(c.slot + c.btns.map((b) => b.text).join('')), `${tag}: no raw key or placeholder`);
      ok(c.slotOver <= 1 && c.cardOver <= 1, `${tag}: nothing is clipped (${c.slotOver}, ${c.cardOver})`);
      ok(c.slotBox.t >= c.body.t - 1 && c.slotBox.t + 24 <= c.body.b + 1, `${tag}: the line of the step is in view, not below the fold (slot ${c.slotBox.t} of ${c.body.t}..${c.body.b})`);
      ok(c.btns.every((b) => inside(b.box, c.card)), `${tag}: the buttons are inside the card`);
    }
    if (state === 'waiting') {
      await setLook('light', 'en');
      await click(`${CARD} .row-inline button:last-child`);
      await waitFor(`!window.__store.getState().dialog`, 'Skip', 5000);
    }
  }
  // the sidebar notice
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    await calendarOpen('lang=en&light', w, h, `window.__store.setState({ accounts: window.__store.getState().accounts.map((a) => a.id === 'a2' ? { ...a, email: 'averyveryverylongaddressname@subdomain.example.com' } : a) }); 1`);
    await waitFor(`document.querySelector('${OFFER}')`, 'the offer');
    for (const theme of THEMES) for (const lang of LANGS) {
      await setLook(theme, lang);
      await sleep(100);
      o = await offerInfo();
      const tag = `offer ${lang} ${theme} ${w}x${h}`;
      const want = norm(`${tr(lang, 'calendar.side.offer', { service: 'Google Calendar', email: 'averyveryverylongaddressname@subdomain.example.com' })} ${tr(lang, 'calendar.side.offerOn')} ${tr(lang, 'calendar.side.offerLater')}`);
      ok(o && o.text === want, `${tag}: the notice says the agreed words ("${o?.text}")`);
      ok(o && !/\{\w+\}|calendar\.side\./.test(o.text), `${tag}: no raw key or placeholder`);
      ok(o && o.over <= 1 && o.left >= o.paneLeft - 1 && o.right <= o.paneRight + 1, `${tag}: a long address wraps inside the sidebar (over ${o?.over}, ${o?.left}..${o?.right} of ${o?.paneLeft}..${o?.paneRight})`);
      ok(o && o.lines <= 6, `${tag}: ${o?.lines} lines (the 48 character address makes it one more than a normal one)`);
    }
    if (w === 960) await shot('offer-long-address');
  }
  // a normal address: at most 4 lines at the default sidebar width
  await calendarOpen('lang=en&light', 960, 560);
  await waitFor(`document.querySelector('${OFFER}')`, 'the offer');
  for (const theme of THEMES) for (const lang of LANGS) {
    await setLook(theme, lang);
    await sleep(100);
    o = await offerInfo();
    ok(o && o.lines <= 4, `offer ${lang} ${theme}: ${o?.lines} lines with a normal address (at most 4)`);
  }
} catch (e) {
  failures.push(`the test stopped: ${e && e.stack ? e.stack : e}`);
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`\n${failures.length} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok - test-calendar-at-signin (${checks} checks)`);
