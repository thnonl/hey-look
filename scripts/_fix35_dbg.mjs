import { sleep, startHarness } from './cdp-harness.mjs';
import { darkFrameProbe } from './lib/dark-frame-probe.mjs';
const H = await startHarness('fix35-dbg', { vitePort0: 5770 });
const { evaluate, cdp } = H;
await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await H.openApp('lang=en', 1280, 900);
await evaluate(`window.__store.getState().setPrefs({ theme: 'dark', mailCanvas: 'dark' }); 1`);
for (const id of ['dk8']) {
  await evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
  for (const ms of [200, 800, 2500]) {
    await sleep(ms);
    const st = JSON.parse(await evaluate(darkFrameProbe([27, 28, 32])));
    console.log(id, ms, st && { cls: st.cls, vis: st.bodyVis, rs: st.rs, sheets: st.sheets, hmAttr: st.hmAttr, min: st.min, low: st.rows.filter((r) => r[3] < 4.5).slice(0, 3) });
    console.log(await evaluate(`(() => { const d = document.querySelector('.msg-frame').contentDocument; return JSON.stringify({ lens: [...d.querySelectorAll('style')].map((s) => s.textContent.length), win: !!d.defaultView, styles: d.querySelectorAll('style').length, htmlcls: d.documentElement.className, mark: d.querySelectorAll('[data-hm]').length, n: d.body.querySelectorAll('*').length }); })()`));
  }
}
await H.shutdown();
