// The probe of the "Opening message…" surface (1.0.7 fix38; test-open-surface.mjs; the WebKit rows of webkit-checks-107.md section 41). DOM only, for the test bridge `/eval` of the window that is looked at
// (`main`, `reader-N`): START puts a sampler in (one sample per animation frame, from now until READ), READ answers with
//   { frames, withStatus, maxRectDiff, colours: [[r,g,b] ...], texts, small, bodyBefore, bodyAfter }
//   withStatus   frames in which the status (.rp-body .rp-opening) was up
//   maxRectDiff  the largest difference in px between the status box and the body area (.rp-body) over those frames (PASS <= 1)
//   colours      the distinct background colours the status had (PASS: exactly one, the canvas colour of the mode: [255,255,255] original, [27,28,32] dark)
//   small        frames in which the status was narrower or lower than the body area's client box minus 1 px (PASS 0)
//   bodyBefore / bodyAfter  the body area's box [left, top, width, height] at the first status frame and at the end (PASS: within 1 px)
// Start it before the open (select a mail / open the reader window), read it 1.5 s after the mail is on screen. Prints the two expressions: node scripts/lib/open-surface-probe.mjs
export const START = `(() => {
  if (window.__surf && window.__surf.stop) window.__surf.stop();
  const s = window.__surf = { frames: 0, withStatus: 0, maxRectDiff: 0, colours: [], texts: [], small: 0, bodyBefore: null, bodyAfter: null, raf: 0 };
  const box = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const tick = () => {
    s.frames++;
    const o = document.querySelector('.rp-body .rp-opening'), b = document.querySelector('.rp-body');
    if (b) s.bodyAfter = box(b);
    if (o && b) {
      s.withStatus++;
      if (!s.bodyBefore) s.bodyBefore = box(b);
      const x = box(o), y = box(b);
      s.maxRectDiff = Math.max(s.maxRectDiff, ...x.map((v, i) => Math.abs(v - y[i])));
      if (x[2] < b.clientWidth - 1 || x[3] < b.clientHeight - 1) s.small++;
      const c = (getComputedStyle(o).backgroundColor.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      if (!s.colours.some((k) => k.join() === c.join())) s.colours.push(c);
      const t = o.textContent.replace(/[·\\s]+/g, ' ').trim();
      if (!s.texts.includes(t)) s.texts.push(t);
    }
    s.raf = requestAnimationFrame(tick);
  };
  s.stop = () => cancelAnimationFrame(s.raf);
  s.raf = requestAnimationFrame(tick);
  return 'started';
})()`;
export const READ = `(() => { const s = window.__surf; s.stop(); const { raf, stop, ...out } = s; return out; })()`;

if (process.argv[1] && process.argv[1].endsWith('open-surface-probe.mjs')) console.log(JSON.stringify({ START, READ }, null, 2));
