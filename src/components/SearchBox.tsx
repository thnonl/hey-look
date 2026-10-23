import { accountLabel } from "../accountLabel";
import { ChevronDown, Clock, Search, Mail, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, Contact, SearchScope } from "../api";
import { useT } from "../i18n/react";
import { LazySearchAdvanced } from "../lazyViews";
import { setKey } from "../searchQuery";
import { useStore } from "../store";
import { useOutside } from "./ui";

// The search box and its panel (W13.4). The panel opens SIMPLE: "Search in", the people while typing, the recent searches and the button "Advanced search"; the filters, dates, fields and
// operators sit behind that button (SearchAdvanced.tsx, a chunk of its own). The box and the panel are one control for the keyboard: Down enters the panel, Esc leaves it (REQ-13.4.4).

/** "Advanced search" stays open while the program runs (REQ-13.4.2); after a restart it starts closed. */
let advancedMemory = false;

export function SearchBox() {
  const t = useT();
  const { search, setSearch, searchScope, setSearchScope, prefs, accountId, accounts, removeRecentSearch, clearRecentSearches } = useStore();
  const [q, setQ] = useState(search);
  const [open, setOpen] = useState(false);
  const [advanced, setAdvancedState] = useState(advancedMemory);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const radios = useRef<Partial<Record<SearchScope, HTMLButtonElement | null>>>({});
  /** the focus goes back to the box on purpose (not a click or a Tab into it): the panel must not reopen */
  const quiet = useRef(false);
  /** after a recent search was removed: the index of the row that takes its place, to focus it */
  const [after, setAfter] = useState<number | null>(null);
  /** the keyboard asked to go into the panel while it was still closed */
  const enter = useRef(false);
  useOutside(box, () => setOpen(false), open);
  useEffect(() => setQ(search), [search]);

  const setAdvanced = (on: boolean) => {
    advancedMemory = on;
    setAdvancedState(on);
  };

  const navItems = () => [...(panel.current?.querySelectorAll<HTMLElement>("[data-sb-nav]") ?? [])];
  const focusBox = () => {
    quiet.current = true;
    input.current?.focus();
    quiet.current = false;
  };
  useEffect(() => {
    if (open && enter.current) {
      enter.current = false;
      navItems()[0]?.focus();
    }
  }, [open]);

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

  const mailboxLabel = accountId ? (() => { const a = accounts.find((x) => x.id === accountId); return a ? accountLabel(a).text : t("app.search.thisMailbox"); })() : t("app.search.allMailboxes");
  // "All folders" would be the same as "All mailboxes" when no single mailbox is selected, so it is not offered then (REQ-13.4.1)
  const scopes: [SearchScope, string][] = [["current", t("app.search.currentFolder")]];
  if (accountId) scopes.push(["account", t("app.search.allFolders")]);
  scopes.push(["all", t("app.search.allMailboxes")]);
  const scope: SearchScope = scopes.some(([k]) => k === searchScope) ? searchScope : "all";

  const pickScope = (k: SearchScope, focus = false) => {
    void setSearchScope(k);
    if (focus) radios.current[k]?.focus();
  };
  const onScopeKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = scopes.findIndex(([k]) => k === scope);
    pickScope(scopes[(at + step + scopes.length) % scopes.length][0], true);
  };

  const recent = prefs.recentSearches;
  const drop = (i: number) => {
    setAfter(i);
    removeRecentSearch(recent[i]);
  };
  // the focus goes to the row that took the place of the removed one, else to the one before it, else to the box
  useEffect(() => {
    if (after === null) return;
    const rows = navItems().filter((x) => x.dataset.sbNav === "recent");
    if (rows.length) rows[Math.min(after, rows.length - 1)].focus();
    else focusBox();
    setAfter(null);
  }, [recent]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (r: string) => {
    setQ(r);
    setContacts([]);
    run(r, true);
    setOpen(false);
    focusBox();
  };

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Esc anywhere in the panel closes it and gives the focus back to the box, the text stays (REQ-13.4.4)
      e.preventDefault();
      setOpen(false);
      focusBox();
      return;
    }
    const nav = navItems();
    const i = nav.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nav[Math.min(i + 1, nav.length - 1)].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (i === 0) focusBox();
      else nav[i - 1].focus();
    } else if (e.key === "Delete" && nav[i].dataset.sbNav === "recent") {
      e.preventDefault();
      drop(Number(nav[i].dataset.index));
    }
  };

  return (
    <div className="search-wrap" ref={box} data-tauri-drag-region="false">
      <div className="search-box" onClick={() => setOpen(true)}>
        <Search size={16} />
        <input
          id="search-input"
          ref={input}
          aria-label={t("app.search.aria")}
          placeholder={t("app.search.placeholder")}
          value={q}
          onFocus={() => !quiet.current && setOpen(true)}
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
            } else if (e.key === "ArrowDown") {
              // Down goes into the panel: its first control is the "Search in" group
              e.preventDefault();
              if (open) navItems()[0]?.focus();
              else {
                enter.current = true;
                setOpen(true);
              }
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
        <div className="sb-panel" ref={panel} onKeyDown={onPanelKey}>
          <div className="sb-section">
            <div className="sb-title" id="sb-scope-title">{t("app.search.searchIn")}</div>
            <div className="seg" role="radiogroup" aria-labelledby="sb-scope-title" onKeyDown={onScopeKey}>
              {scopes.map(([k, l]) => (
                <button
                  key={k}
                  ref={(el) => void (radios.current[k] = el)}
                  role="radio"
                  aria-checked={scope === k}
                  tabIndex={scope === k ? 0 : -1}
                  data-sb-nav={scope === k ? "scope" : undefined}
                  className={scope === k ? "on" : ""}
                  onClick={() => pickScope(k)}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className="muted small">{scope === "all" ? t("app.search.noteAll") : scope === "account" ? t("app.search.noteAccount", { mailbox: mailboxLabel }) : t("app.search.noteCurrent")}</div>
          </div>

          {contacts.length > 0 && (
            <div className="sb-section">
              <div className="sb-title">{t("app.search.people")}</div>
              {contacts.map((c) => (
                <button key={c.email} data-sb-nav="people" className="menu-row" onClick={() => (change(setKey(q.replace(/\S+$/, "").trim(), "from", c.email), true), setContacts([]))}>
                  <Mail size={14} />
                  <span className="menu-lbl">{c.name || c.email}</span>
                  <span className="menu-hint">{c.name ? c.email : ""}</span>
                </button>
              ))}
            </div>
          )}

          {recent.length > 0 && (
            <div className="sb-section sb-recent">
              <div className="sb-title">{t("app.search.recent")}</div>
              {recent.map((r, i) => (
                <div key={r} className="sb-recent-row">
                  <button className="menu-row" data-sb-nav="recent" data-index={i} onClick={() => pick(r)}>
                    <Clock size={14} />
                    <span className="menu-lbl ellipsis">{r}</span>
                  </button>
                  <button
                    className="icon-btn sb-recent-x"
                    aria-label={t("app.search.removeRecent", { q: r })}
                    title={t("app.search.removeRecent", { q: r })}
                    onClick={() => drop(i)}
                    onKeyDown={(e) => e.key === "Delete" && (e.preventDefault(), drop(i))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              {/* after the rows in the Tab order (row, its X, next row, ..., Clear all, Advanced search); the grid puts it on the line of the title */}
              <button className="sb-clear" data-sb-nav="clear" onClick={() => (clearRecentSearches(), focusBox())}>
                {t("app.search.clearRecent")}
              </button>
            </div>
          )}

          <div className={`sb-section sb-advtoggle ${advanced ? "open" : ""}`}>
            <button className="sb-advanced" data-sb-nav="advanced" aria-expanded={advanced} aria-controls="sb-adv" onClick={() => setAdvanced(!advanced)}>
              <span>{t("app.search.advanced")}</span>
              <ChevronDown size={15} aria-hidden />
            </button>
          </div>
          {advanced && (
            <div id="sb-adv">
              <LazySearchAdvanced q={q} change={change} edit={setQ} run={run} close={() => setOpen(false)} onFail={() => setAdvanced(false)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
