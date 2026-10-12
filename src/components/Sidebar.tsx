import { Archive, Clock, Inbox, Mail, MailOpen, Pin, Send, Settings, Star, Trash2, FileText, AlertOctagon, CalendarClock, PenSquare, RefreshCw } from "lucide-react";
import { FolderKey } from "../api";
import { useStore } from "../store";

const FOLDERS: { key: FolderKey; label: string; icon: React.ReactNode }[] = [
  { key: "inbox", label: "Inbox", icon: <Inbox size={16} /> },
  { key: "unread", label: "Unread", icon: <MailOpen size={16} /> },
  { key: "starred", label: "Starred", icon: <Star size={16} /> },
  { key: "pinned", label: "Pinned", icon: <Pin size={16} /> },
  { key: "snoozed", label: "Snoozed", icon: <Clock size={16} /> },
  { key: "scheduled", label: "Scheduled", icon: <CalendarClock size={16} /> },
  { key: "sent", label: "Sent", icon: <Send size={16} /> },
  { key: "drafts", label: "Drafts", icon: <FileText size={16} /> },
  { key: "archive", label: "Archive", icon: <Archive size={16} /> },
  { key: "junk", label: "Junk", icon: <AlertOctagon size={16} /> },
  { key: "trash", label: "Trash", icon: <Trash2 size={16} /> },
];

export function Sidebar() {
  const { accounts, accountId, folder, setFolder, openCompose, setSettingsOpen, sync, syncing } = useStore();
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="btn primary wide" onClick={() => openCompose({})}>
          <PenSquare size={16} /> Compose
        </button>
      </div>
      <nav>
        <div className="side-label">Mailboxes</div>
        <button className={`side-item ${accountId === null ? "active-soft" : ""}`} onClick={() => setFolder(folder, null)}>
          <Mail size={16} /> All accounts
        </button>
        {accounts.map((a) => (
          <button
            key={a.id}
            className={`side-item ${accountId === a.id ? "active-soft" : ""}`}
            onClick={() => setFolder(folder, a.id)}
            title={a.email}
          >
            <span className="dot" style={{ background: `hsl(${(a.email.length * 47) % 360} 60% 50%)` }} />
            <span className="ellipsis">{a.email}</span>
          </button>
        ))}
        <div className="side-label">Folders</div>
        {FOLDERS.map((f) => (
          <button
            key={f.key}
            className={`side-item ${folder === f.key ? "active" : ""}`}
            onClick={() => setFolder(f.key, accountId)}
          >
            {f.icon} {f.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="icon-btn" title="Sync now (F5)" onClick={() => sync()}>
          <RefreshCw size={16} className={syncing ? "spin" : ""} />
        </button>
        <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings size={16} />
        </button>
      </div>
    </aside>
  );
}
