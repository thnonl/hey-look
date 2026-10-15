// The "support the project" nudge: WHEN it is due and WHEN it may appear. Pure logic only: the clock and the random source are passed in,
// so a plain Node script tests it (scripts/test-support-nudge.mjs). The toast itself is drawn by supportNudgeHost.ts.
// All times are milliseconds since the epoch. Nothing here leaves the computer.

/** What is stored (inside the preferences, key `supportNudge`). */
export interface NudgeState {
  /** the "Occasional support reminder" switch in Settings > General */
  enabled: boolean;
  /** when the app was first used (the first start after the feature appeared, or the age of the local database for an older install) */
  firstRunAt: number | null;
  /** the nudge is due from this moment on; set once, then moved on every time it is shown or answered */
  nextDueAt: number | null;
  /** when it was last shown (kept for the record; nothing reads it to decide) */
  lastShownAt: number | null;
}

export const DEFAULT_NUDGE: NudgeState = { enabled: true, firstRunAt: null, nextDueAt: null, lastShownAt: null };

/** The first nudge comes between day 7 and day 30 (inclusive) after the first run. */
export const FIRST_MIN_DAYS = 7;
export const FIRST_MAX_DAYS = 30;
/** Calendar months until the next nudge: after it was shown, and after "Buy me a coffee" was pressed. */
export const REPEAT_MONTHS = 2;
export const SUPPORTED_MONTHS = 6;
/** The app must have been open this long (this session) before a nudge may appear. */
export const MIN_SESSION_MS = 2 * 60_000;
/** The toast goes away by itself after this long. */
export const SHOW_MS = 15_000;

const DAY = 86_400_000;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Stored value -> a complete state; anything missing or odd (older versions, hand-edited files) gets the default. */
export function normalizeNudge(raw: unknown): NudgeState {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: o.enabled !== false,
    firstRunAt: isTime(o.firstRunAt) ? o.firstRunAt : null,
    nextDueAt: isTime(o.nextDueAt) ? o.nextDueAt : null,
    lastShownAt: isTime(o.lastShownAt) ? o.lastShownAt : null,
  };
}

/**
 * `ms` plus `n` calendar months in the local time zone, keeping the time of day; a day the target month does not have becomes its last day
 * (31 December + 2 months = 28 / 29 February).
 */
export function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(d.getDate(), last));
  return first.getTime();
}

/**
 * Makes sure the first-run date and the first due date exist. `hint` is the age of the local database file when the system can tell
 * (an install from before this feature has no stored first-run date); without it, or when it is in the future, "now" is the first run.
 * `random()` is Math.random in the app: the day count is drawn ONCE (7..30) and the result is stored. Returns the same object when
 * nothing had to be set.
 */
export function ensureSchedule(s: NudgeState, now: number, hint: number | null, random: () => number): NudgeState {
  let { firstRunAt, nextDueAt } = s;
  if (firstRunAt === null) firstRunAt = hint !== null && isTime(hint) && hint <= now ? hint : now;
  if (nextDueAt === null) {
    const span = FIRST_MAX_DAYS - FIRST_MIN_DAYS + 1;
    const r = Math.floor(random() * span);
    const days = FIRST_MIN_DAYS + (Number.isFinite(r) ? Math.min(span - 1, Math.max(0, r)) : 0);
    nextDueAt = firstRunAt + days * DAY;
  }
  return firstRunAt === s.firstRunAt && nextDueAt === s.nextDueAt ? s : { ...s, firstRunAt, nextDueAt };
}

/** What the app is doing right now. */
export interface Moment {
  /** the window is shown and has the focus */
  focused: boolean;
  /** how long this run of the app has been open */
  sessionMs: number;
  /** a message is being written (Compose open) */
  composing: boolean;
  /** a dialog, question, passphrase prompt or the command bar is open */
  modalOpen: boolean;
  /** another toast is on screen */
  toastShowing: boolean;
  /** a send, an update download or an attachment download is under way */
  busy: boolean;
}

/** A calm moment: nothing is in the way. */
export function isCalm(m: Moment): boolean {
  return m.focused && m.sessionMs >= MIN_SESSION_MS && !m.composing && !m.modalOpen && !m.toastShowing && !m.busy;
}

/** "show" = show it now; "wait" = it is due but this is not a calm moment (it stays due); "none" = not due, or switched off. */
export function decide(s: NudgeState, now: number, m: Moment): "show" | "wait" | "none" {
  if (!s.enabled || s.nextDueAt === null || now < s.nextDueAt) return "none";
  return isCalm(m) ? "show" : "wait";
}

/** The toast was shown (counts at once, even when nobody reacts): the next one is due in 2 months, so one due date never shows twice. */
export function shown(s: NudgeState, now: number): NudgeState {
  return { ...s, lastShownAt: now, nextDueAt: addMonths(now, REPEAT_MONTHS) };
}

/** "Buy me a coffee" was pressed: the next one is due in 6 months. */
export function supported(s: NudgeState, now: number): NudgeState {
  return { ...s, nextDueAt: addMonths(now, SUPPORTED_MONTHS) };
}

/** The switch in Settings (and "Don't remind me again", which is the same switch turned off). Turning it on after a long pause does not show a toast at once. */
export function setEnabled(s: NudgeState, enabled: boolean, now: number): NudgeState {
  if (enabled === s.enabled) return s;
  if (!enabled) return { ...s, enabled: false };
  const later = addMonths(now, REPEAT_MONTHS);
  return { ...s, enabled: true, nextDueAt: s.nextDueAt === null || s.nextDueAt < later ? later : s.nextDueAt };
}
