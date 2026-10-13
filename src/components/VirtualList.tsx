import { KeyboardEvent, ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/** One line of the list: a conversation row, or a group header ("Today", "Pinned", ...). */
export interface VItem {
  key: string;
  kind: "row" | "group";
  /** the group the line sits under ("" = no groups): the label of the floating header while it is the first line in view */
  group: string;
}

/** Lines drawn above and below the viewport, so a fast scroll or an arrow key never shows a gap. */
const OVERSCAN = 8;
/** Heights before anything was measured (full density); the first measured line of each kind replaces them. */
const GUESS = { row: 64, group: 34 };
/** Older mail is asked for while this much list is still unread below (or above, oldest-first): the larger of a few screens and a fixed
 * distance, so a normal scroll meets mail that is already there and only a very fast one reaches the "Loading…" footer. */
const PREFETCH_VIEWPORTS = 3;
const PREFETCH_MIN_PX = 4000;
const prefetchPx = (el: HTMLElement, far: boolean) => (far ? Math.max(el.clientHeight * PREFETCH_VIEWPORTS, PREFETCH_MIN_PX) : el.clientHeight);

interface Props<T extends VItem> {
  /** the scrolling element (`.ml-body`); the list lives inside it next to the footer */
  scrollRef: RefObject<HTMLDivElement | null>;
  items: T[];
  render: (item: T) => ReactNode;
  /** changes when the list is a different one (folder, mailbox, search, filter): it starts at the top again */
  viewKey: string;
  /** the line to bring into view when it changes (the selected conversation) */
  reveal: string | null;
  /** header drawn at the top of the viewport for the group of the first visible line */
  floating?: (label: string) => ReactNode;
  footer?: ReactNode;
  /** called whenever the end of the list is within the prefetch distance of the visible area (the caller guards re-entrancy) */
  onNearEnd?: () => void;
  /** same for the start of the list (oldest-first order: older mail is at the top) */
  onNearStart?: () => void;
  /** ask early (default). Off for filtered views: few of the downloaded mail match, so asking early would keep downloading mail nobody scrolled to */
  prefetch?: boolean;
  /** lines added above the first one must not move it, even at the very top (oldest-first order); by default the top shows what is newest */
  holdTop?: boolean;
}

/**
 * Windowed list inside an existing scroll container: only the lines in (and ~8 around) the viewport are in the DOM, the rest is
 * the height of the wrapper. Lines are absolutely placed at `offsets[i]`, so inserting or removing lines never moves the rendered ones.
 *
 * Heights are measured, not guessed: every rendered line is observed (ResizeObserver) and its real height cached by key; lines
 * never drawn yet use the last measured height of their kind. Density, font size, preview on/off or a window resize therefore just
 * work, and the (uniform) rows of a mailbox are laid out exactly after the first paint.
 *
 * The reader's place is kept by content, not by pixel: the first visible line and its offset are remembered while scrolling, and
 * whenever the lines change (a refresh, a chunk of older mail, a re-measure) the scroll position is put back to that line.
 */
export function VirtualList<T extends VItem>({ scrollRef, items, render, viewKey, reveal, floating, footer, onNearEnd, onNearStart, prefetch = true, holdTop }: Props<T>) {
  const heights = useRef(new Map<string, number>());
  const guess = useRef({ ...GUESS });
  const [rev, setRev] = useState(0); // bumps when a measured height differs from what the layout used
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(640);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const anchor = useRef<{ key: string; delta: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => {
    const offsets = new Float64Array(items.length + 1);
    const index = new Map<string, number>();
    items.forEach((it, i) => {
      index.set(it.key, i);
      offsets[i + 1] = offsets[i] + (heights.current.get(it.key) ?? guess.current[it.kind]);
    });
    return { items, offsets, index };
    // `rev` is the signal that heights (a ref) changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, rev]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const holdTopRef = useRef(!!holdTop);
  holdTopRef.current = !!holdTop;

  /** index of the line that contains y (offsets are ascending) */
  const at = (y: number) => {
    const { offsets } = layout;
    let lo = 0;
    let hi = Math.max(0, items.length - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // ---- measuring: one observer for all rendered lines; the stable callback ref observes on mount and un-observes on unmount
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    if (!observer.current) {
      observer.current = new ResizeObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const t = e.target as HTMLElement;
          const h = e.borderBoxSize?.[0]?.blockSize ?? t.getBoundingClientRect().height;
          const key = t.dataset.vkey;
          const kind = t.dataset.vkind as "row" | "group" | undefined;
          if (!key || !kind || !h) continue;
          const used = heights.current.get(key) ?? guess.current[kind];
          if (Math.abs(used - h) > 0.25) changed = true;
          heights.current.set(key, h);
          guess.current[kind] = h;
        }
        if (changed) setRev((r) => r + 1);
      });
    }
    observer.current.observe(el);
    return () => observer.current?.unobserve(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  // ---- the scroll container: scroll position and viewport height
  const remember = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { items: its, offsets } = layoutRef.current;
    if ((el.scrollTop <= 0 && !holdTopRef.current) || its.length === 0) {
      anchor.current = null;
      return;
    }
    let lo = 0;
    let hi = its.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= el.scrollTop) lo = mid;
      else hi = mid - 1;
    }
    anchor.current = { key: its[lo].key, delta: offsets[lo] - el.scrollTop };
  }, [scrollRef]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewH(el.clientHeight);
    // a scroll event arrives at most once per frame already: no extra throttling
    const onScroll = () => {
      setScrollTop(el.scrollTop);
      remember();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [scrollRef, remember]);

  // ---- a different list starts at the top
  const lastView = useRef(viewKey);
  useLayoutEffect(() => {
    if (lastView.current === viewKey) return;
    lastView.current = viewKey;
    anchor.current = null;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [viewKey, scrollRef]);

  // ---- same list, different lines (refresh, older mail, re-measured heights): keep the line the reader was looking at where it was
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (!el) return;
    if (!a) {
      if (holdTop) remember();
      return;
    }
    if (el.scrollTop <= 0 && !holdTop) return;
    const i = layout.index.get(a.key);
    if (i === undefined) return;
    const want = layout.offsets[i] - a.delta;
    if (Math.abs(want - el.scrollTop) > 0.5) {
      el.scrollTop = want;
      setScrollTop(el.scrollTop);
    }
  }, [layout, scrollRef]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Scrolls the least that shows line i completely (below the floating header when there is one). */
  const hasFloat = !!floating;
  const ensureVisible = useCallback(
    (i: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const { offsets, items: its } = layoutRef.current;
      const head = hasFloat && its[i]?.group ? guess.current.group : 0;
      const top = offsets[i];
      const bottom = offsets[i + 1];
      if (top < el.scrollTop + head) el.scrollTop = Math.max(0, top - head);
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      setScrollTop(el.scrollTop);
      remember();
    },
    [scrollRef, hasFloat, remember],
  );

  // the selected conversation (j / k, a click near the edge, the next one after Archive) is brought into view
  const ensureRef = useRef(ensureVisible);
  ensureRef.current = ensureVisible;
  useLayoutEffect(() => {
    if (!reveal) return;
    const i = layoutRef.current.index.get(reveal);
    if (i !== undefined) ensureRef.current(i);
  }, [reveal]);

  // ---- infinite scroll: ask for more well before the end is reached, so the next mail is usually there already
  useEffect(() => {
    const el = scrollRef.current;
    if (!onNearEnd || !el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < prefetchPx(el, prefetch)) onNearEnd();
  }, [scrollRef, onNearEnd, prefetch, scrollTop, layout, viewH, footer]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!onNearStart || !el) return;
    if (el.scrollTop < prefetchPx(el, prefetch)) onNearStart();
  }, [scrollRef, onNearStart, prefetch, scrollTop, layout, viewH]);

  // ---- which lines are drawn
  const n = items.length;
  const first = n ? at(scrollTop) : 0;
  const last = n ? at(scrollTop + viewH) : -1;
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(n - 1, last + OVERSCAN);
  // the line that has the keyboard focus stays drawn, however far it was scrolled away: unmounting it would drop the focus
  const focusIdx = focusKey ? layout.index.get(focusKey) : undefined;
  const indices: number[] = [];
  for (let i = start; i <= end; i++) indices.push(i);
  if (focusIdx !== undefined && (focusIdx < start || focusIdx > end)) indices.push(focusIdx);

  const drawn = useMemo(
    () =>
      indices.map((i) => {
        const it = items[i];
        return (
          <div key={it.key} ref={measure} className="ml-vitem" role="presentation" data-vkey={it.key} data-vkind={it.kind} data-vindex={i} style={{ top: layout.offsets[i] }}>
            {render(it)}
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [start, end, focusIdx, layout, render, measure],
  );

  // a key press moved focus to a line that was not drawn yet: it is now
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const row = wrapRef.current?.querySelector<HTMLElement>(`[data-vkey="${CSS.escape(key)}"] [role="option"]`);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: true });
    }
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cur = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-vkey]");
    const from = cur?.dataset.vkey ? layout.index.get(cur.dataset.vkey) : undefined;
    if (from === undefined) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    let j = from + dir;
    while (j >= 0 && j < n && items[j].kind !== "row") j += dir; // headers are not focusable
    if (j < 0 || j >= n) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    ensureVisible(j);
    pendingFocus.current = items[j].key;
    setFocusKey(items[j].key);
  };

  // the group of the first line in view stays at the top of the list, as a sticky header would
  const floatLabel = floating && scrollTop > 0 && n ? items[first].group : "";

  return (
    <>
      {floatLabel && (
        <div className="ml-float" aria-hidden>
          {floating!(floatLabel)}
        </div>
      )}
      <div
        ref={wrapRef}
        className="ml-vwrap"
        style={{ height: layout.offsets[n] }}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          const k = (e.target as HTMLElement).closest<HTMLElement>("[data-vkey]")?.dataset.vkey;
          if (k) setFocusKey(k);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusKey(null);
        }}
      >
        {drawn}
      </div>
      {footer}
    </>
  );
}
