// The paragraph formats as attributes of the editor's document (spec-rich-text.md REQ-17 .. REQ-20): alignment, indent, line spacing and space after on
// paragraphs and headings, the marker style on bullet and numbered lists. The editor draws them with the same inline styles the serializer writes
// (emailHtml.ts), and reads the same forms back, so a draft that is saved and opened again is the same document (REQ-6).

import { Extension } from "@tiptap/core";
import { alignFromHtml, clampIndent, indentFromMargin, listStyleFromHtml, normAlign, normDirection, normLineHeight, normListStyle, spaceAfterFromMargin, SPACE_AFTER, INDENT_PX } from "./blockFormat.ts";

type Attrs = Record<string, unknown>;

/** How deep a list element sits: the number of lists (<ul> / <ol>) around it. */
function listDepth(el: HTMLElement): number {
  let n = 0;
  for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "UL" || p.tagName === "OL") n++;
  return n;
}

const isHeading = (el: HTMLElement) => /^H[1-6]$/.test(el.tagName);

/** Is this element's own text direction right-to-left (its `dir` attribute, else its `direction` style; not an inherited one)? */
const isRtl = (el: HTMLElement) => normDirection(el.getAttribute("dir") || el.style.direction) === "rtl";

export const BlockFormat = Extension.create({
  name: "blockFormat",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el: HTMLElement) => alignFromHtml(isRtl(el), el.style.textAlign || el.getAttribute("align")),
            renderHTML: (a: Attrs) => (normAlign(a.textAlign as string) || a.textAlign === "left" ? { style: `text-align:${a.textAlign}` } : {}),
          },
          // right-to-left text (REQ-43): dir="rtl" and direction:rtl; the browser then aligns the paragraph to the right by itself
          direction: {
            default: null,
            parseHTML: (el: HTMLElement) => (isRtl(el) ? "rtl" : null),
            renderHTML: (a: Attrs) => (a.direction === "rtl" ? { dir: "rtl", style: "direction:rtl" } : {}),
          },
          indent: {
            default: 0,
            // (the start side: the left of a left-to-right block, the right of a right-to-left one; the editor's own element says margin-inline-start)
            parseHTML: (el: HTMLElement) => indentFromMargin(el.style.marginInlineStart || (isRtl(el) ? el.style.marginRight : el.style.marginLeft)),
            renderHTML: (a: Attrs) => (clampIndent(a.indent) > 0 ? { style: `margin-inline-start:${clampIndent(a.indent) * INDENT_PX}px` } : {}),
          },
          lineHeight: {
            default: null,
            parseHTML: (el: HTMLElement) => normLineHeight(el.style.lineHeight),
            renderHTML: (a: Attrs) => {
              const v = normLineHeight(a.lineHeight as string);
              return v ? { style: `line-height:${v}` } : {};
            },
          },
          spaceAfter: {
            default: null,
            parseHTML: (el: HTMLElement) => spaceAfterFromMargin(el.style.marginBottom, isHeading(el)),
            renderHTML: (a: Attrs) => (a.spaceAfter === "add" ? { style: `margin-bottom:${SPACE_AFTER}` } : a.spaceAfter === "none" ? { style: "margin-bottom:0" } : {}),
          },
        },
      },
      {
        types: ["bulletList", "orderedList"],
        attributes: {
          direction: {
            default: null,
            parseHTML: (el: HTMLElement) => (isRtl(el) ? "rtl" : null),
            renderHTML: (a: Attrs) => (a.direction === "rtl" ? { dir: "rtl", style: "direction:rtl" } : {}),
          },
          // the marker the person chose; null = the one the nesting level gives (disc, circle, square / 1. a. i.)
          listStyle: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const ordered = el.tagName === "OL";
              return listStyleFromHtml(ordered, el.style.listStyleType, el.getAttribute("type"), listDepth(el));
            },
            renderHTML: (a: Attrs) => {
              // the list type of the node decides which names are allowed
              const css = normListStyle(false, a.listStyle as string) ?? normListStyle(true, a.listStyle as string);
              return css ? { style: `list-style-type:${css}` } : {};
            },
          },
        },
      },
    ];
  },
});

