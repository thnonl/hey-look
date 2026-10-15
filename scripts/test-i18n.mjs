// Translations: (1) every language of the registry has the same keys, the same {placeholders} and the plural forms it needs, no key is defined twice,
// no key is unused or missing in the source; (2) a lint for new hard-coded English in the UI code.
// Run: node --experimental-strip-types scripts/test-i18n.mjs [--lint-only] [--list]
// (Texts that are still English placeholders are not an error here: scripts/i18n-status.mjs reports them, and fails on them with --strict.)
//   --list  prints every finding of the lint instead of stopping at the first lines (default prints all, capped at 60)
// A deliberate exception in the code carries a comment `// i18n-ok: why` on the same line or the line above (JSX: `{/* i18n-ok: why */}`).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { en } from "../src/i18n/en.ts";
import { pickPlural, pseudoize, resolveLang, t, setLangPref, getLang, LANGS } from "../src/i18n/index.ts";
import { INLINE, LANGUAGES, formsOf, ident, loadDicts, placeholdersOf, rustMod, textOf } from "./lib/i18n-dicts.mjs";
import { backendText, parseCoded } from "../src/backendErrors.ts";
import { BACKEND_ERRORS } from "../src/calendarSync.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
const failures = [];
const fail = (m) => failures.push(m);

// ------------------------------------------------------------------------------------------------ 0. the language registry
// src/i18n/languages.ts is the one list every control and check reads. English, Vietnamese and French keep their texts inside
// src/i18n/ns/*.ts (gathered by en.ts / vi.ts / fr.ts); every other language has its own folder src/i18n/locales/<code>/ (one file per
// area, typed with defineLocale, gathered by its index.ts) and its own Rust file src-tauri/src/i18n/<code>.rs. Every registry entry needs
// all of that, every folder needs an entry, and the Rust side must know the same codes.
// (A language missing from DICTS in index.ts or DF in format.ts fails `tsc`: both are Record<Lang, ...>.)
const codes = LANGUAGES.map((l) => l.code);
const dicts = await loadDicts();
const ALL_FORMS = ["zero", "one", "two", "few", "many", "other"];
const NS_FILES = readdirSync(join(root, "src/i18n/ns")).filter((x) => x.endsWith(".ts")).map((x) => x.replace(/\.ts$/, "")).sort();
{
  assert.equal(codes[0], "en", "English is the first entry (default and fallback)");
  assert.equal(LANGUAGES[0].sortOrder, Math.min(...LANGUAGES.map((l) => l.sortOrder)), "English comes first in the menus");
  assert.equal(new Set(codes).size, codes.length, "language codes are unique");
  assert.equal(new Set(LANGUAGES.map((l) => l.sortOrder)).size, codes.length, "sortOrder values are unique");
  assert.deepEqual(LANGS.map((l) => l.code), [...LANGUAGES].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.code), "LANGS (what the controls list) is the registry in sortOrder");
  assert.deepEqual(INLINE, ["en", "vi", "fr"], "the three languages that sit inside ns/*.ts");
  for (const l of LANGUAGES) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(l.code)) fail(`registry: bad code ${l.code}`);
    if (!l.nativeName.trim() || !l.englishName.trim()) fail(`registry ${l.code}: nativeName and englishName are required`);
    if (!l.short?.trim() || l.short.length > 3) fail(`registry ${l.code}: short (the label of the header button) is required, at most 3 characters`);
    if (l.dir !== "ltr" && l.dir !== "rtl") fail(`registry ${l.code}: dir must be ltr or rtl`);
    if (!Number.isFinite(l.sortOrder)) fail(`registry ${l.code}: sortOrder must be a number`);
    try { Intl.getCanonicalLocales(l.code); Intl.getCanonicalLocales(l.intl); } catch { fail(`registry ${l.code}: code ${l.code} or intl ${l.intl} is not a valid BCP 47 tag`); }
    // plural forms: includes "other", only real categories, and every category the language can pick for a whole number
    if (!Array.isArray(l.plural) || !l.plural.includes("other") || l.plural.some((c) => !ALL_FORMS.includes(c))) fail(`registry ${l.code}: plural must list CLDR categories and include "other"`);
    else {
      const pr = new Intl.PluralRules(l.intl);
      const used = new Set(Array.from({ length: 201 }, (_, i) => pr.select(i)));
      for (const c of used) if (!l.plural.includes(c)) fail(`registry ${l.code}: plural lacks "${c}" (Intl.PluralRules(${l.intl}) picks it for a whole number)`);
      if (!INLINE.includes(l.code)) for (const c of l.plural) if (!pr.resolvedOptions().pluralCategories.includes(c)) fail(`registry ${l.code}: plural lists "${c}", which ${l.intl} never uses`);
    }
    if (l.fmt?.weekdayShort && !/^E{1,6}$/.test(l.fmt.weekdayShort)) fail(`registry ${l.code}: fmt.weekdayShort must be a date-fns weekday token (E..EEEEEE)`);
    if (l.fmt?.weekdayText && !/^E{1,6}$/.test(l.fmt.weekdayText)) fail(`registry ${l.code}: fmt.weekdayText must be a date-fns weekday token (E..EEEEEE)`);
    if (l.fmt?.dayRange && !(l.fmt.dayRange.sep && ["sameMonth", "sameYear", "otherYear"].every((k) => l.fmt.dayRange[k]?.length === 2 && l.fmt.dayRange[k].every(Boolean)))) fail(`registry ${l.code}: fmt.dayRange needs sep and two patterns each for sameMonth, sameYear and otherYear`);
    for (const [from, to] of Object.entries(l.fmt?.patterns ?? {})) if (!from || !to) fail(`registry ${l.code}: fmt.patterns "${from}" -> "${to}" is empty`);
    if (!dicts[l.code]) fail(`registry ${l.code}: no dictionary (${INLINE.includes(l.code) ? `src/i18n/${l.code}.ts` : `src/i18n/locales/${l.code}/index.ts`} exporting ${ident(l.code)})`);
  }
  // a dictionary without a registry entry
  for (const f of readdirSync(join(root, "src/i18n")).filter((x) => /^[a-z]{2,3}(-[A-Za-z0-9]+)?\.ts$/.test(x))) {
    const c = f.replace(/\.ts$/, "");
    if (!codes.includes(c)) fail(`src/i18n/${f} is a dictionary but its language is not in src/i18n/languages.ts`);
    else if (!INLINE.includes(c)) fail(`src/i18n/${f}: ${c} has its own folder src/i18n/locales/${c}/, not a file here`);
  }
  // the ns files hold English, Vietnamese and French only
  for (const f of NS_FILES) {
    const mod = await import(new URL(`../src/i18n/ns/${f}.ts`, import.meta.url));
    const have = Object.keys(mod.default).sort().join();
    if (have !== [...INLINE].sort().join()) fail(`ns/${f}.ts has the languages {${have}}; it holds {${[...INLINE].sort().join()}} only (other languages: src/i18n/locales/<code>/${f}.ts)`);
  }
  // the folder of every other language: one file per area (typed against English), an index that gathers them, a keep list
  const localesDir = join(root, "src/i18n/locales");
  const folders = existsSync(localesDir) ? readdirSync(localesDir).filter((x) => statSync(join(localesDir, x)).isDirectory()) : [];
  for (const d of folders) if (!codes.includes(d) || INLINE.includes(d)) fail(`src/i18n/locales/${d}/ is not a language of the registry (or is one of en / vi / fr)`);
  for (const l of LANGUAGES.filter((x) => !INLINE.includes(x.code))) {
    const dir = join(localesDir, l.code);
    if (!existsSync(dir)) { fail(`registry ${l.code}: no folder src/i18n/locales/${l.code}/ (node --experimental-strip-types scripts/i18n-new-language.mjs ${l.code})`); continue; }
    const files = readdirSync(dir).sort();
    const want = [...NS_FILES.map((n) => `${n}.ts`), "index.ts", "keep.json"].sort();
    if (files.join() !== want.join()) fail(`locales/${l.code}/ has {${files}} but needs {${want}} (one file per area in ns/, index.ts, keep.json; new area: scripts/i18n-new-language.mjs ${l.code} --sync)`);
    const idx = readFileSync(join(dir, "index.ts"), "utf8");
    for (const n of NS_FILES) {
      if (!new RegExp(`import ${n} from "\\./${n}\\.ts";`).test(idx) || !new RegExp(`\\.\\.\\.${n},`).test(idx)) fail(`locales/${l.code}/index.ts does not gather ${n}.ts`);
      const src = existsSync(join(dir, `${n}.ts`)) ? readFileSync(join(dir, `${n}.ts`), "utf8") : "";
      if (src && !(src.includes(`import type ns from "../../ns/${n}.ts";`) && src.includes("defineLocale<typeof ns.en>("))) fail(`locales/${l.code}/${n}.ts must be typed: import type ns from "../../ns/${n}.ts"; export default defineLocale<typeof ns.en>({ ... })`);
    }
    try { if (!Array.isArray(JSON.parse(readFileSync(join(dir, "keep.json"), "utf8")))) fail(`locales/${l.code}/keep.json must be a JSON array of keys`); } catch { fail(`locales/${l.code}/keep.json is not valid JSON`); }
  }
  // Rust (tray menu, notifications): the same codes in parse(), one Lang variant per language, one module file per later language
  const rs = readFileSync(join(root, "src-tauri/src/i18n.rs"), "utf8");
  const parseBody = rs.match(/pub fn parse\(code: &str\) -> Lang \{[\s\S]*?\n\}/)?.[0] ?? "";
  const rustCodes = [...parseBody.matchAll(/"([a-z]+)"(?: if [^\n]*?)? => Lang::/g)].map((m) => m[1]);
  const wantRust = [...new Set(codes.filter((c) => c !== "en").map((c) => c.split("-")[0].toLowerCase()))];
  if ([...rustCodes].sort().join() !== [...wantRust].sort().join()) fail(`src-tauri/src/i18n.rs parse() maps {${rustCodes}} but the registry (minus en, the fallback) has {${wantRust}} (language part, lower case)`);
  const variants = (rs.match(/pub enum Lang \{([\s\S]*?)\}/)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (variants.length !== codes.length) fail("src-tauri/src/i18n.rs: needs one Lang variant per registry language");
  if (rs.match(/pub const LANGS: \[Lang; (\d+)\]/)?.[1] !== String(codes.length)) fail(`src-tauri/src/i18n.rs: LANGS must list all ${codes.length} languages in registry order`);
  for (const l of LANGUAGES.filter((x) => !INLINE.includes(x.code))) {
    const m = rustMod(l.code);
    if (!existsSync(join(root, `src-tauri/src/i18n/${m}.rs`))) fail(`registry ${l.code}: no src-tauri/src/i18n/${m}.rs`);
    if (!new RegExp(`^mod ${m};`, "m").test(rs)) fail(`src-tauri/src/i18n.rs: no "mod ${m};"`);
  }
  // the pieces of the interface that must name no language
  const SOURCES = ["src/calendar.ts", "src/util.ts", "src/store.ts", "src/App.tsx"].map((f) => [f, readFileSync(join(root, f), "utf8").replace(/\/\/.*$/gm, "")]);
  for (const [f, code] of SOURCES) if (/getLang\(\)\s*[!=]==?\s*["']/.test(code) || /lang\s*===\s*["'](?:vi|fr|ja|zh|ru|de|es)["']/.test(code)) fail(`${f}: compares a language code; put the decision in the registry (languages.ts)`);
}

// ------------------------------------------------------------------------------------------------ 1. dictionaries
const NS_DIR = join(root, "src/i18n/ns");
const OTHERS = Object.entries(dicts).filter(([c]) => c !== "en");
const requiredForms = (name) => LANGUAGES.find((l) => l.code === name).plural;
if (!args.has("--lint-only")) {
  const placeholders = (m) => formsOf(m).map((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(","));
  const phOf = (m) => placeholdersOf(m).join(",");
  const text = textOf;

  // no key in two dictionaries (a spread would silently let one win)
  const seen = new Map();
  for (const f of readdirSync(NS_DIR).filter((x) => x.endsWith(".ts"))) {
    const mod = await import(new URL(`../src/i18n/ns/${f}`, import.meta.url));
    for (const k of Object.keys(mod.default.en)) {
      if (seen.has(k)) fail(`key ${k} is defined in ${seen.get(k)} and in ${f}`);
      seen.set(k, f);
    }
  }

  for (const [name, dict] of OTHERS) {
    for (const k of Object.keys(en)) if (!(k in dict)) fail(`${name}: missing key ${k}`);
    for (const k of Object.keys(dict)) if (!(k in en)) fail(`${name}: key ${k} is not in en`);
  }
  for (const [k, m] of Object.entries(en)) {
    if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_-]+)+$/.test(k)) fail(`key name ${k}: use area.name (letters, digits, dots)`);
    if (!text(m).trim()) fail(`en: ${k} is empty`);
    const want = phOf(m);
    const plural = typeof m !== "string";
    if (plural && !/\{n\}/.test(m.other)) fail(`en: plural ${k} has no {n}`);
    if (plural && Object.keys(m).sort().join() !== "one,other") fail(`en: plural ${k} must have exactly the forms one and other`);
    for (const [name, dict] of OTHERS) {
      const v = dict[k];
      if (v === undefined) continue;
      if (!formsOf(v).every((s) => s.trim())) fail(`${name}: ${k} is empty`);
      if (phOf(v) !== want) fail(`${name}: ${k} placeholders {${phOf(v)}} differ from en {${want}}`);
      const req = requiredForms(name);
      if (typeof v !== "string") {
        // a plural: the forms the language needs (registry `plural`), no unknown category, and the same placeholders in each form
        if (!plural) fail(`${name}: ${k} is a plural but en is not`);
        else {
          for (const c of Object.keys(v)) if (!ALL_FORMS.includes(c)) fail(`${name}: ${k} has an unknown plural form "${c}"`);
          if (!INLINE.includes(name)) {
            for (const c of req) if (typeof v[c] !== "string") fail(`${name}: plural ${k} lacks the "${c}" form (needs ${req.join(", ")})`);
         for (const c of Object.keys(v)) if (!req.includes(c) && c !== "other") fail(`${name}: plural ${k} has the form "${c}", which ${name} never uses (needs ${req.join(", ")})`);
          }
          // a form may leave out {n} ("one" = "1 message"), anything else must match across the forms (Vietnamese is written with one text for both)
          const sets = placeholders(v).map((s) => s.split(",").filter((x) => x && x !== "n").join(","));
          if (name !== "vi" && new Set(sets).size > 1) fail(`${name}: ${k} plural forms use different placeholders`);
        }
      } else if (plural && !INLINE.includes(name) && !(req.length === 1 && req[0] === "other")) {
        fail(`${name}: ${k} is a plain string but ${name} needs the plural forms ${req.join(", ")}`);
      }
      // French typography: a no-break space (not a plain one) before : ; ! ? » and after «
      if (name === "fr" && (/[^\s  ] [:;!?»]/.test(text(v)) || /« [^ ]/.test(text(v)))) fail(`fr: ${k} has a plain space before : ; ! ? » or after « (use \\u00a0)`);
      if (name === "vi" && /[ÀÂÊÔÇ]/.test(text(v)) && !/[ạảãấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹơưăđ]/i.test(text(v))) {
        fail(`vi: ${k} looks French: ${text(v)}`);
      }
    }
  }

  // keys used by the code exist; keys nobody uses are reported (they are dead translations)
  const used = new Set();
  const srcFiles = walk(join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(`${sep}i18n${sep}`) && !f.endsWith(".d.ts"));
  for (const f of srcFiles) {
    const code = readFileSync(f, "utf8");
    for (const m of code.matchAll(/["'`]((?:[a-z][a-zA-Z0-9]*)(?:\.[a-zA-Z0-9_-]+)+)["'`]/g)) if (m[1] in en) used.add(m[1]);
    // dynamic keys: t(`settings.sound.${id}`) marks the whole prefix as used
    for (const m of code.matchAll(/`((?:[a-z][a-zA-Z0-9]*)(?:\.[a-zA-Z0-9_-]+)*\.)\$\{/g)) for (const k of Object.keys(en)) if (k.startsWith(m[1])) used.add(k);
  }
  const unused = Object.keys(en).filter((k) => !used.has(k));
  if (unused.length) fail(`${unused.length} unused key(s), e.g. ${unused.slice(0, 8).join(", ")}${unused.length > 8 ? ", …" : ""}`);

  // ---- behaviour of t(): interpolation, plurals in each language, pseudo-locale
  assert.equal(getLang(), "en");
  // English is the default for everyone: an unset, unknown or outdated setting is English even when the browser / OS language is Vietnamese or French
  Object.defineProperty(globalThis, "navigator", { value: { language: "vi-VN", languages: ["vi-VN", "fr-FR"] }, configurable: true });
  for (const unset of [undefined, null, "", "system", "tlh", "vi-VN", "FR", "klingon"]) assert.equal(resolveLang(unset), "en", String(unset));
  setLangPref(undefined);
  assert.equal(getLang(), "en", "no setting: English, not the language of the computer");
  setLangPref("system");
  assert.equal(getLang(), "en", "the old 'System default' value is English now");
  assert.equal(resolveLang("vi"), "vi");
  assert.equal(resolveLang("fr"), "fr");
  assert.equal(resolveLang("en"), "en");
  assert.equal(resolveLang("en-XA"), "en", "the pseudo-locale is not a real language");
  // the default of the setting is English, an invalid stored value is mapped back to it, and the Language row offers no "System default"
  const prefsSrc = readFileSync(join(root, "src/prefs.ts"), "utf8");
  assert.ok(prefsSrc.includes('  language: "en",\n'), "the default language is English");
  assert.ok(prefsSrc.includes('language: isLang(p.language) || p.language === "en-XA" ? p.language : "en"'), "an invalid stored language is English");
  assert.ok(!/langSystem|System default/.test(readFileSync(join(root, "src/components/SettingsDialog.tsx"), "utf8")), "no System default option");
  assert.ok(!/navigator/.test(readFileSync(join(root, "src/i18n/index.ts"), "utf8").replace(/\/\/.*$/gm, "")), "the language of the computer is never read");
  assert.equal(pseudoize("Hi {name}!"), "[Ĥî {name}! ~~]");
  setLangPref("en-XA");
  assert.equal(getLang(), "en", "pseudo-locale is for dev builds only (not set here)");
  setLangPref("en");

  // ---- every language of the registry is selectable by its exact code and sets <html lang> to it (the CSS :lang() font stacks read it)
  const fakeDoc = { documentElement: { lang: "" } };
  Object.defineProperty(globalThis, "document", { value: fakeDoc, configurable: true });
  setLangPref("vi"); // (an unchanged language returns early: the first iteration, English, must be a change)
  for (const l of LANGUAGES) {
    assert.equal(resolveLang(l.code), l.code, `resolveLang(${l.code})`);
    setLangPref(l.code);
    assert.equal(getLang(), l.code);
    assert.equal(fakeDoc.documentElement.lang, l.code, `<html lang> for ${l.code}`);
    assert.equal(typeof t("common.ok"), "string");
  }
  for (const near of ["zh", "zh-CN", "zh-Hant", "ZH-HANS", "es-MX", "ja-JP", "de-DE", "ru-RU", "pt"]) assert.equal(resolveLang(near), "en", `${near} is not a stored value of the app`);
  setLangPref("en");
  delete globalThis.document;

  // ---- plural forms by language (Intl.PluralRules; a form a message lacks falls back to "other")
  {
    const m4 = { one: "one", few: "few", many: "many", other: "other" };
    const check = (lang, msg, cases) => { for (const [n, want] of cases) assert.equal(pickPlural(msg, n, lang), want, `${lang} n=${n}`); };
    check("ru", m4, [[0, "many"], [1, "one"], [2, "few"], [3, "few"], [4, "few"], [5, "many"], [11, "many"], [12, "many"], [14, "many"], [20, "many"], [21, "one"], [22, "few"], [25, "many"], [101, "one"], [111, "many"], [112, "many"], [122, "few"], [1.5, "other"]]);
    for (const lang of ["ja", "zh-Hans"]) check(lang, { other: "other" }, [[0, "other"], [1, "other"], [2, "other"], [5, "other"], [21, "other"]]);
    for (const lang of ["ja", "zh-Hans"]) check(lang, { one: "one", other: "other" }, [[1, "other"]]); // an unused "one" form is never picked
    for (const lang of ["en", "de", "es"]) check(lang, { one: "one", other: "other" }, [[0, "other"], [1, "one"], [2, "other"], [5, "other"], [21, "other"], [1000000, "other"]]);
    check("fr", { one: "one", other: "other" }, [[0, "one"], [1, "one"], [2, "other"], [1000000, "other"]]); // as before: 0 is singular, millions use "other"
    check("vi", { one: "one", other: "other" }, [[0, "other"], [1, "other"], [2, "other"]]); // Vietnamese has one form
    check("ru", { one: "one", other: "other" }, [[1, "one"], [2, "other"], [5, "other"]]); // a missing form is "other"
    assert.equal(pickPlural("plain", 5, "ru"), "plain");
    assert.equal(pickPlural({ one: "a", other: "b" }, Number.NaN, "en"), "a", "no count: singular, as before");
    // the registry lists the forms each language writes
    const forms = (c) => LANGUAGES.find((l) => l.code === c).plural.join();
    assert.equal(forms("ru"), "one,few,many,other");
    assert.equal(forms("ja"), "other");
    assert.equal(forms("zh-Hans"), "other");
    assert.equal(forms("de"), "one,other");
    assert.equal(forms("es"), "one,other");
    // t() resolves a plural of the active language
    setLangPref("ru");
    assert.equal(t("app.in.days", { n: 1 }), dicts.ru["app.in.days"].one.replace("{n}", "1"));
    assert.equal(t("app.in.days", { n: 5 }), dicts.ru["app.in.days"].many.replace("{n}", "5"));
    setLangPref("en");
    assert.equal(t("app.in.days", { n: 1 }), "in 1 day");
    assert.equal(t("app.in.days", { n: 2 }), "in 2 days");
  }

  // ---- dates: the patterns each language writes differently, the Intl locale, ranges (byte-identical for English, Vietnamese, French)
  {
    const fmt = await import("../src/i18n/format.ts");
    const used = ["EEE, d MMM yyyy", "EEE d MMM yyyy", "EEE d MMM", "d MMM yyyy", "d MMM", "MMM yyyy", "dd/MM/yyyy", "h:mm a", "HH:mm", "EEE", "LLLL", "yyyy", "dd/MM/yyyy h:mm a", "d MMM HH:mm", "EEEEEE, d MMM yyyy"];
    for (const code of ["en", "vi", "fr"]) for (const p of used) assert.equal(fmt.localizePattern(p, code), p, `${code} keeps the English pattern ${p}`);
    assert.equal(fmt.localizePattern("EEE, d MMM yyyy h:mm a", "ja"), "yyyy年M月d日(EEE) ah:mm");
    assert.equal(fmt.localizePattern("dd/MM/yyyy HH:mm", "de"), "dd.MM.yyyy HH:mm");
    assert.equal(fmt.localizePattern("d MMM", "zh-Hans"), "M月d日");
    const day = new Date(2026, 9, 5, 14, 5); // Monday 5 Oct 2026
    const at = (code, p) => { setLangPref(code); return fmt.fmtPattern(day, p); };
    assert.equal(at("en", "EEE, d MMM yyyy"), "Mon, 5 Oct 2026");
    assert.equal(at("zh-Hans", "d MMM yyyy"), "2026年10月5日");
    assert.equal(at("ja", "EEE, d MMM yyyy"), "2026年10月5日(月)");
    assert.equal(at("ja", "HH:mm"), "14:05");
    assert.equal(at("zh-Hans", "h:mm a"), "下午2:05");
    assert.equal(at("de", "d MMM yyyy"), "5. Okt. 2026");
    assert.equal(at("de", "dd/MM/yyyy"), "05.10.2026");
    assert.ok(/^5 окт\.? 2026/.test(at("ru", "d MMM yyyy")), at("ru", "d MMM yyyy"));
    assert.ok(/^5 oct/.test(at("es", "d MMM yyyy")), at("es", "d MMM yyyy"));
    assert.equal(at("ru", "dd/MM/yyyy"), "05.10.2026");
    for (const l of LANGUAGES) {
      setLangPref(l.code);
      assert.equal(typeof fmt.dateFormat(), "object");
      assert.ok(fmt.monthName(9).length > 0 && fmt.weekdayName(1).length > 0, `month and weekday names for ${l.code}`);
      assert.ok((1234567.5).toLocaleString(l.intl).length > 0);
      const r = fmt.fmtDayRange({ y: 2026, m: 10, d: 5 }, { y: 2026, m: 10, d: 11 }, "long");
      if (l.fmt?.intlRanges || l.fmt?.dayRange) assert.ok(r && r.includes("2026"), `range for ${l.code}: ${r}`); else assert.equal(r, null, `${l.code} keeps the classic range`);
      // every language names its weekday tokens (the calendar column and the dates in text) and the tokens are date-fns weekday tokens
      assert.ok(l.fmt?.weekdayShort && l.fmt?.weekdayText || ["en", "fr"].includes(l.code) || l.code === "vi", `registry ${l.code}: fmt.weekdayShort / weekdayText`);
    }
    // ---- week titles and day ranges: ja / zh write them with their own day characters, de / es / ru the way Intl does
    const D = (y, m, d) => ({ y, m, d });
    const range = (code, a, b, month = "long") => { setLangPref(code); return fmt.fmtDayRange(a, b, month); };
    assert.equal(range("ja", D(2026, 10, 12), D(2026, 10, 18)), "2026年10月12日〜18日");
    assert.equal(range("ja", D(2026, 10, 26), D(2026, 11, 1), "short"), "2026年10月26日〜11月1日");
    assert.equal(range("ja", D(2026, 12, 28), D(2027, 1, 3), "short"), "2026年12月28日〜2027年1月3日");
    assert.equal(range("zh-Hans", D(2026, 10, 12), D(2026, 10, 18)), "2026年10月12日至18日");
    assert.equal(range("zh-Hans", D(2026, 10, 26), D(2026, 11, 1), "short"), "2026年10月26日至11月1日");
    assert.match(range("de", D(2026, 10, 12), D(2026, 10, 18)), /^12\.\D{1,3}18\.\sOktober\s2026$/);
    assert.match(range("es", D(2026, 10, 12), D(2026, 10, 18)), /^12\D{1,3}18\soct\.?\s2026$/, "es writes the week title with the short month");
    assert.match(range("ru", D(2026, 10, 12), D(2026, 10, 18)), /^12\D{1,3}18\sокт\.?\s2026\sг\.$/, "ru writes the week title with the short month");
    setLangPref("en");
    assert.equal(fmt.fmtDayRange(D(2026, 10, 12), D(2026, 10, 18), "long"), null, "en keeps the classic range built by the caller");
    // ---- weekdays: the calendar column token and the token of dates in text
    const mon = new Date(2026, 9, 5, 14, 5); // Monday
    const col = (code) => { setLangPref(code); return fmt.fmtPattern(mon, "EEE", fmt.dateFormat().weekdayShort ?? "EEE"); };
    assert.deepEqual(["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"].map(col), ["Mon", "Th 2", "lun.", "周一", "lun", "月", "Mo", "пн"]);
    assert.equal(at("ru", "EEE, d MMM yyyy"), "пн, 5 окт. 2026");
    assert.equal(at("de", "EEE, d MMM yyyy"), "Mo, 5. Okt. 2026");
    assert.equal(at("de", "EEE d MMM"), "Mo, 5. Okt.");
    assert.equal(at("zh-Hans", "EEE, d MMM yyyy"), "2026年10月5日 周一");
    assert.equal(at("vi", "EEE, d MMM yyyy"), "Thứ 2, 5 thg 10 2026", "vi keeps the long form in text");
    // ---- 12-hour clock (a user setting, 24 h by default): the words of am / pm are the dictionary's, so the list and the calendar agree
    assert.deepEqual(["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"].map((c) => at(c, "h:mm a")), ["2:05 PM", "2:05 PM", "2:05 PM", "下午2:05", "2:05 p. m.", "午後2:05", "2:05 PM", "2:05 PM"]);
    assert.equal(at("ja", "EEE, d MMM yyyy h:mm a"), "2026年10月5日(月) 午後2:05");
    // ---- en / vi / fr: byte-identical to date-fns itself
    {
      const dfLocales = { en: (await import("date-fns/locale/en-US")).enUS, vi: (await import("date-fns/locale/vi")).vi, fr: (await import("date-fns/locale/fr")).fr };
      const { format: dfFormat } = await import("date-fns");
      for (const code of ["en", "vi", "fr"]) for (const p of used) {
        setLangPref(code);
        assert.equal(fmt.fmtPattern(mon, p), dfFormat(mon, p, { locale: dfLocales[code] }), `${code} ${p}`);
      }
    }
    setLangPref("vi");
    assert.equal(fmt.dateFormat().weekdayShort, "EEEEEE");
    assert.equal(fmt.dateFormat().capitalMonthTitle, true);
    setLangPref("en");
  }

  // ---- CJK line breaking: Japanese and Chinese paragraphs keep "ん。" and closing punctuation off the start of a line, Latin text is not touched
  {
    const css = readFileSync(join(root, "src/App.css"), "utf8");
    assert.match(css, /:root:lang\(ja\)[^{]*\{[^}]*line-break:\s*strict;[^}]*word-break:\s*auto-phrase/, "ja: line-break strict + word-break auto-phrase");
    assert.match(css, /:root:lang\(zh-Hans\)[^{]*\{[^}]*line-break:\s*strict/, "zh-Hans: line-break strict");
    const rules = css.match(/[^{}]*\{[^}]*(line-break|word-break:\s*auto-phrase)[^}]*\}/g) ?? [];
    assert.ok(rules.every((r) => /lang\((ja|zh-Hans)\)|lang="(ja|zh-Hans)"/.test(r)), "line-break / auto-phrase are set for ja and zh-Hans only (nothing else changes how Latin text wraps)");
  }

  // ---- the "Translate to ..." menu offers every language of the registry (and is built from it), each with a name in every dictionary
  {
    const rp = readFileSync(join(root, "src/components/ReadingPane.tsx"), "utf8");
    assert.ok(/\.\.\.LANGS\.map\(\(l\) => \(\{ en: l\.englishName, key: LANG_NAME\[l\.code\] \}\)\)/.test(rp), "TRANSLATE_TO is built from the registry");
    const names = rp.match(/LANG_NAME: Record<Lang, Key> = \{([^}]*)\}/)?.[1] ?? "";
    for (const l of LANGUAGES) assert.ok(names.includes(`${l.code.includes("-") ? `"${l.code}"` : l.code}: "reading.lang.`), `LANG_NAME names ${l.code}`);
    for (const [name, dict] of Object.entries(dicts)) for (const l of LANGUAGES) assert.ok(typeof dict[`reading.lang.${({ en: "english", vi: "vietnamese", fr: "french", "zh-Hans": "chineseSimplified", es: "spanish", ja: "japanese", de: "german", ru: "russian" })[l.code]}`] === "string", `${name} names ${l.code} in reading.lang.*`);
  }

  // ---- errors that come from the Rust side as codes (backend.<CODE>)
  assert.deepEqual(parseCoded("OUTBOX_SENDING: This message is being sent right now."), { code: "OUTBOX_SENDING", params: {}, text: "This message is being sent right now." });
  assert.deepEqual(parseCoded("PGP_NO_KEY|email=a%3Ab@c.d%7Cx: You have no PGP key for a:b@c.d|x.")?.params, { email: "a:b@c.d|x" });
  assert.equal(parseCoded("SMTP send failed: permanent error"), null, "an ordinary sentence is not a code");
  assert.equal(backendText("PGP_NO_KEY|email=ann@x.y: whatever"), "You have no PGP key for ann@x.y.");
  assert.equal(backendText("CAL_SEND_FAILED|v=saved|detail=boom: x"), "The event was saved, but the invitations weren't sent: boom");
  assert.equal(backendText("NOT_A_KNOWN_CODE: text"), null, "an unknown code keeps the backend's text");
  setLangPref("fr");
  assert.equal(backendText("OUTBOX_SENDING: This message is being sent right now."), "Ce message est en cours d’envoi.");
  setLangPref("vi");
  assert.equal(backendText("FILE_GONE: That file no longer exists."), "Tệp đó không còn tồn tại.");
  setLangPref("en");

  // every code the Rust code sends has a sentence (or is handled elsewhere); the English of the dictionary is what Rust says
  const rustDir = join(root, "src-tauri/src");
  const rust = walk(rustDir).filter((f) => f.endsWith(".rs") && !/tests?\.rs$|_tests|fake/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  const HANDLED_ELSEWHERE = new Set([
    "PGP_LOCKED", "PGP_MISSING_KEYS", "PGP_FAILED", "ATT_RISKY", // special shapes: store.ts friendlyError
    "CAL_READ_ONLY", "CAL_GONE", "CAL_ERROR", "CAL_CONFLICT", "CAL_NOT_SET_UP", "CAL_OFFLINE", "CAL_WRONG_ACCOUNT", "CAL_TIMEOUT", "CAL_PARTIAL",
    "CAL_DENIED", "CAL_BLOCKED", "CAL_AUTH", "CAL_CANCELLED", "CAL_BUSY", // calendar sync sentences: BACKEND_ERRORS in src/calendarSync.ts
  ]);
  // lines that build an error ("Err(", ok_or, map_err, coded(, a const) and are not tests
  const errLines = rust.split("\n").filter((l) => /Err\(|ok_or|map_err|coded\(|None =>|const [A-Z_]+: &str|^\s*"[A-Z][A-Z0-9_]+",$/.test(l) && !/assert|starts_with/.test(l)).join("\n");
  const rustCodes = new Set(
    [...errLines.matchAll(/"([A-Z][A-Z0-9_]{5,})[:|]/g)].map((m) => m[1])
      .concat([...errLines.matchAll(/coded\("([A-Z0-9_]+)"/g)].map((m) => m[1]))
      .concat([...errLines.matchAll(/^\s*"([A-Z][A-Z0-9_]+)",$/gm)].map((m) => m[1])),
  );
  for (const code of rustCodes) {
    if (HANDLED_ELSEWHERE.has(code)) continue;
    if (!Object.keys(en).some((k) => k === `backend.${code}` || k.startsWith(`backend.${code}.`))) fail(`Rust sends the code ${code} but the dictionary has no backend.${code}`);
  }
  for (const k of Object.keys(en)) {
    if (!k.startsWith("backend.")) continue;
    const code = k.slice("backend.".length).split(".")[0];
    if (!rustCodes.has(code)) fail(`${k}: no Rust code sends ${code}`);
  }
  // calendar sync sentences: each one the Rust code can say is recognised by a pattern of BACKEND_ERRORS (else it would stay English)
  const calRust = ["calsync/write.rs", "calsync/cmds.rs"].map((f) => readFileSync(join(rustDir, f), "utf8")).join("\n").split("\n").filter((l) => !/assert|starts_with/.test(l)).join("\n");
  for (const m of calRust.matchAll(/"(CAL_(?:OFFLINE|CONFLICT|GONE|READ_ONLY|AUTH|BUSY|NOT_SET_UP|DENIED|WRONG_ACCOUNT|PARTIAL|TIMEOUT|CANCELLED|BLOCKED|ERROR)): ([^"]+)"/g)) {
    const text = m[2].replace(/\{[^}]*\}/g, "X").replace(/\\"/g, '"');
    if (/^No .* OAuth client configured/.test(text)) continue; // developer text (build configuration), not translated
    if (!BACKEND_ERRORS.some((e) => e.re.test(text))) fail(`calendar sync sentence not covered by BACKEND_ERRORS: ${m[1]}: ${text}`);
  }
  // the Snooze tooltip must keep ending with the shortcut: App.tsx finds the button by it
  for (const [name, dict] of Object.entries(dicts)) if (!String(dict["reading.head.snoozeTip"]).endsWith(" (s)")) fail(`${name}: reading.head.snoozeTip must end with " (s)"`);
}

// ------------------------------------------------------------------------------------------------ 2. hard-coded English lint
function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// files that never reach a user (dev mock data, the dictionaries themselves)
const SKIP = [/[\\/]i18n[\\/]/, /[\\/]devMock/, /[\\/]fakeMail\.ts$/, /[\\/]devDarkCheck\.ts$/, /\.d\.ts$/];
// words that stay as they are in every language
const KEEP = /^(?:Hey Look!?|IMAP|SMTP|POP3?|OAuth2?|OpenPGP|PGP|S\/MIME|TLS|SSL|STARTTLS|iCloud|Gmail|Outlook|Google|Microsoft|Yahoo|Fastmail|GitHub|GreenMail|Hotmail|Office 365|Microsoft 365|ICS|iCal|HTML|URL|SHA-?\d*|CSV|PDF|JSON|UTC|GMT|Tauri|macOS|Windows|Linux)$/;
const ATTRS = new Set(["title", "aria-label", "aria-description", "aria-roledescription", "aria-placeholder", "aria-valuetext", "placeholder", "alt", "label", "tooltip", "hint", "caption", "summary"]);
const PROPS = new Set(["label", "title", "body", "text", "message", "placeholder", "hint", "description", "tooltip", "subtitle", "caption", "heading", "closeLabel", "confirmLabel", "okLabel", "cancelLabel", "emptyText", "detail"]);
const CALLS = new Set(["showToast", "setStickyToast", "toast", "ask", "confirm", "alert", "notify", "setError", "setStatus", "setMsg", "setNote", "setNotice", "setHint"]);
const COMPARE = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Static text of a string-like node, or null. Template expressions: the literal parts joined (placeholders as "{}"). */
function staticText(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + "{}" + n.templateSpans.map((s) => s.literal.text).join("{}");
  return null;
}
/** Does this text read as English UI text? (two words, or a capitalised word, containing letters) */
function looksLikeEnglish(s) {
  const x = s.replace(/\{\}/g, " ").replace(/&[a-z]+;|&#\d+;/gi, " ").trim();
  if (!/[A-Za-z]{2}/.test(x)) return false;
  if (KEEP.test(x)) return false;
  if (/^[a-z0-9_.:/#?&=%+@\-[\]*]+$/.test(x)) return false; // an id, url, css value, key
  if (/^(?:https?:|mailto:|\/|\.|#|[a-z]+:\/\/)/.test(x)) return false;
  const words = x.split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w));
  if (words.length >= 2) return true;
  return /^[A-Z][a-z]{2,}[a-z]*[.!?…:]?$/.test(x) && !KEEP.test(x.replace(/[.!?…:]$/, ""));
}

function lintFile(file) {
  const rel = relative(root, file).split(sep).join("/");
  const code = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = code.split(/\r?\n/);
  const found = [];
  const ok = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    return /i18n-ok/.test(lines[line] ?? "") || /i18n-ok/.test(lines[line - 1] ?? "") || /i18n-ok/.test(lines[sf.getLineAndCharacterOfPosition(node.getEnd()).line] ?? "");
  };
  const reported = new Set();
  const report = (node, what, s) => {
    if (ok(node) || reported.has(node.getStart(sf))) return;
    reported.add(node.getStart(sf));
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push(`${rel}:${line}: ${what}: ${JSON.stringify(s.length > 70 ? s.slice(0, 70) + "…" : s)}`);
  };
  const insideT = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const c = p.expression;
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
        if (name === "t" || name === "tx") return true;
      }
    }
    return false;
  };
  const strLits = (node, cb) => {
    const visit = (n) => {
      const s = staticText(n);
      if (s !== null) {
        const par = n.parent;
        const skip = (par && ts.isBinaryExpression(par) && COMPARE.has(par.operatorToken.kind)) || (par && ts.isCaseClause(par)) || (par && ts.isElementAccessExpression(par)) ||
          (par && ts.isCallExpression(par) && ts.isPropertyAccessExpression(par.expression) && /^(includes|startsWith|endsWith|indexOf|test|match|split|replace|replaceAll|has|get|set|add|delete|querySelector|getAttribute|setAttribute|classList)$/.test(par.expression.name.text));
        if (!skip && !insideT(n) && looksLikeEnglish(s)) cb(n, s);
        if (ts.isTemplateExpression(n)) n.templateSpans.forEach((sp) => visit(sp.expression));
        return;
      }
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return; // walked on their own
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
        if (name === "t" || name === "tx") return; // a translated text: its arguments are keys and data
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };
  // any other sentence-like string (a variable, a return value, a ternary branch): a capitalised phrase of three words, or two words ending in punctuation
  const sentence = (txt) => {
    const x = txt.replace(/\{\}/g, " ").replace(/\s+/g, " ").trim();
    if (/^[EdMyHhmsaLQ ,.:\/\-']+$/.test(x)) return false; // a date-fns pattern
    return (/^[A-Z“‘(][A-Za-z’']+ [A-Za-z’']+ [A-Za-z’']+/.test(x) || /^[A-Za-z’']{2,} [A-Za-z’']{2,}.*[.!?…]$/.test(x)) && !KEEP.test(x);
  };
  const quietParent = (p) =>
    !p || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p) || ts.isTemplateSpan(p) ||
    (ts.isBinaryExpression(p) && COMPARE.has(p.operatorToken.kind)) || ts.isCaseClause(p) || ts.isElementAccessExpression(p) ||
    (ts.isJsxAttribute(p) && !ATTRS.has(p.name.getText(sf))) ||
    (ts.isPropertyAssignment(p) && /^(id|key|type|kind|href|url|className|class|selector|pattern|format)$/.test(p.name.getText(sf).replace(/^["']|["']$/g, ''))) ||
    (ts.isCallExpression(p) && /^(console|log|warn|error|RegExp|querySelector|querySelectorAll|matches|closest|includes|startsWith|endsWith|test|match|replace|replaceAll|split|import|require|join)$/.test(ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : ts.isIdentifier(p.expression) ? p.expression.text : "")) ||
    (ts.isNewExpression(p) && /^(RegExp|Error)$/.test(p.expression.getText(sf)));
  const walkNode = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && !quietParent(n.parent) && !insideT(n)) {
      const txt = staticText(n);
      if (txt !== null && sentence(txt)) report(n, "text", txt);
    }
    if (ts.isJsxText(n)) {
      const x = n.text.replace(/&[a-z]+;|&#\d+;|\s+/gi, " ").trim();
      if (/[A-Za-z]{2}/.test(x) && !KEEP.test(x)) report(n, "JSX text", x);
    } else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText(sf)) && n.initializer) {
      if (ts.isStringLiteral(n.initializer)) {
        if (looksLikeEnglish(n.initializer.text)) report(n.initializer, `attribute ${n.name.getText(sf)}`, n.initializer.text);
      } else strLits(n.initializer, (node, s) => report(node, `attribute ${n.name.getText(sf)}`, s));
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      strLits(n.expression, (node, s) => report(node, "JSX child", s));
    } else if (ts.isPropertyAssignment(n) && n.name && PROPS.has(n.name.getText(sf).replace(/^["']|["']$/g, ""))) {
      strLits(n.initializer, (node, s) => report(node, `property ${n.name.getText(sf)}`, s));
    } else if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      if (CALLS.has(name)) for (const a of n.arguments.slice(0, 1)) strLits(a, (node, s) => report(node, `${name}()`, s));
    } else if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression)) {
      // thrown errors can reach a toast through friendlyError: their text is English unless it is a stable code
      for (const a of (n.expression.arguments ?? []).slice(0, 1)) strLits(a, (node, s) => report(node, "throw", s));
    }
    ts.forEachChild(n, walkNode);
  };
  walkNode(sf);
  return found;
}

const lintFiles = walk(join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !SKIP.some((r) => r.test(f)));
const lint = lintFiles.flatMap(lintFile);
if (lint.length) {
  fail(`${lint.length} hard-coded English text(s) in the UI code (use t("area.key"); a deliberate exception gets a comment "i18n-ok: why"):\n  ` +
    lint.slice(0, args.has("--list") ? 100000 : 60).join("\n  ") + (lint.length > 60 && !args.has("--list") ? `\n  … ${lint.length - 60} more (--list shows all)` : ""));
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok - test-i18n (${Object.keys(en).length} keys in ${Object.keys(dicts).length} languages; ${lintFiles.length} source files linted)`);
