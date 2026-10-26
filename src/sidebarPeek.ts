import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/*
 * The peek: while the side menu is folded to icons, the full menu opens over the list and the reading pane (they do not move) when the
 * pointer rests on the icons, when the keyboard focus comes into them, or while a drag is held over them; it closes when the pointer leaves,
 * when the focus leaves, on Escape and after a folder was chosen. FolderPane.tsx wires `bind` to the pane; `busy` keeps it open while a
 * mailbox is being dragged or its menu is open (the menu lives outside the pane).
 */

/** Pointer at rest on the icons this long (ms) opens the menu: passing over them on the way somewhere else does not. 1.0.10: 500 (was 200), and a move of more than
 *  PEEK_MOVE_PX starts the wait again: a person who arrives from the list and right-clicks an icon within half a second used to hit the menu that had opened under the pointer. */
export const PEEK_HOVER_MS = 500;
/** A move of the pointer on the icons by more than this many px (from where the wait started) is not rest. */
const PEEK_MOVE_PX = 3;
/** A drag held over the icons this long opens it, so a message can be dropped on a folder that is not shown as an icon. */
const PEEK_DRAG_MS = 350;
/** The pointer may leave and come back within this time (ms) without the menu closing. */
const PEEK_LEAVE_MS = 180;

export function useSidebarPeek(active: boolean, busy: boolean) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const pane = useRef<HTMLElement | null>(null);
  const timer = useRef(0);
  const inside = useRef(false);
  /** where the pointer was when the wait for rest started */
  const anchor = useRef({ x: 0, y: 0 });
  /** a press on the icons: the menu does not open under the pointer a moment after a click, until the pointer has left and come back */
  const pressed = useRef(false);
  /** how it was opened: the pointer ("hover", a drag), the keyboard coming in ("key": it stays while the focus is inside), or the control ("pin") */
  const how = useRef<"hover" | "key" | "pin">("hover");
  /** when the last Escape was pressed: the focus a menu gives back to its icon on Escape is not the keyboard coming in */
  const escAt = useRef(-1e9);
  const now = useRef({ open, pinned, busy });
  now.current = { open, pinned, busy };

  /** the last pointer position the page was told about, and whether a button is held: the wait for rest can start without a move (the rail appeared under the pointer, the window got the focus back, a menu closed) */
  const ptr = useRef({ x: -1, y: -1, down: false });
  const stop = () => window.clearTimeout(timer.current);
  const later = (ms: number, fn: () => void) => {
    stop();
    timer.current = window.setTimeout(fn, ms);
  };
  /** when the pointer rest ended in an open peek (performance.now), and when the last press came: a right-click just after the peek opened is the person's click on the icon they were resting on */
  const openedAt = useRef(-1e9);
  const pressAt = useRef(-1e9);
  const openBy = (by: "hover" | "key") => {
    how.current = by;
    openedAt.current = performance.now();
    setOpen(true);
  };
  /** the hover wait ended: nothing opens while a menu is up, a button is down or a press came a moment ago (1.0.10, QA BUG-7: a wait re-armed by a move with the button down fired after the menu) */
  const openHover = () => {
    if (now.current.busy || ptr.current.down || performance.now() - pressAt.current < 1000) return;
    openBy("hover");
  };
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPinned(false);
  }, []);
  const pin = useCallback(() => {
    window.clearTimeout(timer.current);
    how.current = "pin";
    setOpen(true);
    setPinned(true);
  }, []);

  useEffect(() => {
    if (!active) close();
  }, [active, close]);

  // A right-click in the first moments of a hover peek (the pointer had rested, the peek opened, the person clicks the icon they were resting on): the peek goes and the click is
  // given again to the icon under the pointer (1.0.10, QA BUG-7: it landed on a row of the peek, or on none)
  useEffect(() => {
    const ctx = (e: MouseEvent) => {
      if (!now.current.open || how.current !== "hover" || now.current.pinned || performance.now() - openedAt.current > 350) return;
      const el = pane.current;
      if (!el || !(e.target instanceof Node) || !el.contains(e.target) || (e as MouseEvent & { __again?: boolean }).__again) return;
      const rail = el.getBoundingClientRect(); // (the column keeps the width of the icons while the menu lies over the list: only a click on the icons' own place is theirs)
      if (e.clientX >= rail.right) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { clientX: x, clientY: y, ctrlKey, shiftKey, altKey, metaKey } = e;
      flushSync(() => close());
      requestAnimationFrame(() => {
        const to = document.elementFromPoint(x, y);
        if (!to) return;
        const again = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 0, ctrlKey, shiftKey, altKey, metaKey });
        (again as MouseEvent & { __again?: boolean }).__again = true;
        to.dispatchEvent(again);
      });
    };
    window.addEventListener("contextmenu", ctx, true);
    return () => window.removeEventListener("contextmenu", ctx, true);
  }, [close]);

  // the pointer rests on the icons without having moved (or entered) since the icons appeared: the wait starts then (1.0.10, Mac QA)
  const armIfResting = () => {
    const el = pane.current;
    const p = ptr.current;
    if (!el || !active || now.current.open || now.current.busy || pressed.current || p.down || p.x < 0) return;
    const r = el.getBoundingClientRect();
    if (p.x < r.left || p.x >= r.right || p.y < r.top || p.y >= r.bottom) return;
    inside.current = true;
    anchor.current = { x: p.x, y: p.y };
    later(PEEK_HOVER_MS, openHover);
  };
  const armRef = useRef(armIfResting);
  armRef.current = armIfResting;
  useEffect(() => {
    const mv = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      ptr.current = { x: e.clientX, y: e.clientY, down: e.buttons !== 0 };
    };
    const up = () => {
      ptr.current = { ...ptr.current, down: false };
    };
    const focus = () => window.setTimeout(() => armRef.current(), 60);
    window.addEventListener("pointermove", mv, true);
    window.addEventListener("pointerdown", mv, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("pointermove", mv, true);
      window.removeEventListener("pointerdown", mv, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("focus", focus);
    };
  }, []);
  // the icons became the menu column (the sidebar folded under a resting pointer, the window opened folded)
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => armRef.current(), 80);
    return () => window.clearTimeout(id);
  }, [active]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") escAt.current = performance.now();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);

  // a menu or a drag that kept it open has ended and the pointer is elsewhere
  useEffect(() => {
    if (busy) return;
    if (!open) {
      const id = window.setTimeout(() => armRef.current(), 60); // (a menu on an icon closed with the pointer resting on the icons)
      return () => window.clearTimeout(id);
    }
    // (1.0.10, QA BUG-6) the pointer went somewhere that sends no pointerleave (the mail, a frame) while the menu was open, so `inside` can be a stale yes: ask the page now
    inside.current = !!pane.current?.matches(":hover");
    if (inside.current) return;
    // the focus a menu gave back to its icon keeps the peek open only when the keyboard opened it (1.0.10: a hover peek stayed open after its menu closed)
    if (how.current !== "key" || !pane.current?.contains(document.activeElement)) later(PEEK_LEAVE_MS, close);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // the pointer is the authority for a peek it opened: some engines do not send `pointerleave` when the pointer goes into a frame (the mail) or out of the window, so
  // while it is open (not pinned, no menu, no drag) the pane is asked now and then whether it is still hovered; the keyboard's peek stays while the focus is inside
  useEffect(() => {
    if (!open || pinned) return;
    const t = window.setInterval(() => {
      if (now.current.busy || !pane.current) return;
      if (pane.current.matches(":hover")) {
        inside.current = true;
        return;
      }
      if (how.current === "key" && pane.current.contains(document.activeElement)) return;
      inside.current = false;
      close();
    }, 250);
    return () => window.clearInterval(t);
  }, [open, pinned, close]);

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
      anchor.current = { x: e.clientX, y: e.clientY };
      if (!pressed.current) later(PEEK_HOVER_MS, openHover);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.pointerType === "touch" || !active || now.current.open || now.current.busy || e.buttons !== 0 || pressed.current || !inside.current) return;
      if (Math.hypot(e.clientX - anchor.current.x, e.clientY - anchor.current.y) <= PEEK_MOVE_PX) return;
      anchor.current = { x: e.clientX, y: e.clientY };
      later(PEEK_HOVER_MS, openHover); // still moving: the wait starts again
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      inside.current = false;
      pressed.current = false;
      if (!now.current.open) return stop();
      if (now.current.pinned || now.current.busy) return;
      later(PEEK_LEAVE_MS, close);
    },
    onPointerDown: (e: React.PointerEvent) => {
      pressAt.current = performance.now();
      if (e.button !== 2) pressed.current = true; // (a right-click ends with its menu, whose close starts the wait again)
      if (!now.current.open) stop();
    },
    // a right-click is a press too (a system that sends the menu on the release, or without a pointerdown that reaches here): no menu opens over the icon under the pointer
    onContextMenu: () => {
      pressAt.current = performance.now();
      if (!now.current.open) stop(); // (the menu is `busy`; its close starts the wait again)
    },
    // the keyboard comes in: the menu opens at once (a click that gives the pane the focus does not, :focus-visible is for the keyboard)
    onFocus: (e: React.FocusEvent) => {
      if (!active || now.current.open) return;
      // (React sends the focus of a menu that was opened from the pane - a portal outside it - up to the pane too: that is not the keyboard coming in. 1.0.10: a right-click on the grip, which cannot take the focus, opened the menu AND the peek)
      if (!pane.current?.contains(e.target as Node)) return;
      if (performance.now() - escAt.current < 400) return; // (a menu closed with Escape gives the focus back to its icon: not the keyboard coming in)
      if ((e.target as Element).matches(":focus-visible")) openBy("key");
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
      later(PEEK_DRAG_MS, () => openBy("hover"));
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
