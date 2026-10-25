// scratch (never committed): width of the Settings search placeholder in wide fonts, 8 languages, 960x560
import { startHarness, languageJs, sleep } from './cdp-harness.mjs';
const H = await startHarness('fix53-ph', { vitePort0: 5190, cdpPort0: 9190 });
const { evaluate } = H;
const out = [];
try {
  for (const lang of ['en','vi','fr','zh-Hans','es','ja','de','ru']) {
    await H.openApp(`lang=${lang}&os=windows`, 960, 560);
    if (lang !== 'en') await evaluate(languageJs(lang));
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'general', nonce: Date.now() }); 1`);
    for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector('.settings-nav .set-search input')`)) break; await sleep(100); }
    out.push(lang + ' ' + await evaluate(`(() => { const b = document.querySelector('.settings-nav .set-search input'); if (!b) return 'no box'; const cs = getComputedStyle(b); const room = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); const cv = document.createElement('canvas').getContext('2d'); const r = {}; for (const f of ['Segoe UI','Verdana','Tahoma','Arial']) { cv.font = getComputedStyle(b, '::placeholder').fontSize + ' "' + f + '"'; r[f] = Math.round(cv.measureText(b.placeholder).width); } return JSON.stringify({ ph: b.placeholder, room: Math.round(room), box: b.clientWidth, ...r }); })()`));
  }
} finally { await H.shutdown(); }
console.log(out.join('\n'));
