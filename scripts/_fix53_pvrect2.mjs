// scratch (never committed)
import { startHarness, languageJs } from './cdp-harness.mjs';
const H = await startHarness('fix53-pv2', { vitePort0: 5290, cdpPort0: 9290 });
const { evaluate } = H;
try {
  await H.openApp('lang=en&osdark=0', 1280, 800);
  await evaluate(languageJs('en'));
  await evaluate(`window.__store.getState().setPrefs({ theme: 'dark', mailCanvas: 'original' }); 1`);
  const r = await evaluate(`new Promise((res) => { const seen = []; const t0 = performance.now(); let last = ''; window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' });
    const tick = () => { const pane = document.querySelector('.compose-pane'); const k = pane ? [...pane.querySelectorAll('*')].filter((e) => e.children.length && e.parentElement && (e.parentElement === pane || e.parentElement.parentElement === pane)).map((e) => (e.className && e.className.baseVal === undefined ? e.className : e.tagName).toString().slice(0, 30) + ':' + Math.round(e.getBoundingClientRect().top) + '/' + Math.round(e.getBoundingClientRect().height)).join(' | ') : 'none'; if (k !== last) { seen.push(Math.round(performance.now() - t0) + ' ' + k); last = k; } if (performance.now() - t0 > 2500) res(seen); else requestAnimationFrame(tick); }; tick(); })`);
  console.log(r.join('\n'));
} finally { await H.shutdown(); }
