import { sleep, startHarness } from './cdp-harness.mjs';
const H = await startHarness('dbg-ux1', { vitePort0: 5790 });
const { evaluate, cdp } = H;
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__remoteFetchDelayMs = 1500;` });
const u = (n) => `https://img.shop.example/${n}.png`;
const THREADS = [
  ['pM', 'Three', { fromName: 'Shop', fromEmail: 'three@shop.example', html: `<p>Look</p><img src="${u('m1')}" width="200" height="80" alt="one"><img src="${u('m2')}" width="200" height="80" alt="two"><img src="${u('m3')}" width="200" height="80" alt="three">`, auth: 'pass' }],
  ['pW', 'Written', { fromName: 'Friend', fromEmail: 'friend@example.org', html: `<p>Look</p><img src="${u('w1')}" width="200" height="80" alt="one"><img src="${u('w2')}" alt="two">`, auth: 'pass', autoReason: 'wrote' }],
  ['pF', 'Fail', { fromName: 'Shop', fromEmail: 'f@shop.example', html: `<p>Look</p><img src="${u('unreachable1')}" width="200" height="80" alt="one">`, auth: 'pass' }],
];
await H.openApp('light&lang=en&nativemenu=off', 1280, 800);
await evaluate(`${THREADS.map(([id, s, o]) => `window.__mockAddThread(${JSON.stringify(id)}, ${JSON.stringify(s)}, ${JSON.stringify(o)});`).join(' ')} window.__store.getState().setPrefs({ loadRemote: false }); window.__store.getState().refresh().then(() => 1)`);
await sleep(400);
const FR = `document.querySelector('.rp-msg.open iframe.msg-frame')`;
const snap = `(() => { const d = ${FR}?.contentDocument; if (!d) return 'noframe'; return JSON.stringify({ boxes: [...d.querySelectorAll('.hl-bp')].map(b=>(b.hasAttribute('data-pending')?'P':'')+(b.classList.contains('bad')?'B':'')+':'+b.textContent.trim().slice(0,14)+'@'+Math.round(b.getBoundingClientRect().width)+'x'+Math.round(b.getBoundingClientRect().height)), imgs: [...d.images].map(i=>({s:(i.getAttribute('src')||'').slice(0,10), c:i.complete, w:i.naturalWidth, wait:i.hasAttribute('data-hl-wait'), r:Math.round(i.getBoundingClientRect().width)+'x'+Math.round(i.getBoundingClientRect().height)})) }); })()`;
const open = async (id) => { await evaluate(`window.__store.getState().select(null);1`); await sleep(100); await evaluate(`window.__store.getState().select('${id}');1`); for (let i=0;i<100;i++){ if (await evaluate(`!!${FR}`)) break; await sleep(60);} await sleep(600); };
const watch = async (label, act, ms = 2800) => {
  console.log('==', label);
  let last = '';
  await act();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await evaluate(snap); if (s !== last) { console.log(Date.now() - t0, s); last = s; } await sleep(25); }
};
const click = (i) => evaluate(`(() => { const b = ${FR}.contentDocument.querySelectorAll('.hl-bp')[${i}]; b.click(); return 1; })()`);
await open('pM');
await watch('show one', () => click(1));
await open('pM');
await watch('show pictures link', () => evaluate(`document.querySelector('.rp-msg.open .notice button.link:not([data-trust])').click();1`));
await open('pW');
await watch('auto', () => Promise.resolve(), 3000);
await open('pF');
await watch('fail', () => click(0), 2500);
await H.shutdown();
process.exit(0);
