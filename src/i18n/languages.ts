// The one list of UI languages. The header language menu, the Welcome screen chooser, Settings > General > Language, `resolveLang`,
// the stored-preference check, the dictionaries' types and scripts/test-i18n.mjs all read it: see CONTRIBUTING.md > Translations >
// "Adding a language". The first entry (sortOrder 0, English) is the default and the fallback for everything unknown.
// Loadable by `node --experimental-strip-types` (no imports, no enums).
//
// Every language-specific decision of the UI code lives here (plural forms, date patterns, calendar column names) or in a per-language
// file (the dictionary src/i18n/locales/<code>/, the Rust texts src-tauri/src/i18n/<code>.rs). Components never compare a language code.

/** CLDR plural categories a message may carry (see `Plural` in types.ts). */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** How dates are written in a language, where it differs from the English pattern the code asks for. All fields are optional. */
export interface DateFormat {
  /**
   * date-fns pattern -> the pattern to use instead. The UI code asks for English patterns ("d MMM", "EEE, d MMM yyyy", "dd/MM/yyyy",
   * "h:mm a" ...); a language lists the ones it writes differently ("d MMM" -> "M月d日"). The key must equal the whole pattern or a part of
   * it that the code builds (the longest key wins, the text is replaced in one pass). See `PATTERNS` in format.ts for the ones in use.
   */
  patterns?: Readonly<Record<string, string>>;
  /** date-fns token of the weekday name in calendar columns and day labels (default "EEE"; Vietnamese "EEEEEE" gives "T2", "CN"). */
  weekdayShort?: string;
  /** Capitalise the first letter of the month + year title of the calendar ("tháng 10 năm 2026" -> "Tháng 10 ..."). */
  capitalMonthTitle?: boolean;
  /** Write day ranges ("5 – 11 October 2026") with Intl.DateTimeFormat.formatRange of the language instead of "d – d MMM yyyy". */
  intlRanges?: boolean;
}

export interface Language {
  /** BCP 47 code ("en", "vi", "zh-Hans"); also the stored setting, the `<html lang>` and the folder src/i18n/locales/<code>/. */
  code: string;
  /** The language written in itself. Never translated: a person who cannot read the current language must still find theirs. */
  nativeName: string;
  /** For people who maintain the list and for type-ahead in the menus (typing "viet" finds Tiếng Việt). */
  englishName: string;
  /** Short label of the header language button ("EN", "ZH"). */
  short: string;
  /** Writing direction. Only recorded for now: no right-to-left layout exists yet, the UI does not read it. */
  dir: "ltr" | "rtl";
  /** Position in the menus; lower first. English stays first. */
  sortOrder: number;
  /** Tag for Intl / toLocaleString: numbers, dates, time zone names, plural rules. */
  intl: string;
  /**
   * The plural forms a plural message must carry in this language (always includes "other"; a subset of what
   * `Intl.PluralRules(intl)` can return). English, Vietnamese and French keep the two-form shape they were written in (`one` + `other`).
   * Russian: one / few / many / other. Japanese, Chinese: other only.
   */
  plural: readonly PluralCategory[];
  /** Dates and the calendar; see `DateFormat`. */
  fmt?: DateFormat;
}

export const LANGUAGES = [
  { code: "en", nativeName: "English", englishName: "English", short: "EN", dir: "ltr", sortOrder: 0, intl: "en-GB", plural: ["one", "other"] },
  {
    code: "vi", nativeName: "Tiếng Việt", englishName: "Vietnamese", short: "VI", dir: "ltr", sortOrder: 1, intl: "vi-VN", plural: ["one", "other"],
    fmt: { weekdayShort: "EEEEEE", capitalMonthTitle: true },
  },
  { code: "fr", nativeName: "Français", englishName: "French", short: "FR", dir: "ltr", sortOrder: 2, intl: "fr-FR", plural: ["one", "other"] },
  {
    code: "zh-Hans", nativeName: "中文（简体）", englishName: "Chinese (Simplified)", short: "ZH", dir: "ltr", sortOrder: 3, intl: "zh-CN", plural: ["other"],
    fmt: {
      intlRanges: true,
      patterns: {
        "EEE, d MMM yyyy": "yyyy年M月d日 EEE", "EEE d MMM yyyy": "yyyy年M月d日 EEE", "EEE d MMM": "M月d日 EEE", "d MMM yyyy": "yyyy年M月d日",
        "d MMM": "M月d日", "MMM yyyy": "yyyy年M月", "dd/MM/yyyy": "yyyy/MM/dd", "h:mm a": "ah:mm",
      },
    },
  },
  {
    code: "es", nativeName: "Español", englishName: "Spanish", short: "ES", dir: "ltr", sortOrder: 4, intl: "es", plural: ["one", "other"],
    fmt: { intlRanges: true },
  },
  {
    code: "ja", nativeName: "日本語", englishName: "Japanese", short: "JA", dir: "ltr", sortOrder: 5, intl: "ja", plural: ["other"],
    fmt: {
      intlRanges: true,
      patterns: {
        "EEE, d MMM yyyy": "yyyy年M月d日(EEE)", "EEE d MMM yyyy": "yyyy年M月d日(EEE)", "EEE d MMM": "M月d日(EEE)", "d MMM yyyy": "yyyy年M月d日",
        "d MMM": "M月d日", "MMM yyyy": "yyyy年M月", "dd/MM/yyyy": "yyyy/MM/dd", "h:mm a": "ah:mm",
      },
    },
  },
  {
    code: "de", nativeName: "Deutsch", englishName: "German", short: "DE", dir: "ltr", sortOrder: 6, intl: "de", plural: ["one", "other"],
    fmt: {
      intlRanges: true,
      patterns: { "EEE, d MMM yyyy": "EEE, d. MMM yyyy", "EEE d MMM yyyy": "EEE d. MMM yyyy", "EEE d MMM": "EEE d. MMM", "d MMM yyyy": "d. MMM yyyy", "d MMM": "d. MMM", "dd/MM/yyyy": "dd.MM.yyyy" },
    },
  },
  {
    code: "ru", nativeName: "Русский", englishName: "Russian", short: "RU", dir: "ltr", sortOrder: 7, intl: "ru", plural: ["one", "few", "many", "other"],
    fmt: { intlRanges: true, patterns: { "dd/MM/yyyy": "dd.MM.yyyy" } },
  },
] as const satisfies readonly Language[];

/** The codes of the languages above. */
export type Lang = (typeof LANGUAGES)[number]["code"];
