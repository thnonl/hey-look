// scratch (never committed): does the Preview switch move after the composer shows it?
import { startHarness, languageJs, sleep } from './cdp-harness.mjs';
const H = await startHarness('fix53-pv', { vitePort0: 5290, cdpPort0: 9290 });
const { evaluate } = H;
try {
  for (const slow of [1, 4]) {
    await H.cdp('Emulation.setCPUThrottlingRate', { rate: slow });
    await H.openApp('lang=en&osdark=0', 1280, 800);
    await evaluate(languageJs('en'));
    await evaluate(`window.__store.getState().setPrefs({ theme: 'dark', mailCanvas: 'original' }); 1`);
    const r = await evaluate(`new Promise((res) => { const seen = []; const t0 = performance.now(); let last = ''; window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' });
      const tick = () => { const b = document.querySelector('.pv-switch button[aria-pressed]:not(.on)'); const pm = !!document.querySelector('.ProseMirror'); const r = b ? b.getBoundingClientRect() : null; const k = (r ? [r.left, r.top, r.width].map((n) => Math.round(n)).join(',') : 'none') + ' pm=' + pm; if (k !== last) { seen.push(Math.round(performance.now() - t0) + ' ' + k); last = k; } if (performance.now() - t0 > 4000) res(seen); else requestAnimationFrame(tick); }; tick(); })`);
    console.log('slowdown', slow, JSON.stringify(r));
  }
} finally { await H.shutdown(); }
