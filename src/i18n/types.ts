// Types shared by the dictionaries (src/i18n/ns/*.ts, src/i18n/locales/<code>/*.ts) and the translator (index.ts).
// Kept free of runtime imports and of enums so `node --experimental-strip-types` can load it.

/**
 * A plural message: `n` (the `{n}` parameter) picks the form with Intl.PluralRules of the language, falling back to `other`.
 * Which forms a language must carry is listed in its registry entry (`plural` in languages.ts): English and French `one` + `other`
 * (French also uses `one` for 0), Vietnamese the same two (only `other` is ever picked), German and Spanish `one` + `other`,
 * Russian `one` + `few` + `many` + `other`, Japanese and Chinese `other` only. scripts/test-i18n.mjs checks it.
 */
export interface Plural {
  other: string;
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
}
/** One translated text. `{name}` marks a value that is put in at run time. */
export type Msg = string | Plural;
export type Dict = Record<string, Msg>;
export type Params = Record<string, string | number>;

/** Supported UI languages: the codes of the registry in languages.ts (the pseudo-locale `en-XA` exists in dev builds only and is not one of them). */
export type { Lang } from "./languages.ts";
import type { Lang } from "./languages.ts";

/** What the Settings > General > Language choice stores. */
export type LangPref = Lang | "en-XA";

/** The languages that sit next to English inside the namespace files in ns/ (the first three). Every later language has its own files in locales/<code>/. */
export type InlineLang = "vi" | "fr";

/**
 * Declares one dictionary (a feature area) with English, Vietnamese and French side by side. Vietnamese and French must have exactly the
 * keys of `en`: a missing or extra key fails `tsc`. (`NoInfer` keeps the key list coming from `en` alone.)
 * The other languages are declared with `defineLocale` in their own files.
 */
export function define<E extends Dict>(d: { en: E } & { [L in InlineLang]: NoInfer<Record<keyof E, Msg>> }) {
  return d;
}

/**
 * Declares one dictionary of one language in locales/<code>/<ns>.ts. `E` is the English dictionary of the same area
 * (`typeof ns.en` from ns/<ns>.ts); the object must have exactly its keys: a missing or extra key fails `tsc`.
 */
export function defineLocale<E extends Dict>(d: Record<keyof E, Msg>): Record<keyof E, Msg> {
  return d;
}
