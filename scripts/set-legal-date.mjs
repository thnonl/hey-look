#!/usr/bin/env node
// Sets the "Last updated" date of the four legal pages (privacy, terms, google-data, security) in all 8 languages in one go (no dependencies).
//   node scripts/set-legal-date.mjs 2026-11-02     write that day into scripts/lib/legal-date.mjs and the 32 pages
//   node scripts/set-legal-date.mjs                write the day the constant has now into the pages (repairs a page that drifted)
//   node scripts/set-legal-date.mjs --check        change nothing; exit 1 when a page does not show the constant
// Only the date inside the sentence "Last updated: ..." (each language's own words) is rewritten; nothing else on the pages is touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, DOCS } from './generate-site-languages.mjs';
import { LEGAL_DATE, sentence, finder } from './lib/legal-date.mjs';

export const PAGES = ['privacy', 'terms', 'google-data', 'security'];
const LIB = fileURLToPath(new URL('./lib/legal-date.mjs', import.meta.url));

const args = process.argv.slice(2);
const check = args.includes('--check');
const iso = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || LEGAL_DATE;
if (args.some((a) => a !== '--check' && a !== iso)) { console.error('usage: node scripts/set-legal-date.mjs [YYYY-MM-DD] [--check]'); process.exit(2); }

let changed = 0, same = 0;
const todo = [];
for (const l of LANGS) for (const p of PAGES) {
  const f = path.join(DOCS, l.dir, p + '.html');
  const src = fs.readFileSync(f, 'utf8');
  const rx = finder(l.code);
  const m = rx.exec(src);
  if (!m) { console.error(`FAIL ${path.relative(DOCS, f)}: no "Last updated" sentence at the start of a lead paragraph`); process.exit(1); }
  const next = src.replace(rx, (_, open) => open + sentence(l.code, iso));
  if (next === src) same++; else { changed++; todo.push([f, next]); }
}
if (check) {
  if (changed) { console.error(`FAIL ${changed} legal page(s) do not show ${iso}; run: node scripts/set-legal-date.mjs`); process.exit(1); }
  console.log(`ok - set-legal-date --check (${same} legal pages show ${iso})`); process.exit(0);
}
for (const [f, next] of todo) fs.writeFileSync(f, next);
if (iso !== LEGAL_DATE) {
  const lib = fs.readFileSync(LIB, 'utf8');
  fs.writeFileSync(LIB, lib.replace(/export const LEGAL_DATE = '\d{4}-\d{2}-\d{2}';/, `export const LEGAL_DATE = '${iso}';`));
}
console.log(`${iso}: ${changed} legal page(s) rewritten, ${same} already had it${iso !== LEGAL_DATE ? '; scripts/lib/legal-date.mjs updated' : ''}`);
if (changed || iso !== LEGAL_DATE) console.log('next: node scripts/test-legal-dates.mjs && node scripts/generate-site-languages.mjs   (the second one moves the sitemap lastmod of the pages that changed)');
