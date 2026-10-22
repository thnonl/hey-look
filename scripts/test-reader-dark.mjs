#!/usr/bin/env node
// The dark mail background shows the mail at once (1.0.7 D-052). An HTML mail that asks for a picture from a slow (or dead) host used to stay blank on its first open
// in the dark: the frame hides the mail (`hm-pend`) until it is recoloured, and the recolouring waited for the frame's `load` event, which waits for every picture.
// Pressing the sun / moon button recoloured the document that was already parsed, which is why "light, then dark again" showed it.
//
// The fixture is the owner's mail (scripts/fixtures/d052-xhtml-newsletter.html, anonymised: XHTML doctype, a <style> in the head with a universal selector, body colour
// on a grey page, a white 570 px table, a remote logo) as dev preview thread "dk11" (src/devMockDark.ts). The logo is answered by a stub that takes 6 s, so the
// document is parsed (readyState "interactive") and its picture is pending for the whole first look. The preview's sanitiser keeps the body only, so the mail's own
// <style> never reaches the frame; "dk12" is the same mail with that style inside the body (its grey #74787E text on a #F2F4F6 page and a white card then reach the frame
// and the dark sheet has colours to adapt), run in the main window as well.
//
// Checks, in the main window (dark theme + dark mail background, "load remote content" on) and in the reader window, and in the light theme:
//   - first open: the mail is visible and recoloured (no hm-pend, no body hiding) while the picture is still pending (readyState is not "complete"), within 3 s;
//   - the text of every element reads: contrast >= 4.5:1, computed from the frame's own styles (colour over what it sits on) and from the real PIXELS of the frame
//     (a screenshot of the frame: the dominant colour is the dark surface, thousands of pixels of text-like contrast on it);
//   - the same after the picture came (nothing changes), after the original / dark button twice (the result of the first open and of the toggle are the same
//     element by element), after switching to another mail and back, and after a fast switch away and back;
//   - printing (print media) keeps the original colours and nothing hidden; the light theme with the original background is not touched and the picture stays
//     blocked until "Load content" (no request for it); the dark background in the light theme reads too.
//
//   node scripts/test-reader-dark.mjs                    all configurations
//   node scripts/test-reader-dark.mjs --quick            main window dark + reader (what CI runs)
//   node scripts/test-reader-dark.mjs --shots=<dir>      PNGs of the first open
//   node scripts/test-reader-dark.mjs --url=http://127.0.0.1:1420/    use a dev server that is already running
//   node scripts/test-reader-dark.mjs --require-browser  fail (instead of skipping) when no Chrome/Chromium/Edge is installed
import fs from 'node:fs';
import path from 'node:path';
import { arg, flag, inputs, sleep, startHarness } from './cdp-harness.mjs';
import { darkFrameProbe } from './lib/dark-frame-probe.mjs';

const QUICK = flag('quick');
const SHOTS = arg('shots');
const H = await startHarness('test-reader-dark', { vitePort0: 5720 });
const { evaluate, cdp } = H;
const failures = [];
const fail = (tag, msg) => failures.push(`[${tag}] ${msg}`);
const check = (tag, cond, msg) => { if (!cond) fail(tag, msg); };

const SLOW_MS = 6000;
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let logoRequests = 0;
H.net.stub = (u) => { if (!u.includes('/templates/logo.png')) return undefined; logoRequests++; return { status: 200, type: 'image/png', body: PNG_1PX, delay: SLOW_MS }; };

const DARK = [27, 28, 32], WHITE = [255, 255, 255];

// state of the message frame (scripts/lib/dark-frame-probe.mjs, the same expression the QA bridge runs on a Mac or Linux): a JSON string, 'null' while there is no frame
const frameState = (base) => darkFrameProbe(base);
const readFrame = async (base) => JSON.parse(await evaluate(frameState(base)));

/** Waits until `pred(state)` holds for the frame; returns { state, ms } or { state: last, ms: null }. */
async function waitFrame(base, pred, limit = 8000) {
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < limit) {
    st = await readFrame(base);
    if (st && pred(st)) return { state: st, ms: Date.now() - t0 };
    await sleep(40);
  }
  return { state: st, ms: null };
}

// the real pixels of the frame: a screenshot of its rectangle, drawn into a canvas in the page: the most frequent colour (the surface) and how many pixels have
// text-like contrast (>= 4.5:1) against it
async function pixels(tag) {
  await evaluate(`document.querySelector('.msg-frame').scrollIntoView({ block: 'start' }); 1`);
  await sleep(150);
  const r = await evaluate(`(() => { const b = document.querySelector('.msg-frame').getBoundingClientRect(); return [b.left, b.top, b.width, Math.min(b.height, innerHeight - b.top, 420)]; })()`);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r[0]), y: Math.max(0, r[1]), width: Math.max(10, r[2]), height: Math.max(10, r[3]), scale: 1 } });
  return evaluate(`new Promise((ok) => { const im = new Image(); im.onload = () => {
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, seen = new Map();
    for (let i = 0; i < d.length; i += 4) { const k = d[i] << 16 | d[i + 1] << 8 | d[i + 2]; seen.set(k, (seen.get(k) || 0) + 1); }
    let top = 0, topN = 0; for (const [k, n] of seen) if (n > topN) { top = k; topN = n; }
    const bg = [top >> 16 & 255, top >> 8 & 255, top & 255];
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    const lb = lum(bg); let text = 0;
    for (let i = 0; i < d.length; i += 4) { const l = lum([d[i], d[i + 1], d[i + 2]]); if ((Math.max(l, lb) + 0.05) / (Math.min(l, lb) + 0.05) >= 4.5) text++; }
    ok({ bg, bgShare: Math.round(topN / (d.length / 4) * 100) / 100, text, w: c.width, h: c.height });
  }; im.onerror = () => ok(null); im.src = 'data:image/png;base64,${shot.data}'; })`);
}

const near = (a, b, tol = 8) => a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const sig = (st) => JSON.stringify(st.rows.map((r) => r.slice(0, 3)));
const BUTTON = 'button[aria-pressed][aria-label="Message background: original / dark"]';
const open = (id) => evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
const shotTo = async (tag, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${tag}-${name}.png`), Buffer.from(r.data, 'base64')); };

/** What the dark mail must look like (computed styles and pixels). */
async function readable(tag, what, base, st) {
  check(tag, st && st.n >= 15, `${what}: only ${st && st.n} elements with text were found`);
  check(tag, st && st.min >= 4.5, `${what}: the lowest text contrast is ${st && st.min}:1 (< 4.5): ${JSON.stringify(st && st.rows.filter((r) => r[3] < 4.5).slice(0, 4))}`);
  const px = await pixels(tag);
  check(tag, px && near(px.bg, base), `${what}: the frame's surface is ${JSON.stringify(px && px.bg)}, expected about ${JSON.stringify(base)}`);
  check(tag, px && px.text >= 600, `${what}: only ${px && px.text} pixels of text-like contrast in the frame (the mail looks blank)`);
  return px;
}

async function darkConfig(tag, { reader, theme, id = 'dk11', origMin = 4.5 }) {
  logoRequests = 0;
  await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: theme }] });
  if (reader) {
    // the reader window reads the preferences the main page stored (#persist keeps the mock's settings in localStorage)
    await H.openApp('lang=en&persist', 1280, 900);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, mailCanvas: 'dark', loadRemote: true }); 1`);
    await sleep(400);
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=${id}#lang=en&persist` });
    await sleep(1200);
  } else {
    await H.openApp('lang=en', 1280, 900);
    await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)}, mailCanvas: 'dark', loadRemote: true }); window.__store.getState().select(${JSON.stringify(id)}); 1`);
  }
  const t0 = Date.now();
  // 1. first open: visible and recoloured while the picture is pending
  const first = await waitFrame(DARK, (s) => !s.cls.includes('hm-pend') && s.bodyVis === 'visible' && s.text > 300, 5000);
  const st = first.state;
  check(tag, first.ms !== null, `first open: the mail was not shown within 5 s (${JSON.stringify(st && { cls: st.cls, vis: st.bodyVis, rs: st.rs })})`);
  if (!st) return;
  check(tag, first.ms === null || Date.now() - t0 < 3500, `first open: shown after ${Date.now() - t0} ms (limit 3500)`);
  check(tag, st.rs !== 'complete', `first open: the document was already complete (${st.rs}), so this run did not exercise a pending picture`);
  check(tag, st.cls.split(' ').includes('hm-dark') && !st.cls.includes('hm-pend'), `first open: classes "${st.cls}"`);
  check(tag, st.hmAttr > 0 || st.sheets >= 2, `first open: the dark sheet is not in the frame`);
  check(tag, logoRequests >= 1, 'the frame did not ask for the picture (the test does not exercise a pending picture)');
  await shotTo(tag, 'first-open');
  await readable(tag, 'first open', DARK, st);
  const S1 = sig(st);
  // 2. the picture arrives: nothing changes
  const done = await waitFrame(DARK, (s) => s.rs === 'complete', SLOW_MS + 4000);
  check(tag, done.ms !== null, 'the picture never completed');
  if (done.state) { check(tag, sig(done.state) === S1, 'after the picture arrived the colours differ from the first look'); check(tag, !done.state.cls.includes('hm-pend') && done.state.bodyVis === 'visible', 'after the picture arrived the mail is hidden'); }
  // 3. original, then dark again (the button): the dark result is the first look
  const { click } = inputs(H, null, tag);
  await click(BUTTON);
  const orig = await waitFrame(WHITE, (s) => !s.cls.includes('hm-dark'), 3000);
  check(tag, orig.ms !== null && orig.state.bodyVis === 'visible' && !orig.state.cls.includes('hm-pend'), `original: classes "${orig.state && orig.state.cls}" body ${orig.state && orig.state.bodyVis}`);
  if (orig.state) {
    check(tag, near(orig.state.bodyBg.match(/\d+/g).map(Number), WHITE, 2), `original: the body is ${orig.state.bodyBg}, not white`);
    check(tag, orig.state.min >= origMin, `original: lowest text contrast ${orig.state.min}:1`);
  }
  const lightPx = await pixels(tag);
  check(tag, lightPx && near(lightPx.bg, WHITE, 6), `original: the frame's surface is ${JSON.stringify(lightPx && lightPx.bg)}`);
  await click(BUTTON);
  const again = await waitFrame(DARK, (s) => s.cls.includes('hm-dark') && s.bodyVis === 'visible', 3000);
  check(tag, again.ms !== null, 'dark again: the mail did not come back dark');
  if (again.state) { check(tag, sig(again.state) === S1, 'dark again: the result is not the same as the first open'); await readable(tag, 'dark again', DARK, again.state); }
  // 4. another mail and back (the picture is cached now), twice
  for (let i = 0; i < 2; i++) {
    await open('dk1');
    await waitFrame(DARK, (s) => s.text > 20 && !s.cls.includes('hm-pend'), 3000);
    await open(id);
    const back = await waitFrame(DARK, (s) => !s.cls.includes('hm-pend') && s.bodyVis === 'visible' && s.text > 300, 3000);
    check(tag, back.ms !== null, `switch back ${i + 1}: the mail was not shown`);
    if (back.state) check(tag, sig(back.state) === S1, `switch back ${i + 1}: the colours differ from the first open`);
  }
  // 5. a fast switch away and back: the last one wins and is shown
  await open('dk8'); await sleep(30); await open(id); await sleep(30); await open('dk1'); await sleep(30); await open(id);
  const fast = await waitFrame(DARK, (s) => !s.cls.includes('hm-pend') && s.bodyVis === 'visible' && s.text > 300, 4000);
  check(tag, fast.ms !== null, 'fast switching: the mail was not shown');
  if (fast.state) check(tag, sig(fast.state) === S1, 'fast switching: the colours differ from the first open');
  // 6. printing: the original colours, nothing hidden (the dark rules and the hiding are screen only)
  await cdp('Emulation.setEmulatedMedia', { media: 'print', features: [{ name: 'prefers-color-scheme', value: theme }] });
  await sleep(200);
  const pr = await readFrame(WHITE);
  check(tag, pr && pr.bodyVis === 'visible' && near(pr.bodyBg.match(/\d+/g).map(Number), WHITE, 2), `print: body ${pr && pr.bodyVis} on ${pr && pr.bodyBg}`);
  check(tag, pr && pr.bodyColor === 'rgb(36, 36, 36)', `print: text colour ${pr && pr.bodyColor}`);
  await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: theme }] });
}

/** The mail comes from the CSP-blocked default: light theme, original background, nothing hidden, the picture is not asked for; then the dark background reads too. */
async function lightConfig(tag) {
  logoRequests = 0;
  await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await H.openApp('lang=en', 1280, 900);
  await evaluate(`window.__store.getState().setPrefs({ theme: 'light', mailCanvas: 'original', loadRemote: false }); window.__store.getState().select('dk11'); 1`);
  const o = await waitFrame(WHITE, (s) => s.text > 300, 5000);
  check(tag, o.ms !== null, 'light: the mail was not shown');
  const st = o.state;
  if (st) {
    check(tag, st.cls === '' && st.bodyVis === 'visible', `light: classes "${st.cls}", body ${st.bodyVis}`);
    check(tag, st.bodyBg === 'rgb(255, 255, 255)' && st.bodyColor === 'rgb(36, 36, 36)', `light: body ${st.bodyBg} / ${st.bodyColor}`);
    check(tag, st.hmAttr === 0, 'light: elements were recoloured');
    check(tag, st.min >= 4.5, `light: lowest text contrast ${st.min}:1`);
  }
  const notice = await evaluate(`!!document.querySelector('.notice') && /blocked/i.test(document.querySelector('.notice').textContent)`);
  const blocked = await evaluate(`(() => { const d = document.querySelector('.msg-frame').contentDocument; return [d.querySelectorAll('img[src]').length, d.querySelectorAll('img[data-hl-blocked], .hl-bp').length]; })()`);
  check(tag, notice, 'light: the "content was blocked" notice is missing');
  check(tag, blocked[0] === 0 && blocked[1] >= 1, `light: remote picture not blocked (img with src ${blocked[0]}, placeholders ${blocked[1]})`);
  await sleep(500);
  check(tag, logoRequests === 0, `light: the blocked picture was asked for ${logoRequests} time(s)`);
  // the dark background in the light theme
  await evaluate(`window.__store.getState().setPrefs({ mailCanvas: 'dark' }); 1`);
  const d = await waitFrame(DARK, (s) => s.cls.includes('hm-dark') && !s.cls.includes('hm-pend') && s.bodyVis === 'visible', 3000);
  check(tag, d.ms !== null, 'light theme, dark background: the mail was not shown');
  if (d.state) await readable(tag, 'light theme, dark background', DARK, d.state);
  check(tag, logoRequests === 0, `light theme, dark background: the blocked picture was asked for ${logoRequests} time(s)`);
}

/** Other dark fixtures: shown at once, readable (the rest of the dark rendering is checked by __darkCheck, devDarkCheck.ts). */
async function otherFixtures(tag) {
  await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await H.openApp('lang=en', 1280, 900);
  await evaluate(`window.__store.getState().setPrefs({ theme: 'dark', mailCanvas: 'dark' }); 1`);
  for (const id of ['dk1', 'dk8', 'dk9', 'dk10']) {
    await open(id);
    const r = await waitFrame(DARK, (s) => !s.cls.includes('hm-pend') && s.bodyVis === 'visible' && s.text > 40, 4000);
    check(`${tag} ${id}`, r.ms !== null, 'not shown');
    if (r.state) check(`${tag} ${id}`, r.state.min >= 4.5, `lowest text contrast ${r.state.min}:1 ${JSON.stringify(r.state.rows.filter((x) => x[3] < 4.5).slice(0, 3))}`);
  }
}

try {
  await darkConfig('main-dark', { reader: false, theme: 'dark' });
  await darkConfig('reader-dark', { reader: true, theme: 'dark' });
  await darkConfig('main-dark-styled', { reader: false, theme: 'dark', id: 'dk12', origMin: 4.3 }); // (the sender's own grey text on white is 4.4:1)
  if (!QUICK) {
    await lightConfig('main-light');
    await darkConfig('main-light-theme-dark-canvas', { reader: false, theme: 'light' });
    await otherFixtures('fixtures');
  }
} catch (e) {
  fail('run', e && e.stack ? e.stack : String(e));
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-reader-dark: FAILED\n  ` + failures.join('\n  ')); process.exit(1); }
console.log(`ok - test-reader-dark${QUICK ? ' (quick)' : ''}`);
