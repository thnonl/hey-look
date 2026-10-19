#!/usr/bin/env node
// Cmd+Option+1 / 2 / 3 on a Mac (Mac QA 1.0.7 D-024, P2): the Styles menu says "Heading 1  Cmd+Alt+1" and the key did nothing. With Option held a Mac reports the
// character Option+digit types ("¡" for 1, "™" for 2, "£" for 3) as `key`, so the check for the digit failed, `keyAction` answered "editor-skip" (the Cmd+Option guard that keeps
// the editor's code block / paragraph shortcuts off) and the editor never saw the key. Now the physical key (`code`: Digit1..3) decides when Cmd and Option are down and Ctrl is not;
// Windows and Linux (Ctrl+Alt+1..3, where "²" / "³" are AltGr characters) work as before.
//
// Real editor in the dev preview. The Mac is simulated the way WebKit delivers the key: a keydown to the editor with key "¡", code "Digit1", keyCode 49, metaKey and altKey,
// and `navigator.platform` reading MacIntel from the first script of the page on (ProseMirror reads it once to make "Mod" mean Cmd).
//   node scripts/test-mac-heading-keys.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-mac-heading-keys', { vitePort0: 5940 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 400)); } };
const ED = `document.querySelector('.ProseMirror').editor`;

async function open(mac) {
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: String(globalThis.__scriptId ?? '') }).catch(() => {});
  if (mac) { const r = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });` }); globalThis.__scriptId = r.identifier; }
  await H.openApp(`lang=en${mac ? '&os=macos' : ''}`, 1280, 720);
  await evaluate(`window.__store.getState().openCompose({ to: [], subject: 's', bodyHtml: '' }); 1`);
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('.ProseMirror')?.editor`)); i++) await sleep(100);
  await sleep(400);
}
/** The block the caret is in after a key press (and whether the page claimed the key). */
const press = (init) => evaluate(`(() => {
  const e = document.querySelector('.ProseMirror'); const ed = ${ED};
  ed.commands.setContent('<p>Title</p>'); ed.commands.focus('end'); e.focus();
  const k = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}));
  e.dispatchEvent(k);
  e.dispatchEvent(new KeyboardEvent('keyup', Object.assign({ bubbles: true }, ${JSON.stringify(init)})));
  const b = ed.state.selection.$from.parent;
  return JSON.stringify({ block: b.type.name + (b.attrs.level ? b.attrs.level : ''), prevented: k.defaultPrevented });
})()`).then(JSON.parse);

try {
  await open(true);
  for (const [n, key] of [[1, '¡'], [2, '™'], [3, '£']]) {
    await check(`mac: Cmd+Option+${n} (key "${key}", code Digit${n}, keyCode ${48 + n}) makes Heading ${n}`, async () => {
      const r = await press({ key, code: `Digit${n}`, keyCode: 48 + n, metaKey: true, altKey: true });
      assert.equal(r.block, `heading${n}`, JSON.stringify(r));
      assert.equal(r.prevented, true);
    });
  }
  await check('mac: another layout (the digit on the key: AZERTY "&" for 1) works too', async () => assert.equal((await press({ key: '&', code: 'Digit1', keyCode: 49, metaKey: true, altKey: true })).block, 'heading1'));
  await check('mac: the other Cmd+Option keys stay off (4, 5, 0, C, shift+1)', async () => {
    for (const init of [{ key: '¢', code: 'Digit4', keyCode: 52 }, { key: '∞', code: 'Digit5', keyCode: 53 }, { key: 'º', code: 'Digit0', keyCode: 48 }, { key: 'ç', code: 'KeyC', keyCode: 67 }, { key: '⁄', code: 'Digit1', keyCode: 49, shiftKey: true }]) {
      const r = await press({ ...init, metaKey: true, altKey: true });
      assert.equal(r.block, 'paragraph', JSON.stringify([init, r]));
    }
  });
  await check('mac: Ctrl+Option+1 (no Cmd) is not a heading key', async () => assert.equal((await press({ key: '¡', code: 'Digit1', keyCode: 49, ctrlKey: true, altKey: true })).block, 'paragraph'));
  await check('mac: Cmd+1 and Option+1 alone are not heading keys', async () => {
    assert.equal((await press({ key: '1', code: 'Digit1', keyCode: 49, metaKey: true })).block, 'paragraph');
    assert.equal((await press({ key: '¡', code: 'Digit1', keyCode: 49, altKey: true })).block, 'paragraph');
  });

  // Windows / Linux: Ctrl+Alt+1..3 with the digit as `key` (as before); the AltGr characters of a German layout are not heading keys
  await open(false);
  for (const n of [1, 2, 3]) await check(`windows/linux: Ctrl+Alt+${n} makes Heading ${n}`, async () => assert.equal((await press({ key: String(n), code: `Digit${n}`, keyCode: 48 + n, ctrlKey: true, altKey: true })).block, `heading${n}`));
  await check('windows/linux: AltGr+2 / AltGr+3 (key "²" / "³", Ctrl+Alt) are not heading keys', async () => {
    assert.equal((await press({ key: '²', code: 'Digit2', keyCode: 50, ctrlKey: true, altKey: true })).block, 'paragraph');
    assert.equal((await press({ key: '³', code: 'Digit3', keyCode: 51, ctrlKey: true, altKey: true })).block, 'paragraph');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-mac-heading-keys: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-mac-heading-keys: ok');
