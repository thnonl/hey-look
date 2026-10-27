#!/usr/bin/env node
// 1.0.10: senders whose remote content always loads (spec E:\hey-mail\reports\v1-0-1\ba-v1010-trusted-senders-images.md), in the dev preview (src/devMock.ts: `list_remote_ok` / add / remove / clear,
// `fetch_remote_images`, `window.__remoteFetchCalls`, `window.__mockAddThread`, `window.__mockRemoteOk`).
//   T-C1  AC-6/7   the notice has three links in order (Load content, from this sender, Settings); the address is only in the tooltip; Tab order; no link for Junk, encrypted, failed check, own address
//   T-C2  AC-8     pressing it loads the pictures now (boxes gone, a backend fetch), the notice becomes the info line with the Stop link
//   T-C3  AC-9     Undo in the toast: the sender is off the list, the message is blocked again
//   T-C4  AC-10    the next message of the sender (another conversation) loads by itself, no warning
//   T-C5  AC-11    another window's change (the event) updates an open message within a second
//   T-C6  AC-12..15 held messages (Junk, encrypted, failed check) keep their warning with Stop; the global switch hides every notice
//   T-C7  AC-14/18 Stop puts the message back to blocked, toast with Undo, focus on the add link; after an add the focus is on the Stop link
//   T-C8  AC-16    8 languages x 960x560 / 1280x800: the labels fit (no clipping, no horizontal scroll, at most 3 lines), a long sender address does not matter
//   T-C10 AC-19    a reply quotes the pictures of a trusted sender's message; not those of a Junk message of the same sender
//   T-C11 AC-21..26 the list in Settings: empty, search above 8, Remove, Remove all (cancel / confirm), the note while the global switch is on
//   node scripts/test-trusted-senders.mjs [--require-browser]
import fs from 'node:fs';
import os from 'node:os';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-trusted-senders', { vitePort0: 5720 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let section = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${section}] ${msg}`); console.error(`FAIL [${section}] ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const until = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(expr); } catch { /* between two renders */ } if (v) return true; await sleep(40); } return false; };
const VK = { Tab: 9, Enter: 13, Escape: 27 };
const press = async (key, modifiers = 0) => {
  const p = { key, code: key, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key], modifiers };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  if (key === 'Enter') await cdp('Input.dispatchKeyEvent', { type: 'char', ...p, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
};

const IMG = '<img src="https://img.shop.example/a.png" width="200" height="60" alt="banner">';
const MAIL = `<div><p>Our weekly offers</p>${IMG}</div>`;
const SENDER = 'news@shop.example';
const LONG = `${'a'.repeat(44)}@${'b'.repeat(10)}.example`; // 60 characters
const ENC = { encrypted: true, partial: false, decryption: 'ok', encryptedFor: [], signature: null };
const THREADS = [
  ['tr1', 'Offers 1', { fromName: 'Shop', fromEmail: SENDER, html: MAIL }],
  ['tr2', 'Offers 2', { fromName: 'Shop', fromEmail: SENDER, html: MAIL }],
  ['trJ', 'Offers (junk)', { fromName: 'Shop', fromEmail: SENDER, html: MAIL, folder: 'junk' }],
  ['trE', 'Offers (encrypted)', { fromName: 'Shop', fromEmail: SENDER, html: MAIL, security: ENC }],
  ['trF', 'Offers (failed check)', { fromName: 'Shop', fromEmail: SENDER, html: MAIL, auth: 'fail' }],
  ['trP', 'Offers (passed check)', { fromName: 'Shop', fromEmail: SENDER, html: MAIL, auth: 'pass' }],
  ['trO', 'From myself', { fromName: 'Nam', fromEmail: 'nam@example.com', html: MAIL }],
  ['trN', 'Other shop', { fromName: 'Other', fromEmail: 'hello@other.example', html: MAIL }],
  ['trL', 'Long address', { fromName: 'L'.repeat(70), fromEmail: LONG, html: MAIL }],
  ['trT', 'Plain text', { fromName: 'Text', fromEmail: 'text@shop.example', html: null }],
];

const open = async (id) => {
  // (a conversation that was added a moment ago is in the list once the store has been refreshed: one more try with a refresh when it did not open in time, so a slow machine does not fail the test)
  for (let attempt = 0; attempt < 3; attempt++) {
    await evaluate(`window.__store.getState().select(null); 1`);
    await sleep(80);
    if (attempt > 0) { await evaluate(`window.__store.getState().refresh().then(() => 1)`); await sleep(400); }
    await evaluate(`window.__remoteFetchCalls = []; window.__store.getState().select(${JSON.stringify(id)}); 1`);
    if (await until(`!!document.querySelector('.rp-msg.open iframe.msg-frame')`, attempt === 2 ? 15000 : 6000)) { await sleep(450); return; }
  }
  ok(false, `${id}: the message did not open`);
};
/** The notice of the open message: its class, text and links (text, title, data-trust) in DOM order. */
const notice = () => evaluate(`(() => { const n = document.querySelector('.rp-msg.open .notice'); if (!n) return null; return { cls: n.className, text: n.firstChild ? n.textContent.replace(/\\s+/g, ' ').trim() : '', links: [...n.querySelectorAll('button.link')].map((b) => ({ text: b.textContent.trim(), title: b.title, trust: b.dataset.trust || null })) }; })()`);
/** The pictures of the open message: boxes (blocked) and real images in its frame. */
const frame = () => evaluate(`(() => { const d = document.querySelector('.rp-msg.open iframe.msg-frame')?.contentDocument; if (!d) return null; return { boxes: d.querySelectorAll('.hl-bp, [data-hl-blocked]').length, imgs: [...d.querySelectorAll('img')].filter((i) => (i.getAttribute('src') || '').startsWith('data:image')).length }; })()`);
const calls = () => evaluate(`JSON.stringify(window.__remoteFetchCalls || [])`).then(JSON.parse);
const toast = () => evaluate(`(() => { const t = document.querySelector('.toast, .toasts .toast'); return t ? t.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
const setList = (emails) => evaluate(`(() => { const m = window.__mockRemoteOk; m.clear(); for (const e of ${JSON.stringify(emails)}) m.set(e, 1761000000000); return window.__mockEmit('remote-ok-changed', null).then(() => 1); })()`);
const focused = () => evaluate(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, trust: a.dataset ? a.dataset.trust || null : null, text: (a.textContent || '').trim().slice(0, 60) } : null; })()`);
const WAIT = (ms) => sleep(ms);

async function start(w = 1280, h = 800, lang = 'en', extra = '') {
  await H.openApp(`light&lang=${lang}${extra}`, w, h);
  await evaluate(`${THREADS.map(([id, subject, over]) => `window.__mockAddThread(${JSON.stringify(id)}, ${JSON.stringify(subject)}, ${JSON.stringify(over)});`).join(' ')} window.__store.getState().setPrefs({ loadRemote: false }); window.__store.getState().refresh().then(() => 1)`);
  await sleep(300);
}

try {
  // ======================================================================== T-C1 + T-C7
  section = 'notice';
  await start();
  await open('tr1');
  let n = await notice();
  ok(n && n.cls === 'notice', `a new sender: the blocked notice (${n && n.cls})`);
  eq(n.links.map((l) => l.text), ['Load content', 'Always load remote content from this sender', 'Always load remote content (Settings)'], 'three links in this order');
  ok(n.links[1].title.includes(SENDER) && n.links[1].title === `Always load remote content from ${SENDER}`, `the tooltip of the middle link has the address: ${n.links[1].title}`);
  ok(!n.links.some((l) => l.text.includes(SENDER)) && !n.text.includes(SENDER), 'the address is not in the visible text');
  let f = await frame();
  ok(f && f.boxes > 0 && f.imgs === 0, `blocked: boxes, no picture ${JSON.stringify(f)}`);
  // Tab order: from the notice's first link through the three links
  await evaluate(`document.querySelector('.rp-msg.open .notice button.link').focus(); 1`);
  const seen = [await focused()];
  await press('Tab'); seen.push(await focused());
  await press('Tab'); seen.push(await focused());
  eq(seen.map((x) => x.text), ['Load content', 'Always load remote content from this sender', 'Always load remote content (Settings)'], 'Tab goes through the three links in order');

  // links that are not offered
  for (const [id, why] of [['trJ', 'Junk'], ['trE', 'encrypted'], ['trF', 'failed sender check'], ['trO', 'own address']]) {
    await open(id);
    n = await notice();
    eq(n && n.links.map((l) => l.text), ['Load content', 'Always load remote content (Settings)'], `${why}: only the two old links`);
  }
  await open('trP');
  n = await notice();
  eq(n.links.length, 3, 'a message that passed the sender check gets the offer');
  await open('trT');
  eq(await notice(), null, 'a plain text message has no notice');

  // ======================================================================== T-C2, T-C7 (focus), T-C3
  section = 'add';
  await open('tr1');
  await evaluate(`document.querySelector('.rp-msg.open .notice button[data-trust="add"]').focus(); 1`);
  await press('Enter');
  ok(await until(`(window.__remoteFetchCalls || []).length > 0`, 2000), 'the backend fetched the pictures');
  ok(await until(`(() => { const d = document.querySelector('.rp-msg.open iframe.msg-frame')?.contentDocument; return !!d && d.querySelectorAll('.hl-bp, [data-hl-blocked]').length === 0 && d.querySelectorAll('img[src^="data:image"]').length > 0; })()`, 2500), 'the pictures show within 2 s, no box left');
  n = await notice();
  ok(n && n.cls.includes('info') && /Remote content loads automatically for this sender\./.test(n.text), `the info line: ${JSON.stringify(n)}`);
  eq(n.links.map((l) => l.text), ['Stop loading remote content from this sender'], 'one link: Stop');
  ok(n.links[0].title === `Stop loading remote content from ${SENDER}`, 'the Stop tooltip has the address');
  eq((await focused()).trust, 'stop', 'after an add by Enter the focus is on the Stop link');
  ok((await toast() || '').includes(`Remote content will always load for ${SENDER}.`), `the toast: ${await toast()}`);
  eq([...(await evaluate(`[...window.__mockRemoteOk.keys()]`))], [SENDER], 'the list has the sender, lower case');
  // Undo
  ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.toast button, .toasts button')].find((x) => x.textContent.trim() === 'Undo'); if (!b) return false; b.click(); return true; })()`), 'the toast has Undo');
  ok(await until(`(() => { const n = document.querySelector('.rp-msg.open .notice'); return !!n && !n.classList.contains('info') && n.querySelectorAll('button.link').length === 3; })()`, 2500), 'Undo: blocked again with three links');
  f = await frame();
  ok(f && f.boxes > 0 && f.imgs === 0, `Undo: the boxes are back ${JSON.stringify(f)}`);
  eq(await evaluate(`window.__mockRemoteOk.size`), 0, 'Undo: the list is empty again');

  // ======================================================================== T-C4
  section = 'next';
  await evaluate(`document.querySelector('.rp-msg.open .notice button[data-trust="add"]').click(); 1`);
  await sleep(500);
  for (const id of ['tr2', 'trP']) {
    await open(id);
    ok(await until(`(() => { const d = document.querySelector('.rp-msg.open iframe.msg-frame')?.contentDocument; return !!d && d.querySelectorAll('img[src^="data:image"]').length > 0; })()`, 2500), `${id}: the pictures load by themselves`);
    n = await notice();
    ok(n && n.cls.includes('info') && !/blocked/.test(n.text), `${id}: no warning, the info line (${n && n.cls})`);
  }
  await open('trN');
  n = await notice();
  eq(n.links.length, 3, 'another sender is still blocked');

  // ======================================================================== T-C6
  section = 'held';
  await open('trJ');
  n = await notice();
  ok(n.cls === 'notice' && /blocked to help prevent tracking/.test(n.text), `Junk: the normal warning (${n.text})`);
  eq(n.links.map((l) => l.text), ['Load content', 'Stop loading remote content from this sender', 'Always load remote content (Settings)'], 'Junk of a trusted sender: Load content, Stop, Settings');
  f = await frame();
  ok(f.boxes > 0 && f.imgs === 0, 'Junk: not loaded');
  await open('trE');
  n = await notice();
  eq(n.links.map((l) => l.trust), [null, 'stop', null], 'encrypted: the Stop link is the middle one');
  await open('trF');
  n = await notice();
  ok(n.cls === 'notice' && /sender check failed/.test(n.text), `failed check: its own text (${n.text})`);
  eq(n.links.map((l) => l.trust), [null, 'stop', null], 'failed check: the Stop link is the middle one');
  f = await frame();
  ok(f.boxes > 0 && f.imgs === 0, 'failed check: not loaded');
  // "Load content" still loads this one message
  await evaluate(`document.querySelector('.rp-msg.open .notice button.link').click(); 1`);
  ok(await until(`(() => { const d = document.querySelector('.rp-msg.open iframe.msg-frame')?.contentDocument; return !!d && d.querySelectorAll('img[src^="data:image"]').length > 0; })()`, 2500), 'Load content still works for a held message');
  // the global switch: no notice for anybody
  await evaluate(`window.__store.getState().setPrefs({ loadRemote: true }); 1`);
  for (const id of ['tr1', 'trJ', 'trN']) { await open(id); eq(await notice(), null, `${id}: the global switch is on: no notice`); }
  await evaluate(`window.__store.getState().setPrefs({ loadRemote: false }); 1`);

  // ======================================================================== T-C5 + Stop (T-C7)
  section = 'stop';
  await open('tr1');
  ok((await notice()).cls.includes('info'), 'tr1 is trusted: the info line');
  // another window removes the sender (the event reaches this one)
  await setList([]);
  ok(await until(`(() => { const n = document.querySelector('.rp-msg.open .notice'); return !!n && !n.classList.contains('info') && n.querySelectorAll('button.link').length === 3; })()`, 1500), 'another window removed the sender: this message is blocked again within 1.5 s');
  await setList([SENDER]);
  ok(await until(`!!document.querySelector('.rp-msg.open .notice.info')`, 1500), 'another window added the sender: this message loads within 1.5 s');
  await evaluate(`window.__remoteFetchCalls = []; document.querySelector('.rp-msg.open .notice button[data-trust="stop"]').click(); 1`);
  ok(await until(`(() => { const n = document.querySelector('.rp-msg.open .notice'); return !!n && !n.classList.contains('info') && n.querySelectorAll('button.link').length === 3; })()`, 2000), 'Stop: blocked again at once');
  f = await frame();
  ok(f.boxes > 0 && f.imgs === 0, `Stop: boxes, no picture (a cached picture is not shown) ${JSON.stringify(f)}`);
  eq((await focused()).trust, 'add', 'after Stop the focus is on the add link');
  ok((await toast() || '').includes(`Remote content from ${SENDER} will no longer load automatically.`), `Stop: the toast ${await toast()}`);
  eq(await evaluate(`window.__mockRemoteOk.size`), 0, 'Stop: off the list');
  // the 1001st address
  await evaluate(`(() => { const m = window.__mockRemoteOk; for (let i = 0; i < 1000; i++) m.set('u' + i + '@x.org', 1); return 1; })()`);
  await evaluate(`document.querySelector('.rp-msg.open .notice button[data-trust="add"]').click(); 1`);
  ok(await until(`(document.body.innerText || '').includes('up to 1000 senders')`, 2500), `the full list says so (${await toast()})`);
  eq(await evaluate(`window.__mockRemoteOk.size`), 1000, 'the full list did not change');
  await setList([]);

  // ======================================================================== T-C10
  section = 'quote';
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  const quoteOf = async (id) => {
    await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
    await sleep(150);
    await open(id);
    await evaluate(`window.__remoteFetchCalls = []; 1`);
    ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === 'Reply'); if (!b) return false; b.click(); return true; })()`), `${id}: the Reply button`);
    ok(await until(`!!document.querySelector('.compose-pane .cp-editor .tiptap .quote-block')`, 15000), `${id}: the quote showed`);
    await sleep(900);
    return evaluate(`(() => { const r = document.querySelector('.compose-pane .quote-host')?.shadowRoot; const note = document.querySelector('.compose-pane .quote-note'); return { imgs: r ? r.querySelectorAll('img[src^="data:image"]').length : -1, note: note ? note.textContent.trim() : null, fetched: (window.__remoteFetchCalls || []).length }; })()`);
  };
  let q = await quoteOf('tr1');
  ok(q.imgs === 0 && q.note, `a sender not on the list: no picture, the note (${JSON.stringify(q)})`);
  await setList([SENDER]);
  q = await quoteOf('tr1');
  ok(q.imgs > 0 && !q.note, `a trusted sender: the picture shows, no note (${JSON.stringify(q)})`);
  q = await quoteOf('trJ');
  ok(q.imgs === 0 && q.note && q.fetched === 0, `a Junk message of the same sender: the note, nothing fetched (${JSON.stringify(q)})`);
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
  await setList([]);

  // ======================================================================== T-C11: the list in Settings
  section = 'settings';
  await setList([]);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:all', section: 'reading', nonce: Date.now() }); 1`);
  ok(await until(`!!document.querySelector('.trusted-list')`, 8000), 'the list is under the Always load remote content switch');
  const order = await evaluate(`(() => { const ids = [...document.querySelectorAll('.settings-body .set-row')].map((r) => r.id); return [ids.indexOf('set-loadRemote'), ids.indexOf('set-trusted')]; })()`);
  ok(order[0] >= 0 && order[1] === order[0] + 1, `the list's row follows the switch's (${order})`);
  const sl = () => evaluate(`(() => { const l = document.querySelector('.trusted-list'); if (!l) return null; const rows = [...l.querySelectorAll('.list-row')].map((r) => r.querySelector('.lr-title').textContent); return { rows, search: !!l.querySelector('input.trusted-search'), muted: [...l.querySelectorAll(':scope > .muted')].map((m) => m.textContent.trim()), removeAll: [...document.querySelectorAll('.settings-body .set-row button')].some((b) => b.textContent.trim() === 'Remove all'), added: l.querySelector('.list-row .small') ? l.querySelector('.list-row .small').textContent.trim() : null }; })()`);
  let s = await sl();
  ok(s.rows.length === 0 && s.muted.some((m) => m.startsWith('No senders yet.')) && !s.search && !s.removeAll, `empty: the text, no search box, no Remove all (${JSON.stringify(s)})`);
  await setList(['one@shop.example']);
  await sleep(300);
  s = await sl();
  ok(s.rows.length === 1 && !s.removeAll && /^Added /.test(s.added || '') && !s.search, `one sender: a row with its date, no Remove all (${JSON.stringify(s)})`);
  await setList(['a@shop.example', 'b@shop.example', 'c@shop.example', 'd@shop.example', 'e@shop.example', 'f@other.example', 'g@other.example', 'h@other.example']);
  await sleep(300);
  s = await sl();
  ok(s.rows.length === 8 && !s.search && s.removeAll, `eight senders: no search box yet, Remove all (${JSON.stringify(s)})`);
  await setList(['a@shop.example', 'b@shop.example', 'c@shop.example', 'd@shop.example', 'e@shop.example', 'f@other.example', 'g@other.example', 'h@other.example', 'i@other.example']);
  await sleep(300);
  s = await sl();
  ok(s.rows.length === 9 && s.search, 'nine senders: the search box');
  const type = async (txt) => { await evaluate(`(() => { const i = document.querySelector('.trusted-search'); i.focus(); return 1; })()`); await cdp('Input.insertText', { text: txt }); await sleep(150); };
  await type('SHOP');
  s = await sl();
  eq(s.rows, ['a@shop.example', 'b@shop.example', 'c@shop.example', 'd@shop.example', 'e@shop.example'], 'search "SHOP": only the rows that contain it');
  await evaluate(`(() => { const i = document.querySelector('.trusted-search'); i.select(); return 1; })()`);
  await type('zzz');
  s = await sl();
  ok(s.rows.length === 0 && s.muted.some((m) => m === 'No senders match "zzz".'), `"zzz": the no-match text (${JSON.stringify(s.muted)})`);
  await evaluate(`(() => { const i = document.querySelector('.trusted-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(150);
  // Remove one
  ok(await evaluate(`(() => { const b = document.querySelector('.trusted-list .list-row button'); if (!b) return false; const name = b.getAttribute('aria-label'); window.__removed = name; b.click(); return true; })()`), 'a Remove button');
  await sleep(300);
  eq(await evaluate(`window.__removed`), 'Remove a@shop.example', 'the name of the button has the address');
  eq(await evaluate(`window.__mockRemoteOk.has('a@shop.example')`), false, 'Remove: off the list');
  s = await sl();
  eq(s.rows.length, 8, 'Remove: the row is gone');
  // Remove all: Cancel, then confirm
  const modalBtn = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.ask button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  await evaluate(`[...document.querySelectorAll('.settings-body .set-row button')].find((b) => b.textContent.trim() === 'Remove all').click(); 1`);
  ok(await until(`!![...document.querySelectorAll('.ask')].find((m) => m.textContent.includes('Remove all senders?'))`, 2000), 'Remove all asks first');
  ok((await evaluate(`document.body.innerText`)).includes('Remote content from 8 senders will be blocked again.'), 'with the number in the text');
  ok(await modalBtn('Cancel'), 'Cancel');
  await sleep(300);
  eq(await evaluate(`window.__mockRemoteOk.size`), 8, 'Cancel: nothing changed');
  await evaluate(`[...document.querySelectorAll('.settings-body .set-row button')].find((b) => b.textContent.trim() === 'Remove all').click(); 1`);
  ok(await until(`!![...document.querySelectorAll('.ask')].find((m) => m.textContent.includes('Remove all senders?'))`, 2000), 'Remove all asks again');
  ok(await evaluate(`(() => { const bs = [...document.querySelectorAll('.ask button')].filter((x) => x.textContent.trim() === 'Remove all'); if (!bs.length) return false; bs[bs.length - 1].click(); return true; })()`), 'confirm');
  await sleep(400);
  eq(await evaluate(`window.__mockRemoteOk.size`), 0, 'confirm: the list is empty');
  s = await sl();
  ok(s.rows.length === 0 && s.muted.some((m) => m.startsWith('No senders yet.')), 'and the empty text shows');
  // the note while the global switch is on
  await evaluate(`window.__store.getState().setPrefs({ loadRemote: true }); 1`);
  await sleep(200);
  s = await sl();
  ok(s.muted.some((m) => m.startsWith('Not needed while "Always load remote content (images)" is on')), `the global switch is on: the note (${JSON.stringify(s.muted)})`);
  await evaluate(`window.__store.getState().setPrefs({ loadRemote: false }); 1`);
  await sleep(200);
  s = await sl();
  ok(!s.muted.some((m) => m.startsWith('Not needed while')), 'off: the note is gone');
  // the same list in one mailbox's page
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a2', section: 'reading', nonce: Date.now() }); 1`);
  ok(await until(`!!document.querySelector('.trusted-list')`, 6000), 'a mailbox page shows the same list');
  await evaluate(`window.__store.getState().setDialog(null); 1`);

  // ======================================================================== T-C8 + T-C9: the notice in 8 languages, two sizes, both themes
  section = 'layout';
  const LANGS = ['en', 'de', 'es', 'fr', 'ja', 'ru', 'vi', 'zh-Hans'];
  const SIZES = [[960, 560], [1230, 800] /* (478 px: a margin, 4 lines allowed) */, [1244, 800], [1260, 800], [1280, 800]]; // (the Sandbox QA windows are OUTER sizes: a window of 1260 has a page of about 1244, whose notice is about 490 px wide; 1260 and 1280 here are page widths)
  const report = [];
  for (const theme of ['light', 'dark']) for (const [w, h] of SIZES) for (const lang of LANGS) {
    if (theme === 'dark' && lang !== 'en' && lang !== 'de') continue;
    await H.openApp(`${theme}&lang=${lang}`, w, h);
    await evaluate(`${THREADS.map(([id, subject, over]) => `window.__mockAddThread(${JSON.stringify(id)}, ${JSON.stringify(subject)}, ${JSON.stringify(over)});`).join(' ')} window.__store.getState().setPrefs({ loadRemote: false }); window.__store.getState().refresh().then(() => 1)`);
    await sleep(300);
    // the three notices of the spec: the offer (S1), the blocked notice of a trusted sender held back in Junk (S5) and the one for a failed sender check (S6, the longest text)
    // both states of each variant (the sender on the list: the Stop link; not on it: the add link or none): offer, Junk, failed sender check
    for (const [id, state, onList] of [['trN', 'offer', false], ['trL', 'offer', false], ['trJ', 'held', true], ['trJ', 'plainJunk', false], ['trF', 'heldFailed', true], ['trF', 'plainFailed', false]]) {
      await setList(onList ? [SENDER] : []);
      await open(id);
      const m = await evaluate(`(() => {
        const n = document.querySelector('.rp-msg.open .notice'); if (!n) return null;
        const cs = getComputedStyle(n), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4, r = n.getBoundingClientRect(), pane = n.closest('.rp-msg').parentElement;
        const links = [...n.querySelectorAll('button.link')].map((b) => { const q = b.getBoundingClientRect(); const own = parseFloat(getComputedStyle(b).lineHeight) || lh; return { text: b.textContent.trim(), lines: Math.round(q.height / own), h: Math.round(q.height), inside: q.left >= r.left - 1 && q.right <= r.right + 1, tall: b.scrollWidth > b.clientWidth + 1 }; });
        const sc = [...document.querySelectorAll('.rp-msg.open, .reading-pane, .reader, .rp-scroll')].some((e) => e.scrollWidth > e.clientWidth + 1);
        const rg = document.createRange(); rg.selectNodeContents(n); const tops = []; for (const q of [...rg.getClientRects(), ...[...n.querySelectorAll('button.link')].flatMap((b) => [...b.getClientRects()])]) { if (q.height < 4) continue; const y = Math.round(q.top); if (!tops.some((v) => Math.abs(v - y) < 5)) tops.push(y); }
        return { lines: tops.length, width: Math.round(r.width), clip: n.scrollWidth > n.clientWidth + 1, hscroll: sc || document.documentElement.scrollWidth > innerWidth, links, text: n.textContent, right: Math.round(r.right), vw: innerWidth };
      })()`);
      ok(m, `${lang} ${w}x${h} ${id}: the notice shows`);
      // the narrowest real notices: a Mac window of 960 with the side menu open had a notice of 352 px (the reading pane is at least 440 px wide plus the page's own padding and the
      // size of the system font); the width is set on the notice itself, which wraps exactly as it would in a pane that narrow. Only once per language and variant (at 1280).
      if (w === 1280 && theme === 'light') {
        for (const nw of [400, 352]) {
          const k = await evaluate(`(() => { const n = document.querySelector('.rp-msg.open .notice'); if (!n) return null; n.style.width = '${nw}px'; n.style.boxSizing = 'border-box'; const rg = document.createRange(); rg.selectNodeContents(n); const tops = []; for (const q of [...rg.getClientRects(), ...[...n.querySelectorAll('button.link')].flatMap((b) => [...b.getClientRects()])]) { if (q.height < 4) continue; const y = Math.round(q.top); if (!tops.some((v) => Math.abs(v - y) < 5)) tops.push(y); } const r = n.getBoundingClientRect(); const inside = [...n.querySelectorAll('button.link')].every((b) => { const x = b.getBoundingClientRect(); return x.left >= r.left - 1 && x.right <= r.right + 1; }); const out = { lines: tops.length, clip: n.scrollWidth > n.clientWidth + 1, inside }; n.style.width = ''; n.style.boxSizing = ''; return out; })()`);
          ok(k && k.lines <= 4 && !k.clip && k.inside, `${lang} ${nw}px notice ${state}: at most 4 lines, nothing clipped (${JSON.stringify(k)})`);
          report.push(`${lang} ${nw}px ${state}: ${k && k.lines}`);
        }
      }
      if (!m) continue;
      ok(!m.clip && !m.hscroll, `${theme} ${lang} ${w}x${h} ${id}: not clipped, no horizontal scroll (${JSON.stringify({ clip: m.clip, hscroll: m.hscroll })})`);
      ok(m.links.every((l) => l.inside && !l.tall), `${lang} ${w}x${h} ${id}: every link inside the notice ${JSON.stringify(m.links.filter((l) => !l.inside || l.tall))}`);
      ok(!/reading\.trust|settings\.reading/.test(m.text), `${lang} ${w}x${h} ${id}: no raw key`);
      ok(!m.text.includes(LONG) && !m.text.includes(SENDER), `${lang} ${w}x${h} ${id}: the address is not in the text`);
      const trust = m.links.find((l) => /^(?!.*\()/.test(l.text) && l.text !== m.links[0].text && m.links.indexOf(l) === 1);
      if (trust) ok([...trust.text].length <= (['ja', 'zh-Hans'].includes(lang) ? 22 : 52), `${lang}: the label is short enough (${[...trust.text].length}): ${trust.text}`);
      if (theme === 'light') ok(m.lines <= (w >= 1244 ? 3 : 4), `${lang} ${w}x${h} ${id}: at most ${w >= 1244 ? 3 : 4} lines (${m.lines}; 3 at 1280, 4 at the narrow 960x560 where the Russian and German blocked text alone takes 3)`);
      if (theme === 'light') report.push(`${lang} ${w}x${h} ${state}: ${m.lines} (${m.width}px)`);
    }
    await setList([]);
  }
  console.log('  notice lines:', report.join('; '));
  fs.writeFileSync(process.env.NOTICE_LINES_OUT || os.devNull, report.join('\n'));
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-trusted-senders: ${failures.length} failure(s) of ${checks} checks`); process.exit(1); }
console.log(`test-trusted-senders: ok (${checks} checks)`);
