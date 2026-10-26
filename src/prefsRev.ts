// One-time changes of stored preferences (`prefsRev`), pure so a node test can run them. The rule for the stored copy is `migrate_prefs` in
// src-tauri/src/db.rs (it runs at start-up before the tray is drawn); `mergePrefs` (prefs.ts) applies this one to what it reads, so the dev preview
// and any read before the backend wrote get the same result. Both must agree: scripts/test-prefs-defaults.mjs and `prefs_rev_1_turns_count_other_on_once`.

/** The favorite id of One Inbox (the Inbox of all accounts). It is always in the list (prefs.ts `withOneInbox`). */
const ONE_INBOX = "*|inbox";

/** A favorites list with One Inbox in it: put at index 0 when missing, left where it is when present. */
export function withOneInbox(favorites: string[]): string[] {
  return favorites.includes(ONE_INBOX) ? favorites : [ONE_INBOX, ...favorites];
}

/** The read rule for a stored `favorites`: a list gets One Inbox back (every read, not only once); anything else gives the defaults. */
export function readFavorites(stored: unknown, defaults: string[]): string[] {
  return Array.isArray(stored) ? withOneInbox(stored.filter((f): f is string => typeof f === "string")) : defaults;
}

/** The newest revision. Raise it with a new rule below and in db.rs (and `DEFAULT_PREFS.prefsRev` follows). */
export const PREFS_REV = 2;

/**
 * Applies the changes a stored preferences object has not had yet, in place. Returns true when something changed.
 *   1 (1.0.7): "Count Other (bulk) mail" is on. The whole object is saved on every change, so a stored `false` is almost always untouched, not
 *   chosen; it is switched on once, `prefsRev` is saved with the next save, and the person's own choice is kept from then on.
 *   2 (1.0.10): One Inbox (`*|inbox`) is always in Favorites. It could be taken out with its star before 1.0.10 and there was no way back; a stored
 *   list without it gets it at index 0, once. Nothing else in the list moves.
 */
export function applyPrefsRev(p: Record<string, unknown>): boolean {
  const rev = typeof p.prefsRev === "number" ? p.prefsRev : 0;
  if (rev >= PREFS_REV) return false;
  if (rev < 1) p.countOtherMail = true;
  if (rev < 2 && Array.isArray(p.favorites) && !p.favorites.includes(ONE_INBOX)) p.favorites = withOneInbox(p.favorites as string[]);
  p.prefsRev = PREFS_REV;
  return true;
}
