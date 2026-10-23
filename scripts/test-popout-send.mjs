#!/usr/bin/env node
// Sending from a compose window keeps the compose on screen (1.0.7 W13.1), real Compose in the dev preview (`?w=compose`):
//   - Send: the compose stays, locked (`inert`, `aria-busy`), the Send button reads "Sending..." with a ring and keeps its width, no "Sending... n s" card, ONE toast
//     "Sending... n s" with Undo (the number is aria-hidden, a screen reader gets "Sending..." once), Undo has the focus, the toast counts down;
//   - Undo: the SAME editor is unlocked in place (a marker set on its element before Send is still there, the text, the scroll position and the caret are as they were,
//     the focus is back in the body), the message counts as changed, the window did not end; the outbox copy was cancelled;
//   - when the time is over the toast reads "Sending..." (no Undo) until the server answered, then the window ends; with no Undo time the same, locked, no Undo;
//   - a failed send unlocks in place with the error in this window; X during the send hides the window (park) and the send goes on;
//   - the main window: the "Sending..." toast with Undo stays exactly the Undo send time (not the undo-action time).
//   node scripts/test-popout-send.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-popout-send', { vitePort0: 5200, cdpPort0: 9200 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };

const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const popCalls = () => json(`window.__popoutCalls || []`);
const sendCalls = () => json(`(window.__sendCalls || []).map((c) => c.cmd)`);
const outboxCalls = () => json(`(window.__outboxCalls || []).map((c) => c.cmd)`);
const reset = () => evaluate(`window.__popoutCalls = []; window.__sendCalls = []; window.__outboxCalls = []; 1`);
const toasts = () => json(`[...document.querySelectorAll('.toasts .toast')].map((t) => ({ text: t.querySelector('.toast-text')?.textContent ?? '', hidden: t.querySelector('.toast-text')?.getAttribute('aria-hidden') === 'true', read: t.querySelector('.sr-only')?.textContent ?? null, undo: !!t.querySelector('.toast-undo'), ring: !!t.querySelector('.busy-ring') }))`);
const pane = () => json(`(() => { const p = document.querySelector('.compose-pane'); return p ? { inert: p.hasAttribute('inert'), busy: p.getAttribute('aria-busy') } : null; })()`);
const sendButton = () => json(`(() => { const b = document.querySelector('.cp-bar button.btn.primary'); return b ? { text: b.textContent.trim(), ring: !!b.querySelector('.spin'), w: b.getBoundingClientRect().width } : null; })()`);
const editorText = () => evaluate(`document.querySelector('.cp-editor .tiptap').editor.getText()`);
const scrollTop = () => evaluate(`document.querySelector('.cp-editor').scrollTop`);
const clickSend = () => evaluate(`(() => { const b = document.querySelector('.cp-bar button.btn.primary'); if (!b) return false; b.click(); return true; })()`);

async function windowOf({ mock = 'reply', undo = 3 } = {}) {
  await H.openApp('lang=en', 1280, 720);
  await H.cdp('Page.navigate', { url: 'about:blank' });
  await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=${mock}#lang=en` });
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'the window did not start');
  await sleep(900);
  await evaluate(`window.__store.getState().setPrefs({ undoSeconds: ${undo} }); 1`);
  // a body longer than the pane, scrolled a little; a marker on the element of the editor (a new editor would not have it)
  await evaluate(`(() => { const ed = document.querySelector('.cp-editor .tiptap').editor; ed.commands.insertContent('<p>' + Array.from({ length: 40 }, (_, i) => 'line ' + i).join('</p><p>') + '</p>'); document.querySelector('.cp-editor .tiptap').setAttribute('data-marker', 'before-send'); ed.commands.focus('end'); return 1; })()`);
  await sleep(500);
  await evaluate(`document.querySelector('.cp-editor').scrollTop = 120; 1`);
  await sleep(300);
  await reset();
}

try {
  // ---------- Send with an Undo time of 3 s
  await windowOf();
  const text0 = await editorText();
  const top0 = await scrollTop();
  const w0 = (await sendButton()).w;
  assert.ok(top0 > 0, 'the body did not scroll');
  assert.ok(await clickSend(), 'no Send button');
  await check('locked: the pane is inert and busy, nothing of it takes input', async () => {
    assert.ok(await waitFor(`document.querySelector('.compose-pane')?.hasAttribute('inert')`, 5000), 'the pane is not inert');
    const p = await pane();
    assert.deepEqual(p, { inert: true, busy: 'true' });
  });
  await check('the compose stays: no "Sending... n s" card, same text, same scroll position', async () => {
    assert.equal(await evaluate(`!!document.querySelector('.popout-sending')`), false);
    assert.equal(await editorText(), text0);
    assert.equal(await scrollTop(), top0);
  });
  await check('the Send button reads "Sending..." with a ring and keeps its width', async () => {
    const b = await sendButton();
    assert.equal(b.text, 'Sending…');
    assert.equal(b.ring, true);
    assert.ok(b.w >= w0 - 1.5, `the button got narrower: ${b.w} vs ${w0}`);
  });
  await check('one toast "Sending... n s" with Undo; the number is aria-hidden and the screen reader text is "Sending..."', async () => {
    assert.ok(await waitFor(`document.querySelectorAll('.toasts .toast-undo').length === 1`, 5000), 'no Undo toast');
    const t = await toasts();
    assert.equal(t.length, 1, JSON.stringify(t));
    assert.match(t[0].text, /^Sending… \d+ s$/);
    assert.equal(t[0].hidden, true);
    assert.equal(t[0].read, 'Sending…');
    assert.equal(t[0].undo, true);
    assert.equal(t[0].ring, true);
  });
  await check('Undo has the keyboard focus', async () => assert.ok(await waitFor(`document.activeElement?.classList?.contains('toast-undo')`, 3000), await evaluate(`String(document.activeElement?.className)`)));
  await check('the toast counts down', async () => {
    const a = (await toasts())[0].text;
    await sleep(1300);
    const b = (await toasts())[0]?.text;
    assert.notEqual(a, b, `${a} -> ${b}`);
  });
  // Undo with the keyboard (Enter on the focused button)
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await check('Undo: the same editor is unlocked in place', async () => {
    assert.ok(await waitFor(`!document.querySelector('.compose-pane')?.hasAttribute('inert')`, 5000), 'still locked');
    assert.equal(await evaluate(`document.querySelector('.cp-editor .tiptap').getAttribute('data-marker')`), 'before-send', 'the editor was made again');
    assert.equal(await editorText(), text0);
    assert.equal(await scrollTop(), top0);
    assert.equal((await pane()).busy, null);
    assert.equal((await sendButton()).text, 'Send');
    assert.deepEqual((await toasts()).filter((t) => /Sending/.test(t.text)), [], 'the toast is still there');
  });
  await check('Undo: the focus is back in the body, the message counts as changed, the window did not end, the outbox copy was taken back', async () => {
    assert.ok(await waitFor(`!!document.activeElement?.closest?.('.ProseMirror')`, 3000), String(await evaluate(`document.activeElement?.className`)));
    assert.equal(await evaluate(`window.__store.getState().composeDirty`), true);
    await sleep(800);
    assert.ok(!(await popCalls()).includes('popout_destroy'), 'the window ended');
    assert.ok((await outboxCalls()).includes('cancel_outbox'));
    assert.deepEqual((await sendCalls()).filter((c) => c === 'holdSend'), []);
  });
  await check('after Undo the editor takes input again (typing works) and the Ctrl+Z history reaches back before Send', async () => {
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent('X'); 1`);
    assert.match(await editorText(), /X$/);
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.undo(); 1`);
    assert.equal((await editorText()).includes('X'), false);
  });

  // ---------- Send, let the time run out: "Sending..." without Undo, then the window ends
  await reset();
  assert.ok(await clickSend());
  assert.ok(await waitFor(`document.querySelectorAll('.toasts .toast-undo').length === 1`, 5000));
  await check('the time is over: the toast changes in place to "Sending..." with the ring and no Undo', async () => {
    assert.ok(await waitFor(`[...document.querySelectorAll('.toasts .toast')].some((t) => t.querySelector('.toast-text')?.textContent === 'Sending…' && !t.querySelector('.toast-undo'))`, 8000), JSON.stringify(await toasts()));
  });
  await check('the server answered: the window ends (after the grace time), one message was sent through the outbox', async () => {
    assert.ok(await waitFor(`(window.__popoutCalls || []).includes('popout_destroy')`, 6000), 'the window did not end');
    assert.equal((await sendCalls()).filter((c) => c === 'holdSend').length, 1);
  });

  // ---------- no Undo time: locked, "Sending..." without Undo, then the window ends
  await windowOf({ undo: 0 });
  assert.ok(await clickSend());
  await check('Undo send off: locked at once, a toast "Sending..." without Undo, the window is not hidden', async () => {
    assert.ok(await waitFor(`document.querySelector('.compose-pane')?.hasAttribute('inert') || (window.__popoutCalls || []).includes('popout_destroy')`, 3000));
    assert.equal((await popCalls()).includes('popout_park'), false, 'the window was hidden');
  });
  await check('Undo send off: the window ends when the send is over', async () => assert.ok(await waitFor(`(window.__popoutCalls || []).includes('popout_destroy')`, 6000)));

  // ---------- a failed send: unlocked in place, the error in this window
  await windowOf({ undo: 1 });
  // the mock refuses a subject with [toolarge] like a server with a smaller size limit does
  await evaluate(`(() => { const subj = document.querySelector('input[aria-label="Subject"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(subj, 'Big [toolarge]'); subj.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(300);
  assert.ok(await clickSend());
  await check('a failed send: the same editor comes back unlocked with the error toast in this window; the window did not end', async () => {
    assert.ok(await waitFor(`!document.querySelector('.compose-pane')?.hasAttribute('inert') && [...document.querySelectorAll('.toasts .toast.error')].length > 0`, 12000), JSON.stringify(await toasts()));
    assert.equal(await evaluate(`document.querySelector('.cp-editor .tiptap').getAttribute('data-marker')`), 'before-send');
    assert.equal((await popCalls()).includes('popout_destroy'), false);
    assert.equal((await sendCalls()).filter((c) => c === 'holdSend').length, 1);
    assert.equal((await sendCalls()).includes('cancel'), false);
  });

  // ---------- Undo keeps the scroll position on every engine (Linux QA D-030: WebKitGTK moved the editor 150 -> 544 a moment AFTER the unlock; Mac and Windows kept it)
  // The engine is simulated: when the pane stops being inert the page scrolls the editor to the caret's end after 30 ms and again after 120 ms, as that engine does.
  await windowOf({ undo: 3 });
  const top1 = await scrollTop();
  assert.ok(top1 > 0);
  await evaluate(`(() => { const pane = document.querySelector('.compose-pane'); const box = document.querySelector('.cp-editor'); new MutationObserver(() => { if (!pane.hasAttribute('inert')) { for (const ms of [30, 120]) setTimeout(() => { box.scrollTop = box.scrollHeight; }, ms); } }).observe(pane, { attributes: true, attributeFilter: ['inert'] }); return 1; })()`);
  assert.ok(await clickSend());
  assert.ok(await waitFor(`document.querySelectorAll('.toasts .toast-undo').length === 1`, 5000));
  await evaluate(`document.querySelector('.toasts .toast-undo').click(); 1`);
  assert.ok(await waitFor(`!document.querySelector('.compose-pane')?.hasAttribute('inert')`, 5000), 'still locked');
  await sleep(900);
  await check('Undo: the scroll position is the one at Send (within 1 px) although the engine scrolls to the caret afterwards; the caret is back in the body', async () => {
    const top = await scrollTop();
    assert.ok(Math.abs(top - top1) <= 1, `scrollTop ${top1} -> ${top}`);
    assert.equal(await evaluate(`!!document.activeElement?.closest?.('.ProseMirror')`), true);
  });
  // D-041 (Linux QA: scrollTop read 557 for the first 1 to 2 frames, 4 to 36 ms, before the 150 came back: a visible flash). The engine moves the caret into view in the next
  // layout after the focus call. Simulated: the move happens at the first layout flush after the unlock - a script reading `offsetHeight` of the pane, or else the frame's own
  // layout, which comes after the animation frame callbacks and before the paint, where no page code can undo it. Every frame is sampled once it was drawn. The unlock flushes the
  // layout itself before it puts the position back, so no drawn frame is off (without the flush the first drawn frame reads the end position).
  await windowOf({ undo: 3 });
  const top2 = await scrollTop();
  assert.ok(top2 > 0);
  await evaluate(`(() => { const pane = document.querySelector('.compose-pane'); const box = document.querySelector('.cp-editor'); let pending = false; window.__drawn = null;
    const reveal = () => { box.scrollTop = box.scrollHeight; };
    const sample = () => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => { window.__drawn.push(box.scrollTop); if (window.__drawn.length < 30) sample(); }; ch.port2.postMessage(0); });
    Object.defineProperty(pane, 'offsetHeight', { get() { if (pending) { pending = false; reveal(); } return 400; } });
    const remove = pane.removeAttribute.bind(pane);
    pane.removeAttribute = (n) => { remove(n); if (n === 'inert' && !window.__drawn) { pending = true; window.__drawn = []; queueMicrotask(() => requestAnimationFrame(() => { if (pending) { pending = false; reveal(); } })); sample(); } };
    return 1; })()`);
  assert.ok(await clickSend());
  assert.ok(await waitFor(`document.querySelectorAll('.toasts .toast-undo').length === 1`, 5000));
  await evaluate(`document.querySelector('.toasts .toast-undo').click(); 1`);
  assert.ok(await waitFor(`(window.__drawn || []).length >= 30`, 8000), 'no frames were sampled after Undo');
  await check('Undo: no drawn frame shows another scroll position than the one at Send (the engine moves the caret into view at the next layout)', async () => {
    const drawn = await evaluate(`window.__drawn`);
    const off = drawn.filter((v) => Math.abs(v - top2) > 1);
    assert.equal(off.length, 0, `position at Send ${top2}, frames drawn: ${drawn.join(',')}`);
  });
  await check('the unlock runs before the browser draws (layout effect) and flushes the layout before it puts the scroll position back (D-041, source guard)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/components/Compose.tsx', import.meta.url), 'utf8');
    const at = src.indexOf('const wasLocked = useRef(false);');
    const eff = src.slice(at, src.indexOf('}, [locked]);', at));
    assert.ok(/useLayoutEffect\(\(\) => \{\s*if \(locked\)/.test(eff), 'the unlock effect is not a layout effect');
    // (the hold itself is the function holdScrolls, shared with the inline pane that Undo makes again, D-053)
    assert.ok(eff.includes('holdScrolls(scrollsWas.current'), 'the unlock does not hold the scroll positions');
    const hold = src.slice(src.indexOf('function holdScrolls('), src.indexOf('export function Compose('));
    assert.ok(hold.indexOf('.offsetHeight') > 0 && hold.indexOf('.offsetHeight') < hold.indexOf('put();'), 'the layout is not flushed before the position is put back');
    assert.ok(hold.includes('document.addEventListener("scroll", put, true)'), 'a later move is not undone at once');
  });
  await check('a person scrolling after Undo is not fought: the wheel moves the editor', async () => {
    await evaluate(`document.querySelector('.cp-editor').dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true })); document.querySelector('.cp-editor').scrollTop = 20; 1`);
    await sleep(500);
    assert.ok(Math.abs((await scrollTop()) - 20) <= 1, String(await scrollTop()));
  });

  // ---------- X during the send hides the window, the send goes on
  await windowOf({ undo: 3 });
  assert.ok(await clickSend());
  assert.ok(await waitFor(`document.querySelectorAll('.toasts .toast-undo').length === 1`, 5000));
  await evaluate(`window.__mockEmit('tauri://close-requested', null); 1`);
  await sleep(600);
  await check('X while locked: the window is hidden (parked), no question, the send goes on and the window ends when it is over', async () => {
    assert.ok((await popCalls()).includes('popout_park'));
    assert.equal(await evaluate(`!!document.querySelector('[role=alertdialog]')`), false);
    assert.ok(await waitFor(`(window.__popoutCalls || []).includes('popout_destroy')`, 8000), 'the window did not end');
    assert.equal((await sendCalls()).filter((c) => c === 'holdSend').length, 1);
  });

  // ---------- Ctrl+Shift+O and Ctrl+Z while locked do nothing
  await windowOf({ undo: 3 });
  const textBefore = await editorText();
  assert.ok(await clickSend());
  assert.ok(await waitFor(`document.querySelector('.compose-pane')?.hasAttribute('inert')`, 5000));
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
  await sleep(300);
  await check('Ctrl+Z while locked does nothing', async () => assert.equal(await editorText(), textBefore));

  // ---------- the main window: the Undo toast stays as long as the message is held
  for (const secs of [5, 20]) {
    await H.openApp('lang=en', 1280, 800);
    await evaluate(`window.__store.getState().setPrefs({ undoSeconds: ${secs} }); window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000));
    await sleep(700);
    await evaluate(`document.querySelector('.cp-editor .tiptap').editor.commands.insertContent('Some words'); 1`);
    assert.ok(await clickSend());
    assert.ok(await waitFor(`window.__store.getState().toasts.some((t) => t.undo)`, 5000), 'no Undo toast');
    await check(`main window, Undo send ${secs} s: the Undo toast stays exactly ${secs} s (not the archive/delete Undo time)`, async () => {
      assert.equal(await evaluate(`window.__store.getState().toasts.find((t) => t.undo).ttl`), secs * 1000);
      assert.notEqual(await evaluate(`window.__store.getState().prefs.undoActionSeconds * 1000`), secs * 1000, 'the test does not tell the two settings apart');
    });
  }
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-popout-send: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-popout-send: ok');
