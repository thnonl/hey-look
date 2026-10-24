#!/usr/bin/env node
// 1.0.7 W5.1 (AC-5.1.1 to 5.1.9, AC-5.1.12, AC-5.1.13; REQ-5.1.4 to 5.1.8) in the dev preview, whose mock backend hands the preview the fixtures of scripts/fixtures/pdf/ (scripts/lib/pdf-fixtures.mjs):
//   - macOS / Linux (PDF.js): a one-page PDF is drawn (non-white canvas pixels, the blue bar, a text layer, no link, no frame / object / embed, no blob URL), "Page 1 of 1" and the zoom buttons in the header;
//     30 pages: "Page n of 30" follows the scroll, only the pages near the view keep a canvas, Fit / 100 / 150 / 200 % at the right size and as sharp as the screen (device pixel ratio 2 too), a resize re-fits;
//     pages of several sizes; the text of CJK fonts that are not embedded (the cMaps); a password-protected file (the locked message, Open / Save as stay), a damaged one (could not be drawn + Open),
//     a file called .pdf that is HTML (the not-a-PDF message, nothing handed to PDF.js); JavaScript inside a PDF runs nothing (no dialog)
//   - the keyboard: the stage has the focus, PageDown / ArrowDown scroll, Shift+Tab leaves it for the header, Esc closes and the focus goes back to the card
//   - the failures end in the card, never in a blank stage: the worker that cannot be found (`#pdf=pdfjs-broken`, AC-5.1.13) and the viewer that cannot be loaded (`#lazyfail=pdfview`)
//   - Windows: the frame as before, nothing of PDF.js is requested; Light and Dark; the header on one line in the 8 languages at 960x560; 10 open / close cycles leave no canvas behind
//   node scripts/test-pdf-viewer-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sleep, startHarness, languageJs, inputs } from './cdp-harness.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';

const H = await startHarness('test-pdf-viewer-ui', { vitePort0: 6060 });
const { evaluate, cdp } = H;
const { press } = inputs(H, null, 'pdf');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
let baseCanvases = 0; // (canvases the app itself has: none of them is the viewer's)
let scale = 1; // (a slow computer waits longer for the same thing; calibrated below)
const waitFor = async (js, ms = 8000) => { ms *= Math.max(1, scale); const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
// the "tlayer" strip has three previewable cards (agenda.pdf, photo-orphan.png, notes.txt): since 1.0.7 W8.8c the header says which one this is (a lone attachment shows no count)
const STRIP = '1 of 3';
const fx = (name) => fs.readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url)).toString('base64');
const dialogs = [];
H.on((m) => { if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); void cdp('Page.handleJavaScriptDialog', { accept: true }); } });
await cdp('Page.enable');

/** Opens the preview of the attachment "agenda.pdf" of the first message of the "tlayer" conversation, whose bytes are the fixture `file` (base64 text when `raw` is given). */
async function openPreview(file, { hash = 'lang=en&os=macos', w = 1280, h = 800, theme = 'dark', raw = null, dpr = 1 } = {}) {
  await H.openApp(hash, w, h);
  if (dpr !== 1) await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  await evaluate(`window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective + ' ' + e.blockedURI)); window.__mockPdf = { 'agenda.pdf': ${JSON.stringify(raw ?? fx(file))} };
    window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); window.__store.getState().select('tlayer'); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.rp-head .icon-btn[aria-label="Expand all"]')`), 'the conversation did not open');
  await evaluate(`document.querySelector('.rp-head .icon-btn[aria-label="Expand all"]').click(); 1`);
  assert.ok(await waitFor(`[...document.querySelectorAll('.att-card')].some((x) => x.textContent.includes('agenda.pdf'))`), 'no agenda.pdf card');
  await evaluate(`(() => { const c = [...document.querySelectorAll('.att-card')].find((x) => x.textContent.includes('agenda.pdf')); window.__opener = c; c.focus(); c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); window.__t0 = performance.now(); })()`);
}
const ready = (ms = 10000) => waitFor(`document.querySelector('.pv-pdfjs')?.dataset.state === 'ready'`, ms);
const state = () => evaluate(`document.querySelector('.pv-pdfjs')?.dataset.state ?? null`);
const headText = () => evaluate(`document.querySelector('.pv-head')?.innerText.replace(/\\s+/g, ' ').trim()`);
// (a key with its virtual key code, so that the engine does what the key does: scroll, move the focus)
const VK = { PageDown: 34, PageUp: 33, End: 35, Home: 36, ArrowDown: 40, ArrowUp: 38, Tab: 9 };
const key = async (k, modifiers = 0) => { for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code: k, modifiers, windowsVirtualKeyCode: VK[k], nativeVirtualKeyCode: VK[k] }); };
const closeEsc = async () => { await press('Escape', 'Escape'); assert.ok(await waitFor(`!document.querySelector('.pv-modal')`, 3000), 'Esc did not close the preview'); };
const pixels = (i = 0) => evaluate(`(() => { const c = document.querySelectorAll('.pv-page canvas')[${i}]; if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let nonWhite = 0, blue = 0; for (let k = 0; k < d.length; k += 4) { if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) nonWhite++; if (d[k] < 60 && d[k + 1] > 80 && d[k + 1] < 140 && d[k + 2] > 170) blue++; } const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cssW: Math.round(r.width * 100) / 100, cssH: Math.round(r.height * 100) / 100, nonWhite, blue }; })()`);
const pages = () => evaluate(`[...document.querySelectorAll('.pv-page')].map((p) => { const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), canvas: !!p.querySelector('canvas'), label: p.getAttribute('aria-label') }; })`);
const drawn = () => evaluate(`document.querySelectorAll('.pv-page canvas').length`);
const zoomBtn = async (which) => { await evaluate(`document.querySelectorAll('.pv-head .pv-zoom button')[${which}].click(); 1`); await sleep(80); return evaluate(`document.querySelectorAll('.pv-head .pv-zoom button')[1].textContent.trim()`); };

try {
  // ---------------------------------------------------------------- calibration of this machine
  await H.openApp('lang=en&os=macos', 1280, 800);
  baseCanvases = await evaluate(`document.querySelectorAll('canvas').length`);
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / 48), 8);
  console.log(`test-pdf-viewer-ui: this page runs the reference work in ${cal.cpu} ms (reference 48): scale ${scale.toFixed(2)}`);

  await check('AC-5.1.1 a one-page PDF is drawn: canvas pixels, the blue bar, the text layer, "Page 1 of 1", no link, no frame / object / embed / blob', async () => {
    await openPreview('one-page.pdf'); // (the first preview of the run also loads the viewer chunk and the worker)
    assert.ok(await ready(), `the viewer is "${await state()}"`);
    const px = await pixels();
    assert.ok(px.nonWhite > 5000 && px.blue > 3000, JSON.stringify(px));
    assert.equal(await headText(), `agenda.pdf ${STRIP} Page 1 of 1 Fit Open Save as…`);
    const dom = await evaluate(`({ links: document.querySelectorAll('.pv-stage a, .pv-stage [href]').length, frames: document.querySelectorAll('.pv-stage iframe, .pv-stage object, .pv-stage embed').length, blob: !!document.querySelector('.pv-stage [src^="blob:"], .pv-stage [data^="blob:"]'),
      text: [...document.querySelectorAll('.pv-text-layer span')].map((s) => s.textContent).join(' '), worker: document.querySelector('.pv-pdfjs').dataset.worker, hand: [...document.querySelectorAll('.pv-text-layer span')].some((s) => getComputedStyle(s).cursor === 'pointer'),
      group: document.querySelector('.pv-page').getAttribute('role'), label: document.querySelector('.pv-page').getAttribute('aria-label'), canvasHidden: document.querySelector('.pv-page canvas').getAttribute('aria-hidden'),
      region: document.querySelector('.pv-pdfjs').getAttribute('role') + ':' + document.querySelector('.pv-pdfjs').getAttribute('aria-label'), tab: document.querySelector('.pv-pdfjs').tabIndex })`);
    assert.equal(dom.links, 0, 'the PDF has an http and a mailto link: the viewer shows none');
    assert.equal(dom.frames, 0);
    assert.equal(dom.blob, false);
    assert.ok(/Hey Look one page 1 of 1/.test(dom.text) && /quick brown fox/.test(dom.text), dom.text);
    assert.equal(dom.hand, false, 'the pointer does not turn into a hand over text');
    assert.deepEqual([dom.group, dom.label, dom.canvasHidden, dom.region, dom.tab], ['group', 'Page 1 of 1', 'true', 'region:agenda.pdf', 0]);
    assert.equal(dom.worker, 'module', 'a real worker (not the fake one on the page thread)');
    assert.deepEqual(await evaluate('window.__csp'), [], 'no policy violation');
    assert.deepEqual(dialogs, []);
    // a click on the place of the links does nothing: the window stays, no new target
    const pageTargets = async () => (await cdp('Target.getTargets')).targetInfos.filter((x) => x.type === 'page').length;
    const before = await pageTargets();
    const link = await evaluate(`(() => { const r = document.querySelector('.pv-page').getBoundingClientRect(); return [r.left + 40, r.top + 842 - 242 + (r.height - 842) * 0]; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: link[0], y: link[1], button: 'left', clickCount: 1 });
    await sleep(300);
    assert.equal(await pageTargets(), before, 'a click on a link of the PDF opened a window');
    assert.ok(await evaluate(`!!document.querySelector('.pv-modal')`), 'the preview stays');
    await closeEsc();
  });

  await check('AC-5.1.1 a second open: drawn within 3 s (scaled to this machine); the focus is on the pages; Esc gives the focus back to the card', async () => {
    await openPreview('one-page.pdf');
    assert.ok(await ready(), 'not ready');
    const ms = await evaluate(`Math.round(performance.now() - window.__t0)`);
    assert.ok(ms <= 3000 * Math.min(scale, 3) + 500, `drawn after ${ms} ms`);
    assert.equal(await evaluate(`document.activeElement.classList.contains('pv-pdfjs')`), true, 'the pages have the focus once drawn');
    await closeEsc();
    assert.equal(await evaluate(`document.activeElement === window.__opener`), true, 'the focus did not go back to the card that opened the preview');
  });

  await check('AC-5.1.2 30 pages: "Page n of 30" follows the scroll; only the pages near the view keep a canvas; the pages are one under the other, 16 px apart', async () => {
    await openPreview('thirty-pages.pdf');
    assert.ok(await ready(), `the viewer is "${await state()}"`);
    assert.equal(await headText(), `agenda.pdf ${STRIP} Page 1 of 30 Fit Open Save as…`);
    const list = await pages();
    assert.equal(list.length, 30);
    assert.equal(list[29].label, 'Page 30 of 30');
    assert.ok(await drawn() <= 3, `${await drawn()} canvases at the top`);
    await evaluate(`(() => { const s = document.querySelector('.pv-pdfjs'); s.scrollTop = document.querySelectorAll('.pv-page')[14].offsetTop - 20; })()`);
    assert.ok(await waitFor(`/Page 15 of 30/.test(document.querySelector('.pv-head').innerText)`, 3000), 'the indicator did not follow the scroll');
    assert.ok(await waitFor(`!!document.querySelectorAll('.pv-page')[14].querySelector('canvas')`, 5000), 'the page in view was not drawn');
    await sleep(500);
    assert.ok((await drawn()) <= 7, `${await drawn()} canvases near page 15`);
    assert.equal(await evaluate(`!!document.querySelectorAll('.pv-page')[0].querySelector('canvas')`), false, 'page 1 is far away: its canvas was freed');
    const gaps = await evaluate(`(() => { const r = [...document.querySelectorAll('.pv-page')].map((p) => p.getBoundingClientRect()); return [Math.round(r[1].top - r[0].bottom), Math.round(r[20].top - r[19].bottom)]; })()`);
    assert.deepEqual(gaps, [16, 16]);
    await evaluate(`(() => { const s = document.querySelector('.pv-pdfjs'); s.scrollTop = s.scrollHeight; })()`);
    assert.ok(await waitFor(`/Page 30 of 30/.test(document.querySelector('.pv-head').innerText)`, 3000), 'the last page was not reached');
    assert.deepEqual(await evaluate('window.__csp'), []);
    await closeEsc();
  });

  await check('AC-5.1.2 Fit / 100 / 150 / 200 %: the size, the labels, sharp canvases at device pixel ratio 1 and 2', async () => {
    for (const dpr of [1, 2]) {
      await openPreview('one-page.pdf', { dpr });
      assert.ok(await ready(), 'not ready');
      let px = await pixels();
      const stageW = await evaluate(`document.querySelector('.pv-pdfjs').clientWidth`);
      assert.ok(Math.abs(px.cssW - (stageW - 96)) <= 1.5, `Fit: ${px.cssW} px in a stage of ${stageW}`);
      assert.ok(Math.abs(px.w - px.cssW * dpr) <= 2, `dpr ${dpr}: canvas ${px.w} px for ${px.cssW} css px (blurred if not equal)`);
      const labels = [];
      for (const [z, k] of [[1, 1], [1.5, 1.5], [2, 2]]) {
        labels.push(await zoomBtn(2));
        await sleep(100);
        assert.ok(await waitFor(`(() => { const c = document.querySelector('.pv-page canvas'); const r = c && c.getBoundingClientRect(); return r && Math.abs(r.width - 595 * ${k} * 96 / 72) < 1.5 && Math.abs(c.width - r.width * ${dpr}) < 2.5; })()`, 4000), `${z * 100}%: the page did not come out at ${595 * k * 96 / 72} css px, ${dpr}x sharp`);
      }
      assert.deepEqual(labels, ['100%', '150%', '200%'].map((x, i) => x), 'the labels after each step');
      px = await pixels();
      assert.ok(px.nonWhite > 5000, 'the page is drawn at 200 %');
      assert.equal(await evaluate(`document.querySelector('.pv-pdfjs').scrollWidth > document.querySelector('.pv-pdfjs').clientWidth`), true, 'a page wider than the stage scrolls sideways');
      assert.equal(await zoomBtn(2), '200%', 'no step above 200 %');
      for (const want of ['150%', '100%', 'Fit']) assert.equal(await zoomBtn(0), want);
      await closeEsc();
    }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  });

  await check('AC-5.1.2 resizing the window re-fits the pages in Fit (debounced) and keeps the place', async () => {
    await openPreview('thirty-pages.pdf');
    assert.ok(await ready(), 'not ready');
    await evaluate(`(() => { const s = document.querySelector('.pv-pdfjs'); s.scrollTop = document.querySelectorAll('.pv-page')[9].offsetTop - 20; })()`);
    assert.ok(await waitFor(`/Page 10 of 30/.test(document.querySelector('.pv-head').innerText)`, 3000));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 960, height: 560, deviceScaleFactor: 1, mobile: false });
    assert.ok(await waitFor(`(() => { const s = document.querySelector('.pv-pdfjs'), p = document.querySelectorAll('.pv-page')[9]; return Math.abs(p.getBoundingClientRect().width - (s.clientWidth - 96)) < 2; })()`, 4000), 'the pages did not re-fit');
    assert.ok(await waitFor(`/Page 10 of 30/.test(document.querySelector('.pv-head').innerText)`, 2000), 'the place was lost by the resize');
    assert.ok(await waitFor(`(() => { const c = document.querySelectorAll('.pv-page')[9].querySelector('canvas'); return c && Math.abs(c.width - c.getBoundingClientRect().width) < 2.5; })()`, 4000), 'the page was not drawn again for the new size');
    await closeEsc();
  });

  await check('AC-5.1.4 pages of other sizes keep their own size; AC-5.1.4 CJK text in fonts that are not embedded is drawn (cMaps)', async () => {
    await openPreview('mixed-sizes.pdf');
    assert.ok(await ready(), 'not ready');
    await zoomBtn(2); // 100 %
    assert.ok(await waitFor(`(() => { const p = [...document.querySelectorAll('.pv-page')].map((x) => Math.round(x.getBoundingClientRect().width) + 'x' + Math.round(x.getBoundingClientRect().height)); return p.join(' ') === '793x1123 1123x793 400x267 267x933'; })()`, 5000), `sizes: ${JSON.stringify(await pages())}`);
    await closeEsc();
    await openPreview('cjk.pdf');
    assert.ok(await ready(), 'not ready');
    assert.ok(await waitFor(`document.querySelectorAll('.pv-text-layer span').length >= 2`, 3000));
    const text = await evaluate(`[...document.querySelectorAll('.pv-text-layer span')].map((s) => s.textContent).join('|')`);
    assert.ok(text.includes('你好') && text.includes('こんにちは'), text);
    const px = await pixels();
    assert.ok(px.nonWhite > 6000, 'the glyphs are drawn');
    await closeEsc();
  });

  await check('AC-5.1.5 a password-protected PDF: the locked message, Open and Save as stay, no page number', async () => {
    await openPreview('locked.pdf');
    assert.ok(await waitFor(`document.querySelector('.pv-pdfjs')?.dataset.state === 'locked'`, 8000), `the viewer is "${await state()}"`);
    assert.equal(await evaluate(`document.querySelector('.pv-pdfjs-msg').innerText.trim()`), 'This PDF is protected by a password, so it can’t be shown here. You can still open or save it.');
    assert.equal(await headText(), `agenda.pdf ${STRIP} Open Save as…`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.pv-pdfjs')).visibility`), 'hidden');
    await closeEsc();
  });

  await check('AC-5.1.6 a damaged PDF: "could not be drawn" with Open (never a blank stage)', async () => {
    await openPreview('damaged.pdf');
    assert.ok(await waitFor(`document.querySelector('.pv-pdfjs')?.dataset.state === 'damaged'`, 8000), `the viewer is "${await state()}"`);
    assert.equal(await evaluate(`document.querySelector('.pv-pdfjs-msg > div').innerText.trim()`), 'This preview could not be drawn here. Open the file in your default app instead.');
    assert.equal(await evaluate(`document.querySelector('.pv-pdfjs-msg button').textContent.trim()`), 'Open');
    await closeEsc();
  });

  await check('AC-5.1.6 a file called .pdf that is HTML: the not-a-PDF message, nothing runs, nothing of PDF.js is asked for', async () => {
    await openPreview(null, { raw: Buffer.from('<!doctype html><script>top.__pwned=1</script><b>not a pdf</b>').toString('base64'), hash: 'lang=en&os=linux' });
    assert.ok(await waitFor(`!!document.querySelector('.pv-modal .pv-msg')`, 5000));
    assert.equal(await evaluate(`document.querySelector('.pv-modal .pv-msg').innerText.trim()`), 'This file is not a valid PDF, so it can’t be shown. You can still open or save it.');
    assert.equal(await evaluate(`typeof window.__pwned`), 'undefined');
    assert.equal(await evaluate(`!!document.querySelector('.pv-pdfjs, .pv-stage iframe')`), false);
    assert.equal(await evaluate(`performance.getEntriesByType('resource').some((e) => /pdfView|pdfjs\\//.test(e.name))`), false, 'PDF.js was requested for a file that is not a PDF');
    await closeEsc();
  });

  await check('AC-5.1.4 JavaScript in a PDF runs nothing: no dialog, no navigation, the form field is not live', async () => {
    dialogs.length = 0;
    await openPreview('scripting.pdf');
    assert.ok(await ready(), 'not ready');
    await sleep(1200);
    assert.deepEqual(dialogs, [], 'the PDF raised a dialog');
    assert.equal(await evaluate(`document.querySelectorAll('.pv-stage input, .pv-stage textarea, .pv-stage select, .pv-stage a').length`), 0);
    assert.equal(await evaluate(`location.href.includes('#') && !location.href.includes('lang=en')`), false);
    await closeEsc();
  });

  await check('AC-5.1.7 keyboard: the pages scroll with PageDown / ArrowDown, Shift+Tab leaves for the header, Esc closes; the arrows keep their dialog meaning', async () => {
    await openPreview('thirty-pages.pdf');
    assert.ok(await ready(), 'not ready');
    await key('PageDown');
    assert.ok(await waitFor(`document.querySelector('.pv-pdfjs').scrollTop > 200`, 2000), 'PageDown did not scroll');
    const t1 = await evaluate(`document.querySelector('.pv-pdfjs').scrollTop`);
    await key('ArrowDown');
    assert.ok(await waitFor(`document.querySelector('.pv-pdfjs').scrollTop > ${t1}`, 2000), 'ArrowDown did not scroll');
    await key('Home');
    assert.ok(await waitFor(`document.querySelector('.pv-pdfjs').scrollTop === 0`, 2000), 'Home did not go to the top');
    await sleep(300); // (a key pressed in the last frame of the smooth scroll of the one before is dropped by the engine)
    await key('End');
    assert.ok(await waitFor(`/Page 30 of 30/.test(document.querySelector('.pv-head').innerText)`, 8000), `End did not go to the last page: ${await evaluate(`JSON.stringify({ top: document.querySelector('.pv-pdfjs').scrollTop, h: document.querySelector('.pv-pdfjs').scrollHeight, head: document.querySelector('.pv-head').innerText, active: document.activeElement.className })`)}`); // (the engine animates a long jump)
    // (the strip has three previewable cards since W8.8c: Next, enabled and ahead of the viewer in the tab order, is what Shift+Tab reaches first; Previous is disabled at the first card; the next Shift+Tab is the header)
    await key('Tab', 8);
    assert.equal(await evaluate(`document.activeElement.classList.contains('pv-nav') && document.activeElement.classList.contains('next')`), true, 'Shift+Tab did not leave the pages for the Next button');
    await key('Tab', 8);
    assert.equal(await evaluate(`document.activeElement.closest('.pv-head') !== null`), true, 'Shift+Tab did not reach the header');
    await closeEsc();
  });

  await check('AC-5.1.9 Light and Dark: the stage and the buttons follow the theme, the pages stay white', async () => {
    const seen = {};
    for (const theme of ['light', 'dark']) {
      await openPreview('one-page.pdf', { theme });
      assert.ok(await ready(), 'not ready');
      seen[theme] = await evaluate(`(() => { const probe = document.createElement('div'); probe.style.background = 'var(--bg3)'; document.body.appendChild(probe); const bg3 = getComputedStyle(probe).backgroundColor; probe.remove();
        return { stage: getComputedStyle(document.querySelector('.pv-stage')).backgroundColor, bg3, page: getComputedStyle(document.querySelector('.pv-page')).backgroundColor, text: getComputedStyle(document.querySelector('.pv-page-no')).color, shadow: getComputedStyle(document.querySelector('.pv-page')).boxShadow !== 'none' }; })()`);
      assert.equal(seen[theme].stage, seen[theme].bg3);
      assert.equal(seen[theme].page, 'rgb(255, 255, 255)');
      assert.ok(seen[theme].shadow, 'the pages have the shadow of the theme');
      await closeEsc();
    }
    assert.notEqual(seen.light.stage, seen.dark.stage, 'the stage does not change with the theme');
  });

  await check('AC-5.1.9 960x560 in the 8 languages: name, page number, zoom, Open, Save as and close on one line; no raw key; the pages are drawn', async () => {
    await openPreview('thirty-pages.pdf', { w: 960, h: 560 });
    assert.ok(await ready(), 'not ready');
    for (const lang of ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru']) {
      await evaluate(languageJs(lang));
      await sleep(120);
      const r = await evaluate(`(() => { const head = document.querySelector('.pv-head'), hr = head.getBoundingClientRect(); const kids = [...head.querySelectorAll(':scope > *, .pv-pdf-tools > *')].filter((k) => k.getClientRects().length);
        const rects = kids.map((k) => k.getBoundingClientRect()); return { text: head.innerText.replace(/\\s+/g, ' '), h: Math.round(hr.height), lines: new Set(rects.map((x) => Math.round((x.top + x.bottom) / 2 / 6))).size, inside: rects.every((x) => x.left >= hr.left - 1 && x.right <= hr.right + 1),
          clipped: kids.filter((k) => !k.classList.contains('pv-name') && k.scrollWidth > k.clientWidth + 1).length, page: document.querySelector('.pv-page-no').textContent.trim(), n: kids.length }; })()`);
      assert.ok(r.inside && r.clipped === 0 && r.lines === 1 && r.h < 56, `${lang}: ${JSON.stringify(r)}`);
      assert.ok(/\d/.test(r.page) && !/reading\./.test(r.text), `${lang}: ${r.page} / ${r.text}`);
      assert.ok(r.n >= 6, `${lang}: ${r.n} items in the header`);
    }
    await closeEsc();
  });

  await check('AC-5.1.8 / REQ-5.1.8 ten open and close cycles leave no canvas, page or listener of the viewer behind', async () => {
    await openPreview('thirty-pages.pdf');
    assert.ok(await ready(), 'not ready');
    await closeEsc();
    for (let i = 0; i < 10; i++) {
      await evaluate(`window.__opener.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 1`);
      assert.ok(await ready(), `cycle ${i}: not ready`);
      await evaluate(`document.querySelector('.pv-pdfjs').scrollTop = 3000; 1`);
      await sleep(150);
      await closeEsc();
      assert.deepEqual(await evaluate(`({ canvases: document.querySelectorAll('canvas').length - ${baseCanvases}, pages: document.querySelectorAll('.pv-page, .pv-text-layer').length })`), { canvases: 0, pages: 0 }, `cycle ${i}: ${await evaluate(`[...document.querySelectorAll('canvas')].map((c) => c.parentElement.className + '/' + c.width + 'x' + c.height + '/' + c.outerHTML.slice(0, 80)).join(' ; ')`)} (base ${baseCanvases})`);
    }
    // one worker only: the page never made a second one
    assert.deepEqual(await evaluate('window.__csp'), []);
  });

  await check('AC-5.1.13 the worker cannot be found (#pdf=pdfjs-broken): the card with Open and Save as, not a blank stage', async () => {
    await openPreview('one-page.pdf', { hash: 'lang=en&os=macos&pdf=pdfjs-broken' });
    assert.ok(await waitFor(`!!document.querySelector('.pv-card')`, 15000), `no card; the viewer is "${await state()}"`);
    assert.equal(await evaluate(`[...document.querySelectorAll('.pv-card button')].map((b) => b.textContent.trim()).join('|')`), 'Open|Save as…');
    assert.equal(await evaluate(`document.querySelector('.pv-card').innerText.includes('PDF files open in your default app')`), true);
    assert.equal(await evaluate(`!!document.querySelector('.pv-page-no, .pv-zoom')`), false, 'no page number or zoom on the card');
    await closeEsc();
  });

  await check('the viewer cannot be loaded at all (#lazyfail=pdfview): the card, no toast', async () => {
    await openPreview('one-page.pdf', { hash: 'lang=en&os=macos&lazyfail=pdfview' });
    assert.ok(await waitFor(`!!document.querySelector('.pv-card')`, 10000), 'no card');
    assert.equal(await evaluate(`!!document.querySelector('.toast')`), false, 'the failure is the card, not a toast');
    await closeEsc();
  });

  await check('AC-5.1.12 Windows: the PDF stays in the frame of the engine, nothing of PDF.js is requested', async () => {
    await openPreview('one-page.pdf', { hash: 'lang=en&os=windows' });
    assert.ok(await waitFor(`!!document.querySelector('.pv-modal iframe.pv-pdf')`, 8000), 'no frame');
    assert.equal(await evaluate(`!!document.querySelector('.pv-pdfjs, .pv-page-no')`), false);
    assert.equal(await evaluate(`performance.getEntriesByType('resource').some((e) => /pdfView|pdfjs\\//.test(e.name))`), false, 'PDF.js was requested on Windows');
    assert.equal(await evaluate(`document.querySelector('.pv-modal iframe.pv-pdf').getAttribute('src').startsWith('blob:')`), true);
    await closeEsc();
  });

  await check('Linux works like macOS', async () => {
    await openPreview('one-page.pdf', { hash: 'lang=en&os=linux' });
    assert.ok(await ready(), 'not ready');
    assert.equal(await headText(), `agenda.pdf ${STRIP} Page 1 of 1 Fit Open Save as…`);
    await closeEsc();
  });
} finally {
  await H.shutdown();
}

if (failures.length) { console.error(`test-pdf-viewer-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-pdf-viewer-ui: ok');
