#!/usr/bin/env node
// 1.0.7 fix18 (D-065, DEC-021, DEC-010): pressing Unsubscribe always ends in one visible outcome, in the real page (the dev preview with the mock backend,
// src/devMock.ts: `#unsub=done|open|mailto|notarget|error`, `#unsubms=<ms>`, `#openfail`), real mouse clicks.
//  - the link shows it is working within 100 ms (aria-busy, a ring that takes no room), a second press starts nothing, the More-menu entry is disabled meanwhile
//  - the one-click POST was accepted: "Unsubscribed", no browser; the page is opened: the info toast "The sender's unsubscribe page is open ..." and the backend is told
//    how the browser took it (unsubscribe_opened: no error); the browser cannot be started: only the error toast of the failed open (no info toast) and the error is reported;
//    mailto: a compose addressed to the unsubscribe address with its subject and body, and the info toast "Send this message to finish unsubscribing." (nothing is sent);
//    no target / backend error: "Unsubscribe failed: ..."; the busy state is over after each
//  - a backend that never answers: the safety end after 15 s (the failed toast; full run only)
//  - the two info toasts in every language: the agreed words, no raw key, not clipped, inside the window, at 960 x 560 and 1280 x 800
//
//   node scripts/test-unsub-outcomes.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--quick]
//   --quick  English, German and Japanese and no 15 s wait; the full run (no flag) is the 8 languages
import { flag, arg, sleep, startHarness, inputs } from './cdp-harness.mjs';
import { loadDict } from './lib/i18n-dicts.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : flag('quick') ? ['en', 'de', 'ja'] : ALL;
const dicts = {};
for (const l of new Set(['en', ...LANGS])) dicts[l] = await loadDict(l);
const tr = (lang, key) => {
  const m = dicts[lang]?.[key];
  if (typeof m !== 'string') throw new Error(`no text ${key} in ${lang}`);
  return m;
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const H = await startHarness('test-unsub-outcomes', { vitePort0: 5780 });
const { evaluate } = H;
const { click } = inputs(H, arg('shots'), 'unsub');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
const waitFor = async (expr, what, ms = 10000) => {
  for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(40)) {
    let v = false;
    try { v = await evaluate(`!!(${expr})`); } catch { /* between two renders */ }
    if (v) return true;
  }
  ok(false, `timed out waiting for ${what}`);
  return false;
};
const LINK = '.rp-msg-body .notice .unsub-link';
const toasts = () => evaluate(`[...document.querySelectorAll('.toasts .toast')].map((t) => ({ text: t.querySelector('.toast-text')?.textContent.trim() ?? '', kind: [...t.classList].find((c) => ['info', 'success', 'error'].includes(c)) ?? '' }))`);
const calls = () => evaluate(`(window.__unsubCalls || []).length`);
const opened = () => evaluate(`JSON.stringify(window.__unsubOpened || [])`).then(JSON.parse);
const browserGot = () => evaluate(`JSON.stringify(window.__mockMail.opened)`).then(JSON.parse);
const busy = () => evaluate(`document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy') === 'true'`);
const clear = () => evaluate(`window.__unsubCalls = []; window.__unsubOpened = []; window.__mockMail.opened.length = 0; window.__store.setState({ toasts: [] }); 1`);
const setMode = (mode, ms = 0) => evaluate(`history.replaceState(null, '', '#' + location.hash.slice(1).replace(/(^|&)unsub(ms)?=[^&]*/g, '').replace(/^&/, '') + '&unsub=${mode}&unsubms=${ms}'); 1`);

const openPage = async (hash, w = 1280, h = 800) => {
  await H.openApp(hash, w, h);
  await waitFor(`window.__store.getState().loaded === true`, 'the store to finish loading', 20000);
  await sleep(300 + 250 * hash.split('&').filter(Boolean).length);
  await evaluate(`window.__store.getState().openMail('t1'); 1`);
  await waitFor(`document.querySelector(${JSON.stringify(LINK)})`, 'the Unsubscribe link of the newsletter notice', 15000);
  await sleep(300);
  await clear();
};
/** Presses the link with a real click and returns how long the busy state took to appear (ms; null when it never did). */
const press = async () => {
  await evaluate(`(() => { window.__u = { click: 0, busy: 0 };
    document.addEventListener('click', () => { if (!window.__u.click) window.__u.click = performance.now(); }, { capture: true, once: true });
    new MutationObserver(() => { if (!window.__u.busy && document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy') === 'true') window.__u.busy = performance.now(); }).observe(document.body, { subtree: true, attributes: true, childList: true });
    return 1; })()`);
  await click(LINK);
  await sleep(60);
  const u = await evaluate(`window.__u`);
  return u.click && u.busy ? Math.round(u.busy - u.click) : null;
};
const toastCount = (list, text) => list.filter((t) => t.text === text).length;

try {
  // ------------------------------------------------------------------ English, every outcome
  const T = (k) => tr('en', k);
  await openPage('lang=en&light&unsub=done&unsubms=700');
  ok(!(await busy()), 'idle: the link is not busy');

  // AC-D065.1 the POST was accepted
  let ms = await press();
  ok(ms !== null && ms <= 100, `done: busy within 100 ms of the press (${ms} ms)`);
  ok(await busy(), 'done: the link stays busy while the backend works');
  ok(await evaluate(`!!document.querySelector(${JSON.stringify(LINK + ' .busy-ring')})`), 'done: a ring is drawn');
  const geo = await evaluate(`(() => { const l = document.querySelector(${JSON.stringify(LINK)}); const r = l.getBoundingClientRect(); const ring = l.querySelector('.busy-ring').getBoundingClientRect(); return { linkW: r.width, ring: ring.width > 0 }; })()`);
  ok(geo.ring, 'done: the ring has a size');
  await click(LINK); // a second press while busy
  await sleep(200);
  ok((await calls()) === 1, `done: a second press starts nothing (${await calls()} call(s))`);
  await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, 'the busy state to end', 4000);
  let tl = await toasts();
  ok(toastCount(tl, T('reading.msg.unsubscribed')) === 1 && tl.find((t) => t.text === T('reading.msg.unsubscribed'))?.kind === 'success', `done: the success toast "Unsubscribed" (${JSON.stringify(tl)})`);
  ok((await browserGot()).length === 0 && (await opened()).length === 0, 'done: the browser was not asked');
  // the layout stands still: the link keeps its width while busy (the ring is out of the flow)
  await clear();
  await setMode('done', 600);
  const w0 = await evaluate(`document.querySelector(${JSON.stringify(LINK)}).getBoundingClientRect().width`);
  await press();
  const w1 = await evaluate(`document.querySelector(${JSON.stringify(LINK)}).getBoundingClientRect().width`);
  ok(Math.abs(w0 - w1) < 0.5, `busy: the link does not change its width (${w0} -> ${w1})`);
  await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, 'the busy state to end (2)', 4000);

  // the More menu entry is disabled while busy
  await clear();
  await setMode('done', 900);
  await press();
  await click('.rp-msg-head [aria-label="More actions"], [aria-label="More actions"]');
  await sleep(150);
  const item = await evaluate(`(() => { const b = [...document.querySelectorAll('button[role=menuitem]')].find((x) => x.textContent.trim() === 'Unsubscribe'); return b ? { disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' } : null; })()`);
  ok(item && item.disabled, `busy: the More menu entry "Unsubscribe" is disabled (${JSON.stringify(item)})`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, 'the busy state to end (3)', 4000);

  // AC-D065.2 the page is opened (POST failed or a plain link): the info toast and the report to the backend
  await clear();
  await setMode('open', 500);
  ms = await press();
  ok(ms !== null && ms <= 100, `open: busy within 100 ms (${ms} ms)`);
  await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, 'the busy state to end (open)', 4000);
  tl = await toasts();
  ok(tl.length === 1 && tl[0].text === T('reading.msg.unsubscribeOpened') && tl[0].kind === 'info', `open: exactly one info toast, "The sender's unsubscribe page is open..." (${JSON.stringify(tl)})`);
  ok(JSON.stringify(await browserGot()) === JSON.stringify(['https://news.example.org/u/abc123']), `open: the browser was asked once for the page (${JSON.stringify(await browserGot())})`);
  ok(JSON.stringify(await opened()) === JSON.stringify([['https://news.example.org/u/abc123', null]]), `open: the backend was told the browser took it (${JSON.stringify(await opened())})`);

  // AC-D065.5 mailto
  await clear();
  await setMode('mailto', 300);
  await press();
  await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, 'the busy state to end (mailto)', 4000);
  tl = await toasts();
  ok(tl.length === 1 && tl[0].text === T('reading.msg.unsubscribeMailto') && tl[0].kind === 'info', `mailto: exactly one info toast, "Send this message to finish unsubscribing." (${JSON.stringify(tl)})`);
  await waitFor(`window.__store.getState().compose`, 'the compose of the mailto', 5000);
  const comp = await evaluate(`(() => { const c = window.__store.getState().compose; return c ? { to: c.to, subject: c.subject, body: c.bodyHtml ?? '' } : null; })()`);
  ok(comp && JSON.stringify(comp.to) === JSON.stringify(['unsub-7f3a@lists.example.org']) && comp.subject === 'unsubscribe T0K3N' && comp.body.includes('Please remove me'), `mailto: a compose with the address, subject and body of the mailto (${JSON.stringify(comp)})`);
  ok((await browserGot()).length === 0 && (await opened()).length === 0, 'mailto: no browser');
  await evaluate(`window.__store.setState({ compose: null, composeDirty: false }); 1`);

  // no target, backend error
  for (const [mode, text] of [['notarget', 'Unsubscribe failed: This message has no unsubscribe link.'], ['error', null]]) {
    await openPage(`lang=en&light&unsub=${mode}&unsubms=300`);
    await press();
    await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, `the busy state to end (${mode})`, 4000);
    tl = await toasts();
    ok(tl.length === 1 && tl[0].kind === 'error' && tl[0].text.startsWith('Unsubscribe failed: ') && (text === null || tl[0].text === text), `${mode}: one error toast (${JSON.stringify(tl)})`);
    ok(!(await busy()), `${mode}: the link is not busy any more`);
  }

  // AC-D065.4 the browser cannot be started
  await openPage('lang=en&light&unsub=open&unsubms=200&openfail');
  await press();
  await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, 'the busy state to end (openfail)', 4000);
  await sleep(300);
  tl = await toasts();
  ok(tl.length === 1 && tl[0].kind === 'error' && /open your browser/i.test(tl[0].text) && toastCount(tl, T('reading.msg.unsubscribeOpened')) === 0, `openfail: only the error toast of the failed open, no "page is open" toast (${JSON.stringify(tl)})`);
  const rep = await opened();
  ok(rep.length === 1 && typeof rep[0][1] === 'string' && rep[0][1].length > 0, `openfail: the backend was told that opening failed (${JSON.stringify(rep)})`);

  // the safety end: a backend that never answers
  if (!flag('quick')) {
    await openPage('lang=en&light&unsub=done&unsubms=30000');
    const t0 = Date.now();
    await press();
    await sleep(14000 - (Date.now() - t0));
    ok(await busy(), 'safety: still busy at 14 s');
    await waitFor(`!document.querySelector(${JSON.stringify(LINK)})?.getAttribute('aria-busy')`, 'the safety end', 4000);
    const took = Date.now() - t0;
    ok(took >= 14500 && took <= 16500, `safety: the busy state ended at about 15 s (${took} ms)`);
    tl = await toasts();
    ok(tl.length === 1 && tl[0].kind === 'error' && tl[0].text.startsWith('Unsubscribe failed: '), `safety: the failed toast (${JSON.stringify(tl)})`);
  }

  // ------------------------------------------------------------------ the two info toasts in every language, two window sizes
  for (const [w, h] of [[960, 560], [1280, 800]]) {
    await openPage('lang=en&light&unsub=open&unsubms=0', w, h);
    for (const lang of LANGS) {
      await evaluate(`window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); 1`);
      await waitFor(`document.documentElement.lang === ${JSON.stringify(lang)}`, `the page language ${lang}`, 25000);
      await sleep(150);
      for (const mode of ['open', 'mailto']) {
        await clear();
        await setMode(mode, 0);
        await evaluate(`window.__store.setState({ compose: null, composeDirty: false }); window.__store.getState().openMail('t1'); 1`);
        await waitFor(`document.querySelector(${JSON.stringify(LINK)})`, `${lang} ${mode}: the Unsubscribe link`, 8000);
        await sleep(200);
        await click(LINK);
        const want = norm(tr(lang, mode === 'open' ? 'reading.msg.unsubscribeOpened' : 'reading.msg.unsubscribeMailto'));
        await waitFor(`document.querySelector('.toasts .toast')`, `${lang} ${mode}: the toast`, 5000);
        await sleep(250);
        const m = await evaluate(`(() => { const t = document.querySelector('.toasts .toast'); if (!t) return null; const x = t.querySelector('.toast-text'); const r = t.getBoundingClientRect(); return { text: x.textContent.replace(/\\s+/g, ' ').trim(), over: x.scrollWidth - x.clientWidth, overY: x.scrollHeight - x.clientHeight, l: r.left, r: r.right, t: r.top, b: r.bottom, vw: innerWidth, vh: innerHeight }; })()`);
        const tag = `${lang} ${mode} ${w}x${h}`;
        ok(m && m.text === want, `${tag}: the agreed words ("${m?.text}")`);
        ok(m && !/\{\w+\}|reading\.msg\./.test(m.text), `${tag}: no raw key or placeholder`);
        ok(m && m.over <= 1 && m.overY <= 1, `${tag}: the text is not clipped (${m?.over}, ${m?.overY})`);
        ok(m && m.l >= 0 && m.r <= m.vw && m.t >= 0 && m.b <= m.vh, `${tag}: the toast is inside the window (${m?.l}..${m?.r} of ${m?.vw}, ${m?.t}..${m?.b} of ${m?.vh})`);
      }
    }
  }
} catch (e) {
  failures.push(`the test stopped: ${e && e.stack ? e.stack : e}`);
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) {
  console.error(`\n${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`test-unsub-outcomes: ${checks} checks ok`);
