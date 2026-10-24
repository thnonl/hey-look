import { CalendarCheck, CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, CircleCheck, Clock, Copy, Download, ExternalLink, FolderInput, MapPin, Mail, Pencil, Repeat, Trash2, TriangleAlert, UserRound, Video, X } from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, CalEvent, CalEventDetail, CalendarInfo, errorCode, Rsvp, SeriesScope } from "../api";
import { addDays, addMonths, chipClass, cmpDay, Day, dayKey, dayOfMs, dayStartMs, daysBetween, eventColor, eventDaySpan, eventLabel, eventsOnDay, fmtClock, fmtClockRange, fmtDayLong, fmtDayMonth, fmtDayShort, fmtRange, fmtTime, fromInputs, isUrl, joinLabel, joinShortName, layoutDay, monthGrid, monthTitle, myStatusLabel, partsOf, personName, nextHour, repeatKind, repeatRule, sameDay, today, toInputs, tzOffsetLabel, weekDays, weekStartOf, weekTitle, wdLong, wdNarrow, wdShort, CalView, MY_EVENTS_COLOR } from "../calendar";
import { accountColor } from "../prefs";
import { HOUR_PX_MAX, hourHeight, minuteFromY } from "../weekHours";
import { calendarOffer, calendarTitle, foldTarget, sidebarCalendars, defaultCalendar, deleteConfirm, isSyncedCalendarId, pausedSources, readOnlyNote, serviceName, writableCalendars } from "../calendarSync";
import { deletedToast, dialogTitleKey, needsResetQuestion, savedToastKey, scopeAsk, scopeNote, slotOf } from "../calendarSeries";
import { friendlyError, EventInit, useStore } from "../store";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { DateField, TimeField } from "./DateTimeFields";
import { moveStart } from "../dateTimeFields";
import { RecipientField } from "./RecipientField";
import { EmptyState } from "./overlays";
import { Modal, Switch, useOutside } from "./ui";
import { bare, EMAIL, nameOf, useAccountColor, useTz } from "./InviteCard";
import { newEvent } from "../newEvent";
import { openPopout } from "../popout/open";
import { shiftNow } from "../popout/modifier";
import { eventKey } from "../popout/windowKinds";
import { guestsBlock, moveTargets } from "../calendarMove";
import { MoveDialog } from "./MoveDialog";
// =============================================================== calendar module

function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

interface PopState {
  ev: CalEvent;
  rect: DOMRect;
  /** the chip, block or row that opened it: the focus goes back to it */
  el: HTMLElement;
}

/**
 * Whether the edit dialog applies to an event: My events, and the events of a synced calendar unless the calendar or the service says read only. An invitation
 * (answered with its buttons) and an event of a read-only calendar are not edited; they show their details.
 */
const canEditEvent = (ev: Pick<CalEvent, "calendarId" | "readOnly">) => ev.calendarId === "local" || (isSyncedCalendarId(ev.calendarId) && !ev.readOnly);

/**
 * What Edit does: the popover's Edit button, a double-click on an event and Ctrl/Cmd+Enter on it. An event of a series asks first which part to open: this occurrence, this and the
 * following ones, or the whole series (W7.1, REQ-7.1.1); Cancel and Esc open nothing and resolve false.
 */
async function openEventForEdit(ev: CalEvent): Promise<boolean> {
  // Shift + double-click or Shift+Enter: the event opens in a window of its own (W4.6); opening it again focuses that window (the key is read now, the question comes first)
  const alone = shiftNow();
  let scope: SeriesScope | undefined;
  if (ev.series) {
    const a = await useStore.getState().choose(scopeAsk("open", ev));
    if (a === "cancel") return false;
    scope = a as SeriesScope;
  }
  const occurrenceStart = scope ? (slotOf(ev) ?? null) : null;
  if (alone) {
    void openPopout("event", eventKey(ev.id, scope, occurrenceStart), { eventId: ev.id, scope, occurrenceStart });
    return true;
  }
  useStore.getState().setDialog({ type: "event", eventId: ev.id, scope, occurrenceStart });
  return true;
}

/** The zone the repeat rule of an event is worked out in: the zone of its series, else the one the calendar shows. */
const ruleZone = (e: Pick<CalEvent, "allDay" | "tzid">, tz: string) => (!e.allDay && e.tzid ? e.tzid : tz);

/** The day of the occurrence an event stands for, in the zone of its series (a date of its own for an all-day series). */
function occurrenceDay(ev: Pick<CalEvent, "allDay" | "tzid" | "occurrenceStart" | "start">, appTz: string): Day {
  const ms = (ev.occurrenceStart ?? ev.start) * 1000;
  return ev.allDay ? dayOfMs(ms, "UTC") : dayOfMs(ms, ev.tzid ?? appTz);
}

/**
 * Delete an event, or one part of its series, after the questions it needs: the part of a series (REQ-7.1.1, the question also stands for the confirmation; a synced calendar's
 * sentence about the guests is in it), whether to send the cancellation for an event you organize, or the plain confirmation of a single event. Resolves true when the delete was
 * made. `say` shows a toast where the person looks (an event window has its toast made in the main window).
 */
async function deleteEventAsked(ev: CalEvent, cal: Pick<CalendarInfo, "name" | "service" | "appInvites"> | undefined, appTz: string, say: (text: () => string, kind: "success" | "error") => void): Promise<"done" | "failed" | "cancelled"> {
  const st = useStore.getState();
  const others = ev.attendees.filter((a) => a.role !== "chair").length;
  const synced = isSyncedCalendarId(ev.calendarId);
  let scope: SeriesScope | undefined;
  if (ev.series) {
    const a = await st.choose(scopeAsk("delete", ev, synced ? deleteConfirm(cal?.name ?? "", cal?.service, others).body : null));
    if (a === "cancel") return "cancelled";
    scope = a as SeriesScope;
  }
  let notify = false;
  if ((ev.calendarId === "local" || cal?.appInvites) && ev.myStatus === "organizer" && others > 0) {
    const c = await st.choose({
      title: t("calendar.pop.cancelTitle", { n: others }),
      body: t("calendar.pop.cancelBody"),
      choices: [
        { id: "keep", label: t("calendar.pop.keep") },
        { id: "silent", label: t("calendar.pop.deleteSilent"), kind: "danger" },
        { id: "send", label: t("calendar.pop.sendCancellation"), kind: "primary" },
      ],
    });
    if (c === "keep") return "cancelled";
    notify = c === "send";
  } else if (!ev.series) {
    if (synced && !cal?.appInvites) {
      // the service sends the cancellation to the guests, this app sends no mail for these events
      const del = deleteConfirm(cal?.name ?? "", cal?.service, others);
      if (!(await st.confirm({ ...del, confirmLabel: t("common.delete"), danger: true }))) return "cancelled";
    } else if (!(await st.confirm({ title: t("calendar.pop.deleteTitle", { summary: ev.summary }), confirmLabel: t("common.delete"), danger: true }))) return "cancelled";
  }
  const day = occurrenceDay(ev, appTz);
  try {
    await api.calendarDeleteEvent(ev.id, notify, scope, scope ? slotOf(ev) ?? null : null);
    say(() => deletedToast(scope, fmtDayLong(day)) ?? (notify ? t("calendar.toast.cancelledNotified") : t("calendar.toast.deleted")), "success");
  } catch (e) {
    say(() => friendlyError(e), "error");
    return "failed";
  }
  return "done";
}

/** Opens the New event dialog on a day (at 09:00 – 10:00) or at an exact time. */
function newOnDay(day: Day, tz: string, hour = 9, minute = 0) {
  const start = Math.floor(dayStartMs(day, tz) / 1000) + hour * 3600 + minute * 60;
  newEvent({ start, end: start + 3600 });
}

const VIEW_KEYS = { month: ["calendar.view.month", "calendar.view.monthTip"], week: ["calendar.view.week", "calendar.view.weekTip"], agenda: ["calendar.view.agenda", "calendar.view.agendaTip"] } as const;

export function CalendarView() {
  const t = useT();
  const { prefs, calDate, calEvents, calendars, calLoading, calError, loadCalendar, setCalDate, setCalView, accounts, dialog } = useStore();
  const tz = useTz();
  const view: CalView = prefs.calView;
  const [pop, setPop] = useState<PopState | null>(null);
  // the event the Move dialog is open for (W7.5)
  const [moving, setMoving] = useState<{ ev: CalEvent; el: HTMLElement } | null>(null);
  const [focus, setFocus] = useState<Day>(calDate);
  const color = useAccountColor();
  const now = useNow();
  const todayD = today(tz);

  useEffect(() => {
    void loadCalendar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, prefs.weekStart, prefs.calTz]);
  useEffect(() => setFocus(calDate), [calDate]);
  // opening the Calendar asks the synced calendars for news (the backend skips a mailbox that synced in the last minute)
  useEffect(() => void api.calendarSyncNow(null, true).catch(() => undefined), []);

  const events = useMemo(
    () => calEvents.filter((e) => prefs.calShowDeclined || e.myStatus !== "declined"),
    [calEvents, prefs.calShowDeclined],
  );

  const step = (dir: 1 | -1) => setCalDate(view === "month" ? addMonths(calDate, dir) : view === "week" ? addDays(calDate, 7 * dir) : addDays(calDate, 30 * dir));
  const title = view === "month" ? monthTitle(calDate) : view === "week" ? weekTitle(weekDays(calDate, prefs.weekStart)) : t("calendar.fromDay", { day: fmtDayLong(calDate) });
  const openPop = (ev: CalEvent, el: HTMLElement) => setPop({ ev, rect: el.getBoundingClientRect(), el });
  // a double-click or Ctrl/Cmd+Enter on an event, and the popover's Edit: the edit dialog, or the details when this event cannot be edited
  const editOrigin = useRef<HTMLElement | null>(null);
  const edit = (ev: CalEvent, el: HTMLElement) => {
    if (!canEditEvent(ev)) return openPop(ev, el);
    editOrigin.current = el;
    setPop(null);
    // (a question comes first for a series: when it is cancelled the focus goes back to the event)
    void openEventForEdit(ev).then((opened) => {
      if (!opened) {
        editOrigin.current = null;
        requestAnimationFrame(() => (document.contains(el) ? el : document.querySelector<HTMLElement>(".mday[tabindex='0'], .week-wrap, .agenda"))?.focus({ preventScroll: true }));
      }
    });
  };
  // when that dialog closes (Save, Cancel, Esc) the focus returns to the event that opened it, else to the day or the grid (a button is not focused by a click in WebKit,
  // so the dialog cannot be trusted to remember it)
  const wasEvent = useRef(false);
  useEffect(() => {
    const isEvent = dialog?.type === "event";
    if (wasEvent.current && !isEvent && editOrigin.current) {
      const el = editOrigin.current;
      editOrigin.current = null;
      requestAnimationFrame(() => {
        const to = document.contains(el) ? el : document.querySelector<HTMLElement>(".mday[tabindex='0'], .week-wrap, .agenda");
        to?.focus({ preventScroll: true });
      });
    }
    wasEvent.current = isEvent;
  }, [dialog]);
  void accounts;

  return (
    <section className="cal-view" aria-label={t("calendar.title")} aria-busy={calLoading}>
      <div className="cal-head">
        <button className="btn small" onClick={() => setCalDate(todayD)} title={t("calendar.todayTip")}>{t("calendar.today")}</button>
        <button className="icon-btn" aria-label={view === "month" ? t("calendar.prevMonth") : view === "week" ? t("calendar.prevWeek") : t("calendar.prev30")} title={t("calendar.prevTip")} onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button className="icon-btn" aria-label={view === "month" ? t("calendar.nextMonth") : view === "week" ? t("calendar.nextWeek") : t("calendar.next30")} title={t("calendar.nextTip")} onClick={() => step(1)}><ChevronRight size={16} /></button>
        <h2>{title}</h2>
        <span className="muted small">{tz} ({tzOffsetLabel(tz)})</span>
        <div className="seg" role="tablist" aria-label={t("calendar.viewLabel")}>
          {(["month", "week", "agenda"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} title={t(VIEW_KEYS[v][1])} onClick={() => setCalView(v)}>
              {t(VIEW_KEYS[v][0])}
            </button>
          ))}
        </div>
      </div>
      {calError && (
        <div className="notice bad" style={{ margin: "8px 16px 0" }} role="alert">
          {t("calendar.loadFailed", { error: calError })} <button className="link" onClick={() => void loadCalendar()}>{t("common.retry")}</button>
        </div>
      )}
      {view === "month" && (
        <MonthView events={events} focus={focus} setFocus={setFocus} tz={tz} anchor={calDate} weekStart={prefs.weekStart} todayD={todayD} color={color} openPop={openPop} edit={edit} loading={calLoading} />
      )}
      {view === "week" && <WeekView events={events} tz={tz} anchor={calDate} weekStart={prefs.weekStart} todayD={todayD} now={now} color={color} openPop={openPop} edit={edit} />}
      {view === "agenda" && <AgendaView events={events} tz={tz} from={calDate} todayD={todayD} color={color} openPop={openPop} edit={edit} loading={calLoading} />}
      {pop && <EventPopover state={pop} tz={tz} color={eventColor(pop.ev, color)} onClose={() => setPop(null)} onEdit={() => edit(pop.ev, pop.el)} onMove={() => (setMoving({ ev: pop.ev, el: pop.el }), setPop(null))} />}
      {moving && <MovingEvent ev={moving.ev} onClose={() => (requestAnimationFrame(() => (document.contains(moving.el) ? moving.el : null)?.focus({ preventScroll: true })), setMoving(null))} />}
      <span hidden>{calendars.length}</span>
    </section>
  );
}

/** Enter with Ctrl (Cmd on a Mac) on a focused event does what a double-click does. */
const isEditKey = (e: React.KeyboardEvent) => e.key === "Enter" && (e.ctrlKey || e.metaKey || (e.shiftKey && !e.altKey));

type EventAct = (e: CalEvent, el: HTMLElement) => void;

function Chip({ ev, tz, color, openPop, edit }: { ev: CalEvent; tz: string; color: string; openPop: EventAct; edit: EventAct }) {
  return (
    <button
      type="button"
      className={`ev-chip ${chipClass(ev)}`}
      style={{ ["--ev" as string]: color }}
      aria-label={eventLabel(ev, tz)}
      title={eventLabel(ev, tz)}
      onClick={(e) => {
        e.stopPropagation();
        openPop(ev, e.currentTarget);
      }}
      // (a double-click on an event never makes a new event on the day: it edits this one, or shows its details)
      onDoubleClick={(e) => (e.stopPropagation(), edit(ev, e.currentTarget))}
      onKeyDown={(e) => isEditKey(e) && (e.preventDefault(), e.stopPropagation(), edit(ev, e.currentTarget))}
    >
      {!ev.allDay && <time>{fmtTime(ev.start, tz)}</time>}
      <span className="ellipsis">{ev.summary}</span>
    </button>
  );
}

const MAX_CHIPS = 3;

function MonthView({
  events, focus, setFocus, tz, anchor, weekStart, todayD, color, openPop, edit, loading,
}: {
  events: CalEvent[]; focus: Day; setFocus: (d: Day) => void; tz: string; anchor: Day; weekStart: number; todayD: Day;
  color: (id: string) => string | undefined; openPop: EventAct; edit: EventAct; loading: boolean;
}) {
  const t = useT();
  const setCalDate = useStore((s) => s.setCalDate);
  const setCalView = useStore((s) => s.setCalView);
  const grid = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const dows = Array.from({ length: 7 }, (_, i) => wdShort((weekStart + i) % 7));
  const refs = useRef<Record<string, HTMLDivElement | null>>({});

  const moveFocus = (d: Day) => {
    setFocus(d);
    if (d.m !== anchor.m || d.y !== anchor.y) setCalDate(d);
    requestAnimationFrame(() => refs.current[dayKey(d)]?.focus());
  };

  return (
    <>
      <div className="month-dow" role="presentation">
        {dows.map((d) => <span key={d}>{d}</span>)}
      </div>
      <div className="month-grid" role="grid" aria-label={monthTitle(anchor)}>
        {grid.map((day) => {
          const list = eventsOnDay(events, day, tz);
          const isToday = sameDay(day, todayD);
          const other = day.m !== anchor.m;
          const shown = list.slice(0, list.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS);
          const more = list.length - shown.length;
          return (
            <div
              key={dayKey(day)}
              ref={(el) => { refs.current[dayKey(day)] = el; }}
              role="gridcell"
              aria-label={`${fmtDayLong(day)}${isToday ? `, ${t("calendar.cell.today")}` : ""}${list.length ? `, ${t("calendar.cell.events", { n: list.length })}` : ""}`}
              aria-selected={sameDay(day, focus)}
              tabIndex={sameDay(day, focus) ? 0 : -1}
              className={`mday ${other ? "other" : ""} ${isToday ? "today" : ""}`}
              onFocus={() => !sameDay(day, focus) && setFocus(day)}
              onDoubleClick={() => newOnDay(day, tz)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                const k = e.key;
                if (k === "ArrowLeft") moveFocus(addDays(day, -1));
                else if (k === "ArrowRight") moveFocus(addDays(day, 1));
                else if (k === "ArrowUp") moveFocus(addDays(day, -7));
                else if (k === "ArrowDown") moveFocus(addDays(day, 7));
                else if (k === "Enter") {
                  if (list.length) openPop(list[0], e.currentTarget);
                  else newOnDay(day, tz);
                } else return;
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <span className="mnum">{day.d === 1 ? fmtDayMonth(day) : day.d}</span>
              {loading && events.length === 0 ? (!other && day.d % 3 === 0 ? <div className="sk" style={{ height: 16, margin: "2px 2px" }} aria-hidden="true" /> : null) : shown.map((ev) => <Chip key={`${ev.id}:${ev.start}`} ev={ev} tz={tz} color={eventColor(ev, color)} openPop={openPop} edit={edit} />)}
              {more > 0 && (
                <button type="button" className="ev-more" onClick={(e) => (e.stopPropagation(), setCalDate(day), setCalView("agenda"))}>
                  {t("calendar.more", { n: more })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function WeekView({
  events, tz, anchor, weekStart, todayD, now, color, openPop, edit,
}: {
  events: CalEvent[]; tz: string; anchor: Day; weekStart: number; todayD: Day; now: number;
  color: (id: string) => string | undefined; openPop: EventAct; edit: EventAct;
}) {
  const t = useT();
  const days = useMemo(() => weekDays(anchor, weekStart), [anchor, weekStart]);
  const scroller = useRef<HTMLDivElement>(null);
  const [sbw, setSbw] = useState(0);
  // the hour height: 08:00 to 20:00 fit the visible grid when the window allows (weekHours.ts), measured again when the window is resized
  const [hourPx, setHourPx] = useState(HOUR_PX_MAX);
  const hourPxRef = useRef(hourPx);
  hourPxRef.current = hourPx;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fit = () => setHourPx(hourHeight(el.clientHeight));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the time at the top of the grid stays where it was when the hours get taller or shorter
  const shownPx = useRef(hourPx);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && shownPx.current !== hourPx) el.scrollTop = (el.scrollTop / shownPx.current) * hourPx;
    shownPx.current = hourPx;
  }, [hourPx]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // working hours first: 08:00, or earlier when it is early in the morning today
    const h = days.some((d) => sameDay(d, todayD)) ? Math.min(Math.max(partsOf(Date.now(), tz).h - 1, 0), 8) : 8;
    el.scrollTop = h * hourPxRef.current - (h > 0 ? 8 : 0);
    setSbw(el.offsetWidth - el.clientWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0].y, days[0].m, days[0].d]);
  const nowP = partsOf(now, tz);
  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div className="week-wrap" role="grid" aria-label={weekTitle(days)} tabIndex={-1}>
    <div className="week-head" style={{ paddingRight: sbw }}>
      <div className="wk-dh" />
      {days.map((d) => (
        <div key={dayKey(d)} className={`wk-dh ${sameDay(d, todayD) ? "today" : ""}`} role="columnheader">
          {wdShort(weekdayIdx(d))}
          <b>{d.d}</b>
        </div>
      ))}
      <div className="wk-allday-label">{t("calendar.allDay")}</div>
      {days.map((d) => (
        <div key={`ad-${dayKey(d)}`} className="wk-allday">
          {eventsOnDay(events, d, tz).filter((e) => e.allDay).map((ev) => <Chip key={`${ev.id}:${ev.start}`} ev={ev} tz={tz} color={eventColor(ev, color)} openPop={openPop} edit={edit} />)}
        </div>
      ))}
    </div>
    <div className="week" ref={scroller} style={{ "--hour-px": `${hourPx}px` } as React.CSSProperties}>
      <div className="wk-hours" aria-hidden="true">
        {hours.map((h) => <div key={h} className="wk-hour">{h === 0 ? "" : fmtClock(h, 0)}</div>)}
      </div>
      {days.map((d) => {
        const dayStart = Math.floor(dayStartMs(d, tz) / 1000);
        const dayEnd = Math.floor(dayStartMs(addDays(d, 1), tz) / 1000);
        const timed = eventsOnDay(events, d, tz)
          .filter((e) => !e.allDay)
          .map((e) => ({ ...e, ev: e, start: Math.max(e.start, dayStart), end: Math.max(Math.min(e.end, dayEnd), Math.max(e.start, dayStart) + 900) }));
        const placed = layoutDay(timed);
        return (
          <div
            key={dayKey(d)}
            className="wk-col"
            role="gridcell"
            onDoubleClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const mins = minuteFromY(e.clientY - r.top, hourPx);
              newOnDay(d, tz, Math.floor(mins / 60), mins % 60);
            }}
          >
            {placed.map(({ ev: p, lane, lanes }) => {
              const ev = p.ev;
              const top = ((p.start - dayStart) / 3600) * hourPx;
              const h = Math.max(((p.end - p.start) / 3600) * hourPx, 20);
              return (
                <button
                  key={`${ev.id}:${ev.start}`}
                  type="button"
                  className={`wk-ev ${chipClass(ev)}`}
                  style={{ top, height: h - 1, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, right: "auto", ["--ev" as string]: eventColor(ev, color) }}
                  aria-label={eventLabel(ev, tz)}
                  title={eventLabel(ev, tz)}
                  onClick={(e) => (e.stopPropagation(), openPop(ev, e.currentTarget))}
                  onDoubleClick={(e) => (e.stopPropagation(), edit(ev, e.currentTarget))}
                  onKeyDown={(e) => isEditKey(e) && (e.preventDefault(), e.stopPropagation(), edit(ev, e.currentTarget))}
                >
                  <b>{ev.summary}</b>
                  {h > 34 && <span>{fmtClockRange(ev, tz)}</span>}
                </button>
              );
            })}
            {sameDay(d, todayD) && <div className="now-line" style={{ top: ((nowP.h * 60 + nowP.mi) / 60) * hourPx }} aria-hidden="true" />}
          </div>
        );
      })}
    </div>
    </div>
  );
}

const weekdayIdx = (d: Day) => new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();

function statusPill(ev: CalEvent): ReactNode {
  if (ev.status === "cancelled") return <span className="pill bad">{t("calendar.status.cancelled")}</span>;
  const s = ev.myStatus;
  if (s === "accepted") return <span className="pill good">{t("calendar.status.accepted")}</span>;
  if (s === "tentative") return <span className="pill warn">{t("calendar.status.tentative")}</span>;
  if (s === "declined") return <span className="pill">{t("calendar.status.declined")}</span>;
  if (s === "needs-action") return <span className="pill warn">{t("calendar.status.needsAction")}</span>;
  if (s === "organizer") return <span className="pill accent">{t("calendar.status.organizer")}</span>;
  return null;
}

function AgendaView({
  events, tz, from, todayD, color, openPop, edit, loading,
}: {
  events: CalEvent[]; tz: string; from: Day; todayD: Day; color: (id: string) => string | undefined; openPop: EventAct; edit: EventAct; loading: boolean;
}) {
  const t = useT();
  const days = Array.from({ length: 30 }, (_, i) => addDays(from, i));
  const groups = days.map((d) => ({ d, list: eventsOnDay(events, d, tz) })).filter((g) => g.list.length);
  if (loading && events.length === 0) {
    return (
      <div className="agenda" aria-busy="true">
        {[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 38, margin: "12px 0" }} />)}
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="agenda">
        <EmptyState icon={<CalendarDays size={44} />} title={t("calendar.agenda.emptyTitle")} text={t("calendar.agenda.emptyText")} />
        <div style={{ textAlign: "center" }}><button className="btn primary" onClick={() => newOnDay(from, tz, 9)}><CalendarPlus size={14} /> {t("calendar.newEvent")}</button></div>
      </div>
    );
  }
  return (
    <div className="agenda" role="list" aria-label={t("calendar.agenda.label")} tabIndex={-1}>
      {groups.map(({ d, list }) => (
        <div key={dayKey(d)} role="listitem">
          <div className="ag-day">{sameDay(d, todayD) ? t("calendar.agenda.today", { day: fmtDayShort(d) }) : fmtDayShort(d)}</div>
          {list.map((ev) => (
            <div
              key={`${ev.id}:${ev.start}`}
              className="ag-row"
              role="button"
              tabIndex={0}
              style={{ ["--ev" as string]: eventColor(ev, color) }}
              aria-label={eventLabel(ev, tz)}
              onClick={(e) => openPop(ev, e.currentTarget)}
              onDoubleClick={(e) => edit(ev, e.currentTarget)}
              onKeyDown={(e) => {
                if (isEditKey(e)) {
                  e.preventDefault();
                  edit(ev, e.currentTarget);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openPop(ev, e.currentTarget);
                }
              }}
            >
              <span className="ag-time">{ev.allDay ? t("calendar.allDay") : `${fmtTime(ev.start, tz)} – ${fmtTime(ev.end, tz)}`}</span>
              <span className="ag-bar" />
              <span className="grow ellipsis" style={{ textDecoration: ev.status === "cancelled" ? "line-through" : undefined, opacity: ev.status === "cancelled" ? 0.7 : 1 }}>
                <b>{ev.summary}</b>
                {ev.location && <span className="muted small"> · {isUrl(ev.location) ? joinShortName(ev.location) : ev.location}</span>}
              </span>
              {statusPill(ev)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// =============================================================== event popover

function EventPopover({ state, tz, color, onClose, onEdit, onMove }: { state: PopState; tz: string; color: string; onClose: () => void; onEdit: () => void; onMove: () => void }) {
  const t = useT();
  const { showToast, setDialog, bumpCal, setModule, setView, openMail: openMailThread } = useStore();
  const ev = state.ev;
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose, true);
  const [busy, setBusy] = useState<Rsvp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  // narrower than 300 px inside (a window under about 340 px): the action buttons keep their icon and lose their label
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setNarrow(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) < 300);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // keyboard users land in the popover and return to the event they came from
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => back?.focus?.({ preventScroll: true });
  }, []);
  const invite = ev.calendarId.startsWith("invites:");
  // an event of a synced calendar (Google Calendar / Outlook) can be changed here unless the service or the calendar says otherwise
  const synced = isSyncedCalendarId(ev.calendarId);
  const syncedCal = useStore.getState().calendars.find((c) => c.id === ev.calendarId);
  const lockNote = synced ? readOnlyNote(ev, syncedCal?.name ?? "", syncedCal?.service) : null;
  // an invitation shown as part of the synced calendar that the service did not add there (a twin would have been shown instead of it): say it is only here (W7.11)
  const foldedCal = invite ? foldTarget(useStore.getState().calendars, ev.calendarId) : undefined;
  const localOnlyNote = foldedCal && foldedCal.id !== ev.calendarId && foldedCal.service ? t("calendar.pop.inviteLocalOnly", { service: foldedCal.service }) : null;
  const canRsvp = invite && !!ev.sourceMessageId && ev.myStatus !== "organizer" && ev.myStatus !== null && ev.status !== "cancelled";

  // below the chip, or above it when there is no room; kept inside the window (the popover is never taller than the window: its details scroll)
  useLayoutEffect(() => {
    const place = () => {
      const h = ref.current?.offsetHeight ?? 220;
      const w = 392;
      const r = state.rect;
      let top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      top = Math.max(8, Math.min(top, window.innerHeight - 8 - h));
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place); // (a window that gets smaller keeps the popover inside)
    return () => window.removeEventListener("resize", place);
  }, [state.rect, ev.id]);

  const respond = async (r: Rsvp) => {
    if (!ev.sourceMessageId) return;
    setBusy(r);
    setErr(null);
    try {
      await api.calendarRespond(ev.sourceMessageId, r, null, true);
      const who = personName(ev.organizer);
      showToast(who ? t("calendar.toast.responseSent", { name: who }) : t("calendar.toast.responseSentOrganizer"), undefined, "success");
      bumpCal();
      onClose();
    } catch (e) {
      setErr(t("calendar.invite.sendFailed", { error: friendlyError(e) }));
      bumpCal();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const end = await deleteEventAsked(ev, syncedCal, tz, (text, kind) => showToast(text, undefined, kind));
    if (end === "cancelled") return;
    bumpCal();
    onClose();
  };

  const duplicate = () => {
    onClose();
    setDialog({ type: "event", init: { summary: t("calendar.pop.copyOf", { summary: ev.summary }), start: ev.start, end: ev.end, allDay: ev.allDay, location: ev.location ?? undefined, description: ev.description ?? undefined } });
  };

  const openMail = async () => {
    if (!ev.sourceMessageId) return;
    try {
      const r = await api.calendarOpenMessage(ev.sourceMessageId);
      onClose();
      setModule("mail");
      await setView(r.folder, r.accountId);
      await openMailThread(r.threadId);
    } catch (e) {
      showToast(() => friendlyError(e), undefined, "error");
    }
  };

  const saveIcs = async () => {
    try {
      const p = await api.calendarSaveIcs({ eventId: ev.id });
      if (p) showToast(t("calendar.toast.saved", { name: p.split(/[\\/]/).pop() ?? p }), undefined, "success");
    } catch (e) {
      showToast(() => t("calendar.toast.saveFailed", { error: friendlyError(e) }), undefined, "error");
    }
    onClose();
  };

  const others = ev.attendees.length;
  // the repeat rule in words; a series that only has extra dates (RDATE) has no rule to describe
  const repeatText = ev.recurrenceText ?? (ev.hasRdates ? t("calendar.repeat.customFallback") : null);
  // which actions apply to this event (an action that cannot be done is not shown; the note under the details says why Edit is missing)
  const showEdit = canEditEvent(ev);
  const showCopy = !ev.confidential;
  // another calendar to move it to (W7.5): the user's own event, in My events or a synced calendar, with a writable calendar to go to
  const showMove = showEdit && !invite && moveTargets(ev, useStore.getState().calendars).length > 0;
  const showDelete = !(synced && !!ev.readOnly);
  const showMail = invite && !!ev.sourceMessageId;
  const answerRow = canRsvp || !!ev.joinUrl;
  // an action button: icon and label, or the icon alone (with the label as its name and tooltip) in a narrow popover
  const actionButton = (label: string, icon: ReactNode, onClick: () => void, danger = false) => {
    const cls = `btn small${danger ? " danger ev-delete" : ""}`;
    return narrow ? (
      <button type="button" className={`${cls} icon-only`} title={label} aria-label={label} onClick={onClick}>{icon}</button>
    ) : (
      <button type="button" className={cls} onClick={onClick}>{icon}<span>{label}</span></button>
    );
  };
  return (
    <div ref={ref} tabIndex={-1} className="popover ev-pop" role="dialog" aria-label={t("calendar.pop.aria", { summary: ev.summary })} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 40 }}>
      <h4 style={{ textDecoration: ev.status === "cancelled" ? "line-through" : undefined }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: color, marginTop: 6, flex: "none" }} aria-hidden />
        <span className="grow">{ev.summary}</span>
        <button className="icon-btn" aria-label={t("common.close")} onClick={onClose}><X size={14} /></button>
      </h4>
      <div className="ev-details">
        <div className="inv-row"><Clock size={14} aria-hidden /><span>{fmtRange(ev, tz)}{repeatText ? <><br /><span className="sub"><Repeat size={11} aria-hidden style={{ verticalAlign: -1 }} /> {repeatText}</span></> : ""}{ev.changedOccurrence ? <><br /><span className="sub" data-changed-occurrence>{t("calendar.pop.changedOccurrence")}</span></> : ""}</span></div>
        {(ev.location || ev.joinUrl) && (
          <div className="inv-row">
            <MapPin size={14} aria-hidden />
            <span>
              {ev.location && (isUrl(ev.location) ? null : ev.location)}
              {ev.location && !isUrl(ev.location) && ev.joinUrl && " · "}
              {(ev.joinUrl || (ev.location && isUrl(ev.location))) && <button className="link" onClick={() => void open((ev.joinUrl ?? ev.location)!)}>{joinLabel((ev.joinUrl ?? ev.location)!)}</button>}
            </span>
          </div>
        )}
        {(ev.organizer || others > 0) && (
          <div className="inv-row">
            <UserRound size={14} aria-hidden />
            <span>
              {ev.organizer ? t("calendar.pop.organizerOf", { name: personName(ev.organizer) }) : ""}{ev.organizer && others > 1 ? " · " : ""}{others > 1 ? t("calendar.pop.attendees", { n: others }) : ""}
            </span>
          </div>
        )}
        {myStatusLabel(ev.myStatus) && ev.myStatus !== "organizer" && (
          <div className="inv-row"><CircleCheck size={14} aria-hidden /><span>{ev.status === "cancelled" ? t("calendar.pop.cancelledByOrganizer") : myStatusLabel(ev.myStatus)}{ev.respondedAt === null && ev.myStatus !== "needs-action" ? ` (${t("calendar.invite.noResponseSent")})` : ""}</span></div>
        )}
        {ev.description && <div className="muted small" style={{ whiteSpace: "pre-wrap", maxHeight: 90, overflow: "auto" }}>{ev.description.slice(0, 600)}</div>}
        {lockNote && <div className="muted small">{lockNote}</div>}
        {localOnlyNote && <div className="muted small">{localOnlyNote}</div>}
        {err && <div className="inline-err" role="alert"><TriangleAlert size={14} aria-hidden /> {err}</div>}
      </div>
      {(answerRow || showMail || showEdit || showCopy || showDelete || showMove) && (
        <div className="ev-foot">
          {answerRow && (
            <div className="ev-acts ev-answer">
              {canRsvp && (
                <>
                  <button className={`btn small ${ev.myStatus === "accepted" ? "chosen" : ""}`} disabled={busy !== null} onClick={() => void respond("accepted")}>{busy === "accepted" ? t("calendar.sending") : t("calendar.rsvp.accept")}</button>
                  <button className={`btn small ${ev.myStatus === "tentative" ? "chosen" : ""}`} disabled={busy !== null} onClick={() => void respond("tentative")}>{busy === "tentative" ? t("calendar.sending") : t("calendar.rsvp.tentative")}</button>
                  <button className={`btn small ${ev.myStatus === "declined" ? "chosen" : ""}`} disabled={busy !== null} onClick={() => void respond("declined")}>{busy === "declined" ? t("calendar.sending") : t("calendar.rsvp.decline")}</button>
                </>
              )}
              {ev.joinUrl && <button className="btn small primary" onClick={() => void open(ev.joinUrl!)}><Video size={13} /> {t("calendar.pop.join")}</button>}
            </div>
          )}
          {(showMail || showEdit || showCopy || showDelete || showMove) && (
            <div className="ev-acts ev-actions">
              {showMail && <button className="icon-btn" title={t("calendar.pop.openEmail")} aria-label={t("calendar.pop.openEmail")} onClick={() => void openMail()}><Mail size={15} /></button>}
              {showEdit && actionButton(t("common.edit"), <Pencil size={14} aria-hidden />, onEdit)}
              {showCopy && actionButton(t("calendar.pop.duplicate"), <Copy size={14} aria-hidden />, duplicate)}
              {/* (icon only, like Open email: its name is long, and a third line of buttons would push the footer out of small windows) */}
              {showMove && <button type="button" className="btn small icon-only" title={t("calendar.pop.moveTo")} aria-label={t("calendar.pop.moveTo")} onClick={onMove}><FolderInput size={14} aria-hidden /></button>}
              {showCopy && actionButton(t("calendar.saveIcs"), <Download size={14} aria-hidden />, () => void saveIcs())}
              {showDelete && actionButton(t("common.delete"), <Trash2 size={14} aria-hidden />, () => void remove(), true)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The Move dialog of an event: the calendars it can go to, and the guests sentence when its service cannot move it with guests. */
function MovingEvent({ ev, onClose }: { ev: CalEvent; onClose: () => void }) {
  const { calendars, bumpCal } = useStore();
  const targets = moveTargets(ev, calendars);
  if (targets.length === 0) return null;
  return <MoveDialog event={ev} targets={targets} blocked={guestsBlock(ev, calendars, targets)} onClose={onClose} onMoved={() => (bumpCal(), onClose())} />;
}

// =============================================================== sidebar (folder pane in Calendar mode)

/** A synced calendar keeps its own colour; a mailbox's invitations use the mailbox colour. */
function calendarColor(c: { id: string; remote?: boolean; color?: string | null; accountId: string | null }, accounts: { id: string }[], accent: string): string {
  const acct = accounts.find((a) => a.id === c.accountId) as Parameters<typeof accountColor>[0] | undefined;
  return c.id === "local" ? MY_EVENTS_COLOR : c.remote && c.color ? c.color : acct ? accountColor(acct, accent) : c.color || "var(--accent)";
}

/** The calendar list of the side menu while it is folded to icons: one coloured dot per calendar, filled while it is shown; the name is the tooltip. */
export function CalRail() {
  const t = useT();
  const { prefs, calendars, bumpCal, accounts } = useStore();
  const cals = calendars.length ? sidebarCalendars(calendars) : [{ id: "local", name: t("calendar.myEvents"), color: MY_EVENTS_COLOR, accountId: null, visible: true }];
  return (
    <div className="fp-group fp-calrail" role="group" aria-label={t("calendar.side.calendars")}>
      {cals.map((c) => {
        const col = calendarColor(c, accounts, prefs.accent);
        return (
          <button
            key={c.id}
            type="button"
            className={`fp-cal ${c.visible ? "on" : ""}`}
            aria-pressed={c.visible}
            aria-label={calendarTitle(c)}
            title={calendarTitle(c)}
            onClick={() => void api.calendarSetVisible(c.id, !c.visible).then(() => bumpCal())}
          >
            <span className="fp-cal-dot" style={{ background: c.visible ? col : "transparent", borderColor: col }} />
          </button>
        );
      })}
    </div>
  );
}

export function CalSidebar() {
  const t = useT();
  const { prefs, calDate, calEvents, calendars, calSources, calSourcesReady, calOfferDone, setCalDate, setPrefs, setDialog, bumpCal, accounts } = useStore();
  const tz = useTz();
  const todayD = today(tz);
  const [month, setMonth] = useState<Day>(calDate);
  // the offer for mailboxes that existed before calendar sync could be asked for at sign-in (W7.9): shown once everything it depends on is read
  const [kinds, setKinds] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    api.calendarKindsAvailable().then((k) => live && setKinds(k)).catch(() => live && setKinds([]));
    void useStore.getState().loadCalOffer();
    void useStore.getState().loadCalSources();
    return () => void (live = false);
  }, []);
  const offer = calSourcesReady ? calendarOffer(accounts, calSources, kinds, calOfferDone) : null;
  useEffect(() => setMonth({ ...calDate, d: 1 }), [calDate]);
  const grid = useMemo(() => monthGrid(month, prefs.weekStart), [month, prefs.weekStart]);
  const dows = Array.from({ length: 7 }, (_, i) => wdNarrow((prefs.weekStart + i) % 7));
  const has = useMemo(() => {
    const s = new Set<string>();
    for (const e of calEvents) {
      const [a, b] = eventDaySpan(e, tz);
      for (let d = a, i = 0; cmpDay(d, b) <= 0 && i < 40; d = addDays(d, 1), i++) s.add(dayKey(d));
    }
    return s;
  }, [calEvents, tz]);
  const weekOfSel = weekStartOf(calDate, prefs.weekStart);
  const sel = (d: Day) => prefs.calView === "month" ? sameDay(d, calDate) : prefs.calView === "week" ? daysBetween(weekOfSel, d) >= 0 && daysBetween(weekOfSel, d) < 7 : sameDay(d, calDate);

  const cals = calendars.length ? sidebarCalendars(calendars) : [{ id: "local", name: t("calendar.myEvents"), color: MY_EVENTS_COLOR, accountId: null, visible: true }];
  return (
    <>
      <div className="fp-group">
        <div className="mini-head">
          <span>{monthTitle(month)}</span>
          <span>
            <button className="icon-btn" aria-label={t("calendar.prevMonth")} onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={14} /></button>
            <button className="icon-btn" aria-label={t("calendar.nextMonth")} onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={14} /></button>
          </span>
        </div>
        <table className="mini-month" role="grid" aria-label={monthTitle(month)}>
          <thead><tr>{dows.map((d, i) => <th key={i} scope="col">{d}</th>)}</tr></thead>
          <tbody>
            {Array.from({ length: 6 }, (_, w) => (
              <tr key={w}>
                {grid.slice(w * 7, w * 7 + 7).map((d) => (
                  <td key={dayKey(d)}>
                    <button
                      type="button"
                      className={`${d.m !== month.m ? "other" : ""} ${sameDay(d, todayD) ? "today" : ""} ${sel(d) ? "sel" : ""} ${has.has(dayKey(d)) ? "has" : ""}`}
                      aria-label={`${fmtDayLong(d)}${has.has(dayKey(d)) ? `, ${t("calendar.cell.hasEvents")}` : ""}`}
                      aria-current={sameDay(d, todayD) ? "date" : undefined}
                      onClick={() => setCalDate(d)}
                    >
                      {d.d}
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fp-group">
        <div className="fp-head" style={{ cursor: "default" }}>{t("calendar.side.calendars")}</div>
        <div className="cal-list">
          {cals.map((c) => {
            const col = calendarColor(c, accounts, prefs.accent);
            return (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={c.visible}
                  style={{ accentColor: col }}
                  onChange={(e) => void api.calendarSetVisible(c.id, e.target.checked).then(() => bumpCal())}
                />
                <span className="ellipsis" title={calendarTitle(c)}>{calendarTitle(c)}</span>
                {c.remote && !c.writable && <span className="muted small" style={{ flex: "none" }}>{t("calendar.side.readOnly")}</span>}
              </label>
            );
          })}
          <label>
            <input type="checkbox" checked={prefs.calShowDeclined} onChange={(e) => setPrefs({ calShowDeclined: e.target.checked })} />
            <span>{t("calendar.side.showDeclined")}</span>
          </label>
        </div>
        {offer && (
          <div className="notice info cal-offer" role="note" style={{ margin: "8px 0 0" }}>
            {tx("calendar.side.offer", { email: <span className="cal-email" title={offer.email}>{offer.email}</span> }, { service: serviceName(offer.kind) })}{" "}
            <button
              className="link"
              onClick={() => {
                // answered; Settings > that mailbox > Calendar opens and starts the switch's own path, which asks before the browser opens
                void useStore.getState().answerCalOffer();
                useStore.setState({ calAutostart: offer.accountId });
                setDialog({ type: "settings", tab: `mb:${offer.accountId}`, focus: "calendar", nonce: Date.now() });
              }}
            >
              {t("calendar.side.offerOn")}
            </button>{" "}
            <button className="link" onClick={() => void useStore.getState().answerCalOffer()}>{t("calendar.side.offerLater")}</button>
          </div>
        )}
        {pausedSources(calSources).map((s) => (
          <div key={s.id} className="notice bad" style={{ margin: "8px 0 0" }}>
            {(() => {
              const email = accounts.find((a) => a.id === s.accountId)?.email;
              return email ? t("calendar.side.paused", { email }) : t("calendar.side.pausedGeneric");
            })()}{" "}
            <button className="link" onClick={() => setDialog({ type: "settings", tab: `mb:${s.accountId}`, focus: "calendar", nonce: Date.now() })}>{t("calendar.side.fix")}</button>
          </div>
        ))}
      </div>
    </>
  );
}

// =============================================================== new / edit event

const REMINDERS = [
  [null, "calendar.reminder.none"], [0, "calendar.reminder.start"], [5, "calendar.reminder.m5"], [10, "calendar.reminder.m10"], [15, "calendar.reminder.m15"], [30, "calendar.reminder.m30"],
  [60, "calendar.reminder.h1"], [1440, "calendar.reminder.d1"],
] as const;

/** The form of an event as the dialog holds it: what moves into a window of its own with "Open in new window", changes included (W4.6, REQ-4.6.6). */
export interface EventDraft {
  title: string;
  sd: string;
  st: string;
  ed: string;
  et: string;
  allDay: boolean;
  where: string;
  notes: string;
  invite: string[];
  accountId: string;
  reminder: number | null;
  repeat: string;
  customRule: string | null;
  customText: string | null;
  calId: string;
  dirty: boolean;
}

/** What the event window gives the form (EventView.tsx): the form is the page of the window instead of a dialog. */
export interface EventWindowHooks {
  /** the window ends: the event was saved or deleted, or the person closed the form */
  done: () => void;
  /** the form hands over what the window's close needs: whether it has changes, and its own close (the discard question first when it has) */
  register: (h: { dirty: () => boolean; close: () => Promise<void> }) => void;
  /** a toast that is made in the main window, where the person still looks (the window ends) */
  toast: (text: string, kind: "info" | "success" | "error") => void;
  /** the title of the window follows the title of the event */
  title: (text: string) => void;
}

export function EventDialog({ eventId, init, draft, windowed, scope, occurrenceStart }: { eventId?: string; init?: EventInit; draft?: EventDraft; windowed?: EventWindowHooks; scope?: SeriesScope; occurrenceStart?: number | null }) {
  const t = useT();
  const { prefs, accounts, calendars, setPrefs, setDialog, showToast, bumpCal } = useStore();
  const tz = useTz();
  const [loaded, setLoaded] = useState(!eventId);
  // the calendar a new event goes to (My events or a synced calendar); fixed when editing
  const [calId, setCalId] = useState(() => draft?.calId ?? defaultCalendar(calendars, prefs.calDefaultCalendar));
  const calInfo = calendars.find((c) => c.id === calId);
  const remote = isSyncedCalendarId(calId);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [title, setTitle] = useState(draft?.title ?? init?.summary ?? "");
  const startSec = init?.start ?? nextHour(tz);
  const endSec = init?.end ?? startSec + 3600;
  const [allDay, setAllDay] = useState(draft?.allDay ?? init?.allDay ?? false);
  const [sd, setSd] = useState(draft?.sd ?? toInputs(startSec, tz).date);
  const [st, setSt] = useState(draft?.st ?? toInputs(startSec, tz).time);
  const [ed, setEd] = useState(draft?.ed ?? toInputs(allDay ? endSec - 86400 : endSec, tz).date);
  const [et, setEt] = useState(draft?.et ?? toInputs(endSec, tz).time);
  const [where, setWhere] = useState(draft?.where ?? init?.location ?? "");
  const [notes, setNotes] = useState(draft?.notes ?? init?.description ?? "");
  const [invite, setInvite] = useState<string[]>(draft?.invite ?? init?.attendees ?? []);
  const [accountId, setAccountId] = useState(draft?.accountId ?? (prefs.defaultAccount || accounts[0]?.id || ""));
  const [reminder, setReminder] = useState<number | null>(draft ? draft.reminder : prefs.eventReminderMin);
  const [repeat, setRepeat] = useState(draft?.repeat ?? "none");
  const [customRule, setCustomRule] = useState<string | null>(draft?.customRule ?? null);
  const [customText, setCustomText] = useState<string | null>(draft?.customText ?? null);
  const [existing, setExisting] = useState<CalEventDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(draft?.dirty ?? false);
  const touch = () => setDirty(true);
  /** the form is over: the dialog closes, or the window ends */
  const finish = () => (windowed ? windowed.done() : setDialog(null));
  /** a toast: in the window of a form that is a window, in the main window (the window ends) */
  const say = (text: () => string, kind: "info" | "success" | "error") => (windowed ? windowed.toast(text(), kind) : showToast(() => text(), undefined, kind));
  // moving the start moves the end with it (same length); the end alone never moves the start
  const moveStartTo = (change: { sd?: string; st?: string }) => {
    const n = moveStart({ sd, st, ed, et }, change, allDay);
    setSd(n.sd);
    setSt(n.st);
    setEd(n.ed);
    setEt(n.et);
    touch();
  };

  useEffect(() => {
    if (!eventId) return;
    let live = true;
    api.calendarGetEvent(eventId, scope, occurrenceStart).then((e) => {
      if (!live) return;
      setExisting(e);
      setCalId(e.calendarId);
      setTitle(e.summary);
      setAllDay(e.allDay);
      const zone = e.allDay ? "UTC" : tz;
      setSd(toInputs(e.start, zone).date);
      setSt(toInputs(e.start, zone).time);
      setEd(toInputs(e.allDay ? e.end - 86400 : e.end, zone).date);
      setEt(toInputs(e.end, zone).time);
      setWhere(e.location ?? "");
      setNotes(e.description ?? "");
      setInvite(e.attendees.filter((a) => a.role !== "chair").map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)));
      if (e.accountId) setAccountId(e.accountId);
      setReminder(e.reminderMin);
      // the repeat choices are worked out in the zone of the series, not the one the form shows (a New York series seen from Ho Chi Minh keeps its weekday)
      const startDay = e.allDay ? dayOfMs(e.start * 1000, "UTC") : dayOfMs(e.start * 1000, ruleZone(e, tz));
      const k = repeatKind(e.rrule, startDay);
      setRepeat(k);
      if (k === "custom") {
        setCustomRule(e.rrule);
        setCustomText(e.recurrenceText);
      }
      if (draft) {
        // the form moved here with changes: they are laid over the event as it is stored
        setTitle(draft.title);
        setAllDay(draft.allDay);
        setSd(draft.sd);
        setSt(draft.st);
        setEd(draft.ed);
        setEt(draft.et);
        setWhere(draft.where);
        setNotes(draft.notes);
        setInvite(draft.invite);
        setAccountId(draft.accountId);
        setReminder(draft.reminder);
        setRepeat(draft.repeat);
        setCustomRule(draft.customRule);
        setCustomText(draft.customText);
      }
      setLoaded(true);
    }).catch((e) => live && setLoadErr(friendlyError(e)));
    return () => {
      live = false;
    };
  }, [eventId, tz, scope, occurrenceStart]);

  const close = async () => {
    if (dirty && !(await useStore.getState().confirm({ title: t("calendar.dialog.discardTitle"), body: t("calendar.dialog.discardBody"), confirmLabel: t("calendar.dialog.discard"), danger: true }))) return;
    finish();
  };
  // the window asks the form for its close and for whether it has changes (the discard question is the dialog's own)
  const closeRef = useRef(close);
  closeRef.current = close;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    windowed?.register({ dirty: () => dirtyRef.current, close: () => closeRef.current() });
  }, [windowed]);
  useEffect(() => {
    windowed?.title(title.trim() || t("calendar.newEvent"));
  }, [windowed, title]); // eslint-disable-line react-hooks/exhaustive-deps
  /** "Open in new window": the form with every change made so far moves into a window; the dialog closes, nothing is saved (REQ-4.6.6) */
  const popOut = async () => {
    const moved: EventDraft = { title, sd, st, ed, et, allDay, where, notes, invite, accountId, reminder, repeat, customRule, customText, calId, dirty };
    const key = eventKey(eventId, scope, occurrenceStart);
    const init2 = eventId ? { eventId, scope, occurrenceStart, draft: moved } : { init, draft: moved };
    if (await openPopout("event", key, init2)) setDialog(null);
  };
  /** Delete in the window of an event (REQ-4.6.7): the questions of the event popover, then the event goes and the window ends */
  const remove = async () => {
    if (!existing) return;
    // (the questions are about the part of the series this form is for)
    const target: CalEvent = scope ? { ...existing, series: true, occurrenceStart: occurrenceStart ?? existing.occurrenceStart } : existing;
    const end = await deleteEventAsked(target, calInfo, tz, (text, kind) => (kind === "success" ? say(text, kind) : showToast(text, undefined, kind)));
    if (end === "done") finish();
  };

  const hasGuests = invite.length > 0;
  const startMs = fromInputs(sd, st, tz, allDay);
  const endMs = fromInputs(ed, et, tz, allDay);
  const everyone = existing?.attendees.length ? existing.attendees.length > 1 : false;
  const primary = busy ? (hasGuests ? t("calendar.sending") : t("calendar.dialog.saving")) : hasGuests ? (existing && everyone ? t("calendar.dialog.sendUpdate") : t("calendar.dialog.sendInvitations")) : t("common.save");

  const save = async () => {
    setError(null);
    if (!title.trim()) return setError(t("calendar.dialog.errTitle"));
    if (startMs === null || endMs === null) return setError(t("calendar.dialog.errDate"));
    const s = startMs;
    const e = allDay ? endMs + 86400 : endMs;
    if (e <= s && !allDay) return setError(t("calendar.endBeforeStart"));
    if (allDay && e <= s) return setError(t("calendar.endBeforeStart"));
    const bad = invite.find((a) => !EMAIL.test(bare(a)));
    if (bad) return setError(t("calendar.dialog.errAddress", { address: bad }));
    if (hasGuests && !accountId && !remote) return setError(t("calendar.dialog.errAccount"));
    const startDay = allDay ? dayOfMs(s * 1000, "UTC") : dayOfMs(s * 1000, existing ? ruleZone(existing, tz) : tz);
    const rrule = scope === "occurrence" ? null : repeat === "custom" ? customRule : repeatRule(repeat, startDay);
    // a time or rule change of a series may reset the occurrences that were changed one by one: ask first (REQ-7.1.3)
    if (existing && (scope === "series" || scope === "following")) {
      const timeChanged = s !== existing.start || e !== existing.end || allDay !== existing.allDay;
      const ruleChanged = !existing.patternUnsupported && (rrule ?? null) !== (existing.rrule ?? null);
      if (needsResetQuestion({ scope, synced: remote, changedCount: existing.changedCount ?? 0, timeChanged, ruleChanged })) {
        const ok = await useStore.getState().confirm({ title: t("calendar.series.resetTitle"), body: t("calendar.series.resetBody"), confirmLabel: t("calendar.series.resetConfirm") });
        if (!ok) return;
      }
    }
    setBusy(true);
    try {
      const ev = await api.calendarSaveEvent(
        {
          id: eventId ?? null,
          accountId: (remote ? calInfo?.accountId : accountId) || null,
          summary: title.trim(),
          start: s,
          end: e,
          allDay,
          tzid: allDay ? null : tz,
          location: where.trim() || null,
          description: notes.trim() || null,
          attendees: invite.map((a) => ({ email: bare(a).toLowerCase(), name: nameOf(a) || null, role: "required" as const })),
          rrule,
          reminderMin: reminder,
          calendarId: calId,
          scope,
          occurrenceStart: scope ? occurrenceStart ?? existing?.occurrenceStart ?? null : null,
        },
        // (the service sends the invitations of a synced calendar, not this app; except a CalDAV server that does not send them: W7.4, D-7.4j)
        hasGuests && (!remote || !!calInfo?.appInvites),
      );
      if (!eventId && (remote || prefs.calDefaultCalendar)) setPrefs({ calDefaultCalendar: remote ? calId : "" });
      say(() => (hasGuests && (!remote || !scope) ? t("calendar.toast.invitationsSent", { n: invite.length }) : t(savedToastKey(scope, !eventId))), "success");
      bumpCal();
      useStore.getState().setCalDate(allDay ? dayOfMs(ev.start * 1000, "UTC") : dayOfMs(ev.start * 1000, tz));
      finish();
    } catch (err) {
      bumpCal();
      const code = errorCode(err);
      if (code === "CAL_SEND_FAILED" || code === "CAL_CONFLICT" || code === "CAL_GONE") {
        // the invitations failed, or the service's version won: said once, the dialog closes (the calendar shows what is there now)
        say(() => friendlyError(err), "error");
        finish();
      } else if (code === "CAL_OFFLINE") {
        // nothing was saved: the dialog stays open with what was typed
        showToast(() => friendlyError(err), undefined, "error");
        setBusy(false);
      } else {
        setError(friendlyError(err));
        setBusy(false);
      }
    }
  };

  if (loadErr) {
    return (
      <Modal title={t("calendar.dialog.editTitle")} onClose={finish} width={560} windowed={!!windowed}>
        <div className="notice bad">{loadErr}</div>
      </Modal>
    );
  }
  const startDayPreview = parseDay(sd);
  return (
    <Modal
      title={t(dialogTitleKey(scope, !!eventId))}
      onClose={() => void close()}
      width={560}
      windowed={!!windowed}
      headExtra={
        windowed ? undefined : (
          <button className="icon-btn" title={t("app.cmd.openInWindow")} aria-label={t("app.cmd.openInWindow")} onClick={() => void popOut()}>
            <ExternalLink size={14} />
          </button>
        )
      }
    >
      {existing && isSyncedCalendarId(existing.calendarId) && readOnlyNote(existing, calInfo?.name ?? "", calInfo?.service) && (
        <div className="notice" role="note">{readOnlyNote(existing, calInfo?.name ?? "", calInfo?.service)}</div>
      )}
      {(scope === "occurrence" || scope === "following") && (
        // which occurrence the changes are for: plain text, read after the title
        <p className="muted small ev-scope-note" style={{ margin: "0 0 10px" }}>{scopeNote(scope, fmtDayLong(occurrenceDay({ allDay, tzid: existing?.tzid ?? null, occurrenceStart: occurrenceStart ?? existing?.occurrenceStart ?? null, start: existing?.start ?? startSec }, tz)))}</p>
      )}
      <div className="ev-form" aria-busy={!loaded}>
        <label htmlFor="ev-title">{t("calendar.dialog.title")}</label>
        <input id="ev-title" autoFocus value={title} aria-invalid={!!error && !title.trim()} onChange={(e) => (setTitle(e.target.value), touch())} placeholder={t("calendar.dialog.titlePlaceholder")} />

        <label>{t("calendar.dialog.when")}</label>
        <div className="ev-when">
          {/* start and end share one grid (date | time | hint), so both rows get the same column widths in every state */}
          <div className="when-dates" data-allday={allDay || undefined}>
            <DateField label={t("calendar.dialog.startDate")} tz={tz} value={sd} onChange={(v) => moveStartTo({ sd: v })} />
            {!allDay && <TimeField label={t("calendar.dialog.startTime")} value={st} onChange={(v) => moveStartTo({ st: v })} />}
            <span aria-hidden />
            <DateField label={t("calendar.dialog.endDate")} tz={tz} value={ed} onChange={(v) => (setEd(v), touch())} />
            {!allDay && <TimeField label={t("calendar.dialog.endTime")} value={et} onChange={(v) => (setEt(v), touch())} />}
            <span className="muted small">{allDay ? t("calendar.dialog.lastDay") : t("calendar.dialog.end")}</span>
          </div>
          <div className="when">
            <Switch checked={allDay} onChange={(v) => (setAllDay(v), touch())} label={t("calendar.allDay")} />
            <span className="tz">{allDay ? t("calendar.dialog.datesOnly") : `${tz} (${tzOffsetLabel(tz)})`}</span>
          </div>
          {scope !== "occurrence" && (
          <div>
            <select aria-label={t("calendar.dialog.repeat")} value={repeat} disabled={!!existing?.patternUnsupported} onChange={(e) => (setRepeat(e.target.value), touch())}>
              <option value="none">{t("calendar.repeat.none")}</option>
              <option value="daily">{t("calendar.repeat.daily")}</option>
              <option value="weekdays">{t("calendar.repeat.weekdays")}</option>
              <option value="weekly">{startDayPreview ? t("calendar.repeat.weeklyOn", { weekday: wdLong(weekdayIdx(startDayPreview)) }) : t("calendar.repeat.weekly")}</option>
              <option value="monthly">{startDayPreview ? t("calendar.repeat.monthlyOn", { day: startDayPreview.d }) : t("calendar.repeat.monthly")}</option>
              <option value="yearly">{t("calendar.repeat.yearly")}</option>
              {customRule && <option value="custom">{t("calendar.repeat.custom", { text: customText ?? t("calendar.repeat.customFallback") })}</option>}
            </select>
            {existing?.rrule && scope !== "following" && <div className="muted small" style={{ marginTop: 4 }}>{t("calendar.dialog.repeatsNote")}</div>}
            {existing?.patternUnsupported && <div className="muted small" style={{ marginTop: 4 }}>{t("calendar.sync.patternUnsupported", { service: calInfo?.service ?? t("calendar.sync.ownApp") })}</div>}
          </div>
          )}
        </div>

        <label htmlFor="ev-where">{t("calendar.dialog.where")}</label>
        <input id="ev-where" value={where} onChange={(e) => (setWhere(e.target.value), touch())} placeholder={t("calendar.dialog.wherePlaceholder")} />

        <label>{t("calendar.dialog.invite")}</label>
        <div className="ev-invite">
          <RecipientField label={t("calendar.dialog.invite")} hideLabel values={invite} onChange={(v) => (setInvite(v), touch())} />
        </div>

        {remote ? (
          <div className="muted small" style={{ gridColumn: "2 / -1" }}>{(() => {
            const from = accounts.find((a) => a.id === calInfo?.accountId)?.email;
            const service = calInfo?.service;
            if (calInfo?.appInvites && from) return t("calendar.dialog.appSendsFrom", { email: from });
            return service
              ? (from ? t("calendar.dialog.serviceSendsFrom", { service, email: from }) : t("calendar.dialog.serviceSends", { service }))
              : (from ? t("calendar.dialog.genericSendsFrom", { email: from }) : t("calendar.dialog.genericSends"));
          })()}</div>
        ) : (
          <>
            <label htmlFor="ev-from">{t("calendar.dialog.sendFrom")}</label>
            <select id="ev-from" value={accountId} onChange={(e) => (setAccountId(e.target.value), touch())}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>)}
            </select>
          </>
        )}

        <label htmlFor="ev-cal">{t("calendar.dialog.calendar")}</label>
        <select
          id="ev-cal"
          disabled={!!eventId || writableCalendars(calendars).length < 2}
          value={calId}
          onChange={(e) => {
            setCalId(e.target.value);
            touch();
          }}
        >
          {(eventId ? calendars.filter((c) => c.id === calId) : writableCalendars(calendars)).map((c) => <option key={c.id} value={c.id}>{calendarTitle(c)}</option>)}
          {!calendars.some((c) => c.id === calId) && <option value={calId}>{t("calendar.myEvents")}</option>}
        </select>

        <label htmlFor="ev-rem">{t("calendar.dialog.reminder")}</label>
        <select id="ev-rem" value={reminder === null ? "" : String(reminder)} onChange={(e) => (setReminder(e.target.value === "" ? null : Number(e.target.value)), touch())}>
          {REMINDERS.map(([v, l]) => <option key={String(v)} value={v === null ? "" : String(v)}>{t(l)}</option>)}
        </select>

        <label htmlFor="ev-notes">{t("calendar.dialog.notes")}</label>
        <textarea id="ev-notes" rows={4} value={notes} onChange={(e) => (setNotes(e.target.value), touch())} />
      </div>
      {error && <div className="field-err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="row-inline" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        {windowed && existing && !existing.readOnly && (
          <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => void remove()} disabled={busy}><Trash2 size={14} /> {t("common.delete")}</button>
        )}
        <button className="btn" onClick={() => void close()} disabled={busy}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={busy || !loaded || !!existing?.readOnly} aria-busy={busy} onClick={() => void save()}>
          {hasGuests ? <CalendarCheck size={14} /> : <Check size={14} />} {primary}
        </button>
      </div>
    </Modal>
  );
}

function parseDay(v: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

