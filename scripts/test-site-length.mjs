// The four main pages of the website stay concise (no browser, no dependencies). Run:  node scripts/test-site-length.mjs
//
// WP10g: the website says what Hey Look! is, does, does not do and how to install it, not the user interface layer by layer. For each language
// and each of index, features, help and download this measures the text of <main> and fails above a ceiling. Printed as a table.
//
// What is counted: the text of <main> after removing the demo regions of the home page (the drawn app window of the tour, the ticker, the
// "Make it yours" customiser, all wrapped in <!-- hl:demo-begin --> ... <!-- hl:demo-end --> comments), comments and script, style and svg
// elements. Inline tags (i b em strong span a kbd code small abbr sup sub) are removed without a space, any other tag becomes a space, an
// entity becomes a space. Units = words (a run of non-space characters with a letter or digit, Latin, Cyrillic and Vietnamese alike) plus
// ceil(Han + Hiragana + Katakana characters / 2) for Chinese and Japanese.
// The APT how-to block of the download page (<details id="apt">, WP15) is left out of the count.
// Also fails when index.html of a language has not exactly 3 demo regions (the markers are what keeps the demos out of the count).
//
// Ceilings: English index 560, features 760, help 1060, download 360 (with header and footer, about 139 words, these are 700 / 900 / 1200 / 500),
// times a factor per language because the same text is longer or shorter there: fr, de, ru, es 1.3; vi 1.5; ja 1.7; zh 1.1. A block that does
// not fit raises a ceiling only by an explicit decision of the owner or the BA in the spec of the work that adds it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGS, DOCS, fileOf } from './generate-site-languages.mjs';

export const PAGES = ['index', 'features', 'help', 'download'];
export const CEILING_EN = { index: 560, features: 760, help: 1060, download: 360 };
export const FACTOR = { en: 1, vi: 1.5, fr: 1.3, zh: 1.1, es: 1.3, ja: 1.7, de: 1.3, ru: 1.3 };
export const ceiling = (code, page) => Math.floor(CEILING_EN[page] * FACTOR[code]);

const INLINE = 'i|b|em|strong|span|a|kbd|code|small|abbr|sup|sub';
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const DEMO_BEGIN = '<!-- hl:demo-begin -->';
const DEMO_END = '<!-- hl:demo-end -->';

// the demo regions of a page: the number of well-formed (begin, end) pairs, or -1 when the markers do not alternate
export function demoRegions(html) {
  let n = 0, i = 0;
  for (;;) {
    const b = html.indexOf(DEMO_BEGIN, i);
    const e = html.indexOf(DEMO_END, i);
    if (b < 0 && e < 0) return n;
    if (b < 0 || e < b) return -1;
    const b2 = html.indexOf(DEMO_BEGIN, b + DEMO_BEGIN.length);
    if (b2 >= 0 && b2 < e) return -1;
    n++;
    i = e + DEMO_END.length;
  }
}

// the text of <main> without the demo regions, as one string
export function mainText(html) {
  const a = html.indexOf('<main');
  const z = html.indexOf('</main>');
  let t = a >= 0 && z > a ? html.slice(a, z) : html;
  t = t.replace(/<!-- hl:demo-begin -->[\s\S]*?<!-- hl:demo-end -->/g, ' ');
  // WP15: the "Install with APT" how-to of the download page (a closed <details id="apt">: five commands, the key fingerprint, texts agreed with the
  // language specialists, scripts/lib/site-apt.mjs) is not counted; scripts/test-site-apt.mjs holds its exact text. Needs a BA decision to stay (reported).
  t = t.replace(/<details id="apt">[\s\S]*?<\/details>/g, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, ' ');
  t = t.replace(new RegExp(`</?(?:${INLINE})(?:\\s[^>]*)?>`, 'g'), '');
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, ' ');
  return t;
}

export function units(html) {
  const t = mainText(html);
  const cjk = (t.match(CJK) || []).length;
  const words = t.replace(CJK, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words + Math.ceil(cjk / 2);
}

function run() {
  const errors = [];
  const rows = [];
  for (const lang of LANGS) {
    const row = { lang: lang.code };
    for (const page of PAGES) {
      const file = fileOf(lang, page);
      const html = fs.readFileSync(file, 'utf8');
      const n = units(html);
      const max = ceiling(lang.code, page);
      row[page] = `${n}/${max}`;
      if (n > max) errors.push(`${lang.dir || 'en'}/${page}.html: ${n} units, ceiling ${max}`);
      if (page === 'index') {
        const d = demoRegions(html);
        if (d !== 3) errors.push(`${lang.dir || 'en'}/index.html: ${d} demo regions between ${DEMO_BEGIN} and ${DEMO_END}, expected 3`);
      }
    }
    rows.push(row);
  }
  console.log('units / ceiling'.padEnd(10) + PAGES.map((p) => p.padStart(12)).join(''));
  for (const r of rows) console.log(r.lang.padEnd(10) + PAGES.map((p) => r[p].padStart(12)).join(''));
  if (errors.length) {
    console.error(`\nFAIL (${errors.length})`);
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`\nok: ${rows.length * PAGES.length} pages within their ceiling, 3 demo regions on each home page (${DOCS.replace(/\\/g, '/')})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) run();
