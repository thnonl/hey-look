#!/usr/bin/env node
// 1.0.12: an unread row of the message list has a faint accent tint behind it besides the dot, the 600 sender and the accent subject (the weights are capped at 600). No layout effect; hover and
// selected win over the tint and stay different from it; the text keeps 4.5:1 on the tint in light and dark, in every accent colour of the app, in Comfortable and Compact.
//   node scripts/test-unread-tint.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import { sleep, startHarness } from './cdp-harness.mjs';

const ACCENTS = ['#0f6cbd', '#0e7c86', '#1a7f4b', '#6d4aff', '#c2327d', '#c4570c', '#475569'];
const H = await startHarness('test-unread-tint', { vitePort0: 5190 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures.push(m); console.error('FAIL', m); } };
const until = async (expr, ms = 8000) => { for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { let v = false; try { v = await evaluate(`!!(${expr})`); } catch { /* between renders */ } if (v) return true; } return false; };
// colours as the page computes them (rgb() or color(srgb r g b), a custom colour space result of color-mix) -> [r, g, b] 0..255, alpha ignored (the row is opaque)
const PARSE = String.raw`const px = (c) => { let m = /rgba?\(([^)]+)\)/.exec(c); if (m) return m[1].split(/[ ,\/]+/).filter(Boolean).slice(0, 3).map(Number); m = /color\(srgb ([^)]+)\)/.exec(c); if (m) return m[1].split(/[ \/]+/).filter(Boolean).slice(0, 3).map((v) => Math.round(parseFloat(v) * 255)); return null; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };`;
const probe = (sel) => `(() => { ${PARSE} const r = document.querySelector(${JSON.stringify(sel)}); if (!r) return null; const bg = px(getComputedStyle(r).backgroundColor); const col = (s) => { const e = r.querySelector(s); return e ? px(getComputedStyle(e).color) : null; };
  const out = { bg, h: Math.round(r.getBoundingClientRect().height * 10) / 10, bl: getComputedStyle(r).borderLeftColor, w: Math.round(r.getBoundingClientRect().width) };
  for (const s of ['.who', '.subject', '.preview', '.date']) { const c = col(s); out[s] = c && bg ? Math.round(ratio(c, bg) * 100) / 100 : null; }
  return JSON.stringify(out); })()`;
const mouse = async (p, type) => cdp('Input.dispatchMouseEvent', { type, x: p[0], y: p[1] });
try {
  await H.openApp('lang=en&nativemenu=off', 1280, 800);
  await until(`window.__store.getState().loaded === true`, 20000);
  await sleep(1500);
  for (const theme of ['light', 'dark']) for (const density of ['comfortable', 'compact']) for (const accent of ACCENTS) {
    const tag = `${theme} ${density} ${accent}`;
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, density: ${JSON.stringify(density)}, accent: ${JSON.stringify(accent)} }); window.__store.getState().select(null); 1`);
    await sleep(350);
    ok(await until(`document.querySelector('.ml-row.unread') && document.querySelector('.ml-row:not(.unread)')`), `${tag}: the list has an unread and a read row`);
    const u = JSON.parse(await evaluate(probe('.ml-row.unread:not(.selected)')));
    const r = JSON.parse(await evaluate(probe('.ml-row:not(.unread):not(.selected)')));
    ok(u && r && JSON.stringify(u.bg) !== JSON.stringify(r.bg), `${tag}: the unread row has another background than a read row (${u && u.bg} / ${r && r.bg})`);
    ok(u.h > 0 && u.w === r.w, `${tag}: no width change`);
    if (process.env.VERBOSE) console.log(tag, JSON.stringify({ u, r: r.bg }));
    for (const s of ['.who', '.subject', '.preview', '.date']) ok((u[s] !== null || (s === '.preview' && density === 'compact')) && (u[s] === null || u[s] >= 4.5), `${tag}: ${s} of an unread row has ${u[s]}:1 on the tint (need 4.5)`);
    // only one theme/accent walk of hover and selected (they do not depend on the accent being different)
    if (accent === ACCENTS[0] && density === 'comfortable') {
      const at = await evaluate(`(() => { const r = document.querySelector('.ml-row.unread'); r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return [b.left + b.width * 0.7, b.top + b.height / 2]; })()`);
      await mouse(at, 'mouseMoved'); await sleep(250);
      const hov = JSON.parse(await evaluate(probe('.ml-row.unread:hover')));
      ok(hov && JSON.stringify(hov.bg) !== JSON.stringify(u.bg), `${tag}: hover beats the tint (${hov && hov.bg} / ${u.bg})`);
      await mouse([5, 5], 'mouseMoved');
      const id = await evaluate(`(() => { const r = document.querySelector('.ml-row.unread'); return r.getAttribute('data-thread') || null; })()`);
      await evaluate(`document.querySelector('.ml-row.unread').click(); 1`);
      await sleep(500);
      await mouse([5, 5], 'mouseMoved'); await sleep(150);
      const sel = JSON.parse(await evaluate(probe('.ml-row.selected')));
      ok(sel && JSON.stringify(sel.bg) !== JSON.stringify(u.bg) && JSON.stringify(sel.bg) !== JSON.stringify(r.bg), `${tag}: a selected row (which was unread) looks selected, not tinted (${sel && sel.bg}; tint ${u.bg}; read ${r.bg}; ${id})`);
      for (const s of ['.who', '.subject', '.preview', '.date']) ok(sel[s] === null || sel[s] >= 4.5, `${tag}: ${s} of the selected row has ${sel[s]}:1`);
    }
  }
} catch (e) {
  failures.push(String(e && e.stack ? e.stack : e));
  console.error(e);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-unread-tint: FAILED (${failures.length})`); process.exit(1); }
console.log(`test-unread-tint: ok (${checks} checks)`);
process.exit(0);
