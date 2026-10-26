#!/usr/bin/env node
// Turns the Microsoft Store listing texts (one md file per language) and the listing images into a Partner Center IMPORT folder: one .csv + an images/
// folder (Partner Center: "Import listings" > "Import folder"). No dependencies, Node 22+.
//
//   make the folder   node scripts/store-listing-csv.mjs --md <md folder> --images <screens folder> --out <import folder> --template <Partner Center export.csv>
//                       [--logos <folder>[,<folder>]: store-poster-720x1080.png, store-box-1080x1080.png, store-tile-300x300.png (msix-assets.mjs --only store) and
//                          store-hero-1920x1080.png, store-tile-150x150.png, store-tile-71x71.png (--only listing)]
//                       [--root-name <name>] [--bom auto|yes|no] [--release-notes <json>] [--no-license-terms] [--no-hardware]
//                       [--dev-studio "Noamo, thnonl"] [--short-title "Hey Look!"] [--locales en,vi,...]
//   check a folder    node scripts/store-listing-csv.mjs --check <import folder> [--template <export.csv>] [--root-name <name>] [--locales ...]
//   rename the root   node scripts/store-listing-csv.mjs --rebase <import folder>     (the image paths name the folder: use after a copy or rename)
//   no export yet     --no-template instead of --template writes a BEST-GUESS template (the field list of a real export) and marks the result
//                     "NOT PROVEN: replace by an export from Partner Center" (a note on the console and a file <out>.NOT-PROVEN.txt next to the folder)
//
// Inputs: <md folder>/<lang>.md with the sections "## Short description", "## Description", "## Product features" (one per line), "## Search terms"
// (one per line), "## Copyright and trademark info", "## Developed by", "## Applicable license terms", "## Additional system requirements",
// "## What's new in this version", "## Screenshot captions" (S1..S8), and optional "## Short title"; a trailing "(203 characters)" line of a section is a note and dropped.
// <screens folder>/<locale column>/S1.png ... S8.png (scripts/store-screenshots.mjs makes them), logos from scripts/msix-assets.mjs --only store.
//
// The TEMPLATE is the owner's export from Partner Center. Its Field / ID / Type columns, its header and EVERY row (also the empty ones) are copied
// unchanged; only the cells of the language columns that this script owns are filled (Description, ShortDescription, ReleaseNotes (empty: first
// submission), ShortTitle, DevStudio, CopyrightTrademarkInformation, AdditionalLicenseTerms (the MIT text), Feature1..20, SearchTerm1..7, MinimumHardwareReq1..11 (the md's
// "Additional system requirements"), DesktopScreenshot1..30 + captions and, when logos are given, the six image rows StoreLogo720x1080 / 1080x1080 / 300x300, StoreLogoOverride150x150 /
// 71x71, PromoImage1920x1080 with OverrideLogosForWin10 = True). Title, VoiceTitle, SortTitle and every other row stay as the export has them. The `default`
// column stays empty: Microsoft says a blank language cell falls back to it, but nobody has shown that for images, so every language column is filled itself.
//
// It FAILS LOUD (exit 1, nothing written) on: a Field that is not in the table below, an ID or Type that differs from the table, a language column that has
// no md file / an md file of no known language, a missing section, a missing Description or screenshot, a value over its limit, a missing or wrong image
// (PNG header and end, size, ratio), a placeholder like {version} left in a text.
//
// FILE FORMAT (what is written, and why):
//   Encoding  UTF-8. BOM: `--bom auto` (default) = like the template (the real export has one; without a template: yes). Microsoft says only "UTF-8"; an
//             answer in the Microsoft Q&A (2022) says an import failed until the BOM was removed, while the export itself carries one. Not proven either
//             way: if the import is refused without a clear reason, make the folder again with the other --bom value.
//   Rows      end with the template's line break (the real export: CRLF); a line break inside a cell (the Description) is LF, inside quotes. A cell is
//             quoted only when it holds a comma, a quote or a line break (RFC 4180, like the export). The last row has no line break, like the export.
//   Images    cell = <root folder name>/images/<language column>/S1.png (Microsoft: "enter the full path, including the root folder name"), so the
//             folder must keep the name it was made with (--root-name, default the name of --out); --rebase fixes the paths after a rename.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- the languages
/** md file name (without .md) -> the language column of the Partner Center export, and the app's language code (= the screenshot language). */
export const LOCALES = [
  { md: "en", col: "en-us", app: "en" },
  { md: "vi", col: "vi", app: "vi" },
  { md: "fr", col: "fr", app: "fr" },
  { md: "zh-Hans", col: "zh-hans", app: "zh-Hans" },
  { md: "es", col: "es", app: "es" },
  { md: "ja", col: "ja", app: "ja" },
  { md: "de", col: "de", app: "de" },
  { md: "ru", col: "ru", app: "ru" },
];
export const LOCALE_COLS = LOCALES.map((l) => l.col);

// ---------------------------------------------------------------- the field table (a Partner Center export of 2026-10)
const TEXT = "Text";
const PATH = "Relative path (or URL to file in Partner Center)";
const BOOL = "True/False";

/** Every row of the export, in its order: [{ name, id, type }]. The script fails on a Field of a template that is not here, or whose ID / Type differs. */
export function fieldTable() {
  const t = [];
  const add = (name, id, type) => t.push({ name, id: String(id), type });
  const series = (prefix, from, to, id0, type) => { for (let n = from; n <= to; n++) add(`${prefix}${n}`, id0 + n - from, type); };
  add("Description", 2, TEXT); add("ReleaseNotes", 3, TEXT); add("Title", 4, TEXT); add("ShortTitle", 5, TEXT); add("SortTitle", 6, TEXT);
  add("VoiceTitle", 7, TEXT); add("ShortDescription", 8, TEXT); add("DevStudio", 9, TEXT); add("CopyrightTrademarkInformation", 12, TEXT);
  add("AdditionalLicenseTerms", 13, TEXT);
  series("DesktopScreenshot", 1, 30, 100, PATH); series("DesktopScreenshotCaption", 1, 30, 150, TEXT);
  series("MobileScreenshot", 1, 30, 200, PATH); series("MobileScreenshotCaption", 1, 30, 250, TEXT);
  series("XboxScreenshot", 1, 30, 300, PATH); series("XboxScreenshotCaption", 1, 30, 350, TEXT);
  series("HolographicScreenshot", 1, 30, 400, PATH); series("HolographicScreenshotCaption", 1, 30, 450, TEXT);
  series("SurfaceHubScreenshot", 11, 30, 510, PATH); series("SurfaceHubScreenshotCaption", 11, 30, 560, TEXT);
  add("StoreLogo720x1080", 600, PATH); add("StoreLogo1080x1080", 601, PATH); add("StoreLogo300x300", 602, PATH); add("OverrideLogosForWin10", 603, BOOL);
  add("StoreLogoOverride150x150", 604, PATH); add("StoreLogoOverride71x71", 605, PATH); add("PromoImage1920x1080", 606, PATH); add("PromoImage2400x1200", 607, PATH);
  add("XboxBrandedKeyArt584x800", 608, PATH); add("XboxTitledHero1920x1080", 609, PATH); add("XboxFeaturedPromo1080x1080", 610, PATH);
  add("OptionalPromo358x358", 611, PATH); add("OptionalPromo1000x800", 612, PATH); add("OptionalPromo414x180", 613, PATH);
  series("Feature", 1, 20, 700, TEXT); series("MinimumHardwareReq", 1, 11, 800, TEXT); series("RecommendedHardwareReq", 1, 11, 850, TEXT);
  series("SearchTerm", 1, 7, 900, TEXT);
  add("TrailerToPlayAtTopOfListing", 999, PATH); series("Trailer", 1, 15, 1000, PATH); series("TrailerTitle", 1, 15, 1020, TEXT);
  series("TrailerThumbnail", 1, 15, 1040, PATH); series("TrailerClosedCaption", 1, 15, 1055, PATH); series("TrailerAudioDescription", 1, 15, 1070, PATH);
  return t;
}
const TABLE = fieldTable();
const BY_NAME = new Map(TABLE.map((f) => [f.name, f]));

export const LOGO_ROWS = [
  { field: "StoreLogo720x1080", file: "store-poster-720x1080.png", w: 720, h: 1080, maxBytes: 50e6, what: "poster 2:3" },
  { field: "StoreLogo1080x1080", file: "store-box-1080x1080.png", w: 1080, h: 1080, maxBytes: 50e6, what: "box art 1:1" },
  { field: "StoreLogo300x300", file: "store-tile-300x300.png", w: 300, h: 300, maxBytes: 5e6, what: "app tile 1:1" },
  { field: "StoreLogoOverride150x150", file: "store-tile-150x150.png", w: 150, h: 150, maxBytes: 5e6, what: "small tile 1:1" },
  { field: "StoreLogoOverride71x71", file: "store-tile-71x71.png", w: 71, h: 71, maxBytes: 5e6, what: "small tile 1:1" },
  { field: "PromoImage1920x1080", file: "store-hero-1920x1080.png", w: 1920, h: 1080, maxBytes: 50e6, what: "hero art 16:9" },
];
/** The row that must be True when the two small tiles are given (the export's "OverrideLogosForWin10"). */
const OVERRIDE_ROW = "OverrideLogosForWin10";
export const DEFAULT_DEV_STUDIO = "Noamo, thnonl";
export const DEFAULT_SHORT_TITLE = "Hey Look!";
export const SHOT_MAX = 30; // DesktopScreenshot1..30
const SHOT = { minW: 1366, minH: 768, maxW: 3840, maxH: 2160, maxBytes: 50e6 };

/** The fields a text must not span lines in. */
const MULTILINE = new Set(["Description", "ReleaseNotes", "AdditionalLicenseTerms"]);

/** Limits in UTF-16 units (the stricter way to count). `warn`: above it the text is accepted but reported. */
export function limitOf(name) {
  if (name === "Description") return { max: 10000 };
  if (name === "ShortDescription") return { max: 1000, warn: 270 }; // Microsoft: "keep under 270, limit 1000"
  if (name === "ReleaseNotes") return { max: 1500 };
  if (name === "DevStudio") return { max: 255 };
  if (name === "ShortTitle") return { max: 50 };
  if (name === "CopyrightTrademarkInformation") return { max: 200 };
  if (name === "AdditionalLicenseTerms") return { max: 10000 }; // not documented for the MSIX form: assumed like Description
  if (/^Feature\d+$/.test(name)) return { max: 200 };
  if (/^SearchTerm\d+$/.test(name)) return { max: 40 }; // the owner's form: 40 characters each, 7 terms, 21 words in all
  if (/^DesktopScreenshotCaption\d+$/.test(name)) return { max: 200 };
  if (/^(Minimum|Recommended)HardwareReq\d+$/.test(name)) return { max: 200 };
  return null;
}
const countOf = (re, n) => ({ max: n, re });
export const COUNT_LIMITS = [countOf(/^Feature\d+$/, 20), countOf(/^SearchTerm\d+$/, 7), countOf(/^DesktopScreenshot\d+$/, SHOT_MAX)];
export const SEARCH_WORDS_MAX = 21;

// ---------------------------------------------------------------- CSV
/** RFC 4180 reader: quoted cells with commas, quotes ("") and line breaks. Returns { rows, eol, finalEol } (eol: the first row break, CRLF or LF). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false, i = 0, eol = null, finalEol = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === "") { q = true; i++; continue; }
    if (c === ",") { row.push(cell); cell = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      const br = c === "\r" && text[i + 1] === "\n" ? "\r\n" : c;
      if (eol === null) eol = br;
      row.push(cell); rows.push(row); row = []; cell = ""; i += br.length;
      if (i >= n) finalEol = true;
      continue;
    }
    cell += c; i++;
  }
  if (q) throw new Error("the CSV ends inside a quoted cell");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return { rows, eol: eol ?? "\r\n", finalEol };
}

/** The reverse: a cell is quoted only when it has a comma, a quote or a line break. */
export function serializeCsv(rows, eol = "\r\n", finalEol = false) {
  const cell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(",")).join(eol) + (finalEol ? eol : "");
}

export const encodeCsv = (text, bom) => Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);

/** Reads a CSV file: { header, rows (data rows), bom, eol, finalEol }; throws on a file that is not UTF-8 or has no Partner Center header. */
export function readCsvFile(file) {
  const buf = fs.readFileSync(file);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? buf.subarray(3) : buf); } catch { throw new Error(`${file}: not valid UTF-8`); }
  const { rows, eol, finalEol } = parseCsv(text);
  if (!rows.length) throw new Error(`${file}: empty`);
  const header = rows[0];
  if (header[0] !== "Field" || header[1] !== "ID" || !/^Type\b/.test(header[2] ?? "") || header[3] !== "default") {
    throw new Error(`${file}: the header must start with Field, ID, Type, default (found: ${header.slice(0, 4).join(", ")})`);
  }
  return { header, rows: rows.slice(1), bom, eol, finalEol };
}

// ---------------------------------------------------------------- PNG
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** { w, h, size, complete } of a PNG file, or null when it is not one. `complete`: ends with the IEND chunk (a cut file is not). */
export function pngFileInfo(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), size: buf.length, complete: buf.subarray(buf.length - 8, buf.length - 4).toString("ascii") === "IEND" };
}

/** Problems of one image file for a role: "shot" (screenshot) or a LOGO_ROWS entry. */
export function imageProblems(file, role) {
  const bad = [];
  if (!fs.existsSync(file)) return [`image file is missing: ${file}`];
  const info = pngFileInfo(file);
  if (!info) return [`${file}: not a PNG (Partner Center takes .png only)`];
  if (!info.complete) bad.push(`${file}: the PNG is cut off (no IEND chunk)`);
  if (role === "shot") {
    if (info.w < SHOT.minW || info.h < SHOT.minH || info.w > SHOT.maxW || info.h > SHOT.maxH) bad.push(`${file}: ${info.w}x${info.h}, a screenshot is ${SHOT.minW}x${SHOT.minH} up to ${SHOT.maxW}x${SHOT.maxH}`);
    if (Math.abs(info.w * 9 - info.h * 16) > 16) bad.push(`${file}: ${info.w}x${info.h} is not 16:9`);
    if (info.size >= SHOT.maxBytes) bad.push(`${file}: ${info.size} bytes, a screenshot must be under 50 MB`);
  } else {
    if (info.w !== role.w || info.h !== role.h) bad.push(`${file}: ${info.w}x${info.h}, ${role.field} (${role.what}) is exactly ${role.w}x${role.h}`);
    if (info.size >= role.maxBytes) bad.push(`${file}: ${info.size} bytes, over the limit of ${role.maxBytes / 1e6} MB`);
  }
  return bad;
}

// ---------------------------------------------------------------- the md files
const SECTION_NAMES = ["Short description", "Description", "Product features", "Search terms", "Copyright and trademark info", "Applicable license terms", "Additional system requirements", "What's new in this version", "Screenshot captions"];
/** A note line of the BA: "(203 characters)", "(2114 ký tự)", "(8 unique words)", "(225 characters; limit 270)", "Characters: 250", "Символов: 228". */
const NOTE_LINE = /^(?:\(\s*\d[^()]*\)|\p{L}[\p{L} ]{0,24}:\s*\d[\d.,]*)$/u;

/** The sections of an md file: { "Short description": "text", ... } (every "## " heading; body trimmed, LF). */
export function splitSections(md) {
  const out = {};
  const lines = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let name = null, buf = [];
  const flush = () => { if (name !== null && !(name in out)) out[name] = buf.join("\n").trim(); };
  for (const line of lines) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) { flush(); name = m[1]; buf = []; } else buf.push(line);
  }
  flush();
  return out;
}

/** Text of a section without the count note on its last line. */
function textOf(section) {
  const lines = section.split(/\n/);
  while (lines.length && (lines[lines.length - 1].trim() === "" || NOTE_LINE.test(lines[lines.length - 1].trim()))) lines.pop();
  return lines.join(String.fromCharCode(10)).trim();
}
const linesOf = (section) => section.split("\n").map((l) => l.trim()).filter((l) => l && !NOTE_LINE.test(l));

/** The fields of one md file: { values: { FieldName: text }, shots: n of captions, errors: [] }. */
export function parseListingMd(md, label, { release = "", shortTitle, devStudio } = {}) {
  const errors = [], warnings = [];
  const sec = splitSections(md);
  for (const s of SECTION_NAMES) if (!(s in sec)) errors.push(`${label}: the section "## ${s}" is missing`);
  const v = {};
  if (errors.length) return { values: v, errors, warnings };
  v.ShortDescription = textOf(sec["Short description"]);
  v.Description = textOf(sec["Description"]);
  linesOf(sec["Product features"]).forEach((l, i) => { v[`Feature${i + 1}`] = l; });
  linesOf(sec["Search terms"]).forEach((l, i) => { v[`SearchTerm${i + 1}`] = l; });
  v.CopyrightTrademarkInformation = textOf(sec["Copyright and trademark info"]);
  // owner decision 2026-10-26: Developed by = "Noamo, thnonl", ShortTitle = "Hey Look!" in every language. Order: an explicit option (--dev-studio, --short-title) > the md
  // ("## Developed by", the optional "## Short title") > the built-in default; an md that says something else than the option is reported.
  const pick = (what, opt, fromMd, dflt) => {
    if (opt !== undefined && fromMd && fromMd !== opt) warnings.push(`${label}: "${what}" says "${fromMd.slice(0, 60)}", the option wins: "${opt}"`);
    return opt ?? (fromMd || dflt);
  };
  v.DevStudio = pick("Developed by", devStudio, textOf(sec["Developed by"] ?? ""), DEFAULT_DEV_STUDIO);
  v.ShortTitle = pick("Short title", shortTitle, textOf(sec["Short title"] ?? ""), DEFAULT_SHORT_TITLE);
  v.AdditionalLicenseTerms = textOf(sec["Applicable license terms"]);
  linesOf(sec["Additional system requirements"]).forEach((l, i) => { v[`MinimumHardwareReq${i + 1}`] = l; });
  v.ReleaseNotes = release; // the md only says "leave EMPTY" for the first submission and gives a template for later ones
  for (const line of linesOf(sec["Screenshot captions"])) {
    // "S1: text" | "S1 text" | "S1 (what is shown, Light): text"
    const m = /^S(\d{1,2})(?:\s*\([^)]*\))?\s*[:：]?\s*(\S.*)$/.exec(line);
    if (!m) { errors.push(`${label}: caption line not understood: ${line.slice(0, 60)}`); continue; }
    const n = Number(m[1]);
    if (v[`DesktopScreenshotCaption${n}`] !== undefined) errors.push(`${label}: caption S${n} twice`);
    v[`DesktopScreenshotCaption${n}`] = m[2].trim();
  }
  return { values: v, errors, warnings };
}

// ---------------------------------------------------------------- the checks of the values of one language
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f﻿�]/;
const PLACEHOLDER = /\{[A-Za-z][^{}\n]*\}/;

/**
 * { errors, warnings } for the values of one language column: `v` = { FieldName: text } (empty values may be missing), `opts.skip` = field names that are
 * not written (their limits are not applied). Used for the md texts before writing and for the cells of a folder (--check).
 */
export function validateValues(label, v, opts = {}) {
  const errors = [], warnings = [];
  const skip = opts.skip ?? new Set();
  const get = (k) => v[k] ?? "";
  if (!get("Description").trim()) errors.push(`${label}: Description is required and empty`);
  const names = Object.keys(v).filter((k) => get(k) !== "" && !skip.has(k));
  for (const name of names) {
    const val = get(name);
    const lim = limitOf(name);
    if (lim && val.length > lim.max) errors.push(`${label}: ${name} is ${val.length} characters, the limit is ${lim.max}`);
    else if (lim?.warn && val.length > lim.warn) warnings.push(`${label}: ${name} is ${val.length} characters, Microsoft advises at most ${lim.warn} (the limit is ${lim.max})`);
    if (CONTROL.test(val)) errors.push(`${label}: ${name} has a control character, a BOM or a replacement character`);
    if (!MULTILINE.has(name) && /[\r\n]/.test(val)) errors.push(`${label}: ${name} must be one line`);
    if (val !== val.trim()) warnings.push(`${label}: ${name} starts or ends with a space or line break`);
    if (PLACEHOLDER.test(val) && name === "ReleaseNotes") errors.push(`${label}: ReleaseNotes still has a placeholder ${PLACEHOLDER.exec(val)[0]}`);
    if (/^(Description|ShortDescription|Feature\d+)$/.test(name) && (/https?:\/\/|www\./i.test(val) || /<\/?[a-z][^>]*>/i.test(val))) warnings.push(`${label}: ${name} has a URL or HTML; Microsoft: no HTML, code or URLs in these fields`);
  }
  for (const { max, re } of COUNT_LIMITS) {
    const present = Object.keys(v).filter((k) => re.test(k) && get(k) !== "");
    if (present.length > max) errors.push(`${label}: ${present.length} values for ${re.source}, at most ${max}`);
    const nums = present.map((k) => Number(/\d+$/.exec(k)[0])).sort((a, b) => a - b);
    if (nums.some((n, i) => n !== i + 1)) warnings.push(`${label}: the numbering of ${re.source} has a gap (${nums.join(",")})`);
  }
  const terms = Object.keys(v).filter((k) => /^SearchTerm\d+$/.test(k) && get(k) !== "").map(get);
  const words = terms.reduce((s, t) => s + t.split(/\s+/).filter(Boolean).length, 0);
  if (words > SEARCH_WORDS_MAX) errors.push(`${label}: the search terms have ${words} words, at most ${SEARCH_WORDS_MAX}`);
  if (new Set(terms.map((t) => t.toLowerCase())).size !== terms.length) warnings.push(`${label}: a search term appears twice`);
  const shots = Object.keys(v).filter((k) => /^DesktopScreenshot\d+$/.test(k) && get(k) !== "").map((k) => Number(/\d+$/.exec(k)[0]));
  const caps = Object.keys(v).filter((k) => /^DesktopScreenshotCaption\d+$/.test(k) && get(k) !== "").map((k) => Number(/\d+$/.exec(k)[0]));
  if (opts.needShots !== false && !shots.length) errors.push(`${label}: no screenshot (Microsoft: at least one is required)`);
  for (const c of caps) if (opts.needShots !== false && !shots.includes(c)) errors.push(`${label}: caption ${c} has no DesktopScreenshot${c}`);
  for (const s of shots) if (!caps.includes(s)) warnings.push(`${label}: DesktopScreenshot${s} has no caption`);
  return { errors, warnings };
}

// ---------------------------------------------------------------- the template
/** Checks the rows of a template against the table: no unknown Field, same ID and Type. Returns the list of problems. */
export function templateProblems(tpl, source = "template") {
  const bad = [];
  const seen = new Set();
  tpl.rows.forEach((r, i) => {
    if (r.every((c) => c === "")) return; // the empty rows at the end of the export
    const f = BY_NAME.get(r[0]);
    if (!f) { bad.push(`${source}: row ${i + 2}: unknown Field "${r[0]}" (add it to fieldTable() after reading what Partner Center means by it)`); return; }
    if (seen.has(r[0])) bad.push(`${source}: row ${i + 2}: Field "${r[0]}" twice`);
    seen.add(r[0]);
    if (r[1] !== f.id) bad.push(`${source}: ${r[0]}: ID is "${r[1]}", the table has "${f.id}"`);
    if (r[2] !== f.type) bad.push(`${source}: ${r[0]}: Type is "${r[2]}", the table has "${f.type}"`);
    if (r.length !== tpl.header.length) bad.push(`${source}: row ${i + 2} has ${r.length} cells, the header ${tpl.header.length}`);
  });
  return bad;
}

/** A best-guess template: the field list of the 2026-10 export, empty language columns, Title empty. NOT PROVEN until compared with a real export. */
export function bestGuessTemplate() {
  const header = ["Field", "ID", "Type (Type)", "default", ...LOCALE_COLS];
  const rows = TABLE.map((f) => [f.name, f.id, f.type, "", ...LOCALE_COLS.map(() => (f.name === "OverrideLogosForWin10" ? "False" : ""))]);
  return { header, rows, bom: true, eol: "\r\n", finalEol: false };
}

// ---------------------------------------------------------------- make
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) { a._.push(t); continue; }
    const k = t.slice(2);
    if (["no-template", "no-license-terms", "no-hardware", "strict"].includes(k)) a[k] = true;
    else { a[k] = argv[++i]; if (a[k] === undefined) throw new Error(`--${k} needs a value`); }
  }
  return a;
}

const sl = (...p) => p.join("/");

/** Everything `make` needs from the md files of the wanted languages: { byCol: { col: values }, errors, warnings }. */
export function readAllMd(mdDir, locales, { release = {}, licenseTerms = true, hardware = true, devStudio, shortTitle } = {}) {
  const errors = [], warnings = [];
  const byCol = {};
  let names = [];
  try { names = fs.readdirSync(mdDir); } catch { errors.push(`md folder not found: ${mdDir}`); return { byCol, errors, warnings }; }
  for (const f of names) {
    const m = /^([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)\.md$/.exec(f);
    if (m && !LOCALES.some((l) => l.md === m[1])) errors.push(`unknown locale: ${f} (known: ${LOCALES.map((l) => l.md).join(", ")})`);
  }
  for (const loc of locales) {
    const file = path.join(mdDir, `${loc.md}.md`);
    if (!fs.existsSync(file)) { errors.push(`${file}: missing (language ${loc.col})`); continue; }
    const { values, errors: e, warnings: w } = parseListingMd(fs.readFileSync(file, "utf8"), `${loc.md}.md`, { release: release[loc.md] ?? release[loc.col] ?? "", devStudio, shortTitle });
    errors.push(...e); warnings.push(...w);
    byCol[loc.col] = values;
  }
  for (const [col, values] of Object.entries(byCol)) {
    if (!licenseTerms) delete values.AdditionalLicenseTerms;
    if (!hardware) for (const k of Object.keys(values)) if (/^MinimumHardwareReq/.test(k)) delete values[k];
    const r = validateValues(`${col}`, values, { needShots: false });
    errors.push(...r.errors); warnings.push(...r.warnings);
  }
  return { byCol, errors, warnings };
}

/**
 * Makes the import folder. Returns { csv, files, warnings }; throws an Error whose message lists every problem (nothing is written then).
 * opts: { mdDir, imagesDir, logosDir?, out, templateFile? (else best guess), rootName?, bom: "auto"|"yes"|"no", release?, licenseTerms?, hardware?, locales? }
 */
export function makeImportFolder(opts) {
  const errors = [], warnings = [];
  const locales = (opts.locales ? LOCALES.filter((l) => opts.locales.includes(l.col) || opts.locales.includes(l.md)) : LOCALES);
  if (!locales.length) throw new Error("no known language selected");
  const outDir = path.resolve(opts.out);
  const rootName = opts.rootName ?? path.basename(outDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rootName)) errors.push(`root folder name "${rootName}": letters, digits, . _ - only (it is part of every image path)`);

  const tpl = opts.templateFile ? readCsvFile(opts.templateFile) : bestGuessTemplate();
  const bestGuess = !opts.templateFile;
  errors.push(...templateProblems(tpl, opts.templateFile ? path.basename(opts.templateFile) : "best-guess template"));
  const colIndex = new Map();
  tpl.header.slice(4).forEach((h, i) => colIndex.set(h, 4 + i));
  const knownCols = new Set(LOCALE_COLS);
  for (const h of colIndex.keys()) if (!knownCols.has(h)) warnings.push(`template column "${h}" is not one of the 8 languages: left unchanged`);
  for (const l of locales) if (!colIndex.has(l.col)) errors.push(`the template has no column "${l.col}" (it has: ${[...colIndex.keys()].join(", ")}); add the language in Partner Center first`);

  const licenseTerms = opts.licenseTerms !== false, hardware = opts.hardware !== false;
  const md = readAllMd(opts.mdDir, locales, { release: opts.release, licenseTerms, hardware, devStudio: opts.devStudio, shortTitle: opts.shortTitle });
  errors.push(...md.errors); warnings.push(...md.warnings);

  // images: screenshots S1..Sn per language (n = the captions), logos once
  const imageSrc = {}; // `${col}` -> [{ field, src, rel }]
  const logoSrc = [];
  for (const l of locales) {
    const vals = md.byCol[l.col];
    if (!vals) continue;
    const caps = Object.keys(vals).filter((k) => /^DesktopScreenshotCaption\d+$/.test(k)).map((k) => Number(/\d+$/.exec(k)[0])).sort((a, b) => a - b);
    if (caps.some((n, i) => n !== i + 1)) errors.push(`${l.md}.md: the captions are not S1..S${caps.length} without a gap`);
    if (!caps.length) errors.push(`${l.md}.md: no screenshot caption`);
    imageSrc[l.col] = [];
    for (const n of caps) {
      const src = path.join(opts.imagesDir, l.col, `S${n}.png`);
      errors.push(...imageProblems(src, "shot"));
      imageSrc[l.col].push({ field: `DesktopScreenshot${n}`, src, rel: sl("images", l.col, `S${n}.png`) });
    }
  }
  if (opts.logosDir) {
    // one folder or several (a list): the poster, box art and tile of the package build (msix-assets.mjs --only store), the hero and the small tiles (--only listing)
    const dirs = (Array.isArray(opts.logosDir) ? opts.logosDir : String(opts.logosDir).split(",")).map((d) => d.trim()).filter(Boolean);
    for (const role of LOGO_ROWS) {
      const cands = dirs.flatMap((d) => [path.join(d, role.file), path.join(d, "store", role.file)]);
      const src = cands.find((c) => fs.existsSync(c));
      if (!src) { errors.push(`logo file ${role.file} not found in ${dirs.join(", ")} (node scripts/msix-assets.mjs --only store|listing --out <folder>)`); continue; }
      errors.push(...imageProblems(src, role));
      logoSrc.push({ field: role.field, src, rel: sl("images", "store", role.file) });
    }
  } else warnings.push("no --logos: the StoreLogo rows stay as the template has them");

  // the rows
  const owned = new Set(["Description", "ShortDescription", "ReleaseNotes", "DevStudio", "CopyrightTrademarkInformation"]);
  for (let n = 1; n <= 20; n++) owned.add(`Feature${n}`);
  for (let n = 1; n <= 7; n++) owned.add(`SearchTerm${n}`);
  for (let n = 1; n <= SHOT_MAX; n++) { owned.add(`DesktopScreenshot${n}`); owned.add(`DesktopScreenshotCaption${n}`); }
  owned.add("ShortTitle");
  if (licenseTerms) owned.add("AdditionalLicenseTerms");
  if (hardware) for (let n = 1; n <= 11; n++) owned.add(`MinimumHardwareReq${n}`);
  if (opts.logosDir) { for (const r of LOGO_ROWS) owned.add(r.field); owned.add(OVERRIDE_ROW); }
  const present = new Set(tpl.rows.map((r) => r[0]));
  for (const f of owned) if (!present.has(f)) errors.push(`the template has no row "${f}"`);

  if (errors.length) throw new Error(errors.map((e) => `  - ${e}`).join("\n"));

  const rows = tpl.rows.map((r) => r.slice());
  for (const l of locales) {
    const ci = colIndex.get(l.col);
    const vals = { ...md.byCol[l.col] };
    for (const im of imageSrc[l.col]) vals[im.field] = sl(rootName, im.rel);
    for (const lg of logoSrc) vals[lg.field] = sl(rootName, lg.rel);
    if (logoSrc.length) vals[OVERRIDE_ROW] = "True"; // the two small tiles are given, so the Store uses them instead of the images of the package
    for (const r of rows) if (owned.has(r[0])) r[ci] = vals[r[0]] ?? "";
  }
  const bomWanted = opts.bom === "yes" ? true : opts.bom === "no" ? false : tpl.bom;
  const csvText = serializeCsv([tpl.header, ...rows], tpl.eol, tpl.finalEol);

  // write (files are overwritten, nothing is deleted)
  fs.mkdirSync(outDir, { recursive: true });
  const stale = fs.readdirSync(outDir).filter((f) => /\.csv$/i.test(f) && f !== CSV_NAME);
  if (stale.length) throw new Error(`  - ${outDir} already holds another .csv (${stale.join(", ")}); Partner Center takes one per folder: use an empty folder`);
  const csv = path.join(outDir, CSV_NAME);
  fs.writeFileSync(csv, encodeCsv(csvText, bomWanted));
  const files = [csv];
  for (const l of locales) for (const im of imageSrc[l.col]) files.push(copyTo(im.src, path.join(outDir, im.rel)));
  for (const lg of logoSrc) files.push(copyTo(lg.src, path.join(outDir, lg.rel)));
  if (bestGuess) {
    const note = path.join(path.dirname(outDir), `${path.basename(outDir)}.NOT-PROVEN.txt`);
    fs.writeFileSync(note, "NOT PROVEN: replace by an export from Partner Center.\r\nThis import folder was made from a best-guess template (the field list of an export seen in 2026-10), not from the export of this product.\r\nRun the script again with --template <your export.csv>.\r\n");
    warnings.push("NOT PROVEN: replace by an export from Partner Center (best-guess template); note written to " + note);
  }
  return { csv, files, warnings, rootName, bom: bomWanted, eol: tpl.eol };
}
export const CSV_NAME = "heylook-store-listing.csv";
function copyTo(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
}

// ---------------------------------------------------------------- check
/**
 * Checks an import folder as Partner Center will see it. opts: { templateFile?, rootName?, locales? }. Returns { errors, warnings, info }.
 * Rules: one .csv; the header; every Field known with its ID and Type (and equal to the template's rows when given); per language the limits of
 * validateValues; every image path starts with the folder's name, the file exists inside it and has the size of its row; nothing but the
 * 8 languages' columns is filled in the other device families.
 */
export function checkImportFolder(dir, opts = {}) {
  const errors = [], warnings = [], info = [];
  const root = path.resolve(dir);
  const rootName = opts.rootName ?? path.basename(root);
  if (!fs.existsSync(root)) return { errors: [`${root}: not a folder`], warnings, info };
  const csvs = fs.readdirSync(root).filter((f) => /\.csv$/i.test(f));
  if (csvs.length !== 1) return { errors: [`${root}: ${csvs.length} .csv files, Partner Center takes exactly one per folder`], warnings, info };
  let tpl;
  try { tpl = readCsvFile(path.join(root, csvs[0])); } catch (e) { return { errors: [e.message], warnings, info }; }
  info.push(`${csvs[0]}: ${tpl.rows.length} rows, BOM ${tpl.bom ? "yes" : "no"}, rows end with ${tpl.eol === "\r\n" ? "CRLF" : "LF"}`);
  errors.push(...templateProblems(tpl, csvs[0]));
  if (opts.templateFile) {
    const ref = readCsvFile(opts.templateFile);
    errors.push(...templateProblems(ref, path.basename(opts.templateFile)));
    if (ref.header.join("\u0001") !== tpl.header.join("\u0001")) errors.push(`the header differs from the template: [${tpl.header.join(",")}] vs [${ref.header.join(",")}]`);
    if (ref.rows.length !== tpl.rows.length) errors.push(`${tpl.rows.length} rows, the template has ${ref.rows.length} (every row of the export must stay)`);
    ref.rows.forEach((r, i) => { const o = tpl.rows[i]; if (o && (o[0] !== r[0] || o[1] !== r[1] || o[2] !== r[2])) errors.push(`row ${i + 2}: Field/ID/Type [${o.slice(0, 3).join(" | ")}] differ from the template's [${r.slice(0, 3).join(" | ")}]`); });
  }
  const wanted = opts.locales ? LOCALES.filter((l) => opts.locales.includes(l.col) || opts.locales.includes(l.md)).map((l) => l.col) : LOCALE_COLS;
  const cols = tpl.header.slice(4);
  for (const c of cols) if (!LOCALE_COLS.includes(c)) warnings.push(`column "${c}" is not one of the 8 languages`);
  for (const c of wanted) if (!cols.includes(c)) errors.push(`no column "${c}"`);
  const used = new Set();
  for (const c of wanted) {
    const ci = tpl.header.indexOf(c);
    if (ci < 0) continue;
    const v = {};
    const pathCells = [];
    for (const r of tpl.rows) {
      const f = BY_NAME.get(r[0]);
      if (!f || r[ci] === undefined || r[ci] === "") continue;
      if (f.type === PATH) pathCells.push([f, r[ci]]);
      else v[f.name] = r[ci];
    }
    // the other device families must stay empty
    for (const [f, val] of pathCells) if (!/^(DesktopScreenshot\d+|StoreLogo(720x1080|1080x1080|300x300)|StoreLogoOverride(150x150|71x71)|PromoImage1920x1080)$/.test(f.name)) warnings.push(`${c}: ${f.name} is filled (${val}); this listing uses only desktop screenshots, the StoreLogo rows, the two small tiles and the 16:9 hero art`);
    const flag = tpl.rows.find((r) => r[0] === OVERRIDE_ROW)?.[ci];
    const small = pathCells.filter(([f]) => /^StoreLogoOverride/.test(f.name)).length;
    if (flag === "True" && small !== 2) errors.push(`${c}: ${OVERRIDE_ROW} is True but ${small} of the 2 small tiles (150x150, 71x71) are given`);
    if (flag !== "True" && small === 2) warnings.push(`${c}: the two small tiles are given but ${OVERRIDE_ROW} is "${flag}": the Store will not use them`);
    for (const [f] of pathCells) if (/^DesktopScreenshot\d+$/.test(f.name)) v[f.name] = "x";
    const r = validateValues(c, v, {});
    errors.push(...r.errors); warnings.push(...r.warnings);
    for (const [f, val] of pathCells) {
      if (/^https?:\/\//i.test(val)) { warnings.push(`${c}: ${f.name} is a URL (not checked)`); continue; }
      if (/\\|^\/|\.\.|^[A-Za-z]:/.test(val)) { errors.push(`${c}: ${f.name}: "${val}" must be a relative path with / and no ..`); continue; }
      const slash = val.indexOf("/");
      if (slash < 0 || val.slice(0, slash) !== rootName) { errors.push(`${c}: ${f.name}: "${val}" must start with the root folder name "${rootName}/" (Microsoft: the full path including the root folder name; node scripts/store-listing-csv.mjs --rebase <folder> fixes it)`); continue; }
      const file = path.join(root, val.slice(slash + 1));
      used.add(path.resolve(file));
      const role = /^DesktopScreenshot\d+$/.test(f.name) ? "shot" : LOGO_ROWS.find((x) => x.field === f.name);
      if (!role) continue;
      errors.push(...imageProblems(file, role).map((m) => `${c}: ${f.name}: ${m}`));
    }
  }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const extra = walk(root).filter((f) => !/\.csv$/i.test(f) && !used.has(path.resolve(f)));
  if (extra.length) warnings.push(`${extra.length} file(s) in the folder that no cell names, e.g. ${path.relative(root, extra[0])}`);
  info.push(`${used.size} image files named by the cells`);
  return { errors, warnings, info };
}

/** Rewrites the root folder name in every image path of the folder's csv to the folder's current name. Returns the number of cells changed. */
export function rebaseFolder(dir) {
  const root = path.resolve(dir);
  const csvs = fs.readdirSync(root).filter((f) => /\.csv$/i.test(f));
  if (csvs.length !== 1) throw new Error(`${root}: ${csvs.length} .csv files, expected exactly one`);
  const file = path.join(root, csvs[0]);
  const tpl = readCsvFile(file);
  const name = path.basename(root);
  let n = 0;
  const rows = tpl.rows.map((r) => r.map((c, i) => {
    if (i < 4 || !BY_NAME.has(r[0]) || BY_NAME.get(r[0]).type !== PATH || !c || /^https?:\/\//i.test(c)) return c;
    const m = /^([^/]+)\/(images\/.*)$/.exec(c);
    if (!m || m[1] === name) return c;
    n++;
    return `${name}/${m[2]}`;
  }));
  fs.writeFileSync(file, encodeCsv(serializeCsv([tpl.header, ...rows], tpl.eol, tpl.finalEol), tpl.bom));
  return n;
}

// ---------------------------------------------------------------- command line
function printReport(r) {
  for (const i of r.info ?? []) console.log(`info: ${i}`);
  for (const w of r.warnings) console.log(`warning: ${w}`);
  for (const e of r.errors) console.error(`ERROR: ${e}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "usage:\n  node scripts/store-listing-csv.mjs --md <dir> --images <dir> --out <dir> (--template <export.csv> | --no-template) [--logos <dir>[,<dir>...]] [--root-name n] [--bom auto|yes|no]\n                                     [--release-notes <json>] [--no-license-terms] [--no-hardware] [--dev-studio <text>] [--short-title <text>] [--locales en-us,vi,...]\n  node scripts/store-listing-csv.mjs --check <folder> [--template <export.csv>] [--root-name n] [--locales ...] [--strict]\n  node scripts/store-listing-csv.mjs --rebase <folder>";
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`store-listing-csv: ${e.message}\n${usage}`); process.exit(2); }
  const locales = a.locales ? a.locales.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  try {
    if (a.check) {
      const r = checkImportFolder(a.check, { templateFile: a.template, rootName: a["root-name"], locales });
      printReport(r);
      const bad = r.errors.length || (a.strict && r.warnings.length);
      console.log(`store-listing-csv --check: ${r.errors.length} error(s), ${r.warnings.length} warning(s): ${bad ? "FAILED" : "ok"}`);
      process.exit(bad ? 1 : 0);
    } else if (a.rebase) {
      console.log(`store-listing-csv --rebase: ${rebaseFolder(a.rebase)} path(s) changed`);
    } else if (a.md && a.images && a.out && (a.template || a["no-template"]) && !(a.template && a["no-template"])) {
      if (!["auto", "yes", "no", undefined].includes(a.bom)) throw new Error("--bom is auto, yes or no");
      const release = a["release-notes"] ? JSON.parse(fs.readFileSync(a["release-notes"], "utf8")) : {};
      const r = makeImportFolder({ mdDir: a.md, imagesDir: a.images, logosDir: a.logos, out: a.out, templateFile: a.template, rootName: a["root-name"], bom: a.bom ?? "auto", release, licenseTerms: !a["no-license-terms"], hardware: !a["no-hardware"], devStudio: a["dev-studio"], shortTitle: a["short-title"], locales });
      for (const w of r.warnings) console.log(`warning: ${w}`);
      console.log(`store-listing-csv: wrote ${r.csv} and ${r.files.length - 1} image file(s); root folder name "${r.rootName}", BOM ${r.bom ? "yes" : "no"}, rows end with ${r.eol === "\r\n" ? "CRLF" : "LF"}`);
      const c = checkImportFolder(a.out, { templateFile: a.template, rootName: r.rootName, locales });
      printReport({ ...c, info: [] });
      if (c.errors.length) { console.error("store-listing-csv: the folder just written fails its own check"); process.exit(1); }
      console.log(`store-listing-csv: check of the result ok (${c.warnings.length} warning(s))`);
      if (!a.template) console.log("NOT PROVEN: replace by an export from Partner Center");
    } else { console.error(usage); process.exit(2); }
  } catch (e) {
    console.error(`store-listing-csv: FAILED, nothing was written:\n${e.message}`);
    process.exit(1);
  }
}
