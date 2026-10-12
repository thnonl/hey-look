import { Archive, Ban, MailMinus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, SenderInfo } from "../api";
import { useStore } from "../store";
import { fmtDate } from "../util";
import { Modal } from "./ui";

/** "Sweep": clean up the inbox sender by sender. */
export function BulkCleaner() {
  const { accountId, setDialog, showToast, refresh, accounts, confirm } = useStore();
  const [list, setList] = useState<SenderInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const acct = accountId ?? null;

  const load = () => api.listSenders(acct).then(setList);
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (s: SenderInfo, action: string, label: string) => {
    const ok = await confirm({ title: `${label} all mail from ${s.email}?`, body: `${s.count} conversation${s.count === 1 ? "" : "s"} in the inbox will be affected.`, confirmLabel: label, danger: action !== "read" });
    if (!ok) return;
    setBusy(s.email);
    try {
      // with "all accounts" selected the backend scopes by sender only
      const n = await api.senderAction(acct ?? (accounts.length === 1 ? accounts[0].id : null), s.email, action);
      showToast(`${label}: ${n} conversation(s) from ${s.email}`);
      await load();
      void refresh();
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(null);
    }
  };

  const shown = (list ?? []).filter((s) => !q || s.email.toLowerCase().includes(q.toLowerCase()) || s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Sweep: clean up by sender" onClose={() => setDialog(null)} wide>
      <div className="muted small">Inbox senders ordered by message count.{accountId ? "" : " Showing all accounts."}</div>
      <input className="sweep-search" placeholder="Filter senders" value={q} onChange={(e) => setQ(e.target.value)} />
      {list === null && <div className="muted">Loading…</div>}
      <div className="sweep-list">
        {shown.map((s) => (
          <div key={s.email} className="sweep-row">
            <div className="sweep-who">
              <b className="ellipsis">{s.name || s.email}</b>
              <span className="muted small ellipsis">{s.email} · last {fmtDate(s.lastDate)}</span>
            </div>
            <span className="count">{s.count}</span>
            {s.unread > 0 && <span className="fp-badge strong">{s.unread}</span>}
            <div className="sweep-actions">
              <button className="icon-btn" title="Archive all" disabled={busy === s.email} onClick={() => void run(s, "archive", "Archive")}><Archive size={15} /></button>
              <button className="icon-btn" title="Delete all" disabled={busy === s.email} onClick={() => void run(s, "trash", "Delete")}><Trash2 size={15} /></button>
              <button className="icon-btn" title="Mark all as read" disabled={busy === s.email} onClick={() => void run(s, "read", "Mark as read")}><MailMinus size={15} /></button>
              <button className="icon-btn" title="Block sender and move to Junk" disabled={busy === s.email} onClick={() => void run(s, "block", "Block")}><Ban size={15} /></button>
            </div>
          </div>
        ))}
        {list && shown.length === 0 && <div className="muted">No senders.</div>}
      </div>
    </Modal>
  );
}

export function ShowOriginal({ messageId }: { messageId: string }) {
  const { setDialog, showToast } = useStore();
  const [raw, setRaw] = useState<string | null>(null);
  useEffect(() => {
    api.getRaw(messageId).then(setRaw).catch((e) => {
      showToast(String(e));
      setDialog(null);
    });
  }, [messageId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Original message" onClose={() => setDialog(null)} wide>
      {raw === null ? <div className="muted">Fetching from server…</div> : (
        <>
          <button className="btn small" onClick={() => void navigator.clipboard.writeText(raw).then(() => showToast("Copied"))}>Copy</button>
          <pre className="original">{raw}</pre>
        </>
      )}
    </Modal>
  );
}
