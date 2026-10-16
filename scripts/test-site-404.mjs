#!/usr/bin/env node
// Checks how the website's 404 page finds its language, without a browser (no dependencies). Run:  node scripts/test-site-404.mjs
//
// GitHub Pages serves docs/404.html for EVERY missing address, whatever the folder (https://thnonl.github.io/hey-look/de/nope.html and
// https://thnonl.github.io/hey-look/nope.html get the same file). So the page works out two things from the address alone:
//   1. the <base href>, from an inline script in 404.html: /hey-look/ on github.io, / on any other host, . for file:// ;
//   2. the language, from the first folder under the base (assets/site.js, the "404" block): a known language folder loads that
//      dictionary (German 404 for /hey-look/de/nope.html); anything else stays English.
// The whole page is then translated from that dictionary: heading, buttons, header navigation and footer (data-i18n / data-i18n-aria in
// 404.html). Section 5 renders the page with each dictionary and compares its header and footer with the index page of that language.
// The browser language (navigator.language) and any redirect are never used: the site is English at the root and the visitor picks
// another language in the menu. This test runs the real inline script and the real address-to-folder lines of site.js in a vm with
// a fake location, and checks the page, the dictionaries and the scripts for the things that would break that.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { LANGS, DOCS, langBlock } from './generate-site-languages.mjs';

const errors = [];
const fail = (msg) => errors.push(msg);
const read = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const html = read('404.html');
const dictOf = (code) => { const sb = { window: {} }; vm.runInNewContext(read(`assets/i18n/${code}.js`), sb); return sb.window.HL_I18N[code]; };
const siteJs = read('assets/site.js');

// ---------- 1. the inline <base> script ----------
const inline = [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (inline.length !== 1) fail(`404.html: expected exactly one inline script (the <base> one), found ${inline.length}`);
function baseFor(location) {
  let written = '';
  const sandbox = { location, document: { write: (s) => { written += s; } } };
  try { vm.runInNewContext(inline[0] || '', sandbox); } catch (e) { return 'ERROR ' + e.message; }
  return (/<base href="([^"]*)">/.exec(written) || [])[1];
}
const gh = (pathname) => ({ protocol: 'https:', hostname: 'thnonl.github.io', pathname });
const BASE_CASES = [
  [gh('/hey-look/nope.html'), '/hey-look/'],
  [gh('/hey-look/nope'), '/hey-look/'],
  [gh('/hey-look/de/nope.html'), '/hey-look/'],
  [gh('/hey-look/zh/a/b/c.html'), '/hey-look/'],
  [gh('/hey-look/'), '/hey-look/'],
  [{ protocol: 'http:', hostname: 'localhost', pathname: '/de/nope.html' }, '/'],
  [{ protocol: 'http:', hostname: '127.0.0.1', pathname: '/nope.html' }, '/'],
  [{ protocol: 'file:', hostname: '', pathname: 'C:/x/docs/404.html' }, '.'],
];
for (const [loc, want] of BASE_CASES) {
  const got = baseFor(loc);
  if (got !== want) fail(`404.html <base> for ${loc.hostname || loc.protocol}${loc.pathname}: got ${got}, want ${want}`);
}

// the inline script is allowed by its hash in the page's CSP
const cspHash = (/script-src 'self' 'sha256-([^']+)'/.exec(html) || [])[1];
const realHash = inline[0] ? crypto.createHash('sha256').update(inline[0]).digest('base64') : '';
if (cspHash !== realHash) fail(`404.html: the CSP hash of the inline script (${cspHash}) is not its sha256 (${realHash}); the browser would block the <base> script`);

// ---------- 2. address -> language folder (the lines of site.js that do it) ----------
const m = /var basePath = (new URL\(document\.baseURI\)\.pathname), here = (location\.pathname);\s*\n\s*var seg = ([^;\n]+);/.exec(siteJs);
if (!m) fail('assets/site.js: the 404 block ("var basePath = ..., here = ...; var seg = ...;") was not found or changed shape: update this test with it');
const segOf = (base, pathname) => vm.runInNewContext(m[3], {
  basePath: new URL(base, 'https://thnonl.github.io').pathname, here: pathname, location: { pathname }, document: { baseURI: new URL(base, 'https://thnonl.github.io').href },
});
const dirs = LANGS.filter((l) => l.dir).map((l) => l.dir);
const menuDirs = [...html.matchAll(/data-dir="([^"]*)"/g)].map((x) => x[1]).filter(Boolean);
if (JSON.stringify([...menuDirs].sort()) !== JSON.stringify([...dirs].sort())) fail(`404.html: language menu folders ${menuDirs} differ from the language list ${dirs}`);
// what site.js does with seg: a language folder = the menu entry whose data-dir equals seg (else English, nothing is loaded)
const langOf = (seg) => (dirs.includes(seg) && menuDirs.includes(seg) ? seg : 'en');
if (m) {
  const B = '/hey-look/';
  const cases = [
    ['/hey-look/nope.html', 'en'], ['/hey-look/nope', 'en'], ['/hey-look/', 'en'], ['/hey-look/assets/nope.png', 'en'],
    ['/hey-look/de.html', 'en'], ['/hey-look/DE/nope.html', 'en'], ['/hey-look/xx/nope.html', 'en'], ['/hey-look/devil/x.html', 'en'],
    ...dirs.flatMap((d) => [[`/hey-look/${d}/nope.html`, d], [`/hey-look/${d}/a/b/c`, d], [`/hey-look/${d}/`, d]]),
  ];
  for (const [p, want] of cases) {
    const seg = segOf(B, p);
    const got = langOf(seg);
    if (got !== want) fail(`site.js 404 language for ${p}: seg "${seg}" -> ${got}, want ${want}`);
  }
  // the same on a host without a project folder (base /)
  for (const d of dirs) { const got = langOf(segOf('/', `/${d}/nope.html`)); if (got !== d) fail(`site.js 404 language for /${d}/nope.html with base /: ${got}`); }
  if (langOf(segOf('/', '/nope.html')) !== 'en') fail('site.js 404 language for /nope.html with base /: not English');
}

// ---------- 3. what the language page needs ----------
for (const l of LANGS.filter((x) => x.dir)) {
  if (!fs.existsSync(path.join(DOCS, 'assets/i18n', l.code + '.js'))) fail(`assets/i18n/${l.code}.js is missing: the ${l.dir}/ 404 has no dictionary`);
  else {
    const dict = read(`assets/i18n/${l.code}.js`);
    for (const k of ['nf.title', 'nf.h1a', 'nf.h1b', 'nf.lead', 'nf.home', 'nf.download', 'nf.support']) {
      if (!new RegExp(`"${k.replace('.', '\\.')}"\\s*:`).test(dict)) fail(`assets/i18n/${l.code}.js: key ${k} (used by the 404 page) is missing`);
    }
  }
}
for (const k of new Set([...html.matchAll(/data-i18n="(nf\.[^"]+)"/g)].map((x) => x[1]))) {
  const en = read('assets/i18n/en.js');
  if (!new RegExp(`"${k.replace('.', '\\.')}"\\s*:`).test(en)) fail(`assets/i18n/en.js: key ${k} (used by 404.html) is missing`);
}
if (!/<html lang="en">/.test(html)) fail('404.html: <html lang> is not en (English is the default 404)');
if (!/src="assets\/i18n\/en\.js"/.test(html) || !/src="assets\/site\.js"/.test(html)) fail('404.html: the English dictionary and site.js are not loaded');

// ---------- 5. header navigation and footer are translated with the dictionaries ----------
// Render 404.html the way site.js does (data-i18n: text of the element, data-i18n-aria: its aria-label) and compare the header and the
// footer with the same part of the language's own index page: the same text nodes in the same order and the same aria-labels.
// English is checked too (the dictionary must say what the page says).
const decode = (s) => s.replace(/&copy;/g, '©').replace(/&rsquo;/g, '’').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
function render(code) {
  const dict = dictOf(code);
  const get = (k) => (typeof dict[k] === 'string' ? dict[k] : '');
  return html
    .replace(/<(\w+)([^>]*?\sdata-i18n="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, k) => `<${tag}${attrs}>${escText(get(k))}</${tag}>`)
    .replace(/<\w+[^>]*?\sdata-i18n-aria="([^"]+)"[^>]*>/g, (m, k) => m.replace(/\saria-label="[^"]*"/, ` aria-label="${escAttr(get(k))}"`));
}
function parts(page) {
  const noLang = page.replace(/<!-- hl:lang-begin[\s\S]*?<!-- hl:lang-end -->/, '');
  const head = noLang.slice(noLang.indexOf('<a class="skip"'), noLang.indexOf('</header>'));
  const foot = noLang.slice(noLang.indexOf('<footer class="ftr">'), noLang.indexOf('</footer>'));
  const text = (s) => s.replace(/<svg[\s\S]*?<\/svg>/g, '').split(/<[^>]*>/).map((x) => decode(x).trim()).filter(Boolean);
  // the theme and animation buttons are labelled by site.js from the dictionary on every page, so their static label is not compared
  const aria = (s) => [...s.replace(/<button id="(?:motion|theme)-btn"[^>]*>/g, '').matchAll(/\saria-label="([^"]*)"/g)].map((x) => decode(x[1]));
  return { headText: text(head), footText: text(foot), headAria: aria(head), footAria: aria(foot) };
}
for (const l of LANGS) {
  const got = parts(render(l.code));
  const want = parts(read((l.dir ? l.dir + '/' : '') + 'index.html'));
  for (const k of Object.keys(want)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) {
      const i = got[k].findIndex((x, j) => x !== want[k][j]);
      fail(`404 in ${l.code}: ${k} differs from ${l.dir || '.'}${l.dir ? '/' : ''}index.html at item ${i}: "${got[k][i]}" vs "${want[k][i]}" (${got[k].length} vs ${want[k].length} items)`);
    }
  }
}
// the labels that site.js writes into the generated language menu come from the dictionary and say what the generator's block says
for (const l of LANGS) {
  const d = dictOf(l.code), sum = /<summary aria-label="([^"]*)" title="([^"]*)"/.exec(langBlock(l, 'index'));
  if (d['nf.lang'] !== sum[2]) fail(`assets/i18n/${l.code}.js: nf.lang "${d['nf.lang']}" differs from the language menu title "${sum[2]}"`);
  if ((d['nf.lang.cur'] || '').replace('{lang}', l.native) !== sum[1]) fail(`assets/i18n/${l.code}.js: nf.lang.cur gives "${(d['nf.lang.cur'] || '').replace('{lang}', l.native)}", the language menu says "${sum[1]}"`);
}
if (!siteJs.includes("$$('[data-i18n-aria]')") || !siteJs.includes("t('nf.lang.cur'")) fail('assets/site.js: the 404 block does not translate the data-i18n-aria attributes and the language menu labels');
// every marker used on the page has a key in every dictionary
const used = new Set([...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((x) => x[1]));
for (const l of LANGS) { const d = dictOf(l.code); for (const k of used) if (typeof d[k] !== 'string' || !d[k]) fail(`assets/i18n/${l.code}.js: key ${k} (used by 404.html) is missing or empty`); }
// nothing visible is left without a marker (it would stay English on a translated 404), except the brand name and the number
{
  const body = html.slice(html.indexOf('<a class="skip"'), html.indexOf('<!-- hl:scripts-begin'))
    .replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<!-- hl:lang-begin[\s\S]*?<!-- hl:lang-end -->/, '');
  const unmarked = body.replace(/<(\w+)[^>]*\sdata-i18n="[^"]+"[^>]*>[\s\S]*?<\/\1>/g, '');
  for (const x of unmarked.split(/<[^>]*>/).map((s) => decode(s).trim()).filter(Boolean)) if (x !== 'Hey Look!' && x !== '404') fail(`404.html: the visible text "${x}" has no data-i18n marker, it would stay English on a translated 404`);
  for (const m of body.matchAll(/<[^>]*\saria-label="([^"]*)"[^>]*>/g)) if (!/data-i18n-aria=/.test(m[0]) && !/id="(motion|theme)-btn"/.test(m[0])) fail(`404.html: aria-label "${m[1]}" has no data-i18n-aria marker`);
}

// ---------- 4. no language guessing, no redirect ----------
const scripts = fs.readdirSync(path.join(DOCS, 'assets')).filter((f) => f.endsWith('.js')).map((f) => 'assets/' + f);
const pages = [];
const walk = (dir) => { for (const e of fs.readdirSync(path.join(DOCS, dir), { withFileTypes: true })) { const p = path.posix.join(dir, e.name); if (e.isDirectory() && e.name !== 'assets' && e.name !== 'media') walk(p); else if (e.name.endsWith('.html')) pages.push(p); } };
walk('.');
for (const f of [...scripts, ...pages]) {
  const t = read(f);
  const body = f.endsWith('.js') ? t : (t.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || []).join('\n') + '\n' + (t.match(/<meta[^>]+http-equiv="refresh"[^>]*>/gi) || []).join('\n');
  for (const [re, what] of [[/navigator\.languages?\b/, 'reads the browser language'], [/\blocation\.(replace|assign)\s*\(/, 'redirects'], [/\b(window\.)?location(\.href)?\s*=[^=]/, 'sets location'], [/http-equiv="refresh"/i, 'meta refresh']]) {
    if (re.test(body)) fail(`${f}: ${what} (the site never switches language or page by itself)`);
  }
}

if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
console.log(`ok - test-site-404 (${dirs.length} language folders, base + language detection, translated title/text/header/footer in ${LANGS.length} languages, no redirect or navigator.language)`);
