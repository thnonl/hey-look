import { ChevronRight } from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuKey, placeAtPoint, placeBeside, typeAhead } from "../contextMenu";
import type { Size } from "../contextMenu";

export interface CtxItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  /** greyed out: it stays in the menu and in the keyboard order (`aria-disabled`), activating it does nothing */
  disabled?: boolean;
  /** extra text at the end of the row (the reason an entry is off) */
  hint?: string;
  /** tooltip of the row */
  title?: string;
  divider?: boolean;
  /** a line of text above the entries (not an entry) */
  header?: string;
  /** a flyout menu: opens on the right (ArrowRight / Enter / pointer over) */
  submenu?: CtxItem[];
}

interface Place {
  left: number;
  top: number;
  maxHeight: number | null;
}

/** One panel (the menu, or a flyout of it) drawn in a portal on <body> at fixed coordinates; `place` is told its measured size. */
function Panel({
  items, place, label, labelledBy, focusFirst, onPick, onExit, onLeave,
}: {
  items: CtxItem[];
  place: (size: Size) => Place;
  label?: string;
  labelledBy?: string;
  /** focus the first entry as soon as it is placed (keyboard open); otherwise the menu itself takes the focus and an arrow key picks the first */
  focusFirst: boolean;
  onPick: (it: CtxItem) => void;
  /** the whole menu closes (Escape, Tab) */
  onExit: () => void;
  /** a flyout asks to be closed (ArrowLeft / Escape): the focus goes back to its row */
  onLeave?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Place | null>(null);
  const [sub, setSub] = useState<{ i: number; focus: boolean } | null>(null);
  const typed = useRef({ text: "", at: 0 });
  // measured once, hidden: the size decides which side of the pointer the menu opens on
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setPos(place({ w: el.offsetWidth, h: el.offsetHeight })); // not getBoundingClientRect: the opening animation scales the box
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    if (focusFirst) rows()[0]?.focus({ preventScroll: true });
    else list.current?.focus({ preventScroll: true });
  }, [placed]); // eslint-disable-line react-hooks/exhaustive-deps
  // the entries that are rows (dividers and headers are not), in the order of the DOM rows
  const rowItems = items.filter((it) => !it.divider && !it.header);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = rows();
    const at = els.indexOf(document.activeElement as HTMLElement);
    const cur = rowItems[at];
    if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation(); // letters are the shortcuts of the app; here they are type-ahead
      const now = Date.now();
      const ty = typed.current;
      ty.text = now - ty.at > 700 ? e.key : ty.text + e.key;
      ty.at = now;
      const hit = typeAhead(rowItems.map((x) => x.label ?? ""), ty.text, ty.text.length === 1 ? at : Math.max(at - 1, -1));
      if (hit >= 0) {
        e.preventDefault();
        els[hit]?.focus({ preventScroll: true });
      }
      return;
    }
    const k = menuKey(e.key, at, els.length, !!cur?.submenu && !cur.disabled, !!onLeave);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation(); // the global keys (Esc clears the selection) must not also react
    if (k.kind === "focus") els[k.index]?.focus({ preventScroll: true });
    else if (k.kind === "activate") {
      if (cur && !cur.disabled) onPick(cur);
    } else if (k.kind === "open-sub") setSub({ i: at, focus: true });
    else if (k.kind === "close-sub") onLeave?.();
    else onExit();
  };
  const style = pos
    ? ({ left: pos.left, top: pos.top, "--dd-max": pos.maxHeight !== null ? `${pos.maxHeight}px` : undefined } as React.CSSProperties)
    : { left: 0, top: 0, visibility: "hidden" as const };
  let rowNo = -1;
  let flyout: ReactNode = null;
  const body = items.map((it, i) => {
    if (it.divider) return <div key={i} className="menu-div" role="separator" />;
    if (it.header) return <div key={i} className="menu-head" role="presentation">{it.header}</div>;
    const n = ++rowNo;
    const open = sub?.i === n && !!it.submenu;
    if (open) {
      flyout = (
        <Panel
          items={it.submenu!}
          focusFirst={sub!.focus}
          onPick={onPick}
          onExit={onExit}
          onLeave={() => {
            setSub(null);
            rows()[n]?.focus({ preventScroll: true });
          }}
          place={(size) => {
            const r = rows()[n]?.getBoundingClientRect();
            return r ? placeBeside(r, size, window.innerWidth, window.innerHeight) : { left: 0, top: 0, maxHeight: null };
          }}
        />
      );
    }
    return (
      <button
        key={i}
        className="menu-row"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={it.disabled || undefined}
        aria-haspopup={it.submenu ? "menu" : undefined}
        aria-expanded={it.submenu ? open : undefined}
        title={it.title}
        onMouseEnter={(e) => {
          e.currentTarget.focus({ preventScroll: true });
          setSub(it.submenu && !it.disabled ? { i: n, focus: false } : null);
        }}
        onClick={() => {
          if (it.disabled) return;
          if (it.submenu) setSub({ i: n, focus: false });
          else onPick(it);
        }}
      >
        <span className="menu-ico">{it.icon}</span>
        <span className="menu-lbl ellipsis">{it.label}</span>
        {it.hint && <span className="menu-hint">{it.hint}</span>}
        {it.submenu && <ChevronRight size={13} className="menu-sub" aria-hidden />}
      </button>
    );
  });
  return (
    <>
      {createPortal(
        <div ref={box} className="dd-fixed ctx-menu" style={style} onContextMenu={(e) => e.preventDefault()}>
          <div ref={list} className="menu" role="menu" tabIndex={-1} aria-label={label} aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
            {body}
          </div>
        </div>,
        document.body,
      )}
      {flyout}
    </>
  );
}

/**
 * A menu opened at a point (right-click, or beside the focused row for the ContextMenu key / Shift+F10).
 * Keyboard: ArrowUp / Down / Home / End move, Enter / Space run the entry, ArrowRight opens a flyout and ArrowLeft / Escape close it, typing
 * jumps to the entry that starts with the letters, Escape closes the menu and focus goes back to `returnTo`, Tab closes it too.
 * Pointer: closes on a press outside, a scroll, a resize, or when the window loses the focus. The entries have role=menuitem (`aria-disabled`
 * when off); the menu is named by `label` or by the element `labelledBy` (the row it was opened on).
 */
export function ContextMenu({
  at, items, label, labelledBy, keyboard, returnTo, onClose,
}: {
  at: { x: number; y: number };
  items: CtxItem[];
  label?: string;
  labelledBy?: string;
  /** opened with the keyboard: the first entry is focused */
  keyboard?: boolean;
  /** where the focus goes when the menu closes */
  returnTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const back = useRef(returnTo);
  back.current = returnTo;
  const shut = useRef((refocus: boolean) => {
    closeRef.current();
    if (refocus && back.current?.isConnected) back.current.focus({ preventScroll: true });
  });
  useEffect(() => {
    const inside = (t: EventTarget | null) => !!(t as Element | null)?.closest?.(".ctx-menu");
    const down = (e: MouseEvent) => !inside(e.target) && shut.current(false);
    const scroll = (e: Event) => !inside(e.target) && shut.current(false); // scrolling the menu itself is fine
    const gone = () => shut.current(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      shut.current(true);
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
    };
  }, []);
  return (
    <Panel
      items={items}
      label={label}
      labelledBy={labelledBy}
      focusFirst={!!keyboard}
      place={(size) => placeAtPoint(at.x, at.y, size, window.innerWidth, window.innerHeight)}
      onPick={(it) => {
        shut.current(true);
        it.onClick?.();
      }}
      onExit={() => shut.current(true)}
    />
  );
}
