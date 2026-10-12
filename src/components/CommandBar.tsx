import { useEffect, useMemo, useRef, useState } from "react";
import { FolderKey } from "../api";
import { useStore } from "../store";

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
    const go = (f: FolderKey) => () => void s.setFolder(f, s.accountId);
    const list: Cmd[] = [
      { label: "Compose new message", run: () => s.openCompose({}) },
      { label: "Sync now", run: () => void s.sync() },
      { label: "Open settings", run: () => s.setSettingsOpen(true) },
      { label: "Theme: light", run: () => s.setTheme("light") },
      { label: "Theme: dark", run: () => s.setTheme("dark") },
      { label: "Theme: system", run: () => s.setTheme("system") },
      ...(["inbox", "unread", "starred", "pinned", "snoozed", "scheduled", "sent", "drafts", "archive", "junk", "trash"] as FolderKey[]).map(
        (f) => ({ label: `Go to ${f}`, run: go(f) }),
      ),
    ];
    if (ids.length)
      list.push(
        { label: "Archive conversation", run: () => void s.act(ids, "archive", undefined, "Archived") },
        { label: "Trash conversation", run: () => void s.act(ids, "trash", undefined, "Moved to trash") },
        { label: "Mark unread", run: () => void s.act(ids, "unread") },
        { label: "Star / unstar", run: () => void s.act(ids, s.threads.find((t) => t.threadId === ids[0])?.flagged ? "unstar" : "star") },
        { label: "Pin / unpin", run: () => void s.act(ids, s.threads.find((t) => t.threadId === ids[0])?.pinned ? "unpin" : "pin") },
      );
    for (const a of s.accounts) list.push({ label: `Switch to ${a.email}`, run: () => void s.setFolder(s.folder, a.id) });
    list.push({ label: "Show all accounts", run: () => void s.setFolder(s.folder, null) });
    return list;
  }, [s.selected, s.accounts, s.folder, s.accountId, s.threads]);

  const shown = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  const exec = (c?: Cmd) => {
    s.setCommandOpen(false);
    c?.run();
  };

  return (
    <div className="modal-back top" onClick={() => s.setCommandOpen(false)}>
      <div className="modal cmd" onClick={(e) => e.stopPropagation()}>
        <input
          ref={ref}
          placeholder="Type a command…"
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
          <div key={c.label} className={`menu-item ${idx === i ? "hl" : ""}`} onMouseEnter={() => setI(idx)} onClick={() => exec(c)}>
            {c.label}
          </div>
        ))}
      </div>
    </div>
  );
}
