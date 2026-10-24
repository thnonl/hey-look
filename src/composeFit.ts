// How much room the compose pane has, and what the header of it does about that (App.css `.compose-pane.compact`, Compose.tsx).
// The pane is the right column of the main window (308 px wide and 388 px high at the minimum window of 960 x 560) or a window of its own
// (560 x 440 at the least), so it is measured, not the window: a pane of 600 px or more and 480 px or more keeps the labelled buttons in rows;
// a smaller one (a narrow column, a low window) shows Send, Discard and Attach (Send with its name, the others as icons) and moves every other action to "More actions".

/** Below this many px of pane width the action row is one row of icons plus "More actions". */
const COMPACT_WIDTH = 600;
/** Below this many px of pane height the same (a wide but low pane cannot afford rows of labelled buttons either). */
const COMPACT_HEIGHT = 480;
/** The message body is never smaller than this (px, padding included): the header above it and the attachments under it give way first. */
export const BODY_MIN = 180;
/** ... with a meeting on (App.css `.compose-pane.has-meeting`): the strip's two rows go to the header, the body gives up 60 px for them in a low window (D-012). */
export const BODY_MIN_MEETING = 120;

export function isCompact(width: number, height: number): boolean {
  return width < COMPACT_WIDTH || height < COMPACT_HEIGHT;
}
/** A row of the compact action bar is at most this high (px); a taller bar has wrapped into a second row. */
export const BAR_ROW_MAX = 52;

// ---- the labelled action row is ONE row in every language (W1.7, 1.0.7) ----
// The row of a pane of 600 x 480 px or more used to wrap (`flex-wrap`): with the long words of German or Russian the Importance pair ended up alone on a second row.
// Now what does not fit moves into "More actions", from the end: first Write with AI, then Templates, Save draft, Importance, Confidential, Sign, Encrypt, Meeting, Picture.
// Send, Discard, Attach (and Move to drafts of a scheduled message) and the pop-out button never move.

/** The movable items of the labelled row, in the order of the row (the first is the last to go into "More actions"). Save draft is not there for a scheduled message. */
export type BarItem = "picture" | "meeting" | "encrypt" | "sign" | "confidential" | "importance" | "saveDraft" | "templates" | "ai";
export const BAR_ITEMS: readonly BarItem[] = ["picture", "meeting", "encrypt", "sign", "confidential", "importance", "saveDraft", "templates", "ai"];

/** The gap between two items of the row (px; App.css `.cp-bar`). */
const BAR_GAP = 2;

/**
 * How many of the movable items go into "More actions" (from the end). `fixed`: the width of what never moves (each item with its margins), `movable`: the natural
 * widths of the movable items in row order, `more`: the width of the "More actions" button, `available`: the room of the row (px, padding taken off). 0 = everything fits
 * and there is no "More actions"; otherwise the fewest that leave room for the rest and the button; at most all of them.
 */
export function overflowCount(o: { available: number; fixed: readonly number[]; movable: readonly number[]; more: number; gap?: number }): number {
  const gap = o.gap ?? BAR_GAP;
  if (!(o.available > 0)) return 0; // not measured (a hidden pane): leave the row as it is
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  const width = (kept: number, withMore: boolean) => {
    const items = o.fixed.length + kept + (withMore ? 1 : 0);
    return sum(o.fixed) + sum(o.movable.slice(0, kept)) + (withMore ? o.more : 0) + gap * Math.max(0, items - 1);
  };
  const n = o.movable.length;
  if (width(n, false) <= o.available) return 0;
  for (let moved = 1; moved < n; moved++) if (width(n - moved, true) <= o.available) return moved;
  return n;
}

/** The items that stay in the row for `moved` of them in "More actions" (the last ones of `order` are the first to go). */
export function keptItems<T>(order: readonly T[], moved: number): T[] {
  return order.slice(0, Math.max(0, order.length - Math.max(0, moved)));
}
