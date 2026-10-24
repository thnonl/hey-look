// UI translations: t("some.key", { name }) -> text in the chosen language.
//
//   - dictionaries: ns/*.ts (one file per feature area, English only), gathered by en.ts; every other language has its own folder
//     locales/<code>/ (one file per area, gathered by its index.ts).
//     A key missing in a language (or an extra one) fails `tsc`; scripts/test-i18n.mjs also compares the {placeholders} and plural forms.
//   - only English is in the first JavaScript file (it is the fallback of `t`). Every other language is a chunk of its own (lang-<code>.ts:
//     dictionary + date-fns locale), fetched by `loadLanguage` when the saved language is read at start (before the first render, bootLang.ts)
//     or when the person picks it (store.setPrefs). `t` itself stays synchronous: the current language is always one that is loaded.
//   - `t` is a plain function so non-React code (store, toasts, helpers) can use it. A component calls `useT()` (./react.ts) once, which
//     re-renders it when the language changes; module-level helpers called while rendering use `t` directly.
//   - the language comes from the Language setting (prefs.language): English (the default) or any language of the registry; the OS language is not used.
//   - `en-XA` is a pseudo-locale (dev builds only): English made longer, accented and in brackets, to show text that is not translated
//     or does not fit.
// This file must stay loadable by `node --experimental-strip-types` (no JSX, no enums, imports with extension).
import { en } from "./en.ts";
import { LANGUAGES } from "./languages.ts";
import type { Language } from "./languages.ts";
import type { Lang, LangPack, LangPref, Msg, Params } from "./types.ts";
import type { Locale } from "date-fns";

export type { Lang, LangPref, Msg, Params } from "./types.ts";
export { LANGUAGES } from "./languages.ts";
export type { Language, DateFormat, PluralCategory } from "./languages.ts";
export type Key = keyof typeof en;

/** The languages every language control offers (header menu, Welcome screen, Settings), in registry order; names in their own language. */
export const LANGS: readonly (Language & { code: Lang })[] = [...LANGUAGES].sort((a, b) => a.sortOrder - b.sortOrder);
const PSEUDO = "en-XA";

// ---- loading the languages ----------------------------------------------------------------------------------------------------
// A language in the registry without a loader here fails `tsc`. The import() arguments are literals (vite makes one chunk of each, node loads them too).
const LOADERS: Record<Exclude<Lang, "en">, () => Promise<{ default: LangPack }>> = {
  vi: () => import("./lang-vi.ts"),
  fr: () => import("./lang-fr.ts"),
  "zh-Hans": () => import("./lang-zh-Hans.ts"),
  es: () => import("./lang-es.ts"),
  ja: () => import("./lang-ja.ts"),
  de: () => import("./lang-de.ts"),
  ru: () => import("./lang-ru.ts"),
};
/** The languages loaded so far (English is not in here: it is always there). They stay in memory until the app quits. */
const PACKS: Partial<Record<Exclude<Lang, "en">, LangPack>> = {};
const LOADING = new Map<Lang, Promise<void>>();
const RETRY_MS = 500;
/** Tag for Intl / toLocaleString: numbers, dates, time zone names. */
const INTL = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.intl])) as Record<Lang, string>;
/** True for the code of a language in the registry. */
export const isLang = (code: unknown): code is Lang => LANGUAGES.some((l) => l.code === code);

const isDev = (): boolean => !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
/** The pseudo-locale can be picked in dev builds only. */
export const pseudoAllowed = isDev;

/**
 * The language of a Language setting. English is the default: an unset, unknown or outdated value ("system", a removed language) gives
 * English, and the language of the computer is never looked at.
 */
export function resolveLang(pref: LangPref | string | undefined | null): Lang {
  return isLang(pref) ? pref : "en";
}

/** True when the language can be switched to now: English (and the pseudo-locale) always, any other once its chunk was loaded. */
export const isLoaded = (code: Lang): boolean => code === "en" || !!PACKS[code];
/** True when the Language setting `pref` can be applied by `setLangPref` right now. */
export const isReady = (pref: LangPref | string | undefined): boolean => isLoaded(resolveLang(pref === PSEUDO ? "en" : pref));
/** The date-fns locale of a loaded language (undefined for English and for a language that is not loaded: format.ts has en-US). */
export const loadedDateLocale = (code: Lang): Locale | undefined => (code === "en" ? undefined : PACKS[code]?.df);

const isNode = (): boolean => !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Dev preview seam `#langfail=<code>`: the load of that language fails (every try), to see the failure path. Dev builds only. */
const failSeam = (code: Lang): boolean =>
  (isDev() && typeof window !== "undefined" && window.location.hash.slice(1).split("&").includes(`langfail=${code}`)) ||
  (isNode() && ((globalThis as { __heylookLangFail?: string[] }).__heylookLangFail ?? []).includes(code)); // (node tests: scripts/test-lang-load.mjs)

async function fetchPack(code: Exclude<Lang, "en">): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (failSeam(code)) throw new Error(`the language chunk "${code}" could not be loaded (#langfail)`);
      PACKS[code] = (await LOADERS[code]()).default;
      return;
    } catch (e) {
      if (attempt >= 1) throw e; // one retry after 500 ms, then the caller keeps the language in use
      await sleep(RETRY_MS);
    }
  }
}

/**
 * Fetch the dictionary and the date-fns locale of a language (once; English is already there). Resolves when it is loaded, rejects when the
 * chunk cannot be fetched (after one retry). Does not switch: `setLangPref` (or `switchLanguage`) does, so the UI never shows a mix.
 */
export function loadLanguage(code: Lang): Promise<void> {
  if (isLoaded(code)) return Promise.resolve();
  let p = LOADING.get(code);
  if (!p) {
    p = fetchPack(code as Exclude<Lang, "en">).finally(() => LOADING.delete(code)); // a failure is not remembered: the next try fetches again
    LOADING.set(code, p);
  }
  return p;
}

/** Load every language (node tests that switch through the registry; the dev preview does not need it). */
export async function loadAllLanguages(): Promise<void> {
  await Promise.all(LANGUAGES.map((l) => loadLanguage(l.code)));
}

// ---- current language (module state, observable) ------------------------------------------------------------------------------
// English until setLangPref is called with the saved setting (the first render of the app, node tests).
let lang: Lang = "en";
let dict: Record<string, Msg> = en;
let pseudo = false;
let version = 0;
let switchSeq = 0;
const listeners = new Set<() => void>();

/**
 * Apply the Language setting, synchronously: the language must be loaded (`await loadLanguage(code)` first). A language that is not loaded
 * throws in dev builds and in node (a test cannot silently run in English) and is ignored with a console error in a release build.
 * Called when the preferences load and whenever the choice changes.
 */
export function setLangPref(pref: LangPref | string | undefined): void {
  const wantPseudo = pref === PSEUDO && isDev();
  const next = resolveLang(wantPseudo ? "en" : pref);
  if (!isLoaded(next)) {
    const msg = `setLangPref("${String(pref)}"): the language is not loaded; await loadLanguage("${next}") first`;
    if (isDev() || isNode()) throw new Error(msg);
    console.error(msg);
    return;
  }
  switchSeq++; // a switch that was waiting for a chunk is dropped: this one is the last choice
  if (next === lang && wantPseudo === pseudo) return;
  lang = next;
  dict = next === "en" ? en : PACKS[next]!.dict;
  pseudo = wantPseudo;
  version++;
  if (typeof document !== "undefined") document.documentElement.lang = pseudo ? "en-XA" : lang; // the registry code is the BCP 47 tag (zh-Hans, ja ...): the CSS :lang() font stacks read it
  listeners.forEach((l) => l());
}
export const subscribeLang = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/**
 * Load the language of a Language setting, then switch to it in one step: until the chunk is there everything stays in the language in
 * use. A later call (or `setLangPref`) while this one is loading wins: this one then does nothing and resolves false. Rejects when the
 * chunk cannot be loaded; the language in use stays.
 */
export async function switchLanguage(pref: LangPref | string | undefined): Promise<boolean> {
  const seq = ++switchSeq;
  await loadLanguage(resolveLang(pref === PSEUDO ? "en" : pref));
  if (seq !== switchSeq) return false;
  setLangPref(pref);
  return true;
}
/** Changes with every language switch (for useSyncExternalStore). */
export const langVersion = (): number => version;
/** The language in use ("en" under the pseudo-locale). */
export const getLang = (): Lang => lang;
/** The BCP 47 tag for Intl and toLocaleString in the language in use. */
export const intlLocale = (): string => INTL[lang];

// ---- translating --------------------------------------------------------------------------------------------------------------
const PLACEHOLDER = /\{(\w+)\}/g;

const PLURAL_RULES = Object.fromEntries(LANGUAGES.map((l) => [l.code, new Intl.PluralRules(l.intl)])) as Record<Lang, Intl.PluralRules>;

/** The text of a message for the count `n` in a language: a plain string as it is, a plural by CLDR category (Intl.PluralRules), `other` when a form is missing. */
export function pickPlural(m: Msg, n: number, language: Lang): string {
  if (typeof m === "string") return m;
  const cat = PLURAL_RULES[language].select(Number.isFinite(n) ? n : 1);
  return m[cat] ?? m.other; // a form the language does not write (French "many" for millions, Spanish "many") is `other`
}

const pick = (m: Msg, params: Params | undefined, language: Lang): string => pickPlural(m, Number(params?.n), language);

/** Text for `key` in the current language with `{name}` filled from `params`; a plural message uses `params.n`. */
export function t(key: Key, params?: Params): string {
  const msg = dict[key] ?? en[key];
  if (msg === undefined) return String(key); // a dynamic key that does not exist: show it rather than nothing
  const raw = pick(msg, params, lang);
  const out = params ? raw.replace(PLACEHOLDER, (m, name: string) => (name in params ? String(params[name]) : m)) : raw;
  return pseudo ? pseudoize(out) : out;
}

/** True when the key exists (dynamic keys built from data). */
export const hasKey = (key: string): key is Key => key in en;

// ---- pseudo-locale ------------------------------------------------------------------------------------------------------------
const ACCENTS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ö", p: "þ", q: "ǫ",
  r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ",
  R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};
/** "Save draft" -> "[Šáṽé ðŕáƒţ ~~~~]": accented letters, about 40% longer, in brackets; {placeholders} are left alone. */
export function pseudoize(s: string): string {
  const body = s.replace(/\{\w+\}|[A-Za-z]/g, (m) => (m.length > 1 ? m : (ACCENTS[m] ?? m)));
  const pad = "~".repeat(Math.max(1, Math.round(s.replace(/\{\w+\}/g, "").length * 0.4)));
  return `[${body} ${pad}]`;
}
