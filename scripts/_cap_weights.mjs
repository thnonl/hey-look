import fs from 'node:fs';
import { sleep, startHarness, languageJs, arg } from './cdp-harness.mjs';
const out = arg('out'), tag = arg('tag');
fs.mkdirSync(out, { recursive: true });
const H = await startHarness('cap-weights', { vitePort0: 5900 + Math.floor(Math.random() * 90) });
const { evaluate, cdp } = H;
const HEAVY = `JSON.stringify([...document.querySelectorAll('body *')].filter((e) => !e.closest('iframe, .tiptap, .rich-body') && e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontWeight) > 600).map((e) => e.tagName.toLowerCase() + '.' + e.className.toString().slice(0, 24) + ':' + getComputedStyle(e).fontWeight + ':' + e.textContent.trim().slice(0, 18)))`;
const heavy = {};
const shot = async (name) => { await sleep(500); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/${tag}-${name}.png`, Buffer.from(r.data, 'base64')); const h = JSON.parse(await evaluate(HEAVY)); if (h.length) heavy[name] = h; };
for (const theme of ['light', 'dark']) for (const lang of ['en', 'vi']) {
  const k = `${theme}-${lang}`;
  await H.openApp(`lang=en&${theme}&nativemenu=off`, 1280, 800);
  await sleep(1500);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); 1`);
  await evaluate(languageJs(lang)); await sleep(1200);
  await evaluate(`window.__store.getState().select('t1'); 1`); await sleep(1500);
  await shot(`mail-${k}`);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'appearance', nonce: Date.now() }); 1`); await sleep(1000);
  await shot(`settings-${k}`);
  await evaluate(`window.__store.getState().setDialog(null); 1`); await sleep(300);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }); 1`); await sleep(1500);
  await shot(`compose-${k}`);
  await evaluate(`window.__store.getState().setModule('calendar'); window.__store.getState().setPrefs({ calView: 'month' }); 1`); await sleep(1800);
  await shot(`calendar-${k}`);
}
console.log('HEAVY', JSON.stringify(heavy));
await H.shutdown(); process.exit(0);
