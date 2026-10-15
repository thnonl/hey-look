// The one list of UI languages. The header language menu, the Welcome screen chooser, Settings > General > Language, `resolveLang`,
// the stored-preference check, the dictionaries' types and scripts/test-i18n.mjs all read it: see CONTRIBUTING.md > Translations >
// "Adding a language". The first entry (sortOrder 0, English) is the default and the fallback for everything unknown.
// Loadable by `node --experimental-strip-types` (no imports, no enums).

export interface Language {
  /** BCP 47 code, lower case ("en", "vi", "pt-br"); also the dictionary file name (src/i18n/<code>.ts) and the stored setting. */
  code: string;
  /** The language written in itself. Never translated: a person who cannot read the current language must still find theirs. */
  nativeName: string;
  /** For people who maintain the list and for type-ahead in the menus (typing "viet" finds Tiếng Việt). */
  englishName: string;
  /** Writing direction. Only recorded for now: no right-to-left layout exists yet, the UI does not read it. */
  dir: "ltr" | "rtl";
  /** Position in the menus; lower first. English stays first. */
  sortOrder: number;
  /** Tag for Intl / toLocaleString: numbers, dates, time zone names. */
  intl: string;
}

export const LANGUAGES = [
  { code: "en", nativeName: "English", englishName: "English", dir: "ltr", sortOrder: 0, intl: "en-GB" },
  { code: "vi", nativeName: "Tiếng Việt", englishName: "Vietnamese", dir: "ltr", sortOrder: 1, intl: "vi-VN" },
  { code: "fr", nativeName: "Français", englishName: "French", dir: "ltr", sortOrder: 2, intl: "fr-FR" },
] as const satisfies readonly Language[];

/** The codes of the languages above. */
export type Lang = (typeof LANGUAGES)[number]["code"];
