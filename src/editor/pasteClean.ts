// What may enter the compose editor from the clipboard or a drop (spec-rich-text.md REQ-23): the HTML of Word, Excel, Outlook, Gmail, Google Docs, web pages
// and Apple's programs is read into a tree (pasteTree.ts) and written again as the small, clean HTML the editor's schema understands. Pure (no DOM): a
// plain Node script gives the very same answer as the editor, so the stored files of scripts/test-paste-clean.mjs are the real output.
//
//   Keep source   fonts, sizes, colours, highlight, bold / italic / underline / strike, sub / sup, links, lists, alignment, indent, spacing
//   Merge         structure, bold / italic / underline / strike, sub / sup, links, lists, alignment and indent; no font, size, colour, highlight,
//                 line spacing or space after (the text takes the format around it)
//   Text only     text, line breaks as paragraphs, list items as lines with their marker
//
// Taken away in every mode: Mso classes and mso-* styles, conditional comments, <o:p>, VML, <xml>, <style> (after its simple class / tag rules were
// applied to the elements), scripts, frames, forms, event handlers, ids, classes, links that are not http / https / mailto / tel, and every picture that is
// not a data: picture (a web, file: or cid: picture would be a request, a broken box or a tracking pixel). Word's fake lists (paragraphs with mso-list and
// a typed marker) become real, nested lists. Tables: when the editor has none (`tables` false) a table whose cells hold only text becomes one paragraph per
// row with the cells separated by a tab, any other table (a layout) is unfolded into its blocks; with `tables` they stay tables.

import { parseHtml, textOf, toHtml, MAX_DEPTH, type El, type Nd } from "./pasteTree.ts";
import { normColor, parseRgb } from "./colors.ts";
import { familyName, normFamily, sizePt, ptText } from "./fonts.ts";
import { lengthPx, normAlign, normDirection, normLineHeight, normListStyle, INDENT_PX } from "./blockFormat.ts";
import { htmlToText } from "../htmlText.ts";
import { isLocalPictureSrc } from "../pastedHtml.ts";

export type PasteMode = "source" | "merge" | "text";
export interface PasteOpts {
  mode: PasteMode;
  /** the editor can show tables (WP5d); without them a table is turned into text lines */
  tables?: boolean;
  /** the default font of the message: the same family or size in the paste is not written again */
  base?: { family: string; size: number };
}
export interface PasteResult {
  html: string;
  /** pictures that were left out (not a data: picture) */
  removed: number;
}

type Decls = Record<string, string>;

// ---------------------------------------------------------------- CSS

/** `a:b;c:d` -> {a:b, c:d}; `;` inside quotes or brackets (a data: URL) does not split. */
export function decls(css: string): Decls {
  const out: Decls = {};
  let cur = "";
  let q = "";
  let depth = 0;
  const put = (part: string) => {
    const c = part.indexOf(":");
    if (c > 0) out[part.slice(0, c).trim().toLowerCase()] = part.slice(c + 1).replace(/!\s*important/i, "").trim();
  };
  for (const ch of css) {
    if (q) {
      if (ch === q) q = "";
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && !depth) {
      put(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  put(cur);
  return out;
}

interface Rule {
  tag: string;
  cls: string;
  spec: number;
  d: Decls;
}

const MAX_RULES = 3000;

/** A style sheet as [selector, body] pairs; comments and at-rules (@font-face, @page, @media ...) are left out. One pass: a hostile sheet cannot make it slow. */
export function ruleList(text: string): [string, string][] {
  let css = "";
  for (let p = 0; ; ) {
    const a = text.indexOf("/*", p);
    if (a < 0) {
      css += text.slice(p);
      break;
    }
    css += text.slice(p, a);
    const b = text.indexOf("*/", a + 2);
    if (b < 0) break;
    p = b + 2;
  }
  css = css.replace(/<!--|-->/g, "");
  const out: [string, string][] = [];
  for (let i = 0; i < css.length; ) {
    const o = css.indexOf("{", i);
    if (o < 0) break;
    const sel = css.slice(Math.max(i, o - 300), o);
    const t = sel.slice(Math.max(sel.lastIndexOf(";"), sel.lastIndexOf("}")) + 1).trim(); // (what an @import line or the end of the rule before leaves in front)
    if (t.startsWith("@")) {
      let depth = 1;
      let j = o + 1;
      while (j < css.length && depth) {
        const ch = css[j++];
        depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      }
      i = j;
      continue;
    }
    const c = css.indexOf("}", o);
    if (c < 0) break;
    out.push([t, css.slice(o + 1, c)]);
    if (out.length >= MAX_RULES) break; // (Word writes about a hundred, a web page's whole sheet is never needed)
    i = c + 1;
  }
  return out;
}

/** The simple rules of the <style> elements: `tag`, `.class`, `tag.class`, several separated by commas (what Word, Excel and Apple's programs write). */
function readRules(root: El): Map<string, Rule[]> {
  const map = new Map<string, Rule[]>();
  let count = 0;
  const walk = (e: El) => {
    for (const k of e.kids) {
      if (typeof k === "string") continue;
      if (k.tag !== "style") {
        walk(k);
        continue;
      }
      for (const [selectors, body] of ruleList(textOf(k).slice(0, 400_000))) {
        if (count++ >= MAX_RULES) return;
        const d = decls(body);
        for (const sel of selectors.split(",")) {
          const s = /^\s*([a-z][a-z0-9]*)?(?:\.([\w-]+))?\s*$/i.exec(sel.slice(0, 100));
          if (!s || (!s[1] && !s[2])) continue;
          const r: Rule = { tag: (s[1] ?? "").toLowerCase(), cls: s[2] ?? "", spec: (s[1] ? 1 : 0) + (s[2] ? 10 : 0), d };
          const key = r.cls || r.tag;
          (map.get(key) ?? map.set(key, []).get(key)!).push(r);
        }
      }
    }
  };
  walk(root);
  return map;
}

/** The size keywords of CSS and the sizes 1 - 7 of <font>, in pt. */
const SIZE_WORDS: Record<string, number> = { "xx-small": 7, "x-small": 8, small: 10, medium: 12, large: 14, "x-large": 18, "xx-large": 24, "1": 8, "2": 10, "3": 12, "4": 14, "5": 18, "6": 24, "7": 36 };

/** `font: italic bold 12px/1.4 Arial, sans-serif` (Apple's programs write it) split into its longhands. */
function fontShorthand(v: string, d: Decls) {
  const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|[1-9]00)\s+)*)([\d.]+(?:px|pt)|(?:xx?-)?(?:small|large)|medium)(?:\/\S+)?\s+(.+)$/i.exec(v.trim());
  if (!m) return;
  if (/italic|oblique/i.test(m[1])) d["font-style"] = "italic";
  const w = /\b(bold|bolder|lighter|[1-9]00)\b/i.exec(m[1]);
  if (w) d["font-weight"] = w[1];
  d["font-size"] = m[2];
  d["font-family"] = m[3];
}

// ---------------------------------------------------------------- what text looks like

interface Props {
  ff?: string;
  fs?: string;
  c?: string;
  bg?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  sub?: boolean;
  sup?: boolean;
  k?: boolean;
  /** link target */
  h?: string;
}
const MARK_TAG: Record<string, "b" | "i" | "u" | "s" | "sub" | "sup" | "k"> = { b: "b", strong: "b", i: "i", em: "i", cite: "i", dfn: "i", var: "i", u: "u", ins: "u", s: "s", strike: "s", del: "s", sub: "sub", sup: "sup", code: "k", tt: "k", kbd: "k", samp: "k" };
const AUTO_COLOR = /^(?:inherit|initial|unset|currentcolor|transparent|auto|windowtext|window|none|black)$/i;
const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:)/i;
/** The colour names of the old HTML palette (what Word's `color:red` and `background:yellow` mean) as the hex the colour menus use. */
const NAMED_COLORS: Record<string, string> = { white: "#FFFFFF", red: "#FF0000", yellow: "#FFFF00", lime: "#00FF00", aqua: "#00FFFF", cyan: "#00FFFF", fuchsia: "#FF00FF", magenta: "#FF00FF", blue: "#0000FF", navy: "#000080", teal: "#008080", green: "#008000", purple: "#800080", maroon: "#800000", olive: "#808000", gray: "#808080", grey: "#808080", silver: "#C0C0C0", orange: "#FFA500" };
const colorOf = (v: string): string => {
  const c = normColor(v);
  return NAMED_COLORS[c] ?? c;
};

/** The text properties an element adds to those it inherits (`fromBlock`: a block's background is not text highlight). */
function textProps(p: Props, tag: string, d: Decls, fromBlock: boolean, mode: PasteMode): Props {
  if (mode === "text") return p;
  const o: Props = { ...p };
  const flag = MARK_TAG[tag];
  if (flag) o[flag] = true;
  const w = d["font-weight"];
  if (w) o.b = /^(?:bold|bolder|[6-9]00)$/i.test(w) ? true : /^(?:normal|lighter|[1-5]00)$/i.test(w) ? false : o.b;
  if (/^(?:italic|oblique)/i.test(d["font-style"] ?? "")) o.i = true;
  const dec = (d["text-decoration"] ?? "") + (d["text-decoration-line"] ?? "");
  if (/underline/i.test(dec)) o.u = true;
  if (/line-through/i.test(dec)) o.s = true;
  const va = (d["vertical-align"] ?? "").toLowerCase();
  if (va === "sub" || va === "super") o[va === "sub" ? "sub" : "sup"] = true;
  if (tag === "a" && !fromBlock) {
    const href = (d.href ?? "").trim();
    o.h = SAFE_HREF.test(href) ? href : ""; // (a link that is no link keeps its text but not the link look: see `final`)
  }
  if (mode === "merge") return o;
  const ff = d["font-family"] && !/^(?:inherit|initial|unset)$/i.test(d["font-family"]) ? normFamily(d["font-family"]).slice(0, 200) : "";
  if (ff) o.ff = ff;
  const sz = d["font-size"]?.trim().toLowerCase();
  const pt = sz ? (SIZE_WORDS[sz] ?? sizePt(sz)) : null;
  if (pt !== null && pt !== undefined && pt >= 1 && pt <= 400) o.fs = ptText(pt);
  const col = d.color && !AUTO_COLOR.test(d.color.trim()) ? colorOf(d.color) : "";
  if (col) o.c = col;
  const bgv = d["background-color"] ?? /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]{3,20}\b)/i.exec(d.background ?? "")?.[1];
  if (!fromBlock && bgv && !AUTO_COLOR.test(bgv.trim())) o.bg = colorOf(bgv);
  return o;
}

/** The properties as they are written: nothing that equals the message's own font, no automatic or white-on-nothing colour, no link look. */
function final(p: Props, opts: PasteOpts): Props {
  const o: Props = { ...p };
  if (o.h !== undefined) {
    delete o.c;
    delete o.u;
  }
  if (o.bg && /^#(?:FFFFFF|FEFEFE|FDFDFD)$/i.test(o.bg)) delete o.bg;
  const rgb = o.c ? parseRgb(o.c) : null;
  if (rgb && ((rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0) || (!o.bg && Math.min(...rgb) >= 240))) delete o.c; // black is "Automatic"; white would vanish on the page
  const base = opts.base;
  if (base && o.ff && familyName(o.ff).toLowerCase() === familyName(base.family).toLowerCase()) delete o.ff;
  if (base && o.fs && sizePt(o.fs) === base.size) delete o.fs;
  for (const k of Object.keys(o) as (keyof Props)[]) if (!o[k]) delete o[k];
  return o;
}
const keyOf = (p: Props) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join("|");

// ---------------------------------------------------------------- blocks

interface Blk {
  /** null = left on purpose (it cancels an inherited alignment) */
  align?: string | null;
  /** right-to-left text (`dir="rtl"` or `direction:rtl`, inherited by what is inside; left-to-right cancels it) */
  rtl?: boolean;
  ml?: number;
  mb?: number;
  lh?: string;
}

/** `margin` and the longhands -> left and bottom, in px. */
function margins(d: Decls): { l?: number; b?: number } {
  const o: { l?: number; b?: number } = {};
  if (d.margin) {
    const v = d.margin.trim().split(/\s+/).map(lengthPx);
    const b = v[2] ?? v[0];
    const l = v.length === 4 ? v[3] : v.length >= 2 ? v[1] : v[0];
    if (b !== null && b !== undefined) o.b = b;
    if (l !== null && l !== undefined) o.l = l;
  }
  const l = lengthPx(d["margin-left"]);
  const b = lengthPx(d["margin-bottom"]);
  if (l !== null) o.l = l;
  if (b !== null) o.b = b;
  return o;
}

function blockOf(parent: Blk, d: Decls, tag: string): Blk {
  const o: Blk = { ...parent };
  const a = d["text-align"];
  if (a) o.align = normAlign(a);
  if (d.direction) o.rtl = normDirection(d.direction) === "rtl";
  if (tag === "center") o.align = "center";
  if (/^(?:p|h[1-6]|div|li|td|th|section|article|blockquote|center)$/.test(tag)) {
    const m = margins(d);
    if (m.l !== undefined && tag !== "li") o.ml = Math.round(m.l);
    if (m.b !== undefined && /^(?:p|h[1-6])$/.test(tag)) o.mb = m.b;
    const lh = d["line-height"] ? normLineHeight(d["line-height"]) : undefined;
    if (lh !== undefined) o.lh = lh ?? undefined;
  }
  return o;
}

function blockStyle(b: Blk, tag: string, mode: PasteMode): string {
  if (mode === "text") return "";
  const out: string[] = [];
  if (b.rtl) out.push("direction:rtl");
  if (b.align) out.push(`text-align:${b.align}`);
  if (b.ml && b.ml >= INDENT_PX / 2) out.push(`margin-left:${b.ml}px`);
  if (mode === "source") {
    if (b.mb !== undefined && (b.mb > 0 || /^h/.test(tag))) out.push(`margin-bottom:${Math.round(b.mb * 0.75 * 2) / 2}pt`);
    if (b.lh) out.push(`line-height:${b.lh}`);
  }
  return out.join(";");
}

// ---------------------------------------------------------------- Word's lists

const MSO_LIST = /mso-list:\s*l(\d+)\s+level(\d+)/i;
const msoItem = (n: Nd) => {
  const m = typeof n === "string" ? null : MSO_LIST.exec(n.attrs.style ?? "");
  return m ? { id: m[1], level: Number(m[2]) } : null;
};

/** Takes the typed marker (the span Word marks `mso-list:Ignore`) out of a paragraph and returns its text. */
function takeMarker(e: El): string | null {
  for (let i = 0; i < e.kids.length; i++) {
    const k = e.kids[i];
    if (typeof k === "string") continue;
    if (/mso-list:\s*ignore/i.test(k.attrs.style ?? "")) {
      e.kids.splice(i, 1);
      return textOf(k).replace(/[\s ]+/g, "");
    }
    const m = takeMarker(k);
    if (m !== null) return m;
  }
  return null;
}

/** What a typed marker says about its list: bullet (and which) or number (and which kind, and from where). */
function markerKind(m: string, level: number): { ordered: boolean; style: string; start: number } {
  const num = /^\(?(\d+)[.)]?$/.exec(m);
  if (num) return { ordered: true, style: "decimal", start: Number(num[1]) };
  const al = /^\(?([a-zA-Z]+)[.)]?$/.exec(m);
  if (al && m !== "o") {
    const w = al[1];
    const upper = w === w.toUpperCase();
    // i. v. x. are Roman at the third level (Word's default 1. a. i.) or when longer than one letter
    if (/^[ivxlcdm]+$/i.test(w) && (w.length > 1 || (level % 3 === 0 && /^[ivx]$/i.test(w)))) return { ordered: true, style: upper ? "upper-roman" : "lower-roman", start: 1 };
    return { ordered: true, style: upper ? "upper-alpha" : "lower-alpha", start: w.length === 1 ? w.toLowerCase().charCodeAt(0) - 96 : 1 };
  }
  // Symbol / Wingdings bullets arrive as private-use characters, the hollow one as the letter o
  const square = /^[§▪■□]$/.test(m);
  return { ordered: false, style: m === "o" || /^[○◦]$/.test(m) ? "circle" : square ? "square" : "disc", start: 1 };
}

/** Consecutive Word list paragraphs -> real nested <ul> / <ol>. */
function listify(kids: Nd[]): Nd[] {
  const out: Nd[] = [];
  let stack: { el: El; level: number; id: string; ordered: boolean }[] = [];
  for (const k of kids) {
    const info = msoItem(k);
    if (!info || typeof k === "string") {
      if (typeof k === "string" && /^[ \t\r\n]*$/.test(k) && stack.length) continue; // blank text between the items does not end the list
      stack = [];
      out.push(k);
      continue;
    }
    const kind = markerKind(takeMarker(k) ?? "", info.level);
    while (stack.length && stack[stack.length - 1].level > info.level) stack.pop();
    let t = stack[stack.length - 1];
    if (t && t.level === info.level && (t.id !== info.id || t.ordered !== kind.ordered)) {
      stack.pop();
      t = stack[stack.length - 1];
    }
    if (!t || t.level < info.level) {
      const attrs: Record<string, string> = { style: `list-style-type:${kind.style}` };
      if (kind.ordered && kind.start > 1) attrs.start = String(kind.start);
      const l: El = { tag: kind.ordered ? "ol" : "ul", attrs, kids: [] };
      if (t) {
        const last = t.el.kids[t.el.kids.length - 1];
        let li = typeof last === "object" ? last : null;
        if (!li) t.el.kids.push((li = { tag: "li", attrs: {}, kids: [] }));
        li.kids.push(l);
      } else out.push(l);
      stack.push((t = { el: l, level: info.level, id: info.id, ordered: kind.ordered }));
    }
    // the paragraph's own style and class stay on the item (its font, alignment); `data-t` lets a class rule written for p.MsoListParagraph still match
    t.el.kids.push({ tag: "li", attrs: { style: k.attrs.style ?? "", class: k.attrs.class ?? "", "data-t": k.tag }, kids: k.kids });
  }
  return out;
}

/** Word's lists, and the lists that are not valid HTML (text or a list directly inside <ul>) made valid, everywhere in the tree. */
function fixTree(e: El, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const k of e.kids) if (typeof k !== "string") fixTree(k, depth + 1);
  e.kids = listify(e.kids);
  if (e.tag === "ul" || e.tag === "ol") {
    const kids: Nd[] = [];
    for (const k of e.kids) {
      const last = kids[kids.length - 1];
      if (typeof k !== "string" && k.tag === "li") kids.push(k);
      else if (typeof k !== "string" && (k.tag === "ul" || k.tag === "ol")) {
        if (typeof last === "object" && last.tag === "li") last.kids.push(k);
        else kids.push({ tag: "li", attrs: {}, kids: [k] });
      } else if (typeof k === "string" && !k.trim()) continue;
      else if (typeof last === "object" && last.tag === "li" && last.attrs["data-loose"]) last.kids.push(k);
      else kids.push({ tag: "li", attrs: { "data-loose": "1" }, kids: [k] });
    }
    e.kids = kids;
  }
}

// ---------------------------------------------------------------- the writer

type Item = { t: string; p: Props; k: string } | { br: true } | { img: Record<string, string> };

const MARKS: [keyof Props, string][] = [["sup", "sup"], ["sub", "sub"], ["s", "s"], ["u", "u"], ["i", "em"], ["b", "strong"], ["k", "code"]];
/** A tab is a span that keeps it: the editor's reader folds every other blank (emailHtml.ts writes a tab as no-break spaces, a recipient's client would fold it too). */
const tabSpan = (): El => ({ tag: "span", attrs: { style: "white-space:pre" }, kids: ["\t"] });
/** The nodes of a run of text: its tabs, then its properties (the span, the marks, the link) around them. */
function runNodes(t: string, p: Props): Nd[] {
  let n: Nd[] = t.split("\t").flatMap((x, i) => (i ? [tabSpan(), x] : [x]));
  const st = [p.ff && `font-family:${p.ff}`, p.fs && `font-size:${p.fs}`, p.c && `color:${p.c}`, p.bg && `background-color:${p.bg}`].filter(Boolean).join(";");
  if (st) n = [{ tag: "span", attrs: { style: st }, kids: n }];
  for (const [f, tag] of MARKS) if (p[f]) n = [{ tag, attrs: {}, kids: n }];
  return p.h ? [{ tag: "a", attrs: { href: p.h }, kids: n }] : n;
}

class Out {
  root: El = { tag: "", attrs: {}, kids: [] };
  stack: El[] = [this.root];
  cur: { el: El; items: Item[]; pre: boolean } | null = null;
  top = () => this.stack[this.stack.length - 1];

  /** the text block being filled ends: its items become nodes */
  end() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    let items = c.items;
    if (items.length && "br" in items[items.length - 1]) items = items.slice(0, -1); // a browser shows a last <br> as nothing
    if (!c.pre) {
      const first = items[0];
      if (first && "t" in first) first.t = first.t.replace(/^ /, "");
      const last = items[items.length - 1];
      if (last && "t" in last) last.t = last.t.replace(/ $/, "");
    }
    if (items.every((i) => "t" in i && /^[  ]*$/.test(i.t))) items = []; // Word's "empty" paragraph holds a no-break space
    for (const i of items) {
      if ("t" in i) c.el.kids.push(...(c.pre ? [i.t] : runNodes(i.t, i.p)));
      else c.el.kids.push("br" in i ? { tag: "br", attrs: {}, kids: [] } : { tag: "img", attrs: i.img, kids: [] });
    }
  }
  /** a new text block (paragraph, heading, code) in the open container */
  open(tag: string, style: string, pre = false) {
    this.end();
    const el: El = { tag, attrs: style ? { style } : {}, kids: [] };
    this.top().kids.push(el);
    this.cur = { el, items: [], pre };
  }
  /** a container (list, item, quote, table ...) */
  push(tag: string, attrs: Record<string, string> = {}, direct = false): El {
    this.end();
    const el: El = { tag, attrs, kids: [] };
    this.top().kids.push(el);
    this.stack.push(el);
    if (direct) this.cur = { el, items: [], pre: false }; // a list item holds its text directly
    return el;
  }
  pop() {
    this.end();
    if (this.stack.length > 1) this.stack.pop();
  }
  node(n: El) {
    this.end();
    this.top().kids.push(n);
  }
  item(i: Item, blk: string) {
    if (!this.cur) this.open("p", blk);
    this.cur!.items.push(i);
  }
}
const NO_PROPS: Props = {};

interface Cx {
  p: Props;
  blk: Blk;
  pre: boolean;
  depth: number;
}

const DROP = new Set("script style iframe object embed noscript template head title meta link xml svg math canvas audio video applet frame frameset input button select textarea option datalist param source track area map".split(" "));
const BLOCKS = new Set("div section article aside header footer main nav figure figcaption address dd dt dl form fieldset legend details summary center body html caption hgroup menu dir table thead tbody tfoot tr td th colgroup".split(" "));
const HIDDEN = /display:\s*none|mso-hide:\s*all|visibility:\s*hidden/i;

class Cleaner {
  out = new Out();
  removed = 0;
  rules: Map<string, Rule[]>;
  o: PasteOpts;
  constructor(root: El, o: PasteOpts) {
    this.o = o;
    this.rules = o.mode === "text" ? new Map() : readRules(root); // (Text only has no use for the look of anything)
  }

  /** the declarations that apply to an element: attributes of old HTML, then the rules of the style sheet, then its own style */
  declsOf(e: El): Decls {
    const d: Decls = {};
    const a = e.attrs;
    if (a.align) d["text-align"] = a.align;
    if (a.dir) d.direction = a.dir;
    if (e.tag === "font") {
      if (a.color) d.color = a.color;
      if (a.face) d["font-family"] = a.face;
      if (a.size) d["font-size"] = a.size;
    }
    if (e.tag === "a") d.href = a.href ?? "";
    const tag = a["data-t"] ?? e.tag;
    const found: Rule[] = [];
    for (const c of [...(a.class ?? "").split(/\s+/), tag]) for (const r of this.rules.get(c) ?? []) if ((!r.tag || r.tag === tag) && (!r.cls || (a.class ?? "").split(/\s+/).includes(r.cls))) found.push(r);
    for (const r of [...new Set(found)].sort((x, y) => x.spec - y.spec)) Object.assign(d, r.d);
    Object.assign(d, decls(a.style ?? ""));
    if (d.font) fontShorthand(d.font, d);
    if (e.tag === "mark" && !d["background-color"] && !d.background) d["background-color"] = "#FFFF00";
    return d;
  }

  text(s: string, cx: Cx) {
    const o = this.out;
    // (white-space:pre* text keeps its blanks: a second blank in a row is a no-break space, which the editor's reader does not fold; a tab stays a tab)
    s = cx.pre ? s.replace(/\r\n?|\n/g, " ").replace(/ {2,}/g, (m) => " " + " ".repeat(m.length - 1)) : s.replace(/[ \t\r\n\f]+/g, " ");
    if (!o.cur) {
      if (/^[ \t\r\n\f]*$/.test(s)) return; // the layout of the source between blocks
      o.open("p", blockStyle(cx.blk, "p", this.o.mode));
    }
    const items = o.cur!.items;
    if (!cx.pre && s.startsWith(" ")) {
      const last = items[items.length - 1];
      if (!last || ("t" in last ? /[ \t\n]$/.test(last.t) : "br" in last)) s = s.slice(1);
    }
    if (!s) return;
    const p = final(cx.p, this.o);
    const k = keyOf(p);
    const last = items[items.length - 1];
    if (last && "t" in last && last.k === k) last.t += s;
    else items.push({ t: s, p: k ? p : NO_PROPS, k });
  }

  walk(n: Nd, cx: Cx): void {
    if (typeof n === "string") return this.text(n, cx);
    if (cx.depth > MAX_DEPTH) return;
    const tag = n.tag;
    if (DROP.has(tag) || /^[vwmx]:/.test(tag)) return;
    const d = this.declsOf(n);
    if (HIDDEN.test(Object.entries(d).map(([k, v]) => `${k}:${v}`).join(";"))) return;
    const mode = this.o.mode;
    const o = this.out;
    const block = BLOCKS.has(tag) || /^(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr)$/.test(tag);
    const next: Cx = { p: textProps(cx.p, tag, d, block, mode), blk: block ? blockOf(cx.blk, d, tag) : cx.blk, pre: cx.pre || tag === "pre" || /^pre/.test(d["white-space"] ?? ""), depth: cx.depth + 1 };
    const kids = (c: Cx = next) => {
      for (const k of n.kids) this.walk(k, c);
    };

    switch (tag) {
      case "br":
        if (!/page-break/i.test(n.attrs.style ?? "") && !n.attrs.clear) o.item({ br: true }, blockStyle(cx.blk, "p", mode));
        return;
      case "hr":
        o.node({ tag: "hr", attrs: {}, kids: [] });
        return;
      case "img": {
        const src = n.attrs.src ?? "";
        if (mode === "text") return;
        if (!isLocalPictureSrc(src) || /^\s*cid:/i.test(src)) {
          this.removed++;
          return;
        }
        const w = Number(n.attrs.width ?? /([\d.]+)px/.exec(d.width ?? "")?.[1]);
        o.item({ img: { src, alt: (n.attrs.alt ?? "").slice(0, 200), ...(w > 0 && w < 5000 ? { width: String(Math.round(w)) } : {}) } }, blockStyle(cx.blk, "p", mode));
        return;
      }
      case "p":
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const h = /^h[1-6]$/.test(tag);
        const t = h && tag > "h3" ? "p" : tag; // only Heading 1 - 3 exist; a lower one is a bold paragraph
        o.open(t, blockStyle(next.blk, tag, mode));
        // a heading is bold by itself, so its own bold style says nothing; a lower heading becomes a bold paragraph
        kids(h && mode !== "text" ? { ...next, p: { ...next.p, b: t === "p" ? true : cx.p.b } } : next);
        o.end();
        return;
      }
      case "pre":
        o.open("pre", "", true);
        o.cur!.items.push({ t: textOf(n).replace(/\r\n?/g, "\n").replace(/\n$/, ""), p: NO_PROPS, k: "" });
        o.end();
        return;
      case "ul": case "ol": case "menu": case "dir": {
        const ordered = tag === "ol";
        const attrs: Record<string, string> = {};
        const st = normListStyle(ordered, (/list-style(?:-type)?:\s*([a-z-]+)/i.exec(n.attrs.style ?? "")?.[1]) ?? "") ?? (ordered ? normListStyle(true, n.attrs.type) : null);
        if (st) attrs.style = `list-style-type:${st}`;
        const start = parseInt(n.attrs.start ?? "", 10);
        if (ordered && start > 1 && start < 10000) attrs.start = String(start);
        o.push(ordered ? "ol" : "ul", attrs);
        kids({ ...next, blk: { ...next.blk, ml: 0 } });
        o.pop();
        return;
      }
      case "li": {
        const a = next.blk.align;
        o.push("li", {}, !a);
        kids();
        o.pop();
        return;
      }
      case "blockquote":
        o.push("blockquote");
        kids({ ...next, blk: {} });
        o.pop();
        return;
      case "table":
        if (this.o.tables) {
          o.push("table", this.bordered(n) ? { border: "1" } : {}); // (the border style the editor's table has: all borders, else none)
          kids();
          o.pop();
        } else this.table(n, next);
        return;
      case "tr":
        if (this.o.tables) {
          o.push("tr");
          kids();
          o.pop();
          return;
        }
        break;
      case "td": case "th":
        if (this.o.tables) {
          const at: Record<string, string> = {};
          for (const k of ["colspan", "rowspan"]) if (/^\d{1,3}$/.test(n.attrs[k] ?? "") && n.attrs[k] !== "1") at[k] = n.attrs[k];
          const shade = mode === "text" ? "" : this.shading(n, d);
          if (shade) at.bgcolor = shade;
          o.push(tag, at);
          kids();
          o.pop();
          return;
        }
        break;
      default:
    }
    if (block) {
      o.end();
      kids();
      o.end();
    } else kids();
  }

  /** Whether a table is drawn with borders: its `border` attribute, or borders on its cells (Word and Excel write them as styles on every cell). */
  bordered(t: El): boolean {
    if (Number(t.attrs.border) > 0) return true;
    let seen = 0;
    const visit = (e: El): boolean => {
      for (const k of e.kids) {
        if (typeof k === "string" || seen > 60) continue;
        if (k.tag === "td" || k.tag === "th") {
          seen++;
          const d = this.declsOf(k);
          if (["border", "border-top", "border-right", "border-bottom", "border-left"].some((p) => d[p] && !/\b(?:none|hidden)\b/i.test(d[p]) && !/^\s*0/.test(d[p]))) return true;
        } else if (/^(?:thead|tbody|tfoot|tr)$/.test(k.tag) && visit(k)) return true;
      }
      return false;
    };
    return visit(t);
  }

  /** The shading of a cell as `#RRGGBB`: its `bgcolor` or background colour; white (the page) and no colour give "". */
  shading(c: El, d: Decls): string {
    const bg = d["background-color"] || (d.background ?? "").split(/\s+/).find((x) => /^#|^rgb|^[a-z]{3,20}$/i.test(x)) || c.attrs.bgcolor || "";
    const hex = colorOf(bg);
    return /^#[0-9A-F]{6}$/i.test(hex) && hex.toUpperCase() !== "#FFFFFF" ? hex.toUpperCase() : "";
  }

  /** A table in an editor without tables: rows of plain cells become lines (cells separated by a tab), anything else is unfolded into its blocks. */
  table(t: El, cx: Cx) {
    const rows: El[] = [];
    const find = (e: El) => {
      for (const k of e.kids) if (typeof k !== "string") (k.tag === "tr" ? rows.push(k) : /^(?:thead|tbody|tfoot)$/.test(k.tag) && find(k));
    };
    find(t);
    const cells = (r: El) => r.kids.filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
    const plain = rows.length > 0 && rows.every((r) => cells(r).every((c) => !hasBlock(c)));
    if (!plain) {
      this.out.end();
      for (const k of t.kids) this.walk(k, cx);
      this.out.end();
      return;
    }
    for (const r of rows) {
      const cs = cells(r);
      if (!cs.length) continue;
      this.out.open("p", blockStyle(cx.blk, "p", this.o.mode));
      cs.forEach((c, i) => {
        if (i) this.out.cur!.items.push({ t: "\t", p: NO_PROPS, k: "" });
        for (const k of c.kids) this.walk(k, { ...cx, p: textProps(cx.p, c.tag, this.declsOf(c), true, this.o.mode) });
      });
      this.out.end();
    }
  }
}

const hasBlock = (e: El): boolean => e.kids.some((k) => typeof k !== "string" && (/^(?:p|div|ul|ol|table|h[1-6]|blockquote|pre|hr|li)$/.test(k.tag) || hasBlock(k)));

// ---------------------------------------------------------------- the entry points

/** True for the HTML of a copy made inside the editor (ProseMirror marks it): it is already in the editor's own form. */
export const isInternalCopy = (html: string): boolean => /^\s*(?:<meta\b[^>]*>\s*)*<[a-z][a-z0-9]*\b[^>]*\sdata-pm-slice="\d+ \d+ [^"]*"/i.test(html.slice(0, 2000));

/** The clipboard HTML as the clean HTML of the editor's schema. */
export function cleanPaste(html: string, o: PasteOpts): PasteResult {
  const start = html.search(/<[a-zA-Z!]/);
  const root = parseHtml(start > 0 ? html.slice(start) : html); // (the "Version:0.9 StartHTML:..." header of the Windows format)
  fixTree(root);
  const c = new Cleaner(root, o);
  c.walk(root, { p: {}, blk: {}, pre: false, depth: 0 });
  c.out.end();
  return { html: toHtml(c.out.root.kids), removed: c.removed };
}

/** The text of clipboard HTML: lines, list items with their marker (`- ` / `1. `), table rows with tabs; no links, no pictures. */
export function pasteText(html: string, tables = true): string {
  return htmlToText(cleanPaste(html, { mode: "text", tables }).html);
}

const NBSP = String.fromCharCode(160);

/** Lines of text as paragraphs: one per line, a blank line stays a blank paragraph, the blanks that indent a line stay. */
/**
 * The HTML the editor's reader gets for a clipboard, in a mode: the cleaned HTML (a copy made inside the editor is left as it is), Text only made from the
 * structure (list markers, table rows) or else from the plain text, and the plain text when the HTML had nothing left (a picture that could not be pasted).
 */
export function editorHtml(p: { html: string; text: string }, mode: PasteMode, tables: boolean, base: { family: string; size: number }): string {
  if (mode === "text") return textToHtml(pasteText(p.html, tables) || p.text);
  const html = isInternalCopy(p.html) ? p.html : cleanPaste(p.html, { mode, tables, base }).html;
  return html || (p.text ? textToHtml(p.text) : "");
}

export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // the editor's reader folds blanks: the blanks that are not alone become no-break spaces, a tab becomes the span that keeps it
  const keep = (l: string) => esc(l).replace(/^ +| {2,}/g, (m, at: number) => (at === 0 ? NBSP.repeat(m.length) : " " + NBSP.repeat(m.length - 1))).replace(/\t/g, toHtml([tabSpan()]));
  return lines.map((l) => `<p>${keep(l)}</p>`).join("");
}
