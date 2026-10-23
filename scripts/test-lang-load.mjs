// Language on demand (WP9c): English is the only dictionary in the first JavaScript file; every other language is a chunk of its own
// (src/i18n/lang-<code>.ts: dictionary + date-fns locale) that loadLanguage / switchLanguage fetch.
//   1. nothing is loaded at start but English; setLangPref of a language that is not loaded throws (a test cannot silently run in English)
//   2. every language loads, and what the chunk holds is the dictionary of its folder (t() shows it)
//   3. a second switch while one is loading wins; the earlier one does nothing
//   (the order below: 1, 4, 5 first, while nothing but English and fr / de are loaded; then 2, 3, 6)
//   4. a chunk that cannot be loaded: one retry after 500 ms, then the promise rejects, the language in use stays, the next try fetches again
//   5. the saved language at start (bootLang.ts): loaded before the first sentence; a failure leaves English
//   6. the date-fns locale comes with the chunk; index.ts and format.ts import no other language statically
// Run: node --experimental-strip-types scripts/test-lang-load.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applySavedLanguage } from "../src/bootLang.ts";
import { en } from "../src/i18n/en.ts";
import { loadDicts } from "./lib/i18n-dicts.mjs";
import { dfLocale, fmtPattern } from "../src/i18n/format.ts";
import { getLang, isLoaded, isReady, loadAllLanguages, loadLanguage, loadedDateLocale, setLangPref, switchLanguage, t, LANGUAGES } from "../src/i18n/index.ts";

const read = (f) => readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8");
const DICT = await loadDicts(); // (read from the folders of the languages, not through src/i18n/index.ts)
const others = LANGUAGES.map((l) => l.code).filter((c) => c !== "en");

// 1. at start only English is there
assert.equal(getLang(), "en");
for (const c of others) assert.equal(isLoaded(c), false, `${c} is not loaded at start`);
assert.equal(isLoaded("en"), true);
assert.equal(isReady("en-XA"), true, "the pseudo-locale needs no chunk");
for (const c of others) {
  assert.throws(() => setLangPref(c), /not loaded/, `setLangPref(${c}) before its chunk is loaded throws in node`);
  assert.equal(getLang(), "en", "and the language in use stays");
}
assert.equal(t("common.cancel"), en["common.cancel"]);

// 4. failure (before anything else is loaded): one retry after 500 ms, then the promise rejects, the language in use stays, the failure is not remembered
{
  globalThis.__heylookLangFail = ["fr", "ja"];
  const t0 = Date.now();
  await assert.rejects(switchLanguage("fr"), /could not be loaded/);
  const took = Date.now() - t0;
  assert.ok(took >= 450 && took < 5000, `one retry after 500 ms, then the error (${took} ms)`);
  assert.equal(getLang(), "en", "the language in use stays");
  assert.equal(isLoaded("fr"), false);
  assert.equal(t("common.cancel"), en["common.cancel"], "the texts stay English");
  globalThis.__heylookLangFail = [];
  assert.equal(await switchLanguage("fr"), true, "the next try fetches again");
  assert.equal(getLang(), "fr");
  setLangPref("en");

  // 5. the saved language at start (bootLang.ts): a chunk that cannot be fetched leaves English and throws nothing
  globalThis.__heylookLangFail = ["ja"];
  await applySavedLanguage(async () => JSON.stringify({ language: "ja" }));
  assert.equal(getLang(), "en");
  assert.equal(isLoaded("ja"), false);
  globalThis.__heylookLangFail = [];
  // and when it can: the language is in use after the await, before the first sentence
  await applySavedLanguage(async () => JSON.stringify({ language: "de" }));
  assert.equal(getLang(), "de");
  assert.equal(isLoaded("de"), true);
  setLangPref("en");
}

// 2. every language loads; the chunk holds the dictionary of its folder
await loadAllLanguages();
for (const c of others) assert.equal(isLoaded(c), true, `${c} loaded`);
for (const l of LANGUAGES) {
  const code = l.code;
  const dict = code === "en" ? en : (await import(`../src/i18n/lang-${code}.ts`)).default.dict;
  const want = DICT[code];
  assert.deepEqual(Object.keys(dict).sort(), Object.keys(en).sort(), `${code}: the same keys as English`);
  assert.deepEqual(dict, want, `${code}: the chunk holds the dictionary of src/i18n/locales/${code}`);
  // and what t() shows (plain strings, no parameters)
  setLangPref(code);
  for (const k of Object.keys(want)) if (typeof want[k] === "string" && !/\{\w+\}/.test(want[k])) assert.equal(t(k), want[k], `${code}: t(${k})`);
}
setLangPref("en");

// 3. a second switch while one is loading wins (the languages are loaded here already: the order of the calls is what counts)
{
  setLangPref("en");
  const a = switchLanguage("de");
  const b = switchLanguage("ja");
  assert.deepEqual(await Promise.all([a, b]), [false, true], "the earlier switch is dropped, the last choice applied");
  assert.equal(getLang(), "ja");
  const c = switchLanguage("fr");
  setLangPref("ru"); // a direct setLangPref while a switch is waiting is a newer choice as well
  assert.equal(await c, false);
  assert.equal(getLang(), "ru");
  assert.equal(await switchLanguage("en"), true);
  assert.equal(getLang(), "en");
}

// 6. the date-fns locale comes with the chunk of its language
for (const c of others) assert.ok(loadedDateLocale(c)?.code, `${c}: a date-fns locale came with the chunk`);
assert.equal(loadedDateLocale("en"), undefined, "English uses en-US from the first file");
setLangPref("de");
assert.equal(dfLocale().code, "de");
assert.equal(fmtPattern(new Date(2026, 9, 5), "MMMM"), "Oktober");
setLangPref("ja");
assert.equal(dfLocale().code, "ja");
setLangPref("en");
assert.equal(dfLocale().code, "en-US");
{
  // the first file imports no language but English (source check; the bundle budget checks the built result)
  const idx = read("src/i18n/index.ts").replace(/\/\/.*$/gm, "");
  const stat = [...idx.matchAll(/^import .*?from "([^"]+)";/gm)].map((m) => m[1]);
  assert.ok(!stat.some((s) => /locales|lang-/.test(s)), `index.ts imports a language statically: ${stat.join(", ")}`);
  const fmt = [...read("src/i18n/format.ts").matchAll(/^import .*?from "([^"]+)";/gm)].map((m) => m[1]).filter((s) => s.startsWith("date-fns/locale"));
  assert.deepEqual(fmt, ["date-fns/locale/en-US"], "format.ts imports en-US only; every other date-fns locale comes with its language chunk");
  for (const c of others) assert.ok(idx.includes(`import("./lang-${c}.ts")`), `LOADERS has ${c}`);
}
console.log("ok - test-lang-load");
