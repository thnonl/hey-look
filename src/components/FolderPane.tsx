import {
  AlertTriangle, Archive, CalendarClock, ChevronDown, ChevronRight, Clock, FileText, Flag, Folder, Inbox, MailOpen, OctagonAlert, Pin, Send, Star, Trash2,
} from "lucide-react";
import { ReactNode } from "react";
import { FolderInfo } from "../api";
import { folderDepth, folderLabel } from "../prefs";
import { useStore } from "../store";

const ICONS: Record<string, ReactNode> = {
  inbox: <Inbox size={16} />,
  drafts: <FileText size={16} />,
  sent: <Send size={16} />,
  archive: <Archive size={16} />,
  junk: <OctagonAlert size={16} />,
  trash: <Trash2 size={16} />,
  starred: <Flag size={16} />,
  pinned: <Pin size={16} />,
  snoozed: <Clock size={16} />,
  scheduled: <CalendarClock size={16} />,
  unread: <MailOpen size={16} />,
};

const VIRTUAL_VIEWS = ["unread", "starred", "pinned", "snoozed", "scheduled"];

export function FolderPane() {
  const { accounts, folders, folder, accountId, setView, prefs, setPrefs, syncErrors, sync } = useStore();

  const isFav = (acct: string | null, key: string) => prefs.favorites.includes(`${acct ?? "*"}|${key}`);
  const toggleFav = (acct: string | null, key: string) => {
    const id = `${acct ?? "*"}|${key}`;
    setPrefs({ favorites: isFav(acct, key) ? prefs.favorites.filter((f) => f !== id) : [...prefs.favorites, id] });
  };
  const collapsed = (k: string) => !!prefs.collapsed[k];
  const toggle = (k: string) => setPrefs({ collapsed: { ...prefs.collapsed, [k]: !collapsed(k) } });

  const counts = (acct: string | null, key: string): { unread: number; total: number } =>
    folders
      .filter((f) => f.key === key && (acct === null || f.accountId === acct))
      .reduce((a, f) => ({ unread: a.unread + f.unread, total: a.total + f.total }), { unread: 0, total: 0 });

  const row = (acct: string | null, key: string, label: string, indent = 0, name?: string) => {
    const active = folder === key && accountId === acct;
    const c = counts(acct, key);
    // calm numbers: only unread conversations, and only where they help (Inbox / Junk / the Unread view); drafts show a total
    const badge = key === "inbox" || key === "unread" || key === "junk" ? c.unread : key === "drafts" ? c.total : 0;
    const go = () => void setView(key, acct);
    return (
      <div
        key={`${acct}|${key}`}
        role="treeitem"
        aria-selected={active}
        tabIndex={0}
        className={`fp-row ${active ? "active" : ""}`}
        style={{ paddingLeft: 12 + indent * 16 }}
        onClick={go}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            go();
          }
        }}
        title={name && name !== label ? name : undefined}
      >
        <span className="fp-ico">{ICONS[key] ?? <Folder size={16} />}</span>
        <span className="fp-lbl ellipsis">{label}</span>
        {badge > 0 && <span className={`fp-badge ${key === "inbox" || key === "unread" ? "strong" : ""}`}>{badge > 99 ? "99+" : badge}</span>}
        <button
          className={`fp-star ${isFav(acct, key) ? "on" : ""}`}
          title={isFav(acct, key) ? "Remove from Favorites" : "Add to Favorites"}
          aria-label={isFav(acct, key) ? "Remove from Favorites" : "Add to Favorites"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFav(acct, key);
          }}
        >
          <Star size={12} fill={isFav(acct, key) ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  const favs = prefs.favorites
    .map((f) => {
      const [a, ...k] = f.split("|");
      return { acct: a === "*" ? null : a, key: k.join("|") };
    })
    .filter((f) => f.acct === null || accounts.some((a) => a.id === f.acct));

  const acctName = (id: string | null) => accounts.find((a) => a.id === id)?.email ?? "";
  const labelFor = (acct: string | null, key: string) => {
    const info: FolderInfo | undefined = folders.find((f) => f.accountId === acct && f.key === key);
    const base = folderLabel(key, info?.name);
    return acct ? `${base} — ${acctName(acct)}` : base;
  };

  const head = (id: string, label: ReactNode) => (
    <button className="fp-head" onClick={() => toggle(id)} aria-expanded={!collapsed(id)}>
      {collapsed(id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      {label}
    </button>
  );

  return (
    <aside className="folder-pane" aria-label="Folders" role="tree">
      <div className="fp-group">
        {head("fav", "Favorites")}
        {!collapsed("fav") && favs.map((f) => row(f.acct, f.key, labelFor(f.acct, f.key)))}
      </div>

      <div className="fp-group">
        {head("views", "Quick views")}
        {!collapsed("views") && VIRTUAL_VIEWS.map((k) => row(null, k, folderLabel(k)))}
      </div>

      {accounts.map((a) => {
        const mine = folders.filter((f) => f.accountId === a.id);
        const std = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
        const custom = mine.filter((f) => f.key.startsWith("f:"));
        const error = syncErrors[a.id];
        return (
          <div className="fp-group" key={a.id}>
            {head(
              a.id,
              <>
                <span className="dot" style={{ background: a.color || "var(--accent)" }} />
                <span className="ellipsis fp-acct">{a.email}</span>
                {error && (
                  <span
                    className="fp-warn"
                    role="button"
                    tabIndex={0}
                    title={`${error}\nClick to retry`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void sync();
                    }}
                  >
                    <AlertTriangle size={13} />
                  </span>
                )}
              </>,
            )}
            {!collapsed(a.id) && (
              <>
                {std.map((k) => row(a.id, k, folderLabel(k), 1))}
                {custom.map((f) => row(a.id, f.key, folderLabel(f.key, f.name), 1 + folderDepth(f.key, f.name), f.name))}
              </>
            )}
          </div>
        );
      })}
    </aside>
  );
}
