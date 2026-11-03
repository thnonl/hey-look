#!/usr/bin/env node
// 1.0.12 (Windows QA BUG-7): the ribbon never has a horizontal scrollbar and never clips a button, in every language, at every window width down to the app minimum (960 px, tauri.conf.json),
// on every tab of the mail and the calendar module. A row that does not fit with its labels shows icons only (the same look the 1400 px rule gave).
//   node scripts/test-ribbon-fit.mjs [--require-browser | --url=http://127.0.0.1:1420/] [--langs=ru,en] [--widths=1800,1400,1100,960]
import { arg, languageJs, sleep, startHarness } from './cdp-harness.mjs';

const LANGS = arg('langs') ? arg('langs').split(',') : ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru'];
const WIDTHS = arg('widths') ? arg('widths').split(',').map(Number) : [1800, 1400, 1100, 960];
const H = await startHarness('test-ribbon-fit', { vitePort0: 5420 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures.push(m); console.error('FAIL', m); } };
const until = async (expr, ms = 8000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { let v = false; try { v = await evaluate(`!!(${expr})`); } catch { /* between renders */ } if (v) return true; } return false; };
const PROBE = `(() => { const row = document.querySelector('.ribbon-row'); if (!row) return null; const r = row.getBoundingClientRect(); const cs = getComputedStyle(row);
  const inner = r.right - parseFloat(cs.paddingRight); const clipped = [...row.querySelectorAll('.rb, .dd > button, .rg')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > inner + 0.5 || b.left < r.left - 0.5); }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.className).trim().slice(0, 24));
  return JSON.stringify({ scroll: row.scrollWidth - row.clientWidth, clipped, labels: !!row.querySelector('.rb:not(.primary) span') && getComputedStyle(row.querySelector('.rb:not(.primary) span')).display !== 'none', w: window.innerWidth }); })()`;
try {
  for (const width of WIDTHS) {
    await H.openApp('lang=en&nativemenu=off', width, 800);
    await until(`window.__store.getState().loaded === true`, 20000);
    await sleep(800);
    for (const lang of LANGS) {
      await evaluate(languageJs(lang));
      await until(`document.documentElement.lang === ${JSON.stringify(lang)}`, 25000);
      await sleep(300);
      for (const [module, tab] of [['mail', 'home'], ['mail', 'view'], ['mail', 'help'], ['calendar', 'home'], ['calendar', 'view']]) {
        await evaluate(`(() => { const s = window.__store.getState(); s.setModule(${JSON.stringify(module)}); s.setRibbonTab(${JSON.stringify(tab)}); return 1; })()`);
        await sleep(350);
        const r = JSON.parse((await evaluate(PROBE)) ?? 'null');
        const tag = `${lang} ${width}px ${module}/${tab}`;
        ok(!!r, `${tag}: the ribbon is there`);
        if (!r) continue;
        ok(r.scroll <= 0, `${tag}: no horizontal scroll (${r.scroll} px too wide)`);
        ok(r.clipped.length === 0, `${tag}: no button is cut off (${r.clipped.join(', ')})`);
      }
    }
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-ribbon-fit: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-ribbon-fit: ok (${checks} checks)`);
process.exit(0);
