import { AlertTriangle, CalendarClock, CalendarX, Pencil, RotateCw, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorCode, OutboxItem } from "../api";
import { picturesToEditor } from "./Compose";
import { kbd } from "../platform";
import { friendlyError, useStore } from "../store";
import { fmtWhen, zoneLabel } from "../util";
import { EmptyState } from "./overlays";
import { askUnlock } from "./Pgp";

type Group = "Needs attention" | "Today" | "Tomorrow" | "Later";

/** Group a scheduled item by when it goes out (or whether it needs the user). */
export function groupOf(o: OutboxItem, now = new Date()): Group {
  if (o.status === "failed" || o.status === "overdue") return "Needs attention";
  const d = new Date(o.sendAt * 1000);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return "Later";
}

const STATUS_PILL: Partial<Record<OutboxItem["status"], { cls: string; label: string }>> = {
  held: { cls: "accent", label: "Paused · editing" },
  sending: { cls: "", label: "Sending…" },
  failed: { cls: "bad", label: "Failed" },
  overdue: { cls: "warn", label: "Overdue" },
};

/**
 * The Scheduled folder: queued messages grouped by when they go out, with the states the worker can be in.
 * Enter opens a message for editing; Delete cancels (asks first); Ctrl+Enter sends now.
 */
export function ScheduledList() {
  const { outbox, openCompose, showToast, refresh, choose } = useStore();
  const [busyId, setBusyId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const order: Group[] = ["Needs attention", "Today", "Tomorrow", "Later"];
    const map = new Map<Group, OutboxItem[]>();
    for (const o of [...outbox].sort((a, b) => a.sendAt - b.sendAt)) {
      const g = groupOf(o);
      map.set(g, [...(map.get(g) ?? []), o]);
    }
    return order.filter((g) => map.has(g)).map((g) => [g, map.get(g) ?? []] as const);
  }, [outbox]);

  const overdue = outbox.filter((o) => o.status === "overdue");
  const failedCount = outbox.filter((o) => o.status === "failed").length;

  const open = async (o: OutboxItem, openSchedule = false) => {
    if (o.status === "sending") return;
    try {
      const e = await api.outboxOpenForEdit(o.id);
      const d = e.draft;
      void openCompose({
        accountId: d.accountId,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        bodyHtml: picturesToEditor(d.html, d.inline ?? []),
        attachments: d.attachments,
        security: d.security,
        meeting: d.meeting ? { ...d.meeting, on: true } : undefined,
        confidential: d.confidential,
        outboxId: o.id,
        sendAt: e.sendAt,
        outboxError: o.status === "failed" ? o.error ?? "The server refused it." : undefined,
        openSchedule,
      });
    } catch (err) {
      // an encrypted message is read back with your key: ask for the passphrase and try again
      const locked = String(err).match(/PGP_LOCKED:([0-9A-F]+)/);
      if (errorCode(err) === "PGP_LOCKED" && locked) {
        if (await askUnlock(locked[1], "decrypt")) return open(o, openSchedule);
        return;
      }
      showToast(friendlyError(err), undefined, "error");
      void refresh();
    }
  };

  const sendNow = async (o: OutboxItem) => {
    setBusyId(o.id);
    try {
      await api.outboxSendNow(o.id);
      showToast(`Sent “${o.subject || "(no subject)"}”`, undefined, "success");
    } catch (err) {
      showToast(`Scheduled message “${o.subject || "(no subject)"}” failed to send. ${friendlyError(err)}`, undefined, "error", [
        { label: "Retry", run: () => void api.outboxRetry(o.id).then(refresh) },
        { label: "Open", run: () => void open(o) },
      ]);
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const retry = async (o: OutboxItem) => {
    try {
      await api.outboxRetry(o.id);
      showToast("Trying again…", undefined, "info");
    } catch (err) {
      showToast(friendlyError(err), undefined, "error");
    }
    void refresh();
  };

  const cancel = async (o: OutboxItem) => {
    const choice = await choose({
      title: "Cancel this scheduled message?",
      body: `“${o.subject || "(no subject)"}” won’t be sent.`,
      choices: [
        { id: "keep", label: "Keep scheduled" },
        { id: "drafts", label: "Move to Drafts" },
        { id: "delete", label: "Delete", kind: "danger" },
      ],
    });
    try {
      if (choice === "delete") {
        await api.cancelOutbox(o.id);
        showToast("Scheduled send cancelled", undefined, "success");
      } else if (choice === "drafts") {
        await api.outboxToDraft(o.id);
        showToast("Moved to Drafts", undefined, "success");
      }
    } catch (err) {
      showToast(friendlyError(err), undefined, "error");
    }
    void refresh();
  };

  if (outbox.length === 0) {
    return <EmptyState icon={<CalendarX size={40} />} title="No scheduled messages" text="Use the arrow next to Send to send a message later. It stays here until it goes out." />;
  }

  return (
    <div className="sched-list" role="listbox" aria-label="Scheduled messages" aria-describedby="sched-sub">
      <div id="sched-sub" className="ml-sub muted small" style={{ padding: "6px 16px 0" }}>
        {outbox.length} message{outbox.length === 1 ? "" : "s"} · times in {zoneLabel()}
      </div>
      {overdue.length > 0 && (
        <div className="notice info ml-banner" role="status">
          {overdue.length} scheduled message{overdue.length === 1 ? " was" : "s were"} due while Hey Look! was closed.{" "}
          <button
            className="link"
            onClick={async () => {
              for (const o of overdue) await api.outboxSendNow(o.id).catch(() => undefined);
              void refresh();
            }}
          >
            Send now
          </button>{" "}
          <button className="link" onClick={() => void open(overdue[0])}>Review</button>
        </div>
      )}
      {groups.map(([g, items]) => (
        <div key={g}>
          <div className="ml-group">
            {g}
            {g === "Needs attention" && failedCount > 0 && <span className="sched-group-count">{failedCount} failed</span>}
          </div>
          {items.map((o) => {
            const pill = STATUS_PILL[o.status];
            const failed = o.status === "failed";
            const label = `${o.subject || "(no subject)"} to ${o.to.join(", ") || "no one"}, ${pill ? pill.label : fmtWhen(o.sendAt)}${failed && o.error ? `. ${friendlyError(o.error)}` : ""}`;
            return (
              <div
                key={o.id}
                className={`ml-row sched ${failed ? "failed" : ""}`}
                role="option"
                aria-selected={false}
                aria-label={label}
                tabIndex={0}
                aria-busy={busyId === o.id || o.status === "sending" || undefined}
                onClick={() => void open(o)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), void sendNow(o));
                  else if (e.key === "Enter" && e.shiftKey) (e.preventDefault(), void open(o, true));
                  else if (e.key === "Enter") (e.preventDefault(), void open(o));
                  else if (e.key === "Delete") (e.preventDefault(), void cancel(o));
                }}
              >
                <div className="ml-main">
                  <div className="ml-top">
                    <span className="who ellipsis">{o.to.join(", ") || "(no recipients)"}</span>
                  </div>
                  <div className="subject ellipsis">{o.subject || "(no subject)"}</div>
                  {o.snippet && <div className="preview ellipsis">{o.snippet}</div>}
                  {failed && o.error && (
                    <div className="err-line">
                      <AlertTriangle size={13} aria-hidden /> Was due {fmtWhen(o.sendAt)} · {friendlyError(o.error)}
                    </div>
                  )}
                </div>
                {pill ? (
                  <span className={`pill ${pill.cls}`}>
                    {o.status === "sending" && <span className="spin" aria-hidden />}
                    {pill.label}
                  </span>
                ) : (
                  <span className="sched-when"><CalendarClock size={13} aria-hidden /> {fmtWhen(o.sendAt)}</span>
                )}
                <div className="row-acts sched-row-acts" onClick={(e) => e.stopPropagation()}>
                  {failed ? (
                    <>
                      <button className="btn small" onClick={() => void retry(o)} aria-label={`Retry sending ${o.subject || "message"}`}><RotateCw size={12} /> Retry</button>
                      <button className="btn small" onClick={() => void open(o)} aria-label={`Edit ${o.subject || "message"}`}><Pencil size={12} /> Edit</button>
                    </>
                  ) : (
                    <>
                      <button className="icon-btn" title={kbd("Send now (Ctrl+Enter)")} aria-label={`Send ${o.subject || "message"} now`} disabled={o.status === "sending"} onClick={() => void sendNow(o)}><Send size={14} /></button>
                      <button className="icon-btn" title={kbd("Change time (Ctrl+Shift+Enter)")} aria-label={`Change time of ${o.subject || "message"}`} onClick={() => void open(o, true)}><CalendarClock size={14} /></button>
                    </>
                  )}
                  <button className="icon-btn" title="Cancel scheduled send (Delete)" aria-label={`Cancel scheduled send of ${o.subject || "message"}`} onClick={() => void cancel(o)}><X size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
