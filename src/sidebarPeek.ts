import { useCallback, useEffect, useRef, useState } from "react";

/*
 * The peek: while the side menu is folded to icons, the full menu opens over the list and the reading pane (they do not move) when the
 * pointer rests on the icons, when the keyboard focus comes into them, or while a drag is held over them; it closes when the pointer leaves,
 * when the focus leaves, on Escape and after a folder was chosen. FolderPane.tsx wires `bind` to the pane; `busy` keeps it open while a
 * mailbox is being dragged or its menu is open (the menu lives outside the pane).
 */

/** Pointer at rest on the icons this long (ms) opens the menu: passing over them on the way somewhere else does not. */
export const PEEK_HOVER_MS = 200;
/** A drag held over the icons this long opens it, so a message can be dropped on a folder that is not shown as an icon. */
export const PEEK_DRAG_MS = 350;
/** The pointer may leave and come back within this time (ms) without the menu closing. */
export const PEEK_LEAVE_MS = 180;

export function useSidebarPeek(active: boolean, busy: boolean) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const pane = useRef<HTMLElement | null>(null);
  const timer = useRef(0);
  const inside = useRef(false);
  /** a press on the icons: the menu does not open under the pointer a moment after a click, until the pointer has left and come back */
  const pressed = useRef(false);
  const now = useRef({ open, pinned, busy });
  now.current = { open, pinned, busy };

  const stop = () => window.clearTimeout(timer.current);
  const later = (ms: number, fn: () => void) => {
    stop();
    timer.current = window.setTimeout(fn, ms);
  };
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPinned(false);
  }, []);
  const pin = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(true);
    setPinned(true);
  }, []);

  useEffect(() => {
    if (!active) close();
  }, [active, close]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // a menu or a drag that kept it open has ended and the pointer is elsewhere
  useEffect(() => {
    if (busy || !open || inside.current) return;
    if (!pane.current?.contains(document.activeElement)) later(PEEK_LEAVE_MS, close);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape, and a press anywhere outside, close it (the second one is how a pinned menu goes away)
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const st = document.querySelector(".modal, .ctx-menu, .dd-fixed");
      if (st) return; // a dialog or a menu is on top: Escape belongs to it
      e.preventDefault();
      e.stopPropagation(); // (the window's own Escape would deselect the open conversation)
      close();
    };
    const press = (e: PointerEvent) => {
      if (now.current.busy) return;
      const t = e.target as Node | null;
      if (t && pane.current?.contains(t)) return;
      close();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", press, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", press, true);
    };
  }, [open, close]);

  const bind = {
    ref: pane as React.RefObject<HTMLElement>,
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      inside.current = true;
      if (!active || now.current.open) {
        stop(); // back in time: it stays
        return;
      }
      if (!pressed.current) later(PEEK_HOVER_MS, () => setOpen(true));
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      inside.current = false;
      pressed.current = false;
      if (!now.current.open) return stop();
      if (now.current.pinned || now.current.busy) return;
      later(PEEK_LEAVE_MS, close);
    },
    onPointerDown: () => {
      pressed.current = true;
      if (!now.current.open) stop();
    },
    // the keyboard comes in: the menu opens at once (a click that gives the pane the focus does not, :focus-visible is for the keyboard)
    onFocus: (e: React.FocusEvent) => {
      if (!active || now.current.open) return;
      if ((e.target as Element).matches(":focus-visible")) setOpen(true);
    },
    onBlur: (e: React.FocusEvent) => {
      if (!now.current.open || now.current.busy) return;
      const to = e.relatedTarget as Node | null;
      if (to && pane.current?.contains(to)) return;
      if (inside.current) return; // a press on an empty spot of the menu moves the focus to the page: the pointer is still on the menu
      close();
    },
    onDragEnter: () => {
      if (!active || now.current.open) return stop();
      later(PEEK_DRAG_MS, () => setOpen(true));
    },
    onDragLeave: (e: React.DragEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && pane.current?.contains(to)) return;
      if (!now.current.open) return stop();
      later(PEEK_LEAVE_MS, close);
    },
    onDrop: () => close(),
  };
  return { open, pinned, pin, close, bind };
}
