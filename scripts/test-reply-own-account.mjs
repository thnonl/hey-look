#!/usr/bin/env node
// 1.0.9 BUG-3: Reply to a message that another account of the person sent opened a draft with an EMPTY To (both addresses counted as "mine", so the sender was removed).
// The message is received mail in the account it is in: Reply / Reply all go to the sender, Forward starts empty; in the Sent folder of the sending account Reply still goes to the
// recipients. Real buttons in the dev preview (src/devMock.ts: accounts a1 nam@example.com and a2 nam@gmail.com); the To row of the compose pane is read.
//   node scripts/test-reply-own-account.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-reply-own-account', { vitePort0: 5910 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 600)}`); console.error('FAIL', failures.at(-1)); } };
const waitFor = async (js, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };
const paneReady = `(() => { const p = document.querySelector('.compose-pane'); return !!p && !p.classList.contains('preparing') && !!p.querySelector('.cp-editor .tiptap .quote-block'); })()`;
const rows = () => evaluate(`JSON.stringify((() => { const t = (e) => e.textContent.replace(/\\s+/g, ' ').trim(); const p = document.querySelector('.compose-pane');
  const row = (label) => [...p.querySelectorAll('.cp-fields .cf-field')].filter((f) => t(f.querySelector('label')) === label).flatMap((f) => [...f.querySelectorAll('.chips > span')].map(t));
  const clean = (a) => a.map((x) => x.replace(/[\\s\\u200b-\\u200d\\u2060\\ufeff]/g, ''));
  return { to: clean(row('To')), cc: clean(row('Cc')), from: p.querySelector('.cf-from, .cf-field.from')?.textContent.replace(/\\s+/g, ' ').trim() ?? '' }; })())`).then(JSON.parse);

async function answer(thread, button) {
  await evaluate(`window.__store.getState().openCompose(null, { restore: false }); window.__store.getState().select(${JSON.stringify(thread)}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), 'the message did not open');
  await sleep(400);
  assert.ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open button')].find((x) => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(button)}); if (!b) return false; b.click(); return true; })()`), `no ${button} button`);
  assert.ok(await waitFor(paneReady, 15000), 'the compose pane never filled in');
  await sleep(300);
  return rows();
}

try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(`(() => {
    const add = window.__mockAddThread;
    // in a1's Inbox, sent by the person's other account a2 to a1 (and to an outside address)
    add('oa-in', 'From my other account', { fromName: 'Nam Gmail', fromEmail: 'nam@gmail.com', to: 'nam@example.com,bob@ext.test', cc: 'carol@ext.test', html: '<p>hello</p>' });
    return true; })()`);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  await check('Reply to a mail from my other account: To is that account', async () => {
    const r = await answer('oa-in', 'Reply');
    assert.equal(r.to.length, 1, `To ${JSON.stringify(r)}`);
    assert.match(r.to[0], /nam@gmail\.com/);
    assert.deepEqual(r.cc, []);
  });
  await check('Reply all: To is the sender and the outside recipient, Cc the outside Cc; the account the mail is in is not in it', async () => {
    const r = await answer('oa-in', 'Reply all');
    assert.ok(r.to.some((x) => /nam@gmail\.com/.test(x)), `To ${JSON.stringify(r)}`);
    assert.ok(r.to.some((x) => /bob@ext\.test/.test(x)), `To ${JSON.stringify(r)}`);
    assert.ok(![...r.to, ...r.cc].some((x) => /nam@example\.com/.test(x)), `the account the mail is in is in the answer ${JSON.stringify(r)}`);
    assert.ok(r.cc.some((x) => /carol@ext\.test/.test(x)), `Cc ${JSON.stringify(r)}`);
  });
  await check('Forward starts without a recipient', async () => {
    const r = await answer('oa-in', 'Forward');
    assert.deepEqual(r.to, []);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-reply-own-account: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-reply-own-account: ok');
