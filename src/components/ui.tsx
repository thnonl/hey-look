import { Check, ChevronDown } from "lucide-react";
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  // a menu that would run off the bottom of the window opens upward instead (when there is room above)
  const pop = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    if (!open) return setUp(false);
    const p = pop.current?.getBoundingClientRect();
    const b = ref.current?.getBoundingClientRect();
    if (p && b) setUp(p.bottom > window.innerHeight - 6 && b.top - p.height - 4 >= 6);
  }, [open]);
  return (
    <div className="dd" ref={ref}>
      <button className={className} title={title} aria-label={title} onClick={() => setOpen((o) => !o)}>
        {children}
        {caret && <ChevronDown size={12} className="caret" />}
      </button>
      {open && (
        <div ref={pop} className={`dd-pop ${align}${up ? " up" : ""}`}>
          <MenuList items={items} onDone={() => setOpen(false)} />
        </div>
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
