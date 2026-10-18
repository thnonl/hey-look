#!/usr/bin/env node
// Checks the multi-language website in docs/ (no dependencies). Run:  node scripts/test-site-languages.mjs [--strict]
// Without --strict, stub pages (English text copies) pass. With --strict, a page or dictionary that is still the English text
// (or still carries the STUB note) fails: use it when you claim a language is finished.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { LANGS, PAGES, DOCS, STUB, urlOf, fileOf, headBlock, langBlock, scriptsBlock, seoBlock } from './generate-site-languages.mjs';
import { versionOf } from './lib/site-seo.mjs';

const strict = process.argv.includes('--strict');
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const EN = LANGS[0];
const read = (f) => fs.readFileSync(f, 'utf8');
const relDocs = (f) => path.relative(DOCS, f).replace(/\\/g, '/');

// ---------- small html helpers (regex based; the pages are plain, hand-written html) ----------
const BLOCKS = ['head', 'seo', 'lang', 'scripts'];
const stripBlocks = (t) => BLOCKS.reduce((s, n) => s.replace(new RegExp(`<!-- hl:${n}-begin[^>]*-->[\\s\\S]*?<!-- hl:${n}-end -->`), ''), t);
const stripComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
const body = (t) => stripComments(stripBlocks(t));
const ids = (t) => [...body(t).replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const attrs = (t, tag, attr) => [...body(t).matchAll(new RegExp(`<${tag}\\b[^>]*?\\s${attr}="([^"]*)"`, 'g'))].map((m) => m[1]);
const headings = (t) => { const o = {}; for (const m of body(t).matchAll(/<h([1-6])\b/g)) o[m[1]] = (o[m[1]] || 0) + 1; return JSON.stringify(o); };
// executable inline scripts only: a JSON-LD block (type="application/ld+json") is data, the browser never runs it and the CSP does not apply to it
const inlineScripts = (t) => [...stripComments(t).matchAll(/<script\b(?![^>]*\ssrc=)(?![^>]*\stype="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const csp = (t) => (/http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(t) || [])[1];
const external = (h) => /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//');
const sameSet = (a, b) => { const A = new Set(a), B = new Set(b); return [[...A].filter((x) => !B.has(x)), [...B].filter((x) => !A.has(x))]; };
const sameMulti = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// a link target as a docs-relative path plus fragment; null for outside links
function target(file, href) {
  if (external(href)) return null;
  const [p, hash = ''] = href.split('#'); const q = p.split('?')[0];
  let abs = q ? path.resolve(path.dirname(file), q) : file;
  if (q.endsWith('/') || (fs.existsSync(abs) && fs.statSync(abs).isDirectory())) abs = path.join(abs, 'index.html');
  return { abs, hash, rel: relDocs(abs) };
}

// ---------- dictionaries ----------
function loadDict(code) {
  const f = path.join(DOCS, 'assets/i18n', code + '.js');
  if (!fs.existsSync(f)) { fail(relDocs(f), 'dictionary missing'); return null; }
  const sandbox = { window: {} };
  try { vm.runInNewContext(read(f), sandbox, { filename: f }); } catch (e) { fail(relDocs(f), 'does not run: ' + e.message); return null; }
  const d = sandbox.window.HL_I18N && sandbox.window.HL_I18N[code];
  if (!d || typeof d !== 'object') { fail(relDocs(f), `does not define HL_I18N['${code}']`); return null; }
  return d;
}
const PLURAL = /\.(zero|one|two|few|many|other)$/;
const baseKey = (k) => k.replace(PLURAL, '');
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const enDict = loadDict('en');

for (const lang of LANGS.slice(1)) {
  const d = loadDict(lang.code);
  if (!d || !enDict) continue;
  const where = `assets/i18n/${lang.code}.js`;
  const [miss, extra] = sameSet(Object.keys(enDict).map(baseKey), Object.keys(d).map(baseKey));
  if (miss.length) fail(where, 'missing keys: ' + miss.join(', '));
  if (extra.length) fail(where, 'unknown keys: ' + extra.join(', '));
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'string') { fail(where, `value of "${k}" is not a string`); continue; }
    const en = enDict[k] !== undefined ? enDict[k] : enDict[baseKey(k) + '.other'];
    if (en === undefined) continue;
    const a = ph(en), b = ph(v);
    if (PLURAL.test(k) && enDict[k] === undefined) { if (b.some((x) => !a.includes(x))) fail(where, `"${k}" uses a placeholder the English text does not: ${b}`); }
    else if (a.join() !== b.join()) fail(where, `"${k}" placeholders ${JSON.stringify(b)} differ from English ${JSON.stringify(a)}`);
    if (k !== 'locale' && (v.match(/\*\*/g) || []).length !== (en.match(/\*\*/g) || []).length) fail(where, `"${k}": the ** markers differ from English`);
  }
  for (const k of Object.keys(d)) if (PLURAL.test(k) && !(baseKey(k) + '.other' in d)) fail(where, `"${baseKey(k)}" has no .other form`);
  if (typeof d.locale !== 'string' || !d.locale) fail(where, 'locale must be a language tag');
  else { try { new Intl.Locale(d.locale); } catch { fail(where, `locale "${d.locale}" is not a valid language tag`); } }
  if (strict) {
    if (/STUB:/.test(read(path.join(DOCS, where)))) fail(where, 'still carries the STUB note');
    const same = Object.keys(d).filter((k) => k !== 'locale' && d[k] === enDict[k]).length;
    if (same === Object.keys(d).length - 1) fail(where, 'every value is still the English text');
  }
}

// ---------- the header switches: one whole sentence per case, never a state word and a target word joined by a template ----------
// site.js writes t('theme.label.' + state) and t('motion.label.' + state + '.' + next). Every language has all 3 + 6 sentences, none with a
// placeholder (a noun put into a sentence cannot agree in gender / case), and no sentence is shared by two cases.
{
  const THEME = ['auto', 'light', 'dark'].map((k) => 'theme.label.' + k);
  const MOTION = ['auto.off', 'auto.on', 'off.on', 'off.auto', 'on.auto', 'on.off'].map((k) => 'motion.label.' + k);
  const siteJs = read(path.join(DOCS, 'assets/site.js'));
  if (!siteJs.includes("t('theme.label.' + pref)") || !siteJs.includes("t('motion.label.' + mpref + '.' + next)")) fail('assets/site.js', 'the switches must write one whole sentence per case (theme.label.<state>, motion.label.<state>.<next>)');
  for (const old of ['theme.label', 'motion.label', 'motion.next.auto']) if (new RegExp(`['"]${old.replace('.', '\.')}['"]`).test(siteJs)) fail('assets/site.js', `still uses the template key "${old}"`);
  for (const lang of LANGS) {
    const d = loadDict(lang.code);
    if (!d) continue;
    const where = `assets/i18n/${lang.code}.js`;
    for (const k of ['theme.label', 'motion.label', 'motion.next.auto']) if (k in d) fail(where, `"${k}" is the old template key (a state word and a target word in one sentence)`);
    for (const group of [THEME, MOTION]) {
      const seen = new Map();
      for (const k of group) {
        if (typeof d[k] !== 'string' || !d[k].trim()) { fail(where, `"${k}" is missing`); continue; }
        if (/[{}]/.test(d[k])) fail(where, `"${k}" has a placeholder: it must be a whole sentence`);
        if (seen.has(d[k])) fail(where, `"${k}" is the same sentence as "${seen.get(d[k])}"`);
        seen.set(d[k], k);
      }
    }
  }
}

// ---------- pages ----------
const enText = {};
for (const page of [...PAGES, '404']) {
  const f = fileOf(EN, page);
  if (!fs.existsSync(f)) { fail(relDocs(f), 'English page missing'); continue; }
  enText[page] = read(f);
}
const enTargets = (page) => attrs(enText[page], 'a', 'href').map((h) => target(fileOf(EN, page), h)).filter(Boolean);
const LOGIC_ATTRS = ['data-go', 'data-scene', 'data-act', 'data-rsvp', 'data-hold', 'data-asset', 'data-tog', 'data-for'];
let stubPages = 0, pageCount = 0;

function checkCommon(lang, page, file, text) {
  const where = relDocs(file);
  pageCount++;
  // language plumbing: exactly what the generator writes
  if (page !== '404' && !text.includes(headBlock(lang, page))) fail(where, 'canonical/hreflang block is missing or out of date (run scripts/generate-site-languages.mjs)');
  if (page !== '404' && !text.includes(seoBlock(lang, page, text, versionOf(enText.index)))) fail(where, 'Open Graph / Twitter / JSON-LD block is missing or out of date (run scripts/generate-site-languages.mjs)');
  if (!text.includes(langBlock(lang, page))) fail(where, 'language menu block is missing or out of date');
  if (!text.includes(scriptsBlock(lang, page))) fail(where, 'script block is missing or out of date');
  const m = /<html lang="([^"]*)"/.exec(text);
  if (!m || m[1] !== lang.hreflang) fail(where, `<html lang> is "${m && m[1]}", expected "${lang.hreflang}"`);
  if (page !== '404') {
    const canon = [...text.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map((x) => x[1]);
    if (canon.length !== 1 || canon[0] !== urlOf(lang, page)) fail(where, `canonical is ${JSON.stringify(canon)}, expected ${urlOf(lang, page)}`);
    const alt = new Map([...text.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    for (const l of LANGS) if (alt.get(l.hreflang) !== urlOf(l, page)) fail(where, `hreflang ${l.hreflang} is ${alt.get(l.hreflang)}, expected ${urlOf(l, page)}`);
    if (alt.get('x-default') !== urlOf(EN, page)) fail(where, 'hreflang x-default is not the English page');
    if (alt.size !== LANGS.length + 1) fail(where, `${alt.size} hreflang links, expected ${LANGS.length + 1}`);
  }
  const menu = [...stripComments(text).matchAll(/<li><a href="([^"]*)" hreflang="([^"]*)"[^>]*?( aria-current="true")?>/g)];
  if (menu.length !== LANGS.length || menu.filter((x) => x[3]).length !== 1) fail(where, 'the language menu must list every language once, one marked current');
  // no new inline scripts, same CSP as the English page, no inline style or event handlers
  const en = enText[page];
  if (inlineScripts(text).length !== inlineScripts(en).length) fail(where, 'inline <script> count differs from the English page (the CSP allows none, except the hashed one in 404.html)');
  if (csp(text) !== csp(en)) fail(where, 'Content-Security-Policy differs from the English page');
  if (/\sstyle="/.test(stripComments(text)) !== /\sstyle="/.test(stripComments(en))) fail(where, 'inline style attribute added');
  if (/\son[a-z]+="/i.test(stripComments(text))) fail(where, 'inline event handler attribute');
  // ids, headings, link targets, logic keys
  const idsL = ids(text), idsE = ids(en);
  const [miss, extra] = sameSet(idsE, idsL);
  if (miss.length) fail(where, 'ids missing (anchors must stay English): ' + miss.join(', '));
  if (extra.length) fail(where, 'ids not in the English page: ' + extra.join(', '));
  if (new Set(idsL).size !== idsL.length) fail(where, 'duplicate ids');
  if (headings(text) !== headings(en)) fail(where, `heading levels ${headings(text)} differ from English ${headings(en)}`);
  const want = enTargets(page).map((t) => {
    const isPage = /\.html$/.test(t.rel) && [...PAGES, '404'].includes(path.basename(t.rel, '.html')) && !t.rel.includes('/');
    return (isPage && lang.dir ? lang.dir + '/' : '') + t.rel + '#' + t.hash;
  });
  const got = attrs(text, 'a', 'href').map((h) => target(file, h)).filter(Boolean).map((t) => t.rel + '#' + t.hash);
  const [lm, le] = sameSet(want, got);
  if (lm.length) fail(where, 'link targets missing: ' + lm.join(', '));
  if (le.length) fail(where, 'link targets not in the English page: ' + le.join(', '));
  for (const a of LOGIC_ATTRS) if (!sameMulti(attrs(en, '[a-z]+', a), attrs(text, '[a-z]+', a))) fail(where, `${a} values differ from English (they are keys for the scripts, do not translate)`);
  if (page === 'index') {
    const cmds = (t) => { const m = /data-cmds='([^']*)'/.exec(t); try { return JSON.parse(m[1]).length; } catch { return -1; } };
    if (cmds(text) !== cmds(en)) fail(where, `data-cmds has ${cmds(text)} commands, English has ${cmds(en)} (the order is fixed: story.js reads positions)`);
    for (const a of ['data-snz', 'data-when']) if (attrs(en, '[a-z]+', a).length !== attrs(text, '[a-z]+', a).length) fail(where, `${a} count differs from English`);
    if (!attrs(text, '[a-z]+', 'data-snz').includes('custom')) fail(where, 'data-snz="custom" is a key for story.js and must stay');
  }
  // relative references resolve, in-page fragments exist
  const noInline = stripComments(text).replace(/<script\b(?![^>]*\ssrc=)[\s\S]*?<\/script>/g, '');
  for (const m of noInline.matchAll(/\s(?:href|src|poster)="([^"]*)"/g)) {
    const h = m[1]; if (!h || external(h) || h.startsWith('data:')) continue;
    const t = target(file, h);
    if (!fs.existsSync(t.abs)) { fail(where, `${h} does not resolve (${t.rel})`); continue; }
    if (t.hash && /\.html$/.test(t.abs)) {
      const have = new Set([...stripComments(read(t.abs)).replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]));
      if (!have.has(t.hash)) fail(where, `${h}: no id "${t.hash}" in ${t.rel}`);
    }
  }
  return stripComments(stripBlocks(text)).replace(/\.\.\/(assets|media)\//g, '$1/').replace(/\s+/g, ' ').trim();
}

for (const page of [...PAGES, '404']) {
  if (!enText[page]) continue;
  checkCommon(EN, page, fileOf(EN, page), enText[page]);
}

const enBody = {};
for (const page of PAGES) enBody[page] = enText[page] && stripComments(stripBlocks(enText[page])).replace(/\s+/g, ' ').trim();
for (const lang of LANGS.slice(1)) {
  for (const page of PAGES) {
    const file = fileOf(lang, page);
    if (!fs.existsSync(file)) { fail(relDocs(file), 'page missing'); continue; }
    const text = read(file);
    const mine = checkCommon(lang, page, file, text);
    const isStub = text.trimStart().startsWith(STUB) || mine === enBody[page];
    if (isStub) stubPages++;
    if (strict && isStub) fail(relDocs(file), 'still the English text (STUB note present or body identical to English)');
    if (strict) {
      const title = (t) => (/<title>([^<]*)<\/title>/.exec(t) || [])[1], desc = (t) => (/name="description" content="([^"]*)"/.exec(t) || [])[1];
      if (!isStub && title(text) === title(enText[page])) fail(relDocs(file), 'title is still the English title');
      if (!isStub && desc(text) === desc(enText[page])) fail(relDocs(file), 'meta description is still the English text');
    }
  }
  if (fs.existsSync(path.join(DOCS, lang.dir, '404.html'))) fail(`${lang.dir}/404.html`, 'there is one 404.html, at the root (GitHub Pages serves no other); it reads the language from the address');
}

// ---------- the anchors the app and the README link to, in every language ----------
const APP_ANCHORS = [['help', 'google-review'], ['help', 'push'], ['help', 'lim'], ['index', 'film']];
for (const lang of LANGS) for (const [page, id] of APP_ANCHORS) {
  const f = fileOf(lang, page);
  if (fs.existsSync(f) && !ids(read(f)).includes(id)) fail(relDocs(f), `#${id} is missing (the app links to ${page}.html#${id})`);
}

// ---------- 404.html: language neutral ----------
if (enText['404']) {
  const t = enText['404'], hashes = [...(csp(t) || '').matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
  for (const s of inlineScripts(t)) {
    const h = crypto.createHash('sha256').update(s, 'utf8').digest('base64');
    if (!hashes.includes(h)) fail('404.html', 'the inline <base> script does not match a hash in the CSP');
  }
  if (!/data-i18n="nf\.h1a"/.test(t)) fail('404.html', 'data-i18n markers are missing');
  if (enDict) for (const k of [...t.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]).concat('nf.title', 'nf.desc')) if (!(k in enDict)) fail('404.html', `en.js has no key ${k}`);
}

// ---------- sitemap ----------
{
  const f = path.join(DOCS, 'sitemap.xml');
  const xml = fs.existsSync(f) ? read(f) : '';
  if (!xml) fail('sitemap.xml', 'missing');
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const locs = entries.map((e) => (/<loc>([^<]+)<\/loc>/.exec(e) || [])[1]);
  const want = LANGS.flatMap((l) => PAGES.map((p) => urlOf(l, p)));
  const [lm, le] = sameSet(want, locs);
  if (lm.length) fail('sitemap.xml', 'missing URLs: ' + lm.join(', '));
  if (le.length) fail('sitemap.xml', 'unknown URLs: ' + le.join(', '));
  if (new Set(locs).size !== locs.length) fail('sitemap.xml', 'duplicate <loc>');
  for (const e of entries) {
    const loc = (/<loc>([^<]+)<\/loc>/.exec(e) || [])[1];
    const page = PAGES.find((p) => LANGS.some((l) => urlOf(l, p) === loc));
    if (!page) continue;
    const alt = new Map([...e.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map((m) => [m[1], m[2]]));
    for (const l of LANGS) if (alt.get(l.hreflang) !== urlOf(l, page)) fail('sitemap.xml', `${loc}: alternate ${l.hreflang} is ${alt.get(l.hreflang)}`);
    if (alt.get('x-default') !== urlOf(EN, page)) fail('sitemap.xml', `${loc}: alternate x-default is wrong`);
    if (!/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(e)) fail('sitemap.xml', `${loc}: no <lastmod>`);
  }
}

// ---------- the Search Console file stays as it is ----------
{
  const f = path.join(DOCS, 'googlef426f30257016548.html');
  if (!fs.existsSync(f) || read(f).trim() !== 'google-site-verification: googlef426f30257016548.html') fail('googlef426f30257016548.html', 'Search Console verification file missing or changed');
}

// ---------- result ----------
if (errors.length) {
  console.error(`site languages: ${errors.length} problem(s)${strict ? ' (strict)' : ''}`);
  for (const e of errors.slice(0, 80)) console.error('  ' + e);
  if (errors.length > 80) console.error(`  ... and ${errors.length - 80} more`);
  process.exit(1);
}
console.log(`site languages ok: ${LANGS.length} languages, ${pageCount} pages checked, sitemap ${LANGS.length * PAGES.length} URLs; ${stubPages} language pages still English text (stubs)${strict ? '' : ', allowed without --strict'}`);
