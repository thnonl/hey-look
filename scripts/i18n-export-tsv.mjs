// Export the texts of one language as review sheets: TSV files of key / English / translation, in chunks of about 12 KB, for a proof-read
// by a person or a model (Gemini, Codex ...) that can take a limited amount of text at a time.
//
//   node --experimental-strip-types scripts/i18n-export-tsv.mjs <code> <target-dir> [--bytes=12000 | --chunk-chars=40000] [--untranslated] [--prefix=chunk] [--index]
//
//   <code>           a language of src/i18n/languages.ts (vi, fr, zh-Hans, ...)
//   <target-dir>     created if needed; files <code>-01.tsv, <code>-02.tsv ... are written there (put it outside the repository)
//   --bytes=N        size limit per file in bytes of UTF-8 (default 12000); a file never splits a row
//   --chunk-chars=N  size limit per file in characters (code points) instead of bytes, for a reviewer with a limit in characters
//   --prefix=NAME    files are NAME-01.tsv ... (default: the language code; the site review sheets use "chunk")
//   --index          also write index.json: language, limits, row counts and, per file, its rows, characters and first and last key
//   --untranslated   only the rows that are still the English placeholder (what a translator has left)
//
// One row per key, in dictionary order. In a cell a tab is written \t and a line break \n; a no-break space is <nbsp> (so a reviewer sees
// it); a plural shows its forms as "one: ... || few: ... || other: ...". Every file starts with the header row key<TAB>English<TAB>translation.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { en } from "../src/i18n/en.ts";
import { LANGUAGES, formsOf, keepList, loadDicts, mayStayEnglish, sameAsEnglish } from "./lib/i18n-dicts.mjs";

const args = process.argv.slice(2);
const [code, dir] = args.filter((a) => !a.startsWith("--"));
const charsArg = args.find((a) => a.startsWith("--chunk-chars="))?.slice(14);
const byChars = charsArg !== undefined;
const limit = Number(charsArg ?? args.find((a) => a.startsWith("--bytes="))?.slice(8) ?? 12000);
const size = (s) => (byChars ? [...s].length : Buffer.byteLength(s)); // the size of a text in the unit of the limit
const prefix = args.find((a) => a.startsWith("--prefix="))?.slice(9) ?? code;
const onlyOpen = args.includes("--untranslated");
if (!code || !dir || !Number.isFinite(limit) || limit < 500 || !/^[\w.-]+$/.test(prefix)) {
  console.error("usage: node --experimental-strip-types scripts/i18n-export-tsv.mjs <code> <target-dir> [--bytes=12000 | --chunk-chars=40000] [--untranslated] [--prefix=chunk] [--index]");
  process.exit(2);
}
if (!LANGUAGES.some((l) => l.code === code)) {
  console.error(`unknown language "${code}" (registry: ${LANGUAGES.map((l) => l.code).join(", ")})`);
  process.exit(2);
}
const dicts = await loadDicts();
const d = dicts[code];

// (the two characters in brackets below are U+00A0 no-break space and U+202F narrow no-break space)
const cell = (s) => s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n").replace(/[ ]/g, "<nbsp>").replace(/[ ]/g, "<nnbsp>");
const show = (m) => (typeof m === "string" ? cell(m) : Object.entries(m).map(([c, s]) => `${c}: ${cell(s)}`).join(" || "));
const keep = keepList(code);

const header = "key\tEnglish\ttranslation\n";
const files = [];
const info = []; // per file: rows, first and last key
let cur = header;
let rows = 0;
let curInfo = { rows: 0, first: "", last: "" };
for (const k of Object.keys(en)) {
  const v = d[k];
  if (onlyOpen && (keep.has(k) || formsOf(en[k]).every(mayStayEnglish) || (v !== undefined && !sameAsEnglish(v, en[k])))) continue;
  const row = `${k}\t${show(en[k])}\t${v === undefined ? "" : show(v)}\n`;
  if (size(cur + row) > limit && cur !== header) {
    files.push(cur);
    info.push(curInfo);
    cur = header;
    curInfo = { rows: 0, first: "", last: "" };
  }
  cur += row;
  rows++;
  curInfo.rows++;
  curInfo.first ||= k;
  curInfo.last = k;
}
if (cur !== header) {
  files.push(cur);
  info.push(curInfo);
}

const out = resolve(dir);
mkdirSync(out, { recursive: true });
const width = Math.max(2, String(files.length).length);
const names = files.map((_, i) => `${prefix}-${String(i + 1).padStart(width, "0")}.tsv`);
files.forEach((text, i) => writeFileSync(join(out, names[i]), text, "utf8"));
if (args.includes("--index")) {
  const lang = LANGUAGES.find((l) => l.code === code);
  const index = {
    language: code,
    name: lang.englishName,
    nativeName: lang.nativeName,
    generatedAt: new Date().toISOString(),
    columns: ["key", "English", "translation"],
    limit: { unit: byChars ? "characters" : "bytes", value: limit },
    onlyUntranslated: onlyOpen,
    totalRows: rows,
    totalChunks: files.length,
    files: files.map((text, i) => ({ file: names[i], rows: info[i].rows, characters: [...text].length, bytes: Buffer.byteLength(text), firstKey: info[i].first, lastKey: info[i].last })),
  };
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
}
console.log(`${code}: ${rows} row(s) in ${files.length} file(s) of at most ${limit} ${byChars ? "characters" : "bytes"} -> ${out}`);
