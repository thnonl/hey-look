#!/usr/bin/env node
// The format painter (W3.1) and the mini toolbar (W3.3) in the real page with real input events (spec-107-wp3.md): the Compose of the dev preview (src/devMock.ts), Input.dispatchMouseEvent
// presses / moves / releases (clickCount 2 for a double click), Input.dispatchKeyEvent keys, touch through Input.dispatchTouchEvent.
//   Format painter: AC-3.1.1 (once: the button is pressed, the pointer is a brush, a drag paints on release, the button is released), AC-3.1.2 (a double click keeps it on, three targets, Esc),
//   AC-3.1.4 (the paragraph rule), AC-3.1.5 (a click paints the word), AC-3.1.6 (Ctrl+Z, sticky stays), AC-3.1.7 (keyboard only, Ctrl+Shift+D, the live message), AC-3.1.8 (it goes off: typing,
//   a field, Bold, Esc with the paste button), AC-3.1.9 (the More row in a narrow pane), AC-3.1.10 (the signature editor), AC-3.1.11 (reply: the quote is not painted), AC-3.1.16 (Ctrl+Shift+C / B / K).
//   node scripts/test-painter-mini.mjs [--require-browser] [--throttle=4]
import assert from 'node:assert/strict';
import { arg, sleep, startHarness } from './cdp-harness.mjs';
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
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-painter-mini: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-painter-mini: ok');
