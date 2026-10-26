#!/usr/bin/env node
// 1.0.10 "Test connection" in the dev preview, with the mocked backend (src/devMockConn.ts decides the answers by the host or the password that is typed):
//   Settings > Add account > iCloud, Yahoo, other. Drives the real form with real mouse and keyboard events (CDP) and reads what a person reads.
//   AC-1..AC-4   the button, the reason line, Gmail needs the address and the password only, a host that is not a name
//   AC-5, AC-6   both lines at once, each with its own result, one test for a double click
//   AC-7..AC-9   Cancel and Esc (Settings stays open), the timeout, stale lines after an edit, an edit while a test runs
//   AC-10..AC-18 the sentences, hints, fields and fixes of the kinds (English), the same rows in the other 7 languages without clipping, Show field, port fixes, swapped hosts,
//                trust and test again, app password and Google / Microsoft sign-in, the shared SMTP login
//   AC-19..AC-22 a refused Add account shows the same lines, the pause after three failed sign-ins, offline, Details and Copy
//   AC-26, AC-27 the keyboard order and the focus, the status region
//   node scripts/test-conn-test-ui.mjs [--require-browser] [--shots=<dir>]
import assert from 'node:assert/strict';
import { arg, inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-conn-test-ui', { vitePort0: 6230 });
const { evaluate } = H;
const { press, click, shot } = inputs(H, arg('shots'), 'conn');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 700)}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(30); } return false; };
const must = async (js, what, ms) => assert.ok(await waitFor(js, ms), `timeout: ${what}`);

const SEL = {
  email: 'input[aria-label="Email"]', pw: 'input[aria-label="Password / app password"]', user: 'input[aria-label="Username (if different from email)"]',
  imapHost: 'input[aria-label="IMAP host"]', imapPort: 'input[aria-label="IMAP port"]', imapSec: 'select[aria-label="IMAP security"]',
  smtpHost: 'input[aria-label="SMTP host"]', smtpPort: 'input[aria-label="SMTP port"]', smtpSec: 'select[aria-label="SMTP security"]',
  provider: 'select[aria-label="Provider"]', test: '[data-conn="test"]', add: '.set-card .btn.primary', reason: '[data-conn="reason"]', block: '[data-conn="block"]',
  summary: '[data-conn="summary"]', cancel: '[data-conn="cancel"]', details: '[data-conn="details"]', detailsText: '[data-conn="details-text"]',
};
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const text = (sel) => evaluate(`(${q(sel)}?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);
/** the visible sentence of the summary (the status region also holds the failed lines for a screen reader, in a visually hidden span) */
const summaryText = () => evaluate(`(${q(SEL.summary)}?.firstChild?.textContent ?? '').trim()`);
/** the text of a node with its child elements separated by a space (textContent glues buttons to the sentence) */
const spaced = (sel) => evaluate(`[...${q(sel)}.children].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' ')`);
const exists = (sel) => evaluate(`!!${q(sel)}`);
const set = (sel, v) => evaluate(`(() => { const e = ${q(sel)}; const sel = e.tagName === 'SELECT'; Object.getOwnPropertyDescriptor(sel ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event(sel ? 'change' : 'input', { bubbles: true })); return e.value; })()`);
const calls = (cmd) => evaluate(`window.__calls.filter((c) => c.cmd === ${JSON.stringify(cmd)}).map((c) => c.args)`);
const line = (part) => text(`.conn-part[data-part="${part}"] [data-conn="text"]`);
const lineState = (part) => evaluate(`${q(`.conn-part[data-part="${part}"]`)}?.dataset.state ?? ''`);
const lineKind = (part) => evaluate(`${q(`.conn-part[data-part="${part}"]`)}?.dataset.kind ?? ''`);
const buttons = (part) => evaluate(`[...document.querySelectorAll('.conn-part[data-part="${part}"] .conn-actions button')].map((b) => b.textContent.trim())`);
const isDisabled = (sel) => evaluate(`${q(sel)}.disabled`);
const focusId = () => evaluate(`document.activeElement?.dataset?.conn ?? document.activeElement?.tagName ?? ''`);
const clickButton = (label, within = '') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${within} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`);
const invalid = (sel) => evaluate(`${q(sel)}.getAttribute('aria-invalid') === 'true'`);
const enter = async () => { await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) }); await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
/** the language of the page (a chunk the dev server transforms on the first request: tried again, with a short wait each time, when the first try is lost) */
const switchLang = async (lang) => {
  for (let i = 0; i < 4; i++) {
    if (await evaluate(`(async () => { window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); const t0 = Date.now(); while (Date.now() - t0 < 12000) { const s = window.__store.getState(); if (s.langLoading === null && s.prefs.language === ${JSON.stringify(lang)}) return true; await new Promise((r) => setTimeout(r, 30)); } return false; })()`)) return;
  }
  throw new Error(`the language ${lang} was not applied`);
};
const dialogOpen = () => evaluate(`!!document.querySelector('[role=dialog]')`);

async function openForm({ hash = '', w = 1280, h = 800, lang = 'en', provider = 'custom' } = {}) {
  await H.openApp(`lang=${lang}&os=windows&conncooldown=3&conntime=1500${hash ? `&${hash}` : ''}`, w, h);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'add-account' }); 1`);
  await must(`document.querySelectorAll('.seg button').length >= 3`, 'the segments');
  await evaluate(`[...document.querySelectorAll('.seg button')].pop().click(); 1`);
  await must(`!!${q(SEL.test)}`, 'the form');
  await evaluate(`(() => {
    window.__calls = [];
    if (window.__spied) return 1;
    window.__spied = true;
    const inv = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    window.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => { window.__calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? null)), t: Date.now() }); return inv(cmd, args, opts); };
    return 1;
  })()`);
  if (provider !== 'custom') await set(SEL.provider, provider);
}

/** Fills the form of provider Other: the address, the password and a mock scenario host for both servers. */
async function fill({ host = 'ok.test', pw = 'secret', email = 'sam@fastmail.test', smtpHost, imapPort, smtpPort } = {}) {
  await set(SEL.email, email);
  await set(SEL.pw, pw);
  if (await exists(SEL.imapHost)) {
    await set(SEL.imapHost, host);
    await set(SEL.smtpHost, smtpHost ?? host);
    if (imapPort) await set(SEL.imapPort, String(imapPort));
    if (smtpPort) await set(SEL.smtpPort, String(smtpPort));
  }
}
const runTest = () => click(SEL.test);
const ended = (ms = 8000) => must(`!!${q(SEL.block)} && !${q(SEL.cancel)} && ![...document.querySelectorAll('.conn-part')].some((p) => p.dataset.state === 'checking')`, 'the test to end', ms);
const testAndWait = async () => { await runTest(); await ended(); };

try {
  // ---------------------------------------------------------------- AC-1, AC-2, AC-3, AC-4
  await check('AC-1: the button is left of Add account in one row, both fully visible at 960x560', async () => {
    await openForm({ w: 960, h: 560 });
    const g = await evaluate(`(() => { const t = ${q(SEL.test)}.getBoundingClientRect(), a = ${q(SEL.add)}.getBoundingClientRect(), body = document.querySelector('.settings-body').getBoundingClientRect(); return { sameRow: Math.abs(t.top - a.top) < 4, left: t.right <= a.left, inside: t.left >= body.left && a.right <= body.right, label: ${q(SEL.test)}.textContent.trim() }; })()`);
    assert.deepEqual(g, { sameRow: true, left: true, inside: true, label: 'Test connection' });
  });
  await check('AC-2: the reason line, in field order, and the tooltip equals it', async () => {
    await openForm();
    const seq = [];
    const reason = async () => ({ disabled: await isDisabled(SEL.test), line: (await exists(SEL.reason)) ? await text(SEL.reason) : '', title: await evaluate(`${q(SEL.test)}.title`) });
    seq.push(await reason());
    await set(SEL.email, 'sam@fastmail.test'); seq.push(await reason());
    await set(SEL.pw, 'secret'); seq.push(await reason());
    await set(SEL.imapHost, 'imap.fastmail.test'); seq.push(await reason());
    await set(SEL.smtpHost, 'smtp.fastmail.test'); seq.push(await reason());
    await set(SEL.imapPort, ''); seq.push(await reason());
    assert.deepEqual(seq.map((s) => s.line), ['Enter the email address to test.', 'Enter the password to test.', 'Enter the IMAP host to test.', 'Enter the SMTP host to test.', '', 'Enter a port from 1 to 65535.'], JSON.stringify(seq));
    assert.deepEqual(seq.map((s) => s.disabled), [true, true, true, true, false, true]);
    assert.deepEqual(seq.map((s) => s.title), seq.map((s) => s.line), 'the tooltip is the reason');
    assert.ok(await evaluate(`${q(SEL.test)}.getAttribute('aria-describedby') === ${q(SEL.reason)}?.id`), 'the reason is linked to the button');
  });
  await check('AC-3: the Gmail preset needs the address and the password only', async () => {
    await openForm({ provider: 'gmail' });
    assert.equal(await exists(SEL.imapHost), false, 'the server fields are hidden');
    assert.equal(await isDisabled(SEL.test), true);
    await set(SEL.email, 'sam@gmail.com');
    await set(SEL.pw, 'x');
    assert.equal(await isDisabled(SEL.test), false);
    assert.equal(await exists(SEL.reason), false);
  });
  await check('AC-4: a host that is not a name is red and blocks Test and Add; spaces around a name are trimmed', async () => {
    await openForm();
    await fill({ host: 'https://imap.example.com/', smtpHost: 'smtp.example.com' });
    assert.equal(await invalid(SEL.imapHost), true);
    assert.equal(await text(SEL.reason), 'Enter only the server name, for example imap.example.com.');
    assert.equal(await isDisabled(SEL.test), true);
    assert.equal(await isDisabled(SEL.add), true);
    await set(SEL.imapHost, '  imap.example.com  ');
    assert.equal(await invalid(SEL.imapHost), false);
    assert.equal(await isDisabled(SEL.test), false);
    await testAndWait();
    const sent = await calls('test_connection');
    assert.deepEqual(sent.map((a) => a.input.imapHost), ['imap.example.com', 'imap.example.com'], 'both parts carry the trimmed name');
    assert.deepEqual(sent.map((a) => a.part).sort(), ['imap', 'smtp']);
  });

  // ---------------------------------------------------------------- AC-5, AC-6, AC-10, AC-27
  await check('AC-5, AC-6: both lines at once, each with its own result; a double click is one test', async () => {
    await openForm();
    await fill({ host: 'slow.test' });
    const t0 = Date.now();
    await click(SEL.test);
    await click(SEL.test).catch(() => undefined); // (the button is disabled by now: nothing happens)
    await must(`${q(SEL.test)}.textContent.includes('Testing…')`, 'the Testing… label', 1000);
    assert.equal(await summaryText(), 'Testing the connection…');
    assert.deepEqual([await line('imap'), await line('smtp')], ['Checking…', 'Checking…']);
    await must(`document.querySelector('.conn-part[data-part="smtp"]').dataset.state === 'ok'`, 'the SMTP result', 2500);
    const smtpAt = Date.now() - t0;
    assert.equal(await lineState('imap'), 'checking', 'IMAP still spins when SMTP is done');
    await must(`document.querySelector('.conn-part[data-part="imap"]').dataset.state === 'ok'`, 'the IMAP result', 4500);
    const imapAt = Date.now() - t0;
    assert.ok(smtpAt < 2000 && imapAt >= 2700 && imapAt < 4300, `SMTP ${smtpAt} ms, IMAP ${imapAt} ms`);
    assert.equal((await calls('test_connection')).length, 2, 'one test = one call per part');
  });
  await check('AC-10, AC-27: green block, folders counted, the summary is a status region, no toast', async () => {
    await openForm();
    await fill();
    await testAndWait();
    assert.equal(await evaluate(`${q(SEL.block)}.dataset.tone`), 'good');
    assert.equal(await summaryText(), 'Both servers work. You can add the account.');
    assert.equal(await line('imap'), 'Connected and signed in. 12 folders found.');
    assert.equal(await line('smtp'), 'Connected and signed in.');
    assert.equal(await evaluate(`${q(SEL.summary)}.getAttribute('role')`), 'status');
    assert.equal(await evaluate(`document.querySelectorAll('.toasts .toast').length`), 0, 'a test shows no toast (REQ-23)');
    assert.equal(await exists(SEL.details), true, 'Details is there, closed');
    assert.equal(await evaluate(`${q(SEL.details)}.open`), false);
    assert.equal((await calls('add_account')).length, 0, 'nothing was added');
    assert.equal(await exists('[data-conn="show-field"]'), false);
    await shot('ok');
  });

  // ---------------------------------------------------------------- AC-7, AC-8
  await check('AC-7: Cancel ends the test at once and the focus is on the button; Esc does the same and does not close Settings', async () => {
    await openForm();
    await fill({ host: 'blackhole.test' });
    await runTest();
    await must(`!!${q(SEL.cancel)}`, 'the Cancel link');
    assert.equal(await focusId(), 'cancel', 'the focus moves to Cancel');
    const t0 = Date.now();
    await click(SEL.cancel);
    await must(`${q(SEL.summary)}?.firstChild?.textContent.trim() === 'Test cancelled.'`, 'Test cancelled.', 700);
    assert.ok(Date.now() - t0 < 700);
    assert.equal(await focusId(), 'test', 'the focus is back on the button');
    assert.equal((await calls('cancel_test_connection')).length, 1);
    assert.equal(await exists('.conn-part'), false, 'the lines are dropped');
    await sleep(1800); // (the late answers of the mock must not come back)
    assert.equal(await summaryText(), 'Test cancelled.');
    // Esc
    await runTest();
    await must(`!!${q(SEL.cancel)}`, 'the Cancel link');
    await press('Escape', 'Escape');
    await must(`${q(SEL.summary)}?.firstChild?.textContent.trim() === 'Test cancelled.'`, 'cancelled by Esc', 700);
    assert.equal(await dialogOpen(), true, 'Settings stays open');
    assert.equal(await focusId(), 'test');
    await press('Escape', 'Escape');
    await must(`!document.querySelector('[role=dialog]')`, 'the second Esc closes Settings', 1500);
  });
  await check('AC-8: a server that stays silent is a timeout line (the mock waits 1.5 s instead of 20 s)', async () => {
    await openForm();
    await fill({ host: 'blackhole.test' });
    await runTest();
    await ended(5000);
    assert.equal(await line('imap'), 'The server did not answer within 20 seconds. Check the IMAP host and port, or your firewall.');
    assert.equal(await line('smtp'), 'The server did not answer within 20 seconds. Check the SMTP host and port, or your firewall.');
    assert.deepEqual([await buttons('imap'), await lineKind('imap')].flat(), ['Show field', 'timeout']);
  });

  // ---------------------------------------------------------------- AC-9
  await check('AC-9: an edit marks the lines it affects as stale; an edit while a test runs ends it', async () => {
    await openForm();
    await fill();
    await testAndWait();
    await set(SEL.smtpPort, '587');
    assert.equal(await line('smtp'), 'Changed since the test. Test again.');
    assert.equal(await line('imap'), 'Connected and signed in. 12 folders found.', 'the IMAP line keeps its result');
    assert.equal(await summaryText(), 'Some settings changed. Test again.');
    await set(SEL.pw, 'other');
    assert.deepEqual([await lineState('imap'), await lineState('smtp')], ['stale', 'stale']);
    await runTest();
    await ended();
    assert.deepEqual([await lineState('imap'), await lineState('smtp')], ['ok', 'ok'], 'a new test makes it current');
    await set(SEL.imapHost, 'slow.test');
    await set(SEL.smtpHost, 'slow.test');
    await runTest();
    await must(`!!${q(SEL.cancel)}`, 'running');
    const before = (await calls('cancel_test_connection')).length;
    await set(SEL.smtpPort, '25');
    await must(`!${q(SEL.block)}`, 'the block to go', 800);
    assert.equal((await calls('cancel_test_connection')).length, before + 1, 'the test was cancelled');
    await sleep(3500);
    assert.equal(await exists(SEL.block), false, 'no late answer');
    // the provider select clears the block
    await set(SEL.imapHost, 'ok.test'); await set(SEL.smtpHost, 'ok.test');
    await testAndWait();
    await set(SEL.provider, 'gmail');
    assert.equal(await exists(SEL.block), false);
  });

  // ---------------------------------------------------------------- AC-11: the rows, English
  const MSG = {
    dns: (p) => `Server name not found. Check the ${p} host and your internet connection.`,
    refused: (port) => `The server refused the connection on port ${port}. Check the port and the security setting.`,
    unreachable: 'Cannot reach the server. Check your internet connection, VPN or firewall.',
    auth: 'Sign-in failed. Check the username and password.',
  };
  const rows = [
    { name: 'dns', fill: { host: 'nx.test' }, imap: MSG.dns('IMAP'), smtp: MSG.dns('SMTP'), summary: 'Neither server could be reached. Check your internet connection.', fields: ['IMAP host', 'SMTP host'] },
    { name: 'refused', fill: { host: 'refused.test' }, imap: MSG.refused(993), smtp: MSG.refused(465), summary: 'Fix the problem below, then test again.' },
    { name: 'unreachable', fill: { host: 'unreach.test' }, imap: MSG.unreachable, smtp: MSG.unreachable, summary: 'Neither server could be reached. Check your internet connection.' },
    { name: 'secure', fill: { host: 'secure.test' }, imap: 'Couldn’t start a secure connection on port 993. The port and the security setting may not match.', smtp: 'Couldn’t start a secure connection on port 465. The port and the security setting may not match.', imapButtons: ['Show field', 'Use STARTTLS on port 143'], smtpButtons: ['Show field', 'Use STARTTLS on port 587'] },
    { name: 'certUntrusted', fill: { host: 'selfsigned.test' }, imap: 'The server’s certificate is not trusted (self-signed or unknown issuer). If you run this server yourself, you can trust its certificate.', imapButtons: ['Show field', 'Trust this certificate and test again'] },
    { name: 'certName', fill: { host: 'mismatch.test' }, imap: 'The certificate does not match the server name mismatch.test. Use the exact server name your provider gives. The certificate is for imap.example.org, example.org.', imapButtons: ['Show field', 'Trust this certificate and test again'] },
    { name: 'certExpired', fill: { host: 'expired.test' }, imap: 'The server’s certificate has expired or is not valid yet. Check your computer’s date and time, or ask the server’s administrator.', imapButtons: ['Trust this certificate and test again'] },
    { name: 'notImap', fill: { host: 'smtp-as-imap.test', smtpHost: 'ok.test' }, imap: 'This port does not answer like an incoming (IMAP) server. It answers like an outgoing (SMTP) server. Check the IMAP host and port.', smtp: 'Connected and signed in.', imapButtons: ['Show field', 'Swap IMAP and SMTP hosts'] },
    { name: 'notSmtp', fill: { host: 'ok.test', smtpHost: 'imap-as-smtp.test' }, smtp: 'This port does not answer like an outgoing (SMTP) server. It answers like an incoming (IMAP) server. Check the SMTP host and port. You can still add the account, but sending will fail until this is fixed.', smtpButtons: ['Show field'] },
    { name: 'busy', fill: { host: 'busy.test' }, imap: 'The server closed the session right away. It may be busy or limit connections. Try again in a few minutes.' },
    { name: 'auth', fill: { pw: 'wrong' }, imap: MSG.auth, smtp: MSG.auth, imapButtons: ['Show field'], fields: ['Password / app password', 'Password / app password'] },
    { name: 'appPassword', fill: { pw: 'apppw', host: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' }, imap: 'Gmail needs an app password, not your normal password. Create one in your account’s security settings and enter it here.', imapButtons: ['Show field', 'Get an app password', 'Use Google sign-in'] },
    { name: 'microsoftPassword', fill: { pw: 'msft', host: 'imap.example.org', smtpHost: 'smtp.example.org' }, imap: 'Microsoft does not accept a password for this account. Sign in with the Microsoft tab instead.', imapButtons: ['Use Microsoft sign-in'] },
    { name: 'smtpAuthOff', fill: { pw: 'smtpoff' }, smtp: 'Sending with a password is turned off for this account. Ask your administrator to allow SMTP AUTH, or sign in with the Microsoft tab. You can still add the account, but sending will fail until this is fixed.', smtpButtons: ['Use Microsoft sign-in'] },
    { name: 'imapOff', fill: { pw: 'imapoff' }, imap: 'IMAP is turned off for this account. Turn on IMAP in your mail provider’s web settings, then test again.' },
    { name: 'webLogin', fill: { pw: 'weblogin' }, imap: 'Your provider wants you to sign in on its website first. Sign in there, confirm that it was you, then test again.' },
    { name: 'tooMany', fill: { pw: 'toomany' }, imap: 'Too many sign-in attempts. Wait a few minutes, then try again.' },
    { name: 'noAuth', fill: { host: 'noauth.test', smtpPort: 25 }, smtp: 'The server does not offer sign-in on this port. Outgoing mail usually uses port 587 with STARTTLS or 465 with SSL/TLS. You can still add the account, but sending will fail until this is fixed.', smtpButtons: ['Show field', 'Use SSL/TLS on port 465', 'Use STARTTLS on port 587'] },
    { name: 'listFailed', fill: { host: 'listfail.test' }, imap: 'Signed in, but the folder list could not be read. See Details.', summary: 'The servers work, with a warning below.' },
    { name: 'unknown', fill: { pw: 'unknown' }, smtp: 'The test failed. See Details for the server’s reply.', smtpButtons: [] },
  ];
  for (const row of rows) {
    await check(`AC-11 (${row.name}): the sentence, the hints, the buttons`, async () => {
      await openForm();
      await fill(row.fill);
      await testAndWait();
      if (row.imap) assert.equal(await line('imap'), row.imap, 'IMAP');
      if (row.smtp) assert.equal(await line('smtp'), row.smtp, 'SMTP');
      if (row.summary) assert.equal(await summaryText(), row.summary);
      if (row.imapButtons) assert.deepEqual(await buttons('imap'), row.imapButtons, 'IMAP buttons');
      if (row.smtpButtons) assert.deepEqual(await buttons('smtp'), row.smtpButtons, 'SMTP buttons');
      if (row.name === 'unknown') assert.equal(await evaluate(`${q(SEL.details)}.open`), true, 'unknown opens the Details');
      if (row.name === 'auth') assert.equal(await evaluate(`${q(SEL.block)}.dataset.tone`), 'bad');
    });
  }

  // ---------------------------------------------------------------- AC-12, AC-13, AC-14, AC-15
  await check('AC-12: Show field focuses and selects the field, red until it is edited', async () => {
    await openForm();
    await fill({ host: 'nx.test' });
    await testAndWait();
    await click('.conn-part[data-part="imap"] [data-conn="show-field"]');
    assert.equal(await evaluate(`document.activeElement === ${q(SEL.imapHost)} && ${q(SEL.imapHost)}.selectionStart === 0 && ${q(SEL.imapHost)}.selectionEnd === ${q(SEL.imapHost)}.value.length`), true, 'focused and selected');
    assert.equal(await invalid(SEL.imapHost), true);
    assert.equal(await evaluate(`${q('.conn-part[data-part="imap"] [data-conn="show-field"]')}.getAttribute('aria-label')`), 'Show field: IMAP host');
    await set(SEL.imapHost, 'nx2.test');
    assert.equal(await invalid(SEL.imapHost), false, 'edited: no longer red');
  });
  await check('AC-13: port and security hints with one-click fixes that change the form only', async () => {
    await openForm();
    await fill({ host: 'imap.fastmail.test', smtpHost: 'smtp.fastmail.test' });
    await set(SEL.imapSec, 'starttls'); // port 993 + STARTTLS
    const hint = await spaced('[data-pre="imapPortSecurity"]');
    assert.equal(hint, 'Port 993 is normally used with SSL/TLS. Use SSL/TLS on port 993 Use STARTTLS on port 143');
    const before = (await calls('test_connection')).length;
    await clickButton('Use SSL/TLS on port 993', '[data-pre="imapPortSecurity"]');
    assert.deepEqual(await evaluate(`[${q(SEL.imapPort)}.value, ${q(SEL.imapSec)}.value]`), ['993', 'ssl']);
    assert.equal(await exists('[data-pre="imapPortSecurity"]'), false, 'the hint is gone');
    assert.equal((await calls('test_connection')).length, before, 'no test ran');
    assert.equal((await calls('add_account')).length, 0, 'nothing was saved');
    await set(SEL.smtpSec, 'starttls');
    assert.equal(await spaced('[data-pre="smtpPortSecurity"]'), 'Port 465 is normally used with SSL/TLS. Use SSL/TLS on port 465 Use STARTTLS on port 587');
    await clickButton('Use STARTTLS on port 587', '[data-pre="smtpPortSecurity"]');
    assert.deepEqual(await evaluate(`[${q(SEL.smtpPort)}.value, ${q(SEL.smtpSec)}.value]`), ['587', 'starttls']);
    await set(SEL.smtpPort, '25');
    assert.equal(await text('[data-pre="smtp25"]'), 'Port 25 is often blocked on home and office networks. Try 587 or 465.');
    await set(SEL.imapPort, '1143'); await set(SEL.imapSec, 'starttls');
    assert.equal(await exists('[data-pre="imapPortSecurity"]'), false, 'a Bridge port gets no hint');
  });
  await check('AC-14: swapped hosts are named and swapped by one click', async () => {
    await openForm();
    await fill({ host: 'smtp.example.com', smtpHost: 'imap.example.com' });
    assert.equal(await spaced('[data-pre="swapped"]'), 'The IMAP and SMTP hosts look swapped. Swap IMAP and SMTP hosts');
    await clickButton('Swap IMAP and SMTP hosts', '[data-pre="swapped"]');
    assert.deepEqual(await evaluate(`[${q(SEL.imapHost)}.value, ${q(SEL.smtpHost)}.value]`), ['imap.example.com', 'smtp.example.com']);
    assert.equal(await exists('[data-pre="swapped"]'), false);
  });
  await check('AC-15: "Trust this certificate and test again" turns the switch on and the test ends green', async () => {
    await openForm();
    await fill({ host: 'selfsigned.test' });
    await testAndWait();
    assert.equal(await evaluate(`${q('.switch input')} && [...document.querySelectorAll('.switch input')].pop().checked`), false);
    await clickButton('Trust this certificate and test again', '.conn-part[data-part="imap"]');
    await must(`[...document.querySelectorAll('.switch input')].pop().checked`, 'the switch to turn on');
    assert.ok(await text('.set-card .notice:not(.conn-block)').then((x) => x.includes('The certificate is not checked')), 'its warning shows');
    await ended();
    assert.equal(await summaryText(), 'Both servers work. You can add the account.');
    const sent = await calls('test_connection');
    assert.deepEqual(sent.slice(-2).map((a) => a.input.tlsInsecure), [true, true], 'the second test trusts the certificate');
  });

  // ---------------------------------------------------------------- AC-16, AC-17, AC-18
  await check('AC-16: Gmail with a normal password: the provider sentence, the app password link and Google sign-in', async () => {
    await openForm({ provider: 'gmail' });
    await fill({ email: 'sam@gmail.com', pw: 'gmailnormal' });
    await testAndWait();
    assert.equal(await line('imap'), 'Sign-in failed. Check the username and password. Gmail accepts only an app password here, not your normal password.');
    assert.deepEqual(await buttons('imap'), ['Show field', 'Get an app password', 'Use Google sign-in']);
    assert.equal(await exists('[data-conn="show-field"]') && await text('.conn-part[data-part="imap"] [data-conn="show-field"]'), 'Show field');
    await clickButton('Get an app password', '.conn-part[data-part="imap"]');
    await sleep(100);
    const urls = await evaluate(`window.__calls.filter((c) => /open_external|open_url/.test(c.cmd)).map((c) => JSON.stringify(c.args))`);
    assert.ok(urls.some((u) => u.includes('https://myaccount.google.com/apppasswords')), JSON.stringify(urls));
    await clickButton('Use Google sign-in', '.conn-part[data-part="imap"]');
    await must(`document.querySelector('.seg button.on')?.textContent.trim() === 'Google'`, 'the Google segment');
  });
  await check('AC-17: Outlook / Microsoft 365 with any password: Microsoft does not accept it, Microsoft sign-in', async () => {
    await openForm({ provider: 'outlook' });
    await fill({ email: 'sam@outlook.com', pw: 'anything' });
    await testAndWait();
    assert.equal(await line('imap'), 'Microsoft does not accept a password for this account. Sign in with the Microsoft tab instead.');
    await clickButton('Use Microsoft sign-in', '.conn-part[data-part="imap"]');
    await must(`document.querySelector('.seg button.on')?.textContent.trim() === 'Microsoft'`, 'the Microsoft segment');
  });
  await check('AC-18: the shared SMTP login refused: the line says so, Add still goes through (a separate login does not)', async () => {
    await openForm();
    await fill({ pw: 'smtpwrong' });
    await testAndWait();
    assert.equal(await line('imap'), 'Connected and signed in. 12 folders found.');
    assert.equal(await line('smtp'), 'Sign-in failed. Check the username and password. You can still add the account, but sending will fail until this is fixed.');
    await set(SEL.pw, 'smtpwrong');
    await click(SEL.add);
    await must(`window.__calls.some((c) => c.cmd === 'add_account')`, 'Add account', 3000);
    // a separate SMTP login: the note is not true for it
    await openForm();
    await fill({ pw: 'smtpwrong' });
    await click('.switch input'); // the first switch: a different login for sending
    await set('input[aria-label="SMTP username"]', 'smtp-user');
    await set('input[aria-label="SMTP password"]', 'smtpwrong');
    await testAndWait();
    assert.equal((await line('smtp')).includes('You can still add the account'), false);
    assert.equal(await line('smtp'), 'Sign-in failed. Check the SMTP username and SMTP password.');
  });

  // ---------------------------------------------------------------- AC-19, AC-20, AC-21, AC-22
  await check('AC-19: a refused Add account shows the same lines, the toast stays', async () => {
    await openForm();
    await fill({ pw: 'wrong' });
    await click(SEL.add);
    await must(`!!${q(SEL.block)}`, 'the block of the refused add', 4000);
    assert.equal(await summaryText(), 'The account was not added.');
    assert.equal(await line('imap'), 'Sign-in failed. Check the username and password.');
    assert.equal(await line('smtp'), 'Not checked.');
    assert.ok((await text('.toasts')).includes('Incoming (IMAP): Sign-in failed. Check the username and password.'), await text('.toasts'));
    assert.equal((await calls('add_account')).length, 1);
    assert.equal((await calls('add_account'))[0].input.email, 'sam@fastmail.test');
  });
  await check('AC-20: three failed sign-ins pause Test and Add, with a countdown; a success in between resets', async () => {
    await openForm();
    await fill({ pw: 'wrong' });
    await testAndWait(); await testAndWait();
    assert.equal(await isDisabled(SEL.test), false, 'two failures: no pause');
    await set(SEL.pw, 'good'); await testAndWait(); // a success resets
    await set(SEL.pw, 'wrong'); await testAndWait(); await testAndWait();
    assert.equal(await isDisabled(SEL.test), false, 'two failures after a success: no pause');
    await testAndWait();
    assert.equal(await isDisabled(SEL.test), true, 'the third in a row');
    assert.equal(await isDisabled(SEL.add), true);
    assert.match(await text(SEL.reason), /^Paused for [123] s after several failed sign-ins, so the server does not lock your account\.$/);
    await sleep(1200);
    const later = await text(SEL.reason);
    await must(`!${q(SEL.test)}.disabled`, 'the pause to end', 5000);
    assert.equal(await isDisabled(SEL.add), false);
    assert.equal(await exists(SEL.reason), false);
    assert.ok(/Paused for [12] s/.test(later), later);
  });
  await check('AC-21: neither server reached: the summary says to check the internet connection', async () => {
    await openForm();
    await fill({ host: 'nx.test' });
    await testAndWait();
    assert.equal(await summaryText(), 'Neither server could be reached. Check your internet connection.');
  });
  await check('AC-22: Details opens by itself for an unknown answer, shows host, kind and reply, Copy puts the same text on the clipboard', async () => {
    await openForm();
    await fill({ pw: 'wrong' });
    await testAndWait();
    await click(`${SEL.details} summary`);
    await must(`${q(SEL.details)}.open`, 'Details to open');
    const shown = await evaluate(`${q(SEL.detailsText)}.textContent`);
    assert.ok(shown.startsWith('Incoming (IMAP): ok.test:993 SSL/TLS\n  auth'), shown);
    assert.ok(shown.includes('Outgoing (SMTP): ok.test:465 SSL/TLS') && /\nHey Look! .*, Windows$/.test(shown), shown);
    await evaluate(`(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (x) => { window.__copied = x; } }, configurable: true }); return 1; })()`);
    await click('[data-conn="copy"]');
    await must(`window.__copied !== null`, 'the copy', 1500);
    assert.equal(await evaluate('window.__copied'), shown, 'the copied text equals the shown text');
    await must(`document.querySelector('.toasts')?.textContent.includes('Details copied')`, 'the toast', 1500);
  });
  await check('AC-23 (mock): the password is not in the details text of a failed test', async () => {
    await openForm();
    await fill({ pw: 'unknown' });
    await testAndWait();
    const shown = await evaluate(`${q(SEL.detailsText)}.textContent`);
    assert.ok(shown.includes('••••') && !shown.includes('unknown\n') && !/\u0001/.test(shown), shown);
  });

  // ---------------------------------------------------------------- AC-26: keyboard
  await check('AC-26: Tab reaches Test connection after the last field, Enter runs it, the focus goes to Cancel and back', async () => {
    await openForm();
    await fill({ pw: 'wrong' });
    await evaluate(`[...document.querySelectorAll('.switch input')].pop().focus()`);
    await press('Tab', 'Tab');
    assert.equal(await focusId(), 'test');
    await enter();
    await must(`${q(SEL.cancel)} && document.activeElement === ${q(SEL.cancel)}`, 'the focus on Cancel', 1500);
    await ended();
    assert.equal(await focusId(), 'test', 'the focus is back on Test connection');
    await press('Tab', 'Tab');
    assert.equal(await evaluate(`document.activeElement.classList.contains('primary')`), true, 'then Add account');
    for (const want of ['show-field', 'show-field']) { await press('Tab', 'Tab'); assert.equal(await focusId(), want); }
    await press('Tab', 'Tab');
    assert.equal(await evaluate(`document.activeElement.tagName === 'SUMMARY'`), true, 'then Details');
  });

  // ---------------------------------------------------------------- AC-29: the longest case in every language at 960x560
  for (const lang of ['de', 'fr', 'es', 'ja', 'ru', 'vi', 'zh-Hans']) {
    await check(`AC-11/AC-29 (${lang}): both lines failed with hints and fix buttons, Details open: no raw key, no clipping, no sideways scroll at 960x560`, async () => {
      await openForm({ w: 960, h: 560 });
      await set(SEL.email, 'sam@fastmail.test'); await set(SEL.pw, 'secret');
      await set(SEL.imapHost, 'secure.test'); await set(SEL.smtpHost, 'mismatch.test');
      await set(SEL.imapPort, '143'); await set(SEL.imapSec, 'ssl');
      await switchLang(lang);
      await runTest();
      await ended();
      await click(`${SEL.details} summary`);
      await must(`${q(SEL.details)}.open`, 'Details open');
      const m = await evaluate(`(() => {
        const body = document.querySelector('.settings-body'), blk = ${q(SEL.block)}, r = blk.getBoundingClientRect(), b = body.getBoundingClientRect();
        const cut = [...blk.querySelectorAll('button, .conn-text, .conn-name, summary')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map((e) => e.textContent.trim().slice(0, 30));
        const out = [...blk.querySelectorAll('button')].filter((e) => { const x = e.getBoundingClientRect(); return x.right > b.right + 1 || x.left < b.left - 1; }).map((e) => e.textContent.trim().slice(0, 30));
        return { text: blk.textContent, sideways: body.scrollWidth > body.clientWidth + 1, blockOut: r.right > b.right + 1 || r.left < b.left - 1, cut, out, lines: [...blk.querySelectorAll('.conn-part')].length };
      })()`);
      assert.ok(!/settings\.test\.|\{\w+\}|undefined/.test(m.text), `raw text in the block: ${m.text.slice(0, 300)}`);
      assert.deepEqual({ sideways: m.sideways, blockOut: m.blockOut, cut: m.cut, out: m.out, lines: m.lines }, { sideways: false, blockOut: false, cut: [], out: [], lines: 2 }, lang);
      await shot(`long-${lang}`);
    });
  }
}
catch (e) { failures.push(`setup: ${e.stack || e.message}`); }
if (failures.length) console.error(`FAIL - test-conn-test-ui\n${failures.map((f) => `  - ${f}`).join('\n')}`);
else console.log('ok - test-conn-test-ui');
await H.shutdown();
process.exit(failures.length ? 1 : 0);
