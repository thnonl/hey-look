import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('fp', { vitePort0: 5850 });
await H.openApp('lang=en&light&nativemenu=off', 1280, 800); await sleep(1800);
console.log(await H.evaluate(`JSON.stringify([...document.querySelectorAll('.fp-row')].map((r) => [r.querySelector('.fp-star.on, .fp-star-gap') ? 'star' : 'nostar', r.getBoundingClientRect().height]))`));
await H.shutdown(); process.exit(0);
