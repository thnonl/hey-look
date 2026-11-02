import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('wprobe', { vitePort0: 5197 });
const { evaluate, cdp } = H;
await H.openApp('lang=en&nativemenu=off', 1280, 800); await sleep(2000);
const W = `JSON.stringify((() => { const out = {}; for (const r of document.querySelectorAll('.ml-row')) { const un = r.classList.contains('unread') ? 'unread' : 'read'; const sel = r.classList.contains('selected') ? '+sel' : ''; for (const s of ['.who', '.subject', '.preview', '.date']) { const e = r.querySelector(s); if (!e) continue; const k = un + sel + ' ' + s + ' ' + getComputedStyle(e).fontWeight; out[k] = (out[k] || 0) + 1; } const w = getComputedStyle(r).fontWeight; out[un + sel + ' row ' + w] = 1; } return out; })())`;
for (const density of ['comfortable', 'compact']) {
  await evaluate(`window.__store.getState().setPrefs({ density: '${density}' }); window.__store.getState().select(null); 1`); await sleep(500);
  console.log(density, await evaluate(W));
  await evaluate(`[...document.querySelectorAll('.ml-row:not(.unread)')][1].click(); 1`); await sleep(500);
  console.log(density, 'selected read', await evaluate(W));
}
await H.shutdown(); process.exit(0);
