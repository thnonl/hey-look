// Dates and numbers in the language in use. Every user-visible date / number goes through here (or through Intl with intlLocale()).
import { format as dfFormat } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { vi as dfVi } from "date-fns/locale/vi";
import { fr as dfFr } from "date-fns/locale/fr";
import type { Locale } from "date-fns";
import { getLang, intlLocale } from "./index.ts";
import type { Lang } from "./index.ts";

/** The date-fns locale of each language (a new language in the registry fails `tsc` until it has one here). */
const DF: Record<Lang, Locale> = { en: enUS, vi: dfVi, fr: dfFr };

/** The date-fns locale of the language in use (month and weekday names, am/pm). */
export function dfLocale(): Locale {
  return DF[getLang()];
}

/** date-fns `format` with the language in use: `fmtPattern(d, "EEE d MMM")`. */
export function fmtPattern(d: Date | number, pattern: string): string {
  return dfFormat(d, pattern, { locale: dfLocale() });
}

/** 12345 -> "12,345" (en), "12.345" (vi), "12 345" (fr, narrow no-break space). */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(intlLocale(), opts);
}

/** Month and weekday names from Intl (no tables of English words). `month` is 0-11, `weekday` 0 = Sunday. */
export function monthName(month: number, style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(intlLocale(), { month: style, timeZone: "UTC" }).format(Date.UTC(2021, month, 15));
}
export function weekdayName(weekday: number, style: "long" | "short" | "narrow" = "short"): string {
  return new Intl.DateTimeFormat(intlLocale(), { weekday: style, timeZone: "UTC" }).format(Date.UTC(2021, 7, 1 + weekday)); // 1 Aug 2021 = Sunday
}
