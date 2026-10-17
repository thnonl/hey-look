import { AlertTriangle, CalendarClock, CalendarX, Pencil, RotateCw, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorCode, OutboxItem } from "../api";
import { picturesToEditor } from "./Compose";
import { kbd } from "../platform";
import { friendlyError, useStore } from "../store";
import type { Key } from "../i18n";
import { useT } from "../i18n/react";
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

const STATUS_PILL: Partial<Record<OutboxItem["status"], { cls: string; label: Key }>> = {
  held: { cls: "accent", label: "compose.scheduled.paused" },
  sending: { cls: "", label: "compose.scheduled.sending" },
  failed: { cls: "bad", label: "compose.scheduled.failed" },
  overdue: { cls: "warn", label: "compose.scheduled.overdue" },
};

/** The group ids stay English (they are only compared); this is what the list shows. */
const GROUP_LABEL = {
  "Needs attention": "compose.scheduled.needsAttention",
  Today: "compose.scheduled.today",
  Tomorrow: "compose.scheduled.tomorrow",
  Later: "compose.scheduled.later",
} as const;

/**
 * The Scheduled folder: queued messages grouped by when they go out, with the states the worker can be in.
 * Enter opens a message for editing; Delete cancels (asks first); Ctrl+Enter sends now.
 */
export function ScheduledList() {
  const t = useT();
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
        importance: d.importance,
        outboxId: o.id,
        sendAt: e.sendAt,
        outboxError: o.status === "failed" ? o.error ?? t("compose.scheduled.serverRefused") : undefined,
        openSchedule,
      });
    } catch (err) {
      // an encrypted message is read back with your key: ask for the passphrase and try again
      const locked = String(err).match(/PGP_LOCKED:([0-9A-F]+)/);
      if (errorCode(err) === "PGP_LOCKED" && locked) {
        if (await askUnlock(locked[1], "decrypt")) return open(o, openSchedule);
        return;
      }
      showToast(() => friendlyError(err), undefined, "error");
      void refresh();
    }
  };

  const sendNow = async (o: OutboxItem) => {
    setBusyId(o.id);
    try {
      await api.outboxSendNow(o.id);
      showToast(t("compose.scheduled.sentToast", { subject: o.subject || t("compose.noSubject") }), undefined, "success");
    } catch (err) {
      showToast(() => t("compose.scheduled.failedToast", { subject: o.subject || t("compose.noSubject"), error: friendlyError(err) }), undefined, "error", [
        { label: () => t("common.retry"), run: () => void api.outboxRetry(o.id).then(refresh) },
        { label: () => t("compose.scheduled.open"), run: () => void open(o) },
      ]);
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const retry = async (o: OutboxItem) => {
    try {
      await api.outboxRetry(o.id);
      showToast(t("compose.scheduled.tryingAgain"), undefined, "info");
    } catch (err) {
      showToast(() => friendlyError(err), undefined, "error");
    }
    void refresh();
  };

  const cancel = async (o: OutboxItem) => {
    const choice = await choose({
      title: t("compose.dlg.cancelScheduledTitle"),
      body: t("compose.dlg.cancelScheduledBody", { subject: o.subject || t("compose.noSubject") }),
      choices: [
        { id: "keep", label: t("compose.dlg.keepScheduled") },
        { id: "drafts", label: t("compose.dlg.moveToDrafts") },
        { id: "delete", label: t("common.delete"), kind: "danger" },
      ],
    });
    try {
      if (choice === "delete") {
        await api.cancelOutbox(o.id);
        showToast(t("compose.toast.scheduleCancelled"), undefined, "success");
      } else if (choice === "drafts") {
        await api.outboxToDraft(o.id);
        showToast(t("compose.toast.movedToDrafts"), undefined, "success");
      }
    } catch (err) {
      showToast(() => friendlyError(err), undefined, "error");
    }
    void refresh();
  };

  if (outbox.length === 0) {
    return <EmptyState icon={<CalendarX size={40} />} title={t("compose.scheduled.emptyTitle")} text={t("compose.scheduled.emptyText")} />;
  }

  return (
    <div className="sched-list" role="listbox" aria-label={t("compose.scheduled.listLabel")} aria-describedby="sched-sub">
      <div id="sched-sub" className="ml-sub muted small" style={{ padding: "6px 16px 0" }}>
        {t("compose.scheduled.summary", { n: outbox.length, zone: zoneLabel() })}
      </div>
      {overdue.length > 0 && (
        <div className="notice info ml-banner" role="status">
          {t("compose.scheduled.overdueBanner", { n: overdue.length })}{" "}
          <button
            className="link"
            onClick={async () => {
              for (const o of overdue) await api.outboxSendNow(o.id).catch(() => undefined);
              void refresh();
            }}
          >
            {t("compose.scheduled.sendNow")}
          </button>{" "}
          <button className="link" onClick={() => void open(overdue[0])}>{t("compose.scheduled.review")}</button>
        </div>
      )}
      {groups.map(([g, items]) => (
        <div key={g}>
          <div className="ml-group">
            {t(GROUP_LABEL[g])}
            {g === "Needs attention" && failedCount > 0 && <span className="sched-group-count">{t("compose.scheduled.failedCount", { n: failedCount })}</span>}
          </div>
          {items.map((o) => {
            const pill = STATUS_PILL[o.status];
            const failed = o.status === "failed";
            const rowParams = { subject: o.subject || t("compose.noSubject"), to: o.to.join(", ") || t("compose.scheduled.noOne"), status: pill ? t(pill.label) : fmtWhen(o.sendAt) };
            const label = failed && o.error ? t("compose.scheduled.rowLabelError", { ...rowParams, error: friendlyError(o.error) }) : t("compose.scheduled.rowLabel", rowParams);
            const name = o.subject || t("compose.message");
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
                    <span className="who ellipsis">{o.to.join(", ") || t("compose.noRecipients")}</span>
                  </div>
                  <div className="subject ellipsis">{o.subject || t("compose.noSubject")}</div>
                  {o.snippet && <div className="preview ellipsis">{o.snippet}</div>}
                  {failed && o.error && (
                    <div className="err-line">
                      <AlertTriangle size={13} aria-hidden /> {t("compose.scheduled.wasDue", { when: fmtWhen(o.sendAt), error: friendlyError(o.error) })}
                    </div>
                  )}
                </div>
                {pill ? (
                  <span className={`pill ${pill.cls}`}>
                    {o.status === "sending" && <span className="spin" aria-hidden />}
                    {t(pill.label)}
                  </span>
                ) : (
                  <span className="sched-when"><CalendarClock size={13} aria-hidden /> {fmtWhen(o.sendAt)}</span>
                )}
                <div className="row-acts sched-row-acts" onClick={(e) => e.stopPropagation()}>
                  {failed ? (
                    <>
                      <button className="btn small" onClick={() => void retry(o)} aria-label={t("compose.scheduled.retryAria", { name })}><RotateCw size={12} /> {t("common.retry")}</button>
                      <button className="btn small" onClick={() => void open(o)} aria-label={t("compose.scheduled.editAria", { name })}><Pencil size={12} /> {t("common.edit")}</button>
                    </>
                  ) : (
                    <>
                      <button className="icon-btn" title={kbd(t("compose.scheduled.sendNowTip"))} aria-label={t("compose.scheduled.sendNowAria", { name })} disabled={o.status === "sending"} onClick={() => void sendNow(o)}><Send size={14} /></button>
                      <button className="icon-btn" title={kbd(t("compose.scheduled.changeTimeTip"))} aria-label={t("compose.scheduled.changeTimeAria", { name })} onClick={() => void open(o, true)}><CalendarClock size={14} /></button>
                    </>
                  )}
                  <button className="icon-btn" title={t("compose.scheduled.cancelTip")} aria-label={t("compose.scheduled.cancelAria", { name })} onClick={() => void cancel(o)}><X size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
