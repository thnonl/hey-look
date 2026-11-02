import { sleep, startHarness, languageJs, arg } from './cdp-harness.mjs';
const H = await startHarness('scan-menus', { vitePort0: 5820 });
const { evaluate, cdp } = H;
const lang = arg('lang') || 'ru';
await H.openApp(`lang=en&light&nativemenu=off`, 1280, 800);
await sleep(1500);
await evaluate(languageJs(lang)); await sleep(800);
const SCAN = `(() => { const out = []; for (const e of document.querySelectorAll('[role^=menuitem], .ctx-menu button, .dd-fixed button, .dd-fixed [role], .menu-row')) { if (e.scrollWidth > e.clientWidth + 0.5 || [...e.querySelectorAll('*')].some((c) => c.scrollWidth > c.clientWidth + 0.5 && getComputedStyle(c).overflow !== 'visible')) out.push({ t: e.textContent.trim().slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth, cls: e.className.toString().slice(0, 30), inner: [...e.querySelectorAll('*')].filter((c) => c.scrollWidth > c.clientWidth + 0.5).map((c) => c.className.toString().slice(0, 20) + ':' + c.scrollWidth + '/' + c.clientWidth).join(',') }); } return out; })()`;
const results = {};
const seen = {}; const check = async (name) => { await sleep(250); seen[name] = await evaluate(`document.querySelectorAll('[role^=menuitem], .ctx-menu button, .dd-fixed button').length`); const r = JSON.parse(await evaluate(`JSON.stringify(${SCAN})`)); if (r.length) results[name] = r; };
const realClick = async (sel) => { const p = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`); if (!p) return; await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1] }); await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 }); };
const esc = async () => { await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(150); };
const views = [['mail', `window.__store.getState().setModule('mail'); window.__store.getState().select('t1'); 1`], ['calendar', `window.__store.getState().setModule('calendar'); 1`]];
for (const [vn, setup] of views) {
  await evaluate(setup); await sleep(1500);
  const btns = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('button[aria-haspopup], .dd-wrap > button, .rb.more, .icon-btn[aria-expanded]')].map((b, i) => { b.setAttribute('data-scan', String(i)); return [i, (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)]; }))`));
  for (const [i, label] of btns) {
    await realClick(`[data-scan="${i}"]`);
    await check(`${vn}: button ${label}`);
    await esc(); await esc();
  }
  // context menus
  for (const sel of ['.ml-row', '.fp-row', '.fp-head', '.fp-group']) {
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 0; const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10, button: 2 })); return 1; })()`);
    await check(`${vn}: right-click ${sel}`);
    await esc();
  }
}
await evaluate(`window.__store.getState().setModule('mail'); 1`); await sleep(500); await evaluate(`window.__store.getState().select('t1'); 1`); await sleep(800);
for (const sel of ['.compose-btn, button[aria-label="Compose"], .fp-compose, [data-testid=compose]']) await evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {click(){}}).click(); 1`);
await sleep(1500);
{ const btns = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.compose-pane button[aria-haspopup], .compose-pane .rb.more, .compose-pane .dd-wrap > button, .compose-pane .split-btn button:last-child')].map((b, i) => { b.setAttribute('data-scan2', String(i)); return [i, (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)]; }))`)); for (const [i, label] of btns) { await evaluate(`(() => { const b = document.querySelector('[data-scan2="${i}"]'); if (b) b.click(); return 1; })()`); await check('compose: ' + label); await esc(); await esc(); } }
await evaluate(`window.__store.getState().setModule('mail'); 1`);
console.log(JSON.stringify(results, null, 1)); console.log('SEEN', JSON.stringify(seen));
await H.shutdown(); process.exit(0);
