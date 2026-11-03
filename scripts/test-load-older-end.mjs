#!/usr/bin/env node
// 1.0.13: a mailbox whose whole mail is on this computer says "You've reached the end" at once, not "Load older messages" until the button was pressed once. The backend keeps the mark
// (`folder_ends`: the `exhausted:` mark, or nothing older than UID 1); the page reads it after the list loads and after every sync (the sync no longer clears it). In the dev preview
// (`#big` = mail on the server per mailbox, `#local` = already downloaded):
//   E1  everything downloaded (all mailboxes, one mailbox, the Unread view): the end line at once, no button, not one load_older request, also after a sync
//   E2  part of the mail downloaded: the button; a press runs to the end, the end line stays, and a sync keeps it
//   E3  a combined view is at its end only when EVERY mailbox is: one mailbox with older mail keeps the button
//   E4  the persisted mark going away (the dev preview's mailbox gets older mail on the server): the next list read offers the button again
//   E5  the Focused / Other tabs and a filter show the same line as before (the mailbox's end), the button where a mailbox is not done
//   node scripts/test-load-older-end.mjs [--require-browser]
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-load-older-end', { vitePort0: 5360 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const waitFor = async (js, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(60); } return false; };
const foot = () => evaluate(`(() => { const f = document.querySelector('.ml-foot'); return JSON.stringify({ text: f ? f.textContent.replace(/\s+/g, ' ').trim() : null, buttons: f ? [...f.querySelectorAll('button')].map((b) => b.textContent.trim()) : [], calls: window.__mockMail.calls.length, rows: document.querySelectorAll('.ml-row').length }); })()`).then(JSON.parse);
const open = async (hash, view = "'inbox', null") => {
  await H.openApp(hash, 1000, 700);
  await evaluate(`window.__store.getState().setView(${view}); 1`);
  await waitFor(`!window.__store.getState().loading && document.querySelectorAll('.ml-row').length > 0`, 10000);
  await sleep(500);
};
const END = /reached the end/i, OLDER = /Load older/i;
const isEnd = async (label) => { const f = await foot(); assert(END.test(f.text ?? '') && f.buttons.length === 0, `${label}: wanted the end line, got ${JSON.stringify(f)}`); return f; };
const isButton = async (label) => { const f = await foot(); assert(f.buttons.some((b) => OLDER.test(b)), `${label}: wanted the Load older button, got ${JSON.stringify(f)}`); return f; };
const sync = async () => { await evaluate(`window.__store.getState().sync().then(() => 1)`); await sleep(500); };

try {
  await check('E1 everything downloaded', async () => {
    await open('big=120&local=120');
    assert((await isEnd('all mailboxes')).calls === 0, 'a request was made');
    await sync();
    assert((await isEnd('after a sync')).calls === 0, 'a request after the sync');
    await evaluate(`window.__store.getState().setView('inbox', 'a1'); 1`); await sleep(500);
    await isEnd('one mailbox');
    await evaluate(`window.__store.getState().setView('unread', null); 1`); await sleep(500);
    const f = await foot();
    assert(f.rows === 0 || (END.test(f.text ?? '') && f.buttons.length === 0), `the Unread view: ${JSON.stringify(f)}`);
  });
  await check('E2 part downloaded, the button runs to the end and a sync keeps it', async () => {
    await open('big=120&local=15&olderdelay=50', "'inbox', 'a1'");
    await isButton('start');
    for (let i = 0; i < 12; i++) {
      if (END.test((await foot()).text ?? '')) break;
      await evaluate(`[...document.querySelectorAll('.ml-foot button')].find((b) => /Load older/.test(b.textContent))?.click(); 1`);
      await waitFor(`!window.__store.getState().loadingMore`, 15000); await sleep(300);
    }
    await isEnd('after the presses');
    const calls = (await foot()).calls;
    await sync();
    const f = await isEnd('after a sync');
    assert(f.calls === calls, 'the sync asked the server again');
  });
  await check('E3 a combined view needs every mailbox', async () => {
    await open('big=120&local=120');
    await isEnd('all done');
    // a mailbox gets older mail on the server (the mark is gone): the combined view offers the button again after its next read
    await evaluate(`window.__mockMail.total.a1 += 50; 1`);
    await evaluate(`window.__store.getState().refresh().then(() => 1)`); await sleep(500);
    await isButton('one mailbox not done');
    await evaluate(`window.__store.getState().setView('inbox', 'a1'); 1`); await sleep(500);
    await isButton('that mailbox alone');
    await evaluate(`window.__store.getState().setView('inbox', 'a2'); 1`); await sleep(500);
    await isEnd('another mailbox alone');
  });
  await check('E5 tabs and filters', async () => {
    await open('big=120&local=120');
    await evaluate(`window.__store.getState().setFocus('other').then(() => 1)`); await sleep(500);
    const f = await foot();
    assert(f.rows === 0 || (END.test(f.text ?? '') && f.buttons.length === 0), `Other: ${JSON.stringify(f)}`);
    await open('big=120&local=15');
    await evaluate(`window.__store.getState().setFocus('other').then(() => 1)`); await sleep(500);
    const g = await foot();
    assert(g.rows === 0 || g.buttons.some((b) => OLDER.test(b)), `Other with older mail on the server: ${JSON.stringify(g)}`);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error('test-load-older-end: FAILED\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('test-load-older-end: ok');
