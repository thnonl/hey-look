import { readFileSync } from 'node:fs';
import { startHarness, sleep } from './cdp-harness.mjs';
const expr = readFileSync(new URL('./_fix57_probe_expr.txt', import.meta.url), 'utf8');
const H = await startHarness('fix57-probe', { vitePort0: 6170 });
try {
  for (const lang of ['en', 'ru']) {
    await H.openApp(`lang=${lang}&os=macos`, 960, 560);
    await H.evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'tray' }); 1`);
    await sleep(600);
    console.log(lang, await H.evaluate(expr));
  }
} finally { await H.shutdown(); }
