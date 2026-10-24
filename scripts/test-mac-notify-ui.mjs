#!/usr/bin/env node
// 1.0.7 W5.10 (REQ-5.10.4, REQ-5.10.5; AC-5.10.3 page part, AC-5.10.4 page part, AC-5.10.7, AC-5.10.9) in the dev preview, whose mock plays the backend (src/devMock.ts: `#os=macos`, `#macnotify-denied`
// / `#macnotify-undetermined`, window.__mockPerm, window.__mockPermAnswer, window.__notifyLog):
//   - macOS, denied: Settings > Notifications & tray shows the muted note and the button "Open System Settings" under the Send test row (the old "not available" line is gone), the button asks the
//     backend to open the pane; Send test sends nothing and says the note as an info toast
//   - macOS, granted: no note, Send test sends; undetermined: Send test asks first (the person's answer decides), then sends or shows the note; the note follows a change made in System Settings
//     when the window gets the focus again (no restart); the note disappears when notifications are turned on there
//   - Windows and Linux: the page never asks for the permission and never shows the note
//   - 960x560 and 1280x800, light and dark, 8 languages: the note and the button fit inside the settings body, no raw key, no clipping; the button comes after the note in the tab order and its
//     accessible name is its label
//   node scripts/test-mac-notify-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness, languageJs } from './cdp-harness.mjs';

const H = await startHarness('test-mac-notify-ui', { vitePort0: 6020 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const S = (path) => `window.__store.getState().${path}`;
const openTray = async (hash, w = 1280, h = 800) => {
  await H.openApp(hash, w, h);
  await evaluate(`${S('setDialog')}({ type: 'settings', tab: 'tray' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.settings-body') && [...document.querySelectorAll('.settings-body button')].some((b) => /send test/i.test(b.textContent))`), 'the tray tab did not open');
  await sleep(250); // the permission is read once the tab is on screen
};
const note = () => evaluate(`(() => {
  const n = document.querySelector('.mac-notify-denied');
  if (!n) return null;
  const t = n.querySelector('.muted'), b = n.querySelector('button'), body = document.querySelector('.settings-body').getBoundingClientRect(), r = n.getBoundingClientRect(), br = b.getBoundingClientRect();
  return { text: t.textContent.trim(), button: b.textContent.trim(), name: b.getAttribute('aria-label') || b.textContent.trim(), inside: r.left >= body.left - 1 && r.right <= body.right + 1 && br.left >= body.left - 1 && br.right <= body.right + 1,
    clipped: b.scrollWidth > b.clientWidth + 1 || t.scrollWidth > t.clientWidth + 1, muted: getComputedStyle(t).color !== getComputedStyle(document.body).color, textBeforeButton: !!(t.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), h: Math.round(r.height) };
})()`);
const log = () => evaluate(`window.__notifyLog || []`);
const clickSendTest = () => evaluate(`[...document.querySelectorAll('.settings-body button')].find((b) => /send test/i.test(b.textContent)).click(); 1`);
const toast = () => evaluate(`(document.querySelector('.toast .toast-text') || {}).textContent || null`);
const DENIED_EN = 'Notifications for Hey Look! are turned off in macOS, so banners and the Dock badge don’t appear. Turn them on in System Settings > Notifications.';

try {
  await check('macOS, denied: the note and the button under the Send test row; the old line is gone', async () => {
    await openTray('lang=en&os=macos&macnotify-denied');
    const n = await note();
    assert.ok(n, 'no note');
    assert.equal(n.text, DENIED_EN);
    assert.equal(n.button, 'Open System Settings');
    assert.equal(n.name, 'Open System Settings');
    assert.ok(n.textBeforeButton, 'the button comes after the note');
    assert.ok(n.muted, 'the note is the muted colour');
    assert.equal(await evaluate(`document.body.innerText.includes('aren’t available on macOS')`), false);
    // it sits below the Send test row, before the next row
    assert.ok(await evaluate(`(() => { const note = document.querySelector('.mac-notify-denied'), row = [...document.querySelectorAll('.settings-body .set-row')].find((r) => /send test/i.test(r.textContent)); return !!(row.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING) && note.previousElementSibling === row; })()`), 'not under the Send test row');
  });

  await check('the button asks the backend to open System Settings; Send test sends nothing and shows the note as a toast', async () => {
    await evaluate(`document.querySelector('.mac-notify-denied button').click(); 1`);
    await sleep(80);
    assert.deepEqual(await log(), ['open-settings']);
    await clickSendTest();
    assert.ok(await waitFor(`!!document.querySelector('.toast')`), 'no toast');
    assert.equal(await toast(), DENIED_EN);
    assert.equal(await evaluate(`!!document.querySelector('.toast.error')`), false, 'an info toast, not an error');
    assert.deepEqual(await log(), ['open-settings'], 'nothing was sent');
  });

  await check('the note follows System Settings: gone when notifications are turned on there and the window is focused, back when they are turned off', async () => {
    await evaluate(`window.__mockPerm = 'granted'; window.dispatchEvent(new Event('focus')); 1`);
    assert.ok(await waitFor(`!document.querySelector('.mac-notify-denied')`), 'the note stays after the permission was given');
    await evaluate(`window.__mockPerm = 'denied'; window.dispatchEvent(new Event('focus')); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.mac-notify-denied')`), 'the note does not come back');
  });

  await check('macOS, granted: no note, Send test sends', async () => {
    await openTray('lang=en&os=macos');
    assert.equal(await note(), null);
    await clickSendTest();
    await sleep(150);
    assert.deepEqual(await log(), ['test']);
    assert.equal(await evaluate(`!!document.querySelector('.toast.error')`), false);
  });

  await check('macOS, undetermined: Send test asks first; Allow -> it sends; Don’t Allow -> no banner, the note shows', async () => {
    await openTray('lang=en&os=macos&macnotify-undetermined');
    assert.equal(await note(), null, 'no note before the person was asked');
    await clickSendTest();
    await sleep(200);
    assert.deepEqual(await log(), ['ask', 'test']);
    assert.equal(await note(), null);
    await openTray('lang=en&os=macos&macnotify-undetermined');
    await evaluate(`window.__mockPermAnswer = 'denied'; 1`);
    await clickSendTest();
    assert.ok(await waitFor(`!!document.querySelector('.mac-notify-denied')`), 'the note does not show after Don’t Allow');
    assert.deepEqual(await log(), ['ask'], 'nothing was sent after Don’t Allow');
    assert.equal(await toast(), DENIED_EN);
  });

  for (const os of ['windows', 'linux']) {
    await check(`${os}: the page never asks for the permission and never shows the note`, async () => {
      await openTray(`lang=en&os=${os}&macnotify-denied`);
      assert.equal(await note(), null);
      await clickSendTest();
      await sleep(150);
      assert.deepEqual(await log(), ['test'], 'only the test notification');
    });
  }

  await check('AC-5.10.7 the note and the button fit at 960x560 and 1280x800 in the 8 languages, light and dark, no raw key', async () => {
    for (const [w, h] of [[960, 560], [1280, 800]]) {
      await openTray('lang=en&os=macos&macnotify-denied', w, h);
      for (const theme of ['light', 'dark']) {
        await evaluate(`${S('setPrefs')}({ theme: ${JSON.stringify(theme)} }); 1`);
        for (const lang of ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru']) {
          await evaluate(languageJs(lang));
          await sleep(80);
          const n = await note();
          assert.ok(n, `${lang}: no note`);
          assert.ok(n.inside && !n.clipped, `${w} ${theme} ${lang}: ${JSON.stringify(n)}`);
          assert.ok(!/settings\./.test(n.text + n.button), `${lang}: a raw key shows`);
          assert.ok(n.text.length > 20 && n.button.length > 3, `${lang}: empty texts`);
          assert.ok(n.h < 220, `${w} ${theme} ${lang}: the note is ${n.h} px high`);
        }
      }
    }
  });

  await check('the button is reachable with Tab after the note and works with Enter', async () => {
    await openTray('lang=en&os=macos&macnotify-denied');
    await evaluate(`document.querySelector('.mac-notify-denied button').focus(); 1`);
    assert.equal(await evaluate(`document.activeElement.textContent.trim()`), 'Open System Settings');
    assert.equal(await evaluate(`document.activeElement.tabIndex >= 0 && !document.activeElement.disabled`), true);
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-mac-notify-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-mac-notify-ui: ok');
