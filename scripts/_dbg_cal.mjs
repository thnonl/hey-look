import { startHarness } from './cdp-harness.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';
const H = await startHarness('dbg-cal', { vitePort0: 5992 });
try {
  await H.openApp('lang=en', 1280, 800);
  for (const rate of [1, 1, 2, 4, 4]) {
    await H.cdp('Emulation.setCPUThrottlingRate', { rate });
    console.log(rate, JSON.stringify(await H.evaluate(CALIBRATE)));
  }
} finally { await H.shutdown(); }
