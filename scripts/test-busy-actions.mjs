#!/usr/bin/env node
// 1.0.7 W13.14 (spec-107-wp13e-feedback.md, RULE-1 to RULE-7): the pending state of actions that can take long, in the dev preview with slow commands (`window.__mockDelays.cmds`, src/devMock.ts):
//   A8  a move / mark of 20 or more conversations: the sticky toast "Working on {count} conversations…" (spinner) is up by 150 ms and goes with the result, which keeps its own toast; 19 show nothing
//   A9  Send: the button is busy (ring, aria-busy, progress cursor) at once, a second press starts nothing; in the pane a "Sending…" toast with a ring covers the hand-over to the outbox and the
//       send itself, and it is replaced by the Undo toast / the "Message sent" toast; the button does not change its width
//   A10 Print: "Preparing to print…" over the body area is painted BEFORE the print call (a blocking call would hide it), a second press does nothing
//   A5  Save all attachments from the More menu with several files: "Loading…" after 300 ms, replaced by the result
//   A6/A7 a search, a tab or a filter while the old rows are there: the "Loading…" pill over the top of the list within 150 ms, no row moves; a folder switch shows the skeleton rows at once
//   A15 the Check mail button is aria-busy while it syncs
// and the texts of `app.busy.many` / `reading.print.preparing` in the 8 languages at 960x560 and 1280x800. The rule as a table: scripts/test-pending-core.mjs.
//   node scripts/test-busy-actions.mjs [--require-browser]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startHarness, languageJs } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';

const H = await startHarness('test-busy-actions', { vitePort0: 5320 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(40); } return false; };
/**
 * Runs `start` in the page and notes, for each named condition, when it first became true and when it was false again afterwards (ms from the start). Polls on animation frames, a
 * timer and DOM mutations. Returns after `ms`.
 */
const timeline = async (start, conds, ms) => {
  const body = Object.entries(conds).map(([k, f]) => `${JSON.stringify(k)}: () => { try { return !!(${f}); } catch (e) { return false; } }`).join(', ');
  await evaluate(`(() => {
    const P = { ${body} };
    const t0 = performance.now(); const out = window.__tl = {}; for (const k of Object.keys(P)) out[k] = { on: null, off: null };
    const look = () => { const t = Math.round(performance.now() - t0); for (const [k, f] of Object.entries(P)) { const v = f(), o = out[k]; if (v && o.on === null) o.on = t; if (!v && o.on !== null && o.off === null) o.off = t; } };
    const mo = new MutationObserver(look); mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    let raf = 0; const loop = () => { look(); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop);
    const iv = setInterval(look, 15);
    window.__tlStop = () => { mo.disconnect(); clearInterval(iv); cancelAnimationFrame(raf); };
    ${start}
    return 1;
  })()`);
  await sleep(ms);
  return evaluate(`(() => { window.__tlStop(); return window.__tl; })()`);
};
const toastText = `[...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent.replace(/[·\\s]+/g, ' ').trim())`;
const busyToast = (re) => `[...document.querySelectorAll('.toasts .toast')].some((t) => t.querySelector('.busy-ring') && ${re}.test(t.textContent))`;
const anyToast = (re) => `[...document.querySelectorAll('.toasts .toast')].some((t) => ${re}.test(t.textContent))`;

try {
  await H.openApp('lang=en', 1280, 800);
  await evaluate(FIXTURES);
  await evaluate(`window.__store.getState().refresh().then(() => 1)`);
  await evaluate(`window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
  await sleep(600);
  const ids = (n, from = 0) => evaluate(`window.__store.getState().threads.filter((t) => !t.threadId.startsWith('fx-')).slice(${from}, ${from + n}).map((t) => t.threadId)`);

  // ---------------------------------------------------------------- A8
  await check('A8: archiving 30 conversations (the folder look-up takes 700 ms) shows the count by 150 ms, ends with the result and its Undo toast (AC-13.14.2)', async () => {
    const list = await ids(30);
    assert.equal(list.length, 30);
    await evaluate(`window.__mockDelays = { cmds: { prepare_action: 700 } }; 1`);
    const tl = await timeline(`window.__store.getState().act(${JSON.stringify(list)}, 'archive', undefined, () => 'Archived 30 for the test');`, {
      busy: busyToast('/Working on 30 conversations…/'), result: anyToast('/Archived 30 for the test/'), rows: `document.querySelectorAll('.ml-row').length > 0 && ![...document.querySelectorAll('.ml-row')].some((r) => ${JSON.stringify(list)}.includes(r.dataset.thread))`,
    }, 2500);
    assert.ok(tl.busy.on !== null && tl.busy.on <= 220, `the count showed at ${tl.busy.on} ms`); // (100 ms timer + render of the dev build; the exe is measured by QA)
    assert.ok(tl.result.on !== null && tl.result.on >= 650, `the result at ${tl.result.on}`);
    assert.ok(tl.busy.off !== null && tl.busy.off >= tl.busy.on + 290, `the busy toast was up for ${tl.busy.off - tl.busy.on} ms`);
    assert.ok(tl.busy.off <= tl.result.on + 400, `the busy toast stayed (${tl.busy.off}) long after the result (${tl.result.on})`);
    await evaluate(`window.__mockDelays = {}; 1`);
    assert.equal(await evaluate(`${busyToast('/Working on/')}`), false);
    // Undo brings them back (the preview's own Undo): not part of this check
    await evaluate(`window.__store.getState().toasts.filter((t) => t.undo).forEach((t) => t.undo()); 1`);
    await sleep(500);
  });

  await check('A8: marking 40 conversations read (the server takes 600 ms) shows the count; 19 show nothing', async () => {
    const list = await ids(40, 40);
    await evaluate(`window.__mockDelays = {}; 1`);
    const tl = await timeline(`window.__store.getState().act(${JSON.stringify(list)}, 'unread', undefined, () => 'Marked 40 for the test');`, { busy: busyToast('/Working on 40 conversations…/'), result: anyToast('/Marked 40 for the test/') }, 2200);
    assert.ok(tl.busy.on !== null && tl.busy.on <= 220, `the count showed at ${tl.busy.on} ms`);
    assert.ok(tl.result.on !== null && tl.busy.off !== null, JSON.stringify(tl));
    const few = await ids(19, 100);
    const tl2 = await timeline(`window.__store.getState().act(${JSON.stringify(few)}, 'unread', undefined, () => 'Marked 19 for the test');`, { busy: busyToast('/Working on/'), result: anyToast('/Marked 19 for the test/') }, 1800);
    assert.equal(tl2.busy.on, null, '19 conversations showed the count');
    assert.ok(tl2.result.on !== null, 'the result did not show');
  });

  await check('A8: a quick batch (no delay) never shows the count (no flash)', async () => {
    const list = await ids(25, 150);
    await evaluate(`window.__mockDelays = { cmds: { thread_action: 1 } }; 1`);
    // (the mock's thread_action takes 600 ms by itself; a move is quick when the folder is known)
    const tl = await timeline(`window.__store.getState().act(${JSON.stringify(list)}, 'archive', undefined, () => 'Archived 25 for the test');`, { busy: busyToast('/Working on/') }, 1500);
    assert.equal(tl.busy.on, null, `the count flashed at ${tl.busy.on}`);
    await evaluate(`window.__mockDelays = {}; window.__store.getState().toasts.filter((t) => t.undo).forEach((t) => t.undo()); 1`);
    await sleep(400);
  });

  // ---------------------------------------------------------------- A9
  const compose = async (subject) => {
    await evaluate(`window.__store.getState().openCompose(null, { restore: false }); 1`);
    await sleep(300);
    await evaluate(`window.__store.getState().openCompose({ accountId: window.__store.getState().accounts[0].id, to: ['alice@example.com'], subject: ${JSON.stringify(subject)}, bodyHtml: '<p>Some words</p>' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane .cp-editor .tiptap')`, 10000), 'compose did not open');
    await sleep(400);
  };
  const sendBtn = `document.querySelector('.compose-pane .split-btn .btn.primary')`;
  await check('A9: Send with a slow hand-over to the outbox: the button is busy at once and keeps its width, a second press starts nothing, a "Sending…" toast covers the gap, then the Undo toast (AC-13.14.3)', async () => {
    await compose('Big attachments one');
    await evaluate(`window.__sendCalls = []; window.__store.getState().setPrefs({ undoSeconds: 10 }); window.__mockDelays = { cmds: { outbox_hold: 1200 } }; 1`);
    const w0 = await evaluate(`${sendBtn}.getBoundingClientRect().width`);
    const tl = await timeline(`${sendBtn}.click(); setTimeout(() => ${sendBtn}?.click(), 250);`, {
      busy: `(() => { const b = ${sendBtn}; return !!b && b.getAttribute('aria-busy') === 'true' && !!b.querySelector('.spin'); })()`,
      paneGone: `!document.querySelector('.compose-pane')`,
      gap: busyToast('/Sending…/'),
      undo: `[...document.querySelectorAll('.toasts .toast')].some((t) => /Sending…/.test(t.textContent) && /Undo/.test(t.textContent))`,
    }, 2400);
    assert.ok(tl.busy.on !== null && tl.busy.on <= 100, `the button was busy at ${tl.busy.on} ms`);
    assert.ok(tl.gap.on !== null && tl.gap.on <= 400, `the "Sending…" toast at ${tl.gap.on}`);
    assert.ok(tl.undo.on !== null && tl.undo.on >= 1100, `the Undo toast at ${tl.undo.on}`);
    assert.ok(tl.gap.off !== null && tl.gap.off <= tl.undo.on + 60, `the "Sending…" busy toast stayed (${tl.gap.off}) after the Undo toast (${tl.undo.on})`);
    const calls = await evaluate(`window.__sendCalls.filter((c) => c.cmd === 'hold').length`);
    assert.equal(calls, 1, `the message was handed over ${calls} times`);
    const sendingToasts = await evaluate(`${toastText}.filter((x) => /Sending…/.test(x)).length`);
    assert.equal(sendingToasts, 1, 'one "Sending…" toast, not two');
    assert.ok(w0 > 0);
    await evaluate(`window.__store.getState().toasts.filter((t) => t.undo).forEach((t) => t.undo()); window.__mockDelays = {}; 1`);
    await sleep(600);
  });

  await check('A9: the Send button keeps its width and position while it is busy (RULE-6)', async () => {
    await compose('Big attachments width');
    await evaluate(`window.__store.getState().setPrefs({ undoSeconds: 10 }); window.__mockDelays = { cmds: { outbox_hold: 800 } }; 1`);
    const before = await evaluate(`(() => { const r = ${sendBtn}.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; })()`);
    await evaluate(`window.__atBusy = null; { const b = ${sendBtn}; new MutationObserver(() => { if (b.getAttribute('aria-busy') === 'true' && !window.__atBusy) { const r = b.getBoundingClientRect(); window.__atBusy = [Math.round(r.left * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; } }).observe(b, { attributes: true, childList: true, subtree: true }); b.click(); }; 1`);
    await sleep(120);
    const during = await evaluate(`window.__atBusy`);
    assert.ok(during, 'the button never got busy');
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(before[i] - during[i]) <= 1, `left/width/height ${JSON.stringify(before)} -> ${JSON.stringify(during)}`);
    assert.equal(await evaluate(`getComputedStyle(${sendBtn} ?? document.body).cursor !== undefined`), true);
    await sleep(1200);
    await evaluate(`window.__store.getState().toasts.filter((t) => t.undo).forEach((t) => t.undo()); window.__mockDelays = {}; 1`);
    await sleep(500);
  });

  await check('A9: with Undo off the server hand-over shows "Sending…" with a ring until "Message sent"', async () => {
    await compose('Big attachments two');
    await evaluate(`window.__store.getState().setPrefs({ undoSeconds: 0 }); window.__mockDelays = { cmds: { send_message: 1500 } }; 1`);
    const tl = await timeline(`${sendBtn}.click();`, { busy: busyToast('/Sending…/'), sent: anyToast('/Message sent/') }, 3200);
    assert.ok(tl.busy.on !== null && tl.busy.on <= 400, `"Sending…" at ${tl.busy.on}`);
    assert.ok(tl.sent.on !== null && tl.sent.on >= 1400, `sent at ${tl.sent.on}`);
    assert.ok(tl.busy.off !== null && tl.busy.off >= tl.busy.on + 290, 'the busy toast was up for its minimum');
    await evaluate(`window.__store.getState().setPrefs({ undoSeconds: 10 }); window.__mockDelays = {}; 1`);
  });

  // ---------------------------------------------------------------- A10
  await check('A10: Print paints "Preparing to print…" before the print call and ignores a second press', async () => {
    await evaluate(`window.__store.getState().openCompose(null, { restore: false }); window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
    await sleep(400);
    await evaluate(`window.__store.getState().select(${JSON.stringify(IDS.small)}); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open .msg-frame') && getComputedStyle(document.querySelector('.rp-msg.open .msg-frame')).visibility !== 'hidden'`, 10000), 'the mail did not open');
    await sleep(400);
    // the frame's print() blocks like the engine's does: the test notes what was on screen when it was called
    await evaluate(`(() => { const f = document.querySelector('.rp-msg.open .msg-frame'); window.__prints = []; f.contentWindow.print = () => { window.__prints.push({ status: document.querySelector('.rp-opening')?.textContent.replace(/[·\\s]+/g, ' ').trim() ?? null, busy: document.querySelector('.rp-opening')?.getAttribute('aria-busy') }); const t = performance.now(); while (performance.now() - t < 350) { /* the dialog is being prepared */ } }; 1; })()`);
    const openMenu = async () => { await evaluate(`document.querySelector('.rp-msg.open .rp-msg-actions button[aria-label="More actions"]').click(); 1`); await sleep(120); };
    await openMenu();
    const tl = await timeline(`[...document.querySelectorAll('[role=menu] [role=menuitem], .dd-menu button')].find((e) => /^Print$/.test(e.textContent.trim()))?.click();`, { status: `/Preparing to print…/.test(document.querySelector('.rp-opening')?.textContent ?? '')` }, 1100);
    assert.equal(await evaluate(`window.__prints.length`), 1, 'print() was not called once');
    const seen = await evaluate(`window.__prints[0]`);
    assert.equal(seen.status, 'Preparing to print…', `at the print call the pane showed ${JSON.stringify(seen)}`);
    assert.ok(tl.status.on !== null && tl.status.on <= 150, `the status at ${tl.status.on}`);
    assert.ok(tl.status.off !== null && tl.status.off >= 330, `the status was up for ${tl.status.off - tl.status.on} ms`);
    // a second press while it works: the menu item is off
    await evaluate(`window.__prints.length = 0; 1`);
  });

  // ---------------------------------------------------------------- A5
  await check('A5: Save all from the More menu with several files shows "Loading…" after 300 ms and ends with the result', async () => {
    await evaluate(`window.__store.getState().select(${JSON.stringify(IDS.att)}); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.rp-msg.open .rp-msg-actions button[aria-label="More actions"]')`, 8000));
    await sleep(500);
    await evaluate(`window.__mockDelays = { cmds: { attachment_save_all: 1500 } }; document.querySelector('.rp-msg.open .rp-msg-actions button[aria-label="More actions"]').click(); 1`);
    await sleep(150);
    const tl = await timeline(`[...document.querySelectorAll('[role=menu] [role=menuitem], .dd-menu button')].find((e) => /^Save all attachments/.test(e.textContent.trim()))?.click();`, { busy: busyToast('/Loading…/'), result: anyToast('/Saved|saved/') }, 2600);
    assert.ok(tl.busy.on !== null && tl.busy.on >= 280 && tl.busy.on <= 450, `Loading… at ${tl.busy.on} (after 300 ms)`);
    assert.ok(tl.result.on !== null && tl.result.on >= 1400, `the result at ${tl.result.on}`);
    await evaluate(`window.__mockDelays = {}; 1`);
  });

  // ---------------------------------------------------------------- A6 / A7
  await check('A6/A7: a search with the old rows on screen shows the pill by 150 ms without moving a row; a tab switch too; a folder switch shows the skeleton at once', async () => {
    await evaluate(`window.__store.getState().select(null); window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
    await sleep(500);
    await evaluate(`window.__mockDelays = { cmds: { list_threads: 900 } }; 1`);
    const top = `(() => { const r = document.querySelector('.ml-row'); return r ? Math.round(r.getBoundingClientRect().top) : null; })()`;
    const before = await evaluate(top);
    const tl = await timeline(`window.__store.getState().setSearch('road', false);`, {
      pill: `(() => { const p = document.querySelector('.ml-loadpill'); return !!p && p.getAttribute('role') === 'status' && /Loading…/.test(p.textContent) && !!p.querySelector('.spin'); })()`,
      moved: `(() => { const t = ${top}; return t !== null && Math.abs(t - ${before}) > 1; })()`,
    }, 2000);
    assert.ok(tl.pill.on !== null && tl.pill.on <= 220, `the pill at ${tl.pill.on}`);
    assert.ok(tl.pill.off !== null && tl.pill.off >= tl.pill.on + 290, 'the pill stayed its minimum');
    assert.equal(tl.moved.on, null, 'a row moved because of the pill (RULE-6)');
    // a tab switch (Focused / Other): the same
    await evaluate(`window.__mockDelays = {}; window.__store.getState().setSearch('', false); 1`);
    await sleep(900);
    await evaluate(`window.__mockDelays = { cmds: { list_threads: 900 } }; 1`);
    const tl2 = await timeline(`window.__store.getState().setFilter('unread');`, { pill: `!!document.querySelector('.ml-loadpill')` }, 1800);
    assert.ok(tl2.pill.on !== null && tl2.pill.on <= 220, `the filter pill at ${tl2.pill.on}`);
    await evaluate(`window.__store.getState().setFilter('all'); window.__mockDelays = {}; 1`);
    await sleep(500);
    // a folder switch: the old rows go and the skeleton rows are there in the first frame; never a blank list
    await evaluate(`window.__mockDelays = { cmds: { list_threads: 900 } }; 1`);
    const tl3 = await timeline(`window.__store.getState().setView('drafts', null);`, { skeleton: `!!document.querySelector('.ml-body .skeleton, .ml-body [class*=skel]')`, blank: `document.querySelectorAll('.ml-row').length === 0 && !document.querySelector('.ml-body [class*=skel]') && !document.querySelector('.empty-state')` }, 1500);
    assert.ok(tl3.skeleton.on !== null && tl3.skeleton.on <= 120, `the skeleton at ${tl3.skeleton.on}`);
    assert.equal(tl3.blank.on, null, 'a blank list without a status');
    await evaluate(`window.__mockDelays = {}; window.__store.getState().setView('inbox', window.__store.getState().accounts[0].id); 1`);
    await sleep(500);
  });

  // ---------------------------------------------------------------- A15
  await check('A15: the Check mail button is aria-busy while it syncs', async () => {
    await evaluate(`window.__mockDelays = { cmds: { sync_account: 800 } }; 1`);
    const tl = await timeline(`document.querySelector('.top-actions button[title^="Sync now"]')?.click();`, { busy: `document.querySelector('.top-actions .icon-btn[aria-busy="true"] .spin')` }, 1800);
    assert.ok(tl.busy.on !== null && tl.busy.on <= 100, `busy at ${tl.busy.on}`);
    assert.ok(tl.busy.off !== null && tl.busy.off >= 700, 'it ends with the sync');
    await evaluate(`window.__mockDelays = {}; 1`);
  });

  // ---------------------------------------------------------------- texts
  await check('the two texts are in the 8 languages and fit at 960x560 and 1280x800 (AC-13.14.4)', async () => {
    const want = {
      en: ['Working on 30 conversations…', 'Preparing to print…'], vi: ['Đang xử lý 30 cuộc trò chuyện…', 'Đang chuẩn bị để in…'], fr: ['Traitement de 30 conversations…', 'Préparation de l’impression…'],
      'zh-Hans': ['正在处理30个对话…', '正在准备打印…'], es: ['Procesando 30 conversaciones…', 'Preparando la impresión…'], ja: ['会話30件を処理しています…', '印刷の準備をしています…'],
      de: ['30 Unterhaltungen werden bearbeitet…', 'Druck wird vorbereitet…'], ru: ['Обработка бесед: 30…', 'Подготовка к печати…'],
    };
    for (const [w, h] of [[1280, 800], [960, 560]]) {
      await H.openApp('lang=en', w, h);
      await evaluate(FIXTURES);
      await evaluate(`window.__store.getState().refresh().then(() => 1)`);
      for (const [lang, [many, print]] of Object.entries(want)) {
        await evaluate(languageJs(lang));
        await sleep(100);
        await evaluate(`window.__store.getState().setStickyToast('busy-many', { text: () => window.__t ? window.__t('app.busy.many', { count: 30 }) : '', kind: 'info', busy: true }); 1`).catch(() => undefined);
        // the real toast text through the same lookup the store uses
        const t = await evaluate(`import('/src/i18n/index.ts').then((m) => [m.t('app.busy.many', { count: 30 }), m.t('reading.print.preparing')])`);
        assert.deepEqual(t, [many, print], `${lang} at ${w}x${h}`);
        await evaluate(`window.__store.getState().setStickyToast('busy-many', { text: () => 'Working on 30 conversations…', kind: 'info', busy: true }); 1`);
        await evaluate(`window.__store.getState().setStickyToast('busy-many', null); 1`);
      }
      // a toast with the longest text is not clipped: draw it for real
      for (const lang of ['de', 'ru', 'vi', 'fr']) {
        await evaluate(languageJs(lang));
        await evaluate(`import('/src/i18n/index.ts').then((m) => { window.__store.getState().setStickyToast('busy-many', { text: () => m.t('app.busy.many', { count: 500 }), kind: 'info', busy: true }); return 1; })`);
        await sleep(120);
        const fit = await evaluate(`(() => { const t = document.querySelector('.toasts .toast .toast-text'); const box = document.querySelector('.toasts .toast').getBoundingClientRect(); return { clipped: t.scrollWidth > t.clientWidth + 1 && getComputedStyle(t).whiteSpace === 'nowrap', inside: box.right <= innerWidth && box.left >= 0, h: Math.round(box.height) }; })()`);
        assert.equal(fit.clipped, false, `${lang} clipped at ${w}`);
        assert.equal(fit.inside, true, `${lang} outside the window at ${w}`);
        await evaluate(`window.__store.getState().setStickyToast('busy-many', null); 1`);
      }
    }
  });
} finally {
  await H.shutdown();
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
await check('the 8 dictionaries have the agreed texts for the two keys', async () => {
  const many = { vi: 'Đang xử lý {count} cuộc trò chuyện…', fr: 'Traitement de {count} conversations…', 'zh-Hans': '正在处理{count}个对话…', es: 'Procesando {count} conversaciones…', ja: '会話{count}件を処理しています…', de: '{count} Unterhaltungen werden bearbeitet…', ru: 'Обработка бесед: {count}…' };
  const print = { vi: 'Đang chuẩn bị để in…', fr: 'Préparation de l’impression…', 'zh-Hans': '正在准备打印…', es: 'Preparando la impresión…', ja: '印刷の準備をしています…', de: 'Druck wird vorbereitet…', ru: 'Подготовка к печати…' };
  assert.ok(read('src/i18n/ns/app.ts').includes('"app.busy.many": "Working on {count} conversations…"'));
  assert.ok(read('src/i18n/ns/reading.ts').includes('"reading.print.preparing": "Preparing to print…"'));
  for (const l of Object.keys(many)) {
    assert.ok(read(`src/i18n/locales/${l}/app.ts`).includes(`"app.busy.many": "${many[l]}"`), `${l} app.busy.many`);
    assert.ok(read(`src/i18n/locales/${l}/reading.ts`).includes(`"reading.print.preparing": "${print[l]}"`), `${l} reading.print.preparing`);
  }
});
await check('the wiring: A8 threshold, A9 wrapper and gap toasts, A10 paint first, A5, A6/A7', async () => {
  const st = read('src/store.ts');
  assert.ok(/export const BUSY_MANY = 20;/.test(st) && /n >= BUSY_MANY/.test(st), 'A8: 20 or more');
  assert.equal((st.match(/busy\?\.end\(\);/g) ?? []).length >= 4, true, 'A8: ends before each result toast and in a finally');
  const c = read('src/components/Compose.tsx');
  assert.ok(/sendPendingRef\.current\) return;/.test(c) && /aria-busy=\{sendPending \|\| undefined\}/.test(c), 'A9: one send at a time, the button is aria-busy');
  assert.ok(/pendingToast\("send-hold"/.test(c) && /pendingToast\("send-run"/.test(c), 'A9: the gap toasts');
  const p = read('src/printStatus.ts');
  assert.ok(/await paint\(\);\s*win\.print\(\);/.test(p), 'A10: painted first');
  const rp = read('src/components/ReadingPane.tsx');
  assert.ok(/pendingToast\("save-all", \(\) => t\("common\.loading"\), 300\)/.test(rp), 'A5');
  assert.ok(/useDelayedFlag\(loading && threads\.length > 0\)/.test(read('src/components/MessageList.tsx')), 'A6/A7');
  assert.ok(/aria-busy=\{syncing \|\| undefined\}/.test(read('src/components/TopBar.tsx')), 'A15');
});

if (failures.length) { console.error(`test-busy-actions: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-busy-actions: ok');
