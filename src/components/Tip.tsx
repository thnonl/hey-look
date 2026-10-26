import { Star } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
 * A small tooltip for a control whose explanation must be readable where native `title` tooltips do not render (the macOS WKWebView shows none). 1.0.10: the locked
 * One Inbox star only. Shows after 400 ms of the pointer resting on the control, or at once when the keyboard focuses it; goes with the pointer, the focus, a press, a
 * scroll or Escape (WCAG 1.4.13: dismissable, hoverable is not needed because it never takes the pointer). The text is also the control's `aria-label` (the caller keeps
 * its `title` as well); while it shows, the control is described by it. Drawn in a portal at the window's edge so no overflow of the side menu cuts it.
 */
const TIP_DELAY_MS = 400;

function useTip(text: string) {
  const id = useId();
  const [at, setAt] = useState<{ right: number; top: number; bottom: number } | null>(null);
  const timer = useRef(0);
  const hide = () => {
    window.clearTimeout(timer.current);
    setAt(null);
  };
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ right: r.right, top: r.top, bottom: r.bottom });
  };
  useEffect(() => {
    if (!at) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [at]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const bind = {
    "aria-describedby": at ? id : undefined,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "touch") return;
      const el = e.currentTarget;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => show(el), TIP_DELAY_MS);
    },
    onPointerLeave: hide,
    onPointerDown: hide,
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget);
    },
    onBlur: hide,
  };
  const node = at
    ? createPortal(
        <div
          id={id}
          role="tooltip"
          className="tip"
          style={{
            // below the control, its right edge on the control's, kept inside the window (above it when there is no room below)
            right: Math.max(8, window.innerWidth - at.right),
            ...(at.bottom + 8 + 64 > window.innerHeight ? { bottom: window.innerHeight - at.top + 6 } : { top: at.bottom + 6 }),
          }}
        >
          {text}
        </div>,
        document.body,
      )
    : null;
  return { bind, node };
}

/**
 * The star of a row of the side menu (Favorites). `locked` is One Inbox's: filled, `aria-disabled` (not `disabled`, so it keeps its place in the Tab order and its
 * explanation), a press does nothing and does not open the row, and it has the tooltip above.
 */
export function FavStar({ on, locked, label, onToggle }: { on: boolean; locked: boolean; label: string; onToggle: () => void }) {
  const tip = useTip(label);
  return (
    <>
      <button
        className={`fp-star ${on ? "on" : ""} ${locked ? "locked" : ""}`}
        title={label}
        aria-label={label}
        aria-disabled={locked ? true : undefined}
        {...(locked ? tip.bind : undefined)}
        onClick={(e) => {
          e.stopPropagation();
          if (!locked) onToggle();
        }}
      >
        <Star size={12} fill={on ? "currentColor" : "none"} />
      </button>
      {locked && tip.node}
    </>
  );
}
