#!/usr/bin/env node
// 1.0.7 fix42 (D-103, Mac QA root cause): selecting a big mail again and again in the dark canvas kept about 5 MB of native memory per selection on WebKit (linear, never given back); the same loop on the
// original canvas, where no dark walk runs, was flat. The walk (src/darkMail.ts buildDarkSheet) reads the computed style of every element of the mail (about 4,400 in the 2 MB fixture), and WebKit keeps the
// style data it builds after the frame is removed; clearing or navigating the frame away does not give it back. So (1) the walk is made ONCE per mail: the sheet's text and the rule number of every element are
// kept (strings and numbers, not elements or rules) and a second frame of the same mail is dressed from them; (2) a walk that has to be made runs in ONE hidden frame kept for the life of the page, never in a
// message frame, and its result is copied into the message frame by tree position.
// Counted here, in Chromium (the engine-independent part of the cure; the memory itself is read on the Mac, rows WK-42b in webkit-checks-107.md): getComputedStyle calls of the dark path (window.__darkMail:
// walks, cached, scratch, computed, inScratch, inFrame), that the hidden-frame walk gives the SAME sheet text and the SAME tags as a walk of the message frame itself (the look is identical), and that no message frame has its styles read.
//   node scripts/test-dark-walk.mjs [--require-browser]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sleep, startHarness } from './cdp-harness.mjs';
import { FIXTURES, IDS } from './lib/reply-fixtures.mjs';

const H = await startHarness('test-dark-walk', { vitePort0: 6230 });
const { evaluate, cdp } = H;
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${String(e.message).replace(/\s+/g, ' ')}`); } };
const waitFor = async (js, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(js)) return true; } catch { /* between renders */ } await sleep(40); } return false; };
const stats = () => evaluate(`window.__darkMail`);
// the mail is shown, recoloured and its dark sheet is in the frame
const dressed = `(() => { const d = document.querySelector('.msg-frame')?.contentDocument; return !!d && d.documentElement.classList.contains('hm-dark') && !d.documentElement.classList.contains('hm-pend') && [...d.querySelectorAll('style')].some((s) => s.textContent.includes('@layer hm')); })()`;
let settle = 250;
const select = async (id) => {
  await evaluate(`window.__store.getState().select(${JSON.stringify(id)}); 1`);
  assert.ok(await waitFor(dressed), `${id}: the dark mail did not appear`);
  await sleep(settle); // (a mail with pictures is written twice: with them pending, and once they are resolved; each document is walked once)
};
// what the look consists of: the text of the generated sheet and the rule number of every tagged element, in tree order
const look = () => evaluate(`(() => { const d = document.querySelector('.msg-frame').contentDocument; const sheet = [...d.querySelectorAll('style')].map((s) => s.textContent).find((t) => t.includes('@layer hm')) ?? '';
  return { sheet: sheet.length + ':' + sheet.slice(0, 400), rules: (sheet.match(/\\[data-hm=/g) || []).length, tags: [...d.querySelectorAll('[data-hm]')].map((e) => e.getAttribute('data-hm')).join(','), frames: document.querySelectorAll('.msg-frame').length }; })()`);

try {
  await H.openApp('lang=en', 1280, 800);
  await cdp('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await evaluate(FIXTURES);
  await evaluate(`window.__store.getState().setPrefs({ theme: 'dark', mailCanvas: 'dark', loadRemote: false }); window.__store.getState().refresh().then(() => 1); 1`);
  await sleep(800);

  await check('the first selection of a mail walks the document once, the second one of the same mail reads no style at all', async () => {
    settle = 1800;
    const s0 = await stats();
    assert.ok(s0 && typeof s0.walks === 'number', 'window.__darkMail is missing');
    await select(IDS.big);
    const a = await stats();
    const first = await look();
    assert.ok(a.walks - s0.walks >= 1 && a.walks - s0.walks <= 2, `${a.walks - s0.walks} walks for the first selection (one per written document: 2 at most, the mail is written again when its pictures are resolved)`);
    assert.ok(a.computed - s0.computed > 1000, `the 2 MB mail has thousands of elements, the walk read ${a.computed - s0.computed} styles`);
    assert.ok(first.rules > 0 && first.tags.length > 0, 'the walk made rules and tags');
    await select(IDS.huge);
    const b = await stats();
    assert.ok(b.walks - a.walks >= 1 && b.walks - a.walks <= 2, `${b.walks - a.walks} walks for another mail`);
    await select(IDS.big);
    const c = await stats();
    assert.equal(c.walks, b.walks, 'the same mail again is not walked');
    assert.equal(c.computed, b.computed, `the same mail again read ${c.computed - b.computed} styles (0 expected)`);
    assert.ok(c.cached - b.cached >= 1, 'it was answered from the cache');
    const again = await look();
    assert.equal(again.sheet, first.sheet, 'the same sheet text');
    assert.equal(again.rules, first.rules, 'the same number of rules');
    assert.equal(again.tags, first.tags, 'the same rule on the same element, element by element');
    assert.equal(again.frames, 1, 'one message frame');
  });

  await check('a loop of alternating selections reads styles only for the first visit of each mail and never reads a style in a message frame', async () => {
    settle = 3000;
    await select(IDS.huge);
    await select(IDS.big);
    settle = 250;
    const a = await stats();
    for (let i = 0; i < 12; i++) await select(i % 2 ? IDS.huge : IDS.big);
    const z = await stats();
    assert.equal(z.walks, a.walks, `${z.walks - a.walks} walks in 12 selections of mails that were already walked`);
    assert.equal(z.computed, a.computed, `${z.computed - a.computed} styles read in 12 selections`);
    assert.ok(z.cached - a.cached >= 11, `${z.cached - a.cached} cache hits`);
    assert.equal(z.inFrame, a.inFrame, 'a message frame never had its styles read');
    assert.ok(z.cache <= 8, `the cache holds ${z.cache} mails (8 at most)`);
    assert.equal((await look()).frames, 1);
  });

  await check('the walk in the kept hidden frame gives exactly the sheet and the tags of a walk of the message frame itself, and reads no style in the message frame', async () => {
    const one = async (scratchOn) => {
      await evaluate(`window.__darkMailScratch = ${scratchOn}; window.__darkMailClear(); 1`);
      await select(IDS.huge);
      await select(IDS.big);
      return { look: await look(), st: await stats() };
    };
    settle = 1800;
    const direct = await one(false);
    const hidden = await one(true);
    await evaluate('window.__darkMailScratch = true; 1');
    assert.ok(direct.look.rules > 0, 'the mail has rules to compare');
    assert.equal(hidden.look.sheet, direct.look.sheet, 'the same sheet text');
    assert.equal(hidden.look.tags, direct.look.tags, 'the same rule on the same element');
    assert.ok(direct.st.inFrame > 0, 'the control walked the message frame');
    assert.equal(hidden.st.inFrame, direct.st.inFrame, `the hidden-frame run read ${hidden.st.inFrame - direct.st.inFrame} styles in message frames`);
    assert.ok(hidden.st.inScratch > 0, 'the walk ran in the hidden frame');
    assert.equal(await evaluate(`document.querySelectorAll('iframe').length`), 2, 'the message frame and the one kept hidden frame');
  });

  await check('a dark mail is written with its rules in it: the message frame has no element of it listed or wrapped for the dark mode (fix44, D-103)', async () => {
    settle = 1800;
    await evaluate('window.__darkMailScratch = true; window.__darkMailClear(); 1');
    await select(IDS.huge);
    await select(IDS.big);
    settle = 250;
    const a = await stats();
    for (let i = 0; i < 12; i++) await select(i % 2 ? IDS.huge : IDS.big);
    const z = await stats();
    assert.ok(z.tagged - a.tagged >= 12, `${z.tagged - a.tagged} of 12 selections were written from the tagged document`);
    // frameWrappers counts the frame's elements our dark code listed: only the pictures of the mail (logo check) may be, never the thousands of elements of the 2 MB mail
    assert.ok(z.frameWrappers - a.frameWrappers <= 12 * 40, `${z.frameWrappers - a.frameWrappers} frame elements wrapped in 12 selections`);
    const sheetEl = await evaluate(`(() => { const d = document.querySelector('.msg-frame').contentDocument; return { id: !!d.getElementById('hm-dark-sheet'), styles: [...d.querySelectorAll('style')].filter((x) => x.textContent.includes('@layer hm')).length, csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]').content, doctype: !!d.doctype }; })()`);
    assert.ok(sheetEl.id && sheetEl.styles === 1, 'one dark sheet, the one that came in the written text: ' + JSON.stringify(sheetEl));
    assert.ok(/img-src data:/.test(sheetEl.csp), "the mail's own CSP is back in the document (not the hidden frame's): " + sheetEl.csp);
    assert.ok(sheetEl.doctype, 'the document keeps its doctype (standards mode)');
    // control: with the hidden frame off the old path lists the elements of the message frame
    const c0 = await stats();
    await evaluate('window.__darkMailScratch = false; window.__darkMailClear(); 1');
    settle = 1800;
    await select(IDS.big);
    const c1 = await stats();
    await evaluate('window.__darkMailScratch = true; 1');
    assert.ok(c1.frameWrappers - c0.frameWrappers > 1000, `the control (no hidden frame) listed ${c1.frameWrappers - c0.frameWrappers} elements of the message frame`);
    settle = 250;
  });

  await check('the cache holds text and numbers only: no element, rule or style object is kept', async () => {
    const src = readFileSync(new URL('../src/darkMail.ts', import.meta.url), 'utf8');
    assert.ok(/const darkCache = new Map<string, \{ sheet: string; tags: Int32Array; html\?: string \}>\(\)/.test(src), 'the cache entry is {sheet: string, tags: Int32Array, html?: string}: text and numbers');
    assert.ok(!/new Map<[^>]*(Element|CSSStyleSheet|CSSRule|CSSStyleDeclaration)/.test(src.split('export function buildDarkSheet')[0]), 'no module-level map of elements or style objects before the walk');
    assert.ok(/new WeakMap<Element, HTMLStyleElement>\(\)/.test(src), 'the per-document sheet is a WeakMap keyed by the root');
  });

} finally {
  await H.shutdown();
}
if (failures.length) { console.error(failures.map((f) => 'FAIL ' + f).join('\n')); process.exit(1); }
console.log('ok - test-dark-walk (one walk per mail, in the hidden frame; a repeat reads no style; the same sheet and tags as a walk of the message frame; no style read in a message frame; a dark mail is written tagged, no element of the frame listed; the cache keeps text and numbers only)');
