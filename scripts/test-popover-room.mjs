#!/usr/bin/env node
// How far down a popover or menu may reach while a toast shows (v1.0.6 QA round 2, BUG-A1-4): src/popoverRoom.ts.
//   node --experimental-strip-types scripts/test-popover-room.mjs
import assert from 'node:assert/strict';
import { popoverFloor } from '../src/popoverRoom.ts';

const toast = { left: 220, right: 740, top: 489 };
assert.equal(popoverFloor(560, 8, 470, 770, null), 552, 'no toast: the window edge');
assert.equal(popoverFloor(560, 8, 470, 770, toast), 481, 'a toast under the popover: 8 px above it');
assert.equal(popoverFloor(560, 8, 10, 210, toast), 552, 'a popover left of the toast stack is not in its way');
assert.equal(popoverFloor(560, 8, 740, 900, toast), 552, 'touching is not overlapping');
assert.equal(popoverFloor(560, 8, 739, 900, toast), 481);
assert.equal(popoverFloor(560, 8, 470, 770, { ...toast, top: 700 }), 552, 'a toast below the window edge changes nothing');
assert.equal(popoverFloor(560, 8, 470, 770, toast, 0), 489);

// where a popover that hangs on a button goes: popoverRoom.ts placePopover (below, above, inside the window, above a toast, never more than the room)
import { placePopover } from '../src/popoverRoom.ts';
const win = { w: 946, h: 552 };
const btn = (left, top, w = 30, h = 28) => ({ left, right: left + w, top, bottom: top + h });
{
  // below the button when it fits
  let p = placePopover(btn(100, 100), { w: 300, h: 200 }, win, { edge: 8, gap: 4 });
  assert.deepEqual([p.top, p.left, p.up], [132, 100, false]);
  assert.equal(p.max, 552 - 8 - 132);
  // too tall for the room below (QA round 3: 427 px high under a button at y 177 in a 552 px window): scrolls in the room, never past the window
  p = placePopover(btn(470, 150), { w: 300, h: 427 }, win);
  assert.equal(p.up, false);
  assert.equal(p.top + Math.min(427, p.max) <= 552 - 8 + 0.001, true);
  assert.equal(p.max, 552 - 8 - (150 + 28 + 4));
  // more room above: opens above, ends at the button
  p = placePopover(btn(100, 400), { w: 300, h: 300 }, win);
  assert.equal(p.up, true);
  assert.equal(p.top, 400 - 4 - 300);
  // above with less room than the popover needs: the room above, from the edge down
  p = placePopover(btn(100, 300, 30, 28), { w: 300, h: 400 }, { w: 946, h: 480 });
  assert.equal(p.up, true); assert.equal(p.max, 300 - 4 - 8); assert.equal(p.top, 8);
  // sideways: kept inside the window; right alignment
  assert.equal(placePopover(btn(900, 100), { w: 300, h: 100 }, win).left, 946 - 300 - 8);
  assert.equal(placePopover(btn(2, 100), { w: 300, h: 100 }, win).left, 8);
  assert.equal(placePopover(btn(800, 100, 40), { w: 200, h: 100 }, win, { align: 'right' }).left, 640);
  assert.equal(placePopover(btn(100, 100), { w: 300, h: 100 }, win, { inset: 62 }).left, 162);
  // a toast stack under it: it ends 8 px above the stack (same as popoverFloor)
  p = placePopover(btn(470, 150), { w: 300, h: 427 }, { w: 946, h: 560 }, { toasts: toast });
  assert.equal(p.max, 481 - (150 + 28 + 4));
  // a button scrolled out of the window: the popover is still inside it
  p = placePopover(btn(100, 700), { w: 300, h: 200 }, win);
  assert.equal(p.top >= 8 && p.top + 200 <= 552, true);
  // a window lower than minRoom: it gets minRoom
  assert.equal(placePopover(btn(100, 100), { w: 300, h: 400 }, { w: 946, h: 200 }, { minRoom: 96 }).max, 96);
  // every size: the box never ends below the window
  for (const h of [300, 480, 552, 720]) for (const top of [0, 50, 150, 300, 450]) for (const ph of [100, 250, 430, 800]) {
    const q = placePopover(btn(300, top), { w: 300, h: ph }, { w: 946, h }, { minRoom: 0 });
    const room = h - 16;
    assert.ok(q.top >= 8 - 0.001 && q.top + Math.min(ph, q.max) <= h - 8 + 0.001 || q.max < 0 || Math.min(ph, q.max) > room, `window ${h}, button ${top}, popover ${ph}: top ${q.top} max ${q.max}`);
  }
}
console.log('ok - test-popover-room');
