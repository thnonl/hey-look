#!/usr/bin/env node
// 1.0.7 W7.5 (move an event to another calendar, make a calendar, the colour of a synced calendar) in the dev preview with REAL mouse and key events. Events on fixed days of October 2030 (never today's date).
//   - AC-7.5.1/.2/.4  the popover has "Move to another calendar..." for the user's own event with a writable calendar to go to; the dialog lists the calendars of the same mailbox (My events: every writable synced one);
//                     one call makes the move, the toast names the calendar, the event is in the target; an event with guests where the service cannot move it shows the sentence instead of the list; a series says it moves whole
//   - AC-7.5.5        Settings > Calendar: the dot of a calendar is a button that opens the colour choice; a colour is kept and shown (sidebar list, chips, Settings); "Color from <service>" restores the service's
//   - AC-7.5.6        New calendar: the dialog, the call, the toast, the calendar in the list; a refusal stays in the dialog with what was typed; Google offers none until its permission is part of the consent
//   - AC-7.5.7        keyboard only (Tab to the button, Enter, a choice with the keys, Esc back to the event); 8 languages at 960 x 560, Light and Dark; the pending state of a slow move by 150 ms (scaled)
//
//   node --experimental-strip-types scripts/test-calendar-move-ui.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir]
import { flag, arg, sleep, startHarness, inputs } from './cdp-harness.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : flag('quick') ? ['en', 'de'] : ALL;
const dicts = {};
for (const l of new Set(['en', ...LANGS])) dicts[l] = await loadDict(l);
const D = dicts.en;
const tr = (lang, key, params = {}) => {
  const m = dicts[lang]?.[key];
  if (typeof m !== 'string') throw new Error(`no text ${key} in ${lang}`);
  return m.replace(/\{(\w+)\}/g, (_, k) => String(params[k]));
};

const H = await startHarness('test-calendar-move-ui', { vitePort0: 5160 });
const { evaluate, cdp } = H;
const { click, clickAt, typeText, press, shot } = inputs(H, arg('shots'), 'move');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
let scale = 1;
const slow = (ms) => Math.round(ms * scale);
const waitFor = async (expr, what, ms = 8000, soft = false) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms * Math.max(1, scale); await sleep(40)) if (await evaluate(`!!(${expr})`)) return true;
  if (!soft) ok(false, `timed out waiting for ${what}`);
  return false;
};
const openApp = async (hash, w = 1280, h = 800) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length + 250);
};
const key = async (k, code, vk, modifiers = 0, text) => {
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const enter = () => key('Enter', 'Enter', 13, 0, '\r');
const esc = () => key('Escape', 'Escape', 27);
const tab = () => key('Tab', 'Tab', 9);

const at = (iso) => Date.parse(iso) / 1000;
const G_PRIMARY = 'google:a2:primary';
const hash = (extra = '') => `lang=en&light&calsync=ok&calsyncms=ok${extra}`;
const GUEST = [{ email: 'g@x.test', name: 'Guest', role: 'required', status: 'needs-action', isYou: false }];
const seed = () => evaluate(`(() => {
  const s = window.__store.getState();
  s.setPrefs({ calTz: 'Europe/Berlin' });
  const add = (id, title, day, over) => window.__mockAddEvent(id, title, ${at('2030-10-01T08:00:00Z')} + (day - 1) * 86400, ${at('2030-10-01T09:00:00Z')} + (day - 1) * 86400, over);
  add('mv1', 'Move me', 15, { calendarId: '${G_PRIMARY}', accountId: 'a2', remoteMock: true, readOnly: null });
  add('mv2', 'Outlook guest', 16, { calendarId: 'ms:a4:primary', accountId: 'a4', remoteMock: true, readOnly: null, attendees: ${JSON.stringify(GUEST)} });
  add('mv3', 'Local plain', 17, {});
  add('mv4', 'Local guest', 18, { attendees: ${JSON.stringify(GUEST)} });
  add('mv5', 'Weekly G', 22, { calendarId: '${G_PRIMARY}', accountId: 'a2', remoteMock: true, readOnly: null, rrule: 'FREQ=WEEKLY;COUNT=2', series: true });
  add('mv6', 'Holiday', 20, { calendarId: 'google:a2:holidays', accountId: 'a2', remoteMock: true, readOnly: 'calendar' });
  add('mv7', 'Google guest', 21, { calendarId: '${G_PRIMARY}', accountId: 'a2', remoteMock: true, readOnly: null, attendees: ${JSON.stringify(GUEST)} });
  s.setModule('calendar'); s.setCalView('month'); s.setCalDate({ y: 2030, m: 10, d: 15 });
  return 1;
})()`);
const shown = async () => {
  await seed();
  await waitFor(`[...document.querySelectorAll('.month-grid .ev-chip')].some((c) => c.textContent.includes('Move me'))`, 'the month with the events');
  await waitFor(`document.querySelector('.cal-view')?.getAttribute('aria-busy') === 'false'`, 'the calendar to finish loading');
  await sleep(500);
};
const chip = (text) => evaluate(`(() => { const e = [...document.querySelectorAll('.month-grid .ev-chip')].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 30), r.top + r.height / 2]; })()`);
const openPop = async (text) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let t0 = Date.now(); Date.now() - t0 < 9000 && (await evaluate(`!!document.querySelector('.toast')`)); await sleep(100));
    const c = await chip(text);
    if (!c) { ok(false, `the event "${text}" is on screen`); return false; }
    await clickAt(c[0], c[1]);
    if (await waitFor(`document.querySelector('.ev-pop')`, `the popover of ${text}`, 3000, true)) { await sleep(300); return true; }
    if (attempt === 0) console.log(`RETRY the popover of ${text}`);
  }
  ok(false, `the popover of ${text} did not open`);
  return false;
};
const popButtons = () => evaluate(`[...document.querySelectorAll('.ev-pop .ev-foot button')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim())`);
const pressIn = async (sel, text) => {
  const c = await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(text)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  ok(!!c, `a ${sel} "${text}" is on screen`);
  if (c) await clickAt(c[0], c[1]);
  return !!c;
};
const moveDialog = () => evaluate(`(() => {
  const all = document.querySelectorAll('.modal'); const m = all[all.length - 1]; if (!m) return null;
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const btns = [...m.querySelectorAll('.row-inline .btn')];
  const sel = m.querySelector('#mv-to');
  return { title: m.querySelector('.modal-head b')?.textContent ?? '', select: sel ? [...sel.options].map((o) => o.textContent) : null, value: sel?.value ?? null, notice: m.querySelector('.notice')?.textContent ?? null,
    series: [...m.querySelectorAll('.muted.small')].map((e) => e.textContent).join(' | '), buttons: btns.map((b) => b.textContent), err: m.querySelector('.field-err')?.textContent ?? null,
    busy: btns.some((b) => b.getAttribute('aria-busy') === 'true'), box: r(m), rects: btns.map(r), overflowX: m.scrollWidth - m.clientWidth, vw: window.innerWidth, vh: window.innerHeight, focus: document.activeElement?.id || document.activeElement?.textContent || '' };
})()`);
const moves = () => evaluate('JSON.stringify(window.__mockMoves || [])').then(JSON.parse);
const toast = () => evaluate(`[...document.querySelectorAll('.toast')].map((x) => x.textContent.trim()).join(' | ')`);
const closeAll = async () => {
  for (let i = 0; i < 6; i++) {
    if (!(await evaluate(`!!document.querySelector('.ev-pop, .modal, .ask')`))) break;
    await esc();
    await sleep(150);
  }
  await sleep(200);
};
const store = (expr) => evaluate(`(() => { const s = window.__store.getState(); return ${expr}; })()`);

try {
  await openApp(hash());
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / 48), 8);
  console.log(`test-calendar-move-ui: reference work ${cal.cpu} ms (reference 48): scale ${scale.toFixed(2)}`);
  await openApp(hash());
  await shown();

  // ------------------------------------------------------------------ AC-7.5.1: a Google event moves within the mailbox
  ok(await openPop('Move me'), 'popover');
  let names = await popButtons();
  ok(names.includes(D['calendar.pop.moveTo']), `the popover has "${D['calendar.pop.moveTo']}" (${names})`);
  ok(names.indexOf(D['calendar.pop.moveTo']) === names.indexOf(D['calendar.pop.duplicate']) + 1, `it comes right after Duplicate (${names})`);
  await pressIn('.ev-pop .ev-foot button', D['calendar.pop.moveTo']);
  await waitFor(`document.querySelector('#mv-to')`, 'the Move dialog');
  let d = await moveDialog();
  ok(d.title === tr('en', 'calendar.move.title', { summary: 'Move me' }), `title (${d.title})`);
  ok(JSON.stringify(d.select) === JSON.stringify(['Work · nam@gmail.com']), `only the writable calendars of the same mailbox (${JSON.stringify(d.select)})`);
  ok(d.buttons.join('|') === `${D['common.cancel']}|${D['calendar.move.confirm']}`, `buttons (${d.buttons})`);
  ok(d.focus === 'mv-to', `the focus starts on the choice (${d.focus})`);
  ok(!d.series.includes(D['calendar.move.seriesNote']), 'no series note for a single event');
  ok(!(await evaluate(`!!document.querySelector('.ev-pop')`)), 'the popover closed when the dialog opened');
  // Esc cancels, the focus goes back to the event, nothing was called
  await esc();
  await sleep(300);
  ok(!(await evaluate(`!!document.querySelector('.modal')`)) && (await moves()).length === 0, 'Esc: no dialog and no call');
  ok(await evaluate(`document.activeElement?.classList.contains('ev-chip') && document.activeElement.textContent.includes('Move me')`), 'Esc: the focus is back on the event');
  // the move
  ok(await openPop('Move me'), 'popover again');
  await evaluate(`window.__mockCalSync.moveDelay = 1500; 1`);
  await pressIn('.ev-pop .ev-foot button', D['calendar.pop.moveTo']);
  await waitFor(`document.querySelector('#mv-to')`, 'the Move dialog again');
  const t0 = await evaluate(`performance.now()`);
  await pressIn('.modal .row-inline .btn', D['calendar.move.confirm']);
  await waitFor(`document.querySelector('.modal .btn[aria-busy="true"]')`, 'the pending Move', 3000);
  const dt = (await evaluate(`performance.now()`)) - t0;
  ok(dt < slow(1000), `Move shows its pending state quickly (${Math.round(dt)} ms incl. the click)`);
  d = await moveDialog();
  ok(d.busy && (await evaluate(`document.querySelector('#mv-to').disabled`)), 'the choice is off while it waits');
  await waitFor(`!document.querySelector('.modal')`, 'the move to end', 6000);
  const mv = await moves();
  ok(mv.length === 1 && mv[0].id === 'mv1' && mv[0].to === 'google:a2:work', `one call for the chosen calendar (${JSON.stringify(mv)})`);
  ok((await toast()).includes(tr('en', 'calendar.toast.moved', { calendar: 'Work · nam@gmail.com' })), `the toast names the calendar (${await toast()})`);
  ok((await store(`s.calEvents.find((e) => e.id === 'mv1')?.calendarId`)) === 'google:a2:work', 'the event is in the target calendar');
  await evaluate(`window.__mockCalSync.moveDelay = 0; 1`);

  // ------------------------------------------------------------------ guests and series
  await closeAll();
  ok(await openPop('Outlook guest'), 'popover (Outlook, guests)');
  await pressIn('.ev-pop .ev-foot button', D['calendar.pop.moveTo']);
  await waitFor(`document.querySelector('.modal .notice')`, 'the guests sentence');
  d = await moveDialog();
  ok(d.select === null && d.notice === tr('en', 'calendar.move.guests', { service: 'Outlook' }), `Outlook with guests: the sentence, no choice (${d.notice})`);
  ok(d.buttons.join('|') === D['common.cancel'], `only Cancel (${d.buttons})`);
  await closeAll();
  ok(await openPop('Google guest'), 'popover (Google, guests)');
  await pressIn('.ev-pop .ev-foot button', D['calendar.pop.moveTo']);
  await waitFor(`document.querySelector('#mv-to')`, 'the choice');
  ok((await moveDialog()).notice === null, 'Google moves an event with guests');
  await closeAll();
  ok(await openPop('Local guest'), 'popover (My events, guests)');
  await pressIn('.ev-pop .ev-foot button', D['calendar.pop.moveTo']);
  await waitFor(`document.querySelector('.modal .notice')`, 'the guests sentence for My events');
  d = await moveDialog();
  ok(d.notice?.startsWith('An event with guests can’t be moved'), `My events with guests: the sentence (${d.notice})`);
  await closeAll();
  ok(await openPop('Local plain'), 'popover (My events)');
  await pressIn('.ev-pop .ev-foot button', D['calendar.pop.moveTo']);
  await waitFor(`document.querySelector('#mv-to')`, 'the choice for My events');
  d = await moveDialog();
  ok(d.select.length === 4 && d.select.every((x) => x.includes('·')), `My events: every writable synced calendar (${JSON.stringify(d.select)})`);
  await closeAll();
  ok(await openPop('Weekly G'), 'popover (series)');
  await pressIn('.ev-pop .ev-foot button', D['calendar.pop.moveTo']);
  await waitFor(`document.querySelector('#mv-to')`, 'the choice for the series');
  ok((await moveDialog()).series.includes(D['calendar.move.seriesNote']), 'a series says it moves whole');
  await closeAll();
  ok(await openPop('Holiday'), 'popover (read-only calendar)');
  ok(!(await popButtons()).includes(D['calendar.pop.moveTo']), 'a read-only calendar: no Move');
  await closeAll();

  // ------------------------------------------------------------------ keyboard only
  ok(await openPop('Local plain'), 'popover (keyboard)');
  await evaluate(`[...document.querySelectorAll('.ev-pop .ev-foot button')].find((b) => (b.getAttribute('aria-label') || b.textContent).trim() === ${JSON.stringify(D['calendar.pop.moveTo'])}).focus(); 1`);
  await key(' ', 'Space', 32, 0, ' ');
  await waitFor(`document.querySelector('#mv-to')`, 'the dialog from the keyboard');
  await key('ArrowDown', 'ArrowDown', 40);
  await tab();
  ok(await evaluate(`document.activeElement?.textContent.trim() === ${JSON.stringify(D['common.cancel'])}`), 'Tab goes from the choice to Cancel');
  await tab();
  ok(await evaluate(`document.activeElement?.textContent.trim() === ${JSON.stringify(D['calendar.move.confirm'])}`), 'then to Move');
  await enter();
  await waitFor(`!document.querySelector('.modal')`, 'Enter on Move');
  const mv2 = (await moves()).at(-1);
  ok(mv2.id === 'mv3' && mv2.to === 'google:a2:work', `ArrowDown chose the second calendar (${JSON.stringify(mv2)})`);

  // ------------------------------------------------------------------ AC-7.5.5: colour
  await openApp(hash());
  await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  await waitFor(`window.__store.getState().calendars.some((c) => c.id === 'google:a2:work')`, 'the calendars');
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a2', focus: 'calendar' }); 1`);
  await waitFor(`document.querySelector('.dot-btn')`, 'the calendars in Settings');
  await sleep(300);
  const dotOf = (name) => `.settings .set-row:has(.switch input[aria-label="${tr('en', 'settings.calendar.syncCal', { name })}"]) .dot-btn`;
  const bg = (name) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(dotOf(name) + ' .dot')})).backgroundColor`);
  const before = await bg('Work');
  await click(dotOf('Work'));
  await waitFor(`document.querySelector('.cal-colors')`, 'the colour choice');
  ok(await evaluate(`document.querySelector(${JSON.stringify(dotOf('Work'))}).getAttribute('aria-expanded') === 'true' && document.querySelector(${JSON.stringify(dotOf('Work'))}).getAttribute('aria-label') === ${JSON.stringify(tr('en', 'settings.calendar.colorOf', { name: 'Work' }))}`), 'the dot is a button named "Color of Work", expanded');
  const first = await evaluate(`document.querySelector('.cal-colors button[role=radio]').textContent`);
  ok(first === tr('en', 'settings.calendar.colorDefault', { service: 'Google Calendar' }) && (await evaluate(`document.querySelector('.cal-colors button[role=radio]').getAttribute('aria-checked')`)) === 'true', `"Color from Google Calendar" comes first and is chosen (${first})`);
  await click('.cal-colors button.swatch:nth-of-type(3)');
  await waitFor(`(window.__mockColors || []).length === 1`, 'the colour call');
  const colorCall = (await evaluate('JSON.stringify(window.__mockColors)').then(JSON.parse))[0];
  ok(colorCall.calendarId === 'google:a2:work' && /^#[0-9a-f]{6}$/i.test(colorCall.color), `one call with a colour (${JSON.stringify(colorCall)})`);
  await waitFor(`getComputedStyle(document.querySelector(${JSON.stringify(dotOf('Work') + ' .dot')})).backgroundColor !== ${JSON.stringify(before)}`, 'the dot to change');
  const hex = colorCall.color.toLowerCase();
  ok((await store(`s.calendars.find((c) => c.id === 'google:a2:work')?.color`)) === hex, 'the sidebar list has the colour');
  ok((await evaluate(`document.querySelector('.cal-colors button.swatch.on')?.getAttribute('aria-label')?.toLowerCase()`)) === hex, 'the chosen swatch is marked');
  await click('.cal-colors button[role=radio]');
  await waitFor(`(window.__mockColors || []).length === 2`, 'the second colour call');
  const back = (await evaluate('JSON.stringify(window.__mockColors)').then(JSON.parse))[1];
  ok(back.color === null, 'the service colour is asked for with none');
  await waitFor(`getComputedStyle(document.querySelector(${JSON.stringify(dotOf('Work') + ' .dot')})).backgroundColor === ${JSON.stringify(before)}`, 'the service colour back');
  ok((await store(`s.calendars.find((c) => c.id === 'google:a2:work')?.color`)) !== hex, 'the list has the service colour again');

  // ------------------------------------------------------------------ AC-7.5.6: a new calendar
  ok(!(await evaluate(`[...document.querySelectorAll('.settings button')].some((b) => b.textContent.trim() === ${JSON.stringify(D['settings.calendar.newCalendar'])})`)), 'Google: no New calendar while its permission is not part of the consent');
  await openApp(hash());
  await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  await waitFor(`window.__store.getState().calendars.some((c) => c.id === 'ms:a4:primary')`, 'the calendars');
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a4', focus: 'calendar' }); 1`);
  await waitFor(`[...document.querySelectorAll('.settings button')].some((b) => b.textContent.trim() === ${JSON.stringify(D['settings.calendar.newCalendar'])})`, 'the New calendar button');
  await sleep(300);
  await pressIn('.settings button', D['settings.calendar.newCalendar']);
  await waitFor(`document.querySelector('#newcal-name')`, 'the New calendar dialog');
  ok((await moveDialog()).title === tr('en', 'settings.calendar.newCalendarTitle', { service: 'Outlook' }), 'the title names the service');
  ok(await evaluate(`document.activeElement?.id === 'newcal-name' && [...document.querySelectorAll('.modal .row-inline .btn.primary')].every((b) => b.disabled)`), 'the name has the focus and Create waits for a name');
  await typeText('Hobbies [needsaccess]');
  await pressIn('.modal .row-inline .btn', D['settings.calendar.create']);
  await waitFor(`document.querySelector('.modal .field-err')`, 'the refusal');
  d = await moveDialog();
  ok(d.err === tr('en', 'calendar.err.needsAccess', { service: 'Outlook' }), `the refusal says what to do (${d.err})`);
  ok(await evaluate(`document.querySelector('#newcal-name').value === 'Hobbies [needsaccess]'`), 'the dialog stays open with the typed name');
  // fix51: a refused or failed create says the calendar could not be CREATED (not "save", not "<new name> is read only"), with the reason
  for (const [name, key, params] of [['Hobbies [fail]', 'calendar.err.createFailed', { service: 'Outlook', reason: 'the server refused it' }], ['Hobbies [denied]', 'calendar.err.createDenied', { service: 'Outlook' }]]) {
    await evaluate(`(() => { const i = document.querySelector('#newcal-name'); i.focus(); i.select(); return 1; })()`);
    await typeText(name);
    await pressIn('.modal .row-inline .btn', D['settings.calendar.create']);
    await waitFor(`document.querySelector('.modal .field-err')`, `the refusal of ${name}`);
    d = await moveDialog();
    ok(d.err === tr('en', key, params) && !/save|read only/i.test(d.err), `${name}: the refusal says the calendar could not be created (${d.err})`);
  }
  await evaluate(`(() => { const i = document.querySelector('#newcal-name'); i.focus(); i.select(); return 1; })()`);
  await typeText('Hobbies');
  await click('.cal-colors button.swatch:nth-of-type(2)');
  await pressIn('.modal .row-inline .btn', D['settings.calendar.create']);
  await waitFor(`!document.querySelector('#newcal-name')`, 'the dialog to close', 6000);
  const made = (await evaluate('JSON.stringify(window.__mockCreates)').then(JSON.parse)).at(-1);
  ok(made.name === 'Hobbies' && made.accountId === 'a4' && /^#[0-9a-f]{6}$/i.test(made.color), `one call with the name and a colour (${JSON.stringify(made)})`);
  ok((await toast()).includes(tr('en', 'settings.calendar.created', { name: 'Hobbies' })), `the toast (${await toast()})`);
  await waitFor(`[...document.querySelectorAll('.settings .set-lbl')].some((e) => e.textContent.includes('Hobbies'))`, 'the new calendar in the list');
  ok(await evaluate(`window.__store.getState().calendars.some((c) => c.name.startsWith('Hobbies'))`), 'and in the sidebar list');
  ok(await evaluate(`document.activeElement?.textContent.trim() === ${JSON.stringify(D['settings.calendar.newCalendar'])}`), 'the focus is back on New calendar');
  // Esc closes this dialog only
  await pressIn('.settings button', D['settings.calendar.newCalendar']);
  await waitFor(`document.querySelector('#newcal-name')`, 'the dialog again');
  await esc();
  await sleep(250);
  ok(!(await evaluate(`!!document.querySelector('#newcal-name')`)) && (await evaluate(`!!document.querySelector('.settings')`)), 'Esc closes the dialog and Settings stays');

  // ------------------------------------------------------------------ AC-7.5.7: the dialogs fit, 8 languages, Light and Dark, 960 x 560
  await openApp(hash(), 960, 560);
  await shown();
  for (const theme of ['light', 'dark']) for (const lang of LANGS) {
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
    await waitFor(`document.documentElement.lang === ${JSON.stringify(lang)}`, `the page language ${lang}`, 25000);
    await closeAll();
    for (const [text, kind] of [['Move me', 'list'], ['Outlook guest', 'guests'], ['Weekly G', 'series']]) {
      const where = `${lang}/${theme}/${kind}`;
      if (!(await openPop(text))) continue;
      const label = tr(lang, 'calendar.pop.moveTo');
      const pop = await evaluate(`(() => { const p = document.querySelector('.ev-pop'); const r = p.getBoundingClientRect(); const bs = [...p.querySelectorAll('.ev-foot button')].map((b) => { const q = b.getBoundingClientRect(); return { n: (b.getAttribute('aria-label') || b.textContent).trim(), l: q.left, r: q.right, t: q.top, b: q.bottom, clipped: b.scrollWidth - b.clientWidth > 1 }; }); return { box: { l: r.left, t: r.top, r: r.right, b: r.bottom }, bs, vw: innerWidth, vh: innerHeight }; })()`);
      const mvb = pop.bs.find((x) => x.n === label);
      ok(!!mvb && !mvb.clipped && mvb.l >= pop.box.l - 0.5 && mvb.r <= pop.box.r + 0.5 && mvb.b <= pop.box.b + 0.5, `${where}: the popover button "${label}" is whole and inside the popover`);
      ok(pop.box.l >= -0.5 && pop.box.r <= pop.vw + 0.5 && pop.box.t >= -0.5 && pop.box.b <= pop.vh + 0.5, `${where}: the popover is inside the window`);
      await pressIn('.ev-pop .ev-foot button', label);
      await waitFor(`document.querySelector('.modal')`, `${where}: the dialog`);
      await sleep(250);
      d = await moveDialog();
      ok(d.title === tr(lang, 'calendar.move.title', { summary: text }), `${where}: title (${d.title})`);
      ok(d.box.l >= 0 && d.box.r <= d.vw && d.box.t >= 0 && d.box.b <= d.vh && d.overflowX <= 1, `${where}: inside the window without sideways scroll (${JSON.stringify(d.box)} overflow ${d.overflowX})`);
      if (kind === 'guests') {
        ok(d.notice === tr(lang, 'calendar.move.guests', { service: 'Outlook' }), `${where}: the guests sentence`);
      } else {
        ok(d.buttons.join('|') === `${tr(lang, 'common.cancel')}|${tr(lang, 'calendar.move.confirm')}` && Math.abs(d.rects[0].t - d.rects[1].t) < 2, `${where}: Cancel and Move on one row`);
        if (kind === 'series') ok(d.series.includes(tr(lang, 'calendar.move.seriesNote')), `${where}: the series note`);
      }
      if (lang === LANGS[0] && kind === 'list') await shot(`move-${theme}`);
      await closeAll();
    }
  }
  // the New calendar dialog and the colour row
  for (const theme of ['light', 'dark']) for (const lang of LANGS) {
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a4', focus: 'calendar' }); 1`);
    await waitFor(`document.documentElement.lang === ${JSON.stringify(lang)}`, `the page language ${lang}`, 25000);
    await waitFor(`document.querySelector('.dot-btn')`, 'Settings > Calendar');
    await sleep(250);
    const where = `${lang}/${theme}`;
    await click('.dot-btn');
    await waitFor(`document.querySelector('.cal-colors')`, `${where}: the colour choice`);
    const row = await evaluate(`(() => { const c = document.querySelector('.cal-colors').getBoundingClientRect(), s = document.querySelector('.settings-body, .modal-body').getBoundingClientRect(); const first = document.querySelector('.cal-colors button[role=radio]'); return { r: c.right, sr: s.right, fw: first.scrollWidth - first.clientWidth, lbl: first.textContent }; })()`);
    ok(row.r <= row.sr + 1 && row.fw <= 1 && row.lbl === tr(lang, 'settings.calendar.colorDefault', { service: 'Outlook' }), `${where}: the colour row is inside Settings and its first choice is whole (${JSON.stringify(row)})`);
    await pressIn('.settings button', tr(lang, 'settings.calendar.newCalendar'));
    await waitFor(`document.querySelector('#newcal-name')`, `${where}: the New calendar dialog`);
    await sleep(200);
    d = await moveDialog();
    ok(d.title === tr(lang, 'settings.calendar.newCalendarTitle', { service: 'Outlook' }), `${where}: title (${d.title})`);
    ok(d.box.l >= 0 && d.box.r <= d.vw && d.box.t >= 0 && d.box.b <= d.vh && d.overflowX <= 1, `${where}: the New calendar dialog is inside the window (${JSON.stringify(d.box)})`);
    ok(d.buttons.join('|') === `${tr(lang, 'common.cancel')}|${tr(lang, 'settings.calendar.create')}`, `${where}: buttons (${d.buttons})`);
    for (const [name, key, params] of [['Hobbies [fail]', 'calendar.err.createFailed', { service: 'Outlook', reason: 'the server refused it' }], ['Hobbies [denied]', 'calendar.err.createDenied', { service: 'Outlook' }]]) {
      await evaluate(`(() => { const i = document.querySelector('#newcal-name'); i.focus(); i.select(); return 1; })()`);
      await typeText(name);
      await pressIn('.modal .row-inline .btn', tr(lang, 'settings.calendar.create'));
      await waitFor(`document.querySelector('.modal .field-err')`, `${where}: the refusal of ${name}`);
      await sleep(100);
      d = await moveDialog();
      ok(d.err === tr(lang, key, params), `${where}: ${name}: the create failure is the translated sentence (${d.err})`);
      ok(d.box.l >= 0 && d.box.r <= d.vw && d.box.t >= 0 && d.box.b <= d.vh && d.overflowX <= 1, `${where}: ${name}: the dialog with the failure sentence is inside the window (${JSON.stringify(d.box)})`);
    }
    if (lang === LANGS[0]) await shot(`newcal-${theme}`);
    await esc();
    await sleep(200);
    await esc();
    await sleep(250);
  }
} catch (e) {
  failures.push(`threw: ${e?.stack || e}`);
  console.error(e);
} finally {
  await H.shutdown();
}
console.log(`${checks} checks, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('test-calendar-move-ui: ok');
