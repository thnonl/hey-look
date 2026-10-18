// The box a blocked remote picture is drawn as (W1.13 b, 1.0.7). Without consent the reading pane removes the picture's address; the bare <img> was drawn as a tiny or empty
// box that was easy to miss (and differently by each engine). Now it is a box of the size the mail gave it, with an icon and the picture's alt text (ReadingPane.tsx
// `pictureHtml`). Pure, so scripts/test-blocked-picture.mjs runs it as it is.

/** The side of the box when the mail gives no size (px). */
export const BLOCKED_PICTURE_SIDE = 48;
/** A picture declared this small or smaller (px) in width or height is a tracking pixel: it is not drawn at all. */
export const TRACKING_PIXEL_MAX = 2;

export type BlockedBox = { hidden: true } | { hidden: false; width: string; height: string };

type Size = { px: number } | { pct: number } | null;

/** "600", "600px", "12.5", "50%" -> a size; anything else (auto, em, calc ...) -> null. */
function parseSize(v: string | null | undefined): Size {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px|%)?\s*$/i.exec(v ?? "");
  if (!m) return null;
  return m[2] === "%" ? { pct: Number(m[1]) } : { px: Number(m[1]) };
}

/** `width` / `height` declared in an inline style (the last declaration wins, as in CSS). */
function fromStyle(style: string | null | undefined, prop: "width" | "height"): string | null {
  let found: string | null = null;
  for (const decl of (style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0 && decl.slice(0, i).trim().toLowerCase() === prop) found = decl.slice(i + 1).replace(/!important/i, "");
  }
  return found;
}

/**
 * The box for a blocked picture from its own `width` / `height` attributes and inline style (the style wins, as it does for a picture): the size the mail gave it, 48 px
 * for a side it did not give, and hidden when a side is 2 px or less. The box is capped at the width of the frame by the page's CSS (`max-width: 100%`).
 */
export function blockedPictureBox(a: { width?: string | null; height?: string | null; style?: string | null }): BlockedBox {
  const w = parseSize(fromStyle(a.style, "width")) ?? parseSize(a.width);
  const h = parseSize(fromStyle(a.style, "height")) ?? parseSize(a.height);
  if ((w && "px" in w && w.px <= TRACKING_PIXEL_MAX) || (h && "px" in h && h.px <= TRACKING_PIXEL_MAX)) return { hidden: true };
  const side = `${BLOCKED_PICTURE_SIDE}px`;
  return {
    hidden: false,
    width: w ? ("px" in w ? `${w.px}px` : `${w.pct}%`) : side,
    height: h && "px" in h ? `${h.px}px` : side, // (a height in percent has no frame to refer to)
  };
}
