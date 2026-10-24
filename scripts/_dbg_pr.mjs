import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-pr', { vitePort0: 6190 });
await H.openApp('lang=en&os=macos', 1280, 800);
await H.evaluate(`(async () => { window.__mockAddThread('pr1', 'Q3', { html: '<p>hello</p>', fromName: 'Ann', fromEmail: 'ann@example.org' }); await window.__store.getState().refresh(); await window.__store.getState().select('pr1'); return 1; })()`);
await sleep(1500);
console.log(await H.evaluate(`JSON.stringify([...document.querySelectorAll('.rp-msg button')].map(b=>[b.getAttribute('aria-label'),b.title,b.className]))`));
await H.shutdown();
