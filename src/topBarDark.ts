/**
 * Dark-theme top bar: the primary colour as a DARK tint (the light theme shows it as the bar itself, see topBar() in prefs.ts).
 *
 * Only the HUE of the primary is used, at a fixed dark lightness and a small, capped chroma (OKLCH), so the bar can never get
 * light however light the chosen colour is, and white text/icons keep >= 7:1 on it. Chroma follows the primary's own chroma:
 * a near-grey primary (white, black, mid-grey) therefore gives the neutral dark bar, a vivid one gives the full tint.
 *
 *   L(start) = 0.255, L(end) = 0.31                      (the old neutral bar was #25272d -> #2d3038, L 0.27 -> 0.31)
 *   C        = 0.06 * min(1, C(primary) / 0.08)           (hue h(primary))
 *   then C is reduced until both ends are inside sRGB and their relative luminance is <= DARK_TOP_MAX_LUM
 *
 * Published by applyPrefs (store.ts) as --top-dk-start / --top-dk-end; App.css builds the gradient from them (dark blocks only).
 * Pure: no DOM, no imports (scripts/test-top-bar-dark.mjs runs it under node).
 */
export const DARK_TOP_MAX_LUM = 0.06;
const L_START = 0.255, L_END = 0.31, C_MAX = 0.06, C_FULL = 0.08;

const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const enc = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));

/** #rrggbb -> OKLCH chroma and hue (radians). */
function oklch(hex: string): { c: number; h: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

/** OKLCH -> linear sRGB (unclamped). */
function linear(L: number, c: number, h: number): number[] {
  const a = c * Math.cos(h), b = c * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const lum = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const fits = (rgb: number[]) => rgb.every((v) => v >= 0 && v <= 1);
const hexOf = (rgb: number[]) => `#${rgb.map((v) => enc(Math.min(1, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

export interface DarkTopBar { start: string; end: string }
/** The dark top bar for a primary colour (#rrggbb): the two ends of its 135deg gradient (--top-dk-start / --top-dk-end in App.css). */
export function darkTopBar(primary: string): DarkTopBar {
  const p = oklch(primary);
  let c = C_MAX * Math.min(1, p.c / C_FULL);
  let s = linear(L_START, c, p.h), e = linear(L_END, c, p.h);
  for (let i = 0; i < 40 && c > 0 && !(fits(s) && fits(e) && lum(s) <= DARK_TOP_MAX_LUM && lum(e) <= DARK_TOP_MAX_LUM); i++) {
    c *= 0.9; s = linear(L_START, c, p.h); e = linear(L_END, c, p.h);
  }
  const start = hexOf(s), end = hexOf(e);
  return { start, end };
}
