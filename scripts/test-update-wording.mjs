#!/usr/bin/env node
// The update-check timing, in words and in code (no browser, no dependencies). Run:  node scripts/test-update-wording.mjs
//
// src-tauri/src/update.rs decides when the app asks GitHub for a newer version: STARTUP_GAP_SECS 300 (a launch checks when the last attempt is
// 5 minutes old), EVERY_SECS 7200 (a window that comes back checks when the last attempt is 2 hours old), RETRY_SECS 900 (15 minutes after a
// failed attempt). Three texts say so in each of the 8 languages:
//   - help.html #updates, the first paragraph (the website)
//   - the app string settings.about.autoCheckHint (Settings > About)
//   - privacy.html section 2, the github.com row (the privacy policy)
// This test reads the three numbers from the Rust file, fails unless they are 300, 7200 and 900, and fails unless each of those texts, in each
// language, says "2" together with that language's word for hours and "15" together with its word for minutes, and has no vague wording
// ("a couple of hours", "several hours" ...). If the numbers change, change the texts (and this test) with them.
//
// NOT_YET: the texts whose work package has not changed them yet. Each package that changes one removes it from this list:
//   'app'      the app string settings.about.autoCheckHint (WP10d)
import fs from 'node:fs';
import path from 'node:path';
import { LANGS, DOCS } from './generate-site-languages.mjs';

const NOT_YET = ['app'];

const ROOT = path.join(DOCS, '..');
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const errors = [];
const fail = (msg) => errors.push(msg);

// ---------- the numbers in the code ----------
const WANT = { STARTUP_GAP_SECS: 300, EVERY_SECS: 7200, RETRY_SECS: 900 };
const rsPath = arg('update-rs') || path.join(ROOT, 'src-tauri/src/update.rs');
const rs = fs.readFileSync(rsPath, 'utf8');
const TEXTS = 'help.html #updates (first paragraph), the app string settings.about.autoCheckHint (src/i18n) and the github.com row of privacy.html section 2, all in 8 languages';
for (const [name, want] of Object.entries(WANT)) {
  const m = new RegExp(`const ${name}: i64 = ([0-9 *]+);`).exec(rs);
  if (!m) { fail(`${path.relative(ROOT, rsPath)}: "const ${name}: i64 = ...;" was not found or changed shape: update this test with it`); continue; }
  const got = m[1].split('*').reduce((n, x) => n * Number(x.trim()), 1);
  if (got !== want) fail(`${path.relative(ROOT, rsPath)}: ${name} is ${got}, the texts say ${want >= 3600 ? `${want / 3600} hours` : `${want / 60} minutes`} (${want}): change ${TEXTS}, and this test`);
}

// ---------- the words ----------
// hour / minute: a regex for "<number> <unit>" in that language; vague: wording that is not an exact interval
const WORDS = {
  en: { h: /(?<![\d.])2 hours/, m: /(?<![\d.])15 minutes/, vague: /couple of hours|several hours|few hours/i },
  vi: { h: /(?<!\d)2 giờ/, m: /(?<!\d)15 phút/, vague: /vài giờ/ },
  fr: { h: /(?<!\d)2 heures/, m: /(?<!\d)15 minutes/, vague: /quelques heures/ },
  zh: { h: /(?<!\d)2小时/, m: /(?<!\d)15分钟/, vague: /几个小时|数小时/ },
  es: { h: /(?<!\d)2 horas/, m: /(?<!\d)15 minutos/, vague: /un par de horas|varias horas/ },
  ja: { h: /(?<!\d)2時間/, m: /(?<!\d)15分/, vague: /数時間/ },
  de: { h: /(?<!\d)2 Stunden/, m: /(?<!\d)15 Minuten/, vague: /ein paar Stunden|mehrere Stunden/ },
  ru: { h: /(?<!\d)2 (?:час|часа|часов)(?![а-яё])/, m: /(?<!\d)15 минут/, vague: /пару часов|несколько часов/ },
};

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', rsquo: '’', ldquo: '“', rdquo: '”', bdquo: '„' };
const plain = (s) => s.replace(/<[^>]*>/g, '').replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m).replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

function check(where, code, text) {
  const w = WORDS[code];
  if (!w.h.test(text)) fail(`${where} (${code}): must say "at most every 2 hours" (the hour word of ${code} with the number 2): "${text}"`);
  if (!w.m.test(text)) fail(`${where} (${code}): must say "15 minutes" (the minute word of ${code} with the number 15): "${text}"`);
  if (w.vague.test(text)) fail(`${where} (${code}): vague wording, say the exact interval (2 hours): "${text}"`);
}
const pageOf = (l, f) => path.join(DOCS, l.dir, f);

for (const l of LANGS) {
  // help.html #updates, the first paragraph
  const help = fs.readFileSync(pageOf(l, 'help.html'), 'utf8');
  const hm = /<details[^>]*\sid="updates"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(help);
  if (!hm) fail(`${l.dir || '.'}/help.html: #updates has no paragraph`); else check('help.html #updates', l.code, plain(hm[1]));

  // privacy.html section 2: the github.com row, the "when" cell
  if (!NOT_YET.includes('privacy')) {
    const pr = fs.readFileSync(pageOf(l, 'privacy.html'), 'utf8');
    const pm = /<tr><th scope="row">github\.com<\/th><td>([\s\S]*?)<\/td>/.exec(pr);
    if (!pm) fail(`${l.dir || '.'}/privacy.html: no github.com row in the table of section 2`); else check('privacy.html section 2 (github.com)', l.code, plain(pm[1]));
  }
}

// the app string: en is in src/i18n/ns/settings.ts, the others in src/i18n/locales/<code>/settings.ts
if (!NOT_YET.includes('app')) {
  const hint = (src) => [...src.matchAll(/"settings\.about\.autoCheckHint":\s*("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
  const ns = hint(fs.readFileSync(path.join(ROOT, 'src/i18n/ns/settings.ts'), 'utf8'));
  if (ns.length !== 1) fail(`src/i18n/ns/settings.ts: ${ns.length} settings.about.autoCheckHint strings, expected 1 (en)`);
  else check('settings.about.autoCheckHint', 'en', plain(ns[0]));
  for (const l of LANGS.filter((x) => x.code !== 'en')) {
    const folder = l.code === 'zh' ? 'zh-Hans' : l.code;
    const f = path.join(ROOT, `src/i18n/locales/${folder}/settings.ts`);
    const got = fs.existsSync(f) ? hint(fs.readFileSync(f, 'utf8')) : [];
    if (got.length !== 1) fail(`src/i18n/locales/${folder}/settings.ts: ${got.length} settings.about.autoCheckHint strings, expected 1`); else check('settings.about.autoCheckHint', l.code, plain(got[0]));
  }
}

if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
console.log(`ok - test-update-wording (update.rs 300 / 7200 / 900; help #updates in ${LANGS.length} languages${NOT_YET.includes('privacy') ? '' : ', privacy github.com row'}${NOT_YET.includes('app') ? '' : ', app hint'}; not yet changed: ${NOT_YET.join(', ') || 'none'})`);
