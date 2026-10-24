// New calendar (W7.5, REQ-7.5.3): Settings > mailbox > Calendar > "New calendar…". A Modal over Settings with the name and the colour; the service makes the calendar (Outlook, a CalDAV server; Google once its extra
// permission is part of the consent), then it is listed and synced at once. Lives in the Settings chunk. Errors stay in the dialog with what was typed.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, Account } from "../api";
import { friendlyError, useStore } from "../store";
import { useT } from "../i18n/react";
import { CalColorChoice } from "./CalColorChoice";
import { useNestedEsc } from "./nestedEsc";
import { Modal } from "./ui";

export function NewCalendarDialog({ account, service, onClose, onDone }: { account: Account; service: string; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const { showToast } = useStore();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  useNestedEsc(() => !busy && onClose());
  const canGo = !busy && name.trim() !== "";
  const go = async () => {
    if (!canGo) return;
    setBusy(true);
    setError(null);
    try {
      await api.calendarCreateCalendar(account.id, name.trim(), color);
      showToast(t("settings.calendar.created", { name: name.trim() }), undefined, "success");
      onDone();
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  };
  return createPortal(
    <Modal title={t("settings.calendar.newCalendarTitle", { service })} onClose={() => !busy && onClose()} width={440}>
      <div className="ev-form dav-form" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "BUTTON") (e.preventDefault(), void go()); }}>
        <label htmlFor="newcal-name">{t("settings.calendar.calName")}</label>
        <input id="newcal-name" ref={first} value={name} maxLength={100} disabled={busy} autoComplete="off" onChange={(e) => (setName(e.target.value), setError(null))} />
        <label>{t("settings.profile.color")}</label>
        <CalColorChoice value={color} label={t("settings.calendar.colorOf", { name: name.trim() || t("settings.calendar.calName") })} service={service} onChange={setColor} />
      </div>
      {error && <div className="field-err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="row-inline" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={!canGo} aria-busy={busy} onClick={() => void go()}>{t("settings.calendar.create")}</button>
      </div>
    </Modal>,
    document.body,
  );
}
