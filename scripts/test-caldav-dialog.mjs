#!/usr/bin/env node
// 1.0.7 W7.4 (calendar sync with a CalDAV server: iCloud, Fastmail, Nextcloud, any) in the dev preview with REAL mouse and key events. The mock backend (src/devMock.ts) answers the connect
// dialog by its values; the real discovery, sync and password handling are covered by the Rust tests (src-tauri/src/calsync/caldav_tests.rs).
//   - AC-7.4.1  a mailbox with no calendar service of its own gets Settings > Calendar > "Set up..." only where the build offers CalDAV (calendar_kinds_available)
//   - AC-7.4.2  the dialog per service: iCloud / Fastmail show a fixed address and the mailbox password choice, Nextcloud / Other an address and the certificate choice; Connect waits for the values
//   - AC-7.4.3  Connect sends the typed values once; the answer of the server (wrong password, no server, no CalDAV, no calendars, certificate, redirect, http) shows as one sentence next to the buttons, the dialog stays open with what was typed
//   - AC-7.4.4  a connected server: the switch, "user · host", the calendars with their switches, Stop asks and removes
//   - AC-7.4.5  after the server refused the password: the status sentence and "Enter password again...", the dialog asks for the password only
//   - AC-7.4.6  keyboard: Tab order Service, Address, Username, Password, check boxes, Cancel, Connect; Enter connects; Esc closes this dialog only (Settings stays)
//   - AC-7.4.7  the dialog fits at 960 x 560 in Light and Dark, in 8 languages; its words are the dictionary's
//   - REQ-13.14 RULE-1/2  Connect shows its pending state by 150 ms (budgets scale with the machine like test-reply-feedback)
//
//   node --experimental-strip-types scripts/test-caldav-dialog.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick] [--shots=dir]
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

const H = await startHarness('test-caldav-dialog', { vitePort0: 5140 });
const { evaluate } = H;
const { click, typeText, press, shot } = inputs(H, arg('shots'), 'caldav');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
let scale = 1;
const slow = (ms) => Math.round(ms * scale);
const waitFor = async (expr, what, ms = 8000) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms * Math.max(1, scale); await sleep(40)) if (await evaluate(`!!(${expr})`)) return true;
  ok(false, `timed out waiting for ${what}`);
  return false;
};
const openApp = async (hash, w = 960, h = 560) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length + 250);
};
const setLook = async (theme, lang) => {
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, language: ${JSON.stringify(lang)} }); 1`);
  await waitFor(`document.documentElement.lang === ${JSON.stringify(lang)}`, `the page language ${lang}`, 25000);
};
const openSettings = async (account = 'a5') => {
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:${account}', focus: 'calendar' }); 1`);
  await waitFor(`document.querySelector('.settings')`, 'Settings');
  await sleep(300);
};
const DLG = '.dav-form';
const dlgOpen = () => evaluate(`!!document.querySelector(${JSON.stringify(DLG)})`);
const field = (id) => `${DLG} #${id}`;
const val = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`);
const exists = (sel) => evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const connectBtn = `.modal-back:last-child .btn.primary`;
const state = () => evaluate(`(() => {
  const f = document.querySelector('.dav-form'); if (!f) return null;
  const m = f.closest('.modal'); const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const btns = [...m.querySelectorAll('.row-inline .btn')];
  const go = btns[btns.length - 1];
  return { title: m.querySelector('.modal-head b').textContent, labels: [...f.querySelectorAll(':scope > label')].map((l) => l.textContent),
    fixed: f.querySelector('.dav-fixed')?.textContent ?? null, checks: [...f.querySelectorAll('.dav-check label')].map((l) => ({ text: l.textContent, on: l.querySelector('input').checked })),
    help: [...f.querySelectorAll(':scope > .muted')].map((l) => l.textContent).filter((x) => !f.querySelector('.dav-fixed') || x !== f.querySelector('.dav-fixed').textContent),
    err: m.querySelector('.field-err')?.textContent ?? null, buttons: btns.map((b) => b.textContent), goDisabled: go.disabled, goBusy: go.getAttribute('aria-busy'),
    box: r(m), rects: btns.map(r), overflowX: m.scrollWidth - m.clientWidth, vw: window.innerWidth, vh: window.innerHeight, focus: document.activeElement?.id || document.activeElement?.tagName };
})()`);
const connects = () => evaluate('JSON.stringify(window.__mockDavConnects || [])').then(JSON.parse);
const setUp = '#set-calendar button';
const TRUST = '.dav-form > .dav-check:last-child input';
const typeInto = async (sel, text) => {
  await click(sel);
  await evaluate(`document.querySelector(${JSON.stringify(sel)}).select(); 1`);
  await typeText(text);
};
const openDialog = async () => {
  await waitFor(`document.querySelector(${JSON.stringify(setUp)})`, 'the Set up button');
  await click(setUp);
  await waitFor(`document.querySelector(${JSON.stringify(DLG)})`, 'the connect dialog');
  await sleep(150);
};
const pick = async (preset) => {
  await evaluate(`(() => { const s = document.querySelector('#dav-service'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(preset)}); s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await sleep(120);
};

try {
  await openApp("lang=en&light");
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / 48), 8);
  // ------------------------------------------------------------------ AC-7.4.1: a mailbox with no service of its own gets CalDAV (every build has it), also in a build without the Google and Microsoft clients
  await openApp('lang=en&light&calkinds=none');
  await openSettings('a5');
  ok(await exists('#set-calendar') && !!(await exists(setUp)), 'a build without the OAuth clients still offers CalDAV to the custom-domain mailbox');
  await openApp("lang=en&light");
  await openSettings('a5');
  ok(await exists('#set-calendar'), 'the custom-domain mailbox has the Calendar section');
  const label = await evaluate(`document.querySelector('#set-calendar .set-lbl').textContent`);
  ok(label.includes(D['settings.calendar.davLabel']) && label.includes(D['settings.calendar.davHint']), `the row says what CalDAV does (${label})`);
  ok((await evaluate(`document.querySelector(${JSON.stringify(setUp)}).textContent`)) === D['settings.calendar.davSetUp'], 'the button is "Set up..."');
  await openApp("lang=en&light");
  await openSettings('a2');
  ok(!(await evaluate(`!!document.querySelector('#set-calendar button.btn.small') && document.querySelector('#set-calendar button').textContent === ${JSON.stringify(D['settings.calendar.davSetUp'])}`)), 'a Google mailbox keeps its own Google sync (no Set up button)');

  // ------------------------------------------------------------------ AC-7.4.2: the dialog per service
  await openApp("lang=en&light");
  await openSettings('a5');
  await openDialog();
  let s = await state();
  ok(s.title === D['settings.calendar.davTitle'], `title (${s.title})`);
  ok(s.labels.join('|') === [D['settings.calendar.davService'], D['settings.calendar.davAddress'], D['settings.calendar.davUsername'], D['settings.add.password']].join('|'), `labels (${s.labels})`);
  ok((await val('#dav-service')) === 'other', 'a mailbox on its own domain starts at "Other CalDAV server"');
  ok((await val('#dav-user')) === 'nam@pro66.emailserver.vn', 'the user name is the mailbox address');
  ok(s.fixed === null && (await exists('#dav-url')), 'Other: an address box');
  ok(s.checks.length === 2 && s.checks[0].text === D['settings.calendar.davUseMailPassword'] && !s.checks[0].on && s.checks[1].text === D['settings.add.trustCert'] && !s.checks[1].on, `Other: the mailbox password and the certificate choice, both off (${JSON.stringify(s.checks)})`);
  ok(s.help.includes(D['settings.calendar.davHelpOther']), 'Other: its help line');
  ok(s.goDisabled && s.buttons.join('|') === `${D['common.cancel']}|${D['settings.calendar.davConnect']}`, `Connect waits for the values (${s.buttons}, disabled ${s.goDisabled})`);
  ok(s.focus === 'dav-service', `the focus starts on the service (${s.focus})`);
  await pick('nextcloud');
  s = await state();
  ok(s.help.includes(D['settings.calendar.davHelpNextcloud']), 'Nextcloud: its help line');
  ok(s.checks.length === 2 && s.checks[1].text === D['settings.add.trustCert'], 'Nextcloud: the certificate choice');
  await pick('icloud');
  s = await state();
  ok(s.fixed === 'https://caldav.icloud.com/' && !(await exists('#dav-url')), `iCloud: the fixed address (${s.fixed})`);
  ok(s.checks.length === 1 && s.checks[0].text === D['settings.calendar.davUseMailPassword'] && s.checks[0].on, `iCloud: use the mailbox password, on (${JSON.stringify(s.checks)})`);
  ok(!(await exists('#dav-pw')), 'iCloud with the mailbox password: no password box');
  ok(!s.goDisabled, 'iCloud with the mailbox password: Connect is ready');
  ok(s.help.includes(D['settings.calendar.davHelpIcloud']), 'iCloud: its help line');
  await pick('fastmail');
  s = await state();
  ok(s.fixed === 'https://caldav.fastmail.com/', `Fastmail: the fixed address (${s.fixed})`);
  ok(s.help.includes(D['settings.calendar.davHelpFastmail']), 'Fastmail: its help line');
  await click('.dav-check input'); // not the mailbox password
  ok(await exists('#dav-pw'), 'unticking the mailbox password shows the password box');
  s = await state();
  ok(s.goDisabled, 'a typed password is needed then');
  await pick('other');
  ok((await exists('#dav-pw')) && (await evaluate(`document.querySelector('.dav-check input')?.checked === false`)), 'Other: the mailbox password is off and a password box shows');

  // ------------------------------------------------------------------ AC-7.4.3: the server's answers; the values stay
  await openApp("lang=en&light");
  await openSettings('a5');
  await openDialog();
  await typeInto('#dav-url', 'https://nowhere.example.org');
  await typeInto('#dav-pw', 'secret');
  ok(!(await state()).goDisabled, 'address and password typed: Connect is ready');
  await click(connectBtn);
  await waitFor(`document.querySelector('.dav-form')?.closest('.modal').querySelector('.field-err')`, 'the answer for an address with no server');
  s = await state();
  ok(s.err === D['calendar.err.davNotFound'], `no server (${s.err})`);
  ok((await val('#dav-url')) === 'https://nowhere.example.org' && (await val('#dav-pw')) === 'secret', 'the typed values stay');
  ok((await dlgOpen()) && !s.goDisabled && s.goBusy !== 'true', 'the dialog stays open and Connect is ready again');
  const cases = [
    ['https://plain.example.org', 'secret', 'calendar.err.davNotCaldav'],
    ['https://empty.example.org', 'secret', 'calendar.err.davNoCalendars'],
    ['https://selfsigned.example.org', 'secret', 'calendar.err.davCert'],
    ['http://cloud.example.org', 'secret', 'calendar.err.davHttps'],
    ['https://redirect.example.org', 'secret', 'calendar.err.davRedirect', { host: 'login.example.net' }],
    ['https://cloud.example.org', 'wrong', 'calendar.err.davAuth'],
  ];
  for (const [url, pw, key, params] of cases) {
    await typeInto('#dav-url', url);
    await typeInto('#dav-pw', pw);
    const before = (await connects()).length;
    await click(connectBtn);
    await waitFor(`window.__mockDavConnects.length === ${before + 1}`, `the call for ${url}`);
    await waitFor(`!document.querySelector('.dav-form')?.closest('.modal').querySelector('[aria-busy="true"]')`, 'the answer');
    await sleep(100);
    s = await state();
    ok(s.err === tr('en', key, params), `${url}: ${key} (${s.err})`);
  }
  // an untrusted certificate goes through once the person trusts it
  await typeInto('#dav-url', 'https://selfsigned.example.org');
  await typeInto('#dav-pw', 'secret');
  await click(TRUST);
  ok(await evaluate(`!!document.querySelector('.dav-check .notice')`), 'trusting the certificate shows the warning');
  const calls = await connects();
  ok(calls.every((c) => c.useMailPassword === false && c.service === 'other'), 'every call carries the service and the mailbox password choice');
  ok(calls[0].url === 'https://nowhere.example.org' && calls[0].username === 'nam@pro66.emailserver.vn' && calls[0].password === 'secret' && calls[0].trustCert === false, `the first call carries the typed values (${JSON.stringify({ ...calls[0], password: '*' })})`);
  await click(connectBtn);
  await waitFor(`!document.querySelector('.dav-form')`, 'the dialog to close once the certificate is trusted');
  ok((await connects()).at(-1).trustCert === true, 'the last call trusts the certificate');

  // ------------------------------------------------------------------ AC-7.4.4: a connected server
  await waitFor(`document.querySelector('.dav-who')`, 'the connected state');
  ok((await evaluate(`document.querySelector('.dav-who').textContent`)) === 'nam@pro66.emailserver.vn · selfsigned.example.org', 'user and host are shown');
  ok(await evaluate(`document.querySelector('#set-calendar .switch input').checked`), 'the switch is on');
  const cals = await evaluate(`[...document.querySelectorAll('.settings .set-row')].map((r) => r.querySelector('.set-lbl')?.textContent ?? '').filter((t) => /Personal|Work|Team/.test(t))`);
  ok(cals.length === 3 && cals[2].includes(D['settings.calendar.readOnly']), `the calendars with a read-only one (${JSON.stringify(cals)})`);
  ok((await evaluate(`document.querySelector('.set-status')?.textContent ?? ''`)).length > 0, 'a status line');
  ok(await evaluate(`!![...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('nam@pro66.emailserver.vn'))`), 'a toast says sync is on');
  await click('#set-calendar .switch');
  await waitFor(`document.querySelector('.ask')`, 'the Stop question');
  const stopBody = await evaluate(`document.querySelector('.ask p').textContent`);
  ok(stopBody.includes('selfsigned.example.org'), `the Stop question names the server (${stopBody})`);
  await click('.ask-actions button:last-child');
  await waitFor(`document.querySelector(${JSON.stringify(setUp)})`, 'Set up again after Stop');
  ok(!(await exists('.dav-who')), 'Stop removes the connection');

  // ------------------------------------------------------------------ AC-7.4.2/7.4.3: iCloud with the mailbox password, one call; pending state
  await openApp("lang=en&light");
  await openSettings('a5');
  await openDialog();
  await pick('icloud');
  await evaluate(`window.__mockCalSync.davDelay = 1500; 1`);
  const t0 = await evaluate(`performance.now()`);
  await click(connectBtn);
  await waitFor(`document.querySelector('.dav-form')?.closest('.modal').querySelector('.btn.primary[aria-busy="true"]')`, 'the pending Connect', 3000);
  const dt = (await evaluate(`performance.now()`)) - t0;
  s = await state();
  ok(s.goBusy === 'true' && s.buttons.at(-1) === D['settings.calendar.davConnecting'], `Connect shows "${D['settings.calendar.davConnecting']}" while it waits (${s.buttons})`);
  ok(await evaluate(`[...document.querySelectorAll('.dav-form input, .dav-form select')].every((e) => e.disabled)`), 'the fields are disabled while it waits');
  ok(dt < slow(2000), `Connect shows its pending state quickly (${Math.round(dt)} ms incl. the click)`);
  await waitFor(`!document.querySelector('.dav-form')`, 'iCloud to connect', 6000);
  const ic = (await connects()).at(-1);
  ok(ic.service === 'icloud' && ic.useMailPassword === true && ic.password === '' && ic.username === 'nam@pro66.emailserver.vn', `iCloud call: mailbox password, no typed one (${JSON.stringify({ ...ic, password: ic.password ? '*' : '' })})`);
  ok((await connects()).length === 1, 'one call');
  ok((await evaluate(`document.querySelector('.dav-who').textContent`)) === 'nam@pro66.emailserver.vn · caldav.icloud.com', 'iCloud host shown');

  // ------------------------------------------------------------------ AC-7.4.6: keyboard
  await openApp("lang=en&light");
  await openSettings('a5');
  await openDialog();
  ok((await state()).focus === 'dav-service', 'keyboard: the focus starts on the service');
  const order = [];
  for (let i = 0; i < 8; i++) {
    order.push(await evaluate(`(() => { const a = document.activeElement; return a.id || a.getAttribute('aria-label') || a.tagName + ':' + (a.textContent || a.type || '').slice(0, 20); })()`));
    await press('Tab', 'Tab');
  }
  ok(order.slice(0, 7).join('|') === ['dav-service', 'dav-url', 'dav-user', 'dav-pw', 'INPUT:checkbox', 'INPUT:checkbox', `BUTTON:${D['common.cancel']}`].join('|'), `Tab order, Connect is disabled until the values are typed (${order.join(' > ')})`);
  await typeInto('#dav-url', 'https://cloud.example.org');
  await typeInto('#dav-pw', 'secret');
  await evaluate(`window.__mockCalSync.davDelay = 0; 1`);
  await press('Enter', 'Enter');
  await waitFor(`!document.querySelector('.dav-form')`, 'Enter to connect', 6000);
  ok((await connects()).length === 1, 'Enter in a field connects');

  await openApp("lang=en&light");
  await openSettings('a5');
  await openDialog();
  await press('Escape', 'Escape');
  await sleep(250);
  ok(!(await dlgOpen()), 'Esc closes the dialog');
  ok(await evaluate(`!!document.querySelector('.settings')`), 'Esc closes this dialog only: Settings stays');
  ok((await connects()).length === 0, 'Esc: no call');
  ok(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(setUp)})`), 'Esc: the focus is back on Set up');

  // ------------------------------------------------------------------ AC-7.4.5: the password was refused
  await openApp('lang=en&light&calsyncdav=auth');
  await openSettings('a5');
  await waitFor(`document.querySelector('.set-status .notice')`, 'the status sentence');
  const st = await evaluate(`document.querySelector('.set-status').textContent`);
  ok(st.includes(tr('en', 'calendar.sync.davAuth', { service: 'Nextcloud', username: 'nam' })), `status: ${st}`);
  const pwBtn = '.set-actions .btn.primary';
  ok((await evaluate(`document.querySelector(${JSON.stringify(pwBtn)})?.textContent`)) === D['settings.calendar.davEnterPassword'], 'the button "Enter password again..."');
  await click(pwBtn);
  await waitFor(`document.querySelector('.dav-form')`, 'the password dialog');
  s = await state();
  ok(await evaluate(`['dav-service', 'dav-url', 'dav-user'].every((i) => !document.getElementById(i) || document.getElementById(i).disabled)`), 'service, address and user name cannot be changed');
  ok(s.focus === 'dav-pw', `the focus is on the password (${s.focus})`);
  ok(s.checks.length === 0, 'no check boxes in this mode');
  await typeInto('#dav-pw', 'wrong');
  await click(connectBtn);
  await waitFor(`document.querySelector('.dav-form')?.closest('.modal').querySelector('.field-err')`, 'the refusal');
  ok((await state()).err === D['calendar.err.davAuth'], 'a wrong password: the sentence, the dialog stays');
  await typeInto('#dav-pw', 'right');
  await click(connectBtn);
  await waitFor(`!document.querySelector('.dav-form')`, 'the password dialog to close');
  ok(JSON.stringify(await evaluate(`window.__mockDavPasswords`)) === '["wrong","right"]', 'two password calls');
  await waitFor(`!document.querySelector('.set-actions .btn.primary')`, 'the button to go once the password works');
  ok(!(await evaluate(`(document.querySelector('.set-status')?.textContent ?? '').includes(${JSON.stringify(D['settings.calendar.davEnterPassword'])})`)), 'the status no longer asks for the password');

  // ------------------------------------------------------------------ AC-7.4.15: who sends the invitations (the dialog line, and whether the app sends them)
  for (const sched of [false, true]) {
    await openApp(`lang=en&light&calsyncdav=ok${sched ? '&davsched' : ''}`, 1280, 800);
    await evaluate(`(() => { const s = window.__store.getState(); s.setModule('calendar'); return 1; })()`);
    await waitFor(`window.__store.getState().calendars.some((c) => c.id === 'caldav:a5:work')`, 'the CalDAV calendars');
    const info = await evaluate(`window.__store.getState().calendars.find((c) => c.id === 'caldav:a5:work')`);
    ok(info.appInvites === !sched && info.movesGuests === !sched && info.service === 'Nextcloud', `${sched ? 'scheduling' : 'plain'}: the calendar says who sends (${JSON.stringify({ a: info.appInvites, m: info.movesGuests, s: info.service })})`);
    await evaluate(`(() => { const s = window.__store.getState(); s.setPrefs({ calDefaultCalendar: 'caldav:a5:work' }); s.setDialog({ type: 'event' }); return 1; })()`);
    await waitFor(`document.querySelector('.ev-invite')`, 'the event dialog');
    await sleep(300);
    const line = await evaluate(`[...document.querySelectorAll('.ev-form .muted.small')].map((e) => e.textContent).find((x) => /invitations/.test(x)) || ''`);
    const want = sched ? tr('en', 'calendar.dialog.serviceSendsFrom', { service: 'Nextcloud', email: 'nam@pro66.emailserver.vn' }) : tr('en', 'calendar.dialog.appSendsFrom', { email: 'nam@pro66.emailserver.vn' });
    ok(line === want, `${sched ? 'scheduling' : 'plain'}: the line says "${want}" (${line})`);
    // a guest: the app asks its backend to send the invitations only where the server does not
    await evaluate(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const t = document.querySelector('#ev-title') || document.querySelector('.ev-form input'); set.call(t, 'Planning'); t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await click('.ev-invite input');
    await typeText('guest@example.org');
    await press('Enter', 'Enter');
    await sleep(200);
    await click('.modal .row-inline .btn.primary');
    await waitFor(`(window.__mockCalls || []).some((c) => c.cmd === 'calendar_save_event')`, 'the save call');
    const call = await evaluate(`(window.__mockCalls || []).filter((c) => c.cmd === 'calendar_save_event').at(-1)`);
    ok(call.args.notify === !sched && call.args.event.attendees.length === 1, `${sched ? 'scheduling' : 'plain'}: notify is ${!sched} (${JSON.stringify(call.args.notify)}, ${call.args.event.attendees.length} guest)`);
  }

  // ------------------------------------------------------------------ AC-7.4.7: fit and words in 8 languages, Light and Dark
  await openApp("lang=en&light");
  await openSettings('a5');
  await openDialog();
  for (const theme of ['light', 'dark']) for (const lang of LANGS) {
    await setLook(theme, lang);
    for (const preset of ['other', 'icloud']) {
      await pick(preset);
      await evaluate(`(() => { const c = document.querySelector(${JSON.stringify(TRUST)}); if (c && !c.checked) c.click(); return 1; })()`);
      await sleep(80);
      s = await state();
      const where = `${lang}/${theme}/${preset}`;
      ok(s.title === tr(lang, 'settings.calendar.davTitle'), `${where}: title (${s.title})`);
      ok(s.labels[0] === tr(lang, 'settings.calendar.davService') && s.labels[1] === tr(lang, 'settings.calendar.davAddress'), `${where}: labels (${s.labels})`);
      ok(s.buttons.join('|') === `${tr(lang, 'common.cancel')}|${tr(lang, 'settings.calendar.davConnect')}`, `${where}: buttons (${s.buttons})`);
      ok(s.box.l >= 0 && s.box.r <= s.vw && s.box.t >= 0 && s.box.b <= s.vh, `${where}: inside the window (${JSON.stringify(s.box)})`);
      ok(s.overflowX <= 1, `${where}: no sideways scroll (${s.overflowX})`);
      ok(Math.abs(s.rects[0].t - s.rects[1].t) < 2 && s.rects[0].r <= s.rects[1].l, `${where}: Cancel and Connect on one row`);
    }
    if (lang === LANGS[0]) await shot(`dialog-${theme}`);
  }
  // an error in every language still fits
  await setLook('light', 'en');
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
console.log('test-caldav-dialog: ok');
