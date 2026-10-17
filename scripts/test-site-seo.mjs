#!/usr/bin/env node
// Search-engine and social-preview checks of the website in docs/ (no browser, no dependencies). Run:  node scripts/test-site-seo.mjs
// For all 72 pages (9 pages x 8 languages) and 404.html: title and description length, canonical, hreflang (complete and reciprocal), Open Graph,
// Twitter card, exactly one <h1> and a heading order without gaps, JSON-LD that parses and says only what the page shows, images with alt and
// size, external links with rel=noopener, lang attribute = folder, no noindex except on 404.html. Site-wide: robots.txt, sitemap.xml, the
// preview picture and icons (their pixel size and weight), the Search Console file.
//
// Lengths are measured in display width, because a search result is cut by pixels, not characters: a letter counts 1, a CJK character
// (Chinese, Japanese) counts 2. Title <= 60, description 120..160. The title ends with the brand ("Features - Hey Look!").
import fs from 'node:fs';
import path from 'node:path';
import { LANGS, PAGES, DOCS, SITE, urlOf, fileOf } from './generate-site-languages.mjs';
import { decode, pageMeta, pageName, versionOf, LOCALE, OG_ALT, OG_IMAGE_PATH, OG_SIZE, SCREENSHOT_PATH, REPO } from './lib/site-seo.mjs';

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const read = (f) => fs.readFileSync(f, 'utf8');
const EN = LANGS[0];
const width = (s) => [...s].reduce((a, c) => a + (/[⺀-鿿＀-￯　-〿]/.test(c) ? 2 : 1), 0);
const stripComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
const noScripts = (t) => stripComments(t).replace(/<script[\s\S]*?<\/script>/g, '');
const metas = (t) => { // every <meta> of the head as [attrName, attrValue, content]
  const head = t.slice(0, t.indexOf('</head>')), out = [];
  for (const m of head.matchAll(/<meta\s+(name|property)="([^"]+)"\s+content="([^"]*)"(?:\s+media="[^"]*")?>/g)) out.push([m[1], m[2], decode(m[3])]);
  return out;
};
const one = (ms, key) => { const x = ms.filter((m) => m[1] === key); return x.length === 1 ? x[0][2] : x.length ? `(${x.length} times)` : undefined; };
const all = (ms, key) => ms.filter((m) => m[1] === key).map((m) => m[2]);

function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const mk = buf[i + 1];
    if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
const pngSize = (buf) => buf.slice(1, 4).toString() === 'PNG' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;

const enIndex = read(fileOf(EN, 'index'));
const version = versionOf(enIndex);
if (!version || !/^\d+\.\d+\.\d+/.test(version)) fail('index.html', `<span data-version> is "${version}", expected a version number`);

// ---------- the preview picture and the icons ----------
{
  const og = path.join(DOCS, OG_IMAGE_PATH);
  if (!fs.existsSync(og)) fail(OG_IMAGE_PATH, 'missing (node scripts/make-site-images.mjs)');
  else {
    const buf = fs.readFileSync(og), s = jpegSize(buf);
    if (!s || s.w !== OG_SIZE.width || s.h !== OG_SIZE.height) fail(OG_IMAGE_PATH, `is ${s && s.w}x${s && s.h}, expected ${OG_SIZE.width}x${OG_SIZE.height} (a JPEG)`);
    if (buf.length > 200 * 1024) fail(OG_IMAGE_PATH, `${buf.length} bytes, expected < 200 KB`);
  }
  for (const [f, px] of [['assets/apple-touch-icon.png', 180], ['assets/icon-48.png', 48]]) {
    const p = path.join(DOCS, f);
    if (!fs.existsSync(p)) { fail(f, 'missing (node scripts/make-site-images.mjs)'); continue; }
    const s = pngSize(fs.readFileSync(p));
    if (!s || s.w !== px || s.h !== px) fail(f, `is ${s && s.w}x${s && s.h}, expected ${px}x${px} (a PNG)`);
  }
  if (!fs.existsSync(path.join(DOCS, 'assets/favicon.svg'))) fail('assets/favicon.svg', 'missing');
  if (!fs.existsSync(path.join(DOCS, SCREENSHOT_PATH))) fail(SCREENSHOT_PATH, 'missing (the JSON-LD screenshot)');
}

// ---------- the pages ----------
const urlSet = new Set(LANGS.flatMap((l) => PAGES.map((p) => urlOf(l, p))));
const alternatesOf = (t) => new Map([...t.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"/g)].map((x) => [x[1], x[2]]));
const titles = new Map(), descs = new Map(); // per language: no two pages share a title or a description
let pageCount = 0;

function checkPage(lang, page, file) {
  const where = path.relative(DOCS, file).replace(/\\/g, '/');
  const text = read(file), ms = metas(text);
  pageCount++;
  const is404 = page === '404';
  if (!/^<!doctype html>/i.test(text)) fail(where, 'no <!doctype html>');
  const m = /<html lang="([^"]*)"/.exec(text);
  if (!m || m[1] !== lang.hreflang) fail(where, `<html lang> is "${m && m[1]}", expected "${lang.hreflang}"`);
  if (!/<meta charset="utf-8">/i.test(text)) fail(where, 'no <meta charset="utf-8">');
  if (one(ms, 'viewport') !== 'width=device-width, initial-scale=1') fail(where, `viewport meta is ${one(ms, 'viewport')}`);
  if (!all(ms, 'theme-color').length) fail(where, 'no theme-color meta');

  // title and description
  let title, description;
  try { ({ title, description } = pageMeta(text)); } catch (e) { fail(where, e.message); return; }
  if (!is404) {
    if (width(title) > 60) fail(where, `title is ${width(title)} wide, expected <= 60: "${title}"`);
    if (!/Hey Look!$/.test(title) || /^Hey Look!/.test(title)) fail(where, `title must end with the brand: "${title}"`);
    if (pageName(title).length < 2) fail(where, `title has no page name before the brand: "${title}"`);
    if (width(description) < 120 || width(description) > 160) fail(where, `description is ${width(description)} wide, expected 120..160: "${description}"`);
    const tk = lang.code + '|' + title, dk = lang.code + '|' + description;
    if (titles.has(tk)) fail(where, `same title as ${titles.get(tk)}`); else titles.set(tk, where);
    if (descs.has(dk)) fail(where, `same description as ${descs.get(dk)}`); else descs.set(dk, where);
    if (/\s{2,}|^\s|\s$/.test(description) || /\s{2,}|^\s|\s$/.test(title)) fail(where, 'title or description has stray spaces');
  }
  if (/<title>/.test(text.replace(/<title>[^<]*<\/title>/, '')) ) fail(where, 'more than one <title>');
  if (all(ms, 'description').length !== 1) fail(where, 'there must be exactly one meta description');

  // robots meta
  const robots = one(ms, 'robots');
  if (is404) { if (!/noindex/.test(robots || '')) fail(where, 'the 404 page must be noindex'); }
  else if (!robots || /noindex|nofollow|none/.test(robots)) fail(where, `robots meta is "${robots}": an indexable page must not say noindex/nofollow`);

  // headings: exactly one h1, no gaps in the order (h2 -> h4 is a gap), the first is the h1
  const levels = [...noScripts(text).matchAll(/<h([1-6])\b/g)].map((x) => +x[1]);
  if (levels.filter((x) => x === 1).length !== 1) fail(where, `${levels.filter((x) => x === 1).length} <h1> elements, expected exactly 1`);
  if (levels[0] !== 1) fail(where, `the first heading is h${levels[0]}, expected h1`);
  levels.forEach((h, i) => { if (i && h > levels[i - 1] + 1) fail(where, `heading order jumps from h${levels[i - 1]} to h${h} (heading #${i + 1})`); });

  // images: alt, width and height; links: external ones with rel=noopener
  for (const tag of noScripts(text).matchAll(/<img\b[^>]*>/g)) {
    for (const a of ['alt', 'width', 'height']) if (!new RegExp(`\\s${a}="[^"]+"`).test(tag[0])) fail(where, `<img> without ${a}: ${tag[0].slice(0, 80)}`);
  }
  for (const tag of noScripts(text).matchAll(/<a\b[^>]*>/g)) {
    const h = /\shref="([^"]*)"/.exec(tag[0]);
    if (h && /^https?:\/\//.test(h[1]) && !/\srel="[^"]*\bnoopener\b/.test(tag[0])) fail(where, `external link without rel="noopener": ${h[1]}`);
  }
  if (is404) return;

  // canonical and hreflang: complete, and every target lists this page back
  const canon = [...text.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map((x) => x[1]);
  if (canon.length !== 1 || canon[0] !== urlOf(lang, page)) fail(where, `canonical is ${JSON.stringify(canon)}, expected ${urlOf(lang, page)}`);
  const alt = alternatesOf(text);
  for (const l of LANGS) if (alt.get(l.hreflang) !== urlOf(l, page)) fail(where, `hreflang ${l.hreflang} is ${alt.get(l.hreflang)}, expected ${urlOf(l, page)}`);
  if (alt.get('x-default') !== urlOf(EN, page)) fail(where, 'hreflang x-default is not the English page');
  if (alt.size !== LANGS.length + 1) fail(where, `${alt.size} hreflang links, expected ${LANGS.length + 1}`);
  for (const l of LANGS) {
    const back = alternatesOf(read(fileOf(l, page)));
    if (back.get(lang.hreflang) !== urlOf(lang, page)) fail(where, `${l.dir || 'en'}/${page} does not link back to this page (hreflang ${lang.hreflang})`);
  }

  // Open Graph and Twitter
  const want = {
    'og:type': 'website', 'og:site_name': 'Hey Look!', 'og:title': title, 'og:description': description, 'og:url': urlOf(lang, page), 'og:locale': LOCALE[lang.code],
    'og:image': SITE + OG_IMAGE_PATH, 'og:image:type': 'image/jpeg', 'og:image:width': String(OG_SIZE.width), 'og:image:height': String(OG_SIZE.height), 'og:image:alt': OG_ALT[lang.code],
    'twitter:card': 'summary_large_image', 'twitter:title': title, 'twitter:description': description, 'twitter:image': SITE + OG_IMAGE_PATH, 'twitter:image:alt': OG_ALT[lang.code],
  };
  for (const [k, v] of Object.entries(want)) { const got = one(ms, k); if (got !== v) fail(where, `${k} is ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`); }
  const loc = all(ms, 'og:locale:alternate').sort(), wantLoc = LANGS.filter((l) => l !== lang).map((l) => LOCALE[l.code]).sort();
  if (JSON.stringify(loc) !== JSON.stringify(wantLoc)) fail(where, `og:locale:alternate is ${loc}, expected ${wantLoc}`);
  if (!OG_ALT[lang.code] || width(OG_ALT[lang.code]) < 20) fail(where, 'og:image:alt is missing or too short');

  // icons
  if (!/<link rel="icon" href="(?:\.\.\/)?assets\/favicon\.svg" type="image\/svg\+xml">/.test(text)) fail(where, 'no SVG favicon');
  if (!/<link rel="icon" href="(?:\.\.\/)?assets\/icon-48\.png" sizes="48x48" type="image\/png">/.test(text)) fail(where, 'no 48x48 PNG favicon');
  if (!/<link rel="apple-touch-icon" href="(?:\.\.\/)?assets\/apple-touch-icon\.png">/.test(text)) fail(where, 'no apple-touch-icon');

  // JSON-LD
  const blocks = [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  if (blocks.length !== 1) { fail(where, `${blocks.length} JSON-LD blocks, expected 1`); return; }
  let doc;
  try { doc = JSON.parse(blocks[0]); } catch (e) { fail(where, 'JSON-LD does not parse: ' + e.message); return; }
  if (doc['@context'] !== 'https://schema.org') fail(where, 'JSON-LD @context is not https://schema.org');
  const nodes = doc['@graph'] || [doc];
  const byType = (t) => nodes.filter((n) => n['@type'] === t);
  if (/aggregateRating|"review"|ratingValue|ratingCount|reviewCount/.test(blocks[0])) fail(where, 'JSON-LD has a rating or a review: the site shows none');
  for (const n of nodes) for (const [k, v] of Object.entries(n)) {
    // every URL in it is an address of this site, of the repository, or of schema.org
    const urls = JSON.stringify(v).match(/https?:\/\/[^"]+/g) || [];
    for (const u of urls) if (!u.startsWith(SITE) && !u.startsWith('https://github.com/thnonl') && u !== 'https://schema.org') fail(where, `JSON-LD ${n['@type']}.${k} has a foreign URL ${u}`);
  }
  const wantTypes = page === 'index' ? ['WebSite', 'SoftwareApplication'] : page === 'download' ? ['SoftwareApplication', 'BreadcrumbList'] : ['BreadcrumbList'];
  if (JSON.stringify(nodes.map((n) => n['@type'])) !== JSON.stringify(wantTypes)) fail(where, `JSON-LD types are ${nodes.map((n) => n['@type'])}, expected ${wantTypes}`);
  for (const [site] of byType('WebSite').map((n) => [n])) {
    if (site.name !== 'Hey Look!' || site.url !== urlOf(lang, 'index') || site.inLanguage !== lang.hreflang) fail(where, 'JSON-LD WebSite name, url or inLanguage is wrong');
  }
  for (const app of byType('SoftwareApplication')) {
    const req = ['name', 'description', 'url', 'applicationCategory', 'operatingSystem', 'softwareVersion', 'offers', 'downloadUrl', 'license', 'inLanguage', 'image'];
    for (const k of req) if (app[k] == null || app[k] === '') fail(where, `JSON-LD SoftwareApplication has no ${k}`);
    if (app.name !== 'Hey Look!') fail(where, 'JSON-LD SoftwareApplication name is not Hey Look!');
    if (app.description !== description) fail(where, 'JSON-LD SoftwareApplication description differs from the page description');
    if (app.url !== urlOf(lang, page)) fail(where, 'JSON-LD SoftwareApplication url is not this page');
    if (app.applicationCategory !== 'CommunicationApplication') fail(where, `applicationCategory is ${app.applicationCategory}`);
    for (const os of ['Windows', 'macOS', 'Linux']) if (!String(app.operatingSystem).includes(os)) fail(where, `operatingSystem lacks ${os}`);
    if (app.softwareVersion !== version) fail(where, `softwareVersion ${app.softwareVersion} differs from the version the home page shows (${version})`);
    if (!app.offers || app.offers['@type'] !== 'Offer' || app.offers.price !== '0' || !app.offers.priceCurrency) fail(where, 'offers must be a free Offer (price "0")');
    if (app.downloadUrl !== REPO + '/releases/latest') fail(where, 'downloadUrl is not the latest release');
    if (app.license !== REPO + '/blob/main/LICENSE') fail(where, 'license is not the repository LICENSE');
    if (JSON.stringify(app.inLanguage) !== JSON.stringify(LANGS.map((l) => l.hreflang))) fail(where, 'inLanguage is not the language list of the site');
    if (app.image !== SITE + OG_IMAGE_PATH) fail(where, 'image is not the preview picture');
    if (page === 'index' ? app.screenshot !== SITE + SCREENSHOT_PATH : app.screenshot !== undefined) fail(where, 'screenshot belongs on the home page only (the poster is shown there)');
  }
  for (const bc of byType('BreadcrumbList')) {
    const it = bc.itemListElement || [];
    if (it.length !== 2 || it[0].position !== 1 || it[1].position !== 2) fail(where, 'BreadcrumbList must have 2 items, positions 1 and 2');
    else {
      if (it[0].item !== urlOf(lang, 'index') || it[0].name !== 'Hey Look!') fail(where, 'BreadcrumbList item 1 is not the home page of this language');
      if (it[1].item !== urlOf(lang, page) || it[1].name !== pageName(title)) fail(where, 'BreadcrumbList item 2 is not this page (name = the title without the brand)');
    }
  }
}

for (const lang of LANGS) for (const page of PAGES) checkPage(lang, page, fileOf(lang, page));
checkPage(EN, '404', path.join(DOCS, '404.html'));

// ---------- robots.txt ----------
{
  const f = path.join(DOCS, 'robots.txt');
  if (!fs.existsSync(f)) fail('robots.txt', 'missing');
  else {
    const lines = read(f).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.includes('User-agent: *')) fail('robots.txt', 'no "User-agent: *"');
    if (!lines.includes('Allow: /')) fail('robots.txt', 'no "Allow: /"');
    for (const l of lines) if (/^Disallow:\s*\S/i.test(l)) fail('robots.txt', `"${l}": nothing may be blocked (the assets are needed to render the pages)`);
    const sm = lines.filter((l) => /^Sitemap:/i.test(l));
    if (sm.length !== 1 || sm[0] !== `Sitemap: ${SITE}sitemap.xml`) fail('robots.txt', `Sitemap line is ${JSON.stringify(sm)}, expected "Sitemap: ${SITE}sitemap.xml"`);
  }
}

// ---------- sitemap.xml ----------
{
  const f = path.join(DOCS, 'sitemap.xml');
  const xml = fs.existsSync(f) ? read(f) : '';
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const missing = [...urlSet].filter((u) => !locs.includes(u)), extra = locs.filter((u) => !urlSet.has(u));
  if (missing.length) fail('sitemap.xml', 'missing URLs: ' + missing.join(', '));
  if (extra.length) fail('sitemap.xml', 'URLs that are not generated pages (404.html and the verification file must stay out): ' + extra.join(', '));
  if (locs.length !== LANGS.length * PAGES.length) fail('sitemap.xml', `${locs.length} URLs, expected ${LANGS.length * PAGES.length}`);
  for (const e of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const lm = (/<lastmod>([^<]+)<\/lastmod>/.exec(e[1]) || [])[1];
    if (!lm || !/^\d{4}-\d{2}-\d{2}$/.test(lm) || Number.isNaN(Date.parse(lm))) fail('sitemap.xml', `bad <lastmod> "${lm}"`);
    else if (lm > new Date(Date.now() + 36e5 * 14).toISOString().slice(0, 10)) fail('sitemap.xml', `<lastmod> ${lm} is in the future`);
  }
  if (/<priority>|<changefreq>/.test(xml)) fail('sitemap.xml', '<priority> / <changefreq> are not used (search engines ignore them)');
}

// ---------- the Search Console file, no manifest to forget ----------
if (!fs.existsSync(path.join(DOCS, 'googlef426f30257016548.html'))) fail('googlef426f30257016548.html', 'Search Console verification file missing');
if (/rel="manifest"/.test(read(fileOf(EN, 'index')))) fail('index.html', 'a web manifest is linked but the CSP (default-src none) would block it: add manifest-src or drop it');

if (errors.length) {
  console.error(`site seo: ${errors.length} problem(s)`);
  for (const e of errors.slice(0, 80)) console.error('  ' + e);
  if (errors.length > 80) console.error(`  ... and ${errors.length - 80} more`);
  process.exit(1);
}
console.log(`site seo ok: ${pageCount} pages (${LANGS.length} languages x ${PAGES.length} + 404), titles <= 60, descriptions 120..160, JSON-LD parsed, robots.txt and sitemap checked`);
