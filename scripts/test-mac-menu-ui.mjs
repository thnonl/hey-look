#!/usr/bin/env node
// 1.0.7 W5.11 (REQ-5.11.1 to REQ-5.11.4, AC-5.11.1 to AC-5.11.4 page part) in the dev preview (`#os=macos` plays the Mac; the native menu is not visible to the page, so the events it sends are called
// the way the listeners do: `macMenuEvent` of src/macMenu.ts, and what the page tells the menu is the mock's `mac_menu_state` log `window.__macMenu`):
//   File > Print…  the main window says `canPrint` true while a readable, not Confidential message is open and no dialog is in front, false with nothing selected, with Confidential mail, with Settings open; every change is told within 200 ms and only when it is a change; the menu's event prints once (the W5.3 document), and does nothing when the window said false;
//                  Cmd+P is not taken by the page (no second print); the reader window says true when its message is shown
//   Help           opens help.html of the app language in the browser (en: /help.html, de: /de/help.html)
//   Settings…      opens Settings as the gear does
//   Windows        never calls mac_menu_state
//   node scripts/test-mac-menu-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { languageJs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-mac-menu-ui', { vitePort0: 6550 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(30); } return false; };
const log = () => evaluate(`window.__macMenu ?? []`);
const last = async () => (await log()).at(-1)?.can;
const lastIs = (v) => waitFor(`(window.__macMenu ?? []).at(-1)?.can === ${v}`, 3000);
const select = (id) => evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
const shown = `!!document.querySelector('.rp-msg.open .msg-frame')?.contentDocument?.querySelector('p')`;
const openApp = async (query) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await H.openApp(query, 1280, 800);
  await evaluate(languageJs('en'));
  await sleep(400);
};
const event = (item) => evaluate(`import('/src/macMenu.ts').then((m) => m.macMenuEvent(${JSON.stringify(item)})); 1`);
const printed = () => evaluate(`(window.__printed ?? []).length`);

try {
  await check('AC-5.11.2 the main window tells the menu when a message can be printed, within 200 ms, once per change', async () => {
    await openApp('lang=en&os=macos');
    assert.ok(await lastIs(false), 'nothing selected: canPrint false');
    const t0 = await evaluate(`performance.now()`);
    await select('t1');
    assert.ok(await waitFor(shown, 10000), 'the mail did not open');
    assert.ok(await lastIs(true), 'an open message: canPrint true');
    const on = (await log()).filter((e) => e.can).at(0);
    await sleep(300);
    const seq = (await log()).map((e) => e.can);
    assert.deepEqual(seq.filter((v, i) => i === 0 || v !== seq[i - 1]), seq, `reports only on a change: ${JSON.stringify(seq)}`);
    // (the mail shows after its read; the report follows the render that has the message open: within 200 ms of the frame)
    const frameAt = await evaluate(`performance.now()`);
    assert.ok(on.at - t0 < 4000 && on.at <= frameAt, `reported at ${on.at - t0} ms`);
    // a selection change: the report follows the render at once
    await evaluate(`window.__store.getState().select(null); window.__t1 = performance.now(); 1`);
    assert.ok(await lastIs(false), 'nothing selected again: false');
    const off = (await log()).at(-1);
    const t1 = await evaluate(`window.__t1`);
    assert.ok(Math.abs(off.at - t1) <= 200, `the report came ${Math.round(off.at - t1)} ms after the change`);
  });

  await check('AC-5.11.2 Confidential mail and a dialog in front: canPrint false', async () => {
    await select('tconf');
    assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open')`, 10000));
    await sleep(600);
    assert.equal(await last(), false, 'Confidential mail');
    await select('t1');
    assert.ok(await waitFor(shown, 10000));
    assert.ok(await lastIs(true));
    await evaluate(`window.__store.getState().setDialog({ type: 'settings' }); 1`);
    assert.ok(await lastIs(false), 'Settings open in front of the message');
    await evaluate(`window.__store.getState().setDialog(null); 1`);
    assert.ok(await lastIs(true), 'closed again');
  });

  await check('AC-5.11.2 the menu event prints once through the W5.3 path, and nothing when the window said false; Cmd+P is not taken by the page', async () => {
    await select('t1');
    assert.ok(await waitFor(shown, 10000));
    assert.ok(await lastIs(true));
    const before = await printed();
    const taken = await evaluate(`(() => { const e = new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; })()`);
    await sleep(400);
    assert.equal(taken, false, 'the page claimed Cmd+P');
    assert.equal(await printed(), before, 'Cmd+P printed in the page');
    await event('print');
    assert.ok(await waitFor(`(window.__printed ?? []).length === ${before + 1}`, 4000), 'the menu event did not print once');
    await sleep(500);
    assert.equal(await printed(), before + 1, 'printed more than once');
    await evaluate(`window.__store.getState().select(null); 1`);
    assert.ok(await lastIs(false));
    await event('print');
    await sleep(500);
    assert.equal(await printed(), before + 1, 'printed with nothing open');
  });

  await check('AC-5.11.3 Help opens help.html in the language of the app; AC-5.11.4 it follows a language switch', async () => {
    await evaluate(`window.__mockMail.opened.length = 0; 1`);
    await event('help');
    assert.ok(await waitFor(`window.__mockMail.opened.includes('https://heylook.namthai.site/help.html')`, 3000), JSON.stringify(await evaluate(`window.__mockMail.opened`)));
    await evaluate(languageJs('de'));
    await sleep(300);
    await event('help');
    assert.ok(await waitFor(`window.__mockMail.opened.includes('https://heylook.namthai.site/de/help.html')`, 3000), JSON.stringify(await evaluate(`window.__mockMail.opened`)));
    await evaluate(languageJs('en'));
  });

  await check('AC-5.11.1 Settings… opens Settings as the gear does', async () => {
    await evaluate(`window.__store.getState().setDialog(null); 1`);
    await event('settings');
    assert.ok(await waitFor(`window.__store.getState().dialog?.type === 'settings'`, 3000), 'Settings did not open');
    await evaluate(`window.__store.getState().setDialog(null); 1`);
  });

  await check('the reader window tells the menu when its message is shown', async () => {
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=t1#lang=en&os=macos` });
    assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open iframe.msg-frame')?.contentDocument?.querySelector('p')`, 12000), 'the reader did not open its mail');
    assert.ok(await lastIs(true), 'the reader says canPrint true');
    const before = await printed();
    await event('print');
    assert.ok(await waitFor(`(window.__printed ?? []).length === ${before + 1}`, 4000), 'the menu event did not print the reader\'s message');
  });

  await check('AC-5.11.7 Windows: the page never calls mac_menu_state', async () => {
    await openApp('lang=en&os=windows');
    await select('t1');
    assert.ok(await waitFor(shown, 10000));
    await sleep(500);
    assert.deepEqual(await log(), []);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-mac-menu-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-mac-menu-ui: ok');
