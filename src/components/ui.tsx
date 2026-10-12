import { Check, ChevronDown } from "lucide-react";
import { ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
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

export function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
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
            role={it.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={it.checked === undefined ? undefined : it.checked}
            tabIndex={-1}
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
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const want = useRef<"first" | "last" | null>(null); // which item an Arrow key on the trigger asked for
  const rows = () => Array.from(pop.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  // The menu is rendered in <body> with fixed coordinates taken from the trigger, so it is never clipped by an
  // ancestor with overflow / containment (the ribbon row scrolls horizontally, message rows use content-visibility).
  const place = () => {
    const t = ref.current?.getBoundingClientRect();
    const p = pop.current;
    if (!t || !p) return;
    const w = p.offsetWidth, h = p.offsetHeight;
    let left = align === "right" ? t.right - w : t.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = t.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, t.top - h - 4);
    setPos((o) => (o.top === top && o.left === left ? o : { top, left }));
  };
  useLayoutEffect(() => {
    if (open) place();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  // keyboard users land in the menu however it was opened (Enter, Space, Arrow keys or the mouse)
  useEffect(() => {
    if (!open) return;
    const list = rows();
    const target = want.current === "last" ? list[list.length - 1] : list.find((x) => x.getAttribute("aria-checked") === "true") ?? list[0];
    want.current = null;
    target?.focus({ preventScroll: true });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!ref.current?.contains(n) && !pop.current?.contains(n)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Esc only closes the menu: the global Esc (clear selection) must not run as well
      close(true);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    const shut = () => close();
    window.addEventListener("resize", shut);
    const scroll = (e: Event) => !pop.current?.contains(e.target as Node) && close(); // scrolling the menu itself is fine
    window.addEventListener("scroll", scroll, true); // any scroll container moving the trigger would leave the menu behind
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", shut);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  return (
    <div className="dd" ref={ref}>
      <button
        ref={trigger}
        className={className}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          want.current = e.key === "ArrowDown" ? "first" : "last";
          if (!open) setOpen(true);
          else {
            const list = rows();
            (want.current === "last" ? list[list.length - 1] : list[0])?.focus();
            want.current = null;
          }
        }}
      >
        {children}
        {caret && <ChevronDown size={12} className="caret" />}
      </button>
      {open &&
        createPortal(
          <div
            className="dd-pop"
            ref={pop}
            style={{ top: pos.top, left: pos.left }}
            onKeyDown={(e) => {
              const list = rows();
              const i = list.indexOf(document.activeElement as HTMLElement);
              const go = (el?: HTMLElement) => {
                e.preventDefault();
                el?.focus();
              };
              if (e.key === "ArrowDown") go(list[(i + 1) % list.length]);
              else if (e.key === "ArrowUp") go(list[(i - 1 + list.length) % list.length]);
              else if (e.key === "Home") go(list[0]);
              else if (e.key === "End") go(list[list.length - 1]);
              else if (e.key === "Tab") close(true); // focus returns to the trigger and Tab carries on from there
            }}
          >
            <MenuList items={items} onDone={() => close(true)} />
          </div>,
          document.body,
        )}
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

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[contenteditable=true],[tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  // focus moves into the dialog when it opens and goes back to what opened it when it closes
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus({ preventScroll: true });
    return () => {
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);
  // Esc closes - unless a menu or a confirm question on top of the dialog takes it first
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !useStore.getState().ask) onCloseRef.current();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  // Tab / Shift+Tab cycle inside the dialog
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current || !box.current.contains(e.target as Node)) return; // menus portalled out of the dialog handle their own Tab
    const list = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.getClientRects().length > 0);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box.current)) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && active === last) (e.preventDefault(), first.focus());
  };
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div
        ref={box}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trap}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <b id={titleId}>{title}</b>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
