import fs from 'node:fs';
import { sleep, startHarness, arg } from './cdp-harness.mjs';
const OUT = 'E:/hey-mail/test-builds/v1012-unread/shots';
const mode = arg('mode') || 'unread';
const H = await startHarness('shots-unread', { vitePort0: 5196 });
const { evaluate, cdp } = H;
const mouse = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const shot = async (name) => { await sleep(350); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64')); };
await H.openApp('lang=en&nativemenu=off', 1280, 800);
await sleep(2000);
const rowAt = (n) => evaluate(`(() => { const r = [...document.querySelectorAll('.ml-row')][${n}]; const b = r.getBoundingClientRect(); return [b.left + b.width * 0.55, b.top + b.height / 2]; })()`);
if (mode === 'unread') {
  for (const theme of ['light', 'dark']) for (const density of ['comfortable', 'compact']) for (const [accName, accent] of [['blue', '#0f6cbd'], ['rose', '#c2327d']]) {
    await evaluate(`window.__store.getState().setPrefs({ theme: '${theme}', density: '${density}', accent: '${accent}' }); window.__store.getState().select(null); 1`);
    await sleep(500);
    // the third row selected, the fifth hovered: the others are unread (tinted) or read
    await evaluate(`[...document.querySelectorAll('.ml-row')][2].click(); 1`); await sleep(500);
    const p = await rowAt(4); await mouse(p[0], p[1]);
    await shot(`unread-${theme}-${density}-${accName}`);
    await mouse(5, 5);
  }
} else {
  const tag = arg('tag');
  for (const theme of ['light', 'dark']) {
    await evaluate(`window.__store.getState().setPrefs({ theme: '${theme}', density: 'compact' }); window.__store.getState().select(null); 1`);
    await sleep(500);
    await shot(`compact-normal-${tag}-${theme}`);
    const p = await rowAt(3); await mouse(p[0], p[1]);
    await shot(`compact-hover-${tag}-${theme}`);
    await mouse(5, 5);
  }
}
await H.shutdown(); process.exit(0);
