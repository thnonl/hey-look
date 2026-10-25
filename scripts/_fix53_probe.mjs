// scratch (never committed)
import { startHarness, languageJs, sleep } from './cdp-harness.mjs';
import { searchProbe } from './lib/settings-search-probe.mjs';
const H = await startHarness('fix53-probe', { vitePort0: 5190, cdpPort0: 9190 });
const { evaluate } = H;
try {
  await H.openApp('lang=de&os=windows', 960, 560);
  await evaluate(languageJs('de'));
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'general', nonce: Date.now() }); 1`);
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector('.settings-nav .set-search input')`)) break; await sleep(100); }
  const r = JSON.parse(await evaluate(searchProbe()));
  console.log(JSON.stringify(r.box));
} finally { await H.shutdown(); }
