#!/usr/bin/env node
// Settings > Mailboxes > (mailbox) > Reply-to address (1.0.7 W2.21, REQ-2.21.1, AC-2.21.2, AC-2.21.3, AC-2.21.6). Real Settings dialog in the dev preview:
//   - the row is there under "Display name", with its hint, in every language, and is not shown for "All accounts";
//   - an address is saved when the field is left; empty clears it; the mailbox's own address is saved too (the header is left out when mail is sent);
//   - text that is not one address (a name part, a list, words) shows "Enter a valid email address" under the field and the old value stays saved;
//   - label and hint are not clipped at 960 x 560.
//   node scripts/test-reply-to-setting.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness, inputs } from './cdp-harness.mjs';

const H = await startHarness('test-reply-to-setting', { vitePort0: 5662 });
const { evaluate } = H;
const { typeText, click } = inputs(H, null, 'reply-to');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(100); } return false; };

/** Settings on `tab`, without loading the page again (the mock keeps what was saved) */
const reopen = async (tab) => {
  await evaluate(`window.__store.getState().setDialog(null); 1`);
  await sleep(300);
  await evaluate(`window.__store.getState().setDialog(${JSON.stringify({ type: 'settings', tab })}); 1`);
  if (tab !== 'mb:all' && await waitFor(`!!document.querySelector('.nav-sub button')`, 15000)) await evaluate(`document.querySelector('.nav-sub button').click(); 1`);
};
const open = async (hash, tab, w = 1280, h = 800) => {
  await H.openApp(hash, w, h);
  await evaluate(`window.__store.getState().setDialog(${JSON.stringify({ type: 'settings', tab })}); 1`);
  // the section of a mailbox page that holds the Profile (the first one under the mailbox)
  if (tab !== 'mb:all' && await waitFor(`!!document.querySelector('.nav-sub button')`, 15000)) await evaluate(`document.querySelector('.nav-sub button').click(); 1`);
};
const stored = () => evaluate(`window.__store.getState().accounts.find((a) => a.id === 'a1')?.replyTo ?? ''`);
const field = `#set-replyTo input`;
const errText = () => evaluate(`document.querySelector('#set-replyTo .field-err')?.textContent ?? null`);
/** select all in the field, type `text`, and leave the field by pressing the Display name field */
async function enter(text) {
  await click(field);
  await evaluate(`document.querySelector(${JSON.stringify(field)}).select(); 1`);
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  if (text) await typeText(text, 5);
  await click('.settings-body .set-row input', 'first'); // (the first row of the page is the Display name: pressing it ends the edit)
  await sleep(300);
}

try {
  await open('lang=en', 'mb:a1');
  assert.ok(await waitFor(`!!document.querySelector('${field}')`, 15000), 'the Reply-to row did not show');

  await check('the row is under Display name with its label and hint', async () => {
    const rows = await evaluate(`[...document.querySelectorAll('.settings-body .set-row')].slice(0, 3).map((r) => r.querySelector('.set-lbl').innerText.replace(/\\s+/g, ' ').trim())`);
    assert.match(rows[0], /^Display name/, rows[0]);
    assert.equal(rows[1], 'Reply-to address Replies to mail you send from this mailbox go to this address. Leave empty to get replies here.');
    assert.equal(await evaluate(`document.querySelector('${field}').placeholder`), '', 'no placeholder');
  });

  await check('an address is saved when the field is left', async () => {
    await enter('team@x.test');
    assert.equal(await errText(), null);
    assert.equal(await stored(), 'team@x.test');
  });

  await check('text that is not an address shows the error and the old value stays saved', async () => {
    for (const bad of ['not an address', 'Team <team@x.test>', 'a@x.test, b@x.test']) {
      await enter(bad);
      assert.equal(await errText(), 'Enter a valid email address', bad);
      assert.equal(await evaluate(`document.querySelector('${field}').getAttribute('aria-invalid')`), 'true');
      assert.equal(await stored(), 'team@x.test', `${bad}: nothing was saved`);
    }
    // reopening Settings shows the saved value
    await reopen('mb:a1');
    assert.ok(await waitFor(`!!document.querySelector('${field}')`));
    assert.equal(await evaluate(`document.querySelector('${field}').value`), 'team@x.test');
    assert.equal(await errText(), null);
  });

  await check('typing again takes the error away; the mailbox\'s own address is accepted; empty clears it', async () => {
    await enter('oops');
    assert.equal(await errText(), 'Enter a valid email address');
    await click(field);
    await typeText('x', 5);
    assert.equal(await errText(), null, 'the error goes when the person types again');
    await enter('nam@example.com');
    assert.equal(await stored(), 'nam@example.com');
    await enter('');
    assert.equal(await stored(), '');
    assert.equal(await errText(), null);
  });

  await check('not shown for All accounts', async () => {
    await open('lang=en', 'mb:all');
    assert.ok(await waitFor(`!!document.querySelector('.settings-body .set-row')`, 15000));
    assert.equal(await evaluate(`!!document.querySelector('#set-replyTo')`), false);
  });

  // 8 languages at 960 x 560: the texts are there, label and hint fit
  const want = { en: 'Reply-to address', vi: 'Địa chỉ nhận thư trả lời', fr: 'Adresse de réponse', 'zh-Hans': '回复地址', es: 'Dirección de respuesta', ja: '返信先アドレス', de: 'Antwortadresse', ru: 'Адрес для ответа' };
  for (const [lang, label] of Object.entries(want)) {
    await check(`${lang}: label and hint at 960 x 560`, async () => {
      await open(`lang=${lang}`, 'mb:a1', 960, 560);
      assert.ok(await waitFor(`!!document.querySelector('${field}')`, 15000), 'no row');
      await sleep(400);
      const r = await evaluate(`(() => { const row = document.querySelector('#set-replyTo'), l = row.querySelector('.set-lbl'), h = l.querySelector('.muted'); const c = row.querySelector('.set-ctl input').getBoundingClientRect(), d = document.querySelector('.settings-body').getBoundingClientRect(); return { label: l.firstElementChild.textContent.trim(), hint: h.textContent.trim().length, clipped: l.scrollWidth > l.clientWidth + 1 || h.scrollWidth > h.clientWidth + 1, inside: c.right <= d.right + 1 && c.left >= d.left - 1, raw: /settings\\.profile/.test(row.innerText) }; })()`);
      assert.equal(r.label, label);
      assert.ok(r.hint > 20 && !r.raw, JSON.stringify(r));
      assert.ok(!r.clipped && r.inside, `clipped: ${JSON.stringify(r)}`);
    });
  }
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-reply-to-setting: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-reply-to-setting: ok');
