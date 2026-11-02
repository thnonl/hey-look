import fs from 'node:fs';
import { startHarness } from './cdp-harness.mjs';
const RAW = 'E:/hey-mail/test-builds/v1012-weights/raw', OUT = 'E:/hey-mail/test-builds/v1012-weights/final';
const TAGS = [['inter', 'Inter 1.0.11'], ['final', "B' final (550 primary button and name)"]];
const H = await startHarness('montage', { vitePort0: 5990 });
const { evaluate } = H;
await H.openApp('lang=en', 800, 600);
const b64 = (f) => fs.readFileSync(f).toString('base64');
const jobs = [];
for (const screen of ['mail', 'settings', 'compose', 'calendar']) for (const th of ['light', 'dark']) for (const lg of ['en', 'vi']) jobs.push({ screen, k: `${th}-${lg}`, crop: null });
for (const th of ['light', 'dark']) for (const lg of ['en', 'vi']) jobs.push({ screen: 'mail', k: `${th}-${lg}`, crop: [0, 0, 280, 800], name: 'folderpane' });
for (const j of jobs) {
  const imgs = TAGS.map(([t]) => `data:image/png;base64,${b64(`${RAW}/${t}-${j.screen}-${j.k}.png`)}`);
  const png = await evaluate(`(async () => {
    const load = (u) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = u; });
    const ims = await Promise.all(${JSON.stringify(imgs)}.map(load));
    const labels = ${JSON.stringify(TAGS.map((t) => t[1]))};
    const crop = ${JSON.stringify(j.crop)};
    const sw = crop ? crop[2] : 1280, sh = crop ? crop[3] : 800, sc = crop ? 1 : 0.7, gap = 8, lab = 28;
    const w = Math.round(sw * sc), h = Math.round(sh * sc);
    const c = document.createElement('canvas'); c.width = (w + gap) * ims.length - gap; c.height = h + lab;
    const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, c.width, c.height);
    ims.forEach((im, i) => { const x = i * (w + gap); g.drawImage(im, crop ? crop[0] : 0, crop ? crop[1] : 0, sw, sh, x, lab, w, h); g.fillStyle = '#fff'; g.font = 'bold 16px sans-serif'; g.fillText(labels[i], x + 6, 20); });
    return c.toDataURL('image/png').split(',')[1]; })()`);
  fs.writeFileSync(`${OUT}/${j.name || j.screen}-${j.k}.png`, Buffer.from(png, 'base64'));
}
console.log(jobs.length, 'images');
await H.shutdown(); process.exit(0);
