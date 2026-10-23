// Real input for the editor tests (CDP): typed characters, keys with modifiers, mouse presses / moves / releases (a drag, a double click) and the geometry of a word of the
// editor, so a test acts like a person (spec-107-wp3.md: test-autoformat-ui.mjs, test-painter-mini.mjs). `cdp` is the harness' session (scripts/cdp-harness.mjs).
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

export function makeInput(cdp, sleep) {
  /** One typed character, as a keyboard produces it (the page sees keydown, keypress / beforeinput, input, keyup). */
  const char = async (ch) => {
    const space = ch === ' ';
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: space ? 'Space' : undefined, text: ch, unmodifiedText: ch });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: space ? 'Space' : undefined });
  };
  /** Types a string, one key per character. */
  const type = async (str, gap = 12) => {
    for (const ch of [...str]) {
      await char(ch);
      if (gap) await sleep(gap);
    }
    await sleep(40);
  };
  /** A key with modifiers; `vk` is the Windows virtual key code. */
  const key = async (k, code, vk, modifiers = 0) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await sleep(60);
  };
  const keys = {
    enter: () => key('Enter', 'Enter', 13),
    backspace: () => key('Backspace', 'Backspace', 8),
    esc: () => key('Escape', 'Escape', 27),
    left: (mods = 0) => key('ArrowLeft', 'ArrowLeft', 37, mods),
    right: (mods = 0) => key('ArrowRight', 'ArrowRight', 39, mods),
    down: (mods = 0) => key('ArrowDown', 'ArrowDown', 40, mods),
    home: (mods = 0) => key('Home', 'Home', 36, mods),
    end: (mods = 0) => key('End', 'End', 35, mods),
    f10: (mods = 0) => key('F10', 'F10', 121, mods),
    tab: (mods = 0) => key('Tab', 'Tab', 9, mods),
    ctrl: (letter, extra = 0) => key(letter.toLowerCase(), `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), MOD.ctrl | extra),
  };
  const move = (x, y, buttons = 0) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons, button: buttons ? 'left' : 'none' });
  const down = (x, y, clickCount = 1, modifiers = 0) => cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount, modifiers });
  const up = (x, y, clickCount = 1, modifiers = 0) => cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount, modifiers });
  /** A click (`clickCount` 2 is the second press of a double click, 3 of a triple click: the earlier presses are made first). */
  const click = async (x, y, clickCount = 1, modifiers = 0) => {
    await move(x, y);
    for (let n = 1; n <= clickCount; n++) {
      await down(x, y, n, modifiers);
      await up(x, y, n, modifiers);
    }
    await sleep(60);
  };
  /** Press at (x1, y1), move in steps, release at (x2, y2): a drag selection. */
  const drag = async (x1, y1, x2, y2, steps = 6) => {
    await move(x1, y1);
    await down(x1, y1);
    for (let i = 1; i <= steps; i++) await move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, 1);
    await up(x2, y2);
    await sleep(60);
  };
  return { char, type, key, keys, move, down, up, click, drag };
}

/**
 * Browser-side expression (a string for `evaluate`): the client rect of the first occurrence of `word` in the editor `ed` (an expression that gives the TipTap editor),
 * as { x0, x1, y, top, bottom } or null. The rect comes from a DOM range over the text node, so it is what the engine drew.
 */
export const wordRect = (ed, word, nth = 0) => `(() => {
  const e = ${ed};
  let hit = null, n = 0;
  e.state.doc.descendants((node, pos) => {
    if (hit || !node.isText) return;
    let i = -1;
    while ((i = node.text.indexOf(${JSON.stringify(word)}, i + 1)) >= 0) { if (n++ === ${nth}) { hit = pos + i; return; } }
  });
  if (hit === null) return null;
  const a = e.view.domAtPos(hit), b = e.view.domAtPos(hit + ${word.length});
  const r = document.createRange();
  r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
  const q = r.getBoundingClientRect();
  return { x0: q.left, x1: q.right, y: (q.top + q.bottom) / 2, top: q.top, bottom: q.bottom, pos: hit };
})()`;
