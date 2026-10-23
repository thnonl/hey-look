#!/usr/bin/env node
// 1.0.7 W13.8 (REQ-13.8.1, REQ-13.8.8; AC-13.8.1, AC-13.8.4, AC-13.8.8, AC-13.8.11) in the dev preview: Settings > Mailboxes > Notifications has ONE sound row, a switch (on by default) with its hint and the
// button "Play sound", which asks the backend for the sound once, switch on or off, and says "Couldn't play the sound on this computer." when it cannot; a mailbox can override the switch;
// a 1.0.6 profile with Silent starts with the switch off, one with another sound with it on; the row fits at 960x560 in the 8 languages; the old select is gone.
//   node scripts/test-notify-sound-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness, languageJs } from './cdp-harness.mjs';

const H = await startHarness('test-notify-sound-ui', { vitePort0: 5340 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const S = (path) => `window.__store.getState().${path}`;
const openFresh = async (hash = 'lang=en', w = 1280, h = 800, stored = null) => {
  const s = stored ? await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('hl-mock-settings', ${JSON.stringify(JSON.stringify(stored))});` }) : null;
  try { await H.openApp(hash, w, h); } finally { if (s) await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.identifier }); }
};
/** Settings > Mailboxes > (All accounts | the first mailbox) > Notifications */
const openNotifications = async (mailbox = false) => {
  await evaluate(`${S('setDialog')}(null); ${S('setDialog')}({ type: 'settings', tab: ${mailbox ? "'mb:' + window.__store.getState().accounts[0].id" : "'mb:all'"} }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.nav-sub button')`), 'Settings did not open');
  // the section list of the mailbox page: Notifications is the one that holds the sound row (the test opens it in English)
  assert.ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.nav-sub button')].find((x) => /notif/i.test(x.textContent)); if (!b) return false; b.click(); return true; })()`), 'no Notifications section');
  assert.ok(await waitFor(`!!document.querySelector('.sound-row')`), 'the Notifications section has no sound row');
  await sleep(150);
};
const row = () => evaluate(`(() => { const r = document.querySelector('.sound-row')?.closest('.set-row'); if (!r) return null; const sw = r.querySelector('input[type=checkbox]'); const btn = r.querySelector('.sound-play'); const rr = r.getBoundingClientRect(), dr = document.querySelector('.settings-body').getBoundingClientRect(); return { label: r.querySelector('.set-lbl > div').textContent.trim(), hint: (r.querySelector('.set-lbl .muted') || {}).textContent || null, on: sw.checked, swName: sw.getAttribute('aria-label'), btn: btn.textContent.trim(), selects: r.querySelectorAll('select').length, tag: (r.querySelector('.ov-tag') || {}).textContent || null, tagOwn: !!r.querySelector('.ov-tag.own'), clipped: btn.scrollWidth > btn.clientWidth + 1 || r.scrollWidth > r.clientWidth + 1, inside: rr.left >= dr.left - 1 && rr.right <= dr.right + 1, h: Math.round(rr.height) }; })()`);
const plays = () => evaluate(`window.__mockSoundPlays || 0`);
const clickSwitch = () => evaluate(`document.querySelector('.sound-row input[type=checkbox]').click(); 1`);

try {
  await openFresh('lang=en&persist');
  await check('AC-13.8.1 fresh profile: "Sound" is on, with the hint and "Play sound"; no select any more', async () => {
    await openNotifications();
    const r = await row();
    assert.equal(r.label, 'Sound');
    assert.equal(r.hint, 'Plays a short sound when new mail arrives. It follows your system volume.');
    assert.equal(r.on, true);
    assert.equal(r.btn, 'Play sound');
    assert.equal(r.selects, 0);
    assert.equal(r.swName, 'Sound');
    assert.equal(await evaluate(S('prefs.notifySound')), 'pop');
  });

  await check('Play sound asks the backend once per press, with the switch on and off', async () => {
    assert.equal(await plays(), 0);
    await evaluate(`document.querySelector('.sound-play').click(); 1`);
    await sleep(100);
    assert.equal(await plays(), 1);
    await clickSwitch();
    await sleep(100);
    assert.equal(await evaluate(S('prefs.notifySound')), 'none');
    assert.equal((await row()).on, false);
    await evaluate(`document.querySelector('.sound-play').click(); 1`);
    await sleep(100);
    assert.equal(await plays(), 2, 'the preview plays also when the switch is off');
    assert.equal(await evaluate(`!!document.querySelector('.toast.error')`), false);
    await clickSwitch();
    await sleep(100);
    assert.equal(await evaluate(S('prefs.notifySound')), 'pop');
  });

  await check('AC-13.8.4 a mailbox can switch it off for itself, "All accounts" stays on; Same as all accounts / own tag', async () => {
    await openNotifications(true);
    let r = await row();
    assert.equal(r.on, true);
    assert.ok(r.tag && !r.tagOwn, JSON.stringify(r));
    await clickSwitch();
    await sleep(120);
    r = await row();
    assert.equal(r.on, false);
    assert.ok(r.tagOwn, 'the own-value tag shows');
    assert.equal(await evaluate(S('prefs.notifySound')), 'pop', 'All accounts is unchanged');
    const id = await evaluate(S('accounts[0].id'));
    assert.equal(await evaluate(`${S('prefs.accountPrefs')}[${JSON.stringify(id)}].notifySound`), 'none');
    await evaluate(`document.querySelector('.sound-row').closest('.set-row').querySelector('.ov-tag.own').click(); 1`);
    await sleep(120);
    assert.equal((await row()).on, true, 'back to the value of All accounts');
  });

  await check('the preview that cannot play says so (settings.notify.playFailed)', async () => {
    await openFresh('lang=en&nosound');
    await openNotifications();
    await evaluate(`document.querySelector('.sound-play').click(); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.toast.error')`));
    assert.equal(await evaluate(`document.querySelector('.toast.error .toast-text').textContent.trim()`), 'Couldn’t play the sound on this computer.');
  });

  await check('AC-13.8.8 a 1.0.6 profile: Silent stays off, another sound is on, in All accounts and in a mailbox', async () => {
    await openFresh('lang=en&persist', 1280, 800, { prefs: JSON.stringify({ language: 'en', prefsRev: 1, notifySound: 'none' }) });
    assert.equal(await evaluate(S('prefs.notifySound')), 'none');
    await openNotifications();
    assert.equal((await row()).on, false);
    await openFresh('lang=en&persist', 1280, 800, { prefs: JSON.stringify({ language: 'en', prefsRev: 1, notifySound: 'sms' }) });
    assert.equal(await evaluate(S('prefs.notifySound')), 'pop');
    await openNotifications();
    assert.equal((await row()).on, true);
    await openFresh('lang=en&persist', 1280, 800, { prefs: JSON.stringify({ language: 'en', prefsRev: 1, notifySound: 'reminder', accountPrefs: { a1: { notifySound: 'none' }, a2: { notifySound: 'im' } } }) });
    assert.deepEqual(await evaluate(`[${S('prefs.accountPrefs.a1.notifySound')}, ${S('prefs.accountPrefs.a2.notifySound')}]`), ['none', 'pop'], 'the own values of the mailboxes are read the same way');
    // nothing stored at all: on
    await openFresh('lang=en&persist', 1280, 800, { prefs: JSON.stringify({ language: 'en', prefsRev: 1 }) });
    assert.equal(await evaluate(S('prefs.notifySound')), 'pop');
  });

  await check('AC-13.8.11 the row fits at 960x560 and 1280x800 in the 8 languages, light and dark', async () => {
    for (const [w, h] of [[960, 560], [1280, 800]]) {
      await openFresh('lang=en', w, h);
      await openNotifications();
      for (const theme of ['light', 'dark']) {
        await evaluate(`${S('setPrefs')}({ theme: ${JSON.stringify(theme)} }); 1`);
        for (const lang of ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru']) {
          await evaluate(languageJs(lang));
          await sleep(80);
          const r = await row();
          assert.ok(r, `${lang}: no row`);
          assert.ok(!r.clipped && r.inside, `${w} ${theme} ${lang}: ${JSON.stringify(r)}`);
          assert.ok(r.btn && !/settings\./.test(r.btn + r.hint + r.label), `${lang}: a raw key shows`);
          assert.ok(r.h < 190, `${w} ${theme} ${lang}: the row is ${r.h} px high`);
        }
      }
    }
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-notify-sound-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-notify-sound-ui: ok');
