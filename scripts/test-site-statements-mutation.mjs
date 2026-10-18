#!/usr/bin/env node
// Proof that scripts/test-site-statements.mjs really fails when a removed statement comes back (AC-10.13.2 mobile apps, AC-10.14.2 "more languages / theme editor may come",
// and every other row of its list). No dependencies, nothing on disk is changed. Run:  node scripts/test-site-statements-mutation.mjs
// For every sentence of every row, in every language: the real page is read, the sentence is put back as a new paragraph at the end of the first page it is checked in, and the
// test must report exactly that page and sentence. The unchanged pages must report nothing. The same is done for an English app path in brackets on a translated page.
import fs from 'node:fs';
import path from 'node:path';
import { DOCS, LANGS, PAGES } from './generate-site-languages.mjs';
import { REMOVED, findProblems, englishPathProblems } from './test-site-statements.mjs';

const errors = [];
const lang = (code) => LANGS.find((l) => l.code === code);
const rel = (f) => path.relative(DOCS, f).replace(/\\/g, '/');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const putBack = (file, add) => (f) => { const html = fs.readFileSync(f, 'utf8'); return path.resolve(f) === path.resolve(file) ? html.replace(/<\/main>|<\/body>/, add + '$&') : html; };

const clean = findProblems();
if (clean.errors.length) errors.push('the unchanged pages already fail test-site-statements: fix that first\n    ' + clean.errors.slice(0, 5).join('\n    '));

let mutations = 0;
for (const { row, items } of REMOVED) {
  for (const item of items) {
    const [code, text, only] = item;
    const l = lang(code);
    // a sentence that is checked on every page is put back on the first page of its language, a named one on the first page it names
    const where = path.join(DOCS, l.dir, only ? only[0] : 'index.html');
    const read = putBack(where, `<p>${esc(text)}</p>`);
    const got = findProblems({ rows: [{ row, items: [item] }], read, whole: false }).errors;
    mutations++;
    if (!got.some((e) => e.startsWith(rel(where) + ': says again') && e.includes(text))) errors.push(`${row} ${code}: "${text.slice(0, 60)}" put back into ${rel(where)}, and test-site-statements did not fail on it`);
  }
}
// an English app path on a translated page: in brackets after the translated one (the Russian help page of 1.0.6), and bare
for (const add of ['<p><strong>Настройки &gt; О программе</strong> (Settings &gt; About)</p>', '<p>Open Settings &gt; General</p>']) {
  for (const l of LANGS.filter((x) => x.dir)) {
    for (const p of PAGES) {
      const where = path.join(DOCS, l.dir, p + '.html');
      const got = findProblems({ rows: [], read: putBack(where, add) }).errors;
      mutations++;
      if (!got.some((e) => e.startsWith(`${l.dir}/${p}.html: an English app path`))) errors.push(`${l.dir}/${p}.html: "${add.slice(0, 60)}" was not caught`);
    }
  }
}
if (englishPathProblems('<p>Open System Settings &gt; Privacy &amp; Security</p>').length) errors.push('the macOS "System Settings" path is wrongly reported as an English app path');

if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
console.log(`ok - test-site-statements-mutation (${mutations} sentences put back one at a time, every one caught; the unchanged pages are clean)`);
