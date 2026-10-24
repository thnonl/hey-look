import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-nb', { vitePort0: 6180 });
await H.openApp('lang=en&os=linux', 1280, 800);
await H.evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:all' }); 1`);
await sleep(800);
console.log(await H.evaluate(`JSON.stringify([...document.querySelectorAll('.settings-body button, .mb-tabs button, .settings button')].slice(0,30).map(b=>[b.className,b.textContent.trim().slice(0,30)]))`));
console.log(await H.evaluate(`document.querySelector('.settings-body')?.innerHTML.slice(0,800)`));
await H.shutdown();
