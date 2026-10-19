// One-time changes of stored preferences (`prefsRev`), pure so a node test can run them. The rule for the stored copy is `migrate_prefs` in
// src-tauri/src/db.rs (it runs at start-up before the tray is drawn); `mergePrefs` (prefs.ts) applies this one to what it reads, so the dev preview
// and any read before the backend wrote get the same result. Both must agree: scripts/test-prefs-defaults.mjs and `prefs_rev_1_turns_count_other_on_once`.

/** The newest revision. Raise it with a new rule below and in db.rs (and `DEFAULT_PREFS.prefsRev` follows). */
export const PREFS_REV = 1;

/**
 * Applies the changes a stored preferences object has not had yet, in place. Returns true when something changed.
 *   1 (1.0.7): "Count Other (bulk) mail" is on. The whole object is saved on every change, so a stored `false` is almost always untouched, not
 *   chosen; it is switched on once, `prefsRev` is saved with the next save, and the person's own choice is kept from then on.
 */
export function applyPrefsRev(p: Record<string, unknown>): boolean {
  const rev = typeof p.prefsRev === "number" ? p.prefsRev : 0;
  if (rev >= PREFS_REV) return false;
  if (rev < 1) p.countOtherMail = true;
  p.prefsRev = PREFS_REV;
  return true;
}
