#!/usr/bin/env node
// Settings > AI Assistant must stand still while it is used. The tab used to jump: a "Loading models..." / error row was inserted between
// the Model field and Save on every keystroke in Base URL or API key (Save moved 36 px down and back), "Remove the saved key" was inserted
// under the key after Save (Model and Save moved again, with the button going away from under the pointer), a model list arriving swapped
// the Model text box for a <select> and dropped the focus of someone typing a model id, and Remove the saved key left the focus on nothing.
//
// This opens the tab in the dev preview (src/devMock.ts: the model list answers like the real command: slow, a half-typed address cannot
// be reached, "bad" -> 404, "empty" -> no models), types into every field, clicks Save and Remove the saved key, and samples the layout on
// every animation frame. It asserts that, from the first frame to the last, nothing moved: the heading, every label, Base URL, API key,
// Model (text box or list), Save, the status slot under Save, the form, the dialog, the scroll position of the page; that the focus and
// the caret stayed where the person put them; and that every transient message really appeared (so the test measures what it claims).
//
//   node scripts/test-ai-tab-layout.mjs                       en + de x 960x560 + 1280x720 x light + dark (about 1.5 minutes)
//   node scripts/test-ai-tab-layout.mjs --quick               en 960x560 and de 1280x720 (what CI runs)
//   node scripts/test-ai-tab-layout.mjs --lang=en,ru --size=960x560 --theme=dark --shots=<dir>   (PNGs of the key moments)
//   node scripts/test-ai-tab-layout.mjs --url=http://127.0.0.1:1420/    use a dev server that is already running (default: starts its own vite)
//   node scripts/test-ai-tab-layout.mjs --require-browser      fail (instead of skipping) when no Chrome/Chromium/Edge is installed
//   node scripts/test-ai-tab-layout.mjs --font=Verdana --spacing=0.02   font stress: every font of the page replaced / extra letter spacing (em), as test-focus-tabs has
//   CHROME_PATH=/path/to/chrome overrides the browser lookup. No dependencies (Node 22+, global WebSocket).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness, sleep } from './cdp-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = (name) => process.argv.includes(`--${name}`);
const QUICK = flag('quick');
const CONFIGS = [];
if (QUICK) CONFIGS.push({ lang: 'en', w: 960, h: 560, theme: 'light' }, { lang: 'de', w: 1280, h: 720, theme: 'dark' });
else for (const lang of (arg('lang') || 'en,de').split(',')) for (const size of (arg('size') || '960x560,1280x720').split(',')) for (const theme of (arg('theme') || 'light,dark').split(',')) CONFIGS.push({ lang, w: Number(size.split('x')[0]), h: Number(size.split('x')[1]), theme });
const SHOTS = arg('shots');
const FONT = arg('font'), SPACING = arg('spacing');

// ---------- the browser and the app: a vite dev server of this checkout (the dev preview has the mock backend) ----------
// Both run on ports they bound themselves (scripts/cdp-harness.mjs), so this test cannot meet another one started at the same moment.
const { base, cdp, evaluate, shutdown } = await startHarness('test-ai-tab-layout', { vitePort0: 5480 });
if (FONT || SPACING) {
  // a CI machine (Linux, DejaVu Sans) and macOS / Linux WebKit have other fallback fonts than this Windows PC: the tab must stand still with any metrics
  const css = '*,*::before,*::after{' + (FONT ? 'font-family:' + FONT + '!important;' : '') + (SPACING ? 'letter-spacing:' + SPACING + 'em!important;' : '') + '}';
  // a constructed sheet: the page's CSP blocks an inline <style>
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const sh = new CSSStyleSheet(); sh.replaceSync(${JSON.stringify(css)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; })()` });
}

// ---------- the page side: a layout sample on every frame ----------
const PAGE = `(() => {
  // a button gives a 1 px press nudge while the pointer is down (.btn:active { transform: translateY(1px) }, a .06 s transition): visual feedback, not layout. A frame that lands in the
  // middle of the click (CI, Linux) sees Save 0.5 px lower; the sampler measures the layout, so the nudge is switched off while measuring (a constructed sheet: the CSP blocks an inline <style>).
  { const sh = new CSSStyleSheet(); sh.replaceSync('.btn:active:not(:disabled) { transform: none !important; }'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; }
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  const sample = () => {
    const body = document.querySelector('.settings-body'), form = body && body.querySelector('.form');
    if (!form) return null;
    // (what is inside Advanced is not one of the form's own fields: it is checked by its own phases, the fields above it must not move when it opens)
    const labels = [...form.querySelectorAll('label')].filter((l) => !l.closest('details')), inputs = [...form.querySelectorAll('input, select')].filter((i) => !i.closest('details'));
    const a = document.activeElement, link = form.querySelector('button.link');
    return {
      pos: { summary: R(form.querySelector('details.advanced > summary')), h3: R(body.querySelector('h3')), intro: R(body.querySelector('h3 + .muted')), labels: labels.map(R), url: R(inputs[0]), key: R(inputs[1]), model: R(inputs[2]), save: R(form.querySelector('.btn.primary')), slot: R(form.querySelector('.ai-status, [role=status]')), form: R(form), modal: R(document.querySelector('.modal')), scroll: body.scrollTop, scrollH: body.scrollHeight },
      text: (form.querySelector('.ai-status, [role=status]') || {}).textContent || '', modelTag: inputs[2] ? inputs[2].tagName : '', link: !!link, linkInHead: link ? !!link.closest('.field-head') : null,
      active: a === inputs[0] ? 'url' : a === inputs[1] ? 'key' : a === inputs[2] ? 'model' : a === link ? 'link' : a && a.classList.contains('primary') ? 'save' : a && a.tagName === 'BODY' ? 'body' : 'other',
      caret: a && a.selectionStart != null && a.type !== 'password' ? a.selectionStart : null, value: a && a.value != null ? a.value : null,
    };
  };
  window.__phase = 'start'; window.__log = []; let last = '';
  const tick = () => { const s = sample(), j = JSON.stringify(s); if (j !== last) { last = j; window.__log.push({ phase: window.__phase, s }); } requestAnimationFrame(tick); };
  tick();
})()`;

const ADVANCED = new Set(['open Advanced', 'type a list URL on another server', 'turn the key permission on and off', 'type an invalid list URL']);
const failures = [];
let checks = 0;
const fail = (cfg, msg) => failures.push(`[${cfg.lang} ${cfg.w}x${cfg.h} ${cfg.theme}] ${msg}`);
const flat = (o) => JSON.stringify(o);

async function runConfig(cfg) {
  const tag = `${cfg.lang}-${cfg.w}x${cfg.h}-${cfg.theme}`;
  await cdp('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: false });
  // the first request of a fresh dev server may reload the page once while vite optimises its dependencies: wait for the store
  for (let attempt = 0; attempt < 5; attempt++) {
    await cdp('Page.navigate', { url: 'about:blank' }); // a change of the hash alone would keep the page (and the mock's memory: the saved key, the language)
    await cdp('Page.navigate', { url: `${base}#lang=${cfg.lang}&modelsms=150` });
    await sleep(600);
    try { await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (window.__store && window.__store.getState().accounts.length) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('app did not start')); } }, 100); })`); break; } catch (e) { if (attempt === 4) throw e; }
  }
  const lang = await evaluate('document.documentElement.lang');
  if (lang !== cfg.lang) { fail(cfg, `the page is in ${lang}, not ${cfg.lang}`); return; }
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(cfg.theme)} }); window.__store.getState().setDialog({ type: 'settings', tab: 'ai' }); 1`);
  await evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('.settings-body .form input')) { clearInterval(t); ok(1); } }, 50); })`);
  await sleep(300);
  // a small window scrolls: start at the bottom, where a shrinking page would drag everything up
  await evaluate(`(() => { const b = document.querySelector('.settings-body'); b.scrollTop = b.scrollHeight; })()`);
  await evaluate(PAGE);
  await evaluate('window.__origin0 = performance.timeOrigin');
  await sleep(100);

  const phase = (n) => evaluate(`window.__phase = ${JSON.stringify(n)}`);
  const waitFor = async (what, expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(40); } fail(cfg, `timed out waiting for ${what}`); return false; };
  const last = `window.__log[window.__log.length - 1].s`;
  const focus = (i) => evaluate(`(() => { const e = document.querySelectorAll('.settings-body .form input, .settings-body .form select')[${i}]; e.focus(); if (e.select) e.select(); })()`);
  const typeText = async (text, gap = 25) => { for (const ch of text) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); await sleep(gap); } };
  const press = async (key, code) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code }); };
  const click = async (selector) => {
    const [x, y] = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${tag}-${name}.png`), Buffer.from(r.data, 'base64')); };
  const message = `${last}.text !== '' && !/…$/.test(${last}.text)`; // a sentence of the slot, not "Loading models…" (every language ends that one with an ellipsis)
  const idle = `${last}.text === '' && ${last}.modelTag === 'SELECT'`; // the list has arrived and nothing is pending
  // the sentence fits the two lines of the slot (measured with the clamp lifted, in the same frame: nothing is cut off)
  const fits = async (what) => { const r = await evaluate(`(() => { const e = document.querySelector('.settings-body .ai-status'); if (!e) return null; const keep = e.style.cssText; const h = e.clientHeight; e.style.cssText = 'height:auto;-webkit-line-clamp:none;display:block;overflow:visible;margin-bottom:0'; const need = e.getBoundingClientRect().height; e.style.cssText = keep; return [need, h]; })()`); if (!r) fail(cfg, `no status slot (.ai-status) to show the ${what} message in`); else if (r[0] > r[1] + 1) fail(cfg, `the ${what} message needs ${r[0]}px but the slot is ${r[1]}px high (cut off)`); };
  const typeInto = async (i, text, gap) => { await focus(i); await press('Backspace', 'Backspace'); await typeText(text, gap); };

  // 1. Base URL: typing a full address, character by character (the list is asked for 600 ms after the last key; "Loading models..." from the first)
  await phase('type Base URL');
  await typeInto(0, 'https://api.example.com/v1');
  await shot('url-typed');
  await waitFor('the model list', idle);
  // 2. API key
  await phase('type API key');
  await typeInto(1, 'sk-test-12345');
  await waitFor('the model list again', idle);
  // 3. the saved key / the model list: choose a model, then Save (the key is saved: "Remove the saved key" appears, the key box empties)
  await phase('choose a model');
  await evaluate(`(() => { const s = document.querySelector('.settings-body .form select'); s.focus(); s.value = 'gpt-4o'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  await phase('click Save');
  await shot('before-save');
  await click('.settings-body .form .btn.primary');
  await waitFor('the saved toast', `!!document.querySelector('.toast')`);
  await shot('after-save');
  await sleep(1000);
  await waitFor('the list after Save', idle);
  await phase('Save again');
  await click('.settings-body .form .btn.primary');
  await sleep(900);
  // 4. Remove the saved key
  await phase('Remove the saved key');
  await click('.settings-body .form button.link');
  await sleep(300);
  await shot('key-removed');
  await waitFor('the list after the key was removed', idle);
  // 5. the model list fails (404): the message appears under Save, Save keeps its place and works
  await phase('error from the endpoint');
  await typeInto(0, 'https://bad.example.com/v1');
  await waitFor('the error', `${message} && ${last}.modelTag === 'INPUT'`);
  await fits('error');
  await shot('error');
  await phase('Save with an error showing');
  await click('.settings-body .form .btn.primary');
  await sleep(700);
  // 6. a model id typed while the list is on its way (the box is a text box after the failed request): it keeps focus and caret when the list arrives
  await phase('type Model while the list arrives');
  await typeInto(0, 'https://other.example.com/v1', 20);
  await focus(2);
  await press('Backspace', 'Backspace');
  await typeText('gpt-4o-mini', 130); // the list answers about 750 ms after the address: well inside this
  await sleep(400);
  await phase('leave Model');
  await press('Tab', 'Tab');
  await waitFor('the list after leaving Model', idle);
  // 7. an endpoint without models; a half-typed address
  await phase('no models');
  await typeInto(0, 'https://empty.example.com/v1');
  await waitFor('"no models"', `${message} && ${last}.modelTag === 'INPUT'`);
  await fits('no models');
  await shot('no-models');
  await phase('half-typed address');
  await typeInto(0, 'https://api');
  await waitFor('the unreachable address message', message);
  await fits('unreachable');
  await sleep(300);
  // 8. Save fails (the mock refuses a Base URL with "savefail" in it, the key "keyfail", and Remove the saved key after #removefail): the reason is said in the
  // slot under Save, nothing moves, and what was typed is still in the boxes
  const value = (i) => evaluate(`document.querySelectorAll('.settings-body .form input, .settings-body .form select')[${i}].value`);
  await phase('Save fails');
  await typeInto(0, 'https://savefail.example.com/v1');
  await typeInto(1, 'keep-me-123');
  await focus(2); await press('Backspace', 'Backspace'); await typeText('gpt-4o-mini', 10);
  await sleep(900);
  await click('.settings-body .form .btn.primary');
  await waitFor('the save error', `${last}.text.includes('disk I/O')`);
  await fits('save failed');
  await shot('save-failed');
  if (await value(0) !== 'https://savefail.example.com/v1' || await value(1) !== 'keep-me-123' || await value(2) !== 'gpt-4o-mini') fail(cfg, `a failed save emptied or changed a box: ${await value(0)} / ${await value(1)} / ${await value(2)}`);
  if (!(await evaluate(`document.querySelector('.settings-body .ai-status').classList.contains('bad')`))) fail(cfg, 'the save error is not marked as an error (colour)');
  await typeInto(0, 'https://ok.example.com/v1'); // typing takes it away
  if (await evaluate(`${last}.text.includes('disk I/O')`)) fail(cfg, 'the save error stayed after the Base URL was edited');
  await phase('Save fails, key store');
  await typeInto(1, 'keyfail');
  await sleep(900);
  await click('.settings-body .form .btn.primary');
  await waitFor('the key store error', `${last}.text.includes('keychain')`);
  await fits('key store');
  if (await value(1) !== 'keyfail') fail(cfg, 'a failed save of the key emptied the key box');
  if (await evaluate(`!!document.querySelector('.settings-body .form button.link')`)) fail(cfg, 'a failed save of the key shows "Remove the saved key"');
  await phase('Remove the saved key fails');
  await typeInto(1, 'sk-good-key');
  await sleep(900);
  await click('.settings-body .form .btn.primary'); // this one works: the key is saved
  await waitFor('the saved key', `${last}.link`);
  await sleep(400);
  await evaluate(`location.hash = location.hash + '&removefail'`);
  await click('.settings-body .form button.link');
  await waitFor('the remove error', `${last}.text.includes('keychain')`);
  await fits('remove key');
  if (!(await evaluate(`!!document.querySelector('.settings-body .form button.link')`))) fail(cfg, 'the link to remove the saved key went away although removing failed');
  await sleep(300);

  // 9. (W8.11) Advanced, the last thing in the form: open it, type a list URL on another server (the warning and the switch appear), turn the permission on and off, type a value that is none of the three forms
  await phase('open Advanced');
  await click('.settings-body details.advanced summary');
  await waitFor('Advanced open', `document.querySelector('.settings-body details.advanced').open`);
  await sleep(200);
  await phase('type a list URL on another server');
  await evaluate(`(() => { const e = document.getElementById('set-aiModelsUrl'); e.focus(); e.select(); })()`);
  await typeText('http://127.0.0.1:31842/v1/models', 15);
  await waitFor('the warning and the switch', `!!document.querySelector('.settings-body details.advanced .switch')`);
  await shot('advanced');
  await phase('turn the key permission on and off');
  await click('.settings-body details.advanced .switch');
  await sleep(900);
  await click('.settings-body details.advanced .switch');
  await sleep(900);
  await phase('type an invalid list URL');
  await evaluate(`(() => { const e = document.getElementById('set-aiModelsUrl'); e.focus(); e.select(); })()`);
  await typeText('models', 15);
  await waitFor('the invalid list URL message', `${last}.text.includes('https://')`);
  await fits('invalid list URL');
  await sleep(300);

  const log = await evaluate('window.__log');
  const first = log.find((e) => e.s)?.s;
  if (!first) { fail(cfg, 'the AI tab never rendered'); return; }
  // every frame is compared with the first one: nothing may move, ever
  const moved = new Map();
  for (const { phase: ph, s } of log) {
    if (!s) continue;
    checks++;
    // (Advanced grows the form and the page by its own height; everything above it, and the summary, must not move)
    const growing = ADVANCED.has(ph);
    // (in a low window the page scrolls to the field being typed in: the fields are compared in the page's own coordinates, rectangle + scroll)
    const inPage = (v, scroll) => (Array.isArray(v) && v.length === 4 && typeof v[0] === 'number' ? [v[0], v[1] + scroll, v[2], v[3]] : Array.isArray(v) ? v.map((x) => inPage(x, scroll)) : v);
    for (const k of Object.keys(first.pos)) if (!(growing && (k === 'form' || k === 'scrollH' || k === 'scroll')) && flat(growing && k !== 'modal' ? inPage(s.pos[k], s.pos.scroll) : s.pos[k]) !== flat(growing && k !== 'modal' ? inPage(first.pos[k], first.pos.scroll) : first.pos[k])) { const key = `${k} (${ph})`; if (!moved.has(key)) moved.set(key, `${flat(first.pos[k])} -> ${flat(s.pos[k])}`); }
    if (s.link && s.linkInHead === false) moved.set('Remove the saved key is not on the key label\'s line', '');
  }
  for (const [k, v] of moved) fail(cfg, `${k} moved: ${v}`);
  // the focus and the caret stayed where the person put them
  const inPhase = (ph) => log.filter((e) => e.phase === ph && e.s).map((e) => e.s);
  const only = (ph, who) => { const a = inPhase(ph).filter((s) => s.active !== who); if (a.length) fail(cfg, `focus left the ${who} box during "${ph}" (it was on ${[...new Set(a.map((s) => s.active))].join(', ')})`); };
  only('type Base URL', 'url'); only('type API key', 'key');
  const typingModel = inPhase('type Model while the list arrives');
  const modelFrames = typingModel.filter((s) => s.active === 'model');
  if (!modelFrames.length) fail(cfg, 'the Model box never had focus');
  else {
    if (modelFrames.some((s) => s.modelTag !== 'INPUT')) fail(cfg, 'the Model text box was replaced by a list while it had focus');
    const lastFrame = typingModel[typingModel.length - 1];
    if (lastFrame.active !== 'model' || lastFrame.value !== 'gpt-4o-mini' || lastFrame.caret !== 'gpt-4o-mini'.length) fail(cfg, `after typing a model id, the focus/caret/value is ${lastFrame.active}/${lastFrame.caret}/${lastFrame.value} (want model/11/gpt-4o-mini)`);
  }
  const afterLeave = inPhase('leave Model');
  if (!afterLeave.some((s) => s.modelTag === 'SELECT')) fail(cfg, 'the list never replaced the Model box after it lost the focus');
  const removed = inPhase('Remove the saved key');
  if (!removed.some((s) => !s.link) ) fail(cfg, 'Remove the saved key did not remove the link');
  if (!removed.some((s) => !s.link && s.active === 'key')) fail(cfg, 'after Remove the saved key the focus is not on the API key box');
  if (!log.some((e) => e.phase === 'click Save' && e.s?.link)) fail(cfg, 'the Remove the saved key link did not appear after Save');
  // the transient messages really appeared, in the slot (otherwise this test would prove nothing)
  const texts = new Set(log.map((e) => e.s?.text).filter(Boolean));
  const longest = Math.max(0, ...[...texts].map((x) => x.length));
  if (texts.size < 7) fail(cfg, `only ${texts.size} different status texts were seen (loading, no models, error, unreachable, save failed, key store, invalid list URL expected)`);
  if (!log.some((e) => e.s?.text && e.s.pos.slot[3] > 0)) fail(cfg, 'the status slot has no height');
  console.log(`  ok ${tag}: ${log.length} layout changes, ${checks} frames compared, ${texts.size} status texts (longest ${longest} chars)`);
}

const t0 = Date.now();
try { for (const cfg of CONFIGS) await runConfig(cfg); }
catch (e) { failures.push(`crashed: ${e.stack || e}`); console.log('DBGCRASH', await evaluate(`JSON.stringify({ modal: !!document.querySelector('.modal'), title: document.querySelector('.modal h2, .modal h3')?.textContent, body: document.querySelector('.settings-body')?.innerText.slice(0, 300), reloaded: window.__origin0 !== performance.timeOrigin, origin0: window.__origin0, now0: performance.timeOrigin, log: (window.__log || []).slice(-6).map((x) => x.phase + ' ' + (x.s && x.s.text)) , hash: location.hash })`)); }
finally { await shutdown(); }
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (failures.length) { console.error(`test-ai-tab-layout: FAILED (${CONFIGS.length} configurations, ${secs}s)\n\n  ` + [...new Set(failures)].join('\n  ')); process.exit(1); }
console.log(`test-ai-tab-layout: ok (${CONFIGS.map((c) => `${c.lang} ${c.w}x${c.h} ${c.theme}`).join(', ')}; ${secs}s)`);
