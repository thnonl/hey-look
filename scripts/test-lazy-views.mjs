#!/usr/bin/env node
// 1.0.7 WP9d (W9.2, REQ-9.2.4 - 9.2.6): the big parts of the app load on demand, in the real page of the dev preview. The network of the page is slowed down with the DevTools
// network conditions so that a part takes a while (the way the first open on a slow disk does), and a probe in the page notes, frame by frame, when the frame of the part, the loading
// look and the part itself were on screen. Checked:
//   settings   first open: the dialog frame (title) at once, no loading look before 150 ms and the look by ~200 ms, then the dialog; focus inside the dialog; the frame is replaced by the dialog
//              with no second opening animation; a second open has no frame step and no loading look
//   calendar   first switch: the pane (aria-busy) at once, the look after 150 ms, then the view; Mail <-> Calendar again: no look; the event dialog (c in the Calendar) opens
//   pgp        Generate key: frame, look, dialog; Key details / Import key open
//   compose    key `c` pressed three times while the editor is still on its way (idle prefetch off): the compose frame at once, ONE message when it is there, nothing typed into To
//   reply      a Reply while the editor is on its way: the shell (status "Preparing reply…", Send off, Discard on) is on screen without the editor, then it fills
//   fail       #lazyfail=<settings|calendar|pgp|compose>: the toast "Failed: ..." in English and German, nothing half open (no dialog / back in Mail / no compose), and after taking the seam
//              away the next try opens it
//   windows    the reader window page loads no editor module (resource list), the compose window page loads the editor before it draws and shows its body
//   node scripts/test-lazy-views.mjs [--require-browser]
import { sleep, startHarness } from './cdp-harness.mjs';
import { PROBE_INSTALL, PROBE_PRESS, PROBE_READ, fill, verdict } from './lib/lazy-open-probe.mjs';

const H = await startHarness('test-lazy-views', { vitePort0: 5020 });
const { evaluate, cdp } = H;
const failures = [];
let checks = 0;
let tag = '';
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(`[${tag}] ${msg}`); console.error(`FAIL [${tag}] ${msg}`); } };
const scenario = async (name, fn) => { tag = name; try { await fn(); } catch (e) { failures.push(`[${name}] ${String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')}`); console.error(`FAIL [${name}] ${e.message}`); } };

const slow = (ms) => cdp('Network.emulateNetworkConditions', { offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 });
const fast = () => slow(0);
const key = async (k, code, vk) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k, windowsVirtualKeyCode: vk });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const waitFor = async (js, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };

/** A page with no idle prefetch of the editor (the cold path is what is tested), loaded with `hash`. */
async function boot(hash, w = 1280, h = 800) {
  await cdp('Network.enable');
  await fast();
  await cdp('Page.navigate', { url: 'about:blank' });
  const s = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestIdleCallback = () => 0;' });
  await H.openApp(hash, w, h);
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.identifier });
}

/**
 * Runs `trigger` in the page and notes, frame by frame, the first time each selector is on screen: `frame` (the frame of the part), `look` (the loading look) and `done` (the part).
 * Returns at once; read the result with `probeResult()`.
 */
const startProbe = (trigger, frameSel, doneSel) => evaluate(`(() => {
  const o = (window.__lz = { frame: null, look: null, done: null, animsAtDone: null, focusInModal: null });
  const t0 = performance.now();
  ${trigger};
  const tick = () => {
    const now = performance.now() - t0;
    if (o.frame === null && document.querySelector(${JSON.stringify(frameSel)})) o.frame = now;
    if (o.look === null && document.querySelector('.lazy-load[role=status]')) o.look = now;
    if (o.done === null && document.querySelector(${JSON.stringify(doneSel)})) {
      o.done = now;
      o.focusInModal = !!document.activeElement?.closest?.('.modal');
      setTimeout(() => { o.animsAtDone = document.getAnimations().filter((a) => ['pop', 'fade'].includes(a.animationName)).length; }, 60);
      return;
    }
    if (now < 20000) requestAnimationFrame(tick);
  };
  tick();
  return 1;
})()`);
const probeResult = async (ms = 20000) => { await waitFor('window.__lz && window.__lz.done !== null', ms); return evaluate('window.__lz'); };
const closeDialog = () => evaluate('window.__store.getState().setDialog(null); 1');

try {
  // ---- Settings
  await scenario('settings', async () => {
    await boot('lang=en');
    await slow(450);
    await startProbe('window.__store.getState().setDialog({ type: "settings" })', '.modal', '.modal .settings');
    await sleep(60);
    const early = await evaluate(`({ frame: !!document.querySelector('.modal'), title: document.querySelector('.modal-head b')?.textContent, look: !!document.querySelector('.lazy-load[role=status]'), handoff: document.documentElement.hasAttribute('data-lazy-handoff') })`);
    ok(early.frame && early.title === 'Settings', `the dialog frame is there at once with its title (${JSON.stringify(early)})`);
    ok(!early.look, 'no loading look at 60 ms');
    ok(early.handoff, 'the hand-off mark is on while the frame is up');
    await sleep(300);
    ok(await evaluate(`!!document.querySelector('.lazy-load[role=status]')`), 'the loading look by 360 ms');
    ok(await evaluate(`document.querySelector('.lazy-load[role=status]')?.textContent.trim()`) === 'Loading…', 'it says "Loading…" (the existing text)');
    ok(await evaluate(`!!document.querySelector('.modal-back.top, .modal-back')`) && (await evaluate(`document.querySelectorAll('.modal').length`)) === 1, 'one dialog, not two');
    await fast();
    const r = await probeResult();
    ok(r.frame !== null && r.frame <= 120, `the frame came at ${r.frame} ms`);
    ok(r.look !== null && r.look >= 140 && r.look <= 400, `the loading look came at ${r.look} ms (after 150 ms)`);
    ok(r.done !== null, 'the dialog is there');
    await sleep(150);
    ok(await evaluate(`!!document.activeElement?.closest?.('.modal')`), 'the focus is in the dialog');
    await sleep(100);
    const animsAtDone = await evaluate('window.__lz.animsAtDone');
    ok(animsAtDone === 0, `the dialog that replaced the frame played no opening animation again (${animsAtDone} running 60 ms later)`);
    ok(await evaluate(`document.documentElement.hasAttribute('data-lazy-handoff')`), 'the hand-off mark stays while the dialog is open (taking it away would start the opening animation of the dialog on screen)');
    ok(await evaluate(`getComputedStyle(document.querySelector('.modal')).animationName === 'none'`), 'and the dialog has no opening animation');
    ok(await evaluate(`document.querySelectorAll('.modal').length === 1 && !!document.querySelector('.settings-nav button.active')`), 'Settings is complete (a tab is selected)');
    // second open: no frame step, no look
    await closeDialog();
    await sleep(200);
    ok(await evaluate(`!document.documentElement.hasAttribute('data-lazy-handoff')`), 'the hand-off mark is gone when the dialog is closed');
    await slow(450); // (even on a slow network: the part is loaded already)
    await startProbe('window.__store.getState().setDialog({ type: "settings" })', '.modal', '.modal .settings');
    const r2 = await probeResult(3000);
    ok(r2.look === null, 'the second open shows no loading look');
    ok(r2.done !== null && r2.done <= 120, `the second open is complete at once (${r2.done} ms)`);
    await closeDialog();
    await fast();
  });

  // ---- Calendar
  await scenario('calendar', async () => {
    await boot('lang=en');
    await slow(450);
    await startProbe('window.__store.getState().setModule("calendar")', '.cal-view[aria-busy="true"]', '.cal-view .cal-head');
    await sleep(500);
    await fast();
    const r = await probeResult();
    ok(r.frame !== null && r.frame <= 120, `the pane box came at ${r.frame} ms`);
    ok(r.look !== null && r.look >= 140 && r.look <= 450, `the loading look came at ${r.look} ms`);
    ok(r.done !== null, 'the Calendar is there');
    // Mail <-> Calendar again: no look
    await evaluate('window.__store.getState().setModule("mail"); 1');
    await sleep(200);
    await slow(450);
    await startProbe('window.__store.getState().setModule("calendar")', '.cal-view', '.cal-view .cal-head');
    const r2 = await probeResult(3000);
    ok(r2.look === null && r2.done !== null && r2.done <= 150, `the second switch is immediate (${JSON.stringify(r2)})`);
    await fast();
    // the event dialog (the module is loaded: the dialog is complete at once) and the side menu is the Calendar's
    ok(await waitFor(`!!document.querySelector('.mini-head')`, 5000), 'the side menu of the Calendar is drawn');
    await startProbe('window.__store.getState().setDialog({ type: "event" })', '.modal', '.modal input');
    const r3 = await probeResult(5000);
    ok(r3.done !== null && r3.look === null, `the event dialog opens complete (${JSON.stringify(r3)})`);
    await closeDialog();
  });

  // ---- PGP dialogs
  await scenario('pgp', async () => {
    await boot('lang=en');
    await slow(450);
    await startProbe('window.__store.getState().setDialog({ type: "pgp-generate" })', '.modal', '.modal-body input, .modal-body select');
    await sleep(60);
    ok(await evaluate(`!!document.querySelector('.modal')`) && !(await evaluate(`!!document.querySelector('.lazy-load[role=status]')`)), 'Generate key: the frame at once, no look yet');
    await sleep(400);
    await fast();
    const r = await probeResult();
    ok(r.frame !== null && r.frame <= 120 && r.look !== null && r.look >= 140, `Generate key: frame ${r.frame} ms, look ${r.look} ms`);
    ok(r.done !== null, 'Generate key: the dialog is there');
    await closeDialog();
    await evaluate('window.__store.getState().setDialog({ type: "pgp-import", paste: true }); 1');
    ok(await waitFor(`!!document.querySelector('.modal-body textarea, .modal-body input')`, 5000), 'Import key opens');
    await closeDialog();
    await evaluate('window.__store.getState().setDialog({ type: "pgp-key", fingerprint: "ABCDEF" }); 1');
    ok(await waitFor(`!!document.querySelector('.modal')`, 5000), 'Key details opens');
    await closeDialog();
  });

  // ---- New mail: three presses of c while the editor is on its way
  await scenario('compose', async () => {
    await boot('lang=en');
    await slow(400);
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) { await key('c', 'KeyC', 67); await sleep(60); }
    await sleep(100);
    const early = await evaluate(`({ panes: document.querySelectorAll('.compose-pane').length, frame: document.querySelectorAll('.compose-pane[data-lazy-frame]').length, editor: document.querySelectorAll('.compose-pane .ProseMirror').length })`);
    ok(early.panes === 1 && early.frame === 1 && early.editor === 0, `the frame of ONE message is on screen while the editor loads (${JSON.stringify(early)}, ${Date.now() - t0} ms after the first key)`);
    await sleep(300);
    ok(await evaluate(`!!document.querySelector('.lazy-load[role=status]')`), 'the loading look in the body after 150 ms');
    await fast();
    ok(await waitFor(`!!document.querySelector('.compose-pane .ProseMirror')`, 30000), 'the editor arrived');
    await sleep(300);
    const end = await evaluate(`({ panes: document.querySelectorAll('.compose-pane').length, editors: document.querySelectorAll('.compose-pane .ProseMirror').length, to: document.querySelector('.cf-field.rcpt input')?.value ?? null, frame: document.querySelectorAll('[data-lazy-frame]').length, focusInTo: !!document.activeElement?.closest?.('.cf-field.rcpt') })`);
    ok(end.panes === 1 && end.editors === 1 && end.frame === 0, `exactly one message, no frame left (${JSON.stringify(end)})`);
    ok(end.to === '', `nothing was typed into To (${end.to})`);
    ok(end.focusInTo, 'the caret is in the To field as it is today');
    // the next message in the same run opens in the same render (the editor is loaded): no frame step
    await evaluate('window.__store.getState().openCompose(null, { restore: false }); 1');
    await sleep(200);
    await slow(400);
    await startProbe('window.__store.getState().openCompose({ accountId: window.__store.getState().accounts[0].id })', '.compose-pane', '.compose-pane .ProseMirror');
    const r = await probeResult(5000);
    ok(r.done !== null && r.look === null, `the second message opens with the editor in it (${JSON.stringify(r)})`);
    await fast();
  });

  // ---- Reply: the shell does not wait for the editor
  await scenario('reply', async () => {
    await boot('lang=en');
    await evaluate(`window.__mockDelays = { replyHeaders: 1500 }; 1`);
    await evaluate(`window.__store.getState().select(window.__store.getState().threads[0].threadId); 1`);
    ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), 'a message is open');
    await slow(450); // (no pointer went near a Reply button: the editor is not prefetched; the open message prefetches it, so the network is slowed after that started: the load is still in flight)
    await evaluate('window.__lz = { t0: performance.now(), shell: null, status: null, filled: null }; (function tick() { const p = document.querySelector(".compose-pane"); const o = window.__lz; const now = performance.now() - o.t0; if (p && o.shell === null) o.shell = now; if (p?.classList.contains("preparing") && p.querySelector(".cp-prep [role=status]") && o.status === null) o.status = now; if (p && !p.classList.contains("preparing") && p.querySelector(".ProseMirror") && o.filled === null) { o.filled = now; return; } if (now < 25000) requestAnimationFrame(tick); })(); 1');
    await evaluate(`document.querySelector('button[aria-label="Reply"], .rp-reply-row .btn')?.click(); 1`);
    await sleep(500);
    const shell = await evaluate(`(() => { const p = document.querySelector('.compose-pane'); return p ? { preparing: p.classList.contains('preparing'), frame: p.hasAttribute('data-lazy-frame'), sendOff: !!p.querySelector('.split-btn .btn.primary')?.disabled, discard: !!p.querySelector('.cp-keep'), status: p.querySelector('.cp-prep [role=status] p')?.textContent.trim() ?? null, subject: p.querySelector('.cf-subject input')?.value } : null; })()`);
    ok(shell && shell.preparing && shell.sendOff && shell.discard, `the shell is on screen (${JSON.stringify(shell)})`);
    ok(shell && shell.status === 'Preparing reply…', `the status reads "Preparing reply…" (${shell?.status})`);
    ok(shell && /^Re: /.test(shell.subject ?? ''), 'the subject is in the shell');
    await fast();
    ok(await waitFor('window.__lz.filled !== null', 30000), 'the message filled in when the editor and the headers were there');
    const r = await evaluate('window.__lz');
    ok(r.shell !== null && r.shell <= 300, `the shell came at ${r.shell} ms (200 ms on a release build)`);
    ok(r.status !== null && r.status <= 350, `the status came at ${r.status} ms`);
    ok(await evaluate(`document.querySelectorAll('.compose-pane').length === 1 && !document.querySelector('[data-lazy-frame]')`), 'one pane, the frame replaced by the editor');
  });

  // ---- failure paths
  for (const [lang, expect] of [['en', 'Failed:'], ['de', 'Fehlgeschlagen:']]) {
    await scenario(`fail-${lang}`, async () => {
      await boot(`lang=${lang}&lazyfail=settings,calendar,pgp,compose`);
      const toastText = () => evaluate(`window.__store.getState().toasts.map((t) => (t.textFn ? t.textFn() : t.text))`);
      // Settings
      await evaluate('window.__store.getState().setDialog({ type: "settings" }); 1');
      await sleep(80);
      ok(await evaluate(`!!document.querySelector('.modal')`), 'Settings: the frame is there at once');
      ok(await waitFor(`!document.querySelector('.modal') && window.__store.getState().dialog === null`, 4000), 'Settings: nothing half open after the failure');
      let toasts = await toastText();
      ok(toasts.some((t) => t.startsWith(expect)), `Settings: the toast "${expect} ..." (${JSON.stringify(toasts)})`);
      // Calendar
      await evaluate('window.__store.getState().setModule("calendar"); 1');
      ok(await waitFor(`window.__store.getState().module === 'mail'`, 4000), 'Calendar: back in Mail after the failure');
      ok(await evaluate(`!document.querySelector('.cal-view')`), 'Calendar: no half open pane');
      // PGP
      await evaluate('window.__store.getState().setDialog({ type: "pgp-generate" }); 1');
      ok(await waitFor(`window.__store.getState().dialog === null && !document.querySelector('.modal')`, 4000), 'PGP: no dialog left');
      // compose
      await evaluate('window.__store.getState().openCompose({ accountId: window.__store.getState().accounts[0].id }); 1');
      ok(await waitFor(`window.__store.getState().compose === null && !document.querySelector('.compose-pane')`, 4000), 'Compose: the pane is closed again');
      toasts = await toastText();
      ok(toasts.filter((t) => t.startsWith(expect)).length >= 3, `one toast per failure (${JSON.stringify(toasts)})`);
      // the seam taken away: the next try opens it
      await evaluate(`location.hash = 'lang=en'; 1`);
      await evaluate('window.__store.getState().setDialog({ type: "settings" }); 1');
      ok(await waitFor(`!!document.querySelector('.modal .settings')`, 20000), 'Settings opens at the next try (no failure was remembered)');
      await closeDialog();
      await evaluate('window.__store.getState().setModule("calendar"); 1');
      ok(await waitFor(`!!document.querySelector('.cal-view .cal-head')`, 20000), 'Calendar opens at the next try');
    });
  }

  // ---- the QA probe (scripts/lib/lazy-open-probe.mjs, the bridge script of the Mac / Linux rows) works on the real page: real presses, then the numbers
  for (const kind of ['settings', 'calendar', 'compose']) {
    await scenario(`probe-${kind}`, async () => {
      await boot('lang=en');
      ok((await evaluate(`(() => { ${fill(PROBE_INSTALL, kind)} })()`)).installed, 'the recorder is installed');
      const pressed = await evaluate(`(() => { ${fill(PROBE_PRESS, kind)} })()`);
      ok(pressed.pressed, `the button of "${kind}" was found and pressed`);
      ok(await waitFor('window.__lazyOpen.part !== null && window.__lazyOpen.focus !== null', 30000), 'the part appeared');
      await sleep(300);
      const r = await evaluate(`(() => { ${PROBE_READ} })()`);
      const bad = verdict(r, { partMax: 5000 }); // (the dev preview is not a release build: the 300 ms are for the kits)
      ok(bad.length === 0, `probe verdict: ${bad.join('; ')} ${JSON.stringify(r)}`);
      ok(r.chunks.length > 0, 'the chunks fetched by the first open are listed');
    });
  }

  // ---- the pop-out windows
  await scenario('windows', async () => {
    const open = async (query, w, h) => {
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: `${H.base}?${query}#lang=en` });
    };
    const resources = () => evaluate(`performance.getEntriesByType('resource').map((r) => r.name)`);
    const editorish = (names) => names.filter((n) => /Compose\.tsx|RichEditor|SettingsDialog|\/Calendar\.tsx|PgpDialogs|@tiptap|prosemirror/i.test(n));
    await open('w=reader&thread=t1', 900, 700);
    ok(await waitFor(`!!document.querySelector('.reader-win, .rp-msg, [class*=reader]')`, 30000), 'the reader window draws its view');
    await sleep(2500); // (a page with an idle prefetch would have asked for the editor by now)
    const reader = editorish(await resources());
    ok(reader.length === 0, `the reader window loaded no editor module: ${reader.slice(0, 4).join(', ')}`);
    await open('w=compose&mock=new', 900, 700);
    ok(await waitFor(`!!document.querySelector('.compose-pane .ProseMirror')`, 30000), 'the compose window shows its body');
    const compose = editorish(await resources());
    ok(compose.some((n) => /Compose\.tsx/.test(n)) && compose.some((n) => /tiptap/i.test(n)), 'the compose window loaded the editor');
    ok(await evaluate(`document.querySelectorAll('.compose-pane').length === 1`), 'one message in the window');
  });
} finally {
  await H.shutdown();
}

if (failures.length) {
  console.error(`test-lazy-views: ${failures.length} failure(s) of ${checks} checks\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log(`test-lazy-views: ok (${checks} checks)`);
