// The fonts and sizes of the compose editor (spec-rich-text.md 2.4) and the one way a font stack is written, so a stack that goes into the
// editor, into the sent HTML and back out of a draft is always the same string. Pure (no imports): a plain Node script can test it
// (scripts/test-rich-golden.mjs).

export interface FontDef {
  /** the name the menu shows, in its own face; never translated */
  name: string;
  /** the stack that is written to the HTML: the first name, fall-backs recipients may have, a generic family last */
  stack: string;
}

/** Menu order. The stacks are the ones of the spec (2.4), in the canonical writing of `normFamily`. */
export const FONTS: readonly FontDef[] = [
  { name: "Aptos", stack: "Aptos,Calibri,Carlito,Arial,sans-serif" },
  { name: "Arial", stack: "Arial,Helvetica,sans-serif" },
  { name: "Calibri", stack: "Calibri,Carlito,Arial,sans-serif" },
  { name: "Cambria", stack: "Cambria,Caladea,Georgia,serif" },
  { name: "Comic Sans MS", /* i18n-ok: a font name */ stack: "'Comic Sans MS',cursive" },
  { name: "Consolas", stack: "Consolas,Menlo,'Courier New',monospace" },
  { name: "Courier New", stack: "'Courier New',Courier,monospace" },
  { name: "Georgia", stack: "Georgia,serif" },
  { name: "Helvetica", stack: "Helvetica,Arial,sans-serif" },
  { name: "Segoe UI", stack: "'Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif" },
  { name: "Tahoma", stack: "Tahoma,Verdana,sans-serif" },
  { name: "Times New Roman", /* i18n-ok: a font name */ stack: "'Times New Roman',Times,serif" },
  { name: "Trebuchet MS", stack: "'Trebuchet MS',sans-serif" },
  { name: "Verdana", stack: "Verdana,Geneva,sans-serif" },
  { name: "Microsoft YaHei", stack: "'Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif" },
  { name: "Meiryo", stack: "Meiryo,'Yu Gothic','Hiragino Sans','Noto Sans JP',sans-serif" },
];

/** The sizes of the menu, in pt (spec 2.4). */
export const SIZES: readonly number[] = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** What a new message starts with (owner decision 2): Calibri 11 pt. */
export const DEFAULT_FONT_NAME = "Calibri";
export const DEFAULT_FONT_SIZE = 11;

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "emoji", "math"]);

/** The comma-separated names of a font-family value, outside quotes, with their quotes taken off. */
function families(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = "";
  for (const c of value) {
    if (q) {
      if (c === q) q = "";
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** One family name as CSS: a name with blanks or other odd characters in single quotes, `-apple-system` and the generic families bare. */
function writeFamily(name: string): string {
  const n = name.replace(/\s+/g, " ").replace(/['"\\;{}<>]/g, "");
  if (GENERIC.has(n.toLowerCase()) || /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(n)) return n;
  return `'${n}'`;
}

/** The canonical writing of a font-family value: names separated by a plain comma, single quotes where a name needs them. */
export function normFamily(value: string | null | undefined): string {
  if (!value) return "";
  return families(value).map(writeFamily).join(",");
}

/** The first name of a stack, without quotes ("Segoe UI"). */
export function familyName(value: string | null | undefined): string {
  return families(value ?? "")[0] ?? "";
}

/** The menu font a stack belongs to (by its first name), if any. */
export function fontOf(value: string | null | undefined): FontDef | undefined {
  const n = familyName(value).toLowerCase();
  return n ? FONTS.find((f) => f.name.toLowerCase() === n) : undefined;
}

/** The stack to write for a font name: the stack of the menu font, else the name alone (quoted when it needs it). */
export function stackFor(name: string): string {
  const f = FONTS.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  return f ? f.stack : normFamily(name);
}

/** A CSS length in pt as a number (`14pt`, `10.5pt`, `18.6667px` -> 14); null for a unit that has no fixed size (em, %, keywords). */
export function sizePt(value: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(pt|px)?\s*$/i.exec(value ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  const pt = (m[2] ?? "pt").toLowerCase() === "px" ? n * 0.75 : n;
  return Math.round(pt * 100) / 100;
}

/** `14` -> `14pt`, `10.5` -> `10.5pt`. */
export const ptText = (n: number): string => `${Math.round(n * 100) / 100}pt`;

/** A size value as it is written to the HTML: pt with no trailing zeros; px, em, rem and % lengths stay; anything else ("" ) is not written. */
export function normSize(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (/^\d+(\.\d+)?\s*pt$/i.test(v)) return ptText(parseFloat(v));
  const m = /^(\d+(?:\.\d+)?)\s*(px|em|rem|%)$/i.exec(v);
  return m ? `${m[1]}${m[2].toLowerCase()}` : "";
}

/** The next listed size above (`dir` 1) or below (-1) `cur`; the ends of the list stay where they are. */
export function stepSize(cur: number, dir: 1 | -1): number {
  if (dir > 0) return SIZES.find((s) => s > cur + 1e-9) ?? SIZES[SIZES.length - 1];
  for (let i = SIZES.length - 1; i >= 0; i--) if (SIZES[i] < cur - 1e-9) return SIZES[i];
  return SIZES[0];
}

/** A size typed into the size box ("14", "10,5", "12 pt") in pt, or null when it is no number or not within 1 - 400. */
export function parseTypedSize(text: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:pt)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Math.round(Number(m[1].replace(",", ".")) * 100) / 100;
  return n >= 1 && n <= 400 ? n : null;
}
