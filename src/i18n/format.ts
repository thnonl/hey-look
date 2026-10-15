// Dates and numbers in the language in use. Every user-visible date / number goes through here (or through Intl with intlLocale()).
import { format as dfFormat } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { vi as dfVi } from "date-fns/locale/vi";
import { fr as dfFr } from "date-fns/locale/fr";
import { zhCN as dfZh } from "date-fns/locale/zh-CN";
import { es as dfEs } from "date-fns/locale/es";
import { ja as dfJa } from "date-fns/locale/ja";
import { de as dfDe } from "date-fns/locale/de";
import { ru as dfRu } from "date-fns/locale/ru";
import type { Locale } from "date-fns";
import { getLang, intlLocale, LANGUAGES } from "./index.ts";
import type { DateFormat, Language, Lang } from "./index.ts";

/** The date-fns locale of each language (a new language in the registry fails `tsc` until it has one here). */
const DF: Record<Lang, Locale> = { en: enUS, vi: dfVi, fr: dfFr, "zh-Hans": dfZh, es: dfEs, ja: dfJa, de: dfDe, ru: dfRu };

const FMT = Object.fromEntries(LANGUAGES.map((l) => [l.code, (l as Language).fmt ?? {}])) as Record<Lang, DateFormat>;
/** How the language in use writes dates and calendar columns (the `fmt` of its registry entry; {} = the English patterns as they are). */
export const dateFormat = (): DateFormat => FMT[getLang()];

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN_RE = new Map<Lang, RegExp | null>();
/**
 * The date-fns pattern the language writes for an English one: `localizePattern("d MMM yyyy")` -> "yyyy年M月d日" in Chinese. Languages
 * list only the patterns they write differently (`fmt.patterns` in the registry); the UI code keeps asking in English patterns.
 */
export function localizePattern(pattern: string, lang: Lang = getLang()): string {
  let re = PATTERN_RE.get(lang);
  if (re === undefined) {
    const keys = Object.keys(FMT[lang].patterns ?? {}).sort((a, b) => b.length - a.length);
    re = keys.length ? new RegExp(keys.map(escapeRe).join("|"), "g") : null;
    PATTERN_RE.set(lang, re);
  }
  return re ? pattern.replace(re, (m) => FMT[lang].patterns![m]) : pattern;
}

/** The date-fns locale of the language in use (month and weekday names, am/pm). */
export function dfLocale(): Locale {
  return DF[getLang()];
}

/** date-fns `format` with the language in use: `fmtPattern(d, "EEE d MMM")`. */
export function fmtPattern(d: Date | number, pattern: string): string {
  return dfFormat(d, localizePattern(pattern), { locale: dfLocale() });
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

/** "5 – 11 October 2026" the way Intl writes a range of days in the language, or null when the language keeps the classic form (dateFormat().intlRanges). */
export function intlDayRange(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }, month: "long" | "short"): string | null {
  if (!dateFormat().intlRanges) return null;
  const f = new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month, year: "numeric", timeZone: "UTC" }) as Intl.DateTimeFormat & {
    formatRange(a: number, b: number): string; // (ES2021 lib)
  };
  return f.formatRange(Date.UTC(a.y, a.m - 1, a.d), Date.UTC(b.y, b.m - 1, b.d));
}
