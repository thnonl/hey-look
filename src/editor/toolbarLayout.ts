// Which controls of the formatting toolbar fit in the width there is (spec-rich-text.md REQ-10): one row that never wraps, what does not fit
// goes into the "More formatting options" menu, the least important first. Pure (no imports): a plain Node script tests it
// (scripts/test-format-bar-layout.mjs). The widths are the ones the CSS draws (App.css `.fmt-bar`).

export interface LayoutItem {
  id: string;
  /** controls of one group sit together; a separator is drawn between two groups */
  group: string;
  /** place in the bar, left to right */
  order: number;
  /** how long the control stays in the bar when it gets narrow: the smaller, the longer */
  priority: number;
  /** its width in px */
  width: number;
}

/** the space between two items, the width of a separator, the width of the More button (px) */
export const GAP = 1;
export const SEP = 5;
export const MORE_W = 28;

/** The width of these items in the bar plus the More button. */
export function barWidth(items: LayoutItem[]): number {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  let w = MORE_W;
  let n = 1; // flex children: the items, the separators and More
  sorted.forEach((it, i) => {
    w += it.width;
    n++;
    if (i > 0 && sorted[i - 1].group !== it.group) {
      w += SEP;
      n++;
    }
  });
  return w + GAP * (n - 1);
}

/**
 * The items that stay in the bar (in bar order) and the ones that move to More (the most important first, which is the order the menu
 * lists them in). Items are kept by priority, and the first that does not fit ends it: a less important control never stays when a more
 * important one had to go.
 */
export function layoutBar(items: LayoutItem[], avail: number): { visible: string[]; hidden: string[] } {
  const byPriority = [...items].sort((a, b) => a.priority - b.priority || a.order - b.order);
  let k = 0;
  while (k < byPriority.length && barWidth(byPriority.slice(0, k + 1)) <= avail) k++;
  const keep = byPriority.slice(0, k);
  return {
    visible: [...keep].sort((a, b) => a.order - b.order).map((i) => i.id),
    hidden: byPriority.slice(k).map((i) => i.id),
  };
}

/** Where each control sits and how long it stays: the numbers of the toolbar, in one place that a script can read (controls.tsx draws the controls). */
export type Variant = "compose" | "compact";
export interface BarMeta {
  group: string;
  order: number;
  priority: number;
  width: number;
  variants: readonly Variant[];
}
const BOTH: readonly Variant[] = ["compose", "compact"];
/**
 * Priority = the place in the list of spec-rich-text.md 4.1 (x10): B I U, Bulleted, Numbered, Link, Picture, Font color, Highlight, Font, Size,
 * Styles, Align, Increase / Decrease indent, Strikethrough, Table, Insert, Clear formatting, Undo, Redo. Order = left to right. A later package
 * adds its controls here with the numbers of that list.
 */
export const BAR_META: Record<string, BarMeta> = {
  // the clipboard group: Hey Look! has no Paste / Cut / Copy buttons, so it holds the format painter only (W3.1; priority 185: after Insert, before Clear formatting)
  painter: { group: "clipboard", order: 10, priority: 185, width: 28, variants: BOTH },
  undo: { group: "history", order: 1, priority: 200, width: 28, variants: BOTH },
  redo: { group: "history", order: 2, priority: 210, width: 28, variants: BOTH },
  font: { group: "font", order: 20, priority: 110, width: 120, variants: BOTH },
  size: { group: "font", order: 21, priority: 120, width: 52, variants: BOTH },
  bold: { group: "style", order: 30, priority: 10, width: 28, variants: BOTH },
  italic: { group: "style", order: 31, priority: 20, width: 28, variants: BOTH },
  underline: { group: "style", order: 32, priority: 30, width: 28, variants: BOTH },
  strike: { group: "style", order: 33, priority: 160, width: 28, variants: BOTH },
  fontColor: { group: "colors", order: 40, priority: 80, width: 43, variants: BOTH },
  highlight: { group: "colors", order: 41, priority: 90, width: 43, variants: BOTH },
  // the list buttons are split buttons (the button and the arrow of its marker styles), narrow enough for the 360 px pane (AC-17)
  bulleted: { group: "lists", order: 50, priority: 40, width: 37, variants: BOTH },
  numbered: { group: "lists", order: 51, priority: 50, width: 37, variants: BOTH },
  indentLess: { group: "lists", order: 52, priority: 155, width: 28, variants: BOTH },
  indentMore: { group: "lists", order: 53, priority: 150, width: 28, variants: BOTH },
  align: { group: "align", order: 60, priority: 140, width: 40, variants: BOTH },
  styles: { group: "styles", order: 65, priority: 130, width: 108, variants: BOTH },
  link: { group: "insert", order: 70, priority: 60, width: 28, variants: BOTH },
  picture: { group: "insert", order: 71, priority: 70, width: 28, variants: BOTH },
  table: { group: "insert", order: 72, priority: 170, width: 40, variants: BOTH },
  insert: { group: "insert", order: 73, priority: 180, width: 40, variants: BOTH },
  clear: { group: "clear", order: 90, priority: 190, width: 28, variants: BOTH },
};
