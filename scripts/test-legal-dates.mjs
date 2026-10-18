#!/usr/bin/env node
// The "Last updated" date of the four legal pages (privacy, terms, google-data, security) is one shared date, in every language (no dependencies).
// Run:  node scripts/test-legal-dates.mjs
// Policy (decided by the owner): whenever any of the legal pages changes in a release, all four get the same date; security.html carries the same
// line at the start of its lead. So the four pages of a language must show the same day, every language the same day, and that day is LEGAL_DATE in
// scripts/lib/legal-date.mjs (the one place; to move it: node scripts/set-legal-date.mjs YYYY-MM-DD).
import fs from 'node:fs';
import path from 'node:path';
import { LANGS, DOCS } from './generate-site-languages.mjs';
import { LEGAL_DATE, sentence, finder } from './lib/legal-date.mjs';

const PAGES = ['privacy', 'terms', 'google-data', 'security'];
const errors = [];
try { sentence('en', LEGAL_DATE); } catch (e) { errors.push(`LEGAL_DATE in scripts/lib/legal-date.mjs: ${e.message}`); }
if (!errors.length) {
  for (const l of LANGS) {
    for (const p of PAGES) {
      const f = path.join(DOCS, l.dir, p + '.html');
      const src = fs.readFileSync(f, 'utf8');
      const m = finder(l.code).exec(src);
      const where = `${l.dir || '.'}/${p}.html`;
      if (!m) { errors.push(`${where}: no "Last updated" date at the start of a lead paragraph`); continue; }
      const want = sentence(l.code, LEGAL_DATE);
      if (m[0] !== '<p class="lead">' + want) errors.push(`${where}: says "${m[0].slice('<p class="lead">'.length)}", expected "${want}" (LEGAL_DATE ${LEGAL_DATE}): the four legal pages carry one date in every language; node scripts/set-legal-date.mjs fixes it`);
    }
  }
}
if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
console.log(`ok - test-legal-dates (${PAGES.length} legal pages x ${LANGS.length} languages, all dated ${LEGAL_DATE})`);
