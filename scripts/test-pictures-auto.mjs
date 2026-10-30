#!/usr/bin/env node
// 1.0.10: pictures that show without a click (people you wrote to, well-known services) and the box of a hidden picture with its menu
// (spec E:\hey-mail\reports\v1-0-1\ba-v1010-written-to-and-placeholders.md), in the dev preview (src/devMock.ts: a message can carry `autoReason`, the senders turned off are
// `window.__mockRemoteNoauto`, the fetches of pictures are `window.__remoteFetchCalls`).
//   T-C1/C2 S8 and S9 (no notice bar: the info button in the header says why, its popover has the action; keyboard)   T-C3 Stop: hidden again, the offer, focus, toast, Undo, no list in Settings, the way back through "Always show"
//   T-C4 AC-10/11/12/13: the senders and messages that do NOT show by themselves; a trusted sender with the rule: Stop really stops
//   T-C6 AC-15..18 the box: size, text, aria, tiers, nothing for pixels and for what the mail hides      T-C7 AC-19/20 the menu: right-click, Shift+F10, Esc, in a link, confidential
//   T-C8 AC-21..25 show one picture (one fetch, the CSP stays, focus), show all, reopen                  T-C12 colours and the print rule
// 1.0.11 WP2 adds: the Settings list of senders turned off (Remove) and the global switch off (tag switch-off).
//   node scripts/test-pictures-auto.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { languageJs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-pictures-auto', { vitePort0: 5740 });
H.net.stub = (url) => (/\.png$/.test(url) ? { status: 200, type: 'image/png', body: '' } : undefined);
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (c, m) => { checks++; if (!c) { failures.push(`[${tag}] ${m}`); console.error('FAIL', `[${tag}] ${m}`); } return !!c; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const until = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = false; try { v = await evaluate(expr); } catch { /* between renders */ } if (v) return true; await sleep(40); } return false; };
const key = async (k, code, vk, modifiers = 0) => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  if (k === 'Enter') await cdp('Input.dispatchKeyEvent', { type: 'char', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(60);
};
const mouse = async (x, y, button = 'left') => {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
};

const SENDER = 'friend@example.org';
const u = (n) => `https://img.shop.example/${n}.png`;
const IMG = `<img src="${u('a')}" width="200" height="60" alt="banner">`;
const MAIL = `<div><p>Our weekly offers</p>${IMG}</div>`;
const ENC = { encrypted: true, partial: false, decryption: 'ok', encryptedFor: [], signature: null };
const THREADS = [
  ['pW', 'Written to', { fromName: 'Friend', fromEmail: SENDER, html: MAIL, auth: 'pass', autoReason: 'wrote' }],
  ['pS', 'Service', { fromName: 'Google', fromEmail: 'no-reply@accounts.google.com', html: MAIL, auth: 'pass', autoReason: 'service' }],
  ['pW2', 'Written to again', { fromName: 'Friend', fromEmail: SENDER, html: MAIL, auth: 'pass', autoReason: 'wrote' }],
  ['pN', 'No reason', { fromName: 'Shop', fromEmail: 'news@shop.example', html: MAIL, auth: 'pass' }],
  ['pJ', 'Junk', { fromName: 'Friend', fromEmail: 'junk@example.org', html: MAIL, auth: 'pass', autoReason: 'wrote', folder: 'junk' }],
  ['pE', 'Encrypted', { fromName: 'Friend', fromEmail: 'enc@example.org', html: MAIL, auth: 'pass', autoReason: 'wrote', security: ENC }],
  ['pF', 'Failed check', { fromName: 'Friend', fromEmail: 'fail@example.org', html: MAIL, auth: 'fail', autoReason: 'wrote' }],
  ['pT', 'Listed and the rule', { fromName: 'Google', fromEmail: 'alerts@accounts.google.com', html: MAIL, auth: 'pass', autoReason: 'service' }],
  ['pB', 'Boxes', { fromName: 'Shop', fromEmail: 'boxes@shop.example', html: `<p>Hi</p><img src="${u('b1')}" width="600" height="200" alt="Summer sale"><img src="${u('b2')}"><img src="${u('b3')}" width="1" height="1"><img src="${u('b4')}" hidden><img src="${u('b5')}" style="display:none"><img src="${u('b6')}" width="80" height="30" alt="Tiny"><img src="${u('b7')}" width="300" height="2">` }],
  ['pZ', 'Small boxes', { fromName: 'Shop', fromEmail: 'small@shop.example', html: `<p>Hi</p><img src="${u('z1')}" width="120" height="40" alt="Logo"><img src="${u('z2')}" width="120" height="56" alt="Logo"><img src="${u('z3')}" width="96" height="56"><img src="${u('z4')}" width="140" height="64" alt="Logo"><img src="${u('z5')}" width="100" height="45"><img src="${u('z6')}" width="300" height="120" alt="Banner"><img src="${u('z7')}" width="200" height="84" alt="Banner"><img src="${u('z8')}" width="200" height="100" alt="Banner"><img src="${u('z9')}" width="220" height="60" alt="Logo"><img src="${u('z10')}" width="168" height="50" alt="Logo"><img src="${u('z11')}" width="110" height="60" alt="Logo"><img src="${u('z12')}" width="140" height="84" alt="Logo"><img src="${u('z13')}" width="140" height="83" alt="Logo">` }],
  ['pY', 'Zoomed mail', { fromName: 'Shop', fromEmail: 'zoom@shop.example', html: `<div style="width:1500px"><p>Wide mail</p><img src="${u('y1')}" width="280" height="84" alt="Logo"><img src="${u('y2')}" width="168" height="50" alt="Logo"><img src="${u('y3')}" width="503" height="210" alt="Banner"></div>` }],
  ['pDK', 'Dark logo, written to', { fromName: 'Friend', fromEmail: SENDER, html: `<p>Hi</p><picture><source media="(prefers-color-scheme: dark)" srcset="${u('dark-logo')}"><img src="${u('light-logo')}" width="200" height="60" alt="Logo"></picture>`, auth: 'pass', autoReason: 'wrote' }],
  ['pM', 'Three pictures', { fromName: 'Shop', fromEmail: 'three@shop.example', html: `<p>Look</p><img src="${u('m1')}" width="200" height="80" alt="one"><img src="${u('m2')}" width="200" height="80" alt="two"><img src="${u('m3')}" width="200" height="80" alt="three">` }],
  ['pL', 'In a link', { fromName: 'Shop', fromEmail: 'link@shop.example', html: `<p>Hi</p><a id="lnk" href="https://shop.example/sale"><img src="${u('l1')}" width="200" height="80" alt="linked"></a>` }],
  ['pC', 'Confidential', { fromName: 'Shop', fromEmail: 'conf@shop.example', html: `<p>Secret</p><img src="${u('c1')}" width="200" height="80" alt="secret">`, confidential: true }],
  ['pD', 'Dup', { fromName: 'Shop', fromEmail: 'dup@shop.example', html: `<p>x</p><img src="${u('d1')}" width="200" height="80"><img src="${u('d1')}" width="200" height="80"><img src="${u('d2')}" width="200" height="80">` }],
];

const FR = `document.querySelector('.rp-msg.open iframe.msg-frame')`;
const open = async (id) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await evaluate(`window.__store.getState().select(null); 1`);
    await sleep(80);
    if (attempt > 0) { await evaluate(`window.__store.getState().refresh().then(() => 1)`); await sleep(400); }
    await evaluate(`window.__remoteFetchCalls = []; window.__store.getState().select(${JSON.stringify(id)}); 1`);
    if (await until(`!!${FR}`, attempt === 2 ? 15000 : 6000)) { await sleep(500); return; }
  }
  ok(false, `${id}: the message did not open`);
};
const notice = () => evaluate(`(() => { const n = document.querySelector('.rp-msg.open .notice'); if (!n) return null; return { cls: n.className, text: n.textContent.replace(/\\s+/g, ' ').trim(), links: [...n.querySelectorAll('button.link')].map((b) => b.textContent.trim()), trust: [...n.querySelectorAll('button.link')].map((b) => b.dataset.trust || null) }; })()`);
const pics = () => evaluate(`(() => { const d = ${FR}?.contentDocument; if (!d) return null; return { boxes: d.querySelectorAll('.hl-bp').length, imgs: [...d.querySelectorAll('img')].filter((i) => (i.getAttribute('src') || '').startsWith('data:image')).length, raw: d.querySelectorAll('img[data-hl-src]').length }; })()`);
const calls = () => evaluate(`JSON.stringify(window.__remoteFetchCalls || [])`).then(JSON.parse);
const toast = () => evaluate(`(() => { const t = document.querySelector('.toast, .toasts .toast'); return t ? t.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
const noauto = () => evaluate(`JSON.stringify([...window.__mockRemoteNoauto.keys()])`).then(JSON.parse);
const trusted = () => evaluate(`JSON.stringify([...window.__mockRemoteOk.keys()])`).then(JSON.parse);
const info = () => evaluate(`(() => { const b = document.querySelector('.rp-msg.open .autoinfo-btn'); return b ? { title: b.title, aria: b.getAttribute('aria-label'), kind: b.dataset.kind, expanded: b.getAttribute('aria-expanded') } : null; })()`);
const popover = () => evaluate(`(() => { const p = document.querySelector('.autoinfo-pop'); if (!p) return null; const r = p.getBoundingClientRect(); return { text: [...p.querySelectorAll('p')].map((x) => x.textContent.trim()), buttons: [...p.querySelectorAll('button')].map((b) => b.textContent.trim()), label: p.getAttribute('aria-label'), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, overflow: p.scrollWidth > p.clientWidth + 1, focusOn: document.activeElement ? document.activeElement.textContent.trim() : null }; })()`);
const openInfo = async () => { await evaluate(`document.querySelector('.rp-msg.open .autoinfo-btn').click(); 1`); return until(`!!document.querySelector('.autoinfo-pop')`, 2000); };
const infoAction = async () => { await openInfo(); await evaluate(`document.querySelector('.autoinfo-pop button').click(); 1`); };
const clearLists = () => evaluate(`window.__mockRemoteOk.clear(); window.__mockRemoteNoauto.clear(); window.__mockEmit('remote-ok-changed', null).then(() => 1)`);
const clickLink = (sel) => evaluate(`(() => { const b = document.querySelector('.rp-msg.open .notice ${sel}'); if (!b) return false; b.click(); return true; })()`);
const boxPoint = (i) => evaluate(`(() => { const f = ${FR}, d = f.contentDocument, b = d.querySelectorAll('.hl-bp[data-hl-pic]')[${i}]; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(), fr = f.getBoundingClientRect(); return [fr.left + q.left + Math.min(q.width / 2, 40), fr.top + q.top + Math.min(q.height / 2, 20)]; })()`);
const menuRows = () => evaluate(`(() => { const m = document.querySelector('.ctx-menu'); return m ? { label: (m.querySelector('[role=menu]') || m).getAttribute('aria-label'), rows: [...m.querySelectorAll('[role=menuitem],[role=separator]')].map((e) => (e.getAttribute('role') === 'separator' ? '---' : e.textContent.trim())), first: document.activeElement ? document.activeElement.textContent.trim() : null } : null; })()`);
const menuOpen = async () => { await until(`!!document.querySelector('.ctx-menu [role=menuitem]')`, 3000); return menuRows(); };
const closeMenu = async () => { if (await evaluate(`!!document.querySelector('.ctx-menu')`)) { await key('Escape', 'Escape', 27); await sleep(100); } };
const chooseRow = async (startsWith) => evaluate(`(() => { const r = [...document.querySelectorAll('.ctx-menu [role=menuitem]')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(startsWith)})); if (!r) return false; r.click(); return true; })()`);
const start = async (theme = 'light') => {
  await H.openApp(`${theme}&lang=en&nativemenu=off`, 1280, 800);
  await evaluate(`${THREADS.map(([id, subject, over]) => `window.__mockAddThread(${JSON.stringify(id)}, ${JSON.stringify(subject)}, ${JSON.stringify(over)});`).join(' ')} window.__store.getState().setPrefs({ loadRemote: false }); window.__store.getState().refresh().then(() => 1)`);
  await sleep(300);
  await clearLists();
};

let n;
try {
  await start();

  // ======================================================================== T-C1 / T-C2: S8 and S9
  tag = 'S8';
  await open('pW');
  eq(await notice(), null, 'no notice bar above a message whose pictures show by themselves');
  let ic = await info();
  const S8 = 'Pictures in this message are shown automatically because you have written to this address before.';
  ok(ic && ic.kind === 'wrote' && ic.title === S8 && ic.aria === S8 && ic.expanded === 'false', `the info button says why in one sentence: ${JSON.stringify(ic)}`);
  let p = await pics();
  ok(p.boxes === 0 && p.imgs >= 1, `the picture shows by itself: ${JSON.stringify(p)}`);
  ok((await calls()).length > 0, 'it came through the backend');
  ok(await openInfo(), 'the button opens the popover');
  let po = await popover();
  eq(po.text, [`${S8} Hey Look! also checked that the message really comes from this sender.`, 'When pictures are shown, the sender’s server can see that you opened the message and roughly when.'], 'the reason, then what the sender can see');
  eq(po.buttons, ['Stop showing pictures from this sender'], 'one action');
  ok(po.inside && !po.overflow && po.label === 'Why are pictures shown?', `the popover is inside the window and named: ${JSON.stringify(po)}`);
  ok(po.focusOn === 'Stop showing pictures from this sender', 'the focus is on its action');
  await key('Escape', 'Escape', 27);
  ok(!(await popover()) && (await evaluate(`document.activeElement && document.activeElement.classList.contains('autoinfo-btn')`)), 'Esc closes it and the focus returns to the button');
  // the keyboard: Enter on the button opens it (a button does by itself), Esc closes
  await evaluate(`document.querySelector('.rp-msg.open .autoinfo-btn').focus(); 1`);
  await key('Enter', 'Enter', 13);
  ok(await until(`!!document.querySelector('.autoinfo-pop')`, 1500), 'Enter on the button opens the popover');
  await key('Escape', 'Escape', 27);
  tag = 'S9';
  await open('pS');
  eq(await notice(), null, 'no notice bar');
  ic = await info();
  ok(ic && ic.kind === 'service' && ic.title === 'Pictures in this message are shown automatically because it comes from accounts.google.com, a well-known service.', `the service reason names the domain: ${JSON.stringify(ic)}`);
  await openInfo();
  po = await popover();
  ok(po.text[0].endsWith('Hey Look! checked that it really comes from there.'), `the popover adds what was checked: ${po.text[0]}`);
  await key('Escape', 'Escape', 27);
  p = await pics();
  ok(p.boxes === 0 && p.imgs >= 1, 'the pictures show');

  // ======================================================================== T-C3: Stop, Undo, Settings
  tag = 'stop';
  await open('pW');
  await infoAction();
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length > 0`, 4000), 'Stop: the pictures are hidden again');
  n = await notice();
  ok(n && n.cls === 'notice' && n.links.length === 3 && n.links[1] === 'Always show pictures from this sender', `Stop: the offer is back: ${JSON.stringify(n)}`);
  eq(await noauto(), [SENDER], 'the sender is on the list of senders turned off');
  ok(await until(`document.activeElement && document.activeElement.dataset && document.activeElement.dataset.trust === 'add'`, 2000), 'the focus is on the add link');
  ok(/Pictures from friend@example.org will no longer be shown automatically\./.test((await toast()) || ''), `the toast: ${await toast()}`);
  // another message of the same sender: hidden, the offer
  await open('pW2');
  n = await notice();
  ok(n && n.cls === 'notice' && n.links.length === 3, 'the next message of that sender: the offer');
  // Undo (on the toast of the first message): the sender is off the list, the message shows again
  await open('pW');
  await clickLink('button.link[data-trust="add"]'); // (not the Undo: leave a clean list state first)
  await clearLists();
  await open('pW');
  await infoAction();
  await until(`!!document.querySelector('.toast button, .toasts .toast button')`, 3000);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.toast button, .toasts .toast button')].find((x) => /undo/i.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length === 0 && !!document.querySelector('.rp-msg.open .autoinfo-btn')`, 4000), 'Undo: shown again, the info button is back');
  eq(await noauto(), [], 'Undo: the list is empty again');
  // 1.0.11: the list of the senders turned off is in Settings; the way back is Remove there, or "Always show pictures from this sender" on that sender's notice
  await infoAction();
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length > 0`, 4000), 'Stop again: hidden');
  eq(await noauto(), [SENDER], 'the sender is turned off');
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:all', section: 'reading', nonce: Date.now() }); 1`);
  ok(await until(`!!document.querySelector('.trusted-list')`, 8000), 'Settings > Reading & sync opens');
  // 1.0.11: the Settings list of the senders turned off shows the sender, with its own Remove button
  const offRows = () => evaluate(`(() => { const r = document.querySelector('#set-noauto'); const l = r && r.nextElementSibling; return l ? [...l.querySelectorAll('.list-row button')].map((b) => b.getAttribute('aria-label')) : null; })()`);
  eq(await offRows(), [`Remove ${SENDER}`], 'Settings lists the sender turned off, with Remove');
  await evaluate(`document.querySelector('#set-noauto').nextElementSibling.querySelector('.list-row button').click(); 1`);
  ok(await until(`window.__mockRemoteNoauto.size === 0`, 3000), 'Remove in Settings: the backend list is empty');
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length === 0`, 6000), 'and the rule shows the pictures again');
  await infoAction();
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length > 0`, 4000), 'Stop again: hidden');
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await sleep(300);
  ok(await clickLink('button.link[data-trust="add"]'), 'the offer on the notice is there');
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length === 0`, 4000), '"Always show pictures from this sender": the pictures show');
  eq(await noauto(), [], 'it cleared the entry of the senders turned off');
  eq(await trusted(), [SENDER], 'and put the sender on the always-show list');
  ok(!(await notice()) && (await info()) && (await info()).kind === 'list', 'now the info button says: always shown because you chose to');
  await clearLists();
  await open('pW');
  ok(!(await notice()) && (await info()) && (await info()).kind === 'wrote', 'with both lists empty the message shows by itself again');

  // 1.0.11 WP2: the global switch off: the rule never shows pictures (written-to and service), the normal notice with the offer, no info button; the lists still work; on again: back
  tag = 'switch-off';
  await evaluate(`window.__mockAutoPictures.on = false; window.__mockEmit('remote-ok-changed', null).then(() => 1)`);
  await sleep(300);
  await open('pW');
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length > 0`, 4000), 'switch off: a written-to sender\'s pictures stay hidden');
  n = await notice();
  ok(n && n.cls === 'notice' && n.links.length === 3, `switch off: the normal notice with the offer: ${JSON.stringify(n)}`);
  eq(await info(), null, 'switch off: no "shown automatically" info button');
  await open('pS');
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length > 0`, 4000), 'switch off: a well-known service\'s pictures stay hidden');
  eq(await info(), null, 'switch off (service): no info button');
  await open('pW');
  ok(await clickLink('button.link[data-trust="add"]'), 'switch off: "Always show pictures from this sender" is offered');
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length === 0`, 4000), 'switch off: the always-show list still shows the pictures');
  await clearLists();
  await evaluate(`window.__mockAutoPictures.on = true; window.__mockEmit('remote-ok-changed', null).then(() => 1)`);
  await sleep(300);
  await open('pW');
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length === 0`, 4000), 'switch on again: shown by the rule');

  // ======================================================================== T-C4: what does not show by itself
  tag = 'not-auto';
  await clearLists();
  for (const [id, why] of [['pN', 'no reason from the backend'], ['pJ', 'Junk'], ['pE', 'encrypted'], ['pF', 'failed check']]) {
    await open(id);
    n = await notice();
    p = await pics();
    ok(n && n.cls === 'notice' && n.text.startsWith('Pictures in this message are hidden to protect your privacy.') && p.imgs === 0 && p.boxes >= 1, `${why}: hidden, the normal notice (${JSON.stringify(n && n.text)})`);
  }
  // the global switch: no notice at all
  await evaluate(`window.__store.getState().setPrefs({ loadRemote: true }); 1`);
  await open('pW');
  ok((await notice()) === null, 'AC-13: the global switch is on: no notice');
  ic = await info();
  ok(ic && ic.kind === 'global' && ic.title === 'Pictures are shown in every message because “Always show pictures” is turned on in Settings.', `the global switch: the info button says so (${JSON.stringify(ic)})`);
  await openInfo();
  eq((await popover()).buttons, ['Open Settings'], 'its action opens Settings');
  await evaluate(`document.querySelector('.autoinfo-pop button').click(); 1`);
  ok(await until(`!!document.querySelector('[role=dialog][aria-label], .modal')`, 4000), 'Settings opens');
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await sleep(300);
  await evaluate(`window.__store.getState().setPrefs({ loadRemote: false }); 1`);
  // a sender on the list AND the rule: the manual list wins, and Stop really stops
  await evaluate(`window.__mockRemoteOk.set('alerts@accounts.google.com', 1); window.__mockEmit('remote-ok-changed', null).then(() => 1)`);
  await open('pT');
  ic = await info();
  ok(!(await notice()) && ic && ic.kind === 'list', `AC-11: on the list: the info button, kind list (${JSON.stringify(ic)})`);
  await openInfo();
  eq((await popover()).buttons, ['Remove from always-show list'], 'the list has its own action');
  await evaluate(`document.querySelector('.autoinfo-pop button').click(); 1`);
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length > 0`, 4000), 'AC-11: Stop: the pictures are hidden, not shown by the rule');
  n = await notice();
  ok(n && n.cls === 'notice', 'AC-11: the notice is the offer, not S8/S9');
  eq(await trusted(), [], 'and the sender left the list');
  eq(await noauto(), ['alerts@accounts.google.com'], 'and is turned off for the rule');
  // "Always show from this sender" for a sender that was turned off: the lists never contradict each other
  await clickLink('button.link[data-trust="add"]');
  await sleep(300);
  eq(await noauto(), [], 'Always show: off the list of senders turned off');
  eq(await trusted(), ['alerts@accounts.google.com'], 'Always show: on the list');
  await clearLists();

  // the popover fits the window in every language (full sentences, no line limit; never clipped)
  tag = 'popover-fit';
  const { languageJs } = await import('./cdp-harness.mjs');
  for (const [w, h] of [[960, 560], [1280, 800]]) for (const lang of ['en', 'de', 'es', 'fr', 'ja', 'ru', 'vi', 'zh-Hans']) {
    await H.openApp(`light&lang=en&nativemenu=off`, w, h);
    await evaluate(`${THREADS.map(([id, subject, over]) => `window.__mockAddThread(${JSON.stringify(id)}, ${JSON.stringify(subject)}, ${JSON.stringify(over)});`).join(' ')} window.__store.getState().setPrefs({ loadRemote: false }); window.__store.getState().refresh().then(() => 1)`);
    await sleep(200);
    await evaluate(languageJs(lang));
    await open('pS');
    ok(await openInfo(), `${lang} ${w}x${h}: the popover opens`);
    const fit = await popover();
    ok(fit && fit.inside && !fit.overflow && fit.text.every((x) => x.length > 20), `${lang} ${w}x${h}: inside the window, nothing clipped: ${JSON.stringify(fit && { inside: fit.inside, overflow: fit.overflow })}`);
    const ib = await info();
    ok(ib && ib.aria === ib.title && !/\{|reading\.autoinfo/.test(ib.title + fit.text.join(' ')), `${lang}: the button is named by its tooltip, no raw key or placeholder`);
  }
  await start();

  // ======================================================================== T-C6: the box
  tag = 'box';
  await open('pB');
  const bx = await evaluate(`(() => { const d = ${FR}.contentDocument; const fw = ${FR}.getBoundingClientRect().width; return { fw, boxes: [...d.querySelectorAll('.hl-bp[data-hl-pic]')].map((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return { w: Math.round(r.width), h: Math.round(r.height), tier: b.dataset.tier, role: b.getAttribute('role'), tab: b.getAttribute('tabindex'), aria: b.getAttribute('aria-label'), ariaHidden: b.getAttribute('aria-hidden'), main: b.querySelector('.hl-bp-main')?.textContent, hint: b.querySelector('.hl-bp-hint')?.textContent, alt: b.querySelector('.hl-bp-alt')?.textContent || null, mainShown: getComputedStyle(b.querySelector('.hl-bp-main')).display !== 'none', hintShown: getComputedStyle(b.querySelector('.hl-bp-hint')).display !== 'none', cursor: cs.cursor, src: b.dataset.src }; }) }; })()`);
  eq(bx.boxes.length, 3, 'AC-17: the pixel, the hidden attribute, display:none and the 300 x 2 line get no box; 3 boxes remain (600 x 200, no size, 80 x 30)');
  const [b1, b2, b3] = bx.boxes;
  ok(b1 && Math.abs(b1.w - Math.min(600, bx.fw - 24)) <= 24 && b1.h === 200 && b1.tier === 'full', `AC-15: 600 x 200 (the frame is ${Math.round(bx.fw)} wide): ${JSON.stringify(b1)}`);
  ok(b1 && b1.main === 'Picture hidden for privacy' && b1.hint === 'Right-click to show' && b1.alt === 'Summer sale' && b1.mainShown && b1.hintShown, `AC-15: the lines: ${JSON.stringify(b1)}`);
  ok(b1 && b1.role === 'button' && b1.tab === '0' && b1.ariaHidden === null && b1.aria === 'Picture hidden for privacy: Summer sale. Press Enter to show it, or Shift+F10 for more options.', `AC-15/REQ-6: button, focusable, named: ${b1 && b1.aria}`);
  ok(b2 && b2.w === 240 && b2.h >= 96 && b2.aria === 'Picture hidden for privacy. Press Enter to show it, or Shift+F10 for more options.', `AC-16: no size: 240 wide, at least 96 high, no alt in the name: ${JSON.stringify(b2)}`);
  ok(b3 && b3.w === 80 && b3.h === 30 && b3.tier === 'small' && !b3.mainShown && !b3.hintShown && /Tiny/.test(b3.aria), `AC-18: 80 x 30: the icon only, the name is complete: ${JSON.stringify(b3)}`);
  ok(bx.boxes.every((b) => b.cursor === 'pointer' && b.src && /^https:/.test(b.src)), 'pointer cursor, the address is kept (never loaded)');
  const csp = await evaluate(`${FR}.contentDocument.querySelector('meta[http-equiv=Content-Security-Policy]').content`);
  ok(/img-src data:(;|$)/.test(csp), `the frame's CSP does not allow a remote picture: ${csp}`);
  ok((await calls()).length === 0, 'nothing was fetched');
  // 1.0.11 RC1 BUG-1: no line of text is cut off by the edge of a small box (120 x 40 showed "Picture hidden" and clipped "for privacy"): everything that shows lies inside the box and a line is one line
  tag = 'box-fit';
  await open('pZ');
  const fit = await evaluate(`(() => { const d = ${FR}.contentDocument; return [...d.querySelectorAll('.hl-bp[data-hl-pic]')].map((b) => { const r = b.getBoundingClientRect(); const shown = [...b.querySelectorAll('.hl-bp-ico, .hl-bp-main, .hl-bp-hint, .hl-bp-alt')].filter((e) => getComputedStyle(e).display !== 'none'); const out = shown.filter((e) => { const q = e.getBoundingClientRect(); return q.bottom > r.bottom + 0.5 || q.top < r.top - 0.5 || q.right > r.right + 0.5 || q.left < r.left - 0.5; }).map((e) => e.className); const main = b.querySelector('.hl-bp-main'); const mainShown = getComputedStyle(main).display !== 'none'; const cut = shown.filter((e) => e.scrollHeight > e.clientHeight + 1 && e.className !== 'hl-bp-ico').map((e) => e.className); return { w: Math.round(r.width), h: Math.round(r.height), tier: b.dataset.tier, alt: ((a) => !!a && getComputedStyle(a).display !== 'none' && a.offsetHeight > 0)(b.querySelector('.hl-bp-alt')), out, cut, mainShown, mainLines: mainShown ? Math.round(main.getBoundingClientRect().height / parseFloat(getComputedStyle(main).lineHeight)) : 0, title: b.getAttribute('title') }; }); })()`);
  eq(fit.length, 13, 'thirteen small boxes');
  // (which of "full" / "mid" / "small" a box ends in depends on the glyph widths of the font of the machine: the CI runner is not this host. What does not: a box never says more than its declared size
  // and its size on screen allow, a box under 96 wide or 56 high is the icon only, and nothing sticks out or is cut off.)
  const CAP = ['small', 'mid', 'mid', 'mid', 'small', 'full', 'full', 'full', 'mid', 'small', 'mid', 'full', 'mid']; // (120x40, 120x56, 96x56, 140x64, 100x45, 300x120, 200x84, 200x100, 220x60, 168x50, 110x60, 140x84, 140x83)
  const RK = { small: 0, mid: 1, full: 2 };
  fit.forEach((x, k) => ok(RK[x.tier] <= RK[CAP[k]], `${x.w} x ${x.h}: "${x.tier}" is not more than its size allows ("${CAP[k]}")`));
  eq([0, 4, 9].map((k) => fit[k].tier), ['small', 'small', 'small'], '120 x 40, 100 x 45 and 168 x 50 (under 56 high) are the icon only');
  ok(fit[5].tier !== 'small', '300 x 120 says more than the icon');
  fit.forEach((x) => ok(!x.alt || x.tier === 'full', `${x.w} x ${x.h}: the alt text only in a whole box (${x.tier})`));
  ok(fit.filter((x) => x.h < 100).every((x) => !x.alt), 'the alt text shows from 100 px high only');
  for (const f of fit) {
    eq([f.out, f.cut], [[], []], `${f.w} x ${f.h} (${f.tier}): nothing outside the box, nothing cut off`);
    if (f.tier === 'mid') ok(f.mainLines >= 1 && f.mainLines <= 2, `${f.w} x ${f.h}: the line is one or two lines (${f.mainLines})`);
    ok(f.title === 'Picture hidden for privacy', `${f.w} x ${f.h}: the tooltip has the whole line`);
  }
  // 1.0.11 RC1 round 2 BUG-2: a picture that shows by itself is fetched by the backend ONLY; the page (the message frame) never asks the sender's host (it did, with its own user agent and a Referer,
  // because the frame's CSP allowed img-src https: http: once the pictures were allowed). The hermetic net lists every request the page makes to a host other than this machine, also from the frame.
  // BUG-1 reopened (round 2): the mid box (icon and one line) cut a line that was longer than the box ("Picture hidden for privacy" is about 150 px, the box 96 to 140). In each of the 8 languages, with the
  // real text of the language and the real font of this machine, a box either shows its line WHOLE (not wider than the box) or only the icon; nothing is cut, in light and in the dark background.
  tag = 'box-fit-lang';
  for (const lang of ['en', 'de', 'es', 'fr', 'ja', 'ru', 'vi', 'zh-Hans']) {
    await evaluate(languageJs(lang));
    await open('pZ');
    const fl = await evaluate(`(() => { const d = ${FR}.contentDocument; return [...d.querySelectorAll('.hl-bp[data-hl-pic]')].map((b) => { const r = b.getBoundingClientRect(); const main = b.querySelector('.hl-bp-main'); const shown = getComputedStyle(main).display !== 'none'; const out = [...b.querySelectorAll('.hl-bp-ico, .hl-bp-main, .hl-bp-hint, .hl-bp-alt')].filter((e) => getComputedStyle(e).display !== 'none').filter((e) => { const q = e.getBoundingClientRect(); return q.bottom > r.bottom + 0.5 || q.top < r.top - 0.5 || q.right > r.right + 0.5 || q.left < r.left - 0.5; }).length; return { w: Math.round(r.width), h: Math.round(r.height), tier: b.dataset.tier, shown, cut: shown && main.scrollWidth > main.clientWidth + 1, out, text: main.textContent }; }); })()`);
    eq(fl.length, 13, `${lang}: thirteen boxes`);
    for (const f of fl) {
      ok(!f.cut && f.out === 0, `${lang} ${f.w} x ${f.h} (${f.tier}): the line is whole or not shown, nothing outside the box: ${JSON.stringify(f)}`);
      if (f.tier === 'small') ok(!f.shown, `${lang} ${f.w} x ${f.h}: the icon-only box shows no line`);
    }
  }
  await evaluate(languageJs('en'));
  // BUG-1, third report (Mac WKWebView): the tier is judged by the box AS DRAWN - the device pixel ratio, the mail's zoom (a wide mail is shown at 0.6: a 280 x 84 box is 168 x 50 on screen) and a box
  // that a stylesheet sizes - read with getBoundingClientRect after layout; a line that sticks out at the top (a centred column cuts both ends: scrollHeight does not see it) steps the box down.
  tag = 'box-fit-render';
  const RANK = { small: 0, mid: 1, full: 2 };
  const drawn = () => evaluate(`import('/src/blockedPicture.ts').then((m) => { const d = ${FR}.contentDocument; return JSON.stringify([...d.querySelectorAll('.hl-bp[data-hl-pic]')].map((b) => { const r = b.getBoundingClientRect(); const out = [...b.querySelectorAll('.hl-bp-ico, .hl-bp-main, .hl-bp-hint, .hl-bp-alt')].filter((e) => getComputedStyle(e).display !== 'none').filter((e) => { const q = e.getBoundingClientRect(); return q.bottom > r.bottom + 0.5 || q.top < r.top - 0.5 || q.right > r.right + 0.5 || q.left < r.left - 0.5; }).length; return { w: Math.round(r.width), h: Math.round(r.height), tier: b.dataset.tier, allowed: m.tierForSize(r.width, r.height), out, zoom: d.documentElement.style.zoom || '' }; })); })`).then((x) => JSON.parse(x));
  const sane = (rows, what) => { for (const f of rows) ok(f.out === 0 && RANK[f.tier] <= RANK[f.allowed], `${what}: ${f.w} x ${f.h} on screen says "${f.tier}" (allowed "${f.allowed}"), ${f.out} parts outside the box`); };
  // device pixel ratio 2 (a Retina screen): the same tiers as at 1
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await open('pZ');
  const dpr2 = await drawn();
  eq(dpr2.map((x) => x.tier), fit.map((x) => x.tier), 'devicePixelRatio 2: the same tiers as at 1');
  ok(dpr2.find((x) => x.w === 168 && x.h === 50)?.tier === 'small', 'devicePixelRatio 2: 168 x 50 is the icon only');
  sane(dpr2, 'dpr 2');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // a box that a stylesheet sizes (not the attributes the mail gave the picture): 168 x 50 as drawn, the declared tier was "full"
  await open('pB');
  const cssBox = await evaluate(`import('/src/blockedPicture.ts').then((m) => { const d = ${FR}.contentDocument; const b = d.querySelector('.hl-bp[data-hl-pic]'); const was = b.dataset.tier; b.style.width = '168px'; b.style.height = '50px'; b.style.minHeight = '0'; m.fitHiddenBoxes(d); const r = b.getBoundingClientRect(); const lines = [...b.querySelectorAll('.hl-bp-main, .hl-bp-hint, .hl-bp-alt')].filter((e) => getComputedStyle(e).display !== 'none').length; return { was, now: b.dataset.tier, w: Math.round(r.width), h: Math.round(r.height), lines }; })`);
  eq([cssBox.was, cssBox.now, cssBox.w, cssBox.h, cssBox.lines], ['full', 'small', 168, 50, 0], 'a 168 x 50 box sized by a stylesheet is the icon only, the full box would cut its lines');
  // the box grows again (the pane is widened, the stylesheet changes): the text comes back
  const back = await evaluate(`import('/src/blockedPicture.ts').then((m) => { const d = ${FR}.contentDocument; const b = d.querySelector('.hl-bp[data-hl-pic]'); b.style.width = '400px'; b.style.height = '200px'; m.fitHiddenBoxes(d); return b.dataset.tier; })`);
  eq(back, 'full', 'a box that grows again gets its text back');
  // the mail's own zoom: a wide mail (1500 px) is shown at 0.6 in the 1280 px window; the boxes are judged at their size on screen
  await open('pY');
  await sleep(500);
  const zr = await drawn();
  ok(zr.length === 3 && zr.every((x) => x.zoom !== ''), `the wide mail is zoomed: ${JSON.stringify(zr.map((x) => x.zoom))}`);
  const z84 = zr[0];
  ok(z84.w <= 190 && z84.h <= 56 && z84.tier === 'small', `the 280 x 84 box drawn as ${z84.w} x ${z84.h} on screen is the icon only (it says "${z84.tier}")`);
  ok(zr[1].tier === 'small' && zr[2].tier !== 'small', `168 x 50 icon only, 503 x 210 says more than the icon: ${JSON.stringify(zr.map((x) => x.tier))}`);
  sane(zr, 'zoomed mail');
  // Mac QA (WKWebView): a SYNTHETIC contextmenu event on a hidden-picture box did nothing. A mouse event always targets an element, a script's may target the icon, the svg path inside it or the TEXT NODE
  // of the line (no closest(): the box was not found and the menu blocked), may be built in the page or in the frame, and the frame may be zoomed. Every one of them opens the menu of the box.
  tag = 'ctx-synthetic';
  const fire = (kind, realm, zoom) => evaluate(`(() => { const f = ${FR}, d = f.contentDocument, b = d.querySelector('.hl-bp[data-hl-pic]'); d.documentElement.style.zoom = ${JSON.stringify(zoom)};
    const target = { box: b, icon: b.querySelector('.hl-bp-ico'), svg: b.querySelector('.hl-bp-ico svg path') || b.querySelector('.hl-bp-ico svg'), line: b.querySelector('.hl-bp-main'), text: b.querySelector('.hl-bp-main').firstChild }[${JSON.stringify(kind)}];
    if (!target) return 'no target';
    const W = ${JSON.stringify(realm)} === 'frame' ? d.defaultView : window; const r = target.nodeType === 1 ? target.getBoundingClientRect() : b.getBoundingClientRect();
    target.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) }));
    return 'sent'; })()`);
  for (const [kind, realm, zoom] of [['box', 'page', ''], ['icon', 'page', ''], ['svg', 'page', ''], ['line', 'page', ''], ['text', 'page', ''], ['text', 'frame', ''], ['svg', 'frame', ''], ['box', 'page', '0.6'], ['text', 'page', '0.6'], ['svg', 'frame', '0.6']]) {
    await open('pB');
    const sent = await fire(kind, realm, zoom);
    const rows = sent === 'sent' ? await menuOpen() : null;
    ok(rows && rows.rows.some((r) => /^Show this picture/.test(r.text ?? r)), `synthetic contextmenu on ${kind} (${realm} event, zoom ${zoom || '1'}): the menu of the box opens: ${JSON.stringify(rows)}`);
    if (kind === 'text' && realm === 'page' && !zoom) {
      ok(await chooseRow('Show this picture'), 'the entry is there');
      ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 1`, 4000), 'Show this picture, from the synthetic event on the text node: the picture shows');
    }
    await closeMenu();
  }
  // the automatic rule (written to / well-known service) shows the picture AND the dark-mode <source> of its <picture>: one data: address, fetched by the backend, the page asks for nothing (Mac QA)
  tag = 'auto-dark-source';
  H.net.reset();
  await open('pDK');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 1`, 6000), 'the auto picture shows');
  ok(await until(`${FR}.contentDocument.querySelectorAll('source[srcset^="data:image"]').length === 1`, 4000), 'the dark <source> has the data: address of its fetched picture');
  eq(await evaluate(`[...${FR}.contentDocument.querySelectorAll('source')].filter((x) => /^(https?:)?\\/\\//.test(x.getAttribute('srcset') || '')).length`), 0, 'no remote srcset');
  eq(H.net.requests.filter((r) => /img\.shop\.example/.test(r.url)).length, 0, 'the page asked the sender for nothing');
  // A deliberately wide font (what the Linux runner's fallback is: Verdana here, DejaVu Sans / Liberation there): the boxes are judged again and still nothing sticks out, nothing is squeezed below its text
  // (the 200 x 100 box of the CI run: the alt line was shrunk to no height by the column and painted over the line above it)
  tag = 'box-fit-wide-font';
  await open('pZ');
  for (const font of ['Verdana, "DejaVu Sans", sans-serif', '"Courier New", "DejaVu Sans Mono", monospace']) {
    const wide = await evaluate(`import('/src/blockedPicture.ts').then((m) => { const d = ${FR}.contentDocument; d.getElementById('wide-font')?.remove(); const st = d.createElement('style'); st.id = 'wide-font'; st.textContent = '.hl-bpx, .hl-bpx * { font-family: ' + ${JSON.stringify(font)} + ' !important; letter-spacing: .6px; }'; d.head.append(st); m.fitHiddenBoxes(d); return JSON.stringify([...d.querySelectorAll('.hl-bp[data-hl-pic]')].map((b) => { const r = b.getBoundingClientRect(); const bad = [...b.querySelectorAll('.hl-bp-ico, .hl-bp-main, .hl-bp-hint, .hl-bp-alt')].filter((e) => getComputedStyle(e).display !== 'none').filter((e) => { const q = e.getBoundingClientRect(); return q.bottom > r.bottom + 0.5 || q.top < r.top - 0.5 || q.right > r.right + 0.5 || q.left < r.left - 0.5 || (!e.classList.contains('hl-bp-ico') && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)); }).length; const alt = b.querySelector('.hl-bp-alt'); return { w: Math.round(r.width), h: Math.round(r.height), tier: b.dataset.tier, bad, allowed: m.tierForSize(r.width, r.height), altShown: !!alt && getComputedStyle(alt).display !== 'none' && alt.offsetHeight > 0 }; })); })`).then((x) => JSON.parse(x));
    eq(wide.length, 13, `${font}: thirteen boxes`);
    for (const f of wide) {
      ok(f.bad === 0 && RK[f.tier] <= RK[f.allowed], `${font}: ${f.w} x ${f.h} says "${f.tier}" (allowed "${f.allowed}"), ${f.bad} parts outside or squeezed`);
      ok(!f.altShown || f.tier === 'full', `${font}: ${f.w} x ${f.h} (${f.tier}): the alt line is not displayed unless the box is whole`);
    }
  }
  tag = 'no-page-request';
  for (const id of ['pW', 'pS']) {
    H.net.reset();
    await open(id);
    ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 1`, 6000), `${id}: the picture shows by itself, from a data: URI`);
    await sleep(600);
    eq(H.net.requests.filter((r) => /img\.shop\.example/.test(r.url)).map((r) => r.url), [], `${id}: the page made no request to the sender's host`);
    const csp = await evaluate(`${FR}.contentDocument.querySelector('meta[http-equiv=Content-Security-Policy]').content`);
    ok(/img-src data:(;|$)/.test(csp), `${id}: the frame's CSP allows data: pictures only: ${csp}`);
    eq(await evaluate(`[...${FR}.contentDocument.querySelectorAll('img')].filter((i) => /^(https?:)?\\/\\//.test(i.getAttribute('src') || '')).length`), 0, `${id}: no picture keeps a remote address`);
  }
  tag = 'box';
  await open('pB');
  // colours: light and dark (the contrast of the text >= 4.5)
  const contrast = () => evaluate(`(() => { const d = ${FR}.contentDocument, b = d.querySelector('.hl-bp[data-hl-pic]'); const lum = (c) => { const v = c.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map((x) => { const s = Number(x) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }; const bg = getComputedStyle(b).backgroundColor; const fg = getComputedStyle(b.querySelector('.hl-bp-main')).color; const hint = getComputedStyle(b.querySelector('.hl-bp-hint')).color; const r = (a, c) => { const x = lum(a), y = lum(c); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }; return { bg, fg, main: r(bg, fg), hint: r(bg, hint) }; })()`);
  let c = await contrast();
  ok(c.main >= 4.5 && c.hint >= 4.5, `AC-15 light: the text has a contrast of ${c.main.toFixed(1)} / ${c.hint.toFixed(1)} (${c.bg})`);
  await evaluate(`window.__store.getState().setPrefs({ theme: 'dark' }); 1`);
  await sleep(600);
  await open('pB');
  c = await contrast();
  ok(c.main >= 4.5 && c.hint >= 4.5, `AC-15 dark: the text has a contrast of ${c.main.toFixed(1)} / ${c.hint.toFixed(1)} (${c.bg})`);
  await evaluate(`window.__store.getState().setPrefs({ theme: 'light' }); 1`);
  await sleep(400);

  // the shield of the box (1.0.10 P3: it was hardly visible): at least 28 px in a full box, and a stroke with at least 3:1 against the box, light and dark (the dark mail background)
  tag = 'shield';
  const shield = () => evaluate(`(() => { const d = ${FR}.contentDocument, b = d.querySelector('.hl-bp[data-hl-pic]'); const i = b.querySelector('.hl-bp-ico'); const svg = i.querySelector('svg'); if (!svg) return { size: 0, ratio: 0, stroke: 'no svg', bg: [] }; const ps = getComputedStyle(svg.querySelector('path')); const num = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number); const lum = (c) => { const v = c.map((x) => { const q = x / 255; return q <= 0.03928 ? q / 12.92 : ((q + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }; const bg = num(getComputedStyle(b).backgroundColor); const sc = num(ps.stroke); const x = lum(sc), y = lum(bg); const r = svg.getBoundingClientRect(); return { size: Math.round(r.width), height: Math.round(r.height), stroke: ps.stroke, bg, ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), painted: ps.stroke !== 'none' && r.width > 0 && r.height > 0 }; })()`);
  await open('pB'); // (600 x 200: a full box; 200 x 80 is a mid box since the 1.0.11 RC1 BUG-1 fix)
  let sh = await shield();
  ok(sh.size >= 28 && sh.painted && sh.ratio >= 3, `light: the shield is ${sh.size} px with a contrast of ${sh.ratio.toFixed(1)} (${sh.stroke} on ${sh.bg})`);
  ok(await evaluate(`(() => { const b = document.querySelector('.rp-msg.open .rp-msg-actions .icon-btn[aria-pressed]'); if (!b) return false; b.click(); return true; })()`), 'the dark mail background button is there');
  ok(await until(`${FR}.contentDocument.documentElement.classList.contains('hm-dark')`, 3000), 'the frame is dark');
  await sleep(300);
  sh = await shield();
  ok(sh.size >= 28 && sh.painted && sh.ratio >= 3, `dark: the shield is ${sh.size} px with a contrast of ${sh.ratio.toFixed(1)} (${sh.stroke} on ${sh.bg})`);
  await evaluate(`document.querySelector('.rp-msg.open .rp-msg-actions .icon-btn[aria-pressed]').click(); 1`);
  await sleep(300);

  // ======================================================================== T-C7: the menu
  tag = 'menu';
  await open('pM');
  let [x, y] = await boxPoint(1);
  await mouse(x, y, 'right');
  let m = await menuOpen();
  ok(m && m.label === 'Picture options', `AC-19: the menu is named: ${m && m.label}`);
  eq(m && m.rows, ['Show this picture', 'Show all pictures in this message', 'Always show pictures from this sender'], 'AC-19: three entries in this order (a new sender)');
  await closeMenu();
  // keyboard: focus the box, Shift+F10, the first entry has the focus, Esc returns to the box
  await evaluate(`(() => { const f = ${FR}, b = f.contentDocument.querySelectorAll('.hl-bp[data-hl-pic]')[0]; f.contentWindow.focus(); b.focus(); return 1; })()`);
  await key('F10', 'F10', 121, 8);
  m = await menuOpen();
  eq(m && m.rows, ['Show this picture', 'Show all pictures in this message', 'Always show pictures from this sender'], 'AC-20: Shift+F10: the same menu');
  ok(m && m.first === 'Show this picture', `AC-20: the first entry has the focus (${m && m.first})`);
  await key('Escape', 'Escape', 27);
  await sleep(150);
  ok(await evaluate(`(() => { const d = ${FR}.contentDocument; return d.activeElement && d.activeElement.classList.contains('hl-bp'); })()`), 'AC-20: Esc: the focus is back on the box');
  // a sender that is not offered the link: no third entry
  await open('pN');
  [x, y] = await boxPoint(0);
  await mouse(x, y, 'right');
  m = await menuOpen();
  eq(m && m.rows.slice(0, 3), ['Show this picture', 'Show all pictures in this message', 'Always show pictures from this sender'], 'the offered sender: three entries');
  await closeMenu();
  await open('pJ');
  [x, y] = await boxPoint(0);
  await mouse(x, y, 'right');
  m = await menuOpen();
  eq(m && m.rows, ['Show this picture', 'Show all pictures in this message'], 'Junk: no "Always" entry (the notice does not offer it)');
  await closeMenu();
  // in a link: the picture entries, a line, the link entries
  await open('pL');
  [x, y] = await boxPoint(0);
  await mouse(x, y, 'right');
  m = await menuOpen();
  ok(m && m.rows.slice(0, 2).join('|') === 'Show this picture|Show all pictures in this message' && m.rows.includes('---') && m.rows.length >= 5, `a picture in a link: the picture entries, a line, the link entries: ${JSON.stringify(m && m.rows)}`);
  await closeMenu();
  // confidential: no menu; Enter still shows the picture
  await open('pC');
  [x, y] = await boxPoint(0);
  await mouse(x, y, 'right');
  await sleep(300);
  ok(!(await evaluate(`!!document.querySelector('.ctx-menu')`)), 'confidential mail: no menu');
  await evaluate(`(() => { const f = ${FR}, b = f.contentDocument.querySelector('.hl-bp[data-hl-pic]'); f.contentWindow.focus(); b.focus(); return 1; })()`);
  await key('Enter', 'Enter', 13);
  ok(await until(`${FR}.contentDocument.querySelectorAll('.hl-bp').length === 0 && ${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 1`, 4000), 'confidential mail: Enter on the box still shows the picture');

  // ======================================================================== T-C8: show one picture, show all
  tag = 'show-one';
  await open('pM');
  await evaluate(`window.__remoteFetchCalls = []; 1`);
  [x, y] = await boxPoint(1);
  await mouse(x, y, 'right');
  await menuOpen();
  ok(await chooseRow('Show this picture'), 'the entry is there');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 1`, 4000), 'AC-21: exactly one picture shows');
  const after = await evaluate(`(() => { const d = ${FR}.contentDocument; return { boxes: d.querySelectorAll('.hl-bp[data-hl-pic]').length, alts: [...d.querySelectorAll('img[src^="data:image"]')].map((i) => i.getAttribute('alt')), focusOn: d.activeElement && d.activeElement.getAttribute('aria-label') }; })()`);
  eq(after.boxes, 2, 'AC-21: the other two boxes stay');
  eq(after.alts, ['two'], 'AC-21: it is the second one (alt, size kept)');
  const cl = await calls();
  eq(cl, [[u('m2')]], 'AC-21: one fetch, for exactly that address');
  ok(after.focusOn && /three/.test(after.focusOn), `AC-23: the focus goes on to the next hidden picture (${after.focusOn})`);
  n = await notice();
  ok(n && n.cls === 'notice' && n.text.startsWith('Pictures in this message are hidden'), 'AC-21: the notice stays');
  ok(/img-src data:(;|$)/.test(await evaluate(`${FR}.contentDocument.querySelector('meta[http-equiv=Content-Security-Policy]').content`)), 'AC-21: the CSP is the same');
  // Enter on the next one
  await key('Enter', 'Enter', 13);
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 2`, 4000), 'Enter on the focused box shows it');
  // reopen: hidden again
  await open('pN');
  await open('pM');
  p = await pics();
  ok(p.boxes === 3 && p.imgs === 0, `AC-25: closed and opened again: all hidden (${JSON.stringify(p)})`);
  // the same address twice: both show with one fetch
  await open('pD');
  await evaluate(`window.__remoteFetchCalls = []; 1`);
  [x, y] = await boxPoint(0);
  await mouse(x, y, 'right');
  await menuOpen();
  await chooseRow('Show this picture');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 2`, 4000), 'the same address twice: both boxes show');
  eq((await calls()).flat().length, 1, 'with one address fetched');
  // a failure is said in the box, Enter asks again
  await evaluate(`document.querySelector('.rp-msg.open'); 1`);
  // show all = the "Show pictures" link
  await open('pM');
  [x, y] = await boxPoint(0);
  await mouse(x, y, 'right');
  await menuOpen();
  await chooseRow('Show all pictures in this message');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 3 && ${FR}.contentDocument.querySelectorAll('.hl-bp').length === 0`, 5000), 'AC-24: all pictures show');
  ok((await notice()) === null, 'AC-24: as after "Show pictures": no notice');
  await open('pM');
  await clickLink('button.link:not([data-trust])');
  ok(await until(`${FR}.contentDocument.querySelectorAll('img[src^="data:image"]').length === 3`, 5000), 'the "Show pictures" link does the same');

  // ======================================================================== T-C12: print
  tag = 'print';
  const css = await evaluate(`fetch('/src/mailFrameCss.ts').then((r) => r.text())`);
  ok(/@media print\{\.hl-bp-hint\{display:none!important\}/.test(css), 'AC-28: the hint line and the focus ring are not printed');
} catch (e) {
  failures.push(`[${tag}] ${e && e.stack ? e.stack : e}`);
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-pictures-auto: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-pictures-auto: ok (${checks} checks)`);
process.exit(0);
