import fs from 'node:fs';
import { sleep, startHarness, inputs } from './cdp-harness.mjs';
const H = await startHarness('pdfprobe2', { vitePort0: 6080 });
const { evaluate, cdp } = H;
const { press } = inputs(H, null, 'x');
const H_ready = async () => { for (let i = 0; i < 100; i++) { if (await evaluate(`document.querySelector('.pv-pdfjs')?.dataset.state === 'ready'`)) return; await sleep(50); } };
const b64 = fs.readFileSync(new URL(`./fixtures/pdf/thirty-pages.pdf`, import.meta.url)).toString('base64');
await H.openApp('lang=en&os=macos', 1280, 800);
await evaluate(`window.__mockPdf = { 'agenda.pdf': ${JSON.stringify(b64)} }; window.__store.getState().select('tlayer'); 1`);
await sleep(800);
await evaluate(`document.querySelector('.rp-head .icon-btn[aria-label="Expand all"]').click(); 1`);
await sleep(600);
console.log('base', await evaluate(`[...document.querySelectorAll('canvas')].map((c) => c.parentElement.className + '/' + c.className)`));
for (let i = 0; i < 8; i++) {
  await evaluate(`(() => { const c = [...document.querySelectorAll('.att-card')].find((x) => x.textContent.includes('agenda.pdf')); c.focus(); c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
  await H_ready();
  await evaluate(`document.querySelector('.pv-pdfjs').scrollTop = 3000; 1`);
  await sleep(150);
  await press('Escape', 'Escape');
  await sleep(300);
  console.log(i, await evaluate(`[...document.querySelectorAll('canvas')].map((c) => (c.parentElement.className || c.parentElement.tagName) + '/' + c.className + '/' + c.width)`));
}
await H.shutdown();
