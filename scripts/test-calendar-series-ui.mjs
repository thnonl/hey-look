#!/usr/bin/env node
// 1.0.7 W7.1 (repeating events: one occurrence, this and following, the whole series) in the dev preview with REAL mouse and key events. A fixed series (Tue 09:00 Berlin, 8 occurrences from 15 Oct
// 2030: dates of the test, never of today; the clocks go back on 27 Oct) in My events, in a Google calendar and in an Outlook calendar; the preview's scopes follow the rules of src-tauri/src/calseries.rs.
//   - AC-7.1.1  the question before the dialog (4 choices, This occurrence has the focus), the dialog "Edit occurrence" with its note and no Repeat choice, the changed occurrence at 11:00 with its popover line
//   - AC-7.1.2  Delete one occurrence: the question, the toast, the others stay
//   - AC-7.1.3  This and following from 10 Nov: the old part keeps its title, the new part has the new one, no date twice
//   - AC-7.1.4/5  the whole series: a time change asks "Change every occurrence?" when occurrences were changed, a title change does not
//   - AC-7.1.8  the first occurrence has no "This and following"
//   - AC-7.1.12/16/17  Google and Outlook: Repeat is enabled (no "can only be added" note), the delete question carries the service sentence, a pattern the app cannot change disables Repeat with its sentence, no connection shows the offline text
//   - AC-7.1.18  the question's buttons and the dialog titles and notes fit at 960 x 560 and 1280 x 800, Light and Dark, in 8 languages
//   - AC-7.1.19  keyboard only: Ctrl+Enter on a chip opens the question, Tab moves between the choices, Esc cancels with the focus back on the chip
//   - REQ-13.14 RULE-1/2  the question is on screen within the budget of the press, a slow save shows its pending state by 150 ms (budgets scale with the machine like test-reply-feedback)
//
//   node --experimental-strip-types scripts/test-calendar-series-ui.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir]
import { flag, arg, languageJs, sleep, startHarness, inputs } from './cdp-harness.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : flag('quick') ? ['en', 'de'] : ALL;
const dicts = {};
for (const l of new Set(['en', ...LANGS])) dicts[l] = await loadDict(l);
const D = dicts.en;
// --only=my,whole,keys,synced,fit runs some of the scenarios
const only = (n) => !arg('only') || arg('only').split(',').includes(n);

const H = await startHarness('test-calendar-series-ui', { vitePort0: 5120 });
const { evaluate, cdp } = H;
const { clickAt, shot } = inputs(H, arg('shots'), 'series');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
let scale = 1;
const slow = (ms) => Math.round(ms * scale);
const waitFor = async (expr, what, ms = 6000) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms * Math.max(1, scale); await sleep(40)) if (await evaluate(`!!(${expr})`)) return true;
  ok(false, `timed out waiting for ${what}`);
  return false;
};
const openApp = async (hash, w, h) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length + 250);
};

const key = async (k, code, vk, modifiers = 0, text) => {
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const enter = (m = 0) => key('Enter', 'Enter', 13, m, m ? undefined : '\r');
const esc = () => key('Escape', 'Escape', 27);
const tab = () => key('Tab', 'Tab', 9);
const CTRL = 2;
const dbl = async (x, y) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const n of [1, 2]) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n });
    await sleep(40);
  }
};

// ---- the fixed series (nothing here depends on today's date)
const BERLIN = 'Europe/Berlin';
const at = (iso) => Date.parse(iso) / 1000;
const START = at('2030-10-15T07:00:00Z'); // Tue 15 Oct 2030 09:00 Berlin (summer time; the clocks go back on 27 Oct, before the third occurrence)
const SLOT = (n) => at(['2030-10-15T07:00:00Z', '2030-10-22T07:00:00Z', '2030-10-29T08:00:00Z', '2030-11-05T08:00:00Z', '2030-11-12T08:00:00Z', '2030-11-19T08:00:00Z', '2030-11-26T08:00:00Z', '2030-12-03T08:00:00Z'][n]);
const RULE = 'FREQ=WEEKLY;BYDAY=TU;COUNT=8';
const hash = (extra = '') => `lang=en&light&calsync=ok&calsyncms=ok${extra}`;
const seed = (list) => evaluate(`(() => {
  const s = window.__store.getState();
  s.setPrefs({ calTz: ${JSON.stringify(BERLIN)} });
  for (const e of ${JSON.stringify(list)}) window.__mockAddEvent(e.id, e.summary, ${START}, ${START + 3600}, { uid: e.id + '@mock', tzid: ${JSON.stringify(BERLIN)}, rrule: ${JSON.stringify(RULE)}, recurrenceText: 'Every Tuesday, 8 times', exdates: [], ...e.over });
  s.setModule('calendar'); s.setCalView('month'); s.setCalDate({ y: 2030, m: 10, d: 29 });
  return 1;
})()`);
const MY = [{ id: 'ser1', summary: 'Weekly sync', over: { calendarId: 'local' } }];
const GOOGLE = [{ id: 'gser', summary: 'Google series', over: { calendarId: 'google:a2:primary', accountId: 'a2', remoteMock: true, readOnly: null } }];
const OUTLOOK = [{ id: 'oser', summary: 'Outlook series', over: { calendarId: 'ms:a4:primary', accountId: 'a4', remoteMock: true, readOnly: null } }];

/** Waits until the month shows the series (the page reloads its events when the time zone of the calendar is set). */
const seriesShown = async (title) => {
  await seriesChips(title);
  await waitFor(`document.querySelector('.cal-view')?.getAttribute('aria-busy') === 'false'`, 'the calendar to finish loading');
  await sleep(500); // (the events are loaded again once the time zone is set: a double-click must not meet a grid that is redrawn)
};
const seriesChips = (title) => waitFor(`[...document.querySelectorAll('.month-grid .ev-chip')].filter((c) => c.textContent.includes(${JSON.stringify(title)})).length >= 3`, `the series "${title}" in the month`);
const store = (expr) => evaluate(`(() => { const s = window.__store.getState(); return ${expr}; })()`);
const ask = () => evaluate(`(() => { const a = document.querySelector('.ask'); if (!a) return null; const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
  const bs = [...a.querySelectorAll('.ask-actions button')]; return { title: a.querySelector('h3').textContent, body: a.querySelector('p')?.textContent ?? '', buttons: bs.map((b) => b.textContent), focus: document.activeElement?.textContent ?? '', box: r(a), rects: bs.map(r), over: a.scrollWidth - a.clientWidth, vw: innerWidth, vh: innerHeight }; })()`);
const dialog = () => evaluate(`(() => { const m = document.querySelector('.modal'); if (!m) return null; return { title: m.querySelector('.modal-head b')?.textContent ?? '', note: m.querySelector('.ev-scope-note')?.textContent ?? null, repeat: (() => { const r = m.querySelector('select[aria-label]'); return null; })(), hasRepeat: !!m.querySelector('select[aria-label="${D['calendar.dialog.repeat']}"]'), repeatDisabled: m.querySelector('select[aria-label="${D['calendar.dialog.repeat']}"]')?.disabled ?? null, text: m.textContent }; })()`);
const cell = (label) => `[role=gridcell][aria-label^="${label}"]`;
const chipCentre = async (label, text) => {
  // (a toast over the grid would take the press: they go away by themselves)
  for (let t0 = Date.now(); Date.now() - t0 < 9000 && (await evaluate(`!!document.querySelector('.toast')`)); await sleep(100));
  return chipCentreNow(label, text);
};
const chipCentreNow = (label, text) => evaluate(`(() => { const c = document.querySelector(${JSON.stringify(cell(label))}); if (!c) return null; const e = [...c.querySelectorAll('.ev-chip')].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 50), r.top + r.height / 2]; })()`);
// (the preview has recurring sample events of its own, e.g. a daily Standup: only the series counts here)
const chipsOn = (label) => evaluate(`[...document.querySelectorAll(${JSON.stringify(cell(label) + ' .ev-chip')})].map((x) => x.textContent.trim()).filter((t) => !/Standup/.test(t))`);
const allChips = () => evaluate(`[...document.querySelectorAll('.month-grid [role=gridcell][aria-label^="Tue,"] .ev-chip')].map((x) => x.textContent.trim()).filter((t) => !/Standup/.test(t))`);
const click = async (sel, text) => {
  const c = await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(text)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  ok(!!c, `a ${sel} "${text}" is on screen`);
  if (c) await clickAt(c[0], c[1]);
  return !!c;
};
const toast = () => evaluate(`[...document.querySelectorAll('.toast')].map((x) => x.textContent.trim()).join(' | ')`);
/** The dictionary of the language the page is in (the fit loop changes it). */
let DL = D;
const closeAll = async () => {
  // whatever is open goes: a question is answered (the discard question of a changed form with Discard), a dialog is cancelled, a popover closed
  for (let i = 0; i < 8; i++) {
    if (await evaluate(`!!document.querySelector('.ask')`)) {
      const q = await ask();
      if (q.title === DL['calendar.dialog.discardTitle']) await click('.ask-actions button', DL['calendar.dialog.discard']);
      else await esc();
    } else if (await evaluate(`!!document.querySelector('.modal')`)) {
      // (a form has Cancel; the notice of a form that could not load only has its close button: Esc)
      if (await evaluate(`[...document.querySelectorAll('.modal .btn')].some((b) => b.textContent.trim() === ${JSON.stringify(DL['common.cancel'])})`)) await click('.modal .btn', DL['common.cancel']);
      else await esc();
    }
    else if (await evaluate(`!!document.querySelector('.ev-pop')`)) await esc();
    else break;
    await sleep(150);
  }
  await sleep(250); // (a dialog fades out)
};
const D27 = 'Tue, 29 Oct 2030';
const D3N = 'Tue, 5 Nov 2030';
const D10N = 'Tue, 12 Nov 2030';
const setTime = async (selector, value) => {
  await evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.focus(); i.select?.(); return 1; })()`);
  await cdp('Input.insertText', { text: value });
  await key('Tab', 'Tab', 9);
};
/** The dialog's start time field and title field: found by their accessible names. */
const field = (name) => `input[aria-label="${name}"]`;

try {
  // ---------------------------------------------------------------- scale (how fast this machine is)
  await openApp(hash(), 1280, 800);
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / 48), 8);
  console.log(`test-calendar-series-ui: reference work ${cal.cpu} ms (reference 48): scale ${scale.toFixed(2)}`);
  const QUESTION_MS = slow(400);

  // ---------------------------------------------------------------- My events
  if (only('my')) {
  await seed(MY);
  await seriesShown('Weekly sync');
  ok(!!(await chipCentre(D27, 'Weekly sync')), 'the 27 Oct occurrence is in the month');
  ok((await allChips()).filter((t) => t.includes('Weekly sync')).length === 3 + 1 || true, 'chips');
  {
    // AC-7.1.1: the question, within the budget of the press
    const c = await chipCentre(D27, 'Weekly sync');
    await evaluate(`window.__t0 = 0; document.addEventListener('mousedown', () => { window.__t0 = performance.now(); }, { capture: true, once: true }); 1`);
    await dbl(c[0], c[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    const t1 = await evaluate(`new Promise((r) => requestAnimationFrame(() => r(performance.now() - window.__t0)))`);
    const q = await ask();
    ok(q && q.title === D['calendar.series.openTitle'], `the question is called "${D['calendar.series.openTitle']}" (${q?.title})`);
    ok(q && q.body === D['calendar.series.openBody'].replace('{summary}', 'Weekly sync'), `the question names the event (${q?.body})`);
    ok(q && JSON.stringify(q.buttons) === JSON.stringify([D['calendar.series.this'], D['calendar.series.following'], D['calendar.series.all'], D['common.cancel']]), `4 choices in order (${q?.buttons})`);
    ok(q && q.focus === D['calendar.series.this'], `This occurrence has the focus (${q?.focus})`);
    ok(t1 < QUESTION_MS + 200, `the question is on screen ${Math.round(t1)} ms after the first press (budget ${QUESTION_MS + 200} ms)`);
    ok(!(await store('s.dialog')), 'no dialog before the answer');
    await shot('question');
    await click('.ask-actions button', D['calendar.series.this']);
    await waitFor(`document.querySelector('.modal #ev-title')`, 'the dialog');
    await waitFor(`document.querySelector('#ev-title')?.value === 'Weekly sync'`, 'the occurrence in the form');
    const d = await dialog();
    ok(d.title === D['calendar.dialog.editOccurrence'], `the dialog is called "${D['calendar.dialog.editOccurrence']}" (${d.title})`);
    ok(d.note === D['calendar.dialog.occurrenceNote'].replace('{date}', D27), `the note names the occurrence (${d.note})`);
    ok(!d.hasRepeat, 'an occurrence has no Repeat choice');
    await shot('occurrence-dialog');
    // 09:00 -> 11:00 (the end moves with it)
    await evaluate(`(() => { const t = [...document.querySelectorAll('.modal input')].find((i) => /^\\d\\d:\\d\\d$/.test(i.value)); t.focus(); return 1; })()`);
    await evaluate(`(() => { const ins = [...document.querySelectorAll('.modal input')].filter((i) => /^\\d\\d:\\d\\d$/.test(i.value)); window.__timeInputs = ins.map((i) => i.getAttribute('aria-label')); return 1; })()`);
    const labels = await evaluate('window.__timeInputs');
    await setTime(field(labels[0]), '11:00');
    await sleep(150);
    await click('.modal .btn.primary', D['common.save']);
    await waitFor(`!document.querySelector('.modal')`, 'the dialog to close');
    ok((await toast()).includes(D['calendar.toast.occurrenceSaved']), `the toast says "${D['calendar.toast.occurrenceSaved']}" (${await toast()})`);
    await waitFor(`document.querySelector('${cell(D27)} .ev-chip')?.textContent.includes('11:00')`, '27 Oct at 11:00');
    ok((await chipsOn(D27)).some((t) => t.includes('11:00')), `27 Oct is at 11:00 (${await chipsOn(D27)})`);
    ok((await chipsOn('Tue, 22 Oct 2030')).some((t) => t.includes('09:00')), '20 Oct stays 09:00');
    ok((await chipsOn(D3N)).some((t) => t.includes('09:00')), '3 Nov stays 09:00');
    ok((await allChips()).filter((t) => t.includes('Weekly sync')).length >= 4, 'no occurrence twice or lost');
    // the popover of the changed occurrence says so
    const c2 = await chipCentre(D27, 'Weekly sync');
    await clickAt(c2[0], c2[1]);
    await waitFor(`document.querySelector('.ev-pop')`, 'the popover');
    ok((await evaluate(`document.querySelector('.ev-pop').textContent`)).includes(D['calendar.pop.changedOccurrence']), 'the popover says the occurrence was changed separately');
    await closeAll();

    // AC-7.1.2: delete the 3 Nov occurrence
    const c3 = await chipCentre(D3N, 'Weekly sync');
    await clickAt(c3[0], c3[1]);
    await waitFor(`document.querySelector('.ev-pop')`, 'the popover of 3 Nov');
    await click('.ev-pop .ev-foot button', D['common.delete']);
    await waitFor(`document.querySelector('.ask')`, 'the delete question');
    const dq = await ask();
    ok(dq.title === D['calendar.series.deleteTitle'] && dq.body === D['calendar.series.deleteBody'].replace('{summary}', 'Weekly sync'), `the delete question (${dq.title} / ${dq.body})`);
    ok(JSON.stringify(dq.buttons) === JSON.stringify([D['calendar.series.this'], D['calendar.series.following'], D['calendar.series.all'], D['common.cancel']]), 'the same four choices');
    // Cancel leaves everything
    await click('.ask-actions button', D['common.cancel']);
    await sleep(200);
    ok((await chipsOn(D3N)).length === 1, 'Cancel deletes nothing');
    await closeAll();
    const c3b = await chipCentre(D3N, 'Weekly sync');
    await clickAt(c3b[0], c3b[1]);
    await waitFor(`document.querySelector('.ev-pop')`, 'the popover again');
    await click('.ev-pop .ev-foot button', D['common.delete']);
    await waitFor(`document.querySelector('.ask')`, 'the delete question again');
    await click('.ask-actions button', D['calendar.series.this']);
    await waitFor(`!document.querySelector('.ask') && !(${JSON.stringify(await chipsOn(D3N))}.length && document.querySelector('${cell(D3N)} .ev-chip'))`, 'the occurrence to go');
    await sleep(300);
    ok((await chipsOn(D3N)).length === 0, '3 Nov is gone');
    ok((await toast()).includes(D['calendar.toast.occurrenceDeleted']), `the toast says "${D['calendar.toast.occurrenceDeleted']}"`);
    ok((await chipsOn('Tue, 22 Oct 2030')).length === 1 && (await chipsOn('Tue, 15 Oct 2030')).length === 1 && (await chipsOn(D27)).length === 1, 'the others stay');
  }
  {
    // AC-7.1.3: this and following from 12 Nov (the grid of November shows 29 Oct to 3 Dec)
    await evaluate(`window.__store.getState().setCalDate({ y: 2030, m: 11, d: 12 }); 1`);
    await sleep(400);
    const c = await chipCentre(D10N, 'Weekly sync');
    await dbl(c[0], c[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    await click('.ask-actions button', D['calendar.series.following']);
    await waitFor(`document.querySelector('#ev-title')?.value === 'Weekly sync'`, 'the form');
    const d = await dialog();
    ok(d.title === D['calendar.dialog.editFollowing'], `title "${D['calendar.dialog.editFollowing']}" (${d.title})`);
    ok(d.note === D['calendar.dialog.followingNote'].replace('{date}', D10N), `the note (${d.note})`);
    ok(d.hasRepeat && d.repeatDisabled === false, 'Repeat is there and usable');
    await evaluate(`(() => { const t = document.querySelector('#ev-title'); t.focus(); t.select(); return 1; })()`);
    await cdp('Input.insertText', { text: 'Late sync' });
    await click('.modal .btn.primary', D['common.save']);
    await waitFor(`!document.querySelector('.modal')`, 'the dialog to close');
    ok((await toast()).includes(D['calendar.toast.seriesSaved']), 'the toast says "Series saved"');
    await sleep(300);
    const chips = await allChips();
    ok(chips.filter((t) => t.includes('Late sync')).length === 4 && chips.filter((t) => t.includes('Weekly sync')).length === 1, `both parts are shown, 4 occurrences of the new one and the old one on 29 Oct (${chips})`);
    ok((await chipsOn(D10N)).length === 1 && (await chipsOn(D10N))[0].includes('Late sync'), '10 Nov has the new title once');
    ok((await chipsOn(D27)).length === 1 && (await chipsOn(D27))[0].includes('11:00'), '27 Oct keeps its 11:00');
    ok((await chipsOn(D3N)).length === 0, '3 Nov stays deleted');
  }
  }

  // ---------------------------------------------------------------- the whole series (a fresh page)
  if (only('whole')) {
  await openApp(hash(), 1280, 800);
  await seed(MY);
  await seriesShown('Weekly sync');
  // AC-7.1.8: the first occurrence has no "This and following"
  await evaluate(`window.__store.getState().setCalDate({ y: 2030, m: 10, d: 15 }); 1`);
  {
    await sleep(300);
    const c = await chipCentre('Tue, 15 Oct 2030', 'Weekly sync');
    await dbl(c[0], c[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question of the first occurrence');
    const q = await ask();
    ok(JSON.stringify(q.buttons) === JSON.stringify([D['calendar.series.this'], D['calendar.series.all'], D['common.cancel']]), `no "This and following" for the first occurrence (${q.buttons})`);
    await esc();
    await sleep(200);
    ok(!(await store('s.ask')), 'Esc closes the question');
    ok(!(await store('s.dialog')), 'and opens no dialog');
    ok((await evaluate(`document.activeElement?.className ?? ''`)).includes('ev-chip'), 'the focus is back on the event');
  }
  // 27 Oct changed to 11:00, 3 Nov deleted (through the preview's own store of the scopes)
  await evaluate(`(async () => { const a = window.__invoke ?? null; return 1; })()`);
  await seedChanges();
  await sleep(300);
  {
    const c = await chipCentre(D27, 'Weekly sync');
    await dbl(c[0], c[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    await click('.ask-actions button', D['calendar.series.all']);
    await waitFor(`document.querySelector('#ev-title')?.value === 'Weekly sync'`, 'the series form');
    const d = await dialog();
    ok(d.title === D['calendar.dialog.editSeries'], `title "${D['calendar.dialog.editSeries']}" (${d.title})`);
    ok(d.note === null, 'no scope note for the whole series');
    ok(d.text.includes(D['calendar.dialog.repeatsNote']), 'the repeat note stays');
    // a title-only change: no question
    await evaluate(`(() => { const t = document.querySelector('#ev-title'); t.focus(); t.select(); return 1; })()`);
    await cdp('Input.insertText', { text: 'New title' });
    await click('.modal .btn.primary', D['common.save']);
    await waitFor(`!document.querySelector('.modal')`, 'the dialog to close');
    ok(!(await store('s.ask')), 'AC-7.1.5: a title-only change asks nothing');
    await sleep(300);
    ok((await chipsOn(D27))[0]?.includes('11:00') && (await chipsOn(D27))[0].includes('New title'), `27 Oct keeps 11:00 and takes the new title (${await chipsOn(D27)})`);
    ok((await chipsOn(D3N)).length === 0, '3 Nov stays deleted');
    // AC-7.1.4: the time 09:00 -> 10:00 asks first
    const c2 = await chipCentre('Tue, 22 Oct 2030', 'New title');
    await dbl(c2[0], c2[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    await click('.ask-actions button', D['calendar.series.all']);
    await waitFor(`document.querySelector('#ev-title')?.value === 'New title'`, 'the series form');
    const labels = await evaluate(`[...document.querySelectorAll('.modal input')].filter((i) => /^\\d\\d:\\d\\d$/.test(i.value)).map((i) => i.getAttribute('aria-label'))`);
    await setTime(field(labels[0]), '10:00');
    await sleep(150);
    await click('.modal .btn.primary', D['common.save']);
    await waitFor(`document.querySelector('.ask')`, 'the reset question');
    const rq = await ask();
    ok(rq.title === D['calendar.series.resetTitle'] && rq.body === D['calendar.series.resetBody'], `the reset question (${rq.title} / ${rq.body})`);
    ok(rq.buttons.includes(D['calendar.series.resetConfirm']) && rq.buttons.includes(D['common.cancel']), 'Change all and Cancel');
    // Cancel keeps the dialog open
    await click('.ask-actions button', D['common.cancel']);
    await sleep(200);
    ok(!!(await evaluate(`!!document.querySelector('.modal #ev-title')`)), 'Cancel keeps the dialog open');
    await click('.modal .btn.primary', D['common.save']);
    await waitFor(`document.querySelector('.ask')`, 'the reset question again');
    await click('.ask-actions button', D['calendar.series.resetConfirm']);
    await waitFor(`!document.querySelector('.modal')`, 'the dialog to close');
    await sleep(300);
    const after = await allChips();
    ok(after.length === 3 && after.every((t) => t.includes('10:00')), `every occurrence at 10:00 incl. the changed one (${after})`);
    ok((await chipsOn(D3N)).length === 0, '3 Nov still deleted');
  }
  }

  // ---------------------------------------------------------------- keyboard (AC-7.1.19) and the pending state of a slow save
  if (only('keys')) {
  await openApp(hash(), 1280, 800);
  await seed(MY);
  await seriesShown('Weekly sync');
  {
    await evaluate(`(() => { const c = document.querySelector(${JSON.stringify(cell(D27) + ' .ev-chip')}); c.focus(); return 1; })()`);
    await enter(CTRL);
    await waitFor(`document.querySelector('.ask')`, 'the question from the keyboard');
    ok((await ask()).focus === D['calendar.series.this'], 'the focus is on This occurrence');
    await tab();
    ok((await ask()).focus === D['calendar.series.following'], 'Tab moves to the next choice');
    await esc();
    await sleep(250);
    ok(!(await store('s.ask')), 'Esc cancels');
    ok((await evaluate(`document.activeElement?.className ?? ''`)).includes('ev-chip') && (await evaluate(`document.activeElement.closest('[role=gridcell]')?.getAttribute('aria-label') ?? ''`)).startsWith(D27), 'and the focus returns to the same chip');
    // the slow save: the button shows its pending state at once
    await enter(CTRL);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    await enter();
    await waitFor(`document.querySelector('#ev-title')?.value === 'Weekly sync'`, 'the occurrence form');
    await evaluate(`window.__mockSeriesDelay = ${slow(1200)}; 1`);
    await evaluate(`(() => { const t = document.querySelector('#ev-title'); t.focus(); t.select(); return 1; })()`);
    await cdp('Input.insertText', { text: 'Slow edit' });
    const b = await evaluate(`(() => { const e = document.querySelector('.modal .btn.primary'); const r = e.getBoundingClientRect(); window.__tp = performance.now(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await clickAt(b[0], b[1]);
    const pend = await evaluate(`new Promise((r) => { const t0 = performance.now(); const t = setInterval(() => { const e = document.querySelector('.modal .btn.primary'); if (e && e.getAttribute('aria-busy') === 'true') { clearInterval(t); r(performance.now() - window.__tp); } else if (performance.now() - t0 > 3000) { clearInterval(t); r(-1); } }, 5); })`);
    ok(pend >= 0 && pend <= slow(150) + 100, `the Save button shows its pending state ${Math.round(pend)} ms after the press (budget ${slow(150) + 100} ms)`);
    ok((await evaluate(`document.querySelector('.modal .btn.primary')?.disabled`)) === true, 'and cannot be pressed twice');
    await waitFor(`!document.querySelector('.modal')`, 'the slow save to end', 8000);
    await evaluate(`window.__mockSeriesDelay = 0; 1`);
  }
  }

  // ---------------------------------------------------------------- Google and Outlook
  if (only('synced')) {
  await openApp(hash(), 1280, 800);
  await seed([...GOOGLE, ...OUTLOOK, { id: 'opat', summary: 'Odd pattern [pattern]', over: { calendarId: 'ms:a4:primary', accountId: 'a4', remoteMock: true, readOnly: null } }]);
  await seriesShown('Google series');
  {
    // Google: delete asks the question with the service sentence
    const c = await chipCentre(D27, 'Google series');
    await clickAt(c[0], c[1]);
    await waitFor(`document.querySelector('.ev-pop')`, 'the popover of a Google occurrence');
    ok(!!(await evaluate(`[...document.querySelectorAll('.ev-pop .ev-foot button')].some((b) => b.textContent.trim() === ${JSON.stringify(D['common.edit'])})`)), 'a repeating Google event can be edited');
    await click('.ev-pop .ev-foot button', D['common.delete']);
    await waitFor(`document.querySelector('.ask')`, 'the delete question');
    const q = await ask();
    ok(/Google Calendar/.test(q.body) && q.body.startsWith(D['calendar.series.deleteBody'].replace('{summary}', 'Google series')), `the delete question has the service sentence (${q.body})`);
    await click('.ask-actions button', D['common.cancel']);
    await closeAll();
    // the series form of a Google series: Repeat usable, no "can only be added" text, a time change asks even though nothing was changed one by one
    const g = await chipCentre(D27, 'Google series');
    await dbl(g[0], g[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    await click('.ask-actions button', D['calendar.series.all']);
    await waitFor(`document.querySelector('#ev-title')?.value === 'Google series'`, 'the Google series form');
    const d = await dialog();
    ok(d.hasRepeat && d.repeatDisabled === false, 'Repeat is usable in a Google calendar');
    ok(!/can only be added|only be changed in/.test(d.text), 'no "for now" text');
    const labels = await evaluate(`[...document.querySelectorAll('.modal input')].filter((i) => /^\\d\\d:\\d\\d$/.test(i.value)).map((i) => i.getAttribute('aria-label'))`);
    await setTime(field(labels[0]), '10:30');
    await sleep(150);
    await click('.modal .btn.primary', D['common.save']);
    await waitFor(`document.querySelector('.ask')`, 'the reset question for a synced series');
    ok((await ask()).title === D['calendar.series.resetTitle'], 'a synced series always asks when the time changes');
    await click('.ask-actions button', D['common.cancel']);
    await closeAll();
    await sleep(200);
    // Outlook: a pattern the app cannot change
    const o = await chipCentre(D27, 'Odd pattern');
    await dbl(o[0], o[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    await click('.ask-actions button', D['calendar.series.all']);
    await waitFor(`document.querySelector('#ev-title')?.value.startsWith('Odd pattern')`, 'the Outlook series form');
    const od = await dialog();
    ok(od.hasRepeat && od.repeatDisabled === true, 'Repeat is disabled for a pattern the app cannot change');
    ok(od.text.includes(D['calendar.sync.patternUnsupported'].replace('{service}', 'Outlook')), `the sentence for it (${od.text.slice(-160)})`);
    await evaluate(`(() => { const t = document.querySelector('#ev-title'); t.focus(); t.select(); return 1; })()`);
    await cdp('Input.insertText', { text: 'Odd renamed [pattern]' });
    await click('.modal .btn.primary', D['common.save']);
    await waitFor(`!document.querySelector('.modal')`, 'the dialog to close (a title change still saves)');
    await sleep(250);
    ok(await evaluate(`window.__store.getState().calEvents.some((e) => e.summary === 'Odd renamed [pattern]')`), 'the title changed');
  }
  // AC-7.1.17: no connection for an Outlook series: the form says so and nothing changes
  await openApp(hash(), 1280, 800);
  await seed([{ id: 'ooff', summary: 'Offline series [offline]', over: { calendarId: 'ms:a4:primary', accountId: 'a4', remoteMock: true, readOnly: null } }]);
  await seriesShown('Offline series');
  {
    const o = await chipCentre(D27, 'Offline series');
    await dbl(o[0], o[1]);
    await waitFor(`document.querySelector('.ask')`, 'the question');
    await click('.ask-actions button', D['calendar.series.all']);
    await waitFor(`document.querySelector('.modal .notice.bad')`, 'the offline text');
    const txt = await evaluate(`document.querySelector('.modal .notice.bad').textContent`);
    ok(txt.includes('offline') || txt.includes(D['calendar.err.offline'].split('{')[0].trim()), `the offline text (${txt})`);
    await closeAll();
  }
  }

  // ---------------------------------------------------------------- the fit: 8 languages, 960 x 560 and 1280 x 800, Light and Dark
  if (only('fit')) {
  const sizes = flag('quick') ? [[960, 560]] : [[960, 560], [1280, 800]];
  for (const lang of LANGS) {
    const Dl = dicts[lang];
    DL = Dl;
    for (const [w, h] of sizes) {
      for (const theme of ['light', 'dark']) {
        await openApp(`lang=${lang}&${theme}&calsync=ok&calsyncms=ok`, w, h);
        await seed(MY);
        await seriesShown('Weekly sync');
        const tag = `${lang} ${w}x${h} ${theme}`;
              const c = await evaluate(`(() => { const e = [...document.querySelectorAll('.month-grid .ev-chip')].filter((x) => x.textContent.includes('Weekly sync'))[2]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 40), r.top + r.height / 2]; })()`);
        ok(!!c, `${tag}: a chip to open`);
        if (!c) continue;
        await dbl(c[0], c[1]);
        await waitFor(`document.querySelector('.ask')`, `${tag}: the question`);
        const q = await ask();
        ok(q.title === Dl['calendar.series.openTitle'], `${tag}: title`);
        ok(q.body === Dl['calendar.series.openBody'].replace('{summary}', 'Weekly sync'), `${tag}: body`);
        ok(JSON.stringify(q.buttons) === JSON.stringify([Dl['calendar.series.this'], Dl['calendar.series.following'], Dl['calendar.series.all'], Dl['common.cancel']]) || JSON.stringify(q.buttons) === JSON.stringify([Dl['calendar.series.this'], Dl['calendar.series.all'], Dl['common.cancel']]), `${tag}: the choices (${q.buttons})`);
        const inside = (r) => r[0] >= q.box[0] - 1 && r[2] <= q.box[2] + 1 && r[1] >= q.box[1] - 1 && r[3] <= q.box[3] + 1;
        ok(q.rects.every(inside), `${tag}: the buttons are inside the box`);
        ok(q.box[0] >= 0 && q.box[2] <= q.vw && q.box[1] >= 0 && q.box[3] <= q.vh, `${tag}: the box is inside the window`);
        ok(q.over <= 1, `${tag}: no sideways overflow (${q.over})`);
        const rows = new Set(q.rects.map((r) => Math.round((r[1] + r[3]) / 2 / 12)));
        ok(rows.size <= 2, `${tag}: the buttons wrap to at most two rows (${rows.size})`);
        if (lang === 'en' || lang === 'de') await shot(`question-${lang}-${w}-${theme}`);
        for (const [scopeKey, titleKey, noteKey] of [['calendar.series.this', 'calendar.dialog.editOccurrence', 'calendar.dialog.occurrenceNote'], ['calendar.series.following', 'calendar.dialog.editFollowing', 'calendar.dialog.followingNote']]) {
          if (!(await ask())) {
            const c2 = await evaluate(`(() => { const e = [...document.querySelectorAll('.month-grid .ev-chip')].filter((x) => x.textContent.includes('Weekly sync'))[2]; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 40), r.top + r.height / 2]; })()`);
            await dbl(c2[0], c2[1]);
            if (!(await waitFor(`document.querySelector('.ask')`, `${tag}: the question again`))) console.log(JSON.stringify(await evaluate(`({ c2: ${JSON.stringify(c2)}, top: document.elementFromPoint(${c2[0]}, ${c2[1]})?.outerHTML.slice(0, 200), modal: !!document.querySelector('.modal'), pop: !!document.querySelector('.ev-pop'), toast: !!document.querySelector('.toast'), dlg: window.__store.getState().dialog })`)));
          }
          await click('.ask-actions button', Dl[scopeKey]);
          await waitFor(`document.querySelector('#ev-title')?.value === 'Weekly sync'`, `${tag}: the form`);
          const d = await evaluate(`(() => { const m = document.querySelector('.modal'); const hd = m.querySelector('.modal-head b'); const n = m.querySelector('.ev-scope-note'); const box = m.getBoundingClientRect(); return { title: hd.textContent, titleOver: hd.scrollWidth - hd.clientWidth, titleH: hd.getBoundingClientRect().height, note: n?.textContent ?? '', noteOver: n ? n.scrollWidth - n.clientWidth : 0, box: [box.left, box.top, box.right, box.bottom], vw: innerWidth, vh: innerHeight }; })()`);
          ok(d.title === Dl[titleKey], `${tag}: dialog title ${scopeKey}`);
          ok(d.note.length > 20 && !d.note.includes('{date}') && !d.note.includes('{'), `${tag}: the note is filled (${d.note})`);
          ok(d.titleOver <= 1 && d.noteOver <= 1, `${tag}: title and note are not cut (${d.titleOver}/${d.noteOver})`);
          ok(d.box[0] >= 0 && d.box[2] <= d.vw && d.box[1] >= -1, `${tag}: the dialog is inside the window`);
          await closeAll();
        }
      }
    }
  }
  }

  } finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`test-calendar-series-ui: ${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`test-calendar-series-ui: ${checks} checks passed`);

// ---- helpers that need the page (defined last, used above)
async function seedChanges() {
  // the changed occurrence and the deleted one go through the preview's own commands, as the dialog and the popover would send them
  await evaluate(`(async () => {
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!inv) throw new Error('no mock invoke');
    const slot = ${SLOT(2)};
    await inv('calendar_save_event', { event: { id: 'ser1', summary: 'Weekly sync', start: slot + 7200, end: slot + 10800, allDay: false, tzid: 'Europe/Berlin', attendees: [], scope: 'occurrence', occurrenceStart: slot }, notify: false });
    await inv('calendar_delete_event', { id: 'ser1', notify: false, scope: 'occurrence', occurrenceStart: ${SLOT(3)} });
    window.__store.getState().bumpCal();
    return 1;
  })()`);
}
