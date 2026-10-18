#!/usr/bin/env node
// The placeholder of the message body follows the language while the compose is open (v1.0.6 Mac / Windows QA: a compose that was open when the language was
// switched kept "Write your message…"; one opened afterwards was translated). Real compose pane in the dev preview (src/devMock.ts): the placeholder (the
// data-placeholder of the empty first paragraph, drawn by the Placeholder extension) is read in English, the language is switched under the open compose, and the
// text is read again: it must be the text of the new language, back and forth, and typed text must not be touched.
//
//   node scripts/test-placeholder-lang.mjs [--require-browser | --url=http://127.0.0.1:1420/]
import fs from 'node:fs';
import path from 'node:path';
import { sleep, startHarness, ROOT } from './cdp-harness.mjs';

// the expected texts come from the language files (no copy of them here)
const text = (file) => { const m = /"compose\.editor\.placeholder":\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, file), 'utf8')); if (!m) throw new Error(`no compose.editor.placeholder in ${file}`); return m[1]; };
const EN = text('src/i18n/ns/compose.ts');
const DE = text('src/i18n/locales/de/compose.ts');
const RU = text('src/i18n/locales/ru/compose.ts');
if (new Set([EN, DE, RU]).size !== 3) throw new Error('the three placeholders are not different texts');

const H = await startHarness('test-placeholder-lang', { vitePort0: 5680, cdpPort0: 9680 });
const { evaluate } = H;
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures.push(msg); console.error(`FAIL ${msg}`); } };
// what the person sees: the content of the ::before of the first (empty) paragraph, as the browser computes it
const PH = `(() => { const p = document.querySelector('.compose-pane .cp-editor .tiptap p.is-empty:first-child'); if (!p) return null; const c = getComputedStyle(p, '::before').content; return c && c !== 'none' ? c.replace(/^"|"$/g, '') : null; })()`;
// and the data-placeholder of every element that has one (what a script or a screen reader reads)
const ATTRS = `[...document.querySelectorAll('.compose-pane .cp-editor [data-placeholder]')].map((e) => e.getAttribute('data-placeholder'))`;
const waitFor = async (expected) => { for (let i = 0; i < 40; i++) { if ((await evaluate(PH)) === expected) return true; await sleep(100); } return false; };

try {
  await H.openApp('lang=en&aiset', 1280, 800);
  await evaluate(`window.__store.getState().openCompose({ accountId: 'a1', to: ['alice@fabrikam.com'], subject: 'Hello' }); 1`);
  await evaluate(`new Promise((ok, no) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.compose-pane .cp-editor .tiptap')?.editor) { clearInterval(t); ok(1); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error('compose did not start')); } }, 100); })`);
  await sleep(500);
  ok(await waitFor(EN), `English: the placeholder is "${await evaluate(PH)}", expected "${EN}"`);
  for (const [lang, want] of [['de', DE], ['ru', RU], ['en', EN], ['de', DE]]) {
    await evaluate(`window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); 1`);
    ok(await waitFor(want), `${lang}: an open compose shows "${await evaluate(PH)}", expected "${want}"`);
    const attrs = await evaluate(ATTRS);
    ok(attrs.length >= 1 && attrs.every((a) => a === want), `${lang}: data-placeholder is ${JSON.stringify(attrs)}, expected "${want}" on every element`);
  }
  // the text typed in the body stays, and the placeholder is gone while there is text (nothing else was touched by the redraw)
  await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').editor.commands.setContent('<p>Typed text</p>'); 1`);
  await evaluate(`window.__store.getState().setPrefs({ language: 'en' }); 1`);
  await sleep(400);
  ok((await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').textContent`)).includes('Typed text'), 'the typed text was lost by the language switch');
  ok((await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap p.is-editor-empty') === null`)), 'the placeholder is shown over typed text');
} catch (e) {
  ok(false, `threw: ${e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-placeholder-lang: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-placeholder-lang: ${checks} checks passed`);
