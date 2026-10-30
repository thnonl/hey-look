#!/usr/bin/env node
// The calendar label "Name · address" (1.0.11): Google names the primary calendar after the address, so the label says the address once, in the sidebar, the Calendar select of the
// event dialog and the move dialog (they all show `calendarTitle`). Mirrors `calendar_label` of src-tauri/src/calendar.rs (cargo test calendar_label).
//   node --experimental-strip-types scripts/test-calendar-label.mjs
import assert from 'node:assert/strict';
import { calendarLabel, calendarName, calendarTitle } from '../src/calendarSync.ts';

// a calendar with its own name keeps both
assert.equal(calendarLabel('Work', 'me@gmail.com'), 'Work · me@gmail.com');
// the primary calendar of a Google account is named after the address: once
assert.equal(calendarLabel('thnonline@gmail.com', 'thnonline@gmail.com'), 'thnonline@gmail.com');
assert.equal(calendarLabel('Me@Gmail.com', ' me@gmail.com'), 'Me@Gmail.com', 'case and spaces do not matter');
assert.equal(calendarLabel('me@gmail.com work', 'me@gmail.com'), 'me@gmail.com work · me@gmail.com', 'only an equal name is folded');

// what the lists show
assert.equal(calendarTitle({ id: 'google:a:primary', name: 'Work · me@gmail.com' }), 'Work · me@gmail.com');
assert.equal(calendarTitle({ id: 'google:a:primary', name: 'thnonline@gmail.com' }), 'thnonline@gmail.com');
assert.equal(calendarTitle({ id: 'google:a:primary', name: 'thnonline@gmail.com · thnonline@gmail.com' }), 'thnonline@gmail.com', 'a label made by an older build');
assert.equal(calendarTitle({ id: 'google:a:primary', name: 'Team · A · Team' }), 'Team · A · Team', 'different words are left alone');

// the popover / delete texts take the calendar's own name out of the label
assert.equal(calendarName(calendarLabel('thnonline@gmail.com', 'thnonline@gmail.com')), 'thnonline@gmail.com');
assert.equal(calendarName(calendarLabel('Work', 'me@gmail.com')), 'Work');
console.log('PASS test-calendar-label');
