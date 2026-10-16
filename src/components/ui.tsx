import { Check, ChevronDown } from "lucide-react";
import { ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/react";
import { accountColor } from "../prefs";
import { fitInWindow } from "../fitInWindow";
import { menuOwners, pressIsOutside } from "../pressInside";
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
  /** colour dot shown before the label (accounts) */
  dot?: string;
  /** language of the label when it differs from the app's (the language names, each in its own language) */
  lang?: string;
  /** extra text the type-ahead of the menu also matches (the English name of a language written in its own) */
  search?: string;
}

type Ref = React.RefObject<HTMLElement | null>;

/** Calls onOut on a press outside of every given element (or on Escape) while active. */
export function useOutside(ref: Ref | Ref[], onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const refs = Array.isArray(ref) ? ref : [ref];
    // a press on a menu that was opened from inside counts as inside: the menu is portalled out of the DOM tree (see pressInside.ts)
    const h = (e: MouseEvent) => {
      if (pressIsOutside(e.target, refs)) onOut();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Esc closes only this popover: the global Esc (clear selection) and an open dialog must not react as well
      onOut();
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [active, onOut, ref]);
}

/**
 * Keeps an absolutely placed popover (CSS `left` / `top` next to its button) inside the window while `active`: it is moved sideways when an
 * edge would be cut off (the compose pane is narrow at the minimum window width) and made scrollable when it is taller than the room below it.
 * Nothing changes when it already fits. Measured when it opens and when the window is resized.
 */
export function useFitInWindow(ref: Ref, active: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const edge = 8;
    const fit = () => {
      el.style.marginLeft = "";
      el.style.maxHeight = "";
      const { shift, maxHeight } = fitInWindow(el.getBoundingClientRect(), window.innerWidth, window.innerHeight, edge);
      if (shift) el.style.marginLeft = `${shift}px`;
      if (maxHeight !== null) el.style.maxHeight = `${maxHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref, active]);
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
            data-search={it.search}
            disabled={it.disabled}
            onClick={() => {
              onDone();
              it.onClick?.();
            }}
          >
            <span className="menu-ico">{it.checked ? <Check size={14} /> : it.icon}</span>
            {it.dot && <span className="dot" style={{ background: it.dot }} />}
            <span className="menu-lbl ellipsis" lang={it.lang}>{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

const ITEMS = '[role^="menuitem"]:not(:disabled)';

/**
 * A menu drawn in a portal on <body> with fixed coordinates taken from its anchor, so no scrolling or overflow-clipped
 * parent (the ribbon row, an invitation card, a dialog body) can cut it off. It opens below the anchor, upward when it
 * would run off the bottom of the window, on the roomier side (scrollable) when neither fits, and is kept inside the
 * window sideways.
 *
 * Keyboard: focus moves into the menu when it opens (the checked row, else the first; `start="last"` for ArrowUp on the
 * trigger); ArrowUp/Down/Home/End move between rows, typing letters jumps to the next row that starts with them (a long list,
 * such as the languages), Tab closes it and carries on from the trigger, Escape closes it,
 * returns focus to the trigger and does not reach the global shortcuts (it must not also clear the open conversation).
 * Mouse: closes on a press outside (anchor and menu count as inside), a resize, or any scroll outside the menu.
 *
 * `trigger` is the element focus returns to (defaults to the anchor); `onClose` only has to hide the menu.
 */
export function FloatingMenu({
  anchor,
  trigger,
  items,
  align = "left",
  minWidth,
  start = "first",
  onClose,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  trigger?: React.RefObject<HTMLElement | null>;
  items: MenuItem[];
  align?: "left" | "right";
  minWidth?: number;
  start?: "first" | "last";
  onClose: () => void;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; max: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const shut = useCallback(
    (refocus: boolean) => {
      close.current();
      if (refocus) (trigger ?? anchor).current?.focus({ preventScroll: true });
    },
    [anchor, trigger],
  );
  const typed = useRef({ text: "", at: 0 });
  const rows = () => Array.from(pop.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
  // an effect, not a layout effect: a conditionally attached anchor ref (the invitation buttons) is only set once this commit is done
  useEffect(() => {
    const p = pop.current?.getBoundingClientRect();
    const b = anchor.current?.getBoundingClientRect();
    if (!p || !b) return;
    const gap = 4;
    const edge = 6;
    // a trigger scrolled out of view (a dialog body, a list) has nowhere sensible to anchor the menu: close it instead of placing it off-screen
    if (b.bottom < edge || b.top > window.innerHeight - edge || b.right < edge || b.left > window.innerWidth - edge) {
      close.current();
      return;
    }
    const below = window.innerHeight - edge - (b.bottom + gap);
    const above = b.top - gap - edge;
    // down when it fits, else up when it fits, else the roomier side with the list made scrollable
    const up = p.height > below && (p.height <= above || above > below);
    const room = up ? above : below;
    const raw = up ? b.top - gap - Math.min(p.height, room) : b.bottom + gap;
    const top = Math.max(edge, Math.min(raw, window.innerHeight - edge - Math.min(p.height, room)));
    const want = align === "right" ? b.right - p.width : b.left;
    const left = Math.max(edge, Math.min(want, window.innerWidth - p.width - edge));
    setPos({ top, left, max: room });
  }, [anchor, align]);
  // lets a "press outside" handler of the popover this menu was opened from tell that a press on a row is not outside (pressInside.ts)
  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    menuOwners.set(el, anchor);
    return () => void menuOwners.delete(el);
  }, [anchor]);
  // keyboard users land in the menu however it was opened; only once it is placed (a hidden element cannot take focus)
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    const list = rows();
    (start === "last" ? list[list.length - 1] : list.find((x) => x.getAttribute("aria-checked") === "true") ?? list[0])?.focus({ preventScroll: true });
  }, [placed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!anchor.current?.contains(n) && !pop.current?.contains(n)) shut(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Esc only closes the menu: the global Esc (clear selection) and an open dialog must not react as well
      e.preventDefault();
      shut(true);
    };
    const gone = () => shut(false);
    const scroll = (e: Event) => !pop.current?.contains(e.target as Node) && shut(false); // scrolling the menu itself is fine
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", gone);
    window.addEventListener("scroll", scroll, true); // any scroll container moving the anchor would leave the menu behind
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", gone);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor, shut]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = rows();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key.length !== 1) typed.current.text = ""; // an Arrow / Home / End key starts a new type-ahead word
    const go = (el?: HTMLElement) => {
      e.preventDefault();
      el?.focus();
    };
    if (e.key === "ArrowDown") go(list[(i + 1) % list.length]);
    else if (e.key === "ArrowUp") go(list[(i - 1 + list.length) % list.length]);
    else if (e.key === "Home") go(list[0]);
    else if (e.key === "End") go(list[list.length - 1]);
    else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // type-ahead: letters typed within 700 ms make one prefix; the same letter again steps through the rows starting with it
      const now = Date.now();
      const ty = typed.current;
      ty.text = now - ty.at > 700 ? e.key : ty.text + e.key;
      ty.at = now;
      const fold = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLocaleLowerCase();
      const want = fold(ty.text);
      const same = want.length > 1 && [...want].every((c) => c === want[0]);
      const prefix = same ? want[0] : want;
      const hit = (el: HTMLElement) => [el.querySelector(".menu-lbl")?.textContent ?? "", el.dataset.search ?? ""].some((x) => fold(x).startsWith(prefix));
      const from = same || ty.text.length === 1 ? i + 1 : Math.max(i, 0); // a longer prefix may stay on the current row
      const order = [...list.slice(from), ...list.slice(0, from)];
      go(order.find(hit));
    }
    else if (e.key === "Tab") shut(true); // focus returns to the trigger and Tab carries on from there
  };
  const style = pos ? ({ top: pos.top, left: pos.left, "--dd-max": `${pos.max}px` } as React.CSSProperties) : { top: 0, left: 0, visibility: "hidden" as const };
  return createPortal(
    <div ref={pop} className="dd-fixed" style={{ ...style, minWidth }} onKeyDown={onKeyDown}>
      <MenuList items={items} onDone={() => shut(true)} />
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
  wrapClass = "",
  matchWidth = false,
}: {
  children: ReactNode;
  items: MenuItem[];
  className?: string;
  title?: string;
  align?: "left" | "right";
  caret?: boolean;
  /** class of the wrapper (to size the control) */
  wrapClass?: string;
  /** the menu is at least as wide as the button */
  matchWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const start = useRef<"first" | "last">("first"); // which end an Arrow key on the trigger asked for
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className={`dd ${wrapClass}`} ref={ref}>
      <button
        ref={trigger}
        className={className}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          start.current = "first";
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          start.current = e.key === "ArrowDown" ? "first" : "last";
          setOpen(true);
        }}
      >
        {children}
        {caret && <ChevronDown size={12} className="caret" />}
      </button>
      {open && <FloatingMenu anchor={ref} trigger={trigger} items={items} align={align} start={start.current} minWidth={matchWidth ? ref.current?.offsetWidth : undefined} onClose={close} />}
    </div>
  );
}

export interface PickerAccount {
  id: string;
  email: string;
  displayName?: string | null;
  color?: string | null;
}

/**
 * Account chooser built on the shared Dropdown: colour dot + name + address on every entry, same keyboard behaviour
 * and look as the other menus. `none` adds a leading entry without account (value "").
 */
export function AccountPicker({
  value, accounts, onChange, label, none, className = "",
}: {
  value: string;
  accounts: PickerAccount[];
  onChange: (id: string) => void;
  label: string;
  none?: string;
  className?: string;
}) {
  const accent = useStore((s) => s.prefs.accent);
  const name = (a: PickerAccount) => a.displayName || a.email;
  const cur = accounts.find((a) => a.id === value);
  const body = (a?: PickerAccount) =>
    a ? (
      <>
        <span className="dot" style={{ background: accountColor(a, accent) }} />
        <span className="ap-name ellipsis">{name(a)}</span>
        {a.displayName && <span className="ap-addr ellipsis">{a.email}</span>}
      </>
    ) : (
      <span className="ap-name ellipsis">{none}</span>
    );
  if (accounts.length === 1 && !none) {
    // a single mailbox: nothing to choose, show it as readable text
    return <div className={`acct-pick static ${className}`} aria-label={`${label}: ${cur?.email ?? accounts[0].email}`}>{body(cur ?? accounts[0])}</div>;
  }
  const items: MenuItem[] = [
    ...(none !== undefined ? [{ label: none, checked: value === "", onClick: () => onChange("") }] : []),
    ...accounts.map((a) => ({ label: name(a), hint: a.displayName ? a.email : undefined, dot: accountColor(a, accent), checked: a.id === value, onClick: () => onChange(a.id) })),
  ];
  return (
    <Dropdown className={`acct-pick ${className}`} wrapClass="acct-pick-wrap" matchWidth title={`${label}: ${cur ? cur.email : none ?? ""}`} items={items}>
      {body(cur)}
    </Dropdown>
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

export function Switch({ checked, onChange, label, disabled, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; ariaLabel?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked)} />
      <span className="track">
        <span className="thumb" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[contenteditable=true],[tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, wide, width }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; width?: number }) {
  const t = useT();
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
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trap}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <b id={titleId}>{title}</b>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
