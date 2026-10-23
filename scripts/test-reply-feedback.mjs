#!/usr/bin/env node
// 1.0.7 W13.13 / D-064: Reply, Reply all and Forward of a long mail open at once. Real list, pane and compose in the dev preview (src/devMock.ts: `window.__mockDelays` stand in for the
// server: replyHeaders = the round trip of the headers, quote = one picture, quoteFirst = the download of the raw message; the fixtures are scripts/lib/reply-fixtures.mjs). Checked:
//   - the compose shell is on screen within one frame of the press (the pane's budget is 200 ms on a release build; this dev build is allowed 300), with the header rows in place,
//     the From / To / Cc / Subject fields and the formatting row off, Send disabled, Discard on, and the status "Preparing reply…" (role=status, aria-busy) by 200 ms;
//   - the message fills in when the slow steps are done: after the longest of them, not after their sum (headers and pictures side by side); the To field's box is the same +- 1 px;
//     the status is gone, Send is on, the quote is in the editor; a quick open (no delay) never shows the status;
//   - Discard and Esc while it prepares end it: no draft is saved, no toast, and the result that arrives later does not open again;
//   - the same answer pressed again (a window of its own) starts nothing new; the window gets the shell with `preparing` at once and the finished message when it asks for it;
//   - a server that fails: the answer to From, no stuck status; Forward with attachments says "Getting the attachments…" and has no separate toast, the 3 files come along;
//   - the compose window (?w=compose): the shell, then the message handed over by the main window; the status stays 300 ms once shown;
//   - the two texts in the 8 languages at 960 x 560 and 1280 x 800, light and dark, not clipped; reduced motion shows the dots instead of the ring.
//   node scripts/test-reply-feedback.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';
import { PROBE_INSTALL, PROBE_PRESS, PROBE_READ, fill } from './lib/reply-open-probe.mjs';

const H = await startHarness('test-reply-feedback', { vitePort0: 5995 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(30); } return false; };
const fn = (body) => `(() => { ${body} })()`;
const SHELL_MS = 300; // (the budget of the pane is 200 ms on a release build, REQ-13.13.1; the dev preview builds Compose unoptimised)

const TEXTS = {
  en: ['Preparing reply…', 'Preparing forward…'], vi: ['Đang chuẩn bị thư trả lời…', 'Đang chuẩn bị thư chuyển tiếp…'], fr: ['Préparation de la réponse…', 'Préparation du transfert…'],
  'zh-Hans': ['正在准备回复…', '正在准备转发…'], es: ['Preparando la respuesta…', 'Preparando el reenvío…'], ja: ['返信を準備しています…', '転送を準備しています…'],
  de: ['Antwort wird vorbereitet…', 'Weiterleitung wird vorbereitet…'], ru: ['Подготовка ответа…', 'Подготовка пересылки…'],
};

const delays = (d) => evaluate(`window.__mockDelays = ${JSON.stringify(d)}; window.__attachmentCalls = []; window.__replyHeaderCalls = []; 1`);
const closeCompose = async () => { await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`); await sleep(150); };
async function openMessage(id) {
  await closeCompose();
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
const toasts = () => evaluate(`window.__store.getState().toasts.map((t) => t.text ?? '')`);

try {
  await boot('lang=en', 1280, 800);

  // ---- the 2 MB mail, headers 3 s: shell at once, fill after the longest step
  await check('F-huge: the shell at once, the status by 200 ms, the fill after the longest step (not the sum)', async () => {
    await openMessage(IDS.huge);
    await delays({ replyHeaders: 3000, quoteFirst: 800, quote: 20 });
    await install();
    assert.ok((await press('Reply')).pressed);
    await sleep(SHELL_MS - 100);
    const early = await read();
    assert.ok(early.shellMs !== null && early.shellMs <= SHELL_MS, `the shell took ${early.shellMs} ms`);
    assert.ok(early.pressMs !== null && early.pressMs <= SHELL_MS, `the first frame after the press came at ${early.pressMs} ms`);
    await sleep(200);
    const f = await shellFacts();
    assert.ok(f.preparing && f.fieldsInert && f.fmtInert && f.sendDisabled && f.discardOn && f.barOff, `the shell is not off where it should be: ${JSON.stringify(f)}`);
    assert.equal(f.subject, 'Re: Fixture huge 2 MB');
    assert.deepEqual(f.status, { text: 'Preparing reply…', busy: 'true' }, 'the status');
    assert.ok(f.focusOnBody, 'the focus is on the body of the shell (Esc and Tab work from there)');
    const st = (await read()).statusMs;
    assert.ok(st !== null && st <= SHELL_MS, `the status came at ${st} ms`); // (200 ms on a release build, REQ-13.13.1)
    assert.equal(f.quote, false);
    assert.equal(await evaluate(`window.__replyHeaderCalls.length`), 1, 'the headers were asked for once, at once');
    assert.ok(await waitFor(`window.__replyOpen.filled !== null`, 12000), 'the message never filled in');
    const r = await read();
    // the longest step is the headers (3 s); the old code added the pictures (0.8 s + 40 x 20 ms) and the quote after it
    assert.ok(r.filledMs >= 2900 && r.filledMs <= 3000 + 1100, `filled at ${r.filledMs} ms (the headers take 3000)`);
    assert.ok(r.statusGoneMs !== null && r.statusGoneMs >= r.statusMs + 300, `the status stayed ${r.statusGoneMs - r.statusMs} ms`);
    assert.ok(r.toMovedPx !== null && r.toMovedPx <= 1, `the To field moved ${r.toMovedPx} px`);
    const after = await shellFacts();
    assert.ok(!after.preparing && !after.fieldsInert && !after.sendDisabled && after.quote && after.chips >= 1 && !after.status, `the filled compose: ${JSON.stringify(after)}`);
    assert.equal(await evaluate(`document.activeElement?.closest?.('.cp-editor') ? 'editor' : document.activeElement?.tagName`), 'editor', 'the caret goes to the body as it does today');
    assert.equal(await evaluate(`(window.__attachmentCalls || []).length`), 40, 'all 40 pictures were fetched');
    assert.deepEqual(await toasts(), [], 'no toast');
  });

  // ---- a quick open: no status, complete in 300 ms
  await check('F-small, nothing slow: the compose is complete within 400 ms and the status never shows', async () => {
    await openMessage(IDS.small);
    await delays({});
    await install();
    await press('Reply');
    assert.ok(await waitFor(`window.__replyOpen.filled !== null`, 5000));
    await sleep(400);
    const r = await read();
    assert.equal(r.statusMs, null, `the status flashed: ${JSON.stringify(r)}`);
    assert.ok(r.filledMs <= 400, `complete at ${r.filledMs} ms`);
    assert.ok(r.toMovedPx <= 1);
  });

  // ---- Discard while it prepares
  await check('Discard while preparing: no draft, no toast, the late result does not open it again', async () => {
    await openMessage(IDS.big);
    await delays({ replyHeaders: 1500, quote: 0 });
    await evaluate(`window.__draftSaveCalls = 0; 1`);
    await press('Reply');
    await sleep(350);
    assert.ok((await shellFacts()).preparing, 'no shell');
    await evaluate(`document.querySelector('.compose-pane .cp-bar .cp-keep').click(); 1`);
    await sleep(300);
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false, 'Discard did not end the shell');
    await sleep(2000); // (the headers come back)
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane') || !!window.__store.getState().compose`), false, 'the result opened it again');
    assert.equal(await evaluate(`window.__draftSaveCalls || 0`), 0, 'a draft was saved');
    assert.deepEqual(await toasts(), [], 'a toast');
    assert.equal(await evaluate(`!!document.querySelector('.rp-msg.open')`), true, 'the reading pane is back');
  });
  await check('Esc while preparing ends it the same way', async () => {
    await openMessage(IDS.big);
    await delays({ replyHeaders: 1200, quote: 0 });
    await press('Reply');
    await sleep(350);
    assert.ok((await shellFacts()).focusOnBody, 'the focus is not on the shell body');
    await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    assert.equal(await evaluate(`!!document.querySelector('.compose-pane')`), false, 'Esc did not end the shell');
    await sleep(1500);
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
    await delays({ replyHeaders: 800, quote: 700 });
    await install();
    await press('Forward');
    await sleep(350);
    const f = await shellFacts();
    assert.deepEqual(f.status, { text: 'Getting the attachments…', busy: 'true' });
    assert.equal(f.subject, 'Fwd: Fixture three attachments');
    assert.deepEqual(await toasts(), [], 'the old 700 ms toast is back');
    assert.ok(await waitFor(`window.__replyOpen.filled !== null`, 10000));
    assert.equal(await evaluate(`document.querySelectorAll('.compose-pane .atts .att-chip').length`), 3, 'the three attachments');
    assert.deepEqual(await toasts(), []);
    // the three fetches ran side by side (3 x 700 ms would be 2.1 s after the headers)
    const r = await read();
    assert.ok(r.filledMs < 1900, `Forward took ${r.filledMs} ms`);
  });
  await check('Forward without attachments: "Preparing forward…"', async () => {
    await openMessage(IDS.small);
    await delays({ replyHeaders: 800 });
    await press('Forward');
    await sleep(400);
    assert.deepEqual((await shellFacts()).status, { text: 'Preparing forward…', busy: 'true' });
    assert.ok(await waitFor(`!document.querySelector('.compose-pane.preparing') && !!document.querySelector('.compose-pane .quote-block')`, 6000));
  });

  // ---- a window of its own
  await check('window mode: the shell is asked for at once, the button is busy, a second press starts nothing, the message is handed over when the window asks', async () => {
    await openMessage(IDS.huge);
    await evaluate(`window.__store.getState().setPrefs({ popoutCompose: true }); window.__popoutOpened = []; window.__popoutReplies = []; window.__popoutKeys = new Set(); 1`);
    await delays({ replyHeaders: 1500, quoteFirst: 300, quote: 10 });
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
          await delays({ replyHeaders: 1500 });
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
    await delays({ replyHeaders: 1500 });
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
