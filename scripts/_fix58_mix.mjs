import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('fix58-mix', { vitePort0: 6195 });
await H.openApp('lang=en&os=linux&wp8', 1280, 800);
await H.evaluate(`window.__store.getState().openMail('tw8-mix'); 1`);
await sleep(2000);
await H.evaluate(`(document.querySelector('.rp-msg:not(.open) .rp-msg-head') || document.querySelector('.rp-msg:not(.open)')).click(); 1`);
await sleep(1500);
console.log(JSON.stringify(await H.evaluate(`({ frames: [...document.querySelectorAll('iframe.msg-frame')].map((f) => f.contentDocument?.body?.textContent.slice(0, 40)), cards: [...document.querySelectorAll('.rp-msg')].map((c) => c.className) })`), null, 1));
await H.shutdown();
