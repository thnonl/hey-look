import { Archive, Ban, MailMinus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, SenderInfo } from "../api";
import { copyToClipboard } from "../open";
import { useT } from "../i18n/react";
import { isConfidentialId } from "../protect";
import { friendlyError, useStore } from "../store";
import { fmtDate } from "../util";
import { Modal } from "./ui";

/** "Sweep": clean up the inbox sender by sender. */
export function BulkCleaner() {
  const t = useT();
  const { accountId, setDialog, showToast, refresh, accounts, confirm } = useStore();
  const [list, setList] = useState<SenderInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const acct = accountId ?? null;

  const load = () => api.listSenders(acct).then(setList);
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // the question and the button of each action, by the action the backend knows
  const wording = {
    archive: { title: "app.sweep.archiveTitle", label: "app.sweep.archive" },
    trash: { title: "app.sweep.deleteTitle", label: "common.delete" },
    read: { title: "app.sweep.readTitle", label: "app.sweep.read" },
    block: { title: "app.sweep.blockTitle", label: "app.sweep.block" },
  } as const;
  const run = async (s: SenderInfo, action: keyof typeof wording) => {
    const label = t(wording[action].label);
    const ok = await confirm({ title: t(wording[action].title, { email: s.email }), body: t("app.sweep.body", { n: s.count }), confirmLabel: label, danger: action !== "read" });
    if (!ok) return;
    setBusy(s.email);
    try {
      // with "all accounts" selected the backend scopes by sender only
      const n = await api.senderAction(acct ?? (accounts.length === 1 ? accounts[0].id : null), s.email, action);
      showToast(t("app.sweep.done", { action: label, n, email: s.email }));
      await load();
      void refresh();
    } catch (e) {
      showToast(() => friendlyError(e), undefined, "error");
    } finally {
      setBusy(null);
    }
  };

  const shown = (list ?? []).filter((s) => !q || s.email.toLowerCase().includes(q.toLowerCase()) || s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={t("app.sweep.title")} onClose={() => setDialog(null)} wide>
      <div className="muted small">{accountId ? t("app.sweep.intro") : t("app.sweep.introAll")}</div>
      <input className="sweep-search" aria-label={t("app.sweep.filter")} placeholder={t("app.sweep.filter")} value={q} onChange={(e) => setQ(e.target.value)} />
      {list === null && <div className="muted">{t("common.loading")}</div>}
      <div className="sweep-list">
        {shown.map((s) => (
          <div key={s.email} className="sweep-row">
            <div className="sweep-who">
              <b className="ellipsis">{s.name || s.email}</b>
              <span className="muted small ellipsis">{t("app.sweep.last", { email: s.email, date: fmtDate(s.lastDate) })}</span>
            </div>
            <span className="count">{s.count}</span>
            {s.unread > 0 && <span className="fp-badge strong">{s.unread}</span>}
            <div className="sweep-actions">
              <button className="icon-btn" title={t("app.sweep.archiveAll")} disabled={busy === s.email} onClick={() => void run(s, "archive")}><Archive size={15} /></button>
              <button className="icon-btn" title={t("app.sweep.deleteAll")} disabled={busy === s.email} onClick={() => void run(s, "trash")}><Trash2 size={15} /></button>
              <button className="icon-btn" title={t("app.sweep.readAll")} disabled={busy === s.email} onClick={() => void run(s, "read")}><MailMinus size={15} /></button>
              <button className="icon-btn" title={t("app.sweep.blockAll")} disabled={busy === s.email} onClick={() => void run(s, "block")}><Ban size={15} /></button>
            </div>
          </div>
        ))}
        {list && shown.length === 0 && <div className="muted">{t("app.sweep.none")}</div>}
      </div>
    </Modal>
  );
}

export function ShowOriginal({ messageId }: { messageId: string }) {
  const t = useT();
  const { setDialog, showToast } = useStore();
  const [raw, setRaw] = useState<string | null>(null);
  const confidential = isConfidentialId(messageId);
  useEffect(() => {
    if (confidential) return;
    api.getRaw(messageId).then(setRaw).catch((e) => {
      showToast(() => friendlyError(e), undefined, "error");
      setDialog(null);
    });
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={t("app.original.title")} onClose={() => setDialog(null)} wide>
      {confidential ? <div className="muted">{t("app.original.confidential")}</div> : raw === null ? <div className="muted">{t("app.original.fetching")}</div> : (
        <>
          <button className="btn small" onClick={() => void copyToClipboard(raw).then((ok) => (ok ? showToast(t("app.original.copied")) : showToast(() => t("mail.ctx.copyFailed"), undefined, "error")))}>{t("common.copy")}</button>
          <pre className="original">{raw}</pre>
        </>
      )}
    </Modal>
  );
}
