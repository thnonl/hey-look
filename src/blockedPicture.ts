// The box a blocked remote picture is drawn as (W1.13 b, 1.0.7). Without consent the reading pane removes the picture's address; the bare <img> was drawn as a tiny or empty
// box that was easy to miss (and differently by each engine). Now it is a box of the size the mail gave it, with an icon and the picture's alt text (ReadingPane.tsx
// `pictureHtml`). Pure, so scripts/test-blocked-picture.mjs runs it as it is.

/** The side of the box when the mail gives no size (px). */
export const BLOCKED_PICTURE_SIDE = 48;
/** A picture declared this small or smaller (px) in width or height is a tracking pixel: it is not drawn at all. */
export const TRACKING_PIXEL_MAX = 2;

export type BlockedBox = { hidden: true } | { hidden: false; width: string; height: string };

/** How much the box of the reading pane says (1.0.10): the whole text (width 140 px or more and height 84 px or more: icon 32 + two lines 33 + gaps and padding 16; the alt text also needs 100 px, ALT_MIN_HEIGHT), the main line only (96 wide and 56 high: icon 24 + line 17 + gaps and padding 14), or just the icon (BUG-1 of the 1.0.11 RC1 QA: a 120 x 40 box cut the line off). */
export type PictureTier = "full" | "mid" | "small";
export type HiddenPictureBox = { hidden: true } | { hidden: false; width: string; height: string; minHeight: string; tier: PictureTier; maxHeight: string };

/** The alt text is the third line of a full box: it needs this height (px) on top of the others, else it is left out (the name is in the box's label). */
export const ALT_MIN_HEIGHT = 100;

/** The side of the box when the mail gives no width / no height (px), and its smallest height. */
const HIDDEN_PICTURE_WIDTH = 240;
const HIDDEN_PICTURE_MIN_HEIGHT = 96;
const HIDDEN_PICTURE_MAX_HEIGHT = 480;

/**
 * The box of a picture the reading pane hides for privacy (spec ba-v1010-written-to-and-placeholders.md section 6): the size the mail gave (at most 480 px high, the frame's own CSS
 * caps the width), 240 px wide and at least 96 px high when it gave none; nothing for a tracking pixel or a picture the mail hides itself. The tier says how much text fits.
 */
export function hiddenPictureBox(a: { width?: string | null; height?: string | null; style?: string | null; hidden?: boolean }): HiddenPictureBox {
  const base = blockedPictureBox(a);
  if (base.hidden) return base;
  const w = parseSize(fromStyle(a.style, "width")) ?? parseSize(a.width);
  const h = parseSize(fromStyle(a.style, "height")) ?? parseSize(a.height);
  const wPx = w ? ("px" in w ? w.px : null) : HIDDEN_PICTURE_WIDTH; // (a width in percent: a wide box)
  const hPx = h && "px" in h ? h.px : null; // (no height, or one in percent: the minimum, and text for it)
  const width = w ? ("px" in w ? `${w.px}px` : `${w.pct}%`) : `${HIDDEN_PICTURE_WIDTH}px`;
  const height = hPx !== null ? `${Math.min(hPx, HIDDEN_PICTURE_MAX_HEIGHT)}px` : "auto";
  const effW = wPx ?? 600;
  const effH = hPx ?? HIDDEN_PICTURE_MIN_HEIGHT;
  const tier: PictureTier = effW >= 140 && effH >= 84 ? "full" : effW >= 96 && effH >= 56 ? "mid" : "small";
  return { hidden: false, width, height, minHeight: hPx !== null ? "0" : `${HIDDEN_PICTURE_MIN_HEIGHT}px`, maxHeight: `${HIDDEN_PICTURE_MAX_HEIGHT}px`, tier };
}

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
export function blockedPictureBox(a: { width?: string | null; height?: string | null; style?: string | null; hidden?: boolean }): BlockedBox {
  const w = parseSize(fromStyle(a.style, "width")) ?? parseSize(a.width);
  const h = parseSize(fromStyle(a.style, "height")) ?? parseSize(a.height);
  // a picture the mail itself hides (a hidden attribute, display:none, visibility:hidden, opacity:0) is not drawn either
  const hiddenByStyle = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?)\s*(!important\s*)?(;|$)/i.test(a.style ?? "");
  if (a.hidden || hiddenByStyle) return { hidden: true };
  if ((w && "px" in w && w.px <= TRACKING_PIXEL_MAX) || (h && "px" in h && h.px <= TRACKING_PIXEL_MAX)) return { hidden: true };
  const side = `${BLOCKED_PICTURE_SIDE}px`;
  return {
    hidden: false,
    width: w ? ("px" in w ? `${w.px}px` : `${w.pct}%`) : side,
    height: h && "px" in h ? `${h.px}px` : side, // (a height in percent has no frame to refer to)
  };
}

/**
 * A box says only what fits it whole (BUG-1 of the 1.0.11 RC1 QA, twice): the tier from the declared size (hiddenPictureBox) is a first guess from both sides (width AND height); after layout, with the
 * real text of the language and the real font, a full box whose lines do not fit its height becomes the mid box (icon and one line), a mid box whose line is wider than the box becomes the small one
 * (the icon; the tooltip has the line). German, Russian and Vietnamese lines are longer than English ones, and a font may be wider than the one measured with. Returns how many boxes changed.
 */
export function fitHiddenBoxes(doc: Document): number {
  let n = 0;
  const tooTall = (b: HTMLElement) => b.scrollHeight > b.clientHeight + 1;
  const tooWide = (m: HTMLElement | null) => !!m && m.scrollWidth > m.clientWidth + 1;
  doc.querySelectorAll<HTMLElement>('.hl-bpx[data-tier="full"], .hl-bpx[data-tier="mid"]').forEach((b) => {
    const main = b.querySelector<HTMLElement>(".hl-bp-main");
    if (b.getAttribute("data-tier") === "full" && tooTall(b)) {
      b.setAttribute("data-tier", "mid");
      n++;
    }
    if (b.getAttribute("data-tier") === "mid" && (tooWide(main) || tooTall(b))) {
      b.setAttribute("data-tier", "small");
      n++;
    }
  });
  return n;
}
