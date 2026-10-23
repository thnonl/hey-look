#!/usr/bin/env node
// AutoFormat as you type in the real page (spec-107-wp3.md W3.2): real key events in the Compose of the dev preview (src/devMock.ts) and in the signature editor of Settings.
//   AC-3.2.1 `"Hello" -- (c) ...` and a space give the typographic text; AC-3.2.2 / AC-3.2.3 the apostrophe, single quotes, arrows, (r) (tm), upper case (C) stays;
//   AC-3.2.4 Ctrl+Z right after a replacement gives the typed text back with the caret behind it, typing on does not convert it again, the second Ctrl+Z is the ordinary undo,
//            Backspace after (c) deletes the sign;
//   AC-3.2.5 the Code style and a URL stay as typed; AC-3.2.6 `---` + Enter at the start of an empty paragraph is a horizontal line, `-- ` at the start stays, `a---b` stays;
//   AC-3.2.7 a paste is not converted; AC-3.2.8 the switch off / on without reopening; AC-3.2.9 German and French give their quotes and the French no-break spaces;
//   AC-3.2.10 an input-method commit (Input.imeSetComposition + Input.insertText) with `--` and `...` in it stays exactly as the IME produced it;
//   AC-3.2.11 the same in the signature editor of Settings; AC-3.2.13 the Settings row and its hint in the 8 languages, whole at 960 x 560 and 1280 x 800.
//   node scripts/test-autoformat-ui.mjs [--require-browser]
import assert from 'node:assert/strict';
import { sleep, startHarness, languageJs } from './cdp-harness.mjs';
import { makeInput } from './lib/editor-input.mjs';

const H = await startHarness('test-autoformat-ui', { vitePort0: 5460 });
const { evaluate, cdp } = H;
const I = makeInput(cdp, sleep);
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); console.error('FAIL', failures.at(-1).slice(0, 600)); } };
const waitFor = async (js, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between two renders */ } await sleep(60); } return false; };
const ED = `document.querySelector('.cp-editor .tiptap').editor`;
const RICH = `document.querySelector('.rich-body .tiptap').editor`;
const para = (ed, n = 0) => evaluate(`${ed}.state.doc.child(${n}).textContent`);
const caret = (ed) => evaluate(`(() => { const s = ${ed}.state.selection; return { from: s.from, empty: s.empty, off: s.$from.parentOffset }; })()`);
const NB = ' ';

async function openCompose(lang = 'en', w = 1280, h = 800) {
  await H.openApp(`lang=${lang}`, w, h);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'AutoFormat', bodyHtml: '<p></p>' }); 1`);
  assert.ok(await waitFor(`!!document.querySelector('.cp-editor .tiptap')?.editor`, 20000), 'compose did not start');
  await sleep(900);
  await evaluate(`${ED}.commands.focus('start'); 1`);
  await sleep(150);
}
/** An empty first paragraph with the caret in it. */
const reset = async (ed) => { await evaluate(`(() => { const e = ${ed}; e.commands.setContent('<p></p>'); e.commands.focus('start'); return 1; })()`); await sleep(150); };

try {
  await openCompose('en');

  await check('AC-3.2.1 quotes, dash, (c), ellipsis', async () => {
    await I.type('"Hello" -- (c) ... ');
    assert.equal(await para(ED), '“Hello” – © … ');
  });

  await check('AC-3.2.2 apostrophe and single quotes', async () => {
    await reset(ED);
    await I.type("don't and 'quoted' ");
    assert.equal(await para(ED), 'don’t and ‘quoted’ ');
  });

  await check('AC-3.2.3 arrows, (r), (tm); (C) and (R) stay', async () => {
    await reset(ED);
    await I.type('-> --> <- (r) (tm) (C) (R) ');
    assert.equal(await para(ED), '→ → ← ® ™ (C) (R) ');
  });

  await check('AC-3.2.4 Ctrl+Z right after each replacement, typing on, the second Ctrl+Z, Backspace', async () => {
    for (const [typed, shown] of [['say "', 'say “'], ['a -- ', 'a – '], ['x (c)', 'x ©'], ['wait...', 'wait…'], ['', null]]) {
      if (shown === null) break;
      await reset(ED);
      await I.type(typed);
      assert.equal(await para(ED), shown, `converted: ${typed}`);
      await I.keys.ctrl('z');
      assert.equal(await para(ED), typed, `Ctrl+Z gives back: ${typed}`);
      const c = await caret(ED);
      assert.equal(c.off, typed.length, `the caret is behind the typed text: ${typed}`);
      await I.type('z');
      assert.equal(await para(ED), typed + 'z', `typing on does not convert it again: ${typed}`);
    }
    // the second Ctrl+Z is the ordinary undo
    await reset(ED);
    await I.type('hello a -- ');
    await I.keys.ctrl('z');
    assert.equal(await para(ED), 'hello a -- ');
    await I.keys.ctrl('z');
    assert.notEqual(await para(ED), 'hello a -- ', 'the second Ctrl+Z undoes the typing as before');
    // Backspace right after a replacement deletes the character before the caret
    await reset(ED);
    await I.type('(c)');
    assert.equal(await para(ED), '©');
    await I.keys.backspace();
    assert.equal(await para(ED), '', 'Backspace deletes the sign');
  });

  await check('AC-3.2.5 / 3.2.6 URLs, addresses, the Code style, `---`, `-- `, `a---b`', async () => {
    await reset(ED);
    await I.type('https://a.test/x--y... ');
    assert.equal(await para(ED), 'https://a.test/x--y... ');
    await reset(ED);
    await I.type('qa--1@example.test ');
    assert.equal(await para(ED), 'qa--1@example.test ');
    await reset(ED);
    await I.type('-- ');
    assert.equal(await para(ED), '-- ');
    await reset(ED);
    await I.type('a---b');
    assert.equal(await para(ED), 'a---b');
    await reset(ED);
    await I.type('---');
    await I.keys.enter();
    const kinds = await evaluate(`(() => { const k = []; ${ED}.state.doc.forEach((n) => k.push(n.type.name)); return k; })()`);
    assert.ok(kinds.includes('horizontalRule'), `a horizontal line: ${kinds}`);
    // the Code style
    await reset(ED);
    await evaluate(`${ED}.commands.setCodeBlock(); 1`);
    await sleep(100);
    await I.type('"x" -- (c) ... ');
    assert.equal(await para(ED), '"x" -- (c) ... ');
  });

  await check('AC-3.2.7 a paste is not converted', async () => {
    await reset(ED);
    await evaluate(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', '"x" -- (c)'); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); ${ED}.view.dom.dispatchEvent(ev); return 1; })()`);
    await sleep(300);
    assert.equal(await para(ED), '"x" -- (c)');
  });

  await check('AC-3.2.8 the switch off and on, no reopening', async () => {
    await reset(ED);
    await evaluate(`window.__store.getState().setPrefs({ autoFormat: false }); 1`);
    await sleep(100);
    await I.type('"x" -- ');
    assert.equal(await para(ED), '"x" -- ');
    await evaluate(`window.__store.getState().setPrefs({ autoFormat: true }); 1`);
    await sleep(100);
    await reset(ED);
    await I.type('"x" -- ');
    assert.equal(await para(ED), '“x” – ');
  });

  await check('AC-3.2.10 an input method commit is exactly what the IME produced', async () => {
    await reset(ED);
    await cdp('Input.imeSetComposition', { text: 'ab--', selectionStart: 4, selectionEnd: 4 });
    await sleep(80);
    await cdp('Input.insertText', { text: 'ab-- ... "x" (c) ' });
    await sleep(200);
    assert.equal(await para(ED), 'ab-- ... "x" (c) ');
    await cdp('Input.imeSetComposition', { text: '-', selectionStart: 1, selectionEnd: 1 });
    await sleep(60);
    await cdp('Input.insertText', { text: '-' });
    await sleep(250);
    await I.type(' ');
    // (the commit "-" after "...(c) " is a dash and a space typed after it: nothing pending, so no replacement either way)
    assert.ok((await para(ED)).startsWith('ab-- ... "x" (c) '), await para(ED));
  });

  await check('AC-3.2.9 German and French', async () => {
    await evaluate(languageJs('de')); await sleep(300);
    await reset(ED);
    await I.type(`"Test" 'a' x -- y don't`);
    assert.equal(await para(ED), '„Test“ ‚a‘ x – y don’t');
    await evaluate(languageJs('fr')); await sleep(300);
    await reset(ED);
    await I.type(`"Test" 'a' x -- y `);
    assert.equal(await para(ED), `«${NB}Test${NB}» ‘a’ x – y `);
    await evaluate(languageJs('ja')); await sleep(300);
    await reset(ED);
    await I.type('a -- b "c"');
    assert.equal(await para(ED), 'a -- b “c”');
    await evaluate(languageJs('en')); await sleep(300);
  });

  // ---- Settings: the row in 8 languages at both sizes, and the signature editor (AC-3.2.11, AC-3.2.13)
  for (const [w, h] of [[946, 552], [1266, 792]]) {
    await H.openApp('lang=en', w, h);
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:all' }); 1`);
    assert.ok(await waitFor(`!!document.querySelector('.nav-sub button')`), 'Settings did not open');
    assert.ok(await evaluate(`(() => { const b = [...document.querySelectorAll('.nav-sub button')].find((x) => /compos/i.test(x.textContent)); if (!b) return false; b.click(); return true; })()`), 'no Composing section');
    assert.ok(await waitFor(`!!document.getElementById('set-autoFormat')`), 'the Composing section has no AutoFormat row');
    await sleep(200);
    for (const lang of ['en', 'vi', 'fr', 'zh-Hans', 'es', 'ja', 'de', 'ru']) {
      await evaluate(languageJs(lang));
      await sleep(250);
      await check(`AC-3.2.13 the row in ${lang} at ${w}`, async () => {
        const r = await evaluate(`(() => {
          const row = document.getElementById('set-autoFormat');
          if (!row) return null;
          row.scrollIntoView({ block: 'center' });
          const m = document.querySelector('.modal').getBoundingClientRect(), lbl = row.querySelector('.set-lbl'), q = row.getBoundingClientRect();
          const sw = row.querySelector('input[type=checkbox]');
          const bad = [...row.querySelectorAll('.set-lbl > div, .set-lbl')].filter((el) => el.scrollWidth > el.clientWidth + 1);
          return { txt: lbl.innerText, checked: sw.checked, inside: q.left >= m.left - 1 && q.right <= m.right + 1, clipped: bad.length, raw: /settings\\.composing/.test(row.innerText), ariaName: sw.getAttribute('aria-label') };
        })()`);
        assert.ok(r, 'no row');
        assert.equal(r.checked, true, 'on by default');
        assert.equal(r.raw, false, 'a raw key is shown');
        assert.ok(r.inside && r.clipped === 0, JSON.stringify(r));
        const quote = { fr: "«", ru: "«", es: "«", de: "„" }[lang] ?? "“";
        assert.ok(r.txt.includes(quote), `the hint shows the quotes of ${lang}: ${r.txt}`);
      });
    }
    await evaluate(languageJs('en'));
  }

  await H.openApp('lang=en', 946, 552);
  await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:a1' }); 1`);
  await sleep(800);
  const clickText = (sel, text) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  assert.ok(await clickText('.modal button', 'Signatures'), 'no Signatures entry');
  await sleep(500);
  assert.ok(await clickText('.modal button', 'New signature'), 'no New signature button');
  assert.ok(await waitFor(`!!document.querySelector('.rich-body .tiptap')?.editor`, 15000), 'the signature editor did not start');
  await sleep(500);
  await evaluate(`${RICH}.commands.focus('start'); 1`);
  await sleep(100);
  await check('AC-3.2.11 the signature editor converts and undoes', async () => {
    await I.type('"Hi" -- (c) ...');
    assert.equal(await para(RICH), '“Hi” – © …');
    await I.keys.ctrl('z');
    assert.equal(await para(RICH), '“Hi” – © ...', 'Ctrl+Z gives the last replacement back');
  });
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-autoformat-ui: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('test-autoformat-ui: ok');
