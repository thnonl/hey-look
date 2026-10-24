#!/usr/bin/env node
// 1.0.7 W5.2 (REQ-5.2.4, REQ-5.2.6, AC-5.2.1 to AC-5.2.3, AC-5.2.7 page part) in the dev preview, whose mock backend plays the Linux backend (`#osdark=1|0`, the event `os-color-scheme` through
// window.__mockEmit) while the BROWSER's own colour scheme is emulated the opposite way (WebKitGTK's was wrong under a dark Plasma: the page must believe the backend, not the engine):
//   System + backend dark (engine light) -> the page is dark, a change to light in the event is followed within 2 s, in the main window and in a reader window; Light / Dark chosen stay put
//   through changes of the OS; back to System follows the desktop at once; the Settings preview shows the same; Windows (`#os=windows`, no backend value): no data-theme for System, the engine decides
//   node scripts/test-os-theme-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-os-theme-ui', { vitePort0: 6140 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* loading */ } await sleep(40); } return false; };
const attr = () => evaluate(`document.documentElement.getAttribute('data-theme')`);
const ground = () => evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`);
const open = async (hash, engine, query = '') => {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: engine }] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}${query}#${hash}` });
  assert.ok(await waitFor(`document.documentElement.dataset.os !== undefined || !!window.__store`, 10000), 'the page did not start');
  await sleep(700);
};
const setTheme = (t) => evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(t)} }); 1`);
const emit = (dark) => evaluate(`window.__mockEmit('os-color-scheme', { dark: ${dark}, source: 'portal' }); 1`);

try {
  await check('AC-5.2.2 System + a dark desktop (the engine says light): the first page is dark', async () => {
    await open('lang=en&os=linux&osdark=1', 'light');
    assert.equal(await attr(), 'dark');
    assert.equal(await ground(), '#1b1c20');
  });
  await check('AC-5.2.1 a switch of the desktop in either direction is followed within 2 s, five times, whatever the engine says', async () => {
    await open('lang=en&os=linux&osdark=0', 'dark');
    assert.equal(await attr(), 'light', 'a light desktop under a dark engine');
    for (let i = 0; i < 5; i++) {
      const dark = i % 2 === 0;
      const t0 = Date.now();
      await emit(dark);
      assert.ok(await waitFor(`document.documentElement.getAttribute('data-theme') === ${JSON.stringify(dark ? 'dark' : 'light')}`, 2000), `switch ${i + 1}: not followed within 2 s`);
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(await ground(), dark ? '#1b1c20' : '#ffffff');
    }
  });
  await check('AC-5.2.3 Light / Dark chosen stay through desktop switches; back to System follows the desktop at once', async () => {
    await open('lang=en&os=linux&osdark=1', 'light');
    await setTheme('light');
    assert.equal(await attr(), 'light');
    await emit(false); await emit(true); await sleep(250);
    assert.equal(await attr(), 'light', 'Light stays light under a dark desktop');
    await setTheme('dark');
    await emit(false); await sleep(250);
    assert.equal(await attr(), 'dark', 'Dark stays dark under a light desktop');
    await setTheme('system');
    assert.equal(await attr(), 'light', 'System again: the desktop is light now');
    await emit(true);
    assert.ok(await waitFor(`document.documentElement.getAttribute('data-theme') === 'dark'`, 2000));
  });
  await check('the Settings preview and the other readers of the OS scheme follow the same value', async () => {
    await open('lang=en&os=linux&osdark=1', 'light');
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'appearance' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.ap-preview')`, 6000), 'no preview');
    assert.equal(await evaluate(`document.querySelector('.ap-preview').getAttribute('data-theme')`), 'dark');
    await emit(false);
    assert.ok(await waitFor(`document.querySelector('.ap-preview').getAttribute('data-theme') === 'light'`, 2000), 'the preview did not follow');
  });
  await check('a reader window follows the same event', async () => {
    await open('lang=en&os=linux&osdark=1', 'light', '?w=reader&thread=tlayer');
    assert.equal(await attr(), 'dark');
    await emit(false);
    assert.ok(await waitFor(`document.documentElement.getAttribute('data-theme') === 'light'`, 2000), 'the reader did not follow');
  });
  await check('AC-5.2.7 Windows and macOS: no data-theme for System, the engine decides, the event is not asked for', async () => {
    for (const os of ['windows', 'macos']) {
      await open(`lang=en&os=${os}`, 'dark');
      assert.equal(await attr(), null, `${os}: an attribute for System`);
      assert.equal(await ground(), '#1b1c20', `${os}: the engine says dark`);
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      assert.ok(await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#ffffff'`, 2000), `${os}: the engine's switch is followed by the CSS`);
    }
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-os-theme-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-os-theme-ui: ok');
