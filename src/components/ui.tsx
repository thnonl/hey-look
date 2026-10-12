import { Check, ChevronDown } from "lucide-react";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hue, initials } from "../util";

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  checked?: boolean;
  divider?: boolean;
  disabled?: boolean;
  hint?: string;
}

type Ref = React.RefObject<HTMLElement | null>;

/** Calls onOut on a press outside of every given element (or on Escape) while active. */
export function useOutside(ref: Ref | Ref[], onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const refs = Array.isArray(ref) ? ref : [ref];
    const h = (e: MouseEvent) => {
      if (refs.every((r) => r.current && !r.current.contains(e.target as Node))) onOut();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && onOut();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [active, onOut, ref]);
}

export function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  return (
    <div className="menu" role="menu">
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} className="menu-div" />
        ) : (
          <button
            key={i}
            className="menu-row"
            disabled={it.disabled}
            onClick={() => {
              onDone();
              it.onClick?.();
            }}
          >
            <span className="menu-ico">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="menu-lbl">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * A menu drawn in a portal on <body> with fixed coordinates taken from its anchor, so no scrolling or overflow-clipped
 * parent (the ribbon row, an invitation card, a dialog body) can cut it off. It opens below the anchor, upward when it
 * would run off the bottom of the window, on the roomier side (scrollable) when neither fits, and is kept inside the
 * window sideways. Closes on a press outside (anchor and menu count as inside), Escape, a resize, or a scroll of
 * something that carries the anchor.
 */
export function FloatingMenu({
  anchor,
  items,
  align = "left",
  minWidth,
  onClose,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  items: MenuItem[];
  align?: "left" | "right";
  minWidth?: number;
  onClose: () => void;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; max: number } | null>(null);
  useOutside([anchor, pop], onClose, true);
  // an effect, not a layout effect: a conditionally attached anchor ref (the invitation buttons) is only set once this commit is done
  useEffect(() => {
    const p = pop.current?.getBoundingClientRect();
    const b = anchor.current?.getBoundingClientRect();
    if (!p || !b) return;
    const gap = 4;
    const edge = 6;
    const below = window.innerHeight - edge - (b.bottom + gap);
    const above = b.top - gap - edge;
    // down when it fits, else up when it fits, else the roomier side with the list made scrollable
    const up = p.height > below && (p.height <= above || above > below);
    const room = up ? above : below;
    const top = up ? b.top - gap - Math.min(p.height, room) : b.bottom + gap;
    const want = align === "right" ? b.right - p.width : b.left;
    const left = Math.max(edge, Math.min(want, window.innerWidth - p.width - edge));
    setPos({ top, left, max: room });
  }, [anchor, align]);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && t !== document && t.contains(anchor.current)) onClose();
    };
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);
  const style = pos ? ({ top: pos.top, left: pos.left, "--dd-max": `${pos.max}px` } as React.CSSProperties) : { top: 0, left: 0, visibility: "hidden" as const };
  return createPortal(
    <div ref={pop} className="dd-fixed" style={{ ...style, minWidth }}>
      <MenuList items={items} onDone={onClose} />
    </div>,
    document.body,
  );
}

/** Button that opens a menu below it. */
export function Dropdown({
  children,
  items,
  className = "",
  title,
  align = "left",
  caret = true,
}: {
  children: ReactNode;
  items: MenuItem[];
  className?: string;
  title?: string;
  align?: "left" | "right";
  caret?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="dd" ref={ref}>
      <button className={className} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {children}
        {caret && <ChevronDown size={12} className="caret" />}
      </button>
      {open && <FloatingMenu anchor={ref} items={items} align={align} onClose={close} />}
    </div>
  );
}

export function Avatar({ name, size = 36, color }: { name: string; size?: number; color?: string }) {
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.38, background: color ?? `hsl(${hue(name)} 50% 31%)` }}
    >
      {initials(name)}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track">
        <span className="thumb" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide, width }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; width?: number }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} style={width ? { width } : undefined} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
