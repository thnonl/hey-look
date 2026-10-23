#!/usr/bin/env node
// 1.0.7 W7.10 (owner report: "double-click on an event does not open the edit form"), in the dev preview with REAL mouse and key events (Input.dispatchMouseEvent with
// clickCount 1 then 2; Ctrl+Enter / Cmd+Enter as key events with modifiers):
//   - a double-click on an event opens its edit dialog in the month view (chip), the week view (timed block and all-day chip) and the agenda (row); the popover that the
//     first click opened is gone, no "New event" dialog appears;
//   - an event that cannot be edited (an invitation, an event of a read-only calendar, an event only its organizer may change) shows its details popover instead:
//     no dialog, no error, no toast;
//   - a double-click on empty space still makes a new event: a month day at 09:00, a week column at the time clicked (14:30);
//   - the keyboard: Enter on an event = popover, Esc closes it with the focus back on the event, Ctrl+Enter (Cmd+Enter as a Mac key) = the double-click; Esc from
//     the dialog puts the focus back on the event; on an invitation it shows the popover;
//   - Settings > Shortcuts has the row, in all 8 languages.
//
//   node --experimental-strip-types scripts/test-calendar-dblclick.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir]
import { flag, arg, languageJs, sleep, startHarness, inputs } from './cdp-harness.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : flag('quick') ? ['en', 'de'] : ALL;
const dicts = {};
for (const l of new Set(['en', ...LANGS])) dicts[l] = await loadDict(l);

const H = await startHarness('test-calendar-dblclick', { vitePort0: 5172 });
const { evaluate, cdp } = H;
const { clickAt, shot } = inputs(H, arg('shots'), 'dblclick');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
const waitFor = async (expr, what, ms = 6000) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (await evaluate(`!!(${expr})`)) return true;
  ok(false, `timed out waiting for ${what}`);
  return false;
};
// (the dev preview applies the tokens of the hash (lang=, light, ...) in order, 250 ms apart, after the store has loaded: a language or theme set in that gap is
// overwritten when its token comes, so the test waits for the last one)
const openApp = async (hash, w, h) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length + 250);
};

/** Two presses of the left button at the same place with clickCount 1 and 2, as the browser sends a double-click. */
const dbl = async (x, y) => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const n of [1, 2]) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n });
    await sleep(40);
  }
};
const key = async (k, code, vk, modifiers = 0, text) => {
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const enter = (modifiers = 0) => key('Enter', 'Enter', 13, modifiers, modifiers ? undefined : '\r');
const esc = () => key('Escape', 'Escape', 27);
const CTRL = 2, META = 4;

const store = (expr) => evaluate(`(() => { const s = window.__store.getState(); return ${expr}; })()`);
const dialog = () => store('s.dialog ? { type: s.dialog.type, eventId: s.dialog.eventId ?? null, start: s.dialog.init?.start ?? null } : null');
const centre = (sel, text) => evaluate(`(() => {
  const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => (x.getAttribute('title') || x.getAttribute('aria-label') || x.textContent).includes(${JSON.stringify(text)}));
  if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = e.getBoundingClientRect();
  return [r.left + Math.min(r.width / 2, 60), r.top + r.height / 2];
})()`);
const popover = () => evaluate(`(() => { const p = document.querySelector('.ev-pop'); return p ? { text: p.textContent, buttons: [...p.querySelectorAll('.ev-foot button')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim()) } : null; })()`);
const openDay = (offset, view) => evaluate(`(() => { const s = window.__store.getState(); const d = new Date(); d.setDate(d.getDate() + ${offset}); s.setCalView(${JSON.stringify(view)}); s.setCalDate({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }); return 1; })()`);
const closeAll = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await evaluate(`!!document.querySelector('.ev-pop, .modal')`))) break;
    await esc();
    await sleep(150);
  }
};
const focusedTitle = () => evaluate(`document.activeElement?.getAttribute('title') ?? document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className ?? ''`);

/** Double-click the element and expect the edit dialog of `id`: no popover left, no new-event dialog. */
async function expectEdit(sel, text, id, tag) {
  const c = await centre(sel, text);
  ok(!!c, `${tag}: "${text}" is on screen (${sel})`);
  if (!c) return;
  await dbl(c[0], c[1]);
  ok(await waitFor(`window.__store.getState().dialog?.type === 'event'`, `${tag}: the dialog`), `${tag}: no dialog`);
  const d = await dialog();
  ok(d && d.type === 'event' && d.eventId === id, `${tag}: the edit dialog of ${id}, not a new event (${JSON.stringify(d)})`);
  await waitFor(`document.querySelector('#ev-title')?.value === ${JSON.stringify(text)}`, `${tag}: the title in the form`);
  ok((await evaluate(`document.querySelector('.modal-head b')?.textContent`)) === dicts.en['calendar.dialog.editTitle'], `${tag}: the dialog is called Edit event`);
  ok(!(await evaluate(`!!document.querySelector('.ev-pop')`)), `${tag}: no popover is left`);
  await esc();
  await waitFor(`!document.querySelector('.modal')`, `${tag}: the dialog to close`);
  await sleep(200);
}

/** Double-click the element and expect the details popover of the event and no dialog. */
async function expectDetails(sel, text, tag, buttons) {
  const c = await centre(sel, text);
  ok(!!c, `${tag}: "${text}" is on screen (${sel})`);
  if (!c) return;
  await dbl(c[0], c[1]);
  await waitFor(`document.querySelector('.ev-pop')`, `${tag}: the popover`);
  await sleep(250);
  const d = await dialog();
  const p = await popover();
  ok(!d, `${tag}: no dialog (${JSON.stringify(d)})`);
  ok(p && p.text.includes(text), `${tag}: the popover shows the event`);
  if (buttons) ok(buttons.every((b) => p && p.buttons.includes(b)), `${tag}: the popover has ${buttons} (it has ${p?.buttons})`);
  ok(!(await evaluate(`!!document.querySelector('.toast, [role=alert] .toast')`)), `${tag}: no toast`);
  await closeAll();
}

try {
  await openApp('lang=en&light&calsync=ok', 1280, 800);
  await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  await waitFor(`document.querySelector('.cal-view')`, 'the calendar');
  // an all-day event of My events today and a Google event that only its organizer may change
  await evaluate(`(() => { const d = new Date(); window.__mockAddEvent('ad1', 'Offsite day', Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 1000, Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 1) / 1000, { allDay: true, tzid: null }); return 1; })()`);
  await sleep(500);

  // ---------------------------------------------------------------- month
  await openDay(0, 'month');
  await waitFor(`document.querySelectorAll('.ev-chip').length > 3`, 'chips in the month');
  await expectEdit('.ev-chip', 'Q4 contract call', 'e3', 'month, My events');
  await expectDetails('.ev-chip', 'Design review', 'month, invitation', ['Accept', 'Tentative', 'Decline']);
  // ---------------------------------------------------------------- week
  await openDay(1, 'week');
  await waitFor(`document.querySelector('.wk-ev')`, 'blocks in the week');
  await expectEdit('.wk-ev', 'Coffee with Minh', 'g1', 'week, Google primary');
  await openDay(0, 'week');
  await waitFor(`document.querySelector('.wk-allday .ev-chip')`, 'the all-day chip');
  await expectEdit('.wk-allday .ev-chip', 'Offsite day', 'ad1', 'week all-day, My events');
  await openDay(2, 'week');
  await expectDetails('.wk-ev', 'Design crit', 'week, Google event only its organizer may change');
  // ---------------------------------------------------------------- agenda
  await openDay(0, 'agenda');
  await waitFor(`document.querySelector('.ag-row')`, 'the agenda rows');
  await expectEdit('.ag-row', 'Lunch with Alice', 'e4', 'agenda, My events');
  await expectDetails('.ag-row', 'Design review', 'agenda, invitation', ['Accept']);
  await expectDetails('.ag-row', 'Reunification Day', 'agenda, read-only calendar');
  // the details of a read-only event name no Edit and no Delete (W7.12)
  await openDay(0, 'agenda');
  const holiday = await centre('.ag-row', 'Reunification Day');
  await clickAt(holiday[0], holiday[1]);
  await waitFor(`document.querySelector('.ev-pop')`, 'the popover of the holiday');
  ok(JSON.stringify((await popover()).buttons) === JSON.stringify(['Duplicate', 'Save .ics']), `read-only popover buttons: ${JSON.stringify((await popover()).buttons)}`);
  await closeAll();
  // ---------------------------------------------------------------- empty space still makes a new event
  await openDay(0, 'month');
  await waitFor(`document.querySelectorAll('.mday').length > 27`, 'the month grid');
  const cell = await evaluate(`(() => { const days = [...document.querySelectorAll('.mday:not(.other)')]; const c = days.find((x) => !x.querySelector('.ev-chip') && x.getBoundingClientRect().bottom < window.innerHeight - 10) ?? days[days.length - 1]; const r = c.getBoundingClientRect(); return { x: r.left + 8, y: r.bottom - 8, num: c.querySelector('.mnum').textContent }; })()`);
  await dbl(cell.x, cell.y);
  await waitFor(`window.__store.getState().dialog?.type === 'event'`, 'the new-event dialog from the month');
  let d = await dialog();
  const nine = await evaluate(`(() => { const t = new Date(); const day = Number(${JSON.stringify(cell.num)}.replace(/\\D/g, '')); return Math.floor(new Date(t.getFullYear(), t.getMonth(), day, 9, 0).getTime() / 1000); })()`);
  ok(d && !d.eventId && d.start === nine, `month empty space: a new event on that day at 09:00 (${JSON.stringify(d)}, wanted ${nine})`);
  ok((await evaluate(`document.querySelector('.modal-head b')?.textContent`)) === dicts.en['calendar.newEvent'], 'month empty space: the dialog is New event');
  await closeAll();
  // the chip inside a cell: no new event on top of the edit
  await openDay(0, 'month');
  const chip = await centre('.ev-chip', 'Q4 contract call');
  await dbl(chip[0], chip[1]);
  await waitFor(`window.__store.getState().dialog?.type === 'event'`, 'the dialog');
  await sleep(300);
  ok((await evaluate(`document.querySelectorAll('.modal').length`)) === 1, 'a double-click on a chip makes one dialog, not two');
  await closeAll();
  // week column at 14:30
  await openDay(4, 'week');
  await waitFor(`document.querySelector('.wk-col')`, 'the week columns');
  const wk = await evaluate(`(() => {
    const scroller = document.querySelector('.week'); const hourPx = parseFloat(getComputedStyle(scroller).getPropertyValue('--hour-px'));
    scroller.scrollTop = Math.max(0, 14 * hourPx - 120);
    const cols = [...document.querySelectorAll('.wk-col')]; const col = cols[Math.min(3, cols.length - 1)]; const r = col.getBoundingClientRect();
    return { x: r.left + 6, y: r.top + 14.5 * hourPx + 3, hourPx, idx: cols.indexOf(col) };
  })()`);
  await sleep(150);
  await dbl(wk.x, wk.y);
  await waitFor(`window.__store.getState().dialog?.type === 'event'`, 'the new-event dialog from the week');
  d = await dialog();
  const minutes = d && d.start !== null ? await evaluate(`(() => { const t = new Date(${d.start} * 1000); return t.getHours() * 60 + t.getMinutes(); })()`) : null;
  ok(d && !d.eventId && minutes === 14 * 60 + 30, `week empty space at 14:30: a new event at 14:30 (${JSON.stringify(d)}, minutes ${minutes})`);
  await closeAll();

  // ---------------------------------------------------------------- the keyboard
  for (const [name, mod] of [['Ctrl+Enter', CTRL], ['Cmd+Enter', META]]) {
    await openDay(0, 'month');
    await waitFor(`document.querySelectorAll('.ev-chip').length > 3`, 'chips');
    const focusChip = (text) => evaluate(`(() => { const e = [...document.querySelectorAll('.ev-chip')].find((x) => x.title.includes(${JSON.stringify(text)})); e.focus(); return document.activeElement === e; })()`);
    ok(await focusChip('Q4 contract call'), `${name}: the chip takes the focus`);
    await enter();
    await waitFor(`document.querySelector('.ev-pop')`, `${name}: Enter opens the popover`);
    ok(!(await dialog()), `${name}: Enter on an event is the popover only`);
    await esc();
    await waitFor(`!document.querySelector('.ev-pop')`, `${name}: Esc closes the popover`);
    await sleep(150);
    ok((await focusedTitle()).includes('Q4 contract call'), `${name}: the focus is back on the event after Esc (${await focusedTitle()})`);
    await enter(mod);
    await waitFor(`window.__store.getState().dialog?.type === 'event'`, `${name}: the dialog`);
    d = await dialog();
    ok(d && d.eventId === 'e3', `${name}: opens the edit dialog of the event (${JSON.stringify(d)})`);
    ok(!(await evaluate(`!!document.querySelector('.ev-pop')`)), `${name}: no popover`);
    await esc();
    await waitFor(`!document.querySelector('.modal')`, `${name}: Esc closes the dialog`);
    await sleep(250);
    ok((await focusedTitle()).includes('Q4 contract call'), `${name}: the focus is back on the event when the dialog closes (${await focusedTitle()})`);
    // an invitation: the details
    ok(await focusChip('Design review'), `${name}: the invitation takes the focus`);
    await enter(mod);
    await waitFor(`document.querySelector('.ev-pop')`, `${name}: on an invitation the popover opens`);
    ok(!(await dialog()), `${name}: no dialog for an invitation`);
    await closeAll();
  }
  // a dialog that closes after the event left the grid (saved with another date): the focus is not lost to the page
  await openDay(0, 'month');
  const sv = await centre('.ev-chip', 'Q4 contract call');
  await dbl(sv[0], sv[1]);
  await waitFor(`window.__store.getState().dialog?.type === 'event'`, 'the dialog to save');
  await evaluate(`window.__store.getState().setDialog(null); document.querySelectorAll('.ev-chip').forEach((c) => c.remove()); 1`);
  await sleep(300);
  ok(!/^BODY$/i.test(await evaluate(`document.activeElement?.tagName ?? ''`)) , 'the focus is not on the page body after the dialog closed and the chip is gone');

  // ---------------------------------------------------------------- Settings > Shortcuts
  for (const lang of LANGS) {
    await evaluate(languageJs(lang));
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'shortcuts' }); 1`);
    const want = dicts[lang]['settings.keys.editEvent'];
    await waitFor(`[...document.querySelectorAll('.set-row')].some((r) => r.textContent.includes(${JSON.stringify(want)}))`, `the Shortcuts row in ${lang}`);
    const row = await evaluate(`(() => { const r = [...document.querySelectorAll('.set-row')].find((x) => x.textContent.includes(${JSON.stringify(want)})); const rr = r.getBoundingClientRect(); const box = r.parentElement.getBoundingClientRect(); return { key: r.querySelector('kbd').textContent, over: r.scrollWidth - r.clientWidth, right: rr.right, boxRight: box.right, prev: r.previousElementSibling?.textContent ?? '' }; })()`);
    ok(row.key === 'Ctrl+Enter', `${lang}: the key reads Ctrl+Enter (${row.key})`);
    ok(row.over <= 1 && row.right <= row.boxRight + 1, `${lang}: the row is not clipped`);
    ok(row.prev.includes(dicts[lang]['settings.keys.calendarKeys']), `${lang}: the row follows the calendar keys row`);
    ok(!/settings\.keys/.test(row.prev + want), `${lang}: no raw key`);
    await evaluate(`window.__store.getState().setDialog(null); 1`);
  }
  await shot('done');
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-calendar-dblclick: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-calendar-dblclick: ${checks} checks passed`);
