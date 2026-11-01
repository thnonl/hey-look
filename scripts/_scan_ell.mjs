import { sleep, startHarness, languageJs, arg } from './cdp-harness.mjs';
const H = await startHarness('scan-ell', { vitePort0: 5830 });
const { evaluate, cdp } = H;
const lang = arg('lang') || 'ru';
await H.openApp(`lang=en&light&nativemenu=off`, 1280, 800);
await sleep(1500);
await evaluate(languageJs(lang)); await sleep(800);
const SCAN = `JSON.stringify([...document.querySelectorAll('body *')].filter((e) => { const c = getComputedStyle(e); return (c.textOverflow === 'ellipsis' || c.webkitLineClamp !== 'none') && e.scrollWidth > e.clientWidth + 0.5 && e.textContent.trim().length > 0 && !e.closest('iframe'); }).map((e) => e.className.toString().slice(0, 22) + '|' + e.textContent.trim().slice(0, 40) + '|' + e.scrollWidth + '/' + e.clientWidth))`;
const seen = new Set(); const all = [];
const scan = async (n) => { for (const x of JSON.parse(await evaluate(SCAN))) if (!seen.has(x)) { seen.add(x); all.push(n + ' :: ' + x); } };
await evaluate(`window.__store.getState().select('t1'); 1`); await sleep(1200); await scan('mail');
for (const tab of ['general', 'appearance', 'mb:all', 'tray']) { await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: ${JSON.stringify(tab)}, nonce: Date.now() }); 1`); await sleep(900); await scan('settings ' + tab); }
await evaluate(`window.__store.getState().setDialog(null); window.__store.getState().setModule('calendar'); 1`); await sleep(1200); await scan('calendar');
console.log(all.join('\n'));
await H.shutdown(); process.exit(0);
