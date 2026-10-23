#!/usr/bin/env node
// 1.0.7 W13.2 (REQ-13.2.2 to 13.2.8): the dot and the bolder name for a mailbox / folder that got new mail, in the side menu of the dev preview (src/devMock.ts has two mailboxes). The backend's
// `mail-arrived` is stood in by `__mockEmit("mail-arrived", ...)`; whether the window is "in front" is `document.hasFocus()` + visibility, which the test sets.
//   - an arrival for the other mailbox: its heading and Inbox row get the dot (`.fp-new`), the name 650, tooltip + hidden text "New mail"; the mailbox on screen is unchanged;
//   - opening the folder clears it; an arrival for the folder on screen while the window is in front marks nothing; with the window behind it marks, and the window coming forward clears;
//   - the icon column: the avatar ring and the title/aria "New mail"; a folder icon gets the 6 px dot;
//   - dark, forced colors (CanvasText), reduced motion; no blinking; the 8 languages have the text; nothing is stored (a reload starts with no markers).
//   node scripts/test-new-mail-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startHarness, languageJs } from './cdp-harness.mjs';

const H = await startHarness('test-new-mail-ui', { vitePort0: 5240 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(40); } return false; };
const arrive = (accountId, folder, ...threads) => evaluate(`window.__mockEmit('mail-arrived', ${JSON.stringify({ accountId, folders: [{ folder, threads }] })}); 1`).then(() => sleep(120));
const front = (on) => evaluate(`(() => { document.hasFocus = () => ${on}; return 1; })()`);
const marks = () => evaluate(`(() => { const s = window.__store.getState(); return Object.keys(s.newMail).sort(); })()`);
const dots = () => evaluate(`[...document.querySelectorAll('.fp-tree .fp-new')].map((d) => { const r = d.closest('.fp-row, .fp-head'); return (r.classList.contains('fp-head') ? 'head:' : 'row:') + (r.textContent || '').replace(/\\s+/g, ' ').trim(); })`);

try {
  await H.openApp('lang=en', 1280, 800);
  const ids = await evaluate(`window.__store.getState().accounts.map((a) => a.id)`);
  assert.ok(ids.length >= 2, 'the preview needs two mailboxes');
  const [A, B] = ids; // A is on screen (its Inbox), B is the other mailbox
  await front(true);
  await evaluate(`window.__store.getState().setView('inbox', ${JSON.stringify(A)}); 1`);
  await sleep(300);

  await check('nothing is marked at the start', async () => {
    assert.deepEqual(await marks(), []);
    assert.equal(await evaluate(`document.querySelectorAll('.fp-new').length`), 0);
  });

  await check('an arrival for the other mailbox marks its heading and its Inbox row, not the one on screen (AC-13.2.1)', async () => {
    await arrive(B, 'inbox', 't-new-1');
    assert.deepEqual(await marks(), [`${B}|inbox`]);
    const d = await dots();
    // the heading, the mailbox's Inbox row and the Favorites row of the all-mailboxes Inbox (Favorites rows of that folder show the same, REQ-13.2.5)
    assert.equal(d.length, 3, JSON.stringify(d));
    assert.ok(d.filter((x) => x.startsWith('head:')).length === 1 && d.filter((x) => x.startsWith('row:Inbox')).length === 2, JSON.stringify(d));
    const look = await evaluate(`(() => { const row = document.querySelector('.fp-row.fresh'), head = document.querySelector('.fp-head.fresh'); const dot = row.querySelector('.fp-new'); const cs = getComputedStyle(dot); const lbl = getComputedStyle(row.querySelector('.fp-lbl')); const acc = getComputedStyle(row.querySelector('.fp-lbl')).color; return { w: Math.round(dot.getBoundingClientRect().width), h: Math.round(dot.getBoundingClientRect().height), radius: cs.borderRadius, bg: cs.backgroundColor, weight: lbl.fontWeight, title: row.getAttribute('title'), sr: [...row.querySelectorAll('.sr-only')].map((e) => e.textContent), headSr: [...head.querySelectorAll('.sr-only')].map((e) => e.textContent), inbox: row.textContent, activeRow: document.querySelector('.fp-row.active')?.classList.contains('fresh') }; })()`);
    assert.deepEqual([look.w, look.h], [8, 8], 'an 8 px circle');
    assert.ok(/50%|4px/.test(look.radius), look.radius);
    assert.equal(look.weight, '650');
    assert.ok(/New mail/.test(look.title || ''), `tooltip: ${look.title}`);
    assert.deepEqual(look.sr, [', New mail']);
    assert.deepEqual(look.headSr, [', New mail']);
    assert.equal(look.activeRow, false, 'the Inbox on screen is not marked');
  });

  await check('the marker is a shape and a weight, it does not blink and it is not the selected look (REQ-13.2.7)', async () => {
    const r = await evaluate(`(() => { const dot = document.querySelector('.fp-row.fresh .fp-new'); const row = dot.closest('.fp-row'); const a = getComputedStyle(dot), rs = getComputedStyle(row); return { anim: a.animationName, iter: a.animationIterationCount, bgRow: rs.backgroundColor, before: getComputedStyle(row, '::before').content }; })()`);
    assert.notEqual(r.iter, 'infinite');
    assert.ok(r.bgRow === 'rgba(0, 0, 0, 0)' || r.bgRow === 'transparent', `a marked row has no background of its own: ${r.bgRow}`);
    assert.ok(r.before === 'none' || r.before === 'normal', `no left bar: ${r.before}`);
  });

  await check('opening the folder clears it (AC-13.2.2)', async () => {
    await evaluate(`document.querySelector('.fp-row.fresh').click(); 1`);
    await sleep(300);
    assert.deepEqual(await marks(), []);
    assert.equal(await evaluate(`document.querySelectorAll('.fp-new').length`), 0);
  });

  await check('an arrival for the folder on screen while the window is in front marks nothing; behind, it marks, and the window coming forward clears it (AC-13.2.2 / 13.2.3)', async () => {
    await arrive(B, 'inbox', 't-2');
    assert.deepEqual(await marks(), []);
    await front(false);
    await arrive(B, 'inbox', 't-3');
    assert.deepEqual(await marks(), [`${B}|inbox`]);
    await front(true);
    await evaluate(`window.dispatchEvent(new Event('focus')); 1`);
    await sleep(150);
    assert.deepEqual(await marks(), [], 'the window came forward with the folder on screen');
    // another mailbox's Inbox is on screen: the arrival for A marks it
    await evaluate(`window.__store.getState().setView('inbox', ${JSON.stringify(A)}); 1`);
    await sleep(200);
    await arrive(B, 'inbox', 't-4');
    assert.deepEqual(await marks(), [`${B}|inbox`]);
    await evaluate(`window.dispatchEvent(new Event('focus')); 1`);
    await sleep(150);
    assert.deepEqual(await marks(), [`${B}|inbox`], 'the window coming forward clears only the folder on screen');
  });

  await check('a folder of the person: marked, but it does not mark the mailbox (AC-13.2.4); the all-mailboxes Inbox clears every Inbox marker; the Unread view clears nothing', async () => {
    await evaluate(`window.__store.setState({ newMail: {} }); 1`);
    await arrive(B, 'f:Projects', 't-5');
    assert.deepEqual(await marks(), [`${B}|f:Projects`]);
    assert.equal(await evaluate(`document.querySelectorAll('.fp-head.fresh').length`), 0, 'only the Inbox marks the mailbox');
    await arrive(B, 'inbox', 't-6');
    await evaluate(`window.__store.getState().setView('unread', null); 1`);
    await sleep(200);
    assert.deepEqual(await marks(), [`${B}|f:Projects`, `${B}|inbox`], 'the Unread view clears nothing');
    await evaluate(`window.__store.getState().setView('inbox', null); 1`);
    await sleep(200);
    assert.deepEqual(await marks(), [`${B}|f:Projects`], 'the all-mailboxes Inbox clears the Inbox markers only');
    await evaluate(`window.__store.setState({ newMail: {} }); 1`);
  });

  await check('the folder list with no unread mail left clears it (AC-13.2.5); an arrival newer than the read stays', async () => {
    const zero = await evaluate(`(() => { const s = window.__store.getState(); return s.folders.filter((f) => f.key === 'inbox').map((f) => [f.accountId, f.unread]); })()`);
    assert.ok(zero.length >= 2, JSON.stringify(zero));
    // pick the mailbox whose Inbox has no unread mail in the preview, and the other one for the control
    const none = zero.find(([, u]) => u === 0)?.[0];
    const some = zero.find(([, u]) => u > 0)?.[0];
    assert.ok(some, 'the preview has an Inbox with unread mail');
    await evaluate(`window.__store.getState().setView('inbox', ${JSON.stringify(A)}); 1`);
    await sleep(150);
    await evaluate(`window.__store.setState({ newMail: { [${JSON.stringify(some + '|inbox')}]: { at: Date.now() - 5000, threads: ['x'] } } }); window.__store.getState().refresh().then(() => 1)`);
    await sleep(500);
    const kept = await marks();
    assert.ok(kept.includes(`${some}|inbox`) || some === A, `an Inbox with unread mail keeps its marker: ${JSON.stringify(kept)}`);
    if (none) {
      await evaluate(`window.__store.setState({ newMail: { [${JSON.stringify(none + '|inbox')}]: { at: Date.now() - 5000, threads: ['x'] } } }); window.__store.getState().refresh().then(() => 1)`);
      await sleep(500);
      assert.ok(!(await marks()).includes(`${none}|inbox`), 'an Inbox with no unread mail loses it');
      // newer than the read: a marker noted in the future of the read is kept
      await evaluate(`window.__store.setState({ newMail: { [${JSON.stringify(none + '|inbox')}]: { at: Date.now() + 60000, threads: ['x'] } } }); window.__store.getState().refresh().then(() => 1)`);
      await sleep(500);
      assert.ok((await marks()).includes(`${none}|inbox`), 'an arrival newer than the read of the numbers stays');
    }
    await evaluate(`window.__store.setState({ newMail: {} }); 1`);
  });

  await check('the icon column: a ring on the avatar, a dot on a folder icon, "New mail" in the tooltip and the name (AC-13.2.7)', async () => {
    await H.openApp('lang=en', 960, 560); // below 1100 px the side menu is the icon column
    await front(true);
    const B2 = await evaluate(`window.__store.getState().accounts[1].id`);
    await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
    await sleep(300);
    assert.equal(await evaluate(`document.querySelector('.folder-pane').classList.contains('is-rail')`), true, 'the icon column');
    await arrive(B2, 'inbox', 't-7');
    const r = await evaluate(`(() => { const av = [...document.querySelectorAll('.fp-avatar')].find((a) => a.classList.contains('fresh')); if (!av) return null; const dot = av.querySelector('.dot'); return { shadow: getComputedStyle(dot).boxShadow, title: av.getAttribute('title'), label: av.getAttribute('aria-label') }; })()`);
    assert.ok(r, 'no avatar has the ring');
    assert.ok(/New mail/.test(r.title) && /New mail$/.test(r.label), JSON.stringify(r));
    assert.ok(/0px 0px 0px 4px/.test(r.shadow) && /0px 0px 0px 2px/.test(r.shadow), `the ring is 2 px gap + 2 px line: ${r.shadow}`);
    // its folder icon (the mailbox is selected to see its folders)
    await evaluate(`window.__store.getState().setView('inbox', ${JSON.stringify(B2)}); 1`);
    await sleep(300);
    await arrive(B2, 'f:Projects', 't-8'); // (no such folder row in the preview: the store holds it)
    await evaluate(`window.__store.setState({ newMail: { [${JSON.stringify(B2 + '|archive')}]: { at: Date.now() + 60000, threads: ['x'] } } }); 1`);
    await sleep(150);
    const d = await evaluate(`(() => { const row = [...document.querySelectorAll('.fp-row')].find((r) => r.classList.contains('fresh')); if (!row) return null; const dot = row.querySelector('.fp-new'); const rr = row.getBoundingClientRect(), dr = dot.getBoundingClientRect(); return { w: Math.round(dr.width), h: Math.round(dr.height), x: Math.round(dr.left - rr.left), y: Math.round(dr.top - rr.top), title: row.getAttribute('title'), label: row.getAttribute('aria-label') }; })()`);
    assert.ok(d, 'no folder icon has the dot');
    assert.deepEqual([d.w, d.h], [6, 6]);
    assert.ok(d.x <= 8 && d.y <= 6, `at the top left corner: ${JSON.stringify(d)}`);
    assert.ok(/New mail/.test(d.title) && /New mail$/.test(d.label), JSON.stringify(d));
    await evaluate(`window.__store.setState({ newMail: {} }); 1`);
  });

  await check('dark theme and forced colors keep the marker visible (AC-13.2.9)', async () => {
    await H.openApp('lang=en', 1280, 800);
    await front(true);
    await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); window.__store.getState().setPrefs({ theme: 'dark' }); 1`);
    await sleep(300);
    const B2 = await evaluate(`window.__store.getState().accounts[1].id`);
    await arrive(B2, 'inbox', 't-9');
    const dark = await evaluate(`(() => { const dot = document.querySelector('.fp-row.fresh .fp-new'); const pane = getComputedStyle(document.querySelector('.folder-pane')).backgroundColor; return { bg: getComputedStyle(dot).backgroundColor, pane }; })()`);
    assert.notEqual(dark.bg, dark.pane, 'the dot differs from the pane in dark');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(200);
    const fc = await evaluate(`(() => { const dot = document.querySelector('.fp-row.fresh .fp-new'); const probe = document.createElement('i'); probe.style.color = 'CanvasText'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); return { bg: getComputedStyle(dot).backgroundColor, want }; })()`);
    assert.equal(fc.bg, fc.want, 'forced colors: the dot is CanvasText');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
  });

  await check('the text is in all 8 languages and the row does not clip it (AC-13.2.10)', async () => {
    const want = { en: 'New mail', vi: 'Thư mới', fr: 'Nouveau courrier', 'zh-Hans': '新邮件', es: 'Correo nuevo', ja: '新着メール', de: 'Neue E-Mails', ru: 'Новые письма' };
    await H.openApp('lang=en', 1280, 800);
    await front(true);
    await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
    for (const [lang, text] of Object.entries(want)) {
      await evaluate(languageJs(lang));
      await sleep(150);
      const B2 = await evaluate(`window.__store.getState().accounts[1].id`);
      await evaluate(`window.__store.setState({ newMail: {} }); 1`);
      await arrive(B2, 'inbox', 't-' + lang);
      const r = await evaluate(`(() => { const row = document.querySelector('.fp-row.fresh'); const lbl = row.querySelector('.fp-lbl'); return { title: row.getAttribute('title'), sr: row.querySelector('.sr-only').textContent, clipped: lbl.scrollWidth > lbl.clientWidth + 1 && getComputedStyle(lbl).textOverflow !== 'ellipsis' }; })()`);
      assert.ok((r.title || '').includes(text) && r.sr.includes(text), `${lang}: ${JSON.stringify(r)}`);
    }
  });

  await check('nothing is stored: a reload starts with no marker (AC-13.2.8)', async () => {
    await evaluate(`window.__store.setState({ newMail: { 'x|inbox': { at: 1, threads: ['t'] } } }); 1`);
    await H.openApp('lang=en', 1280, 800);
    assert.deepEqual(await marks(), []);
  });
} finally {
  await H.shutdown();
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
await check('the key is in the 8 dictionaries with the agreed texts', async () => {
  const want = { vi: 'Thư mới', fr: 'Nouveau courrier', 'zh-Hans': '新邮件', es: 'Correo nuevo', ja: '新着メール', de: 'Neue E-Mails', ru: 'Новые письма' };
  assert.ok(read('src/i18n/ns/mail.ts').includes('"mail.side.newMail": "New mail"'));
  for (const [l, t] of Object.entries(want)) assert.ok(read(`src/i18n/locales/${l}/mail.ts`).includes(`"mail.side.newMail": "${t}"`), l);
});

if (failures.length) { console.error(`test-new-mail-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-new-mail-ui: ok');
