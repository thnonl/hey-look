// The show / hide rule of a status block that must not flash (1.0.7 RULE-2 of spec-107-wp13e-feedback.md): shown when the work has taken `after` ms (at once for heavy work, which paints the
// status before it starts), and once shown it stays at least `min` ms. Pure; `since` is when the block first showed (0 = not shown), `wantNow` says that the block is wanted on screen right
// now (the work is under way and its `after` is over). Used by openStatus.tsx; scripts/test-open-loading.mjs checks the table.
export interface HoldResult {
  /** the block is on screen */
  show: boolean;
  /** when it first showed, to be passed back (0: not shown) */
  since: number;
  /** while the block is only being held for its minimum: how long until it may go (0: not held) */
  leftMs: number;
}

export function holdState(since: number, wantNow: boolean, min: number, now: number): HoldResult {
  if (wantNow) return { show: true, since: since || now, leftMs: 0 };
  if (since && now - since < min) return { show: true, since, leftMs: min - (now - since) };
  return { show: false, since: 0, leftMs: 0 };
}
