#!/usr/bin/env node
// The picture toolbar and the resize handles of a selected picture never overlap (v1.0.6 QA round 3, BUG-R3-2: at 1280 x 720, with three pictures in the message
// and the middle one selected, the corner handles sat on the first letters of "Small" and "As attachment" and the toolbar covered the picture's top edge; the
// DOM scan of the toolbar saw no overlap because the handles are not in the toolbar's DOM: they are four squares in a layer of their own).
//
// Real compose pane in the dev preview (src/devMock.ts): a new message with three pictures one under the other, each one selected in turn, the editor scrolled
// through its whole length in steps. At every position (the picture in view, partly in view, tall, short) it measures the rectangles of the toolbar, of each of
// its controls, of the four handles, of the picture and of the editor, and asserts:
//   - no handle (the part of it that the pane's clip leaves) touches the toolbar box, and no handle is what is under the centre of a toolbar control
//     (the label can be read and clicked);
//   - the toolbar does not cross the top or the bottom edge of the picture (above it, below it, or over the picture clear of both edges and of the handles);
//   - the handles lie inside the picture's rectangle, in its corners;
//   - the toolbar is inside the editor pane (sideways always; up and down when the pane is tall enough to hold it), and is not covered by anything else.
// At 1266 x 712 (a 1280 x 720 window), 960 x 560's 946 x 552, 946 x 480, 1726 x 892 and a narrow compose window.
//   node scripts/test-picture-toolbar.mjs [--require-browser] [--url=http://127.0.0.1:1420/] [--table] [--shots=<dir>]
import fs from 'node:fs';
import path from 'node:path';
import { arg, flag, sleep, startHarness } from './cdp-harness.mjs';

const SHOTS = arg('shots');
const H = await startHarness('test-picture-toolbar', { vitePort0: 5940, cdpPort0: 9940 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
const ok = (tag, cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };
const shot = async (tag) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, tag.replace(/[^\w.-]+/g, '_') + '.png'), Buffer.from(r.data, 'base64')); };

const ED = `document.querySelector('.cp-editor .tiptap').editor`;
/** a PNG of w x h px in a colour */
const PNG = (w, h, c) => `(() => { const k = document.createElement('canvas'); k.width = ${w}; k.height = ${h}; const g = k.getContext('2d'); g.fillStyle = ${JSON.stringify(c)}; g.fillRect(0, 0, ${w}, ${h}); g.fillStyle = '#fff'; g.fillRect(10, 10, 60, 30); return k.toDataURL('image/png'); })()`;

const MEASURE = `(() => {
  const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const pane = document.querySelector('.cp-editor'), P = R(pane);
  const sel = document.querySelector('.ProseMirror-selectednode'); if (!sel) return { none: true };
  const img = R(sel), box = document.querySelector('.img-tools-box'), tools = document.querySelector('.img-tools-anchor');
  if (!box || !tools || getComputedStyle(tools).visibility === 'hidden') return { none: true, why: 'no toolbar' };
  const clip = (r) => ({ l: Math.max(r.l, P.l), t: Math.max(r.t, P.t), r: Math.min(r.r, P.r), b: Math.min(r.b, P.b) });
  const handles = [...document.querySelectorAll('.pic-handle')].map((h) => ({ raw: R(h), vis: clip(R(h)) })).map((h) => ({ ...h, empty: h.vis.r <= h.vis.l || h.vis.b <= h.vis.t }));
  const ctrls = [...box.querySelectorAll('.img-tools button')].map((b) => { const r = R(b); const x = (r.l + r.r) / 2, y = (r.t + r.b) / 2; const inPane = x >= P.l && x <= P.r && y >= P.t && y <= P.b; const t = inPane ? document.elementFromPoint(x, y) : null; return { name: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 20), r, inPane, hit: !t || b.contains(t), over: t && !b.contains(t) ? (t.className || t.tagName).toString().slice(0, 30) : null }; });
  return { P, img, tb: R(box), handles, ctrls, scrollTop: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight, tbH: box.getBoundingClientRect().height };
})()`;

const SIZES = [[1266, 712], [946, 552], [946, 480], [1726, 892], [1100, 600]];
async function run(w, h) {
  const base = `${w}x${h}`;
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Three pictures' }); 1`);
  for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('.cp-editor .tiptap')?.editor`)); i++) await sleep(100);
  await sleep(500);
  // three pictures one under the other (a small, a medium and a wide one), the way the Picture button puts them in
  await evaluate(`(() => { const ed = ${ED}; ed.commands.focus('start'); ed.commands.insertContent([
    { type: 'image', attrs: { src: ${PNG(300, 140, '#c0392b')}, alt: '', width: 300 } },
    { type: 'image', attrs: { src: ${PNG(420, 160, '#27ae60')}, alt: '', width: 420 } },
    { type: 'image', attrs: { src: ${PNG(260, 120, '#2980b9')}, alt: '', width: 260 } },
  ]); return 1; })()`);
  await sleep(500);
  for (let which = 0; which < 3; which++) {
    const nodes = await evaluate(`(() => { const ed = ${ED}; const at = []; ed.state.doc.descendants((n, p) => { if (n.type.name === 'image') at.push(p); }); return at; })()`);
    if (nodes.length < 3) { ok(base, false, `only ${nodes.length} pictures in the message`); return; }
    await evaluate(`${ED}.chain().focus().setNodeSelection(${nodes[which]}).run(); 1`);
    await sleep(300);
    const first = await evaluate(MEASURE);
    const max = first.none ? 0 : Math.max(first.max, 0);
    // from the top to the bottom of the editor in steps, then back up by half steps (the position the browser keeps after a scroll differs)
    const steps = [...new Set([0, 10, 25, 40, 55, 70, 90, 110, 140, 180, 230, 300, 400].map((s) => Math.min(s, max)).concat([max, Math.round(max / 2)]))].sort((a, b) => a - b);
    for (const top of [...steps, ...steps.slice().reverse().filter((_, i) => i % 2 === 0)]) {
      await evaluate(`document.querySelector('.cp-editor').scrollTop = ${top}; 1`);
      await sleep(220);
      const g = await evaluate(MEASURE);
      const tag = `${base} picture ${which + 1} scroll ${top}`;
      if (g.none) { continue; } // (the picture is scrolled out of the editor: no toolbar, the selection stays)
      if (flag('table')) console.log(`${tag}: pane ${Math.round(g.P.t)}-${Math.round(g.P.b)}, picture ${Math.round(g.img.t)}-${Math.round(g.img.b)}, toolbar ${Math.round(g.tb.t)}-${Math.round(g.tb.b)} (${Math.round(g.tbH)} high)`);
      const visible = g.img.b > g.P.t && g.img.t < g.P.b && g.img.r > g.P.l && g.img.l < g.P.r;
      // 1. the handles and the toolbar
      for (const [i, hd] of g.handles.entries()) {
        if (hd.empty) continue;
        const o = hd.vis.l < g.tb.r && hd.vis.r > g.tb.l && hd.vis.t < g.tb.b && hd.vis.b > g.tb.t;
        ok(tag, !o, `handle ${i} (${JSON.stringify(hd.vis)}) overlaps the toolbar (${JSON.stringify(g.tb)})`);
      }
      for (const c of g.ctrls) { if (c.inPane) ok(tag, c.hit, `"${c.name}" is covered by ${c.over}`); }
      // 2. the toolbar does not cross an edge of the picture that is in view
      const xOver = g.tb.l < g.img.r && g.tb.r > g.img.l;
      const crosses = (y) => g.tb.t < y - 0.5 && g.tb.b > y + 0.5;
      if (xOver && g.img.t >= g.P.t && g.img.t <= g.P.b) ok(tag, !crosses(g.img.t), `the toolbar (${Math.round(g.tb.t)}-${Math.round(g.tb.b)}) covers the top edge of the picture (${Math.round(g.img.t)})`);
      if (xOver && g.img.b >= g.P.t && g.img.b <= g.P.b) ok(tag, !crosses(g.img.b), `the toolbar (${Math.round(g.tb.t)}-${Math.round(g.tb.b)}) covers the bottom edge of the picture (${Math.round(g.img.b)})`);
      // over the picture (neither above nor below it) the toolbar keeps off the 16 px of the corners where the handles are
      const over = g.tb.t >= g.img.t - 0.5 && g.tb.b <= g.img.b + 0.5 && xOver;
      if (over && g.img.t >= g.P.t) ok(tag, g.tb.t >= g.img.t + 16 - 0.5, `the toolbar over the picture is ${Math.round(g.tb.t - g.img.t)} px from its top edge (the top handles are 10 px deep)`);
      if (over && g.img.b <= g.P.b) ok(tag, g.tb.b <= g.img.b - 16 + 0.5, `the toolbar over the picture is ${Math.round(g.img.b - g.tb.b)} px from its bottom edge`);
      // 3. the handles are in the corners, inside the picture
      if (g.handles.length === 4) {
        const [nw, ne, sw, se] = g.handles.map((x) => x.raw);
        const near = (a, b) => Math.abs(a - b) <= 1;
        ok(tag, near(nw.l, g.img.l) && near(nw.t, g.img.t) && near(ne.r, g.img.r) && near(ne.t, g.img.t) && near(sw.l, g.img.l) && near(sw.b, g.img.b) && near(se.r, g.img.r) && near(se.b, g.img.b), `the handles are not in the picture's corners: ${JSON.stringify(g.handles.map((x) => x.raw))} for ${JSON.stringify(g.img)}`);
      }
      // 4. the toolbar is in the editor
      if (visible) {
        ok(tag, g.tb.l >= g.P.l - 1 && g.tb.r <= g.P.r + 1, `the toolbar is outside the editor sideways (${Math.round(g.tb.l)}-${Math.round(g.tb.r)} in ${Math.round(g.P.l)}-${Math.round(g.P.r)})`);
        if (g.P.b - g.P.t >= g.tbH + 12) ok(tag, g.tb.t >= g.P.t - 1 && g.tb.b <= g.P.b + 1, `the toolbar is outside the editor (${Math.round(g.tb.t)}-${Math.round(g.tb.b)} in ${Math.round(g.P.t)}-${Math.round(g.P.b)})`);
      }
      if (top === steps[Math.min(2, steps.length - 1)] && which === 1) await shot(`${base}-middle-${top}`);
    }
  }
}

try {
  for (const [w, h] of SIZES) { try { await run(w, h); } catch (e) { ok(`${w}x${h}`, false, `threw: ${e.message}`); } }
} finally { await H.shutdown(); }
if (failures.length) { console.error(`test-picture-toolbar: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-picture-toolbar: ${SIZES.length} sizes, ${checks} checks passed`);
