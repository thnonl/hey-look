// scratch (not committed): does an iframe flash white while its srcdoc is being committed? which style avoids it? (fix32)
import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('fix32-exp', { vitePort0: 5750 });
const { evaluate, cdp } = H;
await cdp('Emulation.setCPUThrottlingRate', { rate: 4 });
const dom = (b64) => `new Promise((ok) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; const i = (c.width * (c.height >> 1) + (c.width >> 1)) * 4; ok([d[i], d[i + 1], d[i + 2]]); }; im.src = 'data:image/jpeg;base64,${b64}'; })`;
const DOC = (extraHead = '') => `<!doctype html><html class="hm-dark"><head><meta charset="utf-8">${extraHead}<style>html.hm-dark{color-scheme:dark;--bg:rgb(27,28,32)}body{background:var(--bg);color:#eee;margin:0}</style></head><body>${'<p>some text of the mail</p>'.repeat(300)}</body></html>`;
const variants = {
  'A bg dark': { style: 'background:rgb(27,28,32)', doc: DOC() },
  'B bg dark + element color-scheme dark': { style: 'background:rgb(27,28,32);color-scheme:dark', doc: DOC() },
  'C bg dark + meta color-scheme dark first': { style: 'background:rgb(27,28,32)', doc: DOC('<meta name="color-scheme" content="dark">') },
  'D bg dark + element dark + meta dark': { style: 'background:rgb(27,28,32);color-scheme:dark', doc: DOC('<meta name="color-scheme" content="dark">') },
  'E bg dark + doc starts with inline style on html': { style: 'background:rgb(27,28,32)', doc: DOC().replace('<html class="hm-dark">', '<html class="hm-dark" style="background:rgb(27,28,32)">') },
};
for (const scheme of ['light', 'dark']) {
  await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await H.openApp('lang=en', 1280, 900);
  await evaluate(`window.__store.getState().setPrefs({ theme: '${scheme}' }); 1`);
  await sleep(300);
  for (const [name, v] of Object.entries(variants)) {
    let whites = 0, total = 0, kinds = new Set();
    for (let rep = 0; rep < 4; rep++) {
      await evaluate(`(() => { document.querySelectorAll('.exp').forEach((e) => e.remove()); const f = document.createElement('iframe'); f.className = 'exp'; f.setAttribute('sandbox', 'allow-same-origin'); f.style.cssText = 'position:fixed;left:100px;top:100px;width:300px;height:200px;border:0;z-index:99999;${v.style}'; document.body.appendChild(f); f.srcdoc = ${JSON.stringify(v.doc)}; return 1; })()`);
      const end = Date.now() + 700;
      while (Date.now() < end) {
        const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 40, clip: { x: 100, y: 100, width: 300, height: 200, scale: 0.25 } });
        const c = await evaluate(dom(s.data));
        total++; kinds.add(c.map((x) => x >> 4).join(','));
        if (c[0] > 200 && c[1] > 200) whites++;
      }
    }
    console.log(scheme.padEnd(5), name.padEnd(48), `white ${whites}/${total}`, [...kinds].join(' | '));
  }
}
await H.shutdown();
