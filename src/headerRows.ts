// Where the scrolled header of the compose pane comes to rest (1.0.7 D-012, D-003, D-018).
//
// In a low window the header (actions, From / To / Cc / Subject, the meeting strip) is a box that scrolls under a sticky action row. A focus scrolls the field into the part
// that shows, and the browser stops wherever the field just fits: the row above it ends up CUT by the action row (QA: "To scrolls above the header box", "the When row is half
// under the Send row"). Nothing is wrong with that scroll - at 960 x 480 the box shows 77 px, a field is 29 - but a row that is half in sight reads as broken. This chooses the
// position the focus scroll should have ended on: the nearest one that keeps the focused control whole and cuts no row at the top of the part that shows.

/** The top and bottom of something in the header, in px from the start of the scrolled content. */
export interface Span {
  top: number;
  bottom: number;
}

export interface SettleInput {
  /** the scroll position now */
  s: number;
  /** the largest scroll position of the box */
  max: number;
  /** the height of the box */
  view: number;
  /** the height of the action row that sticks to the top of the box and covers the content under it (0 when it scrolls away with the rest) */
  bar: number;
  /** the rows of the header (fields, strips, notes): none contains another */
  rows: Span[];
  /** the control that has the focus */
  focus: Span;
}

const TOL = 0.75;

/** A row that the top of the visible part passes through: its upper part is hidden, its lower part is not. */
function cutAt(top: number, rows: Span[]): Span | null {
  return rows.find((r) => r.top < top - TOL && r.bottom > top + TOL) ?? null;
}

/**
 * The scroll position the header should rest on. `s` when no row is cut at the top of the part that shows (or when no position keeps the focused control whole); else "the cut row
 * whole" (scrolled up to its top) when the focused control is still whole then, else "the cut row gone" (scrolled down to its bottom).
 */
export function settledScroll(o: SettleInput): number {
  const cut = cutAt(o.s + o.bar, o.rows);
  if (!cut) return o.s;
  const fits = (s: number) => s >= 0 && s <= o.max + TOL && o.focus.top >= s + o.bar - TOL && o.focus.bottom <= s + o.view + TOL && !cutAt(s + o.bar, o.rows);
  const up = Math.max(0, Math.round(cut.top - o.bar));
  const down = Math.min(o.max, Math.round(cut.bottom - o.bar));
  // the cut row whole is the better of the two: more of the header stays in sight, and no field is lost from it; the row gone only when the control would not be whole with it
  return [up, down].find(fits) ?? o.s;
}

/** The rows of the header, as the page draws them: every field, link row, note and strip row, but not a box that holds others (the meeting strip is its When row and its Where row). */
export const HEADER_ROWS = ".cp-fields > .cf-field, .cp-fields > .cf-links, .cp-fields > .note, .cp-event > .when, .cp-event > input, .cp-head > .note, .cp-head > .sec-strip";

/** Measure the header box and rest it (see `settledScroll`); `focus` is the control that has the focus. Returns the scroll it was set to, null when nothing was changed. */
export function settleHeader(head: HTMLElement, focus: Element): number | null {
  const box = head.getBoundingClientRect();
  const bar = head.querySelector<HTMLElement>(":scope > .cp-bar");
  const sticky = !!bar && getComputedStyle(bar).position === "sticky";
  const span = (el: Element): Span => {
    const r = el.getBoundingClientRect();
    return { top: r.top - box.top + head.scrollTop, bottom: r.bottom - box.top + head.scrollTop };
  };
  const rows = [...head.querySelectorAll<HTMLElement>(HEADER_ROWS)].filter((e) => e.getBoundingClientRect().height > 0).map(span);
  const s = head.scrollTop;
  // (a row of the header holds the control: the whole row is what has to be in sight, the field of a row is what the browser scrolled to)
  const next = settledScroll({ s, max: head.scrollHeight - head.clientHeight, view: head.clientHeight, bar: sticky && bar ? bar.getBoundingClientRect().height : 0, rows, focus: span(focus) });
  if (Math.abs(next - s) < 0.5) return null;
  head.scrollTop = next;
  return next;
}
