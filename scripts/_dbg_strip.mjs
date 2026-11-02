import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-strip', { vitePort0: 5199 });
const { evaluate, cdp } = H;
await H.openApp('lang=en&nativemenu=off', 1280, 800); await sleep(2000);
await evaluate(`window.__store.getState().setPrefs({ density: 'compact' }); 1`); await sleep(600);
const p = JSON.parse(await evaluate(`(() => { const b = document.querySelectorAll('.ml-row')[3].getBoundingClientRect(); return JSON.stringify([b.left + b.width / 2, b.top + b.height / 2]); })()`));
await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1] }); await sleep(300);
console.log(await evaluate(`(() => { const r = document.querySelectorAll('.ml-row')[3]; const s = r.querySelector('.ml-sub'); return JSON.stringify({ sub: s.getBoundingClientRect().height, kids: [...s.children].map((c) => [c.className, Math.round(c.getBoundingClientRect().height), getComputedStyle(c).display, getComputedStyle(c).marginTop + '/' + getComputedStyle(c).marginBottom]), inner: [...r.querySelector('.hover-actions').children].map((c) => [c.tagName, c.className, Math.round(c.getBoundingClientRect().height)]) }); })()`));
await H.shutdown(); process.exit(0);
