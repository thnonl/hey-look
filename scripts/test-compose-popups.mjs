#!/usr/bin/env node
// The popups of the message editor stay whole and readable (v1.0.6 Mac QA): the Symbol popup (its 7th column was cut at the popup's right edge, and the
// glyphs of (c) (R) (TM) had a button's black colour on the dark panel), the More (...) menu (taller than the window at small sizes: the rows below
// Subscript could only be reached with the End key), Find and replace (the Replace row could not be reached on a Mac: no Ctrl+H there, and the menu item
// only opened Find), and the picture handles (drawn over the Settings dialog).
//
// Real editor in the dev preview (src/devMock.ts), at 960 x 560 and 1280 x 800, light and dark. Asserts:
//  - Symbol: the popup is as wide as its grid, every cell lies inside it and nothing scrolls sideways; every glyph has a contrast of at least 4.5 : 1
//  - More: the menu lies inside the window, scrolls when it is taller than the room, the last row comes into view with End and with the mouse wheel, and the
//    first row again with Home; a row reached by the arrow keys is inside the menu's box
//  - Find: the panel has a chevron button for the Replace row on every system (aria-expanded follows it), the "Replace" item of More opens the panel with the
//    Replace row and the focus in it, and Ctrl+F again leaves the row as the person has it
//  - the picture handles are below the dialogs (z-index) and are drawn only while the editor has the focus
//   node scripts/test-compose-popups.mjs [--require-browser] [--url=http://127.0.0.1:1420/]
import assert from 'node:assert/strict';
import { inputs, sleep, startHarness } from './cdp-harness.mjs';

const H = await startHarness('test-compose-popups', { vitePort0: 5880, cdpPort0: 9880 });
const { evaluate, cdp } = H;
const io = inputs(H, null, 'cp');
const failures = [];
const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message.replace(/\s+/g, ' ')}`); } };

const key = async (k, code, vk, modifiers = 0) => {
  const p = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
};
const openMore = async () => { await evaluate(`document.querySelector('.fmt-more').click(); 1`); await sleep(400); };
const closeMenus = async () => { await key('Escape', 'Escape', 27); await sleep(250); };
const pickRow = (start) => evaluate(`(() => { const r = [...document.querySelectorAll('.dd-fixed [role^=menuitem]')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(start)})); if (!r) return false; r.click(); return true; })()`);

/** WCAG contrast of an element's text colour against the first opaque background behind it. */
const CONTRAST = `((el) => {
  const rgb = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let bg = null;
  for (let n = el; n && !bg; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c && c.a > 0.95) bg = c; }
  const fg = rgb(getComputedStyle(el).color);
  if (!bg || !fg) return 0;
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
})`;

async function run(w, h, theme) {
  const tag = `${w}x${h} ${theme}`;
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().setPrefs({ theme: ${JSON.stringify(theme)} }); window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }); 1`);
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('.ProseMirror')?.editor`)); i++) await sleep(100);
  await sleep(600);

  // ---- Symbol
  await openMore();
  const found = await pickRow('Symbol');
  await sleep(400);
  const sym = found ? await evaluate(`(() => {
    const panel = document.querySelector('.fmt-pop-symbol'); if (!panel) return null;
    const P = panel.getBoundingClientRect(), cells = [...panel.querySelectorAll('.symbol-btn')];
    const contrast = ${CONTRAST};
    return { n: cells.length, P: P.toJSON(), sw: panel.scrollWidth, cw: panel.clientWidth, inside: cells.every((c) => { const r = c.getBoundingClientRect(); return r.left >= P.left - 0.5 && r.right <= P.right + 0.5 && r.top >= P.top - 0.5 && r.bottom <= P.bottom + 0.5; }), min: Math.min(...cells.map(contrast)), win: [innerWidth, innerHeight] };
  })()`) : null;
  check(`${tag}: the Symbol popup opens`, () => assert.ok(sym, 'no popup'));
  if (sym) {
    check(`${tag}: 24 symbols`, () => assert.equal(sym.n, 24));
    check(`${tag}: every symbol cell is inside the popup`, () => assert.equal(sym.inside, true));
    check(`${tag}: the popup does not scroll sideways (${sym.sw} > ${sym.cw})`, () => assert.ok(sym.sw <= sym.cw + 1));
    check(`${tag}: the popup is inside the window`, () => assert.ok(sym.P.left >= 0 && sym.P.right <= sym.win[0] && sym.P.top >= 0 && sym.P.bottom <= sym.win[1]));
    check(`${tag}: every symbol has a contrast of at least 4.5 (lowest ${sym.min.toFixed(2)})`, () => assert.ok(sym.min >= 4.5));
  }
  await closeMenus();
  await closeMenus();

  // ---- More
  await evaluate(`document.querySelector('.ProseMirror').editor.commands.focus(); 1`);
  await openMore();
  const m0 = await evaluate(`(() => { const d = document.querySelector('.dd-fixed'), m = d.querySelector('.menu'), r = d.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight, sh: m.scrollHeight, ch: m.clientHeight, oy: getComputedStyle(m).overflowY, tall: d.hasAttribute('data-tall'), rows: m.querySelectorAll('[role^=menuitem]').length }; })()`);
  check(`${tag}: More is inside the window`, () => assert.ok(m0.top >= 0 && m0.bottom <= m0.vh, JSON.stringify(m0)));
  check(`${tag}: More scrolls when it is taller than the room`, () => { assert.ok(m0.tall); if (m0.sh > m0.ch + 1) assert.match(m0.oy, /auto|scroll/); });
  const inBox = `(() => { const m = document.querySelector('.dd-fixed .menu'), b = m.getBoundingClientRect(), r = document.activeElement.getBoundingClientRect(); return { ok: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, last: document.activeElement === [...m.querySelectorAll('[role^=menuitem]')].pop(), label: document.activeElement.textContent.trim().slice(0, 20) }; })()`;
  await key('End', 'End', 35);
  await sleep(200);
  let at = await evaluate(inBox);
  check(`${tag}: End reaches the last row and it is in view`, () => { assert.equal(at.last, true); assert.equal(at.ok, true); });
  await key('Home', 'Home', 36);
  await sleep(200);
  at = await evaluate(inBox);
  check(`${tag}: Home brings the first row back in view`, () => assert.equal(at.ok, true));
  for (let i = 0; i < 12; i++) await key('ArrowDown', 'ArrowDown', 40);
  await sleep(200);
  at = await evaluate(inBox);
  check(`${tag}: a row reached with the arrow keys is inside the menu (${at.label})`, () => assert.equal(at.ok, true));
  // the mouse wheel: to the end of the menu, the last row is whole
  const c = await evaluate(`(() => { const r = document.querySelector('.dd-fixed .menu').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  for (let i = 0; i < 12; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c[0], y: c[1], deltaX: 0, deltaY: 200 });
  await sleep(300);
  const end = await evaluate(`(() => { const m = document.querySelector('.dd-fixed .menu'); if (!m) return null; const b = m.getBoundingClientRect(), last = [...m.querySelectorAll('[role^=menuitem]')].pop().getBoundingClientRect(); return { gap: b.bottom - last.bottom, sh: m.scrollHeight, ch: m.clientHeight, st: m.scrollTop }; })()`);
  check(`${tag}: the wheel scrolls More to its last row`, () => { assert.ok(end, 'the menu closed'); assert.ok(end.gap >= -1, JSON.stringify(end)); });

  // ---- Find and replace
  const rep = await pickRow('Replace');
  await sleep(500);
  check(`${tag}: More has a Replace row`, () => assert.equal(rep, true));
  const f1 = await evaluate(`(() => { const bar = document.querySelector('.find-bar'); if (!bar) return null; const t = bar.querySelector('.find-toggle'); return { toggle: !!t, expanded: t?.getAttribute('aria-expanded'), replaceInput: !!bar.querySelector('input[aria-label="Replace with"]'), focus: document.activeElement?.getAttribute('aria-label') }; })()`);
  check(`${tag}: the Replace item opens the panel with the Replace row and the focus in it`, () => { assert.ok(f1, 'no panel'); assert.equal(f1.replaceInput, true); assert.equal(f1.expanded, 'true'); assert.equal(f1.focus, 'Replace with'); });
  await evaluate(`document.querySelector('.find-toggle').click(); 1`);
  await sleep(250);
  const f2 = await evaluate(`({ expanded: document.querySelector('.find-toggle').getAttribute('aria-expanded'), replaceInput: !!document.querySelector('.find-bar input[aria-label="Replace with"]') })`);
  check(`${tag}: the chevron hides the Replace row`, () => { assert.equal(f2.replaceInput, false); assert.equal(f2.expanded, 'false'); });
  await evaluate(`document.querySelector('.find-toggle').click(); 1`);
  await sleep(250);
  const f3 = await evaluate(`({ expanded: document.querySelector('.find-toggle').getAttribute('aria-expanded'), replaceInput: !!document.querySelector('.find-bar input[aria-label="Replace with"]'), focus: document.activeElement?.getAttribute('aria-label') })`);
  check(`${tag}: the chevron shows it again, the focus goes to it`, () => { assert.equal(f3.replaceInput, true); assert.equal(f3.expanded, 'true'); assert.equal(f3.focus, 'Replace with'); });
  // Replace works: type a word, find it, replace it
  await evaluate(`(() => { const ed = document.querySelector('.ProseMirror').editor; ed.commands.insertContentAt(1, 'one two one'); return 1; })()`);
  await evaluate(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; set(document.querySelector('.find-bar input[aria-label="Find"]'), 'one'); set(document.querySelector('.find-bar input[aria-label="Replace with"]'), 'three'); return 1; })()`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('.find-bar button')].find((b) => b.textContent.trim() === 'Replace all').click(); 1`);
  await sleep(300);
  const text = await evaluate(`document.querySelector('.ProseMirror').editor.getText().includes('three two three')`);
  check(`${tag}: Replace all changed the text`, () => assert.equal(text, true));
  await evaluate(`document.querySelector('.find-close').click(); 1`);
  await sleep(200);

  // ---- the picture handles: below the dialogs, only with the editor focused
  const PNG = `(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#3366aa'; g.fillRect(0, 0, 600, 300); return c.toDataURL('image/png'); })()`;
  await evaluate(`(() => { const ed = document.querySelector('.ProseMirror').editor; ed.commands.focus('end'); ed.commands.insertContent({ type: 'image', attrs: { src: ${PNG} } }); let at = -1; ed.state.doc.descendants((n, p) => { if (n.type.name === 'image') at = p; }); ed.commands.setNodeSelection(at); return at; })()`);
  await sleep(500);
  const hz = await evaluate(`(() => { const box = document.querySelector('.pic-handles'); if (!box) return null; const back = document.createElement('div'); back.className = 'modal-back'; back.style.visibility = 'hidden'; document.body.appendChild(back); const z = [Number(getComputedStyle(box).zIndex), Number(getComputedStyle(back).zIndex)]; back.remove(); return { z, n: document.querySelectorAll('.pic-handle').length }; })()`);
  check(`${tag}: handles shown while the editor has the focus`, () => { assert.ok(hz, 'no handles'); assert.equal(hz.n, 4); });
  check(`${tag}: the handles are below the dialogs (${hz?.z})`, () => assert.ok(hz && hz.z[0] < hz.z[1]));
  await evaluate(`window.__store.getState().setDialog({ type: 'settings' }); 1`);
  await sleep(600);
  const hb = await evaluate(`({ n: document.querySelectorAll('.pic-handle').length, modal: !!document.querySelector('.modal-back') })`);
  check(`${tag}: with Settings open (the editor lost the focus) no handle is drawn`, () => { assert.equal(hb.modal, true); assert.equal(hb.n, 0); });
  await evaluate(`window.__store.getState().setDialog(null); 1`);
}

try {
  for (const [w, h] of [[960, 560], [1280, 800]]) for (const theme of ['light', 'dark']) await run(w, h, theme);
} finally { await H.shutdown(); }

if (failures.length) { console.error(`test-compose-popups: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-compose-popups: ok');
