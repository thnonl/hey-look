// Where a context menu opened at a point goes, and what the keys do inside it. Pure (no DOM), so a script can test it
// (scripts/test-row-menu.mjs); the menu itself is components/ContextMenu.tsx.
import { fitInWindow } from "./fitInWindow.ts";

export interface Size {
  w: number;
  h: number;
}

/**
 * Top-left corner of a menu of `size` opened at the point (x, y) of a window `vw` x `vh`, and the height it has to be limited to when it
 * is taller than the room (it then scrolls inside). Like the menus of the system: down and to the right of the pointer; when that would run
 * off the right / bottom edge it opens to the left / upward of the pointer instead; when neither side has room it slides up to fit the window, and only a menu taller than the window takes the roomier side and scrolls.
 * The result is then kept `edge` px inside the window (fitInWindow.ts, the rule the other popovers use).
 */
export function placeAtPoint(x: number, y: number, size: Size, vw: number, vh: number, edge = 6): { left: number; top: number; maxHeight: number | null } {
  let left = x;
  if (x + size.w > vw - edge && x - size.w >= edge) left = x - size.w; // flip to the left of the pointer
  const below = vh - edge - y;
  const above = y - edge;
  const MIN = 120; // a window that is shorter still shows something usable
  let top = y;
  let maxHeight: number | null = null;
  if (size.h <= below) top = y;
  else if (size.h <= above) top = Math.min(y - size.h, vh - edge - size.h); // flip upward (a pointer on the very edge: still inside)
  else if (size.h <= vh - 2 * edge) top = vh - edge - size.h; // neither side has room but the window does: slid up until it fits, like the system menus
  else if (below >= above) (top = y, maxHeight = Math.max(below, MIN)); // taller than the window: the roomier side, scrollable
  else (maxHeight = Math.max(above, MIN), top = y - maxHeight);
  top = Math.max(edge, top);
  // sideways: kept `edge` px inside the window (the rule of the other popovers); the height was settled above
  const fit = fitInWindow({ left, right: left + size.w, top, bottom: top + (maxHeight ?? size.h) }, vw, vh, edge, MIN);
  return { left: left + fit.shift, top, maxHeight: maxHeight ?? fit.maxHeight };
}

/**
 * Top-left corner of a submenu of `size` opened beside the row `parent` of its parent menu: to the right of the menu, to the left when there
 * is no room, level with the row, moved up when it would run off the bottom.
 */
export function placeBeside(parent: { left: number; right: number; top: number }, size: Size, vw: number, vh: number, edge = 6): { left: number; top: number; maxHeight: number | null } {
  let left = parent.right - 2;
  if (left + size.w > vw - edge && parent.left + 2 - size.w >= edge) left = parent.left + 2 - size.w;
  left = Math.max(edge, Math.min(left, vw - edge - size.w));
  const top = Math.max(edge, Math.min(parent.top - 5, vh - edge - size.h));
  const room = vh - edge - top;
  return { left, top, maxHeight: size.h > room ? Math.max(room, 120) : null };
}

/** What a key does in a menu whose rows are numbered 0..count-1 with `at` the focused one (-1 = none yet). `null`: the key is not a menu key. */
export type MenuKey = { kind: "focus"; index: number } | { kind: "activate" } | { kind: "open-sub" } | { kind: "close-sub" } | { kind: "close" };

export function menuKey(key: string, at: number, count: number, hasSub: boolean, inSub: boolean): MenuKey | null {
  if (count === 0) return key === "Escape" || key === "Tab" ? { kind: "close" } : null;
  switch (key) {
    case "ArrowDown":
      return { kind: "focus", index: at < 0 ? 0 : (at + 1) % count };
    case "ArrowUp":
      return { kind: "focus", index: at < 0 ? count - 1 : (at - 1 + count) % count };
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: count - 1 };
    case "Enter":
    case " ":
      return hasSub ? { kind: "open-sub" } : { kind: "activate" };
    case "ArrowRight":
      return hasSub ? { kind: "open-sub" } : null;
    case "ArrowLeft":
      return inSub ? { kind: "close-sub" } : null;
    case "Escape":
      return inSub ? { kind: "close-sub" } : { kind: "close" };
    case "Tab":
      return { kind: "close" };
    default:
      return null;
  }
}

/** Type-ahead: the index of the next row (after `from`, wrapping) whose label starts with `typed` (accents and case ignored). -1 when none does. */
export function typeAhead(labels: readonly string[], typed: string, from: number): number {
  const fold = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLocaleLowerCase();
  const want = fold(typed);
  if (!want) return -1;
  for (let k = 1; k <= labels.length; k++) {
    const i = (from + k) % labels.length;
    if (fold(labels[i]).startsWith(want)) return i;
  }
  return -1;
}

/** Whether the contextmenu event that follows the ContextMenu key / Shift+F10 press is the one the key press already answered (WebView2 sends it on key up). */
export const KEY_CONTEXT_DEDUPE_MS = 600;
export function isKeyEcho(openedByKeyAt: number, now: number): boolean {
  return openedByKeyAt > 0 && now - openedByKeyAt >= 0 && now - openedByKeyAt < KEY_CONTEXT_DEDUPE_MS;
}

/** Whether this key press asks for a context menu (the ContextMenu key, or Shift+F10 - without other modifiers). */
export function isContextMenuKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  if (e.key === "ContextMenu") return !e.ctrlKey && !e.altKey && !e.metaKey;
  return e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}
