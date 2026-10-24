// The colours of the compose editor: the Office palette of the font colour menu (theme colours with their tints and shades, standard
// colours), the 15 highlight colours of Word, and the one writing of a colour in the HTML (`#RRGGBB`). Pure (no imports): a plain Node
// script can test it (scripts/test-rich-golden.mjs).

/** A swatch: the colour, the dictionary key of its name and, for a tint or a shade, which one (the label is "{color}, lighter 40%"). */
export interface Swatch {
  hex: string;
  /** `compose.color.<id>` */
  id: string;
  shade?: { kind: "lighter" | "darker"; n: number };
}

/** The base row of the theme colours (spec 4.2), left to right. */
const THEME_BASE: readonly Swatch[] = [
  { hex: "#FFFFFF", id: "white" },
  { hex: "#000000", id: "black" },
  { hex: "#E7E6E6", id: "lightGray" },
  { hex: "#44546A", id: "blueGray" },
  { hex: "#4472C4", id: "blue" },
  { hex: "#ED7D31", id: "orange" },
  { hex: "#A5A5A5", id: "gray" },
  { hex: "#FFC000", id: "gold" },
  { hex: "#5B9BD5", id: "lightBlue" },
  { hex: "#70AD47", id: "green" },
];

/** The ten standard colours (spec 4.2). */
export const STANDARD: readonly Swatch[] = [
  { hex: "#C00000", id: "darkRed" },
  { hex: "#FF0000", id: "red" },
  { hex: "#FFC000", id: "orange" },
  { hex: "#FFFF00", id: "yellow" },
  { hex: "#92D050", id: "lightGreen" },
  { hex: "#00B050", id: "green" },
  { hex: "#00B0F0", id: "lightBlue" },
  { hex: "#0070C0", id: "blue" },
  { hex: "#002060", id: "darkBlue" },
  { hex: "#7030A0", id: "purple" },
];

/** The 15 highlight colours of Word, in the order of its menu. */
export const HIGHLIGHTS: readonly Swatch[] = [
  { hex: "#FFFF00", id: "yellow" },
  { hex: "#00FF00", id: "brightGreen" },
  { hex: "#00FFFF", id: "turquoise" },
  { hex: "#FF00FF", id: "pink" },
  { hex: "#0000FF", id: "blue" },
  { hex: "#FF0000", id: "red" },
  { hex: "#000080", id: "darkBlue" },
  { hex: "#008080", id: "teal" },
  { hex: "#008000", id: "green" },
  { hex: "#800080", id: "violet" },
  { hex: "#800000", id: "darkRed" },
  { hex: "#808000", id: "darkYellow" },
  { hex: "#808080", id: "gray50" },
  { hex: "#C0C0C0", id: "gray25" },
  { hex: "#000000", id: "black" },
];

/** What the Font color button applies before a colour was ever used (spec REQ-14, Q-3: Outlook's red). */
export const DEFAULT_FONT_COLOR = "#FF0000";
/** What the Highlight button applies before a colour was ever used. */
export const DEFAULT_HIGHLIGHT = "#FFFF00";
/** How many recent colours are remembered. */
export const MAX_RECENT = 10;

type RGB = [number, number, number];

const h2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0").toUpperCase();
export const rgbHex = ([r, g, b]: RGB): string => `#${h2(r)}${h2(g)}${h2(b)}`;

/** `#abc`, `#aabbcc`, `rgb(1, 2, 3)` (also `rgba`, space syntax) -> [r, g, b]; null for anything else (names, hsl(), var()). */
export function parseRgb(value: string | null | undefined): RGB | null {
  const v = (value ?? "").trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)) as RGB;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  m = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** The one writing of a colour in the HTML: `#RRGGBB` for a number colour, a lower-case colour name as it is, "" for nothing else (nothing that is not a plain colour is ever written to a `style`). */
export function normColor(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  const rgb = parseRgb(v);
  if (rgb) return rgbHex(rgb);
  return /^[a-z]{3,20}$/i.test(v) ? v.toLowerCase() : "";
}

/** The same colour for comparing (swatch ring, "is this the current colour"). */
export const sameColor = (a: string | null | undefined, b: string | null | undefined): boolean => normColor(a) !== "" && normColor(a) === normColor(b);

// HSL, as Word does its tints: a lighter n% colour is lumMod (100-n)% + lumOff n%, a darker n% one lumMod (100-n)%.
function toHsl([r, g, b]: RGB): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** A tint (`lighter`) or a shade (`darker`) of a colour, `n` percent. */
export function shadeOf(hex: string, kind: "lighter" | "darker", n: number): string {
  const rgb = parseRgb(hex);
  if (!rgb) return hex;
  const [h, s, l] = toHsl(rgb);
  const nl = kind === "lighter" ? l * (1 - n / 100) + n / 100 : l * (1 - n / 100);
  return rgbHex(fromHsl([h, s, nl]));
}

// Word's own first two columns: white and black have no tint of their own colour, they step through greys
const WHITE_COLUMN: readonly [string, number][] = [["#F2F2F2", 5], ["#D9D9D9", 15], ["#BFBFBF", 25], ["#A6A6A6", 35], ["#808080", 50]];
const BLACK_COLUMN: readonly [string, number][] = [["#7F7F7F", 50], ["#595959", 35], ["#404040", 25], ["#262626", 15], ["#0D0D0D", 5]];
const TINTS: readonly ["lighter" | "darker", number][] = [["lighter", 80], ["lighter", 60], ["lighter", 40], ["darker", 25], ["darker", 50]];

/** The 6 rows of the theme grid, 10 swatches each: row 0 the base colours, rows 1-5 their tints and shades. */
export function themeGrid(): Swatch[][] {
  const rows: Swatch[][] = [THEME_BASE.map((s) => ({ ...s }))];
  for (let r = 0; r < 5; r++) {
    rows.push(
      THEME_BASE.map((base, c) => {
        if (c === 0) return { hex: WHITE_COLUMN[r][0], id: base.id, shade: { kind: "darker" as const, n: WHITE_COLUMN[r][1] } };
        if (c === 1) return { hex: BLACK_COLUMN[r][0], id: base.id, shade: { kind: "lighter" as const, n: BLACK_COLUMN[r][1] } };
        const [kind, n] = TINTS[r];
        return { hex: shadeOf(base.hex, kind, n), id: base.id, shade: { kind, n } };
      }),
    );
  }
  return rows;
}

/** The recent colours after `hex` was used: it moves to the front, no colour twice, at most MAX_RECENT. */
export function pushRecent(recent: readonly string[], hex: string): string[] {
  const c = normColor(hex);
  if (!c || !parseRgb(c)) return [...recent].slice(0, MAX_RECENT);
  return [c, ...recent.filter((x) => normColor(x) !== c)].slice(0, MAX_RECENT);
}
