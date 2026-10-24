import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg', { vitePort0: 5281 });
const { evaluate } = H;
try {
  await H.openApp('lang=en', 1400, 900);
  await evaluate(`window.__store.getState().setView('inbox','a1'); window.__mockAddFolder('a1','Projects'); window.__mockAddFolder('a1','Projects/2026'); window.__mockAddFolder('a1','Zeta'); window.__store.getState().refresh().then(()=>1)`);
  await sleep(700);
  console.log(await evaluate(`JSON.stringify([...document.querySelectorAll('.fp-group .fp-row[data-fkey]')].map(r=>{const c=r.querySelector('.fp-chev'),cr=c&&c.getBoundingClientRect(),ic=r.querySelector('.fp-ico').getBoundingClientRect();return {key:r.dataset.fkey,pad:parseInt(r.style.paddingLeft||'0'),chev:c?[Math.round(cr.left),Math.round(cr.width),Math.round(cr.height)]:null,iconLeft:Math.round(ic.left)}}))`));
} finally { await H.shutdown(); }
