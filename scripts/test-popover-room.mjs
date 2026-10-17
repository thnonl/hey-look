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
console.log('ok - test-popover-room');
