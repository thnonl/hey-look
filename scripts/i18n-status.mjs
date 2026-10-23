// How much of each language is translated: per language, the keys whose text is still the English placeholder (a stub) against the keys
// that are translated, plus the ones that are the same as English on purpose.
//
//   node --experimental-strip-types scripts/i18n-status.mjs [--lang=ru] [--list] [--areas] [--strict]
//
//   --lang=<code>  only that language          --list   print the keys that are still English
//   --areas        break each language down by area (the first part of the key)
//   --strict       exit 1 when any language other than English still has an English placeholder or a "STUB" header
//                  (for the release: every shipped language must be fully translated)
//
// A text is "same as English on purpose" when English itself would not change: only product / protocol names ("Hey Look!", "IMAP",
// "OpenPGP"), numbers, punctuation, placeholders, keyboard names (see KEEP_WORDS in scripts/lib/i18n-dicts.mjs), or when the key is listed in
// src/i18n/locales/<code>/keep.json (a JSON array of keys, for the odd word that really is the same, e.g. "Menu" in German).
// The test (scripts/test-i18n.mjs) stays green while stubs exist: this script reports them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { en } from "../src/i18n/en.ts";
import { BUILTIN, LANGUAGES, formsOf, keepList, loadDicts, mayStayEnglish, root, sameAsEnglish } from "./lib/i18n-dicts.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--lang="))?.slice(7);
const strict = args.includes("--strict");
const list = args.includes("--list");
const areas = args.includes("--areas");

const dicts = await loadDicts();
const targets = LANGUAGES.filter((l) => l.code !== "en" && (!only || l.code === only));
if (only && !targets.length) {
  console.error(`unknown language "${only}" (registry: ${LANGUAGES.map((l) => l.code).join(", ")})`);
  process.exit(2);
}
const keys = Object.keys(en);
const rows = [];
let anyStub = false;
for (const l of targets) {
  const d = dicts[l.code];
  if (!d) { console.error(`${l.code}: no dictionary`); process.exit(2); }
  const keep = keepList(l.code);
  const stub = [];
  let translated = 0;
  let allowed = 0;
  const byArea = new Map();
  for (const k of keys) {
    const area = k.split(".")[0];
    const a = byArea.get(area) ?? { total: 0, stub: 0 };
    a.total++;
    byArea.set(area, a);
    const v = d[k];
    if (v === undefined || formsOf(v).every((s) => !s.trim())) { stub.push(k); a.stub++; continue; }
    if (!sameAsEnglish(v, en[k])) { translated++; continue; }
    if (keep.has(k) || formsOf(en[k]).every(mayStayEnglish)) { allowed++; continue; }
    stub.push(k);
    a.stub++;
  }
  // a locale file that still carries the STUB header (the translator removes it when the file is done)
  const stubFiles = l.code === "en" ? [] : readdirSync(join(root, "src/i18n/locales", l.code)).filter((f) => f.endsWith(".ts") && f !== "index.ts" && readFileSync(join(root, "src/i18n/locales", l.code, f), "utf8").startsWith("// STUB:"));
  const rsFile = join(root, "src-tauri/src/i18n", `${l.code.toLowerCase().replace(/-/g, "_")}.rs`);
  const stubRust = !BUILTIN.includes(l.code) && existsSync(rsFile) && /STUB: English placeholders/.test(readFileSync(rsFile, "utf8"));
  if (stub.length || stubFiles.length || stubRust) anyStub = true;
  rows.push({ l, translated, allowed, stub, stubFiles, stubRust, byArea });
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`${keys.length} keys in English\n`);
console.log(`${pad("language", 26)}${num("translated", 11)}${num("same on purpose", 17)}${num("still English", 15)}${num("done", 7)}  files with STUB header`);
for (const r of rows) {
  const done = Math.round(((r.translated + r.allowed) / keys.length) * 100);
  const extra = r.stubFiles.length || r.stubRust ? `${r.stubFiles.length} ts${r.stubRust ? " + rust" : ""}` : "-";
  console.log(`${pad(`${r.l.code} ${r.l.englishName}`, 26)}${num(r.translated, 11)}${num(r.allowed, 17)}${num(r.stub.length, 15)}${num(`${done}%`, 7)}  ${extra}`);
}
if (areas) {
  for (const r of rows) {
    console.log(`\n${r.l.code} by area (still English / keys)`);
    console.log([...r.byArea].map(([a, x]) => `  ${pad(a, 10)}${num(x.stub, 5)} / ${x.total}`).join("\n"));
  }
}
if (list) {
  for (const r of rows) {
    if (!r.stub.length) continue;
    console.log(`\n${r.l.code}: ${r.stub.length} key(s) still English`);
    for (const k of r.stub) console.log(`  ${k}`);
  }
}
if (strict && anyStub) {
  console.error("\nstrict: some language is not fully translated (placeholders or STUB headers left)");
  process.exit(1);
}
