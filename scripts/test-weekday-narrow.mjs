#!/usr/bin/env node
// The one-letter weekday header of the mini calendars (1.0.11): it comes from Intl, so Spanish writes "D L M X J V S" (Wednesday is X; the
// date-fns narrow weekday of Spanish is lower case and has "m" twice). Every language, week starting on Sunday.
//   node --experimental-strip-types scripts/test-weekday-narrow.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { setLangPref, loadAllLanguages } = await import('../src/i18n/index.ts');
await loadAllLanguages();
const { weekdayName } = await import('../src/i18n/format.ts');
// (src/calendar.ts wdNarrow is this call, checked at the end: node cannot load that file)
const wdNarrow = (wd) => weekdayName(wd, 'narrow');

const NARROW = {
  en: 'S M T W T F S',
  de: 'S M D M D F S',
  es: 'D L M X J V S',
  fr: 'D L M M J V S',
  ru: 'В П В С Ч П С',
  vi: 'CN T2 T3 T4 T5 T6 T7',
  ja: '日 月 火 水 木 金 土',
  'zh-Hans': '日 一 二 三 四 五 六',
};
for (const [lang, want] of Object.entries(NARROW)) {
  setLangPref(lang);
  assert.equal([0, 1, 2, 3, 4, 5, 6].map(wdNarrow).join(' '), want, `${lang}: weekday header`);
}
// Spanish: upper case, and Wednesday is told from Tuesday
setLangPref('es');
assert.equal(wdNarrow(3), 'X');
assert.notEqual(wdNarrow(2), wdNarrow(3));
assert.equal(wdNarrow(1), wdNarrow(1).toUpperCase());

// the mini calendars take their header from wdNarrow, and wdNarrow from Intl (not from a date-fns pattern)
const cal = readFileSync(new URL('../src/calendar.ts', import.meta.url), 'utf8');
const line = cal.split(/\r?\n/).find((l) => l.startsWith('export const wdNarrow'));
assert.equal(line, 'export const wdNarrow = (wd: number) => weekdayName(wd, "narrow");');
console.log('ok test-weekday-narrow');
