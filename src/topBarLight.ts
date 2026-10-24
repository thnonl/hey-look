/**
 * Light-theme top bar: the primary colour as the bar itself (the dark theme tints it, see topBarDark.ts), and the colour maths it needs. Pure - no imports of the
 * app - so scripts/test-top-bar-contrast.mjs runs it as it is. prefs.ts re-exports `buttonAccent` and `topBar`; `luminance`, `blend` and `ratio` are also what
 * `accentText` and `readableOn` there are made of.
 */

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
const rgbOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hexOf = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** `a` blended `t` (0..1) of the way towards `b`. */
export const blend = (a: string, b: string, t: number) => { const x = rgbOf(a), y = rgbOf(b); return hexOf(x.map((v, i) => v * (1 - t) + y[i] * t)); };
/** WCAG contrast ratio of two #rrggbb colours. */
export const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** Darkens an accent just enough that its button label (white or near-black) reaches 4.5:1; colours that already pass are returned unchanged. */
export function buttonAccent(hex: string): string {
  const best = (c: string) => Math.max(ratio(c, "#ffffff"), ratio(c, "#0b1220"));
  for (let t = 0; t <= 0.5; t += 0.01) {
    const c = blend(hex, "#000000", t);
    if (best(c) >= 4.5) return c;
  }
  return hex;
}
export interface TopBarColors { bg: string; fg: string; field: string; fieldHover: string; hover: string }
/**
 * Light-theme top bar: gradient from the accent (22% darker) to the accent, with text/icon colour and search-field tint chosen so
 * everything on it reads at >= 4.5:1 at BOTH gradient ends. White text on accents that allow it, near-black on light accents,
 * otherwise the gradient is darkened until white works.
 */
export function topBar(accent: string): TopBarColors {
  const { s, e, fg, field, fieldHover, hover } = topBarParts(accent);
  return { bg: `linear-gradient(135deg, ${s} 0%, ${e} 100%)`, fg, field, fieldHover, hover };
}

/** The two ends of the light bar's gradient (`start` is the left/top end, `end` the right end: behind the window's caption buttons) and the text colour on it. */
export function topBarEnds(accent: string): { start: string; end: string; fg: string } {
  const { s, e, fg } = topBarParts(accent);
  return { start: s, end: e, fg };
}

function topBarParts(accent: string): { s: string; e: string; fg: string; field: string; fieldHover: string; hover: string } {
  const WHITE = "#ffffff", INK = "#0b1220";
  let s = blend(accent, "#000000", 0.22), e = accent;
  if (ratio(WHITE, e) < 4.5 && ratio(INK, s) >= 4.5) {
    return { s, e, fg: INK, field: "rgba(255,255,255,.35)", fieldHover: "rgba(255,255,255,.5)", hover: "rgba(0,0,0,.12)" };
  }
  for (let k = 0; ratio(WHITE, e) < 4.5 && k < 1; k += 0.02) { s = blend(accent, "#000000", 0.22 + k); e = blend(accent, "#000000", k); }
  return { s, e, fg: WHITE, field: "rgba(0,0,0,.2)", fieldHover: "rgba(0,0,0,.3)", hover: "rgba(255,255,255,.18)" };
}
