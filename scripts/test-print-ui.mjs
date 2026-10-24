#!/usr/bin/env node
// 1.0.7 W5.3 (REQ-5.3.1 to REQ-5.3.4, AC-5.3.1/5.3.4/5.3.5/5.3.9 page part) in the dev preview, whose mock backend answers `print_html` (`#os=macos` plays the Mac):
//   the per-message More menu has Print and it hands the backend ONE light document (title = subject, CSP with script-src 'none', the mail, no app UI) even with the Dark background;
//   a failing backend (`#printfail`) shows the toast "Couldn't print this message." in this window and nothing else changes; a second press while a print is under way does nothing;
//   the reader window: Cmd+P and More > Print print the last open message; Windows (`#os=windows`) never calls print_html
//   node scripts/test-print-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-print-ui', { vitePort0: 6150 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const MAIL = `<div><style>body{background:#fff}@media (prefers-color-scheme: dark){body{background:#000;color:#eee}}</style><p>Print me: the quarterly numbers.</p></div>`;
const printed = () => evaluate(`(window.__printed ?? []).map((p) => ({ title: p.title, html: p.html }))`);
const openPane = async (query, theme = 'light', canvas = 'original') => {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await H.openApp(query, 1280, 800);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, mailCanvas: ${JSON.stringify(canvas)} }); 1`);
  await evaluate(`(async () => { window.__mockAddThread('pr1', 'Q3 <numbers> & plans', { html: ${JSON.stringify(MAIL)}, fromName: 'Ann', fromEmail: 'ann@example.org' }); await window.__store.getState().refresh(); await window.__store.getState().select('pr1'); return 1; })()`);
  assert.ok(await waitFor(`!!document.querySelector('.msg-frame')?.contentDocument?.querySelector('p')`), 'the mail did not open');
  await sleep(500);
};
const clickPrint = async () => {
  assert.ok(await waitFor(`!!document.querySelector('button[aria-label="More actions"]')`, 10000), 'no More actions button');
  await evaluate(`document.querySelector('button[aria-label="More actions"]').click(); 1`);
  const row = `[...document.querySelectorAll('.menu-row')].find((b) => b.querySelector('.menu-lbl')?.textContent.trim() === 'Print')`;
  assert.ok(await waitFor(`!!(${row})`), 'no Print entry');
  return evaluate(`(() => { const b = ${row}; const off = b.disabled; if (!off) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return !off; })()`);
};

try {
  await check('AC-5.3.1/5.3.4 macOS: More > Print hands the backend one light document, with the Dark background too', async () => {
    await openPane('lang=en&os=macos', 'dark', 'dark');
    assert.equal(await clickPrint(), true, 'Print is disabled');
    assert.ok(await waitFor(`(window.__printed ?? []).length === 1`), 'print_html was not called once');
    const [p] = await printed();
    assert.equal(p.title, 'Q3 <numbers> & plans');
    assert.ok(p.html.includes('Print me: the quarterly numbers.'));
    assert.ok(p.html.includes("script-src 'none'") && p.html.includes('--hm-bg:#ffffff') && !p.html.includes('hm-dark'), 'light, no script');
    assert.ok(!p.html.includes('html,body{overflow:hidden!important'), 'no frame-only rule');
    assert.ok(!/class="(rp-|fp-|ml-)/.test(p.html), 'no app UI');
  });
  await check('REQ-5.3.4 AC-5.3.9 a failing backend: the toast in this window, the page stays usable', async () => {
    await openPane('lang=en&os=macos&printfail');
    assert.equal(await clickPrint(), true);
    assert.ok(await waitFor(`document.body.innerText.includes('Couldn’t print this message.')`), 'no toast');
    assert.equal((await printed()).length, 1, 'the call was made once');
    assert.equal(await evaluate(`!!document.querySelector('.msg-frame')`), true);
  });
  await check('REQ-5.3.1 reader window: Cmd+P and More > Print print the last open message', async () => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=t1#lang=en&os=macos` });
    await sleep(800);
    assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open iframe.msg-frame')?.contentDocument?.querySelector('p')`, 12000), 'the reader did not open its mail');
    await sleep(400);
    await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true })); 1`);
    assert.ok(await waitFor(`(window.__printed ?? []).length >= 1`, 4000), 'Cmd+P did not print');
    const before = (await printed()).length;
    await sleep(400);
    assert.equal(await clickPrint(), true, 'the reader menu has Print');
    assert.ok(await waitFor(`(window.__printed ?? []).length === ${before + 1}`, 4000), 'More > Print did not print');
  });
  await check('Windows never calls print_html (the frame prints itself)', async () => {
    await openPane('lang=en&os=windows');
    await evaluate(`window.print = () => { window.__winPrint = (window.__winPrint ?? 0) + 1; }; document.querySelector('.msg-frame').contentWindow.print = () => { window.__winPrint = (window.__winPrint ?? 0) + 1; }; 1`);
    assert.equal(await clickPrint(), true);
    await sleep(600);
    assert.equal((await printed()).length, 0, 'print_html was called on Windows');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-print-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-print-ui: ok');
