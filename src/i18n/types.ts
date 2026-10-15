// Types shared by the dictionaries (src/i18n/ns/*.ts) and the translator (index.ts).
// Kept free of runtime imports and of enums so `node --experimental-strip-types` can load it.

/** A plural message: `n` (the `{n}` parameter) picks the form with Intl.PluralRules of the language.
 *  English and French use `one` for 1 (French also for 0); Vietnamese has only `other`. */
export interface Plural {
  one: string;
  other: string;
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

/**
 * Declares one dictionary (a feature area) with every language of the registry side by side. Each other language must have exactly the
 * keys of `en`: a missing or extra key, or a registry language without its dictionary, fails `tsc`. (`NoInfer` keeps the key list coming
 * from `en` alone.)
 */
export function define<E extends Dict>(d: { en: E } & { [L in Exclude<Lang, "en">]: NoInfer<Record<keyof E, Msg>> }) {
  return d;
}
