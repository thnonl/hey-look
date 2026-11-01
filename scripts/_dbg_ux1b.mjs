import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-ux1b', { vitePort0: 5795 });
const { evaluate } = H;
await H.openApp('light&lang=en&nativemenu=off', 1280, 800);
console.log(await evaluate(`(() => { const out = {}; const mk = (k, h) => { const d = document.createElement('div'); d.innerHTML = h; document.body.append(d); const i = d.firstChild; const r = i.getBoundingClientRect(); out[k] = Math.round(r.width)+'x'+Math.round(r.height)+' c='+i.complete+' nw='+i.naturalWidth; };
 mk('nosrc-alt-size','<img alt="logo" width="200" height="80">'); mk('nosrc-noalt-size','<img width="200" height="80">'); mk('nosrc-noalt','<img>'); mk('nosrc-emptyalt-size','<img alt="" width="200" height="80">'); mk('src-empty-size','<img src="" alt="logo" width="200" height="80">'); mk('bad-src','<img src="data:image/png;base64,AAAA" alt="logo" width="200" height="80">'); return JSON.stringify(out); })()`));
await H.shutdown(); process.exit(0);
