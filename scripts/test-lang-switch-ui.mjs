#!/usr/bin/env node
// Language on demand in the real UI (WP9c, AC-9.1.2 to AC-9.1.5, AC-9.1.8), dev preview with the mock backend (src/devMock.ts).
//   1. the saved language (#lang=de) is applied before the first frame: every text and label that was ever put into the page, from the first
//      mutation on, is German or language-neutral - never an English text of the dictionary - and only the `de` chunk is fetched
//   2. all 8 languages one after the other (en vi fr zh-Hans es ja de ru en): no text, title, aria-label or placeholder is a raw key of the
//      English dictionary, the page language follows, and the switch from the call to the last changed text is quick once the chunk is there
//   3. while a chunk is loading everything stays in the old language: no sample taken every few milliseconds shows texts of both languages
//   4. #langfail=fr: the chunk cannot be loaded, the toast "Failed: ..." shows, the window and the saved Language setting stay as they were,
//      and a second try is made (the failure is not remembered)
//   5. the pseudo-locale (#lang=en-XA) still works
//
//   node scripts/test-lang-switch-ui.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { loadDicts } from './lib/i18n-dicts.mjs';

const dicts = await loadDicts();
const en = dicts.en;
const strings = (d) => new Set(Object.values(d).flatMap((m) => (typeof m === 'string' ? [m] : Object.values(m))));
const ALL = Object.fromEntries(Object.entries(dicts).map(([c, d]) => [c, strings(d)]));
const KEYS = new Set(Object.keys(en));
/** English texts that a window in `code` must not show: not a text of that language either (a word like "Name" is the same in both) */
const onlyIn = (a, b) => [...ALL[a]].filter((s) => !ALL[b].has(s) && s.trim().length > 3 && !/^\W*\{/.test(s));

const memo = new Map();
const onlySet = (a, b) => { const k = a + b; if (!memo.has(k)) memo.set(k, new Set(onlyIn(a, b))); return memo.get(k); };

const H = await startHarness('test-lang-switch-ui', { vitePort0: 5995, cdpPort0: 9995 });
const { evaluate, cdp } = H;
let neutral = new Set();
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };

// every text, title, aria-label and placeholder that is ever put into the page, from the first mutation of the document on
const RECORDER = `(() => {
  window.__seen = new Set();
  try { performance.setResourceTimingBufferSize(5000); } catch (e) { /* the default buffer */ }
  const add = (s) => { s = s && String(s).trim(); if (s) window.__seen.add(s); };
  const scan = (n) => { if (n.nodeType === 3) add(n.data); else if (n.nodeType === 1) { for (const a of ['title', 'aria-label', 'placeholder']) add(n.getAttribute(a)); n.childNodes.forEach(scan); } };
  new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'childList') m.addedNodes.forEach(scan); else if (m.type === 'characterData') add(m.target.data); else add(m.target.getAttribute(m.attributeName)); } })
    .observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] });
})()`;
// what the window shows now
const SNAP = `(() => {
  const out = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { const x = n.data.trim(); const p = n.parentElement; if (x && p && !['SCRIPT', 'STYLE'].includes(p.tagName)) out.add(x); }
  document.querySelectorAll('[title],[aria-label],[placeholder]').forEach((e) => { for (const a of ['title', 'aria-label', 'placeholder']) { const v = e.getAttribute(a); if (v && v.trim()) out.add(v.trim()); } });
  return [...out];
})()`;
const resources = () => evaluate(`performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /lang-[\\w-]+\\.(ts|js)/.test(n)).map((n) => /lang-([\\w-]+)\\.(?:ts|js)/.exec(n)[1])`);

try {
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });

  // ---- 2. all 8 languages one after the other, then the same round again with every chunk in memory (timing)
  await H.openApp('lang=en', 1280, 800);
  await sleep(500);
  const snaps = {};
  const ORDER = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru', 'en'];
  for (const code of ORDER) {
    await evaluate(languageJs(code));
    await sleep(250);
    ok((await evaluate(`document.documentElement.lang`)) === code, `${code}: the page language follows`);
    const now = await evaluate(SNAP);
    snaps[code] = new Set(now);
    const rawNow = now.filter((s) => KEYS.has(s));
    ok(rawNow.length === 0, `${code}: no raw key in the window: ${JSON.stringify(rawNow.slice(0, 5))}`);
  }
  // texts that are the same in all 8 windows are data of the mock mailbox (a subject, a name), not the dictionary: they are not a leak
  neutral = new Set([...snaps.en].filter((x) => Object.values(snaps).every((sn) => sn.has(x))));
  for (const code of ORDER.slice(1, 8)) {
    const left = [...snaps[code]].filter((x) => onlySet('en', code).has(x) && !neutral.has(x));
    ok(left.length === 0, `${code}: no English dictionary text left in the window: ${JSON.stringify(left.slice(0, 6))}`);
  }
  const after = [...new Set(await resources())].sort();
  ok(after.join() === ['de', 'es', 'fr', 'ja', 'ru', 'vi', 'zh-Hans'].sort().join(), `each chunk was fetched once, English never (${after.join(', ')})`);
  const dup = await evaluate(`(() => { const c = {}; for (const r of performance.getEntriesByType('resource')) { const m = /lang-([\\w-]+)\\.(?:ts|js)/.exec(r.name); if (m) c[m[1]] = (c[m[1]] || 0) + 1; } return Object.entries(c).filter(([, n]) => n > 1).map(([k]) => k); })()`);
  ok(dup.length === 0, `no chunk was fetched twice (${dup.join(', ')})`);

  const times = [];
  for (const code of ['ja', 'de', 'en']) {
    const ms = await evaluate(`new Promise((done) => {
      const L = ${JSON.stringify(code)}, t0 = performance.now();
      let last = t0;
      const mo = new MutationObserver(() => { last = performance.now(); });
      mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] });
      window.__store.getState().setPrefs({ language: L });
      const t = setInterval(() => { const s = window.__store.getState(); if (s.langLoading === null && s.prefs.language === L) { clearInterval(t); setTimeout(() => { mo.disconnect(); done(Math.round(last - t0)); }, 200); } }, 5);
    })`);
    times.push(`${code} ${ms} ms`);
    ok(ms <= 500, `${code}: from the call to the last changed text ${ms} ms (limit 500 here; the QA limit of AC-9.1.3 is 300 ms on the debug kit)`);
  }
  console.log(`switch times with the chunk in memory: ${times.join(', ')}`);

  // ---- 1. start in German (the saved language is applied before the first frame)
  await H.openApp('lang=de', 1280, 800);
  await sleep(800);
  ok((await evaluate(`document.documentElement.lang`)) === 'de', 'the page language is de at start');
  const seen = await evaluate(`[...window.__seen]`);
  const leaked = seen.filter((s) => onlySet('en', 'de').has(s) && !neutral.has(s));
  ok(seen.length > 50, `the recorder saw the page being built (${seen.length} strings)`);
  ok(leaked.length === 0, `no English text of the dictionary was ever drawn in a German start: ${JSON.stringify(leaked.slice(0, 8))}`);
  const raw = seen.filter((s) => KEYS.has(s));
  ok(raw.length === 0, `no raw key was ever drawn at start: ${JSON.stringify(raw.slice(0, 5))}`);
  const loaded = [...new Set(await resources())];
  ok(loaded.length === 1 && loaded[0] === 'de', `only the de chunk is fetched at start (${JSON.stringify(loaded)})`);


  // ---- 3. a first switch to a language that is not loaded yet: nothing is shown in two languages at once
  await H.openApp('lang=en', 1280, 800);
  await sleep(500);
  const enOnlyRu = onlyIn('en', 'ru').filter((x) => !neutral.has(x)), ruOnly = onlyIn('ru', 'en').filter((x) => !neutral.has(x));
  const mix = await evaluate(`new Promise((done) => {
    const A = new Set(${JSON.stringify(enOnlyRu)}), B = new Set(${JSON.stringify(ruOnly)});
    const snap = () => ${SNAP};
    let worst = 0, samples = 0, sawOld = 0, sawNew = 0, loadingSeen = false;
    const t0 = performance.now();
    window.__store.getState().setPrefs({ language: 'ru' });
    const t = setInterval(() => {
      const s = snap(); const a = s.filter((x) => A.has(x)).length, b = s.filter((x) => B.has(x)).length;
      samples++; if (a > 0) sawOld++; if (b > 0) sawNew++; worst = Math.max(worst, Math.min(a, b));
      if (window.__store.getState().langLoading === 'ru') loadingSeen = true;
      if ((window.__store.getState().langLoading === null && b > 0) || performance.now() - t0 > 15000) { clearInterval(t); done({ worst, samples, sawOld, sawNew, loadingSeen }); }
    }, 2);
  })`);
  ok(mix.worst === 0, `during the switch en -> ru no sample shows both languages (${JSON.stringify(mix)})`);
  ok(mix.sawNew > 0, `the switch to ru was completed (${JSON.stringify(mix)})`);
  console.log(`first switch en -> ru: ${JSON.stringify(mix)}`);

  // ---- 4. the chunk cannot be loaded
  await H.openApp('lang=en&langfail=fr', 1280, 800);
  await sleep(500);
  await evaluate(`window.__store.getState().setPrefs({ language: 'fr' }); 1`);
  ok((await evaluate(`window.__store.getState().langLoading`)) === 'fr', 'the loading state is set while the chunk is fetched');
  let toast = '';
  for (let i = 0; i < 60 && !toast; i++) { await sleep(100); toast = await evaluate(`[...document.querySelectorAll('.toasts .toast')].map((t) => t.innerText.replace(/\\s+/g, ' ')).find((x) => /Failed:/.test(x)) || ''`); }
  ok(/Failed: .*fr/i.test(toast), `the toast "Failed: ..." shows the error (${JSON.stringify(toast)})`);
  const st = await evaluate(`({ loading: window.__store.getState().langLoading, pref: window.__store.getState().prefs.language, lang: document.documentElement.lang })`);
  ok(st.loading === null && st.pref === 'en' && st.lang === 'en', `the language and the setting stay as they were (${JSON.stringify(st)})`);
  const saved = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem('hl-mock-settings') || '{}').prefs || ''; } catch { return ''; } })()`);
  ok(!/"language":"fr"/.test(saved), 'fr was not saved as the Language setting');
  ok((await evaluate(SNAP)).filter((s) => onlySet('fr', 'en').has(s)).length === 0, 'the window shows no French text');
  // a second try is made (the failure is not remembered): it fails again here because of the seam, and the loading state ends again
  await evaluate(`window.__store.getState().setPrefs({ language: 'fr' }); 1`);
  await sleep(300);
  ok((await evaluate(`window.__store.getState().langLoading`)) === 'fr', 'a second try starts a new load');
  for (let i = 0; i < 60 && (await evaluate(`window.__store.getState().langLoading`)) !== null; i++) await sleep(100);
  ok((await evaluate(`window.__store.getState().langLoading`)) === null, 'and ends again');

  // ---- 5. the pseudo-locale
  await H.openApp('lang=en-XA', 1280, 800);
  await sleep(500);
  ok((await evaluate(`document.documentElement.lang`)) === 'en-XA', 'the pseudo-locale sets the page language en-XA');
  const pseudo = (await evaluate(SNAP)).filter((s) => /^\[.*~+\]$/.test(s)).length;
  ok(pseudo > 20, `the pseudo-locale writes texts in brackets (${pseudo})`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`\ntest-lang-switch-ui: ${failures.length} of ${checks} checks failed`); process.exit(1); }
console.log(`ok - test-lang-switch-ui (${checks} checks)`);
