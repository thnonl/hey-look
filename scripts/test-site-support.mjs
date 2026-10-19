// The Support page of the website (docs/support.html and the seven translated ones; no browser, no dependencies). Run:
//   node --experimental-strip-types scripts/test-site-support.mjs
//
// The bank transfer QR is gone from the site (W10.17, owner decision 2026-10-19), and the page is one Ko-fi action plus four ways to help
// that cost nothing. This test keeps it so, in 8 languages:
//   - nothing under docs/ (pages, style sheet, scripts) mentions the QR images, their card, the Vietnamese QR paragraph, VietQR or the bank, and the two image files are gone;
//   - every support page has exactly one link to Ko-fi (the button), the widget button, box and note, the four cards with their targets, no image and no `role="group"`;
//   - the heading of the coffee card is the app's own "Buy me a coffee" label of that language (Settings > About), so the app's link and the page say the same;
//   - the privacy page does not talk about a QR image any more (the sentence itself is in REMOVED of test-site-statements.mjs, row W10.19).
import fs from "node:fs";
import path from "node:path";
import { loadDicts } from "./lib/i18n-dicts.mjs";
import { LANGS, DOCS } from "./generate-site-languages.mjs";
import { plain } from "./test-site-statements.mjs";

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const dicts = await loadDicts();

// 1. the files of docs/ (text only) say nothing about the QR or a bank transfer; the images do not exist
const FORBIDDEN = /donate-qr|bank-card|vi-line|VietQR|Techcombank/i;
let scanned = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(html|css|js|xml|txt|json|webmanifest)$/i.test(e.name)) {
      scanned++;
      const m = FORBIDDEN.exec(fs.readFileSync(p, "utf8"));
      if (m) fail(path.relative(DOCS, p).replace(/\\/g, "/"), `mentions "${m[0]}"`);
    }
  }
};
walk(DOCS);
for (const f of ["assets/donate-qr.jpg", "assets/donate-qr-card.jpg"]) if (fs.existsSync(path.join(DOCS, f))) fail(`docs/${f}`, "the QR image is still there");

// 2. each support page
const CARDS = [
  ["star", "https://github.com/thnonl/hey-look"],
  ["report", "help.html#bug"],
  ["translate", "https://github.com/thnonl/hey-look/issues"],
  ["share", "index.html"],
];
const decode = (s) => plain(s);
let pages = 0;
for (const l of LANGS) {
  const where = `${l.dir ? l.dir + "/" : ""}support.html`;
  const html = fs.readFileSync(path.join(DOCS, l.dir, "support.html"), "utf8");
  pages++;

  // one Ko-fi link: the button; the widget button, box and note
  const kofi = html.match(/<a\b[^>]*href="https:\/\/ko-fi\.com[^"]*"[^>]*>/g) ?? [];
  if (kofi.length !== 1) fail(where, `${kofi.length} links to ko-fi.com, expected exactly one (the button)`);
  else {
    const a = kofi[0];
    if (!/\bid="kofi-link"/.test(a)) fail(where, "the Ko-fi link has no id kofi-link");
    if (!/href="https:\/\/ko-fi\.com\/namthnonl"/.test(a)) fail(where, "the Ko-fi link does not go to https://ko-fi.com/namthnonl");
    if (!/\btarget="_blank"/.test(a)) fail(where, "the Ko-fi link does not open in a new tab (its text says it does)");
    if (!/\brel="[^"]*\bnoopener\b/.test(a)) fail(where, "the Ko-fi link has no rel=noopener");
  }
  for (const id of ["support", "kofi-h", "kofi-load", "kofi-box", "kofi-note", "more-h", "letter-h"]) {
    if (!new RegExp(`\\bid="${id}"`).test(html)) fail(where, `no element with id ${id}`);
  }
  if (!/<button\b[^>]*\bid="kofi-load"[^>]*\bhidden\b/.test(html)) fail(where, "the widget button must be hidden until the script shows it (no script, no button)");
  if (!/<section\b[^>]*\bid="kofi-box"[^>]*\bhidden\b/.test(html)) fail(where, "the widget box must be empty and hidden until the button is pressed");
  if (!/class="support-top"/.test(html)) fail(where, "no .support-top wrapper");
  if (/role="group"/.test(html)) fail(where, 'a role="group" is back (the old "two ways" group)');
  if (/<img\b/.test(html)) fail(where, "an image on the Support page (the QR is gone, nothing replaces it)");
  if (/<figure\b/.test(html)) fail(where, "a figure on the Support page");

  // the coffee card is named like the app's link
  const heading = /<h2 id="kofi-h">([^<]*)<\/h2>/.exec(html)?.[1];
  const app = dicts[l.hreflang]?.["settings.about.coffee"];
  if (typeof app !== "string") fail(where, `the app dictionary of ${l.hreflang} has no settings.about.coffee`);
  else if (decode(heading ?? "") !== app) fail(where, `the coffee card says "${heading}", the app's Buy me a coffee says "${app}"`);

  // the four cards, in order, with their targets
  const list = /<ul class="more-ways">([\s\S]*?)<\/ul>/.exec(html)?.[1];
  if (!list) fail(where, "no ul.more-ways");
  else {
    const items = [...list.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)];
    if (items.length !== CARDS.length) fail(where, `${items.length} cards in more-ways, expected ${CARDS.length}`);
    items.forEach((m, i) => {
      const want = CARDS[i];
      if (!want) return;
      if (!new RegExp(`\\bid="${want[0]}"`).test(m[1])) fail(where, `card ${i + 1} should have id ${want[0]}`);
      const links = [...m[2].matchAll(/<a\b([^>]*)>/g)].map((x) => x[1]);
      if (links.length !== 1) fail(where, `card ${want[0]} has ${links.length} links, expected one`);
      else {
        const href = /href="([^"]*)"/.exec(links[0])?.[1];
        if (href !== want[1]) fail(where, `card ${want[0]} links to ${href}, expected ${want[1]}`);
        if (/^https:/.test(want[1]) && !/rel="[^"]*\bnoopener\b/.test(links[0])) fail(where, `card ${want[0]}: an external link without rel=noopener`);
      }
      if (!/<h3>[^<]+<\/h3>/.test(m[2])) fail(where, `card ${want[0]} has no h3`);
      if (!/<svg class="ic" aria-hidden="true"/.test(m[2])) fail(where, `card ${want[0]}: the icon is not hidden from assistive technology`);
    });
  }
  if ((html.match(/<h3>/g) ?? []).length < CARDS.length) fail(where, "fewer than four h3 headings");
  const heads = [...html.matchAll(/<h([1-4])\b/g)].map((m) => +m[1]);
  heads.forEach((h, i) => { if (i && h > heads[i - 1] + 1) fail(where, `heading levels jump from h${heads[i - 1]} to h${h}`); });

  // the privacy page has no sentence about a QR image
  const priv = path.join(DOCS, l.dir, "privacy.html");
  if (/\bQR\b|二维码|QRコード/.test(plain(fs.readFileSync(priv, "utf8")))) fail(`${l.dir ? l.dir + "/" : ""}privacy.html`, "talks about a QR image");
}

if (errors.length) { console.error(errors.map((e) => "FAIL " + e).join("\n")); process.exit(1); }
console.log(`ok - test-site-support (${pages} support pages in ${LANGS.length} languages, ${scanned} site files scanned, no QR, one Ko-fi action, ${CARDS.length} cards)`);
