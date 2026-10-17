// How much room the compose pane has, and what the header of it does about that (App.css `.compose-pane.compact`, Compose.tsx).
// The pane is the right column of the main window (308 px wide and 388 px high at the minimum window of 960 x 560) or a window of its own
// (560 x 440 at the least), so it is measured, not the window: a pane of 600 px or more and 480 px or more keeps the labelled buttons in rows;
// a smaller one (a narrow column, a low window) shows Send, Discard and Attach (Send with its name, the others as icons) and moves every other action to "More actions".

/** Below this many px of pane width the action row is one row of icons plus "More actions". */
export const COMPACT_WIDTH = 600;
/** Below this many px of pane height the same (a wide but low pane cannot afford rows of labelled buttons either). */
export const COMPACT_HEIGHT = 480;
/** The message body is never smaller than this (px, padding included): the header above it and the attachments under it give way first. */
export const BODY_MIN = 180;

export function isCompact(width: number, height: number): boolean {
  return width < COMPACT_WIDTH || height < COMPACT_HEIGHT;
}
/** A row of the compact action bar is at most this high (px); a taller bar has wrapped into a second row. */
export const BAR_ROW_MAX = 52;
