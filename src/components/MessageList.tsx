import { Archive, CalendarX, Check, CheckCheck, Clock, Flag, FolderOpen, Mail, MailOpen, Paperclip, Pin, SearchX, Trash2, X } from "lucide-react";
import { Fragment, ReactNode } from "react";
import { api, ThreadSummary } from "../api";
import { folderLabel, Prefs } from "../prefs";
import { useStore } from "../store";
import { dateGroup, fmtDate, fmtFull, snoozePresets } from "../util";
import { EmptyState, SkeletonRows } from "./overlays";
import { Avatar, Dropdown } from "./ui";

export interface ThreadRowProps {
  t: ThreadSummary;
  selected?: boolean;
  checked?: boolean;
  prefs: Prefs;
  /** show where the conversation lives (search results) */
  showFolder?: boolean;
  /** colour dot of the account (only when several accounts are shown together) */
  accountColor?: string | null;
  accountLabel?: string;
  hover?: ReactNode;
  onOpen?: () => void;
  onToggle?: () => void;
}

/** One conversation in the list. Pure: the real list and the Appearance preview both render it. */
export function ThreadRow({ t, selected, checked, prefs, showFolder, accountColor, accountLabel, hover, onOpen, onToggle }: ThreadRowProps) {
  const who = t.participants.join(", ");
  const dense = prefs.density === "compact";
  return (
    <div
      role="option"
      aria-selected={!!selected}
      tabIndex={0}
      data-thread={t.threadId}
      className={`ml-row ${selected ? "selected" : ""} ${t.unread ? "unread" : ""} ${checked ? "checked" : ""}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.();
        }
      }}
    >
      <div
        className="ml-lead"
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
        title="Select"
      >
        {!dense && (
          <div className="lead-avatar">
            <Avatar name={t.participants[0] ?? "?"} size={34} />
          </div>
        )}
        <div className={`lead-check ${checked ? "on" : ""}`}>{checked && <Check size={12} />}</div>
        {accountColor && !dense && <span className="acct-dot under" style={{ background: accountColor }} title={accountLabel} />}
      </div>
      <div className="ml-main">
        <div className="ml-top">
          {t.unread > 0 && <span className="unread-dot" aria-label="Unread" />}
          {accountColor && dense && <span className="acct-dot" style={{ background: accountColor }} title={accountLabel} />}
          <span className="who ellipsis">{who}</span>
          {hover}
          <span className="date">{fmtDate(t.lastDate)}</span>
        </div>
        <div className="ml-mid">
          <span className="subject ellipsis">{t.subject}</span>
          <span className="flags">
            {showFolder && <span className="where">{folderLabel(t.folder)}</span>}
            {t.count > 1 && prefs.conversations && <span className="count">{t.count}</span>}
            {t.hasAttach && <Paperclip size={12} aria-label="Has attachment" />}
            {t.pinned && <Pin size={12} aria-label="Pinned" />}
            {t.flagged && <Flag size={12} fill="currentColor" className="flag-on" aria-label="Flagged" />}
            {t.snoozedUntil && t.snoozedUntil > Date.now() / 1000 && <Clock size={12} aria-label="Snoozed" />}
          </span>
        </div>
        {prefs.preview && !dense && <div className="preview ellipsis">{t.snippet}</div>}
      </div>
    </div>
  );
}

function HoverActions({ t }: { t: ThreadSummary }) {
  const { act, prefs, folder } = useStore();
  const ids = [t.threadId];
  const btn = (key: string, title: string, icon: ReactNode, run: () => void) => (
    <button key={key} className="icon-btn" title={title} aria-label={title} onClick={run}>
      {icon}
    </button>
  );
  const map: Record<string, ReactNode> = {
    archive: btn("archive", "Archive", <Archive size={14} />, () => void act(ids, "archive", undefined, "Archived")),
    delete: btn("delete", folder === "trash" ? "Delete permanently" : "Delete", <Trash2 size={14} />, () =>
      void act(ids, "trash", undefined, folder === "trash" ? "Deleted permanently" : "Moved to Deleted Items")),
    flag: btn("flag", t.flagged ? "Remove flag" : "Flag", <Flag size={14} fill={t.flagged ? "currentColor" : "none"} />, () => void act(ids, t.flagged ? "unstar" : "star")),
    pin: btn("pin", t.pinned ? "Unpin" : "Pin", <Pin size={14} fill={t.pinned ? "currentColor" : "none"} />, () => void act(ids, t.pinned ? "unpin" : "pin")),
    read: btn("read", t.unread ? "Mark as read" : "Mark as unread", t.unread ? <MailOpen size={14} /> : <Mail size={14} />, () => void act(ids, t.unread ? "read" : "unread")),
    snooze: (
      <Dropdown
        key="snooze"
        className="icon-btn"
        caret={false}
        title="Snooze"
        items={snoozePresets(prefs.snoozeTimes).map((p) => ({ label: p.label, onClick: () => void act(ids, "snooze", String(p.ts), `Snoozed: ${p.label}`) }))}
      >
        <Clock size={14} />
      </Dropdown>
    ),
  };
  return (
    <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
      {prefs.hoverActions.map((k) => map[k])}
    </div>
  );
}

export function MessageList() {
  const {
    threads, outbox, folder, accountId, selected, select, checked, toggleCheck, setChecked, search, searchScope, setSearchScope, refresh,
    prefs, focus, setFocus, filter, setFilter, accounts, openCompose, loading, loadOlder, loadingOlder,
  } = useStore();
  const searching = search.trim().length > 0;
  const title = searching ? "Search results" : folderLabel(folder);
  const scopeNote = searching ? (searchScope === "all" ? "All mailboxes" : searchScope === "account" ? "Whole mailbox" : `In ${folderLabel(folder)}`) : "";
  const showTabs = folder === "inbox" && prefs.focused && !searching;
  const multi = checked.size > 0;
  const colors = new Map(accounts.map((a) => [a.id, a.color || null]));
  const labels = new Map(accounts.map((a) => [a.id, a.email]));
  const mixed = accounts.length > 1 && (!accountId || (searching && searchScope === "all"));
  const canPageBack = !searching && !["starred", "pinned", "snoozed", "all", "scheduled"].includes(folder) && threads.length > 0;

  const openThread = (t: ThreadSummary) => {
    if (folder === "drafts") {
      void (async () => {
        const msgs = await api.getThread(t.threadId, "drafts");
        const m = msgs[msgs.length - 1];
        if (!m) return;
        // restore attachments so saving or sending the draft does not silently drop them
        const attachments = await Promise.all(
          m.attachments.map((a) =>
            api.attachmentData(m.id, a.index).then((d) => ({ filename: d.name, mime: d.mime, dataBase64: d.dataBase64 })).catch(() => null),
          ),
        );
        void openCompose({
          accountId: m.accountId,
          to: m.to ? m.to.split(",").map((x) => x.trim()) : [],
          cc: m.cc ? m.cc.split(",").map((x) => x.trim()) : [],
          subject: m.subject === "(no subject)" ? "" : m.subject,
          bodyHtml: m.html ?? `<p>${(m.text ?? "").replace(/\n/g, "<br>")}</p>`,
          replaces: t.threadId,
          attachments: attachments.filter((a): a is NonNullable<typeof a> => !!a),
        });
      })();
      return;
    }
    void select(t.threadId);
  };

  const onKeyNav = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="option"]'));
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  let lastGroup = "";
  return (
    <section className="msg-list" aria-label="Message list">
      <div className={`ml-head ${multi ? "multi" : ""}`}>
        <div className="ml-title">
          {showTabs ? (
            <div className="pivots" role="tablist">
              <button role="tab" aria-selected={focus === "focused"} className={focus === "focused" ? "active" : ""} onClick={() => void setFocus("focused")}>Focused</button>
              <button role="tab" aria-selected={focus === "other"} className={focus === "other" ? "active" : ""} onClick={() => void setFocus("other")}>Other</button>
            </div>
          ) : (
            <h2 className="ellipsis">{title}</h2>
          )}
          <div className="ml-tools">
            <Dropdown
              className="link-btn"
              items={[
                { label: "All", checked: filter === "all", onClick: () => void setFilter("all") },
                { label: "Unread", checked: filter === "unread", onClick: () => void setFilter("unread") },
                { label: "Flagged", checked: filter === "flagged", onClick: () => void setFilter("flagged") },
              ]}
            >
              {filter === "all" ? "Filter" : `Filter: ${filter[0].toUpperCase()}${filter.slice(1)}`}
            </Dropdown>
          </div>
        </div>
        {searching ? (
          <div className="ml-sub">
            “{search.trim()}” · {scopeNote} · {threads.length} result{threads.length === 1 ? "" : "s"}
          </div>
        ) : (
          accountId && <div className="ml-sub">{labels.get(accountId)}</div>
        )}
        {multi && (
          <div className="ml-bulk">
            <span>{checked.size} selected</span>
            <button className="link-btn" onClick={() => setChecked(threads.map((t) => t.threadId))}>Select all</button>
            <button className="link-btn" onClick={() => setChecked([])}>Clear</button>
          </div>
        )}
      </div>

      <div className="ml-body" role="listbox" aria-label={title} aria-multiselectable onKeyDown={onKeyNav}>
        {folder === "scheduled" ? (
          outbox.length === 0 ? (
            <EmptyState icon={<CalendarX size={40} />} title="No scheduled messages" text="Messages you schedule with Send later appear here until they go out." />
          ) : (
            outbox.map((o) => (
              <div key={o.id} className="ml-row">
                <div className="ml-main">
                  <div className="ml-top">
                    <span className="who ellipsis">{o.to.join(", ")}</span>
                    <span className="date">{o.status === "failed" ? "failed" : fmtFull(o.sendAt)}</span>
                  </div>
                  <div className="subject ellipsis">{o.subject || "(no subject)"}</div>
                  {o.error && <div className="preview err">{o.error}</div>}
                </div>
                <button className="icon-btn" title="Cancel scheduled send" aria-label="Cancel scheduled send" onClick={async () => { await api.cancelOutbox(o.id); void refresh(); }}>
                  <X size={16} />
                </button>
              </div>
            ))
          )
        ) : loading && threads.length === 0 ? (
          <SkeletonRows />
        ) : threads.length === 0 ? (
          searching ? (
            <EmptyState
              icon={<SearchX size={40} />}
              title="No results"
              text={searchScope === "all" ? "Only mail already downloaded to this computer is searched. Use Load older messages in a folder to fetch more." : "Try other words, or search every folder."}
              action={searchScope !== "all" && <button className="btn" onClick={() => void setSearchScope("all")}>Search all mailboxes</button>}
            />
          ) : filter !== "all" ? (
            <EmptyState icon={<FolderOpen size={40} />} title="Nothing matches this filter" action={<button className="btn" onClick={() => void setFilter("all")}>Show everything</button>} />
          ) : folder === "inbox" || folder === "unread" ? (
            <EmptyState icon={<CheckCheck size={40} />} title="You're all caught up" text="New mail will show up here as it arrives." />
          ) : (
            <EmptyState icon={<FolderOpen size={40} />} title="This folder is empty" />
          )
        ) : (
          <>
            {threads.map((t) => {
              const group = t.pinned && folder === "inbox" ? "Pinned" : dateGroup(t.lastDate);
              const showGroup = !prefs.sortAsc && group !== lastGroup;
              lastGroup = group;
              return (
                <Fragment key={t.rowKey}>
                  {showGroup && <div className="ml-group" role="presentation">{group}</div>}
                  <ThreadRow
                    t={t}
                    prefs={prefs}
                    selected={selected === t.threadId}
                    checked={checked.has(t.threadId)}
                    showFolder={searching}
                    accountColor={mixed ? colors.get(t.accountId) ?? "var(--accent)" : null}
                    accountLabel={labels.get(t.accountId)}
                    hover={<HoverActions t={t} />}
                    onOpen={() => openThread(t)}
                    onToggle={() => toggleCheck(t.threadId)}
                  />
                </Fragment>
              );
            })}
            {canPageBack && (
              <div className="ml-more">
                <button className="btn" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {loadingOlder ? "Loading…" : "Load older messages"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
