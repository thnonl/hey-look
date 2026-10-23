// The probe of Reply / Reply all / Forward (1.0.7 W13.13, D-064; test-reply-feedback.mjs; WebKit rows WK-F28.xx in webkit-checks-107.md). DOM only; it installs a recorder in the
// page (nothing is kept after a reload) and reads it back, in three bridge calls so that nothing waits inside the page (scripts/test-bridge.md):
//   INSTALL  puts the recorder in: a MutationObserver, a frame loop and a 20 ms timer that note, in ms from the press (the first mousedown / keydown, or PRESS below):
//              shellMs      the compose pane is on screen (a frame after the press: the shell opens at once, REQ-13.13.1; <= 200 in the pane)
//              statusMs     the status "Preparing reply…" / "Preparing forward…" (role=status, aria-busy) is on screen (null when the compose filled before 100 ms: no flash)
//              statusGoneMs the status is gone again
//              filledMs     the quote is in the editor and the To field is enabled (the compose is complete)
//              pressMs      the pressed button shows its pending state (aria-busy) or the compose pane is there instead of it
//              gapMax       the longest wait of the 20 ms timer (WebKit has no long-task API); longTaskMax: the longest long task (Chromium only, else null)
//              toBefore / toAfter  the box of the To field in the shell and after the fill (x, y, w, h): the same +- 1 px
//              shellState   what the shell looked like: To disabled, Send disabled, the toolbar inert, the status text
//   (the person presses Reply / Reply all / Forward in the reading pane: a real click or key, or `PRESS` below)
//   READ     returns the recorder
//   node scripts/lib/reply-open-probe.mjs <data folder | test-bridge.json | port:token> [window=main] [button=Reply]
// runs the three calls with a click on the first button named like that in the open message and waits (up to 60 s) until the compose is filled; prints the recorder.
export const PROBE_INSTALL = `
if (window.__replyOpen && window.__replyOpen.stop) window.__replyOpen.stop();
const rec = window.__replyOpen = { t0: 0, shell: null, status: null, statusGone: null, filled: null, press: null, gaps: [], last: performance.now(), longTaskMax: null, toBefore: null, toAfter: null, shellState: null, statusText: null };
const pane = () => document.querySelector('.compose-pane');
const toBox = () => { const f = pane()?.querySelectorAll('.cp-fields .cf-field')[1]; if (!f) return null; const r = f.getBoundingClientRect(); return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
const look = () => {
  if (!rec.t0) return;
  const t = Math.round(performance.now() - rec.t0);
  const p = pane();
  if (rec.shell === null && p) {
    rec.shell = t;
    rec.toBefore = toBox();
    const to = p.querySelectorAll('.cp-fields .cf-field')[1];
    rec.shellState = { preparing: p.classList.contains('preparing'), toDisabled: !!to && (to.hasAttribute('inert') || !!to.closest('[inert]') || !!to.querySelector('input:disabled')), sendDisabled: !!p.querySelector('.split-btn .btn.primary')?.disabled };
  }
  const st = p && [...p.querySelectorAll('[role=status][aria-busy=true]')].find((e) => /\\u2026|\\.\\.\\./.test(e.textContent || ''));
  if (rec.status === null && st) { rec.status = t; rec.statusText = st.textContent.trim(); }
  if (rec.status !== null && rec.statusGone === null && !st) rec.statusGone = t;
  const quote = !!p?.querySelector('.cp-editor .quote-block');
  const toOn = p && !p.classList.contains('preparing');
  if (rec.shell !== null && rec.filled === null && quote && toOn) { rec.filled = t; rec.toAfter = toBox(); }
};
const mo = new MutationObserver(look); mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
let raf = 0; const loop = () => { look(); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop);
const iv = setInterval(() => { const n = performance.now(); rec.gaps.push(Math.round(n - rec.last)); rec.last = n; look(); }, 20);
let po = null; try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.longTaskMax = Math.max(rec.longTaskMax || 0, Math.round(e.duration)); }); po.observe({ entryTypes: ['longtask'] }); } catch (e) { po = null; }
const press = () => { if (!rec.t0) { rec.t0 = performance.now(); rec.last = rec.t0; } };
document.addEventListener('mousedown', press, true); document.addEventListener('keydown', press, true);
rec.stop = () => { mo.disconnect(); clearInterval(iv); cancelAnimationFrame(raf); try { po && po.disconnect(); } catch (e) {} document.removeEventListener('mousedown', press, true); document.removeEventListener('keydown', press, true); };
return { installed: true };
`;

/** Presses the first button named __BUTTON__ (aria-label or text) by \`.click()\` (a synthetic press: the recorder's clock starts with it). */
export const PROBE_PRESS = `
const want = __BUTTON__;
const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent || '').trim() === want);
if (!b) return { pressed: false };
window.__replyOpen.t0 = performance.now(); window.__replyOpen.last = window.__replyOpen.t0;
window.__replyOpen.pressTarget = b;
b.click();
requestAnimationFrame(() => { const r = window.__replyOpen; if (r && r.press === null) r.press = Math.round(performance.now() - r.t0); });
return { pressed: true };
`;

export const PROBE_READ = `
const rec = window.__replyOpen;
if (!rec) return { error: 'not installed' };
const { shell, status, statusGone, filled, press, gaps, longTaskMax, toBefore, toAfter, shellState, statusText } = rec;
const moved = toBefore && toAfter ? Math.max(Math.abs(toBefore.x - toAfter.x), Math.abs(toBefore.y - toAfter.y), Math.abs(toBefore.w - toAfter.w), Math.abs(toBefore.h - toAfter.h)) : null;
return { shellMs: shell, statusMs: status, statusGoneMs: statusGone, filledMs: filled, pressMs: press, statusText, shellState, gapMax: Math.max(0, ...gaps), longTaskMax, toBefore, toAfter, toMovedPx: moved, ua: navigator.userAgent };
`;

export const fill = (body, button) => body.replaceAll('__BUTTON__', JSON.stringify(button));

if (process.argv[1] && process.argv[1].endsWith('reply-open-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main', button = 'Reply'] = process.argv.slice(2);
  if (!where) { console.error('usage: node scripts/lib/reply-open-probe.mjs <data folder | test-bridge.json | port:token> [window=main] [button=Reply]  (open a message first)'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const b = bridge(conn);
  const run = (body) => b.evalIn(win, body, { timeoutMs: 15000 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await run(PROBE_INSTALL);
  const pr = await run(fill(PROBE_PRESS, button));
  if (!pr.pressed) { console.log(JSON.stringify({ error: `no button "${button}" in an open message` })); process.exit(1); }
  let res = null;
  for (let i = 0; i < 120; i++) {
    await wait(500);
    res = await run(PROBE_READ);
    if (res.filledMs !== null) break;
  }
  await wait(600);
  res = await run(PROBE_READ);
  const pass = res.shellMs !== null && res.shellMs <= 200 && res.filledMs !== null && (res.toMovedPx === null || res.toMovedPx <= 1) && res.gapMax < 500 && (res.statusMs === null || res.statusMs <= 150);
  console.log(JSON.stringify({ ...res, pass }, null, 2));
  process.exit(pass ? 0 : 1);
}

/**
 * How fast this page runs, measured in the page itself (the timing tests scale their budgets by it, so a slow shared runner is not a failure): the median of 7 round trips of
 * a frame callback + a task (`frame`), and of 5 runs of a fixed piece of main-thread work, 6000 elements parsed, attached and laid out (`cpu`). Returns { frame, cpu } in ms.
 */
export const CALIBRATE = `(async () => {
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const frames = [], cpus = [];
  for (let i = 0; i < 7; i++) { const t = performance.now(); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); frames.push(performance.now() - t); }
  for (let i = 0; i < 5; i++) { const t = performance.now(); const d = document.createElement('div'); d.innerHTML = '<p>x <b>y</b> <i>z</i></p>'.repeat(6000); document.body.appendChild(d); d.offsetHeight; d.remove(); cpus.push(performance.now() - t); }
  return { frame: Math.round(med(frames) * 10) / 10, cpu: Math.round(med(cpus) * 10) / 10 };
})()`;
