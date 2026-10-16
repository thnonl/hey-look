/**
 * What the stack of toasts shows (pure, so a script can test it: scripts/test-toast-stack.mjs).
 *
 * Toasts that stay until they are answered (sticky ones) and error toasts could pile up without a limit: six failed translations covered
 * the mail list and the reading pane. So:
 *  - at most `MAX_PERSISTENT` of them are shown per kind (error / info / success), the newest ones; the older ones fold into one
 *    "N more" row in the place of the oldest hidden one. They are not lost: when a shown toast goes, the next older one is shown again.
 *  - an error toast with the same text as one that is already there (and nothing to undo) replaces it instead of stacking up.
 * Normal toasts (the 4 to 8 seconds ones, with or without Undo) are never hidden or merged.
 */

export const MAX_PERSISTENT = 3;

/** A text that follows the language: a function is called each time the toast is drawn (the toasts redraw on a language switch), so a
 *  toast made from a translation key stays in the language in use instead of the one it was made in. */
export type Lazy = string | (() => string);
export const lazyText = (x: Lazy): string => (typeof x === "function" ? x() : x);

export type ToastKind = "info" | "success" | "error";

/** The part of a toast this file looks at. */
export interface StackToast {
  id: number;
  text: string;
  kind: ToastKind;
  sticky?: boolean;
  undo?: unknown;
}

/** Stays until answered, or an error: the toasts the limit is for. */
export const isPersistent = (t: StackToast): boolean => !t.undo && (!!t.sticky || t.kind === "error");

/** What "Dismiss all" on the "N more" row of `kind` clears: every persistent toast of that kind, the shown rows as well as the folded ones. */
export function clearableOfKind<T extends StackToast>(toasts: readonly T[], kind: ToastKind): T[] {
  return toasts.filter((t) => t.kind === kind && isPersistent(t));
}

export type StackItem<T extends StackToast> = { toast: T } | { more: ToastKind; hidden: T[] };

/** The rows to show, in the order of `toasts`: each toast, or one "N more" row (`hidden` = the older toasts of that kind it stands for). */
export function stackItems<T extends StackToast>(toasts: readonly T[], max = MAX_PERSISTENT): StackItem<T>[] {
  const hiddenIds = new Set<number>();
  const hiddenOf = new Map<ToastKind, T[]>();
  for (const kind of ["error", "info", "success"] as const) {
    const mine = toasts.filter((t) => t.kind === kind && isPersistent(t));
    if (mine.length <= max) continue;
    // the "N more" row takes a place of its own, so with more than `max` the newest `max - 1` stay beside it
    const keep = max - 1;
    const drop = mine.slice(0, mine.length - keep);
    if (!drop.length) continue;
    hiddenOf.set(kind, drop);
    for (const t of drop) hiddenIds.add(t.id);
  }
  const out: StackItem<T>[] = [];
  const placed = new Set<ToastKind>();
  for (const t of toasts) {
    if (!hiddenIds.has(t.id)) {
      out.push({ toast: t });
    } else if (!placed.has(t.kind)) {
      placed.add(t.kind);
      out.push({ more: t.kind, hidden: hiddenOf.get(t.kind) ?? [] });
    }
  }
  return out;
}

/** `toasts` plus `next` (last = newest). Older error toasts with the same text that have nothing to undo are replaced, not stacked
 *  (a sticky toast has its `key` for that: a new one of the same key replaces the old in place, and two jobs keep their own Retry). */
export function addToast<T extends StackToast>(toasts: readonly T[], next: T): T[] {
  const same = (t: T) => next.kind === "error" && !next.undo && !t.undo && !next.sticky && !t.sticky && t.kind === "error" && t.text === next.text;
  return [...toasts.filter((t) => !same(t)), next];
}
