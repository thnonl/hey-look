#!/usr/bin/env node
// 1.0.7 D-021 in the dev preview (`#os=` plays the system): Ctrl+Q on Linux tells the backend (the `quit-key` event, which the backend answers with the tray's quit);
//   Windows and macOS never send it, other chords (Ctrl+Shift+Q, Alt+Q, Ctrl+W, Ctrl+A on a layout whose Q key makes an "a", a held key) do not either, it works with the
//   focus in a text box and in the document of a message frame (main window and a reader window; a plain and a Confidential mail, also after the mail has changed and the frame is
//   written again: D-112, the frame of a Confidential mail had no guard), and the key press is taken (preventDefault) only where it quits.
//   node scripts/test-quit-key-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-quit-key-ui', { vitePort0: 6180 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };

/** records the events the page emits to the backend */
const spy = () => evaluate(`(() => {
  window.__emits = [];
  if (window.__spied) return 1;
  window.__spied = true;
  const inv = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  window.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => { if (cmd === 'plugin:event|emit') window.__emits.push(args && args.event); return inv(cmd, args, opts); };
  return 1;
})()`);
const emits = () => evaluate(`window.__emits.filter((e) => e === 'quit-key').length`);
const CTRL = 2, ALT = 1, SHIFT = 8, META = 4;
const key = async (k, code, vk, modifiers = CTRL) => {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(120);
};
const FRAME_DOC = `document.querySelector('iframe.msg-frame').contentDocument`;
const FRAME_READY = `!!document.querySelector('iframe.msg-frame')?.contentDocument?.body?.textContent.trim()`;
/** a Ctrl+Q keydown in the frame's document: was it taken? */
const frameKey = () => evaluate(`(() => { const d = ${FRAME_DOC}; const ev = new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', ctrlKey: true, bubbles: true, cancelable: true, view: d.defaultView }); d.body.dispatchEvent(ev); return ev.defaultPrevented; })()`);
/** every message frame of the page: a Ctrl+Q keydown in its document, was it taken? (array, one entry per frame) */
const allFrameKeys = () => evaluate(`[...document.querySelectorAll('iframe.msg-frame')].map((f) => { const d = f.contentDocument; const ev = new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', ctrlKey: true, bubbles: true, cancelable: true, view: d.defaultView }); d.body.dispatchEvent(ev); return ev.defaultPrevented; })`);
/** the page is the real thing when the person focuses a frame and presses the key: the frame gets the focus, the press goes to its document */
const focusFrame = (i) => evaluate(`(() => { const f = document.querySelectorAll('iframe.msg-frame')[${i}]; f.contentWindow.focus(); return f.contentDocument.hasFocus(); })()`);
const frameCount = () => evaluate(`document.querySelectorAll('iframe.msg-frame').length`);
/** opens the thread and waits until its frames hold the text (a frame that still shows the mail before is not the new one) */
const openThread = async (id, needles) => {
  await evaluate(`window.__store.getState().openMail(${JSON.stringify(id)}); 1`);
  const ok = await waitFor(`(() => { const t = [...document.querySelectorAll('iframe.msg-frame')].map((f) => f.contentDocument?.body?.textContent || ''); return ${JSON.stringify(needles)}.every((n) => t.some((x) => x.includes(n))); })()`, 10000);
  assert.ok(ok, `no frame with ${needles} for ${id}`);
  await sleep(500); // (the document is hooked a few ms after it is parsed)
};
const openFirstThread = async () => {
  await evaluate(`document.querySelector('.ml-row')?.click(); 1`);
  assert.ok(await waitFor(FRAME_READY, 10000), 'no message frame');
};

try {
  await check('Linux: Ctrl+Q sends one quit-key per press (any language, Caps Lock too)', async () => {
    for (const lang of ['en', 'ru']) {
      await H.openApp(`lang=${lang}&os=linux`, 1280, 800);
      await spy();
      await key('q', 'KeyQ', 81);
      assert.equal(await emits(), 1, `${lang}: one press`);
      await key('Q', 'KeyQ', 81);
      assert.equal(await emits(), 2, `${lang}: Caps Lock Q`);
    }
  });
  await check('Linux: the other chords do nothing', async () => {
    await H.openApp('lang=en&os=linux', 1280, 800);
    await spy();
    await key('Q', 'KeyQ', 81, CTRL | SHIFT);
    await key('q', 'KeyQ', 81, ALT);
    await key('q', 'KeyQ', 81, CTRL | ALT);
    await key('q', 'KeyQ', 81, 0);
    await key('w', 'KeyW', 87, CTRL);
    await key('a', 'KeyQ', 65, CTRL); // AZERTY: the physical Q key makes an "a": Ctrl+A is not a quit
    assert.equal(await emits(), 0);
  });
  await check('Linux: a layout without Latin letters (Russian) has its physical Q key', async () => {
    await H.openApp('lang=en&os=linux', 1280, 800);
    await spy();
    await key('й', 'KeyQ', 81);
    assert.equal(await emits(), 1);
  });
  await check('Linux: a held key is one press', async () => {
    await H.openApp('lang=en&os=linux', 1280, 800);
    await spy();
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: CTRL });
    for (let i = 0; i < 2; i++) await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: CTRL, autoRepeat: true });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: CTRL });
    await sleep(120);
    assert.equal(await emits(), 1);
  });
  await check('Windows and macOS: no quit-key', async () => {
    for (const os of ['windows', 'macos']) {
      await H.openApp(`lang=en&os=${os}`, 1280, 800);
      await spy();
      await key('q', 'KeyQ', 81, CTRL);
      await key('q', 'KeyQ', 81, META); // (macOS has Cmd+Q in its app menu, not in the page)
      assert.equal(await emits(), 0, os);
    }
  });
  await check('Linux: with the focus in a compose window\'s Subject and body nothing is typed and the key quits', async () => {
    await H.openApp('lang=en&os=linux', 1280, 800);
    await spy();
    await evaluate(`(async () => { await window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello', bodyHtml: '<p>Some text</p>' }); return 1; })()`);
    assert.ok(await waitFor(`!!document.querySelector('.cf-subject input') && !!document.querySelector('.ProseMirror')`), 'no compose');
    await sleep(300);
    const content = () => evaluate(`document.querySelector('.cf-subject input').value + '|' + document.querySelector('.ProseMirror').textContent`);
    const before = await content();
    for (const sel of ['.cf-subject input', '.ProseMirror']) {
      await evaluate(`document.querySelector(${JSON.stringify(sel)}).focus(); window.__emits.length = 0; 1`);
      await key('q', 'KeyQ', 81);
      assert.equal(await emits(), 1, sel);
    }
    assert.equal(await content(), before, 'a q was typed');
  });
  await check('Linux: the document of a message frame (main window and a reader window)', async () => {
    await H.openApp('lang=en&os=linux', 1280, 800);
    await spy();
    await openFirstThread();
    assert.equal(await frameKey(), true, 'the press in the frame is taken');
    await sleep(100);
    assert.equal(await emits(), 1, 'main window frame');
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=t1#lang=en&os=linux` });
    assert.ok(await waitFor(`!!document.querySelector('.reader-win iframe.msg-frame') && ${FRAME_READY}`, 25000), 'no reader frame');
    await spy();
    assert.equal(await frameKey(), true);
    await sleep(100);
    assert.equal(await emits(), 1, 'reader window frame');
    await key('q', 'KeyQ', 81);
    assert.equal(await emits(), 2, 'reader window itself');
  });
  await check('Linux: every frame takes Ctrl+Q - plain and Confidential mail, also after the mail changed (D-112)', async () => {
    await H.openApp('lang=en&os=linux&wp8', 1280, 800);
    await spy();
    const steps = [['tw8-sel', ['Quarterly budget'], 'plain'], ['tconf', ['Revenue is down'], 'Confidential'], ['tw8-sel', ['Quarterly budget'], 'plain again'], ['tconf', ['Revenue is down'], 'Confidential again'], ['tw8-att-conf', ['Four attachments'], 'Confidential with attachments']];
    for (const [id, needles, what] of steps) {
      await openThread(id, needles);
      assert.equal(await frameCount(), 1, what);
      await evaluate('window.__emits.length = 0; 1');
      assert.deepEqual(await allFrameKeys(), [true], `${what}: the press in the frame is taken`);
      await sleep(100);
      assert.equal(await emits(), 1, `${what}: one quit-key (dispatched)`);
      assert.equal(await focusFrame(0), true, `${what}: the frame has the focus`);
      await key('q', 'KeyQ', 81);
      assert.equal(await emits(), 2, `${what}: one more quit-key (real key with the focus in the frame)`);
    }
  });
  await check('Linux: a conversation of a plain and a Confidential message: both frames take Ctrl+Q', async () => {
    await H.openApp('lang=en&os=linux&wp8', 1280, 800);
    await spy();
    await openThread('tw8-mix', ['ZEBRA-CONF']); // (the older message is folded: open it)
    await evaluate(`(document.querySelector('.rp-msg:not(.open) .rp-msg-head') || document.querySelector('.rp-msg:not(.open)')).click(); 1`);
    assert.ok(await waitFor(`document.querySelectorAll('iframe.msg-frame').length === 2 && [...document.querySelectorAll('iframe.msg-frame')].every((f) => f.contentDocument?.body?.textContent.trim())`, 8000), 'no second frame');
    await sleep(500);
    await evaluate('window.__emits.length = 0; 1');
    assert.deepEqual(await allFrameKeys(), [true, true]);
    await sleep(100);
    assert.equal(await emits(), 2, 'one quit-key per press');
    for (const i of [0, 1]) {
      assert.equal(await focusFrame(i), true, `frame ${i} has the focus`);
      await key('q', 'KeyQ', 81);
    }
    assert.equal(await emits(), 4);
  });
  await check('Linux: the frame of a reader window takes Ctrl+Q - plain and Confidential mail', async () => {
    for (const [thread, needle] of [['t1', ''], ['tconf', 'Revenue is down']]) {
      await cdp('Page.navigate', { url: 'about:blank' });
      await cdp('Page.navigate', { url: `${H.base}?w=reader&thread=${thread}#lang=en&os=linux` });
      assert.ok(await waitFor(`!!document.querySelector('.reader-win iframe.msg-frame') && ${FRAME_READY} && document.querySelector('iframe.msg-frame').contentDocument.body.textContent.includes(${JSON.stringify(needle)})`, 25000), `no reader frame for ${thread}`);
      await sleep(500);
      await spy();
      assert.deepEqual(await allFrameKeys(), [true], `${thread}: taken`);
      await sleep(100);
      assert.equal(await emits(), 1, `${thread}: dispatched`);
      assert.equal(await focusFrame(0), true);
      await key('q', 'KeyQ', 81);
      assert.equal(await emits(), 2, `${thread}: real key`);
    }
  });
  await check('Windows: a press in the frame is not taken and sends nothing', async () => {
    await H.openApp('lang=en&os=windows', 1280, 800);
    await spy();
    await openFirstThread();
    assert.equal(await frameKey(), false);
    assert.equal(await emits(), 0);
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-quit-key-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-quit-key-ui: ok');
