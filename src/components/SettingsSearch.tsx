// Search in Settings (1.0.7 W8.12): the box that sits at the top of the navigation, and the list of results that takes the place of the navigation while it holds text.
// The registry and the ranking are src/settingsIndex.ts; the jump to a result is src/settingsJump.ts. This file is part of the Settings chunk (and so is its CSS).
import { Search, X } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import "../settingsSearch.css";
import { isImeEvent } from "../recipients";
import { fold, optionName, searchSettings, type Entry, type Hit } from "../settingsIndex";
import { kbd, usePlatform } from "../platform";
import { useT } from "../i18n/react";

export interface SearchState {
  q: string;
  setQ: (q: string) => void;
  /** the text holds something to look for (not only spaces and punctuation): the results take the place of the navigation */
  searching: boolean;
  hits: Hit[];
  /** the option the arrow keys are on, or that was jumped to last (-1: none) */
  active: number;
  setActive: (i: number) => void;
  /** the live region's text: the count or "No settings found", 500 ms after the last change */
  live: string;
  boxRef: React.RefObject<HTMLInputElement | null>;
  /** the element that had the focus before the box took it (Esc with an empty box gives it back) */
  before: React.MutableRefObject<HTMLElement | null>;
  listId: string;
}

/** The state of the search: the text, the results (recomputed on every input event, with no delay), the active option, the live region. */
export function useSettingsSearch(index: readonly Entry[]): SearchState {
  const t = useT();
  const [q, setQRaw] = useState("");
  const [active, setActive] = useState(-1);
  const [live, setLive] = useState("");
  const boxRef = useRef<HTMLInputElement | null>(null);
  const before = useRef<HTMLElement | null>(null);
  const listId = useId();
  const hits = useMemo(() => searchSettings(index, q), [index, q]);
  // dev preview seam: scripts/test-settings-search.mjs compares the index the box searches with the rows on screen
  useEffect(() => {
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as { __settingsIndex?: readonly Entry[] }).__settingsIndex = index;
  }, [index]);
  const searching = useMemo(() => fold(q) !== "", [q]);
  const setQ = (next: string) => {
    setQRaw(next);
    setActive(-1);
  };
  // one announcement, 500 ms after the last change of the text, the language or the mailboxes (not one per key press)
  useEffect(() => {
    setLive("");
    if (!searching) return;
    const timer = setTimeout(() => setLive(hits.length ? t("settings.search.count", { n: hits.length }) : t("settings.search.none")), 500);
    return () => clearTimeout(timer);
  }, [q, index, searching]); // eslint-disable-line react-hooks/exhaustive-deps
  return { q, setQ, searching, hits, active: active < hits.length ? active : -1, setActive, live, boxRef, before, listId };
}

/** The box. `onPick` jumps to a result. */
export function SearchBox({ s, onPick }: { s: SearchState; onPick: (e: Entry) => void }) {
  const t = useT();
  const os = usePlatform((p) => p.os);
  const opt = (i: number) => `${s.listId}-o${i}`;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeEvent(e)) return; // (an Enter that confirms a half-converted word is not a jump)
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!s.hits.length) return;
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(s.active + 1, s.hits.length - 1) : Math.max(s.active - 1, 0);
      s.setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = s.hits[s.active >= 0 ? s.active : 0];
      if (hit) {
        s.setActive(s.active >= 0 ? s.active : 0);
        onPick(hit.entry);
      }
    } else if (e.key === "Escape") {
      // Esc never closes Settings from here: with text it clears the text, with none the focus goes back to where it came from, and the next Esc closes
      e.preventDefault();
      if (s.q) s.setQ("");
      else {
        const back = s.before.current;
        if (back && document.contains(back) && !back.closest("[hidden]")) back.focus();
        else document.querySelector<HTMLElement>(".settings-nav button.active")?.focus();
      }
    }
  };
  return (
    <div className="set-search">
      <div className="set-box">
        <Search size={14} aria-hidden className="set-ico" />
        <input
          ref={s.boxRef}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={s.searching && s.hits.length > 0}
          aria-controls={s.searching && s.hits.length > 0 ? s.listId : undefined}
          aria-activedescendant={s.active >= 0 ? opt(s.active) : undefined}
          aria-keyshortcuts={os === "macos" ? "Meta+F /" : "Control+F /"}
          aria-label={t("settings.search.label")}
          placeholder={t("settings.search.label")}
          title={t("settings.search.title", { key: kbd("Ctrl+F", os) })}
          maxLength={100}
          spellCheck={false}
          autoComplete="off"
          value={s.q}
          onChange={(e) => s.setQ(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            const from = e.relatedTarget as HTMLElement | null;
            if (from && from !== e.currentTarget && document.contains(from)) s.before.current = from;
          }}
        />
        {s.q && (
          <button type="button" className="icon-btn set-clear" aria-label={t("app.search.clear")} title={t("app.search.clear")} onClick={() => (s.setQ(""), s.boxRef.current?.focus())}>
            <X size={14} aria-hidden />
          </button>
        )}
      </div>
      <div className="sr-only" role="status">{s.live}</div>
    </div>
  );
}

/** The matched parts of a label in bold (a weight, not a colour). */
function Marked({ text, ranges }: { text: string; ranges: [number, number][] }): ReactNode {
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<b key={i}>{text.slice(a, b)}</b>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <Fragment>{out}</Fragment>;
}

/** The results (or "No settings found"), in the column of the navigation. */
export function SearchResults({ s, onPick }: { s: SearchState; onPick: (e: Entry) => void }) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  // the option the arrow keys are on stays in view (under the box, which is sticky)
  useEffect(() => {
    if (s.active < 0) return;
    const el = document.getElementById(`${s.listId}-o${s.active}`);
    const nav = el?.closest<HTMLElement>(".settings-nav");
    if (!el || !nav) return;
    const top = (nav.querySelector<HTMLElement>(".set-search")?.offsetHeight ?? 0) + nav.getBoundingClientRect().top;
    const r = el.getBoundingClientRect();
    if (r.top < top) nav.scrollTop -= top - r.top;
    else if (r.bottom > nav.getBoundingClientRect().bottom) nav.scrollTop += r.bottom - nav.getBoundingClientRect().bottom;
  }, [s.active, s.listId]);
  if (!s.hits.length)
    return (
      <div className="set-none">
        <div className="set-none-title">{t("settings.search.none")}</div>
        <div className="muted small">{t("settings.search.noneHint")}</div>
      </div>
    );
  return (
    <div ref={list} id={s.listId} role="listbox" aria-label={t("settings.search.results")} className="set-results">
      {s.hits.map((h, i) => (
        <div
          key={`${h.entry.tab}|${h.entry.section ?? ""}|${h.entry.id}`}
          id={`${s.listId}-o${i}`}
          role="option"
          aria-selected={i === s.active}
          aria-label={optionName(h.entry)}
          className={`set-opt${i === s.active ? " on" : ""}`}
          title={`${h.entry.label}${h.entry.line ? ` — ${h.entry.line}` : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (s.setActive(i), onPick(h.entry))}
        >
          <span className="set-opt-label" aria-hidden>
            <Marked text={h.entry.label} ranges={h.ranges} />
          </span>
          {h.entry.line && <span className="set-opt-place muted small ellipsis" aria-hidden>{h.entry.line}</span>}
        </div>
      ))}
    </div>
  );
}
