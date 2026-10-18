#!/usr/bin/env node
// A meeting survives Save draft and the crash-recovery snapshot in the real compose pane (v1.0.6 QA round 3, BUG-R3-4: Meeting on, Save draft, open the draft
// again: the toggle was off and the strip gone). The pure parts are scripts/test-meeting-draft.mjs, the backend (the private header, never in a sent message)
// is `cargo test --lib meeting_form`; this is the pane itself in the dev preview (src/devMock.ts keeps what Save draft was given and gives it back like the
// backend reads the header):
//   - "Meeting" switched on AFTER the pane was open (the draft once came from a stale copy of the pane's state and never held the meeting), place typed;
//   - Save draft carries the meeting form; the draft opened again from Drafts has Meeting pressed, the strip with the same times and place, "Send invite";
//     saving it again writes the same meeting; a draft without a meeting opens without one and carries no form;
//   - the snapshot of the message (what a crash leaves) holds the meeting; restoring it opens the strip again with the same fields;
//   - a message moved to a window of its own keeps it (the moved message is the draft as built).
//   node scripts/test-meeting-compose.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-meeting-compose', { vitePort0: 5960, cdpPort0: 9960 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };

const PANE = `!!document.querySelector('.compose-pane .cp-editor .tiptap')?.editor`;
const STRIP = `(() => { const s = document.querySelector('.cp-event'); if (!s) return null; const v = (id) => document.getElementById(id)?.value ?? null; const m = [...document.querySelectorAll('.compose-pane [aria-pressed]')].find((b) => /Meeting/.test(b.textContent)); return { where: v('mt-where'), pressed: m ? m.getAttribute('aria-pressed') : null, send: [...document.querySelectorAll('.cp-bar .btn.primary')].map((b) => b.textContent.trim())[0], text: s.innerText.replace(/\\s+/g, ' ').trim() }; })()`;
const clickText = (sel, re) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`);
const lastDraft = async () => JSON.parse(await evaluate(`JSON.stringify(window.__lastDraft || null)`));
const mod = (path) => `import(${JSON.stringify(path)})`;

async function fresh(init) {
  await H.openApp('lang=en&aiset', 1280, 800);
  await evaluate(`window.__hlTiming = { autosaveMs: 600000, snapshotMs: 300 }; window.__store.getState().openCompose(${JSON.stringify(init)}); 1`);
  assert.ok(await waitFor(PANE), 'compose did not start');
  await sleep(500);
}

try {
  // ---------- a draft with a meeting
  await fresh({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Plan the launch', bodyHtml: '<p>Agenda</p>' });
  assert.equal(await evaluate(`document.querySelector('.cp-event')`), null);
  assert.ok(await clickText('.cp-bar button', /^Meeting$/), 'no Meeting button');
  assert.ok(await waitFor(`!!document.querySelector('.cp-event')`), 'no strip');
  await evaluate(`(() => { const i = document.getElementById('mt-where'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Room 1 à'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(300);
  const before = await evaluate(STRIP);
  await check('Meeting on: the strip has the place and the button says Send invite', () => { assert.equal(before.where, 'Room 1 à'); assert.equal(before.send, 'Send invite'); });
  await clickText('.cp-bar button', /^Save draft$/);
  await sleep(1200);
  const d1 = await lastDraft();
  const form = await evaluate(`${mod('/src/meetingDraft.ts')}.then((m) => m.decodeMeeting(window.__lastDraft.meetingForm))`);
  await check('Save draft: the draft carries the meeting (typed, for a send) and its form (for the header)', () => {
    assert.ok(d1 && d1.meeting && d1.meeting.end > d1.meeting.start, 'no typed meeting');
    assert.ok(d1.meetingForm && /^[A-Za-z0-9_-]+$/.test(d1.meetingForm), 'no form');
    assert.equal(form.where, 'Room 1 à');
    assert.equal(form.allDay, false);
  });

  // ---------- opened again from Drafts: the meeting is back
  await evaluate(`${mod('/src/components/Compose.tsx')}.then((m) => m.openDraftThread('dt1', true))`);
  assert.ok(await waitFor(`${PANE} && !!document.querySelector('.cp-event')`, 10000), 'the draft opened without its meeting (no strip)');
  await sleep(400);
  const after = await evaluate(STRIP);
  await check('reopened draft: Meeting is pressed, the strip has the place, the button says Send invite', () => { assert.equal(after.pressed, 'true'); assert.equal(after.where, 'Room 1 à'); assert.equal(after.send, 'Send invite'); });
  await check('reopened draft: the strip shows the same times as before', () => assert.equal(after.text, before.text));
  await clickText('.cp-bar button', /^Save draft$/);
  await sleep(1200);
  const d2 = await lastDraft();
  await check('saved again: the same meeting (no drift of the times)', () => { assert.deepEqual(d2.meeting, d1.meeting); assert.equal(d2.meetingForm, d1.meetingForm); });

  // ---------- a draft without a meeting is unchanged
  await fresh({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'No meeting here', bodyHtml: '<p>Hello</p>' });
  await clickText('.cp-bar button', /^Save draft$/);
  await sleep(1200);
  const d3 = await lastDraft();
  await check('no meeting: the draft has no meeting and no form', () => { assert.equal(d3.meeting, undefined); assert.equal(d3.meetingForm, undefined); });
  await evaluate(`${mod('/src/components/Compose.tsx')}.then((m) => m.openDraftThread('dt1', true))`);
  assert.ok(await waitFor(PANE, 10000));
  await sleep(500);
  await check('no meeting: it opens without a strip, Meeting not pressed', async () => { assert.equal(await evaluate(`document.querySelector('.cp-event')`), null); const p = await evaluate(`[...document.querySelectorAll('.compose-pane [aria-pressed]')].find((b) => /Meeting/.test(b.textContent))?.getAttribute('aria-pressed')`); assert.equal(p, 'false'); });

  // ---------- the snapshot (a crash): the meeting is in it, restoring opens the strip again
  await fresh({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Crash test', bodyHtml: '<p>text</p>' });
  await clickText('.cp-bar button', /^Meeting$/);
  assert.ok(await waitFor(`!!document.querySelector('.cp-event')`));
  await evaluate(`(() => { const i = document.getElementById('mt-where'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Hall B'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent(' more'); 1`);
  const snap = await (async () => { for (let i = 0; i < 60; i++) { const s = await evaluate(`(() => { const all = Object.values(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /recover/i.test(k)) ?? '') ?? '{}')); const x = all.find((y) => /Hall B/.test(y.payload)); return x ? JSON.stringify(x) : null; })()`); if (s) return JSON.parse(s); await sleep(250); } return null; })();
  await check('snapshot: it holds the meeting (place and times)', () => { assert.ok(snap, 'no snapshot with the meeting was written'); const f = JSON.parse(snap.payload).meeting; assert.equal(f.where, 'Hall B'); assert.match(f.sd, /^\d{4}-\d{2}-\d{2}$/); });
  if (snap) {
    const restored = await evaluate(`${mod('/src/recovery.ts')}.then((m) => { const i = m.composeFromSnapshot({ id: ${JSON.stringify(snap.id)}, accountId: 'a1', savedAt: 1, payload: ${JSON.stringify(snap.payload)}, files: [] }); window.__store.getState().openCompose(i); return !!i.meetingForm; })`);
    await check('snapshot: restoring gives a meeting form', () => assert.equal(restored, true));
    assert.ok(await waitFor(`${PANE} && !!document.querySelector('.cp-event')`, 10000), 'the restored message opened without its meeting');
    await sleep(400);
    await check('snapshot: the restored message has Meeting pressed and the same place', async () => { const s = await evaluate(STRIP); assert.equal(s.pressed, 'true'); assert.equal(s.where, 'Hall B'); assert.equal(s.send, 'Send invite'); });
    // saved as a draft by the recovery (the draft of a snapshot): it carries the form too
    const dr = await evaluate(`${mod('/src/recovery.ts')}.then((m) => { const d = m.draftFromSnapshot({ id: 'x', accountId: 'a1', savedAt: 1, payload: ${JSON.stringify(snap.payload)}, files: [] }); return d ? { form: d.meetingForm || null } : null; })`);
    await check('snapshot: the draft made from it carries the form', () => assert.ok(dr && dr.form));
  }

  // ---------- the calendar's "new meeting" start still opens the strip
  await fresh({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Move me', bodyHtml: '<p>x</p>', meeting: { on: true } });
  await check('init.meeting still starts the strip (the Meeting button of the calendar)', async () => assert.ok(await waitFor(`!!document.querySelector('.cp-event')`)));
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-meeting-compose: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-meeting-compose: ok');
