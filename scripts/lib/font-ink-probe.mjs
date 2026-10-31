// 1.0.12 font change: is the INK of one-line clipped rows (overflow: hidden, the app's .subject.ellipsis) cut? Renders Latin, German, Russian and Vietnamese (stacked marks) samples clipped and unclipped, screenshots both (2x), compares the ink pixels. Pass: clipped ink equals visible ink for every sample. Prints JSON.
//   node scripts/lib/font-ink-probe.mjs [--url=http://127.0.0.1:1420/]
import { startHarness, sleep } from '../cdp-harness.mjs';
const H = await startHarness('font-ink-probe', { vitePort0: 5680 });
const { evaluate, cdp } = H;
const SAMPLES = { vi_stack_caps: 'ẨẤẦẪẬẲẮẰẴẶỂẾỀỄỆỔỐỒỖỘỞỚỜỠỢỬỨỪỮỰ', vi_low: 'ấẩẫậắằẳẵặếềểễệ ỵỷỹ gỵ', latin: 'Äg Ég Åj Ñp ÿ', de: 'ÄÖÜ äöüß gq', ru: 'Йщ Ёё Ђ' };
try {
  await H.openApp('lang=en', 1000, 600);
  const res = {};
  for (const [name, txt] of Object.entries(SAMPLES)) {
    // each wrapper is 60 px tall at a known top; variants: clipped (as in the app) and visible (reference)
    await evaluate(`(() => { document.body.innerHTML=''; document.body.style.cssText='background:#fff;margin:0'; [['hidden',0],['visible',100]].forEach(([ov,top]) => { const d=document.createElement('div'); d.style.cssText='position:absolute;left:10px;width:900px;height:60px;top:'+top+'px;background:#fff;color:#000'; d.dataset.top=top; const s=document.createElement('span'); s.className='subject ellipsis'; s.style.display='block'; s.style.marginTop='20px'; s.style.overflow=ov; s.textContent=${JSON.stringify(txt)}; d.appendChild(s); document.body.appendChild(d); }); })()`);
    await evaluate('document.fonts.ready.then(() => 1)'); await sleep(400);
    const shot = (await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 920, height: 200, scale: 2 } })).data;
    const r = await evaluate(`(async () => { const i = await new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = 'data:image/png;base64,${shot}'; }); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i,0,0); const d = x.getImageData(0,0,i.width,i.height).data; const w = i.width;
      const rows = (y0, y1) => { let mn = 1e9, mx = -1, ink = 0; for (let y = y0; y < y1; y++) for (let xx = 0; xx < w; xx++) if (d[(y*w+xx)*4] < 200) { ink++; mn = Math.min(mn, y); mx = Math.max(mx, y); } return { top: mn/2, bottom: mx/2, ink }; };
      return JSON.stringify({ clipped: rows(0, 190), visible: rows(200, 400) }); })()`);
    res[name] = JSON.parse(r);
  }
  console.log(JSON.stringify(res));
} finally { await H.shutdown(); }
process.exit(0);
