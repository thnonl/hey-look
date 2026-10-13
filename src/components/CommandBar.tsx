import { useEffect, useMemo, useRef, useState } from "react";
import { newMailAccount } from "../actions";
import { folderLabel } from "../prefs";
import { newEvent } from "./Calendar";
import { useStore } from "../store";
import { useUpdates } from "../updates";

interface Cmd {
  label: string;
  run: () => void;
}

export function CommandBar() {
  const s = useStore();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const cmds = useMemo<Cmd[]>(() => {
    const ids = s.selected ? [s.selected] : [];
    const cur = s.threads.find((t) => t.threadId === s.selected);
    const list: Cmd[] = [
      { label: "New mail", run: () => s.openCompose({ accountId: newMailAccount() }) },
      { label: "Sync now", run: () => void s.sync() },
      { label: "New event", run: () => newEvent() },
      { label: "Go to Calendar", run: () => s.setModule("calendar") },
      { label: "Go to Mail", run: () => s.setModule("mail") },
      { label: "Calendar: Month view", run: () => (s.setModule("calendar"), s.setCalView("month")) },
      { label: "Calendar: Week view", run: () => (s.setModule("calendar"), s.setCalView("week")) },
      { label: "Calendar: Agenda view", run: () => (s.setModule("calendar"), s.setCalView("agenda")) },
      { label: "Open settings", run: () => s.setDialog({ type: "settings" }) },
      { label: "Check for updates", run: () => useUpdates.getState().openSettingsAbout(true) },
      { label: "Sweep: clean up by sender", run: () => s.setDialog({ type: "cleaner" }) },
      { label: "Theme: light", run: () => s.setPrefs({ theme: "light" }) },
      { label: "Theme: dark", run: () => s.setPrefs({ theme: "dark" }) },
      { label: "Theme: system", run: () => s.setPrefs({ theme: "system" }) },
      { label: "Toggle reading pane position", run: () => s.setPrefs({ readingPane: s.prefs.readingPane === "right" ? "bottom" : "right" }) },
      { label: "Toggle conversations", run: () => s.setPrefs({ conversations: !s.prefs.conversations }) },
      { label: "Toggle Focused Inbox", run: () => s.setPrefs({ focused: !s.prefs.focused }) },
      ...["inbox", "unread", "starred", "pinned", "snoozed", "scheduled", "sent", "drafts", "archive", "junk", "trash"].map((f) => ({
        label: `Go to ${folderLabel(f)}`,
        run: () => void s.setView(f, s.accountId),
      })),
    ];
    if (ids.length)
      list.push(
        { label: "Archive conversation", run: () => void s.act(ids, "archive", undefined, "Archived") },
        { label: "Delete conversation", run: () => void s.act(ids, "trash", undefined, "Moved to Deleted Items") },
        { label: "Mark as unread", run: () => void s.act(ids, "unread") },
        { label: cur?.flagged ? "Remove flag" : "Flag", run: () => void s.act(ids, cur?.flagged ? "unstar" : "star") },
        { label: cur?.pinned ? "Unpin" : "Pin", run: () => void s.act(ids, cur?.pinned ? "unpin" : "pin") },
      );
    for (const a of s.accounts) list.push({ label: `Switch to ${a.email}`, run: () => void s.setView(s.folder, a.id) });
    list.push({ label: "Show all accounts", run: () => void s.setView(s.folder, null) });
    return list;
  }, [s.selected, s.accounts, s.folder, s.accountId, s.threads, s.prefs]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  const exec = (c?: Cmd) => {
    s.setCommandOpen(false);
    c?.run();
  };

  return (
    <div className="modal-back top" onMouseDown={() => s.setCommandOpen(false)}>
      <div className="modal cmd" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={ref}
          aria-label="Command" placeholder="Type a command…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((x) => Math.min(x + 1, shown.length - 1));
            else if (e.key === "ArrowUp") setI((x) => Math.max(x - 1, 0));
            else if (e.key === "Enter") exec(shown[i]);
            else if (e.key === "Escape") s.setCommandOpen(false);
          }}
        />
        {shown.map((c, idx) => (
          <div key={c.label} className={`menu-row ${idx === i ? "hl" : ""}`} onMouseEnter={() => setI(idx)} onClick={() => exec(c)}>
            {c.label}
          </div>
        ))}
      </div>
    </div>
  );
}
