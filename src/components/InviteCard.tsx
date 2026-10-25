import { openUpdateLink } from "../updates";
import { CalendarCheck, CalendarDays, CalendarPlus, CalendarX, Check, ChevronDown, ChevronUp, CircleCheck, Clock, Download, History, Info, MapPin, Mail, RefreshCw, Repeat, TriangleAlert, UserRound, Video, X } from "lucide-react";
import { ReactNode, useCallback, useRef, useState } from "react";
import { api, CalInvite, MessageFull, Rsvp } from "../api";
import { calTz, configureCalendar, dayOfMs, fmtClockRange, fmtRange, fmtTime, isUrl, joinLabel, monthShort, personName, tzOffsetLabel, tzShortName, wdShort } from "../calendar";
import { accountColor } from "../prefs";
import { foldTarget } from "../calendarSync";
import { friendlyError, useStore } from "../store";
import { t } from "../i18n";
import { useLang, useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { Avatar, Dropdown, FloatingMenu, Modal } from "./ui";
// The invitation card of the reading pane (and the helpers the calendar views share with it). Kept apart from Calendar.tsx (the month / week / agenda views and the event dialog, loaded on demand, WP9d).
export const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const bare = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim();
export const nameOf = (v: string) => (v.includes("<") ? v.split("<")[0].trim().replace(/^"|"$/g, "") : "");

async function open(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  await openUpdateLink(url); // an open that fails says so and copies the link
}

export function useTz() {
  const prefs = useStore((s) => s.prefs);
  configureCalendar(prefs);
  return calTz(prefs);
}

export function useAccountColor() {
  const accounts = useStore((s) => s.accounts);
  const accent = useStore((s) => s.prefs.accent);
  const calendars = useStore((s) => s.calendars);
  // a synced calendar is drawn in its own colour (the id of such a calendar is what `eventColor` asks for); the invitations of a mailbox whose main calendar is
  // synced are part of that calendar and take its colour (W7.11), otherwise the mailbox's
  return useCallback((id: string) => {
    const target = foldTarget(calendars, id);
    const own = target?.remote ? target.color : "";
    if (own) return own;
    const a = accounts.find((x) => x.id === (calendars.find((c) => c.id === id)?.accountId ?? id));
    return a ? accountColor(a, accent) : undefined;
  }, [accounts, accent, calendars]);
}

// =============================================================== invitation card (reading pane)

const RS_ICON: Record<string, ReactNode> = {
  accepted: <Check size={11} strokeWidth={3} />,
  declined: <X size={11} strokeWidth={3} />,
  tentative: <span style={{ fontSize: 10, fontWeight: 800, lineHeight: 1 }}>?</span>,
};
const RS_CLASS: Record<string, string> = { accepted: "yes", declined: "no", tentative: "maybe", "needs-action": "wait", delegated: "wait" };
const RS_TEXT = {
  accepted: "calendar.invite.state.accepted", declined: "calendar.invite.state.declined", tentative: "calendar.invite.state.tentative",
  "needs-action": "calendar.invite.state.needsAction", delegated: "calendar.invite.state.delegated",
} as const;
/** The words for an attendee's answer ("accepted", "no response yet"); an unknown status is shown as it is. */
const rsText = (status: string): string => (status in RS_TEXT ? t(RS_TEXT[status as keyof typeof RS_TEXT]) : status);

function Dot({ status, label, title }: { status: string; label?: string; title?: string }) {
  useT();
  const text = label ?? rsText(status);
  return (
    <span className={`rs ${RS_CLASS[status] ?? "wait"}`} role="img" aria-label={text} title={title ?? text}>
      {RS_ICON[status]}
    </span>
  );
}

function CalTile({ start, allDay, tz, cancelled }: { start: number; allDay: boolean; tz: string; cancelled?: boolean }) {
  useLang(); // month and weekday names follow the language
  const d = allDay ? dayOfMs(start * 1000, "UTC") : dayOfMs(start * 1000, tz);
  return (
    <div className="cal-tile" aria-hidden="true" data-cancelled={cancelled ? "1" : undefined}>
      <b>{monthShort(d.m)}</b>
      <span>{d.d}</span>
      <small>{wdShort(new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay())}</small>
    </div>
  );
}

const YOU_TEXT = { accepted: "calendar.invite.you.accepted", tentative: "calendar.invite.you.tentative", declined: "calendar.invite.you.declined" } as const;
/** The keys of the three answer buttons: the label, its menu entries, its options button and the note dialog's title. */
const CHOICE = {
  accepted: { label: "calendar.rsvp.accept", send: "calendar.rsvp.acceptSend", note: "calendar.rsvp.acceptNote", silent: "calendar.rsvp.acceptSilent", options: "calendar.rsvp.acceptOptions", dialog: "calendar.rsvp.acceptDialog" },
  tentative: { label: "calendar.rsvp.tentative", send: "calendar.rsvp.tentativeSend", note: "calendar.rsvp.tentativeNote", silent: "calendar.rsvp.tentativeSilent", options: "calendar.rsvp.tentativeOptions", dialog: "calendar.rsvp.tentativeDialog" },
  declined: { label: "calendar.rsvp.decline", send: "calendar.rsvp.declineSend", note: "calendar.rsvp.declineNote", silent: "calendar.rsvp.declineSilent", options: "calendar.rsvp.declineOptions", dialog: "calendar.rsvp.declineDialog" },
} as const;

export function InviteCard({ m }: { m: MessageFull }) {
  const t = useT();
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
  const [applying, setApplying] = useState(false);
  const warnRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optsRef = useRef<HTMLButtonElement>(null); // the "options" button of the open menu: Escape returns focus to it
  const closeMenu = useCallback(() => setMenu(null), []);

  if (inv.parseError) {
    return (
      <div className="notice bad" role="alert">
        {t("calendar.invite.unreadable")}{" "}
        {m.confidential ? t("calendar.invite.confidentialNoSource") : (
          <><button className="link" onClick={() => void saveIcs()}>{t("calendar.saveIcs")}</button> · <button className="link" onClick={() => useStore.getState().setDialog({ type: "original", messageId: m.id })}>{t("calendar.invite.showOriginal")}</button></>
        )}
      </div>
    );
  }

  async function saveIcs() {
    try {
      const p = await api.calendarSaveIcs({ messageId: m.id });
      if (p) showToast(t("calendar.toast.saved", { name: p.split(/[\\/]/).pop() ?? p }), undefined, "success");
    } catch (e) {
      showToast(() => t("calendar.toast.saveFailed", { error: friendlyError(e) }), undefined, "error");
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
      if (send) showToast(t("calendar.toast.responseSent", { name: personName(inv.organizer) || m.fromName || m.fromEmail }), undefined, "success");
      else showToast(t("calendar.toast.savedNoResponse"), undefined, "success");
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
      showToast(t("calendar.toast.added"), undefined, "success");
      useStore.getState().bumpCal();
      await useStore.getState().reloadMessages();
    } catch (e) {
      showToast(() => t("calendar.toast.addFailed", { error: friendlyError(e) }), undefined, "error");
    } finally {
      setAdding(false);
    }
  };

  const removeFromCalendar = async () => {
    if (!inv.eventId) return;
    try {
      await api.calendarDeleteEvent(inv.eventId, false);
      showToast(t("calendar.toast.removed"), undefined, "success");
      useStore.getState().bumpCal();
      await useStore.getState().reloadMessages();
    } catch (e) {
      showToast(() => t("calendar.toast.removeFailed", { error: friendlyError(e) }), undefined, "error");
    }
  };

  const openInCalendar = () => {
    setCalDate(inv.allDay ? dayOfMs(inv.start * 1000, "UTC") : dayOfMs(inv.start * 1000, tz));
    setModule("calendar");
  };

  // the receiving server's sender check failed (W7.3): a change this message carries was not applied until the person says so
  const applyAnyway = async () => {
    setApplying(true);
    try {
      await api.calendarAddFromMessage(m.id, true);
      showToast(t("calendar.toast.applied"), undefined, "success");
      useStore.getState().bumpCal();
      await useStore.getState().reloadMessages();
      warnRef.current?.focus(); // the button is gone: the focus stays on the notice
    } catch (e) {
      showToast(() => t("calendar.toast.addFailed", { error: friendlyError(e) }), undefined, "error");
    } finally {
      setApplying(false);
    }
  };
  const unverifiedNotice = (who: string) =>
    inv.unverified ? (
      <div ref={warnRef} tabIndex={-1} className="notice bad" role="alert" style={{ margin: "0 16px 10px" }}>
        {t("calendar.invite.unverified", { name: who })}
        {inv.held && (
          <>
            {" "}{t("calendar.invite.held")}{" "}
            <button className="link" disabled={applying} onClick={() => void applyAnyway()}>{t("calendar.invite.applyAnyway")}</button>
          </>
        )}
      </div>
    ) : null;

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
    const replyKey = r.status === "accepted" ? "calendar.invite.reply.accepted" : r.status === "declined" ? "calendar.invite.reply.declined" : r.status === "tentative" ? "calendar.invite.reply.tentative" : "calendar.invite.reply.other";
    return (
      <article className="invite reply" aria-label={t("calendar.invite.replyAria", { summary: inv.summary })}>
        <div className="invite-head">
          <Dot status={r.status} />
          <div className="inv-rows">
            <div className="invite-title">{t(replyKey, { who, summary: inv.summary })}</div>
            <div className="inv-row"><Clock size={14} aria-hidden /><span>{fmtRange(inv, tz)}</span></div>
            {r.comment && <div className="inv-row"><Mail size={14} aria-hidden /><span>“{r.comment}”</span></div>}
            {inv.attendees.length > 1 && (
              <div className="inv-row sub">
                <Users2 />
                {/* (a held answer, sender check failed, changed nothing: "updated in your calendar" would contradict the notice below) */}
                <span>{t("calendar.invite.acceptedOf", { accepted, total: inv.attendees.length })}{inv.eventId && !inv.held ? ` · ${t("calendar.invite.statusUpdated")}` : ""}</span>
              </div>
            )}
          </div>
        </div>
        {unverifiedNotice(who)}
        <div className="invite-actions">
          <span className="grow" />
          {inv.eventId && <button className="link-btn" onClick={openInCalendar}><CalendarDays size={14} /> {t("calendar.invite.openInCalendar")}</button>}
        </div>
      </article>
    );
  }

  const status = inv.responded?.status;
  const ChoiceBtn = ({ r, icon }: { r: Rsvp; icon: ReactNode }) => {
    const keys = CHOICE[r];
    const label = t(keys.label);
    const chosen = status === r;
    const isBusy = busy === r;
    const others = busy !== null && busy !== r;
    const items = [
      { label: t(keys.send), onClick: () => void respond(r, true) },
      { label: t(keys.note), onClick: () => setNote(r) },
      { label: t(keys.silent), onClick: () => void respond(r, false) },
    ];
    return (
      <span className="rsvp" ref={menu === r ? menuRef : undefined} style={{ position: "relative" }}>
        <button className={`btn ${chosen || isBusy ? "chosen" : ""}`} disabled={others || busy === r} aria-busy={isBusy} aria-pressed={chosen} onClick={() => void respond(r, true)}>
          {isBusy ? <RefreshCw size={14} className="spin" /> : icon} {isBusy ? t("calendar.sending") : label}
        </button>
        <button ref={menu === r ? optsRef : undefined} className="btn" aria-label={t(keys.options)} aria-haspopup="menu" aria-expanded={menu === r} disabled={busy !== null} onClick={() => setMenu(menu === r ? null : r)}>
          <ChevronDown size={14} />
        </button>
        {menu === r && <FloatingMenu anchor={menuRef} trigger={optsRef} items={items} minWidth={280} onClose={closeMenu} />}
      </span>
    );
  };

  const mine = inv.you?.status === "organizer";
  const needsPermission = isReq && method === "REQUEST" && inv.you && !inv.you.onList && !forced && !inv.responded;
  const prev = inv.changed?.previous;

  return (
    <article className={`invite ${inv.cancelled ? "cancelled" : ""}`} aria-label={t("calendar.invite.aria", { summary: inv.summary })}>
      {inv.cancelled && (
        <div className="invite-banner bad" role="status"><CalendarX size={15} aria-hidden /> {t("calendar.invite.cancelled")}</div>
      )}
      {!inv.cancelled && inv.outdated && (
        <div className="invite-banner muted" role="status"><History size={15} aria-hidden /> {t("calendar.invite.outdated")}</div>
      )}
      {!inv.cancelled && !inv.outdated && inv.changed && (
        <div className="invite-banner" role="status">
          <RefreshCw size={15} aria-hidden /> {t("calendar.invite.updated", { changes: inv.changed.fields.map((f) => (f === "time" ? t("calendar.invite.change.time") : f === "location" ? t("calendar.invite.change.location") : t("calendar.invite.change.details"))).join(", ") })}
        </div>
      )}
      {!inv.cancelled && !inv.outdated && ended && (
        <div className="invite-banner muted" role="status"><History size={15} aria-hidden /> {t("calendar.invite.ended")}</div>
      )}
      {inv.trimmed && (
        <div className="invite-banner muted" role="status">
          <Info size={15} aria-hidden /> {t("calendar.invite.trimmed")}
        </div>
      )}
      {mine && !inv.cancelled && !ended && (
        <div className="invite-banner" role="status"><CalendarCheck size={15} aria-hidden /> {t("calendar.invite.organized")}</div>
      )}
      {!inv.cancelled && !inv.outdated && !ended && inv.responded && (
        <div className="invite-banner" role="status">
          <CircleCheck size={15} aria-hidden /> {t(YOU_TEXT[inv.responded.status])}
          {inv.responded.sentAt ? ` · ${t("calendar.invite.responseSent", { time: fmtTime(inv.responded.sentAt, tz) })}` : ` (${t("calendar.invite.noResponseSent")})`}
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
              {fmtRange(inv, tz)} {!inv.allDay && <span className="sub">({t("calendar.invite.yourTime", { tz })})</span>}
              {(orgTz || inv.recurrenceText) && (
                <><br /><span className="sub">{orgTz ? t("calendar.invite.organizerTime", { range: fmtClockRange(inv, orgTz), tz: tzShortName(orgTz, inv.start * 1000) }) : ""}{orgTz && inv.recurrenceText ? " · " : ""}{inv.recurrenceText ? <><Repeat size={11} aria-hidden style={{ verticalAlign: -1 }} /> {inv.recurrenceText}</> : ""}</span></>
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
              <span>{tx("calendar.invite.organizer", { name: <><b>{personName(inv.organizer)}</b>{inv.organizer.name ? ` <${inv.organizer.email}>` : ""}</> })}</span>
            </div>
          )}
          {inv.conflicts.length > 0 && !closed && (
            <div className="inv-row">
              <span className="conflict"><TriangleAlert size={13} aria-hidden /> {inv.conflicts.length > 1
                ? t("calendar.invite.overlapsMore", { summary: inv.conflicts[0].summary, range: fmtClockRange(inv.conflicts[0], tz), n: inv.conflicts.length - 1 })
                : t("calendar.invite.overlaps", { summary: inv.conflicts[0].summary, range: fmtClockRange(inv.conflicts[0], tz) })}</span>
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
            {t("calendar.invite.attendees", { n: inv.attendees.length })}
            {accepted + declined > 0 && ` · ${t("calendar.invite.nAccepted", { n: accepted })}${declined ? `, ${t("calendar.invite.nDeclined", { n: declined })}` : ""}`}
            {showAtt ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {showAtt && (
            <ul className="att-list">
              {inv.attendees.map((a) => (
                <li key={a.email}>
                  <Dot
                    status={a.isYou && inv.you ? (inv.you.status === "organizer" ? "accepted" : inv.you.status) : a.status}
                    label={a.role === "chair" ? t("calendar.invite.organizerStatus", { status: rsText(a.isYou && inv.you ? (inv.you.status === "organizer" ? "accepted" : inv.you.status) : a.status) }) : undefined}
                  />
                  <span>{personName(a)}{a.isYou ? ` (${t("calendar.invite.you")})` : ""}</span>
                  {a.role === "chair" && <span className="muted small">{t("calendar.invite.role.organizer")}</span>}
                  {a.role === "optional" && <span className="muted small">{t("calendar.invite.role.optional")}</span>}
                  {(a.isYou && inv.you ? inv.you.status : a.status) !== "accepted" && a.role !== "chair" && <span className="muted small">{rsText(a.isYou && inv.you ? (inv.you.status as string) : a.status)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {needsPermission && (
        <div className="notice" style={{ margin: "0 16px 10px" }}>
          {t("calendar.invite.notOnList", { name: organizerName })}{" "}
          <button className="link" onClick={() => setForced(true)}>{t("calendar.invite.respondAnyway")}</button>
        </div>
      )}
      {method === "PUBLISH" && (
        <div className="notice info" style={{ margin: "0 16px 10px" }}>
          {t("calendar.invite.published")} {inv.eventId ? t("calendar.invite.inYourCalendar") : <button className="link" disabled={adding} onClick={() => void addToCalendar()}>{adding ? t("calendar.adding") : t("calendar.addToCalendar")}</button>}
        </div>
      )}
      {method === "COUNTER" && (
        <div className="notice" style={{ margin: "0 16px 10px" }}>{t("calendar.invite.counter", { name: organizerName, range: fmtRange(inv, tz) })}</div>
      )}
      {method === "OTHER" && (
        <div className="notice info" style={{ margin: "0 16px 10px" }}>{t("calendar.invite.other")}</div>
      )}
      {unverifiedNotice(organizerName)}
      {err && (
        <div className="inline-err" role="alert" style={{ padding: "0 16px 8px" }}>
          <TriangleAlert size={14} aria-hidden /> {t("calendar.invite.sendFailed", { error: err.text })} <button className="link" onClick={err.retry}>{t("common.retry")}</button>
        </div>
      )}

      <div className="invite-actions" role="group" aria-label={t("calendar.invite.respondGroup")}>
        {method === "REQUEST" && !closed && !needsPermission && !mine && (
          inv.responded && busy === null ? (
            <Dropdown
              className="btn"
              title={t("calendar.invite.changeResponse")}
              items={[
                { label: t("calendar.rsvp.accept"), checked: status === "accepted", onClick: () => void respond("accepted", true) },
                { label: t("calendar.rsvp.tentative"), checked: status === "tentative", onClick: () => void respond("tentative", true) },
                { label: t("calendar.rsvp.decline"), checked: status === "declined", onClick: () => void respond("declined", true) },
              ]}
            >
              {t("calendar.invite.changeResponse")}
            </Dropdown>
          ) : (
            <>
              <ChoiceBtn r="accepted" icon={<Check size={14} />} />
              <ChoiceBtn r="tentative" icon={<span style={{ fontWeight: 800, width: 14, textAlign: "center" }}>?</span>} />
              <ChoiceBtn r="declined" icon={<X size={14} />} />
            </>
          )
        )}
        {closed && !inv.cancelled && <span className="muted small">{t("calendar.invite.closed")}</span>}
        {inv.cancelled && inv.eventId && <button className="btn" onClick={() => void removeFromCalendar()}>{t("calendar.invite.removeFromCalendar")}</button>}
        {method === "REQUEST" && !inv.eventId && !inv.cancelled && !mine && (
          <button className="btn" disabled={adding} onClick={() => void addToCalendar()}><CalendarPlus size={14} /> {adding ? t("calendar.adding") : t("calendar.addToCalendar")}</button>
        )}
        <span className="grow" />
        {inv.eventId && !inv.cancelled && <button className="link-btn" onClick={openInCalendar}><CalendarDays size={14} /> {t("calendar.invite.openInCalendar")}</button>}
        {!m.confidential && <button className="link-btn" onClick={() => void saveIcs()}><Download size={14} /> {t("calendar.saveIcs")}</button>}
      </div>

      {note && <NoteDialog r={note} onClose={() => setNote(null)} onSend={(text) => (setNote(null), void respond(note, true, text))} />}
    </article>
  );
}

function Users2() {
  return <CalendarCheck size={14} aria-hidden />;
}

function NoteDialog({ r, onClose, onSend }: { r: Rsvp; onClose: () => void; onSend: (text: string) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  return (
    <Modal title={t(CHOICE[r].dialog)} onClose={onClose}>
      <label className="muted small" htmlFor="rsvp-note">{t("calendar.invite.noteLabel")}</label>
      <textarea autoComplete="off" id="rsvp-note" rows={4} autoFocus value={text} onChange={(e) => setText(e.target.value)} style={{ width: "100%", marginTop: 6 }} />
      <div className="row-inline" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" onClick={() => onSend(text.trim())}>{t("calendar.send")}</button>
      </div>
    </Modal>
  );
}

