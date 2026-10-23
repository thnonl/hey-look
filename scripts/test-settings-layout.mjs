#!/usr/bin/env node
// Settings > Add account (Google, Microsoft, other account) and Settings > mailbox > Calendar must stand still while a sign-in runs and ends.
// Same cause as the AI Assistant tab (scripts/test-ai-tab-layout.mjs): messages were rows of the form, inserted above or below the control that
// starts the sign-in, so the button the person had just pressed moved ("Waiting for ...", the error row, the "sign-in ended" notice, a client-id
// hint that vanished at the first key), and the calendar's status block grew and shrank under the Sync now button.
//
// Opens the tabs in the dev preview (src/devMock.ts: `#signin=slow|timeout|denied|blocked|error` decide how the next browser sign-in ends,
// `#calslow` / `#calfail=<why>` the calendar's, `__mockCalSync.state(...)` the sync state, a password "wrong" makes "Add account" fail), drives
// them with real mouse and keyboard events, and samples the layout on every animation frame. Asserts that, from the first frame to the last,
// nothing moved: the headings, the fields, the button that starts the sign-in, the card, the status slot, the rows under it, the dialog, the
// scroll position; that the focus is on the button that started the sign-in when it ends; that every message really appeared; that no message
// is cut off by its slot.
//
//   node scripts/test-settings-layout.mjs                       en + de x 960x560 + 1280x720 x light + dark
//   node scripts/test-settings-layout.mjs --quick               en 960x560 light and de 1280x720 dark (what CI runs)
//   node scripts/test-settings-layout.mjs --lang=en,ru --size=960x560 --theme=dark --shots=<dir> --only=google,imap,calendar
//   node scripts/test-settings-layout.mjs --url=http://127.0.0.1:1420/    use a dev server that is already running
//   node scripts/test-settings-layout.mjs --require-browser     fail (instead of skipping) when no Chrome/Chromium/Edge is installed
import { arg, flag, inputs, sleep, startHarness } from './cdp-harness.mjs';

const QUICK = flag('quick');
const CONFIGS = [];
if (QUICK) CONFIGS.push({ lang: 'en', w: 960, h: 560, theme: 'light' }, { lang: 'de', w: 1280, h: 720, theme: 'dark' });
else for (const lang of (arg('lang') || 'en,de').split(',')) for (const size of (arg('size') || '960x560,1280x720').split(',')) for (const theme of (arg('theme') || 'light,dark').split(',')) CONFIGS.push({ lang, w: Number(size.split('x')[0]), h: Number(size.split('x')[1]), theme });
const ONLY = (arg('only') || (QUICK ? 'google,imap,calendar' : 'google,microsoft,imap,calendar,calendar-off')).split(',');
const SHOTS = arg('shots');

const H = await startHarness('test-settings-layout', { vitePort0: 5560, cdpPort0: 9580 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const fail = (cfg, scenario, msg) => failures.push(`[${scenario} ${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme}] ${msg}`);
const flat = (o) => JSON.stringify(o);
// equal within 0.75px (text in some fonts, Vietnamese for one, rounds a line box by half a pixel: nobody sees that; a real jump is 15 px or more)
const same = (a, b) => (Array.isArray(a) ? a.length === b.length && a.every((x, i) => same(x, b[i])) : Math.abs(a - b) <= 0.75);

// ---------- the page side: a layout sample on every frame ----------
// `kind`: 'add' (the card of Add account) or 'cal' (the Calendar panel of a mailbox)
const PAGE = (kind) => `(() => {
  // a button gives a 1 px press nudge while the pointer is down (.btn:active { transform: translateY(1px) }, a .06 s transition): visual feedback, not layout. On a busy machine a frame
  // lands in the middle of a click and the button seems to have moved by up to 1 px; the sampler measures the layout, so the nudge is switched off while measuring.
  if (!document.getElementById('__nonudge')) { const st = document.createElement('style'); st.id = '__nonudge'; st.textContent = '.btn:active:not(:disabled) { transform: none !important; }'; document.head.appendChild(st); }
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  // the button that starts a sign-in changes its words ("Sign in with Google" / "Waiting for Google..."): its place and height must not change, its width follows the words
  const P = (el) => { const r = R(el); return r && [r[0], r[1], r[3]]; };
  const T = (el) => (el ? el.getBoundingClientRect().top : null);
  // what the slot's content needs, whatever the slot's own height is
  const need = (slot) => (slot && slot.children.length ? Math.round(Math.max(...[...slot.children].map((c) => c.getBoundingClientRect().bottom)) - slot.getBoundingClientRect().top) : 0);
  const slotOf = (root) => root.querySelector('.signin-slot, .set-status');
  const sample = () => {
    const body = document.querySelector('.settings-body');
    if (!body) return null;
    const a = document.activeElement;
    const base = { modal: R(document.querySelector('.modal')), scroll: body.scrollTop, scrollH: body.scrollHeight };
    if (${JSON.stringify(kind)} === 'add') {
      const card = body.querySelector('.set-card');
      if (!card) return null;
      const primary = card.querySelector('.btn.primary'), inputs = [...card.querySelectorAll('input, select')];
      const cancel = [...card.querySelectorAll('.row-inline .btn')].find((b) => b !== primary && !b.classList.contains('small') && b.textContent.trim() && !b.querySelector('svg'));
      const slot = slotOf(body);
      const text = [...body.querySelectorAll('.notice, [role=status], [role=alert]')].map((e) => e.textContent.trim()).filter(Boolean).join(' || ');
      return {
        pos: { h3: R(body.querySelector('h3')), seg: R(body.querySelector('.seg')), card: R(card), title: R(card.querySelector('h4')), summary: R(card.querySelector('summary')), inputs: inputs.map(R), primary: P(primary), slot: R(slot), ...base },
        cancelTop: cancel ? T(cancel) : null, primaryTop: T(primary), text, bad: !!body.querySelector('.notice.bad'), slotText: slot ? slot.textContent.trim() : '', hasCancel: !!cancel,
        active: !a ? 'none' : a === primary ? 'primary' : a === cancel ? 'cancel' : a.tagName === 'BODY' ? 'body' : inputs.includes(a) ? 'input' : 'other',
        slotOverflow: slot ? slot.scrollHeight - slot.clientHeight : 0, need: need(slot),
      };
    }
    const row = body.querySelector('#set-calendar');
    if (!row) return null;
    const slot = slotOf(body), after = [...body.querySelectorAll('.mb-body .row-inline .btn, .mb-body h4, .mb-body .set-row')].filter((e) => !row.contains(e));
    const text = slot ? slot.textContent.trim() : '';
    return {
      pos: { head: R(body.querySelector('.mb-head')), row: R(row), switch: R(row.querySelector('.switch')), slot: R(slot), actions: R(body.querySelector('.set-actions') || body.querySelector('.row-inline .btn.small, .row-inline .btn.primary')), heading: R(body.querySelector('.mb-body h4')), firstCal: R(body.querySelector('.mb-body h4 ~ .set-row')), modal: base.modal, scroll: base.scroll, scrollH: base.scrollH },
      text, waiting: !!(slot && slot.querySelector('button.link') && !slot.querySelector('.notice, .field-err')), active: !a ? 'none' : a.tagName === 'BODY' ? 'body' : row.contains(a) ? 'row' : a.closest('.set-status, .signin-slot') ? 'slot' : 'other', activeTag: a ? a.tagName + (a.type ? ':' + a.type : '') : '',
      slotOverflow: slot ? slot.scrollHeight - slot.clientHeight : 0, need: need(slot), after: after.length,
    };
  };
  window.__phase = 'start'; window.__log = []; let last = '';
  const tick = () => { const s = sample(), j = JSON.stringify(s); if (j !== last) { last = j; window.__log.push({ phase: window.__phase, s }); } requestAnimationFrame(tick); };
  tick();
})()`;

const hashFor = (cfg, extra = '') => `lang=${cfg.lang}${extra ? '&' + extra : ''}`;

async function openTab(cfg, tab, extraHash = '') {
  await H.openApp(hashFor(cfg, extraHash), cfg.w, cfg.h);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); window.__store.getState().setDialog(${JSON.stringify(tab)}); 1`);
}
const waitFor = async (cfg, scenario, what, expr, ms = 20000) => { ms = Math.max(ms, 10000); const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(expr); } catch { /* between two renders: not yet */ } if (v) return true; await sleep(40); } fail(cfg, scenario, `timed out waiting for ${what}`); return false; }; // (the cap is not a sleep: it only matters when the test fails)
/** Waits, on the page's clock, until nothing moves: no running animation or transition, the dialog and the settings body at the same place, and the frame log (once the sampler runs) without a new entry, for 4 frames in a row. */
const SETTLE = `new Promise((done) => { const R = (s) => { const e = document.querySelector(s); if (!e) return ''; const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, e.scrollTop].join(); }; const key = () => [R('.modal'), R('.settings-body'), window.__log ? window.__log.length : -1, innerWidth, innerHeight].join('|'); const t0 = performance.now(); let last = '', n = 0; const tick = () => { const k = key(), running = document.getAnimations().some((a) => a.playState === 'running' || a.playState === 'pending'); if (k === last && !running) n++; else { n = 0; last = k; } if (n >= 4) return done(true); if (performance.now() - t0 > 10000) return done(false); requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`;
const settle = () => evaluate(SETTLE);

/** Add account, Google or Microsoft: the browser sign-in ends every way the mock knows; the card never moves. */
async function runOAuth(cfg, kind) {
  const scenario = kind;
  const tag = `${kind}-${cfg.lang}-${cfg.w}x${cfg.h}-${cfg.theme}`;
  await openTab(cfg, { type: 'settings', tab: 'add-account' });
  const { typeText, press, click, shot } = inputs(H, SHOTS, tag);
  await waitFor(cfg, scenario, 'the Add account tab', `!!document.querySelector('.settings-body .set-card')`);
  if (kind === 'microsoft') await evaluate(`document.querySelectorAll('.settings-body .seg button')[1].click()`);
  await settle();
  // the Advanced section holds the client id; it is opened first (opening it is the person's own layout change)
  await evaluate(`document.querySelector('.settings-body .set-card summary').click()`);
  await waitFor(cfg, scenario, 'the Advanced section', `document.querySelector('.settings-body .set-card details').open`); await settle();
  // a small window scrolls: the pane starts where the client id box and the sign-in button are both in view (a person who types the id and clicks the button)
  await evaluate(`(() => { const b = document.querySelector('.settings-body'), i = b.querySelector('.set-card details input'), p = b.querySelector('.set-card .btn.primary'); b.scrollTop += (p.getBoundingClientRect().bottom + i.getBoundingClientRect().top) / 2 - (b.getBoundingClientRect().top + b.clientHeight / 2); })()`);
  await evaluate(PAGE('add'));
  await waitFor(cfg, scenario, 'the first sample', `window.__log.length > 0`);
  const phase = (n) => evaluate(`window.__phase = ${JSON.stringify(n)}`);
  const last = `(window.__log.filter((e) => e.s).slice(-1)[0] || { s: {} }).s`;
  const setHash = (extra) => evaluate(`location.hash = ${JSON.stringify(hashFor(cfg, extra))}`);
  const primary = '.settings-body .set-card .btn.primary';
  // the slot (or the card) shows what the sign-in is doing / how it ended; `fits`: nothing is cut off
  const fits = async (what) => { const o = await evaluate(`${last}.slotOverflow`); if (o > 1) fail(cfg, scenario, `the ${what} message does not fit its slot: ${o}px too much`); };
  // starts a sign-in that ends `mode`; waits for it to wait (Cancel there) and to end (Cancel gone)
  const ended = async (what, mode, expectText) => {
    await phase(what);
    await setHash(`signin=${mode}`);
    await click(primary);
    await waitFor(cfg, scenario, `the wait of the ${what} sign-in`, `${last}.hasCancel`, 3000);
    await waitFor(cfg, scenario, `the end of the ${what} sign-in`, `!${last}.hasCancel`, 6000);
    await waitFor(cfg, scenario, `the message of the ${what} sign-in`, expectText === 'bad' ? `${last}.bad` : `${last}.text.length > 20`);
    await settle();
    if (expectText === 'bad' ? !(await evaluate(`${last}.bad`)) : !(await evaluate(`${last}.text.length > 20`))) fail(cfg, scenario, `the ${what} message is not shown (${await evaluate(`${last}.text`)})`);
    await fits(what);
    await shot(what.replace(/\W+/g, '-'));
    const act = await evaluate(`${last}.active`);
    if (act !== 'primary') fail(cfg, scenario, `after the ${what} the focus is on "${act}", not on the button that started the sign-in`);
  };

  // 1. the client id: the hint that said "not available" must not vanish and pull the field up under the caret
  await phase('type the client id');
  await evaluate(`(() => { const i = document.querySelector('.settings-body .set-card details input'); i.focus(); })()`);
  await typeText('client-id-12345', 30);
  await waitFor(cfg, scenario, 'the typed client id', `document.querySelector('.settings-body .set-card details input').value === 'client-id-12345'`); await settle();
  const typingFocus = await evaluate(`${last}.active`);
  if (typingFocus !== 'input') fail(cfg, scenario, `typing the client id: the focus is on "${typingFocus}"`);
  await shot('client-id');
  // 2. a sign-in that waits, then Cancel
  await phase('waiting for the browser');
  await setHash('signin=slow');
  await click(primary);
  await waitFor(cfg, scenario, 'the waiting message and Cancel', `${last}.hasCancel`);
  await waitFor(cfg, scenario, 'the waiting text', `${last}.slotText.length > 0`); await settle();
  await fits('waiting');
  await shot('waiting');
  if (await evaluate(`Math.abs(${last}.cancelTop - ${last}.primaryTop) > 1`)) fail(cfg, scenario, 'Cancel is not on the line of the sign-in button');
  await phase('Cancel');
  await click('.settings-body .set-card .row-inline .btn:not(.primary)');
  await waitFor(cfg, scenario, 'the end of the wait', `!${last}.hasCancel`);
  await settle();
  await fits('cancelled');
  await shot('cancelled');
  const afterCancel = await evaluate(`${last}.active`);
  if (afterCancel !== 'primary') fail(cfg, scenario, `after Cancel the focus is on "${afterCancel}", not on the sign-in button`);
  // 3. the other ends: timeout (advice), refused, organization has to approve, a plain error (also a toast)
  await ended('timeout', 'timeout', 'notice');
  await ended('refused', 'denied', 'notice');
  await ended('blocked', 'blocked', 'notice');
  await ended('error', 'error', 'bad');
  await settle();
  report(cfg, scenario, await evaluate('window.__log'), (log) => {
    const texts = new Set(log.map((e) => e.s?.text).filter(Boolean));
    if (texts.size < 5) fail(cfg, scenario, `only ${texts.size} different messages were seen (waiting, cancelled, timeout, refused, blocked, error expected)`);
    if (!log.some((e) => e.s?.pos.slot && e.s.pos.slot[3] > 0)) fail(cfg, scenario, 'there is no status slot with a height');
    if (!log.some((e) => e.s?.hasCancel)) fail(cfg, scenario, 'Cancel never appeared');
  });
}

/** Add account > other account: "Connecting..." then the error; the Add button never moves. */
async function runImap(cfg) {
  const scenario = 'imap';
  const tag = `imap-${cfg.lang}-${cfg.w}x${cfg.h}-${cfg.theme}`;
  await openTab(cfg, { type: 'settings', tab: 'add-account' });
  const { typeText, press, click, shot } = inputs(H, SHOTS, tag);
  await waitFor(cfg, scenario, 'the Add account tab', `!!document.querySelector('.settings-body .set-card')`);
  await evaluate(`document.querySelectorAll('.settings-body .seg button')[2].click()`);
  await waitFor(cfg, scenario, 'the account fields', `document.querySelectorAll('.settings-body .set-card input').length >= 3`); await settle();
  const field = (i) => evaluate(`(() => { const e = document.querySelectorAll('.settings-body .set-card input')[${i}]; e.focus(); })()`);
  await field(0); await typeText('sam@fastmail.test', 5);
  await field(2); await typeText('wrong', 5); // the mock refuses this password
  await waitFor(cfg, scenario, 'the typed password', `document.querySelectorAll('.settings-body .set-card input')[2].value === 'wrong'`); await settle();
  await evaluate(`(() => { const b = document.querySelector('.settings-body'); b.scrollTop = b.scrollHeight; })()`);
  await evaluate(PAGE('add'));
  await waitFor(cfg, scenario, 'the first sample', `window.__log.length > 0`);
  const phase = (n) => evaluate(`window.__phase = ${JSON.stringify(n)}`);
  const last = `(window.__log.filter((e) => e.s).slice(-1)[0] || { s: {} }).s`;
  const add = '.settings-body .set-card .btn.primary';
  for (const n of [1, 2]) {
    await phase(`Add account fails (${n})`);
    await click(add);
    await waitFor(cfg, scenario, 'the Connecting wait', `!!document.querySelector('.settings-body .set-card .btn.primary:disabled')`, 2000);
    await waitFor(cfg, scenario, 'the old error to go while it connects', `!${last}.bad`, 2000); // (the sample of the frame before the click may still show it)
    await waitFor(cfg, scenario, 'the error', `${last}.bad`, 5000);
    await settle();
    if ((await evaluate(`${last}.slotOverflow`)) > 1) fail(cfg, scenario, 'the error does not fit its slot');
    await shot(`error-${n}`);
    const act = await evaluate(`${last}.active`);
    if (act !== 'primary') fail(cfg, scenario, `after the error the focus is on "${act}", not on the Add button (${await evaluate('JSON.stringify(document.activeElement.outerHTML.slice(0,80))')})`);
  }
  report(cfg, scenario, await evaluate('window.__log'), (log) => {
    if (!log.some((e) => e.s?.bad)) fail(cfg, scenario, 'the error never appeared');
  });
}

/** Settings > mailbox > Calendar of the Google mailbox (a2). `connected`: sync is on from the start; else it is off and the switch turns it on. */
async function runCalendar(cfg, connected) {
  const scenario = connected ? 'calendar' : 'calendar-off';
  const tag = `${scenario}-${cfg.lang}-${cfg.w}x${cfg.h}-${cfg.theme}`;
  await openTab(cfg, { type: 'settings', tab: 'mb:a2', focus: 'calendar' }, connected ? 'calsync=ok' : '');
  const { click, shot } = inputs(H, SHOTS, tag);
  await waitFor(cfg, scenario, 'the Calendar panel', `!!document.querySelector('#set-calendar')`);
  await settle();
  await evaluate(PAGE('cal'));
  await waitFor(cfg, scenario, 'the first sample', `window.__log.length > 0`);
  const phase = (n) => evaluate(`window.__phase = ${JSON.stringify(n)}`);
  const last = `(window.__log.filter((e) => e.s).slice(-1)[0] || { s: {} }).s`;
  const setHash = (extra) => evaluate(`location.hash = ${JSON.stringify(hashFor(cfg, extra))}`);
  const state = async (st, text) => { await phase(`state ${st}`); await evaluate(`window.__mockCalSync.state(${JSON.stringify(st)})`); if (text) await waitFor(cfg, scenario, `the "${st}" status`, `${last}.text.includes(${JSON.stringify(text)})`, 3000); else await settle(); await settle(); if ((await evaluate(`${last}.slotOverflow`)) > 1) fail(cfg, scenario, `the "${st}" status does not fit its slot: ${await evaluate(`${last}.slotOverflow`)}px too much`); await shot(`state-${st}`); };
  const sw = '#set-calendar .switch';
  // (1.0.7 W7.7: the switch and Allow access again ask first; the consent starts with Open browser)
  const openBrowser = async () => { await waitFor(cfg, scenario, 'the question before the browser opens', `!!document.querySelector('.ask')`, 3000); await click('.ask-actions button:last-child'); };
  const fitsNow = async (what) => { const o = await evaluate(`${last}.slotOverflow`); if (o > 1) fail(cfg, scenario, `the ${what} message does not fit its slot: ${o}px too much`); };
  if (connected) {
    // the status of a connected calendar changes by itself (a sync ends, the network goes, access ends): the rows under it stay
    for (const st of ['syncing', 'first', 'offline', 'busy', 'error', 'auth', 'blocked', 'notsetup', 'truncated', 'ok']) await state(st);
    // Sync now: syncing, then back to Last synced
    await phase('Sync now');
    await click('.mb-body .row-inline .btn.small');
    // the mock ends the sync by itself (calendar_sync_now: syncing, then ok): wait for both, on the state the page shows
    await waitFor(cfg, scenario, 'the sync to start', `window.__mockCalSync.get().status === 'syncing'`);
    await waitFor(cfg, scenario, 'the sync to end', `window.__mockCalSync.get().status === 'ok'`);
    await settle();
    // access ended: Allow again starts a consent that waits (Cancel) and ends in every way
    await state('auth');
    await phase('Allow again waits');
    await setHash('calslow');
    await click('.mb-body .row-inline .btn.primary');
    await openBrowser();
    await waitFor(cfg, scenario, 'the waiting consent', `${last}.waiting`); await settle();
    await fitsNow('waiting');
    await shot('allow-waiting');
    await click('.set-status button.link', 'last'); // (Cancel is the last link of the waiting text: "What does this mean?" comes first)
    await waitFor(cfg, scenario, 'the end of the wait', `!${last}.waiting`); await settle();
    for (const why of ['timeout', 'denied', 'wrong', 'partial', 'blocked']) {
      await phase(`Allow again ends: ${why}`);
      await setHash(`calfail=${why}`);
      await click('.mb-body .row-inline .btn.primary');
      await openBrowser();
      await waitFor(cfg, scenario, `the wait of the "${why}" consent`, `${last}.waiting`, 3000);
      await waitFor(cfg, scenario, `the end of the "${why}" consent`, `!${last}.waiting && ${last}.text.length > 20`, 6000);
      await settle();
      await fitsNow(why);
      await shot(`allow-${why}`);
    }
    await state('ok');
  } else {
    // sync is off: the switch starts a consent in the browser
    await phase('switch on, waits');
    await setHash('calslow');
    await click(sw);
    await openBrowser();
    await waitFor(cfg, scenario, 'the waiting message', `${last}.waiting`, 4000);
    await settle();
    await fitsNow('waiting');
    await shot('waiting');
    await phase('Cancel');
    await click('.set-status button.link', 'last'); // (Cancel is the last link of the waiting text: "What does this mean?" comes first)
    await waitFor(cfg, scenario, 'the end of the wait', `!${last}.waiting`); await settle();
    await fitsNow('cancelled');
    await shot('cancelled');
    for (const why of ['timeout', 'denied', 'wrong', 'partial', 'blocked']) {
      await phase(`switch on ends: ${why}`);
      await setHash(`calfail=${why}`);
      await click(sw);
      await openBrowser();
      await waitFor(cfg, scenario, `the wait of the "${why}" consent`, `${last}.waiting`, 3000);
      await waitFor(cfg, scenario, `the end of the "${why}" consent`, `!${last}.waiting && ${last}.text.length > 20`, 6000);
      await settle();
      await fitsNow(why);
      await shot(why);
    }
  }
  await settle();
  report(cfg, scenario, await evaluate('window.__log'), (log) => {
    const texts = new Set(log.map((e) => e.s?.text).filter(Boolean));
    if (texts.size < (connected ? 12 : 4)) fail(cfg, scenario, `only ${texts.size} different status texts were seen`);
    if (!log.some((e) => e.s?.pos.slot && e.s.pos.slot[3] > 0)) fail(cfg, scenario, 'there is no status slot with a height');
  });
}

/** Every frame against the first: nothing moves, ever. */
function report(cfg, scenario, log, extra) {
  const first = log.find((e) => e.s)?.s;
  if (!first) { fail(cfg, scenario, 'the page never rendered'); return; }
  const moved = new Map();
  for (const { phase: ph, s } of log) {
    if (!s) continue;
    checks++;
    for (const k of Object.keys(first.pos)) {
      // a row that is not there in one of the two frames is not "moved" (the calendars list exists only while the calendar is connected)
      if (first.pos[k] === null || s.pos[k] === null) continue;
      if (!same(s.pos[k], first.pos[k])) { const key = `${k} (${ph})`; if (!moved.has(key)) moved.set(key, `${flat(first.pos[k])} -> ${flat(s.pos[k])}`); }
    }
  }
  for (const [k, v] of moved) fail(cfg, scenario, `${k} moved: ${v}`);
  extra?.(log.filter((e) => e.s).map((e) => ({ phase: e.phase, s: e.s })));
  const texts = new Set(log.map((e) => e.s?.text).filter(Boolean));
  const needs = log.map((e) => e.s?.need || 0);
  console.log(`  ok ${scenario} ${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme}: ${log.length} layout changes, ${texts.size} texts, the slot needs up to ${Math.max(0, ...needs)}px`);
}

const t0 = Date.now();
try {
  for (const cfg of CONFIGS) {
    if (ONLY.includes('google')) await runOAuth(cfg, 'google');
    if (ONLY.includes('microsoft')) await runOAuth(cfg, 'microsoft');
    if (ONLY.includes('imap')) await runImap(cfg);
    if (ONLY.includes('calendar')) await runCalendar(cfg, true);
    if (ONLY.includes('calendar-off')) await runCalendar(cfg, false);
  }
}
catch (e) { failures.push(`crashed: ${e.stack || e}`); }
finally { await H.shutdown(); }
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (failures.length) { console.error(`test-settings-layout: FAILED (${CONFIGS.length} configurations, ${secs}s)\n\n  ` + [...new Set(failures)].join('\n  ')); process.exit(1); }
console.log(`test-settings-layout: ok (${CONFIGS.map((c) => `${c.lang} ${c.w}x${c.h} ${c.theme}`).join(', ')}; ${checks} frames compared; ${secs}s)`);
