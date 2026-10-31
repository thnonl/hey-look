#!/usr/bin/env node
// W4.4 (Next / Previous conversation in a reader window) and W4.5 (move a message back to the main window), real components in the dev preview
// (`?w=reader`, `?w=compose`, the mock backend answers the requests of the secondary window, src/devMock.ts):
//   - the toolbar starts with two icon-only buttons (aria-label, tooltip "<name> (k)" / "(j)"), a separator, then Reply; they stay on screen at 520 px;
//   - Next / Previous (buttons and the keys j / k) put the next / previous conversation of the list in the SAME window: the registry is told (popout_show with the key
//     and the hand-off data), the subject has the focus, the scroll is at the top; the ends are disabled with the two agreed tooltips, no wrap;
//   - j / k do nothing in a field or behind a dialog; another window that shows the conversation is brought forward and this window stays as it is;
//   - the conversation is gone (banner) or the main window does not answer: both buttons are off;
//   - W4.5: a compose window's Pop out button is Move to main window; the request the main window gets carries the message as the window holds it.
//   node scripts/test-popout-nav.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-nav', { vitePort0: 5340, cdpPort0: 9340 });
const { evaluate } = H;
const { press } = inputs(H, null, 'nav');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`(async () => JSON.stringify(await (${js})))()`).then((s) => JSON.parse(s));

let A = []; // the five conversations A..E of the list (newest first)

/** The mock list reduced to five readable conversations, then a reader window on `start` (0..4). */
async function readerAt(start, hash = 'lang=en', width = 1100) {
  await H.openApp(hash, width, 720);
  if (!A.length) {
    A = await json(`(async () => { const l = await window.__TAURI_INTERNALS__.invoke('list_threads', { filter: { accountId: null, folder: 'inbox', search: '', focus: null, flat: false, unreadOnly: false, flaggedOnly: false, sortAsc: false, scope: 'current' } }); const out = []; for (const t of l.filter((x) => !/invitation|cancel|confidential|sender check|unverified/i.test(x.subject)).slice(0, 5)) out.push({ id: t.threadId, subject: (await window.__TAURI_INTERNALS__.invoke('get_thread', { threadId: t.threadId, scope: null, light: null }))[0].subject }); return out; })()`);
    assert.equal(A.length, 5, 'five readable conversations');
  }
  // the page of a reader window is loaded in this tab; the mock list keeps only A..E (everything else "left"), so the ends are the ends of the list
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=reader&thread=${A[start].id}#${hash}` });
  assert.ok(await waitFor(`!!document.querySelector('.reader-bar .rb.nav')`, 20000), 'the reader window did not start');
  await evaluate(`(async () => { const all = await window.__TAURI_INTERNALS__.invoke('list_threads', { filter: { accountId: null, folder: 'inbox', search: '', focus: null, flat: false, unreadOnly: false, flaggedOnly: false, sortAsc: false, scope: 'current' } }); const keep = new Set(${JSON.stringify(A.map((a) => a.id))}); for (const t of all) if (!keep.has(t.threadId)) window.__mockGone.add(t.threadId); return 1; })()`);
  await evaluate(`window.__mockEmit('mail-synced', null); 1`);
  await sleep(700);
}
const navState = () => json(`(() => { const b = [...document.querySelectorAll('.reader-bar .rb.nav')]; return b.map((x) => ({ label: x.getAttribute('aria-label'), title: x.getAttribute('title'), disabled: x.disabled, text: x.textContent.trim(), icon: !!x.querySelector('svg') })); })()`);
const subjectNow = () => evaluate(`document.querySelector('.rp-head h1')?.textContent ?? null`);
const shown = () => json(`(window.__popoutShown || []).map((s) => s.key)`);
const waitSubject = async (i) => assert.ok(await waitFor(`document.querySelector('.rp-head h1')?.textContent === ${JSON.stringify(A[i].subject)}`, 8000), `the window did not show ${A[i].subject} (shows ${await subjectNow()})`);
const waitNav = async (prevOff, nextOff) => assert.ok(await waitFor(`(() => { const b = document.querySelectorAll('.reader-bar .rb.nav'); return b.length === 2 && b[0].disabled === ${prevOff} && b[1].disabled === ${nextOff}; })()`, 8000), `the buttons are ${JSON.stringify(await navState())}`);

try {
  // ---------- the buttons
  await readerAt(2);
  await check('two icon-only buttons first in the toolbar, a separator, then Reply (REQ-4.4.1)', async () => {
    await waitNav(false, false);
    const s = await navState();
    assert.deepEqual(s.map((b) => b.label), ['Previous conversation', 'Next conversation']);
    assert.deepEqual(s.map((b) => b.title), ['Previous conversation (k)', 'Next conversation (j)']);
    assert.ok(s.every((b) => b.text === '' && b.icon), 'no word, only an icon');
    const order = await json(`[...document.querySelector('.reader-bar').children].slice(0, 4).map((e) => e.className.split(' ').slice(0, 2).join(' ') + ':' + (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 20))`);
    assert.match(order[0], /nav/); assert.match(order[1], /nav/); assert.match(order[2], /^sep/); assert.match(order[3], /Reply/);
  });

  // ---------- Next
  await check('Next: D in the same window, the registry is told, the subject has the focus, the scroll is at the top (REQ-4.4.5)', async () => {
    await evaluate(`document.querySelector('.reader-pane').scrollTop = 40; document.querySelector('.rb.nav[aria-label="Next conversation"]').click(); 1`);
    await waitSubject(3);
    assert.deepEqual(await shown(), [A[3].id], 'popout_show got the key of D');
    const init = await json(`window.__popoutShown[0].init`);
    assert.equal(init.threadId, A[3].id); assert.equal(init.subject, A[3].subject); assert.equal(init.view, 'inbox');
    assert.ok(await waitFor(`document.activeElement === document.querySelector('.rp-head h1')`, 5000), 'the subject has the focus');
    assert.equal(await evaluate(`document.title`), `${A[3].subject} – Hey Look!`);
    assert.equal(await evaluate(`document.querySelector('.reader-pane').scrollTop`), 0);
  });
  // BUG-L3 (1.0.12): the body of a conversation is asked for exactly once per navigation, and the window is not told "show another conversation" again by itself
  await check('Previous: C is read once, popout_show is called once, and nothing happens by itself afterwards', async () => {
    await waitNav(false, false);
    await evaluate(`window.__reads = []; window.__shows0 = (window.__popoutShown || []).length; (() => { const inv = window.__TAURI_INTERNALS__.invoke; window.__TAURI_INTERNALS__.invoke = (cmd, a, o) => { if (cmd === 'get_thread_packed') window.__reads.push(a.threadId); return inv.call(window.__TAURI_INTERNALS__, cmd, a, o); }; })(); document.querySelectorAll('.rb.nav')[0].click(); 1`);
    await waitSubject(2);
    await sleep(2500);
    const reads = await json('window.__reads');
    assert.deepEqual(reads.filter((id) => id === A[2].id), [A[2].id], `the body of C was read once (reads: ${JSON.stringify(reads)})`);
    assert.equal(await evaluate('(window.__popoutShown || []).length - window.__shows0'), 1, 'popout_show was called once');
    assert.equal(await evaluate("!!document.querySelector('.rp-opening')"), false, 'the opening status is gone');
    await sleep(3000);
    assert.equal(await evaluate('(window.__popoutShown || []).length - window.__shows0'), 1, 'no further popout_show by itself');
    await evaluate("document.querySelectorAll('.rb.nav')[1].click(); 1");
    await waitSubject(3);
  });
  await check('Next again: E; Next is disabled with the tooltip "last conversation" (REQ-4.4.4)', async () => {
    await waitNav(false, false);
    await evaluate(`document.querySelectorAll('.rb.nav')[1].click(); 1`);
    await waitSubject(4);
    await waitNav(false, true);
    const s = await navState();
    assert.equal(s[1].title, 'This is the last conversation in the list');
    assert.equal(s[0].title, 'Previous conversation (k)');
    await evaluate(`document.querySelectorAll('.rb.nav')[1].click(); 1`); // a click on a disabled button does nothing
    await sleep(300);
    assert.equal(await subjectNow(), A[4].subject);
  });
  await check('Previous x4 back to A; Previous disabled with "first conversation"; no wrap (REQ-4.4.3)', async () => {
    for (let i = 3; i >= 0; i--) {
      await waitNav(false, i === 3);
      await evaluate(`document.querySelectorAll('.rb.nav')[0].click(); 1`);
      await waitSubject(i);
    }
    await waitNav(true, false);
    const s = await navState();
    assert.equal(s[0].title, 'This is the first conversation in the list');
    assert.equal(await subjectNow(), A[0].subject);
  });

  // ---------- the keys
  await check('k and j do the same as the buttons (REQ-4.4.2)', async () => {
    await press('j', 'KeyJ');
    await waitSubject(1);
    await press('j', 'KeyJ');
    await waitSubject(2);
    await press('k', 'KeyK');
    await waitSubject(1);
  });
  await check('typing j in a field, or behind a dialog, moves nothing', async () => {
    await waitNav(false, false);
    await evaluate(`(() => { const i = document.createElement('input'); i.id = 'probe'; document.body.appendChild(i); i.focus(); return 1; })()`);
    await press('j', 'KeyJ');
    await sleep(500);
    assert.equal(await subjectNow(), A[1].subject, 'a field takes the key');
    await evaluate(`document.getElementById('probe').remove(); window.__store.setState({ dialog: { type: 'original', messageId: 'none' } }); 1`);
    await press('j', 'KeyJ');
    await sleep(500);
    assert.equal(await subjectNow(), A[1].subject, 'a dialog takes the key');
    await evaluate(`window.__store.setState({ dialog: null }); 1`);
  });

  // ---------- another window has it
  await readerAt(1, 'lang=en&showother');
  await check('the conversation is open in another window: that window comes forward, this one stays (REQ-4.4.6)', async () => {
    await waitNav(false, false);
    await evaluate(`document.querySelectorAll('.rb.nav')[1].click(); 1`);
    assert.ok(await waitFor(`(window.__popoutShown || []).length === 1`, 5000), 'popout_show was asked');
    await sleep(500);
    assert.equal(await subjectNow(), A[1].subject, 'this window still shows its conversation');
  });

  // ---------- gone / the main window does not answer
  await readerAt(2);
  await check('the conversation is gone (banner): both buttons are off (REQ-4.4.4)', async () => {
    await waitNav(false, false);
    await evaluate(`window.__mockGone.add(${JSON.stringify(A[2].id)}); window.__mockEmit('mail-synced', null); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.reader-gone')`, 8000), 'no banner');
    await waitNav(true, true);
  });
  await readerAt(2, 'lang=en&reqsilent');
  await check('the main window does not answer: both buttons are off, no text explains (REQ-4.4.4)', async () => {
    assert.ok(await waitFor(`(() => { const b = document.querySelectorAll('.reader-bar .rb.nav'); return b.length === 2 && b[0].disabled && b[1].disabled; })()`, 8000), 'the buttons are not off');
    const s = await navState();
    assert.equal(s[0].title, 'Previous conversation (k)');
    assert.equal(await evaluate(`!!document.querySelector('.reader-bar')?.textContent.match(/first conversation|last conversation/)`), false);
  });

  // ---------- the narrow window
  await readerAt(2, 'lang=en', 520);
  await check('at 520 px the toolbar keeps both buttons on screen (AC-4.4.9)', async () => {
    await waitNav(false, false);
    const r = await json(`(() => { const bar = document.querySelector('.reader-bar').getBoundingClientRect(); return [...document.querySelectorAll('.rb.nav')].map((b) => { const r = b.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= bar.left - 1 && r.right <= bar.right + 1 }; }); })()`);
    assert.ok(r.every((b) => b.inside && b.w >= 30 && b.h >= 30), JSON.stringify(r));
  });

  // ---------- 8 languages: the names and tooltips, no raw key
  const names = { en: ['Previous conversation', 'Next conversation'], de: ['Vorherige Unterhaltung', 'Nächste Unterhaltung'], vi: ['Cuộc trò chuyện trước', 'Cuộc trò chuyện sau'], ja: ['前の会話', '次の会話'], ru: ['Предыдущая беседа', 'Следующая беседа'], fr: ['Conversation précédente', 'Conversation suivante'], es: ['Conversación anterior', 'Conversación siguiente'], 'zh-Hans': ['上一个对话', '下一个对话'] };
  for (const [lang, [prev, next]] of Object.entries(names)) {
    await readerAt(0, `lang=${lang}`);
    await check(`${lang}: names and tooltips (the first conversation: Previous says so)`, async () => {
      await waitNav(true, false);
      const s = await navState();
      assert.equal(s[0].label, prev); assert.equal(s[1].label, next);
      assert.ok(!s.some((b) => /reading\.popout/.test(b.title + b.label)), 'a raw key');
      assert.ok(s[1].title.endsWith('(j)'), s[1].title);
      assert.ok(s[0].title.length > 8 && !/\(k\)$/.test(s[0].title), s[0].title);
    });
  }

  // ================= W4.5: move a compose window back to the main window
  const composeAt = async (hash = 'lang=en', mock = 'reply', width = 1100) => {
    await H.openApp(hash, width, 720);
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=${mock}#${hash}` });
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'the compose window did not start');
    await sleep(900);
  };
  const popInButton = () => json(`(() => { const b = document.querySelector('.cp-bar .icon-btn[aria-label="Move to main window"]'); return b ? { title: b.getAttribute('title'), disabled: b.disabled } : null; })()`);
  const lastPopIn = () => json(`(window.__popoutRequests || []).filter((r) => r.kind === 'cw-pop-in').at(-1) ?? null`);
  const clickPopIn = () => evaluate(`document.querySelector('.cp-bar .icon-btn[aria-label="Move to main window"]').click(); 1`);

  await composeAt();
  await check('a compose window has Move to main window where Pop out is; its tooltip carries the key (REQ-4.5.1)', async () => {
    const b = await popInButton();
    assert.ok(b, 'no Move to main window button');
    assert.match(b.title, /^Move to the main window \((Ctrl|Cmd)\+Shift\+O\)$/);
    assert.equal(await evaluate(`!!document.querySelector('.cp-bar .icon-btn[aria-label="Pop out"]')`), false, 'Pop out is not in a window');
  });
  await check('the button hands the message over as the window holds it, then the window ends with no question, toast or save (REQ-4.5.2 / 4.5.4)', async () => {
    await evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; ed.commands.insertContent('<p>typed in the window</p>'); return 1; })()`);
    await sleep(300);
    await clickPopIn();
    assert.ok(await waitFor(`(window.__popoutDestroyed || 0) >= 1`, 8000), 'the window did not end');
    const r = await lastPopIn();
    assert.ok(r, 'no cw-pop-in request');
    const init = r.payload.init;
    assert.deepEqual(init.to, ['linh.tran@acme.example']);
    assert.equal(init.subject, 'Re: Q4 roadmap review');
    assert.equal(init.isReply, true);
    assert.equal(init.inReplyTo, '<m1@acme.example>');
    assert.match(init.bodyHtml, /typed in the window/);
    assert.match(init.bodyHtml, /Could you review the milestones/);
    assert.equal(init.carried, true, 'the message counts as changed: closing it asks');
    assert.equal(init.openSchedule, undefined);
    assert.equal(await evaluate(`window.__draftSaveCalls || 0`), 0, 'nothing was saved');
    assert.deepEqual(await json(`[...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent)`), [], 'no toast');
  });

  await composeAt('lang=en&popinkeep');
  await check('Keep writing in the main window: the window is exactly as it was and usable (REQ-4.5.3)', async () => {
    await clickPopIn();
    assert.ok(await waitFor(`(window.__popoutRequests || []).some((r) => r.kind === 'cw-pop-in')`, 5000), 'no request');
    await sleep(800);
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 0, 'the window did not end');
    assert.equal(await evaluate(`document.querySelector('.compose-pane')?.hasAttribute('inert') === false`), true, 'the pane is usable again');
    assert.ok(await popInButton(), 'the button is back');
  });

  await composeAt('lang=en&popinasking');
  await check('the main window asks its question: the pane is inert while it is open, then the window ends (REQ-4.5.3)', async () => {
    await clickPopIn();
    assert.ok(await waitFor(`document.querySelector('.compose-pane')?.hasAttribute('inert')`, 3000), 'the pane is not inert while it waits');
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 0);
    assert.ok(await waitFor(`(window.__popoutDestroyed || 0) >= 1`, 8000), 'the window did not end after the answer');
  });

  await composeAt('lang=en&reqsilent');
  await check('the main window does not answer in 5 s: the window stays unchanged with the "main window" toast (REQ-4.5.6)', async () => {
    await clickPopIn();
    assert.ok(await waitFor(`[...document.querySelectorAll('.toasts .toast')].some((t) => /reach the main window/i.test(t.textContent))`, 9000), 'no toast');
    assert.equal(await evaluate(`window.__popoutDestroyed || 0`), 0);
    assert.equal(await evaluate(`document.querySelector('.compose-pane')?.hasAttribute('inert') === false`), true);
  });

  await composeAt('lang=en', 'reply');
  await check('Ctrl+Shift+O does the same from the body (AC-4.5.2)', async () => {
    await evaluate(`document.querySelector('.cp-editor .tiptap').focus(); 1`);
    await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'O', code: 'KeyO', modifiers: 2 | 8, windowsVirtualKeyCode: 79 });
    await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'O', code: 'KeyO', modifiers: 2 | 8, windowsVirtualKeyCode: 79 });
    assert.ok(await waitFor(`(window.__popoutDestroyed || 0) >= 1`, 8000), 'the window did not end');
  });

  await composeAt('lang=en', 'reply');
  await check('during "Sending…" the button is not there and Ctrl+Shift+O does nothing (AC-4.5.9)', async () => {
    await evaluate(`window.__store.getState().setPrefs({ undoSeconds: 5 }); document.querySelector('.cp-bar button.btn.primary').click(); 1`);
    assert.ok(await waitFor(`document.querySelector('.compose-pane')?.hasAttribute('inert')`, 5000), 'not locked');
    assert.equal(await popInButton(), null, 'the button is gone while sending');
    await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'O', code: 'KeyO', modifiers: 2 | 8, windowsVirtualKeyCode: 79 });
    await sleep(500);
    assert.equal(await lastPopIn(), null, 'no request');
  });

  // ================= W4.2: a window whose page process died is loaded again with its message
  await check('a reloaded compose window shows the message of its crash snapshot, not the hand-off data (REQ-4.2.3)', async () => {
    await H.openApp('lang=en', 1100, 720);
    const snap = { v: 1, to: ['restored@acme.example'], cc: [], bcc: [], subject: 'From the snapshot', html: '<p>typed before the crash</p>', inReplyTo: null, references: [], replaces: null, isReply: false, encrypt: 'off', sign: false, attachKey: false, confidential: false, win: true };
    await evaluate(`localStorage.setItem('hl-mock-recovery', ${JSON.stringify(JSON.stringify({ 'snap-1': { id: 'snap-1', accountId: 'a1', savedAt: 1, subject: 'From the snapshot', preview: '', payload: JSON.stringify(snap), files: [] } }))}); 1`);
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=reloaded#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'the window did not start');
    await sleep(900);
    assert.match(await evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`), /typed before the crash/);
    assert.doesNotMatch(await evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`), /Handed over/);
    assert.ok((await json(`[...document.querySelectorAll('.rchip .ellipsis')].map((e) => e.textContent.trim())`)).includes('restored@acme.example'));
    assert.ok((await json(`[...document.querySelectorAll('.compose-pane input')].map((i) => i.value)`)).includes('From the snapshot'));
  });
  await check('a reloaded window without a snapshot shows the hand-off data again', async () => {
    await H.openApp('lang=en', 1100, 720);
    await evaluate(`localStorage.setItem('hl-mock-recovery', '{}'); 1`);
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=reloaded#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000));
    await sleep(900);
    assert.match(await evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`), /Handed over/);
  });

  // 8 languages: the name and the tooltip of the button
  const popNames = { en: ['Move to main window', 'Move to the main window ('], de: ['Ins Hauptfenster verschieben', 'Zurück ins Hauptfenster verschieben ('], vi: ['Chuyển về cửa sổ chính', 'Chuyển về cửa sổ chính ('], ja: ['メインウィンドウに戻す', 'メインウィンドウに戻す ('], ru: ['В главное окно', 'Вернуть в главное окно ('], fr: ['Déplacer vers la fenêtre principale', 'Déplacer vers la fenêtre principale ('], es: ['Mover a la ventana principal', 'Mover a la ventana principal ('], 'zh-Hans': ['移回主窗口', '移回主窗口 ('] };
  for (const [lang, [name, tip]] of Object.entries(popNames)) {
    await composeAt(`lang=${lang}`);
    await check(`${lang}: name and tooltip of Move to main window`, async () => {
      const r = await json(`(() => { const b = document.querySelector('.cp-bar .icon-btn[data-fit="fixed"]'); return b ? { label: b.getAttribute('aria-label'), title: b.getAttribute('title') } : null; })()`);
      assert.ok(r, 'no button');
      assert.equal(r.label, name);
      assert.ok(r.title.startsWith(tip) && /Ctrl\+Shift\+O\)$/.test(r.title), r.title);
    });
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('test-popout-nav: ok');
