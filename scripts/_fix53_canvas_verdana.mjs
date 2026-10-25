#!/usr/bin/env node
// 1.0.7 WP13g (DEC-025, REQ-13.15.1 to 13.15.8, AC-13.15.1 to 13.15.4, 13.15.6, 13.15.7, 13.15.8) in the dev preview: the app theme decides the mail background.
//   Light app: the mail is the original whatever is stored; the button is a session choice (nothing stored) that any switch of the theme clears.
//   Dark app: the stored choice, which the button stores. System follows the OS (the app's own OS-theme seam: the `os-color-scheme` event, not a media emulation).
// Surfaces: the reading pane, the reader window (a page of its own in the preview: ?w=reader; what the main window tells it, `prefs-changed` and `mail-canvas-session`, is sent to it the way the backend does),
// and the composer's "Preview as recipient".
// The frame is sampled with real pixels (a screenshot of a spot of the mail's own background) all through every switch: only the old and the new background may ever show, no white in the dark app, no third
// colour (AC-13.15.7), and the new one shows within 1 s (a budget scaled by how fast this machine runs the page, like scripts/test-reply-feedback.mjs, with a hard cap).
//   node scripts/test-mail-canvas-theme.mjs [--require-browser] [--throttle=4] [--shots=<dir>] [--url=<running dev server>]
import fs from 'node:fs';
import path from 'node:path';
import { arg, inputs, languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { CALIBRATE } from './lib/reply-open-probe.mjs';
import { darkFrameProbe } from './lib/dark-frame-probe.mjs';

const SHOTS = arg('shots');
const H = await startHarness('test-mail-canvas-theme', { vitePort0: 5490 });
const { evaluate, cdp } = H;
const failures = [];
const check = (tag, cond, msg) => { if (!cond) failures.push(`[${tag}] ${msg}`); return !!cond; };

// ---- timing: the background follows within 1 s on the reference machine; the budget grows with a slower page (median CALIBRATE, never below 1, at most 8) and has a hard cap
const CPU_REF = 48;
const HARD_CAP_MS = 4000;
let scale = 1;
const budget = (base) => Math.min(Math.round(base * scale), HARD_CAP_MS);
const waitFor = async (js, ms = 8000) => { ms *= Math.max(1, scale); const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(30); } return false; };

const DARK = [27, 28, 32], WHITE = [255, 255, 255], OWN_DARK = [18, 18, 18];
const near = (a, b, tol = 10) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const BUTTON = 'button[aria-pressed][aria-label="Message background: original / dark"]';
const { click } = inputs(H, null, 'mail-canvas-theme');

async function boot(hash, w = 1280, h = 800) {
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "(() => { const sh = new CSSStyleSheet(); sh.replaceSync('*,*::before,*::after{font-family:Verdana!important}'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; })()" });
  await H.openApp(hash, w, h);
  await evaluate(languageJs('en'));
}
const setPrefs = (patch) => evaluate(`window.__store.getState().setPrefs(${JSON.stringify(patch)}); 1`);
const prefsNow = () => evaluate(`(() => { const s = window.__store.getState(); return { theme: s.prefs.theme, mailCanvas: s.prefs.mailCanvas, session: s.mailCanvasSession }; })()`);
const osSeam = (dark) => evaluate(`window.__mockEmit('os-color-scheme', { dark: ${dark} }).then(() => 1)`);
const open = (id) => evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
const frameState = async (base) => JSON.parse(await evaluate(darkFrameProbe(base)));

/** A spot of the frame that shows the mail's own background (the bottom right corner of a short mail), as a clip origin; it must be the frame. */
async function spot() {
  const s = await evaluate(`(() => { const f = document.querySelector('.msg-frame'); if (!f) return null; const r = f.getBoundingClientRect(); const x = Math.max(2, Math.min(r.right, innerWidth) - 16), y = Math.max(2, Math.min(r.bottom, innerHeight) - 16); return { x, y, hit: document.elementFromPoint(x, y) === f }; })()`);
  return s;
}
/** The colours of 6 x 6 px screenshots (base64 PNG), decoded in the page. */
const decode = (list) => evaluate(`Promise.all(${JSON.stringify(list)}.map((b) => new Promise((ok) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(im.width >> 1, im.height >> 1, 1, 1).data; ok([d[0], d[1], d[2]]); }; im.onerror = () => ok(null); im.src = 'data:image/png;base64,' + b; })))`);
async function shotColors(n) {
  const p = await spot();
  const shots = [];
  for (let i = 0; i < n; i++) shots.push((await cdp('Page.captureScreenshot', { format: 'png', clip: { x: p.x, y: p.y, width: 6, height: 6, scale: 1 }, optimizeForSpeed: true })).data);
  return decode(shots);
}
/** The colour the frame shows now (the most common of 3 samples). */
const surface = async () => (await shotColors(3))[1];

/**
 * Runs `action` (the switch) while the spot of the frame is photographed over and over: the first photo is before, the rest follow until the budget plus 700 ms has passed.
 * Returns the samples as { ms, c }. The checks: every colour is the old or the new one (no white in the dark app, no third colour), the new one shows within the budget and stays.
 */
async function watchSwitch(tag, oldC, newC, action, baseMs = 1000) {
  const p = await spot();
  check(tag, p && p.hit, 'the spot to sample is not on the mail frame');
  if (!p) return;
  const cap = async () => ({ t: Date.now(), data: (await cdp('Page.captureScreenshot', { format: 'png', clip: { x: p.x, y: p.y, width: 6, height: 6, scale: 1 }, optimizeForSpeed: true })).data });
  const shots = [await cap()];
  const t0 = Date.now();
  await action();
  const limit = budget(baseMs);
  while (Date.now() - t0 < limit + 700) shots.push(await cap());
  const cols = await decode(shots.map((s) => s.data));
  const samples = shots.map((s, i) => ({ ms: s.t - t0, c: cols[i] }));
  check(tag, near(samples[0].c, oldC), `before the switch the frame shows ${JSON.stringify(samples[0].c)}, expected about ${JSON.stringify(oldC)}`);
  const strays = samples.filter((s) => !near(s.c, oldC) && !near(s.c, newC));
  check(tag, strays.length === 0, `${strays.length} of ${samples.length} samples show a colour that is neither the old ${JSON.stringify(oldC)} nor the new ${JSON.stringify(newC)}: ${JSON.stringify(strays.slice(0, 4))}`);
  const first = samples.find((s) => s.ms >= 0 && near(s.c, newC));
  check(tag, !!first && first.ms <= limit, `the new background ${JSON.stringify(newC)} showed ${first ? `after ${first.ms} ms` : 'never'} (budget ${limit} ms)`);
  if (first) {
    const back = samples.filter((s) => s.ms > first.ms && !near(s.c, newC));
    check(tag, back.length === 0, `after the new background showed, ${back.length} sample(s) went back: ${JSON.stringify(back.slice(0, 3))}`);
  }
  check(tag, samples.length >= 5, `only ${samples.length} samples were taken`);
  return samples;
}
const shotTo = async (tag, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${tag}-${name}.png`), Buffer.from(r.data, 'base64')); };

/** Waits for the pane to show a mail on the given surface (pixels). */
async function waitSurface(tag, want, what, ms = 6000) {
  let c = null;
  const ok = await waitFor(`!!document.querySelector('.msg-frame')?.contentDocument?.body?.innerText?.length`, ms);
  const t0 = Date.now();
  while (Date.now() - t0 < ms * Math.max(1, scale)) { c = await surface(); if (near(c, want)) break; await sleep(60); }
  check(tag, ok && near(c, want), `${what}: the frame shows ${JSON.stringify(c)}, expected about ${JSON.stringify(want)}`);
}

async function scenario(name, fn) {
  try { await fn(name); } catch (e) { failures.push(`[${name}] threw: ${e && e.stack ? e.stack : String(e)}`); }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
async function paneScenarios() {
  await scenario('AC-13.15.1 fresh profile, Light app: white mail', async (tag) => {
    await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await boot('lang=en&osdark=0');
    const p = await prefsNow();
    check(tag, p.mailCanvas === 'original' && p.session === null, `fresh profile: ${JSON.stringify(p)}`);
    check(tag, p.theme === 'system', `fresh profile: theme ${p.theme}`);
    await open('dk1');
    await waitSurface(tag, WHITE, 'System theme with a light OS');
    await setPrefs({ theme: 'light' });
    await waitSurface(tag, WHITE, 'Light app');
    const st = await frameState(WHITE);
    check(tag, st && st.cls === '' && st.bodyVis === 'visible', `Light app: frame classes "${st && st.cls}", body ${st && st.bodyVis}`);
    check(tag, await evaluate(`getComputedStyle(document.querySelector('.msg-frame').contentDocument.documentElement).getPropertyValue('--hm-bg').trim() === '#ffffff'`), 'the frame base is not #ffffff');
    await shotTo(tag, 'light');
  });

  await scenario('AC-13.15.2 / 13.15.7 stored dark follows the theme (Dark -> Light -> Dark), pane', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'dark', mailCanvas: 'dark' });
    await open('dk1');
    await waitSurface(tag, DARK, 'Dark app with the stored dark');
    const st = await frameState(DARK);
    check(tag, st && st.cls.includes('hm-dark') && !st.cls.includes('hm-pend'), `Dark app: frame classes "${st && st.cls}"`);
    await shotTo(tag, 'dark');
    await watchSwitch(`${tag} Dark->Light`, DARK, WHITE, () => setPrefs({ theme: 'light' }));
    check(tag, (await prefsNow()).mailCanvas === 'dark', 'the stored choice changed when the theme went Light');
    const st2 = await frameState(WHITE);
    check(tag, st2 && !st2.cls.includes('hm-dark') && st2.bodyVis === 'visible', `Light app: frame classes "${st2 && st2.cls}"`);
    await watchSwitch(`${tag} Light->Dark`, WHITE, DARK, () => setPrefs({ theme: 'dark' }));
    check(tag, (await prefsNow()).mailCanvas === 'dark', 'the stored choice changed when the theme went Dark');
    // the button in the Dark app reflects the shown state
    check(tag, await evaluate(`document.querySelector('${BUTTON}').getAttribute('aria-pressed') === 'true'`), 'the button does not show the dark background in the Dark app');
  });

  await scenario('AC-13.15.3 Light app: the button is a session choice', async (tag) => {
    await boot('lang=en&osdark=0&persist');
    await evaluate(`localStorage.removeItem('hl-mock-settings'); 1`);
    await boot('lang=en&osdark=0&persist');
    await setPrefs({ theme: 'light', mailCanvas: 'original' });
    await open('dk1');
    await waitSurface(tag, WHITE, 'Light app');
    await watchSwitch(`${tag} press`, WHITE, DARK, () => click(BUTTON));
    let p = await prefsNow();
    check(tag, p.mailCanvas === 'original' && p.session === 'dark', `after the press: ${JSON.stringify(p)} (nothing stored, the session dark)`);
    check(tag, await evaluate(`document.querySelector('${BUTTON}').getAttribute('aria-pressed') === 'true'`), 'the button does not show the dark background');
    // another mail: still dark (the session lasts)
    await open('dk8');
    await waitSurface(tag, DARK, 'another mail, same session');
    await open('dk1');
    await waitSurface(tag, DARK, 'back to the first mail');
    const stored = JSON.parse((await evaluate(`localStorage.getItem('hl-mock-settings')`)) ?? '{}');
    check(tag, !!stored.prefs && JSON.parse(stored.prefs).mailCanvas === 'original', `the stored preferences after the press: ${stored.prefs}`);
    // the next press gives the original again
    await watchSwitch(`${tag} press again`, DARK, WHITE, () => click(BUTTON));
    check(tag, (await prefsNow()).session === null, 'the second press did not take the session choice off');
    // a restart (a new page on the same stored settings): original, stored value unchanged
    await click(BUTTON);
    await waitSurface(tag, DARK, 'session dark again');
    await boot('lang=en&osdark=0&persist');
    await setPrefs({ theme: 'light' });
    await open('dk1');
    await waitSurface(tag, WHITE, 'after a restart');
    p = await prefsNow();
    check(tag, p.session === null && p.mailCanvas === 'original', `after a restart: ${JSON.stringify(p)}`);
  });

  await scenario('AC-13.15.4 Dark app: the button stores; Light shows the original; back to Dark gives the stored choice', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'dark', mailCanvas: 'original' });
    await open('dk1');
    await waitSurface(tag, WHITE, 'Dark app, stored original');
    await watchSwitch(`${tag} press`, WHITE, DARK, () => click(BUTTON));
    let p = await prefsNow();
    check(tag, p.mailCanvas === 'dark' && p.session === null, `after the press in the Dark app: ${JSON.stringify(p)} (stored, no session)`);
    await watchSwitch(`${tag} Dark->Light`, DARK, WHITE, () => setPrefs({ theme: 'light' }));
    await watchSwitch(`${tag} Light->Dark`, WHITE, DARK, () => setPrefs({ theme: 'dark' }));
    p = await prefsNow();
    check(tag, p.mailCanvas === 'dark', `stored value after the round trip: ${p.mailCanvas}`);
  });

  await scenario('AC-13.15.3 a switch of the theme clears the session choice (setting, command bar value, OS under System)', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'light', mailCanvas: 'original' });
    await open('dk1');
    await waitSurface(tag, WHITE, 'Light app');
    await click(BUTTON);
    await waitSurface(tag, DARK, 'session dark');
    // Light -> Dark -> Light: the session choice is gone, not stored, not coming back
    await setPrefs({ theme: 'dark' });
    await waitSurface(tag, WHITE, 'Dark app after the switch (stored original)');
    check(tag, (await prefsNow()).session === null, 'the session choice survived a switch to the Dark theme');
    await setPrefs({ theme: 'light' });
    await waitSurface(tag, WHITE, 'Light app again (the session choice must not come back)');
    // a theme set to the value it has (no switch): the session choice stays
    await click(BUTTON);
    await waitSurface(tag, DARK, 'session dark again');
    await setPrefs({ theme: 'light', density: 'compact' });
    await sleep(300);
    check(tag, (await prefsNow()).session === 'dark', 'a preference that is not the theme cleared the session choice');
    await setPrefs({ density: 'comfortable' });
  });

  await scenario('AC-13.15.5 System follows the OS (the OS-theme seam), stored dark and session choice', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'dark', mailCanvas: 'dark' });
    await open('dk1');
    await waitSurface(tag, DARK, 'Dark app, stored dark');
    await watchSwitch(`${tag} Dark->System (OS light)`, DARK, WHITE, () => setPrefs({ theme: 'system' }));
    check(tag, (await prefsNow()).mailCanvas === 'dark', 'stored value changed');
    await watchSwitch(`${tag} OS light->dark`, WHITE, DARK, () => osSeam(true));
    await watchSwitch(`${tag} OS dark->light`, DARK, WHITE, () => osSeam(false));
    // a session choice under System with the OS light is cleared by the OS going dark and does not return when the OS goes light
    await click(BUTTON);
    await waitSurface(tag, DARK, 'System/OS light, session dark');
    check(tag, (await prefsNow()).mailCanvas === 'dark', 'stored value changed by the press');
    await setPrefs({ mailCanvas: 'original' });
    await sleep(200);
    await waitSurface(tag, DARK, 'session dark with the stored original');
    await osSeam(true);
    await waitSurface(tag, WHITE, 'OS dark, stored original');
    check(tag, (await prefsNow()).session === null, 'the OS going dark did not clear the session choice');
    await osSeam(false);
    await waitSurface(tag, WHITE, 'OS light again');
  });

  await scenario('AC-13.15.6 a mail with its own dark design is not recoloured in the Light app', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'light', mailCanvas: 'dark' });
    await open('dk3');
    check(tag, await waitFor(`!!document.querySelector('.msg-frame')?.contentDocument?.querySelector('table')`), 'the mail did not open');
    await sleep(300);
    const r = await evaluate(`(() => { const d = document.querySelector('.msg-frame').contentDocument; const w = d.defaultView; const wrap = d.querySelector('div[style*="background:#121212"]'), p = d.querySelector('p'); return { cls: d.documentElement.className, wrap: getComputedStyle(wrap).backgroundColor, text: getComputedStyle(d.querySelector('td')).color, tagged: d.querySelectorAll('[data-hm]').length, vis: getComputedStyle(d.body).visibility }; })()`);
    check(tag, r.cls === '' && r.tagged === 0 && r.vis === 'visible', `own dark design: ${JSON.stringify(r)}`);
    check(tag, r.wrap === 'rgb(18, 18, 18)' && r.text === 'rgb(238, 238, 238)', `the mail's own colours changed: ${JSON.stringify(r)}`);
    const c = await surface();
    check(tag, near(c, OWN_DARK, 6) || near(c, WHITE, 6), `the corner of the frame shows ${JSON.stringify(c)}`); // (the corner is the frame's own white or the mail's wrapper)
    await shotTo(tag, 'own-dark');
  });

  await scenario('AC-13.15.8 print is original in every state', async (tag) => {
    await boot('lang=en&osdark=0');
    const rows = [
      ['Light/original', { theme: 'light', mailCanvas: 'original' }, false],
      ['Light/stored dark', { theme: 'light', mailCanvas: 'dark' }, false],
      ['Light/session dark', { theme: 'light', mailCanvas: 'original' }, true],
      ['Dark/original', { theme: 'dark', mailCanvas: 'original' }, false],
      ['Dark/dark', { theme: 'dark', mailCanvas: 'dark' }, false],
    ];
    for (const [name, prefs, session] of rows) {
      await cdp('Emulation.setEmulatedMedia', { media: '', features: [] });
      await setPrefs(prefs);
      await evaluate(`window.__store.getState().setMailCanvasSession(${session ? "'dark'" : 'null'}); 1`);
      await open('dk8');
      await open('dk1');
      await waitFor(`!!document.querySelector('.msg-frame')?.contentDocument?.body?.innerText?.length`);
      await sleep(400);
      await cdp('Emulation.setEmulatedMedia', { media: 'print', features: [] });
      await sleep(200);
      const pr = await frameState(WHITE);
      check(`${tag} ${name}`, pr && pr.bodyVis === 'visible' && pr.bodyColor === 'rgb(36, 36, 36)', `print: body ${pr && pr.bodyVis}, text ${pr && pr.bodyColor}`);
      const bg = await evaluate(`getComputedStyle(document.querySelector('.msg-frame').contentDocument.documentElement).getPropertyValue('--hm-bg').trim()`);
      check(`${tag} ${name}`, bg === '#ffffff', `print: the base background is ${bg}`);
      await cdp('Emulation.setEmulatedMedia', { media: '', features: [] });
    }
  });
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
/** The reader window is a page of its own (?w=reader); the main window's side is played the way the backend tells it: prefs written, `prefs-changed`; `mail-canvas-session`. */
async function readerScenarios() {
  const mainSetTheme = (theme, extra = {}) => evaluate(`(async () => { const inv = window.__TAURI_INTERNALS__.invoke; const p = JSON.parse((await inv('get_setting', { key: 'prefs' })) || '{}'); Object.assign(p, ${JSON.stringify({ theme, ...extra })}); await inv('set_setting', { key: 'prefs', value: JSON.stringify(p) }); await window.__mockEmit('prefs-changed', { writer: 'main' }); return 1; })()`);
  const readerPage = async (hash, prefs) => {
    await boot('lang=en&osdark=0&persist');
    await evaluate(`localStorage.removeItem('hl-mock-settings'); 1`);
    await boot('lang=en&osdark=0&persist');
    await setPrefs(prefs);
    await sleep(300);
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=dk1#lang=en&osdark=0&persist${hash}` });
    check('reader', await waitFor(`!!document.querySelector('.msg-frame')?.contentDocument?.body?.innerText?.length`, 15000), 'the reader window did not show the mail');
    await sleep(500);
  };

  await scenario('reader: stored dark follows the theme (AC-13.15.2 / 13.15.7)', async (tag) => {
    await readerPage('', { theme: 'dark', mailCanvas: 'dark' });
    await waitSurface(tag, DARK, 'reader, Dark app, stored dark');
    await watchSwitch(`${tag} Dark->Light`, DARK, WHITE, () => mainSetTheme('light'));
    check(tag, await evaluate(`window.__store.getState().prefs.mailCanvas === 'dark'`), 'the reader lost the stored choice');
    await watchSwitch(`${tag} Light->Dark`, WHITE, DARK, () => mainSetTheme('dark'));
  });

  await scenario('reader: the session choice (AC-13.15.3), shared with the main window', async (tag) => {
    await readerPage('', { theme: 'light', mailCanvas: 'original' });
    await waitSurface(tag, WHITE, 'reader, Light app');
    // the main window says: dark for this session
    await watchSwitch(`${tag} main presses`, WHITE, DARK, () => evaluate(`window.__mockEmit('mail-canvas-session', { dark: true }).then(() => 1)`));
    await watchSwitch(`${tag} main takes it off`, DARK, WHITE, () => evaluate(`window.__mockEmit('mail-canvas-session', { dark: false }).then(() => 1)`));
    // the reader's own button: shown at once, the main window asked, nothing stored
    await watchSwitch(`${tag} reader presses`, WHITE, DARK, () => click(BUTTON));
    const sent = await evaluate(`(window.__popoutRequests || []).filter((r) => r.kind === 'canvas-session').map((r) => r.payload)`);
    check(tag, sent.some((p) => p && p.dark === true), `the reader did not ask the main window for the session choice: ${JSON.stringify(sent)}`);
    check(tag, !(await evaluate(`(window.__popoutRequests || []).some((r) => r.kind === 'prefs')`)), 'the reader asked for a preference to be stored');
    check(tag, await evaluate(`window.__store.getState().prefs.mailCanvas === 'original'`), 'the reader stored the choice');
    // the main window's tell that a theme switch cleared its choice may arrive before this window's own theme changes: it must not flash the other background in between
    await evaluate(`window.__mockEmit('mail-canvas-session', { dark: false, theme: true }).then(() => 1)`);
    await sleep(300);
    check(tag, near(await surface(), DARK) && (await evaluate(`window.__store.getState().mailCanvasSession`)) === 'dark', 'the "cleared by a theme switch" tell flipped the reader before its own theme changed');
    // the theme switches: the session choice goes
    await watchSwitch(`${tag} theme Light->Dark`, DARK, WHITE, () => mainSetTheme('dark'));
    check(tag, (await evaluate(`window.__store.getState().mailCanvasSession`)) === null, 'the reader kept the session choice over a theme switch');
    await mainSetTheme('light');
    await waitSurface(tag, WHITE, 'reader, Light app again');
  });

  await scenario('reader: a window opened while the session is dark starts dark (AC-13.15.3)', async (tag) => {
    await readerPage('&canvasdark', { theme: 'light', mailCanvas: 'original' });
    await waitSurface(tag, DARK, 'reader opened in the dark session');
    const asked = await evaluate(`(window.__popoutRequests || []).filter((r) => r.kind === 'canvas-session').length`);
    check(tag, asked >= 1, 'the reader did not ask the main window for the session choice at start');
    // and the OS seam under System (AC-13.15.5)
    await mainSetTheme('system', { mailCanvas: 'dark' });
    await waitSurface(tag, WHITE, 'System, OS light: the theme switch cleared the session choice and the Light app shows the original');
    await watchSwitch(`${tag} OS light->dark`, WHITE, DARK, () => osSeam(true));
    await watchSwitch(`${tag} OS dark->light`, DARK, WHITE, () => osSeam(false));
  });
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
async function composerScenarios() {
  const pv = () => evaluate(`(() => { const e = document.querySelector('.cp-pv'); return e ? { cls: [...e.classList].find((c) => c.startsWith('pv-')) ?? null, bg: getComputedStyle(e).backgroundColor } : null; })()`);
  const waitPv = async (tag, want, what) => {
    const t0 = Date.now(); let v = null;
    while (Date.now() - t0 < budget(1000)) { v = await pv(); if (v && v.cls === want) break; await sleep(30); }
    check(tag, v && v.cls === want, `${what}: the preview is ${v && v.cls}, expected ${want} within ${budget(1000)} ms`);
    return v;
  };
  const startComposer = async () => {
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }); 1`);
    check('composer', await waitFor(`!!document.querySelector('.cp-editor.cp-pv') && !!document.querySelector('.pv-switch')`, 15000), 'the composer did not open');
  };

  await scenario('composer: stored dark follows the theme (AC-13.15.2)', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'dark', mailCanvas: 'dark' });
    await startComposer();
    await waitPv(tag, 'pv-dark', 'Dark app, stored dark');
    const t0 = Date.now();
    await setPrefs({ theme: 'light' });
    await waitPv(tag, 'pv-light', 'Light app');
    check(tag, Date.now() - t0 <= budget(1000) + 200, `the preview took ${Date.now() - t0} ms to follow`);
    check(tag, (await evaluate(`window.__store.getState().prefs.mailCanvas`)) === 'dark', 'the stored choice changed');
    const v = await pv();
    check(tag, v && v.bg === 'rgb(255, 255, 255)', `Light preview surface ${v && v.bg}`);
    await setPrefs({ theme: 'dark' });
    const d = await waitPv(tag, 'pv-dark', 'Dark app again (stored dark)');
    check(tag, d && d.bg === 'rgb(27, 28, 32)', `Dark preview surface ${d && d.bg}`);
  });

  await scenario('composer: the preview choice is cleared by a theme switch', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'dark', mailCanvas: 'original' });
    await startComposer();
    await waitPv(tag, 'pv-light', 'Dark app, stored original');
    await click('.pv-switch button[aria-pressed]:not(.on)'); // Dark (the one not on)
    await waitPv(tag, 'pv-dark', 'chosen dark');
    await setPrefs({ theme: 'light' });
    await waitPv(tag, 'pv-light', 'Light app: the choice is gone');
    await click('.pv-switch button[aria-pressed]:not(.on)');
    await waitPv(tag, 'pv-dark', 'chosen dark in the Light app');
    await setPrefs({ theme: 'dark' });
    await waitPv(tag, 'pv-light', 'Dark app, stored original: the new theme\'s start value, not the old choice');
    // the next composer in this run starts from the start value too
    await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
    await sleep(300);
    await startComposer();
    await waitPv(tag, 'pv-light', 'a new composer after the switch');
  });

  await scenario('composer: System follows the OS (AC-13.15.5)', async (tag) => {
    await boot('lang=en&osdark=0');
    await setPrefs({ theme: 'system', mailCanvas: 'dark' });
    await startComposer();
    await waitPv(tag, 'pv-light', 'System, OS light');
    await osSeam(true);
    await waitPv(tag, 'pv-dark', 'OS dark (stored dark)');
    await click('.pv-switch button[aria-pressed]:not(.on)'); // Light
    await waitPv(tag, 'pv-light', 'chosen light in the dark OS');
    await osSeam(false);
    await waitPv(tag, 'pv-light', 'OS light');
    await osSeam(true);
    await waitPv(tag, 'pv-dark', 'OS dark again: the choice from before the switch is gone');
  });
}

try {
  if (arg('throttle')) await cdp('Emulation.setCPUThrottlingRate', { rate: Number(arg('throttle')) });
  await boot('lang=en&osdark=0');
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / CPU_REF), 8);
  console.log(`test-mail-canvas-theme: the page runs the reference work in ${cal.cpu} ms (reference ${CPU_REF}): scale ${scale.toFixed(2)}, follow budget ${budget(1000)} ms, hard cap ${HARD_CAP_MS} ms`);
  await paneScenarios();
  await readerScenarios();
  await composerScenarios();
} catch (e) {
  failures.push(`[run] ${e && e.stack ? e.stack : String(e)}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-mail-canvas-theme: ${failures.length} failure(s)\n  ` + failures.join('\n  ')); process.exit(1); }
console.log('ok - test-mail-canvas-theme');
