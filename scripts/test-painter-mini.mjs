#!/usr/bin/env node
// The format painter (W3.1) and the mini toolbar (W3.3) in the real page with real input events (spec-107-wp3.md): the Compose of the dev preview (src/devMock.ts), Input.dispatchMouseEvent
// presses / moves / releases (clickCount 2 for a double click), Input.dispatchKeyEvent keys, touch through Input.dispatchTouchEvent.
//   Format painter: AC-3.1.1 (once: the button is pressed, the pointer is a brush, a drag paints on release, the button is released), AC-3.1.2 (a double click keeps it on, three targets, Esc),
//   AC-3.1.4 (the paragraph rule), AC-3.1.5 (a click paints the word), AC-3.1.6 (Ctrl+Z, sticky stays), AC-3.1.7 (keyboard only, Ctrl+Shift+D, the live message), AC-3.1.8 (it goes off: typing,
//   a field, Bold, Esc with the paste button), AC-3.1.9 (the More row in a narrow pane), AC-3.1.10 (the signature editor), AC-3.1.11 (reply: the quote is not painted), AC-3.1.16 (Ctrl+Shift+C / B / K).
//   node scripts/test-painter-mini.mjs [--require-browser] [--throttle=4]
import assert from 'node:assert/strict';
import { arg, languageJs, sleep, startHarness } from './cdp-harness.mjs';
import { MOD, makeInput, wordRect } from './lib/editor-input.mjs';

const H = await startHarness('test-painter-mini', { vitePort0: 5420 });
const { evaluate, cdp } = H;
const I = makeInput(cdp, sleep);
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 700)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(50); } return false; };
const json = (js) => evaluate(`JSON.stringify(${js})`).then((s) => JSON.parse(s));
const ED = `document.querySelector('.cp-editor .tiptap').editor`;
const RICH = `document.querySelector('.rich-body .tiptap').editor`;

async function openCompose(w = 1900, h = 900, init = {}) {
  if (arg('throttle')) await cdp('Emulation.setCPUThrottlingRate', { rate: Number(arg('throttle')) });
  await H.openApp('lang=en', w, h);
  await evaluate(`window.__store.getState().openCompose(${JSON.stringify({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Painter', bodyHtml: '<p></p>', ...init })}); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'compose did not start');
  await sleep(1000);
}
const setBody = async (ed, html) => { await evaluate(`(() => { const e = ${ed}; e.commands.setContent(${JSON.stringify(html)}); e.commands.focus('start'); return 1; })()`); await sleep(200); };
const select = async (ed, word, nth = 0) => evaluate(`(() => { const e = ${ed}; let hit = -1, n = 0; e.state.doc.descendants((node, pos) => { if (hit >= 0 || !node.isText) return; let i = -1; while ((i = node.text.indexOf(${JSON.stringify(word)}, i + 1)) >= 0) if (n++ === ${nth}) { hit = pos + i; return; } }); e.chain().focus().setTextSelection({ from: hit, to: hit + ${word.length} }).run(); return hit; })()`);
const caretAt = (ed, word, off = 0) => evaluate(`(() => { const e = ${ed}; let hit = -1; e.state.doc.descendants((node, pos) => { if (hit < 0 && node.isText && node.text.includes(${JSON.stringify(word)})) hit = pos + node.text.indexOf(${JSON.stringify(word)}); }); e.chain().focus().setTextSelection(hit + ${off}).run(); return hit; })()`);
const marksOf = (ed, word) => json(`(() => { const e = ${ed}; let m = null; e.state.doc.descendants((node, pos) => { if (m === null && node.isText && node.text.includes(${JSON.stringify(word)})) m = node.marks.map((x) => x.toJSON()); }); return m; })()`);
const sel = (ed) => json(`(() => { const s = ${ed}.state.selection; const d = ${ed}.state.doc; return { from: s.from, to: s.to, text: d.textBetween(s.from, s.to) }; })()`);
const btn = (id) => json(`(() => { const b = document.querySelector('[data-rove="${id}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, pressed: b.getAttribute('aria-pressed'), on: b.classList.contains('on'), title: b.title, label: b.getAttribute('aria-label') }; })()`);
const painter = (ed = ED) => json(`(() => { const b = document.querySelector('[data-rove="painter"]'); const dom = ${ed}.view.dom; return { pressed: b?.getAttribute('aria-pressed') ?? null, on: b?.classList.contains('on') ?? null, brush: dom.classList.contains('fmt-painting'), cursor: getComputedStyle(dom.querySelector('p') || dom).cursor.slice(0, 40), status: document.querySelector('.cp-fmt [role=status], .rich-bar [role=status]')?.textContent ?? null }; })()`);
const clickBtn = async (id, n = 1) => { const b = await btn(id); assert.ok(b, `no button ${id}`); await I.click(b.x, b.y, n); await sleep(150); };
const dragWord = async (ed, word, nth = 0) => { const r = await json(wordRect(ed, word, nth)); assert.ok(r, `no word ${word}`); await I.drag(r.x0 + 1, r.y, r.x1 - 1, r.y); await sleep(200); };
const FMT = `<p><strong><span style="font-family: Georgia, serif; font-size: 14pt; color: #ff0000">Alpha</span></strong> Beta Gamma</p>`;
const sameMarks = (a, b) => assert.deepEqual(a, b);

try {
  await openCompose();

  await check('AC-3.1.1 once: pressed, brush, drag paints on release, released again', async () => {
    await setBody(ED, FMT);
    const idle = await painter();
    assert.deepEqual([idle.pressed, idle.brush], ['false', false], JSON.stringify(idle));
    const b = await btn('painter');
    assert.ok(/Format painter \(Ctrl\+Shift\+D\)/.test(b.title) && b.label === 'Format painter', JSON.stringify(b));
    await select(ED, 'Alpha');
    await clickBtn('painter');
    const on = await painter();
    assert.deepEqual([on.pressed, on.on, on.brush], ['true', true, true], JSON.stringify(on));
    assert.ok(/url\(/.test(on.cursor) || on.cursor.includes('copy'), `the pointer over the text is the brush: ${on.cursor}`);
    assert.equal(on.status, 'Format painter is on. Select the text to format.');
    await dragWord(ED, 'Gamma');
    sameMarks(await marksOf(ED, 'Gamma'), await marksOf(ED, 'Alpha'));
    const after = await painter();
    assert.deepEqual([after.pressed, after.brush], ['false', false], 'the button is released and the pointer is normal');
    assert.equal(after.status, 'Format painter is off.');
    assert.equal((await sel(ED)).text, 'Gamma', 'the painted text stays selected');
    await dragWord(ED, 'Beta');
    assert.deepEqual(await marksOf(ED, 'Beta'), [], 'off: a drag only selects');
    assert.equal((await sel(ED)).text, 'Beta');
  });

  await check('AC-3.1.2 a double click keeps it on: three targets, Esc stops it', async () => {
    await setBody(ED, `<p><strong>Src</strong> x</p><p>one</p><p>two</p><p>three</p><p>four</p>`);
    await select(ED, 'Src');
    await clickBtn('painter', 2);
    assert.equal((await painter()).pressed, 'true');
    assert.equal((await painter()).status, 'Format painter stays on. Select text to format, or press Esc to stop.');
    for (const w of ['one', 'two', 'three']) {
      await dragWord(ED, w);
      assert.deepEqual((await marksOf(ED, w)).map((m) => m.type), ['bold'], `${w} is painted`);
      assert.equal((await painter()).pressed, 'true', `still on after ${w}`);
    }
    await I.keys.esc();
    const off = await painter();
    assert.deepEqual([off.pressed, off.brush], ['false', false]);
    await dragWord(ED, 'four');
    assert.deepEqual(await marksOf(ED, 'four'), [], 'the 4th drag only selects');
  });

  await check('AC-3.1.4 the paragraph rule', async () => {
    await setBody(ED, `<p style="text-align:center;line-height:1.5"><strong><span style="color:#ff0000">Alpha</span></strong> middle</p><p>left words here</p><p>other left</p>`);
    await caretAt(ED, 'Alpha', 2);
    await clickBtn('painter');
    await dragWord(ED, 'words');
    const d = await json(`(() => { const p = ${ED}.state.doc.child(1); return { align: p.attrs.textAlign, lh: p.attrs.lineHeight }; })()`);
    assert.deepEqual(d, { align: 'center', lh: '1.5' }, 'the whole paragraph is centred with spacing 1.5');
    assert.ok((await marksOf(ED, 'words')).some((m) => m.type === 'bold'), 'and the word is bold red');
    await select(ED, 'Alpha');
    await clickBtn('painter');
    await dragWord(ED, 'other');
    const e = await json(`${ED}.state.doc.child(2).attrs.textAlign`);
    assert.equal(e, null, 'part of a paragraph copies the characters only: the paragraph stays left-aligned');
    assert.ok((await marksOf(ED, 'other')).some((m) => m.type === 'bold'));
  });

  await check('AC-3.1.5 a click without a drag paints the whole word; a click on a space paints no text', async () => {
    await setBody(ED, FMT);
    await select(ED, 'Alpha');
    await clickBtn('painter');
    const r = await json(wordRect(ED, 'Gamma'));
    await I.click((r.x0 + r.x1) / 2, r.y);
    await sleep(200);
    sameMarks(await marksOf(ED, 'Gamma'), await marksOf(ED, 'Alpha'));
    assert.equal((await sel(ED)).text, 'Gamma');
    assert.equal((await painter()).pressed, 'false');
    // a click past the end of the line
    await setBody(ED, FMT);
    await select(ED, 'Alpha');
    await clickBtn('painter');
    const line = await json(wordRect(ED, 'Gamma'));
    await I.click(line.x1 + 120, line.y);
    await sleep(200);
    assert.deepEqual(await marksOf(ED, 'Gamma'), [], 'past the line end: no text changes');
  });

  await check('AC-3.1.6 Ctrl+Z restores the target in one step; sticky stays on', async () => {
    await setBody(ED, FMT);
    await select(ED, 'Alpha');
    await clickBtn('painter', 2);
    await dragWord(ED, 'Beta');
    sameMarks(await marksOf(ED, 'Beta'), await marksOf(ED, 'Alpha'));
    await I.keys.ctrl('z');
    assert.deepEqual(await marksOf(ED, 'Beta'), [], 'one Ctrl+Z restores the whole target');
    assert.equal((await painter()).pressed, 'true', 'sticky: Ctrl+Z does not switch it off');
    await dragWord(ED, 'Gamma');
    sameMarks(await marksOf(ED, 'Gamma'), await marksOf(ED, 'Alpha'));
    await I.keys.esc();
  });

  await check('AC-3.1.7 keyboard only: Ctrl+Shift+D picks up, a keyboard selection does not paint, Ctrl+Shift+D paints', async () => {
    await setBody(ED, FMT);
    await caretAt(ED, 'Alpha', 0);
    await I.keys.right(MOD.ctrl | MOD.shift);
    assert.ok((await sel(ED)).text.startsWith('Alpha'));
    await I.key('D', 'KeyD', 68, MOD.ctrl | MOD.shift);
    const on = await painter();
    assert.deepEqual([on.pressed, on.status], ['true', 'Format painter is on. Select the text to format.']);
    await I.keys.end();
    await I.keys.left(MOD.ctrl | MOD.shift);
    assert.equal((await sel(ED)).text, 'Gamma');
    assert.deepEqual(await marksOf(ED, 'Gamma'), [], 'nothing changes yet');
    assert.equal((await painter()).pressed, 'true');
    await I.key('D', 'KeyD', 68, MOD.ctrl | MOD.shift);
    sameMarks(await marksOf(ED, 'Gamma'), await marksOf(ED, 'Alpha'));
    assert.equal((await painter()).pressed, 'false', 'Gamma is painted and the painter is off');
  });

  await check('AC-3.1.8 it goes off: typing, a field, Bold, and Esc before the paste button', async () => {
    await setBody(ED, FMT);
    await select(ED, 'Alpha');
    await clickBtn('painter');
    await I.type('x');
    assert.equal((await painter()).pressed, 'false', 'typing a character');
    assert.equal(await evaluate(`${ED}.state.doc.child(0).textContent.startsWith('x')`), true, 'and the character is typed normally');
    // a field outside the editor
    await select(ED, 'Beta');
    await clickBtn('painter');
    const subj = await json(`(() => { const i = document.querySelector('.cf-subject input'); const r = i.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
    await I.click(subj.x, subj.y);
    await sleep(150);
    assert.equal((await painter()).pressed, 'false', 'the Subject field');
    // the Bold button: off, and Bold acts as usual
    await select(ED, 'Gamma');
    await clickBtn('painter');
    await clickBtn('bold');
    assert.equal((await painter()).pressed, 'false', 'Bold switches it off');
    assert.ok((await marksOf(ED, 'Gamma')).some((m) => m.type === 'bold'), 'and Bold acted as usual');
    // Esc with the paste button showing: the painter takes the first one
    await setBody(ED, FMT);
    await evaluate(`(() => { const dt = new DataTransfer(); dt.setData('text/html', '<p><b>pasted</b> text</p>'); dt.setData('text/plain', 'pasted text'); ${ED}.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
    await sleep(500);
    const pasteBtn = () => evaluate(`!!document.querySelector('.paste-opt')`);
    assert.equal(await pasteBtn(), true, "the paste button shows after a rich paste");
    {
      await select(ED, 'Beta');
      await clickBtn('painter');
      await evaluate(`${ED}.commands.focus(); 1`);
      await I.keys.esc();
      assert.equal((await painter()).pressed, 'false', 'the first Esc switches the painter off');
      assert.equal(await pasteBtn(), true, 'the paste button is still there');
      await I.keys.esc();
      assert.equal(await pasteBtn(), false, 'the second Esc closes the paste button');
    }
  });

  await check('AC-3.1.16 Ctrl+Shift+C / B / K keep their meaning; AltGr+Shift+D does not switch the painter on', async () => {
    await setBody(ED, FMT);
    await select(ED, 'Alpha');
    const fields = () => evaluate(`document.querySelectorAll('.compose-pane .cf-field.rcpt').length`);
    const before = await fields();
    await I.key('C', 'KeyC', 67, MOD.ctrl | MOD.shift);
    await sleep(200);
    assert.ok((await fields()) > before, 'Ctrl+Shift+C shows Cc');
    assert.equal((await painter()).pressed, 'false');
    await select(ED, 'Alpha');
    await I.key('D', 'KeyD', 68, MOD.ctrl | MOD.alt | MOD.shift);
    assert.equal((await painter()).pressed, 'false', 'AltGr+Shift+D (Ctrl+Alt+Shift+D) does nothing');
  });

  // ---- the More row in a narrow pane (AC-3.1.9)
  await openCompose(400, 800);
  await check('AC-3.1.9 narrow pane: the painter is a More row with the key, a check while on', async () => {
    await setBody(ED, FMT);
    assert.equal(await btn('painter'), null, 'not in the bar at 400 px');
    await select(ED, 'Alpha');
    const open = async () => { await clickBtn('more'); await sleep(200); return json(`(() => { const r = [...document.querySelectorAll('.menu-row')].find((x) => /Format painter/.test(x.textContent)); return r ? { text: r.textContent, role: r.getAttribute('role'), checked: r.getAttribute('aria-checked'), x: r.getBoundingClientRect().left + 20, y: r.getBoundingClientRect().top + 10 } : null; })()`); };
    let row = await open();
    assert.ok(row, 'no Format painter row');
    assert.ok(row.text.includes('Ctrl+Shift+D'), row.text);
    assert.ok(row.role === 'menuitemcheckbox' && row.checked === 'false', JSON.stringify(row));
    await I.click(row.x, row.y);
    await sleep(200);
    assert.equal(await evaluate(`${ED}.view.dom.classList.contains('fmt-painting')`), true, 'choosing it switches it on (once)');
    row = await open();
    assert.equal(row.checked, 'true', 'while on its row shows a check');
    await I.click(row.x, row.y);
    await sleep(200);
    assert.equal(await evaluate(`${ED}.view.dom.classList.contains('fmt-painting')`), false, 'choosing it again switches it off');
  });

  // ---- the mini toolbar (W3.3)
  await openCompose(1900, 900);
  const MINI = '.mini-tb';
  const miniRect = () => json(`(() => { const m = document.querySelector('${MINI}'); if (!m) return null; const r = m.getBoundingClientRect(); const cs = getComputedStyle(m); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, vis: cs.visibility, z: cs.zIndex, label: m.getAttribute('aria-label'), role: m.getAttribute('role') }; })()`);
  const slowBy = Math.max(1, Number(arg('throttle') || 1));
  const waitMini = async (ms = 600) => { const t0 = Date.now(); while (Date.now() - t0 < ms * slowBy) { const r = await miniRect(); if (r && r.vis !== 'hidden') return { ...r, after: Date.now() - t0 }; await sleep(20); } return null; };
  const noMini = async (ms = 400) => { await sleep(ms); return (await miniRect()) === null; };
  /** the client rects of the text of the selection (the lines) */
  const lines = () => json(`(() => { const s = getSelection(); if (!s.rangeCount) return []; const r = s.getRangeAt(0); const w = document.createTreeWalker(r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer, NodeFilter.SHOW_TEXT); const out = []; for (let n = w.nextNode(); n; n = w.nextNode()) { if (!r.intersectsNode(n)) continue; const q = document.createRange(); q.selectNodeContents(n); if (n === r.startContainer) q.setStart(n, r.startOffset); if (n === r.endContainer) q.setEnd(n, r.endOffset); for (const c of q.getClientRects()) if (c.width > 0) out.push({ l: c.left, t: c.top, r: c.right, b: c.bottom }); } return out; })()`);
  const disjoint = (m, rects) => rects.every((q) => m.right <= q.l || m.left >= q.r || m.bottom <= q.t || m.top >= q.b);
  const TEXT = '<p>First line of the body here</p><p>Second line with Alpha Beta Gamma words</p><p>Third paragraph one</p><p>Fourth paragraph two</p>';
  const dragSel = async (ed, word, nth = 0) => { const w = await json(wordRect(ed, word, nth)); await I.drag(w.x0 + 1, w.y, w.x1 - 1, w.y); return waitMini(); };
  const mb = (id) => json(`(() => { const b = document.querySelector('${MINI} [data-rove="mini:${id}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label') }; })()`);

  await check('AC-3.3.1 a drag, a double click, a triple click and Shift+click show it above the text, centred, covering nothing', async () => {
    await setBody(ED, TEXT);
    // (the first time it shows, the dev server transforms its module: a warm-up, the release build has it prefetched)
    await dragSel(ED, 'Alpha');
    await I.keys.esc();
    await sleep(300);
    const w = await json(wordRect(ED, 'Third'));
    await I.drag(w.x0 + 1, w.y, w.x1 - 1, w.y);
    const m0 = await waitMini();
    assert.ok(m0, 'no mini toolbar after a drag');
    await sleep(200); // (the pop animation of 100 ms)
    const m = { ...(await miniRect()), after: m0.after };
    assert.ok(m.after <= 300 * slowBy, `it came after ${m.after} ms`);
    const rects = await lines();
    assert.ok(disjoint(m, rects), `it covers the selection: ${JSON.stringify([m, rects])}`);
    const sx = (Math.min(...rects.map((q) => q.l)) + Math.max(...rects.map((q) => q.r))) / 2;
    assert.ok(Math.abs((m.left + m.right) / 2 - sx) <= 2, `centred on the word: ${(m.left + m.right) / 2} vs ${sx}`);
    assert.ok(m.bottom <= Math.min(...rects.map((q) => q.t)) - 7, `above the word, 8 px gap: ${JSON.stringify([m, rects])}`);
    assert.ok(m.h > 30 && m.h < 46 && m.w > 180 && m.w < 260, `about 36 x 210: ${m.w} x ${m.h}`);
    assert.deepEqual([m.label, m.role], ['Mini toolbar', 'toolbar']);
    assert.equal(await evaluate(`${ED}.view.hasFocus()`), true, 'the editor keeps the focus');
    assert.equal((await sel(ED)).text, 'Third');
    // (a press on selected text may start dragging it: a double click is made on text that is not selected)
    const elsewhere = await json(wordRect(ED, 'Fourth'));
    await I.click(elsewhere.x0 + 3, elsewhere.y);
    await sleep(200);
    await I.click(w.x0 + 4, w.y, 2);
    assert.ok(await waitMini(), `double click: ${JSON.stringify(await sel(ED))} dom=${await evaluate('getSelection().toString()')}`);
    await I.click(elsewhere.x0 + 3, elsewhere.y);
    await sleep(200);
    await I.click(w.x0 + 4, w.y, 3);
    assert.ok(await waitMini(), 'triple click');
    const a = await json(wordRect(ED, 'Fourth')); // (not a line the toolbar hangs over)
    await I.click(a.x0 + 3, a.y);
    assert.equal(await noMini(250), true, 'a click: no selection, no toolbar');
    await I.click(w.x1 - 2, w.y, 1, MOD.shift);
    assert.ok(await waitMini(), 'Shift+click extends the selection');
  });

  await check('AC-3.3.2 a keyboard selection never shows it', async () => {
    await setBody(ED, TEXT);
    await caretAt(ED, 'Alpha', 0);
    await I.keys.right(MOD.shift);
    await I.keys.right(MOD.shift);
    assert.equal(await noMini(), true, 'Shift+Right');
    await I.keys.right(MOD.ctrl | MOD.shift);
    assert.equal(await noMini(), true, 'Ctrl+Shift+Right');
    await I.key('a', 'KeyA', 65, MOD.ctrl);
    assert.equal(await noMini(), true, 'Ctrl+A');
  });

  await check('AC-3.3.3 B, I, U stay; the colours; Link opens the popover under it and the toolbar goes', async () => {
    await setBody(ED, TEXT);
    assert.ok(await dragSel(ED, 'Beta'), 'shown');
    for (const id of ['bold', 'italic', 'underline']) {
      const b = await mb(id);
      assert.ok(b, `no ${id}`);
      await I.click(b.x, b.y);
      await sleep(150);
      assert.ok((await marksOf(ED, 'Beta')).some((m) => m.type === id), `${id} applied`);
      assert.equal((await mb(id)).pressed, 'true', `${id} shows pressed`);
      assert.ok(await miniRect(), `${id}: the toolbar stays`);
    }
    assert.equal((await sel(ED)).text, 'Beta', 'the selection is kept');
    const fc = await mb('fontColor');
    await I.click(fc.x, fc.y);
    await sleep(150);
    assert.ok((await marksOf(ED, 'Beta')).some((m) => m.type === 'textStyle' && m.attrs.color), 'the last used colour is applied');
    const arrow = await mb('fontColor:opts');
    await I.click(arrow.x, arrow.y);
    await sleep(300);
    const pal = await json(`(() => { const p = document.querySelector('.fmt-pop'); if (!p) return null; const r = p.getBoundingClientRect(); const m = document.querySelector('${MINI}').getBoundingClientRect(); return { top: r.top, mbottom: m.bottom, mtop: m.top, bottom: r.bottom }; })()`);
    assert.ok(pal, 'the palette opened');
    assert.ok(await miniRect(), 'the toolbar stays while the palette is open');
    assert.ok(pal.top >= pal.mbottom - 1 || pal.bottom <= pal.mtop + 1, 'the palette is under (or over) the toolbar, not on it');
    const blue = await json(`(() => { const b = [...document.querySelectorAll('.fmt-pop button[aria-label]')].find((x) => /^Blue$/.test(x.getAttribute('aria-label'))); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(blue, 'a Blue swatch');
    await I.click(blue.x, blue.y);
    await sleep(250);
    assert.equal(await evaluate(`!!document.querySelector('.fmt-pop')`), false, 'the palette closes');
    assert.ok(await miniRect(), 'the toolbar stays after a colour is chosen');
    const colour = (await marksOf(ED, 'Beta')).find((m) => m.type === 'textStyle')?.attrs.color;
    assert.ok(colour && colour.toLowerCase() !== '#ff0000', `Beta is blue: ${colour}`);
    const lk = await mb('link');
    const lr = await json(`(() => { const r = document.querySelector('${MINI} [data-rove="mini:link"]').getBoundingClientRect(); return { b: r.bottom, l: r.left }; })()`);
    await I.click(lk.x, lk.y);
    assert.ok(await waitFor(`!!document.querySelector('.link-pop')`), 'the link popover');
    const pop = await json(`(() => { const r = document.querySelector('.link-pop').getBoundingClientRect(); return { top: r.top, left: r.left }; })()`);
    assert.ok(pop.top >= lr.b - 2, `under the Link button: popover ${pop.top} button bottom ${lr.b}`);
    assert.equal(await miniRect(), null, 'the toolbar is gone');
    await I.type('heylook.app');
    await I.keys.enter();
    await sleep(200);
    assert.equal((await marksOf(ED, 'Beta')).find((m) => m.type === 'link')?.attrs.href, 'https://heylook.app', 'Beta is a link to https://heylook.app');
  });

  await check('AC-3.3.4 Esc, typing, a click elsewhere, a scroll, a resize hide it; Ctrl+B keeps it', async () => {
    await setBody(ED, TEXT);
    await dragSel(ED, 'Alpha');
    await I.keys.esc();
    assert.equal(await miniRect(), null, 'Esc hides');
    assert.equal((await sel(ED)).text, 'Alpha', 'the word is still selected');
    assert.equal(await evaluate(`${ED}.view.hasFocus()`), true);
    await I.type('Q');
    assert.equal((await sel(ED)).text, '', 'typing replaces the selection');
    await setBody(ED, TEXT);
    await dragSel(ED, 'Alpha');
    await I.type('x');
    assert.equal(await miniRect(), null, 'a typed letter hides it (and replaces the selection)');
    await setBody(ED, TEXT);
    await dragSel(ED, 'Alpha');
    const o = await json(wordRect(ED, 'Fourth'));
    await I.click(o.x0 + 3, o.y);
    assert.equal(await miniRect(), null, 'a click elsewhere hides it');
    await setBody(ED, TEXT);
    await dragSel(ED, 'Alpha');
    await evaluate(`(() => { const s = document.querySelector('.cp-editor'); s.dispatchEvent(new Event('scroll')); return 1; })()`);
    await sleep(200);
    assert.equal(await miniRect(), null, 'a scroll of the pane hides it');
    await setBody(ED, TEXT);
    await dragSel(ED, 'Alpha');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1880, height: 880, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    assert.equal(await miniRect(), null, 'a resize hides it');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1900, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    await setBody(ED, TEXT);
    await dragSel(ED, 'Alpha');
    await I.key('b', 'KeyB', 66, MOD.ctrl);
    await sleep(150);
    assert.ok(await miniRect(), 'Ctrl+B keeps it');
    assert.equal((await mb('bold')).pressed, 'true', 'and Bold shows pressed');
  });

  await check('AC-3.3.5 the first line: above (over the toolbar) or below, never on the word', async () => {
    await setBody(ED, TEXT);
    const w = await json(wordRect(ED, 'First'));
    await I.drag(w.x0 + 1, w.y, w.x1 - 1, w.y);
    const m = await waitMini();
    assert.ok(m);
    assert.ok(disjoint(m, await lines()), 'never on the word');
    assert.ok(m.top >= 8 && m.bottom <= 900 - 8, 'inside the window');
  });

  await check('AC-3.3.6 a table cell: below the text; a selection inside a link: no toolbar, the link bubble', async () => {
    await setBody(ED, '<p>before</p><table><tbody><tr><td><p>cell text here</p></td><td><p>other</p></td></tr></tbody></table><p>after <a href="https://a.test/x">linked words</a> end</p>');
    const w = await json(wordRect(ED, 'text'));
    await I.drag(w.x0 + 1, w.y, w.x1 - 1, w.y);
    const m = await waitMini();
    assert.ok(m, 'in a table cell');
    const rects = await lines();
    assert.ok(m.top >= Math.max(...rects.map((q) => q.b)) - 1, 'in a table: below the selected text');
    await I.click(...(await json(`(() => { const r = document.querySelector('.cp-editor .tiptap p').getBoundingClientRect(); return [r.left + 5, r.top + r.height / 2]; })()`))); // (out of the table: its tools and the toolbar under the cell text would be over the next lines)
    await sleep(200);
    const l = await json(wordRect(ED, 'linked'));
    await I.drag(l.x0 + 1, l.y, l.x1 - 1, l.y);
    assert.equal(await noMini(500), true, 'inside a link: no mini toolbar');
    assert.ok(await waitFor(`!!document.querySelector('.link-bubble')`, 3000), 'the link bubble shows');
  });

  await check('AC-3.3.7 the painter on: a drag paints and no mini toolbar shows', async () => {
    await setBody(ED, FMT);
    await select(ED, 'Alpha');
    await clickBtn('painter');
    await dragWord(ED, 'Gamma');
    assert.equal(await noMini(300), true);
    assert.equal((await marksOf(ED, 'Gamma')).some((m) => m.type === 'bold'), true, 'painted');
  });

  await check('AC-3.3.8 Alt+F10 reaches it; the arrows, Enter, Esc; Alt+F10 again is the formatting toolbar', async () => {
    await setBody(ED, TEXT);
    await dragSel(ED, 'Beta');
    await I.keys.f10(MOD.alt);
    await sleep(150);
    const focused = () => evaluate(`document.activeElement?.getAttribute('data-rove') ?? document.activeElement?.className ?? null`);
    assert.equal(await focused(), 'mini:bold');
    const order = [];
    for (let i = 0; i < 7; i++) { await I.keys.right(); order.push(await focused()); }
    assert.deepEqual(order, ['mini:italic', 'mini:underline', 'mini:fontColor', 'mini:fontColor:opts', 'mini:highlight', 'mini:highlight:opts', 'mini:link']);
    await I.keys.home();
    await I.keys.right();
    assert.equal(await focused(), 'mini:italic');
    await I.keys.activate();
    await sleep(150);
    assert.ok((await marksOf(ED, 'Beta')).some((m) => m.type === 'italic'), 'Enter on Italic makes it italic');
    await I.keys.esc();
    await sleep(150);
    assert.equal(await miniRect(), null, 'Esc hides it');
    assert.equal(await evaluate(`${ED}.view.hasFocus()`), true, 'the focus is back in the text');
    assert.equal((await sel(ED)).text, 'Beta', 'the selection is unchanged');
    await I.keys.f10(MOD.alt);
    await sleep(150);
    assert.equal(await evaluate(`!!document.activeElement?.closest('.fmt-tb')`), true, 'Alt+F10 again: the formatting toolbar gets the focus');
  });

  await check('AC-3.3.9 a touch selection shows nothing; an IME composition hides it', async () => {
    await setBody(ED, TEXT);
    const w = await json(wordRect(ED, 'Beta'));
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: w.x0 + 3, y: w.y }] });
    await select(ED, 'Beta');
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await noMini(500), true, 'a selection by touch');
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    await setBody(ED, TEXT);
    assert.ok(await dragSel(ED, 'Beta'));
    await cdp('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await sleep(200);
    assert.equal(await miniRect(), null, 'typing with an IME hides it');
    await cdp('Input.insertText', { text: 'ni' });
    await sleep(300);
    assert.equal(await miniRect(), null, 'and it does not come back');
  });

  await check('AC-3.3.10 the setting off: no toolbar; on again: it works without reopening', async () => {
    await setBody(ED, TEXT);
    await evaluate(`window.__store.getState().setPrefs({ miniToolbar: false }); 1`);
    await sleep(100);
    assert.equal(await dragSel(ED, 'Beta'), null, 'off');
    await evaluate(`window.__store.getState().setPrefs({ miniToolbar: true }); 1`);
    await sleep(100);
    assert.ok(await dragSel(ED, 'Alpha'), 'on again');
  });

  // ---- the signature editor (AC-3.1.10) and a reply (AC-3.1.11)
  await H.openApp('lang=en', 946, 552);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a1' }); 1`);
  await sleep(800);
  const clickText = (sel2, text) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel2)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  await check('AC-3.1.10 the signature editor has the painter and paints its own text only', async () => {
    assert.ok(await clickText('.modal button', 'Signatures'));
    await sleep(500);
    assert.ok(await clickText('.modal button', 'New signature'));
    assert.ok(await waitFor(`!!document.querySelector('.rich-body .tiptap')?.editor`, 15000));
    await sleep(500);
    await setBody(RICH, `<p><strong>Alpha</strong> Beta Gamma</p>`);
    await select(RICH, 'Alpha');
    // (the compact toolbar of the dialog is narrow: the painter is a row of More there, and Ctrl+Shift+D works)
    assert.equal(await btn('painter'), null);
    await clickBtn('more');
    await sleep(200);
    assert.ok(await evaluate(`[...document.querySelectorAll('.menu-row')].some((x) => /Format painter/.test(x.textContent))`), 'the More row');
    await I.keys.esc();
    await select(RICH, 'Alpha');
    await I.key('D', 'KeyD', 68, MOD.ctrl | MOD.shift);
    assert.equal((await painter(RICH)).brush, true);
    await dragWord(RICH, 'Gamma');
    assert.ok((await marksOf(RICH, 'Gamma')).some((m) => m.type === 'bold'), 'Gamma is bold');
    assert.equal((await painter(RICH)).brush, false);
  });
  await check('AC-3.3.11 / 3.3.13 the signature editor in Settings: the toolbar shows over the dialog, in the app theme, named in 8 languages', async () => {
    await setBody(RICH, `<p>Alpha Beta Gamma</p>`);
    await evaluate(`document.querySelector('.modal-body, .modal')?.scrollTo?.(0, 0); 1`);
    const names = { en: 'Mini toolbar', vi: 'Thanh công cụ nhỏ', fr: 'Mini barre d’outils', 'zh-Hans': '浮动工具栏', es: 'Minibarra de herramientas', ja: 'ミニツールバー', de: 'Mini-Symbolleiste', ru: 'Мини-панель инструментов' };
    for (const [lang, name] of Object.entries(names)) {
      await evaluate(languageJs(lang));
      await sleep(250);
      await setBody(RICH, `<p>Alpha Beta Gamma</p>`);
      const w = await json(wordRect(RICH, 'Beta'));
      await I.drag(w.x0 + 1, w.y, w.x1 - 1, w.y);
      const m = await evaluate(`(() => { const t0 = Date.now(); return new Promise((ok) => { const f = () => { const m = document.querySelector('.mini-tb'); if (m && getComputedStyle(m).visibility !== 'hidden') { const r = m.getBoundingClientRect(); ok({ label: m.getAttribute('aria-label'), z: Number(getComputedStyle(m).zIndex), modalZ: Number(getComputedStyle(document.querySelector('.modal-back')).zIndex), bg: getComputedStyle(m).backgroundColor, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, names: [...m.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) }); } else if (Date.now() - t0 > 3000) ok(null); else setTimeout(f, 30); }; f(); }); })()`);
      assert.ok(m, `${lang}: no toolbar`);
      assert.equal(m.label, name, `${lang}: its name`);
      assert.ok(m.z > m.modalZ && m.z < 80, `above the dialog, below the menus: ${m.z} vs ${m.modalZ}`);
      assert.ok(m.inside, `${lang}: inside the window`);
      assert.ok(m.names.every((n) => n && !/^compose\./.test(n)), `${lang}: no raw key in ${m.names}`);
      await I.keys.esc();
    }
    await evaluate(languageJs('en'));
  });

  // D-090 (Mac / Linux round 9b): a word in the FIRST line of the body is right under the formatting toolbar; the mini toolbar must not be drawn over that toolbar. The room above a
  // selection ends at the bottom of the formatting toolbar: with no room the toolbar goes BELOW the word, 8 px away; a later line keeps it above.
  const FIRST = '<p>Alpha first line words</p><p>Second line with Beta words</p><p>Third paragraph one</p><p>Fourth paragraph here</p>';
  const bar = () => json("(() => { const b = document.querySelector('.fmt-tb'); const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()");
  const noOverlap = (a, b) => a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
  const firstLineCases = async (where) => {
    await setBody(ED, FIRST);
    await dragSel(ED, 'Third'); // warm-up of the lazy chunk (another word: a press on selected text may start dragging it)
    await I.keys.esc();
    await sleep(300);
    const w = await json(wordRect(ED, 'Alpha'));
    await I.drag(w.x0 + 1, w.y, w.x1 - 1, w.y);
    const m0 = await waitMini();
    assert.ok(m0, `${where}: no mini toolbar for a word of the first line`);
    await sleep(200);
    const m = await miniRect();
    const b = await bar();
    const rects = await lines();
    const selTop = Math.min(...rects.map((q) => q.t));
    const selBottom = Math.max(...rects.map((q) => q.b));
    assert.ok(noOverlap(m, b), `${where}: the mini toolbar covers the formatting toolbar: ${JSON.stringify([m, b])}`);
    assert.ok(disjoint(m, rects), `${where}: it covers the word`);
    assert.ok(m.top >= selBottom + 7 && m.top <= selBottom + 9, `${where}: below the word with an 8 px gap: ${m.top} vs ${selBottom}`);
    assert.ok(m.top > selTop, `${where}: it is below the first line`);
    await I.keys.esc();
    await sleep(200);
    // the fourth line has room above the word: above, as before
    const w2 = await json(wordRect(ED, 'Fourth'));
    await I.drag(w2.x0 + 1, w2.y, w2.x1 - 1, w2.y);
    assert.ok(await waitMini(), `${where}: no mini toolbar for a word of a later line`);
    await sleep(200);
    const m2 = await miniRect();
    const r2 = await lines();
    assert.ok(m2.bottom <= Math.min(...r2.map((q) => q.t)) - 7, `${where}: a later line keeps it above the word, 8 px gap: ${JSON.stringify([m2, r2])}`);
    assert.ok(noOverlap(m2, await bar()), `${where}: and clear of the formatting toolbar`);
    // a phrase over two lines starting in the first: still no cover
    await I.keys.esc();
  };
  await check('D-090 inline compose at 960 x 560: a word of the first line gets the mini toolbar below it, a later line above', async () => {
    await openCompose(960, 560);
    await firstLineCases('inline 960x560');
  });
  await check('D-090 the compose window at 960 x 560: the same', async () => {
    await H.cdp('Emulation.setDeviceMetricsOverride', { width: 960, height: 560, deviceScaleFactor: 1, mobile: false });
    await H.cdp('Page.navigate', { url: 'about:blank' });
    await H.cdp('Page.navigate', { url: `${H.base}?w=compose&mock=new#lang=en` });
    assert.ok(await waitFor(`!!document.querySelector('.compose-pane .cp-editor .tiptap')?.editor`, 20000), 'the compose window did not start');
    await sleep(600);
    await firstLineCases('compose window 960x560');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-painter-mini: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-painter-mini: ok');
