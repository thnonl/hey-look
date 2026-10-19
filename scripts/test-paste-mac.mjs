#!/usr/bin/env node
// Cmd+Shift+V on macOS (QA Mac, confirmed twice: it pasted NOTHING while Cmd+V worked). WKWebView sends no `paste` event for Cmd+Shift+V: it is not an
// accelerator of any item of the Edit menu (the app's Edit menu is tauri's default: Undo, Redo, Cut, Copy, Paste, Select All; Cmd+V is Paste's key and
// the menu turns it into a `paste:` that makes the event), so the key is an ordinary key press with no action. The editors now catch it on a Mac
// (src/editor/pasteOptions.tsx), read the clipboard text through the backend command read_clipboard_text (src-tauri/src/macclip.rs) and paste it as plain text.
//
// This drives the real editor in the dev preview with `#os=macos` and the mock backend's clipboard (window.__mockClipboard), and simulates the WebKit
// order: a key press with Cmd+Shift+V, NO paste event; and the order where a paste event does arrive too (after the key, in the same turn). It asserts that
// the text lands once, as plain text (no bold, no Paste options button), that the key is claimed on a Mac only, that Cmd+V / Cmd+C / Cmd+X / Cmd+A /
// Cmd+Shift+Z... keys are left alone (the Edit menu must keep delivering them), that Cmd+Option+Shift+V ("Paste and Match Style", W2.24) does exactly what Cmd+Shift+V does while every other Cmd+Option key stays blocked, that Linux (W2.23) pastes the HTML of an HTML-only clipboard as text when
// Ctrl+Shift+V pasted nothing and does not paste twice when the paste event did arrive, and that Windows behaviour has not changed.
//   node scripts/test-paste-mac.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-paste-mac', { vitePort0: 5850, cdpPort0: 9850 });
const { evaluate, cdp } = H;
const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };
const ED = `document.querySelector('.ProseMirror').editor`;
const open = async (os) => {
  await H.openApp(`lang=en${os ? `&os=${os}` : ''}`, 1280, 720);
  await evaluate(`window.__store.getState().openCompose({ to: [], subject: 's', bodyHtml: '' }); 1`);
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('.ProseMirror')?.editor`)); i++) await sleep(100);
  await sleep(300);
  await evaluate(`${ED}.commands.focus('end'); 1`);
};
const setClip = (text, html) => evaluate(`window.__mockClipboard = ${JSON.stringify({ text, html })}; window.__readCalls = 0; 1`);
const doc = async () => JSON.parse(await evaluate(`JSON.stringify({ html: ${ED}.getHTML().replace(/<div data-sig-block[^>]*><\\/div>/g, '').replace(/<p><\\/p>/g, ''), text: ${ED}.getText(), button: !!document.querySelector('.paste-opt'), bold: ${ED}.isActive('bold') })`));
/** A key press the way WebKit delivers it: keydown to the editor; true when the page claimed it (preventDefault). */
const press = (key, code, mods, alsoPaste) => evaluate(`(() => {
  const e = document.querySelector('.ProseMirror'); e.focus();
  const k = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, ${mods}, bubbles: true, cancelable: true });
  e.dispatchEvent(k);
  ${alsoPaste ? `const dt = new DataTransfer(); dt.setData('text/html', '<p><b>FROM THE PASTE EVENT</b></p>'); dt.setData('text/plain', 'FROM THE PASTE EVENT'); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));` : ''}
  e.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, ${mods}, bubbles: true }));
  return k.defaultPrevented;
})()`);
const CMD_SHIFT = 'metaKey: true, shiftKey: true';

try {
  // ---- macOS: Cmd+Shift+V with no paste event (what WKWebView does)
  await open('macos');
  await setClip('Plain line\n\nSecond line', '<p><b>Plain line</b></p><p>Second line</p>');
  let claimed = await press('V', 'KeyV', CMD_SHIFT, false);
  await sleep(400);
  let d = await doc();
  check('mac: the key is claimed (no native default)', () => assert.equal(claimed, true));
  check('mac: the clipboard text is pasted as plain text, paragraph by paragraph', () => { assert.equal(d.html, '<p>Plain line</p><p>Second line</p>'); });
  check('mac: no Paste options button after a text-only paste, caret not bold', () => { assert.equal(d.button, false); assert.equal(d.bold, false); });

  // ---- the order where a paste event arrives as well, right after the key: one paste, from the clipboard, not from the event
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('Only once', '');
  await press('V', 'KeyV', CMD_SHIFT, true);
  await sleep(400);
  d = await doc();
  check('mac: a paste event after the key does not paste a second time', () => assert.equal(d.html, '<p>Only once</p>'));

  // ---- a clipboard with HTML only (no plain text part)
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('', '<ul><li>one</li><li>two</li></ul>');
  await press('V', 'KeyV', CMD_SHIFT, false);
  await sleep(400);
  d = await doc();
  check('mac: HTML-only clipboard becomes plain text (list markers kept)', () => { assert.equal(d.text.includes('one') && d.text.includes('two'), true); assert.ok(!/<(ul|li|strong)/.test(d.html), d.html); });

  // ---- an empty clipboard (or a picture only): nothing happens, no error
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('', '');
  await press('V', 'KeyV', CMD_SHIFT, false);
  await sleep(300);
  d = await doc();
  check('mac: nothing to paste: nothing pasted', () => assert.equal(d.html, ''));

  // ---- another keyboard layout (the letter V is not on the V key)
  await setClip('Match style', '');
  await press('v', 'Period', CMD_SHIFT, false);
  await sleep(300);
  d = await doc();
  check('mac: another layout (the letter V on another key) works', () => assert.equal(d.html, '<p>Match style</p>'));

  // ---- W2.24: Cmd+Option+Shift+V is the same key ("Paste and Match Style"); with Option held the key reads "◊" and the physical V decides
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('Match and style', '<p><b>Match</b> and style</p>');
  claimed = await press('◊', 'KeyV', 'metaKey: true, shiftKey: true, altKey: true', false);
  await sleep(400);
  d = await doc();
  check('mac: Cmd+Option+Shift+V is claimed and pastes the clipboard as plain text', () => { assert.equal(claimed, true); assert.equal(d.html, '<p>Match and style</p>'); assert.equal(d.bold, false); assert.equal(d.button, false); });
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('', '<ul><li>one</li><li>two</li></ul>');
  await press('◊', 'KeyV', 'metaKey: true, shiftKey: true, altKey: true', false);
  await sleep(400);
  d = await doc();
  check('mac: Cmd+Option+Shift+V with an HTML-only clipboard: the HTML as text', () => { assert.ok(d.text.includes('one') && d.text.includes('two')); assert.ok(!/<(ul|li)/.test(d.html), d.html); });
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('Must not appear', '');
  for (const [key, code, mods] of [['ç', 'KeyC', 'metaKey: true, shiftKey: true, altKey: true'], ['√', 'KeyV', 'metaKey: true, altKey: true'], ['◊', 'KeyV', 'metaKey: true, shiftKey: true, altKey: true, ctrlKey: true']]) {
    const c = await press(key, code, mods, false);
    await sleep(200);
    d = await doc();
    check(`mac: ${mods.replace(/: true/g, '').replace(/Key/g, '')} + ${code} stays blocked: nothing is pasted`, () => { assert.equal(c, false); assert.equal(d.html, ''); });
  }

  // ---- the plain keys the Edit menu delivers are left alone, and the paste event of Cmd+V still works, with its Paste options button
  for (const [key, code, mods] of [['v', 'KeyV', 'metaKey: true'], ['c', 'KeyC', 'metaKey: true'], ['x', 'KeyX', 'metaKey: true'], ['a', 'KeyA', 'metaKey: true'], ['z', 'KeyZ', CMD_SHIFT], ['b', 'KeyB', 'metaKey: true']]) {
    const c = await press(key, code, mods, false);
    check(`mac: Cmd${mods.includes('shift') ? '+Shift' : ''}+${key.toUpperCase()} is not claimed`, () => assert.equal(c, false));
  }
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await evaluate(`(() => { const e = document.querySelector('.ProseMirror'); e.focus(); const dt = new DataTransfer(); dt.setData('text/html', '<p><b>Rich</b></p>'); dt.setData('text/plain', 'Rich'); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(300);
  d = await doc();
  check('mac: Cmd+V (a paste event) is the normal rich paste with its options button', () => { assert.match(d.html, /<strong>Rich<\/strong>/); assert.equal(d.button, true); });
  // a Cmd+V pressed soon after a Cmd+Shift+V is a paste of its own (the window that drops the duplicate event is a few ms)
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('first', '');
  await press('V', 'KeyV', CMD_SHIFT, false);
  await sleep(400);
  await evaluate(`(() => { const e = document.querySelector('.ProseMirror'); const dt = new DataTransfer(); dt.setData('text/plain', 'second'); e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(200);
  d = await doc();
  check('mac: a later Cmd+V is not swallowed', () => assert.equal(d.html, '<p>firstsecond</p>'));

  // ---- a real key press through the browser's input pipeline (the page sees what a person's key gives it)
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('Real key', '');
  await evaluate(`document.querySelector('.ProseMirror').focus(); 1`);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'V', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4 | 8 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'V', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4 | 8 });
  await sleep(400);
  d = await doc();
  check('mac: a real Cmd+Shift+V key press pastes', () => assert.equal(d.html, '<p>Real key</p>'));

  // ---- a plain text box (Subject): the same key pastes the text, line breaks as spaces, through the page's own input handling (React sees it)
  await setClip('Line one\nLine two', '');
  const pressIn = (mods) => evaluate(`(() => { const i = document.querySelector('input[aria-label="Subject"]'); i.focus(); i.select(); const k = new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ${mods}, bubbles: true, cancelable: true }); i.dispatchEvent(k); return k.defaultPrevented; })()`);
  claimed = await pressIn(CMD_SHIFT);
  await sleep(300);
  check('mac: Subject: the key is claimed', () => assert.equal(claimed, true));
  const subject = await evaluate(`document.querySelector('input[aria-label="Subject"]').value`);
  check('mac: Subject: the clipboard text, line break as a space', () => assert.equal(subject, 'Line one Line two'));
  claimed = await pressIn('metaKey: true');
  check('mac: Subject: Cmd+V is left to the Edit menu', () => assert.equal(claimed, false));

  // ---- Edit > Paste and Match Style (the native menu item, D-026): the menu only tells the page (event mac-paste-match); the page does what the key does
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('From the menu', '<p><b>From the menu</b></p>');
  await evaluate("document.querySelector('.ProseMirror').focus(); import('/src/plainPasteKey.ts').then((m) => m.pasteMatchStyle()); 1");
  await sleep(500);
  d = await doc();
  check('mac menu: Paste and Match Style in the body pastes the clipboard text as plain text, once', () => { assert.equal(d.html, '<p>From the menu</p>'); assert.equal(d.button, false); assert.equal(d.bold, false); });
  await setClip('Menu line one\nMenu line two', '');
  await evaluate("(() => { const i = document.querySelector('input[aria-label=\"Subject\"]'); i.focus(); i.select(); return import('/src/plainPasteKey.ts').then((m) => m.pasteMatchStyle()); })()");
  await sleep(400);
  const subj2 = await evaluate("document.querySelector('input[aria-label=\"Subject\"]').value");
  check('mac menu: Paste and Match Style in the Subject box pastes the text (line break as a space)', () => assert.equal(subj2, 'Menu line one Menu line two'));
  await evaluate("document.activeElement?.blur(); import('/src/plainPasteKey.ts').then((m) => m.pasteMatchStyle()); 1");
  await sleep(300);
  const subj3 = await evaluate("document.querySelector('input[aria-label=\"Subject\"]').value");
  check('mac menu: with nothing that takes text focused it does nothing', () => assert.equal(subj3, 'Menu line one Menu line two'));

  // ---- Windows (the default): the key is the page's, not claimed (Ctrl+Shift+V works through the paste event, tested in test-paste-options.mjs)
  await open(null);
  await setClip('Must not appear', '');
  claimed = await press('V', 'KeyV', CMD_SHIFT, false);
  await sleep(300);
  d = await doc();
  check('windows: Meta+Shift+V is not claimed and pastes nothing', () => { assert.equal(claimed, false); assert.equal(d.html, ''); });
  claimed = await press('V', 'KeyV', 'ctrlKey: true, shiftKey: true', false);
  check('windows: Ctrl+Shift+V is not claimed (the paste event does it)', () => assert.equal(claimed, false));
  claimed = await press('V', 'KeyV', 'ctrlKey: true, altKey: true, shiftKey: true', false);
  await sleep(300);
  d = await doc();
  check('windows: Ctrl+Alt+Shift+V (AltGr+Shift+V) is not claimed and pastes nothing', () => { assert.equal(claimed, false); assert.equal(d.html, ''); });
  // ---- W2.23, Windows: a normal copy from a browser (both flavours) still pastes plain text through the paste event
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await press('V', 'KeyV', 'ctrlKey: true, shiftKey: true', true);
  await sleep(400);
  d = await doc();
  check('windows: Ctrl+Shift+V with a paste event pastes its text once, plain', () => { assert.equal(d.html, '<p>FROM THE PASTE EVENT</p>'); assert.equal(d.button, false); });

  // ---- W2.23, Linux: WebKitGTK pastes "as plain text" from the text part only. A clipboard with HTML only pastes nothing and may send no paste event: after the key the backend's clipboard is read
  await open('linux');
  await setClip('', '<ol><li>one</li><li>two</li></ol><p>after</p>');
  claimed = await press('V', 'KeyV', 'ctrlKey: true, shiftKey: true', false);
  check('linux: Ctrl+Shift+V is not claimed', () => assert.equal(claimed, false));
  await sleep(700);
  d = await doc();
  check('linux: an HTML-only clipboard is pasted as text (list markers, no formatting, no Paste options button)', () => { assert.match(d.text, /1. one/); assert.match(d.text, /2. two/); assert.ok(d.text.includes('after')); assert.ok(!/<(ol|ul|li|strong)/.test(d.html), d.html); assert.equal(d.button, false); });
  // the paste event did arrive: it pastes, the backend is not asked (no second paste)
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('From the backend', '<p>From the backend</p>');
  await press('V', 'KeyV', 'ctrlKey: true, shiftKey: true', true);
  await sleep(700);
  d = await doc();
  const reads = await evaluate(`window.__readCalls`);
  check('linux: with a paste event the text lands once and the backend clipboard is not pasted as well', () => { assert.equal(d.html, '<p>FROM THE PASTE EVENT</p>'); assert.equal(reads, 0, 'the backend was not asked'); });
  // nothing in either flavour: nothing happens, no error
  await evaluate(`${ED}.commands.clearContent(); 1`);
  await setClip('', '');
  await press('V', 'KeyV', 'ctrlKey: true, shiftKey: true', false);
  await sleep(700);
  d = await doc();
  check('linux: an empty clipboard pastes nothing, no error toast', () => { assert.equal(d.html, ''); });
  // Cmd+Shift+V is not a Linux key
  await setClip('Must not appear', '');
  claimed = await press('V', 'KeyV', CMD_SHIFT, false);
  await sleep(500);
  d = await doc();
  check('linux: Meta+Shift+V pastes nothing', () => { assert.equal(claimed, false); assert.equal(d.html, ''); });
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-paste-mac: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-paste-mac: ok');
