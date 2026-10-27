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
// The APT how-to block of the download page is left out of the count (WP15, DEC-020), and ONLY that: exactly one `<details id="apt">` on a
// download page, written exactly like that (closed by default: no `open`, no other attribute), without another <details> inside; on any other
// page such an element is an error and is not skipped. Anything else that is skipped (a second block, an open one, another element) fails the test.
// The ceilings below are unchanged (download 360 in English).
// WP14 (Microsoft Store): the Store block of the Windows card on the download page (`<div class="asset" id="store-block" hidden>`, texts agreed with the language specialists) is hidden
// until STORE_PRODUCT_ID in docs/assets/site.js is set, so while it is empty the block is not read by anyone and is left out of the count: exactly one, written exactly like
// that, flat (no <div> inside), on the download page only (anywhere else it is an error and is counted). Once the product is published (STORE_PRODUCT_ID set) the block is
// visible and IS counted: the ceilings stay as they are, and that is the moment the owner or the BA decides whether the block fits.
// Also fails when index.html of a language has not exactly 3 demo regions (the markers are what keeps the demos out of the count).
//
// Ceilings: English index 560, features 760, help 1060, download 360 (with header and footer, about 139 words, these are 700 / 900 / 1200 / 500),
// times a factor per language because the same text is longer or shorter there: fr, de, ru, es 1.3; vi 1.5; ja 1.7; zh 1.1. A block that does
// not fit raises a ceiling only by an explicit decision of the owner or the BA in the spec of the work that adds it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LANGS, DOCS, fileOf } from './generate-site-languages.mjs';

export const PAGES = ['index', 'features', 'help', 'download'];
// 1.0.10: features 760 -> 800 (auto-shown pictures and privacy placeholders; orchestrator decision 2026-10-28, the new privacy feature text is legitimate)
export const CEILING_EN = { index: 560, features: 800, help: 1060, download: 360 };
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

/**
 * The one exception to the count (DEC-020): the byte range of the `<details id="apt">…</details>` of a download page and the problems with it.
 * Returns { range: [from, to] | null, problems: [] }. The range is only given when everything is as it must be.
 */
export function aptBlock(html, page) {
  const problems = [];
  const tags = [...html.matchAll(/<details\b[^>]*>/g)].filter((m) => /\bid\s*=\s*["']?apt\b/i.test(m[0]));
  if (page !== 'download') {
    if (tags.length) problems.push(`${tags.length} <details id="apt"> on a page that is not the download page (it is only skipped there)`);
    return { range: null, problems };
  }
  if (tags.length !== 1) {
    problems.push(`${tags.length} <details id="apt"> on the download page, expected exactly one`);
    return { range: null, problems };
  }
  const [m] = tags;
  if (m[0] !== '<details id="apt">') problems.push(`the block is ${m[0]}, expected exactly <details id="apt"> (closed by default: no open attribute, nothing else)`);
  const from = m.index;
  const end = html.indexOf('</details>', from);
  if (end < 0) problems.push('the <details id="apt"> block is never closed');
  const inner = end < 0 ? '' : html.slice(from + m[0].length, end);
  if (/<details\b/i.test(inner)) problems.push('another <details> sits inside the APT block (the exception covers one flat element)');
  return { range: problems.length ? null : [from, end + '</details>'.length], problems };
}

/** Is the Store block visible, that is, is STORE_PRODUCT_ID of docs/assets/site.js set (12 characters)? */
export function storeOn(siteJs = fs.readFileSync(new URL('../docs/assets/site.js', import.meta.url), 'utf8')) {
  const m = /var STORE_PRODUCT_ID = '([^']*)';/.exec(siteJs);
  if (!m) throw new Error("docs/assets/site.js has no `var STORE_PRODUCT_ID = '...';`");
  return /^[0-9A-Z]{12}$/.test(m[1]);
}

/** The Store block of a download page: { range: [from, to] | null, problems: [] }; the range only when it is exactly as it must be. */
export function storeBlock(html, page) {
  const problems = [];
  const tags = [...html.matchAll(/<div\b[^>]*>/g)].filter((m) => /\bid\s*=\s*["']?store-block\b/i.test(m[0]));
  if (page !== 'download') {
    if (tags.length) problems.push(`${tags.length} store-block on a page that is not the download page`);
    return { range: null, problems };
  }
  if (tags.length !== 1) return { range: null, problems: [`${tags.length} store-block on the download page, expected exactly one`] };
  const [m] = tags;
  if (m[0] !== '<div class="asset" id="store-block" hidden>') problems.push(`the Store block is ${m[0]}, expected exactly <div class="asset" id="store-block" hidden>`);
  const end = html.indexOf('</div>', m.index);
  if (end < 0) problems.push('the Store block is never closed');
  else if (/<div\b/i.test(html.slice(m.index + m[0].length, end))) problems.push('another <div> sits inside the Store block');
  return { range: problems.length ? null : [m.index, end + '</div>'.length], problems };
}

// the text of <main> without the demo regions (and, on the download page, the APT block), as one string
export function mainText(html, page, store = storeOn()) {
  const a = html.indexOf('<main');
  const z = html.indexOf('</main>');
  let t = a >= 0 && z > a ? html.slice(a, z) : html;
  // WP15 / DEC-020: the "Install with APT" how-to of the download page (a closed <details id="apt">: five commands, the key fingerprint, texts agreed
  // with the language specialists) is not counted; scripts/test-site-apt.mjs holds its exact text. Only that one element, only there (aptBlock).
  const apt = aptBlock(t, page).range;
  if (apt) t = t.slice(0, apt[0]) + ' ' + t.slice(apt[1]);
  // WP14: the Store block while it is hidden (STORE_PRODUCT_ID empty); counted once the product is published
  const sb = store ? null : storeBlock(t, page).range;
  if (sb) t = t.slice(0, sb[0]) + ' ' + t.slice(sb[1]);
  t = t.replace(/<!-- hl:demo-begin -->[\s\S]*?<!-- hl:demo-end -->/g, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, ' ');
  t = t.replace(new RegExp(`</?(?:${INLINE})(?:\\s[^>]*)?>`, 'g'), '');
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, ' ');
  return t;
}

export function units(html, page, store = storeOn()) {
  const t = mainText(html, page, store);
  const cjk = (t.match(CJK) || []).length;
  const words = t.replace(CJK, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words + Math.ceil(cjk / 2);
}

// The exception is exactly one closed block on a download page (DEC-020): proof on synthetic pages.
function selfcheck() {
  const bad = [];
  const main = (inner) => `<main>${inner}</main>`;
  const blk = '<details id="apt"><summary>Install</summary><p>one two three four five six seven eight nine ten</p></details>';
  const base = main('<p>alpha beta gamma</p>' + blk);
  const is = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
  is('the block is skipped on the download page', units(base, 'download'), 3);
  is('the same text outside the block is counted', units(main('<p>alpha beta gamma</p><p>one two three four five six seven eight nine ten</p>'), 'download'), 13);
  is('text in the block does not change the count', units(base.replace('nine ten', 'nine ten eleven twelve'), 'download'), 3);
  is('a valid block has no problem', aptBlock(base, 'download').problems, []);
  is('two blocks are an error and none is skipped', [aptBlock(main(blk + blk), 'download').problems.length, aptBlock(main(blk + blk), 'download').range], [1, null]);
  is('no block on the download page is an error', aptBlock(main('<p>x</p>'), 'download').problems.length, 1);
  is('an open block is an error and is counted', [aptBlock(base.replace('<details id="apt">', '<details id="apt" open>'), 'download').problems.length, units(base.replace('<details id="apt">', '<details id="apt" open>'), 'download') > 3], [1, true]);
  is('another attribute is an error and is counted', [aptBlock(base.replace('<details id="apt">', '<details id="apt" class="x">'), 'download').problems.length, units(base.replace('<details id="apt">', '<details id="apt" class="x">'), 'download') > 3], [1, true]);
  is('a details inside the block is an error', aptBlock(main(blk.replace('<p>', '<details><summary>s</summary></details><p>')), 'download').problems.length, 1);
  is('a block that never closes is an error', aptBlock(main(blk.replace('</details>', '')), 'download').problems.length, 1);
  is('a block on another page is an error and is counted', [aptBlock(base, 'help').problems.length, units(base, 'help')], [1, 14]);
  is('other closed details are counted', units(main('<details><summary>Notes</summary><p>a b c</p></details>' + blk), 'download'), 4);
  // the Store block (WP14): skipped while hidden, counted when the product is published, errors when it is not exactly as agreed
  const sblk = '<div class="asset" id="store-block" hidden><strong>Store</strong><a class="btn" href="x"><span class="t">Get it</span></a><small>one two three four five six</small></div>';
  const sb = main('<p>alpha beta gamma</p>' + sblk);
  is('the hidden Store block is skipped', units(sb, 'download', false), 3);
  is('the published Store block is counted', units(sb, 'download', true), 10); // (inline tags are removed without a space: StoreGet, itone, two ... six)
  is('a valid Store block has no problem', storeBlock(sb, 'download').problems, []);
  is('a Store block that is not hidden is an error and is counted', [storeBlock(sb.replace(' hidden>', '>'), 'download').problems.length, units(sb.replace(' hidden>', '>'), 'download', false) > 3], [1, true]);
  is('another attribute on the Store block is an error and is counted', [storeBlock(sb.replace('class="asset" ', 'class="asset x" '), 'download').problems.length, units(sb.replace('class="asset" ', 'class="asset x" '), 'download', false) > 3], [1, true]);
  is('a div inside the Store block is an error', storeBlock(sb.replace('<small>', '<div><small>'), 'download').problems.length, 1);
  is('two Store blocks are an error and none is skipped', [storeBlock(main(sblk + sblk), 'download').problems.length, units(main(sblk + sblk), 'download', false) > 3], [1, true]);
  is('a Store block on another page is an error and is counted', [storeBlock(sb, 'help').problems.length, units(sb, 'help', false) > 3], [1, true]);
  is('no Store block on the download page is an error', storeBlock(main('<p>x</p>'), 'download').problems.length, 1);
  is('STORE_PRODUCT_ID empty is off, 12 characters is on', [storeOn("var STORE_PRODUCT_ID = '';"), storeOn("var STORE_PRODUCT_ID = '9NBLGGH4NNS1';"), storeOn("var STORE_PRODUCT_ID = 'abc';")], [false, true, false]);
  if (bad.length) { console.error('selfcheck failed:\n  ' + bad.join('\n  ')); process.exit(1); }
}

function run() {
  selfcheck();
  const errors = [];
  const rows = [];
  for (const lang of LANGS) {
    const row = { lang: lang.code };
    for (const page of PAGES) {
      const file = fileOf(lang, page);
      const html = fs.readFileSync(file, 'utf8');
      const n = units(html, page);
      const inMain = html.slice(Math.max(0, html.indexOf('<main')), html.indexOf('</main>') > 0 ? html.indexOf('</main>') : undefined);
      for (const pr of aptBlock(inMain, page).problems) errors.push(`${lang.dir || 'en'}/${page}.html: ${pr}`);
      for (const pr of storeBlock(inMain, page).problems) errors.push(`${lang.dir || 'en'}/${page}.html: ${pr}`);
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
