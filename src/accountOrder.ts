// The order of the mailboxes in the folder pane, the account switcher, Compose's From and Settings (v1.0.6: the person can move them).
// One saved list of account ids (`prefs.accountOrder`) is applied to the list the backend gives (oldest first), so an existing user starts with
// exactly today's order (the saved list is empty), and nothing about the order is stored in the accounts table. Pure, so a script can test it
// (scripts/test-account-order.mjs); the drag and keyboard handling is components/AccountReorder.tsx.

/**
 * `accounts` in the saved order. An account the saved list does not name (a new one, or an install from before this setting) goes after
 * the named ones, in the order the backend gave; ids in the list that are not accounts (a removed account) are ignored.
 */
export function orderAccounts<T extends { id: string }>(accounts: readonly T[], saved: readonly string[] | undefined): T[] {
  if (!saved || saved.length === 0) return [...accounts];
  const rank = new Map<string, number>();
  for (const id of saved) if (!rank.has(id)) rank.set(id, rank.size);
  const known = accounts.filter((a) => rank.has(a.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...known, ...accounts.filter((a) => !rank.has(a.id))];
}

/** Moves the entry at index `from` so that it ends up at index `to` (both clamped to the list); a new array, the same one when nothing moves. */
export function moveIndex<T>(list: readonly T[], from: number, to: number): T[] {
  if (list.length === 0 || from < 0 || from >= list.length) return [...list];
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/** The ids of `current` (the order on screen) after `id` was moved to position `to`; unchanged when `id` is not in the list. */
export function moveAccountTo(current: readonly string[], id: string, to: number): string[] {
  return moveIndex(current, current.indexOf(id), to);
}

/** One step up / down (Alt+Up / Alt+Down, the menu's Move up / Move down). */
export function stepAccount(current: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = current.indexOf(id);
  return i < 0 ? [...current] : moveIndex(current, i, i + dir);
}

/** The saved list without ids that are no accounts any more (a removed account); null when nothing had to go. */
export function pruneOrder(saved: readonly string[], accountIds: readonly string[]): string[] | null {
  const known = new Set(accountIds);
  const kept = saved.filter((id) => known.has(id));
  return kept.length === saved.length ? null : kept;
}

/**
 * Where a dragged entry lands: the pointer's vertical position `y` against the middles of the entries (in the order on screen, the dragged one
 * included). The result is the index the dragged entry ends up at - the number of OTHER entries whose middle is above the pointer.
 */
export function dropIndex(middles: readonly number[], from: number, y: number): number {
  let n = 0;
  middles.forEach((m, i) => {
    if (i !== from && m < y) n++;
  });
  return n;
}

/** How fast (px per frame, negative = up) a list scrolls while an entry is dragged near its top / bottom edge; 0 away from the edges. */
export function autoScrollStep(y: number, top: number, bottom: number, zone = 40, max = 14): number {
  if (y < top + zone) return -Math.ceil((max * Math.min(zone, top + zone - y)) / zone);
  if (y > bottom - zone) return Math.ceil((max * Math.min(zone, y - (bottom - zone))) / zone);
  return 0;
}
