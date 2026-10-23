// The probe of the first open of a part that loads on demand (1.0.7 WP9d, test-lazy-views.mjs; WebKit rows WK-30.xx in webkit-checks-107.md). DOM only; it installs a recorder in the page
// (nothing is kept after a reload) and reads it back, in three bridge calls so that nothing waits inside the page (scripts/test-bridge.md):
//   INSTALL  puts the recorder in: a MutationObserver, a frame loop and a 20 ms timer that note, in ms from the press (the first mousedown / keydown, or PRESS below):
//              frameMs   the frame of the part is on screen (Settings: the dialog box with its title; Calendar: the empty pane; New mail / Reply: the compose pane) - <= 100
//              lookMs    the loading look ("Loading…", role=status) is on screen: null when the part came first, else >= 140 (150 ms after the press, REQ-9.2.4)
//              partMs    the part itself is on screen (Settings: the dialog's `.settings`; Calendar: the view's header; New mail / Reply: the editor `.ProseMirror`)
//              focusMs   the focus is where the part puts it (Settings: inside the dialog; New mail: in the To field or the editor; Reply: the shell's body, then the editor)
//              anims     Settings only: opening animations (`pop` / `fade`) running 60 ms after the dialog appeared; with `handoff` true it must be 0 (a dialog that replaces its frame does not open a second time: that would be a flicker); 0 for the others
//              gapMax / longTaskMax   the longest wait of the 20 ms timer (WebKit has no long-task API) / the longest long task (Chromium only, else null)
//              chunks    the script files fetched since the press: name, start (ms from the press), duration, bytes - the cost of the first open
//              handoff   the page carries data-lazy-handoff (true for a dialog that was loaded on demand while it is open, false for a pane)
//   (the person presses the button: a real click, or `PRESS` below)
//   READ     returns the recorder
//   node scripts/lib/lazy-open-probe.mjs <data folder | test-bridge.json | port:token> [window=main] [kind=settings|calendar|compose|reply]
// runs the three calls with a click on the button of that kind and waits (up to 30 s) until the part is there; prints the recorder.
export const PROBE_INSTALL = `
if (window.__lazyOpen && window.__lazyOpen.stop) window.__lazyOpen.stop();
const KIND = __KIND__;
const SEL = {
  settings: { frame: '.modal', part: '.modal .settings' },
  calendar: { frame: '.cal-view', part: '.cal-view .cal-head' },
  compose: { frame: '.compose-pane', part: '.compose-pane .ProseMirror' },
  reply: { frame: '.compose-pane', part: '.compose-pane:not(.preparing) .ProseMirror' },
}[KIND];
if (!SEL) return { error: 'unknown kind ' + KIND };
const rec = window.__lazyOpen = { kind: KIND, t0: 0, frame: null, look: null, part: null, focus: null, anims: null, handoff: null, gaps: [], last: performance.now(), longTaskMax: null, chunks0: performance.getEntriesByType('resource').length };
const focusOk = () => {
  const a = document.activeElement;
  if (!a) return false;
  if (KIND === 'settings') return !!a.closest('.modal');
  if (KIND === 'calendar') return true;
  return !!a.closest('.compose-pane');
};
const look = () => {
  if (!rec.t0) return;
  const t = Math.round(performance.now() - rec.t0);
  if (rec.frame === null && document.querySelector(SEL.frame)) rec.frame = t;
  if (rec.look === null && rec.part === null && document.querySelector('.lazy-load[role=status]')) rec.look = t;
  if (rec.part === null && document.querySelector(SEL.part)) {
    rec.part = t;
    // (a dialog that was loaded on demand opens without its opening animation, so none may run a moment after it replaced its frame; one that is drawn at once - the part was loaded already - has its
    // normal animation, which runs: only a framed dialog (handoff true) is judged)
    const running = () => document.getAnimations().filter((a) => a.animationName === 'pop' || a.animationName === 'fade').length;
    if (KIND === 'settings') setTimeout(() => { rec.anims = running(); }, 60); else rec.anims = 0;
  }
  if (rec.part !== null && rec.focus === null && focusOk()) rec.focus = t;
  if (rec.part !== null) rec.handoff = document.documentElement.hasAttribute('data-lazy-handoff');
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

/** Presses the button of the kind by \`.click()\` (a synthetic press: the recorder's clock starts with it). */
export const PROBE_PRESS = `
const KIND = __KIND__;
const find = {
  settings: () => [...document.querySelectorAll('button.icon-btn')].find((x) => x.querySelector('svg.lucide-settings')),
  calendar: () => document.querySelectorAll('.fp-modules button')[1],
  compose: () => document.querySelector('.ribbon .rb.primary'),
  reply: () => document.querySelector('.rp-msg.open .rp-msg-actions .icon-btn'),
}[KIND];
const b = find && find();
if (!b) return { pressed: false };
window.__lazyOpen.t0 = performance.now(); window.__lazyOpen.last = window.__lazyOpen.t0;
b.click();
return { pressed: true };
`;

export const PROBE_READ = `
const rec = window.__lazyOpen;
if (!rec) return { error: 'not installed' };
const chunks = performance.getEntriesByType('resource').slice(rec.chunks0).filter((e) => /\\.(js|mjs|tsx?)(\\?|$)/.test(e.name)).map((e) => ({ name: e.name.split('/').pop().split('?')[0], start: rec.t0 ? Math.round(e.startTime - rec.t0) : null, ms: Math.round(e.duration), bytes: e.transferSize }));
return { kind: rec.kind, frameMs: rec.frame, lookMs: rec.look, partMs: rec.part, focusMs: rec.focus, anims: rec.anims, handoff: rec.handoff, gapMax: Math.max(0, ...rec.gaps), longTaskMax: rec.longTaskMax, chunks, ua: navigator.userAgent };
`;

export const fill = (body, kind) => body.replaceAll('__KIND__', JSON.stringify(kind));

/** The pass rule of one run: the numbers of AC-9.2.2 / 9.2.4 / 9.2.5 (the frame at once, the look only after 150 ms, the part within 300 ms of a warm disk). */
export function verdict(r, { partMax = 300 } = {}) {
  const bad = [];
  if (r.frameMs === null) bad.push('no frame');
  else if (r.frameMs > 100) bad.push(`frame at ${r.frameMs} ms (> 100)`);
  if (r.lookMs !== null && r.lookMs < 140) bad.push(`loading look at ${r.lookMs} ms (< 140)`);
  if (r.partMs === null) bad.push('the part never appeared');
  else if (r.partMs > partMax) bad.push(`part at ${r.partMs} ms (> ${partMax})`);
  if (r.handoff && r.anims) bad.push(`${r.anims} opening animation(s) running 60 ms after the dialog replaced its frame (it opened twice)`);
  return bad;
}

if (process.argv[1] && process.argv[1].endsWith('lazy-open-probe.mjs')) {
  const { bridge, connection } = await import('../test-bridge-client.mjs');
  const [where, win = 'main', kind = 'settings'] = process.argv.slice(2);
  if (!where) { console.error('usage: node scripts/lib/lazy-open-probe.mjs <data folder | test-bridge.json | port:token> [window=main] [kind=settings|calendar|compose|reply]'); process.exit(2); }
  const conn = /^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(':')[0]), token: where.split(':')[1] } : connection(where);
  const b = bridge(conn);
  const run = (body) => b.evalIn(win, body, { timeoutMs: 15000 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const inst = await run(fill(PROBE_INSTALL, kind));
  if (inst.error) { console.log(JSON.stringify(inst)); process.exit(2); }
  const pr = await run(fill(PROBE_PRESS, kind));
  if (!pr.pressed) { console.log(JSON.stringify({ error: `no button for "${kind}"` })); process.exit(1); }
  let res = null;
  for (let i = 0; i < 60; i++) {
    await wait(500);
    res = await run(PROBE_READ);
    if (res.partMs !== null && res.focusMs !== null) break;
  }
  await wait(400);
  res = await run(PROBE_READ);
  const bad = verdict(res, { partMax: kind === 'reply' ? 2500 : 300 });
  console.log(JSON.stringify({ ...res, problems: bad, pass: bad.length === 0 }, null, 2));
  process.exit(bad.length ? 1 : 0);
}
