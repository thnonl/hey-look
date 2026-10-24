#!/usr/bin/env node
// 1.0.7 W13.13 / D-064: Reply, Reply all and Forward of a long mail open at once. Real list, pane and compose in the dev preview (src/devMock.ts: `window.__mockDelays` stand in for the
// server: replyHeaders = the round trip of the headers, quote = one picture, quoteFirst = the download of the raw message; the fixtures are scripts/lib/reply-fixtures.mjs). Checked:
//   - the compose shell is on screen within one frame of the press (200 ms on a release build; this test runs the dev preview, so its budgets are scaled by a calibration of the machine, see "timing budgets" below, with a hard cap), with the header rows in place,
//     the From / To / Cc / Subject fields and the formatting row off, Send disabled, Discard on, and the status "Preparing reply…" (role=status, aria-busy) by 200 ms;
//   - the message fills in when the slow steps are done: after the longest of them, not after their sum (headers and pictures side by side); the To field's box is the same +- 1 px;
//     the status is gone, Send is on, the quote is in the editor; a quick open (no delay) never shows the status;
//   - Discard and Esc while it prepares end it: no draft is saved, no toast, and the result that arrives later does not open again;
//   - the same answer pressed again (a window of its own) starts nothing new; the window gets the shell with `preparing` at once and the finished message when it asks for it;
//   - a server that fails: the answer to From, no stuck status; Forward with attachments says "Getting the attachments…" and has no separate toast, the 3 files come along;
//   - the compose window (?w=compose): the shell, then the message handed over by the main window; the status stays 300 ms once shown;
//   - the two texts in the 8 languages at 960 x 560 and 1280 x 800, light and dark, not clipped; reduced motion shows the dots instead of the ring.
//   node scripts/test-reply-feedback.mjs [--require-browser] [--throttle=4]   (--throttle: CDP CPU throttling, to try the budgets on a slow computer)
import assert from 'node:assert/strict';
import { arg, inputs, sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';
import { CALIBRATE, PROBE_INSTALL, PROBE_PRESS, PROBE_READ, fill } from './lib/reply-open-probe.mjs';

const H = await startHarness('test-reply-feedback', { vitePort0: 5995 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { ms *= Math.max(1, scale); /* (a slow computer waits longer for the same thing) */ const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(30); } return false; };
const fn = (body) => `(() => { ${body} })()`;
// ---- timing budgets: relative to how fast this page runs, with a hard cap
// The budget of the pane is 200 ms on a release build (REQ-13.13.1); this test runs the dev preview (Compose unoptimised, React with its development checks) on whatever machine runs it, a shared CI
// runner included (2 to 3 times slower than the machine the numbers were first taken on). So every budget is  BASE x scale  with scale = (the time this page needs for a fixed piece of main-thread
// work, `CALIBRATE` in lib/reply-open-probe.mjs) / CPU_REF, never below 1 and at most 8, each time the median of 3 measurements, and never above HARD_CAP_MS. The cap is below the shortest wait of the
// bug being tested (the old code showed nothing until the server answered: 3000 ms or more in these scenarios), so a shell that waits for the headers, the pictures or the quote fails on any machine.
const CPU_REF = 48; // ms of CALIBRATE's `cpu` on the development machine (Windows, 1x); 4x CPU throttling measures 230-280
const HARD_CAP_MS = 2800;
const BASE_SHELL_MS = 400; // press -> shell / first frame / status, at scale 1 (200 ms on a release build)
const BASE_FILL_MS = 700; // press -> a complete message when nothing is slow, at scale 1
let scale = 1;
const budget = (base) => Math.min(Math.round(base * scale), HARD_CAP_MS);
const slowMs = (ms) => Math.round(ms * Math.max(1, scale)); // (a wait or a server delay a test must stay inside of grows on a slow computer)
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

const TEXTS = {
  en: ['Preparing reply…', 'Preparing forward…'], vi: ['Đang chuẩn bị thư trả lời…', 'Đang chuẩn bị thư chuyển tiếp…'], fr: ['Préparation de la réponse…', 'Préparation du transfert…'],
  'zh-Hans': ['正在准备回复…', '正在准备转发…'], es: ['Preparando la respuesta…', 'Preparando el reenvío…'], ja: ['返信を準備しています…', '転送を準備しています…'],
  de: ['Antwort wird vorbereitet…', 'Weiterleitung wird vorbereitet…'], ru: ['Подготовка ответа…', 'Подготовка пересылки…'],
};

const delays = (d) => evaluate(`window.__mockDelays = ${JSON.stringify(d)}; window.__attachmentCalls = []; window.__replyHeaderCalls = []; 1`);
const closeCompose = async () => { await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`); await sleep(150); };
/** Waits until the mock has not been asked for a picture for a moment: a shell that was discarded finishes its fetches in the background, and they must not land in the next scenario's log. */
async function quiet() {
  let last = -1, same = 0;
  for (let i = 0; i < 300 && same < 3; i++) {
    const n = await evaluate(`(window.__attachmentCalls || []).length + (window.__replyHeaderCalls || []).length`);
    same = n === last ? same + 1 : 0;
    last = n;
    await sleep(120);
  }
}
async function openMessage(id) {
  await closeCompose();
  await quiet();
  await evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000), `the message ${id} did not open`);
  await sleep(300);
}
const install = () => evaluate(fn(PROBE_INSTALL));
const press = (button) => evaluate(fn(fill(PROBE_PRESS, button)));
const read = () => evaluate(fn(PROBE_READ));
const pane = (js) => evaluate(`(() => { const p = document.querySelector('.compose-pane'); return p ? (${js})(p) : null; })()`);
const shellFacts = () => pane(`(p) => ({
  preparing: p.classList.contains('preparing'),
  fieldsInert: !!p.querySelector('.cp-fields')?.hasAttribute('inert'),
  fmtInert: !!p.querySelector('.cp-fmt')?.hasAttribute('inert'),
  sendDisabled: !!p.querySelector('.split-btn .btn.primary')?.disabled,
  discardOn: !!p.querySelector('.cp-bar .cp-keep') && !p.querySelector('.cp-bar .cp-keep').closest('[inert]'),
  barOff: [...p.querySelectorAll('.cp-bar > :not(.cp-keep)')].every((e) => e.hasAttribute('inert')),
  subject: p.querySelector('.cf-subject input')?.value ?? null,
  status: (() => { const s = p.querySelector('.cp-prep [role=status]'); return s ? { text: s.querySelector('p').textContent.trim(), busy: s.getAttribute('aria-busy') } : null; })(),
  focusOnBody: document.activeElement?.classList.contains('cp-prep') ?? false,
  chips: p.querySelectorAll('.cf-field.rcpt .rchip, .cf-field .rchip').length,
  quote: !!p.querySelector('.cp-editor .quote-block'),
})`);
/** Loads the preview, adds the fixtures and opens one message once (the first open after a load can be lost while the dev server optimises). */
async function boot(hash, w, h) {
  await H.openApp(hash, w, h);
  assert.ok(await evaluate(FIXTURES), 'the fixtures were not added');
  await evaluate(`window.__store.getState().refresh().then(() => 1)`); // (the list reads the new conversations)
  for (let i = 0; i < 4; i++) {
    await evaluate(`window.__store.getState().select(${JSON.stringify(IDS.att)}); 1`);
    if (await waitFor(`!!document.querySelector('.rp-msg.open button')`, 6000)) return;
  }
  throw new Error('no message opened after the start');
}
/** Presses `button` three times on message `id` with a slow server and gives the median of the first-frame times; each time the shell is discarded once the status was seen. */
async function shellTimes(id, button, d) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    await openMessage(id);
    await delays(d);
    await install();
    assert.ok((await press(button)).pressed, `no ${button} button`);
    assert.ok(await waitFor(`window.__replyOpen.status !== null`, 8000), 'the status never showed');
    runs.push(await read());
    await evaluate(`document.querySelector('.compose-pane .cp-bar .cp-keep').click(); 1`);
    assert.ok(await waitFor(`!document.querySelector('.compose-pane')`, 3000), 'Discard did not end the shell');
  }
  return { shell: median(runs.map((r) => r.shellMs)), press: median(runs.map((r) => r.pressMs)), status: median(runs.map((r) => r.statusMs)), runs: runs.map((r) => [r.shellMs, r.pressMs, r.statusMs]) };
}
const toasts = () => evaluate(`window.__store.getState().toasts.map((t) => t.text ?? '')`);

try {
  if (arg('throttle')) await cdp('Emulation.setCPUThrottlingRate', { rate: Number(arg('throttle')) });
  await boot('lang=en', 1280, 800);
  const cal = await evaluate(CALIBRATE);
  scale = Math.min(Math.max(1, cal.cpu / CPU_REF), 8);
  console.log(`test-reply-feedback: this page runs the reference work in ${cal.cpu} ms (reference ${CPU_REF}), a frame in ${cal.frame} ms: scale ${scale.toFixed(2)}, shell budget ${budget(BASE_SHELL_MS)} ms, hard cap ${HARD_CAP_MS} ms`);

  // ---- the 2 MB mail, 4 s headers: the shell and the status come at once (median of 3, nothing waits for the server)
  await check('F-huge: the first frame, the shell and the status do not wait for the server (median of 3)', async () => {
    const m = await shellTimes(IDS.huge, 'Reply', { replyHeaders: 4000, quoteFirst: 800, quote: 20 });
    const b = budget(BASE_SHELL_MS);
    assert.ok(m.shell <= b, `the shell took ${m.shell} ms (median of ${JSON.stringify(m.runs)}), budget ${b}`);
    assert.ok(m.press <= b, `the first frame after the press came at ${m.press} ms, budget ${b}`);
    assert.ok(m.status <= Math.min(b + 150 * scale, HARD_CAP_MS), `the status came at ${m.status} ms, budget ${Math.min(Math.round(b + 150 * scale), HARD_CAP_MS)}`);
    for (const r of m.runs) assert.ok(r[0] <= HARD_CAP_MS && r[2] <= HARD_CAP_MS, `a run waited for the server: ${JSON.stringify(m.runs)}`);
  });

  // ---- the 2 MB mail, headers 3 s: what the shell looks like, the fill after the longest step
  await check('F-huge: the shell at once, the status by 200 ms, the fill after the longest step (not the sum)', async () => {
    await openMessage(IDS.huge);
    await delays({ replyHeaders: 3000, quoteFirst: 800, quote: 20 });
    await install();
    assert.ok((await press('Reply')).pressed);
    assert.ok(await waitFor(`window.__replyOpen.status !== null`, 8000), 'the status never showed');
    const early = await read();
    assert.ok(early.shellMs !== null && early.shellMs <= HARD_CAP_MS, `the shell took ${early.shellMs} ms`);
    const f = await shellFacts();
    assert.ok(f.preparing && f.fieldsInert && f.fmtInert && f.sendDisabled && f.discardOn && f.barOff, `the shell is not off where it should be: ${JSON.stringify(f)}`);
    assert.equal(f.subject, 'Re: Fixture huge 2 MB');
    assert.deepEqual(f.status, { text: 'Preparing reply…', busy: 'true' }, 'the status');
    assert.ok(f.focusOnBody, 'the focus is on the body of the shell (Esc and Tab work from there)');
    assert.equal(f.quote, false);
    assert.equal(await evaluate(`window.__replyHeaderCalls.length`), 1, 'the headers were asked for once, at once');
    assert.ok(await waitFor(`window.__replyOpen.filled !== null`, 12000), 'the message never filled in');
    const r = await read();
    // the longest step is the headers (3 s); the old code added the pictures (0.8 s + 40 x 20 ms) and the quote after it
    assert.ok(r.filledMs >= 2900 && r.filledMs <= 3000 + 1100 * Math.min(scale, 3), `filled at ${r.filledMs} ms (the headers take 3000)`);
    // side by side, not one after the other: the first picture was asked for right after the headers (a serial Reply asks 3 s later, when the headers are there)
    const at = await evaluate(`({ headers: window.__replyHeaderCalls[0].at, picture: window.__attachmentCalls[0].at })`);
    assert.ok(at.picture - at.headers < HARD_CAP_MS, `the pictures waited ${Math.round(at.picture - at.headers)} ms for the headers`);
    assert.ok(r.statusGoneMs !== null && r.statusGoneMs >= r.statusMs + 300, `the status stayed ${r.statusGoneMs - r.statusMs} ms`);
    assert.ok(r.toMovedPx !== null && r.toMovedPx <= 1, `the To field moved ${r.toMovedPx} px`);
    const after = await shellFacts();
    assert.ok(!after.preparing && !after.fieldsInert && !after.sendDisabled && after.quote && after.chips >= 1 && !after.status, `the filled compose: ${JSON.stringify(after)}`);
    assert.equal(await evaluate(`document.activeElement?.closest?.('.cp-editor') ? 'editor' : document.activeElement?.tagName`), 'editor', 'the caret goes to the body as it does today');
    assert.equal(await evaluate(`(window.__attachmentCalls || []).length`), 40, 'all 40 pictures were fetched');
    assert.deepEqual(await toasts(), [], 'no toast');
  });

  // ---- a quick open: complete at once; the status only when the work took longer than it waits (median of 3)
  await check('F-small, nothing slow: the compose is complete quickly and the status never flashes', async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await openMessage(IDS.small);
      await delays({});
      await install();
      await press('Reply');
      assert.ok(await waitFor(`window.__replyOpen.filled !== null`, 8000));
      await sleep(500);
      runs.push(await read());
    }
    for (const r of runs) {
      assert.ok(r.statusMs === null || r.filledMs >= 140, `the status showed for a message that was there at ${r.filledMs} ms: ${JSON.stringify(r)}`); // (it shows 140 ms after the press: composeShell.ts)
      assert.ok(r.toMovedPx <= 1, `the To field moved ${r.toMovedPx} px`);
    }
    const b = budget(BASE_FILL_MS);
    const m = median(runs.map((r) => r.filledMs));
    assert.ok(m <= b, `complete at ${m} ms (median of ${runs.map((r) => r.filledMs)}), budget ${b}`);
    // (that no status shows at all for a quick message is a property of the release build, where the whole message is there about 100 ms after the press: AC-13.13.2 on the release kit; the dev preview is
    // slower than the 140 ms the status waits, so here only the rule is checked: it never shows for a message that was there already)
  });

  // ---- Discard while it prepares
  await check('Discard while preparing: no draft, no toast, the late result does not open it again', async () => {
    await openMessage(IDS.big);
    await delays({ replyHeaders: slowMs(2500), quote: 0 });
    await evaluate(`window.__draftSaveCalls = 0; 1`);
    await press('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000), 'no shell');
    await evaluate(`document.querySelector('.compose-pane .cp-bar .cp-keep').click(); 1`);
    await sleep(300);
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false, 'Discard did not end the shell');
    await sleep(slowMs(2700)); // (the headers come back)
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane') || !!window.__store.getState().compose`), false, 'the result opened it again');
    assert.equal(await evaluate(`window.__draftSaveCalls || 0`), 0, 'a draft was saved');
    assert.deepEqual(await toasts(), [], 'a toast');
    assert.equal(await evaluate(`!!document.querySelector('.rp-msg.open')`), true, 'the reading pane is back');
  });
  await check('Esc while preparing ends it the same way', async () => {
    await openMessage(IDS.big);
    await delays({ replyHeaders: slowMs(2500), quote: 0 });
    await press('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000), 'no shell');
    assert.ok((await shellFacts()).focusOnBody, 'the focus is not on the shell body');
    await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false, 'Esc did not end the shell');
    await sleep(slowMs(2700));
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false, 'the late result opened it again');
  });

  // ---- the server does not answer
  await check('headers fail: the answer to From, no quote lost, no stuck status', async () => {
    await openMessage(IDS.big);
    await delays({ replyHeaders: 600, replyHeadersFail: true, quote: 0 });
    await install();
    await press('Reply all');
    assert.ok(await waitFor(`window.__replyOpen.filled !== null`, 8000), 'never filled');
    const f = await shellFacts();
    assert.ok(!f.preparing && f.quote && !f.status && f.chips >= 1, JSON.stringify(f));
    assert.deepEqual(await pane(`(p) => [...p.querySelectorAll('.cf-field.rcpt .rchip, .cf-field .rchip')].map((c) => c.textContent.trim())`), ['Linh Tran <linh@example.com>'], 'to From');
  });

  // ---- Forward with attachments
  await check('Forward: "Getting the attachments…" in the shell, no separate toast, the files come along', async () => {
    await openMessage(IDS.att);
    await delays({ replyHeaders: slowMs(1200), quote: slowMs(700) });
    await install();
    await press('Forward');
    assert.ok(await waitFor(`!!document.querySelector('.cp-prep [role=status]')`, 3000), 'no status');
    const f = await shellFacts();
    assert.deepEqual(f.status, { text: 'Getting the attachments…', busy: 'true' });
    assert.equal(f.subject, 'Fwd: Fixture three attachments');
    assert.deepEqual(await toasts(), [], 'the old 700 ms toast is back');
    assert.ok(await waitFor(`window.__replyOpen.filled !== null`, 10000));
    assert.equal(await evaluate(`document.querySelectorAll('.compose-pane .atts .att-chip').length`), 3, 'the three attachments');
    assert.deepEqual(await toasts(), []);
    // the three fetches ran side by side (3 x 700 ms would be 2.1 s after the headers)
    // the three files were asked for side by side (one after the other they start 700 ms apart)
    const starts = await evaluate(`window.__attachmentCalls.map((c) => c.at)`);
    assert.equal(starts.length, 3);
    assert.ok(Math.max(...starts) - Math.min(...starts) < 400, `the attachments were fetched one after the other: starts ${JSON.stringify(starts.map((x) => Math.round(x)))}`);
  });
  await check('Forward without attachments: "Preparing forward…"', async () => {
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(1500) });
    await press('Forward');
    assert.ok(await waitFor(`!!document.querySelector('.cp-prep [role=status]')`, 3000), 'no status');
    assert.deepEqual((await shellFacts()).status, { text: 'Preparing forward…', busy: 'true' });
    assert.ok(await waitFor(`!document.querySelector('.compose-pane.preparing') && !!document.querySelector('.compose-pane .quote-block')`, 6000));
  });

  // ---- a window of its own
  await check('window mode: the shell is asked for at once, the button is busy, a second press starts nothing, the message is handed over when the window asks', async () => {
    await openMessage(IDS.huge);
    await evaluate(`window.__store.getState().setPrefs({ popoutCompose: true }); window.__popoutOpened = []; window.__popoutReplies = []; window.__popoutKeys = new Set(); 1`);
    await delays({ replyHeaders: Math.round(1500 + 1500 * scale), quoteFirst: 300, quote: 10 });
    await install();
    await press('Reply');
    await sleep(60);
    const busy = await evaluate(`[...document.querySelectorAll('.rp-msg.open button')].filter((b) => b.getAttribute('aria-busy') === 'true').length`);
    assert.ok(busy >= 1, 'the pressed button is not busy');
    await sleep(240);
    const opened = await evaluate(`window.__popoutOpened.filter((o) => !o.focusOnly)`);
    assert.equal(opened.length, 1, 'one window asked for');
    assert.equal(opened[0].key, 're:m-fx-huge', 'the window key is the answer');
    assert.equal(opened[0].init.preparing.kind, 'reply');
    assert.equal(opened[0].init.subject, 'Re: Fixture huge 2 MB');
    assert.equal(opened[0].init.bodyHtml, undefined, 'the shell has no body');
    // the pane stays: the button shows the press until the window is asked for, then is free again after the minimum
    // a second press of the same answer: the window with that key is brought forward (focus-only ask), nothing new is prepared
    const calls = await evaluate(`window.__replyHeaderCalls.length`);
    await press('Reply');
    await sleep(200);
    assert.equal(await evaluate(`window.__replyHeaderCalls.length`), calls, 'the second press started a preparation');
    assert.equal(await evaluate(`window.__popoutOpened.filter((o) => !o.focusOnly).length`), 1, 'a second window');
    assert.equal(await evaluate(`window.__popoutOpened.filter((o) => o.focusOnly).length >= 1`), true, 'the window was not brought forward');
    assert.equal(await evaluate(`window.__popoutReplies.filter((r) => r.id === 'shell-fill').length`), 0, 'the window is not listening yet: nothing is sent');
    // the window starts listening: asks for its message (the event the backend would send)
    await evaluate(`window.__mockEmit('popout-request', { id: 'cw1', from: 'compose-1', kind: 'cw-fill-ready', payload: null }); 1`);
    await sleep(100);
    assert.equal(await evaluate(`window.__popoutReplies.filter((r) => r.id === 'shell-fill').length`), 0, 'sent before the message is ready');
    assert.ok(await waitFor(`window.__popoutReplies.filter((r) => r.id === 'shell-fill').length === 1`, 8000), 'the finished message was not handed to the window');
    const rep = await evaluate(`window.__popoutReplies.find((r) => r.id === 'shell-fill')`);
    assert.equal(rep.to, 'compose-1');
    assert.equal(rep.id, 'shell-fill');
    assert.equal(rep.data.afterShell, true);
    assert.equal(rep.data.preparing, undefined);
    assert.ok(rep.data.bodyHtml.includes('hl-quote'), 'the quote');
    assert.deepEqual(rep.data.to, ['Linh Tran <linh@example.com>']);
    await evaluate(`window.__store.getState().setPrefs({ popoutCompose: false }); 1`);
  });

  // ---- the compose window itself, in a plain tab
  await check('the compose window: the shell, then the message handed over (the status stays 300 ms once shown)', async () => {
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=prepare#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.popout-compose .compose-pane.preparing')`, 20000), 'no shell in the window');
    await sleep(250);
    const f = await shellFacts();
    assert.deepEqual(f.status, { text: 'Preparing reply…', busy: 'true' }, JSON.stringify(f));
    assert.ok(f.fieldsInert && f.sendDisabled);
    assert.ok(await waitFor(`(window.__popoutRequests || []).some((r) => r.kind === 'cw-fill-ready')`, 5000), 'the window did not ask for its message');
    const full = { accountId: 'a1', to: ['linh.tran@acme.example'], subject: 'Re: Q4 roadmap review', isReply: true, afterShell: true, inReplyTo: '<m1@acme.example>', bodyHtml: '<br><div class="hl-quote"><div>On Mon, Linh wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p>Could you review the milestones?</p></blockquote></div>' };
    await evaluate(`window.__mockEmit('popout-reply', { id: 'shell-fill', ok: true, data: ${JSON.stringify(full)}, error: null }); 1`);
    assert.ok(await waitFor(`!document.querySelector('.compose-pane.preparing') && !!document.querySelector('.compose-pane .quote-block')`, 5000), 'the window did not fill');
    const g = await shellFacts();
    assert.ok(!g.preparing && g.chips === 1 && g.quote && !g.status && !g.sendDisabled, JSON.stringify(g));
    // another message's answer (not the shell's) is ignored
    await evaluate(`window.__mockEmit('popout-reply', { id: 'cw9', ok: true, data: { subject: 'x' }, error: null }); 1`);
    await sleep(200);
    assert.equal(await evaluate(`document.querySelector('.cf-subject input').value`), 'Re: Q4 roadmap review');
    // a status that was shown stays 300 ms: the message handed over a moment after it appeared waits
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=prepare#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing .cp-prep [role=status]')`, 20000), 'the status never showed in the window');
    const shownAt = Date.now();
    await evaluate(`window.__mockEmit('popout-reply', { id: 'shell-fill', ok: true, data: ${JSON.stringify(full)}, error: null }); 1`);
    assert.ok(await waitFor(`!document.querySelector('.compose-pane.preparing')`, 5000));
    assert.ok(Date.now() - shownAt >= 150, 'the status went at once (the minimum is 300 ms after it was drawn)');
  });

  // ---- the shell is filled IN PLACE (WP13f-3, DEC-023): the Compose and its editor are the same objects before and after the fill, Ctrl+Z cannot take the message back, a shell leaves no draft or snapshot
  const filledJs = `!document.querySelector('.compose-pane.preparing') && !!document.querySelector('.compose-pane .quote-block')`;
  const MARK = `(() => { const p = document.querySelector('.compose-pane'); window.__shell = { pane: p, instance: p.getAttribute('data-compose-instance'), editor: p.__editor, view: p.__editor && p.__editor.view, key: window.__store.getState().composeKey }; return !!window.__shell.editor && !!window.__shell.instance && !!window.__shell.view; })()`;
  const SAME = `(() => { const s = window.__shell, p = document.querySelector('.compose-pane'); return { pane: p === s.pane, instance: p.getAttribute('data-compose-instance') === s.instance, editor: p.__editor === s.editor, view: s.editor.view === s.view, prosemirror: document.querySelector('.cp-editor .tiptap')?.editor === s.editor, key: window.__store.getState().composeKey === s.key, editable: s.editor.isEditable }; })()`;
  const ALL_SAME = { pane: true, instance: true, editor: true, view: true, prosemirror: true, key: true, editable: true };
  const editorDoc = () => evaluate(`JSON.stringify(window.__shell.editor.getJSON())`);
  const canUndo = () => evaluate(`window.__shell.editor.can().undo()`);
  const io = inputs(H, null, 'rf');
  const pressOn = async (button) => (await install(), press(button)); // (the probe's clock starts with the press)
  await boot('lang=en', 1280, 800); // (the check before this one left the tab on the compose window page)

  await check('in place (pane): the Compose instance, its editor and its view are the same objects after the fill, composeKey is not bumped (AC-13.13.15)', async () => {
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(700), quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000), 'no shell');
    assert.ok(await evaluate(MARK), 'the shell has no instance marker / editor / view');
    assert.equal(await evaluate(`window.__shell.editor.isEditable`), false, 'the editor of a shell is not editable');
    assert.equal(await evaluate(`window.__shell.editor.getText().trim() === ''`), true, 'the editor of a shell is empty');
    assert.ok(await waitFor(filledJs, 8000), 'the message never filled in');
    const s = await evaluate(SAME);
    assert.deepEqual(s, ALL_SAME, JSON.stringify(s));
    assert.equal(await evaluate(`window.__shell.editor.getJSON().content.some((n) => n.type === 'quoteBlock')`), true, 'the quote is in the same editor');
    assert.equal(await evaluate(`document.querySelectorAll('.cp-editor .sig-block').length`), 1, 'the signature region is there once');
  });
  await check('in place (pane): Reply all and Forward keep the instance as well', async () => {
    for (const [button, id] of [['Reply all', IDS.cc], ['Forward', IDS.att]]) {
      await openMessage(id);
      await delays({ replyHeaders: slowMs(500), quote: slowMs(100) });
      await pressOn(button);
      assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000), `${button}: no shell`);
      assert.ok(await evaluate(MARK));
      assert.ok(await waitFor(filledJs, 8000), `${button}: never filled`);
      const s = await evaluate(SAME);
      assert.deepEqual(s, ALL_SAME, `${button}: ${JSON.stringify(s)}`);
    }
  });

  await check('Undo: Ctrl+Z right after the fill changes nothing; typing then Ctrl+Z removes only the typing (AC-13.13.17)', async () => {
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(500), quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000));
    assert.ok(await evaluate(MARK));
    assert.ok(await waitFor(filledJs, 8000));
    await sleep(300);
    const before = await editorDoc();
    assert.equal(await canUndo(), false, 'the fill is in the undo history');
    assert.ok(await waitFor(`document.activeElement?.closest?.('.cp-editor') !== null`, 2000), 'the caret is not in the body');
    await io.press('z', 'KeyZ', 2);
    await sleep(150);
    assert.equal(await editorDoc(), before, 'Ctrl+Z changed the message');
    await io.typeText('abc', 10);
    await sleep(150);
    assert.notEqual(await editorDoc(), before, 'nothing was typed');
    assert.equal(await canUndo(), true);
    await io.press('z', 'KeyZ', 2);
    await sleep(150);
    assert.equal(await editorDoc(), before, 'Ctrl+Z did not remove just the typing');
    assert.equal(await canUndo(), false, 'one Ctrl+Z more would undo the fill');
    await io.press('z', 'KeyZ', 2);
    await sleep(100);
    assert.equal(await editorDoc(), before, 'a second Ctrl+Z took the message back');
  });
  await check('after the fill the quote is protected as in a fresh mount: Delete on the selected block removes it, one Ctrl+Z brings it back', async () => {
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(300), quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(filledJs, 8000));
    assert.ok(await evaluate(MARK));
    await sleep(300);
    await evaluate(`(() => { const ed = window.__shell.editor; let at = -1; ed.state.doc.forEach((n, o) => { if (n.type.name === 'quoteBlock') at = o; }); ed.chain().focus().setNodeSelection(at).run(); return at; })()`);
    await io.press('Delete', 'Delete');
    await sleep(150);
    assert.equal(await evaluate(`window.__shell.editor.getJSON().content.some((n) => n.type === 'quoteBlock')`), false, 'Delete did not remove the selected quote block');
    await io.press('z', 'KeyZ', 2);
    await sleep(150);
    assert.equal(await evaluate(`window.__shell.editor.getJSON().content.some((n) => n.type === 'quoteBlock')`), true, 'Ctrl+Z did not bring the quote back');
  });

  const recoveryItems = () => evaluate(`(async () => { const { api } = await import('/src/api.ts'); const l = await api.recoveryList(); const out = []; for (const i of l) { const s = await api.recoveryLoad(i.id); out.push({ id: i.id, text: JSON.stringify(s?.payload ?? s ?? '').includes('xyz') }); } return out; })()`);
  const clearRecovery = () => evaluate(`(async () => { const { api } = await import('/src/api.ts'); for (const i of await api.recoveryList()) await api.recoveryClear(i.id, 'test'); return 1; })()`);
  await check('drafts and recovery: a shell and an untouched filled reply save nothing, close with no question; after typing the snapshot has the text (AC-13.13.18)', async () => {
    await clearRecovery();
    // (a message that is encrypted "automatically" - a recipient with a key - is never written to the snapshot in clear: Encrypt is off for this check)
    await evaluate(`window.__hlTiming = { autosaveMs: 400, snapshotMs: 300 }; window.__draftSaveCalls = 0; window.__recoverySaves = 0; window.__store.getState().setPrefs({ pgpEncrypt: 'never' }); 1`);
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(2500), quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000));
    await sleep(1800); // (the timers of a real pane look every second)
    assert.deepEqual(await evaluate(`({ saves: window.__recoverySaves || 0, drafts: window.__draftSaveCalls || 0, dirty: window.__store.getState().composeDirty })`), { saves: 0, drafts: 0, dirty: false }, 'the shell saved or marked something');
    assert.ok(await waitFor(filledJs, 12000));
    await sleep(2600);
    assert.deepEqual(await evaluate(`({ saves: window.__recoverySaves || 0, drafts: window.__draftSaveCalls || 0, dirty: window.__store.getState().composeDirty })`), { saves: 0, drafts: 0, dirty: false }, 'an untouched filled reply saved or marked something');
    assert.deepEqual(await recoveryItems(), [], 'a snapshot of an untouched reply');
    await evaluate(`[...document.querySelectorAll('.cp-bar button')].find((b) => b.textContent.trim() === 'Discard').click(); 1`);
    await sleep(500);
    assert.equal(await evaluate(`!!document.querySelector('[role=dialog],[role=alertdialog]')`), false, 'Discard of an untouched reply asked a question');
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false, 'Discard did not close it');
    assert.equal(await evaluate(`window.__draftSaveCalls || 0`), 0, 'a draft was saved');
    // typed: today's question and a snapshot with the text (the autosave is far away: it would replace the snapshot with a draft)
    await evaluate(`window.__hlTiming = { autosaveMs: 600000, snapshotMs: 300 }; 1`);
    await openMessage(IDS.small);
    await delays({ replyHeaders: 50, quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(filledJs, 8000));
    await sleep(300);
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.focus('start'); 1`);
    await io.typeText('xyz', 10);
    assert.ok(await waitFor(`(window.__recoverySaves || 0) >= 1`, 5000), 'no snapshot after typing');
    assert.deepEqual((await recoveryItems()).map((x) => x.text), [true], 'the snapshot does not have the text');
    await evaluate(`[...document.querySelectorAll('.cp-bar button')].find((b) => b.textContent.trim() === 'Discard').click(); 1`);
    await sleep(500);
    assert.equal(await evaluate(`!!document.querySelector('[role=dialog],[role=alertdialog]')`), true, 'Discard of a changed reply did not ask');
    await evaluate(`[...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].find((b) => /Cancel|Keep/.test(b.textContent)).click(); 1`);
    await sleep(300);
    // a kill during preparing: no recovery offer
    await clearRecovery();
    await evaluate(`window.__recoverySaves = 0; 1`);
    await closeCompose();
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(2500), quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000));
    await sleep(1500);
    assert.deepEqual(await recoveryItems(), [], 'a shell left a snapshot behind (a kill now would offer it)');
    await closeCompose();
    await evaluate(`delete window.__hlTiming; window.__store.getState().setPrefs({ pgpEncrypt: 'possible' }); 1`);
  });
  await check('Reply all: the Cc and Bcc rows are in the shell and no row appears at the fill (REQ-13.13.12)', async () => {
    const rows = `(() => { const p = document.querySelector('.compose-pane'); return { fields: [...p.querySelectorAll('.cp-fields .cf-field')].map((f) => f.querySelector('label')?.textContent.trim()), links: !!p.querySelector('.cf-links'), chips: p.querySelectorAll('.cf-field.rcpt .chips > span').length }; })()`;
    await openMessage(IDS.cc);
    await delays({ replyHeaders: slowMs(700), quote: 0 });
    await pressOn('Reply all');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000));
    const shell = await evaluate(rows);
    assert.deepEqual(shell.fields, ['From', 'To', 'Cc', 'Bcc', 'Subject'], `the shell: ${JSON.stringify(shell)}`);
    assert.equal(shell.links, false, 'the shell shows the Cc / Bcc links');
    assert.ok(await waitFor(filledJs, 8000));
    const full = await evaluate(rows);
    assert.deepEqual(full.fields, shell.fields, `a row appeared at the fill: ${JSON.stringify(full)}`);
    assert.equal(full.chips >= 3, true, `the recipients are there: ${JSON.stringify(full)}`);
    // a plain Reply has the Cc / Bcc links, in the shell and after
    await openMessage(IDS.cc);
    await delays({ replyHeaders: slowMs(700), quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000));
    assert.deepEqual((await evaluate(rows)).fields, ['From', 'To', 'Subject']);
    assert.equal((await evaluate(rows)).links, true);
    assert.ok(await waitFor(filledJs, 8000));
    assert.deepEqual((await evaluate(rows)).fields, ['From', 'To', 'Subject']);
  });
  await check('the fill falls back to a fresh Compose when it throws, and says so (REQ-13.13.14)', async () => {
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(600), quote: 0 });
    await evaluate(`window.__warns = []; if (!window.__warnWrapped) { window.__warnWrapped = true; const w = console.warn; console.warn = (...a) => { window.__warns.push(a.join(' ')); w.apply(console, a); }; } 1`);
    await pressOn('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000));
    assert.ok(await evaluate(MARK));
    await evaluate(`window.__shell.editor.chain = () => { throw new Error('boom'); }; 1`); // (the fill cannot be done)
    assert.ok(await waitFor(filledJs, 8000), 'the reply did not open');
    const s = await evaluate(SAME);
    assert.equal(s.pane, false, 'the Compose was not replaced');
    assert.equal(s.key, false, 'the fallback mounts a new Compose (composeKey +1)');
    assert.ok((await evaluate(`window.__warns`)).some((x) => /^\[reply\] fill: fallback boom$/.test(x)), `not logged: ${await evaluate(`JSON.stringify(window.__warns)`)}`);
    const f = await shellFacts();
    assert.ok(!f.preparing && f.quote && f.chips >= 1 && !f.sendDisabled, JSON.stringify(f));
  });
  await check('a second Reply on the same message while it prepares only brings the shell forward (REQ-13.13.7)', async () => {
    await openMessage(IDS.small);
    await delays({ replyHeaders: slowMs(900), quote: 0 });
    await pressOn('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing')`, 3000));
    assert.ok(await evaluate(MARK));
    const calls = await evaluate(`window.__replyHeaderCalls.length`);
    await evaluate(`document.activeElement?.blur?.(); 1`);
    await pressOn('Reply');
    await sleep(200);
    assert.equal(await evaluate(`window.__replyHeaderCalls.length`), calls, 'the second press started a preparation');
    assert.equal(await evaluate(`window.__store.getState().composeKey === window.__shell.key`), true, 'the second press opened another compose');
    assert.ok(await waitFor(filledJs, 8000));
    assert.deepEqual(await evaluate(SAME), ALL_SAME);
  });

  // ---- the same rows in the compose window (AC-13.13.19)
  const WIN_FULL = { accountId: 'a1', to: ['linh.tran@acme.example'], subject: 'Re: Q4 roadmap review', isReply: true, afterShell: true, inReplyTo: '<m1@acme.example>', bodyHtml: '<br><div class="hl-quote"><div>On Mon, Linh wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex"><p>Could you review the milestones?</p></blockquote></div>' };
  const winShell = async () => {
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=prepare#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.popout-compose .compose-pane.preparing')`, 20000), 'no shell in the window');
    assert.ok(await waitFor(`(window.__popoutRequests || []).some((r) => r.kind === 'cw-fill-ready')`, 5000), 'the window did not ask for its message');
    assert.ok(await evaluate(MARK), 'the shell of the window has no instance marker / editor / view');
  };
  const winFill = () => evaluate(`window.__mockEmit('popout-reply', { id: 'shell-fill', ok: true, data: ${JSON.stringify(WIN_FULL)}, error: null }); 1`);
  await check('in place (compose window): the Compose and its editor are the same objects after the hand-over; Ctrl+Z changes nothing; the shell saves nothing (AC-13.13.19)', async () => {
    await winShell();
    await evaluate(`window.__hlTiming = { autosaveMs: 400, snapshotMs: 300 }; window.__draftSaveCalls = 0; window.__recoverySaves = 0; 1`);
    await sleep(1600);
    assert.deepEqual(await evaluate(`({ saves: window.__recoverySaves || 0, drafts: window.__draftSaveCalls || 0 })`), { saves: 0, drafts: 0 }, 'the shell of the window saved something');
    await winFill();
    assert.ok(await waitFor(filledJs, 8000), 'the window did not fill');
    const s = await evaluate(SAME);
    assert.deepEqual(s, ALL_SAME, JSON.stringify(s));
    await sleep(300);
    const before = await editorDoc();
    assert.equal(await canUndo(), false, 'the fill is in the undo history');
    assert.ok(await waitFor(`document.activeElement?.closest?.('.cp-editor') !== null`, 2000), 'the caret is not in the body');
    await io.press('z', 'KeyZ', 2);
    await sleep(150);
    assert.equal(await editorDoc(), before, 'Ctrl+Z changed the message');
    await io.typeText('abc', 10);
    await sleep(100);
    await io.press('z', 'KeyZ', 2);
    await sleep(150);
    assert.equal(await editorDoc(), before, 'Ctrl+Z did not remove just the typing');
    await sleep(2200);
    assert.deepEqual(await evaluate(`({ saves: window.__recoverySaves || 0, drafts: window.__draftSaveCalls || 0 })`), { saves: 0, drafts: 0 }, 'an untouched reply in the window saved something');
  });
  await check('in place (compose window): the fill falls back to a fresh Compose when it throws (REQ-13.13.14)', async () => {
    await winShell();
    await evaluate(`window.__warns = []; const w = console.warn; console.warn = (...a) => { window.__warns.push(a.join(' ')); w.apply(console, a); }; window.__shell.editor.chain = () => { throw new Error('boom'); }; 1`);
    await winFill();
    assert.ok(await waitFor(filledJs, 8000), 'the window did not open the reply');
    const s = await evaluate(SAME);
    assert.equal(s.pane, false, 'the Compose was not replaced');
    assert.ok((await evaluate(`window.__warns`)).some((x) => /^\[reply\] fill: fallback boom$/.test(x)), 'not logged');
    assert.equal(await evaluate(`document.querySelectorAll('.cf-field.rcpt .chips > span').length`), 1, 'the recipient');
  });

  // ---- 8 languages x 2 sizes x light / dark: the texts, not clipped
  for (const lang of Object.keys(TEXTS)) {
    await check(`texts and fit in ${lang}`, async () => {
      for (const [w, h] of [[960, 560], [1280, 800]]) {
        await boot(`lang=${lang}`, w, h);
        for (const [theme, kind, button] of [['light', 0, 'reply'], ['dark', 1, 'forward']]) {
          await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); 1`);
          await closeCompose();
          await evaluate(`window.__store.getState().select(${JSON.stringify(kind ? IDS.small : IDS.big)}); 1`);
          assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open button')`, 20000));
          await delays({ replyHeaders: Math.round(1500 + 1500 * scale) });
          await sleep(300);
          // the first button of the message actions: Reply (icon button) or the third (Forward)
          await evaluate(`(() => { const b = [...document.querySelectorAll('.rp-msg.open .rp-msg-actions .icon-btn')]; b[${kind ? 2 : 0}].click(); })()`);
          assert.ok(await waitFor(`!!document.querySelector('.compose-pane.preparing .cp-prep [role=status]')`, 3000), `${lang} ${w}x${h} ${theme}: no status`);
          const s = await evaluate(`(() => { const e = document.querySelector('.cp-prep [role=status] p'); const r = e.getBoundingClientRect(); const pane = document.querySelector('.cp-editor').getBoundingClientRect(); return { text: e.textContent.trim(), clipped: e.scrollWidth > e.clientWidth + 1, inside: r.left >= pane.left - 1 && r.right <= pane.right + 1 && r.top >= pane.top - 1 && r.bottom <= pane.bottom + 1, raw: /compose\\.preparing/.test(e.textContent), font: getComputedStyle(e).fontFamily, color: getComputedStyle(e).color }; })()`);
          assert.equal(s.text, TEXTS[lang][kind], `${lang}: the text`);
          assert.ok(!s.clipped && s.inside && !s.raw, `${lang} ${w}x${h} ${theme}: ${JSON.stringify(s)}`);
          void button;
        }
      }
    });
  }

  // ---- reduced motion: the dots instead of the ring
  await check('reduced motion: dots, not the ring', async () => {
    await boot('lang=en', 1280, 800);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await openMessage(IDS.big);
    await delays({ replyHeaders: Math.round(1500 + 1500 * scale) });
    await install();
    await press('Reply');
    assert.ok(await waitFor(`!!document.querySelector('.cp-prep [role=status]')`, 3000));
    const m = await evaluate(`({ ring: getComputedStyle(document.querySelector('.cp-prep .busy-ring')).display, dots: getComputedStyle(document.querySelector('.cp-prep .busy-dots')).display })`);
    assert.equal(m.ring, 'none', 'the ring is hidden');
    assert.notEqual(m.dots, 'none', 'the dots show');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  });
} finally {
  await H.shutdown();
}

if (failures.length) {
  console.error(`test-reply-feedback: ${failures.length} failure(s)\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log('test-reply-feedback: ok');
