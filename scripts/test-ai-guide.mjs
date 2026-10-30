#!/usr/bin/env node
// The AI Assistant problem toast, in the real UI (dev preview with the mock backend, src/devMock.ts), through every entry point:
// Summarize (reading pane, reader window), Translate (reading pane, reader window) and Write with AI (compose pane, compose window).
// For each problem (not set up, 401, 404 model, timeout, unreadable answer, ...) it asserts that
//   - the toast is there, is ONE toast (a second try replaces it), says the cause of that problem (English) and has the right buttons
//     ("Open AI Assistant settings" always; "Try again" only where trying again can help);
//   - it is still there after 20 seconds (no timer closes it);
//   - the Settings button opens Settings on the AI Assistant tab with the cursor in the field the problem is about (key / Base URL / Model),
//     without scrolling; from a pop-out window it asks the main window (the request of the channel is logged by the mock);
//   - the X closes it, and so does Esc while the focus is on its buttons;
//   - the person's own Cancel (AI_CANCELLED) shows nothing.
//   - a NEW request removes the toast of the old problem at once (Summarize again, or Try again, in the main window and the reader window): no problem toast while it
//     runs, exactly one when it fails (W1.8, 1.0.7).
//
//   node scripts/test-ai-guide.mjs                    all problems x all entry points (about 8 minutes: every scenario waits 20 s)
//   node scripts/test-ai-guide.mjs --quick            Summarize x (not set up, 401, timeout), Translate x timeout, Write x not set up, then the Settings button from every window (what CI runs, about 4 minutes)
//   node scripts/test-ai-guide.mjs --wait=20000       how long the toast must stay (ms)
//   node scripts/test-ai-guide.mjs --shots=<dir> --lang=en,de --size=960x560,1280x720 --theme=light,dark    PNGs of the toast and of the field it leads to
//   (--only-popouts with --shots: just the pictures of the reader and compose windows)
//   node scripts/test-ai-guide.mjs --url=http://127.0.0.1:1420/     use a dev server that is already running
//   node scripts/test-ai-guide.mjs --require-browser  fail (instead of skipping) when no Chrome/Chromium/Edge is installed
import { arg, flag, inputs, sleep, startHarness } from './cdp-harness.mjs';

const QUICK = flag('quick');
const WAIT = Number(arg('wait') || 20000);
const SHOTS = arg('shots');
const LANGS = (arg('lang') || 'en').split(',');
const SIZES = (arg('size') || '1280x720').split(',').map((s) => ({ w: Number(s.split('x')[0]), h: Number(s.split('x')[1]) }));
const THEMES = (arg('theme') || 'light').split(',');

// what each problem looks like in the mock (#failai=<mode>), what the toast says in English, which field gets the cursor, whether it offers "Try again"
const PROBLEMS = {
  notset: { hash: '', cause: 'Its address and model are not saved yet.', field: 'set-aiBaseUrl', again: false },
  nokey: { hash: 'aiset&failai=nokey', cause: 'Its address and model are not saved yet.', field: 'set-aiBaseUrl', again: false },
  auth: { hash: 'aiset&failai=auth', cause: 'The provider rejected the key (401).', field: 'set-aiKey', again: false },
  forbidden: { hash: 'aiset&failai=forbidden', cause: 'The provider rejected the key (403).', field: 'set-aiKey', again: false },
  model: { hash: 'aiset&failai=model', cause: 'The model name was not found.', field: 'set-aiModel', again: false },
  url: { hash: 'aiset&failai=url', cause: 'The provider does not know this address (404).', field: 'set-aiBaseUrl', again: false },
  timeout: { hash: 'aiset&failai=timeout', cause: 'It took too long.', field: null, again: true },
  bad: { hash: 'aiset&failai=bad', cause: 'The answer could not be read.', field: null, again: true },
  busy: { hash: 'aiset&failai=busy', cause: 'The provider is busy, try again later (429).', field: null, again: true },
  network: { hash: 'aiset&failai=network', cause: 'Could not reach the address you entered.', field: 'set-aiBaseUrl', again: true },
};
const ENGLISH = { summarize: 'Summarize did not work', translate: 'Translate did not work', write: 'Write with AI did not work' };
const CORE = QUICK ? ['notset', 'auth', 'timeout'] : ['notset', 'nokey', 'auth', 'model', 'timeout', 'bad'];
const EXTRA = QUICK ? [] : ['forbidden', 'url', 'busy', 'network'];
const ENTRIES = (arg('entries') || 'summarize,translate,write').split(',');

const H = await startHarness('test-ai-guide', { vitePort0: 5640, cdpPort0: 9640 });
const { evaluate, cdp, base } = H;
const failures = [];
let checks = 0;
const check = (ctx, ok, msg) => { checks++; if (!ok) failures.push(`[${ctx}] ${msg}`); };

/** Load the page (main window, or a pop-out with `?w=...`) with the dev switches in the hash and wait until it is up. */
async function open(query, hash, w, h, ready) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  for (let attempt = 0; attempt < 5; attempt++) {
    await cdp('Page.navigate', { url: 'about:blank' }); // (a change of the hash alone would keep the page and the mock's memory)
    await cdp('Page.navigate', { url: `${base}${query}#${hash}` });
    await sleep(600);
    try { await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (${ready}) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('page did not start')); } }, 100); })`); return; } catch (e) { if (attempt === 4) throw e; }
  }
}
const hashOf = (p, lang, theme) => [`lang=${lang}`, 'failaims=300', PROBLEMS[p].hash].filter(Boolean).join('&');
const MAIN_READY = `window.__store && window.__store.getState().accounts.length && window.__store.getState().loaded`;

const toastInfo = () => evaluate(`(() => {
  const all = [...document.querySelectorAll('.toasts .toast.guide')];
  const t = all[0];
  const r = t && t.getBoundingClientRect();
  return { count: all.length, title: t?.querySelector('.toast-title')?.textContent ?? '', lines: [...(t?.querySelectorAll('.toast-line') ?? [])].map((x) => x.textContent), buttons: [...(t?.querySelectorAll('.toast-act') ?? [])].map((b) => b.textContent.trim()), hasX: !!t?.querySelector('.toast-x'), kind: t?.classList.contains('error') ? 'error' : t?.classList.contains('info') ? 'info' : '', box: r ? [r.left, r.top, r.right, r.bottom, window.innerWidth, window.innerHeight] : null, others: document.querySelectorAll('.toasts .toast:not(.guide)').length };
})()`);
const waitToast = async (ms = 9000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await toastInfo()).count > 0) return true; await sleep(100); } return false; };
const noToast = async (ms = 1500) => { await sleep(ms); return (await toastInfo()).count === 0; };

const { clickAt, press, typeText, shot: shotRaw } = inputs(H, SHOTS, 'x');
/** A real mouse click on the centre of the element the expression evaluates to. */
async function clickEl(expr) {
  const pt = await evaluate(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!pt) throw new Error(`nothing to click: ${expr}`);
  await clickAt(pt[0], pt[1]);
}
const byText = (scope, re) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => ${re}.test(e.textContent))`;
/** The words of the Translate entries of the menu, per language. */
const TRANSLATE_WORDS = { en: '^Translate to', de: 'übersetzen$', ru: '^Перевести', fr: '^Traduire', es: '^Traducir', vi: '^Dịch sang', ja: '翻訳$', 'zh-Hans': '^翻译为' };
const WRITE_WORDS = { en: 'Write with AI', de: 'Mit KI schreiben', ru: 'Написать с ИИ', fr: 'Rédiger avec l’IA', es: 'Escribir con IA', vi: 'Viết bằng AI', ja: 'AIで作成', 'zh-Hans': '用 AI 撰写' };
let curLang = 'en';
/** Open the "more" menu that holds the Translate entries (in `scope`) and choose "Translate to ...". */
async function chooseTranslate(scope) {
  const n = await evaluate(`document.querySelectorAll(${JSON.stringify(`${scope} button[aria-haspopup]`)}).length`);
  for (let i = 0; i < n; i++) {
    await clickEl(`document.querySelectorAll(${JSON.stringify(`${scope} button[aria-haspopup]`)})[${i}]`);
    await sleep(150);
    const re = `new RegExp(${JSON.stringify(TRANSLATE_WORDS[curLang])})`;
    const has = await evaluate(`!![...document.querySelectorAll('[role=menuitem]')].find((e) => ${re}.test(e.textContent))`);
    if (has) { await clickEl(byText('[role=menuitem]', re)); return; }
    await press('Escape', 'Escape');
    await sleep(100);
  }
  throw new Error('no Translate menu found');
}

/** The click that uses a feature, in a window. `fresh`: the first use (the compose bar is opened and filled in). */
const TRIGGER = {
  summarize: (win) => clickEl(win === 'reader' ? `document.querySelector('.reader-bar .ai-btn')` : `document.querySelector('.rp-tools .ai-btn')`),
  translate: (win) => chooseTranslate(win === 'reader' ? '.reader-bar' : '.rp-msg.open .rp-msg-actions'),
  write: async (win, problem) => {
    const re = `new RegExp(${JSON.stringify(WRITE_WORDS[curLang])})`;
    // a small pane keeps the button in its "More" menu (src/composeFit.ts)
    const toggle = async () => {
      if (await evaluate(`!![...document.querySelectorAll('.compose-pane .rb')].find((e) => ${re}.test(e.textContent))`)) return clickEl(byText('.compose-pane .rb', re));
      await clickEl(`document.querySelector('.compose-pane .rb.more')`);
      await sleep(150);
      return clickEl(byText('.menu-row', re));
    };
    if (problem === 'notset') return toggle();
    if (!(await evaluate(`!!document.querySelector('.cp-ai textarea')`))) {
      await toggle();
      await sleep(250);
    }
    if (!(await evaluate(`document.querySelector('.cp-ai textarea').value`))) {
      await evaluate(`document.querySelector('.cp-ai textarea').focus()`);
      await typeText('Politely decline the meeting', 5);
    }
    return clickEl(`document.querySelector('.cp-ai .btn.primary')`);
  },
};

/** Put the window in the state where the feature can be used. */
async function prepare(entry, win, problem, lang, size) {
  curLang = lang;
  const hash = hashOf(problem, lang, 'light');
  if (win === 'main') {
    await open('', hash, size.w, size.h, MAIN_READY);
    if (entry === 'write') {
      await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: '' }); 1`);
      await evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('.compose-pane .rb')) { clearInterval(t); ok(1); } }, 50); })`);
    } else {
      await evaluate(`window.__store.getState().openMail('t1'); 1`);
      await evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('.rp-msg.open .rp-msg-actions')) { clearInterval(t); ok(1); } }, 50); })`);
    }
  } else if (win === 'reader') {
    await open('?w=reader&thread=t1', hash, size.w, size.h, `document.querySelector('.reader-bar .ai-btn') && document.querySelector('.rp-msg')`);
  } else {
    await open('?w=compose&mock=new', hash, size.w, size.h, `document.querySelector('.compose-pane .rb')`);
  }
  await sleep(500);
}

const requests = () => evaluate(`JSON.stringify(window.__popoutRequests || [])`).then((s) => JSON.parse(s));

/** One window, one feature, one problem: everything the toast promises. */
async function scenario(entry, win, problem, lang, size) {
  const P = PROBLEMS[problem];
  const ctx = `${entry} ${win} ${problem} ${lang} ${size.w}x${size.h}`;
  await prepare(entry, win, problem, lang, size);
  const trigger = () => TRIGGER[entry](win, problem);
  // 1. the toast comes, once, with the words of this problem
  await trigger();
  if (!(await waitToast())) { check(ctx, false, 'no toast'); return; }
  await trigger().catch(() => {}); // (a second use while the toast is up replaces it in place: still one)
  await sleep(P.again || problem === 'notset' ? 700 : 900);
  let info = await toastInfo();
  const english = lang === 'en';
  check(ctx, info.count === 1, `${info.count} toasts of this kind at once`);
  check(ctx, info.hasX, 'no X');
  check(ctx, info.kind === (problem === 'notset' || problem === 'nokey' ? 'info' : 'error') || problem === 'nokey', `kind ${info.kind}`);
  if (english) {
    check(ctx, info.title === (problem === 'notset' || problem === 'nokey' ? 'AI Assistant is not set up' : ENGLISH[entry]), `title "${info.title}"`);
    check(ctx, info.lines[0] === P.cause, `cause "${info.lines[0]}"`);
    check(ctx, info.lines.length === 2, `${info.lines.length} lines under the title`);
    check(ctx, info.buttons.includes('Open AI Assistant settings'), `buttons ${JSON.stringify(info.buttons)}`);
    check(ctx, info.buttons.includes('Try again') === P.again, `Try again ${P.again ? 'missing' : 'must not be there'}: ${JSON.stringify(info.buttons)}`);
  } else {
    check(ctx, info.title.length > 3 && info.lines.length === 2 && info.buttons.length === (P.again ? 2 : 1), `${lang}: ${JSON.stringify(info)}`);
  }
  if (info.box) check(ctx, info.box[0] >= 0 && info.box[2] <= info.box[4] && info.box[3] <= info.box[5] && info.box[1] >= 0, `toast outside the window ${JSON.stringify(info.box)}`);
  if (SHOTS) {
    await shot(`${entry}-${win}-${problem}-${lang}-${size.w}x${size.h}`);
    return; // (a run for pictures does not wait)
  }

  // 2. it stays
  await sleep(WAIT);
  info = await toastInfo();
  check(ctx, info.count === 1, `the toast was gone after ${WAIT / 1000} s`);

  // 3. the X closes it; a new use brings it back; Esc (focus on its buttons) closes it
  if (info.count) {
    await clickEl(`document.querySelector('.toasts .toast.guide .toast-x')`);
    check(ctx, await noToast(400), 'the X did not close it');
  }
  await trigger();
  check(ctx, await waitToast(), 'no toast after a second use');
  await sleep(300);
  const selected = () => evaluate(`window.__store ? window.__store.getState().selected : null`);
  const selectedBefore = await selected();
  await evaluate(`document.querySelector('.toasts .toast.guide .toast-act').focus()`);
  await press('Escape', 'Escape');
  check(ctx, await noToast(400), 'Esc did not close it');
  check(ctx, (await selected()) === selectedBefore, 'Esc on the toast also closed the open conversation');

  // 4. Try again (where it is offered) makes another call and the toast comes back
  if (P.again) {
    await trigger();
    await waitToast();
    const before = await evaluate(`(window.__mockAiRequests || []).length`);
    await clickEl(byText('.toasts .toast.guide .toast-act', '/^Try again$/'));
    await sleep(150);
    const during = (await toastInfo()).count;
    check(ctx, during === 0, 'the toast stayed after Try again was pressed');
    check(ctx, await waitToast(), 'no toast after Try again failed again');
    const after = await evaluate(`(window.__mockAiRequests || []).length`);
    check(ctx, after > before, `Try again made no new request (${before} -> ${after})`);
  }
}

/** The Settings button leads to the AI Assistant tab, to the field of the problem. */
async function settingsClick(entry, win, problem, lang, size) {
  const P = PROBLEMS[problem];
  const ctx = `${entry} ${win} ${problem} ${lang} ${size.w}x${size.h} settings`;
  await prepare(entry, win, problem, lang, size);
  await TRIGGER[entry](win, problem);
  if (!(await waitToast())) { check(ctx, false, 'no toast'); return; }
  await sleep(P.again ? 1800 : 400); // (a translation tries a connection error once more before it gives up)
  if (!(await waitToast())) { check(ctx, false, 'no toast (2)'); return; }
  // the Settings button is the last one
  await clickEl(`[...document.querySelectorAll('.toasts .toast.guide .toast-act')].pop()`);
  check(ctx, await noToast(300), 'the toast stayed after the Settings button was pressed');
  await sleep(500);
  if (win === 'main') {
    const d = JSON.parse(await evaluate(`JSON.stringify(window.__store.getState().dialog)`));
    check(ctx, d && d.type === 'settings' && d.tab === 'ai', `dialog ${JSON.stringify(d)}`);
    const tab = await evaluate(`document.querySelector('.settings-nav button.active')?.textContent.trim() ?? ''`);
    if (lang === 'en') check(ctx, tab === 'AI Assistant', `active tab "${tab}"`);
    const active = await evaluate(`document.activeElement?.id ?? document.activeElement?.tagName`);
    check(ctx, P.field ? active === P.field : true, `the cursor is in "${active}", expected ${P.field}`);
    // nothing scrolled to put it there
    const scrolled = await evaluate(`document.querySelector('.settings-body')?.scrollTop ?? -1`);
    check(ctx, scrolled === 0 || scrolled === -1, `the settings page scrolled to ${scrolled}`);
    if (SHOTS) await shot(`${entry}-${win}-${problem}-${lang}-${size.w}x${size.h}-settings`);
  } else {
    const q = (await requests()).filter((r) => r.kind === 'dialog' || r.kind === 'cw-dialog');
    const dlg = q.length ? (q[q.length - 1].payload.dialog ?? q[q.length - 1].payload.req) : null;
    check(ctx, dlg && dlg.type === 'settings' && dlg.tab === 'ai', `request to the main window ${JSON.stringify(q)}`);
    const want = P.field ? P.field.replace('set-', '') : undefined;
    check(ctx, !P.field || (dlg && dlg.focus === want), `the pop-out asked for focus "${dlg?.focus}", expected ${want}`);
  }
}

let shot = async () => {};
async function cancelled(entry, win) {
  const ctx = `${entry} ${win} cancelled`;
  await open(win === 'main' ? '' : win === 'reader' ? '?w=reader&thread=t1' : '?w=compose&mock=new', 'lang=en&aiset&failaims=300&failai=cancelled', 1280, 720, win === 'main' ? MAIN_READY : win === 'reader' ? `document.querySelector('.reader-bar .ai-btn') && document.querySelector('.rp-msg')` : `document.querySelector('.compose-pane .rb')`);
  if (win === 'main') {
    if (entry === 'write') {
      await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: '' }); 1`);
      await evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('.compose-pane .rb')) { clearInterval(t); ok(1); } }, 50); })`);
    } else {
      await evaluate(`window.__store.getState().openMail('t1'); 1`);
      await evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('.rp-msg.open .rp-msg-actions')) { clearInterval(t); ok(1); } }, 50); })`);
    }
  }
  await sleep(500);
  await TRIGGER[entry](win, 'cancelled');
  await sleep(1800);
  check(ctx, (await toastInfo()).count === 0, 'a call the person cancelled shows a problem');
}

/**
 * A new request removes the toast of the old problem at once (W1.8, 1.0.7). The first Summarize fails (after 2.5 s in the mock), the toast shows; the second request - by the
 * Summarize button, or by "Try again" on the toast - is pending for 2.5 s: during that time there is NO problem toast; when it fails there is exactly one.
 */
async function newRequestClears(win, viaTryAgain) {
  const ctx = `new request ${win} ${viaTryAgain ? 'try again' : 'summarize again'}`;
  const hash = 'lang=en&aiset&failaims=2500&failai=timeout';
  if (win === 'main') {
    await open('', hash, 1280, 720, MAIN_READY);
    await evaluate(`window.__store.getState().openMail('t1'); 1`);
    await evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('.rp-msg.open .rp-msg-actions')) { clearInterval(t); ok(1); } }, 50); })`);
  } else {
    await open('?w=reader&thread=t1', hash, 1280, 720, `document.querySelector('.reader-bar .ai-btn') && document.querySelector('.rp-msg')`);
  }
  await sleep(500);
  await TRIGGER.summarize(win);
  check(ctx, await waitToast(6000), 'no toast after the first failure');
  await sleep(400);
  check(ctx, (await toastInfo()).count === 1, 'not one toast after the first failure');
  if (viaTryAgain) await clickEl(byText('.toasts .toast.guide .toast-act', '/^Try again$/'));
  else await TRIGGER.summarize(win);
  await sleep(500); // (the request is pending: the mock answers after 2.5 s)
  check(ctx, (await toastInfo()).count === 0, 'the old problem toast stays while the new request runs');
  await sleep(1200);
  check(ctx, (await toastInfo()).count === 0, 'a problem toast shows while the new request still runs');
  check(ctx, await waitToast(6000), 'no toast after the second failure');
  await sleep(500);
  const info = await toastInfo();
  check(ctx, info.count === 1, `${info.count} problem toasts after the second failure, expected one`);
}

const t0 = Date.now();
try {
  for (const lang of LANGS) for (const size of SIZES) for (const theme of THEMES) {
    const sh = inputs(H, SHOTS, `${theme}`);
    shot = async (name) => {
      await evaluate(`(() => { const s = window.__store; if (s) s.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); })()`);
      await sleep(250);
      await sh.shot(name);
    };
    const problems = arg('problems') ? arg('problems').split(',') : SHOTS ? ['notset', 'auth', 'model', 'url', 'timeout', 'bad', 'busy', 'network'] : lang === 'en' ? [...CORE, ...EXTRA] : ['notset', 'auth'];
    for (const problem of flag('only-popouts') ? [] : problems) for (const entry of ENTRIES) {
      if (QUICK && !(entry === 'summarize' || (entry === 'translate' && problem === 'timeout') || (entry === 'write' && problem === 'notset'))) continue;
      if (SHOTS && entry !== 'summarize' && problem !== 'notset' && problem !== 'auth') continue;
      await scenario(entry, 'main', problem, lang, size);
      console.log(`  done ${entry} main ${problem} ${lang} ${size.w}x${size.h} ${theme}`);
    }
    if (SHOTS) {
      // the page the Settings button leads to: the cursor is in the field the problem is about
      for (const problem of flag('only-popouts') ? [] : ['notset', 'auth', 'model', 'url']) await settingsClick('summarize', 'main', problem, lang, size);
      // and the same toast in the reader window and in the compose window
      await scenario('summarize', 'reader', 'auth', lang, size);
      await scenario('translate', 'reader', 'timeout', lang, size);
      await scenario('write', 'compose', 'notset', lang, size);
      await scenario('write', 'compose', 'busy', lang, size);
      continue;
    }
    // the Settings button, main window and both pop-outs
    for (const problem of QUICK ? ['notset', 'auth'] : ['notset', 'nokey', 'auth', 'model', 'url', 'network']) {
      for (const entry of ENTRIES) { if (QUICK && entry === 'translate') continue; await settingsClick(entry, 'main', problem, lang, size); }
      await settingsClick('summarize', 'reader', problem, lang, size);
      if (!QUICK) await settingsClick('translate', 'reader', problem, lang, size);
      await settingsClick('write', 'compose', problem, lang, size);
    }
    for (const entry of ENTRIES) await cancelled(entry, 'main');
    if (!QUICK) { await cancelled('summarize', 'reader'); await cancelled('write', 'compose'); }
    if (lang === 'en' && !SHOTS) {
      await newRequestClears('main', false);
      await newRequestClears('main', true);
      await newRequestClears('reader', false);
    }
  }
} catch (e) { failures.push(`crashed: ${e.stack || e}`); }
finally { await H.shutdown(); }
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (failures.length) { console.error(`test-ai-guide: FAILED (${checks} checks, ${secs}s)\n\n  ` + [...new Set(failures)].join('\n  ')); process.exit(1); }
console.log(`test-ai-guide: ok (${checks} checks, ${secs}s)`);
