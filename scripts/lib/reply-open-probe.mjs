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
//              rowsMovedPx  the worst distance of any header row (From, To, Cc, Bcc, the Cc / Bcc links, Subject) between the shell and the fill; rowsAdded: rows added (+) or lost (-) at the fill: 0 (WP13f-3, AC-13.13.14)
//              same         { instance, pane, editor, view }: the Compose and the editor made for the shell are the ones that were filled in (AC-13.13.15); canUndoAtFill: false = Ctrl/Cmd+Z has nothing to undo (AC-13.13.17)
//              statusStarved / statusNullOk  the status is "due" 140 ms after the press; when the main thread was busy at that moment it cannot be drawn and the message is complete when it comes free (D-096): not a missing status
//              shellState   what the shell looked like: To disabled, Send disabled, the toolbar inert, the status text
//   (the person presses Reply / Reply all / Forward in the reading pane: a real click or key, or `PRESS` below)
//   READ     returns the recorder
//   node scripts/lib/reply-open-probe.mjs <data folder | test-bridge.json | port:token> [window=main] [button=Reply] [maxFilledMs]
// runs the three calls with a click on the first button named like that in the open message and waits (up to 60 s) until the compose is filled; prints the recorder and the AC-13.13.14 checks
// (exit code 1 when one fails). `button` = state reads the compose pane of a window as it is now (PROBE_STATE), for the compose window of a Shift+Reply, which the press creates.
export const PROBE_INSTALL = `
if (window.__replyOpen && window.__replyOpen.stop) window.__replyOpen.stop();
const rec = window.__replyOpen = { t0: 0, shell: null, status: null, statusGone: null, filled: null, press: null, gaps: [], blocks: [], last: performance.now(), longTaskMax: null, toBefore: null, toAfter: null, shellState: null, statusText: null, rowsBefore: null, rowsAfter: null, ident: null, same: null, canUndoAtFill: null };
const pane = () => document.querySelector('.compose-pane');
const toBox = () => { const f = pane()?.querySelectorAll('.cp-fields .cf-field')[1]; if (!f) return null; const r = f.getBoundingClientRect(); return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
// every header row (From, To, Cc, Bcc, the Cc / Bcc links, Subject) with its label and box; the OpenPGP strip is not a row (it may appear at the fill and moves only what is below the rows)
const rowBoxes = () => [...(pane()?.querySelectorAll('.cp-fields .cf-field, .cp-fields .cf-links') ?? [])].map((f) => { const r = f.getBoundingClientRect(); return { label: f.querySelector('label')?.textContent.trim() ?? 'links', x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; });
const look = () => {
  if (!rec.t0) return;
  const t = Math.round(performance.now() - rec.t0);
  const p = pane();
  if (rec.shell === null && p) {
    rec.shell = t;
    rec.toBefore = toBox();
    rec.rowsBefore = rowBoxes();
    // (WP13f-3, AC-13.13.15: the Compose and its editor made for the shell are the ones that are filled in; the pane keeps a marker and the editor of the instance, components/Compose.tsx)
    rec.ident = { inst: p.getAttribute('data-compose-instance'), pane: p, ed: p.__editor || null, view: (p.__editor && p.__editor.view) || null };
    const to = p.querySelectorAll('.cp-fields .cf-field')[1];
    rec.shellState = { preparing: p.classList.contains('preparing'), toDisabled: !!to && (to.hasAttribute('inert') || !!to.closest('[inert]') || !!to.querySelector('input:disabled')), sendDisabled: !!p.querySelector('.split-btn .btn.primary')?.disabled };
  }
  const st = p && [...p.querySelectorAll('[role=status][aria-busy=true]')].find((e) => /\\u2026|\\.\\.\\./.test(e.textContent || ''));
  if (rec.status === null && st) { rec.status = t; rec.statusText = st.textContent.trim(); }
  if (rec.status !== null && rec.statusGone === null && !st) rec.statusGone = t;
  const quote = !!p?.querySelector('.cp-editor .quote-block');
  const toOn = p && !p.classList.contains('preparing');
  if (rec.shell !== null && rec.filled === null && quote && toOn) {
    rec.filled = t;
    rec.toAfter = toBox();
    rec.rowsAfter = rowBoxes();
    const id = rec.ident, ed = p.__editor || null;
    rec.same = id ? { instance: !!id.inst && p.getAttribute('data-compose-instance') === id.inst, pane: p === id.pane, editor: !!id.ed && ed === id.ed, view: !!id.view && !!ed && ed.view === id.view } : null;
    try { rec.canUndoAtFill = ed ? !!ed.can().undo() : null; } catch (e) { rec.canUndoAtFill = null; }
  }
};
const mo = new MutationObserver(look); mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
let raf = 0; const loop = () => { look(); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop);
const iv = setInterval(() => { const n = performance.now(); const gap = Math.round(n - rec.last); rec.gaps.push(gap); if (gap > 60 && rec.t0) rec.blocks.push([Math.round(rec.last - rec.t0), Math.round(n - rec.t0)]); rec.last = n; look(); }, 20);
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
const { shell, status, statusGone, filled, press, gaps, blocks, longTaskMax, toBefore, toAfter, shellState, statusText, rowsBefore, rowsAfter, same, canUndoAtFill } = rec;
const moved = toBefore && toAfter ? Math.max(Math.abs(toBefore.x - toAfter.x), Math.abs(toBefore.y - toAfter.y), Math.abs(toBefore.w - toAfter.w), Math.abs(toBefore.h - toAfter.h)) : null;
// every header row of the shell is still the same row after the fill, in the same place (+- 1 px): the worst distance, null while a row was added or lost (rowsAdded says how many)
let rowsMoved = null, rowsAdded = null;
if (rowsBefore && rowsAfter) {
  rowsAdded = rowsAfter.length - rowsBefore.length;
  if (rowsAdded === 0) rowsMoved = Math.max(0, ...rowsBefore.map((a, i) => Math.max(Math.abs(a.x - rowsAfter[i].x), Math.abs(a.y - rowsAfter[i].y), Math.abs(a.w - rowsAfter[i].w), Math.abs(a.h - rowsAfter[i].h))));
}
// the status is "due" 140 ms after the press (src/composeShell.ts STATUS_AFTER_MS); when the main thread was busy at that moment (a block of the 20 ms timer that contains it) it could not be drawn, and the
// message was complete when the thread came free: that is not a missing status (D-096). statusNullOk: the status was shown, or the compose was complete before 150 ms, or the thread was blocked at 140 ms.
const starved = status === null && filled !== null && blocks.some((b) => b[0] <= 140 && b[1] >= 140);
const statusNullOk = status !== null || (filled !== null && (filled < 150 || starved));
const p = document.querySelector('.compose-pane');
return { shellMs: shell, statusMs: status, statusGoneMs: statusGone, filledMs: filled, pressMs: press, statusText, shellState, gapMax: Math.max(0, ...gaps), longTaskMax, toBefore, toAfter, toMovedPx: moved, rowsMovedPx: rowsMoved, rowsAdded, rowLabels: rowsAfter ? rowsAfter.map((r) => r.label) : null, same, canUndoAtFill, fillKind: p ? p.getAttribute('data-fill') : null, statusStarved: starved, statusNullOk, blocks: blocks.slice(0, 8), ua: navigator.userAgent };
`;

/**
 * What a compose pane looks like now, for a window the probe could not be installed in before the press (the compose window of a Shift+Reply / the window setting is created by the press): which
 * way the message got in (fillKind: "in-place" = the Compose and editor made for the shell were filled, null = a Compose mounted with the finished message), the header rows, whether Ctrl/Cmd+Z could
 * undo something, the editor, the signature region (once), the quote, the recipients. The timing of a window is the 'shell' and 'filled' marks of the window's own page, not this.
 */
export const PROBE_STATE = `
const p = document.querySelector('.compose-pane');
if (!p) return { error: 'no compose pane in this window' };
const ed = p.__editor || document.querySelector('.cp-editor .tiptap')?.editor || null;
const rows = [...p.querySelectorAll('.cp-fields .cf-field, .cp-fields .cf-links')].map((f) => { const r = f.getBoundingClientRect(); return { label: f.querySelector('label')?.textContent.trim() ?? 'links', y: Math.round(r.top * 10) / 10, h: Math.round(r.height * 10) / 10 }; });
let canUndo = null; try { canUndo = ed ? !!ed.can().undo() : null; } catch (e) {}
return { preparing: p.classList.contains('preparing'), fillKind: p.getAttribute('data-fill'), instance: p.getAttribute('data-compose-instance'), rows, canUndo, editable: ed ? !!ed.isEditable : null, signatureRegions: p.querySelectorAll('.cp-editor .sig-block').length, quote: !!p.querySelector('.cp-editor .quote-block'), recipients: [...p.querySelectorAll('.cf-field.rcpt')].map((f) => (f.querySelector('label')?.textContent.trim() ?? '') + ': ' + [...f.querySelectorAll('.chips > span')].map((c) => c.textContent.trim()).join(' | ')), font: ed ? getComputedStyle(ed.view.dom).fontFamily : null, ua: navigator.userAgent };
`;

export const fill = (body, button) => body.replaceAll('__BUTTON__', JSON.stringify(button));

if (process.argv[1] && process.argv[1].endsWith('reply-open-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main', button = 'Reply', maxFilledArg] = process.argv.slice(2);
  if (!where) { console.error('usage: node scripts/lib/reply-open-probe.mjs <data folder | test-bridge.json | port:token> [window=main] [button=Reply | state] [maxFilledMs]  (open a message first; "state" reads the compose pane of the window as it is now, for a compose window)'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const b = bridge(conn);
  const run = (body) => b.evalIn(win, body, { timeoutMs: 15000 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (button === 'state') { const st = await run(PROBE_STATE); console.log(JSON.stringify(st, null, 2)); process.exit(st.error ? 1 : 0); }
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
  // AC-13.13.14 (Mac and Linux debug builds): shell <= 200, status <= 250 (or none, see statusNullOk), complete <= maxFilledMs when given (450 for the 20 KB mail), the header rows moved <= 1 px and none added,
  // gapMax < 250, the Compose and the editor are the ones of the shell, and Cmd/Ctrl+Z has nothing to undo
  const maxFilled = maxFilledArg ? Number(maxFilledArg) : null;
  const same = res.same && res.same.instance && res.same.pane && res.same.editor && res.same.view;
  const checks = {
    shell: res.shellMs !== null && res.shellMs <= 200,
    status: res.statusNullOk && (res.statusMs === null || res.statusMs <= 250),
    filled: res.filledMs !== null && (maxFilled === null || res.filledMs <= maxFilled),
    rows: res.rowsAdded === 0 && res.rowsMovedPx !== null && res.rowsMovedPx <= 1,
    gap: res.gapMax < 250,
    sameObjects: !!same,
    noUndo: res.canUndoAtFill === false,
  };
  const pass = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ...res, checks, pass }, null, 2));
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
