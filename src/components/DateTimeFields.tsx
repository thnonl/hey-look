// Date and time fields that follow the app: the value is written in the language in use and in the Time format setting, typed text is read
// leniently, and a popup offers a month grid / a list of times. They replace <input type="date"> and <input type="time">, which show the
// OS / browser format (10/16/2026, 03:00 AM) whatever the app says. The value stays "yyyy-MM-dd" / "HH:mm" ("" = no date, only where `allowEmpty`).
// Text helpers: src/dateTimeFields.ts (tested by scripts/test-datetime-fields.mjs).
//
// Keyboard (the input): type and press Enter or leave the field to commit, Escape puts the old value back, Up / Down step (date: 1 day, Page Up /
// Page Down 1 month; time: 15 minutes, Shift = 1 minute, Page Up / Page Down 1 hour), Alt+Down or F4 opens the popup. In the popup: arrows move,
// Enter / Space picks, Escape closes (focus goes back to the field), Tab closes and carries on from the field. A press outside closes it
// (tested with contains(), never with blur or focus: WebKit does not focus a button on a mouse click, see pressInside.ts).
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDays, addMonths, Day, dayKey, fmtDayLong, monthGrid, monthTitle, sameDay, systemTz, today, wdNarrow } from "../calendar";
import { addDaysIso, addMonthsIso, addMinutesOfDay, formatDate, formatTime, parseDate, parseTime, readIso, readTime, slotFor, timeSlots } from "../dateTimeFields";
import { useT } from "../i18n/react";
import { menuOwners } from "../pressInside";
import { useStore } from "../store";

type Ref = React.RefObject<HTMLElement | null>;

// ================================================================ popup

/**
 * A panel drawn in a portal on <body> under its field (fixed coordinates, like FloatingMenu): no dialog body, popover or scrolling parent can
 * cut it off. Registered as a menu of its field (pressInside.ts), so a popover around the field does not take a press on it for "outside".
 * Closes on a press outside, Escape, a resize and any scroll outside of it.
 */
function FieldPopup({
  anchor, onClose, role, label, id, minWidth, children, onKeyDown,
}: {
  anchor: Ref;
  onClose: (refocus: boolean) => void;
  role: "dialog" | "listbox";
  label: string;
  id: string;
  minWidth?: number;
  children: ReactNode;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; max: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const p = pop.current?.getBoundingClientRect();
    const b = anchor.current?.getBoundingClientRect();
    if (!p || !b) return;
    const gap = 4;
    const edge = 6;
    if (b.bottom < edge || b.top > window.innerHeight - edge) return close.current(false); // the field was scrolled out of view
    const below = window.innerHeight - edge - (b.bottom + gap);
    const above = b.top - gap - edge;
    const up = p.height > below && (p.height <= above || above > below);
    const room = up ? above : below;
    const raw = up ? b.top - gap - Math.min(p.height, room) : b.bottom + gap;
    const top = Math.max(edge, Math.min(raw, window.innerHeight - edge - Math.min(p.height, room)));
    const left = Math.max(edge, Math.min(b.left, window.innerWidth - p.width - edge));
    setPos({ top, left, max: room });
  }, [anchor]);
  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    menuOwners.set(el, anchor);
    return () => void menuOwners.delete(el);
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!anchor.current?.contains(n) && !pop.current?.contains(n)) close.current(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Esc closes only the popup: the dialog under it must stay
      e.preventDefault();
      close.current(true);
    };
    const gone = () => close.current(false);
    // a scroll that can move the field closes the popup (the dialog body); one inside the popup or in an unrelated area does not
    const scroll = (e: Event) => {
      const n = e.target as Node;
      if (!pop.current?.contains(n) && (n === document || n.contains(anchor.current))) close.current(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", gone);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", gone);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor]);
  const style = pos ? ({ top: pos.top, left: pos.left, "--dd-max": `${pos.max}px` } as React.CSSProperties) : { top: 0, left: 0, opacity: 0 };
  return createPortal(
    <div
      ref={pop}
      id={id}
      className="dd-fixed fld-pop"
      role={role}
      aria-label={label}
      style={{ ...style, minWidth }}
      onKeyDown={(e) => {
        if (e.key === "Tab") return close.current(true); // focus returns to the field and Tab carries on from there
        onKeyDown?.(e);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ================================================================ time list

function TimeList({ value, hour12, onPick }: { value: string; hour12: boolean; onPick: (v: string) => void }) {
  const slots = useMemo(() => timeSlots(value), [value]);
  const [active, setActive] = useState(() => slotFor(slots, value) ?? "00:00");
  const list = useRef<HTMLUListElement>(null);
  const first = useRef(true);
  // the active row has the focus; the list opens with it in the middle
  useEffect(() => {
    const ul = list.current;
    const el = ul?.querySelector<HTMLElement>(`[data-t="${active}"]`);
    if (!ul || !el) return;
    el.focus({ preventScroll: true });
    if (first.current) ul.scrollTop = el.offsetTop - (ul.clientHeight - el.offsetHeight) / 2;
    else if (el.offsetTop < ul.scrollTop) ul.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = el.offsetTop + el.offsetHeight - ul.clientHeight;
    first.current = false;
  }, [active]);
  const move = (to: number) => setActive(slots[Math.max(0, Math.min(slots.length - 1, to))]);
  const onKey = (e: React.KeyboardEvent) => {
    const i = slots.indexOf(active);
    const step: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, PageDown: i + 8, PageUp: i - 8, Home: 0, End: slots.length - 1 };
    if (e.key in step) {
      e.preventDefault();
      move(step[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(active);
    }
  };
  return (
    <ul ref={list} className="fld-times" role="presentation" onKeyDown={onKey}>
      {slots.map((x) => (
        <li
          key={x}
          data-t={x}
          role="option"
          aria-selected={x === value}
          tabIndex={x === active ? 0 : -1}
          className={x === value ? "on" : undefined}
          onClick={() => onPick(x)}
        >
          {formatTime(x, hour12)}
        </li>
      ))}
    </ul>
  );
}

// ================================================================ month grid

function DateGrid({ value, tz, weekStart, onPick }: { value: string; tz?: string; weekStart: number; onPick: (v: string) => void }) {
  const t = useT();
  const todayD = today(tz ?? systemTz());
  const sel = readIso(value);
  const [cursor, setCursor] = useState<Day>(sel ?? todayD);
  const grid = useRef<HTMLTableElement>(null);
  const cells = useMemo(() => monthGrid(cursor, weekStart), [cursor.y, cursor.m, weekStart]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = grid.current?.querySelector<HTMLElement>("button[data-cursor]");
    el?.focus({ preventScroll: true }); // the focus follows the cursor
  }, [cursor]);
  const go = (d: Day) => setCursor(d);
  const onKey = (e: React.KeyboardEvent) => {
    const wd = cells.findIndex((c) => sameDay(c, cursor)) % 7; // (column of the cursor)
    const moves: Record<string, Day> = {
      ArrowLeft: addDays(cursor, -1), ArrowRight: addDays(cursor, 1), ArrowUp: addDays(cursor, -7), ArrowDown: addDays(cursor, 7),
      Home: addDays(cursor, -wd), End: addDays(cursor, 6 - wd),
      PageUp: e.shiftKey ? addMonths(cursor, -12) : addMonths(cursor, -1), PageDown: e.shiftKey ? addMonths(cursor, 12) : addMonths(cursor, 1),
    };
    if (e.key in moves) {
      e.preventDefault();
      go(moves[e.key]);
    } else if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); // "t" = Today, like the calendar
      onPick(dayKey(todayD));
    }
  };
  const month = { y: cursor.y, m: cursor.m, d: 1 };
  return (
    <div className="fld-grid" onKeyDown={onKey}>
      <div className="mini-head">
        <span>{monthTitle(month)}</span>
        <span>
          <button type="button" className="icon-btn" tabIndex={-1} aria-label={t("calendar.prevMonth")} onClick={() => go(addMonths(cursor, -1))}><ChevronLeft size={14} /></button>
          <button type="button" className="icon-btn" tabIndex={-1} aria-label={t("calendar.nextMonth")} onClick={() => go(addMonths(cursor, 1))}><ChevronRight size={14} /></button>
        </span>
      </div>
      <table ref={grid} className="mini-month" role="grid" aria-label={monthTitle(month)}>
        <thead>
          <tr>{Array.from({ length: 7 }, (_, i) => <th key={i} scope="col">{wdNarrow((weekStart + i) % 7)}</th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, w) => (
            <tr key={w}>
              {cells.slice(w * 7, w * 7 + 7).map((d) => {
                const isSel = !!sel && sameDay(d, sel);
                return (
                  <td key={dayKey(d)} aria-selected={isSel}>
                    <button
                      type="button"
                      tabIndex={sameDay(d, cursor) ? 0 : -1}
                      data-cursor={sameDay(d, cursor) ? "" : undefined}
                      className={`${d.m !== cursor.m ? "other" : ""} ${sameDay(d, todayD) ? "today" : ""} ${isSel ? "sel" : ""}`}
                      aria-label={fmtDayLong(d)}
                      aria-current={sameDay(d, todayD) ? "date" : undefined}
                      onClick={() => onPick(dayKey(d))}
                    >
                      {d.d}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="link small fld-today" tabIndex={-1} onClick={() => onPick(dayKey(todayD))}>{t("calendar.today")}</button>
    </div>
  );
}

// ================================================================ the text field

interface FieldProps {
  id?: string;
  /** accessible name of the field (a visible <label htmlFor> works as well) */
  label?: string;
  value: string;
  onChange: (v: string) => void;
  format: (v: string) => string;
  /** typed text -> value, or null; `ref` is the value the field had */
  parse: (text: string, ref: string) => string | null;
  /** value after an arrow key, or null when the key is not a step */
  step: (base: string, e: React.KeyboardEvent) => string | null;
  allowEmpty?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  className: string;
  pickLabel: string;
  icon: ReactNode;
  popup: "dialog" | "listbox";
  renderPopup: (p: { onPick: (v: string) => void }) => ReactNode;
}

function Field(p: FieldProps) {
  const { value, onChange, format, parse } = p;
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popId = useId();
  const [draft, setDraft] = useState<string | null>(null); // what is being typed; null = the formatted value
  const [open, setOpen] = useState(false);
  const fresh = useRef(false); // just focused: the mouse-up of that click must not undo the select-all
  const shown = draft ?? (value ? format(value) : "");
  const typedBad = draft !== null && (draft.trim() === "" ? !p.allowEmpty : parse(draft, value) === null);

  const commit = (text: string) => {
    setDraft(null);
    const v = text.trim() === "" ? (p.allowEmpty ? "" : null) : parse(text, value);
    if (v !== null && v !== value) onChange(v);
  };
  const pick = (v: string) => {
    setOpen(false);
    setDraft(null);
    if (v !== value) onChange(v);
    input.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    fresh.current = false;
    if ((e.key === "ArrowDown" && e.altKey) || e.key === "F4") {
      e.preventDefault();
      if (draft !== null) commit(draft);
      return setOpen(true);
    }
    if (e.key === "Enter") {
      if (draft !== null) (e.preventDefault(), commit(draft));
      return;
    }
    if (e.key === "Escape") {
      if (draft !== null) (e.preventDefault(), e.stopPropagation(), setDraft(null)); // (the dialog stays; a second Esc closes it)
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const base = draft !== null ? parse(draft, value) ?? value : value;
    const next = p.step(base, e);
    if (next !== null) {
      e.preventDefault();
      setDraft(null);
      if (next !== value) onChange(next);
    }
  };
  return (
    <div ref={wrap} className={`dt-field ${p.className}`}>
      <input
        ref={input}
        id={p.id}
        type="text"
        role="combobox"
        aria-haspopup={p.popup}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-keyshortcuts="Alt+ArrowDown"
        aria-label={p.label}
        aria-invalid={p.invalid || typedBad || undefined}
        aria-describedby={p.describedBy}
        autoComplete="off"
        spellCheck={false}
        placeholder={p.placeholder}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(e) => ((fresh.current = true), e.currentTarget.select())}
        onMouseUp={(e) => fresh.current && ((fresh.current = false), e.preventDefault())}
        onBlur={() => ((fresh.current = false), draft !== null && commit(draft))}
      />
      <button type="button" className="dt-pick" tabIndex={-1} title={p.pickLabel} aria-label={p.pickLabel} aria-haspopup={p.popup} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {p.icon}
      </button>
      {open && (
        <FieldPopup
          anchor={wrap}
          id={popId}
          role={p.popup}
          label={p.pickLabel}
          minWidth={p.popup === "listbox" ? wrap.current?.offsetWidth : undefined}
          onClose={(refocus) => (setOpen(false), refocus && input.current?.focus())}
        >
          {p.renderPopup({ onPick: pick })}
        </FieldPopup>
      )}
    </div>
  );
}

// ================================================================ public fields

/** A date in the language in use ("16 Oct 2026", "2026年10月16日"). `value` / `onChange`: "yyyy-MM-dd". */
export function DateField({
  value, onChange, label, id, tz, allowEmpty, invalid, describedBy, placeholder, className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  id?: string;
  /** zone of "today" in the grid (default: this computer's) */
  tz?: string;
  allowEmpty?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  className?: string;
}) {
  const t = useT();
  const weekStart = useStore((s) => s.prefs.weekStart);
  const todayIso = dayKey(today(tz ?? systemTz()));
  return (
    <Field
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      format={formatDate}
      parse={parseDate}
      step={(base, e) => {
        const from = readIso(base) ? base : todayIso;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") return addDaysIso(from, e.key === "ArrowUp" ? 1 : -1);
        if (e.key === "PageUp" || e.key === "PageDown") return addMonthsIso(from, e.key === "PageUp" ? 1 : -1);
        return null;
      }}
      allowEmpty={allowEmpty}
      invalid={invalid}
      describedBy={describedBy}
      placeholder={placeholder ?? (allowEmpty ? formatDate(todayIso) : undefined)} // (an optional date shows what to type)
      className={`dt-date ${className}`}
      pickLabel={t("calendar.dialog.pickDate")}
      icon={<CalendarDays size={14} aria-hidden />}
      popup="dialog"
      renderPopup={({ onPick }) => <DateGrid value={value} tz={tz} weekStart={weekStart} onPick={onPick} />}
    />
  );
}

/** A time of day in the Time format setting ("15:30" or "3:30 PM"). `value` / `onChange`: "HH:mm". */
export function TimeField({
  value, onChange, label, id, invalid, describedBy, className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}) {
  const t = useT();
  const hour12 = useStore((s) => s.prefs.timeFormat === "12");
  return (
    <Field
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      format={(v) => formatTime(v, hour12)}
      parse={(text) => parseTime(text)}
      step={(base, e) => {
        const from = readTime(base) === null ? "09:00" : base;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") return addMinutesOfDay(from, (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 1 : 15));
        if (e.key === "PageUp" || e.key === "PageDown") return addMinutesOfDay(from, e.key === "PageUp" ? 60 : -60);
        return null;
      }}
      invalid={invalid}
      describedBy={describedBy}
      className={`dt-time ${className}`}
      pickLabel={t("calendar.dialog.pickTime")}
      icon={<Clock size={14} aria-hidden />}
      popup="listbox"
      renderPopup={({ onPick }) => <TimeList value={value} hour12={hour12} onPick={onPick} />}
    />
  );
}
