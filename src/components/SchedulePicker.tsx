import { CalendarClock, Clock, Send } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { fmtIn, fmtWhen, parseLocal, snoozePresets, zoneLabel } from "../util";

const MAX_AHEAD = 366 * 24 * 3600;

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The check behind the custom date/time: an error blocks scheduling, a warning does not. */
export function checkSchedule(date: string, time: string, now = Date.now()): { ts: number | null; error?: string; warn?: string; adjusted?: string } {
  const ts = parseLocal(date, time);
  if (ts === null) return { ts: null, error: date && time ? "Pick a real date and time." : undefined };
  const d = new Date(ts * 1000);
  // a time that does not exist (clock change) is moved forward by the browser; say so
  const adjusted = toTimeInput(d) !== time ? toTimeInput(d) : undefined;
  if (ts * 1000 < now - 60 * 1000) return { ts: null, error: "That time has passed. Pick a later time, or send now.", adjusted };
  if (ts * 1000 > now + MAX_AHEAD * 1000) return { ts: null, error: "Pick a date within a year.", adjusted };
  if (ts * 1000 < now + 60 * 1000) return { ts, warn: "That’s less than a minute away — it will be sent almost immediately.", adjusted };
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
  primaryLabel = "Schedule",
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
  const prefs = useStore((s) => s.prefs);
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
    <div ref={wrap} role="dialog" aria-label="Send later" onKeyDown={onKey} className="sched-picker">
      <div className="sb-title">Send later</div>
      <div className="sched-tz" title="The time you pick is read in this time zone">
        <Clock size={12} aria-hidden /> Times in {zoneLabel()}
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
          <label>
            Date
            <input
              type="date"
              value={date}
              aria-invalid={!!check.error || undefined}
              aria-describedby={check.error ? "sched-err" : undefined}
              onChange={(e) => (setDate(e.target.value), tick((n) => n + 1))}
            />
          </label>
          <label>
            Time
            <input
              type="time"
              value={time}
              aria-invalid={!!check.error || undefined}
              aria-describedby={check.error ? "sched-err" : undefined}
              onChange={(e) => (setTime(e.target.value), tick((n) => n + 1))}
            />
          </label>
        </div>
        {check.ts !== null && (
          <div className="sched-sum" aria-live="polite">
            Sends <b>{fmtWhen(check.ts)}</b> · {fmtIn(check.ts)}
            {check.adjusted && <span className="muted"> · Adjusted to {check.adjusted} (clock change).</span>}
          </div>
        )}
        {check.error && (
          <div id="sched-err" className="field-err" role="alert">
            {check.error}
            {onSendNow && (
              <button className="link" onClick={onSendNow}>Send now</button>
            )}
          </div>
        )}
        {check.warn && <div className="note" style={{ color: "var(--warn)" }}>{check.warn}</div>}
        <div className="row-inline" style={{ margin: 0, justifyContent: "flex-end" }}>
          {onCancel && <button className="btn small" onClick={onCancel}>Cancel</button>}
          <button className="btn primary small" disabled={!valid || busy} onClick={() => check.ts !== null && onPick(check.ts)}>
            <CalendarClock size={13} /> {primaryLabel}
          </button>
        </div>
      </div>
      {currentLabel && <div className="sched-picker-foot">{currentLabel}</div>}
      <div className="sched-picker-foot">
        Hey Look! sends from this computer. If it’s closed at that time, the message goes out the next time you open it.
        {!prefs.closeToTray && (
          <div className="warn">
            Closing the window quits Hey Look!, so this message only goes out when you open it again.{" "}
            <button className="link" onClick={() => useStore.getState().setPrefs({ closeToTray: true })}>Keep running in the tray</button>
          </div>
        )}
      </div>
      {onSendNow && !check.error && (
        <button className="link small" style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={onSendNow}>
          <Send size={12} /> Send now instead
        </button>
      )}
    </div>
  );
}
