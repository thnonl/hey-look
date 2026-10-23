#!/usr/bin/env node
// 1.0.7 WP7a in the real page (dev preview with the mock backend, src/devMock.ts), with real mouse and key events:
//  - W7.7  Settings > mailbox > Calendar: the switch (and "Allow access again") asks before the browser opens. Cancel and Esc change nothing, put the focus back and
//          make no calendar_connect call; "Open browser" makes exactly one. The question shows the provider and the address (Google, Microsoft), in all 8 languages,
//          light and dark, at 960 x 560: its words are the dictionary's, its two buttons are on one row and inside the box.
//  - W7.8  A build without the OAuth client of a service (calendar_kinds_available): the switch is disabled and the muted note says so in all 8 languages.
//  - W7.3  A mail whose sender check failed: the warning on the card (REQUEST update, CANCEL, REPLY, new invitation), the held-change sentence and the
//          Apply anyway button only where a change was held, Apply anyway makes one call with the check skipped and a toast; nothing is clipped in 8 languages.
//  - W7.2  An event with extra dates and no rule shows "Custom" in its popover.
//
//   node --experimental-strip-types scripts/test-calendar-consent.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir]
//   --quick  English, German and Japanese; the full run (no flag) is the 8 languages
import fs from 'node:fs';
import path from 'node:path';
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

const H = await startHarness('test-calendar-consent', { vitePort0: 5120 });
const { evaluate, cdp } = H;
const { press, clickAt, click, shot } = inputs(H, arg('shots'), 'consent');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
const waitFor = async (expr, what, ms = 8000) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(60)) if (await evaluate(`!!(${expr})`)) return true;
  ok(false, `timed out waiting for ${what}`);
  return false;
};
const SW = '#set-calendar .switch input';
const connects = () => evaluate('JSON.stringify(window.__mockCalConnects || [])').then(JSON.parse);
const setLook = (theme, lang) => evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
const openCalendarSettings = async (account) => {
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:${account}', focus: 'calendar' }); 1`);
  await waitFor(`document.querySelector(${JSON.stringify(SW)})`, `the Calendar section of ${account}`);
  await sleep(200);
};
const ask = () => evaluate(`(() => {
  const a = document.querySelector('.ask'); if (!a) return null;
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height }; };
  const btns = [...a.querySelectorAll('.ask-actions button')];
  return { title: a.querySelector('h3')?.textContent ?? '', body: a.querySelector('p')?.textContent ?? '', buttons: btns.map((b) => b.textContent), rects: btns.map(r), box: r(a),
    overflowX: a.scrollWidth - a.clientWidth, focus: document.activeElement === btns[0] ? 'first' : document.activeElement?.textContent ?? '', vh: window.innerHeight };
})()`);
const focusIsSwitch = () => evaluate(`document.activeElement === document.querySelector(${JSON.stringify(SW)})`);
const statusText = () => evaluate(`(document.querySelector('#set-calendar')?.closest('.settings, .modal')?.querySelector('.set-status')?.textContent ?? '').trim()`);

try {
  // ------------------------------------------------------------------ W7.7: the question before the browser opens (English, light, 960 x 560)
  await H.openApp('lang=en&light', 960, 560);
  await openCalendarSettings('a2');
  ok(!(await evaluate(`document.querySelector(${JSON.stringify(SW)}).checked`)), 'a2: the switch starts off');
  await click('#set-calendar .switch');
  ok(await waitFor(`document.querySelector('.ask')`, 'the question after pressing the switch'), 'no question');
  let q = await ask();
  ok(q && q.title === 'Allow calendar access in your browser?', `title: ${q?.title}`);
  ok(q && q.body === 'Hey Look! opens Google’s page in your browser. Sign in as nam@gmail.com there and allow access to your calendars. Your mail sign-in doesn’t change.', `body: ${q?.body}`);
  ok(q && q.buttons.join('|') === 'Cancel|Open browser', `buttons: ${q?.buttons}`);
  ok((await connects()).length === 0, 'the browser step has not started while the question is open');
  ok(!(await evaluate(`document.querySelector(${JSON.stringify(SW)}).checked`)), 'the switch stays off while the question is open');
  // Cancel (button)
  await click('.ask-actions button:first-child');
  await sleep(250);
  ok(!(await evaluate(`!!document.querySelector('.ask')`)), 'Cancel closes the question');
  ok(!(await evaluate(`document.querySelector(${JSON.stringify(SW)}).checked`)) && (await connects()).length === 0, 'Cancel: the switch is off and nothing was started');
  ok(await focusIsSwitch(), 'Cancel: the focus is back on the switch');
  ok((await statusText()) === '', `Cancel: no status text (${await statusText()})`);
  // Esc
  await click('#set-calendar .switch');
  await waitFor(`document.querySelector('.ask')`, 'the question again');
  await press('Escape', 'Escape');
  await sleep(250);
  ok(!(await evaluate(`!!document.querySelector('.ask')`)), 'Esc closes the question');
  ok(await evaluate(`!!document.querySelector('.settings, .modal')`), 'Esc answers the question only: Settings is still open');
  ok(!(await evaluate(`document.querySelector(${JSON.stringify(SW)}).checked`)) && (await connects()).length === 0, 'Esc: the switch is off and nothing was started');
  ok(await focusIsSwitch(), 'Esc: the focus is back on the switch');
  // Open browser: one call, for this mailbox
  await click('#set-calendar .switch');
  await waitFor(`document.querySelector('.ask')`, 'the question a third time');
  await click('.ask-actions button:last-child');
  await waitFor(`window.__mockCalConnects && window.__mockCalConnects.length === 1`, 'the one calendar_connect call');
  ok(JSON.stringify(await connects()) === '["a2"]', `Open browser: one call for a2 (${JSON.stringify(await connects())})`);
  ok(!(await evaluate(`!!document.querySelector('.ask')`)), 'Open browser closes the question');
  await waitFor(`document.querySelector(${JSON.stringify(SW)}).checked && !document.querySelector(${JSON.stringify(SW)}).disabled`, 'the first consent to end', 6000);

  // Microsoft: the other provider name and address
  await H.openApp('lang=en&light', 960, 560);
  await openCalendarSettings('a4');
  await click('#set-calendar .switch');
  await waitFor(`document.querySelector('.ask')`, 'the question for Outlook');
  q = await ask();
  ok(q && q.body === 'Hey Look! opens Microsoft’s page in your browser. Sign in as nam@outlook.com there and allow access to your calendars. Your mail sign-in doesn’t change.', `Microsoft body: ${q?.body}`);
  await press('Escape', 'Escape');
  await sleep(200);
  ok((await connects()).length === 0, 'Microsoft: Esc starts nothing');

  // "Allow access again" (the access-ended state): the same question, the focus returns to that button
  await H.openApp('lang=en&light&calsync=auth', 960, 560);
  await openCalendarSettings('a2');
  const again = '.set-actions button.primary';
  await waitFor(`document.querySelector(${JSON.stringify(again)})`, 'the Allow access again button');
  await click(again);
  await waitFor(`document.querySelector('.ask')`, 'the question for Allow access again');
  q = await ask();
  ok(q && q.title === 'Allow calendar access in your browser?', 'Allow access again: the same question');
  await click('.ask-actions button:first-child');
  await sleep(250);
  ok((await connects()).length === 0, 'Allow access again: Cancel starts nothing');
  ok(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(again)})`), 'Allow access again: the focus is back on the button');
  await click(again);
  await waitFor(`document.querySelector('.ask')`, 'the question again');
  await click('.ask-actions button:last-child');
  await waitFor(`window.__mockCalConnects && window.__mockCalConnects.length === 1`, 'the call after Open browser');
  await waitFor(`!document.querySelector(${JSON.stringify(again)})`, 'the consent to end', 6000);

  // ------------------------------------------------------------------ the question in every language and both themes
  await H.openApp('lang=en&light', 960, 560);
  await openCalendarSettings('a2');
  for (const theme of THEMES) for (const lang of LANGS) {
    await setLook(theme, lang);
    await sleep(150);
    await click('#set-calendar .switch');
    await waitFor(`document.querySelector('.ask')`, `the question ${lang} ${theme}`);
    const g = await ask();
    const tag = `${lang} ${theme}`;
    ok(g.title === tr(lang, 'calendar.consent.title'), `${tag}: title "${g.title}"`);
    ok(g.body === tr(lang, 'calendar.consent.body', { provider: 'Google', email: 'nam@gmail.com' }), `${tag}: body "${g.body}"`);
    ok(g.buttons[0] === tr(lang, 'common.cancel') && g.buttons[1] === tr(lang, 'calendar.consent.open'), `${tag}: buttons ${g.buttons}`);
    ok(!/\{\w+\}|calendar\.consent/.test(g.title + g.body + g.buttons.join('')), `${tag}: no raw key or placeholder`);
    ok(g.title.length > 3 && g.body.length > 30, `${tag}: title and body are not empty`);
    ok(Math.abs(g.rects[0].t - g.rects[1].t) <= 2 && g.rects[0].r <= g.rects[1].l, `${tag}: the buttons are on one row (${JSON.stringify(g.rects.map((r) => [r.t, r.l, r.r]))})`);
    ok(g.rects.every((r) => r.l >= g.box.l - 0.5 && r.r <= g.box.r + 0.5 && r.b <= g.box.b + 0.5), `${tag}: the buttons are inside the box`);
    ok(g.overflowX <= 1 && g.box.b <= g.vh && g.box.t >= 0, `${tag}: the box is not clipped (overflow ${g.overflowX}, ${g.box.t}..${g.box.b} of ${g.vh})`);
    if (lang === LANGS[0]) await shot(`ask-${lang}-${theme}`);
    await press('Escape', 'Escape');
    await sleep(150);
  }

  // ------------------------------------------------------------------ W7.8: a build without the OAuth client of the service
  for (const [hash, expect] of [['calkinds=none', { a2: true, a4: true }], ['calkinds=microsoft', { a2: true, a4: false }], ['calkinds=google', { a2: false, a4: true }], ['', { a2: false, a4: false }]]) {
    for (const acc of ['a2', 'a4']) {
      await H.openApp(`lang=en&light${hash ? `&${hash}` : ''}`, 960, 560);
      await openCalendarSettings(acc);
      await sleep(250);
      const st = await evaluate(`(() => { const i = document.querySelector(${JSON.stringify(SW)}); const n = document.querySelector('.set-status'); return { disabled: i.disabled, note: (n?.textContent ?? '').trim() }; })()`);
      const provider = acc === 'a2' ? 'Google' : 'Microsoft';
      const want = tr('en', 'calendar.err.noClient', { provider });
      ok(st.disabled === expect[acc], `${hash || 'both kinds'} ${acc}: the switch is ${st.disabled ? 'disabled' : 'enabled'}, expected ${expect[acc] ? 'disabled' : 'enabled'}`);
      ok(expect[acc] ? st.note === want : st.note === '', `${hash || 'both kinds'} ${acc}: note "${st.note}"`);
    }
  }
  await H.openApp('lang=en&light&calkinds=none', 960, 560);
  await openCalendarSettings('a2');
  for (const theme of THEMES) for (const lang of LANGS) {
    await setLook(theme, lang);
    await sleep(150);
    const st = await evaluate(`(() => { const n = document.querySelector('.set-status'); const b = n.getBoundingClientRect(); const p = n.closest('.set-body, .modal-body, .settings')?.getBoundingClientRect(); return { note: n.textContent.trim(), disabled: document.querySelector(${JSON.stringify(SW)}).disabled, over: n.scrollWidth - n.clientWidth, right: b.right, pr: p ? p.right : 1e9 }; })()`);
    ok(st.disabled && st.note === tr(lang, 'calendar.err.noClient', { provider: 'Google' }), `${lang} ${theme}: noClient note "${st.note}"`);
    ok(st.over <= 1 && st.right <= st.pr + 1, `${lang} ${theme}: the note is not clipped`);
    ok(!(await evaluate(`!!document.querySelector('.ask')`)), `${lang} ${theme}: nothing to click into an error`);
  }
  await shot('no-client');

  // ------------------------------------------------------------------ W7.3: the sender check on the card
  const CARDS = [
    { thread: 't30', msg: 'm-unv-upd', name: 'Mai Khanh', held: true },
    { thread: 't31', msg: 'm-unv-cancel', name: 'Vendor Ops', held: true },
    { thread: 't32', msg: 'm-unv-reply', name: 'Bao Tran', held: true },
    { thread: 't33', msg: 'm-unv-new', name: 'Mai Khanh', held: false },
  ];
  await H.openApp('lang=en&light&unverified', 960, 560);
  const card = () => evaluate(`(() => {
    const art = document.querySelector('.rp-msg-body article.invite, article.invite'); if (!art) return null;
    const n = art.querySelector('.notice.bad[role="alert"]');
    const b = n && [...n.querySelectorAll('button')].map((x) => x.textContent);
    const r = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom }; };
    return { has: !!n, text: n?.textContent ?? '', buttons: b ?? [], over: n ? n.scrollWidth - n.clientWidth : 0, box: n && r(n), btnBoxes: n ? [...n.querySelectorAll('button')].map(r) : [], role: n?.getAttribute('role') };
  })()`);
  for (const c of CARDS) {
    for (const theme of THEMES) for (const lang of LANGS) {
      await setLook(theme, lang);
      await evaluate(`window.__store.getState().select(${JSON.stringify(c.thread)}).then(() => 1)`);
      await waitFor(`document.querySelector('article.invite')`, `the card of ${c.msg}`);
      // (the first switch to a language loads its dictionary: wait until the card speaks it)
      const first = JSON.stringify(tr(lang, 'calendar.invite.unverified', { name: c.name }).slice(0, 12));
      await waitFor(`document.querySelector('article.invite .notice.bad[role="alert"]')?.textContent.startsWith(${first})`, `the warning in ${lang}`, 4000);
      await sleep(80);
      const g = await card();
      const tag = `${c.msg} ${lang} ${theme}`;
      ok(g && g.has, `${tag}: the warning is on the card`);
      if (!g || !g.has) continue;
      const want = tr(lang, 'calendar.invite.unverified', { name: c.name });
      ok(g.text.startsWith(want), `${tag}: warning text "${g.text}"`);
      ok(g.role === 'alert', `${tag}: the warning is announced (role=${g.role})`);
      if (c.held) {
        ok(g.text === `${want} ${tr(lang, 'calendar.invite.held')} ${tr(lang, 'calendar.invite.applyAnyway')}`, `${tag}: the held sentence and the button: "${g.text}"`);
        ok(g.buttons.length === 1 && g.buttons[0] === tr(lang, 'calendar.invite.applyAnyway'), `${tag}: Apply anyway is the only button (${g.buttons})`);
      } else {
        ok(g.buttons.length === 0 && g.text === want, `${tag}: nothing held, so no sentence and no button: "${g.text}"`);
      }
      ok(g.over <= 1, `${tag}: no sideways overflow (${g.over})`);
      ok(g.btnBoxes.every((b) => b.l >= g.box.l - 0.5 && b.r <= g.box.r + 0.5), `${tag}: the button is inside the warning`);
      ok(g.box.r <= 960 && g.box.b <= 560 + 4000, `${tag}: the warning is inside the pane`);
    }
  }
  // Apply anyway: one call with the check skipped, a toast, the button is gone and the warning stays
  await setLook('light', 'en');
  await evaluate(`window.__store.getState().select('t30').then(() => 1)`);
  await waitFor(`document.querySelector('article.invite .notice.bad button.link')`, 'Apply anyway');
  await evaluate(`document.querySelector('article.invite .notice.bad button.link').scrollIntoView({ block: 'center' }); 1`);
  await click('article.invite .notice.bad button.link');
  await waitFor(`window.__mockApplied && window.__mockApplied.length === 1`, 'the apply call');
  const applied = await evaluate('JSON.stringify(window.__mockApplied)');
  ok(applied === '[{"messageId":"m-unv-upd","overrideAuth":true}]', `Apply anyway: one call with overrideAuth (${applied})`);
  await waitFor(`document.body.innerText.includes(${JSON.stringify(tr('en', 'calendar.toast.applied'))})`, 'the toast "Your calendar was updated"');
  await waitFor(`!document.querySelector('article.invite .notice.bad button.link')`, 'the button to go');
  const after = await card();
  ok(after.has && after.text === tr('en', 'calendar.invite.unverified', { name: 'Mai Khanh' }), `after Apply anyway the warning stays and nothing is held: "${after.text}"`);
  ok(await evaluate(`document.activeElement === document.querySelector('article.invite .notice.bad')`), 'after Apply anyway the focus stays on the warning, not on the page');
  await shot('unverified-applied');
  // a mail with a passing check or none has no warning at all
  await evaluate(`window.__store.getState().select('t15').then(() => 1)`);
  await waitFor(`document.querySelector('article.invite')`, 'an ordinary invitation');
  ok(!(await card()).has, 'an invitation without a failed check has no warning');

  // ------------------------------------------------------------------ W7.2: extra dates and no rule = "Custom"
  for (const lang of LANGS) {
    await H.openApp(`lang=${lang}&light&rdate`, 960, 560);
    await evaluate(`window.__store.getState().setModule('calendar'); window.__store.getState().setCalView('agenda'); 1`);
    await waitFor(`[...document.querySelectorAll('.ag-row')].some((r) => r.textContent.includes('Reading group'))`, `the series with extra dates in the agenda (${lang})`);
    await evaluate(`[...document.querySelectorAll('.ag-row')].find((r) => r.textContent.includes('Reading group')).scrollIntoView({ block: 'center' }); 1`);
    const pt = await evaluate(`(() => { const r = [...document.querySelectorAll('.ag-row')].find((x) => x.textContent.includes('Reading group')).getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; })()`);
    await clickAt(pt[0], pt[1]);
    await waitFor(`document.querySelector('.ev-pop')`, `the popover (${lang})`);
    const text = await evaluate(`document.querySelector('.ev-pop').textContent`);
    ok(text.includes(tr(lang, 'calendar.repeat.customFallback')), `${lang}: the popover of a series with extra dates says "${tr(lang, 'calendar.repeat.customFallback')}" ("${text.slice(0, 120)}")`);
    ok(!/calendar\.repeat/.test(text), `${lang}: no raw key`);
  }
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-calendar-consent: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-calendar-consent: ${checks} checks passed`);
