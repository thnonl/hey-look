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
  // (owner, 1.0.12) a READ row is not bold: sender and subject (and the preview and the date) are 400 at rest, hovered and selected, in the Inbox, Sent and Drafts, light and dark, Comfortable and
  // Compact; an unread row keeps its emphasis (sender 600, subject 500)
  const WEIGHTS = `JSON.stringify([...document.querySelectorAll('.ml-row')].map((r) => ({ un: r.classList.contains('unread'), sel: r.classList.contains('selected'), w: Object.fromEntries(['.who', '.subject', '.preview', '.date'].map((s) => [s, r.querySelector(s) ? getComputedStyle(r.querySelector(s)).fontWeight : null])), row: getComputedStyle(r).fontWeight })))`;
  for (const theme of ['light', 'dark']) for (const density of ['comfortable', 'compact']) for (const view of ['inbox', 'sent', 'drafts']) {
    const tag = `weights ${theme} ${density} ${view}`;
    await evaluate(`(() => { const s = window.__store.getState(); s.setPrefs({ theme: ${JSON.stringify(theme)}, density: ${JSON.stringify(density)} }); s.setView(${JSON.stringify(view)}, s.accounts[0].id); s.select(null); return 1; })()`);
    await sleep(700);
    const rowsOf = async () => JSON.parse(await evaluate(WEIGHTS));
    let rows = await rowsOf();
    // (Sent and Drafts have rows in some mailboxes of the mock only: the first one that has some)
    for (let i = 1; view !== 'inbox' && rows.length === 0 && i < 6; i++) {
      await evaluate(`(() => { const s = window.__store.getState(); if (!s.accounts[${i}]) return 0; s.setView(${JSON.stringify(view)}, s.accounts[${i}].id); s.select(null); return 1; })()`);
      await sleep(600);
      rows = await rowsOf();
    }
    if (view !== 'inbox' && rows.length === 0) { console.log(`${tag}: no rows in any mailbox of the mock (skipped)`); continue; }
    ok(rows.length > 2 || view !== 'inbox', `${tag}: the list has rows (${rows.length})`);
    const readWeights = (rs, what) => { for (const r of rs.filter((x) => !x.un)) for (const [s, w] of Object.entries(r.w)) ok(w === null || w === '400', `${tag} ${what}: a read row's ${s} is ${w}, not 400`); for (const r of rs.filter((x) => !x.un)) ok(r.row === '400', `${tag} ${what}: a read row inherits ${r.row}`); };
    readWeights(rows, 'at rest');
    for (const r of rows.filter((x) => x.un)) { ok(r.w['.who'] === '600' && r.w['.subject'] === '500', `${tag}: an unread row keeps its emphasis (${r.w['.who']} / ${r.w['.subject']})`); }
    // hovered read row
    const at = await evaluate(`(() => { const r = [...document.querySelectorAll('.ml-row:not(.unread)')][0]; if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return [b.left + b.width * 0.5, b.top + b.height / 2]; })()`);
    if (at) { await mouse(at, 'mouseMoved'); await sleep(250); readWeights(await rowsOf(), 'hovered'); await mouse([5, 5], 'mouseMoved'); }
    // a selected read row
    if (at) { await evaluate(`[...document.querySelectorAll('.ml-row:not(.unread)')][0].click(); 1`); await sleep(500); rows = await rowsOf(); ok(rows.some((r) => r.sel && !r.un), `${tag}: a read row is selected`); readWeights(rows, 'selected'); }
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
