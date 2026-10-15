// UI translations: t("some.key", { name }) -> text in the chosen language.
//
//   - dictionaries: ns/*.ts (one file per feature area, English / Vietnamese / French side by side), gathered by en.ts / vi.ts / fr.ts.
//     A key missing in vi or fr (or an extra one) fails `tsc`; scripts/test-i18n.mjs also compares the {placeholders}.
//   - `t` is a plain function so non-React code (store, toasts, helpers) can use it. A component calls `useT()` (./react.ts) once, which
//     re-renders it when the language changes; module-level helpers called while rendering use `t` directly.
//   - the language comes from the Language setting (prefs.language): English (the default), Vietnamese or French; the OS language is not used.
//   - `en-XA` is a pseudo-locale (dev builds only): English made longer, accented and in brackets, to show text that is not translated
//     or does not fit.
// This file must stay loadable by `node --experimental-strip-types` (no JSX, no enums, imports with extension).
import { en } from "./en.ts";
import { vi } from "./vi.ts";
import { fr } from "./fr.ts";
import { LANGUAGES } from "./languages.ts";
import type { Language } from "./languages.ts";
import type { Lang, LangPref, Msg, Params } from "./types.ts";

export type { Lang, LangPref, Msg, Params } from "./types.ts";
export { LANGUAGES } from "./languages.ts";
export type { Language } from "./languages.ts";
export type Key = keyof typeof en;

/** The languages every language control offers (header menu, Welcome screen, Settings), in registry order; names in their own language. */
export const LANGS: readonly (Language & { code: Lang })[] = [...LANGUAGES].sort((a, b) => a.sortOrder - b.sortOrder);
export const PSEUDO = "en-XA";

const DICTS: Record<Lang, Record<string, Msg>> = { en, vi, fr };
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

// ---- current language (module state, observable) ------------------------------------------------------------------------------
// English until setLangPref is called with the saved setting (the first render of the app, node tests).
let lang: Lang = "en";
let pseudo = false;
let version = 0;
const listeners = new Set<() => void>();

/** Apply the Language setting. Called when the preferences load and whenever the choice changes. */
export function setLangPref(pref: LangPref | string | undefined): void {
  const wantPseudo = pref === PSEUDO && isDev();
  const next = resolveLang(wantPseudo ? "en" : pref);
  if (next === lang && wantPseudo === pseudo) return;
  lang = next;
  pseudo = wantPseudo;
  version++;
  if (typeof document !== "undefined") document.documentElement.lang = pseudo ? "en-XA" : lang;
  listeners.forEach((l) => l());
}
export const subscribeLang = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** Changes with every language switch (for useSyncExternalStore). */
export const langVersion = (): number => version;
/** The language in use ("en" under the pseudo-locale). */
export const getLang = (): Lang => lang;
/** The BCP 47 tag for Intl and toLocaleString in the language in use. */
export const intlLocale = (): string => INTL[lang];

// ---- translating --------------------------------------------------------------------------------------------------------------
const PLACEHOLDER = /\{(\w+)\}/g;

function pick(m: Msg, params: Params | undefined, language: Lang): string {
  if (typeof m === "string") return m;
  const n = Number(params?.n);
  const cat = new Intl.PluralRules(INTL[language]).select(Number.isFinite(n) ? n : 1);
  return cat === "one" ? m.one : m.other;
}

/** Text for `key` in the current language with `{name}` filled from `params`; a plural message uses `params.n`. */
export function t(key: Key, params?: Params): string {
  const msg = DICTS[lang][key] ?? en[key];
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
