// The side menu (the folder pane): when it is shown in full and when as a narrow column of icons (v1.0.6). Pure, so a script can test it
// (scripts/test-sidebar-state.mjs); the hook that feeds it the window width is useSidebar.ts, the preference is `prefs.sidebar`.
//
// Three states, one global setting:
//   auto       (default) the menu folds to icons by itself in a narrow window and opens again when the window grows
//   expanded   the person opened it: it stays open, as long as the list and the reading pane keep their minimum widths
//   collapsed  the person folded it: it stays folded
// A manual choice always wins over the window width. The one thing it cannot do is squeeze the other panes: when "expanded" does not leave
// them their minimum, the menu is shown as icons and opens over the list instead (the same overlay as the hover peek), and the choice is kept for
// when the window is wide enough again.

export type SidebarMode = "auto" | "expanded" | "collapsed";
export const SIDEBAR_MODES: readonly SidebarMode[] = ["auto", "expanded", "collapsed"];

/** Width of the column of icons (px). */
export const RAIL_W = 56;
/** Width of a splitter between two panes (px); App.css `.workspace` has the same number. */
export const SPLITTER_W = 6;
/**
 * Below this window width "auto" folds the menu. With the default widths (menu 248, list 392, two splitters) the reading pane is left with
 * 448 px at 1100; the smallest window (960) is then served by the icons: 960 - 56 - 392 - 12 = 500 px of reading pane instead of 308.
 */
export const AUTO_COLLAPSE_BELOW = 1100;
/** The reading pane never gets narrower than this because of the menu (px): the message header and its action bar still fit in one line. */
export const MIN_READER_W = 440;

/** Anything stored that is not one of the three counts as "auto". */
export function normalizeSidebar(v: unknown): SidebarMode {
  return v === "expanded" || v === "collapsed" ? v : "auto";
}

export interface SidebarInput {
  mode: SidebarMode;
  /** window width (px) */
  width: number;
  /** width of the open menu (px; the person's own, 180 to 360) */
  folderW: number;
  /** width of the message list (px) */
  listW: number;
  /** the reading pane is below the list: the menu then only shares the width with that one column */
  bottomPane: boolean;
}

/** Whether the open menu leaves the reading pane its minimum width. */
export function sidebarFits(i: Pick<SidebarInput, "width" | "folderW" | "listW" | "bottomPane">): boolean {
  const rest = i.width - i.folderW - SPLITTER_W - (i.bottomPane ? 0 : i.listW + SPLITTER_W);
  return rest >= MIN_READER_W;
}

export interface SidebarLayout {
  /** the column is the icons (the menu may still open over the panes as a peek) */
  collapsed: boolean;
  /** the person wants it open, but there is no room for it next to the other panes */
  squeezed: boolean;
}

export function sidebarLayout(i: SidebarInput): SidebarLayout {
  const fits = sidebarFits(i);
  switch (i.mode) {
    case "collapsed":
      return { collapsed: true, squeezed: false };
    case "expanded":
      return { collapsed: !fits, squeezed: !fits };
    default:
      // auto: the breakpoint is for the usual widths; a wider list or menu than the default folds it earlier
      return { collapsed: i.width < AUTO_COLLAPSE_BELOW || !fits, squeezed: false };
  }
}

/**
 * What the collapse / expand control does. It shows the state of the layout, not of the setting:
 *  - open now: fold it ("collapsed")
 *  - icons now: open it ("expanded"); when that leaves no room, `pin` asks for the overlay to stay open until it is dismissed
 *  - squeezed already (the setting is "expanded"): the setting stays, the overlay is pinned
 */
export function toggleSidebar(i: SidebarInput): { mode: SidebarMode; pin: boolean } {
  const now = sidebarLayout(i);
  if (!now.collapsed) return { mode: "collapsed", pin: false };
  const next: SidebarMode = "expanded";
  return { mode: next, pin: sidebarLayout({ ...i, mode: next }).squeezed };
}
