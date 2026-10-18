#!/usr/bin/env node
// The placeholder AND the accessible name (aria-label) of the editors follow the language while they are open. Placeholder: v1.0.6 Mac / Windows QA: a compose that was open when the language was
// switched kept "Write your message…"; one opened afterwards was translated). Real compose pane in the dev preview (src/devMock.ts): the placeholder (the
// data-placeholder of the empty first paragraph, drawn by the Placeholder extension) is read in English, the language is switched under the open compose, and the
// text is read again: it must be the text of the new language, back and forth, and typed text must not be touched.
// Accessible name (W1.4, 1.0.7): the aria-label of the contenteditable of the message body (compose.editor.body), of the signature editor
// (settings.composing.signature) and of the template editor (settings.tpl.message) is read the same way after every switch, and "abc" typed before the switch is
// still there, with its undo step.
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
// the accessible names, from the same files
const word = (file, key) => { const m = new RegExp('"' + key.replace(/\./g, '\\.') + '":\\s*"([^"]+)"').exec(fs.readFileSync(path.join(ROOT, file), 'utf8')); if (!m) throw new Error(`no ${key} in ${file}`); return m[1]; };
const NAMES = {
  body: { en: word('src/i18n/ns/compose.ts', 'compose.editor.body'), de: word('src/i18n/locales/de/compose.ts', 'compose.editor.body'), ru: word('src/i18n/locales/ru/compose.ts', 'compose.editor.body') },
  sig: { en: word('src/i18n/ns/settings.ts', 'settings.composing.signature'), de: word('src/i18n/locales/de/settings.ts', 'settings.composing.signature'), ru: word('src/i18n/locales/ru/settings.ts', 'settings.composing.signature') },
  tpl: { en: word('src/i18n/ns/settings.ts', 'settings.tpl.message'), de: word('src/i18n/locales/de/settings.ts', 'settings.tpl.message'), ru: word('src/i18n/locales/ru/settings.ts', 'settings.tpl.message') },
};
for (const [k, v] of Object.entries(NAMES)) if (new Set([v.en, v.de, v.ru]).size !== 3) throw new Error(`the three accessible names of ${k} are not different texts`);

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
  const NAME = `document.querySelector('.compose-pane .cp-editor .tiptap').getAttribute('aria-label')`;
  ok((await evaluate(NAME)) === NAMES.body.en, `English: the body is named "${await evaluate(NAME)}", expected "${NAMES.body.en}"`);
  for (const [lang, want] of [['de', DE], ['ru', RU], ['en', EN], ['de', DE]]) {
    await evaluate(`window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); 1`);
    ok(await waitFor(want), `${lang}: an open compose shows "${await evaluate(PH)}", expected "${want}"`);
    ok((await evaluate(NAME)) === NAMES.body[lang], `${lang}: the body of an open compose is named "${await evaluate(NAME)}", expected "${NAMES.body[lang]}"`);
    const attrs = await evaluate(ATTRS);
    ok(attrs.length >= 1 && attrs.every((a) => a === want), `${lang}: data-placeholder is ${JSON.stringify(attrs)}, expected "${want}" on every element`);
  }
  // the text typed in the body stays, and the placeholder is gone while there is text (nothing else was touched by the redraw)
  await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').editor.commands.setContent('<p>Typed text</p>'); 1`);
  await evaluate(`window.__store.getState().setPrefs({ language: 'en' }); 1`);
  await sleep(400);
  ok((await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').textContent`)).includes('Typed text'), 'the typed text was lost by the language switch');
  ok((await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap p.is-editor-empty') === null`)), 'the placeholder is shown over typed text');

  // typed text, selection and undo history are untouched by the switches: "abc" is typed, the language goes round, "abc" is still there and one undo takes back the typing
  await evaluate(`window.__store.getState().setPrefs({ language: 'en' }); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').editor.commands.setContent('<p>Typed text</p>'); document.querySelector('.compose-pane .cp-editor .tiptap').editor.commands.focus('end'); 1`);
  await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').editor.commands.insertContent(' abc'); 1`);
  for (const lang of ['de', 'ru', 'en']) {
    await evaluate(`window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); 1`);
    await sleep(300);
    ok((await evaluate(NAME)) === NAMES.body[lang], `${lang}: with text typed the body is named "${await evaluate(NAME)}", expected "${NAMES.body[lang]}"`);
    ok((await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').textContent.includes('abc')`)), `${lang}: the typed text "abc" was lost by the language switch`);
  }
  await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').editor.commands.undo(); 1`);
  const afterUndo = await evaluate(`document.querySelector('.compose-pane .cp-editor .tiptap').textContent`);
  ok(!afterUndo.includes('abc'), `undo after the language switches did not take back the last typing ("${afterUndo}")`);

  // the signature editor and the template editor of Settings
  await evaluate(`window.__store.getState().setPrefs({ language: 'en' }); 1`);
  const id = await evaluate(`window.__store.getState().accounts[0].id`);
  for (const [kind, section, newBtn] of [['sig', /Signatures/i, /New signature/i], ['tpl', /Templates/i, /New template/i]]) {
    await evaluate(`window.__store.getState().setDialog({ type: 'settings', tab: 'mb:' + ${JSON.stringify(id)} }); 1`);
    await sleep(500);
    await evaluate(`[...document.querySelectorAll('.nav-sub button')].find((x) => ${section}.test(x.textContent)).click(); 1`);
    await sleep(400);
    await evaluate(`[...document.querySelectorAll('.settings button.btn')].find((x) => ${newBtn}.test(x.textContent)).click(); 1`);
    await evaluate(`new Promise((ok) => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('.settings .rich .ProseMirror') || Date.now() - t0 > 8000) { clearInterval(t); ok(1); } }, 100); })`);
    await sleep(400);
    const SN = `document.querySelector('.settings .rich .ProseMirror').getAttribute('aria-label')`;
    await evaluate(`(() => { const ed = document.querySelector('.settings .rich .ProseMirror').editor; ed.commands.focus('end'); ed.commands.insertContent('abc'); return 1; })()`);
    ok((await evaluate(SN)) === NAMES[kind].en, `${kind} en: the editor is named "${await evaluate(SN)}", expected "${NAMES[kind].en}"`);
    for (const lang of ['de', 'ru', 'en']) {
      await evaluate(`window.__store.getState().setPrefs({ language: ${JSON.stringify(lang)} }); 1`);
      await sleep(300);
      ok((await evaluate(SN)) === NAMES[kind][lang], `${kind} ${lang}: the open editor is named "${await evaluate(SN)}", expected "${NAMES[kind][lang]}"`);
      ok((await evaluate(`document.querySelector('.settings .rich .ProseMirror').textContent.includes('abc')`)), `${kind} ${lang}: the typed text was lost by the language switch`);
    }
    await evaluate(`window.__store.getState().setDialog(null); 1`);
    await sleep(300);
  }
} catch (e) {
  ok(false, `threw: ${e.message}`);
} finally {
  await H.shutdown();
}
if (failures.length) { console.error(`test-placeholder-lang: ${failures.length} failure(s) in ${checks} checks`); process.exit(1); }
console.log(`test-placeholder-lang: ${checks} checks passed`);
