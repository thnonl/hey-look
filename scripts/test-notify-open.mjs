#!/usr/bin/env node
// A click on the notification of a new message opens that message wherever it is (1.0.7 D-051), in the real app in the dev preview (mock backend).
// The notification click is the event the backend sends (`open-thread`, shell.rs handle_activation); the preview's `__mockEmit` sends it too.
//   - a bulk message (the Other tab) while the Focused tab is open: the Other tab is selected, the row is in view, selected, and the reading pane shows it;
//   - a normal message while the Other tab is open: the Focused tab;
//   - a message of another mailbox while one mailbox's Inbox is open: that mailbox's Inbox; the unified Inbox stays;
//   - Focused Inbox off: no tabs, the row is there and open;
//   - a search and the Unread filter on: they are left / cleared, the row is there and open;
//   - the Inbox is sorted oldest first and the row is far down the list: it is scrolled into view;
//   - the calendar is open: the mail comes back;
//   - the conversation has a window of its own: that window is asked to come to the front (nothing else changes);
//   - the conversation is gone: a short notice (the one the reader window has), nothing opens, Reply from a notification opens no message either.
//   node scripts/test-notify-open.mjs [--quick] [--require-browser] [--url=http://127.0.0.1:1420/] [--shots=<dir>]
import fs from 'node:fs';
import path from 'node:path';
import { arg, flag, sleep, startHarness } from './cdp-harness.mjs';
import { notifyLookJs } from './lib/notify-open-probe.mjs';

const QUICK = flag('quick');
const SHOTS = arg('shots');
const H = await startHarness('test-notify-open', { vitePort0: 5740 });
const { evaluate, cdp } = H;
const failures = [];
const fail = (tag, msg) => failures.push(`[${tag}] ${msg}`);
const check = (tag, cond, msg) => { if (!cond) fail(tag, msg); };
const S = (js) => `window.__store.getState().${js}`;
const waitFor = async (js, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(50); } return false; };

// the new mail of the scenarios: an id, the list row it has (the mock's `bulk` puts it in the Other tab) and its subject
const MAILS = {
  nbulk: { subject: 'Shop weekly offers (bulk)', row: { bulk: true, unread: 1 } },
  nnorm: { subject: 'Lunch on Friday (normal)', row: { unread: 1 } },
  nbulk2: { subject: 'Account B newsletter (bulk)', row: { bulk: true, unread: 1, accountId: 'a2' } },
  nnorm2: { subject: 'Account B hello (normal)', row: { unread: 1, accountId: 'a2' } },
};

async function fresh(hash, prefs = {}) {
  await H.openApp(`lang=en&${hash}`, 1280, 800);
  await waitFor(`!${S('loading')} && !!document.querySelector('.pivots')`, 15000);
  await evaluate(`(() => { const add = window.__mockAddThread; ${Object.entries(MAILS).map(([id, m]) => `add(${JSON.stringify(id)}, ${JSON.stringify(m.subject)}, { fromName: 'Sender', html: '<p>Body of ${id}</p>', row: ${JSON.stringify(m.row)} });`).join(' ')} return 1; })()`);
  if (Object.keys(prefs).length) await evaluate(`${S(`setPrefs(${JSON.stringify(prefs)})`)}; 1`);
  await evaluate(`${S('refresh()')}; 1`);
  await sleep(500);
  await waitFor(`!${S('loading')}`, 8000);
}

/** The state a person sees: the open view, the selected tab, the row's place in the list, what the reading pane shows (scripts/lib/notify-open-probe.mjs, the same expression the QA bridge runs). */
// plus what only the dev preview can say: the store's own view of it
const look = async (id) => ({ ...JSON.parse(await evaluate(notifyLookJs(id))), ...(await evaluate(`(() => { const st = window.__store.getState(); return { folder: st.folder, accountId: st.accountId, focus: st.focus, filter: st.filter, search: st.search, module: st.module, selected: st.selected, compose: !!st.compose }; })()`)) });
const click = (id) => evaluate(`window.__mockEmit('open-thread', { threadId: ${JSON.stringify(id)} }); 1`);
const opened = async (tag, id, extra = '') => {
  const ok = await waitFor(`${S('selected')} === ${JSON.stringify(id)} && !!document.querySelector('.msg-frame')`, 6000);
  await sleep(300);
  const s = await look(id);
  check(tag, ok, `the conversation did not open: ${JSON.stringify(s)}`);
  check(tag, s.rowThere && s.rowSelected, `the row is not in the list / not selected: ${JSON.stringify(s)}`);
  check(tag, s.rowInView, `the row is not in view of the list: ${JSON.stringify(s)}`);
  check(tag, s.pane === MAILS[id].subject, `the reading pane shows "${s.pane}", not "${MAILS[id].subject}"`);
  check(tag, s.paneBody.includes(`Body of ${id}`), `the message body is "${s.paneBody}"`);
  return s;
};
const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64')); };

try {
  // 1. the bulk message, Focused tab open (the case of the report)
  await fresh('');
  let s0 = await look('nbulk');
  check('bulk', s0.focus === 'focused' && s0.tab === 'Focused' && !s0.rowThere, `start: ${JSON.stringify(s0)} (the bulk mail must not be in the Focused list)`);
  await click('nbulk');
  let s = await opened('bulk', 'nbulk');
  check('bulk', s.focus === 'other' && s.tab === 'Other', `the Other tab is not selected: ${JSON.stringify(s)}`);
  check('bulk', s.folder === 'inbox' && s.accountId === null, `the view changed to ${s.folder}/${s.accountId}`);
  await shot('bulk-other-tab');

  // 2. a normal message while the Other tab is open
  await click('nnorm');
  s = await opened('normal from Other', 'nnorm');
  check('normal from Other', s.focus === 'focused' && s.tab === 'Focused', `the Focused tab is not selected: ${JSON.stringify(s)}`);

  // 3. a message already in the open list: nothing else changes (the tab stays)
  await evaluate(`${S('setFocus("other")')}; 1`); await waitFor(`!${S('loading')}`);
  await click('nbulk');
  s = await opened('already listed', 'nbulk');
  check('already listed', s.focus === 'other', `the tab changed: ${JSON.stringify(s)}`);

  // 4. another mailbox: one mailbox's Inbox is open, the message is of the other and bulk
  await fresh('');
  await evaluate(`${S('setView("inbox", "a1")')}; 1`); await waitFor(`!${S('loading')}`);
  await click('nbulk2');
  s = await opened('other mailbox', 'nbulk2');
  check('other mailbox', s.accountId === 'a2' && s.folder === 'inbox' && s.focus === 'other' && s.tab === 'Other', `mailbox / tab: ${JSON.stringify(s)}`);
  await click('nnorm');
  s = await opened('back to the first mailbox', 'nnorm');
  check('back to the first mailbox', s.accountId === 'a1' && s.focus === 'focused', `mailbox / tab: ${JSON.stringify(s)}`);

  if (!QUICK) {
    // 5. Focused Inbox off: no tabs
    await fresh('', { focused: false });
    await click('nbulk');
    s = await opened('Focused Inbox off', 'nbulk');
    check('Focused Inbox off', s.tabs === 0, `there are ${s.tabs} tabs`);

    // 6. a search and the Unread filter are on
    await fresh('');
    await evaluate(`${S('setSearch("lunch")')}; 1`); await waitFor(`!${S('loading')}`);
    await click('nbulk');
    s = await opened('search on', 'nbulk');
    check('search on', s.search === '' && s.focus === 'other', `search "${s.search}", tab ${s.focus}`);
    await evaluate(`${S('setFilter("flagged")')}; 1`); await waitFor(`!${S('loading')}`);
    await click('nnorm');
    s = await opened('filter on', 'nnorm');
    check('filter on', s.filter === 'all', `the filter is still ${s.filter}`);

    // 7. oldest first, a mailbox of 360 conversations: the row is far down and is scrolled to
    await fresh('', { sortAsc: true });
    await evaluate(`window.__mockAddThread('nlate', 'Latest of all (far down)', { fromName: 'Sender', html: '<p>Body of nlate</p>', row: { unread: 1 } }); 1`);
    MAILS.nlate = { subject: 'Latest of all (far down)' };
    await evaluate(`${S('refresh()')}; 1`); await waitFor(`!${S('loading')}`);
    const before = await look('nlate');
    await click('nlate');
    s = await opened('far down', 'nlate');
    check('far down', !before.rowInView, `the row was in view before the click (${JSON.stringify(before)}), so this run did not test the scrolling`);
    delete MAILS.nlate;

    // 8. the calendar is open
    await fresh('');
    await evaluate(`${S('setModule("calendar")')}; 1`); await sleep(400);
    await click('nbulk');
    s = await opened('calendar open', 'nbulk');
    check('calendar open', s.module === 'mail', `module ${s.module}`);

    // 9. the conversation has a window of its own: that one is asked to come to the front, the main window stays as it is
    await fresh('');
    await evaluate(`(window.__popoutKeys ??= new Set()).add('reader|nbulk'); 1`);
    await click('nbulk'); await sleep(600);
    const w = await evaluate(`({ asked: (window.__popoutOpened || []).filter((o) => o.kind === 'reader' && o.key === 'nbulk').map((o) => o.focusOnly), made: window.__popoutOpens || 0, selected: ${S('selected')}, focus: ${S('focus')} })`);
    check('window of its own', w.asked.length >= 1 && w.asked.every((f) => f === true) && w.made === 0, `asked ${JSON.stringify(w)}`);
    check('window of its own', w.selected === null && w.focus === 'focused', `the main window changed: ${JSON.stringify(w)}`);

    // 10. gone: a notice, nothing opens; Reply from the notification opens nothing either
    await fresh('');
    await evaluate(`window.__mockGone.add('nbulk'); 1`);
    await click('nbulk'); await sleep(800);
    s = await look('nbulk');
    check('gone', s.selected === null && !s.rowThere && /moved or deleted/.test(s.toast), `selected ${s.selected}, toast "${s.toast}"`);
    await evaluate(`window.__mockEmit('notify-reply', { threadId: 'nbulk' }); 1`); await sleep(800);
    s = await look('nbulk');
    check('gone', s.selected === null && !s.compose, `Reply from the notification of a gone message opened something: ${JSON.stringify(s)}`);
    await evaluate(`window.__mockEmit('open-thread', { threadId: 'never-heard-of' }); 1`); await sleep(500);
    check('gone', /moved or deleted/.test((await look('x')).toast), 'an unknown conversation has no notice');
  }
} catch (e) {
  fail('run', e && e.stack ? e.stack : String(e));
} finally {
  await H.shutdown();
}
if (failures.length) { console.error('test-notify-open: FAILED\n  ' + failures.join('\n  ')); process.exit(1); }
console.log(`ok - test-notify-open${QUICK ? ' (quick)' : ''}`);
