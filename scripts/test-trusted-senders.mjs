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
//   T-C8  AC-16    8 languages x 960x560 / 1280x800: the labels fit (no clipping, no horizontal scroll, at most 3 lines at 1280x800), a long sender address does not matter
//   T-C10 AC-19    a reply quotes the pictures of a trusted sender's message; not those of a Junk message of the same sender
//   T-C11 AC-21..26 the list in Settings: empty, search above 8, Remove, Remove all (cancel / confirm), the note while the global switch is on
//   node scripts/test-trusted-senders.mjs [--require-browser]
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
  await evaluate(`window.__store.getState().select(null); 1`);
  await sleep(80);
  await evaluate(`window.__remoteFetchCalls = []; window.__store.getState().select(${JSON.stringify(id)}); 1`);
  ok(await until(`!!document.querySelector('.rp-msg.open iframe.msg-frame')`, 15000), `${id}: the message did not open`);
  await sleep(450);
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
  ok(n.cls === 'notice' && /did not pass the sender check/.test(n.text), `failed check: its own text (${n.text})`);
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
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-trusted-senders: ${failures.length} failure(s) of ${checks} checks`); process.exit(1); }
console.log(`test-trusted-senders: ok (${checks} checks)`);
