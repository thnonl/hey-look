// Text of the date and time fields (components/DateTimeFields.tsx): how a value is shown in the language and clock in use, how typed text is
// read back, and the steps of the arrow keys. A native <input type="date"> / <input type="time"> would show the OS / browser format
// (10/16/2026, 03:00 AM) whatever the app language and the Time format setting say, and `lang` does not change that in Chromium / WebView2.
//
// Values are the ones the inputs always had: "yyyy-MM-dd" and "HH:mm" (24 h), or "" for no value. Pure functions, no DOM; arithmetic runs on
// calendar dates (UTC) and minutes of the day, so a clock change never moves anything.
// This file must stay loadable by `node --experimental-strip-types` (imports with extension): scripts/test-datetime-fields.mjs.
import { getLang, t } from "./i18n/index.ts";
import { fmtPattern, localizePattern, monthName } from "./i18n/format.ts";

const pad = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------- dates

export interface YMD {
  y: number;
  m: number; // 1-12
  d: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-16" -> {2026, 10, 16}; null for anything else, including a date that does not exist (31 February). */
export function readIso(v: string): YMD | null {
  const m = ISO_DATE.exec(v);
  if (!m) return null;
  return real(Number(m[1]), Number(m[2]), Number(m[3]));
}

export const toIso = (x: YMD): string => `${String(x.y).padStart(4, "0")}-${pad(x.m)}-${pad(x.d)}`;

function real(y: number, m: number, d: number): YMD | null {
  if (!(y >= 1000 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null; // (31 Feb rolls into March)
}

/** The date `n` days later (or earlier), by calendar days: a clock change cannot move it. */
export function addDaysIso(v: string, n: number): string | null {
  const x = readIso(v);
  if (!x) return null;
  const t = new Date(Date.UTC(x.y, x.m - 1, x.d) + n * 86_400_000);
  return real(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()) ? toIso({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }) : null;
}

/** The date `n` months later (earlier); the day is kept, or the last day of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsIso(v: string, n: number): string | null {
  const x = readIso(v);
  if (!x) return null;
  const idx = x.y * 12 + (x.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const r = real(y, m, Math.min(x.d, dim));
  return r ? toIso(r) : null;
}

/** "2026-10-16" in the language in use: "16 Oct 2026", "16. Okt. 2026", "2026年10月16日" (the app's own d MMM yyyy pattern); "" for no value. */
export function formatDate(v: string): string {
  const x = readIso(v);
  return x ? fmtPattern(new Date(x.y, x.m - 1, x.d), "d MMM yyyy") : "";
}

/** Order of the numbers of a numeric date in the language in use: "dmy" (16/10/2026, 16.10.2026) or "ymd" (2026/10/16), from its dd/MM/yyyy pattern. */
export function numericOrder(): "dmy" | "ymd" {
  const p = localizePattern("dd/MM/yyyy");
  return p.indexOf("y") < p.indexOf("d") ? "ymd" : "dmy";
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\s.  ]/g, "").toLocaleLowerCase();

const MONTHS = new Map<string, Map<string, number>>();
/** Month names in the language in use (abbreviated and long, as the app writes them and as Intl does) and in English, folded: "okt" "oktober" "oct" -> month. */
function monthNames(): Map<string, number> {
  const lang = getLang();
  let map = MONTHS.get(lang);
  if (map) return map;
  map = new Map();
  for (let m = 0; m < 12; m++) {
    const probe = new Date(2021, m, 15);
    const names = [fmtPattern(probe, "MMM"), fmtPattern(probe, "MMMM"), fmtPattern(probe, "LLL"), fmtPattern(probe, "LLLL"), monthName(m, "short"), monthName(m, "long")];
    for (const style of ["short", "long"] as const) names.push(new Intl.DateTimeFormat("en", { month: style, timeZone: "UTC" }).format(Date.UTC(2021, m, 15))); // i18n-ok: English names are accepted in every language
    for (const n of names) {
      const k = fold(n);
      if (k && !/\d/.test(k) && !map.has(k)) map.set(k, m + 1);
    }
  }
  MONTHS.set(lang, map);
  return map;
}

/** The month a typed word means: a whole name, or the start of one that is long enough to be only that month ("octo", "sept"). */
function monthOfWord(word: string): number | null {
  const k = fold(word);
  if (!k) return null;
  const names = monthNames();
  const exact = names.get(k);
  if (exact) return exact;
  if (k.length < 3) return null;
  const hits = new Set<number>();
  for (const [name, m] of names) if (name.startsWith(k)) hits.add(m);
  return hits.size === 1 ? [...hits][0] : null; // ("mar" is March in English but also the start of Maart ...: only an unambiguous start counts)
}

const asYear = (s: string): number | null => {
  const n = Number(s);
  if (s.length <= 2) return 2000 + n;
  return s.length === 4 ? n : null;
};

/**
 * Typed text -> "yyyy-MM-dd", or null when it is not a date. Reads what the field shows (16 Oct 2026, 16. Okt. 2026, 2026年10月16日), ISO
 * (2026-10-16, 20261016), numbers in the order of the language (16/10/2026, 16.10.2026, 2026/10/16) with any of - / . space as separator, a month
 * written as a word anywhere ("October 16, 2026", "16 de octubre de 2026"), a two-digit year (16/10/26), and a date without a year or a day
 * alone, which take the year / month of `ref` (the value the field had). A month above 12 with a day up to 12 is read the other way round
 * (10/16/2026), because nobody means month 16.
 */
export function parseDate(text: string, ref = ""): string | null {
  const s = text.normalize("NFKC").trim();
  if (!s) return null;
  const base = readIso(ref) ?? (() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
  })();
  const nums = s.match(/\d+/g) ?? [];
  const words = s.match(/\p{L}+/gu) ?? [];
  let month: number | null = null;
  for (const w of words) {
    month = monthOfWord(w);
    if (month) break;
  }
  const make = (y: number | null, m: number, d: number): string | null => {
    if (y === null) return null;
    let r = real(y, m, d);
    if (!r && !month && m > 12 && d <= 12) r = real(y, d, m); // 10/16/2026
    return r ? toIso(r) : null;
  };
  if (month) {
    // "16 Oct 2026", "Oct 16, 2026", "October 2026" is not a day; the year is the number that has four digits (or the one that cannot be a day)
    if (nums.length === 0 || nums.length > 2) return null;
    if (nums.length === 1) {
      const n = nums[0]!;
      return n.length <= 2 ? make(base.y, month, Number(n)) : null;
    }
    const [a, b] = nums as [string, string];
    const yearFirst = a.length >= 3 || (a.length === 2 && b.length <= 2 && Number(a) > 31);
    return yearFirst ? make(asYear(a), month, Number(b)) : make(asYear(b), month, Number(a));
  }
  if (nums.length === 3) {
    const [a, b, c] = nums as [string, string, string];
    if (a.length === 4) return make(Number(a), Number(b), Number(c)); // 2026-10-16, 2026年10月16日
    if (c.length === 4 || (a.length <= 2 && c.length <= 2 && numericOrder() === "dmy")) return make(asYear(c), Number(b), Number(a)); // 16/10/2026, 16/10/26
    return make(asYear(a), Number(b), Number(c)); // 26/10/16 in a year-first language
  }
  if (nums.length === 2) {
    const [a, b] = nums as [string, string];
    if (a.length === 4) return null; // "2026-10" is a month, not a day
    return numericOrder() === "ymd" ? make(base.y, Number(a), Number(b)) : make(base.y, Number(b), Number(a)); // 16/10 or 10月16日
  }
  if (nums.length === 1) {
    const n = nums[0]!;
    if (n.length === 8) return make(Number(n.slice(0, 4)), Number(n.slice(4, 6)), Number(n.slice(6)));
    if (n.length <= 2) return make(base.y, base.m, Number(n)); // "16" = the 16th of the month the field had
  }
  return null;
}

// ---------------------------------------------------------------- times

const TIME_VALUE = /^(\d{2}):(\d{2})$/;

/** "15:30" -> minutes of the day (930); null for anything else. */
export function readTime(v: string): number | null {
  const m = TIME_VALUE.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

export const toTime = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** "15:30" the way the calendar writes its clock: 24 h "15:30", or 12 h "3:30 PM" with the language's am / pm words. */
export function formatTime(v: string, hour12: boolean): string {
  const mins = readTime(v);
  if (mins === null) return "";
  const h = Math.floor(mins / 60);
  const mi = mins % 60;
  if (!hour12) return `${pad(h)}:${pad(mi)}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(mi)} ${h < 12 ? t("calendar.time.am") : t("calendar.time.pm")}`; // (same as calendar.ts fmtClock)
}

/** Minutes later (earlier) in the same day, wrapping at midnight; the date is not touched. */
export function addMinutesOfDay(v: string, n: number): string | null {
  const mins = readTime(v);
  return mins === null ? null : toTime((((mins + n) % 1440) + 1440) % 1440);
}

const AM = ["am", "a", "上午", "午前"];
const PM = ["pm", "p", "下午", "午後", "午后"];

/**
 * Typed text -> "HH:mm", or null. Reads 15:30, 15.30, 1530, 930, 15h30, 15 h 30, 15, and a 12-hour clock with am / pm in English
 * ("3pm", "3:30 PM", "3 p.m.") or in the words of the language (午後3:00, 3:30 p. m.). Without a marker the number is a 24-hour time.
 */
export function parseTime(text: string): string | null {
  const s = text.normalize("NFKC").trim().toLocaleLowerCase();
  const m = /^([^\d]*)(\d{1,2})(?:\s*[:.hH時时]\s*|\s+)?(\d{2})?\s*(?:分|分钟)?([^\d]*)$/.exec(s);
  if (!m) return null;
  if (m[3] === undefined && /^\d{1,2}\s+\d/.test(s)) return null;
  const raw = fold(`${m[1]}${m[4]}`);
  const am = new Set([...AM, fold(t("calendar.time.am"))]);
  const pm = new Set([...PM, fold(t("calendar.time.pm"))]);
  let h = Number(m[2]);
  const mi = m[3] === undefined ? 0 : Number(m[3]);
  if (mi > 59) return null;
  const marker = am.has(raw) || pm.has(raw) ? raw : raw.replace(/uhr|h|時|时|点/g, ""); // ("15h" and "15 Uhr" mean nothing more; "CH" is the Vietnamese pm)
  if (marker) {
    if (pm.has(marker)) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + 12;
    } else if (am.has(marker)) {
      if (h < 1 || h > 12) return null;
      h %= 12;
    } else return null;
  } else if (h > 23) return null;
  return toTime(h * 60 + mi);
}

/** The times of the time list: every `step` minutes of a day; the current value is added when it is between two of them. */
export function timeSlots(current = "", step = 15): string[] {
  const out: string[] = [];
  for (let m = 0; m < 1440; m += step) out.push(toTime(m));
  const c = readTime(current);
  if (c !== null && c % step !== 0) {
    out.push(toTime(c));
    out.sort();
  }
  return out;
}

/** The slot a list opens on: the value itself, else the first time after it. */
export function slotFor(slots: string[], current: string): string | null {
  return slots.find((x) => x === current) ?? slots.find((x) => x > current) ?? slots[slots.length - 1] ?? null;
}
