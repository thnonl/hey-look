#!/usr/bin/env node
// The "Last updated" date of the four legal pages (privacy, terms, google-data, security) is one shared date, in every language (no dependencies).
// Run:  node scripts/test-legal-dates.mjs
// Policy (decided by the owner): whenever any of the legal pages changes in a release, all four get the same date; security.html carries the same
// line at the start of its lead. So the four pages of a language must show the same day, and every language the same day as English.
import fs from 'node:fs';
import path from 'node:path';
import { LANGS, DOCS } from './generate-site-languages.mjs';

const PAGES = ['privacy', 'terms', 'google-data', 'security'];
const MONTHS = { en: 'October', vi: '10', fr: 'octobre', zh: '10', es: 'octubre', ja: '10', de: 'Oktober', ru: 'октября' };
// the date as each language writes it: [regex with groups (day, month name or number, year)]
const RX = {
  en: /<p class="lead">Last updated: (\d{1,2}) ([A-Z][a-z]+) (\d{4})\./,
  vi: /<p class="lead">Cập nhật lần cuối: (\d{1,2}) tháng (\d{1,2}) năm (\d{4})\./,
  fr: /<p class="lead">Dernière mise à jour&nbsp;: (\d{1,2}) ([a-zéû]+) (\d{4})\./,
  zh: /<p class="lead">最后更新：(\d{4})年(\d{1,2})月(\d{1,2})日。/,
  es: /<p class="lead">Última actualización: (\d{1,2}) de ([a-z]+) de (\d{4})\./,
  ja: /<p class="lead">最終更新日：(\d{4})年(\d{1,2})月(\d{1,2})日。/,
  de: /<p class="lead">Zuletzt aktualisiert: (\d{1,2})\. ([A-Za-zä]+) (\d{4})\./,
  ru: /<p class="lead">Последнее обновление: (\d{1,2}) ([а-я]+) (\d{4}) г\./,
};
const NUM = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const errors = [];
const days = new Map();
for (const l of LANGS) {
  for (const p of PAGES) {
    const f = path.join(DOCS, l.dir, p + '.html');
    const m = RX[l.code].exec(fs.readFileSync(f, 'utf8'));
    if (!m) { errors.push(`${l.dir || '.'}/${p}.html: no "Last updated" date at the start of a lead paragraph`); continue; }
    let d, mo, y;
    if (l.code === 'zh' || l.code === 'ja') [y, mo, d] = m.slice(1).map(Number);
    else {
      d = Number(m[1]); y = Number(m[3]);
      if (l.code === 'vi') mo = Number(m[2]);
      else if (l.code === 'en') mo = NUM[m[2]];
      else if (m[2] === MONTHS[l.code]) mo = 10;
      else { errors.push(`${l.dir || '.'}/${p}.html: month "${m[2]}" is not the month this test knows (${MONTHS[l.code]}); extend MONTHS with it`); continue; }
    }
    days.set(`${l.code}/${p}`, `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
}
const first = days.get('en/privacy');
for (const [k, v] of days) if (v !== first) errors.push(`${k}: dated ${v}, English privacy.html is dated ${first}: the four legal pages carry one date in every language`);
if (first && !/^\d{4}-\d{2}-\d{2}$/.test(first)) errors.push(`bad date ${first}`);
if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
console.log(`ok - test-legal-dates (${PAGES.length} legal pages x ${LANGS.length} languages, all dated ${first})`);
