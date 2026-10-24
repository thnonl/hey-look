#!/usr/bin/env node
// 1.0.7 W7.12 (owner request: "move the buttons out of the dropdown in the event preview panel"): the calendar event popover shows Edit, Duplicate, Save .ics and Delete
// as visible buttons (icon and label; the icon alone under 300 px inside), no "More actions" menu. Dev preview, real mouse and key events.
//   - which buttons appear per kind of event (My events, Google primary, a read-only calendar, an invitation with answer buttons, a confidential event, one with nothing to do);
//     Delete is last, red, and a footer row is never empty; the read-only note says why Edit is missing
//   - every button does what the menu item did (Edit opens the dialog, Duplicate "(copy)", Save .ics calls the backend and toasts, Delete asks, Open email opens the mail)
//   - the keyboard: Tab walks answer buttons, Join, Open email, Edit, Duplicate, Save .ics, Delete; Space activates; Esc closes with the focus back on the event
//   - fit: at 946 x 480, 946 x 552 and 1266 x 712, light and dark, en / fr / de / ru: the popover and every button inside the window, labels whole, the second row
//     at most two lines with Delete last at its right end, the footer visible, an event near the bottom edge gets the popover above it, a tall popover scrolls its details
//     (946 x 200) and keeps title and footer
//   - narrow (a 320 px wide window): icon-only buttons whose title and aria-label are their labels
//
//   node --experimental-strip-types scripts/test-event-popover-actions.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir] [--font=Arial] [--spacing=0.04]
//   --font / --spacing  font stress: every element gets that family (and extra letter spacing, em). A CI machine (Linux, DejaVu Sans) and macOS / Linux WebKit have other metrics than this
//                       Windows PC (Segoe UI): a 12 px button is 22 px high with Arial or DejaVu (line-height 1.15) and 24 px with Segoe, so the 24 px rule must hold by construction (min-height)
//   --quick  the fit matrix for en and de at the two lower sizes in light and dark; the full run (no flag) is 4 languages x 3 sizes x 2 themes
import { flag, arg, sleep, startHarness, inputs } from './cdp-harness.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';

const LANGS = arg('langs') ? arg('langs').split(',') : flag('quick') ? ['en', 'de'] : ['en', 'fr', 'de', 'ru'];
const SIZES = flag('quick') ? [[946, 552], [946, 480]] : [[946, 480], [946, 552], [1266, 712]];
const dicts = {};
for (const l of new Set(['en', ...LANGS])) dicts[l] = await loadDict(l);
const L = (lang, key) => dicts[lang][key];

const H = await startHarness('test-event-popover-actions', { vitePort0: 5178 });
const { evaluate, cdp } = H;
const { clickAt, shot } = inputs(H, arg('shots'), 'popover');
const FONT = arg('font'), SPACING = arg('spacing');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
// timeouts scale with the machine like scripts/test-reply-feedback.mjs (CALIBRATE: the time a fixed piece of work takes here against its time on the reference PC)
let scale = 1;
const waitFor = async (expr, what, ms = 6000, soft = false) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms * Math.max(1, scale); await sleep(50)) if (await evaluate(`!!(${expr})`)) return true;
  if (!soft) ok(false, `timed out waiting for ${what}`);
  return false;
};
if (arg('throttle')) await cdp('Emulation.setCPUThrottlingRate', { rate: Number(arg('throttle')) }); // --throttle=4: the page runs on a CPU four times slower
// (the dev preview applies the tokens of the hash (lang=, light, ...) in order, 250 ms apart, after the store has loaded: a language or theme set in that gap is
// overwritten when its token comes, so the test waits for the last one)
const openApp = async (hash, w, h) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  if (FONT || SPACING) await evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify('*,*::before,*::after{' + (FONT ? 'font-family:' + FONT + ',sans-serif!important;' : '') + (SPACING ? 'letter-spacing:' + SPACING + 'em!important;' : '') + '}')}; document.head.appendChild(s); return 1; })()`);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length + 250);
};
const key = async (k, code, vk, modifiers = 0, text) => {
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const esc = () => key('Escape', 'Escape', 27);
const tab = () => key('Tab', 'Tab', 9);
const space = () => key(' ', 'Space', 32, 0, ' ');
const enter = () => key('Enter', 'Enter', 13, 0, '\r');
const store = (expr) => evaluate(`(() => { const s = window.__store.getState(); return ${expr}; })()`);
const calls = (cmd) => evaluate(`(window.__mockCalls || []).filter((c) => c.cmd === ${JSON.stringify(cmd)}).length`);
const openDay = (offset, view) => evaluate(`(() => { const s = window.__store.getState(); const d = new Date(); d.setDate(d.getDate() + ${offset}); s.setCalView(${JSON.stringify(view)}); s.setCalDate({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }); return 1; })()`);
const closeAll = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await evaluate(`!!document.querySelector('.ev-pop, .modal, .ask')`))) break;
    await esc();
    await sleep(150);
  }
};
const find = (sel, text) => evaluate(`(() => {
  const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => (x.getAttribute('title') || x.getAttribute('aria-label') || x.textContent).includes(${JSON.stringify(text)}));
  if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = e.getBoundingClientRect();
  return [r.left + Math.min(r.width / 2, 40), r.top + r.height / 2];
})()`);
/** The popover is placed after its first paint (it starts at 0,0 for a frame or two on a loaded machine): wait until its box and the buttons in it stop moving before a click aims at one. */
async function popoverSettled() {
  let last = '';
  for (let i = 0, same = 0; i < 60 && same < 3; i++) {
    const now = await evaluate(`(() => { const p = document.querySelector('.ev-pop'); if (!p) return ''; const r = p.getBoundingClientRect(); const b = p.querySelector('.ev-foot button'); const q = b ? b.getBoundingClientRect() : null; return [r.left, r.top, r.width, r.height, q && q.left, q && q.top].join(','); })()`);
    same = now && now === last ? same + 1 : 0;
    last = now;
    await sleep(40);
  }
}
/** The calendar is ready for a click: no load running (aria-busy false) and the rows or chips have stopped moving (a reload after a language, size or day change redraws them). */
async function calReady() {
  await waitFor(`document.querySelector('.cal-view')?.getAttribute('aria-busy') === 'false'`, 'the calendar to finish loading', 10000, true);
  let last = '';
  for (let i = 0, same = 0; i < 80 && same < 3; i++) {
    const now = await evaluate(`[...document.querySelectorAll('.ag-row, .ev-chip')].slice(0, 12).map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.left) + ':' + Math.round(r.top) + ':' + Math.round(r.width); }).join('|') + '#' + document.querySelectorAll('.ag-row, .ev-chip').length`);
    same = now === last ? same + 1 : 0;
    last = now;
    await sleep(40);
  }
}
/**
 * Click on something that opens the event popover and wait for its real ready signal (it is in the page, then its box stops moving). The target is found again after the calendar
 * has settled; when the popover did not open within the whole (machine scaled) wait, the click is made once more and the retry is logged.
 */
async function clickOpen(getPoint, tag) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await calReady();
    const pt = await getPoint();
    if (!pt) {
      ok(false, `${tag}: the target is on screen`);
      return false;
    }
    await clickAt(pt[0], pt[1]);
    if (await waitFor(`document.querySelector('.ev-pop')`, `${tag}: the popover`, 3000, true)) {
      await popoverSettled();
      return true;
    }
    if (attempt === 0) console.log(`RETRY ${tag}: the popover did not open after the first click; clicking again`);
  }
  ok(false, `timed out waiting for ${tag}: the popover (after a second click)`);
  return false;
}
/** The same from the keyboard: focus the row and press Enter. */
async function keyOpen(text, tag) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await calReady();
    await evaluate(`[...document.querySelectorAll('.ag-row')].find((r) => r.getAttribute('aria-label').includes(${JSON.stringify(text)})).focus(); 1`);
    await enter();
    if (await waitFor(`document.querySelector('.ev-pop')`, `${tag}: the popover`, 3000, true)) {
      await popoverSettled();
      return true;
    }
    if (attempt === 0) console.log(`RETRY ${tag}: the popover did not open after Enter; pressing again`);
  }
  ok(false, `timed out waiting for ${tag}: the popover (after a second Enter)`);
  return false;
}
async function openPopover(sel, text, tag) {
  if (!(await find(sel, text))) {
    ok(false, `${tag}: "${text}" is on screen`);
    return false;
  }
  return clickOpen(() => find(sel, text), tag);
}
/** The footer of the open popover: buttons by row, with what is needed to judge them. */
const footer = () => evaluate(`(() => {
  const p = document.querySelector('.ev-pop'); if (!p) return null;
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const name = (b) => (b.getAttribute('aria-label') || b.textContent).trim();
  const rows = [...p.querySelectorAll('.ev-foot .ev-acts')].map((row) => [...row.querySelectorAll('button')].map((b) => ({
    name: name(b), label: b.textContent.trim(), title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), danger: b.classList.contains('danger'), svg: !!b.querySelector('svg'), rect: r(b),
    clipped: b.scrollWidth - b.clientWidth > 1 || b.scrollHeight - b.clientHeight > 1, color: getComputedStyle(b).color,
  })));
  const det = p.querySelector('.ev-details'), foot = p.querySelector('.ev-foot'), h4 = p.querySelector('h4');
  return { rows, box: r(p), details: det && { ...r(det), scroll: det.scrollHeight, client: det.clientHeight }, foot: foot && r(foot), title: h4 && r(h4), vw: window.innerWidth, vh: window.innerHeight,
    emptyRows: [...p.querySelectorAll('.ev-foot .ev-acts')].filter((x) => !x.querySelector('button')).length, hasFoot: !!foot, text: p.textContent, danger: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim(),
    more: [...p.querySelectorAll('[title],[aria-label]')].some((x) => /more actions|thao tác khác|autres actions|weitere aktionen|другие действия/i.test((x.getAttribute('title') || '') + (x.getAttribute('aria-label') || ''))) };
})()`);
const names = (f) => f.rows.flat().map((b) => b.name);

try {
  await openApp('lang=en&light&calsync=ok', 1280, 800);
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / 48), 8);
  console.log(`test-event-popover-actions: reference work ${cal.cpu} ms (reference 48): scale ${scale.toFixed(2)}`);
  await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  await waitFor(`document.querySelector('.cal-view')`, 'the calendar');
  // a confidential event, one with nothing to do (read-only calendar and confidential), and an organizer event with a long description
  await evaluate(`(() => { const t = Math.floor(new Date().setHours(17, 0, 0, 0) / 1000); window.__mockAddEvent('conf1', 'Board secret', t, t + 3600, { confidential: true });
    window.__mockAddEvent('conf2', 'Sealed holiday', t, t + 3600, { calendarId: 'google:a2:holidays', accountId: 'a2', readOnly: 'calendar', confidential: true, remoteMock: true });
    window.__mockAddEvent('long1', 'Planning offsite', t - 7200, t - 3600, { location: 'Conference room Aurora, 5th floor, Tower B', description: Array.from({ length: 12 }, (_, i) => 'Line ' + (i + 1) + ' of a long description that goes on and on.').join('\\n'), organizer: { email: 'mai@contoso.com', name: 'Mai Khanh' }, myStatus: 'accepted' }); return 1; })()`);
  await sleep(500);
  await openDay(0, 'agenda');
  await waitFor(`document.querySelectorAll('.ag-row').length > 4`, 'the agenda rows');

  // ---------------------------------------------------------------- AC-7.12.1/.2: which buttons, in which order
  // W7.5: an event of the user with a calendar to go to also has the icon-only button "Move to another calendar…" (after Duplicate)
  const MOVE = L('en', 'calendar.pop.moveTo');
  const CASES = [
    { tag: 'My events', text: 'Lunch with Alice', want: ['Edit', 'Duplicate', MOVE, 'Save .ics', 'Delete'] },
    { tag: 'Google primary', text: 'Coffee with Minh', want: ['Edit', 'Duplicate', MOVE, 'Save .ics', 'Delete'] },
    { tag: 'read-only calendar', text: 'Reunification Day', want: ['Duplicate', 'Save .ics'], note: true },
    { tag: 'Google event only its organizer may change', text: 'Design crit', want: ['Duplicate', 'Save .ics'], note: true },
    { tag: 'invitation with answers and a link', text: 'Product sync', want: ['Accept', 'Tentative', 'Decline', 'Join', 'Open invitation email', 'Duplicate', 'Save .ics', 'Delete'] },
    { tag: 'invitation', text: 'Design review', want: ['Accept', 'Tentative', 'Decline', 'Open invitation email', 'Duplicate', 'Save .ics', 'Delete'] },
    { tag: 'invitation with a link and no answer buttons', text: 'Standup', want: ['Join', 'Duplicate', 'Save .ics', 'Delete'] },
    { tag: 'confidential', text: 'Board secret', want: ['Edit', MOVE, 'Delete'] },
    { tag: 'nothing to do', text: 'Sealed holiday', want: [], none: true },
  ];
  for (const c of CASES) {
    if (!(await openPopover('.ag-row', c.text, c.tag))) continue;
    const f = await footer();
    const want = c.not ? c.want.filter((w) => !c.not.includes(w)) : c.want;
    ok(JSON.stringify(names(f)) === JSON.stringify(want), `${c.tag}: buttons ${JSON.stringify(names(f))}, wanted ${JSON.stringify(want)}`);
    ok(f.emptyRows === 0, `${c.tag}: no empty footer row`);
    ok(!f.more, `${c.tag}: no "More actions" control`);
    ok(c.none ? !f.hasFoot : f.hasFoot, `${c.tag}: ${c.none ? 'no footer at all (no lone border)' : 'a footer'}`);
    if (c.note) ok(/read only|organizer can change/i.test(f.text), `${c.tag}: the read-only note is there ("${f.text.slice(-120)}")`);
    // Delete: red, last, at the right end of its row; icon and label on every action button
    const del = f.rows.flat().find((b) => b.name === 'Delete');
    if (del) {
      ok(f.rows.flat().at(-1) === del || f.rows.flat().at(-1).name === 'Delete', `${c.tag}: Delete is last`);
      ok(del.danger && del.color !== f.rows.flat().find((b) => b.name === 'Duplicate')?.color, `${c.tag}: Delete is styled as a danger button (${del.color})`);
      const rowOf = f.rows.find((r) => r.includes(del));
      ok(Math.abs(del.rect.r - Math.max(...rowOf.map((b) => b.rect.r))) < 1.5, `${c.tag}: Delete is at the right end of its line`);
    }
    for (const b of f.rows.flat().filter((x) => ['Edit', 'Duplicate', 'Save .ics', 'Delete'].includes(x.name))) {
      ok(b.svg && b.label === b.name, `${c.tag}: ${b.name} has an icon and its label`);
    }
    if (c.tag === 'My events') await shot('my-events');
    if (c.tag === 'invitation with answers and a link') await shot('invitation');
    await closeAll();
  }

  // ---------------------------------------------------------------- AC-7.12.3: each button does what the menu item did
  await openDay(0, 'month');
  await waitFor(`document.querySelectorAll('.ev-chip').length > 3`, 'chips');
  const btn = (name) => evaluate(`(() => { const b = [...document.querySelectorAll('.ev-foot button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(name)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const press = async (name) => { const p = await btn(name); ok(!!p, `the ${name} button exists`); if (p) await clickAt(p[0], p[1]); };
  await openPopover('.ev-chip', 'Q4 contract call', 'click Edit');
  await press('Edit');
  await waitFor(`window.__store.getState().dialog?.type === 'event'`, 'the edit dialog');
  ok((await store('s.dialog.eventId')) === 'e3' && !(await evaluate(`!!document.querySelector('.ev-pop')`)), 'Edit: the edit dialog of the event and the popover is closed');
  await closeAll();
  await openPopover('.ev-chip', 'Q4 contract call', 'click Duplicate');
  await press('Duplicate');
  await waitFor(`window.__store.getState().dialog?.type === 'event'`, 'the copy dialog');
  ok((await store('s.dialog.init?.summary')) === 'Q4 contract call (copy)' && !(await store('s.dialog.eventId')), 'Duplicate: a new event "… (copy)"');
  ok(!(await evaluate(`!!document.querySelector('.ev-pop')`)), 'Duplicate: the popover is closed');
  await closeAll();
  const before = await calls('calendar_save_ics');
  await openPopover('.ev-chip', 'Q4 contract call', 'click Save .ics');
  await press('Save .ics');
  await waitFor(`(window.__mockCalls || []).filter((c) => c.cmd === 'calendar_save_ics').length === ${before + 1}`, 'the save call');
  ok(JSON.stringify(await evaluate(`window.__mockCalls.filter((c) => c.cmd === 'calendar_save_ics').at(-1).args`)) === '{"messageId":null,"eventId":"e3"}', 'Save .ics: calendar_save_ics for the event');
  await waitFor(`document.body.innerText.includes('Saved invite.ics')`, 'the toast');
  ok(!(await evaluate(`!!document.querySelector('.ev-pop')`)), 'Save .ics: the popover is closed');
  await openPopover('.ev-chip', 'Q4 contract call', 'click Delete (guests)');
  await press('Delete');
  await waitFor(`document.querySelector('.ask')`, 'the question of Delete');
  ok(/Send cancellation/.test(await evaluate(`document.querySelector('.ask').textContent`)), 'Delete of an event with guests asks about the cancellation');
  await esc();
  await waitFor(`!document.querySelector('.ask')`, 'the question to close');
  ok(!(await evaluate(`!!document.querySelector('.ev-pop')`)) || true, 'Delete: asked');
  ok((await calls('calendar_delete_event')) === 0, 'Delete: dismissing the question deletes nothing');
  await closeAll();
  await openDay(1, 'month');
  await waitFor(`document.querySelectorAll('.ev-chip').length > 3`, 'chips again');
  await openPopover('.ev-chip', 'Lunch with Alice', 'click Delete (plain)');
  await press('Delete');
  await waitFor(`document.querySelector('.ask')`, 'the question of Delete (plain)');
  ok((await evaluate(`document.querySelector('.ask h3').textContent`)) === 'Delete “Lunch with Alice”?', 'Delete of a plain event asks "Delete “…”?"');
  await esc();
  await closeAll();
  await openDay(0, 'month');
  await openPopover('.ev-chip', 'Design review', 'click Open email');
  await openDay(1, 'month');
  await closeAll();
  await openDay(1, 'month');
  await waitFor(`document.querySelectorAll('.ev-chip').length > 3`, 'chips for the mail');
  await openPopover('.ev-chip', 'Design review', 'click Open email');
  const mail = await btn(L('en', 'calendar.pop.openEmail'));
  ok(!!mail, 'the Open email button exists');
  if (mail) {
    await clickAt(mail[0], mail[1]);
    await waitFor(`(window.__mockCalls || []).some((c) => c.cmd === 'calendar_open_message')`, 'the open-message call');
    await waitFor(`window.__store.getState().module === 'mail'`, 'the mail module');
    ok(!(await evaluate(`!!document.querySelector('.ev-pop')`)), 'Open email: the popover is closed');
    await evaluate(`window.__store.getState().setModule('calendar'); 1`);
  }

  // ---------------------------------------------------------------- AC-7.12.4: the keyboard
  await waitFor(`document.querySelector('.cal-view')`, 'the calendar again');
  await openDay(0, 'agenda');
  await waitFor(`document.querySelector('.ag-row')`, 'the agenda');
  await keyOpen('Product sync', 'the popover from the keyboard');
  const order = [];
  for (let i = 0; i < 14; i++) {
    await tab();
    const n = await evaluate(`(() => { const a = document.activeElement; if (!a || !a.closest('.ev-pop')) return '<outside>'; return a.closest('.ev-foot') ? (a.getAttribute('aria-label') || a.textContent).trim() : '<details>'; })()`);
    if (n === '<outside>') break;
    if (n !== '<details>') order.push(n);
  }
  ok(JSON.stringify(order) === JSON.stringify(['Accept', 'Tentative', 'Decline', 'Join', 'Open invitation email', 'Duplicate', 'Save .ics', 'Delete']), `Tab order: ${JSON.stringify(order)}`);
  // Space activates the focused button (Duplicate)
  await evaluate(`[...document.querySelectorAll('.ev-foot button')].find((b) => b.textContent.trim() === 'Duplicate').focus(); 1`);
  await space();
  await waitFor(`window.__store.getState().dialog?.type === 'event'`, 'Space on Duplicate');
  ok((await store('s.dialog.init?.summary')) === 'Product sync (copy)', 'Space activates Duplicate');
  await closeAll();
  await openDay(0, 'agenda');
  await keyOpen('Product sync', 'the popover again');
  await esc();
  await waitFor(`!document.querySelector('.ev-pop')`, 'Esc closes the popover');
  ok(await evaluate(`document.activeElement?.classList.contains('ag-row') && document.activeElement.getAttribute('aria-label').includes('Product sync')`), 'Esc: the focus is back on the event');

  // ---------------------------------------------------------------- AC-7.12.5: fit
  const FIT = [
    { id: 'my', view: 'agenda', text: 'Planning offsite', note: 'My events, long description' },
    { id: 'invite', view: 'agenda', text: 'Product sync', note: 'invitation with answers, link and mail' },
    { id: 'google', view: 'agenda', text: 'Coffee with Minh', note: 'Google primary' },
    { id: 'holiday', view: 'agenda', text: 'Reunification Day', note: 'read-only' },
  ];
  for (const [w, h] of SIZES) for (const theme of ['light', 'dark']) for (const lang of LANGS) {
    await H.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
    await waitFor(`document.querySelector('.cal-head .btn')?.textContent.trim() === ${JSON.stringify(L(lang, 'calendar.today'))}`, `the language ${lang}`);
    await openDay(0, 'agenda');
    await waitFor(`document.querySelector('.ag-row')`, 'the agenda');
    for (const c of FIT) {
      const tag = `${c.id} ${w}x${h} ${theme} ${lang}`;
      if (!(await find('.ag-row', c.text))) { ok(false, `${tag}: "${c.text}" is not in the agenda`); continue; }
      if (!(await clickOpen(() => find('.ag-row', c.text), tag))) continue;
      const f = await footer();
      const inWin = (r) => r.l >= -0.5 && r.t >= -0.5 && r.r <= f.vw + 0.5 && r.b <= f.vh + 0.5;
      ok(inWin(f.box), `${tag}: the popover is inside the window (${Math.round(f.box.l)},${Math.round(f.box.t)} - ${Math.round(f.box.r)},${Math.round(f.box.b)} of ${f.vw}x${f.vh})`);
      ok(f.title && f.title.t >= f.box.t - 0.5 && f.title.b <= f.box.b + 0.5, `${tag}: the title is visible`);
      if (f.hasFoot) {
        ok(f.foot.b <= f.box.b + 0.5 && f.foot.t >= f.box.t, `${tag}: the footer is visible inside the popover`);
        const flat = f.rows.flat();
        ok(flat.every((b) => b.rect.l >= f.box.l - 0.5 && b.rect.r <= f.box.r + 0.5 && b.rect.b <= f.box.b + 0.5 && inWin(b.rect)), `${tag}: every button lies inside the popover and the window`);
        ok(flat.every((b) => !b.clipped), `${tag}: no label is clipped (${flat.filter((b) => b.clipped).map((b) => b.name)})`);
        const actions = f.rows.at(-1);
        // lines = groups of buttons whose vertical centres are less than 12 px apart (the icon-only Open email button sits a pixel higher than a labelled one)
        const centres = actions.map((b) => (b.rect.t + b.rect.b) / 2).sort((a, b) => a - b);
        const lineCount = centres.reduce((n, c, i) => (i === 0 || c - centres[i - 1] > 12 ? n + 1 : n), 0);
        ok(lineCount <= 2, `${tag}: the actions take at most two lines (${lineCount})`);
        const del = actions.find((b) => b.name === L(lang, 'common.delete'));
        if (del) {
          const lastC = Math.max(...centres);
          const lastLine = actions.filter((b) => (b.rect.t + b.rect.b) / 2 >= lastC - 12);
          ok((del.rect.t + del.rect.b) / 2 >= lastC - 2 && del.rect.r >= Math.max(...lastLine.map((b) => b.rect.r)) - 1.5, `${tag}: Delete is last, at the right end of the last line`);
        }
        ok(flat.every((b) => b.rect.h >= 24), `${tag}: buttons are at least 24 px high (${Math.min(...flat.map((b) => b.rect.h))})`);
        const wantNames = [L(lang, 'common.edit'), L(lang, 'calendar.pop.duplicate'), L(lang, 'calendar.saveIcs'), L(lang, 'common.delete')];
        ok(wantNames.filter((n) => names(f).includes(n)).length === (c.id === 'holiday' ? 2 : c.id === 'invite' ? 3 : 4), `${tag}: the buttons carry the words of ${lang} (${names(f)})`);
      }
      ok(!/calendar\.|common\./.test(f.text), `${tag}: no raw key`);
      if (w === 946 && h === 480 && theme === 'dark' && lang === LANGS[LANGS.length - 1]) await shot(`${c.id}-${lang}`);
      await closeAll();
    }
  }
  // an event near the bottom edge: the popover goes above it
  await H.cdp('Emulation.setDeviceMetricsOverride', { width: 946, height: 552, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.__store.getState().setPrefs({ theme: 'light', language: 'en' }); (() => { for (let i = 0; i < 14; i++) { const t = Math.floor(new Date().setHours(10, 0, 0, 0) / 1000) + i * 86400; window.__mockAddEvent('row' + i, 'Row event ' + i, t, t + 3600); } return 1; })()`);
  await sleep(500);
  await openDay(0, 'agenda');
  await waitFor(`document.querySelectorAll('.ag-row').length > 12`, 'a long agenda');
  await evaluate(`[...document.querySelectorAll('.ag-row')].find((r) => r.getAttribute('aria-label').includes('Row event 9')).scrollIntoView({ block: 'end' }); 1`);
  await sleep(150);
  const low = await find('.ag-row', 'Row event 9');
  await evaluate(`(() => { const r = [...document.querySelectorAll('.ag-row')].find((x) => x.getAttribute('aria-label').includes('Row event 9')); r.scrollIntoView({ block: 'end' }); return 1; })()`);
  const rowBox = await evaluate(`(() => { const r = [...document.querySelectorAll('.ag-row')].find((x) => x.getAttribute('aria-label').includes('Row event 9')).getBoundingClientRect(); return { t: r.top, b: r.bottom, cx: r.left + 40, cy: r.top + r.height / 2 }; })()`);
  void low;
  await clickOpen(async () => { await evaluate(`[...document.querySelectorAll('.ag-row')].find((r) => r.getAttribute('aria-label').includes('Row event 9')).scrollIntoView({ block: 'end' }); 1`); return evaluate(`(() => { const b = [...document.querySelectorAll('.ag-row')].find((x) => x.getAttribute('aria-label').includes('Row event 9')).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`); }, 'the popover of the low event');
  const fl = await footer();
  ok(rowBox.b > 552 - 90, `the event is near the bottom edge (bottom at ${rowBox.b})`);
  ok(fl.box.b <= rowBox.t + 2 && fl.box.t >= -0.5, `an event near the bottom edge gets the popover above it (popover ${Math.round(fl.box.t)}-${Math.round(fl.box.b)}, event top ${Math.round(rowBox.t)})`);
  await closeAll();
  // a window that becomes too low for the details: they scroll, the title and the footer stay, and the popover moves inside the window
  await H.cdp('Emulation.setDeviceMetricsOverride', { width: 946, height: 480, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await openDay(0, 'agenda');
  await waitFor(`document.querySelector('.ag-row')`, 'the agenda at 480 px');
  await clickOpen(() => find('.ag-row', 'Planning offsite'), 'the popover of the long event');
  await H.cdp('Emulation.setDeviceMetricsOverride', { width: 946, height: 200, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const tiny = await footer();
  ok(tiny.box.t >= -0.5 && tiny.box.b <= tiny.vh + 0.5, `946 x 200: the popover is inside the window (${Math.round(tiny.box.t)}-${Math.round(tiny.box.b)} of ${tiny.vh})`);
  ok(tiny.details.scroll > tiny.details.client + 1, `946 x 200: the details scroll (${tiny.details.scroll} > ${tiny.details.client})`);
  ok(tiny.foot.b <= tiny.box.b + 0.5 && tiny.rows.flat().every((b) => b.rect.b <= tiny.box.b + 0.5), '946 x 200: the footer and its buttons stay visible');
  ok(tiny.title.t >= tiny.box.t - 0.5, '946 x 200: the title stays');
  await shot('tiny');
  await closeAll();

  // ---------------------------------------------------------------- AC-7.12.6: narrow
  await H.cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 560, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  await openDay(0, 'agenda');
  await waitFor(`document.querySelector('.ag-row')`, 'the agenda at 320 px');
  await clickOpen(() => find('.ag-row', 'Product sync'), 'the popover at 320 px');
  await sleep(150);
  const nf = await footer();
  ok(nf.box.l >= -0.5 && nf.box.r <= nf.vw + 0.5, `320 px: the popover is inside the window (${Math.round(nf.box.l)}-${Math.round(nf.box.r)} of ${nf.vw})`);
  for (const name of ['Duplicate', 'Save .ics', 'Delete']) {
    const b = nf.rows.flat().find((x) => x.name === name);
    ok(b && b.label === '' && b.title === name && b.aria === name && b.svg, `320 px: ${name} is icon-only with its title and aria-label (${JSON.stringify(b && { label: b.label, title: b.title, aria: b.aria })})`);
  }
  ok(nf.rows.flat().every((b) => b.rect.r <= nf.box.r + 0.5 && b.rect.l >= nf.box.l - 0.5), '320 px: every button is inside the popover');
  await shot('narrow');
  await closeAll();
} catch (e) {
  ok(false, `threw: ${e.stack || e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-event-popover-actions: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-event-popover-actions: ${checks} checks passed`);
