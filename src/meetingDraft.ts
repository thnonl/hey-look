// The meeting switch of Compose when a message is saved (v1.0.6 QA round 3, BUG-R3-4: Save draft, then opening the draft again, lost the meeting).
// What Compose holds for a meeting is a handful of date / time / place fields; they are kept in three places, all in the form below:
//   - the draft that Save draft puts in the Drafts folder: a private header `X-HeyLook-Meeting` with the form as base64url JSON (src-tauri/src/draftmail.rs;
//     the header is written for DRAFT copies only, never into a message that is sent), and a copy on this computer by Message-ID for a server that drops it;
//   - the crash-recovery snapshot (recovery.ts): the form as an object;
//   - a message that moves to a window of its own, or comes back after Undo: the same blob inside the draft.
// Pure functions only (no React, no Tauri), so scripts/test-meeting-draft.mjs runs them as they are. The text is checked on the way in: whatever
// does not look exactly like a form we wrote is ignored (the draft opens without a meeting, as before).

/** The fields of the meeting strip (components/MeetingStrip.tsx MeetingState), as typed in its inputs. */
export interface MeetingForm {
  sd: string;
  st: string;
  ed: string;
  et: string;
  allDay: boolean;
  where: string;
}

/** The form with the time zone its date and time fields were written in. */
export interface MeetingWire extends MeetingForm {
  tz: string;
}

/** The longest value written (a bigger one is left out, the draft is saved without a meeting form rather than with a broken one); the backend reads up to 4096. */
export const MEETING_MAX = 2048;
/** The longest place kept (the rest is cut). */
export const WHERE_MAX = 400;

const DATE = /^(\d{4}-\d{2}-\d{2})?$/;
const TIME = /^(\d{2}:\d{2})?$/;
const ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;
// (control characters never belong in a place: they would only come from a paste)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** The form as a plain object, or null when it is not one of ours (the snapshot reads it with this, and `decodeMeeting` after the base64). */
export function readMeetingWire(v: unknown): MeetingWire | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const { sd, st, ed, et, allDay, where, tz } = o;
  if (typeof sd !== "string" || typeof st !== "string" || typeof ed !== "string" || typeof et !== "string") return null;
  if (!DATE.test(sd) || !DATE.test(ed) || !TIME.test(st) || !TIME.test(et)) return null;
  if (typeof allDay !== "boolean" || typeof where !== "string" || typeof tz !== "string" || !ZONE.test(tz)) return null;
  return { sd, st, ed, et, allDay, where: where.replace(CONTROL, " ").slice(0, WHERE_MAX), tz };
}

/** The form of the strip as an object for the snapshot (the place cut to its limit). */
export function meetingWire(m: MeetingForm, tz: string): MeetingWire {
  return { sd: m.sd, st: m.st, ed: m.ed, et: m.et, allDay: !!m.allDay, where: m.where.replace(CONTROL, " ").slice(0, WHERE_MAX), tz };
}

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The form for the draft's header: base64url of `{"v":1,...}`; undefined when it would be bigger than `MEETING_MAX` or is not valid. */
export function encodeMeeting(m: MeetingForm, tz: string): string | undefined {
  const w = readMeetingWire(meetingWire(m, tz));
  if (!w) return undefined;
  const blob = b64url(new TextEncoder().encode(JSON.stringify({ v: 1, ...w })));
  return blob.length <= MEETING_MAX ? blob : undefined;
}

/** The form out of a draft's header value (or the copy kept for it); null for anything that is not exactly what `encodeMeeting` writes. */
export function decodeMeeting(blob: string | null | undefined): MeetingWire | null {
  if (typeof blob !== "string") return null;
  const s = blob.replace(/\s+/g, "");
  if (!s || s.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
    const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { v?: unknown };
    return o && typeof o === "object" && o.v === 1 ? readMeetingWire(o) : null;
  } catch {
    return null;
  }
}

/** What the calendar helpers (src/calendar.ts) do; passed in so this file needs none of the app. */
export interface ZoneIo {
  fromInputs(date: string, time: string, tz: string, allDay?: boolean): number | null;
  toInputs(sec: number, tz: string): { date: string; time: string };
}

/**
 * The strip's fields for a form that was written in zone `w.tz`, shown in zone `tz`: the same moments, so a draft saved before the calendar's time zone
 * was changed still means the same hour. An all-day meeting has no time and stays on its dates; a form that cannot be converted (an empty field) stays as typed.
 */
export function restoreMeeting(w: MeetingWire, tz: string, io: ZoneIo): MeetingForm {
  const same: MeetingForm = { sd: w.sd, st: w.st, ed: w.ed, et: w.et, allDay: w.allDay, where: w.where };
  if (w.allDay || w.tz === tz) return same;
  const s = io.fromInputs(w.sd, w.st, w.tz);
  const e = io.fromInputs(w.ed, w.et, w.tz);
  if (s === null || e === null) return same;
  const a = io.toInputs(s, tz);
  const b = io.toInputs(e, tz);
  return { sd: a.date, st: a.time, ed: b.date, et: b.time, allDay: false, where: w.where };
}
