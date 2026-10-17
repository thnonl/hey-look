// The paragraph formats of the compose editor (spec-rich-text.md REQ-17 .. REQ-21): alignment, indent, line spacing, space after a paragraph, and the
// marker style of a list. One place that knows how each of them is written to the HTML and read back, so the serializer (emailHtml.ts), the editor's
// own parse / render rules (blockExtension.ts) and the tests agree. Pure (no imports, no DOM): a plain Node script tests it
// (scripts/test-block-format.mjs).
//
//   alignment     text-align:center | right | justify     (left is no declaration: it is what a paragraph is)
//   indent        margin-left:40px .. 320px               (steps of 40 px, 8 at most; margin-right in a right-to-left block)
//   line spacing  line-height:1.15 | 1.5 | 2              (1.0 is "single": no declaration, the font's own line height)
//   space after   margin-bottom:10pt                      (a paragraph has none, a heading has 4pt; "Remove space after" writes 0)
//   lists         list-style-type:disc|circle|square, decimal|lower-alpha|upper-alpha|lower-roman|upper-roman (+ type="a" on <ol>)
//   direction     dir="rtl" style="direction:rtl;text-align:right" on a paragraph or heading, dir="rtl" on a list (REQ-43; left-to-right is no declaration)

export type Align = "center" | "right" | "justify";
/** Right-to-left text (REQ-43). Left-to-right is what a block is: no attribute. */
export type Direction = "rtl";
export type SpaceAfter = "add" | "none";

/** The paragraph-level attributes of a paragraph or heading, as the editor's document stores them. */
export interface BlockAttrs {
  /** "left" is only stored in a right-to-left block (there, no declaration means right; in a left-to-right block it is the default and no attribute) */
  textAlign?: Align | "left" | null;
  direction?: Direction | null;
  indent?: number | null;
  lineHeight?: string | null;
  spaceAfter?: SpaceAfter | null;
}

export const INDENT_PX = 40;
export const MAX_INDENT = 8;
/** The menu of Line spacing; 1 is the font's own spacing and is written as no declaration. */
export const LINE_HEIGHTS: readonly number[] = [1, 1.15, 1.5, 2];
/** "Add space after paragraph". */
export const SPACE_AFTER = "10pt";

const PX_PER: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, em: 16, rem: 16 };

/** A CSS length in px (`40px`, `.5in`, `0`, `12pt`); em / rem count 16 px. null for anything else (`auto`, `%`, `calc()`). */
export function lengthPx(value: string | null | undefined): number | null {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*([a-z]*)\s*$/i.exec(value ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === "") return n === 0 ? 0 : null;
  const f = PX_PER[m[2].toLowerCase()];
  return f === undefined ? null : n * f;
}

// ---------------------------------------------------------------- alignment

/** `text-align` -> the attribute: left (and start, the default) is null; anything that is not left, centre, right or justify is null too. */
export function normAlign(value: string | null | undefined): Align | null {
  const v = (value ?? "").trim().toLowerCase().replace(/^-(?:webkit|moz)-/, "");
  return v === "center" || v === "right" || v === "justify" ? v : null;
}

// ---------------------------------------------------------------- direction

/** `dir` / `direction` -> the attribute: "rtl" or nothing (ltr and auto are what a block is without one). */
export function normDirection(value: string | null | undefined): Direction | null {
  return (value ?? "").trim().toLowerCase() === "rtl" ? "rtl" : null;
}

/**
 * The alignment attribute of a block read from its HTML. In a right-to-left block no alignment means right, so a written `text-align:right` is the
 * default again (null); `text-align:left` there is a choice and is kept as "left".
 */
export function alignFromHtml(rtl: boolean, value: string | null | undefined): Align | "left" | null {
  const a = normAlign(value);
  if (!rtl) return a;
  if (a === "right") return null;
  return a ?? ((value ?? "").trim().toLowerCase() === "left" ? "left" : null);
}

/** The alignment a block has on screen: its own, else the side its direction starts on. */
export function effectiveAlign(a: BlockAttrs): Align | "left" {
  const own = a.textAlign === "left" && a.direction === "rtl" ? "left" : normAlign(a.textAlign);
  return own ?? (a.direction === "rtl" ? "right" : "left");
}

// ---------------------------------------------------------------- indent

/** `margin-left` -> indent steps: the nearest multiple of 40 px, 0 .. 8. */
export function indentFromMargin(value: string | null | undefined): number {
  const px = lengthPx(value);
  return px === null ? 0 : Math.min(MAX_INDENT, Math.max(0, Math.round(px / INDENT_PX)));
}

export const clampIndent = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_INDENT, Math.max(0, v)) : 0;
};

// ---------------------------------------------------------------- line spacing

/** A line-height as the attribute stores it: a number as text ("1.5"); null for "single" (1), `normal`, a length, or a value out of 0.8 .. 4. */
export function normLineHeight(value: string | number | null | undefined): string | null {
  const s = String(value ?? "").trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?|\.\d+)(%?)$/.exec(s);
  if (!m) return null;
  const n = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  if (!(n >= 0.8 && n <= 4)) return null;
  const r = Math.round(n * 100) / 100;
  return r === 1 ? null : String(r);
}

// ---------------------------------------------------------------- space after

/**
 * `margin-bottom` -> the attribute. A paragraph has no space after, so anything under 6pt is "nothing set"; a heading has 4pt, so 3 .. 5pt is
 * "nothing set" and about zero is "none". Anything from 6pt up is "add" (10pt).
 */
export function spaceAfterFromMargin(value: string | null | undefined, heading: boolean): SpaceAfter | null {
  const px = lengthPx(value);
  if (px === null) return null;
  const pt = px * 0.75;
  if (pt >= 6) return "add";
  return heading && pt < 0.5 ? "none" : null;
}

// ---------------------------------------------------------------- the style of a block

/** The tail of a block's style: direction, alignment and line spacing. A right-to-left block always says where it is aligned (a client without `dir` support still shows it right). */
export function tailCss(a: BlockAttrs): string {
  const out: string[] = [];
  const rtl = a.direction === "rtl";
  if (rtl) out.push("direction:rtl");
  const align = rtl ? effectiveAlign(a) : normAlign(a.textAlign);
  if (align && (rtl || align !== "left")) out.push(`text-align:${align}`);
  const lh = normLineHeight(a.lineHeight);
  if (lh) out.push(`line-height:${lh}`);
  return out.length ? ";" + out.join(";") : "";
}

/**
 * The `margin` of a block: `top` and `bottom` are the block's own (a paragraph 0 and 0, a heading 12pt and 4pt); the indent is the left margin and
 * "add / none" replace the bottom one. Written as one declaration, 1 .. 4 values.
 */
/** The `dir` attribute of a block (with its leading blank), or nothing. */
export const dirAttr = (a: { direction?: Direction | null }): string => (a.direction === "rtl" ? ' dir="rtl"' : "");

export function marginCss(top: string, bottom: string, a: BlockAttrs): string {
  const after = a.spaceAfter === "add" ? SPACE_AFTER : a.spaceAfter === "none" ? "0" : bottom;
  const start = clampIndent(a.indent) * INDENT_PX;
  // (the indent is on the side the text starts on: the right of a right-to-left block)
  if (start) return a.direction === "rtl" ? `margin:${top} ${start}px ${after} 0` : `margin:${top} 0 ${after} ${start}px`;
  return top === "0" && after === "0" ? "margin:0" : `margin:${top} 0 ${after}`;
}

// ---------------------------------------------------------------- lists

export const BULLET_STYLES: readonly string[] = ["disc", "circle", "square"];
export const NUMBER_STYLES: readonly string[] = ["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"];
/** The `type` attribute of <ol> for each numbering. */
const OL_TYPE: Record<string, string> = { decimal: "1", "lower-alpha": "a", "upper-alpha": "A", "lower-roman": "i", "upper-roman": "I" };
const ALIAS: Record<string, string> = { "lower-latin": "lower-alpha", "upper-latin": "upper-alpha", a: "lower-alpha", A: "upper-alpha", i: "lower-roman", I: "upper-roman", "1": "decimal" };
/** A new nesting level cycles: filled circle, hollow circle, filled square; 1. a. i. */
const BULLET_CYCLE = ["disc", "circle", "square"];
const NUMBER_CYCLE = ["decimal", "lower-alpha", "lower-roman"];

/** The marker a list has at this nesting level when its style is not set. */
export function defaultListStyle(ordered: boolean, depth: number): string {
  const cycle = ordered ? NUMBER_CYCLE : BULLET_CYCLE;
  return cycle[Math.max(0, depth) % cycle.length];
}

/** A list style value (`lower-alpha`, `lower-latin`, a type letter) in its canonical name for this kind of list, or null when it is none of them. */
export function normListStyle(ordered: boolean, value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  const v = ALIAS[raw] ?? ALIAS[raw.toLowerCase()] ?? raw.toLowerCase();
  return (ordered ? NUMBER_STYLES : BULLET_STYLES).includes(v) ? v : null;
}

/** The style a list is stored with: its own, and null when it is the one the nesting level gives anyway (so moving the list changes the marker, as in Word). */
export function listStyleFromHtml(ordered: boolean, cssValue: string | null | undefined, typeAttr: string | null | undefined, depth: number): string | null {
  const s = normListStyle(ordered, cssValue) ?? (ordered ? normListStyle(true, typeAttr) : null);
  return s && s !== defaultListStyle(ordered, depth) ? s : null;
}

/** The `type` attribute an <ol> gets for a numbering; "1" (and so no attribute) for decimal. */
export const olType = (style: string): string => OL_TYPE[style] ?? "1";
