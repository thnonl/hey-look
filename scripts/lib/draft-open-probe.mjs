// The probe of the opening of a draft (1.0.7 D-044 / D-045, test-draft-opening.mjs; WebKit rows WK-F5.04 to WK-F5.06 in webkit-checks-107.md). DOM only; it installs a recorder in
// the page (nothing is kept after a reload) and reads it back, in three bridge calls so that nothing waits inside the page (scripts/test-bridge.md):
//   INSTALL  puts the recorder in: a MutationObserver and a frame loop that note, in ms from the press of the mouse, when the row of the draft is `aria-busy`, when the status
//            "Opening ..." is on screen, when the subject and the pictures are in the editor; and a 20 ms timer that notes the longest wait (WebKit has no long-task API)
//   (the person presses the row of the draft in Drafts: a real click or Enter, or `PRESS` below)
//   READ     returns the recorder
//   node scripts/lib/draft-open-probe.mjs <data folder | test-bridge.json | port:token> [window=main] "<subject of the draft>" [pictures=14]
// runs the three calls with a click on the row by `.click()` and waits (up to 90 s) until the draft is open; prints
//   { busyMs, statusMs, doneMs, subjectMs, pictures, gapMax, statusText, rowAfter, pass }
//   busyMs     the row of the draft is aria-busy (ring in place of the date): must be <= 150
//   statusMs   the status "Opening draft..." (role=status) in the pane: <= 150 when the open takes longer than that, null for a quick open (no flash)
//   doneMs     subject and all pictures in the editor: <= 2000 on a release build (1.0.7 target: about 1000 for the 19 MB draft on Windows; Mac / Linux numbers are recorded)
//   gapMax     the longest wait of the 20 ms timer while it opened: < 500
//   rowAfter   the row is not busy any more and shows its date
export const PROBE_INSTALL = `
const SUBJ = __SUBJECT__;
if (window.__draftOpen && window.__draftOpen.stop) window.__draftOpen.stop();
const rec = window.__draftOpen = { t0: 0, busy: null, status: null, statusText: null, subject: null, pictures: 0, done: null, gaps: [], last: performance.now() };
const rowOf = () => [...document.querySelectorAll('.ml-row')].find((r) => r.innerText.includes(SUBJ));
const look = () => {
  if (!rec.t0) return;
  const t = Math.round(performance.now() - rec.t0);
  const r = rowOf();
  if (rec.busy === null && r && r.getAttribute('aria-busy') === 'true') rec.busy = t;
  const st = [...document.querySelectorAll('[role=status]')].find((e) => /\\.\\.\\.|\\u2026/.test(e.textContent || '') && e.getAttribute('aria-busy') === 'true');
  if (rec.status === null && st) { rec.status = t; rec.statusText = st.textContent.trim(); }
  if (rec.subject === null && [...document.querySelectorAll('input')].some((x) => x.value === SUBJ)) rec.subject = t;
  rec.pictures = document.querySelectorAll('.cp-editor img').length;
  if (rec.done === null && rec.subject !== null && rec.pictures >= __PICTURES__) rec.done = t;
};
const mo = new MutationObserver(look); mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
const iv = setInterval(() => { const n = performance.now(); rec.gaps.push(Math.round(n - rec.last)); rec.last = n; look(); }, 20);
const press = () => { if (!rec.t0) { rec.t0 = performance.now(); rec.last = rec.t0; } };
document.addEventListener('mousedown', press, true); document.addEventListener('keydown', press, true);
rec.stop = () => { mo.disconnect(); clearInterval(iv); document.removeEventListener('mousedown', press, true); document.removeEventListener('keydown', press, true); };
return { installed: true, row: !!rowOf() };
`;

/** Presses the row of the draft by `.click()` (a synthetic press: the recorder's clock starts with it). */
export const PROBE_PRESS = `
const r = [...document.querySelectorAll('.ml-row')].find((x) => x.innerText.includes(__SUBJECT__));
if (!r) return { pressed: false };
window.__draftOpen.t0 = performance.now(); window.__draftOpen.last = window.__draftOpen.t0;
r.click();
return { pressed: true };
`;

export const PROBE_READ = `
const rec = window.__draftOpen;
if (!rec) return { error: 'not installed' };
const r = [...document.querySelectorAll('.ml-row')].find((x) => x.innerText.includes(__SUBJECT__));
return { busyMs: rec.busy, statusMs: rec.status, statusText: rec.statusText, subjectMs: rec.subject, doneMs: rec.done, pictures: rec.pictures, gapMax: Math.max(0, ...rec.gaps),
  rowAfter: r ? { busy: r.getAttribute('aria-busy') === 'true', date: (r.querySelector('.date')?.textContent || '').trim() } : null, ua: navigator.userAgent };
`;

export const fill = (body, subject, pictures) => body.replaceAll('__SUBJECT__', JSON.stringify(subject)).replaceAll('__PICTURES__', String(pictures));

if (process.argv[1] && process.argv[1].endsWith('draft-open-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main', subject, pics = '14'] = process.argv.slice(2);
  if (!where || !subject) { console.error('usage: node scripts/lib/draft-open-probe.mjs <data folder | test-bridge.json | port:token> [window] "<subject of the draft>" [pictures]'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const b = bridge(conn);
  const run = (body) => b.evalIn(win, fill(body, subject, Number(pics)), { timeoutMs: 15000 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const inst = await run(PROBE_INSTALL);
  if (!inst.row) { console.log(JSON.stringify({ error: 'the draft has no row in the open folder: open Drafts first' })); process.exit(1); }
  const pr = await run(PROBE_PRESS);
  if (!pr.pressed) { console.log(JSON.stringify({ error: 'no row' })); process.exit(1); }
  let res = null;
  for (let i = 0; i < 180; i++) {
    await wait(500);
    res = await run(PROBE_READ);
    if (res.doneMs !== null) break;
  }
  await wait(600);
  res = await run(PROBE_READ);
  const pass = res.busyMs !== null && res.busyMs <= 150 && res.doneMs !== null && res.doneMs <= 2000 && res.gapMax < 500 && (res.statusMs === null || res.statusMs <= 150) && !!res.rowAfter && !res.rowAfter.busy && !!res.rowAfter.date;
  console.log(JSON.stringify({ ...res, pass }, null, 2));
  process.exit(pass ? 0 : 1);
}
