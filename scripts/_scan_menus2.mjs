import { sleep, startHarness, languageJs, arg } from './cdp-harness.mjs';
const H = await startHarness('scan-menus2', { vitePort0: 5840 });
const { evaluate, cdp } = H;
const lang = arg('lang') || 'ru';
await H.openApp(`lang=en&light&nativemenu=off`, 1280, 800);
await sleep(1500);
await evaluate(languageJs(lang)); await sleep(800);
await evaluate(`window.__store.getState().select('t1'); 1`); await sleep(1500);
const realClickAt = async (p) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1] }); await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 }); };
const esc = async () => { for (let i = 0; i < 2; i++) { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(120); } };
const POS = (i) => `(() => { const bs = [...document.querySelectorAll('.rp-actions button, .rp-msg button, .reading button, header button, .toolbar button, .ml-head button, button')].filter((b) => b.offsetParent && b.getBoundingClientRect().width > 0); const b = bs[${i}]; if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, n: bs.length, label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30), pop: b.getAttribute('aria-haspopup') }); })()`;
const SCAN = `JSON.stringify([...document.querySelectorAll('.dd-fixed, .ctx-menu, [role=menu]')].flatMap((m) => [...m.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 0.5 && e.children.length === 0 && e.textContent.trim()).map((e) => e.textContent.trim().slice(0, 50) + ' ' + e.scrollWidth + '/' + e.clientWidth)).concat([...document.querySelectorAll('.dd-fixed, .ctx-menu, [role=menu]')].filter((m) => m.scrollWidth > m.clientWidth + 0.5).map((m) => 'MENU ' + m.scrollWidth + '/' + m.clientWidth)))`;
const fresh = async () => { await H.openApp(`lang=en&light&nativemenu=off`, 1280, 800); await sleep(900); await evaluate(languageJs(lang)); await sleep(600); await evaluate(`window.__store.getState().select('t1'); 1`); await sleep(1000); };
await fresh();
const n0 = JSON.parse(await evaluate(POS(0))).n;
const res = {}, opened = {};
for (let i = 0; i < n0; i++) {
  if (i > 0) await fresh();
  const p = JSON.parse((await evaluate(POS(i))) || 'null'); if (!p) continue;
  await realClickAt([p.x, p.y]); await sleep(300);
  const cnt = await evaluate(`document.querySelectorAll('.dd-fixed, .ctx-menu, [role=menu]').length`);
  if (cnt) { opened[p.label] = await evaluate(`document.querySelectorAll('[role^=menuitem]').length`); const r = JSON.parse(await evaluate(SCAN)); if (r.length) res[p.label] = r; }
  await esc();
}
console.log('OPENED', JSON.stringify(opened)); console.log('OVER', JSON.stringify(res, null, 1));
await H.shutdown(); process.exit(0);
