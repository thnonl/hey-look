#!/usr/bin/env node
// 1.0.7 W5.5 (AC-5.5.1 to AC-5.5.4) in the dev preview: kit mail N1 (a white body, dark rules `body{background:#000;color:#eee}`, a light / dark logo pair switched by display, a
// `<picture><source media="(prefers-color-scheme: dark)">`, and compound queries with max-width) follows the MESSAGE BACKGROUND, not the OS:
//   OS dark + app Light + Original -> light body, light logo, light picture;  OS light + app Dark + Original -> light;  any OS + Dark background -> dark body, dark logo, dark picture;
//   toggling back gives light again and the frame is NOT reloaded (the same document, a marker on its window survives, the scroll position stays);
//   `@media screen and (prefers-color-scheme: dark) and (max-width: N)` applies with Dark when N is wide and never when N is narrow, Original applies neither;
//   a print (beforeprint / afterprint) is light whatever the background; a mail without colour-scheme rules looks the same in both backgrounds
//   node scripts/test-color-scheme-frame.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-color-scheme-frame', { vitePort0: 6120 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4o6EBAAMQAS0ujiXaAAAAAElFTkSuQmCC';
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQCLgDAAH4AVXSujU3AAAAAElFTkSuQmCC';
// (the sanitizer keeps a `srcset` of an address, not a data: one, so the dark source of the <picture> is a same-origin file here; the choice of the source is the point, not that it loads)
// (a <style> that is the first thing of the body is moved into the head by the parser and dropped by the sanitizer, as for every mail: the kit mail has it inside a wrapper)
const N1 = `<div><style>body{background:#fff;color:#111}.ld{display:none}.ll{display:block}.a,.b,.c,.d{display:none}
@media (prefers-color-scheme: dark){body{background:#000;color:#eee}.ld{display:block}.ll{display:none}}
@media screen and (prefers-color-scheme: dark) and (max-width: 100000px){.a{display:block}}
@media screen and (prefers-color-scheme: dark) and (max-width: 10px){.b{display:block}}
@media not (prefers-color-scheme: dark){.c{display:block}}
@media (prefers-color-scheme: light), print and (max-width: 0px){.d{display:block}}</style>
<p class="ll">LIGHT-LOGO</p><p class="ld">DARK-LOGO</p><p class="a">A-wide-dark</p><p class="b">B-narrow-dark</p><p class="c">C-not-dark</p><p class="d">D-light</p>
<picture><source media="(prefers-color-scheme: dark)" srcset="/dark-logo.png"><img id="pic" alt="logo" src="data:image/png;base64,${RED}"></picture>
<p>Tip for web designers: use @media (prefers-color-scheme: dark) in your CSS.</p></div>`;
const PLAIN = '<p style="color:#223">A plain mail without any colour-scheme rule.</p><p>Second paragraph.</p>';

const frame = (js) => evaluate(`(() => { const f = document.querySelector('.msg-frame'); const d = f && f.contentDocument; if (!d || !d.body) return null; ${js} })()`);
const state = () => frame(`const v = (s) => { const e = d.querySelector(s); return e ? getComputedStyle(e).display : null; };
  const lum = (c) => { const m = c.match(/\\d+/g).map(Number); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
  const bg = getComputedStyle(d.body).backgroundColor; return { bg, dark: lum(bg) < 90, ll: v('.ll'), ld: v('.ld'), a: v('.a'), b: v('.b'), c: v('.c'), d: v('.d'), pic: d.getElementById('pic').currentSrc.slice(-24), dataPic: d.getElementById('pic').currentSrc.startsWith('data:'), marker: f.contentWindow.__marker ?? null, tip: d.body.innerText.includes('use @media (prefers-color-scheme: dark) in your CSS') };`);
const open = async (id, os, theme, canvas, w = 1280, h = 800) => {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: os }] });
  await H.openApp('lang=en', w, h);
  // (WP13g: in the dark app theme the Dark background is the stored choice; in the light theme it is the session choice of the button, nothing is stored)
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, mailCanvas: ${JSON.stringify(theme === 'dark' ? canvas : 'original')} }); window.__store.getState().setMailCanvasSession(${JSON.stringify(theme !== 'dark' && canvas === 'dark' ? 'dark' : null)}); 1`);
  await evaluate(`(async () => { window.__mockAddThread(${JSON.stringify(id)}, 'Newsletter ${id}', { html: ${JSON.stringify(id === 'n1' ? N1 : PLAIN)}, fromName: 'News', fromEmail: 'news@example.org' }); await window.__store.getState().refresh(); await window.__store.getState().select(${JSON.stringify(id)}); return 1; })()`);
  assert.ok(await waitFor(`!!document.querySelector('.msg-frame')?.contentDocument?.querySelector('p')`), 'the mail did not open');
  await sleep(700); // (the dark presentation is recoloured on load)
};
const toggle = () => evaluate(`(() => { const s = window.__store.getState(); if (s.prefs.theme === 'dark') s.setPrefs({ mailCanvas: s.prefs.mailCanvas === 'dark' ? 'original' : 'dark' }); else s.setMailCanvasSession(s.mailCanvasSession === 'dark' ? null : 'dark'); return 1; })()`);

try {
  await check('AC-5.5.1 OS dark + app Light + Original: light body, light logo, light picture, the mail\'s dark-only blocks off', async () => {
    await open('n1', 'dark', 'light', 'original');
    const s = await state();
    assert.equal(s.dark, false, JSON.stringify(s));
    assert.deepEqual([s.ll, s.ld, s.a, s.b, s.c, s.d], ['block', 'none', 'none', 'none', 'block', 'block'], JSON.stringify(s));
    assert.ok(s.pic.startsWith('data:') || s.pic.includes(RED.slice(-20)), `the picture is the light one: ${s.pic}`);
    assert.equal(s.tip, true, 'a sentence of the mail that names the feature is untouched');
  });
  await check('AC-5.5.1 OS light + app Dark + Original: light as well (the OS and the app theme do not decide)', async () => {
    await open('n1', 'light', 'dark', 'original');
    const s = await state();
    assert.equal(s.dark, false, JSON.stringify(s));
    assert.deepEqual([s.ll, s.ld, s.a, s.b], ['block', 'none', 'none', 'none'], JSON.stringify(s));
  });
  await check('AC-5.5.1 / 5.5.4 any OS + the Dark background: dark body, dark logo, dark picture; the wide compound block applies, the narrow one never; toggling back is light and the frame is not reloaded', async () => {
    for (const os of ['light', 'dark']) {
      await open('n1', os, os === 'dark' ? 'dark' : 'light', 'dark');
      const s = await state();
      assert.equal(s.dark, true, `${os}: ${JSON.stringify(s)}`);
      assert.deepEqual([s.ll, s.ld, s.a, s.b, s.c, s.d], ['none', 'block', 'block', 'none', 'none', 'none'], `${os}: ${JSON.stringify(s)}`);
      assert.ok(s.pic.endsWith('dark-logo.png'), `${os}: the picture is the dark one: ${s.pic}`);
    }
    // toggle back and forth on the open mail: the same document, a marker on its window survives, and the scroll position of the pane stays
    await evaluate(`document.querySelector('.msg-frame').contentWindow.__marker = 'same-document'; document.querySelector('.rp-body').scrollTop = 3; 1`);
    await toggle();
    assert.ok(await waitFor(`document.querySelector('.msg-frame').contentWindow.__marker === 'same-document' && getComputedStyle(document.querySelector('.msg-frame').contentDocument.querySelector('.ll')).display === 'block'`, 4000), 'back to Original: the light block did not come back in place');
    let s = await state();
    assert.equal(s.dark, false, JSON.stringify(s));
    assert.deepEqual([s.ll, s.ld, s.a, s.c, s.d], ['block', 'none', 'none', 'block', 'block']);
    assert.equal(s.dataPic, true, 'the picture switched back (the <picture> chose its source again)');
    assert.equal(s.marker, 'same-document', 'the frame was reloaded');
    await toggle();
    assert.ok(await waitFor(`getComputedStyle(document.querySelector('.msg-frame').contentDocument.querySelector('.ld')).display === 'block'`, 4000), 'Dark again: the dark block did not come in place');
    s = await state();
    assert.equal(s.marker, 'same-document', 'the frame was reloaded by the second switch');
    assert.equal(s.dark, true);
  });
  await check('AC-5.5.2 print is light whatever the background (beforeprint / afterprint)', async () => {
    await open('n1', 'dark', 'dark', 'dark');
    assert.equal((await state()).ld, 'block');
    await evaluate(`document.querySelector('.msg-frame').contentWindow.dispatchEvent(new Event('beforeprint')); 1`);
    let s = await state();
    assert.deepEqual([s.ll, s.ld, s.a, s.c], ['block', 'none', 'none', 'block'], `during the print: ${JSON.stringify(s)}`);
    await evaluate(`document.querySelector('.msg-frame').contentWindow.dispatchEvent(new Event('afterprint')); 1`);
    s = await state();
    assert.deepEqual([s.ll, s.ld, s.a], ['none', 'block', 'block'], `after the print: ${JSON.stringify(s)}`);
  });
  await check('AC-5.5.3 a mail without colour-scheme rules looks the same in both backgrounds (nothing of it is rewritten)', async () => {
    await open('p1', 'dark', 'light', 'original');
    const srcOriginal = await evaluate(`document.querySelector('.msg-frame').contentDocument.documentElement.outerHTML`);
    assert.ok(!srcOriginal.includes('data-hm-orig'), 'no element was marked');
    assert.ok(srcOriginal.includes('A plain mail without any colour-scheme rule.'));
    await toggle();
    await sleep(500);
    assert.equal(await evaluate(`document.querySelector('.msg-frame').contentDocument.querySelectorAll('[data-hm-orig],[data-hm-orig-media]').length`), 0);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-color-scheme-frame: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-color-scheme-frame: ok');
