// The probe of a mail that opens in the reading pane (1.0.7 W13.6, REQ-13.6.1; test-open-loading.mjs; the WebKit rows of webkit-checks-107.md section 31). DOM only: it installs a recorder in the page
// (nothing is kept after a reload) and reads it back, in separate bridge calls so that nothing waits inside the page (scripts/test-bridge.md):
//   INSTALL  puts the recorder in: a MutationObserver, a frame loop and a 20 ms timer that note, in ms from the press (PRESS below, or the first mousedown / keydown):
//              statusMs      the status "Opening message…" (.rp-opening, role=status, aria-busy) is on screen (null: it never showed, a quick open must not flash)
//              statusGoneMs  the status is gone again (it stays at least 300 ms once shown)
//              frameMs       the frame of the open message is visible (a .msg-frame whose visibility is not hidden)
//              gapMax        the longest wait of the 20 ms timer (WebKit has no long-task API); longTaskMax: the longest long task (Chromium only, else null)
//              marks         the phases the app marks when window.__hlMarks is set: thread (get_thread), clean (DOMPurify), pics (placeholders), dark (buildDarkSheet), shown (first measurement), in ms from the press
//   READ     returns the recorder
// The press is PRESS: `window.__store.getState().select(id)` (the debug build and the dev preview expose the store) or a real click on the row, with the recorder started by the click itself.
export const PROBE_INSTALL = `
if (window.__openMail && window.__openMail.stop) window.__openMail.stop();
window.__hlMarks = true;
performance.clearMarks();
const rec = window.__openMail = { t0: 0, status: null, statusGone: null, frame: null, gaps: [], last: performance.now(), longTaskMax: null, statusText: null, statusBusy: null };
const look = () => {
  if (!rec.t0) return;
  const t = Math.round(performance.now() - rec.t0);
  const st = document.querySelector('.rp-body .rp-opening');
  if (rec.status === null && st) { rec.headBox = (() => { const h = document.querySelector('.rp-head'); if (!h) return null; const r = h.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })(); rec.bodyOpening = document.querySelector('.rp-body')?.classList.contains('opening') ?? null; }
  if (rec.status === null && st) { rec.status = t; rec.statusText = st.textContent.trim(); rec.statusBusy = st.getAttribute('aria-busy') === 'true' && st.getAttribute('role') === 'status'; }
  if (rec.status !== null && rec.statusGone === null && !st) rec.statusGone = t;
  const f = document.querySelector('.rp-msg.open .msg-frame');
  if (rec.frame === null && f && getComputedStyle(f).visibility !== 'hidden') rec.frame = t;
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

/** Starts the clock and selects the conversation __ID__ (a synthetic press). */
export const PROBE_PRESS = `
const id = __ID__;
window.__openMail.t0 = performance.now(); window.__openMail.last = window.__openMail.t0;
window.__store.getState().select(id);
return { pressed: true };
`;

export const PROBE_READ = `
const r = window.__openMail;
const m = Object.fromEntries(performance.getEntriesByType('mark').map((e) => [e.name, Math.round(e.startTime - r.t0)]));
const span = (a, b) => (m[a] !== undefined && m[b] !== undefined ? m[b] - m[a] : null);
return {
  statusMs: r.status, statusGoneMs: r.statusGone, frameMs: r.frame, statusText: r.statusText, statusBusy: r.statusBusy,
  gapMax: r.gaps.length ? Math.max(...r.gaps) : null, longTaskMax: r.longTaskMax,
  marks: { threadMs: span('open:thread:start', 'open:thread:end'), cleanMs: span('open:clean:start', 'open:clean:end'), picsMs: span('open:pics:start', 'open:pics:end'), darkMs: span('open:dark:start', 'open:dark:end'), shownAt: m['open:shown'] ?? null, cleanAt: m['open:clean:start'] ?? null },
  statusLeft: !!document.querySelector('.rp-body .rp-opening'), headBox: r.headBox ?? null, bodyOpening: r.bodyOpening ?? null,
  headAfter: (() => { const h = document.querySelector('.rp-head'); if (!h) return null; const x = h.getBoundingClientRect(); return [Math.round(x.top), Math.round(x.height)]; })(),
};
`;

/** Puts the page values into a probe body: __ID__ is the conversation id (a JSON string). */
export const fill = (body, id) => body.replace(/__ID__/g, JSON.stringify(id));

/** Starts the clock and clicks the list row whose text has __SUBJECT__ (a real click on the row of the debug build; nothing needs the store). */
export const PROBE_PRESS_ROW = `
const want = __SUBJECT__;
const row = [...document.querySelectorAll('.ml-row')].find((r) => (r.textContent || '').includes(want));
if (!row) return { pressed: false };
window.__openMail.t0 = performance.now(); window.__openMail.last = window.__openMail.t0;
row.click();
return { pressed: true };
`;

if (process.argv[1] && process.argv[1].endsWith('open-mail-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main', subject = ''] = process.argv.slice(2);
  if (!where || !subject) { console.error('usage: node scripts/lib/open-mail-probe.mjs <data folder | test-bridge.json | port:token> <window=main> "<text of the row to open>"  (the list must show the row)'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const b = bridge(conn);
  const run = (body) => b.evalIn(win, body, { timeoutMs: 15000 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await run(PROBE_INSTALL);
  const pr = await run(PROBE_PRESS_ROW.replaceAll('__SUBJECT__', JSON.stringify(subject)));
  if (!pr.pressed) { console.log(JSON.stringify({ error: `no row with "${subject}"` })); process.exit(1); }
  let res = null;
  for (let i = 0; i < 120; i++) {
    await wait(250);
    res = await run(PROBE_READ);
    if (res.frameMs !== null) break;
  }
  await wait(700);
  res = await run(PROBE_READ);
  const pass = res.frameMs !== null && !res.statusLeft && (res.statusMs === null || (res.statusMs <= 150 && res.statusGoneMs - res.statusMs >= 290)) && res.gapMax < 500;
  console.log(JSON.stringify({ ...res, pass }, null, 2));
  process.exit(pass ? 0 : 1);
}
