import { CalendarClock, Clock, Send } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { osNow, usePlatform } from "../platform";
import { useStore } from "../store";
import { scheduleKeepKey } from "../trayWords";
import { formatTime } from "../dateTimeFields";
import { DateField, TimeField } from "./DateTimeFields";
import { fmtIn, fmtWhen, parseLocal, snoozePresets, zoneLabel } from "../util";

const MAX_AHEAD = 366 * 24 * 3600;

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The check behind the custom date/time: an error blocks scheduling, a warning does not. */
export function checkSchedule(date: string, time: string, now = Date.now()): { ts: number | null; error?: string; warn?: string; adjusted?: string } {
  const ts = parseLocal(date, time);
  if (ts === null) return { ts: null, error: date && time ? t("compose.schedule.realDate") : undefined };
  const d = new Date(ts * 1000);
  // a time that does not exist (clock change) is moved forward by the browser; say so
  const adjusted = toTimeInput(d) !== time ? toTimeInput(d) : undefined;
  if (ts * 1000 < now - 60 * 1000) return { ts: null, error: t("compose.schedule.passed"), adjusted };
  if (ts * 1000 > now + MAX_AHEAD * 1000) return { ts: null, error: t("compose.schedule.withinYear"), adjusted };
  if (ts * 1000 < now + 60 * 1000) return { ts, warn: t("compose.schedule.almostNow"), adjusted };
  return { ts, adjusted };
}

/**
 * "Send later": exact presets with the time they mean, a custom date and time with validation, the time zone
 * the time is read in, and a note about closed-app behaviour. Used by Compose and by "Change time".
 */
export function SchedulePicker({
  initial,
  onPick,
  onSendNow,
  primaryLabel,
  busy = false,
  onCancel,
  currentLabel,
}: {
  /** prefill the custom date and time with this time (Change time) */
  initial?: number;
  onPick: (ts: number) => void;
  onSendNow?: () => void;
  primaryLabel?: string;
  busy?: boolean;
  onCancel?: () => void;
  /** e.g. "Now: Tue 13 Oct, 08:00" */
  currentLabel?: string;
}) {
  const t = useT();
  const uid = useId();
  const prefs = useStore((s) => s.prefs);
  const keepKey = scheduleKeepKey(osNow(), usePlatform((s) => s.tray));
  const start = initial ? new Date(initial * 1000) : new Date(Date.now() + 60 * 60 * 1000);
  const [date, setDate] = useState(toDateInput(start));
  const [time, setTime] = useState(toTimeInput(start));
  const [, tick] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  const presets = useMemo(
    () =>
      snoozePresets(prefs.snoozeTimes)
        .filter((p) => p.ts * 1000 > Date.now() + 60 * 1000)
        .map((p) => ({ ...p, label: p.label.replace(/\s*\(.*\)$/, "") })),
    [prefs.snoozeTimes],
  );

  const check = checkSchedule(date, time);
  const valid = check.ts !== null && !check.error;

  const onKey = (e: React.KeyboardEvent) => {
    // up / down move between the presets, like a menu
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>(".sched-presets .menu-row") ?? []);
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (rows.length === 0) return;
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      rows[i === -1 ? 0 : next]?.focus();
    }
  };

  return (
    <div ref={wrap} role="dialog" aria-label={t("compose.schedule.title")} onKeyDown={onKey} className="sched-picker">
      <div className="sb-title">{t("compose.schedule.title")}</div>
      <div className="sched-tz" title={t("compose.schedule.tzTip")}>
        <Clock size={12} aria-hidden /> {t("compose.schedule.times", { zone: zoneLabel() })}
      </div>
      <div className="sched-presets">
        {presets.map((p) => (
          <button key={p.label} className="menu-row" disabled={busy} onClick={() => onPick(p.ts)}>
            <CalendarClock size={14} aria-hidden />
            <span className="menu-lbl">{p.label}</span>
            <span className="menu-hint">{fmtWhen(p.ts)}</span>
          </button>
        ))}
      </div>
      <div className="sched-custom">
        <div className="row-inline" style={{ margin: 0 }}>
          <div className="sched-fld date">
            <label htmlFor={`${uid}-date`}>{t("compose.schedule.date")}</label>
            <DateField
              id={`${uid}-date`}
              value={date}
              invalid={!!check.error}
              describedBy={check.error ? "sched-err" : undefined}
              onChange={(v) => (setDate(v), tick((n) => n + 1))}
            />
          </div>
          <div className="sched-fld time">
            <label htmlFor={`${uid}-time`}>{t("compose.schedule.time")}</label>
            <TimeField
              id={`${uid}-time`}
              value={time}
              invalid={!!check.error}
              describedBy={check.error ? "sched-err" : undefined}
              onChange={(v) => (setTime(v), tick((n) => n + 1))}
            />
          </div>
        </div>
        {check.ts !== null && (
          <div className="sched-sum" aria-live="polite">
            {tx("compose.schedule.sends", { when: <b>{fmtWhen(check.ts)}</b> }, { in: fmtIn(check.ts) })}
            {check.adjusted && <span className="muted"> · {t("compose.schedule.adjusted", { time: formatTime(check.adjusted, prefs.timeFormat === "12") })}</span>}
          </div>
        )}
        {check.error && (
          <div id="sched-err" className="field-err" role="alert">
            {check.error}
            {onSendNow && (
              <button className="link" onClick={onSendNow}>{t("compose.schedule.sendNow")}</button>
            )}
          </div>
        )}
        {check.warn && <div className="note" style={{ color: "var(--warn)" }}>{check.warn}</div>}
        <div className="row-inline sched-actions">
          {onCancel && <button className="btn small" onClick={onCancel}>{t("common.cancel")}</button>}
          <button className="btn primary small" disabled={!valid || busy} onClick={() => check.ts !== null && onPick(check.ts)}>
            <CalendarClock size={13} /> {primaryLabel ?? t("compose.schedule.button")}
          </button>
        </div>
      </div>
      {currentLabel && <div className="sched-picker-foot">{currentLabel}</div>}
      <div className="sched-picker-foot">
        {t("compose.schedule.foot")}
        {!prefs.closeToTray && (
          <div className="warn">
            {t("compose.schedule.quitWarning")}
            {keepKey && (
              <>
                {" "}
                <button className="link" onClick={() => useStore.getState().setPrefs({ closeToTray: true })}>{t(keepKey)}</button>
              </>
            )}
          </div>
        )}
      </div>
      {onSendNow && !check.error && (
        <button className="link small" style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={onSendNow}>
          <Send size={12} /> {t("compose.schedule.sendNowInstead")}
        </button>
      )}
    </div>
  );
}
