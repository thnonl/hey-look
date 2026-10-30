#!/usr/bin/env node
// A moved or deleted mail is in the folder it went to at once (1.0.11, src/movedIn.ts), real list and side menu in the dev preview. The move waits out its Undo time (the dev mock never
// moves the rows), so what the target folder shows is the ghost:
//   - Delete / Archive: the mail is gone from the Inbox, the Trash / Archive list has its row at once (not after the Undo time) and the folder numbers counted it (total, unread);
//   - Undo: the row is not in the target folder any more and the numbers are as before;
//   - a refused move (`#refusemove`): the row leaves the target folder when the server says no, with the error.
//   node scripts/test-moved-in-ui.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-moved-in-ui', { vitePort0: 5710, cdpPort0: 9710 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const st = (expr) => `window.__store.getState().${expr}`;
const row = (key, acc) => json(`(() => { const f = ${st('folders')}.find((x) => x.key === ${JSON.stringify(key)} && x.accountId === ${JSON.stringify(acc)}); return f ? { unread: f.unread, total: f.total } : null; })()`);
const listIds = () => json(`${st('threads')}.map((t) => t.threadId)`);

async function start(flags = '') {
  await H.openApp(`lang=en${flags}`, 1280, 800);
  assert.ok(await waitFor(`${st('threads')}.length > 0 && ${st('folder')} === 'inbox'`, 15000), 'no Inbox rows');
  await sleep(500);
  await evaluate(`${st('setPrefs')}({ undoActionSeconds: 6 }); 1`);
}
const firstUnread = () => json(`(() => { const t = ${st('threads')}.find((x) => x.unread > 0) ?? ${st('threads')}[0]; return { id: t.threadId, acc: t.accountId, unread: t.unread > 0 }; })()`);

try {
  for (const [action, key] of [['trash', 'trash'], ['archive', 'archive']]) {
    await start();
    const t = await firstUnread();
    const before = await row(key, t.acc);
    await evaluate(`${st('act')}([${JSON.stringify(t.id)}], ${JSON.stringify(action)}, undefined, () => 'Done'); 1`);
    await check(`${action}: the mail leaves the Inbox list at once`, async () => {
      assert.ok(await waitFor(`!${st('threads')}.some((x) => x.threadId === ${JSON.stringify(t.id)})`, 3000), 'still in the Inbox');
    });
    await check(`${action}: the numbers of ${key} count it at once (total +1${t.unread ? ', unread +1' : ''})`, async () => {
      assert.ok(await waitFor(`${st('folders')}.some((f) => f.key === ${JSON.stringify(key)} && f.accountId === ${JSON.stringify(t.acc)} && f.total === ${before.total + 1})`, 3000), JSON.stringify(await row(key, t.acc)));
      const after = await row(key, t.acc);
      assert.equal(after.unread, before.unread + (t.unread ? 1 : 0));
    });
    await evaluate(`${st('setView')}(${JSON.stringify(key)}, ${JSON.stringify(t.acc)}); 1`);
    const t0 = Date.now();
    await check(`${action}: the ${key} folder lists the mail at once, well inside the Undo time`, async () => {
      assert.ok(await waitFor(`${st('folder')} === ${JSON.stringify(key)} && ${st('threads')}.some((x) => x.threadId === ${JSON.stringify(t.id)})`, 3000), 'not listed in ' + key);
      assert.ok(Date.now() - t0 < 3000);
      assert.equal(await evaluate(`!!document.querySelector('[data-thread=${JSON.stringify(t.id)}]')`), true, 'no row in the list');
    });
    await check(`${action}: a re-read of the list (a sync) keeps it there and the numbers do not count it twice`, async () => {
      await evaluate(`${st('refresh')}(); 1`);
      await sleep(600);
      assert.ok((await listIds()).includes(t.id));
      assert.equal((await row(key, t.acc)).total, before.total + 1);
    });
  }

  // ---------- Undo: the target folder does not list it, the numbers are back
  await start();
  {
    const t = await firstUnread();
    const before = await row('trash', t.acc);
    await evaluate(`${st('act')}([${JSON.stringify(t.id)}], 'trash', undefined, () => 'Deleted'); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.toasts .toast-undo')`, 4000), 'no Undo toast');
    assert.ok(await waitFor(`${st('folders')}.some((f) => f.key === 'trash' && f.accountId === ${JSON.stringify(t.acc)} && f.total === ${before.total + 1})`, 3000));
    await evaluate(`document.querySelector('.toasts .toast-undo').click(); 1`);
    await check('Undo: the numbers of Trash are as before and Trash does not list the mail', async () => {
      assert.ok(await waitFor(`${st('folders')}.some((f) => f.key === 'trash' && f.accountId === ${JSON.stringify(t.acc)} && f.total === ${before.total})`, 4000), JSON.stringify(await row('trash', t.acc)));
      await evaluate(`${st('setView')}('trash', ${JSON.stringify(t.acc)}); 1`);
      await sleep(900);
      assert.equal((await listIds()).includes(t.id), false);
    });
    await check('Undo: the mail is back in the Inbox', async () => {
      await evaluate(`${st('setView')}('inbox', ${JSON.stringify(t.acc)}); 1`);
      assert.ok(await waitFor(`${st('threads')}.some((x) => x.threadId === ${JSON.stringify(t.id)})`, 4000), 'not back');
    });
  }

  // ---------- a refused move: out of the target folder, the error shown
  await start('&refusemove=300');
  {
    const t = await firstUnread();
    const before = await row('archive', t.acc);
    await evaluate(`${st('setPrefs')}({ undoActionSeconds: 1 }); ${st('act')}([${JSON.stringify(t.id)}], 'archive', undefined, () => 'Archived'); 1`);
    assert.ok(await waitFor(`${st('folders')}.some((f) => f.key === 'archive' && f.accountId === ${JSON.stringify(t.acc)} && f.total === ${before.total + 1})`, 3000), 'not counted');
    await check('a refused move: Archive does not keep the mail, the numbers are as before and the error is shown', async () => {
      assert.ok(await waitFor(`${st('toasts')}.some((x) => /refused|failed|couldn/i.test(String(x.text ?? '')))`, 6000), 'no error toast: ' + (await evaluate(`JSON.stringify(${st('toasts')}.map((x) => x.text))`)));
      assert.ok(await waitFor(`${st('folders')}.some((f) => f.key === 'archive' && f.accountId === ${JSON.stringify(t.acc)} && f.total === ${before.total})`, 4000), JSON.stringify(await row('archive', t.acc)));
      await evaluate(`${st('setView')}('archive', ${JSON.stringify(t.acc)}); 1`);
      await sleep(900);
      assert.equal((await listIds()).includes(t.id), false);
    });
  }

  // ---------- RC1 round 5 observation O-r5-1 (mail that arrived while the window was open was missing from the list in one session): new mail that the sync brings (the backend event `mail-synced`
  // and the 30 s timer both run `refresh()`) is in the Inbox list whatever moved before in the same session: during the Undo time, after the move was committed, after an Undo, after the
  // Trash was visited, and in a burst of five.
  await start();
  {
    let n = 0;
    const arrive = async (label, count = 1) => {
      const mine = [];
      for (let i = 0; i < count; i++) {
        const id = `arrived${++n}`;
        mine.push(id);
        await evaluate(`window.__mockAddThread(${JSON.stringify(id)}, 'Arrived ${n}', { fromName: 'New', fromEmail: 'new${n}@example.org', html: '<p>hi</p>' }); 1`);
      }
      await evaluate(`${st('refresh')}().then(() => 1)`);
      await check(`${label}: ${count === 1 ? 'the new mail is' : 'all ' + count + ' new mails are'} in the Inbox list`, async () => {
        assert.ok(await waitFor(`${JSON.stringify(mine)}.every((id) => ${st('threads')}.some((x) => x.threadId === id))`, 4000), 'missing: ' + JSON.stringify((await listIds()).filter((x) => mine.includes(x))));
      });
    };
    await arrive('no move yet');
    const t = await firstUnread();
    await evaluate(`${st('act')}([${JSON.stringify(t.id)}], 'archive', undefined, () => 'Archived'); 1`);
    await sleep(400);
    await arrive('during the Undo time of an archive');
    await sleep(7000);
    await arrive('after the archive was committed');
    const t2 = await firstUnread();
    await evaluate(`${st('act')}([${JSON.stringify(t2.id)}], 'archive', undefined, () => 'Archived'); 1`);
    await sleep(400);
    await evaluate(`document.querySelector('.toasts .toast-undo')?.click(); 1`);
    await sleep(700);
    await arrive('after an archive and its Undo');
    const t3 = await firstUnread();
    await evaluate(`${st('act')}([${JSON.stringify(t3.id)}], 'trash', undefined, () => 'Deleted'); 1`);
    await sleep(400);
    await evaluate(`${st('setView')}('trash', ${JSON.stringify(t3.acc)}); 1`);
    await sleep(600);
    await evaluate(`${st('setView')}('inbox', ${JSON.stringify(t3.acc)}); 1`);
    await sleep(600);
    await arrive('after a delete, a visit to Trash and back');
    await arrive('a burst of five', 5);
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-moved-in-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-moved-in-ui: ok');
