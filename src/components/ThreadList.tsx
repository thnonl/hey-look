import { Archive, Clock, Paperclip, Pin, Search, Star, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { fmtDate, fmtFull, hue, initials } from "../util";
import { SnoozeMenu } from "./SnoozeMenu";

export function ThreadList() {
  const { threads, outbox, folder, selected, select, checked, toggleCheck, act, search, setSearch, refresh } = useStore();
  const [q, setQ] = useState(search);
  const [snoozeFor, setSnoozeFor] = useState<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setQ(search), [search]);

  const onSearch = (v: string) => {
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSearch(v), 250);
  };

  const bulk = checked.size > 0 ? Array.from(checked) : null;

  return (
    <section className="list">
      <div className="list-head">
        <div className="search">
          <Search size={14} />
          <input id="search-input" placeholder="Search mail  ( / )" value={q} onChange={(e) => onSearch(e.target.value)} />
          {q && (
            <button className="icon-btn" onClick={() => onSearch("")}>
              <X size={14} />
            </button>
          )}
        </div>
        {bulk && (
          <div className="bulk">
            <span>{bulk.length} selected</span>
            <button className="icon-btn" title="Archive" onClick={() => act(bulk, "archive", undefined, "Archived")}>
              <Archive size={16} />
            </button>
            <button className="icon-btn" title="Trash" onClick={() => act(bulk, "trash", undefined, "Moved to trash")}>
              <Trash2 size={16} />
            </button>
            <button className="icon-btn" title="Snooze" onClick={() => setSnoozeFor(bulk)}>
              <Clock size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="list-body">
        {folder === "scheduled" ? (
          outbox.length === 0 ? (
            <div className="empty">No scheduled messages</div>
          ) : (
            outbox.map((o) => (
              <div key={o.id} className="row">
                <div className="row-main">
                  <div className="row-top">
                    <span className="who ellipsis">{o.to.join(", ")}</span>
                    <span className="date">{o.status === "failed" ? "failed" : fmtFull(o.sendAt)}</span>
                  </div>
                  <div className="subject ellipsis">{o.subject || "(no subject)"}</div>
                  {o.error && <div className="snippet err">{o.error}</div>}
                </div>
                <button
                  className="icon-btn"
                  title="Cancel"
                  onClick={async () => {
                    await api.cancelOutbox(o.id);
                    refresh();
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ))
          )
        ) : threads.length === 0 ? (
          <div className="empty">{search ? "No results" : "Nothing here"}</div>
        ) : (
          threads.map((t) => {
            const who = t.participants.join(", ");
            return (
              <div
                key={t.threadId}
                className={`row ${selected === t.threadId ? "selected" : ""} ${t.unread ? "unread" : ""}`}
                onClick={() => select(t.threadId)}
              >
                <div
                  className="avatar"
                  style={{ background: `hsl(${hue(who)} 55% 45%)` }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCheck(t.threadId);
                  }}
                >
                  {checked.has(t.threadId) ? "✓" : initials(t.participants[0] ?? "?")}
                </div>
                <div className="row-main">
                  <div className="row-top">
                    <span className="who ellipsis">{who}</span>
                    {t.count > 1 && <span className="count">{t.count}</span>}
                    <span className="date">{fmtDate(t.lastDate)}</span>
                  </div>
                  <div className="subject ellipsis">{t.subject}</div>
                  <div className="snippet ellipsis">{t.snippet}</div>
                </div>
                <div className="row-flags">
                  {t.pinned && <Pin size={13} />}
                  {t.flagged && <Star size={13} fill="currentColor" />}
                  {t.hasAttach && <Paperclip size={13} />}
                  {t.snoozedUntil && t.snoozedUntil > Date.now() / 1000 && <Clock size={13} />}
                </div>
              </div>
            );
          })
        )}
      </div>
      {snoozeFor && <SnoozeMenu ids={snoozeFor} onClose={() => setSnoozeFor(null)} />}
    </section>
  );
}
