// Date helpers for the calendar: everything is computed in the chosen calendar time zone ("auto" = this computer's),
// never in the browser's local zone by accident. Events are epoch seconds (UTC); all-day events are UTC midnights
// of their dates and are always handled by date.
import type { CalEvent, CalInvite } from "./api";
import type { Prefs } from "./prefs";

export type CalView = "month" | "week" | "agenda";

export interface Day {
  y: number;
  m: number; // 1-12
  d: number;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WD_SHORT = WEEKDAYS.map((d) => d.slice(0, 3));
const DAY_MS = 86_400_000;

export const MY_EVENTS_COLOR = "#8764b8";

export function systemTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function calTz(p: Pick<Prefs, "calTz">): string {
  return p.calTz && p.calTz !== "auto" && validTz(p.calTz) ? p.calTz : systemTz();
}

const tzOk = new Map<string, boolean>();
export function validTz(tz: string): boolean {
  let ok = tzOk.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    tzOk.set(tz, ok);
  }
  return ok;
}

const dtf = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtf.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    dtf.set(tz, f);
  }
  return f;
}

export interface Parts extends Day {
  h: number;
  mi: number;
  s: number;
  dow: number; // 0 = Sunday
}

/** Wall-clock parts of an instant in a zone. */
export function partsOf(ms: number, tz: string): Parts {
  const o: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  const h = o.hour === 24 ? 0 : o.hour;
  return { y: o.year, m: o.month, d: o.day, h, mi: o.minute, s: o.second, dow: new Date(Date.UTC(o.year, o.month - 1, o.day)).getUTCDay() };
}

/** UTC instant (ms) of a wall-clock time in a zone. Times inside a clock-change gap move forward. */
export function zonedMs(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (t: number) => {
    const p = partsOf(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
  };
  let t = guess - off(guess);
  const o2 = off(t);
  t = guess - o2;
  return t;
}

export const dayStartMs = (d: Day, tz: string) => zonedMs(d.y, d.m, d.d, 0, 0, tz);
export const dayKey = (d: Day) => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
export const sameDay = (a: Day, b: Day) => a.y === b.y && a.m === b.m && a.d === b.d;
export const cmpDay = (a: Day, b: Day) => a.y - b.y || a.m - b.m || a.d - b.d;

export function addDays(d: Day, n: number): Day {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export function addMonths(d: Day, n: number): Day {
  const idx = d.y * 12 + (d.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(d.d, dim) };
}
export const weekdayOf = (d: Day) => new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();
export const daysBetween = (a: Day, b: Day) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);

export function today(tz: string): Day {
  const p = partsOf(Date.now(), tz);
  return { y: p.y, m: p.m, d: p.d };
}

export function dayOfMs(ms: number, tz: string): Day {
  const p = partsOf(ms, tz);
  return { y: p.y, m: p.m, d: p.d };
}

/** First day shown for a week containing `d`. */
export function weekStartOf(d: Day, weekStart: number): Day {
  return addDays(d, -((weekdayOf(d) - weekStart + 7) % 7));
}

/** Six weeks covering the month of `d`. */
export function monthGrid(d: Day, weekStart: number): Day[] {
  const first = weekStartOf({ y: d.y, m: d.m, d: 1 }, weekStart);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export function weekDays(d: Day, weekStart: number): Day[] {
  const first = weekStartOf(d, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** The range to load (epoch seconds) for a view. */
export function rangeFor(view: CalView, focus: Day, weekStart: number, tz: string): { from: number; to: number } {
  let a: Day, b: Day;
  if (view === "month") {
    const g = monthGrid(focus, weekStart);
    a = g[0];
    b = addDays(g[41], 1);
  } else if (view === "week") {
    const w = weekDays(focus, weekStart);
    a = w[0];
    b = addDays(w[6], 1);
  } else {
    a = focus;
    b = addDays(focus, 30);
  }
  return { from: Math.floor(dayStartMs(a, tz) / 1000), to: Math.floor(dayStartMs(b, tz) / 1000) };
}

// ---------------------------------------------------------------- events on days

/** Date range an event covers: a [first, last] pair of days in the calendar zone (all-day events: their own dates). */
export function eventDaySpan(e: Pick<CalEvent, "start" | "end" | "allDay">, tz: string): [Day, Day] {
  if (e.allDay) {
    const a = dayOfMs(e.start * 1000, "UTC");
    const last = dayOfMs(Math.max(e.end * 1000 - 1, e.start * 1000), "UTC");
    return [a, cmpDay(last, a) < 0 ? a : last];
  }
  const a = dayOfMs(e.start * 1000, tz);
  const last = dayOfMs(Math.max(e.end * 1000 - 1, e.start * 1000), tz);
  return [a, cmpDay(last, a) < 0 ? a : last];
}

export function eventsOnDay(events: CalEvent[], day: Day, tz: string): CalEvent[] {
  return events
    .filter((e) => {
      const [a, b] = eventDaySpan(e, tz);
      return cmpDay(a, day) <= 0 && cmpDay(day, b) <= 0;
    })
    .sort((x, y) => Number(y.allDay) - Number(x.allDay) || x.start - y.start || x.end - y.end);
}

// ---------------------------------------------------------------- formatting

let hour12 = false;
export function configureCalendar(p: Pick<Prefs, "timeFormat">) {
  hour12 = p.timeFormat === "12";
}

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtClock(h: number, mi: number): string {
  if (!hour12) return `${pad(h)}:${pad(mi)}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(mi)} ${h < 12 ? "AM" : "PM"}`;
}

/** Clock time of an instant (epoch seconds) in a zone. */
export function fmtTime(sec: number, tz: string): string {
  const p = partsOf(sec * 1000, tz);
  return fmtClock(p.h, p.mi);
}

export const fmtDayLong = (d: Day) => `${WD_SHORT[weekdayOf(d)]}, ${d.d} ${MONTHS_SHORT[d.m - 1]} ${d.y}`;
export const fmtDayShort = (d: Day) => `${WD_SHORT[weekdayOf(d)]} ${d.d} ${MONTHS_SHORT[d.m - 1]}`;

/** "UTC+7" / "UTC-5:30" for a zone at an instant. */
export function tzOffsetLabel(tz: string, ms = Date.now()): string {
  const p = partsOf(ms, tz);
  const mins = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ""}`;
}

/** Short zone name such as "CEST" when the browser knows one, else "UTC+2". */
export function tzShortName(tz: string, ms = Date.now()): string {
  try {
    const n = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value;
    if (n && !/^GMT[+-]/.test(n)) return n;
  } catch {
    /* fall through */
  }
  return tzOffsetLabel(tz, ms);
}

/** "Wed, 14 Oct 2026 · 10:00 – 11:00", "Wed, 14 Oct 2026 · All day", "14 – 16 Oct 2026 · All day". */
export function fmtRange(e: Pick<CalEvent, "start" | "end" | "allDay">, tz: string): string {
  const [a, b] = eventDaySpan(e, tz);
  if (e.allDay) {
    if (sameDay(a, b)) return `${fmtDayLong(a)} · All day`;
    return a.y === b.y && a.m === b.m ? `${a.d} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y} · All day` : `${fmtDayShort(a)} – ${fmtDayLong(b)} · All day`;
  }
  if (sameDay(a, b)) {
    const end = e.end > e.start ? ` – ${fmtTime(e.end, tz)}` : "";
    return `${fmtDayLong(a)} · ${fmtTime(e.start, tz)}${end}`;
  }
  return `${fmtDayLong(a)} ${fmtTime(e.start, tz)} – ${fmtDayLong(b)} ${fmtTime(e.end, tz)}`;
}

/** Only the clock part ("05:00 – 06:00") for the organizer's-zone line. */
export function fmtClockRange(e: Pick<CalEvent, "start" | "end">, tz: string): string {
  return e.end > e.start ? `${fmtTime(e.start, tz)} – ${fmtTime(e.end, tz)}` : fmtTime(e.start, tz);
}

export function monthTitle(d: Day) {
  return `${MONTHS[d.m - 1]} ${d.y}`;
}

export function weekTitle(days: Day[]): string {
  const a = days[0];
  const b = days[6];
  if (a.m === b.m) return `${a.d} – ${b.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS_SHORT[a.m - 1]} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${a.y}`;
  return `${a.d} ${MONTHS_SHORT[a.m - 1]} ${a.y} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
}

// ---------------------------------------------------------------- input <-> instant

/** `<input type="date">` / `<input type="time">` values for an instant in a zone. */
export function toInputs(sec: number, tz: string): { date: string; time: string } {
  const p = partsOf(sec * 1000, tz);
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
}

export function dayToDate(d: Day): string {
  return dayKey(d);
}

export function parseDate(v: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/** Epoch seconds for date + time inputs in a zone (all-day: UTC midnight of the date). */
export function fromInputs(date: string, time: string, tz: string, allDay = false): number | null {
  const d = parseDate(date);
  if (!d) return null;
  if (allDay) return Date.UTC(d.y, d.m - 1, d.d) / 1000;
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!t) return null;
  return Math.floor(zonedMs(d.y, d.m, d.d, Number(t[1]), Number(t[2]), tz) / 1000);
}

// ---------------------------------------------------------------- misc

/** "Join Microsoft Teams meeting" etc. for a meeting link; null when the URL is not a known service. */
export function joinLabel(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "Join meeting";
  }
  if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) return "Join Microsoft Teams meeting";
  if (host.includes("meet.google.com")) return "Join Google Meet meeting";
  if (host.includes("zoom.us")) return "Join Zoom meeting";
  if (host.includes("webex.com")) return "Join Webex meeting";
  return "Join meeting";
}

export const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

export function personName(p: { email: string; name?: string | null } | null | undefined): string {
  return p ? p.name?.trim() || p.email : "";
}

export function eventColor(e: Pick<CalEvent, "calendarId">, accountColor: (id: string) => string | undefined): string {
  if (e.calendarId === "local") return MY_EVENTS_COLOR;
  return accountColor(e.calendarId.replace(/^invites:/, "")) || "var(--accent)";
}

/** Answer text for an event ("Accepted", "Not responded", …). */
export function myStatusLabel(s: CalEvent["myStatus"]): string | null {
  switch (s) {
    case "accepted": return "Accepted";
    case "tentative": return "Tentative";
    case "declined": return "Declined";
    case "needs-action": return "Not responded";
    case "organizer": return "Organizer";
    default: return null;
  }
}

/** The kind of chip an event gets (see the .ev-chip classes). */
export function chipClass(e: Pick<CalEvent, "myStatus" | "status" | "allDay">): string {
  if (e.status === "cancelled") return "cancelled";
  if (e.myStatus === "declined") return "declined";
  if (e.allDay) return "allday";
  if (e.myStatus === "needs-action") return "needs";
  if (e.myStatus === "tentative") return "tentative";
  return "";
}

export function eventLabel(e: CalEvent, tz: string): string {
  const when = e.allDay ? "all day" : `${fmtTime(e.start, tz)} to ${fmtTime(e.end, tz)}`;
  const st = e.status === "cancelled" ? "cancelled" : myStatusLabel(e.myStatus)?.toLowerCase();
  return `${e.summary}, ${when}${st ? `, ${st}` : ""}`;
}

export function inviteAsEvent(i: CalInvite): Pick<CalEvent, "start" | "end" | "allDay"> {
  return { start: i.start, end: i.end, allDay: i.allDay };
}

export interface Placed<T> {
  ev: T;
  lane: number;
  lanes: number;
}

/** Side-by-side lanes for overlapping timed events of one day (simple greedy packing per overlap cluster). */
export function layoutDay<T extends { start: number; end: number }>(list: T[]): Placed<T>[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = -Infinity;
  const ends: number[] = [];
  const flush = () => {
    const lanes = Math.max(1, ends.length);
    cluster.forEach((c) => (c.lanes = lanes));
    out.push(...cluster);
    cluster = [];
    ends.length = 0;
  };
  for (const ev of sorted) {
    if (ev.start >= clusterEnd && cluster.length) flush();
    let lane = ends.findIndex((e) => e <= ev.start);
    if (lane < 0) {
      lane = ends.length;
      ends.push(ev.end);
    } else ends[lane] = ev.end;
    cluster.push({ ev, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd === -Infinity ? ev.end : clusterEnd, ev.end);
  }
  if (cluster.length) flush();
  return out;
}

/** Repeat options offered in the event dialog (the rule is written for the event's start). */
export function repeatRule(kind: string, start: Day): string | null {
  switch (kind) {
    case "daily": return "FREQ=DAILY";
    case "weekdays": return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly": return `FREQ=WEEKLY;BYDAY=${["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekdayOf(start)]}`;
    case "monthly": return `FREQ=MONTHLY;BYMONTHDAY=${start.d}`;
    case "yearly": return "FREQ=YEARLY";
    default: return null;
  }
}

/** Which preset an existing rule matches ("custom" when none does). */
export function repeatKind(rule: string | null, start: Day): string {
  if (!rule) return "none";
  for (const k of ["daily", "weekdays", "weekly", "monthly", "yearly"]) if (repeatRule(k, start) === rule) return k;
  return "custom";
}
