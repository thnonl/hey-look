/**
 * Which presses count as "inside" a popover.
 *
 * A FloatingMenu is drawn in a portal on <body>, so a menu opened from a button inside a popover is NOT a DOM descendant
 * of that popover. A document-level "close on a press outside" handler that only asks `popover.contains(target)` sees a
 * press on a menu row as outside, closes the popover (and with it the menu) on mousedown and the row's click never
 * happens: the '…' menu of the calendar event popover did nothing when clicked with the mouse (Return worked, it fires no
 * mousedown). Each menu therefore registers its anchor here, and a press on a menu counts as inside every element that
 * contains that menu's anchor.
 */
export const MENU_SELECTOR = ".dd-fixed";

type Rooted = { current: Node | null };

/** menu element -> ref of the anchor it was opened from */
export const menuOwners = new WeakMap<object, Rooted>();

export function pressIsOutside(target: EventTarget | null, roots: Rooted[]): boolean {
  const n = target as (Node & { closest?: (s: string) => Element | null }) | null;
  if (!n) return true;
  if (roots.some((r) => r.current?.contains(n))) return false;
  const menu = n.closest?.(MENU_SELECTOR);
  const anchor = menu ? menuOwners.get(menu)?.current : null;
  return !(anchor && roots.some((r) => r.current?.contains(anchor)));
}
