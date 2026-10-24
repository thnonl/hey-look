// How far down a popover or a menu may reach. The window's bottom edge is not the limit while a toast is on show under it: the toast stack is fixed at the bottom
// of the window, above everything in the page, so a popover that ran down to the edge had its footer (the Schedule button of Send later) behind a toast
// (v1.0.6 QA round 2, BUG-A1-4). Pure geometry; the placement code is in components/ui.tsx.

/** The box of the toast stack: only what the popover is compared with. */
export interface ToastBox {
  left: number;
  right: number;
  top: number;
}

/**
 * The lowest y a popover that spans `popLeft`..`popRight` may reach: `vh - edge`, or just above the toast stack when the stack is under it
 * (sideways overlap). `gap`: the space kept between the two.
 */
export function popoverFloor(vh: number, edge: number, popLeft: number, popRight: number, toasts: ToastBox | null, gap = 8): number {
  const bottom = vh - edge;
  if (!toasts || toasts.right <= popLeft || toasts.left >= popRight) return bottom;
  return Math.min(bottom, toasts.top - gap);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Where a popover or menu that hangs on a button goes (v1.0.6 QA round 3, BUG-R3-1). One rule for all of them (the menus, the Send later popover, the
// colour / emoji / symbol panels, the date and time panels of a field, the link popover, the alt text popover):
//   (a) its place comes from the button (left edge, or right edge for `align: "right"`), kept inside the window sideways;
//   (b) its height is never more than the room it is given (`max`: the popover scrolls inside, it is never cut off and never runs past the window or a toast);
//   (c) it opens below the button, above it when it does not fit below and there is more room above;
//   (d) the lowest y it may reach is `popoverFloor` (the toast stack is above everything in the page).
// The layers (the picture toolbar and handles under it, the dialogs under the menus, the confirm questions and toasts over them) are in App.css (--z-*).

export interface PlaceBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Placed {
  /** `top` / `left` in px of the window (position: fixed) */
  top: number;
  left: number;
  /** the height it may have: set it as max-height, the popover scrolls inside when it is taller */
  max: number;
  /** it opens above the button */
  up: boolean;
}

export interface PlaceOptions {
  edge?: number;
  gap?: number;
  inset?: number;
  /** "left" / "right": the edge of the anchor the popover is lined up with; "center": centred on the anchor (the mini toolbar) */
  align?: "left" | "right" | "center";
  toasts?: ToastBox | null;
  minRoom?: number;
  /** with `cover: false`: which side is tried first (default below) */
  prefer?: "above" | "below";
  /** `false`: the popover never overlaps the anchor box: it goes where it fits in full, else `null` (a selection that fills the room has no place for a toolbar) */
  cover?: boolean;
}

/**
 * `anchor`: the button; `size`: the popover as it is when nothing limits it (width and full height); `win`: the window. `edge`: space kept to the window,
 * `gap`: to the button; `inset`: px from the button's left; `minRoom`: the least room it is given (a window that is lower than this is not worth a
 * popover of 40 px). `cover: false` (the mini toolbar over a selection): the popover is centred on the anchor with `align: "center"`, goes on the `prefer` side
 * (above by default there) when it fits there in full, else on the other side, else the answer is null; it is never made smaller and never overlaps the anchor.
 */
export function placePopover(anchor: PlaceBox, size: { w: number; h: number }, win: { w: number; h: number }, o: PlaceOptions & { cover: false }): Placed | null;
export function placePopover(anchor: PlaceBox, size: { w: number; h: number }, win: { w: number; h: number }, o?: PlaceOptions): Placed;
export function placePopover(anchor: PlaceBox, size: { w: number; h: number }, win: { w: number; h: number }, o: PlaceOptions = {}): Placed | null {
  const { edge = 8, gap = 4, inset = 0, align = "left", toasts = null, minRoom = 0, prefer = "below", cover = true } = o;
  const want = align === "right" ? anchor.right - size.w : align === "center" ? (anchor.left + anchor.right) / 2 - size.w / 2 : anchor.left + inset;
  const left = Math.max(edge, Math.min(want, win.w - size.w - edge));
  const floor = popoverFloor(win.h, edge, left, left + size.w, toasts);
  const below = floor - (anchor.bottom + gap);
  const above = anchor.top - gap - edge;
  if (!cover) {
    const fitsAbove = above >= size.h;
    const fitsBelow = below >= size.h;
    const up = prefer === "above" ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
    if (!(up ? fitsAbove : fitsBelow)) return null;
    return { top: up ? anchor.top - gap - size.h : anchor.bottom + gap, left, max: size.h, up };
  }
  const up = size.h > below && above > below;
  const max = Math.max(up ? above : below, minRoom);
  const h = Math.min(size.h, max);
  const raw = up ? anchor.top - gap - h : anchor.bottom + gap;
  // (inside the window even when the button is scrolled out of it)
  const top = Math.max(edge, Math.min(raw, floor - h));
  return { top, left, max, up };
}
