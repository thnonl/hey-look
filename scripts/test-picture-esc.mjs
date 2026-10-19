#!/usr/bin/env node
// Esc from the picture toolbar keeps the picture selected (Linux QA 1.0.7 D-033, AC-2.18.1): the focus goes back to the text and Delete removes the picture. On WebKitGTK the engine
// put the caret at the start of the text a moment after the focus call, the selection became a text selection and the toolbar went. Chromium does not do that, so the engine is
// simulated: when the editor gets the focus, 10 ms later (and again at 60 ms) the DOM selection is collapsed to the start of the first paragraph, which is what ProseMirror reads
// as the new selection. Real key events (Alt+F10, Esc, Delete) in the real Compose of the dev preview.
//   node scripts/test-picture-esc.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-picture-esc', { vitePort0: 5990 });
const { evaluate } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 500)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(js)) return true; await sleep(100); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const key = async (k, code, vk, modifiers = 0) => {
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await H.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(80);
};
const ED = `document.querySelector('.cp-editor .tiptap').editor`;
const PNG = `(() => { const k = document.createElement('canvas'); k.width = 300; k.height = 140; const g = k.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 300, 140); return k.toDataURL('image/png'); })()`;
const st = () => json(`(() => { const e = ${ED}; const s = e.state.selection; let imgs = 0; e.state.doc.descendants((n) => { if (n.type.name === 'image') imgs++; }); return { node: s.node?.type.name ?? null, imgs, toolbar: !!document.querySelector('.img-tools'), focus: !!document.activeElement?.closest('.ProseMirror') }; })()`);

try {
  for (const engine of ['plain', 'gtk-like']) {
    await H.openApp('lang=en', 1280, 800);
    await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Esc', bodyHtml: '<p>Intro text</p>' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 15000), 'compose did not start');
    await sleep(900);
    await evaluate(`(() => { const e = ${ED}; e.commands.focus('end'); e.commands.insertContent({ type: 'image', attrs: { src: ${PNG}, alt: '', width: 300 } }); let p = -1; e.state.doc.descendants((n, pos) => { if (p < 0 && n.type.name === 'image') p = pos; }); e.chain().focus().setNodeSelection(p).run(); return 1; })()`);
    await sleep(400);
    if (engine === 'gtk-like') {
      await evaluate(`(() => { const dom = ${ED}.view.dom; dom.addEventListener('focus', () => { for (const ms of [10, 60]) setTimeout(() => { const p = dom.querySelector('p'); const r = document.createRange(); r.setStart(p.firstChild, 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, ms); }); return 1; })()`);
    }
    await check(`${engine}: the picture is selected and the toolbar shows`, async () => { const s = await st(); assert.equal(s.node, 'image'); assert.equal(s.toolbar, true); });
    await key('F10', 'F10', 121, 1);
    await sleep(200);
    await check(`${engine}: Alt+F10 puts the focus on the toolbar`, async () => assert.equal(await evaluate(`!!document.activeElement?.closest('.img-tools')`), true));
    await key('Escape', 'Escape', 27);
    await sleep(500);
    await check(`${engine}: Esc: the focus is in the text, the picture is still selected, the toolbar is still there`, async () => { const s = await st(); assert.deepEqual([s.focus, s.node, s.toolbar, s.imgs], [true, 'image', true, 1], JSON.stringify(s)); });
    await key('Delete', 'Delete', 46);
    await sleep(300);
    await check(`${engine}: Delete removes the picture`, async () => assert.equal((await st()).imgs, 0));
  }
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-picture-esc: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-picture-esc: ok');
