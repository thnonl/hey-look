// Probes of the mail background rule (1.0.7 WP13g, DEC-025): what a window shows as the mail's background, and how it changes during a switch of the app theme.
// DOM only (nothing is added to the page); every expression evaluates to a JSON string, so it runs through a CDP `Runtime.evaluate` and through the test bridge's `/eval` alike
// (scripts/test-bridge.md; WebKit rows in webkit-checks-107.md, section 39).
//
//   node scripts/lib/mail-canvas-probe.mjs                 prints the state probe (paste it into /eval or a console)
//   node scripts/lib/mail-canvas-probe.mjs watch [ms]      prints the watch (default 1500 ms): one sample per animation frame
//   node scripts/lib/mail-canvas-probe.mjs pixel <png> <x> <y>
//                                                          the RGB of one pixel of a PNG (a bridge `/snapshot` is 2x on a Retina Mac: pass device pixels, i.e. CSS px * scale)
//
// The state: { theme (prefs.theme), themeAttr (data-theme of <html>, null = the CSS follows the media query), osDark (the engine's prefers-color-scheme), mailCanvas (the stored choice),
//   session (the light theme's session choice, null or "dark"), pressed (aria-pressed of the message background button, null when there is none), frame: null | { cls (classes of the frame's
//   <html>), hmBg (its --hm-bg), bodyBg, bodyVis, frameBg (the iframe element's own background), painted ([r,g,b] the colour the empty parts of the mail show: the body's if opaque, else the
//   frame element's), rect: [x, y, w, h] in CSS px, dpr }, composer: null | { cls (pv-light / pv-dark), bg } }.
const oneLine = (t) => t.split('\n').map((l) => l.trim()).join(' '); // (the bridge's /eval takes one line)
export const mailCanvasProbe = () => oneLine(`(() => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const st = window.__store && window.__store.getState();
  const f = document.querySelector('.msg-frame'), d = f && f.contentDocument;
  const btn = document.querySelector('button[aria-pressed][aria-label="Message background: original / dark"]');
  const cp = document.querySelector('.cp-pv');
  let frame = null;
  if (d && d.body && d.documentElement) {
    const w = d.defaultView, body = rgb(w.getComputedStyle(d.body).backgroundColor), fb = rgb(getComputedStyle(f).backgroundColor), r = f.getBoundingClientRect();
    const painted = body && body[3] === 1 ? body.slice(0, 3) : fb && fb[3] > 0 ? fb.slice(0, 3) : null;
    frame = { cls: d.documentElement.className, hmBg: w.getComputedStyle(d.documentElement).getPropertyValue('--hm-bg').trim(), bodyBg: w.getComputedStyle(d.body).backgroundColor, bodyVis: w.getComputedStyle(d.body).visibility, frameBg: getComputedStyle(f).backgroundColor, painted, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], dpr: window.devicePixelRatio };
  }
  return JSON.stringify({ theme: st ? st.prefs.theme : null, themeAttr: document.documentElement.getAttribute('data-theme'), osDark: matchMedia('(prefers-color-scheme: dark)').matches, mailCanvas: st ? st.prefs.mailCanvas : null, session: st ? st.mailCanvasSession : null,
    pressed: btn ? btn.getAttribute('aria-pressed') : null, frame, composer: cp ? { cls: [...cp.classList].find((c) => c.startsWith('pv-')) || null, bg: getComputedStyle(cp).backgroundColor } : null });
})()`);

/**
 * One sample per animation frame for `ms` milliseconds (start it, then switch the theme in the same second): the colour the mail frame (or the composer's preview) paints in that frame.
 * Answers { frames, span (ms), osAt (when the engine's prefers-color-scheme changed, null = not in the window), themeAt (when <html data-theme> changed), colours: [{ c: [r,g,b], from, to, n }, ...] in the order they appeared,
 * hidden (frames in which the body was hidden by hm-pend), samples: up to 400 [t, r, g, b] }.
 * PASS criterion of a switch: `colours` has exactly the old and the new background, in that order, and no other (no white in the dark app, no third colour).
 */
export const mailCanvasWatch = (ms = 1500) => oneLine(`new Promise((done) => {
  const rgb = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const t0 = performance.now(), out = [], runs = []; let hidden = 0, osAt = null, themeAt = null;
  const mq = matchMedia('(prefers-color-scheme: dark)'), onOs = () => { if (osAt === null) osAt = Math.round(performance.now() - t0); };
  mq.addEventListener('change', onOs);
  const mo = new MutationObserver(() => { if (themeAt === null) themeAt = Math.round(performance.now() - t0); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const look = () => {
    const f = document.querySelector('.msg-frame'), d = f && f.contentDocument, cp = document.querySelector('.cp-pv');
    let c = null;
    if (d && d.body) {
      const b = rgb(d.defaultView.getComputedStyle(d.body).backgroundColor), fb = rgb(getComputedStyle(f).backgroundColor);
      if (d.defaultView.getComputedStyle(d.body).visibility === 'hidden') hidden++;
      c = b && b[3] === 1 ? b.slice(0, 3) : fb && fb[3] > 0 ? fb.slice(0, 3) : null;
    } else if (cp) { const b = rgb(getComputedStyle(cp).backgroundColor); c = b ? b.slice(0, 3) : null; }
    const t = Math.round(performance.now() - t0);
    if (out.length < 400) out.push([t, ...(c || [-1, -1, -1])]);
    const last = runs[runs.length - 1];
    if (last && c && last.c.every((v, i) => v === c[i])) { last.to = t; last.n++; } else runs.push({ c, from: t, to: t, n: 1 });
    if (t < ${Number(ms)}) requestAnimationFrame(look); else { mq.removeEventListener('change', onOs); mo.disconnect(); done(JSON.stringify({ frames: runs.reduce((a, r) => a + r.n, 0), span: t, osAt, themeAt, colours: runs, hidden, samples: out })); }
  };
  requestAnimationFrame(look);
})`);

/** The RGB of one pixel of a PNG file (8-bit grey, RGB or RGBA, not interlaced: what a snapshot of a window is). */
export async function pixelOfPng(file, x, y) {
  const { readFileSync } = await import('node:fs');
  const { inflateSync } = await import('node:zlib');
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0; const idat = [];
  for (let p = 8; p < b.length;) {
    const len = b.readUInt32BE(p), name = b.toString('latin1', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    if (name === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 6].includes(type)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const bpp = type === 0 ? 1 : type === 2 ? 3 : 4, row = w * bpp, raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * row);
  for (let r = 0; r < h; r++) {
    const f = raw[r * (row + 1)], src = raw.subarray(r * (row + 1) + 1, (r + 1) * (row + 1));
    for (let i = 0; i < row; i++) {
      const a = i >= bpp ? px[r * row + i - bpp] : 0, up = r ? px[(r - 1) * row + i] : 0, c = i >= bpp && r ? px[(r - 1) * row + i - bpp] : 0;
      const pr = () => { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; };
      px[r * row + i] = (src[i] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pr())) & 255;
    }
  }
  if (x < 0 || y < 0 || x >= w || y >= h) throw new Error(`pixel ${x},${y} is outside the ${w}x${h} picture`);
  const o = y * row + x * bpp;
  return type === 0 ? [px[o], px[o], px[o]] : [px[o], px[o + 1], px[o + 2]];
}

if (process.argv[1] && process.argv[1].endsWith('mail-canvas-probe.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'watch') console.log(mailCanvasWatch(Number(rest[0]) || 1500));
  else if (cmd === 'pixel') console.log(JSON.stringify(await pixelOfPng(rest[0], Number(rest[1]), Number(rest[2]))));
  else console.log(mailCanvasProbe());
}
