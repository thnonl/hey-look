import fs from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('pdfprobe3', { vitePort0: 6090 });
const { evaluate, cdp } = H;
const VK = { End: 35, Home: 36, PageDown: 34, ArrowDown: 40 };
const key = async (k) => { for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: VK[k], nativeVirtualKeyCode: VK[k] }); };
const b64 = fs.readFileSync(new URL(`./fixtures/pdf/thirty-pages.pdf`, import.meta.url)).toString('base64');
await H.openApp('lang=en&os=macos', 1280, 800);
await evaluate(`window.__mockPdf = { 'agenda.pdf': ${JSON.stringify(b64)} }; window.__store.getState().select('tlayer'); 1`);
await sleep(800);
await evaluate(`document.querySelector('.rp-head .icon-btn[aria-label="Expand all"]').click(); 1`);
await sleep(600);
await evaluate(`(() => { const c = [...document.querySelectorAll('.att-card')].find((x) => x.textContent.includes('agenda.pdf')); c.focus(); c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
await sleep(2500);
const s = () => evaluate(`JSON.stringify({ top: Math.round(document.querySelector('.pv-pdfjs').scrollTop), h: document.querySelector('.pv-pdfjs').scrollHeight, c: document.querySelector('.pv-pdfjs').clientHeight, head: document.querySelector('.pv-head').innerText.replace(/\s+/g, ' '), active: document.activeElement.className })`);
console.log(await s());
await key('PageDown'); await sleep(400); await key('ArrowDown'); await sleep(300); await key('Home'); await sleep(1200); console.log('Home', await s());
await key('End'); for (let i = 0; i < 6; i++) { await sleep(700); console.log('End', i, await s()); }
await H.shutdown();
