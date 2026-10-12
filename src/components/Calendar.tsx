import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CalendarCheck, CalendarDays, CalendarPlus, CalendarX, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, Clock, Download, History, MapPin,
  Mail, MoreHorizontal, RefreshCw, Repeat, TriangleAlert, UserRound, Video, X,
} from "lucide-react";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, CalEvent, CalInvite, errorCode, MessageFull, Rsvp } from "../api";
import {
  addDays, addMonths, calTz, chipClass, cmpDay, configureCalendar, Day, dayKey, dayOfMs, dayStartMs, daysBetween, eventColor, eventDaySpan, eventLabel, eventsOnDay, fmtClock,
  fmtClockRange, fmtDayLong, fmtDayShort, fmtRange, fmtTime, fromInputs, isUrl, joinLabel, layoutDay, monthGrid, monthTitle, myStatusLabel, partsOf, personName, repeatKind,
  repeatRule, sameDay, today, toInputs, tzOffsetLabel, tzShortName, weekDays, weekStartOf, weekTitle, WD_SHORT, WEEKDAYS, MONTHS_SHORT, CalView, MY_EVENTS_COLOR,
} from "../calendar";
import { friendlyError, EventInit, useStore } from "../store";
import { RecipientField } from "./Compose";
import { EmptyState } from "./overlays";
import { Avatar, Dropdown, MenuList, Modal, Switch, useOutside } from "./ui";

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const bare = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim();
const nameOf = (v: string) => (v.includes("<") ? v.split("<")[0].trim().replace(/^"|"$/g, "") : "");
const HOUR_PX = 48;

async function open(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

function useTz() {
  const prefs = useStore((s) => s.prefs);
  configureCalendar(prefs);
  return calTz(prefs);
}

function useAccountColor() {
  const accounts = useStore((s) => s.accounts);
  return useCallback((id: string) => accounts.find((a) => a.id === id)?.color ?? undefined, [accounts]);
}

// =============================================================== invitation card (reading pane)

const RS_ICON: Record<string, ReactNode> = {
  accepted: <Check size={11} strokeWidth={3} />,
  declined: <X size={11} strokeWidth={3} />,
  tentative: <span style={{ fontSize: 10, fontWeight: 800, lineHeight: 1 }}>?</span>,
};
const RS_CLASS: Record<string, string> = { accepted: "yes", declined: "no", tentative: "maybe", "needs-action": "wait", delegated: "wait" };
const RS_TEXT: Record<string, string> = { accepted: "accepted", declined: "declined", tentative: "tentative", "needs-action": "no response yet", delegated: "delegated" };

function Dot({ status }: { status: string }) {
  return (
    <span className={`rs ${RS_CLASS[status] ?? "wait"}`} role="img" aria-label={RS_TEXT[status] ?? status}>
      {RS_ICON[status]}
    </span>
  );
}

function CalTile({ start, allDay, tz, cancelled }: { start: number; allDay: boolean; tz: string; cancelled?: boolean }) {
  const d = allDay ? dayOfMs(start * 1000, "UTC") : dayOfMs(start * 1000, tz);
  return (
    <div className="cal-tile" aria-hidden="true" data-cancelled={cancelled ? "1" : undefined}>
      <b>{MONTHS_SHORT[d.m - 1]}</b>
      <span>{d.d}</span>
      <small>{WD_SHORT[new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay()]}</small>
    </div>
  );
}

const youText: Record<Rsvp, string> = { accepted: "You accepted", tentative: "You said maybe", declined: "You declined" };

export function InviteCard({ m }: { m: MessageFull }) {
  const inv = m.invite as CalInvite;
  const { showToast, replaceMessage, setModule, setCalDate } = useStore();
  const tz = useTz();
  const [busy, setBusy] = useState<Rsvp | null>(null);
  const [err, setErr] = useState<{ text: string; retry: () => void } | null>(null);
  const [forced, setForced] = useState(false);
  const [note, setNote] = useState<Rsvp | null>(null);
  const [menu, setMenu] = useState<Rsvp | null>(null);
  const [showAtt, setShowAtt] = useState(inv.attendees.length <= 8);
  const [adding, setAdding] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutside(menuRef, () => setMenu(null), menu !== null);

  if (inv.parseError) {
    return (
      <div className="notice bad" role="alert">
        This invitation couldn’t be read (invalid calendar data).{" "}
        <button className="link" onClick={() => void saveIcs()}>Save .ics</button> · <button className="link" onClick={() => useStore.getState().setDialog({ type: "original", messageId: m.id })}>Show original</button>
      </div>
    );
  }

  async function saveIcs() {
    try {
      const p = await api.calendarSaveIcs({ messageId: m.id });
      if (p) showToast(`Saved ${p.split(/[\\/]/).pop()}`, undefined, "success");
    } catch (e) {
      showToast(`Couldn’t save the file: ${friendlyError(e)}`, undefined, "error");
    }
  }

  const apply = (next: CalInvite) => replaceMessage({ ...m, invite: next });

  const respond = async (r: Rsvp, send: boolean, comment: string | null = null) => {
    setBusy(r);
    setErr(null);
    setMenu(null);
    try {
      const next = await api.calendarRespond(m.id, r, comment, send);
      apply(next);
      if (send) showToast(`Response sent to ${personName(inv.organizer) || m.fromName || m.fromEmail}`, undefined, "success");
      else showToast("Saved in your calendar (no response sent)", undefined, "success");
      useStore.getState().bumpCal();
    } catch (e) {
      setErr({ text: friendlyError(e), retry: () => void respond(r, send, comment) });
      // the answer is kept in the calendar even though sending failed
      void useStore.getState().reloadMessages();
    } finally {
      setBusy(null);
    }
  };

  const addToCalendar = async () => {
    setAdding(true);
    try {
      await api.calendarAddFromMessage(m.id);
      showToast("Added to your calendar", undefined, "success");
      useStore.getState().bumpCal();
      await useStore.getState().reloadMessages();
    } catch (e) {
      showToast(`Couldn’t add the event: ${friendlyError(e)}`, undefined, "error");
    } finally {
      setAdding(false);
    }
  };

  const removeFromCalendar = async () => {
    if (!inv.eventId) return;
    try {
      await api.calendarDeleteEvent(inv.eventId, false);
      showToast("Removed from your calendar", undefined, "success");
      useStore.getState().bumpCal();
      await useStore.getState().reloadMessages();
    } catch (e) {
      showToast(`Couldn’t remove it: ${friendlyError(e)}`, undefined, "error");
    }
  };

  const openInCalendar = () => {
    setCalDate(inv.allDay ? dayOfMs(inv.start * 1000, "UTC") : dayOfMs(inv.start * 1000, tz));
    setModule("calendar");
  };

  const orgTz = inv.tzid && inv.tzid !== tz && !inv.allDay && tzOffsetLabel(inv.tzid, inv.start * 1000) !== tzOffsetLabel(tz, inv.start * 1000) ? inv.tzid : null;
  const method = inv.method;
  const isReq = method === "REQUEST" || method === "PUBLISH";
  const ended = inv.ended && isReq;
  const closed = ended || inv.cancelled || inv.outdated;
  const organizerName = personName(inv.organizer) || m.fromName || m.fromEmail;
  const accepted = inv.attendees.filter((a) => a.status === "accepted").length;
  const declined = inv.attendees.filter((a) => a.status === "declined").length;

  // ---- an answer to an event you organized
  if (method === "REPLY" && inv.reply) {
    const r = inv.reply;
    const who = personName(r.from) || m.fromName || m.fromEmail;
    const word = r.status === "accepted" ? "accepted" : r.status === "declined" ? "declined" : r.status === "tentative" ? "said maybe to" : "replied to";
    return (
      <article className="invite reply" aria-label={`Meeting reply: ${inv.summary}`}>
        <div className="invite-head">
          <Dot status={r.status} />
          <div className="inv-rows">
            <div className="invite-title">{who} {word} “{inv.summary}”</div>
            <div className="inv-row"><Clock size={14} aria-hidden /><span>{fmtRange(inv, tz)}</span></div>
            {r.comment && <div className="inv-row"><Mail size={14} aria-hidden /><span>“{r.comment}”</span></div>}
            {inv.attendees.length > 1 && (
              <div className="inv-row sub">
                <Users2 />
                <span>{accepted} of {inv.attendees.length} accepted{inv.eventId ? " · Attendee status updated in your calendar" : ""}</span>
              </div>
            )}
          </div>
        </div>
        <div className="invite-actions">
          <span className="grow" />
          {inv.eventId && <button className="link-btn" onClick={openInCalendar}><CalendarDays size={14} /> Open in calendar</button>}
        </div>
      </article>
    );
  }

  const status = inv.responded?.status;
  const ChoiceBtn = ({ r, label, icon }: { r: Rsvp; label: string; icon: ReactNode }) => {
    const chosen = status === r;
    const isBusy = busy === r;
    const others = busy !== null && busy !== r;
    const items = [
      { label: `${label} and send response`, onClick: () => void respond(r, true) },
      { label: `${label} with a note…`, onClick: () => setNote(r) },
      { label: `${label} without sending a response`, onClick: () => void respond(r, false) },
    ];
    return (
      <span className="rsvp" ref={menu === r ? menuRef : undefined} style={{ position: "relative" }}>
        <button className={`btn ${chosen || isBusy ? "chosen" : ""}`} disabled={others || busy === r} aria-busy={isBusy} aria-pressed={chosen} onClick={() => void respond(r, true)}>
          {isBusy ? <RefreshCw size={14} className="spin" /> : icon} {isBusy ? "Sending…" : label}
        </button>
        <button className="btn" aria-label={`${label} options`} aria-haspopup="menu" aria-expanded={menu === r} disabled={busy !== null} onClick={() => setMenu(menu === r ? null : r)}>
          <ChevronDown size={14} />
        </button>
        {menu === r && (
          <div className="dd-pop left" style={{ top: "100%", minWidth: 280 }}>
            <MenuList items={items} onDone={() => setMenu(null)} />
          </div>
        )}
      </span>
    );
  };

  const needsPermission = isReq && method === "REQUEST" && inv.you && !inv.you.onList && !forced && !inv.responded;
  const prev = inv.changed?.previous;

  return (
    <article className={`invite ${inv.cancelled ? "cancelled" : ""}`} aria-label={`Meeting invitation: ${inv.summary}`}>
      {inv.cancelled && (
        <div className="invite-banner bad" role="status"><CalendarX size={15} aria-hidden /> The organizer cancelled this event</div>
      )}
      {!inv.cancelled && inv.outdated && (
        <div className="invite-banner muted" role="status"><History size={15} aria-hidden /> A newer version of this invitation was received. Respond from the latest message.</div>
      )}
      {!inv.cancelled && !inv.outdated && inv.changed && (
        <div className="invite-banner" role="status">
          <RefreshCw size={15} aria-hidden /> Updated by organizer: {inv.changed.fields.map((f) => (f === "time" ? "time changed" : f === "location" ? "location changed" : "details changed")).join(", ")}
        </div>
      )}
      {!inv.cancelled && !inv.outdated && ended && (
        <div className="invite-banner muted" role="status"><History size={15} aria-hidden /> This event has ended</div>
      )}
      {!inv.cancelled && !inv.outdated && !ended && inv.responded && (
        <div className="invite-banner" role="status">
          <CircleCheck size={15} aria-hidden /> {youText[inv.responded.status]}
          {inv.responded.sentAt ? ` · response sent ${fmtTime(inv.responded.sentAt, tz)}` : " (no response sent)"}
        </div>
      )}

      <div className="invite-head">
        <CalTile start={inv.start} allDay={inv.allDay} tz={tz} cancelled={inv.cancelled} />
        <div className="inv-rows">
          <div className="invite-title">{inv.summary}</div>
          <div className="inv-row">
            <Clock size={14} aria-hidden />
            <span>
              {inv.changed?.fields.includes("time") && prev && (
                <><s className="muted">{fmtRange({ start: prev.start, end: prev.end, allDay: inv.allDay }, tz)}</s><br /></>
              )}
              {fmtRange(inv, tz)} {!inv.allDay && <span className="sub">(your time, {tz})</span>}
              {(orgTz || inv.recurrenceText) && (
                <><br /><span className="sub">{orgTz ? `Organizer’s time: ${fmtClockRange(inv, orgTz)} ${tzShortName(orgTz, inv.start * 1000)}` : ""}{orgTz && inv.recurrenceText ? " · " : ""}{inv.recurrenceText ? <><Repeat size={11} aria-hidden style={{ verticalAlign: -1 }} /> {inv.recurrenceText}</> : ""}</span></>
              )}
            </span>
          </div>
          {(inv.location || inv.joinUrl) && (
            <div className="inv-row">
              <MapPin size={14} aria-hidden />
              <span>
                {inv.changed?.fields.includes("location") && prev && prev.location && (<><s className="muted">{prev.location}</s><br /></>)}
                {inv.location && (isUrl(inv.location) ? <button className="link" onClick={() => void open(inv.location!)}>{joinLabel(inv.location)}</button> : inv.location)}
                {inv.location && inv.joinUrl && inv.joinUrl !== inv.location && " · "}
                {inv.joinUrl && inv.joinUrl !== inv.location && <button className="link" onClick={() => void open(inv.joinUrl!)}><Video size={12} aria-hidden style={{ verticalAlign: -1 }} /> {joinLabel(inv.joinUrl)}</button>}
              </span>
            </div>
          )}
          {inv.organizer && (
            <div className="inv-row">
              <UserRound size={14} aria-hidden />
              <span>Organizer: <b>{personName(inv.organizer)}</b>{inv.organizer.name ? ` <${inv.organizer.email}>` : ""}</span>
            </div>
          )}
          {inv.conflicts.length > 0 && !closed && (
            <div className="inv-row">
              <span className="conflict"><TriangleAlert size={13} aria-hidden /> Overlaps “{inv.conflicts[0].summary}” {fmtClockRange(inv.conflicts[0], tz)}{inv.conflicts.length > 1 ? ` and ${inv.conflicts.length - 1} more` : ""}</span>
            </div>
          )}
        </div>
      </div>

      {inv.attendees.length > 0 && (
        <div className="inv-people">
          <button className="link-btn" style={{ paddingLeft: 0 }} aria-expanded={showAtt} onClick={() => setShowAtt(!showAtt)}>
            <span className="att-stack">
              {inv.attendees.slice(0, 3).map((a) => <Avatar key={a.email} name={personName(a)} size={22} />)}
            </span>{" "}
            {inv.attendees.length} attendee{inv.attendees.length === 1 ? "" : "s"}
            {accepted + declined > 0 && ` · ${accepted} accepted${declined ? `, ${declined} declined` : ""}`}
            {showAtt ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {showAtt && (
            <ul className="att-list">
              {inv.attendees.map((a) => (
                <li key={a.email}>
                  <Dot status={a.isYou && inv.you ? (inv.you.status === "organizer" ? "accepted" : inv.you.status) : a.status} />
                  <span>{personName(a)}{a.isYou ? " (you)" : ""}</span>
                  {a.role === "chair" && <span className="muted small">organizer</span>}
                  {a.role === "optional" && <span className="muted small">optional</span>}
                  {(a.isYou && inv.you ? inv.you.status : a.status) !== "accepted" && a.role !== "chair" && <span className="muted small">{RS_TEXT[a.isYou && inv.you ? (inv.you.status as string) : a.status]}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {needsPermission && (
        <div className="notice" style={{ margin: "0 16px 10px" }}>
          You’re not on the attendee list (this invite was forwarded to you). Responding tells {organizerName} you were added.{" "}
          <button className="link" onClick={() => setForced(true)}>Respond anyway</button>
        </div>
      )}
      {method === "PUBLISH" && (
        <div className="notice info" style={{ margin: "0 16px 10px" }}>
          Published event (no response needed). {inv.eventId ? "It is in your calendar." : <button className="link" disabled={adding} onClick={() => void addToCalendar()}>{adding ? "Adding…" : "Add to calendar"}</button>}
        </div>
      )}
      {method === "COUNTER" && (
        <div className="notice" style={{ margin: "0 16px 10px" }}>{organizerName} proposed a new time: {fmtRange(inv, tz)}. (Counter-proposals can’t be answered in Hey Look! yet.)</div>
      )}
      {method === "OTHER" && (
        <div className="notice info" style={{ margin: "0 16px 10px" }}>This message contains calendar data that Hey Look! can’t act on.</div>
      )}
      {err && (
        <div className="inline-err" role="alert" style={{ padding: "0 16px 8px" }}>
          <TriangleAlert size={14} aria-hidden /> Couldn’t send your response: {err.text} <button className="link" onClick={err.retry}>Retry</button>
        </div>
      )}

      <div className="invite-actions" role="group" aria-label="Respond to invitation">
        {method === "REQUEST" && !closed && !needsPermission && (
          inv.responded && busy === null ? (
            <Dropdown
              className="btn"
              title="Change response"
              items={[
                { label: "Accept", checked: status === "accepted", onClick: () => void respond("accepted", true) },
                { label: "Tentative", checked: status === "tentative", onClick: () => void respond("tentative", true) },
                { label: "Decline", checked: status === "declined", onClick: () => void respond("declined", true) },
              ]}
            >
              Change response
            </Dropdown>
          ) : (
            <>
              <ChoiceBtn r="accepted" label="Accept" icon={<Check size={14} />} />
              <ChoiceBtn r="tentative" label="Tentative" icon={<span style={{ fontWeight: 800, width: 14, textAlign: "center" }}>?</span>} />
              <ChoiceBtn r="declined" label="Decline" icon={<X size={14} />} />
            </>
          )
        )}
        {closed && !inv.cancelled && <span className="muted small">Responses are closed.</span>}
        {inv.cancelled && inv.eventId && <button className="btn" onClick={() => void removeFromCalendar()}>Remove from calendar</button>}
        {method === "REQUEST" && !inv.eventId && !inv.cancelled && (
          <button className="btn" disabled={adding} onClick={() => void addToCalendar()}><CalendarPlus size={14} /> {adding ? "Adding…" : "Add to calendar"}</button>
        )}
        <span className="grow" />
        {inv.eventId && !inv.cancelled && <button className="link-btn" onClick={openInCalendar}><CalendarDays size={14} /> Open in calendar</button>}
        <button className="link-btn" onClick={() => void saveIcs()}><Download size={14} /> Save .ics</button>
      </div>

      {note && <NoteDialog r={note} onClose={() => setNote(null)} onSend={(text) => (setNote(null), void respond(note, true, text))} />}
    </article>
  );
}

function Users2() {
  return <CalendarCheck size={14} aria-hidden />;
}

function NoteDialog({ r, onClose, onSend }: { r: Rsvp; onClose: () => void; onSend: (t: string) => void }) {
  const [t, setT] = useState("");
  return (
    <Modal title={`${r === "accepted" ? "Accept" : r === "tentative" ? "Tentative" : "Decline"} with a note`} onClose={onClose}>
      <label className="muted small" htmlFor="rsvp-note">Add a note (optional)</label>
      <textarea id="rsvp-note" rows={4} autoFocus value={t} onChange={(e) => setT(e.target.value)} style={{ width: "100%", marginTop: 6 }} />
      <div className="row-inline" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSend(t.trim())}>Send</button>
      </div>
    </Modal>
  );
}

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
}

/** Start of the next full hour (epoch seconds) in the calendar zone. */
function nextHour(tz: string): number {
  const p = partsOf(Date.now() + 3600_000, tz);
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d, p.h, 0) / 1000) - offsetSeconds(tz, Date.now() + 3600_000);
}
function offsetSeconds(tz: string, ms: number): number {
  const p = partsOf(ms, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 1000);
}

export function newEvent(init?: EventInit) {
  useStore.getState().setDialog({ type: "event", init });
}

/** Opens the New event dialog on a day (at 09:00 – 10:00) or at an exact time. */
function newOnDay(day: Day, tz: string, hour = 9, minute = 0) {
  const start = Math.floor(dayStartMs(day, tz) / 1000) + hour * 3600 + minute * 60;
  newEvent({ start, end: start + 3600 });
}

export function CalendarView() {
  const { prefs, calDate, calEvents, calendars, calLoading, calError, loadCalendar, setCalDate, setCalView, accounts } = useStore();
  const tz = useTz();
  const view: CalView = prefs.calView;
  const [pop, setPop] = useState<PopState | null>(null);
  const [focus, setFocus] = useState<Day>(calDate);
  const color = useAccountColor();
  const now = useNow();
  const todayD = today(tz);

  useEffect(() => {
    void loadCalendar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, prefs.weekStart, prefs.calTz]);
  useEffect(() => setFocus(calDate), [calDate]);

  const events = useMemo(
    () => calEvents.filter((e) => prefs.calShowDeclined || e.myStatus !== "declined"),
    [calEvents, prefs.calShowDeclined],
  );

  const step = (dir: 1 | -1) => setCalDate(view === "month" ? addMonths(calDate, dir) : view === "week" ? addDays(calDate, 7 * dir) : addDays(calDate, 30 * dir));
  const title = view === "month" ? monthTitle(calDate) : view === "week" ? weekTitle(weekDays(calDate, prefs.weekStart)) : `From ${fmtDayLong(calDate)}`;
  const openPop = (ev: CalEvent, el: HTMLElement) => setPop({ ev, rect: el.getBoundingClientRect() });
  void accounts;

  return (
    <section className="cal-view" aria-label="Calendar" aria-busy={calLoading}>
      <div className="cal-head">
        <button className="btn small" onClick={() => setCalDate(todayD)} title="Today (t)">Today</button>
        <button className="icon-btn" aria-label={view === "month" ? "Previous month" : view === "week" ? "Previous week" : "Previous 30 days"} title="Previous (←)" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button className="icon-btn" aria-label={view === "month" ? "Next month" : view === "week" ? "Next week" : "Next 30 days"} title="Next (→)" onClick={() => step(1)}><ChevronRight size={16} /></button>
        <h2>{title}</h2>
        <span className="muted small">{tz} ({tzOffsetLabel(tz)})</span>
        <div className="seg" role="tablist" aria-label="Calendar view">
          {(["month", "week", "agenda"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} title={`${v[0].toUpperCase()}${v.slice(1)} (${v[0]})`} onClick={() => setCalView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {calError && (
        <div className="notice bad" style={{ margin: "8px 16px 0" }} role="alert">
          Couldn’t load events: {calError} <button className="link" onClick={() => void loadCalendar()}>Retry</button>
        </div>
      )}
      {view === "month" && (
        <MonthView events={events} focus={focus} setFocus={setFocus} tz={tz} anchor={calDate} weekStart={prefs.weekStart} todayD={todayD} color={color} openPop={openPop} loading={calLoading} />
      )}
      {view === "week" && <WeekView events={events} tz={tz} anchor={calDate} weekStart={prefs.weekStart} todayD={todayD} now={now} color={color} openPop={openPop} />}
      {view === "agenda" && <AgendaView events={events} tz={tz} from={calDate} todayD={todayD} color={color} openPop={openPop} loading={calLoading} />}
      {pop && <EventPopover state={pop} tz={tz} color={eventColor(pop.ev, color)} onClose={() => setPop(null)} />}
      <span hidden>{calendars.length}</span>
    </section>
  );
}

function Chip({ ev, tz, color, openPop }: { ev: CalEvent; tz: string; color: string; openPop: (e: CalEvent, el: HTMLElement) => void }) {
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
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {!ev.allDay && <time>{fmtTime(ev.start, tz)}</time>}
      <span className="ellipsis">{ev.summary}</span>
    </button>
  );
}

const MAX_CHIPS = 3;

function MonthView({
  events, focus, setFocus, tz, anchor, weekStart, todayD, color, openPop, loading,
}: {
  events: CalEvent[]; focus: Day; setFocus: (d: Day) => void; tz: string; anchor: Day; weekStart: number; todayD: Day;
  color: (id: string) => string | undefined; openPop: (e: CalEvent, el: HTMLElement) => void; loading: boolean;
}) {
  const setCalDate = useStore((s) => s.setCalDate);
  const setCalView = useStore((s) => s.setCalView);
  const grid = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const dows = Array.from({ length: 7 }, (_, i) => WD_SHORT[(weekStart + i) % 7]);
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
              aria-label={`${fmtDayLong(day)}${isToday ? ", today" : ""}${list.length ? `, ${list.length} event${list.length === 1 ? "" : "s"}` : ""}`}
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
              <span className="mnum">{day.d === 1 ? `${day.d} ${MONTHS_SHORT[day.m - 1]}` : day.d}</span>
              {loading && list.length === 0 && !other ? null : shown.map((ev) => <Chip key={`${ev.id}:${ev.start}`} ev={ev} tz={tz} color={eventColor(ev, color)} openPop={openPop} />)}
              {more > 0 && (
                <button type="button" className="ev-more" onClick={(e) => (e.stopPropagation(), setCalDate(day), setCalView("agenda"))}>
                  +{more} more
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
  events, tz, anchor, weekStart, todayD, now, color, openPop,
}: {
  events: CalEvent[]; tz: string; anchor: Day; weekStart: number; todayD: Day; now: number;
  color: (id: string) => string | undefined; openPop: (e: CalEvent, el: HTMLElement) => void;
}) {
  const days = useMemo(() => weekDays(anchor, weekStart), [anchor, weekStart]);
  const scroller = useRef<HTMLDivElement>(null);
  const [sbw, setSbw] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // working hours first: 08:00, or earlier when it is early in the morning today
    const h = days.some((d) => sameDay(d, todayD)) ? Math.min(Math.max(partsOf(Date.now(), tz).h - 1, 0), 8) : 8;
    el.scrollTop = h * HOUR_PX - (h > 0 ? 8 : 0);
    setSbw(el.offsetWidth - el.clientWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0].y, days[0].m, days[0].d]);
  const nowP = partsOf(now, tz);
  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div className="week-wrap" role="grid" aria-label={weekTitle(days)}>
    <div className="week-head" style={{ paddingRight: sbw }}>
      <div className="wk-dh" />
      {days.map((d) => (
        <div key={dayKey(d)} className={`wk-dh ${sameDay(d, todayD) ? "today" : ""}`} role="columnheader">
          {WD_SHORT[(weekdayIdx(d))]}
          <b>{d.d}</b>
        </div>
      ))}
      <div className="wk-allday-label">All day</div>
      {days.map((d) => (
        <div key={`ad-${dayKey(d)}`} className="wk-allday">
          {eventsOnDay(events, d, tz).filter((e) => e.allDay).map((ev) => <Chip key={`${ev.id}:${ev.start}`} ev={ev} tz={tz} color={eventColor(ev, color)} openPop={openPop} />)}
        </div>
      ))}
    </div>
    <div className="week" ref={scroller}>
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
              const mins = Math.max(0, Math.min(23 * 60 + 30, Math.round(((e.clientY - r.top) / HOUR_PX) * 2) * 30));
              newOnDay(d, tz, Math.floor(mins / 60), mins % 60);
            }}
          >
            {placed.map(({ ev: t, lane, lanes }) => {
              const ev = t.ev;
              const top = ((t.start - dayStart) / 3600) * HOUR_PX;
              const h = Math.max(((t.end - t.start) / 3600) * HOUR_PX, 20);
              return (
                <button
                  key={`${ev.id}:${ev.start}`}
                  type="button"
                  className={`wk-ev ${chipClass(ev)}`}
                  style={{ top, height: h - 1, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, right: "auto", ["--ev" as string]: eventColor(ev, color) }}
                  aria-label={eventLabel(ev, tz)}
                  title={eventLabel(ev, tz)}
                  onClick={(e) => (e.stopPropagation(), openPop(ev, e.currentTarget))}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <b>{ev.summary}</b>
                  {h > 34 && <span>{fmtClockRange(ev, tz)}</span>}
                </button>
              );
            })}
            {sameDay(d, todayD) && <div className="now-line" style={{ top: ((nowP.h * 60 + nowP.mi) / 60) * HOUR_PX }} aria-hidden="true" />}
          </div>
        );
      })}
    </div>
    </div>
  );
}

const weekdayIdx = (d: Day) => new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();

function statusPill(ev: CalEvent): ReactNode {
  if (ev.status === "cancelled") return <span className="pill bad">Cancelled</span>;
  const s = ev.myStatus;
  if (s === "accepted") return <span className="pill good">Accepted</span>;
  if (s === "tentative") return <span className="pill warn">Tentative</span>;
  if (s === "declined") return <span className="pill">Declined</span>;
  if (s === "needs-action") return <span className="pill warn">Not responded</span>;
  if (s === "organizer") return <span className="pill accent">Organizer</span>;
  return null;
}

function AgendaView({
  events, tz, from, todayD, color, openPop, loading,
}: {
  events: CalEvent[]; tz: string; from: Day; todayD: Day; color: (id: string) => string | undefined; openPop: (e: CalEvent, el: HTMLElement) => void; loading: boolean;
}) {
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
        <EmptyState icon={<CalendarDays size={44} />} title="Nothing scheduled in the next 30 days." text="Invitations you receive and events you create show up here." />
        <div style={{ textAlign: "center" }}><button className="btn primary" onClick={() => newOnDay(from, tz, 9)}><CalendarPlus size={14} /> New event</button></div>
      </div>
    );
  }
  return (
    <div className="agenda" role="list" aria-label="Agenda">
      {groups.map(({ d, list }) => (
        <div key={dayKey(d)} role="listitem">
          <div className="ag-day">{sameDay(d, todayD) ? `Today · ${fmtDayShort(d)}` : fmtDayShort(d)}</div>
          {list.map((ev) => (
            <div
              key={`${ev.id}:${ev.start}`}
              className="ag-row"
              role="button"
              tabIndex={0}
              style={{ ["--ev" as string]: eventColor(ev, color) }}
              aria-label={eventLabel(ev, tz)}
              onClick={(e) => openPop(ev, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openPop(ev, e.currentTarget);
                }
              }}
            >
              <span className="ag-time">{ev.allDay ? "All day" : `${fmtTime(ev.start, tz)} – ${fmtTime(ev.end, tz)}`}</span>
              <span className="ag-bar" />
              <span className="grow ellipsis" style={{ textDecoration: ev.status === "cancelled" ? "line-through" : undefined, opacity: ev.status === "cancelled" ? 0.7 : 1 }}>
                <b>{ev.summary}</b>
                {ev.location && <span className="muted small"> · {isUrl(ev.location) ? joinLabel(ev.location).replace("Join ", "").replace(" meeting", "") : ev.location}</span>}
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

function EventPopover({ state, tz, color, onClose }: { state: PopState; tz: string; color: string; onClose: () => void }) {
  const { showToast, choose, confirm, setDialog, bumpCal, setModule, setView, select } = useStore();
  const ev = state.ev;
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose, true);
  const [busy, setBusy] = useState<Rsvp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const mine = ev.calendarId === "local";
  const invite = ev.calendarId.startsWith("invites:");
  const canRsvp = invite && !!ev.sourceMessageId && ev.myStatus !== "organizer" && ev.myStatus !== null && ev.status !== "cancelled";

  // below the chip, or above it when there is no room; kept inside the window
  useEffect(() => {
    const el = ref.current;
    const h = el?.offsetHeight ?? 220;
    const w = 392;
    const r = state.rect;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setPos({ top, left });
  }, [state.rect, ev.id]);

  const respond = async (r: Rsvp) => {
    if (!ev.sourceMessageId) return;
    setBusy(r);
    setErr(null);
    try {
      await api.calendarRespond(ev.sourceMessageId, r, null, true);
      showToast(`Response sent to ${personName(ev.organizer) || "the organizer"}`, undefined, "success");
      bumpCal();
      onClose();
    } catch (e) {
      setErr(`Couldn’t send your response: ${friendlyError(e)}`);
      bumpCal();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const others = ev.attendees.filter((a) => a.role !== "chair").length;
    let notify = false;
    if (mine && ev.myStatus === "organizer" && others > 0) {
      const c = await choose({
        title: `Cancel this event for ${others} attendee${others === 1 ? "" : "s"}?`,
        body: "Send a cancellation so they can remove it from their calendars, or delete it only here.",
        choices: [
          { id: "keep", label: "Keep" },
          { id: "silent", label: "Delete without notifying", kind: "danger" },
          { id: "send", label: "Send cancellation", kind: "primary" },
        ],
      });
      if (c === "keep") return;
      notify = c === "send";
    } else if (!(await confirm({ title: `Delete “${ev.summary}”?`, body: ev.rrule ? "Every occurrence of this repeating event is deleted." : undefined, confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.calendarDeleteEvent(ev.id, notify);
      showToast(notify ? "Event cancelled and attendees notified" : "Event deleted", undefined, "success");
    } catch (e) {
      showToast(friendlyError(e), undefined, errorCode(e) === "CAL_SEND_FAILED" ? "error" : "error");
    }
    bumpCal();
    onClose();
  };

  const duplicate = () => {
    onClose();
    setDialog({ type: "event", init: { summary: `${ev.summary} (copy)`, start: ev.start, end: ev.end, allDay: ev.allDay, location: ev.location ?? undefined, description: ev.description ?? undefined } });
  };

  const openMail = async () => {
    if (!ev.sourceMessageId) return;
    try {
      const r = await api.calendarOpenMessage(ev.sourceMessageId);
      onClose();
      setModule("mail");
      await setView(r.folder, r.accountId);
      await select(r.threadId);
    } catch (e) {
      showToast(friendlyError(e), undefined, "error");
    }
  };

  const saveIcs = async () => {
    try {
      const p = await api.calendarSaveIcs({ eventId: ev.id });
      if (p) showToast(`Saved ${p.split(/[\\/]/).pop()}`, undefined, "success");
    } catch (e) {
      showToast(`Couldn’t save the file: ${friendlyError(e)}`, undefined, "error");
    }
    onClose();
  };

  const others = ev.attendees.length;
  return (
    <div ref={ref} className="popover ev-pop" role="dialog" aria-label={`Event: ${ev.summary}`} style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 40 }}>
      <h4 style={{ textDecoration: ev.status === "cancelled" ? "line-through" : undefined }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: color, marginTop: 6, flex: "none" }} aria-hidden />
        <span className="grow">{ev.summary}</span>
        <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={14} /></button>
      </h4>
      <div className="inv-row"><Clock size={14} aria-hidden /><span>{fmtRange(ev, tz)}{ev.recurrenceText ? <><br /><span className="sub"><Repeat size={11} aria-hidden style={{ verticalAlign: -1 }} /> {ev.recurrenceText}</span></> : ""}</span></div>
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
            {ev.organizer ? `${personName(ev.organizer)} (organizer)` : ""}{ev.organizer && others > 1 ? " · " : ""}{others > 1 ? `${others} attendees` : ""}
          </span>
        </div>
      )}
      {myStatusLabel(ev.myStatus) && ev.myStatus !== "organizer" && (
        <div className="inv-row"><CircleCheck size={14} aria-hidden /><span>{ev.status === "cancelled" ? "Cancelled by the organizer" : myStatusLabel(ev.myStatus)}{ev.respondedAt === null && ev.myStatus !== "needs-action" ? " (no response sent)" : ""}</span></div>
      )}
      {ev.description && <div className="muted small" style={{ whiteSpace: "pre-wrap", maxHeight: 90, overflow: "auto" }}>{ev.description.slice(0, 600)}</div>}
      {err && <div className="inline-err" role="alert"><TriangleAlert size={14} aria-hidden /> {err}</div>}
      <div className="ev-acts">
        {canRsvp && (
          <>
            <button className={`btn small ${ev.myStatus === "accepted" ? "chosen" : ""}`} disabled={busy !== null} onClick={() => void respond("accepted")}>{busy === "accepted" ? "Sending…" : "Accept"}</button>
            <button className={`btn small ${ev.myStatus === "tentative" ? "chosen" : ""}`} disabled={busy !== null} onClick={() => void respond("tentative")}>{busy === "tentative" ? "Sending…" : "Tentative"}</button>
            <button className={`btn small ${ev.myStatus === "declined" ? "chosen" : ""}`} disabled={busy !== null} onClick={() => void respond("declined")}>{busy === "declined" ? "Sending…" : "Decline"}</button>
          </>
        )}
        {ev.joinUrl && <button className="btn small primary" onClick={() => void open(ev.joinUrl!)}><Video size={13} /> Join</button>}
        <span className="grow" />
        {invite && ev.sourceMessageId && <button className="icon-btn" title="Open invitation email" aria-label="Open invitation email" onClick={() => void openMail()}><Mail size={15} /></button>}
        <Dropdown
          className="icon-btn"
          caret={false}
          align="right"
          title="More actions"
          items={[
            { label: "Edit", disabled: !mine, onClick: () => (onClose(), setDialog({ type: "event", eventId: ev.id })) },
            { label: "Duplicate", onClick: duplicate },
            { label: "Save .ics", onClick: () => void saveIcs() },
            { divider: true },
            { label: "Delete", onClick: () => void remove() },
          ]}
        >
          <MoreHorizontal size={15} />
        </Dropdown>
      </div>
    </div>
  );
}

// =============================================================== sidebar (folder pane in Calendar mode)

export function CalSidebar() {
  const { prefs, calDate, calEvents, calendars, setCalDate, setPrefs, bumpCal, accounts } = useStore();
  const tz = useTz();
  const todayD = today(tz);
  const [month, setMonth] = useState<Day>(calDate);
  useEffect(() => setMonth({ ...calDate, d: 1 }), [calDate]);
  const grid = useMemo(() => monthGrid(month, prefs.weekStart), [month, prefs.weekStart]);
  const dows = Array.from({ length: 7 }, (_, i) => WD_SHORT[(prefs.weekStart + i) % 7][0]);
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

  const cals = calendars.length ? calendars : [{ id: "local", name: "My events", color: MY_EVENTS_COLOR, accountId: null, visible: true }];
  return (
    <>
      <div className="fp-group">
        <div className="mini-head">
          <span>{monthTitle(month)}</span>
          <span>
            <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={14} /></button>
            <button className="icon-btn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={14} /></button>
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
                      aria-label={`${fmtDayLong(d)}${has.has(dayKey(d)) ? ", has events" : ""}`}
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
        <div className="fp-head" style={{ cursor: "default" }}>Calendars</div>
        <div className="cal-list">
          {cals.map((c) => {
            const acct = accounts.find((a) => a.id === c.accountId);
            const col = c.id === "local" ? MY_EVENTS_COLOR : acct?.color || c.color || "var(--accent)";
            return (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={c.visible}
                  style={{ accentColor: col }}
                  onChange={(e) => void api.calendarSetVisible(c.id, e.target.checked).then(() => bumpCal())}
                />
                <span className="ellipsis">{c.name}</span>
              </label>
            );
          })}
          <label>
            <input type="checkbox" checked={prefs.calShowDeclined} onChange={(e) => setPrefs({ calShowDeclined: e.target.checked })} />
            <span>Show declined events</span>
          </label>
        </div>
      </div>
    </>
  );
}

// =============================================================== new / edit event

const REMINDERS: [number | null, string][] = [
  [null, "No reminder"], [0, "At the start"], [5, "5 minutes before"], [10, "10 minutes before"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [1440, "1 day before"],
];

export function EventDialog({ eventId, init }: { eventId?: string; init?: EventInit }) {
  const { prefs, accounts, setDialog, showToast, bumpCal } = useStore();
  const tz = useTz();
  const [loaded, setLoaded] = useState(!eventId);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [title, setTitle] = useState(init?.summary ?? "");
  const startSec = init?.start ?? nextHour(tz);
  const endSec = init?.end ?? startSec + 3600;
  const [allDay, setAllDay] = useState(init?.allDay ?? false);
  const [sd, setSd] = useState(toInputs(startSec, tz).date);
  const [st, setSt] = useState(toInputs(startSec, tz).time);
  const [ed, setEd] = useState(toInputs(allDay ? endSec - 86400 : endSec, tz).date);
  const [et, setEt] = useState(toInputs(endSec, tz).time);
  const [where, setWhere] = useState(init?.location ?? "");
  const [notes, setNotes] = useState(init?.description ?? "");
  const [invite, setInvite] = useState<string[]>(init?.attendees ?? []);
  const [accountId, setAccountId] = useState(prefs.defaultAccount || accounts[0]?.id || "");
  const [reminder, setReminder] = useState<number | null>(prefs.eventReminderMin);
  const [repeat, setRepeat] = useState("none");
  const [customRule, setCustomRule] = useState<string | null>(null);
  const [customText, setCustomText] = useState<string | null>(null);
  const [existing, setExisting] = useState<CalEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const touch = () => setDirty(true);

  useEffect(() => {
    if (!eventId) return;
    let live = true;
    api.calendarGetEvent(eventId).then((e) => {
      if (!live) return;
      setExisting(e);
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
      const startDay = e.allDay ? dayOfMs(e.start * 1000, "UTC") : dayOfMs(e.start * 1000, tz);
      const k = repeatKind(e.rrule, startDay);
      setRepeat(k);
      if (k === "custom") {
        setCustomRule(e.rrule);
        setCustomText(e.recurrenceText);
      }
      setLoaded(true);
    }).catch((e) => live && setLoadErr(friendlyError(e)));
    return () => {
      live = false;
    };
  }, [eventId, tz]);

  const close = async () => {
    if (dirty && !(await useStore.getState().confirm({ title: "Discard this event?", body: "Your changes haven’t been saved.", confirmLabel: "Discard", danger: true }))) return;
    setDialog(null);
  };

  const hasGuests = invite.length > 0;
  const startMs = fromInputs(sd, st, tz, allDay);
  const endMs = fromInputs(ed, et, tz, allDay);
  const everyone = existing?.attendees.length ? existing.attendees.length > 1 : false;
  const primary = busy ? (hasGuests ? "Sending…" : "Saving…") : hasGuests ? (existing && everyone ? "Send update" : "Send invitations") : "Save";

  const save = async () => {
    setError(null);
    if (!title.trim()) return setError("Add a title.");
    if (startMs === null || endMs === null) return setError("Check the date and time.");
    const s = startMs;
    const e = allDay ? endMs + 86400 : endMs;
    if (e <= s && !allDay) return setError("End must be after start.");
    if (allDay && e <= s) return setError("End must be after start.");
    const bad = invite.find((a) => !EMAIL.test(bare(a)));
    if (bad) return setError(`Check the address: ${bad}`);
    if (hasGuests && !accountId) return setError("Choose the account to send from.");
    const startDay = allDay ? dayOfMs(s * 1000, "UTC") : dayOfMs(s * 1000, tz);
    const rrule = repeat === "custom" ? customRule : repeatRule(repeat, startDay);
    setBusy(true);
    try {
      const ev = await api.calendarSaveEvent(
        {
          id: eventId ?? null,
          accountId: accountId || null,
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
        },
        hasGuests,
      );
      showToast(hasGuests ? `Invitations sent to ${invite.length} ${invite.length === 1 ? "person" : "people"}` : eventId ? "Event saved" : "Event added", undefined, "success");
      bumpCal();
      useStore.getState().setCalDate(allDay ? dayOfMs(ev.start * 1000, "UTC") : dayOfMs(ev.start * 1000, tz));
      setDialog(null);
    } catch (err) {
      bumpCal();
      if (errorCode(err) === "CAL_SEND_FAILED") {
        showToast(friendlyError(err), undefined, "error");
        setDialog(null);
      } else {
        setError(friendlyError(err));
        setBusy(false);
      }
    }
  };

  if (loadErr) {
    return (
      <Modal title="Edit event" onClose={() => setDialog(null)} width={560}>
        <div className="notice bad">{loadErr}</div>
      </Modal>
    );
  }
  const startDayPreview = parseDay(sd);
  return (
    <Modal title={eventId ? "Edit event" : "New event"} onClose={() => void close()} width={560}>
      <div className="ev-form" aria-busy={!loaded}>
        <label htmlFor="ev-title">Title</label>
        <input id="ev-title" autoFocus value={title} aria-invalid={!!error && !title.trim()} onChange={(e) => (setTitle(e.target.value), touch())} placeholder="Add a title" />

        <label>When</label>
        <div>
          <div className="when">
            <input type="date" aria-label="Start date" value={sd} onChange={(e) => (setSd(e.target.value), touch(), ed < e.target.value && setEd(e.target.value))} />
            {!allDay && <input type="time" aria-label="Start time" value={st} onChange={(e) => (setSt(e.target.value), touch())} />}
          </div>
          <div className="when" style={{ marginTop: 6 }}>
            <input type="date" aria-label="End date" value={ed} onChange={(e) => (setEd(e.target.value), touch())} />
            {!allDay && <input type="time" aria-label="End time" value={et} onChange={(e) => (setEt(e.target.value), touch())} />}
            <span className="muted small">{allDay ? "(last day)" : "(end)"}</span>
          </div>
          <div className="when" style={{ marginTop: 8 }}>
            <Switch checked={allDay} onChange={(v) => (setAllDay(v), touch())} label="All day" />
            <span className="tz">{allDay ? "Dates only" : `${tz} (${tzOffsetLabel(tz)})`}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <select aria-label="Repeat" value={repeat} onChange={(e) => (setRepeat(e.target.value), touch())}>
              <option value="none">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekdays">Every weekday (Mon–Fri)</option>
              <option value="weekly">{startDayPreview ? `Every week on ${WEEKDAYS[weekdayIdx(startDayPreview)]}` : "Every week"}</option>
              <option value="monthly">{startDayPreview ? `Every month on day ${startDayPreview.d}` : "Every month"}</option>
              <option value="yearly">Every year</option>
              {customRule && <option value="custom">{customText ?? "Custom"} (kept as is)</option>}
            </select>
            {existing?.rrule && <div className="muted small" style={{ marginTop: 4 }}>This event repeats. Changes apply to every occurrence.</div>}
          </div>
        </div>

        <label htmlFor="ev-where">Where</label>
        <input id="ev-where" value={where} onChange={(e) => (setWhere(e.target.value), touch())} placeholder="Room, address or meeting link" />

        <label>Invite</label>
        <div className="ev-invite">
          <RecipientField label="Invite" hideLabel values={invite} onChange={(v) => (setInvite(v), touch())} />
        </div>

        <label htmlFor="ev-from">Send from</label>
        <select id="ev-from" value={accountId} onChange={(e) => (setAccountId(e.target.value), touch())}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>)}
        </select>

        <label htmlFor="ev-cal">Calendar</label>
        <select id="ev-cal" disabled value="local" aria-readonly>
          <option value="local">My events</option>
        </select>

        <label htmlFor="ev-rem">Reminder</label>
        <select id="ev-rem" value={reminder === null ? "" : String(reminder)} onChange={(e) => (setReminder(e.target.value === "" ? null : Number(e.target.value)), touch())}>
          {REMINDERS.map(([v, l]) => <option key={String(v)} value={v === null ? "" : String(v)}>{l}</option>)}
        </select>

        <label htmlFor="ev-notes">Notes</label>
        <textarea id="ev-notes" rows={4} value={notes} onChange={(e) => (setNotes(e.target.value), touch())} />
      </div>
      {error && <div className="field-err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="row-inline" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" onClick={() => void close()} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={busy || !loaded} aria-busy={busy} onClick={() => void save()}>
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
export function meetingToDraft(m: MeetingState, tz: string): { meeting: { start: number; end: number; allDay: boolean; tzid: string | null; location: string | null } } | { error: string } {
  const s = fromInputs(m.sd, m.st, tz, m.allDay);
  const e = fromInputs(m.ed, m.et, tz, m.allDay);
  if (s === null || e === null) return { error: "Check the meeting date and time." };
  const end = m.allDay ? e + 86400 : e;
  if (end <= s) return { error: "The meeting must end after it starts." };
  return { meeting: { start: s, end, allDay: m.allDay, tzid: m.allDay ? null : tz, location: m.where.trim() || null } };
}

export function MeetingStrip({ value, onChange, tz }: { value: MeetingState; onChange: (m: MeetingState) => void; tz: string }) {
  const set = (p: Partial<MeetingState>) => onChange({ ...value, ...p });
  return (
    <div className="cp-event" role="group" aria-label="Meeting details">
      <label htmlFor="mt-sd">When</label>
      <div className="when">
        <input id="mt-sd" type="date" aria-label="Start date" value={value.sd} onChange={(e) => set({ sd: e.target.value, ed: value.ed < e.target.value ? e.target.value : value.ed })} />
        {!value.allDay && <input type="time" aria-label="Start time" value={value.st} onChange={(e) => set({ st: e.target.value })} />}
        <span className="muted">–</span>
        {!value.allDay && <input type="time" aria-label="End time" value={value.et} onChange={(e) => set({ et: e.target.value })} />}
        <input type="date" aria-label="End date" value={value.ed} onChange={(e) => set({ ed: e.target.value })} />
        <Switch checked={value.allDay} onChange={(v) => set({ allDay: v })} label="All day" />
        <span className="tz">{value.allDay ? "" : tz}</span>
      </div>
      <label htmlFor="mt-where">Where</label>
      <input id="mt-where" value={value.where} onChange={(e) => set({ where: e.target.value })} placeholder="Room, address or meeting link" />
    </div>
  );
}

export { calTz };
