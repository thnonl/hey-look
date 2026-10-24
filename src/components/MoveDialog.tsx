// Move to another calendar (W7.5, REQ-7.5.1): the target list, a note for a series (it moves whole) and, when guests stop the move, the sentence that says so instead of the list. Part of the Calendar chunk.
import { useEffect, useRef, useState } from "react";
import { api, CalEvent, CalendarInfo } from "../api";
import { calendarTitle } from "../calendarSync";
import { useT } from "../i18n/react";
import { friendlyError, useStore } from "../store";
import { Modal } from "./ui";

export function MoveDialog({ event, targets, blocked, onClose, onMoved }: { event: CalEvent; targets: CalendarInfo[]; blocked: string | null; onClose: () => void; onMoved: () => void }) {
  const t = useT();
  const { showToast } = useStore();
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);
  const go = async () => {
    const target = targets.find((c) => c.id === to);
    if (busy || !target || blocked !== null) return;
    setBusy(true);
    setError(null);
    try {
      await api.calendarMoveEvent(event.id, target.id);
      showToast(t("calendar.toast.moved", { calendar: calendarTitle(target) }), undefined, "success");
      onMoved();
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={t("calendar.move.title", { summary: event.summary })} onClose={() => !busy && onClose()} width={440}>
      <div className="ev-form" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "BUTTON") (e.preventDefault(), void go()); }}>
        {blocked === null ? (
          <>
            <label htmlFor="mv-to">{t("calendar.move.to")}</label>
            <select id="mv-to" ref={first} value={to} disabled={busy} onChange={(e) => (setTo(e.target.value), setError(null))}>
              {targets.map((c) => <option key={c.id} value={c.id}>{calendarTitle(c)}</option>)}
            </select>
          </>
        ) : (
          <div className="notice" style={{ gridColumn: "1 / -1" }} role="status">{t("calendar.move.guests", { service: blocked })}</div>
        )}
        {event.series && <div className="muted small" style={{ gridColumn: "1 / -1" }}>{t("calendar.move.seriesNote")}</div>}
      </div>
      {error && <div className="field-err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="row-inline" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        {blocked === null && <button className="btn primary" disabled={busy || !to} aria-busy={busy} onClick={() => void go()}>{t("calendar.move.confirm")}</button>}
      </div>
    </Modal>
  );
}
