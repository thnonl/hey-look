// The Store listing import (scripts/store-listing-csv.mjs, rules: IMPORT-SPEC.md of the BA): the md files + images + the Partner Center export become an import
// folder, and every wrong input stops it. No browser, no network. Run: node scripts/test-store-listing-csv.mjs
//   - the field table equals the real export (scripts/fixtures/store-listing/partner-center-export.csv: BOM, CRLF, 453 rows, 24 empty ones at the end), and reading + writing
//     it again gives the same bytes
//   - CSV: commas, quotes and line breaks in a cell survive; the Description keeps its line breaks
//   - the text rules of the spec (3.3): NFC, tab, zero-width, trailing space, HTML, markdown, URL, braces, raw key, count / note lines; the "S<N>: " caption format; the
//     revision line; the Product name = the Title of the export; one line fields; the same number of screenshots in every language
//   - make: only the cells this script owns change (every other row, also Title and the empty rows, is byte for byte the export's); the 8 language columns
//     are filled from the 8 md files (all 3 caption styles, count notes dropped); image cells are <root>/images/<column>/S<n>.png; the folder checks out
//   - every failure the brief lists is a failure: unknown Field, changed ID / Type, md of an unknown language, missing section, empty Description, texts over
//     their limits (Description 10000, short 1000, feature 200, search term 40, 7 terms, 21 words, 20 features), missing / non-PNG / cut / wrong-size /
//     not 16:9 images, a placeholder in ReleaseNotes, a second .csv in the folder, a renamed root folder (--check) and its --rebase
//   - without a template: the best-guess template is written and marked NOT PROVEN
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { CSV_NAME, DEFAULT_DEV_STUDIO, DEFAULT_SHORT_TITLE, LOCALES, LOCALE_COLS, LOGO_ROWS, checkImportFolder, fieldTable, makeImportFolder, parseCsv, parseListingMd, readCsvFile, rebaseFolder, serializeCsv, splitSections, templateProblems, textRuleProblems } from "./store-listing-csv.mjs";
import { listingExtras, storeLogos } from "./lib/msix.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "store-listing", "partner-center-export.csv");
let n = 0;
const check = (label, fn) => {
  try { fn(); } catch (e) { e.message = `${label}: ${e.message}`; throw e; }
  n++;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hl-storecsv-"));
let seq = 0;
const tmp = (name) => { const d = path.join(tmpRoot, `${name}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- a PNG of any size (one colour; deflate keeps it small)
const crcTable = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const pngCache = new Map();
function png(w, h) {
  const key = `${w}x${h}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3, 0x44); row[0] = 0;
  const raw = Buffer.alloc(row.length * h); for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  const buf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  pngCache.set(key, buf);
  return buf;
}

// ---- md fixtures: the format of IMPORT-SPEC 3 (revision line, "S<N>: " captions, no count notes), plus sections that are not imported
const SECTION = (title, body) => `## ${title}\n\n${body}\n\n`;
function mdFor(loc, o = {}) {
  const features = o.features ?? Array.from({ length: 5 }, (_, i) => `Feature ${i + 1} in ${loc.md}, with a comma`);
  const caps = Array.from({ length: o.shots ?? 8 }, (_, i) => `S${i + 1}: Caption ${i + 1} in ${loc.md}, "quoted"`);
  const parts = {
    "Product name": o.productName ?? "Hey Look! Mail Client",
    ...(o.shortTitle ? { "Short title": o.shortTitle } : {}),
    ...(o.titles ? { "Short title": "Hey Look!", "Sort title": "Hey Look Mail Client", "Voice title": "Hey Look Mail Client" } : {}),
    "Short description": o.short ?? `Short text in ${loc.md}, with a comma.`,
    "Description": o.description ?? `First paragraph in ${loc.md}, with "quotes" and a comma.\n\nHeading one\nText under heading one.\n\nHeading two\nMore text.`,
    "Product features": features.join("\n"),
    "Search terms": (o.terms ?? ["email", "mail client", "IMAP", "OpenPGP", "calendar", "encrypted email", "inbox"]).join("\n"),
    "Copyright and trademark info": "© 2026 thnonl. MIT License.",
    ...(o.dev === null ? {} : { "Developed by": o.dev ?? "thnonl" }),
    "Applicable license terms": "MIT License\n\nCopyright (c) 2026 thnonl",
    "Additional system requirements": "Windows 10 version 1809 or later\nAn email account\nAn internet connection",
    "What's new in this version": o.whatsNew ?? "",
    "What's new template (later versions, not imported now)": "Version {version}: {summary of the main changes}. (3 characters)",
    "Screenshot captions": caps.join("\n"),
    "Screenshot scenes": "S1: not imported",
    "Sample mail for screenshots": "| # | sender |\n|---|---|\n| 1 | A |",
    "Character counts": "| field | count |\n|---|---|\n| Short description | 12 |",
  };
  Object.assign(parts, o.raw ?? {});
  for (const k of o.drop ?? []) delete parts[k];
  const head = `# Hey Look! – Microsoft Store listing – ${loc.md}\n\n` + (o.revision === null ? "" : `Listing revision ${o.revision ?? "1.0.9"} (2026-10-26), first Store submission, app version 1.0.9.\n\n`);
  return head + Object.entries(parts).map(([k, v]) => SECTION(k, v)).join("");
}
function writeMd(dir, o = {}, per = {}) {
  for (const loc of LOCALES) fs.writeFileSync(path.join(dir, `${loc.md}.md`), mdFor(loc, { ...o, ...(per[loc.md] ?? {}) }));
  return dir;
}
function writeImages(dir, { shots = 8, w = 1920, h = 1080 } = {}) {
  for (const loc of LOCALES) {
    fs.mkdirSync(path.join(dir, loc.col), { recursive: true });
    for (let i = 1; i <= shots; i++) fs.writeFileSync(path.join(dir, loc.col, `S${i}.png`), png(w, h));
  }
  return dir;
}
function writeLogos(dir) {
  fs.mkdirSync(path.join(dir, "store"), { recursive: true });
  fs.writeFileSync(path.join(dir, "store", "store-poster-720x1080.png"), png(720, 1080));
  fs.writeFileSync(path.join(dir, "store", "store-box-1080x1080.png"), png(1080, 1080));
  fs.writeFileSync(path.join(dir, "store", "store-tile-300x300.png"), png(300, 300));
  fs.writeFileSync(path.join(dir, "store", "store-tile-150x150.png"), png(150, 150));
  fs.writeFileSync(path.join(dir, "store", "store-tile-71x71.png"), png(71, 71));
  fs.writeFileSync(path.join(dir, "store", "store-hero-1920x1080.png"), png(1920, 1080));
  return dir;
}
const base = () => ({ md: writeMd(tmp("md")), images: writeImages(tmp("img")), logos: writeLogos(tmp("logo")) });
const make = (over = {}) => {
  const b = base();
  const out = over.out ?? path.join(tmp("out"), "heylook-listing-109");
  const opts = { mdDir: b.md, imagesDir: b.images, logosDir: b.logos, out, templateFile: FIXTURE, bom: "auto", ...over };
  return { b, out, ...makeImportFolder(opts) };
};
const fails = (label, re, fn) => assert.throws(fn, (e) => re.test(e.message), `${label}: expected a failure matching ${re}`);
const cellsOf = (csv) => { const t = readCsvFile(csv); const by = new Map(t.rows.map((r) => [r[0], r])); return { t, get: (f, col) => by.get(f)[t.header.indexOf(col)] }; };

// ---- the table and the export
check("the table equals the export (Field, ID, Type, order)", () => {
  const t = readCsvFile(FIXTURE);
  assert.deepEqual(t.header, ["Field", "ID", "Type (Type)", "default", "en-us", "vi", "fr", "zh-hans", "es", "ja", "de", "ru"]);
  assert.deepEqual(templateProblems(t), []);
  const real = t.rows.filter((r) => r[0] !== "").map((r) => r.slice(0, 3).join("|"));
  assert.deepEqual(fieldTable().map((f) => [f.name, f.id, f.type].join("|")), real);
  assert.equal(t.rows.filter((r) => r.every((c) => c === "")).length, 24, "the export ends with 24 empty rows");
  assert.deepEqual(LOCALE_COLS, t.header.slice(4));
});
check("reading and writing the export gives the same bytes (BOM, CRLF, no final break)", () => {
  const raw = fs.readFileSync(FIXTURE);
  const t = readCsvFile(FIXTURE);
  assert.equal(t.bom, true);
  assert.equal(t.eol, "\r\n");
  assert.equal(t.finalEol, false);
  const again = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serializeCsv([t.header, ...t.rows], t.eol, t.finalEol), "utf8")]);
  assert.ok(raw.equals(again));
});
check("templateProblems: unknown Field, changed ID, changed Type, odd width", () => {
  const t = readCsvFile(FIXTURE);
  const mutate = (fn) => { const c = { ...t, rows: t.rows.map((r) => r.slice()) }; fn(c); return templateProblems(c); };
  assert.match(mutate((c) => { c.rows[0][0] = "Descriptionn"; }).join("\n"), /unknown Field "Descriptionn"/);
  assert.match(mutate((c) => { c.rows[0][1] = "3"; }).join("\n"), /Description: ID is "3"/);
  assert.match(mutate((c) => { c.rows[0][2] = "Relative path"; }).join("\n"), /Description: Type is/);
  assert.match(mutate((c) => { c.rows[1].pop(); }).join("\n"), /cells, the header/);
  assert.match(mutate((c) => { c.rows[1][0] = "Description"; }).join("\n"), /twice/);
});

// ---- CSV
check("CSV: commas, quotes and line breaks in a cell, CRLF and LF rows", () => {
  const rows = [["a", 'b "c", d', "e\nf\r\ng"], ["", "x", ""]];
  for (const eol of ["\r\n", "\n"]) {
    for (const fin of [false, true]) {
      const text = serializeCsv(rows, eol, fin);
      const back = parseCsv(text);
      assert.deepEqual(back.rows, rows);
      assert.equal(back.eol, eol);
      assert.equal(back.finalEol, fin);
    }
  }
  assert.equal(serializeCsv([["a", "b,c", 'd"e']]), 'a,"b,c","d""e"');
  assert.throws(() => parseCsv('a,"b'), /quoted cell/);
});

// ---- the md files
check("md: sections, one line fields, captions, revision", () => {
  const en = LOCALES[0];
  const { values, productName, errors } = parseListingMd(mdFor(en), "en.md");
  assert.deepEqual(errors, []);
  assert.equal(productName, "Hey Look! Mail Client");
  assert.equal(values.ShortDescription, "Short text in en, with a comma.");
  assert.match(values.Description, /^First paragraph in en, with "quotes" and a comma\.\n\nHeading one\nText under heading one\.\n\nHeading two\nMore text\.$/);
  assert.equal(values.Feature5, "Feature 5 in en, with a comma");
  assert.equal(values.SearchTerm7, "inbox");
  assert.equal(values.SearchTerm8, undefined);
  assert.equal(values.DesktopScreenshotCaption1, 'Caption 1 in en, "quoted"');
  assert.equal(values.ReleaseNotes, "", "the first submission leaves What's new empty");
  assert.equal(values.SortTitle, undefined, "Sort title and Voice title are not written without --titles-from-md");
  assert.deepEqual(Object.keys(splitSections(mdFor(en))).slice(0, 3), ["Product name", "Short description", "Description"]);
  const bad = (o) => parseListingMd(mdFor(en, o), "en.md", o.opts).errors.join("\n");
  assert.match(bad({ revision: null }), /no line "Listing revision 1\.0\.9"/);
  assert.match(bad({ revision: "1.0.90" }), /no line "Listing revision 1\.0\.9"/, "1.0.90 is not 1.0.9");
  assert.equal(bad({ revision: "1.0.10", opts: { revision: "1.0.10" } }), "");
  assert.equal(bad({ revision: null, opts: { revision: "" } }), "", "no check when no revision is asked for");
  assert.match(bad({ drop: ["Product name"] }), /the section "## Product name" is missing/);
  assert.match(bad({ raw: { "Product name": "a\nb" } }), /"## Product name" must be one line/);
  assert.match(bad({ raw: { "Developed by": "a\nb" } }), /"## Developed by" must be one line/);
  assert.match(bad({ raw: { "Screenshot captions": "S1: ok\nS2:no space" } }), /caption line not understood \(it must be "S<N>: text"\): S2:no space/);
  assert.match(bad({ raw: { "Screenshot captions": "S1 (scene): old style" } }), /caption line not understood/);
  assert.match(bad({ raw: { "Screenshot captions": "S1: a\nS1: b" } }), /caption S1 twice/);
  assert.match(bad({ raw: { "Screenshot captions": "S31: too many" } }), /caption line not understood/);
  assert.match(bad({ titles: true, opts: { titlesFromMd: true }, drop: ["Sort title"] }), /"## Sort title" is missing/);
  const t = parseListingMd(mdFor(en, { titles: true }), "en.md", { titlesFromMd: true }).values;
  assert.equal(t.SortTitle, "Hey Look Mail Client");
  assert.equal(t.VoiceTitle, "Hey Look Mail Client");
  assert.equal(parseListingMd(mdFor(en), "en.md", { sortTitle: "S", voiceTitle: "" }).values.VoiceTitle, "", "an explicit empty VoiceTitle is written (it clears the row)");
});
check("text rules of the spec (3.3): every one is an error with the field and the line", () => {
  const prob = (text, name = "Description") => textRuleProblems("en", name, text).join(" | ");
  assert.equal(prob("Plain text, with a comma.\n\nAnd a second paragraph (in brackets)."), "");
  assert.equal(prob("Typographic: … © “ ” « » 「」 full-width：punctuation，ok"), "");
  assert.equal(prob("the app. For more"), "", "a dot and a space is not a raw key");
  assert.match(prob("A\u0065\u0301 composed"), /not in Unicode NFC/);
  assert.match(prob("one\ttwo"), /en: Description, line 1: a tab/);
  assert.match(prob("one\u200btwo"), /a zero-width character/);
  assert.match(prob("fine\ntrailing space \nfine"), /line 2: a space at the end of the line/);
  assert.match(prob("a <b>bold</b> word"), /HTML/);
  assert.match(prob("see <!-- x -->"), /HTML/);
  for (const line of ["# heading", "- item", "* item", "> quote", "| a | b |", "so **bold** is", "a [link](x)"]) assert.match(prob(line), /a markdown marker/, line);
  assert.match(prob("go to https://example.com now"), /a URL/);
  assert.match(prob("see www.example.com"), /a URL/);
  assert.match(prob("a {placeholder} here"), /a brace/);
  assert.match(prob("a } alone"), /a brace/);
  for (const key of ["settings.about.title", "mail.ctx.createRule", "app.cmd.x", "reading.head.y", "common.ok"]) assert.match(prob(`see ${key} there`), /a raw text key/, key);
  for (const line of ["(203 characters)", "(8 unique words)", "203 characters", "12 ký tự", "Characters: 250", "Символов: 228", "Caractères : 12", "Zeichen: 5", "字符：8", "文字数: 9", "leave this field empty", "First submission: leave the field blank", "this is EMPTY"]) assert.match(prob(line), /a count or note line/, line);
  assert.match(prob("line one\nline two with a tab\there\nthree"), /line 2: a tab/, "the line number counts lines of the text");
});

// ---- make
check("make: the folder, the cells, the unchanged rows", () => {
  const { out, csv, files, warnings } = make();
  assert.equal(path.basename(out), "heylook-listing-109");
  assert.equal(path.basename(csv), CSV_NAME);
  assert.equal(files.length, 1 + 8 * 8 + 6);
  assert.ok(fs.existsSync(path.join(out, "screenshots", "zh-hans", "S8.png")));
  assert.ok(fs.existsSync(path.join(out, "logos", "store-poster-720x1080.png")));
  assert.equal(path.basename(csv), "listing.csv");
  assert.deepEqual(fs.readdirSync(out).sort(), ["listing.csv", "logos", "screenshots"], "one csv, logos, screenshots");
  assert.equal(fs.readdirSync(path.join(out, "logos")).length, 6);
  assert.deepEqual(fs.readdirSync(path.join(out, "screenshots")).sort(), [...LOCALE_COLS].sort());
  const raw = fs.readFileSync(csv);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM like the export (auto)");
  const { t, get } = cellsOf(csv);
  assert.deepEqual(t.header, readCsvFile(FIXTURE).header, "header unchanged");
  assert.equal(t.eol, "\r\n");
  assert.match(get("Description", "de"), /^First paragraph in de, with "quotes" and a comma\.\n\nHeading one\n/);
  assert.equal(get("ShortDescription", "ja"), "Short text in ja, with a comma.");
  assert.equal(get("ReleaseNotes", "en-us"), "");
  assert.equal(get("DevStudio", "ru"), "thnonl");
  assert.equal(get("CopyrightTrademarkInformation", "es"), "© 2026 thnonl. MIT License.");
  assert.equal(get("Feature5", "fr"), "Feature 5 in fr, with a comma");
  assert.equal(get("Feature6", "fr"), "");
  assert.equal(get("SearchTerm2", "vi"), "mail client");
  assert.equal(get("DesktopScreenshot1", "en-us"), "heylook-listing-109/screenshots/en-us/S1.png");
  assert.equal(get("DesktopScreenshot8", "zh-hans"), "heylook-listing-109/screenshots/zh-hans/S8.png");
  assert.equal(get("DesktopScreenshot9", "zh-hans"), "", "the rows after the last caption stay as exported");
  assert.equal(get("DesktopScreenshotCaption9", "zh-hans"), "");
  assert.equal(get("DesktopScreenshotCaption4", "ja"), 'Caption 4 in ja, "quoted"');
  assert.equal(get("StoreLogo720x1080", "de"), "heylook-listing-109/logos/store-poster-720x1080.png");
  assert.equal(get("StoreLogo300x300", "ru"), "heylook-listing-109/logos/store-tile-300x300.png");
  assert.equal(get("StoreLogo1080x1080", "ja"), "heylook-listing-109/logos/store-box-1080x1080.png");
  assert.equal(get("StoreLogoOverride150x150", "es"), "heylook-listing-109/logos/store-tile-150x150.png");
  assert.equal(get("StoreLogoOverride71x71", "es"), "heylook-listing-109/logos/store-tile-71x71.png");
  assert.equal(get("PromoImage1920x1080", "fr"), "heylook-listing-109/logos/store-hero-1920x1080.png");
  assert.equal(get("OverrideLogosForWin10", "ja"), "True", "the small tiles are given: the Store must use them");
  assert.equal(get("ShortTitle", "ru"), DEFAULT_SHORT_TITLE);
  assert.equal(get("DevStudio", "ru"), "thnonl", "the md says something: it wins over the built-in default");
  assert.equal(get("AdditionalLicenseTerms", "en-us"), "MIT License\n\nCopyright (c) 2026 thnonl");
  assert.equal(get("MinimumHardwareReq1", "en-us"), "Windows 10 version 1809 or later");
  assert.equal(get("MinimumHardwareReq3", "en-us"), "An internet connection");
  assert.equal(get("MinimumHardwareReq4", "en-us"), "");
  assert.equal(get("RecommendedHardwareReq1", "en-us"), "", "not used");
  assert.equal(get("VoiceTitle", "en-us"), "");
  assert.equal(get("MobileScreenshot1", "en-us"), "");
  assert.equal(get("Title", "ja"), "Hey Look! Mail Client", "Title stays as the export has it");
  assert.equal(get("Description", "default") ?? "", "", "the default column stays empty");
  // every row but the owned cells is the export's
  const orig = readCsvFile(FIXTURE);
  assert.equal(t.rows.length, orig.rows.length, "every row is kept, also the empty ones");
  const owned = /^(Description|ShortDescription|ShortTitle|ReleaseNotes|DevStudio|CopyrightTrademarkInformation|AdditionalLicenseTerms|Feature\d+|SearchTerm\d+|MinimumHardwareReq\d+|DesktopScreenshot[1-8]|DesktopScreenshotCaption[1-8]|StoreLogo(720x1080|1080x1080|300x300)|StoreLogoOverride(150x150|71x71)|PromoImage1920x1080|OverrideLogosForWin10)$/;
  t.rows.forEach((r, i) => r.forEach((c, j) => { if (!(owned.test(r[0]) && j >= 4)) assert.equal(c, orig.rows[i][j], `row ${r[0]} col ${j}`); }));
  assert.deepEqual(t.rows.map((r) => r[3]), t.rows.map(() => ""), "the default column is empty in every row");
  assert.deepEqual(warnings, []);
  const chk = checkImportFolder(out, { templateFile: FIXTURE });
  assert.deepEqual(chk.errors, []);
  assert.deepEqual(chk.warnings, []);
});
check("make: --bom yes / no / auto, a template without BOM", () => {
  const first = (r) => [...fs.readFileSync(r.csv).subarray(0, 3)];
  assert.deepEqual(first(make({ bom: "no" })), [0x46, 0x69, 0x65], "no BOM: starts with Fie(ld)");
  assert.deepEqual(first(make({ bom: "yes" })), [0xef, 0xbb, 0xbf]);
  const plain = path.join(tmp("tpl"), "plain.csv");
  fs.writeFileSync(plain, fs.readFileSync(FIXTURE).subarray(3));
  const r = make({ templateFile: plain });
  assert.deepEqual(first(r), [0x46, 0x69, 0x65], "auto follows the template");
  assert.equal(r.bom, false);
});
check("make: root folder name is a parameter and part of every path", () => {
  const out = path.join(tmp("out"), "folder-x");
  const r = make({ out, rootName: "my_folder" });
  const { get } = cellsOf(r.csv);
  assert.equal(get("DesktopScreenshot1", "en-us"), "my_folder/screenshots/en-us/S1.png");
  assert.match(checkImportFolder(out).errors.join("\n"), /must start with the root folder name "folder-x\/"/, "check wants the folder's own name");
  assert.deepEqual(checkImportFolder(out, { rootName: "my_folder" }).errors, []);
  assert.equal(rebaseFolder(out), 8 * 8 + 8 * 6);
  assert.deepEqual(checkImportFolder(out).errors, []);
  assert.equal(cellsOf(r.csv).get("StoreLogo300x300", "vi"), "folder-x/logos/store-tile-300x300.png");
  fails("bad root name", /root folder name/, () => make({ out: path.join(tmp("out"), "ok"), rootName: "a b/c" }));
});
check("make: release notes from a file; --no-license-terms / --no-hardware; ShortTitle and DevStudio: option > md > default", () => {
  const r = make({ release: { en: "Version 1.0.10: fixes." } });
  const { get } = cellsOf(r.csv);
  assert.equal(get("ReleaseNotes", "en-us"), "Version 1.0.10: fixes.");
  assert.equal(get("ReleaseNotes", "fr"), "");
  fails("placeholder", /ReleaseNotes, line 1: a brace/, () => make({ release: { en: "Version {version}: x" } }));
  const off = cellsOf(make({ licenseTerms: false, hardware: false }).csv);
  assert.equal(off.get("AdditionalLicenseTerms", "ja"), "");
  assert.equal(off.get("MinimumHardwareReq1", "ja"), "");
  // the option wins and the md that says something else is reported
  const opt = make({ devStudio: DEFAULT_DEV_STUDIO, shortTitle: "Hey" });
  assert.equal(cellsOf(opt.csv).get("DevStudio", "de"), "Noamo, thnonl");
  assert.equal(cellsOf(opt.csv).get("ShortTitle", "de"), "Hey");
  assert.match(opt.warnings.join(" "), /"Developed by" says "thnonl", the option wins: "Noamo, thnonl"/);
  // an md without a "Developed by" gets the built-in default; an md "## Short title" wins over the default, the option over the md
  const md = { md: writeMd(tmp("md"), { dev: null, shortTitle: "Hey Look (md)" }), images: writeImages(tmp("img")) };
  const go = (extra) => makeImportFolder({ mdDir: md.md, imagesDir: md.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE, ...extra });
  const r2 = go({});
  assert.equal(cellsOf(r2.csv).get("DevStudio", "ja"), DEFAULT_DEV_STUDIO);
  assert.equal(cellsOf(r2.csv).get("ShortTitle", "ja"), "Hey Look (md)");
  assert.equal(cellsOf(go({ shortTitle: "Opt" }).csv).get("ShortTitle", "ja"), "Opt");
  fails("ShortTitle over 50", /ShortTitle is 51 characters/, () => go({ shortTitle: "x".repeat(51) }));
});
check("the logo rows and the msix image lists agree (names and sizes)", () => {
  const list = [...storeLogos(), ...listingExtras()];
  for (const row of LOGO_ROWS) {
    const m = list.find((i) => i.file === row.file);
    assert.ok(m, `${row.file} is made by scripts/msix-assets.mjs`);
    assert.deepEqual([m.w, m.h], [row.w, row.h], row.file);
  }
});
check("make: Title = Product name (REQ-6), revision (REQ-3), the same screenshots in every language (REQ-9), --texts-only, Sort / Voice title", () => {
  const go = (o, extra = {}, per = {}) => {
    const b = { md: writeMd(tmp("md"), o, per), images: writeImages(tmp("img")) };
    return () => makeImportFolder({ mdDir: b.md, imagesDir: b.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE, ...extra });
  };
  fails("product name", /de\.md: Product name is "Hey Look!", the Store name is "Hey Look! Mail Client"/, go({}, {}, { de: { productName: "Hey Look!" } }));
  fails("revision", /ja\.md: no line "Listing revision 1\.0\.9"/, go({}, {}, { ja: { revision: null } }));
  go({ revision: null }, { revision: "" })(); // (the check can be switched off)
  fails("title of the export", /en-us: the Title of the export is "Hey Look! Mail Client", the md's Product name is "Other"/, go({ productName: "Other" }));
  // (every md says Other: the Store name check fails first, so use a template whose Title differs instead)
  const t = fs.readFileSync(FIXTURE, "utf8").replace(/^\uFEFF/, "").replace("\r\nTitle,4,Text,,Hey Look! Mail Client,", "\r\nTitle,4,Text,,Another Name,");
  const f = path.join(tmp("tpl"), "title.csv"); fs.writeFileSync(f, t);
  fails("Title cell", /en-us: the Title of the export is "Another Name", the md's Product name is "Hey Look! Mail Client" \(IMPORT-SPEC REQ-6\)/, go({}, { templateFile: f }));
  fails("different screenshot counts", /different numbers of captions \(.*ja 7.*\)/, go({}, {}, { ja: { shots: 7 } }));
  // --texts-only: no screenshot rows, no captions, no image files needed
  const to = (() => { const b = { md: writeMd(tmp("md")) }; return makeImportFolder({ mdDir: b.md, out: path.join(tmp("o"), "a"), templateFile: FIXTURE, textsOnly: true }); })();
  const c = cellsOf(to.csv);
  assert.equal(c.get("DesktopScreenshot1", "en-us"), "");
  assert.equal(c.get("DesktopScreenshotCaption1", "en-us"), "");
  assert.equal(c.get("Description", "en-us") !== "", true);
  assert.deepEqual(checkImportFolder(path.dirname(to.csv), { templateFile: FIXTURE }).errors.filter((e) => !/no screenshot/.test(e)), []);
  // Sort / Voice title: not written by default; --titles-from-md writes both; explicit options write one
  const def = cellsOf(make().csv);
  assert.equal(def.get("SortTitle", "en-us"), "");
  assert.equal(def.get("VoiceTitle", "en-us"), "");
  const b = { md: writeMd(tmp("md"), { titles: true }), images: writeImages(tmp("img")) };
  const withTitles = cellsOf(makeImportFolder({ mdDir: b.md, imagesDir: b.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE, titlesFromMd: true }).csv);
  assert.equal(withTitles.get("SortTitle", "ja"), "Hey Look Mail Client");
  assert.equal(withTitles.get("VoiceTitle", "ja"), "Hey Look Mail Client");
  assert.equal(withTitles.get("ShortTitle", "ja"), "Hey Look!");
  const one = cellsOf(makeImportFolder({ mdDir: b.md, imagesDir: b.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE, sortTitle: "Sorted" }).csv);
  assert.equal(one.get("SortTitle", "ja"), "Sorted");
  assert.equal(one.get("VoiceTitle", "ja"), "");
});
check("make: the report names every length against its limit", () => {
  const r = make();
  assert.equal(r.report.length, 8);
  assert.match(r.report[0], /^en-us\s+Description \d+\/10000, short 31\/1000 \(advice 270\), short title 9\/50, developed by 6\/255, copyright 27\/200, license \d+\/10000, features 5\/20 \(longest 29\/200\), terms 7\/7 \(longest 15\/40, 9\/21 words\), captions 8 \(longest 25\/200\), requirements 3, screenshots 8$/);
});
check("make: the md of a text can be cut to a few languages (--locales)", () => {
  const r = make({ locales: ["de", "ja"] });
  const { get } = cellsOf(r.csv);
  assert.equal(get("Description", "de") !== "", true);
  assert.equal(get("Description", "fr"), "");
  assert.ok(!fs.existsSync(path.join(path.dirname(r.csv), "screenshots", "fr")));
});

// ---- every failure
check("fail: unknown Field / changed ID in the template", () => {
  const t = fs.readFileSync(FIXTURE, "utf8").replace(/^﻿/, "");
  const f1 = path.join(tmp("tpl"), "unknown.csv"); fs.writeFileSync(f1, t.replace("\r\nShortTitle,5,", "\r\nShortTitel,5,"));
  const f2 = path.join(tmp("tpl"), "id.csv"); fs.writeFileSync(f2, t.replace("\r\nDescription,2,", "\r\nDescription,22,"));
  const f3 = path.join(tmp("tpl"), "hdr.csv"); fs.writeFileSync(f3, t.replace("Field,ID", "Feld,ID"));
  const f4 = path.join(tmp("tpl"), "nolang.csv"); fs.writeFileSync(f4, t.replace(",ru\r\n", ",ru2\r\n"));
  const f5 = path.join(tmp("tpl"), "norow.csv"); fs.writeFileSync(f5, t.replace(/\r\nFeature3,[^\r]*/, ""));
  fails("unknown", /unknown Field "ShortTitel"/, () => make({ templateFile: f1 }));
  fails("id", /Description: ID is "22"/, () => make({ templateFile: f2 }));
  fails("header", /header must start with Field, ID, Type, default/, () => make({ templateFile: f3 }));
  fails("no column", /no column "ru"/, () => make({ templateFile: f4 }));
  fails("no row", /no row "Feature3"/, () => make({ templateFile: f5 }));
  assert.match(checkImportFolder(make().out, { templateFile: f2 }).errors.join("\n"), /ID is "22"/);
});
check("fail: md problems (unknown language, missing file, missing section, empty Description)", () => {
  const b = base();
  fs.writeFileSync(path.join(b.md, "xx.md"), "x");
  fails("unknown language", /unknown locale: xx\.md/, () => makeImportFolder({ mdDir: b.md, imagesDir: b.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  const b2 = { md: writeMd(tmp("md"), { drop: ["Search terms"] }), images: b.images };
  fails("missing section", /the section "## Search terms" is missing/, () => makeImportFolder({ mdDir: b2.md, imagesDir: b2.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  const b3 = { md: writeMd(tmp("md"), {}, { ja: { description: "\n" } }), images: b.images };
  fails("empty Description", /ja: Description is required and empty/, () => makeImportFolder({ mdDir: b3.md, imagesDir: b3.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  const b4 = tmp("md"); writeMd(b4); fs.renameSync(path.join(b4, "de.md"), path.join(b4, "de2.md"));
  fails("missing file", /de\.md: missing/, () => makeImportFolder({ mdDir: b4, imagesDir: b.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  const b5 = { md: writeMd(tmp("md"), { shots: 0 }), images: b.images };
  fails("no caption", /no screenshot caption/, () => makeImportFolder({ mdDir: b5.md, imagesDir: b5.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  const b6 = { md: writeMd(tmp("md"), { drop: ["Screenshot captions"] }), images: b.images };
  fails("no captions section", /"## Screenshot captions" is missing/, () => makeImportFolder({ mdDir: b6.md, imagesDir: b6.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  const b7 = { md: writeMd(tmp("md")), images: b.images };
  fs.writeFileSync(path.join(b7.md, "ru.md"), mdFor(LOCALES[7]).replace("S3: ", "garbage line\nS3: "));
  const b8 = { md: writeMd(tmp("md"), {}, { fr: { raw: { Description: "A paragraph.\n\n(203 characters)" } } }), images: b.images };
  fails("count line in a section", /fr: Description, line 3: a count or note line/, () => makeImportFolder({ mdDir: b8.md, imagesDir: b8.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  const b9 = { md: writeMd(tmp("md"), { raw: { "Short description": "See https://example.com" } }), images: b.images };
  fails("URL in a section", /en-us: ShortDescription, line 1: a URL/, () => makeImportFolder({ mdDir: b9.md, imagesDir: b9.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
  fails("caption line", /caption line not understood \(it must be "S<N>: text"\)/, () => makeImportFolder({ mdDir: b7.md, imagesDir: b7.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }));
});
check("fail: limits", () => {
  const run = (o, per) => { const b = { md: writeMd(tmp("md"), o, per), images: writeImages(tmp("img")) }; return () => makeImportFolder({ mdDir: b.md, imagesDir: b.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE }); };
  run({ description: "x".repeat(10000) })(); // exactly the limit: fine
  fails("Description 10001", /Description is 10001 characters, the limit is 10000/, run({ description: "x".repeat(10001) }));
  run({ short: "y".repeat(271) })(); // above 270 is a warning, not a failure
  fails("short 1001", /ShortDescription is 1001 characters/, run({ short: "y".repeat(1001) }));
  run({ features: Array(20).fill("f".repeat(200)) })();
  fails("feature 201", /Feature1 is 201 characters/, run({ features: ["f".repeat(201)] }));
  fails("21 features", /21 values for \^Feature/, run({ features: Array(21).fill("f") }));
  run({ terms: ["t".repeat(40)] })();
  fails("term 41", /SearchTerm1 is 41 characters/, run({ terms: ["t".repeat(41)] }));
  fails("8 terms", /8 values for \^SearchTerm/, run({ terms: Array.from({ length: 8 }, (_, i) => `t${i}`) }));
  run({ terms: ["a b c", "d e f", "g h i", "j k l", "m n o", "p q r", "s t u"] })(); // 21 words
  fails("22 words", /22 words, at most 21/, run({ terms: ["a b c", "d e f", "g h i", "j k l", "m n o", "p q r", "s t u v"] }));
  const b = { md: writeMd(tmp("md"), { short: "y".repeat(271) }), images: writeImages(tmp("img")) };
  const r = makeImportFolder({ mdDir: b.md, imagesDir: b.images, out: path.join(tmp("o"), "a"), templateFile: FIXTURE });
  assert.match(r.warnings.join("\n"), /ShortDescription is 271 characters, Microsoft advises at most 270/);
});
check("fail: images", () => {
  const md = writeMd(tmp("md"));
  const go = (img, logos) => () => makeImportFolder({ mdDir: md, imagesDir: img, logosDir: logos, out: path.join(tmp("o"), "a"), templateFile: FIXTURE });
  const ok = writeImages(tmp("img"));
  const lg = writeLogos(tmp("logo"));
  go(ok, lg)();
  const miss = writeImages(tmp("img")); fs.writeFileSync(path.join(miss, "de", "S8.png"), png(1920, 1080)); fs.renameSync(path.join(miss, "de", "S5.png"), path.join(miss, "de", "S5x.png"));
  fails("missing image", /image file is missing: .*[\\/]de[\\/]S5\.png/, go(miss));
  const small = writeImages(tmp("img")); fs.writeFileSync(path.join(small, "ja", "S1.png"), png(1280, 720));
  fails("too small", /1280x720, a screenshot is 1366x768/, go(small));
  const big = writeImages(tmp("img")); fs.writeFileSync(path.join(big, "ja", "S1.png"), png(3856, 2169));
  fails("too big", /3856x2169, a screenshot is/, go(big));
  const ratio = writeImages(tmp("img")); fs.writeFileSync(path.join(ratio, "ja", "S1.png"), png(1600, 1000));
  fails("not 16:9", /1600x1000 is not 16:9/, go(ratio));
  const ok4k = writeImages(tmp("img")); fs.writeFileSync(path.join(ok4k, "ja", "S1.png"), png(3840, 2160)); go(ok4k)();
  const notpng = writeImages(tmp("img")); fs.writeFileSync(path.join(notpng, "ja", "S1.png"), Buffer.from("GIF89a....................................."));
  fails("not a PNG", /not a PNG/, go(notpng));
  const cut = writeImages(tmp("img")); fs.writeFileSync(path.join(cut, "ja", "S1.png"), png(1920, 1080).subarray(0, 3000));
  fails("cut PNG", /cut off/, go(cut));
  const badLogo = writeLogos(tmp("logo")); fs.writeFileSync(path.join(badLogo, "store", "store-box-1080x1080.png"), png(1000, 1000));
  fails("logo size", /1000x1000, StoreLogo1080x1080 \(box art 1:1\) is exactly 1080x1080/, go(ok, badLogo));
  const badHero = writeLogos(tmp("logo")); fs.writeFileSync(path.join(badHero, "store", "store-hero-1920x1080.png"), png(1280, 720));
  fails("hero size", /1280x720, PromoImage1920x1080 \(hero art 16:9\) is exactly 1920x1080/, go(ok, badHero));
  const split = tmp("split"); const part1 = writeLogos(tmp("logo")); fs.mkdirSync(path.join(split, "store"), { recursive: true });
  fs.renameSync(path.join(part1, "store", "store-hero-1920x1080.png"), path.join(split, "store", "store-hero-1920x1080.png"));
  go(ok, [part1, split].join(","))(); // the logos may sit in two folders
  const noLogo = writeLogos(tmp("logo")); fs.writeFileSync(path.join(noLogo, "store", "store-poster-720x1080.png"), png(1440, 2160));
  fails("poster 2x not in the 720 row", /1440x2160, StoreLogo720x1080/, go(ok, noLogo));
  fails("logo file missing", /logo file store-tile-300x300\.png not found/, go(ok, tmp("empty")));
});
check("fail: a second .csv in the out folder; stale csv; --no-template marks the output", () => {
  const out = path.join(tmp("out"), "listing-import");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "old.csv"), "x");
  const b = base();
  fails("second csv", /already holds another \.csv \(old\.csv\)/, () => makeImportFolder({ mdDir: b.md, imagesDir: b.images, out, templateFile: FIXTURE }));
  const out2 = path.join(tmp("out"), "bestguess");
  const r = makeImportFolder({ mdDir: b.md, imagesDir: b.images, logosDir: b.logos, out: out2 });
  assert.match(r.warnings.join("\n"), /NOT PROVEN: replace by an export from Partner Center/);
  assert.match(fs.readFileSync(path.join(path.dirname(out2), "bestguess.NOT-PROVEN.txt"), "utf8"), /NOT PROVEN/);
  assert.deepEqual(checkImportFolder(out2).errors, []);
  assert.deepEqual(readCsvFile(r.csv).header, readCsvFile(FIXTURE).header, "the best guess has the header of the real export");
  const real = readCsvFile(FIXTURE).rows.filter((x) => x[0]).map((x) => x.slice(0, 3).join("|"));
  assert.deepEqual(readCsvFile(r.csv).rows.map((x) => x.slice(0, 3).join("|")), real);
});

// ---- --check on a finished folder
check("--check: finds what is wrong in a folder", () => {
  const ovr = (t, f, c, v) => { t.rows.find((r) => r[0] === f)[t.header.indexOf(c)] = v; };
  const { out, csv } = make();
  const text = () => fs.readFileSync(csv);
  const orig = text();
  const set = (fn) => { const t = readCsvFile(csv); fn(t); fs.writeFileSync(csv, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serializeCsv([t.header, ...t.rows], t.eol, t.finalEol))])); const r = checkImportFolder(out, { templateFile: FIXTURE }); fs.writeFileSync(csv, orig); return r; };
  const row = (t, f) => t.rows.find((r) => r[0] === f);
  const col = (t, c) => t.header.indexOf(c);
  assert.match(set((t) => { row(t, "Description")[col(t, "fr")] = ""; }).errors.join("\n"), /fr: Description is required and empty/);
  assert.match(set((t) => { row(t, "Description")[col(t, "fr")] = "d".repeat(10001); }).errors.join("\n"), /fr: Description is 10001/);
  assert.match(set((t) => { row(t, "DesktopScreenshot1")[col(t, "es")] = "heylook-listing-109/screenshots/es/nope.png"; }).errors.join("\n"), /es: DesktopScreenshot1: image file is missing/);
  assert.match(set((t) => { row(t, "DesktopScreenshot1")[col(t, "es")] = "other/images/es/S1.png"; }).errors.join("\n"), /must start with the root folder name "heylook-listing-109\/"/);
  assert.match(set((t) => { row(t, "DesktopScreenshot1")[col(t, "es")] = "heylook-listing-109\\screenshots\\es\\S1.png"; }).errors.join("\n"), /relative ASCII path with \/ and no \.\./);
  assert.match(set((t) => { row(t, "DesktopScreenshot1")[col(t, "es")] = "heylook-listing-109/../x.png"; }).errors.join("\n"), /relative ASCII path with \/ and no \.\./);
  assert.match(set((t) => { for (let i = 1; i <= 8; i++) row(t, `DesktopScreenshot${i}`)[col(t, "ja")] = ""; }).errors.join("\n"), /ja: no screenshot|ja: caption 1 has no DesktopScreenshot1/);
  assert.match(set((t) => { row(t, "Title")[0] = "Titel"; }).errors.join("\n"), /unknown Field "Titel"/);
  assert.match(set((t) => { t.rows.pop(); }).errors.join("\n"), /452 rows, the template has 453/);
  assert.match(set((t) => { row(t, "MobileScreenshot1")[col(t, "de")] = "heylook-listing-109/screenshots/de/S1.png"; }).warnings.join("\n"), /de: MobileScreenshot1 is filled/);
  assert.match(set((t) => { row(t, "Feature9")[col(t, "de")] = "gap"; }).warnings.join("\n"), /gap/);
  assert.match(set((t) => { row(t, "DesktopScreenshot1")[col(t, "es")] = "https://developer.microsoft.com/x"; }).warnings.join("\n"), /is a URL \(not checked\)/);
  assert.match(set((t) => { row(t, "Description")[col(t, "de")] += "\nSee https://example.com"; }).errors.join("\n"), /de: Description, line \d+: a URL/);
  assert.match(set((t) => { row(t, "Feature2")[col(t, "de")] += " "; }).errors.join("\n"), /de: Feature2 starts or ends with a space/);
  assert.match(set((t) => { row(t, "Title")[col(t, "de")] = "Changed"; }).errors.join("\n"), /row \d+ \(Title\): this row is not written by the import and differs from the export/);
  assert.match(set((t) => { row(t, "MobileScreenshot1")[col(t, "de")] = ""; row(t, "Trailer1")[col(t, "ru")] = "x"; }).errors.join("\n"), /\(Trailer1\): this row is not written/);
  assert.match(set((t) => { row(t, "Description")[3] = "shared"; }).errors.join("\n"), /\(Description\): the default column must stay empty/);
  assert.match(set((t) => { row(t, "DesktopScreenshot8")[col(t, "ja")] = ""; row(t, "DesktopScreenshotCaption8")[col(t, "ja")] = ""; }).errors.join("\n"), /different numbers of screenshots/);
  assert.match(set((t) => { row(t, "DesktopScreenshotCaption8")[col(t, "ja")] = ""; }).errors.join("\n"), /ja: DesktopScreenshot8 has no caption/);
  assert.match(set((t) => { row(t, "Description")[col(t, "ja")] = "Count line\n(120 characters)"; }).errors.join("\n"), /ja: Description, line 2: a count or note line/);
  assert.match(set((t) => { row(t, "Feature1")[col(t, "de")] = "a" + String.fromCharCode(10) + "b"; }).errors.join(" "), /de: Feature1 must be one line/);
  assert.match(set((t) => { ovr(t, "StoreLogoOverride71x71", "de", ""); }).errors.join(" "), /de: OverrideLogosForWin10 is True but 1 of the 2 small tiles/);
  assert.match(set((t) => { ovr(t, "OverrideLogosForWin10", "de", "False"); }).warnings.join(" "), /de: the two small tiles are given but OverrideLogosForWin10 is "False"/);
  assert.match(set((t) => { ovr(t, "PromoImage1920x1080", "de", "heylook-listing-109/logos/store-tile-71x71.png"); }).errors.join(" "), /de: PromoImage1920x1080: .*71x71, PromoImage1920x1080 \(hero art 16:9\) is exactly 1920x1080/);
  assert.match(set((t) => { ovr(t, "ShortTitle", "de", "s".repeat(51)); }).errors.join(" "), /de: ShortTitle is 51/);
  assert.ok(text().equals(orig));
  // two csv files, no csv, not a folder
  const second = path.join(out, "second.csv"); fs.writeFileSync(second, "x");
  assert.match(checkImportFolder(out).errors[0], /2 \.csv files/);
  fs.writeFileSync(second, "");
  const none = tmp("none");
  assert.match(checkImportFolder(none).errors[0], /0 \.csv files/);
  assert.match(checkImportFolder(path.join(none, "x")).errors[0], /not a folder/);
  fs.writeFileSync(path.join(none, "a.csv"), Buffer.from([0xff, 0xfe, 0x00]));
  assert.match(checkImportFolder(none).errors[0], /not valid UTF-8/);
});

// ---- the command line
check("command line: make, --check (exit codes), --rebase", () => {
  const b = base();
  const out = path.join(tmp("cli"), "heylook-listing-109");
  const run = (...args) => spawnSync(process.execPath, [path.join(HERE, "store-listing-csv.mjs"), ...args], { encoding: "utf8" });
  const r = run("--md", b.md, "--images", b.images, "--logos", b.logos, "--out", out, "--template", FIXTURE, "--dev-studio", "Noamo, thnonl", "--short-title", "Hey Look!");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /root folder name "heylook-listing-109", BOM yes, rows end with CRLF/);
  assert.match(r.stdout, /check of the result ok/);
  assert.match(r.stdout, /the option wins: "Noamo, thnonl"/);
  assert.match(r.stdout, /report: en-us\s+Description/);
  assert.equal(cellsOf(path.join(out, CSV_NAME)).get("DevStudio", "vi"), "Noamo, thnonl");
  const c = run("--check", out, "--template", FIXTURE);
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.match(c.stdout, /0 error\(s\), 0 warning\(s\): ok/);
  const moved = path.join(path.dirname(out), "renamed");
  fs.cpSync(out, moved, { recursive: true });
  const c2 = run("--check", moved);
  assert.equal(c2.status, 1);
  assert.match(c2.stderr, /root folder name "renamed\/"/);
  assert.equal(run("--rebase", moved).status, 0);
  assert.equal(run("--check", moved).status, 0);
  const bad = run("--md", b.md, "--images", path.join(b.images, "nope"), "--out", path.join(tmp("cli"), "x"), "--template", FIXTURE);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /nothing was written/);
  assert.equal(run("--md", b.md).status, 2, "usage");
  assert.equal(run("--bogus").status, 2);
});

console.log(`test-store-listing-csv: ${n} checks passed`);
