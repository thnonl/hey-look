// The paragraph formats as attributes of the editor's document (spec-rich-text.md REQ-17 .. REQ-20): alignment, indent, line spacing and space after on
// paragraphs and headings, the marker style on bullet and numbered lists. The editor draws them with the same inline styles the serializer writes
// (emailHtml.ts), and reads the same forms back, so a draft that is saved and opened again is the same document (REQ-6).

import { Extension } from "@tiptap/core";
import { clampIndent, indentFromMargin, listStyleFromHtml, normAlign, normLineHeight, normListStyle, spaceAfterFromMargin, SPACE_AFTER, INDENT_PX } from "./blockFormat.ts";

type Attrs = Record<string, unknown>;

/** How deep a list element sits: the number of lists (<ul> / <ol>) around it. */
function listDepth(el: HTMLElement): number {
  let n = 0;
  for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "UL" || p.tagName === "OL") n++;
  return n;
}

const isHeading = (el: HTMLElement) => /^H[1-6]$/.test(el.tagName);

export const BlockFormat = Extension.create({
  name: "blockFormat",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el: HTMLElement) => normAlign(el.style.textAlign || el.getAttribute("align")),
            renderHTML: (a: Attrs) => (normAlign(a.textAlign as string) ? { style: `text-align:${a.textAlign}` } : {}),
          },
          indent: {
            default: 0,
            parseHTML: (el: HTMLElement) => indentFromMargin(el.style.marginLeft),
            renderHTML: (a: Attrs) => (clampIndent(a.indent) > 0 ? { style: `margin-left:${clampIndent(a.indent) * INDENT_PX}px` } : {}),
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

