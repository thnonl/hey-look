#!/usr/bin/env node
// The toolbar Discard answers in every state a message gets into (1.0.7 WP2 fix 3, QA round 3a O-1: "Discard did not respond in later app runs").
// Real mouse presses (CDP Input.dispatchMouseEvent at the centre of the button, after checking that the button is what is under that point), real Compose in the dev
// preview, in the main window (the pane) and as a compose window (`?w=compose`, the mock of the pop-out). In each state a message with something the person wrote
// shows "Discard this message?"; Cancel keeps everything (the same editor, the text), a second press and Discard end the message. The states are the ones that came
// before the report: a fresh message, after an autosave, after a send that was taken back with Undo, after a failed send, after Pop out (the pane went, a new
// message was started), in a window after Undo / a failed send; and the one place where the button must NOT answer: while the window is locked for a send ("Sending...",
// `inert`), after which it answers again. At 960 x 560 (the toolbar shows icons) as well as at 1280 x 720.
//   node scripts/test-discard-states.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-discard-states', { vitePort0: 5920 });
const { evaluate, cdp } = H;
const io = inputs(H, null, 'ds');
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));

const dialogText = () => evaluate(`document.querySelector('[role=alertdialog]')?.innerText.split(String.fromCharCode(10)).join(' ') ?? null`);
const popCalls = () => json(`window.__popoutCalls || []`);
const paneUp = () => evaluate(`!!document.querySelector('.compose-pane')`);
const editorText = () => evaluate(`document.querySelector('.cp-editor .tiptap')?.editor.getText() ?? null`);

/** The centre of the toolbar button with this label, and whether the button is what a press there reaches. */
const barButton = (label) => json(`(() => {
  const b = [...document.querySelectorAll('.cp-bar button')].find((x) => (x.getAttribute('aria-label') || x.title || x.textContent).trim().startsWith(${JSON.stringify(label)}));
  if (!b) return null;
  b.scrollIntoView({ block: 'nearest' });
  const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
  return { x, y, w: r.width, h: r.height, reached: !!hit && b.contains(hit), disabled: b.disabled };
})()`);
const press = async (label) => {
  const b = await barButton(label);
  assert.ok(b, `no "${label}" button in the toolbar`);
  assert.ok(b.w > 8 && b.h > 8, `the "${label}" button has no size: ${b.w} x ${b.h}`);
  assert.ok(b.reached, `a press on the "${label}" button reaches something else (an overlay over it)`);
  await io.clickAt(b.x, b.y);
};
const clickCenter = async (selector) => {
  const p = await json(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 }; })()`);
  assert.ok(p, `no ${selector}`);
  await io.clickAt(p.x, p.y);
};
const addTo = async (a) => { await clickCenter('.cf-field.rcpt input'); await io.typeText(a + ',', 5); await sleep(250); };
const typeSubject = async (text) => { await clickCenter('input[aria-label="Subject"]'); await io.typeText(text, 5); await sleep(250); };
const answer = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('[role=alertdialog] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; return true; })()`)
  .then(async (has) => { assert.ok(has, `no "${label}" in the question`); const p = await json(`(() => { const b = [...document.querySelectorAll('[role=alertdialog] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); await io.clickAt(p.x, p.y); });

/** The message has something written: Discard asks; Cancel keeps it all; Discard ends it (the pane goes, or the window ends). */
async function discardAsks(where, { win = false } = {}) {
  const text0 = await editorText();
  await press('Discard');
  assert.ok(await waitFor(`!!document.querySelector('[role=alertdialog]')`, 4000), `${where}: no question after a press on Discard`);
  assert.match(String(await dialogText()), /Discard this message\?|Discard your changes\?/, where);
  await answer('Cancel');
  assert.ok(await waitFor(`!document.querySelector('[role=alertdialog]')`, 3000), `${where}: Cancel left the question open`);
  assert.equal(await paneUp(), true, `${where}: Cancel closed the message`);
  assert.equal(await editorText(), text0, `${where}: Cancel changed the text`);
  await press('Discard');
  assert.ok(await waitFor(`!!document.querySelector('[role=alertdialog]')`, 4000), `${where}: no question at the second press`);
  await answer('Discard');
  if (win) assert.ok(await waitFor(`(window.__popoutCalls || []).includes('popout_destroy')`, 6000), `${where}: the window did not end`);
  else assert.ok(await waitFor(`!document.querySelector('.compose-pane') && window.__store.getState().composeDirty === false`, 6000), `${where}: the message did not end`);
}

async function paneApp(w, h) {
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().setPrefs({ undoSeconds: 3 }); 1`);
}
async function newMessage() {
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: [], subject: '' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 10000), 'the compose did not open');
  await sleep(700);
}
async function windowApp(w, h) {
  await H.openApp('lang=en', w, h);
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en` });
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'the window did not start');
  await sleep(900);
  await evaluate(`window.__store.getState().setPrefs({ undoSeconds: 3 }); window.__popoutCalls = []; 1`);
}
const send = () => press('Send');
const undo = async () => {
  assert.ok(await waitFor(`document.querySelectorAll('.toasts .toast-undo').length === 1`, 6000), 'no Undo toast');
  await clickCenter('.toasts .toast-undo');
};

try {
  for (const [w, h] of [[1280, 720], [960, 560]]) {
    const at = `${w}x${h}`;
    // ---------------------------------------------------------------- the pane
    await paneApp(w, h);
    await check(`${at} pane: a fresh message with a subject`, async () => { await newMessage(); await typeSubject('Hello'); await discardAsks('fresh'); });
    await check(`${at} pane: only recipients and nothing written closes at once (W13.5)`, async () => {
      await newMessage();
      await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['only@x.test'], subject: '' }); 1`);
      await sleep(600);
      await press('Discard');
      assert.ok(await waitFor(`!document.querySelector('.compose-pane')`, 4000), 'did not close');
      assert.equal(await dialogText(), null);
    });
    await check(`${at} pane: after an autosave / Save draft`, async () => {
      await newMessage(); await typeSubject('Saved once');
      await evaluate(`window.__store.getState().composeSaver?.(); 1`);
      await sleep(1200);
      await discardAsks('after a save');
    });
    await check(`${at} pane: after Send and Undo`, async () => {
      await newMessage();
      await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['u@x.test'], subject: 'Undo me', bodyHtml: '<p>body</p>' }); 1`);
      await sleep(800);
      await typeSubject(' x');
      await send();
      await undo();
      assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 6000), 'the message did not come back');
      await sleep(800);
      await discardAsks('after Send and Undo');
    });
    await check(`${at} pane: after a failed send`, async () => {
      await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['f@x.test'], subject: 'Big [toolarge]', bodyHtml: '<p>body</p>' }); 1`);
      await sleep(800);
      await typeSubject(' x');
      await send();
      assert.ok(await waitFor(`[...document.querySelectorAll('.toasts .toast.error')].length > 0 || (!!document.querySelector('.cp-editor .tiptap') && !document.querySelector('.toasts .toast-undo'))`, 15000), 'no failure');
      await sleep(800);
      await discardAsks('after a failed send');
    });
    await check(`${at} pane: after Pop out (the pane went, a new message is started)`, async () => {
      await newMessage(); await typeSubject('To a window');
      await evaluate(`window.__popoutOpens = 0; 1`);
      await press('Pop out');
      assert.ok(await waitFor(`(window.__popoutOpens || 0) > 0 && !document.querySelector('.compose-pane')`, 8000), 'the pane did not move to a window');
      await newMessage(); await typeSubject('Second');
      await discardAsks('after Pop out');
    });

    // ---------------------------------------------------------------- a compose window
    await windowApp(w, h);
    await check(`${at} window: a fresh message with a subject`, async () => { await typeSubject('Hello'); await discardAsks('window fresh', { win: true }); });
    await windowApp(w, h);
    await check(`${at} window: Send, locked (Discard does nothing), Undo, then Discard asks`, async () => {
      await addTo('u@x.test');
      await typeSubject('Undo in a window');
      await send();
      assert.ok(await waitFor(`document.querySelector('.compose-pane')?.hasAttribute('inert')`, 5000), 'not locked');
      await sleep(500);
      const b = await barButton('Discard');
      await io.clickAt(b.x, b.y);
      await sleep(600);
      assert.equal(await dialogText(), null, 'a question while the message is on its way out');
      assert.equal(await paneUp(), true);
      await undo();
      assert.ok(await waitFor(`!document.querySelector('.compose-pane')?.hasAttribute('inert')`, 6000), 'still locked after Undo');
      await sleep(600);
      await discardAsks('window after Undo', { win: true });
    });
    await windowApp(w, h);
    await check(`${at} window: after a failed send`, async () => {
      await addTo('f@x.test');
      await typeSubject('Big [toolarge]');
      await send();
      assert.ok(await waitFor(`!document.querySelector('.compose-pane')?.hasAttribute('inert') && [...document.querySelectorAll('.toasts .toast.error')].length > 0`, 15000), 'no failure');
      await sleep(600);
      await discardAsks('window after a failed send', { win: true });
    });
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-discard-states: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-discard-states: ok');
