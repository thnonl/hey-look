#!/usr/bin/env node
// 1.0.12 BUG-1012-FONT-1: the calendar names of the sidebar ("Invitations · address", "Name · address") fit the sidebar in all 8 languages at the default sidebar width: no label is cut
// (the name wraps instead of ending in an ellipsis: scrollWidth <= clientWidth, at most 3 lines), also with a long address. The dev preview with the mock backend (`#caltwins`: the IMAP mailbox "nam@example.com" keeps its Invitations entry).
// The same measurement is the WebKit probe WK-1012.FONT.09 in webkit-checks-107.md.
//   node scripts/test-calendar-label-fit.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--langs=en,de]
import { arg, languageJs, sleep, startHarness } from './cdp-harness.mjs';

const ALL = ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const LANGS = arg('langs') ? arg('langs').split(',') : ALL;
const H = await startHarness('test-calendar-label-fit', { vitePort0: 5178 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures.push(m); console.error('FAIL', m); } };
const until = async (expr, ms = 10000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { let v = false; try { v = await evaluate(`!!(${expr})`); } catch { /* between renders */ } if (v) return true; } return false; };
const PROBE = `JSON.stringify([...document.querySelectorAll('.folder-pane .cal-list label')].map((l) => { const s = l.querySelector('.cal-nm'); const lh = s ? parseFloat(getComputedStyle(s).lineHeight) : 0; return s ? { text: s.textContent.trim(), sw: s.scrollWidth, cw: s.clientWidth, lines: Math.round(s.getBoundingClientRect().height / lh), ell: getComputedStyle(s).textOverflow === 'ellipsis' } : null; }).filter(Boolean))`;
try {
  await H.openApp('lang=en&light&caltwins&calsync=ok&calsyncms=ok', 1280, 800);
  await until(`window.__store.getState().loaded === true`, 20000);
  await sleep(500);
  await evaluate(`window.__store.getState().setPrefs({ sidebar: 'expanded' }); window.__store.getState().setModule('calendar'); 1`);
  ok(await until(`document.querySelector('.cal-list')`), 'the calendar list is there');
  for (const lang of LANGS) {
    await evaluate(languageJs(lang));
    await until(`document.documentElement.lang === ${JSON.stringify(lang)}`, 25000);
    await sleep(400);
    const rows = JSON.parse(await evaluate(PROBE));
    ok(rows.length >= 4, `${lang}: the sidebar lists its calendars (${rows.length})`);
    for (const r of rows) {
      ok(r.sw <= r.cw && !r.ell, `${lang}: "${r.text}" is cut (scrollWidth ${r.sw} > clientWidth ${r.cw}, ellipsis ${r.ell})`);
      ok(r.lines <= 3, `${lang}: "${r.text}" takes ${r.lines} lines`);
    }
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-calendar-label-fit: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-calendar-label-fit: ok (${checks} checks)`);
process.exit(0);
