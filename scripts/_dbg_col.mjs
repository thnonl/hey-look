import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-col', { vitePort0: 5192 });
await H.openApp('lang=en&nativemenu=off', 1280, 800); await sleep(2500);
console.log(await H.evaluate(`(() => { const r = document.querySelector('.ml-row.unread'); return JSON.stringify([getComputedStyle(r).backgroundColor, getComputedStyle(r.querySelector('.who')).color, getComputedStyle(r.querySelector('.subject')).color, !!r.querySelector('.preview'), r.innerHTML.slice(0, 300)]); })()`));
await H.shutdown(); process.exit(0);
