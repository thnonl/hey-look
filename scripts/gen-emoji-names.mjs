#!/usr/bin/env node
// Writes src/editor/emojiNames/<lang>.json: for each of the 256 emoji of EMOJI_GROUPS (src/editor/emojiData.ts) its short name and its keywords in the 8 app
// languages, from the Unicode CLDR annotations (the data Windows, macOS and Outlook use for their emoji names). The result is committed; nothing here is a runtime
// dependency, and the names are fetched lazily with the emoji picker (insertUi.tsx), never part of the main bundle.
//
// Source: the `cldr-json` packages `cldr-annotations-full` and `cldr-annotations-derived-full`, pinned to PINNED below (Unicode License v3,
// https://www.unicode.org/license.txt). They are NOT dependencies of this repository: install them in a scratch folder and point the script at it:
//     mkdir /tmp/cldr && cd /tmp/cldr && npm init -y && npm install --save-exact cldr-annotations-full@48.2.0 cldr-annotations-derived-full@48.2.0
//     node scripts/gen-emoji-names.mjs --from=/tmp/cldr/node_modules
// `--check` only verifies that the committed files are what the source would give (no write). The script refuses another CLDR version than the pinned one.
//
// File format (one per language, `en vi fr zh-Hans es ja de ru`; CLDR's `zh` is Simplified Chinese):
//   { "_license": "...", "_source": "CLDR 48.2.0 annotations (en)", "names": { "<emoji as in EMOJI_GROUPS>": ["short name", "keyword", ...] } }
// The first entry is the short name (CLDR's `tts`), the others are the search keywords (CLDR's `default`), the name itself not repeated.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED = "48.2.0";
// app language -> CLDR locale folder
const LANGS = { en: "en", vi: "vi", fr: "fr", "zh-Hans": "zh", es: "es", ja: "ja", de: "de", ru: "ru" };
const LICENSE = "Unicode License v3 (https://www.unicode.org/license.txt). Copyright (c) 1991-2026 Unicode, Inc. Names and keywords are from the Unicode CLDR annotations; they are used here as data and are not modified.";

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const from = arg("from");
const check = process.argv.includes("--check");
if (!from) {
  console.error("gen-emoji-names: pass --from=<folder with node_modules/cldr-annotations-full and node_modules/cldr-annotations-derived-full> (see the header of this file)");
  process.exit(2);
}
const base = fs.existsSync(path.join(from, "cldr-annotations-full")) ? from : path.join(from, "node_modules");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
for (const pkg of ["cldr-annotations-full", "cldr-annotations-derived-full"]) {
  const v = readJson(path.join(base, pkg, "package.json")).version;
  if (v !== PINNED) { console.error(`gen-emoji-names: ${pkg} is ${v}, the pinned CLDR release is ${PINNED}`); process.exit(2); }
}

// the 256 emoji (the list of emojiData.ts, read as a module: it has no imports)
const { EMOJI_GROUPS } = await import(pathToFileURL(path.join(ROOT, "src/editor/emojiData.ts")).href);
const all = EMOJI_GROUPS.flatMap((g) => [...g.emoji]);
const strip = (e) => e.replace(/️/g, "");

let bad = 0;
for (const [lang, folder] of Object.entries(LANGS)) {
  const main = readJson(path.join(base, "cldr-annotations-full/annotations", folder, "annotations.json")).annotations.annotations;
  const derived = readJson(path.join(base, "cldr-annotations-derived-full/annotationsDerived", folder, "annotations.json")).annotationsDerived.annotations;
  const names = {};
  for (const e of all) {
    // CLDR writes most emoji without the variation selector U+FE0F
    const a = main[e] ?? main[strip(e)] ?? derived[e] ?? derived[strip(e)];
    const tts = a?.tts?.[0];
    if (!a || !tts) { console.error(`gen-emoji-names: ${lang}: no name for ${e} (U+${[...e].map((c) => c.codePointAt(0).toString(16).toUpperCase()).join(" U+")})`); bad++; continue; }
    const kw = (a.default ?? []).filter((k) => k !== tts);
    names[e] = [tts, ...kw];
  }
  // one emoji per line (readable diffs, small files)
  const lines = Object.entries(names).map(([e, v]) => ` ${JSON.stringify(e)}: ${JSON.stringify(v)}`).join(",\n");
  const text = `{\n "_license": ${JSON.stringify(LICENSE)},\n "_source": ${JSON.stringify(`CLDR ${PINNED} annotations (${folder})`)},\n "names": {\n${lines.replace(/^ /gm, "  ")}\n }\n}\n`;
  const file = path.join(ROOT, "src/editor/emojiNames", `${lang}.json`);
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) { console.error(`gen-emoji-names: ${lang}.json differs from the source`); bad++; }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`${lang}: ${Object.keys(names).length} emoji, ${Math.round(text.length / 1024)} KB`);
  }
}
process.exit(bad ? 1 : 0);
