// scratch (not committed): hunts the white first frame of a dark mail in the light theme (fix32)
import { arg, sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('fix32-repro', { vitePort0: 5740 });
const { evaluate, cdp } = H;
const N = Number(arg('n') || 10), THR = Number(arg('throttle') || 0);
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
H.net.stub = (u) => { if (!u.includes('/templates/logo.png')) return undefined; return { status: 200, type: 'image/png', body: PNG_1PX, delay: 6000 }; };
if (THR) await cdp('Emulation.setCPUThrottlingRate', { rate: THR });
const REC = `(() => {
  const ids = new WeakMap(); let n = 0; const rec = (window.__rec = []);
  const tick = () => {
    const f = document.querySelector('.msg-frame'); const e = { t: Math.round(performance.now()), ov: !!document.querySelector('.rp-opening') };
    if (f) {
      const r = f.getBoundingClientRect(); const d = f.contentDocument;
      e.rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; e.fbg = getComputedStyle(f).backgroundColor;
      if (d && d.documentElement) { if (!ids.has(d)) ids.set(d, ++n); e.doc = ids.get(d); e.rs = d.readyState; e.cls = d.documentElement.className; e.vis = d.body ? getComputedStyle(d.body).visibility : '-'; e.hbg = getComputedStyle(d.documentElement).backgroundColor; e.bbg = d.body ? getComputedStyle(d.body).backgroundColor : '-'; e.len = d.body ? d.body.textContent.length : -1; e.src = f.srcdoc ? f.srcdoc.length : 0; }
    } else e.noframe = true;
    rec.push(e); if (rec.length > 4000) rec.shift(); requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;
const dom = (b64) => `new Promise((ok) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data, seen = new Map(); for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3); seen.set(k, (seen.get(k) || 0) + 1); } let top = 0, tn = 0; for (const [k, n] of seen) if (n > tn) { top = k; tn = n; } ok([ (top >> 10 & 31) << 3, (top >> 5 & 31) << 3, (top & 31) << 3 ]); }; im.src = 'data:image/jpeg;base64,${b64}'; })`;
let bad = 0;
for (let i = 1; i <= N; i++) {
  await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await H.openApp('lang=en', 1280, 900);
  await evaluate(`window.__store.getState().setPrefs({ theme: 'light', mailCanvas: 'dark', loadRemote: true }); 1`);
  await evaluate(REC);
  const t0 = await evaluate('performance.now()');
  await evaluate(`window.__store.getState().select('dk11'); 1`);
  const shots = [];
  const end = Date.now() + 3500;
  while (Date.now() < end) {
    const r = await evaluate(`(() => { const f = document.querySelector('.msg-frame'); if (!f) return null; const b = f.getBoundingClientRect(); return [b.left, b.top, b.width, Math.min(b.height, innerHeight - b.top, 300), performance.now(), !!document.querySelector('.rp-opening')]; })()`);
    if (!r || r[2] < 10 || r[3] < 10) { await sleep(10); continue; }
    const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 40, clip: { x: Math.max(0, r[0]), y: Math.max(0, r[1]), width: r[2], height: Math.max(10, r[3]), scale: 0.25 } });
    const col = await evaluate(dom(s.data)); const ov2 = await evaluate("!!document.querySelector('.rp-opening')");
    shots.push({ t: Math.round(r[4]), col, ov: r[5] || ov2 });
  }
  const white = shots.filter((s) => s.col[0] > 200 && s.col[1] > 200); const whiteNoOv = white.filter((s) => !s.ov); console.log('   whites with the Opening block up:', white.length - whiteNoOv.length, 'without:', whiteNoOv.length, 'blockshots', shots.filter((s) => s.ov).length, JSON.stringify(shots.filter((s) => s.ov).map((s) => s.col)).slice(0, 120));
  console.log(`run ${i}: ${shots.length} shots, first ${JSON.stringify(shots[0])}, white ${white.length}`);
  if (white.length) {
    bad++;
    const rec = await evaluate('window.__rec');
    const w0 = white[0].t;
    console.log('  WHITE at', w0, 'since select', Math.round(w0 - t0));
    console.log('  rec around:\n   ' + rec.filter((e) => e.t >= w0 - 120 && e.t <= w0 + 60).map((e) => JSON.stringify(e)).join('\n   '));
    console.log('  doc changes:\n   ' + rec.filter((e, j) => j === 0 || e.doc !== rec[j - 1].doc || e.cls !== rec[j - 1].cls || e.vis !== rec[j - 1].vis || e.noframe !== rec[j - 1].noframe).slice(0, 25).map((e) => JSON.stringify(e)).join('\n   '));
  }
}
console.log(`done: ${bad} of ${N} runs had a white frame`);
await H.shutdown();
