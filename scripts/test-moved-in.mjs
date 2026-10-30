#!/usr/bin/env node
// Mail that was just moved shows in the folder it went to at once (1.0.11, src/movedIn.ts): the folder a queued action goes to, the ghost list of the target folder (filters, the
// Inbox tabs, the order by date, no double rows), the folder numbers (unread and total, the Inbox tabs), Undo / refused / dropped moves, "the copy is here", the time limits, and
// that the store, the app and the backend are wired to it.
//   node --experimental-strip-types scripts/test-moved-in.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMITTED_MS, MovedIn, QUEUED_GRACE_MS, destOf, mergeMoved, withMovedCounts } from '../src/movedIn.ts';

const T = (id, over = {}) => ({ threadId: id, rowKey: id, accountId: 'a1', folder: 'inbox', bulk: false, subject: id, participants: [], snippet: '', lastDate: 1000, count: 1, unread: 0, flagged: false, pinned: false, snoozedUntil: null, hasAttach: false, ...over });
const F = (accountId, key, unread, total, over = {}) => ({ accountId, key, name: key, unread, total, ...over });
const view = (over = {}) => ({ folder: 'trash', accountId: null, tab: null, unreadOnly: false, flaggedOnly: false, searching: false, ...over });

// ---- where a queued action puts the mail
assert.equal(destOf('archive'), 'archive');
assert.equal(destOf('trash'), 'trash');
assert.equal(destOf('junk'), 'junk');
assert.equal(destOf('inbox'), 'inbox');
assert.equal(destOf('block'), 'junk', 'block moves to Junk');
assert.equal(destOf('move', 'f:Receipts'), 'f:Receipts');
assert.equal(destOf('move', null), null);
assert.equal(destOf('delete_forever'), null, 'deleted for good: nowhere');
assert.equal(destOf('snooze'), null);

// ---- the ghosts of the folder in view
{
  const m = new MovedIn();
  m.add('tok1', 'trash', [T('t1', { unread: 1, lastDate: 500 }), T('t2', { lastDate: 900, accountId: 'a2' })], 0, 5);
  assert.deepEqual(m.forView(view()).map((t) => t.threadId), ['t1', 't2']);
  assert.equal(m.forView(view())[0].folder, 'trash', 'the row says the folder it is in now');
  assert.deepEqual(m.forView(view({ accountId: 'a2' })).map((t) => t.threadId), ['t2'], 'one mailbox');
  assert.deepEqual(m.forView(view({ folder: 'archive' })), [], 'another folder shows nothing');
  assert.deepEqual(m.forView(view({ unreadOnly: true })).map((t) => t.threadId), ['t1'], 'the Unread filter');
  assert.deepEqual(m.forView(view({ searching: true })), [], 'a search is not a folder');
  assert.equal(m.has('t1', 'trash'), true);
  assert.equal(m.has('t1', 'inbox'), false);
}

// the Inbox tabs: Focused = no List-Unsubscribe header, Other = with one
{
  const m = new MovedIn();
  m.add('tok', 'inbox', [T('n1'), T('n2', { bulk: true })], 0, 5);
  assert.deepEqual(m.forView(view({ folder: 'inbox', tab: 'focused' })).map((t) => t.threadId), ['n1']);
  assert.deepEqual(m.forView(view({ folder: 'inbox', tab: 'other' })).map((t) => t.threadId), ['n2']);
  assert.deepEqual(m.forView(view({ folder: 'inbox', tab: null })).map((t) => t.threadId), ['n1', 'n2']);
}

// ---- Undo, refused, dropped: the token takes its ghosts out
{
  const m = new MovedIn();
  m.add('a', 'trash', [T('t1')], 0, 5);
  m.add('b', 'archive', [T('t2')], 0, 5);
  assert.equal(m.drop('a'), true);
  assert.equal(m.drop('a'), false, 'nothing to drop twice');
  assert.deepEqual(m.all().map((g) => g.thread.threadId), ['t2']);
}

// a conversation moved again: the newest move owns it
{
  const m = new MovedIn();
  m.add('a', 'archive', [T('t1')], 0, 5);
  m.add('b', 'trash', [T('t1')], 0, 5);
  assert.deepEqual(m.all().map((g) => g.dest), ['trash']);
}

// ---- the move is done, the copy is here
{
  const m = new MovedIn();
  m.add('a', 'trash', [T('t1'), T('t2', { accountId: 'a2' })], 0, 5);
  assert.equal(m.settle('a1'), false, 'a ghost whose move has not finished is not settled by a sync of its mailbox');
  m.commit(['t1', 't2'], 10_000);
  assert.equal(m.all().every((g) => g.committed && g.until === 10_000 + COMMITTED_MS), true);
  assert.equal(m.settle('a1'), true);
  assert.deepEqual(m.all().map((g) => g.thread.threadId), ['t2'], 'only the mailbox that was settled');
  // the list of the target folder has the conversation: it is really there
  m.landed('a2', 'trash', new Set(['t2']));
  assert.equal(m.size, 0);
  m.add('b', 'trash', [T('t3')], 0, 5);
  m.landed(null, 'archive', new Set(['t3']));
  assert.equal(m.size, 1, 'present in another folder says nothing');
}

// ---- time limits
{
  const m = new MovedIn();
  m.add('a', 'trash', [T('t1')], 1000, 10);
  assert.equal(m.all()[0].until, 1000 + 10_000 + QUEUED_GRACE_MS);
  m.expire(1000 + 10_000 + QUEUED_GRACE_MS - 1);
  assert.equal(m.size, 1);
  m.expire(1000 + 10_000 + QUEUED_GRACE_MS);
  assert.equal(m.size, 0, 'a move that never ended is given up');
  m.add('b', 'trash', [T('t2')], 0, 5);
  m.commit(['t2'], 50_000);
  m.expire(50_000 + COMMITTED_MS - 1);
  assert.equal(m.size, 1);
  m.expire(50_000 + COMMITTED_MS);
  assert.equal(m.size, 0, 'a copy that never arrived is given up');
}

// ---- the list: by date, once, pinned rows stay on top in the Inbox
{
  const list = [T('x1', { lastDate: 900 }), T('x2', { lastDate: 600 }), T('x3', { lastDate: 100 })];
  assert.deepEqual(mergeMoved(list, [T('g', { lastDate: 700 })], false, false).map((t) => t.threadId), ['x1', 'g', 'x2', 'x3']);
  assert.deepEqual(mergeMoved(list, [T('g', { lastDate: 2000 })], false, false).map((t) => t.threadId), ['g', 'x1', 'x2', 'x3'], 'newest on top');
  assert.deepEqual(mergeMoved(list, [T('g', { lastDate: 50 })], false, false).map((t) => t.threadId), ['x1', 'x2', 'x3', 'g'], 'oldest at the end');
  assert.deepEqual(mergeMoved([...list].reverse(), [T('g', { lastDate: 700 })], true, false).map((t) => t.threadId), ['x3', 'x2', 'g', 'x1'], 'oldest first order');
  assert.deepEqual(mergeMoved(list, [T('x2', { lastDate: 600 })], false, false).map((t) => t.threadId), ['x1', 'x2', 'x3'], 'not twice');
  assert.deepEqual(mergeMoved([], [T('g')], false, false).map((t) => t.threadId), ['g'], 'an empty folder');
  assert.equal(list.length, 3, 'the read list is not changed');
  // the Inbox: pinned first, whatever their date
  const inbox = [T('p', { pinned: true, lastDate: 10 }), T('y1', { lastDate: 900 }), T('y2', { lastDate: 100 })];
  assert.deepEqual(mergeMoved(inbox, [T('g', { lastDate: 500 })], false, true).map((t) => t.threadId), ['p', 'y1', 'g', 'y2']);
  assert.deepEqual(mergeMoved(inbox, [T('g', { lastDate: 5000 })], false, true).map((t) => t.threadId), ['p', 'g', 'y1', 'y2'], 'not above the pinned rows');
  assert.deepEqual(mergeMoved([T('p', { pinned: true })], [T('g', { lastDate: 5 })], false, true).map((t) => t.threadId), ['p', 'g']);
}

// ---- the numbers
{
  const rows = [F('a1', 'trash', 2, 10), F('a1', 'archive', 0, 4), F('a2', 'trash', 0, 1), F('a1', 'inbox', 5, 20, { unreadFocused: 3, unreadOther: 2 })];
  const read = withMovedCounts(rows, [{ dest: 'trash', thread: T('t1', { unread: 1 }) }, { dest: 'trash', thread: T('t2', { unread: 0 }) }], true);
  assert.deepEqual([read[0].unread, read[0].total], [3, 12], 'a read conversation adds to the total only');
  assert.equal(read[1], rows[1], 'other rows are the same objects');
  assert.equal(rows[0].total, 10, 'the input is not changed');
  assert.deepEqual([withMovedCounts(rows, [{ dest: 'trash', thread: T('t', { accountId: 'a2', unread: 1 }) }], true)[2].unread], [1], 'the row of its own mailbox');
  // back into the Inbox: the tab of its kind and the side-menu number
  const focused = withMovedCounts(rows, [{ dest: 'inbox', thread: T('t', { unread: 1 }) }], true)[3];
  assert.deepEqual([focused.unread, focused.unreadFocused, focused.unreadOther, focused.total], [6, 4, 2, 21]);
  const bulk = withMovedCounts(rows, [{ dest: 'inbox', thread: T('t', { unread: 1, bulk: true }) }], false)[3];
  assert.deepEqual([bulk.unread, bulk.unreadFocused, bulk.unreadOther], [5, 3, 3], 'bulk mail is not in the side-menu number when Other is not counted');
  // a folder that is not in the list (not listed yet) changes nothing
  assert.deepEqual(withMovedCounts(rows, [{ dest: 'f:None', thread: T('t', { unread: 1 }) }], true), rows);
}

// ---- wired: the store, the app and the backend
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
assert.match(store, /movedIn\.add\(token, dest, leaving,/, 'a queued move puts its mail into the target folder');
assert.match(store, /mergeMoved\(fresh, movedIn\.forView\(/, 'the list read of the target folder shows it');
assert.match(store, /withMovedCounts\(read, movedIn\.all\(\)/, 'the folder numbers count it');
assert.match(store, /cancelled && movedIn\.drop\(token\)/, 'Undo takes it out');
assert.match(store, /movedIn\.drop\(token\);[^\n]*\n[^\n]*\n?[\s\S]{0,400}export function moveRefused|export function moveRefused\(token: string, error: string\) \{\n  movedIn\.drop\(token\);/, 'a refused move takes it out');
assert.match(store, /movedIn\.has\(id, here\)/, 'the move being done does not take the arrived row out of the list');
assert.match(app, /movesCommitted\(e\.payload\.threadIds\)/);
assert.match(app, /"moves-settled"/);
assert.match(lib, /app\.emit\("moves-settled", MovesSettled/, 'the backend says when the copies are here');
console.log('PASS test-moved-in');
