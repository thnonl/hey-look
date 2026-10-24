// The dev preview's version of repeating events (W7.1): expansion of a rule and the scopes of a change (this occurrence, this and the following ones, the whole series), kept in
// step with src-tauri/src/calseries.rs (My events) so the preview and the tests of the interface behave as the app does. Dev only (devMock.ts imports it; a release build
// never ships it, see scripts/bundle-budget.json `neverShipped`). Everything is plain data: rows are objects, a series is a row with `rrule`, a changed occurrence a row of the
// same `uid` with `recurrenceId` (its slot) and the slot in the series' `exdates`.

export type Row = Record<string, unknown> & { id: string; uid: string; start: number; end: number; calendarId: string; rrule: string | null; allDay: boolean };
export type Scope = "occurrence" | "following" | "series";

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const exOf = (r: Row): number[] => (Array.isArray(r.exdates) ? (r.exdates as number[]) : []);
const zoneOf = (r: { allDay: boolean; tzid?: unknown }) => (r.allDay ? "UTC" : typeof r.tzid === "string" && r.tzid ? r.tzid : "UTC");

// ---- wall clock <-> instant in a zone
function wall(ts: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; wd: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })
      .formatToParts(new Date(ts * 1000))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
function instant(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi) / 1000;
  const off = (t: number) => {
    const w = wall(t, tz);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) / 1000 - t;
  };
  const t1 = guess - off(guess);
  return guess - off(t1);
}

// ---- rules
const parts = (rule: string): [string, string][] =>
  rule.replace(/^RRULE:/i, "").split(";").filter((x) => x.includes("=")).map((kv) => {
    const i = kv.indexOf("=");
    return [kv.slice(0, i).toUpperCase(), kv.slice(i + 1)] as [string, string];
  });
const join = (p: [string, string][]) => p.map(([k, v]) => `${k}=${v}`).join(";");
const part = (rule: string, k: string) => parts(rule).find(([x]) => x === k)?.[1];

/** The start of every occurrence of a series up to `to` (no exclusions), at most `max`. */
export function slots(r: Pick<Row, "start" | "end" | "allDay" | "rrule"> & { tzid?: unknown; rdates?: number[] }, to: number, max = 800): number[] {
  const tz = zoneOf(r);
  const w = wall(r.start, tz);
  const rule = r.rrule;
  if (!rule) return [r.start];
  const freq = part(rule, "FREQ");
  const interval = Math.max(1, Number(part(rule, "INTERVAL") ?? 1));
  const count = part(rule, "COUNT") ? Number(part(rule, "COUNT")) : Infinity;
  const untilRaw = part(rule, "UNTIL");
  const until = untilRaw
    ? untilRaw.length === 8
      ? Date.UTC(+untilRaw.slice(0, 4), +untilRaw.slice(4, 6) - 1, +untilRaw.slice(6, 8)) / 1000 + 86399
      : Date.UTC(+untilRaw.slice(0, 4), +untilRaw.slice(4, 6) - 1, +untilRaw.slice(6, 8), +untilRaw.slice(9, 11), +untilRaw.slice(11, 13), +untilRaw.slice(13, 15)) / 1000
    : Infinity;
  const days = (part(rule, "BYDAY") ?? "").split(",").filter(Boolean).map((c) => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(c.replace(/^[+-]?\d+/, "")));
  const monthDay = part(rule, "BYMONTHDAY") ? Number(part(rule, "BYMONTHDAY")) : w.d;
  const out: number[] = [];
  let emitted = 0;
  const day0 = Date.UTC(w.y, w.m - 1, w.d) / 86400000;
  for (let i = 0; i < 4000 && out.length < max && emitted < count; i++) {
    const dayN = day0 + i;
    const dt = new Date(dayN * 86400000);
    const [y, m, d, wd] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), dt.getUTCDay()];
    let hit = false;
    if (freq === "DAILY") hit = i % interval === 0;
    else if (freq === "WEEKLY") {
      // weeks count from the Monday of the start's week
      const startMon = day0 - ((new Date(day0 * 86400000).getUTCDay() + 6) % 7);
      const weekNo = Math.floor((dayN - startMon) / 7);
      hit = weekNo % interval === 0 && (days.length ? days.includes(wd) : wd === new Date(day0 * 86400000).getUTCDay());
    } else if (freq === "MONTHLY") hit = d === monthDay && ((y - w.y) * 12 + (m - w.m)) % interval === 0;
    else if (freq === "YEARLY") hit = d === w.d && m === w.m && (y - w.y) % interval === 0;
    if (!hit) continue;
    const t = r.allDay ? Date.UTC(y, m - 1, d) / 1000 : instant(y, m, d, w.h, w.mi, tz);
    if (t < r.start) continue;
    if (t > until || t > to) break;
    out.push(t);
    emitted++;
  }
  return out;
}

const untilBefore = (slot: number, allDay: boolean) => {
  const f = (t: number, all: boolean) => {
    const d = new Date(t * 1000);
    const p = (n: number, l = 2) => String(n).padStart(l, "0");
    return all ? `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` : `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  };
  return allDay ? f(slot - 86400, true) : f(slot - 1, false);
};

/** The rule cut before `slot`: the part that stays and the part that starts there (COUNT is divided, anything else gets UNTIL). */
export function splitRule(r: Row, slot: number): { old: string; next: string } | null {
  if (!r.rrule || slot <= r.start) return null;
  const p = parts(r.rrule);
  const ci = p.findIndex(([k]) => k === "COUNT");
  if (ci >= 0) {
    const n = Number(p[ci][1]);
    const k = slots(r, slot - 1).length;
    if (k === 0 || k >= n) return null;
    const old = p.map((x) => [...x] as [string, string]);
    old[ci][1] = String(k);
    p[ci][1] = String(n - k);
    return { old: join(old), next: join(p) };
  }
  const next = join(p);
  return { old: join([...p.filter(([k]) => k !== "UNTIL"), ["UNTIL", untilBefore(slot, r.allDay)]]), next };
}

/** A rule in one form for comparing: the implied day / weekday of the start written out. */
function signature(rule: string | null, start: number, tz: string): string {
  if (!rule) return "";
  const p = parts(rule).filter(([k, v]) => !(k === "INTERVAL" && v === "1"));
  const w = wall(start, tz);
  const has = (k: string) => p.some(([x]) => x === k);
  const f = part(rule, "FREQ");
  if (f === "WEEKLY" && !has("BYDAY")) p.push(["BYDAY", ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][w.wd]]);
  if (f === "MONTHLY" && !has("BYDAY") && !has("BYMONTHDAY")) p.push(["BYMONTHDAY", String(w.d)]);
  if (f === "YEARLY") {
    if (!has("BYMONTH")) p.push(["BYMONTH", String(w.m)]);
    if (!has("BYDAY") && !has("BYMONTHDAY")) p.push(["BYMONTHDAY", String(w.d)]);
  }
  return join(p.map(([k, v]) => [k, k === "BYDAY" ? v.split(",").sort().join(",") : v] as [string, string]).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Where a slot goes when the series moves from `oldStart` to `newStart`: the wall clock moves by the same amount in the zone of the series. */
function shift(slot: number, oldStart: number, newStart: number, allDay: boolean, tz: string): number {
  if (allDay) return slot + (newStart - oldStart);
  const [a, b, c] = [wall(oldStart, tz), wall(newStart, tz), wall(slot, tz)];
  const delta = Date.UTC(b.y, b.m - 1, b.d, b.h, b.mi) - Date.UTC(a.y, a.m - 1, a.d, a.h, a.mi);
  const n = new Date(Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi) + delta);
  return instant(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), n.getUTCHours(), n.getUTCMinutes(), tz);
}

// ---- expanding rows for the views
const isSeries = (r: Row) => !!r.rrule || !!r.recurrenceId;

/**
 * The entries of one row in a window: a series row gives its occurrences (not the excluded slots), any other row itself. Every occurrence carries `series`, `occurrenceStart` and
 * `instanceStart` (= its slot) and `firstOccurrence`, as `calendar_list_events` does (calendar.rs `list_range`; D-109 was that one leaving `occurrenceStart` empty, pinned by the
 * Rust tests `chip_tests`, which the mock cannot see: change both together).
 */
export function expandRow(r: Row, from: number, to: number): Row[] {
  const base = (x: Row, extra: Record<string, unknown>): Row => ({ ...x, series: isSeries(x) || undefined, ...extra });
  if (r.recurrenceId) return r.end > from && r.start < to ? [base(r, { occurrenceStart: Number(r.recurrenceId), changedOccurrence: true })] : [];
  if (!r.rrule) return r.end > from - 86400 && r.start < to + 86400 ? [base(r, { series: r.series })] : [];
  const dur = r.end - r.start;
  const ex = new Set(exOf(r));
  return slots(r, to)
    .filter((s) => !ex.has(s) && s < to && s + dur > from - (r.allDay ? 86400 : 0))
    .map((s) => base({ ...r, start: s, end: s + dur }, { occurrenceStart: s, instanceStart: s, firstOccurrence: s === r.start, series: true }));
}

// ---- the scopes
export interface Resolved {
  series: Row;
  changed: Row | null;
  slot: number | null;
}

export function resolve(rows: Row[], id: string, slot: number | null): Resolved {
  const row = rows.find((x) => x.id === id);
  if (!row) throw "CAL_EVENT_NOT_FOUND: event not found";
  if (row.recurrenceId) {
    const series = rows.find((x) => x.uid === row.uid && x.calendarId === row.calendarId && !x.recurrenceId);
    if (!series) throw "CAL_EVENT_NOT_FOUND: event not found";
    return { series, changed: row, slot: Number(row.recurrenceId) };
  }
  return { series: row, changed: slot === null ? null : rows.find((x) => x.uid === row.uid && x.recurrenceId === String(slot)) ?? null, slot };
}

const changedOf = (rows: Row[], s: Row) => rows.filter((x) => x.uid === s.uid && x.calendarId === s.calendarId && !!x.recurrenceId);
const instanceOf = (s: Row, slot: number): Row => ({ ...s, start: slot, end: slot + (s.end - s.start), instanceStart: slot, occurrenceStart: slot, exdates: [], firstOccurrence: slot === s.start, series: true });

/** What the form edits: the values for a part of a series, how many changed occurrences a save would reset, whether the rule can be changed. */
export function getScoped(rows: Row[], id: string, scope: Scope, slot: number | null): Row {
  const p = resolve(rows, id, slot);
  const all = changedOf(rows, p.series);
  const unsupported = String(p.series.summary).includes("[pattern]");
  if (scope === "series") return { ...p.series, series: true, changedCount: all.length, patternUnsupported: unsupported, rrule: unsupported ? null : p.series.rrule };
  if (p.slot === null) throw "CAL_EVENT_NOT_FOUND: event not found";
  const e = p.changed ? { ...p.changed } : instanceOf(p.series, p.slot);
  if (scope === "following") e.rrule = unsupported ? null : p.series.rrule;
  return { ...e, series: true, occurrenceStart: p.slot, changedCount: scope === "following" ? all.filter((o) => Number(o.recurrenceId) >= p.slot!).length : 0, patternUnsupported: unsupported };
}

export interface Input {
  id?: string | null;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  tzid?: string | null;
  location?: string | null;
  description?: string | null;
  rrule?: string | null;
  reminderMin?: number | null;
  scope?: Scope;
  occurrenceStart?: number | null;
}

const fields = (inp: Input) => ({ summary: inp.summary.trim() || "(No title)", location: inp.location ?? null, description: inp.description ?? null, reminderMin: inp.reminderMin ?? null });

/** Save a part of a series; returns the new rows and the event the form shows next. */
export function saveScoped(rows: Row[], inp: Input, scope: Scope, newId: () => string): { rows: Row[]; event: Row } {
  const p = resolve(rows, inp.id ?? "", inp.occurrenceStart ?? null);
  const s = p.series;
  const tz = zoneOf({ allDay: inp.allDay, tzid: s.tzid });
  const zone = inp.allDay ? null : (s.tzid as string | null | undefined) ?? null;
  const dur = s.end - s.start;
  if (scope === "following" && (p.slot === null || p.slot <= s.start)) scope = "series";
  if (scope === "occurrence") {
    if (p.slot === null) throw "CAL_EVENT_NOT_FOUND: event not found";
    const base = p.changed ?? instanceOf(s, p.slot);
    const o: Row = { ...base, id: p.changed?.id ?? newId(), ...fields(inp), start: inp.start, end: inp.end, allDay: inp.allDay, tzid: zone, rrule: null, exdates: [], recurrenceId: String(p.slot), uid: s.uid, series: true, occurrenceStart: p.slot, changedOccurrence: true, instanceStart: undefined, sequence: num(base.sequence) };
    const ser = { ...s, exdates: [...new Set([...exOf(s), p.slot])].sort((a, b) => a - b) };
    return { rows: [...rows.filter((x) => x.id !== o.id && x.id !== s.id), ser, o], event: o };
  }
  if (scope === "following") {
    const slot = p.slot!;
    const sp = splitRule(s, slot);
    if (!sp) throw "CAL_EVENT_NOT_FOUND: event not found";
    const time = inp.allDay !== s.allDay || inp.start !== slot || inp.end !== slot + dur;
    const ruleChanged = signature(s.rrule, s.start, tz) !== signature(inp.rrule ?? null, inp.start, tz);
    const changed = changedOf(rows, s);
    const uid = `${newId()}@mock`;
    const carry = !time && !ruleChanged;
    const moved = (x: number) => shift(x, slot, inp.start, s.allDay, tz);
    const own = changed.map((o) => Number(o.recurrenceId));
    const next: Row = {
      ...s, id: newId(), uid, ...fields(inp), start: inp.start, end: inp.end, allDay: inp.allDay, tzid: zone, rrule: ruleChanged ? inp.rrule ?? null : sp.next,
      exdates: ruleChanged ? [] : exOf(s).filter((e) => e >= slot && !own.includes(e)).map(moved),
      sequence: 0, instanceStart: undefined, occurrenceStart: undefined,
    };
    const carried = carry ? changed.filter((o) => Number(o.recurrenceId) >= slot).map((o) => ({ ...o, uid })) : [];
    next.exdates = [...(next.exdates as number[]), ...carried.map((o) => Number((o as Row).recurrenceId))].sort((a, b) => a - b);
    const old: Row = { ...s, rrule: sp.old, exdates: exOf(s).filter((e) => e < slot) };
    const keep = rows.filter((x) => x.id !== s.id && !(x.uid === s.uid && x.recurrenceId && Number(x.recurrenceId) >= slot));
    return { rows: [...keep, old, next, ...carried], event: { ...next, series: true } };
  }
  // the whole series
  const time = inp.start !== s.start || inp.end !== s.end || inp.allDay !== s.allDay;
  const ruleChanged = signature(s.rrule, s.start, tz) !== signature(inp.rrule ?? null, inp.start, tz);
  const reset = time || ruleChanged;
  const changed = changedOf(rows, s);
  const slotsOwned = changed.map((o) => Number(o.recurrenceId));
  const kept = reset
    ? []
    : changed.map((o) => ({
        ...o,
        summary: o.summary === s.summary ? fields(inp).summary : o.summary,
        location: o.location === s.location ? fields(inp).location : o.location,
        description: o.description === s.description ? fields(inp).description : o.description,
        reminderMin: o.reminderMin === s.reminderMin ? fields(inp).reminderMin : o.reminderMin,
      }));
  const deleted = exOf(s).filter((e) => !slotsOwned.includes(e));
  const exdates = [...(ruleChanged ? [] : time ? deleted.map((e) => shift(e, s.start, inp.start, s.allDay, tz)) : deleted), ...kept.map((o) => Number((o as Row).recurrenceId))].sort((a, b) => a - b);
  const ser: Row = { ...s, ...fields(inp), start: inp.start, end: inp.end, allDay: inp.allDay, tzid: zone, rrule: inp.rrule ? inp.rrule : null, exdates, series: !!inp.rrule };
  return { rows: [...rows.filter((x) => x.id !== s.id && !(x.uid === s.uid && x.calendarId === s.calendarId && x.recurrenceId)), ser, ...kept], event: ser };
}

/** Delete a part of a series. */
export function deleteScoped(rows: Row[], id: string, scope: Scope, slot: number | null): Row[] {
  const p = resolve(rows, id, slot);
  const s = p.series;
  if (scope === "following" && (p.slot === null || p.slot <= s.start)) scope = "series";
  if (scope === "series") return rows.filter((x) => !(x.uid === s.uid && x.calendarId === s.calendarId));
  if (p.slot === null) throw "CAL_EVENT_NOT_FOUND: event not found";
  if (scope === "occurrence") {
    const ser = { ...s, exdates: [...new Set([...exOf(s), p.slot])].sort((a, b) => a - b) };
    return [...rows.filter((x) => x.id !== s.id && x.id !== p.changed?.id), ser];
  }
  const sp = splitRule(s, p.slot);
  const slotN = p.slot;
  const ser: Row = { ...s, rrule: sp ? sp.old : s.rrule, exdates: exOf(s).filter((e) => e < slotN) };
  return [...rows.filter((x) => x.id !== s.id && !(x.uid === s.uid && x.recurrenceId && Number(x.recurrenceId) >= slotN)), ser];
}
