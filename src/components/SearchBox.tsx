import { accountLabel } from "../accountLabel";
import { format } from "date-fns";
import { Clock, Paperclip, Pin, Search, Star, Mail, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, Contact, SearchScope } from "../api";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { useStore } from "../store";
import { DateField } from "./DateTimeFields";
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

// the operators the person types into the box: they are not translated
const OPERATORS = ["from:", "to:", "subject:", "body:", "folder:sent", "is:unread|read|flagged|pinned", "has:attachment", "after:2026-01-31", "before:", "after:7d"];
const QUOTE_EXAMPLE = '"quarterly report"';

const DATES = [
  ["", "app.search.anyTime"],
  ["today", "app.date.today"],
  ["7d", "app.search.past7"],
  ["30d", "app.search.past30"],
  ["365d", "app.search.pastYear"],
] as const;

export function SearchBox() {
  const t = useT();
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

  const mailboxLabel = accountId ? (() => { const a = accounts.find((x) => x.id === accountId); return a ? accountLabel(a).text : t("app.search.thisMailbox"); })() : t("app.search.allMailboxes");
  const scopes: [SearchScope, string][] = [
    ["current", t("app.search.currentFolder")],
    ["account", accountId ? t("app.search.thisMailbox") : t("app.search.allFolders")],
    ["all", t("app.search.allMailboxes")],
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
      <div className="sb-field">
        <label htmlFor={`sb-${key}`}>{label}</label>
        <DateField id={`sb-${key}`} allowEmpty value={/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""} onChange={(d) => change(setKey(q, key, d), true)} />
      </div>
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
    <div className="search-wrap" ref={box} data-tauri-drag-region="false">
      <div className="search-box" onClick={() => setOpen(true)}>
        <Search size={16} />
        <input
          id="search-input"
          aria-label={t("app.search.aria")}
          placeholder={t("app.search.placeholder")}
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              run(q, true);
              setOpen(false);
            } else if (e.key === "Escape") {
              // first Escape clears the query; with an empty box it leaves the field
              setOpen(false);
              if (q) change("", true);
              else e.currentTarget.blur();
            }
          }}
        />
        {q && (
          <button className="icon-btn" aria-label={t("app.search.clear")} onClick={() => (change("", true), setOpen(false))}>
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="sb-panel">
          <div className="sb-section">
            <div className="sb-title">{t("app.search.searchIn")}</div>
            <div className="seg">
              {scopes.map(([k, l]) => (
                <button key={k} className={searchScope === k ? "on" : ""} onClick={() => void setSearchScope(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="muted small">{searchScope === "all" ? t("app.search.noteAll") : searchScope === "account" ? t("app.search.noteAccount", { mailbox: mailboxLabel }) : t("app.search.noteCurrent")}</div>
          </div>

          {contacts.length > 0 && (
            <div className="sb-section">
              <div className="sb-title">{t("app.search.people")}</div>
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
            <div className="sb-title">{t("app.search.filters")}</div>
            <div className="sb-chips">
              {chip(t("app.search.unread"), "is:unread", <Mail size={13} />)}
              {chip(t("app.search.flagged"), "is:flagged", <Star size={13} />)}
              {chip(t("app.search.pinned"), "is:pinned", <Pin size={13} />)}
              {chip(t("app.search.hasAttachment"), "has:attachment", <Paperclip size={13} />)}
            </div>
          </div>

          <div className="sb-section">
            <div className="sb-title">{t("app.search.date")}</div>
            <div className="sb-chips">
              {DATES.map(([k, l]) => (
                <button key={k || "any"} className={`sb-chip ${date === k ? "on" : ""}`} onClick={() => setDate(k)}>
                  {t(l)}
                </button>
              ))}
            </div>
            <div className="sb-row">
              {dateField(t("app.search.after"), "after")}
              {dateField(t("app.search.before"), "before")}
            </div>
          </div>

          <div className="sb-section">
            <div className="sb-title">{t("app.search.fields")}</div>
            <div className="sb-row">
              {field(t("app.search.from"), "from", t("app.search.nameOrAddress"))}
              {field(t("app.search.to"), "to", t("app.search.nameOrAddress"))}
            </div>
            <div className="sb-row">{field(t("app.search.subject"), "subject", t("app.search.subjectHint"))}</div>
          </div>

          {prefs.recentSearches.length > 0 && (
            <div className="sb-section">
              <div className="sb-title">{t("app.search.recent")}</div>
              {prefs.recentSearches.map((r) => (
                <button key={r} className="menu-row" onClick={() => (change(r, true), setOpen(false))}>
                  <Clock size={14} />
                  <span className="menu-lbl ellipsis">{r}</span>
                </button>
              ))}
            </div>
          )}

          <div className="sb-foot muted small">
            {t("app.search.operators")}{" "}
            {OPERATORS.map((o, i) => (
              <Fragment key={o}>
                {i > 0 && " "}
                <code>{o}</code>
              </Fragment>
            ))}
            . {tx("app.search.quote", { example: <code>{QUOTE_EXAMPLE}</code> })}
          </div>
        </div>
      )}
    </div>
  );
}
