// Connect a mailbox's calendar to a CalDAV server (W7.4, REQ-7.4.2): iCloud, Fastmail, Nextcloud or any other server. A Modal with the service, the server address, the user name, the
// password (or the mailbox's own), the help line of the service and, for a server of the person's own, the certificate choice. Discovery runs in the backend; the dialog stays open with
// what was typed when it fails. "password" mode (REQ-7.4.5, after the server refused the password): only the password can be typed.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, Account, CalSource } from "../api";
import { davPreset, type DavPreset } from "../calendarSync";
import { friendlyError } from "../store";
import { useT } from "../i18n/react";
import { useNestedEsc } from "./nestedEsc";
import { Modal } from "./ui";

const FIXED: Partial<Record<DavPreset, string>> = { icloud: "https://caldav.icloud.com/", fastmail: "https://caldav.fastmail.com/" };

export function CalDavDialog({ account, mode, source, onClose, onDone }: { account: Account; mode: "connect" | "password"; source?: CalSource | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const again = mode === "password";
  const [preset, setPreset] = useState<DavPreset>(() => (again && source?.dav ? (source.dav.preset as DavPreset) : davPreset(account.imapHost)));
  const [url, setUrl] = useState("");
  const [user, setUser] = useState(again && source?.dav ? source.dav.username : account.email);
  const passwordMailbox = account.auth === "password";
  // the mailbox's password is what iCloud and Fastmail accept only when it is an app password: on by default for their presets when the mailbox uses a password
  const [useMail, setUseMail] = useState(() => !again && passwordMailbox && davPreset(account.imapHost) !== "other");
  const [pw, setPw] = useState("");
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement | HTMLInputElement | null>(null);
  const fixed = FIXED[preset];
  const ownServer = preset === "nextcloud" || preset === "other";
  const showPw = !(useMail && passwordMailbox && !again);
  useEffect(() => {
    first.current?.focus();
  }, []);
  // Esc closes this dialog only (Settings, which it is opened from, keeps its own)
  useNestedEsc(() => !busy && onClose());
  // the mailbox-password choice follows the service the person picks (on for iCloud and Fastmail, off for a server of their own)
  const choose = (p: DavPreset) => {
    setPreset(p);
    if (passwordMailbox) setUseMail(p === "icloud" || p === "fastmail");
    setError(null);
  };
  const canGo = !busy && user.trim() !== "" && (fixed !== undefined || again || url.trim() !== "") && (!showPw || pw !== "");
  const go = async () => {
    if (!canGo) return;
    setBusy(true);
    setError(null);
    try {
      if (again) await api.calendarDavPassword(account.id, pw);
      else await api.calendarConnectCaldav({ accountId: account.id, service: preset, url: fixed ?? url.trim(), username: user.trim(), password: showPw ? pw : "", useMailPassword: !showPw, trustCert: ownServer && trust });
      onDone();
    } catch (e) {
      // (the typed values stay, the password too)
      setError(friendlyError(e));
      setBusy(false);
    }
  };
  const submit = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      void go();
    }
  };
  const help = t(preset === "icloud" ? "settings.calendar.davHelpIcloud" : preset === "fastmail" ? "settings.calendar.davHelpFastmail" : preset === "nextcloud" ? "settings.calendar.davHelpNextcloud" : "settings.calendar.davHelpOther");
  return createPortal(
    <Modal title={t("settings.calendar.davTitle")} onClose={() => !busy && onClose()} width={480}>
      <div className="ev-form dav-form" onKeyDown={submit}>
        <label htmlFor="dav-service">{t("settings.calendar.davService")}</label>
        <select id="dav-service" ref={(e) => { if (!first.current) first.current = e; }} value={preset} disabled={busy || again} onChange={(e) => choose(e.target.value as DavPreset)}>
          {/* i18n-ok: product name */}
          <option value="icloud">iCloud</option>
          {/* i18n-ok: product name */}
          <option value="fastmail">Fastmail</option>
          {/* i18n-ok: product name */}
          <option value="nextcloud">Nextcloud</option>
          <option value="other">{t("settings.calendar.davOther")}</option>
        </select>

        {fixed === undefined ? (
          <>
            <label htmlFor="dav-url">{t("settings.calendar.davAddress")}</label>
            <input autoComplete="off" id="dav-url" value={url} disabled={busy || again} placeholder="https://cloud.example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => (setUrl(e.target.value), setError(null))} />
          </>
        ) : (
          <>
            <label>{t("settings.calendar.davAddress")}</label>
            <div className="muted small dav-fixed">{fixed}</div>
          </>
        )}

        <label htmlFor="dav-user">{t("settings.calendar.davUsername")}</label>
        <input autoComplete="off" id="dav-user" value={user} disabled={busy || again} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => (setUser(e.target.value), setError(null))} />

        {showPw && (
          <>
            <label htmlFor="dav-pw">{t("settings.add.password")}</label>
            <input id="dav-pw" type="password" value={pw} disabled={busy} autoComplete="off" ref={(e) => { if (again && e) first.current = e; }} onChange={(e) => (setPw(e.target.value), setError(null))} />
          </>
        )}

        {passwordMailbox && !again && (
          <div className="dav-check" style={{ gridColumn: "1 / -1" }}>
            <label>
              <input type="checkbox" checked={useMail} disabled={busy} onChange={(e) => (setUseMail(e.target.checked), setError(null))} />
              <span>{t("settings.calendar.davUseMailPassword")}</span>
            </label>
          </div>
        )}
        <div className="muted small" style={{ gridColumn: "1 / -1" }}>{help}</div>
        {ownServer && !again && (
          <div className="dav-check" style={{ gridColumn: "1 / -1" }}>
            <label>
              <input type="checkbox" checked={trust} disabled={busy} onChange={(e) => setTrust(e.target.checked)} />
              <span>{t("settings.add.trustCert")}</span>
            </label>
            {trust && <div className="notice" style={{ marginTop: 6 }}>{t("settings.add.trustCertWarning")}</div>}
          </div>
        )}
      </div>
      {error && <div className="field-err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="row-inline" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn primary" disabled={!canGo} aria-busy={busy} onClick={() => void go()}>{busy ? t("settings.calendar.davConnecting") : t("settings.calendar.davConnect")}</button>
      </div>
    </Modal>,
    document.body,
  );
}

