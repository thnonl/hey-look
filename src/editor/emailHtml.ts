// The HTML of a message, written from the editor's document (`editor.getJSON()`), not from what the editor shows (`getHTML()`):
// every node and mark becomes the email-safe form of spec-rich-text.md 2.3 (inline styles and plain attributes, no classes, no
// <style>), so a recipient's client, the Reader and the editor itself agree on font, size and spacing. The editor reads the same
// forms back (the extensions' parse rules), so a draft that is saved and reopened is written again exactly as before (REQ-6).
// Pure (no imports, no DOM): a plain Node script tests it against stored files (scripts/test-rich-golden.mjs).
//
//   paragraph      <p style="margin:0">..</p>          (an empty one: <p style="margin:0"><br></p>, so it keeps its height)
//                  with paragraph formats: <p style="margin:0 0 10pt 80px;text-align:center;line-height:1.5"> (blockFormat.ts)
//   heading 1-3    <h1 style="font-size:18pt;font-weight:bold;margin:12pt 0 4pt">
//   lists          <ul style="list-style-type:disc;margin:0 0 0 40px;padding:0"> / <ol type="a" style="list-style-type:lower-alpha;..">
//                  (the marker is the list's own style, else the one its nesting level gives: disc, circle, square / 1. a. i.)
//   text styles    <span style="font-family:..;font-size:..pt;color:#..;background-color:#..">, <strong> <em> <u> <s> <sub> <sup>
//   everything     inside one wrapper with the message's default font (`wrapBase`)

import { normFamily, normSize, ptText, sizePt } from "./fonts.ts";
import { normColor } from "./colors.ts";
import { defaultListStyle, marginCss, normListStyle, olType, tailCss, type BlockAttrs } from "./blockFormat.ts";

export interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** The default font of a message: family stack (as `normFamily` writes it) and size in pt. */
export interface BaseFont {
  family: string;
  size: number;
}

const HEADING_FONT: Record<number, string> = { 1: "font-size:18pt;font-weight:bold", 2: "font-size:14pt;font-weight:bold", 3: "font-size:12pt;font-weight:bold" };
const LIST_BOX = "margin:0 0 0 40px;padding:0";

/** The style of a paragraph: its margin box (indent, space after), then alignment and line spacing. */
const paragraphStyle = (a: BlockAttrs): string => marginCss("0", "0", a) + tailCss(a);
const headingStyle = (level: number, a: BlockAttrs): string => `${HEADING_FONT[level]};${marginCss("12pt", "4pt", a)}${tailCss(a)}`;
const blockAttrs = (n: JsonNode): BlockAttrs => (n.attrs ?? {}) as BlockAttrs;
export const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex";
export const MONO = "Consolas,Menlo,'Courier New',monospace";
const PRE_STYLE = `font-family:${MONO};font-size:10pt;white-space:pre-wrap;background-color:#f4f4f4;padding:8px;margin:0`;
const CODE_STYLE = `font-family:${MONO};font-size:10pt;background-color:#f4f4f4`;
const HR_STYLE = "border:0;border-top:1px solid #bfbfbf;margin:8pt 0";
const IMG_STYLE = "max-width:100%;height:auto";

/** The only addresses a link may have (the sanitiser in outgoing.rs says the same). */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:)/i;
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text as HTML: a no-break space is `&nbsp;`; of a run of blanks only the first stays a plain blank, and a blank at the edge of a line is a no-break one, so nothing collapses. */
function textHtml(raw: string, atStart: boolean, atEnd: boolean): string {
  let s = escText(raw).replace(/ /g, "&nbsp;").replace(/\r\n?|\n/g, " ");
  s = s.replace(/ {2,}/g, (run) => " " + "&nbsp;".repeat(run.length - 1));
  if (atStart) s = s.replace(/^ /, "&nbsp;");
  if (atEnd) s = s.replace(/ $/, "&nbsp;");
  return s;
}

/** The marks of a text node, outermost first. */
const MARK_ORDER = ["link", "textStyle", "bold", "italic", "underline", "strike", "subscript", "superscript", "code"];

function spanStyle(attrs: Record<string, unknown> | undefined): string {
  const a = attrs ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const parts: string[] = [];
  const fam = normFamily(str(a.fontFamily));
  if (fam) parts.push(`font-family:${fam}`);
  const size = normSize(str(a.fontSize));
  if (size) parts.push(`font-size:${size}`);
  const color = normColor(str(a.color));
  if (color) parts.push(`color:${color}`);
  const bg = normColor(str(a.backgroundColor));
  if (bg) parts.push(`background-color:${bg}`);
  return parts.join(";");
}

function openClose(mark: { type: string; attrs?: Record<string, unknown> }): [string, string] | null {
  switch (mark.type) {
    case "link": {
      const href = mark.attrs?.href;
      return typeof href === "string" && SAFE_HREF.test(href.trim()) ? [`<a href="${escAttr(href.trim())}">`, "</a>"] : null; // (javascript:, data:, file: ... stay plain text)
    }
    case "textStyle": {
      const st = spanStyle(mark.attrs);
      return st ? [`<span style="${escAttr(st)}">`, "</span>"] : null;
    }
    case "bold": return ["<strong>", "</strong>"];
    case "italic": return ["<em>", "</em>"];
    case "underline": return ["<u>", "</u>"];
    case "strike": return ["<s>", "</s>"];
    case "subscript": return ["<sub>", "</sub>"];
    case "superscript": return ["<sup>", "</sup>"];
    case "code": return [`<code style="${CODE_STYLE}">`, "</code>"];
    default: return null;
  }
}

/**
 * The inline content of a block: text with its marks, hard breaks, and the (rare) inline picture. `skip`: marks that are not written (a heading is
 * bold by its own style, so a bold mark in it says nothing; the editor reads that style back as a bold mark on every character, and without this
 * a draft that was saved and reopened would gain a <strong> in every heading).
 */
function inlineHtml(nodes: JsonNode[] | undefined, skip: readonly string[] = []): string {
  const list = nodes ?? [];
  let out = "";
  list.forEach((n, i) => {
    if (n.type === "hardBreak") {
      out += "<br>";
      return;
    }
    if (n.type === "image") {
      out += imageHtml(n);
      return;
    }
    if (n.type !== "text" || !n.text) return;
    const atStart = i === 0 || list[i - 1].type === "hardBreak";
    const atEnd = i === list.length - 1 || list[i + 1].type === "hardBreak";
    let html = textHtml(n.text, atStart, atEnd);
    const marks = (n.marks ?? []).filter((m) => !skip.includes(m.type)).sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    for (let k = marks.length - 1; k >= 0; k--) {
      const oc = openClose(marks[k]);
      if (oc) html = oc[0] + html + oc[1];
    }
    out += html;
  });
  return out;
}

function imageHtml(n: JsonNode): string {
  const a = n.attrs ?? {};
  const src = typeof a.src === "string" ? a.src : "";
  if (!src) return "";
  const width = Number(a.width) > 0 ? ` width="${Math.round(Number(a.width))}"` : "";
  const name = typeof a["data-name"] === "string" && a["data-name"] ? ` data-name="${escAttr(a["data-name"] as string)}"` : "";
  return `<img src="${escAttr(src)}" alt="${escAttr(typeof a.alt === "string" ? a.alt : "")}"${width} style="${IMG_STYLE}"${name}>`;
}

function listHtml(n: JsonNode, depth: number): string {
  const items = (n.content ?? []).map((li) => itemHtml(li, depth)).join("");
  if (n.type === "orderedList") {
    const css = normListStyle(true, n.attrs?.listStyle as string) ?? defaultListStyle(true, depth);
    const type = olType(css);
    const start = Number(n.attrs?.start);
    const attrs = `${type !== "1" ? ` type="${type}"` : ""}${start > 1 ? ` start="${Math.round(start)}"` : ""}`;
    return `<ol${attrs} style="list-style-type:${css};${LIST_BOX}">${items}</ol>`;
  }
  const css = normListStyle(false, n.attrs?.listStyle as string) ?? defaultListStyle(false, depth);
  return `<ul style="list-style-type:${css};${LIST_BOX}">${items}</ul>`;
}

/**
 * A list item: the text of its first paragraph straight in the <li> (what Outlook and Gmail write), its other blocks after it. A first paragraph
 * with a format of its own (centred, line spacing ...) keeps its <p>, which carries the style.
 */
function itemHtml(li: JsonNode, depth: number): string {
  const kids = li.content ?? [];
  const rest = kids.slice(1);
  const simple = kids[0]?.type === "paragraph" && paragraphStyle(blockAttrs(kids[0])) === "margin:0" && rest.every((k) => k.type === "bulletList" || k.type === "orderedList");
  if (simple) return `<li>${inlineHtml(kids[0].content)}${rest.map((k) => listHtml(k, depth + 1)).join("")}</li>`;
  return `<li>${kids.map((k) => blockHtml(k, depth + 1)).join("")}</li>`;
}

function blockHtml(n: JsonNode, depth = 0): string {
  switch (n.type) {
    case "paragraph": {
      const inner = inlineHtml(n.content);
      return `<p style="${paragraphStyle(blockAttrs(n))}">${inner || "<br>"}</p>`;
    }
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(n.attrs?.level) || 1));
      return `<h${level} style="${headingStyle(level, blockAttrs(n))}">${inlineHtml(n.content, ["bold"])}</h${level}>`;
    }
    case "bulletList":
    case "orderedList":
      return listHtml(n, depth);
    case "blockquote":
      return `<blockquote style="${QUOTE_STYLE}">${(n.content ?? []).map((k) => blockHtml(k, depth)).join("")}</blockquote>`;
    case "codeBlock": {
      const text = (n.content ?? []).map((k) => k.text ?? "").join("");
      return `<pre style="${PRE_STYLE}">${escText(text)}</pre>`;
    }
    case "horizontalRule":
      return `<hr style="${HR_STYLE}">`;
    case "image":
      return imageHtml(n);
    case "signatureBlock":
      return "<div data-sig-block></div>"; // the marker the signature is put in place of (signature.ts)
    case "text":
    case "hardBreak":
      return inlineHtml([n]);
    default:
      return (n.content ?? []).map((k) => blockHtml(k, depth)).join("");
  }
}

/** The body of a message: the blocks of the document, one after the other (no wrapper: see `wrapBase`). */
export function docToHtml(doc: JsonNode): string {
  return (doc.content ?? []).map((n) => blockHtml(n)).join("");
}

/** The style of the wrapper: the default font of the message, family and size. */
export const baseStyle = (b: BaseFont): string => `font-family:${normFamily(b.family)};font-size:${ptText(b.size)}`;

/** The whole message in one box with its default font, so every client starts from the same family and size (the paragraphs carry their own margins). */
export function wrapBase(html: string, base: BaseFont): string {
  return `<div style="${baseStyle(base)}">${html}</div>`;
}

const WRAP_OPEN = /^\s*<div style="font-family:([^;"]+);font-size:(\d+(?:\.\d+)?)pt"\s*>/;

/**
 * The reverse of `wrapBase`: a message that is one `<div>` with exactly the family and size declarations gives back its inner HTML and
 * its font. Anything else (a draft from before the default font existed, a message from another program) comes back as it is, `base` null.
 */
export function unwrapBase(html: string): { html: string; base: BaseFont | null } {
  const m = WRAP_OPEN.exec(html);
  if (!m) return { html, base: null };
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = m[0].length;
  let depth = 1;
  for (let t = tag.exec(html); t; t = tag.exec(html)) {
    depth += t[1] ? -1 : t[0].endsWith("/>") ? 0 : 1;
    if (depth === 0) {
      if (html.slice(tag.lastIndex).trim() !== "") return { html, base: null }; // something follows the box: it is not the wrapper of the whole message
      const size = sizePt(`${m[2]}pt`);
      const family = normFamily(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      return size && family ? { html: html.slice(m[0].length, t.index), base: { family, size } } : { html, base: null };
    }
  }
  return { html, base: null };
}
