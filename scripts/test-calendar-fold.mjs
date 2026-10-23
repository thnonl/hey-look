#!/usr/bin/env node
// 1.0.7 WP7f2 (W7.11, owner request R3: no separate "Invitations · address" entry for a mailbox whose calendar is synced) in the real page: the dev preview with the
// mock backend (src/devMock.ts: `#caltwins&calsync=ok&calsyncms=ok`), real mouse events. The backend rules themselves (which invitation is folded, which one is a twin, the
// decoded Outlook ID) are proved by `cargo test --lib` (calendar.rs, calsync/microsoft_tests.rs, calsync/write.rs); the mock repeats them, so this test proves what the page does with them:
//  - the sidebar and the icon column list no Invitations entry for the synced mailboxes (Google and Outlook), and still list the IMAP and the not synced Gmail one;
//  - an invitation without a twin is drawn in its main calendar's colour and goes with that calendar's checkbox (month, week and agenda);
//  - a meeting that is both an invitation and a synced event shows once (the synced copy), in the three views;
//  - the popover of an invitation without a twin says it only came by mail (8 languages) and keeps Accept / Tentative / Decline; the synced copy has no such line;
//  - turning sync off, or the primary calendar's Sync off, brings the entry back with its events, its own checkbox and the state it had (hidden stays hidden); on again: folded again;
//  - the agenda with nothing in it says the same as before.
//
//   node scripts/test-calendar-fold.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir]
//   --quick  English, German and Japanese for the texts; the full run (no flag) is the 8 languages
import { flag, arg, sleep, startHarness, inputs } from './cdp-harness.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : flag('quick') ? ['en', 'de', 'ja'] : ALL;
const dicts = {};
for (const l of new Set(['en', ...LANGS])) dicts[l] = await loadDict(l);
const tr = (lang, key, params = {}) => {
  const m = dicts[lang]?.[key];
  if (typeof m !== 'string') throw new Error(`no text ${key} in ${lang}`);
  return m.replace(/\{(\w+)\}/g, (_, k) => String(params[k]));
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const H = await startHarness('test-calendar-fold', { vitePort0: 5174 });
const { evaluate } = H;
const { click, shot } = inputs(H, arg('shots'), 'fold');
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
const openApp = async (hash, w, h) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length + 250);
};
const setLook = async (lang) => {
  await evaluate(`window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); 1`);
  await waitFor(`document.documentElement.lang === ${JSON.stringify(lang)}`, `the page language ${lang}`, 25000);
  await sleep(150);
};
const view = async (v, dayOffset = 0) => {
  await evaluate(`(() => { const s = window.__store.getState(); const d = new Date(); d.setDate(d.getDate() + ${dayOffset}); s.setPrefs({ calView: ${JSON.stringify(v)} }); s.setCalDate({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }); })()`);
  await sleep(500);
};
const SIDE = '.folder-pane .cal-list label';
const sideLabels = () => evaluate(`[...document.querySelectorAll(${JSON.stringify(SIDE)})].map((l) => ({ text: l.querySelector('.ellipsis, span')?.textContent.trim(), checked: !!l.querySelector('input')?.checked }))`);
const railTitles = () => evaluate(`[...document.querySelectorAll('.folder-pane .fp-cal')].map((b) => b.getAttribute('aria-label'))`);
const ITEM = '.ag-row, .ev-chip, .wk-ev';
/** the events of the view whose text contains `title`: how many, and the colour each is drawn in */
const find = (title) => evaluate(`(() => { const out = []; for (const e of document.querySelectorAll(${JSON.stringify(ITEM)})) { const n = e.getAttribute('aria-label') || e.textContent; if (n.includes(${JSON.stringify(title)})) out.push(getComputedStyle(e).getPropertyValue('--ev').trim()); } return out; })()`);
const open = async (title) => {
  await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(ITEM)})].find((x) => (x.getAttribute('aria-label') || x.textContent).includes(${JSON.stringify(title)})); e && e.scrollIntoView({ block: 'center' }); })()`);
  await sleep(120);
  const at = await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(ITEM)})].find((x) => (x.getAttribute('aria-label') || x.textContent).includes(${JSON.stringify(title)})); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + Math.min(20, r.width / 2), r.top + r.height / 2]; })()`);
  if (!at) { ok(false, `no event "${title}" to open`); return null; }
  await H.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
  await H.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', clickCount: 1 });
  await H.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', clickCount: 1 });
  await waitFor(`document.querySelector('.ev-pop')`, `the popover of ${title}`);
  return evaluate(`(() => { const p = document.querySelector('.ev-pop'); return { text: p.textContent.replace(/\\s+/g, ' ').trim(), buttons: [...p.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim()), notes: [...p.querySelectorAll('.muted.small')].map((n) => n.textContent.trim()) }; })()`);
};
const closePop = async () => { await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(150); };
const showSidebar = async () => {
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'expanded' }); window.__store.getState().setModule('calendar'); 1`);
  await waitFor(`document.querySelector('.cal-list')`, 'the calendar list', 10000);
  await sleep(300);
};
const click1 = (label) => evaluate(`(() => { const l = [...document.querySelectorAll(${JSON.stringify(SIDE)})].find((x) => x.textContent.includes(${JSON.stringify(label)})); l.querySelector('input').click(); })()`);
const HASH = 'lang=en&light&caltwins&calsync=ok&calsyncms=ok';
const GOOGLE = '#039be5', MS = '#0078d4';
const INV_G = 'Invitations · nam@gmail.com', INV_M = 'Invitations · nam@outlook.com', INV_1 = 'Invitations · nam@example.com', INV_3 = 'Invitations · nam.work@gmail.com';

try {
  // ------------------------------------------------------------------ AC-7.11.1: the sidebar and the icon column
  await openApp(HASH, 1280, 800);
  await showSidebar();
  let labels = (await sideLabels()).map((l) => l.text);
  ok(!labels.includes(INV_G) && !labels.includes(INV_M), `no Invitations entry for the Google and the Outlook mailbox (${labels.join(' | ')})`);
  ok(labels.includes(INV_1) && labels.includes(INV_3), 'the IMAP mailbox and the Gmail mailbox without sync keep their Invitations entry');
  ok(labels.includes('My events') && labels.some((l) => l.startsWith('Nam')) && labels.some((l) => l.startsWith('Calendar')), 'My events and the synced calendars are listed');
  await shot('sidebar-folded');
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'collapsed' }); 1`);
  await waitFor(`document.querySelector('.folder-pane.is-rail .fp-cal')`, 'the icon column');
  const rail = await railTitles();
  ok(!rail.includes(INV_G) && !rail.includes(INV_M) && rail.includes(INV_1) && rail.includes(INV_3), `the icon column likewise (${rail.join(' | ')})`);
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'expanded' }); 1`);
  await sleep(300);

  // ------------------------------------------------------------------ AC-7.11.2: the colour and the checkbox of the main calendar
  await view('agenda');
  let c = await find('Only by mail (Google)');
  ok(c.length === 1 && c[0] === GOOGLE, `an invitation without a twin is drawn in the main calendar's colour (${JSON.stringify(c)})`);
  c = await find('Only by mail (Outlook)');
  ok(c.length === 1 && c[0] === MS, `the same for Outlook (${JSON.stringify(c)})`);
  c = await find('Hiring panel');
  ok(c.length === 1 && c[0] === GOOGLE, `and for an invitation that was there before (${JSON.stringify(c)})`);
  c = await find('Design review');
  ok(c.length === 1 && c[0] !== GOOGLE && c[0] !== MS, `an IMAP mailbox's invitation keeps the mailbox colour (${JSON.stringify(c)})`);
  await click1('Nam ·');
  await sleep(500);
  ok((await find('Only by mail (Google)')).length === 0 && (await find('Planning twin')).length === 0 && (await find('Hiring panel')).length === 0, 'unticking Nam hides the invitation and the main calendar\'s events');
  ok((await find('Only by mail (Outlook)')).length === 1, 'the other mailbox is not touched');
  await click1('Nam ·');
  await sleep(500);
  ok((await find('Only by mail (Google)')).length === 1 && (await find('Planning twin')).length === 1, 'ticking it shows both again');

  // ------------------------------------------------------------------ AC-7.11.3: a twin pair shows once, in all three views
  const TWINS = ['Planning twin', 'Budget twin', 'Offsite title twin'];
  for (const [v, off] of [['agenda', 0], ['month', 0], ['week', 5]]) {
    await view(v, off);
    // (a month cell shows its first events and folds the rest into "+N more": there a meeting must not show twice, and may be missing)
    const most = v === 'month' ? 1 : 1, least = v === 'month' ? 0 : 1;
    for (const t of TWINS) { const n = (await find(t)).length; ok(n >= least && n <= most, `${v}: "${t}" shows once (${n})`); }
    const lone = (await find('Only by mail (Outlook)')).length;
    ok(lone >= least && lone <= 1, `${v}: an invitation without a twin shows (${lone})`);
  }
  await view('agenda');
  c = await find('Planning twin');
  ok(c[0] === GOOGLE, 'the synced copy is the one shown');

  // ------------------------------------------------------------------ AC-7.11.4: the popover line
  for (const lang of LANGS) {
    await setLook(lang);
    await view('agenda');
    let p = await open('Only by mail (Google)');
    const want = tr(lang, 'calendar.pop.inviteLocalOnly', { service: 'Google Calendar' });
    ok(p && p.notes.includes(want), `${lang}: the popover of an invitation without a twin says "${want}" (${JSON.stringify(p?.notes)})`);
    ok(p && [tr(lang, 'calendar.rsvp.accept'), tr(lang, 'calendar.rsvp.tentative'), tr(lang, 'calendar.rsvp.decline')].every((b) => p.buttons.some((x) => x.includes(b))), `${lang}: Accept, Tentative and Decline are there (${JSON.stringify(p?.buttons)})`);
    ok(p && !/\{\w+\}|calendar\.pop\./.test(p.text), `${lang}: no raw key or placeholder`);
    if (lang === LANGS[0]) await shot('popover-local-only');
    await closePop();
    p = await open('Only by mail (Outlook)');
    ok(p && p.notes.includes(tr(lang, 'calendar.pop.inviteLocalOnly', { service: 'Outlook' })), `${lang}: Outlook names Outlook`);
    await closePop();
    p = await open('Planning twin');
    ok(p && !p.notes.some((n) => n.includes(tr(lang, 'calendar.pop.inviteLocalOnly', { service: 'Google Calendar' }).slice(0, 12))) && !p.text.includes(tr(lang, 'calendar.pop.inviteLocalOnly', { service: 'Google Calendar' })), `${lang}: the synced copy has no such line`);
    await closePop();
    p = await open('Design review');
    ok(p && !p.text.includes(tr(lang, 'calendar.pop.inviteLocalOnly', { service: 'Google Calendar' })), `${lang}: an IMAP mailbox's invitation has no such line`);
    await closePop();
  }
  await setLook('en');

  // ------------------------------------------------------------------ AC-7.11.5: sync off, and the primary calendar's Sync off, bring the entry back
  await openApp(HASH, 1280, 800);
  await showSidebar();
  await click1(INV_1); // the IMAP mailbox's entry is hidden first
  await sleep(300);
  const inv1Before = (await sideLabels()).find((l) => l.text === INV_1)?.checked;
  ok(inv1Before === false, 'the IMAP mailbox\'s Invitations entry is unticked');
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a2', focus: 'calendar', nonce: Date.now() }); 1`);
  await waitFor(`document.querySelector('#set-calendar .switch input')`, 'Settings > Calendar');
  await click('#set-calendar .switch'); // switch off
  await waitFor(`document.querySelector('.ask')`, 'the question of turning it off');
  await click('.ask-actions button:last-child');
  await waitFor(`!document.querySelector('#set-calendar .switch input').checked`, 'the switch off', 6000);
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await showSidebar();
  await view('agenda');
  labels = await sideLabels();
  ok(labels.some((l) => l.text === INV_G && l.checked), `sync off: "${INV_G}" is back and ticked`);
  ok(labels.some((l) => l.text === INV_1 && !l.checked), `"${INV_1}" is still unticked`);
  c = await find('Only by mail (Google)');
  ok(c.length === 1 && c[0] !== GOOGLE, `its events are back in the mailbox colour (${JSON.stringify(c)})`);
  ok((await find('Planning twin')).length === 1, 'the meeting that is only an invitation now shows (its synced copy is gone)');
  // sync on again: folded again
  await evaluate(`window.__mockCalSync.connectResult = 'ok'; window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a2', focus: 'calendar', nonce: Date.now() }); 1`);
  await waitFor(`document.querySelector('#set-calendar .switch input')`, 'Settings > Calendar again');
  await click('#set-calendar .switch');
  await waitFor(`document.querySelector('.ask')`, 'the question of turning it on');
  await click('.ask-actions button:last-child');
  await waitFor(`document.querySelector('#set-calendar .switch input').checked && !document.querySelector('#set-calendar .switch input').disabled`, 'the switch on', 8000);
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await showSidebar();
  await sleep(500);
  labels = (await sideLabels()).map((l) => l.text);
  ok(!labels.includes(INV_G), 'sync on again: folded again');
  // the primary calendar's own Sync switch off: the entry comes back; on: folded
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a2', focus: 'calendar', nonce: Date.now() }); 1`);
  await waitFor(`document.querySelector('#set-calendar .switch input')`, 'Settings > Calendar for the per-calendar switch');
  await sleep(300);
  const SWN = `[...document.querySelectorAll('.settings-body .set-row')].find((r) => r.textContent.includes('Nam') && r.textContent.includes('Primary'))?.querySelector('.switch input')`;
  await evaluate(`${SWN}.click(); 1`);
  await sleep(500);
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await showSidebar();
  labels = (await sideLabels()).map((l) => l.text);
  ok(labels.includes(INV_G), 'the main calendar\'s Sync is off: the Invitations entry is back');
  await shot('unfolded-again');
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a2', focus: 'calendar', nonce: Date.now() }); 1`);
  await waitFor(`document.querySelector('#set-calendar .switch input')`, 'Settings > Calendar');
  await sleep(300);
  await evaluate(`${SWN}.click(); 1`);
  await sleep(500);
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await showSidebar();
  labels = (await sideLabels()).map((l) => l.text);
  ok(!labels.includes(INV_G), 'the main calendar\'s Sync is on again: folded again');

  // ------------------------------------------------------------------ AC-7.11.6: the agenda with nothing in it (every calendar hidden)
  await evaluate(`import('/src/api.ts').then(async (m) => { const s = window.__store.getState(); for (const c of s.calendars) await m.api.calendarSetVisible(c.id, false); s.bumpCal(); })`);
  for (const lang of LANGS) {
    await setLook(lang);
    await evaluate(`window.__store.getState().setPrefs({ calView: 'agenda' }); 1`);
    await waitFor(`document.querySelector('.agenda .empty-state, .agenda .empty-title')`, `${lang}: the empty agenda`, 6000);
    const t = await evaluate(`document.querySelector('.agenda')?.textContent ?? ''`);
    ok(t.includes(tr(lang, 'calendar.agenda.emptyText')) && t.includes(tr(lang, 'calendar.agenda.emptyTitle')), `${lang}: the empty agenda says what it said before ("${t}")`);
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
console.log(`ok - test-calendar-fold (${checks} checks)`);
