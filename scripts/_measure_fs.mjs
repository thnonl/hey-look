import fs from 'node:fs';
import { sleep, startHarness, arg } from './cdp-harness.mjs';
const H = await startHarness('measure-fs', { vitePort0: 5810 });
const { evaluate, cdp } = H;
const out = {};
for (const theme of ['light', 'dark']) {
  await H.openApp(`lang=en&${theme}&nativemenu=off`, 1280, 800);
  await sleep(1500);
  await evaluate(`window.__store.getState().select(window.__store.getState().threads?.[0]?.threadId ?? null); 1`).catch(() => {});
  await sleep(1200);
  const m = JSON.parse(await evaluate(`JSON.stringify((() => { const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height * 10) / 10 : null; }; const fs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).fontSize : null; };
    const rows = [...document.querySelectorAll('.ml-row')].slice(0, 5).map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
    return { root: getComputedStyle(document.documentElement).fontSize, rootLine: getComputedStyle(document.documentElement).lineHeight, listRows: rows, topbar: h('.topbar'), btn: h('.btn'), iconBtn: h('.icon-btn'), mlSubject: fs('.ml-row .subject'), mlWho: fs('.ml-row .who'), folderRow: h('.fp-row'), bodyFont: fs('body'), rpBody: fs('.rp-body'), subjectH: h('.ml-row .subject'), whoH: h('.ml-row .who'), tab: h('.ml-tab, .tabs button') }; })())`));
  out[theme] = m;
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg('shot') + '-' + theme + '.png', Buffer.from(shot.data, 'base64'));
}
console.log(JSON.stringify(out));
await H.shutdown(); process.exit(0);
