#!/usr/bin/env node
// The four resize handles of a selected picture stay inside the editor (v1.0.6 final QA, BUG-2): with a picture selected, scrolling the compose pane
// so that the picture (or its top edge) leaves the visible editor drew the blue `.pic-handle` squares over the To row and the attachment row.
// They are `position: fixed` in the page, so the editor's own scrolling did not clip them. Now they live in a box (`.pic-handles`) that has the
// size of the pane the editor scrolls in (`.cp-editor`) and clips what sticks out.
//
// Real editor in the dev preview (src/devMock.ts), real wheel events: a new message, a large picture (1400 x 900) then enough text to scroll, the
// picture selected. At 960 x 560 and 1280 x 720: the handles sit at the picture's corners while it is in view (and take the pointer there); scrolled
// until the picture's top edge is above the pane, none of their pixels that lie outside the pane takes the pointer or shows (the point under the
// pointer is not a handle), and scrolled out completely none of them is hit anywhere; scrolled back they are at the corners again.
//   node scripts/test-picture-handles.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-picture-handles', { vitePort0: 5840, cdpPort0: 9840 });
const { evaluate, cdp } = H;
const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

const ED = `document.querySelector('.ProseMirror').editor`;
const PNG = `(() => { const c = document.createElement('canvas'); c.width = 1400; c.height = 900; const g = c.getContext('2d'); g.fillStyle = '#3366aa'; g.fillRect(0, 0, 1400, 900); g.fillStyle = '#ffcc00'; g.fillRect(100, 100, 400, 300); return c.toDataURL('image/png'); })()`;

/** The geometry of the pane, the picture and the handles, and what is under the pointer at the four corners and the centre of each handle. */
const GEO = `(() => {
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const pane = document.querySelector('.cp-editor'), img = document.querySelector('.ProseMirror img'), box = document.querySelector('.pic-handles');
  const hs = [...document.querySelectorAll('.pic-handle')];
  const P = R(pane);
  const out = (x, y) => x < P.l || x > P.r || y < P.t || y > P.b;
  return {
    pane: P, img: R(img), box: box && R(box), boxClip: box && getComputedStyle(box).overflow + '/' + getComputedStyle(box).overflowX, count: hs.length,
    handles: hs.map((h) => {
      const r = R(h), pts = [[r.l + 1, r.t + 1], [r.r - 1, r.t + 1], [r.l + 1, r.b - 1], [r.r - 1, r.b - 1], [(r.l + r.r) / 2, (r.t + r.b) / 2]];
      return { r, hits: pts.map(([x, y]) => ({ outside: out(x, y), on: !!document.elementFromPoint(x, y)?.closest?.('.pic-handle') })) };
    }),
    scroll: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight,
  };
})()`;
const geo = async () => JSON.parse(JSON.stringify(await evaluate(GEO)));
const wheel = async (y) => { const p = await evaluate(`(() => { const r = document.querySelector('.cp-editor').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`); await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p[0], y: p[1], deltaX: 0, deltaY: y }); await sleep(250); };

async function run(w, h) {
  const tag = `${w}x${h}`;
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }); 1`);
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('.ProseMirror')?.editor`)); i++) await sleep(100);
  await sleep(300);
  // a large picture, then text enough to scroll the pane; the picture selected
  await evaluate(`(() => { const ed = ${ED}; ed.commands.focus('start'); ed.commands.insertContent([{ type: 'image', attrs: { src: ${PNG} } }, ...Array.from({ length: 40 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: 'Line ' + (i + 1) + ' of the message' }] }))]); let at = -1; ed.state.doc.descendants((n, p) => { if (at < 0 && n.type.name === 'image') at = p; }); ed.commands.setNodeSelection(at); ed.commands.scrollIntoView(); return at; })()`);
  await sleep(500);
  await evaluate(`document.querySelector('.cp-editor').scrollTop = 0; 1`);
  await sleep(300);

  let g = await geo();
  check(`${tag}: four handles while the picture is in view`, () => assert.equal(g.count, 4));
  check(`${tag}: the handle box is the pane and clips`, () => { assert.ok(g.box, 'no .pic-handles box'); for (const k of ['l', 't', 'r', 'b']) assert.ok(Math.abs(g.box[k] - g.pane[k]) <= 1, `box ${k} ${g.box[k]} vs pane ${g.pane[k]}`); assert.match(g.boxClip, /hidden|clip/); });
  check(`${tag}: handles at the corners of the picture`, () => {
    const cx = [g.img.l, g.img.r, g.img.l, g.img.r], cy = [g.img.t, g.img.t, g.img.b, g.img.b];
    g.handles.forEach((hd, i) => { assert.ok(Math.abs((hd.r.l + hd.r.r) / 2 - cx[i]) <= 1.5 && Math.abs((hd.r.t + hd.r.b) / 2 - cy[i]) <= 1.5, `handle ${i} at ${hd.r.l},${hd.r.t} want ${cx[i]},${cy[i]}`); });
  });
  check(`${tag}: a handle inside the pane takes the pointer`, () => { const inside = g.handles.filter((hd) => hd.hits.every((x) => !x.outside)); assert.ok(inside.length >= 2, `${inside.length} handles inside`); for (const hd of inside) assert.ok(hd.hits.every((x) => x.on), 'a handle inside the pane is not under the pointer'); });

  // scroll until the top of the picture is above the pane: the two upper handles lie over what is above the pane (the To row, the header)
  let n = 0;
  while ((await geo()).img.t > (await geo()).pane.t - 8 && n++ < 30) await wheel(40);
  g = await geo();
  check(`${tag}: the pane did scroll`, () => assert.ok(g.scroll > 0 && g.img.t < g.pane.t, `scrollTop ${g.scroll}, picture top ${g.img.t}, pane top ${g.pane.t}`));
  check(`${tag}: nothing of a handle that is outside the pane takes the pointer`, () => { for (const [i, hd] of g.handles.entries()) hd.hits.forEach((x, k) => { if (x.outside) assert.ok(!x.on, `handle ${i} point ${k} is over the To row / header and takes the pointer`); }); });
  // scrolled out completely: the picture is above the pane
  const scrollBy = g.img.b - g.pane.t + 40;
  await evaluate(`document.querySelector('.cp-editor').scrollTop += ${Math.ceil(scrollBy)}; 1`);
  await sleep(300);
  g = await geo();
  check(`${tag}: picture out of the pane: no handle is hit anywhere`, () => { assert.ok(g.img.b < g.pane.t, `picture bottom ${g.img.b}, pane top ${g.pane.t}`); for (const hd of g.handles) assert.ok(hd.hits.every((x) => !x.on), 'a handle takes the pointer'); });
  // back: the handles are at the corners again
  await evaluate(`document.querySelector('.cp-editor').scrollTop = 0; 1`);
  await sleep(300);
  g = await geo();
  check(`${tag}: scrolled back, the handles are back at the picture`, () => assert.ok(Math.abs((g.handles[0].r.l + g.handles[0].r.r) / 2 - g.img.l) <= 1.5 && Math.abs((g.handles[0].r.t + g.handles[0].r.b) / 2 - g.img.t) <= 1.5));
}

try {
  await run(960, 560);
  await run(1280, 720);
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-picture-handles: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-picture-handles: ok');
