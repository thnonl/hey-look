import { fromInputs, nextHour, toInputs } from "../calendar";
import { t, type Key } from "../i18n";
import { useT } from "../i18n/react";
import { DateField, TimeField } from "./DateTimeFields";
import { moveStart } from "../dateTimeFields";
import { Switch } from "./ui";
// The meeting strip of the composer (Compose.tsx). Apart from Calendar.tsx so the editor does not pull the calendar views in (WP9d).
// =============================================================== meeting strip (Compose)

export interface MeetingState {
  sd: string;
  st: string;
  ed: string;
  et: string;
  allDay: boolean;
  where: string;
}

export function defaultMeeting(tz: string, init?: { start?: number; end?: number; allDay?: boolean; location?: string | null }): MeetingState {
  const s = init?.start ?? nextHour(tz);
  const e = init?.end ?? s + 3600;
  return { sd: toInputs(s, tz).date, st: toInputs(s, tz).time, ed: toInputs(e, tz).date, et: toInputs(e, tz).time, allDay: !!init?.allDay, where: init?.location ?? "" };
}

/** The meeting of a draft, or the reason it can't be sent. */
export function meetingToDraft(m: MeetingState, tz: string): { meeting: { start: number; end: number; allDay: boolean; tzid: string | null; location: string | null } } | { error: string; errorKey: Key } {
  const s = fromInputs(m.sd, m.st, tz, m.allDay);
  const e = fromInputs(m.ed, m.et, tz, m.allDay);
  if (s === null || e === null) return { error: t("calendar.meeting.errDate"), errorKey: "calendar.meeting.errDate" };
  const end = m.allDay ? e + 86400 : e;
  if (end <= s) return { error: t("calendar.meeting.errEnd"), errorKey: "calendar.meeting.errEnd" };
  return { meeting: { start: s, end, allDay: m.allDay, tzid: m.allDay ? null : tz, location: m.where.trim() || null } };
}

export function MeetingStrip({ value, onChange, tz }: { value: MeetingState; onChange: (m: MeetingState) => void; tz: string }) {
  const t = useT();
  const set = (p: Partial<MeetingState>) => onChange({ ...value, ...p });
  // shown next to the fields as soon as the times can't work, not only when Send is pressed
  const bad = meetingToDraft(value, tz);
  const problem = "error" in bad && bad.error === t("calendar.meeting.errEnd") ? t("calendar.endBeforeStart") : null;
  return (
    <div className="cp-event" role="group" aria-label={t("calendar.meeting.details")}>
      <label htmlFor="mt-sd">{t("calendar.dialog.when")}</label>
      <div className="when">
        <DateField id="mt-sd" label={t("calendar.dialog.startDate")} tz={tz} value={value.sd} onChange={(v) => set(moveStart(value, { sd: v }, value.allDay))} />
        {!value.allDay && <TimeField label={t("calendar.dialog.startTime")} value={value.st} onChange={(v) => set(moveStart(value, { st: v }, false))} />}
        <span className="muted">–</span>
        {!value.allDay && <TimeField label={t("calendar.dialog.endTime")} invalid={!!problem} value={value.et} onChange={(v) => set({ et: v })} />}
        <DateField label={t("calendar.dialog.endDate")} tz={tz} invalid={!!problem} value={value.ed} onChange={(v) => set({ ed: v })} />
        <Switch checked={value.allDay} onChange={(v) => set({ allDay: v })} label={t("calendar.allDay")} />
        <span className="tz">{value.allDay ? "" : tz}</span>
      </div>
      {problem && (
        <div className="field-err" role="alert" style={{ gridColumn: "2" }}>{problem}</div>
      )}
      <label htmlFor="mt-where">{t("calendar.dialog.where")}</label>
      <input autoComplete="off" id="mt-where" value={value.where} onChange={(e) => set({ where: e.target.value })} placeholder={t("calendar.dialog.wherePlaceholder")} />
    </div>
  );
}
