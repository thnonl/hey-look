import { format } from "date-fns";
import { Clock, Paperclip, Pin, Search, Star, Mail, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, Contact, SearchScope } from "../api";
import { useStore } from "../store";
import { useOutside } from "./ui";

// ---- tiny query helpers: the search box text is the single source of truth ("from:ann is:unread budget") ----
const tokens = (q: string): string[] => q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
const hasTok = (q: string, t: string) => tokens(q).includes(t);
const toggleTok = (q: string, t: string) => (hasTok(q, t) ? tokens(q).filter((x) => x !== t) : [...tokens(q), t]).join(" ");
const dropKey = (q: string, key: string) => tokens(q).filter((x) => !x.toLowerCase().startsWith(`${key}:`));
const setKey = (q: string, key: string, value: string) => {
  const rest = dropKey(q, key);
  const v = value.trim();
  if (!v) return rest.join(" ");
  return [...rest, `${key}:${/\s/.test(v) ? `"${v}"` : v}`].join(" ");
};
const getKey = (q: string, key: string) => {
  const t = tokens(q).find((x) => x.toLowerCase().startsWith(`${key}:`));
  return t ? t.slice(key.length + 1).replace(/^"|"$/g, "") : "";
};

const DATES: [string, string][] = [
  ["", "Any time"],
  ["today", "Today"],
  ["7d", "Past 7 days"],
  ["30d", "Past 30 days"],
  ["365d", "Past year"],
];

export function SearchBox() {
  const { search, setSearch, searchScope, setSearchScope, prefs, accountId, accounts } = useStore();
  const [q, setQ] = useState(search);
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, () => setOpen(false), open);
  useEffect(() => setQ(search), [search]);

  const run = (value: string, remember = false) => {
    clearTimeout(timer.current);
    void setSearch(value, remember);
  };
  const change = (value: string, immediate = false) => {
    setQ(value);
    clearTimeout(timer.current);
    if (immediate) run(value);
    else timer.current = setTimeout(() => run(value), 300);
    const last = value.split(/\s+/).pop() ?? "";
    if (last.length >= 2 && !last.includes(":")) void api.suggestContacts(last).then(setContacts).catch(() => setContacts([]));
    else setContacts([]);
  };

  const date = (() => {
    const a = getKey(q, "after");
    if (!a) return "";
    if (a === format(new Date(), "yyyy-MM-dd")) return "today";
    return DATES.some(([k]) => k === a) ? a : "custom";
  })();
  const setDate = (v: string) => change(setKey(q, "after", v === "today" ? format(new Date(), "yyyy-MM-dd") : v), true);

  const mailboxLabel = accountId ? accounts.find((a) => a.id === accountId)?.email ?? "This mailbox" : "All mailboxes";
  const scopes: [SearchScope, string][] = [
    ["current", "Current folder"],
    ["account", accountId ? "This mailbox" : "All folders"],
    ["all", "All mailboxes"],
  ];

  const chip = (label: string, token: string, icon: React.ReactNode) => (
    <button key={token} className={`sb-chip ${hasTok(q, token) ? "on" : ""}`} onClick={() => change(toggleTok(q, token), true)}>
      {icon}
      {label}
    </button>
  );

  const dateField = (label: string, key: string) => {
    const v = getKey(q, key);
    return (
      <label className="sb-field">
        <span>{label}</span>
        <input type="date" value={/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""} onChange={(e) => change(setKey(q, key, e.target.value), true)} />
      </label>
    );
  };

  const field = (label: string, key: string, placeholder: string) => (
    <label className="sb-field">
      <span>{label}</span>
      <input
        value={getKey(q, key)}
        placeholder={placeholder}
        onChange={(e) => setQ(setKey(q, key, e.target.value))}
        onKeyDown={(e) => e.key === "Enter" && (run(q, true), setOpen(false))}
        onBlur={() => run(q)}
      />
    </label>
  );

  return (
    <div className="search-wrap" ref={box}>
      <div className="search-box" onClick={() => setOpen(true)}>
        <Search size={16} />
        <input
          id="search-input"
          placeholder="Search mail  ( / )"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              run(q, true);
              setOpen(false);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
        {q && (
          <button className="icon-btn" aria-label="Clear search" onClick={() => (change("", true), setOpen(false))}>
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="sb-panel">
          <div className="sb-section">
            <div className="sb-title">Search in</div>
            <div className="seg">
              {scopes.map(([k, l]) => (
                <button key={k} className={searchScope === k ? "on" : ""} onClick={() => void setSearchScope(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="muted small">Searches mail downloaded to this computer. {searchScope === "all" ? "Every folder of every account (not Deleted/Junk)" : searchScope === "account" ? `${mailboxLabel}, all folders (not Deleted/Junk)` : "Only the folder you have open"}</div>
          </div>

          {contacts.length > 0 && (
            <div className="sb-section">
              <div className="sb-title">People</div>
              {contacts.map((c) => (
                <button key={c.email} className="menu-row" onClick={() => (change(setKey(q.replace(/\S+$/, "").trim(), "from", c.email), true), setContacts([]))}>
                  <Mail size={14} />
                  <span className="menu-lbl">{c.name || c.email}</span>
                  <span className="menu-hint">{c.name ? c.email : ""}</span>
                </button>
              ))}
            </div>
          )}

          <div className="sb-section">
            <div className="sb-title">Filters</div>
            <div className="sb-chips">
              {chip("Unread", "is:unread", <Mail size={13} />)}
              {chip("Flagged", "is:flagged", <Star size={13} />)}
              {chip("Pinned", "is:pinned", <Pin size={13} />)}
              {chip("Has attachment", "has:attachment", <Paperclip size={13} />)}
            </div>
          </div>

          <div className="sb-section">
            <div className="sb-title">Date</div>
            <div className="sb-chips">
              {DATES.map(([k, l]) => (
                <button key={k || "any"} className={`sb-chip ${date === k ? "on" : ""}`} onClick={() => setDate(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="sb-row">
              {dateField("After", "after")}
              {dateField("Before", "before")}
            </div>
          </div>

          <div className="sb-section">
            <div className="sb-title">Fields</div>
            <div className="sb-row">
              {field("From", "from", "name or address")}
              {field("To", "to", "name or address")}
            </div>
            <div className="sb-row">{field("Subject", "subject", "words in the subject")}</div>
          </div>

          {prefs.recentSearches.length > 0 && (
            <div className="sb-section">
              <div className="sb-title">Recent searches</div>
              {prefs.recentSearches.map((r) => (
                <button key={r} className="menu-row" onClick={() => (change(r, true), setOpen(false))}>
                  <Clock size={14} />
                  <span className="menu-lbl ellipsis">{r}</span>
                </button>
              ))}
            </div>
          )}

          <div className="sb-foot muted small">
            Operators: <code>from:</code> <code>to:</code> <code>subject:</code> <code>body:</code> <code>folder:sent</code> <code>is:unread|read|flagged|pinned</code>{" "}
            <code>has:attachment</code> <code>after:2026-01-31</code> <code>before:</code> <code>after:7d</code>. Quote phrases: <code>"quarterly report"</code>.
          </div>
        </div>
      )}
    </div>
  );
}
